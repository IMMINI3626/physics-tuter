const MypageScreen = {
  _currentChapter: null,
  _currentSubUnit: null,
  _currentLevel: 1,
  _currentCorrectCount: 0,
  _currentSessionCount: 0,
  _currentCompleted: false,
  _currentSessions: [],
  _historyPage: 0,
  HISTORY_PAGE_SIZE: 10,

  async init() {
    // Router.go('mypage')가 비로그인 시 이미 진입 자체를 막아주므로 여기선 방어적으로만 체크
    if (!AppState.isLoggedIn || !AppState.user) return;

    try {
      const uid = AppState.user.uid;
      const [stats, allProgress, recentSessions] = await Promise.all([
        LearningService.fetchStats(uid),
        LearningService.fetchAllUnitProgress(uid),
        LearningService.fetchRecentSessions(uid, 20),
      ]);

      this._renderStats(stats);
      this._renderWeakUnits(recentSessions);
      this._renderChapterList(allProgress);
    } catch (e) {
      console.error('마이페이지 로드 실패:', e);
      Toast.show('데이터를 불러오지 못했어요');
    }
  },

  _renderStats(stats) {
    const el = (id) => document.getElementById(id);
    if (el('mp-total'))    el('mp-total').textContent    = stats.total;
    if (el('mp-avgscore')) el('mp-avgscore').textContent = stats.avgScore;
  },

  /* 마이페이지 메인에서, 소단원 상세 화면에 들어가지 않아도 어디가 취약한지 바로 보여주는
     단원별 평균 점수 기반 막대 (점수가 낮을수록 취약도가 높게 표시됨) */
  _renderWeakUnits(sessions) {
    const container = document.getElementById('weak-list');
    if (!container) return;

    if (!sessions.length) {
      container.innerHTML = '<p style="font-size:13px;color:var(--text3);padding:8px 0">아직 학습 데이터가 없어요</p>';
      return;
    }

    const unitStats = {};
    sessions.forEach(s => {
      const unitName = s.unit || '기타 단원';
      if (!unitStats[unitName]) unitStats[unitName] = { sum: 0, count: 0 };
      unitStats[unitName].sum += (s.score || 0);
      unitStats[unitName].count += 1;
    });

    const weakList = Object.entries(unitStats)
      .map(([name, data]) => {
        const avg = Math.round(data.sum / data.count);
        return { name, pct: 100 - avg }; // 점수가 낮을수록 취약도(바 길이)가 커짐
      })
      .sort((a, b) => b.pct - a.pct)
      .slice(0, 5);

    const colors = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6'];
    container.innerHTML = weakList.map((item, i) => `
      <div class="weak-row">
        <span class="weak-name">${escapeHtml(item.name)}</span>
        <div class="weak-track">
          <div class="weak-fill" style="width:${item.pct}%;background:${colors[i % colors.length]}"></div>
        </div>
        <span class="weak-pct">취약도 ${item.pct}%</span>
      </div>
    `).join('');
  },

  /* 대단원 카드 목록 렌더링 */
  _renderChapterList(allProgress) {
    const container = document.getElementById('chapter-list');
    if (!container) return;

    const matchedNames = new Set();
    Object.values(UNIT_MAP).forEach(data => data.subUnits.forEach(su => matchedNames.add(su)));

    const chapterCards = Object.entries(UNIT_MAP).map(([chapter, data]) => `
      <div class="chapter-card">
        <div class="chapter-card-title">${chapter}</div>
        ${data.subUnits.map((su, i) => {
          const p = allProgress[su] || { level: 1, sessionCount: 0, completed: false };
          return `
          <button class="subunit-row" data-chapter-idx="${Object.keys(UNIT_MAP).indexOf(chapter)}" data-sub-idx="${i}" onclick="MypageScreen._onSubunitClick(this)">
            <span class="subunit-name ${p.sessionCount ? '' : 'dim'}">${su}</span>
            ${this._levelDots(p)}
            ${this._levelBadge(p)}
            <svg class="subunit-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
          </button>`;
        }).join('')}
      </div>
    `).join('');

    // 🔑 안전장치: AI가 14개 소단원명과 다르게 저장한 진행 상황도 놓치지 않고 "기타"로 표시
    const unmatchedNames = Object.keys(allProgress).filter(name => !matchedNames.has(name));
    const etcCard = unmatchedNames.length ? `
      <div class="chapter-card">
        <div class="chapter-card-title">기타</div>
        ${unmatchedNames.map((name) => {
          const p = allProgress[name];
          return `
          <button class="subunit-row" data-etc-name="${this._escapeAttr(name)}" onclick="MypageScreen._onSubunitClick(this)">
            <span class="subunit-name">${escapeHtml(name)}</span>
            ${this._levelDots(p)}
            ${this._levelBadge(p)}
            <svg class="subunit-chev" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
          </button>`;
        }).join('')}
      </div>
    ` : '';

    container.innerHTML = chapterCards + etcCard;
  },

  _escapeAttr(str) {
    return String(str).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  },

  _onSubunitClick(btnEl) {
    if (btnEl.dataset.etcName != null) {
      this.goDetail('기타', btnEl.dataset.etcName);
      return;
    }
    const chapters = Object.keys(UNIT_MAP);
    const chapter = chapters[Number(btnEl.dataset.chapterIdx)];
    const subUnit = UNIT_MAP[chapter].subUnits[Number(btnEl.dataset.subIdx)];
    this.goDetail(chapter, subUnit);
  },

  _levelBadge(progress) {
    if (progress.completed) return '<span class="level-badge done">✓ 완료</span>';
    if (!progress.sessionCount) return '<span class="level-badge new">시작 전</span>';
    const level = progress.level || 1;
    return `<span class="level-badge l${level}">L${level}</span>`;
  },

  /* 점 3개로 현재 레벨(L1~L3)을 표시. 완료면 3개 다 채움, 시작 전이면 0개 채움 —
     "몇 번 풀었는지"는 더 이상 여기서 보여주지 않음 */
  _levelDots(progress) {
    const filled = progress.completed ? 3 : (progress.sessionCount ? (progress.level || 1) : 0);
    let dots = '';
    for (let i = 0; i < 3; i++) dots += `<span class="${i < filled ? 'filled' : ''}"></span>`;
    return `<div class="progress-dots">${dots}</div>`;
  },

  /* 소단원 상세 화면 진입 */
  async goDetail(chapter, subUnit) {
    this._currentChapter = chapter;
    this._currentSubUnit = subUnit;

    document.getElementById('d-chapter').textContent = chapter;
    document.getElementById('d-title').textContent = subUnit;
    Router.go('mypage-detail');

    try {
      const uid = AppState.user.uid;
      const [sessions, progress, weakConcepts] = await Promise.all([
        LearningService.fetchSessionsByUnit(uid, subUnit),
        LearningService.getUnitProgress(uid, subUnit),
        LearningService.fetchWeakConcepts(uid, subUnit),
      ]);

      this._currentLevel = progress.level || 1;
      this._currentCorrectCount = progress.correctCount || 0;
      this._currentSessionCount = sessions.length;
      this._currentCompleted = !!progress.completed;

      this._renderChart(sessions);
      this._renderWeakConcepts(weakConcepts);
      this._renderHistory(sessions);
      this._updateRetryButton();
    } catch (e) {
      console.error('소단원 상세 로드 실패:', e);
      Toast.show('데이터를 불러오지 못했어요');
    }
  },

  goMain() {
    Router.go('mypage');
    this.init();
  },

  /* 사진으로 한 번도 진단 안 된 소단원은 바로 문제 풀기로 못 들어가게 하고
     사진 업로드로 유도 — "사진 찍어서 올리면 그 부분을 공부한다"는 앱의 핵심 전제를
     마이페이지에서 우회하지 않도록 함 */
  _updateRetryButton() {
    const btn = document.getElementById('d-retry-btn');
    const cta = document.getElementById('d-no-photo-cta');
    if (!btn || !cta) return;

    if (this._currentSessionCount > 0) {
      btn.style.display = '';
      cta.style.display = 'none';
      // 🔑 완료(completed)된 단원은 incrementCorrectCount가 카운터를 더 올리지 않는다.
      //    그런데 "L3 이어서 풀기"라고 계속 띄우면 풀어도 아무 변화가 없는 이유를
      //    사용자가 알 수 없으므로, 복습 모드라는 걸 라벨로 분명히 알려준다.
      btn.textContent = this._currentCompleted
        ? '✓ 완료한 단원 · 복습 문제 풀기'
        : `L${this._currentLevel} 이어서 풀기`;
    } else {
      btn.style.display = 'none';
      cta.style.display = '';
    }
  },

  /* 점수 추이 그래프 + 개념 향상도 배너 */
  _renderChart(sessions) {
    const scores = sessions.map(s => s.score);
    document.getElementById('d-chart').innerHTML = this._buildLineChart(scores);

    const curEl     = document.getElementById('d-curscore');
    const trendEl   = document.getElementById('d-trend');
    const improveEl = document.getElementById('d-improve');

    if (scores.length >= 2) {
      const first = scores[0], last = scores[scores.length - 1];
      const delta = last - first;

      curEl.innerHTML = `${last}<span>점 · 최근</span>`;
      trendEl.style.display = '';
      trendEl.className = 'trend ' + (delta >= 0 ? 'up' : 'down');
      trendEl.textContent = (delta >= 0 ? '▲ ' : '▼ ') + Math.abs(delta) + '점 ' + (delta >= 0 ? '향상' : '하락');

      document.getElementById('d-first').textContent = first + '점';
      document.getElementById('d-last').textContent  = last + '점';
      document.getElementById('d-delta').textContent = (delta >= 0 ? '+' : '') + delta;
      improveEl.style.display = '';
    } else {
      curEl.innerHTML = scores.length ? `${scores[0]}<span>점</span>` : '—';
      trendEl.style.display = 'none';
      improveEl.style.display = 'none';
    }
  },

  _buildLineChart(scores) {
    const w = 358, h = 130, pad = 18;
    if (scores.length < 2) {
      return `<div style="height:${h}px;display:flex;align-items:center;justify-content:center;color:var(--text3);font-size:12.5px">아직 그래프를 그리기엔 세션이 부족해요</div>`;
    }
    const min = 0, max = 100;
    const stepX = (w - pad * 2) / (scores.length - 1);
    const yOf = (v) => pad + (1 - (v - min) / (max - min)) * (h - pad * 2);
    const pts = scores.map((s, i) => [pad + i * stepX, yOf(s)]);
    const line = pts.map((p, i) => (i === 0 ? 'M' : 'L') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ');
    const area = line + ` L${pts[pts.length - 1][0]},${h - pad} L${pts[0][0]},${h - pad} Z`;
    const gridLines = [0, 50, 100].map(v => {
      const y = yOf(v).toFixed(1);
      return `<line x1="${pad}" y1="${y}" x2="${w - pad}" y2="${y}" stroke="var(--border)" stroke-width="1"/>
              <text x="2" y="${Number(y) + 3}" font-size="9" fill="var(--text3)">${v}</text>`;
    }).join('');
    const first = pts[0], last = pts[pts.length - 1];
    return `
      <svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" role="img" aria-label="점수 추이 그래프">
        <defs>
          <linearGradient id="fillGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.22"/>
            <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
          </linearGradient>
        </defs>
        ${gridLines}
        <path d="${area}" fill="url(#fillGrad)"/>
        <path d="${line}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="${first[0]}" cy="${first[1]}" r="3.5" fill="var(--surface)" stroke="var(--text3)" stroke-width="2"/>
        <circle cx="${last[0]}" cy="${last[1]}" r="4.5" fill="var(--accent)" stroke="var(--surface)" stroke-width="2"/>
      </svg>`;
  },

  /* 등장 횟수를 부드러운 강도 표현으로. 실패 횟수를 숫자로 들이밀지 않기 위함 */
  _intensityLabel(count) {
    if (count >= 5) return { text: '자주', cls: 'high' };
    if (count >= 3) return { text: '종종', cls: 'mid' };
    return { text: '가끔', cls: 'low' };
  },

  /* "집중하면 좋을 개념" — 개별 오개념 대신 개념 영역으로 묶어 부드럽게 표시.
     데이터는 fetchWeakConcepts가 이미 영역 단위로 집계·정렬해서 넘겨줌 */
  _renderWeakConcepts(concepts) {
    const card = document.getElementById('d-mc-card');
    const el = document.getElementById('d-misconceptions');
    if (!card || !el) return;

    if (!concepts || !concepts.length) {
      card.style.display = 'none';
      return;
    }

    el.innerHTML = concepts.map(c => {
      const it = this._intensityLabel(c.count);
      // 강도는 신호등 색 점으로만 표시(빨강=자주 / 노랑=종종 / 초록=가끔).
      // 색만으로는 색각 이상 사용자가 구분 못 하므로 강도 텍스트를 title/aria-label에 남겨둠.
      return `
        <div class="mc-row">
          <span class="mc-dot ${it.cls}" title="${it.text}" aria-label="${it.text}"></span>
          <div class="mc-text">${escapeHtml(c.name)}</div>
        </div>`;
    }).join('');
    card.style.display = '';
  },

  /* 과거 문제 풀이 이력 — 같은 문제(원본 + 다시 풀기들)는 하나로 묶어서, 그룹 단위로
     최신순 10개씩 페이지네이션. 각 그룹은 최근 시도를 대표로 보여주고, 재도전이 있으면
     펼쳐서 1차/2차/3차... 시도를 개별로 볼 수 있음 */
  _renderHistory(sessions) {
    // sessions는 fetchSessionsByUnit 결과로 오름차순(오래된 순) 정렬되어 있음 —
    // 그 순서를 그대로 유지해야 그룹 안에서 1차/2차/3차 번호가 맞게 매겨짐
    const groups = {};
    const order = [];
    sessions.forEach(s => {
      const rootId = s.retryOf || s.id; // 이 기능 이전 데이터는 retryOf가 없어 자기 자신이 원본이 됨
      if (!groups[rootId]) { groups[rootId] = []; order.push(rootId); }
      groups[rootId].push(s);
    });

    // 그룹 안에서 가장 최근 시도의 시각 기준으로 그룹 자체를 최신순 정렬
    this._historyGroups = order
      .map(rootId => groups[rootId])
      .sort((a, b) => {
        const at = a[a.length - 1].createdAt?.toMillis?.() || 0;
        const bt = b[b.length - 1].createdAt?.toMillis?.() || 0;
        return bt - at;
      });

    this._historyPage = 0;
    this._renderHistoryPage();
  },

  _fmtHistDate(createdAt) {
    return createdAt && createdAt.toDate
      ? createdAt.toDate().toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit' })
      : '-';
  },

  _histScoreCls(score) {
    return score >= 90 ? 'good' : score >= 70 ? 'mid' : 'bad';
  },

  /* 이력 한 줄(원본 단독, 또는 펼친 상태의 1차/2차 등 개별 시도) 렌더링 */
  _renderHistAttemptRow(s, ordinalLabel) {
    // level은 이 기능을 만들기 전에 저장된 과거 세션엔 없을 수 있음 — 그런 경우는 배지 없이 표시
    const levelBadge = s.level ? `<span class="level-badge l${s.level}">L${s.level}</span>` : '';
    const ordinal = ordinalLabel ? `<span class="hist-ordinal">${ordinalLabel}</span>` : '';
    const rootId = s.retryOf || s.id;

    return `
      <div class="hist-row">
        ${ordinal}
        <span class="hist-date">${this._fmtHistDate(s.createdAt)}</span>
        <span class="hist-score ${this._histScoreCls(s.score)}">${s.score}점</span>
        <span class="hist-level">${levelBadge}</span>
        <button class="hist-view-btn" onclick="event.stopPropagation(); viewSessionLog('${s.id}', MypageScreen._currentSubUnit, ${s.score}, 'mypage-detail', '${rootId}')">
          문제 보기
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
      </div>
    `;
  },

  _toggleHistGroup(groupId) {
    const attemptsEl = document.getElementById(groupId);
    const chevEl = document.getElementById(`chev-${groupId}`);
    if (!attemptsEl) return;
    const isOpen = attemptsEl.classList.toggle('open');
    if (chevEl) chevEl.style.transform = isOpen ? 'rotate(180deg)' : '';
  },

  _renderHistoryPage() {
    const el = document.getElementById('d-history');
    const pagEl = document.getElementById('d-history-pagination');
    if (!el) return;

    const groups = this._historyGroups || [];
    if (!groups.length) {
      el.innerHTML = '<div style="padding:10px 0;color:var(--text3);font-size:12.5px">아직 학습 기록이 없어요</div>';
      if (pagEl) pagEl.innerHTML = '';
      return;
    }

    const pageSize = this.HISTORY_PAGE_SIZE;
    const totalPages = Math.ceil(groups.length / pageSize);
    const page = this._historyPage;
    const pageGroups = groups.slice(page * pageSize, page * pageSize + pageSize);

    el.innerHTML = pageGroups.map((attempts, gi) => {
      const retryCount = attempts.length - 1;

      // 재도전이 없으면 예전과 동일하게 한 줄만
      if (retryCount === 0) {
        return `<div class="hist-item">${this._renderHistAttemptRow(attempts[0], null)}</div>`;
      }

      const latest = attempts[attempts.length - 1];
      const groupId = `hist-group-${page}-${gi}`;
      const attemptsHtml = attempts.map((s, i) => this._renderHistAttemptRow(s, `${i + 1}차 풀이`)).join('');

      return `
        <div class="hist-item">
          <div class="hist-row hist-group-header" onclick="MypageScreen._toggleHistGroup('${groupId}')">
            <span class="hist-date">${this._fmtHistDate(latest.createdAt)}</span>
            <span class="hist-score ${this._histScoreCls(latest.score)}">${latest.score}점</span>
            <span class="hist-retry-badge">재풀이 횟수: ${retryCount}</span>
            <svg class="hist-toggle-chev" id="chev-${groupId}" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg>
          </div>
          <div class="hist-attempts" id="${groupId}">${attemptsHtml}</div>
        </div>
      `;
    }).join('');

    if (pagEl) pagEl.innerHTML = this._buildPagination(page, totalPages);
  },

  _buildPagination(page, totalPages) {
    if (totalPages <= 1) return '';
    const btn = (label, target, disabled, active) =>
      `<button class="hist-page-btn ${active ? 'active' : ''}" ${disabled ? 'disabled' : ''} onclick="MypageScreen._goHistoryPage(${target})">${label}</button>`;

    const buttons = [btn('‹', page - 1, page === 0, false)];
    for (let i = 0; i < totalPages; i++) {
      buttons.push(btn(i + 1, i, false, i === page));
    }
    buttons.push(btn('›', page + 1, page === totalPages - 1, false));
    return buttons.join('');
  },

  _goHistoryPage(page) {
    this._historyPage = page;
    this._renderHistoryPage();
  },

  /* 이 소단원 추가 문제 풀기 → 새 문제 생성 후 해당 레벨 화면으로 이동 */
  async retryUnit(btnEl) {
    if (btnEl) { btnEl.disabled = true; btnEl.textContent = '문제 생성 중...'; }

    try {
      const level = this._currentLevel;
      const mode = pickQuizMode(level);

      AppState.session.detectedUnit = this._currentSubUnit;
      AppState.session.misconceptions = [];
      AppState.session.currentLevel = level;
      AppState.session.correctCount = this._currentCorrectCount;
      AppState.session.isRetry = false;
      AppState.session.isHistoryRetry = false;
      AppState.session._rootSessionId = null;
      AppState.session.checkedStatements = new Set();
      AppState.session.step2Answers = [];
      AppState.session.hintUsed = 0;
      AppState.session.quizMode = mode;
      // 마이페이지 상세에서 온 거라 문제 화면 상단 뒤로가기는 "분석 결과"가 아니라 "학습 현황"으로
      setQuizBackTarget('mypage-detail');

      const result = await ApiService.generateQuestions([], this._currentSubUnit, level, mode);

      AppState.session.hint1 = result.hint1;
      AppState.session.hint2 = result.hint2;
      if (result.misconceptionCount) AppState.session.misconceptionCount = result.misconceptionCount;

      applyQuizResult(result);
    } catch (err) {
      console.error('문제 생성 실패:', err);
      Toast.show('문제를 생성하는 데 실패했어요. 다시 시도해주세요.');
    } finally {
      if (btnEl) { btnEl.disabled = false; }
      this._updateRetryButton();
    }
  },
};

/* 과거 세션의 문제/피드백을 실제로 보러가기 (마이페이지 이력에서 호출)
   rootId: 이 세션이 속한 "원본 문제" id — 여기서 다시 풀기를 또 누르면 같은 그룹으로 묶이도록 전달 */
window.viewSessionLog = async function(sessionId, unitName, score, returnTo = 'mypage', rootId = null) {
  try {
    Toast.show('과거 기록을 불러오는 중...');

    const logs = await LearningService.fetchSessionLogs(AppState.user.uid, sessionId);

    const historyData = {
      score: score,
      title: '과거 학습 복기',
      subtitle: `${unitName} 단원`,
      unit: unitName,
      rootId: rootId || sessionId,
      items: logs,
    };

    FeedbackScreen.render(historyData, true, returnTo);
    Router.go('feedback');
  } catch (e) {
    console.error(e);
    Toast.show('기록을 불러오지 못했어요.');
  }
};
