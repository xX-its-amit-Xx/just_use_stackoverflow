// CommonMark (+ GFM tables / strikethrough) renderer — original implementation.
import { ENTITIES } from './entities.js';

// ---------------------------------------------------------------- utilities

const ESCAPABLE_RE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const ENTITY_SRC = '&(?:#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});';
const ENTITY_RE = new RegExp('^' + ENTITY_SRC);
const UNESCAPE_RE = new RegExp('\\\\[!"#$%&\'()*+,\\-./:;<=>?@[\\\\\\]^_`{|}~]|' + ENTITY_SRC, 'g');

function decodeEntity(ent) {
  // ent includes & and ;
  const body = ent.slice(1, -1);
  if (body[0] === '#') {
    let cp = (body[1] === 'x' || body[1] === 'X') ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    if (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
    return String.fromCodePoint(cp);
  }
  if (Object.prototype.hasOwnProperty.call(ENTITIES, body)) return ENTITIES[body];
  return null;
}

function unescapeString(s) {
  if (!/[\\&]/.test(s)) return s;
  return s.replace(UNESCAPE_RE, (m) => {
    if (m[0] === '\\') return m[1];
    const d = decodeEntity(m);
    return d === null ? m : d;
  });
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}

const URI_SAFE = /[A-Za-z0-9;\/?:@&=+$,\-_.!~*'()#]/;
function normalizeURI(uri) {
  let out = '';
  for (let i = 0; i < uri.length; i++) {
    const c = uri[i];
    if (c === '%' && /^[0-9a-fA-F]{2}$/.test(uri.slice(i + 1, i + 3))) { out += uri.slice(i, i + 3); i += 2; continue; }
    if (URI_SAFE.test(c)) { out += c; continue; }
    const code = c.charCodeAt(0);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < uri.length) {
      const n = uri.charCodeAt(i + 1);
      if (n >= 0xdc00 && n <= 0xdfff) { out += encodeURIComponent(c + uri[i + 1]); i++; continue; }
      out += '%EF%BF%BD'; continue;
    }
    if (code >= 0xd800 && code <= 0xdfff) { out += '%EF%BF%BD'; continue; }
    out += encodeURIComponent(c);
  }
  return out;
}

const UNSAFE_PROTO = /^\s*(?:javascript|vbscript|file|data):/i;
const SAFE_DATA = /^\s*data:image\/(?:png|gif|jpeg|webp);/i;
function safeUrl(url) {
  if (UNSAFE_PROTO.test(url) && !SAFE_DATA.test(url)) return '#';
  return url;
}

function normalizeLabel(label) {
  return label.slice(1, -1).trim().replace(/[ \t\r\n]+/g, ' ').toLowerCase().toUpperCase();
}

export function slugify(text, seen) {
  const base = String(text).toLowerCase().replace(/[^\p{L}\p{M}\p{N} _-]/gu, '').replace(/ /g, '-');
  if (!(seen instanceof Map)) return base;
  let slug = base;
  if (seen.has(base)) {
    let n = seen.get(base);
    do { n++; slug = base + '-' + n; } while (seen.has(slug));
    seen.set(base, n);
  }
  if (!seen.has(slug)) seen.set(slug, 0);
  return slug;
}

// ---------------------------------------------------------------- nodes

class Node {
  constructor(type, props) {
    this.type = type;
    this.parent = null; this.firstChild = null; this.lastChild = null; this.prev = null; this.next = null;
    if (props) Object.assign(this, props);
  }
  appendChild(c) {
    c.unlink();
    c.parent = this;
    if (this.lastChild) { this.lastChild.next = c; c.prev = this.lastChild; this.lastChild = c; }
    else { this.firstChild = this.lastChild = c; }
  }
  insertAfter(s) {
    s.unlink();
    s.next = this.next;
    if (s.next) s.next.prev = s;
    s.prev = this; this.next = s; s.parent = this.parent;
    if (!s.next && s.parent) s.parent.lastChild = s;
  }
  unlink() {
    if (this.prev) this.prev.next = this.next; else if (this.parent) this.parent.firstChild = this.next;
    if (this.next) this.next.prev = this.prev; else if (this.parent) this.parent.lastChild = this.prev;
    this.parent = this.prev = this.next = null;
  }
  children() { const a = []; for (let c = this.firstChild; c; c = c.next) a.push(c); return a; }
}

const text = (s) => new Node('text', { literal: s });

// ---------------------------------------------------------------- inline parser

const WS_CHAR = /^[ \t\n\x0b\x0c\r]$/;
const UNICODE_WS = /^\s$/u;
const PUNCT = /^[\p{P}\p{S}]$/u;
const SPECIAL = /^[^\n`\[\]\\!<&*_~]+/;
const AUTOLINK_RE = /^<[A-Za-z][A-Za-z0-9.+-]{1,31}:[^<>\x00-\x20]*>/;
const EMAIL_RE = /^<([a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/;
const LABEL_RE = /^\[(?:[^\\\[\]]|\\[\s\S]){0,999}\]/;
const TITLE_RE = /^(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^()\\])*\))/;
const WIKI_RE = /^\[\[([^\[\]|\n]+)(?:\|([^\[\]\n]*))?\]\]/;

class InlineParser {
  constructor(refmap, opts) {
    this.refmap = refmap || {};
    this.opts = opts || {};
    this.subject = ''; this.pos = 0; this.delimiters = null; this.brackets = null;
  }
  peek() { return this.pos < this.subject.length ? this.subject[this.pos] : null; }
  match(re) {
    const m = re.exec(this.subject.slice(this.pos));
    if (!m) return null;
    this.pos += m.index + m[0].length;
    return m[0];
  }
  spnl() { this.match(/^[ \t]*(?:\n[ \t]*)?/); return true; }

  parse(block, content) {
    this.subject = content.replace(/^[ \t\n]+|[ \t\n]+$/g, '');
    this.pos = 0; this.delimiters = null; this.brackets = null;
    while (this.parseInline(block)) { /* loop */ }
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
      case '<': res = this.parseAutolink(block); break;
      case '&': res = this.parseEntity(block); break;
      default: res = this.parseString(block);
    }
    if (!res) { this.pos++; block.appendChild(text(c)); }
    return true;
  }

  parseString(block) {
    const m = this.match(SPECIAL);
    if (m === null) return false;
    block.appendChild(text(m));
    return true;
  }

  parseNewline(block) {
    this.pos++;
    const last = block.lastChild;
    if (last && last.type === 'text' && last.literal[last.literal.length - 1] === ' ') {
      const hard = last.literal[last.literal.length - 2] === ' ';
      last.literal = last.literal.replace(/ +$/, '');
      block.appendChild(new Node(hard ? 'linebreak' : 'softbreak'));
    } else {
      block.appendChild(new Node('softbreak'));
    }
    this.match(/^ */);
    return true;
  }

  parseBackslash(block) {
    const s = this.subject;
    this.pos++;
    const n = this.peek();
    if (n === '\n') { this.pos++; block.appendChild(new Node('linebreak')); this.match(/^ */); }
    else if (n !== null && ESCAPABLE_RE.test(n)) { this.pos++; block.appendChild(text(n)); }
    else block.appendChild(text('\\'));
    void s;
    return true;
  }

  parseBackticks(block) {
    const ticks = this.match(/^`+/);
    const after = this.pos;
    const re = /`+/g;
    re.lastIndex = after;
    let m;
    while ((m = re.exec(this.subject))) {
      if (m[0].length === ticks.length) {
        let content = this.subject.slice(after, m.index).replace(/\n/g, ' ');
        if (content.length > 0 && /[^ ]/.test(content) && content[0] === ' ' && content[content.length - 1] === ' ') {
          content = content.slice(1, -1);
        }
        this.pos = m.index + m[0].length;
        block.appendChild(new Node('code', { literal: content }));
        return true;
      }
    }
    this.pos = after;
    block.appendChild(text(ticks));
    return true;
  }

  scanDelims(cc) {
    const start = this.pos;
    let n = 0;
    while (this.subject[this.pos + n] === cc) n++;
    if (n === 0) return null;
    const before = start === 0 ? '\n' : charBefore(this.subject, start);
    const after = start + n >= this.subject.length ? '\n' : charAt(this.subject, start + n);
    const afterWS = UNICODE_WS.test(after);
    const afterP = PUNCT.test(after);
    const beforeWS = UNICODE_WS.test(before);
    const beforeP = PUNCT.test(before);
    const left = !afterWS && (!afterP || beforeWS || beforeP);
    const right = !beforeWS && (!beforeP || afterWS || afterP);
    let canOpen, canClose;
    if (cc === '_') { canOpen = left && (!right || beforeP); canClose = right && (!left || afterP); }
    else { canOpen = left; canClose = right; }
    return { n, canOpen, canClose };
  }

  handleDelim(cc, block) {
    const res = this.scanDelims(cc);
    if (!res) return false;
    const start = this.pos;
    this.pos += res.n;
    const node = text(this.subject.slice(start, this.pos));
    block.appendChild(node);
    if (cc === '~' && res.n > 2) return true;
    if (res.canOpen || res.canClose) {
      this.delimiters = {
        cc, numdelims: res.n, origdelims: res.n, node, previous: this.delimiters, next: null,
        canOpen: res.canOpen, canClose: res.canClose,
      };
      if (this.delimiters.previous) this.delimiters.previous.next = this.delimiters;
    }
    return true;
  }

  removeDelimiter(d) {
    if (d.previous) d.previous.next = d.next;
    if (d.next) d.next.previous = d.previous; else this.delimiters = d.previous;
  }

  processEmphasis(stackBottom) {
    const openersBottom = {};
    let closer = this.delimiters;
    while (closer && closer.previous !== stackBottom) closer = closer.previous;
    while (closer) {
      if (!closer.canClose) { closer = closer.next; continue; }
      const cc = closer.cc;
      const key = cc + (closer.canOpen ? '1' : '0') + (closer.origdelims % 3);
      let opener = closer.previous;
      let found = false;
      while (opener && opener !== stackBottom && opener !== openersBottom[key]) {
        const odd = (closer.canOpen || opener.canClose) && closer.origdelims % 3 !== 0 &&
          (opener.origdelims + closer.origdelims) % 3 === 0;
        if (opener.cc === cc && opener.canOpen) {
          if (cc === '~') { if (opener.numdelims === closer.numdelims) { found = true; break; } }
          else if (!odd) { found = true; break; }
        }
        opener = opener.previous;
      }
      const oldCloser = closer;
      if (found) {
        const use = cc === '~' ? closer.numdelims : (closer.numdelims >= 2 && opener.numdelims >= 2 ? 2 : 1);
        const oi = opener.node, ci = closer.node;
        opener.numdelims -= use; closer.numdelims -= use;
        oi.literal = oi.literal.slice(0, oi.literal.length - use);
        ci.literal = ci.literal.slice(0, ci.literal.length - use);
        const emph = new Node(cc === '~' ? 'del' : use === 1 ? 'emph' : 'strong');
        let tmp = oi.next;
        while (tmp && tmp !== ci) { const nx = tmp.next; emph.appendChild(tmp); tmp = nx; }
        oi.insertAfter(emph);
        if (closer.previous !== opener) { opener.next = closer; closer.previous = opener; }
        if (opener.numdelims === 0) { oi.unlink(); this.removeDelimiter(opener); }
        if (closer.numdelims === 0) {
          ci.unlink();
          const nx = closer.next;
          this.removeDelimiter(closer);
          closer = nx;
        }
      } else {
        closer = closer.next;
        openersBottom[key] = oldCloser.previous;
        if (!oldCloser.canOpen) this.removeDelimiter(oldCloser);
      }
    }
    while (this.delimiters !== null && this.delimiters !== stackBottom) this.removeDelimiter(this.delimiters);
  }

  addBracket(node, index, image) {
    if (this.brackets) this.brackets.bracketAfter = true;
    this.brackets = { node, previous: this.brackets, previousDelimiter: this.delimiters, index, image, active: true, bracketAfter: false };
  }
  removeBracket() { this.brackets = this.brackets.previous; }

  parseOpenBracket(block) {
    if (this.opts.wikiLinks && this.subject[this.pos + 1] === '[') {
      const m = WIKI_RE.exec(this.subject.slice(this.pos));
      if (m && m[1].trim()) {
        const target = m[1].trim();
        const label = m[2] !== undefined && m[2].trim() ? m[2].trim() : target;
        const slug = slugify(target);
        if (slug) {
          this.pos += m[0].length;
          block.appendChild(new Node('wikilink', { slug, label }));
          return true;
        }
      }
    }
    this.pos++;
    const node = text('[');
    block.appendChild(node);
    this.addBracket(node, this.pos, false);
    return true;
  }

  parseBang(block) {
    this.pos++;
    if (this.peek() === '[') {
      this.pos++;
      const node = text('![');
      block.appendChild(node);
      this.addBracket(node, this.pos, true);
    } else block.appendChild(text('!'));
    return true;
  }

  parseLinkLabel() {
    const m = LABEL_RE.exec(this.subject.slice(this.pos));
    if (!m) return 0;
    this.pos += m[0].length;
    return m[0].length;
  }

  parseLinkDestination() {
    const m = this.match(/^<(?:[^<>\n\\\x00]|\\[\s\S])*>/);
    if (m !== null) return normalizeURI(unescapeString(m.slice(1, -1)));
    if (this.peek() === '<') return null;
    const save = this.pos;
    let open = 0;
    const s = this.subject;
    while (this.pos < s.length) {
      const c = s[this.pos];
      if (c === '\\' && this.pos + 1 < s.length && ESCAPABLE_RE.test(s[this.pos + 1])) { this.pos += 2; continue; }
      if (c === '(') { open++; this.pos++; continue; }
      if (c === ')') { if (open < 1) break; open--; this.pos++; continue; }
      const code = c.charCodeAt(0);
      if (code <= 0x20 || code === 0x7f) break;
      this.pos++;
    }
    if (this.pos === save && s[this.pos] !== ')') return null;
    if (open !== 0) { this.pos = save; return null; }
    return normalizeURI(unescapeString(s.slice(save, this.pos)));
  }

  parseLinkTitle() {
    const m = this.match(TITLE_RE);
    if (m === null) return null;
    return unescapeString(m.slice(1, -1));
  }

  parseCloseBracket(block) {
    const startpos = this.pos;
    this.pos++;
    const opener = this.brackets;
    if (!opener) { block.appendChild(text(']')); return true; }
    if (!opener.active) { block.appendChild(text(']')); this.removeBracket(); return true; }
    const isImage = opener.image;
    const savepos = this.pos;
    let matched = false, dest = null, title = null;
    if (this.peek() === '(') {
      this.pos++;
      this.spnl();
      dest = this.parseLinkDestination();
      if (dest !== null) {
        this.spnl();
        if (WS_CHAR.test(this.subject[this.pos - 1] || '')) title = this.parseLinkTitle();
        this.spnl();
        if (this.peek() === ')') { this.pos++; matched = true; }
      }
      if (!matched) this.pos = savepos;
    }
    if (!matched) {
      const beforelabel = this.pos;
      const n = this.parseLinkLabel();
      let reflabel = null;
      if (n > 2) reflabel = this.subject.slice(beforelabel, beforelabel + n);
      else if (!opener.bracketAfter) reflabel = '[' + this.subject.slice(opener.index, startpos) + ']';
      if (n === 0) this.pos = savepos;
      if (reflabel) {
        const ref = this.refmap[normalizeLabel(reflabel)];
        if (ref) { dest = ref.destination; title = ref.title; matched = true; }
      }
    }
    if (matched) {
      const node = new Node(isImage ? 'image' : 'link', { destination: dest, title: title || '' });
      let tmp = opener.node.next;
      while (tmp) { const nx = tmp.next; node.appendChild(tmp); tmp = nx; }
      block.appendChild(node);
      this.processEmphasis(opener.previousDelimiter);
      this.removeBracket();
      opener.node.unlink();
      if (!isImage) {
        for (let o = this.brackets; o; o = o.previous) if (!o.image) o.active = false;
      }
      return true;
    }
    this.removeBracket();
    this.pos = startpos + 1;
    block.appendChild(text(']'));
    return true;
  }

  parseAutolink(block) {
    let m;
    if ((m = this.match(EMAIL_RE))) {
      const dest = m.slice(1, -1);
      const link = new Node('link', { destination: normalizeURI('mailto:' + dest), title: '' });
      link.appendChild(text(dest));
      block.appendChild(link);
      return true;
    }
    if ((m = this.match(AUTOLINK_RE))) {
      const dest = m.slice(1, -1);
      const link = new Node('link', { destination: normalizeURI(dest), title: '' });
      link.appendChild(text(dest));
      block.appendChild(link);
      return true;
    }
    return false;
  }

  parseEntity(block) {
    const m = ENTITY_RE.exec(this.subject.slice(this.pos));
    if (!m) return false;
    const d = decodeEntity(m[0]);
    if (d === null) return false;
    this.pos += m[0].length;
    block.appendChild(text(d));
    return true;
  }

  // Link reference definition parsing at start of s. Returns chars consumed.
  parseReference(s, refmap) {
    this.subject = s; this.pos = 0;
    const n = this.parseLinkLabel();
    if (n === 0) return 0;
    const rawlabel = s.slice(0, n);
    if (this.peek() !== ':') return 0;
    this.pos++;
    this.spnl();
    if (this.pos >= s.length) return 0;
    const dest = this.parseLinkDestination();
    if (dest === null) return 0;
    if (dest === '' && s[this.pos - 1] !== '>') return 0;
    const beforetitle = this.pos;
    this.spnl();
    let title = null;
    if (this.pos !== beforetitle) title = this.parseLinkTitle();
    if (title === null) { title = ''; this.pos = beforetitle; }
    let atLineEnd = true;
    if (this.match(/^[ \t]*(?:\n|$)/) === null) {
      if (title === '') atLineEnd = false;
      else {
        title = ''; this.pos = beforetitle;
        atLineEnd = this.match(/^[ \t]*(?:\n|$)/) !== null;
      }
    }
    if (!atLineEnd) return 0;
    const norm = normalizeLabel(rawlabel);
    if (norm === '') return 0;
    if (!Object.prototype.hasOwnProperty.call(refmap, norm)) refmap[norm] = { destination: dest, title };
    return this.pos;
  }
}

function charAt(s, i) {
  const cp = s.codePointAt(i);
  return String.fromCodePoint(cp);
}
function charBefore(s, i) {
  const c = s.charCodeAt(i - 1);
  if (c >= 0xdc00 && c <= 0xdfff && i >= 2) {
    const h = s.charCodeAt(i - 2);
    if (h >= 0xd800 && h <= 0xdbff) return s.slice(i - 2, i);
  }
  return s[i - 1];
}

// ---------------------------------------------------------------- block parser

const MAYBE_SPECIAL = /^[#`~*+_=<>0-9|:-]/;
const THEMATIC = /^(?:\*[ \t]*){3,}$|^(?:_[ \t]*){3,}$|^(?:-[ \t]*){3,}$/;
const ATX = /^#{1,6}(?:[ \t]+|$)/;
const FENCE = /^`{3,}(?!.*`)|^~{3,}/;
const CLOSE_FENCE = /^(?:`{3,}|~{3,})(?=[ \t]*$)/;
const SETEXT = /^(?:=+|-+)[ \t]*$/;
const BULLET = /^[*+-]/;
const ORDERED = /^(\d{1,9})([.)])/;

const isSpaceOrTab = (c) => c === ' ' || c === '\t';

function splitRow(line) {
  let s = line.trim();
  if (s[0] === '|') s = s.slice(1);
  if (s.length && s[s.length - 1] === '|') {
    // trailing pipe unless escaped
    let bs = 0, i = s.length - 2;
    while (i >= 0 && s[i] === '\\') { bs++; i--; }
    if (bs % 2 === 0) s = s.slice(0, -1);
  }
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '\\' && i + 1 < s.length) { cur += c + s[i + 1]; i++; continue; }
    if (c === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function parseDelimRow(line) {
  const s = line.trim();
  if (!/^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?$/.test(s)) return null;
  const cells = splitRow(s);
  return cells.map((c) => {
    const l = c[0] === ':', r = c[c.length - 1] === ':';
    return l && r ? 'center' : l ? 'left' : r ? 'right' : '';
  });
}

class BlockParser {
  constructor(opts) {
    this.opts = opts || {};
    this.refmap = {};
  }

  parse(input) {
    this.doc = new Node('document', { open: true, string: '' });
    this.tip = this.doc;
    this.oldtip = this.doc;
    this.lineNumber = 0;
    this.refmap = {};
    let src = String(input).replace(/\r\n?/g, '\n').replace(/\0/g, '\ufffd');
    const lines = src.split('\n');
    if (src.length > 0 && src[src.length - 1] === '\n') lines.pop();
    for (const l of lines) this.incorporateLine(l);
    while (this.tip) this.finalize(this.tip);
    this.processInlines(this.doc);
    return this.doc;
  }

  findNextNonspace() {
    const ln = this.ln;
    let i = this.offset, cols = this.column, c;
    while ((c = ln[i]) !== undefined) {
      if (c === ' ') { i++; cols++; }
      else if (c === '\t') { i++; cols += 4 - (cols % 4); }
      else break;
    }
    this.blank = c === undefined || c === '\n' || c === '\r';
    this.nextNonspace = i;
    this.nextNonspaceColumn = cols;
    this.indent = cols - this.column;
    this.indented = this.indent >= 4;
  }

  advanceOffset(count, columns) {
    const ln = this.ln;
    let c;
    while (count > 0 && (c = ln[this.offset]) !== undefined) {
      if (c === '\t') {
        const charsToTab = 4 - (this.column % 4);
        if (columns) {
          this.partiallyConsumedTab = charsToTab > count;
          const adv = charsToTab > count ? count : charsToTab;
          this.column += adv;
          this.offset += this.partiallyConsumedTab ? 0 : 1;
          count -= adv;
        } else {
          this.partiallyConsumedTab = false;
          this.column += charsToTab;
          this.offset++;
          count--;
        }
      } else {
        this.partiallyConsumedTab = false;
        this.offset++; this.column++; count--;
      }
    }
  }

  advanceNextNonspace() {
    this.offset = this.nextNonspace;
    this.column = this.nextNonspaceColumn;
    this.partiallyConsumedTab = false;
  }

  addLine() {
    if (this.partiallyConsumedTab) {
      this.offset++;
      const charsToTab = 4 - (this.column % 4);
      this.tip.string += ' '.repeat(charsToTab);
    }
    this.tip.string += this.ln.slice(this.offset) + '\n';
  }

  addChild(type, props) {
    while (!canContain(this.tip.type, type)) this.finalize(this.tip);
    const node = new Node(type, Object.assign({ open: true, string: '', startLine: this.lineNumber, lastLineBlank: false }, props));
    this.tip.appendChild(node);
    this.tip = node;
    return node;
  }

  closeUnmatchedBlocks() {
    if (!this.allClosed) {
      while (this.oldtip !== this.lastMatchedContainer) {
        const parent = this.oldtip.parent;
        this.finalize(this.oldtip);
        this.oldtip = parent;
      }
      this.allClosed = true;
    }
  }

  finalize(block) {
    const above = block.parent;
    block.open = false;
    switch (block.type) {
      case 'paragraph': {
        let content = block.string;
        let consumed;
        const ip = new InlineParser();
        while (content[0] === '[' && (consumed = ip.parseReference(content, this.refmap))) {
          content = content.slice(consumed);
        }
        block.string = content;
        if (/^[ \t\n]*$/.test(content)) block.unlink();
        break;
      }
      case 'code_block': {
        if (block.fenced) {
          const nl = block.string.indexOf('\n');
          const first = block.string.slice(0, nl);
          block.info = unescapeString(first.trim());
          block.literal = block.string.slice(nl + 1);
        } else {
          block.literal = block.string.replace(/(\n *)+$/, '\n');
        }
        break;
      }
      case 'list': {
        let tight = true;
        outer: for (let item = block.firstChild; item; item = item.next) {
          if (endsWithBlankLine(item) && item.next) { tight = false; break; }
          for (let sub = item.firstChild; sub; sub = sub.next) {
            if (endsWithBlankLine(sub) && (item.next || sub.next)) { tight = false; break outer; }
          }
        }
        block.tight = tight;
        break;
      }
      case 'table': {
        const rows = block.string.split('\n');
        block.rows = rows.filter((r) => r.trim() !== '').map(splitRow);
        break;
      }
      default:
    }
    this.tip = above;
  }

  // continuation: 0 matched, 1 not matched, 2 line consumed
  cont(container) {
    const ln = this.ln;
    switch (container.type) {
      case 'document': case 'list': return 0;
      case 'block_quote':
        if (!this.indented && ln[this.nextNonspace] === '>') {
          this.advanceNextNonspace();
          this.advanceOffset(1, false);
          if (isSpaceOrTab(ln[this.offset])) this.advanceOffset(1, true);
          return 0;
        }
        return 1;
      case 'item':
        if (this.blank) {
          if (container.firstChild === null) return 1;
          this.advanceNextNonspace();
        } else if (this.indent >= container.markerOffset + container.padding) {
          this.advanceOffset(container.markerOffset + container.padding, true);
        } else return 1;
        return 0;
      case 'heading': case 'thematic_break': return 1;
      case 'code_block':
        if (container.fenced) {
          const m = this.indent <= 3 && ln[this.nextNonspace] === container.fenceChar && CLOSE_FENCE.exec(ln.slice(this.nextNonspace));
          if (m && m[0].length >= container.fenceLength) {
            this.lastLineLength = ln.length;
            this.finalize(container);
            return 2;
          }
          let i = container.fenceOffset;
          while (i > 0 && isSpaceOrTab(ln[this.offset])) { this.advanceOffset(1, true); i--; }
          return 0;
        }
        if (this.indent >= 4) this.advanceOffset(4, true);
        else if (this.blank) this.advanceNextNonspace();
        else return 1;
        return 0;
      case 'paragraph': return this.blank ? 1 : 0;
      case 'table': {
        if (this.blank) return 1;
        if (!this.indented) {
          const rest = ln.slice(this.nextNonspace);
          if (rest[0] === '>' || ATX.test(rest) || FENCE.test(rest) || THEMATIC.test(rest)) return 1;
        }
        return 0;
      }
      default: return 0;
    }
  }

  tryStarts(container) {
    const ln = this.ln;
    const rest = ln.slice(this.nextNonspace);
    // block quote
    if (!this.indented && rest[0] === '>') {
      this.advanceNextNonspace();
      this.advanceOffset(1, false);
      if (isSpaceOrTab(ln[this.offset])) this.advanceOffset(1, true);
      this.closeUnmatchedBlocks();
      this.addChild('block_quote');
      return 1;
    }
    // ATX heading
    let m;
    if (!this.indented && (m = ATX.exec(rest))) {
      this.advanceNextNonspace();
      this.advanceOffset(m[0].length, false);
      this.closeUnmatchedBlocks();
      const h = this.addChild('heading', { level: m[0].trim().length });
      h.string = ln.slice(this.offset).replace(/^[ \t]*#+[ \t]*$/, '').replace(/[ \t]+#+[ \t]*$/, '');
      this.advanceOffset(ln.length - this.offset);
      return 2;
    }
    // fenced code
    if (!this.indented && (m = FENCE.exec(rest))) {
      const len = m[0].length;
      this.closeUnmatchedBlocks();
      this.addChild('code_block', { fenced: true, fenceLength: len, fenceChar: m[0][0], fenceOffset: this.indent });
      this.advanceNextNonspace();
      this.advanceOffset(len, false);
      return 2;
    }
    // setext heading
    if (!this.indented && container.type === 'paragraph' && SETEXT.test(rest)) {
      this.closeUnmatchedBlocks();
      let content = container.string;
      let consumed;
      const ip = new InlineParser();
      while (content[0] === '[' && (consumed = ip.parseReference(content, this.refmap))) content = content.slice(consumed);
      container.string = content;
      if (content.length > 0 && !/^[ \t\n]*$/.test(content)) {
        const h = new Node('heading', { open: true, level: rest[0] === '=' ? 1 : 2, string: content, lastLineBlank: false });
        container.insertAfter(h);
        container.unlink();
        this.tip = h;
        this.advanceOffset(ln.length - this.offset, false);
        return 2;
      }
      return 0;
    }
    // GFM table
    if (!this.indented && container.type === 'paragraph') {
      const aligns = parseDelimRow(rest);
      if (aligns) {
        const plines = container.string.replace(/\n$/, '').split('\n');
        const header = plines[plines.length - 1];
        const hcells = splitRow(header);
        if (hcells.length === aligns.length && (header.includes('|') || rest.includes('|'))) {
          this.closeUnmatchedBlocks();
          const table = new Node('table', { open: true, string: '', aligns, header: hcells, lastLineBlank: false });
          container.insertAfter(table);
          if (plines.length > 1) {
            container.string = plines.slice(0, -1).join('\n') + '\n';
            this.finalize(container);
          } else {
            container.unlink();
          }
          this.tip = table;
          this.advanceOffset(ln.length - this.offset, false);
          return 2;
        }
      }
    }
    // thematic break
    if (!this.indented && THEMATIC.test(rest)) {
      this.closeUnmatchedBlocks();
      this.addChild('thematic_break');
      this.advanceOffset(ln.length - this.offset, false);
      return 2;
    }
    // list item
    if (!this.indented || container.type === 'list') {
      const data = this.parseListMarker(container);
      if (data) {
        this.closeUnmatchedBlocks();
        if (this.tip.type !== 'list' || !listsMatch(this.tip, data)) {
          this.addChild('list', { listType: data.listType, bulletChar: data.bulletChar, start: data.start, delimiter: data.delimiter, tight: true });
        }
        this.addChild('item', data);
        return 1;
      }
    }
    // indented code
    if (this.indented && this.tip.type !== 'paragraph' && !this.blank) {
      this.advanceOffset(4, true);
      this.closeUnmatchedBlocks();
      this.addChild('code_block', { fenced: false });
      return 2;
    }
    return 0;
  }

  parseListMarker(container) {
    const ln = this.ln;
    if (this.indent >= 4) return null;
    const rest = ln.slice(this.nextNonspace);
    const data = { listType: null, bulletChar: null, start: null, delimiter: null, padding: 0, markerOffset: this.indent };
    let m, mlen;
    if ((m = BULLET.exec(rest))) {
      data.listType = 'bullet'; data.bulletChar = m[0]; mlen = 1;
    } else if ((m = ORDERED.exec(rest)) && (container.type !== 'paragraph' || m[1] === '1')) {
      data.listType = 'ordered'; data.start = parseInt(m[1], 10); data.delimiter = m[2]; mlen = m[0].length;
    } else return null;
    const nextc = ln[this.nextNonspace + mlen];
    if (!(nextc === undefined || nextc === '\t' || nextc === ' ')) return null;
    if (container.type === 'paragraph' && !/[^ \t]/.test(ln.slice(this.nextNonspace + mlen))) return null;
    this.advanceNextNonspace();
    this.advanceOffset(mlen, true);
    const spacesStartCol = this.column, spacesStartOffset = this.offset;
    let nc;
    do { this.advanceOffset(1, true); nc = ln[this.offset]; } while (this.column - spacesStartCol < 5 && isSpaceOrTab(nc));
    const blankItem = ln[this.offset] === undefined;
    const after = this.column - spacesStartCol;
    if (after >= 5 || after < 1 || blankItem) {
      data.padding = mlen + 1;
      this.column = spacesStartCol;
      this.offset = spacesStartOffset;
      if (isSpaceOrTab(ln[this.offset])) this.advanceOffset(1, true);
    } else data.padding = mlen + after;
    return data;
  }

  incorporateLine(ln) {
    let container = this.doc;
    this.oldtip = this.tip;
    this.offset = 0; this.column = 0; this.blank = false; this.partiallyConsumedTab = false;
    this.lineNumber++;
    this.ln = ln;
    let allMatched = true;
    let last;
    while ((last = container.lastChild) && last.open) {
      container = last;
      this.findNextNonspace();
      const r = this.cont(container);
      if (r === 2) { this.lastLineLength = ln.length; return; }
      if (r === 1) { allMatched = false; container = container.parent; break; }
    }
    void allMatched;
    this.allClosed = container === this.oldtip;
    this.lastMatchedContainer = container;
    let matchedLeaf = container.type !== 'paragraph' && acceptsLines(container.type);
    while (!matchedLeaf) {
      this.findNextNonspace();
      if (!this.indented && !MAYBE_SPECIAL.test(ln.slice(this.nextNonspace))) { this.advanceNextNonspace(); break; }
      const r = this.tryStarts(container);
      if (r === 1) { container = this.tip; continue; }
      if (r === 2) { container = this.tip; matchedLeaf = true; break; }
      this.advanceNextNonspace();
      break;
    }
    if (!this.allClosed && !this.blank && this.tip.type === 'paragraph') {
      this.addLine();
    } else {
      this.closeUnmatchedBlocks();
      if (this.blank && container.lastChild) container.lastChild.lastLineBlank = true;
      const t = container.type;
      const llb = this.blank && !(t === 'block_quote' || (t === 'code_block' && container.fenced) ||
        (t === 'item' && !container.firstChild && container.startLine === this.lineNumber));
      for (let c = container; c; c = c.parent) c.lastLineBlank = llb;
      if (acceptsLines(t)) {
        this.addLine();
      } else if (this.offset < ln.length && !this.blank) {
        this.addChild('paragraph');
        this.advanceNextNonspace();
        this.addLine();
      }
    }
    this.lastLineLength = ln.length;
  }

  processInlines(root) {
    const ip = new InlineParser(this.refmap, this.opts);
    const walk = (node) => {
      if (node.type === 'paragraph' || node.type === 'heading') {
        ip.parse(node, node.string);
      } else if (node.type === 'table') {
        const mk = (s) => { const cell = new Node('table_cell'); ip.parse(cell, s); return cell; };
        node.headCells = node.header.map(mk);
        node.bodyRows = node.rows.map((r) => r.map(mk));
      } else {
        for (let c = node.firstChild; c; c = c.next) walk(c);
      }
    };
    walk(root);
  }
}

function endsWithBlankLine(b) {
  while (b) {
    if (b.lastLineBlank) return true;
    if (b.type === 'list' || b.type === 'item') b = b.lastChild;
    else return false;
  }
  return false;
}

function listsMatch(list, data) {
  return list.listType === data.listType && list.delimiter === data.delimiter && list.bulletChar === data.bulletChar;
}

function canContain(parent, child) {
  switch (parent) {
    case 'document': case 'block_quote': case 'item': return child !== 'item';
    case 'list': return child === 'item';
    default: return false;
  }
}

function acceptsLines(t) {
  return t === 'paragraph' || t === 'code_block' || t === 'table';
}

// ---------------------------------------------------------------- rendering

function plainText(node) {
  let s = '';
  for (let c = node.firstChild; c; c = c.next) {
    switch (c.type) {
      case 'text': case 'code': s += c.literal; break;
      case 'softbreak': s += ' '; break;
      case 'linebreak': s += ' '; break;
      case 'wikilink': s += c.label; break;
      default: s += plainText(c);
    }
  }
  return s;
}

class Renderer {
  constructor(opts) {
    this.opts = opts || {};
    this.buf = [];
    this.lastOut = '\n';
    this.seen = new Map();
  }
  out(s) { if (s.length) { this.buf.push(s); this.lastOut = s; } }
  cr() { if (this.lastOut[this.lastOut.length - 1] !== '\n') this.out('\n'); }

  inlines(node) {
    for (let c = node.firstChild; c; c = c.next) this.inline(c);
  }

  inline(n) {
    switch (n.type) {
      case 'text': this.out(escapeHtml(n.literal)); break;
      case 'softbreak': this.out('\n'); break;
      case 'linebreak': this.out('<br />\n'); break;
      case 'code': this.out('<code>' + escapeHtml(n.literal) + '</code>'); break;
      case 'emph': this.out('<em>'); this.inlines(n); this.out('</em>'); break;
      case 'strong': this.out('<strong>'); this.inlines(n); this.out('</strong>'); break;
      case 'del': this.out('<del>'); this.inlines(n); this.out('</del>'); break;
      case 'link': {
        let a = '<a href="' + escapeHtml(safeUrl(n.destination)) + '"';
        if (n.title) a += ' title="' + escapeHtml(n.title) + '"';
        this.out(a + '>'); this.inlines(n); this.out('</a>');
        break;
      }
      case 'image': {
        let a = '<img src="' + escapeHtml(safeUrl(n.destination)) + '" alt="' + escapeHtml(plainText(n)) + '"';
        if (n.title) a += ' title="' + escapeHtml(n.title) + '"';
        this.out(a + ' />');
        break;
      }
      case 'wikilink': {
        const wl = this.opts.wikiLinks;
        let exists = true;
        try { exists = typeof wl.exists === 'function' ? !!wl.exists(n.slug) : true; } catch { exists = false; }
        this.out('<a href="/wiki/' + escapeHtml(n.slug) + '" class="wikilink' + (exists ? '' : ' missing') + '">' + escapeHtml(n.label) + '</a>');
        break;
      }
      default: this.inlines(n);
    }
  }

  block(n) {
    switch (n.type) {
      case 'document':
        for (let c = n.firstChild; c; c = c.next) this.block(c);
        break;
      case 'paragraph': {
        const gp = n.parent && n.parent.parent;
        if (gp && gp.type === 'list' && gp.tight) { this.inlines(n); break; }
        this.cr(); this.out('<p>'); this.inlines(n); this.out('</p>'); this.cr();
        break;
      }
      case 'heading': {
        const tag = 'h' + n.level;
        let attrs = '';
        if (this.opts.headingIds) attrs = ' id="' + escapeHtml(slugify(plainText(n), this.seen)) + '"';
        this.cr(); this.out('<' + tag + attrs + '>'); this.inlines(n); this.out('</' + tag + '>'); this.cr();
        break;
      }
      case 'thematic_break': this.cr(); this.out('<hr />'); this.cr(); break;
      case 'code_block': {
        const info = n.info ? n.info.split(/[ \t\n]+/)[0] : '';
        this.cr();
        this.out('<pre><code' + (info ? ' class="language-' + escapeHtml(info) + '"' : '') + '>' + escapeHtml(n.literal) + '</code></pre>');
        this.cr();
        break;
      }
      case 'block_quote':
        this.cr(); this.out('<blockquote>'); this.cr();
        for (let c = n.firstChild; c; c = c.next) this.block(c);
        this.cr(); this.out('</blockquote>'); this.cr();
        break;
      case 'list': {
        const tag = n.listType === 'bullet' ? 'ul' : 'ol';
        const start = n.listType === 'ordered' && n.start !== 1 ? ' start="' + n.start + '"' : '';
        this.cr(); this.out('<' + tag + start + '>'); this.cr();
        for (let c = n.firstChild; c; c = c.next) this.block(c);
        this.cr(); this.out('</' + tag + '>'); this.cr();
        break;
      }
      case 'item':
        this.out('<li>');
        for (let c = n.firstChild; c; c = c.next) this.block(c);
        this.out('</li>'); this.cr();
        break;
      case 'table': {
        const al = (i) => (n.aligns[i] ? ' align="' + n.aligns[i] + '"' : '');
        this.cr(); this.out('<table>\n<thead>\n<tr>\n');
        n.headCells.forEach((c, i) => { this.out('<th' + al(i) + '>'); this.inlines(c); this.out('</th>\n'); });
        this.out('</tr>\n</thead>\n');
        if (n.bodyRows.length) {
          this.out('<tbody>\n');
          for (const row of n.bodyRows) {
            this.out('<tr>\n');
            for (let i = 0; i < n.aligns.length; i++) {
              this.out('<td' + al(i) + '>');
              if (row[i]) this.inlines(row[i]);
              this.out('</td>\n');
            }
            this.out('</tr>\n');
          }
          this.out('</tbody>\n');
        }
        this.out('</table>\n');
        break;
      }
      default:
    }
  }
}

// ---------------------------------------------------------------- public API

export function parse(markdown, opts = {}) {
  return new BlockParser(opts).parse(markdown == null ? '' : String(markdown));
}

export function render(markdown, { headingIds = false, wikiLinks } = {}) {
  const doc = parse(markdown, { wikiLinks: !!wikiLinks });
  const r = new Renderer({ headingIds, wikiLinks });
  r.block(doc);
  return r.buf.join('');
}

function walkHeadings(node, cb) {
  for (let c = node.firstChild; c; c = c.next) {
    if (c.type === 'heading') cb(c);
    else walkHeadings(c, cb);
  }
}

export function toc(markdown) {
  const doc = parse(markdown, { wikiLinks: true });
  const seen = new Map();
  const out = [];
  walkHeadings(doc, (h) => {
    const t = plainText(h);
    out.push({ level: h.level, text: t, slug: slugify(t, seen) });
  });
  return out;
}

// Distinct wiki link target slugs (in order of first appearance).
export function wikiLinkTargets(markdown) {
  const doc = parse(markdown, { wikiLinks: true });
  const out = new Set();
  const walk = (n) => {
    for (let c = n.firstChild; c; c = c.next) {
      if (c.type === 'wikilink') out.add(c.slug);
      else walk(c);
    }
    if (n.type === 'table') {
      for (const c of n.headCells) walk(c);
      for (const r of n.bodyRows) for (const c of r) walk(c);
    }
  };
  walk(doc);
  return [...out];
}
