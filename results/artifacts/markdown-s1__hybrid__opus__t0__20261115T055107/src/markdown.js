// Minimal CommonMark-subset Markdown -> HTML renderer.
// Written from scratch following the CommonMark 0.31 spec.

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '\u00a9',
  reg: '\u00ae', trade: '\u2122', hellip: '\u2026', mdash: '\u2014', ndash: '\u2013',
  lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d', laquo: '\u00ab',
  raquo: '\u00bb', middot: '\u00b7', times: '\u00d7', divide: '\u00f7', deg: '\u00b0',
  plusmn: '\u00b1', para: '\u00b6', sect: '\u00a7', euro: '\u20ac', pound: '\u00a3',
  yen: '\u00a5', cent: '\u00a2', bull: '\u2022', larr: '\u2190', rarr: '\u2192',
  uarr: '\u2191', darr: '\u2193', harr: '\u2194', auml: '\u00e4', ouml: '\u00f6',
  uuml: '\u00fc', Auml: '\u00c4', Ouml: '\u00d6', Uuml: '\u00dc', szlig: '\u00df',
  eacute: '\u00e9', egrave: '\u00e8', aacute: '\u00e1', agrave: '\u00e0', ccedil: '\u00e7',
  ntilde: '\u00f1', iexcl: '\u00a1', iquest: '\u00bf', shy: '\u00ad', ensp: '\u2002',
  emsp: '\u2003', thinsp: '\u2009', infin: '\u221e', ne: '\u2260', le: '\u2264', ge: '\u2265',
  alpha: '\u03b1', beta: '\u03b2', gamma: '\u03b3', delta: '\u03b4', pi: '\u03c0',
  sigma: '\u03c3', omega: '\u03c9', Omega: '\u03a9', micro: '\u00b5', frac12: '\u00bd',
  frac14: '\u00bc', frac34: '\u00be', sup2: '\u00b2', sup3: '\u00b3', dagger: '\u2020',
  Dagger: '\u2021', permil: '\u2030', prime: '\u2032', Prime: '\u2033', hearts: '\u2665',
  ngE: '\u2267\u0338', DifferentialD: '\u2146', ClockwiseContourIntegral: '\u2232',
  HilbertSpace: '\u210b', Dcaron: '\u010e', AElig: '\u00c6',
};

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}

const ASCII_PUNCT = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/;
const PUNCT = /[\p{P}\p{S}]/u;
const WS = /[\s\u00a0]/u;
const ENTITY_RE = /^&(?:#[xX]([0-9a-fA-F]{1,6});|#([0-9]{1,7});|([A-Za-z][A-Za-z0-9]{0,31});)/;

function decodeEntity(m) {
  let cp;
  if (m[1] !== undefined) cp = parseInt(m[1], 16);
  else if (m[2] !== undefined) cp = parseInt(m[2], 10);
  else return Object.prototype.hasOwnProperty.call(ENTITIES, m[3]) ? ENTITIES[m[3]] : null;
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '\ufffd';
  return String.fromCodePoint(cp);
}

// Process backslash escapes and entities in a string (used for URLs, titles, info strings).
function unescapeString(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && ASCII_PUNCT.test(s[i + 1])) { out += s[++i]; continue; }
    if (c === '&') {
      const m = ENTITY_RE.exec(s.slice(i));
      if (m) {
        const d = decodeEntity(m);
        if (d !== null) { out += d; i += m[0].length - 1; continue; }
      }
    }
    out += c;
  }
  return out;
}

function normalizeUrl(url) {
  let out = '';
  const bytes = new TextEncoder();
  for (let i = 0; i < url.length; i++) {
    const c = url[i];
    if (/[A-Za-z0-9;/?:@&=+$,\-_.!~*'()#]/.test(c)) { out += c; continue; }
    if (c === '%' && /^[0-9a-fA-F]{2}$/.test(url.slice(i + 1, i + 3))) { out += c; continue; }
    let ch = c;
    const code = c.charCodeAt(0);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < url.length) { ch = url.slice(i, i + 2); i++; }
    for (const b of bytes.encode(ch)) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

// ---------------------------------------------------------------- inline parsing

function parseInlines(text) {
  const nodes = [];
  const delims = [];
  const brackets = [];
  let delimId = 0;
  let pos = 0;
  const n = text.length;

  const pushText = s => {
    const last = nodes[nodes.length - 1];
    if (last && last.type === 'text' && !last.delim) last.value += s;
    else nodes.push({ type: 'text', value: s });
  };

  const isWs = c => c === undefined || WS.test(c);
  const isPunct = c => c !== undefined && PUNCT.test(c);

  while (pos < n) {
    const c = text[pos];
    if (c === '\\') {
      const nx = text[pos + 1];
      if (nx === '\n') {
        nodes.push({ type: 'hardbreak' });
        pos += 2;
        while (text[pos] === ' ' || text[pos] === '\t') pos++;
      } else if (nx !== undefined && ASCII_PUNCT.test(nx)) { pushText(nx); pos += 2; }
      else { pushText('\\'); pos++; }
    } else if (c === '`') {
      let e = pos;
      while (text[e] === '`') e++;
      const len = e - pos;
      let found = -1;
      let s = e;
      while (s < n) {
        const j = text.indexOf('`', s);
        if (j < 0) break;
        let k = j;
        while (text[k] === '`') k++;
        if (k - j === len) { found = j; break; }
        s = k;
      }
      if (found < 0) { pushText(text.slice(pos, e)); pos = e; }
      else {
        let code = text.slice(e, found).replace(/\n/g, ' ');
        if (code.length >= 2 && code[0] === ' ' && code[code.length - 1] === ' ' && /[^ ]/.test(code)) code = code.slice(1, -1);
        nodes.push({ type: 'code', value: code });
        pos = found + len;
      }
    } else if (c === '*' || c === '_') {
      let e = pos;
      while (text[e] === c) e++;
      const before = pos === 0 ? undefined : text[pos - 1];
      const after = text[e];
      const left = !isWs(after) && (!isPunct(after) || isWs(before) || isPunct(before));
      const right = !isWs(before) && (!isPunct(before) || isWs(after) || isPunct(after));
      let canOpen, canClose;
      if (c === '*') { canOpen = left; canClose = right; }
      else {
        canOpen = left && (!right || isPunct(before));
        canClose = right && (!left || isPunct(after));
      }
      const node = { type: 'text', value: text.slice(pos, e), delim: true };
      nodes.push(node);
      if (canOpen || canClose) {
        delims.push({ id: delimId++, node, char: c, count: e - pos, orig: e - pos, canOpen, canClose });
      }
      pos = e;
    } else if (c === '[' || (c === '!' && text[pos + 1] === '[')) {
      const image = c === '!';
      const node = { type: 'text', value: image ? '![' : '[', delim: true };
      nodes.push(node);
      brackets.push({ node, image, active: true, delimBottom: delims.length });
      pos += image ? 2 : 1;
    } else if (c === ']') {
      pos++;
      const br = brackets[brackets.length - 1];
      if (!br) { pushText(']'); continue; }
      if (!br.active) { brackets.pop(); pushText(']'); continue; }
      const link = parseLinkTail(text, pos);
      if (!link) { brackets.pop(); pushText(']'); continue; }
      pos = link.end;
      processEmphasis(nodes, delims, br.delimBottom);
      const idx = nodes.indexOf(br.node);
      const children = nodes.splice(idx + 1);
      nodes.pop();
      nodes.push({ type: br.image ? 'image' : 'link', dest: link.dest, title: link.title, children });
      brackets.pop();
      if (!br.image) for (const b of brackets) if (!b.image) b.active = false;
    } else if (c === '&') {
      const m = ENTITY_RE.exec(text.slice(pos, pos + 40));
      const d = m ? decodeEntity(m) : null;
      if (d !== null) { pushText(d); pos += m[0].length; }
      else { pushText('&'); pos++; }
    } else if (c === '\n') {
      const last = nodes[nodes.length - 1];
      let hard = false;
      if (last && last.type === 'text' && !last.delim) {
        const m = /( *)$/.exec(last.value);
        if (m[1].length >= 2) hard = true;
        last.value = last.value.replace(/ +$/, '');
      }
      nodes.push({ type: hard ? 'hardbreak' : 'softbreak' });
      pos++;
      while (text[pos] === ' ' || text[pos] === '\t') pos++;
    } else {
      let e = pos + 1;
      while (e < n && !'\\`*_[]!&\n'.includes(text[e])) e++;
      pushText(text.slice(pos, e));
      pos = e;
    }
  }
  processEmphasis(nodes, delims, 0);
  return nodes;
}

function parseLinkTail(text, pos) {
  if (text[pos] !== '(') return null;
  let p = pos + 1;
  const skipWs = () => {
    const s = p;
    let nl = 0;
    while (p < text.length && /[ \t\n]/.test(text[p])) {
      if (text[p] === '\n' && ++nl > 1) return -1;
      p++;
    }
    return p - s;
  };
  if (skipWs() < 0) return null;
  let dest = '';
  if (text[p] === '<') {
    let q = p + 1;
    while (q < text.length && text[q] !== '>') {
      if (text[q] === '\n' || text[q] === '<') return null;
      if (text[q] === '\\' && q + 1 < text.length) q++;
      q++;
    }
    if (text[q] !== '>') return null;
    dest = text.slice(p + 1, q);
    p = q + 1;
  } else {
    let depth = 0;
    const s = p;
    while (p < text.length) {
      const ch = text[p];
      if (ch === '\\' && p + 1 < text.length && ASCII_PUNCT.test(text[p + 1])) { p += 2; continue; }
      if (ch.charCodeAt(0) <= 0x20 || ch === '\x7f') break;
      if (ch === '(') depth++;
      else if (ch === ')') { if (depth === 0) break; depth--; }
      p++;
    }
    if (depth !== 0) return null;
    dest = text.slice(s, p);
  }
  const ws = skipWs();
  if (ws < 0) return null;
  let title = null;
  const q0 = text[p];
  if (ws > 0 && (q0 === '"' || q0 === "'" || q0 === '(')) {
    const close = q0 === '(' ? ')' : q0;
    let q = p + 1;
    while (q < text.length && text[q] !== close) {
      if (text[q] === '\\' && q + 1 < text.length) q++;
      else if (q0 === '(' && text[q] === '(') return null;
      q++;
    }
    if (q >= text.length) return null;
    title = text.slice(p + 1, q);
    p = q + 1;
    if (skipWs() < 0) return null;
  }
  if (text[p] !== ')') return null;
  return { dest: unescapeString(dest), title: title === null ? null : unescapeString(title), end: p + 1 };
}

function processEmphasis(nodes, delims, bottom) {
  const openersBottom = {};
  let ci = bottom;
  while (ci < delims.length) {
    const c = delims[ci];
    if (!c.canClose) { ci++; continue; }
    const key = c.char + (c.canOpen ? '1' : '0') + (c.orig % 3);
    const bound = openersBottom[key] ?? -1;
    let oi = ci - 1;
    let found = false;
    while (oi >= bottom && delims[oi].id > bound) {
      const o = delims[oi];
      if (o.char === c.char && o.canOpen) {
        const odd = (o.canClose || c.canOpen) && (o.orig + c.orig) % 3 === 0 && !(o.orig % 3 === 0 && c.orig % 3 === 0);
        if (!odd) { found = true; break; }
      }
      oi--;
    }
    if (found) {
      const o = delims[oi];
      const use = o.count >= 2 && c.count >= 2 ? 2 : 1;
      o.count -= use; c.count -= use;
      o.node.value = o.node.value.slice(0, o.count);
      c.node.value = c.node.value.slice(0, c.count);
      const si = nodes.indexOf(o.node);
      const ei = nodes.indexOf(c.node);
      const children = nodes.splice(si + 1, ei - si - 1);
      nodes.splice(si + 1, 0, { type: use === 2 ? 'strong' : 'em', children });
      delims.splice(oi + 1, ci - oi - 1);
      ci = oi + 1;
      if (o.count === 0) { nodes.splice(nodes.indexOf(o.node), 1); delims.splice(oi, 1); ci--; }
      if (c.count === 0) { nodes.splice(nodes.indexOf(c.node), 1); delims.splice(ci, 1); }
    } else {
      openersBottom[key] = ci - 1 >= bottom ? delims[ci - 1].id : -1;
      if (!c.canOpen) delims.splice(ci, 1);
      else ci++;
    }
  }
  delims.length = Math.min(delims.length, bottom);
}

function renderInlines(nodes) {
  let out = '';
  for (const nd of nodes) {
    switch (nd.type) {
      case 'text': out += escapeHtml(nd.value); break;
      case 'code': out += '<code>' + escapeHtml(nd.value) + '</code>'; break;
      case 'softbreak': out += '\n'; break;
      case 'hardbreak': out += '<br />\n'; break;
      case 'em': out += '<em>' + renderInlines(nd.children) + '</em>'; break;
      case 'strong': out += '<strong>' + renderInlines(nd.children) + '</strong>'; break;
      case 'link':
        out += '<a href="' + escapeHtml(normalizeUrl(nd.dest)) + '"' +
          (nd.title !== null ? ' title="' + escapeHtml(nd.title) + '"' : '') + '>' +
          renderInlines(nd.children) + '</a>';
        break;
      case 'image':
        out += '<img src="' + escapeHtml(normalizeUrl(nd.dest)) + '" alt="' + escapeHtml(plainText(nd.children)) + '"' +
          (nd.title !== null ? ' title="' + escapeHtml(nd.title) + '"' : '') + ' />';
        break;
    }
  }
  return out;
}

function plainText(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.type === 'text' || nd.type === 'code') out += nd.value;
    else if (nd.type === 'softbreak' || nd.type === 'hardbreak') out += '\n';
    else if (nd.children) out += plainText(nd.children);
  }
  return out;
}

function inline(text) {
  return renderInlines(parseInlines(text));
}

// ---------------------------------------------------------------- block parsing

function expandTabs(line, startCol = 0) {
  // Expand tabs in leading whitespace to spaces (tab stop 4), starting at column startCol.
  let out = '';
  let col = startCol;
  let i = 0;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === ' ') { out += ' '; col++; }
    else if (c === '\t') { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; }
    else break;
  }
  return out + line.slice(i);
}

const isBlank = l => /^[ \t]*$/.test(l);
const indentOf = l => /^ */.exec(l)[0].length;
const THEMATIC = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/;
const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;

function listMarker(line) {
  const m0 = /^( {0,3})([-+*]|\d{1,9}[.)])(.*)$/.exec(line);
  if (!m0) return null;
  const [, ind, marker] = m0;
  const after = expandTabs(m0[3], ind.length + marker.length);
  const sp = /^ */.exec(after)[0];
  const rest = after.slice(sp.length);
  if (sp.length === 0 && rest.length > 0) return null;
  const ordered = /\d/.test(marker[0]);
  const base = ind.length + marker.length;
  let contentIndent;
  let first;
  if (rest.length === 0) { contentIndent = base + 1; first = ''; }
  else if (sp.length >= 5) { contentIndent = base + 1; first = ' '.repeat(sp.length - 1) + rest; }
  else { contentIndent = base + sp.length; first = rest; }
  return {
    ordered,
    char: ordered ? marker[marker.length - 1] : marker,
    start: ordered ? parseInt(marker, 10) : null,
    contentIndent,
    first,
    empty: rest.length === 0,
  };
}

function fenceOpen(line) {
  const m = FENCE.exec(line);
  if (!m) return null;
  if (m[2][0] === '`' && m[3].includes('`')) return null;
  return { indent: m[1].length, char: m[2][0], len: m[2].length, info: m[3].trim() };
}

// Can this line interrupt a paragraph (i.e. start a new block)?
function interrupts(line) {
  if (THEMATIC.test(line) || ATX.test(line) || fenceOpen(line) || /^ {0,3}>/.test(line)) return true;
  const lm = listMarker(line);
  if (lm && !lm.empty && (!lm.ordered || lm.start === 1)) return true;
  return false;
}

// Is the last open block of `lines` (a container's content) a paragraph that can take a lazy line?
function endsInParagraph(lines) {
  if (lines.length === 0 || isBlank(lines[lines.length - 1])) return false;
  const blocks = parseBlocks(lines);
  let b = blocks[blocks.length - 1];
  while (b) {
    if (b.type === 'paragraph') return true;
    if (b.type === 'blockquote') { b = b.children[b.children.length - 1]; continue; }
    if (b.type === 'list') {
      const it = b.items[b.items.length - 1];
      b = it.children[it.children.length - 1];
      continue;
    }
    return false;
  }
  return false;
}

// Lazy continuation lines are tagged so they are never treated as setext underlines.
function lazy(l) {
  const o = new String(l);
  o.lazy = true;
  return o;
}

function endsOpenFence(blocks) {
  let b = blocks[blocks.length - 1];
  while (b) {
    if (b.type === 'code') return !!b.open;
    if (b.type === 'list') { const it = b.items[b.items.length - 1]; b = it.children[it.children.length - 1]; continue; }
    return false;
  }
  return false;
}

function parseBlocks(lines) {
  const blocks = [];
  let i = 0;
  let blankBefore = false;
  const push = b => { b.blankBefore = blankBefore; blankBefore = false; blocks.push(b); };

  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { blankBefore = true; i++; continue; }

    // Indented code
    if (indentOf(line) >= 4) {
      const buf = [];
      while (i < lines.length && (isBlank(lines[i]) || indentOf(lines[i]) >= 4)) {
        buf.push(lines[i].slice(Math.min(4, indentOf(lines[i]))));
        i++;
      }
      while (buf.length && isBlank(buf[buf.length - 1])) { buf.pop(); i--; }
      push({ type: 'code', info: '', text: buf.join('\n') + '\n' });
      continue;
    }

    // Fenced code
    const fo = fenceOpen(line);
    if (fo) {
      i++;
      const buf = [];
      const closeRe = new RegExp('^ {0,3}' + (fo.char === '`' ? '`' : '~') + '{' + fo.len + ',}[ \\t]*$');
      while (i < lines.length && !closeRe.test(lines[i])) {
        const l = lines[i];
        const strip = Math.min(fo.indent, indentOf(l));
        buf.push(l.slice(strip));
        i++;
      }
      const open = i >= lines.length;
      if (!open) i++;
      push({ type: 'code', info: unescapeString(fo.info), text: buf.length ? buf.join('\n') + '\n' : '', open });
      continue;
    }

    // Thematic break
    if (THEMATIC.test(line)) { push({ type: 'hr' }); i++; continue; }

    // ATX heading
    const am = ATX.exec(line);
    if (am) {
      let content = am[2].replace(/[ \t]+$/, '');
      if (/^#+$/.test(content)) content = '';
      else content = content.replace(/[ \t]+#+$/, '');
      push({ type: 'heading', level: am[1].length, text: content.trim() });
      i++;
      continue;
    }

    // Blockquote
    if (/^ {0,3}>/.test(line)) {
      const inner = [];
      while (i < lines.length) {
        const l = lines[i];
        const m = /^( {0,3})>(.*)$/.exec(l);
        if (m) {
          const r = expandTabs(m[2], m[1].length + 1);
          inner.push(r[0] === ' ' ? r.slice(1) : r);
          i++;
        } else if (!isBlank(l) && !interrupts(l) && !listMarker(l) && endsInParagraph(inner)) {
          inner.push(lazy(l));
          i++;
        } else break;
      }
      push({ type: 'blockquote', children: parseBlocks(inner) });
      continue;
    }

    // List
    const lm = listMarker(line);
    if (lm) {
      const list = { type: 'list', ordered: lm.ordered, start: lm.start, char: lm.char, items: [], loose: false };
      let cur = lm;
      while (cur) {
        const itemLines = [cur.first];
        i++;
        const ci = cur.contentIndent;
        while (i < lines.length) {
          const l = lines[i];
          if (isBlank(l)) {
            if (itemLines.length === 1 && itemLines[0] === '' && cur.empty) break;
            itemLines.push('');
            i++;
            continue;
          }
          if (l.lazy) { if (endsInParagraph(itemLines)) { itemLines.push(l); i++; continue; } break; }
          if (indentOf(l) >= ci) { itemLines.push(l.lazy ? lazy(l.slice(ci)) : l.slice(ci)); i++; continue; }
          if (!interrupts(l) && !listMarker(l) && endsInParagraph(itemLines)) { itemLines.push(lazy(l)); i++; continue; }
          break;
        }
        // Trailing blank lines are not part of the item
        let trailingBlank = false;
        if (!endsOpenFence(parseBlocks(itemLines))) while (itemLines.length > 1 && isBlank(itemLines[itemLines.length - 1])) { itemLines.pop(); i--; trailingBlank = true; }
        const children = parseBlocks(itemLines);
        if (children.slice(1).some(b => b.blankBefore)) list.loose = true;
        list.items.push({ children });
        // skip blanks, see if next item continues
        let j = i;
        while (j < lines.length && isBlank(lines[j])) j++;
        const nl = j < lines.length ? lines[j] : null;
        const next = nl !== null && !THEMATIC.test(nl) ? listMarker(nl) : null;
        if (next && next.ordered === list.ordered && next.char === list.char) {
          if (j > i || trailingBlank) list.loose = true;
          i = j;
          cur = next;
        } else cur = null;
      }
      push(list);
      continue;
    }

    // Paragraph (possibly setext heading)
    const buf = [line];
    i++;
    let setext = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (isBlank(l)) break;
      const sm = SETEXT.exec(l);
      if (sm && !l.lazy) { setext = sm[1][0] === '=' ? 1 : 2; i++; break; }
      if (!l.lazy && interrupts(l)) break;
      buf.push(l);
      i++;
    }
    const text = buf.map(l => l.replace(/^[ \t]+/, '')).join('\n').replace(/[ \t]+$/, '');
    if (setext) push({ type: 'heading', level: setext, text });
    else push({ type: 'paragraph', text });
  }
  return blocks;
}

function renderBlocks(blocks, tight = false) {
  let out = '';
  for (const b of blocks) {
    switch (b.type) {
      case 'paragraph':
        out += tight ? inline(b.text) : '<p>' + inline(b.text) + '</p>\n';
        break;
      case 'heading':
        out += `<h${b.level}>` + inline(b.text) + `</h${b.level}>\n`;
        break;
      case 'hr':
        out += '<hr />\n';
        break;
      case 'code': {
        const lang = b.info.split(/[ \t]+/)[0];
        out += '<pre><code' + (lang ? ' class="language-' + escapeHtml(lang) + '"' : '') + '>' + escapeHtml(b.text) + '</code></pre>\n';
        break;
      }
      case 'blockquote':
        out += '<blockquote>\n' + renderBlocks(b.children) + '</blockquote>\n';
        break;
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        const start = b.ordered && b.start !== 1 ? ` start="${b.start}"` : '';
        out += `<${tag}${start}>\n`;
        for (const it of b.items) {
          let inner = '';
          const ch = it.children;
          for (let k = 0; k < ch.length; k++) {
            const c = ch[k];
            if (!b.loose && c.type === 'paragraph') {
              inner += inline(c.text);
              if (k < ch.length - 1) inner += '\n';
            } else {
              if (k === 0) inner += '\n';
              inner += renderBlocks([c]);
            }
          }
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
  const src = String(markdown ?? '').replace(/\r\n?/g, '\n').replace(/\0/g, '\ufffd');
  const lines = src.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return renderBlocks(parseBlocks(lines.map(l => expandTabs(l))));
}

export default render;
