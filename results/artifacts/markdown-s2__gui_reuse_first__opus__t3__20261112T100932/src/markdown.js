// Safe Markdown -> HTML renderer (markdown-s2).
// Parsing is done by a vendored, lightly patched copy of marked v15.0.12
// (MIT, see THIRD_PARTY_NOTICES.md); this module adds the glue: CommonMark-style
// output tweaks, URL sanitisation, heading ids, TOC and slugify.
import { Marked } from './vendor/marked.esm.js';

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ESC[c]);

// Small table of common named entities (full HTML5 table not vendored).
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®',
  trade: '™', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', middot: '·', bull: '•',
  deg: '°', plusmn: '±', times: '×', divide: '÷', euro: '€', pound: '£',
  yen: '¥', cent: '¢', sect: '§', para: '¶', frac12: '½', frac14: '¼',
  frac34: '¾', larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü',
  szlig: 'ß', eacute: 'é', egrave: 'è', aacute: 'á', agrave: 'à', ccedil: 'ç',
  ntilde: 'ñ', iexcl: '¡', iquest: '¿', shy: '­', micro: 'µ', infin: '∞',
  ne: '≠', le: '≤', ge: '≥', alpha: 'α', beta: 'β', gamma: 'γ', pi: 'π',
  Dcaron: 'Ď', HilbertSpace: 'ℋ', DifferentialD: 'ⅆ', ClockwiseContourIntegral: '∲',
  ngE: '≧̸', AElig: 'Æ', thinsp: ' ', ensp: ' ', emsp: ' ', zwj: '‍', zwnj: '‌',
};

function decodeEntities(s) {
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g, (m, dec, hex, name) => {
    if (name) return Object.prototype.hasOwnProperty.call(NAMED, name) ? NAMED[name] : m;
    let cp = dec ? parseInt(dec, 10) : parseInt(hex, 16);
    if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
    return String.fromCodePoint(cp);
  });
}

// Text in marked tokens is raw source text: decode entities, then escape.
const textOut = (s) => escapeHtml(decodeEntities(s));

// ---- URL handling ---------------------------------------------------------
function isUnsafeUrl(url) {
  const u = decodeEntities(url).replace(/[\u0000- \u007f]/g, '').toLowerCase();
  if (/^(?:javascript|vbscript|file):/.test(u)) return true;
  if (/^data:/.test(u)) return !/^data:image\/(?:png|gif|jpeg|webp);/.test(u);
  return false;
}

// Percent-encode like commonmark.js (mdurl.encode): keep existing %XX escapes
// and URL-reserved characters, encode everything else.
function normalizeUrl(url) {
  let out = '';
  const keep = /[A-Za-z0-9;/?:@&=+$,\-_.!~*'()#]/;
  for (let i = 0; i < url.length; i++) {
    const ch = url[i];
    if (ch === '%' && /^[0-9a-fA-F]{2}$/.test(url.slice(i + 1, i + 3))) { out += ch; continue; }
    if (keep.test(ch)) { out += ch; continue; }
    const code = url.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < url.length) {
      const next = url.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) { out += encodeURIComponent(ch + url[i + 1]); i++; continue; }
      out += '%EF%BF%BD'; continue;
    }
    if (code >= 0xd800 && code <= 0xdfff) { out += '%EF%BF%BD'; continue; }
    out += encodeURIComponent(ch);
  }
  return out;
}

function safeHref(href) {
  const raw = decodeEntities(href || '');
  if (isUnsafeUrl(raw)) return '#';
  return escapeHtml(normalizeUrl(raw));
}

// ---- plain text of inline tokens -----------------------------------------
function plainText(tokens) {
  let out = '';
  for (const t of tokens || []) {
    if (t.type === 'escape') out += t.text;
    else if (t.type === 'br') out += '';
    else if (t.type === 'codespan') out += t.text;
    else if (t.type === 'image') out += t.tokens ? plainText(t.tokens) : t.text;
    else if (t.tokens) out += plainText(t.tokens);
    else if (t.type === 'text') out += decodeEntities(t.text);
    else if (t.text != null) out += t.text;
  }
  return out;
}

// ---- slugify -------------------------------------------------------------
export function slugify(text, seen) {
  const base = String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{Nd} _-]/gu, '')
    .replace(/ /g, '-');
  if (!(seen instanceof Map)) return base;
  let slug = base;
  if (seen.has(slug)) {
    let n = seen.get(base) ?? 0;
    do {
      n++;
      slug = `${base}-${n}`;
    } while (seen.has(slug));
    seen.set(base, n);
  }
  seen.set(slug, 0);
  return slug;
}

// ---- renderer --------------------------------------------------------------
function createMarked(state) {
  const marked = new Marked({ gfm: true, breaks: false, pedantic: false, async: false });
  marked.use({
    walkTokens(token) {
      if (token.type === 'heading') {
        const text = plainText(token.tokens);
        const slug = slugify(text, state.seen);
        token._slug = slug;
        state.headings.push({ level: token.depth, text, slug });
      }
    },
    renderer: {
      heading(token) {
        const body = this.parser.parseInline(token.tokens);
        const id = state.headingIds ? ` id="${escapeHtml(token._slug)}"` : '';
        return `<h${token.depth}${id}>${body}</h${token.depth}>\n`;
      },
      hr() {
        return '<hr />\n';
      },
      br() {
        return '<br />\n';
      },
      codespan({ text }) {
        return `<code>${escapeHtml(text)}</code>`;
      },
      code({ text, lang }) {
        const info = decodeEntities((lang || '').replace(/\\([!-/:-@[-`{-~])/g, '$1')).trim();
        const word = info.split(/\s+/)[0];
        const body = text ? text.replace(/\n$/, '') + '\n' : '';
        const cls = word ? ` class="language-${escapeHtml(word)}"` : '';
        return `<pre><code${cls}>${escapeHtml(body === '\n' && !text ? '' : body)}</code></pre>\n`;
      },
      link({ href, title, tokens }) {
        const text = this.parser.parseInline(tokens);
        let out = `<a href="${safeHref(href)}"`;
        if (title) out += ` title="${textOut(title)}"`;
        return out + '>' + text + '</a>';
      },
      image({ href, title, tokens, text }) {
        const alt = tokens ? plainText(tokens) : decodeEntities(text || '');
        let out = `<img src="${safeHref(href)}" alt="${escapeHtml(alt)}"`;
        if (title) out += ` title="${textOut(title)}"`;
        return out + ' />';
      },
      text(token) {
        if (token.tokens) return this.parser.parseInline(token.tokens);
        if (token.escaped) return token.text;
        return textOut(token.text);
      },
      html({ text }) {
        // Raw HTML is never passed through.
        return escapeHtml(text);
      },
    },
  });
  return marked;
}

function normalizeInput(md) {
  return String(md ?? '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '�');
}

function run(markdown, headingIds) {
  const state = { seen: new Map(), headings: [], headingIds };
  const marked = createMarked(state);
  const html = marked.parse(normalizeInput(markdown));
  return { html, headings: state.headings };
}

export function render(markdown, { headingIds = false } = {}) {
  return run(markdown, headingIds).html;
}

export function toc(markdown) {
  const state = { seen: new Map(), headings: [], headingIds: false };
  const marked = createMarked(state);
  const tokens = marked.lexer(normalizeInput(markdown));
  marked.walkTokens(tokens, (t) => {
    if (t.type === 'heading') {
      const text = plainText(t.tokens);
      state.headings.push({ level: t.depth, text, slug: slugify(text, state.seen) });
    }
  });
  return state.headings;
}

export default { render, toc, slugify };
