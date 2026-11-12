// markdown-s2: safe Markdown -> HTML renderer (CommonMark-like + GFM tables/strikethrough).
// Written from scratch (no reusable single-file candidate found); zero dependencies.

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', bull: '•', middot: '·', times: '×', divide: '÷', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', deg: '°', plusmn: '±', para: '¶', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', eacute: 'é', egrave: 'è', agrave: 'à', aacute: 'á', ccedil: 'ç', ntilde: 'ñ', hearts: '♥', larr: '←', rarr: '→', uarr: '↑', darr: '↓', ne: '≠', le: '≤', ge: '≥', infin: '∞', Dcaron: 'Ď', HilbertSpace: 'ℋ', DifferentialD: 'ⅆ', ClockwiseContourIntegral: '∲', ngE: '≧̸' };

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function decodeEntities(s) {
  return s.replace(/&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
      return String.fromCodePoint(cp);
    }
    return Object.prototype.hasOwnProperty.call(ENT, e) ? ENT[e] : m;
  });
}
const unescapeBs = s => s.replace(/\\([!-\/:-@\[-`{-~])/g, '$1');

function normUrl(u) {
  u = decodeEntities(unescapeBs(u));
  const t = u.replace(/[\u0000- \u007f-\u009f]/g, '').toLowerCase();
  if (/^(javascript|vbscript|file|data):/.test(t) && !/^data:image\/(png|gif|jpeg|webp);/.test(t)) return '#';
  u = u.replace(/%(?![0-9a-fA-F]{2})|[^A-Za-z0-9\-_.!~*'();\/?:@&=+$,#%]/gu, ch => {
    if (ch === '%') return '%25';
    try { return encodeURIComponent(ch); } catch { return '%EF%BF%BD'; }
  });
  return esc(u);
}
const normLabel = s => s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase();

export function slugify(text, seen) {
  const s = String(text).toLowerCase().replace(/[^\p{L}\p{N} \-_]/gu, '').replace(/ /g, '-');
  if (!seen) return s;
  if (!seen.has(s)) { seen.set(s, 0); return s; }
  let c = seen.get(s), cand;
  do { c++; cand = `${s}-${c}`; } while (seen.has(cand));
  seen.set(s, c); seen.set(cand, 0);
  return cand;
}

/* ------------------------------- inline ------------------------------- */
const PUNCT = /[\p{P}\p{S}]/u, WS = /\s/u;

function linkTail(src, p) {
  if (src[p] !== '(') return null;
  let i = p + 1;
  const ws = () => { while (i < src.length && /[ \t\n]/.test(src[i])) i++; };
  ws();
  let dest = '';
  if (src[i] === '<') {
    i++;
    while (i < src.length && src[i] !== '>') {
      if (src[i] === '\n' || src[i] === '<') return null;
      if (src[i] === '\\' && i + 1 < src.length) { dest += src[i] + src[i + 1]; i += 2; continue; }
      dest += src[i++];
    }
    if (src[i] !== '>') return null;
    i++;
  } else {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\' && i + 1 < src.length && /[!-\/:-@\[-`{-~]/.test(src[i + 1])) { dest += c + src[i + 1]; i += 2; continue; }
      if (c === '(') depth++;
      else if (c === ')') { if (depth === 0) break; depth--; }
      else if (/[\s\u0000-\u001f]/.test(c)) break;
      dest += c; i++;
    }
    if (depth !== 0) return null;
  }
  const before = i;
  ws();
  let title = null;
  if (i > before && /["'(]/.test(src[i] || '')) {
    const close = src[i] === '(' ? ')' : src[i];
    let j = i + 1, t = '';
    while (j < src.length && src[j] !== close) {
      if (src[j] === '\\' && j + 1 < src.length) { t += src[j] + src[j + 1]; j += 2; continue; }
      if (close === ')' && src[j] === '(') return null;
      t += src[j++];
    }
    if (src[j] !== close) return null;
    title = t; i = j + 1; ws();
  }
  if (src[i] !== ')') return null;
  return { url: dest, title, end: i + 1 };
}

function renderTokens(tokens) {
  const ds = [];
  tokens.forEach((t, i) => { if (t.k === 'd') ds.push(i); });
  for (let a = 0; a < ds.length; a++) {
    const cl = tokens[ds[a]];
    if (!cl.close || cl.dead) continue;
    while (cl.n > 0) {
      let o = null;
      for (let b = a - 1; b >= 0; b--) {
        const c = tokens[ds[b]];
        if (c.dead || c.ch !== cl.ch || !c.open || c.n === 0) continue;
        if (cl.ch === '~') { if (c.n !== cl.n) continue; }
        else if ((c.close || cl.open) && (c.o + cl.o) % 3 === 0 && !(c.o % 3 === 0 && cl.o % 3 === 0)) continue;
        o = c;
        for (let m = b + 1; m < a; m++) tokens[ds[m]].dead = true;
        break;
      }
      if (!o) break;
      const use = cl.ch === '~' ? cl.n : (o.n >= 2 && cl.n >= 2 ? 2 : 1);
      o.n -= use; cl.n -= use;
      const tag = cl.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em';
      o.ot = `<${tag}>` + o.ot;
      cl.ct += `</${tag}>`;
    }
  }
  let html = '', plain = '';
  for (const t of tokens) {
    if (t.k === 't') { html += esc(t.v); plain += t.v; }
    else if (t.k === 'r') { html += t.h; plain += t.p; }
    else { const lit = t.ch.repeat(t.n); html += t.ct + lit + t.ot; plain += lit; }
  }
  return { html, plain };
}

function inline(src, refs) {
  const toks = [], brackets = [];
  let buf = '', i = 0;
  const n = src.length;
  const flush = () => { if (buf) { toks.push({ k: 't', v: buf }); buf = ''; } };
  while (i < n) {
    const c = src[i];
    if (c === '\\') {
      const d = src[i + 1];
      if (d === '\n') { flush(); toks.push({ k: 'r', h: '<br />\n', p: '\n' }); i += 2; while (src[i] === ' ') i++; continue; }
      if (d && /[!-\/:-@\[-`{-~]/.test(d)) { buf += d; i += 2; continue; }
      buf += c; i++; continue;
    }
    if (c === '`') {
      let j = i; while (src[j] === '`') j++;
      const len = j - i;
      let k = j, found = -1;
      while (true) {
        const idx = src.indexOf('`', k);
        if (idx < 0) break;
        let e = idx; while (src[e] === '`') e++;
        if (e - idx === len) { found = idx; break; }
        k = e;
      }
      if (found < 0) { buf += src.slice(i, j); i = j; continue; }
      let code = src.slice(j, found).replace(/\n/g, ' ');
      if (code.length > 2 && code[0] === ' ' && code[code.length - 1] === ' ' && /[^ ]/.test(code)) code = code.slice(1, -1);
      flush();
      toks.push({ k: 'r', h: `<code>${esc(code)}</code>`, p: code });
      i = found + len; continue;
    }
    if (c === '&') {
      const m = /^&(?:#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/.exec(src.slice(i, i + 40));
      if (m) { buf += decodeEntities(m[0]); i += m[0].length; continue; }
      buf += c; i++; continue;
    }
    if (c === '<') {
      const rest = src.slice(i);
      let m = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/.exec(rest);
      if (m) { flush(); toks.push({ k: 'r', h: `<a href="${normUrl(m[1])}">${esc(m[1])}</a>`, p: m[1] }); i += m[0].length; continue; }
      m = /^<([a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/.exec(rest);
      if (m) { flush(); toks.push({ k: 'r', h: `<a href="mailto:${normUrl(m[1])}">${esc(m[1])}</a>`, p: m[1] }); i += m[0].length; continue; }
      buf += c; i++; continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      let j = i; while (src[j] === c) j++;
      const cnt = j - i;
      if (c === '~' && cnt > 2) { buf += src.slice(i, j); i = j; continue; }
      const prev = i > 0 ? src[i - 1] : ' ', next = j < n ? src[j] : ' ';
      const pw = WS.test(prev), nw = WS.test(next), pp = PUNCT.test(prev), np = PUNCT.test(next);
      const left = !nw && (!np || pw || pp), right = !pw && (!pp || nw || np);
      let open, close;
      if (c === '_') { open = left && (!right || pp); close = right && (!left || np); }
      else { open = left; close = right; }
      flush();
      toks.push({ k: 'd', ch: c, n: cnt, o: cnt, open, close, ot: '', ct: '', dead: false });
      i = j; continue;
    }
    if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      flush();
      const img = c === '!';
      toks.push({ k: 't', v: img ? '![' : '[' });
      brackets.push({ idx: toks.length - 1, img, pos: i + (img ? 2 : 1), active: true });
      i += img ? 2 : 1; continue;
    }
    if (c === ']') {
      flush();
      const op = brackets.pop();
      if (!op || !op.active) { buf += ']'; i++; continue; }
      let r = linkTail(src, i + 1);
      if (!r) {
        const m = /^\[((?:[^\[\]\\]|\\.)*)\]/s.exec(src.slice(i + 1));
        let lbl, end = i + 1, ok = true;
        if (m && m[1].trim()) { lbl = m[1]; end = i + 1 + m[0].length; }
        else { lbl = src.slice(op.pos, i); if (m) end = i + 1 + m[0].length; }
        const ref = ok && lbl.trim() ? refs.get(normLabel(lbl)) : null;
        if (ref) r = { url: ref.url, title: ref.title, end };
      }
      if (!r) { buf += ']'; i++; continue; }
      const inner = toks.splice(op.idx).slice(1);
      const { html, plain } = renderTokens(inner);
      const url = normUrl(r.url);
      const title = r.title != null ? ` title="${esc(decodeEntities(unescapeBs(r.title)))}"` : '';
      if (op.img) toks.push({ k: 'r', h: `<img src="${url}" alt="${esc(plain)}"${title} />`, p: plain });
      else {
        toks.push({ k: 'r', h: `<a href="${url}"${title}>${html}</a>`, p: plain });
        for (const b of brackets) if (!b.img) b.active = false;
      }
      i = r.end; continue;
    }
    if (c === '\n') {
      const t = buf.replace(/ +$/, '');
      const hard = buf.length - t.length >= 2;
      buf = t; flush();
      toks.push({ k: 'r', h: hard ? '<br />\n' : '\n', p: '\n' });
      i++; while (src[i] === ' ') i++;
      continue;
    }
    buf += c; i++;
  }
  flush();
  return renderTokens(toks);
}

/* -------------------------------- blocks ------------------------------- */
const isBlank = l => /^\s*$/.test(l);
const indentOf = l => /^ */.exec(l)[0].length;
const HR = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*(.*)$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;

function listMarker(l) {
  const m = /^( {0,3})([-*+]|\d{1,9}[.)])( *)(.*)$/.exec(l);
  if (!m) return null;
  if (m[3].length === 0 && m[4] !== '') return null;
  const marker = m[2], ordered = marker.length > 1 || /\d/.test(marker);
  const empty = m[4] === '';
  let W, first;
  if (empty) { W = m[1].length + marker.length + 1; first = ''; }
  else if (m[3].length >= 5) { W = m[1].length + marker.length + 1; first = ' '.repeat(m[3].length - 1) + m[4]; }
  else { W = m[1].length + marker.length + m[3].length; first = m[4]; }
  return { marker, ordered, type: ordered ? marker.slice(-1) : marker, start: ordered ? parseInt(marker, 10) : 1, W, first, empty };
}
function startsBlock(l) {
  if (FENCE.test(l) && !(l.trim()[0] === '`' && FENCE.exec(l)[3].includes('`'))) return true;
  if (ATX.test(l) || HR.test(l) || /^ {0,3}>/.test(l)) return true;
  const m = listMarker(l);
  if (m && !m.empty && (!m.ordered || m.start === 1)) return true;
  return false;
}
function splitRow(l) {
  l = l.trim();
  if (l.startsWith('|')) l = l.slice(1);
  if (l.endsWith('|') && !l.endsWith('\\|')) l = l.slice(0, -1);
  const cells = []; let cur = '';
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (c === '\\' && l[i + 1] === '|') { cur += '|'; i++; }
    else if (c === '\\' && i + 1 < l.length) { cur += c + l[i + 1]; i++; }
    else if (c === '|') { cells.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}
const DELIM_ROW = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

const REFDEF = /^ {0,3}\[((?:[^\[\]\\]|\\.)+)\]:[ \t]*\n?[ \t]*(<[^<>\n]*>|[^\s<]\S*)(?:(?:[ \t]+|[ \t]*\n[ \t]*)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\)))?[ \t]*(?:\n|$)/s;

function extractDefs(text, refs) {
  while (true) {
    const m = REFDEF.exec(text);
    if (!m || !m[1].trim()) break;
    let url = m[2];
    if (url[0] === '<') url = url.slice(1, -1);
    const key = normLabel(m[1]);
    if (!refs.has(key)) refs.set(key, { url, title: m[3] ? m[3].slice(1, -1) : null });
    text = text.slice(m[0].length);
  }
  return text;
}

function parseBlocks(lines, refs) {
  const nodes = [];
  let i = 0, gap = false;
  const n = lines.length;
  const add = node => { node.gap = gap; gap = false; nodes.push(node); };
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { gap = true; i++; continue; }
    const ind = indentOf(line);
    if (ind >= 4) {
      const buf = [];
      while (i < n && (isBlank(lines[i]) || indentOf(lines[i]) >= 4)) { buf.push(lines[i].slice(4)); i++; }
      while (buf.length && isBlank(buf[buf.length - 1])) { buf.pop(); }
      // blank lines consumed after code count as gap
      add({ t: 'code', lang: '', text: buf.map(l => (isBlank(l) && l.length < 0 ? '' : l)).join('\n') + '\n' });
      continue;
    }
    let m = FENCE.exec(line);
    if (m && !(m[2][0] === '`' && m[3].includes('`'))) {
      const fch = m[2][0], flen = m[2].length, fin = m[1].length;
      const info = m[3].trim();
      const body = []; i++;
      const closeRe = new RegExp(`^ {0,3}\\${fch}{${flen},}[ \\t]*$`);
      while (i < n && !closeRe.test(lines[i])) {
        let l = lines[i], k = 0;
        while (k < fin && l[k] === ' ') k++;
        body.push(l.slice(k)); i++;
      }
      i++;
      const word = decodeEntities(unescapeBs(info)).split(/\s+/)[0];
      add({ t: 'code', lang: word, text: body.length ? body.join('\n') + '\n' : '' });
      continue;
    }
    m = ATX.exec(line);
    if (m) {
      let text = (m[2] || '').replace(/(?:^|[ \t]+)#+[ \t]*$/, '').trim();
      add({ t: 'h', level: m[1].length, text });
      i++; continue;
    }
    if (HR.test(line)) { add({ t: 'hr' }); i++; continue; }
    if (/^ {0,3}>/.test(line)) {
      const inner = [];
      while (i < n) {
        const l = lines[i];
        const q = /^ {0,3}> ?/.exec(l);
        if (q) { inner.push(l.slice(q[0].length)); i++; continue; }
        if (isBlank(l)) break;
        const last = inner[inner.length - 1];
        if (last !== undefined && !isBlank(last) && !startsBlock(last) && indentOf(last) < 4 + 0 && !startsBlock(l)) { inner.push(l); i++; continue; }
        if (last !== undefined && !isBlank(last) && !FENCE.test(last) && !startsBlock(l) && !/^ {4}/.test(last)) { inner.push(l); i++; continue; }
        break;
      }
      add({ t: 'bq', kids: parseBlocks(inner, refs) });
      continue;
    }
    const lm = listMarker(line);
    if (lm) {
      const items = [];
      let loose = false, trailingGap = false;
      while (i < n) {
        const mk = listMarker(lines[i]);
        if (!mk || mk.type !== lm.type || HR.test(lines[i])) break;
        const W = mk.W;
        const il = [mk.first];
        i++;
        while (i < n) {
          const l = lines[i];
          if (isBlank(l)) {
            if (il.length === 1 && mk.empty) break;
            il.push(''); i++; continue;
          }
          if (indentOf(l) >= W) { il.push(l.slice(W)); i++; continue; }
          const prev = il[il.length - 1];
          if (prev !== '' && !startsBlock(l) && !listMarker(l) && !/^ {4}/.test(prev) && !FENCE.test(prev)) { il.push(l.replace(/^\s+/, '')); i++; continue; }
          break;
        }
        let tr = 0;
        while (il.length > 1 && il[il.length - 1] === '') { il.pop(); tr++; }
        if (il.length === 1 && il[0] === '' && tr) tr--;
        const kids = parseBlocks(il, refs);
        const nm = i < n ? listMarker(lines[i]) : null;
        const more = nm && nm.type === lm.type && !HR.test(lines[i]);
        if (tr && more) loose = true;
        trailingGap = tr > 0;
        if (kids.some((k, idx) => idx > 0 && k.gap)) loose = true;
        items.push({ kids });
        if (!more) break;
      }
      add({ t: 'list', ordered: lm.ordered, start: lm.start, items, loose });
      gap = trailingGap;
      continue;
    }
    // table
    if (line.includes('|') && i + 1 < n && DELIM_ROW.test(lines[i + 1]) && lines[i + 1].includes('-')) {
      const head = splitRow(line), dl = splitRow(lines[i + 1]);
      if (head.length === dl.length && (lines[i + 1].includes('|') || head.length > 0)) {
        const align = dl.map(c => (c[0] === ':' ? (c.endsWith(':') ? 'center' : 'left') : c.endsWith(':') ? 'right' : null));
        i += 2;
        const rows = [];
        while (i < n && !isBlank(lines[i]) && !startsBlock(lines[i])) {
          const r = splitRow(lines[i]);
          while (r.length < head.length) r.push('');
          rows.push(r.slice(0, head.length)); i++;
        }
        add({ t: 'table', align, head, rows });
        continue;
      }
    }
    // paragraph / setext
    const para = [line.replace(/^\s+/, '')];
    i++;
    let setext = 0;
    while (i < n) {
      const l = lines[i];
      if (isBlank(l)) break;
      const sm = /^ {0,3}(=+|-+)[ \t]*$/.exec(l);
      if (sm) { setext = sm[1][0] === '=' ? 1 : 2; i++; break; }
      if (indentOf(l) < 4 && startsBlock(l)) break;
      para.push(l.replace(/^\s+/, '')); i++;
    }
    let text = para.join('\n');
    if (setext) {
      const rest = extractDefs(text, refs);
      if (rest.trim() === '') { add({ t: 'p', text: text.replace(/[ \t]+$/, '') }); /* defs only: degenerate */ nodes.pop(); /* "===" becomes paragraph */ add({ t: 'p', text: lines[i - 1].trim() }); continue; }
      add({ t: 'h', level: setext, text: rest.trim() });
      continue;
    }
    text = extractDefs(text, refs);
    if (text.trim() === '') continue;
    add({ t: 'p', text: text.replace(/[ \t]+$/, '') });
  }
  return nodes;
}

/* -------------------------------- render ------------------------------- */
function renderNodes(nodes, ctx, tight = false) {
  const out = [];
  for (const nd of nodes) {
    switch (nd.t) {
      case 'p': { const h = inline(nd.text, ctx.refs).html; out.push(tight ? h : `<p>${h}</p>`); break; }
      case 'h': {
        const { html, plain } = inline(nd.text, ctx.refs);
        const id = ctx.ids ? ` id="${esc(slugify(plain, ctx.seen))}"` : '';
        out.push(`<h${nd.level}${id}>${html}</h${nd.level}>`); break;
      }
      case 'code': out.push(`<pre><code${nd.lang ? ` class="language-${esc(nd.lang)}"` : ''}>${esc(nd.text)}</code></pre>`); break;
      case 'hr': out.push('<hr />'); break;
      case 'bq': { const b = renderNodes(nd.kids, ctx); out.push(`<blockquote>\n${b ? b + '\n' : ''}</blockquote>`); break; }
      case 'list': {
        const tag = nd.ordered ? 'ol' : 'ul';
        const attr = nd.ordered && nd.start !== 1 ? ` start="${nd.start}"` : '';
        const lis = nd.items.map(it => {
          const parts = renderNodes(it.kids, ctx, !nd.loose);
          if (!it.kids.length) return '<li></li>';
          const firstP = !nd.loose && it.kids[0].t === 'p', lastP = !nd.loose && it.kids[it.kids.length - 1].t === 'p';
          return `<li>${firstP ? '' : '\n'}${parts}${lastP ? '' : '\n'}</li>`;
        });
        out.push(`<${tag}${attr}>\n${lis.join('\n')}\n</${tag}>`); break;
      }
      case 'table': {
        const cell = (tg, c, k) => `<${tg}${nd.align[k] ? ` align="${nd.align[k]}"` : ''}>${inline(c, ctx.refs).html}</${tg}>`;
        let h = `<table>\n<thead>\n<tr>\n${nd.head.map((c, k) => cell('th', c, k)).join('\n')}\n</tr>\n</thead>`;
        if (nd.rows.length) h += `\n<tbody>\n${nd.rows.map(r => `<tr>\n${r.map((c, k) => cell('td', c, k)).join('\n')}\n</tr>`).join('\n')}\n</tbody>`;
        out.push(h + '\n</table>'); break;
      }
    }
  }
  return out.join('\n');
}

function expandTabs(l) {
  if (!l.includes('\t')) return l;
  let col = 0, o = '';
  for (const ch of l) {
    if (ch === '\t') { const k = 4 - (col % 4); o += ' '.repeat(k); col += k; }
    else { o += ch; col++; }
  }
  return o;
}
function parse(md) {
  const refs = new Map();
  const lines = String(md).replace(/\r\n?/g, '\n').split('\n').map(l => { const m = /^[ \t]*/.exec(l)[0]; return m.includes('\t') ? expandTabs(m) + l.slice(m.length) : l; });
  return { nodes: parseBlocks(lines, refs), refs };
}

export function render(markdown, { headingIds = false } = {}) {
  const { nodes, refs } = parse(markdown);
  const html = renderNodes(nodes, { refs, ids: headingIds, seen: new Map() });
  return html ? html + '\n' : '';
}

export function toc(markdown) {
  const { nodes, refs } = parse(markdown);
  const seen = new Map(), out = [];
  const walk = ns => {
    for (const nd of ns) {
      if (nd.t === 'h') { const { plain } = inline(nd.text, refs); out.push({ level: nd.level, text: plain, slug: slugify(plain, seen) }); }
      else if (nd.t === 'bq') walk(nd.kids);
      else if (nd.t === 'list') nd.items.forEach(it => walk(it.kids));
    }
  };
  walk(nodes);
  return out;
}
