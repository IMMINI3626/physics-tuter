# PhysiClinic

고등학교 물리 오개념을 진단하고 교정하는 AI 학습 플랫폼.

배포: https://physics-tuter.web.app

---

## 이 프로젝트가 하는 일

학생이 물리 교과서나 필기 사진을 찍어 올리면, AI가 그 내용을 분석해 어떤 단원인지 파악하고
학생이 헷갈릴 만한 **오개념**(잘못 알기 쉬운 개념)을 짚어낸다. 그리고 그 오개념을 겨냥한
맞춤 문제를 만들어 풀게 하고, 답을 AI가 채점하며 왜 틀렸는지 설명해 준다.

한 번에 끝나는 게 아니라, 난이도를 세 단계로 나눠 반복하면서 오개념을 교정한다.

```
1. 사진 업로드      교과서/필기 사진을 찍어서 올린다
2. 진단            AI가 단원과 관련 오개념을 찾아낸다
3. 문제 생성        그 오개념을 겨냥한 문제를 만든다
4. 풀이 & 채점      학생이 풀면 AI가 채점하고 피드백한다
5. 반복 & 교정      난이도를 올려가며(개념→계산→종합) 오개념을 고쳐나간다
6. 학습 현황        마이페이지에서 단원별 진행 상황을 본다
```

### 난이도 3단계

같은 단원을 세 단계의 난이도로 반복하며 개념을 다진다.

- Level 1: 문장의 참·거짓을 판단하는 개념 이해 단계
- Level 2: 공식에 수를 넣어 답을 구하는 정량 계산 단계
- Level 3: 여러 법칙이 얽힌 복합 문제를 풀이 과정까지 쓰는 종합 단계

### 무엇에 기반하는가

오개념 목록은 임의로 만든 게 아니라 물리교육에서 널리 쓰이는 표준 진단검사
(FCI, FMCE)와 국내 물리교육 학위논문에 근거한다. 총 87개 오개념을 17개 개념 영역으로
묶어 관리한다.

### 기술 구성

- 프론트엔드: 프레임워크 없는 순수 HTML/CSS/JavaScript 단일 페이지 앱
- 백엔드: Firebase Cloud Functions에서 Google Gemini API를 호출 (API 키를 클라이언트에
  노출하지 않기 위해 서버를 경유)
- 데이터: Firebase Firestore (오개념 DB + 사용자별 학습 기록)
- 인증: Firebase Authentication (Google, 이메일)
- 호스팅: Firebase Hosting

### 진행 중인 작업

학생이 각 오개념을 얼마나 이해했는지를 확률로 추적하는 학습자 모델(Bayesian Knowledge
Tracing)을 도입하고 있다. 지금의 "정답 횟수 세기"를 "이해도 확률"로 대체하는 작업이며,
설계는 [docs/오개념측정_BKT_설계.md](docs/오개념측정_BKT_설계.md)에 정리했다.

---

## 프로젝트 구조

```
physics-tuter/
├── public/                     프론트엔드 (Firebase Hosting에 배포)
│   ├── index.html              모든 화면이 담긴 단일 진입점
│   ├── css/
│   │   ├── variables.css       색상·폰트·간격 등 디자인 토큰
│   │   ├── base.css            리셋, 공통 컴포넌트(버튼·모달·토스트)
│   │   ├── home.css            홈 화면
│   │   ├── keyword.css         사진 분석 결과 화면
│   │   ├── quiz.css            문제 풀이 화면(STEP1/2, 계산, Level 3)
│   │   └── feedback.css        피드백 + 마이페이지
│   ├── js/
│   │   ├── app.js              라우터, 전역 상태(AppState), 공용 유틸(이스케이프 등)
│   │   ├── bkt.js              오개념 이해도 확률 계산(BKT) 순수 모듈
│   │   ├── home.js             홈 화면(사진 업로드, 리사이즈)
│   │   ├── keyword.js          사진 분석 결과 화면
│   │   ├── quiz.js             문제 풀이(STEP1/2, 계산, Level 3 캔버스 필기)
│   │   ├── feedback.js         채점 결과 + 레벨 승급/교정 루프
│   │   ├── mypage.js           마이페이지(단원별 현황, 점수 추이, 이력)
│   │   └── quiz-library.js     문제풀기 탭(최근 학습 목록)
│   └── firebase/
│       ├── config.js           Firebase 초기화
│       ├── auth.js             로그인/로그아웃(Google, 이메일)
│       ├── firestore.js        학습 기록 저장/조회
│       └── api.js              Cloud Functions 호출 래퍼
│
├── functions/                  백엔드 (Firebase Cloud Functions)
│   ├── index.js                Gemini API 호출 5종(진단·문제 생성·채점 등)
│   ├── seed.js                 오개념 DB 시딩 스크립트
│   └── package.json
│
├── firebase.json               Hosting + Functions + Firestore 배포 설정
├── firestore.rules             Firestore 접근 규칙
├── .firebaserc                 프로젝트 ID
├── README.md                   이 문서
├── CHANGELOG.md                기능·버그 수정 상세 이력
├── Add_README.md               레벨 시스템·마이페이지 설계 기준, 미결 사항
└── docs/
    └── 오개념측정_BKT_설계.md   진행 중인 학습자 모델(BKT) 설계 문서
```

---

## 처음 설정하기

### 1. Firebase 프로젝트 생성

1. [Firebase Console](https://console.firebase.google.com) 접속
2. 새 프로젝트 생성 (예: physics-tuter)
3. Authentication에서 Google, 이메일/비밀번호 로그인 활성화
4. Firestore 데이터베이스 생성 (프로덕션 모드)
5. Functions 활성화 (종량제 Blaze 요금제 필요)

### 2. Firebase 설정값 입력

`public/firebase/config.js`의 값을 본인 프로젝트 값으로 교체.
(Firebase Console → 프로젝트 설정 → 내 앱 → SDK 설정 및 구성에서 복사)

```js
const firebaseConfig = {
  apiKey:     "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId:  "YOUR_PROJECT_ID",
  // ...
};
```

### 3. 프로젝트 ID 지정

`.firebaserc`:

```json
{ "projects": { "default": "YOUR_PROJECT_ID" } }
```

### 4. Gemini API 키 등록

API 키는 코드에 넣지 않고 Firebase Secret으로 관리한다.

```bash
firebase functions:secrets:set GEMINI_API_KEY
```

### 5. 오개념 DB 시딩

Firebase Console에서 서비스 계정 비공개 키를 발급받아
`functions/serviceAccountKey.json`으로 저장한 뒤:

```bash
cd functions
npm install
node seed.js
```

오개념·문장·기출 유형 등 정적 데이터가 Firestore에 채워진다.

### 6. 배포

```bash
firebase deploy --only functions   # 백엔드
firebase deploy --only hosting      # 프론트엔드
```

배포 후 `https://YOUR_PROJECT_ID.web.app`으로 접속한다.

---

## 로컬 개발

Firebase 에뮬레이터로 배포 없이 테스트할 수 있다.

```bash
firebase emulators:start

# http://localhost:5000   앱
# http://localhost:4000   에뮬레이터 관리 UI
```

에뮬레이터의 정적 파일은 캐시되므로, 코드를 고친 뒤에는 시크릿 창이나
강력 새로고침(Ctrl+Shift+R)으로 확인한다.

---

## Firestore 데이터 구조

### 정적 데이터 (seed.js로 시딩, 읽기 전용)

```
/units/{unitId}                    대단원 (힘과 운동, 에너지 등)
/misconception_dimensions/{id}     개념 영역 17개 (임페투스, 중력·저항 등)
/misconceptions/{id}               개별 오개념 87개 (dimensionCode로 영역에 연결)
/misconception_sentences/{id}      오개념별 참·거짓 예시 문장 166개
/question_patterns/{id}            실제 기출 유형 추상화 116개 (문제 생성 참고용)
/fci_fmce_items/{id}               표준 진단검사 문항 73개 (효과 검증·진단용)
/item_misconception_map/{id}       진단 문항의 오답과 오개념 연결 130개
/scoring_keywords/{id}             채점 키워드 54개
```

### 사용자 학습 데이터

```
/users/{uid}/sessions/{sid}                 한 번의 문제 풀이 세션
  unit, keywords, misconceptions[], score, level, wrongCount,
  hintUsed, checkedCount, hint1, hint2, retryOf?, createdAt

/users/{uid}/sessions/{sid}/logs/{logId}    세션 안 문항별 기록
  questionId, questionText, isWrongQ, userSelected, isCorrectAnswer,
  userReason, explanation, (계산형: correctAnswer, unit, unitOptions, solutionSteps)

/users/{uid}/unitProgress/{소단원}           소단원별 진행 상태
  level, completed, correctCount, chapter, bestScore, sessionCount, lastStudied

/users/{uid}/knowledgeState/{오개념id}        (도입 중) 오개념별 이해도 확률
  pL, attempts, lastUpdated
```

접근 규칙은 `firestore.rules`에 정의한다. 사용자 데이터는 본인만 읽고 쓸 수 있고,
정적 데이터는 모두 읽기 전용이다.

---

## 화면 흐름

```
홈
 └ 사진 업로드
     └ 사진 분석 (단원·오개념 진단)
         └ 문제 풀이
             ├ Level 1  문장 참·거짓 (STEP1 선택 → STEP2 서술)
             ├ Level 2  계산 단답 또는 문장 판별
             └ Level 3  복합 계산 (풀이 과정 텍스트/필기 입력)
         └ 피드백 (채점 결과)
             └ 합격 시 승급, 아니면 교정 루프(다시 풀기/다음 문제)

마이페이지
 └ 대단원 카드 (소단원별 레벨·진행)
     └ 소단원 상세 (점수 추이 그래프, 집중하면 좋을 개념, 과거 이력)
```

문제 생성·채점은 Gemini API를 서버(Cloud Functions)에서 호출한다. 진단, 문제 생성,
채점이 각각 별도 호출로 이뤄진다.

---

## 주의사항

- Gemini API 키는 코드에 넣지 말고 반드시 Firebase Secret으로 관리한다.
- `functions/serviceAccountKey.json`(서비스 계정 키)은 Git에 커밋하지 않는다
  (`.gitignore`에 포함되어 있다).
- Functions는 종량제(Blaze) 요금제가 필요하다. 개인 프로젝트는 월 무료 한도 안에서 운영 가능하다.

---

## 커밋 규칙

```
feat     새 기능 추가
fix      버그 수정
refactor 기능 변경 없는 구조 개선
style    포맷팅 등 기능에 영향 없는 수정
docs     문서 수정
chore    빌드·설정 등
```
