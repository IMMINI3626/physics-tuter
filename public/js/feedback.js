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

    container.innerHTML = items.map(item => {
      const statusClass = item.isWrong
        ? (item.isCorrectAnswer ? 'correct' : 'wrong')
        : 'correct';

      const checkIcon = `<svg viewBox="0 0 24 24"><polyline points="20 6 9 17 4 12"/></svg>`;
      const xIcon     = `<svg viewBox="0 0 24 24"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
      const icon = (item.isWrong && !item.isCorrectAnswer) ? xIcon : checkIcon;

      // 틀린 문장이고 사용자가 선택한 경우만 설명 표시
      const showExplanation = item.isWrong && item.userReason !== undefined;

      return `
        <div class="feedback-card">
          <div class="fb-card-header">
            <div class="fb-status ${statusClass}">${icon}</div>
            <span class="fb-stmt ${statusClass}">${item.text}</span>
          </div>
          ${showExplanation ? `
            <div class="fb-explanation">
              <div class="fb-exp-label user">📝 내 답변</div>
              <div class="fb-user-ans">${item.userReason || '(미입력)'}</div>
              <div class="fb-exp-label ideal">✅ 올바른 해설</div>
              <div class="fb-correct-ans">${item.explanation}</div>
            </div>
          ` : ''}
        </div>
      `;
    }).join('');
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
