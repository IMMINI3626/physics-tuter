# PhysiClinic 변경 이력

구현이 끝난 기능의 설계 배경과 세부 스펙 기록. 진행 중이거나 아직 열린 사항은 [Add_README.md](Add_README.md) 참고.

---

## (1) 소단원 기반 레벨 시스템 + 교정 루프

레벨은 소단원 단위로 관리하고, 마이페이지에서는 대단원으로 묶어 시각화한다. 소단원-대단원 매핑은 Firestore가 아니라 프론트 상수(`public/js/app.js`의 `UNIT_MAP`, 현재 값은 [Add_README.md](Add_README.md) 참고)로 둔다.

unitProgress 저장 시 chapter 필드를 함께 넣어 대단원 카드 그룹핑에 쓴다. extractKeywords 프롬프트의 소단원 리스트를 UNIT_MAP과 같게 유지해 Gemini 반환값이 항상 키와 일치하도록 한다.

### 게스트(비로그인) 처리

- 푼 문제 데이터를 저장하지 않는다.
- 세션 종료(다음 학습 시작, 새로고침 등) 시 AppState.session을 비운다.
- 레벨/카운터는 로그인 사용자만 Firestore에 저장한다.

### 승급 조건

- 같은 소단원의 새 문제를 맞혀 누적한다. 다시 풀어보기(같은 문제 재시도)는 세지 않는다.
- 오답이어도 카운터는 유지하고, 맞춘 것만 누적한다.
- 카운터는 unitProgress.correctCount에 저장(소단원 단위).
- 합격 판정 점수는 레벨별로 다르다. L1·L2는 100점, L3는 90점(`feedback.js`의 `PROMOTION_SCORE`). 원래 전 레벨 100점이었으나 L3만 승급이 불가능해 조정했다. 사유는 4-4 참고.

```
/users/{uid}/unitProgress/{소단원명}
  level: 1 | 2 | 3
  completed: boolean
  correctCount: number   // 누적 정답 (승급 시 0으로 리셋)
  chapter: string        // 대단원명
  lastStudied: timestamp
```

기존 misconceptionProgress 컬렉션은 승급 카운터로 쓰지 않는다. Gemini가 세션마다 다른 오개념 ID를 골라 카운터가 분산되는 문제로 unitProgress에 통합했다. misconceptionProgress는 추후 "취약 개념" 표시용으로만 남겨둔다.

### 승급 목표치 (동적 계산)

소단원마다 오개념 수가 다르므로 고정하지 않고 매 세션 계산한다.

```js
L1 목표: min(max(round(오개념수 × 1.7), 10), 20)
L2 목표: min(max(round(오개념수 × 1.3),  7), 13)
L3 목표: min(max(round(오개념수 × 1.0),  5), 10)
```

| 소단원 | 오개념 수 | L1 | L2 | L3 |
|--------|:--:|:--:|:--:|:--:|
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

목표치는 저장하지 않고 매번 오개념 수로 즉시 계산하므로, seed.js에 오개념을 추가하면 자동 반영된다.

### 교정 루프

승급 조건 미달 시 피드백 화면에서 두 선택지를 준다.

- 다시 풀어보기: 기존 questions 배열 재사용, API 호출 없음. checkedStatements/step2Answers만 초기화하고 STEP1로.
- 다음 문제 풀기: extractKeywords 없이 세션의 detectedUnit·misconceptions·currentLevel을 재사용해 generateQuestions만 새로 호출. 같은 소단원·오개념·레벨로 새 문항 생성. 맞히면 카운터 +1.

### Level 1 — 개념 기본 이해

물리량 정의, 벡터 방향, 그래프 개형 같은 정성적 이해와 공식 인식을 본다.

- 문장형 + 공식 판별 문장 5문항. 기존 STEP1/2 UI 그대로(체크=틀리다 → STEP2 서술, 미체크=맞다).
- 공식 판별 예: "일의 양을 구하는 공식은 W = mv²이다"(틀림), "F = ma에서 가속도는 a = m/F이다"(틀림).
- 프롬프트: 계산 없는 정성 문장과 공식 판별 문장을 섞어 5문항 생성(정성 3 + 공식 2, 또는 정성 4 + 공식 1 중 랜덤).

변경 파일

| 파일 | 내용 |
|------|------|
| `functions/index.js` | generateQuestions에 level 1 분기, 공식 문장 생성 지시 |
| `firebase/api.js` | level 파라미터 추가 |
| `firebase/firestore.js` | 승급 카운터 함수(incrementCorrectCount, getUnitProgress) |
| `public/js/feedback.js` | 세션 종료 후 카운터 갱신 |
| `public/js/app.js` | AppState.session에 currentLevel/correctCount, UNIT_MAP 추가 |

### Level 2 — 개념 응용 및 정량 계산

단일 공식 매칭과 수치 도출을 본다. 세션마다 방식 A/B를 랜덤으로 정하고, 첫 세션의 detectedUnit·misconceptions를 재사용(이미지 재업로드 없음).

방식 A — STEP1→STEP2(기존 흐름): 참/거짓 3문항 + 계산 2문항(총 5, 틀린 문항 1개 포함). 체크 후 STEP2 서술.

방식 B — 계산 화면(신규): 단일 공식 계산 1문항. 숫자 입력 + 단위 드롭다운. Gemini가 correctAnswer·unit·unitOptions를 JSON으로 반환하고, 프론트에서 ±1% 오차로 직접 비교(AI 재채점 없음).

```js
{
  "text": "질량 2kg인 물체에 5N의 힘을 가했을 때 가속도는?",
  "correctAnswer": 2.5,
  "unit": "m/s²",
  "unitOptions": ["m/s²", "N", "kg", "m/s"]  // 정답이 항상 [0]번 — 렌더링 시 셔플 필요
}
```

주의: unitOptions는 프롬프트 지시상 정답 단위가 항상 첫 번째다. 화면에 뿌릴 때 `QuizScreen._shuffle()`로 섞지 않으면 `<select>` 기본값이 곧 정답이 되어 단위 판정이 무력화된다. 실제로 그 상태로 배포됐던 것을 4-1에서 수정했다.

변경 파일

| 파일 | 내용 |
|------|------|
| `functions/index.js` | level 2 분기, 방식 A/B 프롬프트 |
| `firebase/api.js` | level, mode 파라미터 |
| `public/js/keyword.js` | 세션 시작 시 방식 A/B 랜덤 결정 후 quizMode 저장 |
| `public/js/quiz.js` | 방식 B 계산 화면 렌더링·정답 비교 |
| `public/js/app.js` | AppState.session에 quizMode |
| `quiz.css` | 숫자 입력·단위 드롭다운 스타일 |
| `index.html` | screen-calc 추가 |

### Level 3 — 개념 종합 및 다단계 추론

소단원 하나를 중심으로 실생활/시험 스타일 복합 상황에서 다단계 추론을 본다.

- 복합 계산 1문항, 두 개 이상의 물리 법칙 결합. 첫 세션의 detectedUnit·misconceptions 재사용.
- 답안: 최종 답(숫자 + 단위 드롭다운, 프론트 직접 비교)과 풀이 과정. 풀이 과정은 텍스트/직접 쓰기 탭으로 입력하고, 직접 쓰기는 사진 업로드나 캔버스 손글씨(패드+펜, 마우스)를 지원한다.
- 캔버스/사진은 base64로 변환해 Gemini에 이미지로 넘겨 채점. 풀이 과정 채점은 Gemini가 담당하며, 정확도가 낮을 경우 피드백만 제공하는 방식으로 교체할 수 있게 분리해 뒀다.

승급/완료는 L1/L2와 같은 동적 목표치 방식이다. 목표치(L3 기준 5~10) 달성 시 unitProgress.completed = true로 처리하고 완료 배너를 띄운다. 별도의 "누적 3회 → 완료" 버튼이나 "5문제 강제 완료" 캡은 두지 않고 승급과 동일한 로직(calcPromotionTarget)을 재사용한다.

변경 파일

| 파일 | 내용 |
|------|------|
| `functions/index.js` | level 3 복합 계산 프롬프트, 풀이 과정 이미지/텍스트 채점 분기 |
| `firebase/api.js` | level 3 전달 |
| `public/js/quiz.js` | Level 3 화면(숫자 입력 + 풀이 탭 + 캔버스 + 사진 업로드) |
| `public/js/feedback.js` | 완료 흐름 처리 |
| `firebase/firestore.js` | 소단원 완료 상태 저장 |
| `index.html` | Level 3 화면, 캔버스 UI |
| `quiz.css` | 캔버스·탭·풀이 입력 스타일 |

---

## (2) 마이페이지 단원별 학습 현황 시각화 (2026-07)

### 이전 vs 목표

| 항목 | 이전 | 목표 |
|------|------|------|
| 취약 오개념 | 전체 합산 막대 | 소단원별 분리 |
| 학습 이력 | 세션 나열 | 대단원 카드 그룹화 |
| 점수 추이 | 없음 | 소단원별 회차 꺾은선 |
| 개념 향상도 | 없음 | 첫 vs 최근 세션 비교 |
| 레벨 현황 | 없음 | 소단원별 레벨 배지 |

### 화면 구조

메인은 대단원 카드 목록. 각 소단원 행에 레벨 점(최대 3개, L1~L3)과 배지(L1/L2/L3/완료)를 표시하고, 행을 클릭하면 상세로 이동한다.

소단원 상세(screen-mypage-detail) 구성:

1. 점수 추이 꺾은선 — X축 회차, Y축 0~100, 첫/최근 지점 강조.
2. 개념 향상도 배너 — 첫 세션 vs 최근 세션 점수 차이.
3. 반복 오개념 목록 — 2회 이상만 표시(id → 한글 이름은 `MisconceptionDB.getMisconceptionById` 조회). "교정 완료" 취소선은 뺐다. 세션에는 "다룬 오개념"만 남고 "그 문항을 맞았는지"와 연결이 없어 교정 여부를 정확히 판단할 근거가 없었기 때문. 잘못된 정보 대신 반복 횟수만 정확히 보여준다.
4. 과거 이력 — 날짜/점수/틀린 문항 수. "문제 보기"는 새 화면 없이 기존 `viewSessionLog()` + `FeedbackScreen.render(data, true, 'mypage-detail')`를 재사용해 실제 채점 화면과 같은 방식으로 문항별 피드백을 보여준다.
5. 추가 문제 풀기 — 최하단 배치. `pickQuizMode()`로 모드를 정하고 `generateQuestions([], subUnit, level, mode)` 호출 후 step1/calc/level3로 분기.

상세 진입은 마이페이지에서만 가능하고, 메인 카드에서 레벨·진척도가 보이므로 상세에 들어가지 않아도 파악된다.

### Firestore 조회

```js
// where + orderBy를 같이 쓰면 복합 인덱스가 필요하므로 where만 쓰고 정렬은 클라이언트에서 처리
const sessions = await fetchSessionsByUnit(uid, unitName); // where('unit','==',unitName) 후 .sort()
const improvement = scores.at(-1) - scores[0];             // 첫 vs 최근
```

변경 파일

| 파일 | 내용 |
|------|------|
| `public/firebase/firestore.js` | `fetchAllUnitProgress`, `fetchSessionsByUnit` 추가, `fetchWeakMisconceptions` 소단원 필터, `getMisconceptionById`, saveSession에 wrongCount |
| `public/js/mypage.js` | 전면 재작성 — 대단원 카드, 소단원 상세(SVG 그래프 직접 구현), 추가 문제 풀기 |
| `public/index.html` | 메인을 카드 목록으로, screen-mypage-detail 신규 |
| `public/css/feedback.css` | 취약오개념 막대/이력 스타일을 카드형으로 교체 |
| `public/js/app.js` | Router.navMap/authRequired에 mypage-detail |

꺾은선은 외부 라이브러리 없이 SVG로 직접 그렸다(그리드 + 영역 그라디언트 + 첫/최근 강조).

### 구현하며 발견해 같이 고친 것

1. sessionCount 레이스 컨디션 — saveSession()이 "읽고 +1해서 쓰기" 방식이라 문제를 연달아 빠르게 풀면 동시 저장이 서로의 증가분을 덮어써 실제보다 적게 기록됐다(세션 22개인데 sessionCount 8로 확인). runTransaction으로 전환. 동시 저장 20개 재현 테스트에서 정확히 20으로 기록 확인.
2. AI가 반환하는 unit이 UNIT_MAP 14개와 다를 수 있음 — "힘과 운동"(대단원명), "전기장과 전위"(목록 밖) 같은 사례. 14개와 정확히 일치하는 것만 보이면 이런 세션이 영영 안 보이므로, "기타" 카드를 추가해 이름이 안 맞는 unitProgress도 어딘가엔 표시되게 했다.
3. 레벨 시스템 이전(2026-04~05) 세션은 unitProgress 문서 자체가 없음 — 갱신 코드가 나중에 추가됐기 때문. 그 전에 풀고 안 돌아온 단원은 세션은 있어도 진행 문서가 없어 "시작 전"으로 뜬다. 과거 세션으로 소급 생성하는 백필도 검토했으나 그 시절엔 레벨 개념이 없어 정확히 복원할 근거가 없어 보류. (2·3번 모두 새로 푸는 세션에는 영향 없음)

---

## 구현 순서 기록

```
[x] app.js — UNIT_MAP, AppState.session 필드
[x] firestore.js — unitProgress.correctCount 승급 카운터
[x] functions/index.js — level 분기(L1~L3) + subUnit 오개념 필터 + misconceptionCount 반환
[x] api.js — level, mode 파라미터
[x] quiz.js — L2 방식 B 계산 화면, L3 화면
[x] feedback.js — 승급 판단 + 교정 루프 + 동적 목표치(calcPromotionTarget)
[x] index.html — screen-calc, L3 화면, 캔버스
[x] quiz.css — 계산 입력·드롭다운·캔버스·탭
[x] mypage.js — 대단원 카드, 소단원 상세 (2026-07)
[x] feedback.css — 마이페이지 상세 스타일 (2026-07)
```

---

## Firestore 오개념 시딩 이력 (seed.js)

### misconception_dimensions

| id | code | 이름 | 단원 |
|----|------|------|------|
| 1 | K | 운동학 | unit1 |
| 2 | I | 임페투스 | unit1 |
| 3 | AF | 능동적 힘 | unit1 |
| 4 | AR | 작용-반작용 | unit1 |
| 5 | CI | 힘의 합성 | unit1 |
| 6 | G | 중력/저항 | unit1 |
| 7 | ME | 역학적 에너지 보존 | unit2 |
| 8 | WI | 파동의 간섭 | unit4 |
| 9 | MD | 물질의 이중성 | unit4 |
| 10 | EC | 전기 회로 | unit3 |
| 11 | MF | 자기장 | unit3 |
| 12 | EMI | 전자기 유도 | unit3 |
| 13 | MO | 운동량 | unit2 |
| 14 | AT | 원자 모형 | unit3 |
| 15 | EB | 에너지 띠와 반도체 | unit3 |
| 16 | LD | 빛의 이중성 | unit4 |
| 17 | WR | 파동·굴절 | unit4 |

### misconceptions — 기존 49개

| ID | 단원 | 출처 |
|----|------|------|
| K1~K3, I1~I5, AF1~AF2, Ob, AR1~AR4, CI1~CI3, R1~R3, G1~G5 | unit1 힘과 운동 | Hestenes et al. (1992) FCI |
| ME1~ME7 | unit2 에너지 | 이종주 (2009), 연세대 석사 |
| ME8~ME13 | unit2 에너지 | 정현 (2021), 충북대 석사 |
| WI1~WI5 | unit4 파동 | Yun, Kwak & Choi (2025), 새물리 |
| MD1 | unit4 파동 | 이창열 (2021), 서울대 학사 |

### misconceptions — 추가 38개 (2026-07 시딩 완료)

unit2 운동량 — 이종주 (2009)

| ID | 오개념 |
|----|--------|
| MO1 | 충돌 후 질량 큰 쪽이 더 빠르다 |
| MO2 | 완전비탄성충돌 시 운동량 감소 |
| MO3 | 운동량이 클수록 가속도가 크다 |

unit3 전기 회로(EC) — 이승노 (2006), 한국교원대 석사

| ID | 오개념 |
|----|--------|
| EC1 | 전류가 각 소자를 지나며 소비되어 뒤로 갈수록 줄어든다 |
| EC2 | 전압과 전류를 같은 개념으로 혼동 |
| EC3 | 병렬 연결 시 전체 저항이 증가한다 |
| EC4 | 전지에서 멀수록 전류가 약해진다 |
| EC5 | 전류 방향이 전자 이동 방향과 같다 |
| EC6 | 저항은 전류를 아예 막는다 |

unit3 자기장(MF) — 이승노 (2006)

| ID | 오개념 |
|----|--------|
| MF1 | 전류 방향과 자기장 방향을 평행하게 생각 |
| MF2 | 도선에서 멀어져도 자기장 세기가 일정 |
| MF3 | 같은 방향 전류 도선이 서로 밀어낸다 |
| MF4 | 자기력선이 N극에서만 나온다 |
| MF5 | 오른손 법칙 없이 코일 자기장 방향을 직관 판단 |
| MF6 | 전류를 2배로 해도 자기장은 2배가 안 된다 |
| MF7 | 전자석과 영구자석은 전혀 다른 원리다 |

unit3 전자기 유도(EMI) — 이승노 (2006) + 연구 기반 추론

| ID | 오개념 |
|----|--------|
| EMI1 | 자석이 코일 근처에 있기만 해도 전류가 흐른다 |
| EMI2 | 자기장이 강하면 무조건 유도 기전력이 크다 |
| EMI3 | 폐회로가 아니어도 유도 전류가 흐른다 |
| EMI4 | 유도 전류 방향이 자석 N극 방향과 같다 |
| EMI5 | 유도 전류가 원래 자기장을 항상 완전히 상쇄시킨다 |

unit3 원자 모형(AT) — 장숙경 (2014), 이화여대 석사 (고1 135명 조사)

| ID | 오개념 |
|----|--------|
| AT1 | 선 스펙트럼의 선이 원자 속 입자를 나타낸다 |
| AT2 | 스펙트럼 선이 전자 에너지 준위 차이와 관련됨을 모름 |
| AT3 | 전자 에너지가 불연속이라는 양자 개념 미획득 |
| AT4 | 오비탈을 확률밀도가 아닌 실제 전자 궤도로 믿음 |
| AT5 | 점밀도 그림의 각 점을 실제 전자 위치로 인식 |
| AT6 | 전자 에너지를 원자핵과의 거리로만 판단(보어 모형 고착) |

unit3 에너지 띠·반도체(EB) — 장숙경 (2014) 간접 근거 기반 추론

| ID | 오개념 |
|----|--------|
| EB1 | 에너지 띠가 원자 에너지 준위에서 형성됨을 이해 못함 |
| EB2 | 반도체가 에너지 띠 간격으로 설명되는 별개 물질임을 모름 |
| EB3 | 도핑이 전하를 이동이 아닌 생성으로 오해 |

unit4 파동·굴절(WR) — 최정훈 (2015), 충북대 석사 (중1~3 45명 조사)

| ID | 오개념 |
|----|--------|
| WR1 | 빛이 굴절할 때 속도는 변하지 않고 방향만 바뀐다 |
| WR2 | 굴절각이 클수록 빛의 속도가 빠르다 |
| WR3 | 전반사가 어떤 각도에서도 일어날 수 있다 |
| WR4 | 빛이 굴절할 때 파장이 변하지 않는다(진동수·파장 혼동) |

unit4 빛의 이중성(LD) — 간섭·회절 연구(서울대 박사, 2006) + 최정훈 (2015)

| ID | 오개념 |
|----|--------|
| LD1 | 빛의 세기가 강할수록 광전자 운동에너지가 커진다 |
| LD2 | 빛이 입자성과 파동성을 항상 동시에 드러낸다 |
| LD3 | 드브로이 파장이 클수록 입자가 크다 |
| LD4 | 빛의 간섭·회절이 파동성이 아닌 입자성으로 설명된다 |

### seed.js 작업 기록

```
[x] dims에 EC/MF/EMI/MO/AT/EB/LD/WR 8개 추가 (id 10~17)
[x] unit2 MO1~3, unit3 EC1~6/MF1~7/EMI1~5/AT1~6/EB1~3, unit4 WR1~4/LD1~4 오개념+sentences
[x] 전체 87개 오개념에 subUnit 필드 (소단원 필터용)
[x] serviceAccountKey.json 재발급 후 node seed.js (2026-07)
    → misconceptions 87개, misconception_sentences 166개 시딩 완료
[x] question_patterns 116개 추가 — 완자 물리학Ⅰ 기출 유형 (2026-07)
    상황 설정/함정 포인트만 추상화, 원문·숫자 미포함. generateQuestions가 소단원 기준으로
    조회해 스타일 참고자료로 프롬프트에 주입
[x] item_misconception_map을 FCI_FMCE_extracted.xlsx와 100% 일치하도록 보완 (2026-07)
    6개 코드 누락 + 12개 부분 누락 수정, 74건 → 130건. 현재 미사용, 향후 정식 진단평가용
[x] misconception_sentences / scoring_keywords / item_misconception_map에 고유 id 부여
    batchUpload를 id 기반 upsert로 전환 → 재실행해도 중복 안 쌓임. 기존 3배 중복은 재시딩으로 정리
```

---

## (3) 과거 기록 "다시 풀기" (2026-07)

마이페이지에서 과거 세션을 열람만 하던 것을, 그 자리에서 같은 문제를 다시 풀 수 있게 확장. STEP1/2 → L2 계산형 → L3 순으로 넓혔고, 과정에서 나온 버그 수정과 코드 정리도 함께.

### 3-1. 문항 유형별 지원 범위

| 유형 | 지원 | 근거 |
|------|:--:|------|
| STEP1/2 (문장 5개) | O | 로그에 문장 5개(id/text/isWrong)가 그대로 남아 복원 가능 |
| L2 계산형(방식B) | O | correctAnswer/unit/unitOptions를 로그에 추가 저장 |
| L3 | O | 위 필드 + solutionSteps/isLevel3까지 저장 |
| 이 기능 이전 기록 | X | 필드가 없어 `_canRetryHistory()`가 자동으로 걸러냄(하위 호환) |

변경 파일

| 파일 | 내용 |
|------|------|
| `public/js/quiz.js` | 계산형 채점 시 correctAnswer/unit/unitOptions 저장, L3 `_finalize()`에 isLevel3/solutionSteps |
| `public/firebase/firestore.js` | saveSession/fetchSessionLogs가 위 필드 저장·반환 |
| `public/js/feedback.js` | `_canRetryHistory()`, `retrySameHistory()` — 유형별로 STEP1/계산/L3 화면 복원 |

### 3-2. 재도전 결과 화면

과거 기록 재도전은 승급 카운터와 무관하므로(isRetry=true라 DB에 안 남음) 승급 UI 없이 점수/피드백과 버튼 2개(돌아가기 / 새 문제 풀기)만 준다. `AppState.session.isHistoryRetry` 플래그로 구분하고, 새 문제를 만들면 플래그를 되돌려 정상 승급 흐름으로 복귀한다.

### 3-3. 뒤로가기 목적지 3분기

문제 화면 진입 경로에 따라 상단 뒤로가기 목적지와 라벨이 달라진다.

- 홈에서 사진 업로드로 진입: "분석 결과" → keyword
- 마이페이지 상세에서 이어서/다시 풀기: "학습 현황" → mypage-detail
- 문제풀기 탭 기록에서 다시 풀기: "문제풀기" → quiz-library

`app.js`에 `setQuizBackTarget(target)` / `quizGoBack()`을 두고, 진입 경로마다(KeywordScreen.start, MypageScreen.retryUnit, FeedbackScreen.retrySameHistory) 목적지를 설정한다.

### 3-4. 이력 — 레벨 배지 + 같은 문제 그룹핑

- 세션 저장 시 level을 함께 넣어 이력에 L1/L2/L3 배지 표시(이전 기록은 배지 없음).
- 재도전이면 원본 id를 retryOf로 저장(재도전의 재도전도 항상 최초 원본을 가리키게 `_rootSessionId`로 전파). 이력에서 retryOf로 그룹핑해 재도전이 없으면 한 줄, 있으면 "재풀이 횟수: N"으로 접고 펼치면 1차/2차… 개별 시도.
- "틀린 문항 N개" 텍스트는 혼동을 줘 제거(레이아웃 spacer만 유지).
- 소단원 진행 점(3개)의 의미를 "푼 횟수"에서 "현재 레벨"로 변경.

참고: 소단원 상세의 점수 추이 그래프는 재도전까지 개별 점으로 찍고, 바로 아래 이력 목록은 재도전을 그룹으로 묶는다. 그래프는 추이 확인용, 이력은 정리해 보기용이라 의도적으로 다르게 처리한 것이고 버그는 아니다. 통일이 필요하면 그래프도 그룹당 최신 점수 하나로 그리도록 바꾼다.

### 3-5. 개발 중 고친 버그

1. 마이페이지 상세로 돌아와도 이력이 갱신 안 되던 문제 — "돌아가기"가 `Router.go('mypage-detail')`만 호출해 화면만 바뀌고 데이터는 그대로였다. `MypageScreen.goDetail()`을 같이 호출하도록 수정. (이 과정에서 `window.MypageScreen`으로 잘못 참조해 갱신이 아예 안 되는 2차 버그도 발생 — mypage.js는 모듈이 아닌 일반 스크립트라 `window.` 없이 참조해야 함)
2. 재도전 시 "Level 1"로 잘못 표시 — `retrySameHistory()`가 currentLevel을 갱신 안 해 열람 중 남아 있던 값(보통 1)이 표시됐다. DB 값은 안전(isRetry라 안 씀), 표시만 문제. `getUnitProgress()`로 실제 값을 다시 조회하도록 수정.
3. L3 "텍스트 입력" 탭 버튼 태그 깨짐 — `</button>`가 하나 더 있어 라벨이 버튼 밖으로 빠져 클릭이 안 됐음.

### 3-6. 문제 화면 라우팅 통합

"결과가 계산형/L3인지 보고 step1/calc/level3 중 어디로 보낼지" 판단이 keyword.js, feedback.js, mypage.js 5곳에 거의 같게 복사돼 있던 것을 app.js 공용 함수 2개로 통합.

```js
routeToQuizScreen()      // session.calcQuestion/questions가 세팅된 상태에서 라우팅만
applyQuizResult(result)  // generateQuestions 응답을 세션에 반영 후 routeToQuizScreen() 호출
```

5곳 전부 이 함수로 교체해, 화면이 늘거나 분기가 바뀌어도 한 곳만 고치면 되게 함.

---

## (4) 문제 풀이 화면 버그 수정 (2026-07)

기능이 일단락된 뒤 전체 코드를 정적 점검하며 찾은 것 중 사용자 화면에 바로 드러나는 것을 묶어 수정. 대부분 새 화면(screen-calc, screen-level3)을 추가하며 QuizScreen.init()의 초기화를 옮겨 적지 않아 생긴 누락이다.

### 4-1. 계산 문제 단위 선택지에 정답이 항상 첫 번째

프롬프트가 unitOptions를 `[정답, 오답1, ...]` 순으로 만드는데 `initCalc()`가 그 순서 그대로 `<option>`을 렌더링했다. `<select>` 기본값이 첫 항목이므로 학생이 드롭다운을 안 건드리면 무조건 정답이 제출됐다. `submitCalc()`의 단위 검사가 사실상 무력.

`_shuffle()`(원본 불변 Fisher-Yates)로 렌더 직전에 섞음. 채점은 인덱스가 아니라 `userUnit === calcQuestion.unit` 문자열 비교라 셔플 영향 없음. 프롬프트로 "섞어서 생성"을 시킬 수도 있지만 LLM이 지킬 보장이 없어 프론트에서 강제로 섞었다.

### 4-2. 계산·L3 화면에서 힌트 버튼이 무반응

hintUsed를 0으로 되돌리는 코드가 QuizScreen.init()(STEP1)에만 있었다. initCalc()와 Level3Screen.init()은 버튼 disabled만 되돌리고 카운터는 그대로 뒀다. 앞 문제에서 힌트 2개를 쓴 뒤(hintUsed=2) 계산 문제로 넘어가면 버튼은 활성화돼 보이는데 useCalcHint(1)의 `used === 0` 조건에 걸려 아무 반응이 없었다.

두 init에서 hintUsed = 0을 명시 초기화. 같은 김에 checkedStatements도 비웠다 — 계산 화면엔 체크박스가 없는데 앞 STEP1의 체크 상태가 남아 saveSession()의 checkedCount에 엉뚱한 값이 저장되고 있었다.

### 4-3. L3 힌트 사용량 미기록

Level3Screen.useHint()가 텍스트만 표시하고 hintUsed를 갱신하지 않아, L3 세션만 힌트를 다 봐도 hintUsed 0으로 저장됐다. `session.hintUsed = Math.max(session.hintUsed || 0, n)`으로 갱신하고 버튼 비활성화도 다른 화면과 맞춤.

### 4-4. L3 승급이 구조적으로 불가능

승급 카운터는 score === 100일 때만 올랐다. 그런데 L3 최종 점수는 `정답(100/0) × 0.6 + 풀이 점수 × 0.4`라 풀이에서 100점을 받아야 총점 100이 된다. gradeSolutionProcess 프롬프트가 "100점이 아니면 감점 사유를 구체적으로"라고 강하게 지시해 모델이 90~95로 수렴하므로, L3는 아무리 잘 풀어도 완료에 도달할 수 없었다.

레벨별 합격 기준을 도입.

```js
// feedback.js
const PROMOTION_SCORE = { 1: 100, 2: 100, 3: 90 };
```

L3 90점 = 정답 맞히고(60) 풀이 75점 이상. isPerfect 변수도 의미가 바뀌어 isPassed로 정리. L1·L2를 100으로 둔 건 문항 정오답이 명확해 도달 가능하고 "완벽히 이해했을 때만 다음"이라는 취지에 맞기 때문. L3만 예외인 건 AI 서술 채점이 끼어 점수 상한이 사실상 100이 아니라서다.

### 4-5. 완료한 단원에 "L3 이어서 풀기"가 계속 노출

incrementCorrectCount()는 completed 단원의 카운터를 안 올리는데, `_updateRetryButton()`은 완료 여부와 무관하게 "L{level} 이어서 풀기"를 표시했다. 계속 풀어도 변화가 없는 이유를 알 수 없는 상태. goDetail()에서 `_currentCompleted`를 저장하고, 완료 단원은 "완료한 단원 · 복습 문제 풀기"로 라벨을 분기해 성격을 복습용으로 명시.

### 4-6. 문제풀기 탭이 로그인 없이 뒤에서 실행

screen-quiz-library에는 비로그인 배너(#library-login-banner)와 "새 사진으로 학습 시작"이 이미 마크업에 있어 게스트도 볼 수 있게 설계돼 있었다. 그런데 Router.authRequired에 quiz-library가 들어가 있어, 게스트가 탭을 누르면 로그인 모달만 뜨고 전환은 막히는데 nav의 `Router.go(...); QuizLibraryScreen.init()`에서 init()은 그대로 실행돼 안 보이는 화면에 렌더링됐다. 배너 분기는 도달 못 하는 죽은 코드였다.

두 가지를 함께 수정.

1. authRequired에서 quiz-library 제외(mypage, mypage-detail만 남김) → 게스트에게 배너 표시.
2. Router.go()가 전환 성공 여부(boolean)를 반환하도록 바꾸고 nav를 `if (Router.go('mypage')) MypageScreen.init()`으로 수정 → 인증에 막힌 화면의 init이 뒤에서 도는 일 차단.

### 4-7. 변경 파일

| 파일 | 내용 |
|------|------|
| `public/js/quiz.js` | `_shuffle()` + 단위 셔플, initCalc/Level3Screen.init에서 hintUsed·checkedStatements 초기화, Level3Screen.useHint가 hintUsed 갱신 |
| `public/js/feedback.js` | PROMOTION_SCORE, isPerfect → isPassed |
| `public/js/mypage.js` | `_currentCompleted` 상태, 완료 단원 라벨 분기 |
| `public/js/app.js` | authRequired에서 quiz-library 제외, Router.go() boolean 반환 |
| `public/index.html` | nav를 `if (Router.go()) init()`으로 |

### 4-8. 검증

에뮬레이터(hosting)에 띄운 뒤 콘솔에서 각 함수를 직접 호출해 확인.

```
단위 셔플 20회 첫 보기 분포 : { m/s²:7, m/s:5, N:4, J:4 }   (수정 전엔 m/s² 20/20)
채점 정확도                : 정답+정단위 100 / 정답+오단위 0 / 오답+정단위 0
힌트 (직전 hintUsed=2)     : init 후 0 → 클릭 후 1
L3 힌트                    : useHint(1)→1, useHint(2)→2
승급 기준                  : L1 95 불합격 / L3 92 합격 / L3 85 불합격
완료 단원 라벨             : "완료한 단원 · 복습 문제 풀기"
게스트 문제풀기 탭         : 진입 성공, 배너 표시
```

QuizScreen·MypageScreen은 window에 없는 전역 const라 콘솔에서 바로 참조되지 않을 수 있다. `window.eval("QuizScreen")`처럼 전역 스코프에서 평가하면 접근된다(Level3Screen·AppState·Router는 window에 노출).

### 4-9. 같이 발견했지만 미룬 것

1. 사진 리사이즈 없음 — (5)에서 해결
2. AI 응답 재시도 없음 — (5)에서 해결
3. innerHTML 이스케이프 없음 — (6-1)에서 해결
4. 힌트를 써도 감점 없음 — (6-3)에서 해결
5. 오답 체크 감점 -20 고정 — (6-4)에서 해결
6. 재도전·이어서 풀기 세션이 오개념 집계에서 누락 — (6-5)에서 해결(이어서 풀기만. 다시 풀기는 의도적으로 제외)
7. fetchStats가 전 기간 세션을 매번 전부 조회 — 사용 기간에 비례해 읽기 비용·로딩 증가.
8. UNIT_MAP 교육과정 분류가 교과서와 불일치 — '특수 상대성 이론'이 '에너지'에, '원자 모형과 전기력'이 '전기와 자기'에 들어가 있음. 게다가 app.js 상수와 functions/index.js 프롬프트 두 곳에 중복 하드코딩돼 동기화가 수동.

---

## (5) 안정화 — 사진 리사이즈 · AI 재시도 · thinking 예산 (2026-07)

기능·버그 정리 후 실패율·지연·비용을 낮추는 작업. 4-9에 미뤘던 사진 리사이즈·AI 재시도 포함.

### 5-1. 업로드 사진 리사이즈 (home.js)

원본 폰 사진(4000×3000, 5MB+)을 base64로 그대로 보내면 약 1.33배로 부풀어 callable 요청 크기 한도에 걸릴 수 있었다. 걸리면 "다시 업로드해주세요"만 반복되고 원인을 알 수 없다. 업로드 전 canvas로 장변 1600px 축소 + JPEG 0.8 재인코딩. 실측 4000×3000 → 1600×1200, 전송량 약 89% 감소.

두 가지를 추가로 처리.

- EXIF 회전 — 폰 세로 사진은 픽셀이 가로로 저장되고 "90도 돌려서 봐라"는 태그만 붙는다. 무시하고 캔버스에 그리면 교과서가 누운 채 전달돼 인식률이 떨어진다. `createImageBitmap(..., { imageOrientation: 'from-image' })`로 회전 반영, 미지원 구형 브라우저는 `<img>` 폴백.
- 투명 PNG 대비 — JPEG로 바꾸면 투명 영역이 검게 깔려, 흰 바탕을 먼저 칠하고 그림.

### 5-2. AI 응답 재시도 + 검증 (functions/index.js)

LLM은 일정 비율로 형식을 어긴다(응답이 잘려 파싱 실패, 문장 5개 요청에 4개 반환 등). 예전엔 즉시 HttpsError를 던져 실패 토스트가 그대로 노출됐다. `withRetry(label, fn)`를 도입해 AI 호출 5종 전부(generateQuestions는 L1/L2B/L3 각각)에 최대 3회 재시도(400→800ms 백오프).

검증을 재시도 콜백 안에서 하는 게 핵심이다. 밖에서 하면 형식이 틀린 응답이 재생성을 유발하지 못하고 그대로 실패한다. 이에 맞춰 검증도 강화.

| 함수 | 재시도 유발 조건 |
|------|------------------|
| extractKeywords | unit/keywords 누락 |
| generateQuestions | 문장 5개 아님, text/isWrong 누락, 틀린 문장이 하나도 없음 |
| 계산형(L2B/L3) | correctAnswer 비수치, unitOptions에 정답 단위 없음, L3 solutionSteps 누락 |
| gradeAnswers | items 누락, 학생이 답한 문항이 채점에서 빠짐 |
| gradeSolutionProcess | score/feedback 누락 |


- unitOptions에 정답 단위가 없는 경우 — 4-1 셔플 수정 이후 프론트가 `선택값 === unit`으로 채점하므로, 보기에 정답이 없으면 학생이 뭘 골라도 오답.
- gradeSolutionProcess의 score 누락 — 예전엔 `|| 0`으로 0점 처리해 채점 실패를 학생의 0점으로 이력에 남겼다. 재시도로 변경.

### 5-3. thinking 예산 작업별 차등 (functions/index.js)

체감 지연·비용의 진짜 원인은 재시도가 아니라 thinking이었다. gemini-2.5-flash는 thinking(추론)이 기본 켜져 있고 양이 적응적으로 는다. 재시도는 실패할 때만 붙지만 thinking은 매 호출 붙고, thinking 토큰은 출력 토큰으로 과금되며, L3의 20~30초도 대부분 이것이다. `getGeminiModel(temperature, { thinkingBudget, outputTokens })`로 확장해 작업별로 배분.

| 호출 | thinkingBudget | 이유 |
|------|:--:|------|
| extractKeywords (사진 분류) | 0 | 목록에서 고르는 분류, 추론 불필요. 입력이 커 지연 감소 최대 |
| recognizeSolutionImage (OCR) | 0 | 옮겨 적기, 판단 없음 |
| gradeAnswers (서술형 채점) | 512 | 루브릭 채점에 약간의 추론 |
| gradeSolutionProcess (풀이 채점) | 1024 | 다단계 논리 평가 |
| generateQuestions L1·L2A | 512 | 개념 참/거짓, 가장 흔한 경로라 낮게 |
| generateQuestions L2B | 1024 | 정답 숫자 정확성 |
| generateQuestions L3 | 2048 | 두 법칙 결합 계산의 일관성 |

가장 흔한 경로(사진 분석 → L1)에서 thinking이 빠지거나 최소화돼 평소 지연·비용이 직접 준다.

SDK(@google/generative-ai 0.21) 타입 정의엔 thinkingConfig가 없지만, generationConfig 객체를 필드 필터링 없이 그대로 v1beta API에 실어 보내므로 2.5 모델에서 정상 적용된다(fetch 가로채기로 요청 body 확인).

### 5-4. thinking 토큰이 답변을 잘라먹던 문제 (5-3 후속)

5-3 배포 직후 계산 문제(L2B·L3) 생성이 간헐적으로 "JSON 파싱 실패"로 터졌다. 원인은 thinking 토큰과 답변 토큰이 maxOutputTokens 예산을 공유한다는 것(2.5 모델). maxOutputTokens를 답변 크기에만 맞춰 잡으니 추론이 예산을 다 쓰면 정답 JSON을 쓸 자리가 없어 중간에 잘렸다.

thinking이 적응형이라 문제가 단순하면 통과, 복잡하면 잘림 — 되고 안 되고가 그때그때 운인 간헐적 버그였다(L1·L2A 문장형은 답변 공간이 충분해 영향 없음). 옵션을 maxOutputTokens(전체 상한)에서 outputTokens(보이는 답변에 필요한 양)로 바꾸고, 내부에서 `maxOutputTokens = thinkingBudget + outputTokens`로 계산. thinking은 하드 상한이라 답변 몫이 항상 보장된다.

| 호출 | thinking | outputTokens | maxOutputTokens | 답변 여유 |
|------|:--:|:--:|:--:|:--:|
| extractKeywords / recognizeSolutionImage | 0 | 1024 | 1024 | 1024 |
| gradeAnswers | 512 | 2048 | 2560 | 2048 |
| gradeSolutionProcess | 1024 | 1024 | 2048 | 1024 |
| L1·L2A | 512 | 1536 | 2048 | 1536 |
| L2B | 1024 | 1024 | 2048 | 1024 |
| L3 | 2048 | 1536 | 3584 | 1536 |

상한을 올려도 비용은 늘지 않는다. 과금은 실제 생성 토큰만큼이지 상한만큼이 아니다. thinking을 적게 하면 그대로 나오고 많이 할 때만 잘림을 막는다.

### 5-5. 그 외

- 게스트 무료 횟수 차감 시점 — 업로드 시점에서 분석 성공 시점으로 이동(home.js → keyword.js). AI 인식 실패 시 아무것도 못 해보고 횟수만 날리던 문제 해소.
- timeoutSeconds 60 → 120 — 재시도 3회를 감안한 최악 대기 상한. thinking 제한으로 호출당 지연이 줄어 180까지 갈 필요 없음(중간에 180으로 올렸다가 5-3 후 120으로 조정).
- 단위 표기 교정 — 정답 `m/s²` vs 보기 `m/s^2`처럼 표기만 다르면 재시도하지 않고 normalizeUnit으로 보기를 정답과 일치시켜 교정. 실질이 다른 단위만 있을 때 재시도.
- 계산 문제 단위 드롭다운 레이아웃(quiz.css) — 숫자 입력칸의 min-width:0 누락으로 입력칸이 최소 너비 밑으로 안 줄어 행을 화면 밖으로 밀어내, 드롭다운이 잘려 보였다. 입력칸 min-width:0 + 드롭다운 flex:0 0 auto / max-width:38%로 수정.

### 5-6. 변경 파일

| 파일 | 내용 |
|------|------|
| `public/js/home.js` | `_compressImage`/`_decodeImage`(리사이즈·EXIF), 게스트 차감 제거 |
| `public/js/keyword.js` | 분석 성공 시점에 게스트 차감 |
| `functions/index.js` | withRetry·validateCalcQuestion·normalizeUnit, getGeminiModel 확장(thinking/output 예산), 5종 재시도, timeout 120 |
| `public/css/quiz.css` | 계산 입력행 레이아웃 |

### 5-7. 검증

- 서버 로직(재시도·검증·단위 교정·정규화) 22개 케이스 단위 테스트 통과(소스에서 헬퍼 추출).
- thinkingConfig가 v1beta 요청 body에 실제로 실림을 fetch 가로채기로 확인.
- 사진 압축 4000×3000 → 1600×1200, 전송량 89% 감소(브라우저 실행).
- 게스트 차감: 분석 실패 시 0 유지 / 성공 시 1 / 로그인 시 0.
- 배포 후 L2B·L3 계산 문제가 잘림 없이(풀이단계까지) 생성됨을 콘솔에서 확인.

thinking 예산 숫자(512/1024/2048)가 문제·채점 품질을 해치지 않는지는 실사용으로만 확인 가능하다. 특히 계산 문제 정답 정확도는 계속 지켜본다. 품질 저하가 보이면 해당 레벨의 thinkingBudget만 올리면 된다.

---

## (6) 신뢰성 — 보안 · 채점 · 통계 (2026-07)

4-9에 미뤄뒀던 것 중 보안(이스케이프)·채점(힌트/오답 감점)·통계(오개념 집계)를 묶어 처리하고, 마이페이지 오개념 표시도 개편했다.

### 6-1. innerHTML 이스케이프 (XSS 방어)

학생이 입력한 서술 답변과 AI 생성 텍스트(문제 문장, 해설, 단원명, 키워드 등)가 이스케이프 없이 innerHTML에 들어가고 있었다. `<img src=x onerror=...>` 같은 입력이 그대로 실행되는 XSS 취약점이자, 단원명에 <·& 등이 섞이면 레이아웃도 깨진다. 자기 계정 안에서만 재생돼 실피해는 낮지만 웹 보안 기본 방어라 처리.

`escapeHtml()`(& < > " ' 5종을 엔티티로) 유틸을 app.js에 추가하고, 텍스트가 innerHTML로 들어가는 26곳(feedback.js 피드백 카드, quiz.js 문장·힌트·단위 보기, keyword.js 키워드, mypage.js 취약 개념·기타 카드, quiz-library.js 카드)에 적용. 따옴표까지 이스케이프해 속성값 자리에도 안전하다.

onclick 문자열에 AI 생성 단원명을 직접 보간하던 두 곳(작은따옴표 한 개로 핸들러가 깨짐)도 정리: 마이페이지 이력은 상태(`MypageScreen._currentSubUnit`)에서 직접 읽고, 문제풀기 카드는 data-* 속성 + 위임 리스너로 전환.

브라우저 실측: 이스케이프한 payload는 img 노드 0개(무력), 이스케이프 안 한 대조군은 1개(위험 실재 확인). 단원명 `파동's 간섭`은 dataset 왕복 시 원문 복원.

### 6-2. "반복 오개념 유형" → "집중하면 좋을 개념" 개편

개별 오개념(틀린 생각)을 그대로 나열("무거운 물체가 빨리 낙하 3회")하던 것을, 상위 개념 영역(dimension) 단위로 묶어 부드럽게 표시하도록 개편.

- 87개 오개념 → 17개 개념 영역(중력·저항, 역학적 에너지 보존 등)으로 롤업. 프론트 상수 `DIMENSION_NAMES`(app.js) + Firestore의 실제 `dimensionCode`로 매핑.
- 오개념 id 앞글자로는 영역을 유추할 수 없다(CF·Ob·R1~R3은 앞글자가 달라도 모두 '중력·저항'). `MisconceptionDB.getDimensionMap()`이 misconceptions 컬렉션을 한 번만 읽어(캐시) id→dimensionCode 지도를 만든다.
- 영역으로 묶으면 정확도도 오른다. 예전엔 같은 영역의 서로 다른 오개념(G1·G3)이 각각 1회면 둘 다 잘렸는데, 이제 '중력·저항' 2회로 집계된다.
- `fetchWeakMisconceptions` → `fetchWeakConcepts`(영역 단위 집계, 2회 이상, 상위 4개).
- 표현: 제목 "집중하면 좋을 개념", 횟수 숫자 대신 신호등 색 점(빨강=자주 ≥5 / 노랑=종종 3~4 / 초록=가끔 2). 강도 텍스트는 title/aria-label에만 남겨 색각 이상 대비.

### 6-3. 힌트 감점 (힌트 1개당 -10점)

hintUsed를 저장만 하고 점수에 반영하지 않아, 힌트를 다 보고 맞혀도 만점→승급이 됐다. 교정 루프의 "스스로 풀었을 때만 다음 단계" 취지에 어긋난다.

`applyHintPenalty(feedbackData)`(app.js)로 채점 결과를 한 번 걸러 저장·표시·승급 판정에 같은 점수를 쓴다. 힌트 1개당 10점 감점(1차 -10, 둘 다 -20), 하한 0. STEP1/2·계산(L2B)·L3 세 유형 전부 공용 적용(submitStep2/submitCalc/_finalize). 부제에 "힌트 -N점"을 남겨 왜 만점이 아닌지 보이게 함.

### 6-4. 오답(헛다리) 감점 비례화

맞는 문장을 오개념이라 잘못 체크한 경우의 감점이 고정 -20이라, 틀린 문장 1개 문제(문항 만점 100)와 2개 문제(만점 50)에 벌점 무게가 두 배 차이 났다. `maxScorePerItem × 0.5`로 비례화(gradeAnswers, 서버). 틀린 문장 1개면 헛다리당 -50, 2개면 -25.

효과("틀린 것 다 맞히고 헛다리 하나" 기준): 1개짜리 50점 / 2개짜리 75점. "5개 다 찍기": 1개짜리 0점 / 2개짜리 25점 — 문제 유형과 무관하게 공평해짐.

### 6-5. "이어서 풀기" 오개념 집계 반영

사진 없이 푸는 두 경로가 misconceptions: []로 저장돼 오개념 통계에서 빠지던 문제. 두 경로를 다르게 처리:

- 이어서 풀기(retryUnit, 새 문제): 이 소단원에서 마지막으로 진단된 오개념을 이어받아 저장(`fetchLastMisconceptions` — 최신순 첫 비어있지 않은 세션의 오개념 id). 계속 연습한 개념이 통계에 반영된다.
- 다시 풀기(retrySameHistory, 같은 문제): 그대로 점수만 저장. 같은 문제를 또 세면 중복 집계되므로 의도적으로 제외.

소단원 전체 오개념(예: 18개)을 다 넣으면 한 세션이 모든 영역을 부풀리므로, 마지막 진단(1~3개)만 이어받아 사진 세션과 크기를 맞췄다. 문항별 정밀 태깅은 Phase 3(오개념 측정)의 몫으로 남김.

### 6-6. 변경 파일

| 파일 | 내용 |
|------|------|
| `public/js/app.js` | escapeHtml, DIMENSION_NAMES, applyHintPenalty |
| `public/js/quiz.js` | 이스케이프 적용, 세 유형에 힌트 감점 |
| `public/js/feedback.js` | 피드백 카드 이스케이프 |
| `public/js/keyword.js` | 키워드 이스케이프 |
| `public/js/mypage.js` | 이스케이프, `_renderWeakConcepts`(개념·색 점), retryUnit 오개념 상속 |
| `public/js/quiz-library.js` | 카드 이스케이프 + dataset/위임 리스너 |
| `public/firebase/firestore.js` | fetchWeakConcepts, getDimensionMap, fetchLastMisconceptions |
| `functions/index.js` | 헛다리 감점 비례화(maxScorePerItem × 0.5) |
| `public/css/feedback.css` | 개념 영역 색 점(.mc-dot) 스타일 |
| `public/index.html` | 카드 제목 "집중하면 좋을 개념", nav dataset/이스케이프 |

### 6-7. 남은 것

- 문제 검수 파이프라인(생성 문제를 2차 LLM으로 정답·유일성 검증) — 비용·구현 부담이 커서 발표용 "AI 채점 신뢰성 검증"과 묶어 처리 예정.
- 6-5의 정밀화(문항별 오개념 태깅), 4-9의 7·8번은 여전히 열림. 8번(UNIT_MAP 교육과정)은 Phase 3에서 UNIT_MAP을 Firestore로 옮길 때 함께 정리.

---

## (7) 오개념 이해도 측정 - (2026-07)

정답 횟수로 승급을 판정하던 방식을 오개념별 이해도 확률(Bayesian Knowledge Tracing) 기반으로 교체했다. 이론적 배경과 설계 근거는 `docs/오개념측정_BKT_설계.md`에 있고, 여기에는 구현 이력만 남긴다.

### 7-1. 왜 바꿨나

기존 승급 목표치는 `round(오개념수 × 배수)`에 상하한을 씌운 값이었다(L1 1.7배·상한 20 등). 계수와 상하한에 근거가 없고, 찍어서 맞힌 정답과 이해하고 맞힌 정답을 구분하지 못했다. "이 학생이 이 개념을 이해했는가"에 시스템이 답하지 못하는 구조였다.

### 7-2. 이해도 계산 (bkt.js)

오개념 하나마다 "이해했을 확률" P(L)을 두고 정답·오답 관측마다 갱신한다.

| 파라미터 | 값 | 의미 |
|---|---|---|
| P(T) | 0.15 | 한 번의 학습으로 이해하게 될 확률 |
| P(G) | 0.20 | 몰라도 찍어서 맞힐 확률 |
| P(S) | 0.10 | 알아도 실수할 확률 |
| 숙달 기준 | 0.90 | 이 값을 넘으면 이해한 것으로 판정 |

초기값은 사진에서 진단됐거나 진단검사에서 틀리면 0.15, 진단검사에서 맞히면 0.70, 아무데도 안 걸리면 0.30이다. 힌트를 보고 맞힌 정답은 P(G)를 0.50으로 올려 증거력을 깎는다. 순수 계산 모듈이라 단위 테스트 26개로 검증했다.

### 7-3. 문항 태깅과 관측 저장

`generateQuestions`가 문항마다 겨냥한 오개념 id(`targetMisconceptionId`)를 함께 반환한다. 목록에 없는 id는 서버가 걸러 null로 만들고, 태깅 실패가 문제 생성을 막지는 않는다. 채점 로그에 정오답·힌트 사용 여부를 함께 남겨 이해도 갱신의 근거로 쓴다.

저장 위치는 `users/{uid}/knowledgeState/{오개념id}` = `{ pL, attempts, lastUpdated }`.

### 7-4. 진단된 오개념 풀

사진 분석에 성공하면 진단된 오개념을 소단원별로 누적(합집합)하고 이해도를 0.15로 낮춘다. 사진을 여러 장 올리면 풀이 커진다. Phase 2의 "마지막 진단 물려받기"(6-5)를 이 누적 풀로 대체했다.

### 7-5. 순환 출제

문제를 만들기 전에 이해도가 낮은 오개념 2개를 골라 서버에 전달하고, 서버는 그 오개념을 프롬프트 맨 앞에 놓고 "반드시 겨냥하라"고 지시한다. 이미 숙달(0.90 이상)한 오개념은 후보에서 빠진다. 전달값이 없으면 프롬프트가 예전과 동일해 회귀가 없다.

### 7-6. 승급 판정 교체

`calcPromotionTarget`(임의 계수)을 제거하고, "현재 레벨 대상 오개념의 이해도가 모두 0.90 이상인가"로 바꿨다.

| 레벨 | 대상 오개념 |
|---|---|
| L1 | 소단원 전체 |
| L2 | 사진으로 진단된 풀 (비면 소단원 전체) |
| L3 | 사진으로 진단된 풀 (비면 소단원 전체) |

점수 만점 조건은 승급에서 분리했다. 오답은 이미 이해도를 떨어뜨리는 형태로 반영되기 때문이다. `PROMOTION_SCORE`는 "다시 풀어보기" 버튼 노출에만 남는다.

승급하면 대상 오개념의 이해도를 되돌린다(숙달했으면 0.30, 아니면 0.15). 쉬운 난이도에서 모은 증거를 그대로 들고 가면 다음 레벨이 한두 문제로 끝나기 때문이다.

예상 문항 수(한 문제도 안 틀렸을 때): 오개념 22개 소단원은 L1 24 + L2 3 + L3 6 = 33문제, 3개 소단원은 8문제. 기존 방식(최대 43문제, 매번 만점 요구)보다 짧고 소단원 크기에 자동으로 비례한다.

### 7-7. 구현 중 고친 것

**재도전이 이해도를 부풀림.** "다시 풀어보기"는 정답을 이미 본 같은 문제인데도 이해도 갱신에 포함됐다. 승급이 이해도에 걸리면서 실제 이해보다 빨리 승급하는 원인이 되므로 제외했다.

**승급 판정이 한 문제씩 밀림.** 이해도 저장을 기다리지 않고 판정하면 방금 푼 문제가 빠진 값을 읽는다. 갱신 promise를 보관했다가 판정 직전에 기다리도록 했다.

**판정 실패 시 이전 값 잔존.** 네트워크 오류 등으로 판정이 실패하면 직전 문제의 진행도가 화면에 남았다. 판정 전에 비운다.

### 7-8. 오개념 데이터 보강

`misconceptions` 87개가 12개 소단원에만 있고 열역학 법칙·특수 상대성 이론에는 하나도 없었다. FCI/FMCE가 역학 전용이라 그 두 단원은 기출 유형만 넣고 오개념은 비워둔 상태였다.

| 항목 | 이전 | 이후 |
|---|---|---|
| 개념 영역 | 17 | 19 (TH 열역학, SR 특수 상대성) |
| 오개념 | 87 | 103 |
| 판별 문장 | 166 | 214 |

근거 문헌은 Yeo & Zadnik(2001) TCE, Meltzer(2004), Cochran & Heron(2006), Sözbilir(2003), Villani & Pacca(1987), Scherr 외(2001), Aslanides & Savage(2013) RCI, Dimitriadi & Halkia(2012). 8편 모두 서지를 확인했다.

사진 진단(`extractKeywords`)에 남아 있던 임시 오개념 3개(M-W01/M-E01/M-T01, DB에 없는 id)를 제거하고, 오개념 목록에 소단원을 함께 실어 "정한 소단원의 오개념 중에서만 고르라"로 지시를 바꿨다. 저장 단계에서도 실제 존재하고 소단원이 일치하는 id만 남긴다.

### 7-8-1. 진단검사용 데이터 2차 보강

8단계(사전 진단검사)는 오개념 5개의 판별 문장을 표본으로 쓴다. 착수 전 점검에서 두 가지가 걸렸다.

- 물질의 이중성 오개념이 1개뿐이어서 그 단원은 L1이 2문제 만에 끝났다.
- 파동의 간섭 오개념 5개가 모두 음파여서 교과 비중이 큰 이중슬릿·회절이 빠져 있었다.
- 오개념 17개에 판별 문장이 없어 진단검사 대상이 될 수 없었다.

| 항목 | 이전 | 이후 |
|---|---|---|
| 오개념 | 103 | 112 |
| 판별 문장 | 214 | 289 |
| 문장 없는 오개념 | 17 | 0 |

신규 오개념 9개는 빛의 간섭·회절(WI6~WI8)과 물질파(MD2~MD7)다. 근거는 Ambrose 외(1999), Vokos 외(2000), Wuttiprom 외(2009) QPCS, McKagan 외(2010) QMCS, Matejak Cvenic 외(2023). 5편 모두 서지를 확인했다.

문장이 없던 기존 오개념 16개에는 문장 3개씩 붙였다. 기존 오개념의 설명과 정개념을 문장으로 옮긴 것이라 새 인용은 없다.

이어서 오개념이 3~4개뿐이던 4개 소단원도 채웠다. 운동량과 충격량(MO4~MO8, 충격량 판단·완충 장치·운동량과 운동 에너지 구분 등), 에너지 띠와 반도체(EB4~EB8, 자유 전자·띠 간격·양공·도핑), 파동의 진동과 굴절(WR5~WR8, 매질 이동·파동 속력·진동수 불변·매질 없는 전파), 빛의 이중성(LD5~LD8, 문턱 진동수·광자 에너지·광자 질량·약한 빛 간섭).

| 항목 | 1차 보강 후 | 2차 보강 후 |
|---|---|---|
| 오개념 | 112 | 130 |
| 판별 문장 | 289 | 343 |
| 오개념 5개 미만 소단원 | 4개 | 0개 |

이제 14개 소단원 전부 진단검사 5문항이 가능하다. 근거는 Lawson & McDermott(1987), Singh & Rosengrant(2003), Wittmann 외(2002) 전도 모형, Ambrose 외(1999) 전자기파, Wittmann 외(1999) 역학적 파동. 모두 서지를 확인했다.

L1 학습량은 오개념 5개면 6문제, 8개면 9문제, 22개면 24문제로 정리됐다.

남은 것: 오개념으로 등록되지 않은 개념은 문제에는 등장하지만 이해도 측정에는 반영되지 않는다. 지식 요소를 "오개념 + 개념 요소"로 확장하는 방안을 설계 문서에 과제로 정리했다.

### 7-9. 화면 변경

**진행도 표시.** "누적 정답 3 / 20"을 "Level 1 진행도 38%" + 막대로 바꿨다. 내부적으로는 대상 오개념 중 숙달한 비율이지만 개수는 노출하지 않는다. 단원마다 오개념 수가 1~22개로 크게 달라 개수를 보여주면 학습이 아니라 숫자를 좇게 된다.

**문제 화면 상단.** 왼쪽 뒤로가기가 "분석 결과"로 돌아가면 풀던 문제를 버리고 새로 생성해야 했다. 왼쪽은 홈으로 나가기로 바꾸고, 오른쪽에 [단원 정보] 버튼을 넣어 단원명·레벨·사진·키워드를 모달로 확인하게 했다. 마이페이지·문제풀기 탭에서 들어온 경우는 원래 자리로 돌아가는 기존 동작을 유지한다.

**기타.** 피드백 화면의 "홈으로 나가기"를 테두리 없는 텍스트 버튼으로 바꾸고 가운데 정렬했다. 승급 배너 문구에서 "오개념"이라는 표현을 뺐다.

### 7-9-1. 사전 진단검사 (단계 8)

소단원을 처음 시작할 때 문장 5개를 O/X로 묻고, 그 답으로 오개념별 초기 이해도를 세운다. 사진 분석 후 "문제 풀기 시작"과 마이페이지 "이어서 풀기"에서 문제 생성 직전에 뜬다. 소단원당 한 번만 본다.

**초기값을 손으로 정하지 않기로 했다.** 원래 설계는 "진단에서 맞히면 이해도 0.70"이었는데, 0.70은 문제를 한 번만 맞혀도 숙달로 올라간다. 진단은 O/X라 찍어도 절반은 맞으니, 열 명 중 한 명은 운으로 통과하는 셈이었다.

지금은 진단 답을 초기값이 아니라 **관측 한 건**으로 처리한다. 아무 증거 없는 상태(0.30)에서 시작해, "이 문항은 O/X라 추측률이 0.50"이라는 조건으로 이해도를 갱신한다.

| 진단 결과 | 이해도 | 숙달까지 문제 정답 |
|---|---|---|
| 정답 | 0.520 | 2번 |
| 건너뛰기 | 0.300 | 2번 |
| 오답 | 0.217 | 3번 |

운으로 통과할 확률이 10%에서 2%로 떨어진다. 임의로 정한 숫자(0.70)가 사라지고 초기값 파라미터가 하나(0.30)로 줄어드는 것도 이득이다.

**화면.** 5문항을 한 화면에 시험지처럼 늘어놓고, 문항마다 O / X / 건너뛰기를 고르게 했다. 한 문항씩 넘기는 방식은 앞 문항으로 돌아갈 수 없고 화면 전환만 5번 일어난다. 같은 버튼을 다시 누르면 선택이 해제되고, 5문항을 모두 표시해야 제출 버튼이 활성화된다(`제출하기 (3/5)`). 무응답과 "모르겠다"를 구분하려면 건너뛰기도 명시적 선택이어야 한다.

**문항 선정.** 5문장은 서로 다른 오개념 5개에서 뽑는다. 개념 영역이 여럿인 소단원은 영역을 돌아가며 뽑아 한쪽에 몰리지 않게 했다(14개 중 3개 소단원에서만 실제로 작동 — 나머지는 영역이 하나뿐이다). 틀린 문장 3개 / 옳은 문장 2개를 섞는다. 전부 틀린 문장이면 "다 X"로 찍어서 다 맞기 때문이다.

**보여주지 않는 것.** 점수와 정답을 알려주지 않는다. 검사 직후 같은 개념의 문제가 나오는데, 정답을 미리 알려주면 그 문제가 무의미해진다. 모르는 문장은 건너뛸 수 있고, 건너뛴 문항은 관측을 남기지 않는다(찍게 만들면 잘못된 초기값이 들어간다).

**검사가 학습을 막지 않는다.** 문항 생성 실패, 데이터 부족, 비로그인, 저장 실패 — 어느 경우든 검사를 건너뛰고 바로 문제로 넘어간다.

**관리자 열쇠 파일이 함수 배포에 섞여 있었다.** `functions/serviceAccountKey.json`은 `.gitignore`로 커밋만 막혀 있었다. 함수 배포는 `.gitignore`도 `.gcloudignore`도 보지 않고 `firebase.json`의 `functions.ignore`만 본다(기본값 `node_modules`, `.git`). 배포 서버가 이 열쇠를 쓰지도 않는데 계속 올라가고 있었다. `functions.ignore`에 열쇠와 로컬 전용 스크립트(seed.js 등)를 넣어, 배포에 포함되는 파일이 `index.js` + `package*.json` 3개만 남는 것을 확인했다.

**Firestore 규칙 누락을 먼저 고쳤다.** 판별 문장 컬렉션에 읽기 규칙이 없어 클라이언트에서 읽을 수 없는 상태였다. Cloud Functions는 관리자 권한으로 읽어서 그동안 드러나지 않았다. 정적 참조 컬렉션에 읽기 허용을 추가하고 배포했다.

**진단검사가 Level 1을 줄여주지는 않는다.** 22개 오개념 중 5개만 건드리므로 총 학습량은 거의 그대로다(관측 44 → 46). 실제 효과는 약한 개념을 먼저 겨냥하는 출제 순서와, 진단 오답을 진단 풀에 넣어 Level 2/3 범위를 좁히는 것이다.

### 7-10. 변경 파일

| 파일 | 내용 |
|---|---|
| `public/js/bkt.js` | 신규. 이해도 계산 순수 모듈 + 진단 관측 환산 |
| `public/js/diagnostic.js` | 신규. 사전 진단검사 화면 |
| `firestore.rules` | 판별 문장·개념 영역 컬렉션 읽기 허용 |
| `public/firebase/firestore.js` | knowledgeState CRUD, 관측 반영, 레벨 대상 선정, 승급 판정, 이해도 리셋, 진단검사 조회·저장 |
| `public/js/feedback.js` | 승급 판정 교체, 재도전 제외, 진행도 표시 |
| `public/js/app.js` | 순환 출제 헬퍼, 단원 정보 모달, 나가기 목적지, 진단 화면 라우팅 |
| `public/js/keyword.js` | 진단 오개념 누적, 순환 출제 연결, 진단검사 진입 |
| `public/js/mypage.js` | 진단 풀 사용, 순환 출제 연결, 진단검사 진입 |
| `public/js/quiz.js` | 문항 태그를 채점 결과에 전달 |
| `functions/index.js` | 문항 오개념 태깅, 우선 겨냥 지시, 사진 진단 정리 |
| `functions/seed.js` | 오개념 87 → 130개, 판별 문장 166 → 343개 |
| `firebase.json` | 서비스 계정 키·로컬 스크립트를 함수 배포에서 제외(`functions.ignore`) |
| `public/index.html` | 단원 정보 모달, 문제 화면 상단 버튼, 진단검사 화면 |
| `public/css/base.css`, `feedback.css`, `quiz.css` | 정보 버튼, 진행도 막대, 텍스트 버튼, 진단검사 화면 |

### 7-11. 남은 것

- 마이페이지 이해도 시각화(단계 9), "교정된 오개념" 통계 복원
- 파라미터 민감도 분석(단계 10, 논문 실험)
- Level 1 길이 조절 — 오개념 22개 소단원은 통과에 24문제가 필요하다. 진단검사로는 줄지 않는다
- 지식 요소를 오개념 + 개념 요소로 확장 — 오개념이 없는 개념은 지금 측정되지 않는다(설계 7-2의 A안)
- Phase 2에서 넘어온 것: 문제 검수 파이프라인, UNIT_MAP 교육과정 분류
