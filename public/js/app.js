/* ============================================================
   PhysiClinic — App Router & Global State
   ============================================================ */

/* ────────────────────────────────────────
   소단원 ↔ 대단원 매핑 (레벨 시스템용)
──────────────────────────────────────── */
const UNIT_MAP = {
  '힘과 운동': {
    chapterId: '1',
    subUnits: ['물체의 운동', '뉴턴 운동 법칙', '운동량과 충격량']
  },
  '에너지': {
    chapterId: '2',
    subUnits: ['역학적 에너지 보존', '열역학 법칙', '특수 상대성 이론']
  },
  '전기와 자기': {
    chapterId: '3',
    subUnits: ['원자 모형과 전기력', '에너지 띠와 반도체', '전류의 자기 작용', '전자기 유도']
  },
  '파동': {
    chapterId: '4',
    subUnits: ['파동의 진동과 굴절', '파동의 간섭', '빛의 이중성', '물질의 이중성']
  },
};

// 소단원명 → 대단원명 찾기
function getChapter(unitName) {
  for (const [chapter, data] of Object.entries(UNIT_MAP)) {
    if (data.subUnits.includes(unitName)) return chapter;
  }
  return null;
}

/* ────────────────────────────────────────
   Global App State
──────────────────────────────────────── */
const AppState = {
  // 현재 로그인 상태
  isLoggedIn: false,
  user: null,

  // 현재 세션 데이터
  session: {
    uploadedImageBase64: null,
    extractedKeywords: [],
    detectedUnit: null,
    misconceptions: [],
    questions: [],           // 생성된 5개 문장
    checkedStatements: new Set(),
    step2Answers: [],        // [{ reason, correctLaw }]
    hintUsed: 0,
    score: null,
    feedbackData: null,

    // 🆕 레벨 시스템
    currentLevel: 1,         // 현재 풀고 있는 레벨 (1/2/3)
    correctCount: 0,         // 같은 소단원 내 누적 정답 수
    misconceptionCount: 0,   // 현재 소단원의 오개념 총 개수 (승급 목표치 계산용)
    isRetry: false,          // 다시 풀어보기(같은 문제 재시도) 여부 — true면 카운터 증가 안 함
    hint1: null,             // 문제 세트 전체에 대한 1차 힌트
    hint2: null,             // 문제 세트 전체에 대한 2차 힌트
    quizMode: null,          // Level 2 출제 방식: 'A'(STEP1/2 혼합) | 'B'(계산 단답형)
    calcQuestion: null,      // Level 2 Mode B 계산 문제 객체
  },

  // 비로그인 시 문제 풀이 횟수
  guestCount: parseInt(localStorage.getItem('pc_guest_count') || '0'),
  GUEST_LIMIT: 3,

  // Level 2 모드 연속 횟수 추적 (localStorage로 새로고침에도 유지)
  _lastQuizMode: localStorage.getItem('pc_last_quiz_mode') || null,
  _consecutiveModeCount: parseInt(localStorage.getItem('pc_consecutive_mode_count') || '0'),
};

// Level 2 출제 시 A/B 모드를 랜덤으로 고르되, 같은 모드가 2회 연속이면 강제 전환.
// 새 문제를 요청하는 모든 호출 지점(keyword.js 최초 출제, feedback.js 다음 문제 풀기 등)이
// 이 함수 하나만 공유해서 써야 A/B anti-repeat 로직이 어긋나지 않는다.
function pickQuizMode(level) {
  if (level !== 2) return null;
  const last = AppState._lastQuizMode;
  const count = AppState._consecutiveModeCount;
  const mode = (count >= 2 && last)
    ? (last === 'A' ? 'B' : 'A')
    : (Math.random() < 0.5 ? 'A' : 'B');
  AppState._consecutiveModeCount = (mode === last) ? count + 1 : 1;
  AppState._lastQuizMode = mode;
  localStorage.setItem('pc_last_quiz_mode', mode);
  localStorage.setItem('pc_consecutive_mode_count', AppState._consecutiveModeCount);
  return mode;
}

/* ────────────────────────────────────────
   Router
──────────────────────────────────────── */
const Router = {
  current: 'home',

  

  // 화면 ID → nav 아이템 ID 매핑
  navMap: {
    home:     'nav-home',
    keyword:  'nav-quiz',
    calc:     'nav-quiz',
    level3:   'nav-quiz',
    step1:    'nav-quiz',
    step2:    'nav-quiz',
    feedback: 'nav-quiz',
    mypage:   'nav-mypage',
    'mypage-detail': 'nav-mypage',
  },

  // 🔑 quiz-library는 여기 넣지 말 것 — 이 화면은 비로그인 전용 안내 배너(#library-login-banner)를
  // 갖고 있어서 게스트도 볼 수 있는 게 원래 설계다. authRequired에 넣으면 로그인 모달만 뜨고
  // 그 배너 분기가 영원히 실행되지 않는 죽은 코드가 된다.
  authRequired: ['mypage', 'mypage-detail'],

  /* 화면 전환 성공 여부를 반환 — 호출부에서 "전환에 성공했을 때만 init()" 하도록 판단할 수 있게 함.
     (예전엔 반환값이 없어서 nav가 Router.go()로 막힌 뒤에도 init()을 그대로 실행했음) */
  go(screenId) {
    if (this.authRequired.includes(screenId) && !AppState.isLoggedIn) {
      Toast.show('로그인 후 이용할 수 있어요');
      Modal.open('login-modal');
      return false;
    }
    const prev = document.getElementById(`screen-${this.current}`);
    const next = document.getElementById(`screen-${screenId}`);
    if (!next) {
      console.warn(`Screen not found: ${screenId}`);
      return false;
    }

    if (prev) prev.classList.remove('active');
    next.classList.remove('active');   // reset animation
    void next.offsetWidth;             // reflow trick
    next.classList.add('active');

    this.current = screenId;
    window.scrollTo(0, 0);
    this._updateNav(screenId);
    return true;
  },

  _updateNav(screenId) {
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    const navId = this.navMap[screenId];
    if (navId) document.getElementById(navId)?.classList.add('active');
  },
};

/* ────────────────────────────────────────
   Quiz 화면(step1/calc/level3)의 상단 "< 뒤로가기" 목적지
   기본은 keyword("분석 결과")지만, 마이페이지 소단원 상세에서 문제를 새로 풀거나
   과거 기록을 다시 풀 때는 mypage-detail("학습 현황")로, 문제풀기 탭 기록에서 다시 풀 때는
   quiz-library("문제풀기")로 돌아가야 함
──────────────────────────────────────── */
const QUIZ_BACK_LABELS = {
  'mypage-detail': '학습 현황',
  'quiz-library':  '문제풀기',
};

function setQuizBackTarget(target) {
  AppState.session._quizBackTarget = target;
  const label = QUIZ_BACK_LABELS[target] || '분석 결과';
  ['step1-back-label', 'calc-back-label', 'l3-back-label'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.textContent = label;
  });
}

function quizGoBack() {
  const target = AppState.session._quizBackTarget;
  if (target === 'quiz-library') {
    Router.go('quiz-library');
    window.QuizLibraryScreen?.init();
    return;
  }
  Router.go(target === 'mypage-detail' ? 'mypage-detail' : 'keyword');
}

/* ────────────────────────────────────────
   문제 화면(step1/calc/level3) 라우팅 — 공용 함수
   "어느 화면으로 보낼지" 판단 로직이 여러 곳에 흩어져 있으면 나중에 화면이 하나
   늘어나거나 조건이 바뀔 때 한 곳을 빠뜨리기 쉬워서, 문제를 새로 보여줘야 하는
   모든 지점(최초 출제, 다음 문제 풀기, 다시 풀어보기, 이어서 풀기, 과거 기록 다시 풀기)이
   이 두 함수만 공유해서 쓴다.
──────────────────────────────────────── */

/* AppState.session.calcQuestion/questions가 이미 세팅되어 있다는 전제로,
   그 내용에 맞는 문제 화면으로 이동만 시킴 */
function routeToQuizScreen() {
  const { calcQuestion, questions } = AppState.session;
  if (calcQuestion) {
    if (calcQuestion.isLevel3) {
      Level3Screen.init(calcQuestion);
      Router.go('level3');
    } else {
      QuizScreen.initCalc(calcQuestion);
      Router.go('calc');
    }
  } else {
    QuizScreen.init(questions);
    Router.go('step1');
  }
}

/* generateQuestions API 응답(result)을 세션에 반영한 뒤 알맞은 문제 화면으로 이동 */
function applyQuizResult(result) {
  if (result.calcQuestion) {
    AppState.session.calcQuestion = result.calcQuestion;
    AppState.session.questions = null;
  } else {
    AppState.session.calcQuestion = null;
    AppState.session.questions = result.questions;
  }
  routeToQuizScreen();
}

/* ────────────────────────────────────────
   Toast
──────────────────────────────────────── */
const Toast = {
  _timer: null,

  show(msg, duration = 2600) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(this._timer);
    this._timer = setTimeout(() => el.classList.remove('show'), duration);
  },
};

/* ────────────────────────────────────────
   Modal
──────────────────────────────────────── */
const Modal = {
  open(id) {
    document.getElementById(id)?.classList.add('open');
    document.dispatchEvent(new CustomEvent('modal:open', { detail: { id } }));
  },
  close(id) {
    document.getElementById(id)?.classList.remove('open');
  },
};

/* ────────────────────────────────────────
   Guest Limit Helper
──────────────────────────────────────── */
const GuestGuard = {
  increment() {
    AppState.guestCount++;
    localStorage.setItem('pc_guest_count', AppState.guestCount);
    this._updateUI();
  },

  isLimitReached() {
    return !AppState.isLoggedIn && AppState.guestCount >= AppState.GUEST_LIMIT;
  },

  _updateUI() {
    const bar = document.getElementById('guest-bar');
    if (bar) {
      if (AppState.isLoggedIn) {
        bar.style.display = 'none';
      } else {
        const remaining = AppState.GUEST_LIMIT - AppState.guestCount;
        bar.querySelector('#guest-count-text').textContent =
          `남은 무료 문제: ${Math.max(0, remaining)}회`;
      }
    }
  },
};

/* ────────────────────────────────────────
   Init
──────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  // 모달 외부 클릭 시 닫기
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) Modal.close(overlay.id);
    });
  });

  // 초기 guest bar 상태
  GuestGuard._updateUI();

  console.log('PhysiClinic initialized');
});

window.AppState   = AppState;
window.Router     = Router;
window.Toast      = Toast;
window.Modal      = Modal;
window.GuestGuard = GuestGuard;
window.UNIT_MAP    = UNIT_MAP;
window.getChapter  = getChapter;
