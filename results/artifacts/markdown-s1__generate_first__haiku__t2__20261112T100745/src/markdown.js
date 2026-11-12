// Minimal CommonMark-subset Markdown -> HTML renderer.
// Original implementation written for this project (no third-party code).

const ASCII_PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~');

const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const ATX_RE = /^ {0,3}(#{1,6})(?=[ \t]|$)(.*)$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CLOSE_FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const LIST_RE = /^( {0,3})([-*+]|(\d{1,9})([.)]))([ \t]+|$)(.*)$/;
const QUOTE_RE = /^ {0,3}>/;
const QUOTE_LINE_RE = /^ {0,3}> ?(.*)$/;
const SETEXT_RE = /^ {0,3}(=+|-+)[ \t]*$/;

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', mdash: '—', ndash: '–', hellip: '…',
};

// ---------- small helpers ----------

export function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function decodeEntity(body) {
  if (body[0] === '#') {
    const hex = body[1] === 'x' || body[1] === 'X';
    const cp = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!Number.isFinite(cp) || cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
    return String.fromCodePoint(cp);
  }
  return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : null;
}

// Resolve backslash escapes and entity references (used for URLs, titles, info strings).
function unescapeString(str) {
  return str.replace(/\\(.)|&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g, (m0, esc, ent) => {
    if (esc !== undefined) return ASCII_PUNCT.has(esc) ? esc : m0;
    const d = decodeEntity(ent);
    return d === null ? m0 : d;
  });
}

function normalizeUrl(u) {
  let out = '';
  for (let k = 0; k < u.length; k++) {
    const ch = u[k];
    if (ch === '%' && /^[0-9A-Fa-f]{2}$/.test(u.slice(k + 1, k + 3))) { out += ch; continue; }
    if (/[A-Za-z0-9;/?:@&=+$,\-_.!~*'()#]/.test(ch)) { out += ch; continue; }
    const cp = u.codePointAt(k);
    const chStr = String.fromCodePoint(cp);
    if (cp > 0xffff) k++;
    out += encodeURIComponent(chStr);
  }
  return out;
}

const isBlank = (l) => /^[ \t]*$/.test(l);
const leadingSpaces = (l) => /^ */.exec(l)[0].length;

function expandLeadingTabs(line) {
  const lead = /^[ \t]*/.exec(line)[0];
  if (!lead.includes('\t')) return line;
  let out = '';
  for (const ch of lead) out += ch === '\t' ? ' '.repeat(4 - (out.length % 4)) : ' ';
  return out + line.slice(lead.length);
}

function isWsChar(c) {
  return c === undefined || c === '\n' || /\s/.test(c);
}
function isPunctChar(c) {
  return c !== undefined && (ASCII_PUNCT.has(c) || /[\p{P}\p{S}]/u.test(c));
}

function fenceOpen(line) {
  const m = FENCE_RE.exec(line);
  if (!m) return null;
  if (m[1][0] === '`' && m[2].includes('`')) return null;
  return m;
}

function listStart(line) {
  const m = LIST_RE.exec(line);
  if (!m) return null;
  const ordered = m[3] !== undefined;
  return {
    m,
    ordered,
    bullet: ordered ? null : m[2],
    delim: ordered ? m[4] : null,
    num: ordered ? parseInt(m[3], 10) : null,
    empty: m[6] === '',
    indentLen: m[1].length,
  };
}

// Lines that may interrupt a paragraph (or end a lazy continuation).
function startsBlock(line) {
  if (ATX_RE.test(line) || fenceOpen(line) || HR_RE.test(line) || QUOTE_RE.test(line)) return true;
  const ls = listStart(line);
  return !!ls && !ls.empty && (!ls.ordered || ls.num === 1);
}

// ---------- block parsing ----------

function joinParagraph(lines) {
  return lines.map((l) => l.trimStart()).join('\n').trimEnd();
}

function parseItem(lines, start, ls) {
  const len = lines.length;
  const markerEnd = ls.indentLen + ls.m[2].length;
  const spaces = ls.m[5].length;
  let W;
  let first;
  if (ls.empty) { W = markerEnd + 1; first = ''; }
  else if (spaces >= 5) { W = markerEnd + 1; first = ' '.repeat(spaces - 1) + ls.m[6]; }
  else { W = markerEnd + spaces; first = ls.m[6]; }

  const itemLines = [first];
  let keep = 1;
  let end = start + 1;
  let i = start + 1;
  while (i < len) {
    const l = lines[i];
    if (isBlank(l)) {
      if (ls.empty && itemLines.length === 1) break;
      itemLines.push('');
      i++;
      continue;
    }
    if (leadingSpaces(l) >= W) {
      itemLines.push(l.slice(W));
      i++;
      keep = itemLines.length;
      end = i;
      continue;
    }
    // lazy paragraph continuation
    if (keep === itemLines.length && !startsBlock(l) && !listStart(l)) {
      itemLines.push(l.trimStart());
      i++;
      keep = itemLines.length;
      end = i;
      continue;
    }
    break;
  }
  itemLines.length = keep;
  const sub = parseBlocks(itemLines);
  return { item: { children: sub.blocks, loose: sub.loose, blankAfter: false }, next: end };
}

function parseBlocks(lines) {
  const blocks = [];
  const len = lines.length;
  let loose = false;
  let sawBlank = false;
  let i = 0;
  const push = (b) => {
    if (sawBlank && blocks.length) loose = true;
    sawBlank = false;
    blocks.push(b);
  };

  while (i < len) {
    const line = lines[i];
    if (isBlank(line)) { sawBlank = true; i++; continue; }

    // fenced code block
    const fm = fenceOpen(line);
    if (fm) {
      const fence = fm[1];
      const fch = fence[0];
      const lead = leadingSpaces(line);
      const info = fm[2].trim();
      const content = [];
      i++;
      while (i < len) {
        const l = lines[i];
        const cm = CLOSE_FENCE_RE.exec(l);
        if (cm && cm[1][0] === fch && cm[1].length >= fence.length) { i++; break; }
        content.push(l.slice(Math.min(lead, leadingSpaces(l))));
        i++;
      }
      push({ type: 'code', info, lines: content });
      continue;
    }

    // indented code block
    if (leadingSpaces(line) >= 4) {
      const content = [];
      let j = i;
      let endIdx = i;
      while (j < len && (isBlank(lines[j]) || leadingSpaces(lines[j]) >= 4)) {
        const l = lines[j];
        content.push(isBlank(l) ? '' : l.slice(4));
        j++;
        if (!isBlank(l)) endIdx = j;
      }
      content.length = endIdx - i;
      push({ type: 'code', info: '', lines: content });
      i = endIdx;
      continue;
    }

    // ATX heading
    const am = ATX_RE.exec(line);
    if (am) {
      const text = am[2].trim().replace(/(^|[ \t]+)#+$/, '').trim();
      push({ type: 'heading', level: am[1].length, text });
      i++;
      continue;
    }

    // thematic break
    if (HR_RE.test(line)) {
      push({ type: 'hr' });
      i++;
      continue;
    }

    // blockquote
    if (QUOTE_RE.test(line)) {
      const inner = [];
      while (i < len) {
        const l = lines[i];
        const qm = QUOTE_LINE_RE.exec(l);
        if (qm) { inner.push(qm[1]); i++; continue; }
        if (!isBlank(l) && inner.length && !isBlank(inner[inner.length - 1]) && !startsBlock(l)) {
          inner.push(l);
          i++;
          continue;
        }
        break;
      }
      push({ type: 'quote', children: parseBlocks(inner).blocks });
      continue;
    }

    // list
    const ls0 = listStart(line);
    if (ls0) {
      const list = {
        type: 'list',
        ordered: ls0.ordered,
        bullet: ls0.bullet,
        delim: ls0.delim,
        start: ls0.num,
        items: [],
        loose: false,
      };
      let cur = ls0;
      for (;;) {
        const { item, next } = parseItem(lines, i, cur);
        list.items.push(item);
        i = next;
        let k = i;
        while (k < len && isBlank(lines[k])) k++;
        const nx = k < len ? listStart(lines[k]) : null;
        const same = nx && nx.ordered === list.ordered
          && (list.ordered ? nx.delim === list.delim : nx.bullet === list.bullet);
        if (same && nx.indentLen <= 3) {
          item.blankAfter = k > i;
          i = k;
          cur = nx;
          continue;
        }
        break;
      }
      list.loose = list.items.some((it) => it.blankAfter || it.loose);
      push(list);
      continue;
    }

    // paragraph (possibly a setext heading)
    const pLines = [line];
    i++;
    let setext = 0;
    while (i < len) {
      const l = lines[i];
      if (isBlank(l)) break;
      const sm = SETEXT_RE.exec(l);
      if (sm) { setext = sm[1][0] === '=' ? 1 : 2; i++; break; }
      if (startsBlock(l)) break;
      pLines.push(l);
      i++;
    }
    if (setext) push({ type: 'heading', level: setext, text: joinParagraph(pLines) });
    else push({ type: 'para', text: joinParagraph(pLines) });
  }

  return { blocks, loose };
}

// ---------- inline parsing ----------

function raw(html, plain = '') {
  return { t: 'raw', s: html, plain };
}

function renderNode(nd) {
  switch (nd.t) {
    case 'text': return escapeHtml(nd.s);
    case 'raw': return nd.s;
    case 'delim': return escapeHtml(nd.ch.repeat(nd.n));
    case 'bracket': return escapeHtml(nd.img ? '![' : '[');
    default: return '';
  }
}

function plainOf(nd) {
  switch (nd.t) {
    case 'text': return nd.s;
    case 'raw': return nd.plain;
    case 'delim': return nd.ch.repeat(nd.n);
    case 'bracket': return nd.img ? '![' : '[';
    default: return '';
  }
}

// CommonMark "process emphasis": pairs delimiter runs and splices in tags.
function processEmphasis(nodes, bottom) {
  let ci = bottom + 1;
  while (ci < nodes.length) {
    const c = nodes[ci];
    if (c.t !== 'delim' || !c.canClose || c.n === 0) { ci++; continue; }
    let oi = -1;
    for (let k = ci - 1; k > bottom; k--) {
      const o = nodes[k];
      if (o.t !== 'delim' || o.ch !== c.ch || !o.canOpen || o.n === 0) continue;
      if ((o.canClose || c.canOpen) && (o.orig + c.orig) % 3 === 0 && !(o.orig % 3 === 0 && c.orig % 3 === 0)) continue;
      oi = k;
      break;
    }
    if (oi < 0) { ci++; continue; }

    const o = nodes[oi];
    const use = o.n >= 2 && c.n >= 2 ? 2 : 1;
    o.n -= use;
    c.n -= use;
    for (let k = oi + 1; k < ci; k++) {
      const d = nodes[k];
      if (d.t === 'delim') nodes[k] = { t: 'text', s: d.ch.repeat(d.n) };
    }
    nodes.splice(ci, 0, raw(use === 2 ? '</strong>' : '</em>'));
    nodes.splice(oi + 1, 0, raw(use === 2 ? '<strong>' : '<em>'));
    ci += 2; // the closer has shifted right by two
    if (c.n === 0) ci++;
  }
}

function parseLinkTail(s, p) {
  // s[p] === '('
  let q = p + 1;
  const skipWs = () => {
    while (q < s.length && (s[q] === ' ' || s[q] === '\t')) q++;
    if (s[q] === '\n') {
      q++;
      while (q < s.length && (s[q] === ' ' || s[q] === '\t')) q++;
    }
  };
  skipWs();
  let url = '';
  if (s[q] === '<') {
    let r = q + 1;
    while (r < s.length && s[r] !== '>' && s[r] !== '\n' && s[r] !== '<') {
      if (s[r] === '\\' && ASCII_PUNCT.has(s[r + 1])) r += 2;
      else r++;
    }
    if (s[r] !== '>') return null;
    url = s.slice(q + 1, r);
    q = r + 1;
  } else {
    const start = q;
    let depth = 0;
    while (q < s.length) {
      const c = s[q];
      if (c === '\\' && ASCII_PUNCT.has(s[q + 1])) { q += 2; continue; }
      if (c === ' ' || c === '\t' || c === '\n' || c.charCodeAt(0) < 32) break;
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      }
      q++;
    }
    if (depth !== 0) return null;
    url = s.slice(start, q);
  }
  const before = q;
  skipWs();
  let title = null;
  if (q > before && (s[q] === '"' || s[q] === "'" || s[q] === '(')) {
    const close = s[q] === '(' ? ')' : s[q];
    let r = q + 1;
    while (r < s.length && s[r] !== close) {
      if (s[r] === '\\' && ASCII_PUNCT.has(s[r + 1])) r += 2;
      else r++;
    }
    if (r >= s.length) return null;
    title = unescapeString(s.slice(q + 1, r));
    q = r + 1;
    skipWs();
  }
  if (s[q] !== ')') return null;
  return { url: unescapeString(url), title, end: q + 1 };
}

function parseInline(s) {
  const nodes = [];
  const pushText = (str) => {
    const last = nodes[nodes.length - 1];
    if (last && last.t === 'text') last.s += str;
    else nodes.push({ t: 'text', s: str });
  };
  const n = s.length;
  let i = 0;
  while (i < n) {
    const c = s[i];

    if (c === '\\') {
      const nx = s[i + 1];
      if (nx === '\n') { nodes.push(raw('<br />\n')); i += 2; continue; }
      if (nx !== undefined && ASCII_PUNCT.has(nx)) { pushText(nx); i += 2; continue; }
      pushText('\\');
      i++;
      continue;
    }

    if (c === '`') {
      let j = i;
      while (s[j] === '`') j++;
      const len = j - i;
      let k = j;
      let found = -1;
      while (k < n) {
        if (s[k] === '`') {
          let e = k;
          while (s[e] === '`') e++;
          if (e - k === len) { found = k; break; }
          k = e;
        } else {
          k++;
        }
      }
      if (found < 0) { pushText('`'.repeat(len)); i = j; continue; }
      let content = s.slice(j, found).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      nodes.push(raw(`<code>${escapeHtml(content)}</code>`, content));
      i = found + len;
      continue;
    }

    if (c === '*' || c === '_') {
      let j = i;
      while (s[j] === c) j++;
      const before = i > 0 ? s[i - 1] : undefined;
      const after = s[j];
      const bWs = isWsChar(before);
      const aWs = isWsChar(after);
      const bP = isPunctChar(before);
      const aP = isPunctChar(after);
      const left = !aWs && (!aP || bWs || bP);
      const right = !bWs && (!bP || aWs || aP);
      const canOpen = c === '*' ? left : left && (!right || bP);
      const canClose = c === '*' ? right : right && (!left || aP);
      nodes.push({ t: 'delim', ch: c, n: j - i, orig: j - i, canOpen, canClose });
      i = j;
      continue;
    }

    if (c === '!' && s[i + 1] === '[') {
      nodes.push({ t: 'bracket', img: true, active: true });
      i += 2;
      continue;
    }
    if (c === '[') {
      nodes.push({ t: 'bracket', img: false, active: true });
      i++;
      continue;
    }
    if (c === ']') {
      let bi = -1;
      for (let k = nodes.length - 1; k >= 0; k--) {
        if (nodes[k].t === 'bracket') { bi = k; break; }
      }
      if (bi < 0) { pushText(']'); i++; continue; }
      const br = nodes[bi];
      const tail = br.active && s[i + 1] === '(' ? parseLinkTail(s, i + 1) : null;
      if (!tail) {
        nodes[bi] = { t: 'text', s: br.img ? '![' : '[' };
        pushText(']');
        i++;
        continue;
      }
      processEmphasis(nodes, bi);
      for (let k = bi + 1; k < nodes.length; k++) {
        const d = nodes[k];
        if (d.t === 'delim') nodes[k] = { t: 'text', s: d.ch.repeat(d.n) };
      }
      const urlAttr = escapeHtml(normalizeUrl(tail.url));
      const titleAttr = tail.title === null ? '' : ` title="${escapeHtml(tail.title)}"`;
      if (br.img) {
        const alt = nodes.slice(bi + 1).map(plainOf).join('');
        nodes.length = bi;
        nodes.push(raw(`<img src="${urlAttr}" alt="${escapeHtml(alt)}"${titleAttr} />`, alt));
      } else {
        nodes[bi] = raw(`<a href="${urlAttr}"${titleAttr}>`);
        nodes.push(raw('</a>'));
        for (let k = 0; k < bi; k++) {
          if (nodes[k].t === 'bracket' && !nodes[k].img) nodes[k].active = false;
        }
      }
      i = tail.end;
      continue;
    }

    if (c === '<') {
      const m = /^<([A-Za-z][A-Za-z0-9+.\-]{1,31}:[^<>\x00-\x20]*)>/.exec(s.slice(i, i + 2100));
      if (m) {
        nodes.push(raw(`<a href="${escapeHtml(normalizeUrl(m[1]))}">${escapeHtml(m[1])}</a>`, m[1]));
        i += m[0].length;
        continue;
      }
      pushText('<');
      i++;
      continue;
    }

    if (c === '&') {
      const m = /^&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/.exec(s.slice(i, i + 40));
      const dec = m ? decodeEntity(m[1]) : null;
      if (dec !== null) { pushText(dec); i += m[0].length; }
      else { pushText('&'); i++; }
      continue;
    }

    if (c === '\n') {
      const last = nodes[nodes.length - 1];
      let hard = false;
      if (last && last.t === 'text') {
        const trail = /( *)$/.exec(last.s)[1];
        hard = trail.length >= 2;
        last.s = last.s.slice(0, last.s.length - trail.length);
      }
      if (hard) nodes.push(raw('<br />\n'));
      else pushText('\n');
      i++;
      continue;
    }

    pushText(c);
    i++;
  }
  processEmphasis(nodes, -1);
  return nodes.map(renderNode).join('');
}

// ---------- block rendering ----------

function renderBlock(b, tight) {
  switch (b.type) {
    case 'para': {
      const h = parseInline(b.text);
      return tight ? h : `<p>${h}</p>`;
    }
    case 'heading':
      return `<h${b.level}>${parseInline(b.text)}</h${b.level}>`;
    case 'hr':
      return '<hr />';
    case 'code': {
      const lang = b.info ? unescapeString(b.info.split(/\s+/)[0]) : '';
      const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      const body = b.lines.map((l) => l + '\n').join('');
      return `<pre><code${cls}>${escapeHtml(body)}</code></pre>`;
    }
    case 'quote': {
      const inner = renderBlocks(b.children, false);
      return inner ? `<blockquote>\n${inner}\n</blockquote>` : '<blockquote>\n</blockquote>';
    }
    case 'list': {
      const open = b.ordered ? (b.start !== 1 ? `<ol start="${b.start}">` : '<ol>') : '<ul>';
      const close = b.ordered ? '</ol>' : '</ul>';
      const items = b.items.map((it) => `<li>${renderBlocks(it.children, !b.loose)}</li>`);
      return `${open}\n${items.join('\n')}\n${close}`;
    }
    default:
      return '';
  }
}

function renderBlocks(blocks, tight) {
  return blocks.map((b) => renderBlock(b, tight)).filter((s) => s !== '').join('\n');
}

export function render(markdown) {
  const text = String(markdown).replace(/\r\n?/g, '\n').replace(/\0/g, '�');
  const lines = text.split('\n').map(expandLeadingTabs);
  return renderBlocks(parseBlocks(lines).blocks, false);
}
