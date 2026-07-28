/* ============================================================
   PhysiClinic — Feedback Screen Logic
   ============================================================ */
/* 레벨별 "합격"(승급 카운터 +1) 기준 점수.
   L1/L2는 문항 정오답이 명확해서 만점을 요구해도 되지만, L3는 최종 점수가
   [정답 여부 60% + AI가 매긴 풀이 과정 점수 40%]라서 만점을 요구하면 사실상 승급이 불가능하다.
   (풀이 과정 채점 프롬프트가 "100점이 아니면 감점 사유를 반드시 명시하라"고 지시해서
    모델이 90~95점으로 수렴 → 총점이 100에 못 미침 → 🏆 단원 완료에 영원히 도달 못 함)
   따라서 L3만 90점으로 낮춘다. 정답을 맞히고(60) 풀이 과정 75점 이상이면 통과하는 수준. */
const PROMOTION_SCORE = { 1: 100, 2: 100, 3: 90 };

/* 승급 판정은 Phase 3 단계 7에서 "누적 정답 횟수"(calcPromotionTarget의 임의 계수)에서
   "레벨 대상 오개념의 이해도 P(L)이 모두 0.90 이상인가"로 교체됐다. 설계: docs/오개념측정_BKT_설계.md 4-10 */

/* 문항 신고 사유 (설계 단계 9-1).
   자유 입력만 받으면 아무도 안 쓰고, 고르기만 시키면 예상 밖의 오류를 못 듣는다.
   자주 나올 것을 고정 항목으로 두고 마지막에 '기타'로 서술 칸을 연다. */
const REPORT_REASONS = [
  { code: 'label_should_be_correct', text: '이 문장은 맞는 것 같아요' },
  { code: 'label_should_be_wrong',   text: '이 문장은 틀린 것 같아요' },
  { code: 'bad_explanation',         text: '해설이 이상해요' },
  { code: 'bad_grading',             text: '채점이 잘못됐어요' },
  { code: 'unclear',                 text: '문제가 이해가 안 돼요' },
  { code: 'etc',                     text: '기타 (직접 입력)' },
];

const FeedbackScreen = {
  _reportItem: null,     // 지금 신고 중인 문항
  _reportReason: null,   // 고른 사유 code
  _reportedIds: null,    // 이번 결과 화면에서 이미 신고한 문항 (중복 전송 방지)

  // isHistory 파라미터 추가, returnTo로 돌아갈 화면 지정 (기본값: mypage)
  async render(data, isHistory = false, returnTo = 'mypage') {
    this._reportedIds = new Set();
    this._reportSessionId = null;
    this._renderScore(data.score, data.title, data.subtitle);
    this._renderFeedbackList(data.items);
    this._bktApplied = null;   // 직전 문제의 갱신 promise가 남아있지 않도록 초기화

    // isHistory가 아닐 때(방금 막 푼 새 문제일 때)만 DB에 저장
    if (!isHistory && window.AppState.isLoggedIn && window.AppState.user) {
      const uid = window.AppState.user.uid;
      window.LearningService.saveSession(data).then(newId => {
        // 재도전이 아니라 새 문제였다면, 이 문제가 앞으로의 재도전들이 묶일 "원본"이 됨
        if (!window.AppState.session.isRetry) {
          window.AppState.session._rootSessionId = newId;
        }
        // 문항 신고에서 "어느 세션의 문항이었나"를 남기기 위해 기억해둔다
        this._reportSessionId = newId;
      }).catch(console.error);
      // 태그된 오개념 관측을 BKT로 반영해 이해도(knowledgeState) 갱신.
      // 🔑 "다시 풀어보기"(isRetry)는 정답을 이미 본 같은 문제라서 맞히는 게 당연하다.
      //    이걸 관측으로 세면 이해도가 부풀려져 승급이 실제 이해보다 빨리 나므로 제외한다.
      // 승급 판정(_handleLevelProgress)이 이 갱신 결과를 읽어야 하므로 promise를 남겨둔다.
      if (!window.AppState.session.isRetry) {
        const usedHint = (window.AppState.session.hintUsed || 0) > 0;
        this._bktApplied = window.LearningService
          .applyBktObservations(uid, data.items, usedHint)
          .catch(e => { console.error('이해도 갱신 실패:', e); });
      }
    }

    const nextBtn = document.getElementById('btn-feedback-next');
    if (!nextBtn) return;

    if (isHistory) {
      // 과거 기록 뷰: 다시 풀기 위해 필요한 데이터를 기억해둠 (retrySameHistory에서 사용)
      this._historyItems = data.items;
      this._historyUnit = data.unit || null;
      this._historyReturnTo = returnTo;
      this._historyRootId = data.rootId || null;
      this._historyHint1 = data.hint1 || null;   // 다시 풀기로 복원 시 힌트 되살리기
      this._historyHint2 = data.hint2 || null;

      this._setHistoryHeader(returnTo);
      nextBtn.style.display = 'none';
      this._renderHistoryActions(data.items, returnTo);
      return;
    }

    this._resetHeader();
    // 🆕 일반 학습 완료 뷰: 레벨 시스템 적용 (승급 처리 + 버튼 분기)
    await this._handleLevelProgress(data);
  },

  /* 과거 기록 뷰: 상단바를 "< 학습 현황/문제풀기" 형태의 back-btn으로 전환 */
  _setHistoryHeader(returnTo) {
    const backBtn = document.getElementById('feedback-back-btn');
    const backLabel = document.getElementById('feedback-back-label');
    const actions = document.getElementById('feedback-topbar-actions');
    if (!backBtn || !actions) return;

    backLabel.textContent = returnTo === 'quiz-library' ? '문제풀기' : '학습 현황';
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
     - 계산형 단일 문항(Level 2 방식B, Level 3): correctAnswer/unit/unitOptions가 로그에 저장되어
       있을 때만 가능. Level 3는 모범 풀이 단계(solutionSteps)까지 있어야 재현 가능
       (예전 기록엔 이 필드들이 없어서 여기서 자동으로 걸러짐 — 하위 호환) */
  _canRetryHistory(items) {
    if (!Array.isArray(items) || !items.length) return false;
    if (items.length > 1) return true;
    const it = items[0];
    const hasCalcData = it.correctAnswer !== undefined && !!it.unit && Array.isArray(it.unitOptions);
    if (!hasCalcData) return false;
    return it.isLevel3 ? Array.isArray(it.solutionSteps) : true;
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
    } else if (returnTo === 'mypage-detail' && typeof MypageScreen !== 'undefined' && MypageScreen._currentSubUnit) {
      // Router.go만으로는 화면만 바뀌고 데이터는 그대로라, 방금 다시 풀기로 바뀐 이력/차트가
      // 반영 안 됨 — goDetail을 다시 불러서 "나갔다 들어온 것"과 동일하게 새로고침
      MypageScreen.goDetail(MypageScreen._currentChapter, MypageScreen._currentSubUnit);
    }
  },

  /* "다시 풀기"(과거 기록 재도전) 결과 화면: 레벨/승급 정보 없이 맞았는지만 보여주고
     [돌아가기] / [새 문제 풀기] 두 개만 양옆으로 반반 제공 */
  _renderPostRetryActions() {
    const area = document.getElementById('level-progress-area');
    if (!area) return;

    const returnTo = this._historyReturnTo === 'quiz-library' ? 'quiz-library' : 'mypage-detail';
    const backLabel = returnTo === 'quiz-library' ? '문제풀기로 돌아가기' : '학습 현황으로 돌아가기';

    area.style.display = 'block';
    area.innerHTML = `
      <div style="display:flex;gap:10px;margin:0 20px 20px;">
        <button class="primary-btn" style="margin:0;flex:1;background:var(--surface2);color:var(--text1);box-shadow:none" onclick="FeedbackScreen._historyGoBack('${returnTo}')">
          ${backLabel}
        </button>
        <button class="primary-btn green-btn" style="margin:0;flex:1" onclick="FeedbackScreen.retrySimilar(this)">
          새 문제 풀기
        </button>
      </div>
    `;
  },

  /* 과거 기록 화면에서 "다시 풀기" — 그때 그 문제를 그대로 복원해서 다시 풀게 함
     (STEP1/2 방식은 5문장 전체를, 계산형은 문제·정답·단위를 복원).
     실제 라이브 세션의 retrySame()과 동일하게 isRetry=true로 표시되어, 다시 제출해도
     승급 카운터에는 반영되지 않음 (채점/저장 자체는 새로 일어남 — 라이브 재시도와 동일 동작) */
  async retrySameHistory() {
    const items = this._historyItems;
    if (!this._canRetryHistory(items)) return;

    AppState.session.detectedUnit = this._historyUnit || AppState.session.detectedUnit;
    AppState.session.checkedStatements = new Set();
    AppState.session.step2Answers = [];
    // 저장해둔 힌트 복원 (없으면 화면에서 기본 문구로 떨어짐 — 옛 기록엔 없을 수 있음)
    AppState.session.hint1 = this._historyHint1 || null;
    AppState.session.hint2 = this._historyHint2 || null;
    AppState.session.isRetry = true;
    // 채점 후 결과 화면을 "레벨/승급 없는 간단 버전"으로 보여주기 위한 표시
    AppState.session.isHistoryRetry = true;
    // 이 재도전이 저장될 때 원본 문제와 묶일 수 있도록 원본 id를 표시
    AppState.session._rootSessionId = this._historyRootId || null;
    // 과거 기록에는 세션이 다뤘던 원래 오개념 id 목록이 없음 — 직전 세션(다른 단원일 수 있음)의
    // misconceptions가 그대로 남아있으면 이 재시도가 엉뚱한 오개념을 다룬 것으로 잘못 저장되므로 비움
    AppState.session.misconceptions = [];
    // 문제 화면 상단 뒤로가기를 들어온 곳(마이페이지 상세 or 문제풀기 탭)으로 되돌아가게 함
    setQuizBackTarget(this._historyReturnTo === 'quiz-library' ? 'quiz-library' : 'mypage-detail');

    // 🔑 AppState.session.currentLevel/correctCount는 과거 기록을 열람하는 동안 다른 값으로
    // 남아있을 수 있음(직전 세션 잔재, 또는 애초에 기본값 1) — 재시도 화면에 "현재 Level"을
    // 잘못 표시하지 않도록 Firestore의 실제 진행 상태로 다시 맞춰줌
    if (window.AppState.isLoggedIn && window.AppState.user && AppState.session.detectedUnit) {
      try {
        const progress = await window.LearningService.getUnitProgress(
          window.AppState.user.uid, AppState.session.detectedUnit
        );
        AppState.session.currentLevel = progress.level || 1;
        AppState.session.correctCount = progress.correctCount || 0;
      } catch (e) {
        console.warn('진행 상태 조회 실패, 기존 값 유지:', e);
      }
    }

    if (items.length > 1) {
      // STEP1/2 방식 — 문장 5개 그대로 복원
      AppState.session.questions = items.map(it => ({ id: it.id, text: it.text, isWrong: it.isWrong }));
      AppState.session.calcQuestion = null;
    } else {
      // 계산형(Level 2 방식B, Level 3) — 문제·정답·단위 그대로 복원
      const it = items[0];
      AppState.session.questions = null;
      AppState.session.calcQuestion = {
        text: it.text,
        correctAnswer: it.correctAnswer,
        unit: it.unit,
        unitOptions: it.unitOptions,
        solutionSteps: it.solutionSteps || [],
        isLevel3: !!it.isLevel3,
      };
    }
    routeToQuizScreen();
  },

  /* 레벨 승급 카운터 처리 + 화면 분기 */
  async _handleLevelProgress(data) {
    const nextBtn = document.getElementById('btn-feedback-next');
    const session = window.AppState.session;

    // 마이페이지 과거 기록에서 "다시 풀기"로 재도전한 결과 — 승급/레벨 정보 없이 간단한 선택지만 제공
    if (session.isHistoryRetry) {
      if (nextBtn) nextBtn.style.display = 'none';
      this._renderPostRetryActions();
      return;
    }

    const isLoggedIn = window.AppState.isLoggedIn && window.AppState.user;
    const passScore = PROMOTION_SCORE[session.currentLevel] || 100;
    const isPassed = data.score >= passScore;
    const isNewProblem = !session.isRetry;

    let isPromoted = false;
    let promotedTo = null;
    // 판정에 실패했을 때 직전 문제의 값이 화면에 남지 않도록 먼저 비운다
    session.masteryProgress = null;

    // 승급 판정 (설계 4-10): 이번 문제의 이해도 갱신이 반영된 뒤, 현재 레벨의 대상 오개념이
    // 모두 숙달(P(L) ≥ 0.90)됐는지 확인한다. 점수 만점 여부와 무관 — 오답은 이미 이해도를
    // 떨어뜨리는 방식으로 반영돼 있다.
    if (isLoggedIn && session.detectedUnit && isNewProblem) {
      try {
        await this._bktApplied;   // 방금 푼 문제의 관측이 저장될 때까지 대기
        const uid = window.AppState.user.uid;
        const result = await window.LearningService.evaluatePromotion(
          uid, session.detectedUnit, session.currentLevel
        );
        session.masteryProgress = { mastered: result.mastered, total: result.total, ratio: result.ratio };

        // 오개념 데이터가 없는 소단원은 이해도로 판정할 대상이 없다(안전망).
        // 그런 소단원에서만 예전 누적 정답 방식으로 승급시킨다.
        const promote = result.total === 0
          ? await this._legacyPromotionCheck(uid, session, isPassed)
          : (result.isPromoted && !result.completed);

        if (promote) {
          isPromoted = true;
          if (session.currentLevel >= 3) {
            promotedTo = 'complete';
            await window.LearningService.setUnitLevel(uid, session.detectedUnit, 3, true);
          } else {
            promotedTo = session.currentLevel + 1;
            session.currentLevel = promotedTo;
            // 다음 난이도에서는 증거를 다시 모은다 (숙달했던 것도 unknown 0.30에서 재시작)
            await window.LearningService.resetKnowledgeForLevel(uid, result.ids);
            await window.LearningService.setUnitLevel(uid, session.detectedUnit, promotedTo);
            session.masteryProgress = null;
          }
        }
      } catch (e) {
        console.error('승급 판정 실패:', e);
      }
    }

    if (!nextBtn) return;

    if (isPromoted) {
      this._showPromotionBanner(promotedTo);
      nextBtn.style.display = 'none';
      this._renderPromotionActions(promotedTo);
    } else if (isLoggedIn) {
      nextBtn.style.display = 'none';
      this._renderCorrectionLoop(isPassed);
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

  /* [폴백] 오개념 데이터가 없는 소단원의 승급 판정 — 예전 방식(합격 점수 + 누적 정답 횟수).
     레벨별 목표는 예전 계산식의 하한값을 그대로 쓴다. */
  async _legacyPromotionCheck(uid, session, isPassed) {
    if (!isPassed) return false;
    const target = { 1: 10, 2: 7, 3: 5 }[session.currentLevel] || 10;
    const result = await window.LearningService.incrementCorrectCount(
      uid, session.detectedUnit, target
    );
    session.correctCount = result.count;
    session.masteryProgress = {
      mastered: result.count, total: target, legacy: true,
      ratio: Math.min(1, result.count / target),   // 폴백 경로는 누적 정답 비율이 곧 진행률
    };
    if (result.isPromoted) session.correctCount = 0;
    return result.isPromoted;
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
          ${isComplete ? '마이페이지에서 학습 이력을 확인할 수 있어요' : '이 단계에서 확인할 내용을 모두 이해했어요'}
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
  _renderCorrectionLoop(isPassed) {
    const area = document.getElementById('level-progress-area');
    if (!area) return;

    const level = window.AppState.session.currentLevel;
    // 승급까지 남은 정도를 진행률(%)로만 보여준다. 내부적으로는 "레벨 대상 오개념 중 숙달한 비율"
    // (설계 4-10)이지만, 학습자에게 오개념 개수를 노출하면 "몇 개짜리 단원인가"에 신경이 쏠려
    // 학습 자체보다 숫자를 좇게 된다. 화면에는 진행도만 남긴다.
    // 🔑 숙달한 개수(mastered/total)가 아니라 이해도가 임계값에 다가간 비율(ratio)을 쓴다.
    //    개수로 세면 만점을 4번 받아도 0%에 머문다(_masteryRatio 주석 참고).
    const mastery = window.AppState.session.masteryProgress;
    let percent = (mastery && mastery.total && typeof mastery.ratio === 'number')
      ? Math.round(mastery.ratio * 100)
      : null;
    // 🔑 100%인데 승급이 안 되면 학습자는 화면이 고장난 줄 안다. 임계값 바로 아래(0.899)에
    //    걸린 오개념이 있으면 반올림으로 100이 나올 수 있으므로 승급 전에는 99에서 막는다.
    if (percent === 100 && mastery.mastered < mastery.total) percent = 99;

    // 합격했으면 다시 풀어보기 버튼 숨김 (마이페이지에서만 재시도)
    const retryBtn = isPassed ? '' : `
      <button class="primary-btn" style="margin:0;flex:1;background:var(--surface2);color:var(--text1);box-shadow:none" onclick="FeedbackScreen.retrySame()">
        다시 풀어보기
      </button>
    `;

    const progressCard = percent === null ? `
      <div class="level-progress-card"><span class="lp-label">현재 Level ${level}</span></div>
    ` : `
      <div class="level-progress-card">
        <div class="lp-head">
          <span class="lp-label">Level ${level} 진행도</span>
          <strong class="lp-percent">${percent}%</strong>
        </div>
        <div class="lp-bar"><div class="lp-fill" style="width:${percent}%"></div></div>
      </div>
    `;

    area.style.display = 'block';
    area.innerHTML = `
      ${progressCard}
      <div style="display:flex;gap:10px;margin:0 20px 12px;">
        ${retryBtn}
        <button id="btn-next-problem" class="primary-btn" style="margin:0;flex:1" onclick="FeedbackScreen.retrySimilar(this)">
          다음 문제 풀기
        </button>
      </div>
      <div style="display:flex;justify-content:center;margin:0 20px 20px;">
        <button class="text-link-btn" onclick="FeedbackScreen.continueNext()">홈으로 나가기</button>
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
    routeToQuizScreen();
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

      const targets = await pickTargetMisconceptionIds(AppState.session.detectedUnit, level);

      const result = await ApiService.generateQuestions(
        AppState.session.misconceptions,
        AppState.session.detectedUnit,
        level,
        mode,
        targets
      );
      AppState.session.isRetry = false;
      AppState.session.isHistoryRetry = false;
      AppState.session.hint1 = result.hint1;
      AppState.session.hint2 = result.hint2;
      if (result.misconceptionCount) {
        AppState.session.misconceptionCount = result.misconceptionCount;
      }
      AppState.session.checkedStatements = new Set();
      AppState.session.step2Answers = [];
      applyQuizResult(result);
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
    this._lastItems = items;   // 문항 신고에서 id로 원본을 되찾는 데 쓴다

    /* 🔑 "채점에서 뺀 문항" 그룹은 없앴다 (단계 8-5). 참·거짓 라벨 검증을 문제를 만들 때로
       옮겼기 때문에, 어긋난 문장은 학생에게 도달하기 전에 걸러져 다시 만들어진다.
       예전에 저장된 세션에는 isVoided가 남아 있으므로 그것만 조용히 걸러낸다. */
    const valid = items.filter(i => !i.isVoided);

    // userReason이 있으면 체크한 것으로 판단
    const checkedItems = valid.filter(i => i.userReason !== undefined && i.userReason !== null);
    const missedItems  = valid.filter(i => (i.userReason === undefined || i.userReason === null) && i.isWrong);

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
            <span class="fb-stmt" style="text-decoration:line-through;color:var(--text3)">${escapeHtml(item.text)}</span>
          </div>
          <div class="fb-explanation">
            <div class="fb-exp-label user">📝 내 답변</div>
            <div class="fb-user-ans">${escapeHtml(item.userReason || '(입력 없음)')}</div>
            <div class="fb-exp-label ideal">✅ 피드백</div>
            <div class="fb-correct-ans">${escapeHtml(item.explanation)}</div>
          </div>
          ${this._reportBtn(item)}
        </div>`).join('');
    }

    // ── 그룹 2: 오개념은 찾았지만, 이유가 틀린 문장 ──
    if (halfItems.length) {
      html += `<div class="fb-section-title" style="margin-top:24px">이유가 틀린 문항</div>`;
      html += halfItems.map(item => `
        <div class="feedback-card">
          <div class="fb-card-header">
            <span class="fb-stmt">${escapeHtml(item.text)}</span>
          </div>
          <div class="fb-explanation">
            <div class="fb-exp-label user">📝 내 답변</div>
            <div class="fb-user-ans">${escapeHtml(item.userReason || '(입력 없음)')}</div>
            <div class="fb-exp-label ideal">💡 올바른 피드백</div>
            <div class="fb-correct-ans">${escapeHtml(item.explanation)}</div>
          </div>
          ${this._reportBtn(item)}
        </div>`).join('');
    }

    // ── 그룹 3: 올바른 문장인데 오개념으로 착각한 문장 ──
    if (wrongGuess.length) {
      html += `<div class="fb-section-title" style="margin-top:24px">오답 체크</div>`;
      html += wrongGuess.map(item => `
        <div class="feedback-card">
          <div class="fb-card-header">
            <span class="fb-stmt">${escapeHtml(item.text)}</span>
          </div>
          <div class="fb-explanation">
            <div class="fb-exp-label user">📝 내 답변</div>
            <div class="fb-user-ans">${escapeHtml(item.userReason || '(입력 없음)')}</div>
            <div class="fb-exp-label ideal">💡 올바른 피드백</div>
            <div class="fb-correct-ans">${escapeHtml(item.explanation)}</div>
          </div>
          ${this._reportBtn(item)}
        </div>`).join('');
    }

    // ── 그룹 4: 아예 놓쳐버린 오개념 ──
    if (missedItems.length) {
      html += `<div class="fb-section-title" style="margin-top:24px">선택하지 않은 정답 문항</div>`;
      html += missedItems.map(item => `
        <div class="feedback-card">
          <div class="fb-card-header">
            <span class="fb-stmt">${escapeHtml(item.text)}</span>
          </div>
          <div class="fb-explanation">
            <div class="fb-exp-label ideal">💡 틀린 이유</div>
            <div class="fb-correct-ans">${escapeHtml(item.explanation)}</div>
          </div>
          ${this._reportBtn(item)}
        </div>`).join('');
    }

    // 아무것도 없을 때 (퍼펙트 클리어)
    if (!checkedItems.length && !missedItems.length) {
      html = `<div style="text-align:center;padding:30px;color:var(--text3);font-size:14px">모든 문장을 정확히 판단했어요! 🎉</div>`;
    }

    container.innerHTML = html;
  },

  /* ────────────────────────────────────────
     문항 신고 (설계 단계 9-1)

     왜 필요한가 — 문장의 참·거짓은 생성 단계에서 독립 호출로 검증하지만(단계 8-5), 계산 문제·
     해설·서술형 채점은 여전히 AI가 혼자 판단한다. 그쪽에서 틀렸을 때 학생이 말할 곳이 없다.

     🔑 신고해도 점수와 이해도는 바뀌지 않는다. 신고가 관측을 지우게 만들면 "틀릴 때마다
        신고"가 최적 전략이 되어 이해도가 영원히 안 떨어진다. 모아서 사람이 보고 고친다.
  ──────────────────────────────────────── */

  _reportBtn(item) {
    // 비로그인은 저장할 uid가 없다. 버튼을 띄워놓고 눌렀을 때 막으면 더 나쁘므로 아예 안 보인다.
    if (!window.AppState?.isLoggedIn) return '';
    const done = this._reportedIds?.has(item.id);
    return `
      <button class="fb-report-btn${done ? ' done' : ''}"
              ${done ? 'disabled' : `onclick="FeedbackScreen.openReport(${item.id})"`}>
        ${done ? '접수됐어요' : '이 문항 이상해요 ⚑'}
      </button>`;
  },

  openReport(itemId) {
    const item = (this._lastItems || []).find(i => i.id === itemId);
    if (!item) return;
    this._reportItem = item;
    this._reportReason = null;

    const stmtEl = document.getElementById('report-stmt');
    if (stmtEl) stmtEl.textContent = item.text;

    const list = document.getElementById('report-reasons');
    if (list) {
      list.innerHTML = REPORT_REASONS.map(r => `
        <button class="report-reason" data-code="${r.code}"
                onclick="FeedbackScreen.pickReportReason('${r.code}')">${r.text}</button>
      `).join('');
    }
    const etcWrap = document.getElementById('report-etc-wrap');
    const etc = document.getElementById('report-etc');
    if (etcWrap) etcWrap.style.display = 'none';
    if (etc) etc.value = '';
    const submit = document.getElementById('report-submit');
    if (submit) { submit.disabled = true; submit.textContent = '보내기'; }

    Modal.open('report-modal');
  },

  pickReportReason(code) {
    this._reportReason = code;
    document.querySelectorAll('#report-reasons .report-reason').forEach(b => {
      b.classList.toggle('selected', b.dataset.code === code);
    });
    const isEtc = code === 'etc';
    const wrap = document.getElementById('report-etc-wrap');
    if (wrap) wrap.style.display = isEtc ? '' : 'none';
    if (isEtc) document.getElementById('report-etc')?.focus();
    // 기타는 뭐라도 적어야 보낼 수 있다. 빈 '기타'는 아무 정보도 주지 않는다.
    this._syncReportSubmit();
  },

  _syncReportSubmit() {
    const submit = document.getElementById('report-submit');
    if (!submit) return;
    const etc = document.getElementById('report-etc');
    const needsText = this._reportReason === 'etc';
    submit.disabled = !this._reportReason || (needsText && !etc?.value.trim());
  },

  async submitReport() {
    const item = this._reportItem;
    if (!item || !this._reportReason) return;
    const submit = document.getElementById('report-submit');
    if (submit) { submit.disabled = true; submit.textContent = '보내는 중...'; }

    const detail = this._reportReason === 'etc'
      ? (document.getElementById('report-etc')?.value || '').trim().slice(0, 300)
      : '';

    try {
      await window.LearningService.submitQuestionReport({
        item,
        reason: this._reportReason,
        detail,
        unit: window.AppState.session.detectedUnit || null,
        level: window.AppState.session.currentLevel || null,
        sessionId: this._reportSessionId || null,
      });
      this._reportedIds.add(item.id);
      Modal.close('report-modal');
      Toast.show('접수됐어요. 확인해볼게요');
      // 버튼만 '접수됨'으로 바꾼다. 목록을 다시 그리면 스크롤 위치가 튄다.
      const btn = document.querySelector(`.fb-report-btn[onclick*="openReport(${item.id})"]`);
      if (btn) { btn.classList.add('done'); btn.disabled = true; btn.removeAttribute('onclick'); btn.textContent = '접수됐어요'; }
    } catch (e) {
      console.error('문항 신고 실패:', e);
      Toast.show('전송에 실패했어요. 잠시 후 다시 시도해주세요');
      if (submit) { submit.disabled = false; submit.textContent = '보내기'; }
    }
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
      isHistoryRetry: false,
      _rootSessionId: null,
      _quizBackTarget: null,
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