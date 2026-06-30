/* ============================================================
   PhysiClinic — Quiz Library Screen Logic (문제풀기 탭)
   ============================================================ */

const QuizLibraryScreen = {
  async init() {
    const banner = document.getElementById('library-login-banner');

    if (!AppState.isLoggedIn || !AppState.user) {
      if (banner) banner.style.display = 'block';
      this._renderEmpty('로그인하면 학습 기록을 모아볼 수 있어요');
      return;
    }

    if (banner) banner.style.display = 'none';

    try {
      const sessions = await LearningService.fetchRecentSessions(AppState.user.uid, 5);
      this._render(sessions);
    } catch (e) {
      console.error('문제풀기 탭 로드 실패:', e);
      Toast.show('학습 기록을 불러오지 못했어요');
    }
  },

  _render(sessions) {
    const container = document.getElementById('quiz-recent-list');
    if (!container) return;

    if (!sessions.length) {
      this._renderEmpty('아직 학습 기록이 없어요. 사진을 업로드해서 시작해보세요!');
      return;
    }

    container.innerHTML = sessions.map(s => {
      const dateStr = s.createdAt?.toDate
        ? s.createdAt.toDate().toLocaleDateString('ko-KR') : '최근';
      const score = s.score ?? 0;
      const badgeClass = score >= 80 ? 'badge-green' : score >= 60 ? 'badge-amber' : 'badge-red';

      return `
        <div class="recent-card" onclick="QuizLibraryScreen.openSession('${s.id}', '${s.unit || '물리'}', ${score})">
          <div class="recent-info">
            <div class="recent-unit">${s.unit || '개념 학습'}</div>
            <div class="recent-meta">${dateStr} · 5문제</div>
          </div>
          <span class="badge ${badgeClass}">${score}점</span>
        </div>`;
    }).join('');
  },

  _renderEmpty(message) {
    const container = document.getElementById('quiz-recent-list');
    if (!container) return;
    container.innerHTML = `
      <div style="text-align:center;padding:32px 20px;color:var(--text3);font-size:13px">
        📚 ${message}
      </div>`;
  },

  /* 클릭 시 과거 피드백 재생 (mypage.js의 viewSessionLog와 동일 로직, 복귀처는 quiz-library) */
  async openSession(sessionId, unitName, score) {
    await window.viewSessionLog(sessionId, unitName, score, 'quiz-library');
  },
};

window.QuizLibraryScreen = QuizLibraryScreen;
