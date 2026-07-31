import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';
import { functions } from './config.js';
import { ensureSession } from './auth.js';

/* 🔑 모든 호출이 ensureSession()을 먼저 await 한다.
   Cloud Functions가 request.auth로 호출자를 확인하도록 바뀌었기 때문에(요금 남용 차단),
   토큰 없이 부르면 unauthenticated로 거절된다. 비로그인 사용자는 익명 세션을 쓰고,
   첫 화면 진입 직후 발급이 아직 안 끝난 시점에도 호출이 성립하도록 여기서 기다린다. */
const ApiService = {
  async extractKeywords(imageBase64) {
    await ensureSession();
    const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
    const fn = httpsCallable(functions, 'extractKeywords');
    const { data } = await fn({ imageBase64: base64Data });
    return data;
  },

  // targetMisconceptionIds: 순환 출제에서 우선 겨냥할 오개념 id (없으면 서버가 전체에서 자유 출제)
  async generateQuestions(misconceptions, unit, level = 1, mode = null, targetMisconceptionIds = []) {
    await ensureSession();
    const fn = httpsCallable(functions, 'generateQuestions');
    const { data } = await fn({ misconceptions, unit, level, mode, targetMisconceptionIds });
    return data;
  },

  async gradeAnswers(answers, questions, unit) {
    await ensureSession();
    const fn = httpsCallable(functions, 'gradeAnswers');
    const { data } = await fn({ answers, questions, unit });
    return data;
  },

  async recognizeSolutionImage(imageBase64) {
    await ensureSession();
    const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
    const fn = httpsCallable(functions, 'recognizeSolutionImage');
    const { data } = await fn({ imageBase64: base64Data });
    return data.text;
  },

  async gradeSolutionProcess(questionText, correctAnswer, unit, solutionSteps, processText, answerText = null) {
    await ensureSession();
    const fn = httpsCallable(functions, 'gradeSolutionProcess');
    const { data } = await fn({ questionText, correctAnswer, unit, solutionSteps, processText, answerText });
    return data; // { score, feedback, answerCorrect }
  },
};

// 🔑 글로벌로 노출 (public/js/*.js에서 ApiService로 접근 가능)
window.ApiService = ApiService;
export { ApiService };
