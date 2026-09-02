/* ============================================================
   시험 공용 뼈대 — 네트워크 없이 서버 코드를 실제로 돌린다

   왜 이런 방식인가:
   index.js는 5개 함수만 내보내고 내부 헬퍼(채점 집계·검증)는 숨겨져 있다. 헬퍼를 시험용으로
   따로 내보내면 "시험이 보는 코드"와 "배포되는 코드"가 갈라진다. 그래서 헬퍼를 꺼내는 대신
   **모듈 로더를 가로채** Gemini SDK와 Admin SDK만 가짜로 바꾸고, 실제 함수를 그대로 부른다.
   시험이 보는 것은 배포되는 코드와 같은 경로다.

   onCall이 돌려주는 핸들러의 .run(request)로 HTTP 없이 함수 본문을 실행한다.

   사용법:
     const H = require('./_harness');
     H.stub();                       // ← index.js를 require하기 "전에" 부를 것
     const fn = require('../index.js');
     H.reply({ items: [...] });      // AI가 돌려줄 응답을 미리 넣어둔다
     await fn.gradeAnswers.run({ data, auth: H.auth() });
   ============================================================ */
const Module = require('module');
const assert = require('assert');

/* ── AI 응답 큐 ───────────────────────────────────────────── */
const replies = [];      // 다음 generateContent가 꺼내 쓸 응답들
const prompts = [];      // 실제로 AI에 실린 프롬프트 (인젝션·스냅샷 시험이 읽는다)

/** AI가 돌려줄 응답을 큐에 넣는다. 객체면 JSON 문자열로 만든다. */
function reply(value) {
  replies.push(typeof value === 'string' ? value : JSON.stringify(value));
  return module.exports;
}

/** 같은 응답을 n번 넣는다 (재시도 3번을 모두 같은 값으로 채울 때). */
function replyTimes(value, n) {
  for (let i = 0; i < n; i++) reply(value);
  return module.exports;
}

function resetQueue() {
  replies.length = 0;
  prompts.length = 0;
}

/* ── 가짜 Firestore ──────────────────────────────────────── */
/* seed()로 넣은 컬렉션만 갖는 최소 구현. 실제 코드가 쓰는 API만 만든다:
   collection().get() / .where().get() / .doc(), runTransaction, FieldValue */
let store = {};          // { 컬렉션이름: [문서객체, ...] }
const usage = {};        // ai_usage 문서 (일일 상한 시험용)

function seed(collections) {
  store = collections || {};
  return module.exports;
}

const snapOf = (rows) => ({ docs: rows.map(r => ({ data: () => r })), size: rows.length });

function makeQuery(rows) {
  return {
    where(field, op, value) {
      const next = rows.filter(r => {
        if (op === 'in') return Array.isArray(value) && value.includes(r[field]);
        return r[field] === value;
      });
      return makeQuery(next);
    },
    get: async () => snapOf(rows),
  };
}

const fakeDb = {
  collection(name) {
    const rows = store[name] || [];
    return Object.assign(makeQuery(rows), {
      doc: (id) => ({ _key: `${name}/${id}` }),
    });
  },
  async runTransaction(fn) {
    const tx = {
      get: async (ref) => {
        const row = usage[ref._key];
        return { exists: row !== undefined, data: () => row };
      },
      set: (ref, value) => { usage[ref._key] = { ...(usage[ref._key] || {}), ...value }; },
    };
    return fn(tx);
  },
};

/** ai_usage 카운터를 특정 값으로 미리 채운다 (일일 상한 시험용). */
function presetUsage(uid, count) {
  const day = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  usage[`ai_usage/${uid}_${day}`] = { count };
  return module.exports;
}

function resetUsage() {
  Object.keys(usage).forEach(k => delete usage[k]);
}

/* ── 모듈 가로채기 ───────────────────────────────────────── */
let stubbed = false;

function stub() {
  if (stubbed) return module.exports;
  stubbed = true;

  const fakeAdmin = {
    apps: [{}],                       // 이미 초기화된 것처럼 보여 initializeApp을 건너뛰게 한다
    initializeApp: () => {},
    firestore: Object.assign(() => fakeDb, {
      FieldValue: { serverTimestamp: () => '<서버시각>' },
    }),
  };

  const fakeGenAI = {
    GoogleGenerativeAI: class {
      constructor(key) { this.key = key; }
      getGenerativeModel(config) {
        return {
          _config: config,
          async generateContent(prompt) {
            prompts.push({ prompt, config });
            if (!replies.length) {
              throw new Error('시험 설정 오류: AI 응답 큐가 비었는데 generateContent가 불렸다');
            }
            const text = replies.shift();
            return { response: { text: () => text } };
          },
        };
      }
    },
  };

  const original = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === '@google/generative-ai') return fakeGenAI;
    if (request === 'firebase-admin') return fakeAdmin;
    if (request === 'firebase-functions/params') {
      return { defineSecret: () => ({ value: () => 'TEST_KEY' }) };
    }
    return original.apply(this, arguments);
  };
  return module.exports;
}

/* ── Math.random 고정 ────────────────────────────────────── */
/* 틀린 문장 개수·패턴 셔플·varietySeed가 전부 Math.random을 쓴다. 프롬프트를 바이트 단위로
   비교하려면 이 값들이 매번 같아야 한다. 호출 순서(index.js 465줄 주석)가 곧 시험의 전제다. */
const realRandom = Math.random;
function freezeRandom(value = 0.5) {
  Math.random = () => value;
}
function thawRandom() {
  Math.random = realRandom;
}

/* ── 로그 가로채기 ───────────────────────────────────────── */
/* 함수가 찍는 로그를 삼켜서 시험 결과를 읽기 쉽게 하고, 동시에 **로그 자체를 시험 대상**으로
   만든다. `개념별 판정 …`·`미답변 문항 가점 차단 …`은 논문이 쓰는 실측 지표라, 코드를 고치다
   로그가 조용히 사라지면 측정이 끊긴다. */
let captured = [];
const realConsole = { log: console.log, info: console.info, warn: console.warn, error: console.error };

function startCapture() {
  captured = [];
  const grab = (level) => (...args) => {
    captured.push({ level, text: args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') });
  };
  console.info = grab('info');
  console.warn = grab('warn');
  console.error = grab('error');
}

function stopCapture() {
  Object.assign(console, realConsole);
}

/** 잡아둔 로그 중 substr를 담은 줄. 없으면 빈 배열. */
function logsWith(substr) {
  return captured.filter(l => l.text.includes(substr));
}

/* ── 시험 등록·실행 ──────────────────────────────────────── */
const cases = [];
let currentFile = '';

function test(name, fn) {
  cases.push({ name, fn, file: currentFile });
}

function setFile(name) { currentFile = name; }

async function runAll() {
  let pass = 0;
  const failures = [];
  let lastFile = null;

  for (const c of cases) {
    if (c.file !== lastFile) {
      console.log(`\n  ${c.file}`);
      lastFile = c.file;
    }
    startCapture();
    try {
      await c.fn();
      stopCapture();
      pass++;
      console.log(`    OK   ${c.name}`);
    } catch (err) {
      stopCapture();
      failures.push({ ...c, err });
      console.log(`    실패 ${c.name}`);
      console.log(`         ${err.message.split('\n')[0]}`);
    }
  }

  console.log(`\n${'─'.repeat(60)}`);
  if (failures.length) {
    console.log(`${pass}건 통과, ${failures.length}건 실패\n`);
    failures.forEach(f => {
      console.log(`[${f.file}] ${f.name}`);
      console.log(f.err.stack.split('\n').slice(0, 4).join('\n'));
      console.log('');
    });
  } else {
    console.log(`${pass}건 전부 통과`);
  }
  return failures.length;
}

/* ── 단언 도우미 ─────────────────────────────────────────── */
const auth = (uid = 'tester', anonymous = false) => ({
  uid,
  token: { firebase: { sign_in_provider: anonymous ? 'anonymous' : 'password' } },
});

/** fn을 부르면 반드시 던져야 한다. message에 substr가 들어있는지도 본다. */
async function throws(fn, substr, label) {
  let caught = null;
  try { await fn(); } catch (e) { caught = e; }
  assert.ok(caught, `${label || ''} — 던져야 하는데 통과했다`);
  if (substr) {
    assert.ok(
      String(caught.message).includes(substr),
      `${label || ''} — 오류 메시지에 "${substr}"가 없다 (실제: ${caught.message})`
    );
  }
  return caught;
}

/** 문자열 안에 needle이 정확히 count번 나오는지. 울타리 시험이 쓴다. */
function countOf(haystack, needle) {
  return haystack.split(needle).length - 1;
}

module.exports = {
  stub, seed, reply, replyTimes, resetQueue, resetUsage, presetUsage,
  freezeRandom, thawRandom,
  test, setFile, runAll, auth, throws, countOf, assert, logsWith,
  get prompts() { return prompts; },
  lastPrompt: () => prompts[prompts.length - 1]?.prompt,
  lastConfig: () => prompts[prompts.length - 1]?.config,
};
