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

    // 🔑 단원명(s.unit)은 AI가 생성한 문자열이라 onclick 문자열에 직접 보간하면 작은따옴표
    //    한 개로 핸들러가 깨진다. 값은 data-* 속성(escapeHtml로 이스케이프)에 담고, 클릭은
    //    컨테이너 한 곳에 위임 리스너로 처리한다.
    container.innerHTML = sessions.map(s => {
      const dateStr = s.createdAt?.toDate
        ? s.createdAt.toDate().toLocaleDateString('ko-KR') : '최근';
      const score = s.score ?? 0;
      const badgeClass = score >= 80 ? 'badge-green' : score >= 60 ? 'badge-amber' : 'badge-red';
      const rootId = s.retryOf || s.id;

      return `
        <div class="recent-card" data-session-id="${escapeHtml(s.id)}" data-unit="${escapeHtml(s.unit || '물리')}" data-score="${score}" data-root-id="${escapeHtml(rootId)}">
          <div class="recent-info">
            <div class="recent-unit">${escapeHtml(s.unit || '개념 학습')}</div>
            <div class="recent-meta">${dateStr} · 5문제</div>
          </div>
          <span class="badge ${badgeClass}">${score}점</span>
        </div>`;
    }).join('');

    container.querySelectorAll('.recent-card').forEach(card => {
      card.addEventListener('click', () => {
        const { sessionId, unit, score, rootId } = card.dataset;
        this.openSession(sessionId, unit, Number(score), rootId);
      });
    });
  },

  _renderEmpty(message) {
    const container = document.getElementById('quiz-recent-list');
    if (!container) return;
    container.innerHTML = `
      <div style="text-align:center;padding:32px 20px;color:var(--text3);font-size:13px">
        ${message}
      </div>`;
  },

  /* 클릭 시 과거 피드백 재생 (mypage.js의 viewSessionLog와 동일 로직, 복귀처는 quiz-library) */
  async openSession(sessionId, unitName, score, rootId) {
    await window.viewSessionLog(sessionId, unitName, score, 'quiz-library', rootId);
  },
};

window.QuizLibraryScreen = QuizLibraryScreen;
