const MypageScreen = {
  async init() {
    if (!AppState.isLoggedIn || !AppState.user) {
      document.getElementById('mypage-login-required')?.style.setProperty('display', 'block');
      document.getElementById('mypage-content')?.style.setProperty('display', 'none');
      return;
    }

    document.getElementById('mypage-login-required')?.style.setProperty('display', 'none');
    document.getElementById('mypage-content')?.style.setProperty('display', 'block');

    try {
      const [stats, weakList] = await Promise.all([
        LearningService.fetchStats(AppState.user.uid),
        LearningService.fetchWeakMisconceptions(AppState.user.uid),
      ]);
      this._renderStats(stats);
      this._renderWeak(weakList);
    } catch (e) {
      console.error('마이페이지 로드 실패:', e);
      Toast.show('데이터를 불러오지 못했어요');
    }
  },

  _renderStats(stats) {
    const el = (id) => document.getElementById(id);
    if (el('mp-total'))    el('mp-total').textContent    = stats.total;
    if (el('mp-avgscore')) el('mp-avgscore').textContent = stats.avgScore;
    if (el('mp-corrected'))el('mp-corrected').textContent = stats.correctedMisconceptions;
  },

  _renderWeak(list) {
    const container = document.getElementById('weak-list');
    if (!container) return;

    if (!list.length) {
      container.innerHTML = '<p style="font-size:13px;color:var(--text3);padding:8px 0">아직 학습 데이터가 없어요</p>';
      return;
    }

    const colors = ['#ef4444','#f97316','#eab308','#22c55e','#3b82f6'];
    container.innerHTML = list.map((item, i) => `
      <div class="weak-row">
        <span class="weak-name">${item.name}</span>
        <div class="weak-track">
          <div class="weak-fill" style="width:${item.pct}%;background:${colors[i % colors.length]}"></div>
        </div>
        <span class="weak-pct">${item.pct}%</span>
      </div>
    `).join('');
  },
};
