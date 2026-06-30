# PhysiClinic — 추가 구현사항 개발 가이드

## 개요

본 문서는 PhysiClinic의 현재 구현(키워드 추출 → 문제 생성 → 채점 → 피드백) 위에 추가될 두 가지 핵심 기능을 정의한다.

- **(1) 소단원 기반 레벨 시스템 + 교정 루프**
- **(2) 마이페이지 단원별 학습 현황 시각화**

---

## 공통 — 소단원 분류

레벨 시스템은 소단원 단위로 관리하고, 마이페이지에서는 대단원으로 묶어서 시각화한다.
소단원-대단원 매핑은 Firestore가 아닌 프론트 상수로 관리한다.

`public/js/app.js`에 UNIT_MAP 상수 추가:

```js
const UNIT_MAP = {
  '힘과 운동': {
    chapterId: '1',
    subUnits: ['물체의 운동', '뉴턴 운동 법칙', '운동량과 충격량']
  },
  '에너지': {
    chapterId: '2',
    subUnits: ['역학적 에너지 보존', '열역학 법칙']
  },
  '전기와 자기': {
    chapterId: '3',
    subUnits: ['원자 모형과 전기력', '에너지 띠와 반도체', '전류의 자기 작용', '전자기 유도']
  },
  '파동': {
    chapterId: '4',
    subUnits: ['파동의 진동과 굴절', '파동의 간섭', '빛의 이중성', '물질의 이중성']
  },
};

// 소단원 → 대단원 찾기 헬퍼
function getChapter(unitName) {
  for (const [chapter, data] of Object.entries(UNIT_MAP)) {
    if (data.subUnits.includes(unitName)) return chapter;
  }
  return null;
}
```

Firestore unitProgress 저장 시 chapter 필드 함께 저장 → 마이페이지 대단원 카드 그룹핑에 활용.
extractKeywords 프롬프트의 소단원 리스트를 UNIT_MAP과 동일하게 유지하여 Gemini 반환값이 항상 키값과 일치하도록 보장한다.

---

## (1) 레벨 시스템 및 교정 루프

### 비로그인(게스트) 상태 처리
- 비로그인 상태에서는 푼 문제 데이터를 저장하지 않음
- 세션 종료(다음 학습 시작, 새로고침 등) 시 AppState.session 데이터 삭제
- 레벨/카운터 데이터는 로그인 사용자에게만 Firestore에 저장

### 공통 승급 조건 (전 레벨 동일)

- 같은 소단원 내 새로운 문제 누적 정답으로 승급
- 다시 풀어보기(같은 문제 재시도)는 카운트 안 됨
- 오답이 나와도 카운터 유지, 맞춘 것만 누적
- 카운터는 Firestore misconceptionProgress에 저장

```
// Firestore 저장 위치
/users/{uid}/misconceptionProgress/{unitId}_{misconceptionId}
  {
    count: 3,        // 현재 누적 정답 횟수
    overcome: false, // 승급 조건 달성 시 true
    lastUpdated: timestamp
  }

/users/{uid}/unitProgress/{unitId}
  {
    level: 1 | 2 | 3,
    completed: boolean,
    chapter: string,   // 대단원명
    bestScore: number,
    sessionCount: number,
    lastStudied: timestamp
  }
```

### 교정 루프

피드백 화면에서 승급 조건 미달 시 두 가지 선택지 제공:

```
[다시 풀어보기]           [유사 문제 풀기]
 동일 문제 재시도          새 문항으로 재도전 (+1 카운트 가능)
```

- 다시 풀어보기: 기존 questions 배열 재사용, API 호출 없음. checkedStatements/step2Answers만 초기화 후 STEP1으로 라우팅
- 유사 문제 풀기: extractKeywords 호출 없이 AppState.session에 저장된 detectedUnit, misconceptions, currentLevel을 그대로 재사용하여 generateQuestions만 새로 호출. 같은 소단원, 같은 오개념, 같은 레벨 기준으로 새 문장만 생성. 정답 시 카운터 +1

---

### 🟢 Level 1 — 개념 기본 이해

**평가 목표**
물리량의 정의, 벡터 방향성, 그래프 개형에 대한 직관적 이해 + 핵심 공식 인식

**문제 구성**
- 문장형 + 공식 문장 혼합 5문항
- 기존 STEP1/2 방식 그대로 유지 (체크 = 틀리다, 미체크 = 맞다)
- 틀리다 체크 → STEP2 서술 창으로 연결
- 맞다(미체크) → 서술 없이 넘어감
- 별도 문항 타입 추가 없이 기존 UI 재활용
- 공식 문장 예시:
  - "일의 양을 구하는 공식은 W = mv² 입니다" → 맞다/틀리다 판별
  - "F = ma 에서 가속도는 a = m/F 입니다" → 맞다/틀리다 판별

**승급 조건**
- 같은 소단원 내 새로운 문제 누적 5회 정답 → Level 2 승급

**Gemini 프롬프트 전략**
- 수식 계산이 없는 정성적 문장 + 공식 판별 문장을 혼합 생성하도록 지시
- 예: "계산 없이 개념의 옳고 그름을 판단할 수 있는 문장 3개 + 공식이 맞는지 틀린지 판별하는 문장 2개로 총 5개, 또는 계산 없이 개념의 옳고 그름을 판단할 수 있는 문장 4개 + 공식이 맞는지 틀린지 판별하는 문장 1개로 총 5개, 두 조합 중 하나를 랜덤으로 선택하여 생성해 줘"

**변경 파일**

| 파일 | 수정 내용 |
|------|-----------|
| `functions/index.js` | generateQuestions에 level 1 프롬프트 분기 추가, 공식 문장 생성 지시 |
| `firebase/api.js` | generateQuestions 호출 시 level 파라미터 추가 |
| `firebase/firestore.js` | 승급 카운터 저장/조회 함수 추가 (incrementCorrectCount, getUnitProgress) |
| `public/js/feedback.js` | 세션 종료 후 카운터 업데이트 로직 추가 |
| `public/js/app.js` | AppState.session에 currentLevel, correctCount 필드 추가, UNIT_MAP 상수 추가 |

---

### 🟡 Level 2 — 개념 응용 및 정량 계산

**평가 목표**
단일 물리 공식 매칭 및 수치 도출, 공식-상황 매칭

**문제 구성 (세션마다 랜덤으로 방식 A or B 결정)**
첫 세션에서 추출한 detectedUnit, misconceptions를 그대로 재사용. 이미지 재업로드 없음.

#### 방식 A — STEP1→STEP2 (기존 흐름 유지)
- 참/거짓 판별 문장 3문항 + 계산 2문항, 총 5문항
- 틀린 문항 1개 포함
- 참/거짓 판별 예시: "마찰 없는 빗면에서 물체가 미끄러지면 역학적 에너지는 보존됩니다" → 맞다/틀리다 체크 후 STEP2 서술
- 계산 문항은 수치가 주어지는 단답형, STEP2에서 풀이 서술
- 기존 STEP1 체크 → STEP2 서술 흐름 유지

#### 방식 B — 계산 화면 (새 화면)
- 단일 공식으로 풀리는 계산 문제 1문항
- 숫자 입력 input + 단위 드롭다운
- 예시: "질량 2kg인 물체에 5N의 힘을 가했을 때 가속도는?" → 2.5 / m/s² 선택
- Gemini가 생성 시 correctAnswer(숫자)와 unit(단위), unitOptions(단위 선택지) JSON에 포함
- 프론트에서 직접 비교 (오차 범위 ±1% 허용), AI 재채점 불필요

```js
// 방식 B JSON 구조
{
  "text": "질량 2kg인 물체에 5N의 힘을 가했을 때 가속도는?",
  "correctAnswer": 2.5,
  "unit": "m/s²",
  "unitOptions": ["m/s²", "N", "kg", "m/s"]
}
```

**승급 조건**
- 같은 소단원 내 새로운 문제 누적 5회 정답 → Level 3 승급

**변경 파일**

| 파일 | 수정 내용 |
|------|-----------|
| `functions/index.js` | level 2 프롬프트 분기, 방식 A/B 각각 문제 생성 프롬프트 추가 |
| `firebase/api.js` | level, mode 파라미터 추가 |
| `public/js/keyword.js` | 세션 시작 시 방식 A/B 랜덤 결정 후 AppState.session.quizMode에 저장 |
| `public/js/quiz.js` | 방식 B 계산 화면 렌더링 추가 (숫자 input + 단위 드롭다운, 정답 비교 로직) |
| `public/js/app.js` | AppState.session에 quizMode 필드 추가 |
| `quiz.css` | 숫자 input, 단위 드롭다운 스타일 추가 |
| `index.html` | screen-calc 화면 추가 |

---

### 🔴 Level 3 — 개념 종합 및 다단계 추론

**평가 목표**
소단원 하나를 중심으로 실생활 또는 수능/모의고사 스타일의 복합 상황에서 다단계 추론 및 수치 도출

**문제 구성 (고정)**
- 복합 계산 문제 1문항
- 소단원 중심 실생활/시험 스타일 문제
- 예시: "놀이공원 롤러코스터에서 질량 60kg인 사람이 반지름 10m인 원형 궤도 최저점을 통과할 때 바닥이 사람에게 가하는 힘은?"
- 두 가지 이상의 물리 법칙이 결합된 다단계 풀이 필요
- 첫 세션에서 추출한 detectedUnit, misconceptions를 그대로 재사용. 이미지 재업로드 없음.

**답안 입력 방식**

```
[최종 답]  _____ (단위 드롭다운)   ← 필수, 프론트 직접 비교

[풀이 과정]
  ✏️ 텍스트 입력     🖊️ 직접 쓰기    ← 탭으로 전환

  직접 쓰기 탭 선택 시:
    ├─ 📷 사진 찍기/업로드
    └─ 🖊️ 캔버스에 직접 쓰기 (패드+펜슬, 마우스 등)
```

- 텍스트 입력: textarea로 수식/설명 입력
- 캔버스: `<canvas>` 태그 + 터치/마우스 이벤트로 손글씨 입력
- 사진 업로드: 기존 홈화면 업로드 로직 재활용
- 캔버스/사진 모두 base64로 변환 → Gemini에 이미지로 넘겨서 채점
- 풀이 과정 채점은 Gemini가 담당 (추후 판별 정확도 낮을 시 피드백만 제공하는 B안으로 교체 가능하도록 gradeAnswers 내 분리 설계)

**승급 조건 및 완료 흐름**

```
누적 3회 정답 달성
  ├─ "계속 풀기" 버튼 → 새 문제 계속 생성
  └─ "완료하기" 버튼 → 소단원 완료 처리

5문제 도달 시 (3회 정답 여부 무관)
  → "이 개념을 완전히 이해했어요! 나중에 마이페이지에서 복습할 수 있어요" 문구 표시
  → 소단원 완료 처리
```

**변경 파일**

| 파일 | 수정 내용 |
|------|-----------|
| `functions/index.js` | level 3 복합 계산 문제 생성 프롬프트 추가, gradeAnswers에 풀이 과정 이미지/텍스트 채점 분기 추가 |
| `firebase/api.js` | level 3 파라미터 전달 |
| `public/js/quiz.js` | Level 3 화면 렌더링 (숫자 input + 풀이 과정 탭 UI + 캔버스 드로잉 로직 + 사진 업로드 로직) |
| `public/js/feedback.js` | 3회 달성 시 "계속 풀기 / 완료하기" 버튼 렌더링, 5문제 완료 시 완료 문구 표시 |
| `firebase/firestore.js` | 소단원 완료 상태 저장 |
| `index.html` | Level 3 화면 추가, 캔버스 UI 추가 |
| `quiz.css` | 캔버스, 탭 전환, 풀이 과정 입력 스타일 추가 |

---

## (2) 마이페이지 단원별 학습 현황 시각화

### 2-1. 현재 상태 vs 목표 상태

| 항목 | 현재 | 목표 |
|------|------|------|
| 취약 오개념 | 막대 그래프 (전체 합산) | 소단원별로 분리 표시 |
| 학습 이력 | 세션 목록 나열 | 대단원 카드로 그룹화 |
| 점수 추이 | 없음 | 소단원별 회차 추이 꺾은선 그래프 |
| 개념 향상도 | 없음 | 첫 세션 vs 최근 세션 비교 |
| 레벨 현황 | 없음 | 소단원별 레벨 배지 |

### 2-2. 화면 구조

**메인 뷰: 대단원 카드 목록**

```
┌────────────────────────────────────┐
│  힘과 운동                          │
│  ├ 물체의 운동       ●●●○  L2      │
│  ├ 뉴턴 운동법칙     ●○○○  L1      │
│  └ 운동량과 충격량   ✓완료          │
│                    [자세히 보기 →]  │
└────────────────────────────────────┘
```

- `●●●○`: 학습 횟수 점 표시 (최대 4개, 이후 숫자로)
- 레벨 배지: L1 / L2 / L3 / ✓ 완료
- "자세히 보기" 클릭 → 소단원 상세 화면

**소단원 상세 화면 (screen-mypage-detail)**

1. **점수 추이 꺾은선 그래프** — X축: 학습 회차, Y축: 점수(0~100), 첫/최근 세션 마커 강조
2. **개념 향상도 비교 배너** — 첫 세션 점수 vs 최근 세션 점수 차이 표시 (동일 소단원 기준)
3. **반복 오개념 유형 목록** — 2회 이상 틀린 오개념 ID 집계, 교정 완료 항목은 취소선 + 초록 체크
4. **과거 피드백 이력** — 날짜 / 점수 / 틀린 문장 수, 클릭 시 explanation 펼쳐보기
5. **추가 문제 풀기 버튼** — 화면 최하단 또는 우측 상단에 배치, 클릭 시 해당 소단원의 새 문제를 generateQuestions로 생성하여 추가 학습

- 소단원 상세 화면 진입 경로는 마이페이지에서만 허용 (다른 화면에서 바로가기 없음)
- 메인 카드 목록 자체에서 레벨/학습 횟수가 보이므로 상세 화면 진입 없이도 진척도 한눈에 파악 가능

### 2-3. Firestore 조회 로직

```js
// 소단원별 세션 목록 조회
const sessions = await db
  .collection('users').doc(uid)
  .collection('sessions')
  .where('unit', '==', unitId)
  .orderBy('createdAt', 'asc')
  .get();

// 개념 향상도 계산 (첫 세션 vs 최근 세션)
const scores = sessions.docs.map(d => d.data().score);
const improvement = scores.at(-1) - scores[0];
```

### 2-4. 변경 파일

| 파일 | 수정 내용 |
|------|-----------|
| `public/js/mypage.js` | 대단원 카드 뷰 렌더링, UNIT_MAP 기반 그룹핑, 레벨 배지 표시 |
| `public/js/feedback.js` | 세션 종료 시 unitProgress 업데이트 로직 추가 |
| `index.html` | screen-mypage-detail 화면 추가 |
| `feedback.css` | 상세 화면 스타일 (그래프, 배너, 이력 목록) |
| `public/js/app.js` | Router.navMap에 mypage-detail 추가 |

꺾은선 그래프는 외부 라이브러리 없이 SVG로 직접 구현하거나, index.html에 포함된 라이브러리가 있다면 그것을 활용한다.

---

## 구현 순서 권장

```
1. app.js — UNIT_MAP 상수 추가, AppState.session 필드 추가
2. firestore.js — unitProgress, misconceptionProgress 컬렉션 저장/조회 함수 추가
3. functions/index.js — level 파라미터 분기 추가 (L1 → L2 → L3 순서로)
4. firebase/api.js — level, mode 파라미터 추가
5. quiz.js — Level 2 방식 B 계산 화면, Level 3 화면 렌더링 추가
6. feedback.js — 승급 조건 판단 + 교정 루프 UI + Level 3 완료 흐름
7. index.html — screen-calc, Level 3 화면, 캔버스 UI 추가
8. quiz.css — 계산 input, 단위 드롭다운, 캔버스, 탭 스타일 추가
9. mypage.js — 대단원 카드 뷰, 소단원 상세 화면 구현
10. feedback.css — 마이페이지 상세 화면 스타일 추가
```

---

## 미결 사항

- Level 3 풀이 과정 채점 정확도는 실제 구현 후 확인하며 필요 시 B안(피드백만 제공)으로 교체
- 마이페이지 메인 카드에 취약도(반복 오개념)까지 요약 표시할지는 카드 UI 설계 시 추가 결정 필요
- screen-mypage-detail의 "추가 문제 풀기" 버튼 위치 (최하단 vs 우측 상단) 확정 필요