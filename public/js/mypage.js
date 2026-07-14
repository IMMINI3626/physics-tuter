const MypageScreen = {
  _currentChapter: null,
  _currentSubUnit: null,
  _currentLevel: 1,
  _currentCorrectCount: 0,

  async init() {
    // Router.go('mypage')가 비로그인 시 이미 진입 자체를 막아주므로 여기선 방어적으로만 체크
    if (!AppState.isLoggedIn || !AppState.user) return;

    try {
      const uid = AppState.user.uid;
      const [stats, allProgress] = await Promise.all([
        LearningService.fetchStats(uid),
        LearningService.fetchAllUnitProgress(uid),
      ]);

      this._renderStats(stats);
      this._renderChapterList(allProgress);
    } catch (e) {
      console.error('마이페이지 로드 실패:', e);
      Toast.show('데이터를 불러오지 못했어요');
    }
  },

  _renderStats(stats) {
    const el = (id) => document.getElementById(id);
    if (el('mp-total'))     el('mp-total').textContent     = stats.total;
    if (el('mp-avgscore'))  el('mp-avgscore').textContent  = stats.avgScore;
    if (el('mp-corrected')) el('mp-corrected').textContent = stats.correctedMisconceptions;
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
            ${this._progressDots(p.sessionCount || 0)}
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
            <span class="subunit-name">${name}</span>
            ${this._progressDots(p.sessionCount || 0)}
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

  _progressDots(n) {
    if (!n) return '<span class="progress-count">0회</span>';
    const capped = Math.min(n, 4);
    let dots = '';
    for (let i = 0; i < 4; i++) dots += `<span class="${i < capped ? 'filled' : ''}"></span>`;
    const extra = n > 4 ? `<span class="progress-count">${n}회</span>` : '';
    return `<div class="progress-dots">${dots}</div>${extra}`;
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
      const [sessions, progress, weakList] = await Promise.all([
        LearningService.fetchSessionsByUnit(uid, subUnit),
        LearningService.getUnitProgress(uid, subUnit),
        LearningService.fetchWeakMisconceptions(uid, subUnit),
      ]);

      this._currentLevel = progress.level || 1;
      this._currentCorrectCount = progress.correctCount || 0;

      this._renderChart(sessions);
      await this._renderMisconceptions(weakList);
      this._renderHistory(sessions);
    } catch (e) {
      console.error('소단원 상세 로드 실패:', e);
      Toast.show('데이터를 불러오지 못했어요');
    }
  },

  goMain() {
    Router.go('mypage');
    this.init();
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

  /* 반복 오개념 유형 (2회 이상만) */
  async _renderMisconceptions(weakList) {
    const card = document.getElementById('d-mc-card');
    const el = document.getElementById('d-misconceptions');
    if (!card || !el) return;

    if (!weakList.length) {
      card.style.display = 'none';
      return;
    }

    const withNames = await Promise.all(weakList.map(async (w) => {
      const mc = await MisconceptionDB.getMisconceptionById(w.id);
      return { ...w, label: mc ? mc.name_ko : w.id };
    }));

    el.innerHTML = withNames.map(w => `
      <div class="mc-row">
        <div class="mc-icon">⚠</div>
        <div class="mc-text">${w.label}</div>
        <div class="mc-count">${w.count}회</div>
      </div>
    `).join('');
    card.style.display = '';
  },

  /* 과거 문제 풀이 이력 (최신순) */
  _renderHistory(sessions) {
    const el = document.getElementById('d-history');
    if (!el) return;

    if (!sessions.length) {
      el.innerHTML = '<div style="padding:10px 0;color:var(--text3);font-size:12.5px">아직 학습 기록이 없어요</div>';
      return;
    }

    const reversed = [...sessions].reverse();
    el.innerHTML = reversed.map(s => {
      const dateStr = s.createdAt && s.createdAt.toDate
        ? s.createdAt.toDate().toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit' })
        : '-';
      const scoreCls = s.score >= 90 ? 'good' : s.score >= 70 ? 'mid' : 'bad';
      const wrongText = s.wrongCount != null ? `틀린 문항 ${s.wrongCount}개` : '';

      return `
        <div class="hist-item">
          <div class="hist-row">
            <span class="hist-date">${dateStr}</span>
            <span class="hist-score ${scoreCls}">${s.score}점</span>
            <span class="hist-wrong">${wrongText}</span>
            <button class="hist-view-btn" onclick="viewSessionLog('${s.id}', '${this._currentSubUnit}', ${s.score}, 'mypage-detail')">
              문제 보기
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          </div>
        </div>
      `;
    }).join('');
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
      AppState.session.checkedStatements = new Set();
      AppState.session.step2Answers = [];
      AppState.session.hintUsed = 0;
      AppState.session.quizMode = mode;

      const result = await ApiService.generateQuestions([], this._currentSubUnit, level, mode);

      AppState.session.hint1 = result.hint1;
      AppState.session.hint2 = result.hint2;
      if (result.misconceptionCount) AppState.session.misconceptionCount = result.misconceptionCount;

      if (result.calcQuestion) {
        AppState.session.calcQuestion = result.calcQuestion;
        AppState.session.questions = null;
        if (result.calcQuestion.isLevel3) {
          Level3Screen.init(result.calcQuestion);
          Router.go('level3');
        } else {
          QuizScreen.initCalc(result.calcQuestion);
          Router.go('calc');
        }
      } else {
        AppState.session.calcQuestion = null;
        AppState.session.questions = result.questions;
        QuizScreen.init(result.questions);
        Router.go('step1');
      }
    } catch (err) {
      console.error('문제 생성 실패:', err);
      Toast.show('문제를 생성하는 데 실패했어요. 다시 시도해주세요.');
    } finally {
      if (btnEl) { btnEl.disabled = false; btnEl.textContent = '이 소단원 추가 문제 풀기'; }
    }
  },
};

/* 과거 세션의 문제/피드백을 실제로 보러가기 (마이페이지 이력에서 호출) */
window.viewSessionLog = async function(sessionId, unitName, score, returnTo = 'mypage') {
  try {
    Toast.show('과거 기록을 불러오는 중...');

    const logs = await LearningService.fetchSessionLogs(AppState.user.uid, sessionId);

    const historyData = {
      score: score,
      title: '과거 학습 복기',
      subtitle: `${unitName} 단원`,
      items: logs,
    };

    FeedbackScreen.render(historyData, true, returnTo);
    Router.go('feedback');
  } catch (e) {
    console.error(e);
    Toast.show('기록을 불러오지 못했어요.');
  }
};
