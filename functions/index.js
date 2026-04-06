/* ============================================================
   PhysiClinic — Firebase Cloud Functions
   Node.js 18 / Firebase Functions v2
   
   Gemini API를 서버에서 안전하게 호출 (API 키 노출 방지)
   
   배포: firebase deploy --only functions
   ============================================================ */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { defineSecret }       = require('firebase-functions/params');
const { GoogleGenerativeAI } = require('@google/generative-ai');

/* Gemini API 키를 Firebase Secret으로 관리 */
const GEMINI_API_KEY = defineSecret('GEMINI_API_KEY');

/* 함수 공통 옵션 */
const FUNC_OPTIONS = {
  region: 'asia-northeast3',  // 서울 리전
  secrets: [GEMINI_API_KEY],
  timeoutSeconds: 60,
};

/* ────────────────────────────────────────
   유틸: Gemini 클라이언트 초기화
──────────────────────────────────────── */
function getGemini() {
  return new GoogleGenerativeAI(GEMINI_API_KEY.value());
}

/* ────────────────────────────────────────
   유틸: JSON 응답 파싱 (마크다운 펜스 제거)
──────────────────────────────────────── */
function parseJSON(text) {
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    throw new Error(`JSON 파싱 실패: ${cleaned.slice(0, 200)}`);
  }
}

/* ────────────────────────────────────────
   오개념 키워드 매핑 테이블
   (Firestore에서 로드하거나 인라인으로 관리)
──────────────────────────────────────── */
const MISCONCEPTION_TABLE = {
  '뉴턴 법칙': [
    { id: 'M-001', description: '힘이 없으면 물체가 반드시 정지한다는 오개념 (뉴턴 제1법칙)' },
    { id: 'M-002', description: '무거운 물체가 가벼운 물체보다 빨리 떨어진다는 오개념' },
  ],
  '관성': [
    { id: 'M-003', description: '관성은 무게에 비례한다는 오개념' },
  ],
  '작용·반작용': [
    { id: 'M-007', description: '작용·반작용이 같은 물체에 작용한다는 오개념 (뉴턴 제3법칙)' },
  ],
  '등속운동': [
    { id: 'M-004', description: '등속운동을 유지하려면 힘이 필요하다는 오개념' },
  ],
  '파동': [
    { id: 'M-010', description: '파동이 전파될 때 매질이 함께 이동한다는 오개념' },
  ],
};

/* ────────────────────────────────────────
   Function 1: extractKeywords
   이미지 → 물리 키워드 + 단원 + 오개념 추출
──────────────────────────────────────── */
exports.extractKeywords = onCall(FUNC_OPTIONS, async (request) => {
  const { imageBase64 } = request.data;
  if (!imageBase64) throw new HttpsError('invalid-argument', '이미지 데이터가 없습니다');

  const genAI = getGemini();
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const prompt = `
다음 물리 교과서/필기 이미지를 분석하여 아래 JSON 형식으로 응답하세요.
JSON 외 다른 텍스트는 절대 출력하지 마세요.

{
  "unit": "단원명 (예: 뉴턴의 운동 법칙, 파동과 에너지 등)",
  "keywords": ["키워드1", "키워드2", ...],  // 주요 물리 개념 키워드 5~10개
  "misconceptions": [
    {
      "id": "오개념ID (예: M-001)",
      "description": "이 이미지 내용과 관련된 흔한 오개념 설명"
    }
  ]
}

단원 분류 기준:
- 역학: 뉴턴 법칙, 운동, 힘, 에너지, 운동량
- 전자기학: 전기, 자기, 전류, 전압
- 파동: 파동, 소리, 빛, 진동
- 열역학: 열, 온도, 엔트로피
- 현대물리: 양자, 원자, 핵

오개념은 2~3개, 해당 단원의 학생들이 자주 틀리는 개념으로 선정하세요.
`;

  try {
    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          mimeType: 'image/jpeg',
          data: imageBase64,
        },
      },
    ]);

    const text = result.response.text();
    const parsed = parseJSON(text);

    // 키워드로 오개념 보강 (테이블 매핑)
    if (!parsed.misconceptions || parsed.misconceptions.length === 0) {
      for (const kw of (parsed.keywords || [])) {
        const mapped = MISCONCEPTION_TABLE[kw];
        if (mapped) {
          parsed.misconceptions = mapped.slice(0, 2);
          break;
        }
      }
    }

    return parsed;
  } catch (err) {
    console.error('extractKeywords error:', err);
    throw new HttpsError('internal', `키워드 추출 실패: ${err.message}`);
  }
});

/* ────────────────────────────────────────
   Function 2: generateQuestions
   오개념 → 혼합형 5문장 생성
──────────────────────────────────────── */
exports.generateQuestions = onCall(FUNC_OPTIONS, async (request) => {
  const { misconceptions, unit } = request.data;
  if (!misconceptions || !unit) {
    throw new HttpsError('invalid-argument', '오개념 또는 단원 정보가 없습니다');
  }

  const genAI = getGemini();
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  const mcText = misconceptions
    .map((mc, i) => `${i + 1}. ${mc.description}`)
    .join('\n');

  const prompt = `
당신은 고등학교 물리 교사입니다.
단원: "${unit}"
학생들의 주요 오개념:
${mcText}

위 오개념을 진단하기 위한 문장 5개를 만드세요.
- 오개념이 담긴 틀린 문장: 2개 (isWrong: true)
- 올바른 물리 개념 문장: 3개 (isWrong: false)
- 문장들을 무작위 순서로 섞어주세요
- 자연스러운 한국어로, 고등학생이 이해할 수 있는 수준

JSON만 출력하세요 (다른 텍스트 금지):
[
  { "id": 1, "text": "문장 내용", "isWrong": true  },
  { "id": 2, "text": "문장 내용", "isWrong": false },
  ...
]
`;

  try {
    const result = await model.generateContent(prompt);
    const text   = result.response.text();
    const parsed = parseJSON(text);

    // 유효성 검사: 5개, isWrong 2개
    if (!Array.isArray(parsed) || parsed.length !== 5) {
      throw new Error('문장 수가 올바르지 않습니다');
    }

    return parsed;
  } catch (err) {
    console.error('generateQuestions error:', err);
    throw new HttpsError('internal', `문제 생성 실패: ${err.message}`);
  }
});

/* ────────────────────────────────────────
   Function 3: gradeAnswers
   서술형 답변 자동 채점
──────────────────────────────────────── */
exports.gradeAnswers = onCall(FUNC_OPTIONS, async (request) => {
  const { answers, questions, unit } = request.data;
  if (!answers || !questions) {
    throw new HttpsError('invalid-argument', '답변 또는 문제 정보가 없습니다');
  }

  const genAI = getGemini();
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

  // 채점 대상만 추출 (사용자가 체크한 문장)
  const answerText = answers.map((a, i) => `
[문장 ${i + 1}] "${a.questionText}"
- 학생의 틀린 이유: "${a.reason}"
- 학생이 쓴 올바른 법칙: "${a.correctLaw}"
`).join('\n');

  const prompt = `
당신은 고등학교 물리 교사입니다.
단원: "${unit}"

학생이 다음 틀린 문장들에 대해 설명을 작성했습니다.
각 답변을 채점하고 피드백을 주세요.

${answerText}

JSON만 출력하세요 (다른 텍스트 금지):
{
  "totalScore": 0~100 사이 점수 (정수),
  "items": [
    {
      "questionId": 번호(정수),
      "isCorrectAnswer": true/false,  // 학생 답변이 핵심 개념을 포함하면 true
      "score": 0~50 사이 이 문항 점수,
      "explanation": "올바른 물리 해설 (2~3문장)"
    }
  ]
}

채점 기준:
- 핵심 물리 키워드 포함 여부 (뉴턴 제1법칙, 관성, 등속직선운동 등)
- 개념의 방향성이 맞는지 (완전하지 않아도 방향이 맞으면 부분 점수)
- 아예 관련 없는 답변이면 0점
`;

  try {
    const result = await model.generateContent(prompt);
    const text   = result.response.text();
    const graded = parseJSON(text);

    // 전체 피드백 구성
    const feedbackItems = questions.map(q => {
      const gradedItem = graded.items?.find(g => g.questionId === q.id);
      const answered   = answers.find(a => a.questionId === q.id);

      return {
        id:              q.id,
        text:            q.text,
        isWrong:         q.isWrong,
        isCorrectAnswer: gradedItem?.isCorrectAnswer ?? !q.isWrong,
        userReason:      answered?.reason,
        explanation:     gradedItem?.explanation || (q.isWrong ? '해당 문장은 틀린 개념입니다.' : '올바른 물리 개념입니다.'),
      };
    });

    // 오개념 태그 생성
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

    const score = graded.totalScore ?? 0;

    return {
      score,
      title:    score >= 80 ? '훌륭해요! 🎉' : score >= 60 ? '잘 하셨어요! 👍' : '조금 더 공부해봐요 📚',
      subtitle: `${wrongAnswered.length + correctAnswered.length}개 오개념 중 ${correctAnswered.length}개 이해`,
      misconceptions: misconceptionTags,
      items: feedbackItems,
    };
  } catch (err) {
    console.error('gradeAnswers error:', err);
    throw new HttpsError('internal', `채점 실패: ${err.message}`);
  }
});
