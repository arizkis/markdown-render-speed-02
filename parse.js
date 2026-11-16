const ESC = { '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&#39;', '"': '&quot;' };
const PUNCT = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
const IN_RAW_LINK = Symbol('inside an HTML anchor');
const COLLECT_REFS = Symbol('collect references');
const EMAIL_LOCAL = asciiFlags("!#$%&'*+/=?^_`{|}~.-");
const INLINE_SPECIAL = asciiFlags('\n\\`&<[]!*_~"\'>');

function asciiFlags(characters) {
  const flags = new Uint8Array(128);
  for (let offset = 0; offset < characters.length; offset++) {
    flags[characters.charCodeAt(offset)] = 1;
  }
  return flags;
}

function escapeHtml(source, encode = false) {
  let rendered = '';
  let copiedThrough = 0;
  for (let cursor = 0; cursor < source.length; cursor++) {
    switch (source.charCodeAt(cursor)) {
      case 38:
        if (!encode) {
          const entityLimit = entityAt(source, cursor);
          if (entityLimit > cursor) {
            cursor = entityLimit - 1;
            continue;
          }
        }
        break;
      case 34: case 39: case 60: case 62:
        break;
      default:
        continue;
    }
    rendered += source.slice(copiedThrough, cursor) + ESC[source[cursor]];
    copiedThrough = cursor + 1;
  }
  return copiedThrough === 0 ? source : rendered + source.slice(copiedThrough);
}

function cleanUrl(address) {
  let uri;
  try {
    uri = encodeURI(address.trim());
  } catch {
    uri = address.trim();
  }
  return escapeHtml(uri.replaceAll('%25', '%'));
}

function normalizeLabel(source) {
  let key = '';
  let needsSeparator = false;
  let cursor = 0;
  while (cursor < source.length) {
    const character = source[cursor++];
    if (character === '\t' || character === '\n' || character === ' ') {
      needsSeparator = key.length > 0;
    } else {
      key += (needsSeparator ? ' ' : '') + (character === '\u1e9e' ? 'ss' : character.toLowerCase());
      needsSeparator = false;
    }
  }
  return key;
}

function isBlank(source) {
  return leadingSpaces(source) === source.length;
}

function trimAscii(source) {
  const begin = leadingSpaces(source);
  let limit = source.length;
  while (limit > begin) {
    const code = source.charCodeAt(limit - 1);
    if (code !== 9 && code !== 32) break;
    limit--;
  }
  return source.slice(begin, limit);
}

function indentColumns(source) {
  let columns = 0;
  for (let cursor = 0; cursor < source.length; cursor++) {
    switch (source[cursor]) {
      case ' ': columns++; break;
      case '\t': columns = (columns + 4) & ~3; break;
      default: return columns;
    }
  }
  return columns;
}

function consumeIndent(source, requested, origin, expandTail, adjustListTabs) {
  let cursor = 0;
  let absoluteColumn = origin;
  let remaining = requested;
  let retained = 0;
  while (cursor < source.length) {
    const code = source.charCodeAt(cursor);
    if (code !== 9 && code !== 32) break;
    if (!expandTail && remaining <= 0) break;
    const columns = code === 32 ? 1 : 4 - (absoluteColumn & 3);
    const taken = Math.min(columns, Math.max(0, remaining));
    retained += columns - taken;
    remaining -= taken;
    absoluteColumn += columns;
    cursor++;
  }
  let tail = source.slice(cursor);
  if (adjustListTabs && requested > 0 && source[0] === '\t' && tail[0] === '\t') {
    tail = '  ' + tail.slice(1);
  }
  return retained ? ' '.repeat(retained) + tail : tail;
}

function stripIndent(source, columns, retainTabs = false) {
  return consumeIndent(source, columns, 0, false, !retainTabs);
}

function stripFencedIndent(source, columns, baseIndent) {
  return consumeIndent(source, columns, baseIndent, true, false);
}

function stripFenceContent(source, columns, baseIndent) {
  if (baseIndent) return stripFencedIndent(source, columns, baseIndent);
  const removed = Math.min(columns, leadingSpaces(source));
  return source.slice(removed);
}

function markdownLines(value) {
  let source = String(value);
  if (source.includes('\r')) source = source.replace(/\r\n?/g, '\n');
  const rows = source.split('\n');
  if (rows[rows.length - 1] === '') rows.pop();
  return rows;
}

function replaceNewlines(source, replacement) {
  let rendered = '';
  let begin = 0;
  for (let newline = source.indexOf('\n'); newline >= 0; newline = source.indexOf('\n', begin)) {
    rendered += source.slice(begin, newline) + replacement;
    begin = newline + 1;
  }
  return rendered + source.slice(begin);
}

function parse(markdown) {
  const sourceLines = markdownLines(markdown);
  const references = Object.create(null);
  references[COLLECT_REFS] = true;
  if (String(markdown).includes(']:')) renderBlocks(sourceLines, references);
  references[COLLECT_REFS] = false;
  references[IN_RAW_LINK] = false;
  const rendered = renderBlocks(sourceLines, references);
  const omitFinalNewline = !String(markdown).endsWith('\n')
    && String(markdown).endsWith('</blockquote>')
    && rendered.endsWith('</blockquote>\n');
  return omitFinalNewline ? rendered.slice(0, -1) : rendered;
}

function saveReference(references, definition) {
  const key = normalizeLabel(definition.label);
  if (key.length === 0) return false;
  if (Object.hasOwn(references, key)) return true;
  references[key] = { url: definition.url, title: definition.title };
  return true;
}

function parseReferenceDefinition(lines, start, leading) {
  let row = start;
  let declaration = lines[row];
  let boundary = seekUnescapedSequence(declaration, ']:', leading + 1);
  for (; boundary < 0 && row + 1 < lines.length && !isBlank(lines[row + 1]);) {
    declaration += '\n' + lines[++row];
    boundary = seekUnescapedSequence(declaration, ']:', leading + 1);
  }
  if (boundary <= leading + 1) return null;
  const labelText = declaration.slice(leading + 1, boundary);
  if (seekUnescapedSequence(labelText, '[') >= 0 || seekUnescapedSequence(labelText, ']') >= 0) return null;

  let remainder = declaration.slice(boundary + 2);
  let address = '';
  let caption = '';
  let readAddress = false;
  for (;;) {
    remainder = trimAscii(remainder);
    if (address.length === 0) {
      if (remainder.length === 0) {
        if (row + 1 === lines.length || isBlank(lines[row + 1])) return null;
        remainder = lines[++row];
        continue;
      }
      const destination = readDefinitionAddress(remainder);
      if (destination === null) return null;
      address = destination.address;
      remainder = destination.tail;
      readAddress = true;
    }

    remainder = trimAscii(remainder);
    if (remainder.length > 0) {
      const parsedTitle = readDefinitionTitle(lines, row, remainder);
      if (parsedTitle === null) return null;
      caption = parsedTitle.caption;
      row = parsedTitle.lastRow;
      break;
    }
    if (row + 1 === lines.length || isBlank(lines[row + 1])) break;
    const candidate = trimAscii(lines[row + 1]);
    if (!beginsReferenceTitle(candidate)) break;
    const probeEnd = seekTitleDelimiter(candidate, 1, candidate[0]);
    if (probeEnd >= 0 && trimAscii(candidate.slice(probeEnd + 1))) break;
    remainder = lines[++row];
  }
  return readAddress ? { label: labelText, url: address, title: caption, next: row + 1 } : null;
}

function readDefinitionAddress(source) {
  if (source[0] === '<') {
    const limit = source.indexOf('>');
    if (limit < 0) return null;
    const enclosed = source.slice(0, limit);
    if (enclosed.includes('\r') || enclosed.includes('\n')) return null;
    const tail = source.slice(limit + 1);
    if (tail.length && !isSpace(tail[0])) return null;
    return { address: unescapePunctuation(source.slice(1, limit)), tail };
  }

  let cursor = 0;
  let parentheses = 0;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === '\\' && cursor + 1 < source.length) {
      cursor += 2;
      continue;
    }
    if (character === '(') parentheses++;
    else if (character === ')' && parentheses > 0) parentheses--;
    else if (parentheses === 0 && isSpace(character)) break;
    cursor++;
  }
  if (cursor === 0 || parentheses !== 0) return null;
  return { address: unescapePunctuation(source.slice(0, cursor)), tail: source.slice(cursor) };
}

function readDefinitionTitle(lines, row, source) {
  if (!beginsReferenceTitle(source)) return null;
  const delimiter = source[0] === '(' ? ')' : source[0];
  const pieces = [];
  let begin = 1;
  for (;;) {
    const limit = seekTitleDelimiter(source, begin, delimiter);
    if (limit >= 0) {
      if (trimAscii(source.slice(limit + 1))) return null;
      pieces.push(source.slice(begin, limit));
      return { caption: unescapePunctuation(pieces.join('\n')), lastRow: row };
    }
    pieces.push(source.slice(begin));
    if (row + 1 === lines.length || isBlank(lines[row + 1])) return null;
    source = lines[++row];
    begin = 0;
  }
}

function leadingSpaces(source) {
  let length = 0;
  while (source.charCodeAt(length) === 32 || source.charCodeAt(length) === 9) length++;
  return length;
}

function seekUnescapedSequence(source, sequence, from = 0) {
  let match = source.indexOf(sequence, from);
  while (match !== -1) {
    let backslashes = 0;
    let preceding = match;
    while (preceding > 0 && source.charCodeAt(--preceding) === 92) backslashes++;
    if (backslashes % 2 === 0) return match;
    match = source.indexOf(sequence, match + sequence.length);
  }
  return -1;
}

function beginsReferenceTitle(source) {
  const code = source.charCodeAt(0);
  return code === 40 || code === 34 || code === 39;
}

function seekTitleDelimiter(source, from, delimiter) {
  let cursor = from;
  while (cursor < source.length) {
    if (source[cursor] === '\\' && cursor + 1 < source.length) cursor += 2;
    else if (source[cursor] === delimiter) return cursor;
    else cursor++;
  }
  return -1;
}

function unescapePunctuation(source) {
  let rendered = '';
  let begin = 0;
  let backslash = source.indexOf('\\');
  while (backslash !== -1) {
    if (backslash + 1 < source.length && PUNCT.includes(source[backslash + 1])) {
      rendered += source.slice(begin, backslash) + source[backslash + 1];
      begin = backslash + 2;
      backslash = source.indexOf('\\', begin);
    } else backslash = source.indexOf('\\', backslash + 1);
  }
  return begin === 0 ? source : rendered + source.slice(begin);
}

function renderBlocks(rows, references, withinItem = false, parentColumn = 0, compact = false, insideQuote = false) {
  const definitionsOnly = references[COLLECT_REFS];
  if (definitionsOnly && !hasReferenceSyntax(rows)) return '';
  const fragments = [];
  let cursor = 0;
  while (cursor < rows.length) {
    const source = rows[cursor];
    if (isBlank(source)) {
      cursor++;
      continue;
    }
    const margin = leadingSpaces(source);
    const first = source.charCodeAt(margin);
    if (first === 91 && !isIndentedCode(source)) {
      const definition = parseReferenceDefinition(rows, cursor, margin);
      if (definition && saveReference(references, definition)) {
        cursor = definition.next;
        continue;
      }
    }
    if ((first === 95 || first === 45 || first === 42) && isThematic(source)) {
      if (!definitionsOnly) fragments.push('<hr>\n');
      cursor++;
      continue;
    }
    const marker = first === 43 || first === 45 || first === 42 || isDigit(first) ? listStart(source) : null;
    if (marker) {
      const listResult = renderList(rows, cursor, references, marker, parentColumn);
      fragments.push(listResult.html);
      cursor = listResult.next;
      continue;
    }
    if (cursor + 1 < rows.length && source.includes('|') && isTableDelimiter(rows[cursor + 1])) {
      const tableResult = renderTable(rows, cursor, references);
      if (tableResult) {
        fragments.push(tableResult.html);
        cursor = tableResult.next;
        continue;
      }
    }
    if (first === 60 && isHtmlBlockStart(source)) {
      const htmlRegion = takeHtmlBlock(rows, cursor, definitionsOnly, insideQuote);
      fragments.push(htmlRegion.html);
      cursor = htmlRegion.next;
      continue;
    }
    const opening = first === 126 || first === 96 ? fenceStart(source) : null;
    if (opening) {
      const codeRegion = takeFencedCode(rows, cursor, opening, parentColumn, definitionsOnly);
      fragments.push(codeRegion.html);
      cursor = codeRegion.next;
      continue;
    }
    if (isIndentedCode(source)) {
      const codeRegion = takeIndentedCode(rows, cursor, parentColumn, definitionsOnly);
      fragments.push(codeRegion.html);
      cursor = codeRegion.next;
      continue;
    }
    const heading = first === 35 ? atxHeading(source) : null;
    if (heading) {
      if (!definitionsOnly) fragments.push(blockHeadingHtml(heading.level, heading.text, references));
      cursor++;
      continue;
    }
    if (first !== 62 && cursor + 1 < rows.length) {
      const underline = setextLevel(rows[cursor + 1]);
      if (underline) {
        if (!definitionsOnly) fragments.push(blockHeadingHtml(underline, trimAscii(source), references));
        cursor += 2;
        continue;
      }
    }
    if (first === 62 && quoteLine(source) !== null) {
      const quoteRegion = takeBlockQuote(rows, cursor, references, withinItem, definitionsOnly);
      fragments.push(quoteRegion.html);
      cursor = quoteRegion.next;
      continue;
    }
    const paragraph = takeParagraph(rows, cursor, withinItem);
    cursor = paragraph.next;
    if (definitionsOnly) continue;
    const content = paragraph.content.join('\n');
    if (paragraph.level) {
      fragments.push(blockHeadingHtml(paragraph.level, trimAscii(content), references));
    } else {
      const body = renderInline(content, references);
      fragments.push(compact ? body : '<p>' + body + '</p>\n');
    }
  }
  return fragments.join('');
}

function takeParagraph(rows, start, withinItem) {
  const captured = [rows[start]];
  let cursor = start + 1;
  let underline = 0;
  while (cursor < rows.length && !isBlank(rows[cursor])) {
    const source = rows[cursor];
    underline = setextLevel(source);
    if (underline) {
      cursor++;
      break;
    }
    if (trimAscii(source).toLowerCase() === '</pre>') {
      captured.push(source);
      cursor++;
      continue;
    }
    if (isIndentedCode(source)) {
      const preceding = captured[captured.length - 1];
      if (preceding.endsWith('  ') || preceding.endsWith('\\')) {
        captured.push(source.trimStart());
        cursor++;
        continue;
      }
      if (!isBlank(rows[cursor - 1])) {
        captured.push(source);
        cursor++;
        continue;
      }
    }
    const followedByUnderline = cursor + 1 < rows.length && setextLevel(rows[cursor + 1]);
    if (startsParagraphBlock(rows, cursor, withinItem) && !isIndentedUnderline(source) && !followedByUnderline) break;
    captured.push(source);
    cursor++;
  }
  return { next: cursor, level: underline, content: captured };
}

function blockHeadingHtml(level, source, references) {
  return '<h' + level + '>' + renderInline(source, references) + '</h' + level + '>\n';
}

function takeFencedCode(rows, start, opening, parentColumn, definitionsOnly) {
  const captured = definitionsOnly ? null : [];
  const margin = opening.ch === '~' ? 0 : opening.indent;
  let cursor = start + 1;
  for (; cursor < rows.length && !fenceEnd(rows[cursor], opening); cursor++) {
    if (captured) captured.push(stripFenceContent(rows[cursor], margin, parentColumn));
  }
  if (cursor < rows.length) cursor++;
  if (captured === null) return { next: cursor, html: '' };

  let languageEnd = 0;
  while (languageEnd < opening.info.length && opening.info[languageEnd] !== '\t' && opening.info[languageEnd] !== ' ') languageEnd++;
  const language = opening.info.slice(0, languageEnd);
  const attribute = language.length ? ' class="language-' + escapeHtml(unescapePunctuation(language)) + '"' : '';
  let body = captured.join('\n');
  if (captured.length > 0 && captured[captured.length - 1] !== '') body += '\n';
  return { next: cursor, html: '<pre><code' + attribute + '>' + escapeHtml(body, true) + '</code></pre>\n' };
}

function takeIndentedCode(rows, start, parentColumn, definitionsOnly) {
  const captured = definitionsOnly ? null : [];
  let cursor = start;
  while (cursor < rows.length) {
    const source = rows[cursor];
    const blank = isBlank(source);
    if (!blank && !isIndentedCode(source)) break;
    if (captured) captured.push(blank ? stripIndent(source, 4) : stripIndent(source, 4, !parentColumn));
    cursor++;
  }
  if (captured === null) return { next: cursor, html: '' };
  while (captured.length > 0 && captured[captured.length - 1] === '') captured.pop();
  const body = escapeHtml(captured.join('\n') + '\n', true);
  return { next: cursor, html: '<pre><code>' + body + '</code></pre>\n' };
}

function takeHtmlBlock(rows, start, definitionsOnly, insideQuote) {
  const kind = htmlBlockTag(rows[start]);
  const explicitEnd = kind === '!--' || kind === '?' || kind === '![CDATA['
    || kind === 'script' || kind === 'style' || kind === 'pre' || kind === 'textarea';
  const captured = definitionsOnly ? null : [rows[start]];
  let cursor = start + 1;
  let blankTerminated = false;
  if (explicitEnd) {
    if (!htmlBlockEnd(rows[start], kind)) {
      while (cursor < rows.length) {
        const source = rows[cursor++];
        if (captured) captured.push(source);
        if (htmlBlockEnd(source, kind)) break;
      }
    }
  } else {
    for (; cursor < rows.length && !isBlank(rows[cursor]); cursor++) {
      if (captured) captured.push(rows[cursor]);
    }
    blankTerminated = cursor < rows.length;
  }

  let addNewline = !blankTerminated;
  if (explicitEnd && cursor < rows.length && isBlank(rows[cursor])) {
    addNewline = false;
    do {
      if (rows[cursor].length > 0) addNewline = true;
      cursor++;
    } while (cursor < rows.length && isBlank(rows[cursor]));
  }
  if (insideQuote && !explicitEnd && cursor === rows.length) addNewline = false;
  return { next: cursor, html: captured ? captured.join('\n') + (addNewline ? '\n' : '') : '' };
}

function takeBlockQuote(rows, start, references, withinItem, definitionsOnly) {
  const captured = [];
  let cursor = start;
  let openFence = null;
  let lastMarkedBlank = false;
  while (cursor < rows.length) {
    const source = rows[cursor];
    const content = quoteLine(source);
    if (content !== null) {
      let column = quotePrefixWidth(source);
      let marker = 0;
      while (marker < 3 && source[marker] === ' ') marker++;
      if (source[marker + 1] === '\t') column++;
      captured.push(quoteLine(content) === null ? expandQuotedTabs(content, column) : content);
      lastMarkedBlank = isBlank(content);
      if (openFence === null) openFence = fenceStart(content);
      else if (fenceEnd(content, openFence)) openFence = null;
      cursor++;
      continue;
    }
    if (openFence || lastMarkedBlank) break;
    if (isIndentedCode(source) && captured.length > 0 && listStart(source.trimStart())) {
      captured.push('\\' + source.trimStart());
      cursor++;
      continue;
    }
    if (!quoteAcceptsLazyLine(source)) break;
    captured.push((setextLevel(source) ? '    ' : '') + source);
    cursor++;
  }

  const finalRow = captured[captured.length - 1];
  if (captured.length > 1 && finalRow.length > 0 && isBlank(finalRow)) {
    captured.pop();
    captured[captured.length - 1] += '\n' + finalRow;
  }
  let body = renderBlocks(captured, references, withinItem, quotePrefixWidth(rows[start]), false, true);
  if (definitionsOnly) return { next: cursor, html: '' };
  if (captured.length && isHtmlBlockStart(captured[0]) && !captured.some(isBlank) && body.endsWith('\n')) {
    body = body.slice(0, -1);
  }
  return { next: cursor, html: '<blockquote>\n' + body + '</blockquote>\n' };
}

function quoteAcceptsLazyLine(source) {
  return !isBlank(source) && !isThematic(source) && !fenceStart(source)
    && !listStart(source) && !atxHeading(source) && !isIndentedCode(source)
    && (!isHtmlBlockStart(source) || isStandaloneInlineTag(source));
}

function quotePrefixWidth(source) {
  let marker = 0;
  while (marker < 3 && source[marker] === ' ') marker++;
  if (source[marker] !== '>') return 0;
  return marker + (source[marker + 1] === ' ' ? 2 : 1);
}

function quoteLine(source) {
  const width = quotePrefixWidth(source);
  return width > 0 ? source.slice(width) : null;
}

function expandQuotedTabs(source, initialColumn) {
  if (!source.includes('\t')) return source;
  let rendered = '';
  let column = initialColumn;
  for (let cursor = 0; cursor < source.length; cursor++) {
    const width = source[cursor] === '\t' ? 4 - column % 4 : 1;
    rendered += source[cursor] === '\t' ? ' '.repeat(width) : source[cursor];
    column += width;
  }
  return rendered;
}

function isIndentedCode(source) {
  return indentColumns(source) >= 4;
}

function fenceEnd(source, opening) {
  let margin = 0;
  while (source[margin] === ' ') margin++;
  if (margin > 3) return false;
  let limit = margin;
  while (source[limit] === opening.ch) limit++;
  if (limit - margin < opening.size) return false;
  return isBlank(source.slice(limit));
}

function fenceStart(source) {
  let margin = 0;
  while (margin < 4 && source[margin] === ' ') margin++;
  const delimiter = source[margin];
  if (margin === 4 || (delimiter !== '~' && delimiter !== '`')) return null;
  let limit = margin;
  do { limit++; } while (source[limit] === delimiter);
  const length = limit - margin;
  if (length < 3) return null;
  const annotation = source.slice(limit).trim();
  if (delimiter === '`' && annotation.includes('`')) return null;
  return { ch: delimiter, size: length, info: annotation, indent: margin };
}

function isThematic(source) {
  if (isIndentedCode(source)) return false;
  let marker;
  let repetitions = 0;
  for (const character of source) {
    if (character === '\t' || character === ' ') continue;
    if (marker === undefined) {
      if (character !== '*' && character !== '-' && character !== '_') return false;
      marker = character;
    }
    if (character !== marker) return false;
    repetitions++;
  }
  return repetitions >= 3;
}

function isIndentedUnderline(source) {
  if (!isIndentedCode(source)) return false;
  const body = trimAscii(source);
  if (body.length < 3 || (body[0] !== '=' && body[0] !== '-')) return false;
  let cursor = body.length;
  while (--cursor > 0) if (body[cursor] !== body[0]) return false;
  return true;
}

function setextLevel(source) {
  if (isIndentedCode(source)) return 0;
  let cursor = leadingSpaces(source);
  const marker = source[cursor];
  if (marker !== '-' && marker !== '=') return 0;
  do { cursor++; } while (source[cursor] === marker);
  if (!isBlank(source.slice(cursor))) return 0;
  return marker === '-' ? 2 : 1;
}

function atxHeading(source) {
  let margin = 0;
  while (margin < 3 && source[margin] === ' ') margin++;
  let first = margin;
  while (source[first] === '#') first++;
  const level = first - margin;
  if (level < 1 || level > 6) return null;
  if (first < source.length && source[first] !== ' ' && source[first] !== '\t') return null;

  first += leadingSpaces(source.slice(first));
  let last = source.length;
  while (last > first && (source[last - 1] === '\t' || source[last - 1] === ' ')) last--;
  let hashes = last;
  while (hashes > first && source[hashes - 1] === '#') hashes--;
  const separated = hashes === first || source[hashes - 1] === ' ' || source[hashes - 1] === '\t';
  if (hashes < last && separated) {
    last = hashes;
    while (last > first && (source[last - 1] === '\t' || source[last - 1] === ' ')) last--;
  }
  return { level, text: source.slice(first, last) };
}

function startsBlock(rows, row) {
  const source = rows[row];
  if (isIndentedCode(source)) return true;
  const first = source.charCodeAt(leadingSpaces(source));
  switch (first) {
    case 35:
      if (atxHeading(source)) return true;
      break;
    case 96: case 126:
      if (fenceStart(source)) return true;
      break;
    case 42: case 45: case 95:
      if (isThematic(source)) return true;
      if (first !== 95 && listStart(source)) return true;
      break;
    case 43:
      if (listStart(source)) return true;
      break;
    case 62:
      if (quoteLine(source) !== null) return true;
      break;
    case 60:
      if (isHtmlBlockStart(source)) return true;
      break;
    default:
      if (isDigit(first) && listStart(source)) return true;
  }
  return row + 1 < rows.length && setextLevel(rows[row + 1]);
}

function startsParagraphBlock(rows, row, inListItem = false) {
  const source = rows[row];
  const first = source.charCodeAt(leadingSpaces(source));
  const candidate = first === 43 || first === 45 || first === 42 || isDigit(first) ? listStart(source) : null;
  if (candidate && source.slice(candidate.contentIndent).trim().length === 0) return false;
  if (first === 60 && isStandaloneInlineTag(source)) return false;
  if (!inListItem && candidate && candidate.ordered && candidate.start !== 1) {
    return atxHeading(source) || fenceStart(source) || isThematic(source)
      || quoteLine(source) !== null || isIndentedCode(source) || isHtmlBlockStart(source);
  }
  return startsBlock(rows, row);
}

function listStart(source) {
  let margin = 0;
  while (margin < 4 && source[margin] === ' ') margin++;
  if (margin === 4) return null;

  const bullet = source[margin] === '+' || source[margin] === '-' || source[margin] === '*';
  let separator = margin;
  if (!bullet) {
    while (separator < source.length && isDigit(source.charCodeAt(separator))) separator++;
    const digits = separator - margin;
    if (digits < 1 || digits > 9 || (source[separator] !== ')' && source[separator] !== '.')) return null;
  }
  const afterMarker = separator + 1;
  if (afterMarker < source.length && source[afterMarker] !== '\t' && source[afterMarker] !== ' ') return null;
  const gap = leadingSpaces(source.slice(afterMarker));
  const padding = gap > 4 ? 1 : gap;
  const bulletTab = bullet && source[afterMarker] === '\t';
  const delimiter = source[separator];
  return {
    indent: margin,
    ordered: !bullet,
    marker: delimiter,
    delimiter,
    start: bullet ? 1 : Number(source.slice(margin, separator)),
    width: bulletTab ? afterMarker : afterMarker + (padding || gap),
    contentIndent: bulletTab ? margin + 2 : afterMarker + (padding || 1)
  };
}

function listIndentCompatible(opening, candidate) {
  if (candidate.indent >= opening.indent) return true;
  return opening.indent <= 3 && candidate.indent <= 3;
}

function matchesList(opening, candidate) {
  return candidate && candidate.ordered === opening.ordered
    && candidate.delimiter === opening.delimiter && listIndentCompatible(opening, candidate);
}

function renderList(rows, start, references, opening, parentColumn = 0) {
  const entries = [];
  let cursor = start;
  let separated = false;
  while (cursor < rows.length) {
    const source = rows[cursor];
    if (isThematic(source)) break;
    const previous = entries[entries.length - 1];
    if (previous && opening.indent === 0 && indentColumns(source) >= 4 && !previous.blockAfterBlank) {
      const unindented = source.trimStart();
      if (listStart(unindented)) {
        previous.push((indentColumns(source) < previous.contentIndent ? '\\' : '') + unindented);
        cursor++;
        continue;
      }
    }
    const marker = listStart(source);
    if (!matchesList(opening, marker)) break;
    if (previous && marker.indent >= 4 && (opening.indent === 0 || marker.indent - opening.indent < 2)) {
      previous.push(source.trimStart());
      cursor++;
      continue;
    }
    if (previous && marker.indent > opening.indent && marker.indent >= previous.contentIndent) break;
    const entry = [source.slice(marker.width)];
    Object.assign(entry, {
      contentIndent: marker.contentIndent,
      baseIndent: parentColumn + marker.contentIndent,
      nestedContentIndent: marker.contentIndent,
      nestedMarkerIndent: Infinity,
      hasNestedMarker: false
    });
    entries.push(entry);
    const continuation = extendListEntry(rows, cursor + 1, entry, opening, parentColumn);
    cursor = continuation.next;
    if (continuation.loose) separated = true;
  }
  return { next: cursor, html: renderListEntries(entries, references, opening, separated) };
}

function extendListEntry(rows, start, entry, opening, parentColumn) {
  let cursor = start;
  let separated = false;
  let openFence = fenceStart(entry[0]);
  let fenceNeedsContent = Boolean(openFence);
  while (cursor < rows.length) {
    const source = rows[cursor];
    if (isBlank(source)) {
      if (openFence) {
        entry.push('');
        cursor++;
        continue;
      }
      const gap = listBlankGap(rows, cursor, entry, opening);
      cursor = gap.next;
      if (gap.loose) separated = true;
      if (gap.stop) break;
      continue;
    }

    const margin = indentColumns(source);
    if (openFence) {
      const indented = margin >= entry.contentIndent;
      const content = indented ? stripFencedIndent(source, entry.contentIndent, parentColumn) : source;
      if (fenceEnd(content, openFence)) {
        openFence = null;
      } else {
        if (fenceNeedsContent && !indented) break;
        fenceNeedsContent = false;
      }
      entry.push(content);
      cursor++;
      continue;
    }
    if (isThematic(source) && margin < entry.contentIndent) break;
    const marker = listStart(source);
    if (source[0] === '\t' && listStart(source.trimStart())) {
      entry.hasNestedMarker = true;
      entry.push(stripIndent(source, entry.contentIndent));
      cursor++;
      continue;
    }
    if (matchesList(opening, marker) && marker.indent < entry.contentIndent) break;
    if (marker && marker.indent >= entry.contentIndent) {
      if (opening.indent === 3 && marker.indent === entry.contentIndent) {
        entry.push(source.trimStart());
        cursor++;
        continue;
      }
      noteNestedMarker(entry, marker.indent, marker.contentIndent);
    }
    if (margin >= entry.contentIndent) {
      let content = stripIndent(source, entry.contentIndent);
      if (content[0] === '\t') content = ' ' + content.slice(1);
      if (source.startsWith('\t\t') && entry.contentIndent < 4) content = '      ' + source.trimStart();
      openFence = fenceStart(content);
      fenceNeedsContent = Boolean(openFence);
      const nested = listStart(content);
      if (!openFence && nested) {
        noteNestedMarker(entry, entry.contentIndent + nested.indent, entry.contentIndent + nested.contentIndent);
      }
      entry.push(content);
    } else {
      const indentedContinuation = isIndentedCode(source)
        && (margin < opening.indent + 4 || !listStart(source.trimStart()));
      if (startsBlock(rows, cursor) && !indentedContinuation) break;
      entry.push(entry[0] && margin < 4 ? source : source.trimStart());
    }
    cursor++;
  }
  return { next: cursor, loose: separated };
}

function noteNestedMarker(entry, margin, contentColumn) {
  entry.hasNestedMarker = true;
  if (margin > entry.nestedMarkerIndent) return;
  entry.nestedMarkerIndent = margin;
  entry.nestedContentIndent = contentColumn;
}

function renderListEntries(entries, references, opening, separated) {
  const element = opening.ordered ? 'ol' : 'ul';
  const startAttribute = opening.ordered && opening.start !== 1 ? ' start="' + opening.start + '"' : '';
  const fragments = ['<' + element + startAttribute + '>\n'];
  for (const entry of entries) {
    if (references[COLLECT_REFS] && !hasReferenceSyntax(entry)) continue;
    while (entry.length > 0 && isBlank(entry[0])) entry.shift();
    while (entry.length > 0 && isBlank(entry[entry.length - 1])) entry.pop();

    let checkbox = '';
    if (entry.length > 0) {
      const prefix = entry[0].slice(0, 4);
      if (prefix === '[ ] ' || prefix === '[x] ' || prefix === '[X] ') {
        checkbox = '<input ' + (prefix[1] === ' ' ? '' : 'checked="" ') + 'disabled="" type="checkbox"> ';
        entry[0] = entry[0].slice(4);
      }
    }
    let body = separated
      ? renderBlocks(entry, references, true, entry.baseIndent)
      : tightListItem(entry, references, entry.baseIndent);
    if (entry.length === 1 && isHtmlBlockStart(entry[0]) && body.endsWith('\n')) body = body.slice(0, -1);
    if (checkbox) body = separated ? body.replace('<p>', '<p>' + checkbox) : checkbox + body;
    fragments.push('<li>' + body + '</li>\n');
  }
  fragments.push('</' + element + '>\n');
  return fragments.join('');
}

function listBlankGap(rows, start, entry, opening) {
  let next = start;
  while (next < rows.length && isBlank(rows[next])) next++;
  const following = next < rows.length ? rows[next] : null;
  const marker = following === null ? null : listStart(following);
  const margin = following === null ? -1 : indentColumns(following);

  if (opening.indent === 0 && margin >= 4 && margin < entry.contentIndent && listStart(following.trimStart())) {
    entry.blockAfterBlank = true;
    return { next, stop: true, loose: false };
  }
  if (matchesList(opening, marker) && marker.indent < entry.contentIndent) {
    for (let row = start; row < next; row++) entry.push('');
    return { next, stop: true, loose: true };
  }
  if (marker && marker.indent >= entry.contentIndent && !entry.hasNestedMarker) {
    entry.push('');
    return { next, stop: false, loose: true };
  }
  if (!marker && following !== null && margin >= entry.contentIndent) {
    const nested = listStart(following.trimStart());
    if (nested) {
      const newlyNested = !entry.hasNestedMarker;
      if (newlyNested) {
        entry.hasNestedMarker = true;
        entry.nestedContentIndent = margin + nested.contentIndent;
      }
      entry.push('');
      return { next, stop: false, loose: newlyNested };
    }
  }
  if (following !== null && margin >= entry.contentIndent && entry[0] !== '') {
    for (let row = start; row < next; row++) entry.push('');
    const threshold = entry.hasNestedMarker ? entry.nestedContentIndent : entry.contentIndent + 4;
    const loose = !listStart(following.trimStart())
      && (margin < threshold || (isIndentedCode(following) && !entry.hasNestedMarker));
    return { next, stop: false, loose };
  }
  entry.blockAfterBlank = true;
  return { next, stop: true, loose: false };
}

function hasReferenceSyntax(rows) {
  for (const source of rows) if (source.indexOf(']:') !== -1) return true;
  return false;
}

function tightListItem(rows, references, parentColumn) {
  if (rows.length === 0 || (references[COLLECT_REFS] && !hasReferenceSyntax(rows))) return '';
  const fragments = [];
  let cursor = 0;
  while (cursor < rows.length) {
    const source = rows[cursor];
    if (isBlank(source)) {
      cursor++;
      continue;
    }
    const margin = leadingSpaces(source);
    if (!isIndentedCode(source) && source[margin] === '[') {
      const definition = parseReferenceDefinition(rows, cursor, margin);
      if (definition) {
        cursor = definition.next;
        continue;
      }
    }
    const heading = atxHeading(source);
    if (heading) {
      const body = renderInline(heading.text, references);
      fragments.push('<h' + heading.level + '>' + body + '</h' + heading.level + '>\n');
      cursor++;
      continue;
    }
    if (listItemBlockBoundary(rows, cursor)) {
      fragments.push(renderBlocks(rows.slice(cursor), references, true, parentColumn, true));
      break;
    }

    const paragraph = [rows[cursor++]];
    let underline = 0;
    for (; cursor < rows.length && !isBlank(rows[cursor]); cursor++) {
      underline = setextLevel(rows[cursor]);
      if (underline) {
        cursor++;
        break;
      }
      if (listItemBlockBoundary(rows, cursor)) break;
      paragraph.push(rows[cursor]);
    }
    const body = renderInline(paragraph.join('\n'), references);
    fragments.push(underline ? '<h' + underline + '>' + body + '</h' + underline + '>\n' : body);
  }
  return fragments.join('');
}

function listItemBlockBoundary(rows, row) {
  return startsBlock(rows, row) && !(row + 1 < rows.length && setextLevel(rows[row + 1]));
}

const BLOCK_TAG_NAMES = new Set([
  'html', 'head', 'body', 'title', 'base', 'basefont', 'link',
  'header', 'footer', 'main', 'nav', 'section', 'article', 'aside', 'address',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'p', 'hr', 'pre', 'div', 'center',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'dir', 'menu', 'menuitem',
  'table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td',
  'details', 'summary', 'dialog', 'figure', 'figcaption', 'form', 'fieldset', 'legend',
  'iframe', 'script', 'style', 'textarea', 'picture', 'source', 'track'
]);

function htmlNameLimit(source, begin) {
  let cursor = begin;
  while (isAlpha(source.charCodeAt(cursor)) || isDigit(source.charCodeAt(cursor)) || source[cursor] === '-') cursor++;
  return cursor;
}

function isHtmlBlockStart(source) {
  if (indentColumns(source) > 3) return false;
  const tag = source.trimStart();
  if (tag[0] !== '<') return false;
  if (tag.startsWith('<!') || tag.startsWith('<?')) return true;
  const begin = tag[1] === '/' ? 2 : 1;
  if (!isAlpha(tag.charCodeAt(begin))) return false;
  const limit = htmlNameLimit(tag, begin + 1);
  const boundary = tag[limit];
  if (boundary && boundary !== ' ' && boundary !== '\t' && boundary !== '>' && boundary !== '/') return false;
  const name = tag.slice(begin, limit).toLowerCase();
  return BLOCK_TAG_NAMES.has(name) || completeHtmlTag(tag);
}

function isStandaloneInlineTag(source, name = '', end = -1) {
  const tag = source.trimStart();
  if (tag[0] !== '<') return false;
  if (end < 0) {
    const begin = tag[1] === '/' ? 2 : 1;
    const limit = htmlNameLimit(tag, begin);
    if (limit === begin) return false;
    name = tag.slice(begin, limit).toLowerCase();
  }
  return completeHtmlTag(tag) && !BLOCK_TAG_NAMES.has(name);
}

function tagWhitespaceLimit(source, begin, allowNewline) {
  let cursor = begin;
  while (source[cursor] === ' ' || source[cursor] === '\t' || (allowNewline && source[cursor] === '\n')) cursor++;
  return cursor;
}

function completeHtmlTag(source) {
  const last = source.length - 1;
  if (source[last] !== '>') return false;
  const closing = source[1] === '/';
  let cursor = closing ? 2 : 1;
  const begin = cursor;
  while (cursor < last && isAlpha(source.charCodeAt(cursor))) cursor++;
  if (cursor === begin) return false;
  if (closing) return cursor === last;

  while (cursor < last) {
    cursor = tagWhitespaceLimit(source, cursor, true);
    if (cursor >= last) return true;
    if (source[cursor] === '/') return cursor + 1 === last;
    const attributeStart = cursor;
    while (cursor < last && isAlpha(source.charCodeAt(cursor))) cursor++;
    if (attributeStart === cursor) return false;
    cursor = tagWhitespaceLimit(source, cursor, true);
    if (cursor < last && source[cursor] !== '=') return false;
    cursor = tagWhitespaceLimit(source, cursor + 1, false);

    const quote = source[cursor];
    if (quote === "'" || quote === '"') {
      const quoteEnd = source.indexOf(quote, cursor + 1);
      if (quoteEnd === -1) return false;
      cursor = quoteEnd + 1;
      if (cursor < last && source[cursor] !== '/' && tagWhitespaceLimit(source, cursor, true) === cursor) return false;
    } else {
      const valueStart = cursor;
      while (cursor < last && source[cursor] !== ' ' && source[cursor] !== '\t' && source[cursor] !== '>') cursor++;
      if (valueStart === cursor) return false;
    }
  }
  return true;
}

function htmlBlockEnd(source, kind) {
  switch (kind) {
    case '?': return source.indexOf('?>') !== -1;
    case '!--': return source.indexOf('-->') !== -1;
    case '![CDATA[': return source.indexOf(']]>') !== -1;
    default: return source.toLowerCase().indexOf('</' + kind + '>') !== -1;
  }
}

function htmlBlockTag(source) {
  const tag = source.trimStart();
  if (tag[0] !== '<') return null;
  if (tag.startsWith('<!--')) return '!--';
  if (tag.startsWith('<![CDATA[')) return '![CDATA[';
  if (tag[1] === '?') return '?';
  const begin = tag[1] === '/' ? 2 : 1;
  if (!isAlpha(tag.charCodeAt(begin))) return null;
  return tag.slice(begin, htmlNameLimit(tag, begin + 1)).toLowerCase();
}

function isInlineHtml(source) {
  if (source[0] === '!' || source[0] === '?') return true;
  const closing = source[0] === '/';
  const begin = closing ? 1 : 0;
  if (!isAlpha(source.charCodeAt(begin))) return false;
  let cursor = htmlNameLimit(source, begin + 1);
  if (closing) return cursor === source.length;
  if (cursor < source.length && source[cursor] !== '/' && !isSpace(source[cursor])) return false;
  if (source.includes('\n')) return multilineInlineTag(source, cursor);

  while (cursor < source.length && isSpace(source[cursor])) cursor++;
  if (cursor === source.length) return true;
  if (source[cursor] === '/') return cursor + 1 === source.length;
  while (cursor < source.length) {
    const attributeStart = cursor;
    while (cursor < source.length && !isSpace(source[cursor]) && source[cursor] !== '=') {
      const code = source.charCodeAt(cursor);
      const punctuation = source[cursor] === '_' || source[cursor] === ':' || source[cursor] === '.' || source[cursor] === '-';
      if (!isAlpha(code) && !isDigit(code) && !punctuation) return false;
      cursor++;
    }
    if (cursor === attributeStart) return false;
    if (cursor === source.length) return true;
    if (source[cursor] !== '=') {
      if (!isSpace(source[cursor])) return false;
      do { cursor++; } while (cursor < source.length && isSpace(source[cursor]));
      if (cursor === source.length) return true;
      if (source[cursor] === '/') return cursor + 1 === source.length;
      continue;
    }

    cursor = tagWhitespaceLimit(source, cursor + 1, false);
    const quote = source[cursor];
    if (quote === '"' || quote === "'") {
      const quoteEnd = source.indexOf(quote, cursor + 1);
      if (quoteEnd < 0) return false;
      cursor = quoteEnd + 1;
    } else {
      const valueStart = cursor;
      for (; cursor < source.length && !isSpace(source[cursor]); cursor++) {
        if (source[cursor] === '<' || source[cursor] === '>' || source[cursor] === '`') return false;
      }
      if (cursor === valueStart) return false;
    }
    const valueEnd = cursor;
    while (cursor < source.length && isSpace(source[cursor])) cursor++;
    if (cursor < source.length) {
      if (source[cursor] === '/') return cursor + 1 === source.length;
      if (cursor === valueEnd) return false;
    }
  }
  return true;
}

function multilineInlineTag(source, nameEnd) {
  let quoteParity = 0;
  for (const character of source) {
    if (character === '"' || character === "'") quoteParity ^= 1;
  }
  if (quoteParity || (source.slice(0, nameEnd).toLowerCase() === 'a' && source.includes('href='))) return true;
  const firstNewline = source.indexOf('\n', nameEnd);
  if (!source.slice(nameEnd, firstNewline).trim()) return true;
  const rows = source.split('\n');
  for (let row = 1; row < rows.length; row++) {
    const attribute = rows[row].trim();
    if (attribute && attribute !== '/' && !attribute.startsWith('_') && !attribute.includes('=')) return false;
  }
  return !source.includes('#') && !source.includes('*');
}

function isAutolink(source) {
  const colon = angleSchemeColon(source);
  if (colon < 0) return angleEmailAddress(source);
  for (let cursor = colon + 1; cursor < source.length; cursor++) {
    if (source[cursor] === '<' || source[cursor] === '>' || isSpace(source[cursor])) return false;
  }
  return true;
}

function angleSchemeColon(source) {
  if (!isAlpha(source.charCodeAt(0))) return -1;
  let cursor = 1;
  while (cursor < source.length && cursor < 33) {
    const character = source[cursor];
    if (character === ':') return cursor >= 2 ? cursor : -1;
    const code = source.charCodeAt(cursor);
    if (!isAlpha(code) && !isDigit(code) && character !== '.' && character !== '-' && character !== '+') break;
    cursor++;
  }
  return -1;
}

function angleEmailAddress(source) {
  const at = source.lastIndexOf('@');
  if (at < 1 || at + 1 === source.length) return false;
  let cursor = 0;
  for (; cursor < at; cursor++) {
    const code = source.charCodeAt(cursor);
    if (!(isAlpha(code) || isDigit(code) || EMAIL_LOCAL[code])) return false;
  }
  let lastDot = -1;
  for (cursor = at + 1; cursor < source.length; cursor++) {
    const code = source.charCodeAt(cursor);
    if (code === 46) {
      if (cursor === at + 1 || cursor === source.length - 1) return false;
      lastDot = cursor;
    } else if (!(code === 45 || isDigit(code) || isAlpha(code))) return false;
  }
  if (lastDot < 0 || source.length - lastDot < 3) return false;
  for (cursor = lastDot + 1; cursor < source.length; cursor++) {
    if (!isAlpha(source.charCodeAt(cursor))) return false;
  }
  return true;
}

function isTableDelimiter(source) {
  const fields = splitTableFields(source);
  return fields.length > 0 && fields.every(tableSeparatorValid);
}

function tableSeparatorValid(field) {
  let begin = 0;
  let limit = field.length;
  while (field[begin] === ' ') begin++;
  while (limit > begin && field[limit - 1] === ' ') limit--;
  let cursor = field[begin] === ':' ? begin + 1 : begin;
  const dashStart = cursor;
  while (field[cursor] === '-') cursor++;
  if (cursor === dashStart) return false;
  if (field[cursor] === ':') cursor++;
  return cursor === limit;
}

function renderTable(rows, start, references) {
  if (!rows[start].includes('|') || !rows[start + 1].includes('|')) return null;
  const headings = splitTableFields(rows[start]);
  const separators = splitTableFields(rows[start + 1]);
  if (headings.length === 0 || headings.length !== separators.length) return null;

  let row = start + 2;
  if (references[COLLECT_REFS]) {
    while (row < rows.length && tableRowContinues(rows, row)) row++;
    return { html: '', next: row };
  }

  const alignments = separators.map(tableAlignmentAttribute);
  const output = ['<table>\n<thead>\n'];
  emitTableRow(output, headings, alignments, 'th', references);
  output.push('</thead>\n');
  let bodyRows = 0;
  while (row < rows.length && tableRowContinues(rows, row)) {
    if (bodyRows === 0) output.push('<tbody>');
    emitTableRow(output, splitTableFields(rows[row]), alignments, 'td', references);
    row++;
    bodyRows++;
  }
  if (bodyRows > 0) output.push('</tbody>');
  output.push('</table>\n');
  return { html: output.join(''), next: row };
}

function tableAlignmentAttribute(source) {
  const marker = source.trim();
  const hasLeftColon = marker[0] === ':';
  const hasRightColon = marker[marker.length - 1] === ':';
  if (hasLeftColon && hasRightColon) return ' align="center"';
  if (hasLeftColon) return ' align="left"';
  return hasRightColon ? ' align="right"' : '';
}

function emitTableRow(output, fields, alignments, element, references) {
  output.push('<tr>\n');
  let column = 0;
  while (column < alignments.length) {
    const source = trimAscii(fields[column] ?? '').replaceAll('\\|', '|');
    const body = renderInline(source, references);
    output.push('<' + element + alignments[column] + '>' + body + '</' + element + '>\n');
    column++;
  }
  output.push('</tr>\n');
}

function tableRowContinues(rows, row) {
  const source = rows[row];
  if (isBlank(source)) return source.indexOf('\t') !== -1;
  if (!startsBlock(rows, row) || source.indexOf('|') !== -1) return true;
  return row + 1 < rows.length && setextLevel(rows[row + 1]);
}

function splitTableFields(source) {
  const fields = [];
  let fieldStart = 0;
  let backslashes = 0;
  for (let cursor = 0; cursor < source.length; cursor++) {
    const code = source.charCodeAt(cursor);
    if (code === 92) {
      backslashes++;
      continue;
    }
    if (code === 124 && backslashes % 2 === 0) {
      fields.push(source.slice(fieldStart, cursor));
      fieldStart = cursor + 1;
    }
    backslashes = 0;
  }
  fields.push(source.slice(fieldStart));
  const first = fields.length > 1 && fields[0].trim().length === 0 ? 1 : 0;
  let limit = fields.length;
  if (limit - first > 1 && fields[limit - 1].trim().length === 0) limit--;
  return fields.slice(first, limit);
}

function findStrikeClose(source, start, references) {
  let nesting = 1;
  let cursor = start + 2;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === '\\') {
      cursor += Math.min(2, source.length - cursor);
      continue;
    }
    if (character === '`') {
      const width = markerRun(source, cursor, '`');
      const closing = closingBackticks(source, cursor + width, '`'.repeat(width));
      cursor = (closing < 0 ? cursor : closing) + width;
      continue;
    }
    if (character === '<') {
      const limit = tagClosingAngle(source, cursor);
      if (limit >= 0) {
        cursor = limit + 1;
        continue;
      }
    }
    if (character === '[' || (character === '!' && source[cursor + 1] === '[')) {
      const link = readInlineLink(source, cursor, references, true);
      if (link) {
        cursor = link.end;
        continue;
      }
    }
    if (character !== '~') {
      cursor++;
      continue;
    }
    const width = markerRun(source, cursor, '~');
    if (width === 2) {
      if (cursor > 0 && !isSpace(source[cursor - 1])) {
        if (--nesting === 0) return cursor;
      } else if (!isSpace(source[cursor + 2])) nesting++;
    }
    cursor += width;
  }
  return -1;
}

function renderInline(source, references, suppressBareUrls = false) {
  if (references[COLLECT_REFS]) return '';
  const fragments = [];
  const codePositions = codeSpanPositions(source);
  const lastAt = source.lastIndexOf('@');
  let cursor = 0;
  let literalThrough = -1;
  while (cursor < source.length) {
    const character = source[cursor];
    const code = source.charCodeAt(cursor);
    if (!INLINE_SPECIAL[code]) {
      const allowBare = !suppressBareUrls && !references[IN_RAW_LINK];
      if (allowBare && extendedLinkCandidate(source, cursor, lastAt)) {
        const link = renderExtendedLink(source, cursor, cursor < lastAt);
        if (link) {
          fragments.push(link.html);
          cursor = link.end;
          continue;
        }
      }
      const begin = cursor++;
      while (cursor < source.length) {
        const nextCode = source.charCodeAt(cursor);
        if (INLINE_SPECIAL[nextCode]) break;
        if (allowBare && extendedLinkCandidate(source, cursor, lastAt)) break;
        cursor++;
      }
      fragments.push(source.slice(begin, cursor));
      continue;
    }
    if (character === '\\' && cursor + 1 < source.length) {
      const escaped = source[cursor + 1];
      if (escaped === '\n') {
        fragments.push('<br>');
        cursor += 2;
        cursor += leadingSpaces(source.slice(cursor));
        continue;
      }
      if (PUNCT.includes(escaped)) {
        fragments.push(escapeHtml(escaped));
        cursor += 2;
        continue;
      }
    }
    if (character === '\n') {
      let preceding = cursor;
      while (preceding > 0 && source[preceding - 1] === ' ') preceding--;
      const spaces = cursor - preceding;
      if (spaces >= 2) removeOutputSuffix(fragments, spaces);
      fragments.push(spaces < 2 ? '\n' : '<br>');
      cursor++;
      if (spaces >= 2) cursor += leadingSpaces(source.slice(cursor));
      continue;
    }
    if (character === '`') {
      const width = markerRun(source, cursor, '`');
      const closing = codePositions?.[cursor] > 0
        ? codePositions[cursor] - 1 : closingBackticks(source, cursor + width, '`'.repeat(width));
      if (closing >= 0) {
        let body = replaceNewlines(source.slice(cursor + width, closing), ' ');
        if (body.length > 1 && body.startsWith(' ') && body.endsWith(' ') && body.trim()) body = body.slice(1, -1);
        fragments.push('<code>' + escapeHtml(body, true) + '</code>');
        cursor = closing + width;
        continue;
      }
      if (width > 1) {
        fragments.push(escapeHtml('`'.repeat(width)));
        cursor += width;
        continue;
      }
    }
    if (character === '&') {
      const limit = entityAt(source, cursor);
      if (limit > cursor) {
        const entity = source.slice(cursor, limit);
        if (entity[1] !== '#') fragments.push(entity);
        else {
          const value = entityValue(entity);
          fragments.push(value === null ? escapeHtml(entity, true) : escapeHtml(value));
        }
        cursor = limit;
        continue;
      }
    }
    if (character === '<') {
      const angle = renderAngleConstruct(source, cursor, references);
      if (angle) {
        fragments.push(angle.html);
        cursor = angle.end;
        continue;
      }
    }
    if (character === '[' || (character === '!' && source[cursor + 1] === '[')) {
      const link = readInlineLink(source, cursor, references);
      if (link) {
        fragments.push(link.html);
        cursor = link.end;
        continue;
      }
      const opening = cursor + (character === '!' ? 1 : 0);
      const closing = labelClosingBracket(source, opening);
      if (closing < source.length && mixedCodeLabelTail(source.slice(opening + 1, closing))) literalThrough = closing;
      if (character === '[') {
        const shortcut = shortcutReference(source, cursor, references);
        if (shortcut) {
          fragments.push(shortcut.html);
          cursor = shortcut.end;
          continue;
        }
      }
    }
    if (character === '~') {
      const strike = strikeExtent(source, cursor, references);
      if (strike) {
        const body = renderInline(source.slice(cursor + strike.width, strike.closing), references, suppressBareUrls);
        fragments.push('<del>' + body + '</del>');
        cursor = strike.closing + strike.width;
        continue;
      }
    }
    if ((character === '_' || character === '*') && !codePositions?.[cursor] && cursor > literalThrough) {
      const width = markerRun(source, cursor, character);
      const canOpen = flankingSides(source, cursor, width, character).open;
      const match = canOpen ? emphasisExtent(source, cursor, width, character, references) : null;
      if (match) {
        const unused = match.prefix || 0;
        const paired = Math.min(width - unused, match.count) % 2 ? 1 : 2;
        const limit = match.at + match.count;
        const element = paired === 1 ? 'em' : 'strong';
        const body = renderInline(source.slice(cursor + unused + paired, limit - paired), references, suppressBareUrls);
        fragments.push(character.repeat(unused), '<' + element + '>' + body + '</' + element + '>');
        cursor = limit;
        continue;
      }
      if (!canOpen && width > 1) {
        fragments.push(escapeHtml(character.repeat(width)));
        cursor += width;
        continue;
      }
    }
    fragments.push(ESC[character] || character);
    cursor++;
  }
  return fragments.join('');
}

function removeOutputSuffix(fragments, count) {
  let remaining = count;
  while (remaining > 0 && fragments.length > 0) {
    const tail = fragments.pop();
    if (tail.length > remaining) {
      fragments.push(tail.slice(0, tail.length - remaining));
      break;
    }
    remaining -= tail.length;
  }
}

function strikeExtent(source, start, references) {
  if (source[start - 1] === '~') return null;
  if (source[start + 1] === '~') {
    if (source[start + 2] === '~' || isSpace(source[start + 2])) return null;
    const closing = findStrikeClose(source, start, references);
    return closing > start + 2 && !isSpace(source[closing - 1]) ? { closing, width: 2 } : null;
  }
  if (isSpace(source[start + 1])) return null;
  const closing = source.indexOf('~', start + 1);
  if (closing <= start + 1 || source[closing - 1] === '~' || source[closing + 1] === '~' || isSpace(source[closing - 1])) return null;
  return { closing, width: 1 };
}

function renderAngleConstruct(source, start, references) {
  if (source.startsWith('<![CDATA[', start)) {
    const closing = source.indexOf(']]>', start + 9);
    if (closing >= 0) return { end: closing + 3, html: source.slice(start, closing + 3) };
  }
  const closing = tagClosingAngle(source, start);
  if (closing < 0) return null;
  const contents = source.slice(start + 1, closing);
  if (isAutolink(contents)) {
    const target = contents.includes('@') && !contents.includes(':') ? 'mailto:' + contents : contents;
    return { end: closing + 1, html: '<a href="' + cleanUrl(target) + '">' + escapeHtml(contents) + '</a>' };
  }
  if (!isInlineHtml(contents)) return null;
  const tag = contents.toLowerCase();
  if (tag === '/a') references[IN_RAW_LINK] = false;
  else if (tag[0] === 'a' && (tag.length === 1 || isSpace(tag[1]))) references[IN_RAW_LINK] = true;
  let limit = closing + 1;
  if (contents[0] === '/' && source[limit] === '<') {
    const nextClosing = tagClosingAngle(source, limit);
    if (nextClosing >= 0 && !isInlineHtml(source.slice(limit + 1, nextClosing))) limit = nextClosing + 1;
  }
  return { end: limit, html: source.slice(start, limit) };
}

function codeSpanPositions(source) {
  let positions = null;
  let cursor = source.indexOf('`');
  while (cursor !== -1) {
    let preceding = cursor;
    let slashCount = 0;
    while (preceding > 0 && source[--preceding] === '\\') slashCount++;
    if (slashCount % 2) {
      cursor = source.indexOf('`', cursor + 1);
      continue;
    }
    const width = markerRun(source, cursor, '`');
    const closing = closingBackticks(source, cursor + width, '`'.repeat(width));
    if (closing === -1) {
      cursor = source.indexOf('`', cursor + width);
      continue;
    }
    positions ??= new Int32Array(source.length);
    positions.fill(-1, cursor, closing + width);
    positions[cursor] = closing + 1;
    cursor = source.indexOf('`', closing + width);
  }
  return positions;
}

function shortcutReference(source, start, references) {
  const limit = labelClosingBracket(source, start);
  if (limit >= source.length || (start > 0 && source[start - 1] === ']') || source[limit + 1] === '[') return null;
  const label = source.slice(start + 1, limit);
  const saved = references[normalizeLabel(label)];
  if (!saved) return null;
  const title = saved.title ? ' title="' + escapeHtml(saved.title) + '"' : '';
  const body = renderInline(label, references, true);
  return { end: limit + 1, html: '<a href="' + cleanUrl(saved.url) + '"' + title + '>' + body + '</a>' };
}

function entityAt(source, start) {
  let cursor = start + 1;
  if (source[cursor] !== '#') {
    if (!isAlpha(source.charCodeAt(cursor))) return start;
    do { cursor++; } while (isAlpha(source.charCodeAt(cursor)) || isDigit(source.charCodeAt(cursor)));
  } else {
    cursor++;
    const hexadecimal = source[cursor] === 'x' || source[cursor] === 'X';
    if (hexadecimal) cursor++;
    const digits = cursor;
    while (hexadecimal ? isHex(source.charCodeAt(cursor)) : isDigit(source.charCodeAt(cursor))) cursor++;
    if (cursor === digits) return start;
  }
  return source[cursor] === ';' && cursor > start + 1 ? cursor + 1 : start;
}

const NAMED_ENTITIES = {
  lt: '<', gt: '>', amp: '&', apos: "'", quot: '"',
  nbsp: '\u00a0', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009',
  shy: '\u00ad', zwnj: '\u200c', zwj: '\u200d', lrm: '\u200e', rlm: '\u200f',
  lsquo: '\u2018', ldquo: '\u201c', rsquo: '\u2019', rdquo: '\u201d',
  laquo: '\u00ab', raquo: '\u00bb', iexcl: '\u00a1', iquest: '\u00bf',
  ndash: '\u2013', mdash: '\u2014', hellip: '\u2026', bull: '\u2022', middot: '\u00b7',
  copy: '\u00a9', reg: '\u00ae', trade: '\u2122', sect: '\u00a7', para: '\u00b6',
  cent: '\u00a2', pound: '\u00a3', yen: '\u00a5', euro: '\u20ac',
  uml: '\u00a8', acute: '\u00b4', circ: '\u02c6', tilde: '\u02dc',
  OElig: '\u0152', oelig: '\u0153', Scaron: '\u0160', scaron: '\u0161', Yuml: '\u0178', fnof: '\u0192',
  Alpha: '\u0391', alpha: '\u03b1', Beta: '\u0392', beta: '\u03b2',
  Gamma: '\u0393', gamma: '\u03b3', Delta: '\u0394', delta: '\u03b4',
  Pi: '\u03a0', pi: '\u03c0', Sigma: '\u03a3', sigma: '\u03c3', Omega: '\u03a9', omega: '\u03c9',
  deg: '\u00b0', plusmn: '\u00b1', micro: '\u00b5', times: '\u00d7', divide: '\u00f7',
  frac14: '\u00bc', frac12: '\u00bd', frac34: '\u00be',
  forall: '\u2200', exist: '\u2203', empty: '\u2205', part: '\u2202', nabla: '\u2207',
  isin: '\u2208', ni: '\u220b', notin: '\u2209', prod: '\u220f', sum: '\u2211',
  minus: '\u2212', lowast: '\u2217', radic: '\u221a', prop: '\u221d', infin: '\u221e',
  ang: '\u2220', and: '\u2227', or: '\u2228', cap: '\u2229', cup: '\u222a', int: '\u222b',
  there4: '\u2234', sim: '\u223c', cong: '\u2245', asymp: '\u2248',
  ne: '\u2260', equiv: '\u2261', le: '\u2264', ge: '\u2265',
  sub: '\u2282', sube: '\u2286', sup: '\u2283', supe: '\u2287', nsub: '\u2284',
  oplus: '\u2295', otimes: '\u2297', perp: '\u22a5',
  lceil: '\u2308', lfloor: '\u230a', rceil: '\u2309', rfloor: '\u230b', lang: '\u2329', rang: '\u232a',
  loz: '\u25ca', spades: '\u2660', hearts: '\u2665', clubs: '\u2663', diams: '\u2666'
};

function entityValue(source) {
  const name = source.slice(1, -1);
  if (name[0] !== '#') return Object.hasOwn(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : null;
  const hexadecimal = name[1] === 'X' || name[1] === 'x';
  const code = Number.parseInt(name.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
  if (!Number.isFinite(code) || code > 0x10ffff) return null;
  if (code === 0 || (code >= 0xd800 && code <= 0xdfff)) return '\ufffd';
  return String.fromCodePoint(code);
}

function markerRun(source, start, marker) {
  let limit = start;
  while (source[limit] === marker) limit++;
  return limit - start;
}

function closingBackticks(source, from, marker) {
  let cursor = source.indexOf('`', from);
  while (cursor !== -1) {
    const width = markerRun(source, cursor, '`');
    if (width === marker.length) return cursor;
    cursor = source.indexOf('`', cursor + width);
  }
  return -1;
}

function flankingSides(source, start, width, marker) {
  let before = 32;
  if (start > 0) {
    const previousUnit = source.charCodeAt(start - 1);
    before = source.codePointAt(start - (previousUnit >= 0xdc00 && previousUnit <= 0xdfff ? 2 : 1));
  }
  const after = start + width < source.length ? source.codePointAt(start + width) : 32;
  const beforeSpace = unicodeWhitespace(before);
  const afterSpace = unicodeWhitespace(after);
  const beforePunctuation = unicodePunctuation(before);
  const afterPunctuation = unicodePunctuation(after);
  const left = !afterSpace && (!afterPunctuation || beforeSpace || beforePunctuation);
  const right = !beforeSpace && (!beforePunctuation || afterSpace || afterPunctuation);
  if (marker === '*') return { open: left, close: right };
  return { open: left && (!right || beforePunctuation), close: right && (!left || afterPunctuation) };
}

function emphasisExtent(source, start, openingWidth, marker, references) {
  const opening = flankingSides(source, start, openingWidth, marker);
  let needed = openingWidth;
  let deferred = 0;
  let cursor = start + openingWidth;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === '\\') {
      cursor += 2;
      continue;
    }
    if (character === '`') {
      const width = markerRun(source, cursor, '`');
      const closing = closingBackticks(source, cursor + width, '`'.repeat(width));
      cursor = (closing < 0 ? cursor : closing) + width;
      continue;
    }
    if (character === '<') {
      const closing = tagClosingAngle(source, cursor);
      if (closing >= 0) {
        cursor = closing + 1;
        continue;
      }
    }
    if (character === '[' || (character === '!' && source[cursor + 1] === '[')) {
      const link = readInlineLink(source, cursor, references, true);
      if (link) {
        cursor = link.end;
        continue;
      }
    }
    if (character !== marker) {
      cursor++;
      continue;
    }
    const width = markerRun(source, cursor, marker);
    const sides = flankingSides(source, cursor, width, marker);
    if (sides.close) {
      if (ambiguousDelimiterPair(opening.close, sides.open, openingWidth, width)) deferred += width;
      else {
        needed -= width;
        if (needed <= 0) return { at: cursor, count: Math.min(width, width + needed + deferred) };
      }
    } else if (sides.open) needed += width;
    cursor += width;
  }
  if (deferred) return null;
  const groups = collectDelimiterPairs(source, start + openingWidth, marker, openingWidth, true, true, references);
  if (!groups) return null;
  let consumed = 0;
  for (const group of groups) consumed += group.count;
  const last = groups[groups.length - 1];
  return { at: last.at, count: last.count, prefix: openingWidth - consumed };
}

function ambiguousDelimiterPair(openingCloses, closingOpens, openingWidth, closingWidth) {
  return (openingCloses || closingOpens) && (openingWidth + closingWidth) % 3 === 0
    && (openingWidth % 3 !== 0 || closingWidth % 3 !== 0);
}

function collectDelimiterPairs(source, from, marker, openingWidth, skipAlternate, collectAll, references = Object.create(null)) {
  const stack = [];
  const pairs = [];
  let needed = openingWidth;
  let cursor = from;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === '\\') {
      cursor += Math.min(2, source.length - cursor);
      continue;
    }
    if (character === '`') {
      const width = markerRun(source, cursor, '`');
      const closing = closingBackticks(source, cursor + width, '`'.repeat(width));
      cursor = (closing < 0 ? cursor : closing) + width;
      continue;
    }
    if (character === '<') {
      const closing = source.indexOf('>', cursor + 1);
      if (closing >= 0) {
        cursor = closing + 1;
        continue;
      }
    }
    if (character === '[' || (character === '!' && source[cursor + 1] === '[')) {
      const link = readInlineLink(source, cursor, references, true);
      if (link) {
        cursor = link.end;
        continue;
      }
    }
    if (skipAlternate && character !== marker && (character === '_' || character === '*')) {
      const width = markerRun(source, cursor, character);
      if (flankingSides(source, cursor, width, character).open) {
        const other = collectDelimiterPairs(source, cursor + width, character, width, false, false, references);
        const closing = other ? other[0].at : -1;
        if (closing >= 0 && !containsClosingMarker(source, cursor + width, closing, marker)) {
          cursor = closing + Math.min(width, markerRun(source, closing, character));
          continue;
        }
      }
      cursor += width;
      continue;
    }
    if (character !== marker) {
      cursor++;
      continue;
    }
    const width = markerRun(source, cursor, marker);
    const sides = flankingSides(source, cursor, width, marker);
    if (sides.close) {
      if (stack.length > 0 && width >= stack[stack.length - 1]) {
        cursor += stack.pop();
        continue;
      }
      const opening = flankingSides(source, from - openingWidth, openingWidth, marker);
      if (width > 0 && !ambiguousDelimiterPair(opening.close, sides.open, openingWidth, width)) {
        const used = Math.min(needed, width);
        pairs.push({ at: cursor, count: used });
        needed -= used;
        if (!collectAll || needed === 0) return pairs;
        cursor += width;
        continue;
      }
    }
    if (sides.open) stack.push(width);
    cursor += width;
  }
  return pairs.length > 0 ? pairs : null;
}

function containsClosingMarker(source, from, limit, marker) {
  let cursor = from;
  while (cursor < limit) {
    if (source[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (source[cursor] === '`') {
      const width = markerRun(source, cursor, '`');
      const closing = closingBackticks(source, cursor + width, '`'.repeat(width));
      if (closing >= 0 && closing < limit) {
        cursor = closing + width;
        continue;
      }
    }
    if (source[cursor] === marker) {
      const width = markerRun(source, cursor, marker);
      if (flankingSides(source, cursor, width, marker).close) return true;
      cursor += width;
    } else cursor++;
  }
  return false;
}

function unicodeWhitespace(code) {
  if (code >= 0x2000 && code <= 0x200a) return true;
  switch (code) {
    case 9: case 10: case 13: case 32: case 0xa0: case 0x1680:
    case 0x2028: case 0x2029: case 0x202f: case 0x205f: case 0x3000: return true;
    default: return false;
  }
}

function unicodePunctuation(code) {
  if (code < 128) {
    return (code >= 123 && code <= 126) || (code >= 91 && code <= 96)
      || (code >= 58 && code <= 64) || (code >= 33 && code <= 47);
  }
  switch (code) {
    case 0xa1: case 0xa3: case 0xa7: case 0xa9: case 0xab: case 0xac: case 0xae:
    case 0xb0: case 0xb1: case 0xb6: case 0xbb: case 0xbf: case 0xd7: case 0xf7: return true;
  }
  return (code >= 0x2000 && code <= 0x206f) || (code >= 0x20a0 && code <= 0x20cf)
    || (code >= 0x2100 && code <= 0x214f) || (code >= 0x2190 && code <= 0x2bff)
    || (code >= 0x2e00 && code <= 0x2e7f) || (code >= 0x3001 && code <= 0x303f)
    || (code >= 0xfe10 && code <= 0xfe6f) || (code >= 0xff01 && code <= 0xff0f)
    || (code >= 0xff1a && code <= 0xff20) || (code >= 0xff3b && code <= 0xff40)
    || (code >= 0xff5b && code <= 0xff65) || (code >= 0x1f000 && code <= 0x1faff);
}

function linkDestination(source, from) {
  let cursor = from;
  while (isSpace(source[cursor])) cursor++;
  let address;
  if (source[cursor] === '<') {
    const begin = ++cursor;
    while (cursor < source.length) {
      const character = source[cursor];
      if (character === '\r' || character === '\n' || character === '<') return null;
      if (character === '\\' && PUNCT.includes(source[cursor + 1])) cursor += 2;
      else if (character === '>') break;
      else cursor++;
    }
    if (source[cursor] !== '>' || (cursor > begin && source[cursor - 1] === '\\')) return null;
    address = source.slice(begin, cursor);
    cursor++;
  } else {
    const begin = cursor;
    let parentheses = 0;
    while (cursor < source.length && !isSpace(source[cursor])) {
      const character = source[cursor];
      if (character === '\\' && PUNCT.includes(source[cursor + 1])) {
        cursor += 2;
        continue;
      }
      if (character === '(') parentheses++;
      else if (character === ')') {
        if (parentheses === 0) break;
        parentheses--;
      }
      cursor++;
    }
    if (parentheses) return null;
    address = source.slice(begin, cursor);
  }
  while (isSpace(source[cursor])) cursor++;
  let title = '';
  const opening = source[cursor];
  if (opening === '(' || opening === '"' || opening === "'") {
    const closing = linkTitleLimit(source, cursor, opening === '(' ? ')' : opening);
    if (closing < 0) return null;
    title = source.slice(cursor + 1, closing);
    cursor = closing + 1;
    while (isSpace(source[cursor])) cursor++;
  }
  return source[cursor] === ')'
    ? [unescapePunctuation(address), unescapePunctuation(title), cursor + 1] : null;
}

function savedLinkDestination(source, label, from, references) {
  let lookup = label;
  let limit = from;
  if (source[from] === '[') {
    const closing = source.indexOf(']', from + 1);
    if (closing < 0) return null;
    if (closing > from + 1) lookup = source.slice(from + 1, closing);
    limit = closing + 1;
  }
  const entry = references[normalizeLabel(lookup)];
  return entry ? [entry.url, entry.title, limit] : null;
}

function readInlineLink(source, start, references, probe = false) {
  const image = source[start] === '!';
  const opening = start + (image ? 1 : 0);
  const closing = labelClosingBracket(source, opening);
  if (closing === source.length) return null;
  const label = source.slice(opening + 1, closing);
  if (mixedCodeLabelTail(label)) return null;
  const after = closing + 1;
  const target = source[after] === '('
    ? linkDestination(source, after + 1) : savedLinkDestination(source, label, after, references);
  if (target === null || (!image && labelContainsLink(label, references))) return null;
  if (probe) return { end: target[2] };
  return { end: target[2], html: resolvedLinkHtml(label, target[0], target[1], image, references) };
}

function resolvedLinkHtml(label, address, title, image, references) {
  const href = cleanUrl(address);
  const titleAttribute = title.length > 0 ? ' title="' + escapeHtml(title) + '"' : '';
  const body = renderInline(label, references, true);
  if (!image) return '<a href="' + href + '"' + titleAttribute + '>' + body + '</a>';
  const alternative = escapeHtml(inlinePlainText(body), true);
  return '<img src="' + href + '" alt="' + alternative + '"' + titleAttribute + '>';
}

function mixedCodeLabelTail(source) {
  if (!source.includes('``')) return false;
  let cursor = 0;
  while (cursor < source.length) {
    if (source[cursor] === '\\') {
      cursor += 2;
      continue;
    }
    if (source[cursor] !== '`') {
      cursor++;
      continue;
    }
    const width = markerRun(source, cursor, '`');
    const closing = closingBackticks(source, cursor + width, '`'.repeat(width));
    if (closing < 0) cursor += width;
    else {
      const mixed = width > 1 && source.indexOf('`', cursor + width) < closing;
      if (mixed && trimAscii(source.slice(closing + width))) return true;
      cursor = closing + width;
    }
  }
  return false;
}

function labelContainsLink(source, references) {
  if (!source.includes('[')) return false;
  let cursor = 0;
  while (cursor < source.length) {
    if (source[cursor] === '!' && source[cursor + 1] === '[') {
      const image = readInlineLink(source, cursor, references, true);
      if (image) {
        cursor = image.end;
        continue;
      }
    }
    if (source[cursor] === '[' && (cursor === 0 || source[cursor - 1] !== '\\')) {
      const closing = labelClosingBracket(source, cursor);
      if (closing < source.length && (cursor === 0 || source[cursor - 1] !== '!')
        && readInlineLink(source, cursor, references, true)) return true;
    }
    cursor++;
  }
  return false;
}

function labelClosingBracket(source, opening) {
  let nesting = 1;
  let literalTicks = false;
  let cursor = opening + 1;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === '\\') {
      cursor += 2;
      continue;
    }
    if (character === '`') {
      const width = markerRun(source, cursor, '`');
      const closing = closingBackticks(source, cursor + width, '`'.repeat(width));
      if (width > 1) {
        const bracket = source.indexOf(']', cursor + width);
        const followedByTarget = source[bracket + 1] === '[' || source[bracket + 1] === '(';
        if (closing < 0 || (bracket >= 0 && bracket < closing && followedByTarget)) literalTicks = true;
      }
      cursor = (!literalTicks && closing >= 0 ? closing : cursor) + width;
      continue;
    }
    if (character === '<') {
      const closing = tagClosingAngle(source, cursor);
      if (closing >= 0) {
        cursor = closing + 1;
        continue;
      }
    }
    if (character === '[') nesting++;
    else if (character === ']' && --nesting === 0) return cursor;
    cursor++;
  }
  return source.length;
}

function tagClosingAngle(source, opening) {
  let quotedBy = '';
  let cursor = opening + 1;
  while (cursor < source.length) {
    const character = source[cursor];
    if (quotedBy) {
      if (character === quotedBy) quotedBy = '';
    } else if (character === "'" || character === '"') quotedBy = character;
    else if (character === '>') return cursor;
    cursor++;
  }
  return -1;
}

function inlinePlainText(source) {
  if (!source.includes('<')) return source;
  let rendered = '';
  let withinTag = false;
  let quotedBy = '';
  let cursor = 0;
  while (cursor < source.length) {
    if (!withinTag && source.startsWith('<img ', cursor)) {
      const closing = source.indexOf('>', cursor + 5);
      if (closing >= 0) {
        const alt = source.indexOf(' alt="', cursor + 5);
        if (alt >= 0 && alt < closing) {
          const limit = source.indexOf('"', alt + 6);
          if (limit > alt) rendered += imageAlternativeText(source.slice(alt + 6, limit));
        }
        cursor = closing + 1;
        continue;
      }
    }
    const character = source[cursor++];
    if (!withinTag) {
      if (character === '<') withinTag = true;
      else rendered += character;
    } else if (quotedBy) {
      if (character === quotedBy) quotedBy = '';
    } else if (character === "'" || character === '"') quotedBy = character;
    else if (character === '>') withinTag = false;
  }
  return rendered;
}

function imageAlternativeText(source) {
  return source.replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"').replaceAll('&#39;', "'");
}

function linkTitleLimit(source, start, delimiter) {
  const parentheses = source[start] === '(';
  let cursor = start + 1;
  while (cursor < source.length) {
    const character = source[cursor];
    if (character === '\r' || character === '\n') return -1;
    if (character === '\\') {
      cursor += 2;
      continue;
    }
    if (character === delimiter) return cursor;
    if (parentheses && character === '(') return -1;
    cursor++;
  }
  return -1;
}

function extendedLinkCandidate(source, offset, finalAt) {
  const letter = source.charCodeAt(offset);
  if ((letter | 32) !== 104 && letter !== 119 && !(offset < finalAt && isAlpha(letter))) return false;
  const preceding = source.charCodeAt(offset - 1);
  return preceding !== 95 && !isAlpha(preceding) && !isDigit(preceding);
}

function extendedAnchor(source, begin, end, targetPrefix = '') {
  const label = source.slice(begin, end);
  return {
    end,
    html: '<a href="' + cleanUrl(targetPrefix + label) + '">' + escapeHtml(label) + '</a>'
  };
}

function renderExtendedLink(source, begin, withMailbox) {
  const remaining = source.slice(begin);
  const mailScheme = withMailbox ? /^(mailto|xmpp):/i.exec(remaining) : null;
  if (mailScheme !== null) {
    const accountStart = begin + mailScheme[0].length;
    const ceiling = mailAddressCeiling(source, accountStart);
    const firstSlash = source.indexOf('/', accountStart);
    const accountLimit = firstSlash === -1 ? ceiling : Math.min(firstSlash, ceiling);
    const accountEnd = mailboxBoundary(source, accountStart, accountLimit);
    if (accountEnd >= 0) {
      let end = accountEnd;
      if (mailScheme[1].toLowerCase() === 'xmpp' && end < ceiling && source[end] === '/') {
        const nextSlash = source.indexOf('/', end + 1);
        const resourceLimit = nextSlash === -1 ? ceiling : Math.min(nextSlash, ceiling);
        const resource = source.slice(end + 1, resourceLimit).replace(/[.,]+$/, '');
        end += resource.length + 1;
      }
      return extendedAnchor(source, begin, end);
    }
  }

  const protocol = /^https?:\/\//i.exec(remaining);
  const prefix = protocol?.[0] ?? (remaining.startsWith('www.') ? 'www.' : '');
  if (prefix.length > 0) {
    const end = webAddressBoundary(source, begin, begin + prefix.length);
    return end > begin + prefix.length
      ? extendedAnchor(source, begin, end, prefix === 'www.' ? 'http://' : '') : null;
  }
  if (!withMailbox || !isAlpha(source.charCodeAt(begin))) return null;
  const end = mailboxBoundary(source, begin);
  return end < 0 ? null : extendedAnchor(source, begin, end, 'mailto:');
}

function addressSeparator(code, quoted) {
  return code === 9 || code === 10 || code === 13 || code === 32
    || code === 60 || code === 62 || (quoted && code === 34);
}

function mailAddressCeiling(source, from) {
  let width = 0;
  while (from + width < source.length && !addressSeparator(source.charCodeAt(from + width), false)) width++;
  const body = source.slice(from, from + width).replace(/[!?,.;:]+$/, '');
  return from + body.length;
}

function webAddressBoundary(source, from, bodyStart) {
  let stop = bodyStart;
  let nesting = 0;
  let openGroup = -1;
  for (; stop < source.length && !addressSeparator(source.charCodeAt(stop), true); stop++) {
    if (source[stop] === '(') {
      if (nesting === 0) openGroup = stop;
      nesting++;
    } else if (source[stop] === ')' && nesting > 0) nesting--;
  }
  if (nesting > 0) stop = openGroup;

  // Only balanced closing parentheses can keep a punctuation suffix in a URL.
  let retained = from;
  let balance = 0;
  for (let offset = from; offset < stop; offset++) {
    const character = source[offset];
    if (character === ')') {
      if (balance === 0) continue;
      balance--;
    } else if (character === '(') balance++;
    else if ('!?,.;:'.includes(character)) continue;
    retained = offset + 1;
  }

  const ampersand = source.lastIndexOf('&', retained - 1);
  if (ampersand >= from) {
    const assignment = source.indexOf('=', ampersand + 1);
    if (assignment === -1 || assignment >= retained) retained = ampersand;
  }
  return retained;
}

function mailboxBoundary(source, from, ceiling = source.length) {
  const candidate = source.slice(from, ceiling);
  const separator = candidate.indexOf('@');
  if (separator <= 0) return -1;
  const account = candidate.slice(0, separator);
  if (/[^a-z\d!#$%&'*+/=?^_`{|}~.\-]/i.test(account)
    || account[0] === '.' || account.endsWith('.') || account.includes('..')) return -1;

  const hostMatch = /^[a-z\d.\-]+/i.exec(candidate.slice(separator + 1));
  if (hostMatch === null) return -1;
  const host = hostMatch[0];
  const hostOffset = from + separator + 1;
  if (source[hostOffset + host.length] === '_') return -1;
  const addressHost = host.replace(/\.+$/, '');
  const labels = addressHost.split('.');
  if (labels.length < 2) return -1;
  for (const label of labels) {
    if (label.length === 0 || label.startsWith('-') || label.endsWith('-')) return -1;
  }
  return hostOffset + addressHost.length;
}

function isSpace(character) {
  switch (character) {
    case '\t': case '\n': case '\r': case ' ': return true;
    default: return false;
  }
}

function isDigit(code) {
  return code <= 57 && code >= 48;
}

function isAlpha(code) {
  return (code >= 97 && code <= 122) || (code >= 65 && code <= 90);
}

function isHex(code) {
  if (isDigit(code)) return true;
  return (code >= 97 && code <= 102) || (code >= 65 && code <= 70);
}

export {
  parse
};
