/* ============================================================
   클라이언트 스크립트 (public/js/*.js)

   왜 이렇게까지 하나:
   이 파일들은 빌드 도구 없이 <script>로 그냥 올라간다. 최상위 const는 window에 붙지 않고
   **전역 렉시컬 스코프**에 산다 — 다른 파일에서는 보이지만 `window.X`로는 안 보인다. 그래서
   "app.js로 함수를 옮겼는데 quiz.js에서 안 보인다" 같은 사고가 실제로 나고, 브라우저를 켜야만
   드러난다. 여기서는 vm으로 **한 realm에 index.html과 같은 순서로** 올려 그 관계를 그대로
   재현한다.

   Level 3 사진 업로드가 압축을 건너뛰던 사고(S-13)가 정확히 이 종류였다.
   ============================================================ */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const H = require('./_harness');
const { test, assert } = H;

const PUBLIC = path.join(__dirname, '..', '..', 'public');
const INDEX_HTML = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

/* index.html이 부르는 순서 그대로 읽는다 — 목록을 손으로 적어두면 실제 순서와 어긋난다 */
const SCRIPTS = [...INDEX_HTML.matchAll(/<script src="(js\/[^"]+)"><\/script>/g)].map(m => m[1]);

/* ── 최소 브라우저 흉내 ────────────────────────────────── */
function makeSandbox() {
  const noop = () => {};
  const el = () => ({
    style: {}, classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
    addEventListener: noop, removeEventListener: noop, appendChild: noop,
    setAttribute: noop, removeAttribute: noop, querySelector: () => null,
    querySelectorAll: () => [], click: noop, focus: noop, remove: noop,
    value: '', textContent: '', innerHTML: '', disabled: false, files: [],
    getContext: () => ({
      fillRect: noop, drawImage: noop, clearRect: noop, beginPath: noop,
      moveTo: noop, lineTo: noop, stroke: noop, scale: noop,
      set fillStyle(v) {}, set strokeStyle(v) {}, set lineWidth(v) {},
    }),
    /* 캔버스 크기를 그대로 담고, toDataURL은 "이 크기로 인코딩했다"는 사실만 돌려준다.
       실제 JPEG 인코딩은 여기서 확인할 수 없지만, 축소가 됐는지는 크기로 확인할 수 있다. */
    width: 0, height: 0,
    toDataURL(type) { return `data:${type};base64,W${this.width}xH${this.height}`; },
    getBoundingClientRect: () => ({ width: 300, height: 200, left: 0, top: 0 }),
  });

  const documentStub = {
    getElementById: () => el(),
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => el(),
    addEventListener: noop,
    body: el(),
    documentElement: el(),
  };

  const sandbox = {
    console: { log: noop, warn: noop, error: noop, info: noop },
    document: documentStub,
    localStorage: {
      _d: {},
      getItem(k) { return this._d[k] ?? null; },
      setItem(k, v) { this._d[k] = String(v); },
      removeItem(k) { delete this._d[k]; },
    },
    location: { href: 'http://localhost/', hash: '' },
    navigator: { userAgent: 'test' },
    setTimeout, clearTimeout, setInterval, clearInterval,
    Promise, Math, JSON, Date, Object, Array, String, Number, Boolean, Set, Map, Error,
    isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
    /* 폰 사진을 흉내 낸다: 4000×3000 (EXIF 회전 적용 경로) */
    createImageBitmap: async () => ({ width: 4000, height: 3000, close() {} }),
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  return sandbox;
}

/* index.html 순서 그대로 한 realm에 올린다 */
const sandbox = makeSandbox();
const context = vm.createContext(sandbox);
const loadErrors = [];
SCRIPTS.forEach((rel) => {
  const code = fs.readFileSync(path.join(PUBLIC, rel), 'utf8');
  try {
    vm.runInContext(code, context, { filename: rel });
  } catch (err) {
    loadErrors.push(`${rel}: ${err.message}`);
  }
});

/* ── 로드 자체 ─────────────────────────────────────────── */

test('index.html이 부르는 스크립트를 실제로 찾았다', () => {
  assert.ok(SCRIPTS.length >= 8, `스크립트를 ${SCRIPTS.length}개만 찾았다 — 정규식이 깨졌을 수 있다`);
});

test('모든 클라이언트 스크립트가 오류 없이 올라간다', () => {
  assert.deepStrictEqual(loadErrors, [], `로드 실패:\n${loadErrors.join('\n')}`);
});

/* 🔑 `const HomeScreen = {...}`는 window에 붙지 않는다. 브라우저에서도 마찬가지로 전역
   **렉시컬** 스코프에 살고, 다른 스크립트와 인라인 onclick에서만 보인다. 그래서 존재 확인은
   sandbox 속성이 아니라 그 스코프에서 식을 평가해서 해야 한다 — 이 차이를 헷갈리면
   "왜 window.Level3Screen이 undefined지?"에 시간을 버린다. */
const evalInPage = (expr) => vm.runInContext(expr, context);

test('화면 객체들이 전부 정의된다', () => {
  ['HomeScreen', 'KeywordScreen', 'QuizScreen', 'Level3Screen', 'FeedbackScreen', 'DiagnosticScreen']
    .forEach(name => {
      assert.notStrictEqual(evalInPage(`typeof ${name}`), 'undefined', `${name}이 정의되지 않았다`);
    });
});

test('인라인 onclick이 부르는 함수들이 실제로 보인다', () => {
  /* index.html의 onclick="X.y()"에서 X를 뽑아 전부 존재하는지 본다. 화면에서 버튼을 눌렀을
     때만 드러나는 종류의 사고(이름을 바꿨는데 HTML은 안 고침)를 여기서 잡는다. */
  const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'return', 'typeof', 'new', 'this', 'window']);
  const names = new Set(
    [...INDEX_HTML.matchAll(/onclick="([A-Za-z_$][\w$]*)\s*[.(]/g)]
      .map(m => m[1])
      .filter(n => !KEYWORDS.has(n))
  );
  assert.ok(names.size > 5, `onclick 대상을 ${names.size}개만 찾았다`);
  const missing = [...names].filter(n => evalInPage(`typeof ${n}`) === 'undefined');
  assert.deepStrictEqual(missing, [], `HTML이 부르는데 없는 것: ${missing.join(', ')}`);
});

/* ── 사진 압축이 두 화면에서 같이 보이는가 (S-13) ─────── */

test('compressImage가 전역에 있다', () => {
  assert.strictEqual(typeof sandbox.compressImage, 'function');
});

test('compressImage가 window에도 노출된다 — 모듈 다리에서도 부른다', () => {
  assert.strictEqual(typeof sandbox.window.compressImage, 'function');
});

test('quiz.js(Level 3)가 compressImage를 쓴다', () => {
  const quiz = fs.readFileSync(path.join(PUBLIC, 'js', 'quiz.js'), 'utf8');
  assert.ok(quiz.includes('await compressImage(file)'),
    'Level 3 사진 업로드가 공용 압축 함수를 안 쓴다 — 원본이 그대로 나간다');
});

test('home.js에 옛 압축 코드가 남아 있지 않다', () => {
  const home = fs.readFileSync(path.join(PUBLIC, 'js', 'home.js'), 'utf8');
  assert.ok(!home.includes('_compressImage'), '옛 압축 함수가 남아 두 벌이 됐다');
  assert.ok(!home.includes('readAsDataURL'),
    'home.js가 아직 원본을 그대로 base64로 만든다');
});

test('Level 3 사진 업로드가 FileReader로 원본을 읽지 않는다', () => {
  const quiz = fs.readFileSync(path.join(PUBLIC, 'js', 'quiz.js'), 'utf8');
  assert.ok(!quiz.includes('readAsDataURL'),
    'Level 3가 아직 원본을 그대로 보낸다 — 폰 사진이 서버 상한에 걸린다');
});

test('4000×3000 사진이 긴 변 1600으로 줄어든다', async () => {
  const dataUrl = await sandbox.compressImage({ type: 'image/jpeg' });
  assert.ok(dataUrl.startsWith('data:image/jpeg'), `JPEG로 안 나왔다: ${dataUrl.slice(0, 40)}`);
  assert.ok(dataUrl.includes('W1600xH1200'), `1600×1200이 아니다: ${dataUrl}`);
});

test('EXIF 회전을 적용해서 읽는다 — 세로 사진이 눕지 않게', () => {
  const app = fs.readFileSync(path.join(PUBLIC, 'js', 'app.js'), 'utf8');
  assert.ok(app.includes("imageOrientation: 'from-image'"),
    'EXIF 회전 옵션이 빠졌다 — 폰으로 세로로 찍은 사진이 누워서 전달된다');
});

/* ── 형식을 실제로 보내는가 (S-13) ────────────────────── */

test('api.js가 이미지 형식을 함께 보낸다', () => {
  const api = fs.readFileSync(path.join(PUBLIC, 'firebase', 'api.js'), 'utf8');
  assert.ok(api.includes('mimeType'), 'mimeType을 안 보낸다 — 서버가 png로 고정해 버린다');
  assert.ok(/data:\(\[\^;\]\+\)|data:\(\[\^;\]/.test(api) || api.includes('exec(imageBase64)'),
    'data: 접두사에서 실제 형식을 읽는 코드가 없다');
});

/* ── 점수 계산 (화면 쪽) ──────────────────────────────── */

test('힌트를 쓰면 감점된다', () => {
  sandbox.window.AppState = { session: { hintUsed: 2 } };
  const data = { score: 100, subtitle: '' };
  sandbox.applyHintPenalty(data);
  assert.strictEqual(data.score, 80, '힌트 2개면 -20이어야 한다');
});

test('감점이 음수로 내려가지 않는다', () => {
  sandbox.window.AppState = { session: { hintUsed: 2 } };
  const data = { score: 10, subtitle: '' };
  sandbox.applyHintPenalty(data);
  assert.strictEqual(data.score, 0);
});

test('힌트를 안 쓰면 점수가 그대로다', () => {
  sandbox.window.AppState = { session: { hintUsed: 0 } };
  const data = { score: 75, subtitle: '' };
  sandbox.applyHintPenalty(data);
  assert.strictEqual(data.score, 75);
});

/* ── 신고 맥락과 태그 복원 (S-16) ─────────────────────
   둘 다 화면에서는 정상으로 보이고 저장된 데이터만 틀리는 종류라, 눈으로는 못 잡는다. */

const FEEDBACK = fs.readFileSync(path.join(PUBLIC, 'js', 'feedback.js'), 'utf8');

test('신고가 지금 세션이 아니라 이 화면의 단원을 쓴다', () => {
  const start = FEEDBACK.indexOf('submitQuestionReport({');
  const body = FEEDBACK.slice(start, FEEDBACK.indexOf('});', start));
  assert.ok(body.includes('unit: this._reportUnit'),
    '신고에 AppState.session의 단원이 붙는다 — 과거 기록을 열어 신고하면 엉뚱한 단원이 된다');
  assert.ok(body.includes('level: this._reportLevel'), '레벨도 같은 문제가 있다');
  assert.ok(!body.includes('AppState.session.detectedUnit'), '세션 값을 아직 읽고 있다');
});

test('과거 기록을 열면 그 기록의 단원·레벨·세션이 신고에 붙는다', () => {
  const start = FEEDBACK.indexOf('this._reportUnit');
  const block = FEEDBACK.slice(start, start + 500);
  assert.ok(/isHistory \?\s*\(data\.unit/.test(block), '과거 기록의 단원을 안 쓴다');
  assert.ok(/isHistory \?\s*\(data\.level/.test(block), '과거 기록의 레벨을 안 쓴다');
  assert.ok(/isHistory \?\s*\(data\.sessionId/.test(block), '과거 기록의 세션 id를 안 쓴다');
});

test('마이페이지가 신고에 필요한 값을 실어 보낸다', () => {
  const mypage = fs.readFileSync(path.join(PUBLIC, 'js', 'mypage.js'), 'utf8');
  const start = mypage.indexOf('const historyData = {');
  const block = mypage.slice(start, mypage.indexOf('};', start));
  ['unit:', 'level:', 'sessionId'].forEach(k => {
    assert.ok(block.includes(k), `historyData에 ${k}가 없다 — 신고 맥락이 비게 된다`);
  });
});

test('신고를 보내기 전에 세션 저장을 기다린다', () => {
  const start = FEEDBACK.indexOf('async submitReport()');
  const body = FEEDBACK.slice(start, FEEDBACK.indexOf('submitQuestionReport', start));
  assert.ok(/await this\._sessionSaved/.test(body),
    '저장을 안 기다린다 — 채점 직후 바로 신고하면 sessionId가 null로 나간다');
});

test('세션 저장 promise를 실제로 들고 있다', () => {
  assert.ok(/this\._sessionSaved = window\.LearningService\.saveSession/.test(FEEDBACK),
    'saveSession 결과를 안 붙잡아 둔다 — 기다릴 대상이 없다');
});

test('다시 풀기가 계산형 오개념 태그를 복원한다', () => {
  const start = FEEDBACK.indexOf('AppState.session.calcQuestion = {');
  const body = FEEDBACK.slice(start, FEEDBACK.indexOf('};', start));
  assert.ok(body.includes('targetMisconceptionId'),
    '계산형 복원에 오개념 태그가 빠졌다 — 재도전 기록의 오개념이 null로 저장된다');
});

test('문장형 다시 풀기도 태그를 복원한다', () => {
  const start = FEEDBACK.indexOf('AppState.session.questions = items.map');
  const body = FEEDBACK.slice(start, FEEDBACK.indexOf('}));', start));
  assert.ok(body.includes('targetMisconceptionIds'), '문장형 복원에서 태그가 사라졌다');
});

/* ── 죽은 값이 다시 생기지 않게 (S-19) ────────────────
   "아무도 안 읽는데 계속 채우는 값"은 오류가 안 나서 오래 남는다. 지운 것들이 되돌아오면
   여기서 잡는다. 값을 넣는 코드가 늘어나는 건 쉽고, 읽는 곳이 없다는 건 눈에 안 띈다. */

test('세션에 아무도 안 읽는 값을 넣지 않는다', () => {
  const dead = ['step2Answers', 'uploadedImageBase64', 'quizMode', 'misconceptionCount',
                'correctCount', 'score', 'feedbackData'];
  const clientFiles = SCRIPTS.map(rel => [rel, fs.readFileSync(path.join(PUBLIC, rel), 'utf8')]);
  const found = [];
  clientFiles.forEach(([rel, code]) => {
    dead.forEach(name => {
      if (new RegExp(`session\\.${name}\\s*=`).test(code)) found.push(`${rel} → session.${name}`);
    });
  });
  assert.deepStrictEqual(found, [], `읽는 곳이 없는 값을 다시 채우고 있다:\n${found.join('\n')}`);
});

test('채점 요청에 문장 본문을 중복해서 싣지 않는다', () => {
  const quiz = fs.readFileSync(path.join(PUBLIC, 'js', 'quiz.js'), 'utf8');
  /* ⚠️ `checkedQuestions.map`은 화면을 그리는 곳에도 있다. 짧은 조각으로 자리를 잡으면
     엉뚱한 구간을 읽는다 — 실제로 한 번 헛짚었다. 대입문 전체로 자리를 잡는다. */
  const start = quiz.indexOf('const answers = checkedQuestions.map');
  assert.ok(start !== -1, '답변을 모으는 코드를 못 찾았다');
  const body = quiz.slice(start, quiz.indexOf('}));', start));
  assert.ok(!body.includes('questionText'),
    '문장 본문은 questions로 이미 간다 — answers에 또 실으면 서버는 그냥 버린다');
});

/* ── 소단원 ↔ 대단원 매핑 ────────────────────────────── */

test('소단원 14개가 모두 대단원에 연결된다', () => {
  const all = Object.values(sandbox.UNIT_MAP).flatMap(c => c.subUnits);
  assert.strictEqual(all.length, 14, `소단원이 ${all.length}개다 (14개여야 함)`);
  all.forEach(sub => {
    assert.ok(sandbox.getChapter(sub), `${sub}의 대단원을 못 찾는다`);
  });
});

test('없는 소단원은 null을 돌려준다', () => {
  assert.strictEqual(sandbox.getChapter('없는단원'), null);
});

test('개념 영역 이름이 오개념 데이터의 영역 코드를 모두 덮는다', () => {
  const fixtures = require('./_fixtures');
  const codes = [...new Set(fixtures.misconceptions.map(m => m.dimensionCode))];
  codes.forEach(code => {
    assert.ok(sandbox.DIMENSION_NAMES[code], `영역 ${code}의 한글 이름이 없다`);
  });
});
