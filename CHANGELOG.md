# PhysiClinic — 개발 변경 이력

이 문서는 이미 구현이 끝난 기능의 설계 배경과 세부 스펙을 기록한 히스토리입니다.
현재 진행 중이거나 아직 열려있는 사항은 [Add_README.md](Add_README.md)를 참고하세요.

---

## (1) 소단원 기반 레벨 시스템 + 교정 루프 (완료)

레벨 시스템은 소단원 단위로 관리하고, 마이페이지에서는 대단원으로 묶어서 시각화한다.
소단원-대단원 매핑은 Firestore가 아닌 프론트 상수로 관리한다 (`public/js/app.js`의 `UNIT_MAP` — 현재 값은 [Add_README.md](Add_README.md) 참고).

Firestore unitProgress 저장 시 chapter 필드 함께 저장 → 마이페이지 대단원 카드 그룹핑에 활용.
extractKeywords 프롬프트의 소단원 리스트를 UNIT_MAP과 동일하게 유지하여 Gemini 반환값이 항상 키값과 일치하도록 보장한다.

### 비로그인(게스트) 상태 처리
- 비로그인 상태에서는 푼 문제 데이터를 저장하지 않음
- 세션 종료(다음 학습 시작, 새로고침 등) 시 AppState.session 데이터 삭제
- 레벨/카운터 데이터는 로그인 사용자에게만 Firestore에 저장

### 공통 승급 조건

- 같은 소단원 내 새로운 문제 누적 정답으로 승급
- 다시 풀어보기(같은 문제 재시도)는 카운트 안 됨
- 오답이 나와도 카운터 유지, 맞춘 것만 누적
- 카운터는 Firestore unitProgress.correctCount에 저장 (소단원 단위 통합)
- **합격("맞춘 것") 판정 점수는 레벨별로 다름** — L1·L2는 100점, L3는 90점
  (`public/js/feedback.js`의 `PROMOTION_SCORE`). 원래 전 레벨 100점이었으나 L3만
  승급이 불가능해 조정함 — 사유는 [(4)절](#4-코드-점검--문제-풀이-화면-버그-수정-완료-2026-07) 참고

```
// Firestore 저장 위치
/users/{uid}/unitProgress/{소단원명}
  {
    level: 1 | 2 | 3,
    completed: boolean,
    correctCount: number,  // 현재 누적 정답 횟수 (승급 시 0으로 리셋)
    chapter: string,       // 대단원명
    lastStudied: timestamp
  }
```

> ⚠️ 기존 misconceptionProgress 컬렉션은 더 이상 승급 카운터로 사용하지 않음.
> Gemini가 매 세션 다른 오개념 ID를 선택해 카운터가 분산되는 문제로 인해 unitProgress로 통합함.
> misconceptionProgress는 향후 마이페이지 "취약 개념" 표시 용도로만 활용 예정.

### 승급 목표치 (동적 계산)

소단원마다 오개념 수가 다르므로 목표치를 고정하지 않고 실시간 계산:

```js
// feedback.js 내 계산 로직
L1 목표: Math.min(Math.max(Math.round(오개념수 × 1.7), 10), 20)
L2 목표: Math.min(Math.max(Math.round(오개념수 × 1.3), 7),  13)
L3 목표: Math.min(Math.max(Math.round(오개념수 × 1.0), 5),  10)
```

| 소단원 | 오개념 수 | L1 목표 | L2 목표 | L3 목표 |
|--------|----------|---------|---------|---------|
| 뉴턴 운동 법칙 | 18 | 20 | 13 | 10 |
| 역학적 에너지 보존 | 13 | 20 | 13 | 10 |
| 전류의 자기 작용 | 13 | 20 | 13 | 10 |
| 전자기 유도 | 5 | 10 | 7 | 5 |
| 물체의 운동 | 8 | 14 | 10 | 8 |
| 운동량과 충격량 | 3 | 10 | 7 | 5 |
| 원자 모형과 전기력 | 6 | 10 | 8 | 6 |
| 에너지 띠와 반도체 | 3 | 10 | 7 | 5 |
| 파동의 진동과 굴절 | 4 | 10 | 7 | 5 |
| 파동의 간섭 | 5 | 10 | 7 | 5 |
| 빛의 이중성 | 4 | 10 | 7 | 5 |
| 물질의 이중성 | 1 | 10 | 7 | 5 |

목표치는 Firestore에 저장하지 않고 매 세션 오개념 수 조회 결과로 즉시 계산 → seed.js에 오개념 추가 시 자동 반영됨.

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
- 소단원 오개념 수 기반 동적 목표치 달성 → Level 2 승급 (위 표 참고)

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
  "unitOptions": ["m/s²", "N", "kg", "m/s"]  // ⚠️ 정답이 항상 [0]번 — 렌더링 시 반드시 셔플할 것
}
```

> ⚠️ `unitOptions`는 프롬프트 지시상 **정답 단위가 항상 첫 번째**로 생성된다. 화면에 뿌릴 때
> `QuizScreen._shuffle()`로 반드시 섞어야 한다 — 안 섞으면 `<select>`의 기본 선택값이 곧 정답이
> 되어 단위 판정이 무력화된다. 실제로 그 상태로 배포돼 있었고 [(4)절](#4-코드-점검--문제-풀이-화면-버그-수정-완료-2026-07)에서 수정함.

**승급 조건**
- 소단원 오개념 수 기반 동적 목표치 달성 → Level 3 승급 (위 표 참고)

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

**승급 조건 및 완료 흐름 (실제 구현: L1/L2와 동일한 동적 목표치 방식)**

```
소단원 오개념 수 기반 동적 목표치 달성 (위 표 참고, L3 기준 min 5 ~ max 10)
  → 소단원 완료 처리 (unitProgress.completed = true)
  → "이 단원을 완전히 이해했어요!" 배너 표시 후 홈으로 이동
```

> ⚠️ 별도의 "누적 3회 정답 → 계속 풀기/완료하기" 버튼이나 "5문제 도달 시 강제 완료" 캡은 도입하지 않음.
> L1→L2, L2→L3 승급과 동일한 로직(_calcTarget/calcPromotionTarget)을 그대로 재사용해 일관성을 유지하기로 결정.

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

## (2) 마이페이지 단원별 학습 현황 시각화 (완료, 2026-07)

### 2-1. 당시 현재 상태 vs 목표 상태

| 항목 | 이전 | 목표 |
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
- (구현) "자세히 보기" 버튼 대신 소단원 행 자체를 클릭하면 상세 화면으로 이동

**소단원 상세 화면 (screen-mypage-detail)**

1. **점수 추이 꺾은선 그래프** — X축: 학습 회차, Y축: 점수(0~100), 첫/최근 세션 마커 강조
2. **개념 향상도 비교 배너** — 첫 세션 점수 vs 최근 세션 점수 차이 표시 (동일 소단원 기준)
3. **반복 오개념 유형 목록** — 2회 이상 반복된 오개념만 표시 (id → 실제 한글 이름은
   `MisconceptionDB.getMisconceptionById`로 조회). (구현) "교정 완료" 취소선 표시는 뺐음 —
   세션에는 "이 세션이 다룬 오개념"만 기록되고 "그 문항을 맞았는지"는 별도 연결이 없어서,
   교정 여부를 정확히 판단할 근거가 없었음. 잘못된 정보를 보여주느니 반복 횟수만 정확히 표시.
4. **과거 문제 풀이 이력** — 날짜 / 점수 / 틀린 문항 수, "문제 보기" 버튼 클릭 시 새 화면을
   만들지 않고 기존 `viewSessionLog()` + `FeedbackScreen.render(data, true, 'mypage-detail')`를
   재사용해 실제 채점 화면과 동일한 방식으로 문항별 피드백을 보여줌
5. **추가 문제 풀기 버튼** — (구현) 화면 최하단에 배치. 클릭 시 `pickQuizMode()`로 모드를
   고르고 `generateQuestions([], subUnit, level, mode)` 호출 → 결과에 따라 step1/calc/level3
   화면으로 분기 (keyword.js의 최초 출제, feedback.js의 다음 문제 풀기와 동일한 패턴 재사용)

- 소단원 상세 화면 진입 경로는 마이페이지에서만 허용 (다른 화면에서 바로가기 없음)
- 메인 카드 목록 자체에서 레벨/학습 횟수가 보이므로 상세 화면 진입 없이도 진척도 한눈에 파악 가능

### 2-3. Firestore 조회 로직

```js
// (구현) where + orderBy를 같이 쓰면 복합 인덱스가 필요해지므로,
// where만 쿼리하고 정렬은 클라이언트에서 처리해 인덱스 배포 없이 바로 동작하게 함
const sessions = await fetchSessionsByUnit(uid, unitName); // where('unit','==',unitName)만 사용, 이후 .sort()

// 개념 향상도 계산 (첫 세션 vs 최근 세션)
const scores = sessions.map(s => s.score);
const improvement = scores.at(-1) - scores[0];
```

### 2-4. 변경 파일

| 파일 | 수정 내용 |
|------|-----------|
| `public/firebase/firestore.js` | `fetchAllUnitProgress`, `fetchSessionsByUnit` 추가, `fetchWeakMisconceptions`에 소단원 필터 추가, `MisconceptionDB.getMisconceptionById` 추가, `saveSession`에 `wrongCount` 필드 저장 |
| `public/js/mypage.js` | 전면 재작성 — 대단원 카드 뷰, 소단원 상세(SVG 그래프 직접 구현), 추가 문제 풀기 |
| `public/index.html` | 메인 화면을 카드 목록으로 교체, `screen-mypage-detail` 신규 추가 |
| `public/css/feedback.css` | 안 쓰던 취약오개념 막대바/이력 리스트 스타일을 카드형으로 교체 |
| `public/js/app.js` | Router.navMap/authRequired에 `mypage-detail` 추가 |

꺾은선 그래프는 외부 라이브러리 없이 SVG로 직접 구현함 (그리드선 + 영역 채우기 그라디언트 + 첫/최근 지점 강조).

### 2-5. 실제 구현 시 달라진 점 / 발견된 이슈

마이페이지를 실제로 붙이면서 기존 `saveSession()`/`unitProgress` 쪽에서 이 기능과 무관하게
존재하던 데이터 정합성 문제 두 가지를 발견해서 같이 고쳤다:

1. **`sessionCount` 레이스 컨디션** — `saveSession()`이 `unitProgress`의 `sessionCount`를
   "읽고 → +1 해서 쓰기" 방식으로 갱신하고 있어서, 문제를 연달아 빠르게 풀면(초 단위 간격)
   동시 저장 요청끼리 서로의 증가분을 덮어써서 실제 세션 수보다 적게 기록되는 버그가 있었음
   (실제 계정에서 세션 22개인데 `sessionCount: 8`로 기록된 사례로 확인). Firestore
   트랜잭션(`runTransaction`)으로 전환해 해결 — 동시 저장 20개로 재현 테스트해서 정확히
   20으로 기록되는 것 확인.
2. **AI가 반환하는 unit 값이 UNIT_MAP 14개 소단원명과 다를 수 있음** — 실제 계정들에서
   `"힘과 운동"`(대단원명을 그대로 반환), `"전기장과 전위"`(목록에 없는 이름) 같은 사례
   발견. 카드 목록에서 14개 소단원명과 정확히 일치하는 것만 보여주면 이런 세션은 영원히
   안 보이게 되므로, 마이페이지에 "기타" 카드를 추가해서 이름이 안 맞는 unitProgress도
   최소한 어딘가엔 표시되도록 안전장치를 넣음.
3. **레벨 시스템 도입 이전(대략 2026-04~05) 세션은 `unitProgress` 문서 자체가 없음** —
   `unitProgress` 갱신 코드가 레벨 시스템과 함께 나중에 추가된 것이라, 그 전에 풀고 이후
   한 번도 안 돌아온 단원은 세션 기록은 있어도 진행 상태 문서가 없어서 카드에 "시작 전"으로
   나옴. 과거 세션을 기반으로 `unitProgress`를 소급 생성하는 백필 스크립트도 검토했으나,
   레벨 시스템이 없던 시절 데이터라 "레벨"을 정확히 복원할 근거가 없어 **의도적으로 보류**함.
   (2번·3번 이슈 모두 앞으로 새로 푸는 세션에는 영향 없음 — 지금 코드는 항상 unitProgress를
   정상적으로 생성/갱신함)

---

## 구현 순서 (완료 기록)

```
[x] 1. app.js — UNIT_MAP 상수 추가, AppState.session 필드 추가
[x] 2. firestore.js — unitProgress.correctCount 기반 승급 카운터 구현
[x] 3. functions/index.js — level 파라미터 분기 추가 (L1 → L2 → L3)
              + subUnit 기반 오개념 필터링
              + misconceptionCount 반환
[x] 4. firebase/api.js — level, mode 파라미터 추가
[x] 5. quiz.js — Level 2 방식 B 계산 화면, Level 3 화면 렌더링 추가
[x] 6. feedback.js — 승급 조건 판단 + 교정 루프 UI
              + 동적 목표치 계산 (calcPromotionTarget, L1/L2/L3 공용)
              + n/target 진행 표시
              + L3는 별도 완료 흐름 없이 동일 로직으로 completed 처리
[x] 7. index.html — screen-calc, Level 3 화면, 캔버스 UI 추가
[x] 8. quiz.css — 계산 input, 단위 드롭다운, 캔버스, 탭 스타일 추가
[x] 9. mypage.js — 대단원 카드 뷰, 소단원 상세 화면 구현 (2026-07)
[x] 10. feedback.css — 마이페이지 상세 화면 스타일 추가 (2026-07)
```

---

## Firestore seed.js 오개념 데이터 시딩 이력

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
| 10 | EC | 전기 회로 | unit3 | ✅ seed.js 포함 |
| 11 | MF | 자기장 | unit3 | ✅ seed.js 포함 |
| 12 | EMI | 전자기 유도 | unit3 | ✅ seed.js 포함 |
| 13 | MO | 운동량 | unit2 | ✅ seed.js 포함 |
| 14 | AT | 원자 모형 | unit3 | ✅ seed.js 포함 |
| 15 | EB | 에너지 띠와 반도체 | unit3 | ✅ seed.js 포함 |
| 16 | LD | 빛의 이중성 | unit4 | ✅ seed.js 포함 |
| 17 | WR | 파동·굴절 | unit4 | ✅ seed.js 포함 |

### misconceptions (오개념 항목)

#### 기존 포함 (49개)

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

#### 추가 완료 (38개 — 2026-07 시딩 완료)

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

### seed.js 작업 체크리스트

```
[x] dims 배열에 EC/MF/EMI/MO/AT/EB/LD/WR 8개 추가 (id 10~17)
[x] unit2 — MO1~MO3 misconceptions + sentences 추가
[x] unit3 — EC1~EC6 misconceptions + sentences 추가
[x] unit3 — MF1~MF7 misconceptions + sentences 추가
[x] unit3 — EMI1~EMI5 misconceptions + sentences 추가
[x] unit3 — AT1~AT6 misconceptions + sentences 추가
[x] unit3 — EB1~EB3 misconceptions + sentences 추가
[x] unit4 — WR1~WR4 misconceptions + sentences 추가
[x] unit4 — LD1~LD4 misconceptions + sentences 추가
[x] 전체 87개 오개념에 subUnit 필드 추가 (소단원 기반 필터링용)
[x] serviceAccountKey.json 재발급 후 node seed.js 실행 (2026-07)
    → misconceptions 87개, misconception_sentences 166개 시딩 완료
[x] question_patterns 컬렉션 추가 — 완자 물리학Ⅰ 기출 유형 116개 (2026-07)
    → 상황 설정/함정 포인트만 추상화, 문제 원문·숫자는 포함하지 않음
    → generateQuestions가 소단원 기준으로 조회해 문제 스타일 참고자료로 프롬프트에 주입
[x] item_misconception_map을 FCI_FMCE_extracted.xlsx 원본과 100% 일치하도록 보완 (2026-07)
    → 6개 오개념 코드 누락 + 12개 부분 누락 수정, 74건 → 130건
    → 현재 앱 로직에서는 미사용, 향후 "FCI 문항 그대로 풀리는 정식 진단평가" 기능용으로 정확도만 확보
[x] misconception_sentences / scoring_keywords / item_misconception_map에 고유 id 부여 (2026-07)
    → batchUpload를 id 기반 덮어쓰기(upsert) 방식으로 전환, node seed.js를 몇 번 재실행해도 중복 안 쌓임
    → 기존에 반복 실행으로 3배씩 쌓여있던 중복 데이터는 삭제 후 재시딩으로 정리 완료
```

---

## (3) 과거 기록 "다시 풀기" 기능 및 관련 정리 (완료, 2026-07)

### 배경

마이페이지에서 "문제 보기"로 과거 세션을 열람만 할 수 있었는데, 그 자리에서 같은 문제를
다시 풀어볼 수 있게 해달라는 요청으로 시작. STEP1/2(문장형) → Level 2 계산형 → Level 3
순서로 단계적으로 확장했고, 그 과정에서 발견한 버그 수정과 코드 정리도 같이 진행함.

### 3-1. 다시 풀기 — 문항 유형별 지원 범위

| 유형 | 지원 여부 | 이유 |
|------|-----------|------|
| STEP1/2 (문장 5개) | ✅ | 로그에 문장 5개(id/text/isWrong)가 그대로 남아있어 원본 그대로 복원 가능 |
| Level 2 계산형(방식B) | ✅ | `correctAnswer`/`unit`/`unitOptions`를 로그에 추가로 저장하도록 확장 |
| Level 3 | ✅ | 위 필드에 더해 `solutionSteps`/`isLevel3`까지 저장하도록 확장 |
| 이 기능 이전에 저장된 기록 | ❌ (자동 비활성화) | 위 필드들이 로그에 없어서 `_canRetryHistory()`가 자동으로 걸러냄 — 하위 호환 문제없음 |

**변경 파일**
| 파일 | 수정 내용 |
|------|-----------|
| `public/js/quiz.js` | 계산형(Level 2방식B) 채점 시 `correctAnswer`/`unit`/`unitOptions` 저장, Level 3 `_finalize()`에 `isLevel3`/`solutionSteps` 포함 |
| `public/firebase/firestore.js` | `saveSession()`/`fetchSessionLogs()`가 위 필드들을 저장·반환하도록 확장 |
| `public/js/feedback.js` | `_canRetryHistory()`, `retrySameHistory()` 추가 — 문항 유형에 따라 STEP1/계산 화면/Level3 화면 중 알맞은 곳으로 복원 |

### 3-2. 재도전 결과 화면 — 레벨 정보 없는 간단 버전

과거 기록에서 "다시 풀기"로 재도전한 결과는 레벨/승급 카운터와 무관하므로(`isRetry=true`라
DB에 반영 안 됨), 화면도 승급 UI 없이 간단하게: 점수/피드백만 보여주고 아래 버튼 2개만 제공.

```
[학습 현황으로 돌아가기]   [새 문제 풀기]
```

`AppState.session.isHistoryRetry` 플래그로 이 케이스를 구분 (`FeedbackScreen._handleLevelProgress`
맨 앞에서 분기). 새 문제를 생성하면(`retrySimilar`) 이 플래그를 다시 `false`로 돌려 정상
승급 흐름으로 복귀.

### 3-3. 상단 뒤로가기 목적지 — "분석 결과" / "학습 현황" / "문제풀기" 3분기

문제 화면(STEP1/계산/Level3)에 들어온 경로에 따라 상단 뒤로가기 버튼의 목적지와 라벨이
달라져야 함:
- 홈 → 사진 업로드로 들어온 정상 흐름: "< 분석 결과" → keyword 화면
- 마이페이지 상세에서 "이어서 풀기"/"다시 풀기"로 들어온 경우: "< 학습 현황" → mypage-detail
- 문제풀기 탭 기록에서 "다시 풀기"로 들어온 경우: "< 문제풀기" → quiz-library

`app.js`에 `setQuizBackTarget(target)` / `quizGoBack()` 공용 함수 추가, `AppState.session._quizBackTarget`에
목적지를 저장해두고 진입 경로마다(`KeywordScreen.start`, `MypageScreen.retryUnit`,
`FeedbackScreen.retrySameHistory`) 알맞게 설정.

### 3-4. 마이페이지 이력 — 레벨 배지 + 같은 문제끼리 그룹핑

- **레벨 배지**: 세션 저장 시 `level` 필드를 같이 저장(`sessionData.currentLevel`), 이력 목록에
  L1/L2/L3 배지로 표시. 이 기능 이전 기록은 필드가 없어 배지 없이 표시 (하위 호환).
- **재도전 그룹핑**: 세션 저장 시 재도전이면 원본 문제 id를 `retryOf` 필드로 같이 저장
  (재도전의 재도전도 항상 최초 원본을 가리키도록 유지 — `AppState.session._rootSessionId`를
  통해 체인 전체에 전파). 마이페이지 이력에서 `retryOf` 기준으로 그룹핑해서 재도전 없으면
  기존처럼 한 줄, 있으면 "재풀이 횟수: N"으로 접어서 표시하고 펼치면 1차/2차/3차... 개별
  시도를 볼 수 있음.
- "틀린 문항 N개" 텍스트는 사용자에게 혼동을 줄 수 있어 제거 (레이아웃 spacer 역할만 유지).
- 마이페이지 메인의 소단원 진행 점(●●●○)을 "몇 번 풀었는지" 대신 "현재 레벨(점 3개, L1~L3)"로
  의미 변경.

> ⚠️ **참고**: 소단원 상세 화면의 점수 추이 그래프는 재도전까지 전부 개별 점으로 표시하고,
> 바로 아래 이력 목록은 재도전을 그룹으로 묶어서 표시함 — 같은 화면 안에서 두 영역이
> "재도전"을 다르게 다룸. 그래프는 "점수가 어떻게 변해왔는지" 추이를 보여주는 용도, 이력
> 목록은 "서로 다른 문제를 몇 개나 풀었는지" 정리해서 보여주는 용도라 각자 목적에 맞게
> 의도적으로 다르게 처리한 것이며, 버그는 아님. 통일하고 싶으면 그래프도 그룹 단위(문제당
> 최신 점수 하나)로 그리도록 바꿔야 함 — 아직 요청 없어 보류.

### 3-5. 개발 중 발견/수정한 버그

1. **마이페이지 상세로 돌아와도 이력이 바로 안 바뀌던 문제** — "학습 현황으로 돌아가기"가
   `Router.go('mypage-detail')`만 호출해서 화면 전환만 하고 데이터는 새로고침 안 됐음.
   `MypageScreen.goDetail()`을 같이 호출하도록 수정. (수정 과정에서 `window.MypageScreen`으로
   잘못 참조해 새로고침이 아예 실행 안 되는 2차 버그도 같이 발생 → `mypage.js`가 모듈이 아닌
   일반 스크립트라 `window.` 없이 바로 참조해야 한다는 걸 재확인하고 수정)
2. **재도전 시 화면에 "Level 1"로 잘못 표시되던 문제** — `retrySameHistory()`가
   `AppState.session.currentLevel`을 갱신 안 해서, 과거 화면 열람 중 남아있던 값(보통 기본값 1)이
   그대로 표시됨. 실제 Firestore에 저장된 레벨/카운터는 (isRetry=true라 애초에 DB에 안 쓰여서)
   안전했고, 화면 표시만 문제였음. `retrySameHistory()`에서 `LearningService.getUnitProgress()`로
   실제 값을 다시 조회하도록 수정.
3. **Level 3 화면 "텍스트 입력" 탭 버튼 HTML 태그 깨짐** — `<button>...도중</button>텍스트 입력</button>`처럼
   `</button>`가 하나 더 들어가 있어서 라벨 텍스트가 버튼 밖으로 빠져나가 있었음 (클릭 안 됨).

### 3-6. 코드 정리 — 문제 화면 라우팅 로직 통합

"결과가 계산형인지/Level3인지 보고 step1·calc·level3 중 어디로 보낼지" 판단하는 로직이
`keyword.js`(startQuiz), `feedback.js`(retrySame/retrySimilar/retrySameHistory),
`mypage.js`(retryUnit) 5곳에 거의 동일하게 복사돼 있던 것을 `app.js`의 공용 함수 2개로 통합:

```js
routeToQuizScreen()      // AppState.session.calcQuestion/questions가 이미 세팅된 상태에서 라우팅만
applyQuizResult(result)  // generateQuestions 응답을 세션에 반영한 뒤 routeToQuizScreen() 호출
```

5곳 전부 이 함수 호출로 교체 — 나중에 화면이 하나 늘어나거나 분기 조건이 바뀌어도 한 곳만
고치면 됨.

---

## (4) 코드 점검 — 문제 풀이 화면 버그 수정 (완료, 2026-07)

### 배경

기능 추가가 일단락된 시점에 전체 코드를 정적 점검하면서 발견한 버그 중, **사용자 화면에
곧바로 드러나는 것들**을 우선 묶어서 수정했다. 공통점은 전부 "새 화면을 추가하면서 기존
화면에만 있던 처리를 옮겨 적지 않아 생긴 누락"이라는 점이다 — 특히 나중에 추가된
`screen-calc`와 `screen-level3`이 `QuizScreen.init()`이 하던 초기화를 물려받지 못했다.

### 4-1. 계산 문제 단위 선택지에 정답이 항상 첫 번째로 노출

가장 심각했던 문제. `generateQuestions` 프롬프트가 `unitOptions`를
`["정답단위", "헷갈릴단위1", ...]` 순서로 생성하도록 지시하는데, `QuizScreen.initCalc()`가
그 배열을 **받은 순서 그대로** `<option>`으로 렌더링하고 있었다.

`<select>`는 첫 번째 항목이 기본 선택값이므로, **학생이 단위 드롭다운을 건드리지 않으면
무조건 정답 단위가 제출된다.** `submitCalc()`의 `isUnitCorrect` 검사가 사실상 무력했음.

→ `QuizScreen._shuffle()`(원본 배열을 건드리지 않는 Fisher-Yates)을 추가해 렌더링 직전에 섞음.
채점은 인덱스가 아니라 `userUnit === calcQuestion.unit` 문자열 비교라 셔플의 영향을 받지 않음.

> 프롬프트 쪽에서 "섞어서 생성하라"고 지시하는 방법도 있었지만, LLM이 지킬지 보장할 수 없어서
> **프론트에서 강제로 섞는 쪽**을 택했다. 정답 위치는 모델 출력에 의존하면 안 되는 값이다.

### 4-2. 계산·Level 3 화면에서 힌트 버튼이 눌러도 반응 없음

`AppState.session.hintUsed`는 힌트 단계를 판단하는 카운터인데, 이걸 0으로 되돌리는 코드가
`QuizScreen.init()`(STEP1)에만 있었다. `initCalc()`와 `Level3Screen.init()`은 힌트 버튼의
`disabled` 속성만 되돌리고 카운터는 그대로 뒀다.

결과적으로:

```
앞 문제에서 힌트 2개 사용 (hintUsed = 2)
  → 계산 문제로 이동 (버튼은 disabled=false로 초기화되어 활성화돼 보임)
  → 힌트1 클릭 → useCalcHint(1)의 `used === 0` 조건 불통과 → 아무 일도 안 일어남
```

버튼이 멀쩡해 보이는데 반응만 없어서 "고장난 것"처럼 보였음.
→ `initCalc()`와 `Level3Screen.init()`에서 `hintUsed = 0`을 명시적으로 초기화.

같은 함수에서 `checkedStatements`도 함께 비웠다. 계산형 화면에는 체크박스가 아예 없는데도
직전 STEP1 문제의 체크 상태가 남아, `saveSession()`의 `checkedCount`에 엉뚱한 값이
저장되고 있었기 때문이다.

### 4-3. Level 3 힌트 사용량이 기록되지 않던 문제

`Level3Screen.useHint()`는 힌트 텍스트를 표시하기만 하고 `hintUsed`를 갱신하지 않았다.
STEP1(`useHint`)·계산형(`useCalcHint`)과 달리 L3 세션만 **힌트를 두 개 다 봐도 DB에
`hintUsed: 0`으로 저장**됐음. 향후 학습 분석에서 쓸 수 없는 데이터가 쌓이던 상태.

→ `session.hintUsed = Math.max(session.hintUsed || 0, n)`으로 갱신하고, 사용한 힌트 버튼을
비활성화하는 처리도 다른 화면과 동일하게 맞춤.

### 4-4. Level 3 승급(= 단원 완료)이 구조적으로 불가능

승급 카운터는 `data.score === 100`일 때만 올라갔다. 그런데 L3 최종 점수는:

```
finalScore = 정답 여부(100 또는 0) × 0.6  +  AI 풀이 과정 점수 × 0.4
```

즉 **풀이 과정에서 100점을 받아야만** 총점 100점이 된다. 그런데 `gradeSolutionProcess`
프롬프트는 "score가 100점이 아니라면 감점 사유를 반드시 구체적으로 짚어라"고 강하게
지시하고 있어 모델이 90~95점으로 수렴한다. 결과적으로 **L3에서 아무리 완벽하게 풀어도
승급 카운터가 한 번도 오르지 않고, 🏆 "단원 완료" 상태에 영원히 도달할 수 없었다.**

→ 레벨별 합격 기준 테이블을 도입:

```js
// public/js/feedback.js
const PROMOTION_SCORE = { 1: 100, 2: 100, 3: 90 };
```

L3는 90점 = 정답을 맞히고(60점) 풀이 과정 75점 이상이면 통과하는 수준.
`isPerfect` 변수명도 의미가 바뀌어 `isPassed`로 정리했다.

> L1·L2를 100점으로 유지한 이유: 이 두 레벨은 문항 정오답이 명확해서 만점을 요구해도
> 도달 가능하고, "완벽히 이해했을 때만 다음 단계"라는 교정 루프의 원래 취지에 맞는다.
> L3만 예외인 건 AI 서술 채점이 끼어들어 점수 상한이 사실상 100이 아니기 때문.

### 4-5. 완료한 단원인데 "L3 이어서 풀기"가 계속 노출

`incrementCorrectCount()`는 `completed: true`인 소단원에서는 카운터를 올리지 않는다.
그런데 마이페이지 상세의 `_updateRetryButton()`은 완료 여부와 무관하게 항상
`L{level} 이어서 풀기`를 표시했다. 사용자 입장에서는 **계속 풀어도 아무 변화가 없는 이유를
알 수 없는 상태**였음.

→ `goDetail()`에서 `_currentCompleted`를 저장하고, 완료된 단원은
`✓ 완료한 단원 · 복습 문제 풀기`로 라벨을 분기. 기능(문제 생성)은 그대로 두고 성격만
"승급용"에서 "복습용"으로 명시했다.

### 4-6. 문제풀기 탭이 로그인 없이도 뒤에서 실행되던 문제

`screen-quiz-library`에는 비로그인 안내 배너(`#library-login-banner`)와 "새 사진으로 학습 시작"
버튼이 마크업에 이미 들어 있다. 즉 **게스트도 볼 수 있는 화면으로 설계돼 있었다.**
그런데 `Router.authRequired`에 `quiz-library`가 들어가 있어서:

- 게스트가 탭을 누르면 로그인 모달만 뜨고 화면 전환은 차단됨
- `QuizLibraryScreen.init()`의 비로그인 분기(배너 표시)는 **영원히 도달하지 않는 죽은 코드**
- 그런데 nav의 `onclick`이 `Router.go(...); QuizLibraryScreen.init()`이라
  **전환이 막힌 뒤에도 `init()`은 그대로 실행**되어 보이지 않는 화면에 렌더링됨

→ 두 가지를 함께 수정:

1. `authRequired`에서 `quiz-library` 제외 → 원래 설계대로 게스트에게 배너가 보임
   (`mypage`, `mypage-detail`만 남김)
2. `Router.go()`가 **전환 성공 여부(boolean)를 반환**하도록 변경하고, nav를
   `if (Router.go('mypage')) MypageScreen.init()` 형태로 수정 → 앞으로 인증 게이트에 걸린
   화면의 init이 뒤에서 도는 일이 구조적으로 막힘

### 4-7. 변경 파일

| 파일 | 수정 내용 |
|------|-----------|
| `public/js/quiz.js` | `_shuffle()` 추가 및 단위 선택지 셔플, `initCalc`/`Level3Screen.init`에서 `hintUsed`·`checkedStatements` 초기화, `Level3Screen.useHint`가 `hintUsed` 갱신 |
| `public/js/feedback.js` | `PROMOTION_SCORE` 테이블 추가, `isPerfect` → `isPassed`로 정리 |
| `public/js/mypage.js` | `_currentCompleted` 상태 추가, 완료 단원 버튼 라벨 분기 |
| `public/js/app.js` | `authRequired`에서 `quiz-library` 제외, `Router.go()`가 boolean 반환 |
| `public/index.html` | 하단 nav의 `Router.go(); init()` → `if (Router.go()) init()` |

### 4-8. 검증 방법

Firebase 에뮬레이터(hosting)에 띄운 뒤 브라우저 콘솔에서 각 함수를 직접 호출해 확인:

```
단위 셔플 20회 첫 보기 분포 : { m/s²:7, m/s:5, N:4, J:4 }   ← 수정 전엔 m/s² 20/20
채점 정확도                : 정답+정단위 100 / 정답+오단위 0 / 오답+정단위 0
힌트 (직전 hintUsed=2 상태) : init 후 0 → 클릭 후 1, 힌트 텍스트 정상 노출
L3 힌트                    : useHint(1)→1, useHint(2)→2, 버튼 상태 정상
승급 기준                  : L1 95점 불합격 / L3 92점 합격 / L3 85점 불합격
완료 단원 라벨             : "✓ 완료한 단원 · 복습 문제 풀기"
게스트 문제풀기 탭         : 진입 성공, 안내 배너 표시됨
```

> `QuizScreen`·`MypageScreen` 등은 `window`에 노출되지 않은 전역 `const`라 개발자도구 콘솔에서
> 바로 참조하면 잡히지 않을 수 있음. `window.eval("QuizScreen")`처럼 전역 스코프에서
> 평가하면 접근 가능하다. (`Level3Screen`·`AppState`·`Router`는 `window`에 노출되어 있음)

### 4-9. 이번에 손대지 않은, 같이 발견된 문제들

우선순위상 다음 차례로 미룬 것들. 여기 적어두지 않으면 잊는다.

1. **사진 리사이즈 없음** — 원본 폰 사진을 base64로 그대로 전송해 callable 요청 크기 한도에
   걸릴 수 있음. 실패 시 사용자에겐 "다시 업로드해주세요"만 보이고 몇 번을 반복해도 동일.
   업로드 전 canvas로 장변 1600px 리사이즈 + JPEG 0.8 압축 필요. **투자 대비 효과가 가장 큼.**
2. **AI 응답 실패 시 재시도 없음** — `parseJSON` 파싱 실패나 "문장 5개가 아님"이면 즉시
   `HttpsError`. 서버에서 1~2회 재시도만 넣어도 체감 실패율이 크게 준다.
3. **innerHTML 이스케이프 없음** — 학생이 입력한 `userReason`과 AI 생성 텍스트가 그대로
   `innerHTML`에 들어감. 자기 계정 안에서만 재생되지만 XSS 기본 방어에 해당.
   단원명을 `onclick` 문자열에 직접 보간하는 곳(`mypage.js`, `quiz-library.js`)도 같은 계열 —
   AI가 만든 단원명에 작은따옴표가 섞이면 핸들러가 깨진다.
4. **힌트를 써도 감점 없음** — `hintUsed`를 저장만 하고 점수에 반영하지 않아, 힌트 2개를 다
   보고 맞혀도 승급 카운터가 동일하게 오른다. 교정 루프의 신뢰성 문제.
5. **오답 체크 감점 -20 고정** — 틀린 문장이 1개인 문제(문항당 만점 100)와 2개인 문제(만점 50)에
   같은 -20을 적용해서, 동일한 "전부 체크" 행동의 벌점이 두 배 차이 난다.
   `maxScorePerItem`에 비례하도록 바꿔야 함.
6. **재도전·이어서 풀기 세션이 오개념 집계에서 누락** — 두 경로 모두 `misconceptions: []`로
   저장되어 `fetchWeakMisconceptions()` 통계에 안 잡힌다.
7. **`fetchStats`가 전 기간 세션을 매번 전부 조회** — 사용 기간에 비례해 읽기 비용·로딩 시간 증가.
8. **UNIT_MAP의 교육과정 분류가 실제 교과서와 불일치** — '특수 상대성 이론'이 '에너지'에,
   '원자 모형과 전기력'이 '전기와 자기'에 들어가 있음. 게다가 이 표가 `app.js` 상수와
   `functions/index.js` 프롬프트 두 곳에 중복 하드코딩되어 동기화가 수동.
