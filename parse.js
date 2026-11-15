const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const PUNCT = "!\"#$%&'()*+,\-./:;<=>?@[\\]^_`{|}~";

function escapeHtml(text, encode = false) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '&') {
      const end = encode ? i : entityAt(text, i);
      if (end > i) { out += text.slice(i, end); i = end - 1; }
      else out += '&amp;';
    } else if ((c === '"' || c === "'") && !encode) out += c;
    else out += ESC[c] || c;
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
    out += c.toLowerCase();
  }
  return out;
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) if (line.charCodeAt(i) !== 32 && line.charCodeAt(i) !== 9) return false;
  return true;
}

function indentOf(line) {
  let n = 0;
  for (let i = 0; i < line.length && n < 4; i++) n += line[i] === '\t' ? 4 : 1;
  return n;
}

function stripIndent(line, count) {
  let i = 0;
  while (i < line.length && count > 0) {
    if (line[i] === '\t') { count -= 4; i++; }
    else if (line[i] === ' ') { count--; i++; }
    else break;
  }
  return line.slice(i);
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
  const body = [];
  collectReferences(lines, refs, body);
  return renderBlocks(body, refs);
}

function collectReferences(lines, refs, body) {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (indentOf(line) <= 3 && line[0] === '[') {
      const close = line.indexOf(']:');
      if (close > 0) {
        let rest = line.slice(close + 2).trim();
        let url = '';
        let title = '';
        if (rest[0] === '<') {
          const e = rest.indexOf('>');
          if (e >= 0) { url = rest.slice(1, e); rest = rest.slice(e + 1).trim(); }
        } else {
          let e = 0;
          let depth = 0;
          while (e < rest.length) {
            const c = rest[e];
            if (c === '(') depth++;
            else if (c === ')' && depth > 0) depth--;
            else if ((c === ' ' || c === '\t') && depth === 0) break;
            e++;
          }
          url = rest.slice(0, e);
          rest = rest.slice(e).trim();
        }
        if (rest) {
          const q = rest[0];
          if ((q === '"' || q === "'" || q === '(') && rest[rest.length - 1] === (q === '(' ? ')' : q)) title = rest.slice(1, -1);
        }
        if (url) refs[normalizeLabel(line.slice(1, close))] = { url, title };
        continue;
      }
    }
    body.push(line);
  }
}

function renderBlocks(lines, refs) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (isBlank(lines[i])) { i++; continue; }
    const line = lines[i];
    if (isThematic(line)) { out.push('<hr>\n'); i++; continue; }
    if (i + 1 < lines.length && isTableDelimiter(lines[i + 1])) {
      const table = renderTable(lines, i, refs);
      if (table) { out.push(table.html); i = table.next; continue; }
    }
    if (isHtmlBlockStart(line)) {
      const block = [line];
      const tag = htmlBlockTag(line);
      i++;
      while (i < lines.length && !isBlank(lines[i]) && (!tag || !htmlBlockEnd(lines[i], tag))) block.push(lines[i++]);
      if (tag && i < lines.length) block.push(lines[i++]);
      out.push(block.join('\n') + '\n');
      continue;
    }
    const fence = fenceStart(line);
    if (fence) {
      const content = [];
      i++;
      while (i < lines.length && !fenceEnd(lines[i], fence)) content.push(lines[i++]);
      if (i < lines.length) i++;
      const info = fence.info;
      let language = '';
      for (let n = 0; n < info.length && info[n] !== ' ' && info[n] !== '\t'; n++) language += info[n];
      const cls = language ? ` class="language-${escapeHtml(language, true)}"` : '';
      out.push(`<pre><code${cls}>${escapeHtml(content.join('\n') + (content.length ? '\n' : ''))}</code></pre>\n`);
      continue;
    }
    if (isIndentedCode(line)) {
      const content = [];
      while (i < lines.length) {
        if (isBlank(lines[i])) { content.push(''); i++; continue; }
        if (!isIndentedCode(lines[i])) break;
        content.push(stripIndent(lines[i], 4)); i++;
      }
      while (content.length && content[content.length - 1] === '') content.pop();
      out.push(`<pre><code>${escapeHtml(content.join('\n') + '\n')}</code></pre>\n`);
      continue;
    }
    const heading = atxHeading(line);
    if (heading) { out.push(`<h${heading.level}>${renderInline(heading.text, refs)}</h${heading.level}>\n`); i++; continue; }
    if (i + 1 < lines.length && !isBlank(line)) {
      const level = setextLevel(lines[i + 1]);
      if (level) { out.push(`<h${level}>${renderInline(line.trim(), refs)}</h${level}>\n`); i += 2; continue; }
    }
    if (line[0] === '>') {
      const quote = [];
      while (i < lines.length) {
        if (lines[i][0] === '>') { let content = lines[i++].slice(1); if (content[0] === ' ') content = content.slice(1); quote.push(content); }
        else if (isBlank(lines[i])) { quote.push(''); i++; }
        else break;
      }
      out.push(`<blockquote>\n${renderBlocks(quote, refs)}</blockquote>\n`);
      continue;
    }
    const list = listStart(line);
    if (list) {
      const result = renderList(lines, i, refs, list);
      out.push(result.html); i = result.next; continue;
    }
    const para = [line]; i++;
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines, i)) para.push(lines[i++]);
    out.push(`<p>${renderInline(para.join('\n'), refs)}</p>\n`);
  }
  return out.join('');
}

function startsBlock(lines, i) {
  const line = lines[i];
  return atxHeading(line) || fenceStart(line) || isThematic(line) || line[0] === '>' || listStart(line) || isIndentedCode(line) || isHtmlBlockStart(line) || (i + 1 < lines.length && setextLevel(lines[i + 1]));
}

function atxHeading(line) {
  let i = 0;
  while (i < line.length && line[i] === '#') i++;
  if (i < 1 || i > 6 || (line[i] && line[i] !== ' ' && line[i] !== '\t')) return null;
  let text = trimAscii(line.slice(i));
  let end = text.length;
  while (end > 0 && (text[end - 1] === ' ' || text[end - 1] === '\t')) end--;
  let hash = end;
  while (hash > 0 && text[hash - 1] === '#') hash--;
  if (hash < end && (hash === 0 || text[hash - 1] === ' ' || text[hash - 1] === '\t')) text = trimAscii(text.slice(0, hash));
  return { level: i, text };
}

function setextLevel(line) {
  const s = trimAscii(line);
  if (!s) return 0;
  const c = s[0];
  if (c !== '=' && c !== '-') return 0;
  for (let i = 1; i < s.length; i++) if (s[i] !== c) return 0;
  return c === '=' ? 1 : 2;
}

function isThematic(line) {
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
  return { ch, size: j - n, info: line.slice(j).trim() };
}

function fenceEnd(line, fence) {
  let i = 0; while (i < line.length && line[i] === ' ') i++;
  if (i > 3) return false;
  let j = i; while (j < line.length && line[j] === fence.ch) j++;
  return j - i >= fence.size && isBlank(line.slice(j));
}

function isIndentedCode(line) { return line.startsWith('    ') || line.startsWith('\t'); }

function listStart(line) {
  let i = 0; while (i < line.length && line[i] === ' ') i++;
  if (i > 3) return null;
  const marker = line[i];
  if (marker === '*' || marker === '-' || marker === '+') {
    if (line[i + 1] !== ' ' && line[i + 1] !== '\t') return null;
    return { indent: i, ordered: false, marker, start: 1, width: i + 2 };
  }
  let j = i;
  while (j < line.length && line.charCodeAt(j) >= 48 && line.charCodeAt(j) <= 57) j++;
  if (j === i || line[j] !== '.' || (line[j + 1] !== ' ' && line[j + 1] !== '\t')) return null;
  return { indent: i, ordered: true, marker: '.', start: Number(line.slice(i, j)), width: j + 2 };
}

function renderList(lines, start, refs, first) {
  const items = [];
  let i = start;
  let loose = false;
  while (i < lines.length) {
    const marker = listStart(lines[i]);
    if (!marker || marker.indent !== first.indent || marker.ordered !== first.ordered) break;
    const item = [lines[i].slice(marker.width)]; i++;
    let blank = false;
    while (i < lines.length) {
      if (isBlank(lines[i])) { item.push(''); blank = true; i++; continue; }
      const next = listStart(lines[i]);
      if (next && next.indent === first.indent && next.ordered === first.ordered) break;
      if (indentOf(lines[i]) <= first.indent && !next) break;
      item.push(stripIndent(lines[i], first.indent + 2)); i++;
    }
    if (blank) loose = true;
    items.push(item);
  }
  const tag = first.ordered ? 'ol' : 'ul';
  const attr = first.ordered && first.start !== 1 ? ` start="${first.start}"` : '';
  const out = [`<${tag}${attr}>\n`];
  for (const item of items) {
    while (item.length && isBlank(item[0])) item.shift();
    while (item.length && isBlank(item[item.length - 1])) item.pop();
    const inner = renderBlocks(item, refs);
    const body = loose ? inner : tightListItem(item, refs);
    out.push(`<li>${body}</li>\n`);
  }
  out.push(`</${tag}>\n`);
  return { html: out.join(''), next: i };
}

function tightListItem(lines, refs) {
  if (!lines.length) return '';
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (isBlank(lines[i])) { i++; continue; }
    if (startsBlock(lines, i) && !atxHeading(lines[i]) && !setextLevel(lines[i + 1] || '')) {
      out.push(renderBlocks(lines.slice(i), refs)); break;
    }
    const p = [lines[i++]];
    while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines, i)) p.push(lines[i++]);
    out.push(renderInline(p.join('\n'), refs));
  }
  return out.join('');
}

function isHtmlBlockStart(line) {
  const s = line.trimStart();
  if (s.startsWith('<!--') || s.startsWith('<?') || s.startsWith('<![CDATA[') || s.startsWith('<!')) return true;
  if (s[0] !== '<') return false;
  const e = s.indexOf('>');
  if (e < 0) return false;
    let end = 1;
    while (end < e && s[end] !== ' ' && s[end] !== '\t' && s[end] !== '/') end++;
    const name = s.slice(1, end).toLowerCase();
  return name === 'address' || name === 'article' || name === 'aside' || name === 'base' || name === 'blockquote' || name === 'body' || name === 'caption' || name === 'center' || name === 'col' || name === 'colgroup' || name === 'dd' || name === 'details' || name === 'dialog' || name === 'dir' || name === 'div' || name === 'dl' || name === 'dt' || name === 'fieldset' || name === 'figcaption' || name === 'figure' || name === 'footer' || name === 'form' || name === 'h1' || name === 'head' || name === 'header' || name === 'hr' || name === 'html' || name === 'iframe' || name === 'legend' || name === 'li' || name === 'link' || name === 'main' || name === 'menu' || name === 'menuitem' || name === 'nav' || name === 'ol' || name === 'p' || name === 'pre' || name === 'script' || name === 'section' || name === 'summary' || name === 'style' || name === 'table' || name === 'tbody' || name === 'td' || name === 'tfoot' || name === 'th' || name === 'thead' || name === 'title' || name === 'tr' || name === 'track' || name === 'ul';
}

function htmlBlockTag(line) {
  const s = line.trimStart();
  if (s.startsWith('<!--')) return '!--';
  if (s.startsWith('<?')) return '?';
  if (s.startsWith('<![CDATA[')) return '![CDATA[';
  if (s[0] !== '<' || !isAlpha(s.charCodeAt(1))) return null;
  let i = 2;
  while (isAlpha(s.charCodeAt(i)) || isDigit(s.charCodeAt(i)) || s[i] === '-') i++;
  if (s[i] && s[i] !== ' ' && s[i] !== '\t' && s[i] !== '/' && s[i] !== '>') return null;
  return s.slice(1, i).toLowerCase();
}

function htmlBlockEnd(line, tag) {
  if (tag === '!--') return line.includes('-->');
  if (tag === '?') return line.includes('?>');
  if (tag === '![CDATA[') return line.includes(']]>');
  return line.toLowerCase().includes(`</${tag}>`);
}

function isInlineHtml(inside) {
  if (inside.startsWith('!--') || inside.startsWith('?')) return true;
  let i = 0;
  if (inside[i] === '/') i++;
  if (!isAlpha(inside.charCodeAt(i)) && inside[i] !== '!') return false;
  for (; i < inside.length; i++) if (inside[i] === '<' || inside[i] === '>') return false;
  return true;
}

function isAutolink(inside) {
  const colon = inside.indexOf(':');
  if (colon > 0 && colon <= 32 && isAlpha(inside.charCodeAt(0))) {
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
  while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines, i)) {
    body.push(tagRow(tableCells(lines[i]), 'td'));
    i++;
  }
  if (body.length) out.push('<tbody>' + body.join('') + '</tbody>');
  out.push('</table>\n');
  return { html: out.join(''), next: i };
}

function tableCells(line) {
  const cells = [];
  let start = 0, ticks = 0;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') { i++; continue; }
    if (line[i] === '`') { ticks++; while (line[i + 1] === '`') { ticks++; i++; } continue; }
    if (line[i] === '|' && (ticks % 2) === 0) { cells.push(line.slice(start, i)); start = i + 1; }
  }
  cells.push(line.slice(start));
  if (cells.length > 1 && cells[0].trim() === '') cells.shift();
  if (cells.length > 1 && cells[cells.length - 1].trim() === '') cells.pop();
  return cells;
}

function renderInline(text, refs) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length) {
      if (text[i + 1] === '\n') { out.push('<br>'); i += 2; continue; }
      if (PUNCT.includes(text[i + 1])) { out.push(escapeHtml(text[i + 1])); i += 2; continue; }
    }
    if (c === '\n') {
      let spaces = 0; while (out.length && out[out.length - 1] === ' ' && spaces < 2) { out.pop(); spaces++; }
      out.push(spaces >= 2 ? '<br>\n' : '\n'); i++; continue;
    }
    if (c === '`') {
      let n = 1; while (text[i + n] === '`') n++;
      const mark = '`'.repeat(n);
      const end = findClosing(text, i + n, mark);
      if (end >= 0) {
        let code = replaceNewlines(text.slice(i + n, end), ' ');
        if (code.length > 1 && code[0] === ' ' && code[code.length - 1] === ' ' && code.trim()) code = code.slice(1, -1);
        out.push(`<code>${escapeHtml(code, true)}</code>`); i = end + n; continue;
      }
    }
    if (c === '&') {
      const entityEnd = entityAt(text, i);
      if (entityEnd > i) {
        const decoded = decodeEntity(text.slice(i, entityEnd));
        if (decoded !== null) out.push(escapeHtml(decoded));
        else out.push(text.slice(i, entityEnd));
        i = entityEnd; continue;
      }
    }
    if (c === '<') {
      const close = text.indexOf('>', i + 1);
      if (close >= 0) {
        const inside = text.slice(i + 1, close);
        if (isAutolink(inside)) {
          const href = inside.includes('@') && !inside.includes(':') ? `mailto:${inside}` : inside;
          out.push(`<a href="${cleanUrl(href)}">${escapeHtml(inside)}</a>`); i = close + 1; continue;
        }
        if (isInlineHtml(inside)) { out.push(text.slice(i, close + 1)); i = close + 1; continue; }
      }
    }
    if (c === '[' || (c === '!' && text[i + 1] === '[')) {
      const parsed = parseLink(text, i, refs);
      if (parsed) { out.push(parsed.html); i = parsed.end; continue; }
    }
    const url = extendedUrlAt(text, i);
    if (url) { out.push(`<a href="${cleanUrl(url.href)}">${escapeHtml(url.label)}</a>`); i = url.end; continue; }
    if (c === '~' && text[i + 1] === '~') {
      const end = text.indexOf('~~', i + 2);
      if (end > i + 2 && !isSpace(text[end - 1]) && !isSpace(text[i + 2])) { out.push(`<del>${renderInline(text.slice(i + 2, end), refs)}</del>`); i = end + 2; continue; }
    }
    if (c === '*' || c === '_') {
      let n = 1; while (text[i + n] === c && n < 3) n++;
      const marker = c.repeat(n);
      const prev = i ? text[i - 1] : ' ';
      const canOpen = !isSpace(text[i + n]) && !(c === '_' && isWord(prev));
      const end = canOpen ? findDelimiter(text, i + n, marker, c) : -1;
      if (end > i + n) {
        const tag = n >= 2 ? 'strong' : 'em';
        const inner = renderInline(text.slice(i + n, end), refs);
        out.push(`<${tag}>${inner}</${tag}>`); i = end + n; continue;
      }
    }
    out.push(escapeHtml(c)); i++;
  }
  return out.join('');
}

function entityAt(text, i) {
  let j = i + 1;
  if (text[j] === '#') {
    j++;
    if (text[j] === 'x' || text[j] === 'X') { j++; while (isHex(text.charCodeAt(j))) j++; }
    else while (isDigit(text.charCodeAt(j))) j++;
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
    if (value === 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return '\ufffd';
    return String.fromCodePoint(value);
  }
  return Object.prototype.hasOwnProperty.call(ENTITY, body) ? ENTITY[body] : null;
}

function findDelimiter(text, from, marker, char) {
  let p = from;
  while ((p = text.indexOf(marker, p)) >= 0) {
    const before = text[p - 1] || ' ';
    const after = text[p + marker.length] || ' ';
    if (!isSpace(before) && !(char === '_' && isWord(after))) return p;
    p += marker.length;
  }
  return -1;
}

function parseLink(text, start, refs) {
  const image = text[start] === '!';
  const open = start + (image ? 1 : 0);
  let depth = 1, close = open + 1;
  for (; close < text.length; close++) {
    if (text[close] === '\\') { close++; continue; }
    if (text[close] === '[') depth++;
    else if (text[close] === ']' && --depth === 0) break;
  }
  if (close >= text.length) return null;
  const label = text.slice(open + 1, close);
  let end = close + 1;
  let href = ''; let title = '';
  if (text[end] === '(') {
    let p = end + 1; while (isSpace(text[p])) p++;
    if (text[p] === '<') {
      const q = text.indexOf('>', p + 1); if (q < 0) return null;
      href = text.slice(p + 1, q); p = q + 1;
    } else {
      let parens = 0; const begin = p;
      while (p < text.length && !isSpace(text[p])) {
        if (text[p] === '(') parens++;
        if (text[p] === ')' && parens > 0) parens--;
        else if (text[p] === ')' && parens === 0) break;
        p++;
      }
      href = text.slice(begin, p);
    }
    while (isSpace(text[p])) p++;
    if (text[p] === '"' || text[p] === "'") {
      const q = text.indexOf(text[p], p + 1); if (q >= 0) { title = text.slice(p + 1, q); p = q + 1; while (isSpace(text[p])) p++; }
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
    const ref = refs[normalizeLabel(refLabel)];
    if (!ref) return null;
    href = ref.url; title = ref.title;
  }
  const safe = cleanUrl(href);
  const titleAttr = title ? ` title="${escapeHtml(title, true)}"` : '';
  const content = image ? escapeHtml(label) : renderInline(label, refs);
  return { html: image ? `<img src="${safe}" alt="${escapeHtml(label, true)}"${titleAttr}>` : `<a href="${safe}"${titleAttr}>${content}</a>`, end };
}

function extendedUrlAt(text, i) {
  if (i && isWord(text[i - 1])) return null;
  let start = i;
  let prefix = '';
  if (text.startsWith('https://', i) || text.startsWith('http://', i)) prefix = text.startsWith('https://', i) ? 'https://' : 'http://';
  else if (text.startsWith('www.', i)) prefix = 'www.';
  else if (isAlpha(text.charCodeAt(i))) {
    let p = i; while (isAlpha(text.charCodeAt(p)) || isDigit(text.charCodeAt(p)) || text[p] === '+' || text[p] === '-' || text[p] === '.') p++;
    if (text[p] !== '@') return null;
    while (p < text.length && !isSpace(text[p]) && text[p] !== '<' && text[p] !== '>') p++;
    let end = p;
    while (end > i && '.,!?;:'.includes(text[end - 1])) end--;
    const email = text.slice(i, end);
    if (!email.includes('.') || email.lastIndexOf('@') < 1) return null;
    return { href: `mailto:${email}`, label: email, end };
  } else return null;
  let p = i + prefix.length;
  while (p < text.length && !isSpace(text[p]) && text[p] !== '<' && text[p] !== '>' && text[p] !== '"') p++;
  while (p > i && (text[p - 1] === '.' || text[p - 1] === ',' || text[p - 1] === ':' || text[p - 1] === ';' || text[p - 1] === '!' || text[p - 1] === '?')) p--;
  while (p > i && text[p - 1] === ')') {
    let opens = 0, closes = 0;
    for (let q = i; q < p; q++) { if (text[q] === '(') opens++; else if (text[q] === ')') closes++; }
    if (closes <= opens) break;
    p--;
  }
  if (p <= start + prefix.length) return null;
  const label = text.slice(start, p);
  if (prefix === 'www.') return { href: `http://${label}`, label, end: p };
  return { href: label, label, end: p };
}

function isSpace(c) { return c === ' ' || c === '\t' || c === '\n' || c === '\r'; }
function isWord(c) { if (!c) return false; const n = c.charCodeAt(0); return isAlpha(n) || isDigit(n) || c === '_'; }
function isAlpha(n) { return (n >= 65 && n <= 90) || (n >= 97 && n <= 122); }
function isDigit(n) { return n >= 48 && n <= 57; }
function isHex(n) { return isDigit(n) || (n >= 65 && n <= 70) || (n >= 97 && n <= 102); }

export { parse };
