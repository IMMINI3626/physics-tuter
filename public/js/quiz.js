/* ============================================================
   PhysiClinic — Quiz Screen Logic (STEP 1 & STEP 2)
   ============================================================ */

const QuizScreen = {
  /* STEP 1 초기화 */
  init(questions) {
    AppState.session.checkedStatements = new Set();
    AppState.session.hintUsed = 0;

    this._renderStatements(questions);
    this._resetHints();
    this._updateProgress(1);
    // 🔑 게스트 카운트 증가는 home.js의 업로드 시점에서 이미 처리됨 (중복 방지)
  },

  /* 문장 목록 렌더링 */
  _renderStatements(questions) {
    const container = document.getElementById('statements-list');
    if (!container) return;

    const nums = ['①', '②', '③', '④', '⑤'];
    container.innerHTML = questions.map((q, i) => `
      <div class="statement-item" id="stmt-${q.id}" data-id="${q.id}">
        <div class="statement-header" onclick="QuizScreen.toggleStatement(${q.id})">
          <span class="stmt-num">${nums[i]}</span>
          <span class="stmt-text">${q.text}</span>
          <div class="stmt-checkbox" id="cb-${q.id}">
            <svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>
          </div>
        </div>
        <div class="stmt-expand" id="expand-${q.id}">
          <p class="stmt-expand-note">▸ STEP 2에서 틀린 이유를 서술해요</p>
        </div>
      </div>
    `).join('');
  },

  /* 체크박스 토글 */
  toggleStatement(id) {
    const checked = AppState.session.checkedStatements;
    const item  = document.getElementById(`stmt-${id}`);
    const cb    = document.getElementById(`cb-${id}`);
    const exp   = document.getElementById(`expand-${id}`);

    if (checked.has(id)) {
      checked.delete(id);
      item.classList.remove('checked');
      cb.classList.remove('checked');
      exp.classList.remove('open');
    } else {
      checked.add(id);
      item.classList.add('checked');
      cb.classList.add('checked');
      exp.classList.add('open');
    }
  },

  /* 힌트 사용 */
  useHint(level) {
    const used = AppState.session.hintUsed;
    const questions = AppState.session.questions;
    const wrongIds = questions.filter(q => q.isWrong).map(q => q.id);

    if (level === 1 && used === 0) {
      AppState.session.hintUsed = 1;
      document.getElementById('hint-btn-1').disabled = true;
      document.getElementById('hint-btn-2').disabled = false;

      const resultEl = document.getElementById('hint-result');
      resultEl.querySelector('#hint-result-text').textContent =
        `힌트 1: 틀린 문장은 총 ${wrongIds.length}개예요`;
      resultEl.classList.add('visible');
      Toast.show('힌트 1 사용 완료');
    } else if (level === 2 && used === 1) {
      AppState.session.hintUsed = 2;
      document.getElementById('hint-btn-2').disabled = true;

      // 틀린 문장 하이라이트
      wrongIds.forEach(id => {
        document.getElementById(`stmt-${id}`)?.classList.add('hint-highlight');
      });

      const resultEl = document.getElementById('hint-result');
      resultEl.querySelector('#hint-result-text').textContent =
        '힌트 2: 노란 테두리 문장을 다시 살펴보세요';
      Toast.show('힌트 2 사용 완료 (이후 비활성)');
    }
  },

  /* 힌트 초기화 */
  _resetHints() {
    document.getElementById('hint-btn-1').disabled = false;
    document.getElementById('hint-btn-2').disabled = true;
    document.getElementById('hint-result')?.classList.remove('visible');
  },

  /* STEP 1 → STEP 2 이동 */
  goToStep2() {
    const checked = AppState.session.checkedStatements;
    if (checked.size === 0) {
      Toast.show('틀린 문장을 최소 1개 선택해주세요');
      return;
    }

    this._renderStep2();
    this._updateProgress(2);
    Router.go('step2');
  },

  /* STEP 2 렌더링 (통합 텍스트 박스) */
  _renderStep2() {
    const container = document.getElementById('step2-list');
    if (!container) return;

    const checked   = AppState.session.checkedStatements;
    const questions = AppState.session.questions;
    const nums = ['①', '②', '③', '④', '⑤'];

    const checkedQuestions = questions.filter(q => checked.has(q.id));

    container.innerHTML = checkedQuestions.map((q) => {
      const idx = questions.findIndex(x => x.id === q.id);
      return `
        <div class="step2-item" data-id="${q.id}">
          <div class="step2-stmt-row">
            <span class="step2-stmt-num">${nums[idx]}</span>
            <span class="step2-stmt-text">${q.text}</span>
          </div>
          <div class="step2-fields">
            <div>
              <div class="field-label">답변 작성</div>
              <textarea
                class="field-textarea"
                id="reason-${q.id}"
                rows="3"
                placeholder="해당 문장이 틀린 이유나 올바른 물리 개념을 자유롭게 적어보세요..."
              ></textarea>
            </div>
          </div>
        </div>
      `;
    }).join('');
  },

  /* STEP 2 제출 → 채점 (데이터 수집 통합) */
  async submitStep2() {
    const checked = AppState.session.checkedStatements;
    const questions = AppState.session.questions;
    const checkedQuestions = questions.filter(q => checked.has(q.id));

    // 🔑 답변 수집: 통합된 reason 값만 수집합니다.
    const answers = checkedQuestions.map(q => ({
      questionId: q.id,
      questionText: q.text,
      reason: document.getElementById(`reason-${q.id}`)?.value.trim() || '',
    }));

    // 입력 여부 체크
    const hasInput = answers.some(a => a.reason);
    if (!hasInput) {
      Toast.show('최소 하나의 답변을 입력해주세요');
      return;
    }

    AppState.session.step2Answers = answers;

    const btn = document.getElementById('btn-submit');
    if (btn) { btn.disabled = true; btn.textContent = '채점 중...'; }

    try {
      // Firebase Function 호출 → Gemini API (3차: 채점)
      const result = await ApiService.gradeAnswers(
        answers,
        questions,
        AppState.session.detectedUnit
      );
      AppState.session.score = result.score;
      AppState.session.feedbackData = result;
      await FeedbackScreen.render(result);
      Router.go('feedback');
    } catch (err) {
      console.error('Grading failed:', err);
      // 더미 피드백으로 폴백
      const dummy = this._getDummyFeedback();
      AppState.session.score = dummy.score;
      AppState.session.feedbackData = dummy;
      FeedbackScreen.render(dummy);
      Router.go('feedback');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '제출하고 채점받기'; }
    }
  },

  /* 프로그레스 바 업데이트 */
  _updateProgress(step) {
    const fill = document.querySelector('.progress-fill');
    const stepEl = document.querySelector('.progress-info-step');
    if (fill) fill.style.width = step === 1 ? '50%' : '100%';
    if (stepEl) stepEl.textContent = step === 1 ? '틀린 문장 찾기' : '개념 서술하기';
  },

  /* 개발용 더미 피드백 */
  _getDummyFeedback() {
    return {
      score: 70,
      title: '잘 하셨어요! 🎉',
      subtitle: '2개 오개념 중 1개 완벽 이해',
      misconceptions: [
        { text: '관성의 법칙 오개념', type: 'wrong' },
        { text: '작용·반작용 이해', type: 'correct' },
      ],
      items: [
        {
          id: 1,
          text: '물체에 힘이 작용하지 않으면 반드시 정지한다.',
          isWrong: true,
          isCorrectAnswer: false,
          userReason: '힘이 없으면 멈춘다고 생각했어요',
          explanation: '학생의 답변처럼 생각할 수 있지만, 뉴턴 제1법칙(관성의 법칙)에 따르면 외력이 작용하지 않을 때 운동하던 물체는 계속 등속직선운동을 유지합니다.',
        },
        {
          id: 2,
          text: '작용·반작용은 같은 물체에 작용하는 힘의 쌍이다.',
          isWrong: true,
          isCorrectAnswer: true,
          userReason: '서로 다른 물체에 작용한다고 했어요',
          explanation: '학생의 답변이 정확합니다! 작용·반작용은 항상 서로 다른 두 물체 사이에서 상호작용하는 힘이므로 하나의 물체에 합력을 구할 수 없습니다.',
        },
        { id: 3, text: '알짜힘이 0이면 물체는 등속직선운동을 유지한다.', isWrong: false },
        { id: 4, text: '힘이 클수록 가속도가 크고, 질량이 클수록 가속도는 작다.', isWrong: false },
        { id: 5, text: 'A가 B에 힘을 가하면 B도 A에 크기는 같고 방향은 반대인 힘을 가한다.', isWrong: false },
      ],
    };
  },
};