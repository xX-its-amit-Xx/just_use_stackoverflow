// Markdown renderer: CommonMark + GFM tables/strikethrough, built on vendored markdown-it.
import markdownit from './vendor/markdown-it.mjs';

export function slugify(text, seen) {
  const base = String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N} _-]/gu, '')
    .replace(/ /g, '-');
  if (!(seen instanceof Map)) return base;
  let result = base;
  if (seen.has(result)) {
    let n = seen.get(base) ?? 0;
    do {
      n++;
      result = `${base}-${n}`;
    } while (seen.has(result));
    seen.set(base, n);
  }
  seen.set(result, 0);
  return result;
}

const UNSAFE_SCHEME = /^(javascript|vbscript|file|data):/i;
const SAFE_DATA = /^data:image\/(png|gif|jpeg|webp);/i;

function safeUrl(url) {
  // strip whitespace/control chars that browsers ignore when checking scheme
  let probe = String(url).replace(/[\u0000- \u007f]/g, '');
  try { probe = decodeURIComponent(probe); } catch { /* keep raw */ }
  probe = probe.replace(/[\u0000- \u007f]/g, '');
  if (UNSAFE_SCHEME.test(probe) && !SAFE_DATA.test(probe)) return '#';
  return url;
}

function inlineText(tokens) {
  let out = '';
  for (const t of tokens || []) {
    if (t.type === 'text' || t.type === 'code_inline') out += t.content;
    else if (t.type === 'softbreak' || t.type === 'hardbreak') out += ' ';
    else if (t.type === 'image') out += inlineText(t.children);
    else if (t.children) out += inlineText(t.children);
  }
  return out;
}

function wikiLinkRule(state, silent) {
  const src = state.src;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x5b || src.charCodeAt(start + 1) !== 0x5b) return false;
  const end = src.indexOf(']]', start + 2);
  if (end < 0) return false;
  const inner = src.slice(start + 2, end);
  if (!inner.trim() || /[\[\]\n]/.test(inner)) return false;
  const bar = inner.indexOf('|');
  const target = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
  const label = (bar >= 0 ? inner.slice(bar + 1) : inner).trim() || target;
  const slug = slugify(target);
  if (!slug) return false;
  if (!silent) {
    const wl = state.md.__wikiLinks;
    const exists = wl && typeof wl.exists === 'function' ? !!wl.exists(slug) : true;
    const open = state.push('link_open', 'a', 1);
    open.attrs = [['href', `/wiki/${slug}`], ['class', exists ? 'wikilink' : 'wikilink missing']];
    open.markup = 'wikilink';
    open.info = 'wikilink';
    open.meta = { wikiSlug: slug };
    const txt = state.push('text', '', 0);
    txt.content = label;
    const close = state.push('link_close', 'a', -1);
    close.markup = 'wikilink';
  }
  state.pos = end + 2;
  return true;
}

function makeParser(withWiki) {
  const md = markdownit({ html: false, linkify: false, typographer: false, xhtmlOut: false, breaks: false });
  md.validateLink = () => true;
  md.renderer.rules.s_open = () => '<del>';
  md.renderer.rules.s_close = () => '</del>';
  if (withWiki) md.inline.ruler.before('link', 'wikilink', wikiLinkRule);
  md.core.ruler.push('safe_urls', (state) => {
    const walk = (tokens) => {
      for (const t of tokens) {
        if (t.type === 'link_open' && t.markup !== 'wikilink') {
          const h = t.attrGet('href');
          if (h != null) t.attrSet('href', safeUrl(h));
        } else if (t.type === 'image') {
          const s = t.attrGet('src');
          if (s != null) t.attrSet('src', safeUrl(s));
        }
        if (t.children) walk(t.children);
      }
    };
    walk(state.tokens);
  });
  md.core.ruler.push('heading_ids', (state) => {
    if (!state.env.headingIds && !state.env.collectToc) return;
    const seen = new Map();
    const toks = state.tokens;
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].type !== 'heading_open') continue;
      const text = inlineText(toks[i + 1] && toks[i + 1].children);
      const slug = slugify(text, seen);
      if (state.env.headingIds) toks[i].attrSet('id', slug);
      if (state.env.toc) state.env.toc.push({ level: Number(toks[i].tag.slice(1)), text, slug });
    }
  });
  return md;
}

const plainParser = makeParser(false);
const wikiParser = makeParser(true);

export function render(markdown, { headingIds = false, wikiLinks } = {}) {
  const src = String(markdown ?? '');
  if (wikiLinks) {
    wikiParser.__wikiLinks = wikiLinks;
    try {
      return wikiParser.render(src, { headingIds });
    } finally {
      wikiParser.__wikiLinks = null;
    }
  }
  return plainParser.render(src, { headingIds });
}

export function toc(markdown) {
  const env = { collectToc: true, toc: [] };
  plainParser.parse(String(markdown ?? ''), env);
  // parse() runs core rules including heading_ids
  return env.toc;
}

/** Distinct sorted wiki-link target slugs in markdown (excluding code). */
export function extractWikiLinks(markdown) {
  const set = new Set();
  const tokens = wikiParser.parse(String(markdown ?? ''), {});
  const walk = (ts) => {
    for (const t of ts) {
      if (t.type === 'link_open' && t.meta && t.meta.wikiSlug) set.add(t.meta.wikiSlug);
      if (t.children) walk(t.children);
    }
  };
  walk(tokens);
  return [...set].sort();
}
