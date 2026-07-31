/* ============================================================
   PhysiClinic — Firebase Cloud Functions
   Node.js 18 / Firebase Functions v2
   
   Gemini API 서버 사이드 안전 호출 & Firestore RAG 연동
   ============================================================ */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret }       = require('firebase-functions/params');
const { GoogleGenerativeAI } = require('@google/generative-ai');

// DB 접근을 위한 Admin SDK 초기화
const admin = require('firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

/* Gemini API 키 Secret 관리 */
const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');

/* 함수 공통 옵션 */
const FUNC_OPTIONS = {
  region: 'asia-northeast3',  // 서울 리전
  secrets: [GEMINI_API_KEY],
  // thinking 예산을 작업별로 제한(getGeminiModel)하면서 호출당 지연이 크게 줄어,
  // 재시도(최대 3회)를 감안해도 120초면 충분하다. 이 값은 비용이 아니라 최악의
  // 대기시간 상한이다 — 낮출수록 사용자가 무한정 기다리는 일이 없어진다.
  timeoutSeconds: 120,
};

/* AI 호출 최대 시도 횟수 (최초 1회 + 재시도 2회) */
const MAX_AI_ATTEMPTS = 3;

/* uid 하나가 하루에 쓸 수 있는 AI 호출 수.
   익명(게스트)은 체험 수준으로만, 로그인 사용자는 정상 학습에 지장 없는 선으로 잡는다.
   문제 한 세트당 호출은 생성 1 + 채점 1 = 2회(Level 3는 풀이 인식이 더 붙어 3~4회)이므로
   게스트 40 ≈ 15세트, 로그인 400 ≈ 150세트다. */
const DAILY_AI_LIMIT = { guest: 40, member: 400 };

/* base64 이미지 페이로드 상한.
   리사이즈는 클라이언트(public/js/home.js)에서 하지만 그건 브라우저의 선의에 의존한다.
   1600px JPEG(q0.8)는 base64로 보통 300~700KB라, 2MB면 정상 사진은 전부 통과한다. */
const MAX_IMAGE_BASE64_BYTES = 2 * 1024 * 1024;

/* ------------------------------------------------------------
   유틸리티 함수 모음
   ------------------------------------------------------------ */

/**
 * 호출 자격 검사 — 모든 AI 함수의 첫 줄에서 부른다.
 *
 * 왜 필요한가: 예전에는 5개 함수 모두 request.auth를 보지 않았다. 함수 URL은 배포된 프론트
 * 번들에 그대로 들어있으므로, 주소만 알면 누구나 Gemini 호출을 대신 시킬 수 있었고 요금은
 * 이 프로젝트에 청구됐다. (functions/test_api.js가 Authorization 헤더 없이 실제 응답을
 * 받아오는 것이 그 증거다 — 그 스크립트는 지금부터 토큰 없이는 동작하지 않는다.)
 *
 * 익명 로그인도 통과시킨다. 비로그인 무료 체험을 유지하기로 한 결정이고, 익명 사용자도
 * uid는 있으므로 서버가 셀 수 있다. 대신 익명 토큰은 누구나 무한정 발급받을 수 있어서
 * 자격 검사만으로는 남용을 막지 못한다 — 그래서 uid 단위 일일 상한을 함께 건다.
 *
 * 🔑 반드시 각 함수의 try 블록 "밖에서" 부를 것. 안에서 부르면 아래 catch가
 *    unauthenticated/resource-exhausted를 'internal'로 덮어써서, 클라이언트가
 *    "다시 시도하면 되는 오류"와 "다시 해도 막히는 오류"를 구분할 수 없게 된다.
 */
async function authorize(request, label) {
  const auth = request.auth;
  if (!auth?.uid) {
    throw new HttpsError('unauthenticated', '로그인이 필요합니다');
  }

  const guest = auth.token?.firebase?.sign_in_provider === 'anonymous';
  const limit = guest ? DAILY_AI_LIMIT.guest : DAILY_AI_LIMIT.member;

  // 날짜 경계는 KST 기준 — 사용자가 체감하는 "오늘"과 맞춘다 (UTC면 오전 9시에 초기화됨)
  const day = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const ref = db.collection('ai_usage').doc(`${auth.uid}_${day}`);

  // 트랜잭션으로 세야 동시 호출에서 증가분이 씹히지 않는다.
  const allowed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prev = snap.exists ? (snap.data().count || 0) : 0;
    if (prev >= limit) return false;
    tx.set(ref, {
      uid: auth.uid,
      day,
      guest,
      count: prev + 1,
      lastCall: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
    return true;
  });

  if (!allowed) {
    console.warn(`[${label}] 일일 상한 초과 — uid: ${auth.uid}, guest: ${guest}, 상한: ${limit}`);
    throw new HttpsError(
      'resource-exhausted',
      guest
        ? '무료 체험 횟수를 모두 썼어요. 로그인하면 계속 학습할 수 있어요.'
        : '오늘 사용할 수 있는 횟수를 모두 썼어요. 내일 다시 이용해주세요.'
    );
  }

  return auth;
}

/**
 * 오개념 마스터(128개)를 인스턴스가 살아있는 동안 재사용합니다.
 *
 * seed.js로만 바뀌는 정적 데이터인데, 예전에는 extractKeywords가 호출마다 컬렉션 전체를
 * 다시 읽고 generateQuestions가 또 소단원 쿼리를 따로 냈다. 사진 한 장에 128건 읽기가
 * 그대로 붙는다. 프롬프트에 실어 보낼 목록이라 매번 최신일 필요도 없다.
 *
 * 시딩을 다시 했다면 인스턴스가 교체될 때까지(보통 수 분) 옛 목록이 쓰일 수 있다. 문제
 * 생성은 이 목록에서 "고르는" 작업이라 그 지연은 감당 가능하다. 즉시 반영이 필요하면
 * 함수를 재배포하면 된다.
 */
let misconceptionCache = null;
async function loadMisconceptions() {
  if (misconceptionCache) return misconceptionCache;
  const snap = await db.collection('misconceptions').get();
  misconceptionCache = snap.docs.map(d => d.data());
  return misconceptionCache;
}

/**
 * 이미지 페이로드 검증. 없거나 지나치게 크면 AI를 부르기 전에 끊는다.
 * (큰 요청은 그대로 Gemini 입력 토큰 비용이 되므로 여기서 막는 게 요점이다)
 */
function validateImagePayload(imageBase64) {
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    throw new HttpsError('invalid-argument', '이미지 데이터가 없습니다');
  }
  if (imageBase64.length > MAX_IMAGE_BASE64_BYTES) {
    throw new HttpsError('invalid-argument', '이미지가 너무 커요. 다시 촬영해주세요.');
  }
}

/**
 * 설정된 API 키를 사용하여 Gemini 모델 인스턴스를 반환합니다.
 *
 * @param {number} temperature - 기본 0(결정적). 문제 생성처럼 다양성이 필요한 곳은 높여서 호출.
 * @param {object} [opts]
 * @param {number} [opts.thinkingBudget=0]  추론(thinking) 토큰 상한.
 *        gemini-2.5-flash는 thinking이 기본 켜져 있고 그 양이 적응적으로 늘어난다.
 *        thinking 토큰은 출력 토큰으로 과금되고 응답 지연의 최대 요인이므로,
 *        추론이 필요 없는 작업(이미지 분류·OCR)은 0으로 완전히 끄고, 정답의 논리적
 *        일관성이 중요한 작업(계산 문제 생성·풀이 채점)만 제한적으로 허용한다.
 *        (0 = 끔. Flash는 0을 허용함)
 * @param {number} [opts.outputTokens]  "눈에 보이는 답변"에 필요한 토큰 예산.
 *        thinking 토큰과 실제 답변 토큰은 maxOutputTokens 예산을 함께 쓴다.
 *        (2.5 모델에서 thinking도 output으로 집계됨) 그래서 maxOutputTokens를 답변 크기에만
 *        맞춰 잡으면, 추론이 예산을 다 써버려 답변 JSON이 중간에 잘려 나온다(파싱 실패).
 *        여기서는 outputTokens를 "답변에 필요한 양"으로 받고, 내부에서 thinkingBudget을
 *        자동으로 더해 실제 maxOutputTokens = thinkingBudget + outputTokens 로 설정한다.
 */
function getGeminiModel(temperature = 0, opts = {}) {
  const { thinkingBudget = 0, outputTokens } = opts;
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY.value());

  const generationConfig = {
    temperature,
    responseMimeType: "application/json", // AI가 항상 JSON만 반환하도록 강제
    // 🔑 SDK 0.21의 타입 정의엔 thinkingConfig가 없지만, generationConfig 객체를 그대로
    //    v1beta API에 실어 보내므로(필드 필터링 없음) 2.5 모델에서 정상 적용된다.
    thinkingConfig: { thinkingBudget },
  };
  // thinking 몫을 더해줘야 답변이 잘리지 않는다 (위 outputTokens 설명 참고)
  if (outputTokens) generationConfig.maxOutputTokens = thinkingBudget + outputTokens;

  return genAI.getGenerativeModel({ model: 'gemini-2.5-flash', generationConfig });
}

/**
 * 생성된 판별 문장을 독립된 호출로 검수합니다 (단계 8-5).
 *
 * 두 가지를 함께 판정한다.
 *   1) isFalse   — 참·거짓 라벨이 맞는가. 생성 호출이 isWrong을 반대로 다는 사고가 실제로 났다.
 *   2) needsCalc — 수를 대입해 계산해야 판별되는 문장인가. Level 1은 "계산 없이 옳고 그름만"
 *      판별하는 단계인데, 프롬프트로 금지하는 것만으로는 지켜지지 않았다("1kg의 물체가 5m
 *      높이에 있을 때의 위치에너지는 49 J이다" 같은 Level 2용 문장이 실제로 Level 1에 나왔다).
 *      그 문장은 라벨이 맞아서 1)을 그냥 통과했고, 그래서 아무것도 막지 못했다.
 *
 * 왜 별도 호출인가 — 문장을 만드는 호출은 오개념 겨냥, 개수 맞추기, 소재 다양화, 공식 문장
 * 혼합을 동시에 처리한다. 이 호출은 문장만 보고 판정한다. 문장 외의 맥락(오개념 목록, 겨냥
 * 지시, 학생 답변)은 일부러 주지 않는다 — 힌트를 주면 생성 호출의 판단을 그대로 따라가
 * 검수가 되지 않는다.
 *
 * @returns {Array<{isFalse: boolean|null, ambiguous: boolean, needsCalc: boolean}> | null}
 *          형식이 깨지면 null(검수 생략).
 */
async function verifyStatements(unit, questions) {
  const list = questions.map((q, i) => `${i + 1}. ${q.text}`).join('\n');
  const prompt = `
당신은 고등학교 물리 교사입니다. 아래 문장들을 두 가지 기준으로 판정하세요.
단원: "${unit}"

${list}

[판정 1: isFalse — 이 문장이 물리적으로 거짓인가]
- 고등학교 교육과정 수준에서 판단합니다.
- 표기 관례(부호, 벡터 화살표, 기호 이름)만 다르고 물리적 내용이 맞으면 **참**입니다.
- 교과서에 따라 다르게 쓸 수 있어 참·거짓을 단정할 수 없는 문장은 "ambiguous"로 표시하세요.

[판정 2: needsCalc — 참·거짓을 가리려면 수를 대입해 계산해야 하는가]
- 공식에 수를 넣어 값을 구해봐야 맞는지 알 수 있으면 true입니다.
    "1kg의 물체가 5m 높이에 있을 때의 위치에너지는 49 J이다"     → true (mgh를 계산해야 함)
    "질량 2kg에 5N을 가하면 가속도는 2.5 m/s²이다"              → true (F=ma를 계산해야 함)
- 공식의 "형태"가 맞는지만 보면 되는 문장은 false입니다. 계산이 아니라 암기·이해의 문제입니다.
    "운동에너지를 구하는 공식은 E = mv²이다"                    → false (½이 빠진 걸 보면 됨)
    "운동량의 단위는 kg·m/s이다"                               → false
- 수치가 나오더라도 그것이 상수·정의값이라 계산이 필요 없으면 false입니다.
    "빛의 속도는 약 3×10⁸ m/s이다"                             → false
- 판단 기준은 "수치가 들어있는가"가 아니라 "수를 대입해 계산해야 하는가"입니다.

JSON만 출력:
{"results":[{"n":1,"isFalse":true,"needsCalc":false},{"n":2,"isFalse":false,"needsCalc":true},{"n":3,"ambiguous":true,"needsCalc":false}]}
`;
  try {
    const model = getGeminiModel(0, { thinkingBudget: 256, outputTokens: 512 });
    const parsed = parseJSON((await model.generateContent(prompt)).response.text());
    const rows = parsed?.results;
    if (!Array.isArray(rows) || rows.length !== questions.length) return null;
    return questions.map((_, i) => {
      const row = rows.find(r => Number(r?.n) === i + 1);
      // 판정이 빠진 문항은 "문제 없음"으로 둔다 — 검수 누락으로 정상 문항을 버리지 않기 위함
      if (!row) return { isFalse: null, ambiguous: false, needsCalc: false };
      return {
        isFalse:   typeof row.isFalse === 'boolean' ? row.isFalse : null,
        ambiguous: row.ambiguous === true,
        needsCalc: row.needsCalc === true,
      };
    });
  } catch (err) {
    // 검수가 실패했다고 문제 생성을 막지는 않는다. 검수는 품질 장치이지 필수 경로가 아니다.
    console.warn(`[verifyStatements] 검수 호출 실패, 생략함: ${err.message}`);
    return null;
  }
}

/**
 * AI 호출을 재시도로 감쌉니다.
 *
 * LLM은 특성상 일정 비율로 형식을 어깁니다 — 응답이 중간에 잘려 JSON 파싱이 깨지거나,
 * 문장 5개를 요청했는데 4개를 주는 식입니다. 예전에는 이런 경우 곧바로 HttpsError를 던져서
 * 사용자에게 "다시 시도해주세요" 토스트가 그대로 노출됐습니다. 주문을 잘못 알아들은 직원에게
 * 다시 물어보지도 않고 손님한테 안 된다고 하는 셈이라, 서버에서 조용히 두 번 더 시도합니다.
 *
 * 검증(파싱·형식 확인)까지 fn 안에서 해야 의미가 있습니다. 검증을 밖에서 하면
 *    "형식이 틀린 응답"이 재시도를 유발하지 못하고 그대로 실패로 빠집니다.
 *
 * @param {string} label   로그 식별용 함수명
 * @param {Function} fn    호출 + 파싱 + 검증까지 수행하는 async 함수
 */
async function withRetry(label, fn) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_AI_ATTEMPTS; attempt++) {
    try {
      const result = await fn(attempt);
      if (attempt > 1) console.info(`[${label}] ${attempt}번째 시도에서 성공`);
      return result;
    } catch (err) {
      lastErr = err;
      console.warn(`[${label}] ${attempt}/${MAX_AI_ATTEMPTS} 시도 실패: ${err.message}`);
      // 마지막 시도가 아니면 잠깐 쉬었다가 (400ms → 800ms) 재시도
      if (attempt < MAX_AI_ATTEMPTS) {
        await new Promise(resolve => setTimeout(resolve, 400 * attempt));
      }
    }
  }
  throw lastErr;
}

/**
 * 마크다운 찌꺼기나 불필요한 텍스트를 제거하고 안전하게 JSON을 파싱합니다.
 */
function parseJSON(text) {
  try {
    const cleaned = text.replace(/```json\n?/gi, '').replace(/```\n?/g, '').trim();
    // JSON 시작과 끝 괄호만 정확히 추출 (부가적인 텍스트가 섞여 있을 경우 대비)
    const startIndex = cleaned.search(/[\{\[]/);
    const endIndex = cleaned.search(/[\}\]][^}\]]*$/);
    
    if (startIndex !== -1 && endIndex !== -1) {
      return JSON.parse(cleaned.substring(startIndex, endIndex + 1));
    }
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`JSON 파싱 실패: ${text.slice(0, 200)}`);
  }
}

/**
 * 단위 문자열을 비교용으로 정규화합니다. (m/s² ≡ m/s^2 ≡ M/S 2 판정용)
 * 표기 차이(위첨자·^·공백·중점·대소문자)만 무시하고 실질이 같은지 본다.
 */
function normalizeUnit(u) {
  return String(u)
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/²/g, '2').replace(/³/g, '3')
    .replace(/\^/g, '')       // m/s^2 → m/s2
    .replace(/[·*×]/g, '');    // kg·m/s → kgm/s
}

/**
 * 계산형 문제(Level 2 방식B, Level 3)의 필수 필드를 검증하고, 고칠 수 있는 건 고칩니다.
 * 하나라도 어긋나면 throw → withRetry가 재생성을 시도합니다.
 *
 * 특히 unitOptions에 정답 단위가 실제로 들어있는지 확인하는 게 중요합니다.
 * 프론트(QuizScreen.initCalc)는 보기를 셔플한 뒤 `선택값 === calcQuestion.unit`으로
 * 채점하므로, 보기 안에 정답 단위가 없으면 학생이 무엇을 고르든 무조건 오답이 됩니다.
 *
 * 🔑 표기만 다른 경우(정답 'm/s²' vs 보기 'm/s^2')는 그냥 재시도하지 않고 보기 문자열을
 *    정답과 똑같이 맞춰서 "교정"한다. 이런 사소한 표기 차이로 3번씩 재생성하면 비용·지연
 *    낭비가 크기 때문. 실질이 다른 단위가 없을 때만 throw한다.
 */
function validateCalcQuestion(q, label) {
  if (!q)                                    throw new Error(`${label} calcQuestion 누락`);
  if (typeof q.text !== 'string' || !q.text.trim()) throw new Error(`${label} 문제 본문 누락`);
  if (typeof q.correctAnswer !== 'number' || !Number.isFinite(q.correctAnswer)) {
    throw new Error(`${label} correctAnswer가 숫자가 아님 (${q.correctAnswer})`);
  }
  if (typeof q.unit !== 'string' || !q.unit.trim()) throw new Error(`${label} 정답 단위 누락`);
  if (!Array.isArray(q.unitOptions) || q.unitOptions.length < 2) {
    throw new Error(`${label} unitOptions가 부족함`);
  }
  if (!q.unitOptions.includes(q.unit)) {
    // 표기만 다른 보기가 있으면 그 자리를 정답 문자열로 교정 (재시도 없이 해결)
    const idx = q.unitOptions.findIndex(o => normalizeUnit(o) === normalizeUnit(q.unit));
    if (idx === -1) throw new Error(`${label} unitOptions에 정답 단위(${q.unit})가 없음`);
    q.unitOptions[idx] = q.unit;
  }
  // Level 3는 "다시 풀기"로 문제를 복원할 때 모범 풀이 단계까지 필요함
  if (label === 'L3' && (!Array.isArray(q.solutionSteps) || !q.solutionSteps.length)) {
    throw new Error('L3 solutionSteps 누락');
  }
  // 힌트가 없으면 화면에 하드코딩 기본 문구가 뜨므로, 없으면 재생성
  if (typeof q.hint1 !== 'string' || !q.hint1.trim() ||
      typeof q.hint2 !== 'string' || !q.hint2.trim()) {
    throw new Error(`${label} 힌트 누락`);
  }
}

/* ────────────────────────────────────────
   보조 오개념 마스터 (FCI가 커버하지 못하는 비역학 등)
──────────────────────────────────────── */
/* ────────────────────────────────────────
   Function 1: extractKeywords (하이브리드 DB 연동 버전)
──────────────────────────────────────── */
exports.extractKeywords = onCall(FUNC_OPTIONS, async (request) => {
  await authorize(request, 'extractKeywords');
  const { imageBase64 } = request.data;
  validateImagePayload(imageBase64);

  try {
    // 1. 오개념 DB 전체 불러오기 (14개 소단원 전부 수록 — 역학/비역학 구분 없음).
    //    소단원명을 함께 넘겨야 AI가 "이 사진의 단원"과 "그 단원의 오개념"을 일관되게 고른다.
    //    (loadMisconceptions가 인스턴스 단위로 캐시한다 — 호출마다 128건을 다시 읽지 않는다)
    const dbMisconceptions = (await loadMisconceptions()).map(m => ({
      id: m.id,
      subUnit: m.subUnit,
      description: m.description,
    }));

    // 이미지 → 소단원 분류 + 오개념 id 매핑. 정해진 목록에서 고르는 분류 작업이라
    // 추론 불필요 → thinking 0. (입력이 큰 호출이라 여기서 지연을 가장 크게 줄인다)
    const model = getGeminiModel(0, { outputTokens: 1024 });

    // 2. 소단원 분류 + 그 소단원의 오개념 매핑을 한 번에 요구하는 프롬프트
    const prompt = `
      다음 물리 교과서/필기 이미지를 분석하여 아래 JSON 형식으로 응답하세요.
      JSON 외 다른 텍스트는 절대 출력하지 마세요.

      [물리 오개념 목록 - 14개 소단원 전체]
      ${JSON.stringify(dbMisconceptions)}

      {
        "unit": "고등학교 물리 소단원명 (예: '물체의 운동', '열역학 법칙', '파동의 간섭' 등 반드시 구체적인 소단원명만 출력하세요. '1단원'이나 '역학과 에너지' 같은 대분류는 절대 적지 마십시오.)",
        "keywords": ["키워드1", "키워드2", "키워드3"],
        "misconceptions": [
          {
            "id": "오개념 id",
            "description": "선택한 오개념의 설명"
          }
        ]
      }

      [고등학교 물리 소단원 분류 리스트]
      - 역학: 물체의 운동, 뉴턴 운동 법칙, 운동량과 충격량, 역학적 에너지 보존, 열역학 법칙, 특수 상대성 이론
      - 전자기: 원자 모형과 전기력, 에너지 띠와 반도체, 전류의 자기 작용, 전자기 유도
      - 파동: 파동의 진동과 굴절, 파동의 간섭, 빛의 이중성, 물질의 이중성

      [오개념 매핑 지시사항]
      1. 먼저 이미지의 소단원을 위 분류 리스트에서 정하세요.
      2. 오개념은 반드시 위 목록에서 고르되, subUnit이 1번에서 정한 소단원과 같은 항목 중에서만 고르세요.
      3. 그 소단원 안에 도저히 일치하는 내용이 없을 때만 id에 "ETC"라고 작성하세요.
      4. 목록에 없는 id를 새로 지어내지 마세요.
    `;

    return await withRetry('extractKeywords', async () => {
      const result = await model.generateContent([
        prompt,
        {
          inlineData: {
            mimeType: 'image/jpeg',
            data: imageBase64,
          },
        },
      ]);

      const parsed = parseJSON(result.response.text());
      // 화면이 곧바로 참조하는 필드들 — 비어 있으면 재시도해서 받아내는 편이 낫다
      if (!parsed.unit) throw new Error('unit 누락');
      if (!Array.isArray(parsed.keywords) || !parsed.keywords.length) {
        throw new Error('keywords 누락');
      }
      if (!Array.isArray(parsed.misconceptions)) parsed.misconceptions = [];
      return parsed;
    });
  } catch (err) {
    console.error('[extractKeywords] Error:', err);
    throw new HttpsError('internal', `키워드 추출 실패: ${err.message}`);
  }
});

/* ────────────────────────────────────────
   Function 2: generateQuestions (DB 참고 문장 활용 + 레벨 분기)
──────────────────────────────────────── */
exports.generateQuestions = onCall(FUNC_OPTIONS, async (request) => {
  await authorize(request, 'generateQuestions');
  const { misconceptions, unit, level = 1, mode = null, targetMisconceptionIds = [] } = request.data;
  if (!misconceptions || !unit) {
    throw new HttpsError('invalid-argument', '오개념 또는 단원 정보가 없습니다');
  }

  try {
    // 소단원 기반 오개념 조회 (캐시된 마스터에서 걸러낸다 — 쿼리 한 번을 아낀다)
    const subUnitMisconceptions = (await loadMisconceptions()).filter(m => m.subUnit === unit);

    // 소단원 오개념이 있으면 그걸 사용, 없으면 Gemini가 골라준 misconceptions 사용
    const activeMisconceptions = subUnitMisconceptions.length > 0
      ? subUnitMisconceptions
      : misconceptions;

    // 해당 소단원 오개념 ID 목록으로 sentences 조회
    const validIds = activeMisconceptions.map(mc => mc.id).filter(Boolean);
    // 문항 오개념 태깅 검증용 — AI가 붙인 targetMisconceptionId가 실제 목록 안의 값인지 확인
    const validIdSet = new Set(validIds);
    /* 🔑 예전엔 오개념 id마다 쿼리를 하나씩 날려서, 소단원 하나에 최대 22번이 됐다
       (뉴턴 운동 법칙 22개). in 연산자는 한 번에 30개까지 받으므로 지금 데이터에서는
       어느 소단원이든 쿼리 1회로 끝난다. */
    const ID_CHUNK = 30;
    const idChunks = [];
    for (let i = 0; i < validIds.length; i += ID_CHUNK) {
      idChunks.push(validIds.slice(i, i + ID_CHUNK));
    }
    const querySnapshots = await Promise.all(idChunks.map(chunk =>
      db.collection('misconception_sentences').where('misconceptionId', 'in', chunk).get()
    ));
    const contextSentences = querySnapshots.flatMap(snap => snap.docs.map(doc => doc.data()));

    // 🆕 소단원 기반 실제 기출 유형 패턴 조회 (완자 물리학Ⅰ 유형 추상화 DB, 원문 미포함)
    const patternSnap = await db.collection('question_patterns').where('subUnit', '==', unit).get();
    const allPatterns = patternSnap.docs.map(d => d.data());
    const sampledPatterns = [...allPatterns]
      .sort(() => Math.random() - 0.5)
      .slice(0, Math.min(3, allPatterns.length));
    const patternText = sampledPatterns.length > 0
      ? sampledPatterns.map((p, i) =>
          `${i + 1}. [${p.patternType}] ${p.situationArchetype}\n   (핵심 개념: ${p.keyDiscriminator} / 흔한 함정: ${p.commonTrap})`
        ).join('\n')
      : '';
    const patternInstruction = patternText ? `
[참고: 실제 기출/문제집에 자주 나오는 유형 - 스타일 참고 전용, 절대 그대로 베끼지 마세요]
아래는 이 소단원에서 실제로 자주 출제되는 문제 유형입니다. "상황 설정 방식"과 "형식", "함정 포인트"만 참고하여
완전히 새로운 소재·숫자·문장으로 창작하세요. 아래 내용의 문장을 그대로 옮기거나 숫자만 바꾸는 것은 금지합니다.
${patternText}
` : '';

    // 틀린 문장과 옳은 문장을 분류
    const wrongExamples = contextSentences.filter(s => s.isWrong).map(s => s.sentence).join(' / ');
    const correctExamples = contextSentences.filter(s => !s.isWrong).map(s => s.sentence).join(' / ');

    // 각 오개념에 id를 함께 노출한다. STEP1/2에서 틀린 문장을 만들 때, 그 문장이 겨냥한
    // 오개념 id를 targetMisconceptionId로 태깅하게 하기 위함(BKT 관측의 근거).
    // 🆕 순환 출제(설계 4-8): 클라이언트가 "이해도 낮은 오개념"을 우선 겨냥 대상으로 보내온다.
    //    목록 밖 id는 버리고, 최대 2개까지만 사용한다. 지정이 없으면 예전처럼 전체에서 자유 출제.
    const priorityIds = [...new Set(
      (Array.isArray(targetMisconceptionIds) ? targetMisconceptionIds : []).filter(id => validIdSet.has(id))
    )].slice(0, 2);

    // 오개념이 17개까지 갈 수 있어, 우선 대상을 목록 맨 앞으로 올려 프롬프트에서 눈에 띄게 한다
    const orderedMisconceptions = priorityIds.length
      ? [...activeMisconceptions].sort(
          (a, b) => (priorityIds.includes(b.id) ? 1 : 0) - (priorityIds.includes(a.id) ? 1 : 0))
      : activeMisconceptions;

    const mcText = orderedMisconceptions.map((mc, i) => `${i + 1}. [id: ${mc.id || '?'}] ${mc.description}`).join('\n');

    const priorityInstruction = priorityIds.length ? `
[우선 겨냥 오개념 - 매우 중요]
아래 오개념은 이 학생이 아직 이해하지 못한 것으로 측정되었습니다. 이번 문제는 반드시 아래 오개념을 겨냥하세요.
${priorityIds.map(id => {
      const mc = activeMisconceptions.find(m => m.id === id);
      return `- [id: ${id}] ${mc ? mc.description : ''}`;
    }).join('\n')}
- 문장 5개를 만드는 경우: 틀린 문장(isWrong: true) 중 최소 1개는 위 오개념을 겨냥하고, 그 문장의 targetMisconceptionId에 해당 id를 적으세요.
- 계산 문제를 만드는 경우: 위 오개념이 문제의 함정(자주 하는 실수)이 되도록 상황을 설계하고, targetMisconceptionId에 해당 id를 적으세요.
` : '';

    const wrongCount = Math.floor(Math.random() * 2) + 1; // 1 or 2
    const rightCount = 5 - wrongCount; // 4 or 3

    // 🆕 매번 다른 관점/상황으로 출제하도록 랜덤 컨텍스트 주입 (문제 다양성 확보)
    const ANGLES = [
      '일상생활 속 예시(스포츠, 교통수단, 놀이기구 등)를 활용한 상황 설정으로',
      '실험실에서 진행하는 실험 상황을 가정하여',
      '두 물체 또는 두 상황을 서로 비교하는 형태로',
      '시간에 따른 변화 과정을 서술하는 형태로',
      '특정 순간의 물리량 관계를 설명하는 형태로',
      '학생들이 흔히 떠올릴 법한 직관적 생각을 그대로 문장화하는 형태로',
    ];
    const randomAngle = ANGLES[Math.floor(Math.random() * ANGLES.length)];
    // 매 호출마다 고유한 시드값을 줘서 같은 입력이어도 다른 결과를 유도
    const varietySeed = Math.random().toString(36).slice(2, 8);

    // 🔑 thinking 예산은 레벨별로 다르게 준다 (아래 각 분기에서 모델 생성).
    //    - L1/L2A(문장 5개): 개념 참/거짓이라 추론 부담이 작음 → 적게
    //    - L2B(단일 계산): 정답 숫자가 맞아야 함 → 중간
    //    - L3(다단계 복합): 두 법칙 결합 계산의 논리 일관성이 중요 → 넉넉히

    // ── Level 3: 다단계 복합 계산 문제 ──
    if (level === 3) {
      const prompt = `
당신은 고등학교 물리 교사입니다.
단원: "${unit}"
학생들의 주요 오개념:
${mcText}
${priorityInstruction}${patternInstruction}
이 단원과 오개념을 중심으로, 두 가지 이상의 물리 법칙이 결합된 다단계 복합 계산 문제를 1개 만드세요.
- 실생활 또는 수능/모의고사 스타일 (놀이기구, 스포츠, 실험 등)
- 최소 2단계 이상의 풀이 과정 필요
- 고등학교 물리 수준 (뉴턴 법칙, 에너지 보존, 운동량, 전기회로, 파동 등)
- 최종 답은 소수점 2자리 이하의 깔끔한 숫자
- 중력 가속도는 반드시 9.8 m/s²를 사용하세요. (10 m/s² 같은 간이값 금지 — 고등학교 물리학Ⅰ/Ⅱ 교육과정 기준 값입니다)

[복합성 필수 조건 - 매우 중요, 반드시 지키세요]
겉보기엔 단계가 나뉘어 보여도 실제로는 물리 법칙 하나(예: 역학적 에너지 보존 한 줄)만 적용하면 끝나는 문제는 절대 만들지 마세요.

나쁜 예 (단일 법칙 - 금지): "물체가 마찰 없는 곡면에서 높이 h에서 출발해 미끄러져 내려온 뒤 용수철과 충돌해 정지한다. 최대 압축 길이는?"
→ mgh = (1/2)kx² 한 줄이면 끝나는 문제. 마찰·충돌 등 두 번째 요소가 빠져있어 Level 3 수준이 아닙니다.

좋은 예 (진짜 복합 - 이런 식으로 만드세요): "물체가 마찰 없는 곡면에서 내려온 뒤, 마찰이 있는 수평 구간을 통과하며 운동 마찰력으로 에너지를 잃고, 그 다음 용수철과 충돌해 압축된다."
→ (1) 역학적 에너지 보존 (2) 마찰에 의한 일-에너지 정리(에너지 손실 계산) 두 가지가 실제로 결합됩니다.

아래 중 최소 1개 이상을 반드시 문제에 포함시켜, 서로 다른 물리 개념 2개 이상이 실제 계산에 관여하도록 하세요:
- 마찰 구간 (운동 마찰력에 의한 에너지 손실 계산 필요)
- 충돌 (운동량 보존 + 운동에너지 보존/손실 구분)
- 서로 다른 두 물체의 상호작용
- 성질이 다른 두 구간의 운동 결합 (예: 등가속도 구간 + 등속 구간, 경사면 + 수평면 등)

[필수 규칙 - 어투 및 표기]
- 문제 본문(text)은 반드시 "~한다", "~이다", "~된다" 형태의 평서문(교과서 서술체)으로 작성하세요. (예: "출발한다", "통과한다", "도달한다") 경어체("~습니다", "~합니다")나 반말은 금지합니다.
- 수학·물리 기호는 아스키 문자로 대체하지 말고 실제 유니코드 기호를 사용하세요.
  · 제곱·세제곱 등 지수: "m/s^2" (X) → "m/s²" (O)
  · 곱셈: "*" 또는 "x" (X) → "×" (O)
  · 제곱근: "sqrt(2)" 또는 "root2" (X) → "√2" (O)
  · 그리스 문자(마찰계수 μ, 각도 θ, 각속도 ω, 파장 λ 등): "mu", "theta" 같은 로마자 표기 (X) → 실제 그리스 문자 (O)
  · 덧셈/뺄셈 오차 범위: "+-" (X) → "±" (O)

JSON만 출력하세요:
{
  "calcQuestion": {
    "text": "문제 내용 (조건과 수치 명확히 포함, 평서문 교과서 서술체, 지수는 위첨자 기호 사용)",
    "correctAnswer": 숫자(정수 또는 소수),
    "unit": "정답 단위",
    "unitOptions": ["정답단위", "헷갈릴단위1", "헷갈릴단위2", "헷갈릴단위3"],
    "solutionSteps": ["1단계: 적용할 법칙/공식 설명", "2단계: 계산 과정 설명"],
    "targetMisconceptionId": "위 오개념 목록의 id 중 이 문제가 주로 겨냥하는 것 하나 (없으면 생략)",
    "hint1": "어떤 물리 법칙을 순서대로 적용해야 하는지 방향만 제시. 정답 언급 금지. 1~2문장 경어체.",
    "hint2": "각 단계에서 어떤 변수를 구해야 하는지 유도. 최종 값 언급 금지. 1~2문장 경어체."
  }
}
`;
      const model = getGeminiModel(0.8, { thinkingBudget: 2048, outputTokens: 1536 });
      return await withRetry('generateQuestions:L3', async () => {
        const result = await model.generateContent(prompt);
        const parsed = parseJSON(result.response.text());
        validateCalcQuestion(parsed.calcQuestion, 'L3');
        const targetMc = validIdSet.has(parsed.calcQuestion.targetMisconceptionId)
          ? parsed.calcQuestion.targetMisconceptionId : null;
        return {
          questions: null,
          calcQuestion: { ...parsed.calcQuestion, targetMisconceptionId: targetMc, isLevel3: true },
          hint1: parsed.calcQuestion.hint1 || null,
          hint2: parsed.calcQuestion.hint2 || null,
          misconceptionCount: activeMisconceptions.length,
          patternCount: sampledPatterns.length,
        };
      });
    }

    // ── Level 2 Mode B: 계산 단답형 ──
    if (level === 2 && mode === 'B') {
      const prompt = `
당신은 고등학교 물리 교사입니다.
단원: "${unit}"
학생들의 주요 오개념:
${mcText}
${priorityInstruction}${patternInstruction}
이 오개념과 관련된 단일 공식으로 풀 수 있는 계산 문제를 1개 만드세요.
- 숫자와 단위가 명확하게 주어지는 문제
- 고등학생이 풀 수 있는 수준 (F=ma, E=mc², W=Fs, v=at, p=mv 등 기본 공식)
- 최종 답은 소수점 1자리 이하의 깔끔한 숫자
- 중력 가속도가 필요하다면 반드시 9.8 m/s²를 사용하세요. (10 m/s² 같은 간이값 금지 — 고등학교 물리학Ⅰ/Ⅱ 교육과정 기준 값입니다)

[필수 규칙 - 어투 및 표기]
- 문제 본문(text)은 반드시 "~한다", "~이다", "~된다" 형태의 평서문(교과서 서술체)으로 작성하세요. 경어체("~습니다", "~합니다")나 반말은 금지합니다.
- 수학·물리 기호는 아스키 문자로 대체하지 말고 실제 유니코드 기호를 사용하세요.
  · 제곱·세제곱 등 지수: "m/s^2" (X) → "m/s²" (O)
  · 곱셈: "*" 또는 "x" (X) → "×" (O)
  · 제곱근: "sqrt(2)" 또는 "root2" (X) → "√2" (O)
  · 그리스 문자(마찰계수 μ, 각도 θ, 각속도 ω, 파장 λ 등): "mu", "theta" 같은 로마자 표기 (X) → 실제 그리스 문자 (O)
  · 덧셈/뺄셈 오차 범위: "+-" (X) → "±" (O)

JSON만 출력하세요:
{
  "calcQuestion": {
    "text": "문제 내용 (조건과 수치 포함, 평서문 교과서 서술체, 지수는 위첨자 기호 사용)",
    "correctAnswer": 숫자(정수 또는 소수),
    "unit": "정답 단위 (예: m/s, N, J, kg·m/s 등)",
    "unitOptions": ["정답단위", "헷갈릴단위1", "헷갈릴단위2", "헷갈릴단위3"],
    "targetMisconceptionId": "위 오개념 목록의 id 중 이 문제가 주로 겨냥하는 것 하나 (없으면 생략)",
    "hint1": "이 문제를 풀 때 어떤 물리 법칙/공식을 사용해야 하는지 방향만 제시. 정답 언급 금지. 1~2문장 경어체.",
    "hint2": "공식에서 각 변수에 어떤 값을 대입해야 하는지 구체적으로 유도. 최종 값 언급 금지. 1~2문장 경어체."
  }
}
`;
      const model = getGeminiModel(0.8, { thinkingBudget: 1024, outputTokens: 1024 });
      return await withRetry('generateQuestions:L2B', async () => {
        const result = await model.generateContent(prompt);
        const parsed = parseJSON(result.response.text());
        validateCalcQuestion(parsed.calcQuestion, 'L2 방식B');
        const targetMc = validIdSet.has(parsed.calcQuestion.targetMisconceptionId)
          ? parsed.calcQuestion.targetMisconceptionId : null;
        return {
          questions: null,
          calcQuestion: { ...parsed.calcQuestion, targetMisconceptionId: targetMc },
          hint1: parsed.calcQuestion.hint1 || null,
          hint2: parsed.calcQuestion.hint2 || null,
          misconceptionCount: activeMisconceptions.length,
          patternCount: sampledPatterns.length,
        };
      });
    }

    // 🆕 Level 1: 정성적 문장 + 공식 판별 문장 혼합 출제 지시
    const level1FormulaInstruction = `
[Level 1 절대 금지 - 계산이 필요한 문장]
Level 1은 계산 없이 옳고 그름만 판별하는 단계입니다. 수를 대입해 값을 구해봐야 참·거짓을
가릴 수 있는 문장은 **단 하나도** 만들지 마세요. 아래는 전부 금지입니다.

- "실험실 바닥을 기준면으로 했을 때, 1kg의 물체가 5m 높이에 있을 때의 위치에너지는 49 J이다"
  → mgh에 수를 넣어 계산해야 판별됩니다. 금지.
- "질량 2kg인 물체에 5N의 힘을 가하면 가속도는 2.5 m/s²이다"
  → F=ma에 수를 넣어 계산해야 판별됩니다. 금지.
- "10m/s로 달리는 2kg 공의 운동에너지는 100 J이다"
  → 금지. 이런 수치 판별 문장은 Level 2에서 다룹니다.

반대로, 아래처럼 **공식의 형태**만 보면 되는 문장은 계산이 아니므로 허용됩니다.
- "운동에너지를 구하는 공식은 E = mv²이다" → ½이 빠진 것을 눈으로 보면 됩니다. 허용.
- "운동량의 단위는 kg·m/s이다" → 허용.
- "빛의 속도는 약 3×10⁸ m/s이다" → 상수를 아는지 묻는 것이므로 허용.

판단 기준은 "수치가 들어있는가"가 아니라 **"수를 대입해 계산해야 하는가"**입니다.

[Level 1 추가 규칙 - 공식 판별 문장 혼합]
생성하는 5개의 문장 중 일부는 "공식이 맞는지 틀린지 판별하는 문장"으로 구성해야 합니다.
아래 두 가지 조합 중 하나를 랜덤으로 선택하여 생성하세요:
  - 조합 A: 계산 없이 개념의 옳고 그름을 판단할 수 있는 문장 3개 + 공식이 맞는지 틀린지 판별하는 문장 2개로 총 5개
  - 조합 B: 계산 없이 개념의 옳고 그름을 판단할 수 있는 문장 4개 + 공식이 맞는지 틀린지 판별하는 문장 1개로 총 5개

공식 판별 문장 예시:
  - "일의 양을 구하는 공식은 W = mv² 입니다" (틀림, 올바른 공식은 W = Fs)
  - "F = ma 에서 가속도는 a = m/F 입니다" (틀림, 올바른 식은 a = F/m)
  - "운동량의 단위는 kg·m/s 입니다" (맞음)

공식 판별 문장도 일반 문장과 동일하게 isWrong: true/false로 표시하고, 같은 5문항 배열 안에 섞어서 출력하세요.

[공식 판별 문장에서 금지 - 매우 중요]
참·거짓이 교과서 표기 관례에 따라 달라지는 문장은 만들지 마세요. 채점하는 사람마다 답이
갈리는 문장은 문제로서 성립하지 않습니다. 다음은 전부 금지입니다.

- 부호 관례만 다른 식
  예: "유도 기전력은 ε = -N(ΔΦ/Δt) 이다" — 교과서에 따라 크기만 ε = N(ΔΦ/Δt)로 쓰므로
      맞다고도 틀리다고도 할 수 있습니다. 이런 문장은 만들지 마세요.
- 벡터/스칼라 표기 차이만 있는 식 (F = ma 와 F⃗ = ma⃗)
- 단위계나 기호 이름만 다른 식 (v 대신 u를 쓴 경우 등)
- 근사식·조건부 성립식을 조건 없이 제시한 것 (예: 공기 저항 무시 여부에 따라 갈리는 식)

틀린 공식은 **누가 봐도 틀린 형태**로만 만드세요. 변수가 바뀌었거나(W = mv²), 분자·분모가
뒤집혔거나(a = m/F), 지수가 틀린(E = mc) 경우처럼 표기 관례와 무관하게 틀린 것이어야 합니다.
`;

    // Level 2 Mode A: 참/거짓 3문항 + 계산 서술 2문항 혼합
    const level2AInstruction = level === 2 ? `
[Level 2 추가 규칙 - 계산 서술 혼합]
생성하는 5개의 문장 중:
- 참/거짓 판별 문장: 3개 (개념 옳고 그름)
- 계산 결과가 맞는지 틀린지 판별하는 문장: 2개 (예: "질량 2kg인 물체에 5N의 힘을 가하면 가속도는 2.5m/s²입니다" 형태)
계산 판별 문장도 isWrong: true/false로 표시하고 같은 배열에 섞어주세요.
계산 판별 문장은 실제로 계산해보면 맞거나 틀린 수치가 들어있는 형태입니다.
` : '';

    const levelInstruction = level === 1 ? level1FormulaInstruction : level2AInstruction;

    const prompt = `
당신은 고등학교 물리 교사입니다.
단원: "${unit}"
학생들의 주요 오개념:
${mcText}
${priorityInstruction}
[학술적 참고 자료 (FCI/FMCE 기반)]
- 학생들이 흔히 하는 틀린 생각 예시: ${wrongExamples || '관련 자료 없음'}
- 올바른 물리 개념 예시: ${correctExamples || '관련 자료 없음'}
${patternInstruction}
[출제 다양성 지시 - 매우 중요]
이번 출제는 ${randomAngle} 문장을 구성하세요.
이전에 동일한 오개념으로 여러 번 출제되었을 수 있습니다. 단순히 어미나 단어만 바꾸는 것이 아니라,
완전히 다른 소재·상황·문장 구조를 사용해서 같은 오개념을 다른 각도에서 진단하는 문제를 만드세요.
(출제 다양성 참조 시드: ${varietySeed} - 이 값은 매번 다른 문제를 만들기 위한 내부 참고용이며 출력에 포함하지 마세요)

위 오개념과 학술적 참고 자료의 논리를 바탕으로, 이를 진단하기 위한 문장 5개를 만드세요.

[문장 구성 - 반드시 지킬 것]
- isWrong: true 인 문장은 **정확히 ${wrongCount}개**입니다. ${wrongCount}개보다 많아도 적어도 안 됩니다.
- isWrong: false 인 문장은 **정확히 ${rightCount}개**입니다.
- 출력하기 전에 isWrong: true의 개수를 직접 세어 ${wrongCount}개가 맞는지 확인하세요.
  개수가 다르면 문장을 고쳐서 맞춘 뒤에 출력하세요.
- 아래의 다른 규칙(공식 판별 문장 혼합 등)은 이 개수를 바꾸지 않습니다. 공식 판별 문장도
  ${wrongCount}개 / ${rightCount}개 안에 포함해서 세세요.

- 문장들을 무작위 순서로 섞어주세요
- 자연스러운 한국어로, 고등학생이 이해할 수 있는 수준
${levelInstruction}

[필수 규칙 - 어투 및 표기]
- 생성되는 모든 문장(text)은 반드시 "~한다", "~이다", "~된다" 형태의 평서문(교과서 서술체)으로 작성하세요. (경어체, 반말 금지)
- 중력 가속도가 필요한 문장이라면 반드시 9.8 m/s²를 사용하세요. (10 m/s² 같은 간이값 금지 — 고등학교 물리학Ⅰ/Ⅱ 교육과정 기준 값입니다)
- 수학·물리 기호는 아스키 문자로 대체하지 말고 실제 유니코드 기호를 사용하세요.
  · 제곱·세제곱 등 지수: "m/s^2" (X) → "m/s²" (O)
  · 곱셈: "*" 또는 "x" (X) → "×" (O)
  · 제곱근: "sqrt(2)" 또는 "root2" (X) → "√2" (O)
  · 그리스 문자(마찰계수 μ, 각도 θ, 각속도 ω, 파장 λ 등): "mu", "theta" 같은 로마자 표기 (X) → 실제 그리스 문자 (O)
  · 덧셈/뺄셈 오차 범위: "+-" (X) → "±" (O)

JSON만 출력하세요 (다른 텍스트 금지):
{
  "questions": [
    { "id": 1, "text": "문장 내용", "isWrong": true, "targetMisconceptionId": "위 오개념 목록의 id" },
    { "id": 2, "text": "문장 내용", "isWrong": false }
  ],
  "hint1": "5개 문장 전체를 대상으로, 어떤 물리 개념/법칙을 중심으로 판단해야 하는지 방향만 제시. 어느 문장이 틀렸는지 절대 언급 금지. 1~2문장 경어체.",
  "hint2": "hint1보다 구체적으로, 틀린 문장에 사용된 표현이나 조건의 어떤 부분을 의심해봐야 하는지 유도. 어느 문장인지 직접 지목 금지. 1~2문장 경어체."
}

[오개념 태깅 규칙 - 매우 중요]
- isWrong:true 인 문장 중, 위 [학생들의 주요 오개념] 목록의 특정 오개념을 겨냥한 문장은
  targetMisconceptionId에 그 오개념의 id(대괄호 [id: ...] 안의 값)를 정확히 그대로 적으세요.
- 공식이 맞는지 틀린지 판별하는 문장이나 계산 판별 문장처럼 특정 오개념과 직접 연결되지 않는
  문장은 targetMisconceptionId를 넣지 마세요(생략).
- isWrong:false(옳은 문장)에는 targetMisconceptionId를 넣지 마세요.
- 목록에 없는 id를 지어내지 마세요.

[힌트 작성 규칙]
- 힌트는 문제 세트 전체에 대한 것 (특정 문장 번호 언급 금지)
- hint1: 이 단원/오개념과 관련된 핵심 물리 법칙 방향만 제시
- hint2: 틀린 문장에 쓰인 표현 패턴이나 조건을 간접적으로 유도
- 정답(어느 문장이 틀렸는지) 절대 직접 언급 금지
- 모든 힌트는 "~해보세요", "~생각해보세요" 경어체
`;

    const model = getGeminiModel(0.8, { thinkingBudget: 512, outputTokens: 1536 });
    return await withRetry('generateQuestions', async (attempt) => {
      const result = await model.generateContent(prompt);
      const parsed = parseJSON(result.response.text());

      // 구버전 호환: 배열로 반환된 경우 힌트 없이 래핑
      const questions = Array.isArray(parsed) ? parsed : parsed.questions;
      if (!Array.isArray(questions) || questions.length !== 5) {
        throw new Error(`문장 수가 올바르지 않음 (${Array.isArray(questions) ? questions.length : '배열 아님'})`);
      }
      // 화면이 q.id / q.text / q.isWrong을 그대로 쓰므로 여기서 형태를 보장해둔다
      questions.forEach((q, i) => {
        if (typeof q.text !== 'string' || !q.text.trim()) throw new Error(`${i + 1}번 문장 text 누락`);
        if (typeof q.isWrong !== 'boolean') throw new Error(`${i + 1}번 문장 isWrong 누락`);
        if (typeof q.id !== 'number') q.id = i + 1;
      });
      /* 🔑 틀린 문장 개수는 프롬프트로 지시하는 것만으로는 지켜지지 않는다. Level 1에서
         "1개"로 요청했는데 3개가 나온 사례가 확인됐다. 이 개수에 배점(100 ÷ 틀린 문장 수),
         체감 난이도, 헛다리 감점폭이 전부 걸려 있으므로 서버에서 검사하고 다시 만들게 한다.
         마지막 시도에서는 생성 자체를 실패시키지 않는다 — 개수가 어긋나도 1개 이상이면
         채점은 성립하고, 학생에게 "문제 생성 실패"를 띄우는 쪽이 더 나쁘다. */
      const actualWrong = questions.filter(q => q.isWrong).length;
      if (!actualWrong) {
        throw new Error('틀린 문장이 하나도 없음');   // 채점 자체가 성립 안 함
      }
      if (actualWrong !== wrongCount) {
        if (attempt < MAX_AI_ATTEMPTS) {
          throw new Error(`틀린 문장 개수 불일치 (요청 ${wrongCount}, 생성 ${actualWrong})`);
        }
        console.warn(`[generateQuestions] 틀린 문장 개수 불일치 — 요청 ${wrongCount}, 생성 ${actualWrong}, unit: ${unit}, level: ${level} (마지막 시도라 그대로 사용)`);
      }
      // 오개념 태그(targetMisconceptionId) 정리: 틀린 문장이면서 실제 목록에 있는 id만 남기고
      // 나머지(옳은 문장, 목록 밖 id, 공식/계산 판별 문장 등)는 제거한다. 태깅은 BKT 관측용
      // 부가 정보라, 없거나 어긋나도 재시도하지 않고 조용히 비운다(생성 안정성 우선).
      questions.forEach(q => {
        const ok = q.isWrong && validIdSet.has(q.targetMisconceptionId);
        q.targetMisconceptionId = ok ? q.targetMisconceptionId : null;
      });
      // 🔑 힌트도 반드시 있어야 한다. 예전엔 없으면 null로 통과시켜서, AI가 힌트를
      //    빼먹으면(특히 문제 배열만 반환한 경우) 화면에 하드코딩 기본 문구가 떴다.
      //    없으면 재생성해서 실제 힌트를 받아낸다.
      if (typeof parsed.hint1 !== 'string' || !parsed.hint1.trim() ||
          typeof parsed.hint2 !== 'string' || !parsed.hint2.trim()) {
        throw new Error('힌트 누락');
      }

      /* 🔑 문항 검수 (단계 8-5) — 학생에게 보내기 전에 독립된 호출로 다시 판정한다.
         예전에는 이 대조를 채점할 때 했다. 그래서 라벨이 어긋난 문항을 학생이 이미 다 푼 뒤에야
         발견했고, 결과 화면에 "채점에서 뺀 문항"이라는 이상한 카드가 남았다. 지금은 어긋나면
         그 세트를 통째로 버리고 다시 만든다 — 학생은 검수를 통과한 문장만 본다.
         참·거짓을 단정할 수 없는 문장(ambiguous)도 같은 이유로 버린다. 문제로 성립하지 않는다. */
      const verdicts = await verifyStatements(unit, questions);
      if (verdicts) {
        const rows = questions.map((q, i) => ({ q, i, v: verdicts[i] }));

        /* (1) Level 1에 새어든 계산 문장.
           Level 1은 계산 없이 판별하는 단계라 프롬프트에서 금지하지만, 지시만으로는 지켜지지
           않았다("...위치에너지는 49 J이다"가 실제로 나왔다). 그 문장은 라벨이 맞으니까 아래 (2)를
           그냥 통과해서 아무것도 막지 못했다 — 그래서 난이도도 검수 항목으로 넣는다.
           Level 2 Mode A는 계산 판별 문장을 일부러 요구하므로 검사하지 않는다. */
        const calcLeaks = level === 1 ? rows.filter(({ v }) => v.needsCalc) : [];
        if (calcLeaks.length) {
          const where = calcLeaks.map(({ i }) => `${i + 1}번`).join(', ');
          if (attempt < MAX_AI_ATTEMPTS) {
            throw new Error(`Level 1에 계산 문장 ${calcLeaks.length}건 — ${where}`);
          }
          // 마지막 시도에서는 통과시킨다. 계산 문장은 라벨이 틀린 게 아니라 난이도가 어긋난
          // 것이어서, 학생에게 "문제 생성 실패"를 띄우는 쪽이 더 나쁘다. 빈도는 로그로 본다.
          console.warn(`[generateQuestions] Level 1 계산 문장 ${calcLeaks.length}건 — unit: ${unit}, ${where} (마지막 시도라 그대로 사용)`);
        }

        /* (2) 참·거짓 라벨 대조 */
        const bad = rows.filter(({ q, v }) =>
          v.ambiguous || (typeof v.isFalse === 'boolean' && v.isFalse !== !!q.isWrong));
        if (bad.length) {
          const detail = bad.map(({ q, i, v }) =>
            `${i + 1}번(생성:${q.isWrong ? '거짓' : '참'} 검수:${v.ambiguous ? '모호' : (v.isFalse ? '거짓' : '참')})`
          ).join(', ');
          if (attempt < MAX_AI_ATTEMPTS) throw new Error(`라벨 검수 불일치 ${bad.length}건 — ${detail}`);
          // 마지막 시도: 문제 생성 실패를 띄우느니 검수 결과를 라벨로 채택한다. 판정만 하는
          // 호출이 여러 일을 겸하는 생성 호출보다 라벨에 관해서는 더 믿을 만하다.
          // 모호한 문장은 손댈 근거가 없으므로 생성 라벨을 그대로 둔다.
          const flips = bad.filter(({ v }) => !v.ambiguous && typeof v.isFalse === 'boolean');
          // 다 채택했을 때 틀린 문장이 0개가 되면 채점이 성립하지 않는다. 그럴 땐 채택하지 않고
          // 원래 라벨로 내보낸다(채점 단계의 대조 로그가 다시 잡아준다).
          const wrongAfter = questions.filter(q => {
            const f = flips.find(b => b.q === q);
            return f ? f.v.isFalse : q.isWrong;
          }).length;
          if (wrongAfter > 0) {
            flips.forEach(({ q, v }) => {
              q.isWrong = v.isFalse;
              if (!v.isFalse) q.targetMisconceptionId = null;   // 옳은 문장에는 오개념 태그가 붙을 수 없다
            });
          }
          console.warn(`[generateQuestions] 라벨 검수 불일치 — unit: ${unit}, level: ${level}, ${detail} (마지막 시도, 채택 ${wrongAfter > 0 ? '함' : '안 함'})`);
        }
      }

      return {
        questions,
        hint1: parsed.hint1,
        hint2: parsed.hint2,
        misconceptionCount: activeMisconceptions.length,
        patternCount: sampledPatterns.length,
      };
    });
  } catch (err) {
    console.error('[generateQuestions] Error:', err);
    throw new HttpsError('internal', `문제 생성 실패: ${err.message}`);
  }
});

/* ────────────────────────────────────────
   Function 3-1: recognizeSolutionImage (Level 3 풀이 손글씨/사진 → 텍스트)
──────────────────────────────────────── */
exports.recognizeSolutionImage = onCall(FUNC_OPTIONS, async (request) => {
  await authorize(request, 'recognizeSolutionImage');
  const { imageBase64 } = request.data;
  validateImagePayload(imageBase64);

  try {
    // 손글씨 → 텍스트 그대로 옮겨 적기(OCR). 판단·채점 없음 → thinking 0.
    const model = getGeminiModel(0, { outputTokens: 1024 });
    const prompt = `
다음은 학생이 물리 문제를 풀이한 손글씨 또는 사진입니다.
이미지에 적힌 풀이 과정을 최대한 정확하게 텍스트로 옮겨 적으세요.
- 수식은 일반 텍스트로 표기하세요 (예: F=ma, v^2 = 2as)
- 판독이 어려운 부분은 [판독불가]로 표시하세요
- 옮겨 적기만 하고, 채점하거나 평가하지 마세요

JSON만 출력하세요:
{ "text": "옮겨 적은 풀이 과정 전체" }
`;
    return await withRetry('recognizeSolutionImage', async () => {
      const result = await model.generateContent([
        prompt,
        { inlineData: { mimeType: 'image/png', data: imageBase64 } },
      ]);
      const parsed = parseJSON(result.response.text());
      // 빈 문자열은 정상 결과일 수 있음(백지 제출) — 필드 자체가 없을 때만 재시도
      if (typeof parsed.text !== 'string') throw new Error('text 필드 누락');
      return { text: parsed.text };
    });
  } catch (err) {
    console.error('[recognizeSolutionImage] Error:', err);
    throw new HttpsError('internal', `풀이 인식 실패: ${err.message}`);
  }
});

/* ────────────────────────────────────────
   Function 3-2: gradeSolutionProcess (Level 3 풀이 과정 채점)
──────────────────────────────────────── */
exports.gradeSolutionProcess = onCall(FUNC_OPTIONS, async (request) => {
  await authorize(request, 'gradeSolutionProcess');
  const { questionText, correctAnswer, unit, solutionSteps, processText, answerText } = request.data;
  if (!questionText || (!processText && !answerText)) {
    throw new HttpsError('invalid-argument', '문제 또는 풀이/답안 정보가 없습니다');
  }

  try {
    // 다단계 풀이의 논리적 타당성을 평가하는 작업이라 추론이 실제로 필요 → thinking 허용.
    const model = getGeminiModel(0, { thinkingBudget: 1024, outputTokens: 1024 });
    const stepsText = (solutionSteps || []).join('\n');

    // 숫자 입력칸 대신 직접 쓴 답(근호·분수 등)이 있으면 정오 여부도 함께 판단
    const answerCheckBlock = answerText ? `
학생이 숫자 입력란 대신 직접 작성한 최종 답: "${answerText}"
이 답이 정답(${correctAnswer} ${unit || ''})과 실질적으로 같은 값인지 판단하세요.
표현 형태가 달라도(예: 근호, 분수, 소수, 단위 표기 차이) 값이 사실상 같으면 정답으로 인정하세요.
` : '';

    const prompt = `
당신은 고등학교 물리 교사입니다.

문제: "${questionText}"
정답: ${correctAnswer} ${unit || ''}
모범 풀이 단계:
${stepsText || '(제공되지 않음)'}

학생이 작성한 풀이 과정:
"${processText || '(제공되지 않음)'}"
${answerCheckBlock}

학생의 풀이 과정이 물리적으로 타당한 논리와 절차를 거쳤는지 채점하세요.
${answerText ? '' : '최종 답이 맞았는지는 이미 별도로 채점되므로, 여기서는 오직 "풀이 과정 자체의 논리적 타당성"만 평가하세요.'}

[필수 규칙]
1. 어투: 설명은 반드시 "~습니다", "~합니다" 형태의 경어체
2. feedback을 작성할 때 학생이 쓴 풀이를 먼저 언급하며 잘한 점 또는 고칠 점을 짚어주세요.
3. 채점 기준 (풀이 과정 score):
   - 90~100점: 필요한 물리 법칙을 모두 올바르게 적용하고 계산 절차도 타당함
   - 50~89점: 방향은 맞지만 일부 단계 누락/오류가 있음
   - 10~49점: 관련 개념을 일부 언급했으나 논리 전개가 부족함
   - 0~9점: 풀이 과정이 없거나 문제와 무관함
4. 감점 사유 명시 (매우 중요): score가 100점이 아니라면, feedback에 "정확히 무엇 때문에 감점됐는지"를 반드시 구체적으로 짚어야 합니다.
   (예: "다만 마찰력에 의한 열에너지 손실을 계산하는 과정에서 마찰 구간의 길이를 잘못 대입해 2점이 감점되었습니다.")
   막연히 "잘했습니다"로만 끝내지 말고, 100점이 아닌 이유를 학생이 이해할 수 있게 콕 집어 설명하세요.
   score가 100점이면 감점 사유 없이 칭찬만 해도 됩니다.

JSON만 출력하세요:
{
  "score": 0~100 사이 정수,
  "feedback": "학생 풀이에 대한 구체적 코멘트. 100점이 아니면 감점 사유를 반드시 포함 (2~3문장 이상)"${answerText ? ',\n  "answerCorrect": true 또는 false (위 직접 쓴 답이 정답과 같은지)' : ''}
}
`;
    return await withRetry('gradeSolutionProcess', async () => {
      const result = await model.generateContent(prompt);
      const parsed = parseJSON(result.response.text());
      // score가 없으면 0점 처리하지 말고 재시도할 것 — 채점 실패를 학생의 0점으로
      // 둔갑시키면 안 된다. 학습 이력에 그대로 남는 값이다.
      if (typeof parsed.score !== 'number' || !Number.isFinite(parsed.score)) {
        throw new Error(`score가 숫자가 아님 (${parsed.score})`);
      }
      if (typeof parsed.feedback !== 'string' || !parsed.feedback.trim()) {
        throw new Error('feedback 누락');
      }
      return {
        score: Math.max(0, Math.min(100, Math.round(parsed.score))),
        feedback: parsed.feedback,
        answerCorrect: answerText ? !!parsed.answerCorrect : null,
      };
    });
  } catch (err) {
    console.error('[gradeSolutionProcess] Error:', err);
    throw new HttpsError('internal', `풀이 과정 채점 실패: ${err.message}`);
  }
});

/* ────────────────────────────────────────
   Function 3-3: gradeAnswers
──────────────────────────────────────── */
exports.gradeAnswers = onCall(FUNC_OPTIONS, async (request) => {
  await authorize(request, 'gradeAnswers');
  const { answers, questions, unit } = request.data;
  if (!answers || !questions) {
    throw new HttpsError('invalid-argument', '답변 또는 문제 정보가 없습니다');
  }

  try {
    const questionListText = questions.map(q => `[문장 ${q.id}] ${q.text}`).join('\n');
    const answerText = answers.map(a => `
[문장 ${a.questionId}]
- 학생의 답변: "${a.reason || a.answer || ''}" 
`).join('\n') || "제출한 서술형 답변이 없습니다.";

    const targetWrongCount = questions.filter(q => q.isWrong).length || 1; 
    const maxScorePerItem = Math.round(100 / targetWrongCount); 
    const partialScoreRange = targetWrongCount === 1 ? '20~60점' : '10~30점';

    // 서술형 답변 5개를 루브릭에 따라 채점 + 해설 작성. 약간의 추론이 도움 → 소량 허용.
    // 해설 5개를 담아야 하므로 출력 상한은 넉넉히.
    const model = getGeminiModel(0, { thinkingBudget: 512, outputTokens: 2048 });
    const prompt = `
당신은 고등학교 물리 교사입니다.
단원: "${unit}"

전체 문제 목록:
${questionListText}

학생이 제출한 답변 (일부 문장에만 답변했을 수 있음):
${answerText}

학생의 답변을 채점하고, 학생이 답변하지 않은 문장을 포함하여 전체 5개 문장 모두에 대한 피드백을 작성하세요.

[필수 규칙]
1. 어투: 모든 설명(explanation)은 반드시 "~습니다", "~합니다" 형태의 경어체를 사용하세요.
2. 피드백 구조화 (매우 중요): 'explanation'을 작성할 때, **무조건 학생이 작성한 답변을 먼저 언급하며 칭찬하거나 교정**해 주세요. (예: "학생이 작성한 '...'라는 답변처럼 핵심을 정확히 짚었습니다.", "학생의 답변대로 ...입니다.") 그 후, 심화 물리 법칙을 자연스럽게 보충 설명하세요. 단순히 "이 문장은 틀린 진술입니다"로 시작하는 기계적인 답변을 절대 금지합니다.
3. 유연한 채점 (핵심): 학생의 답변이 완벽하지 않더라도 오개념을 지적하는 핵심 논리를 포함했다면 \`isCorrectAnswer\`를 \`true\`로 평가하세요.
   - 표현이 교과서와 달라도, 법칙 이름을 대지 않아도, 핵심 주장이 물리적으로 맞으면 정답입니다.
   - 학생이 더 깊거나 다른 관점에서 옳게 설명한 경우도 정답입니다. 예상한 표현과 다르다는 이유로 오답 처리하지 마세요.
4. 보충 설명 분리: 학생이 핵심을 맞췄다면 정답 처리하고, 부족한 부가 설명은 explanation 텍스트에만 부드럽게 덧붙이세요.
5. 자기 모순 금지 (매우 중요): explanation에서 학생의 판단이 옳다고 인정했다면 \`isCorrectAnswer\`는 반드시 \`true\`여야 합니다. 해설과 판정이 어긋나면 안 됩니다.
6. 명확한 배점 기준 (학생이 찾아야 할 오개념 문장은 총 ${targetWrongCount}개이며, 문항당 최대 배점은 ${maxScorePerItem}점입니다):
   - 만점 (${maxScorePerItem}점): 핵심을 올바르게 지적한 답변 (\`isCorrectAnswer: true\`)
   - 부분 점수 (${partialScoreRange}): 오개념 문장으로 골랐으나, 작성한 이유가 틀린 경우 (\`isCorrectAnswer: false\`)
   - 0점: 답변을 아예 작성하지 않은 경우

[문장 참·거짓 재판정 - 매우 중요]
\`statementIsWrong\`에는 **학생의 답변과 무관하게**, 그 문장 자체가 물리적으로 틀렸는지를 적으세요.
- 문장이 물리적으로 거짓이면 true, 참이면 false
- 학생이 무엇을 골랐는지, 어떻게 썼는지는 이 판단에 영향을 주면 안 됩니다
- 문제를 낸 쪽의 의도를 추측하지 말고, 문장만 읽고 물리 법칙으로 판단하세요
이 값은 문제 생성 단계의 판정과 대조해 검수하는 데 쓰입니다.

JSON만 출력하세요 (다른 텍스트 금지):
{
  "items": [
    {
      "questionId": 번호(정수),
      "statementIsWrong": true/false,
      "isCorrectAnswer": true/false,
      "score": 0~${maxScorePerItem} 사이 이 문항 점수 (미답변이면 0),
      "explanation": "학생 답변에 대한 직접적인 코멘트 + 상세한 물리 해설 (최소 2~3문장 이상)"
    }
  ]
}
`;

    const graded = await withRetry('gradeAnswers', async () => {
      const result = await model.generateContent(prompt);
      const parsed = parseJSON(result.response.text());
      if (!Array.isArray(parsed.items) || !parsed.items.length) {
        throw new Error('items 배열 누락');
      }
      // 학생이 실제로 답한 문항이 채점 결과에 빠져 있으면 그 문항은 0점 처리돼버린다.
      // 누락은 재시도로 받아내는 게 맞다.
      const gradedIds = new Set(parsed.items.map(it => it.questionId));
      const missing = answers
        .map(a => a.questionId)
        .filter(id => !gradedIds.has(id));
      if (missing.length) throw new Error(`채점 누락 문항: ${missing.join(', ')}`);
      return parsed;
    });

    let rawTotalScore = 0;
    const mismatched = [];   // 라벨 대조가 갈린 문항 (로그·오류율 집계용)

    const feedbackItems = questions.map(q => {
      const gradedItem = graded.items?.find(g => g.questionId === q.id);
      const answered   = answers.find(a => a.questionId === q.id);

      /* 🔑 라벨 대조는 여기서 "기록만" 한다 (단계 8-5).
         예전에는 문제를 만든 판정과 채점하는 판정이 어긋나면 그 문항을 무효로 만들고 결과
         화면에 "채점에서 뺀 문항"으로 띄웠다. 학생이 이미 다 푼 뒤에 시스템 사정을 통보하는
         셈이라 보기에 좋지 않았다. 지금은 생성 단계에서 독립 호출로 검증하고 어긋나면 그
         세트를 버리고 다시 만든다(verifyStatements). 그래서 학생은 검수를 통과한 문장만 본다.
         그럼에도 세 번째 판정이 갈리는 경우가 남는데, 그때는 화면을 건드리지 않고
         이해도 관측에서만 빼고 로그를 남긴다 — 점수 한 문항보다 이해도 오염이 오래간다. */
      const rejudged = gradedItem?.statementIsWrong;
      const labelMismatch = typeof rejudged === 'boolean' && rejudged !== !!q.isWrong;
      if (labelMismatch) {
        mismatched.push({ id: q.id, 생성: q.isWrong ? '거짓' : '참', 채점: rejudged ? '거짓' : '참', text: q.text.slice(0, 40) });
      }

      /* isCorrectAnswer를 여기서 확정한다. 예전엔 AI 값을 그대로 쓰고 없으면 !isWrong으로
         채웠는데, 그러면 학생이 손도 대지 않은 문항에 AI의 임의 판단이 들어가 "안 푼 문제로
         이해도가 오르는" 일이 생겼다. 세 경우를 명시적으로 나눈다. */
      let isCorrectAnswer;
      if (!answered)       isCorrectAnswer = !q.isWrong;                      // 안 고름: 틀린 문장이면 못 찾은 것
      else if (!q.isWrong) isCorrectAnswer = false;                           // 옳은 문장을 고름 (헛다리)
      else                 isCorrectAnswer = gradedItem?.isCorrectAnswer === true;

      // 점수: 맞춘 건 더하고, 엄한 걸 잡으면 감점.
      if (q.isWrong) {
        rawTotalScore += (gradedItem?.score || 0);
      } else if (answered) {
        // 맞는 문장인데 오개념이라고 억울하게 고른 경우(헛다리): 무지성 체크 방지용 감점.
        // 🔑 고정 -20이 아니라 문항당 배점에 비례(절반)시킨다. 예전엔 틀린 문장이 1개인
        //    문제(문항 만점 100)와 2개인 문제(만점 50)에 똑같이 -20이라, 같은 "다 찍기"인데도
        //    벌점 무게가 두 배 차이 났다. maxScorePerItem × 0.5로 문제 유형과 무관하게 공평하게.
        rawTotalScore -= Math.round(maxScorePerItem * 0.5);
      }

      return {
        id:              q.id,
        text:            q.text,
        isWrong:         q.isWrong,
        isCorrectAnswer,
        userReason:      answered?.reason || answered?.answer,
        explanation:     gradedItem?.explanation || '설명이 누락되었습니다.',
        // 🆕 문항이 겨냥한 오개념(있으면) — 저장 후 BKT 관측으로 쓰임. 태그 없으면 null.
        //    라벨 대조가 갈린 문항은 태그를 떼어 이해도에서 뺀다(화면에는 그대로 보인다).
        targetMisconceptionId: labelMismatch ? null : (q.targetMisconceptionId ?? null),
      };
    });

    // 🔑 "N개 중 M개 정답"은 학생이 실제로 고른 문항만 센다. 예전엔 미체크 문항까지 세어,
    //    화면의 "정답" 칸은 비었는데 부제만 1개 정답이라고 나오는 일이 있었다.
    const answeredItems   = feedbackItems.filter(i => i.userReason !== undefined && i.userReason !== null);
    const wrongAnswered   = answeredItems.filter(i => i.isWrong && !i.isCorrectAnswer);
    const correctAnswered = answeredItems.filter(i => i.isWrong && i.isCorrectAnswer);
    const gradableWrong   = feedbackItems.filter(i => i.isWrong).length;

    const misconceptionTags = [
      ...wrongAnswered.map(i => ({
        text: `${i.text.slice(0, 12)}... 오개념`,
        type: 'wrong',
      })),
      ...correctAnswered.map(i => ({
        text: `${i.text.slice(0, 12)}... 이해`,
        type: 'correct',
      })),
    ].slice(0, 4);

    // 2. 점수 정제 로직 변경: 마이너스 점수가 나오지 않도록 하한선(0점) 추가
    rawTotalScore = Math.max(0, Math.min(rawTotalScore, 100)); // 0점 ~ 100점 사이로 고정
    const finalScore = Math.round(rawTotalScore / 5) * 5;

    const subtitle = gradableWrong > 0
      ? `틀린 문장 ${gradableWrong}개 중 ${correctAnswered.length}개 정답`
      : '채점할 수 있는 문항이 없었어요';

    /* 라벨 대조가 갈린 건수는 화면에 띄우지 않고 로그로만 남긴다. 생성 단계 검증(단계 8-5)을
       통과한 문장에서 이게 얼마나 나오는지가 곧 문항 오류율이라, 논문의 실측치로 쓴다. */
    if (mismatched.length) {
      console.warn(`[gradeAnswers] 라벨 대조 불일치 ${mismatched.length}건 (이해도 관측에서만 제외) — unit: ${unit}`, mismatched);
    }

    return {
      score: finalScore,
      title: finalScore >= 80 ? '훌륭해요! 🎉' : finalScore >= 60 ? '잘 하셨어요! 👍' : '조금 더 공부해봐요 📚',
      subtitle,
      misconceptions: misconceptionTags,
      mismatchCount: mismatched.length,
      items: feedbackItems,
    };
  } catch (err) {
    console.error('[gradeAnswers] Error:', err);
    throw new HttpsError('internal', `채점 실패: ${err.message}`);
  }
});