// Markdown renderer: vendored markdown-it (MIT, see THIRD_PARTY_NOTICES.md)
// configured for CommonMark + GFM tables/strikethrough, with safety, heading
// ids, TOC and wiki-link extensions added as glue code.
import MarkdownIt from './vendor/markdown-it.mjs';

// ---- slugs (algorithm adapted from github-slugger, ISC) ----
export function slugify(text, seen) {
  const original = String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-');
  if (!(seen instanceof Map)) return original;
  let result = original;
  while (seen.has(result)) {
    const n = (seen.get(original) ?? 0) + 1;
    seen.set(original, n);
    result = original + '-' + n;
  }
  seen.set(result, 0);
  return result;
}

// ---- URL safety ----
const BAD_SCHEME = /^(javascript|vbscript|file|data):/i;
const SAFE_DATA = /^data:image\/(png|gif|jpeg|webp);/i;
export function safeUrl(url) {
  // strip control chars / whitespace that browsers ignore when parsing schemes
  let probe = String(url);
  try { probe = decodeURIComponent(probe); } catch { /* keep raw */ }
  probe = probe.replace(/[\u0000- \u007f]/g, '');
  if (BAD_SCHEME.test(probe) && !SAFE_DATA.test(probe)) return '#';
  return url;
}

// ---- wiki-link inline rule ----
function wikiLinkRule(state, silent) {
  const env = state.env || {};
  if (!env.__wiki) return false;
  const src = state.src;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x5B || src.charCodeAt(start + 1) !== 0x5B) return false;
  const end = src.indexOf(']]', start + 2);
  if (end < 0) return false;
  const inner = src.slice(start + 2, end);
  if (!inner.trim() || /[\[\]\n]/.test(inner)) return false;
  const bar = inner.indexOf('|');
  const target = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
  const label = (bar >= 0 ? inner.slice(bar + 1) : inner).trim();
  if (!target) return false;
  const slug = slugify(target);
  if (!slug) return false;
  if (!silent) {
    let exists = false;
    try { exists = !!env.__wiki.exists(slug); } catch { exists = false; }
    const open = state.push('link_open', 'a', 1);
    open.attrs = [['href', '/wiki/' + slug], ['class', exists ? 'wikilink' : 'wikilink missing']];
    open.markup = 'wikilink';
    open.info = 'wikilink';
    const t = state.push('text', '', 0);
    t.content = label || target;
    state.push('link_close', 'a', -1);
  }
  state.pos = end + 2;
  return true;
}

function inlineText(token) {
  if (!token || !token.children) return token ? token.content : '';
  let out = '';
  for (const c of token.children) {
    if (c.type === 'text' || c.type === 'code_inline') out += c.content;
    else if (c.type === 'image') out += inlineText(c);
    else if (c.type === 'softbreak' || c.type === 'hardbreak') out += ' ';
  }
  return out;
}

function headingIdsRule(state) {
  if (!state.env || !state.env.__headingIds) return;
  const seen = new Map();
  const tokens = state.tokens;
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type === 'heading_open') {
      tokens[i].attrSet('id', slugify(inlineText(tokens[i + 1]), seen));
    }
  }
}

function createMd() {
  const md = new MarkdownIt('commonmark', { html: false });
  md.enable(['table', 'strikethrough']);
  md.validateLink = () => true; // we sanitise in the renderer instead
  md.inline.ruler.before('link', 'wikilink', wikiLinkRule);
  md.core.ruler.push('heading_ids', headingIdsRule);
  const r = md.renderer.rules;
  r.s_open = () => '<del>';
  r.s_close = () => '</del>';
  const defaultLinkOpen = r.link_open || ((tokens, idx, opts, env, self) => self.renderToken(tokens, idx, opts));
  r.link_open = (tokens, idx, opts, env, self) => {
    const t = tokens[idx];
    const href = t.attrGet('href');
    if (href != null) t.attrSet('href', safeUrl(href));
    return defaultLinkOpen(tokens, idx, opts, env, self);
  };
  const defaultImage = r.image;
  r.image = (tokens, idx, opts, env, self) => {
    const t = tokens[idx];
    const src = t.attrGet('src');
    if (src != null) t.attrSet('src', safeUrl(src));
    return defaultImage(tokens, idx, opts, env, self);
  };
  return md;
}

const md = createMd();

export function render(markdown, { headingIds = false, wikiLinks } = {}) {
  const env = { __headingIds: !!headingIds, __wiki: wikiLinks && typeof wikiLinks.exists === 'function' ? wikiLinks : null };
  return md.render(String(markdown ?? ''), env);
}

export function toc(markdown) {
  const tokens = md.parse(String(markdown ?? ''), {});
  const seen = new Map();
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type === 'heading_open') {
      const text = inlineText(tokens[i + 1]);
      out.push({ level: Number(tokens[i].tag.slice(1)), text, slug: slugify(text, seen) });
    }
  }
  return out;
}

// Returns sorted distinct slugs of wiki links (ignoring code spans/blocks).
export function wikiLinks(markdown) {
  const env = { __wiki: { exists: () => true } };
  const tokens = md.parse(String(markdown ?? ''), env);
  const set = new Set();
  const walk = (list) => {
    for (const t of list) {
      if (t.type === 'link_open' && t.info === 'wikilink') set.add(t.attrGet('href').slice(6));
      if (t.children) walk(t.children);
    }
  };
  walk(tokens);
  return [...set].sort();
}
