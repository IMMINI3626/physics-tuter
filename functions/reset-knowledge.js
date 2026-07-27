/* ============================================================
   이해도(knowledgeState) 초기화 스크립트

   왜 필요한가:
   단계 8-2 이전의 이해도는 오염된 관측으로 만들어졌다.
   - 학생이 손대지 않은 문항이 "정답" 관측으로 들어갔다 (isCorrectAnswer 기본값 문제)
   - 문장의 참·거짓 라벨이 반대인 문항이 그대로 관측이 됐다
   그 위에서 마이페이지 시각화(단계 9)나 파라미터 민감도 분석(단계 10)을 하면
   잡음을 분석하게 된다. 고친 뒤 한 번 비우고 다시 쌓는 것이 맞다.

   무엇을 지우나:
     users/{uid}/knowledgeState/*              — 오개념별 이해도 전부
     users/{uid}/unitProgress/{unit}.diagnosticDone / diagnosticAt — 진단검사를 다시 볼 수 있게

   무엇을 남기나:
     세션 기록(sessions/*)과 그 로그         — 학습 이력은 보존
     unitProgress의 level / completed / diagnosedMisconceptions

   사용법:
     node reset-knowledge.js            → 무엇이 지워질지만 출력 (실제로 지우지 않음)
     node reset-knowledge.js --apply    → 실제로 지움
   ============================================================ */
const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const APPLY = process.argv.includes('--apply');

async function main() {
  console.log(APPLY ? '⚠️  실제 삭제 모드\n' : '🔍 미리보기 모드 (실제로 지우지 않음)\n');

  /* 🔑 users/{uid} 문서 자체는 아무도 만들지 않는다. 앱은 하위 컬렉션
     (knowledgeState / unitProgress / sessions)에만 쓴다. Firestore에서 이런 문서는
     "존재하지 않는 상위 문서"로 취급돼 collection('users').get()에 잡히지 않는다.
     하위 컬렉션을 가진 경로까지 보려면 관리자 SDK의 listDocuments()를 써야 한다. */
  const userRefs = await db.collection('users').listDocuments();
  if (!userRefs.length) {
    console.log('사용자가 없습니다.');
    return;
  }

  let totalKnowledge = 0;
  let totalUnits = 0;

  for (const userRef of userRefs) {
    const uid = userRef.id;
    const knowledge = await userRef.collection('knowledgeState').get();
    const progress = await userRef.collection('unitProgress').get();
    const withDiag = progress.docs.filter(d => d.data().diagnosticDone);

    console.log(`👤 ${uid}`);
    console.log(`   이해도 기록 ${knowledge.size}개 / 진단검사 완료 소단원 ${withDiag.length}개`);
    if (knowledge.size) {
      const sample = knowledge.docs.slice(0, 5)
        .map(d => `${d.id}=${(d.data().pL ?? 0).toFixed(3)}`).join(', ');
      console.log(`   예: ${sample}${knowledge.size > 5 ? ' …' : ''}`);
    }

    if (APPLY) {
      for (let i = 0; i < knowledge.docs.length; i += 400) {
        const batch = db.batch();
        knowledge.docs.slice(i, i + 400).forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
      // 진단검사는 "다시 볼 수 있게"만 하고 나머지 진행 상태는 건드리지 않는다
      for (const d of withDiag) {
        await d.ref.update({
          diagnosticDone: admin.firestore.FieldValue.delete(),
          diagnosticAt: admin.firestore.FieldValue.delete(),
        });
      }
    }

    totalKnowledge += knowledge.size;
    totalUnits += withDiag.length;
  }

  console.log(`\n합계: 이해도 ${totalKnowledge}개, 진단검사 표시 ${totalUnits}개`);
  console.log(APPLY
    ? '✅ 삭제 완료. 다음 학습부터 깨끗한 관측으로 다시 쌓입니다.'
    : '\n실제로 지우려면: node reset-knowledge.js --apply');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
