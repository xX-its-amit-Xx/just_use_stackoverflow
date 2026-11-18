// Markdown renderer: CommonMark-style blocks/inlines + GFM tables/strikethrough, safe HTML.

const ESC_RE = /[&<>"]/g;
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
export function esc(s) { return String(s).replace(ESC_RE, (c) => ESC_MAP[c]); }

export function slugify(text, seen) {
  const base = String(text).toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
  if (!seen) return base;
  let s = base;
  if (seen.has(base)) {
    let n = seen.get(base);
    do { s = `${base}-${n}`; n++; } while (seen.has(s));
    seen.set(base, n);
    seen.set(s, 1);
  } else seen.set(base, 1);
  return s;
}

// ---------- entities ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', bull: '•', trade: '™', euro: '€', larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔', hearts: '♥', infin: '∞', ne: '≠', le: '≤', ge: '≥', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', pi: 'π', sigma: 'σ', omega: 'ω', lambda: 'λ', mu: 'μ', theta: 'θ', Omega: 'Ω', Delta: 'Δ', Sigma: 'Σ', dagger: '†', Dagger: '‡', permil: '‰', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', check: '✓', times: '×', Dcaron: 'Ď', dcaron: 'ď', HilbertSpace: 'ℋ', DifferentialD: 'ⅆ', ClockwiseContourIntegral: '∲', ngE: '≧̸', fnof: 'ƒ', circ: 'ˆ', tilde: '˜', OElig: 'Œ', oelig: 'œ', Scaron: 'Š', scaron: 'š', Yuml: 'Ÿ', sum: '∑', minus: '−', radic: '√', asymp: '≈', equiv: '≡', forall: '∀', exist: '∃', empty: '∅', isin: '∈', cap: '∩', cup: '∪', int: '∫', there4: '∴', sim: '∼', spades: '♠', clubs: '♣', diams: '♦' };
('nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml')
  .split(' ').forEach((n, i) => { ENT[n] = String.fromCharCode(160 + i); });
Object.setPrototypeOf(ENT, null);

function decodeEntity(m) {
  if (m[1] === '#') {
    const n = m[2] === 'x' || m[2] === 'X' ? parseInt(m.slice(3, -1), 16) : parseInt(m.slice(2, -1), 10);
    if (!n || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '\uFFFD';
    return String.fromCodePoint(n);
  }
  const v = ENT[m.slice(1, -1)];
  return v === undefined ? m : v;
}
const ESCAPABLE = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
const UNESC_RE = /\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])|&(?:#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g;
function unescapeString(s) {
  if (s.indexOf('\\') < 0 && s.indexOf('&') < 0) return s;
  return s.replace(UNESC_RE, (m, c) => (c !== undefined ? c : decodeEntity(m)));
}

function normalizeURI(uri) {
  let out = '';
  for (let i = 0; i < uri.length;) {
    const ch = uri[i];
    if (ch === '%' && /^%[0-9a-fA-F]{2}/.test(uri.slice(i, i + 3))) { out += uri.slice(i, i + 3); i += 3; continue; }
    const cp = uri.codePointAt(i);
    const s = String.fromCodePoint(cp);
    i += s.length;
    if (/[A-Za-z0-9;/?:@&=+$,\-_.!~*'()#]/.test(s)) out += s;
    else {
      try { out += encodeURIComponent(s); } catch { out += '%EF%BF%BD'; }
    }
  }
  return out;
}
function safeUrl(url) {
  const probe = url.replace(/[\u0000-\u0020\u007f-\u009f\u200b\u00ad]/g, '');
  if (/^(javascript|vbscript|file|data):/i.test(probe)) {
    if (/^data:image\/(png|gif|jpeg|webp);/i.test(probe)) return url;
    return '#';
  }
  return url;
}

// ---------- node ----------
class Node {
  constructor(type) {
    this.type = type; this.parent = null; this.firstChild = null; this.lastChild = null;
    this.prev = null; this.next = null; this.literal = null;
  }
  appendChild(c) {
    c.unlink(); c.parent = this;
    if (this.lastChild) { this.lastChild.next = c; c.prev = this.lastChild; this.lastChild = c; } else { this.firstChild = c; this.lastChild = c; }
  }
  insertAfter(s) {
    s.unlink(); s.next = this.next; if (s.next) s.next.prev = s;
    s.prev = this; this.next = s; s.parent = this.parent;
    if (!s.next && s.parent) s.parent.lastChild = s;
  }
  unlink() {
    if (this.prev) this.prev.next = this.next; else if (this.parent) this.parent.firstChild = this.next;
    if (this.next) this.next.prev = this.prev; else if (this.parent) this.parent.lastChild = this.prev;
    this.parent = null; this.next = null; this.prev = null;
  }
}

// ---------- inline parser ----------
const reLinkLabel = /^\[(?:[^\\\[\]]|\\.){0,1000}\]/s;
const reTitle = /^(?:"(?:\\.|[^"\x00])*"|'(?:\\.|[^'\x00])*'|\((?:\\.|[^()\x00])*\))/s;
const reAutolink = /^<[A-Za-z][A-Za-z0-9.+-]{1,31}:[^<>\x00-\x20]*>/;
const reEmail = /^<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/;
const TAGNAME = '[A-Za-z][A-Za-z0-9-]*';
const ATTR = '(?:\\s+[a-zA-Z_:][a-zA-Z0-9:._-]*(?:\\s*=\\s*(?:[^"\'=<>`\\x00-\\x20]+|\'[^\']*\'|"[^"]*"))?)';
const reHtmlTag = new RegExp('^(?:<' + TAGNAME + ATTR + '*\\s*/?>|</' + TAGNAME + '\\s*>|<!---->|<!--(?:-?[^>-])(?:-?[^-])*-->|<[?][\\s\\S]*?[?]>|<![A-Za-z]+\\s+[^>]*>|<!\\[CDATA\\[[\\s\\S]*?\\]\\]>)');
const rePunct = /[\p{P}\p{S}]/u;
const reWs = /[\s\u00a0]/u;

function normalizeLabel(s) { return s.slice(1, -1).trim().replace(/[ \t\r\n]+/g, ' ').toLowerCase().toUpperCase(); }

class InlineParser {
  constructor(refmap, wikiLinks) { this.refmap = refmap; this.wikiLinks = wikiLinks; this.subject = ''; this.pos = 0; this.delimiters = null; this.brackets = null; }
  peek() { return this.pos < this.subject.length ? this.subject[this.pos] : null; }
  match(re) {
    const m = re.exec(this.subject.slice(this.pos));
    if (m === null) return null;
    this.pos += m[0].length; return m[0];
  }
  spnl() { this.match(/^ *(?:\n *)?/); return true; }
  parseLinkLabel() { const m = reLinkLabel.exec(this.subject.slice(this.pos)); if (!m) return 0; this.pos += m[0].length; return m[0].length; }
  parseLinkTitle() { const t = this.match(reTitle); return t === null ? null : unescapeString(t.slice(1, -1)); }
  parseLinkDestination() {
    let res = this.match(/^<(?:[^<>\n\\]|\\.)*>/);
    if (res !== null) return normalizeURI(unescapeString(res.slice(1, -1)));
    if (this.peek() === '<') return null;
    const savepos = this.pos; let open = 0; let c;
    while ((c = this.peek()) !== null) {
      if (c === '\\' && this.pos + 1 < this.subject.length && ESCAPABLE.includes(this.subject[this.pos + 1])) this.pos += 2;
      else if (c === '(') { this.pos++; open++; } else if (c === ')') { if (open < 1) break; this.pos++; open--; } else if (/[\s\x00-\x1f\x7f]/.test(c)) break;
      else this.pos++;
    }
    if (this.pos === savepos && c !== ')') return null;
    if (open !== 0) return null;
    return normalizeURI(unescapeString(this.subject.slice(savepos, this.pos)));
  }
  parseReference(s) {
    this.subject = s; this.pos = 0;
    const startpos = this.pos;
    if (this.parseLinkLabel() === 0) return 0;
    const rawlabel = this.subject.slice(0, this.pos);
    if (this.peek() !== ':') { this.pos = startpos; return 0; }
    this.pos++; this.spnl();
    const dest = this.parseLinkDestination();
    if (dest === null) { this.pos = startpos; return 0; }
    const beforetitle = this.pos; this.spnl();
    let title = null;
    if (this.pos !== beforetitle) title = this.parseLinkTitle();
    if (title === null) { title = ''; this.pos = beforetitle; }
    let atLineEnd = true;
    if (this.match(/^ *(?:\n|$)/) === null) {
      if (title === '') atLineEnd = false;
      else {
        title = ''; this.pos = beforetitle;
        atLineEnd = this.match(/^ *(?:\n|$)/) !== null;
      }
    }
    if (!atLineEnd) { this.pos = startpos; return 0; }
    const norm = normalizeLabel(rawlabel);
    if (norm === '') { this.pos = startpos; return 0; }
    if (!Object.prototype.hasOwnProperty.call(this.refmap, norm)) this.refmap[norm] = { destination: dest, title };
    return this.pos - startpos;
  }
  text(s) { const n = new Node('text'); n.literal = s; return n; }
  parseInlines(block, str) {
    this.subject = str.trim(); this.pos = 0; this.delimiters = null; this.brackets = null;
    while (this.parseInline(block));
    this.processEmphasis(null);
  }
  parseInline(block) {
    const c = this.peek();
    if (c === null) return false;
    let res = false;
    switch (c) {
      case '\n': res = this.parseNewline(block); break;
      case '\\': res = this.parseBackslash(block); break;
      case '`': res = this.parseBackticks(block); break;
      case '*': case '_': case '~': res = this.handleDelim(c, block); break;
      case '[': res = this.parseOpenBracket(block); break;
      case '!': res = this.parseBang(block); break;
      case ']': res = this.parseCloseBracket(block); break;
      case '<': res = this.parseAutolink(block) || this.parseHtmlTag(block); break;
      case '&': res = this.parseEntity(block); break;
      default: res = this.parseString(block);
    }
    if (!res) { this.pos++; block.appendChild(this.text(c)); }
    return true;
  }
  parseString(block) {
    const m = /^[^\n`\[\]\\!<&*_~]+/.exec(this.subject.slice(this.pos));
    if (!m) return false;
    this.pos += m[0].length; block.appendChild(this.text(m[0])); return true;
  }
  parseNewline(block) {
    this.pos++;
    const last = block.lastChild;
    let hard = false;
    if (last && last.type === 'text' && last.literal[last.literal.length - 1] === ' ') {
      hard = last.literal.endsWith('  ');
      last.literal = last.literal.replace(/ +$/, '');
    }
    block.appendChild(new Node(hard ? 'linebreak' : 'softbreak'));
    this.match(/^ */);
    return true;
  }
  parseBackslash(block) {
    this.pos++;
    const c = this.peek();
    if (c === '\n') { this.pos++; block.appendChild(new Node('linebreak')); } else if (c !== null && ESCAPABLE.includes(c)) { this.pos++; block.appendChild(this.text(c)); } else block.appendChild(this.text('\\'));
    return true;
  }
  parseBackticks(block) {
    const ticks = this.match(/^`+/);
    const after = this.pos;
    let m; const re = /`+/g; re.lastIndex = after;
    while ((m = re.exec(this.subject)) !== null) {
      if (m[0].length === ticks.length) {
        let c = this.subject.slice(after, m.index).replace(/\n/g, ' ');
        if (c.length > 2 && c[0] === ' ' && c[c.length - 1] === ' ' && /[^ ]/.test(c)) c = c.slice(1, -1);
        const n = new Node('code'); n.literal = c; block.appendChild(n);
        this.pos = m.index + m[0].length; return true;
      }
    }
    this.pos = after; block.appendChild(this.text(ticks)); return true;
  }
  parseEntity(block) {
    const m = this.match(/^&(?:#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/);
    if (m === null) return false;
    block.appendChild(this.text(decodeEntity(m))); return true;
  }
  parseAutolink(block) {
    let m;
    if ((m = this.match(reEmail))) {
      const n = new Node('link'); n.destination = normalizeURI('mailto:' + m.slice(1, -1)); n.title = '';
      n.appendChild(this.text(m.slice(1, -1))); block.appendChild(n); return true;
    }
    if ((m = this.match(reAutolink))) {
      const n = new Node('link'); n.destination = normalizeURI(unescapeString(m.slice(1, -1))); n.title = '';
      n.appendChild(this.text(m.slice(1, -1))); block.appendChild(n); return true;
    }
    return false;
  }
  parseHtmlTag(block) {
    const m = this.match(reHtmlTag);
    if (m === null) return false;
    block.appendChild(this.text(m)); return true;
  }
  handleDelim(cc, block) {
    const startpos = this.pos;
    let n = 0;
    while (this.subject[this.pos] === cc) { n++; this.pos++; }
    if (cc === '~' && n !== 2) { block.appendChild(this.text('~'.repeat(n))); return true; }
    const before = startpos === 0 ? '\n' : [...this.subject.slice(Math.max(0, startpos - 2), startpos)].pop();
    const after = this.pos >= this.subject.length ? '\n' : String.fromCodePoint(this.subject.codePointAt(this.pos));
    const afterWs = reWs.test(after), beforeWs = reWs.test(before);
    const afterP = rePunct.test(after), beforeP = rePunct.test(before);
    const left = !afterWs && (!afterP || beforeWs || beforeP);
    const right = !beforeWs && (!beforeP || afterWs || afterP);
    let canOpen, canClose;
    if (cc === '_') { canOpen = left && (!right || beforeP); canClose = right && (!left || afterP); } else { canOpen = left; canClose = right; }
    const node = this.text(this.subject.slice(startpos, this.pos));
    block.appendChild(node);
    if (canOpen || canClose) {
      this.delimiters = { cc, numdelims: n, origdelims: n, node, previous: this.delimiters, next: null, canOpen, canClose };
      if (this.delimiters.previous) this.delimiters.previous.next = this.delimiters;
    }
    return true;
  }
  removeDelimiter(d) {
    if (d.previous) d.previous.next = d.next;
    if (d.next) d.next.previous = d.previous; else this.delimiters = d.previous;
  }
  processEmphasis(bottom) {
    const openersBottom = {};
    let closer = this.delimiters;
    while (closer && closer.previous !== bottom) closer = closer.previous;
    while (closer) {
      if (!closer.canClose) { closer = closer.next; continue; }
      const key = closer.cc + (closer.canOpen ? '3' : '0') + (closer.origdelims % 3);
      let opener = closer.previous, found = false;
      const ob = openersBottom[key] === undefined ? bottom : openersBottom[key];
      while (opener && opener !== bottom && opener !== ob) {
        const odd = closer.cc !== '~' && (closer.canOpen || opener.canClose) && closer.origdelims % 3 !== 0 && (opener.origdelims + closer.origdelims) % 3 === 0;
        if (opener.cc === closer.cc && opener.canOpen && !odd) { found = true; break; }
        opener = opener.previous;
      }
      const oldCloser = closer;
      if (!found) {
        closer = closer.next;
        openersBottom[key] = oldCloser.previous;
        if (!oldCloser.canOpen) this.removeDelimiter(oldCloser);
        continue;
      }
      const use = closer.cc === '~' ? 2 : (closer.numdelims >= 2 && opener.numdelims >= 2 ? 2 : 1);
      const oi = opener.node, ci = closer.node;
      opener.numdelims -= use; closer.numdelims -= use;
      oi.literal = oi.literal.slice(0, oi.literal.length - use);
      ci.literal = ci.literal.slice(0, ci.literal.length - use);
      const emph = new Node(closer.cc === '~' ? 'del' : use === 1 ? 'emph' : 'strong');
      let tmp = oi.next;
      while (tmp && tmp !== ci) { const nx = tmp.next; tmp.unlink(); emph.appendChild(tmp); tmp = nx; }
      oi.insertAfter(emph);
      if (opener.next !== closer) { opener.next = closer; closer.previous = opener; }
      if (opener.numdelims === 0) { oi.unlink(); this.removeDelimiter(opener); }
      if (closer.numdelims === 0) { ci.unlink(); const t = closer.next; this.removeDelimiter(closer); closer = t; }
    }
    while (this.delimiters && this.delimiters !== bottom) this.removeDelimiter(this.delimiters);
  }
  addBracket(node, index, image) {
    if (this.brackets) this.brackets.bracketAfter = true;
    this.brackets = { node, previous: this.brackets, previousDelimiter: this.delimiters, index, image, active: true, bracketAfter: false };
  }
  parseOpenBracket(block) {
    if (this.wikiLinks) {
      const m = /^\[\[([^\[\]\n]+)\]\]/.exec(this.subject.slice(this.pos));
      if (m && m[1].trim()) {
        const bar = m[1].indexOf('|');
        const target = (bar >= 0 ? m[1].slice(0, bar) : m[1]).trim();
        const label = (bar >= 0 ? m[1].slice(bar + 1) : m[1]).trim();
        if (target) {
          const n = new Node('wikilink'); n.target = target; n.literal = label || target;
          block.appendChild(n); this.pos += m[0].length; return true;
        }
      }
    }
    const startpos = this.pos; this.pos++;
    const node = this.text('[');
    block.appendChild(node);
    this.addBracket(node, startpos, false);
    return true;
  }
  parseBang(block) {
    const startpos = this.pos; this.pos++;
    if (this.peek() === '[') {
      this.pos++;
      const node = this.text('![');
      block.appendChild(node);
      this.addBracket(node, startpos + 1, true);
    } else block.appendChild(this.text('!'));
    return true;
  }
  parseCloseBracket(block) {
    const startpos = this.pos; this.pos++;
    const opener = this.brackets;
    if (opener === null) { block.appendChild(this.text(']')); return true; }
    if (!opener.active) { block.appendChild(this.text(']')); this.brackets = opener.previous; return true; }
    const isImage = opener.image;
    const savepos = this.pos;
    let matched = false, dest = null, title = null;
    if (this.peek() === '(') {
      this.pos++;
      this.spnl();
      if ((dest = this.parseLinkDestination()) !== null) {
        const bt = this.pos; this.spnl();
        title = this.pos !== bt ? this.parseLinkTitle() : null;
        if (title === null) this.pos = bt;
        this.spnl();
        if (this.peek() === ')') { this.pos++; matched = true; }
      }
      if (!matched) { this.pos = savepos; dest = null; title = null; }
    }
    if (!matched) {
      const beforelabel = this.pos;
      const n = this.parseLinkLabel();
      let reflabel = null;
      if (n > 2) reflabel = this.subject.slice(beforelabel, beforelabel + n);
      else if (!opener.bracketAfter) reflabel = this.subject.slice(opener.index, startpos);
      if (n === 0) this.pos = savepos;
      if (reflabel) {
        const key = normalizeLabel('[' + reflabel.replace(/^\[/, '').replace(/\]$/, '') + ']');
        const link = Object.prototype.hasOwnProperty.call(this.refmap, key) ? this.refmap[key] : null;
        if (link) { dest = link.destination; title = link.title; matched = true; }
      }
    }
    if (matched) {
      const node = new Node(isImage ? 'image' : 'link');
      node.destination = dest; node.title = title || '';
      let tmp = opener.node.next;
      while (tmp) { const nx = tmp.next; tmp.unlink(); node.appendChild(tmp); tmp = nx; }
      block.appendChild(node);
      this.processEmphasis(opener.previousDelimiter);
      this.brackets = opener.previous;
      opener.node.unlink();
      if (!isImage) { let o = this.brackets; while (o) { if (!o.image) o.active = false; o = o.previous; } }
      return true;
    }
    this.brackets = opener.previous;
    this.pos = startpos + 1;
    block.appendChild(this.text(']'));
    return true;
  }
}

// ---------- block parser ----------
const reMaybeSpecial = /^[#`~*+_=<>0-9-]/;
const isSpaceOrTab = (c) => c === ' ' || c === '\t';

function canContain(parent, child) {
  switch (parent) {
    case 'document': case 'block_quote': case 'item': return child !== 'item';
    case 'list': return child === 'item';
    default: return false;
  }
}
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = []; let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; } else if (s[i] === '|') { cells.push(cur.trim()); cur = ''; } else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}
function parseDelimRow(line) {
  if (!line.includes('|') && !/^\s*:?-+:?\s*$/.test(line)) return null;
  if (!line.includes('|')) return null;
  const cells = splitRow(line);
  const aligns = [];
  for (const c of cells) {
    if (!/^:?-+:?$/.test(c)) return null;
    aligns.push(c[0] === ':' ? (c.endsWith(':') ? 'center' : 'left') : (c.endsWith(':') ? 'right' : null));
  }
  return aligns;
}

class BlockParser {
  constructor() {
    this.doc = new Node('document'); this.doc.open = true;
    this.tip = this.doc; this.oldtip = this.doc;
    this.refmap = Object.create(null);
    this.lineNumber = 0;
  }
  findNextNonspace() {
    let i = this.offset, cols = this.column, c;
    while ((c = this.ln[i]) !== undefined) {
      if (c === ' ') { i++; cols++; } else if (c === '\t') { i++; cols += 4 - (cols % 4); } else break;
    }
    this.blank = c === undefined;
    this.nextNonspace = i; this.nextNonspaceColumn = cols;
    this.indent = cols - this.column; this.indented = this.indent >= 4;
  }
  advanceNextNonspace() { this.offset = this.nextNonspace; this.column = this.nextNonspaceColumn; this.partiallyConsumedTab = false; }
  advanceOffset(count, columns) {
    let c;
    while (count > 0 && (c = this.ln[this.offset]) !== undefined) {
      if (c === '\t') {
        const toTab = 4 - (this.column % 4);
        if (columns) {
          this.partiallyConsumedTab = toTab > count;
          const adv = Math.min(count, toTab);
          this.column += adv; this.offset += this.partiallyConsumedTab ? 0 : 1; count -= adv;
        } else { this.partiallyConsumedTab = false; this.column += toTab; this.offset++; count--; }
      } else { this.partiallyConsumedTab = false; this.offset++; this.column++; count--; }
    }
  }
  newBlock(type) { const n = new Node(type); n.open = true; n.string = ''; n.lastLineBlank = false; return n; }
  addChild(type) {
    while (!canContain(this.tip.type, type)) this.finalize(this.tip);
    const n = this.newBlock(type);
    this.tip.appendChild(n); this.tip = n;
    return n;
  }
  closeUnmatchedBlocks() {
    if (!this.allClosed) {
      while (this.oldtip !== this.lastMatchedContainer) {
        const p = this.oldtip.parent; this.finalize(this.oldtip); this.oldtip = p;
      }
      this.allClosed = true;
    }
  }
  addLine() {
    const t = this.tip;
    if (this.partiallyConsumedTab) {
      this.offset++;
      const n = 4 - (this.column % 4);
      t.string += ' '.repeat(n);
    }
    if (t.type === 'table') { t.rows.push(splitRow(this.ln.slice(this.offset))); return; }
    t.string += this.ln.slice(this.offset) + '\n';
  }
  continueBlock(c) {
    switch (c.type) {
      case 'document': case 'list': return 0;
      case 'block_quote':
        if (!this.indented && this.ln[this.nextNonspace] === '>') {
          this.advanceNextNonspace(); this.advanceOffset(1, false);
          if (isSpaceOrTab(this.ln[this.offset])) this.advanceOffset(1, true);
          return 0;
        }
        return 1;
      case 'item':
        if (this.blank) { if (c.firstChild === null) return 1; this.advanceNextNonspace(); return 0; }
        if (this.indent >= c.markerOffset + c.padding) { this.advanceOffset(c.markerOffset + c.padding, true); return 0; }
        return 1;
      case 'heading': case 'thematic_break': return 1;
      case 'code_block':
        if (c.fenced) {
          const m = this.indent <= 3 && this.ln[this.nextNonspace] === c.fenceChar && /^(`{3,}|~{3,})[ \t]*$/.exec(this.ln.slice(this.nextNonspace));
          if (m && m[1][0] === c.fenceChar && m[1].length >= c.fenceLength) { this.lastLineLength = this.ln.length; this.finalize(c); return 2; }
          let i = c.fenceOffset;
          while (i > 0 && isSpaceOrTab(this.ln[this.offset])) { this.advanceOffset(1, true); i--; }
        } else if (this.indent >= 4) this.advanceOffset(4, true);
        else if (this.blank) this.advanceNextNonspace();
        else return 1;
        return 0;
      case 'paragraph': return this.blank ? 1 : 0;
      case 'table': return this.blank ? 1 : 0;
    }
    return 1;
  }
  parseListMarker(container) {
    const rest = this.ln.slice(this.nextNonspace);
    if (this.indent >= 4) return null;
    const data = { ordered: false, tight: true, bulletChar: null, start: null, delimiter: null, padding: 0, markerOffset: this.indent };
    let m;
    if ((m = /^[*+-]/.exec(rest))) { data.bulletChar = m[0]; } else if ((m = /^(\d{1,9})([.)])/.exec(rest)) && (container.type !== 'paragraph' || m[1] === '1')) {
      data.ordered = true; data.start = parseInt(m[1], 10); data.delimiter = m[2];
    } else return null;
    const nextc = this.ln[this.nextNonspace + m[0].length];
    if (!(nextc === undefined || nextc === '\t' || nextc === ' ')) return null;
    if (container.type === 'paragraph' && !/[^ \t]/.test(this.ln.slice(this.nextNonspace + m[0].length))) return null;
    this.advanceNextNonspace(); this.advanceOffset(m[0].length, true);
    const spacesStartCol = this.column, spacesStartOffset = this.offset;
    let nc;
    do { this.advanceOffset(1, true); nc = this.ln[this.offset]; } while (this.column - spacesStartCol < 5 && isSpaceOrTab(nc));
    const blankItem = this.ln[this.offset] === undefined;
    const after = this.column - spacesStartCol;
    if (after >= 5 || after < 1 || blankItem) {
      data.padding = m[0].length + 1;
      this.column = spacesStartCol; this.offset = spacesStartOffset;
      if (isSpaceOrTab(this.ln[this.offset])) this.advanceOffset(1, true);
    } else data.padding = m[0].length + after;
    return data;
  }
  blockStart(container) {
    // returns 0 none, 1 container, 2 leaf
    const rest = this.ln.slice(this.nextNonspace);
    let m;
    if (!this.indented && rest[0] === '>') {
      this.advanceNextNonspace(); this.advanceOffset(1, false);
      if (isSpaceOrTab(this.ln[this.offset])) this.advanceOffset(1, true);
      this.closeUnmatchedBlocks(); this.addChild('block_quote'); return 1;
    }
    if (!this.indented && (m = /^#{1,6}(?:[ \t]+|$)/.exec(rest))) {
      this.advanceNextNonspace(); this.advanceOffset(m[0].length, false);
      this.closeUnmatchedBlocks();
      const c = this.addChild('heading'); c.level = m[0].trim().length;
      c.string = this.ln.slice(this.offset).replace(/^[ \t]*#+[ \t]*$/, '').replace(/[ \t]+#+[ \t]*$/, '');
      this.advanceOffset(this.ln.length - this.offset); return 2;
    }
    if (!this.indented && (m = /^`{3,}(?!.*`)|^~{3,}/.exec(rest))) {
      const fl = m[0].length;
      this.closeUnmatchedBlocks();
      const c = this.addChild('code_block'); c.fenced = true; c.fenceLength = fl; c.fenceChar = m[0][0]; c.fenceOffset = this.indent;
      this.advanceNextNonspace(); this.advanceOffset(fl, false); return 2;
    }
    if (!this.indented && container.type === 'paragraph' && (m = /^(?:=+|-+)[ \t]*$/.exec(rest))) {
      this.closeUnmatchedBlocks();
      this.resolveRefs(container);
      if (container.string.length > 0) {
        const h = this.newBlock('heading'); h.level = m[0][0] === '=' ? 1 : 2; h.string = container.string;
        container.insertAfter(h); container.unlink(); this.tip = h;
        this.advanceOffset(this.ln.length - this.offset, false); return 2;
      }
      return 0;
    }
    if (!this.indented && /^(?:\*[ \t]*){3,}$|^(?:_[ \t]*){3,}$|^(?:-[ \t]*){3,}$/.test(rest)) {
      this.closeUnmatchedBlocks(); this.addChild('thematic_break');
      this.advanceOffset(this.ln.length - this.offset, false); return 2;
    }
    if ((!this.indented || container.type === 'list')) {
      const data = this.parseListMarker(container);
      if (data) {
        this.closeUnmatchedBlocks();
        if (this.tip.type !== 'list' || !(this.tip.data.ordered === data.ordered && this.tip.data.delimiter === data.delimiter && this.tip.data.bulletChar === data.bulletChar)) {
          const l = this.addChild('list'); l.data = data; l.tight = true;
        }
        const it = this.addChild('item'); it.data = data; it.markerOffset = data.markerOffset; it.padding = data.padding; it.startLine = this.lineNumber;
        return 1;
      }
    }
    if (this.indented && this.tip.type !== 'paragraph' && !this.blank) {
      this.advanceOffset(4, true); this.closeUnmatchedBlocks();
      const c = this.addChild('code_block'); c.fenced = false; return 2;
    }
    return 0;
  }
  resolveRefs(p) {
    const ip = new InlineParser(this.refmap, null);
    let s = p.string, n;
    while (s[0] === '[' && (n = ip.parseReference(s)) > 0) s = s.slice(n);
    p.string = s.replace(/^\s+$/, '');
    if (!/[^ \t\n]/.test(p.string)) p.string = '';
  }
  incorporateLine(ln) {
    let allMatched = true;
    let container = this.doc;
    this.oldtip = this.tip; this.offset = 0; this.column = 0; this.blank = false; this.partiallyConsumedTab = false;
    this.lineNumber++; this.ln = ln;
    let lc;
    while ((lc = container.lastChild) && lc.open) {
      container = lc;
      this.findNextNonspace();
      const r = this.continueBlock(container);
      if (r === 1) { allMatched = false; } else if (r === 2) return;
      if (!allMatched) { container = container.parent; break; }
    }
    this.allClosed = container === this.oldtip;
    this.lastMatchedContainer = container;
    let matchedLeaf = container.type === 'code_block';
    while (!matchedLeaf) {
      this.findNextNonspace();
      if (!this.indented && !reMaybeSpecial.test(ln.slice(this.nextNonspace))) { this.advanceNextNonspace(); break; }
      const r = this.blockStart(container);
      if (r === 1) container = this.tip; else if (r === 2) { container = this.tip; matchedLeaf = true; } else { this.advanceNextNonspace(); break; }
    }
    if (!this.allClosed && !this.blank && this.tip.type === 'paragraph') {
      this.addLine();
    } else {
      this.closeUnmatchedBlocks();
      if (this.blank && container.lastChild) container.lastChild.lastLineBlank = true;
      const t = container.type;
      const llb = this.blank && !(t === 'block_quote' || (t === 'code_block' && container.fenced) || (t === 'item' && !container.firstChild && container.startLine === this.lineNumber));
      for (let c = container; c; c = c.parent) c.lastLineBlank = llb;
      if (t === 'paragraph' && !this.indented && this.tryTable(container)) return;
      if (t === 'code_block' || t === 'table' || t === 'paragraph') this.addLine();
      else if (this.offset < ln.length && !this.blank) {
        this.addChild('paragraph'); this.advanceNextNonspace(); this.addLine();
      }
    }
  }
  tryTable(p) {
    const rest = this.ln.slice(this.nextNonspace);
    const aligns = parseDelimRow(rest);
    if (!aligns) return false;
    const lines = p.string.replace(/\n$/, '').split('\n');
    const headerLine = lines[lines.length - 1];
    const header = splitRow(headerLine);
    if (header.length !== aligns.length) return false;
    const table = this.newBlock('table');
    table.header = header; table.aligns = aligns; table.rows = [];
    lines.pop();
    if (lines.length === 0) {
      p.insertAfter(table); p.unlink(); this.tip = table;
    } else {
      p.string = lines.join('\n') + '\n';
      this.finalize(p); // sets tip = parent (may unlink if only refs)
      const parent = p.parent || this.tip;
      parent.appendChild(table); this.tip = table;
    }
    this.advanceOffset(this.ln.length - this.offset);
    return true;
  }
  finalize(b) {
    b.open = false;
    this.tip = b.parent || this.doc;
    switch (b.type) {
      case 'paragraph':
        this.resolveRefs(b);
        if (b.string === '') b.unlink();
        break;
      case 'code_block':
        if (b.fenced) {
          const nl = b.string.indexOf('\n');
          b.info = unescapeString(b.string.slice(0, nl).trim());
          b.literal = b.string.slice(nl + 1);
        } else b.literal = b.string.replace(/(\n *)+$/, '\n');
        break;
      case 'list': {
        b.tight = true;
        let item = b.firstChild;
        while (item) {
          if (endsWithBlank(item) && item.next) { b.tight = false; break; }
          let sub = item.firstChild;
          while (sub) {
            if (endsWithBlank(sub) && (item.next || sub.next)) { b.tight = false; break; }
            sub = sub.next;
          }
          if (!b.tight) break;
          item = item.next;
        }
        break;
      }
    }
  }
  parse(input) {
    const lines = input.replace(/\u0000/g, '\uFFFD').split(/\r\n|\n|\r/);
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    for (const l of lines) this.incorporateLine(l);
    while (this.tip && this.tip !== this.doc) this.finalize(this.tip);
    this.doc.open = false;
    return this.doc;
  }
}
function endsWithBlank(b) {
  while (b) {
    if (b.lastLineBlank) return true;
    const t = b.type;
    if (!b._checked && (t === 'list' || t === 'item')) { b._checked = true; b = b.lastChild; } else { b._checked = true; break; }
  }
  return false;
}

function parseDocument(markdown, wikiLinks) {
  const bp = new BlockParser();
  const doc = bp.parse(String(markdown));
  const ip = new InlineParser(bp.refmap, wikiLinks);
  const walk = (n) => {
    for (let c = n.firstChild; c; c = c.next) {
      if (c.type === 'paragraph' || c.type === 'heading') {
        const root = new Node('inlines'); ip.parseInlines(root, c.string); c.inlines = root;
      } else if (c.type === 'table') {
        const cell = (s) => { const root = new Node('inlines'); ip.parseInlines(root, s); return root; };
        c.headerNodes = c.header.map(cell);
        const n = c.header.length;
        c.rowNodes = c.rows.map((r) => { const out = []; for (let i = 0; i < n; i++) out.push(cell(r[i] || '')); return out; });
      } else walk(c);
    }
  };
  walk(doc);
  return doc;
}

// ---------- rendering ----------
function plainText(n) {
  let s = '';
  for (let c = n.firstChild; c; c = c.next) {
    if (c.type === 'text' || c.type === 'code') s += c.literal;
    else if (c.type === 'softbreak' || c.type === 'linebreak') s += ' ';
    else if (c.type === 'wikilink') s += c.literal;
    else s += plainText(c);
  }
  return s;
}

function renderInlines(n, ctx) {
  let out = '';
  for (let c = n.firstChild; c; c = c.next) {
    switch (c.type) {
      case 'text': out += esc(c.literal); break;
      case 'softbreak': out += '\n'; break;
      case 'linebreak': out += '<br />\n'; break;
      case 'code': out += '<code>' + esc(c.literal) + '</code>'; break;
      case 'emph': out += '<em>' + renderInlines(c, ctx) + '</em>'; break;
      case 'strong': out += '<strong>' + renderInlines(c, ctx) + '</strong>'; break;
      case 'del': out += '<del>' + renderInlines(c, ctx) + '</del>'; break;
      case 'link': out += '<a href="' + esc(safeUrl(c.destination)) + '"' + (c.title ? ' title="' + esc(c.title) + '"' : '') + '>' + renderInlines(c, ctx) + '</a>'; break;
      case 'image': out += '<img src="' + esc(safeUrl(c.destination)) + '" alt="' + esc(plainText(c)) + '"' + (c.title ? ' title="' + esc(c.title) + '"' : '') + ' />'; break;
      case 'wikilink': {
        const slug = slugify(c.target);
        if (ctx.wikiLinks.exists) { /* resolved below */ }
        const ex = !!ctx.wikiLinks.exists(slug);
        out += '<a href="/wiki/' + esc(slug) + '" class="wikilink' + (ex ? '' : ' missing') + '">' + esc(c.literal) + '</a>';
        break;
      }
    }
  }
  return out;
}

function renderBlocks(doc, opts) {
  let out = '';
  const seen = new Map();
  const cr = () => { if (out && !out.endsWith('\n')) out += '\n'; };
  const ctx = { wikiLinks: opts.wikiLinks };
  const visit = (n) => {
    for (let c = n.firstChild; c; c = c.next) {
      switch (c.type) {
        case 'paragraph': {
          const tight = n.type === 'item' && n.parent && n.parent.tight;
          if (tight) out += renderInlines(c.inlines, ctx);
          else { cr(); out += '<p>' + renderInlines(c.inlines, ctx) + '</p>'; cr(); }
          break;
        }
        case 'heading': {
          cr();
          let id = '';
          if (opts.headingIds) id = ' id="' + esc(slugify(plainText(c.inlines), seen)) + '"';
          out += `<h${c.level}${id}>` + renderInlines(c.inlines, ctx) + `</h${c.level}>`; cr();
          break;
        }
        case 'block_quote': cr(); out += '<blockquote>'; cr(); visit(c); cr(); out += '</blockquote>'; cr(); break;
        case 'list': {
          cr();
          const tag = c.data.ordered ? 'ol' : 'ul';
          out += '<' + tag + (c.data.ordered && c.data.start !== 1 ? ` start="${c.data.start}"` : '') + '>'; cr();
          visit(c); cr(); out += `</${tag}>`; cr();
          break;
        }
        case 'item': out += '<li>'; visit(c); out += '</li>'; cr(); break;
        case 'code_block': {
          cr();
          const w = c.fenced ? (c.info || '').split(/\s+/)[0] : '';
          out += '<pre><code' + (w ? ` class="language-${esc(w)}"` : '') + '>' + esc(c.literal) + '</code></pre>'; cr();
          break;
        }
        case 'thematic_break': cr(); out += '<hr />'; cr(); break;
        case 'table': {
          cr();
          const al = (i) => (c.aligns[i] ? ` align="${c.aligns[i]}"` : '');
          out += '<table>\n<thead>\n<tr>\n';
          c.headerNodes.forEach((h, i) => { out += `<th${al(i)}>` + renderInlines(h, ctx) + '</th>\n'; });
          out += '</tr>\n</thead>\n';
          if (c.rowNodes.length) {
            out += '<tbody>\n';
            for (const r of c.rowNodes) {
              out += '<tr>\n';
              r.forEach((h, i) => { out += `<td${al(i)}>` + renderInlines(h, ctx) + '</td>\n'; });
              out += '</tr>\n';
            }
            out += '</tbody>\n';
          }
          out += '</table>'; cr();
          break;
        }
      }
    }
  };
  visit(doc);
  return out;
}

export function render(markdown, { headingIds = false, wikiLinks } = {}) {
  const doc = parseDocument(markdown, wikiLinks || null);
  return renderBlocks(doc, { headingIds, wikiLinks });
}

export function toc(markdown) {
  const doc = parseDocument(markdown, null);
  const seen = new Map(); const res = [];
  const walk = (n) => {
    for (let c = n.firstChild; c; c = c.next) {
      if (c.type === 'heading') { const text = plainText(c.inlines); res.push({ level: c.level, text, slug: slugify(text, seen) }); } else if (c.type === 'block_quote' || c.type === 'list' || c.type === 'item') walk(c);
    }
  };
  walk(doc);
  return res;
}
