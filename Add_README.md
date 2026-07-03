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

## Firestore seed.js 오개념 데이터 현황

### misconception_dimensions (차원 코드)

| id | code | 이름 | 대상 단원 | 상태 |
|----|------|------|-----------|------|
| 1 | K | 운동학 | unit1 | ✅ seed.js 포함 |
| 2 | I | 임페투스 | unit1 | ✅ seed.js 포함 |
| 3 | AF | 능동적 힘 | unit1 | ✅ seed.js 포함 |
| 4 | AR | 작용-반작용 | unit1 | ✅ seed.js 포함 |
| 5 | CI | 힘의 합성 | unit1 | ✅ seed.js 포함 |
| 6 | G | 중력/저항 | unit1 | ✅ seed.js 포함 |
| 7 | ME | 역학적 에너지 보존 | unit2 | ✅ seed.js 포함 |
| 8 | WI | 파동의 간섭 | unit4 | ✅ seed.js 포함 |
| 9 | MD | 물질의 이중성 | unit4 | ✅ seed.js 포함 |
| 10 | EC | 전기 회로 | unit3 | ❌ 미추가 |
| 11 | MF | 자기장 | unit3 | ❌ 미추가 |
| 12 | EMI | 전자기 유도 | unit3 | ❌ 미추가 |
| 13 | MO | 운동량 | unit2 | ❌ 미추가 |
| 14 | AT | 원자 모형 | unit3 | ❌ 미추가 |
| 15 | EB | 에너지 띠와 반도체 | unit3 | ❌ 미추가 |
| 16 | LD | 빛의 이중성 | unit4 | ❌ 미추가 |
| 17 | WR | 파동·굴절 | unit4 | ❌ 미추가 |

---

### misconceptions (오개념 항목)

#### ✅ 기존 포함 (49개)

| ID | 단원 | 출처 |
|----|------|------|
| K1~K3 | unit1 힘과 운동 | Hestenes et al. (1992) FCI |
| I1~I5 | unit1 힘과 운동 | Hestenes et al. (1992) FCI |
| AF1~AF2, Ob | unit1 힘과 운동 | Hestenes et al. (1992) FCI |
| AR1~AR4 | unit1 힘과 운동 | Hestenes et al. (1992) FCI |
| CI1~CI3 | unit1 힘과 운동 | Hestenes et al. (1992) FCI |
| R1~R3 | unit1 힘과 운동 | Hestenes et al. (1992) FCI |
| G1~G5 | unit1 힘과 운동 | Hestenes et al. (1992) FCI |
| ME1~ME7 | unit2 에너지 | 이종주 (2009), 연세대 석사 |
| ME8~ME13 | unit2 에너지 | 정현 (2021), 충북대 석사 |
| WI1~WI5 | unit4 파동 | Yun, Kwak & Choi (2025), 새물리 |
| MD1 | unit4 파동 | 이창열 (2021), 서울대 학사 |

#### ❌ 추가 예정 (약 35개)

**unit2 추가분**

| ID | 오개념 | 출처 |
|----|--------|------|
| MO1 | 충돌 후 질량 큰 쪽이 더 빠르다 | 이종주 (2009) |
| MO2 | 완전비탄성충돌 시 운동량 감소 | 이종주 (2009) |
| MO3 | 운동량이 클수록 가속도가 크다 | 이종주 (2009) |

**unit3 전기 회로 (EC) — 이승노(2006), 한국교원대 석사**

| ID | 오개념 |
|----|--------|
| EC1 | 직렬회로 전류 소모 모형 — 전류가 각 소자를 지나며 소비되어 뒤로 갈수록 줄어든다 |
| EC2 | 전압·전류 혼동 — 전압과 전류를 같은 개념으로 혼동함 |
| EC3 | 병렬 = 저항 증가 — 병렬 연결 시 전체 저항이 증가한다 |
| EC4 | 전지 거리 비례 전류 — 전지에서 멀수록 전류가 약해진다 |
| EC5 | 전류 방향 = 전자 방향 — 전류 방향이 전자 이동 방향과 같다 |
| EC6 | 저항 = 전류 차단 — 저항은 전류를 아예 막는 것이다 |

**unit3 자기장 (MF) — 이승노(2006)**

| ID | 오개념 |
|----|--------|
| MF1 | 직선 도선 자기장 방향 오해 — 전류 방향과 자기장 방향을 평행하게 생각함 |
| MF2 | 자기장 세기 = 거리 무관 — 도선에서 멀어져도 자기장 세기가 일정하다 |
| MF3 | 같은 방향 전류 도선 = 반발 — 같은 방향 전류 도선이 서로 밀어낸다 |
| MF4 | N극에서만 자기력선 — 자기력선이 N극에서만 나온다 |
| MF5 | 코일 자기장 방향 직관 판단 — 오른손 법칙 없이 직관으로 판단 |
| MF6 | 자기장 세기 ∝ 전류 부정 — 전류를 2배로 해도 자기장은 2배가 안 된다 |
| MF7 | 전자석·영구자석 원리 무관 — 두 자석의 자기장은 전혀 다른 원리다 |

**unit3 전자기 유도 (EMI) — 이승노(2006) + 연구 기반 추론**

| ID | 오개념 |
|----|--------|
| EMI1 | 정지 자석 = 유도 전류 — 자석이 코일 근처에 있기만 해도 전류가 흐른다 |
| EMI2 | 자기장 세기 = 유도 기전력 — 자기장이 강하면 무조건 유도 기전력이 크다 |
| EMI3 | 개방 회로 전류 — 폐회로가 아니어도 유도 전류가 흐른다 |
| EMI4 | 유도 전류 방향 = N극 방향 — 유도 전류 방향이 자석 N극 방향과 같다 |
| EMI5 | 렌츠 법칙 절대 상쇄 — 유도 전류가 원래 자기장을 항상 완전히 상쇄시킨다 |

**unit3 원자 모형 (AT) — 장숙경(2014), 이화여대 석사 (고1 135명 조사)**

| ID | 오개념 |
|----|--------|
| AT1 | 스펙트럼 선 = 입자 — 선 스펙트럼의 선이 원자 속 입자를 나타낸다 (135명 중 다수) |
| AT2 | 스펙트럼선↔에너지 준위 미연결 — 스펙트럼 선이 전자의 에너지 준위 차이와 관련됨을 모름 |
| AT3 | 에너지 불연속 개념 미획득 — 전자 에너지가 불연속적이라는 양자 개념 이해 못함 |
| AT4 | 오비탈 = 전자 궤도 — 오비탈이 확률밀도가 아닌 전자가 실제로 도는 궤도라고 믿음 |
| AT5 | 점밀도 그림 점 = 개별 전자 — 오비탈 점밀도 그림의 각 점을 실제 전자 위치로 인식 |
| AT6 | 에너지 준위 = 거리만 — 전자 에너지를 원자핵과의 거리로만 판단, 보어 모형 고착 (64명 중 31.3%만 정답) |

**unit3 에너지 띠·반도체 (EB) — 장숙경(2014) 간접 근거 기반 추론**

| ID | 오개념 |
|----|--------|
| EB1 | 에너지 띠 ≠ 에너지 준위 연장 — 에너지 띠가 원자 에너지 준위에서 형성됨을 이해 못함 |
| EB2 | 반도체 = 불완전 도체 — 반도체가 에너지 띠 간격으로 설명되는 별개 물질임을 모름 |
| EB3 | 도핑 → 전하 생성 오해 — 도핑이 새 전하를 만든다고 믿음 (전하 이동이 아닌 생성으로 오해) |

**unit4 추가분**

**파동·굴절 (WR) — 최정훈(2015), 충북대 석사 (중1~3 45명 조사)**

| ID | 오개념 |
|----|--------|
| WR1 | 굴절 = 속도 불변 — 빛이 굴절할 때 속도는 변하지 않고 방향만 바뀐다 |
| WR2 | 굴절각 클수록 속도 증가 — 굴절각이 클수록 빛의 속도가 빠르다 |
| WR3 | 전반사 = 모든 각도 가능 — 전반사가 어떤 각도에서도 일어날 수 있다 |
| WR4 | 굴절 시 파장 불변 — 빛이 굴절할 때 파장이 변하지 않는다 (진동수·파장 혼동) |

**빛의 이중성 (LD) — 예비교사 간섭·회절 연구(서울대 박사, 2006) + 최정훈(2015)**

| ID | 오개념 |
|----|--------|
| LD1 | 빛 세기 ↑ = 광전자 에너지 ↑ — 빛의 세기가 강할수록 광전자 운동에너지가 커진다 |
| LD2 | 입자성·파동성 동시 발현 — 빛이 입자성과 파동성을 항상 동시에 드러낸다 |
| LD3 | 물질파 파장 = 입자 크기 비례 — 드브로이 파장이 클수록 입자가 크다 |
| LD4 | 간섭·회절 = 입자성 — 빛의 간섭·회절이 파동성이 아닌 입자성으로 설명된다 |

---

### seed.js 작업 체크리스트

```
[ ] dims 배열에 EC/MF/EMI/MO/AT/EB/LD/WR 8개 추가 (id 10~17)
[ ] unit2 — MO1~MO3 misconceptions + sentences 추가
[ ] unit3 — EC1~EC6 misconceptions + sentences 추가
[ ] unit3 — MF1~MF7 misconceptions + sentences 추가
[ ] unit3 — EMI1~EMI5 misconceptions + sentences 추가
[ ] unit3 — AT1~AT6 misconceptions + sentences 추가
[ ] unit3 — EB1~EB3 misconceptions + sentences 추가
[ ] unit4 — WR1~WR4 misconceptions + sentences 추가
[ ] unit4 — LD1~LD4 misconceptions + sentences 추가
[ ] serviceAccountKey.json 재발급 후 node seed.js 실행
```

---

## 미결 사항

- Level 3 풀이 과정 채점 정확도는 실제 구현 후 확인하며 필요 시 B안(피드백만 제공)으로 교체
- 마이페이지 메인 카드에 취약도(반복 오개념)까지 요약 표시할지는 카드 UI 설계 시 추가 결정 필요
- screen-mypage-detail의 "추가 문제 풀기" 버튼 위치 (최하단 vs 우측 상단) 확정 필요