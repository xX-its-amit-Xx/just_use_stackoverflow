// Safe Markdown -> HTML renderer (CommonMark-style + GFM tables/strikethrough).
// Raw HTML is never passed through; dangerous URL schemes are neutralised.
import { decodeEntity } from './entities.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const ESCAPABLE = '[!"#$%&\'()*+,./:;<=>?@[\\\\\\]^_`{|}~-]';
const reEscapable = new RegExp('^' + ESCAPABLE);
const reEntity = /&(?:#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/;
const reEntityHere = new RegExp('^' + reEntity.source);
const reEscOrEnt = new RegExp('\\\\' + ESCAPABLE + '|' + reEntity.source, 'g');
const rePunct = /^[\p{P}\p{S}]/u;
const reUniWs = /^\s/u;
const reWsChar = /^[ \t\n\x0b\x0c\x0d]/;

function decodeEntityRef(ent) {
  const body = ent.slice(1, -1);
  if (body[0] === '#') {
    let cp = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
    if (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
    return String.fromCodePoint(cp);
  }
  const d = decodeEntity(body);
  return d === null ? ent : d;
}

function unescapeString(s) {
  if (!/[\\&]/.test(s)) return s;
  return s.replace(reEscOrEnt, m => (m[0] === '\\' ? m[1] : decodeEntityRef(m)));
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}

const urlSafe = /[A-Za-z0-9;/?:@&=+$,\-_.!~*'()#]/;
function normalizeURI(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '%' && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) { out += s.slice(i, i + 3); i += 2; continue; }
    if (urlSafe.test(c)) { out += c; continue; }
    const code = s.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { out += encodeURIComponent(c + s[i + 1]); i++; continue; }
      out += '%EF%BF%BD'; continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) { out += '%EF%BF%BD'; continue; }
    out += encodeURIComponent(c);
  }
  return out;
}

function isUnsafeUrl(url) {
  const u = url.replace(/[\x00-\x20\x7f]/g, '').toLowerCase();
  if (/^(?:javascript|vbscript|file):/.test(u)) return true;
  if (/^data:/.test(u)) return !/^data:image\/(?:png|gif|jpeg|webp);/.test(u);
  return false;
}

function safeHref(url) {
  if (isUnsafeUrl(url)) return '#';
  return escapeHtml(normalizeURI(url));
}

function normalizeReference(label) {
  return label.slice(1, -1).trim().replace(/[ \t\r\n]+/g, ' ').toLowerCase().toUpperCase();
}

function trimWs(s) { return s.replace(/^[ \t\n]+|[ \t\n]+$/g, ''); }

// ---------------------------------------------------------------------------
// Node (doubly-linked tree)
// ---------------------------------------------------------------------------

class Node {
  constructor(type) {
    this.type = type;
    this.parent = null; this.firstChild = null; this.lastChild = null;
    this.prev = null; this.next = null;
  }
  appendChild(child) {
    child.unlink();
    child.parent = this;
    if (this.lastChild) { this.lastChild.next = child; child.prev = this.lastChild; this.lastChild = child; }
    else { this.firstChild = this.lastChild = child; }
    return child;
  }
  unlink() {
    if (this.prev) this.prev.next = this.next; else if (this.parent) this.parent.firstChild = this.next;
    if (this.next) this.next.prev = this.prev; else if (this.parent) this.parent.lastChild = this.prev;
    this.parent = this.next = this.prev = null;
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
  insertBefore(sib) {
    sib.unlink();
    sib.prev = this.prev;
    if (sib.prev) sib.prev.next = sib;
    sib.next = this;
    this.prev = sib;
    sib.parent = this.parent;
    if (!sib.prev && sib.parent) sib.parent.firstChild = sib;
  }
}

function textNode(s) { const n = new Node('text'); n.literal = s; return n; }

// ---------------------------------------------------------------------------
// Link reference / inline sub-parsers (shared by block parser for ref defs)
// ---------------------------------------------------------------------------

const reLinkLabel = /^\[(?:[^\\[\]]|\\[\s\S]){0,1000}\]/;
const reLinkTitle = /^(?:"((?:\\[\s\S]|[^"\\\x00])*)"|'((?:\\[\s\S]|[^'\\\x00])*)'|\(((?:\\[\s\S]|[^()\\\x00])*)\))/;
const reLinkDestBraces = /^<(?:[^<>\n\\\x00]|\\[\s\S])*>/;
const reSpnl = /^[ \t]*(?:\n[ \t]*)?/;

class Cursor {
  constructor(s) { this.subject = s; this.pos = 0; }
  peek() { return this.pos < this.subject.length ? this.subject[this.pos] : null; }
  match(re) {
    const m = re.exec(this.subject.slice(this.pos));
    if (m === null) return null;
    this.pos += m.index + m[0].length;
    return m[0];
  }
  spnl() { this.match(reSpnl); return true; }
  parseLinkLabel() {
    const m = this.subject.slice(this.pos).match(reLinkLabel);
    if (m === null || m[0].length > 1001) return 0;
    this.pos += m[0].length;
    return m[0].length;
  }
  parseLinkTitle() {
    const t = this.match(reLinkTitle);
    if (t === null) return null;
    return unescapeString(t.slice(1, -1));
  }
  parseLinkDestination() {
    const res = this.match(reLinkDestBraces);
    if (res !== null) return unescapeString(res.slice(1, -1));
    if (this.peek() === '<') return null;
    const save = this.pos;
    let open = 0, c;
    while ((c = this.peek()) !== null) {
      if (c === '\\' && reEscapable.test(this.subject[this.pos + 1] || '')) this.pos += 2;
      else if (c === '(') { this.pos++; open++; }
      else if (c === ')') { if (open < 1) break; this.pos++; open--; }
      else if (reWsChar.test(c) || c.charCodeAt(0) < 0x20 || c === '\x7f') break;
      else this.pos++;
    }
    if (this.pos === save && c !== ')') return null;
    if (open !== 0) { this.pos = save; return null; }
    return unescapeString(this.subject.slice(save, this.pos));
  }
}

// Try to parse a link reference definition at the start of s.
// Returns number of chars consumed (0 if none).
function parseReference(s, refmap) {
  const cur = new Cursor(s);
  const n = cur.parseLinkLabel();
  if (n === 0) return 0;
  const rawLabel = s.slice(0, n);
  if (cur.peek() !== ':') return 0;
  cur.pos++;
  cur.spnl();
  const dest = cur.parseLinkDestination();
  if (dest === null) return 0;
  // destination must not be empty unless written as <>
  if (dest === '' && s[cur.pos - 1] !== '>') return 0;
  const beforeTitle = cur.pos;
  cur.spnl();
  let title = null;
  if (cur.pos !== beforeTitle) title = cur.parseLinkTitle();
  if (title === null) { title = ''; cur.pos = beforeTitle; }
  let atLineEnd = true;
  if (cur.match(/^[ \t]*(?:\n|$)/) === null) {
    if (title === '') atLineEnd = false;
    else {
      title = ''; cur.pos = beforeTitle;
      atLineEnd = cur.match(/^[ \t]*(?:\n|$)/) !== null;
    }
  }
  if (!atLineEnd) return 0;
  const norm = normalizeReference(rawLabel);
  if (norm === '') return 0;
  if (!refmap.has(norm)) refmap.set(norm, { destination: dest, title });
  return cur.pos;
}

// ---------------------------------------------------------------------------
// Inline parser
// ---------------------------------------------------------------------------

const reMain = /^[^\n`[\]\\!<&*_~]+/;
const reEmailAutolink = /^<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/;
const reAutolink = /^<[A-Za-z][A-Za-z0-9.+-]{1,31}:[^<>\x00-\x20]*>/;

class InlineParser extends Cursor {
  constructor(refmap) { super(''); this.refmap = refmap; }

  parse(block, content) {
    this.subject = trimWs(content);
    this.pos = 0;
    this.delimiters = null;
    this.brackets = null;
    while (this.parseInline(block));
    this.processEmphasis(null);
  }

  parseInline(block) {
    const c = this.peek();
    if (c === null) return false;
    let res = false;
    switch (c) {
      case '\n': res = this.handleNewline(block); break;
      case '\\': res = this.handleBackslash(block); break;
      case '`': res = this.handleBackticks(block); break;
      case '*': case '_': case '~': res = this.handleDelim(c, block); break;
      case '[': res = this.parseOpenBracket(block); break;
      case '!': res = this.parseBang(block); break;
      case ']': res = this.parseCloseBracket(block); break;
      case '<': res = this.parseAutolink(block); break;
      case '&': res = this.parseEntity(block); break;
      default: res = this.parseString(block);
    }
    if (!res) { this.pos++; block.appendChild(textNode(c)); }
    return true;
  }

  parseString(block) {
    const m = this.match(reMain);
    if (m === null) return false;
    block.appendChild(textNode(m));
    return true;
  }

  handleNewline(block) {
    this.pos++;
    const last = block.lastChild;
    if (last && last.type === 'text' && last.literal.endsWith(' ')) {
      const hard = last.literal.endsWith('  ');
      last.literal = last.literal.replace(/ +$/, '');
      block.appendChild(new Node(hard ? 'linebreak' : 'softbreak'));
    } else {
      block.appendChild(new Node('softbreak'));
    }
    this.match(/^[ \t]*/);
    return true;
  }

  handleBackslash(block) {
    this.pos++;
    const c = this.peek();
    if (c === '\n') { this.pos++; block.appendChild(new Node('linebreak')); }
    else if (c !== null && reEscapable.test(c)) { this.pos++; block.appendChild(textNode(c)); }
    else block.appendChild(textNode('\\'));
    return true;
  }

  handleBackticks(block) {
    const ticks = this.match(/^`+/);
    const afterOpen = this.pos;
    let m;
    while ((m = this.match(/`+/)) !== null) {
      if (m === ticks) {
        let contents = this.subject.slice(afterOpen, this.pos - ticks.length).replace(/\n/g, ' ');
        if (contents.length > 0 && /[^ ]/.test(contents) && contents[0] === ' ' && contents[contents.length - 1] === ' ') {
          contents = contents.slice(1, -1);
        }
        const node = new Node('code');
        node.literal = contents;
        block.appendChild(node);
        return true;
      }
    }
    this.pos = afterOpen;
    block.appendChild(textNode(ticks));
    return true;
  }

  parseAutolink(block) {
    const rest = this.subject.slice(this.pos);
    let m;
    if ((m = rest.match(reEmailAutolink))) {
      this.pos += m[0].length;
      const node = new Node('link');
      node.destination = 'mailto:' + m[1];
      node.title = '';
      node.appendChild(textNode(m[1]));
      block.appendChild(node);
      return true;
    }
    if ((m = rest.match(reAutolink))) {
      this.pos += m[0].length;
      const url = m[0].slice(1, -1);
      const node = new Node('link');
      node.destination = url;
      node.title = '';
      node.appendChild(textNode(url));
      block.appendChild(node);
      return true;
    }
    return false; // raw HTML is not recognised: '<' becomes literal text
  }

  parseEntity(block) {
    const m = this.match(reEntityHere);
    if (m === null) return false;
    block.appendChild(textNode(decodeEntityRef(m)));
    return true;
  }

  scanDelims(c) {
    const start = this.pos;
    let n = 0;
    while (this.subject[this.pos] === c) { n++; this.pos++; }
    if (n === 0) return null;
    let before = '\n';
    if (start > 0) {
      const cp = this.subject.codePointAt(start - 1);
      const lo = this.subject.charCodeAt(start - 1);
      if (lo >= 0xdc00 && lo <= 0xdfff && start > 1) before = String.fromCodePoint(this.subject.codePointAt(start - 2));
      else before = String.fromCodePoint(cp);
    }
    const after = this.pos < this.subject.length ? String.fromCodePoint(this.subject.codePointAt(this.pos)) : '\n';
    const afterWs = reUniWs.test(after), afterP = rePunct.test(after);
    const beforeWs = reUniWs.test(before), beforeP = rePunct.test(before);
    const left = !afterWs && (!afterP || beforeWs || beforeP);
    const right = !beforeWs && (!beforeP || afterWs || afterP);
    let canOpen, canClose;
    if (c === '_') {
      canOpen = left && (!right || beforeP);
      canClose = right && (!left || afterP);
    } else {
      canOpen = left; canClose = right;
    }
    this.pos = start;
    return { n, canOpen, canClose };
  }

  handleDelim(c, block) {
    const res = this.scanDelims(c);
    if (!res) return false;
    const start = this.pos;
    this.pos += res.n;
    const node = textNode(this.subject.slice(start, this.pos));
    block.appendChild(node);
    if ((res.canOpen || res.canClose) && (c !== '~' || res.n <= 2)) {
      this.delimiters = {
        cc: c, numdelims: res.n, origdelims: res.n, node,
        previous: this.delimiters, next: null, canOpen: res.canOpen, canClose: res.canClose,
      };
      if (this.delimiters.previous) this.delimiters.previous.next = this.delimiters;
    }
    return true;
  }

  removeDelimiter(d) {
    if (d.previous) d.previous.next = d.next;
    if (d.next) d.next.previous = d.previous;
    else this.delimiters = d.previous;
  }

  processEmphasis(stackBottom) {
    const openersBottom = new Map();
    let closer = this.delimiters;
    while (closer !== null && closer.previous !== stackBottom) closer = closer.previous;
    while (closer !== null) {
      if (!closer.canClose) { closer = closer.next; continue; }
      const cc = closer.cc;
      const key = cc === '~' ? '~' + closer.origdelims : cc + (closer.canOpen ? '1' : '0') + (closer.origdelims % 3);
      const bottom = openersBottom.has(key) ? openersBottom.get(key) : stackBottom;
      let opener = closer.previous;
      let found = false;
      while (opener !== null && opener !== stackBottom && opener !== bottom) {
        if (cc === '~') {
          if (opener.cc === '~' && opener.canOpen && opener.origdelims === closer.origdelims) { found = true; break; }
        } else {
          const oddMatch = (closer.canOpen || opener.canClose) && closer.origdelims % 3 !== 0 &&
            (opener.origdelims + closer.origdelims) % 3 === 0;
          if (opener.cc === cc && opener.canOpen && !oddMatch) { found = true; break; }
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
        if (closer.numdelims === 0) {
          cNode.unlink();
          const nx = closer.next;
          this.removeDelimiter(closer);
          closer = nx;
        }
      } else {
        closer = closer.next;
        openersBottom.set(key, oldCloser.previous);
        if (!oldCloser.canOpen) this.removeDelimiter(oldCloser);
      }
    }
    while (this.delimiters !== null && this.delimiters !== stackBottom) this.removeDelimiter(this.delimiters);
  }

  addBracket(node, index, image) {
    if (this.brackets) this.brackets.bracketAfter = true;
    this.brackets = { node, previous: this.brackets, previousDelimiter: this.delimiters, index, image, active: true, bracketAfter: false };
  }

  parseOpenBracket(block) {
    const start = this.pos;
    this.pos++;
    const node = textNode('[');
    block.appendChild(node);
    this.addBracket(node, start, false);
    return true;
  }

  parseBang(block) {
    const start = this.pos;
    this.pos++;
    if (this.peek() === '[') {
      this.pos++;
      const node = textNode('![');
      block.appendChild(node);
      this.addBracket(node, start + 1, true);
    } else {
      block.appendChild(textNode('!'));
    }
    return true;
  }

  parseCloseBracket(block) {
    this.pos++;
    const startpos = this.pos;
    let opener = this.brackets;
    if (!opener) { block.appendChild(textNode(']')); return true; }
    if (!opener.active) { block.appendChild(textNode(']')); this.brackets = opener.previous; return true; }
    const isImage = opener.image;
    const savepos = this.pos;
    let matched = false, dest = null, title = null;
    if (this.peek() === '(') {
      this.pos++;
      this.spnl();
      dest = this.parseLinkDestination();
      if (dest !== null) {
        this.spnl();
        if (reWsChar.test(this.subject[this.pos - 1] || '')) {
          title = this.parseLinkTitle();
        }
        this.spnl();
        if (this.peek() === ')') { this.pos++; matched = true; }
      }
      if (!matched) this.pos = savepos;
    }
    if (!matched) {
      const beforeLabel = this.pos;
      const n = this.parseLinkLabel();
      let reflabel = null;
      if (n > 2) reflabel = this.subject.slice(beforeLabel, beforeLabel + n);
      else if (!opener.bracketAfter) reflabel = this.subject.slice(opener.index, startpos);
      if (n === 0) this.pos = savepos;
      if (reflabel !== null && reflabel.length <= 1001) {
        const link = this.refmap.get(normalizeReference(reflabel));
        if (link) { dest = link.destination; title = link.title; matched = true; }
      }
    }
    if (matched) {
      const node = new Node(isImage ? 'image' : 'link');
      node.destination = dest;
      node.title = title || '';
      let tmp = opener.node.next;
      while (tmp) { const nx = tmp.next; node.appendChild(tmp); tmp = nx; }
      block.appendChild(node);
      this.processEmphasis(opener.previousDelimiter);
      this.brackets = opener.previous;
      opener.node.unlink();
      if (!isImage) {
        let o = this.brackets;
        while (o !== null) { if (!o.image) o.active = false; o = o.previous; }
      }
      return true;
    }
    this.brackets = opener.previous;
    this.pos = startpos;
    block.appendChild(textNode(']'));
    return true;
  }
}

// ---------------------------------------------------------------------------
// Block parser
// ---------------------------------------------------------------------------

const reMaybeSpecial = /^[#`~*+_=<>0-9|:-]/;
const reClosingFence = /^(?:`{3,}|~{3,})(?=[ \t]*$)/;
const reThematic = /^(?:\*[ \t]*){3,}$|^(?:_[ \t]*){3,}$|^(?:-[ \t]*){3,}$/;
const reTableDelimCell = /^:?-+:?$/;

function isSpaceOrTab(c) { return c === ' ' || c === '\t'; }

function splitRow(line) {
  let s = line.replace(/^[ \t]+|[ \t]+$/g, '');
  if (s[0] === '|') s = s.slice(1);
  const cells = [];
  let cur = '';
  let trailingPipe = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && s[i + 1] === '|') { cur += '|'; i++; }
    else if (c === '\\' && i + 1 < s.length) { cur += c + s[i + 1]; i++; }
    else if (c === '|') {
      cells.push(cur); cur = '';
      if (i === s.length - 1) trailingPipe = true;
    } else cur += c;
  }
  if (!trailingPipe) cells.push(cur);
  return cells.map(x => x.replace(/^[ \t]+|[ \t]+$/g, ''));
}

const blocks = {
  document: {
    continue: () => 0,
    canContain: t => t !== 'item',
    acceptsLines: false,
    finalize() {},
  },
  list: {
    continue: () => 0,
    canContain: t => t === 'item',
    acceptsLines: false,
    finalize(p, block) {
      let item = block.firstChild;
      const endsBlank = b => b.next && b.endLine !== b.next.startLine - 1;
      outer: while (item) {
        if (item.next && endsBlank(item)) { block.listData.tight = false; break; }
        let sub = item.firstChild;
        while (sub) {
          if (sub.next && endsBlank(sub)) { block.listData.tight = false; break outer; }
          sub = sub.next;
        }
        item = item.next;
      }
      if (block.lastChild) block.endLine = block.lastChild.endLine;
    },
  },
  block_quote: {
    continue(p) {
      const ln = p.currentLine;
      if (!p.indented && ln[p.nextNonspace] === '>') {
        p.advanceNextNonspace();
        p.advanceOffset(1, false);
        if (isSpaceOrTab(ln[p.offset])) p.advanceOffset(1, true);
        return 0;
      }
      return 1;
    },
    canContain: t => t !== 'item',
    acceptsLines: false,
    finalize() {},
  },
  item: {
    continue(p, c) {
      if (p.blank) {
        if (c.firstChild === null) return 1;
        p.advanceNextNonspace();
      } else if (p.indent >= c.listData.markerOffset + c.listData.padding) {
        p.advanceOffset(c.listData.markerOffset + c.listData.padding, true);
      } else return 1;
      return 0;
    },
    canContain: t => t !== 'item',
    acceptsLines: false,
    finalize(p, block) {
      if (block.lastChild) block.endLine = block.lastChild.endLine;
      else block.endLine = block.startLine;
    },
  },
  heading: {
    continue: () => 1,
    canContain: () => false,
    acceptsLines: false,
    finalize() {},
  },
  thematic_break: {
    continue: () => 1,
    canContain: () => false,
    acceptsLines: false,
    finalize() {},
  },
  code_block: {
    continue(p, c) {
      const ln = p.currentLine;
      const indent = p.indent;
      if (c.isFenced) {
        const m = indent <= 3 && ln[p.nextNonspace] === c.fenceChar && ln.slice(p.nextNonspace).match(reClosingFence);
        if (m && m[0].length >= c.fenceLength) {
          p.finalize(c, p.lineNumber);
          return 2;
        }
        let i = c.fenceOffset;
        while (i > 0 && isSpaceOrTab(ln[p.offset])) { p.advanceOffset(1, true); i--; }
      } else {
        if (indent >= 4) p.advanceOffset(4, true);
        else if (p.blank) p.advanceNextNonspace();
        else return 1;
      }
      return 0;
    },
    canContain: () => false,
    acceptsLines: true,
    finalize(p, block) {
      if (block.isFenced) {
        const content = block.content;
        const nl = content.indexOf('\n');
        const first = content.slice(0, nl);
        block.info = unescapeString(first.trim());
        block.literal = content.slice(nl + 1);
      } else {
        block.literal = block.content.replace(/(\n *)+$/, '\n');
      }
    },
  },
  paragraph: {
    continue: p => (p.blank ? 1 : 0),
    canContain: () => false,
    acceptsLines: true,
    finalize(p, block) {
      let pos;
      while (block.content[0] === '[' && (pos = parseReference(block.content, p.refmap))) {
        block.content = block.content.slice(pos);
      }
      if (/^[ \t\n]*$/.test(block.content)) block.unlink();
    },
  },
  table: {
    continue: p => (p.blank ? 1 : 0),
    canContain: () => false,
    acceptsLines: true,
    finalize(p, block) {
      const n = block.aligns.length;
      block.rows = [];
      for (const line of block.content.split('\n')) {
        if (line.trim() === '') continue;
        const cells = splitRow(line).slice(0, n);
        while (cells.length < n) cells.push('');
        block.rows.push(cells);
      }
    },
  },
};

const blockStarts = [
  // block quote
  (p) => {
    if (!p.indented && p.currentLine[p.nextNonspace] === '>') {
      p.advanceNextNonspace();
      p.advanceOffset(1, false);
      if (isSpaceOrTab(p.currentLine[p.offset])) p.advanceOffset(1, true);
      p.closeUnmatchedBlocks();
      p.addChild('block_quote');
      return 1;
    }
    return 0;
  },
  // ATX heading
  (p) => {
    let m;
    if (!p.indented && (m = p.currentLine.slice(p.nextNonspace).match(/^#{1,6}(?:[ \t]+|$)/))) {
      p.advanceNextNonspace();
      p.advanceOffset(m[0].length, false);
      p.closeUnmatchedBlocks();
      const h = p.addChild('heading');
      h.level = m[0].trim().length;
      h.content = p.currentLine.slice(p.offset).replace(/^[ \t]*#+[ \t]*$/, '').replace(/[ \t]+#+[ \t]*$/, '');
      p.advanceOffset(p.currentLine.length - p.offset);
      return 2;
    }
    return 0;
  },
  // fenced code
  (p) => {
    let m;
    if (!p.indented && (m = p.currentLine.slice(p.nextNonspace).match(/^`{3,}(?!.*`)|^~{3,}/))) {
      const len = m[0].length;
      p.closeUnmatchedBlocks();
      const c = p.addChild('code_block');
      c.isFenced = true;
      c.fenceLength = len;
      c.fenceChar = m[0][0];
      c.fenceOffset = p.indent;
      p.advanceNextNonspace();
      p.advanceOffset(len, false);
      return 2;
    }
    return 0;
  },
  // setext heading
  (p, container) => {
    let m;
    if (!p.indented && container.type === 'paragraph' && (m = p.currentLine.slice(p.nextNonspace).match(/^(?:=+|-+)[ \t]*$/))) {
      p.closeUnmatchedBlocks();
      let pos;
      while (container.content[0] === '[' && (pos = parseReference(container.content, p.refmap))) {
        container.content = container.content.slice(pos);
      }
      if (container.content.length > 0) {
        const h = new Node('heading');
        h.level = m[0][0] === '=' ? 1 : 2;
        h.content = container.content;
        h.startLine = container.startLine;
        h.open = true;
        container.insertAfter(h);
        container.unlink();
        p.tip = h;
        p.advanceOffset(p.currentLine.length - p.offset, false);
        return 2;
      }
      return 0;
    }
    return 0;
  },
  // GFM table (delimiter row following a paragraph line)
  (p, container) => {
    if (p.indented || container.type !== 'paragraph') return 0;
    const delim = p.currentLine.slice(p.nextNonspace);
    if (!delim.includes('|') || !/^[ \t|:-]+$/.test(delim)) return 0;
    const dcells = splitRow(delim);
    if (dcells.length === 0 || !dcells.every(c => reTableDelimCell.test(c))) return 0;
    // resolve link reference definitions first
    let pos;
    while (container.content[0] === '[' && (pos = parseReference(container.content, p.refmap))) {
      container.content = container.content.slice(pos);
    }
    const lines = container.content.replace(/\n$/, '').split('\n');
    const header = lines[lines.length - 1];
    if (header.trim() === '') return 0;
    const hcells = splitRow(header);
    if (hcells.length !== dcells.length) return 0;
    p.closeUnmatchedBlocks();
    const aligns = dcells.map(c => {
      const l = c[0] === ':', r = c[c.length - 1] === ':';
      return l && r ? 'center' : l ? 'left' : r ? 'right' : null;
    });
    const table = new Node('table');
    table.open = true;
    table.content = '';
    table.header = hcells;
    table.aligns = aligns;
    if (lines.length > 1) {
      container.content = lines.slice(0, -1).join('\n') + '\n';
      container.insertAfter(table);
      table.startLine = p.lineNumber - 1;
      p.finalize(container, p.lineNumber - 2);
    } else {
      table.startLine = container.startLine;
      container.insertAfter(table);
      container.unlink();
    }
    p.tip = table;
    p.advanceOffset(p.currentLine.length - p.offset, false);
    return 2;
  },
  // thematic break
  (p) => {
    if (!p.indented && reThematic.test(p.currentLine.slice(p.nextNonspace))) {
      p.closeUnmatchedBlocks();
      p.addChild('thematic_break');
      p.advanceOffset(p.currentLine.length - p.offset, false);
      return 2;
    }
    return 0;
  },
  // list item
  (p, container) => {
    if (p.indented && container.type !== 'list') return 0;
    const data = parseListMarker(p, container);
    if (!data) return 0;
    p.closeUnmatchedBlocks();
    if (p.tip.type !== 'list' || !listsMatch(container.listData, data)) {
      const l = p.addChild('list');
      l.listData = data;
    }
    const item = p.addChild('item');
    item.listData = data;
    return 1;
  },
  // indented code
  (p) => {
    if (p.indented && p.tip.type !== 'paragraph' && p.tip.type !== 'table' && !p.blank) {
      p.advanceOffset(4, true);
      p.closeUnmatchedBlocks();
      p.addChild('code_block');
      return 2;
    }
    return 0;
  },
];

function listsMatch(a, b) {
  return !!a && a.type === b.type && a.delimiter === b.delimiter && a.bulletChar === b.bulletChar;
}

function parseListMarker(p, container) {
  const ln = p.currentLine;
  const rest = ln.slice(p.nextNonspace);
  if (p.indent >= 4) return null;
  const data = { type: null, tight: true, bulletChar: null, start: null, delimiter: null, padding: null, markerOffset: p.indent };
  let m;
  if ((m = rest.match(/^[*+-]/))) {
    data.type = 'bullet';
    data.bulletChar = m[0];
  } else if ((m = rest.match(/^(\d{1,9})([.)])/)) && (container.type !== 'paragraph' || m[1] === '1')) {
    data.type = 'ordered';
    data.start = parseInt(m[1], 10);
    data.delimiter = m[2];
  } else return null;
  const nextc = ln[p.nextNonspace + m[0].length];
  if (!(nextc === undefined || nextc === ' ' || nextc === '\t')) return null;
  if (container.type === 'paragraph' && /^[ \t]*$/.test(ln.slice(p.nextNonspace + m[0].length))) return null;
  p.advanceNextNonspace();
  p.advanceOffset(m[0].length, true);
  const spacesStartCol = p.column;
  const spacesStartOffset = p.offset;
  let c;
  do {
    p.advanceOffset(1, true);
    c = ln[p.offset];
  } while (p.column - spacesStartCol < 5 && isSpaceOrTab(c));
  const blankItem = ln[p.offset] === undefined;
  const spacesAfter = p.column - spacesStartCol;
  if (spacesAfter >= 5 || spacesAfter < 1 || blankItem) {
    data.padding = m[0].length + 1;
    p.column = spacesStartCol;
    p.offset = spacesStartOffset;
    p.partiallyConsumedTab = false;
    if (isSpaceOrTab(ln[p.offset])) p.advanceOffset(1, true);
  } else {
    data.padding = m[0].length + spacesAfter;
  }
  return data;
}

class BlockParser {
  constructor() {
    this.doc = new Node('document');
    this.doc.open = true;
    this.doc.startLine = 1;
    this.tip = this.doc;
    this.oldtip = this.doc;
    this.lineNumber = 0;
    this.refmap = new Map();
  }

  findNextNonspace() {
    const ln = this.currentLine;
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

  advanceNextNonspace() {
    this.offset = this.nextNonspace;
    this.column = this.nextNonspaceColumn;
    this.partiallyConsumedTab = false;
  }

  advanceOffset(count, columns) {
    const ln = this.currentLine;
    let c;
    while (count > 0 && (c = ln[this.offset]) !== undefined) {
      if (c === '\t') {
        const toTab = 4 - (this.column % 4);
        if (columns) {
          this.partiallyConsumedTab = toTab > count;
          const adv = toTab > count ? count : toTab;
          this.column += adv;
          this.offset += this.partiallyConsumedTab ? 0 : 1;
          count -= adv;
        } else {
          this.partiallyConsumedTab = false;
          this.column += toTab;
          this.offset += 1;
          count -= 1;
        }
      } else {
        this.partiallyConsumedTab = false;
        this.offset += 1;
        this.column += 1;
        count -= 1;
      }
    }
  }

  addLine() {
    if (this.partiallyConsumedTab) {
      this.offset += 1;
      const toTab = 4 - (this.column % 4);
      this.tip.content += ' '.repeat(toTab);
    }
    this.tip.content += this.currentLine.slice(this.offset) + '\n';
  }

  addChild(tag) {
    while (!blocks[this.tip.type].canContain(tag)) this.finalize(this.tip, this.lineNumber - 1);
    const node = new Node(tag);
    node.open = true;
    node.content = '';
    node.startLine = this.lineNumber;
    this.tip.appendChild(node);
    this.tip = node;
    return node;
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

  finalize(block, lineNumber) {
    const above = block.parent;
    block.open = false;
    block.endLine = lineNumber;
    blocks[block.type].finalize(this, block);
    this.tip = above;
  }

  incorporateLine(ln) {
    let allMatched = true;
    let container = this.doc;
    this.oldtip = this.tip;
    this.offset = 0;
    this.column = 0;
    this.blank = false;
    this.partiallyConsumedTab = false;
    this.lineNumber += 1;
    if (ln.indexOf('\u0000') !== -1) ln = ln.replace(/\0/g, '�');
    this.currentLine = ln;

    let last;
    while ((last = container.lastChild) && last.open) {
      container = last;
      this.findNextNonspace();
      const r = blocks[container.type].continue(this, container);
      if (r === 1) { allMatched = false; }
      else if (r === 2) { return; }
      if (!allMatched) { container = container.parent; break; }
    }

    this.allClosed = container === this.oldtip;
    this.lastMatchedContainer = container;

    let matchedLeaf = container.type !== 'paragraph' && container.type !== 'table' && blocks[container.type].acceptsLines;
    while (!matchedLeaf) {
      this.findNextNonspace();
      if (!this.indented && !reMaybeSpecial.test(ln.slice(this.nextNonspace))) {
        this.advanceNextNonspace();
        break;
      }
      let i = 0;
      for (; i < blockStarts.length; i++) {
        const res = blockStarts[i](this, container);
        if (res === 1) { container = this.tip; break; }
        if (res === 2) { container = this.tip; matchedLeaf = true; break; }
      }
      if (i === blockStarts.length) { this.advanceNextNonspace(); break; }
    }

    if (!this.allClosed && !this.blank && this.tip.type === 'paragraph') {
      // lazy paragraph continuation
      this.addLine();
    } else {
      this.closeUnmatchedBlocks();
      const t = container.type;
      if (blocks[t].acceptsLines) {
        this.addLine();
      } else if (this.offset < ln.length && !this.blank) {
        this.addChild('paragraph');
        this.advanceNextNonspace();
        this.addLine();
      }
    }
  }

  parse(input) {
    const lines = String(input).split(/\r\n|\n|\r/);
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    for (const l of lines) this.incorporateLine(l);
    while (this.tip) this.finalize(this.tip, lines.length);
    this.processInlines(this.doc);
    return this.doc;
  }

  processInlines(node) {
    const ip = new InlineParser(this.refmap);
    const walk = (n) => {
      if (n.type === 'paragraph' || n.type === 'heading') {
        ip.parse(n, n.content);
      } else if (n.type === 'table') {
        n.headerNodes = n.header.map(c => { const x = new Node('cell'); ip.parse(x, c); return x; });
        n.rowNodes = n.rows.map(r => r.map(c => { const x = new Node('cell'); ip.parse(x, c); return x; }));
      } else {
        for (let c = n.firstChild; c; c = c.next) walk(c);
      }
    };
    walk(node);
  }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function plainText(node) {
  let out = '';
  for (let c = node.firstChild; c; c = c.next) {
    switch (c.type) {
      case 'text': case 'code': out += c.literal; break;
      case 'softbreak': case 'linebreak': out += ' '; break;
      default: out += plainText(c);
    }
  }
  return out;
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
        out += '<a href="' + safeHref(c.destination) + '"' +
          (c.title ? ' title="' + escapeHtml(c.title) + '"' : '') + '>' + renderInlines(c) + '</a>';
        break;
      case 'image':
        out += '<img src="' + safeHref(c.destination) + '" alt="' + escapeHtml(plainText(c)) + '"' +
          (c.title ? ' title="' + escapeHtml(c.title) + '"' : '') + ' />';
        break;
      default: out += renderInlines(c);
    }
  }
  return out;
}

function renderBlock(node, ctx) {
  switch (node.type) {
    case 'document': {
      let out = '';
      for (let c = node.firstChild; c; c = c.next) out += renderBlock(c, ctx);
      return out;
    }
    case 'paragraph': {
      const gp = node.parent && node.parent.parent;
      if (gp && gp.type === 'list' && gp.listData.tight) return renderInlines(node);
      return '<p>' + renderInlines(node) + '</p>\n';
    }
    case 'heading': {
      const tag = 'h' + node.level;
      let id = '';
      if (ctx.headingIds) id = ' id="' + escapeHtml(slugify(plainText(node), ctx.seen)) + '"';
      return '<' + tag + id + '>' + renderInlines(node) + '</' + tag + '>\n';
    }
    case 'thematic_break': return '<hr />\n';
    case 'code_block': {
      let cls = '';
      if (node.isFenced && node.info) {
        const lang = node.info.split(/[ \t\n]+/)[0];
        if (lang) cls = ' class="language-' + escapeHtml(lang) + '"';
      }
      return '<pre><code' + cls + '>' + escapeHtml(node.literal) + '</code></pre>\n';
    }
    case 'block_quote': {
      let out = '<blockquote>\n';
      for (let c = node.firstChild; c; c = c.next) out += renderBlock(c, ctx);
      return out + '</blockquote>\n';
    }
    case 'list': {
      const d = node.listData;
      const tag = d.type === 'bullet' ? 'ul' : 'ol';
      const start = d.type === 'ordered' && d.start !== 1 ? ' start="' + d.start + '"' : '';
      let out = '<' + tag + start + '>\n';
      for (let c = node.firstChild; c; c = c.next) out += renderBlock(c, ctx);
      return out + '</' + tag + '>\n';
    }
    case 'item': {
      const tight = node.parent.listData.tight;
      let out = '<li>';
      for (let c = node.firstChild; c; c = c.next) {
        const r = renderBlock(c, ctx);
        if (c.type === 'paragraph' && tight) out += r;
        else {
          if (!out.endsWith('\n')) out += '\n';
          out += r;
        }
      }
      return out + '</li>\n';
    }
    case 'table': {
      const attr = i => (node.aligns[i] ? ' align="' + node.aligns[i] + '"' : '');
      let out = '<table>\n<thead>\n<tr>\n';
      node.headerNodes.forEach((c, i) => { out += '<th' + attr(i) + '>' + renderInlines(c) + '</th>\n'; });
      out += '</tr>\n</thead>\n';
      if (node.rowNodes.length) {
        out += '<tbody>\n';
        for (const row of node.rowNodes) {
          out += '<tr>\n';
          row.forEach((c, i) => { out += '<td' + attr(i) + '>' + renderInlines(c) + '</td>\n'; });
          out += '</tr>\n';
        }
        out += '</tbody>\n';
      }
      return out + '</table>\n';
    }
    default: return '';
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function slugify(text, seen) {
  let slug = String(text).toLowerCase().replace(/[^\p{L}\p{M}\p{N} _-]/gu, '').replace(/ /g, '-');
  if (seen instanceof Map) {
    const base = slug;
    if (seen.has(slug)) {
      let n = seen.get(base);
      do { n++; slug = base + '-' + n; } while (seen.has(slug));
      seen.set(base, n);
    }
    seen.set(slug, 0);
  }
  return slug;
}

export function parse(markdown) {
  return new BlockParser().parse(markdown == null ? '' : String(markdown));
}

export function render(markdown, { headingIds = false } = {}) {
  const doc = parse(markdown);
  return renderBlock(doc, { headingIds, seen: new Map() });
}

export function toc(markdown) {
  const doc = parse(markdown);
  const seen = new Map();
  const out = [];
  const walk = (n) => {
    if (n.type === 'heading') {
      const text = plainText(n);
      out.push({ level: n.level, text, slug: slugify(text, seen) });
      return;
    }
    for (let c = n.firstChild; c; c = c.next) walk(c);
  };
  walk(doc);
  return out;
}

export default { render, toc, slugify };
