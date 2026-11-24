// Inline parser adapted from commonmark.js lib/inlines.js and lib/common.js
// (Copyright (c) 2014, John MacFarlane, BSD-2-Clause; see THIRD_PARTY_NOTICES.md).
// Changes: converted to a self-contained ES class, own minimal Node class,
// no raw-HTML inlines (they are left as escaped text), no reference links,
// no smart punctuation, built-in entity table and URL encoder instead of the
// `entities` / `mdurl` npm packages.

// ---------------------------------------------------------------- Node
export class Node {
  constructor(type, literal = '') {
    this.type = type;
    this.literal = literal;
    this.parent = this.prev = this.next = this.firstChild = this.lastChild = null;
    this.destination = '';
    this.title = '';
  }
  appendChild(child) {
    child.unlink();
    child.parent = this;
    if (this.lastChild) { this.lastChild.next = child; child.prev = this.lastChild; this.lastChild = child; }
    else { this.firstChild = this.lastChild = child; }
  }
  insertAfter(sibling) {
    sibling.unlink();
    sibling.next = this.next;
    if (sibling.next) sibling.next.prev = sibling;
    sibling.prev = this;
    this.next = sibling;
    sibling.parent = this.parent;
    if (!sibling.next && sibling.parent) sibling.parent.lastChild = sibling;
  }
  unlink() {
    if (this.prev) this.prev.next = this.next;
    else if (this.parent) this.parent.firstChild = this.next;
    if (this.next) this.next.prev = this.prev;
    else if (this.parent) this.parent.lastChild = this.prev;
    this.parent = this.next = this.prev = null;
  }
}

// ---------------------------------------------------------------- common
export const ESCAPABLE = "[!\"#$%&'()*+,./:;<=>?@[\\\\\\]^_`{|}~-]";
const ENTITY = '&(?:#x[a-f0-9]{1,6}|#[0-9]{1,7}|[a-z][a-z0-9]{1,31});';
const reEntityOrEscapedChar = new RegExp('\\\\' + ESCAPABLE + '|' + ENTITY, 'gi');
const reXmlSpecial = /[&<>"]/g;

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©',
  reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«',
  raquo: '»', middot: '·', bull: '•', deg: '°', plusmn: '±',
  times: '×', divide: '÷', euro: '€', pound: '£', yen: '¥',
  cent: '¢', sect: '§', para: '¶', frac12: '½', frac14: '¼',
  frac34: '¾', larr: '←', rarr: '→', uarr: '↑', darr: '↓',
  harr: '↔', hearts: '♥', auml: 'ä', ouml: 'ö', uuml: 'ü',
  Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß', eacute: 'é',
  egrave: 'è', aacute: 'á', agrave: 'à', ntilde: 'ñ', ccedil: 'ç',
  shy: '­', ensp: ' ', emsp: ' ', thinsp: ' ', zwj: '‍', zwnj: '‌',
  iexcl: '¡', iquest: '¿', micro: 'µ', alpha: 'α', beta: 'β',
  gamma: 'γ', delta: 'δ', pi: 'π', sigma: 'σ', omega: 'ω',
  Delta: 'Δ', Omega: 'Ω', infin: '∞', ne: '≠', le: '≤', ge: '≥',
  dagger: '†', Dagger: '‡', permil: '‰', prime: '′', Prime: '″',
};

// Decode a single entity reference; returns null when it is not a valid one.
export function decodeEntity(s) {
  let m;
  if ((m = /^&#x([0-9a-f]{1,6});$/i.exec(s)) || (m = /^&#([0-9]{1,7});$/.exec(s))) {
    let cp = parseInt(m[1], /x/i.test(s.charAt(2)) ? 16 : 10);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
    return String.fromCodePoint(cp);
  }
  const name = s.slice(1, -1);
  return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, name) ? NAMED_ENTITIES[name] : null;
}

export function unescapeString(s) {
  if (!/[\\&]/.test(s)) return s;
  return s.replace(reEntityOrEscapedChar, (m) => {
    if (m.charCodeAt(0) === 92) return m.charAt(1);
    const d = decodeEntity(m);
    return d === null ? m : d;
  });
}

export function escapeXml(s) {
  return s.replace(reXmlSpecial, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}

// Equivalent of mdurl.encode(uri) with default exclusions and keepEscaped.
const URL_SAFE = /[A-Za-z0-9;\/?:@&=+$,\-_.!~*'()#]/;
export function normalizeURI(uri) {
  let out = '';
  for (let i = 0; i < uri.length; i++) {
    const ch = uri[i];
    if (ch === '%' && /^[0-9a-f]{2}$/i.test(uri.slice(i + 1, i + 3))) { out += uri.slice(i, i + 3); i += 2; continue; }
    if (URL_SAFE.test(ch)) { out += ch; continue; }
    const code = uri.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdfff) {
      if (code <= 0xdbff && i + 1 < uri.length) {
        const next = uri.charCodeAt(i + 1);
        if (next >= 0xdc00 && next <= 0xdfff) { out += encodeURIComponent(ch + uri[i + 1]); i++; continue; }
      }
      out += '%EF%BF%BD';
      continue;
    }
    out += encodeURIComponent(ch);
  }
  return out;
}

// ---------------------------------------------------------------- inline parser
const C_NEWLINE = 10, C_ASTERISK = 42, C_UNDERSCORE = 95, C_BACKTICK = 96,
  C_OPEN_BRACKET = 91, C_CLOSE_BRACKET = 93, C_LESSTHAN = 60, C_BANG = 33,
  C_BACKSLASH = 92, C_AMPERSAND = 38, C_OPEN_PAREN = 40, C_CLOSE_PAREN = 41;

const rePunctuation = /^[!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~\p{P}\p{S}]/u;
const ESCAPED_CHAR = '\\\\' + ESCAPABLE;
const reLinkTitle = new RegExp(
  '^(?:"(' + ESCAPED_CHAR + '|\\\\[^\\\\]' + '|[^\\\\"\\x00])*"' +
  '|' + "'(" + ESCAPED_CHAR + '|\\\\[^\\\\]' + "|[^\\\\'\\x00])*'" +
  '|' + '\\((' + ESCAPED_CHAR + '|\\\\[^\\\\]' + '|[^\\\\()\\x00])*\\))');
const reLinkDestinationBraces = /^(?:<(?:[^<>\n\\\x00]|\\.)*>)/;
const reEscapable = new RegExp('^' + ESCAPABLE);
const reEntityHere = new RegExp('^' + ENTITY, 'i');
const reTicks = /`+/;
const reTicksHere = /^`+/;
const reEmailAutolink = /^<([a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/;
const reAutolink = /^<[A-Za-z][A-Za-z0-9.+-]{1,31}:[^<>\x00-\x20]*>/i;
const reSpnl = /^ *(?:\n *)?/;
const reWhitespaceChar = /^[ \t\n\x0b\x0c\x0d]/;
const reUnicodeWhitespaceChar = /^\s/;
const reFinalSpace = / *$/;
const reInitialSpace = /^ */;
const reMain = /^[^\n`\[\]\\!<&*_]+/m;

const text = (s) => new Node('text', s);

function previousChar(str, pos) {
  if (pos === 0) return '\n';
  const prev = str.charCodeAt(pos - 1);
  if ((prev & 0xfc00) !== 0xdc00) return str.charAt(pos - 1);
  const two = str.charCodeAt(pos - 2);
  if ((two & 0xfc00) !== 0xd800) return str.charAt(pos - 1);
  return str.slice(pos - 2, pos);
}

class InlineParser {
  match(re) {
    const m = re.exec(this.subject.slice(this.pos));
    if (m === null) return null;
    this.pos += m.index + m[0].length;
    return m[0];
  }
  peek() { return this.pos < this.subject.length ? this.subject.codePointAt(this.pos) : -1; }
  spnl() { this.match(reSpnl); return true; }

  parseBackticks(block) {
    const ticks = this.match(reTicksHere);
    if (ticks === null) return false;
    const afterOpenTicks = this.pos;
    let matched;
    while ((matched = this.match(reTicks)) !== null) {
      if (matched === ticks) {
        const node = new Node('code');
        const contents = this.subject.slice(afterOpenTicks, this.pos - ticks.length).replace(/\n/gm, ' ');
        if (contents.length > 0 && /[^ ]/.test(contents) && contents[0] === ' ' && contents[contents.length - 1] === ' ') {
          node.literal = contents.slice(1, -1);
        } else node.literal = contents;
        block.appendChild(node);
        return true;
      }
    }
    this.pos = afterOpenTicks;
    block.appendChild(text(ticks));
    return true;
  }

  parseBackslash(block) {
    const subj = this.subject;
    this.pos += 1;
    if (this.peek() === C_NEWLINE) {
      this.pos += 1;
      block.appendChild(new Node('linebreak'));
    } else if (reEscapable.test(subj.charAt(this.pos))) {
      block.appendChild(text(subj.charAt(this.pos)));
      this.pos += 1;
    } else block.appendChild(text('\\'));
    return true;
  }

  parseAutolink(block) {
    let m, dest, node;
    if ((m = this.match(reEmailAutolink))) {
      dest = m.slice(1, -1);
      node = new Node('link');
      node.destination = normalizeURI('mailto:' + dest);
      node.appendChild(text(dest));
      block.appendChild(node);
      return true;
    } else if ((m = this.match(reAutolink))) {
      dest = m.slice(1, -1);
      node = new Node('link');
      node.destination = normalizeURI(dest);
      node.appendChild(text(dest));
      block.appendChild(node);
      return true;
    }
    return false;
  }

  scanDelims(cc) {
    let numdelims = 0;
    const startpos = this.pos;
    while (this.peek() === cc) { numdelims++; this.pos++; }
    if (numdelims === 0) return null;
    const charBefore = previousChar(this.subject, startpos);
    const ccAfter = this.peek();
    const charAfter = ccAfter === -1 ? '\n' : String.fromCodePoint(ccAfter);
    const afterWs = reUnicodeWhitespaceChar.test(charAfter);
    const afterPunct = rePunctuation.test(charAfter);
    const beforeWs = reUnicodeWhitespaceChar.test(charBefore);
    const beforePunct = rePunctuation.test(charBefore);
    const left = !afterWs && (!afterPunct || beforeWs || beforePunct);
    const right = !beforeWs && (!beforePunct || afterWs || afterPunct);
    let canOpen, canClose;
    if (cc === C_UNDERSCORE) {
      canOpen = left && (!right || beforePunct);
      canClose = right && (!left || afterPunct);
    } else {
      canOpen = left;
      canClose = right;
    }
    this.pos = startpos;
    return { numdelims, canOpen, canClose };
  }

  handleDelim(cc, block) {
    const res = this.scanDelims(cc);
    if (!res) return false;
    const startpos = this.pos;
    this.pos += res.numdelims;
    const node = text(this.subject.slice(startpos, this.pos));
    block.appendChild(node);
    if (res.canOpen || res.canClose) {
      this.delimiters = {
        cc, numdelims: res.numdelims, origdelims: res.numdelims, node,
        previous: this.delimiters, next: null, canOpen: res.canOpen, canClose: res.canClose,
      };
      if (this.delimiters.previous !== null) this.delimiters.previous.next = this.delimiters;
    }
    return true;
  }

  removeDelimiter(delim) {
    if (delim.previous !== null) delim.previous.next = delim.next;
    if (delim.next === null) this.delimiters = delim.previous;
    else delim.next.previous = delim.previous;
  }

  processEmphasis(stackBottom) {
    let opener, closer, oldCloser, openerFound, idx;
    const openersBottom = new Array(14).fill(stackBottom);
    closer = this.delimiters;
    while (closer !== null && closer.previous !== stackBottom) closer = closer.previous;
    while (closer !== null) {
      if (!closer.canClose) { closer = closer.next; continue; }
      opener = closer.previous;
      openerFound = false;
      idx = (closer.cc === C_UNDERSCORE ? 2 : 8) + (closer.canOpen ? 3 : 0) + (closer.origdelims % 3);
      while (opener !== null && opener !== stackBottom && opener !== openersBottom[idx]) {
        const oddMatch = (closer.canOpen || opener.canClose) && closer.origdelims % 3 !== 0 &&
          (opener.origdelims + closer.origdelims) % 3 === 0;
        if (opener.cc === closer.cc && opener.canOpen && !oddMatch) { openerFound = true; break; }
        opener = opener.previous;
      }
      oldCloser = closer;
      if (!openerFound) {
        closer = closer.next;
      } else {
        const useDelims = closer.numdelims >= 2 && opener.numdelims >= 2 ? 2 : 1;
        const openerInl = opener.node, closerInl = closer.node;
        opener.numdelims -= useDelims;
        closer.numdelims -= useDelims;
        openerInl.literal = openerInl.literal.slice(0, openerInl.literal.length - useDelims);
        closerInl.literal = closerInl.literal.slice(0, closerInl.literal.length - useDelims);
        const emph = new Node(useDelims === 1 ? 'emph' : 'strong');
        let tmp = openerInl.next;
        while (tmp && tmp !== closerInl) { const nx = tmp.next; tmp.unlink(); emph.appendChild(tmp); tmp = nx; }
        openerInl.insertAfter(emph);
        if (opener.next !== closer) { opener.next = closer; closer.previous = opener; }
        if (opener.numdelims === 0) { openerInl.unlink(); this.removeDelimiter(opener); }
        if (closer.numdelims === 0) {
          closerInl.unlink();
          const tempstack = closer.next;
          this.removeDelimiter(closer);
          closer = tempstack;
        }
      }
      if (!openerFound) {
        openersBottom[idx] = oldCloser.previous;
        if (!oldCloser.canOpen) this.removeDelimiter(oldCloser);
      }
    }
    while (this.delimiters !== null && this.delimiters !== stackBottom) this.removeDelimiter(this.delimiters);
  }

  parseLinkTitle() {
    const title = this.match(reLinkTitle);
    return title === null ? null : unescapeString(title.slice(1, -1));
  }

  parseLinkDestination() {
    let res = this.match(reLinkDestinationBraces);
    if (res !== null) return normalizeURI(unescapeString(res.slice(1, -1)));
    if (this.peek() === C_LESSTHAN) return null;
    const savepos = this.pos;
    let openparens = 0, c;
    while ((c = this.peek()) !== -1) {
      if (c === C_BACKSLASH && reEscapable.test(this.subject.charAt(this.pos + 1))) {
        this.pos += 1;
        if (this.peek() !== -1) this.pos += 1;
      } else if (c === C_OPEN_PAREN) { this.pos += 1; openparens += 1; }
      else if (c === C_CLOSE_PAREN) {
        if (openparens < 1) break;
        this.pos += 1; openparens -= 1;
      } else if (reWhitespaceChar.test(String.fromCodePoint(c)) || c < 0x20 || c === 0x7f) break;
      else this.pos += c > 0xffff ? 2 : 1;
    }
    if (this.pos === savepos && c !== C_CLOSE_PAREN) return null;
    if (openparens !== 0) return null;
    res = this.subject.slice(savepos, this.pos);
    return normalizeURI(unescapeString(res));
  }

  addBracket(node, index, image) {
    if (this.brackets !== null) this.brackets.bracketAfter = true;
    this.brackets = { node, previous: this.brackets, previousDelimiter: this.delimiters, index, image, active: true };
  }
  removeBracket() { this.brackets = this.brackets.previous; }

  parseOpenBracket(block) {
    const startpos = this.pos;
    this.pos += 1;
    const node = text('[');
    block.appendChild(node);
    this.addBracket(node, startpos, false);
    return true;
  }

  parseBang(block) {
    const startpos = this.pos;
    this.pos += 1;
    if (this.peek() === C_OPEN_BRACKET) {
      this.pos += 1;
      const node = text('![');
      block.appendChild(node);
      this.addBracket(node, startpos + 1, true);
    } else block.appendChild(text('!'));
    return true;
  }

  parseCloseBracket(block) {
    let dest, title, matched = false;
    this.pos += 1;
    const startpos = this.pos;
    let opener = this.brackets;
    if (opener === null) { block.appendChild(text(']')); return true; }
    if (!opener.active) { block.appendChild(text(']')); this.removeBracket(); return true; }
    const isImage = opener.image;
    const savepos = this.pos;
    if (this.peek() === C_OPEN_PAREN) {
      this.pos++;
      if (this.spnl() && (dest = this.parseLinkDestination()) !== null && this.spnl() &&
        ((reWhitespaceChar.test(this.subject.charAt(this.pos - 1)) && (title = this.parseLinkTitle())) || true) &&
        this.spnl() && this.peek() === C_CLOSE_PAREN) {
        this.pos += 1;
        matched = true;
      } else this.pos = savepos;
    }
    if (matched) {
      const node = new Node(isImage ? 'image' : 'link');
      node.destination = dest;
      node.title = title || '';
      let tmp = opener.node.next;
      while (tmp) { const nx = tmp.next; tmp.unlink(); node.appendChild(tmp); tmp = nx; }
      block.appendChild(node);
      this.processEmphasis(opener.previousDelimiter);
      this.removeBracket();
      opener.node.unlink();
      if (!isImage) {
        opener = this.brackets;
        while (opener !== null) { if (!opener.image) opener.active = false; opener = opener.previous; }
      }
      return true;
    }
    this.removeBracket();
    this.pos = startpos;
    block.appendChild(text(']'));
    return true;
  }

  parseEntity(block) {
    const m = this.match(reEntityHere);
    if (!m) return false;
    const d = decodeEntity(m);
    if (d === null) { this.pos -= m.length; return false; }
    block.appendChild(text(d));
    return true;
  }

  parseString(block) {
    const m = this.match(reMain);
    if (!m) return false;
    block.appendChild(text(m));
    return true;
  }

  parseNewline(block) {
    this.pos += 1;
    const lastc = block.lastChild;
    if (lastc && lastc.type === 'text' && lastc.literal[lastc.literal.length - 1] === ' ') {
      const hardbreak = lastc.literal[lastc.literal.length - 2] === ' ';
      lastc.literal = lastc.literal.replace(reFinalSpace, '');
      block.appendChild(new Node(hardbreak ? 'linebreak' : 'softbreak'));
    } else block.appendChild(new Node('softbreak'));
    this.match(reInitialSpace);
    return true;
  }

  parseInline(block) {
    const c = this.peek();
    if (c === -1) return false;
    let res = false;
    switch (c) {
      case C_NEWLINE: res = this.parseNewline(block); break;
      case C_BACKSLASH: res = this.parseBackslash(block); break;
      case C_BACKTICK: res = this.parseBackticks(block); break;
      case C_ASTERISK: case C_UNDERSCORE: res = this.handleDelim(c, block); break;
      case C_OPEN_BRACKET: res = this.parseOpenBracket(block); break;
      case C_BANG: res = this.parseBang(block); break;
      case C_CLOSE_BRACKET: res = this.parseCloseBracket(block); break;
      case C_LESSTHAN: res = this.parseAutolink(block); break;
      case C_AMPERSAND: res = this.parseEntity(block); break;
      default: res = this.parseString(block); break;
    }
    if (!res) {
      const ch = String.fromCodePoint(c);
      this.pos += ch.length;
      block.appendChild(text(ch));
    }
    return true;
  }

  parse(content, block) {
    this.subject = content.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '');
    this.pos = 0;
    this.delimiters = null;
    this.brackets = null;
    while (this.parseInline(block)) { /* continue */ }
    this.processEmphasis(null);
    return block;
  }
}

/** Parse inline markdown `content` into a container node of type `type`. */
export function parseInlines(content, type = 'paragraph') {
  return new InlineParser().parse(content, new Node(type));
}
