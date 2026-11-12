// markdown-s1: minimal CommonMark-subset renderer (written from scratch; no reuse found).
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const PUNCT = /[!-\/:-@\[-`{-~\p{P}\p{S}]/u;
const ESCAPABLE = /[!-\/:-@\[-`{-~]/;

function decodeEntities(s) {
  return s.replace(/&(?:#[xX]([0-9a-fA-F]{1,6})|#(\d{1,7})|(amp|lt|gt|quot|apos|nbsp|copy|reg));/g, (m, h, d, n) => {
    if (n) return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®' }[n];
    let c = h ? parseInt(h, 16) : parseInt(d, 10);
    if (!c || c > 0x10ffff || (c >= 0xd800 && c < 0xe000)) c = 0xfffd;
    return String.fromCodePoint(c);
  });
}
const unescapeStr = s => decodeEntities(s.replace(/\\([!-\/:-@\[-`{-~])/g, '$1'));
function encodeUrl(u) {
  return esc(encodeURI(u).replace(/%25([0-9a-fA-F]{2})/g, '%$1').replace(/%5B/g, '%5B'));
}

// ---------- inline ----------
function parseDest(s, i) {
  while (/[ \t\n]/.test(s[i] || '')) i++;
  let dest = '';
  if (s[i] === '<') {
    let j = i + 1;
    while (j < s.length && s[j] !== '>' && s[j] !== '\n' && s[j] !== '<') { if (s[j] === '\\') j++; j++; }
    if (s[j] !== '>') return null;
    dest = s.slice(i + 1, j); i = j + 1;
  } else {
    let j = i, depth = 0;
    while (j < s.length) {
      const c = s[j];
      if (c === '\\' && j + 1 < s.length) { j += 2; continue; }
      if (c === '(') depth++;
      else if (c === ')') { if (depth === 0) break; depth--; }
      else if (/[ \t\n]/.test(c) || c.charCodeAt(0) < 32) break;
      j++;
    }
    if (depth !== 0) return null;
    dest = s.slice(i, j); i = j;
  }
  return { dest, i };
}
function parseInlineLink(s, i) { // s[i] === '('
  const d = parseDest(s, i + 1);
  if (!d) return null;
  let j = d.i, title = null;
  const ws = j;
  while (/[ \t\n]/.test(s[j] || '')) j++;
  if (j > ws && /["'(]/.test(s[j] || '')) {
    const open = s[j], close = open === '(' ? ')' : open;
    let k = j + 1;
    while (k < s.length && s[k] !== close) { if (s[k] === '\\') k++; k++; }
    if (k >= s.length) return null;
    title = s.slice(j + 1, k); j = k + 1;
    while (/[ \t\n]/.test(s[j] || '')) j++;
  }
  if (s[j] !== ')') return null;
  return { dest: d.dest, title, end: j + 1 };
}

function processEmphasis(nodes, bottom) {
  const openersBottom = {};
  let ci = bottom + 1;
  while (ci < nodes.length) {
    const c = nodes[ci];
    if (c.t !== 'delim' || !c.canClose || c.n === 0) { ci++; continue; }
    const key = c.ch + (c.canOpen ? 1 : 0) + (c.orig % 3);
    let oi = ci - 1, found = -1;
    const lim = Math.max(bottom, openersBottom[key] ?? bottom);
    for (; oi > lim; oi--) {
      const o = nodes[oi];
      if (o.t === 'delim' && o.ch === c.ch && o.canOpen && o.n > 0) {
        if ((o.canClose || c.canOpen) && (o.orig + c.orig) % 3 === 0 && !(o.orig % 3 === 0 && c.orig % 3 === 0)) continue;
        found = oi; break;
      }
    }
    if (found < 0) {
      openersBottom[key] = ci - 1;
      if (!c.canOpen) c.t = 'text', c.v = c.ch.repeat(c.n);
      ci++; continue;
    }
    const o = nodes[found];
    const strong = o.n >= 2 && c.n >= 2;
    const use = strong ? 2 : 1;
    o.n -= use; c.n -= use;
    const inner = nodes.slice(found + 1, ci);
    for (let k = found + 1; k < ci; k++) if (nodes[k].t === 'delim') { nodes[k].t = 'text'; nodes[k].v = nodes[k].ch.repeat(nodes[k].n); }
    const rep = [{ t: 'raw', v: strong ? '<strong>' : '<em>' }, ...inner, { t: 'raw', v: strong ? '</strong>' : '</em>' }];
    nodes.splice(found + 1, ci - found - 1, ...rep);
    ci = found + 1 + rep.length;
    // c now at ci
  }
  for (let k = bottom + 1; k < nodes.length; k++) if (nodes[k].t === 'delim') { nodes[k].t = 'text'; nodes[k].v = nodes[k].ch.repeat(nodes[k].n); }
}

function inline(s) {
  const nodes = [];
  const brackets = []; // {idx, image, active}
  let buf = '';
  const flush = () => { if (buf) { nodes.push({ t: 'text', v: buf }); buf = ''; } };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      if (s[i + 1] === '\n') { flush(); nodes.push({ t: 'raw', v: '<br />\n' }); i += 2; while (s[i] === ' ') i++; continue; }
      if (i + 1 < s.length && ESCAPABLE.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
      buf += c; i++; continue;
    }
    if (c === '`') {
      let j = i; while (s[j] === '`') j++;
      const len = j - i;
      let k = j, end = -1;
      while (k < s.length) {
        if (s[k] === '`') { let m = k; while (s[m] === '`') m++; if (m - k === len) { end = k; break; } k = m; } else k++;
      }
      if (end < 0) { buf += s.slice(i, j); i = j; continue; }
      let code = s.slice(j, end).replace(/\n/g, ' ');
      if (code.length > 2 && code[0] === ' ' && code.at(-1) === ' ' && /[^ ]/.test(code)) code = code.slice(1, -1);
      flush(); nodes.push({ t: 'raw', v: '<code>' + esc(code) + '</code>' });
      i = end + len; continue;
    }
    if (c === '*' || c === '_') {
      let j = i; while (s[j] === c) j++;
      const before = i === 0 ? '\n' : s[i - 1], after = j >= s.length ? '\n' : s[j];
      const ws1 = /\s/.test(before) || before === ' ', ws2 = /\s/.test(after) || after === ' ';
      const p1 = PUNCT.test(before), p2 = PUNCT.test(after);
      const lf = !ws2 && (!p2 || ws1 || p1), rf = !ws1 && (!p1 || ws2 || p2);
      const canOpen = c === '*' ? lf : lf && (!rf || p1);
      const canClose = c === '*' ? rf : rf && (!lf || p2);
      flush(); nodes.push({ t: 'delim', ch: c, n: j - i, orig: j - i, canOpen, canClose });
      i = j; continue;
    }
    if (c === '[' || (c === '!' && s[i + 1] === '[')) {
      const image = c === '!';
      flush(); nodes.push({ t: 'text', v: image ? '![' : '[' });
      brackets.push({ idx: nodes.length - 1, image, active: true, pos: i + (image ? 2 : 1) });
      i += image ? 2 : 1; continue;
    }
    if (c === ']') {
      const op = brackets.pop();
      if (!op || !op.active) { buf += c; i++; continue; }
      if (s[i + 1] === '(') {
        const l = parseInlineLink(s, i + 1);
        if (l) {
          flush();
          const inner = nodes.splice(op.idx + 1);
          nodes.length = op.idx;
          const tmp = [{ t: 'bottom' }, ...inner];
          processEmphasis(tmp, 0);
          const body = tmp.slice(1);
          const url = encodeUrl(unescapeStr(l.dest));
          const title = l.title != null ? ' title="' + esc(unescapeStr(l.title)) + '"' : '';
          if (op.image) {
            const alt = body.map(n => n.t === 'raw' ? n.v.replace(/<[^>]*>/g, '') : n.t === 'img' ? n.alt : esc(n.v || '')).join('');
            nodes.push({ t: 'img', alt, v: '<img src="' + url + '" alt="' + alt + '"' + title + ' />' });
          } else {
            nodes.push({ t: 'raw', v: '<a href="' + url + '"' + title + '>' }, ...body, { t: 'raw', v: '</a>' });
            for (const b of brackets) if (!b.image) b.active = false;
          }
          i = l.end; continue;
        }
      }
      buf += c; i++; continue;
    }
    if (c === '\n') {
      const m = buf.match(/ *$/)[0].length;
      buf = buf.slice(0, buf.length - m);
      flush();
      nodes.push({ t: 'raw', v: m >= 2 ? '<br />\n' : '\n' });
      i++; while (s[i] === ' ' || s[i] === '\t') i++;
      continue;
    }
    if (c === '&') {
      const m = s.slice(i).match(/^&(?:#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos|nbsp|copy|reg);/);
      if (m) { buf += decodeEntities(m[0]); i += m[0].length; continue; }
    }
    buf += c; i++;
  }
  flush();
  processEmphasis([{ t: 'bottom' }, ...nodes].length ? (nodes.unshift({ t: 'bottom' }), nodes) : nodes, 0);
  return nodes.slice(1).map(n => n.t === 'text' ? esc(n.v) : n.v).join('');
}

// ---------- blocks ----------
const isBlank = l => /^[ \t]*$/.test(l);
const isHr = l => /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/.test(l);
const atx = l => l.match(/^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/);
const fenceOpen = l => l.match(/^( {0,3})(`{3,}|~{3,})[ \t]*(.*)$/);
const listMarker = l => {
  const m = l.match(/^( {0,3})([-*+]|\d{1,9}[.)])( +|\t|$)/);
  if (!m) return null;
  const rest = l.slice(m[0].length);
  let sp = m[3].length;
  if (m[3] === '\t') sp = 1;
  let pad = sp;
  if (rest.trim() === '') pad = 1; else if (sp > 4) pad = 1;
  const bullet = /^[-*+]/.test(m[2]);
  return { indent: m[1].length + m[2].length + pad, ch: bullet ? m[2] : m[2].slice(-1), bullet, num: bullet ? 0 : parseInt(m[2], 10), empty: rest.trim() === '', rest: rest.slice(Math.max(0, 0)), mlen: m[0].length - (sp - pad) };
};
const startsBlock = l => atx(l) || fenceOpen(l) || isHr(l) || /^ {0,3}>/.test(l) ||
  (() => { const m = listMarker(l); return m && !m.empty && (!/^\d/.test(l.trim()) || m.num === 1); })();

function parseBlocks(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    let l = lines[i];
    if (isBlank(l)) { i++; continue; }
    let m;
    if ((m = fenceOpen(l)) && !(m[2][0] === '`' && m[3].includes('`'))) {
      const ind = m[1].length, f = m[2], info = m[3].trim();
      const body = []; i++;
      const closeRe = new RegExp('^ {0,3}' + (f[0] === '`' ? '`' : '~') + '{' + f.length + ',}[ \\t]*$');
      while (i < lines.length && !closeRe.test(lines[i])) {
        body.push(lines[i].replace(new RegExp('^ {0,' + ind + '}'), '')); i++;
      }
      i++;
      out.push({ type: 'code', lang: info ? unescapeStr(info.split(/\s+/)[0]) : '', text: body.length ? body.join('\n') + '\n' : '' });
      continue;
    }
    if ((m = atx(l))) {
      out.push({ type: 'h', level: m[1].length, text: m[2].replace(/[ \t]+#+[ \t]*$/, '').replace(/^#+[ \t]*$/, '').trim() });
      i++; continue;
    }
    if (isHr(l)) { out.push({ type: 'hr' }); i++; continue; }
    if (/^ {4}/.test(l)) {
      const body = [];
      while (i < lines.length && (/^ {4}/.test(lines[i]) || isBlank(lines[i]))) { body.push(lines[i].replace(/^ {0,4}/, '')); i++; }
      while (body.length && isBlank(body.at(-1))) body.pop();
      out.push({ type: 'code', lang: '', text: body.join('\n') + '\n' });
      continue;
    }
    if (/^ {0,3}>/.test(l)) {
      const inner = [];
      while (i < lines.length) {
        const x = lines[i];
        if (/^ {0,3}>/.test(x)) inner.push(x.replace(/^ {0,3}> ?/, ''));
        else if (!isBlank(x) && inner.length && !isBlank(inner.at(-1)) && !startsBlock(x) && lastIsParagraph(inner)) inner.push(x);
        else break;
        i++;
      }
      out.push({ type: 'bq', children: parseBlocks(inner) });
      continue;
    }
    if ((m = listMarker(l)) && !(m.num !== 1 && false)) {
      const items = []; let loose = false, sawBlankBetween = false;
      const first = m;
      while (i < lines.length) {
        const mk = listMarker(lines[i]);
        if (!mk || isHr(lines[i]) || mk.bullet !== first.bullet || mk.ch !== first.ch) break;
        const body = [lines[i].slice(mk.mlen)];
        const ind = mk.indent;
        i++;
        let blankPending = 0, itemLoose = false;
        while (i < lines.length) {
          const x = lines[i];
          if (isBlank(x)) { blankPending++; body.push(''); i++; continue; }
          const sp = x.match(/^ */)[0].length;
          if (sp >= ind) { if (blankPending && body.length > blankPending + 0 && !inFence(body)) itemLoose = itemLoose || blankPending > 0 && body.length > blankPending; blankPending = 0; body.push(x.slice(ind)); i++; continue; }
          if (!blankPending && !listMarker(x) && !startsBlock(x) && lastIsParagraph(body)) { body.push(x.trimStart()); i++; continue; }
          break;
        }
        const trailing = blankPending;
        while (body.length && isBlank(body.at(-1))) body.pop();
        if (mk.empty && body.length && isBlank(body[0])) body.shift();
        items.push(parseBlocks(body));
        if (itemLoose) loose = true;
        { const nm = i < lines.length && listMarker(lines[i]); if (trailing && nm && !isHr(lines[i]) && nm.bullet === first.bullet && nm.ch === first.ch) sawBlankBetween = true; }
      }
      out.push({ type: 'list', bullet: first.bullet, start: first.num, items, loose: loose || sawBlankBetween });
      continue;
    }
    // paragraph (with setext)
    const para = [l]; i++;
    let setext = 0;
    while (i < lines.length) {
      const x = lines[i];
      if (isBlank(x)) break;
      if (/^ {0,3}=+[ \t]*$/.test(x)) { setext = 1; i++; break; }
      if (/^ {0,3}-+[ \t]*$/.test(x)) { setext = 2; i++; break; }
      if (startsBlock(x)) break;
      para.push(x); i++;
    }
    const text = para.map(p => p.trim()).join('\n');
    out.push(setext ? { type: 'h', level: setext, text } : { type: 'p', text });
  }
  return out;
}
function inFence(body) { let f = false; for (const l of body) if (/^ {0,3}(```|~~~)/.test(l)) f = !f; return f; }
function lastIsParagraph(lines) {
  let k = lines.length - 1;
  if (k < 0 || isBlank(lines[k])) return false;
  return !(fenceOpen(lines[k]) || atx(lines[k]) || isHr(lines[k]) || /^ {4}/.test(lines[k]) && false) && !inFence(lines);
}

function renderBlocks(blocks, tight) {
  let h = '';
  for (const b of blocks) {
    switch (b.type) {
      case 'p': h += tight ? inline(b.text) + '\n' : '<p>' + inline(b.text) + '</p>\n'; break;
      case 'h': h += `<h${b.level}>${inline(b.text)}</h${b.level}>\n`; break;
      case 'hr': h += '<hr />\n'; break;
      case 'code': h += '<pre><code' + (b.lang ? ` class="language-${esc(b.lang)}"` : '') + '>' + esc(b.text) + '</code></pre>\n'; break;
      case 'bq': h += '<blockquote>\n' + renderBlocks(b.children) + '</blockquote>\n'; break;
      case 'list': {
        const tag = b.bullet ? 'ul' : 'ol';
        h += `<${tag}${!b.bullet && b.start !== 1 ? ` start="${b.start}"` : ''}>\n`;
        for (const it of b.items) {
          let inner = renderBlocks(it, !b.loose);
          if (!b.loose && it.length && it[0].type === 'p') h += '<li>' + inner.replace(/\n$/, '') + '</li>\n';
          else h += '<li>' + (inner ? '\n' + inner : '') + '</li>\n';
        }
        h += `</${tag}>\n`; break;
      }
    }
  }
  return h;
}

export function render(markdown) {
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n').map(l => l.replace(/^( *)\t/, (m, s) => s + '    '));
  return renderBlocks(parseBlocks(lines));
}
