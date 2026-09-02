#!/usr/bin/env node
/* ============================================================
   시험 실행기 —  npm test

   네트워크를 쓰지 않는다. Gemini SDK와 Admin SDK는 _harness가 가짜로 바꾼다.
   시험 파일을 추가하려면 이 폴더에 `NN-이름.test.js`를 만들고 아래 목록에 넣으면 된다.
   ============================================================ */
const fs = require('fs');
const path = require('path');
const H = require('./_harness');

// 🔑 index.js를 부르기 전에 가로채기부터 걸어야 한다
H.stub();
H.seed(require('./_fixtures'));

const files = fs.readdirSync(__dirname)
  .filter(f => f.endsWith('.test.js'))
  .sort();

if (!files.length) {
  console.error('시험 파일이 없습니다 (test/*.test.js)');
  process.exit(1);
}

console.log('PhysiClinic 회귀 시험');
files.forEach((f) => {
  H.setFile(f.replace('.test.js', ''));
  require(path.join(__dirname, f));
});

H.runAll().then((failed) => process.exit(failed ? 1 : 0));
