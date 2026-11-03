// Minimal CommonMark-subset Markdown -> HTML renderer.
// Written from scratch following the CommonMark 0.31 spec algorithms.

const ESC_RE = /[&<>"]/g;
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
export function escapeHtml(s) {
  return s.replace(ESC_RE, (c) => ESC_MAP[c]);
}

const PUNCT = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/;
const ASCII_PUNCT_CLASS = '[!"#$%&\'()*+,\\-./:;<=>?@[\\\\\\]^_`{|}~]';

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©',
  reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«',
  raquo: '»', middot: '·', deg: '°', times: '×', divide: '÷',
  euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§',
  para: '¶', bull: '•', larr: '←', rarr: '→', uarr: '↑',
  darr: '↓', harr: '↔', frac12: '½', frac14: '¼', frac34: '¾',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö',
  Uuml: 'Ü', szlig: 'ß', eacute: 'é', egrave: 'è', aacute: 'á',
  agrave: 'à', ccedil: 'ç', ntilde: 'ñ', iexcl: '¡', iquest: '¿',
};

const ENTITY_RE = /^&(?:#[xX]([0-9a-fA-F]{1,6});|#([0-9]{1,7});|([A-Za-z][A-Za-z0-9]{1,31});)/;

function decodeEntityAt(s, i) {
  const m = ENTITY_RE.exec(s.slice(i));
  if (!m) return null;
  if (m[1] !== undefined || m[2] !== undefined) {
    let cp = m[1] !== undefined ? parseInt(m[1], 16) : parseInt(m[2], 10);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
    return { text: String.fromCodePoint(cp), len: m[0].length };
  }
  if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, m[3])) {
    return { text: NAMED_ENTITIES[m[3]], len: m[0].length };
  }
  return null;
}

// Process backslash escapes and entities (used for URLs, titles, info strings).
function unescapeString(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && PUNCT.test(s[i + 1])) {
      out += s[i + 1];
      i++;
    } else if (c === '&') {
      const e = decodeEntityAt(s, i);
      if (e) { out += e.text; i += e.len - 1; } else out += c;
    } else out += c;
  }
  return out;
}

// Percent-encode a URL similarly to mdurl.encode (used by commonmark.js).
function normalizeURI(url) {
  let out = '';
  const keep = /[A-Za-z0-9;/?:@&=+$,\-_.!~*'()#]/;
  for (let i = 0; i < url.length; i++) {
    const c = url[i];
    if (c === '%' && /^[0-9a-fA-F]{2}$/.test(url.slice(i + 1, i + 3))) {
      out += url.slice(i, i + 3);
      i += 2;
      continue;
    }
    if (keep.test(c)) { out += c; continue; }
    const code = c.charCodeAt(0);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < url.length) {
      const next = url.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += encodeURIComponent(c + url[i + 1]);
        i++;
        continue;
      }
      out += '%EF%BF%BD';
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) { out += '%EF%BF%BD'; continue; }
    out += encodeURIComponent(c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

function expandTabs(line) {
  if (line.indexOf('\t') < 0) return line;
  let out = '';
  let col = 0;
  for (const ch of line) {
    if (ch === '\t') {
      const n = 4 - (col % 4);
      out += ' '.repeat(n);
      col += n;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

const isBlank = (l) => /^[ \t]*$/.test(l);
const indentOf = (l) => /^ */.exec(l)[0].length;

const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const HR_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const QUOTE_RE = /^ {0,3}>/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;
const LIST_RE = /^( {0,3})([-+*]|\d{1,9}[.)])(?=[ \t]|$)/;

function matchFence(line) {
  const m = FENCE_RE.exec(line);
  if (!m) return null;
  if (m[2][0] === '`' && m[3].includes('`')) return null;
  return { indent: m[1].length, fence: m[2], info: m[3] };
}

function matchListItem(line) {
  const m = LIST_RE.exec(line);
  if (!m) return null;
  const indent = m[1].length;
  const marker = m[2];
  const after = line.slice(indent + marker.length);
  const spaces = /^ */.exec(after)[0].length;
  const blankItem = isBlank(after);
  let padding;
  if (blankItem) padding = 1;
  else if (spaces >= 5) padding = 1;
  else padding = spaces;
  const ordered = /\d/.test(marker[0]);
  return {
    indent,
    marker,
    ordered,
    bulletChar: ordered ? marker[marker.length - 1] : marker,
    start: ordered ? parseInt(marker.slice(0, -1), 10) : null,
    contentIndent: indent + marker.length + padding,
    blankItem,
    firstLine: blankItem ? '' : line.slice(indent + marker.length + padding),
  };
}

// Whether a line could interrupt a paragraph (i.e. start a new block).
function interruptsParagraph(line) {
  if (ATX_RE.test(line) || HR_RE.test(line) || matchFence(line) || QUOTE_RE.test(line)) return true;
  const li = matchListItem(line);
  if (li && !li.blankItem && (!li.ordered || li.start === 1)) return true;
  return false;
}

function stripQuoteMarker(line) {
  const m = /^ {0,3}> ?/.exec(line);
  return line.slice(m[0].length);
}

function parseBlocks(lines) {
  const blocks = [];
  let i = 0;
  let blankBefore = false;
  let para = null;

  const push = (b) => {
    b.blankBefore = blankBefore;
    blankBefore = false;
    blocks.push(b);
    return b;
  };
  const closePara = () => { para = null; };

  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) {
      closePara();
      if (blocks.length) blankBefore = true;
      i++;
      continue;
    }

    // Paragraph continuation / setext heading
    if (para) {
      const sm = SETEXT_RE.exec(line);
      if (sm) {
        blocks.pop();
        const b = { type: 'heading', level: sm[1][0] === '=' ? 1 : 2, text: para.lines.join('\n').trim(), blankBefore: para.blankBefore };
        blocks.push(b);
        para = null;
        i++;
        continue;
      }
      if (!interruptsParagraph(line)) {
        para.lines.push(line.replace(/^[ \t]+/, ''));
        i++;
        continue;
      }
      closePara();
    }

    // Indented code block
    if (indentOf(line) >= 4) {
      const code = [];
      let j = i;
      let lastNonBlank = i;
      while (j < lines.length && (isBlank(lines[j]) || indentOf(lines[j]) >= 4)) {
        if (!isBlank(lines[j])) lastNonBlank = j;
        j++;
      }
      for (let k = i; k <= lastNonBlank; k++) code.push(lines[k].length >= 4 ? lines[k].slice(4) : '');
      push({ type: 'code', info: '', text: code.join('\n') + '\n' });
      i = lastNonBlank + 1;
      continue;
    }

    // Fenced code
    const fm = matchFence(line);
    if (fm) {
      const code = [];
      let j = i + 1;
      const closeRe = new RegExp('^ {0,3}' + (fm.fence[0] === '`' ? '`' : '~') + '{' + fm.fence.length + ',}[ \\t]*$');
      while (j < lines.length && !closeRe.test(lines[j])) {
        let l = lines[j];
        const ind = Math.min(indentOf(l), fm.indent);
        code.push(l.slice(ind));
        j++;
      }
      const info = unescapeString(fm.info.trim()).split(/[ \t]+/)[0] || '';
      push({ type: 'code', info, text: code.length ? code.join('\n') + '\n' : '' });
      i = j < lines.length ? j + 1 : j;
      continue;
    }

    // ATX heading
    const am = ATX_RE.exec(line);
    if (am) {
      let text = am[2] || '';
      text = text.replace(/(?:^|[ \t]+)#+[ \t]*$/, '').trim();
      if (/^#+$/.test(text)) text = '';
      push({ type: 'heading', level: am[1].length, text });
      i++;
      continue;
    }

    // Thematic break
    if (HR_RE.test(line)) {
      push({ type: 'hr' });
      i++;
      continue;
    }

    // Blockquote
    if (QUOTE_RE.test(line)) {
      const inner = [];
      let j = i;
      let lazyOk = false;
      while (j < lines.length) {
        const l = lines[j];
        if (QUOTE_RE.test(l)) {
          const s = stripQuoteMarker(l);
          inner.push(s);
          const t = s.trimStart();
          lazyOk = !isBlank(s) && !matchFence(s) && !HR_RE.test(s) && !ATX_RE.test(s) && indentOf(s) < 4;
          if (matchFence(s)) lazyOk = false;
          void t;
          j++;
        } else if (lazyOk && !isBlank(l) && !interruptsParagraph(l)) {
          inner.push(l);
          j++;
        } else break;
      }
      push({ type: 'blockquote', children: parseBlocks(inner) });
      i = j;
      continue;
    }

    // List
    const lm = matchListItem(line);
    if (lm) {
      const list = { type: 'list', ordered: lm.ordered, start: lm.start, bulletChar: lm.bulletChar, items: [], tight: true };
      let j = i;
      let cur = lm;
      let pendingBlankBetween = false;
      while (cur) {
        const itemLines = [cur.firstLine];
        let k = j + 1;
        let lazyOk = !cur.blankItem;
        let sawBlank = false;
        while (k < lines.length) {
          const l = lines[k];
          if (isBlank(l)) {
            // An item starting with a blank line can contain at most one blank line.
            if (cur.blankItem && itemLines.length === 1 && itemLines[0] === '') break;
            itemLines.push('');
            sawBlank = true;
            lazyOk = false;
            k++;
            continue;
          }
          if (indentOf(l) >= cur.contentIndent) {
            itemLines.push(l.slice(cur.contentIndent));
            lazyOk = true;
            sawBlank = false;
            k++;
            continue;
          }
          if (!sawBlank && lazyOk && !interruptsParagraph(l) && !SETEXT_RE.test(l) && !matchListItem(l)) {
            itemLines.push(l);
            k++;
            continue;
          }
          break;
        }
        // Trim trailing blank lines
        let trailingBlank = false;
        while (itemLines.length > 1 && itemLines[itemLines.length - 1] === '') {
          itemLines.pop();
          trailingBlank = true;
        }
        const children = parseBlocks(itemLines);
        if (pendingBlankBetween) list.tight = false;
        if (children.some((c, idx) => idx > 0 && c.blankBefore)) list.tight = false;
        list.items.push(children);
        j = k;
        while (j < lines.length && isBlank(lines[j])) { j++; trailingBlank = true; }
        // Next item?
        if (j < lines.length) {
          const nm = HR_RE.test(lines[j]) ? null : matchListItem(lines[j]);
          if (nm && nm.ordered === list.ordered && nm.bulletChar === list.bulletChar) {
            pendingBlankBetween = trailingBlank;
            cur = nm;
            continue;
          }
        }
        cur = null;
      }
      push(list);
      i = j;
      continue;
    }

    // Paragraph
    para = push({ type: 'paragraph', lines: [line.replace(/^[ \t]+/, '')] });
    i++;
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

const UNICODE_WS = /\s/u;
const UNICODE_PUNCT = /[\p{P}\p{S}]/u;

function parseLinkDestination(s, pos) {
  if (s[pos] === '<') {
    let i = pos + 1;
    let out = '';
    while (i < s.length) {
      const c = s[i];
      if (c === '\\' && i + 1 < s.length && PUNCT.test(s[i + 1])) { out += c + s[i + 1]; i += 2; continue; }
      if (c === '>') return { dest: out, end: i + 1 };
      if (c === '<' || c === '\n') return null;
      out += c;
      i++;
    }
    return null;
  }
  let i = pos;
  let depth = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && PUNCT.test(s[i + 1])) { i += 2; continue; }
    if (c === '(') { depth++; if (depth > 32) return null; }
    else if (c === ')') { if (depth === 0) break; depth--; }
    else if (/[ \x00-\x1f\x7f]/.test(c)) break;
    i++;
  }
  if (depth !== 0) return null;
  if (i === pos && s[i] !== ')') return null;
  return { dest: s.slice(pos, i), end: i };
}

function parseLinkTitle(s, pos) {
  const open = s[pos];
  let close;
  if (open === '"') close = '"';
  else if (open === "'") close = "'";
  else if (open === '(') close = ')';
  else return null;
  let i = pos + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && PUNCT.test(s[i + 1])) { i += 2; continue; }
    if (c === close) return { title: s.slice(pos + 1, i), end: i + 1 };
    if (open === '(' && c === '(') return null;
    i++;
  }
  return null;
}

// Try to parse "(dest "title")" starting at pos (which points at '(').
function parseInlineLinkTail(s, pos) {
  if (s[pos] !== '(') return null;
  let i = pos + 1;
  const skipWs = () => { while (i < s.length && /[ \t\n]/.test(s[i])) i++; };
  skipWs();
  let dest = '';
  let title = null;
  if (s[i] === ')') return { dest: '', title: null, end: i + 1 };
  const d = parseLinkDestination(s, i);
  if (!d) return null;
  dest = d.dest;
  i = d.end;
  const beforeWs = i;
  skipWs();
  if (s[i] === ')') return { dest, title: null, end: i + 1 };
  if (i === beforeWs) return null; // title must be separated by whitespace
  const t = parseLinkTitle(s, i);
  if (!t) return null;
  title = t.title;
  i = t.end;
  skipWs();
  if (s[i] !== ')') return null;
  return { dest, title, end: i + 1 };
}

function parseInlines(src) {
  // Nodes: {type:'text', value} | {type:'code'} | {type:'br'} | {type:'softbreak'}
  //        | {type:'em'|'strong', children} | {type:'link'|'image', dest, title, children}
  const nodes = [];
  const delims = []; // delimiter stack entries for * and _
  const brackets = []; // bracket stack
  let text = '';
  const flush = () => {
    if (text) { nodes.push({ type: 'text', value: text }); text = ''; }
  };
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src[i];

    if (c === '\\') {
      if (src[i + 1] === '\n') {
        flush();
        nodes.push({ type: 'br' });
        i += 2;
        while (i < n && src[i] === ' ') i++;
        continue;
      }
      if (i + 1 < n && PUNCT.test(src[i + 1])) { text += src[i + 1]; i += 2; continue; }
      text += c; i++; continue;
    }

    if (c === '&') {
      const e = decodeEntityAt(src, i);
      if (e) { text += e.text; i += e.len; continue; }
      text += c; i++; continue;
    }

    if (c === '`') {
      let j = i;
      while (j < n && src[j] === '`') j++;
      const runLen = j - i;
      // search for matching closing run
      let k = j;
      let found = -1;
      while (k < n) {
        if (src[k] === '`') {
          let e = k;
          while (e < n && src[e] === '`') e++;
          if (e - k === runLen) { found = k; break; }
          k = e;
        } else k++;
      }
      if (found < 0) { text += src.slice(i, j); i = j; continue; }
      let code = src.slice(j, found).replace(/\n/g, ' ');
      if (code.length >= 2 && code[0] === ' ' && code[code.length - 1] === ' ' && /[^ ]/.test(code)) {
        code = code.slice(1, -1);
      }
      flush();
      nodes.push({ type: 'code', value: code });
      i = found + runLen;
      continue;
    }

    if (c === '<') {
      const rest = src.slice(i);
      let m = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\x00-\x20]*)>/.exec(rest);
      if (m) {
        flush();
        nodes.push({ type: 'link', dest: m[1], title: null, children: [{ type: 'text', value: m[1] }] });
        i += m[0].length;
        continue;
      }
      m = /^<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/.exec(rest);
      if (m) {
        flush();
        nodes.push({ type: 'link', dest: 'mailto:' + m[1], title: null, children: [{ type: 'text', value: m[1] }] });
        i += m[0].length;
        continue;
      }
      text += c; i++; continue;
    }

    if (c === '\n') {
      // hard break if preceded by 2+ spaces
      let sp = 0;
      while (text.length && text[text.length - 1] === ' ') { text = text.slice(0, -1); sp++; }
      flush();
      nodes.push({ type: sp >= 2 ? 'br' : 'softbreak' });
      i++;
      while (i < n && src[i] === ' ') i++;
      continue;
    }

    if (c === '*' || c === '_') {
      let j = i;
      while (j < n && src[j] === c) j++;
      const count = j - i;
      const before = i === 0 ? '\n' : src[i - 1];
      const after = j >= n ? '\n' : src[j];
      const beforeWs = UNICODE_WS.test(before);
      const afterWs = UNICODE_WS.test(after);
      const beforeP = UNICODE_PUNCT.test(before);
      const afterP = UNICODE_PUNCT.test(after);
      const leftFlanking = !afterWs && (!afterP || beforeWs || beforeP);
      const rightFlanking = !beforeWs && (!beforeP || afterWs || afterP);
      let canOpen, canClose;
      if (c === '_') {
        canOpen = leftFlanking && (!rightFlanking || beforeP);
        canClose = rightFlanking && (!leftFlanking || afterP);
      } else {
        canOpen = leftFlanking;
        canClose = rightFlanking;
      }
      flush();
      const node = { type: 'text', value: src.slice(i, j) };
      nodes.push(node);
      delims.push({ node, char: c, count, origCount: count, canOpen, canClose, active: true });
      i = j;
      continue;
    }

    if (c === '!' && src[i + 1] === '[') {
      flush();
      const node = { type: 'text', value: '![' };
      nodes.push(node);
      brackets.push({ node, image: true, active: true, delimIndex: delims.length });
      i += 2;
      continue;
    }

    if (c === '[') {
      flush();
      const node = { type: 'text', value: '[' };
      nodes.push(node);
      brackets.push({ node, image: false, active: true, delimIndex: delims.length });
      i++;
      continue;
    }

    if (c === ']') {
      flush();
      const opener = brackets.length ? brackets[brackets.length - 1] : null;
      if (!opener) { text += ']'; i++; continue; }
      if (!opener.active) { brackets.pop(); text += ']'; i++; continue; }
      const tail = parseInlineLinkTail(src, i + 1);
      if (!tail) { brackets.pop(); text += ']'; i++; continue; }
      // Build link node
      const startIdx = nodes.indexOf(opener.node);
      const inner = nodes.splice(startIdx + 1);
      nodes.pop(); // remove opener text node
      const innerDelims = delims.splice(opener.delimIndex);
      processEmphasis(inner, innerDelims);
      const linkNode = {
        type: opener.image ? 'image' : 'link',
        dest: unescapeString(tail.dest),
        title: tail.title === null ? null : unescapeString(tail.title),
        children: inner,
      };
      nodes.push(linkNode);
      brackets.pop();
      if (!opener.image) {
        for (const b of brackets) if (!b.image) b.active = false;
      }
      i = tail.end;
      continue;
    }

    text += c;
    i++;
  }
  flush();
  processEmphasis(nodes, delims);
  return nodes;
}

// Delimiter-run processing for emphasis (CommonMark "process emphasis").
// `nodes` is a flat list containing the delimiter text nodes; we rebuild
// it in place, nesting em/strong nodes.
function processEmphasis(nodes, delims) {
  if (!delims.length) return;
  let ci = 0;
  while (ci < delims.length) {
    const closer = delims[ci];
    if (!closer.canClose || closer.count === 0) { ci++; continue; }
    const bottom = -1;
    let oi = ci - 1;
    let found = false;
    while (oi > bottom) {
      const op = delims[oi];
      if (op.char === closer.char && op.canOpen && op.count > 0) {
        const odd = (op.canClose || closer.canOpen) &&
          (op.origCount + closer.origCount) % 3 === 0 &&
          !(op.origCount % 3 === 0 && closer.origCount % 3 === 0);
        if (!odd) { found = true; break; }
      }
      oi--;
    }
    if (!found) {
      ci++;
      continue;
    }
    const opener = delims[oi];
    const use = opener.count >= 2 && closer.count >= 2 ? 2 : 1;
    opener.count -= use;
    closer.count -= use;
    opener.node.value = opener.node.value.slice(0, opener.count);
    closer.node.value = closer.node.value.slice(0, closer.count);
    const oIdx = nodes.indexOf(opener.node);
    const cIdx = nodes.indexOf(closer.node);
    const inner = nodes.slice(oIdx + 1, cIdx);
    const emph = { type: use === 2 ? 'strong' : 'em', children: inner };
    nodes.splice(oIdx + 1, cIdx - oIdx - 1, emph);
    // remove delimiters between opener and closer
    delims.splice(oi + 1, ci - oi - 1);
    ci = oi + 1;
    if (opener.count === 0) {
      nodes.splice(nodes.indexOf(opener.node), 1);
      delims.splice(oi, 1);
      ci--;
    }
    if (closer.count === 0) {
      nodes.splice(nodes.indexOf(closer.node), 1);
      delims.splice(ci, 1);
    }
  }
}

function renderInlines(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.type) {
      case 'text': out += escapeHtml(nd.value); break;
      case 'softbreak': out += '\n'; break;
      case 'br': out += '<br />\n'; break;
      case 'code': out += '<code>' + escapeHtml(nd.value) + '</code>'; break;
      case 'em': out += '<em>' + renderInlines(nd.children) + '</em>'; break;
      case 'strong': out += '<strong>' + renderInlines(nd.children) + '</strong>'; break;
      case 'link':
        out += '<a href="' + escapeHtml(normalizeURI(nd.dest)) + '"' +
          (nd.title !== null && nd.title !== undefined ? ' title="' + escapeHtml(nd.title) + '"' : '') +
          '>' + renderInlines(nd.children) + '</a>';
        break;
      case 'image':
        out += '<img src="' + escapeHtml(normalizeURI(nd.dest)) + '" alt="' + escapeHtml(plainText(nd.children)) + '"' +
          (nd.title !== null && nd.title !== undefined ? ' title="' + escapeHtml(nd.title) + '"' : '') +
          ' />';
        break;
    }
  }
  return out;
}

function plainText(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.type === 'text' || nd.type === 'code') out += nd.value;
    else if (nd.type === 'softbreak' || nd.type === 'br') out += '\n';
    else if (nd.children) out += plainText(nd.children);
  }
  return out;
}

function inline(text) {
  return renderInlines(parseInlines(text));
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

function renderBlocks(blocks, tight = false) {
  let out = '';
  for (const b of blocks) {
    switch (b.type) {
      case 'paragraph': {
        const content = inline(b.lines.join('\n').replace(/[ \t]+$/, ''));
        out += tight ? content : '<p>' + content + '</p>\n';
        break;
      }
      case 'heading':
        out += `<h${b.level}>${inline(b.text)}</h${b.level}>\n`;
        break;
      case 'hr':
        out += '<hr />\n';
        break;
      case 'code':
        out += '<pre><code' + (b.info ? ` class="language-${escapeHtml(b.info)}"` : '') + '>' +
          escapeHtml(b.text) + '</code></pre>\n';
        break;
      case 'blockquote':
        out += '<blockquote>\n' + renderBlocks(b.children) + '</blockquote>\n';
        break;
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        const startAttr = b.ordered && b.start !== 1 ? ` start="${b.start}"` : '';
        out += `<${tag}${startAttr}>\n`;
        for (const item of b.items) {
          let inner = '';
          item.forEach((child, idx) => {
            const r = renderBlocks([child], b.tight);
            if (b.tight && child.type === 'paragraph') {
              inner += r;
            } else {
              if (idx === 0 || (b.tight && item[idx - 1].type === 'paragraph')) inner += '\n';
              inner += r;
            }
          });
          out += '<li>' + inner + '</li>\n';
        }
        out += `</${tag}>\n`;
        break;
      }
    }
  }
  return out;
}

export function render(markdown) {
  const src = String(markdown ?? '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '�');
  const lines = src.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return renderBlocks(parseBlocks(lines.map(expandTabs)));
}

export default render;
