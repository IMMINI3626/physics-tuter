/* ============================================================
   PhysiClinic — App Router & Global State
   ============================================================ */

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
  },

  // 비로그인 시 문제 풀이 횟수
  guestCount: parseInt(localStorage.getItem('pc_guest_count') || '0'),
  GUEST_LIMIT: 3,
};

/* ────────────────────────────────────────
   Router
──────────────────────────────────────── */
const Router = {
  current: 'home',

  // 화면 ID → nav 아이템 ID 매핑
  navMap: {
    home:     'nav-home',
    keyword:  'nav-quiz',
    step1:    'nav-quiz',
    step2:    'nav-quiz',
    feedback: 'nav-quiz',
    mypage:   'nav-mypage',
  },

  go(screenId) {
    const prev = document.getElementById(`screen-${this.current}`);
    const next = document.getElementById(`screen-${screenId}`);
    if (!next) return console.warn(`Screen not found: ${screenId}`);

    if (prev) prev.classList.remove('active');
    next.classList.remove('active');   // reset animation
    void next.offsetWidth;             // reflow trick
    next.classList.add('active');

    this.current = screenId;
    window.scrollTo(0, 0);
    this._updateNav(screenId);
  },

  _updateNav(screenId) {
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    const navId = this.navMap[screenId];
    if (navId) document.getElementById(navId)?.classList.add('active');
  },
};

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
    if (!bar) return;
    if (AppState.isLoggedIn) {
      bar.style.display = 'none';
      return;
    }
    const remaining = AppState.GUEST_LIMIT - AppState.guestCount;
    bar.querySelector('#guest-count-text').textContent =
      `남은 무료 문제: ${Math.max(0, remaining)}회`;
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
