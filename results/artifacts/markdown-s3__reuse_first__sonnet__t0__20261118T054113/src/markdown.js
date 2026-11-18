// Markdown renderer: vendored commonmark.js (BSD-2-Clause, see src/vendor) plus
// GFM tables, strikethrough, wiki links, URL safety and heading ids (glue code).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const cm = require('./vendor/commonmark.cjs');
const { Parser, HtmlRenderer, Node } = cm;

export function slugify(text, seen) {
  let s = String(text).toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
  if (seen) {
    let slug = s;
    if (seen.has(s)) {
      let n = seen.get(s);
      do { slug = `${s}-${n}`; n++; } while (seen.has(slug));
      seen.set(s, n);
    } else seen.set(s, 1);
    seen.set(slug, seen.get(slug) ?? 1);
    return slug;
  }
  return s;
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const children = (n) => { const a = []; for (let c = n.firstChild; c; c = c.next) a.push(c); return a; };
function custom(type, onEnter, onExit) {
  const n = new Node(type);
  n.onEnter = onEnter; n.onExit = onExit;
  return n;
}
function textNode(s) { const t = new Node('text'); t.literal = s; return t; }

// ---- tables -------------------------------------------------------------
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = []; let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; }
    else if (s[i] === '|') { cells.push(cur.trim()); cur = ''; }
    else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}
const reDelimCell = /^:?-+:?$/;

function tryTable(node, parseInline) {
  const src = node._string_content;
  if (!src || !src.includes('|')) return false;
  const lines = src.replace(/\n$/, '').split('\n');
  if (lines.length < 2 || !lines[0].includes('|')) return false;
  const delim = splitRow(lines[1]);
  if (!/^[\s|:-]+$/.test(lines[1]) || !lines[1].includes('-') || !delim.every((c) => reDelimCell.test(c))) return false;
  const head = splitRow(lines[0]);
  if (head.length !== delim.length) return false;
  const aligns = delim.map((c) => (c[0] === ':' && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : c[0] === ':' ? 'left' : null));
  const mkCell = (tag, text, i) => {
    const c = custom('custom_inline', `<${tag}${aligns[i] ? ` align="${aligns[i]}"` : ''}>`, `</${tag}>`);
    c._string_content = text;
    parseInline(c);
    return c;
  };
  const mkRow = (tag, cells) => {
    const r = custom('custom_block', '<tr>', '</tr>');
    for (let i = 0; i < head.length; i++) r.appendChild(mkCell(tag, cells[i] ?? '', i));
    return r;
  };
  const thead = custom('custom_block', '<thead>', '</thead>');
  thead.appendChild(mkRow('th', head));
  const rows = lines.slice(2).map(splitRow);
  node._type = 'custom_block';
  node.onEnter = '<table>'; node.onExit = '</table>';
  node._string_content = '';
  node.appendChild(thead);
  if (rows.length) {
    const tbody = custom('custom_block', '<tbody>', '</tbody>');
    for (const r of rows) tbody.appendChild(mkRow('td', r));
    node.appendChild(tbody);
  }
  return true;
}

// ---- post passes ----------------------------------------------------------
const INLINE_PARENTS = new Set(['paragraph', 'heading', 'emph', 'strong', 'link', 'custom_inline']);

function replaceChildren(parent, list) {
  for (const c of children(parent)) c.unlink();
  for (const c of list) parent.appendChild(c);
}

function mergeText(parent) {
  const out = [];
  for (const c of children(parent)) {
    const last = out[out.length - 1];
    if (c.type === 'text' && last && last.type === 'text') last.literal += c.literal;
    else out.push(c);
  }
  replaceChildren(parent, out);
}

function wikiPass(parent, opts, collect) {
  if (parent.type === 'link') return;
  const out = [];
  for (const c of children(parent)) {
    if (c.type !== 'text' || !c.literal.includes('[[')) { out.push(c); continue; }
    const re = /\[\[([^\[\]\n]+?)\]\]/g;
    let last = 0, m;
    const s = c.literal;
    while ((m = re.exec(s))) {
      const bar = m[1].indexOf('|');
      const target = (bar >= 0 ? m[1].slice(0, bar) : m[1]).trim();
      const label = (bar >= 0 ? m[1].slice(bar + 1) : m[1]).trim();
      const slug = slugify(target);
      if (!target || !label || !slug) continue;
      if (m.index > last) out.push(textNode(s.slice(last, m.index)));
      collect?.add(slug);
      if (opts.wikiLinks) {
        const ok = !!opts.wikiLinks.exists(slug);
        const a = custom('custom_inline', `<a href="/wiki/${esc(slug)}" class="wikilink${ok ? '' : ' missing'}">`, '</a>');
        a.appendChild(textNode(label));
        out.push(a);
      } else out.push(textNode(m[0]));
      last = m.index + m[0].length;
    }
    if (last < s.length) out.push(textNode(s.slice(last)));
  }
  replaceChildren(parent, out);
}

function strikePass(parent) {
  if (!children(parent).some((c) => c.type === 'text' && c.literal.includes('~~'))) return;
  const toks = [];
  for (const c of children(parent)) {
    if (c.type === 'text' && c.literal.includes('~~')) {
      c.literal.split('~~').forEach((part, i) => {
        if (i > 0) toks.push({ mark: true });
        if (part) toks.push(textNode(part));
      });
    } else toks.push(c);
  }
  const startsWs = (t) => t && t.type === 'text' && /^\s/.test(t.literal);
  const endsWs = (t) => t && t.type === 'text' && /\s$/.test(t.literal);
  let open = -1;
  const pairs = [];
  toks.forEach((t, j) => {
    if (!t.mark) return;
    if (open < 0) { open = j; return; }
    if (j > open + 1 && !startsWs(toks[open + 1]) && !endsWs(toks[j - 1])) { pairs.push([open, j]); open = -1; }
    else open = j;
  });
  const result = [];
  let pi = 0;
  for (let j = 0; j < toks.length; j++) {
    if (pi < pairs.length && pairs[pi][0] === j) {
      const del = custom('custom_inline', '<del>', '</del>');
      for (let k = j + 1; k < pairs[pi][1]; k++) del.appendChild(toks[k].mark ? textNode('~~') : toks[k]);
      result.push(del);
      j = pairs[pi][1]; pi++;
    } else result.push(toks[j].mark ? textNode('~~') : toks[j]);
  }
  replaceChildren(parent, result);
}

function walkParents(node, fn) {
  for (const c of children(node)) walkParents(c, fn);
  if (INLINE_PARENTS.has(node.type)) fn(node);
}

const reUnsafe = /^[\s\u0000-\u001f]*(?:javascript|vbscript|file|data):/i;
const reSafeData = /^[\s\u0000-\u001f]*data:image\/(?:png|gif|jpeg|webp);/i;
function sanitize(doc) {
  const w = doc.walker(); let e;
  while ((e = w.next())) {
    const n = e.node;
    if ((n.type === 'link' || n.type === 'image') && e.entering && reUnsafe.test(n.destination || '') && !reSafeData.test(n.destination)) n.destination = '#';
  }
}

function plainText(node) {
  let s = '';
  const w = node.walker(); let e;
  while ((e = w.next())) {
    if (e.entering && (e.node.type === 'text' || e.node.type === 'code')) s += e.node.literal;
    else if (e.entering && (e.node.type === 'softbreak' || e.node.type === 'linebreak')) s += ' ';
  }
  return s;
}

function parse(markdown, opts = {}, collect) {
  const parser = new Parser();
  const ip = parser.inlineParser;
  const orig = ip.parse.bind(ip);
  const parseInline = (n) => orig(n);
  ip.parse = (n) => { if (n.type === 'paragraph' && tryTable(n, parseInline)) return; orig(n); };
  const doc = parser.parse(String(markdown));
  walkParents(doc, mergeText);
  walkParents(doc, (n) => wikiPass(n, opts, collect));
  walkParents(doc, strikePass);
  sanitize(doc);
  return doc;
}

export function render(markdown, { headingIds = false, wikiLinks } = {}) {
  const doc = parse(markdown, { wikiLinks });
  const seen = new Map();
  const r = new HtmlRenderer();
  r.html_inline = function (n) { this.out(n.literal); };
  r.html_block = function (n) { this.cr(); this.out(n.literal); this.cr(); };
  r.heading = function (n, entering) {
    const tag = 'h' + n.level;
    if (entering) {
      this.cr();
      this.tag(tag, headingIds ? [['id', esc(slugify(plainText(n), seen))]] : []);
    } else { this.tag('/' + tag); this.cr(); }
  };
  return r.render(doc);
}

export function toc(markdown) {
  const doc = parse(markdown);
  const seen = new Map();
  const out = [];
  for (const h of children(doc).length ? collectHeadings(doc) : []) {
    const text = plainText(h);
    out.push({ level: h.level, text, slug: slugify(text, seen) });
  }
  return out;
}
function collectHeadings(doc) {
  const hs = []; const w = doc.walker(); let e;
  while ((e = w.next())) if (e.entering && e.node.type === 'heading') hs.push(e.node);
  return hs;
}

// Distinct wiki-link target slugs of a document (code is ignored).
export function wikiTargets(markdown) {
  const set = new Set();
  parse(markdown, {}, set);
  return [...set].sort();
}
