/* ============================================================
   문항 신고 조회 스크립트 (설계 단계 9-1)

   왜 스크립트인가:
   신고는 Firestore 규칙에서 "만들기"만 열려 있고 읽기는 막혀 있다. 학생끼리 남의 신고를
   볼 이유가 없고, 신고 문서에는 그 사람이 쓴 답변까지 들어간다. 검토는 관리자 SDK로만 한다.

   사용법:
     node list-reports.js              → 최근 50건
     node list-reports.js --all        → 전부
     node list-reports.js --unit "특수 상대성 이론"
     node list-reports.js --summary    → 사유별·단원별 집계만 (논문 표용)
   ============================================================ */
const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};

const REASON_LABEL = {
  label_should_be_correct: '문장이 맞는 것 같다 (라벨 반대)',
  label_should_be_wrong:   '문장이 틀린 것 같다 (라벨 반대)',
  bad_explanation:         '해설이 이상하다',
  bad_grading:             '채점이 잘못됐다',
  unclear:                 '문제가 이해가 안 된다',
  etc:                     '기타 (직접 입력)',
};

function fmtDate(ts) {
  if (!ts?.toDate) return '-';
  const d = ts.toDate();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function tally(rows, key, label) {
  const counts = {};
  rows.forEach(r => { const k = r[key] || '(없음)'; counts[k] = (counts[k] || 0) + 1; });
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  console.log(`\n${label}`);
  sorted.forEach(([k, n]) => {
    const pct = Math.round(n / rows.length * 100);
    console.log(`  ${String(n).padStart(4)}건 (${String(pct).padStart(3)}%)  ${REASON_LABEL[k] || k}`);
  });
}

async function main() {
  const unitFilter = valueOf('--unit');
  const cap = (!has('--all') && !has('--summary')) ? 50 : null;

  /* 🔑 예전엔 --unit을 주면 쿼리를 통째로 새로 만들면서 orderBy를 잃었다. 그래서 단원을
     지정하면 "최근 50건"이 아니라 임의의 50건이 나왔다(논문 표본이 틀어지는 문제).
     where + orderBy를 함께 쓰면 복합 인덱스를 요구하므로, 필터가 있을 때는 정렬·자르기를
     메모리에서 한다 — public/firebase/firestore.js의 fetchSessionsByUnit과 같은 이유다.
     신고 건수는 사람이 검토할 규모라 전량을 읽어도 부담이 없다. */
  let q = db.collection('question_reports');
  if (unitFilter) {
    q = q.where('unit', '==', unitFilter);
  } else {
    q = q.orderBy('createdAt', 'desc');
    if (cap) q = q.limit(cap);
  }

  const snap = await q.get();
  let rows = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  if (unitFilter) {
    rows.sort((a, b) => (b.createdAt?.toMillis?.() || 0) - (a.createdAt?.toMillis?.() || 0));
    if (cap) rows = rows.slice(0, cap);
  }

  if (!rows.length) {
    console.log('신고가 없습니다.');
    return;
  }

  console.log(`총 ${rows.length}건${unitFilter ? ` (단원: ${unitFilter})` : ''}\n`);
  tally(rows, 'reason', '── 사유별 ──');
  tally(rows, 'unit', '── 단원별 ──');

  if (has('--summary')) return;

  console.log(`\n${'═'.repeat(76)}`);
  rows.forEach((r, i) => {
    console.log(`\n[${i + 1}] ${fmtDate(r.createdAt)}  ${r.unit || '-'} · L${r.level || '?'}`);
    console.log(`    사유: ${REASON_LABEL[r.reason] || r.reason}`);
    if (r.detail) console.log(`    적은 내용: ${r.detail}`);
    console.log(`    문장: ${r.questionText}`);
    console.log(`    시스템 판정: ${r.isWrong ? '틀린 문장' : '옳은 문장'}` +
                (r.targetMisconceptionId ? ` · 겨냥 오개념 ${r.targetMisconceptionId}` : ''));
    if (r.userReason) console.log(`    학생 답변: ${r.userReason}`);
    console.log(`    학생이 본 해설: ${(r.explanation || '').slice(0, 160)}`);
  });

  console.log(`\n${'═'.repeat(76)}`);
  console.log('신고가 몰린 문장은 seed.js(판별 문장) 또는 생성/채점 프롬프트를 고쳐야 합니다.');
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
