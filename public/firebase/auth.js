import {
  GoogleAuthProvider,
  signInWithPopup,
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { auth } from './config.js';

const AuthService = {
  async loginWithGoogle() {
    const provider = new GoogleAuthProvider();
    try {
      const result = await signInWithPopup(auth, provider);
      return result.user;
    } catch (err) {
      console.error('Google login error:', err);
      throw err;
    }
  },

  async loginWithEmail(email, password) {
    try {
      const result = await signInWithEmailAndPassword(auth, email, password);
      return result.user;
    } catch (err) {
      console.error('Email login error:', err);
      throw err;
    }
  },

  async signUpWithEmail(email, password) {
    try {
      const result = await createUserWithEmailAndPassword(auth, email, password);
      return result.user;
    } catch (err) {
      console.error('Sign up error:', err);
      throw err;
    }
  },

  async logout() {
    await signOut(auth);
    window.AppState.isLoggedIn = false;
    window.AppState.user = null;
    window.Toast.show('로그아웃 되었어요');
    window.Router.go('home');
    this._onLogout();
  },

  watchAuthState() {
    onAuthStateChanged(auth, (user) => {
      if (user) {
        window.AppState.isLoggedIn = true;
        window.AppState.user = {
          uid:         user.uid,
          displayName: user.displayName || '사용자',
          email:       user.email,
          photoURL:    user.photoURL,
        };
        this._onLogin(window.AppState.user);
      } else {
        window.AppState.isLoggedIn = false;
        window.AppState.user = null;
        this._onLogout();
      }
    });
  },

  _onLogin(user) {
    // 마이페이지 프로필 업데이트
    const avatarEl = document.getElementById('mp-avatar');
    const nameEl   = document.getElementById('mp-name');
    const emailEl  = document.getElementById('mp-email');
    if (avatarEl) avatarEl.textContent = (user.displayName || '?')[0].toUpperCase();
    if (nameEl)   nameEl.textContent   = user.displayName || '사용자';
    if (emailEl)  emailEl.textContent  = user.email || '';

    // 🔑 상단 버튼들(화면마다 따로 존재) → 전부 로그인된 아바타로 교체
    const loginBtns = document.querySelectorAll('.login-icon-btn');
    loginBtns.forEach(loginBtn => {
      loginBtn.onclick = () => AuthService.logout();
      loginBtn.setAttribute('aria-label', '로그아웃');
      loginBtn.innerHTML = `
        <div style="width:22px;height:22px;border-radius:50%;background:var(--accent);
          color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;
          justify-content:center;">
          ${(user.displayName || '?')[0].toUpperCase()}
        </div>`;
    });

    document.getElementById('guest-bar')?.style.setProperty('display', 'none');
    window.Modal.close('login-modal');
  },

  _onLogout() {
    document.getElementById('guest-bar')?.style.removeProperty('display');

    // 🔑 마이페이지 프로필/통계 초기화 (같은 기기를 쓰는 다음 사람에게 이전 로그인 정보가 남지 않도록)
    const avatarEl = document.getElementById('mp-avatar');
    const nameEl   = document.getElementById('mp-name');
    const emailEl  = document.getElementById('mp-email');
    if (avatarEl) avatarEl.textContent = '?';
    if (nameEl)   nameEl.textContent   = '로그인 필요';
    if (emailEl)  emailEl.textContent  = '로그인 후 이용해주세요';
    ['mp-total', 'mp-avgscore'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = '—';
    });
    const weakList = document.getElementById('weak-list');
    if (weakList) weakList.innerHTML = '';

    // 🔑 상단 버튼들 → 전부 로그인 아이콘으로 복원
    const loginBtns = document.querySelectorAll('.login-icon-btn');
    loginBtns.forEach(loginBtn => {
      loginBtn.onclick = () => window.Modal.open('login-modal');
      loginBtn.setAttribute('aria-label', '로그인');
      loginBtn.innerHTML = `
        <svg viewBox="0 0 24 24" style="width:17px;height:17px;fill:none;stroke:var(--text2);stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;">
          <circle cx="12" cy="8" r="4"/>
          <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
        </svg>`;
    });
  },
};

// 글로벌 노출
window.AuthService = AuthService;

/* ── 이메일 로그인/회원가입 폼 상태 ── */
let emailMode = 'login'; // 'login' | 'signup'

function updateEmailModeUI() {
  const title      = document.getElementById('login-email-title');
  const desc       = document.getElementById('login-email-desc');
  const submitBtn  = document.getElementById('btn-email-submit');
  const toggleBtn  = document.getElementById('btn-email-toggle-mode');
  if (emailMode === 'signup') {
    if (title)     title.textContent      = '이메일로 회원가입';
    if (desc)      desc.textContent       = '사용하실 이메일과 비밀번호를 입력해주세요.';
    if (submitBtn) submitBtn.textContent  = '회원가입';
    if (toggleBtn) toggleBtn.textContent  = '이미 계정이 있으신가요? 로그인';
  } else {
    if (title)     title.textContent      = '이메일로 로그인';
    if (desc)      desc.textContent       = '가입하신 이메일과 비밀번호를 입력해주세요.';
    if (submitBtn) submitBtn.textContent  = '로그인';
    if (toggleBtn) toggleBtn.textContent  = '계정이 없으신가요? 회원가입';
  }
}

function showEmailError(msg) {
  const errEl = document.getElementById('login-email-error');
  if (!errEl) return;
  errEl.textContent = msg;
  errEl.style.display = 'block';
}

function hideEmailError() {
  const errEl = document.getElementById('login-email-error');
  if (!errEl) return;
  errEl.style.display = 'none';
  errEl.textContent = '';
}

function resetEmailForm() {
  const mainEl  = document.getElementById('login-modal-main');
  const emailEl = document.getElementById('login-modal-email');
  if (mainEl)  mainEl.style.display  = '';
  if (emailEl) emailEl.style.display = 'none';
  const emailInput = document.getElementById('login-email-input');
  const pwInput    = document.getElementById('login-password-input');
  if (emailInput) emailInput.value = '';
  if (pwInput)    pwInput.value    = '';
  hideEmailError();
  emailMode = 'login';
  updateEmailModeUI();
}

function mapAuthError(err) {
  switch (err?.code) {
    case 'auth/invalid-email':      return '올바른 이메일 형식이 아니에요.';
    case 'auth/missing-password':   return '비밀번호를 입력해주세요.';
    case 'auth/weak-password':      return '비밀번호는 6자 이상이어야 해요.';
    case 'auth/email-already-in-use': return '이미 가입된 이메일이에요. 로그인을 시도해보세요.';
    case 'auth/user-not-found':
    case 'auth/wrong-password':
    case 'auth/invalid-credential': return '이메일 또는 비밀번호가 올바르지 않아요.';
    case 'auth/too-many-requests':  return '너무 많이 시도했어요. 잠시 후 다시 시도해주세요.';
    default:                        return '처리 중 문제가 생겼어요. 다시 시도해주세요.';
  }
}

document.addEventListener('DOMContentLoaded', () => {
  AuthService.watchAuthState();

  document.getElementById('btn-login-google')?.addEventListener('click', async () => {
    try {
      await AuthService.loginWithGoogle();
      window.Toast.show('로그인 성공!');
    } catch (e) {
      window.Toast.show('로그인에 실패했어요. 다시 시도해주세요.');
    }
  });

  // 모달이 열릴 때마다 이메일 폼을 초기 상태(첫 화면)로 되돌림
  document.addEventListener('modal:open', (e) => {
    if (e.detail?.id === 'login-modal') resetEmailForm();
  });

  document.getElementById('btn-login-email')?.addEventListener('click', () => {
    document.getElementById('login-modal-main').style.display  = 'none';
    document.getElementById('login-modal-email').style.display = 'block';
    document.getElementById('login-email-input')?.focus();
  });

  document.getElementById('btn-email-back')?.addEventListener('click', () => {
    resetEmailForm();
  });

  document.getElementById('btn-email-toggle-mode')?.addEventListener('click', () => {
    emailMode = emailMode === 'login' ? 'signup' : 'login';
    hideEmailError();
    updateEmailModeUI();
  });

  document.getElementById('btn-email-submit')?.addEventListener('click', async () => {
    const email    = document.getElementById('login-email-input')?.value.trim();
    const password = document.getElementById('login-password-input')?.value || '';
    hideEmailError();

    if (!email || !password) {
      showEmailError('이메일과 비밀번호를 모두 입력해주세요.');
      return;
    }

    const btn = document.getElementById('btn-email-submit');
    if (btn) btn.disabled = true;
    try {
      if (emailMode === 'signup') {
        await AuthService.signUpWithEmail(email, password);
        window.Toast.show('회원가입 완료! 바로 로그인됐어요.');
      } else {
        await AuthService.loginWithEmail(email, password);
        window.Toast.show('로그인 성공!');
      }
      // 성공 시 _onLogin()이 모달을 닫음(watchAuthState 콜백)
    } catch (e) {
      showEmailError(mapAuthError(e));
    } finally {
      if (btn) btn.disabled = false;
    }
  });

  document.getElementById('login-password-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('btn-email-submit')?.click();
  });

  document.getElementById('btn-logout')?.addEventListener('click', () => {
    AuthService.logout();
  });
});

export { AuthService };
