// Minimal CommonMark-compatible Markdown -> HTML renderer (subset S1).
// Written from scratch for this workspace (no third-party code copied).

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™', mdash: '—', ndash: '–',
  hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  euro: '€', pound: '£', yen: '¥', cent: '¢', times: '×',
  divide: '÷', middot: '·', deg: '°', plusmn: '±', para: '¶',
  sect: '§', laquo: '«', raquo: '»', bull: '•',
};

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const isPunct = c => c !== undefined && /[\p{P}\p{S}]/u.test(c);
const isWS = c => c === undefined || /\s/.test(c);
const isBlank = l => /^[ \t]*$/.test(l);

function decodeEntity(body) {
  if (body[0] === '#') {
    const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
    return String.fromCodePoint(cp);
  }
  return ENTITIES[body];
}

// Backslash escapes and entity references, used for link destinations/titles and info strings.
function unescapeString(s) {
  return s
    .replace(/\\([!-/:-@[-`{-~])/g, '$1')
    .replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g,
      (m, body) => decodeEntity(body) ?? m);
}

// Percent-encode characters outside the encodeURI-safe set, keeping existing %XX sequences.
function normalizeHref(s) {
  let out = '';
  for (let k = 0; k < s.length; k++) {
    const c = s[k];
    if (/[A-Za-z0-9;/?:@&=+$,\-_.!~*'()#]/.test(c)) out += c;
    else if (c === '%' && /^[0-9A-Fa-f]{2}$/.test(s.substr(k + 1, 2))) out += c;
    else {
      const cp = s.codePointAt(k);
      const ch = String.fromCodePoint(cp);
      if (cp > 0xffff) k++;
      for (const b of new TextEncoder().encode(ch)) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return out;
}

// ---------------------------------------------------------------- inline

const ENTITY_RE = /&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/y;

function skipWS(src, i) {
  while (src[i] === ' ' || src[i] === '\t') i++;
  if (src[i] === '\n') { i++; while (src[i] === ' ' || src[i] === '\t') i++; }
  return i;
}

// Parses "(dest "title")" starting at index p (the char right after "]").
function parseLinkTail(src, p) {
  if (src[p] !== '(') return null;
  const n = src.length;
  let i = skipWS(src, p + 1);
  let dest = '';
  if (src[i] === '<') {
    let j = i + 1;
    let s = '';
    while (j < n && src[j] !== '>' && src[j] !== '\n' && src[j] !== '<') {
      if (src[j] === '\\' && isPunct(src[j + 1])) { s += src[j] + src[j + 1]; j += 2; } else { s += src[j]; j++; }
    }
    if (src[j] !== '>') return null;
    dest = s;
    i = j + 1;
  } else {
    let depth = 0;
    let s = '';
    let j = i;
    while (j < n) {
      const c = src[j];
      if (c === '\\' && isPunct(src[j + 1])) { s += c + src[j + 1]; j += 2; continue; }
      if (c === '(') { depth++; if (depth > 32) return null; }
      else if (c === ')') { if (depth === 0) break; depth--; }
      else if (isWS(c) || c.charCodeAt(0) < 0x20) break;
      s += c;
      j++;
    }
    if (depth !== 0) return null;
    dest = s;
    i = j;
  }
  const wsStart = i;
  i = skipWS(src, i);
  let title = null;
  if (i < n && i > wsStart && (src[i] === '"' || src[i] === "'" || src[i] === '(')) {
    const close = src[i] === '(' ? ')' : src[i];
    let j = i + 1;
    let s = '';
    while (j < n && src[j] !== close) {
      if (src[j] === '\\' && isPunct(src[j + 1])) { s += src[j] + src[j + 1]; j += 2; continue; }
      if (src[j] === '(' && close === ')') return null;
      s += src[j];
      j++;
    }
    if (j >= n) return null;
    title = unescapeString(s);
    i = skipWS(src, j + 1);
  }
  if (src[i] !== ')') return null;
  return { dest: unescapeString(dest), title, end: i + 1 };
}

const raw = (html, plain = '') => ({ t: 'raw', html, plain });

function ruleOfThree(o, c) {
  if ((o.open && o.close) || (c.open && c.close)) {
    return (o.orig + c.orig) % 3 === 0 && !(o.orig % 3 === 0 && c.orig % 3 === 0);
  }
  return false;
}

// CommonMark "process emphasis" over items after index `bottom`.
function processEmphasis(items, bottom) {
  const delims = [];
  for (let k = bottom + 1; k < items.length; k++) if (items[k].t === 'delim') delims.push(items[k]);
  let ci = 0;
  while (ci < delims.length) {
    const closer = delims[ci];
    if (!closer.close) { ci++; continue; }
    let oi = ci - 1;
    let found = null;
    for (; oi >= 0; oi--) {
      const o = delims[oi];
      if (o.open && o.ch === closer.ch && !ruleOfThree(o, closer)) { found = o; break; }
    }
    if (!found) {
      if (!closer.open) delims.splice(ci, 1); else ci++;
      continue;
    }
    const use = closer.n >= 2 && found.n >= 2 ? 2 : 1;
    const tag = use === 2 ? 'strong' : 'em';
    found.n -= use;
    closer.n -= use;
    const oIdx = items.indexOf(found);
    const cIdx = items.indexOf(closer);
    items.splice(cIdx, 0, raw(`</${tag}>`));
    items.splice(oIdx + 1, 0, raw(`<${tag}>`));
    delims.splice(oi + 1, ci - oi - 1);
    ci = oi + 1;
    if (found.n === 0) { delims.splice(oi, 1); ci--; }
    if (closer.n === 0) delims.splice(ci, 1);
  }
}

function plainText(tokens) {
  let s = '';
  for (const t of tokens) {
    if (t.t === 'txt') s += t.s;
    else if (t.t === 'delim') s += t.ch.repeat(t.n);
    else if (t.t === 'raw') s += t.plain;
    else if (t.t === 'br') s += t.img ? '![' : '[';
  }
  return s;
}

function renderTok(t) {
  switch (t.t) {
    case 'txt': return esc(t.s);
    case 'delim': return esc(t.ch.repeat(t.n));
    case 'raw': return t.html;
    case 'br': return t.img ? '![' : '[';
    default: return '';
  }
}

function inline(src) {
  const items = [];
  const brackets = [];
  let text = '';
  const n = src.length;
  const flush = () => { if (text) { items.push({ t: 'txt', s: text }); text = ''; } };
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '\\') {
      const d = src[i + 1];
      if (d === '\n') { flush(); items.push(raw('<br />\n', '\n')); i += 2; continue; }
      if (isPunct(d)) { text += d; i += 2; continue; }
      text += c; i++; continue;
    }
    if (c === '`') {
      let k = i;
      while (k < n && src[k] === '`') k++;
      const len = k - i;
      let j = k;
      let close = -1;
      while (j < n) {
        if (src[j] === '`') {
          let e = j;
          while (e < n && src[e] === '`') e++;
          if (e - j === len) { close = j; break; }
          j = e;
        } else j++;
      }
      if (close < 0) { text += src.slice(i, k); i = k; continue; }
      let content = src.slice(k, close).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      flush();
      items.push(raw(`<code>${esc(content)}</code>`, content));
      i = close + len;
      continue;
    }
    if (c === '*' || c === '_') {
      let k = i;
      while (k < n && src[k] === c) k++;
      const before = i > 0 ? src[i - 1] : undefined;
      const after = k < n ? src[k] : undefined;
      const lf = !isWS(after) && (!isPunct(after) || isWS(before) || isPunct(before));
      const rf = !isWS(before) && (!isPunct(before) || isWS(after) || isPunct(after));
      let open, close;
      if (c === '*') { open = lf; close = rf; } else {
        open = lf && (!rf || isPunct(before));
        close = rf && (!lf || isPunct(after));
      }
      flush();
      items.push({ t: 'delim', ch: c, n: k - i, orig: k - i, open, close });
      i = k;
      continue;
    }
    if (c === '!' && src[i + 1] === '[') {
      flush();
      const b = { t: 'br', img: true, active: true };
      items.push(b); brackets.push(b);
      i += 2; continue;
    }
    if (c === '[') {
      flush();
      const b = { t: 'br', img: false, active: true };
      items.push(b); brackets.push(b);
      i++; continue;
    }
    if (c === ']') {
      flush();
      const b = brackets.pop();
      if (!b) { text += ']'; i++; continue; }
      const literal = () => { b.t = 'txt'; b.s = b.img ? '![' : '['; };
      if (!b.active) { literal(); i++; continue; }
      const link = parseLinkTail(src, i + 1);
      if (!link) { literal(); i++; continue; }
      const bi = items.indexOf(b);
      processEmphasis(items, bi);
      const titleAttr = link.title !== null ? ` title="${esc(link.title)}"` : '';
      if (b.img) {
        const alt = plainText(items.slice(bi + 1));
        items.splice(bi);
        items.push(raw(`<img src="${esc(normalizeHref(link.dest))}" alt="${esc(alt)}"${titleAttr} />`, alt));
      } else {
        items.splice(bi, 1, raw(`<a href="${esc(normalizeHref(link.dest))}"${titleAttr}>`));
        items.push(raw('</a>'));
        for (const o of brackets) if (!o.img) o.active = false;
      }
      i = link.end;
      continue;
    }
    if (c === '&') {
      ENTITY_RE.lastIndex = i;
      const m = ENTITY_RE.exec(src);
      if (m) {
        const dec = decodeEntity(m[1]);
        if (dec !== undefined) { text += dec; i += m[0].length; continue; }
      }
      text += c; i++; continue;
    }
    if (c === '\n') {
      const trimmed = text.replace(/ +$/, '');
      const spaces = text.length - trimmed.length;
      text = trimmed;
      flush();
      items.push(spaces >= 2 ? raw('<br />\n', '\n') : raw('\n', '\n'));
      i++; continue;
    }
    text += c;
    i++;
  }
  flush();
  processEmphasis(items, -1);
  return items.map(renderTok).join('');
}

// ---------------------------------------------------------------- blocks

const RE_ATX = /^ {0,3}(#{1,6})(?=[ \t]|$)(.*)$/;
const RE_FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const RE_FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const RE_HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const RE_SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const RE_QUOTE = /^ {0,3}> ?/;

function indentOf(l) {
  let k = 0;
  while (l[k] === ' ') k++;
  return k;
}

// Returns {ordered, bullet, delim, start, W, content} or null.
function parseMarker(line) {
  const m = /^( {0,3})([-+*]|(\d{1,9})([.)]))(?=[ \t]|$)(.*)$/.exec(line);
  if (!m) return null;
  const indent = m[1].length;
  const markerLen = m[2].length;
  const rest = m[5];
  const ordered = m[3] !== undefined;
  const info = { ordered, bullet: ordered ? null : m[2], delim: ordered ? m[4] : null, start: ordered ? parseInt(m[3], 10) : 1 };
  const sp = indexOfNonSpace(rest);
  if (rest.trim() === '') {
    return { ...info, W: indent + markerLen + 1, content: '' };
  }
  if (sp > 4) return { ...info, W: indent + markerLen + 1, content: rest.slice(1) };
  return { ...info, W: indent + markerLen + sp, content: rest.slice(sp) };
}

function indexOfNonSpace(s) {
  let k = 0;
  while (s[k] === ' ') k++;
  return k;
}

function interruptsParagraph(line) {
  if (indentOf(line) >= 4) return false;
  if (RE_ATX.test(line) || RE_HR.test(line) || RE_QUOTE.test(line)) return true;
  const fm = RE_FENCE.exec(line);
  if (fm && !(fm[2][0] === "`" && fm[3].includes("`"))) return true;
  const mk = parseMarker(line);
  return Boolean(mk && mk.content.trim() !== "" && (!mk.ordered || mk.start === 1));
}

function removeIndent(l, w) {
  const k = Math.min(indexOfNonSpace(l), w);
  return l.slice(k);
}

function expandLeadingTabs(line) {
  return line.replace(/^[ \t]+/, ws => {
    let col = 0;
    for (const ch of ws) col = ch === '\t' ? col + 4 - (col % 4) : col + 1;
    return ' '.repeat(col);
  });
}

// Returns {blocks, loose}.
function parseBlocks(lines) {
  const blocks = [];
  const n = lines.length;
  let loose = false;
  let pendingBlank = false;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { pendingBlank = true; i++; continue; }
    if (pendingBlank && blocks.length) loose = true;
    pendingBlank = false;
    const ind = indentOf(line);

    if (ind >= 4) {
      let last = i;
      let j = i;
      while (j < n && (isBlank(lines[j]) || indentOf(lines[j]) >= 4)) {
        if (!isBlank(lines[j])) last = j;
        j++;
      }
      const body = [];
      for (let k = i; k <= last; k++) body.push(isBlank(lines[k]) ? '' : lines[k].slice(4));
      blocks.push({ t: 'icode', text: body.map(x => x + '\n').join('') });
      i = last + 1;
      continue;
    }

    if (ind < 4) {
      const fm = RE_FENCE.exec(line);
      if (fm && !(fm[2][0] === '`' && fm[3].includes('`'))) {
        const fIndent = fm[1].length;
        const fChar = fm[2][0];
        const fLen = fm[2].length;
        const info = unescapeString(fm[3].trim());
        const lang = info.split(/\s+/)[0];
        const body = [];
        let j = i + 1;
        while (j < n) {
          const cm = RE_FENCE_CLOSE.exec(lines[j]);
          if (cm && cm[1][0] === fChar && cm[1].length >= fLen) break;
          body.push(removeIndent(lines[j], fIndent));
          j++;
        }
        blocks.push({ t: 'code', lang, text: body.map(x => x + '\n').join('') });
        i = j + 1;
        continue;
      }
      const am = RE_ATX.exec(line);
      if (am) {
        const text = am[2].replace(/^[ \t]+|[ \t]+$/g, '').replace(/(^|[ \t]+)#+$/, '').replace(/[ \t]+$/, '');
        blocks.push({ t: 'h', level: am[1].length, text: text.replace(/^[ \t]+/, '') });
        i++;
        continue;
      }
      if (RE_HR.test(line)) { blocks.push({ t: 'hr' }); i++; continue; }
      if (RE_QUOTE.test(line)) {
        const buf = [];
        let j = i;
        while (j < n) {
          const l = lines[j];
          const qm = RE_QUOTE.exec(l);
          if (qm && indentOf(l) < 4) { buf.push(l.slice(qm[0].length)); j++; continue; }
          // lazy paragraph continuation
          if (!isBlank(l) && buf.length && !isBlank(buf[buf.length - 1]) && !interruptsParagraph(l)) {
            buf.push(l); j++; continue;
          }
          break;
        }
        blocks.push({ t: 'quote', blocks: parseBlocks(buf).blocks });
        i = j;
        continue;
      }
      const mk = parseMarker(line);
      if (mk) {
        const res = parseList(lines, i, mk);
        blocks.push(res.block);
        i = res.next;
        continue;
      }
    }

    // paragraph or setext heading
    const buf = [line];
    let j = i + 1;
    let level = 0;
    while (j < n) {
      const l = lines[j];
      if (isBlank(l)) break;
      const su = RE_SETEXT.exec(l);
      if (su && indentOf(l) < 4) { level = su[1][0] === '=' ? 1 : 2; j++; break; }
      if (interruptsParagraph(l)) break;
      buf.push(l);
      j++;
    }
    const text = buf.map(l => l.replace(/^[ \t]+/, '')).join('\n').replace(/[ \t]+$/, '');
    if (level) blocks.push({ t: 'h', level, text });
    else blocks.push({ t: 'p', text });
    i = j;
  }
  return { blocks, loose };
}

function parseList(lines, start, first) {
  const n = lines.length;
  const ordered = first.ordered;
  const sameType = m => m && m.ordered === ordered && (ordered ? m.delim === first.delim : m.bullet === first.bullet);
  const items = [];
  let loose = false;
  let j = start;
  let mk = first;
  let next = start;
  while (true) {
    const W = mk.W;
    const content = [mk.content];
    let k = j + 1;
    while (k < n) {
      const l = lines[k];
      if (isBlank(l)) { content.push(''); k++; continue; }
      if (indentOf(l) >= W) { content.push(removeIndent(l, W)); k++; continue; }
      if (content.length && !isBlank(content[content.length - 1]) && !interruptsParagraph(l) && !parseMarker(l)) {
        content.push(l.replace(/^[ \t]+/, '')); k++; continue;
      }
      break;
    }
    let trailingBlank = false;
    while (content.length > 1 && content[content.length - 1] === '') { content.pop(); trailingBlank = true; }
    const { blocks, loose: itemLoose } = parseBlocks(content);
    if (itemLoose) loose = true;
    items.push(blocks);
    const nx = k < n ? parseMarker(lines[k]) : null;
    if (sameType(nx) && indentOf(lines[k]) < 4) {
      if (trailingBlank) loose = true;
      j = k;
      mk = nx;
      continue;
    }
    // Leave trailing blank lines unconsumed so the enclosing container can see them.
    let e = k;
    while (e - 1 > j && isBlank(lines[e - 1])) e--;
    next = e;
    break;
  }
  return { block: { t: 'list', ordered, start: first.start, loose, items }, next };
}

function renderBlocks(blocks, tight) {
  let out = '';
  blocks.forEach((b, idx) => {
    switch (b.t) {
      case 'p': {
        const body = inline(b.text);
        if (tight) out += body + (idx < blocks.length - 1 ? '\n' : '');
        else out += `<p>${body}</p>\n`;
        break;
      }
      case 'h':
        out += `<h${b.level}>${inline(b.text)}</h${b.level}>\n`;
        break;
      case 'code':
        out += `<pre><code${b.lang ? ` class="language-${esc(b.lang)}"` : ''}>${esc(b.text)}</code></pre>\n`;
        break;
      case 'icode':
        out += `<pre><code>${esc(b.text)}</code></pre>\n`;
        break;
      case 'hr':
        out += '<hr />\n';
        break;
      case 'quote':
        out += `<blockquote>\n${renderBlocks(b.blocks, false)}</blockquote>\n`;
        break;
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        const startAttr = b.ordered && b.start !== 1 ? ` start="${b.start}"` : '';
        out += `<${tag}${startAttr}>\n`;
        const itight = !b.loose;
        for (const item of b.items) {
          if (itight) out += `<li>${renderBlocks(item, true)}</li>\n`;
          else out += `<li>\n${renderBlocks(item, false)}</li>\n`;
        }
        out += `</${tag}>\n`;
        break;
      }
    }
  });
  return out;
}

export function render(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n').replace(/\0/g, '�');
  const lines = src.split('\n').map(expandLeadingTabs);
  return renderBlocks(parseBlocks(lines).blocks, false);
}
