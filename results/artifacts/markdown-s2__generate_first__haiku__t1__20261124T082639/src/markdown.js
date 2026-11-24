// markdown-s2: safe CommonMark-style Markdown -> HTML renderer (with GFM tables
// and strikethrough). Written from scratch. See SPEC.md.
//
// Architecture:
//   1. Block parser: line-by-line container matching (blockquote, list items),
//      leaf blocks (paragraph, heading, code, table, thematic break).
//   2. Inline parser: tokenises into a flat item list, then resolves emphasis
//      with the CommonMark delimiter algorithm and links/images via a bracket
//      stack.
//   3. Renderer: walks the block tree and emits HTML. Raw HTML is never passed
//      through (it is escaped as text); dangerous URL schemes become '#'.

const ASCII_PUNCT_RE = /[!-\/:-@\[-`{-~]/;
const UNESCAPE_RE = /\\([!-\/:-@\[-`{-~])/g;
const ENTITY_RE = /&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g;
const ENTITY_AT = /&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/y;

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™', mdash: '—', ndash: '–',
  hellip: '…', laquo: '«', raquo: '»', ldquo: '“', rdquo: '”',
  lsquo: '‘', rsquo: '’', euro: '€', times: '×', middot: '·',
  para: '¶', sect: '§', deg: '°', plusmn: '±', frac12: '½',
  bull: '•', larr: '←', rarr: '→', uarr: '↑', darr: '↓',
  hearts: '♥',
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const isBlank = s => /^[ \t]*$/.test(s);
const isWS = c => c === undefined || /\s/.test(c);
const isPunct = c => c !== undefined && /[\p{P}\p{S}]/u.test(c);
const countIndent = s => { let i = 0; while (s[i] === ' ') i++; return i; };
const html = (v, p = '') => ({ t: 'html', v, p });

function decodeEntity(body) {
  if (body[0] === '#') {
    const hex = body[1] === 'x' || body[1] === 'X';
    const cp = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!Number.isFinite(cp) || cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) {
      return '�';
    }
    return String.fromCodePoint(cp);
  }
  return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : null;
}

const decodeEntities = s => s.replace(ENTITY_RE, (m, b) => {
  const d = decodeEntity(b);
  return d === null ? m : d;
});
const unescapeBackslash = s => s.replace(UNESCAPE_RE, '$1');
const unescapeAndDecode = s => decodeEntities(unescapeBackslash(s));
const normalizeLabel = l => l.replace(/\s+/g, ' ').trim().toLowerCase();

function normUrl(u) {
  try {
    return encodeURI(u).replace(/%25([0-9A-Fa-f]{2})/g, '%$1');
  } catch {
    return u;
  }
}

function safeHref(u) {
  const t = u.replace(/[\u0000- \u007f]/g, '');
  if (/^(javascript|vbscript|file):/i.test(t)) return '#';
  if (/^data:/i.test(t) && !/^data:image\/(png|gif|jpeg|webp);/i.test(t)) return '#';
  return u;
}

// Decode a raw link destination, check it for dangerous schemes, then normalise.
function linkHref(raw) {
  const decoded = unescapeAndDecode(raw);
  if (safeHref(decoded) === '#') return '#';
  return normUrl(decoded);
}

function expandLeadingTabs(line) {
  let col = 0;
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    col = line[i] === ' ' ? col + 1 : col + 4 - (col % 4);
    i++;
  }
  return ' '.repeat(col) + line.slice(i);
}

function skipSpaces(s, p) {
  while (s[p] === ' ' || s[p] === '\t') p++;
  return p;
}

// Skip spaces/tabs and at most one line ending (plus following indentation).
function skipWsNl(s, p) {
  p = skipSpaces(s, p);
  if (s[p] === '\n') p = skipSpaces(s, p + 1);
  return p;
}

// ---------------------------------------------------------------------------
// Slugs and headings
// ---------------------------------------------------------------------------

export function slugify(text, seen) {
  const s = String(text).toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
  if (!seen) return s;
  if (!seen.has(s)) {
    seen.set(s, 1);
    return s;
  }
  let k = seen.get(s);
  let cand;
  do {
    cand = `${s}-${k}`;
    k++;
  } while (seen.has(cand));
  seen.set(s, k);
  seen.set(cand, 1);
  return cand;
}

// ---------------------------------------------------------------------------
// Block structure
// ---------------------------------------------------------------------------

const DONE = Symbol('done');

function newNode(type, props = {}) {
  return Object.assign({
    type, children: [], parent: null, open: true, lastLineBlank: false,
  }, props);
}

function canContain(parentType, childType) {
  if (parentType === 'list') return childType === 'item';
  if (parentType === 'document' || parentType === 'blockquote' || parentType === 'item') {
    return childType !== 'item';
  }
  return false;
}

function addBlock(state, c, type, props) {
  while (!canContain(c.type, type)) c = c.parent;
  closeUnmatched(state, c);
  const node = newNode(type, props);
  node.parent = c;
  c.children.push(node);
  state.tip = node;
  return node;
}

function closeUnmatched(state, c) {
  while (state.tip !== c && state.tip.parent) {
    const t = state.tip;
    finalize(state, t);
    state.tip = t.parent;
  }
}

function finalize(state, node) {
  node.open = false;
  if (node.type === 'paragraph') {
    extractRefs(state, node);
    if (node.lines.length === 0) {
      node.parent.children = node.parent.children.filter(x => x !== node);
    }
  } else if (node.type === 'code_block' && !node.fenced) {
    while (node.lines.length && isBlank(node.lines[node.lines.length - 1])) node.lines.pop();
  }
}

function setBlankFlag(c, blank) {
  c.lastLineBlank = blank && c.type !== 'blockquote' && !(c.type === 'code_block' && c.fenced);
}

function consumeBQ(rest, ind) {
  let r = rest.slice(ind + 1);
  if (r[0] === ' ' || r[0] === '\t') r = r.slice(1);
  return r;
}

function atxContent(t) {
  let x = t.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  x = x.replace(/(^|[ \t]+)#+$/, '');
  return x.trim();
}

function startsOtherBlock(rest) {
  const ind = countIndent(rest);
  if (ind > 3) return false;
  const s = rest.slice(ind);
  return s[0] === '>'
    || /^#{1,6}(?=[ \t]|$)/.test(s)
    || /^(`{3,}|~{3,})/.test(s)
    || /^(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/.test(s);
}

// Returns the remaining text if the open container `node` continues on this
// line, null if it does not, or DONE if the line closed a fenced code block.
function continueBlock(state, node, rest) {
  const blank = isBlank(rest);
  switch (node.type) {
    case 'blockquote': {
      const ind = countIndent(rest);
      if (ind > 3 || rest[ind] !== '>') return null;
      return consumeBQ(rest, ind);
    }
    case 'list':
      return rest;
    case 'item': {
      if (blank) return node.children.length === 0 ? null : '';
      const need = node.markerOffset + node.padding;
      if (countIndent(rest) < need) return null;
      return rest.slice(need);
    }
    case 'paragraph':
      return blank ? null : rest;
    case 'code_block': {
      if (node.fenced) {
        const ind = countIndent(rest);
        const m = ind <= 3 ? /^(`+|~+)[ \t]*$/.exec(rest.slice(ind)) : null;
        if (m && m[1][0] === node.fenceChar && m[1].length >= node.fenceLen) {
          node.open = false;
          state.tip = node.parent;
          return DONE;
        }
        return rest.slice(Math.min(countIndent(rest), node.fenceIndent));
      }
      if (blank) return rest.slice(Math.min(countIndent(rest), 4));
      return countIndent(rest) >= 4 ? rest.slice(4) : null;
    }
    case 'table':
      return blank || startsOtherBlock(rest) ? null : rest;
    default:
      return null;
  }
}

// GFM table: the open paragraph's last line is the header row, `s` the delimiter row.
function tryTable(state, p, s) {
  if (!s.includes('|')) return null;
  if (!/^\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/.test(s)) return null;
  const delim = splitRow(s);
  const lines = p.lines;
  if (!lines.length) return null;
  const header = splitRow(lines[lines.length - 1]);
  if (header.length !== delim.length) return null;
  const aligns = delim.map(cell => {
    const l = cell.startsWith(':');
    const r = cell.endsWith(':');
    if (l && r) return 'center';
    if (l) return 'left';
    if (r) return 'right';
    return null;
  });
  const tbl = newNode('table', { header, aligns, rows: [] });
  const rem = lines.slice(0, -1);
  if (rem.length === 0) {
    const parent = p.parent;
    tbl.parent = parent;
    parent.children[parent.children.indexOf(p)] = tbl;
    p.open = false;
  } else {
    p.lines = rem;
    finalize(state, p);
    tbl.parent = p.parent;
    p.parent.children.push(tbl);
  }
  state.tip = tbl;
  return tbl;
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

function setext(state, p, s) {
  extractRefs(state, p);
  p.type = 'heading';
  p.level = s[0] === '=' ? 1 : 2;
  p.content = p.lines.join('\n').trim();
  p.lines = [];
  p.open = false;
  state.tip = p.parent;
}

// Process one input line against the block tree.
function incorporate(state, rawLine) {
  let rest = expandLeadingTabs(rawLine);
  let c = state.doc;

  // 1. Match open containers.
  for (;;) {
    const last = c.children[c.children.length - 1];
    if (!last || !last.open) break;
    const r = continueBlock(state, last, rest);
    if (r === DONE) return;
    if (r === null) break;
    rest = r;
    c = last;
  }

  const blank = isBlank(rest);

  // Matched open leaf that takes raw lines.
  if ((c.type === 'code_block' || c.type === 'table') && c.open) {
    if (c.type === 'code_block') c.lines.push(rest);
    else c.rows.push(splitRow(rest));
    setBlankFlag(c, blank);
    return;
  }

  // 2. Look for new block starts.
  let leafDone = false;
  let codeStarted = false;
  for (;;) {
    const indent = countIndent(rest);
    const s = rest.slice(indent);
    const inPara = c.type === 'paragraph';

    if (indent >= 4) {
      if (!blank && state.tip.type !== 'paragraph') {
        rest = rest.slice(4);
        c = addBlock(state, c, 'code_block', { fenced: false, lines: [] });
        codeStarted = true;
      }
      break;
    }

    if (s[0] === '>') {
      rest = consumeBQ(rest, indent);
      c = addBlock(state, c, 'blockquote', {});
      continue;
    }

    let m = /^(#{1,6})(?=[ \t]|$)/.exec(s);
    if (m) {
      c = addBlock(state, c, 'heading', { level: m[1].length, content: atxContent(s.slice(m[1].length)) });
      c.open = false;
      state.tip = c.parent;
      leafDone = true;
      break;
    }

    m = /^(`{3,}|~{3,})(.*)$/.exec(s);
    if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
      c = addBlock(state, c, 'code_block', {
        fenced: true, fenceChar: m[1][0], fenceLen: m[1].length,
        fenceIndent: indent, info: m[2].trim(), lines: [],
      });
      leafDone = true;
      break;
    }

    if (inPara) {
      const t = tryTable(state, c, s);
      if (t) {
        c = t;
        leafDone = true;
        break;
      }
      if (/^(=+|-+)[ \t]*$/.test(s)) {
        setext(state, c, s);
        leafDone = true;
        break;
      }
    }

    if (/^(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/.test(s)) {
      c = addBlock(state, c, 'thematic_break', {});
      c.open = false;
      state.tip = c.parent;
      leafDone = true;
      break;
    }

    m = /^(?:([*+-])|(\d{1,9})([.)]))(?=[ \t]|$)/.exec(s);
    if (m) {
      const ordered = m[1] === undefined;
      const markerLen = m[0].length;
      const after = s.slice(markerLen);
      const emptyItem = isBlank(after);
      const num = ordered ? parseInt(m[2], 10) : 0;
      // Only a non-empty item starting at 1 may interrupt a paragraph.
      if (!(inPara && (emptyItem || (ordered && num !== 1)))) {
        const sp = /^[ \t]*/.exec(after)[0].length;
        let pad;
        let content;
        if (emptyItem) {
          pad = 1;
          content = '';
        } else if (sp >= 5) {
          pad = 1;
          content = after.slice(1);
        } else {
          pad = sp;
          content = after.slice(sp);
        }
        const sameList = c.type === 'list'
          && (ordered ? c.ordered && c.delim === m[3] : !c.ordered && c.bullet === m[1]);
        if (!sameList) {
          c = addBlock(state, c, 'list', {
            ordered, start: num, delim: ordered ? m[3] : null, bullet: ordered ? null : m[1],
          });
        }
        c = addBlock(state, c, 'item', { markerOffset: indent, padding: markerLen + pad });
        rest = content;
        continue;
      }
    }
    break;
  }

  if (leafDone) {
    setBlankFlag(c, blank);
    return;
  }
  if (codeStarted) {
    c.lines.push(rest);
    setBlankFlag(c, false);
    return;
  }

  // 3. Blank lines close unmatched blocks.
  if (blank) {
    closeUnmatched(state, c);
    const lc = c.children[c.children.length - 1];
    if (lc) lc.lastLineBlank = true;
    setBlankFlag(c, true);
    return;
  }

  // 4. Paragraph continuation (or lazy continuation).
  if (state.tip.type === 'paragraph' && state.tip.open) {
    state.tip.lines.push(rest.trimStart());
    setBlankFlag(c, false);
    return;
  }

  // 5. New paragraph.
  closeUnmatched(state, c);
  c = addBlock(state, c, 'paragraph', { lines: [rest.trimStart()] });
  setBlankFlag(c, false);
}

// ---------------------------------------------------------------------------
// Link reference definitions
// ---------------------------------------------------------------------------

function extractRefs(state, node) {
  let s = node.lines.join('\n');
  let def;
  while ((def = parseLinkDefinition(s))) {
    const key = normalizeLabel(def.label);
    if (!state.refs.has(key)) state.refs.set(key, { dest: def.dest, title: def.title });
    s = s.slice(def.end);
  }
  node.lines = s === '' ? [] : s.split('\n');
}

function parseLinkDefinition(s) {
  const m = /^\[((?:[^\\[\]]|\\[\s\S])*)\]:/.exec(s);
  if (!m || m[1].trim() === '' || m[1].length > 999) return null;
  const p = skipWsNl(s, m[0].length);
  const dest = parseDest(s, p);
  if (!dest) return null;
  const afterDest = dest.end;
  const w = skipWsNl(s, afterDest);
  if (w > afterDest && (s[w] === '"' || s[w] === "'" || s[w] === '(')) {
    const t = parseTitle(s, w);
    if (t) {
      const e = skipSpaces(s, t.end);
      if (e >= s.length || s[e] === '\n') {
        return { label: m[1], dest: dest.raw, title: t.raw, end: Math.min(s.length, e + 1) };
      }
    }
  }
  const e = skipSpaces(s, afterDest);
  if (e >= s.length || s[e] === '\n') {
    return { label: m[1], dest: dest.raw, title: null, end: Math.min(s.length, e + 1) };
  }
  return null;
}

function parseDest(s, p) {
  if (s[p] === '<') {
    let k = p + 1;
    while (k < s.length && s[k] !== '>' && s[k] !== '\n' && s[k] !== '<') {
      k += s[k] === '\\' ? 2 : 1;
    }
    if (s[k] !== '>') return null;
    return { raw: s.slice(p + 1, k), end: k + 1 };
  }
  let k = p;
  let depth = 0;
  while (k < s.length) {
    const c = s[k];
    if (c === '\\' && k + 1 < s.length && ASCII_PUNCT_RE.test(s[k + 1])) {
      k += 2;
      continue;
    }
    if (c === '(') {
      depth++;
    } else if (c === ')') {
      if (depth === 0) break;
      depth--;
    } else if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 0x20) {
      break;
    }
    k++;
  }
  if (k === p || depth !== 0) return null;
  return { raw: s.slice(p, k), end: k };
}

function parseTitle(s, p) {
  const open = s[p];
  const close = open === '(' ? ')' : open;
  let k = p + 1;
  while (k < s.length) {
    const c = s[k];
    if (c === '\\' && k + 1 < s.length) {
      k += 2;
      continue;
    }
    if (c === close) return { raw: s.slice(p + 1, k), end: k + 1 };
    if (open === '(' && c === '(') return null;
    k++;
  }
  return null;
}

function parseLabel(s, p) {
  let k = p + 1;
  while (k < s.length) {
    const c = s[k];
    if (c === '\\') {
      k += 2;
      continue;
    }
    if (c === '[') return null;
    if (c === ']') {
      return k - p - 1 > 999 ? null : { raw: s.slice(p + 1, k), end: k + 1 };
    }
    k++;
  }
  return null;
}

function parseInlineTail(s, p) {
  const k = skipWsNl(s, p + 1);
  if (s[k] === ')') return { dest: '', title: null, end: k + 1 };
  const d = parseDest(s, k);
  if (!d) return null;
  const w = skipWsNl(s, d.end);
  if (w > d.end && (s[w] === '"' || s[w] === "'" || s[w] === '(')) {
    const t = parseTitle(s, w);
    if (t) {
      const e = skipWsNl(s, t.end);
      if (s[e] === ')') return { dest: d.raw, title: t.raw, end: e + 1 };
    }
  }
  const e = skipWsNl(s, d.end);
  if (s[e] === ')') return { dest: d.raw, title: null, end: e + 1 };
  return null;
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

function matchLinkTail(s, closeIdx, op, refs) {
  const after = closeIdx + 1;
  const mk = (dest, title, end) => ({
    href: linkHref(dest),
    title: title == null ? null : unescapeAndDecode(title),
    end,
  });
  if (s[after] === '(') {
    const t = parseInlineTail(s, after);
    if (t) return mk(t.dest, t.title, t.end);
  }
  if (s[after] === '[') {
    const lab = parseLabel(s, after);
    if (lab) {
      const key = lab.raw.trim() === '' ? s.slice(op.pos, closeIdx) : lab.raw;
      const ref = refs.get(normalizeLabel(key));
      return ref ? mk(ref.dest, ref.title, lab.end) : null;
    }
  }
  const ref = refs.get(normalizeLabel(s.slice(op.pos, closeIdx)));
  return ref ? mk(ref.dest, ref.title, after) : null;
}

// Resolve emphasis/strikethrough delimiters in items[bottom..] (CommonMark
// "process emphasis" algorithm, operating on an array of items).
function processEmphasis(items, bottom) {
  let ci = bottom;
  for (;;) {
    let c = -1;
    for (let k = ci; k < items.length; k++) {
      const it = items[k];
      if (it.t === 'delim' && it.close && !it.dead && it.n > 0) {
        c = k;
        break;
      }
    }
    if (c < 0) return;
    const closer = items[c];
    let j = -1;
    for (let k = c - 1; k >= bottom; k--) {
      const o = items[k];
      if (o.t !== 'delim' || o.dead || !o.open || o.n === 0 || o.ch !== closer.ch) continue;
      if (closer.ch !== '~'
        && ((o.open && o.close) || (closer.open && closer.close))
        && (o.orig + closer.orig) % 3 === 0
        && !(o.orig % 3 === 0 && closer.orig % 3 === 0)) {
        continue;
      }
      j = k;
      break;
    }
    if (j < 0) {
      if (!closer.open) closer.dead = true;
      ci = c + 1;
      continue;
    }
    const opener = items[j];
    const use = Math.min(2, opener.n, closer.n);
    const tag = closer.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em';
    opener.n -= use;
    closer.n -= use;
    for (let k = j + 1; k < c; k++) {
      if (items[k].t === 'delim') items[k].dead = true;
    }
    items.splice(c, 0, html(`</${tag}>`));
    items.splice(j + 1, 0, html(`<${tag}>`));
    ci = j + 1;
  }
}

function parseInline(s, refs) {
  const items = [];
  let buf = '';
  let i = 0;
  const flush = () => {
    if (buf) {
      items.push({ t: 'txt', v: buf });
      buf = '';
    }
  };
  const pushItem = it => {
    flush();
    items.push(it);
  };

  while (i < s.length) {
    const ch = s[i];

    // Backslash escapes and hard breaks.
    if (ch === '\\') {
      const nx = s[i + 1];
      if (nx === '\n') {
        pushItem(html('<br />\n', '\n'));
        i += 2;
        while (s[i] === ' ' || s[i] === '\t') i++;
        continue;
      }
      if (nx !== undefined && ASCII_PUNCT_RE.test(nx)) {
        buf += nx;
        i += 2;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }

    // Code spans.
    if (ch === '`') {
      let n = 1;
      while (s[i + n] === '`') n++;
      let close = -1;
      let k = i + n;
      while (k < s.length) {
        const b = s.indexOf('`', k);
        if (b < 0) break;
        let m = 0;
        while (s[b + m] === '`') m++;
        if (m === n) {
          close = b;
          break;
        }
        k = b + m;
      }
      if (close < 0) {
        buf += '`'.repeat(n);
        i += n;
        continue;
      }
      let content = s.slice(i + n, close).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' '
        && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      pushItem(html(`<code>${esc(content)}</code>`, content));
      i = close + n;
      continue;
    }

    // Autolinks. Anything else starting with '<' is literal text (raw HTML is not passed through).
    if (ch === '<') {
      const rest = s.slice(i);
      let m = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^<>\x00-\x20]*)>/.exec(rest);
      if (m) {
        const uri = m[1];
        pushItem(html(`<a href="${esc(linkHref(uri))}">${esc(uri)}</a>`, uri));
        i += m[0].length;
        continue;
      }
      m = /^<([a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/.exec(rest);
      if (m) {
        pushItem(html(`<a href="mailto:${esc(m[1])}">${esc(m[1])}</a>`, m[1]));
        i += m[0].length;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }

    // Entity and numeric character references.
    if (ch === '&') {
      ENTITY_AT.lastIndex = i;
      const m = ENTITY_AT.exec(s);
      if (m) {
        const d = decodeEntity(m[1]);
        if (d !== null) {
          buf += d;
          i += m[0].length;
          continue;
        }
      }
      buf += ch;
      i++;
      continue;
    }

    // Link and image openers.
    if (ch === '!' && s[i + 1] === '[') {
      pushItem({ t: 'bracket', img: true, active: true, pos: i + 2 });
      i += 2;
      continue;
    }
    if (ch === '[') {
      pushItem({ t: 'bracket', img: false, active: true, pos: i + 1 });
      i++;
      continue;
    }

    // Link and image closers.
    if (ch === ']') {
      let bi = -1;
      for (let k = items.length - 1; k >= 0; k--) {
        if (items[k].t === 'bracket') {
          bi = k;
          break;
        }
      }
      if (bi < 0) {
        buf += ']';
        i++;
        continue;
      }
      flush();
      const op = items[bi];
      if (!op.active) {
        items[bi] = { t: 'txt', v: op.img ? '![' : '[' };
        buf += ']';
        i++;
        continue;
      }
      const res = matchLinkTail(s, i, op, refs);
      if (!res) {
        items[bi] = { t: 'txt', v: op.img ? '![' : '[' };
        buf += ']';
        i++;
        continue;
      }
      processEmphasis(items, bi + 1);
      for (let k = bi + 1; k < items.length; k++) {
        if (items[k].t === 'delim') items[k].dead = true;
      }
      const titleAttr = res.title != null ? ` title="${esc(res.title)}"` : '';
      if (op.img) {
        const alt = plainOf(items.slice(bi + 1));
        items.length = bi;
        items.push(html(`<img src="${esc(res.href)}" alt="${esc(alt)}"${titleAttr} />`, alt));
      } else {
        items[bi] = html(`<a href="${esc(res.href)}"${titleAttr}>`);
        items.push(html('</a>'));
        for (let k = 0; k < bi; k++) {
          if (items[k].t === 'bracket' && !items[k].img) items[k].active = false;
        }
      }
      i = res.end;
      continue;
    }

    // Emphasis, strong and strikethrough delimiter runs.
    if (ch === '*' || ch === '_' || ch === '~') {
      let j = i;
      while (s[j] === ch) j++;
      const n = j - i;
      const before = i > 0 ? s[i - 1] : undefined;
      const after = s[j];
      const lf = !isWS(after) && (!isPunct(after) || isWS(before) || isPunct(before));
      const rf = !isWS(before) && (!isPunct(before) || isWS(after) || isPunct(after));
      let canOpen;
      let canClose;
      if (ch === '_') {
        canOpen = lf && (!rf || isPunct(before));
        canClose = rf && (!lf || isPunct(after));
      } else {
        canOpen = lf;
        canClose = rf;
      }
      pushItem({ t: 'delim', ch, n, orig: n, open: canOpen, close: canClose, dead: false });
      i = j;
      continue;
    }

    // Line endings: soft breaks, or hard breaks after two+ spaces.
    if (ch === '\n') {
      const trailing = buf.match(/ *$/)[0].length;
      buf = buf.replace(/ +$/, '');
      if (trailing >= 2) {
        pushItem(html('<br />\n', '\n'));
      } else {
        buf += '\n';
      }
      i++;
      while (s[i] === ' ' || s[i] === '\t') i++;
      continue;
    }

    buf += ch;
    i++;
  }
  flush();
  processEmphasis(items, 0);
  return items;
}

function plainOf(items) {
  return items.map(it => {
    switch (it.t) {
      case 'txt': return it.v;
      case 'delim': return it.ch.repeat(it.n);
      case 'bracket': return it.img ? '![' : '[';
      default: return it.p ?? '';
    }
  }).join('');
}

function renderItems(items) {
  return items.map(it => {
    switch (it.t) {
      case 'txt': return esc(it.v);
      case 'html': return it.v;
      case 'delim': return esc(it.ch.repeat(it.n));
      case 'bracket': return esc(it.img ? '![' : '[');
      default: return '';
    }
  }).join('');
}

function renderInline(text, refs) {
  return renderItems(parseInline(text, refs));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function paragraphText(n) {
  return n.lines.join('\n').replace(/[ \t\n]+$/, '');
}

function endsWithBlank(node) {
  let n = node;
  while (n) {
    if (n.lastLineBlank) return true;
    if (n.type === 'list' || n.type === 'item') {
      n = n.children[n.children.length - 1];
    } else {
      return false;
    }
  }
  return false;
}

function isLoose(list) {
  const items = list.children;
  for (let i = 0; i < items.length; i++) {
    if (i < items.length - 1 && endsWithBlank(items[i])) return true;
    const kids = items[i].children;
    for (let j = 0; j < kids.length - 1; j++) {
      if (endsWithBlank(kids[j])) return true;
    }
  }
  return false;
}

function renderChildren(node, ctx, tight = false) {
  return node.children.map(ch => renderBlock(ch, ctx, tight)).join('');
}

function renderTable(n, ctx) {
  const cell = (tag, text, i) => {
    const a = n.aligns[i];
    const attr = a ? ` align="${a}"` : '';
    return `<${tag}${attr}>${renderInline(text, ctx.refs)}</${tag}>`;
  };
  let out = `<table>\n<thead>\n<tr>\n${n.header.map((t, i) => cell('th', t, i)).join('\n')}\n</tr>\n</thead>\n`;
  if (n.rows.length) {
    out += '<tbody>\n' + n.rows.map(r => `<tr>\n${n.header.map((_, i) => cell('td', r[i] ?? '', i)).join('\n')}\n</tr>\n`).join('') + '</tbody>\n';
  }
  return out + '</table>\n';
}

function renderBlock(n, ctx, tight) {
  switch (n.type) {
    case 'paragraph': {
      const inl = renderInline(paragraphText(n), ctx.refs);
      return tight ? `${inl}\n` : `<p>${inl}</p>\n`;
    }
    case 'heading': {
      const items = parseInline(n.content, ctx.refs);
      const inl = renderItems(items);
      const idAttr = ctx.headingIds ? ` id="${slugify(plainOf(items), ctx.seen)}"` : '';
      return `<h${n.level}${idAttr}>${inl}</h${n.level}>\n`;
    }
    case 'thematic_break':
      return '<hr />\n';
    case 'code_block': {
      const body = n.lines.map(l => l + '\n').join('');
      let cls = '';
      if (n.fenced && n.info) {
        const word = unescapeAndDecode(n.info).split(/\s+/)[0];
        if (word) cls = ` class="language-${esc(word)}"`;
      }
      return `<pre><code${cls}>${esc(body)}</code></pre>\n`;
    }
    case 'blockquote':
      return `<blockquote>\n${renderChildren(n, ctx, false)}</blockquote>\n`;
    case 'list': {
      const loose = isLoose(n);
      const items = n.children.map(it => `<li>${renderChildren(it, ctx, !loose)}</li>\n`).join('');
      if (n.ordered) {
        const start = n.start !== 1 ? ` start="${n.start}"` : '';
        return `<ol${start}>\n${items}</ol>\n`;
      }
      return `<ul>\n${items}</ul>\n`;
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

function parseBlocks(markdown) {
  const doc = newNode('document');
  const state = { doc, tip: doc, refs: new Map() };
  const text = String(markdown).replace(/\r\n?/g, '\n').replace(/\0/g, '�');
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) incorporate(state, line);
  closeUnmatched(state, doc);
  doc.open = false;
  return { doc, refs: state.refs };
}

export function render(markdown, { headingIds = false } = {}) {
  const { doc, refs } = parseBlocks(markdown);
  return renderChildren(doc, { refs, headingIds, seen: new Map() }, false);
}

export function toc(markdown) {
  const { doc, refs } = parseBlocks(markdown);
  const seen = new Map();
  const out = [];
  const walk = n => {
    if (n.type === 'heading') {
      const text = plainOf(parseInline(n.content, refs));
      out.push({ level: n.level, text, slug: slugify(text, seen) });
    }
    for (const ch of n.children) walk(ch);
  };
  walk(doc);
  return out;
}
