import {
  collection, doc, setDoc, addDoc, getDoc, getDocs,
  query, orderBy, limit, where, serverTimestamp, runTransaction,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { db } from './config.js';

const LearningService = {
  async saveSession(feedbackData) {
    // 🔑 window.AppState로 접근
    const uid = window.AppState.user?.uid;
    if (!uid) throw new Error('Not authenticated');

    const sessionData = window.AppState.session;

    // 마이페이지 소단원 상세의 "틀린 문항 개수" 표시용
    const wrongCount = feedbackData.items.filter(
      item => !(item.isCorrectAnswer ?? !item.isWrong)
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
      createdAt:      serverTimestamp(),
    };
    // 🔑 재도전(다시 풀어보기/다시 풀기)이면 원본 문제 id를 같이 저장 —
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
        isCorrectAnswer: item.isCorrectAnswer ?? !item.isWrong,
        userReason:      item.userReason || null,
        // 💡 추가된 부분: 이제부터 해설(explanation)도 DB에 저장합니다!
        explanation:     item.explanation || null,
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
   * 오개념 반복 집계. unitName을 주면 그 소단원 세션만 대상으로 필터링.
   * 2회 이상 반복된 오개념만 반환 (한 번 나온 건 "반복 오개념"이 아님)
   */
  async fetchWeakMisconceptions(uid, unitName = null) {
    let q = collection(db, 'users', uid, 'sessions');
    if (unitName) q = query(q, where('unit', '==', unitName));
    const snap = await getDocs(q);
    const countMap = {};

    snap.docs.forEach(d => {
      const mc = d.data().misconceptions || [];
      mc.forEach(id => { countMap[id] = (countMap[id] || 0) + 1; });
    });

    return Object.entries(countMap)
      .filter(([, cnt]) => cnt >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([id, count]) => ({ id, count }));
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
        userReason: data.userReason,
        explanation: data.explanation || '과거 데이터라 해설이 저장되지 않았습니다.',
        // 🔑 계산형 문제(Level 2 방식B, Level 3)일 때만 존재 — "다시 풀기" 복원에 사용
        correctAnswer: data.correctAnswer,
        unit: data.unit,
        unitOptions: data.unitOptions,
        solutionSteps: data.solutionSteps,
        isLevel3: data.isLevel3,
      };
    });
  },

  /* ────────────────────────────────────────
     🆕 레벨 시스템 — 승급 카운터 & 진행 상태
  ──────────────────────────────────────── */

  /**
   * 같은 소단원 내 새 문제 정답 시 누적 카운터 +1
   * 5회 도달 시 overcome: true로 표시하고 isPromoted: true를 반환
   */
  async incrementCorrectCount(uid, unitName, target = 5) {
    const ref = doc(db, 'users', uid, 'unitProgress', unitName);
    const snap = await getDoc(ref);
    const prevData = snap.exists() ? snap.data() : {};
    const prevCount = prevData.correctCount || 0;

    // 이미 승급 완료(completed)된 경우 카운터 증가 안 함
    if (prevData.completed) {
      return { count: prevCount, isPromoted: false };
    }

    const newCount = prevCount + 1;
    const isPromoted = newCount >= target;

    await setDoc(ref, {
      correctCount: isPromoted ? 0 : newCount,
      lastStudied: serverTimestamp(),
    }, { merge: true });

    return { count: newCount, isPromoted };
  },

  /**
   * 소단원의 현재 승급 카운터 조회
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
};

const MisconceptionDB = {
  async getMisconceptionById(id) {
    const snap = await getDoc(doc(db, 'misconceptions', id));
    return snap.exists() ? { id: snap.id, ...snap.data() } : null;
  },
};

// 🔑 글로벌로 노출
window.LearningService = LearningService;
window.MisconceptionDB = MisconceptionDB;

export { LearningService, MisconceptionDB };