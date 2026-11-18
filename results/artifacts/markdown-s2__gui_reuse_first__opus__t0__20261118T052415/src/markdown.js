// Safe Markdown -> HTML renderer built on a vendored, patched copy of
// commonmark.js 0.31.2 (see src/THIRD_PARTY_NOTICES.md and PROVENANCE.json).
import commonmark from './vendor/commonmark.cjs';

const { Parser, HtmlRenderer } = commonmark;

const reUnsafeScheme = /^(?:javascript|vbscript|file|data):/i;
const reSafeData = /^data:image\/(?:png|gif|jpeg|webp);/i;

function safeUrl(url) {
  const probe = String(url || '').replace(/[\u0000- \u007f]/g, '');
  if (reUnsafeScheme.test(probe) && !reSafeData.test(probe)) return '#';
  return url;
}

export function slugify(text, seen) {
  const base = String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N} _-]/gu, '')
    .replace(/ /g, '-');
  if (!(seen instanceof Map)) return base;
  let slug = base;
  if (seen.has(base)) {
    let n = seen.get(base);
    do {
      n++;
      slug = `${base}-${n}`;
    } while (seen.has(slug));
    seen.set(base, n);
  }
  seen.set(slug, 0);
  return slug;
}

function plainText(node) {
  let out = '';
  const walker = node.walker();
  let ev;
  while ((ev = walker.next())) {
    const n = ev.node;
    if (!ev.entering) continue;
    switch (n.type) {
      case 'text':
      case 'code':
        out += n.literal;
        break;
      case 'softbreak':
      case 'linebreak':
        out += ' ';
        break;
      default:
        break;
    }
  }
  return out.trim();
}

function parse(markdown) {
  const parser = new Parser();
  return parser.parse(String(markdown ?? '').replace(/\r\n?/g, '\n'));
}

function headingsOf(doc) {
  const out = [];
  const seen = new Map();
  const walker = doc.walker();
  let ev;
  while ((ev = walker.next())) {
    if (ev.entering && ev.node.type === 'heading') {
      const text = plainText(ev.node);
      const slug = slugify(text, seen);
      out.push({ node: ev.node, level: ev.node.level, text, slug });
    }
  }
  return out;
}

class SafeHtmlRenderer extends HtmlRenderer {
  constructor(options = {}) {
    super(options);
    this.headingSlugs = options.headingSlugs || null;
  }

  heading(node, entering) {
    const tagname = 'h' + node.level;
    const attrs = this.attrs(node);
    if (entering) {
      if (this.headingSlugs && this.headingSlugs.has(node)) {
        attrs.push(['id', this.esc(this.headingSlugs.get(node))]);
      }
      this.cr();
      this.tag(tagname, attrs);
    } else {
      this.tag('/' + tagname);
      this.cr();
    }
  }

  link(node, entering) {
    const attrs = this.attrs(node);
    if (entering) {
      attrs.push(['href', this.esc(safeUrl(node.destination))]);
      if (node.title) attrs.push(['title', this.esc(node.title)]);
      this.tag('a', attrs);
    } else {
      this.tag('/a');
    }
  }

  image(node, entering) {
    if (entering) {
      if (this.disableTags === 0) {
        this.lit('<img src="' + this.esc(safeUrl(node.destination)) + '" alt="');
      }
      this.disableTags += 1;
    } else {
      this.disableTags -= 1;
      if (this.disableTags === 0) {
        if (node.title) this.lit('" title="' + this.esc(node.title));
        this.lit('" />');
      }
    }
  }

  html_inline(node) {
    this.out(node.literal);
  }

  html_block(node) {
    this.cr();
    this.tag('p');
    this.out(node.literal);
    this.tag('/p');
    this.cr();
  }

  del(node, entering) {
    this.tag(entering ? 'del' : '/del');
  }

  table(node, entering) {
    this.cr();
    this.tag(entering ? 'table' : '/table');
    this.cr();
  }

  table_head(node, entering) {
    this.cr();
    this.tag(entering ? 'thead' : '/thead');
    this.cr();
  }

  table_body(node, entering) {
    this.cr();
    this.tag(entering ? 'tbody' : '/tbody');
    this.cr();
  }

  table_row(node, entering) {
    this.cr();
    this.tag(entering ? 'tr' : '/tr');
    this.cr();
  }

  table_cell(node, entering) {
    const name = node.isHeader ? 'th' : 'td';
    if (entering) {
      const attrs = [];
      if (node.align) attrs.push(['align', node.align]);
      this.cr();
      this.tag(name, attrs);
    } else {
      this.tag('/' + name);
      this.cr();
    }
  }
}

export function render(markdown, { headingIds = false } = {}) {
  const doc = parse(markdown);
  let headingSlugs = null;
  if (headingIds) {
    headingSlugs = new Map(headingsOf(doc).map((h) => [h.node, h.slug]));
  }
  const renderer = new SafeHtmlRenderer({ headingSlugs });
  return renderer.render(doc);
}

export function toc(markdown) {
  return headingsOf(parse(markdown)).map(({ level, text, slug }) => ({ level, text, slug }));
}

export default { render, toc, slugify };
