// Minimal CommonMark-style Markdown -> HTML renderer (tier S1).
// Original implementation. Block structure is parsed line by line; inline
// content uses a flat node list with the CommonMark delimiter-run algorithm.

const ASCII_PUNCT_CHAR = /^[!-\/:-@\[-`{-~]$/;
const BLANK = /^[ \t]*$/;

const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  copy: '©', reg: '®', mdash: '—', ndash: '–',
  hellip: '…', ldquo: '“', rdquo: '”', lsquo: '‘',
  rsquo: '’', times: '×', middot: '·',
};

const ENTITY_OR_ESCAPE_RE =
  /\\([!-\/:-@\[-`{-~])|&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g;

const ENTITY_AT_START_RE =
  /^&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/;

function esc(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// `s` is a complete "&...;" reference. Returns the decoded text or `s` unchanged.
function decodeEntity(s) {
  const body = s.slice(1, -1);
  if (body[0] === '#') {
    const hex = body[1] === 'x' || body[1] === 'X';
    const code = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
    return String.fromCodePoint(code);
  }
  return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : s;
}

// Resolves backslash escapes and entity references (used for URLs and titles).
function unescapeString(s) {
  return s.replace(ENTITY_OR_ESCAPE_RE, (m, punct) =>
    punct !== undefined ? punct : decodeEntity(m));
}

function normalizeUrl(u) {
  try {
    return encodeURI(decodeURI(u));
  } catch {
    return u;
  }
}

function isWs(ch) {
  return ch === undefined || /\s/.test(ch);
}

function isPunct(ch) {
  return ch !== undefined && /[\p{P}\p{S}]/u.test(ch);
}

function indentOf(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  return i;
}

function stripIndent(line, max) {
  let c = 0;
  while (c < max && line[c] === ' ') c++;
  return line.slice(c);
}

// ---------------------------------------------------------------------------
// Block-level recognisers
// ---------------------------------------------------------------------------

function fenceOpen(line) {
  const m = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
  if (!m) return null;
  if (m[2][0] === '`' && m[3].includes('`')) return null;
  return { indent: m[1].length, ch: m[2][0], len: m[2].length, info: m[3].trim() };
}

function isHr(line) {
  return /^ {0,3}((\*[ \t]*){3,}|(-[ \t]*){3,}|(_[ \t]*){3,})$/.test(line);
}

// Returns {ordered, bullet, delim, start, contentIndent, rest} or null.
function listMarker(line) {
  const m = /^( {0,3})(?:([-+*])|(\d{1,9})([.)]))( +|$)/.exec(line);
  if (!m) return null;
  const ordered = m[2] === undefined;
  const markerText = ordered ? m[3] + m[4] : m[2];
  const markerEnd = m[1].length + markerText.length;
  const after = line.slice(markerEnd);
  let sp = m[5].length;
  let rest;
  if (after.trim() === '') {
    sp = 1;
    rest = '';
  } else {
    if (sp > 4) sp = 1;
    rest = line.slice(markerEnd + sp);
  }
  return {
    ordered,
    bullet: m[2],
    delim: m[4],
    start: ordered ? parseInt(m[3], 10) : 1,
    contentIndent: markerEnd + sp,
    rest,
  };
}

function sameList(a, b) {
  if (a.ordered !== b.ordered) return false;
  return a.ordered ? a.delim === b.delim : a.bullet === b.bullet;
}

// Whether a line may interrupt an open paragraph.
function startsBlock(line) {
  if (fenceOpen(line)) return true;
  if (/^ {0,3}#{1,6}(?=[ \t]|$)/.test(line)) return true;
  if (isHr(line)) return true;
  if (/^ {0,3}>/.test(line)) return true;
  const m = listMarker(line);
  if (m && m.rest.trim() !== '' && (!m.ordered || m.start === 1)) return true;
  return false;
}

function codeBlockHtml(lines, lang) {
  const content = lines.map((l) => l + '\n').join('');
  const cls = lang ? ` class="language-${esc(lang)}"` : '';
  return `<pre><code${cls}>${esc(content)}</code></pre>\n`;
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

// Returns {html, loose}; `loose` is true when blank lines separate blocks.
// `tight` renders paragraphs without <p> (used for tight list items).
function parseBlocks(lines, tight) {
  let html = '';
  let loose = false;
  let sawBlock = false;
  let pendingBlank = false;
  const add = (s) => {
    if (sawBlock && pendingBlank) loose = true;
    pendingBlank = false;
    sawBlock = true;
    html += s;
  };

  const n = lines.length;
  let i = 0;
  while (i < n) {
    const l = lines[i];

    if (BLANK.test(l)) {
      pendingBlank = true;
      i++;
      continue;
    }

    // Fenced code block.
    const fo = fenceOpen(l);
    if (fo) {
      const body = [];
      i++;
      while (i < n) {
        const t = lines[i];
        const cm = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(t);
        if (cm && cm[1][0] === fo.ch && cm[1].length >= fo.len) {
          i++;
          break;
        }
        body.push(stripIndent(t, fo.indent));
        i++;
      }
      const lang = fo.info ? unescapeString(fo.info.split(/\s+/)[0]) : '';
      add(codeBlockHtml(body, lang));
      continue;
    }

    // Indented code block.
    if (indentOf(l) >= 4) {
      let end = i;
      let j = i;
      while (j < n && (indentOf(lines[j]) >= 4 || BLANK.test(lines[j]))) {
        if (!BLANK.test(lines[j])) end = j + 1;
        j++;
      }
      const body = [];
      for (let k = i; k < end; k++) {
        body.push(BLANK.test(lines[k]) ? '' : lines[k].slice(4));
      }
      i = end;
      add(codeBlockHtml(body, ''));
      continue;
    }

    // ATX heading.
    const at = /^ {0,3}(#{1,6})(?=[ \t]|$)(.*)$/.exec(l);
    if (at) {
      const level = at[1].length;
      const text = at[2].trim().replace(/(^|[ \t]+)#+$/, '').trim();
      add(`<h${level}>${inline(text)}</h${level}>\n`);
      i++;
      continue;
    }

    // Thematic break.
    if (isHr(l)) {
      add('<hr />\n');
      i++;
      continue;
    }

    // Blockquote.
    if (/^ {0,3}>/.test(l)) {
      const inner = [];
      while (i < n) {
        const t = lines[i];
        const q = /^ {0,3}>( ?)(.*)$/.exec(t);
        if (q) {
          inner.push(q[2]);
          i++;
          continue;
        }
        // Lazy paragraph continuation.
        if (!BLANK.test(t) && inner.length && !BLANK.test(inner[inner.length - 1]) && !startsBlock(t)) {
          inner.push(t);
          i++;
          continue;
        }
        break;
      }
      add(`<blockquote>\n${parseBlocks(inner, false).html}</blockquote>\n`);
      continue;
    }

    // List.
    if (listMarker(l)) {
      const r = parseList(lines, i);
      add(r.html);
      i = r.next;
      continue;
    }

    // Paragraph (possibly a setext heading).
    const para = [l.trimStart()];
    i++;
    let level = 0;
    while (i < n) {
      const t = lines[i];
      if (BLANK.test(t)) break;
      const sm = /^ {0,3}(=+|-+)[ \t]*$/.exec(t);
      if (sm) {
        level = sm[1][0] === '=' ? 1 : 2;
        i++;
        break;
      }
      if (startsBlock(t)) break;
      para.push(t.trimStart());
      i++;
    }
    para[para.length - 1] = para[para.length - 1].trimEnd();
    const content = inline(para.join('\n'));
    if (level) {
      add(`<h${level}>${content}</h${level}>\n`);
    } else {
      add(tight ? content + '\n' : `<p>${content}</p>\n`);
    }
  }

  return { html, loose };
}

// Parses a list starting at lines[start]. Returns {html, next}.
function parseList(lines, start) {
  const n = lines.length;
  const first = listMarker(lines[start]);
  const items = [];
  let loose = false;
  let i = start;

  for (;;) {
    const mk = listMarker(lines[i]);
    const itemLines = [mk.rest];
    let end = i + 1; // index after the last line belonging to this item
    let k = i + 1;   // scan position

    while (k < n) {
      const t = lines[k];
      if (BLANK.test(t)) {
        k++;
        continue;
      }
      if (indentOf(t) >= mk.contentIndent) {
        while (end < k) {
          itemLines.push('');
          end++;
        }
        itemLines.push(t.slice(mk.contentIndent));
        k++;
        end = k;
        continue;
      }
      // Lazy continuation of a paragraph directly above.
      if (end === k && !startsBlock(t) && !listMarker(t)) {
        itemLines.push(t.trimStart());
        k++;
        end = k;
        continue;
      }
      break;
    }

    while (itemLines.length && BLANK.test(itemLines[itemLines.length - 1])) itemLines.pop();
    items.push(itemLines);

    const nm = k < n ? listMarker(lines[k]) : null;
    if (nm && sameList(first, nm) && !isHr(lines[k])) {
      if (k > end) loose = true; // blank line between items
      i = k;
      continue;
    }
    i = end;
    break;
  }

  const parsed = items.map((il) => parseBlocks(il, false));
  const isLoose = loose || parsed.some((p) => p.loose);
  let html;
  if (first.ordered) {
    html = first.start !== 1 ? `<ol start="${first.start}">\n` : '<ol>\n';
  } else {
    html = '<ul>\n';
  }
  items.forEach((il, idx) => {
    if (isLoose) {
      html += `<li>\n${parsed[idx].html}</li>\n`;
    } else {
      html += `<li>${parseBlocks(il, true).html.trimEnd()}</li>\n`;
    }
  });
  html += first.ordered ? '</ol>\n' : '</ul>\n';
  return { html, next: i };
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

function raw(html, plain) {
  return { type: 'raw', html, plain };
}

function plainOf(x) {
  switch (x.type) {
    case 'text': return x.value;
    case 'raw': return x.plain;
    case 'delim': return x.ch.repeat(x.count);
    case 'open': return x.image ? '![' : '[';
    default: return '';
  }
}

function serialize(nodes) {
  let s = '';
  for (const x of nodes) {
    switch (x.type) {
      case 'text': s += esc(x.value); break;
      case 'raw': s += x.html; break;
      case 'delim': s += x.head.join('') + x.ch.repeat(x.count) + x.tail.join(''); break;
      case 'open': s += x.image ? '![' : '['; break;
    }
  }
  return s;
}

// CommonMark emphasis resolution over nodes[bottom..].
function processEmphasis(nodes, bottom) {
  let pos = bottom;
  while (pos < nodes.length) {
    const c = nodes[pos];
    if (c.type !== 'delim' || !c.canClose || c.count === 0) {
      pos++;
      continue;
    }
    let found = -1;
    for (let j = pos - 1; j >= bottom; j--) {
      const o = nodes[j];
      if (o.type !== 'delim' || o.ch !== c.ch || !o.canOpen || o.count === 0) continue;
      if ((o.canClose || c.canOpen) &&
          (o.origCount + c.origCount) % 3 === 0 &&
          !(o.origCount % 3 === 0 && c.origCount % 3 === 0)) {
        continue;
      }
      found = j;
      break;
    }
    if (found < 0) {
      pos++;
      continue;
    }
    const o = nodes[found];
    const use = c.count >= 2 && o.count >= 2 ? 2 : 1;
    o.count -= use;
    c.count -= use;
    // Opener: later matches are further out, so prepend. Closer: append.
    o.tail.unshift(use === 2 ? '<strong>' : '<em>');
    c.head.push(use === 2 ? '</strong>' : '</em>');
    for (let k = found + 1; k < pos; k++) {
      const d = nodes[k];
      if (d.type === 'delim') {
        d.canOpen = false;
        d.canClose = false;
      }
    }
    if (o.count === 0) o.canOpen = false;
    if (c.count === 0) pos++;
  }
}

// Parses "(dest "title")" starting just after '('. Returns null on failure.
function parseInlineLink(s, p) {
  const n = s.length;
  const skipWs = () => {
    while (p < n && (s[p] === ' ' || s[p] === '\t' || s[p] === '\n')) p++;
  };
  skipWs();
  let url = '';
  if (s[p] === '<') {
    let k = p + 1;
    while (k < n && s[k] !== '>' && s[k] !== '\n' && s[k] !== '<') {
      if (s[k] === '\\' && k + 1 < n) k++;
      k++;
    }
    if (s[k] !== '>') return null;
    url = s.slice(p + 1, k);
    p = k + 1;
  } else {
    let depth = 0;
    const st = p;
    while (p < n) {
      const ch = s[p];
      if (ch === '\\' && p + 1 < n && ASCII_PUNCT_CHAR.test(s[p + 1])) {
        p += 2;
        continue;
      }
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch.charCodeAt(0) < 0x20) break;
      if (ch === '(') {
        depth++;
      } else if (ch === ')') {
        if (depth === 0) break;
        depth--;
      }
      p++;
    }
    if (depth !== 0) return null;
    url = s.slice(st, p);
  }
  skipWs();
  let title = null;
  if (s[p] === '"' || s[p] === "'" || s[p] === '(') {
    const close = s[p] === '(' ? ')' : s[p];
    let k = p + 1;
    while (k < n && s[k] !== close) {
      if (s[k] === '\\' && k + 1 < n) k++;
      k++;
    }
    if (k >= n) return null;
    title = s.slice(p + 1, k);
    p = k + 1;
    skipWs();
  }
  if (s[p] !== ')') return null;
  return {
    url: normalizeUrl(unescapeString(url)),
    title: title === null ? null : unescapeString(title),
    end: p + 1,
  };
}

function inline(str) {
  const nodes = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      nodes.push({ type: 'text', value: buf });
      buf = '';
    }
  };
  const push = (x) => {
    flush();
    nodes.push(x);
  };

  const n = str.length;
  let i = 0;
  while (i < n) {
    const c = str[i];

    // Backslash escapes and hard line breaks.
    if (c === '\\') {
      if (str[i + 1] === '\n') {
        push(raw('<br />\n', '\n'));
        i += 2;
        while (str[i] === ' ') i++;
        continue;
      }
      if (i + 1 < n && ASCII_PUNCT_CHAR.test(str[i + 1])) {
        buf += str[i + 1];
        i += 2;
        continue;
      }
      buf += c;
      i++;
      continue;
    }

    // Code span.
    if (c === '`') {
      let r = i;
      while (str[r] === '`') r++;
      const len = r - i;
      let k = r;
      let found = -1;
      while (k < n) {
        if (str[k] === '`') {
          let e = k;
          while (str[e] === '`') e++;
          if (e - k === len) {
            found = k;
            break;
          }
          k = e;
        } else {
          k++;
        }
      }
      if (found < 0) {
        buf += '`'.repeat(len);
        i = r;
        continue;
      }
      let content = str.slice(r, found).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      push(raw(`<code>${esc(content)}</code>`, content));
      i = found + len;
      continue;
    }

    // Emphasis delimiter run.
    if (c === '*' || c === '_') {
      let r = i;
      while (str[r] === c) r++;
      const count = r - i;
      const before = i > 0 ? str[i - 1] : undefined;
      const after = r < n ? str[r] : undefined;
      const bWs = isWs(before), aWs = isWs(after);
      const bP = isPunct(before), aP = isPunct(after);
      const left = !aWs && (!aP || bWs || bP);
      const right = !bWs && (!bP || aWs || aP);
      let canOpen, canClose;
      if (c === '*') {
        canOpen = left;
        canClose = right;
      } else {
        canOpen = left && (!right || bP);
        canClose = right && (!left || aP);
      }
      push({ type: 'delim', ch: c, count, origCount: count, canOpen, canClose, head: [], tail: [] });
      i = r;
      continue;
    }

    // Image / link openers.
    if (c === '!' && str[i + 1] === '[') {
      push({ type: 'open', image: true, active: true });
      i += 2;
      continue;
    }
    if (c === '[') {
      push({ type: 'open', image: false, active: true });
      i++;
      continue;
    }

    // Closing bracket: try to form a link or image.
    if (c === ']') {
      flush();
      let oi = -1;
      for (let k = nodes.length - 1; k >= 0; k--) {
        if (nodes[k].type === 'open') {
          oi = k;
          break;
        }
      }
      if (oi < 0) {
        buf += ']';
        i++;
        continue;
      }
      const o = nodes[oi];
      if (!o.active) {
        nodes[oi] = { type: 'text', value: o.image ? '![' : '[' };
        buf += ']';
        i++;
        continue;
      }
      const parsed = str[i + 1] === '(' ? parseInlineLink(str, i + 2) : null;
      if (!parsed) {
        nodes[oi] = { type: 'text', value: o.image ? '![' : '[' };
        buf += ']';
        i++;
        continue;
      }
      processEmphasis(nodes, oi + 1);
      const inner = nodes.splice(oi + 1);
      nodes.pop(); // the opener
      const titleAttr = parsed.title !== null ? ` title="${esc(parsed.title)}"` : '';
      const innerPlain = inner.map(plainOf).join('');
      if (o.image) {
        nodes.push(raw(`<img src="${esc(parsed.url)}" alt="${esc(innerPlain)}"${titleAttr} />`, innerPlain));
      } else {
        nodes.push(raw(`<a href="${esc(parsed.url)}"${titleAttr}>${serialize(inner)}</a>`, innerPlain));
        // Links may not contain other links: deactivate earlier link openers.
        for (const x of nodes) {
          if (x.type === 'open' && !x.image) x.active = false;
        }
      }
      i = parsed.end;
      continue;
    }

    // Autolink (URI form).
    if (c === '<') {
      const m = /^<([a-zA-Z][a-zA-Z0-9+.\-]{1,31}:[^\s<>]*)>/.exec(str.slice(i, i + 2100));
      if (m) {
        push(raw(`<a href="${esc(normalizeUrl(m[1]))}">${esc(m[1])}</a>`, m[1]));
        i += m[0].length;
        continue;
      }
    }

    // Entity reference.
    if (c === '&') {
      const m = ENTITY_AT_START_RE.exec(str.slice(i, i + 40));
      if (m) {
        const d = decodeEntity(m[0]);
        if (d !== m[0]) {
          buf += d;
          i += m[0].length;
          continue;
        }
      }
      buf += c;
      i++;
      continue;
    }

    // Line break: two or more trailing spaces make a hard break.
    if (c === '\n') {
      const trimmed = buf.replace(/ +$/, '');
      const spaces = buf.length - trimmed.length;
      buf = trimmed;
      if (spaces >= 2) {
        push(raw('<br />\n', '\n'));
      } else {
        buf += '\n';
      }
      i++;
      while (str[i] === ' ') i++;
      continue;
    }

    buf += c;
    i++;
  }

  flush();
  processEmphasis(nodes, 0);
  return serialize(nodes);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Expands tabs that occur in leading indentation only (content tabs are kept).
function expandLeadingTabs(line) {
  const lead = /^[ \t]*/.exec(line)[0];
  if (!lead.includes('\t')) return line;
  let col = 0;
  let out = '';
  for (const ch of lead) {
    if (ch === '\t') {
      const k = 4 - (col % 4);
      out += ' '.repeat(k);
      col += k;
    } else {
      out += ' ';
      col++;
    }
  }
  return out + line.slice(lead.length);
}

export function render(markdown) {
  const text = String(markdown).replace(/\r\n?/g, '\n').replace(/\0/g, '�');
  const lines = text.split('\n').map(expandLeadingTabs);
  return parseBlocks(lines, false).html;
}
