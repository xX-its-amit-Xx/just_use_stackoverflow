// Safe CommonMark-style Markdown -> HTML renderer (see SPEC.md).
// Written from scratch; no third-party code is reused.

// ---------------------------------------------------------------------------
// Character helpers
// ---------------------------------------------------------------------------

const ASCII_PUNCT = /^[!-\/:-@\[-`{-~]$/;
const UNI_PUNCT = /^[\p{P}\p{S}]$/u;

function isPunct(ch) {
  return ch !== undefined && (ASCII_PUNCT.test(ch) || UNI_PUNCT.test(ch));
}
function isWs(ch) {
  return ch === undefined || /\s/.test(ch);
}

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', trade: '™', mdash: '—', ndash: '–',
  hellip: '…', laquo: '«', raquo: '»', times: '×', divide: '÷',
  euro: '€', pound: '£', yen: '¥', cent: '¢',
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  bull: '•', middot: '·', para: '¶', sect: '§', deg: '°',
};

const ENTITY_BODY = '(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31})';
const ESCAPE_OR_ENTITY_RE = new RegExp(`\\\\([!-\\/:-@\\[-\`{-~])|&${ENTITY_BODY};`, 'g');
const ENTITY_HEAD_RE = new RegExp(`^&${ENTITY_BODY};`);

function decodeEntity(body) {
  if (body[0] === '#') {
    const hex = /[xX]/.test(body[1]);
    const cp = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
    return String.fromCodePoint(cp);
  }
  return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : null;
}

// Resolve backslash escapes and entity references (used for URLs, titles, info strings).
function unescapeString(s) {
  return s.replace(ESCAPE_OR_ENTITY_RE, (m, esc, ent) => {
    if (esc !== undefined) return esc;
    const d = decodeEntity(ent);
    return d === null ? m : d;
  });
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function stripTags(html) {
  return html.replace(/<img [^>]*?alt="([^"]*)"[^>]*>/g, '$1').replace(/<[^>]*>/g, '');
}

function plainText(html) {
  return stripTags(html)
    .replace(/\n/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
}

function normLabel(s) {
  return s.trim().replace(/\s+/g, ' ').toLowerCase();
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

function safeUrl(u) {
  const t = u.replace(/[\u0000- \u007f]/g, '').toLowerCase();
  if (/^(javascript|vbscript|file):/.test(t)) return '#';
  if (/^data:/.test(t) && !/^data:image\/(png|gif|jpeg|webp);/.test(t)) return '#';
  return u;
}

function normalizeUrl(u) {
  try {
    return encodeURI(u.replace(/%(?![0-9A-Fa-f]{2})/g, '%25'));
  } catch {
    return u;
  }
}

function hrefAttr(raw) {
  return escapeHtml(normalizeUrl(safeUrl(raw)));
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

const RE = {
  blank: /^[ \t]*$/,
  atx: /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/,
  fence: /^( {0,3})(`{3,}|~{3,})(.*)$/,
  fenceClose: /^ {0,3}(`+|~+)[ \t]*$/,
  hr: /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/,
  quote: /^ {0,3}>/,
  setext: /^ {0,3}(=+|-+)[ \t]*$/,
};

const REF_DEF = /^ {0,3}\[((?:[^\\\[\]]|\\.)+)\]:[ \t]*(<[^<>\n]*>|\S+)(?:[ \t]+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\)))?[ \t]*$/;
const DELIM_ROW = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

function expandTabs(line) {
  if (!line.includes('\t')) return line;
  let out = '';
  for (const ch of line) {
    if (ch === '\t') out += ' '.repeat(4 - (out.length % 4));
    else out += ch;
  }
  return out;
}

function indentOf(line) {
  return /^ */.exec(line)[0].length;
}

// Returns list-item marker info if the line opens a list item, else null.
function matchItem(line) {
  const m = /^( {0,3})([-*+]|(\d{1,9})([.)]))(?=[ \t]|$)/.exec(line);
  if (!m) return null;
  const marker = m[2];
  const start = m[1].length + marker.length;
  const rest = line.slice(start);
  const spaces = /^ */.exec(rest)[0].length;
  const blank = spaces === rest.length;
  const offset = blank || spaces >= 5 ? start + 1 : start + spaces;
  const ordered = m[3] !== undefined;
  return {
    ordered,
    num: ordered ? parseInt(m[3], 10) : 0,
    key: ordered ? 'o' + m[4] : 'b' + marker,
    offset,
    blank,
    first: blank ? '' : line.slice(offset),
  };
}

// Lines that may interrupt a paragraph (or end a lazy continuation).
function startsBlock(line) {
  if (RE.atx.test(line) || RE.fence.test(line) || RE.hr.test(line) || RE.quote.test(line)) return true;
  const m = matchItem(line);
  return !!m && !m.blank && (!m.ordered || m.num === 1);
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === '\\' && k + 1 < s.length) {
      cur += ch + s[k + 1];
      k++;
    } else if (ch === '|') {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += ch;
    }
  }
  cells.push(cur.trim());
  return cells;
}

function parseDelimRow(line) {
  if (!DELIM_ROW.test(line)) return null;
  return splitRow(line).map(c => {
    const l = c.startsWith(':');
    const r = c.endsWith(':');
    return l && r ? 'center' : l ? 'left' : r ? 'right' : null;
  });
}

function parseRefDef(line) {
  const m = REF_DEF.exec(line);
  if (!m || !m[1].trim()) return null;
  let dest = m[2];
  if (dest[0] === '<') dest = dest.slice(1, -1);
  const title = m[3] ? unescapeString(m[3].slice(1, -1)) : null;
  return { key: normLabel(m[1]), href: unescapeString(dest), title };
}

// Collect the lines belonging to one list item. Body[k] corresponds to lines[i + k].
function collectItem(lines, i, m) {
  const body = [m.first];
  let last = i;
  let j = i + 1;
  while (j < lines.length) {
    const line = lines[j];
    if (RE.blank.test(line)) {
      if (m.blank && j === i + 1) break;
      body.push('');
      j++;
      continue;
    }
    if (indentOf(line) >= m.offset) {
      body.push(line.slice(m.offset));
      last = j;
      j++;
      continue;
    }
    // Lazy paragraph continuation.
    if (body[body.length - 1] !== '' && !startsBlock(line) && !matchItem(line)) {
      body.push(line.trimStart());
      last = j;
      j++;
      continue;
    }
    break;
  }
  return { body: body.slice(0, last - i + 1), end: last + 1 };
}

function parseList(lines, i, first, ctx) {
  const list = { type: 'list', ordered: first.ordered, start: first.num, loose: false, items: [] };
  const finish = end => {
    list.loose = list.loose || list.items.some(it =>
      it.children.some((c, ci) => ci > 0 && c.blankBefore));
    return { node: list, end };
  };
  let m = first;
  let idx = i;
  for (;;) {
    const { body, end } = collectItem(lines, idx, m);
    list.items.push({ children: parseBlocks(body, ctx) });
    let k = end;
    while (k < lines.length && RE.blank.test(lines[k])) k++;
    const next = k < lines.length ? matchItem(lines[k]) : null;
    if (!next || next.key !== m.key || RE.hr.test(lines[k])) return finish(end);
    if (k > end) list.loose = true;
    m = next;
    idx = k;
  }
}

function parseBlocks(lines, ctx) {
  const out = [];
  let blank = false;
  const push = node => {
    node.blankBefore = blank;
    blank = false;
    out.push(node);
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (RE.blank.test(line)) {
      blank = true;
      i++;
      continue;
    }

    // Indented code block.
    if (indentOf(line) >= 4) {
      const buf = [];
      let j = i;
      while (j < lines.length && (RE.blank.test(lines[j]) || indentOf(lines[j]) >= 4)) {
        buf.push(RE.blank.test(lines[j]) ? '' : lines[j].slice(4));
        j++;
      }
      let end = buf.length;
      while (end > 0 && buf[end - 1] === '') end--;
      push({ type: 'code', info: '', text: end ? buf.slice(0, end).join('\n') + '\n' : '' });
      i += end;
      continue;
    }

    let m;

    // Fenced code block.
    if ((m = RE.fence.exec(line)) && !(m[2][0] === '`' && m[3].includes('`'))) {
      const fi = m[1].length;
      const fch = m[2][0];
      const flen = m[2].length;
      const buf = [];
      let j = i + 1;
      let closed = false;
      while (j < lines.length) {
        const cm = RE.fenceClose.exec(lines[j]);
        if (cm && cm[1][0] === fch && cm[1].length >= flen) { closed = true; break; }
        buf.push(lines[j].replace(new RegExp(`^ {0,${fi}}`), ''));
        j++;
      }
      push({
        type: 'code',
        info: unescapeString(m[3].trim()),
        text: buf.length ? buf.join('\n') + '\n' : '',
      });
      i = closed ? j + 1 : j;
      continue;
    }

    // ATX heading.
    if ((m = RE.atx.exec(line))) {
      const text = (m[2] || '').replace(/(?:^|[ \t]+)#+[ \t]*$/, '').trim();
      push({ type: 'heading', level: m[1].length, text });
      i++;
      continue;
    }

    // Thematic break.
    if (RE.hr.test(line)) {
      push({ type: 'hr' });
      i++;
      continue;
    }

    // Blockquote.
    if (RE.quote.test(line)) {
      const buf = [];
      let j = i;
      while (j < lines.length) {
        const l = lines[j];
        if (RE.quote.test(l)) {
          buf.push(l.replace(/^ {0,3}> ?/, ''));
          j++;
          continue;
        }
        if (!RE.blank.test(l) && buf.length && !RE.blank.test(buf[buf.length - 1]) && !startsBlock(l)) {
          buf.push(l);
          j++;
          continue;
        }
        break;
      }
      push({ type: 'quote', children: parseBlocks(buf, ctx) });
      i = j;
      continue;
    }

    // List.
    if (!RE.hr.test(line) && (m = matchItem(line))) {
      const r = parseList(lines, i, m, ctx);
      push(r.node);
      i = r.end;
      continue;
    }

    // GFM table.
    const align = i + 1 < lines.length ? parseDelimRow(lines[i + 1]) : null;
    if (align && (line.includes('|') || lines[i + 1].includes('|'))) {
      const head = splitRow(line);
      if (head.length === align.length) {
        const rows = [];
        let j = i + 2;
        while (j < lines.length && !RE.blank.test(lines[j]) && !startsBlock(lines[j])) {
          rows.push(splitRow(lines[j]));
          j++;
        }
        push({ type: 'table', align, head, rows });
        i = j;
        continue;
      }
    }

    // Paragraph (possibly a setext heading).
    const para = [line.trimStart()];
    let j = i + 1;
    let setext = 0;
    while (j < lines.length) {
      const l = lines[j];
      if (RE.blank.test(l)) break;
      const su = RE.setext.exec(l);
      if (su) {
        setext = su[1][0] === '=' ? 1 : 2;
        j++;
        break;
      }
      if (startsBlock(l)) break;
      para.push(l.trimStart());
      j++;
    }
    if (!setext) {
      while (para.length) {
        const d = parseRefDef(para[0]);
        if (!d) break;
        if (!ctx.refs.has(d.key)) ctx.refs.set(d.key, { href: d.href, title: d.title });
        para.shift();
      }
    }
    if (setext) {
      push({ type: 'heading', level: setext, text: para.join('\n').trim() });
    } else if (para.length) {
      push({ type: 'paragraph', text: para.join('\n').trimEnd() });
    }
    i = j;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

const AUTO_URI = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\u0000- ]*)>/;
const AUTO_MAIL = /^<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/;

const isDelim = x => typeof x === 'object' && x !== null && x.kind === 'delim';
const isBracket = x => typeof x === 'object' && x !== null && x.kind === 'bracket';

// CommonMark "process emphasis" over nodes[start..]. Leaves only strings behind.
function processEmphasis(nodes, start) {
  let ci = start;
  for (;;) {
    let closer = -1;
    for (let k = ci; k < nodes.length; k++) {
      const x = nodes[k];
      if (isDelim(x) && x.canClose && x.n > 0) { closer = k; break; }
    }
    if (closer < 0) break;
    const cl = nodes[closer];
    let op = -1;
    for (let k = closer - 1; k >= start; k--) {
      const x = nodes[k];
      if (!isDelim(x) || x.ch !== cl.ch || !x.canOpen || x.n === 0) continue;
      if (cl.ch !== '~' && (x.canClose || cl.canOpen) &&
          (x.orig + cl.orig) % 3 === 0 && !(x.orig % 3 === 0 && cl.orig % 3 === 0)) continue;
      op = k;
      break;
    }
    if (op < 0) {
      cl.canClose = false;
      ci = closer + 1;
      continue;
    }
    const o = nodes[op];
    const use = cl.ch === '~' ? 2 : (o.n >= 2 && cl.n >= 2 ? 2 : 1);
    const tag = cl.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em';
    o.n -= use;
    cl.n -= use;
    // Delimiters between opener and closer become literal text.
    for (let k = op + 1; k < closer; k++) {
      const x = nodes[k];
      if (isDelim(x)) nodes[k] = x.ch.repeat(x.n);
      else if (isBracket(x)) nodes[k] = x.image ? '![' : '[';
    }
    nodes.splice(closer, 0, `</${tag}>`);
    nodes.splice(op + 1, 0, `<${tag}>`);
    const closerNow = closer + 2;
    if (o.n === 0) nodes[op] = '';
    if (cl.n === 0) {
      nodes[closerNow] = '';
      ci = closerNow + 1;
    } else {
      ci = closerNow;
    }
  }
  for (let k = start; k < nodes.length; k++) {
    const x = nodes[k];
    if (typeof x === 'object' && x !== null) {
      nodes[k] = x.kind === 'delim' ? x.ch.repeat(x.n) : (x.image ? '![' : '[');
    }
  }
}

function findBacktickRun(src, from, run) {
  let idx = src.indexOf('`', from);
  while (idx >= 0) {
    let r = 0;
    while (src[idx + r] === '`') r++;
    if (r === run) return idx;
    idx = src.indexOf('`', idx + r);
  }
  return -1;
}

function skipWs(src, q) {
  while (q < src.length && (src[q] === ' ' || src[q] === '\t' || src[q] === '\n')) q++;
  return q;
}

// Parses "(dest "title")" starting just after the '('.
function parseInlineTail(src, q) {
  let r = skipWs(src, q);
  let dest = '';
  if (src[r] === '<') {
    let e = r + 1;
    while (e < src.length && src[e] !== '>' && src[e] !== '\n' && src[e] !== '<') {
      if (src[e] === '\\') e++;
      e++;
    }
    if (src[e] !== '>') return null;
    dest = src.slice(r + 1, e);
    r = e + 1;
  } else {
    let e = r;
    let depth = 0;
    while (e < src.length) {
      const ch = src[e];
      if (ch === '\\' && e + 1 < src.length && isPunct(src[e + 1])) { e += 2; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') { if (depth === 0) break; depth--; }
      else if (/[\s\u0000-\u001f]/.test(ch)) break;
      e++;
    }
    dest = src.slice(r, e);
    r = e;
  }
  const before = r;
  r = skipWs(src, r);
  let title = null;
  if (r > before && (src[r] === '"' || src[r] === "'" || src[r] === '(')) {
    const close = src[r] === '(' ? ')' : src[r];
    let e = r + 1;
    while (e < src.length && src[e] !== close) {
      if (src[e] === '\\') e++;
      e++;
    }
    if (e >= src.length) return null;
    title = src.slice(r + 1, e);
    r = skipWs(src, e + 1);
  }
  if (src[r] !== ')') return null;
  return { dest, title, end: r + 1 };
}

function parseRefLabel(src, p) {
  let e = p + 1;
  while (e < src.length && src[e] !== ']' && src[e] !== '[') {
    if (src[e] === '\\') e++;
    e++;
  }
  if (src[e] !== ']' || e - p - 1 > 999) return null;
  return { label: src.slice(p + 1, e), end: e + 1 };
}

// p is the index just after the closing ']'.
function resolveLink(src, p, raw, ctx) {
  if (src[p] === '(') {
    const t = parseInlineTail(src, p + 1);
    if (t) {
      return {
        href: unescapeString(t.dest),
        title: t.title !== null ? unescapeString(t.title) : null,
        end: t.end,
      };
    }
  }
  if (src[p] === '[') {
    const lab = parseRefLabel(src, p);
    if (lab) {
      const key = lab.label.trim() ? lab.label : raw;
      const d = ctx.refs.get(normLabel(key));
      if (d) return { href: d.href, title: d.title, end: lab.end };
      if (lab.label.trim()) return null;
      return null;
    }
  }
  const d = ctx.refs.get(normLabel(raw));
  if (d) return { href: d.href, title: d.title, end: p };
  return null;
}

function inline(src, ctx) {
  const nodes = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      nodes.push(escapeHtml(buf));
      buf = '';
    }
  };
  const n = src.length;
  let p = 0;
  while (p < n) {
    const c = src[p];

    if (c === '\n') {
      const sp = /( *)$/.exec(buf)[1].length;
      buf = buf.slice(0, buf.length - sp);
      flush();
      nodes.push(sp >= 2 ? '<br />\n' : '\n');
      p++;
      while (src[p] === ' ' || src[p] === '\t') p++;
      continue;
    }

    if (c === '\\') {
      const d = src[p + 1];
      if (d === '\n') {
        flush();
        nodes.push('<br />\n');
        p += 2;
        while (src[p] === ' ' || src[p] === '\t') p++;
        continue;
      }
      if (d !== undefined && ASCII_PUNCT.test(d)) {
        buf += d;
        p += 2;
        continue;
      }
      buf += c;
      p++;
      continue;
    }

    if (c === '`') {
      let run = 1;
      while (src[p + run] === '`') run++;
      const close = findBacktickRun(src, p + run, run);
      if (close < 0) {
        buf += '`'.repeat(run);
        p += run;
        continue;
      }
      flush();
      let content = src.slice(p + run, close).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      nodes.push(`<code>${escapeHtml(content)}</code>`);
      p = close + run;
      continue;
    }

    if (c === '*' || c === '_' || c === '~') {
      let run = 1;
      while (src[p + run] === c) run++;
      if (c === '~' && run !== 2) {
        buf += c.repeat(run);
        p += run;
        continue;
      }
      const prev = p > 0 ? src[p - 1] : undefined;
      const next = src[p + run];
      const lf = !isWs(next) && (!isPunct(next) || isWs(prev) || isPunct(prev));
      const rf = !isWs(prev) && (!isPunct(prev) || isWs(next) || isPunct(next));
      let canOpen;
      let canClose;
      if (c === '_') {
        canOpen = lf && (!rf || isPunct(prev));
        canClose = rf && (!lf || isPunct(next));
      } else {
        canOpen = lf;
        canClose = rf;
      }
      flush();
      nodes.push({ kind: 'delim', ch: c, n: run, orig: run, canOpen, canClose });
      p += run;
      continue;
    }

    if (c === '!' && src[p + 1] === '[') {
      flush();
      nodes.push({ kind: 'bracket', image: true, active: true, pos: p + 2 });
      p += 2;
      continue;
    }

    if (c === '[') {
      flush();
      nodes.push({ kind: 'bracket', image: false, active: true, pos: p + 1 });
      p++;
      continue;
    }

    if (c === ']') {
      flush();
      p++;
      let bi = -1;
      for (let k = nodes.length - 1; k >= 0; k--) {
        if (isBracket(nodes[k])) { bi = k; break; }
      }
      if (bi < 0) {
        nodes.push(']');
        continue;
      }
      const br = nodes[bi];
      const literal = () => {
        nodes[bi] = br.image ? '![' : '[';
        nodes.push(']');
      };
      if (!br.active) {
        literal();
        continue;
      }
      const raw = src.slice(br.pos, p - 1);
      const link = resolveLink(src, p, raw, ctx);
      if (!link) {
        literal();
        continue;
      }
      processEmphasis(nodes, bi + 1);
      const inner = nodes.splice(bi + 1).join('');
      const href = hrefAttr(link.href);
      const titleAttr = link.title !== null ? ` title="${escapeHtml(link.title)}"` : '';
      if (br.image) {
        nodes[bi] = `<img src="${href}" alt="${stripTags(inner)}"${titleAttr} />`;
      } else {
        for (let k = 0; k < bi; k++) {
          if (isBracket(nodes[k]) && !nodes[k].image) nodes[k].active = false;
        }
        nodes[bi] = `<a href="${href}"${titleAttr}>${inner}</a>`;
      }
      p = link.end;
      continue;
    }

    if (c === '<') {
      const rest = src.slice(p);
      let m = AUTO_URI.exec(rest);
      if (m) {
        flush();
        nodes.push(`<a href="${hrefAttr(m[1])}">${escapeHtml(m[1])}</a>`);
        p += m[0].length;
        continue;
      }
      m = AUTO_MAIL.exec(rest);
      if (m) {
        flush();
        nodes.push(`<a href="${hrefAttr('mailto:' + m[1])}">${escapeHtml(m[1])}</a>`);
        p += m[0].length;
        continue;
      }
      buf += c;
      p++;
      continue;
    }

    if (c === '&') {
      const m = ENTITY_HEAD_RE.exec(src.slice(p, p + 40));
      if (m) {
        const d = decodeEntity(m[1]);
        if (d !== null) {
          buf += d;
          p += m[0].length;
          continue;
        }
      }
      buf += c;
      p++;
      continue;
    }

    buf += c;
    p++;
  }
  flush();
  processEmphasis(nodes, 0);
  return nodes.join('');
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderTable(t, ctx) {
  const n = t.head.length;
  const al = i => (t.align[i] ? ` align="${t.align[i]}"` : '');
  let s = '<table>\n<thead>\n<tr>\n';
  s += t.head.map((c, i) => `<th${al(i)}>${inline(c, ctx)}</th>\n`).join('');
  s += '</tr>\n</thead>\n';
  if (t.rows.length) {
    s += '<tbody>\n';
    for (const r of t.rows) {
      s += '<tr>\n';
      for (let i = 0; i < n; i++) {
        s += `<td${al(i)}>${i < r.length ? inline(r[i], ctx) : ''}</td>\n`;
      }
      s += '</tr>\n';
    }
    s += '</tbody>\n';
  }
  return s + '</table>\n';
}

function renderBlocks(blocks, ctx, tight, st) {
  return blocks.map(b => renderBlock(b, ctx, tight, st)).join('');
}

function renderBlock(b, ctx, tight, st) {
  switch (b.type) {
    case 'paragraph': {
      const h = inline(b.text, ctx);
      return tight ? h + '\n' : `<p>${h}</p>\n`;
    }
    case 'heading': {
      const h = inline(b.text, ctx);
      const id = st.headingIds ? ` id="${escapeHtml(slugify(plainText(h), st.seen))}"` : '';
      return `<h${b.level}${id}>${h}</h${b.level}>\n`;
    }
    case 'code': {
      const cls = b.info ? ` class="language-${escapeHtml(b.info.split(/\s+/)[0])}"` : '';
      return `<pre><code${cls}>${escapeHtml(b.text)}</code></pre>\n`;
    }
    case 'hr':
      return '<hr />\n';
    case 'quote':
      return `<blockquote>\n${renderBlocks(b.children, ctx, false, st)}</blockquote>\n`;
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      const open = b.ordered && b.start !== 1 ? `<ol start="${b.start}">` : `<${tag}>`;
      const items = b.items
        .map(it => `<li>${renderBlocks(it.children, ctx, !b.loose, st)}</li>\n`)
        .join('');
      return `${open}\n${items}</${tag}>\n`;
    }
    case 'table':
      return renderTable(b, ctx);
    default:
      return '';
  }
}

function parseDocument(markdown) {
  const ctx = { refs: new Map() };
  const lines = String(markdown)
    .replace(/\r\n?/g, '\n')
    .replace(/\0/g, '�')
    .split('\n')
    .map(expandTabs);
  return { blocks: parseBlocks(lines, ctx), ctx };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function slugify(text, seen) {
  const base = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-');
  if (!seen) return base;
  if (!seen.has(base)) {
    seen.set(base, 1);
    return base;
  }
  let k = seen.get(base);
  let cand;
  do {
    cand = `${base}-${k}`;
    k++;
  } while (seen.has(cand));
  seen.set(base, k);
  seen.set(cand, 1);
  return cand;
}

export function render(markdown, { headingIds = false } = {}) {
  const { blocks, ctx } = parseDocument(markdown);
  return renderBlocks(blocks, ctx, false, { headingIds, seen: new Map() });
}

function collectHeadings(blocks, ctx, out) {
  for (const b of blocks) {
    if (b.type === 'heading') out.push(b);
    else if (b.type === 'quote') collectHeadings(b.children, ctx, out);
    else if (b.type === 'list') for (const it of b.items) collectHeadings(it.children, ctx, out);
  }
  return out;
}

export function toc(markdown) {
  const { blocks, ctx } = parseDocument(markdown);
  const seen = new Map();
  return collectHeadings(blocks, ctx, []).map(b => {
    const text = plainText(inline(b.text, ctx));
    return { level: b.level, text, slug: slugify(text, seen) };
  });
}
