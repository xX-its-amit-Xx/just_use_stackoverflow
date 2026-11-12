const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', hellip: '…', mdash: '—', ndash: '–' };
const PUNCT = /[!-\/:-@\[-`{-~\p{P}\p{S}]/u;
const ESCAPABLE = /[!-\/:-@\[-`{-~]/;

function encodeUrl(u) {
  return u.replace(/[^\w\-.~!*'();:@&=+$,\/?#\[\]%]/g, c => encodeURIComponent(c)).replace(/%(?![0-9a-fA-F]{2})/g, '%25');
}
function unescapeStr(s) {
  return s.replace(/\\([!-\/:-@\[-`{-~])|&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]*));/g, (m, a, d, h, n) => {
    if (a) return a;
    if (d || h) { const cp = d ? +d : parseInt(h, 16); try { return cp ? String.fromCodePoint(cp) : '�'; } catch { return '�'; } }
    return ENT[n] !== undefined ? ENT[n] : m;
  });
}

function parseLinkTail(s, i) {
  // s[i] === '(' ; returns {url,title,end} or null
  let p = i + 1;
  const ws = () => { while (p < s.length && /[ \t\n]/.test(s[p])) p++; };
  ws();
  let url = '';
  if (s[p] === '<') {
    p++; const st = p;
    while (p < s.length && s[p] !== '>' && s[p] !== '<' && s[p] !== '\n') { if (s[p] === '\\') p++; p++; }
    if (s[p] !== '>') return null;
    url = s.slice(st, p); p++;
  } else {
    const st = p; let depth = 0;
    while (p < s.length) {
      const c = s[p];
      if (c === '\\' && ESCAPABLE.test(s[p + 1] || '')) { p += 2; continue; }
      if (/[\s\x00-\x1f]/.test(c)) break;
      if (c === '(') depth++;
      else if (c === ')') { if (depth === 0) break; depth--; }
      p++;
    }
    if (depth !== 0) return null;
    url = s.slice(st, p);
  }
  const before = p; ws();
  let title = null;
  if (p > before && /["'(]/.test(s[p])) {
    const open = s[p], close = open === '(' ? ')' : open;
    let q = p + 1; const st = q;
    while (q < s.length && s[q] !== close) { if (s[q] === '\\') q++; q++; }
    if (q >= s.length) return null;
    title = s.slice(st, q); p = q + 1; ws();
  }
  if (s[p] !== ')') return null;
  return { url, title, end: p + 1 };
}

function inline(s) {
  const nodes = [];
  const brackets = [];
  let i = 0, buf = '';
  const flush = () => { if (buf) { nodes.push({ t: 'text', s: esc(buf) }); buf = ''; } };

  function emphasis(from) {
    const ds = [];
    for (let k = from; k < nodes.length; k++) if (nodes[k].t === 'delim') ds.push(nodes[k]);
    for (let ci = 0; ci < ds.length; ci++) {
      const c = ds[ci];
      if (!c.canClose || c.n === 0) continue;
      while (c.n > 0) {
        let oi = -1;
        for (let j = ci - 1; j >= 0; j--) {
          const o = ds[j];
          if (o.ch !== c.ch || !o.canOpen || o.n === 0) continue;
          if ((o.canClose || c.canOpen) && (o.orig + c.orig) % 3 === 0 && !(o.orig % 3 === 0 && c.orig % 3 === 0)) continue;
          oi = j; break;
        }
        if (oi < 0) break;
        const o = ds[oi];
        const strong = o.n >= 2 && c.n >= 2;
        const use = strong ? 2 : 1;
        o.n -= use; c.n -= use;
        o.open = (strong ? '<strong>' : '<em>') + o.open;
        c.close = c.close + (strong ? '</strong>' : '</em>');
        for (let j = oi + 1; j < ci; j++) { ds[j].n = 0; ds[j].canOpen = ds[j].canClose = false; }
      }
    }
    for (let k = from; k < nodes.length; k++) {
      const d = nodes[k];
      if (d.t === 'delim') nodes[k] = { t: 'text', s: d.close + d.ch.repeat(d.n) + d.open };
    }
  }
  const textOf = (a) => a;

  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      if (s[i + 1] === '\n') { flush(); nodes.push({ t: 'text', s: '<br />\n' }); i += 2; while (s[i] === ' ') i++; continue; }
      if (ESCAPABLE.test(s[i + 1] || '')) { buf += s[i + 1]; i += 2; continue; }
      buf += c; i++; continue;
    }
    if (c === '`') {
      let n = 0; while (s[i + n] === '`') n++;
      let j = i + n, found = -1;
      while (j < s.length) {
        if (s[j] === '`') { let m = 0; while (s[j + m] === '`') m++; if (m === n) { found = j; break; } j += m; } else j++;
      }
      if (found < 0) { buf += '`'.repeat(n); i += n; continue; }
      let code = s.slice(i + n, found).replace(/\n/g, ' ');
      if (code.length > 2 && code[0] === ' ' && code[code.length - 1] === ' ' && /[^ ]/.test(code)) code = code.slice(1, -1);
      flush(); nodes.push({ t: 'text', s: '<code>' + esc(code) + '</code>' });
      i = found + n; continue;
    }
    if (c === '*' || c === '_') {
      let n = 0; while (s[i + n] === c) n++;
      const before = i === 0 ? ' ' : s[i - 1], after = i + n >= s.length ? ' ' : s[i + n];
      const wsA = /\s/.test(after), wsB = /\s/.test(before);
      const pA = PUNCT.test(after), pB = PUNCT.test(before);
      const lf = !wsA && (!pA || wsB || pB);
      const rf = !wsB && (!pB || wsA || pA);
      let canOpen, canClose;
      if (c === '*') { canOpen = lf; canClose = rf; }
      else { canOpen = lf && (!rf || pB); canClose = rf && (!lf || pA); }
      flush(); nodes.push({ t: 'delim', ch: c, n, orig: n, canOpen, canClose, open: '', close: '' });
      i += n; continue;
    }
    if (c === '!' && s[i + 1] === '[') {
      flush(); nodes.push({ t: 'text', s: '![' }); brackets.push({ idx: nodes.length - 1, img: true, pos: i + 2 }); i += 2; continue;
    }
    if (c === '[') {
      flush(); nodes.push({ t: 'text', s: '[' }); brackets.push({ idx: nodes.length - 1, img: false, pos: i + 1 }); i++; continue;
    }
    if (c === ']') {
      const b = brackets.pop();
      if (!b) { buf += ']'; i++; continue; }
      flush();
      const tail = s[i + 1] === '(' ? parseLinkTail(s, i + 1) : null;
      if (!tail) { nodes.push({ t: 'text', s: ']' }); i++; continue; }
      // remove earlier link openers (no nested links)
      emphasis(b.idx + 1);
      const inner = nodes.splice(b.idx + 1).map(x => x.s).join('');
      nodes.pop();
      const url = encodeUrl(unescapeStr(tail.url));
      const title = tail.title !== null ? ` title="${esc(unescapeStr(tail.title))}"` : '';
      if (b.img) {
        const alt = inner.replace(/<[^>]*>/g, '');
        nodes.push({ t: 'text', s: `<img src="${esc(url)}" alt="${alt}"${title} />` });
      } else {
        nodes.push({ t: 'text', s: `<a href="${esc(url)}"${title}>${inner}</a>` });
        for (const o of brackets) if (!o.img) o.dead = true;
      }
      i = tail.end; continue;
    }
    if (c === '\n') {
      const m = /( *)$/.exec(buf);
      const hard = m[1].length >= 2;
      buf = buf.slice(0, buf.length - m[1].length);
      flush(); nodes.push({ t: 'text', s: hard ? '<br />\n' : '\n' });
      i++; while (s[i] === ' ' || s[i] === '\t') i++; continue;
    }
    if (c === '&') {
      const m = /^&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]*);/.exec(s.slice(i, i + 40));
      if (m) { const d = unescapeStr(m[0]); if (d !== m[0]) { buf += d; i += m[0].length; continue; } }
    }
    buf += c; i++;
  }
  flush();
  emphasis(0);
  return nodes.map(x => x.s).join('');
}

const isBlank = l => /^\s*$/.test(l);
const reHr = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const reAtx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const reFence = /^( {0,3})(`{3,}|~{3,})\s*([^`]*?)\s*$/;
const reBullet = /^( {0,3})([-+*])( +|$)/;
const reOrdered = /^( {0,3})(\d{1,9})([.)])( +|$)/;

function listMarker(l) {
  let m = reBullet.exec(l);
  if (m) return { type: 'ul', ch: m[2], indent: m[1].length, w: m[0].length - m[1].length, len: m[0].length, rest: l.slice(m[0].length) };
  m = reOrdered.exec(l);
  if (m) return { type: 'ol', ch: m[3], num: +m[2], indent: m[1].length, w: m[0].length - m[1].length, len: m[0].length, rest: l.slice(m[0].length) };
  return null;
}

function blocks(lines, tight) {
  let out = '';
  let i = 0;
  let para = [];
  const flushPara = () => {
    if (para.length) {
      const t = inline(para.map(x => x.replace(/^[ \t]+/, '')).join('\n').replace(/[ \t]+$/, ''));
      out += tight ? t + '\n' : `<p>${t}</p>\n`;
      para = [];
    }
  };
  while (i < lines.length) {
    const l = lines[i];
    if (isBlank(l)) { flushPara(); i++; continue; }
    let m;
    if (/^ {4,}/.test(l) && !para.length) {
      const cl = [];
      while (i < lines.length && (isBlank(lines[i]) || /^ {4}/.test(lines[i]))) { cl.push(lines[i].slice(4)); i++; }
      while (cl.length && isBlank(cl[cl.length - 1])) cl.pop();
      out += `<pre><code>${esc(cl.join('\n'))}\n</code></pre>\n`; continue;
    }
    if ((m = reFence.exec(l))) {
      flushPara();
      const ind = m[1].length, fence = m[2], info = m[3];
      if (fence[0] === '`' && info.includes('`')) { para.push(l); i++; continue; }
      const body = []; i++;
      const close = new RegExp('^ {0,3}' + fence[0] + '{' + fence.length + ',}\\s*$');
      while (i < lines.length && !close.test(lines[i])) {
        body.push(lines[i].replace(new RegExp('^ {0,' + ind + '}'), '')); i++;
      }
      i++;
      const lang = unescapeStr(info).split(/\s+/)[0];
      out += `<pre><code${lang ? ` class="language-${esc(lang)}"` : ''}>${body.length ? esc(body.join('\n')) + '\n' : ''}</code></pre>\n`;
      continue;
    }
    if ((m = reAtx.exec(l))) {
      flushPara();
      const txt = (m[2] || '').replace(/(^|[ \t]+)#+[ \t]*$/, '');
      out += `<h${m[1].length}>${inline(txt.trim())}</h${m[1].length}>\n`; i++; continue;
    }
    if (para.length && /^ {0,3}(=+|-+)[ \t]*$/.test(l)) {
      const lv = l.trim()[0] === '=' ? 1 : 2;
      const t = inline(para.map(x => x.replace(/^[ \t]+/, '')).join('\n').replace(/[ \t]+$/, ''));
      para = []; out += `<h${lv}>${t}</h${lv}>\n`; i++; continue;
    }
    if (reHr.test(l)) { flushPara(); out += '<hr />\n'; i++; continue; }
    if (/^ {0,3}>/.test(l)) {
      flushPara();
      const q = [];
      while (i < lines.length) {
        const x = lines[i];
        if (/^ {0,3}>/.test(x)) { q.push(x.replace(/^ {0,3}> ?/, '')); i++; }
        else if (!isBlank(x) && !(q.length && isBlank(q[q.length - 1])) && lazyOk(q, x)) { q.push(x); i++; }
        else break;
      }
      out += `<blockquote>\n${blocks(q, false)}</blockquote>\n`; continue;
    }
    const lm = listMarker(l);
    if (lm && !(para.length && (lm.rest.trim() === '' || (lm.type === 'ol' && lm.num !== 1)))) {
      flushPara();
      const items = []; let loose = false;
      let cur = lm;
      while (cur) {
        const w = cur.rest.trim() === '' ? 1 : (cur.w > 4 ? 1 : cur.w);
        const cind = cur.indent + cur.len - cur.indent - cur.w + w;
        const first = cur.w > 4 ? l0(lines[i], cur) : cur.rest;
        const body = [first]; i++;
        let blankSeen = false;
        while (i < lines.length) {
          const x = lines[i];
          if (isBlank(x)) { body.push(''); blankSeen = true; i++; continue; }
          const ind = /^ */.exec(x)[0].length;
          if (ind >= cind) { body.push(x.slice(cind)); blankSeen = false; i++; continue; }
          if (!blankSeen && !listMarker(x) && !reHr.test(x) && !reFence.test(x) && !reAtx.test(x) && !/^ {0,3}>/.test(x)) { body.push(x); i++; continue; }
          break;
        }
        let trailing = false;
        while (body.length && isBlank(body[body.length - 1])) { body.pop(); trailing = true; }
        items.push({ body, trailing });
        const nx = i < lines.length ? listMarker(lines[i]) : null;
        if (nx && nx.type === lm.type && nx.ch === lm.ch && !reHr.test(lines[i])) {
          if (trailing) loose = true;
          cur = nx;
        } else cur = null;
      }
      // internal blank lines between blocks
      for (const it of items) {
        let seenBlank = false, content = false;
        for (let k = 0; k < it.body.length; k++) {
          if (isBlank(it.body[k])) { if (content) seenBlank = true; }
          else if (seenBlank) { loose = true; break; }
          else content = true;
        }
      }
      const tag = lm.type;
      const start = tag === 'ol' && lm.num !== 1 ? ` start="${lm.num}"` : '';
      out += `<${tag}${start}>\n` + items.map(it => {
        const inner = blocks(it.body, !loose);
        return `<li>${loose ? '\n' + inner : inner.replace(/\n$/, '')}</li>\n`;
      }).join('') + `</${tag}>\n`;
      continue;
    }
    para.push(l); i++;
  }
  flushPara();
  return out;
}
function l0(line, cur) { return line.slice(cur.indent + cur.len - cur.w + 1); }
function lazyOk(q, x) {
  if (!q.length) return false;
  const last = q[q.length - 1];
  if (isBlank(last)) return false;
  if (reFence.test(x) || reAtx.test(x) || reHr.test(x) || listMarker(x)) return false;
  // only lazy when previous content is paragraph text
  return !reFence.test(last) && !/^ {4}/.test(last) && !reAtx.test(last) && !reHr.test(last);
}

export function render(markdown) {
  const lines = String(markdown).replace(/\r\n?/g, '\n').replace(/\t/g, '    ').split('\n');
  return blocks(lines, false);
}
