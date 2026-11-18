// Markdown renderer: CommonMark-style block and inline parsing, plus GFM
// pipe tables, ~~strikethrough~~ and wiki links. Original implementation.

// ---------------------------------------------------------------------------
// Character helpers
// ---------------------------------------------------------------------------

const ASCII_PUNCT_CHAR = /^[!-\/:-@\[-`{-~]$/;
const PUNCT_RE = /[!-\/:-@\[-`{-~]|\p{P}|\p{S}/u;
const SPECIAL_INLINE = /[\\`\n*_~\[\]!<&]/;

function isWs(c) {
  return c === undefined || /\s/.test(c);
}

function isPunct(c) {
  return c !== undefined && PUNCT_RE.test(c);
}

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function expandLeadingTabs(line) {
  let col = 0;
  let i = 0;
  let out = '';
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === ' ') {
      out += ' ';
      col++;
    } else {
      const k = 4 - (col % 4);
      out += ' '.repeat(k);
      col += k;
    }
    i++;
  }
  return out + line.slice(i);
}

function skipSpaceNl(s, p) {
  while (s[p] === ' ' || s[p] === '\t') p++;
  if (s[p] === '\n') {
    p++;
    while (s[p] === ' ' || s[p] === '\t') p++;
  }
  return p;
}

// ---------------------------------------------------------------------------
// Entities and escapes
// ---------------------------------------------------------------------------

const ENTITY_TABLE = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®',
  trade: '™', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', times: '×', divide: '÷', euro: '€', pound: '£',
  yen: '¥', cent: '¢', sect: '§', para: '¶', deg: '°', plusmn: '±',
  middot: '·', laquo: '«', raquo: '»', bull: '•', frac12: '½', frac14: '¼',
  frac34: '¾', iexcl: '¡', iquest: '¿', micro: 'µ', shy: '­', larr: '←',
  rarr: '→', uarr: '↑', darr: '↓', hearts: '♥',
};

const ENTITY_AT = /&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/y;

function decodeEntityAt(s, i) {
  ENTITY_AT.lastIndex = i;
  const m = ENTITY_AT.exec(s);
  if (!m) return null;
  const body = m[1];
  let value;
  if (body[0] === '#') {
    const cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    value = cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? '�' : String.fromCodePoint(cp);
  } else {
    if (!Object.hasOwn(ENTITY_TABLE, body)) return null;
    value = ENTITY_TABLE[body];
  }
  return { value, end: i + m[0].length };
}

const UNESCAPE_RE = /\\([!-\/:-@\[-`{-~])|&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g;

function unescapeString(s) {
  return s.replace(UNESCAPE_RE, (m, escChar) => {
    if (escChar !== undefined) return escChar;
    const d = decodeEntityAt(m, 0);
    return d ? d.value : m;
  });
}

function encodeUrl(url) {
  let out = '';
  for (let i = 0; i < url.length; i++) {
    const ch = url[i];
    if (ch === '%' && /^[0-9A-Fa-f]{2}$/.test(url.slice(i + 1, i + 3))) {
      out += ch;
      continue;
    }
    if (/[A-Za-z0-9\-._~!*'();:@&=+$,\/?#\[\]]/.test(ch)) {
      out += ch;
      continue;
    }
    const cp = url.codePointAt(i);
    const s = String.fromCodePoint(cp);
    if (cp > 0xffff) i++;
    for (const b of Buffer.from(s, 'utf8')) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

const attr = (url) => esc(encodeUrl(url));

// Blocks javascript:, vbscript:, file: and non-image data: URLs.
function safeUrl(url) {
  const s = url.replace(/[\u0000- \u007f]/g, '');
  const m = /^([a-z][a-z0-9+.\-]*):/i.exec(s);
  if (!m) return url;
  const scheme = m[1].toLowerCase();
  if (scheme === 'javascript' || scheme === 'vbscript' || scheme === 'file') return '#';
  if (scheme === 'data' && !/^data:image\/(png|gif|jpeg|webp);/i.test(s)) return '#';
  return url;
}

// ---------------------------------------------------------------------------
// Slugs
// ---------------------------------------------------------------------------

export function slugify(text, seen) {
  const base = String(text).toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
  if (!seen) return base;
  if (!seen.has(base)) {
    seen.set(base, 0);
    return base;
  }
  let n = seen.get(base) + 1;
  while (seen.has(`${base}-${n}`)) n++;
  seen.set(base, n);
  const id = `${base}-${n}`;
  seen.set(id, 0);
  return id;
}

// ---------------------------------------------------------------------------
// Block parser
// ---------------------------------------------------------------------------

function makeNode(type, props) {
  return Object.assign(
    { type, children: [], parent: null, open: true, lastLineBlank: false, startLine: 0 },
    props,
  );
}

const lastChild = (n) => n.children[n.children.length - 1];

function acceptsLines(t) {
  return t === 'paragraph' || t === 'table' || t === 'code_block' || t === 'html_block';
}

function canContain(parentType, childType) {
  if (parentType === 'document' || parentType === 'blockquote' || parentType === 'item') {
    return childType !== 'item';
  }
  if (parentType === 'list') return childType === 'item';
  return false;
}

const HTML_BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|' +
  'fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|' +
  'link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|' +
  'thead|title|tr|track|ul';

const HTML_BLOCK_KINDS = [
  { re: /^<(?:script|pre|style|textarea)(?:\s|>|$)/i, end: /<\/(?:script|pre|style|textarea)>/i, interrupts: true },
  { re: /^<!--/, end: /-->/, interrupts: true },
  { re: /^<\?/, end: /\?>/, interrupts: true },
  { re: /^<![A-Za-z]/, end: />/, interrupts: true },
  { re: /^<!\[CDATA\[/, end: /\]\]>/, interrupts: true },
  { re: new RegExp(`^</?(?:${HTML_BLOCK_TAGS})(?:\\s|/?>|$)`, 'i'), end: null, interrupts: true },
  {
    re: /^(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>)\s*$/,
    end: null,
    interrupts: false,
  },
];

const LIST_MARK_RE = /^([*+-]|(\d{1,9})([.)]))(?=[ \t]|$)/;
const HR_RE = /^(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;

function findNext(S) {
  let i = S.offset;
  while (S.ln[i] === ' ' || S.ln[i] === '\t') i++;
  S.nextNS = i;
  S.indent = i - S.offset;
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
      cur += '\\|';
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

function parseDelimRow(s) {
  if (!s.includes('|')) return null;
  const cells = splitRow(s);
  if (!cells.every((c) => /^:?-+:?$/.test(c))) return null;
  return cells.map((c) => {
    const l = c.startsWith(':');
    const r = c.endsWith(':');
    if (l && r) return 'center';
    if (r) return 'right';
    if (l) return 'left';
    return null;
  });
}

function normalizeLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

// Parses a link reference definition at the start of `s`.
function parseRefDef(s) {
  const n = s.length;
  if (s[0] !== '[') return null;
  let j = 1;
  while (j < n && s[j] !== ']') {
    if (s[j] === '\\') j += 2;
    else if (s[j] === '[') return null;
    else j++;
  }
  if (j >= n) return null;
  const label = s.slice(1, j);
  if (label.trim() === '' || label.length > 999) return null;
  if (s[j + 1] !== ':') return null;
  let p = skipSpaceNl(s, j + 2);
  let dest;
  if (s[p] === '<') {
    let k = p + 1;
    while (k < n && s[k] !== '>' && s[k] !== '\n' && s[k] !== '<') k += s[k] === '\\' ? 2 : 1;
    if (s[k] !== '>') return null;
    dest = s.slice(p + 1, k);
    p = k + 1;
  } else {
    let k = p;
    while (k < n && !/\s/.test(s[k]) && s.charCodeAt(k) >= 0x20) k += s[k] === '\\' ? 2 : 1;
    if (k === p) return null;
    dest = s.slice(p, k);
    p = k;
  }
  const destEnd = p;
  const q = skipSpaceNl(s, p);
  let title = null;
  let end = -1;
  if (q > destEnd && (s[q] === '"' || s[q] === "'" || s[q] === '(')) {
    const close = s[q] === '(' ? ')' : s[q];
    let k = q + 1;
    while (k < n && s[k] !== close) k += s[k] === '\\' ? 2 : 1;
    if (k < n) {
      let r = k + 1;
      while (r < n && (s[r] === ' ' || s[r] === '\t')) r++;
      if (r >= n || s[r] === '\n') {
        title = s.slice(q + 1, k);
        end = r;
      }
    }
  }
  if (end < 0) {
    let r = destEnd;
    while (r < n && (s[r] === ' ' || s[r] === '\t')) r++;
    if (r < n && s[r] !== '\n') return null;
    end = r;
  }
  return {
    label,
    dest: unescapeString(dest),
    title: title === null ? null : unescapeString(title),
    end,
  };
}

// Strips leading link reference definitions, registering them; returns the rest.
function extractRefs(P, lines) {
  let text = lines.join('\n').replace(/^[ \t]+/, '');
  while (text[0] === '[') {
    const def = parseRefDef(text);
    if (!def) break;
    const key = normalizeLabel(def.label);
    if (!P.refs.has(key)) P.refs.set(key, { dest: def.dest, title: def.title });
    text = text.slice(def.end).replace(/^\n+/, '').replace(/^[ \t]+/, '');
  }
  return text
    .split('\n')
    .map((l) => l.replace(/^[ \t]+/, ''))
    .join('\n')
    .replace(/\s+$/, '');
}

function endsWithBlankLine(block) {
  let b = block;
  while (b) {
    if (b.lastLineBlank) return true;
    if (b.type === 'list' || b.type === 'item') b = lastChild(b);
    else break;
  }
  return false;
}

function computeTight(list) {
  let tight = true;
  const items = list.children;
  items.forEach((item, i) => {
    if (endsWithBlankLine(item) && i < items.length - 1) tight = false;
    item.children.forEach((sub, j) => {
      if (endsWithBlankLine(sub) && (i < items.length - 1 || j < item.children.length - 1)) tight = false;
    });
  });
  return tight;
}

function detach(block) {
  const parent = block.parent;
  parent.children = parent.children.filter((c) => c !== block);
}

function finalize(P, b) {
  b.open = false;
  if (P.tip === b) P.tip = b.parent;
  if (b.type === 'paragraph') {
    const text = extractRefs(P, b.lines);
    if (text === '') detach(b);
    else b.raw = text;
  } else if (b.type === 'code_block' && !b.fenced) {
    while (b.lines.length && /^[ \t]*$/.test(b.lines[b.lines.length - 1])) b.lines.pop();
  } else if (b.type === 'list') {
    b.tight = computeTight(b);
  }
}

function addChild(P, type, props) {
  while (!canContain(P.tip.type, type)) finalize(P, P.tip);
  const node = makeNode(type, { ...props, parent: P.tip, startLine: P.lineNo });
  P.tip.children.push(node);
  P.tip = node;
  return node;
}

function closeUnmatched(P) {
  if (!P.allClosed) {
    while (P.tip !== P.lastMatched) finalize(P, P.tip);
    P.allClosed = true;
  }
}

// Continuation check for an open block. 0 = matched, 1 = not matched, 2 = line consumed.
function continueBlock(P, b, S) {
  const blankRest = S.nextNS >= S.ln.length;
  switch (b.type) {
    case 'blockquote': {
      if (S.indent < 4 && S.ln[S.nextNS] === '>') {
        S.offset = S.nextNS + 1;
        if (S.ln[S.offset] === ' ' || S.ln[S.offset] === '\t') S.offset++;
        return 0;
      }
      return 1;
    }
    case 'item': {
      if (blankRest) {
        if (b.children.length === 0) return 1;
        S.offset = S.nextNS;
        return 0;
      }
      if (S.indent >= b.reqIndent) {
        S.offset += b.reqIndent;
        return 0;
      }
      return 1;
    }
    case 'list':
      return 0;
    case 'paragraph':
    case 'table':
      return blankRest ? 1 : 0;
    case 'code_block': {
      if (b.fenced) {
        if (S.indent < 4) {
          const m = /^(`{3,}|~{3,})[ \t]*$/.exec(S.ln.slice(S.nextNS));
          if (m && m[1][0] === b.fenceChar && m[1].length >= b.fenceLen) {
            finalize(P, b);
            S.offset = S.ln.length;
            return 2;
          }
        }
        let i = S.offset;
        let k = 0;
        while (k < b.fenceIndent && S.ln[i] === ' ') {
          i++;
          k++;
        }
        S.offset = i;
        return 0;
      }
      if (S.indent >= 4) {
        S.offset += 4;
        return 0;
      }
      if (blankRest) {
        S.offset = S.nextNS;
        return 0;
      }
      return 1;
    }
    case 'html_block':
      return blankRest && b.htmlEnd === null ? 1 : 0;
    default:
      return 1;
  }
}

// Block starts. Return 0 (no match), 1 (container opened, keep scanning),
// 2 (leaf complete, line consumed) or 3 (leaf opened, rest of line is content).

function startBlockquote(P, S) {
  if (S.indent >= 4 || S.ln[S.nextNS] !== '>') return 0;
  S.offset = S.nextNS + 1;
  if (S.ln[S.offset] === ' ' || S.ln[S.offset] === '\t') S.offset++;
  closeUnmatched(P);
  addChild(P, 'blockquote', {});
  return 1;
}

function startATX(P, S) {
  if (S.indent >= 4) return 0;
  const rest = S.ln.slice(S.nextNS);
  const m = /^(#{1,6})(?:[ \t]+|$)/.exec(rest);
  if (!m) return 0;
  let text = rest.slice(m[0].length).replace(/[ \t]+$/, '');
  text = text.replace(/(^|[ \t]+)#+$/, '').trim();
  closeUnmatched(P);
  const h = addChild(P, 'heading', { level: m[1].length, raw: text });
  finalize(P, h);
  S.offset = S.ln.length;
  return 2;
}

function startFence(P, S) {
  if (S.indent >= 4) return 0;
  const m = /^(`{3,}|~{3,})(.*)$/.exec(S.ln.slice(S.nextNS));
  if (!m || (m[1][0] === '`' && m[2].includes('`'))) return 0;
  closeUnmatched(P);
  addChild(P, 'code_block', {
    fenced: true,
    fenceChar: m[1][0],
    fenceLen: m[1].length,
    fenceIndent: S.indent,
    info: m[2].trim(),
    lines: [],
  });
  S.offset = S.ln.length;
  return 2;
}

function startHtml(P, S, container) {
  if (S.indent >= 4) return 0;
  const rest = S.ln.slice(S.nextNS);
  if (rest[0] !== '<') return 0;
  for (const kind of HTML_BLOCK_KINDS) {
    if (!kind.interrupts && container.type === 'paragraph') continue;
    if (kind.re.test(rest)) {
      closeUnmatched(P);
      addChild(P, 'html_block', { htmlEnd: kind.end, lines: [] });
      return 3;
    }
  }
  return 0;
}

function startSetext(P, S, container) {
  if (container.type !== 'paragraph' || S.indent >= 4) return 0;
  const rest = S.ln.slice(S.nextNS).replace(/[ \t]+$/, '');
  const m = /^(=+|-+)$/.exec(rest);
  if (!m) return 0;
  const text = extractRefs(P, container.lines);
  if (text === '') return 0;
  container.type = 'heading';
  container.level = m[1][0] === '=' ? 1 : 2;
  container.raw = text;
  delete container.lines;
  finalize(P, container);
  S.offset = S.ln.length;
  return 2;
}

function startHR(P, S) {
  if (S.indent >= 4 || !HR_RE.test(S.ln.slice(S.nextNS))) return 0;
  closeUnmatched(P);
  const hr = addChild(P, 'thematic_break', {});
  finalize(P, hr);
  S.offset = S.ln.length;
  return 2;
}

function startListItem(P, S, container) {
  if (S.indent >= 4) return 0;
  const m = LIST_MARK_RE.exec(S.ln.slice(S.nextNS));
  if (!m) return 0;
  const bullet = !m[2];
  const markerWidth = m[1].length;
  const afterMarker = S.nextNS + markerWidth;
  let j = afterMarker;
  while (S.ln[j] === ' ' || S.ln[j] === '\t') j++;
  const spaces = j - afterMarker;
  const blankAfter = j >= S.ln.length;
  if (container.type === 'paragraph') {
    if (blankAfter) return 0;
    if (!bullet && Number(m[2]) !== 1) return 0;
  }
  let contentOffset;
  let padding;
  if (blankAfter) {
    padding = markerWidth + 1;
    contentOffset = S.ln.length;
  } else if (spaces >= 5) {
    padding = markerWidth + 1;
    contentOffset = afterMarker + 1;
  } else {
    padding = markerWidth + spaces;
    contentOffset = j;
  }
  const reqIndent = S.indent + padding;
  const data = bullet
    ? { ordered: false, bulletChar: m[1], delim: null }
    : { ordered: true, bulletChar: null, delim: m[3] };
  closeUnmatched(P);
  const matches =
    container.type === 'list' &&
    container.ordered === data.ordered &&
    container.bulletChar === data.bulletChar &&
    container.delim === data.delim;
  if (!matches) {
    addChild(P, 'list', { ...data, start: bullet ? 1 : Number(m[2]), tight: true });
  }
  addChild(P, 'item', { reqIndent });
  S.offset = contentOffset;
  return 1;
}

function startIndentedCode(P, S) {
  if (S.indent < 4) return 0;
  if (P.tip.type === 'paragraph' || P.tip.type === 'table') return 0;
  if (S.nextNS >= S.ln.length) return 0;
  closeUnmatched(P);
  addChild(P, 'code_block', { fenced: false, lines: [] });
  S.offset += 4;
  return 3;
}

const BLOCK_STARTS = [
  startBlockquote,
  startATX,
  startFence,
  startHtml,
  startSetext,
  startHR,
  startListItem,
  startIndentedCode,
];

function incorporate(P, raw) {
  P.lineNo++;
  const ln = expandLeadingTabs(raw);
  const S = { ln, offset: 0, nextNS: 0, indent: 0 };
  const oldTip = P.tip;
  let container = P.doc;

  while (true) {
    const last = lastChild(container);
    if (!last || !last.open) break;
    container = last;
    findNext(S);
    const r = continueBlock(P, container, S);
    if (r === 0) continue;
    if (r === 2) return;
    container = container.parent;
    break;
  }
  P.allClosed = container === oldTip;
  P.lastMatched = container;

  const matchedLeaf =
    container.type !== 'paragraph' && container.type !== 'table' && acceptsLines(container.type);
  let startRes = 0;
  if (!matchedLeaf) {
    while (true) {
      findNext(S);
      let res = 0;
      for (const start of BLOCK_STARTS) {
        res = start(P, S, container);
        if (res) break;
      }
      if (!res) {
        S.offset = S.nextNS;
        break;
      }
      container = P.tip;
      if (res === 1) continue;
      startRes = res;
      break;
    }
  }

  const rest = ln.slice(S.offset);
  const blank = /^[ \t]*$/.test(rest);

  if (!P.allClosed && !blank && P.tip.type === 'paragraph' && startRes === 0) {
    P.tip.lines.push(rest.replace(/^[ \t]+/, ''));
    return;
  }

  closeUnmatched(P);
  if (blank && lastChild(container)) lastChild(container).lastLineBlank = true;
  const t = container.type;
  const lastLineBlank =
    blank &&
    !(
      t === 'blockquote' ||
      (t === 'code_block' && container.fenced) ||
      (t === 'item' && container.children.length === 0 && container.startLine === P.lineNo)
    );
  for (let c = container; c; c = c.parent) c.lastLineBlank = lastLineBlank;

  if (startRes === 2) return;

  if (t === 'paragraph') {
    if (container.lines.length === 1 && !blank) {
      const align = parseDelimRow(rest.trim());
      const header = container.lines[0];
      if (align && splitRow(header).length === align.length) {
        container.type = 'table';
        container.header = splitRow(header);
        container.align = align;
        container.rows = [];
        delete container.lines;
        return;
      }
    }
    container.lines.push(rest.replace(/^[ \t]+/, ''));
    return;
  }
  if (t === 'table') {
    container.rows.push(rest);
    return;
  }
  if (t === 'code_block' || t === 'html_block') {
    container.lines.push(rest);
    if (t === 'html_block' && container.htmlEnd && container.htmlEnd.test(rest)) finalize(P, container);
    return;
  }
  if (!blank) {
    addChild(P, 'paragraph', { lines: [] });
    P.tip.lines.push(rest.replace(/^[ \t]+/, ''));
  }
}

function parseBlocks(text) {
  const doc = makeNode('document', {});
  const P = { doc, tip: doc, lastMatched: doc, allClosed: true, refs: new Map(), lineNo: 0 };
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const l of lines) incorporate(P, l);
  while (P.tip !== doc) finalize(P, P.tip);
  return { doc, refs: P.refs };
}

// ---------------------------------------------------------------------------
// Inline parser
// ---------------------------------------------------------------------------

// Parses the inline tail after "(" of an inline link: destination and title.
function parseLinkTail(src, p) {
  const n = src.length;
  p = skipSpaceNl(src, p);
  let dest;
  if (src[p] === '<') {
    let j = p + 1;
    while (j < n && src[j] !== '>' && src[j] !== '\n' && src[j] !== '<') j += src[j] === '\\' ? 2 : 1;
    if (src[j] !== '>') return null;
    dest = src.slice(p + 1, j);
    p = j + 1;
  } else {
    let j = p;
    let depth = 0;
    while (j < n) {
      const ch = src[j];
      if (ch === '\\' && j + 1 < n && ASCII_PUNCT_CHAR.test(src[j + 1])) {
        j += 2;
        continue;
      }
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch.charCodeAt(0) < 0x20) break;
      if (ch === '(') depth++;
      else if (ch === ')') {
        if (depth === 0) break;
        depth--;
      }
      j++;
    }
    if (depth !== 0) return null;
    dest = src.slice(p, j);
    p = j;
  }
  let title = null;
  const beforeTitle = p;
  p = skipSpaceNl(src, p);
  if (p > beforeTitle && (src[p] === '"' || src[p] === "'" || src[p] === '(')) {
    const open = src[p];
    const close = open === '(' ? ')' : open;
    let j = p + 1;
    while (j < n && src[j] !== close) j += src[j] === '\\' ? 2 : 1;
    if (j >= n) return null;
    title = src.slice(p + 1, j);
    p = skipSpaceNl(src, j + 1);
  }
  if (src[p] !== ')') return null;
  return {
    dest: unescapeString(dest),
    title: title === null ? null : unescapeString(title),
    end: p + 1,
  };
}

// [[Target]] or [[Target|Label]]
function scanWiki(src, pos) {
  const close = src.indexOf(']]', pos + 2);
  if (close < 0) return null;
  const inner = src.slice(pos + 2, close);
  if (/[\n\[\]`]/.test(inner)) return null;
  const bar = inner.indexOf('|');
  const target = bar >= 0 ? inner.slice(0, bar) : inner;
  if (target.trim() === '') return null;
  const label = bar >= 0 ? inner.slice(bar + 1) || target : inner;
  return { target, label, end: close + 2 };
}

function parseInlines(src, ctx) {
  const nodes = [];
  const delims = [];
  const brackets = [];
  const n = src.length;
  let pos = 0;

  const pushText = (s) => {
    const last = nodes[nodes.length - 1];
    if (last && last.type === 'text' && !last.keep) last.value += s;
    else nodes.push({ type: 'text', value: s });
  };

  function processEmphasis(bottom) {
    let ci = bottom;
    while (ci < delims.length) {
      const closer = delims[ci];
      if (!closer.canClose) {
        ci++;
        continue;
      }
      let oi = ci - 1;
      let opener = null;
      while (oi >= bottom) {
        const d = delims[oi];
        if (d.char === closer.char && d.canOpen) {
          if (closer.char === '~') {
            if (d.count >= 2 && closer.count >= 2) {
              opener = d;
              break;
            }
          } else {
            const oddMatch =
              (d.canClose || closer.canOpen) &&
              (d.origCount + closer.origCount) % 3 === 0 &&
              !(d.origCount % 3 === 0 && closer.origCount % 3 === 0);
            if (!oddMatch) {
              opener = d;
              break;
            }
          }
        }
        oi--;
      }
      if (!opener) {
        if (!closer.canOpen) delims.splice(ci, 1);
        else ci++;
        continue;
      }
      const use = closer.char === '~' ? 2 : opener.count >= 2 && closer.count >= 2 ? 2 : 1;
      const oIdx = nodes.indexOf(opener.node);
      const cIdx = nodes.indexOf(closer.node);
      const children = nodes.slice(oIdx + 1, cIdx);
      const type = closer.char === '~' ? 'del' : use === 2 ? 'strong' : 'em';
      nodes.splice(oIdx + 1, cIdx - oIdx - 1, { type, children });
      opener.count -= use;
      closer.count -= use;
      opener.node.value = opener.char.repeat(opener.count);
      closer.node.value = closer.char.repeat(closer.count);
      delims.splice(oi + 1, ci - oi - 1);
      let next = oi + 1;
      if (closer.count === 0) {
        nodes.splice(nodes.indexOf(closer.node), 1);
        delims.splice(oi + 1, 1);
      }
      if (opener.count === 0) {
        nodes.splice(nodes.indexOf(opener.node), 1);
        delims.splice(oi, 1);
        next--;
      }
      ci = next;
    }
    delims.length = Math.min(delims.length, bottom);
  }

  while (pos < n) {
    const c = src[pos];

    if (c === '\\') {
      const nx = src[pos + 1];
      if (nx === '\n') {
        nodes.push({ type: 'hardbreak' });
        pos += 2;
        continue;
      }
      if (nx !== undefined && ASCII_PUNCT_CHAR.test(nx)) {
        pushText(nx);
        pos += 2;
        continue;
      }
      pushText('\\');
      pos++;
      continue;
    }

    if (c === '`') {
      let j = pos;
      while (src[j] === '`') j++;
      const len = j - pos;
      let k = j;
      let close = -1;
      while (k < n) {
        if (src[k] === '`') {
          let e = k;
          while (src[e] === '`') e++;
          if (e - k === len) {
            close = k;
            break;
          }
          k = e;
        } else {
          k++;
        }
      }
      if (close < 0) {
        pushText('`'.repeat(len));
        pos = j;
        continue;
      }
      let content = src.slice(j, close).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      nodes.push({ type: 'code', value: content });
      pos = close + len;
      continue;
    }

    if (c === '\n') {
      const last = nodes[nodes.length - 1];
      let hard = false;
      if (last && last.type === 'text') {
        const sp = /[ \t]*$/.exec(last.value)[0];
        if (sp.length) {
          hard = sp.length >= 2;
          last.value = last.value.slice(0, -sp.length);
        }
      }
      nodes.push({ type: hard ? 'hardbreak' : 'softbreak' });
      pos++;
      while (src[pos] === ' ' || src[pos] === '\t') pos++;
      continue;
    }

    if (c === '*' || c === '_' || c === '~') {
      const start = pos;
      while (src[pos] === c) pos++;
      const len = pos - start;
      const before = start === 0 ? '\n' : src[start - 1];
      const after = pos >= n ? '\n' : src[pos];
      const lf = !isWs(after) && (!isPunct(after) || isWs(before) || isPunct(before));
      const rf = !isWs(before) && (!isPunct(before) || isWs(after) || isPunct(after));
      let canOpen;
      let canClose;
      if (c === '_') {
        canOpen = lf && (!rf || isPunct(before));
        canClose = rf && (!lf || isPunct(after));
      } else {
        canOpen = lf;
        canClose = rf;
      }
      const node = { type: 'text', value: c.repeat(len), keep: true };
      nodes.push(node);
      delims.push({ node, char: c, count: len, origCount: len, canOpen, canClose });
      continue;
    }

    if (c === '!' && src[pos + 1] === '[') {
      const node = { type: 'text', value: '![', keep: true };
      nodes.push(node);
      brackets.push({ node, image: true, active: true, pos: pos + 1, delimIdx: delims.length });
      pos += 2;
      continue;
    }

    if (c === '[') {
      if (ctx.wikiLinks && src[pos + 1] === '[') {
        const w = scanWiki(src, pos);
        if (w) {
          const slug = slugify(w.target);
          if (ctx.collect) ctx.collect.push(slug);
          nodes.push({ type: 'wikilink', target: w.target, label: w.label, slug });
          pos = w.end;
          continue;
        }
      }
      const node = { type: 'text', value: '[', keep: true };
      nodes.push(node);
      brackets.push({ node, image: false, active: true, pos, delimIdx: delims.length });
      pos++;
      continue;
    }

    if (c === ']') {
      pos++;
      const opener = brackets[brackets.length - 1];
      if (!opener) {
        pushText(']');
        continue;
      }
      if (!opener.active) {
        brackets.pop();
        pushText(']');
        continue;
      }
      const closePos = pos - 1;
      let dest = null;
      let title = null;
      let end = -1;
      if (src[pos] === '(') {
        const r = parseLinkTail(src, pos + 1);
        if (r) {
          dest = r.dest;
          title = r.title;
          end = r.end;
        }
      }
      if (end < 0) {
        let label = null;
        let after = pos;
        if (src[pos] === '[') {
          const cl = src.indexOf(']', pos + 1);
          if (cl >= 0) {
            const inner = src.slice(pos + 1, cl);
            if (!inner.includes('[')) {
              label = inner.trim() === '' ? src.slice(opener.pos + 1, closePos) : inner;
              after = cl + 1;
            }
          }
        }
        if (label === null) {
          label = src.slice(opener.pos + 1, closePos);
          after = pos;
        }
        const def = ctx.refs.get(normalizeLabel(label));
        if (def) {
          dest = def.dest;
          title = def.title;
          end = after;
        }
      }
      if (end < 0) {
        brackets.pop();
        pushText(']');
        continue;
      }
      processEmphasis(opener.delimIdx);
      const idx = nodes.indexOf(opener.node);
      const children = nodes.slice(idx + 1);
      nodes.length = idx;
      nodes.push({ type: opener.image ? 'image' : 'link', dest, title, children });
      brackets.pop();
      if (!opener.image) {
        for (const b of brackets) if (!b.image) b.active = false;
      }
      pos = end;
      continue;
    }

    if (c === '<') {
      const AUTO_URI = /<([A-Za-z][A-Za-z0-9+.\-]{1,31}:[^<>\x00-\x20]*)>/y;
      const AUTO_EMAIL =
        /<([a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/y;
      AUTO_URI.lastIndex = pos;
      let m = AUTO_URI.exec(src);
      if (m) {
        nodes.push({ type: 'link', dest: m[1], title: null, children: [{ type: 'text', value: m[1] }] });
        pos = AUTO_URI.lastIndex;
        continue;
      }
      AUTO_EMAIL.lastIndex = pos;
      m = AUTO_EMAIL.exec(src);
      if (m) {
        nodes.push({ type: 'link', dest: 'mailto:' + m[1], title: null, children: [{ type: 'text', value: m[1] }] });
        pos = AUTO_EMAIL.lastIndex;
        continue;
      }
      pushText('<');
      pos++;
      continue;
    }

    if (c === '&') {
      const d = decodeEntityAt(src, pos);
      if (d) {
        pushText(d.value);
        pos = d.end;
      } else {
        pushText('&');
        pos++;
      }
      continue;
    }

    let j = pos + 1;
    while (j < n && !SPECIAL_INLINE.test(src[j])) j++;
    pushText(src.slice(pos, j));
    pos = j;
  }

  processEmphasis(0);
  return cleanupInlines(nodes);
}

function cleanupInlines(list) {
  const out = [];
  for (const nd of list) {
    if (nd.type === 'text') {
      if (nd.value === '') continue;
      const last = out[out.length - 1];
      if (last && last.type === 'text') last.value += nd.value;
      else out.push({ type: 'text', value: nd.value });
      continue;
    }
    if (nd.children) nd.children = cleanupInlines(nd.children);
    out.push(nd);
  }
  return out;
}

function plainText(nodes) {
  let s = '';
  for (const nd of nodes) {
    switch (nd.type) {
      case 'text':
      case 'code':
        s += nd.value;
        break;
      case 'softbreak':
      case 'hardbreak':
        s += ' ';
        break;
      case 'wikilink':
        s += nd.label;
        break;
      default:
        if (nd.children) s += plainText(nd.children);
    }
  }
  return s;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function inlinesOf(node, ctx) {
  if (!node.inl) node.inl = parseInlines(node.raw, ctx);
  return node.inl;
}

function renderInlines(nodes, ctx) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.type) {
      case 'text':
        out += esc(nd.value);
        break;
      case 'code':
        out += `<code>${esc(nd.value)}</code>`;
        break;
      case 'softbreak':
        out += '\n';
        break;
      case 'hardbreak':
        out += '<br />\n';
        break;
      case 'em':
        out += `<em>${renderInlines(nd.children, ctx)}</em>`;
        break;
      case 'strong':
        out += `<strong>${renderInlines(nd.children, ctx)}</strong>`;
        break;
      case 'del':
        out += `<del>${renderInlines(nd.children, ctx)}</del>`;
        break;
      case 'link': {
        const title = nd.title !== null ? ` title="${esc(nd.title)}"` : '';
        out += `<a href="${attr(safeUrl(nd.dest))}"${title}>${renderInlines(nd.children, ctx)}</a>`;
        break;
      }
      case 'image': {
        const title = nd.title !== null ? ` title="${esc(nd.title)}"` : '';
        out += `<img src="${attr(safeUrl(nd.dest))}" alt="${esc(plainText(nd.children))}"${title} />`;
        break;
      }
      case 'wikilink': {
        const exists = ctx.wikiLinks ? !!ctx.wikiLinks.exists(nd.slug) : true;
        out += `<a href="/wiki/${esc(nd.slug)}" class="wikilink${exists ? '' : ' missing'}">${esc(nd.label)}</a>`;
        break;
      }
      default:
        if (nd.children) out += renderInlines(nd.children, ctx);
    }
  }
  return out;
}

function renderBlock(node, ctx, tight) {
  switch (node.type) {
    case 'document':
      return node.children.map((c) => renderBlock(c, ctx, false)).join('');
    case 'blockquote':
      return `<blockquote>\n${node.children.map((c) => renderBlock(c, ctx, false)).join('')}</blockquote>\n`;
    case 'paragraph': {
      const inner = renderInlines(inlinesOf(node, ctx), ctx);
      return tight ? `${inner}\n` : `<p>${inner}</p>\n`;
    }
    case 'heading': {
      const id = ctx.headingIds ? ` id="${esc(node.slug)}"` : '';
      return `<h${node.level}${id}>${renderInlines(inlinesOf(node, ctx), ctx)}</h${node.level}>\n`;
    }
    case 'thematic_break':
      return '<hr />\n';
    case 'code_block': {
      const lang = node.fenced ? unescapeString((node.info || '').split(/\s+/)[0]) : '';
      const cls = lang ? ` class="language-${esc(lang)}"` : '';
      const text = node.lines.map((l) => l + '\n').join('');
      return `<pre><code${cls}>${esc(text)}</code></pre>\n`;
    }
    case 'html_block':
      return `<p>${esc(node.lines.join('\n'))}</p>\n`;
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      const startAttr = node.ordered && node.start !== 1 ? ` start="${node.start}"` : '';
      const items = node.children
        .map((item) => `<li>${item.children.map((c) => renderBlock(c, ctx, node.tight)).join('')}</li>\n`)
        .join('');
      return `<${tag}${startAttr}>\n${items}</${tag}>\n`;
    }
    case 'table': {
      const al = (i) => (node.align[i] ? ` align="${node.align[i]}"` : '');
      let out = '<table>\n<thead>\n<tr>\n';
      node.header.forEach((h, i) => {
        out += `<th${al(i)}>${renderInlines(parseInlines(h, ctx), ctx)}</th>\n`;
      });
      out += '</tr>\n</thead>\n';
      if (node.rows.length) {
        out += '<tbody>\n';
        for (const row of node.rows) {
          const cells = splitRow(row);
          out += '<tr>\n';
          node.header.forEach((_, i) => {
            out += `<td${al(i)}>${renderInlines(parseInlines(cells[i] ?? '', ctx), ctx)}</td>\n`;
          });
          out += '</tr>\n';
        }
        out += '</tbody>\n';
      }
      return out + '</table>\n';
    }
    default:
      return '';
  }
}

// Builds the AST and assigns heading slugs in document order.
function buildDocument(markdown, wikiLinks, collect) {
  const text = String(markdown ?? '').replace(/\r\n?/g, '\n').replace(/\0/g, '�');
  const { doc, refs } = parseBlocks(text);
  const ctx = { refs, wikiLinks: wikiLinks || null, collect: collect || null, headingIds: false };
  return { doc, ctx };
}

function collectHeadings(node, ctx, seen, out) {
  if (node.type === 'heading') {
    node.text = plainText(inlinesOf(node, ctx));
    node.slug = slugify(node.text, seen);
    out.push(node);
  }
  for (const c of node.children) collectHeadings(c, ctx, seen, out);
  return out;
}

function renderInternal(markdown, opts, collect) {
  const { doc, ctx } = buildDocument(markdown, opts.wikiLinks, collect);
  ctx.headingIds = !!opts.headingIds;
  collectHeadings(doc, ctx, new Map(), []);
  return renderBlock(doc, ctx, false);
}

export function render(markdown, { headingIds = false, wikiLinks } = {}) {
  return renderInternal(markdown, { headingIds, wikiLinks }, null);
}

export function toc(markdown) {
  const { doc, ctx } = buildDocument(markdown, { exists: () => true }, null);
  return collectHeadings(doc, ctx, new Map(), []).map((h) => ({ level: h.level, text: h.text, slug: h.slug }));
}

// Distinct slugs of all wiki-link targets in a body (sorted).
export function wikiLinkSlugs(markdown) {
  const collect = [];
  renderInternal(markdown, { wikiLinks: { exists: () => true } }, collect);
  return [...new Set(collect)].sort();
}
