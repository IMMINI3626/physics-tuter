import { httpsCallable } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-functions.js';
import { functions } from './config.js';

const ApiService = {
  async extractKeywords(imageBase64) {
    const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
    const fn = httpsCallable(functions, 'extractKeywords');
    const { data } = await fn({ imageBase64: base64Data });
    return data;
  },

  // targetMisconceptionIds: 순환 출제에서 우선 겨냥할 오개념 id (없으면 서버가 전체에서 자유 출제)
  async generateQuestions(misconceptions, unit, level = 1, mode = null, targetMisconceptionIds = []) {
    const fn = httpsCallable(functions, 'generateQuestions');
    const { data } = await fn({ misconceptions, unit, level, mode, targetMisconceptionIds });
    return data;
  },

  async gradeAnswers(answers, questions, unit) {
    const fn = httpsCallable(functions, 'gradeAnswers');
    const { data } = await fn({ answers, questions, unit });
    return data;
  },

  async recognizeSolutionImage(imageBase64) {
    const base64Data = imageBase64.includes(',') ? imageBase64.split(',')[1] : imageBase64;
    const fn = httpsCallable(functions, 'recognizeSolutionImage');
    const { data } = await fn({ imageBase64: base64Data });
    return data.text;
  },

  async gradeSolutionProcess(questionText, correctAnswer, unit, solutionSteps, processText, answerText = null) {
    const fn = httpsCallable(functions, 'gradeSolutionProcess');
    const { data } = await fn({ questionText, correctAnswer, unit, solutionSteps, processText, answerText });
    return data; // { score, feedback, answerCorrect }
  },
};

// 🔑 글로벌로 노출 (public/js/*.js에서 ApiService로 접근 가능)
window.ApiService = ApiService;
export { ApiService };
