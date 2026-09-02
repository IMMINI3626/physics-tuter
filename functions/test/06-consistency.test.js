/* ============================================================
   파일 사이의 약속이 어긋나지 않았는가

   여기 있는 것들은 전부 "한쪽만 고치면 조용히 깨지는" 짝이다. 코드는 멀쩡히 돌아가고
   오류도 안 나는데 기능만 안 된다 — 실제로 겪은 종류만 골라 담았다.
   ============================================================ */
const fs = require('fs');
const path = require('path');
const H = require('./_harness');
const { test, assert } = H;

const ROOT = path.join(__dirname, '..', '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const RULES = read('firestore.rules');
const FIRESTORE_JS = read('public', 'firebase', 'firestore.js');
const INDEX_HTML = read('public', 'index.html');
const BKT_JS = read('public', 'js', 'bkt.js');
const INDEX_JS = read('functions', 'index.js');
const FEEDBACK_JS = read('public', 'js', 'feedback.js');

/* ── 신고 문서: 규칙 ↔ 클라이언트 (S-11) ─────────────────
   firestore.rules의 hasOnly 목록과 submitQuestionReport가 실제로 쓰는 필드가 1:1이 아니면
   신고가 통째로 거부된다. 규칙 파일에도 "한쪽만 바꾸면 조용히 깨진다"고 적혀 있는 자리다. */

function rulesReportFields() {
  const block = RULES.slice(RULES.indexOf('hasOnly(['));
  const list = block.slice(0, block.indexOf('])'));
  return [...list.matchAll(/'([a-zA-Z]+)'/g)].map(m => m[1]).sort();
}

function clientReportFields() {
  const start = FIRESTORE_JS.indexOf("addDoc(collection(db, 'question_reports')");
  assert.ok(start !== -1, 'submitQuestionReport에서 addDoc을 못 찾았다');
  const body = FIRESTORE_JS.slice(start, FIRESTORE_JS.indexOf('});', start));
  return [...body.matchAll(/^\s{6}([a-zA-Z]+)\s*[,:]/gm)].map(m => m[1]).sort();
}

test('신고 문서 필드가 규칙과 클라이언트에서 같다', () => {
  assert.deepStrictEqual(clientReportFields(), rulesReportFields(),
    '한쪽만 바뀌면 신고가 화면에서 "전송에 실패했어요"로만 보인다');
});

test('규칙의 필수 필드를 클라이언트가 전부 보낸다', () => {
  const block = RULES.slice(RULES.indexOf('hasAll(['));
  const required = [...block.slice(0, block.indexOf('])')).matchAll(/'([a-zA-Z]+)'/g)].map(m => m[1]);
  const sent = clientReportFields();
  const missing = required.filter(f => !sent.includes(f));
  assert.deepStrictEqual(missing, [], `클라이언트가 안 보내는 필수 필드: ${missing.join(', ')}`);
});

test('신고 사유 코드가 규칙과 화면에서 같다', () => {
  const inRules = [...RULES.slice(RULES.indexOf('d.reason in ['))
    .slice(0, 300).matchAll(/'([a-z_]+)'/g)].map(m => m[1]).sort();
  const inCode = [...FEEDBACK_JS.matchAll(/code:\s*'([a-z_]+)'/g)].map(m => m[1]).sort();
  assert.ok(inRules.length >= 6, `규칙에서 사유를 ${inRules.length}개만 찾았다`);
  if (inCode.length) {
    const unknown = inCode.filter(c => !inRules.includes(c));
    assert.deepStrictEqual(unknown, [], `규칙이 모르는 사유: ${unknown.join(', ')} — 신고가 거부된다`);
  }
});

/* 신고 규칙의 길이 상한 ↔ 서버 입력 상한.
   신고에 실리는 userReason은 L3에서 "풀이 과정 전체"다. 서버가 받아주는 길이(processText)가
   신고 규칙 상한보다 커지면, 그 길이로 채점받은 학생은 신고를 못 하게 된다 — 화면에는
   "전송에 실패했어요"만 뜬다. 지금 두 값이 우연히 같아서 여유가 0이라 특히 위험하다. */
test('신고 규칙이 서버가 받아주는 풀이 길이를 담을 수 있다', () => {
  const ruleMax = Number(RULES.match(/'userReason',\s*(\d+)/)[1]);
  const serverMax = Number(INDEX_JS.match(/processText:\s*(\d+)/)[1]);
  assert.ok(ruleMax >= serverMax,
    `서버는 풀이를 ${serverMax}자까지 받는데 신고 규칙은 ${ruleMax}자까지만 받는다 — ` +
    `그 사이 길이로 채점받은 학생은 신고를 못 한다`);
});

test('클라이언트가 신고 값을 규칙 상한에 맞춰 자른다', () => {
  const start = FIRESTORE_JS.indexOf('submitQuestionReport');
  const body = FIRESTORE_JS.slice(start, FIRESTORE_JS.indexOf('});', start));
  assert.ok(/userReason:\s*cut\(/.test(body),
    '옛 기록의 긴 서술이 그대로 나가면 규칙이 신고를 통째로 거부한다');
  assert.ok(/explanation:\s*cut\(/.test(body),
    'AI가 쓴 해설은 길이를 우리가 정하지 않는다 — 잘라야 한다');
});

test('기타 사유 입력칸 길이가 규칙 상한과 같다', () => {
  assert.ok(RULES.includes("str(d, 'detail',        300)") || /'detail',\s*300/.test(RULES),
    '규칙의 detail 상한이 300이 아니다');
  assert.ok(/id="report-etc"[^>]*maxlength="300"/s.test(INDEX_HTML),
    '입력칸 maxlength가 규칙 상한(300)과 다르다 — 300자를 넘겨 쓰면 거부된다');
});

/* ── BKT 상수 (설계 4-3) ─────────────────────────────────
   논문이 보고하는 값이다. 조용히 바뀌면 실험 조건이 문서와 달라진다. */

test('BKT 파라미터가 설계 문서 값과 같다', () => {
  const want = { pT: '0.15', pG: '0.20', pS: '0.10' };
  Object.entries(want).forEach(([k, v]) => {
    const m = BKT_JS.match(new RegExp(`${k}:\\s*([0-9.]+)`));
    assert.ok(m, `${k}를 못 찾았다`);
    assert.strictEqual(m[1], v, `${k}가 바뀌었다 (${m[1]}) — 논문 보고값은 ${v}`);
  });
});

test('숙달 기준과 사전확률이 설계 문서 값과 같다', () => {
  assert.ok(/MASTERY:\s*0\.90/.test(BKT_JS), '숙달 기준이 0.90이 아니다');
  assert.ok(/weak:\s*0\.15/.test(BKT_JS), 'weak 사전확률이 0.15가 아니다');
  assert.ok(/unknown:\s*0\.30/.test(BKT_JS), 'unknown 사전확률이 0.30이 아니다');
  assert.ok(/HINT_GUESS:\s*0\.50/.test(BKT_JS), '힌트 추측률이 0.50이 아니다');
  assert.ok(/DIAGNOSTIC_GUESS:\s*0\.50/.test(BKT_JS), '진단검사 추측률이 0.50이 아니다');
});

test('틀린 문장 상한이 설계 문서 값(3)과 같다', () => {
  const m = INDEX_JS.match(/const MAX_WRONG = (\d+)/);
  assert.strictEqual(m[1], '3', '틀린 문장 상한이 바뀌었다 — 설계 4-12의 측정 조건이다');
});

test('일일 호출 상한이 문서 값과 같다', () => {
  assert.ok(/guest:\s*40/.test(INDEX_JS), '게스트 상한이 40이 아니다');
  assert.ok(/member:\s*400/.test(INDEX_JS), '로그인 상한이 400이 아니다');
});

/* ── 서버 상한 ↔ 화면 입력칸 (S-11) ─────────────────────
   서버가 2000자에서 자르는데 입력칸이 더 길면, 학생은 다 쓰고 나서야 거부당한다. */

test('L3 풀이 입력칸이 서버 상한(2000)과 같다', () => {
  assert.ok(/processText:\s*2000/.test(INDEX_JS), '서버 상한이 2000이 아니다');
  const boxes = [...INDEX_HTML.matchAll(/l3-(?:text-input|review-textarea)[^>]*?maxlength="(\d+)"/gs)]
    .map(m => Number(m[1]));
  boxes.forEach(n => assert.ok(n <= 2000, `입력칸이 서버 상한보다 길다 (${n}자)`));
});

test('L3 답 입력칸이 서버 상한(60)과 같다', () => {
  assert.ok(/answerText:\s*60/.test(INDEX_JS), '서버 answerText 상한이 60이 아니다');
  const boxes = [...INDEX_HTML.matchAll(/l3-(?:answer-text-input|review-answer-input)[^>]*?maxlength="(\d+)"/gs)]
    .map(m => Number(m[1]));
  assert.ok(boxes.length > 0, 'L3 답 입력칸의 maxlength를 못 찾았다');
  boxes.forEach(n => assert.ok(n <= 60, `답 입력칸이 서버 상한보다 길다 (${n}자)`));
});

/* ── 배포 설정 ──────────────────────────────────────── */

test('시험 폴더는 배포에 실리지 않는다', () => {
  const cfg = JSON.parse(read('firebase.json'));
  const ignore = cfg.functions?.ignore || (cfg.functions?.[0]?.ignore) || [];
  assert.ok(ignore.some(p => p.includes('test')),
    'firebase.json의 functions.ignore에 test가 없다 — 시험 코드가 배포된다');
});

test('package.json에 시험 명령이 있다', () => {
  const pkg = JSON.parse(read('functions', 'package.json'));
  assert.ok(pkg.scripts?.test, 'npm test가 없다');
  assert.ok(pkg.scripts.test.includes('test/run.js'));
});

/* ── Node 런타임 ─────────────────────────────────────────
   런타임이 firebase.json과 package.json 두 곳에 적혀 있다. 어긋나면 배포는 되는데 실제로는
   다른 버전에서 돌아간다. 그리고 폐기된 런타임은 그날부터 배포 자체가 막힌다. */

const RUNTIME_DECOMMISSION = {   // firebase-tools의 supported/types.js 값
  nodejs18: '2025-01-30', nodejs20: '2026-10-30',
  nodejs22: '2028-10-31', nodejs24: '2028-10-31',
};

test('firebase.json과 package.json의 Node 버전이 같다', () => {
  const runtime = JSON.parse(read('firebase.json')).functions.runtime;   // 예: nodejs22
  const engine = JSON.parse(read('functions', 'package.json')).engines.node;   // 예: 22
  assert.strictEqual(runtime, `nodejs${engine}`,
    `런타임이 어긋났다 (firebase.json ${runtime} / package.json ${engine})`);
});

test('package-lock.json도 같은 Node 버전을 가리킨다', () => {
  const lock = JSON.parse(read('functions', 'package-lock.json'));
  const engine = JSON.parse(read('functions', 'package.json')).engines.node;
  assert.strictEqual(lock.packages[''].engines.node, engine,
    'lock 파일이 옛 버전을 들고 있다 — npm install 때 경고가 난다');
});

test('폐기됐거나 곧 폐기될 런타임을 쓰지 않는다', () => {
  const runtime = JSON.parse(read('firebase.json')).functions.runtime;
  const end = RUNTIME_DECOMMISSION[runtime];
  assert.ok(end, `모르는 런타임이다: ${runtime}`);
  const daysLeft = Math.round((new Date(end) - Date.now()) / 86400000);
  assert.ok(daysLeft > 90,
    `${runtime}이 ${end}에 폐기된다 (${daysLeft}일 남음). 그날 이후 배포가 막힌다`);
});
