import fs from 'node:fs';
import { parse } from '../parse.js';

const root = '/home/hatch/workspace/makefun/projects/markdown-render-speed-02/kit-fresh/practice';
const cases = JSON.parse(fs.readFileSync(`${root}/input/cases.json`, 'utf8'));
const expected = JSON.parse(fs.readFileSync(`${root}/reference/expected.json`, 'utf8')).cases;
for (const arg of process.argv.slice(2)) {
  const index = Number(arg);
  const source = cases[index].markdown;
  const want = expected[index].html;
  const got = parse(source);
  let at = 0;
  while (at < want.length && want[at] === got[at]) at++;
  let anchor = '', position = -1;
  for (let begin = Math.max(0, at - 200); begin < at; begin++) {
    for (let size = Math.min(75, at - begin); size > anchor.length; size--) {
      const part = want.slice(begin, begin + size);
      const found = source.indexOf(part);
      if (found >= 0) { anchor = part; position = found; break; }
    }
  }
  console.log(`CASE ${index} diff=${at} source=${position} anchor=${JSON.stringify(anchor)}`);
  console.log('SOURCE', JSON.stringify(source.slice(Math.max(0, position - 350), position + 1200)));
  console.log('WANT', JSON.stringify(want.slice(Math.max(0, at - 150), at + 600)));
  console.log('GOT ', JSON.stringify(got.slice(Math.max(0, at - 150), at + 600)));
}
