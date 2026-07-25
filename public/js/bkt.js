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

  /* 초기 이해도 P(L₀) — 어디서 걸렸느냐로 결정 (설계 4-3) */
  PRIOR: {
    weak:    0.15,  // 진단검사 오답 / 사진에서 진단됨 (약점 확인)
    known:   0.70,  // 진단검사 정답 (아마 앎)
    unknown: 0.30,  // 아무데도 안 걸림 (미지)
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
   * @returns {number} 갱신된 P(L) (0~1)
   */
  update(pL, isCorrect, opts = {}) {
    const { pT, pG, pS } = this.PARAMS;
    // 입력 방어: 확률 범위를 벗어난 값이 들어오면 안전하게 클램프
    const prior = Math.min(1, Math.max(0, Number(pL)));

    let posterior;
    if (isCorrect) {
      // 힌트로 맞힌 정답은 추측 확률을 높여 증거를 할인
      const g = opts.usedHint ? this.HINT_GUESS : pG;
      const num = prior * (1 - pS);
      posterior = num / (num + (1 - prior) * g);
    } else {
      const num = prior * pS;
      posterior = num / (num + (1 - prior) * (1 - pG));
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

  /** 진단 결과/상황에 맞는 초기 P(L₀) 반환. status: 'weak' | 'known' | 'unknown' */
  initialPL(status) {
    return this.PRIOR[status] ?? this.PRIOR.unknown;
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
