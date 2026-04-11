/**
 * PhysiClinic — Firestore 완전 시딩 스크립트
 * SQL physiclinic_schema_v2.sql 의 모든 정적 데이터 포함
 *
 * 사용법:
 *   1. npm install firebase-admin
 *   2. Firebase Console → 프로젝트 설정 → 서비스 계정 → 새 비공개 키 생성
 *      → serviceAccountKey.json 으로 저장 (이 파일과 같은 폴더)
 *   3. node seed.js
 *
 * 시딩 대상:
 *   ✅ units                    (3개)
 *   ✅ misconception_dimensions  (6개)
 *   ✅ misconceptions            (28개 — K1~G5 전체)
 *   ✅ misconception_sentences   (50개+)
 *   ✅ scoring_keywords          (40개+)
 *   ✅ fci_fmce_items            (73개 — FMCE 43 + FCI 30)
 *   ✅ item_misconception_map    (80개+)
 *
 * 제외 (동적 데이터):
 *   ❌ users / assessments / learning_sessions / learning_logs
 */

const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

/* ============================================================
   1. UNITS
   ============================================================ */
const units = [
  { id:'1', name:'힘과 운동',   keywords:['관성','외력','뉴턴','등속','힘','가속도','마찰','운동','속도','알짜힘','합력'] },
  { id:'2', name:'에너지',      keywords:['운동에너지','퍼텐셜에너지','역학적에너지','보존','일','에너지'] },
  { id:'3', name:'전기와 자기', keywords:['전류','전압','자기장','전기력','저항','전기'] },
];

/* ============================================================
   2. MISCONCEPTION DIMENSIONS
   ============================================================ */
const dims = [
  { id:'1', code:'K',  name_ko:'운동학',      name_en:'Kinematics',        description:'위치, 속도, 가속도 개념 혼동' },
  { id:'2', code:'I',  name_ko:'임페투스',    name_en:'Impetus',            description:'운동을 유지하는 내재적 힘이 있다는 믿음' },
  { id:'3', code:'AF', name_ko:'능동적 힘',   name_en:'Active Force',       description:'힘은 능동적 물체만 가할 수 있다는 믿음' },
  { id:'4', code:'AR', name_ko:'작용-반작용', name_en:'Action/Reaction',    description:'뉴턴 3법칙 관련 오개념' },
  { id:'5', code:'CI', name_ko:'힘의 합성',   name_en:'Concatenation',      description:'힘의 합성 및 우선순위 오개념' },
  { id:'6', code:'G',  name_ko:'중력/저항',   name_en:'Gravity/Resistance', description:'중력, 공기저항 관련 오개념' },
];

/* ============================================================
   3. MISCONCEPTIONS  (FCI Table 4-2, 전체 28개)
   ============================================================ */
const misconceptions = [
  // Kinematics
  { id:'K1', unitId:'1', dimensionCode:'K', code:'K1', name_ko:'위치-속도 미분화', name_en:'Position-velocity undiscriminated',
    description:'위치와 속도를 동일하거나 유사한 개념으로 혼동함',
    correctConcept:'위치는 공간상 좌표, 속도는 위치 변화율로 서로 독립적인 물리량',
    sourcePaper:'Hestenes, Wells & Swackhamer (1992), The Physics Teacher 30(3)' },
  { id:'K2', unitId:'1', dimensionCode:'K', code:'K2', name_ko:'속도-가속도 미분화', name_en:'Velocity-acceleration undiscriminated',
    description:'속도와 가속도를 동일하거나 유사한 개념으로 혼동함',
    correctConcept:'가속도는 속도의 변화율이며 속도와 방향이 다를 수 있음',
    sourcePaper:'Hestenes, Wells & Swackhamer (1992), The Physics Teacher 30(3)' },
  { id:'K3', unitId:'1', dimensionCode:'K', code:'K3', name_ko:'비벡터적 속도 합성', name_en:'Nonvectorial velocity composition',
    description:'속도를 벡터가 아닌 스칼라로 합성함',
    correctConcept:'속도는 벡터량으로 방향을 고려한 벡터 합산이 필요함',
    sourcePaper:'Hestenes, Wells & Swackhamer (1992), The Physics Teacher 30(3)' },
  // Impetus
  { id:'I1', unitId:'1', dimensionCode:'I', code:'I1', name_ko:'충격에 의한 임페투스', name_en:'Impetus supplied by hit',
    description:'물체를 치면 운동을 유지시키는 힘(임페투스)이 전달된다고 믿음',
    correctConcept:'충격은 순간적인 힘을 가할 뿐, 운동을 유지시키는 내재적 힘은 존재하지 않음',
    sourcePaper:'Hestenes, Wells & Swackhamer (1992), The Physics Teacher 30(3)' },
  { id:'I2', unitId:'1', dimensionCode:'I', code:'I2', name_ko:'임페투스 소멸/회복', name_en:'Loss/recovery of original impetus',
    description:'물체가 방향을 바꿀 때 원래 임페투스가 소멸했다가 회복된다고 믿음',
    correctConcept:'힘은 가속도를 만들 뿐이며, 임페투스 같은 내재적 운동 유지력은 없음',
    sourcePaper:'Hestenes, Wells & Swackhamer (1992), The Physics Teacher 30(3)' },
  { id:'I3', unitId:'1', dimensionCode:'I', code:'I3', name_ko:'추진력 소진 이론', name_en:'Impetus dissipation',
    description:'운동하는 물체의 힘(임페투스)이 점차 소진되어 결국 정지한다고 믿음',
    correctConcept:'마찰이 없으면 외력 없이도 등속 운동이 지속됨 (뉴턴 제1법칙)',
    sourcePaper:'Hestenes, Wells & Swackhamer (1992), The Physics Teacher 30(3)' },
  { id:'I4', unitId:'1', dimensionCode:'I', code:'I4', name_ko:'임페투스 점진적 축적', name_en:'Gradual/delayed impetus build-up',
    description:'힘을 가해도 임페투스가 서서히 축적되어 가속이 지연된다고 믿음',
    correctConcept:'힘이 작용하는 순간부터 즉시 가속도가 발생함 (F=ma)',
    sourcePaper:'Hestenes, Wells & Swackhamer (1992), The Physics Teacher 30(3)' },
  { id:'I5', unitId:'1', dimensionCode:'I', code:'I5', name_ko:'원형 임페투스', name_en:'Circular impetus',
    description:'원형 경로를 따라 운동하던 물체가 경로를 벗어나도 원형 궤적을 유지한다고 믿음',
    correctConcept:'구속력이 사라지면 물체는 그 순간의 접선 방향으로 직선 운동함',
    sourcePaper:'Hestenes, Wells & Swackhamer (1992), The Physics Teacher 30(3)' },
  // Active Force
  { id:'AF1', unitId:'1', dimensionCode:'AF', code:'AF1', name_ko:'능동적 물체만 힘을 가함', name_en:'Only active agents exert forces',
    description:'생물이나 엔진 같은 능동적 물체만 힘을 가할 수 있다고 믿음',
    correctConcept:'정지한 물체(벽, 바닥 등)도 접촉한 물체에 힘(수직항력 등)을 가함',
    sourcePaper:'Hestenes, Wells & Swackhamer (1992), The Physics Teacher 30(3)' },
  { id:'AF2', unitId:'1', dimensionCode:'AF', code:'AF2', name_ko:'운동은 능동적 힘을 의미', name_en:'Motion implies active force',
    description:'물체가 운동하고 있으면 반드시 능동적 힘이 작용하고 있다고 믿음',
    correctConcept:'등속 운동은 알짜힘이 0인 상태이며 능동적 힘 없이도 유지됨',
    sourcePaper:'Hestenes, Wells & Swackhamer (1992), The Physics Teacher 30(3)' },
  { id:'AF3', unitId:'1', dimensionCode:'AF', code:'AF3', name_ko:'정지=힘 없음', name_en:'No motion implies no force',
    description:'물체가 정지해 있으면 어떤 힘도 작용하지 않는다고 믿음',
    correctConcept:'정지 물체에도 중력, 수직항력 등 여러 힘이 작용하며 알짜힘이 0인 것임',
    sourcePaper:'Hestenes, Wells & Swackhamer (1992), The Physics Teacher 30(3)' },
  { id:'AF4', unitId:'1', dimensionCode:'AF', code:'AF4', name_ko:'속도는 힘에 비례', name_en:'Velocity proportional to applied force',
    description:'물체의 속도가 작용하는 힘의 크기에 비례한다고 믿음',
    correctConcept:'힘은 가속도에 비례하며(F=ma), 속도가 아닌 속도 변화율에 비례함',
    sourcePaper:'Hestenes, Wells & Swackhamer (1992), The Physics Teacher 30(3)' },
  { id:'AF5', unitId:'1', dimensionCode:'AF', code:'AF5', name_ko:'가속도=힘 증가', name_en:'Acceleration implies increasing force',
    description:'물체가 가속 중이면 힘도 계속 증가한다고 믿음',
    correctConcept:'일정한 힘(F=const)이 작용하면 일정한 가속도가 발생함',
    sourcePaper:'Hestenes, Wells & Swackhamer (1992), The Physics Teacher 30(3)' },
  { id:'AF6', unitId:'1', dimensionCode:'AF', code:'AF6', name_ko:'힘은 종단속도까지 가속', name_en:'Force causes acceleration to terminal velocity',
    description:'힘이 작용하면 물체는 어느 최대 속도(종단속도)까지만 가속된다고 믿음',
    correctConcept:'마찰 없이 일정한 힘이 지속되면 속도는 계속 증가함',
    sourcePaper:'Hestenes, Wells & Swackhamer (1992), The Physics Teacher 30(3)' },
  { id:'AF7', unitId:'1', dimensionCode:'AF', code:'AF7', name_ko:'능동적 힘 소진', name_en:'Active force wears out',
    description:'엔진 등 능동 물체의 힘은 시간이 지남에 따라 소진된다고 믿음',
    correctConcept:'연료가 일정하면 엔진의 힘은 소진되지 않음',
    sourcePaper:'Hestenes, Wells & Swackhamer (1992), The Physics Teacher 30(3)' },
  // Action/Reaction
  { id:'AR1', unitId:'1', dimensionCode:'AR', code:'AR1', name_ko:'질량이 크면 힘이 큼', name_en:'Greater mass implies greater force',
    description:'충돌 시 질량이 더 큰 물체가 더 큰 힘을 가한다고 믿음',
    correctConcept:'뉴턴 제3법칙: 작용-반작용 힘의 크기는 항상 같음',
    sourcePaper:'Hestenes, Wells & Swackhamer (1992), The Physics Teacher 30(3)' },
  { id:'AR2', unitId:'1', dimensionCode:'AR', code:'AR2', name_ko:'능동적 물체가 더 큰 힘', name_en:'Most active agent produces greatest force',
    description:'더 능동적인 물체(움직이는 물체 등)가 더 큰 힘을 가한다고 믿음',
    correctConcept:'뉴턴 제3법칙: 능동성과 관계없이 작용-반작용 힘은 크기가 같음',
    sourcePaper:'Hestenes, Wells & Swackhamer (1992), The Physics Teacher 30(3)' },
  // Concatenation
  { id:'CI1', unitId:'1', dimensionCode:'CI', code:'CI1', name_ko:'가장 큰 힘이 운동 결정', name_en:'Largest force determines motion',
    description:'여러 힘 중 가장 큰 힘의 방향으로만 운동한다고 믿음',
    correctConcept:'운동은 모든 힘의 벡터 합(알짜힘)에 의해 결정됨',
    sourcePaper:'Hestenes, Wells & Swackhamer (1992), The Physics Teacher 30(3)' },
  { id:'CI2', unitId:'1', dimensionCode:'CI', code:'CI2', name_ko:'힘의 타협', name_en:'Force compromise determines motion',
    description:'여러 힘이 작용할 때 운동은 힘들 사이의 타협 방향으로 결정된다고 믿음',
    correctConcept:'운동은 모든 힘의 벡터 합에 의해 결정됨',
    sourcePaper:'Hestenes, Wells & Swackhamer (1992), The Physics Teacher 30(3)' },
  { id:'CI3', unitId:'1', dimensionCode:'CI', code:'CI3', name_ko:'마지막 힘이 운동 결정', name_en:'Last force to act determines motion',
    description:'가장 최근에 작용한 힘이 이후 운동 방향을 결정한다고 믿음',
    correctConcept:'운동은 현재 작용하는 모든 힘의 합에 의해 결정됨',
    sourcePaper:'Hestenes, Wells & Swackhamer (1992), The Physics Teacher 30(3)' },
  // Gravity/Resistance
  { id:'CF', unitId:'1', dimensionCode:'G', code:'CF', name_ko:'원심력 실재', name_en:'Centrifugal force',
    description:'원운동하는 물체에 바깥쪽으로 실제 힘(원심력)이 작용한다고 믿음',
    correctConcept:'원심력은 관성계에서는 존재하지 않으며, 구심력만 실제로 작용함',
    sourcePaper:'Hestenes, Wells & Swackhamer (1992), The Physics Teacher 30(3)' },
  { id:'Ob', unitId:'1', dimensionCode:'G', code:'Ob', name_ko:'장애물은 힘을 가하지 않음', name_en:'Obstacles exert no force',
    description:'정지한 장애물(벽, 바닥 등)은 물체에 힘을 가하지 않는다고 믿음',
    correctConcept:'장애물도 접촉력(수직항력)을 통해 물체에 힘을 가함',
    sourcePaper:'Hestenes, Wells & Swackhamer (1992), The Physics Teacher 30(3)' },
  { id:'R1', unitId:'1', dimensionCode:'G', code:'R1', name_ko:'질량이 멈추게 함', name_en:'Mass makes things stop',
    description:'질량이 있는 물체는 결국 멈추려는 성질이 있다고 믿음',
    correctConcept:'질량은 관성의 척도이며 멈추려는 성질이 아님. 마찰이 멈추게 함',
    sourcePaper:'Hestenes, Wells & Swackhamer (1992), The Physics Teacher 30(3)' },
  { id:'R2', unitId:'1', dimensionCode:'G', code:'R2', name_ko:'저항을 극복해야 운동', name_en:'Motion when force overcomes resistance',
    description:'힘이 저항보다 클 때만 운동이 가능하다고 믿음',
    correctConcept:'알짜힘이 0이어도 등속 운동 가능. 힘>저항이면 가속됨',
    sourcePaper:'Hestenes, Wells & Swackhamer (1992), The Physics Teacher 30(3)' },
  { id:'R3', unitId:'1', dimensionCode:'G', code:'R3', name_ko:'저항은 힘/임페투스에 반대', name_en:'Resistance opposes force/impetus',
    description:'저항은 힘이 아닌 임페투스에 반대로 작용한다고 믿음',
    correctConcept:'마찰력은 운동 방향에 반대로 작용하는 실제 힘임',
    sourcePaper:'Hestenes, Wells & Swackhamer (1992), The Physics Teacher 30(3)' },
  { id:'G1', unitId:'1', dimensionCode:'G', code:'G1', name_ko:'공기압이 중력 보조', name_en:'Air pressure-assisted gravity',
    description:'중력은 공기압의 도움을 받아 물체를 아래로 당긴다고 믿음',
    correctConcept:'중력은 공기압과 독립적으로 작용하는 힘임',
    sourcePaper:'Hestenes, Wells & Swackhamer (1992), The Physics Teacher 30(3)' },
  { id:'G2', unitId:'1', dimensionCode:'G', code:'G2', name_ko:'중력은 질량 고유 성질', name_en:'Gravity intrinsic to mass',
    description:'중력은 물체 자체에 내재된 고유한 성질이라고 믿음',
    correctConcept:'중력은 두 물체 사이의 상호작용으로 발생하는 힘임',
    sourcePaper:'Hestenes, Wells & Swackhamer (1992), The Physics Teacher 30(3)' },
  { id:'G3', unitId:'1', dimensionCode:'G', code:'G3', name_ko:'무거운 물체가 더 빨리 낙하', name_en:'Heavier objects fall faster',
    description:'무거운 물체가 가벼운 물체보다 더 빨리 낙하한다고 믿음',
    correctConcept:'공기저항 무시 시 모든 물체는 동일한 중력가속도로 낙하함 (g≈9.8m/s²)',
    sourcePaper:'Hestenes, Wells & Swackhamer (1992), The Physics Teacher 30(3)' },
  { id:'G4', unitId:'1', dimensionCode:'G', code:'G4', name_ko:'낙하 중 중력 증가', name_en:'Gravity increases as objects fall',
    description:'물체가 낙하하면서 중력이 점점 커진다고 믿음',
    correctConcept:'지표면 근처에서 중력가속도 g는 일정함',
    sourcePaper:'Hestenes, Wells & Swackhamer (1992), The Physics Teacher 30(3)' },
  { id:'G5', unitId:'1', dimensionCode:'G', code:'G5', name_ko:'임페투스 소진 후 중력 작용', name_en:'Gravity acts after impetus wears down',
    description:'던진 물체의 임페투스가 소진된 후에야 중력이 작용하기 시작한다고 믿음',
    correctConcept:'중력은 던지는 순간부터 항상 작용함',
    sourcePaper:'Hestenes, Wells & Swackhamer (1992), The Physics Teacher 30(3)' },
];

/* ============================================================
   4. MISCONCEPTION SENTENCES
   ============================================================ */
const sentences = [
  { misconceptionId:'I3', isWrong:true,  sentence:'물체가 등속도로 운동하려면 계속 힘을 주어야 한다', difficulty:2 },
  { misconceptionId:'I3', isWrong:true,  sentence:'힘이 사라지면 물체는 곧 속도가 줄어 멈추게 된다', difficulty:2 },
  { misconceptionId:'I3', isWrong:false, sentence:'외력의 합이 0이면 물체는 등속도 직선 운동을 유지한다', difficulty:2 },
  { misconceptionId:'I3', isWrong:false, sentence:'마찰이 없는 경우 처음에만 힘을 주면 이후 등속 운동이 유지된다', difficulty:2 },
  { misconceptionId:'I3', isWrong:false, sentence:'등속 운동에서도 중력과 수직항력 같은 힘은 작용할 수 있다', difficulty:3 },
  { misconceptionId:'AR1', isWrong:true,  sentence:'충돌할 때 무거운 물체가 가벼운 물체에 더 큰 힘을 가한다', difficulty:2 },
  { misconceptionId:'AR1', isWrong:true,  sentence:'트럭이 자전거보다 더 큰 힘으로 충돌 상대를 민다', difficulty:2 },
  { misconceptionId:'AR1', isWrong:false, sentence:'뉴턴 제3법칙에 따라 두 물체가 서로 가하는 힘의 크기는 항상 같다', difficulty:2 },
  { misconceptionId:'AR1', isWrong:false, sentence:'작용과 반작용은 질량에 관계없이 크기가 같고 방향이 반대이다', difficulty:2 },
  { misconceptionId:'AR2', isWrong:true,  sentence:'움직이는 자동차가 정지한 트럭보다 더 큰 힘을 가한다', difficulty:2 },
  { misconceptionId:'AR2', isWrong:false, sentence:'작용-반작용은 어느 물체가 능동적인지와 관계없이 크기가 같다', difficulty:2 },
  { misconceptionId:'K1', isWrong:true,  sentence:'물체가 높은 위치에 있으면 속도도 크다', difficulty:2 },
  { misconceptionId:'K1', isWrong:false, sentence:'위치와 속도는 독립적인 물리량으로 위치가 높다고 속도가 크지 않다', difficulty:2 },
  { misconceptionId:'K2', isWrong:true,  sentence:'속도가 클수록 가속도도 크다', difficulty:2 },
  { misconceptionId:'K2', isWrong:true,  sentence:'물체가 빠르게 움직이면 가속도도 크다', difficulty:1 },
  { misconceptionId:'K2', isWrong:false, sentence:'가속도는 속도의 변화율이므로 속도가 일정하면 가속도는 0이다', difficulty:2 },
  { misconceptionId:'K2', isWrong:false, sentence:'등속 운동 중인 물체의 가속도는 빠르게 달려도 0이다', difficulty:2 },
  { misconceptionId:'K3', isWrong:true,  sentence:'동쪽 3m/s, 북쪽 4m/s로 동시에 움직이면 합속도는 7m/s이다', difficulty:2 },
  { misconceptionId:'K3', isWrong:false, sentence:'속도는 벡터이므로 동쪽 3m/s와 북쪽 4m/s의 합속도는 5m/s(북동 방향)이다', difficulty:2 },
  { misconceptionId:'AF1', isWrong:true,  sentence:'정지한 벽은 기대고 있는 사람에게 힘을 가하지 않는다', difficulty:1 },
  { misconceptionId:'AF1', isWrong:false, sentence:'정지한 벽도 기대는 사람에게 수직항력을 통해 힘을 가한다', difficulty:2 },
  { misconceptionId:'AF2', isWrong:true,  sentence:'물체가 움직이고 있다면 반드시 알짜힘이 작용하고 있다', difficulty:2 },
  { misconceptionId:'AF2', isWrong:false, sentence:'등속 운동하는 물체의 알짜힘은 0이다', difficulty:1 },
  { misconceptionId:'AF3', isWrong:true,  sentence:'정지해 있는 물체에는 아무런 힘도 작용하지 않는다', difficulty:1 },
  { misconceptionId:'AF3', isWrong:true,  sentence:'물체가 움직이지 않으면 알짜힘이 없다는 뜻이다', difficulty:2 },
  { misconceptionId:'AF3', isWrong:false, sentence:'정지한 물체에도 중력과 수직항력이 작용하며 알짜힘이 0인 것이다', difficulty:2 },
  { misconceptionId:'AF3', isWrong:false, sentence:'힘이 작용해도 알짜힘이 0이면 물체는 정지 상태를 유지한다', difficulty:3 },
  { misconceptionId:'AF4', isWrong:true,  sentence:'힘을 두 배로 늘리면 속도도 두 배가 된다', difficulty:2 },
  { misconceptionId:'AF4', isWrong:false, sentence:'힘을 두 배로 늘리면 가속도가 두 배가 되며, 속도는 시간에 따라 변한다', difficulty:2 },
  { misconceptionId:'AF5', isWrong:true,  sentence:'물체가 점점 빨라지고 있다면 작용하는 힘도 점점 커지고 있다', difficulty:2 },
  { misconceptionId:'AF5', isWrong:false, sentence:'일정한 힘이 작용하면 가속도가 일정하며 속도는 균일하게 증가한다', difficulty:2 },
  { misconceptionId:'CI1', isWrong:true,  sentence:'두 힘이 작용할 때 더 큰 힘의 방향으로만 운동한다', difficulty:2 },
  { misconceptionId:'CI1', isWrong:false, sentence:'운동 방향은 모든 힘의 벡터 합인 알짜힘의 방향으로 결정된다', difficulty:2 },
  { misconceptionId:'CF',  isWrong:true,  sentence:'원운동하는 물체에는 바깥쪽으로 원심력이 실제로 작용한다', difficulty:2 },
  { misconceptionId:'CF',  isWrong:false, sentence:'관성계에서 원심력은 존재하지 않으며 안쪽 방향의 구심력만 실제 힘이다', difficulty:3 },
  { misconceptionId:'G3',  isWrong:true,  sentence:'무거운 물체가 가벼운 물체보다 더 빨리 떨어진다', difficulty:1 },
  { misconceptionId:'G3',  isWrong:true,  sentence:'쇠공이 깃털보다 빨리 낙하하는 이유는 중력이 더 크게 작용하기 때문이다', difficulty:2 },
  { misconceptionId:'G3',  isWrong:false, sentence:'공기저항이 없다면 모든 물체는 질량에 관계없이 같은 가속도로 낙하한다', difficulty:2 },
  { misconceptionId:'G3',  isWrong:false, sentence:'중력가속도 g는 물체의 질량에 무관하게 약 9.8m/s²로 일정하다', difficulty:2 },
  { misconceptionId:'G4',  isWrong:true,  sentence:'낙하할수록 중력이 점점 강해져 가속도가 커진다', difficulty:2 },
  { misconceptionId:'G4',  isWrong:false, sentence:'지표면 근처에서 중력가속도는 낙하 거리와 무관하게 일정하다', difficulty:2 },
  { misconceptionId:'G5',  isWrong:true,  sentence:'위로 던진 공은 최고점에 도달해야 비로소 중력의 영향을 받기 시작한다', difficulty:2 },
  { misconceptionId:'G5',  isWrong:false, sentence:'위로 던진 순간부터 중력이 작용하여 공은 계속 아래 방향 가속도를 받는다', difficulty:2 },
  { misconceptionId:'I1',  isWrong:true,  sentence:'야구공을 치면 배트의 힘이 공 안에 담겨 공이 날아간다', difficulty:2 },
  { misconceptionId:'I1',  isWrong:false, sentence:'배트가 공에 가하는 힘은 접촉 중에만 작용하고 공이 떠난 후에는 힘이 없다', difficulty:2 },
  { misconceptionId:'I5',  isWrong:true,  sentence:'원형 튜브 안을 구르던 구슬은 튜브를 벗어난 후에도 곡선 경로를 따른다', difficulty:3 },
  { misconceptionId:'I5',  isWrong:false, sentence:'원형 경로를 따르던 물체는 구속이 풀리면 그 순간 접선 방향 직선 운동을 한다', difficulty:3 },
  { misconceptionId:'Ob',  isWrong:true,  sentence:'정지한 바닥은 그 위에 있는 물체에 힘을 가하지 않는다', difficulty:1 },
  { misconceptionId:'Ob',  isWrong:false, sentence:'바닥은 그 위의 물체에 수직항력을 가해 중력과 균형을 이룬다', difficulty:1 },
  { misconceptionId:'R1',  isWrong:true,  sentence:'질량이 클수록 물체는 더 쉽게 멈추려 한다', difficulty:2 },
  { misconceptionId:'R1',  isWrong:false, sentence:'질량은 관성(운동 상태를 유지하려는 성질)의 척도이며 멈추려는 성질이 아니다', difficulty:2 },
  { misconceptionId:'R2',  isWrong:true,  sentence:'힘이 마찰력보다 클 때만 물체가 움직일 수 있다', difficulty:2 },
  { misconceptionId:'R2',  isWrong:false, sentence:'알짜힘이 0이어도 이미 운동 중인 물체는 등속으로 계속 움직인다', difficulty:2 },
];

/* ============================================================
   5. SCORING KEYWORDS
   ============================================================ */
const keywords = [
  { misconceptionId:'I3',  keyword:'등속 운동',       isCorrect:true  },
  { misconceptionId:'I3',  keyword:'알짜힘',          isCorrect:true  },
  { misconceptionId:'I3',  keyword:'뉴턴 제1법칙',    isCorrect:true  },
  { misconceptionId:'I3',  keyword:'관성',            isCorrect:true  },
  { misconceptionId:'I3',  keyword:'힘이 필요',       isCorrect:false },
  { misconceptionId:'I3',  keyword:'계속 밀어야',     isCorrect:false },
  { misconceptionId:'AR1', keyword:'작용-반작용',     isCorrect:true  },
  { misconceptionId:'AR1', keyword:'같은 크기',       isCorrect:true  },
  { misconceptionId:'AR1', keyword:'뉴턴 제3법칙',   isCorrect:true  },
  { misconceptionId:'AR1', keyword:'질량이 클수록',   isCorrect:false },
  { misconceptionId:'AR2', keyword:'뉴턴 제3법칙',   isCorrect:true  },
  { misconceptionId:'AR2', keyword:'능동성 무관',     isCorrect:true  },
  { misconceptionId:'AR2', keyword:'움직이는 쪽이 더 큰', isCorrect:false },
  { misconceptionId:'K1',  keyword:'위치 변화율',     isCorrect:true  },
  { misconceptionId:'K1',  keyword:'독립적',          isCorrect:true  },
  { misconceptionId:'K1',  keyword:'높으면 빠르다',   isCorrect:false },
  { misconceptionId:'K2',  keyword:'속도 변화율',     isCorrect:true  },
  { misconceptionId:'K2',  keyword:'가속도 0',        isCorrect:true  },
  { misconceptionId:'K2',  keyword:'속도와 가속도 같다', isCorrect:false },
  { misconceptionId:'K3',  keyword:'벡터 합',         isCorrect:true  },
  { misconceptionId:'K3',  keyword:'방향 고려',       isCorrect:true  },
  { misconceptionId:'K3',  keyword:'크기만 더하면',   isCorrect:false },
  { misconceptionId:'AF1', keyword:'수직항력',        isCorrect:true  },
  { misconceptionId:'AF1', keyword:'접촉력',          isCorrect:true  },
  { misconceptionId:'AF1', keyword:'정지하면 힘 없다',isCorrect:false },
  { misconceptionId:'AF2', keyword:'알짜힘 0',        isCorrect:true  },
  { misconceptionId:'AF2', keyword:'등속',            isCorrect:true  },
  { misconceptionId:'AF2', keyword:'움직이면 힘 있다',isCorrect:false },
  { misconceptionId:'AF3', keyword:'알짜힘이 0',      isCorrect:true  },
  { misconceptionId:'AF3', keyword:'수직항력',        isCorrect:true  },
  { misconceptionId:'AF3', keyword:'힘이 없다',       isCorrect:false },
  { misconceptionId:'AF4', keyword:'가속도 비례',     isCorrect:true  },
  { misconceptionId:'AF4', keyword:'F=ma',           isCorrect:true  },
  { misconceptionId:'AF4', keyword:'속도 비례',       isCorrect:false },
  { misconceptionId:'AF5', keyword:'일정한 가속도',   isCorrect:true  },
  { misconceptionId:'AF5', keyword:'힘도 증가',       isCorrect:false },
  { misconceptionId:'CI1', keyword:'벡터 합',         isCorrect:true  },
  { misconceptionId:'CI1', keyword:'알짜힘',          isCorrect:true  },
  { misconceptionId:'CI1', keyword:'가장 큰 힘',      isCorrect:false },
  { misconceptionId:'CF',  keyword:'구심력',          isCorrect:true  },
  { misconceptionId:'CF',  keyword:'관성계',          isCorrect:true  },
  { misconceptionId:'CF',  keyword:'원심력 실재',     isCorrect:false },
  { misconceptionId:'G3',  keyword:'중력가속도 일정', isCorrect:true  },
  { misconceptionId:'G3',  keyword:'질량 무관',       isCorrect:true  },
  { misconceptionId:'G3',  keyword:'무거울수록',      isCorrect:false },
  { misconceptionId:'G4',  keyword:'g 일정',          isCorrect:true  },
  { misconceptionId:'G4',  keyword:'낙하할수록 커진다',isCorrect:false },
  { misconceptionId:'G5',  keyword:'항상 작용',       isCorrect:true  },
  { misconceptionId:'G5',  keyword:'최고점 이후',     isCorrect:false },
  { misconceptionId:'Ob',  keyword:'수직항력',        isCorrect:true  },
  { misconceptionId:'Ob',  keyword:'정지하면 힘 없음',isCorrect:false },
  { misconceptionId:'R1',  keyword:'관성',            isCorrect:true  },
  { misconceptionId:'R1',  keyword:'마찰',            isCorrect:true  },
  { misconceptionId:'R1',  keyword:'멈추려 한다',     isCorrect:false },
];

/* ============================================================
   6. FCI / FMCE ITEMS  (FMCE 43개 + FCI 30개)
   ============================================================ */
const fciItems = [
  // ── FMCE Force Sled (Q1-7) ──
  { id:'FMCE-1',  source:'FMCE', questionNo:1,  group:'Force Sled', correctAnswer:'B', unitId:'1',
    text:'썰매가 오른쪽으로 이동하면서 일정한 비율로 빨라지고 있다. 어떤 힘이 이 운동을 유지하는가?',
    choices:{A:'오른쪽 방향, 힘이 증가',B:'오른쪽 방향, 힘이 일정',C:'오른쪽 방향, 힘이 감소',D:'힘 없음',E:'왼쪽 방향, 힘이 증가',F:'왼쪽 방향, 힘이 일정',G:'왼쪽 방향, 힘이 감소',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  { id:'FMCE-2',  source:'FMCE', questionNo:2,  group:'Force Sled', correctAnswer:'D', unitId:'1',
    text:'썰매가 오른쪽으로 일정한 속도(등속)로 이동하고 있다. 어떤 힘이 이 운동을 유지하는가?',
    choices:{A:'오른쪽 방향, 힘이 증가',B:'오른쪽 방향, 힘이 일정',C:'오른쪽 방향, 힘이 감소',D:'힘 없음',E:'왼쪽 방향, 힘이 증가',F:'왼쪽 방향, 힘이 일정',G:'왼쪽 방향, 힘이 감소',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  { id:'FMCE-3',  source:'FMCE', questionNo:3,  group:'Force Sled', correctAnswer:'F', unitId:'1',
    text:'썰매가 오른쪽으로 이동하면서 일정한 비율로 느려지고 있다. 어떤 힘이 이 운동을 유지하는가?',
    choices:{A:'오른쪽 방향, 힘이 증가',B:'오른쪽 방향, 힘이 일정',C:'오른쪽 방향, 힘이 감소',D:'힘 없음',E:'왼쪽 방향, 힘이 증가',F:'왼쪽 방향, 힘이 일정',G:'왼쪽 방향, 힘이 감소',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  { id:'FMCE-4',  source:'FMCE', questionNo:4,  group:'Force Sled', correctAnswer:'F', unitId:'1',
    text:'썰매가 왼쪽으로 이동하면서 일정한 비율로 빨라지고 있다. 어떤 힘이 이 운동을 유지하는가?',
    choices:{A:'오른쪽 방향, 힘이 증가',B:'오른쪽 방향, 힘이 일정',C:'오른쪽 방향, 힘이 감소',D:'힘 없음',E:'왼쪽 방향, 힘이 증가',F:'왼쪽 방향, 힘이 일정',G:'왼쪽 방향, 힘이 감소',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  { id:'FMCE-5',  source:'FMCE', questionNo:5,  group:'Force Sled', correctAnswer:'D', unitId:'1',
    text:'썰매를 정지 상태에서 밀어 오른쪽으로 일정한 속도에 도달시켰다. 이 속도를 유지하려면 어떤 힘이 필요한가?',
    choices:{A:'오른쪽 방향, 힘이 증가',B:'오른쪽 방향, 힘이 일정',C:'오른쪽 방향, 힘이 감소',D:'힘 없음',E:'왼쪽 방향, 힘이 증가',F:'왼쪽 방향, 힘이 일정',G:'왼쪽 방향, 힘이 감소',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  { id:'FMCE-6',  source:'FMCE', questionNo:6,  group:'Force Sled', correctAnswer:'B', unitId:'1',
    text:'썰매가 일정한 비율로 느려지고 있으며 가속도 방향은 오른쪽이다. 어떤 힘이 이 운동을 설명하는가?',
    choices:{A:'오른쪽 방향, 힘이 증가',B:'오른쪽 방향, 힘이 일정',C:'오른쪽 방향, 힘이 감소',D:'힘 없음',E:'왼쪽 방향, 힘이 증가',F:'왼쪽 방향, 힘이 일정',G:'왼쪽 방향, 힘이 감소',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  { id:'FMCE-7',  source:'FMCE', questionNo:7,  group:'Force Sled', correctAnswer:'B', unitId:'1',
    text:'썰매가 왼쪽으로 이동하면서 일정한 비율로 느려지고 있다. 어떤 힘이 이 운동을 유지하는가?',
    choices:{A:'오른쪽 방향, 힘이 증가',B:'오른쪽 방향, 힘이 일정',C:'오른쪽 방향, 힘이 감소',D:'힘 없음',E:'왼쪽 방향, 힘이 증가',F:'왼쪽 방향, 힘이 일정',G:'왼쪽 방향, 힘이 감소',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  // ── FMCE Cart on Ramp (Q8-10) ──
  { id:'FMCE-8',  source:'FMCE', questionNo:8,  group:'Cart on Ramp', correctAnswer:'A', unitId:'1',
    text:'장난감 자동차를 경사면 위로 밀어 올렸다. 놓은 후 위로 올라가는 동안 자동차에 작용하는 알짜힘은?',
    choices:{A:'경사면 아래 방향, 일정',B:'경사면 아래 방향, 증가',C:'경사면 아래 방향, 감소',D:'힘 없음',E:'경사면 위 방향, 일정',F:'경사면 위 방향, 증가',G:'경사면 위 방향, 감소',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  { id:'FMCE-9',  source:'FMCE', questionNo:9,  group:'Cart on Ramp', correctAnswer:'A', unitId:'1',
    text:'장난감 자동차가 경사면 최고점에 있을 때 자동차에 작용하는 알짜힘은?',
    choices:{A:'경사면 아래 방향, 일정',B:'경사면 아래 방향, 증가',C:'경사면 아래 방향, 감소',D:'힘 없음',E:'경사면 위 방향, 일정',F:'경사면 위 방향, 증가',G:'경사면 위 방향, 감소',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  { id:'FMCE-10', source:'FMCE', questionNo:10, group:'Cart on Ramp', correctAnswer:'A', unitId:'1',
    text:'장난감 자동차가 경사면을 내려오는 동안 자동차에 작용하는 알짜힘은?',
    choices:{A:'경사면 아래 방향, 일정',B:'경사면 아래 방향, 증가',C:'경사면 아래 방향, 감소',D:'힘 없음',E:'경사면 위 방향, 일정',F:'경사면 위 방향, 증가',G:'경사면 위 방향, 감소',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  // ── FMCE Coin Toss (Q11-13) ──
  { id:'FMCE-11', source:'FMCE', questionNo:11, group:'Coin Toss', correctAnswer:'A', unitId:'1',
    text:'동전을 위로 던졌다. 손을 떠난 후 위로 올라가는 동안 동전에 작용하는 힘은? (공기저항 무시)',
    choices:{A:'아래 방향, 일정',B:'아래 방향, 증가',C:'아래 방향, 감소',D:'힘 없음',E:'위 방향, 일정',F:'위 방향, 증가',G:'위 방향, 감소',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  { id:'FMCE-12', source:'FMCE', questionNo:12, group:'Coin Toss', correctAnswer:'A', unitId:'1',
    text:'동전을 위로 던졌다. 동전이 최고점에 있을 때 동전에 작용하는 힘은? (공기저항 무시)',
    choices:{A:'아래 방향, 일정',B:'아래 방향, 증가',C:'아래 방향, 감소',D:'힘 없음',E:'위 방향, 일정',F:'위 방향, 증가',G:'위 방향, 감소',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  { id:'FMCE-13', source:'FMCE', questionNo:13, group:'Coin Toss', correctAnswer:'A', unitId:'1',
    text:'동전을 위로 던졌다. 최고점 이후 아래로 내려오는 동안 동전에 작용하는 힘은? (공기저항 무시)',
    choices:{A:'아래 방향, 일정',B:'아래 방향, 증가',C:'아래 방향, 감소',D:'힘 없음',E:'위 방향, 일정',F:'위 방향, 증가',G:'위 방향, 감소',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  // ── FMCE Force Graph (Q14-21) ──
  { id:'FMCE-14', source:'FMCE', questionNo:14, group:'Force Graph', correctAnswer:'D', unitId:'1',
    text:'장난감 자동차가 오른쪽으로 일정한 속도로 이동하고 있다. 이 운동을 유지하는 힘-시간 그래프는?',
    choices:{A:'양수 일정',B:'양수 증가',C:'양수 감소',D:'0 (힘 없음)',E:'음수 일정',F:'음수 감소',G:'음수 증가',H:'양수 감소 후 음수',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  { id:'FMCE-15', source:'FMCE', questionNo:15, group:'Force Graph', correctAnswer:'D', unitId:'1',
    text:'장난감 자동차가 정지해 있다. 이 상태를 나타내는 힘-시간 그래프는?',
    choices:{A:'양수 일정',B:'양수 증가',C:'양수 감소',D:'0 (힘 없음)',E:'음수 일정',F:'음수 감소',G:'음수 증가',H:'양수 감소 후 음수',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  { id:'FMCE-16', source:'FMCE', questionNo:16, group:'Force Graph', correctAnswer:'A', unitId:'1',
    text:'장난감 자동차가 오른쪽으로 일정한 비율로 빨라지고 있다. 이 운동을 만드는 힘-시간 그래프는?',
    choices:{A:'양수 일정',B:'양수 증가',C:'양수 감소',D:'0 (힘 없음)',E:'음수 일정',F:'음수 감소',G:'음수 증가',H:'양수 감소 후 음수',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  { id:'FMCE-17', source:'FMCE', questionNo:17, group:'Force Graph', correctAnswer:'D', unitId:'1',
    text:'장난감 자동차가 왼쪽으로 일정한 속도로 이동하고 있다. 이 운동을 유지하는 힘-시간 그래프는?',
    choices:{A:'양수 일정',B:'양수 증가',C:'양수 감소',D:'0 (힘 없음)',E:'음수 일정',F:'음수 감소',G:'음수 증가',H:'양수 감소 후 음수',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  { id:'FMCE-18', source:'FMCE', questionNo:18, group:'Force Graph', correctAnswer:'E', unitId:'1',
    text:'장난감 자동차가 오른쪽으로 이동하다 일정한 비율로 느려지고 있다. 이 운동을 만드는 힘-시간 그래프는?',
    choices:{A:'양수 일정',B:'양수 증가',C:'양수 감소',D:'0 (힘 없음)',E:'음수 일정',F:'음수 감소',G:'음수 증가',H:'양수 감소 후 음수',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  { id:'FMCE-19', source:'FMCE', questionNo:19, group:'Force Graph', correctAnswer:'E', unitId:'1',
    text:'장난감 자동차가 왼쪽으로 이동하면서 일정한 비율로 빨라지고 있다. 이 운동을 만드는 힘-시간 그래프는?',
    choices:{A:'양수 일정',B:'양수 증가',C:'양수 감소',D:'0 (힘 없음)',E:'음수 일정',F:'음수 감소',G:'음수 증가',H:'양수 감소 후 음수',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  { id:'FMCE-20', source:'FMCE', questionNo:20, group:'Force Graph', correctAnswer:'J', unitId:'1',
    text:'장난감 자동차가 오른쪽으로 이동하다가 빨라진 후 느려진다. 이 운동을 만드는 힘-시간 그래프는?',
    choices:{A:'양수 일정',B:'양수 증가',C:'양수 감소',D:'0 (힘 없음)',E:'음수 일정',F:'음수 감소',G:'음수 증가',H:'양수 감소 후 음수',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  { id:'FMCE-21', source:'FMCE', questionNo:21, group:'Force Graph', correctAnswer:'D', unitId:'1',
    text:'장난감 자동차를 오른쪽으로 밀었다가 손을 뗐다. 손을 뗀 후의 힘-시간 그래프는?',
    choices:{A:'양수 일정',B:'양수 증가',C:'양수 감소',D:'0 (힘 없음)',E:'음수 일정',F:'음수 감소',G:'음수 증가',H:'양수 감소 후 음수',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  // ── FMCE Acceleration Graph (Q22-26) ──
  { id:'FMCE-22', source:'FMCE', questionNo:22, group:'Acceleration Graph', correctAnswer:'A', unitId:'1',
    text:'장난감 자동차가 오른쪽으로 이동하면서 일정한 비율로 빨라지고 있다. 이 운동에 해당하는 가속도-시간 그래프는?',
    choices:{A:'양수 일정',B:'음수 일정',C:'0',D:'양수 증가',E:'음수 증가',F:'음수 감소',G:'양수 감소',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  { id:'FMCE-23', source:'FMCE', questionNo:23, group:'Acceleration Graph', correctAnswer:'B', unitId:'1',
    text:'장난감 자동차가 오른쪽으로 이동하면서 일정한 비율로 느려지고 있다. 이 운동에 해당하는 가속도-시간 그래프는?',
    choices:{A:'양수 일정',B:'음수 일정',C:'0',D:'양수 증가',E:'음수 증가',F:'음수 감소',G:'양수 감소',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  { id:'FMCE-24', source:'FMCE', questionNo:24, group:'Acceleration Graph', correctAnswer:'C', unitId:'1',
    text:'장난감 자동차가 왼쪽으로 일정한 속도로 이동하고 있다. 이 운동에 해당하는 가속도-시간 그래프는?',
    choices:{A:'양수 일정',B:'음수 일정',C:'0',D:'양수 증가',E:'음수 증가',F:'음수 감소',G:'양수 감소',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  { id:'FMCE-25', source:'FMCE', questionNo:25, group:'Acceleration Graph', correctAnswer:'B', unitId:'1',
    text:'장난감 자동차가 왼쪽으로 이동하면서 일정한 비율로 빨라지고 있다. 이 운동에 해당하는 가속도-시간 그래프는?',
    choices:{A:'양수 일정',B:'음수 일정',C:'0',D:'양수 증가',E:'음수 증가',F:'음수 감소',G:'양수 감소',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  { id:'FMCE-26', source:'FMCE', questionNo:26, group:'Acceleration Graph', correctAnswer:'C', unitId:'1',
    text:'장난감 자동차가 오른쪽으로 일정한 속도로 이동하고 있다. 이 운동에 해당하는 가속도-시간 그래프는?',
    choices:{A:'양수 일정',B:'음수 일정',C:'0',D:'양수 증가',E:'음수 증가',F:'음수 감소',G:'양수 감소',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  // ── FMCE Coin Toss Acceleration (Q27-29) ──
  { id:'FMCE-27', source:'FMCE', questionNo:27, group:'Coin Toss Acceleration', correctAnswer:'A', unitId:'1',
    text:'동전을 위로 던졌다. 손을 떠난 후 위로 올라가는 동안 동전의 가속도는? (위 방향 +)',
    choices:{A:'음수 방향, 일정',B:'음수 방향, 증가',C:'음수 방향, 감소',D:'0',E:'양수 방향, 일정',F:'양수 방향, 증가',G:'양수 방향, 감소',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  { id:'FMCE-28', source:'FMCE', questionNo:28, group:'Coin Toss Acceleration', correctAnswer:'A', unitId:'1',
    text:'동전을 위로 던졌다. 동전이 최고점에 있을 때 동전의 가속도는?',
    choices:{A:'음수 방향, 일정',B:'음수 방향, 증가',C:'음수 방향, 감소',D:'0',E:'양수 방향, 일정',F:'양수 방향, 증가',G:'양수 방향, 감소',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  { id:'FMCE-29', source:'FMCE', questionNo:29, group:'Coin Toss Acceleration', correctAnswer:'A', unitId:'1',
    text:'동전을 위로 던졌다. 최고점 이후 아래로 내려오는 동안 동전의 가속도는?',
    choices:{A:'음수 방향, 일정',B:'음수 방향, 증가',C:'음수 방향, 감소',D:'0',E:'양수 방향, 일정',F:'양수 방향, 증가',G:'양수 방향, 감소',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  // ── FMCE Collision (Q30-34) ──
  { id:'FMCE-30', source:'FMCE', questionNo:30, group:'Collision', correctAnswer:'E', unitId:'1',
    text:'트럭이 자동차보다 훨씬 무겁다. 같은 속도로 달리다 충돌할 때 힘의 크기 관계는?',
    choices:{A:'트럭이 더 큰 힘',B:'자동차가 더 큰 힘',C:'힘 없음',D:'트럭만 힘',E:'두 힘 같음',F:'정보 부족',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  { id:'FMCE-31', source:'FMCE', questionNo:31, group:'Collision', correctAnswer:'E', unitId:'1',
    text:'트럭이 자동차보다 훨씬 무겁다. 자동차가 훨씬 빠를 때 충돌 시 힘의 크기 관계는?',
    choices:{A:'트럭이 더 큰 힘',B:'자동차가 더 큰 힘',C:'힘 없음',D:'트럭만 힘',E:'두 힘 같음',F:'정보 부족',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  { id:'FMCE-32', source:'FMCE', questionNo:32, group:'Collision', correctAnswer:'E', unitId:'1',
    text:'트럭이 자동차보다 훨씬 무겁다. 트럭이 정지해 있을 때 자동차가 충돌 시 힘의 크기 관계는?',
    choices:{A:'트럭이 더 큰 힘',B:'자동차가 더 큰 힘',C:'힘 없음',D:'트럭만 힘',E:'두 힘 같음',F:'정보 부족',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  { id:'FMCE-33', source:'FMCE', questionNo:33, group:'Collision', correctAnswer:'E', unitId:'1',
    text:'트럭과 자동차의 질량이 같다. 같은 속도로 달리다 충돌할 때 힘의 크기 관계는?',
    choices:{A:'트럭이 더 큰 힘',B:'자동차가 더 큰 힘',C:'힘 없음',D:'트럭만 힘',E:'두 힘 같음',F:'정보 부족',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  { id:'FMCE-34', source:'FMCE', questionNo:34, group:'Collision', correctAnswer:'E', unitId:'1',
    text:'트럭과 자동차의 질량이 같다. 트럭이 정지해 있을 때 자동차가 충돌 시 힘의 크기 관계는?',
    choices:{A:'트럭이 더 큰 힘',B:'자동차가 더 큰 힘',C:'힘 없음',D:'트럭만 힘',E:'두 힘 같음',F:'정보 부족',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  // ── FMCE Pushing (Q35-38) ──
  { id:'FMCE-35', source:'FMCE', questionNo:35, group:'Pushing', correctAnswer:'A', unitId:'1',
    text:'소형차가 고장난 트럭을 밀고 있지만 트럭이 움직이지 않는다. 힘의 크기 관계는?',
    choices:{A:'차=트럭',B:'차<트럭',C:'차>트럭',D:'차만 힘',E:'힘 없음',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  { id:'FMCE-36', source:'FMCE', questionNo:36, group:'Pushing', correctAnswer:'A', unitId:'1',
    text:'소형차가 트럭을 밀면서 가속하는 중이다. 힘의 크기 관계는?',
    choices:{A:'차=트럭',B:'차<트럭',C:'차>트럭',D:'차만 힘',E:'힘 없음',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  { id:'FMCE-37', source:'FMCE', questionNo:37, group:'Pushing', correctAnswer:'A', unitId:'1',
    text:'소형차가 트럭을 밀면서 일정한 속도(등속)로 이동 중이다. 힘의 크기 관계는?',
    choices:{A:'차=트럭',B:'차<트럭',C:'차>트럭',D:'차만 힘',E:'힘 없음',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  { id:'FMCE-38', source:'FMCE', questionNo:38, group:'Pushing', correctAnswer:'A', unitId:'1',
    text:'소형차가 트럭을 밀다가 트럭이 브레이크를 밟아 감속 중이다. 힘의 크기 관계는?',
    choices:{A:'차=트럭',B:'차<트럭',C:'차>트럭',D:'차만 힘',E:'힘 없음',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  // ── FMCE Bob & Jim (Q39) ──
  { id:'FMCE-39', source:'FMCE', questionNo:39, group:'Bob and Jim', correctAnswer:'E', unitId:'1',
    text:'Bob(95kg)과 Jim(77kg)이 의자에 앉아 마주보고 있다. Bob이 Jim의 무릎을 발로 밀었을 때 두 학생에게 작용하는 힘은?',
    choices:{A:'아무도 힘 없음',B:'Bob만 힘을 가함',C:'Jim이 더 큰 힘',D:'Bob이 더 큰 힘',E:'두 힘 같음',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  // ── FMCE Velocity Graph (Q40-43) ──
  { id:'FMCE-40', source:'FMCE', questionNo:40, group:'Velocity Graph', correctAnswer:'A', unitId:'1',
    text:'장난감 자동차가 오른쪽으로 일정한 속도로 이동하고 있다. 이 운동에 해당하는 속도-시간 그래프는?',
    choices:{A:'양수 일정',B:'음수 일정',C:'0',D:'양수 증가(선형)',E:'음수 증가',F:'양수→0→음수',G:'음수→0→양수',H:'양수 감소 후 증가',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  { id:'FMCE-41', source:'FMCE', questionNo:41, group:'Velocity Graph', correctAnswer:'F', unitId:'1',
    text:'장난감 자동차가 방향을 바꾸고 있다. 이 운동에 해당하는 속도-시간 그래프는?',
    choices:{A:'양수 일정',B:'음수 일정',C:'0',D:'양수 증가(선형)',E:'음수 증가',F:'양수→0→음수',G:'음수→0→양수',H:'양수 감소 후 증가',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  { id:'FMCE-42', source:'FMCE', questionNo:42, group:'Velocity Graph', correctAnswer:'B', unitId:'1',
    text:'장난감 자동차가 왼쪽으로 일정한 속도로 이동하고 있다. 이 운동에 해당하는 속도-시간 그래프는?',
    choices:{A:'양수 일정',B:'음수 일정',C:'0',D:'양수 증가(선형)',E:'음수 증가',F:'양수→0→음수',G:'음수→0→양수',H:'양수 감소 후 증가',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  { id:'FMCE-43', source:'FMCE', questionNo:43, group:'Velocity Graph', correctAnswer:'D', unitId:'1',
    text:'장난감 자동차가 일정한 비율로 속도가 증가하고 있다. 이 운동에 해당하는 속도-시간 그래프는?',
    choices:{A:'양수 일정',B:'음수 일정',C:'0',D:'양수 증가(선형)',E:'음수 증가',F:'양수→0→음수',G:'음수→0→양수',H:'양수 감소 후 증가',J:'해당 없음'},
    sourcePaper:'Thornton & Sokoloff (1998), Am. J. Phys. 66(4)' },
  // ── FCI (Q1-30) ──
  { id:'FCI-1',  source:'FCI', questionNo:1,  group:'Gravity',      correctAnswer:'C', unitId:'1', choices:{}, text:'FCI 1번: 두 물체를 동시에 같은 높이에서 떨어뜨릴 때 어느 것이 먼저 떨어지는가?',         sourcePaper:'Hestenes et al. (1992)' },
  { id:'FCI-2',  source:'FCI', questionNo:2,  group:'Newton3',      correctAnswer:'E', unitId:'1', choices:{}, text:'FCI 2번: 무거운 트럭과 가벼운 자동차 정면충돌 시 힘의 관계는?',                           sourcePaper:'Hestenes et al. (1992)' },
  { id:'FCI-3',  source:'FCI', questionNo:3,  group:'Gravity',      correctAnswer:'A', unitId:'1', choices:{}, text:'FCI 3번: 두 물체를 서로 다른 높이에서 떨어뜨릴 때 낙하 가속도는?',                         sourcePaper:'Hestenes et al. (1992)' },
  { id:'FCI-4',  source:'FCI', questionNo:4,  group:'Newton1',      correctAnswer:'C', unitId:'1', choices:{}, text:'FCI 4번: 마찰 없는 수평면에서 물체를 밀었다 손을 뗀 후 운동은?',                           sourcePaper:'Hestenes et al. (1992)' },
  { id:'FCI-5',  source:'FCI', questionNo:5,  group:'Gravity',      correctAnswer:'D', unitId:'1', choices:{}, text:'FCI 5번: 낙하 중인 물체에 작용하는 힘은?',                                                   sourcePaper:'Hestenes et al. (1992)' },
  { id:'FCI-6',  source:'FCI', questionNo:6,  group:'Newton1',      correctAnswer:'B', unitId:'1', choices:{}, text:'FCI 6번: 등속 운동하는 물체에 작용하는 힘은?',                                               sourcePaper:'Hestenes et al. (1992)' },
  { id:'FCI-7',  source:'FCI', questionNo:7,  group:'Newton1',      correctAnswer:'E', unitId:'1', choices:{}, text:'FCI 7번: 두 힘이 작용할 때 물체의 운동 방향은?',                                             sourcePaper:'Hestenes et al. (1992)' },
  { id:'FCI-8',  source:'FCI', questionNo:8,  group:'Newton1',      correctAnswer:'A', unitId:'1', choices:{}, text:'FCI 8번: 마찰 없이 미끄러지는 물체의 운동은?',                                               sourcePaper:'Hestenes et al. (1992)' },
  { id:'FCI-9',  source:'FCI', questionNo:9,  group:'Superposition',correctAnswer:'D', unitId:'1', choices:{}, text:'FCI 9번: 여러 힘이 작용하는 물체의 운동 방향은?',                                            sourcePaper:'Hestenes et al. (1992)' },
  { id:'FCI-10', source:'FCI', questionNo:10, group:'Newton1',      correctAnswer:'B', unitId:'1', choices:{}, text:'FCI 10번: 원형 경로에서 구속 해제 후 물체 운동은?',                                          sourcePaper:'Hestenes et al. (1992)' },
  { id:'FCI-11', source:'FCI', questionNo:11, group:'Newton3',      correctAnswer:'E', unitId:'1', choices:{}, text:'FCI 11번: 충돌 시 작용-반작용 힘은?',                                                        sourcePaper:'Hestenes et al. (1992)' },
  { id:'FCI-12', source:'FCI', questionNo:12, group:'Force',        correctAnswer:'D', unitId:'1', choices:{}, text:'FCI 12번: 부력이 작용하는 물체에 작용하는 힘은?',                                            sourcePaper:'Hestenes et al. (1992)' },
  { id:'FCI-13', source:'FCI', questionNo:13, group:'Newton3',      correctAnswer:'A', unitId:'1', choices:{}, text:'FCI 13번: 물체가 밀고 있는 대상에 작용하는 힘은?',                                          sourcePaper:'Hestenes et al. (1992)' },
  { id:'FCI-14', source:'FCI', questionNo:14, group:'Newton3',      correctAnswer:'A', unitId:'1', choices:{}, text:'FCI 14번: 정지한 물체에 작용하는 힘은?',                                                     sourcePaper:'Hestenes et al. (1992)' },
  { id:'FCI-15', source:'FCI', questionNo:15, group:'Force',        correctAnswer:'C', unitId:'1', choices:{}, text:'FCI 15번: 스프링으로 밀린 물체에 작용하는 힘은?',                                           sourcePaper:'Hestenes et al. (1992)' },
  { id:'FCI-16', source:'FCI', questionNo:16, group:'Newton2',      correctAnswer:'B', unitId:'1', choices:{}, text:'FCI 16번: 포물선 운동하는 물체의 중간 지점에서의 힘은?',                                    sourcePaper:'Hestenes et al. (1992)' },
  { id:'FCI-17', source:'FCI', questionNo:17, group:'Newton2',      correctAnswer:'C', unitId:'1', choices:{}, text:'FCI 17번: 자유낙하 중인 물체의 가속도는?',                                                   sourcePaper:'Hestenes et al. (1992)' },
  { id:'FCI-18', source:'FCI', questionNo:18, group:'Newton1',      correctAnswer:'B', unitId:'1', choices:{}, text:'FCI 18번: 등속 상승하는 엘리베이터 안 물체의 힘은?',                                        sourcePaper:'Hestenes et al. (1992)' },
  { id:'FCI-19', source:'FCI', questionNo:19, group:'Superposition',correctAnswer:'B', unitId:'1', choices:{}, text:'FCI 19번: 두 힘이 동시에 작용할 때 물체 방향은?',                                           sourcePaper:'Hestenes et al. (1992)' },
  { id:'FCI-20', source:'FCI', questionNo:20, group:'Kinematics',   correctAnswer:'E', unitId:'1', choices:{}, text:'FCI 20번: 속도-시간 그래프 해석은?',                                                         sourcePaper:'Hestenes et al. (1992)' },
  { id:'FCI-21', source:'FCI', questionNo:21, group:'Kinematics',   correctAnswer:'D', unitId:'1', choices:{}, text:'FCI 21번: 가속도-시간 그래프 해석은?',                                                       sourcePaper:'Hestenes et al. (1992)' },
  { id:'FCI-22', source:'FCI', questionNo:22, group:'Newton2',      correctAnswer:'D', unitId:'1', choices:{}, text:'FCI 22번: 공기저항이 작용하는 물체의 운동은?',                                               sourcePaper:'Hestenes et al. (1992)' },
  { id:'FCI-23', source:'FCI', questionNo:23, group:'Newton2',      correctAnswer:'D', unitId:'1', choices:{}, text:'FCI 23번: 포물선 경로 최고점에서의 힘은?',                                                   sourcePaper:'Hestenes et al. (1992)' },
  { id:'FCI-24', source:'FCI', questionNo:24, group:'Newton2',      correctAnswer:'E', unitId:'1', choices:{}, text:'FCI 24번: 일정한 힘이 작용할 때 속도 변화는?',                                               sourcePaper:'Hestenes et al. (1992)' },
  { id:'FCI-25', source:'FCI', questionNo:25, group:'Newton2',      correctAnswer:'B', unitId:'1', choices:{}, text:'FCI 25번: 일정한 힘 작용 시 물체의 운동은?',                                                 sourcePaper:'Hestenes et al. (1992)' },
  { id:'FCI-26', source:'FCI', questionNo:26, group:'Newton1',      correctAnswer:'B', unitId:'1', choices:{}, text:'FCI 26번: 힘이 없을 때 물체의 속도 방향은?',                                                 sourcePaper:'Hestenes et al. (1992)' },
  { id:'FCI-27', source:'FCI', questionNo:27, group:'Newton1',      correctAnswer:'A', unitId:'1', choices:{}, text:'FCI 27번: 힘이 없을 때 물체의 속력은?',                                                      sourcePaper:'Hestenes et al. (1992)' },
  { id:'FCI-28', source:'FCI', questionNo:28, group:'Newton1',      correctAnswer:'C', unitId:'1', choices:{}, text:'FCI 28번: 상쇄되는 힘이 작용할 때 물체의 운동은?',                                          sourcePaper:'Hestenes et al. (1992)' },
  { id:'FCI-29', source:'FCI', questionNo:29, group:'Force',        correctAnswer:'C', unitId:'1', choices:{}, text:'FCI 29번: 마찰력의 방향은?',                                                                  sourcePaper:'Hestenes et al. (1992)' },
  { id:'FCI-30', source:'FCI', questionNo:30, group:'Newton3',      correctAnswer:'E', unitId:'1', choices:{}, text:'FCI 30번: 총알과 총에 작용하는 힘의 관계는?',                                                 sourcePaper:'Hestenes et al. (1992)' },
];

/* ============================================================
   7. ITEM-MISCONCEPTION MAP
   ============================================================ */
const itemMap = [
  // FMCE
  { itemId:'FMCE-2',  choice:'B', misconceptionId:'I3'  },
  { itemId:'FMCE-2',  choice:'A', misconceptionId:'AF4' },
  { itemId:'FMCE-5',  choice:'B', misconceptionId:'I3'  },
  { itemId:'FMCE-9',  choice:'D', misconceptionId:'AF3' },
  { itemId:'FMCE-11', choice:'G', misconceptionId:'G5'  },
  { itemId:'FMCE-11', choice:'E', misconceptionId:'I3'  },
  { itemId:'FMCE-12', choice:'D', misconceptionId:'AF3' },
  { itemId:'FMCE-12', choice:'G', misconceptionId:'I3'  },
  { itemId:'FMCE-13', choice:'B', misconceptionId:'G4'  },
  { itemId:'FMCE-27', choice:'D', misconceptionId:'AF3' },
  { itemId:'FMCE-27', choice:'C', misconceptionId:'I3'  },
  { itemId:'FMCE-28', choice:'D', misconceptionId:'AF3' },
  { itemId:'FMCE-29', choice:'D', misconceptionId:'AF3' },
  { itemId:'FMCE-29', choice:'B', misconceptionId:'G4'  },
  { itemId:'FMCE-30', choice:'A', misconceptionId:'AR1' },
  { itemId:'FMCE-31', choice:'B', misconceptionId:'AR2' },
  { itemId:'FMCE-32', choice:'A', misconceptionId:'AR1' },
  { itemId:'FMCE-39', choice:'D', misconceptionId:'AR1' },
  { itemId:'FMCE-39', choice:'C', misconceptionId:'AR2' },
  // FCI Kinematics
  { itemId:'FCI-20', choice:'B', misconceptionId:'K1' },
  { itemId:'FCI-20', choice:'C', misconceptionId:'K1' },
  { itemId:'FCI-20', choice:'D', misconceptionId:'K1' },
  { itemId:'FCI-20', choice:'A', misconceptionId:'K2' },
  { itemId:'FCI-21', choice:'B', misconceptionId:'K2' },
  { itemId:'FCI-21', choice:'C', misconceptionId:'K2' },
  { itemId:'FCI-7',  choice:'C', misconceptionId:'K3' },
  // FCI Impetus
  { itemId:'FCI-9',  choice:'B', misconceptionId:'I1' },
  { itemId:'FCI-9',  choice:'C', misconceptionId:'I1' },
  { itemId:'FCI-4',  choice:'D', misconceptionId:'I2' },
  { itemId:'FCI-6',  choice:'C', misconceptionId:'I2' },
  { itemId:'FCI-5',  choice:'A', misconceptionId:'I3' },
  { itemId:'FCI-5',  choice:'B', misconceptionId:'I3' },
  { itemId:'FCI-5',  choice:'C', misconceptionId:'I3' },
  { itemId:'FCI-8',  choice:'C', misconceptionId:'I3' },
  { itemId:'FCI-6',  choice:'D', misconceptionId:'I4' },
  { itemId:'FCI-8',  choice:'B', misconceptionId:'I4' },
  { itemId:'FCI-8',  choice:'D', misconceptionId:'I4' },
  { itemId:'FCI-4',  choice:'A', misconceptionId:'I5' },
  { itemId:'FCI-4',  choice:'D', misconceptionId:'I5' },
  { itemId:'FCI-10', choice:'A', misconceptionId:'I5' },
  // FCI Active Force
  { itemId:'FCI-11', choice:'B', misconceptionId:'AF1' },
  { itemId:'FCI-12', choice:'B', misconceptionId:'AF1' },
  { itemId:'FCI-13', choice:'D', misconceptionId:'AF1' },
  { itemId:'FCI-14', choice:'D', misconceptionId:'AF1' },
  { itemId:'FCI-15', choice:'A', misconceptionId:'AF1' },
  { itemId:'FCI-15', choice:'B', misconceptionId:'AF1' },
  { itemId:'FCI-29', choice:'A', misconceptionId:'AF2' },
  { itemId:'FCI-12', choice:'E', misconceptionId:'AF3' },
  { itemId:'FCI-25', choice:'A', misconceptionId:'AF4' },
  { itemId:'FCI-28', choice:'A', misconceptionId:'AF4' },
  // FCI Action/Reaction
  { itemId:'FCI-2',  choice:'A', misconceptionId:'AR1' },
  { itemId:'FCI-2',  choice:'D', misconceptionId:'AR1' },
  { itemId:'FCI-11', choice:'D', misconceptionId:'AR1' },
  { itemId:'FCI-13', choice:'B', misconceptionId:'AR1' },
  { itemId:'FCI-14', choice:'B', misconceptionId:'AR1' },
  { itemId:'FCI-13', choice:'C', misconceptionId:'AR2' },
  { itemId:'FCI-14', choice:'C', misconceptionId:'AR2' },
  // FCI Concatenation
  { itemId:'FCI-18', choice:'A', misconceptionId:'CI1' },
  { itemId:'FCI-18', choice:'E', misconceptionId:'CI1' },
  { itemId:'FCI-19', choice:'A', misconceptionId:'CI1' },
  { itemId:'FCI-4',  choice:'C', misconceptionId:'CI2' },
  { itemId:'FCI-10', choice:'D', misconceptionId:'CI2' },
  { itemId:'FCI-6',  choice:'A', misconceptionId:'CI3' },
  { itemId:'FCI-7',  choice:'B', misconceptionId:'CI3' },
  // FCI Centrifugal
  { itemId:'FCI-4',  choice:'C', misconceptionId:'CF' },
  { itemId:'FCI-4',  choice:'E', misconceptionId:'CF' },
  { itemId:'FCI-10', choice:'C', misconceptionId:'CF' },
  { itemId:'FCI-10', choice:'D', misconceptionId:'CF' },
  { itemId:'FCI-10', choice:'E', misconceptionId:'CF' },
  // FCI Obstacles
  { itemId:'FCI-2',  choice:'C', misconceptionId:'Ob' },
  { itemId:'FCI-9',  choice:'A', misconceptionId:'Ob' },
  { itemId:'FCI-9',  choice:'B', misconceptionId:'Ob' },
  { itemId:'FCI-12', choice:'A', misconceptionId:'Ob' },
  { itemId:'FCI-13', choice:'E', misconceptionId:'Ob' },
  { itemId:'FCI-14', choice:'E', misconceptionId:'Ob' },
  // FCI Gravity
  { itemId:'FCI-9',  choice:'A', misconceptionId:'G1' },
  { itemId:'FCI-12', choice:'C', misconceptionId:'G1' },
  { itemId:'FCI-5',  choice:'E', misconceptionId:'G2' },
  { itemId:'FCI-9',  choice:'E', misconceptionId:'G2' },
  { itemId:'FCI-1',  choice:'A', misconceptionId:'G3' },
  { itemId:'FCI-3',  choice:'B', misconceptionId:'G3' },
  { itemId:'FCI-3',  choice:'D', misconceptionId:'G3' },
  { itemId:'FCI-5',  choice:'B', misconceptionId:'G4' },
  { itemId:'FCI-17', choice:'B', misconceptionId:'G4' },
  { itemId:'FCI-5',  choice:'B', misconceptionId:'G5' },
  { itemId:'FCI-16', choice:'D', misconceptionId:'G5' },
];

/* ============================================================
   UPLOAD
   ============================================================ */
async function batchUpload(collectionName, items, idField) {
  const chunks = [];
  for (let i = 0; i < items.length; i += 400) chunks.push(items.slice(i, i + 400));
  for (const chunk of chunks) {
    const batch = db.batch();
    chunk.forEach(item => {
      const ref = idField ? db.collection(collectionName).doc(item[idField]) : db.collection(collectionName).doc();
      batch.set(ref, item);
    });
    await batch.commit();
  }
}

async function seed() {
  console.log('🌱 PhysiClinic Firestore 완전 시딩 시작...\n');

  console.log('1/7 📚 units...');
  await batchUpload('units', units, 'id');
  console.log(`    ✅ ${units.length}개`);

  console.log('2/7 📐 misconception_dimensions...');
  await batchUpload('misconception_dimensions', dims, 'id');
  console.log(`    ✅ ${dims.length}개`);

  console.log('3/7 🧠 misconceptions (전체 28개)...');
  await batchUpload('misconceptions', misconceptions, 'id');
  console.log(`    ✅ ${misconceptions.length}개`);

  console.log('4/7 📝 misconception_sentences...');
  await batchUpload('misconception_sentences', sentences, null);
  console.log(`    ✅ ${sentences.length}개`);

  console.log('5/7 🔑 scoring_keywords...');
  await batchUpload('scoring_keywords', keywords, null);
  console.log(`    ✅ ${keywords.length}개`);

  console.log('6/7 📋 fci_fmce_items (FMCE 43 + FCI 30)...');
  await batchUpload('fci_fmce_items', fciItems, 'id');
  console.log(`    ✅ ${fciItems.length}개`);

  console.log('7/7 🗺️  item_misconception_map...');
  await batchUpload('item_misconception_map', itemMap, null);
  console.log(`    ✅ ${itemMap.length}개`);

  console.log('\n🎉 시딩 완료!');
  console.log('   https://console.firebase.google.com → Firestore Database\n');
  console.log('   컬렉션          | 건수');
  console.log('   ─────────────────────────────');
  console.log(`   units                    | ${units.length}`);
  console.log(`   misconception_dimensions  | ${dims.length}`);
  console.log(`   misconceptions            | ${misconceptions.length}  ← K1~G5 전체`);
  console.log(`   misconception_sentences   | ${sentences.length}`);
  console.log(`   scoring_keywords          | ${keywords.length}`);
  console.log(`   fci_fmce_items            | ${fciItems.length}  ← FMCE 43 + FCI 30`);
  console.log(`   item_misconception_map    | ${itemMap.length}`);
  process.exit(0);
}

seed().catch(err => {
  console.error('❌ 시딩 실패:', err.message);
  process.exit(1);
});
