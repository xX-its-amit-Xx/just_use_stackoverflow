// Markdown renderer built on vendored markdown-it 14.1.0 (MIT, see THIRD_PARTY_NOTICES.md).
// Slug algorithm adapted from github-slugger (ISC).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const markdownit = require('./vendor/markdown-it.cjs');

const BAD_PROTO_RE = /^(vbscript|javascript|file|data):/;
const GOOD_DATA_RE = /^data:image\/(gif|png|jpeg|webp);/;

function isUnsafeUrl(url) {
  // Strip whitespace/control chars browsers ignore, then check scheme.
  const str = String(url).replace(/[\u0000- \u007f]/g, '').toLowerCase();
  return BAD_PROTO_RE.test(str) && !GOOD_DATA_RE.test(str);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** GitHub-style slug (github-slugger semantics). */
export function slugify(text, seen) {
  const base = String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-');
  if (!(seen instanceof Map)) return base;
  let result = base;
  while (seen.has(result)) {
    seen.set(base, (seen.get(base) || 0) + 1);
    result = base + '-' + seen.get(base);
  }
  seen.set(result, 0);
  return result;
}

// ---- wiki link inline rule ------------------------------------------------
function wikiLinkRule(state, silent) {
  const src = state.src;
  const start = state.pos;
  if (src.charCodeAt(start) !== 0x5b || src.charCodeAt(start + 1) !== 0x5b) return false;
  const env = state.env || {};
  if (!env.__wiki) return false;
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
    tok.meta = { slug, label: label || target };
    tok.content = label || target;
    if (env.__wikiTargets) env.__wikiTargets.push(slug);
  }
  state.pos = end + 2;
  return true;
}

function inlineText(tokens) {
  let out = '';
  for (const t of tokens || []) {
    if (t.type === 'text' || t.type === 'code_inline' || t.type === 'wikilink') out += t.content;
    else if (t.type === 'image') out += inlineText(t.children);
    else if (t.type === 'softbreak' || t.type === 'hardbreak') out += ' ';
  }
  return out;
}

function createMd() {
  const md = markdownit('commonmark', { html: true, xhtmlOut: true, linkify: false, typographer: false });
  md.enable(['table', 'strikethrough']);
  // Never drop links; neutralise unsafe ones to "#".
  md.validateLink = () => true;
  const origNormalize = md.normalizeLink.bind(md);
  md.normalizeLink = (url) => (isUnsafeUrl(url) ? '#' : origNormalize(url));
  md.inline.ruler.before('link', 'wikilink', wikiLinkRule);

  const r = md.renderer.rules;
  // Safety: raw HTML (block and inline) is emitted as escaped text.
  r.html_block = (tokens, idx) => escapeHtml(tokens[idx].content);
  r.html_inline = (tokens, idx) => escapeHtml(tokens[idx].content);
  r.s_open = () => '<del>';
  r.s_close = () => '</del>';
  r.wikilink = (tokens, idx, options, env) => {
    const { slug, label } = tokens[idx].meta;
    const exists = env.__wiki && typeof env.__wiki.exists === 'function' ? !!env.__wiki.exists(slug) : true;
    return `<a href="/wiki/${escapeHtml(slug)}" class="wikilink${exists ? '' : ' missing'}">${escapeHtml(label)}</a>`;
  };
  r.heading_open = (tokens, idx, options, env, self) => {
    const tok = tokens[idx];
    if (env.__headingIds) {
      const id = slugify(inlineText(tokens[idx + 1].children), env.__seen);
      tok.attrSet('id', id);
    }
    return self.renderToken(tokens, idx, options);
  };
  return md;
}

const md = createMd();

export function render(markdown, { headingIds = false, wikiLinks } = {}) {
  const env = { __headingIds: !!headingIds, __seen: new Map(), __wiki: wikiLinks || null };
  return md.render(String(markdown ?? ''), env);
}

export function toc(markdown) {
  const env = { __wiki: { exists: () => true } };
  const tokens = md.parse(String(markdown ?? ''), env);
  const seen = new Map();
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === 'heading_open') {
      const text = inlineText(tokens[i + 1].children);
      out.push({ level: Number(t.tag.slice(1)), text, slug: slugify(text, seen) });
    }
  }
  return out;
}

/** Slugs of wiki link targets (excluding code), in order of appearance. */
export function wikiLinkTargets(markdown) {
  const env = { __wiki: { exists: () => true }, __wikiTargets: [] };
  md.parse(String(markdown ?? ''), env);
  return env.__wikiTargets;
}
