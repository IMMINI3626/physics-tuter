/* ============================================================
   PhysiClinic — Bayesian Knowledge Tracing (BKT) 핵심 모듈

   오개념(지식 요소) 하나의 "이해도 확률 P(L)"을 정/오답 관측마다 갱신한다.
   설계 근거·수식은 docs/오개념측정_BKT_설계.md 참고 (Corbett & Anderson, 1994).

   이 파일은 순수 계산만 담당한다(부수효과·저장 없음). Firestore 저장/조회, 화면 표시,
   승급 판정은 다른 파일이 이 함수를 호출해서 처리한다.
   ============================================================ */

const BKT = {
  /* 파라미터 (설계 문서 4-3에서 확정한 고정 문헌값) */
  PARAMS: {
    pT: 0.15,  // 학습률: 한 번의 학습 기회로 미숙달→숙달 전이 확률
    pG: 0.20,  // 추측: 숙달 못 했어도 정답 낼 확률
    pS: 0.10,  // 실수: 숙달했어도 오답 낼 확률
  },

  /* 힌트를 보고 맞힌 정답에 적용할 상향된 추측 확률.
     "스스로 앎"의 증거가 약하므로 그 정답의 증거력을 할인한다(설계 4-6). */
  HINT_GUESS: 0.50,

  /* 사전 진단검사 문항에 적용할 추측 확률 (설계 4-11).
     진단 문항은 문장 하나를 O/X로 판단하는 이지선다라, 몰라도 절반은 맞는다.
     그래서 진단 결과를 "정답이면 0.70" 같은 손으로 정한 초기값으로 쓰지 않고,
     unknown(0.30)에서 시작해 이 추측률로 관측 한 건을 반영한다. */
  DIAGNOSTIC_GUESS: 0.50,

  /* 초기 이해도 P(L₀) — 어디서 걸렸느냐로 결정 (설계 4-3)
     🔑 진단검사 정답용 초기값(known 0.70)은 4-11에서 폐기했다. O/X 찍기 한 번 + 문제 한 번이면
        숙달로 올라가 10%가 운으로 통과했다. 지금은 applyDiagnostic()이 값을 계산한다. */
  PRIOR: {
    weak:    0.15,  // 사진에서 진단됨 (약점 확인)
    unknown: 0.30,  // 아직 아무 증거 없음 (미지) — 진단검사 전 모든 오개념의 출발점
  },

  /* 숙달 판정 임계값 τ (설계 4-3) */
  MASTERY: 0.90,

  /**
   * 관측(정답/오답) 하나를 반영해 갱신된 P(L)을 반환한다.
   *
   *   1) 관측 반영(베이즈): 정답이면 P(L|정답), 오답이면 P(L|오답)
   *   2) 학습 전이 반영:   P(Lₙ) = posterior + (1 - posterior) · P(T)
   *
   * @param {number} pL         현재 이해도 확률 (0~1)
   * @param {boolean} isCorrect 이 관측이 정답인지
   * @param {object} [opts]
   * @param {boolean} [opts.usedHint] 힌트를 보고 맞혔는지 (정답일 때만 P(G) 상향)
   * @param {number}  [opts.guess]    이 관측에만 쓸 추측 확률 (지정하면 usedHint보다 우선).
   *                                  O/X 진단 문항처럼 문항 형식이 추측률을 바꿀 때 쓴다.
   * @returns {number} 갱신된 P(L) (0~1)
   */
  update(pL, isCorrect, opts = {}) {
    const { pT, pG, pS } = this.PARAMS;
    // 입력 방어: 확률 범위를 벗어난 값이 들어오면 안전하게 클램프
    const prior = Math.min(1, Math.max(0, Number(pL)));

    // 🔑 opts.guess와 usedHint는 적용 범위가 다르다.
    //    - opts.guess: 문항 형식이 추측률을 정하는 경우(O/X 진단). 오답 쪽 P(오답|미숙달)=1-g에도
    //      똑같이 적용해야 한 문항에 대해 일관된 모델이 된다.
    //    - usedHint: "힌트를 봤다"는 정답에만 의미가 있다. 힌트를 보고도 틀렸다면 그건 오히려
    //      강한 미숙달 증거라 할인하지 않는다. 그래서 정답 쪽에만 적용한다.
    const itemGuess = Number.isFinite(opts.guess) ? opts.guess : null;

    let posterior;
    if (isCorrect) {
      const g = itemGuess ?? (opts.usedHint ? this.HINT_GUESS : pG);
      const num = prior * (1 - pS);
      posterior = num / (num + (1 - prior) * g);
    } else {
      const num = prior * pS;
      posterior = num / (num + (1 - prior) * (1 - (itemGuess ?? pG)));
    }
    // 분모가 0이 되는 극단(모든 확률이 0/1)일 때 NaN 방지
    if (!Number.isFinite(posterior)) posterior = prior;

    return posterior + (1 - posterior) * pT;
  },

  /** 여러 관측을 순서대로 반영 (배열: [{isCorrect, usedHint}]) */
  updateMany(pL, observations) {
    return (observations || []).reduce(
      (cur, o) => this.update(cur, !!o.isCorrect, { usedHint: !!o.usedHint }),
      pL
    );
  },

  /** 숙달했는지 (P(L) ≥ τ) */
  isMastered(pL) {
    return Number(pL) >= this.MASTERY;
  },

  /**
   * 화면에 띄울 이해도 비율 0~1 (설계 4-10).
   *
   *   (P(L) − P(L₀)) / (τ − P(L₀))   ... 0~1로 자름
   *
   * P(L)을 그대로 %로 보여주면 아무것도 안 한 오개념이 30%로 표시된다("30%는 안다"로 읽힌다).
   * 출발점을 0, 숙달을 100으로 놓아야 학습자가 읽는 대로의 의미가 된다.
   * 🔑 문제 화면의 진행도(feedback.js)와 마이페이지의 이해도(mypage.js)가 반드시 같은 식을
   *    써야 한다. 한쪽만 바꾸면 같은 상태를 두 화면이 다른 숫자로 말한다.
   */
  progressRatio(pL) {
    const floor = this.PRIOR.unknown;
    const span = this.MASTERY - floor;
    if (!(span > 0)) return 0;
    const r = (Number(pL) - floor) / span;
    return Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0;
  },

  /** 상황에 맞는 초기 P(L₀) 반환. status: 'weak' | 'unknown' */
  initialPL(status) {
    return this.PRIOR[status] ?? this.PRIOR.unknown;
  },

  /**
   * 사전 진단검사 한 문항의 답을 이해도로 환산한다 (설계 4-11).
   * unknown(0.30)에서 시작해 추측률 0.50짜리 관측 한 건을 반영한 값. 손으로 정한 상수가 아니라
   * 모델이 계산한 값이라, "왜 이 숫자인가"가 파라미터 하나(P(L₀))로 환원된다.
   *   정답 → 0.5202 (숙달까지 문제 정답 2번)
   *   오답 → 0.2171 (숙달까지 문제 정답 3번)
   * 건너뛴 문항은 관측이 없으므로 이 함수를 부르지 않고 unknown(0.30)을 그대로 둔다.
   */
  applyDiagnostic(isCorrect) {
    return this.update(this.PRIOR.unknown, !!isCorrect, { guess: this.DIAGNOSTIC_GUESS });
  },

  /**
   * 다음에 풀릴(=아직 숙달 안 된) 오개념을 이해도 낮은 순으로 정렬해 반환 (순환 출제, 설계 4-8).
   * @param {Array<{id, pL}>} items  대상 오개념들의 현재 이해도
   * @param {number} [count]         상위 몇 개까지 (기본 전체)
   * @returns {Array} 숙달 안 된 것만, P(L) 오름차순
   */
  pickWeakest(items, count = Infinity) {
    return (items || [])
      .filter(it => !this.isMastered(it.pL))
      .sort((a, b) => a.pL - b.pL)
      .slice(0, count);
  },
};

// 모듈/브라우저 양쪽에서 쓸 수 있게 노출 (Node 단위 테스트 + 브라우저 전역)
if (typeof module !== 'undefined' && module.exports) module.exports = BKT;
if (typeof window !== 'undefined') window.BKT = BKT;
