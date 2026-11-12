// Minimal CommonMark-subset Markdown -> HTML renderer.
// Output aims to match commonmark.js for the subset described in SPEC.md.

const ESC_RE = /[&<>"]/g;
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
export function escapeHtml(s) {
  return s.replace(ESC_RE, (c) => ESC_MAP[c]);
}

const ASCII_PUNCT = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/;
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®',
  trade: '™', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“',
  rdquo: '”', laquo: '«', raquo: '»', middot: '·', deg: '°', plusmn: '±', times: '×',
  divide: '÷', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶', bull: '•',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', eacute: 'é',
  egrave: 'è', aacute: 'á', agrave: 'à', iacute: 'í', oacute: 'ó', uacute: 'ú', ntilde: 'ñ',
  ccedil: 'ç', Eacute: 'É', larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔',
  hearts: '♥', infin: '∞', ne: '≠', le: '≤', ge: '≥', frac12: '½', frac14: '¼', frac34: '¾',
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', pi: 'π', sigma: 'σ', omega: 'ω', Omega: 'Ω',
  micro: 'µ', shy: '­', zwj: '‍', zwnj: '‌', thinsp: ' ', ensp: ' ',
  emsp: ' ', dagger: '†', Dagger: '‡', permil: '‰', prime: '′', Prime: '″', iexcl: '¡',
  iquest: '¿', ordf: 'ª', ordm: 'º', sup1: '¹', sup2: '²', sup3: '³', not: '¬', macr: '¯',
  acute: '´', cedil: '¸', uml: '¨', curren: '¤', brvbar: '¦', Dcaron: 'Ď', HilbertSpace: 'ℋ',
  DifferentialD: 'ⅆ', ClockwiseContourIntegral: '∲', ngE: '≧̸', AElig: 'Æ', aelig: 'æ',
};
const ENTITY_RE = /^&(?:#[xX]([0-9a-fA-F]{1,6});|#([0-9]{1,7});|([A-Za-z][A-Za-z0-9]{0,31});)/;

function decodeEntityAt(s, pos) {
  const m = ENTITY_RE.exec(s.slice(pos, pos + 40));
  if (!m) return null;
  let cp;
  if (m[1] !== undefined) cp = parseInt(m[1], 16);
  else if (m[2] !== undefined) cp = parseInt(m[2], 10);
  else {
    if (!Object.prototype.hasOwnProperty.call(ENTITIES, m[3])) return null;
    return { text: ENTITIES[m[3]], len: m[0].length };
  }
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
  return { text: String.fromCodePoint(cp), len: m[0].length };
}

// Process backslash escapes and entities (for URLs, titles, info strings).
function unescapeString(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && ASCII_PUNCT.test(s[i + 1])) {
      out += s[++i];
    } else if (c === '&') {
      const e = decodeEntityAt(s, i);
      if (e) { out += e.text; i += e.len - 1; } else out += c;
    } else out += c;
  }
  return out;
}

const URL_SAFE = /[A-Za-z0-9;\/?:@&=+$,\-_.!~*'()#]/;
function normalizeURI(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '%' && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) { out += c; continue; }
    if (URL_SAFE.test(c)) { out += c; continue; }
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { out += encodeURIComponent(c + s[i + 1]); i++; continue; }
    }
    if (code >= 0xd800 && code <= 0xdfff) { out += '%EF%BF%BD'; continue; }
    out += encodeURIComponent(c);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Inline parsing                                                       */
/* ------------------------------------------------------------------ */

const isWS = (c) => c === undefined || /\s/u.test(c);
const isPunct = (c) => c !== undefined && /[\p{P}\p{S}]/u.test(c);

function parseInline(src) {
  const nodes = [];
  let delims = [];
  const brackets = [];
  let seq = 0;
  let pos = 0;
  const n = src.length;

  const pushText = (t) => {
    const last = nodes[nodes.length - 1];
    if (last && last.t === 'text' && !last.special) last.v += t;
    else nodes.push({ t: 'text', v: t });
  };

  function processEmphasis(bottomSeq) {
    const openersBottom = {};
    let ci = 0;
    while (ci < delims.length && delims[ci].seq <= bottomSeq) ci++;
    while (ci < delims.length) {
      const c = delims[ci];
      if (!c.canClose) { ci++; continue; }
      const key = c.ch + (c.canOpen ? '1' : '0') + (c.orig % 3);
      const bottom = Math.max(openersBottom[key] ?? -Infinity, bottomSeq);
      let oi = ci - 1;
      let opener = null;
      while (oi >= 0 && delims[oi].seq > bottom) {
        const o = delims[oi];
        if (o.ch === c.ch && o.canOpen) {
          const odd = (c.canOpen || o.canClose) && (o.orig + c.orig) % 3 === 0 &&
            !(o.orig % 3 === 0 && c.orig % 3 === 0);
          if (!odd) { opener = o; break; }
        }
        oi--;
      }
      if (opener) {
        const use = c.count >= 2 && opener.count >= 2 ? 2 : 1;
        opener.count -= use; c.count -= use;
        opener.node.v = opener.node.v.slice(use);
        c.node.v = c.node.v.slice(use);
        const a = nodes.indexOf(opener.node);
        const b = nodes.indexOf(c.node);
        const inner = nodes.splice(a + 1, b - a - 1);
        nodes.splice(a + 1, 0, { t: use === 2 ? 'strong' : 'em', children: inner });
        delims.splice(oi + 1, ci - oi - 1);
        ci = oi + 1;
        if (opener.count === 0) {
          nodes.splice(nodes.indexOf(opener.node), 1);
          delims.splice(oi, 1);
          ci--;
        }
        if (c.count === 0) {
          nodes.splice(nodes.indexOf(c.node), 1);
          delims.splice(ci, 1);
        }
      } else {
        openersBottom[key] = c.seq - 0.5;
        if (!c.canOpen) delims.splice(ci, 1);
        else ci++;
      }
    }
    delims = delims.filter((d) => d.seq <= bottomSeq);
  }

  function parseLinkTail(p) {
    // p points just after ']'. Returns {dest, title, end} or null.
    if (src[p] !== '(') return null;
    p++;
    const skipWS = () => { while (p < n && /[ \t\n]/.test(src[p])) p++; };
    skipWS();
    let dest = '';
    if (src[p] === '<') {
      let q = p + 1;
      let raw = '';
      for (;;) {
        if (q >= n || src[q] === '\n' || src[q] === '<') return null;
        if (src[q] === '\\' && q + 1 < n && ASCII_PUNCT.test(src[q + 1])) { raw += src[q] + src[q + 1]; q += 2; continue; }
        if (src[q] === '>') break;
        raw += src[q++];
      }
      dest = raw; p = q + 1;
    } else if (src[p] !== ')') {
      let depth = 0;
      const start = p;
      while (p < n) {
        const c = src[p];
        if (c === '\\' && p + 1 < n && ASCII_PUNCT.test(src[p + 1])) { p += 2; continue; }
        if (c === '(') { depth++; if (depth > 32) return null; }
        else if (c === ')') { if (depth === 0) break; depth--; }
        else if (/[\x00-\x20\x7f]/.test(c)) break;
        p++;
      }
      if (depth !== 0 || p === start) return null;
      dest = src.slice(start, p);
    }
    const beforeWS = p;
    skipWS();
    let title = null;
    if (p > beforeWS && (src[p] === '"' || src[p] === "'" || src[p] === '(')) {
      const close = src[p] === '(' ? ')' : src[p];
      let q = p + 1;
      let raw = '';
      let ok = false;
      while (q < n) {
        const c = src[q];
        if (c === '\\' && q + 1 < n && ASCII_PUNCT.test(src[q + 1])) { raw += c + src[q + 1]; q += 2; continue; }
        if (c === close) { ok = true; break; }
        if (close === ')' && c === '(') break;
        raw += c; q++;
      }
      if (ok) { title = raw; p = q + 1; skipWS(); }
      else return null;
    }
    if (src[p] !== ')') return null;
    return { dest: normalizeURI(unescapeString(dest)), title: title === null ? null : unescapeString(title), end: p + 1 };
  }

  while (pos < n) {
    const c = src[pos];
    if (c === '\n') {
      const last = nodes[nodes.length - 1];
      let hard = false;
      if (last && last.t === 'text' && !last.special) {
        const m = /( *)$/.exec(last.v);
        if (m[1].length >= 2) hard = true;
        last.v = last.v.replace(/[ \t]+$/, '');
      }
      nodes.push(hard ? { t: 'hardbreak' } : { t: 'softbreak' });
      pos++;
      while (pos < n && (src[pos] === ' ' || src[pos] === '\t')) pos++;
    } else if (c === '\\') {
      const nx = src[pos + 1];
      if (nx === '\n') { nodes.push({ t: 'hardbreak' }); pos += 2; while (pos < n && (src[pos] === ' ' || src[pos] === '\t')) pos++; }
      else if (nx !== undefined && ASCII_PUNCT.test(nx)) { pushText(nx); pos += 2; }
      else { pushText('\\'); pos++; }
    } else if (c === '`') {
      let e = pos;
      while (src[e] === '`') e++;
      const len = e - pos;
      let q = e;
      let found = -1;
      while (q < n) {
        const i = src.indexOf('`', q);
        if (i < 0) break;
        let j = i;
        while (src[j] === '`') j++;
        if (j - i === len) { found = i; break; }
        q = j;
      }
      if (found < 0) { pushText(src.slice(pos, e)); pos = e; }
      else {
        let content = src.slice(e, found).replace(/\n/g, ' ');
        if (content.length > 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) content = content.slice(1, -1);
        else if (content.length === 2 && content === '  ') { /* keep */ }
        nodes.push({ t: 'code', v: content });
        pos = found + len;
      }
    } else if (c === '*' || c === '_') {
      let e = pos;
      while (src[e] === c) e++;
      const before = pos === 0 ? undefined : src[pos - 1];
      const after = src[e];
      const left = !isWS(after) && (!isPunct(after) || isWS(before) || isPunct(before));
      const right = !isWS(before) && (!isPunct(before) || isWS(after) || isPunct(after));
      let canOpen, canClose;
      if (c === '*') { canOpen = left; canClose = right; }
      else {
        canOpen = left && (!right || isPunct(before));
        canClose = right && (!left || isPunct(after));
      }
      const node = { t: 'text', v: src.slice(pos, e), special: true };
      nodes.push(node);
      if (canOpen || canClose) delims.push({ node, ch: c, count: e - pos, orig: e - pos, canOpen, canClose, seq: ++seq });
      pos = e;
    } else if (c === '[' || (c === '!' && src[pos + 1] === '[')) {
      const image = c === '!';
      const node = { t: 'text', v: image ? '![' : '[', special: true };
      nodes.push(node);
      brackets.push({ node, image, active: true, seq: ++seq });
      pos += image ? 2 : 1;
    } else if (c === ']') {
      pos++;
      const b = brackets[brackets.length - 1];
      if (!b) { pushText(']'); continue; }
      if (!b.active) { brackets.pop(); pushText(']'); continue; }
      const res = parseLinkTail(pos);
      if (!res) { brackets.pop(); pushText(']'); continue; }
      processEmphasis(b.seq);
      const idx = nodes.indexOf(b.node);
      const children = nodes.splice(idx + 1);
      nodes.pop();
      nodes.push({ t: b.image ? 'img' : 'link', children, dest: res.dest, title: res.title });
      brackets.pop();
      if (!b.image) for (const br of brackets) if (!br.image) br.active = false;
      pos = res.end;
    } else if (c === '<') {
      const rest = src.slice(pos);
      let m = /^<([A-Za-z][A-Za-z0-9+.\-]{1,31}:[^<>\x00-\x20]*)>/.exec(rest);
      if (m) {
        nodes.push({ t: 'link', dest: normalizeURI(m[1]), title: null, children: [{ t: 'text', v: m[1] }] });
        pos += m[0].length;
      } else if ((m = /^<([a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~\-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/.exec(rest))) {
        nodes.push({ t: 'link', dest: 'mailto:' + normalizeURI(m[1]), title: null, children: [{ t: 'text', v: m[1] }] });
        pos += m[0].length;
      } else { pushText('<'); pos++; }
    } else if (c === '&') {
      const e = decodeEntityAt(src, pos);
      if (e) { pushText(e.text); pos += e.len; } else { pushText('&'); pos++; }
    } else {
      let e = pos + 1;
      while (e < n && !/[\n\\`*_\[\]!<&]/.test(src[e])) e++;
      pushText(src.slice(pos, e));
      pos = e;
    }
  }
  processEmphasis(-Infinity);
  return nodes;
}

function plainText(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.t === 'text' || nd.t === 'code') out += nd.v;
    else if (nd.t === 'softbreak' || nd.t === 'hardbreak') out += '\n';
    else if (nd.children) out += plainText(nd.children);
  }
  return out;
}

function renderInlineNodes(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.t) {
      case 'text': out += escapeHtml(nd.v); break;
      case 'code': out += '<code>' + escapeHtml(nd.v) + '</code>'; break;
      case 'softbreak': out += '\n'; break;
      case 'hardbreak': out += '<br />\n'; break;
      case 'em': out += '<em>' + renderInlineNodes(nd.children) + '</em>'; break;
      case 'strong': out += '<strong>' + renderInlineNodes(nd.children) + '</strong>'; break;
      case 'link':
        out += '<a href="' + escapeHtml(nd.dest) + '"' +
          (nd.title !== null && nd.title !== undefined ? ' title="' + escapeHtml(nd.title) + '"' : '') +
          '>' + renderInlineNodes(nd.children) + '</a>';
        break;
      case 'img':
        out += '<img src="' + escapeHtml(nd.dest) + '" alt="' + escapeHtml(plainText(nd.children)) + '"' +
          (nd.title !== null && nd.title !== undefined ? ' title="' + escapeHtml(nd.title) + '"' : '') + ' />';
        break;
    }
  }
  return out;
}

function renderInline(s) {
  return renderInlineNodes(parseInline(s));
}

/* ------------------------------------------------------------------ */
/* Block parsing                                                        */
/* ------------------------------------------------------------------ */

const isBlank = (l) => /^[ \t]*$/.test(l);
const indentOf = (l) => /^ */.exec(l)[0].length;
const HR_RE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const FENCE_RE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const BULLET_RE = /^( {0,3})([-+*])([ \t]+|$)(.*)$/;
const ORDERED_RE = /^( {0,3})(\d{1,9})([.)])([ \t]+|$)(.*)$/;

function expandTabs(line) {
  // Expand tabs in leading whitespace (tab stops of 4).
  if (line.indexOf('\t') < 0) return line;
  let out = '';
  let col = 0;
  let i = 0;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '\t') { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; }
    else if (c === ' ' || c === '>' ) { out += c; col++; }
    else break;
  }
  return out + line.slice(i);
}

function matchFence(line) {
  const m = FENCE_RE.exec(line);
  if (!m) return null;
  if (m[2][0] === '`' && m[3].includes('`')) return null;
  return { indent: m[1].length, ch: m[2][0], len: m[2].length, info: m[3].trim() };
}

function matchListItem(line) {
  if (HR_RE.test(line)) return null;
  let m = BULLET_RE.exec(line);
  if (m) {
    return { ordered: false, ch: m[2], indent: m[1].length, markerLen: 1, spaces: m[3], rest: m[4], start: null };
  }
  m = ORDERED_RE.exec(line);
  if (m) {
    return { ordered: true, ch: m[3], indent: m[1].length, markerLen: m[2].length + 1, spaces: m[3 + 1], rest: m[5], start: parseInt(m[2], 10) };
  }
  return null;
}

function startsBlock(line, inPara) {
  if (isBlank(line)) return true;
  if (indentOf(line) >= 4) return false;
  if (HR_RE.test(line) || ATX_RE.test(line) || matchFence(line) || /^ {0,3}>/.test(line)) return true;
  const li = matchListItem(line);
  if (li) {
    if (!inPara) return true;
    if (isBlank(li.rest)) return false;
    if (li.ordered && li.start !== 1) return false;
    return true;
  }
  return false;
}

// Rough check whether the given (container-relative) lines end in an open paragraph,
// used for lazy continuation lines.
function endsInParagraph(lines) {
  let inFence = null;
  let para = false;
  let prevBlank = true;
  for (const l of lines) {
    if (inFence) {
      const f = matchFence(l);
      if (f && f.ch === inFence.ch && f.len >= inFence.len && f.info === '') inFence = null;
      continue;
    }
    if (isBlank(l)) { para = false; prevBlank = true; continue; }
    const f = matchFence(l);
    if (f) { inFence = f; para = false; prevBlank = false; continue; }
    if (!para && indentOf(l) >= 4) { prevBlank = false; continue; }
    if (/^ {0,3}>/.test(l)) {
      para = endsInParagraph([l.replace(/^ {0,3}> ?/, '')]);
      prevBlank = false; continue;
    }
    const li = matchListItem(l);
    if (li && (!para || startsBlock(l, true))) { para = !isBlank(li.rest) && indentOf(li.rest) < 4; prevBlank = false; continue; }
    if (HR_RE.test(l) || ATX_RE.test(l)) { para = false; prevBlank = false; continue; }
    para = true; prevBlank = false;
  }
  void prevBlank;
  return para && !inFence;
}

function parseBlocks(lines) {
  const blocks = [];
  let i = 0;
  let blankBefore = false;
  const n = lines.length;
  const push = (b) => { b.blankBefore = blankBefore; blankBefore = false; blocks.push(b); };

  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { blankBefore = true; i++; continue; }
    const ind = indentOf(line);

    if (ind >= 4) {
      const code = [];
      while (i < n && (isBlank(lines[i]) || indentOf(lines[i]) >= 4)) {
        code.push(isBlank(lines[i]) ? lines[i].slice(Math.min(4, indentOf(lines[i]))) : lines[i].slice(4));
        i++;
      }
      while (code.length && isBlank(code[code.length - 1])) code.pop();
      push({ type: 'code', info: '', text: code.map((l) => l + '\n').join('') });
      continue;
    }

    const fence = matchFence(line);
    if (fence) {
      i++;
      const content = [];
      while (i < n) {
        const l = lines[i];
        const cf = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(l);
        if (cf && cf[1][0] === fence.ch && cf[1].length >= fence.len) { i++; break; }
        let k = 0;
        while (k < fence.indent && l[k] === ' ') k++;
        content.push(l.slice(k));
        i++;
      }
      const info = unescapeString(fence.info.split(/[ \t]+/)[0] || '');
      push({ type: 'code', info, text: content.map((l) => l + '\n').join('') });
      continue;
    }

    const atx = ATX_RE.exec(line);
    if (atx) {
      let text = atx[2] || '';
      text = text.replace(/(^|[ \t]+)#+[ \t]*$/, '').trim();
      push({ type: 'heading', level: atx[1].length, text });
      i++;
      continue;
    }

    if (HR_RE.test(line)) { push({ type: 'hr' }); i++; continue; }

    if (/^ {0,3}>/.test(line)) {
      const inner = [];
      while (i < n) {
        const l = lines[i];
        if (/^ {0,3}>/.test(l)) {
          inner.push(expandTabs(l.replace(/^ {0,3}>/, '').replace(/^ /, '')));
          i++;
        } else if (!isBlank(l) && inner.length && !isBlank(inner[inner.length - 1]) &&
          endsInParagraph(inner) && !startsBlock(l, false)) {
          inner.push(l);
          i++;
        } else break;
      }
      push({ type: 'blockquote', children: parseBlocks(inner) });
      continue;
    }

    const li = matchListItem(line);
    if (li) {
      const list = { type: 'list', ordered: li.ordered, ch: li.ch, start: li.start, items: [], loose: false };
      let first = true;
      while (i < n) {
        const item = first ? li : matchListItem(lines[i]);
        if (!item || item.ordered !== list.ordered || item.ch !== list.ch) break;
        if (!first && indentOf(lines[i]) >= 4) break;
        first = false;
        const markerW = item.indent + item.markerLen;
        let contentIndent;
        let firstContent;
        const sp = item.spaces.replace(/\t/g, '    ').length;
        if (isBlank(item.rest)) { contentIndent = markerW + 1; firstContent = ''; }
        else if (sp >= 5) { contentIndent = markerW + 1; firstContent = ' '.repeat(sp - 1) + item.rest; }
        else { contentIndent = markerW + sp; firstContent = item.rest; }
        const itemLines = [firstContent];
        const startedBlank = firstContent === '';
        i++;
        while (i < n) {
          const l = lines[i];
          if (isBlank(l)) {
            if (startedBlank && itemLines.length === 1) break;
            itemLines.push('');
            i++;
            continue;
          }
          if (indentOf(l) >= contentIndent) { itemLines.push(l.slice(contentIndent)); i++; continue; }
          const last = itemLines[itemLines.length - 1];
          if (!isBlank(last) && endsInParagraph(itemLines) && !startsBlock(l, false)) {
            itemLines.push(l);
            i++;
            continue;
          }
          break;
        }
        let trailing = 0;
        while (itemLines.length > 1 && isBlank(itemLines[itemLines.length - 1])) { itemLines.pop(); trailing++; }
        const children = parseBlocks(itemLines);
        list.items.push({ children, trailingBlank: trailing > 0 });
        if (children.some((b, k) => k > 0 && b.blankBefore)) list.loose = true;
        // blank lines end the list unless followed by another item
        if (trailing > 0) {
          const nx = i < n ? matchListItem(lines[i]) : null;
          if (nx && nx.ordered === list.ordered && nx.ch === list.ch && indentOf(lines[i]) < 4) list.loose = true;
        }
      }
      push(list);
      continue;
    }

    // Paragraph
    const para = [line];
    i++;
    let setext = 0;
    while (i < n) {
      const l = lines[i];
      if (isBlank(l)) break;
      if (indentOf(l) < 4) {
        if (/^ {0,3}=+[ \t]*$/.test(l)) { setext = 1; i++; break; }
        if (/^ {0,3}-+[ \t]*$/.test(l)) { setext = 2; i++; break; }
      }
      if (startsBlock(l, true)) break;
      para.push(l);
      i++;
    }
    const text = para.map((l) => l.replace(/^[ \t]+/, '')).join('\n').replace(/[ \t]+$/, '');
    if (setext) push({ type: 'heading', level: setext, text });
    else push({ type: 'paragraph', text });
  }
  return blocks;
}

/* ------------------------------------------------------------------ */
/* Rendering                                                            */
/* ------------------------------------------------------------------ */

function renderBlocks(blocks, tight) {
  const out = [];
  for (const b of blocks) {
    switch (b.type) {
      case 'paragraph':
        out.push(tight ? renderInline(b.text) : '<p>' + renderInline(b.text) + '</p>');
        break;
      case 'heading':
        out.push(`<h${b.level}>` + renderInline(b.text) + `</h${b.level}>`);
        break;
      case 'hr':
        out.push('<hr />');
        break;
      case 'code':
        out.push('<pre><code' + (b.info ? ' class="language-' + escapeHtml(b.info) + '"' : '') + '>' +
          escapeHtml(b.text) + '</code></pre>');
        break;
      case 'blockquote':
        out.push('<blockquote>\n' + renderBlocks(b.children, false) + (b.children.length ? '\n' : '') + '</blockquote>');
        break;
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        const startAttr = b.ordered && b.start !== 1 ? ` start="${b.start}"` : '';
        const items = b.items.map((it) => {
          const inner = renderBlocks(it.children, !b.loose);
          if (!it.children.length) return '<li></li>';
          const firstPara = it.children[0].type === 'paragraph' && !b.loose;
          const lastPara = it.children[it.children.length - 1].type === 'paragraph' && !b.loose;
          return '<li>' + (firstPara ? '' : '\n') + inner + (lastPara ? '' : '\n') + '</li>';
        });
        out.push(`<${tag}${startAttr}>\n` + items.join('\n') + `\n</${tag}>`);
        break;
      }
    }
  }
  return out.join('\n');
}

export function render(markdown) {
  const src = String(markdown ?? '').replace(/\r\n?/g, '\n').replace(/\0/g, '�');
  const lines = src.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const blocks = parseBlocks(lines.map(expandTabs));
  const html = renderBlocks(blocks, false);
  return html ? html + '\n' : '';
}

export default render;
