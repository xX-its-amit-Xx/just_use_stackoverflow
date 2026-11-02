// Glue around vendored markdown-it (MIT) - see THIRD_PARTY_NOTICES.md
import MarkdownIt from './vendor/markdown-it.esm.min.mjs';

const BAD = /^(javascript|vbscript|file|data):/i;
const OKDATA = /^data:image\/(png|gif|jpeg|webp);/i;

export function slugify(text, seen) {
  let s = String(text).toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
  if (seen instanceof Map) {
    if (seen.has(s)) {
      let n = seen.get(s), c;
      do { c = `${s}-${n++}`; } while (seen.has(c));
      seen.set(s, n);
      seen.set(c, 1);
      return c;
    }
    seen.set(s, 1);
  }
  return s;
}

function make() {
  const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
  md.validateLink = () => true;
  const norm = md.normalizeLink;
  md.normalizeLink = (url) => {
    const t = url.replace(/[\u0000- ]/g, '');
    if (BAD.test(t) && !OKDATA.test(t)) return '#';
    return norm(url);
  };
  return md;
}
const md = make();

function plain(inline) {
  let out = '';
  for (const t of inline.children || []) {
    if (t.type === 'text' || t.type === 'code_inline') out += t.content;
    else if (t.type === 'softbreak' || t.type === 'hardbreak') out += ' ';
  }
  return out;
}

function headings(tokens) {
  const seen = new Map(), res = [];
  tokens.forEach((t, i) => {
    if (t.type !== 'heading_open') return;
    const text = plain(tokens[i + 1]);
    res.push({ token: t, level: +t.tag.slice(1), text, slug: slugify(text, seen) });
  });
  return res;
}

export function render(markdown, { headingIds = false } = {}) {
  const tokens = md.parse(String(markdown), {});
  if (headingIds) for (const h of headings(tokens)) h.token.attrSet('id', h.slug);
  return md.renderer.render(tokens, md.options, {});
}

export function toc(markdown) {
  return headings(md.parse(String(markdown), {})).map(({ level, text, slug }) => ({ level, text, slug }));
}

md.renderer.rules.s_open = () => '<del>';
md.renderer.rules.s_close = () => '</del>';
