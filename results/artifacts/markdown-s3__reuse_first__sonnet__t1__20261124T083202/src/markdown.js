import { createRequire } from 'node:module';
const cm = createRequire(import.meta.url)('./vendor/commonmark.cjs');
const { Parser, HtmlRenderer, Node } = cm;

export function slugify(text, seen) {
  let s = String(text).toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
  if (seen) {
    if (seen.has(s)) { let n = seen.get(s); let c; do { c = `${s}-${n}`; n++; } while (seen.has(c)); seen.set(s, n); seen.set(c, 1); s = c; }
    else seen.set(s, 1);
  }
  return s;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function splitRow(line) {
  let t = line.trim();
  if (t.startsWith('|')) t = t.slice(1);
  const cells = []; let cur = '';
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (c === '\\' && t[i + 1] === '|') { cur += '|'; i++; }
    else if (c === '|') { cells.push(cur); cur = ''; }
    else cur += c;
  }
  const endsPipe = /(^|[^\\])\|\s*$/.test(line.trim()) && line.trim() !== '|';
  if (!endsPipe || cur.trim() !== '') cells.push(cur);
  return cells.map((c) => c.trim());
}
const DELIM = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function mk(type, props) { const n = new Node(type); Object.assign(n, props); return n; }

function transformTables(doc, inl) {
  const w = doc.walker(); let e; const paras = [];
  while ((e = w.next())) if (e.entering && e.node.type === 'paragraph') paras.push(e.node);
  for (const p of paras) {
    const lines = (p._string_content || '').replace(/\n$/, '').split('\n');
    if (lines.length < 2 || !lines[0].includes('|') || !DELIM.test(lines[1]) || !lines[1].includes('-')) continue;
    const head = splitRow(lines[0]); const dl = splitRow(lines[1]);
    if (head.length !== dl.length) continue;
    const aligns = dl.map((d) => (d.startsWith(':') && d.endsWith(':') ? 'center' : d.endsWith(':') ? 'right' : d.startsWith(':') ? 'left' : null));
    const table = mk('custom_block', { onEnter: '<table>', onExit: '</table>' });
    const row = (cells, tag, parent) => {
      const tr = mk('custom_block', { onEnter: '<tr>', onExit: '</tr>' });
      for (let i = 0; i < head.length; i++) {
        const a = aligns[i] ? ` align="${aligns[i]}"` : '';
        const cell = mk('custom_inline', { onEnter: `<${tag}${a}>`, onExit: `</${tag}>` });
        const tmp = new Node('paragraph'); tmp._string_content = cells[i] || '';
        const holder = new Node('document'); holder.appendChild(tmp); inl(holder);
        while (tmp.firstChild) { const c = tmp.firstChild; c.unlink(); cell.appendChild(c); }
        tr.appendChild(cell);
      }
      parent.appendChild(tr);
    };
    const thead = mk('custom_block', { onEnter: '<thead>', onExit: '</thead>' });
    row(head, 'th', thead); table.appendChild(thead);
    if (lines.length > 2) {
      const tbody = mk('custom_block', { onEnter: '<tbody>', onExit: '</tbody>' });
      for (const l of lines.slice(2)) row(splitRow(l), 'td', tbody);
      table.appendChild(tbody);
    }
    p.insertBefore(table); p.unlink();
  }
}

function mergeText(parent) {
  let c = parent.firstChild;
  while (c) {
    const nx = c.next;
    if (c.type === 'text' && nx && nx.type === 'text') { c.literal += nx.literal; nx.unlink(); continue; }
    c = nx;
  }
}

function strike(parent) {
  const kids = []; for (let c = parent.firstChild; c; c = c.next) kids.push(c);
  // find markers
  const items = [];
  for (const k of kids) {
    if (k.type === 'text' && k.literal.includes('~~')) {
      const parts = k.literal.split('~~');
      parts.forEach((s, i) => { if (i) items.push({ marker: true, anchor: k }); if (s) items.push({ text: s }); });
      items.push({ done: k });
    }
  }
  if (!items.some((i) => i.marker)) return;
  // rebuild
  const out = []; // {node} or marker
  for (const k of kids) {
    if (k.type === 'text' && k.literal.includes('~~')) {
      k.literal.split('~~').forEach((s, i) => {
        if (i) out.push({ marker: true });
        if (s) { const t = new Node('text'); t.literal = s; out.push({ node: t }); }
      });
    } else out.push({ node: k });
  }
  const idx = out.map((o, i) => (o.marker ? i : -1)).filter((i) => i >= 0);
  const pairs = [];
  for (let i = 0; i + 1 < idx.length; i += 2) pairs.push([idx[i], idx[i + 1]]);
  const result = []; let pi = 0;
  for (let i = 0; i < out.length; i++) {
    if (pi < pairs.length && i === pairs[pi][0] && pairs[pi][1] > i + 1) {
      const del = new Node('strong'); del.__del = true;
      const d = mk('custom_inline', { onEnter: '<del>', onExit: '</del>' });
      for (let j = i + 1; j < pairs[pi][1]; j++) { if (out[j].node.parent) out[j].node.unlink(); d.appendChild(out[j].node); }
      result.push(d); i = pairs[pi][1]; pi++;
    } else if (out[i].marker) {
      if (pi < pairs.length && i === pairs[pi][1]) pi++;
      const t = new Node('text'); t.literal = '~~'; result.push(t);
    } else { if (out[i].node.parent) out[i].node.unlink(); result.push(out[i].node); }
  }
  while (parent.firstChild) parent.firstChild.unlink();
  for (const r of result) { if (r.parent) r.unlink(); parent.appendChild(r); }
}

const BAD = /^[\s\u0000-\u001f]*(javascript|vbscript|file|data):/i;
const OKDATA = /^[\s\u0000-\u001f]*data:image\/(png|gif|jpeg|webp);/i;
const cleanUrl = (u) => (BAD.test(u || '') && !OKDATA.test(u) ? '#' : u);

function wiki(parent, opts) {
  const kids = []; for (let c = parent.firstChild; c; c = c.next) kids.push(c);
  for (const k of kids) {
    if (k.type !== 'text' || !k.literal.includes('[[')) continue;
    const re = /\[\[([^\[\]|]+?)(?:\|([^\[\]]+?))?\]\]/g; const s = k.literal; let last = 0, m, any = false;
    const add = (lit) => { const t = new Node('text'); t.literal = lit; k.insertBefore(t); };
    while ((m = re.exec(s))) {
      any = true;
      if (m.index > last) add(s.slice(last, m.index));
      const target = m[1].trim(); const label = m[2] !== undefined ? m[2].trim() : target;
      const slug = slugify(target);
      const ok = !!opts.wikiLinks.exists(slug);
      const a = mk('custom_inline', { onEnter: `<a href="/wiki/${esc(slug)}" class="wikilink${ok ? '' : ' missing'}">`, onExit: '</a>' });
      const t = new Node('text'); t.literal = label; a.appendChild(t); k.insertBefore(a);
      last = m.index + m[0].length;
    }
    if (any) { if (last < s.length) add(s.slice(last)); k.unlink(); }
  }
}

function plain(node) {
  let s = ''; const w = node.walker(); let e;
  while ((e = w.next())) {
    if (!e.entering) continue;
    const n = e.node;
    if (n.type === 'text' || n.type === 'code') s += n.literal;
    else if (n.type === 'softbreak' || n.type === 'linebreak') s += ' ';
    else if (n.type === 'custom_inline' && n.onEnter && n.onEnter.startsWith('<a ')) { /* label text collected via child text */ }
  }
  return s;
}

function build(markdown, opts = {}) {
  const parser = new Parser();
  const origInl = parser.processInlines.bind(parser);
  parser.processInlines = (doc) => { transformTables(doc, origInl); origInl(doc); };
  const doc = parser.parse(String(markdown));
  const w = doc.walker(); let e; const containers = []; const fix = [];
  while ((e = w.next())) {
    if (!e.entering) continue;
    const n = e.node;
    if (n.type === 'html_block') fix.push(n);
    else if (n.type === 'html_inline') fix.push(n);
    else if (n.type === 'link' || n.type === 'image') n._destination = cleanUrl(n._destination);
  }
  for (const n of fix) {
    if (n.type === 'html_block') { const b = mk('custom_block', { onEnter: esc(n.literal.replace(/\n$/, '')), onExit: '' }); n.insertBefore(b); n.unlink(); }
    else { const t = new Node('text'); t.literal = n.literal; n.insertBefore(t); n.unlink(); }
  }
  const inlineParents = [];
  const w2 = doc.walker();
  while ((e = w2.next())) {
    const n = e.node;
    if (e.entering && n.isContainer && n.type !== 'document' && n.type !== 'list' && n.type !== 'item' && n.type !== 'block_quote' && n.type !== 'custom_block') inlineParents.push(n);
  }
  for (const n of inlineParents) {
    mergeText(n);
    if (n.type === 'code_block') continue;
    strike(n); mergeText(n);
    if (opts.wikiLinks) wiki(n, opts);
  }
  return doc;
}

export function render(markdown, { headingIds = false, wikiLinks } = {}) {
  const doc = build(markdown, { wikiLinks });
  const r = new HtmlRenderer({ softbreak: '\n' });
  if (headingIds) {
    const seen = new Map(); const orig = r.attrs;
    r.attrs = function (node) {
      const a = orig.call(this, node);
      if (node.type === 'heading') a.push(['id', slugify(plain(node), seen)]);
      return a;
    };
  }
  return r.render(doc);
}

export function toc(markdown) {
  const doc = build(markdown, {}); const seen = new Map(); const out = [];
  const w = doc.walker(); let e;
  while ((e = w.next())) if (e.entering && e.node.type === 'heading') {
    const text = plain(e.node); out.push({ level: e.node.level, text, slug: slugify(text, seen) });
  }
  return out;
}

export function wikiTargets(markdown) {
  const set = new Set(); const doc = build(markdown, { wikiLinks: { exists: () => true } });
  const w = doc.walker(); let e;
  while ((e = w.next())) if (e.entering && e.node.type === 'custom_inline') {
    const m = /^<a href="\/wiki\/([^"]*)" class="wikilink/.exec(e.node.onEnter || '');
    if (m) set.add(m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  }
  return [...set].sort();
}
