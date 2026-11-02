// markdown-s2: safe Markdown -> HTML renderer (CommonMark-ish + GFM tables/strikethrough)

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™',
  hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', laquo: '«',
  raquo: '»', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', deg: '°', plusmn: '±',
  times: '×', divide: '÷', middot: '·', bull: '•', larr: '←', rarr: '→', uarr: '↑', darr: '↓',
  hearts: '♥', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü', szlig: 'ß',
  eacute: 'é', egrave: 'è', agrave: 'à', aacute: 'á', ccedil: 'ç', ntilde: 'ñ', para: '¶',
  frac12: '½', frac14: '¼', frac34: '¾', micro: 'µ', iexcl: '¡', iquest: '¿', dagger: '†',
  Dagger: '‡', check: '✓', ne: '≠', le: '≤', ge: '≥', infin: '∞', hArr: '⇔', copysr: '℗',
  ouml_: 'ö', AElig: 'Æ', aelig: 'æ', Dcaron: 'Ď', HilbertSpace: 'ℋ', DifferentialD: 'ⅆ',
  ClockwiseContourIntegral: '∲', ngE: '≧̸',
};

export function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const ENT_RE = /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g;
function decodeEntity(name) {
  if (name[0] === '#') {
    let cp = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    if (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
    return String.fromCodePoint(cp);
  }
  return Object.prototype.hasOwnProperty.call(ENTITIES, name) ? ENTITIES[name] : null;
}
const ESC_RE = /\\([!-\/:-@\[-`{-~])/g;
function unescapeStr(s) {
  return s.replace(/\\([!-\/:-@\[-`{-~])|&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/g,
    (m, e, ent) => {
      if (e !== undefined) return e;
      const d = decodeEntity(ent);
      return d === null ? m : d;
    });
}

export function slugify(text, seen) {
  const base = String(text).toLowerCase().replace(/[^\p{L}\p{N} \-_]/gu, '').replace(/ /g, '-');
  if (!seen) return base;
  if (seen.has(base)) {
    const n = seen.get(base) + 1;
    seen.set(base, n);
    return base + '-' + n;
  }
  seen.set(base, 0);
  return base;
}

function normalizeUrl(u) {
  let out = '';
  for (let i = 0; i < u.length; i++) {
    const c = u[i];
    if (/[A-Za-z0-9\-_.!~*'();\/?:@&=+$,#]/.test(c)) out += c;
    else if (c === '%' && /^[0-9a-fA-F]{2}/.test(u.slice(i + 1, i + 3))) out += c;
    else {
      const cp = u.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      if (cp > 0xffff) i++;
      try { out += encodeURIComponent(ch); } catch { out += '%EF%BF%BD'; }
    }
  }
  return out;
}
function safeUrl(u) {
  const t = u.replace(/[\x00-\x20\x7f-\x9f\u200b-\u200d\u2028\u2029\ufeff]/g, '');
  if (/^(javascript|vbscript|file|data):/i.test(t)) {
    if (/^data:image\/(png|gif|jpeg|webp);/i.test(t)) return u;
    return '#';
  }
  return u;
}
const fixUrl = u => escapeHtml(safeUrl(normalizeUrl(u)));
const normLabel = s => s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase();

const PUNCT = /[\p{P}\p{S}]/u;
const WS = /[\s   -   　]/u;

// ---------------------------------------------------------------- inline
function parseInline(src, refs, plain = false) {
  const nodes = [];
  const brackets = [];
  let pos = 0;
  const n = src.length;
  const pushText = h => nodes.push({ k: 't', h });

  function renderFlat(list) {
    return list.map(x => x.k === 'd' ? x.ch.repeat(x.n) : x.k === 'b' ? x.h : x.h).join('');
  }
  function emphasis(list) {
    let i = 0;
    while (i < list.length) {
      const c = list[i];
      if (c.k === 'd' && c.close && c.n > 0) {
        let j = i - 1, found = -1;
        for (; j >= 0; j--) {
          const o = list[j];
          if (o.k !== 'd' || o.ch !== c.ch || !o.open || o.n === 0) continue;
          if (c.ch === '~') { if (o.n === c.n) { found = j; break; } continue; }
          if ((o.close || c.open) && (o.orig + c.orig) % 3 === 0 && !(o.orig % 3 === 0 && c.orig % 3 === 0)) continue;
          found = j; break;
        }
        if (found >= 0) {
          const o = list[found];
          const use = c.ch === '~' ? c.n : (o.n >= 2 && c.n >= 2 ? 2 : 1);
          const inner = renderFlat(list.slice(found + 1, i));
          const tag = c.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em';
          const node = { k: 't', h: `<${tag}>${inner}</${tag}>` };
          list.splice(found + 1, i - found - 1, node);
          o.n -= use; c.n -= use;
          let ci = found + 2;
          if (o.n === 0) { list.splice(found, 1); ci--; }
          if (c.n === 0) { list.splice(ci, 1); i = ci; } else i = ci;
          continue;
        }
        if (!c.open) c.close = false;
      }
      i++;
    }
    return renderFlat(list);
  }

  function parseLinkTail(p) {
    // p points just after '('. returns {dest,title,end} or null
    const skipWs = () => { while (p < n && /[ \t\n]/.test(src[p])) p++; };
    skipWs();
    let dest = '';
    if (src[p] === '<') {
      let q = p + 1;
      while (q < n && src[q] !== '>' && src[q] !== '\n' && src[q] !== '<') { if (src[q] === '\\') q++; q++; }
      if (src[q] !== '>') return null;
      dest = src.slice(p + 1, q); p = q + 1;
    } else {
      let depth = 0, q = p;
      while (q < n) {
        const ch = src[q];
        if (ch === '\\' && q + 1 < n && /[!-\/:-@\[-`{-~]/.test(src[q + 1])) { q += 2; continue; }
        if (ch === '(') depth++;
        else if (ch === ')') { if (depth === 0) break; depth--; }
        else if (/[\s\x00-\x1f]/.test(ch)) break;
        q++;
      }
      if (depth !== 0) return null;
      dest = src.slice(p, q); p = q;
    }
    const before = p;
    skipWs();
    let title = null;
    if (p > before && (src[p] === '"' || src[p] === "'" || src[p] === '(')) {
      const close = src[p] === '(' ? ')' : src[p];
      let q = p + 1;
      while (q < n && src[q] !== close) { if (src[q] === '\\') q++; if (src[q] === '(' && close === ')') return null; q++; }
      if (q >= n) return null;
      title = src.slice(p + 1, q); p = q + 1;
      skipWs();
    }
    if (src[p] !== ')') return null;
    return { dest, title, end: p + 1 };
  }

  function closeBracket() {
    const opener = brackets[brackets.length - 1];
    if (!opener) { pushText(']'); pos++; return; }
    if (!opener.active) { brackets.pop(); pushText(']'); pos++; return; }
    const label = src.slice(opener.src, pos);
    let dest = null, title = null, end = pos + 1;
    if (src[pos + 1] === '(') {
      const r = parseLinkTail(pos + 2);
      if (r) { dest = r.dest; title = r.title; end = r.end; }
    }
    if (dest === null) {
      let ref = null;
      const m = /^\[((?:[^\\\[\]]|\\.)*)\]/.exec(src.slice(pos + 1));
      if (m) {
        const key = m[1].trim() === '' ? label : m[1];
        if (m[1].trim() === '' || true) { ref = refs.get(normLabel(key)); if (ref) end = pos + 1 + m[0].length; }
      } else if (!/^\[/.test(src.slice(pos + 1))) {
        ref = refs.get(normLabel(label));
      }
      if (ref && label.trim() !== '' ) { dest = ref.dest; title = ref.title; }
    }
    if (dest === null) { brackets.pop(); pushText(']'); pos++; return; }
    const idx = nodes.indexOf(opener);
    const inner = nodes.splice(idx + 1);
    nodes.pop();
    const innerHtml = emphasis(inner);
    let html;
    if (opener.image) {
      const alt = innerHtml.replace(/<[^>]*>/g, '');
      if (plain) html = alt;
      else html = `<img src="${fixUrl(unescapeStr(dest))}" alt="${alt}"` +
        (title !== null && title !== undefined ? ` title="${escapeHtml(unescapeStr(title))}"` : '') + ' />';
    } else {
      html = `<a href="${fixUrl(unescapeStr(dest))}"` +
        (title !== null && title !== undefined ? ` title="${escapeHtml(unescapeStr(title))}"` : '') + `>${innerHtml}</a>`;
    }
    const bi = brackets.indexOf(opener);
    brackets.length = bi;
    if (!opener.image) for (const b of brackets) if (!b.image) b.active = false;
    pushText(html);
    pos = end;
  }

  while (pos < n) {
    const c = src[pos];
    if (c === '\\') {
      const nx = src[pos + 1];
      if (nx === '\n') { nodes.push({ k: 't', h: '<br />\n' }); pos += 2; while (src[pos] === ' ') pos++; }
      else if (nx !== undefined && /[!-\/:-@\[-`{-~]/.test(nx)) { pushText(escapeHtml(nx)); pos += 2; }
      else { pushText('\\'); pos++; }
    } else if (c === '`') {
      let e = pos; while (src[e] === '`') e++;
      const len = e - pos;
      let q = e, found = -1;
      while (q < n) {
        const f = src.indexOf('`', q);
        if (f < 0) break;
        let g = f; while (src[g] === '`') g++;
        if (g - f === len) { found = f; break; }
        q = g;
      }
      if (found < 0) { pushText(src.slice(pos, e)); pos = e; }
      else {
        let content = src.slice(e, found).replace(/\n/g, ' ');
        if (content.length > 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) content = content.slice(1, -1);
        pushText(`<code>${escapeHtml(content)}</code>`);
        pos = found + len;
      }
    } else if (c === '*' || c === '_' || c === '~') {
      let e = pos; while (src[e] === c) e++;
      const len = e - pos;
      if (c === '~' && len > 2) { pushText(src.slice(pos, e)); pos = e; continue; }
      const prev = pos === 0 ? '\n' : src[pos - 1];
      const next = e >= n ? '\n' : src[e];
      const pw = WS.test(prev), nw = WS.test(next), pp = PUNCT.test(prev), np = PUNCT.test(next);
      const left = !nw && (!np || pw || pp);
      const right = !pw && (!pp || nw || np);
      let open, close;
      if (c === '_') { open = left && (!right || pp); close = right && (!left || np); }
      else { open = left; close = right; }
      nodes.push({ k: 'd', ch: c, n: len, orig: len, open, close });
      pos = e;
    } else if (c === '[') {
      const b = { k: 'b', h: '[', image: false, active: true, src: pos + 1 };
      nodes.push(b); brackets.push(b); pos++;
    } else if (c === '!' && src[pos + 1] === '[') {
      const b = { k: 'b', h: '![', image: true, active: true, src: pos + 2 };
      nodes.push(b); brackets.push(b); pos += 2;
    } else if (c === ']') {
      closeBracket();
    } else if (c === '<') {
      const rest = src.slice(pos);
      let m;
      if ((m = /^<([A-Za-z][A-Za-z0-9+.\-]{1,31}:[^\s<>]*)>/.exec(rest))) {
        pushText(`<a href="${fixUrl(m[1])}">${escapeHtml(m[1])}</a>`); pos += m[0].length;
      } else if ((m = /^<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/.exec(rest))) {
        pushText(`<a href="${fixUrl('mailto:' + m[1])}">${escapeHtml(m[1])}</a>`); pos += m[0].length;
      } else { pushText('&lt;'); pos++; }
    } else if (c === '&') {
      ENT_RE.lastIndex = 0;
      const m = /^&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/.exec(src.slice(pos, pos + 40));
      const d = m ? decodeEntity(m[1]) : null;
      if (d !== null) { pushText(escapeHtml(d)); pos += m[0].length; }
      else { pushText('&amp;'); pos++; }
    } else if (c === '\n') {
      const last = nodes[nodes.length - 1];
      let hard = false;
      if (last && last.k === 't') {
        const m = / +$/.exec(last.h);
        if (m) { hard = m[0].length >= 2; last.h = last.h.slice(0, m.index); }
      }
      pushText(hard ? '<br />\n' : '\n');
      pos++;
      while (src[pos] === ' ' || src[pos] === '\t') pos++;
    } else {
      const m = /[\\`*_~\[\]!<&\n]/.exec(src.slice(pos + 1));
      const e = m ? pos + 1 + m.index : n;
      pushText(escapeHtml(src.slice(pos, e)));
      pos = e;
    }
  }
  let html = emphasis(nodes);
  if (plain) {
    html = html.replace(/<[^>]*>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  }
  return html;
}

// ---------------------------------------------------------------- blocks
const reHr = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const reAtx = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const reFence = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const reMarker = /^( {0,3})([-+*]|\d{1,9}[.)])( +|$)/;
const isBlank = l => /^\s*$/.test(l);

function fenceOpen(l) {
  const m = reFence.exec(l);
  if (!m) return null;
  if (m[2][0] === '`' && m[3].includes('`')) return null;
  return m;
}
function marker(l) {
  const m = reMarker.exec(l);
  if (!m) return null;
  const mk = m[2];
  const ordered = /\d/.test(mk[0]);
  const indent = m[1].length;
  const rest = l.slice(m[0].length);
  const empty = isBlank(l.slice(indent + mk.length));
  let w;
  if (empty || m[3].length >= 5) w = indent + mk.length + 1; else w = indent + mk.length + m[3].length;
  return {
    ordered, type: ordered ? mk[mk.length - 1] : mk, start: ordered ? parseInt(mk, 10) : 0,
    contentIndent: w, empty,
  };
}
function interrupts(l) {
  if (reHr.test(l) || reAtx.test(l) || fenceOpen(l) || /^ {0,3}>/.test(l)) return true;
  const m = marker(l);
  if (m && !m.empty && (!m.ordered || m.start === 1)) return true;
  return false;
}
function inFence(lines) {
  let open = null;
  for (const l of lines) {
    if (open) {
      const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(l);
      if (m && m[1][0] === open[0] && m[1].length >= open.length) open = null;
    } else {
      const m = fenceOpen(l);
      if (m) open = m[2];
    }
  }
  return !!open;
}
function paraLast(lines) {
  if (!lines.length) return false;
  const l = lines[lines.length - 1];
  if (isBlank(l)) return false;
  if (inFence(lines)) return false;
  if (/^(?: {4,}|\t)/.test(l)) {
    // indented code unless part of a paragraph; approximate: treat as code
    let k = lines.length - 1;
    while (k >= 0 && /^(?: {4,}|\t)/.test(lines[k])) k--;
    if (k < 0 || isBlank(lines[k])) return false;
  }
  if (reHr.test(l) || reAtx.test(l)) return false;
  return true;
}

function expandTabs(l) {
  if (!l.includes('\t')) return l;
  let out = '', col = 0, i = 0;
  for (; i < l.length && (l[i] === ' ' || l[i] === '\t'); i++) {
    if (l[i] === ' ') { out += ' '; col++; } else { const k = 4 - (col % 4); out += ' '.repeat(k); col += k; }
  }
  return out + l.slice(i);
}

const reRef = /^ {0,3}\[((?:[^\\\[\]]|\\.){1,999})\]:[ \t]*\n?[ \t]*(<(?:[^<>\n\\]|\\.)*>|[^\s<][^\s]*)(?:(?:[ \t]*\n[ \t]*|[ \t]+)("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\)))?[ \t]*(?:\n|$)/;

function extractRefs(text, refs) {
  for (;;) {
    const m = reRef.exec(text);
    if (!m || !/\S/.test(m[1])) break;
    // title lines must not contain blank lines
    let dest = m[2];
    if (dest[0] === '<') dest = dest.slice(1, -1);
    let title = m[3] ? m[3].slice(1, -1) : null;
    const key = normLabel(m[1]);
    if (!refs.has(key)) refs.set(key, { dest, title });
    text = text.slice(m[0].length);
  }
  return text;
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (/(^|[^\\])(\\\\)*\|$/.test(s) || s === '|') s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; }
    else if (s[i] === '\\' && i + 1 < s.length) { cur += s[i] + s[i + 1]; i++; }
    else if (s[i] === '|') { cells.push(cur.trim()); cur = ''; }
    else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}
function delimRow(line) {
  if (!line.includes('|') && !line.includes(':')) return null;
  if (!/^[\s|:\-]+$/.test(line) || !line.includes('-')) return null;
  if (/^ {4,}/.test(line)) return null;
  const cells = splitRow(line);
  const al = [];
  for (const c of cells) {
    if (!/^:?-+:?$/.test(c)) return null;
    al.push(c[0] === ':' ? (c.endsWith(':') ? 'center' : 'left') : c.endsWith(':') ? 'right' : null);
  }
  return al;
}

function parseBlocks(lines, refs) {
  const out = [];
  let i = 0;
  let gap = false;
  const add = b => { b.gap = gap; gap = false; out.push(b); };
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { gap = out.length > 0 || gap; i++; continue; }
    // indented code
    if (/^ {4}/.test(line)) {
      const buf = [];
      let j = i;
      while (j < lines.length && (isBlank(lines[j]) || /^ {4}/.test(lines[j]))) { buf.push(isBlank(lines[j]) ? lines[j].slice(4) : lines[j].slice(4)); j++; }
      while (buf.length && isBlank(buf[buf.length - 1])) { buf.pop(); }
      add({ t: 'code', text: buf.join('\n') + '\n', info: '' });
      i += buf.length;
      continue;
    }
    let m;
    if ((m = fenceOpen(line))) {
      const ind = m[1].length, ch = m[2][0], len = m[2].length;
      const buf = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const cm = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[j]);
        if (cm && cm[1][0] === ch && cm[1].length >= len) break;
        let l = lines[j], k = 0;
        while (k < ind && l[k] === ' ') k++;
        buf.push(l.slice(k));
      }
      add({ t: 'code', text: buf.length ? buf.join('\n') + '\n' : '', info: unescapeStr(m[3].trim()) });
      i = j + 1;
      continue;
    }
    if ((m = reAtx.exec(line))) {
      let text = (m[2] || '').replace(/[ \t]+#+[ \t]*$/, '').replace(/^#+[ \t]*$/, '').trim();
      add({ t: 'h', level: m[1].length, text });
      i++;
      continue;
    }
    if (reHr.test(line)) { add({ t: 'hr' }); i++; continue; }
    if (/^ {0,3}>/.test(line)) {
      const buf = [];
      let j = i;
      while (j < lines.length) {
        const l = lines[j];
        const bm = /^ {0,3}>( ?)/.exec(l);
        if (bm) { buf.push(l.slice(bm[0].length)); j++; continue; }
        if (!isBlank(l) && paraLast(buf) && !interrupts(l)) { buf.push(l); j++; continue; }
        break;
      }
      add({ t: 'bq', children: parseBlocks(buf, refs) });
      i = j;
      continue;
    }
    const mk = marker(line);
    if (mk) {
      const items = [];
      let j = i, cur = mk, blanksBefore = false, loose = false;
      for (;;) {
        const buf = [line_slice(lines[j], cur)];
        let k = j + 1;
        const startEmpty = cur.empty;
        while (k < lines.length) {
          const l = lines[k];
          if (isBlank(l)) {
            if (startEmpty && k === j + 1) break;
            buf.push(''); k++; continue;
          }
          const ind = /^ */.exec(l)[0].length;
          if (ind >= cur.contentIndent) { buf.push(l.slice(cur.contentIndent)); k++; continue; }
          if (paraLast(buf) && !interrupts(l) && !marker(l)) { buf.push(l); k++; continue; }
          break;
        }
        let trailing = 0;
        while (buf.length && isBlank(buf[buf.length - 1])) { buf.pop(); trailing++; }
        const children = parseBlocks(buf, refs);
        items.push({ children, gapBefore: blanksBefore });
        j = k - 0;
        // k already past trailing blanks
        const next = j < lines.length ? marker(lines[j]) : null;
        if (next && !reHr.test(lines[j]) && next.ordered === mk.ordered && next.type === mk.type) {
          blanksBefore = trailing > 0 || (j > 0 && isBlank(lines[j - 1]));
          cur = next;
          continue;
        }
        break;
      }
      for (let x = 0; x < items.length; x++) {
        if (x > 0 && items[x].gapBefore) loose = true;
        items[x].children.forEach((c, ci) => { if (ci > 0 && c.gap) loose = true; });
      }
      add({ t: 'list', ordered: mk.ordered, start: mk.start, loose, items: items.map(it => it.children) });
      i = j;
      continue;
    }
    // table
    if (line.includes('|') && i + 1 < lines.length) {
      const al = delimRow(lines[i + 1]);
      if (al) {
        const head = splitRow(line);
        if (head.length === al.length) {
          const rows = [];
          let j = i + 2;
          while (j < lines.length && !isBlank(lines[j]) && !interrupts(lines[j])) {
            const r = splitRow(lines[j]);
            while (r.length < al.length) r.push('');
            rows.push(r.slice(0, al.length));
            j++;
          }
          add({ t: 'table', align: al, head, rows });
          i = j;
          continue;
        }
      }
    }
    // paragraph / setext
    const buf = [line.replace(/^[ \t]+/, '')];
    let j = i + 1, setext = 0;
    while (j < lines.length) {
      const l = lines[j];
      if (isBlank(l)) break;
      const sm = /^ {0,3}(=+|-+)[ \t]*$/.exec(l);
      if (sm) { setext = sm[1][0] === '=' ? 1 : 2; j++; break; }
      if (interrupts(l)) break;
      buf.push(l.replace(/^[ \t]+/, ''));
      j++;
    }
    let text = buf.join('\n');
    text = extractRefs(text, refs);
    i = j;
    if (!/\S/.test(text)) {
      if (setext) { /* underline after only definitions: treat as paragraph/hr */ 
        add({ t: 'p', text: setext === 2 ? '' : '=' }); out.pop();
        if (setext === 2) add({ t: 'hr' }); else add({ t: 'p', text: '===' });
      }
      continue;
    }
    text = text.replace(/[ \t]+$/, '').replace(/\n$/, '');
    if (setext) add({ t: 'h', level: setext, text: text.trim() });
    else add({ t: 'p', text });
  }
  return out;
}
function line_slice(l, mk) {
  if (mk.empty) return '';
  return l.slice(mk.contentIndent);
}

// ---------------------------------------------------------------- rendering
function renderBlocks(blocks, ctx, tight) {
  const parts = [];
  for (const b of blocks) {
    switch (b.t) {
      case 'p': {
        const h = parseInline(b.text, ctx.refs);
        parts.push(tight ? h : `<p>${h}</p>`);
        break;
      }
      case 'h': {
        const h = parseInline(b.text, ctx.refs);
        let id = '';
        if (ctx.ids) id = ` id="${escapeHtml(slugify(parseInline(b.text, ctx.refs, true), ctx.seen))}"`;
        parts.push(`<h${b.level}${id}>${h}</h${b.level}>`);
        break;
      }
      case 'hr': parts.push('<hr />'); break;
      case 'code': {
        const lang = b.info.split(/\s+/)[0];
        parts.push(`<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ''}>${escapeHtml(b.text)}</code></pre>`);
        break;
      }
      case 'bq': parts.push(`<blockquote>\n${renderBlocks(b.children, ctx, false)}${b.children.length ? '\n' : ''}</blockquote>`); break;
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        const st = b.ordered && b.start !== 1 ? ` start="${b.start}"` : '';
        const lis = b.items.map(ch => {
          const inner = renderBlocks(ch, ctx, !b.loose);
          return `<li>${!b.loose && ch.length && ch[0].t !== 'p' ? '\n' : ''}${inner}${!b.loose && ch.length && ch[ch.length - 1].t !== 'p' ? '\n' : ''}</li>`;
        });
        parts.push(`<${tag}${st}>\n${lis.join('\n')}\n</${tag}>`);
        break;
      }
      case 'table': {
        const cell = (tag, c, i) => `<${tag}${b.align[i] ? ` align="${b.align[i]}"` : ''}>${parseInline(c, ctx.refs)}</${tag}>`;
        let h = '<table>\n<thead>\n<tr>\n' + b.head.map((c, i) => cell('th', c, i)).join('\n') + '\n</tr>\n</thead>';
        if (b.rows.length) h += '\n<tbody>\n' + b.rows.map(r => '<tr>\n' + r.map((c, i) => cell('td', c, i)).join('\n') + '\n</tr>').join('\n') + '\n</tbody>';
        parts.push(h + '\n</table>');
        break;
      }
    }
  }
  return parts.join('\n');
}

function parseDoc(markdown) {
  const lines = String(markdown).replace(/\r\n?/g, '\n').replace(/\0/g, '�').split('\n').map(expandTabs);
  const refs = new Map();
  const blocks = parseBlocks(lines, refs);
  return { blocks, refs };
}

export function render(markdown, { headingIds = false } = {}) {
  const { blocks, refs } = parseDoc(markdown);
  const out = renderBlocks(blocks, { refs, ids: headingIds, seen: new Map() }, false);
  return out ? out + '\n' : '';
}

export function toc(markdown) {
  const { blocks, refs } = parseDoc(markdown);
  const seen = new Map();
  const res = [];
  const walk = bs => {
    for (const b of bs) {
      if (b.t === 'h') {
        const text = parseInline(b.text, refs, true);
        res.push({ level: b.level, text, slug: slugify(text, seen) });
      } else if (b.t === 'bq') walk(b.children);
      else if (b.t === 'list') b.items.forEach(walk);
    }
  };
  walk(blocks);
  return res;
}
