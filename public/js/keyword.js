/* ============================================================
   PhysiClinic — Keyword Extraction Screen Logic
   ============================================================ */

const KeywordScreen = {
  /* 화면 진입 & AI 분석 시작 */
  async start(imageBase64) {
    Router.go('keyword');
    this._showLoading();

    // 미리보기 이미지 표시
    const preview = document.getElementById('preview-img');
    if (preview && imageBase64) {
      preview.src = imageBase64;
      preview.style.display = 'block';
      document.getElementById('preview-placeholder')?.style.setProperty('display', 'none');
    }

    try {
      // Firebase Function 호출 → Gemini API (1차: 키워드 추출)
      const result = await ApiService.extractKeywords(imageBase64);
      AppState.session.extractedKeywords = result.keywords;
      AppState.session.misconceptions    = result.misconceptions;

      const prevUnit = AppState.session.detectedUnit;
      AppState.session.detectedUnit = result.unit;

      if (result.unit !== prevUnit) {
        // 소단원이 바뀐 경우에만 초기화 후 Firestore에서 실제 진행 상태 불러오기
        AppState.session.currentLevel = 1;
        AppState.session.correctCount = 0;
        // Level 2 모드 반복 방지 상태도 단원 전환 시 함께 초기화
        AppState._lastQuizMode = null;
        AppState._consecutiveModeCount = 0;
        localStorage.removeItem('pc_last_quiz_mode');
        localStorage.removeItem('pc_consecutive_mode_count');
      }

      // 로그인 상태라면 항상 Firestore의 실제 카운터/레벨로 동기화
      if (AppState.isLoggedIn && AppState.user) {
        try {
          const uid = AppState.user.uid;
          const [progress, count] = await Promise.all([
            LearningService.getUnitProgress(uid, result.unit),
            LearningService.getCorrectCount(uid, result.unit),
          ]);

          AppState.session.currentLevel = progress.level || 1;
          AppState.session.correctCount = count;
        } catch (e) {
          console.warn('진행 상태 동기화 실패, 기본값 유지:', e);
        }
      }

      this._showResult(result);
    } catch (err) {
      console.error('Keyword extraction failed:', err);
      Toast.show('사진을 다시 인식하지 못했어요. 다시 업로드해주세요.');
      Router.go('home');
    }
  },

  /* 로딩 UI 표시 */
  _showLoading() {
    document.getElementById('kw-loading').style.display = 'block';
    document.getElementById('kw-result').style.display  = 'none';
  },

  /* 결과 UI 표시 */
  _showResult(data) {
    document.getElementById('kw-loading').style.display = 'none';
    document.getElementById('kw-result').style.display  = 'block';

    // 단원명
    document.getElementById('kw-unit-name').textContent = data.unit;

    // 키워드 태그
    const tagsEl = document.getElementById('kw-tags');
    tagsEl.innerHTML = data.keywords.map((kw, i) =>
      `<span class="keyword-tag ${i < 4 ? 'active' : ''}">${kw}</span>`
    ).join('');
  },

  /* 문제 풀기 버튼 */
  async startQuiz() {
    const btn = document.getElementById('btn-start-quiz');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '문제 생성 중...';
    }

    try {
      const level = AppState.session.currentLevel;
      const mode = pickQuizMode(level);
      AppState.session.quizMode = mode;

      const result = await ApiService.generateQuestions(
        AppState.session.misconceptions,
        AppState.session.detectedUnit,
        level,
        mode
      );

      AppState.session.hint1 = result.hint1;
      AppState.session.hint2 = result.hint2;
      if (result.misconceptionCount) {
        AppState.session.misconceptionCount = result.misconceptionCount;
      }

      // Level 3: 복합 계산 문제 화면 / Level 2 Mode B: 계산 단답형 화면
      if (result.calcQuestion) {
        AppState.session.calcQuestion = result.calcQuestion;
        AppState.session.questions = null;
        if (result.calcQuestion.isLevel3) {
          Level3Screen.init(result.calcQuestion);
          Router.go('level3');
        } else {
          QuizScreen.initCalc(result.calcQuestion);
          Router.go('calc');
        }
      } else {
        AppState.session.calcQuestion = null;
        AppState.session.questions = result.questions;
        QuizScreen.init(result.questions);
        Router.go('step1');
      }
    } catch (err) {
      console.error('Question generation failed:', err);
      Toast.show('문제를 생성하는 데 실패했어요. 다시 시도해주세요.');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '문제 풀기 시작';
      }
    }
  },
};
