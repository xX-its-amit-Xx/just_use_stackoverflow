// Safe Markdown renderer: adapter around vendored commonmark.js (BSD-2-Clause, see vendor/).
// Adds GFM tables + strikethrough, escapes raw HTML, sanitizes URLs, heading ids and TOC.
import cm from './vendor/commonmark.cjs';

const { Parser, HtmlRenderer, Node } = cm;

const UNSAFE = /^(?:javascript|vbscript|file|data):/i;
const SAFE_DATA = /^data:image\/(?:png|gif|jpeg|webp);/i;

function safeUrl(u) {
  if (!u) return u;
  const t = u.replace(/[\u0000- \u007f-\u009f​­]/g, '');
  if (UNSAFE.test(t) && !SAFE_DATA.test(t)) return '#';
  return u;
}

// ---- strikethrough (~~x~~) over sibling text nodes
function strike(root) {
  const w = root.walker();
  const parents = [];
  let ev;
  while ((ev = w.next())) if (ev.entering && ev.node.firstChild) parents.push(ev.node);
  for (const p of parents) strikeIn(p);
}
function strikeIn(parent) {
  let has = false;
  for (let c = parent.firstChild; c; c = c.next) if (c.type === 'text' && c.literal.includes('~~')) has = true;
  if (!has) return;
  const items = [];
  for (let c = parent.firstChild; c; ) {
    const nx = c.next;
    if (c.type === 'text' && c.literal.includes('~~')) {
      const parts = c.literal.split(/(?<!~)~~(?!~)/);
      parts.forEach((s, i) => {
        if (i > 0) items.push({ m: true, canOpen: s !== '' && !/^\s/.test(s), canClose: !/\s$/.test(parts[i - 1]) && parts[i - 1] !== '' || (parts[i - 1] === '' && items.length > 0 && !items[items.length - 1].m) });
        if (s !== '') { const t = new Node('text'); t.literal = s; items.push({ n: t }); }
      });
      // marker at node edge adjacent to other nodes: allow open/close
      c.unlink();
    } else { c.unlink(); items.push({ n: c }); }
    c = nx;
  }
  // fix edge flanking: marker at start of text node followed by node, etc.
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it.m) continue;
    const nxt = items[i + 1], prv = items[i - 1];
    it.canOpen = !!nxt && !(nxt.n && nxt.n.type === 'text' && /^\s/.test(nxt.n.literal)) && !(nxt.n && nxt.n.type === 'softbreak') && !(nxt.n && nxt.n.type === 'linebreak');
    it.canClose = !!prv && !prv.m && !(prv.n.type === 'text' && /\s$/.test(prv.n.literal)) && prv.n.type !== 'softbreak' && prv.n.type !== 'linebreak';
  }
  const stack = [];
  items.forEach((it, i) => {
    if (!it.m) return;
    if (it.canClose) {
      const o = stack.lastIndexOf(stack.filter(s => true).pop());
      if (stack.length) {
        const open = stack.pop();
        open.pair = it; it.paired = true; open.paired = true;
        return;
      }
    }
    if (it.canOpen) stack.push(it);
  });
  // rebuild
  const out = [];
  const holders = [];
  const cur = () => (holders.length ? holders[holders.length - 1].node : parent);
  for (const it of items) {
    if (it.m) {
      if (it.paired && it.pair) {
        const d = new Node('custom_inline'); d.onEnter = '<del>'; d.onExit = '</del>';
        cur().appendChild(d); holders.push({ node: d, end: it.pair });
        continue;
      }
      if (it.paired && holders.length && holders[holders.length - 1].end === it) { holders.pop(); continue; }
      const t = new Node('text'); t.literal = '~~'; cur().appendChild(t); continue;
    }
    cur().appendChild(it.n);
  }
}

// ---- tables
const splitRow = line => {
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
};
const countRow = line => splitRow(line).length;
const isDelim = line => {
  if (!/^\s{0,3}[|:\-\s]+$/.test(line) || !line.includes('-')) return null;
  const c = splitRow(line);
  if (!c.every(x => /^:?-+:?$/.test(x))) return null;
  return c.map(x => (x[0] === ':' ? (x.endsWith(':') ? 'center' : 'left') : x.endsWith(':') ? 'right' : null));
};

function makeTable(parser, lines, aligns) {
  const renderCell = text => {
    const doc = new Node('document'); const p = new Node('paragraph');
    p._string_content = text; doc.appendChild(p);
    parser.inlineParser.parse(p);
    strike(p); sanitize(doc);
    return new HtmlRenderer().render(doc).replace(/^<p>/, '').replace(/<\/p>\s*$/, '');
  };
  const al = i => (aligns[i] ? ` align="${aligns[i]}"` : '');
  const fit = cells => { const r = cells.slice(0, aligns.length); while (r.length < aligns.length) r.push(''); return r; };
  let h = '<table>\n<thead>\n<tr>\n';
  fit(splitRow(lines[0])).forEach((c, i) => { h += `<th${al(i)}>${renderCell(c)}</th>\n`; });
  h += '</tr>\n</thead>\n';
  if (lines.length > 2) {
    h += '<tbody>\n';
    for (const l of lines.slice(2)) {
      h += '<tr>\n';
      fit(splitRow(l)).forEach((c, i) => { h += `<td${al(i)}>${renderCell(c)}</td>\n`; });
      h += '</tr>\n';
    }
    h += '</tbody>\n';
  }
  h += '</table>\n';
  const n = new Node('html_block'); n.literal = h; n._trusted = true;
  return n;
}

function tablesIn(parser, para) {
  const content = para._string_content;
  if (!content || !content.includes('|')) return false;
  const lines = content.replace(/\n$/, '').split('\n');
  for (let i = 0; i + 1 < lines.length; i++) {
    const aligns = isDelim(lines[i + 1]);
    if (!aligns || !(lines[i].includes('|') || lines[i + 1].includes('|'))) continue;
    if (countRow(lines[i]) !== aligns.length) continue;
    const tbl = makeTable(parser, lines.slice(i), aligns);
    para.insertAfter(tbl);
    if (i > 0) para._string_content = lines.slice(0, i).join('\n') + '\n';
    else para.unlink();
    return i > 0 ? para : null;
  }
  return false;
}

// ---- sanitize: raw html -> text, unsafe URLs -> '#'
function sanitize(root) {
  const w = root.walker();
  let ev;
  const blocks = [];
  while ((ev = w.next())) {
    const n = ev.node;
    if (!ev.entering) continue;
    if (n.type === 'html_inline') n._type = 'text';
    else if (n.type === 'html_block' && !n._trusted) blocks.push(n);
    else if (n.type === 'link' || n.type === 'image') n.destination = safeUrl(n.destination);
  }
  for (const b of blocks) {
    const p = new Node('paragraph'); const t = new Node('text');
    t.literal = b.literal.replace(/\n+$/, ''); p.appendChild(t);
    b.insertBefore(p); b.unlink();
  }
}

function makeParser() {
  const parser = new Parser();
  parser.processInlines = function (block) {
    this.inlineParser.refmap = this.refmap;
    this.inlineParser.options = this.options;
    const w = block.walker();
    const todo = [];
    let ev;
    while ((ev = w.next())) {
      const t = ev.node.type;
      if (!ev.entering && (t === 'paragraph' || t === 'heading')) todo.push(ev.node);
    }
    for (let node of todo) {
      if (node.type === 'paragraph') {
        const r = tablesIn(this, node);
        if (r === null) continue;
        if (r) node = r;
      }
      this.inlineParser.parse(node);
      strike(node);
    }
  };
  return parser;
}

function parse(md) {
  const doc = makeParser().parse(String(md).replace(/\r\n?/g, '\n'));
  sanitize(doc);
  return doc;
}

export function slugify(text, seen) {
  const slug = String(text).toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
  if (!(seen instanceof Map)) return slug;
  if (!seen.has(slug)) { seen.set(slug, 0); return slug; }
  let n = seen.get(slug);
  let cand;
  do { n++; cand = `${slug}-${n}`; } while (seen.has(cand));
  seen.set(slug, n); seen.set(cand, 0);
  return cand;
}

function plain(node) {
  let s = '';
  const w = node.walker();
  let ev;
  while ((ev = w.next())) {
    if (!ev.entering) continue;
    const n = ev.node;
    if (n.type === 'text' || n.type === 'code') s += n.literal;
    else if (n.type === 'softbreak' || n.type === 'linebreak') s += ' ';
    else if (n.type === 'html_inline') s += n.literal;
  }
  return s;
}

function headings(doc) {
  const seen = new Map();
  const out = [];
  const w = doc.walker();
  let ev;
  while ((ev = w.next())) {
    if (ev.entering && ev.node.type === 'heading') {
      const text = plain(ev.node);
      out.push({ node: ev.node, level: ev.node.level, text, slug: slugify(text, seen) });
    }
  }
  return out;
}

export function toc(markdown) {
  return headings(parse(markdown)).map(({ level, text, slug }) => ({ level, text, slug }));
}

export function render(markdown, { headingIds = false } = {}) {
  const doc = parse(markdown);
  if (headingIds) for (const h of headings(doc)) h.node._id = h.slug;
  const r = new HtmlRenderer({ safe: false });
  const attrs = r.attrs;
  r.attrs = function (node) {
    const a = attrs.call(this, node);
    if (node._id) a.push(['id', node._id]);
    return a;
  };
  return r.render(doc);
}
