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
  // 재시도(withRetry, 최대 3회)를 도입하면서 60초 → 180초로 상향.
  // gemini-2.5-flash는 thinking이 기본 활성이라 Level 3 문제 생성이 한 번에 20~30초씩
  // 걸리기도 해서, 60초로는 2회차 재시도 도중에 함수가 먼저 죽어버린다.
  timeoutSeconds: 180,
};

/* AI 호출 최대 시도 횟수 (최초 1회 + 재시도 2회) */
const MAX_AI_ATTEMPTS = 3;

/* ------------------------------------------------------------
   유틸리티 함수 모음
   ------------------------------------------------------------ */

/**
 * 설정된 API 키를 사용하여 Gemini 모델 인스턴스를 반환합니다.
 * @param {number} temperature - 기본 0(결정적). 문제 생성처럼 다양성이 필요한 곳은 높여서 호출.
 */
function getGeminiModel(temperature = 0) {
  const genAI = new GoogleGenerativeAI(GEMINI_API_KEY.value());
  return genAI.getGenerativeModel({
    model: 'gemini-2.5-flash', 

    generationConfig: {
      temperature, // 채점(extractKeywords, gradeAnswers)은 0 유지, 문제 생성은 다양성을 위해 올림
      responseMimeType: "application/json" // (보너스 팁) AI가 무조건 완벽한 JSON 형태로만 답변하도록 강제합니다.
    }
  });
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
 * 계산형 문제(Level 2 방식B, Level 3)의 필수 필드를 검증합니다.
 * 하나라도 어긋나면 throw → withRetry가 재생성을 시도합니다.
 *
 * 특히 unitOptions에 정답 단위가 실제로 들어있는지 확인하는 게 중요합니다.
 * 프론트(QuizScreen.initCalc)는 보기를 셔플한 뒤 `선택값 === calcQuestion.unit`으로
 * 채점하므로, 보기 안에 정답 단위가 없으면 학생이 무엇을 고르든 무조건 오답이 됩니다.
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
    throw new Error(`${label} unitOptions에 정답 단위(${q.unit})가 없음`);
  }
  // Level 3는 "다시 풀기"로 문제를 복원할 때 모범 풀이 단계까지 필요함
  if (label === 'L3' && (!Array.isArray(q.solutionSteps) || !q.solutionSteps.length)) {
    throw new Error('L3 solutionSteps 누락');
  }
}

/* ────────────────────────────────────────
   보조 오개념 마스터 (FCI가 커버하지 못하는 비역학 등)
──────────────────────────────────────── */
const SUPPLEMENTAL_MISCONCEPTIONS = [
  { id: 'M-W01', description: '파동이 전파될 때 매질이 함께 이동한다는 오개념' },
  { id: 'M-E01', description: '전류가 전구를 지나면서 소모된다는 오개념' },
  { id: 'M-T01', description: '온도와 열을 같은 개념으로 혼동하는 오개념' },
];

/* ────────────────────────────────────────
   Function 1: extractKeywords (하이브리드 DB 연동 버전)
──────────────────────────────────────── */
exports.extractKeywords = onCall(FUNC_OPTIONS, async (request) => {
  const { imageBase64 } = request.data;
  if (!imageBase64) throw new HttpsError('invalid-argument', '이미지 데이터가 없습니다');

  try {
    // 1. 메인 DB (FCI 역학 오개념) 불러오기
    const misRef = await db.collection('misconceptions').get();
    const dbMisconceptions = misRef.docs.map(doc => ({
      id: doc.data().id,
      description: doc.data().description
    }));

    const model = getGeminiModel();
    
    // 2. 하이브리드 프롬프트 + 소단원명 강제 지시
    const prompt = `
      다음 물리 교과서/필기 이미지를 분석하여 아래 JSON 형식으로 응답하세요.
      JSON 외 다른 텍스트는 절대 출력하지 마세요.

      [제1기준: FCI/FMCE 물리 오개념 (역학 중심)]
      ${JSON.stringify(dbMisconceptions)}

      [제2기준: 보조 물리 오개념 (비역학 중심)]
      ${JSON.stringify(SUPPLEMENTAL_MISCONCEPTIONS)}

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
      1. 역학 관련 이미지라면 반드시 [제1기준] 목록에서 가장 일치하는 id를 찾아 적으세요.
      2. 파동, 전자기학, 열역학 등 역학이 아니라면 [제2기준] 목록에서 가장 일치하는 id를 찾아 적으세요.
      3. [제1기준], [제2기준] 두 곳 모두에 도저히 일치하는 내용이 없다면 id에 "ETC"라고 작성하세요.
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
  const { misconceptions, unit, level = 1, mode = null } = request.data;
  if (!misconceptions || !unit) {
    throw new HttpsError('invalid-argument', '오개념 또는 단원 정보가 없습니다');
  }

  try {
    // 소단원 기반 오개념 전체 조회 (subUnit 필터링)
    const subUnitSnap = await db.collection('misconceptions')
      .where('subUnit', '==', unit)
      .get();
    const subUnitMisconceptions = subUnitSnap.docs.map(d => d.data());

    // 소단원 오개념이 있으면 그걸 사용, 없으면 Gemini가 골라준 misconceptions 사용
    const activeMisconceptions = subUnitMisconceptions.length > 0
      ? subUnitMisconceptions
      : misconceptions;

    // 해당 소단원 오개념 ID 목록으로 sentences 조회
    const validIds = activeMisconceptions.map(mc => mc.id).filter(Boolean);
    const dbQueries = validIds.map(id =>
      db.collection('misconception_sentences').where('misconceptionId', '==', id).get()
    );

    const querySnapshots = await Promise.all(dbQueries);
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

    const mcText = activeMisconceptions.map((mc, i) => `${i + 1}. ${mc.description}`).join('\n');

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

    const model = getGeminiModel(0.8);

    // ── Level 3: 다단계 복합 계산 문제 ──
    if (level === 3) {
      const prompt = `
당신은 고등학교 물리 교사입니다.
단원: "${unit}"
학생들의 주요 오개념:
${mcText}
${patternInstruction}
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
    "hint1": "어떤 물리 법칙을 순서대로 적용해야 하는지 방향만 제시. 정답 언급 금지. 1~2문장 경어체.",
    "hint2": "각 단계에서 어떤 변수를 구해야 하는지 유도. 최종 값 언급 금지. 1~2문장 경어체."
  }
}
`;
      return await withRetry('generateQuestions:L3', async () => {
        const result = await model.generateContent(prompt);
        const parsed = parseJSON(result.response.text());
        validateCalcQuestion(parsed.calcQuestion, 'L3');
        return {
          questions: null,
          calcQuestion: { ...parsed.calcQuestion, isLevel3: true },
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
${patternInstruction}
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
    "hint1": "이 문제를 풀 때 어떤 물리 법칙/공식을 사용해야 하는지 방향만 제시. 정답 언급 금지. 1~2문장 경어체.",
    "hint2": "공식에서 각 변수에 어떤 값을 대입해야 하는지 구체적으로 유도. 최종 값 언급 금지. 1~2문장 경어체."
  }
}
`;
      return await withRetry('generateQuestions:L2B', async () => {
        const result = await model.generateContent(prompt);
        const parsed = parseJSON(result.response.text());
        validateCalcQuestion(parsed.calcQuestion, 'L2 방식B');
        return {
          questions: null,
          calcQuestion: parsed.calcQuestion,
          hint1: parsed.calcQuestion.hint1 || null,
          hint2: parsed.calcQuestion.hint2 || null,
          misconceptionCount: activeMisconceptions.length,
          patternCount: sampledPatterns.length,
        };
      });
    }

    // 🆕 Level 1: 정성적 문장 + 공식 판별 문장 혼합 출제 지시
    const level1FormulaInstruction = `
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
계산을 직접 수행해야 하는 문제는 절대 포함하지 마세요. (Level 1은 계산 없이 옳고 그름만 판별하는 단계입니다)
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
- 오개념이 담긴 틀린 문장: ${wrongCount}개 (isWrong: true)
- 올바른 물리 개념 문장: ${rightCount}개 (isWrong: false)
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
    { "id": 1, "text": "문장 내용", "isWrong": true  },
    { "id": 2, "text": "문장 내용", "isWrong": false }
  ],
  "hint1": "5개 문장 전체를 대상으로, 어떤 물리 개념/법칙을 중심으로 판단해야 하는지 방향만 제시. 어느 문장이 틀렸는지 절대 언급 금지. 1~2문장 경어체.",
  "hint2": "hint1보다 구체적으로, 틀린 문장에 사용된 표현이나 조건의 어떤 부분을 의심해봐야 하는지 유도. 어느 문장인지 직접 지목 금지. 1~2문장 경어체."
}

[힌트 작성 규칙]
- 힌트는 문제 세트 전체에 대한 것 (특정 문장 번호 언급 금지)
- hint1: 이 단원/오개념과 관련된 핵심 물리 법칙 방향만 제시
- hint2: 틀린 문장에 쓰인 표현 패턴이나 조건을 간접적으로 유도
- 정답(어느 문장이 틀렸는지) 절대 직접 언급 금지
- 모든 힌트는 "~해보세요", "~생각해보세요" 경어체
`;

    return await withRetry('generateQuestions', async () => {
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
      if (!questions.some(q => q.isWrong)) {
        throw new Error('틀린 문장이 하나도 없음');   // 채점 자체가 성립 안 함
      }

      return {
        questions,
        hint1: parsed.hint1 || null,
        hint2: parsed.hint2 || null,
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
  const { imageBase64 } = request.data;
  if (!imageBase64) throw new HttpsError('invalid-argument', '이미지 데이터가 없습니다');

  try {
    const model = getGeminiModel();
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
  const { questionText, correctAnswer, unit, solutionSteps, processText, answerText } = request.data;
  if (!questionText || (!processText && !answerText)) {
    throw new HttpsError('invalid-argument', '문제 또는 풀이/답안 정보가 없습니다');
  }

  try {
    const model = getGeminiModel();
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

    const model = getGeminiModel();
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
4. 보충 설명 분리: 학생이 핵심을 맞췄다면 정답 처리하고, 부족한 부가 설명은 explanation 텍스트에만 부드럽게 덧붙이세요.
5. 명확한 배점 기준 (학생이 찾아야 할 오개념 문장은 총 ${targetWrongCount}개이며, 문항당 최대 배점은 ${maxScorePerItem}점입니다):
   - 만점 (${maxScorePerItem}점): 핵심을 올바르게 지적한 답변 (\`isCorrectAnswer: true\`)
   - 부분 점수 (${partialScoreRange}): 오개념 문장으로 골랐으나, 작성한 이유가 틀린 경우 (\`isCorrectAnswer: false\`)
   - 0점: 답변을 아예 작성하지 않은 경우

JSON만 출력하세요 (다른 텍스트 금지):
{
  "items": [
    {
      "questionId": 번호(정수),
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

    const feedbackItems = questions.map(q => {
      const gradedItem = graded.items?.find(g => g.questionId === q.id);
      const answered   = answers.find(a => a.questionId === q.id);

      // 1. 점수 계산 로직 변경: 맞춘 건 더하고, 엄한 걸 잡으면 감점!
      if (q.isWrong) {
        // 진짜 오개념을 찾은 경우: AI가 채점한 점수 합산
        rawTotalScore += (gradedItem?.score || 0);
      } else if (!q.isWrong && answered) {
        // 맞는 문장인데 오개념이라고 억울하게 고른 경우: 무지성 체크 방지용 감점
        rawTotalScore -= 20; // 문항당 20점 감점
      }

      return {
        id:              q.id,
        text:            q.text,
        isWrong:         q.isWrong,
        isCorrectAnswer: gradedItem?.isCorrectAnswer ?? !q.isWrong,
        userReason:      answered?.reason || answered?.answer,
        explanation:     gradedItem?.explanation || '설명이 누락되었습니다.',
      };
    });

    const wrongAnswered = feedbackItems.filter(i => i.isWrong && !i.isCorrectAnswer);
    const correctAnswered = feedbackItems.filter(i => i.isWrong && i.isCorrectAnswer);

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

    return {
      score: finalScore,
      title: finalScore >= 80 ? '훌륭해요! 🎉' : finalScore >= 60 ? '잘 하셨어요! 👍' : '조금 더 공부해봐요 📚',
      subtitle: `${targetWrongCount}개 오개념 중 ${correctAnswered.length}개 이해`,
      misconceptions: misconceptionTags,
      items: feedbackItems,
    };
  } catch (err) {
    console.error('[gradeAnswers] Error:', err);
    throw new HttpsError('internal', `채점 실패: ${err.message}`);
  }
});