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
      // 1. 전체 통계 가져오기
      const stats = await LearningService.fetchStats(AppState.user.uid);
      
      // 2. 최근 세션 최대 20개를 가져와서 취약 단원 분석 및 이력 렌더링에 모두 활용
      const recentSessions = await LearningService.fetchRecentSessions(AppState.user.uid, 20);

      this._renderStats(stats);
      this._renderWeakUnits(recentSessions); // M-001 대신 단원별 평균으로 계산
      this._renderHistory(recentSessions, 'history-list'); // 마이페이지 하단
      this._renderHistory(recentSessions.slice(0, 5), 'recent-list'); // 문제풀기 탭 (최근 5개만)
    } catch (e) {
      console.error('마이페이지 로드 실패:', e);
      window.Toast.show('데이터를 불러오지 못했어요');
    }
  },

  _renderStats(stats) {
    const el = (id) => document.getElementById(id);
    if (el('mp-total'))    el('mp-total').textContent    = stats.total;
    if (el('mp-avgscore')) el('mp-avgscore').textContent = stats.avgScore;
    if (el('mp-corrected'))el('mp-corrected').textContent = stats.correctedMisconceptions;
  },

  /* 변경점 1: 오개념 코드 대신 '단원명'을 기준으로 취약점 계산 */
  _renderWeakUnits(sessions) {
    const container = document.getElementById('weak-list');
    if (!container) return;

    if (!sessions.length) {
      container.innerHTML = '<p style="font-size:13px;color:var(--text3);padding:8px 0">아직 학습 데이터가 없어요</p>';
      return;
    }

    // 단원별 점수 누적
    const unitStats = {};
    sessions.forEach(s => {
      const unitName = s.unit || '기타 단원';
      if (!unitStats[unitName]) unitStats[unitName] = { sum: 0, count: 0 };
      unitStats[unitName].sum += (s.score || 0);
      unitStats[unitName].count += 1;
    });

    // 평균 점수가 낮은 순으로 정렬 (점수가 낮을수록 취약함)
    const weakList = Object.entries(unitStats)
      .map(([name, data]) => {
        const avg = Math.round(data.sum / data.count);
        return { 
          name, 
          pct: 100 - avg // 게이지 바 길이: 100에서 평균을 뺀 값 (점수가 낮을수록 바가 길어짐)
        };
      })
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 5);

    const colors = ['#ef4444','#f97316','#eab308','#22c55e','#3b82f6'];
    container.innerHTML = weakList.map((item, i) => `
      <div class="weak-row">
        <span class="weak-name">${item.name}</span>
        <div class="weak-track">
          <div class="weak-fill" style="width:${item.pct}%;background:${colors[i % colors.length]}"></div>
        </div>
        <span class="weak-pct">취약도 ${item.pct}%</span>
      </div>
    `).join('');
  },

  /* 변경점 2: 학습 이력 리스트 렌더링 */
  _renderHistory(sessions, containerId) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (!sessions.length) {
      container.innerHTML = '<p style="font-size:13px;color:var(--text3);padding:16px 0;text-align:center;">학습 기록이 없어요.</p>';
      return;
    }

    container.innerHTML = sessions.map(s => {
      const dateStr = s.createdAt && s.createdAt.toDate 
        ? s.createdAt.toDate().toLocaleDateString('ko-KR') 
        : '최근';
      
      return `
        <div onclick="viewSessionLog('${s.id}', '${s.unit || '물리'}', ${s.score})" 
             style="padding:16px; background:#fff; border:1px solid #eee; border-radius:12px; margin-bottom:12px; cursor:pointer; display:flex; justify-content:space-between; align-items:center;">
          <div>
            <div style="font-weight:700; color:#111; margin-bottom:4px">${s.unit || '개념 학습'}</div>
            <div style="font-size:12px; color:#888">${dateStr}</div>
          </div>
          <div style="font-weight:700; color:var(--accent); font-size:18px">${s.score}점 <span style="font-size:12px;color:#888;">></span></div>
        </div>
      `;
    }).join('');
  }
};

/* 변경점 3: 이력 클릭 시 과거 문제 풀이 로그를 불러오는 글로벌 함수 */
window.viewSessionLog = async function(sessionId, unitName, score, returnTo = 'mypage') {
  try {
    // window.Toast -> Toast 로 변경
    Toast.show('과거 기록을 불러오는 중...');
    
    // LearningService와 AppState는 모듈에서 전역으로 넘겼으므로 window. 유지
    const logs = await window.LearningService.fetchSessionLogs(window.AppState.user.uid, sessionId);
    
    // 피드백 화면에서 읽을 수 있는 형태로 데이터 조립
    const historyData = {
      score: score,
      title: '과거 학습 복기',
      subtitle: `${unitName} 단원`,
      items: logs 
    };

    // window.FeedbackScreen -> FeedbackScreen 로 변경
    FeedbackScreen.render(historyData, true, returnTo);
    
    // window.Router -> Router 로 변경
    Router.go('feedback');
    
  } catch(e) {
    console.error(e);
    // window.Toast -> Toast 로 변경
    Toast.show('기록을 불러오지 못했어요.');
  }
};