// Inline parsing for markdown-s2
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', bull: '•', middot: '·', deg: '°', plusmn: '±', times: '×', divide: '÷', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶', hearts: '♥', larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', eacute: 'é', egrave: 'è', agrave: 'à', aacute: 'á', ccedil: 'ç', ntilde: 'ñ', frac12: '½', frac14: '¼', frac34: '¾', iexcl: '¡', iquest: '¿', ne: '≠', le: '≤', ge: '≥', infin: '∞', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', pi: 'π', Dcaron: 'Ď', HilbertSpace: 'ℋ', DifferentialD: 'ⅆ', ClockwiseContourIntegral: '∲', ngE: '≧̸', AElig: 'Æ', aelig: 'æ', hyphen: '‐', dash: '‐', check: '✓', star: '☆' };

export function esc(s) {
  return s.replace(/[&<>"]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}
function cpToStr(n) {
  if (!(n > 0 && n <= 0x10ffff) || (n >= 0xd800 && n <= 0xdfff)) return '�';
  return String.fromCodePoint(n);
}
export function decodeEntity(name) {
  if (name[1] === '#') {
    const n = name[2] === 'x' || name[2] === 'X' ? parseInt(name.slice(3, -1), 16) : parseInt(name.slice(2, -1), 10);
    return cpToStr(n);
  }
  const v = ENT[name.slice(1, -1)];
  return v === undefined ? null : v;
}
const ENT_RE = /&(?:#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/;
export function unescapeStr(s) {
  if (!s.includes('\\') && !s.includes('&')) return s;
  return s.replace(/\\([!-\/:-@\[-`{-~])|(&(?:#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});)/g, (m, a, b) => {
    if (a) return a;
    const d = decodeEntity(b);
    return d === null ? m : d;
  });
}
export function normLabel(s) {
  return s.trim().replace(/[ \t\r\n]+/g, ' ').toLowerCase().toUpperCase();
}
const SAFE = /[A-Za-z0-9;\/?:@&=+$,\-_.!~*'()#]/;
export function encodeUrl(u) {
  let out = '';
  for (let i = 0; i < u.length; i++) {
    const c = u[i];
    if (SAFE.test(c)) out += c;
    else if (c === '%' && /^[0-9a-fA-F]{2}$/.test(u.slice(i + 1, i + 3))) out += c;
    else {
      const cp = u.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      if (cp > 0xffff) i++;
      try { out += encodeURIComponent(ch); } catch { out += '%EF%BF%BD'; }
    }
  }
  return out;
}
export function safeUrl(u) {
  const probe = u.replace(/[\u0000-\u0020\u007f-\u009f\u200b\u2028\u2029\ufeff]/g, '').toLowerCase();
  if (/^(javascript|vbscript|file):/.test(probe)) return '#';
  if (/^data:/.test(probe) && !/^data:image\/(png|gif|jpeg|webp);/.test(probe)) return '#';
  return u;
}
function finalUrl(raw) {
  return esc(encodeUrl(safeUrl(unescapeStr(raw))));
}

const isWs = c => c === ' ' || c === '\t' || c === '\n' || c === '\r';
const isPunctAscii = c => /[!-\/:-@\[-`{-~]/.test(c);

export function parseDest(s, i) {
  const n = s.length;
  if (s[i] === '<') {
    let j = i + 1;
    while (j < n) {
      const c = s[j];
      if (c === '\n' || c === '<') return null;
      if (c === '>') return { raw: s.slice(i + 1, j), end: j + 1, angle: true };
      if (c === '\\' && j + 1 < n && isPunctAscii(s[j + 1])) j += 2; else j++;
    }
    return null;
  }
  let j = i, parens = 0;
  while (j < n) {
    const c = s[j];
    if (c === '\\' && j + 1 < n && isPunctAscii(s[j + 1])) j += 2;
    else if (c === '(') { parens++; j++; }
    else if (c === ')') { if (parens === 0) break; parens--; j++; }
    else if (c <= ' ' || c === '\x7f') break;
    else j++;
  }
  if (parens !== 0) return null;
  return { raw: s.slice(i, j), end: j, angle: false };
}
export function parseTitle(s, i) {
  const o = s[i];
  const close = o === '"' ? '"' : o === "'" ? "'" : o === '(' ? ')' : null;
  if (!close) return null;
  let j = i + 1;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && isPunctAscii(s[j + 1])) j += 2;
    else if (c === close) return { raw: s.slice(i + 1, j), end: j + 1 };
    else if (o === '(' && c === '(') return null;
    else j++;
  }
  return null;
}
const skipWs = (s, i) => { while (i < s.length && isWs(s[i])) i++; return i; };

function parseLinkTail(s, i) {
  // i points after '('
  let j = skipWs(s, i);
  const d = parseDest(s, j);
  if (!d) return null;
  j = d.end;
  let title = null;
  const k = skipWs(s, j);
  if (k > j && (s[k] === '"' || s[k] === "'" || s[k] === '(')) {
    const t = parseTitle(s, k);
    if (t) { title = t.raw; j = skipWs(s, t.end); } else return null;
  } else j = k;
  if (s[j] !== ')') return null;
  return { dest: d.raw, title, end: j + 1 };
}

export function parseRefDef(str, pos) {
  let j = pos + 1;
  for (;;) {
    const c = str[j];
    if (c === undefined || c === '[') return null;
    if (c === '\\') j += 2;
    else if (c === ']') break;
    else j++;
  }
  const label = str.slice(pos + 1, j);
  if (!/\S/.test(label) || label.length > 999) return null;
  j++;
  if (str[j] !== ':') return null;
  j++;
  const skipSpNl = (k) => {
    while (str[k] === ' ' || str[k] === '\t') k++;
    if (str[k] === '\n') { k++; while (str[k] === ' ' || str[k] === '\t') k++; }
    return k;
  };
  j = skipSpNl(j);
  const d = parseDest(str, j);
  if (!d || (d.end === j)) return null;
  if (!d.angle && d.raw === '') return null;
  const endOfLine = (k) => { while (str[k] === ' ' || str[k] === '\t') k++; return (k >= str.length) ? str.length : str[k] === '\n' ? k + 1 : -1; };
  let title = null, end = -1;
  const k = skipSpNl(d.end);
  if (k > d.end && (str[k] === '"' || str[k] === "'" || str[k] === '(')) {
    const t = parseTitle(str, k);
    if (t) { const e = endOfLine(t.end); if (e >= 0) { title = t.raw; end = e; } }
  }
  if (end < 0) { end = endOfLine(d.end); if (end < 0) return null; }
  return { label: normLabel(label), dest: d.raw, title, end };
}

const isPunctCp = ch => /[\p{P}\p{S}]/u.test(ch);
const isWsCp = ch => /\s/u.test(ch);
function before(s, i) {
  if (i <= 0) return '\n';
  const c = s.charCodeAt(i - 1);
  if (c >= 0xdc00 && c <= 0xdfff && i >= 2) return s.slice(i - 2, i);
  return s[i - 1];
}
function after(s, i) {
  if (i >= s.length) return '\n';
  return String.fromCodePoint(s.codePointAt(i));
}

const rend = t => (t.d ? t.ch.repeat(t.count) : t.v);
const rendP = t => (t.d ? t.ch.repeat(t.count) : t.p);

function emph(arr) {
  const bottoms = new Map();
  let ci = 0;
  while (ci < arr.length) {
    const c = arr[ci];
    if (!c.d || !c.canClose || c.count === 0) { ci++; continue; }
    const key = c.ch + (c.canOpen ? 1 : 0) + (c.ch === '~' ? c.count : c.orig % 3);
    const bot = bottoms.get(key);
    let found = -1;
    for (let j = ci - 1; j >= 0; j--) {
      const o = arr[j];
      if (o === bot) break;
      if (!o.d || !o.canOpen || o.ch !== c.ch) continue;
      if (c.ch === '~') { if (o.count === c.count) { found = j; break; } continue; }
      if ((c.canOpen || o.canClose) && (o.orig + c.orig) % 3 === 0 && !(o.orig % 3 === 0 && c.orig % 3 === 0)) continue;
      found = j; break;
    }
    if (found < 0) {
      bottoms.set(key, arr[ci - 1]);
      if (!c.canOpen) c.canClose = false;
      ci++;
      continue;
    }
    const o = arr[found];
    const use = c.ch === '~' ? c.count : (c.count >= 2 && o.count >= 2 ? 2 : 1);
    const inner = arr.slice(found + 1, ci);
    const ih = inner.map(rend).join(''), ip = inner.map(rendP).join('');
    const tag = c.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em';
    const raw = { v: `<${tag}>${ih}</${tag}>`, p: ip };
    o.count -= use; c.count -= use;
    arr.splice(found + 1, ci - found - 1, raw);
    let cidx = found + 2;
    if (o.count === 0) { arr.splice(found, 1); cidx--; }
    if (c.count === 0) arr.splice(cidx, 1);
    ci = cidx;
  }
}
function finish(arr) {
  emph(arr);
  return { html: arr.map(rend).join(''), text: arr.map(rendP).join('') };
}

const AUTOLINK = /^<([A-Za-z][A-Za-z0-9.+-]{1,31}:[^\s<>]*)>/;
const EMAIL = /^<([a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/;
const SPECIAL = new Set(['\\', '`', '*', '_', '~', '[', ']', '!', '<', '&', '\n']);

export function inline(s, refs) {
  const toks = [];
  let buf = '';
  let pos = 0;
  const n = s.length;
  const flush = () => { if (buf) { toks.push({ v: esc(buf), p: buf }); buf = ''; } };
  const pushRaw = (v, p) => { flush(); toks.push({ v, p }); };
  while (pos < n) {
    const c = s[pos];
    if (!SPECIAL.has(c)) {
      let j = pos + 1;
      while (j < n && !SPECIAL.has(s[j])) j++;
      buf += s.slice(pos, j); pos = j; continue;
    }
    if (c === '\n') {
      const m = /( *)$/.exec(buf);
      const hard = m[1].length >= 2;
      buf = buf.slice(0, buf.length - m[1].length);
      if (hard) pushRaw('<br />\n', '\n'); else buf += '\n';
      pos++;
      while (pos < n && (s[pos] === ' ' || s[pos] === '\t')) pos++;
      continue;
    }
    if (c === '\\') {
      const nx = s[pos + 1];
      if (nx === '\n') { pushRaw('<br />\n', '\n'); pos += 2; while (pos < n && (s[pos] === ' ' || s[pos] === '\t')) pos++; continue; }
      if (nx !== undefined && isPunctAscii(nx)) { buf += nx; pos += 2; continue; }
      buf += '\\'; pos++; continue;
    }
    if (c === '`') {
      let j = pos; while (s[j] === '`') j++;
      const len = j - pos;
      let k = j, end = -1;
      while (k < n) {
        const f = s.indexOf('`', k);
        if (f < 0) break;
        let e = f; while (s[e] === '`') e++;
        if (e - f === len) { end = f; break; }
        k = e;
      }
      if (end < 0) { buf += s.slice(pos, j); pos = j; continue; }
      let content = s.slice(j, end).replace(/\n/g, ' ');
      if (content.length > 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) content = content.slice(1, -1);
      pushRaw(`<code>${esc(content)}</code>`, content);
      pos = end + len; continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      let j = pos; while (s[j] === c) j++;
      const count = j - pos;
      if (c === '~' && count > 2) { buf += s.slice(pos, j); pos = j; continue; }
      const b = before(s, pos), a = after(s, j);
      const aWs = isWsCp(a), bWs = isWsCp(b), aP = isPunctCp(a), bP = isPunctCp(b);
      const left = !aWs && (!aP || bWs || bP);
      const right = !bWs && (!bP || aWs || aP);
      let canOpen, canClose;
      if (c === '_') { canOpen = left && (!right || bP); canClose = right && (!left || aP); }
      else { canOpen = left; canClose = right; }
      flush();
      toks.push({ d: true, ch: c, count, orig: count, canOpen, canClose });
      pos = j; continue;
    }
    if (c === '[' || (c === '!' && s[pos + 1] === '[')) {
      const img = c === '!';
      flush();
      const len = img ? 2 : 1;
      toks.push({ open: true, img, active: true, pos: pos + len, v: img ? '![' : '[', p: img ? '![' : '[' });
      pos += len; continue;
    }
    if (c === '!') { buf += c; pos++; continue; }
    if (c === ']') {
      flush();
      let idx = -1;
      for (let i = toks.length - 1; i >= 0; i--) if (toks[i].open) { idx = i; break; }
      if (idx < 0) { buf += ']'; pos++; continue; }
      const op = toks[idx];
      if (!op.active) { op.open = false; buf += ']'; pos++; continue; }
      let dest = null, title = null, end = -1;
      if (s[pos + 1] === '(') {
        const t = parseLinkTail(s, pos + 2);
        if (t) { dest = t.dest; title = t.title; end = t.end; }
      }
      if (end < 0 && refs) {
        let label = null, e2 = pos + 1;
        if (s[pos + 1] === '[') {
          let j = pos + 2;
          while (j < n && s[j] !== ']' && s[j] !== '[') j += s[j] === '\\' ? 2 : 1;
          if (s[j] === ']') {
            const l = s.slice(pos + 2, j);
            e2 = j + 1;
            label = l.trim() === '' ? s.slice(op.pos, pos) : l;
            if (l.trim() === '' && false) label = null;
          }
        }
        if (label === null) label = s.slice(op.pos, pos);
        const r = /\S/.test(label) ? refs.get(normLabel(label)) : null;
        if (r) { dest = r.dest; title = r.title; end = e2; }
      }
      if (end < 0) { op.open = false; buf += ']'; pos++; continue; }
      const innerToks = toks.splice(idx + 1);
      toks.pop();
      const inner = finish(innerToks);
      let html;
      const url = finalUrl(dest);
      const tt = title !== null ? ` title="${esc(unescapeStr(title))}"` : '';
      if (op.img) html = `<img src="${url}" alt="${esc(inner.text)}"${tt} />`;
      else html = `<a href="${url}"${tt}>${inner.html}</a>`;
      toks.push({ v: html, p: inner.text });
      if (!op.img) for (const t of toks) if (t.open) t.active = false;
      pos = end; continue;
    }
    if (c === '<') {
      const rest = s.slice(pos, pos + 2000);
      let m = AUTOLINK.exec(rest);
      if (m) { pushRaw(`<a href="${finalUrl(m[1])}">${esc(m[1])}</a>`, m[1]); pos += m[0].length; continue; }
      m = EMAIL.exec(rest);
      if (m) { pushRaw(`<a href="${esc(encodeUrl('mailto:' + m[1]))}">${esc(m[1])}</a>`, m[1]); pos += m[0].length; continue; }
      buf += '<'; pos++; continue;
    }
    if (c === '&') {
      const m = /^&(?:#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/.exec(s.slice(pos, pos + 40));
      if (m) { const d = decodeEntity(m[0]); if (d !== null) { buf += d; pos += m[0].length; continue; } }
      buf += '&'; pos++; continue;
    }
  }
  flush();
  return finish(toks);
}
