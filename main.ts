import fs from 'node:fs';
import path from 'node:path';
import { parse } from './parse.js';

function readInputs(filename) {
  const document = JSON.parse(fs.readFileSync(filename, { encoding: 'utf8' }));
  if (Array.isArray(document)) return document;
  return Object.values(document.cases ?? document);
}

function renderInput(item) {
  const markdown = typeof item === 'string' ? item : item?.markdown ?? '';
  return parse(markdown);
}

function run() {
  const inputDirectory = process.env.MAKEFUN_INPUT_DIR || '/input';
  const outputDirectory = process.env.MAKEFUN_OUTPUT_DIR || '/output';
  const sourceFile = process.env.INPUT_CASES || process.argv[2] || path.resolve(inputDirectory, 'cases.json');
  const destinationFile = process.env.OUTPUT_HTML || process.argv[3] || path.resolve(outputDirectory, 'html.json');
  const renderedCases = readInputs(sourceFile).map(renderInput);
  fs.mkdirSync(path.dirname(destinationFile), { recursive: true });
  fs.writeFileSync(destinationFile, JSON.stringify(renderedCases));
}

run();
