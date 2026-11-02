import { Marked } from './marked.js';

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = s => s.replace(/&(amp|lt|gt|quot|#39);/g, (m, c) => ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[c]);

export function slugify(text, seen) {
  const s = String(text).toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
  if (!seen) return s;
  let r = s;
  if (seen.has(s)) {
    let n = seen.get(s);
    r = `${s}-${n}`;
    while (seen.has(r)) { n++; r = `${s}-${n}`; }
    seen.set(s, n + 1);
  }
  seen.set(r, seen.get(r) ?? 1);
  return r;
}

function safeUrl(href) {
  if (href == null) return href;
  const probe = String(href).replace(/[\u0000- \u007f-\u009f]/g, '').toLowerCase();
  const m = /^([a-z][a-z0-9+.-]*):/.exec(probe);
  if (m) {
    if (['javascript', 'vbscript', 'file'].includes(m[1])) return '#';
    if (m[1] === 'data' && !/^data:image\/(png|gif|jpeg|webp);/.test(probe)) return '#';
  }
  return href;
}

function plain(tokens) {
  let out = '';
  for (const t of tokens || []) {
    if (t.type === 'br') out += '\n';
    else if (t.tokens) out += plain(t.tokens);
    else out += t.text ?? t.raw ?? '';
  }
  return unesc(out);
}

function encodeHref(h) {
  try { return encodeURI(decodeURI(h)); } catch { return h; }
}

function make(headingIds) {
  const seen = new Map();
  const marked = new Marked({ gfm: true, breaks: false });
  marked.use({
    renderer: {
      html(tok) { return esc(tok.text ?? tok.raw ?? ''); },
      link(tok) {
        const t = tok.title ? ` title="${esc(tok.title)}"` : '';
        return `<a href="${esc(encodeHref(safeUrl(tok.href)))}"${t}>${this.parser.parseInline(tok.tokens)}</a>`;
      },
      image(tok) {
        const t = tok.title ? ` title="${esc(tok.title)}"` : '';
        return `<img src="${esc(encodeHref(safeUrl(tok.href)))}" alt="${esc(plain(tok.tokens))}"${t} />`;
      },
      heading(tok) {
        const inner = this.parser.parseInline(tok.tokens);
        const id = headingIds ? ` id="${esc(slugify(plain(tok.tokens), seen))}"` : '';
        return `<h${tok.depth}${id}>${inner}</h${tok.depth}>\n`;
      },
      code(tok) {
        const lang = ((tok.lang || '').match(/^\S+/) || [''])[0];
        const cls = lang ? ` class="language-${esc(lang)}"` : '';
        const body = tok.text === '' ? '' : esc(tok.text.replace(/\n$/, '')) + '\n';
        return `<pre><code${cls}>${body}</code></pre>\n`;
      },
    },
  });
  return marked;
}

const norm = s => String(s ?? '').replace(/\r\n?/g, '\n');

export function render(markdown, { headingIds = false } = {}) {
  return make(headingIds).parse(norm(markdown), { async: false }).replace(/&#39;/g, "'");
}

export function toc(markdown) {
  const seen = new Map();
  const out = [];
  const walk = tokens => {
    for (const t of tokens) {
      if (t.type === 'heading') out.push({ level: t.depth, text: plain(t.tokens), slug: slugify(plain(t.tokens), seen) });
      else {
        if (t.type !== 'paragraph' && t.tokens) walk(t.tokens);
        if (t.items) walk(t.items);
      }
    }
  };
  walk(new Marked({ gfm: true }).lexer(norm(markdown)));
  return out;
}
