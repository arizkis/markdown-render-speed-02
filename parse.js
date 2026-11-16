const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const PUNCT = "!\"#$%&'()*+,\-./:;<=>?@[\\]^_`{|}~";
const COLLECT_REFS = Symbol('collect references');
const IN_RAW_LINK = Symbol('inside an HTML anchor');

function escapeHtml(text, encode = false) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '&') {
      const end = encode ? i : entityAt(text, i);
      if (end > i) { out += text.slice(i, end); i = end - 1; }
      else out += '&amp;';
    } else out += ESC[c] || c;
  }
  return out;
}

function cleanUrl(url) {
  let encoded = '';
  try { encoded = encodeURI(url.trim()); } catch { encoded = url.trim(); }
  let stable = '';
  for (let i = 0; i < encoded.length; i++) {
    if (encoded[i] === '%' && encoded.slice(i, i + 3).toLowerCase() === '%25') { stable += '%'; i += 2; }
    else stable += encoded[i];
  }
  return escapeHtml(stable, false);
}

function normalizeLabel(label) {
  let out = '', pendingSpace = false;
  for (let i = 0; i < label.length; i++) {
    const c = label[i];
    if (c === ' ' || c === '\t' || c === '\n') { if (out) pendingSpace = true; continue; }
    if (pendingSpace) out += ' ';
    pendingSpace = false;
    out += c === '\u1e9e' ? 'ss' : c.toLowerCase();
  }
  return out;
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) if (line.charCodeAt(i) !== 32 && line.charCodeAt(i) !== 9) return false;
  return true;
}

function indentOf(line) {
  return Math.min(4, indentColumns(line));
}

function indentColumns(line) {
  let n = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === ' ') n++;
    else if (line[i] === '\t') n = (n + 4) & ~3;
    else break;
  }
  return n;
}

function stripIndent(line, count) {
  const requested = count;
  let i = 0;
  let column = 0;
  let prefix = '';
  while (i < line.length && count > 0) {
    if (line[i] === '\t') {
      const width = 4 - (column % 4);
      if (count >= width) { count -= width; column += width; i++; }
      else { prefix += ' '.repeat(width - count); count = 0; i++; }
    }
    else if (line[i] === ' ') { count--; column++; i++; }
    else break;
  }
  let rest = line.slice(i);
  if (requested > 0 && line[0] === '\t' && rest[0] === '\t') rest = '  ' + rest.slice(1);
  return prefix + rest;
}

function stripFencedIndent(line, count, baseIndent) {
  if (!baseIndent) return stripIndent(line, count);
  let i = 0;
  let column = baseIndent;
  let remaining = count;
  let prefix = '';
  while (i < line.length && remaining > 0) {
    if (line[i] === ' ') { remaining--; column++; i++; }
    else if (line[i] === '\t') {
      const width = 4 - (column % 4);
      if (remaining >= width) { remaining -= width; column += width; i++; }
      else { prefix += ' '.repeat(width - remaining); remaining = 0; column += width; i++; }
    } else break;
  }
  let end = i;
  let leading = '';
  while (end < line.length && (line[end] === ' ' || line[end] === '\t')) {
    if (line[end] === '\t') {
      const width = 4 - (column % 4);
      leading += ' '.repeat(width);
      column += width;
    } else {
      leading += ' ';
      column++;
    }
    end++;
  }
  return prefix + leading + line.slice(end);
}

function splitLines(markdown) {
  const source = String(markdown);
  const lines = [];
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\r' || source[i] === '\n') {
      lines.push(source.slice(start, i));
      if (source[i] === '\r' && source[i + 1] === '\n') i++;
      start = i + 1;
    }
  }
  if (start < source.length) lines.push(source.slice(start));
  else if (source.length && (source[source.length - 1] === '\n' || source[source.length - 1] === '\r')) lines.push('');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function trimAscii(text) {
  let start = 0, end = text.length;
  while (start < end && (text[start] === ' ' || text[start] === '\t')) start++;
  while (end > start && (text[end - 1] === ' ' || text[end - 1] === '\t')) end--;
  return text.slice(start, end);
}

function replaceNewlines(text, replacement) {
  let out = '';
  for (let i = 0; i < text.length; i++) out += text[i] === '\n' ? replacement : text[i];
  return out;
}

function findClosing(text, from, marker) {
  let p = from;
  while ((p = text.indexOf(marker, p)) >= 0) {
    let bs = 0;
    for (let i = p - 1; i >= 0 && text[i] === '\\'; i--) bs++;
    if ((bs & 1) === 0) return p;
    p += marker.length;
  }
  return -1;
}

function parse(markdown) {
  const lines = splitLines(markdown);
  const refs = Object.create(null);
  refs[COLLECT_REFS] = true;
  renderBlocks(lines, refs);
  refs[COLLECT_REFS] = false;
  refs[IN_RAW_LINK] = false;
  let html = renderBlocks(lines, refs);
  if (!String(markdown).endsWith('\n') && String(markdown).endsWith('</blockquote>') && html.endsWith('</blockquote>\n')) {
    html = html.slice(0, -1);
  }
  return html;
}

function saveReference(refs, parsed) {
  const label = normalizeLabel(parsed.label);
  if (!label) return false;
  if (!Object.prototype.hasOwnProperty.call(refs, label)) refs[label] = { url: parsed.url, title: parsed.title };
  return true;
}

function parseReferenceDefinition(lines, start, leading) {
  let defLine = lines[start];
  let close = findUnescaped(defLine, ']:', leading + 1);
  let last = start;
  while (close < 0 && last + 1 < lines.length && !isBlank(lines[last + 1])) {
    defLine += '\n' + lines[++last];
    close = findUnescaped(defLine, ']:', leading + 1);
  }
  if (close <= leading + 1) return null;
  const label = defLine.slice(leading + 1, close);
  if (hasUnescapedBracket(label, '[') || hasUnescapedBracket(label, ']')) return null;
  let i = last;
  let rest = defLine.slice(close + 2);
  let url = '';
  let title = '';
  let hasUrl = false;
  let consumed = false;
  while (true) {
    rest = trimAscii(rest);
    if (!url) {
      if (!rest) {
        if (i + 1 >= lines.length || isBlank(lines[i + 1])) return null;
        i++;
        rest = lines[i];
        consumed = true;
        continue;
      }
      if (rest[0] === '<') {
        const end = rest.indexOf('>');
        if (end < 0 || hasNewline(rest.slice(0, end))) return null;
        url = unescapePunctuation(rest.slice(1, end));
        hasUrl = true;
        const tail = rest.slice(end + 1);
        if (tail && !isSpace(tail[0])) return null;
        rest = tail;
      } else {
        let end = 0;
        let depth = 0;
        while (end < rest.length) {
          const c = rest[end];
          if (c === '\\' && end + 1 < rest.length) { end += 2; continue; }
          if (c === '(') depth++;
          else if (c === ')' && depth > 0) depth--;
          else if (isSpace(c) && depth === 0) break;
          end++;
        }
        if (!end || depth) return null;
        url = unescapePunctuation(rest.slice(0, end));
        hasUrl = true;
        rest = rest.slice(end);
      }
      consumed = true;
    }
    rest = trimAscii(rest);
    if (!rest) {
      if (i + 1 < lines.length && !isBlank(lines[i + 1]) && isTitleStart(trimAscii(lines[i + 1]))) {
        i++;
        rest = lines[i];
        const titleProbe = trimAscii(rest);
        const titleClose = findTitleClose(titleProbe, 1, titleProbe[0]);
        if (titleClose >= 0 && trimAscii(titleProbe.slice(titleClose + 1))) { i--; break; }
        consumed = true;
        continue;
      }
      break;
    }
    const opener = rest[0];
    if (opener !== '"' && opener !== "'" && opener !== '(') return null;
    const closer = opener === '(' ? ')' : opener;
    let end = 1;
    let titleParts = [];
    while (true) {
      const at = findTitleClose(rest, end, closer);
      if (at >= 0) {
        titleParts.push(rest.slice(end, at));
        const tail = trimAscii(rest.slice(at + 1));
        if (tail) return null;
        title = unescapePunctuation(titleParts.join('\n'));
        break;
      }
      titleParts.push(rest.slice(end));
      if (i + 1 >= lines.length || isBlank(lines[i + 1])) return null;
      i++;
      rest = lines[i];
      end = 0;
      consumed = true;
    }
    break;
  }
  return consumed && hasUrl ? { label, url, title, next: i + 1 } : null;
}

function hasUnescapedBracket(text, bracket) {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== bracket) continue;
    let slashes = 0;
    for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) slashes++;
    if (!(slashes & 1)) return true;
  }
  return false;
}

function isTitleStart(text) { return text[0] === '"' || text[0] === "'" || text[0] === '('; }

function findTitleClose(text, from, closer) {
  for (let i = from; i < text.length; i++) {
    if (text[i] === '\\' && i + 1 < text.length) { i++; continue; }
    if (text[i] === closer) return i;
  }
  return -1;
}

function leadingSpaces(line) {
  let i = 0;
  while (line[i] === ' ' || line[i] === '\t') i++;
  return i;
}

function findUnescaped(text, needle, from = 0) {
  let at = from;
  while ((at = text.indexOf(needle, at)) >= 0) {
    let slash = 0;
    for (let i = at - 1; i >= 0 && text[i] === '\\'; i--) slash++;
    if (!(slash & 1)) return at;
    at += needle.length;
  }
  return -1;
}

function hasNewline(text) { return text.includes('\n') || text.includes('\r'); }

function unescapePunctuation(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && i + 1 < text.length && PUNCT.includes(text[i + 1])) out += text[++i];
    else out += text[i];
  }
  return out;
}

function renderBlocks(lines, refs, inListItem = false, baseIndent = 0) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (isBlank(lines[i])) { i++; continue; }
    const line = lines[i];
    if (indentColumns(line) < 4 && line[leadingSpaces(line)] === '[') {
      const definition = parseReferenceDefinition(lines, i, leadingSpaces(line));
      if (definition && saveReference(refs, definition)) { i = definition.next; continue; }
    }
    if (isThematic(line)) { out.push('<hr>\n'); i++; continue; }
    const list = listStart(line);
    if (list) {
      const result = renderList(lines, i, refs, list, baseIndent);
      out.push(result.html); i = result.next; continue;
    }
    if (i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
      const table = renderTable(lines, i, refs);
      if (table) { out.push(table.html); i = table.next; continue; }
    }
    if (isHtmlBlockStart(line)) {
      const block = [line];
      const tag = htmlBlockTag(line);
      const rawTag = tag === '!--' || tag === '?' || tag === '![CDATA[' || tag === 'script' || tag === 'style' || tag === 'pre' || tag === 'textarea';
      let endedByBlank = false;
      i++;
      if (rawTag && !htmlBlockEnd(line, tag)) {
        while (i < lines.length) {
          const next = lines[i++];
          block.push(next);
          if (htmlBlockEnd(next, tag)) break;
        }
      } else if (!rawTag) {
        while (i < lines.length && !isBlank(lines[i])) block.push(lines[i++]);
        endedByBlank = i < lines.length;
      }
      let joinNewline = !endedByBlank;
      if (rawTag && i < lines.length && isBlank(lines[i])) {
        let blankHasTab = false;
        while (i < lines.length && isBlank(lines[i])) {
          if (lines[i].includes('\t')) blankHasTab = true;
          i++;
        }
        joinNewline = tag === '!--' ? blankHasTab : false;
      }
      out.push(block.join('\n') + (joinNewline ? '\n' : ''));
      continue;
    }
    const fence = fenceStart(line);
    if (fence) {
      const content = [];
      i++;
      while (i < lines.length && !fenceEnd(lines[i], fence)) content.push(stripFencedIndent(lines[i++], fence.indent, baseIndent));
      if (i < lines.length) i++;
      const info = fence.info;
      let language = '';
      for (let n = 0; n < info.length && info[n] !== ' ' && info[n] !== '\t'; n++) language += info[n];
      const cls = language ? ` class="language-${escapeHtml(unescapePunctuation(language), false)}"` : '';
      const code = content.join('\n') + (content.length && content[content.length - 1] !== '' ? '\n' : '');
      out.push(`<pre><code${cls}>${escapeHtml(code, true)}</code></pre>\n`);
      continue;
    }
    if (isIndentedCode(line)) {
      const content = [];
      while (i < lines.length) {
        if (isBlank(lines[i])) { content.push(stripIndent(lines[i], 4)); i++; continue; }
        if (!isIndentedCode(lines[i])) break;
        content.push(stripIndent(lines[i], 4)); i++;
      }
      while (content.length && content[content.length - 1] === '') content.pop();
      out.push(`<pre><code>${escapeHtml(content.join('\n') + '\n', true)}</code></pre>\n`);
      continue;
    }
    const heading = atxHeading(line);
    if (heading) { out.push(`<h${heading.level}>${renderInline(heading.text, refs)}</h${heading.level}>\n`); i++; continue; }
    if (i + 1 < lines.length && !isBlank(line) && quoteLine(line) === null && !listStart(line) && !fenceStart(line)) {
      const level = setextLevel(lines[i + 1]);
      if (level) { out.push(`<h${level}>${renderInline(trimAscii(line), refs)}</h${level}>\n`); i += 2; continue; }
    }
    if (quoteLine(line) !== null) {
      const quote = [];
      let quoteFence = null;
      let quoteBlankSeen = false;
      while (i < lines.length) {
        const marked = quoteLine(lines[i]);
        if (marked !== null) {
          let quoteColumn = baseIndent + quotePrefixWidth(lines[i]);
          let markerAt = 0;
          while (markerAt < lines[i].length && markerAt < 3 && lines[i][markerAt] === ' ') markerAt++;
          if (lines[i][markerAt + 1] === '\t') quoteColumn++;
          quote.push(expandQuoteTabs(marked, quoteColumn));
          quoteBlankSeen = isBlank(marked);
          if (quoteFence) {
            if (fenceEnd(marked, quoteFence)) quoteFence = null;
          } else quoteFence = fenceStart(marked);
          i++;
          continue;
        }
        if (quoteFence) break;
        if (!quoteBlankSeen && indentColumns(lines[i]) >= 4 && quote.length && listStart(lines[i].trimStart())) {
          quote.push(`\\${lines[i].trimStart()}`);
          i++;
          continue;
        }
        if (!quoteBlankSeen && !isBlank(lines[i]) && !isThematic(lines[i]) && !fenceStart(lines[i]) && !listStart(lines[i]) && !atxHeading(lines[i]) && !isIndentedCode(lines[i])) {
          quote.push(setextLevel(lines[i]) ? `    ${lines[i++]}` : lines[i++]);
          continue;
        }
        break;
      }
      if (quote.length > 1 && isBlank(quote[quote.length - 1]) && quote[quote.length - 1].length > 0) {
        quote[quote.length - 2] += `\n${quote.pop()}`;
      }
      let quoteHtml = renderBlocks(quote, refs, inListItem, quotePrefixWidth(line));
      if (quote.length && isHtmlBlockStart(quote[0]) && !quote.some(isBlank) && quoteHtml.endsWith('\n')) quoteHtml = quoteHtml.slice(0, -1);
      out.push(`<blockquote>\n${quoteHtml}</blockquote>\n`);
      continue;
    }
    const para = [line]; i++;
    let setext = 0;
    while (i < lines.length && !isBlank(lines[i])) {
      setext = setextLevel(lines[i]);
      if (setext) { i++; break; }
      if (trimAscii(lines[i]).toLowerCase() === '</pre>') {
        para.push(lines[i++]);
        continue;
      }
      if (isIndentedCode(lines[i]) && para.length && (para[para.length - 1].endsWith('  ') || para[para.length - 1].endsWith('\\'))) {
        para.push(lines[i].trimStart());
        i++;
        continue;
      }
      if (isIndentedCode(lines[i]) && para.length && !isBlank(lines[i - 1])) {
        para.push(lines[i]);
        i++;
        continue;
      }
      if (startsParagraphBlock(lines, i, inListItem) && !isIndentedUnderline(lines[i]) && !(i + 1 < lines.length && setextLevel(lines[i + 1]))) break;
      para.push(lines[i++]);
    }
    if (setext) out.push(`<h${setext}>${renderInline(trimAscii(para.join('\n')), refs)}</h${setext}>\n`);
    else out.push(`<p>${renderInline(para.join('\n'), refs)}</p>\n`);
  }
  return out.join('');
}

function quoteLine(line) {
  let i = 0;
  while (i < line.length && i < 3 && line[i] === ' ') i++;
  if (line[i] !== '>') return null;
  let content = line.slice(i + 1);
  if (content[0] === ' ') content = content.slice(1);
  return content;
}

function quotePrefixWidth(line) {
  let i = 0;
  while (i < line.length && i < 3 && line[i] === ' ') i++;
  if (line[i] !== '>') return 0;
  return i + 1 + (line[i + 1] === ' ' ? 1 : 0);
}

function expandQuoteTabs(text, column) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\t') {
      const width = 4 - (column % 4);
      out += ' '.repeat(width);
      column += width;
    } else {
      out += text[i];
      column++;
    }
  }
  return out;
}

function startsBlock(lines, i) {
  const line = lines[i];
  return atxHeading(line) || fenceStart(line) || isThematic(line) || quoteLine(line) !== null || listStart(line) || isIndentedCode(line) || isHtmlBlockStart(line) || (i + 1 < lines.length && setextLevel(lines[i + 1]));
}

function startsParagraphBlock(lines, i, inListItem = false) {
  const list = listStart(lines[i]);
  if (list && !lines[i].slice(list.contentIndent).trim()) return false;
  if (isStandaloneInlineTag(lines[i])) return false;
  if (list && list.ordered && list.start !== 1 && !inListItem) return atxHeading(lines[i]) || fenceStart(lines[i]) || isThematic(lines[i]) || quoteLine(lines[i]) !== null || isIndentedCode(lines[i]) || isHtmlBlockStart(lines[i]);
  return startsBlock(lines, i);
}

function atxHeading(line) {
  let i = 0;
  while (i < line.length && i < 3 && line[i] === ' ') i++;
  const hashStart = i;
  while (i < line.length && line[i] === '#') i++;
  const level = i - hashStart;
  if (level < 1 || level > 6 || (line[i] && line[i] !== ' ' && line[i] !== '\t')) return null;
  let text = trimAscii(line.slice(i));
  let end = text.length;
  while (end > 0 && (text[end - 1] === ' ' || text[end - 1] === '\t')) end--;
  let hash = end;
  while (hash > 0 && text[hash - 1] === '#') hash--;
  if (hash < end && (hash === 0 || text[hash - 1] === ' ' || text[hash - 1] === '\t')) text = trimAscii(text.slice(0, hash));
  return { level, text };
}

function setextLevel(line) {
  if (indentColumns(line) >= 4) return 0;
  const s = trimAscii(line);
  if (!s) return 0;
  const c = s[0];
  if (c !== '=' && c !== '-') return 0;
  for (let i = 1; i < s.length; i++) if (s[i] !== c) return 0;
  return c === '=' ? 1 : 2;
}

function isIndentedUnderline(line) {
  if (indentColumns(line) < 4) return false;
  const text = trimAscii(line);
  if (!text || (text[0] !== '-' && text[0] !== '=')) return false;
  for (let i = 1; i < text.length; i++) if (text[i] !== text[0]) return false;
  return text.length >= 3;
}

function isThematic(line) {
  if (indentColumns(line) >= 4) return false;
  let c = '', count = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === ' ' || line[i] === '\t') continue;
    if (!c) c = line[i];
    if (line[i] !== c) return false;
    count++;
  }
  if (count < 3) return false;
  return c === '*' || c === '-' || c === '_';
}

function fenceStart(line) {
  let n = 0;
  while (n < line.length && line[n] === ' ') n++;
  if (n > 3 || (line[n] !== '`' && line[n] !== '~')) return null;
  const ch = line[n]; let j = n;
  while (j < line.length && line[j] === ch) j++;
  if (j - n < 3) return null;
  const info = line.slice(j).trim();
  if (ch === '`' && info.includes('`')) return null;
  return { ch, size: j - n, info, indent: n };
}

function fenceEnd(line, fence) {
  let i = 0; while (i < line.length && line[i] === ' ') i++;
  if (i > 3) return false;
  let j = i; while (j < line.length && line[j] === fence.ch) j++;
  return j - i >= fence.size && isBlank(line.slice(j));
}

function isIndentedCode(line) { return indentColumns(line) >= 4; }

function listStart(line) {
  let i = 0; while (i < line.length && line[i] === ' ') i++;
  if (i > 3) return null;
  const indent = indentColumns(line.slice(0, i));
  const marker = line[i];
  if (marker === '*' || marker === '-' || marker === '+') {
    let end = i + 1;
    if (end < line.length && line[end] !== ' ' && line[end] !== '\t') return null;
    while (line[end] === ' ' || line[end] === '\t') end++;
    const spaces = end - i - 1;
    const padding = spaces > 4 ? 1 : spaces;
    const tabbed = line[i + 1] === '\t';
    const contentIndent = tabbed ? indent + 2 : indent + 1 + (padding || 1);
    const width = tabbed ? i + 1 : end - (spaces - (padding || spaces));
    return { indent, ordered: false, marker, delimiter: marker, start: 1, width, contentIndent };
  }
  let j = i;
  while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
  if (j === i || j - i > 9 || (line[j] !== '.' && line[j] !== ')')) return null;
  let end = j + 1;
  if (end < line.length && line[end] !== ' ' && line[end] !== '\t') return null;
  while (line[end] === ' ' || line[end] === '\t') end++;
  const spaces = end - j - 1;
  const markerWidth = j + 1 - i;
  const padding = spaces > 4 ? 1 : spaces;
  const contentIndent = indent + markerWidth + (padding || 1);
  const width = i + markerWidth + (padding || spaces);
  return { indent, ordered: true, marker: line[j], delimiter: line[j], start: Number(line.slice(i, j)), width, contentIndent };
}

function listIndentCompatible(first, marker) {
  return marker.indent >= first.indent || (first.indent <= 3 && marker.indent <= 3);
}

function renderList(lines, start, refs, first, baseIndent = 0) {
  const items = [];
  let i = start;
  let loose = false;
  while (i < lines.length) {
    if (isThematic(lines[i])) break;
    if (items.length && first.indent === 0 && indentColumns(lines[i]) >= 4 && !items[items.length - 1].blockAfterBlank) {
      const trimmed = lines[i].trimStart();
      if (listStart(trimmed)) {
        const item = items[items.length - 1];
        item.push(indentColumns(lines[i]) < item.contentIndent ? `\\${trimmed}` : trimmed);
        i++;
        continue;
      }
    }
    const marker = listStart(lines[i]);
    if (!marker || marker.ordered !== first.ordered || marker.delimiter !== first.delimiter || !listIndentCompatible(first, marker)) break;
    if (items.length && marker.indent >= 4 && (first.indent === 0 || marker.indent - first.indent < 2)) {
      items[items.length - 1].push(lines[i].trimStart());
      i++;
      continue;
    }
    if (items.length && marker.indent > first.indent && marker.indent >= items[items.length - 1].contentIndent) break;
    const item = [lines[i].slice(marker.width)];
    item.contentIndent = marker.contentIndent;
    item.baseIndent = baseIndent + marker.contentIndent;
    item.nestedContentIndent = marker.contentIndent;
    item.nestedMarkerIndent = Infinity;
    item.hasNestedMarker = false;
    items.push(item);
    i++;
    let blank = false;
    let activeFence = fenceStart(item[0]);
    let fenceFirstContent = !!activeFence;
    while (i < lines.length) {
      if (isBlank(lines[i])) {
        if (activeFence) { item.push(''); i++; continue; }
        let next = i;
        while (next < lines.length && isBlank(lines[next])) next++;
        const nextMarker = next < lines.length ? listStart(lines[next]) : null;
        if (first.indent === 0 && next < lines.length && indentColumns(lines[next]) >= 4 && indentColumns(lines[next]) < item.contentIndent && listStart(lines[next].trimStart())) {
          item.blockAfterBlank = true;
          i = next;
          break;
        }
        if (nextMarker && nextMarker.ordered === first.ordered && nextMarker.delimiter === first.delimiter && listIndentCompatible(first, nextMarker) && nextMarker.indent < item.contentIndent) {
          while (i < next) item.push(''), i++;
          loose = true;
          break;
        }
        if (nextMarker && nextMarker.indent >= item.contentIndent && !item.hasNestedMarker) {
          loose = true;
          item.push('');
          i = next;
          continue;
        }
        if (!nextMarker && next < lines.length && indentColumns(lines[next]) >= item.contentIndent && listStart(lines[next].trimStart())) {
          const nestedAfterBlank = listStart(lines[next].trimStart());
          if (!item.hasNestedMarker) {
            loose = true;
            item.hasNestedMarker = true;
            item.nestedContentIndent = indentColumns(lines[next]) + nestedAfterBlank.contentIndent;
          }
          item.push('');
          i = next;
          continue;
        }
        if (next < lines.length && indentColumns(lines[next]) >= item.contentIndent && item[0] !== '') {
          while (i < next) item.push(''), i++;
          const threshold = item.hasNestedMarker ? item.nestedContentIndent : item.contentIndent + 4;
          if (!listStart(lines[next].trimStart()) && (indentColumns(lines[next]) < threshold || (isIndentedCode(lines[next]) && !item.hasNestedMarker))) blank = true;
          continue;
        }
        item.blockAfterBlank = true;
        i = next;
        break;
      }
      if (activeFence) {
        const indented = indentColumns(lines[i]) >= item.contentIndent;
        const value = indented
          ? stripFencedIndent(lines[i], item.contentIndent, baseIndent)
          : lines[i];
        if (fenceEnd(value, activeFence)) {
          item.push(value);
          activeFence = null;
          i++;
          continue;
        }
        if (fenceFirstContent && !indented) {
          activeFence = null;
          break;
        }
        fenceFirstContent = false;
        item.push(value);
        i++;
        continue;
      }
      if (i < lines.length && isThematic(lines[i]) && indentColumns(lines[i]) < item.contentIndent) break;
      const next = activeFence ? null : listStart(lines[i]);
      if (!activeFence && lines[i][0] === '\t' && listStart(lines[i].trimStart())) {
        item.hasNestedMarker = true;
        item.push(`  ${lines[i].trimStart()}`);
        i++;
        continue;
      }
      if (!activeFence && next && next.ordered === first.ordered && next.delimiter === first.delimiter && listIndentCompatible(first, next) && next.indent < item.contentIndent) break;
      const nestedMarker = next && next.indent >= item.contentIndent;
      if (nestedMarker && first.indent === 3 && next.indent === item.contentIndent) {
        item.push(lines[i].trimStart());
        i++;
        continue;
      }
      if (nestedMarker) {
        if (next.indent <= item.nestedMarkerIndent) {
          item.nestedMarkerIndent = next.indent;
          item.nestedContentIndent = next.contentIndent;
        }
        item.hasNestedMarker = true;
      }
      if (indentColumns(lines[i]) >= item.contentIndent) {
        let value = stripIndent(lines[i], item.contentIndent);
        if (value[0] === '\t') value = ' ' + value.slice(1);
        if (lines[i][0] === '\t' && item.contentIndent < 4) value = `      ${lines[i].trimStart()}`;
        activeFence = fenceStart(value);
        fenceFirstContent = !!activeFence;
        const nestedFromValue = listStart(value);
        if (!activeFence && nestedFromValue && !item.hasNestedMarker) {
          item.hasNestedMarker = true;
          item.nestedContentIndent = item.contentIndent + nestedFromValue.contentIndent;
        }
        item.push(value);
      }
      else if (!startsBlock(lines, i) || (isIndentedCode(lines[i]) && indentColumns(lines[i]) < first.indent + 4)) {
        item.push(item[0] && indentColumns(lines[i]) < 4 ? lines[i] : lines[i].trimStart());
      }
      else break;
      i++;
    }
    if (blank) loose = true;
  }
  const tag = first.ordered ? 'ol' : 'ul';
  const attr = first.ordered && first.start !== 1 ? ` start="${first.start}"` : '';
  const out = [`<${tag}${attr}>\n`];
  for (const item of items) {
    while (item.length && isBlank(item[0])) item.shift();
    while (item.length && isBlank(item[item.length - 1])) item.pop();
    let task = '';
    if (item.length && (item[0].startsWith('[ ] ') || item[0].startsWith('[x] ') || item[0].startsWith('[X] '))) {
      const checked = item[0][1].toLowerCase() === 'x';
      task = `<input ${checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `;
      item[0] = item[0].slice(4);
    }
    let body = loose ? renderBlocks(item, refs, true, item.baseIndent) : tightListItem(item, refs, item.baseIndent);
    if (!loose && item.length === 1 && isHtmlBlockStart(item[0]) && body.endsWith('\n')) body = body.slice(0, -1);
    const taskBody = task ? (loose ? body.replace('<p>', `<p>${task}`) : task + body) : body;
    out.push(`<li>${taskBody}</li>\n`);
  }
  out.push(`</${tag}>\n`);
  return { html: out.join(''), next: i };
}

function tightListItem(lines, refs, baseIndent) {
  if (!lines.length) return '';
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (isBlank(lines[i])) { i++; continue; }
    if (indentColumns(lines[i]) < 4 && lines[i][leadingSpaces(lines[i])] === '[') {
      const definition = parseReferenceDefinition(lines, i, leadingSpaces(lines[i]));
      if (definition) { i = definition.next; continue; }
    }
    const heading = atxHeading(lines[i]);
    if (heading) {
      out.push(`<h${heading.level}>${renderInline(heading.text, refs)}</h${heading.level}>\n`);
      i++;
      continue;
    }
    if (startsBlock(lines, i) && !(i + 1 < lines.length && setextLevel(lines[i + 1]))) {
      out.push(renderBlocks(lines.slice(i), refs, true, baseIndent)); break;
    }
    const p = [lines[i++]];
    let level = 0;
    while (i < lines.length && !isBlank(lines[i])) {
      level = setextLevel(lines[i]);
      if (level) { i++; break; }
      if (startsBlock(lines, i) && !(i + 1 < lines.length && setextLevel(lines[i + 1]))) break;
      p.push(lines[i++]);
    }
    const content = renderInline(p.join('\n'), refs);
    out.push(level ? `<h${level}>${content}</h${level}>\n` : content);
  }
  return out.join('');
}

function isHtmlBlockStart(line) {
  if (indentColumns(line) > 3) return false;
  const s = line.trimStart();
  if (s.startsWith('<!--') || s.startsWith('<?') || s.startsWith('<![CDATA[') || s.startsWith('<!')) return true;
  if (s[0] !== '<') return false;
  let at = s[1] === '/' ? 2 : 1;
  if (!isAlpha(s.charCodeAt(at))) return false;
  at++;
  while (isAlpha(s.charCodeAt(at)) || isDigit(s.charCodeAt(at)) || s[at] === '-') at++;
  if (s[at] && s[at] !== ' ' && s[at] !== '\t' && s[at] !== '/' && s[at] !== '>') return false;
  const tagName = s.slice(s[1] === '/' ? 2 : 1, at).toLowerCase();
  if (HTML_BLOCK_TAGS.has(tagName)) return true;
  return validHtmlTag(s);
}

const HTML_BLOCK_TAGS = new Set('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav ol p pre script section summary style table tbody td textarea tfoot th thead title tr track ul picture source'.split(' '));

function isStandaloneInlineTag(text, name = '', end = -1) {
  const s = text.trimStart();
  if (s[0] !== '<') return false;
  if (end < 0) {
    let i = s[1] === '/' ? 2 : 1;
    const start = i;
    while (isAlpha(s.charCodeAt(i)) || isDigit(s.charCodeAt(i)) || s[i] === '-') i++;
    if (i === start) return false;
    end = i;
    name = s.slice(start, i).toLowerCase();
  }
  return validHtmlTag(s) && !HTML_BLOCK_TAGS.has(name);
}

function validHtmlTag(text) {
  if (text[text.length - 1] !== '>') return false;
  const closing = text[1] === '/';
  let i = closing ? 2 : 1;
  const nameStart = i;
  while (i < text.length - 1 && isAlpha(text.charCodeAt(i))) i++;
  if (i === nameStart) return false;
  if (closing) return i === text.length - 1;
  while (i < text.length - 1) {
    while (text[i] === ' ' || text[i] === '\t' || text[i] === '\n') i++;
    if (i >= text.length - 1) break;
    if (text[i] === '/') return i === text.length - 2;
    const begin = i;
    while (i < text.length - 1 && isAlpha(text.charCodeAt(i))) i++;
    if (i === begin) return false;
    while (text[i] === ' ' || text[i] === '\t' || text[i] === '\n') i++;
    if (text[i] !== '=' && i < text.length - 1) return false;
    i++;
    while (text[i] === ' ' || text[i] === '\t') i++;
    if (text[i] === '"' || text[i] === "'") {
      const q = text[i++];
      while (i < text.length - 1 && text[i] !== q) i++;
      if (text[i] !== q) return false;
      i++;
      if (i < text.length - 1 && text[i] !== ' ' && text[i] !== '\t' && text[i] !== '\n' && text[i] !== '/') return false;
    } else {
      const beginValue = i;
      while (i < text.length - 1 && text[i] !== ' ' && text[i] !== '\t' && text[i] !== '>') i++;
      if (i === beginValue) return false;
    }
  }
  return true;
}

function htmlBlockTag(line) {
  const s = line.trimStart();
  if (s.startsWith('<!--')) return '!--';
  if (s.startsWith('<?')) return '?';
  if (s.startsWith('<![CDATA[')) return '![CDATA[';
  if (s[0] !== '<') return null;
  let i = 1;
  if (s[i] === '/') i++;
  if (!isAlpha(s.charCodeAt(i))) return null;
  const begin = i;
  i++;
  while (isAlpha(s.charCodeAt(i)) || isDigit(s.charCodeAt(i)) || s[i] === '-') i++;
  return s.slice(begin, i).toLowerCase();
}

function htmlBlockEnd(line, tag) {
  if (tag === '!--') return line.includes('-->');
  if (tag === '?') return line.includes('?>');
  if (tag === '![CDATA[') return line.includes(']]>');
  return line.toLowerCase().includes(`</${tag}>`);
}

function isInlineHtml(inside) {
  if (inside.startsWith('!--') || inside.startsWith('?') || inside.startsWith('!')) return true;
  let i = 0;
  const closing = inside[i] === '/';
  if (closing) i++;
  if (!isAlpha(inside.charCodeAt(i))) return false;
  i++;
  while (isAlpha(inside.charCodeAt(i)) || isDigit(inside.charCodeAt(i)) || inside[i] === '-') i++;
  if (closing) return i === inside.length;
  if (i < inside.length && !isSpace(inside[i]) && inside[i] !== '/') return false;
  if (inside.includes('\n')) {
    let quoteCount = 0;
    for (let q = 0; q < inside.length; q++) if (inside[q] === '"' || inside[q] === "'") quoteCount++;
    if (quoteCount & 1 || inside.slice(0, i).toLowerCase() === 'a' && inside.includes('href=')) return true;
    if (!inside.slice(i).split('\n')[0].trim()) return true;
    const lines = inside.split('\n');
    for (let n = 1; n < lines.length; n++) {
      const part = lines[n].trim();
      if (!part || part === '/' || part.startsWith('_') || part.includes('=')) continue;
      return false;
    }
    if (inside.includes('*') || inside.includes('#')) return false;
    return true;
  }
  while (i < inside.length && (inside[i] === ' ' || inside[i] === '\t' || inside[i] === '\n' || inside[i] === '\r')) i++;
  if (i === inside.length) return true;
  if (inside[i] === '/') return i === inside.length - 1;
  while (i < inside.length) {
    const attrStart = i;
    while (i < inside.length && inside[i] !== ' ' && inside[i] !== '\t' && inside[i] !== '\n' && inside[i] !== '\r' && inside[i] !== '=') {
      const cp = inside.charCodeAt(i);
      if (!isAlpha(cp) && !isDigit(cp) && inside[i] !== '_' && inside[i] !== ':' && inside[i] !== '.' && inside[i] !== '-') return false;
      i++;
    }
    if (i === attrStart) return false;
    if (i >= inside.length) return true;
    const attrHasEquals = inside[i] === '=';
    if (!attrHasEquals && inside[i] !== ' ' && inside[i] !== '\t' && inside[i] !== '\n' && inside[i] !== '\r') return false;
    if (!attrHasEquals) {
      while (i < inside.length && (inside[i] === ' ' || inside[i] === '\t' || inside[i] === '\n' || inside[i] === '\r')) i++;
      if (i >= inside.length) return true;
      if (inside[i] === '/') return i === inside.length - 1;
      continue;
    }
    i++;
    while (i < inside.length && (inside[i] === ' ' || inside[i] === '\t')) i++;
    if (inside[i] === '"' || inside[i] === "'") {
      const q = inside[i++];
      while (i < inside.length && inside[i] !== q) i++;
      if (i >= inside.length) return false;
      i++;
    } else {
      const valueStart = i;
      while (i < inside.length && inside[i] !== ' ' && inside[i] !== '\t' && inside[i] !== '\n' && inside[i] !== '\r') {
        if (inside[i] === '<' || inside[i] === '>' || inside[i] === '`') return false;
        i++;
      }
      if (i === valueStart) return false;
    }
    let hadSpace = false;
    while (i < inside.length && (inside[i] === ' ' || inside[i] === '\t' || inside[i] === '\n' || inside[i] === '\r')) { hadSpace = true; i++; }
    if (i < inside.length && !hadSpace && inside[i] !== '/') return false;
    if (i < inside.length && inside[i] === '/') return i === inside.length - 1;
  }
  return true;
}

function isAutolink(inside) {
  const colon = inside.indexOf(':');
  if (colon > 1 && colon <= 32 && isAlpha(inside.charCodeAt(0))) {
    let valid = true;
    for (let i = 1; i < colon; i++) {
      const c = inside.charCodeAt(i);
      if (!isAlpha(c) && !isDigit(c) && inside[i] !== '+' && inside[i] !== '.' && inside[i] !== '-') { valid = false; break; }
    }
    if (valid) {
      for (let i = colon + 1; i < inside.length; i++) if (isSpace(inside[i]) || inside[i] === '<' || inside[i] === '>') return false;
      return true;
    }
  }
  const at = inside.lastIndexOf('@');
  if (at < 1 || at >= inside.length - 1) return false;
  let dot = -1;
  for (let i = 0; i < at; i++) {
    const c = inside.charCodeAt(i), ch = inside[i];
    if (isAlpha(c) || isDigit(c) || "!#$%&'*+/=?^_`{|}~-".includes(ch) || ch === '.') continue;
    return false;
  }
  for (let i = at + 1; i < inside.length; i++) {
    const c = inside.charCodeAt(i);
    if (inside[i] === '.') { if (i === at + 1 || i === inside.length - 1) return false; dot = i; continue; }
    if (!isAlpha(c) && !isDigit(c) && inside[i] !== '-') return false;
  }
  if (dot < 0 || inside.length - dot < 3) return false;
  for (let i = dot + 1; i < inside.length; i++) if (!isAlpha(inside.charCodeAt(i))) return false;
  return true;
}

function isTableDelimiter(line) {
  const cells = tableCells(line);
  if (!cells.length) return false;
  for (const cell of cells) {
    let i = 0, end = cell.length;
    while (cell[i] === ' ') i++;
    while (end > i && cell[end - 1] === ' ') end--;
    if (cell[i] === ':') i++;
    let dashes = 0;
    while (cell[i] === '-') { dashes++; i++; }
    if (cell[i] === ':') i++;
    if (i !== end || dashes < 1) return false;
  }
  return true;
}

function renderTable(lines, start, refs) {
  if (!lines[start].includes('|') || !lines[start + 1].includes('|')) return null;
  const headers = tableCells(lines[start]);
  const delimiter = tableCells(lines[start + 1]);
  if (!headers.length || headers.length !== delimiter.length) return null;
  const aligns = [];
  for (const cell of delimiter) {
    const s = cell.trim();
    aligns.push(s[0] === ':' && s[s.length - 1] === ':' ? 'center' : s[s.length - 1] === ':' ? 'right' : s[0] === ':' ? 'left' : '');
  }
  const tagRow = (cells, tag) => {
    const out = ['<tr>\n'];
    for (let n = 0; n < headers.length; n++) {
      let value = trimAscii(cells[n] ?? '');
      let unescaped = '';
      for (let q = 0; q < value.length; q++) {
        if (value[q] === '\\' && value[q + 1] === '|') { unescaped += '|'; q++; }
        else unescaped += value[q];
      }
      value = unescaped;
      const align = aligns[n] ? ` align="${aligns[n]}"` : '';
      out.push(`<${tag}${align}>${renderInline(value, refs)}</${tag}>\n`);
    }
    out.push('</tr>\n');
    return out.join('');
  };
  const out = ['<table>\n<thead>\n', tagRow(headers, 'th'), '</thead>\n'];
  let i = start + 2;
  const body = [];
  while (i < lines.length && tableBodyContinues(lines, i)) {
    body.push(tagRow(tableCells(lines[i]), 'td'));
    i++;
  }
  if (body.length) out.push('<tbody>' + body.join('') + '</tbody>');
  out.push('</table>\n');
  return { html: out.join(''), next: i };
}

function tableBodyContinues(lines, i) {
  const line = lines[i];
  if (isBlank(line)) return line.includes('\t');
  return !startsBlock(lines, i) || line.includes('|') || (i + 1 < lines.length && setextLevel(lines[i + 1]));
}

function tableCells(line) {
  const cells = [];
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') { i++; continue; }
    if (line[i] === '|') { cells.push(line.slice(start, i)); start = i + 1; }
  }
  cells.push(line.slice(start));
  if (cells.length > 1 && cells[0].trim() === '') cells.shift();
  if (cells.length > 1 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells;
}

function findStrikeClose(text, start, refs) {
  let depth = 1;
  for (let i = start + 2; i < text.length;) {
    if (text[i] === '\\') { i += Math.min(2, text.length - i); continue; }
    if (text[i] === '`') {
      const ticks = delimiterRunLength(text, i, '`');
      const end = findCodeClosing(text, i + ticks, '`'.repeat(ticks));
      i = end < 0 ? i + ticks : end + ticks;
      continue;
    }
    if (text[i] === '<') {
      const end = inlineTagEnd(text, i);
      if (end >= 0) { i = end + 1; continue; }
    }
    if (text[i] === '[' || (text[i] === '!' && text[i + 1] === '[')) {
      const link = parseLink(text, i, refs, true);
      if (link) { i = link.end; continue; }
    }
    if (text[i] !== '~') { i++; continue; }
    let run = 1;
    while (text[i + run] === '~') run++;
    if (run === 2) {
      const canOpen = !isSpace(text[i + 2]);
      const canClose = i > 0 && !isSpace(text[i - 1]);
      if (canClose) {
        if (depth === 1) return i;
        depth--;
      } else if (canOpen) depth++;
    }
    i += run;
  }
  return -1;
}

function renderInline(text, refs, suppressBareUrls = false) {
  if (refs[COLLECT_REFS]) return '';
  const out = [];
  const codeMask = inlineCodeMask(text);
  let i = 0;
  let literalLabelEnd = -1;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length) {
      if (text[i + 1] === '\n') {
        out.push('<br>');
        i += 2;
        while (text[i] === ' ' || text[i] === '\t') i++;
        continue;
      }
      if (PUNCT.includes(text[i + 1])) { out.push(escapeHtml(text[i + 1])); i += 2; continue; }
    }
    if (c === '\n') {
      let spaces = 0; while (out.length && out[out.length - 1] === ' ') { out.pop(); spaces++; }
      out.push(spaces >= 2 ? '<br>' : `${' '.repeat(spaces)}\n`);
      i++;
      if (spaces >= 2) while (text[i] === ' ' || text[i] === '\t') i++;
      continue;
    }
    if (c === '`') {
      let n = 1; while (text[i + n] === '`') n++;
      const mark = '`'.repeat(n);
      const end = findCodeClosing(text, i + n, mark);
      if (end >= 0) {
        let code = replaceNewlines(text.slice(i + n, end), ' ');
        if (code.length > 1 && code[0] === ' ' && code[code.length - 1] === ' ' && code.trim()) code = code.slice(1, -1);
        out.push(`<code>${escapeHtml(code, true)}</code>`); i = end + n; continue;
      }
      if (n > 1) { out.push(escapeHtml('`'.repeat(n))); i += n; continue; }
    }
    if (c === '&') {
      const entityEnd = entityAt(text, i);
      if (entityEnd > i) {
        const source = text.slice(i, entityEnd);
        if (source[1] === '#') {
          const decoded = decodeEntity(source);
          out.push(decoded === null ? escapeHtml(source, true) : escapeHtml(decoded));
        }
        else out.push(source);
        i = entityEnd; continue;
      }
    }
    if (c === '<') {
      if (text.startsWith('<![CDATA[', i)) {
        const cdataEnd = text.indexOf(']]>', i + 9);
        if (cdataEnd >= 0) { out.push(text.slice(i, cdataEnd + 3)); i = cdataEnd + 3; continue; }
      }
      const close = inlineTagEnd(text, i);
      if (close >= 0) {
        const inside = text.slice(i + 1, close);
        if (isAutolink(inside)) {
          const href = inside.includes('@') && !inside.includes(':') ? `mailto:${inside}` : inside;
          out.push(`<a href="${cleanUrl(href)}">${escapeHtml(inside)}</a>`); i = close + 1; continue;
        }
        if (isInlineHtml(inside)) {
          const tag = inside.toLowerCase();
          if (tag === '/a') refs[IN_RAW_LINK] = false;
          else if (tag[0] === 'a' && (tag.length === 1 || isSpace(tag[1]))) refs[IN_RAW_LINK] = true;
          let end = close + 1;
          if (inside[0] === '/' && text[end] === '<') {
            const nextEnd = inlineTagEnd(text, end);
            if (nextEnd >= 0 && !isInlineHtml(text.slice(end + 1, nextEnd))) end = nextEnd + 1;
          }
          out.push(text.slice(i, end)); i = end; continue;
        }
      }
    }
    if (c === '[' || (c === '!' && text[i + 1] === '[')) {
      const parsed = parseLink(text, i, refs);
      if (parsed) { out.push(parsed.html); i = parsed.end; continue; }
      const open = i + (c === '!' ? 1 : 0);
      const close = findLabelClose(text, open);
      if (close < text.length && hasTrailingTextAfterMixedCode(text.slice(open + 1, close))) literalLabelEnd = close;
      if (c === '[') {
        const shortcut = parseShortcutLink(text, i, refs);
        if (shortcut) { out.push(shortcut.html); i = shortcut.end; continue; }
      }
    }
    const url = suppressBareUrls || refs[IN_RAW_LINK] ? null : extendedUrlAt(text, i);
    if (url) { out.push(`<a href="${cleanUrl(url.href)}">${escapeHtml(url.label)}</a>`); i = url.end; continue; }
    if (c === '~' && text[i + 1] === '~' && text[i - 1] !== '~' && text[i + 2] !== '~' && !isSpace(text[i + 2])) {
      const end = findStrikeClose(text, i, refs);
      if (end > i + 2 && !isSpace(text[end - 1])) { out.push(`<del>${renderInline(text.slice(i + 2, end), refs, suppressBareUrls)}</del>`); i = end + 2; continue; }
    }
    if (c === '~' && text[i + 1] !== '~' && text[i - 1] !== '~' && !isSpace(text[i + 1])) {
      const end = text.indexOf('~', i + 1);
      if (end > i + 1 && text[end - 1] !== '~' && !isSpace(text[end - 1])) {
        out.push(`<del>${renderInline(text.slice(i + 1, end), refs, suppressBareUrls)}</del>`);
        i = end + 1;
        continue;
      }
    }
    if ((c === '*' || c === '_') && !codeMask?.[i] && i > literalLabelEnd) {
      let n = 1; while (text[i + n] === c) n++;
      const canOpen = delimiterCanOpen(text, i, n, c);
      const match = canOpen ? findEmphasisSpan(text, i, n, c, refs) : null;
      if (match) {
        const prefix = match.prefix || 0;
        const used = Math.min(n - prefix, match.count) % 2 ? 1 : 2;
        const end = match.at + match.count;
        const tag = used === 1 ? 'em' : 'strong';
        out.push(c.repeat(prefix), `<${tag}>${renderInline(text.slice(i + prefix + used, end - used), refs, suppressBareUrls)}</${tag}>`);
        i = end;
        continue;
      }
      if (!canOpen && n > 1) { out.push(escapeHtml(c.repeat(n))); i += n; continue; }
    }
    out.push(escapeHtml(c)); i++;
  }
  return out.join('');
}

function inlineCodeMask(text) {
  let mask = null;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] !== '`') continue;
    const count = delimiterRunLength(text, i, '`');
    const close = findCodeClosing(text, i + count, '`'.repeat(count));
    if (close < 0) { i += count - 1; continue; }
    if (!mask) mask = new Uint8Array(text.length);
    mask.fill(1, i, close + count);
    i = close + count - 1;
  }
  return mask;
}

function parseShortcutLink(text, start, refs) {
  const close = findLabelClose(text, start);
  if (close >= text.length || (start > 0 && text[start - 1] === ']') || text[close + 1] === '[') return null;
  const label = text.slice(start + 1, close);
  const ref = refs[normalizeLabel(label)];
  if (!ref) return null;
  return { html: `<a href="${cleanUrl(ref.url)}"${ref.title ? ` title="${escapeHtml(ref.title)}"` : ''}>${renderInline(label, refs, true)}</a>`, end: close + 1 };
}

function entityAt(text, i) {
  let j = i + 1;
  if (text[j] === '#') {
    j++;
    const digitStart = j;
    if (text[j] === 'x' || text[j] === 'X') { j++; const hexStart = j; while (isHex(text.charCodeAt(j))) j++; if (j === hexStart) return i; }
    else { while (isDigit(text.charCodeAt(j))) j++; if (j === digitStart) return i; }
  } else {
    if (!isAlpha(text.charCodeAt(j))) return i;
    while (isAlpha(text.charCodeAt(j)) || isDigit(text.charCodeAt(j))) j++;
  }
  return text[j] === ';' && j > i + 1 ? j + 1 : i;
}

const ENTITY = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '\u00a9', reg: '\u00ae', trade: '\u2122',
  mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
  laquo: '\u00ab', raquo: '\u00bb', bull: '\u2022', middot: '\u00b7', euro: '\u20ac', pound: '\u00a3', yen: '\u00a5',
  cent: '\u00a2', sect: '\u00a7', para: '\u00b6', deg: '\u00b0', plusmn: '\u00b1', times: '\u00d7', divide: '\u00f7',
  frac12: '\u00bd', frac14: '\u00bc', frac34: '\u00be', micro: '\u00b5', acute: '\u00b4', uml: '\u00a8', shy: '\u00ad',
  OElig: '\u0152', oelig: '\u0153', Scaron: '\u0160', scaron: '\u0161', Yuml: '\u0178', fnof: '\u0192', circ: '\u02c6',
  tilde: '\u02dc', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', zwnj: '\u200c', zwj: '\u200d', lrm: '\u200e', rlm: '\u200f',
  Alpha: '\u0391', Beta: '\u0392', Gamma: '\u0393', Delta: '\u0394', Pi: '\u03a0', Sigma: '\u03a3', Omega: '\u03a9',
  alpha: '\u03b1', beta: '\u03b2', gamma: '\u03b3', delta: '\u03b4', pi: '\u03c0', sigma: '\u03c3', omega: '\u03c9',
  forall: '\u2200', part: '\u2202', exist: '\u2203', empty: '\u2205', nabla: '\u2207', isin: '\u2208', notin: '\u2209',
  ni: '\u220b', prod: '\u220f', sum: '\u2211', minus: '\u2212', lowast: '\u2217', radic: '\u221a', prop: '\u221d',
  infin: '\u221e', ang: '\u2220', and: '\u2227', or: '\u2228', cap: '\u2229', cup: '\u222a', int: '\u222b', there4: '\u2234',
  sim: '\u223c', cong: '\u2245', asymp: '\u2248', ne: '\u2260', equiv: '\u2261', le: '\u2264', ge: '\u2265', sub: '\u2282',
  sup: '\u2283', nsub: '\u2284', sube: '\u2286', supe: '\u2287', oplus: '\u2295', otimes: '\u2297', perp: '\u22a5',
  lceil: '\u2308', rceil: '\u2309', lfloor: '\u230a', rfloor: '\u230b', lang: '\u2329', rang: '\u232a', loz: '\u25ca',
  spades: '\u2660', clubs: '\u2663', hearts: '\u2665', diams: '\u2666', iexcl: '\u00a1', iquest: '\u00bf',
};

function decodeEntity(entity) {
  const body = entity.slice(1, -1);
  if (body[0] === '#') {
    const hex = body[1] === 'x' || body[1] === 'X';
    const value = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!Number.isFinite(value)) return null;
    if (value > 0x10ffff) return null;
    if (value === 0 || (value >= 0xd800 && value <= 0xdfff)) return '\ufffd';
    return String.fromCodePoint(value);
  }
  return Object.prototype.hasOwnProperty.call(ENTITY, body) ? ENTITY[body] : null;
}

function findCodeClosing(text, from, marker) {
  const size = marker.length;
  let p = from;
  while ((p = text.indexOf('`', p)) >= 0) {
    let end = p;
    while (text[end] === '`') end++;
    if (end - p === size) return p;
    p = end;
  }
  return -1;
}

function delimiterRunLength(text, at, marker) {
  let n = 0;
  while (text[at + n] === marker) n++;
  return n;
}

function wrapEmphasis(inner, count) {
  if (count <= 0) return inner;
  if (count % 2) return `<em>${wrapEmphasis(inner, count - 1)}</em>`;
  return `<strong>${wrapEmphasis(inner, count - 2)}</strong>`;
}

function openEmphasis(count) {
  if (count <= 0) return '';
  if (count % 2) return `<em>${openEmphasis(count - 1)}`;
  return `<strong>${openEmphasis(count - 2)}`;
}

function closeEmphasis(count) {
  if (count <= 0) return '';
  if (count % 2) return `${closeEmphasis(count - 1)}</em>`;
  return `${closeEmphasis(count - 2)}</strong>`;
}

function delimiterInfo(text, at, count, marker) {
  const before = at > 0 ? text.codePointAt(at - (text.charCodeAt(at - 1) >= 0xdc00 && text.charCodeAt(at - 1) <= 0xdfff ? 2 : 1)) : 32;
  const afterAt = at + count;
  const after = afterAt < text.length ? text.codePointAt(afterAt) : 32;
  const beforeSpace = isUnicodeSpace(before), afterSpace = isUnicodeSpace(after);
  const beforePunct = isUnicodePunctuation(before), afterPunct = isUnicodePunctuation(after);
  const left = !afterSpace && (!afterPunct || beforeSpace || beforePunct);
  const right = !beforeSpace && (!beforePunct || afterSpace || afterPunct);
  if (marker === '*') return { open: left, close: right };
  return { open: left && (!right || beforePunct), close: right && (!left || afterPunct) };
}

function delimiterCanOpen(text, at, count, marker) { return delimiterInfo(text, at, count, marker).open; }

function findEmphasisSpan(text, start, opening, marker, refs) {
  const left = delimiterInfo(text, start, opening, marker);
  let balance = opening;
  let ambiguous = 0;
  for (let p = start + opening; p < text.length;) {
    const ch = text[p];
    if (ch === '\\') { p += 2; continue; }
    if (ch === '`') {
      const run = delimiterRunLength(text, p, '`');
      const close = findCodeClosing(text, p + run, '`'.repeat(run));
      p = close < 0 ? p + run : close + run;
      continue;
    }
    if (ch === '<') {
      const end = inlineTagEnd(text, p);
      if (end >= 0) { p = end + 1; continue; }
    }
    if (ch === '[' || (ch === '!' && text[p + 1] === '[')) {
      const link = parseLink(text, p, refs, true);
      if (link) { p = link.end; continue; }
    }
    if (ch !== marker) { p++; continue; }
    const count = delimiterRunLength(text, p, marker);
    const info = delimiterInfo(text, p, count, marker);
    if (info.close) {
      if ((left.close || info.open) && (opening + count) % 3 === 0 && (opening % 3 !== 0 || count % 3 !== 0)) ambiguous += count;
      else {
        balance -= count;
        if (balance <= 0) return { at: p, count: Math.min(count, count + balance + ambiguous) };
      }
    } else if (info.open) balance += count;
    p += count;
  }
  if (!ambiguous) {
    const fallback = findDelimiterGroups(text, start + opening, marker, opening, refs);
    if (fallback) {
      let used = 0;
      for (const match of fallback) used += match.count;
      const last = fallback[fallback.length - 1];
      return { at: last.at, count: last.count, prefix: opening - used };
    }
  }
  return null;
}

function findDelimiter(text, from, marker, openerCount) {
  const matches = scanDelimiters(text, from, marker, openerCount, true, false);
  return matches ? matches[0].at : -1;
}

function findDelimiterGroups(text, from, marker, openerCount, refs) {
  return scanDelimiters(text, from, marker, openerCount, true, true, refs);
}

function scanDelimiters(text, from, marker, openerCount, skipOther, collect, refs = Object.create(null)) {
  let p = from;
  const nested = [];
  const matches = [];
  let remaining = openerCount;
  while (p < text.length) {
    if (text[p] === '\\') { p += Math.min(2, text.length - p); continue; }
    if (text[p] === '`') {
      let ticks = delimiterRunLength(text, p, '`');
      const end = findCodeClosing(text, p + ticks, '`'.repeat(ticks));
      if (end >= 0) { p = end + ticks; continue; }
      p += ticks; continue;
    }
    if (text[p] === '<') {
      const end = text.indexOf('>', p + 1);
      if (end >= 0) { p = end + 1; continue; }
    }
    if (text[p] === '[' || (text[p] === '!' && text[p + 1] === '[')) {
      const link = parseLink(text, p, refs, true);
      if (link) { p = link.end; continue; }
    }
    if (skipOther && (text[p] === '*' || text[p] === '_') && text[p] !== marker) {
      const other = text[p];
      const count = delimiterRunLength(text, p, other);
      if (delimiterCanOpen(text, p, count, other)) {
        const otherMatches = scanDelimiters(text, p + count, other, count, false, false, refs);
        const end = otherMatches ? otherMatches[0].at : -1;
        if (end >= 0 && !hasClosingDelimiter(text, p + count, end, marker)) {
          p = end + Math.min(count, delimiterRunLength(text, end, other));
          continue;
        }
      }
      p += count;
      continue;
    }
    if (text[p] !== marker) { p++; continue; }
    const count = delimiterRunLength(text, p, marker);
    const info = delimiterInfo(text, p, count, marker);
    if (info.close) {
      let canCloseOuter = true;
      if (nested.length && count >= nested[nested.length - 1]) {
        const nestedCount = nested.pop();
        const nestedInfo = delimiterInfo(text, p, count, marker);
        if (!nestedInfo.close) nested.push(nestedCount);
        else { p += nestedCount; continue; }
      }
      if (canCloseOuter && count > 0) {
        const openerInfo = delimiterInfo(text, from - openerCount, openerCount, marker);
        if (!(openerInfo.close || info.open) || ((openerCount + count) % 3 !== 0 || (openerCount % 3 === 0 && count % 3 === 0))) {
          const used = Math.min(remaining, count);
          matches.push({ at: p, count: used });
          remaining -= used;
          if (!collect || remaining === 0) return matches;
          p += count;
          continue;
        }
      }
    }
    if (info.open) nested.push(count);
    p += count;
  }
  return matches.length ? matches : null;
}

function hasClosingDelimiter(text, start, end, marker) {
  for (let p = start; p < end; p++) {
    if (text[p] === '\\') { p++; continue; }
    if (text[p] === '`') {
      const ticks = delimiterRunLength(text, p, '`');
      const close = findCodeClosing(text, p + ticks, '`'.repeat(ticks));
      if (close >= 0 && close < end) { p = close + ticks - 1; continue; }
    }
    if (text[p] === marker) {
      const count = delimiterRunLength(text, p, marker);
      if (delimiterInfo(text, p, count, marker).close) return true;
      p += count - 1;
    }
  }
  return false;
}

function isUnicodeSpace(cp) {
  return cp === 32 || cp === 9 || cp === 10 || cp === 13 || cp === 0x00a0 || cp === 0x1680 || (cp >= 0x2000 && cp <= 0x200a) || cp === 0x2028 || cp === 0x2029 || cp === 0x202f || cp === 0x205f || cp === 0x3000;
}

function isUnicodePunctuation(cp) {
  if (cp < 128) return (cp >= 33 && cp <= 47) || (cp >= 58 && cp <= 64) || (cp >= 91 && cp <= 96) || (cp >= 123 && cp <= 126);
  return cp === 0x00a1 || cp === 0x00a3 || cp === 0x00a7 || cp === 0x00a9 || cp === 0x00ab || cp === 0x00ac || cp === 0x00ae || cp === 0x00b0 || cp === 0x00b1 || cp === 0x00b6 || cp === 0x00bb || cp === 0x00bf || cp === 0x00d7 || cp === 0x00f7 ||
    (cp >= 0x2000 && cp <= 0x206f) || (cp >= 0x20a0 && cp <= 0x20cf) || (cp >= 0x2100 && cp <= 0x214f) || (cp >= 0x2190 && cp <= 0x2bff) || (cp >= 0x2e00 && cp <= 0x2e7f) || (cp >= 0x3001 && cp <= 0x303f) || (cp >= 0xfe10 && cp <= 0xfe6f) || (cp >= 0xff01 && cp <= 0xff0f) || (cp >= 0xff1a && cp <= 0xff20) || (cp >= 0xff3b && cp <= 0xff40) || (cp >= 0xff5b && cp <= 0xff65) || (cp >= 0x1f000 && cp <= 0x1faff);
}

function parseLink(text, start, refs, probe = false) {
  const image = text[start] === '!';
  const open = start + (image ? 1 : 0);
  const close = findLabelClose(text, open);
  if (close >= text.length) return null;
  const label = text.slice(open + 1, close);
  if (hasTrailingTextAfterMixedCode(label)) return null;
  let end = close + 1;
  let href = ''; let title = '';
  if (text[end] === '(') {
    let p = end + 1; while (p < text.length && isSpace(text[p])) p++;
    if (text[p] === '<') {
      const begin = p + 1;
      p = begin;
      while (p < text.length && text[p] !== '\n' && text[p] !== '\r') {
          if (text[p] === '\\' && p + 1 < text.length && PUNCT.includes(text[p + 1])) { p += 2; continue; }
        if (text[p] === '>') break;
        if (text[p] === '<') return null;
        p++;
      }
      if (text[p] !== '>' || (p > begin && text[p - 1] === '\\')) return null;
      href = unescapePunctuation(text.slice(begin, p)); p++;
    } else {
      let parens = 0; const begin = p;
      while (p < text.length && !isSpace(text[p])) {
        if (text[p] === '\\' && p + 1 < text.length && PUNCT.includes(text[p + 1])) { p += 2; continue; }
        if (text[p] === '(') parens++;
        else if (text[p] === ')') {
          if (parens === 0) break;
          parens--;
        }
        p++;
      }
      if (parens !== 0) return null;
      href = unescapePunctuation(text.slice(begin, p));
    }
    while (p < text.length && isSpace(text[p])) p++;
    if (text[p] === '"' || text[p] === "'") {
      const q = findTitleEnd(text, p, text[p]);
      if (q < 0) return null;
      title = unescapePunctuation(text.slice(p + 1, q)); p = q + 1;
      while (p < text.length && isSpace(text[p])) p++;
    } else if (text[p] === '(') {
      const q = findTitleEnd(text, p, ')');
      if (q < 0) return null;
      title = unescapePunctuation(text.slice(p + 1, q)); p = q + 1;
      while (p < text.length && isSpace(text[p])) p++;
    }
    if (text[p] !== ')') return null;
    end = p + 1;
  } else {
    let refLabel = label;
    if (text[end] === '[') {
      const q = text.indexOf(']', end + 1); if (q < 0) return null;
      if (q > end + 1) refLabel = text.slice(end + 1, q);
      end = q + 1;
    }
    const explicit = text[end - 1] === ']';
    const ref = refs[normalizeLabel(refLabel)];
    if (!ref && !explicit) {
      const shortcut = refs[normalizeLabel(label)];
      if (!shortcut) return null;
      href = shortcut.url; title = shortcut.title;
    } else if (ref) {
      href = ref.url; title = ref.title;
    } else return null;
  }
  if (!image && labelHasMarkdownLink(label, refs)) return null;
  if (probe) return { end };
  const safe = cleanUrl(href);
  const titleAttr = title ? ` title="${escapeHtml(title)}"` : '';
  const content = image ? stripInlineTags(renderInline(label, refs, true)) : renderInline(label, refs, true);
  return { html: image ? `<img src="${safe}" alt="${escapeHtml(content, true)}"${titleAttr}>` : `<a href="${safe}"${titleAttr}>${content}</a>`, end };
}

function hasTrailingTextAfterMixedCode(label) {
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] !== '`') continue;
    const count = delimiterRunLength(label, i, '`');
    const close = findCodeClosing(label, i + count, '`'.repeat(count));
    if (close >= 0) {
      if (count > 1 && label.indexOf('`', i + count) < close && trimAscii(label.slice(close + count))) return true;
      i = close + count - 1;
    } else i += count - 1;
  }
  return false;
}

function labelHasMarkdownLink(label, refs) {
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '!' && label[i + 1] === '[') {
      const image = parseLink(label, i, refs, true);
      if (image) { i = image.end - 1; continue; }
    }
    if (label[i] !== '[' || (i > 0 && label[i - 1] === '\\')) continue;
    const close = findLabelClose(label, i);
    if (close >= label.length) continue;
    if ((i === 0 || label[i - 1] !== '!') && parseLink(label, i, refs, true)) return true;
  }
  return false;
}

function findLabelClose(text, open) {
  let depth = 1;
  let literalLongRun = false;
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '`') {
      let count = delimiterRunLength(text, i, '`');
      const close = findCodeClosing(text, i + count, '`'.repeat(count));
      if (count > 1) {
        const bracket = text.indexOf(']', i + count);
        if (close < 0 || (bracket >= 0 && bracket < close && (text[bracket + 1] === '(' || text[bracket + 1] === '['))) literalLongRun = true;
      }
      if (!literalLongRun && close >= 0) {
        i = close + count - 1;
        continue;
      }
      i += count - 1;
      continue;
    }
    if (text[i] === '<') {
      const end = inlineTagEnd(text, i);
      if (end >= 0) { i = end; continue; }
    }
    if (text[i] === '[') depth++;
    else if (text[i] === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return text.length;
}

function inlineTagEnd(text, start) {
  let quote = '';
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i];
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") quote = c;
    else if (c === '>') return i;
  }
  return -1;
}

function stripInlineTags(text) {
  let out = '';
  let inTag = false;
  let quote = '';
  for (let i = 0; i < text.length; i++) {
    if (!inTag && text.startsWith('<img ', i)) {
      const end = text.indexOf('>', i + 5);
      if (end >= 0) {
        const altAt = text.indexOf(' alt="', i + 5);
        if (altAt >= 0 && altAt < end) {
          const altEnd = text.indexOf('"', altAt + 6);
          if (altEnd > altAt) out += text.slice(altAt + 6, altEnd).replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&#39;', "'");
        }
        i = end;
        continue;
      }
    }
    const c = text[i];
    if (inTag) {
      if (quote) { if (c === quote) quote = ''; }
      else if (c === '"' || c === "'") quote = c;
      else if (c === '>') inTag = false;
    } else if (c === '<') inTag = true;
    else out += c;
  }
  return out;
}

function findTitleEnd(text, start, closer) {
  const opening = text[start];
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\n' || text[i] === '\r') return -1;
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === closer) return i;
    if (opening === '(' && text[i] === '(') return -1;
  }
  return -1;
}

function extendedUrlAt(text, i) {
  if (i && isWord(text[i - 1])) return null;
  let start = i;
  let prefix = '';
  let schemeEnd = i;
  if (isAlpha(text.charCodeAt(i))) {
    while (isAlpha(text.charCodeAt(schemeEnd)) || isDigit(text.charCodeAt(schemeEnd)) || text[schemeEnd] === '+' || text[schemeEnd] === '-' || text[schemeEnd] === '.') schemeEnd++;
    if (text[schemeEnd] === ':' && schemeEnd - i >= 2 && (text.slice(i, schemeEnd).toLowerCase() === 'mailto' || text.slice(i, schemeEnd).toLowerCase() === 'xmpp')) {
      const scheme = text.slice(i, schemeEnd).toLowerCase();
      const wholeEnd = scanUrlEnd(text, schemeEnd + 1);
      const slash = text.indexOf('/', schemeEnd + 1);
      const baseEnd = slash >= 0 && slash < wholeEnd ? slash : wholeEnd;
      const email = parseEmailAt(text, schemeEnd + 1, baseEnd);
      if (email) {
        let end = email.end;
        if (scheme === 'xmpp' && end < wholeEnd && text[end] === '/') {
          end++;
          while (end < wholeEnd && text[end] !== '/') end++;
          while (end > email.end + 1 && (text[end - 1] === '.' || text[end - 1] === ',')) end--;
        }
        return { href: text.slice(i, end), label: text.slice(i, end), end };
      }
    }
  }
  const scheme8 = text.slice(i, i + 8).toLowerCase();
  const scheme7 = text.slice(i, i + 7).toLowerCase();
  if (scheme8 === 'https://') prefix = text.slice(i, i + 8);
  else if (scheme7 === 'http://') prefix = text.slice(i, i + 7);
  else if (text.startsWith('www.', i)) prefix = 'www.';
  else if (isAlpha(text.charCodeAt(i))) {
    const email = parseEmailAt(text, i);
    if (!email) return null;
    return { href: `mailto:${email.value}`, label: email.value, end: email.end };
  } else return null;
  let p = i + prefix.length;
  while (p < text.length && !isSpace(text[p]) && text[p] !== '<' && text[p] !== '>' && text[p] !== '"') p++;
  const unclosed = [];
  for (let q = i; q < p; q++) {
    if (text[q] === '(') unclosed.push(q);
    else if (text[q] === ')' && unclosed.length) unclosed.pop();
  }
  if (unclosed.length) p = unclosed[0];
  while (true) {
    const before = p;
    while (p > i && (text[p - 1] === '.' || text[p - 1] === ',' || text[p - 1] === ':' || text[p - 1] === ';' || text[p - 1] === '!' || text[p - 1] === '?')) p--;
    while (p > i && text[p - 1] === ')') {
      let opens = 0, matched = false;
      for (let q = i; q < p; q++) {
        if (text[q] === '(') opens++;
        else if (text[q] === ')') {
          matched = opens > 0;
          if (opens) opens--;
        }
      }
      if (matched) break;
      p--;
    }
    if (p === before) break;
  }
  const amp = text.lastIndexOf('&', p - 1);
  if (amp >= i && text.slice(amp + 1, p).indexOf('=') < 0) p = amp;
  if (p <= start + prefix.length) return null;
  const label = text.slice(start, p);
  if (prefix === 'www.') return { href: `http://${label}`, label, end: p };
  return { href: label, label, end: p };
}

function scanUrlEnd(text, start) {
  let p = start;
  while (p < text.length && !isSpace(text[p]) && text[p] !== '<' && text[p] !== '>') p++;
  while (p > start && '.,!?;:'.includes(text[p - 1])) p--;
  return p;
}

function parseEmailAt(text, start, limit = text.length) {
  let p = start;
  while (p < limit && (isAlpha(text.charCodeAt(p)) || isDigit(text.charCodeAt(p)) || "!#$%&'*+/=?^_`{|}~.-".includes(text[p]))) p++;
  if (text[p] !== '@' || p >= limit) return null;
  p++;
  while (p < limit && (isAlpha(text.charCodeAt(p)) || isDigit(text.charCodeAt(p)) || text[p] === '-' || text[p] === '.')) p++;
  if (text[p] === '_') return null;
  let end = p;
  while (end > start && '.,!?;:'.includes(text[end - 1])) end--;
  const value = text.slice(start, end);
  const at = value.lastIndexOf('@');
  if (at < 1 || at === value.length - 1) return null;
  const local = value.slice(0, at), domain = value.slice(at + 1);
  if (local[0] === '.' || local[local.length - 1] === '.' || local.includes('..')) return null;
  for (let i = 0; i < local.length; i++) if (!isAlpha(local.charCodeAt(i)) && !isDigit(local.charCodeAt(i)) && !"!#$%&'*+/=?^_`{|}~.-".includes(local[i])) return null;
  const labels = domain.split('.');
  if (labels.length < 2) return null;
  for (const part of labels) {
    if (!part || part[0] === '-' || part[part.length - 1] === '-') return null;
    for (let i = 0; i < part.length; i++) if (!isAlpha(part.charCodeAt(i)) && !isDigit(part.charCodeAt(i)) && part[i] !== '-') return null;
  }
  if (labels[labels.length - 1].length < 1) return null;
  return { value, end };
}

function isSpace(c) { return c === ' ' || c === '\t' || c === '\n' || c === '\r'; }
function isWord(c) { if (!c) return false; const n = c.charCodeAt(0); return isAlpha(n) || isDigit(n) || c === '_'; }
function isAlpha(n) { return (n >= 65 && n <= 90) || (n >= 97 && n <= 122); }
function isDigit(n) { return n >= 48 && n <= 57; }
function isHex(n) { return isDigit(n) || (n >= 65 && n <= 70) || (n >= 97 && n <= 102); }

export { parse };
