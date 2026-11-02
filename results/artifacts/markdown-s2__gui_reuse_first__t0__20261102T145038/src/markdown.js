// Glue around vendored marked v4.3.0 (MIT) -- see THIRD_PARTY_NOTICES.md
import { marked, Renderer, Lexer } from './marked.js';

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = s => String(s).replace(/&(amp|lt|gt|quot|#39);/g, (m, k) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" }[k]));

export function slugify(text, seen) {
  const s = String(text).toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
  if (!seen) return s;
  if (seen.has(s)) {
    let n = seen.get(s);
    let c;
    do { c = `${s}-${n++}`; } while (seen.has(c));
    seen.set(s, n);
    seen.set(c, 1);
    return c;
  }
  seen.set(s, 1);
  return s;
}

function safeUrl(href) {
  if (href == null) return '';
  const h = String(href);
  const compact = h.replace(/[\u0000- \u007f-\u009f]/g, '');
  const m = /^([a-z][a-z0-9+.-]*):/i.exec(compact);
  if (m) {
    const sch = m[1].toLowerCase();
    if (['javascript', 'vbscript', 'file'].includes(sch)) return '#';
    if (sch === 'data' && !/^data:image\/(png|gif|jpeg|webp);/i.test(compact)) return '#';
  }
  return h;
}

const encUrl = u => (u === '#' ? '#' : esc(encodeURI(u).replace(/%25([0-9A-Fa-f]{2})/g, '%$1')));

function inlineText(tokens) {
  let out = '';
  for (const t of tokens || []) {
    if (t.tokens) out += inlineText(t.tokens);
    else if (t.type === 'escape' || t.type === 'text' || t.type === 'codespan') out += unesc(t.text);
    else if (t.type === 'html') out += t.raw;
  }
  return out;
}

function makeRenderer(headingIds) {
  const r = new Renderer();
  const seen = new Map();
  r.html = h => esc(h);
  r.heading = (text, level, raw) => {
    if (!headingIds) return `<h${level}>${text}</h${level}>\n`;
    return `<h${level} id="${esc(slugify(unesc(raw), seen))}">${text}</h${level}>\n`;
  };
  r.link = (href, title, text) =>
    `<a href="${encUrl(safeUrl(href))}"${title ? ` title="${esc(unesc(title))}"` : ''}>${text}</a>`;
  r.image = (href, title, text) =>
    `<img src="${encUrl(safeUrl(href))}" alt="${esc(unesc(text))}"${title ? ` title="${esc(unesc(title))}"` : ''} />`;
  return r;
}

export function render(markdown, { headingIds = false } = {}) {
  return marked.parse(String(markdown), {
    renderer: makeRenderer(headingIds), gfm: true, mangle: false, headerIds: false, breaks: false, pedantic: false, sanitize: false,
    walkTokens: t => {
      if (t.type === 'html' && 'pre' in t) {
        const raw = t.raw.replace(/\s+$/, '');
        t.type = 'paragraph';
        t.text = raw;
        t.tokens = [{ type: 'text', raw, text: esc(raw) }];
      }
    },
  });
}

export function toc(markdown) {
  const seen = new Map();
  const out = [];
  const walk = tokens => {
    for (const t of tokens) {
      if (t.type === 'heading') {
        const text = inlineText(t.tokens).trim();
        out.push({ level: t.depth, text, slug: slugify(text, seen) });
      } else if (t.type === 'blockquote') walk(t.tokens);
      else if (t.type === 'list') walk(t.items);
      else if (t.type === 'list_item') walk(t.tokens);
    }
  };
  walk(Lexer.lex(String(markdown), { gfm: true, mangle: false }));
  return out;
}
