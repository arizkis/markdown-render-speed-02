import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse } from './parse.js';

const [inputArgument, outputArgument] = process.argv.slice(2);
const inputFile = process.env.INPUT_CASES || inputArgument
  || join(process.env.MAKEFUN_INPUT_DIR || '/input', 'cases.json');
const outputFile = process.env.OUTPUT_HTML || outputArgument
  || join(process.env.MAKEFUN_OUTPUT_DIR || '/output', 'html.json');

const decoded = JSON.parse(readFileSync(inputFile, 'utf8'));
let entries = decoded;
if (!Array.isArray(entries)) entries = Object.values(entries.cases ?? entries);

const rendered = [];
for (const entry of entries) {
  const markdown = typeof entry === 'string' ? entry : (entry?.markdown ?? '');
  rendered.push(parse(markdown));
}

const serialized = JSON.stringify(rendered);
mkdirSync(dirname(outputFile), { recursive: true });
writeFileSync(outputFile, serialized);
