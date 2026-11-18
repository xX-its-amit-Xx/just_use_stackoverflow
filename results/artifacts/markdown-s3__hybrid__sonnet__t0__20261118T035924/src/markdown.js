import markdownit from './vendor/markdown-it.min.mjs';

export function slugify(text, seen) {
  let s = String(text).toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
  if (seen instanceof Map) {
    if (seen.has(s)) {
      const n = seen.get(s) + 1; seen.set(s, n);
      const out = `${s}-${n}`; if (!seen.has(out)) seen.set(out, 0);
      return out;
    }
    seen.set(s, 0);
  }
  return s;
}

const SAFE_DATA = /^data:image\/(png|gif|jpeg|webp);/i;
function cleanUrl(u) {
  const t = u.replace(/[\u0000- ]/g, '').toLowerCase();
  if (/^(javascript|vbscript|file):/.test(t)) return '#';
  if (t.startsWith('data:') && !SAFE_DATA.test(t)) return '#';
  return u;
}

function make() {
  const md = markdownit({ html: false, linkify: false, breaks: false });
  md.validateLink = () => true;
  md.renderer.rules.s_open = () => '<del>';
  md.renderer.rules.s_close = () => '</del>';
  const defLink = md.renderer.rules.link_open || ((t, i, o, e, s) => s.renderToken(t, i, o));
  md.renderer.rules.link_open = (t, i, o, e, s) => {
    const a = t[i].attrGet('href'); if (a != null) t[i].attrSet('href', cleanUrl(md.utils.unescapeAll(a)) === '#' ? '#' : a);
    return defLink(t, i, o, e, s);
  };
  const defImg = md.renderer.rules.image;
  md.renderer.rules.image = (t, i, o, e, s) => {
    const a = t[i].attrGet('src'); if (a != null && cleanUrl(a) === '#') t[i].attrSet('src', '#');
    return defImg(t, i, o, e, s);
  };
  // wiki links
  md.inline.ruler.before('link', 'wikilink', (state, silent) => {
    const src = state.src, pos = state.pos;
    if (!state.env.wikiLinks || src.charCodeAt(pos) !== 0x5b || src.charCodeAt(pos + 1) !== 0x5b) return false;
    const end = src.indexOf(']]', pos + 2);
    if (end < 0) return false;
    const inner = src.slice(pos + 2, end);
    if (!inner.trim() || inner.includes('\n') || inner.includes('[')) return false;
    if (!silent) {
      const bar = inner.indexOf('|');
      const target = (bar < 0 ? inner : inner.slice(0, bar)).trim();
      const label = (bar < 0 ? inner : inner.slice(bar + 1)).trim() || target;
      const tok = state.push('wikilink', '', 0);
      tok.meta = { slug: slugify(target), label };
    }
    state.pos = end + 2;
    return true;
  });
  md.renderer.rules.wikilink = (t, i, o, env) => {
    const { slug, label } = t[i].meta;
    const ok = !!env.wikiLinks.exists(slug);
    return `<a href="/wiki/${md.utils.escapeHtml(encodeURI(slug))}" class="wikilink${ok ? '' : ' missing'}">${md.utils.escapeHtml(label)}</a>`;
  };
  // heading ids + toc collection
  md.core.ruler.push('heading_slugs', (state) => {
    const seen = new Map(); const list = [];
    const toks = state.tokens;
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].type !== 'heading_open') continue;
      const inl = toks[i + 1];
      let text = '';
      const walk = (ch) => { for (const c of ch || []) {
        if (c.type === 'text' || c.type === 'code_inline') text += c.content;
        else if (c.type === 'wikilink') text += c.meta.label;
        else if (c.type === 'softbreak' || c.type === 'hardbreak') text += ' ';
        else if (c.type === 'image') walk(c.children);
      } };
      walk(inl.children);
      const slug = slugify(text, seen);
      list.push({ level: Number(toks[i].tag.slice(1)), text, slug });
      toks[i].meta = { slug };
    }
    state.env.toc = list;
  });
  const defH = (t, i, o, e, s) => s.renderToken(t, i, o);
  md.renderer.rules.heading_open = (t, i, o, env, s) => {
    if (env.headingIds && t[i].meta) t[i].attrSet('id', t[i].meta.slug);
    return defH(t, i, o, env, s);
  };
  return md;
}
const md = make();

export function render(markdown, { headingIds = false, wikiLinks } = {}) {
  return md.render(String(markdown ?? ''), { headingIds, wikiLinks });
}

export function toc(markdown) {
  const env = {};
  md.parse(String(markdown ?? ''), env);
  return env.toc;
}

export function wikiTargets(markdown) {
  const env = { wikiLinks: { exists: () => true } };
  const out = new Set();
  const toks = md.parse(String(markdown ?? ''), env);
  const walk = (ts) => { for (const t of ts) { if (t.type === 'wikilink') out.add(t.meta.slug); if (t.children) walk(t.children); } };
  walk(toks);
  return [...out];
}
