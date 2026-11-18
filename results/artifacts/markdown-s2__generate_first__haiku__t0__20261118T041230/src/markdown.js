// Safe Markdown -> HTML renderer (CommonMark 0.31 + GFM tables/strikethrough).
// Original implementation written for this project.
//
// Architecture:
//   1. Block parser: line-by-line container/leaf tree construction
//      (blockquotes, lists, items, headings, fenced/indented code,
//      paragraphs, GFM tables, thematic breaks, link reference definitions).
//   2. Inline parser: flat token list with CommonMark-style delimiter
//      processing for emphasis/strong/strikethrough, bracket matching for
//      links/images, code spans, autolinks, entities and escapes.
//   3. Renderer: HTML with raw HTML escaped and dangerous URL schemes replaced.

const ENTITIES = new Map(Object.entries({
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™', hellip: '…',
  mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', euro: '€', pound: '£',
  yen: '¥', cent: '¢', sect: '§', deg: '°',
  plusmn: '±', times: '×', divide: '÷', middot: '·',
  laquo: '«', raquo: '»', bull: '•', para: '¶',
  frac12: '½', frac14: '¼', frac34: '¾', iexcl: '¡',
  iquest: '¿', shy: '­', larr: '←', rarr: '→',
  uarr: '↑', darr: '↓', hearts: '♥',
}));

const ASCII_PUNCT = /^[!-\/:-@\[-`{-~]$/;
const UNICODE_PUNCT = /^[\p{P}\p{S}]$/u;
const EMAIL_AUTOLINK = /<([a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/y;
const URI_AUTOLINK = /<([A-Za-z][A-Za-z0-9.+-]{1,31}:[^<>\x00-\x20]*)>/y;
const ENTITY_RE = /&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/y;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function decodeEntity(e) {
  if (e[0] === '#') {
    const code = (e[1] === 'x' || e[1] === 'X')
      ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    if (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
    return String.fromCodePoint(code);
  }
  return ENTITIES.has(e) ? ENTITIES.get(e) : null;
}

function unescapeString(s) {
  return s.replace(/\\([!-\/:-@\[-`{-~])|&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g,
    (m, p, e) => {
      if (p) return p;
      const d = decodeEntity(e);
      return d === null ? m : d;
    });
}

function normalizeLabel(s) {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

// Percent-encode characters that are not valid in a URL, keeping existing %XX.
function normalizeURI(u) {
  let out = '';
  for (let i = 0; i < u.length; i++) {
    const c = u[i];
    if (c === '%' && /^[0-9a-fA-F]{2}$/.test(u.slice(i + 1, i + 3))) { out += c; continue; }
    if (/[A-Za-z0-9;,/?:@&=+$\-_.!~*'()#]/.test(c)) { out += c; continue; }
    const ch = String.fromCodePoint(u.codePointAt(i));
    i += ch.length - 1;
    try {
      out += encodeURIComponent(ch);
    } catch {
      out += '%EF%BF%BD';
    }
  }
  return out;
}

function safeUrl(url) {
  const s = url.replace(/[\u0000- ]/g, '').toLowerCase();
  if (/^(javascript|vbscript|file):/.test(s)) return '#';
  if (/^data:/.test(s) && !/^data:image\/(png|gif|jpeg|webp);/.test(s)) return '#';
  return url;
}

// Skip spaces/tabs and at most one line ending.
function skipWs(s, p) {
  while (s[p] === ' ' || s[p] === '\t') p++;
  if (s[p] === '\n') {
    p++;
    while (s[p] === ' ' || s[p] === '\t') p++;
  }
  return p;
}

// Split a GFM table row into raw cell strings (escaped pipes are kept).
function splitRow(s) {
  let t = s.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '\\' && i + 1 < t.length) {
      cur += c + t[i + 1];
      i++;
    } else if (c === '|') {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  cells.push(cur.trim());
  return cells;
}

// Returns an array of alignments (null | 'left' | 'right' | 'center') or null.
function parseDelimRow(s) {
  const t = s.trim();
  if (!/^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(t)) return null;
  const cells = splitRow(t);
  if (cells.some(c => !/^:?-+:?$/.test(c))) return null;
  return cells.map(c => {
    const l = c.startsWith(':');
    const r = c.endsWith(':');
    if (l && r) return 'center';
    if (r) return 'right';
    if (l) return 'left';
    return null;
  });
}

// Expand tabs that appear in the leading whitespace of a line to spaces
// (tab stops every 4 columns).
function expandLeadingTabs(line) {
  let col = 0;
  let i = 0;
  let out = '';
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === '\t') {
      const n = 4 - (col % 4);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += ' ';
      col++;
    }
    i++;
  }
  return out + line.slice(i);
}

// ---------------------------------------------------------------------------
// Link reference definitions
// ---------------------------------------------------------------------------

function parseDef(text, pos) {
  const s = text.slice(pos);
  const m = /^ {0,3}\[((?:[^\\[\]]|\\.)+)\]:/.exec(s);
  if (!m || m[1].trim() === '' || m[1].length > 999) return null;
  let i = skipWs(s, m[0].length);
  let url;
  if (s[i] === '<') {
    const mm = /^<((?:[^<>\n\\]|\\.)*)>/.exec(s.slice(i));
    if (!mm) return null;
    url = mm[1];
    i += mm[0].length;
  } else {
    const mm = /^[^\s]+/.exec(s.slice(i));
    if (!mm) return null;
    url = mm[0];
    i += mm[0].length;
  }
  const afterDest = i;
  let title = null;
  let end = -1;
  const j = skipWs(s, i);
  if (j > i) {
    const tm = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|\(((?:[^()\\]|\\.)*)\))/.exec(s.slice(j));
    if (tm) {
      const after = j + tm[0].length;
      const lm = /^[ \t]*(?:\n|$)/.exec(s.slice(after));
      if (lm) {
        title = tm[1] ?? tm[2] ?? tm[3];
        end = after + lm[0].length;
      }
    }
  }
  if (end < 0) {
    const lm = /^[ \t]*(?:\n|$)/.exec(s.slice(afterDest));
    if (!lm) return null;
    end = afterDest + lm[0].length;
  }
  return {
    def: {
      label: normalizeLabel(m[1]),
      url: unescapeString(url),
      title: title == null ? null : unescapeString(title),
    },
    end: pos + end,
  };
}

function extractDefs(text) {
  const defs = [];
  let pos = 0;
  for (;;) {
    const r = parseDef(text, pos);
    if (!r) break;
    defs.push(r.def);
    pos = r.end;
  }
  return { defs, rest: text.slice(pos) };
}

// ---------------------------------------------------------------------------
// Block structure
// ---------------------------------------------------------------------------

class Node {
  constructor(type, lineNumber) {
    this.type = type;
    this.parent = null;
    this.children = [];
    this.open = true;
    this.lastLineBlank = false;
    this.line = lineNumber;
    this.lines = [];
    this.text = '';
    this.data = {};
  }

  get lastChild() {
    return this.children[this.children.length - 1] || null;
  }
}

function canContain(parentType, childType) {
  switch (parentType) {
    case 'document':
    case 'blockquote':
    case 'item':
      return childType !== 'item';
    case 'list':
      return childType === 'item';
    default:
      return false;
  }
}

function acceptsLines(type) {
  return type === 'paragraph' || type === 'code_block' || type === 'table';
}

function listsMatch(a, b) {
  return a.type === b.type && a.bulletChar === b.bulletChar && a.delimiter === b.delimiter;
}

function endsWithBlankLine(b) {
  while (b) {
    if (b.lastLineBlank) return true;
    if ((b.type === 'list' || b.type === 'item') && b.lastChild) b = b.lastChild;
    else break;
  }
  return false;
}

class BlockParser {
  constructor() {
    this.doc = new Node('document', 0);
    this.tip = this.doc;
    this.oldtip = this.doc;
    this.lastMatched = this.doc;
    this.allClosed = true;
    this.refs = new Map();
    this.lineNumber = 0;
    this.skipAdd = false;
    this.raw = '';
    this.line = '';
    this.offset = 0;
    this.nextNonspace = 0;
    this.indent = 0;
    this.blank = false;
  }

  parse(src) {
    const lines = src.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    for (const raw of lines) this.incorporate(raw);
    this.lastMatched = this.doc;
    this.oldtip = this.tip;
    this.allClosed = false;
    this.closeUnmatched();
    this.finalize(this.doc);
  }

  // --- line scanning helpers -------------------------------------------------

  findNextNonspace() {
    let i = this.offset;
    const s = this.line;
    while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
    this.nextNonspace = i;
    this.indent = i - this.offset;
    this.blank = i >= s.length;
  }

  advanceNextNonspace() {
    this.offset = this.nextNonspace;
  }

  addLine() {
    if (this.tip.type === 'code_block' && this.tip.data.fenced) {
      // Fenced code keeps original tabs: take the raw suffix that corresponds
      // to the unexpanded remainder of the line.
      const suffix = this.line.length - this.offset;
      const rawIdx = Math.max(0, this.raw.length - suffix);
      this.tip.lines.push(this.raw.slice(rawIdx));
      return;
    }
    this.tip.lines.push(this.line.slice(this.offset));
  }

  addChild(type) {
    while (!canContain(this.tip.type, type)) this.finalize(this.tip);
    const node = new Node(type, this.lineNumber);
    node.parent = this.tip;
    this.tip.children.push(node);
    this.tip = node;
    return node;
  }

  closeUnmatched() {
    if (!this.allClosed) {
      while (this.oldtip !== this.lastMatched) {
        const parent = this.oldtip.parent;
        this.finalize(this.oldtip);
        this.oldtip = parent;
      }
      this.allClosed = true;
    }
  }

  applyDefs(defs) {
    for (const d of defs) {
      if (!this.refs.has(d.label)) this.refs.set(d.label, d);
    }
  }

  // --- finalization ----------------------------------------------------------

  finalize(b) {
    b.open = false;
    this.tip = b.parent;
    switch (b.type) {
      case 'paragraph': {
        const { defs, rest } = extractDefs(b.lines.join('\n'));
        this.applyDefs(defs);
        if (rest.trim() === '') {
          if (b.parent) b.parent.children = b.parent.children.filter(c => c !== b);
        } else {
          b.text = rest;
        }
        b.lines = [];
        break;
      }
      case 'code_block': {
        if (b.data.fenced) {
          const first = b.lines.shift() || '';
          b.data.info = unescapeString(first.trim());
        } else {
          while (b.lines.length && b.lines[b.lines.length - 1].trim() === '') b.lines.pop();
        }
        b.text = b.lines.map(l => l + '\n').join('');
        b.lines = [];
        break;
      }
      case 'list': {
        let tight = true;
        const items = b.children;
        outer:
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          if (endsWithBlankLine(item) && i < items.length - 1) { tight = false; break; }
          const subs = item.children;
          for (let j = 0; j < subs.length; j++) {
            if (endsWithBlankLine(subs[j]) && (i < items.length - 1 || j < subs.length - 1)) {
              tight = false;
              break outer;
            }
          }
        }
        b.data.tight = tight;
        break;
      }
      default:
        break;
    }
  }

  // --- continuation of open containers ---------------------------------------

  // Returns 0 (matched), 1 (not matched), 2 (line consumed).
  continueBlock(c) {
    switch (c.type) {
      case 'document':
        return 0;
      case 'blockquote':
        if (this.indent <= 3 && this.line[this.nextNonspace] === '>') {
          this.advanceNextNonspace();
          this.offset += 1;
          if (this.line[this.offset] === ' ') this.offset += 1;
          return 0;
        }
        return 1;
      case 'item':
        if (this.blank) {
          if (c.children.length === 0) return 1;
          this.advanceNextNonspace();
          return 0;
        }
        if (this.indent >= c.data.markerOffset + c.data.padding) {
          this.offset += c.data.markerOffset + c.data.padding;
          return 0;
        }
        return 1;
      case 'heading':
      case 'thematic_break':
        return 1;
      case 'code_block': {
        if (c.data.fenced) {
          if (this.indent <= 3) {
            const m = this.line.slice(this.nextNonspace).match(/^(`{3,}|~{3,})[ \t]*$/);
            if (m && m[1][0] === c.data.fenceChar && m[1].length >= c.data.fenceLength) {
              this.finalize(c);
              this.offset = this.line.length;
              return 2;
            }
          }
          let i = 0;
          while (i < c.data.fenceOffset && this.line[this.offset] === ' ') {
            this.offset++;
            i++;
          }
          return 0;
        }
        if (this.indent >= 4) {
          this.offset += 4;
          return 0;
        }
        if (this.blank) {
          this.advanceNextNonspace();
          return 0;
        }
        return 1;
      }
      case 'paragraph':
      case 'table':
        return this.blank ? 1 : 0;
      default:
        return 0; // list
    }
  }

  // --- block starts ----------------------------------------------------------
  // Each returns 0 (no match), 1 (container opened), 2 (leaf consumed line).

  startBlock(c) {
    return this.bqStart(c) || this.atxStart(c) || this.fenceStart(c)
      || this.setextStart(c) || this.tableStart(c) || this.hrStart(c)
      || this.listStart(c) || this.indentedStart(c);
  }

  bqStart() {
    if (this.indent >= 4 || this.line[this.nextNonspace] !== '>') return 0;
    this.advanceNextNonspace();
    this.offset += 1;
    if (this.line[this.offset] === ' ') this.offset += 1;
    this.closeUnmatched();
    this.addChild('blockquote');
    return 1;
  }

  atxStart() {
    if (this.indent >= 4) return 0;
    const rest = this.line.slice(this.nextNonspace);
    const m = rest.match(/^(#{1,6})(?=[ \t]|$)/);
    if (!m) return 0;
    let content = rest.slice(m[1].length).replace(/^[ \t]+/, '');
    content = content.replace(/(^|[ \t]+)#+[ \t]*$/, '').replace(/[ \t]+$/, '');
    this.closeUnmatched();
    const h = this.addChild('heading');
    h.data.level = m[1].length;
    h.text = content;
    this.offset = this.line.length;
    return 2;
  }

  fenceStart() {
    if (this.indent >= 4) return 0;
    const rest = this.line.slice(this.nextNonspace);
    const m = rest.match(/^(`{3,}(?=[^`]*$)|~{3,})/);
    if (!m) return 0;
    const fence = m[1];
    this.closeUnmatched();
    const b = this.addChild('code_block');
    b.data.fenced = true;
    b.data.fenceChar = fence[0];
    b.data.fenceLength = fence.length;
    b.data.fenceOffset = this.indent;
    this.offset = this.nextNonspace + fence.length;
    return 2;
  }

  setextStart(c) {
    if (c.type !== 'paragraph' || this.indent >= 4) return 0;
    const m = this.line.slice(this.nextNonspace).match(/^(=+|-+)[ \t]*$/);
    if (!m) return 0;
    const r = extractDefs(c.lines.join('\n'));
    if (r.rest.trim() === '') return 0;
    this.applyDefs(r.defs);
    c.type = 'heading';
    c.data.level = m[1][0] === '=' ? 1 : 2;
    c.text = r.rest;
    c.lines = [];
    this.offset = this.line.length;
    return 2;
  }

  tableStart(c) {
    if (c.type !== 'paragraph' || c.lines.length !== 1 || this.blank || this.indent >= 4) return 0;
    const rest = this.line.slice(this.nextNonspace);
    const align = parseDelimRow(rest);
    if (!align) return 0;
    const header = c.lines[0];
    if (!header.includes('|') && !rest.includes('|')) return 0;
    if (splitRow(header).length !== align.length) return 0;
    c.type = 'table';
    c.data.align = align;
    c.data.header = header;
    c.lines = [];
    this.skipAdd = true;
    this.offset = this.line.length;
    return 2;
  }

  hrStart() {
    if (this.indent >= 4) return 0;
    const rest = this.line.slice(this.nextNonspace);
    if (!/^(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/.test(rest)) return 0;
    this.closeUnmatched();
    this.addChild('thematic_break');
    this.offset = this.line.length;
    return 2;
  }

  listStart(c) {
    if (this.indent >= 4) return 0;
    const rest = this.line.slice(this.nextNonspace);
    let m;
    let data;
    if ((m = rest.match(/^([*+-])(?=[ \t]|$)/))) {
      data = { type: 'bullet', bulletChar: m[1], delimiter: null, start: null };
    } else if ((m = rest.match(/^(\d{1,9})([.)])(?=[ \t]|$)/))) {
      data = { type: 'ordered', bulletChar: null, delimiter: m[2], start: parseInt(m[1], 10) };
    } else {
      return 0;
    }
    const markerWidth = m[0].length;
    const after = rest.slice(markerWidth);
    const blankItem = after.trim() === '';
    if (c.type === 'paragraph' && (blankItem || (data.type === 'ordered' && data.start !== 1))) {
      return 0;
    }
    const wsAfter = after.match(/^[ \t]*/)[0].length;
    const spacesAfter = (blankItem || wsAfter >= 5) ? 1 : wsAfter;
    data.markerOffset = this.indent;
    data.padding = markerWidth + spacesAfter;

    this.closeUnmatched();
    if (c.type !== 'list' || !listsMatch(c.data, data)) {
      const list = this.addChild('list');
      list.data = { ...data, tight: true };
    }
    const item = this.addChild('item');
    item.data = { ...data };
    this.offset = this.nextNonspace + markerWidth + spacesAfter;
    return 1;
  }

  indentedStart() {
    if (this.indent < 4 || this.blank) return 0;
    if (this.tip.type === 'paragraph' || this.tip.type === 'table') return 0;
    this.offset += 4;
    this.closeUnmatched();
    this.addChild('code_block');
    return 2;
  }

  // --- line processing -------------------------------------------------------

  incorporate(raw) {
    this.raw = raw;
    this.line = expandLeadingTabs(raw);
    this.offset = 0;
    this.nextNonspace = 0;
    this.indent = 0;
    this.blank = false;
    this.skipAdd = false;
    this.lineNumber++;

    let container = this.doc;
    this.oldtip = this.tip;
    this.allClosed = container === this.oldtip;

    let last;
    while ((last = container.lastChild) && last.open) {
      container = last;
      this.findNextNonspace();
      const r = this.continueBlock(container);
      if (r === 0) continue;
      if (r === 1) {
        container = container.parent;
        break;
      }
      return; // r === 2: line consumed
    }

    this.allClosed = container === this.oldtip;
    this.lastMatched = container;

    let matchedLeaf = container.type === 'code_block';
    while (!matchedLeaf) {
      this.findNextNonspace();
      const res = this.startBlock(container);
      if (res === 0) {
        this.advanceNextNonspace();
        break;
      }
      container = this.tip;
      if (res === 2) matchedLeaf = true;
    }

    if (!this.allClosed && !this.blank && this.tip.type === 'paragraph') {
      // lazy paragraph continuation
      this.addLine();
      return;
    }

    this.closeUnmatched();
    if (this.blank && container.lastChild) container.lastChild.lastLineBlank = true;

    const t = container.type;
    const lastLineBlank = this.blank && !(
      t === 'blockquote'
      || (t === 'code_block' && container.data.fenced)
      || (t === 'item' && container.children.length === 0 && container.line === this.lineNumber)
    );
    for (let c = container; c; c = c.parent) c.lastLineBlank = lastLineBlank;

    if (this.skipAdd) {
      this.skipAdd = false;
    } else if (acceptsLines(t)) {
      this.addLine();
    } else if (this.offset < this.line.length && !this.blank) {
      container = this.addChild('paragraph');
      this.advanceNextNonspace();
      this.addLine();
    }
  }
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

function resolveLink(s, pos, label, refs) {
  if (s[pos] === '(') {
    const r = parseInlineTail(s, pos);
    if (r) return r;
  }
  const m = /^\[((?:[^\\[\]]|\\.)*)\]/.exec(s.slice(pos));
  let refLabel;
  let end;
  if (m) {
    if (m[1].trim() === '') {
      refLabel = label;
      end = pos + 2;
    } else {
      refLabel = m[1];
      end = pos + m[0].length;
    }
  } else {
    refLabel = label;
    end = pos;
  }
  const def = refs.get(normalizeLabel(refLabel));
  if (!def) return null;
  return { url: def.url, title: def.title, end };
}

// Parses the `(dest "title")` tail of an inline link. s[j] === '('.
function parseInlineTail(s, j) {
  let p = skipWs(s, j + 1);
  let dest = '';
  if (s[p] === '<') {
    let q = p + 1;
    let out = '';
    while (q < s.length && s[q] !== '>' && s[q] !== '\n' && s[q] !== '<') {
      if (s[q] === '\\' && s[q + 1] !== undefined && ASCII_PUNCT.test(s[q + 1])) {
        out += s[q] + s[q + 1];
        q += 2;
      } else {
        out += s[q++];
      }
    }
    if (s[q] !== '>') return null;
    dest = out;
    p = q + 1;
  } else {
    let depth = 0;
    let q = p;
    let out = '';
    while (q < s.length) {
      const c = s[q];
      if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 0x20) break;
      if (c === '\\' && s[q + 1] !== undefined && ASCII_PUNCT.test(s[q + 1])) {
        out += c + s[q + 1];
        q += 2;
        continue;
      }
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      }
      out += c;
      q++;
    }
    if (depth !== 0) return null;
    dest = out;
    p = q;
  }
  const wsStart = p;
  p = skipWs(s, p);
  let title = null;
  if (p > wsStart && (s[p] === '"' || s[p] === "'" || s[p] === '(')) {
    const close = s[p] === '(' ? ')' : s[p];
    let q = p + 1;
    let out = '';
    while (q < s.length && s[q] !== close) {
      if (s[q] === '\\' && q + 1 < s.length) {
        out += s[q] + s[q + 1];
        q += 2;
        continue;
      }
      if (close === ')' && s[q] === '(') return null;
      out += s[q++];
    }
    if (s[q] !== close) return null;
    title = unescapeString(out);
    p = skipWs(s, q + 1);
  }
  if (s[p] !== ')') return null;
  return { url: unescapeString(dest), title, end: p + 1 };
}

function renderTokens(toks) {
  let out = '';
  for (const t of toks) {
    if (t.k === 's') out += t.h;
    else if (t.k === 'd') out += t.close.join('') + t.ch.repeat(t.n) + t.open.join('');
    else if (t.k === 'b') out += escapeHtml(t.img ? '![' : '[');
  }
  return out;
}

function plainTokens(toks) {
  let out = '';
  for (const t of toks) {
    if (t.k === 's') out += t.p;
    else if (t.k === 'd') out += t.ch.repeat(t.n);
    else if (t.k === 'b') out += t.img ? '![' : '[';
  }
  return out;
}

// CommonMark "process emphasis" over tokens[start..].
function processEmphasis(toks, start) {
  for (let ci = start; ci < toks.length; ci++) {
    const closer = toks[ci];
    if (closer.k !== 'd' || !closer.canClose) continue;
    while (closer.n > 0) {
      let oi = -1;
      for (let j = ci - 1; j >= start; j--) {
        const o = toks[j];
        if (o.k !== 'd' || !o.active || !o.canOpen || o.n === 0 || o.ch !== closer.ch) continue;
        if ((closer.canOpen || o.canClose) && (o.orig + closer.orig) % 3 === 0
          && !(o.orig % 3 === 0 && closer.orig % 3 === 0)) continue;
        if (closer.ch === '~' && o.n !== closer.n) continue;
        oi = j;
        break;
      }
      if (oi < 0) break;
      const o = toks[oi];
      const use = closer.ch === '~' ? closer.n : (closer.n >= 2 && o.n >= 2 ? 2 : 1);
      const tag = closer.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em');
      o.n -= use;
      closer.n -= use;
      o.open.unshift(`<${tag}>`);
      closer.close.push(`</${tag}>`);
      for (let k = oi + 1; k < ci; k++) {
        if (toks[k].k === 'd') toks[k].active = false;
      }
    }
  }
}

function inline(src, refs) {
  const s = String(src).replace(/[ \t]+$/, '');
  const toks = [];
  const brackets = [];
  let buf = '';

  const flush = () => {
    if (buf) {
      toks.push({ k: 's', h: escapeHtml(buf), p: buf });
      buf = '';
    }
  };
  const push = (tok) => {
    flush();
    toks.push(tok);
  };
  const isWs = c => c === undefined || /\s/.test(c);
  const isPunct = c => c !== undefined && UNICODE_PUNCT.test(c);

  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];

    if (c === '\\') {
      const d = s[i + 1];
      if (d === '\n') {
        push({ k: 's', h: '<br />\n', p: '\n' });
        i += 2;
        while (s[i] === ' ' || s[i] === '\t') i++;
        continue;
      }
      if (d !== undefined && ASCII_PUNCT.test(d)) {
        buf += d;
        i += 2;
        continue;
      }
      buf += c;
      i++;
      continue;
    }

    if (c === '`') {
      let L = 0;
      while (s[i + L] === '`') L++;
      const re = new RegExp('(?<!`)`{' + L + '}(?!`)', 'g');
      re.lastIndex = i + L;
      const m = re.exec(s);
      if (m) {
        let content = s.slice(i + L, m.index).replace(/\n/g, ' ');
        if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' '
          && /[^ ]/.test(content)) {
          content = content.slice(1, -1);
        }
        push({ k: 's', h: `<code>${escapeHtml(content)}</code>`, p: content });
        i = m.index + L;
      } else {
        buf += '`'.repeat(L);
        i += L;
      }
      continue;
    }

    if (c === '*' || c === '_' || c === '~') {
      let L = 0;
      while (s[i + L] === c) L++;
      if (c === '~' && L > 2) {
        buf += c.repeat(L);
        i += L;
        continue;
      }
      const before = i > 0 ? s[i - 1] : undefined;
      const after = s[i + L];
      const bWs = isWs(before);
      const aWs = isWs(after);
      const bP = isPunct(before);
      const aP = isPunct(after);
      const left = !aWs && (!aP || bWs || bP);
      const right = !bWs && (!bP || aWs || aP);
      let canOpen;
      let canClose;
      if (c === '_') {
        canOpen = left && (!right || bP);
        canClose = right && (!left || aP);
      } else {
        canOpen = left;
        canClose = right;
      }
      if (!canOpen && !canClose) {
        buf += c.repeat(L);
        i += L;
        continue;
      }
      push({ k: 'd', ch: c, n: L, orig: L, canOpen, canClose, open: [], close: [], active: true });
      i += L;
      continue;
    }

    if (c === '[') {
      const tok = { k: 'b', img: false, active: true, start: i + 1 };
      push(tok);
      brackets.push(tok);
      i++;
      continue;
    }

    if (c === '!' && s[i + 1] === '[') {
      const tok = { k: 'b', img: true, active: true, start: i + 2 };
      push(tok);
      brackets.push(tok);
      i += 2;
      continue;
    }

    if (c === ']') {
      const opener = brackets.pop();
      if (!opener || !opener.active) {
        buf += ']';
        i++;
        continue;
      }
      const label = s.slice(opener.start, i);
      const r = resolveLink(s, i + 1, label, refs);
      if (!r) {
        buf += ']';
        i++;
        continue;
      }
      flush();
      const idx = toks.indexOf(opener);
      processEmphasis(toks, idx + 1);
      const inner = toks.splice(idx + 1);
      toks.pop(); // the opener itself
      const innerHtml = renderTokens(inner);
      const innerPlain = plainTokens(inner);
      const href = escapeHtml(normalizeURI(safeUrl(r.url)));
      const titleAttr = r.title != null ? ` title="${escapeHtml(r.title)}"` : '';
      const h = opener.img
        ? `<img src="${href}" alt="${escapeHtml(innerPlain)}"${titleAttr} />`
        : `<a href="${href}"${titleAttr}>${innerHtml}</a>`;
      toks.push({ k: 's', h, p: innerPlain });
      if (!opener.img) {
        for (const b of brackets) if (!b.img) b.active = false;
      }
      i = r.end;
      continue;
    }

    if (c === '<') {
      URI_AUTOLINK.lastIndex = i;
      let m = URI_AUTOLINK.exec(s);
      if (m) {
        push({
          k: 's',
          h: `<a href="${escapeHtml(normalizeURI(safeUrl(m[1])))}">${escapeHtml(m[1])}</a>`,
          p: m[1],
        });
        i += m[0].length;
        continue;
      }
      EMAIL_AUTOLINK.lastIndex = i;
      m = EMAIL_AUTOLINK.exec(s);
      if (m) {
        push({
          k: 's',
          h: `<a href="mailto:${escapeHtml(normalizeURI(m[1]))}">${escapeHtml(m[1])}</a>`,
          p: m[1],
        });
        i += m[0].length;
        continue;
      }
      buf += '<';
      i++;
      continue;
    }

    if (c === '&') {
      ENTITY_RE.lastIndex = i;
      const m = ENTITY_RE.exec(s);
      if (m) {
        const dec = decodeEntity(m[1]);
        if (dec !== null) {
          buf += dec;
          i += m[0].length;
          continue;
        }
      }
      buf += '&';
      i++;
      continue;
    }

    if (c === '\n') {
      const trailing = /( *)$/.exec(buf)[1];
      buf = buf.slice(0, buf.length - trailing.length);
      if (trailing.length >= 2) {
        push({ k: 's', h: '<br />\n', p: '\n' });
      } else {
        buf += '\n';
      }
      i++;
      while (s[i] === ' ' || s[i] === '\t') i++;
      continue;
    }

    buf += c;
    i++;
  }
  flush();
  processEmphasis(toks, 0);
  return { html: renderTokens(toks), plain: plainTokens(toks) };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderBlocks(node, ctx, tight) {
  const parts = [];
  for (const child of node.children) {
    const h = renderBlock(child, ctx, tight);
    if (h !== null && h !== '') parts.push(h);
  }
  return parts.join('\n');
}

function renderTable(n, ctx) {
  const aligns = n.data.align;
  const attr = i => (aligns[i] ? ` align="${aligns[i]}"` : '');
  const cellsOf = line => {
    const cells = splitRow(line);
    const out = [];
    for (let i = 0; i < aligns.length; i++) out.push(cells[i] ?? '');
    return out;
  };
  let out = '<table>\n<thead>\n<tr>\n';
  cellsOf(n.data.header).forEach((c, i) => {
    out += `<th${attr(i)}>${inline(c, ctx.refs).html}</th>\n`;
  });
  out += '</tr>\n</thead>\n';
  if (n.lines.length) {
    out += '<tbody>\n';
    for (const row of n.lines) {
      out += '<tr>\n';
      cellsOf(row).forEach((c, i) => {
        out += `<td${attr(i)}>${inline(c, ctx.refs).html}</td>\n`;
      });
      out += '</tr>\n';
    }
    out += '</tbody>\n';
  }
  out += '</table>';
  return out;
}

function renderBlock(n, ctx, tight) {
  switch (n.type) {
    case 'paragraph': {
      const inner = inline(n.text, ctx.refs).html;
      return tight ? inner : `<p>${inner}</p>`;
    }
    case 'heading': {
      const { html, plain } = inline(n.text, ctx.refs);
      let id = '';
      if (ctx.headingIds) {
        id = ` id="${escapeHtml(slugify(plain.replace(/\n/g, ' ').trim(), ctx.seen))}"`;
      }
      return `<h${n.data.level}${id}>${html}</h${n.data.level}>`;
    }
    case 'thematic_break':
      return '<hr />';
    case 'code_block': {
      const lang = n.data.fenced ? (n.data.info || '').split(/\s+/)[0] : '';
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      return `<pre><code${cls}>${escapeHtml(n.text)}</code></pre>`;
    }
    case 'blockquote':
      return `<blockquote>\n${renderBlocks(n, ctx, false)}\n</blockquote>`;
    case 'list': {
      const tag = n.data.type === 'bullet' ? 'ul' : 'ol';
      const startAttr = tag === 'ol' && n.data.start !== 1 ? ` start="${n.data.start}"` : '';
      const items = n.children.map(item => `<li>${renderBlocks(item, ctx, n.data.tight)}</li>`);
      return `<${tag}${startAttr}>\n${items.join('\n')}\n</${tag}>`;
    }
    case 'table':
      return renderTable(n, ctx);
    default:
      return '';
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

function parseDocument(markdown) {
  const src = String(markdown).replace(/\r\n?/g, '\n').replace(/\u0000/g, '�');
  const parser = new BlockParser();
  parser.parse(src);
  return { doc: parser.doc, refs: parser.refs };
}

function walk(node, fn) {
  for (const child of node.children) {
    fn(child);
    walk(child, fn);
  }
}

export function slugify(text, seen) {
  const base = String(text).toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-');
  if (!seen) return base;
  let slug = base;
  let k = 1;
  while (seen.has(slug)) slug = `${base}-${k++}`;
  seen.set(slug, true);
  return slug;
}

export function render(markdown, { headingIds = false } = {}) {
  const { doc, refs } = parseDocument(markdown);
  const ctx = { refs, headingIds, seen: new Map() };
  const html = renderBlocks(doc, ctx, false);
  return html ? html + '\n' : '';
}

export function toc(markdown) {
  const { doc, refs } = parseDocument(markdown);
  const seen = new Map();
  const out = [];
  walk(doc, n => {
    if (n.type !== 'heading') return;
    const text = inline(n.text, refs).plain.replace(/\n/g, ' ').trim();
    out.push({ level: n.data.level, text, slug: slugify(text, seen) });
  });
  return out;
}
