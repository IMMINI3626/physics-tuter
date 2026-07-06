import {
  collection, doc, setDoc, addDoc, getDoc, getDocs,
  query, orderBy, limit, where, serverTimestamp,
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { db } from './config.js';

const LearningService = {
  async saveSession(feedbackData) {
    // 🔑 window.AppState로 접근
    const uid = window.AppState.user?.uid;
    if (!uid) throw new Error('Not authenticated');

    const sessionData = window.AppState.session;

    const sessionRef = await addDoc(
      collection(db, 'users', uid, 'sessions'),
      {
        unit:           sessionData.detectedUnit,
        keywords:       sessionData.extractedKeywords,
        misconceptions: sessionData.misconceptions.map(m => m.id),
        score:          feedbackData.score,
        hintUsed:       sessionData.hintUsed,
        checkedCount:   sessionData.checkedStatements.size,
        createdAt:      serverTimestamp(),
      }
    );

    const logs = feedbackData.items.map(item => ({
      questionId:      item.id,
      questionText:    item.text,
      isWrongQ:        item.isWrong,
      userSelected:    sessionData.checkedStatements.has(item.id),
      isCorrectAnswer: item.isCorrectAnswer ?? !item.isWrong,
      userReason:      item.userReason || null,
      // 💡 추가된 부분: 이제부터 해설(explanation)도 DB에 저장합니다!
      explanation:     item.explanation || null, 
      createdAt:       serverTimestamp(),
    }));

    await Promise.all(
      logs.map(log =>
        addDoc(collection(db, 'users', uid, 'sessions', sessionRef.id, 'logs'), log)
      )
    );

    // unitProgress 업데이트 (bestScore, sessionCount — 마이페이지 카드용)
    // 🔑 level/completed 필드는 setUnitLevel()만 갱신함 (동시 저장 시 레이스로 인한 덮어쓰기 방지)
    if (sessionData.detectedUnit) {
      const unitRef = doc(db, 'users', uid, 'unitProgress', sessionData.detectedUnit);
      const unitSnap = await getDoc(unitRef);
      const prev = unitSnap.exists() ? unitSnap.data() : {};
      await setDoc(unitRef, {
        chapter:      window.getChapter?.(sessionData.detectedUnit) || null,
        bestScore:    Math.max(prev.bestScore || 0, feedbackData.score),
        sessionCount: (prev.sessionCount || 0) + 1,
        lastStudied:  serverTimestamp(),
      }, { merge: true });
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

    if (!sessions.length) return { total: 0, avgScore: 0, correctedMisconceptions: 0 };

    const total    = sessions.length;
    const avgScore = Math.round(sessions.reduce((s, x) => s + (x.score || 0), 0) / total);
    return { total, avgScore, correctedMisconceptions: Math.floor(total * 0.4) };
  },

  async fetchWeakMisconceptions(uid) {
    const q    = query(collection(db, 'users', uid, 'sessions'));
    const snap = await getDocs(q);
    const countMap = {};

    snap.docs.forEach(d => {
      const mc = d.data().misconceptions || [];
      mc.forEach(id => { countMap[id] = (countMap[id] || 0) + 1; });
    });

    const entries = Object.entries(countMap).sort((a, b) => b[1] - a[1]).slice(0, 5);
    return entries.map(([id, cnt]) => ({
      id,
      name: id,
      pct: Math.min(100, Math.round(cnt / snap.docs.length * 100)),
    }));
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
};

const MisconceptionDB = {
  async getUnits() {
    const snap = await getDocs(collection(db, 'units'));
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },

  async getMisconceptionsByUnit(unitId) {
    const q = query(collection(db, 'misconceptions'), where('unitId', '==', unitId));
    const snap = await getDocs(q);
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  },

  async getScoringKeywords(misconceptionId) {
    const docRef = doc(db, 'misconceptions', misconceptionId);
    const snap   = await getDoc(docRef);
    return snap.exists() ? snap.data().scoringKeywords || [] : [];
  },
};

// 🔑 글로벌로 노출
window.LearningService = LearningService;
window.MisconceptionDB = MisconceptionDB;

export { LearningService, MisconceptionDB };