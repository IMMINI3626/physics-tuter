/* ============================================================
   PhysiClinic — Keyword Extraction Screen Logic
   ============================================================ */

const KeywordScreen = {
  /* 화면 진입 & AI 분석 시작 */
  async start(imageBase64) {
    Router.go('keyword');
    this._showLoading();
    // 새 사진으로 시작하는 정상 흐름 — 문제 화면 뒤로가기를 기본값("분석 결과")으로 되돌리고
    // 이전에 남아있었을 수 있는 재시도 표시도 초기화
    setQuizBackTarget(null);
    AppState.session.isRetry = false;
    AppState.session.isHistoryRetry = false;
    AppState.session._rootSessionId = null;

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

      // 🔑 게스트 무료 횟수는 "분석에 성공한 시점"에 차감한다.
      //    예전엔 home.js의 업로드 시점에 올렸는데, 그러면 AI 인식이 실패했을 때
      //    사용자는 아무것도 못 해보고 기회만 하나 잃었다. (표를 넣었는데 기계가 고장난 격)
      if (!AppState.isLoggedIn) {
        GuestGuard.increment();
      }

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
      `<span class="keyword-tag ${i < 4 ? 'active' : ''}">${escapeHtml(kw)}</span>`
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

      // 결과에 맞춰(문장형/계산형/Level3) 알맞은 문제 화면으로 이동
      applyQuizResult(result);
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
