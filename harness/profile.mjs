import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { parse } from '../parse.js';

const inputPath = process.env.INPUT_CASES || '/home/hatch/workspace/makefun/projects/markdown-render-speed-02/kit-fresh/practice/input/cases.json';
const caseFile = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const cases = Array.isArray(caseFile) ? caseFile : Object.values(caseFile);
const sourceOf = item => typeof item === 'string' ? item : item?.markdown ?? '';

function timeRange(start, end) {
  let total = 0;
  let bytes = 0;
  for (let i = start; i < end; i++) {
    const source = sourceOf(cases[i]);
    const t = performance.now();
    parse(source);
    total += performance.now() - t;
    bytes += source.length;
  }
  return { total, bytes, count: Math.max(0, end - start) };
}

// Warm once so the reported numbers include compiled hot paths rather than startup effects.
for (let i = 0; i < Math.min(680, cases.length); i++) parse(sourceOf(cases[i]));
const spec = timeRange(0, Math.min(680, cases.length));
const docs = timeRange(Math.min(680, cases.length), cases.length);
console.log(`SPEC cases=${spec.count} chars=${spec.bytes} ms=${spec.total.toFixed(3)}`);
console.log(`DOCS cases=${docs.count} chars=${docs.bytes} ms=${docs.total.toFixed(3)}`);
