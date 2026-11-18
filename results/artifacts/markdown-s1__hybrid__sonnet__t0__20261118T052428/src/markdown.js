const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const PUNCT = /[!-\/:-@\[-`{-~\p{P}\p{S}]/u;
const isWs = c => c === undefined || /\s/u.test(c);
const isPunct = c => c !== undefined && PUNCT.test(c);

function normUrl(u) {
  return encodeURI(u).replace(/%25([0-9A-Fa-f]{2})/g, '%$1');
}
function unescapeStr(s) {
  return s.replace(/\\([!-\/:-@\[-`{-~])|&(#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|amp|lt|gt|quot|apos);/g, (m, a, e) => {
    if (a) return a;
    const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (map[e]) return map[e];
    const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '�';
  });
}

function parseLinkTail(s, i) {
  // s[i] === '(' ; returns {url,title,end} or null
  let p = i + 1;
  const skip = () => { while (p < s.length && /[ \t\n]/.test(s[p])) p++; };
  skip();
  let url = '';
  if (s[p] === '<') {
    const e = s.indexOf('>', p);
    if (e < 0) return null;
    url = s.slice(p + 1, e);
    if (url.includes('\n') || url.includes('<')) return null;
    p = e + 1;
  } else {
    let depth = 0, st = p;
    while (p < s.length) {
      const c = s[p];
      if (c === '\\' && p + 1 < s.length) { p += 2; continue; }
      if (c === '(') depth++;
      else if (c === ')') { if (depth === 0) break; depth--; }
      else if (/[\s\x00-\x1f]/.test(c)) break;
      p++;
    }
    if (depth !== 0) return null;
    url = s.slice(st, p);
  }
  const before = p;
  skip();
  let title = null;
  if (p > before && (s[p] === '"' || s[p] === "'" || s[p] === '(')) {
    const close = s[p] === '(' ? ')' : s[p];
    let q = p + 1, t = '';
    while (q < s.length && s[q] !== close) {
      if (s[q] === '\\' && q + 1 < s.length) { t += s[q] + s[q + 1]; q += 2; continue; }
      t += s[q++];
    }
    if (q >= s.length) return null;
    title = t;
    p = q + 1;
    skip();
  }
  if (s[p] !== ')') return null;
  return { url: normUrl(unescapeStr(url)), title: title === null ? null : unescapeStr(title), end: p + 1 };
}

function inline(src) {
  const nodes = []; // {h:string} or {d:true,ch,n,open,close,orig}
  const brackets = []; // indexes in nodes of [ or ![
  let i = 0, buf = '';
  const flush = () => { if (buf) { nodes.push({ h: esc(buf) }); buf = ''; } };
  const s = src;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      if (s[i + 1] === '\n') { flush(); nodes.push({ h: '<br />\n' }); i += 2; while (s[i] === ' ') i++; continue; }
      if (/[!-\/:-@\[-`{-~]/.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
      buf += c; i++; continue;
    }
    if (c === '`') {
      let n = 0; while (s[i + n] === '`') n++;
      let j = i + n, found = -1;
      while (j < s.length) {
        if (s[j] === '`') {
          let m = 0; while (s[j + m] === '`') m++;
          if (m === n) { found = j; break; }
          j += m;
        } else j++;
      }
      if (found < 0) { buf += '`'.repeat(n); i += n; continue; }
      let code = s.slice(i + n, found).replace(/\n/g, ' ');
      if (/^ .*[^ ].* $/s.test(code) || (code.length > 1 && code[0] === ' ' && code.at(-1) === ' ' && /[^ ]/.test(code))) code = code.slice(1, -1);
      flush(); nodes.push({ h: '<code>' + esc(code) + '</code>' });
      i = found + n; continue;
    }
    if (c === '&') {
      const m = /^&(?:#\d{1,7}|#[xX][0-9a-fA-F]{1,6}|amp|lt|gt|quot|apos|nbsp|copy);/.exec(s.slice(i, i + 12));
      if (m) { buf += m[0] === '&nbsp;' ? ' ' : m[0] === '&copy;' ? '©' : unescapeStr(m[0]); i += m[0].length; continue; }
    }
    if (c === '<') {
      const m = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/.exec(s.slice(i));
      if (m) { flush(); nodes.push({ h: `<a href="${esc(normUrl(m[1]))}">${esc(m[1])}</a>` }); i += m[0].length; continue; }
      buf += c; i++; continue;
    }
    if (c === '\n') {
      let hard = / {2,}$/.test(buf);
      buf = buf.replace(/ +$/, '');
      flush(); nodes.push({ h: hard ? '<br />\n' : '\n' }); i++;
      while (s[i] === ' ') i++;
      continue;
    }
    if (c === '*' || c === '_') {
      let n = 0; while (s[i + n] === c) n++;
      const bc = s[i - 1], ac = s[i + n];
      const lf = !isWs(ac) && (!isPunct(ac) || isWs(bc) || isPunct(bc));
      const rf = !isWs(bc) && (!isPunct(bc) || isWs(ac) || isPunct(ac));
      let open, close;
      if (c === '*') { open = lf; close = rf; }
      else { open = lf && (!rf || isPunct(bc)); close = rf && (!lf || isPunct(ac)); }
      flush(); nodes.push({ d: true, ch: c, n, orig: n, open, close, pre: '', post: '' });
      i += n; continue;
    }
    if (c === '!' && s[i + 1] === '[') {
      flush(); nodes.push({ h: '![', br: true, img: true, active: true }); brackets.push(nodes.length - 1); i += 2; continue;
    }
    if (c === '[') {
      flush(); nodes.push({ h: '[', br: true, img: false, active: true }); brackets.push(nodes.length - 1); i++; continue;
    }
    if (c === ']') {
      flush();
      const bi = brackets.pop();
      if (bi === undefined) { nodes.push({ h: ']' }); i++; continue; }
      const op = nodes[bi];
      if (!op.active) { nodes.push({ h: ']' }); i++; continue; }
      let link = s[i + 1] === '(' ? parseLinkTail(s, i + 1) : null;
      if (!link) { op.h = esc(op.h); delete op.br; nodes.push({ h: ']' }); i++; continue; }
      const inner = nodes.splice(bi + 1);
      nodes.pop();
      emphasis(inner);
      const content = inner.map(nodeText).join('');
      const title = link.title !== null ? ` title="${esc(link.title)}"` : '';
      if (op.img) {
        const alt = inner.map(altText).join('');
        nodes[bi] = { h: `<img src="${esc(link.url)}" alt="${esc(alt)}"${title} />` };
      } else {
        nodes[bi] = { h: `<a href="${esc(link.url)}"${title}>${content}</a>` };
        for (const b of brackets) if (!nodes[b].img) nodes[b].active = false;
      }
      i = link.end; continue;
    }
    buf += c; i++;
  }
  flush();
  emphasis(nodes);
  return nodes.map(nodeText).join('');
}
function nodeText(n) {
  if (n.d) return n.pre + n.ch.repeat(n.n) + n.post;
  return n.h;
}
function altText(n) {
  if (n.d) return n.ch.repeat(n.n);
  return n.h.replace(/<img [^>]*alt="([^"]*)"[^>]*>/, (m, a) => a).replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
}
function emphasis(nodes) {
  // delimiter processing; nodes with d flag
  for (let ci = 0; ci < nodes.length; ci++) {
    const cl = nodes[ci];
    if (!cl.d || !cl.close || cl.n === 0) continue;
    while (cl.n > 0) {
      let oi = -1;
      for (let k = ci - 1; k >= 0; k--) {
        const o = nodes[k];
        if (!o.d || !o.open || o.n === 0 || o.ch !== cl.ch) continue;
        if ((o.close || cl.open) && (o.orig + cl.orig) % 3 === 0 && !(o.orig % 3 === 0 && cl.orig % 3 === 0)) continue;
        oi = k; break;
      }
      if (oi < 0) break;
      const o = nodes[oi];
      const use = o.n >= 2 && cl.n >= 2 ? 2 : 1;
      const tag = use === 2 ? 'strong' : 'em';
      o.n -= use; cl.n -= use;
      o.post = `<${tag}>` + o.post;   // placed after remaining opener chars
      cl.pre = cl.pre + `</${tag}>`;
      // delimiters between become inert
      for (let k = oi + 1; k < ci; k++) if (nodes[k].d) { nodes[k].open = false; nodes[k].close = false; }
    }
    if (cl.n > 0) cl.close = false;
  }
  // Fix ordering: openers' remaining chars come before their tags; closers' tags before chars (handled by pre/post)
}

// ---------- blocks ----------
const reHr = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const reAtx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const reFence = /^( {0,3})(`{3,}|~{3,})[ \t]*([^`]*)$/;
const reBullet = /^( {0,3})([-*+])( +|$)/;
const reOrdered = /^( {0,3})(\d{1,9})([.)])( +|$)/;

function listMarker(line) {
  let m = reBullet.exec(line);
  if (m) return { type: 'ul', ch: m[2], indent: m[1].length, rest: line.slice(m[0].length), w: m[1].length + 1 + (m[3].length > 4 || m[3].length === 0 ? 1 : m[3].length), empty: m[3] === '' , pad: m[3].length };
  m = reOrdered.exec(line);
  if (m) return { type: 'ol', ch: m[3], num: parseInt(m[2], 10), indent: m[1].length, rest: line.slice(m[0].length), w: m[1].length + m[2].length + 1 + (m[4].length > 4 || m[4].length === 0 ? 1 : m[4].length), empty: m[4] === '', pad: m[4].length };
  return null;
}
const blank = l => /^[ \t]*$/.test(l);
function startsBlock(l) {
  return reHr.test(l) || reAtx.test(l) || reFence.test(l) || /^ {0,3}>/.test(l) ||
    (() => { const m = listMarker(l); return m && !m.empty && (m.type === 'ul' || m.num === 1); })();
}
function detab(l) { return l.includes('\t') ? l.replace(/^( *)\t/, (m, a) => a + ' '.repeat(4 - a.length % 4)) : l; }

function blocks(lines, tight = false) {
  let out = '';
  let i = 0;
  const para = [];
  const flushPara = () => {
    if (para.length) {
      const t = inline(para.map(x => x.replace(/^[ \t]+/, '')).join('\n').replace(/[ \t]+$/, ''));
      out += tight ? t + '\n' : `<p>${t}</p>\n`;
      para.length = 0;
    }
  };
  while (i < lines.length) {
    const line = detab(lines[i]);
    if (blank(line)) { flushPara(); i++; continue; }
    let m;
    if (/^ {4,}/.test(line) && !para.length) {
      const code = [];
      while (i < lines.length && (blank(detab(lines[i])) || /^ {4,}/.test(detab(lines[i])))) { code.push(detab(lines[i]).slice(4)); i++; }
      while (code.length && blank(code.at(-1))) code.pop();
      out += `<pre><code>${esc(code.join('\n') + '\n')}</code></pre>\n`;
      continue;
    }
    if ((m = reFence.exec(line))) {
      flushPara();
      const ind = m[1].length, fence = m[2], info = unescapeStr(m[3].trim());
      if (fence[0] === '`' && m[3].includes('`')) { para.push(line); i++; continue; }
      const body = [];
      i++;
      const closeRe = new RegExp('^ {0,3}' + fence[0] + '{' + fence.length + ',}[ \\t]*$');
      while (i < lines.length && !closeRe.test(lines[i])) {
        let l = lines[i], k = 0;
        while (k < ind && l[k] === ' ') k++;
        body.push(l.slice(k)); i++;
      }
      i++;
      const lang = info.split(/\s+/)[0];
      out += `<pre><code${lang ? ` class="language-${esc(lang)}"` : ''}>${body.length ? esc(body.join('\n') + '\n') : ''}</code></pre>\n`;
      continue;
    }
    if ((m = reAtx.exec(line))) {
      flushPara();
      out += `<h${m[1].length}>${inline((m[2] || '').trim())}</h${m[1].length}>\n`; i++; continue;
    }
    if (para.length && (m = /^ {0,3}(=+|-+)[ \t]*$/.exec(line))) {
      const n = m[1][0] === '=' ? 1 : 2;
      const t = inline(para.map(x => x.replace(/^[ \t]+/, '')).join('\n').replace(/[ \t]+$/, ''));
      para.length = 0;
      out += `<h${n}>${t}</h${n}>\n`; i++; continue;
    }
    if (reHr.test(line)) { flushPara(); out += '<hr />\n'; i++; continue; }
    if (/^ {0,3}>/.test(line)) {
      flushPara();
      const q = [];
      while (i < lines.length) {
        const l = detab(lines[i]);
        if (/^ {0,3}>/.test(l)) { q.push(l.replace(/^ {0,3}> ?/, '')); i++; }
        else if (!blank(l) && q.length && !blank(q.at(-1)) && !startsBlock(l) && lastIsPara(q)) { q.push(l); i++; }
        else break;
      }
      out += `<blockquote>\n${blocks(q)}</blockquote>\n`;
      continue;
    }
    const lm = listMarker(line);
    if (lm && !(para.length && (lm.empty || (lm.type === 'ol' && lm.num !== 1)))) {
      flushPara();
      const items = [];
      let loose = false;
      while (i < lines.length) {
        if (items.length && blank(lines[i])) {
          let j = i; while (j < lines.length && blank(lines[j])) j++;
          const mk2 = j < lines.length && listMarker(detab(lines[j]));
          if (mk2 && mk2.type === lm.type && mk2.ch === lm.ch && !reHr.test(lines[j])) { loose = true; i = j; } else break;
        }
        const l = detab(lines[i]);
        const mk = listMarker(l);
        if (!mk || mk.type !== lm.type || mk.ch !== lm.ch || reHr.test(l)) break;
        const w = mk.w;
        const body = [mk.rest.length && mk.pad > 4 ? ' '.repeat(mk.pad - 1) + mk.rest : mk.rest];
        i++;
        let sawBlank = false;
        while (i < lines.length) {
          const l2 = detab(lines[i]);
          if (blank(l2)) {
            // look ahead
            let j = i; while (j < lines.length && blank(lines[j])) j++;
            if (j < lines.length && new RegExp('^ {' + w + '}').test(detab(lines[j])) && !(body.length === 1 && blank(body[0]) )) {
              for (; i < j; i++) body.push('');
              continue;
            }
            break;
          }
          if (new RegExp('^ {' + w + '}').test(l2)) { body.push(l2.slice(w)); i++; continue; }
          if (startsBlock(l2) || listMarker(l2) || blank(body.at(-1))) break;
          body.push(l2.replace(/^ +/, '')); i++;
        }
        while (body.length && blank(body.at(-1))) body.pop();
        items.push(body);
      }
      // looseness
      for (let k = 0; k < items.length; k++) {
        const b = items[k];
        for (let x = 0; x < b.length - 1; x++) if (blank(b[x]) && !inFence(b, x)) { if (b.slice(x + 1).some(y => !blank(y))) loose = true; }
        if (k < items.length - 1 && items[k].length === 0) { /* empty */ }
      }
      // blank lines between items
      loose = loose || betweenLoose(lines, items);
      const tag = lm.type;
      const startAttr = tag === 'ol' && lm.num !== 1 ? ` start="${lm.num}"` : '';
      out += `<${tag}${startAttr}>\n` + items.map(b => {
        const inner = blocks(b, !loose);
        return `<li>${loose ? '\n' + inner : inner.replace(/\n$/, '')}</li>\n`;
      }).join('') + `</${tag}>\n`;
      continue;
    }
    para.push(line); i++;
  }
  flushPara();
  return out;
}
function lastIsPara(q) { return !/^( {4,}|```|~~~)/.test(q.at(-1)); }
function inFence(b, x) { let f = false; for (let k = 0; k < x; k++) if (/^ {0,3}(```|~~~)/.test(b[k])) f = !f; return f; }
function betweenLoose() { return false; }

export function render(markdown) {
  const lines = String(markdown).replace(/\r\n?/g, '\n').replace(/\0/g, '�').split('\n');
  // pre-pass for loose lists is handled in blocks via blank-line detection
  return blocks(lines);
}
