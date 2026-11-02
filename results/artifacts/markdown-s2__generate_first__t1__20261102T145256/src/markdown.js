import { inline, esc, unescapeStr, parseRefDef, normLabel } from './inline.js';

export function slugify(text, seen) {
  const base = String(text).toLowerCase().replace(/[^\p{L}\p{N} \-_]/gu, '').replace(/ /g, '-');
  if (!(seen instanceof Map)) return base;
  if (!seen.has(base)) { seen.set(base, 0); return base; }
  let cand;
  do { const k = seen.get(base) + 1; seen.set(base, k); cand = `${base}-${k}`; } while (seen.has(cand));
  seen.set(cand, 0);
  return cand;
}

const CONTAINERS = new Set(['document', 'block_quote', 'item']);
function canContain(parent, child) {
  if (parent === 'document' || parent === 'block_quote' || parent === 'item') return child !== 'item';
  if (parent === 'list') return child === 'item';
  return false;
}
const ACCEPTS_LINES = new Set(['paragraph', 'code_block']);
const isSpaceOrTab = c => c === ' ' || c === '\t';

function newNode(type, line) {
  return { type, parent: null, children: [], open: true, str: '', startLine: line, lastLineBlank: false };
}
const endsWithBlank = (b) => {
  while (b) {
    if (b.lastLineBlank) return true;
    if (b.type === 'list' || b.type === 'item') b = b.children[b.children.length - 1]; else break;
  }
  return false;
};

const splitCells = (line) => {
  let t = line.trim();
  if (t[0] === '|') t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '\\' && t[i + 1] === '|') { cur += '|'; i++; }
    else if (c === '\\' && i + 1 < t.length) { cur += c + t[i + 1]; i++; }
    else if (c === '|') { cells.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  cells.push(cur.trim());
  return cells;
};
const DELIM_ROW = /^\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

function parse(src) {
  const doc = newNode('document', 0);
  const refs = new Map();
  let tip = doc, oldtip = doc, lastMatched = doc;
  let line = '', offset = 0, column = 0, nextNonspace = 0, nextNonspaceColumn = 0, indent = 0, indented = false, blank = false, partial = false;
  let allClosed = true, lineNumber = 0, tableJustMade = false;

  const addChild = (type) => {
    closeUnmatched();
    while (!canContain(tip.type, type)) finalize(tip);
    const n = newNode(type, lineNumber);
    n.parent = tip; tip.children.push(n); tip = n;
    return n;
  };
  const closeUnmatched = () => {
    if (!allClosed) {
      while (oldtip !== lastMatched) { const p = oldtip.parent; finalize(oldtip); oldtip = p; }
      allClosed = true;
    }
  };
  const findNext = () => {
    let i = offset, cols = column, c;
    while ((c = line[i]) !== undefined) {
      if (c === ' ') { i++; cols++; } else if (c === '\t') { i++; cols += 4 - (cols % 4); } else break;
    }
    blank = c === undefined;
    nextNonspace = i; nextNonspaceColumn = cols; indent = cols - column; indented = indent >= 4;
  };
  const advanceOffset = (count, columns) => {
    let c;
    while (count > 0 && (c = line[offset]) !== undefined) {
      if (c === '\t') {
        const toTab = 4 - (column % 4);
        if (columns) {
          partial = toTab > count;
          const adv = Math.min(count, toTab);
          column += adv; offset += partial ? 0 : 1; count -= adv;
        } else { partial = false; column += toTab; offset++; count--; }
      } else { partial = false; offset++; column++; count--; }
    }
  };
  const advanceNext = () => { offset = nextNonspace; column = nextNonspaceColumn; partial = false; };
  const addLine = () => {
    if (partial) { offset++; const t = 4 - (column % 4); tip.str += ' '.repeat(t); }
    tip.str += line.slice(offset) + '\n';
  };

  function finalize(b) {
    b.open = false;
    tip = b.parent || doc;
    if (b.type === 'paragraph') {
      const rest = parseRefs(b.str);
      b.str = rest;
      if (!/\S/.test(rest)) { const p = b.parent; p.children.splice(p.children.indexOf(b), 1); }
    } else if (b.type === 'code_block') {
      if (b.fenced) {
        const nl = b.str.indexOf('\n');
        b.info = unescapeStr(b.str.slice(0, nl).trim());
        b.str = b.str.slice(nl + 1);
      } else b.str = b.str.replace(/(\n[ \t]*)+$/, '\n');
    } else if (b.type === 'list') {
      b.tight = true;
      const items = b.children;
      outer: for (let i = 0; i < items.length; i++) {
        const it = items[i];
        if (endsWithBlank(it) && i < items.length - 1) { b.tight = false; break; }
        for (let k = 0; k < it.children.length; k++) {
          if (endsWithBlank(it.children[k]) && (i < items.length - 1 || k < it.children.length - 1)) { b.tight = false; break outer; }
        }
      }
    }
  }
  function parseRefs(str) {
    let pos = 0;
    while (str[pos] === '[') {
      const r = parseRefDef(str, pos);
      if (!r) break;
      pos = r.end;
      if (!refs.has(r.label)) refs.set(r.label, { dest: r.dest, title: r.title });
    }
    return str.slice(pos);
  }

  function parseMarker(container) {
    if (indent >= 4) return null;
    const rest = line.slice(nextNonspace);
    let m, data;
    if ((m = /^[*+-]/.exec(rest))) data = { ordered: false, bullet: m[0] };
    else if ((m = /^(\d{1,9})([.)])/.exec(rest)) && (container.type !== 'paragraph' || m[1] === '1')) data = { ordered: true, start: parseInt(m[1], 10), delim: m[2] };
    else return null;
    const nc = line[nextNonspace + m[0].length];
    if (!(nc === undefined || nc === ' ' || nc === '\t')) return null;
    if (container.type === 'paragraph' && !/[^ \t\f\v\r\n]/.test(line.slice(nextNonspace + m[0].length))) return null;
    data.markerOffset = indent;
    advanceNext();
    advanceOffset(m[0].length, true);
    const sc = column, so = offset;
    let ch;
    do { advanceOffset(1, true); ch = line[offset]; } while (column - sc < 5 && isSpaceOrTab(ch));
    const blankItem = line[offset] === undefined;
    const spaces = column - sc;
    if (spaces >= 5 || spaces < 1 || blankItem) {
      data.padding = m[0].length + 1;
      column = sc; offset = so;
      if (isSpaceOrTab(line[offset])) advanceOffset(1, true);
    } else data.padding = m[0].length + spaces;
    return data;
  }

  const starts = [
    // block quote
    (container) => {
      if (!indented && line[nextNonspace] === '>') {
        advanceNext(); advanceOffset(1, false);
        if (isSpaceOrTab(line[offset])) advanceOffset(1, true);
        addChild('block_quote');
        return 1;
      }
      return 0;
    },
    // ATX heading
    (container) => {
      let m;
      if (!indented && (m = /^#{1,6}(?:[ \t]+|$)/.exec(line.slice(nextNonspace)))) {
        advanceNext(); advanceOffset(m[0].length, false);
        const h = addChild('heading');
        h.level = m[0].trim().length;
        h.str = line.slice(offset).replace(/^[ \t]*#+[ \t]*$/, '').replace(/[ \t]+#+[ \t]*$/, '').trim();
        advanceOffset(line.length - offset, false);
        return 2;
      }
      return 0;
    },
    // fenced code
    (container) => {
      let m;
      if (!indented && (m = /^`{3,}(?!.*`)|^~{3,}/.exec(line.slice(nextNonspace)))) {
        const fl = m[0].length;
        const b = addChild('code_block');
        b.fenced = true; b.fenceChar = m[0][0]; b.fenceLen = fl; b.fenceOffset = indent;
        advanceNext(); advanceOffset(fl, false);
        return 2;
      }
      return 0;
    },
    // table
    (container) => {
      if (container.type !== 'paragraph' || indented) return 0;
      const rest = line.slice(nextNonspace);
      if (!rest.includes('|') || !DELIM_ROW.test(rest)) return 0;
      const lines = container.str.replace(/\n$/, '').split('\n');
      const head = lines[lines.length - 1];
      const hc = splitCells(head), dc = splitCells(rest);
      if (hc.length !== dc.length || !head.includes('|') && hc.length < 2) return 0;
      const aligns = dc.map(c => (c[0] === ':' ? (c.endsWith(':') ? 'center' : 'left') : c.endsWith(':') ? 'right' : null));
      closeUnmatched();
      const parent = container.parent;
      if (lines.length > 1) { container.str = lines.slice(0, -1).join('\n') + '\n'; finalize(container); }
      else { parent.children.splice(parent.children.indexOf(container), 1); tip = parent; container.open = false; }
      const t = addChild('table');
      t.head = hc; t.aligns = aligns; t.rows = [];
      advanceOffset(line.length - offset, false);
      tableJustMade = true;
      return 2;
    },
    // setext heading
    (container) => {
      let m;
      if (!indented && container.type === 'paragraph' && (m = /^(?:=+|-+)[ \t]*$/.exec(line.slice(nextNonspace)))) {
        closeUnmatched();
        const rest = parseRefs(container.str);
        if (/\S/.test(rest)) {
          const h = newNode('heading', lineNumber);
          h.level = m[0][0] === '=' ? 1 : 2;
          h.str = rest.trim();
          const p = container.parent;
          p.children[p.children.indexOf(container)] = h;
          h.parent = p; container.open = false;
          tip = h; h.open = false; tip = p;
          advanceOffset(line.length - offset, false);
          return 2;
        }
      }
      return 0;
    },
    // thematic break
    (container) => {
      if (!indented && /^(?:\*[ \t]*){3,}$|^(?:_[ \t]*){3,}$|^(?:-[ \t]*){3,}$/.test(line.slice(nextNonspace))) {
        addChild('thematic_break');
        advanceOffset(line.length - offset, false);
        return 2;
      }
      return 0;
    },
    // list item
    (container) => {
      if (indented && container.type !== 'list') return 0;
      const data = parseMarker(container);
      if (!data) return 0;
      closeUnmatched();
      const lm = (a, b) => a.ordered === b.ordered && a.bullet === b.bullet && a.delim === b.delim;
      if (tip.type !== 'list' || !lm(tip.data, data)) {
        const l = addChild('list'); l.data = data;
      }
      const it = addChild('item'); it.data = data;
      return 1;
    },
    // indented code
    (container) => {
      if (indented && tip.type !== 'paragraph' && !blank) {
        advanceOffset(4, true);
        addChild('code_block');
        return 2;
      }
      return 0;
    },
  ];

  const cont = (c) => {
    switch (c.type) {
      case 'block_quote':
        if (!indented && line[nextNonspace] === '>') {
          advanceNext(); advanceOffset(1, false);
          if (isSpaceOrTab(line[offset])) advanceOffset(1, true);
          return 0;
        }
        return 1;
      case 'item':
        if (blank) { if (c.children.length === 0) return 1; advanceNext(); return 0; }
        if (indent >= c.data.markerOffset + c.data.padding) { advanceOffset(c.data.markerOffset + c.data.padding, true); return 0; }
        return 1;
      case 'heading': case 'thematic_break': return 1;
      case 'code_block':
        if (c.fenced) {
          const m = !indented && /^(?:`{3,}|~{3,})(?=[ \t]*$)/.exec(line.slice(nextNonspace));
          if (m && m[0][0] === c.fenceChar && m[0].length >= c.fenceLen) {
            advanceOffset(line.length - offset, false);
            finalize(c);
            return 2;
          }
          let i = c.fenceOffset;
          while (i > 0 && isSpaceOrTab(line[offset])) { advanceOffset(1, true); i--; }
          return 0;
        }
        if (indent >= 4) { advanceOffset(4, true); return 0; }
        if (blank) { advanceNext(); return 0; }
        return 1;
      case 'paragraph': return blank ? 1 : 0;
      case 'table': return blank ? 1 : 0;
      default: return 0;
    }
  };

  const reSpecial = /^[#`~*+_=<>0-9\-|:]/;
  const lines = src.split(/\r\n|\n|\r/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const ln of lines) {
    line = ln.replace(/\0/g, '�');
    lineNumber++;
    offset = 0; column = 0; blank = false; partial = false; tableJustMade = false;
    let container = doc;
    oldtip = tip;
    let allMatched = true, last;
    let stop = false;
    while ((last = container.children[container.children.length - 1]) && last.open) {
      container = last;
      findNext();
      const r = cont(container);
      if (r === 1) allMatched = false;
      else if (r === 2) { stop = true; break; }
      if (!allMatched) { container = container.parent; break; }
    }
    if (stop) continue;
    allClosed = container === oldtip;
    lastMatched = container;
    let matchedLeaf = ACCEPTS_LINES.has(container.type) && container.type !== 'paragraph';
    while (!matchedLeaf) {
      findNext();
      if (!indented && !reSpecial.test(line.slice(nextNonspace))) { advanceNext(); break; }
      let i = 0;
      for (; i < starts.length; i++) {
        const r = starts[i](container);
        if (r === 1) { container = tip; break; }
        if (r === 2) { container = tip; matchedLeaf = true; break; }
      }
      if (i === starts.length) { advanceNext(); break; }
    }
    if (!allClosed && !blank && tip.type === 'paragraph') {
      addLine();
    } else {
      closeUnmatched();
      if (blank && container.children.length) container.children[container.children.length - 1].lastLineBlank = true;
      const t = container.type;
      const llb = blank && !(t === 'block_quote' || (t === 'code_block' && container.fenced) || (t === 'item' && container.children.length === 0 && container.startLine === lineNumber));
      for (let c = container; c; c = c.parent) c.lastLineBlank = llb;
      if (t === 'table') {
        if (!tableJustMade && !blank) container.rows.push(splitCells(line.slice(offset)));
      } else if (ACCEPTS_LINES.has(t)) {
        addLine();
      } else if (offset < line.length && !blank) {
        addChild('paragraph');
        advanceNext();
        addLine();
      }
    }
  }
  while (tip !== doc) finalize(tip);
  closeUnmatched;
  return { doc, refs };
}

function renderDoc(doc, refs, opts, seen) {
  let out = '';
  const cr = () => { if (out && !out.endsWith('\n')) out += '\n'; };
  const inl = (s) => inline(s, refs);
  const cell = (tag, txt, al) => `<${tag}${al ? ` align="${al}"` : ''}>${inl(txt).html}</${tag}>\n`;
  function walk(b, tight) {
    switch (b.type) {
      case 'document': b.children.forEach(c => walk(c, false)); break;
      case 'paragraph': {
        const h = inl(b.str.replace(/\s+$/, '')).html;
        if (tight) out += h; else { cr(); out += `<p>${h}</p>\n`; }
        break;
      }
      case 'heading': {
        const r = inl(b.str);
        cr();
        let id = '';
        if (opts.headingIds) id = ` id="${esc(slugify(r.text, seen))}"`;
        out += `<h${b.level}${id}>${r.html}</h${b.level}>\n`;
        break;
      }
      case 'thematic_break': cr(); out += '<hr />\n'; break;
      case 'code_block': {
        cr();
        const lang = b.fenced && b.info ? b.info.split(/\s+/)[0] : '';
        out += `<pre><code${lang ? ` class="language-${esc(lang)}"` : ''}>${esc(b.str)}</code></pre>\n`;
        break;
      }
      case 'block_quote':
        cr(); out += '<blockquote>\n'; b.children.forEach(c => walk(c, false)); cr(); out += '</blockquote>\n'; break;
      case 'list': {
        cr();
        out += b.data.ordered ? (b.data.start !== 1 ? `<ol start="${b.data.start}">\n` : '<ol>\n') : '<ul>\n';
        for (const it of b.children) {
          out += '<li>';
          it.children.forEach(c => walk(c, b.tight));
          out += '</li>\n';
        }
        cr(); out += b.data.ordered ? '</ol>\n' : '</ul>\n';
        break;
      }
      case 'table': {
        cr();
        out += '<table>\n<thead>\n<tr>\n';
        b.head.forEach((t, i) => { out += cell('th', t, b.aligns[i]); });
        out += '</tr>\n</thead>\n';
        if (b.rows.length) {
          out += '<tbody>\n';
          for (const r of b.rows) {
            out += '<tr>\n';
            for (let i = 0; i < b.head.length; i++) out += cell('td', r[i] || '', b.aligns[i]);
            out += '</tr>\n';
          }
          out += '</tbody>\n';
        }
        out += '</table>\n';
        break;
      }
    }
  }
  walk(doc, false);
  return out;
}

export function render(markdown, { headingIds = false } = {}) {
  const { doc, refs } = parse(String(markdown));
  return renderDoc(doc, refs, { headingIds }, new Map());
}

export function toc(markdown) {
  const { doc, refs } = parse(String(markdown));
  const seen = new Map();
  const res = [];
  (function walk(b) {
    if (b.type === 'heading') {
      const text = inline(b.str, refs).text;
      res.push({ level: b.level, text, slug: slugify(text, seen) });
    } else b.children && b.children.forEach(walk);
  })(doc);
  return res;
}
