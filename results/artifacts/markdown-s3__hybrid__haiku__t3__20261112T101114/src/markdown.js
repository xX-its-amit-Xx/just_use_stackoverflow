// Markdown renderer: CommonMark (vendored commonmark.js 0.31.2, see
// src/vendor/commonmark/LICENSE) plus GFM tables, ~~strikethrough~~, wiki
// links, heading ids and the wiki's URL/raw-HTML safety rules.
import Parser from './vendor/commonmark/blocks.js';
import HtmlRenderer from './vendor/commonmark/render/html.js';

// ---------- slugs ----------

// GitHub-style slug. `seen` (a Map) makes duplicates unique: foo, foo-1, foo-2, ...
export function slugify(text, seen) {
  const base = String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{Nd} _-]/gu, '')
    .replace(/ /g, '-');
  if (!seen) return base;
  let candidate = base;
  let k = 0;
  while (seen.has(candidate)) {
    k += 1;
    candidate = `${base}-${k}`;
  }
  seen.set(candidate, true);
  return candidate;
}

// ---------- AST helpers ----------

const RAW_INLINE_TYPES = new Set(['text', 'code', 'wikilink', 'html_inline']);

function plainText(node) {
  let out = '';
  const walker = node.walker();
  let ev;
  while ((ev = walker.next())) {
    const n = ev.node;
    if (!ev.entering) continue;
    if (RAW_INLINE_TYPES.has(n.type)) out += n.literal ?? '';
    else if (n.type === 'softbreak' || n.type === 'linebreak') out += ' ';
  }
  return out;
}

// Parse once; assign slugs to headings in document order.
function analyze(markdown, wikiLinks) {
  const doc = new Parser({ wikiLinks }).parse(String(markdown ?? ''));
  const seen = new Map();
  const headings = [];
  const walker = doc.walker();
  let ev;
  while ((ev = walker.next())) {
    if (ev.entering && ev.node.type === 'heading') {
      const text = plainText(ev.node);
      const slug = slugify(text, seen);
      ev.node._slug = slug;
      headings.push({ level: ev.node.level, text: text.trim(), slug });
    }
  }
  return { doc, headings };
}

// ---------- renderer ----------

// Only these schemes are neutralised (see the spec's safety rules).
const UNSAFE_URL = /^\s*(?:javascript|vbscript|file|data):/i;
const SAFE_DATA_URL = /^\s*data:image\/(?:png|gif|jpeg|webp);/i;

function unsafeUrl(url) {
  return UNSAFE_URL.test(url) && !SAFE_DATA_URL.test(url);
}

class WikiRenderer extends HtmlRenderer {
  constructor({ headingIds, wikiLinks }) {
    super({ softbreak: '\n' });
    this.headingIds = headingIds;
    this.wikiLinks = wikiLinks;
    this.tbodyOpen = false;
  }

  // Raw HTML is shown as escaped text, not interpreted.
  html_inline(node) {
    this.out(node.literal);
  }

  html_block(node) {
    this.cr();
    this.tag('p');
    this.out(node.literal.replace(/\n+$/, ''));
    this.tag('/p');
    this.cr();
  }

  link(node, entering) {
    if (entering && unsafeUrl(node.destination)) node.destination = '#';
    super.link(node, entering);
  }

  image(node, entering) {
    if (entering && unsafeUrl(node.destination)) node.destination = '#';
    super.image(node, entering);
  }

  heading(node, entering) {
    const tagname = 'h' + node.level;
    if (entering) {
      this.cr();
      const attrs = [];
      if (this.headingIds) attrs.push(['id', node._slug]);
      this.tag(tagname, attrs);
    } else {
      this.tag('/' + tagname);
      this.cr();
    }
  }

  del(node, entering) {
    this.tag(entering ? 'del' : '/del');
  }

  wikilink(node) {
    const slug = slugify(node._target);
    const exists = this.wikiLinks ? !!this.wikiLinks.exists(slug) : true;
    this.lit(`<a href="/wiki/${slug}" class="wikilink${exists ? '' : ' missing'}">`);
    this.out(node.literal);
    this.lit('</a>');
  }

  table(node, entering) {
    if (entering) {
      this.cr();
      this.lit('<table>\n');
      this.tbodyOpen = false;
    } else {
      if (this.tbodyOpen) this.lit('</tbody>\n');
      this.lit('</table>\n');
    }
  }

  table_row(node, entering) {
    if (entering) {
      if (!node._header && !this.tbodyOpen) {
        this.lit('<tbody>\n');
        this.tbodyOpen = true;
      }
      this.lit(node._header ? '<thead>\n<tr>\n' : '<tr>\n');
    } else {
      this.lit('</tr>\n');
      if (node._header) this.lit('</thead>\n');
    }
  }

  table_cell(node, entering) {
    const tagname = node._header ? 'th' : 'td';
    if (entering) {
      const align = node._align ? ` align="${node._align}"` : '';
      this.lit(`<${tagname}${align}>`);
    } else {
      this.lit(`</${tagname}>\n`);
    }
  }
}

// Render markdown to HTML.
export function render(markdown, { headingIds = false, wikiLinks } = {}) {
  const { doc } = analyze(markdown, wikiLinks);
  return new WikiRenderer({ headingIds, wikiLinks }).render(doc);
}

// Table of contents: [{ level, text, slug }] in document order.
export function toc(markdown, { wikiLinks } = {}) {
  return analyze(markdown, wikiLinks).headings;
}

// Sorted, distinct slugs of the wiki links in the markdown (code excluded).
export function wikiLinkTargets(markdown) {
  const { doc } = analyze(markdown, { exists: () => true });
  const found = new Set();
  const walker = doc.walker();
  let ev;
  while ((ev = walker.next())) {
    if (ev.entering && ev.node.type === 'wikilink') found.add(slugify(ev.node._target));
  }
  return [...found].sort();
}
