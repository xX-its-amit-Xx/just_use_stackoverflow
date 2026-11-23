// Markdown rendering for markdown-s3.
// CommonMark parsing/rendering comes from the vendored commonmark.js code in
// ./vendor/commonmark. This module adds the pieces the spec requires on top:
// GFM pipe tables, ~~strikethrough~~, wiki links, GitHub-style heading slugs,
// escaped raw HTML and the URL safety rules.
import Parser from "./vendor/commonmark/blocks.js";
import Node from "./vendor/commonmark/node.js";
import HtmlRenderer from "./vendor/commonmark/render/html.js";

const TOKEN_OPEN = "";
const TOKEN_CLOSE = "";

/**
 * GitHub-style slug. Lower-cases, drops every character that is not a letter,
 * digit, space, `-` or `_`, and turns spaces into `-`. With a `seen` Map,
 * duplicates get `-1`, `-2`, ...
 */
export function slugify(text, seen) {
  const base = String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");
  if (!seen) return base;
  let slug = base;
  let i = 1;
  while (seen.has(slug)) slug = `${base}-${i++}`;
  seen.set(slug, true);
  return slug;
}

const escapeHtml = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------------------------------------------------------------- tables

const RE_DELIMITER = /^\s{0,3}\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;
const RE_FENCE = /^\s{0,3}(`{3,}|~{3,})/;

// Split a GFM table row into trimmed cells; `\|` stays escaped inside a cell.
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") {
      cur += "\\|";
      i++;
    } else if (c === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }
  }
  cells.push(cur.trim());
  return cells;
}

function alignOf(cell) {
  const l = cell.startsWith(":");
  const r = cell.endsWith(":");
  if (l && r) return "center";
  if (r) return "right";
  if (l) return "left";
  return null;
}

// Find top-level GFM tables. Each table is replaced by a placeholder line so
// that it becomes its own paragraph; the placeholder is swapped for the table
// HTML after rendering. Fenced code is skipped.
function extractTables(source) {
  const lines = source.split(/\r\n|\r|\n/);
  const out = [];
  const tables = [];
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const f = RE_FENCE.exec(line);
    if (fence) {
      out.push(line);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      continue;
    }
    if (f) {
      fence = f[1];
      out.push(line);
      continue;
    }
    const next = lines[i + 1];
    if (
      line.includes("|") &&
      !/^\s{4,}|^\t/.test(line) &&
      next !== undefined &&
      next.includes("|") &&
      RE_DELIMITER.test(next)
    ) {
      const header = splitRow(line);
      const delim = splitRow(next);
      if (header.length === delim.length) {
        const rows = [];
        let j = i + 2;
        while (j < lines.length && lines[j].trim() !== "" && !RE_FENCE.test(lines[j])) {
          rows.push(splitRow(lines[j]));
          j++;
        }
        tables.push({ header, align: delim.map(alignOf), rows });
        out.push("", TOKEN_OPEN + (tables.length - 1) + TOKEN_CLOSE, "");
        i = j - 1;
        continue;
      }
    }
    out.push(line);
  }
  return { source: out.join("\n"), tables };
}

// ---------------------------------------------------------------- AST passes

function plainText(node) {
  let s = "";
  const walker = node.walker();
  let ev;
  while ((ev = walker.next())) {
    const n = ev.node;
    if (!ev.entering) continue;
    if (n.type === "text" || n.type === "code") s += n.literal;
    else if (n.type === "softbreak" || n.type === "linebreak") s += " ";
  }
  return s;
}

function textNode(literal) {
  const t = new Node("text");
  t.literal = literal;
  return t;
}

function mergeText(doc) {
  const texts = [];
  const walker = doc.walker();
  let ev;
  while ((ev = walker.next())) if (ev.entering && ev.node.type === "text") texts.push(ev.node);
  for (const t of texts) {
    if (!t.parent) continue;
    while (t.next && t.next.type === "text") {
      t.literal += t.next.literal;
      t.next.unlink();
    }
  }
}

const RE_INLINE = /\[\[([^\[\]\n]+?)\]\]|~~(?=\S)([\s\S]*?\S)~~/g;

// Replace [[wiki]] links and ~~strike~~ runs found in text nodes. Text nodes
// inside code spans/blocks are never visited, so those stay untouched.
function transformInline(doc, ctx) {
  const texts = [];
  const walker = doc.walker();
  let ev;
  while ((ev = walker.next())) if (ev.entering && ev.node.type === "text") texts.push(ev.node);
  for (const t of texts) {
    if (!t.parent) continue;
    const literal = t.literal;
    RE_INLINE.lastIndex = 0;
    if (!RE_INLINE.test(literal)) continue;
    RE_INLINE.lastIndex = 0;
    if (insideLink(t)) continue;
    const pieces = [];
    let last = 0;
    let m;
    while ((m = RE_INLINE.exec(literal))) {
      if (m[1] !== undefined) {
        const parts = m[1].split("|");
        const target = parts[0].trim();
        const label = parts.length > 1 ? parts.slice(1).join("|").trim() : target;
        const slug = slugify(target);
        if (!ctx.wikiLinks || !slug || !label) continue; // stays plain text
        pieces.push(...[literal.slice(last, m.index)].filter(Boolean).map(textNode));
        const exists = ctx.wikiLinks.exists(slug);
        ctx.links.add(slug);
        const c = new Node("custom_inline");
        c.onEnter = `<a href="/wiki/${slug}" class="${exists ? "wikilink" : "wikilink missing"}">`;
        c.onExit = "</a>";
        c.appendChild(textNode(label));
        pieces.push(c);
      } else {
        pieces.push(...[literal.slice(last, m.index)].filter(Boolean).map(textNode));
        const c = new Node("custom_inline");
        c.onEnter = "<del>";
        c.onExit = "</del>";
        c.appendChild(textNode(m[2]));
        pieces.push(c);
      }
      last = m.index + m[0].length;
    }
    if (pieces.length === 0) continue;
    if (last < literal.length) pieces.push(textNode(literal.slice(last)));
    for (const p of pieces) t.insertBefore(p);
    t.unlink();
  }
}

function insideLink(node) {
  for (let p = node.parent; p; p = p.parent) if (p.type === "link" || p.type === "image") return true;
  return false;
}

// ---------------------------------------------------------------- rendering

const RE_UNSAFE = /^\s*(?:javascript|vbscript|file|data):/i;
const RE_SAFE_DATA = /^\s*data:image\/(?:png|gif|jpeg|webp);/i;
const isUnsafeUrl = (url) => RE_UNSAFE.test(url) && !RE_SAFE_DATA.test(url);

function makeRenderer({ headingIds }) {
  const r = new HtmlRenderer({ softbreak: "\n" });
  r.link = function (node, entering) {
    if (entering) {
      const attrs = [["href", isUnsafeUrl(node.destination) ? "#" : this.esc(node.destination)]];
      if (node.title) attrs.push(["title", this.esc(node.title)]);
      this.tag("a", attrs);
    } else {
      this.tag("/a");
    }
  };
  r.image = function (node, entering) {
    if (entering) {
      if (this.disableTags === 0) {
        const src = isUnsafeUrl(node.destination) ? "#" : this.esc(node.destination);
        this.lit('<img src="' + src + '" alt="');
      }
      this.disableTags += 1;
    } else {
      this.disableTags -= 1;
      if (this.disableTags === 0) {
        if (node.title) this.lit('" title="' + this.esc(node.title));
        this.lit('" />');
      }
    }
  };
  r.heading = function (node, entering) {
    const tag = "h" + node.level;
    if (entering) {
      this.cr();
      this.tag(tag, headingIds ? [["id", node._slug]] : []);
    } else {
      this.tag("/" + tag);
      this.cr();
    }
  };
  // Raw HTML is shown as escaped text, never as markup.
  r.html_inline = function (node) {
    if (!this.disableTags) this.out(node.literal);
  };
  r.html_block = function (node) {
    this.cr();
    this.tag("p");
    this.out(node.literal.replace(/\n+$/, ""));
    this.tag("/p");
    this.cr();
  };
  return r;
}

// Core pipeline. ctx = { wikiLinks, links:Set, headings:[] }.
function run(markdown, ctx, { headingIds, tables: allowTables = true }) {
  let source = String(markdown);
  let tables = [];
  if (allowTables) ({ source, tables } = extractTables(source));
  const doc = new Parser({}).parse(source);
  mergeText(doc);
  transformInline(doc, ctx);

  const seen = new Map();
  const walker = doc.walker();
  let ev;
  while ((ev = walker.next())) {
    const n = ev.node;
    if (ev.entering && n.type === "heading") {
      const text = plainText(n);
      n._slug = slugify(text, seen);
      ctx.headings.push({ level: n.level, text, slug: n._slug });
    }
  }

  let html = makeRenderer({ headingIds }).render(doc);
  if (tables.length) {
    html = html.replace(/<p>(\d+)<\/p>\n?/g, (_, i) => renderTable(tables[Number(i)], ctx));
  }
  return html;
}

function renderFragment(text, ctx) {
  const html = run(text, ctx, { headingIds: false, tables: false });
  return html.replace(/^<p>([\s\S]*)<\/p>\n?$/, "$1");
}

function renderTable(t, ctx) {
  const cols = t.header.length;
  let h = "<table>\n<thead>\n<tr>\n";
  t.header.forEach((c, i) => {
    const al = t.align[i] ? ` align="${t.align[i]}"` : "";
    h += `<th${al}>${renderFragment(c, ctx)}</th>\n`;
  });
  h += "</tr>\n</thead>\n";
  if (t.rows.length) {
    h += "<tbody>\n";
    for (const row of t.rows) {
      h += "<tr>\n";
      for (let i = 0; i < cols; i++) {
        const al = t.align[i] ? ` align="${t.align[i]}"` : "";
        h += `<td${al}>${row[i] !== undefined ? renderFragment(row[i], ctx) : ""}</td>\n`;
      }
      h += "</tr>\n";
    }
    h += "</tbody>\n";
  }
  return h + "</table>\n";
}

function newCtx(wikiLinks) {
  return { wikiLinks, links: new Set(), headings: [] };
}

/**
 * Render markdown to HTML.
 * @param {string} markdown
 * @param {{headingIds?: boolean, wikiLinks?: {exists(slug: string): boolean}}} [options]
 */
export function render(markdown, { headingIds = false, wikiLinks } = {}) {
  return run(markdown, newCtx(wikiLinks), { headingIds });
}

/** Table of contents: [{ level, text, slug }] in document order. */
export function toc(markdown) {
  const ctx = newCtx(undefined);
  run(markdown, ctx, { headingIds: false });
  return ctx.headings;
}

/**
 * Everything the page endpoints need in one pass:
 * { html (heading ids + wiki links), toc, links (sorted distinct wiki-link slugs) }.
 */
export function analyze(markdown, { wikiLinks } = {}) {
  const ctx = newCtx(wikiLinks ?? { exists: () => false });
  const html = run(markdown, ctx, { headingIds: true });
  return { html, toc: ctx.headings, links: [...ctx.links].sort() };
}

/** Sorted distinct slugs targeted by wiki links in `markdown` (outside code). */
export function wikiLinkTargets(markdown) {
  return analyze(markdown).links;
}
