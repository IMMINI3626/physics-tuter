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
      createdAt:       serverTimestamp(),
    }));

    await Promise.all(
      logs.map(log =>
        addDoc(collection(db, 'users', uid, 'sessions', sessionRef.id, 'logs'), log)
      )
    );

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
