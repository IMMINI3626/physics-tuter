# PhysiClinic — 개발 가이드

## 📁 프로젝트 구조

```
physi-clinic/
│
├──public
│     ├── index.html              ← 진입점 (모든 화면 포함)
│     │
│     ├── css/
│     │   ├── variables.css       ← 디자인 토큰 (색상, 폰트, 간격)
│     │   ├── base.css            ← 리셋, 공통 컴포넌트 (버튼, 모달, 토스트...)
│     │   ├── home.css            ← 홈 화면
│     │   ├── keyword.css         ← 키워드 추출 화면
│     │   ├── quiz.css            ← STEP1 + STEP2 (문제 풀이)
│     │   └── feedback.css        ← 피드백 + 마이페이지
│     │
│     ├── js/
│         ├── app.js              ← 라우터, 전역 상태(AppState), Toast, Modal
│         ├── home.js             ← 홈 화면 로직 (파일 업로드, 최근 학습)
│         ├── keyword.js          ← 키워드 추출 화면 로직
│         ├── quiz.js             ← STEP1/2 로직 (체크박스, 힌트, 채점 요청)
│         └── feedback.js         ← 피드백 화면 렌더링
│
├── firebase/
│   ├── config.js           ← Firebase 초기화 (⚠️ API 키 설정 필요)
│   ├── auth.js             ← 로그인/로그아웃 (Google, Email)
│   ├── firestore.js        ← 학습 로그 저장/조회
│   └── api.js              ← Cloud Functions 호출 (Gemini API 래퍼)
│
├── functions/
│   ├── index.js            ← Cloud Functions (Gemini API 1·2·3차 호출)
│   └── package.json
│
├── firebase.json           ← Hosting + Functions 배포 설정
├── .firebaserc             ← 프로젝트 ID 설정
└── README.md
```

---

## 🚀 시작하기

### 1단계: Firebase 프로젝트 생성

1. [Firebase Console](https://console.firebase.google.com) 접속
2. 새 프로젝트 생성 (예: `physics-tuter`)
3. Authentication → 로그인 방법 → Google, 이메일/비밀번호 활성화
4. Firestore → 데이터베이스 생성 (프로덕션 모드)
5. Functions 활성화 (Blaze 요금제 필요)

### 2단계: Firebase 설정값 입력

`firebase/config.js`에서 아래 값 교체:
```js
const firebaseConfig = {
  apiKey:            "YOUR_API_KEY",
  authDomain:        "YOUR_PROJECT_ID.firebaseapp.com",
  projectId:         "YOUR_PROJECT_ID",
  // ...
};
```

`firebase console → 프로젝트 설정 → 내 앱 → SDK 설정 및 구성`에서 복사

### 3단계: .firebaserc 설정

```json
{ "projects": { "default": "YOUR_PROJECT_ID" } }
```

### 4단계: Gemini API 키를 Firebase Secret으로 등록

```bash
firebase functions:secrets:set GEMINI_API_KEY
# 프롬프트에 Gemini API 키 입력
```

7Jbk로 끝나는 키 사용

### 5단계: Functions 의존성 설치 & 배포

```bash
cd functions
npm install

cd ..
firebase deploy --only functions
```

### 6단계: index.html에서 Firebase 모듈 활성화

`index.html` 하단의 주석 해제:
```html
<script type="module">
  import { AuthService }     from './firebase/auth.js';
  import { LearningService } from './firebase/firestore.js';
  import { ApiService }      from './firebase/api.js';

  window.AuthService     = AuthService;
  window.LearningService = LearningService;
  window.ApiService      = ApiService;
</script>
```

### 7단계: Hosting 배포

```bash
firebase deploy --only hosting
# 완료 후 https://YOUR_PROJECT_ID.web.app 으로 접속 가능
```
https://physics-tuter.web.app

---

## 🔧 로컬 개발

Firebase 에뮬레이터 사용 (API 키 없이 테스트 가능):

```bash
# 에뮬레이터 시작
firebase emulators:start

# 브라우저에서
# http://localhost:5000  ← 앱
# http://localhost:4000  ← 에뮬레이터 UI
```

**더미 데이터 모드**: `firebase/` 모듈을 활성화하지 않으면 앱은 자동으로 더미 데이터로 동작합니다. UI/로직 개발 시 Firebase 없이 바로 시작 가능해요.

---

## 📊 Firestore 컬렉션 구조

```
/units/{unitId}
  name: string
  keywords: string[]

/misconceptions/{mcId}
  unitId: string
  description: string
  scoringKeywords: string[]

/users/{uid}/sessions/{sid}
  unit: string
  score: number
  hintUsed: number
  createdAt: timestamp

/users/{uid}/sessions/{sid}/logs/{logId}
  questionId: number
  isWrongQ: boolean
  userSelected: boolean
  isCorrectAnswer: boolean
  userReason: string
  createdAt: timestamp

/users/{uid}/assessments/{assessId}
  type: 'FCI' | 'FMCE'
  score: number
  createdAt: timestamp
```

---

## 📱 화면 흐름

```
홈 → [사진 업로드] → 키워드 추출 (Gemini 1차)
   → STEP 1: 틀린 문장 선택
   → STEP 2: 서술형 입력 (Gemini 2차)
   → 피드백: 채점 결과 (Gemini 3차)
   → 홈 (반복)
```

---

## ⚠️ 주의사항

- `firebase/config.js`의 API 키는 절대 Git에 커밋하지 마세요. `.gitignore`에 추가하거나 환경변수로 관리하세요.
- Gemini API 키는 반드시 Firebase Secret으로 관리 (`functions:secrets:set`)
- Functions는 Blaze(종량제) 요금제 필요 (월 무료 한도 내에서 개인 프로젝트 운영 가능)

###
git add .
git commit -m "커밋 내용"
git push

feat: 새로운 기능 추가 (Feature)
refactor: 기능 변경 없는 코드 리팩토링 (가독성 향상, 구조 개선 등)
fix: 버그 수정docs: 문서 수정 (README.md, 주석 등)
style: 코드 포맷팅 (들여쓰기 등 기능에 영향 없는 수정)
chore: 빌드 업무 수정, 패키지 매니저 설정 등
###