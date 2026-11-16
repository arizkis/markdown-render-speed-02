import fs from 'node:fs';
import path from 'node:path';
import { parse } from './parse.js';

const inputRoot = process.env.MAKEFUN_INPUT_DIR || '/input';
const outputRoot = process.env.MAKEFUN_OUTPUT_DIR || '/output';
const inputFile = process.env.INPUT_CASES || process.argv[2] || path.join(inputRoot, 'cases.json');
const outputFile = process.env.OUTPUT_HTML || process.argv[3] || path.join(outputRoot, 'html.json');

const payload = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
const cases = Array.isArray(payload) ? payload : Object.values(payload.cases ?? payload);
const html = cases.map(item => parse(typeof item === 'string' ? item : item?.markdown ?? ''));

fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, JSON.stringify(html));
