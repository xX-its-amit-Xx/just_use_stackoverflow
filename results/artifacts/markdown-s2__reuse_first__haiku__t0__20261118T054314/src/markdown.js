// Safe Markdown -> HTML renderer (tier S2).
// Glue layer around the vendored markdown-it parser (see src/vendor, PROVENANCE.json,
// src/THIRD_PARTY_NOTICES.md). Adds: GFM strikethrough as <del>, heading ids/TOC,
// GitHub-style slugs, and a URL policy that replaces dangerous schemes with '#'.
import MarkdownIt from './vendor/markdown-it/markdown-it.mjs';

// ---------- slugs ----------

/**
 * GitHub-style slug. Lower-cases, drops every char that is not a letter, digit,
 * space, '-' or '_', then maps spaces to '-'. When `seen` (a Map) is given,
 * repeated slugs receive -1, -2, ... suffixes.
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
  let n = seen.get(base);
  let candidate;
  do {
    n += 1;
    candidate = `${base}-${n}`;
  } while (seen.has(candidate));
  seen.set(base, n);
  seen.set(candidate, 0);
  return candidate;
}

// ---------- parser setup ----------

const DANGEROUS_SCHEME = /^(javascript|vbscript|file):/i;
const DATA_SCHEME = /^data:/i;
const SAFE_DATA_IMAGE = /^data:image\/(png|gif|jpeg|webp);/i;

function safeUrl(url) {
  // Ignore whitespace/control characters that browsers strip inside schemes.
  const compact = String(url).replace(/[\x00-\x20\x7f]/g, '');
  if (DANGEROUS_SCHEME.test(compact)) return '#';
  if (DATA_SCHEME.test(compact) && !SAFE_DATA_IMAGE.test(compact)) return '#';
  return url;
}

function createParser() {
  // 'commonmark' preset: no raw HTML, CommonMark rules. We keep html disabled
  // (html: false is the default in that preset) so raw HTML is escaped text.
  const md = new MarkdownIt('commonmark', { html: false, linkify: false, typographer: false });
  md.enable(['table', 'strikethrough']);

  // Replace the default scheme check with our own policy: unsafe URLs become '#'
  // rather than dropping the link/image.
  const normalize = md.normalizeLink.bind(md);
  md.normalizeLink = url => safeUrl(normalize(url));
  md.validateLink = () => true;

  // Strikethrough: markdown-it emits <s>; GFM requires <del>.
  md.core.ruler.after('inline', 'gfm_del_tag', state => {
    for (const block of state.tokens) {
      if (block.children) {
        for (const t of block.children) {
          if (t.type === 's_open') t.tag = 'del';
          else if (t.type === 's_close') t.tag = 'del';
        }
      }
    }
  });
  return md;
}

const parser = createParser();

// ---------- headings ----------

function plainText(children) {
  let out = '';
  for (const t of children || []) {
    switch (t.type) {
      case 'text':
      case 'text_special':
      case 'code_inline':
        out += t.content;
        break;
      case 'softbreak':
      case 'hardbreak':
        out += ' ';
        break;
      case 'image':
        out += plainText(t.children);
        break;
      default:
        break; // emphasis/link/strike markers contribute no text
    }
  }
  return out;
}

/** Walk the token stream, collecting heading info and (optionally) assigning ids. */
function collectHeadings(tokens, { assignIds = false } = {}) {
  const seen = new Map();
  const headings = [];
  for (let i = 0; i < tokens.length; i++) {
    const open = tokens[i];
    if (open.type !== 'heading_open') continue;
    const inline = tokens[i + 1];
    const text = inline && inline.type === 'inline' ? plainText(inline.children) : '';
    const level = Number(open.tag.slice(1));
    const slug = slugify(text.trim(), seen);
    headings.push({ level, text: text.trim(), slug });
    if (assignIds) open.attrSet('id', slug);
  }
  return headings;
}

// ---------- public API ----------

export function render(markdown, { headingIds = false } = {}) {
  const env = {};
  const tokens = parser.parse(String(markdown), env);
  if (headingIds) collectHeadings(tokens, { assignIds: true });
  return parser.renderer.render(tokens, parser.options, env);
}

export function toc(markdown) {
  const env = {};
  const tokens = parser.parse(String(markdown), env);
  return collectHeadings(tokens).map(({ level, text, slug }) => ({ level, text, slug }));
}
