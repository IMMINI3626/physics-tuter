/* ============================================================
   PhysiClinic — Firebase Cloud Functions
   Node.js 20 / Firebase Functions v2

   Gemini API 서버 사이드 안전 호출 & Firestore RAG 연동
   프롬프트는 prompts.js, 구현 결정 근거는 docs/서버구현_결정기록.md
   ============================================================ */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret }       = require('firebase-functions/params');
const { GoogleGenerativeAI } = require('@google/generative-ai');

/* Gemini 프롬프트 템플릿 — 전부 문자열을 만들어 돌려주는 순수 함수다 (functions/prompts.js).
   AI 동작을 조정할 때 가장 자주 손대는 부분이라 로직과 분리했다. */
const P = require('./prompts');

// DB 접근을 위한 Admin SDK 초기화
const admin = require('firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp();
}
const db = admin.firestore();

/* Gemini API 키 Secret 관리 */
const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');

/* 함수 공통 옵션. timeoutSeconds는 비용이 아니라 최악의 대기시간 상한이다 (S-4). */
const FUNC_OPTIONS = {
  region: 'asia-northeast3',  // 서울 리전
  secrets: [GEMINI_API_KEY],
  timeoutSeconds: 120,
};

/* AI 호출 최대 시도 횟수 (최초 1회 + 재시도 2회) */
const MAX_AI_ATTEMPTS = 3;

/* 판별 문장 5개 중 "틀린 문장"의 개수 상한 (설계 4-12). 매 세트 1~MAX_WRONG개를 랜덤으로
   요청하고, 이 값을 넘는 세트는 학생에게 내보내지 않는다. 논문이 보고하는 조건이라
   조용히 넘기면 측정 조건이 문서와 달라진다. */
const MAX_WRONG = 3;

/* uid 하나가 하루에 쓸 수 있는 AI 호출 수 — 게스트 40 ≈ 15세트, 로그인 400 ≈ 150세트 (S-1) */
const DAILY_AI_LIMIT = { guest: 40, member: 400 };

/* base64 이미지 상한. 정상 사진(1600px JPEG q0.8)은 300~700KB라 전부 통과한다 (S-7). */
const MAX_IMAGE_BASE64_BYTES = 2 * 1024 * 1024;

/* 위 상수들과 아래 헬퍼의 결정 근거는 docs/서버구현_결정기록.md의 S-번호 절에 있다. */

/* ------------------------------------------------------------
   유틸리티 함수 모음
   ------------------------------------------------------------ */

/**
 * 호출 자격 검사 + uid 단위 일일 상한 — 모든 AI 함수의 첫 줄에서 부른다.
 * 익명 로그인도 통과시킨다(무료 체험 유지). 근거는 docs/서버구현_결정기록.md S-1.
 *
 * 🔑 반드시 각 함수의 try 블록 "밖에서" 부를 것. 안에서 부르면 그 함수의 catch가
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
 * 오개념 마스터(128개)를 인스턴스가 살아있는 동안 재사용합니다. seed.js로만 바뀌는 정적
 * 데이터라 호출마다 다시 읽을 이유가 없다. 재시딩 후 수 분간 옛 목록이 쓰일 수 있다는
 * 트레이드오프까지 docs/서버구현_결정기록.md S-2.
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
 * Gemini 모델 인스턴스를 반환합니다. 작업별 예산 표와 근거는 docs/서버구현_결정기록.md S-4.
 *
 * @param {number} temperature      기본 0(결정적). 문제 생성처럼 다양성이 필요하면 높인다.
 * @param {object} [opts]
 * @param {number} [opts.thinkingBudget=0]  추론 토큰 상한. 0 = 끔(Flash는 0을 허용).
 *        추론이 필요 없는 작업(분류·OCR)은 0, 논리 일관성이 중요한 작업만 준다.
 * @param {number} [opts.outputTokens]  **답변에만** 필요한 토큰 양을 넣는다.
 *        🔑 2.5 모델은 thinking과 답변이 maxOutputTokens 예산을 함께 쓴다. 답변 크기로만
 *        잡으면 추론이 예산을 다 써서 JSON이 잘린다 — 그래서 이 함수가 thinkingBudget을
 *        더해 maxOutputTokens = thinkingBudget + outputTokens 로 설정한다.
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
 * 생성된 판별 문장을 독립된 호출로 검수합니다 — isFalse(참·거짓 라벨)와 needsCalc(계산이
 * 필요한 문장인가)를 함께 판정한다 (설계 단계 8-5·8-6).
 *
 * 🔑 문장 외의 맥락(오개념 목록·겨냥 지시·생성 라벨·학생 답변)은 일부러 주지 않는다. 주면
 *    생성 호출의 판단을 따라가서 검수가 성립하지 않는다. 이유는 docs/서버구현_결정기록.md S-8.
 *
 * @returns {Array<{isFalse: boolean|null, ambiguous: boolean, needsCalc: boolean}> | null}
 *          형식이 깨지면 null(검수 생략 — 품질 장치이지 필수 경로가 아니다).
 */
async function verifyStatements(unit, questions) {
  const list = questions.map((q, i) => `${i + 1}. ${q.text}`).join('\n');
  const prompt = P.verifyStatements({ unit, list });
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
 * AI 호출을 재시도로 감쌉니다 (최초 1회 + 2회, 400ms → 800ms). LLM은 일정 비율로 형식을
 * 어기므로 사용자에게 실패를 띄우기 전에 서버에서 조용히 다시 묻는다.
 *
 * 🔑 검증(파싱·형식 확인)까지 fn 안에서 할 것. 밖에서 하면 "형식이 틀린 응답"이 재시도를
 *    유발하지 못하고 그대로 실패로 빠진다.
 * 재시도를 다 쓴 뒤 항목별로 실패시킬지 통과시킬지는 docs/서버구현_결정기록.md S-5 표 참고.
 *
 * @param {string} label   로그 식별용 함수명
 * @param {Function} fn    호출 + 파싱 + 검증까지 수행하는 async 함수 (attempt를 받는다)
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
 * 🔑 핵심은 unitOptions에 정답 단위가 실제로 들어있는지다. 프론트(QuizScreen.initCalc)가
 *    `선택값 === calcQuestion.unit`으로 채점하므로, 없으면 무엇을 골라도 무조건 오답이 된다.
 *    표기만 다른 경우('m/s²' vs 'm/s^2')는 재시도 대신 보기 문자열을 교정한다.
 *    자세한 근거는 docs/서버구현_결정기록.md S-6.
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
    const prompt = P.extractKeywords({ dbMisconceptions });

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
/* 출제 관점 — 같은 오개념을 매번 다른 각도에서 묻게 만드는 랜덤 시드 중 하나 */
const ANGLES = [
  '일상생활 속 예시(스포츠, 교통수단, 놀이기구 등)를 활용한 상황 설정으로',
  '실험실에서 진행하는 실험 상황을 가정하여',
  '두 물체 또는 두 상황을 서로 비교하는 형태로',
  '시간에 따른 변화 과정을 서술하는 형태로',
  '특정 순간의 물리량 관계를 설명하는 형태로',
  '학생들이 흔히 떠올릴 법한 직관적 생각을 그대로 문장화하는 형태로',
];

/**
 * 프롬프트에 실을 재료를 한 번에 모읍니다 — Firestore 3개 컬렉션 + 랜덤 요소.
 *
 * 세 생성기(L3 계산 / L2B 계산 / 문장 5개)가 같은 재료를 쓰므로 여기서 한 번만 만든다.
 * 🔑 Math.random() 호출 순서(패턴 셔플 → wrongCount → 관점 → 시드)는 바꾸지 말 것.
 *    같은 입력에 같은 프롬프트가 나오는지 검증할 때 이 순서가 기준이 된다.
 */
async function loadUnitContext(unit, misconceptions, targetMisconceptionIds) {
  // 소단원 오개념이 있으면 그걸 쓰고, 없으면 Gemini가 사진에서 골라준 목록으로 대체
  const subUnitMisconceptions = (await loadMisconceptions()).filter(m => m.subUnit === unit);
  const activeMisconceptions = subUnitMisconceptions.length > 0 ? subUnitMisconceptions : misconceptions;

  const validIds = activeMisconceptions.map(mc => mc.id).filter(Boolean);
  // AI가 붙인 태그가 실제 목록 안의 id인지 확인하는 데 쓴다
  const validIdSet = new Set(validIds);

  /* 🔑 예전엔 오개념 id마다 쿼리를 하나씩 날려서 소단원 하나에 최대 22번이 됐다
     (뉴턴 운동 법칙 22개). in 연산자가 한 번에 30개를 받으므로 지금 데이터는 쿼리 1회로 끝난다. */
  const ID_CHUNK = 30;
  const idChunks = [];
  for (let i = 0; i < validIds.length; i += ID_CHUNK) idChunks.push(validIds.slice(i, i + ID_CHUNK));
  const querySnapshots = await Promise.all(idChunks.map(chunk =>
    db.collection('misconception_sentences').where('misconceptionId', 'in', chunk).get()
  ));
  const contextSentences = querySnapshots.flatMap(snap => snap.docs.map(doc => doc.data()));

  // 기출 유형 패턴 (완자 물리학Ⅰ 유형 추상화 DB, 원문 미포함) — 스타일 참고용으로 3개만 샘플링
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

  /* 순환 출제(설계 4-8): 클라이언트가 이해도 낮은 오개념을 우선 겨냥 대상으로 보내온다.
     목록 밖 id는 버리고 최대 3개까지. 지정이 없으면 전체에서 자유 출제한다. */
  const priorityIds = [...new Set(
    (Array.isArray(targetMisconceptionIds) ? targetMisconceptionIds : []).filter(id => validIdSet.has(id))
  )].slice(0, 3);

  // 오개념이 22개까지 가므로, 우선 대상을 목록 맨 앞으로 올려 프롬프트에서 눈에 띄게 한다
  const orderedMisconceptions = priorityIds.length
    ? [...activeMisconceptions].sort(
        (a, b) => (priorityIds.includes(b.id) ? 1 : 0) - (priorityIds.includes(a.id) ? 1 : 0))
    : activeMisconceptions;

  /* id와 개념 영역(dimensionCode)을 함께 노출한다. id는 태깅(BKT 관측의 근거)에, 영역은
     "한 문장에 묶어도 되는 오개념"을 고르는 데 쓴다 — 영역이 다르면 학생의 서술 하나로
     둘 다 판정할 근거가 없다(설계 4-12). */
  const mcText = orderedMisconceptions
    .map((mc, i) => `${i + 1}. [id: ${mc.id || '?'} | 영역: ${mc.dimensionCode || '?'}] ${mc.description}`)
    .join('\n');

  /* 🔑 틀린 문장 개수는 1~3개 랜덤이다(예전 1~2개). 태그가 붙는 건 틀린 문장뿐이라 이 개수가
     곧 한 세트에서 전진하는 오개념 수의 상한이다 — 1~2개로는 오개념 22개 소단원이 Level 1
     승급까지 36세트 걸렸다(설계 4-10, 4-12). 고정하지 않는 이유는 개수를 알면 "그만큼 찍기"가
     최적 전략이 되기 때문이다(진단검사 비율을 3:2로 고정했다가 겪은 문제와 같다 — 4-11 규칙 3). */
  const wrongCount = Math.floor(Math.random() * MAX_WRONG) + 1;   // 1 ~ MAX_WRONG

  return {
    activeMisconceptions, validIdSet, sampledPatterns, mcText,
    patternInstruction: P.patternBlock(patternText),
    priorityInstruction: P.priorityBlock(priorityIds, activeMisconceptions),
    wrongExamples:   contextSentences.filter(s => s.isWrong).map(s => s.sentence).join(' / '),
    correctExamples: contextSentences.filter(s => !s.isWrong).map(s => s.sentence).join(' / '),
    wrongCount,
    rightCount: 5 - wrongCount,
    randomAngle: ANGLES[Math.floor(Math.random() * ANGLES.length)],
    // 매 호출마다 고유한 시드를 줘서 같은 입력이어도 다른 결과를 유도
    varietySeed: Math.random().toString(36).slice(2, 8),
  };
}

/**
 * AI가 돌려준 문장 5개의 형태를 검증합니다. 어긋나면 throw → withRetry가 다시 만든다.
 *
 * 🔑 틀린 문장 개수는 프롬프트 지시만으로는 지켜지지 않는다(1개 요청에 4개가 나온 사례 확인).
 *    이 개수에 배점(100 ÷ 틀린 문장 수), 체감 난이도, 헛다리 감점폭이 전부 걸려 있다.
 *    부족한 쪽과 넘치는 쪽을 다르게 다룬다.
 *
 *    - 요청보다 **적으면** 마지막 시도에서 통과시킨다. 1개 이상이면 채점은 성립하고,
 *      학생에게 "문제 생성 실패"를 띄우는 쪽이 더 나쁘다.
 *    - 요청보다 많아 **MAX_WRONG(3)을 넘으면 끝까지 실패시킨다.** 설계가 정한 상한이고
 *      (설계 4-12), 논문이 "틀린 문장 1~3개"로 보고하는 값이다. 조용히 4~5개를 내보내면
 *      측정 조건이 문서와 달라진다. 넘치는 문장을 참으로 되돌리는 것도 답이 아니다 —
 *      실제로 거짓인 문장에 참 라벨을 붙이면 학생이 옳게 짚고 헛다리 감점을 맞는다(단계 8-7).
 */
function validateStatementSet(parsed, questions, { wrongCount, unit, level, attempt }) {
  if (!Array.isArray(questions) || questions.length !== 5) {
    throw new Error(`문장 수가 올바르지 않음 (${Array.isArray(questions) ? questions.length : '배열 아님'})`);
  }
  // 화면이 q.id / q.text / q.isWrong을 그대로 쓰므로 여기서 형태를 보장해둔다
  questions.forEach((q, i) => {
    if (typeof q.text !== 'string' || !q.text.trim()) throw new Error(`${i + 1}번 문장 text 누락`);
    if (typeof q.isWrong !== 'boolean') throw new Error(`${i + 1}번 문장 isWrong 누락`);
    if (typeof q.id !== 'number') q.id = i + 1;
  });

  const actualWrong = questions.filter(q => q.isWrong).length;
  if (!actualWrong) throw new Error('틀린 문장이 하나도 없음');   // 채점 자체가 성립 안 함
  if (actualWrong > MAX_WRONG) {
    // 상한 초과는 마지막 시도에서도 통과시키지 않는다 (위 주석 참고)
    throw new Error(`틀린 문장이 상한 초과 (요청 ${wrongCount}, 생성 ${actualWrong}, 상한 ${MAX_WRONG})`);
  }
  if (actualWrong !== wrongCount) {
    if (attempt < MAX_AI_ATTEMPTS) {
      throw new Error(`틀린 문장 개수 불일치 (요청 ${wrongCount}, 생성 ${actualWrong})`);
    }
    console.warn(`[generateQuestions] 틀린 문장 개수 불일치 — 요청 ${wrongCount}, 생성 ${actualWrong}, unit: ${unit}, level: ${level} (요청보다 적어서 마지막 시도라 그대로 사용)`);
  }

  /* 🔑 힌트도 반드시 있어야 한다. 예전엔 없으면 null로 통과시켜서, AI가 힌트를 빼먹으면
     (특히 문제 배열만 반환한 경우) 화면에 하드코딩 기본 문구가 떴다. */
  if (typeof parsed.hint1 !== 'string' || !parsed.hint1.trim() ||
      typeof parsed.hint2 !== 'string' || !parsed.hint2.trim()) {
    throw new Error('힌트 누락');
  }
}

/**
 * 오개념 태그를 정리합니다 — 틀린 문장이면서 목록에 있는 id만 남긴다.
 *
 * 태깅은 BKT 관측용 부가 정보라, 없거나 어긋나도 재시도하지 않고 조용히 비운다(생성 안정성 우선).
 * 🔑 한 문장에 2개까지 허용하되 **영역(dimensionCode)이 같을 때만** 남긴다(설계 4-12).
 *    프롬프트로도 지시하지만 지켜지지 않을 수 있고, 영역이 다른 두 오개념을 한 서술로
 *    판정하는 건 애초에 성립하지 않는다. 영역이 갈리면 첫 번째만 남긴다.
 */
function normalizeTags(questions, activeMisconceptions, validIdSet) {
  const dimOf = {};
  activeMisconceptions.forEach(m => { if (m.id) dimOf[m.id] = m.dimensionCode || null; });

  questions.forEach(q => {
    // 구버전 호환: 모델이 단수 필드로 답할 수도 있다
    const raw = Array.isArray(q.targetMisconceptionIds)
      ? q.targetMisconceptionIds
      : (q.targetMisconceptionId ? [q.targetMisconceptionId] : []);
    delete q.targetMisconceptionId;

    if (!q.isWrong) { q.targetMisconceptionIds = []; return; }

    const clean = [...new Set(raw.filter(id => validIdSet.has(id)))];
    if (clean.length > 1) {
      const dim = dimOf[clean[0]];
      // 첫 id와 같은 영역인 것만 유지 (영역 정보가 없으면 보수적으로 1개만)
      const same = dim ? clean.filter(id => dimOf[id] === dim) : [clean[0]];
      q.targetMisconceptionIds = same.slice(0, 2);
    } else {
      q.targetMisconceptionIds = clean.slice(0, 1);
    }
  });
}

/**
 * 학생에게 보내기 전 문항을 독립된 호출로 검수합니다 (단계 8-5, 8-6).
 *
 * 예전에는 이 대조를 채점할 때 했다. 라벨이 어긋난 문항을 학생이 이미 다 푼 뒤에 발견해서
 * 결과 화면에 "채점에서 뺀 문항" 카드가 남았다. 지금은 어긋나면 세트를 통째로 버리고 다시
 * 만들므로, 학생은 검수를 통과한 문장만 본다. 참·거짓을 단정할 수 없는 문장(ambiguous)도
 * 같은 이유로 버린다 — 문제로 성립하지 않는다.
 *
 * questions를 제자리에서 고칠 수 있다(마지막 시도에서 라벨 채택).
 */
async function reviewStatementSet(questions, { unit, level, attempt }) {
  const verdicts = await verifyStatements(unit, questions);
  if (!verdicts) return;   // 검수 호출 실패 — 품질 장치이지 필수 경로가 아니다
  const rows = questions.map((q, i) => ({ q, i, v: verdicts[i] }));

  /* (1) Level 1에 새어든 계산 문장 (단계 8-6).
     프롬프트에서 금지하지만 지시만으로는 지켜지지 않았다("...위치에너지는 49 J이다"가 실제로
     나왔다). 그 문장은 라벨이 맞으니까 아래 (2)를 그냥 통과해 아무것도 막지 못했다.
     Level 2 Mode A는 계산 판별 문장을 일부러 요구하므로 검사하지 않는다. */
  const calcLeaks = level === 1 ? rows.filter(({ v }) => v.needsCalc) : [];
  if (calcLeaks.length) {
    const where = calcLeaks.map(({ i }) => `${i + 1}번`).join(', ');
    if (attempt < MAX_AI_ATTEMPTS) {
      throw new Error(`Level 1에 계산 문장 ${calcLeaks.length}건 — ${where}`);
    }
    // 마지막 시도는 통과시킨다 — 라벨이 틀린 게 아니라 난이도가 어긋난 것이라, "문제 생성
    // 실패"를 띄우는 쪽이 더 나쁘다. 빈도는 로그로 본다.
    console.warn(`[generateQuestions] Level 1 계산 문장 ${calcLeaks.length}건 — unit: ${unit}, ${where} (마지막 시도라 그대로 사용)`);
  }

  /* (2) 참·거짓 라벨 대조 */
  const bad = rows.filter(({ q, v }) =>
    v.ambiguous || (typeof v.isFalse === 'boolean' && v.isFalse !== !!q.isWrong));
  if (!bad.length) return;

  const detail = bad.map(({ q, i, v }) =>
    `${i + 1}번(생성:${q.isWrong ? '거짓' : '참'} 검수:${v.ambiguous ? '모호' : (v.isFalse ? '거짓' : '참')})`
  ).join(', ');
  if (attempt < MAX_AI_ATTEMPTS) throw new Error(`라벨 검수 불일치 ${bad.length}건 — ${detail}`);

  /* 마지막 시도: 생성 실패를 띄우느니 검수 결과를 라벨로 채택한다. 판정만 하는 호출이 여러
     일을 겸하는 생성 호출보다 라벨에 관해서는 더 믿을 만하다. 모호한 문장은 손댈 근거가
     없으므로 생성 라벨을 그대로 둔다. */
  const flips = bad.filter(({ v }) => !v.ambiguous && typeof v.isFalse === 'boolean');

  /* 🔑 채택했을 때 세트가 문제로 성립하는지 먼저 본다. 판별형은 "거짓인 것을 골라내기"라
     거짓과 참이 **둘 다** 있어야 하고, 거짓은 설계 상한(MAX_WRONG) 안이어야 한다.
     검수가 5개를 전부 거짓이라 판정한 사례가 실제로 재현됐다 — 그대로 채택하면 학생은
     "다 체크하면 만점"인 세트를 받는다.
     성립하지 않으면 채택하지 않고 생성 라벨로 내보낸다. 그래도 학생이 손해 보지 않는데,
     채점 단계가 문항별로 라벨 대조를 다시 해서 갈린 문항은 감점도 가점도 하지 않기
     때문이다(단계 8-7). 즉 세트 단위로 못 고치면 문항 단위로 넘긴다. */
  const wrongAfter = questions.filter(q => {
    const f = flips.find(b => b.q === q);
    return f ? f.v.isFalse : q.isWrong;
  }).length;
  const adopt = wrongAfter > 0 && wrongAfter <= MAX_WRONG && wrongAfter < questions.length;
  if (adopt) {
    flips.forEach(({ q, v }) => {
      q.isWrong = v.isFalse;
      if (!v.isFalse) q.targetMisconceptionIds = [];   // 옳은 문장에는 오개념 태그가 붙을 수 없다
    });
  }
  console.warn(`[generateQuestions] 라벨 검수 불일치 — unit: ${unit}, level: ${level}, ${detail} (마지막 시도, 채택 ${adopt ? '함' : `안 함 — 채택 시 틀린 문장 ${wrongAfter}개`})`);
}

exports.generateQuestions = onCall(FUNC_OPTIONS, async (request) => {
  await authorize(request, 'generateQuestions');
  const { misconceptions, unit, level = 1, mode = null, targetMisconceptionIds = [] } = request.data;
  if (!misconceptions || !unit) {
    throw new HttpsError('invalid-argument', '오개념 또는 단원 정보가 없습니다');
  }

  try {
    const ctx = await loadUnitContext(unit, misconceptions, targetMisconceptionIds);
    const { activeMisconceptions, validIdSet, sampledPatterns, mcText,
            patternInstruction, priorityInstruction, wrongCount } = ctx;

    /* ── 계산형 (Level 3 다단계 복합 / Level 2 방식B 단답) ──
       두 레벨은 프롬프트 본문·thinking 예산·라벨만 다르고 나머지 처리가 같아 한 갈래로 합쳤다.
       thinking 예산이 차이의 핵심이다 — L3는 두 법칙 결합 계산의 논리 일관성이 중요해 넉넉히,
       L2B는 단일 공식이라 중간, 문장 5개(아래)는 개념 참·거짓이라 적게 준다. */
    const isL3 = level === 3;
    if (isL3 || (level === 2 && mode === 'B')) {
      const prompt = P.calcQuestion({
        isLevel3: isL3, unit, mcText, priorityInstruction, patternInstruction,
      });
      const model = getGeminiModel(0.8, isL3
        ? { thinkingBudget: 2048, outputTokens: 1536 }
        : { thinkingBudget: 1024, outputTokens: 1024 });
      // 🔑 validateCalcQuestion은 label === 'L3'일 때만 solutionSteps를 요구한다(다시 풀기 복원용)
      const label = isL3 ? 'L3' : 'L2 방식B';
      return await withRetry(`generateQuestions:${isL3 ? 'L3' : 'L2B'}`, async () => {
        const parsed = parseJSON((await model.generateContent(prompt)).response.text());
        validateCalcQuestion(parsed.calcQuestion, label);
        const targetMc = validIdSet.has(parsed.calcQuestion.targetMisconceptionId)
          ? parsed.calcQuestion.targetMisconceptionId : null;
        return {
          questions: null,
          calcQuestion: {
            ...parsed.calcQuestion,
            targetMisconceptionId: targetMc,
            ...(isL3 ? { isLevel3: true } : {}),
          },
          hint1: parsed.calcQuestion.hint1 || null,
          hint2: parsed.calcQuestion.hint2 || null,
          misconceptionCount: activeMisconceptions.length,
          patternCount: sampledPatterns.length,
        };
      });
    }

    /* ── 판별 문장 5개 (Level 1 / Level 2 Mode A) ── */
    const prompt = P.statementSet({
      ...ctx,
      unit,
      /* Level 1은 계산 문장 금지 + 공식 판별 문장 혼합(단계 8-6),
         Level 2 Mode A는 계산 판별 문장 2개 요구 — 본문은 prompts.js에 있다. */
      levelInstruction: level === 1 ? P.LEVEL1_INSTRUCTION
                      : level === 2 ? P.LEVEL2A_INSTRUCTION : '',
    });

    const model = getGeminiModel(0.8, { thinkingBudget: 512, outputTokens: 1536 });
    return await withRetry('generateQuestions', async (attempt) => {
      const parsed = parseJSON((await model.generateContent(prompt)).response.text());
      // 구버전 호환: 배열로 반환된 경우 힌트 없이 래핑
      const questions = Array.isArray(parsed) ? parsed : parsed.questions;

      validateStatementSet(parsed, questions, { wrongCount, unit, level, attempt });
      normalizeTags(questions, activeMisconceptions, validIdSet);
      await reviewStatementSet(questions, { unit, level, attempt });

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
    const prompt = P.recognizeSolution();
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


    const prompt = P.gradeSolutionProcess({
      questionText, correctAnswer, unit, stepsText, processText, answerText,
    });
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
/** 문항에 달린 오개념 태그 — 구버전의 단수 필드(targetMisconceptionId)도 읽는다. */
const tagsOf = (q) => (Array.isArray(q.targetMisconceptionIds)
  ? q.targetMisconceptionIds
  : (q.targetMisconceptionId ? [q.targetMisconceptionId] : [])).filter(Boolean);

/**
 * 채점 프롬프트에 실을 재료를 만듭니다 — 문제·답변 목록, 배점, 개념별 판정 블록.
 *
 * 배점은 100점을 틀린 문장 수로 나눈다. 부분 점수는 그 배점의 20~60%인데, 예전엔
 * '20~60점'/'10~30점'을 하드코딩했다 — 그 값이 바로 배점 100점/50점의 20~60%였다.
 * 틀린 문장이 3개인 세트(배점 33점)가 생겼으므로 공식으로 바꿨다(1·2개 결과는 동일).
 */
async function buildGradingContext(questions, answers) {
  const targetWrongCount = questions.filter(q => q.isWrong).length || 1;
  const maxScorePerItem = Math.round(100 / targetWrongCount);

  /* 개념별 판정 블록 (설계 4-12) — 한 문장에 오개념이 2개 태그될 수 있으므로, 학생의 서술
     하나를 읽고 오개념마다 따로 판정하게 한다. 판정에 필요한 건 오개념의 설명이라
     캐시된 마스터에서 꺼내 싣는다. 태그가 하나도 없으면 마스터를 읽지 않는다. */
  const descOf = {};
  if (questions.some(q => tagsOf(q).length)) {
    (await loadMisconceptions()).forEach(m => { if (m.id) descOf[m.id] = m.description; });
  }

  return {
    targetWrongCount,
    maxScorePerItem,
    partialScoreRange: `${Math.round(maxScorePerItem * 0.2)}~${Math.round(maxScorePerItem * 0.6)}점`,
    questionListText: questions.map(q => `[문장 ${q.id}] ${q.text}`).join('\n'),
    answerText: answers.map(a => `
[문장 ${a.questionId}]
- 학생의 답변: "${a.reason || a.answer || ''}" 
`).join('\n') || "제출한 서술형 답변이 없습니다.",
    conceptBlock: questions
      .filter(q => tagsOf(q).length)
      .map(q => `[문장 ${q.id}]\n` + tagsOf(q)
        .map(id => `  - ${id}: ${descOf[id] || '(설명 없음)'}`).join('\n'))
      .join('\n'),
  };
}

/**
 * AI 채점 결과를 화면·이해도용 문항 배열로 정리하고 총점을 계산합니다.
 *
 * 🔑 라벨 대조 — 문제를 만든 판정과 채점 판정이 갈리면 (1) 화면 라벨을 **채점** 쪽으로 맞추고
 *    (2) 가점·감점을 하지 않고 (3) 이해도 관측에서 뺀다. (1)이 핵심인데, 학생이 읽는 해설을
 *    쓰는 주체가 채점 호출이라 생성 라벨을 쓰면 "오답 체크" 칸에 "학생 답이 맞다"는 해설이
 *    붙는 자기모순 카드가 나온다. 실제 사례와 경위는 설계 문서 단계 8-7.
 *
 * @returns {{items, rawScore, mismatched, multiTagItems, splitJudgments}}
 */
function scoreFeedbackItems({ questions, answers, graded, maxScorePerItem }) {
  let rawScore = 0;
  const mismatched = [];        // 라벨이 갈린 문항 (로그·문항 오류율 집계용)
  const scoredUnanswered = [];  // 미답변인데 AI가 점수를 준 문항 (버려진 점수 — 로그용, S-10)
  /* 개념별 판정이 실제로 갈리는지 세는 카운터 (설계 4-12). AI가 서술이 좋으면 태그 전부에
     true를 주는 식으로 뭉갤 수 있고, 그러면 증거가 부풀어 다중 태그의 근거가 사라진다.
     갈린 비율이 0에 가까우면 그 전제가 깨졌다는 신호다. */
  let multiTagItems = 0, splitJudgments = 0;

  const items = questions.map(q => {
    const gradedItem = graded.items?.find(g => g.questionId === q.id);
    const answered   = answers.find(a => a.questionId === q.id);

    const rejudged = gradedItem?.statementIsWrong;
    const labelMismatch = typeof rejudged === 'boolean' && rejudged !== !!q.isWrong;
    if (labelMismatch) {
      mismatched.push({ id: q.id, 생성: q.isWrong ? '거짓' : '참', 채점: rejudged ? '거짓' : '참', text: q.text.slice(0, 40) });
    }
    const isWrong = labelMismatch ? rejudged : !!q.isWrong;

    /* isCorrectAnswer를 여기서 확정한다. 예전엔 AI 값을 그대로 쓰고 없으면 !isWrong으로
       채웠는데, 그러면 학생이 손도 대지 않은 문항에 AI의 임의 판단이 들어가 "안 푼 문제로
       이해도가 오르는" 일이 생겼다. 세 경우를 명시적으로 나눈다. */
    let isCorrectAnswer;
    if (!answered)     isCorrectAnswer = !isWrong;                          // 안 고름: 틀린 문장이면 못 찾은 것
    else if (!isWrong) isCorrectAnswer = false;                             // 옳은 문장을 고름 (헛다리)
    else               isCorrectAnswer = gradedItem?.isCorrectAnswer === true;

    if (labelMismatch) {
      // 판정이 갈린 문항 — 가점도 감점도 없다 (위 주석 / 단계 8-7)
    } else if (isWrong && answered) {
      /* 🔑 `answered` 조건이 핵심이다. 학생이 쓰지 않은 문항에는 한 점도 주지 않는다.
         프롬프트가 "미답변이면 0"을 지시하지만 그건 AI의 준수에 기댄 것이고, 어기면
         막을 것이 없었다. 바로 위에서 isCorrectAnswer는 미답변을 명시적으로 걸러내는데
         점수만 AI 값을 그대로 받아, 아무것도 안 쓴 학생이 100점 + "0개 정답"이라는
         모순된 결과를 받을 수 있었다. 근거는 결정 기록 S-10. */
      rawScore += (gradedItem?.score || 0);
    } else if (isWrong && gradedItem?.score > 0) {
      // 미답변인데 점수가 붙어 왔다 — 버리되, 얼마나 자주 있는지는 남긴다 (S-10)
      scoredUnanswered.push({ id: q.id, score: gradedItem.score });
    } else if (answered) {
      /* 옳은 문장을 오개념이라고 고른 경우(헛다리) 감점 — 무지성 체크 방지용.
         🔑 고정 -20이 아니라 배점의 절반. 예전엔 틀린 문장 1개(배점 100)와 2개(배점 50)에
            똑같이 -20이라, 같은 "다 찍기"인데 벌점 무게가 두 배 달랐다. */
      rawScore -= Math.round(maxScorePerItem * 0.5);
    }

    /* 개념별 판정 정리 (설계 4-12) — 태그된 오개념마다 한 건씩 만들고, 이것이 그대로 BKT
       관측이 된다. 라벨이 갈린 문항은 태그를 통째로 떼어 이해도에서 뺀다(화면에는 보인다).
       AI가 빼먹은 오개념은 문항 전체 판정으로 채우고, 답을 안 쓴 문항은 전부 false로 둔다
       — 서술이 없으면 "이해했다"는 증거가 있을 수 없다. */
    const tags = labelMismatch ? [] : tagsOf(q);
    const aiJudgments = Array.isArray(gradedItem?.conceptJudgments) ? gradedItem.conceptJudgments : [];
    const conceptJudgments = tags.map(id => {
      if (!answered) return { misconceptionId: id, understood: false };
      const row = aiJudgments.find(j => j?.misconceptionId === id);
      return {
        misconceptionId: id,
        understood: typeof row?.understood === 'boolean' ? row.understood : isCorrectAnswer,
      };
    });
    if (conceptJudgments.length > 1) {
      multiTagItems++;
      if (new Set(conceptJudgments.map(j => j.understood)).size > 1) splitJudgments++;
    }

    return {
      id:          q.id,
      text:        q.text,
      isWrong,
      isCorrectAnswer,
      userReason:  answered?.reason || answered?.answer,
      explanation: gradedItem?.explanation || '설명이 누락되었습니다.',
      // 문항이 겨냥한 오개념들 + 개념별 판정 — 저장 후 BKT 관측으로 쓰임
      targetMisconceptionIds: tags,
      conceptJudgments,
    };
  });

  return { items, rawScore, mismatched, scoredUnanswered, multiTagItems, splitJudgments };
}

exports.gradeAnswers = onCall(FUNC_OPTIONS, async (request) => {
  await authorize(request, 'gradeAnswers');
  const { answers, questions, unit } = request.data;
  if (!answers || !questions) {
    throw new HttpsError('invalid-argument', '답변 또는 문제 정보가 없습니다');
  }

  try {
    const ctx = await buildGradingContext(questions, answers);

    // 서술형 답변 5개를 루브릭에 따라 채점 + 해설 작성. 약간의 추론이 도움 → 소량 허용.
    // 해설 5개를 담아야 하므로 출력 상한은 넉넉히.
    const model = getGeminiModel(0, { thinkingBudget: 512, outputTokens: 2048 });
    const prompt = P.gradeAnswers({ unit, ...ctx });

    const graded = await withRetry('gradeAnswers', async () => {
      const parsed = parseJSON((await model.generateContent(prompt)).response.text());
      if (!Array.isArray(parsed.items) || !parsed.items.length) {
        throw new Error('items 배열 누락');
      }
      /* 학생이 실제로 답한 문항이 채점 결과에 빠져 있으면 그 문항이 0점 처리돼버린다 —
         누락은 재시도로 받아내는 게 맞다. */
      const gradedIds = new Set(parsed.items.map(it => it.questionId));
      const missing = answers.map(a => a.questionId).filter(id => !gradedIds.has(id));
      if (missing.length) throw new Error(`채점 누락 문항: ${missing.join(', ')}`);
      return parsed;
    });

    const { items, rawScore, mismatched, scoredUnanswered, multiTagItems, splitJudgments } =
      scoreFeedbackItems({ questions, answers, graded, maxScorePerItem: ctx.maxScorePerItem });

    /* 🔑 "N개 중 M개 정답"은 학생이 실제로 고른 문항만 센다. 예전엔 미체크 문항까지 세어
       화면의 "정답" 칸은 비었는데 부제만 1개 정답이라고 나오는 일이 있었다. */
    const answeredItems   = items.filter(i => i.userReason !== undefined && i.userReason !== null);
    const wrongAnswered   = answeredItems.filter(i => i.isWrong && !i.isCorrectAnswer);
    const correctAnswered = answeredItems.filter(i => i.isWrong && i.isCorrectAnswer);
    const gradableWrong   = items.filter(i => i.isWrong).length;

    const misconceptionTags = [
      ...wrongAnswered.map(i => ({ text: `${i.text.slice(0, 12)}... 오개념`, type: 'wrong' })),
      ...correctAnswered.map(i => ({ text: `${i.text.slice(0, 12)}... 이해`, type: 'correct' })),
    ].slice(0, 4);

    // 헛다리 감점 때문에 음수가 될 수 있어 0~100으로 자르고 5점 단위로 맞춘다
    const finalScore = Math.round(Math.max(0, Math.min(rawScore, 100)) / 5) * 5;

    /* 두 로그 모두 화면에는 띄우지 않고 논문 실측치로 쓴다.
       - 라벨 대조 불일치 건수 = 생성 단계 검증(8-5)을 통과하고도 남은 문항 오류율
       - 개념별 판정이 갈린 비율 = 다중 태그(4-12)가 실제로 작동하는지의 지표. 다중 태그
         문항인데 한 번도 갈리지 않으면 AI가 서술을 개념별로 읽지 않고 뭉개는 것이다. */
    if (mismatched.length) {
      console.warn(`[gradeAnswers] 라벨 대조 불일치 ${mismatched.length}건 (이해도 관측에서만 제외) — unit: ${unit}`, mismatched);
    }
    if (multiTagItems) {
      console.info(`[gradeAnswers] 개념별 판정 — 다중 태그 ${multiTagItems}문항 중 ${splitJudgments}건에서 판정이 갈림 (unit: ${unit}, level 정보 없음)`);
    }
    /* 미답변 문항에 AI가 점수를 준 건수 (S-10). 서버가 이미 버렸으므로 점수에는 영향이 없지만,
       프롬프트의 "미답변이면 0" 지시를 모델이 얼마나 어기는지가 이 로그로만 관측된다. */
    if (scoredUnanswered.length) {
      console.warn(`[gradeAnswers] 미답변 문항 가점 차단 ${scoredUnanswered.length}건 — unit: ${unit}`, scoredUnanswered);
    }

    return {
      score: finalScore,
      title: finalScore >= 80 ? '훌륭해요! 🎉' : finalScore >= 60 ? '잘 하셨어요! 👍' : '조금 더 공부해봐요 📚',
      subtitle: gradableWrong > 0
        ? `틀린 문장 ${gradableWrong}개 중 ${correctAnswered.length}개 정답`
        : '채점할 수 있는 문항이 없었어요',
      misconceptions: misconceptionTags,
      mismatchCount: mismatched.length,
      items,
    };
  } catch (err) {
    console.error('[gradeAnswers] Error:', err);
    throw new HttpsError('internal', `채점 실패: ${err.message}`);
  }
});