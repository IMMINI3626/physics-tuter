/**
 * PhysiClinic — unitProgress.sessionCount / bestScore 일회성 보정 스크립트
 *
 * 배경:
 *   saveSession()이 예전엔 "읽고 → +1 해서 쓰기" 방식으로 sessionCount를 갱신해서,
 *   문제를 연달아 빠르게 풀면(초 단위 간격) 동시 저장 요청끼리 서로의 증가분을
 *   덮어써 실제 세션 수보다 적게 기록되는 레이스 컨디션이 있었음
 *   (2026-07 firestore.js에서 runTransaction으로 수정 완료 — 이 스크립트는
 *   "그 수정이 있기 전에 이미 잘못 저장된 기존 값"을 바로잡는 용도).
 *
 * 하는 일 (기존 unitProgress 문서가 있는 것만 대상 — 새 문서를 만들지는 않음):
 *   1. 모든 유저의 기존 unitProgress 문서를 하나씩 봄
 *   2. 그 단원 이름으로 실제 저장된 sessions 문서 개수를 셈
 *   3. sessionCount, bestScore를 그 실제 값으로 덮어씀
 *   4. level / completed / correctCount는 건드리지 않음 (정확히 복원할 근거가 없어서 보류)
 *
 * 사용법: node fix-unitprogress-counts.js
 */

const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function fixUser(uid) {
  const progressSnap = await db.collection('users').doc(uid).collection('unitProgress').get();
  if (progressSnap.empty) return 0;

  let fixedCount = 0;

  for (const progressDoc of progressSnap.docs) {
    const unitName = progressDoc.id;
    const prev = progressDoc.data();

    const sessSnap = await db
      .collection('users').doc(uid).collection('sessions')
      .where('unit', '==', unitName)
      .get();

    const realSessionCount = sessSnap.size;
    const realBestScore = sessSnap.docs.reduce((max, d) => Math.max(max, d.data().score || 0), 0);

    if (prev.sessionCount === realSessionCount && prev.bestScore === realBestScore) {
      continue; // 이미 정확함
    }

    await progressDoc.ref.update({
      sessionCount: realSessionCount,
      bestScore: realBestScore,
    });

    console.log(
      `  [${uid}] "${unitName}": sessionCount ${prev.sessionCount ?? 0} → ${realSessionCount}, ` +
      `bestScore ${prev.bestScore ?? 0} → ${realBestScore}`
    );
    fixedCount++;
  }

  return fixedCount;
}

async function main() {
  console.log('🔧 unitProgress sessionCount/bestScore 보정 시작...\n');

  // 🔑 users/{uid} 문서는 하위 컬렉션만 있고 자기 자신은 set()된 적이 없어서
  //    db.collection('users').get()으로는 안 잡힘 → Firebase Auth에서 실제 uid 목록을 가져옴
  const { users } = await admin.auth().listUsers(1000);
  let totalFixed = 0;

  for (const user of users) {
    totalFixed += await fixUser(user.uid);
  }

  console.log(`\n✅ 완료 — 총 ${totalFixed}개 unitProgress 문서 보정함 (${users.length}명 유저 중)`);
  process.exit(0);
}

main().catch(err => {
  console.error('❌ 보정 실패:', err.message);
  process.exit(1);
});
