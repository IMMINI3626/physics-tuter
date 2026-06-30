/* ============================================================
   PhysiClinic — Keyword Extraction Screen Logic
   ============================================================ */

const KeywordScreen = {
  /* 화면 진입 & AI 분석 시작 */
  async start(imageBase64) {
    Router.go('keyword');
    this._showLoading();

    // 🆕 새 사진 = 새 소단원이므로 레벨/카운터 초기화
    AppState.session.currentLevel = 1;
    AppState.session.correctCount = 0;

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
      AppState.session.detectedUnit      = result.unit;
      AppState.session.misconceptions    = result.misconceptions;
      this._showResult(result);
    } catch (err) {
      console.error('Keyword extraction failed:', err);
      // 개발 중에는 더미 데이터로 폴백
      this._showResult(this._getDummyResult());
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
      // Firebase Function 호출 → Gemini API (2차: 문제 생성)
      const questions = await ApiService.generateQuestions(
        AppState.session.misconceptions,
        AppState.session.detectedUnit,
        AppState.session.currentLevel
      );
      AppState.session.questions = questions;
      QuizScreen.init(questions);
      Router.go('step1');
    } catch (err) {
      console.error('Question generation failed:', err);
      // 더미 문제로 폴백
      const dummy = this._getDummyQuestions();
      AppState.session.questions = dummy;
      QuizScreen.init(dummy);
      Router.go('step1');
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '문제 풀기 시작';
      }
    }
  },

  /* 개발용 더미 결과 */
  _getDummyResult() {
    return {
      unit: '뉴턴의 운동 법칙',
      keywords: ['뉴턴 법칙', '관성', '외력', '작용·반작용', '등속운동', '가속도', '질량'],
      misconceptions: [
        { id: 'M-001', description: '힘이 없으면 물체가 반드시 정지한다고 생각하는 경향 (뉴턴 제1법칙 관련)' },
        { id: 'M-007', description: '작용·반작용이 같은 물체에 작용한다고 오해하는 경향 (뉴턴 제3법칙 관련)' },
      ],
    };
  },

  /* 개발용 더미 문제 */
  _getDummyQuestions() {
    return [
      { id: 1, text: '물체에 힘이 작용하지 않으면 반드시 정지한다.',                         isWrong: true  },
      { id: 2, text: '작용·반작용은 같은 물체에 작용하는 힘의 쌍이다.',                       isWrong: true  },
      { id: 3, text: '알짜힘이 0이면 물체는 등속직선운동을 유지한다.',                        isWrong: false },
      { id: 4, text: '힘이 클수록 가속도가 크고, 질량이 클수록 가속도는 작다.',               isWrong: false },
      { id: 5, text: 'A가 B에 힘을 가하면 B도 A에 크기는 같고 방향은 반대인 힘을 가한다.',   isWrong: false },
    ];
  },
};
