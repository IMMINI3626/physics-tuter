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

    // 🔑 상단 버튼 → 로그인된 아바타로 교체
    const loginBtn = document.getElementById('btn-open-login');
    if (loginBtn) {
      loginBtn.onclick = () => AuthService.logout();
      loginBtn.setAttribute('aria-label', '로그아웃');
      loginBtn.innerHTML = `
        <div style="width:22px;height:22px;border-radius:50%;background:var(--accent);
          color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;
          justify-content:center;">
          ${(user.displayName || '?')[0].toUpperCase()}
        </div>`;
    }

    document.getElementById('guest-bar')?.style.setProperty('display', 'none');
    window.Modal.close('login-modal');
    window.GuestGuard._updateUI();
  },

  _onLogout() {
    document.getElementById('guest-bar')?.style.removeProperty('display');

    // 🔑 상단 버튼 → 로그인 아이콘으로 복원
    const loginBtn = document.getElementById('btn-open-login');
    if (loginBtn) {
      loginBtn.onclick = () => window.Modal.open('login-modal');
      loginBtn.setAttribute('aria-label', '로그인');
      loginBtn.innerHTML = `
        <svg viewBox="0 0 24 24" style="width:17px;height:17px;fill:none;stroke:var(--text2);stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round;">
          <circle cx="12" cy="8" r="4"/>
          <path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/>
        </svg>`;
    }
  },
};

// 글로벌 노출
window.AuthService = AuthService;

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

  document.getElementById('btn-login-email')?.addEventListener('click', () => {
    window.Toast.show('이메일 로그인은 준비 중이에요');
  });

  document.getElementById('btn-logout')?.addEventListener('click', () => {
    AuthService.logout();
  });
});

export { AuthService };
