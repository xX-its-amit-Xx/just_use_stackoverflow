const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const PUNCT = /[!-\/:-@\[-`{-~]/;

function inline(s) {
  let out = '';
  let i = 0;
  const n = s.length;
  // delimiter-run based emphasis: tokenise first
  const toks = []; // {t:'html',v} | {t:'d',ch,len,canOpen,canClose}
  let buf = '';
  const flush = () => { if (buf) { toks.push({ t: 'html', v: esc(buf) }); buf = ''; } };
  const isWs = c => c === undefined || /\s/.test(c);
  const isP = c => c !== undefined && (PUNCT.test(c) || /\p{P}|\p{S}/u.test(c));
  while (i < n) {
    const c = s[i];
    if (c === '\\' && i + 1 < n && PUNCT.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
    if (c === '\\' && s[i + 1] === '\n') { flush(); toks.push({ t: 'html', v: '<br />\n' }); i += 2; continue; }
    if (c === '`') {
      let j = i; while (s[j] === '`') j++;
      const len = j - i;
      let k = j, found = -1;
      while (k < n) {
        if (s[k] === '`') { let m = k; while (s[m] === '`') m++; if (m - k === len) { found = k; break; } k = m; } else k++;
      }
      if (found >= 0) {
        let code = s.slice(j, found).replace(/\n/g, ' ');
        if (/^ .* $/.test(code) && /[^ ]/.test(code)) code = code.slice(1, -1);
        flush(); toks.push({ t: 'html', v: '<code>' + esc(code) + '</code>' }); i = found + len; continue;
      }
      buf += s.slice(i, j); i = j; continue;
    }
    if (c === '!' && s[i + 1] === '[' || c === '[') {
      const img = c === '!';
      const st = img ? i + 1 : i;
      // find matching ]
      let depth = 0, j = st;
      for (; j < n; j++) {
        if (s[j] === '\\') { j++; continue; }
        if (s[j] === '`') { let m = j; while (s[m] === '`') m++; const l = m - j; let k = m, f = -1; while (k < n) { if (s[k] === '`') { let q = k; while (s[q] === '`') q++; if (q - k === l) { f = q; break; } k = q; } else k++; } if (f >= 0) j = f - 1; else j = m - 1; continue; }
        if (s[j] === '[') depth++;
        else if (s[j] === ']') { depth--; if (depth === 0) break; }
      }
      if (j < n && s[j + 1] === '(') {
        const r = parseDest(s, j + 2);
        if (r) {
          flush();
          const text = s.slice(st + 1, j);
          if (img) {
            const alt = inline(text).replace(/<[^>]*>/g, '');
            toks.push({ t: 'html', v: `<img src="${esc(r.url)}" alt="${alt}"${r.title != null ? ` title="${esc(r.title)}"` : ''} />` });
          } else {
            toks.push({ t: 'html', v: `<a href="${esc(r.url)}"${r.title != null ? ` title="${esc(r.title)}"` : ''}>` + inline(text) + '</a>' });
          }
          i = r.end; continue;
        }
      }
      buf += c; i++; continue;
    }
    if (c === '*' || c === '_') {
      let j = i; while (s[j] === c) j++;
      const before = s[i - 1], after = s[j];
      const lf = !isWs(after) && (!isP(after) || isWs(before) || isP(before));
      const rf = !isWs(before) && (!isP(before) || isWs(after) || isP(after));
      let canOpen = c === '*' ? lf : lf && (!rf || isP(before));
      let canClose = c === '*' ? rf : rf && (!lf || isP(after));
      flush(); toks.push({ t: 'd', ch: c, len: j - i, orig: j - i, canOpen, canClose, pre: '', post: '' });
      i = j; continue;
    }
    if (c === '\n') {
      // hard break: two+ spaces before newline
      const m = /( +)$/.exec(buf);
      if (m && m[1].length >= 2) { buf = buf.slice(0, -m[1].length); flush(); toks.push({ t: 'html', v: '<br />\n' }); }
      else { buf = buf.replace(/ +$/, ''); buf += '\n'; }
      i++; while (s[i] === ' ') i++; continue;
    }
    buf += c; i++;
  }
  flush();
  // process emphasis (CommonMark algorithm)
  for (let ci = 0; ci < toks.length; ci++) {
    const cl = toks[ci];
    if (cl.t !== 'd' || !cl.canClose || cl.len === 0) continue;
    let oi = ci - 1, found = -1;
    for (; oi >= 0; oi--) {
      const o = toks[oi];
      if (o.t !== 'd' || o.ch !== cl.ch || !o.canOpen || o.len === 0) continue;
      if ((o.canClose || cl.canOpen) && (o.orig + cl.orig) % 3 === 0 && !(o.orig % 3 === 0 && cl.orig % 3 === 0)) continue;
      found = oi; break;
    }
    if (found < 0) continue;
    const o = toks[found];
    while (o.len > 0 && cl.len > 0) {
      const use = o.len >= 2 && cl.len >= 2 ? 2 : 1;
      o.len -= use; cl.len -= use;
      const tag = use === 2 ? 'strong' : 'em';
      o.post = `<${tag}>` + o.post;   // later opens are inner -> prepend? handled below
      cl.pre += `</${tag}>`;
    }
    // remove delimiters between
    for (let k = found + 1; k < ci; k++) if (toks[k].t === 'd') { toks[k].len = 0; toks[k].canOpen = toks[k].canClose = false; }
    if (cl.len > 0) ci--; // reprocess closer
  }
  for (const t of toks) {
    if (t.t === 'html') out += t.v;
    else out += t.pre + esc(t.ch.repeat(t.len)) + t.post;
  }
  return out;
}

function parseDest(s, i) {
  const n = s.length;
  const ws = () => { while (i < n && /\s/.test(s[i])) i++; };
  ws();
  let url = '';
  if (s[i] === '<') {
    const j = s.indexOf('>', i);
    if (j < 0 || s.slice(i, j).includes('\n')) return null;
    url = s.slice(i + 1, j); i = j + 1;
  } else {
    let depth = 0;
    const st = i;
    while (i < n && !/\s/.test(s[i])) {
      if (s[i] === '\\' && i + 1 < n) { i += 2; continue; }
      if (s[i] === '(') depth++;
      else if (s[i] === ')') { if (depth === 0) break; depth--; }
      i++;
    }
    if (depth !== 0) return null;
    url = s.slice(st, i);
  }
  url = url.replace(/\\([!-\/:-@\[-`{-~])/g, '$1');
  const save = i;
  ws();
  let title = null;
  if (i > save && (s[i] === '"' || s[i] === "'" || s[i] === '(')) {
    const close = s[i] === '(' ? ')' : s[i];
    let j = i + 1, t = '';
    while (j < n && s[j] !== close) { if (s[j] === '\\' && j + 1 < n) { t += PUNCT.test(s[j + 1]) ? s[j + 1] : s[j] + s[j + 1]; j += 2; continue; } t += s[j++]; }
    if (j >= n) return null;
    title = t; i = j + 1; ws();
  }
  if (s[i] !== ')') return null;
  return { url: encodeURI(decodeURI_safe(url)), title, end: i + 1 };
}
function decodeURI_safe(u) { try { return decodeURI(u); } catch { return u; } }

export function render(markdown) {
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
  return blocks(lines);
}

function blocks(lines) {
  let html = '';
  let i = 0;
  let para = [];
  const flushPara = () => {
    if (para.length) { html += '<p>' + inline(para.map(l => l.replace(/^[ \t]+/, '')).join('\n').replace(/[ \t]+$/, '')) + '</p>\n'; para = []; }
  };
  const isHr = l => /^ {0,3}([-*_])( *\1){2,} *$/.test(l);
  const fenceRe = /^( {0,3})(`{3,}|~{3,})\s*([^`]*)$/;
  const ulRe = /^ {0,3}([-*+])( +|$)/;
  const olRe = /^ {0,3}(\d{1,9})([.)])( +|$)/;
  const startsBlock = l => /^ {0,3}#{1,6}(\s|$)/.test(l) || isHr(l) || fenceRe.test(l) || /^ {0,3}>/.test(l);
  while (i < lines.length) {
    const l = lines[i];
    if (/^\s*$/.test(l)) { flushPara(); i++; continue; }
    let m;
    if (!para.length && /^ {4}/.test(l)) {
      const code = [];
      while (i < lines.length && (/^ {4}/.test(lines[i]) || (/^\s*$/.test(lines[i])))) { code.push(lines[i].slice(4)); i++; }
      while (code.length && /^\s*$/.test(code[code.length - 1])) code.pop();
      html += '<pre><code>' + esc(code.join('\n')) + '\n</code></pre>\n'; continue;
    }
    if ((m = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/.exec(l))) {
      flushPara();
      let t = (m[2] || '').replace(/[ \t]+#+[ \t]*$/, '').replace(/^#+$/, '');
      html += `<h${m[1].length}>${inline(t)}</h${m[1].length}>\n`; i++; continue;
    }
    if (para.length && /^ {0,3}(=+|-+) *$/.test(l)) {
      const lvl = l.trim()[0] === '=' ? 1 : 2;
      const t = para.map(x => x.trim()).join('\n'); para = [];
      html += `<h${lvl}>${inline(t)}</h${lvl}>\n`; i++; continue;
    }
    if (isHr(l)) { flushPara(); html += '<hr />\n'; i++; continue; }
    if ((m = fenceRe.exec(l)) && !(m[2][0] === '`' && m[3].includes('`'))) {
      flushPara();
      const ind = m[1].length, fc = m[2][0], fl = m[2].length;
      const lang = m[3].trim().split(/\s+/)[0];
      const code = []; i++;
      const closeRe = new RegExp('^ {0,3}' + (fc === '`' ? '`' : '~') + '{' + fl + ',}\\s*$');
      while (i < lines.length && !closeRe.test(lines[i])) { code.push(lines[i].replace(new RegExp('^ {0,' + ind + '}'), '')); i++; }
      i++;
      html += '<pre><code' + (lang ? ` class="language-${esc(lang.replace(/\\([!-\/:-@\[-`{-~])/g, '$1'))}"` : '') + '>' + esc(code.join('\n')) + (code.length ? '\n' : '') + '</code></pre>\n';
      continue;
    }
    if (/^ {0,3}>/.test(l)) {
      flushPara();
      const q = [];
      while (i < lines.length) {
        if (/^ {0,3}>/.test(lines[i])) q.push(lines[i].replace(/^ {0,3}> ?/, ''));
        else if (!/^\s*$/.test(lines[i]) && q.length && !/^\s*$/.test(q[q.length - 1]) && !startsBlock(lines[i]) && !ulRe.test(lines[i]) && !olRe.test(lines[i])) q.push(lines[i]);
        else break;
        i++;
      }
      html += '<blockquote>\n' + blocks(q) + '</blockquote>\n'; continue;
    }
    let lm = ulRe.exec(l), ordered = false;
    if (!lm && (m = olRe.exec(l)) && (!para.length || m[1] === '1')) { lm = m; ordered = true; }
    if (lm && (!para.length || lm[0].trim().length && !/^\s*$/.test(l.slice(lm[0].length)))) {
      flushPara();
      const marker = ordered ? lm[2] : lm[1];
      const start = ordered ? parseInt(lm[1], 10) : 1;
      const items = []; let loose = false, sawBlank = false;
      const re = ordered ? olRe : ulRe;
      while (i < lines.length) {
        const mm = re.exec(lines[i]);
        if (!mm || (ordered ? mm[2] : mm[1]) !== marker || isHr(lines[i])) break;
        if (sawBlank) loose = true;
        sawBlank = false;
        const w = mm[0].length - (mm[0].endsWith(' ') && mm[0].length - lines[i].search(/\S/) > 5 ? 0 : 0);
        const first = lines[i].slice(mm[0].length);
        const item = [first]; i++;
        let blankPending = 0;
        while (i < lines.length) {
          const x = lines[i];
          if (/^\s*$/.test(x)) { blankPending++; i++; continue; }
          const indent = /^ */.exec(x)[0].length;
          if (indent >= w) {
            for (let b = 0; b < blankPending; b++) item.push('');
            if (blankPending) loose = true;
            blankPending = 0; item.push(x.slice(w)); i++; continue;
          }
          if (!blankPending && !startsBlock(x) && !re.exec(x)) { item.push(x.trim()); i++; continue; }
          break;
        }
        if (blankPending) sawBlank = true;
        items.push(item);
      }
      const tag = ordered ? 'ol' : 'ul';
      html += `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>\n`;
      for (const it of items) {
        const inner = blocks(it);
        html += '<li>' + (loose ? '\n' + inner : inner.replace(/^<p>([\s\S]*?)<\/p>\n(?!$)/, '$1\n').replace(/^<p>([\s\S]*?)<\/p>\n$/, '$1')) + '</li>\n';
      }
      html += `</${tag}>\n`; continue;
    }
    // setext heading
    if (para.length && /^ {0,3}(=+|-+) *$/.test(l)) {
      const lvl = l.trim()[0] === '=' ? 1 : 2;
      const t = para.map(x => x.trim()).join('\n'); para = [];
      html += `<h${lvl}>${inline(t)}</h${lvl}>\n`; i++; continue;
    }
    para.push(l); i++;
  }
  flushPara();
  return html;
}
