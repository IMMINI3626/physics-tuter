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
    // 게스트 카운트 증가는 keyword.js의 분석 성공 시점에서 이미 처리됨 (중복 방지)
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
      Toast.show('채점하는 데 실패했어요. 다시 시도해주세요.');
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '제출하고 채점받기'; }
    }
  },

  /* ── Level 2 Mode B: 계산 단답형 화면 ── */

  initCalc(calcQuestion) {
    document.getElementById('calc-unit-label').textContent = AppState.session.detectedUnit || '';
    document.getElementById('calc-question-text').textContent = calcQuestion.text;

    // 단위 드롭다운
    // 🔑 AI는 unitOptions를 ["정답단위", "헷갈릴단위1", ...] 순서로 생성한다(functions/index.js 프롬프트).
    //    그대로 뿌리면 정답이 항상 첫 번째 = select의 기본 선택값이 되어, 단위를 건드리지 않은
    //    학생이 무조건 맞는다. 반드시 섞어서 보여줄 것.
    const select = document.getElementById('calc-unit-select');
    const options = this._shuffle(calcQuestion.unitOptions || [calcQuestion.unit]);
    select.innerHTML = options.map(u =>
      `<option value="${u}">${u}</option>`
    ).join('');

    // 힌트 초기화
    // 🔑 버튼의 disabled뿐 아니라 세션 카운터(hintUsed)도 반드시 같이 0으로 되돌릴 것 —
    //    useCalcHint()가 hintUsed 값으로 단계를 판단하기 때문에, 이게 남아있으면
    //    버튼은 활성화돼 보이는데 눌러도 아무 반응이 없다.
    AppState.session.hintUsed = 0;
    document.getElementById('calc-hint-btn-1').disabled = false;
    document.getElementById('calc-hint-btn-2').disabled = true;
    const hintResult = document.getElementById('calc-hint-result');
    if (hintResult) hintResult.classList.remove('visible');

    // 🔑 계산형 화면엔 체크박스가 없으므로, 직전 STEP1 문제의 체크 상태가 그대로 남아
    //    checkedCount로 저장되지 않도록 여기서 비움
    AppState.session.checkedStatements = new Set();

    // 입력값 초기화
    const input = document.getElementById('calc-answer-input');
    if (input) input.value = '';
  },

  /* 원본 배열을 건드리지 않는 Fisher-Yates 셔플 */
  _shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
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
        // 🔑 나중에 마이페이지 기록에서 "다시 풀기"로 이 문제를 복원할 수 있도록 원본 데이터도 같이 넘김
        correctAnswer: calcQuestion.correctAnswer,
        unit: calcQuestion.unit,
        unitOptions: calcQuestion.unitOptions,
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

};

/* ============================================================
   Level3Screen — 다단계 복합 계산 문제
   ============================================================ */
const Level3Screen = {
  _tool: 'pen',        // 'pen' | 'eraser' (풀이 과정 캔버스 전용 — 답 캔버스는 항상 펜)
  _ctx: null,           // 풀이 과정 캔버스 컨텍스트
  _answerCtx: null,      // 답 캔버스 컨텍스트
  _photoBase64: null,   // 업로드된 사진 base64 (풀이 과정용)
  _answerHasDrawing: false, // 답 캔버스에 실제로 뭔가 그려졌는지

  init(calcQuestion) {
    const session = window.AppState.session;
    document.getElementById('l3-unit-label').textContent = session.detectedUnit || '';
    document.getElementById('l3-question-text').textContent = calcQuestion.text;

    // 입력 초기화
    document.getElementById('l3-text-input').value = '';
    document.getElementById('l3-answer-text-input').value = '';
    // 🔑 calc 화면과 같은 이유로 세션 카운터/체크 상태도 함께 초기화
    session.hintUsed = 0;
    session.checkedStatements = new Set();
    this._photoBase64 = null;
    this._answerHasDrawing = false;
    this._pending = null;
    this.switchProcessTab('text');
    this.switchAnswerTab('text');
    this._resetHints();
    this._initCanvas('l3-canvas', '_ctx');
    this._initCanvas('l3-answer-canvas', '_answerCtx', () => { this._answerHasDrawing = true; });
    this._bindResizeHandles();
    this._resetReviewUI();
  },

  /* 풀이 과정 탭 전환 (답과 독립적) */
  switchProcessTab(tab) {
    document.getElementById('l3-tab-text').classList.toggle('active', tab === 'text');
    document.getElementById('l3-tab-draw').classList.toggle('active', tab === 'draw');
    document.getElementById('l3-panel-text').classList.toggle('hidden', tab !== 'text');
    document.getElementById('l3-panel-draw').classList.toggle('hidden', tab !== 'draw');
    if (tab === 'draw') this._resizeCanvas('l3-canvas', '_ctx');
  },

  /* 답 탭 전환 (풀이 과정과 독립적) */
  switchAnswerTab(tab) {
    document.getElementById('l3-answer-tab-text').classList.toggle('active', tab === 'text');
    document.getElementById('l3-answer-tab-draw').classList.toggle('active', tab === 'draw');
    document.getElementById('l3-answer-panel-text').classList.toggle('hidden', tab !== 'text');
    document.getElementById('l3-answer-panel-draw').classList.toggle('hidden', tab !== 'draw');
    if (tab === 'draw') this._resizeCanvas('l3-answer-canvas', '_answerCtx');
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

  clearAnswerCanvas() {
    if (this._answerCtx) {
      const canvas = document.getElementById('l3-answer-canvas');
      this._answerCtx.clearRect(0, 0, canvas.width, canvas.height);
      this._answerHasDrawing = false;
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
    // 🔑 STEP1/calc 화면과 동일하게 사용량을 세션에 기록 —
    //    안 그러면 L3 세션만 hintUsed가 0으로 저장돼 학습 분석에서 쓸 수 없다
    session.hintUsed = Math.max(session.hintUsed || 0, n);
    if (n === 1) {
      document.getElementById('l3-hint-btn-1').disabled = true;
      document.getElementById('l3-hint-btn-2').disabled = false;
    } else {
      document.getElementById('l3-hint-btn-2').disabled = true;
    }
  },

  /* 제출 → 풀이 과정/답을 (이미지면) AI가 먼저 텍스트로 읽어서 검토 단계로 보여줌 */
  async submit() {
    const isProcessDrawTab = document.getElementById('l3-tab-draw').classList.contains('active');
    const isAnswerDrawTab = document.getElementById('l3-answer-tab-draw').classList.contains('active');

    const textProcess = document.getElementById('l3-text-input').value.trim();
    const rawAnswerText = document.getElementById('l3-answer-text-input').value.trim();

    let processImageBase64 = null;
    let answerImageBase64 = null;
    if (isProcessDrawTab) {
      processImageBase64 = this._photoBase64 || document.getElementById('l3-canvas').toDataURL('image/png');
    }
    if (isAnswerDrawTab && this._answerHasDrawing) {
      answerImageBase64 = document.getElementById('l3-answer-canvas').toDataURL('image/png');
    }

    const hasAnswer = !!(rawAnswerText || answerImageBase64);
    if (!hasAnswer) {
      Toast.show('답을 입력해주세요.');
      return;
    }

    const submitBtn = document.getElementById('l3-submit-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = '풀이 확인 중...';

    try {
      const calcQuestion = window.AppState.session.calcQuestion;
      this._pending = { calcQuestion };

      // 이미지면 AI가 먼저 텍스트로 옮겨 적고, 텍스트 입력이면 그대로 사용
      const recognizedProcessText = processImageBase64
        ? await ApiService.recognizeSolutionImage(processImageBase64)
        : textProcess;
      const recognizedAnswerText = answerImageBase64
        ? await ApiService.recognizeSolutionImage(answerImageBase64)
        : rawAnswerText;

      this._showReview(recognizedProcessText, recognizedAnswerText);
    } catch (err) {
      console.error('L3 제출 실패:', err);
      Toast.show('채점에 실패했어요. 다시 시도해주세요.');
      submitBtn.disabled = false;
      submitBtn.textContent = '제출하기';
    }
  },

  /* AI가 읽은 풀이 과정/답을 보여주고 수정할 수 있게 함 */
  _showReview(processText, answerText) {
    const submitBtn = document.getElementById('l3-submit-btn');
    submitBtn.style.display = 'none';
    document.getElementById('l3-review-area').classList.remove('hidden');
    document.getElementById('l3-review-textarea').value = processText;
    document.getElementById('l3-review-answer-input').value = answerText;
  },

  /* 검토/수정한 풀이 과정·답으로 실제 채점 요청 */
  async confirmGrade(btnEl) {
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = '채점 중...'; }
    try {
      const editedProcess = document.getElementById('l3-review-textarea').value.trim();
      const editedAnswer = document.getElementById('l3-review-answer-input').value.trim();
      if (!editedAnswer) {
        Toast.show('답을 입력해주세요.');
        if (btnEl) { btnEl.disabled = false; btnEl.textContent = '이 내용으로 채점받기'; }
        return;
      }

      const { calcQuestion } = this._pending;
      const { score, feedback, answerCorrect } = await ApiService.gradeSolutionProcess(
        calcQuestion.text,
        calcQuestion.correctAnswer,
        calcQuestion.unit,
        calcQuestion.solutionSteps,
        editedProcess,
        editedAnswer
      );
      this._pending.isCorrect = !!answerCorrect;
      this._pending.answerScore = answerCorrect ? 100 : 0;
      await this._finalize(editedProcess, editedAnswer, score, feedback);
    } catch (err) {
      console.error('풀이 과정 채점 실패:', err);
      Toast.show('풀이 과정 채점에 실패했어요. 다시 시도해주세요.');
      if (btnEl) { btnEl.disabled = false; btnEl.textContent = '이 내용으로 채점받기'; }
    }
  },

  /* 답 정확도(60%) + 풀이 과정 점수(40%)를 합쳐 최종 결과 화면으로 */
  async _finalize(processText, answerText, processScore, processFeedback) {
    const { isCorrect, answerScore, calcQuestion } = this._pending;
    const correct = calcQuestion.correctAnswer;
    const finalScore = Math.round(answerScore * 0.6 + processScore * 0.4);

    const answerLine = isCorrect
      ? `정답입니다!`
      : `정답은 ${correct} ${calcQuestion.unit}입니다.`;

    const explanation = `[내가 쓴 답] ${answerText} → ${answerLine}\n[풀이 과정 · ${processScore}점] ${processFeedback}`;

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
        userReason: processText || `[답] ${answerText}`,
        explanation,
        solutionSteps: calcQuestion.solutionSteps || [],
        // 🔑 마이페이지 기록에서 "다시 풀기"로 이 Level 3 문제를 복원할 수 있도록 원본 데이터도 같이 넘김
        correctAnswer: calcQuestion.correctAnswer,
        unit: calcQuestion.unit,
        unitOptions: calcQuestion.unitOptions,
        isLevel3: true,
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

  /* Pointer Events로 통합 — 마우스/손가락 터치/펜슬(애플펜슬, 서피스펜 등) 전부 하나의 이벤트로 처리.
     canvasId/ctxKey로 풀이 과정 캔버스와 답 캔버스에 공용으로 사용. */
  _initCanvas(canvasId, ctxKey, onStroke) {
    const canvas = document.getElementById(canvasId);
    this[ctxKey] = canvas.getContext('2d');
    this._resizeCanvas(canvasId, ctxKey);

    let drawing = false;
    const getPos = (e) => {
      const rect = canvas.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };

    const start = (e) => {
      e.preventDefault();
      canvas.setPointerCapture?.(e.pointerId);
      drawing = true;
      onStroke?.();
      const { x, y } = getPos(e);
      const ctx = this[ctxKey];
      ctx.beginPath();
      ctx.moveTo(x, y);
    };
    const move = (e) => {
      if (!drawing) return;
      e.preventDefault();
      const { x, y } = getPos(e);
      const ctx = this[ctxKey];
      // 답 캔버스는 지우개 개념이 없는 펜 전용 — 풀이과정 캔버스의 지우개 상태가 새어들지 않도록 분리
      const tool = ctxKey === '_answerCtx' ? 'pen' : this._tool;
      ctx.globalCompositeOperation = tool === 'eraser' ? 'destination-out' : 'source-over';
      ctx.lineWidth = tool === 'eraser' ? 20 : 2;
      ctx.strokeStyle = '#111018'; // --text1과 동일한 검정 (밝은 캔버스 배경 위에서 잘 보이도록)
      ctx.lineCap = 'round';
      ctx.lineTo(x, y);
      ctx.stroke();
    };
    const end = (e) => {
      drawing = false;
      if (canvas.hasPointerCapture?.(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    };

    canvas.addEventListener('pointerdown', start);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    canvas.addEventListener('pointerleave', end);
  },

  _resizeCanvas(canvasId, ctxKey) {
    const canvas = document.getElementById(canvasId);
    const ctx = this[ctxKey];
    const saved = ctx ? canvas.toDataURL() : null;
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight; // CSS의 반응형 높이를 그대로 따라감
    if (saved && ctx) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0);
      img.src = saved;
    }
  },

  /* 캔버스 우하단 핸들을 드래그해서 세로 크기 조절 (텍스트박스 resize와 동일한 역할) */
  _bindResizeHandles() {
    document.querySelectorAll('.l3-canvas-resize-handle').forEach(handleEl => {
      if (handleEl._l3ResizeBound) return;
      handleEl._l3ResizeBound = true;
      this._initResizeHandle(handleEl);
    });
  },

  _initResizeHandle(handleEl) {
    const wrap = document.getElementById(handleEl.dataset.wrap);
    const canvasId = handleEl.dataset.canvas;
    const ctxKey = handleEl.dataset.ctx;
    let dragging = false;
    let startY = 0;
    let startHeight = 0;

    const move = (e) => {
      if (!dragging) return;
      e.preventDefault();
      const styles = getComputedStyle(wrap);
      const min = parseFloat(styles.minHeight) || 100;
      const max = parseFloat(styles.maxHeight) || 800;
      const next = Math.min(max, Math.max(min, startHeight + (e.clientY - startY)));
      wrap.style.height = `${next}px`;
    };
    const end = (e) => {
      if (!dragging) return;
      dragging = false;
      if (handleEl.hasPointerCapture?.(e.pointerId)) handleEl.releasePointerCapture(e.pointerId);
      this._resizeCanvas(canvasId, ctxKey);
    };

    handleEl.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      dragging = true;
      startY = e.clientY;
      startHeight = wrap.offsetHeight;
      handleEl.setPointerCapture?.(e.pointerId);
    });
    handleEl.addEventListener('pointermove', move);
    handleEl.addEventListener('pointerup', end);
    handleEl.addEventListener('pointercancel', end);
  },
};

window.Level3Screen = Level3Screen;