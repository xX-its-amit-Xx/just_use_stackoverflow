// Markdown renderer built on vendored markdown-it 14.1.0 (MIT, see THIRD_PARTY_NOTICES.md).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const markdownit = require('./vendor/markdown-it.cjs');

const md = markdownit('default', { html: false, linkify: false, typographer: false, breaks: false });

// ---- URL safety -----------------------------------------------------------
const BAD_PROTO = /^(vbscript|javascript|file|data):/;
const GOOD_DATA = /^data:image\/(gif|png|jpeg|webp);/;
export function isUnsafeUrl(url) {
  const s = String(url).trim().toLowerCase().replace(/[\u0000-\u001f\s]+/g, '');
  return BAD_PROTO.test(s) && !GOOD_DATA.test(s);
}
const origNormalizeLink = md.normalizeLink.bind(md);
md.validateLink = () => true;
md.normalizeLink = (url) => (isUnsafeUrl(url) ? '#' : origNormalizeLink(url));

// ---- strikethrough as <del> -----------------------------------------------
md.renderer.rules.s_open = () => '<del>';
md.renderer.rules.s_close = () => '</del>';

// ---- slugs ----------------------------------------------------------------
export function slugify(text, seen) {
  let base = String(text ?? '')
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

function inlineText(tokens) {
  let out = '';
  for (const t of tokens || []) {
    if (t.type === 'text' || t.type === 'code_inline') out += t.content;
    else if (t.type === 'softbreak' || t.type === 'hardbreak') out += ' ';
    else if (t.type === 'image') out += inlineText(t.children);
    else if (t.type === 'wikilink') out += t.meta.label;
  }
  return out;
}

// ---- wiki links -----------------------------------------------------------
function wikilinkRule(state, silent) {
  const src = state.src;
  const start = state.pos;
  if (!state.env || !state.env.wikiLinks) return false;
  if (src.charCodeAt(start) !== 0x5b || src.charCodeAt(start + 1) !== 0x5b) return false;
  const end = src.indexOf(']]', start + 2);
  if (end < 0) return false;
  const inner = src.slice(start + 2, end);
  if (!inner || /[\[\]\n]/.test(inner)) return false;
  const bar = inner.indexOf('|');
  const target = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
  const label = (bar >= 0 ? inner.slice(bar + 1) : inner).trim();
  if (!target) return false;
  const slug = slugify(target);
  if (!slug) return false;
  if (!silent) {
    const tok = state.push('wikilink', '', 0);
    tok.meta = { target, label: label || target, slug };
  }
  state.pos = end + 2;
  return true;
}
md.inline.ruler.before('link', 'wikilink', wikilinkRule);

md.renderer.rules.wikilink = (tokens, idx, options, env) => {
  const { slug, label } = tokens[idx].meta;
  let exists = true;
  try {
    exists = !!env.wikiLinks.exists(slug);
  } catch {
    exists = false;
  }
  const esc = md.utils.escapeHtml;
  return `<a href="/wiki/${esc(encodeURI(slug))}" class="wikilink${exists ? '' : ' missing'}">${esc(label)}</a>`;
};

// ---- headings -------------------------------------------------------------
function annotateHeadings(tokens) {
  const seen = new Map();
  const list = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'heading_open') {
      const inline = tokens[i + 1];
      const text = inlineText(inline && inline.children);
      const slug = slugify(text, seen);
      t.meta = { ...(t.meta || {}), slug };
      list.push({ level: Number(t.tag.slice(1)), text, slug });
    }
  }
  return list;
}

const defaultHeadingOpen = (tokens, idx, options, env, self) => self.renderToken(tokens, idx, options);
md.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
  const t = tokens[idx];
  if (env && env.headingIds && t.meta && t.meta.slug !== undefined) {
    return `<${t.tag} id="${md.utils.escapeHtml(t.meta.slug)}">`;
  }
  return defaultHeadingOpen(tokens, idx, options, env, self);
};

// ---- public API -----------------------------------------------------------
export function render(markdown, { headingIds = false, wikiLinks } = {}) {
  const env = { headingIds, wikiLinks: wikiLinks || null };
  const tokens = md.parse(String(markdown ?? ''), env);
  annotateHeadings(tokens);
  return md.renderer.render(tokens, md.options, env);
}

export function toc(markdown) {
  const tokens = md.parse(String(markdown ?? ''), { wikiLinks: { exists: () => true } });
  return annotateHeadings(tokens);
}

/** Distinct, sorted target slugs of wiki links in the markdown (code excluded). */
export function wikiLinkTargets(markdown) {
  const tokens = md.parse(String(markdown ?? ''), { wikiLinks: { exists: () => true } });
  const set = new Set();
  const walk = (list) => {
    for (const t of list || []) {
      if (t.type === 'wikilink') set.add(t.meta.slug);
      if (t.children) walk(t.children);
    }
  };
  walk(tokens);
  return [...set].sort();
}
