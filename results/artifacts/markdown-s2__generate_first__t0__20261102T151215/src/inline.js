// Inline parser (CommonMark-style delimiter algorithm).
const PUNCT_ASCII = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
export const isAsciiPunct = c => c !== undefined && c !== '' && PUNCT_ASCII.includes(c);
const reUniPunct = /[\p{P}\p{S}]/u;
const reWs = /[\s   -   　]/u;

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', bull: '•', middot: '·', deg: '°', plusmn: '±', times: '×', divide: '÷', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶', larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', hearts: '♥', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', eacute: 'é', egrave: 'è', agrave: 'à', aacute: 'á', ccedil: 'ç', ntilde: 'ñ', frac12: '½', frac14: '¼', frac34: '¾', ne: '≠', le: '≤', ge: '≥', infin: '∞', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', pi: 'π', Dcaron: 'Ď', HilbertSpace: 'ℋ', DifferentialD: 'ⅆ', ClockwiseContourIntegral: '∲', ngE: '≧̸' };
const ENTITY_RE = '&(?:#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});';
function decodeEntity(m) {
  let body = m.slice(1, -1);
  if (body[0] === '#') {
    let cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    if (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
    return String.fromCodePoint(cp);
  }
  return Object.prototype.hasOwnProperty.call(ENT, body) ? ENT[body] : m;
}
const reUnescape = new RegExp('\\\\([' + PUNCT_ASCII.replace(/[\\\]\[^-]/g, '\\$&') + '])|' + ENTITY_RE, 'g');
export function unescapeString(s) {
  if (!s.includes('\\') && !s.includes('&')) return s;
  return s.replace(reUnescape, (m, p) => (p ? p : decodeEntity(m)));
}
export function normalizeLabel(s) {
  return s.trim().replace(/[ \t\r\n]+/g, ' ').toLowerCase().toUpperCase();
}
export function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}
const SAFE = /[A-Za-z0-9\-._~:\/?#@!$&'()*+,;=]/;
export function normalizeUri(u) {
  let out = '';
  for (let i = 0; i < u.length; ) {
    const ch = String.fromCodePoint(u.codePointAt(i));
    i += ch.length;
    if (ch === '%' && /^[0-9a-fA-F]{2}$/.test(u.substr(i, 2))) out += '%';
    else if (ch.length === 1 && SAFE.test(ch)) out += ch;
    else {
      try { out += encodeURIComponent(ch); } catch { out += '%EF%BF%BD'; }
    }
  }
  return out;
}
export function safeUrl(raw) {
  const t = raw.replace(/[\u0000-\u0020\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\ufeff]/g, '');
  if (/^(javascript|vbscript|file|data):/i.test(t)) {
    if (/^data:image\/(png|gif|jpeg|webp);/i.test(t)) return raw;
    return '#';
  }
  return raw;
}

class N {
  constructor(type, literal) { this.type = type; this.literal = literal; this.first = null; this.last = null; this.prev = null; this.next = null; this.parent = null; }
  append(c) { c.unlink(); c.parent = this; if (this.last) { this.last.next = c; c.prev = this.last; this.last = c; } else this.first = this.last = c; }
  insertAfter(s) {
    s.unlink(); s.prev = this; s.parent = this.parent;
    if (this.next) { this.next.prev = s; s.next = this.next; } else if (this.parent) this.parent.last = s;
    this.next = s;
  }
  unlink() {
    if (this.prev) this.prev.next = this.next; else if (this.parent) this.parent.first = this.next;
    if (this.next) this.next.prev = this.prev; else if (this.parent) this.parent.last = this.prev;
    this.parent = this.next = this.prev = null;
  }
}

export function parseLinkLabel(s, pos) {
  if (s[pos] !== '[') return null;
  let i = pos + 1;
  while (i < s.length && i - pos < 1000) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) i += 2;
    else if (c === '[') return null;
    else if (c === ']') return { label: s.slice(pos + 1, i), pos: i + 1 };
    else i++;
  }
  return null;
}
export function parseLinkDestination(s, pos) {
  if (s[pos] === '<') {
    let i = pos + 1;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\' && i + 1 < s.length && isAsciiPunct(s[i + 1])) i += 2;
      else if (c === '>') return { dest: unescapeString(s.slice(pos + 1, i)), pos: i + 1, angle: true };
      else if (c === '<' || c === '\n') return null;
      else i++;
    }
    return null;
  }
  let depth = 0, i = pos;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && isAsciiPunct(s[i + 1])) i += 2;
    else if (c === '(') { depth++; i++; }
    else if (c === ')') { if (depth === 0) break; depth--; i++; }
    else if (c <= ' ' || c === '\x7f') break;
    else i++;
  }
  if (depth !== 0) return null;
  return { dest: unescapeString(s.slice(pos, i)), pos: i, angle: false };
}
export function parseLinkTitle(s, pos) {
  const o = s[pos];
  if (o !== '"' && o !== "'" && o !== '(') return null;
  const cl = o === '(' ? ')' : o;
  let i = pos + 1;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) i += 2;
    else if (c === cl) return { title: unescapeString(s.slice(pos + 1, i)), pos: i + 1 };
    else if (o === '(' && c === '(') return null;
    else i++;
  }
  return null;
}
const skipWs = (s, p) => { while (p < s.length && /[ \t\n]/.test(s[p])) p++; return p; };

// Parse reference definitions at start of paragraph text. Returns consumed length.
export function parseReferences(text, refmap) {
  let total = 0;
  for (;;) {
    const r = parseOneRef(text, total, refmap);
    if (r === 0) break;
    total = r;
  }
  return total;
}
function parseOneRef(s, start, refmap) {
  let pos = start;
  if (s[pos] !== '[') return 0;
  const l = parseLinkLabel(s, pos);
  if (!l || !l.label.trim()) return 0;
  pos = l.pos;
  if (s[pos] !== ':') return 0;
  pos = skipWs(s, pos + 1);
  const d = parseLinkDestination(s, pos);
  if (!d || (!d.angle && d.dest === '' && d.pos === pos)) return 0;
  pos = d.pos;
  const afterDest = pos;
  const p2 = skipWs(s, pos);
  let title = null, end = -1;
  if (p2 > pos) {
    const t = parseLinkTitle(s, p2);
    if (t) {
      let q = t.pos;
      while (q < s.length && (s[q] === ' ' || s[q] === '\t')) q++;
      if (q >= s.length || s[q] === '\n') { title = t.title; end = q < s.length ? q + 1 : q; }
    }
  }
  if (end < 0) {
    let q = afterDest;
    while (q < s.length && (s[q] === ' ' || s[q] === '\t')) q++;
    if (q < s.length && s[q] !== '\n') return 0;
    end = q < s.length ? q + 1 : q;
  }
  const key = normalizeLabel(l.label);
  if (!refmap.has(key)) refmap.set(key, { dest: d.dest, title });
  return end;
}

const RE_AUTOLINK = /^<([A-Za-z][A-Za-z0-9.+-]{1,31}:[^<>\x00-\x20]*)>/;
const RE_EMAIL = /^<([a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/;
const RE_ENTITY = new RegExp('^' + ENTITY_RE);

class InlineParser {
  constructor(s, refmap) { this.s = s; this.pos = 0; this.refmap = refmap; this.delims = null; this.brackets = null; }
  text(v) { return new N('text', v); }
  parse(root) {
    const s = this.s;
    while (this.pos < s.length) {
      if (!this.parseInline(root)) break;
    }
    this.processEmphasis(null);
  }
  parseInline(block) {
    const s = this.s, c = s[this.pos];
    let res = false;
    switch (c) {
      case '\n': res = this.newline(block); break;
      case '\\': res = this.backslash(block); break;
      case '`': res = this.backticks(block); break;
      case '*': case '_': case '~': res = this.delimRun(c, block); break;
      case '[': this.pos++; { const n = this.text('['); block.append(n); this.addBracket(n, this.pos - 1, false); } res = true; break;
      case '!':
        if (s[this.pos + 1] === '[') { this.pos += 2; const n = this.text('!['); block.append(n); this.addBracket(n, this.pos - 2, true); res = true; }
        break;
      case ']': res = this.closeBracket(block); break;
      case '<': res = this.autolink(block); break;
      case '&': { const m = RE_ENTITY.exec(s.slice(this.pos, this.pos + 40)); if (m) { this.pos += m[0].length; block.append(this.text(decodeEntity(m[0]))); res = true; } break; }
    }
    if (!res) {
      if (c === undefined) return false;
      let i = this.pos + 1;
      while (i < s.length && !'\n\\`*_~[]!<&'.includes(s[i])) i++;
      block.append(this.text(s.slice(this.pos, i)));
      this.pos = i;
    }
    return true;
  }
  newline(block) {
    this.pos++;
    const last = block.last;
    if (last && last.type === 'text' && last.literal.endsWith(' ')) {
      const hard = last.literal.endsWith('  ');
      last.literal = last.literal.replace(/ +$/, '');
      block.append(new N(hard ? 'hardbreak' : 'softbreak'));
    } else block.append(new N('softbreak'));
    while (this.pos < this.s.length && (this.s[this.pos] === ' ' || this.s[this.pos] === '\t')) this.pos++;
    return true;
  }
  backslash(block) {
    const n = this.s[this.pos + 1];
    if (n === '\n') { this.pos += 2; block.append(new N('hardbreak')); while (this.s[this.pos] === ' ') this.pos++; }
    else if (isAsciiPunct(n)) { this.pos += 2; block.append(this.text(n)); }
    else { this.pos++; block.append(this.text('\\')); }
    return true;
  }
  backticks(block) {
    const s = this.s;
    let i = this.pos;
    while (s[i] === '`') i++;
    const len = i - this.pos;
    let j = i;
    while (j < s.length) {
      const k = s.indexOf('`', j);
      if (k < 0) break;
      let e = k;
      while (s[e] === '`') e++;
      if (e - k === len) {
        let c = s.slice(i, k).replace(/\n/g, ' ');
        if (c.length > 2 && c[0] === ' ' && c[c.length - 1] === ' ' && /[^ ]/.test(c)) c = c.slice(1, -1);
        block.append(new N('code', c));
        this.pos = e;
        return true;
      }
      j = e;
    }
    this.pos = i;
    block.append(this.text(s.slice(i - len, i)));
    return true;
  }
  autolink(block) {
    const rest = this.s.slice(this.pos);
    let m = RE_EMAIL.exec(rest);
    if (m) { const n = new N('link'); n.dest = 'mailto:' + m[1]; n.title = ''; n.append(this.text(m[1])); block.append(n); this.pos += m[0].length; return true; }
    m = RE_AUTOLINK.exec(rest);
    if (m) { const n = new N('link'); n.dest = m[1]; n.title = ''; n.append(this.text(m[1])); block.append(n); this.pos += m[0].length; return true; }
    this.pos++;
    block.append(this.text('<'));
    return true;
  }
  delimRun(c, block) {
    const s = this.s, start = this.pos;
    let i = start;
    while (s[i] === c) i++;
    const num = i - start;
    const before = start === 0 ? '\n' : String.fromCodePoint(s.codePointAt(start - 1 - (start >= 2 && /[\udc00-\udfff]/.test(s[start - 1]) ? 1 : 0)));
    const after = i >= s.length ? '\n' : String.fromCodePoint(s.codePointAt(i));
    const afterWs = reWs.test(after), beforeWs = reWs.test(before);
    const afterP = reUniPunct.test(after), beforeP = reUniPunct.test(before);
    const left = !afterWs && (!afterP || beforeWs || beforeP);
    const right = !beforeWs && (!beforeP || afterWs || afterP);
    let canOpen, canClose;
    if (c === '_') { canOpen = left && (!right || beforeP); canClose = right && (!left || afterP); }
    else if (c === '~') { canOpen = left && num === 2; canClose = right && num === 2; }
    else { canOpen = left; canClose = right; }
    this.pos = i;
    const node = this.text(s.slice(start, i));
    block.append(node);
    if (canOpen || canClose) {
      this.delims = { cc: c, num, orig: num, node, prev: this.delims, next: null, canOpen, canClose };
      if (this.delims.prev) this.delims.prev.next = this.delims;
    }
    return true;
  }
  removeDelim(d) {
    if (d.prev) d.prev.next = d.next;
    if (d.next) d.next.prev = d.prev; else this.delims = d.prev;
  }
  processEmphasis(bottom) {
    const ob = {};
    let closer = this.delims;
    while (closer && closer.prev !== bottom) closer = closer.prev;
    while (closer) {
      if (!closer.canClose) { closer = closer.next; continue; }
      const key = closer.cc + (closer.canOpen ? 1 : 0) + (closer.orig % 3);
      let opener = closer.prev, found = false;
      while (opener && opener !== bottom && opener !== ob[key]) {
        const odd = (closer.canOpen || opener.canClose) && closer.orig % 3 !== 0 && (opener.orig + closer.orig) % 3 === 0;
        if (opener.cc === closer.cc && opener.canOpen && !odd) { found = true; break; }
        opener = opener.prev;
      }
      const old = closer;
      if (found) {
        const use = closer.cc === '~' ? 2 : (closer.num >= 2 && opener.num >= 2 ? 2 : 1);
        const oi = opener.node, ci = closer.node;
        opener.num -= use; closer.num -= use;
        oi.literal = oi.literal.slice(0, oi.literal.length - use);
        ci.literal = ci.literal.slice(0, ci.literal.length - use);
        const em = new N(closer.cc === '~' ? 'del' : use === 1 ? 'em' : 'strong');
        let t = oi.next;
        while (t && t !== ci) { const nx = t.next; em.append(t); t = nx; }
        oi.insertAfter(em);
        // remove delimiters between
        let d = closer.prev;
        while (d && d !== opener) { const p = d.prev; this.removeDelim(d); d = p; }
        if (opener.num === 0) { oi.unlink(); this.removeDelim(opener); }
        if (closer.num === 0) { ci.unlink(); const nx = closer.next; this.removeDelim(closer); closer = nx; }
      } else {
        ob[key] = old.prev;
        closer = closer.next;
        if (!old.canOpen) this.removeDelim(old);
      }
    }
    while (this.delims && this.delims !== bottom) this.removeDelim(this.delims);
  }
  addBracket(node, index, image) {
    if (this.brackets) this.brackets.bracketAfter = true;
    this.brackets = { node, prev: this.brackets, prevDelim: this.delims, index, image, active: true, bracketAfter: false };
  }
  closeBracket(block) {
    const s = this.s;
    this.pos++;
    const startpos = this.pos;
    const opener = this.brackets;
    if (!opener) { block.append(this.text(']')); return true; }
    if (!opener.active) { block.append(this.text(']')); this.brackets = opener.prev; return true; }
    const isImage = opener.image;
    let dest = null, title = '', matched = false;
    if (s[this.pos] === '(') {
      let p = skipWs(s, this.pos + 1);
      const d = parseLinkDestination(s, p);
      if (d) {
        p = d.pos;
        const p2 = skipWs(s, p);
        let t = null;
        if (p2 > p) { t = parseLinkTitle(s, p2); if (t) p = skipWs(s, t.pos); else p = p2; }
        if (s[p] === ')') { matched = true; dest = d.dest; title = t ? t.title : ''; this.pos = p + 1; }
      }
    }
    if (!matched) {
      const save = this.pos;
      let reflabel = null;
      const l = parseLinkLabel(s, this.pos);
      if (l) { this.pos = l.pos; if (l.label.length > 0) reflabel = l.label; else if (!opener.bracketAfter) reflabel = s.slice(opener.index + (isImage ? 2 : 1), startpos - 1); }
      else { this.pos = save; if (!opener.bracketAfter) reflabel = s.slice(opener.index + (isImage ? 2 : 1), startpos - 1); }
      if (reflabel !== null && reflabel.trim()) {
        const ref = this.refmap.get(normalizeLabel(reflabel));
        if (ref) { matched = true; dest = ref.dest; title = ref.title || ''; }
      }
      if (!matched) this.pos = save;
    }
    if (matched) {
      const node = new N(isImage ? 'image' : 'link');
      node.dest = dest; node.title = title;
      let t = opener.node.next;
      while (t) { const nx = t.next; node.append(t); t = nx; }
      block.append(node);
      this.processEmphasis(opener.prevDelim);
      opener.node.unlink();
      this.brackets = opener.prev;
      if (!isImage) for (let b = this.brackets; b; b = b.prev) if (!b.image) b.active = false;
      return true;
    }
    this.brackets = opener.prev;
    this.pos = startpos;
    block.append(this.text(']'));
    return true;
  }
}

export function parseInlines(text, refmap) {
  const root = new N('root');
  new InlineParser(text.trim(), refmap).parse(root);
  return root;
}

export function plainText(node) {
  let out = '';
  for (let c = node.first; c; c = c.next) {
    if (c.type === 'text' || c.type === 'code') out += c.literal;
    else if (c.type === 'softbreak' || c.type === 'hardbreak') out += ' ';
    else out += plainText(c);
  }
  return out;
}

export function renderInlines(node) {
  let out = '';
  for (let c = node.first; c; c = c.next) {
    switch (c.type) {
      case 'text': out += escapeHtml(c.literal); break;
      case 'code': out += '<code>' + escapeHtml(c.literal) + '</code>'; break;
      case 'softbreak': out += '\n'; break;
      case 'hardbreak': out += '<br />\n'; break;
      case 'em': out += '<em>' + renderInlines(c) + '</em>'; break;
      case 'strong': out += '<strong>' + renderInlines(c) + '</strong>'; break;
      case 'del': out += '<del>' + renderInlines(c) + '</del>'; break;
      case 'link':
        out += '<a href="' + escapeHtml(normalizeUri(safeUrl(c.dest))) + '"' + (c.title ? ' title="' + escapeHtml(c.title) + '"' : '') + '>' + renderInlines(c) + '</a>';
        break;
      case 'image':
        out += '<img src="' + escapeHtml(normalizeUri(safeUrl(c.dest))) + '" alt="' + escapeHtml(plainText(c)) + '"' + (c.title ? ' title="' + escapeHtml(c.title) + '"' : '') + ' />';
        break;
    }
  }
  return out;
}
