/* ============================================================
   PhysiClinic — Quiz Screen Logic (STEP 1 & STEP 2)
   ============================================================ */

const QuizScreen = {
  /* STEP 1 초기화 */
  init(questions) {
    AppState.session.checkedStatements = new Set();
    AppState.session.hintUsed = 0;

    const unitLabel = document.getElementById('q-unit-label');
    if (unitLabel) unitLabel.textContent = AppState.session.detectedUnit || '';

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
    const resultEl = document.getElementById('hint-result');
    const textEl = document.getElementById('hint-result-text');

    if (level === 1 && used === 0) {
      AppState.session.hintUsed = 1;
      document.getElementById('hint-btn-1').disabled = true;
      document.getElementById('hint-btn-2').disabled = false;

      textEl.textContent = AppState.session.hint1 || '관련 물리 개념과 법칙을 떠올려보세요.';
      resultEl.classList.add('visible');
      Toast.show('힌트 1 사용 완료');

    } else if (level === 2 && used === 1) {
      AppState.session.hintUsed = 2;
      document.getElementById('hint-btn-2').disabled = true;

      textEl.innerHTML = `
        <div style="color:var(--text3);margin-bottom:6px;font-size:12px">${AppState.session.hint1 || ''}</div>
        <div>${AppState.session.hint2 || '각 문장의 표현과 조건을 하나씩 따져보세요.'}</div>
      `;
      Toast.show('힌트 2 사용 완료');
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

  /* ── Level 2 Mode B: 계산 단답형 화면 ── */

  initCalc(calcQuestion) {
    document.getElementById('calc-unit-label').textContent = AppState.session.detectedUnit || '';
    document.getElementById('calc-question-text').textContent = calcQuestion.text;

    // 단위 드롭다운
    const select = document.getElementById('calc-unit-select');
    select.innerHTML = calcQuestion.unitOptions.map(u =>
      `<option value="${u}">${u}</option>`
    ).join('');

    // 힌트 초기화
    document.getElementById('calc-hint-btn-1').disabled = false;
    document.getElementById('calc-hint-btn-2').disabled = true;
    const hintResult = document.getElementById('calc-hint-result');
    if (hintResult) hintResult.classList.remove('visible');

    // 입력값 초기화
    const input = document.getElementById('calc-answer-input');
    if (input) input.value = '';
  },

  useCalcHint(level) {
    const used = AppState.session.hintUsed;
    const resultEl = document.getElementById('calc-hint-result');
    const textEl = document.getElementById('calc-hint-result-text');

    if (level === 1 && used === 0) {
      AppState.session.hintUsed = 1;
      document.getElementById('calc-hint-btn-1').disabled = true;
      document.getElementById('calc-hint-btn-2').disabled = false;
      textEl.textContent = AppState.session.hint1 || '관련 물리 공식을 떠올려보세요.';
      resultEl.classList.add('visible');
      Toast.show('힌트 1 사용 완료');
    } else if (level === 2 && used === 1) {
      AppState.session.hintUsed = 2;
      document.getElementById('calc-hint-btn-2').disabled = true;
      textEl.innerHTML = `
        <div style="color:var(--text3);margin-bottom:6px;font-size:12px">${AppState.session.hint1 || ''}</div>
        <div>${AppState.session.hint2 || '각 변수에 어떤 값을 대입할지 생각해보세요.'}</div>
      `;
      Toast.show('힌트 2 사용 완료');
    }
  },

  submitCalc() {
    const input = document.getElementById('calc-answer-input');
    const select = document.getElementById('calc-unit-select');
    const calcQuestion = AppState.session.calcQuestion;

    const userValue = parseFloat(input?.value);
    const userUnit = select?.value;

    if (isNaN(userValue)) {
      Toast.show('숫자를 입력해주세요');
      return;
    }

    const correct = calcQuestion.correctAnswer;
    const tolerance = Math.abs(correct) * 0.01; // ±1%
    const isValueCorrect = Math.abs(userValue - correct) <= Math.max(tolerance, 0.001);
    const isUnitCorrect = userUnit === calcQuestion.unit;
    const isCorrect = isValueCorrect && isUnitCorrect;

    const score = isCorrect ? 100 : 0;
    AppState.session.score = score;

    const feedbackData = {
      score,
      title: isCorrect ? '정확해요! 🎉' : '아쉬워요 📚',
      subtitle: isCorrect ? '계산과 단위 모두 정확합니다' : (
        !isValueCorrect ? `정답은 ${correct} ${calcQuestion.unit}입니다` :
        `단위가 틀렸어요. 정답 단위: ${calcQuestion.unit}`
      ),
      misconceptions: [],
      items: [{
        id: 1,
        text: calcQuestion.text,
        isWrong: !isCorrect,
        isCorrectAnswer: isCorrect,
        userReason: `${userValue} ${userUnit}`,
        explanation: isCorrect
          ? `정확합니다! ${correct} ${calcQuestion.unit}이 맞습니다.`
          : `정답은 ${correct} ${calcQuestion.unit}입니다. 공식과 단위를 다시 확인해보세요.`,
      }],
    };

    AppState.session.feedbackData = feedbackData;
    FeedbackScreen.render(feedbackData);
    Router.go('feedback');
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

/* ============================================================
   Level3Screen — 다단계 복합 계산 문제
   ============================================================ */
const Level3Screen = {
  _tool: 'pen',        // 'pen' | 'eraser'
  _drawing: false,
  _ctx: null,
  _photoBase64: null,  // 업로드된 사진 base64

  init(calcQuestion) {
    const session = window.AppState.session;
    document.getElementById('l3-unit-label').textContent = session.detectedUnit || '';
    document.getElementById('l3-question-text').textContent = calcQuestion.text;

    // 단위 드롭다운
    const select = document.getElementById('l3-unit-select');
    select.innerHTML = calcQuestion.unitOptions.map(u =>
      `<option value="${u}">${u}</option>`
    ).join('');

    // 입력 초기화
    document.getElementById('l3-answer-input').value = '';
    document.getElementById('l3-text-input').value = '';
    this._photoBase64 = null;
    this._pending = null;
    this.switchTab('text');
    this._resetHints();
    this._initCanvas();
    this._resetReviewUI();
  },

  switchTab(tab) {
    document.getElementById('l3-tab-text').classList.toggle('active', tab === 'text');
    document.getElementById('l3-tab-draw').classList.toggle('active', tab === 'draw');
    document.getElementById('l3-panel-text').classList.toggle('hidden', tab !== 'text');
    document.getElementById('l3-panel-draw').classList.toggle('hidden', tab !== 'draw');
    if (tab === 'draw') this._resizeCanvas();
  },

  setTool(tool) {
    this._tool = tool;
    document.getElementById('l3-tool-pen').classList.toggle('active', tool === 'pen');
    document.getElementById('l3-tool-eraser').classList.toggle('active', tool === 'eraser');
  },

  clearCanvas() {
    if (this._ctx) {
      const canvas = document.getElementById('l3-canvas');
      this._ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  },

  handlePhotoUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      this._photoBase64 = ev.target.result;
      document.getElementById('l3-photo-img').src = this._photoBase64;
      document.getElementById('l3-photo-preview').classList.remove('hidden');
      document.getElementById('l3-canvas').classList.add('hidden');
    };
    reader.readAsDataURL(file);
  },

  removePhoto() {
    this._photoBase64 = null;
    document.getElementById('l3-photo-preview').classList.add('hidden');
    document.getElementById('l3-canvas').classList.remove('hidden');
    document.getElementById('l3-photo-input').value = '';
  },

  useHint(n) {
    const session = window.AppState.session;
    const text = n === 1 ? session.hint1 : session.hint2;
    if (!text) return;
    document.getElementById('l3-hint-result').style.display = 'flex';
    document.getElementById('l3-hint-result-text').textContent = text;
    if (n === 1) document.getElementById('l3-hint-btn-2').disabled = false;
  },

  /* 최종 답 제출 → (풀이 과정 있으면) AI가 인식한 내용을 검토 단계로, 없으면 바로 채점 */
  async submit() {
    const answerInput = document.getElementById('l3-answer-input');
    const userValue = parseFloat(answerInput.value);
    if (isNaN(userValue)) {
      Toast.show('숫자를 입력해주세요.');
      return;
    }

    const submitBtn = document.getElementById('l3-submit-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = '풀이 확인 중...';

    try {
      const calcQuestion = window.AppState.session.calcQuestion;
      const userUnit = document.getElementById('l3-unit-select').value;
      const correct = calcQuestion.correctAnswer;
      const isValueCorrect = Math.abs(userValue - correct) / Math.abs(correct) <= 0.01;
      const isUnitCorrect = userUnit === calcQuestion.unit;
      const isCorrect = isValueCorrect && isUnitCorrect;
      const answerScore = isCorrect ? 100 : 0;

      // 풀이 과정 수집 (텍스트 또는 캔버스/사진)
      const textProcess = document.getElementById('l3-text-input').value.trim();
      let processImageBase64 = null;
      const activeTab = document.getElementById('l3-tab-draw').classList.contains('active');
      if (activeTab) {
        if (this._photoBase64) {
          processImageBase64 = this._photoBase64;
        } else {
          const canvas = document.getElementById('l3-canvas');
          processImageBase64 = canvas.toDataURL('image/png');
        }
      }

      this._pending = { isCorrect, isValueCorrect, answerScore, correct, calcQuestion };

      if (!processImageBase64 && !textProcess) {
        // 풀이 과정 미제출 → 검토 단계 없이 바로 최종 결과로
        await this._finalize('', 0, '풀이 과정이 제출되지 않았습니다.');
        return;
      }

      // 이미지면 AI가 먼저 텍스트로 옮겨 적고, 텍스트 입력이면 그대로 사용
      const recognizedText = processImageBase64
        ? await ApiService.recognizeSolutionImage(processImageBase64)
        : textProcess;

      this._showReview(recognizedText);
    } catch (err) {
      console.error('L3 제출 실패:', err);
      Toast.show('채점에 실패했어요. 다시 시도해주세요.');
      submitBtn.disabled = false;
      submitBtn.textContent = '제출하기';
    }
  },

  /* AI가 읽은 풀이 과정을 보여주고 수정할 수 있게 함 */
  _showReview(text) {
    const submitBtn = document.getElementById('l3-submit-btn');
    submitBtn.style.display = 'none';
    document.getElementById('l3-review-area').classList.remove('hidden');
    document.getElementById('l3-review-textarea').value = text;
  },

  /* 검토/수정한 풀이 과정으로 실제 채점 요청 */
  async confirmGrade(btnEl) {
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = '채점 중...'; }
    try {
      const editedText = document.getElementById('l3-review-textarea').value.trim();
      const { calcQuestion } = this._pending;
      const { score, feedback } = await ApiService.gradeSolutionProcess(
        calcQuestion.text,
        calcQuestion.correctAnswer,
        calcQuestion.unit,
        calcQuestion.solutionSteps,
        editedText
      );
      await this._finalize(editedText, score, feedback);
    } catch (err) {
      console.error('풀이 과정 채점 실패:', err);
      Toast.show('풀이 과정 채점에 실패했어요. 다시 시도해주세요.');
      if (btnEl) { btnEl.disabled = false; btnEl.textContent = '이 내용으로 채점받기'; }
    }
  },

  /* 답 정확도(60%) + 풀이 과정 점수(40%)를 합쳐 최종 결과 화면으로 */
  async _finalize(processText, processScore, processFeedback) {
    const { isCorrect, isValueCorrect, answerScore, correct, calcQuestion } = this._pending;
    const finalScore = Math.round(answerScore * 0.6 + processScore * 0.4);

    const answerLine = isCorrect
      ? `정확합니다! ${correct} ${calcQuestion.unit}이 맞습니다.`
      : !isValueCorrect
        ? `정답은 ${correct} ${calcQuestion.unit}입니다.`
        : `단위가 틀렸어요. 정답 단위: ${calcQuestion.unit}`;

    const explanation = processText
      ? `[최종 답] ${answerLine}\n[풀이 과정 · ${processScore}점] ${processFeedback}`
      : `[최종 답] ${answerLine}\n[풀이 과정] ${processFeedback}`;

    const feedbackData = {
      score: finalScore,
      title: finalScore >= 80 ? '훌륭해요! 🎉' : finalScore >= 50 ? '잘 하셨어요! 👍' : '다시 도전해봐요 📚',
      subtitle: `정답 ${isCorrect ? 'O' : 'X'} · 풀이 과정 ${processScore}점`,
      misconceptions: [],
      items: [{
        id: 1,
        text: calcQuestion.text,
        isWrong: !isCorrect,
        isCorrectAnswer: isCorrect,
        userReason: processText || '(풀이 과정 없음)',
        explanation,
        solutionSteps: calcQuestion.solutionSteps || [],
      }],
    };

    AppState.session.score = finalScore;
    AppState.session.feedbackData = feedbackData;
    this._resetReviewUI();
    await FeedbackScreen.render(feedbackData);
    Router.go('feedback');
  },

  _resetReviewUI() {
    const submitBtn = document.getElementById('l3-submit-btn');
    submitBtn.disabled = false;
    submitBtn.textContent = '제출하기';
    submitBtn.style.display = '';
    document.getElementById('l3-review-area').classList.add('hidden');
  },

  _resetHints() {
    document.getElementById('l3-hint-result').style.display = 'none';
    document.getElementById('l3-hint-result-text').textContent = '';
    document.getElementById('l3-hint-btn-1').disabled = false;
    document.getElementById('l3-hint-btn-2').disabled = true;
  },

  /* Pointer Events로 통합 — 마우스/손가락 터치/펜슬(애플펜슬, 서피스펜 등) 전부 하나의 이벤트로 처리 */
  _initCanvas() {
    const canvas = document.getElementById('l3-canvas');
    this._ctx = canvas.getContext('2d');
    this._resizeCanvas();

    const getPos = (e) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    const start = (e) => {
      e.preventDefault();
      canvas.setPointerCapture?.(e.pointerId);
      this._drawing = true;
      const { x, y } = getPos(e);
      this._ctx.beginPath();
      this._ctx.moveTo(x, y);
    };
    const move = (e) => {
      if (!this._drawing) return;
      e.preventDefault();
      const { x, y } = getPos(e);
      this._ctx.globalCompositeOperation = this._tool === 'eraser' ? 'destination-out' : 'source-over';
      this._ctx.lineWidth = this._tool === 'eraser' ? 20 : 2;
      this._ctx.strokeStyle = '#e2e8f0';
      this._ctx.lineCap = 'round';
      this._ctx.lineTo(x, y);
      this._ctx.stroke();
    };
    const end = (e) => {
      this._drawing = false;
      if (canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    };

    canvas.addEventListener('pointerdown', start);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', end);
  },

  _resizeCanvas() {
    const canvas = document.getElementById('l3-canvas');
    const saved = this._ctx ? canvas.toDataURL() : null;
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight; // CSS(.l3-canvas)의 반응형 높이(vh 기준)를 그대로 따라감
    if (saved && this._ctx) {
      const img = new Image();
      img.onload = () => this._ctx.drawImage(img, 0, 0);
      img.src = saved;
    }
  },
};

window.Level3Screen = Level3Screen;