// Safe Markdown -> HTML renderer (CommonMark core + GFM tables/strikethrough).
// Raw HTML is never passed through; dangerous URL schemes are neutralised.
import { ENTITIES } from './entities.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const ESCAPABLE = '[!"#$%&\'()*+,./:;<=>?@[\\\\\\]^_`{|}~-]';
const reEscapable = new RegExp('^' + ESCAPABLE);
const ENTITY = '&(?:#x[a-f0-9]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,31});';
const reEntityHere = new RegExp('^' + ENTITY, 'i');
const reEntityOrEscaped = new RegExp('\\\\' + ESCAPABLE + '|' + ENTITY, 'gi');

function decodeEntity(ent) {
  // ent includes leading & and trailing ;
  const body = ent.slice(1, -1);
  if (body[0] === '#') {
    let code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    if (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) code = 0xfffd;
    return String.fromCodePoint(code);
  }
  if (Object.prototype.hasOwnProperty.call(ENTITIES, body)) return ENTITIES[body];
  return null;
}

function unescapeString(s) {
  if (!/[\\&]/.test(s)) return s;
  return s.replace(reEntityOrEscaped, m => {
    if (m[0] === '\\') return m[1];
    const d = decodeEntity(m);
    return d === null ? m : d;
  });
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}

const URI_SAFE = /[A-Za-z0-9;\/?:@&=+$,\-_.!~*'()#]/;
function normalizeURI(uri) {
  let out = '';
  for (let i = 0; i < uri.length; i++) {
    const c = uri[i];
    if (c === '%' && /^[0-9a-fA-F]{2}$/.test(uri.slice(i + 1, i + 3))) { out += c; continue; }
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

function safeUrl(url) {
  const probe = url.replace(/^[\s\x00-\x20]+/, '').toLowerCase();
  if (/^(?:javascript|vbscript|file):/.test(probe)) return '#';
  if (/^data:/.test(probe)) return /^data:image\/(?:png|gif|jpeg|webp);/.test(probe) ? url : '#';
  return url;
}

function normalizeReference(label) {
  return label.slice(1, -1).trim().replace(/[ \t\r\n]+/g, ' ').toLowerCase().toUpperCase();
}

const isSpaceOrTab = c => c === ' ' || c === '\t';
const reUnicodeWhitespace = /^[\p{Zs}\t\n\v\f\r]/u;
const rePunctuation = /^[\p{P}\p{S}]/u;

// ---------------------------------------------------------------------------
// Node
// ---------------------------------------------------------------------------

class Node {
  constructor(type) {
    this.type = type;
    this.parent = null; this.firstChild = null; this.lastChild = null; this.prev = null; this.next = null;
    this.open = true;
    this.content = '';
    this.literal = '';
    this.startLine = 0; this.endLine = 0;
  }
  appendChild(child) {
    child.unlink();
    child.parent = this;
    if (this.lastChild) { this.lastChild.next = child; child.prev = this.lastChild; this.lastChild = child; }
    else { this.firstChild = this.lastChild = child; }
  }
  insertAfter(sib) {
    sib.unlink();
    sib.next = this.next;
    if (sib.next) sib.next.prev = sib;
    sib.prev = this;
    this.next = sib;
    sib.parent = this.parent;
    if (!sib.next && sib.parent) sib.parent.lastChild = sib;
  }
  unlink() {
    if (this.prev) this.prev.next = this.next; else if (this.parent) this.parent.firstChild = this.next;
    if (this.next) this.next.prev = this.prev; else if (this.parent) this.parent.lastChild = this.prev;
    this.parent = this.prev = this.next = null;
  }
}

function textNode(s) { const n = new Node('text'); n.literal = s; return n; }

// ---------------------------------------------------------------------------
// Inline parser
// ---------------------------------------------------------------------------

const reLinkTitle = /^(?:"(?:\\[\s\S]|[^\\"\x00])*"|'(?:\\[\s\S]|[^\\'\x00])*'|\((?:\\[\s\S]|[^\\()\x00])*\))/;
const reLinkDestBraces = /^<(?:[^<>\n\\\x00]|\\.)*>/;
const reLinkLabel = /^\[(?:[^\\\[\]]|\\.){0,1000}\]/s;
const reSpnl = /^[ \t]*(?:\n[ \t]*)?/;
const reMain = /^[^\n`\[\]\\!<&*_~]+/;
const reEmailAutolink = /^<([a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/;
const reAutolink = /^<[A-Za-z][A-Za-z0-9.+-]{1,31}:[^<>\x00-\x20]*>/;

class InlineParser {
  constructor() { this.subject = ''; this.pos = 0; this.refmap = {}; this.delimiters = null; this.brackets = null; }

  match(re) {
    const m = re.exec(this.subject.slice(this.pos));
    if (!m) return null;
    this.pos += m.index + m[0].length;
    return m[0];
  }
  peek() { return this.pos < this.subject.length ? this.subject[this.pos] : null; }
  spnl() { this.match(reSpnl); return true; }

  parse(block, content) {
    this.subject = content.trim();
    this.pos = 0; this.delimiters = null; this.brackets = null;
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
      case '[': this.pos++; { const n = textNode('['); block.appendChild(n); this.addBracket(n, this.pos - 1, false); } res = true; break;
      case '!':
        this.pos++;
        if (this.peek() === '[') {
          this.pos++;
          const n = textNode('!['); block.appendChild(n); this.addBracket(n, this.pos - 1, true);
        } else block.appendChild(textNode('!'));
        res = true; break;
      case ']': res = this.handleCloseBracket(block); break;
      case '<': res = this.parseAutolink(block); break;
      case '&': res = this.parseEntity(block); break;
      default: res = this.parseString(block);
    }
    if (!res) { this.pos++; block.appendChild(textNode(c)); }
    return true;
  }

  parseNewline(block) {
    this.pos++;
    const last = block.lastChild;
    if (last && last.type === 'text' && last.literal.endsWith(' ')) {
      const hard = last.literal.endsWith('  ');
      last.literal = last.literal.replace(/ +$/, '');
      block.appendChild(new Node(hard ? 'linebreak' : 'softbreak'));
    } else block.appendChild(new Node('softbreak'));
    this.match(/^ */);
    return true;
  }

  parseBackslash(block) {
    this.pos++;
    const c = this.peek();
    if (c === '\n') { this.pos++; block.appendChild(new Node('linebreak')); }
    else if (c !== null && reEscapable.test(c)) { this.pos++; block.appendChild(textNode(c)); }
    else block.appendChild(textNode('\\'));
    return true;
  }

  parseBackticks(block) {
    const ticks = this.match(/^`+/);
    if (!ticks) return false;
    const after = this.pos;
    let m;
    while ((m = this.match(/`+/)) !== null) {
      if (m === ticks) {
        let contents = this.subject.slice(after, this.pos - ticks.length).replace(/\n/g, ' ');
        if (contents.length > 1 && /[^ ]/.test(contents) && contents[0] === ' ' && contents[contents.length - 1] === ' ') {
          contents = contents.slice(1, -1);
        }
        const n = new Node('code'); n.literal = contents; block.appendChild(n);
        return true;
      }
    }
    this.pos = after;
    block.appendChild(textNode(ticks));
    return true;
  }

  parseAutolink(block) {
    let m;
    if ((m = this.match(reEmailAutolink))) {
      const addr = m.slice(1, -1);
      const n = new Node('link'); n.destination = normalizeURI('mailto:' + addr); n.title = '';
      n.appendChild(textNode(addr)); block.appendChild(n); return true;
    }
    if ((m = this.match(reAutolink))) {
      const uri = m.slice(1, -1);
      const n = new Node('link'); n.destination = normalizeURI(uri); n.title = '';
      n.appendChild(textNode(uri)); block.appendChild(n); return true;
    }
    return false;
  }

  parseEntity(block) {
    const m = this.match(reEntityHere);
    if (!m) return false;
    const d = decodeEntity(m);
    block.appendChild(textNode(d === null ? m : d));
    return true;
  }

  parseString(block) {
    const m = this.match(reMain);
    if (!m) return false;
    block.appendChild(textNode(m));
    return true;
  }

  scanDelims(cc) {
    const start = this.pos;
    let n = 0;
    while (this.peek() === cc) { n++; this.pos++; }
    if (n === 0) return null;
    let before = '\n';
    if (start > 0) {
      const code = this.subject.charCodeAt(start - 1);
      before = (code >= 0xdc00 && code <= 0xdfff && start > 1) ? this.subject.slice(start - 2, start) : this.subject[start - 1];
    }
    let after = '\n';
    if (this.pos < this.subject.length) after = String.fromCodePoint(this.subject.codePointAt(this.pos));
    const afterWS = reUnicodeWhitespace.test(after), afterP = rePunctuation.test(after);
    const beforeWS = reUnicodeWhitespace.test(before), beforeP = rePunctuation.test(before);
    const left = !afterWS && (!afterP || beforeWS || beforeP);
    const right = !beforeWS && (!beforeP || afterWS || afterP);
    let canOpen, canClose;
    if (cc === '_') { canOpen = left && (!right || beforeP); canClose = right && (!left || afterP); }
    else { canOpen = left; canClose = right; }
    this.pos = start;
    return { n, canOpen, canClose };
  }

  handleDelim(cc, block) {
    const res = this.scanDelims(cc);
    if (!res) return false;
    const start = this.pos;
    this.pos += res.n;
    const node = textNode(this.subject.slice(start, this.pos));
    block.appendChild(node);
    if ((res.canOpen || res.canClose) && (cc !== '~' || res.n <= 2)) {
      this.delimiters = { cc, numdelims: res.n, origdelims: res.n, node, previous: this.delimiters, next: null, canOpen: res.canOpen, canClose: res.canClose };
      if (this.delimiters.previous) this.delimiters.previous.next = this.delimiters;
    }
    return true;
  }

  removeDelimiter(d) {
    if (d.previous) d.previous.next = d.next;
    if (d.next) d.next.previous = d.previous; else this.delimiters = d.previous;
  }

  processEmphasis(stackBottom) {
    const openersBottom = { '*': [], '_': [], '~': [] };
    for (const k in openersBottom) for (let i = 0; i < 6; i++) openersBottom[k][i] = stackBottom;
    let closer = this.delimiters;
    while (closer && closer.previous !== stackBottom) closer = closer.previous;
    while (closer) {
      if (!closer.canClose) { closer = closer.next; continue; }
      const cc = closer.cc;
      const idx = (closer.canOpen ? 3 : 0) + (closer.origdelims % 3);
      let opener = closer.previous;
      let found = false;
      while (opener && opener !== stackBottom && opener !== openersBottom[cc][idx]) {
        if (cc === '~') {
          if (opener.cc === '~' && opener.canOpen && opener.numdelims === closer.numdelims) { found = true; break; }
        } else {
          const odd = (closer.canOpen || opener.canClose) && closer.origdelims % 3 !== 0 && (opener.origdelims + closer.origdelims) % 3 === 0;
          if (opener.cc === cc && opener.canOpen && !odd) { found = true; break; }
        }
        opener = opener.previous;
      }
      const oldCloser = closer;
      if (found) {
        const use = cc === '~' ? closer.numdelims : (closer.numdelims >= 2 && opener.numdelims >= 2 ? 2 : 1);
        const oNode = opener.node, cNode = closer.node;
        opener.numdelims -= use; closer.numdelims -= use;
        oNode.literal = oNode.literal.slice(0, oNode.literal.length - use);
        cNode.literal = cNode.literal.slice(0, cNode.literal.length - use);
        const wrap = new Node(cc === '~' ? 'del' : use === 1 ? 'emph' : 'strong');
        let tmp = oNode.next;
        while (tmp && tmp !== cNode) { const nx = tmp.next; wrap.appendChild(tmp); tmp = nx; }
        oNode.insertAfter(wrap);
        // remove delimiters between opener and closer
        if (opener.next !== closer) { opener.next = closer; closer.previous = opener; }
        if (opener.numdelims === 0) { oNode.unlink(); this.removeDelimiter(opener); }
        if (closer.numdelims === 0) { cNode.unlink(); const nx = closer.next; this.removeDelimiter(closer); closer = nx; }
      } else {
        closer = closer.next;
        openersBottom[cc][idx] = oldCloser.previous;
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

  parseLinkTitle() {
    const t = this.match(reLinkTitle);
    return t === null ? null : unescapeString(t.slice(1, -1));
  }

  parseLinkDestination() {
    let res = this.match(reLinkDestBraces);
    if (res !== null) return normalizeURI(unescapeString(res.slice(1, -1)));
    if (this.peek() === '<') return null;
    const save = this.pos;
    let parens = 0, c;
    while ((c = this.peek()) !== null) {
      if (c === '\\' && reEscapable.test(this.subject[this.pos + 1] || '')) this.pos += 2;
      else if (c === '(') { this.pos++; parens++; }
      else if (c === ')') { if (parens < 1) break; this.pos++; parens--; }
      else if (/[\x00-\x20]/.test(c)) break;
      else this.pos++;
    }
    if (this.pos === save && c !== ')') return null;
    if (parens !== 0) return null;
    res = this.subject.slice(save, this.pos);
    return normalizeURI(unescapeString(res));
  }

  parseLinkLabel() {
    const m = this.match(reLinkLabel);
    if (m === null || m.length > 1001) { if (m !== null) this.pos -= m.length; return 0; }
    return m.length;
  }

  handleCloseBracket(block) {
    this.pos++;
    const startpos = this.pos;
    let opener = this.brackets;
    if (!opener) { block.appendChild(textNode(']')); return true; }
    if (!opener.active) { block.appendChild(textNode(']')); this.removeBracket(); return true; }
    const isImage = opener.image;
    const savepos = this.pos;
    let matched = false, dest = null, title = null;
    if (this.peek() === '(') {
      this.pos++;
      if (this.spnl() && (dest = this.parseLinkDestination()) !== null && this.spnl() &&
          ((/\s/.test(this.subject[this.pos - 1]) && (title = this.parseLinkTitle())) || true) &&
          this.spnl() && this.peek() === ')') {
        this.pos++; matched = true;
      } else this.pos = savepos;
    }
    if (!matched) {
      const before = this.pos;
      const n = this.parseLinkLabel();
      let reflabel = null;
      if (n > 2) reflabel = this.subject.slice(before, before + n);
      else if (!opener.bracketAfter) reflabel = this.subject.slice(opener.index, startpos);
      if (n === 0) this.pos = savepos;
      if (reflabel) {
        const link = this.refmap[normalizeReference(reflabel)];
        if (link) { dest = link.destination; title = link.title; matched = true; }
      }
    }
    if (matched) {
      const node = new Node(isImage ? 'image' : 'link');
      node.destination = dest; node.title = title || '';
      let tmp = opener.node.next;
      while (tmp) { const nx = tmp.next; node.appendChild(tmp); tmp = nx; }
      block.appendChild(node);
      this.processEmphasis(opener.previousDelimiter);
      this.removeBracket();
      opener.node.unlink();
      if (!isImage) {
        let o = this.brackets;
        while (o) { if (!o.image) o.active = false; o = o.previous; }
      }
      return true;
    }
    this.removeBracket();
    this.pos = startpos;
    block.appendChild(textNode(']'));
    return true;
  }

  // Parse a link reference definition at the start of s; returns chars consumed or 0.
  parseReference(s, refmap) {
    this.subject = s; this.pos = 0;
    const n = this.parseLinkLabel();
    if (n === 0) return 0;
    const rawlabel = this.subject.slice(0, n);
    if (this.peek() !== ':') return 0;
    this.pos++;
    this.spnl();
    const dest = this.parseLinkDestination();
    if (dest === null) return 0;
    const beforeTitle = this.pos;
    this.spnl();
    let title = null;
    if (this.pos !== beforeTitle) title = this.parseLinkTitle();
    if (title === null) { title = ''; this.pos = beforeTitle; }
    let atLineEnd = true;
    if (this.match(/^[ \t]*(?:\n|$)/) === null) {
      if (title === '') atLineEnd = false;
      else {
        title = ''; this.pos = beforeTitle;
        atLineEnd = this.match(/^[ \t]*(?:\n|$)/) !== null;
      }
    }
    if (!atLineEnd) return 0;
    const norm = normalizeReference(rawlabel);
    if (norm === '') return 0;
    if (!refmap[norm]) refmap[norm] = { destination: dest, title };
    return this.pos;
  }
}

// ---------------------------------------------------------------------------
// Block parser
// ---------------------------------------------------------------------------

const reMaybeSpecial = /^[#`~*+_=<>0-9\-|:]/;
const reThematicBreak = /^(?:\*[ \t]*){3,}$|^(?:_[ \t]*){3,}$|^(?:-[ \t]*){3,}$/;
const reATX = /^#{1,6}(?:[ \t]+|$)/;
const reCodeFence = /^`{3,}(?!.*`)|^~{3,}/;
const reClosingFence = /^(?:`{3,}|~{3,})(?=[ \t]*$)/;
const reSetext = /^(?:=+|-+)[ \t]*$/;
const reTableDelim = /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const reListStart = /^(?:[*+-]|\d{1,9}[.)])(?:[ \t]|$)/;

function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  // strip trailing unescaped pipe
  if (s.endsWith('|')) {
    let bs = 0, i = s.length - 2;
    while (i >= 0 && s[i] === '\\') { bs++; i--; }
    if (bs % 2 === 0) s = s.slice(0, -1);
  }
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      if (s[i + 1] === '|') cur += '|'; else cur += c + s[i + 1];
      i++;
    } else if (c === '|') { cells.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

function parseAlign(delim) {
  return splitTableRow(delim).map(c => {
    const l = c.startsWith(':'), r = c.endsWith(':');
    return l && r ? 'center' : l ? 'left' : r ? 'right' : '';
  });
}

const canContain = (parent, child) =>
  parent === 'document' || parent === 'blockquote' || parent === 'item' ? child !== 'item'
    : parent === 'list' ? child === 'item' : false;
const acceptsLines = t => t === 'paragraph' || t === 'code_block' || t === 'table';

class BlockParser {
  constructor() {
    this.inline = new InlineParser();
    this.refmap = {};
  }

  parse(input) {
    this.doc = new Node('document');
    this.doc.startLine = 1;
    this.tip = this.doc;
    this.oldtip = this.doc;
    this.lastMatchedContainer = this.doc;
    this.allClosed = true;
    this.lineNumber = 0;
    const src = input.replace(/\0/g, '�');
    const lines = src.split(/\r\n|\n|\r/);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    for (const ln of lines) { this.lineNumber++; this.incorporateLine(ln); }
    while (this.tip) this.finalize(this.tip, this.lineNumber);
    this.inline.refmap = this.refmap;
    this.processInlines(this.doc);
    return this.doc;
  }

  findNextNonspace() {
    const ln = this.line;
    let i = this.offset, cols = this.column, c;
    while (i < ln.length) {
      c = ln[i];
      if (c === ' ') { i++; cols++; }
      else if (c === '\t') { i++; cols += 4 - (cols % 4); }
      else break;
    }
    this.blank = i >= ln.length;
    this.nextNonspace = i;
    this.nextNonspaceColumn = cols;
    this.indent = cols - this.column;
    this.indented = this.indent >= 4;
  }

  advanceNextNonspace() {
    this.offset = this.nextNonspace;
    this.column = this.nextNonspaceColumn;
    this.partiallyConsumedTab = false;
  }

  advanceOffset(count, columns) {
    const ln = this.line;
    while (count > 0 && this.offset < ln.length) {
      const c = ln[this.offset];
      if (c === '\t') {
        const toTab = 4 - (this.column % 4);
        if (columns) {
          this.partiallyConsumedTab = toTab > count;
          const adv = Math.min(count, toTab);
          this.column += adv;
          this.offset += this.partiallyConsumedTab ? 0 : 1;
          count -= adv;
        } else {
          this.partiallyConsumedTab = false;
          this.column += toTab; this.offset++; count--;
        }
      } else {
        this.partiallyConsumedTab = false;
        this.offset++; this.column++; count--;
      }
    }
  }

  addLine() {
    if (this.partiallyConsumedTab) {
      this.offset++;
      const toTab = 4 - (this.column % 4);
      this.tip.content += ' '.repeat(toTab);
    }
    this.tip.content += this.line.slice(this.offset) + '\n';
  }

  addChild(type) {
    while (!canContain(this.tip.type, type)) this.finalize(this.tip, this.lineNumber - 1);
    const n = new Node(type);
    n.startLine = this.lineNumber;
    this.tip.appendChild(n);
    this.tip = n;
    return n;
  }

  closeUnmatchedBlocks() {
    if (!this.allClosed) {
      while (this.oldtip !== this.lastMatchedContainer) {
        const parent = this.oldtip.parent;
        this.finalize(this.oldtip, this.lineNumber - 1);
        this.oldtip = parent;
      }
      this.allClosed = true;
    }
  }

  // 0 = matched, 1 = not matched, 2 = line consumed
  continueBlock(c) {
    const ln = this.line;
    switch (c.type) {
      case 'document': case 'list': return 0;
      case 'blockquote':
        if (!this.indented && ln[this.nextNonspace] === '>') {
          this.advanceNextNonspace(); this.advanceOffset(1, false);
          if (isSpaceOrTab(ln[this.offset])) this.advanceOffset(1, true);
          return 0;
        }
        return 1;
      case 'item':
        if (this.blank) {
          if (c.firstChild === null) return 1;
          this.advanceNextNonspace();
        } else if (this.indent >= c.listData.markerOffset + c.listData.padding) {
          this.advanceOffset(c.listData.markerOffset + c.listData.padding, true);
        } else return 1;
        return 0;
      case 'heading': case 'thematic_break': return 1;
      case 'code_block':
        if (c.fenced) {
          const m = this.indent <= 3 && ln[this.nextNonspace] === c.fenceChar && ln.slice(this.nextNonspace).match(reClosingFence);
          if (m && m[0].length >= c.fenceLength) {
            this.finalize(c, this.lineNumber);
            return 2;
          }
          let i = c.fenceOffset;
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
          if (rest[0] === '>' || reATX.test(rest) || reCodeFence.test(rest) || reThematicBreak.test(rest) || reListStart.test(rest)) return 1;
        }
        return 0;
      }
    }
    return 1;
  }

  finalize(block, lineNumber) {
    const above = block.parent;
    block.open = false;
    block.endLine = lineNumber;
    switch (block.type) {
      case 'paragraph': {
        let content = block.content;
        let hasRef = false, pos;
        while (content[0] === '[' && (pos = this.inline.parseReference(content, this.refmap))) {
          content = content.slice(pos); hasRef = true;
        }
        block.content = content;
        if (hasRef && /^[ \t\n]*$/.test(content)) block.unlink();
        break;
      }
      case 'code_block':
        if (block.fenced) {
          const nl = block.content.indexOf('\n');
          block.info = unescapeString(block.content.slice(0, nl).trim());
          block.literal = block.content.slice(nl + 1);
        } else {
          block.literal = block.content.replace(/(\n[ \t]*)+$/, '\n');
        }
        break;
      case 'table': {
        const lines = block.content.split('\n').filter(l => l.trim() !== '');
        block.rows = lines.map(l => splitTableRow(l));
        break;
      }
      case 'item':
        if (block.lastChild) block.endLine = block.lastChild.endLine;
        else block.endLine = block.startLine;
        break;
      case 'list': {
        block.listData.tight = true;
        const ends = b => b.next && b.endLine !== b.next.startLine - 1;
        outer: for (let item = block.firstChild; item; item = item.next) {
          if (item.next && ends(item)) { block.listData.tight = false; break; }
          for (let sub = item.firstChild; sub; sub = sub.next) {
            if (sub.next && ends(sub)) { block.listData.tight = false; break outer; }
          }
        }
        if (block.lastChild) block.endLine = block.lastChild.endLine;
        break;
      }
    }
    this.tip = above;
  }

  parseListMarker(container) {
    const ln = this.line;
    const rest = ln.slice(this.nextNonspace);
    if (this.indent >= 4) return null;
    const data = { type: null, tight: true, bulletChar: null, start: null, delimiter: null, padding: null, markerOffset: this.indent };
    let m;
    if ((m = rest.match(/^[*+-]/))) { data.type = 'bullet'; data.bulletChar = m[0]; }
    else if ((m = rest.match(/^(\d{1,9})([.)])/)) && (container.type !== 'paragraph' || m[1] === '1')) {
      data.type = 'ordered'; data.start = parseInt(m[1], 10); data.delimiter = m[2];
    } else return null;
    const nextc = ln[this.nextNonspace + m[0].length];
    if (!(nextc === undefined || nextc === ' ' || nextc === '\t')) return null;
    if (container.type === 'paragraph' && !/[^ \t]/.test(ln.slice(this.nextNonspace + m[0].length))) return null;
    this.advanceNextNonspace();
    this.advanceOffset(m[0].length, true);
    const spacesStartCol = this.column, spacesStartOffset = this.offset;
    let c;
    do { this.advanceOffset(1, true); c = ln[this.offset]; } while (this.column - spacesStartCol < 5 && isSpaceOrTab(c));
    const blankItem = c === undefined;
    const spacesAfter = this.column - spacesStartCol;
    if (spacesAfter >= 5 || spacesAfter < 1 || blankItem) {
      data.padding = m[0].length + 1;
      this.column = spacesStartCol; this.offset = spacesStartOffset; this.partiallyConsumedTab = false;
      if (isSpaceOrTab(ln[this.offset])) this.advanceOffset(1, true);
    } else data.padding = m[0].length + spacesAfter;
    return data;
  }

  // Block starts: 0 none, 1 container, 2 leaf
  tryStarts(container) {
    const ln = this.line;
    const rest = ln.slice(this.nextNonspace);
    // blockquote
    if (!this.indented && rest[0] === '>') {
      this.advanceNextNonspace(); this.advanceOffset(1, false);
      if (isSpaceOrTab(ln[this.offset])) this.advanceOffset(1, true);
      this.closeUnmatchedBlocks();
      this.addChild('blockquote');
      return 1;
    }
    let m;
    // ATX heading
    if (!this.indented && (m = rest.match(reATX))) {
      this.advanceNextNonspace(); this.advanceOffset(m[0].length, false);
      this.closeUnmatchedBlocks();
      const h = this.addChild('heading');
      h.level = m[0].trim().length;
      h.content = ln.slice(this.offset).replace(/^[ \t]*#+[ \t]*$/, '').replace(/[ \t]+#+[ \t]*$/, '');
      this.advanceOffset(ln.length - this.offset, false);
      return 2;
    }
    // fenced code
    if (!this.indented && (m = rest.match(reCodeFence))) {
      const len = m[0].length;
      this.closeUnmatchedBlocks();
      const cb = this.addChild('code_block');
      cb.fenced = true; cb.fenceLength = len; cb.fenceChar = m[0][0]; cb.fenceOffset = this.indent;
      this.advanceNextNonspace(); this.advanceOffset(len, false);
      return 2;
    }
    // setext heading
    if (!this.indented && container.type === 'paragraph' && (m = rest.match(reSetext))) {
      this.closeUnmatchedBlocks();
      let pos;
      while (container.content[0] === '[' && (pos = this.inline.parseReference(container.content, this.refmap))) {
        container.content = container.content.slice(pos);
      }
      if (container.content.length > 0 && /[^ \t\n]/.test(container.content)) {
        const h = new Node('heading');
        h.level = m[0][0] === '=' ? 1 : 2;
        h.content = container.content;
        h.startLine = container.startLine;
        container.insertAfter(h);
        container.unlink();
        this.tip = h;
        this.advanceOffset(ln.length - this.offset, false);
        return 2;
      }
      return 0;
    }
    // GFM table
    if (!this.indented && container.type === 'paragraph' && reTableDelim.test(rest)) {
      const lines = container.content.replace(/\n$/, '').split('\n');
      const header = lines[lines.length - 1];
      if (rest.includes('|') || header.includes('|')) {
        const align = parseAlign(rest);
        const hcells = splitTableRow(header);
        if (hcells.length === align.length) {
          this.closeUnmatchedBlocks();
          const parent = container.parent;
          const table = new Node('table');
          table.align = align; table.header = hcells; table.startLine = this.lineNumber - 1;
          if (lines.length > 1) {
            container.content = lines.slice(0, -1).join('\n') + '\n';
            this.finalize(container, this.lineNumber - 2);
            if (container.parent) container.insertAfter(table); else parent.appendChild(table);
          } else {
            container.insertAfter(table);
            container.unlink();
          }
          this.tip = table;
          this.advanceOffset(ln.length - this.offset, false);
          return 2;
        }
      }
    }
    // thematic break
    if (!this.indented && reThematicBreak.test(rest)) {
      this.closeUnmatchedBlocks();
      this.addChild('thematic_break');
      this.advanceOffset(ln.length - this.offset, false);
      return 2;
    }
    // list item
    let data;
    if ((!this.indented || container.type === 'list') && (data = this.parseListMarker(container))) {
      this.closeUnmatchedBlocks();
      const t = this.tip;
      if (t.type !== 'list' || !(t.listData.type === data.type && t.listData.delimiter === data.delimiter && t.listData.bulletChar === data.bulletChar)) {
        const l = this.addChild('list');
        l.listData = data;
      }
      const it = this.addChild('item');
      it.listData = data;
      return 1;
    }
    // indented code
    if (this.indented && this.tip.type !== 'paragraph' && !this.blank) {
      this.advanceOffset(4, true);
      this.closeUnmatchedBlocks();
      this.addChild('code_block');
      return 2;
    }
    return 0;
  }

  incorporateLine(ln) {
    this.line = ln;
    this.offset = 0; this.column = 0; this.blank = false; this.partiallyConsumedTab = false;
    let container = this.doc;
    this.oldtip = this.tip;
    let allMatched = true;
    let last;
    while ((last = container.lastChild) && last.open) {
      container = last;
      this.findNextNonspace();
      const r = this.continueBlock(container);
      if (r === 1) { container = container.parent; allMatched = false; break; }
      if (r === 2) return;
    }
    this.allClosed = container === this.oldtip;
    this.lastMatchedContainer = container;
    let matchedLeaf = container.type !== 'paragraph' && acceptsLines(container.type);
    while (!matchedLeaf) {
      this.findNextNonspace();
      if (!this.indented && !reMaybeSpecial.test(ln.slice(this.nextNonspace))) { this.advanceNextNonspace(); break; }
      const r = this.tryStarts(container);
      if (r === 1) container = this.tip;
      else if (r === 2) { container = this.tip; matchedLeaf = true; }
      else { this.advanceNextNonspace(); break; }
    }
    if (!this.allClosed && !this.blank && this.tip.type === 'paragraph') {
      this.addLine(); // lazy continuation
      return;
    }
    this.closeUnmatchedBlocks();
    if (acceptsLines(container.type)) this.addLine();
    else if (this.offset < ln.length && !this.blank) {
      this.addChild('paragraph');
      this.advanceNextNonspace();
      this.addLine();
    }
  }

  processInlines(node) {
    for (let c = node.firstChild; c; c = c.next) {
      if (c.type === 'paragraph' || c.type === 'heading') this.inline.parse(c, c.content);
      else if (c.type === 'table') {
        c.headerCells = c.header.map(t => { const n = new Node('cell'); this.inline.parse(n, t); return n; });
        const width = c.header.length;
        c.bodyRows = c.rows.map(r => {
          const cells = [];
          for (let i = 0; i < width; i++) { const n = new Node('cell'); this.inline.parse(n, r[i] || ''); cells.push(n); }
          return cells;
        });
      } else if (c.firstChild) this.processInlines(c);
    }
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function plainText(node) {
  let out = '';
  for (let c = node.firstChild; c; c = c.next) {
    if (c.type === 'text' || c.type === 'code') out += c.literal;
    else if (c.type === 'softbreak' || c.type === 'linebreak') out += c.type === 'softbreak' ? '\n' : '\n';
    else out += plainText(c);
  }
  return out;
}

function headingText(node) {
  return plainText(node).replace(/\n/g, ' ');
}

function renderInlines(node) {
  let out = '';
  for (let c = node.firstChild; c; c = c.next) {
    switch (c.type) {
      case 'text': out += escapeHtml(c.literal); break;
      case 'softbreak': out += '\n'; break;
      case 'linebreak': out += '<br />\n'; break;
      case 'code': out += '<code>' + escapeHtml(c.literal) + '</code>'; break;
      case 'emph': out += '<em>' + renderInlines(c) + '</em>'; break;
      case 'strong': out += '<strong>' + renderInlines(c) + '</strong>'; break;
      case 'del': out += '<del>' + renderInlines(c) + '</del>'; break;
      case 'link':
        out += '<a href="' + escapeHtml(safeUrl(c.destination)) + '"' + (c.title ? ' title="' + escapeHtml(c.title) + '"' : '') + '>' + renderInlines(c) + '</a>';
        break;
      case 'image':
        out += '<img src="' + escapeHtml(safeUrl(c.destination)) + '" alt="' + escapeHtml(plainText(c)) + '"' + (c.title ? ' title="' + escapeHtml(c.title) + '"' : '') + ' />';
        break;
    }
  }
  return out;
}

function renderBlocks(node, ctx, tight) {
  let out = '';
  for (let c = node.firstChild; c; c = c.next) out += renderBlock(c, ctx, tight);
  return out;
}

function renderBlock(b, ctx, tight) {
  switch (b.type) {
    case 'paragraph':
      return tight ? renderInlines(b) : '<p>' + renderInlines(b) + '</p>\n';
    case 'heading': {
      const tag = 'h' + b.level;
      let attr = '';
      if (ctx.headingIds) attr = ' id="' + escapeHtml(slugify(headingText(b), ctx.seen)) + '"';
      return `<${tag}${attr}>` + renderInlines(b) + `</${tag}>\n`;
    }
    case 'thematic_break': return '<hr />\n';
    case 'blockquote': return '<blockquote>\n' + renderBlocks(b, ctx, false) + '</blockquote>\n';
    case 'code_block': {
      let cls = '';
      if (b.info) { const lang = b.info.split(/\s+/)[0]; if (lang) cls = ' class="language-' + escapeHtml(lang) + '"'; }
      return '<pre><code' + cls + '>' + escapeHtml(b.literal) + '</code></pre>\n';
    }
    case 'list': {
      const ld = b.listData;
      const tag = ld.type === 'bullet' ? 'ul' : 'ol';
      const start = ld.type === 'ordered' && ld.start !== 1 ? ` start="${ld.start}"` : '';
      let out = `<${tag}${start}>\n`;
      for (let it = b.firstChild; it; it = it.next) {
        let inner = '';
        for (let c = it.firstChild; c; c = c.next) {
          const r = renderBlock(c, ctx, ld.tight);
          if (ld.tight && c.type !== 'paragraph' && inner && !inner.endsWith('\n')) inner += '\n';
          inner += r;
        }
        if (ld.tight && inner.endsWith('\n')) inner = inner; // keep
        out += '<li>' + inner + '</li>\n';
      }
      return out + `</${tag}>\n`;
    }
    case 'table': {
      const al = i => (b.align[i] ? ` align="${b.align[i]}"` : '');
      let out = '<table>\n<thead>\n<tr>\n';
      b.headerCells.forEach((c, i) => { out += `<th${al(i)}>` + renderInlines(c) + '</th>\n'; });
      out += '</tr>\n</thead>\n';
      if (b.bodyRows.length) {
        out += '<tbody>\n';
        for (const row of b.bodyRows) {
          out += '<tr>\n';
          row.forEach((c, i) => { out += `<td${al(i)}>` + renderInlines(c) + '</td>\n'; });
          out += '</tr>\n';
        }
        out += '</tbody>\n';
      }
      return out + '</table>\n';
    }
  }
  return '';
}

function parseDoc(markdown) {
  return new BlockParser().parse(String(markdown ?? ''));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function slugify(text, seen) {
  let base = String(text).toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
  if (!(seen instanceof Map)) return base;
  if (!seen.has(base)) { seen.set(base, 0); return base; }
  let n = seen.get(base);
  let cand;
  do { n++; cand = base + '-' + n; } while (seen.has(cand));
  seen.set(base, n);
  seen.set(cand, 0);
  return cand;
}

export function render(markdown, { headingIds = false } = {}) {
  const doc = parseDoc(markdown);
  return renderBlocks(doc, { headingIds, seen: new Map() }, false);
}

export function toc(markdown) {
  const doc = parseDoc(markdown);
  const seen = new Map();
  const out = [];
  const walk = node => {
    for (let c = node.firstChild; c; c = c.next) {
      if (c.type === 'heading') {
        const text = headingText(c);
        out.push({ level: c.level, text, slug: slugify(text, seen) });
      } else if (c.firstChild && c.type !== 'paragraph') walk(c);
    }
  };
  walk(doc);
  return out;
}

export default { render, toc, slugify };
