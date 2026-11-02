import MarkdownIt from './vendor/markdown-it.esm.min.mjs';

export function slugify(text, seen) {
  let s = String(text).toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
  if (seen) {
    if (seen.has(s)) {
      let n = seen.get(s), c;
      do { c = `${s}-${n}`; n++; } while (seen.has(c));
      seen.set(s, n);
      seen.set(c, 1);
      return c;
    }
    seen.set(s, 1);
  }
  return s;
}

const BAD = /^(?:javascript|vbscript|file|data):/i;
const OKDATA = /^data:image\/(?:png|gif|jpeg|webp);/i;

function make() {
  const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
  md.enable(['table', 'strikethrough']);
  const origNormalize = md.normalizeLink;
  md.validateLink = () => true;
  md.normalizeLink = (url) => {
    const u = origNormalize(url);
    const probe = String(url).replace(/[\u0000- ]/g, '');
    if (BAD.test(probe) && !OKDATA.test(probe)) return '#';
    return u;
  };
  md.renderer.rules.s_open = () => '<del>';
  md.renderer.rules.s_close = () => '</del>';
  return md;
}
const md = make();

function plain(inline) {
  let out = '';
  for (const t of inline.children || []) {
    if (t.type === 'text' || t.type === 'code_inline') out += t.content;
    else if (t.type === 'image') out += plain(t);
    else if (t.type === 'softbreak' || t.type === 'hardbreak') out += ' ';
  }
  return out;
}

function headings(markdown) {
  const tokens = md.parse(String(markdown), {});
  const seen = new Map();
  const res = [];
  tokens.forEach((t, i) => {
    if (t.type === 'heading_open') {
      const text = plain(tokens[i + 1]);
      res.push({ level: Number(t.tag.slice(1)), text, slug: slugify(text, seen), token: t });
    }
  });
  return { tokens, res };
}

export function render(markdown, { headingIds = false } = {}) {
  const { tokens, res } = headings(markdown);
  if (headingIds) for (const h of res) h.token.attrSet('id', h.slug);
  return md.renderer.render(tokens, md.options, {});
}

export function toc(markdown) {
  return headings(markdown).res.map(({ level, text, slug }) => ({ level, text, slug }));
}
