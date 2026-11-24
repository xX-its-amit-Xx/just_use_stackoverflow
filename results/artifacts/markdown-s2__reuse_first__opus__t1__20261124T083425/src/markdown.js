// Safe Markdown -> HTML renderer. Parsing/rendering is done by the vendored
// markdown-it 15.0.3 (MIT, see THIRD_PARTY_NOTICES.md); this file is glue:
// safety configuration, URL sanitizing, heading ids, TOC and slugify.
import MarkdownIt from './vendor/markdown-it/markdown-it.mjs';
import gfmStrikethrough from './gfm-strikethrough.js';

const BAD_PROTO_RE = /^(vbscript|javascript|file|data):/;
const GOOD_DATA_RE = /^data:image\/(gif|png|jpeg|webp);/;

function isUnsafeUrl(url) {
  // Normalize like browsers do: strip control chars/whitespace, decode entities already done by parser.
  const str = String(url).replace(/[\u0000- \u007f]/g, '').toLowerCase();
  return BAD_PROTO_RE.test(str) && !GOOD_DATA_RE.test(str);
}

function createParser() {
  const md = new MarkdownIt('default', {
    html: false,        // raw HTML is rendered as escaped text
    xhtmlOut: true,
    breaks: false,
    linkify: false,
    typographer: false,
  });
  // Keep links with unsafe schemes but neutralise their target to '#'.
  md.use(gfmStrikethrough);
  md.validateLink = () => true;
  const origNormalize = md.normalizeLink.bind(md);
  md.normalizeLink = (url) => (isUnsafeUrl(url) ? '#' : origNormalize(url));
  return md;
}

const md = createParser();

// Adapted from github-slugger (ISC): lower-case, strip disallowed chars,
// spaces -> '-', de-duplicate with -1, -2, ... suffixes.
export function slugify(text, seen) {
  const base = String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-');
  if (!(seen instanceof Map)) return base;
  let slug = base;
  if (seen.has(slug)) {
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

function inlinePlainText(tokens) {
  let out = '';
  for (const t of tokens || []) {
    switch (t.type) {
      case 'text':
      case 'code_inline':
        out += t.content;
        break;
      case 'softbreak':
      case 'hardbreak':
        out += ' ';
        break;
      case 'image':
        out += inlinePlainText(t.children);
        break;
      default:
        if (t.children) out += inlinePlainText(t.children);
    }
  }
  return out;
}

function headings(tokens) {
  const result = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'heading_open') continue;
    const inline = tokens[i + 1];
    const text = inline && inline.type === 'inline' ? inlinePlainText(inline.children) : '';
    result.push({ index: i, level: Number(t.tag.slice(1)), text });
  }
  return result;
}

export function render(markdown, { headingIds = false } = {}) {
  const env = {};
  const tokens = md.parse(String(markdown ?? ''), env);
  if (headingIds) {
    const seen = new Map();
    for (const h of headings(tokens)) {
      tokens[h.index].attrSet('id', slugify(h.text, seen));
    }
  }
  return md.renderer.render(tokens, md.options, env);
}

export function toc(markdown) {
  const tokens = md.parse(String(markdown ?? ''), {});
  const seen = new Map();
  return headings(tokens).map(({ level, text }) => ({ level, text, slug: slugify(text, seen) }));
}

export default { render, toc, slugify };
