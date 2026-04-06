const HomeScreen = {
  init() {
    this._bindUploadZone();
    this._bindUploadButtons();
    this._renderRecentList();
  },

  _bindUploadZone() {
    const zone = document.getElementById('upload-zone');
    if (!zone) return;
    zone.addEventListener('click', () => this._openFilePicker());
  },

  _bindUploadButtons() {
    document.getElementById('btn-camera')?.addEventListener('click', e => {
      e.stopPropagation();
      this._openCamera();
    });
    document.getElementById('btn-gallery')?.addEventListener('click', e => {
      e.stopPropagation();
      this._openFilePicker();
    });
  },

  _openFilePicker() {
    document.getElementById('file-input')?.click();
  },

  _openCamera() {
    document.getElementById('camera-input')?.click();
  },

  handleFileSelect(file) {
    if (!file || !file.type.startsWith('image/')) {
      Toast.show('이미지 파일을 선택해주세요');
      return;
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

    const iconColors = ['blue', 'purple', 'green', 'blue', 'purple'];
    const icons = ['⚡', '🔭', '🌊', '🔥', '🧲'];

    let sessions = [];

    if (AppState.isLoggedIn && AppState.user) {
      try {
        sessions = await LearningService.fetchRecentSessions(AppState.user.uid, 5);
      } catch (e) {
        console.warn('Firestore 조회 실패, 더미 데이터 사용:', e);
      }
    }

    // 비로그인 또는 데이터 없으면 더미
    if (!sessions.length) {
      sessions = [
        { unit: '뉴턴의 운동 법칙', createdAt: null, score: 87 },
        { unit: '관성과 외력',      createdAt: null, score: 62 },
        { unit: '파동과 에너지',    createdAt: null, score: 94 },
      ];
    }

    list.innerHTML = sessions.map((item, i) => {
      const dateStr = item.createdAt?.toDate
        ? item.createdAt.toDate().toLocaleDateString('ko-KR')
        : '최근';
      const score = item.score ?? 0;
      const badgeClass = score >= 80 ? 'badge-green' : score >= 60 ? 'badge-amber' : 'badge-red';

      return `
        <div class="recent-card" onclick="HomeScreen.goToSession('${item.unit}')">
          <div class="recent-icon ${iconColors[i % iconColors.length]}">${icons[i % icons.length]}</div>
          <div class="recent-info">
            <div class="recent-unit">${item.unit}</div>
            <div class="recent-meta">${dateStr} · 5문제</div>
          </div>
          <span class="badge ${badgeClass}">${score}%</span>
        </div>
      `;
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
  });
  document.getElementById('camera-input')?.addEventListener('change', function () {
    if (this.files[0]) HomeScreen.handleFileSelect(this.files[0]);
  });
});
