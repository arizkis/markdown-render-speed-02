import fs from 'node:fs';
import { parse } from '../parse.js';

const inputPath = process.env.INPUT_CASES || '/home/hatch/workspace/makefun/projects/markdown-render-speed-02/kit-fresh/practice/input/cases.json';
const expectedPath = process.env.EXPECTED_HTML || '/home/hatch/workspace/makefun/projects/markdown-render-speed-02/kit-fresh/practice/reference/expected.json';
const caseFile = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const expectedFile = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
const cases = Array.isArray(caseFile) ? caseFile : Object.values(caseFile);
const expected = Array.isArray(expectedFile)
  ? expectedFile
  : (Array.isArray(expectedFile.cases) ? expectedFile.cases.map(x => x.html) : Object.values(expectedFile.cases ?? expectedFile));
if (!Array.isArray(cases) || !Array.isArray(expected)) throw new Error('oracle files must contain case collections');
if (expected.length < cases.length) throw new Error(`expected only ${expected.length} cases for ${cases.length} inputs`);

function sourceOf(item) {
  return typeof item === 'string' ? item : item?.markdown ?? '';
}

function context(value, position) {
  const start = Math.max(0, position - 60);
  const end = Math.min(value.length, position + 60);
  return JSON.stringify(value.slice(start, end));
}

function one(index) {
  const input = sourceOf(cases[index]);
  const want = expected[index];
  const got = parse(input);
  console.log(`CASE ${index}`);
  console.log('INPUT:\n' + input);
  console.log('EXPECTED:\n' + want);
  console.log('ACTUAL:\n' + got);
}

const oneFlag = process.argv.indexOf('--one');
if (oneFlag >= 0) {
  const index = Number(process.argv[oneFlag + 1]);
  if (!Number.isInteger(index) || index < 0 || index >= cases.length) throw new Error('invalid --one index');
  one(index);
  process.exit(0);
}

let passed = 0;
let specPassed = 0;
let docsPassed = 0;
for (let i = 0; i < cases.length; i++) {
  const got = parse(sourceOf(cases[i]));
  const want = expected[i];
  if (got === want) {
    passed++;
    if (i < 680) specPassed++; else docsPassed++;
    continue;
  }
  let p = 0;
  const limit = Math.min(got.length, want.length);
  while (p < limit && got.charCodeAt(p) === want.charCodeAt(p)) p++;
  console.log(`FAIL ${i} diff=${p}`);
  console.log('  expected:', context(want, p));
  console.log('  actual:  ', context(got, p));
}
console.log(`TOTAL ${passed}/${cases.length}`);
console.log(`SPEC ${specPassed}/${Math.min(680, cases.length)}`);
console.log(`DOCS ${docsPassed}/${Math.max(0, cases.length - 680)}`);
