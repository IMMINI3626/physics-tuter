/* 시험용 고정 데이터. 실제 Firestore를 흉내 내되 최소한만 담는다.
   같은 영역(dimensionCode) 오개념을 2개 이상 둬야 다중 태그(설계 4-12) 경로를 태울 수 있다. */
module.exports = {
  misconceptions: [
    { id: 'AR1', subUnit: '뉴턴 운동 법칙', dimensionCode: 'AR', description: '무거운 물체가 더 큰 힘을 가한다' },
    { id: 'AR2', subUnit: '뉴턴 운동 법칙', dimensionCode: 'AR', description: '빠른 물체가 더 큰 힘을 가한다' },
    { id: 'I4',  subUnit: '뉴턴 운동 법칙', dimensionCode: 'I',  description: '힘이 쌓여 가속도가 서서히 커진다' },
    { id: 'ME1', subUnit: '역학적 에너지 보존', dimensionCode: 'ME', description: '높이가 같으면 속력도 같다' },
  ],

  misconception_sentences: [
    { misconceptionId: 'AR1', sentence: '무거운 쪽이 더 센 힘을 준다', isWrong: true },
    { misconceptionId: 'AR1', sentence: '두 물체가 주고받는 힘의 크기는 같다', isWrong: false },
    { misconceptionId: 'I4',  sentence: '힘이 쌓이면 가속도가 커진다', isWrong: true },
  ],

  question_patterns: [
    {
      subUnit: '뉴턴 운동 법칙',
      patternType: '충돌',
      situationArchetype: '두 물체가 정면으로 부딪힘',
      keyDiscriminator: '작용-반작용',
      commonTrap: '질량이 큰 쪽이 더 큰 힘을 준다고 생각',
    },
  ],
};
