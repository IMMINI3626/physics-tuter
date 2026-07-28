import {
  collection, doc, setDoc, addDoc, getDoc, getDocs,
  query, orderBy, limit, where, serverTimestamp, runTransaction,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { db } from './config.js';

const LearningService = {
  async saveSession(feedbackData) {
    // window.AppState로 접근
    const uid = window.AppState.user?.uid;
    if (!uid) throw new Error('Not authenticated');

    const sessionData = window.AppState.session;

    // 마이페이지 소단원 상세의 "틀린 문항 개수" 표시용.
    // 검수에서 걸린 문항(isVoided)은 학생 잘못이 아니므로 틀린 문항으로 세지 않는다.
    const wrongCount = feedbackData.items.filter(
      item => !item.isVoided && item.isCorrectAnswer === false
    ).length;

    const sessionDoc = {
      unit:           sessionData.detectedUnit,
      keywords:       sessionData.extractedKeywords,
      misconceptions: sessionData.misconceptions.map(m => m.id),
      score:          feedbackData.score,
      level:          sessionData.currentLevel || 1,
      wrongCount,
      hintUsed:       sessionData.hintUsed,
      checkedCount:   sessionData.checkedStatements.size,
      // 힌트도 저장 — 과거 기록 "다시 풀기"로 이 문제를 복원할 때 힌트까지 되살리기 위함.
      // (안 저장하면 재도전 시 힌트가 하드코딩 기본 문구로 떨어짐)
      hint1:          sessionData.hint1 || null,
      hint2:          sessionData.hint2 || null,
      createdAt:      serverTimestamp(),
    };
    // 재도전(다시 풀어보기/다시 풀기)이면 원본 문제 id를 같이 저장 —
    // 마이페이지 이력에서 같은 문제끼리 묶어 보여주는 데 사용
    if (sessionData.isRetry && sessionData._rootSessionId) {
      sessionDoc.retryOf = sessionData._rootSessionId;
    }

    const sessionRef = await addDoc(collection(db, 'users', uid, 'sessions'), sessionDoc);

    const logs = feedbackData.items.map(item => {
      const log = {
        questionId:      item.id,
        questionText:    item.text,
        isWrongQ:        item.isWrong,
        userSelected:    sessionData.checkedStatements.has(item.id),
        // 🔑 서버가 확정해서 보낸 값을 그대로 남긴다. 검수에서 걸린 문항은 null(판정 불가)이다.
        //    예전엔 `?? !item.isWrong`으로 채워, 학생이 안 푼 문항까지 정답으로 기록됐다.
        isCorrectAnswer: typeof item.isCorrectAnswer === 'boolean' ? item.isCorrectAnswer : null,
        isVoided:        !!item.isVoided,   // 문항 검수 불일치 — 논문용 오류율 집계에도 쓴다
        userReason:      item.userReason || null,
        // 💡 추가된 부분: 이제부터 해설(explanation)도 DB에 저장합니다!
        explanation:     item.explanation || null,
        // 🆕 BKT 관측용: 이 문항이 겨냥한 오개념 + 이 세션에서 힌트를 썼는지.
        //    targetMisconceptionId가 있는 문항의 (isCorrectAnswer, usedHint)가 한 건의 관측이 된다.
        targetMisconceptionId: item.targetMisconceptionId || null,
        usedHint:        (sessionData.hintUsed || 0) > 0,
        createdAt:       serverTimestamp(),
      };
      // 🔑 계산형 문제(Level 2 방식B, Level 3)일 때만 존재 — 있으면 같이 저장해서 나중에 "다시 풀기"가 가능하게 함
      if (item.correctAnswer !== undefined) log.correctAnswer = item.correctAnswer;
      if (item.unit !== undefined)          log.unit          = item.unit;
      if (item.unitOptions !== undefined)   log.unitOptions   = item.unitOptions;
      if (item.solutionSteps !== undefined) log.solutionSteps = item.solutionSteps;
      if (item.isLevel3 !== undefined)      log.isLevel3      = item.isLevel3;
      return log;
    });

    await Promise.all(
      logs.map(log =>
        addDoc(collection(db, 'users', uid, 'sessions', sessionRef.id, 'logs'), log)
      )
    );

    // unitProgress 업데이트 (bestScore, sessionCount — 마이페이지 카드용)
    // 🔑 level/completed 필드는 setUnitLevel()만 갱신함 (동시 저장 시 레이스로 인한 덮어쓰기 방지)
    // 🔑 트랜잭션으로 처리 — 문제를 연달아 빠르게 풀어 saveSession()이 거의 동시에 여러 번
    //    호출돼도 sessionCount 증가분이 서로 씹히지 않도록 함 (읽고-쓰기 사이 레이스 방지)
    if (sessionData.detectedUnit) {
      const unitRef = doc(db, 'users', uid, 'unitProgress', sessionData.detectedUnit);
      await runTransaction(db, async (transaction) => {
        const unitSnap = await transaction.get(unitRef);
        const prev = unitSnap.exists() ? unitSnap.data() : {};
        transaction.set(unitRef, {
          chapter:      window.getChapter?.(sessionData.detectedUnit) || null,
          bestScore:    Math.max(prev.bestScore || 0, feedbackData.score),
          sessionCount: (prev.sessionCount || 0) + 1,
          lastStudied:  serverTimestamp(),
        }, { merge: true });
      });
    }

    console.log('Session saved:', sessionRef.id);
    return sessionRef.id;
  },

  async fetchRecentSessions(uid, count = 5) {
    const q = query(
      collection(db, 'users', uid, 'sessions'),
      orderBy('createdAt', 'desc'),
      limit(count)
    );
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },

  async fetchStats(uid) {
    const q    = query(collection(db, 'users', uid, 'sessions'), orderBy('createdAt', 'desc'));
    const snap = await getDocs(q);
    const sessions = snap.docs.map(d => d.data());

    if (!sessions.length) return { total: 0, avgScore: 0 };

    const total    = sessions.length;
    const avgScore = Math.round(sessions.reduce((s, x) => s + (x.score || 0), 0) / total);
    return { total, avgScore };
  },

  /**
   * "집중하면 좋을 개념" 집계. 세션에 쌓인 개별 오개념 id를 상위 개념 영역(dimension)으로
   * 묶어서 영역별 등장 횟수를 낸다. unitName을 주면 그 소단원 세션만 대상으로 한다.
   *
   * 개별 오개념을 그대로 세지 않고 영역으로 묶는 이유:
   *  - 학습자에게 "무거운 물체가 빨리 낙하한다는 오개념" 대신 "중력·저항" 같은 개념 영역으로
   *    부드럽게 보여주기 위함
   *  - 정확도도 오른다. 예전엔 같은 영역의 서로 다른 오개념(G1·G3)이 각각 1회면 둘 다
   *    "2회 미만"으로 잘렸는데, 영역으로 묶으면 '중력·저항' 2회로 정상 집계된다.
   *
   * @returns {[{code, name, count}]} 2회 이상 영역만, 많은 순, 상위 4개
   */
  async fetchWeakConcepts(uid, unitName = null) {
    let q = collection(db, 'users', uid, 'sessions');
    if (unitName) q = query(q, where('unit', '==', unitName));
    const [snap, dimMap] = await Promise.all([
      getDocs(q),
      MisconceptionDB.getDimensionMap(),
    ]);

    // 오개념 id → 개념 영역(dimensionCode)으로 환산하며 영역별 합산
    const countByCode = {};
    snap.docs.forEach(d => {
      (d.data().misconceptions || []).forEach(id => {
        const code = dimMap[id];
        if (!code) return; // 매핑 못 찾는 id(과거 이상 데이터 등)는 건너뜀
        countByCode[code] = (countByCode[code] || 0) + 1;
      });
    });

    const names = window.DIMENSION_NAMES || {};
    return Object.entries(countByCode)
      .filter(([, cnt]) => cnt >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([code, count]) => ({ code, name: names[code] || code, count }));
  },

  /**
   * 소단원 기준 세션 목록 조회 (점수 추이 그래프·과거 이력용)
   * 🔑 where + orderBy 복합 인덱스를 피하려고 정렬은 클라이언트에서 처리
   */
  async fetchSessionsByUnit(uid, unitName) {
    const q = query(collection(db, 'users', uid, 'sessions'), where('unit', '==', unitName));
    const snap = await getDocs(q);
    return snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.createdAt?.toMillis?.() || 0) - (b.createdAt?.toMillis?.() || 0));
  },

  /**
   * 이 소단원에서 가장 최근에 "오개념이 채워진" 세션의 오개념 id 목록을 돌려준다.
   * 마이페이지 "이어서 풀기"가 이 값을 이어받아 저장하면, 사진 없이 푼 세션도
   * "집중하면 좋을 개념" 통계에 반영된다. (사진 세션과 비슷한 크기라 통계가 부풀지 않음)
   * "다시 풀기"(같은 문제 재도전)는 이 함수를 쓰지 않는다 — 같은 문제를 또 세면 중복 집계됨.
   */
  async fetchLastMisconceptions(uid, unitName) {
    const sessions = await this.fetchSessionsByUnit(uid, unitName); // 오래된 → 최신 순
    for (let i = sessions.length - 1; i >= 0; i--) {
      const mc = sessions[i].misconceptions;
      if (Array.isArray(mc) && mc.length) return mc;
    }
    return [];
  },

  // 과거 세션에 저장된 힌트 조회 ("다시 풀기"로 복원 시 사용). 없으면 null.
  async getSessionHints(uid, sessionId) {
    const snap = await getDoc(doc(db, 'users', uid, 'sessions', sessionId));
    if (!snap.exists()) return { hint1: null, hint2: null };
    const d = snap.data();
    return { hint1: d.hint1 || null, hint2: d.hint2 || null };
  },

  async fetchSessionLogs(uid, sessionId) {
    const q = query(
      collection(db, 'users', uid, 'sessions', sessionId, 'logs'),
      orderBy('createdAt', 'asc')
    );
    const snap = await getDocs(q);
    
    // 💡 수정된 부분: DB에 저장된 이름표를 UI가 읽을 수 있는 이름표로 변환해서 넘겨줍니다!
    return snap.docs.map(d => {
      const data = d.data();
      return {
        id: data.questionId,
        text: data.questionText,               // DB의 questionText -> UI의 text
        isWrong: data.isWrongQ,                // DB의 isWrongQ -> UI의 isWrong
        isCorrectAnswer: data.isCorrectAnswer,
        isVoided: !!data.isVoided,             // 검수에서 걸린 문항은 과거 기록에서도 따로 표시
        userReason: data.userReason,
        explanation: data.explanation || '과거 데이터라 해설이 저장되지 않았습니다.',
        // 🔑 계산형 문제(Level 2 방식B, Level 3)일 때만 존재 — "다시 풀기" 복원에 사용
        correctAnswer: data.correctAnswer,
        unit: data.unit,
        unitOptions: data.unitOptions,
        solutionSteps: data.solutionSteps,
        isLevel3: data.isLevel3,
        // 🆕 오개념 태그 — "다시 풀기"로 복원해 다시 풀 때도 관측이 이어지도록 보존
        targetMisconceptionId: data.targetMisconceptionId || null,
      };
    });
  },

  /* ────────────────────────────────────────
     🆕 레벨 시스템 — 승급 카운터 & 진행 상태
  ──────────────────────────────────────── */

  /**
   * [폴백 전용] 누적 정답 카운터 +1. Phase 3 단계 7부터 승급은 이해도(P(L)) 기준이지만,
   * misconceptions 컬렉션에 오개념이 하나도 없는 소단원은 이해도 판정 대상이 없어 영원히
   * 승급이 안 된다. 그런 소단원에서만 예전 방식으로 승급시킨다(안전망).
   */
  async incrementCorrectCount(uid, unitName, target = 10) {
    const ref = doc(db, 'users', uid, 'unitProgress', unitName);
    const snap = await getDoc(ref);
    const prevData = snap.exists() ? snap.data() : {};
    const prevCount = prevData.correctCount || 0;

    if (prevData.completed) return { count: prevCount, isPromoted: false };

    const newCount = prevCount + 1;
    const isPromoted = newCount >= target;

    await setDoc(ref, {
      correctCount: isPromoted ? 0 : newCount,
      lastStudied: serverTimestamp(),
    }, { merge: true });

    return { count: newCount, isPromoted };
  },

  /**
   * 소단원의 현재 승급 카운터 조회 (폴백 소단원 표시용)
   */
  async getCorrectCount(uid, unitName) {
    const ref = doc(db, 'users', uid, 'unitProgress', unitName);
    const snap = await getDoc(ref);
    if (!snap.exists()) return 0;
    return snap.data().correctCount || 0;
  },

  /**
   * 소단원의 현재 레벨/완료 상태 조회 (없으면 기본값 level 1 반환)
   */
  async getUnitProgress(uid, unitName) {
    const ref = doc(db, 'users', uid, 'unitProgress', unitName);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      return { level: 1, completed: false, chapter: window.getChapter?.(unitName) || null };
    }
    return snap.data();
  },

  /**
   * 소단원 레벨 갱신 (승급 시 호출)
   */
  async setUnitLevel(uid, unitName, level, completed = false) {
    const ref = doc(db, 'users', uid, 'unitProgress', unitName);
    await setDoc(ref, {
      level,
      completed,
      chapter: window.getChapter?.(unitName) || null,
      lastStudied: serverTimestamp(),
    }, { merge: true });
  },

  /**
   * 전체 소단원 진행 상태 한 번에 조회 (마이페이지 대단원 카드 뷰용)
   * @returns {[unitName]: {level, completed, correctCount, sessionCount, bestScore, ...}}
   */
  async fetchAllUnitProgress(uid) {
    const snap = await getDocs(collection(db, 'users', uid, 'unitProgress'));
    const map = {};
    snap.docs.forEach(d => { map[d.id] = d.data(); });
    return map;
  },

  /* ────────────────────────────────────────
     BKT — 오개념별 이해도 상태 (knowledgeState)
     /users/{uid}/knowledgeState/{오개념id} = { pL, attempts, lastUpdated }
  ──────────────────────────────────────── */

  /** 오개념별 이해도 전체 조회. { [오개념id]: {pL, attempts, lastUpdated} } (없으면 빈 객체) */
  async fetchKnowledgeState(uid) {
    const snap = await getDocs(collection(db, 'users', uid, 'knowledgeState'));
    const map = {};
    snap.docs.forEach(d => { map[d.id] = d.data(); });
    return map;
  },

  /**
   * 마이페이지 소단원 상세용 — 이 소단원의 이해도 요약 (설계 단계 9).
   *
   * 🔑 오개념 하나하나의 값은 화면에 내보내지 않는다. 학습자에게 필요한 건 "이 소단원이
   *    얼마나 남았나"이고, 개별 오개념 목록은 "몇 개짜리 단원인가"에 신경이 쏠리게 한다
   *    (문제 화면에서 같은 이유로 감춘다 — feedback.js 주석). 여기서는 합쳐서 하나로 준다.
   *
   * 아직 한 번도 측정 안 된 오개념도 unknown(0.30) = 0%로 분모에 넣는다. 측정된 것만 세면
   * 3개 중 3개 숙달인지 8개 중 3개 숙달인지 구분되지 않는다.
   *
   * @returns {{mastered: number, total: number, ratio: number}}
   */
  async fetchUnitMastery(uid, unitName) {
    if (!window.BKT || !uid || !unitName) return { mastered: 0, total: 0, ratio: 0 };
    const [knowledge, all] = await Promise.all([
      this.fetchKnowledgeState(uid),
      MisconceptionDB._loadAll(),
    ]);

    const ids = all.filter(m => m.subUnit === unitName).map(m => m.id);
    if (!ids.length) return { mastered: 0, total: 0, ratio: 0 };

    return {
      total: ids.length,
      mastered: ids.filter(id => window.BKT.isMastered(this._pL(knowledge, id))).length,
      // 🔑 문제 화면의 진행도와 같은 함수를 쓴다. 두 화면이 같은 상태를 다른 숫자로 말하면 안 된다.
      ratio: this._masteryRatio(ids, knowledge),
    };
  },

  /** 특정 오개념 하나의 이해도 조회 (없으면 null) */
  async getKnowledge(uid, misconceptionId) {
    const snap = await getDoc(doc(db, 'users', uid, 'knowledgeState', misconceptionId));
    return snap.exists() ? snap.data() : null;
  },

  /** 오개념 하나의 이해도 저장/갱신 (upsert). BKT 갱신 결과를 여기에 쓴다. */
  async saveKnowledge(uid, misconceptionId, pL, attempts) {
    const ref = doc(db, 'users', uid, 'knowledgeState', misconceptionId);
    await setDoc(ref, { pL, attempts, lastUpdated: serverTimestamp() }, { merge: true });
  },

  /**
   * 사진 진단으로 나온 오개념 id들을 소단원별 "진단된 풀"(unitProgress.diagnosedMisconceptions)에
   * 합집합으로 누적하고, 아직 이해도 기록이 없는 오개념은 weak(0.15)로 초기화한다.
   * 이미 knowledgeState가 있는 오개념은 그대로 둔다(누적된 관측을 덮어쓰지 않음).
   */
  async addDiagnosedMisconceptions(uid, unitName, ids) {
    if (!uid || !unitName) return;
    // 실제 존재하는 오개념 id만 남긴다. AI가 목록 밖 id를 반환하면 쓸모없는 이해도 문서가
    // 생기고 진단 풀도 오염된다. 소단원이 다른 id도 함께 걸러낸다.
    const subUnitMap = await MisconceptionDB.getSubUnitMap();
    const cleanIds = [...new Set(
      (ids || []).filter(id => id && id !== 'ETC' && subUnitMap[id] === unitName)
    )];
    if (!cleanIds.length) return;

    const ref = doc(db, 'users', uid, 'unitProgress', unitName);
    const snap = await getDoc(ref);
    const prev = snap.exists() ? (snap.data().diagnosedMisconceptions || []) : [];
    const merged = [...new Set([...prev, ...cleanIds])];
    await setDoc(ref, {
      diagnosedMisconceptions: merged,
      chapter: window.getChapter?.(unitName) || null,
      lastStudied: serverTimestamp(),
    }, { merge: true });

    const weak = window.BKT ? window.BKT.PRIOR.weak : 0.15;
    await Promise.all(cleanIds.map(async id => {
      const cur = await this.getKnowledge(uid, id);
      if (!cur) await this.saveKnowledge(uid, id, weak, 0);
    }));
  },

  /**
   * 채점 결과(feedbackData.items)의 태그된 관측을 BKT로 반영해 knowledgeState를 갱신한다.
   * 태그(targetMisconceptionId) 없는 문항은 제외. 같은 오개념 문항이 여러 개면 한 오개념으로
   * 묶어 순서대로 반영한 뒤 한 번만 저장(같은 문서 병렬 쓰기 레이스 방지).
   */
  async applyBktObservations(uid, items, usedHint) {
    const BKT = window.BKT;
    if (!BKT || !uid) return;

    const byId = {};
    (items || []).forEach(it => {
      if (!it.targetMisconceptionId) return;
      // 🔑 문항 검수에서 걸린 문항(문장의 참·거짓 판정이 엇갈린 것)은 관측으로 쓰지 않는다.
      //    서버가 태그를 떼어 보내지만, 과거 기록을 다시 읽는 경로를 위해 여기서도 막는다.
      if (it.isVoided) return;
      // 🔑 isCorrectAnswer는 서버가 확정해서 보낸다(고름/안 고름/헛다리를 모두 반영).
      //    값이 없는 옛 기록만 "안 골랐으면 못 찾은 것"으로 보수적으로 처리한다.
      //    예전엔 `?? !it.isWrong` 이라, 손도 안 댄 틀린 문장이 정답 관측으로 들어가
      //    안 푼 문제로 이해도가 오르는 일이 있었다.
      const isCorrect = typeof it.isCorrectAnswer === 'boolean' ? it.isCorrectAnswer : false;
      (byId[it.targetMisconceptionId] ||= []).push(isCorrect);
    });

    await Promise.all(Object.entries(byId).map(async ([id, corrects]) => {
      const cur = await this.getKnowledge(uid, id);
      const pL0 = (cur && typeof cur.pL === 'number') ? cur.pL : BKT.PRIOR.unknown;
      const newPL = corrects.reduce((p, ok) => BKT.update(p, ok, { usedHint }), pL0);
      await this.saveKnowledge(uid, id, newPL, (cur?.attempts || 0) + corrects.length);
    }));
  },

  /**
   * 레벨별 대상 오개념 (설계 4-10). 출제·승급이 같은 집합을 본다.
   *   Level 1     : 소단원 전체 오개념 (넓게 훑는 단계)
   *   Level 2 / 3 : 사진으로 진단된 풀 (범위 축소). 풀이 비면 소단원 전체로 폴백.
   * @returns {{ids: string[], knowledge: object, completed: boolean}}
   */
  async _levelTargets(uid, unitName, level = 1) {
    const [progress, knowledge, subUnitMap] = await Promise.all([
      this.getUnitProgress(uid, unitName),
      this.fetchKnowledgeState(uid),
      MisconceptionDB.getSubUnitMap(),
    ]);

    const unitIds = Object.keys(subUnitMap).filter(id => subUnitMap[id] === unitName);
    // 진단 풀에 다른 소단원 id가 섞여 들어간 과거 데이터를 걸러낸다
    const diagnosed = (progress.diagnosedMisconceptions || [])
      .filter(id => !unitIds.length || unitIds.includes(id));

    let ids = (level >= 2 && diagnosed.length) ? diagnosed : unitIds;
    if (!ids.length) ids = diagnosed;   // 소단원 오개념 데이터 자체가 없을 때의 최후 폴백

    return { ids: [...new Set(ids)], knowledge, completed: !!progress.completed };
  },

  /** knowledgeState에서 이해도 하나 꺼내기 (기록 없으면 unknown 0.30) */
  _pL(knowledge, id) {
    const v = knowledge?.[id]?.pL;
    return typeof v === 'number' ? v : window.BKT.PRIOR.unknown;
  },

  /**
   * 순환 출제(설계 4-8): 다음 문제가 겨냥할 오개념 id를 이해도 낮은 순으로 고른다.
   * 이미 숙달(P(L) ≥ 0.90)한 것은 제외. 전부 숙달했거나 대상이 없으면 빈 배열을 반환하고,
   * 서버는 예전처럼 전체 오개념에서 자유 출제한다.
   */
  async pickTargetMisconceptions(uid, unitName, level = 1, count = 2) {
    if (!window.BKT || !uid || !unitName) return [];
    const { ids, knowledge } = await this._levelTargets(uid, unitName, level);
    const items = ids.map(id => ({ id, pL: this._pL(knowledge, id) }));
    return window.BKT.pickWeakest(items, count).map(it => it.id);
  },

  /**
   * 승급 판정 (설계 4-10): 현재 레벨의 대상 오개념이 모두 숙달(P(L) ≥ τ)됐는지.
   * 대상이 하나도 없으면 승급시키지 않는다(데이터 누락으로 인한 오승급 방지).
   * @returns {{ids, mastered, total, ratio, isPromoted, completed}}
   */
  async evaluatePromotion(uid, unitName, level = 1) {
    if (!window.BKT || !uid || !unitName) {
      return { ids: [], mastered: 0, total: 0, ratio: 0, isPromoted: false, completed: false };
    }
    const { ids, knowledge, completed } = await this._levelTargets(uid, unitName, level);
    const mastered = ids.filter(id => window.BKT.isMastered(this._pL(knowledge, id))).length;
    return {
      ids,
      mastered,
      total: ids.length,
      ratio: this._masteryRatio(ids, knowledge),
      isPromoted: ids.length > 0 && mastered === ids.length,
      completed,
    };
  },

  /**
   * 화면에 띄울 진행률 (설계 4-10). 숙달한 "개수"를 세면 계단이 너무 성겨서, 만점을 여러 번
   * 받아도 막대가 0%에 머문다. 한 문제가 겨냥하는 오개념은 2개이고 숙달에는 정답 2번이
   * 필요하므로, 오개념 N개짜리 소단원은 앞의 N/2문제 동안 숙달이 하나도 안 나온다.
   * 그래서 개수 대신 "각 오개념이 임계값 τ에 얼마나 다가갔는지"를 평균 낸다.
   *
   *   문항별 = (P(L) − P(L₀)) / (τ − P(L₀))   ... 0~1로 자름
   *
   * 출발점(unknown 0.30)이 정확히 0, 전부 숙달이 정확히 1이 되고 틀리면 내려간다.
   * 🔑 승급 판정은 이 값을 쓰지 않는다. 승급은 여전히 "전부 P(L) ≥ τ"만 본다.
   */
  _masteryRatio(ids, knowledge) {
    if (!ids || !ids.length) return 0;
    const sum = ids.reduce((acc, id) => acc + window.BKT.progressRatio(this._pL(knowledge, id)), 0);
    return sum / ids.length;
  },

  /**
   * 승급 직후 다음 레벨의 초기 이해도 재설정 (설계 4-10).
   * 쉬운 난이도에서 모은 증거는 어려운 난이도에 그대로 전이되지 않는다. 증거를 들고 가면
   * 다음 레벨이 한두 문제로 끝나버리므로, 숙달했던 오개념은 unknown(0.30)으로 되돌리고
   * 숙달 못 한 채 올라온 오개념은 weak(0.15)에서 다시 증거를 모은다.
   */
  async resetKnowledgeForLevel(uid, ids) {
    const BKT = window.BKT;
    if (!BKT || !uid) return;
    await Promise.all((ids || []).map(async id => {
      const cur = await this.getKnowledge(uid, id);
      const pL0 = (cur && typeof cur.pL === 'number') ? cur.pL : BKT.PRIOR.unknown;
      const next = BKT.isMastered(pL0) ? BKT.PRIOR.unknown : BKT.PRIOR.weak;
      await this.saveKnowledge(uid, id, next, cur?.attempts || 0);
    }));
  },

  /**
   * 이 소단원의 사전 진단검사를 아직 안 봤는지 (설계 4-11). 소단원당 1회만 본다.
   * 비로그인은 저장할 곳이 없으므로 검사를 건너뛴다(false).
   */
  async needsDiagnostic(uid, unitName) {
    if (!uid || !unitName) return false;
    try {
      const progress = await this.getUnitProgress(uid, unitName);
      return !progress.diagnosticDone;
    } catch (e) {
      // 조회 실패로 학습 자체를 막지는 않는다 — 검사를 건너뛰고 바로 문제로 보낸다
      console.warn('진단검사 여부 조회 실패, 건너뜀:', e);
      return false;
    }
  },

  /**
   * 사전 진단검사 결과를 이해도로 환산해 저장한다 (설계 4-11).
   *
   * 답한 문항만 관측으로 반영한다(건너뛴 문항은 기록을 남기지 않아 unknown 0.30으로 남는다).
   * 오답인 오개념은 "확인된 약점"이므로 진단 풀(diagnosedMisconceptions)에도 넣어, 사진 없이
   * 들어온 경우에도 Level 2/3의 출제 범위가 좁혀지게 한다.
   *
   * @param {Array<{misconceptionId, isCorrect, skipped}>} answers
   * @returns {{answered:number, correct:number, wrongIds:string[]}}
   */
  async saveDiagnosticResult(uid, unitName, answers) {
    const BKT = window.BKT;
    if (!BKT || !uid || !unitName) return { answered: 0, correct: 0, wrongIds: [] };

    const graded = (answers || []).filter(a => a && a.misconceptionId && !a.skipped);
    const wrongIds = graded.filter(a => !a.isCorrect).map(a => a.misconceptionId);

    await Promise.all(graded.map(a =>
      this.saveKnowledge(uid, a.misconceptionId, BKT.applyDiagnostic(a.isCorrect), 1)
    ));

    // 🔑 diagnosticDone을 먼저 세우면 저장이 중간에 실패했을 때 다시 볼 수 없다.
    //    이해도 저장이 끝난 뒤에 표시한다.
    await setDoc(doc(db, 'users', uid, 'unitProgress', unitName), {
      diagnosticDone: true,
      diagnosticAt: serverTimestamp(),
      chapter: window.getChapter?.(unitName) || null,
    }, { merge: true });

    // 오답 오개념을 진단 풀에 누적 (addDiagnosedMisconceptions가 소단원 일치까지 걸러준다)
    if (wrongIds.length) await this.addDiagnosedMisconceptions(uid, unitName, wrongIds);

    return {
      answered: graded.length,
      correct: graded.filter(a => a.isCorrect).length,
      wrongIds,
    };
  },
};

const MisconceptionDB = {
  async getMisconceptionById(id) {
    const snap = await getDoc(doc(db, 'misconceptions', id));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  },

  // 오개념 87개는 정적 데이터라 세션 중 안 바뀐다. 한 번만 읽어 메모리에 캐시하고
  // 아래 지도들(개념 영역 / 소단원)이 같은 캐시를 나눠 쓴다.
  _allCache: null,
  async _loadAll() {
    if (this._allCache) return this._allCache;
    const snap = await getDocs(collection(db, 'misconceptions'));
    this._allCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return this._allCache;
  },

  // 오개념 id → 개념 영역 코드(dimensionCode) 전체 지도
  _dimMapCache: null,
  async getDimensionMap() {
    if (this._dimMapCache) return this._dimMapCache;
    const all = await this._loadAll();
    const map = {};
    all.forEach(m => { if (m.dimensionCode) map[m.id] = m.dimensionCode; });
    this._dimMapCache = map;
    return map;
  },

  // 오개념 id → 소단원(subUnit) 전체 지도. 순환 출제에서 "이 소단원의 오개념"을 추리는 데 쓴다.
  _subUnitMapCache: null,
  async getSubUnitMap() {
    if (this._subUnitMapCache) return this._subUnitMapCache;
    const all = await this._loadAll();
    const map = {};
    all.forEach(m => { if (m.subUnit) map[m.id] = m.subUnit; });
    this._subUnitMapCache = map;
    return map;
  },

  /**
   * 사전 진단검사 문항 세트를 만든다 (설계 4-11).
   *
   * 규칙 (우선순위 순):
   *   1. 문장 개수만큼 서로 다른 오개념 — 한 오개념을 두 번 묶지 않는다.
   *   2. 개념 영역(dimensionCode)을 돌아가며 뽑아 한 영역에 몰리지 않게 한다.
   *      (14개 소단원 중 11개는 영역이 하나뿐이라 이 규칙이 실제로 작동하는 건 3개 소단원이다)
   *   3. 틀린 문장과 옳은 문장을 섞는다 — 전부 틀린 문장이면 "다 틀렸다" 찍기로 다 맞는다.
   *
   * @returns {Array<{misconceptionId, sentenceId, sentence, isWrong}>} 부족하면 있는 만큼만
   */
  async fetchDiagnosticSet(unitName, count = 5) {
    const all = await this._loadAll();
    const pool = all.filter(m => m.subUnit === unitName);
    if (!pool.length) return [];

    // 규칙 2: 영역별로 묶어 섞은 뒤 라운드로빈으로 뽑는다
    const byDim = {};
    pool.forEach(m => (byDim[m.dimensionCode || '?'] ||= []).push(m.id));
    Object.values(byDim).forEach(shuffle);
    const dimLists = shuffle(Object.values(byDim));

    const picked = [];
    for (let round = 0; picked.length < count; round++) {
      const before = picked.length;
      for (const list of dimLists) {
        if (picked.length >= count) break;
        if (list[round]) picked.push(list[round]);
      }
      if (picked.length === before) break;   // 모든 영역이 소진됨
    }
    if (!picked.length) return [];

    // 규칙 3: 틀린 문장/옳은 문장을 절반씩 배정 (홀수면 틀린 문장이 하나 많게)
    const wantWrong = Math.ceil(picked.length / 2);
    const wanted = shuffle(picked.map((_, i) => i < wantWrong));

    const snap = await getDocs(query(
      collection(db, 'misconception_sentences'),
      where('misconceptionId', 'in', picked)
    ));
    const byMc = {};
    snap.docs.forEach(d => (byMc[d.data().misconceptionId] ||= []).push({ id: d.id, ...d.data() }));

    const items = [];
    picked.forEach((mcId, i) => {
      const cands = byMc[mcId] || [];
      if (!cands.length) return;   // 문장 없는 오개념(현재 데이터엔 없음) 방어
      // 배정된 종류를 먼저 찾고, 그 종류가 없으면 아무 문장이나 쓴다
      const preferred = cands.filter(s => !!s.isWrong === wanted[i]);
      const s = shuffle(preferred.length ? preferred : cands.slice())[0];
      items.push({
        misconceptionId: mcId,
        sentenceId: s.id,
        sentence: s.sentence,
        isWrong: !!s.isWrong,
      });
    });

    return shuffle(items);
  },
};

/* 제자리 셔플(Fisher-Yates). 배열을 그대로 반환해 체이닝에 쓴다. */
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 🔑 글로벌로 노출
window.LearningService = LearningService;
window.MisconceptionDB = MisconceptionDB;

export { LearningService, MisconceptionDB };