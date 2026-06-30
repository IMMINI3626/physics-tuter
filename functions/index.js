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
  timeoutSeconds: 60,
};

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

    const result = await model.generateContent([
      prompt,
      {
        inlineData: {
          mimeType: 'image/jpeg',
          data: imageBase64,
        },
      },
    ]);

    return parseJSON(result.response.text());
  } catch (err) {
    console.error('[extractKeywords] Error:', err);
    throw new HttpsError('internal', `키워드 추출 실패: ${err.message}`);
  }
});

/* ────────────────────────────────────────
   Function 2: generateQuestions (DB 참고 문장 활용 + 레벨 분기)
──────────────────────────────────────── */
exports.generateQuestions = onCall(FUNC_OPTIONS, async (request) => {
  const { misconceptions, unit, level = 1 } = request.data;
  if (!misconceptions || !unit) {
    throw new HttpsError('invalid-argument', '오개념 또는 단원 정보가 없습니다');
  }

  try {
    // 🔑 속도 최적화: for문 대신 Promise.all을 사용하여 병렬로 DB 조회
    const validMisconceptions = misconceptions.filter(mc => mc.id);
    const dbQueries = validMisconceptions.map(mc => 
      db.collection('misconception_sentences').where('misconceptionId', '==', mc.id).get()
    );
    
    const querySnapshots = await Promise.all(dbQueries);
    const contextSentences = querySnapshots.flatMap(snap => snap.docs.map(doc => doc.data()));

    // 틀린 문장과 옳은 문장을 분류
    const wrongExamples = contextSentences.filter(s => s.isWrong).map(s => s.sentence).join(' / ');
    const correctExamples = contextSentences.filter(s => !s.isWrong).map(s => s.sentence).join(' / ');

    const mcText = misconceptions.map((mc, i) => `${i + 1}. ${mc.description}`).join('\n');

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

    const model = getGeminiModel(0.8); // 🆕 문제 생성은 다양성을 위해 temperature 상향 (0 → 0.8)

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

    const levelInstruction = level === 1 ? level1FormulaInstruction : '';

    const prompt = `
당신은 고등학교 물리 교사입니다.
단원: "${unit}"
학생들의 주요 오개념:
${mcText}

[학술적 참고 자료 (FCI/FMCE 기반)]
- 학생들이 흔히 하는 틀린 생각 예시: ${wrongExamples || '관련 자료 없음'}
- 올바른 물리 개념 예시: ${correctExamples || '관련 자료 없음'}

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

[필수 규칙 - 어투]
- 생성되는 모든 문장(text)은 반드시 "~습니다", "~합니다", "~입니다" 형태의 정중한 경어체를 사용하세요. (반말 금지)

JSON만 출력하세요 (다른 텍스트 금지):
[
  { "id": 1, "text": "문장 내용", "isWrong": true  },
  { "id": 2, "text": "문장 내용", "isWrong": false }
]
`;

    const result = await model.generateContent(prompt);
    const parsed = parseJSON(result.response.text());

    if (!Array.isArray(parsed) || parsed.length !== 5) {
      throw new Error('문장 수가 올바르지 않거나 배열 형태가 아닙니다.');
    }

    return parsed;
  } catch (err) {
    console.error('[generateQuestions] Error:', err);
    throw new HttpsError('internal', `문제 생성 실패: ${err.message}`);
  }
});

/* ────────────────────────────────────────
   Function 3: gradeAnswers 
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

    const result = await model.generateContent(prompt);
    const graded = parseJSON(result.response.text());

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