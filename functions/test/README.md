# 회귀 시험

```bash
npm test
```

`functions/` 폴더에서 실행한다. 네트워크를 쓰지 않고, 요금도 들지 않는다.
Gemini SDK와 Admin SDK는 `_harness.js`가 가짜로 바꿔치기한다.

## 무엇을 지키는가

| 파일 | 지키는 것 |
|---|---|
| `01-prompts-snapshot` | 프롬프트가 한 글자도 안 바뀌었는가 |
| `02-injection` | 남이 보낸 글이 전부 울타리 안에 들어가는가 (S-12) |
| `03-grading` | 이상한 채점 응답에 NaN이 새지 않는가, 점수 상한이 지켜지는가 (S-13·S-10) |
| `04-validation` | 악용 요청이 **AI를 부르기 전에** 끊기는가 (S-1·S-7·S-11) |
| `05-client` | 화면 스크립트가 브라우저와 같은 순서로 올라가고 사진 압축이 두 화면에서 같이 보이는가 |
| `06-consistency` | 규칙↔클라이언트 필드, BKT 상수, 입력칸 길이 같은 "짝"이 안 어긋났는가 |

## 프롬프트를 일부러 고쳤을 때

`01-prompts-snapshot`이 실패한다. 실패 목록에 **바뀐 프롬프트 이름이 그대로 나오므로**,
의도한 것만 바뀌었는지 확인하고 기준을 새로 만든다.

```bash
npm run test:update
```

바뀐 `prompts.snapshot.json`을 같이 커밋한다.

## 시험을 추가하려면

이 폴더에 `07-이름.test.js`를 만들면 실행기가 알아서 찾는다.

```js
const H = require('./_harness');
const { test, assert } = H;
const fn = require('../index.js');

test('설명', async () => {
  H.resetQueue();
  H.reply({ items: [/* AI가 돌려줄 응답 */] });
  const r = await fn.gradeAnswers.run({ data: {...}, auth: H.auth() });
  assert.strictEqual(r.score, 50);
});
```

`H.reply()`로 AI 응답을 미리 넣어두고, 실패를 확인할 때는 재시도 횟수만큼(3번) 넣는다.

## 주의

- `index.js`를 부르기 **전에** `_harness.stub()`이 돌아야 한다. `run.js`가 이미 해준다.
- 응답 큐가 빈 채로 AI가 불리면 시험이 터진다 — 일부러 그렇게 뒀다. "여기서 AI를 부르면
  안 되는데 불렀다"를 잡기 위해서다.
- 이 폴더는 `firebase.json`의 `functions.ignore`에 있어 배포에 실리지 않는다.
