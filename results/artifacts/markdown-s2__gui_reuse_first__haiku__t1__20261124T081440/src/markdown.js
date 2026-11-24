// markdown-s2: safe Markdown -> HTML renderer.
//
// Parsing and HTML rendering are done by the vendored markdown-it parser
// (src/vendor/markdown-it, CommonMark 0.31.2 + GFM tables/strikethrough).
// This module adds the project-specific policy and features:
//   - raw HTML is never passed through (html: false => escaped text);
//   - unsafe link/image URL schemes are replaced by `#`;
//   - GitHub-style heading slugs (`headingIds`) and `toc()`.

import MarkdownIt from './vendor/markdown-it/index.mjs';

// ---------------------------------------------------------------------------
// Safety policy (project-written)
// ---------------------------------------------------------------------------

const UNSAFE_SCHEME_RE = /^(?:javascript|vbscript|file|data):/i;
const SAFE_DATA_RE = /^data:image\/(?:png|gif|jpeg|webp);/i;

// Strip ASCII controls/whitespace before checking the scheme, so that tricks
// such as "java\tscript:" are judged by the same rule browsers apply.
function isUnsafeUrl (url) {
  const s = url.replace(/[\u0000- \u007f]/g, '');
  if (!UNSAFE_SCHEME_RE.test(s)) return false;
  return !SAFE_DATA_RE.test(s);
}

function createParser () {
  const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
  // GFM strikethrough is specified as <del> (markdown-it emits <s>).
  md.renderer.rules.s_open = () => '<del>';
  md.renderer.rules.s_close = () => '</del>';
  const normalize = md.normalizeLink;
  // markdown-it normalizes first, then validates. Replacing unsafe URLs with
  // '#' here means validation passes and the link/image is still rendered.
  md.normalizeLink = (url) => {
    const normalized = normalize(url);
    return isUnsafeUrl(normalized) ? '#' : normalized;
  };
  return md;
}

const md = createParser();

// ---------------------------------------------------------------------------
// Slugs and plain text
// ---------------------------------------------------------------------------

/**
 * GitHub-style slug. Lower-cases, removes every character that is not a
 * letter, digit, space, `-` or `_`, then turns spaces into `-`. When a Map of
 * previously seen slugs is given, repeats get `-1`, `-2`, ... suffixes.
 */
export function slugify (text, seen) {
  const base = String(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{Nd} _-]/gu, '')
    .replace(/ /g, '-');
  if (!seen) return base;
  let slug = base;
  let n = 0;
  while (seen.has(slug)) {
    n += 1;
    slug = `${base}-${n}`;
  }
  seen.set(slug, true);
  return slug;
}

// Plain text of an inline token: inline markup removed, text content kept.
function plainText (token) {
  if (!token || !token.children) return '';
  let out = '';
  for (const child of token.children) {
    switch (child.type) {
      case 'text':
      case 'text_special':
      case 'code_inline':
        out += child.content;
        break;
      case 'softbreak':
      case 'hardbreak':
        out += ' ';
        break;
      default:
        if (child.children) out += plainText(child);
        else if (child.content) out += child.content;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render Markdown to HTML. Raw HTML is escaped; unsafe URLs become `#`.
 * With `headingIds: true`, each heading gets `id="<slug>"`.
 */
export function render (markdown, { headingIds = false } = {}) {
  const tokens = md.parse(String(markdown), {});
  if (headingIds) {
    const seen = new Map();
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== 'heading_open') continue;
      const slug = slugify(plainText(tokens[i + 1]), seen);
      tokens[i].attrSet('id', slug);
    }
  }
  return md.renderer.render(tokens, md.options, {});
}

/**
 * Table of contents: every ATX and setext heading, in document order.
 */
export function toc (markdown) {
  const tokens = md.parse(String(markdown), {});
  const seen = new Map();
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type !== 'heading_open') continue;
    const text = plainText(tokens[i + 1]);
    out.push({
      level: Number(t.tag.slice(1)),
      text,
      slug: slugify(text, seen)
    });
  }
  return out;
}
