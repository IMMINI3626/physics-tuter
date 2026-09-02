/* ============================================================
   프롬프트 바이트 스냅샷

   왜 필요한가:
   프롬프트는 AI 동작을 바꾸는 가장 예민한 부분인데, 바뀌어도 코드는 멀쩡히 돌아간다. 규칙 한
   줄을 여러 프롬프트에 넣다가 엉뚱한 곳까지 건드려도 아무 오류가 안 난다 — 출제 품질이 조용히
   떨어지고 몇 주 뒤에나 눈치챈다. 그래서 같은 입력에 같은 글자가 나오는지를 해시로 고정한다.

   프롬프트를 **일부러** 고쳤다면 기준을 다시 만들면 된다:
       npm run test:update

   그때 이 시험이 알려주는 것은 "바뀌었다"가 아니라 **"어디가 바뀌었다"**이다. 의도한 파일만
   바뀌었는지 목록으로 확인하고 커밋하면 된다.
   ============================================================ */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const H = require('./_harness');
const { test, assert } = H;
const P = require('../prompts');

const SNAPSHOT_PATH = path.join(__dirname, 'prompts.snapshot.json');
/* 🔑 `VAR=1 node ...` 형태는 Windows의 cmd에서 안 돈다(npm이 거기서 명령을 실행한다).
   그래서 환경변수가 아니라 명령 인자로 받는다. */
const UPDATE = process.argv.includes('--update') || process.env.UPDATE_SNAPSHOT === '1';

/* 고정 입력. 이 값을 바꾸면 해시가 전부 바뀌므로 함부로 손대지 말 것. */
const FIXED = {
  unit: '뉴턴 운동 법칙',
  mcText: '1. [id: AR1 | 영역: AR] 무거운 물체가 더 큰 힘을 가한다',
  list: '1. 무거운 쪽이 더 센 힘을 준다\n2. 가속도는 F/m 이다',
  questionText: '질량 2kg 물체에 4N의 힘이 작용할 때 가속도는?',
  stepsText: '1) F=ma 적용  2) a = 4/2',
  processText: 'F=ma 이므로 a는 2입니다',
  conceptBlock: '[문장 1]\n  - AR1: 무거운 물체가 더 큰 힘을 가한다',
  questionListText: '[문장 1] 무거운 쪽이 더 센 힘을 준다',
  answerText: '작용반작용이라 크기가 같습니다',
};

/* 프롬프트를 만들어내는 모든 경로. 새 경로를 추가하면 여기에도 넣어야 한다. */
function buildAll() {
  return {
    verifyStatements: P.verifyStatements({ unit: FIXED.unit, list: FIXED.list }),

    extractKeywords: P.extractKeywords({ dbMisconceptions: FIXED.mcText }),

    recognizeSolution: P.recognizeSolution(),

    'statementSet(Level1)': P.statementSet({
      unit: FIXED.unit, mcText: FIXED.mcText,
      priorityInstruction: '', patternInstruction: '',
      wrongExamples: '무거운 쪽이 세다', correctExamples: '힘의 크기는 같다',
      randomAngle: '일상 상황', varietySeed: 'abc123',
      wrongCount: 2, rightCount: 3, levelInstruction: P.LEVEL1_INSTRUCTION,
    }),

    'statementSet(Level2A)': P.statementSet({
      unit: FIXED.unit, mcText: FIXED.mcText,
      priorityInstruction: '', patternInstruction: '',
      wrongExamples: '무거운 쪽이 세다', correctExamples: '힘의 크기는 같다',
      randomAngle: '일상 상황', varietySeed: 'abc123',
      wrongCount: 2, rightCount: 3, levelInstruction: P.LEVEL2A_INSTRUCTION,
    }),

    'calcQuestion(L3)': P.calcQuestion({
      isLevel3: true, unit: FIXED.unit, mcText: FIXED.mcText,
      priorityInstruction: '', patternInstruction: '',
    }),

    'calcQuestion(L2B)': P.calcQuestion({
      isLevel3: false, unit: FIXED.unit, mcText: FIXED.mcText,
      priorityInstruction: '', patternInstruction: '',
    }),

    'gradeSolutionProcess(답 있음)': P.gradeSolutionProcess({
      questionText: FIXED.questionText, correctAnswer: '2', unit: 'm/s²',
      stepsText: FIXED.stepsText, processText: FIXED.processText, answerText: '2',
    }),

    'gradeSolutionProcess(답 없음)': P.gradeSolutionProcess({
      questionText: FIXED.questionText, correctAnswer: '2', unit: 'm/s²',
      stepsText: FIXED.stepsText, processText: FIXED.processText, answerText: null,
    }),

    'gradeAnswers(개념 판정 있음)': P.gradeAnswers({
      unit: FIXED.unit, questionListText: FIXED.questionListText, answerText: FIXED.answerText,
      targetWrongCount: 2, maxScorePerItem: 50, partialScoreRange: '10~30점',
      conceptBlock: FIXED.conceptBlock,
    }),

    'gradeAnswers(개념 판정 없음)': P.gradeAnswers({
      unit: FIXED.unit, questionListText: FIXED.questionListText, answerText: FIXED.answerText,
      targetWrongCount: 1, maxScorePerItem: 100, partialScoreRange: '20~60점',
      conceptBlock: '',
    }),

    patternBlock: P.patternBlock('1. [충돌] 두 물체가 부딪힘'),

    priorityBlock: P.priorityBlock(['AR1'], [
      { id: 'AR1', dimensionCode: 'AR', description: '무거운 물체가 더 큰 힘을 가한다' },
    ]),
  };
}

const hash = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 16);

const built = buildAll();
const current = {};
Object.entries(built).forEach(([name, text]) => {
  current[name] = { hash: hash(text), length: text.length };
});

if (UPDATE) {
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(current, null, 2) + '\n', 'utf8');
  console.log(`\n  기준을 새로 만들었습니다 → ${path.basename(SNAPSHOT_PATH)} (${Object.keys(current).length}개)\n`);
}

const saved = fs.existsSync(SNAPSHOT_PATH)
  ? JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'))
  : null;

test('기준 파일이 있다', () => {
  assert.ok(saved, `기준이 없습니다. 한 번 만들어 두세요:  npm run test:update`);
});

test('프롬프트 경로가 하나도 사라지지 않았다', () => {
  if (!saved) return;
  const gone = Object.keys(saved).filter(k => !(k in current));
  assert.deepStrictEqual(gone, [], `프롬프트 경로가 없어졌습니다: ${gone.join(', ')}`);
});

test('새 프롬프트 경로는 기준에 등록되어 있다', () => {
  if (!saved) return;
  const added = Object.keys(current).filter(k => !(k in saved));
  assert.deepStrictEqual(added, [],
    `기준에 없는 경로: ${added.join(', ')} — 의도한 것이면 npm run test:update`);
});

/* 경로마다 시험을 하나씩 만든다 — 어디가 바뀌었는지 이름으로 바로 보이게 */
Object.keys(built).forEach((name) => {
  test(`프롬프트가 그대로다 — ${name}`, () => {
    if (!saved || !saved[name]) return;
    const before = saved[name];
    const after = current[name];
    assert.strictEqual(
      after.hash, before.hash,
      `프롬프트가 바뀌었습니다 (길이 ${before.length} → ${after.length}자). ` +
      `의도한 변경이면:  npm run test:update`
    );
  });
});

/* 프롬프트가 비어버리는 사고 방지 — 해시는 맞아도 내용이 없으면 의미가 없다 */
test('모든 프롬프트가 비어 있지 않다', () => {
  Object.entries(built).forEach(([name, text]) => {
    assert.ok(typeof text === 'string', `${name}이 문자열이 아니다`);
    if (name === 'patternBlock' || name === 'priorityBlock') return;   // 조건부로 빈 값이 정상
    assert.ok(text.length > 200, `${name}이 너무 짧다 (${text.length}자)`);
  });
});
