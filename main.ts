import fs from 'node:fs';
import path from 'node:path';
import { parse } from './parse.js';

const inputPath = process.env.INPUT_CASES || process.argv[2] || path.join(process.env.MAKEFUN_INPUT_DIR || '/input', 'cases.json');
const outputPath = process.env.OUTPUT_HTML || process.argv[3] || path.join(process.env.MAKEFUN_OUTPUT_DIR || '/output', 'html.json');
const raw = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const cases = Array.isArray(raw) ? raw : Object.values(raw.cases ?? raw);
if (!Array.isArray(cases)) throw new Error('input must be an array of cases');

const html = [];
for (const item of cases) {
  html.push(parse(typeof item === 'string' ? item : item?.markdown ?? ''));
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(html));
