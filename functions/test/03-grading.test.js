/* ============================================================
   채점 응답 검증과 점수 집계 (S-13 / S-12 / S-10)

   여기서 지키는 것:
   - AI가 이상한 score를 줘도 NaN이 Firestore로 새 나가지 않는다
   - 한 문항이 배점보다 많이 가져가지 못한다
   - 학생이 답하지 않은 문항에는 한 점도 붙지 않는다
   ============================================================ */
const H = require('./_harness');
const { test, assert, throws, replyTimes, resetQueue, auth, logsWith } = H;
const fn = require('../index.js');

const UNIT = '뉴턴 운동 법칙';

/* 틀린 문장 2개(q1,q2) + 옳은 문장 3개. 배점 = 100/2 = 50점. */
function makeQuestions() {
  return [
    { id: 1, text: '무거운 쪽이 더 센 힘을 준다', isWrong: true,  targetMisconceptionIds: ['AR1', 'AR2'] },
    { id: 2, text: '힘이 쌓이면 가속도가 커진다', isWrong: true,  targetMisconceptionIds: ['I4'] },
    { id: 3, text: '두 물체가 주고받는 힘은 같다', isWrong: false, targetMisconceptionIds: [] },
    { id: 4, text: '가속도는 F/m 이다',           isWrong: false, targetMisconceptionIds: [] },
    { id: 5, text: '알짜힘이 0이면 등속이다',      isWrong: false, targetMisconceptionIds: [] },
  ];
}

/** 채점 한 번 돌리기. aiItems가 그대로 AI 응답이 된다. */
async function grade(aiItems, answers, { attempts = 1 } = {}) {
  resetQueue();
  replyTimes({ items: aiItems }, attempts);
  return fn.gradeAnswers.run({
    data: { answers, questions: makeQuestions(), unit: UNIT },
    auth: auth(),
  });
}

const answeredQ1 = [{ questionId: 1, reason: '작용반작용이라 크기가 같습니다' }];

/* ── 정상 경로 ─────────────────────────────────────────── */

test('정상 점수는 5점 단위로 반올림된다', async () => {
  const r = await grade([{ questionId: 1, score: 33, isCorrectAnswer: true, explanation: 'ok' }], answeredQ1);
  assert.strictEqual(r.score, 35, `33점 → 35점이어야 하는데 ${r.score}`);
});

test('문자열 숫자("33")도 통과한다 — 흔한 응답이라 실패시키지 않는다', async () => {
  const r = await grade([{ questionId: 1, score: '33', isCorrectAnswer: true, explanation: 'ok' }], answeredQ1);
  assert.strictEqual(r.score, 35);
});

test('문자열 문항번호("1")도 통과한다', async () => {
  const r = await grade([{ questionId: '1', score: 50, isCorrectAnswer: true, explanation: 'ok' }], answeredQ1);
  assert.strictEqual(r.score, 50);
});

test('score가 null이면 0점으로 본다 (미답변의 정상 값)', async () => {
  const r = await grade([{ questionId: 1, score: null, isCorrectAnswer: false, explanation: 'x' }], answeredQ1);
  assert.strictEqual(r.score, 0);
});

test('score 필드가 아예 없어도 0점으로 본다', async () => {
  const r = await grade([{ questionId: 1, isCorrectAnswer: false, explanation: 'x' }], answeredQ1);
  assert.strictEqual(r.score, 0);
});

/* ── NaN 차단 (S-13의 핵심) ────────────────────────────── */

test('score가 "만점"이면 재시도를 다 쓰고 실패한다 — NaN을 저장하지 않는다', async () => {
  const err = await throws(
    () => grade([{ questionId: 1, score: '만점', explanation: 'x' }], answeredQ1, { attempts: 3 }),
    'score가 숫자가 아님',
    'score:"만점"'
  );
  assert.ok(!String(err.message).includes('NaN'), 'NaN이 메시지에 새어나오면 안 된다');
});

test('score가 객체({})면 실패한다', async () => {
  await throws(
    () => grade([{ questionId: 1, score: {}, explanation: 'x' }], answeredQ1, { attempts: 3 }),
    'score가 숫자가 아님'
  );
});

test('questionId가 숫자로 안 바뀌면 실패한다', async () => {
  await throws(
    () => grade([{ questionId: '일번', score: 50 }], answeredQ1, { attempts: 3 }),
    'questionId가 숫자가 아님'
  );
});

test('학생이 답한 문항이 채점에서 빠지면 실패한다', async () => {
  await throws(
    () => grade([{ questionId: 2, score: 50 }], answeredQ1, { attempts: 3 }),
    '채점 누락 문항'
  );
});

test('items가 배열이 아니면 실패한다', async () => {
  resetQueue();
  replyTimes({ items: '문자열' }, 3);
  await throws(
    () => fn.gradeAnswers.run({
      data: { answers: answeredQ1, questions: makeQuestions(), unit: UNIT },
      auth: auth(),
    }),
    'items 배열 누락'
  );
});

test('explanation이 문자열이 아니면 버리고 기본 문구로 떨어진다', async () => {
  const r = await grade(
    [{ questionId: 1, score: 50, isCorrectAnswer: true, explanation: { bad: 1 } }],
    answeredQ1
  );
  const item = r.items.find(i => i.id === 1);
  assert.strictEqual(item.explanation, '설명이 누락되었습니다.');
  assert.ok(!item.explanation.includes('object'), '[object Object]가 화면에 나가면 안 된다');
});

/* ── 점수 상한·하한 (S-12) ────────────────────────────── */

test('한 문항이 배점(50점)보다 많이 가져가지 못한다', async () => {
  const r = await grade([{ questionId: 1, score: 100, isCorrectAnswer: true }], answeredQ1);
  assert.strictEqual(r.score, 50, `배점 50으로 잘려야 하는데 ${r.score}`);
});

test('인젝션으로 999점이 붙어도 배점을 넘지 못한다', async () => {
  const r = await grade([{ questionId: 1, score: 999, isCorrectAnswer: true }], answeredQ1);
  assert.strictEqual(r.score, 50);
});

test('음수 점수는 0으로 막는다', async () => {
  const r = await grade([{ questionId: 1, score: -80, isCorrectAnswer: true }], answeredQ1);
  assert.strictEqual(r.score, 0);
});

test('총점은 0~100을 벗어나지 않는다', async () => {
  const r = await grade([
    { questionId: 1, score: 500, isCorrectAnswer: true },
    { questionId: 2, score: 500, isCorrectAnswer: true },
  ], [
    { questionId: 1, reason: 'a' },
    { questionId: 2, reason: 'b' },
  ]);
  assert.ok(r.score >= 0 && r.score <= 100, `범위를 벗어남: ${r.score}`);
  assert.strictEqual(r.score, 100);
});

/* ── 미답변·헛다리 (S-10) ─────────────────────────────── */

test('답하지 않은 문항에 AI가 점수를 줘도 총점에 안 들어간다', async () => {
  const r = await grade([
    { questionId: 1, score: 50, isCorrectAnswer: true },
    { questionId: 2, score: 50, isCorrectAnswer: true },   // ← 학생은 2번을 안 썼다
  ], answeredQ1);
  assert.strictEqual(r.score, 50, `2번 점수가 새어들어감 (${r.score})`);
});

test('아무것도 안 쓴 문항은 정답으로 세지 않는다', async () => {
  const r = await grade([
    { questionId: 1, score: 50, isCorrectAnswer: true },
    { questionId: 2, score: 50, isCorrectAnswer: true },
  ], answeredQ1);
  const q2 = r.items.find(i => i.id === 2);
  assert.strictEqual(q2.isCorrectAnswer, false, '미답변 문항이 정답 처리됐다');
});

test('옳은 문장을 틀렸다고 고르면 배점의 절반을 깎는다', async () => {
  const r = await grade([
    { questionId: 1, score: 50, isCorrectAnswer: true },
    { questionId: 3, score: 0 },
  ], [
    { questionId: 1, reason: '작용반작용' },
    { questionId: 3, reason: '이것도 틀린 것 같습니다' },   // ← 옳은 문장을 고름 (헛다리)
  ]);
  assert.strictEqual(r.score, 25, `50 - 25 = 25여야 하는데 ${r.score}`);
});

/* ── 라벨 대조 (설계 8-7) ─────────────────────────────── */

test('생성과 채점의 라벨이 갈리면 가점도 감점도 하지 않는다', async () => {
  const r = await grade(
    [{ questionId: 1, score: 50, isCorrectAnswer: true, statementIsWrong: false }],
    answeredQ1
  );
  assert.strictEqual(r.score, 0, '갈린 문항에 점수가 붙었다');
  assert.strictEqual(r.mismatchCount, 1);
});

test('라벨이 갈린 문항은 이해도 관측에서 빠진다', async () => {
  const r = await grade(
    [{ questionId: 1, score: 50, isCorrectAnswer: true, statementIsWrong: false }],
    answeredQ1
  );
  const q1 = r.items.find(i => i.id === 1);
  assert.deepStrictEqual(q1.targetMisconceptionIds, [], '갈린 문항에 태그가 남아 있다');
});

/* ── 개념별 판정 (설계 4-12) ──────────────────────────── */

test('다중 태그 문항은 오개념마다 따로 판정된다', async () => {
  const r = await grade([{
    questionId: 1, score: 50, isCorrectAnswer: true,
    conceptJudgments: [
      { misconceptionId: 'AR1', understood: true },
      { misconceptionId: 'AR2', understood: false },
    ],
  }], answeredQ1);
  const q1 = r.items.find(i => i.id === 1);
  assert.strictEqual(q1.conceptJudgments.length, 2);
  const values = q1.conceptJudgments.map(j => j.understood);
  assert.deepStrictEqual(values, [true, false], '개념별 판정이 갈리지 않았다');
});

test('AI가 판정을 빠뜨린 오개념은 문항 전체 판정으로 채운다', async () => {
  const r = await grade([{
    questionId: 1, score: 50, isCorrectAnswer: true,
    conceptJudgments: [{ misconceptionId: 'AR1', understood: false }],
  }], answeredQ1);
  const q1 = r.items.find(i => i.id === 1);
  const ar2 = q1.conceptJudgments.find(j => j.misconceptionId === 'AR2');
  assert.strictEqual(ar2.understood, true, '빠진 판정이 문항 판정으로 안 채워졌다');
});

test('답을 안 쓴 문항은 태그 전부가 "이해 못 함"이 된다', async () => {
  const r = await grade([
    { questionId: 1, score: 50, isCorrectAnswer: true },
    { questionId: 2, score: 0, isCorrectAnswer: true, conceptJudgments: [{ misconceptionId: 'I4', understood: true }] },
  ], answeredQ1);
  const q2 = r.items.find(i => i.id === 2);
  assert.strictEqual(q2.conceptJudgments[0].understood, false, '안 쓴 문항으로 이해도가 올랐다');
});

/* ── 측정 로그 (논문 실측치의 출처) ───────────────────────
   화면에 안 보이는 값이라 코드를 고치다 조용히 사라져도 아무도 모른다. 로그 자체를 지킨다. */

test('개념별 판정 로그에 갈린 건수가 찍힌다', async () => {
  await grade([{
    questionId: 1, score: 50, isCorrectAnswer: true,
    conceptJudgments: [
      { misconceptionId: 'AR1', understood: true },
      { misconceptionId: 'AR2', understood: false },
    ],
  }], answeredQ1);
  const line = logsWith('개념별 판정');
  assert.strictEqual(line.length, 1, '개념별 판정 로그가 안 찍혔다');
  assert.ok(line[0].text.includes('1문항 중 1건'), `건수가 틀림: ${line[0].text}`);
});

test('미답변 가점 차단 로그에 버린 점수가 남는다', async () => {
  await grade([
    { questionId: 1, score: 50, isCorrectAnswer: true },
    { questionId: 2, score: 50, isCorrectAnswer: true },
  ], answeredQ1);
  const line = logsWith('미답변 문항 가점 차단');
  assert.strictEqual(line.length, 1, '미답변 가점 차단 로그가 안 찍혔다');
});

test('라벨 대조 불일치 로그가 남는다', async () => {
  await grade(
    [{ questionId: 1, score: 50, isCorrectAnswer: true, statementIsWrong: false }],
    answeredQ1
  );
  assert.strictEqual(logsWith('라벨 대조 불일치').length, 1);
});

test('정상 채점에서는 경고 로그가 하나도 안 나온다', async () => {
  await grade([{ questionId: 1, score: 50, isCorrectAnswer: true, explanation: 'ok' }], answeredQ1);
  assert.strictEqual(logsWith('라벨 대조 불일치').length, 0);
  assert.strictEqual(logsWith('미답변 문항 가점 차단').length, 0);
});
