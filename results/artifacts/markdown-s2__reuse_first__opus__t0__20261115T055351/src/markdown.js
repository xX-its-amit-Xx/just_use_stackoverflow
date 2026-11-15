// Safe Markdown -> HTML renderer. Integration glue around vendored markdown-it
// (MIT, see THIRD_PARTY_NOTICES.md).
import MarkdownIt from './vendor/markdown-it/index.mjs';

const BAD_PROTO = /^(vbscript|javascript|file|data):/;
const GOOD_DATA = /^data:image\/(gif|png|jpeg|webp);/;

function isUnsafeUrl(url) {
  // Normalise the way browsers do: strip whitespace/control chars, lower-case.
  const s = String(url).replace(/[\u0000- \u007f]/g, '').toLowerCase();
  return BAD_PROTO.test(s) && !GOOD_DATA.test(s);
}

function createParser() {
  const md = new MarkdownIt('default', {
    html: false, xhtmlOut: true, breaks: false, linkify: false, typographer: false,
  });
  // Accept every URL syntactically; unsafe ones are rewritten to '#'.
  md.validateLink = () => true;
  const origNormalize = md.normalizeLink.bind(md);
  md.normalizeLink = (url) => (isUnsafeUrl(url) ? '#' : origNormalize(url));
  // GFM strikethrough renders as <del>.
  md.renderer.rules.s_open = () => '<del>';
  md.renderer.rules.s_close = () => '</del>';
  return md;
}

const md = createParser();

export function slugify(text, seen) {
  let slug = String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N} \-_]/gu, '')
    .replace(/ /g, '-');
  if (seen instanceof Map) {
    if (seen.has(slug)) {
      let n = seen.get(slug);
      let candidate;
      do { n += 1; candidate = `${slug}-${n}`; } while (seen.has(candidate));
      seen.set(slug, n);
      seen.set(candidate, 0);
      slug = candidate;
    } else {
      seen.set(slug, 0);
    }
  }
  return slug;
}

function plainText(tokens) {
  let out = '';
  for (const t of tokens || []) {
    if (t.type === 'text' || t.type === 'code_inline' || t.type === 'html_inline') out += t.content;
    else if (t.type === 'softbreak' || t.type === 'hardbreak') out += ' ';
    else if (t.type === 'image') out += plainText(t.children);
    else if (t.children) out += plainText(t.children);
  }
  return out;
}

function headings(tokens, cb) {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'heading_open') cb(t, tokens[i + 1], Number(t.tag.slice(1)));
  }
}

export function render(markdown, { headingIds = false } = {}) {
  const env = {};
  const tokens = md.parse(String(markdown ?? ''), env);
  if (headingIds) {
    const seen = new Map();
    headings(tokens, (open, inline) => {
      open.attrSet('id', slugify(plainText(inline && inline.children), seen));
    });
  }
  return md.renderer.render(tokens, md.options, env);
}

export function toc(markdown) {
  const tokens = md.parse(String(markdown ?? ''), {});
  const seen = new Map();
  const out = [];
  headings(tokens, (open, inline, level) => {
    const text = plainText(inline && inline.children);
    out.push({ level, text, slug: slugify(text, seen) });
  });
  return out;
}

export default { render, toc, slugify };
