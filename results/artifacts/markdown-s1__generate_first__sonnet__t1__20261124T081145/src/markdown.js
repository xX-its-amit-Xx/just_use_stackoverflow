const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const PUNCT = /[!-\/:-@\[-`{-~\p{P}\p{S}]/u;
const isWs = c => c === undefined || /\s/.test(c);
const isPunct = c => c !== undefined && PUNCT.test(c);
const ESCAPABLE = /[!-\/:-@\[-`{-~]/;

function encodeUrl(u) {
  return u.replace(/[^\w\-.~:\/?#@!$&'()*+,;=%\[\]]/g, ch => encodeURIComponent(ch)).replace(/%(?![0-9a-fA-F]{2})/g, '%25');
}
function unescapeStr(s) {
  return s.replace(/\\([!-\/:-@\[-`{-~])/g, '$1');
}

function inline(src) {
  const toks = [];
  let buf = '';
  const flush = () => { if (buf) { toks.push({ t: 'h', s: esc(buf) }); buf = ''; } };
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '\\') {
      if (src[i + 1] === '\n') { flush(); toks.push({ t: 'h', s: '<br />\n' }); i += 2; while (src[i] === ' ') i++; continue; }
      if (i + 1 < n && ESCAPABLE.test(src[i + 1])) { buf += src[i + 1]; i += 2; continue; }
      buf += c; i++; continue;
    }
    if (c === '`') {
      let j = i; while (src[j] === '`') j++;
      const len = j - i;
      let k = j, found = -1;
      while (k < n) {
        if (src[k] === '`') {
          let m = k; while (src[m] === '`') m++;
          if (m - k === len) { found = k; break; }
          k = m;
        } else k++;
      }
      if (found < 0) { buf += src.slice(i, j); i = j; continue; }
      let code = src.slice(j, found).replace(/\n/g, ' ');
      if (/^ .*[^ ].* $/.test(code) || (code.length > 2 && code[0] === ' ' && code.at(-1) === ' ' && code.trim() !== '')) code = code.slice(1, -1);
      flush(); toks.push({ t: 'h', s: '<code>' + esc(code) + '</code>' });
      i = found + len; continue;
    }
    if (c === '!' && src[i + 1] === '[' || c === '[') {
      const img = c === '!';
      const start = i + (img ? 2 : 1);
      // find matching ]
      let depth = 1, j = start;
      while (j < n) {
        const d = src[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '`') {
          let m = j; while (src[m] === '`') m++;
          const len = m - j; let k = m, f = -1;
          while (k < n) { if (src[k] === '`') { let q = k; while (src[q] === '`') q++; if (q - k === len) { f = q; break; } k = q; } else k++; }
          if (f >= 0) { j = f; continue; }
          j = m; continue;
        }
        if (d === '[') depth++;
        else if (d === ']') { depth--; if (depth === 0) break; }
        j++;
      }
      if (j < n && src[j + 1] === '(') {
        const r = parseDest(src, j + 2);
        if (r) {
          const text = src.slice(start, j);
          flush();
          const url = encodeUrl(unescapeStr(r.url));
          let h;
          if (img) {
            h = '<img src="' + esc(url) + '" alt="' + esc(plain(inline(text))) + '"' + (r.title != null ? ' title="' + esc(r.title) + '"' : '') + ' />';
          } else {
            h = '<a href="' + esc(url) + '"' + (r.title != null ? ' title="' + esc(r.title) + '"' : '') + '>' + inline(text) + '</a>';
          }
          toks.push({ t: 'h', s: h });
          i = r.end; continue;
        }
      }
      buf += src.slice(i, start); i = start; continue;
    }
    if (c === '*' || c === '_') {
      let j = i; while (src[j] === c) j++;
      const before = src[i - 1], after = src[j];
      const lf = !isWs(after) && (!isPunct(after) || isWs(before) || isPunct(before));
      const rf = !isWs(before) && (!isPunct(before) || isWs(after) || isPunct(after));
      let co, cc;
      if (c === '*') { co = lf; cc = rf; }
      else { co = lf && (!rf || isPunct(before)); cc = rf && (!lf || isPunct(after)); }
      flush();
      toks.push({ t: 'd', ch: c, n: j - i, orig: j - i, co, cc, open: '', close: '' });
      i = j; continue;
    }
    if (c === '\n') {
      // hard break if preceded by 2+ spaces
      const m = /( *)$/.exec(buf);
      let sp = m[1].length;
      buf = buf.slice(0, buf.length - sp);
      flush();
      toks.push({ t: 'h', s: sp >= 2 ? '<br />\n' : '\n' });
      i++; while (src[i] === ' ') i++;
      continue;
    }
    if (c === '&') {
      const m = /^&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/.exec(src.slice(i, i + 40));
      if (m) {
        let dec = null;
        if (m[1][0] === '#') {
          const cp = m[1][1] === 'x' || m[1][1] === 'X' ? parseInt(m[1].slice(2), 16) : parseInt(m[1].slice(1), 10);
          dec = cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp < 0xe000) ? '�' : String.fromCodePoint(cp);
        } else {
          const ents = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', hellip: '…', mdash: '—', ndash: '–' };
          if (ents[m[1]] != null) dec = ents[m[1]];
        }
        if (dec != null) { buf += dec; i += m[0].length; continue; }
      }
    }
    buf += c; i++;
  }
  flush();
  // emphasis processing
  const ds = [];
  toks.forEach((t, idx) => { if (t.t === 'd') ds.push(idx); });
  const stack = []; // indices into toks of delimiters
  for (let di = 0; di < toks.length; di++) {
    const cl = toks[di];
    if (cl.t !== 'd') continue;
    if (cl.cc) {
      while (cl.n > 0) {
        let oi = -1;
        for (let s = stack.length - 1; s >= 0; s--) {
          const o = toks[stack[s]];
          if (o.ch !== cl.ch || !o.co || o.n === 0) continue;
          if ((o.cc || cl.co) && (o.orig + cl.orig) % 3 === 0 && !(o.orig % 3 === 0 && cl.orig % 3 === 0)) continue;
          oi = s; break;
        }
        if (oi < 0) break;
        const o = toks[stack[oi]];
        const use = o.n >= 2 && cl.n >= 2 ? 2 : 1;
        const tag = use === 2 ? 'strong' : 'em';
        o.n -= use; cl.n -= use;
        o.open = '<' + tag + '>' + o.open; // placeholder order fixed below
        // inner delimiters between are dead
        const oIdx = stack[oi];
        for (let x = oIdx + 1; x < di; x++) if (toks[x].t === 'd') { toks[x].co = false; toks[x].cc = false; }
        stack.length = oi + (o.n > 0 ? 1 : 0);
        // openers: later-added tags are inner => should be output after earlier ones
        o.open = o.open; 
        o.openList = (o.openList || []); o.openList.push('<' + tag + '>');
        cl.closeList = (cl.closeList || []); cl.closeList.push('</' + tag + '>');
      }
    }
    if (cl.n > 0 && cl.co) stack.push(di);
  }
  let out = '';
  for (const t of toks) {
    if (t.t === 'h') out += t.s;
    else {
      const lit = t.ch.repeat(t.n);
      // closers: literal remaining chars come first for openers? For openers, remaining literal precede tags; for closers, tags precede literal
      if (t.openList) out += lit + t.openList.reverse().join('');
      else if (t.closeList) out += t.closeList.join('') + lit;
      else out += lit;
    }
  }
  return out;
}

function plain(html) { return html.replace(/<[^>]*>/g, ''); }

function parseDest(s, i) {
  const n = s.length;
  const skip = () => { while (i < n && /[ \t\n]/.test(s[i])) i++; };
  skip();
  let url = '';
  if (s[i] === '<') {
    let j = i + 1;
    while (j < n && s[j] !== '>' && s[j] !== '\n' && s[j] !== '<') { if (s[j] === '\\') j++; j++; }
    if (s[j] !== '>') return null;
    url = s.slice(i + 1, j); i = j + 1;
  } else {
    let depth = 0, j = i;
    while (j < n) {
      const d = s[j];
      if (d === '\\' && j + 1 < n && ESCAPABLE.test(s[j + 1])) { j += 2; continue; }
      if (d === '(') depth++;
      else if (d === ')') { if (depth === 0) break; depth--; }
      else if (/[\s\x00-\x1f]/.test(d)) break;
      j++;
    }
    if (depth !== 0) return null;
    url = s.slice(i, j); i = j;
  }
  const save = i;
  skip();
  let title = null;
  if (i > save && (s[i] === '"' || s[i] === "'" || s[i] === '(')) {
    const close = s[i] === '(' ? ')' : s[i];
    let j = i + 1;
    while (j < n && s[j] !== close) { if (s[j] === '\\') j++; j++; }
    if (j >= n) return null;
    title = unescapeStr(s.slice(i + 1, j)); i = j + 1;
    skip();
  }
  if (s[i] !== ')') return null;
  return { url, title, end: i + 1 };
}

// ---------- blocks ----------
const reHr = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const reAtx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const reFence = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\n]*)$/;
const reBq = /^ {0,3}>/;
const reBullet = /^( {0,3})([-+*])([ \t]+|$)/;
const reOrd = /^( {0,3})(\d{1,9})([.)])([ \t]+|$)/;

function expandTabs(l) {
  if (!l.includes('\t')) return l;
  let out = '', col = 0;
  for (const ch of l) {
    if (ch === '\t') { const k = 4 - (col % 4); out += ' '.repeat(k); col += k; } else { out += ch; col++; }
  }
  return out;
}
const blank = l => /^[ \t]*$/.test(l);

function listMarker(l) {
  let m = reBullet.exec(l);
  if (m) {
    const rest = l.slice(m[0].length);
    let sp = m[3].length;
    if (m[3] === '' || blank(rest)) sp = 1; else if (sp > 4) sp = 1;
    return { type: 'b', ch: m[2], indent: m[1].length + 1 + sp, empty: blank(rest), content: blank(rest) ? '' : l.slice(m[1].length + 1 + sp) };
  }
  m = reOrd.exec(l);
  if (m) {
    const rest = l.slice(m[0].length);
    let sp = m[4].length;
    if (m[4] === '' || blank(rest)) sp = 1; else if (sp > 4) sp = 1;
    const w = m[1].length + m[2].length + 1;
    return { type: 'o', ch: m[3], num: parseInt(m[2], 10), indent: w + sp, empty: blank(rest), content: blank(rest) ? '' : l.slice(w + sp) };
  }
  return null;
}

function blocks(lines) {
  let out = '';
  let i = 0;
  let para = [];
  const flushPara = () => {
    if (para.length) { out += '<p>' + inline(para.map(s => s.replace(/^[ \t]+/, '')).join('\n').replace(/[ \t]+$/, '')) + '</p>\n'; para = []; }
  };
  while (i < lines.length) {
    const l = lines[i];
    if (blank(l)) { flushPara(); i++; continue; }
    const indented = /^ {4}/.test(l);
    if (indented && !para.length) {
      const buf = [];
      while (i < lines.length && (blank(lines[i]) || /^ {4}/.test(lines[i]))) { buf.push(lines[i].slice(4)); i++; }
      while (buf.length && blank(buf.at(-1))) buf.pop();
      out += '<pre><code>' + esc(buf.map(s => blank(s) && s.length < 0 ? '' : s).join('\n') + '\n') + '</code></pre>\n';
      continue;
    }
    if (!indented) {
      let m;
      if ((m = reFence.exec(l)) && !(m[2][0] === '`' && m[3].includes('`'))) {
        flushPara();
        const ind = m[1].length, fch = m[2][0], flen = m[2].length;
        const info = unescapeStr(m[3].trim());
        const buf = [];
        i++;
        while (i < lines.length) {
          const cm = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[i]);
          if (cm && cm[1][0] === fch && cm[1].length >= flen) { i++; break; }
          let s = lines[i];
          let k = 0; while (k < ind && s[k] === ' ') k++;
          buf.push(s.slice(k)); i++;
        }
        const lang = info.split(/\s+/)[0];
        out += '<pre><code' + (lang ? ' class="language-' + esc(lang) + '"' : '') + '>' + esc(buf.length ? buf.join('\n') + '\n' : '') + '</code></pre>\n';
        continue;
      }
      if ((m = reAtx.exec(l))) {
        flushPara();
        let txt = m[2] || '';
        out += '<h' + m[1].length + '>' + inline(txt.trim()) + '</h' + m[1].length + '>\n';
        i++; continue;
      }
      if (para.length && /^ {0,3}(=+|-+)[ \t]*$/.test(l)) {
        const lvl = l.trim()[0] === '=' ? 1 : 2;
        const t = inline(para.map(s => s.replace(/^[ \t]+/, '')).join('\n').replace(/[ \t]+$/, ''));
        para = [];
        out += '<h' + lvl + '>' + t + '</h' + lvl + '>\n';
        i++; continue;
      }
      if (reHr.test(l)) { flushPara(); out += '<hr />\n'; i++; continue; }
      if (reBq.test(l)) {
        flushPara();
        const buf = [];
        while (i < lines.length) {
          const s = lines[i];
          if (reBq.test(s)) { buf.push(s.replace(/^ {0,3}> ?/, '')); i++; }
          else if (!blank(s) && buf.length && !blank(buf.at(-1)) && lazyOk(buf, s)) { buf.push(s); i++; }
          else break;
        }
        out += '<blockquote>\n' + blocks(buf) + '</blockquote>\n';
        continue;
      }
      const lm = listMarker(l);
      if (lm && !(para.length && (lm.empty || (lm.type === 'o' && lm.num !== 1)))) {
        flushPara();
        const r = list(lines, i, lm);
        out += r.html; i = r.i; continue;
      }
    }
    para.push(l); i++;
  }
  flushPara();
  return out;
}

// lazy continuation: s continues a paragraph if it's not a block start
function lazyOk(buf, s) {
  const last = buf.at(-1);
  if (/^ {4}/.test(last) && !/^ {0,3}\S/.test(last)) return false;
  if (reFence.test(s) || reAtx.test(s) || reHr.test(s) || reBq.test(s) || listMarker(s)) return false;
  // previous must be paragraph text (not fence/atx) -- approximate
  if (reAtx.test(last) || reHr.test(last) || reFence.test(last)) return false;
  return true;
}

function list(lines, i, first) {
  const items = [];
  let loose = false;
  let cur = first;
  while (true) {
    const item = [cur.content];
    i++;
    let sawBlank = false, endsBlank = false;
    let started = !cur.empty;
    while (i < lines.length) {
      const s = lines[i];
      if (blank(s)) {
        if (!started && item.length === 1 && cur.empty) { break; }
        item.push(''); i++; continue;
      }
      const ind = /^ */.exec(s)[0].length;
      if (ind >= cur.indent) { item.push(s.slice(cur.indent)); started = true; i++; continue; }
      // not indented enough
      if (!blank(item.at(-1)) && lazyOk([item.at(-1)], s) && !/^ {4}/.test(s) && !item.some(x => reFence.test(x) && false)) {
        item.push(s); i++; continue;
      }
      break;
    }
    while (item.length && blank(item.at(-1))) { item.pop(); endsBlank = true; }
    items.push({ lines: item, blankAfter: endsBlank });
    // next item?
    if (i < lines.length) {
      // skip blank lines
      let j = i;
      while (j < lines.length && blank(lines[j])) j++;
      const nm = j < lines.length && !reHr.test(lines[j]) ? listMarker(lines[j]) : null;
      if (nm && nm.type === first.type && nm.ch === first.ch) {
        if (j > i || endsBlank) loose = true;
        i = j; cur = nm; continue;
      }
    }
    break;
  }
  // looseness: blank line between direct children inside an item
  for (const it of items) {
    if (hasInnerBlank(it.lines)) loose = true;
  }
  const tag = first.type === 'b' ? 'ul' : 'ol';
  let html = '<' + tag + (first.type === 'o' && first.num !== 1 ? ' start="' + first.num + '"' : '') + '>\n';
  for (const it of items) {
    let inner = blocks(it.lines);
    if (!loose) inner = inner.replace(/<p>([\s\S]*?)<\/p>\n/g, '$1\n').replace(/\n$/, '');
    html += '<li>' + (inner && /^<(ul|ol|pre|blockquote|h\d|hr|p)/.test(inner) && !loose ? '\n' : '') + inner + '</li>\n';
  }
  html += '</' + tag + '>\n';
  return { html, i };
}

function hasInnerBlank(ls) {
  // blank line followed by more content, outside fenced code
  let fence = null;
  for (let k = 0; k < ls.length; k++) {
    const m = reFence.exec(ls[k]);
    if (fence) { if (m && m[2][0] === fence) fence = null; continue; }
    if (m) { fence = m[2][0]; continue; }
    if (blank(ls[k]) && k > 0 && k < ls.length - 1) return true;
  }
  return false;
}

export function render(markdown) {
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n').map(expandTabs);
  return blocks(lines);
}
