// Markdown renderer: CommonMark 0.31 (vendored commonmark.js, see
// src/vendor and THIRD_PARTY_NOTICES.md) plus GFM tables (vendored block
// extension), ~~strikethrough~~, [[wiki links]], GitHub-style heading slugs.

import { Node, Parser, HtmlRenderer } from './vendor/commonmark/index.js';

const WIKI_RE = /\[\[([^[\]\n]+?)\]\]/g;
const CONTAINERS = new Set(['paragraph', 'heading', 'emph', 'strong', 'del', 'table_cell']);
const LITERAL_TYPES = new Set(['text', 'code', 'html_inline']);

/**
 * GitHub-style slug. With a `seen` Map, duplicates get -1, -2, ...
 */
export function slugify(text, seen) {
  const base = String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-');
  if (!seen) return base;
  if (!seen.has(base)) {
    seen.set(base, 0);
    return base;
  }
  let k = seen.get(base);
  let cand;
  do {
    k += 1;
    cand = `${base}-${k}`;
  } while (seen.has(cand));
  seen.set(base, k);
  seen.set(cand, 0);
  return cand;
}

function plainText(node) {
  let out = '';
  const walker = node.walker();
  let ev;
  while ((ev = walker.next())) {
    if (ev.entering && LITERAL_TYPES.has(ev.node.type)) out += ev.node.literal || '';
  }
  return out;
}

function textNode(s) {
  const n = new Node('text');
  n.literal = s;
  return n;
}

function childrenOf(node) {
  const list = [];
  for (let c = node._firstChild; c; c = c._next) list.push(c);
  return list;
}

function setChildren(node, list) {
  for (let c = node._firstChild; c; ) {
    const next = c._next;
    c.unlink();
    c = next;
  }
  for (const c of list) node.appendChild(c);
}

// Merge adjacent plain text nodes so that wiki links / strikethrough can be found.
function mergeText(list) {
  const out = [];
  for (const n of list) {
    const prev = out[out.length - 1];
    if (n.type === 'text' && prev && prev.type === 'text' && !prev._strike && !n._strike) {
      prev.literal = prev.literal + n.literal;
    } else {
      out.push(n);
    }
  }
  return out;
}

function wikiPass(list, wikiLinks) {
  const out = [];
  for (const n of list) {
    if (n.type !== 'text' || !n.literal.includes('[[')) {
      out.push(n);
      continue;
    }
    const s = n.literal;
    let last = 0;
    let m;
    WIKI_RE.lastIndex = 0;
    while ((m = WIKI_RE.exec(s))) {
      const inner = m[1];
      const bar = inner.indexOf('|');
      const target = (bar === -1 ? inner : inner.slice(0, bar)).trim();
      const label = bar === -1 ? target : inner.slice(bar + 1).trim();
      const slug = slugify(target);
      if (!slug || !label) continue;
      if (m.index > last) out.push(textNode(s.slice(last, m.index)));
      const link = new Node('link');
      link.destination = `/wiki/${slug}`;
      link.title = '';
      link.wikiClass = wikiLinks.exists(slug) ? 'wikilink' : 'wikilink missing';
      link.appendChild(textNode(label));
      out.push(link);
      last = m.index + m[0].length;
    }
    if (last < s.length) out.push(textNode(s.slice(last)));
  }
  return out;
}

function isMarker(n) {
  return n && n._strike === true;
}

function strikePass(list) {
  // Split text into pieces and "~~" markers.
  let items = [];
  for (const n of list) {
    if (n.type !== 'text' || !n.literal.includes('~~')) {
      items.push(n);
      continue;
    }
    const parts = n.literal.split('~~');
    parts.forEach((p, i) => {
      if (i > 0) {
        const mk = textNode('~~');
        mk._strike = true;
        items.push(mk);
      }
      if (p) items.push(textNode(p));
    });
  }
  if (!items.some(isMarker)) return items;

  const canOpen = (arr, i) => {
    const nx = arr[i + 1];
    if (!nx || isMarker(nx)) return false;
    return !(nx.type === 'text' && /^\s/.test(nx.literal));
  };
  const canClose = (arr, i) => {
    const pv = arr[i - 1];
    if (!pv || isMarker(pv)) return false;
    return !(pv.type === 'text' && /\s$/.test(pv.literal));
  };

  let i = 0;
  while (i < items.length) {
    if (isMarker(items[i]) && canOpen(items, i)) {
      let j = i + 1;
      while (j < items.length && !(isMarker(items[j]) && canClose(items, j))) j++;
      if (j < items.length && j > i + 1) {
        const del = new Node('del');
        for (let k = i + 1; k < j; k++) del.appendChild(items[k]);
        items.splice(i, j - i + 1, del);
      }
    }
    i++;
  }
  items = items.map((n) => {
    if (isMarker(n)) n._strike = false;
    return n;
  });
  return items;
}

function postprocess(doc, wikiLinks) {
  const targets = [];
  const walker = doc.walker();
  let ev;
  while ((ev = walker.next())) {
    if (ev.entering && CONTAINERS.has(ev.node.type)) targets.push(ev.node);
  }
  // Deepest first, so that inner containers are finished before their parents.
  for (let t = targets.length - 1; t >= 0; t--) {
    const node = targets[t];
    let list = mergeText(childrenOf(node));
    if (wikiLinks) list = wikiPass(list, wikiLinks);
    list = mergeText(list);
    list = strikePass(list);
    setChildren(node, list);
  }
  return doc;
}

function parseDocument(markdown, wikiLinks) {
  const parser = new Parser();
  const doc = parser.parse(String(markdown ?? ''));
  return postprocess(doc, wikiLinks);
}

/**
 * Render Markdown to HTML.
 */
export function render(markdown, { headingIds = false, wikiLinks } = {}) {
  const doc = parseDocument(markdown, wikiLinks);
  const renderer = new HtmlRenderer({ headingIds });
  const seen = new Map();
  renderer.slugFor = (node) => slugify(plainText(node), seen);
  return renderer.render(doc);
}

/**
 * Table of contents: [{ level, text, slug }] in document order.
 */
export function toc(markdown) {
  const doc = parseDocument(markdown, { exists: () => false });
  const seen = new Map();
  const out = [];
  const walker = doc.walker();
  let ev;
  while ((ev = walker.next())) {
    if (ev.entering && ev.node.type === 'heading') {
      const text = plainText(ev.node);
      out.push({ level: ev.node.level, text, slug: slugify(text, seen) });
    }
  }
  return out;
}

/**
 * Sorted distinct slugs of the wiki links in a Markdown document (links inside
 * code are not wiki links, so they are not reported).
 */
export function wikiLinkTargets(markdown) {
  const doc = parseDocument(markdown, { exists: () => false });
  const found = new Set();
  const walker = doc.walker();
  let ev;
  while ((ev = walker.next())) {
    if (ev.entering && ev.node.type === 'link' && ev.node.wikiClass) {
      found.add(ev.node.destination.slice('/wiki/'.length));
    }
  }
  return [...found].sort();
}
