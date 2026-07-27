/* ============================================================
   PhysiClinic — 사전 진단검사 화면 (설계 4-11 / 구현 단계 8)

   소단원을 처음 시작할 때 한 번, 문장 5개를 O/X로 판단하게 해서 오개념별 초기 이해도를
   세운다. 아무 증거가 없는 상태(0.30)에서 시작하는 것보다 약한 오개념을 먼저 겨냥할 수 있다.

   결정 사항:
   - 5문항을 한 화면에 모두 보여준다 — 시험지처럼 훑어보고 답을 고칠 수 있게. 한 문항씩
     넘기는 방식은 앞 문항으로 되돌아갈 수 없고 화면 전환만 5번 일어난다.
   - 건너뛰기 허용 — 모르는 문장을 찍게 만들면 잘못된 초기값이 들어간다. 건너뛴 문항은
     관측을 남기지 않고 0.30(미지)으로 둔다.
   - 정답 비공개 — 검사 직후 정답을 알려주면 바로 뒤에 나올 학습 문제의 답을 미리 알려주는 셈이다.
   - 문장 5개는 서로 다른 오개념 5개 (선택 규칙은 MisconceptionDB.fetchDiagnosticSet)
   ============================================================ */

const DiagnosticScreen = {
  _items: [],       // [{misconceptionId, sentenceId, sentence, isWrong}]
  _choices: [],     // 문항별 선택: 'O' | 'X' | 'SKIP' | null(미선택)
  _unit: null,
  _onDone: null,    // 검사가 끝난 뒤(또는 건너뛴 뒤) 실행할 콜백 — 원래 하려던 학습으로 이어짐
  _submitting: false,

  /**
   * 진단검사가 필요하면 화면을 띄우고 true, 필요 없으면 아무것도 안 하고 false를 반환한다.
   * 호출부는 false일 때만 원래 흐름(문제 생성)을 그대로 진행하면 된다.
   */
  async startIfNeeded(unitName, onDone) {
    if (!unitName || !window.AppState.isLoggedIn || !window.AppState.user) return false;

    try {
      const uid = window.AppState.user.uid;
      if (!await window.LearningService.needsDiagnostic(uid, unitName)) return false;

      const items = await window.MisconceptionDB.fetchDiagnosticSet(unitName, 5);
      // 문항을 못 만들면(오개념 데이터 없는 소단원) 검사를 건너뛴다 — 학습을 막지 않는다
      if (items.length < 2) return false;

      this._items = items;
      this._choices = items.map(() => null);
      this._unit = unitName;
      this._onDone = onDone;
      this._submitting = false;

      window.Router.go('diagnostic');
      this._render();
      return true;
    } catch (e) {
      console.warn('진단검사 준비 실패, 바로 학습으로 진행:', e);
      return false;
    }
  },

  /* 안내문 + 문항 5개 + 제출 버튼을 한 화면에 그린다 */
  _render() {
    const el = document.getElementById('diag-body');
    if (!el) return;
    document.getElementById('diag-unit-label').textContent = this._unit;

    const nums = ['①', '②', '③', '④', '⑤', '⑥', '⑦', '⑧'];
    const rows = this._items.map((item, i) => `
      <li class="diag-item" id="diag-item-${i}">
        <div class="diag-item-q">
          <span class="diag-item-num">${nums[i] || i + 1}</span>
          <p class="diag-item-text">${escapeHtml(item.sentence)}</p>
        </div>
        <div class="diag-item-opts">
          <button class="diag-opt opt-o"    onclick="DiagnosticScreen.pick(${i},'O')">O</button>
          <button class="diag-opt opt-x"    onclick="DiagnosticScreen.pick(${i},'X')">X</button>
          <button class="diag-opt opt-skip" onclick="DiagnosticScreen.pick(${i},'SKIP')">건너뛰기</button>
        </div>
      </li>
    `).join('');

    el.innerHTML = `
      <div class="diag-sheet">
        <h2 class="diag-sheet-title">
          다음 문장 중 옳은 문장에는 <strong class="mark-o">O</strong>,
          틀린 문장에는 <strong class="mark-x">X</strong>를 표시하세요
        </h2>
        <p class="diag-sheet-note">
          잘 모르는 문장은 <strong>건너뛰기</strong>를 눌러주세요.
          점수로 기록되지 않고, 이 단원에서 한 번만 물어봐요.
        </p>

        <ol class="diag-items">${rows}</ol>

        <button class="primary-btn" id="diag-submit" disabled
                onclick="DiagnosticScreen.submit()">제출하기</button>
        <button class="text-link-btn" style="margin:14px auto 0;display:block"
                onclick="DiagnosticScreen.skipAll()">
          검사 없이 바로 문제 풀기
        </button>
      </div>
    `;
    this._syncState();
  },

  /* 한 문항의 선택 — 같은 걸 다시 누르면 해제된다(잘못 누른 걸 되돌릴 수 있게) */
  pick(i, choice) {
    if (this._submitting || !this._items[i]) return;
    this._choices[i] = (this._choices[i] === choice) ? null : choice;
    this._syncState();
  },

  /* 선택 표시·진행바·제출 버튼을 현재 상태에 맞춘다 */
  _syncState() {
    this._choices.forEach((c, i) => {
      const row = document.getElementById(`diag-item-${i}`);
      if (!row) return;
      row.classList.toggle('answered', !!c);
      row.querySelectorAll('.diag-opt').forEach(btn => {
        const own = btn.classList.contains('opt-o') ? 'O'
                  : btn.classList.contains('opt-x') ? 'X' : 'SKIP';
        btn.classList.toggle('selected', c === own);
      });
    });

    const done = this._choices.filter(Boolean).length;
    const total = this._items.length;
    this._setProgress((done / total) * 100);

    const btn = document.getElementById('diag-submit');
    if (btn) {
      const all = done === total;
      btn.disabled = all ? false : true;
      btn.textContent = all ? '제출하기' : `제출하기 (${done}/${total})`;
    }
  },

  /**
   * 선택을 관측으로 바꿔 저장한다.
   * 문장이 틀린 문장(isWrong)이면 X가 정답, 옳은 문장이면 O가 정답이다.
   * 어느 방향이든 그 오개념에 대한 관측 한 건이 된다. 건너뛰기는 관측을 남기지 않는다.
   */
  async submit() {
    if (this._submitting) return;
    this._submitting = true;

    const answers = this._items.map((item, i) => {
      const c = this._choices[i];
      if (c !== 'O' && c !== 'X') {
        return { misconceptionId: item.misconceptionId, isCorrect: false, skipped: true };
      }
      return {
        misconceptionId: item.misconceptionId,
        isCorrect: (c === 'O') === !item.isWrong,
        skipped: false,
      };
    });

    await this._finish(answers);
  },

  /* 검사 자체를 건너뛰기 — 답을 하나도 남기지 않지만 "봤음" 표시는 해서 매번 묻지 않는다 */
  async skipAll() {
    if (this._submitting) return;
    this._submitting = true;
    await this._finish([]);
  },

  async _finish(answers) {
    this._setProgress(100);
    const el = document.getElementById('diag-body');
    if (el) {
      el.innerHTML = `
        <div class="diag-done">
          <h2 class="diag-done-title">확인했어요</h2>
          <p class="diag-done-desc">헷갈리는 개념부터 문제를 만들어볼게요.</p>
          <div class="diag-spinner"></div>
        </div>
      `;
    }

    // 🔑 정답 개수는 화면에 띄우지 않는다. 바로 다음에 같은 개념의 문제가 나오는데,
    //    여기서 정답을 알려주면 그 문제의 답을 미리 알려주는 셈이 된다.
    try {
      const uid = window.AppState.user?.uid;
      if (uid) {
        const r = await window.LearningService.saveDiagnosticResult(uid, this._unit, answers);
        console.log('[진단검사]', this._unit, `답한 문항 ${r.answered} / 약점 ${r.wrongIds.length}개`, r.wrongIds);
      }
    } catch (e) {
      console.error('진단검사 결과 저장 실패:', e);
      Toast.show('진단 결과를 저장하지 못했어요. 학습은 계속할 수 있어요.');
    }

    const done = this._onDone;
    this._onDone = null;
    if (typeof done === 'function') await done();
  },

  _setProgress(percent) {
    const fill = document.getElementById('diag-progress-fill');
    if (fill) fill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  },
};

window.DiagnosticScreen = DiagnosticScreen;
