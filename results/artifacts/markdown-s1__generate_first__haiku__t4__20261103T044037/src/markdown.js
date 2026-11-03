// Minimal CommonMark-style Markdown -> HTML renderer (original implementation).
// Block level: ATX/setext headings, paragraphs, fenced + indented code,
// blockquotes, thematic breaks, bullet/ordered lists (nested via recursion).
// Inline level: emphasis/strong (delimiter algorithm), code spans, links,
// images, backslash escapes, hard/soft line breaks. Raw HTML is escaped.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const ASCII_PUNCT = /[!-\/:-@\[-`{-~]/;
const UNI_PUNCT = /[\p{P}\p{S}]/u;

export function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => ESC[c]);
}

function unescapeBS(s) {
  return s.replace(/\\([!-\/:-@\[-`{-~])/g, '$1');
}

function normUrl(u) {
  return u.replace(/[^A-Za-z0-9\-._~!*'();:@&=+$,\/?#\[\]%]|%(?![0-9A-Fa-f]{2})/gu, c =>
    c === '%' ? '%25' : encodeURIComponent(c));
}

const isBlank = l => /^[ \t]*$/.test(l);
const leadingSpaces = l => /^ */.exec(l)[0].length;

// ---------------------------------------------------------------- block level

const RE_ATX = /^ {0,3}(#{1,6})(?=[ \t]|$)[ \t]*(.*?)[ \t]*$/;

function fenceStart(l) {
  const m = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(l);
  if (!m) return null;
  if (m[2][0] === '`' && m[3].includes('`')) return null;
  return m;
}

function isHr(line) {
  if (!/^ {0,3}[*_-]/.test(line)) return false;
  const s = line.replace(/[ \t]/g, '').trimStart();
  return /^([*_-])\1{2,}$/.test(s);
}

function parseListMarker(line) {
  const m = /^( {0,3})(?:([*+-])|(\d{1,9})([.)]))(?=[ \t]|$)/.exec(line);
  if (!m) return null;
  const markerEnd = m[1].length + (m[2] ? 1 : m[3].length + 1);
  const rest = line.slice(markerEnd);
  const sp = /^ */.exec(rest)[0].length;
  let W, content;
  if (isBlank(rest)) { W = markerEnd + 1; content = ''; }
  else if (sp >= 5) { W = markerEnd + 1; content = rest.slice(1); }
  else { W = markerEnd + sp; content = rest.slice(sp); }
  const ordered = !!m[3];
  return {
    ordered,
    start: ordered ? parseInt(m[3], 10) : 1,
    key: ordered ? 'o' + m[4] : m[2],
    W,
    content,
  };
}

function startsBlock(l) {
  return RE_ATX.test(l) || !!fenceStart(l) || isHr(l) || /^ {0,3}>/.test(l) || !!parseListMarker(l);
}

function canInterrupt(l) {
  if (RE_ATX.test(l) || fenceStart(l) || isHr(l) || /^ {0,3}>/.test(l)) return true;
  const lm = parseListMarker(l);
  if (!lm || lm.content === '') return false;
  return lm.ordered ? lm.start === 1 : true;
}

function parseBlocks(lines) {
  const nodes = [];
  let pendingBlank = false;
  let loose = false;
  const add = node => {
    if (pendingBlank) loose = true;
    pendingBlank = false;
    nodes.push(node);
  };
  const n = lines.length;
  let i = 0;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      if (nodes.length) pendingBlank = true;
      i++;
      continue;
    }

    // Indented code block (4+ spaces).
    if (/^ {4}/.test(line)) {
      let k = i;
      const body = [];
      while (k < n && (isBlank(lines[k]) || /^ {4}/.test(lines[k]))) {
        body.push(isBlank(lines[k]) ? '' : lines[k].slice(4));
        k++;
      }
      let t = body.length;
      while (t > 0 && body[t - 1] === '') t--;
      add({ type: 'code', lang: '', text: body.slice(0, t).map(l => l + '\n').join('') });
      i += t;
      continue;
    }

    // Fenced code block.
    const fm = fenceStart(line);
    if (fm) {
      const ind = fm[1].length;
      const fence = fm[2];
      const info = fm[3].trim();
      i++;
      const body = [];
      while (i < n) {
        const l = lines[i];
        const cm = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(l);
        if (cm && cm[1][0] === fence[0] && cm[1].length >= fence.length) { i++; break; }
        body.push(l.slice(Math.min(ind, leadingSpaces(l))) + '\n');
        i++;
      }
      add({ type: 'code', lang: unescapeBS(info).split(/\s+/)[0], text: body.join('') });
      continue;
    }

    // ATX heading.
    const hm = RE_ATX.exec(line);
    if (hm) {
      const text = hm[2].replace(/(?:^|[ \t]+)#+$/, '').trim();
      add({ type: 'heading', level: hm[1].length, text });
      i++;
      continue;
    }

    // Thematic break.
    if (isHr(line)) {
      add({ type: 'hr' });
      i++;
      continue;
    }

    // Blockquote.
    if (/^ {0,3}>/.test(line)) {
      const inner = [];
      let k = i;
      while (k < n) {
        const l = lines[k];
        if (/^ {0,3}>/.test(l)) {
          inner.push(l.replace(/^ {0,3}> ?/, ''));
          k++;
          continue;
        }
        // Lazy paragraph continuation.
        if (!isBlank(l) && inner.length && !isBlank(inner[inner.length - 1]) && !startsBlock(l)) {
          inner.push(l);
          k++;
          continue;
        }
        break;
      }
      add({ type: 'quote', children: parseBlocks(inner).nodes });
      i = k;
      continue;
    }

    // List.
    const lm = parseListMarker(line);
    if (lm) {
      const items = [];
      let anyLoose = false;
      let k = i;
      let cur = lm;
      for (;;) {
        const body = [cur.content];
        const W = cur.W;
        k++;
        while (k < n) {
          const l = lines[k];
          if (isBlank(l)) { body.push(''); k++; continue; }
          if (leadingSpaces(l) >= W) { body.push(l.slice(W)); k++; continue; }
          if (startsBlock(l)) break;
          if (!isBlank(body[body.length - 1])) { body.push(l.trimStart()); k++; continue; }
          break;
        }
        let t = body.length;
        let trailing = 0;
        while (t > 0 && isBlank(body[t - 1])) { t--; trailing++; }
        items.push(body.slice(0, t));
        const nxt = k < n ? parseListMarker(lines[k]) : null;
        if (nxt && nxt.key === lm.key) {
          if (trailing > 0) anyLoose = true;
          cur = nxt;
          continue;
        }
        break;
      }
      i = k;
      const parsed = items.map(body => parseBlocks(body));
      const looseList = anyLoose || parsed.some(p => p.loose);
      add({
        type: 'list',
        ordered: lm.ordered,
        start: lm.start,
        tight: !looseList,
        items: parsed.map(p => p.nodes),
      });
      continue;
    }

    // Paragraph, possibly a setext heading.
    const para = [line.trimStart()];
    let setext = 0;
    i++;
    while (i < n) {
      const l = lines[i];
      if (isBlank(l)) break;
      if (/^ {0,3}=+[ \t]*$/.test(l)) { setext = 1; i++; break; }
      if (/^ {0,3}-+[ \t]*$/.test(l)) { setext = 2; i++; break; }
      if (canInterrupt(l)) break;
      para.push(l.trimStart());
      i++;
    }
    const text = para.join('\n').replace(/[ \t]+$/, '');
    if (setext) add({ type: 'heading', level: setext, text });
    else add({ type: 'para', text });
  }
  return { nodes, loose };
}

// ------------------------------------------------------------- inline level

function isPunct(c) {
  return c !== undefined && (ASCII_PUNCT.test(c) || UNI_PUNCT.test(c));
}

function skipWs(src, q) {
  while (q < src.length && /[ \t\n]/.test(src[q])) q++;
  return q;
}

// Parses "(dest "title")" starting at p (which must point at '(').
function parseLinkTail(src, p) {
  if (src[p] !== '(') return null;
  let q = skipWs(src, p + 1);
  let dest;
  if (src[q] === '<') {
    let e = q + 1;
    while (e < src.length && src[e] !== '>' && src[e] !== '\n' && src[e] !== '<') {
      e += src[e] === '\\' && e + 1 < src.length ? 2 : 1;
    }
    if (src[e] !== '>') return null;
    dest = src.slice(q + 1, e);
    q = e + 1;
  } else {
    let e = q;
    let depth = 0;
    while (e < src.length) {
      const c = src[e];
      if (c === '\\' && e + 1 < src.length && ASCII_PUNCT.test(src[e + 1])) { e += 2; continue; }
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      } else if (/\s/.test(c) || c.charCodeAt(0) < 0x20) break;
      e++;
    }
    if (depth !== 0) return null;
    dest = src.slice(q, e);
    q = e;
  }
  const beforeTitle = q;
  q = skipWs(src, q);
  let title = null;
  if (q > beforeTitle && (src[q] === '"' || src[q] === "'" || src[q] === '(')) {
    const open = src[q];
    const closeCh = open === '(' ? ')' : open;
    let e = q + 1;
    while (e < src.length && src[e] !== closeCh) {
      e += src[e] === '\\' && e + 1 < src.length ? 2 : 1;
    }
    if (e >= src.length) return null;
    title = unescapeBS(src.slice(q + 1, e));
    q = skipWs(src, e + 1);
  }
  if (src[q] !== ')') return null;
  return { dest: unescapeBS(dest), title, end: q + 1 };
}

// Delimiter-run algorithm for * and _ (CommonMark "process emphasis").
function processEmphasis(items, start) {
  let ci = start;
  while (ci < items.length) {
    const c = items[ci];
    if (c.t !== 'delim' || !c.close || c.n === 0) { ci++; continue; }
    let found = -1;
    for (let oi = ci - 1; oi >= start; oi--) {
      const o = items[oi];
      if (o.t === 'delim' && o.open && o.n > 0 && o.ch === c.ch) {
        const both = o.close || c.open;
        if (both && (o.orig + c.orig) % 3 === 0 && !(o.orig % 3 === 0 && c.orig % 3 === 0)) continue;
        found = oi;
        break;
      }
    }
    if (found < 0) { ci++; continue; }
    const o = items[found];
    const use = o.n >= 2 && c.n >= 2 ? 2 : 1;
    o.n -= use;
    c.n -= use;
    const tag = use === 2 ? 'strong' : 'em';
    const children = items.splice(found + 1, ci - found - 1);
    items.splice(found + 1, 0, { t: 'node', tag, children });
    let newCi = found + 2;
    if (c.n === 0) items.splice(newCi, 1);
    if (o.n === 0) {
      items.splice(found, 1);
      newCi--;
    }
    ci = newCi;
  }
}

function parseInlines(src) {
  const items = [];
  const text = s => {
    const last = items[items.length - 1];
    if (last && last.t === 'text') last.s += s;
    else items.push({ t: 'text', s });
  };
  const n = src.length;
  let i = 0;
  while (i < n) {
    const ch = src[i];

    if (ch === '\\') {
      const nx = src[i + 1];
      if (nx === '\n') { items.push({ t: 'raw', h: '<br />\n' }); i += 2; continue; }
      if (nx !== undefined && ASCII_PUNCT.test(nx)) { text(nx); i += 2; continue; }
      text('\\');
      i++;
      continue;
    }

    if (ch === '`') {
      let k = i;
      while (src[k] === '`') k++;
      const len = k - i;
      let close = -1;
      let j = k;
      while (j < n) {
        if (src[j] === '`') {
          let e = j;
          while (src[e] === '`') e++;
          if (e - j === len) { close = j; break; }
          j = e;
        } else j++;
      }
      if (close < 0) { text('`'.repeat(len)); i = k; continue; }
      let content = src.slice(k, close).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) {
        content = content.slice(1, -1);
      }
      items.push({ t: 'code', s: content });
      i = close + len;
      continue;
    }

    if (ch === '\n') {
      const last = items[items.length - 1];
      let hard = false;
      if (last && last.t === 'text') {
        hard = / {2,}$/.test(last.s);
        last.s = last.s.replace(/ +$/, '');
      }
      items.push({ t: 'raw', h: hard ? '<br />\n' : '\n' });
      i++;
      continue;
    }

    if (ch === '*' || ch === '_') {
      let k = i;
      while (src[k] === ch) k++;
      const before = i > 0 ? src[i - 1] : undefined;
      const after = src[k];
      const wsB = before === undefined || /\s/.test(before);
      const wsA = after === undefined || /\s/.test(after);
      const pB = isPunct(before);
      const pA = isPunct(after);
      const left = !wsA && (!pA || wsB || pB);
      const right = !wsB && (!pB || wsA || pA);
      let open, close;
      if (ch === '*') { open = left; close = right; }
      else {
        open = left && (!right || pB);
        close = right && (!left || pA);
      }
      items.push({ t: 'delim', ch, n: k - i, orig: k - i, open, close });
      i = k;
      continue;
    }

    if (ch === '[') { items.push({ t: 'bracket', img: false, active: true }); i++; continue; }
    if (ch === '!' && src[i + 1] === '[') { items.push({ t: 'bracket', img: true, active: true }); i += 2; continue; }

    if (ch === ']') {
      let k = items.length - 1;
      while (k >= 0 && items[k].t !== 'bracket') k--;
      if (k < 0) { text(']'); i++; continue; }
      const op = items[k];
      if (!op.active) { items.splice(k, 1); text(']'); i++; continue; }
      const tail = parseLinkTail(src, i + 1);
      if (!tail) { items.splice(k, 1); text(']'); i++; continue; }
      processEmphasis(items, k + 1);
      const children = items.splice(k + 1);
      items.splice(k, 1, { t: 'link', img: op.img, dest: tail.dest, title: tail.title, children });
      if (!op.img) {
        for (const it of items) if (it.t === 'bracket') it.active = false;
      }
      i = tail.end;
      continue;
    }

    text(ch);
    i++;
  }
  return items;
}

function renderInlineItems(items) {
  let out = '';
  for (const it of items) {
    switch (it.t) {
      case 'text': out += escapeHtml(it.s); break;
      case 'raw': out += it.h; break;
      case 'code': out += `<code>${escapeHtml(it.s)}</code>`; break;
      case 'delim': out += escapeHtml(it.ch.repeat(it.n)); break;
      case 'bracket': out += it.img ? '![' : '['; break;
      case 'node': out += `<${it.tag}>${renderInlineItems(it.children)}</${it.tag}>`; break;
      case 'link': {
        const href = escapeHtml(normUrl(it.dest));
        const title = it.title !== null ? ` title="${escapeHtml(it.title)}"` : '';
        if (it.img) {
          out += `<img src="${href}" alt="${plainItems(it.children)}"${title} />`;
        } else {
          out += `<a href="${href}"${title}>${renderInlineItems(it.children)}</a>`;
        }
        break;
      }
    }
  }
  return out;
}

function plainItems(items) {
  let out = '';
  for (const it of items) {
    switch (it.t) {
      case 'text':
      case 'code': out += escapeHtml(it.s); break;
      case 'raw': out += it.h; break;
      case 'delim': out += escapeHtml(it.ch.repeat(it.n)); break;
      case 'bracket': out += it.img ? '![' : '['; break;
      case 'node':
      case 'link': out += plainItems(it.children); break;
    }
  }
  return out;
}

function renderInline(src) {
  const items = parseInlines(src);
  processEmphasis(items, 0);
  return renderInlineItems(items);
}

// --------------------------------------------------------------- rendering

function renderBlocks(nodes, tight = false) {
  let out = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'heading':
        out += `<h${node.level}>${renderInline(node.text)}</h${node.level}>\n`;
        break;
      case 'para': {
        const h = renderInline(node.text);
        out += tight ? h + '\n' : `<p>${h}</p>\n`;
        break;
      }
      case 'code': {
        const cls = node.lang ? ` class="language-${escapeHtml(node.lang)}"` : '';
        out += `<pre><code${cls}>${escapeHtml(node.text)}</code></pre>\n`;
        break;
      }
      case 'hr':
        out += '<hr />\n';
        break;
      case 'quote':
        out += `<blockquote>\n${renderBlocks(node.children)}</blockquote>\n`;
        break;
      case 'list': {
        const tag = node.ordered ? 'ol' : 'ul';
        const attr = node.ordered && node.start !== 1 ? ` start="${node.start}"` : '';
        out += `<${tag}${attr}>\n` + node.items.map(it => renderItem(it, node.tight)).join('') + `</${tag}>\n`;
        break;
      }
    }
  }
  return out;
}

function renderItem(children, tight) {
  if (children.length === 0) return '<li></li>\n';
  let body = renderBlocks(children, tight);
  if (tight && children[children.length - 1].type === 'para') body = body.replace(/\n$/, '');
  if (!tight) return `<li>\n${body}</li>\n`;
  return `<li>${body}</li>\n`;
}

export function render(markdown) {
  const lines = String(markdown)
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(l => l.replace(/^\t+/, m => '    '.repeat(m.length)));
  return renderBlocks(parseBlocks(lines).nodes);
}
