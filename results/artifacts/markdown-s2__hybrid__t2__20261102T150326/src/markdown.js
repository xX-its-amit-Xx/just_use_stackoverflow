// markdown-s2: safe Markdown -> HTML renderer (CommonMark-style algorithm, written from scratch).

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = s => s.replace(/[&<>"]/g, c => ESC[c]);

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '©', reg: '®', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»',
  times: '×', divide: '÷', deg: '°', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶',
  middot: '·', bull: '•', trade: '™', hearts: '♥', larr: '←', rarr: '→', uarr: '↑', darr: '↓',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', eacute: 'é', egrave: 'è',
  agrave: 'à', aacute: 'á', ccedil: 'ç', ntilde: 'ñ', frac12: '½', frac14: '¼', frac34: '¾',
  ngsp: '\u2002', ensp: '\u2002', emsp: '\u2003', hairsp: '\u200a', Dcaron: 'Ď', HilbertSpace: 'ℋ',
  DifferentialD: 'ⅆ', ClockwiseContourIntegral: '∲', ngE: '≧̸',
};
const ENT_RE = /^&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([A-Za-z][A-Za-z0-9]{1,31}));/;
function decodeEntity(m) {
  if (m[1] !== undefined || m[2] !== undefined) {
    const cp = m[1] !== undefined ? parseInt(m[1], 16) : parseInt(m[2], 10);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\ufffd';
    return String.fromCodePoint(cp);
  }
  return Object.prototype.hasOwnProperty.call(ENTITIES, m[3]) ? ENTITIES[m[3]] : null;
}
const unescapeString = s =>
  s.replace(/\\([!-\/:-@\[-`{-~])|&(?:#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g, (m, p) => {
    if (p !== undefined) return p;
    const d = decodeEntity(ENT_RE.exec(m));
    return d === null ? m : d;
  });

function normalizeURI(uri) {
  let out = '';
  const safe = /[A-Za-z0-9;\/?:@&=+$,\-_.!~*'()#]/;
  for (let i = 0; i < uri.length;) {
    const ch = uri[i];
    if (ch === '%' && /^%[0-9a-fA-F]{2}/.test(uri.slice(i, i + 3))) { out += uri.slice(i, i + 3); i += 3; continue; }
    if (safe.test(ch)) { out += ch; i++; continue; }
    const cp = uri.codePointAt(i);
    const chs = String.fromCodePoint(cp);
    i += chs.length;
    if (cp >= 0xd800 && cp <= 0xdfff) { out += '%EF%BF%BD'; continue; }
    out += encodeURIComponent(chs);
  }
  return out;
}
function safeUrl(url) {
  const probe = url.replace(/[\x00-\x20\u00a0\u1680\u2000-\u200f\u2028\u2029\u202f\u205f\u3000\ufeff]/g, '');
  if (/^(?:javascript|vbscript|file|data):/i.test(probe) && !/^data:image\/(?:png|gif|jpeg|webp);/i.test(probe)) return '#';
  return url;
}
const normLabel = s => s.trim().replace(/[ \t\r\n]+/g, ' ').toLowerCase().toUpperCase();

// ---------------------------------------------------------------- shared link-part parsers
function parseDest(s, i) {
  if (s[i] === '<') {
    let j = i + 1;
    while (j < s.length) {
      const c = s[j];
      if (c === '\\' && j + 1 < s.length && s[j + 1] !== '\n') { j += 2; continue; }
      if (c === '\n' || c === '<') return null;
      if (c === '>') return { dest: unescapeString(s.slice(i + 1, j)), end: j + 1 };
      j++;
    }
    return null;
  }
  let j = i, depth = 0;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && /[!-\/:-@\[-`{-~]/.test(s[j + 1])) { j += 2; continue; }
    if (c === '(') depth++;
    else if (c === ')') { if (depth === 0) break; depth--; }
    else if (/[\x00-\x20\x7f]/.test(c)) break;
    j++;
  }
  if (depth !== 0) return null;
  return { dest: unescapeString(s.slice(i, j)), end: j };
}
const TITLE_RE = /^(?:"((?:\\[\s\S]|[^"\\])*)"|'((?:\\[\s\S]|[^'\\])*)'|\(((?:\\[\s\S]|[^()\\])*)\))/;
function parseTitle(s, i) {
  const m = TITLE_RE.exec(s.slice(i));
  if (!m) return null;
  const t = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3];
  return { title: unescapeString(t), end: i + m[0].length };
}
const LABEL_RE = /^\[(?:[^\\\[\]]|\\[\s\S]){0,999}\]/;

// Parse leading reference definitions of paragraph text; returns remaining text.
function extractRefs(text, refs) {
  for (;;) {
    const m = LABEL_RE.exec(text);
    if (!m || text[m[0].length] !== ':' || !m[0].slice(1, -1).trim()) break;
    let i = m[0].length + 1;
    const ws = () => { let nl = 0; while (i < text.length && /[ \t\n]/.test(text[i])) { if (text[i] === '\n' && ++nl > 1) break; i++; } };
    ws();
    const d = parseDest(text, i);
    if (!d || (d.dest === '' && text[i] !== '<')) break;
    i = d.end;
    const afterDest = i;
    let title = null;
    ws();
    if (i > afterDest) {
      const t = parseTitle(text, i);
      if (t) { title = t.title; i = t.end; }
    }
    // must be at end of line
    let k = i;
    while (k < text.length && /[ \t]/.test(text[k])) k++;
    if (k < text.length && text[k] !== '\n') {
      if (title === null) break;
      // title junk: fall back to dest only
      k = afterDest;
      while (k < text.length && /[ \t]/.test(text[k])) k++;
      if (k < text.length && text[k] !== '\n') break;
      title = null;
    }
    if (k < text.length) k++;
    const label = normLabel(m[0].slice(1, -1));
    if (!refs.has(label)) refs.set(label, { dest: d.dest, title });
    text = text.slice(k);
  }
  return text;
}

// ---------------------------------------------------------------- block parser
const reBullet = /^[*+-]/;
const reOrdered = /^(\d{1,9})([.)])/;
const reThematic = /^(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})[ \t]*$/;
const reATX = /^#{1,6}(?:[ \t]+|$)/;
const reFence = /^`{3,}(?!.*`)|^~{3,}/;
const reCloseFence = /^(?:`{3,}|~{3,})(?=[ \t]*$)/;
const reSetext = /^(?:=+|-+)[ \t]*$/;
const reSpecial = /^[#`~*+_=<>0-9\-|]/;

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; }
    else if (s[i] === '|') { cells.push(cur.trim()); cur = ''; }
    else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}
function parseDelimRow(line) {
  if (!/^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/.test(line)) return null;
  return splitRow(line).map(c => (c[0] === ':' ? (c.endsWith(':') ? 'center' : 'left') : c.endsWith(':') ? 'right' : null));
}

function parseBlocks(input) {
  const refs = new Map();
  const mk = (type, parent, extra) => Object.assign({ type, parent, children: [], open: true, content: '', lastLineBlank: false, lastLineChecked: false }, extra);
  const doc = mk('document', null);
  let tip = doc;
  let line = '', lineNo = 0;
  let offset, column, nextNonspace, nextNonspaceColumn, indent, indented, blank, partial;

  const peek = i => (i < line.length ? line[i] : null);
  const isSpaceOrTab = c => c === ' ' || c === '\t';
  const canContain = (p, t) => p.type === 'document' || p.type === 'block_quote' || p.type === 'item' ? true : p.type === 'list' ? t === 'item' : false;

  function finalize(b) {
    b.open = false;
    const above = b.parent;
    tip = above;
    if (b.type === 'paragraph') {
      b.content = extractRefs(b.content, refs);
      if (b.content.trim() === '') { above.children.splice(above.children.indexOf(b), 1); }
    } else if (b.type === 'code_block') {
      if (b.fenced) {
        const nl = b.content.indexOf('\n');
        b.info = unescapeString((nl < 0 ? b.content : b.content.slice(0, nl)).trim());
        b.content = nl < 0 ? '' : b.content.slice(nl + 1);
      } else {
        b.content = b.content.replace(/(?:\n[ \t]*)+$/, '\n');
      }
    } else if (b.type === 'list') {
      b.tight = true;
      const items = b.children;
      for (let i = 0; i < items.length && b.tight; i++) {
        const it = items[i];
        if (endsWithBlank(it) && i < items.length - 1) { b.tight = false; break; }
        for (let j = 0; j < it.children.length; j++) {
          if (endsWithBlank(it.children[j]) && (i < items.length - 1 || j < it.children.length - 1)) { b.tight = false; break; }
        }
      }
    }
  }
  function endsWithBlank(b) {
    while (b) {
      if (b.lastLineBlank) return true;
      if (!b.lastLineChecked && (b.type === 'list' || b.type === 'item')) { b.lastLineChecked = true; b = b.children[b.children.length - 1]; }
      else { b.lastLineChecked = true; break; }
    }
    return false;
  }
  function addChild(type, extra) {
    while (!canContain(tip, type)) finalize(tip);
    const n = mk(type, tip, Object.assign({ startLine: lineNo }, extra));
    tip.children.push(n);
    tip = n;
    return n;
  }
  function findNextNonspace() {
    let i = offset, cols = column, c;
    while ((c = line[i]) !== undefined) {
      if (c === ' ') { i++; cols++; }
      else if (c === '\t') { i++; cols += 4 - (cols % 4); }
      else break;
    }
    blank = c === undefined;
    nextNonspace = i; nextNonspaceColumn = cols;
    indent = cols - column; indented = indent >= 4;
  }
  function advanceNextNonspace() { offset = nextNonspace; column = nextNonspaceColumn; partial = false; }
  function advanceOffset(count, columns) {
    let c;
    while (count > 0 && (c = line[offset]) !== undefined) {
      if (c === '\t') {
        const toTab = 4 - (column % 4);
        if (columns) {
          partial = toTab > count;
          const add = Math.min(count, toTab);
          column += add; offset += partial ? 0 : 1; count -= add;
        } else { partial = false; column += toTab; offset++; count--; }
      } else { partial = false; offset++; column++; count--; }
    }
  }
  function addLine() {
    if (partial) {
      offset++;
      const toTab = 4 - (column % 4);
      tip.content += ' '.repeat(toTab);
    }
    tip.content += line.slice(offset) + '\n';
  }

  // returns 0 fail, 1 matched, 2 line consumed
  function cont(c) {
    switch (c.type) {
      case 'block_quote':
        if (!indented && peek(nextNonspace) === '>') {
          advanceNextNonspace(); advanceOffset(1, false);
          if (isSpaceOrTab(peek(offset))) advanceOffset(1, true);
          return 0;
        }
        return 1;
      case 'item':
        if (blank) { if (c.children.length === 0) return 1; advanceNextNonspace(); return 0; }
        if (indent >= c.markerOffset + c.padding) { advanceOffset(c.markerOffset + c.padding, true); return 0; }
        return 1;
      case 'heading': case 'thematic_break': return 1;
      case 'code_block':
        if (c.fenced) {
          const m = indent <= 3 && line[nextNonspace] === c.fenceChar && reCloseFence.exec(line.slice(nextNonspace));
          if (m && m[0].length >= c.fenceLength) { finalize(c); return 2; }
          let i = c.fenceOffset;
          while (i > 0 && isSpaceOrTab(peek(offset))) { advanceOffset(1, true); i--; }
          return 0;
        }
        if (indent >= 4) { advanceOffset(4, true); return 0; }
        if (blank) { advanceNextNonspace(); return 0; }
        return 1;
      case 'paragraph': return blank ? 1 : 0;
      case 'table': return blank ? 1 : 0;
      default: return 0;
    }
  }

  function tryStarts(container) {
    // returns 0 none, 1 container, 2 leaf
    const rest = line.slice(nextNonspace);
    if (!indented && rest[0] === '>') {
      advanceNextNonspace(); advanceOffset(1, false);
      if (isSpaceOrTab(peek(offset))) advanceOffset(1, true);
      closeUnmatched(); addChild('block_quote');
      return 1;
    }
    if (!indented && reATX.test(rest)) {
      const lvl = rest.match(/^#+/)[0].length;
      advanceNextNonspace(); advanceOffset(lvl, false);
      let txt = line.slice(offset).replace(/^[ \t]*#+[ \t]*$/, '').replace(/[ \t]+#+[ \t]*$/, '');
      closeUnmatched();
      const h = addChild('heading', { level: lvl });
      h.content = txt.trim();
      advanceOffset(line.length - offset, false);
      return 2;
    }
    let m;
    if (!indented && (m = reFence.exec(rest))) {
      closeUnmatched();
      const b = addChild('code_block', { fenced: true, fenceChar: m[0][0], fenceLength: m[0].length, fenceOffset: indent });
      advanceNextNonspace(); advanceOffset(m[0].length, false);
      return 2;
    }
    // GFM table
    if (!indented && container.type === 'paragraph' && /[|]|^[ \t]*:?-+:?[ \t]*$/.test(rest)) {
      const aligns = parseDelimRow(rest);
      if (aligns) {
        const lines = container.content.replace(/\n$/, '').split('\n');
        const header = lines[lines.length - 1];
        // reference definitions are extracted only when paragraph is finalized; accept when header looks sane
        const hc = splitRow(header);
        if (hc.length === aligns.length && (header.includes('|') || rest.includes('|')) && !/^[ \t]*$/.test(header)) {
          closeUnmatched();
          if (lines.length > 1) {
            container.content = lines.slice(0, -1).join('\n') + '\n';
            finalize(container);
          } else {
            container.parent.children.splice(container.parent.children.indexOf(container), 1);
            container.open = false; tip = container.parent;
          }
          const t = addChild('table', { aligns, header: hc, rows: [] });
          advanceOffset(line.length - offset, false);
          return 2;
        }
      }
    }
    if (!indented && container.type === 'paragraph' && (m = reSetext.exec(rest))) {
      closeUnmatched();
      container.content = extractRefs(container.content, refs);
      if (container.content.length > 0) {
        container.type = 'heading';
        container.level = m[0][0] === '=' ? 1 : 2;
        container.content = container.content.replace(/\n$/, '').split('\n').map(s => s.trim()).join('\n');
        container.open = false; tip = container.parent;
        advanceOffset(line.length - offset, false);
        return 2;
      }
    }
    if (!indented && reThematic.test(rest)) {
      closeUnmatched(); addChild('thematic_break');
      advanceOffset(line.length - offset, false);
      return 2;
    }
    // list item
    if (!indented || container.type === 'list') {
      let data = null, mm;
      if ((mm = reBullet.exec(rest))) data = { type: 'bullet', bulletChar: mm[0], len: 1 };
      else if ((mm = reOrdered.exec(rest)) && (container.type !== 'paragraph' || mm[1] === '1'))
        data = { type: 'ordered', start: parseInt(mm[1], 10), delim: mm[2], len: mm[0].length };
      if (data) {
        const after = rest[data.len];
        const ok = after === undefined || after === ' ' || after === '\t';
        const emptyRest = rest.slice(data.len).trim() === '';
        if (ok && !(container.type === 'paragraph' && emptyRest)) {
          const markerOffset = indent;
          advanceNextNonspace(); advanceOffset(data.len, true);
          const sc = column, so = offset;
          let nc;
          do { advanceOffset(1, true); nc = peek(offset); } while (column - sc < 5 && isSpaceOrTab(nc));
          const blankItem = peek(offset) === null;
          const spaces = column - sc;
          if (spaces >= 5 || spaces < 1 || blankItem) {
            data.padding = data.len + 1;
            column = sc; offset = so;
            if (isSpaceOrTab(peek(offset))) advanceOffset(1, true);
          } else data.padding = data.len + spaces;
          closeUnmatched();
          if (tip.type !== 'list' || !(tip.listData.type === data.type && tip.listData.delim === data.delim && tip.listData.bulletChar === data.bulletChar))
            addChild('list', { listData: data });
          addChild('item', { markerOffset, padding: data.padding });
          return 1;
        }
      }
    }
    if (indented && tip.type !== 'paragraph' && !blank) {
      advanceOffset(4, true);
      closeUnmatched();
      addChild('code_block', { fenced: false });
      return 2;
    }
    return 0;
  }

  let oldtip, lastMatched, allClosed;
  function closeUnmatched() {
    if (!allClosed) {
      while (oldtip !== lastMatched) { const p = oldtip.parent; finalize(oldtip); oldtip = p; }
      allClosed = true;
    }
  }

  const lines = input.replace(/\r\n?/g, '\n').split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const ln of lines) {
    lineNo++;
    line = ln.replace(/\0/g, '\ufffd');
    offset = 0; column = 0; blank = false; partial = false;
    oldtip = tip;
    let container = doc;
    let consumed = false;
    let lc;
    while ((lc = container.children[container.children.length - 1]) && lc.open) {
      container = lc;
      findNextNonspace();
      const r = cont(container);
      if (r === 0) continue;
      if (r === 1) { container = container.parent; break; }
      consumed = true; break;
    }
    if (consumed) continue;
    allClosed = container === oldtip;
    lastMatched = container;
    const leafy = c => c.type === 'code_block';
    let matchedLeaf = leafy(container) || container.type === 'heading' || container.type === 'thematic_break';
    while (!matchedLeaf) {
      findNextNonspace();
      if (!indented && !reSpecial.test(line[nextNonspace] === undefined ? '' : line[nextNonspace]) ) {
        // table rows may start with other chars, but the delimiter row only begins with | : - ; fine
        advanceNextNonspace(); break;
      }
      const r = tryStarts(container);
      if (r === 1) { container = tip; }
      else if (r === 2) { container = tip; matchedLeaf = true; }
      else { advanceNextNonspace(); break; }
    }
    if (!allClosed && !blank && tip.type === 'paragraph') {
      addLine();
    } else {
      closeUnmatched();
      if (blank && container.children.length) container.children[container.children.length - 1].lastLineBlank = true;
      const t = container.type;
      const lastBlank = blank && !(t === 'block_quote' || (t === 'code_block' && container.fenced) || (t === 'item' && container.children.length === 0 && container.startLine === lineNo));
      for (let c = container; c; c = c.parent) c.lastLineBlank = lastBlank;
      if (t === 'code_block' || t === 'paragraph') addLine();
      else if (t === 'table') {
        if (!blank && container.startLine !== lineNo) container.rows.push(splitRow(line.slice(offset)));
      } else if (offset < line.length && !blank) {
        tip = container;
        addChild('paragraph');
        advanceNextNonspace();
        addLine();
      }
    }
  }
  while (tip) { finalize(tip); if (!tip) break; if (tip === doc) break; }
  doc.open = false;
  return { doc, refs };
}

// ---------------------------------------------------------------- inline parser
const PUNCT = /[!-\/:-@\[-`{-~\p{P}\p{S}]/u;
const WS = /[\s\u00a0]/u;
const EMAIL = /^<([a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/;
const AUTOLINK = /^<([A-Za-z][A-Za-z0-9.+-]{1,31}:[^<>\x00-\x20]*)>/;

function parseInlines(text, refs) {
  const root = { type: 'root', children: [] };
  let subject = text, pos = 0;
  let delims = null; // linked list tail
  let brackets = null;
  let cur = root.children; // always root; nesting done by splicing

  const push = n => { root.children.push(n); return n; };
  const txt = v => push({ type: 'text', literal: v });

  function scanDelims(c) {
    const start = pos;
    let n = 0;
    while (subject[pos] === c) { n++; pos++; }
    if (c === '~' && n !== 2) { pos = start + n; return { n, canOpen: false, canClose: false }; }
    const before = start === 0 ? '\n' : prevChar(start);
    const after = pos >= subject.length ? '\n' : String.fromCodePoint(subject.codePointAt(pos));
    const aWS = WS.test(after), aP = PUNCT.test(after), bWS = WS.test(before), bP = PUNCT.test(before);
    const left = !aWS && (!aP || bWS || bP);
    const right = !bWS && (!bP || aWS || aP);
    let canOpen, canClose;
    if (c === '_') { canOpen = left && (!right || bP); canClose = right && (!left || aP); }
    else { canOpen = left; canClose = right; }
    return { n, canOpen, canClose };
  }
  function prevChar(i) {
    const c = subject.charCodeAt(i - 1);
    if (c >= 0xdc00 && c <= 0xdfff && i >= 2) return subject.slice(i - 2, i);
    return subject[i - 1];
  }

  function parseBackticks() {
    const m = /^`+/.exec(subject.slice(pos));
    const ticks = m[0];
    const after = pos + ticks.length;
    let i = after;
    const re = /`+/g;
    re.lastIndex = after;
    let f;
    while ((f = re.exec(subject))) {
      if (f[0].length === ticks.length) {
        let c = subject.slice(after, f.index).replace(/\n/g, ' ');
        if (c.length > 2 && c[0] === ' ' && c[c.length - 1] === ' ' && /[^ ]/.test(c)) c = c.slice(1, -1);
        push({ type: 'code', literal: c });
        pos = f.index + f[0].length;
        return;
      }
    }
    txt(ticks); pos = after;
  }

  function parseNewline() {
    pos++;
    const last = root.children[root.children.length - 1];
    let hard = false;
    if (last && last.type === 'text' && last.literal.endsWith(' ')) {
      hard = /  $/.test(last.literal);
      last.literal = last.literal.replace(/ +$/, '');
    }
    push({ type: hard ? 'linebreak' : 'softbreak' });
    while (subject[pos] === ' ' || subject[pos] === '\t') pos++;
  }

  function handleDelim(c) {
    const { n, canOpen, canClose } = scanDelims(c);
    const node = txt(subject.slice(pos - n, pos));
    if ((canOpen || canClose) && !(c === '~' && n !== 2)) {
      delims = { c, num: n, orig: n, node, canOpen, canClose, prev: delims, next: null };
      if (delims.prev) delims.prev.next = delims;
    }
  }
  function removeDelim(d) {
    if (d.prev) d.prev.next = d.next;
    if (d.next) d.next.prev = d.prev; else delims = d.prev;
  }
  function removeBetween(a, b) { // exclusive
    if (a.next !== b) { a.next = b; b.prev = a; }
  }

  function processEmphasis(bottom) {
    const openersBottom = {};
    let closer = delims;
    while (closer && closer.prev !== bottom) closer = closer.prev;
    while (closer) {
      if (closer.canClose) {
        const key = closer.c + (closer.canOpen ? '1' : '0') + (closer.orig % 3);
        const lim = openersBottom[key];
        let opener = closer.prev, found = false;
        while (opener && opener !== bottom && opener !== lim) {
          const odd = (closer.canOpen || opener.canClose) && closer.orig % 3 !== 0 && (opener.orig + closer.orig) % 3 === 0;
          if (opener.c === closer.c && opener.canOpen && !odd) { found = true; break; }
          opener = opener.prev;
        }
        const old = closer;
        if (!found) {
          closer = closer.next;
          openersBottom[key] = old.prev;
          if (!old.canOpen) removeDelim(old);
        } else {
          const use = closer.c === '~' ? 2 : (closer.num >= 2 && opener.num >= 2 ? 2 : 1);
          const arr = root.children;
          const oi = arr.indexOf(opener.node), ci = arr.indexOf(closer.node);
          opener.num -= use; closer.num -= use;
          opener.node.literal = opener.node.literal.slice(0, opener.node.literal.length - use);
          closer.node.literal = closer.node.literal.slice(use);
          const inner = arr.slice(oi + 1, ci);
          const em = { type: closer.c === '~' ? 'del' : use === 2 ? 'strong' : 'em', children: inner };
          arr.splice(oi + 1, ci - oi - 1, em);
          removeBetween(opener, closer);
          if (opener.num === 0) { arr.splice(arr.indexOf(opener.node), 1); removeDelim(opener); }
          if (closer.num === 0) {
            arr.splice(arr.indexOf(closer.node), 1);
            const nx = closer.next;
            removeDelim(closer);
            closer = nx;
          }
        }
      } else closer = closer.next;
    }
    while (delims && delims !== bottom) removeDelim(delims);
  }

  function spnl() { while (/[ \t\n]/.test(subject[pos] || '')) pos++; }

  function parseCloseBracket() {
    const startpos = pos;
    pos++;
    const op = brackets;
    if (!op) { txt(']'); return; }
    if (!op.active) { brackets = op.prev; txt(']'); return; }
    const isImage = op.image;
    const save = pos;
    let matched = false, dest = null, title = null;
    if (subject[pos] === '(') {
      pos++;
      spnl();
      const d = parseDest(subject, pos);
      if (d) {
        pos = d.end;
        const beforeWs = pos;
        spnl();
        let t = null;
        if (pos > beforeWs) { t = parseTitle(subject, pos); if (t) { pos = t.end; } }
        spnl();
        if (subject[pos] === ')') { pos++; matched = true; dest = d.dest; title = t ? t.title : null; }
      }
      if (!matched) pos = save;
    }
    if (!matched) {
      const lm = LABEL_RE.exec(subject.slice(pos));
      const n = lm ? lm[0].length : 0;
      let label = null;
      if (n > 2) label = subject.slice(pos + 1, pos + n - 1);
      else label = subject.slice(op.index, startpos);
      if (n === 0 || n === 2) { if (n === 2) pos += 2; } else pos += n;
      if (label !== null && label.trim() !== '') {
        const r = refs.get(normLabel(label));
        if (r) { matched = true; dest = r.dest; title = r.title; }
      }
      if (!matched) pos = save;
    }
    if (matched) {
      const arr = root.children;
      const oi = arr.indexOf(op.node);
      const inner = arr.slice(oi + 1);
      arr.splice(oi, arr.length - oi);
      const link = { type: isImage ? 'image' : 'link', dest, title, children: inner };
      arr.push(link);
      // emphasis within the link: need delimiters whose nodes are in inner
      const saveChildren = root.children;
      root.children = inner;
      processEmphasis(op.prevDelim);
      root.children = saveChildren;
      brackets = op.prev;
      if (!isImage) for (let b = brackets; b; b = b.prev) if (!b.image) b.active = false;
    } else {
      brackets = op.prev;
      txt(']');
    }
  }

  while (pos < subject.length) {
    const c = subject[pos];
    switch (c) {
      case '\n': parseNewline(); break;
      case '\\': {
        const nx = subject[pos + 1];
        if (nx === '\n') { pos += 2; push({ type: 'linebreak' }); while (subject[pos] === ' ' || subject[pos] === '\t') pos++; }
        else if (nx !== undefined && /[!-\/:-@\[-`{-~]/.test(nx)) { txt(nx); pos += 2; }
        else { txt('\\'); pos++; }
        break;
      }
      case '`': parseBackticks(); break;
      case '*': case '_': case '~': handleDelim(c); break;
      case '[': { pos++; const n = txt('['); brackets = { node: n, prev: brackets, prevDelim: delims, index: pos, active: true, image: false }; break; }
      case '!':
        if (subject[pos + 1] === '[') { pos += 2; const n = txt('!['); brackets = { node: n, prev: brackets, prevDelim: delims, index: pos, active: true, image: true }; }
        else { txt('!'); pos++; }
        break;
      case ']': parseCloseBracket(); break;
      case '<': {
        const rest = subject.slice(pos);
        let m;
        if ((m = AUTOLINK.exec(rest))) { push({ type: 'link', dest: m[1], title: null, children: [{ type: 'text', literal: m[1] }] }); pos += m[0].length; }
        else if ((m = EMAIL.exec(rest))) { push({ type: 'link', dest: 'mailto:' + m[1], title: null, children: [{ type: 'text', literal: m[1] }] }); pos += m[0].length; }
        else { txt('<'); pos++; }
        break;
      }
      case '&': {
        const m = ENT_RE.exec(subject.slice(pos, pos + 40));
        const d = m ? decodeEntity(m) : null;
        if (d !== null) { txt(d); pos += m[0].length; } else { txt('&'); pos++; }
        break;
      }
      default: {
        let j = pos + 1;
        while (j < subject.length && !'\n\\`*_~[]!<&'.includes(subject[j])) j++;
        txt(subject.slice(pos, j)); pos = j;
      }
    }
  }
  processEmphasis(null);
  return mergeText(root.children);
}
function mergeText(nodes) {
  const out = [];
  for (const n of nodes) {
    if (n.children) n.children = mergeText(n.children);
    if (n.type === 'text') {
      if (n.literal === '') continue;
      const l = out[out.length - 1];
      if (l && l.type === 'text') { l.literal += n.literal; continue; }
    }
    out.push(n);
  }
  return out;
}

// ---------------------------------------------------------------- rendering
function plain(nodes) {
  let s = '';
  for (const n of nodes) {
    if (n.type === 'text' || n.type === 'code') s += n.literal;
    else if (n.type === 'softbreak' || n.type === 'linebreak') s += n.type === 'softbreak' ? '\n' : '\n';
    else if (n.children) s += plain(n.children);
  }
  return s;
}
function renderInline(nodes) {
  let o = '';
  for (const n of nodes) {
    switch (n.type) {
      case 'text': o += esc(n.literal); break;
      case 'softbreak': o += '\n'; break;
      case 'linebreak': o += '<br />\n'; break;
      case 'code': o += '<code>' + esc(n.literal) + '</code>'; break;
      case 'em': o += '<em>' + renderInline(n.children) + '</em>'; break;
      case 'strong': o += '<strong>' + renderInline(n.children) + '</strong>'; break;
      case 'del': o += '<del>' + renderInline(n.children) + '</del>'; break;
      case 'link':
        o += '<a href="' + esc(safeUrl(normalizeURI(n.dest))) + '"' + (n.title ? ' title="' + esc(n.title) + '"' : '') + '>' + renderInline(n.children) + '</a>';
        break;
      case 'image':
        o += '<img src="' + esc(safeUrl(normalizeURI(n.dest))) + '" alt="' + esc(plain(n.children)) + '"' + (n.title ? ' title="' + esc(n.title) + '"' : '') + ' />';
        break;
    }
  }
  return o;
}

export function slugify(text, seen) {
  const base = String(text).toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
  if (!(seen instanceof Map)) return base;
  if (!seen.has(base)) { seen.set(base, 0); return base; }
  const n = seen.get(base) + 1;
  seen.set(base, n);
  return base + '-' + n;
}

function renderBlocks(doc, refs, opts) {
  const seen = new Map();
  const inl = s => parseInlines(s, refs);
  function rb(b, tight) {
    switch (b.type) {
      case 'paragraph': {
        const c = inl(b.content.replace(/[ \t\n]+$/, ''));
        return tight ? renderInline(c) : '<p>' + renderInline(c) + '</p>\n';
      }
      case 'heading': {
        const c = inl(b.content);
        const id = opts.headingIds ? ' id="' + esc(slugify(plain(c), seen)) + '"' : '';
        return `<h${b.level}${id}>` + renderInline(c) + `</h${b.level}>\n`;
      }
      case 'thematic_break': return '<hr />\n';
      case 'code_block': {
        const lang = b.fenced && b.info ? b.info.split(/\s+/)[0] : '';
        return '<pre><code' + (lang ? ' class="language-' + esc(lang) + '"' : '') + '>' + esc(b.content) + '</code></pre>\n';
      }
      case 'block_quote': return '<blockquote>\n' + b.children.map(c => rb(c, false)).join('') + '</blockquote>\n';
      case 'list': {
        const tag = b.listData.type === 'ordered' ? 'ol' : 'ul';
        const st = tag === 'ol' && b.listData.start !== 1 ? ` start="${b.listData.start}"` : '';
        return `<${tag}${st}>\n` + b.children.map(i => rb(i, b.tight)).join('') + `</${tag}>\n`;
      }
      case 'item': {
        let o = '<li>';
        b.children.forEach((c, i) => {
          const r = rb(c, tight);
          if (tight && c.type === 'paragraph') { o += r; if (i < b.children.length - 1) o += '\n'; }
          else { if (!o.endsWith('\n') && !o.endsWith('<li>')) o += '\n'; else if (o.endsWith('<li>')) o += '\n'; o += r; }
        });
        return o + '</li>\n';
      }
      case 'table': {
        const al = i => (b.aligns[i] ? ` align="${b.aligns[i]}"` : '');
        const row = (cells, tag) => '<tr>\n' + b.aligns.map((_, i) => `<${tag}${al(i)}>` + renderInline(inl(cells[i] || '')) + `</${tag}>\n`).join('') + '</tr>\n';
        let o = '<table>\n<thead>\n' + row(b.header, 'th') + '</thead>\n';
        if (b.rows.length) o += '<tbody>\n' + b.rows.map(r => row(r, 'td')).join('') + '</tbody>\n';
        return o + '</table>\n';
      }
    }
    return '';
  }
  return doc.children.map(c => rb(c, false)).join('');
}

export function render(markdown, { headingIds = false } = {}) {
  const { doc, refs } = parseBlocks(String(markdown));
  return renderBlocks(doc, refs, { headingIds });
}

export function toc(markdown) {
  const { doc, refs } = parseBlocks(String(markdown));
  const seen = new Map(), out = [];
  (function walk(b) {
    if (b.type === 'heading') {
      const text = plain(parseInlines(b.content, refs));
      out.push({ level: b.level, text, slug: slugify(text, seen) });
    }
    if (b.children) b.children.forEach(walk);
  })(doc);
  return out;
}
