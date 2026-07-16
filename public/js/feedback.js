/* ============================================================
   PhysiClinic — Feedback Screen Logic
   ============================================================ */
/* 소단원 오개념 수 기반 동적 목표치 계산 (레벨별 배수/상하한) */
function calcPromotionTarget(mcCount, level) {
  const configs = [
    { mul: 1.7, min: 10, max: 20 }, // L1
    { mul: 1.3, min: 7,  max: 13 }, // L2
    { mul: 1.0, min: 5,  max: 10 }, // L3
  ];
  const { mul, min, max } = configs[(level - 1)] || configs[0];
  return Math.min(Math.max(Math.round(mcCount * mul), min), max);
}

const FeedbackScreen = {
  // isHistory 파라미터 추가, returnTo로 돌아갈 화면 지정 (기본값: mypage)
  async render(data, isHistory = false, returnTo = 'mypage') {
    this._renderScore(data.score, data.title, data.subtitle);
    this._renderFeedbackList(data.items);

    // isHistory가 아닐 때(방금 막 푼 새 문제일 때)만 DB에 저장
    if (!isHistory && window.AppState.isLoggedIn && window.AppState.user) {
      window.LearningService.saveSession(data).catch(console.error);
    }

    const nextBtn = document.getElementById('btn-feedback-next');
    if (!nextBtn) return;

    if (isHistory) {
      // 과거 기록 뷰: 다시 풀기 위해 필요한 데이터를 기억해둠 (retrySameHistory에서 사용)
      this._historyItems = data.items;
      this._historyUnit = data.unit || null;

      this._setHistoryHeader(returnTo);
      nextBtn.style.display = 'none';
      this._renderHistoryActions(data.items, returnTo);
      return;
    }

    this._resetHeader();
    // 🆕 일반 학습 완료 뷰: 레벨 시스템 적용 (승급 처리 + 버튼 분기)
    await this._handleLevelProgress(data);
  },

  /* 과거 기록 뷰: 상단바를 "< 마이페이지/문제풀기" 형태의 back-btn으로 전환 */
  _setHistoryHeader(returnTo) {
    const backBtn = document.getElementById('feedback-back-btn');
    const backLabel = document.getElementById('feedback-back-label');
    const actions = document.getElementById('feedback-topbar-actions');
    if (!backBtn || !actions) return;

    backLabel.textContent = returnTo === 'quiz-library' ? '문제풀기' : '마이페이지';
    backBtn.style.display = '';
    backBtn.onclick = () => {
      window.Router.go(returnTo);
      if (returnTo === 'quiz-library' && window.QuizLibraryScreen) {
        window.QuizLibraryScreen.init();
      }
    };
    // back-btn과 균형 맞추는 자리 — 다른 화면들의 back-btn+spacer 패턴과 동일
    actions.innerHTML = '<div style="width:72px"></div>';
  },

  /* 일반(방금 막 푼) 피드백 뷰: 상단바를 원래의 로고 + 홈 아이콘으로 복원 */
  _resetHeader() {
    const backBtn = document.getElementById('feedback-back-btn');
    const actions = document.getElementById('feedback-topbar-actions');
    if (backBtn) backBtn.style.display = 'none';
    if (actions) {
      actions.innerHTML = `
        <div class="icon-btn" onclick="Router.go('home')" aria-label="홈으로">
          <svg viewBox="0 0 24 24">
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
            <polyline points="9 22 9 12 15 12 15 22"/>
          </svg>
        </div>
      `;
    }
  },

  /* "다시 풀기" 제공 가능 여부 판단.
     - STEP1/2(문장 5개) 방식: items.length > 1이면 항상 가능 (문항 자체가 정답/오답 여부뿐이라 원본 그대로 복원됨)
     - 계산형 단일 문항: correctAnswer/unit/unitOptions가 로그에 저장되어 있을 때만 가능
       (Level 2 방식B부터 저장하기 시작함 — Level 3는 아직 저장 안 해서 여기서 자동으로 걸러짐) */
  _canRetryHistory(items) {
    if (!Array.isArray(items) || !items.length) return false;
    if (items.length > 1) return true;
    const it = items[0];
    return it.correctAnswer !== undefined && !!it.unit && Array.isArray(it.unitOptions);
  },

  /* 과거 기록 화면 하단 버튼: [다시 풀기] [목록으로 돌아가기] 양옆으로 반반. */
  _renderHistoryActions(items, returnTo) {
    const area = document.getElementById('level-progress-area');
    if (!area) return;

    const canRetrySame = this._canRetryHistory(items);
    const backLabel = returnTo === 'quiz-library' ? '문제풀기로 돌아가기' : '목록으로 돌아가기';

    const retryBtn = canRetrySame ? `
      <button class="primary-btn" style="margin:0;flex:1;background:var(--surface2);color:var(--text1);box-shadow:none" onclick="FeedbackScreen.retrySameHistory()">
        다시 풀기
      </button>
    ` : '';

    area.style.display = 'block';
    area.innerHTML = `
      <div style="display:flex;gap:10px;margin:0 20px 20px;">
        ${retryBtn}
        <button class="primary-btn green-btn" style="margin:0;flex:1" onclick="FeedbackScreen._historyGoBack('${returnTo}')">
          ${backLabel}
        </button>
      </div>
    `;
  },

  _historyGoBack(returnTo) {
    window.Router.go(returnTo);
    if (returnTo === 'quiz-library' && window.QuizLibraryScreen) {
      window.QuizLibraryScreen.init();
    }
  },

  /* 과거 기록 화면에서 "다시 풀기" — 그때 그 문제를 그대로 복원해서 다시 풀게 함
     (STEP1/2 방식은 5문장 전체를, 계산형은 문제·정답·단위를 복원).
     실제 라이브 세션의 retrySame()과 동일하게 isRetry=true로 표시되어, 다시 제출해도
     승급 카운터에는 반영되지 않음 (채점/저장 자체는 새로 일어남 — 라이브 재시도와 동일 동작) */
  retrySameHistory() {
    const items = this._historyItems;
    if (!this._canRetryHistory(items)) return;

    AppState.session.detectedUnit = this._historyUnit || AppState.session.detectedUnit;
    AppState.session.checkedStatements = new Set();
    AppState.session.step2Answers = [];
    AppState.session.isRetry = true;
    // 과거 기록에는 세션이 다뤘던 원래 오개념 id 목록이 없음 — 직전 세션(다른 단원일 수 있음)의
    // misconceptions가 그대로 남아있으면 이 재시도가 엉뚱한 오개념을 다룬 것으로 잘못 저장되므로 비움
    AppState.session.misconceptions = [];

    if (items.length > 1) {
      // STEP1/2 방식 — 문장 5개 그대로 복원
      AppState.session.questions = items.map(it => ({ id: it.id, text: it.text, isWrong: it.isWrong }));
      AppState.session.calcQuestion = null;
      QuizScreen.init(AppState.session.questions);
      Router.go('step1');
    } else {
      // 계산형(Level 2 방식B) — 문제·정답·단위 그대로 복원
      const it = items[0];
      AppState.session.questions = null;
      AppState.session.calcQuestion = {
        text: it.text,
        correctAnswer: it.correctAnswer,
        unit: it.unit,
        unitOptions: it.unitOptions,
      };
      QuizScreen.initCalc(AppState.session.calcQuestion);
      Router.go('calc');
    }
  },

  /* 레벨 승급 카운터 처리 + 화면 분기 */
  async _handleLevelProgress(data) {
    const nextBtn = document.getElementById('btn-feedback-next');
    const session = window.AppState.session;
    const isLoggedIn = window.AppState.isLoggedIn && window.AppState.user;
    const isPerfect = data.score === 100;
    const isNewProblem = !session.isRetry;

    let isPromoted = false;
    let promotedTo = null;

    const mcCount = session.misconceptionCount || 5;
    const promotionTarget = calcPromotionTarget(mcCount, session.currentLevel);

    // 100점 + 새 문제(다시 풀어보기 아님) 일 때만 카운터 +1
    if (isLoggedIn && session.detectedUnit && isPerfect && isNewProblem) {
      try {
        const result = await window.LearningService.incrementCorrectCount(
          window.AppState.user.uid,
          session.detectedUnit,
          promotionTarget
        );
        session.correctCount = result.count;
        if (result.isPromoted) {
          isPromoted = true;
          if (session.currentLevel >= 3) {
            // L3 완료
            promotedTo = 'complete';
            await window.LearningService.setUnitLevel(
              window.AppState.user.uid, session.detectedUnit, 3, true
            );
          } else {
            promotedTo = session.currentLevel + 1;
            session.currentLevel = promotedTo;
            session.correctCount = 0;
            await window.LearningService.setUnitLevel(
              window.AppState.user.uid, session.detectedUnit, promotedTo
            );
          }
        }
      } catch (e) {
        console.error('카운터 증가 실패:', e);
      }
    }

    if (!nextBtn) return;

    if (isPromoted) {
      this._showPromotionBanner(promotedTo);
      nextBtn.style.display = 'none';
      this._renderPromotionActions(promotedTo);
    } else if (isLoggedIn) {
      nextBtn.style.display = 'none';
      this._renderCorrectionLoop(isPerfect);
    } else {
      // 비로그인
      nextBtn.style.display = '';
      nextBtn.innerHTML = `
        <svg viewBox="0 0 24 24">
          <polyline points="17 1 21 5 17 9"/>
          <path d="M3 11V9a4 4 0 0 1 4-4h14"/>
          <polyline points="7 23 3 19 7 15"/>
          <path d="M21 13v2a4 4 0 0 1-4 4H3"/>
        </svg>
        다음 학습 계속하기
      `;
      nextBtn.onclick = () => this.continueNext();
      this._clearLevelArea();
    }
  },

  /* 승급 안내 배너 표시 */
  _showPromotionBanner(newLevel) {
    const area = document.getElementById('level-progress-area');
    if (!area) return;
    area.style.display = 'block';
    const isComplete = newLevel === 'complete';
    area.innerHTML = `
      <div style="text-align:center;padding:16px;background:rgba(52,211,153,0.08);border:1px solid rgba(52,211,153,0.3);border-radius:var(--r-md);margin:0 20px 16px;">
        <div style="font-size:15px;font-weight:600;color:var(--green);margin-bottom:4px">
          ${isComplete ? '🏆 이 단원을 완전히 이해했어요!' : `🎉 Level ${newLevel}로 승급했어요!`}
        </div>
        <div style="font-size:13px;color:var(--text2)">
          ${isComplete ? '마이페이지에서 학습 이력을 확인할 수 있어요' : `누적 정답 목표를 달성했어요`}
        </div>
      </div>
    `;
  },

  /* 승급 후 액션 버튼 */
  _renderPromotionActions(newLevel) {
    const area = document.getElementById('level-progress-area');
    if (!area) return;
    const existing = area.querySelector('.promotion-actions');
    if (existing) existing.remove();

    const isComplete = newLevel === 'complete';
    const div = document.createElement('div');
    div.className = 'promotion-actions';
    div.style.cssText = 'display:flex;gap:10px;margin:0 20px 20px;';
    div.innerHTML = isComplete ? `
      <button class="primary-btn" style="margin:0;flex:1" onclick="FeedbackScreen.continueNext()">
        홈으로 나가기
      </button>
    ` : `
      <button class="primary-btn" style="margin:0;flex:1;background:var(--surface2);color:var(--text1);box-shadow:none" onclick="FeedbackScreen.continueNext()">
        홈으로 나가기
      </button>
      <button class="primary-btn green-btn" style="margin:0;flex:1" onclick="FeedbackScreen.retrySimilar(this)">
        Level ${newLevel} 시작하기
      </button>
    `;
    area.appendChild(div);
  },

  /* 교정 루프 UI */
  _renderCorrectionLoop(isPerfect) {
    const area = document.getElementById('level-progress-area');
    if (!area) return;

    const count = window.AppState.session.correctCount || 0;
    const level = window.AppState.session.currentLevel;
    const mcCount = window.AppState.session.misconceptionCount || 5;
    const target = calcPromotionTarget(mcCount, level);

    // 100점이면 다시 풀어보기 버튼 숨김 (마이페이지에서만 재시도)
    const retryBtn = isPerfect ? '' : `
      <button class="primary-btn" style="margin:0;flex:1;background:var(--surface2);color:var(--text1);box-shadow:none" onclick="FeedbackScreen.retrySame()">
        다시 풀어보기
      </button>
    `;

    area.style.display = 'block';
    area.innerHTML = `
      <div style="margin:0 20px 12px;padding:12px 14px;background:var(--surface);border:0.5px solid var(--border);border-radius:var(--r-md);text-align:center;font-size:13px;color:var(--text2)">
        현재 Level ${level} · 누적 정답 <strong style="color:var(--accent2)">${count} / ${target}</strong>
      </div>
      <div style="display:flex;gap:10px;margin:0 20px 12px;">
        ${retryBtn}
        <button id="btn-next-problem" class="primary-btn" style="margin:0;flex:1" onclick="FeedbackScreen.retrySimilar(this)">
          다음 문제 풀기
        </button>
      </div>
      <div style="margin:0 20px 20px;">
        <button class="primary-btn" style="margin:0;width:100%;background:var(--surface2);color:var(--text1);box-shadow:none" onclick="FeedbackScreen.continueNext()">
          홈으로 나가기
        </button>
      </div>
    `;
  },

  _clearLevelArea() {
    const area = document.getElementById('level-progress-area');
    if (area) { area.style.display = 'none'; area.innerHTML = ''; }
  },

  /* 다시 풀어보기: 기존 문제 재사용, 카운터 증가 없음 */
  retrySame() {
    AppState.session.isRetry = true;
    AppState.session.checkedStatements = new Set();
    AppState.session.step2Answers = [];
    if (AppState.session.calcQuestion) {
      if (AppState.session.calcQuestion.isLevel3) {
        Level3Screen.init(AppState.session.calcQuestion);
        Router.go('level3');
      } else {
        QuizScreen.initCalc(AppState.session.calcQuestion);
        Router.go('calc');
      }
    } else {
      QuizScreen.init(AppState.session.questions);
      Router.go('step1');
    }
  },

  /* 다음 문제 풀기: 같은 소단원/오개념/레벨로 새 문제 생성 */
  async retrySimilar(btnEl) {
    // 연속 클릭 방지
    if (btnEl) {
      btnEl.disabled = true;
      btnEl.textContent = '문제 생성 중...';
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
      AppState.session.isRetry = false;
      AppState.session.hint1 = result.hint1;
      AppState.session.hint2 = result.hint2;
      if (result.misconceptionCount) {
        AppState.session.misconceptionCount = result.misconceptionCount;
      }
      AppState.session.checkedStatements = new Set();
      AppState.session.step2Answers = [];
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
      console.error('문제 생성 실패:', err);
      Toast.show('문제 생성에 실패했어요. 다시 시도해주세요.');
      if (btnEl) {
        btnEl.disabled = false;
        btnEl.textContent = '다음 문제 풀기';
      }
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

  /* 피드백 카드 목록 렌더링 */
  _renderFeedbackList(items) {
    const container = document.getElementById('feedback-list');
    if (!container || !items) return;

    // userReason이 있으면 체크한 것으로 판단
    const checkedItems = items.filter(i => i.userReason !== undefined && i.userReason !== null);
    const missedItems  = items.filter(i => (i.userReason === undefined || i.userReason === null) && i.isWrong);

    // 내가 체크한 항목을 3가지 그룹으로 명확히 분류합니다.
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
      html += `<div class="fb-section-title" style="margin-top:24px">이유가 틀린 문항</div>`;
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
      html += `<div class="fb-section-title" style="margin-top:24px">오답 체크</div>`;
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
      html += `<div class="fb-section-title" style="margin-top:24px">선택하지 않은 정답 문항</div>`;
      html += missedItems.map(item => `
        <div class="feedback-card">
          <div class="fb-card-header">
            <span class="fb-stmt">${item.text}</span>
          </div>
          <div class="fb-explanation">
            <div class="fb-exp-label ideal">💡 틀린 이유</div>
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
      currentLevel: 1,
      correctCount: 0,
      misconceptionCount: 0,
      isRetry: false,
      hint1: null,
      hint2: null,
      quizMode: null,
      calcQuestion: null,
    };
    this._clearLevelArea();
    Router.go('home');
    Toast.show('새 학습을 시작해보세요!');
  },
};