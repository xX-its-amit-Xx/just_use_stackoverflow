// Safe Markdown -> HTML renderer.
// Parsing/rendering is done by vendored markdown-it 15.0.3 (MIT, see
// THIRD_PARTY_NOTICES.md). This file is integration glue: safety policy,
// GFM <del>, heading ids, TOC and GitHub-style slugs (slug algorithm adapted
// from github-slugger 2.0.0, ISC).
import MarkdownIt from './vendor/markdown-it/markdown-it.mjs';

// ---- slugify (adapted from github-slugger's BananaSlug.slug / slug) ----
const NON_SLUG = /[^\p{L}\p{M}\p{N}\p{Pc} \-]/gu;

function baseSlug(text) {
  if (typeof text !== 'string') text = String(text ?? '');
  return text.toLowerCase().replace(NON_SLUG, '').replace(/ /g, '-');
}

export function slugify(text, seen) {
  let result = baseSlug(text);
  if (!(seen instanceof Map)) return result;
  const original = result;
  while (seen.has(result)) {
    const n = (seen.get(original) ?? 0) + 1;
    seen.set(original, n);
    result = original + '-' + n;
  }
  seen.set(result, 0);
  return result;
}

// ---- URL safety ----
const BAD_SCHEME = /^(?:javascript|vbscript|file|data):/i;
const GOOD_DATA = /^data:image\/(?:png|gif|jpeg|webp);/i;

function isUnsafeUrl(url) {
  // strip whitespace/control chars browsers ignore inside schemes
  const s = String(url).replace(/[\u0000- \u007f-\u009f]/g, '');
  return BAD_SCHEME.test(s) && !GOOD_DATA.test(s);
}

// ---- plain text of inline tokens ----
function plainText(children) {
  let out = '';
  for (const t of children || []) {
    if (t.type === 'text' || t.type === 'code_inline' || t.type === 'html_inline') out += t.content;
    else if (t.type === 'softbreak' || t.type === 'hardbreak') out += ' ';
    else if (t.type === 'image') out += plainText(t.children);
    else if (t.children) out += plainText(t.children);
  }
  return out;
}

function createMd() {
  const md = new MarkdownIt('default', {
    html: false,
    xhtmlOut: true,
    breaks: false,
    linkify: false,
    typographer: false,
    langPrefix: 'language-',
  });
  // Keep links with unsafe schemes but neutralise their URL to '#'.
  md.validateLink = () => true;
  const normalizeLink = md.normalizeLink.bind(md);
  md.normalizeLink = (url) => (isUnsafeUrl(url) ? '#' : normalizeLink(url));

  // GFM strikethrough renders as <del>.
  md.renderer.rules.s_open = () => '<del>';
  md.renderer.rules.s_close = () => '</del>';

  // Collect headings (+ optional ids) once per document.
  md.core.ruler.push('heading_meta', (state) => {
    const seen = new Map();
    const headings = [];
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      const tok = tokens[i];
      if (tok.type !== 'heading_open') continue;
      const inline = tokens[i + 1];
      const text = inline && inline.type === 'inline' ? plainText(inline.children) : '';
      const slug = slugify(text, seen);
      headings.push({ level: Number(tok.tag.slice(1)), text, slug });
      if (state.env && state.env.headingIds) tok.attrSet('id', slug);
    }
    if (state.env) state.env.headings = headings;
  });
  return md;
}

const md = createMd();

export function render(markdown, { headingIds = false } = {}) {
  const env = { headingIds: !!headingIds };
  return md.render(String(markdown ?? ''), env);
}

export function toc(markdown) {
  const env = { headingIds: false };
  md.parse(String(markdown ?? ''), env);
  return env.headings || [];
}

export default { render, toc, slugify };
