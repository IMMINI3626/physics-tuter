const HomeScreen = {
  init() {
    this._bindUploadZone();
    this._bindUploadButtons();
    this._renderRecentList();
    GuestGuard._updateUI();
  },

  _bindUploadZone() {
    const zone = document.getElementById('upload-zone');
    if (!zone) return;
    zone.addEventListener('click', () => {
      if (this._checkGuestLimit()) return;
      this._openFilePicker();
    });
  },

  _bindUploadButtons() {
    document.getElementById('btn-camera')?.addEventListener('click', e => {
      e.stopPropagation();
      if (this._checkGuestLimit()) return;
      this._openCamera();
    });
    document.getElementById('btn-gallery')?.addEventListener('click', e => {
      e.stopPropagation();
      if (this._checkGuestLimit()) return;
      this._openFilePicker();
    });
  },

  /* 게스트 제한 체크: 도달 시 안내 + 모달, true 반환 시 상위 동작 중단 */
  _checkGuestLimit() {
    if (GuestGuard.isLimitReached()) {
      Toast.show('무료 체험 3회를 모두 사용했어요. 로그인하고 계속 학습해보세요!');
      Modal.open('login-modal');
      return true;
    }
    return false;
  },

  _openFilePicker() {
    document.getElementById('file-input')?.click();
  },

  _openCamera() {
    document.getElementById('camera-input')?.click();
  },

  handleFileSelect(file) {
    // 🔒 2차 방어: 파일 선택창까지 열린 뒤에도 한 번 더 체크
    if (this._checkGuestLimit()) return;

    if (!file || !file.type.startsWith('image/')) {
      Toast.show('이미지 파일을 선택해주세요');
      return;
    }

    // 🔑 비로그인 사용자는 여기서 카운트 증가 (업로드 시점 = 1회 소모)
    if (!AppState.isLoggedIn) {
      GuestGuard.increment();
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      AppState.session.uploadedImageBase64 = e.target.result;
      KeywordScreen.start(e.target.result);
    };
    reader.readAsDataURL(file);
  },

  // 🔑 Firestore 연동 + 더미 폴백
  async _renderRecentList() {
    const list = document.getElementById('recent-list');
    if (!list) return;

    let sessions = [];

    if (AppState.isLoggedIn && AppState.user) {
      try {
        sessions = await LearningService.fetchRecentSessions(AppState.user.uid, 5);
      } catch (e) {
        console.warn('Firestore 조회 실패:', e);
      }
    }

    if (!sessions.length) {
      list.innerHTML = `
        <div style="text-align:center;padding:32px 20px;color:var(--text3);font-size:13px">
          📚 아직 학습 기록이 없어요.<br>사진을 업로드해서 첫 학습을 시작해보세요!
        </div>`;
      return;
    }

    const icons = ['⚡','🔭','🌊','🔥','🧲'];
    const colors = ['blue','purple','green','blue','purple'];
    list.innerHTML = sessions.map((item, i) => {
      const score = item.score ?? 0;
      const badgeClass = score >= 80 ? 'badge-green' : score >= 60 ? 'badge-amber' : 'badge-red';
      const dateStr = item.createdAt?.toDate
        ? item.createdAt.toDate().toLocaleDateString('ko-KR') : '';
      return `
        <div class="recent-card">
          <div class="recent-icon ${colors[i % colors.length]}">${icons[i % icons.length]}</div>
          <div class="recent-info">
            <div class="recent-unit">${item.unit}</div>
            <div class="recent-meta">${dateStr} · 5문제</div>
          </div>
          <span class="badge ${badgeClass}">${score}점</span>
        </div>`;
    }).join('');
  },


  goToSession(unit) {
    Toast.show(`"${unit}" 다시 학습하기`);
  },
};

document.addEventListener('DOMContentLoaded', () => {
  HomeScreen.init();

  document.getElementById('file-input')?.addEventListener('change', function () {
    if (this.files[0]) HomeScreen.handleFileSelect(this.files[0]);
    this.value = '';
  });
  document.getElementById('camera-input')?.addEventListener('change', function () {
    if (this.files[0]) HomeScreen.handleFileSelect(this.files[0]);
    this.value = '';
  });
});
