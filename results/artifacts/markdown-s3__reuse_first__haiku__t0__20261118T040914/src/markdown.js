// Markdown renderer for markdown-s3.
// Core: commonmark.js 0.31.2 (BSD-2-Clause), vendored as ./vendor/commonmark.cjs.
// Extensions added here (glue): GFM pipe tables, ~~strikethrough~~, wiki links,
// escaped raw HTML, safe link schemes, GitHub-style heading slugs.
import cm from './vendor/commonmark.cjs';

const { Parser, HtmlRenderer, Node } = cm;

// ---------- slugs ----------

export function slugify(text, seen) {
  const base = String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/ /g, '-');
  if (!seen) return base;
  if (!seen.has(base)) {
    seen.set(base, 0);
    return base;
  }
  let k = seen.get(base) + 1;
  let cand = `${base}-${k}`;
  while (seen.has(cand)) {
    k++;
    cand = `${base}-${k}`;
  }
  seen.set(base, k);
  seen.set(cand, 0);
  return cand;
}

function plainText(node) {
  let out = '';
  for (let c = node.firstChild; c; c = c.next) {
    switch (c.type) {
      case 'text':
      case 'code':
      case 'html_inline':
        out += c.literal;
        break;
      case 'softbreak':
      case 'linebreak':
        out += ' ';
        break;
      default:
        out += plainText(c);
    }
  }
  return out;
}

// ---------- safety ----------

const reUnsafeScheme = /^(javascript|vbscript|file|data):/i;
const reSafeDataUrl = /^data:image\/(png|gif|jpeg|webp);/i;

export function potentiallyUnsafe(url) {
  const u = String(url).replace(/[\u0000- \u007f]/g, '');
  return reUnsafeScheme.test(u) && !reSafeDataUrl.test(u);
}

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------- GFM tables (block level, applied to paragraphs before inline parsing) ----------

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '\\|';
      i++;
    } else if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

const reDelimCell = /^:?-+:?$/;

function parseDelimiter(line) {
  if (!line.includes('|')) return null;
  const cells = splitRow(line);
  if (!cells.every((c) => reDelimCell.test(c))) return null;
  return cells.map((c) => {
    const left = c.startsWith(':');
    const right = c.endsWith(':');
    if (left && right) return 'center';
    if (left) return 'left';
    if (right) return 'right';
    return null;
  });
}

function customInline(onEnter, onExit) {
  const n = new Node('custom_inline');
  n.onEnter = onEnter;
  n.onExit = onExit;
  return n;
}

function customBlock(onEnter, onExit) {
  const n = new Node('custom_block');
  n.onEnter = onEnter;
  n.onExit = onExit;
  return n;
}

function buildTable(header, aligns, bodyRows) {
  const alignAttr = (i) => (aligns[i] ? ` align="${aligns[i]}"` : '');
  const table = customBlock('<table>', '</table>');
  const thead = customBlock('<thead>', '</thead>');
  const headRow = customBlock('<tr>', '</tr>');
  header.forEach((text, i) => {
    const cell = customInline(`<th${alignAttr(i)}>`, '</th>');
    cell._string_content = text;
    cell._isTableCell = true;
    headRow.appendChild(cell);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);
  if (bodyRows.length) {
    const tbody = customBlock('<tbody>', '</tbody>');
    for (const cells of bodyRows) {
      const row = customBlock('<tr>', '</tr>');
      for (let i = 0; i < header.length; i++) {
        const cell = customInline(`<td${alignAttr(i)}>`, '</td>');
        cell._string_content = cells[i] ?? '';
        cell._isTableCell = true;
        row.appendChild(cell);
      }
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
  }
  return table;
}

// Returns true if the paragraph was replaced (or split) by a table.
function tableFromParagraph(p) {
  const raw = p._string_content;
  if (raw == null || !raw.includes('|')) return false;
  const lines = raw.replace(/\n$/, '').split('\n');
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i].includes('|')) continue;
    const aligns = parseDelimiter(lines[i + 1]);
    if (!aligns) continue;
    const header = splitRow(lines[i]);
    if (header.length !== aligns.length) continue;
    const bodyRows = lines.slice(i + 2).map(splitRow);
    const table = buildTable(header, aligns, bodyRows);
    const before = lines.slice(0, i);
    if (before.length) {
      p._string_content = before.join('\n');
      p.insertAfter(table);
    } else {
      p.insertBefore(table);
      p.unlink();
    }
    return true;
  }
  return false;
}

// ---------- inline post-processing on sibling lists ----------

function textNode(s) {
  const t = new Node('text');
  t.literal = s;
  return t;
}

// Merge adjacent text siblings and turn a container's children into an array.
function childArray(parent) {
  const arr = [];
  for (let c = parent.firstChild; c; c = c.next) {
    const prev = arr[arr.length - 1];
    if (c.type === 'text' && prev && prev.type === 'text') {
      arr[arr.length - 1] = textNode(prev.literal + c.literal);
    } else {
      arr.push(c);
    }
  }
  return arr;
}

function setChildren(parent, arr) {
  let c = parent.firstChild;
  while (c) {
    const nx = c.next;
    c.unlink();
    c = nx;
  }
  for (const n of arr) parent.appendChild(n);
}

// Find `open ... close` spans across sibling nodes and replace them with make(innerNodes).
// allowAny: whether intermediate siblings may be non-text nodes.
function wrapSpans(parent, open, close, allowAny, make) {
  let arr = childArray(parent);
  let progress = true;
  while (progress) {
    progress = false;
    outer: for (let a = 0; a < arr.length; a++) {
      if (arr[a].type !== 'text') continue;
      let pa = arr[a].literal.indexOf(open);
      while (pa >= 0) {
        const startInner = pa + open.length;
        for (let j = a; j < arr.length; j++) {
          if (j > a && !allowAny && arr[j].type !== 'text') break;
          if (arr[j].type !== 'text') continue;
          const from = j === a ? startInner : 0;
          const pb = arr[j].literal.indexOf(close, from);
          if (pb < 0) continue;
          const inner = [];
          if (j === a) {
            const mid = arr[a].literal.slice(startInner, pb);
            if (mid.length) inner.push(textNode(mid));
          } else {
            const head = arr[a].literal.slice(startInner);
            if (head.length) inner.push(textNode(head));
            for (let k = a + 1; k < j; k++) inner.push(arr[k]);
            const tail = arr[j].literal.slice(0, pb);
            if (tail.length) inner.push(textNode(tail));
          }
          const innerIsEmpty = inner.length === 0 || inner.every((n) => n.type === 'text' && n.literal === '');
          if (innerIsEmpty || (!allowAny && inner.some((n) => n.type !== 'text'))) break;
          const node = make(inner);
          const next = [];
          const before = arr[a].literal.slice(0, pa);
          if (before.length) next.push(textNode(before));
          next.push(node);
          const after = arr[j].literal.slice(pb + close.length);
          if (after.length) next.push(textNode(after));
          arr = [...arr.slice(0, a), ...next, ...arr.slice(j + 1)];
          progress = true;
          break outer;
        }
        pa = arr[a].literal.indexOf(open, pa + 1);
      }
    }
  }
  setChildren(parent, arr);
}

const reTargetSplit = /\|/;

function makeWikiNode(inner, wiki) {
  const text = inner.map((n) => n.literal).join('');
  const parts = text.split(reTargetSplit);
  const target = parts[0].trim();
  const label = parts.length > 1 ? parts.slice(1).join('|').trim() : target;
  const slug = slugify(target);
  if (!target || !slug || !label) return null;
  const n = customInline('', '</a>');
  n.wikiSlug = slug;
  n.wikiTarget = target;
  const exists = wiki && wiki.exists ? wiki.exists(slug) : true;
  n.onEnter = `<a href="/wiki/${escapeAttr(slug)}" class="${exists ? 'wikilink' : 'wikilink missing'}">`;
  n.appendChild(textNode(label));
  return n;
}

// ---------- document pipeline ----------

const INLINE_CONTAINERS = new Set([
  'paragraph', 'heading', 'custom_inline', 'emph', 'strong', 'link', 'image', 'table_cell',
]);

function walkNodes(root, fn) {
  const walker = root.walker();
  let ev;
  while ((ev = walker.next())) {
    if (ev.entering) fn(ev.node);
  }
}

function makeParser(opts) {
  const parser = new Parser({});
  const origProcess = parser.processInlines;
  parser.processInlines = function (block) {
    // 1. tables: paragraphs that form a GFM table become table nodes
    const paras = [];
    walkNodes(block, (n) => {
      if (n.type === 'paragraph') paras.push(n);
    });
    for (const p of paras) tableFromParagraph(p);

    // 2. normal inline parsing (paragraphs and headings)
    origProcess.call(this, block);

    // 3. inline parsing for table cells
    this.inlineParser.refmap = this.refmap;
    this.inlineParser.options = this.options;
    const cells = [];
    walkNodes(block, (n) => {
      if (n._isTableCell) cells.push(n);
    });
    for (const c of cells) {
      this.inlineParser.parse(c);
    }

    // 4. post-process inline sibling lists
    const containers = [];
    walkNodes(block, (n) => {
      if (INLINE_CONTAINERS.has(n.type)) containers.push(n);
    });
    for (const n of containers) {
      if (n.type === 'link' || n.type === 'image') {
        if (potentiallyUnsafe(n.destination)) n.destination = '#';
      }
      if (n.firstChild == null) continue;
      wrapSpans(n, '~~', '~~', true, (inner) => {
        const d = customInline('<del>', '</del>');
        for (const c of inner) d.appendChild(c);
        return d;
      });
      if (opts.wiki) {
        wrapSpans(n, '[[', ']]', false, (inner) => makeWikiNode(inner, opts.wiki) || textWrap(inner));
      } else {
        // still merge adjacent text
        setChildren(n, childArray(n));
      }
    }
  };
  return parser;
}

// Fallback when a [[...]] span is not a valid wiki link: keep its text literal.
function textWrap(inner) {
  const wrapper = customInline('', '');
  wrapper.onEnter = '[[';
  wrapper.onExit = ']]';
  for (const c of inner) wrapper.appendChild(c);
  return wrapper;
}

function parseDocument(markdown, opts = {}) {
  const parser = makeParser(opts);
  return parser.parse(String(markdown ?? ''));
}

// Assign GitHub-style slugs to headings in document order.
function assignSlugs(doc) {
  const seen = new Map();
  const headings = [];
  walkNodes(doc, (n) => {
    if (n.type === 'heading') {
      n._slug = slugify(plainText(n), seen);
      headings.push(n);
    }
  });
  return headings;
}

function makeRenderer(headingIds) {
  const r = new HtmlRenderer({});
  const origAttrs = r.attrs;
  r.attrs = function (node) {
    const a = origAttrs.call(this, node);
    if (headingIds && node.type === 'heading' && node._slug) a.push(['id', node._slug]);
    return a;
  };
  // Raw HTML is shown as escaped text.
  r.html_inline = function (node) {
    this.out(node.literal);
  };
  r.html_block = function (node) {
    this.cr();
    this.lit('<p>');
    this.out(String(node.literal).replace(/\n$/, ''));
    this.lit('</p>');
    this.cr();
  };
  return r;
}

export function render(markdown, { headingIds = false, wikiLinks } = {}) {
  const doc = parseDocument(markdown, { wiki: wikiLinks ? { exists: wikiLinks.exists ?? (() => true) } : null });
  assignSlugs(doc);
  return makeRenderer(headingIds).render(doc);
}

export function toc(markdown) {
  // wiki-aware so heading text and slugs match the rendered page
  const doc = parseDocument(markdown, { wiki: { exists: () => true } });
  return assignSlugs(doc).map((h) => ({ level: h.level, text: plainText(h), slug: h._slug }));
}

// Distinct sorted slugs of wiki link targets in the document (for backlinks/links).
export function wikiLinkTargets(markdown) {
  const doc = parseDocument(markdown, { wiki: { exists: () => true } });
  const set = new Set();
  walkNodes(doc, (n) => {
    if (n.wikiSlug) set.add(n.wikiSlug);
  });
  return [...set].sort();
}
