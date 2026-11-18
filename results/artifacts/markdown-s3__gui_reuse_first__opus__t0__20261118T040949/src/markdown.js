// Markdown renderer: adapter around vendored markdown-it (MIT), see THIRD_PARTY_NOTICES.md.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const MarkdownIt = require('./vendor/markdown-it.cjs');

const SAFE_DATA = /^data:image\/(png|gif|jpeg|webp);/i;
const BAD_SCHEME = /^(javascript|vbscript|file|data):/i;

export function safeUrl(url) {
  const u = String(url ?? '').trim().replace(/[\u0000-\u001f\s]/g, '');
  let decoded = u;
  try { decoded = decodeURIComponent(u); } catch { /* keep */ }
  for (const candidate of [u, decoded]) {
    if (BAD_SCHEME.test(candidate) && !SAFE_DATA.test(candidate)) return '#';
  }
  return url;
}

export function slugify(text, seen) {
  const base = String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
    .replace(/ /g, '-');
  if (!(seen instanceof Map)) return base;
  if (!seen.has(base)) { seen.set(base, 0); return base; }
  let n = seen.get(base);
  let slug;
  do { n += 1; slug = `${base}-${n}`; } while (seen.has(slug));
  seen.set(base, n);
  seen.set(slug, 0);
  return slug;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Inline rule: [[target]] / [[target|label]]
function wikiLinkRule(state, silent) {
  if (!state.env || !state.env.__wiki) return false;
  const src = state.src;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x5b || src.charCodeAt(start + 1) !== 0x5b) return false;
  const end = src.indexOf(']]', start + 2);
  if (end < 0) return false;
  const inner = src.slice(start + 2, end);
  if (!inner.trim() || /[\n\[\]]/.test(inner)) return false;
  const bar = inner.indexOf('|');
  const target = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
  const label = (bar >= 0 ? inner.slice(bar + 1) : inner).trim();
  if (!target) return false;
  if (!silent) {
    const tok = state.push('wikilink', '', 0);
    tok.meta = { target, label: label || target, slug: slugify(target) };
    tok.content = label || target;
  }
  state.pos = end + 2;
  return true;
}

function build() {
  const md = new MarkdownIt('commonmark', { html: false, xhtmlOut: true });
  md.enable(['table', 'strikethrough']);
  md.validateLink = () => true;
  md.inline.ruler.before('link', 'wikilink', wikiLinkRule);

  const r = md.renderer.rules;
  r.s_open = () => '<del>';
  r.s_close = () => '</del>';
  r.wikilink = (tokens, idx, _o, env) => {
    const { slug, label } = tokens[idx].meta;
    let cls = 'wikilink';
    try { if (!env.__wiki.exists(slug)) cls += ' missing'; } catch { cls += ' missing'; }
    return `<a href="/wiki/${escapeHtml(slug)}" class="${cls}">${escapeHtml(label)}</a>`;
  };
  const defaultLinkOpen = r.link_open || ((t, i, o, e, self) => self.renderToken(t, i, o));
  r.link_open = (tokens, idx, opts, env, self) => {
    const t = tokens[idx];
    const i = t.attrIndex('href');
    if (i >= 0) t.attrs[i][1] = safeUrl(t.attrs[i][1]);
    return defaultLinkOpen(tokens, idx, opts, env, self);
  };
  const defaultImage = r.image;
  r.image = (tokens, idx, opts, env, self) => {
    const t = tokens[idx];
    const i = t.attrIndex('src');
    if (i >= 0) t.attrs[i][1] = safeUrl(t.attrs[i][1]);
    return defaultImage(tokens, idx, opts, env, self);
  };
  const defaultHeadingOpen = r.heading_open || ((t, i, o, e, self) => self.renderToken(t, i, o));
  r.heading_open = (tokens, idx, opts, env, self) => {
    if (env.__headingIds) {
      const slug = slugify(inlineText(tokens[idx + 1]), env.__seen);
      tokens[idx].attrSet('id', slug);
    }
    return defaultHeadingOpen(tokens, idx, opts, env, self);
  };
  return md;
}

let mdInstance;
function getMd() { return (mdInstance ||= build()); }

function inlineText(inlineTok) {
  if (!inlineTok || !inlineTok.children) return inlineTok?.content ?? '';
  let out = '';
  for (const c of inlineTok.children) {
    if (c.type === 'text' || c.type === 'code_inline') out += c.content;
    else if (c.type === 'wikilink') out += c.meta.label;
    else if (c.type === 'image') out += inlineText(c);
    else if (c.type === 'softbreak' || c.type === 'hardbreak') out += ' ';
  }
  return out;
}

export function render(markdown, { headingIds = false, wikiLinks } = {}) {
  const env = { __headingIds: headingIds, __seen: new Map(), __wiki: wikiLinks || null };
  return getMd().render(String(markdown ?? ''), env);
}

export function toc(markdown) {
  const tokens = getMd().parse(String(markdown ?? ''), { __wiki: { exists: () => true } });
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

/** Distinct, sorted target slugs of wiki links (ignoring code). */
export function wikiLinkTargets(markdown) {
  const tokens = getMd().parse(String(markdown ?? ''), { __wiki: { exists: () => true } });
  const set = new Set();
  const walk = (list) => {
    for (const t of list) {
      if (t.type === 'wikilink') set.add(t.meta.slug);
      if (t.children) walk(t.children);
    }
  };
  walk(tokens);
  return [...set].filter(Boolean).sort();
}
