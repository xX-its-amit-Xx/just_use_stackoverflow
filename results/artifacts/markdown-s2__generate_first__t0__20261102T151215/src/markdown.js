import { parseInlines, renderInlines, plainText, parseReferences, unescapeString, escapeHtml } from './inline.js';

export function slugify(text, seen) {
  const base = String(text).toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
  if (!(seen instanceof Map)) return base;
  if (!seen.has(base)) { seen.set(base, 0); return base; }
  let n = seen.get(base) + 1;
  while (seen.has(base + '-' + n)) n++;
  seen.set(base, n);
  seen.set(base + '-' + n, 0);
  return base + '-' + n;
}

class B {
  constructor(type) {
    this.type = type; this.parent = null; this.children = []; this.open = true;
    this.lines = []; this.lastLineBlank = false;
  }
}

const reThematic = /^(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})[ \t]*$/;
const reAtx = /^#{1,6}(?:[ \t]+|$)/;
const reFence = /^`{3,}(?!.*`)|^~{3,}/;
const reClosingFence = /^(?:`{3,}|~{3,})(?=[ \t]*$)/;
const reSetext = /^(?:=+|-+)[ \t]*$/;
const reSpecial = /^[#`~*+_=<>0-9|:-]/;
const isSp = c => c === ' ' || c === '\t';

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; }
    else if (s[i] === '\\' && i + 1 < s.length) { cur += s[i] + s[i + 1]; i++; }
    else if (s[i] === '|') { cells.push(cur.trim()); cur = ''; }
    else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}
function parseDelimRow(line) {
  if (!line.includes('|') && !/^\s*:?-+:?\s*$/.test(line)) return null;
  if (!line.includes('|')) return null;
  if (!/^[\s|:-]+$/.test(line)) return null;
  const cells = splitRow(line);
  const align = [];
  for (const c of cells) {
    if (!/^:?-+:?$/.test(c)) return null;
    align.push(c[0] === ':' ? (c.endsWith(':') ? 'center' : 'left') : c.endsWith(':') ? 'right' : null);
  }
  return align;
}

class Parser {
  constructor() {
    this.doc = new B('document'); this.tip = this.doc; this.oldtip = this.doc;
    this.refmap = new Map(); this.lineNo = 0;
  }
  canContain(p, t) {
    switch (p) {
      case 'document': case 'block_quote': return t !== 'item';
      case 'item': return t !== 'item';
      case 'list': return t === 'item';
      default: return false;
    }
  }
  addChild(type) {
    while (!this.canContain(this.tip.type, type)) this.finalize(this.tip);
    const n = new B(type);
    n.parent = this.tip; this.tip.children.push(n); this.tip = n;
    return n;
  }
  finalize(b) {
    const above = b.parent;
    b.open = false;
    switch (b.type) {
      case 'paragraph': {
        let content = b.lines.join('\n');
        const used = parseReferences(content, this.refmap);
        if (used) content = content.slice(used);
        if (!content.trim()) { above.children.splice(above.children.indexOf(b), 1); }
        else b.content = content;
        break;
      }
      case 'code_block':
        if (b.fenced) {
          b.info = unescapeString((b.lines[0] || '').trim());
          b.literal = b.lines.length > 1 ? b.lines.slice(1).join('\n') + '\n' : '';
        } else {
          const l = b.lines.slice();
          while (l.length && !l[l.length - 1].trim()) l.pop();
          b.literal = l.join('\n') + '\n';
        }
        break;
      case 'list': {
        b.tight = true;
        const endsBlank = x => {
          while (x) {
            if (x.lastLineBlank) return true;
            if (x.type === 'list' || x.type === 'item') x = x.children[x.children.length - 1]; else break;
          }
          return false;
        };
        for (let i = 0; i < b.children.length; i++) {
          const item = b.children[i], hasNext = i < b.children.length - 1;
          if (endsBlank(item) && hasNext) { b.tight = false; break; }
          for (let j = 0; j < item.children.length; j++) {
            if (endsBlank(item.children[j]) && (hasNext || j < item.children.length - 1)) { b.tight = false; break; }
          }
          if (!b.tight) break;
        }
        break;
      }
    }
    this.tip = above;
  }
  closeUnmatched() {
    if (!this.allClosed) {
      while (this.oldtip !== this.lastMatched) { const p = this.oldtip.parent; this.finalize(this.oldtip); this.oldtip = p; }
      this.allClosed = true;
    }
  }
  findNext() {
    const l = this.line;
    let i = this.offset, cols = this.column, c;
    while ((c = l[i]) !== undefined) {
      if (c === ' ') { i++; cols++; } else if (c === '\t') { i++; cols += 4 - (cols % 4); } else break;
    }
    this.blank = c === undefined;
    this.nextNon = i; this.nextNonCol = cols; this.indent = cols - this.column; this.indented = this.indent >= 4;
  }
  advanceNext() { this.offset = this.nextNon; this.column = this.nextNonCol; this.partial = false; }
  advance(count, columns) {
    let c;
    while (count > 0 && (c = this.line[this.offset]) !== undefined) {
      if (c === '\t') {
        const toTab = 4 - (this.column % 4);
        if (columns) {
          this.partial = toTab > count;
          const adv = Math.min(count, toTab);
          this.column += adv; this.offset += this.partial ? 0 : 1; count -= adv;
        } else { this.partial = false; this.column += toTab; this.offset++; count--; }
      } else { this.partial = false; this.offset++; this.column++; count--; }
    }
  }
  addLine() {
    let rest;
    if (this.partial) { const n = 4 - (this.column % 4); rest = ' '.repeat(n) + this.line.slice(this.offset + 1); }
    else rest = this.line.slice(this.offset);
    this.tip.lines.push(rest);
  }
  cont(b) {
    switch (b.type) {
      case 'block_quote':
        if (!this.indented && this.line[this.nextNon] === '>') {
          this.advanceNext(); this.advance(1, false);
          if (isSp(this.line[this.offset])) this.advance(1, true);
          return 0;
        }
        return 1;
      case 'item':
        if (this.blank) { if (b.children.length === 0) return 1; this.advanceNext(); return 0; }
        if (this.indent >= b.markerOffset + b.padding) { this.advance(b.markerOffset + b.padding, true); return 0; }
        return 1;
      case 'list': return 0;
      case 'heading': case 'thematic_break': return 1;
      case 'code_block':
        if (b.fenced) {
          const m = this.indent <= 3 && this.line[this.nextNon] === b.fenceChar && reClosingFence.exec(this.line.slice(this.nextNon));
          if (m && m[0].length >= b.fenceLen) { this.finalize(b); return 2; }
          let i = b.fenceOffset;
          while (i > 0 && isSp(this.line[this.offset])) { this.advance(1, true); i--; }
          return 0;
        }
        if (this.indent >= 4) { this.advance(4, true); return 0; }
        if (this.blank) { this.advanceNext(); return 0; }
        return 1;
      case 'paragraph': return this.blank ? 1 : 0;
      case 'table': return this.blank ? 1 : 0;
    }
    return 0;
  }
  tryStarts(container) {
    const l = this.line, rest = l.slice(this.nextNon);
    const ch = l[this.nextNon];
    // blockquote
    if (!this.indented && ch === '>') {
      this.advanceNext(); this.advance(1, false);
      if (isSp(l[this.offset])) this.advance(1, true);
      this.closeUnmatched(); this.addChild('block_quote');
      return 1;
    }
    if (!this.indented && ch === '#' && reAtx.test(rest)) {
      const m = reAtx.exec(rest);
      this.advanceNext(); this.advance(m[0].length, false);
      this.closeUnmatched();
      const h = this.addChild('heading');
      h.level = m[0].trim().length;
      h.content = l.slice(this.offset).replace(/^[ \t]*#+[ \t]*$/, '').replace(/[ \t]+#+[ \t]*$/, '');
      this.advance(l.length - this.offset, false);
      return 2;
    }
    if (!this.indented && (ch === '`' || ch === '~')) {
      const m = reFence.exec(rest);
      if (m) {
        this.closeUnmatched();
        const b = this.addChild('code_block');
        b.fenced = true; b.fenceLen = m[0].length; b.fenceChar = m[0][0]; b.fenceOffset = this.indent;
        this.advanceNext(); this.advance(m[0].length, false);
        return 2;
      }
    }
    if (!this.indented && container.type === 'paragraph' && reSetext.test(rest)) {
      this.closeUnmatched();
      let content = container.lines.join('\n');
      const used = parseReferences(content, this.refmap);
      if (used) content = content.slice(used);
      if (content.trim()) {
        const h = new B('heading');
        h.level = rest[0] === '=' ? 1 : 2; h.content = content; h.open = false; h.parent = container.parent;
        const arr = container.parent.children;
        arr[arr.indexOf(container)] = h;
        this.tip = h;
        this.advance(l.length - this.offset, false);
        return 2;
      }
    }
    if (!this.indented && container.type === 'paragraph' && (ch === '|' || ch === ':' || ch === '-' || ch === ' ' || ch === '\t' || true) && rest.includes('|')) {
      const align = parseDelimRow(rest);
      if (align) {
        const plines = container.lines;
        const hdr = splitRow(plines[plines.length - 1]);
        if (hdr.length === align.length && plines[plines.length - 1].includes('|') || (hdr.length === align.length && align.length === 1)) {
          this.closeUnmatched();
          const parent = container.parent;
          const t = new B('table');
          t.align = align; t.header = hdr; t.rows = []; t.fresh = true; t.parent = parent;
          if (plines.length > 1) { container.lines = plines.slice(0, -1); this.finalize(container); }
          else parent.children.splice(parent.children.indexOf(container), 1);
          parent.children.push(t);
          this.tip = t;
          this.advance(l.length - this.offset, false);
          return 2;
        }
      }
    }
    if (!this.indented && reThematic.test(rest)) {
      this.closeUnmatched(); this.addChild('thematic_break');
      this.advance(l.length - this.offset, false);
      return 2;
    }
    if (!this.indented || container.type === 'list') {
      const d = this.listMarker(container);
      if (d) {
        this.closeUnmatched();
        if (this.tip.type !== 'list' || !(this.tip.ordered === d.ordered && this.tip.delim === d.delim)) {
          const list = this.addChild('list');
          list.ordered = d.ordered; list.delim = d.delim; list.start = d.start;
        }
        const item = this.addChild('item');
        item.markerOffset = d.markerOffset; item.padding = d.padding; item.startLine = this.lineNo;
        return 1;
      }
    }
    if (this.indented && this.tip.type !== 'paragraph' && !this.blank) {
      this.advance(4, true);
      this.closeUnmatched();
      this.addChild('code_block').fenced = false;
      return 2;
    }
    return 0;
  }
  listMarker(container) {
    if (this.indent >= 4) return null;
    const rest = this.line.slice(this.nextNon);
    let m, d = { markerOffset: this.indent };
    if ((m = /^[*+-]/.exec(rest))) { d.ordered = false; d.delim = m[0]; }
    else if ((m = /^(\d{1,9})([.)])/.exec(rest))) {
      if (container.type === 'paragraph' && m[1] !== '1') return null;
      d.ordered = true; d.start = parseInt(m[1], 10); d.delim = m[2];
    } else return null;
    const after = rest[m[0].length];
    if (after !== undefined && !isSp(after)) return null;
    if (container.type === 'paragraph' && !/[^ \t]/.test(rest.slice(m[0].length))) return null;
    this.advanceNext();
    this.advance(m[0].length, true);
    const spStartCol = this.column, spStartOff = this.offset;
    do { this.advance(1, true); } while (this.column - spStartCol < 5 && isSp(this.line[this.offset]));
    const blankItem = this.line[this.offset] === undefined;
    const spaces = this.column - spStartCol;
    if (spaces >= 5 || spaces < 1 || blankItem) {
      d.padding = m[0].length + 1;
      this.column = spStartCol; this.offset = spStartOff;
      if (isSp(this.line[this.offset])) this.advance(1, true);
    } else d.padding = m[0].length + spaces;
    return d;
  }
  processLine(line) {
    this.lineNo++;
    this.line = line; this.offset = 0; this.column = 0; this.blank = false; this.partial = false;
    this.oldtip = this.tip;
    let container = this.doc;
    for (;;) {
      const last = container.children[container.children.length - 1];
      if (!last || !last.open) break;
      container = last;
      this.findNext();
      const r = this.cont(container);
      if (r === 1) { container = container.parent; break; }
      if (r === 2) return;
    }
    this.allClosed = container === this.oldtip;
    this.lastMatched = container;
    let matchedLeaf = container.type === 'code_block';
    while (!matchedLeaf) {
      this.findNext();
      if (!this.indented && !reSpecial.test(this.line.slice(this.nextNon))) { this.advanceNext(); break; }
      const r = this.tryStarts(container);
      if (r === 1) container = this.tip;
      else if (r === 2) { container = this.tip; matchedLeaf = true; }
      else { this.advanceNext(); break; }
    }
    if (!this.allClosed && !this.blank && this.tip.type === 'paragraph') {
      this.addLine();
    } else {
      this.closeUnmatched();
      if (this.blank && container.children.length) container.children[container.children.length - 1].lastLineBlank = true;
      const t = container.type;
      const lb = this.blank && !(t === 'block_quote' || (t === 'code_block' && container.fenced) || (t === 'item' && container.children.length === 0 && container.startLine === this.lineNo));
      for (let c = container; c; c = c.parent) c.lastLineBlank = lb;
      if (t === 'code_block' || t === 'paragraph') this.addLine();
      else if (t === 'table') { if (container.fresh) container.fresh = false; else container.rows.push(splitRow(this.line.slice(this.offset))); }
      else if (this.offset < line.length && !this.blank) {
        this.addChild('paragraph');
        this.advanceNext();
        this.addLine();
      }
    }
  }
  parse(src) {
    const lines = src.replace(/\r\n?/g, '\n').replace(/\0/g, '�').split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    for (const l of lines) this.processLine(l);
    while (this.tip !== this.doc) this.finalize(this.tip);
    this.finalize(this.doc);
    return this.doc;
  }
}

function parseDoc(md) {
  const p = new Parser();
  const doc = p.parse(String(md));
  return { doc, refmap: p.refmap };
}

export function render(markdown, { headingIds = false } = {}) {
  const { doc, refmap } = parseDoc(markdown);
  const seen = new Map();
  let out = '';
  const cr = () => { if (out && !out.endsWith('\n')) out += '\n'; };
  const walk = (b, tight) => {
    switch (b.type) {
      case 'document': for (const c of b.children) walk(c, false); break;
      case 'paragraph': {
        const html = renderInlines(parseInlines(b.content, refmap));
        if (tight) out += html; else { cr(); out += '<p>' + html + '</p>\n'; }
        break;
      }
      case 'heading': {
        const root = parseInlines(b.content, refmap);
        cr();
        const id = headingIds ? ` id="${escapeHtml(slugify(plainText(root), seen))}"` : '';
        out += `<h${b.level}${id}>` + renderInlines(root) + `</h${b.level}>\n`;
        break;
      }
      case 'thematic_break': cr(); out += '<hr />\n'; break;
      case 'code_block': {
        cr();
        let cls = '';
        if (b.fenced) { const w = b.info.split(/\s+/)[0]; if (w) cls = ` class="language-${escapeHtml(w)}"`; }
        out += `<pre><code${cls}>` + escapeHtml(b.literal) + '</code></pre>\n';
        break;
      }
      case 'block_quote':
        cr(); out += '<blockquote>\n';
        for (const c of b.children) walk(c, false);
        cr(); out += '</blockquote>\n';
        break;
      case 'list': {
        cr();
        const tag = b.ordered ? 'ol' : 'ul';
        out += '<' + tag + (b.ordered && b.start !== 1 ? ` start="${b.start}"` : '') + '>\n';
        for (const it of b.children) {
          out += '<li>';
          for (const c of it.children) walk(c, b.tight);
          out += '</li>\n';
        }
        cr(); out += `</${tag}>\n`;
        break;
      }
      case 'table': {
        cr();
        const cell = (tag, txt, i) => {
          const a = b.align[i];
          return `<${tag}${a ? ` align="${a}"` : ''}>` + renderInlines(parseInlines(txt || '', refmap)) + `</${tag}>`;
        };
        out += '<table>\n<thead>\n<tr>\n' + b.header.map((t, i) => cell('th', t, i)).join('\n') + '\n</tr>\n</thead>\n';
        if (b.rows.length) {
          out += '<tbody>\n';
          for (const r of b.rows) {
            const cells = [];
            for (let i = 0; i < b.header.length; i++) cells.push(cell('td', r[i], i));
            out += '<tr>\n' + cells.join('\n') + '\n</tr>\n';
          }
          out += '</tbody>\n';
        }
        out += '</table>\n';
        break;
      }
    }
  };
  walk(doc, false);
  return out;
}

export function toc(markdown) {
  const { doc, refmap } = parseDoc(markdown);
  const seen = new Map();
  const res = [];
  const walk = b => {
    if (b.type === 'heading') {
      const text = plainText(parseInlines(b.content, refmap));
      res.push({ level: b.level, text, slug: slugify(text, seen) });
    }
    for (const c of b.children) walk(c);
  };
  walk(doc);
  return res;
}
