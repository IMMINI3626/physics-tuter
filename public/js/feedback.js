/* ============================================================
   PhysiClinic — Feedback Screen Logic
   ============================================================ */

const FeedbackScreen = {
  render(data) {
    this._renderScore(data.score, data.title, data.subtitle);
    this._renderMisconceptions(data.misconceptions);
    this._renderFeedbackList(data.items);

    // 로그인 상태면 Firestore에 저장
    if (AppState.isLoggedIn && AppState.user) {
      LearningService.saveSession(data).catch(console.error);
    }
  },

  /* 점수 링 렌더링 */
  _renderScore(score, title, subtitle) {
    // 점수 숫자 업데이트
    document.getElementById('score-num').textContent = score;

    // SVG 원형 진행 바 계산
    // r=52 → 둘레 = 2πr ≈ 326.7
    const circumference = 326.7;
    const offset = circumference * (1 - score / 100);
    const circle = document.getElementById('score-circle');
    if (circle) circle.setAttribute('stroke-dashoffset', offset.toFixed(1));

    document.getElementById('score-title').textContent  = title    || '학습 완료!';
    document.getElementById('score-subtitle').textContent = subtitle || '';
  },

  /* 오개념 태그 렌더링 */
  _renderMisconceptions(list) {
    const container = document.getElementById('mis-tags');
    if (!container || !list) return;

    container.innerHTML = list.map(mc => `
      <span class="mis-tag ${mc.type}">
        ${mc.type === 'wrong' ? '⚠' : '✓'} ${mc.text}
      </span>
    `).join('');
  },

  /* 피드백 카드 목록 렌더링 */
  _renderFeedbackList(items) {
    const container = document.getElementById('feedback-list');
    if (!container || !items) return;

    // userReason이 있으면 체크한 것으로 판단
    const checkedItems = items.filter(i => i.userReason !== undefined && i.userReason !== null);
    const missedItems  = items.filter(i => (i.userReason === undefined || i.userReason === null) && i.isWrong);

    // 🔑 내가 체크한 항목을 3가지 그룹으로 명확히 분류합니다.
    const perfectItems = checkedItems.filter(i => i.isWrong && i.isCorrectAnswer);   // 케이스 A: 완벽 이해
    const halfItems    = checkedItems.filter(i => i.isWrong && !i.isCorrectAnswer);  // 케이스 B: 이유 틀림
    const wrongGuess   = checkedItems.filter(i => !i.isWrong);                       // 케이스 C: 헛다리 짚음

    let html = '';

    // ── 그룹 1: 완벽하게 이해한 문장 ──
    if (perfectItems.length) {
      html += `<div class="fb-section-title">정답</div>`;
      html += perfectItems.map(item => `
        <div class="feedback-card">
          <div class="fb-card-header">
            <span class="fb-stmt" style="text-decoration:line-through;color:var(--text3)">${item.text}</span>
          </div>
          <div class="fb-explanation">
            <div class="fb-exp-label user">📝 내 답변</div>
            <div class="fb-user-ans">${item.userReason || '(입력 없음)'}</div>
            <div class="fb-exp-label ideal">✅ 피드백</div>
            <div class="fb-correct-ans">${item.explanation}</div>
          </div>
        </div>`).join('');
    }

    // ── 그룹 2: 오개념은 찾았지만, 이유가 틀린 문장 ──
    if (halfItems.length) {
      html += `<div class="fb-section-title" style="margin-top:24px">📖 다시 한 번 확인이 필요한 문장</div>`;
      html += halfItems.map(item => `
        <div class="feedback-card">
          <div class="fb-card-header">
            <span class="fb-stmt">${item.text}</span>
          </div>
          <div class="fb-explanation">
            <div class="fb-exp-label user">📝 내 답변</div>
            <div class="fb-user-ans">${item.userReason || '(입력 없음)'}</div>
            <div class="fb-exp-label ideal">💡 올바른 피드백</div>
            <div class="fb-correct-ans">${item.explanation}</div>
          </div>
        </div>`).join('');
    }

    // ── 그룹 3: 올바른 문장인데 오개념으로 착각한 문장 ──
    if (wrongGuess.length) {
      html += `<div class="fb-section-title" style="margin-top:24px">맞는 개념인데 틀렸다고 체크한 문장</div>`;
      html += wrongGuess.map(item => `
        <div class="feedback-card">
          <div class="fb-card-header">
            <span class="fb-stmt">${item.text}</span>
          </div>
          <div class="fb-explanation">
            <div class="fb-exp-label user">📝 내 답변</div>
            <div class="fb-user-ans">${item.userReason || '(입력 없음)'}</div>
            <div class="fb-exp-label ideal">💡 올바른 피드백</div>
            <div class="fb-correct-ans">${item.explanation}</div>
          </div>
        </div>`).join('');
    }

    // ── 그룹 4: 아예 놓쳐버린 오개념 ──
    if (missedItems.length) {
      html += `<div class="fb-section-title" style="margin-top:24px">체크하지 못한 틀린 문장</div>`;
      html += missedItems.map(item => `
        <div class="feedback-card">
          <div class="fb-card-header">
            <span class="fb-stmt">${item.text}</span>
          </div>
          <div class="fb-explanation">
            <div class="fb-exp-label ideal">💡 왜 틀렸을까요?</div>
            <div class="fb-correct-ans">${item.explanation}</div>
          </div>
        </div>`).join('');
    }

    // 아무것도 없을 때 (퍼펙트 클리어)
    if (!checkedItems.length && !missedItems.length) {
      html = `<div style="text-align:center;padding:30px;color:var(--text3);font-size:14px">모든 문장을 정확히 판단했어요! 🎉</div>`;
    }

    container.innerHTML = html;
  },

  /* 다음 학습 */
  continueNext() {
    // 세션 초기화
    AppState.session = {
      uploadedImageBase64: null,
      extractedKeywords: [],
      detectedUnit: null,
      misconceptions: [],
      questions: [],
      checkedStatements: new Set(),
      step2Answers: [],
      hintUsed: 0,
      score: null,
      feedbackData: null,
    };
    Router.go('home');
    Toast.show('새 학습을 시작해보세요!');
  },
};
