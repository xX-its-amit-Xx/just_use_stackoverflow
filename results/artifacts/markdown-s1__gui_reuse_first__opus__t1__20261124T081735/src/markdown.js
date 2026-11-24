// Minimal CommonMark-subset Markdown -> HTML renderer.
// Inline parsing is adapted from commonmark.js (see ./inlines.js and
// THIRD_PARTY_NOTICES.md); the line-based block parser and renderer are glue
// written for this project, producing commonmark.js-style HTML output.
// The attribute-escaping idea (encodeAttr) originates from snarkdown (MIT).
import { parseInlines, escapeXml, unescapeString } from './inlines.js';

const reHr = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const reAtx = /^ {0,3}(#{1,6})(?=[ \t]|$)(.*)$/;
const reFence = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const reBq = /^ {0,3}>/;
const reSetext = /^ {0,3}(=+|-+)[ \t]*$/;
const reList = /^( {0,3})(?:([-+*])|(\d{1,9})([.)]))(?=[ \t]|$)/;

const isBlank = (s) => /^[ \t]*$/.test(s);
const indentOf = (s) => /^ */.exec(s)[0].length;

// Expand tabs found in the leading whitespace into spaces (tab stop = 4).
function expandIndent(line) {
  const lead = /^[ \t]*/.exec(line)[0];
  if (!lead.includes('\t')) return line;
  let col = 0, out = '';
  for (const ch of lead) {
    if (ch === '\t') { const n = 4 - (col % 4); out += ' '.repeat(n); col += n; }
    else { out += ' '; col++; }
  }
  return out + line.slice(lead.length);
}

function fenceOpen(line) {
  const m = reFence.exec(line);
  if (!m) return null;
  if (m[2][0] === '`' && m[3].includes('`')) return null;
  return { indent: m[1].length, ch: m[2][0], len: m[2].length, info: m[3] };
}

function listItem(line) {
  const m = reList.exec(line);
  if (!m) return null;
  const markerEnd = m[0].length;
  const rest = line.slice(markerEnd);
  // measure whitespace after the marker in columns
  let col = markerEnd, k = 0;
  while (k < rest.length && (rest[k] === ' ' || rest[k] === '\t')) {
    col += rest[k] === '\t' ? 4 - (col % 4) : 1;
    k++;
  }
  const spaces = col - markerEnd;
  const after = rest.slice(k);
  const emptyFirst = after.length === 0;
  let padding, content;
  if (emptyFirst) { padding = 1; content = ''; }
  else if (spaces >= 5) { padding = 1; content = ' '.repeat(spaces - 1) + after; }
  else { padding = spaces; content = after; }
  return {
    ordered: m[3] !== undefined,
    bullet: m[2],
    delim: m[4],
    start: m[3] !== undefined ? parseInt(m[3], 10) : 1,
    offset: markerEnd + padding,
    content,
    emptyFirst,
  };
}

// Does this line start a block (other than an indented code block)?
function startsBlock(line) {
  return indentOf(line) < 4 &&
    (reAtx.test(line) || !!fenceOpen(line) || reHr.test(line) || reBq.test(line) || !!listItem(line));
}

function canInterruptParagraph(line) {
  if (indentOf(line) >= 4) return false;
  if (reAtx.test(line) || fenceOpen(line) || reHr.test(line) || reBq.test(line)) return true;
  const li = listItem(line);
  return !!li && !li.emptyFirst && (!li.ordered || li.start === 1);
}

function parseBlocks(rawLines) {
  const lines = rawLines.map(expandIndent);
  const n = lines.length;
  const blocks = [];
  let i = 0;
  let sawBlank = false;
  let blankBetween = false;
  const push = (b) => {
    if (sawBlank && blocks.length) blankBetween = true;
    sawBlank = false;
    blocks.push(b);
  };

  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) { sawBlank = true; i++; continue; }
    const ind = indentOf(line);
    let m, f, li;

    // indented code block
    if (ind >= 4) {
      const code = [];
      while (i < n && (isBlank(lines[i]) || indentOf(lines[i]) >= 4)) {
        code.push(isBlank(lines[i]) ? lines[i].slice(4) : lines[i].slice(4));
        i++;
      }
      while (code.length && isBlank(code[code.length - 1])) code.pop();
      push({ type: 'code', info: '', text: code.join('\n') + '\n' });
      continue;
    }

    // fenced code block
    if ((f = fenceOpen(line))) {
      const code = [];
      i++;
      while (i < n) {
        const l = lines[i];
        const c = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(l);
        if (c && c[1][0] === f.ch && c[1].length >= f.len) { i++; break; }
        if (f.indent === 0) code.push(rawLines[i]);
        else code.push(l.slice(Math.min(f.indent, indentOf(l))));
        i++;
      }
      push({ type: 'code', info: unescapeString(f.info.trim()), text: code.length ? code.join('\n') + '\n' : '' });
      continue;
    }

    // ATX heading
    if ((m = reAtx.exec(line))) {
      let content = m[2].replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
      if (/^#+$/.test(content)) content = '';
      else content = content.replace(/[ \t]+#+$/, '').replace(/[ \t]+$/, '');
      push({ type: 'heading', level: m[1].length, content });
      i++;
      continue;
    }

    // thematic break
    if (reHr.test(line)) { push({ type: 'hr' }); i++; continue; }

    // blockquote
    if (reBq.test(line)) {
      const inner = [];
      while (i < n) {
        const l = lines[i];
        const q = reBq.exec(l);
        if (q) {
          let rest = l.slice(q[0].length);
          if (rest[0] === ' ' || rest[0] === '\t') rest = rest[0] === '\t' ? '  ' + rest.slice(1) : rest.slice(1);
          inner.push(rest);
          i++;
        } else if (!isBlank(l) && inner.length && !isBlank(inner[inner.length - 1]) &&
          !startsBlock(l) && parseBlocks(inner).lazyOpen) {
          inner.push(l);
          i++;
        } else break;
      }
      const sub = parseBlocks(inner);
      push({ type: 'blockquote', children: sub.blocks, lazyOpen: sub.lazyOpen });
      continue;
    }

    // list
    if ((li = listItem(line))) {
      const blankBeforeList = sawBlank;
      let blankAfterList = false;
      const list = { type: 'list', ordered: li.ordered, start: li.start, tight: true, items: [], lazyOpen: false };
      while (i < n) {
        const cur = listItem(lines[i]);
        if (!cur || reHr.test(lines[i]) || cur.ordered !== li.ordered ||
          (cur.ordered ? cur.delim !== li.delim : cur.bullet !== li.bullet)) break;
        const itemLines = [cur.content];
        let j = i + 1;
        if (!(cur.emptyFirst && j < n && isBlank(lines[j]))) {
          while (j < n) {
            const l = lines[j];
            if (isBlank(l)) { itemLines.push(l.length > cur.offset ? l.slice(cur.offset) : ''); j++; continue; }
            if (indentOf(l) >= cur.offset) { itemLines.push(l.slice(cur.offset)); j++; continue; }
            if (!isBlank(itemLines[itemLines.length - 1]) && !startsBlock(l) && parseBlocks(itemLines).lazyOpen) {
              itemLines.push(l); j++; continue;
            }
            break;
          }
        }
        let k = itemLines.length;
        while (k > 1 && isBlank(itemLines[k - 1])) k--;
        const trailingBlank = k < itemLines.length;
        itemLines.length = k;
        const sub = parseBlocks(itemLines);
        if (sub.blankBetween) list.tight = false;
        list.items.push(sub.blocks);
        list.lazyOpen = !trailingBlank && sub.lazyOpen;
        i = j;
        if (trailingBlank && i < n) {
          const nx = listItem(lines[i]);
          if (nx && !reHr.test(lines[i]) && nx.ordered === li.ordered &&
            (nx.ordered ? nx.delim === li.delim : nx.bullet === li.bullet)) list.tight = false;
        }
        blankAfterList = trailingBlank;
      }
      sawBlank = blankBeforeList;
      push(list);
      sawBlank = blankAfterList;
      continue;
    }

    // paragraph (possibly a setext heading)
    const para = [line];
    i++;
    let heading = 0;
    while (i < n) {
      const l = lines[i];
      if (isBlank(l)) break;
      if ((m = reSetext.exec(l))) { heading = m[1][0] === '=' ? 1 : 2; i++; break; }
      if (canInterruptParagraph(l)) break;
      para.push(l);
      i++;
    }
    const content = para.map((l) => l.replace(/^[ \t]+/, '')).join('\n').replace(/[ \t]+$/, '');
    push(heading ? { type: 'heading', level: heading, content } : { type: 'paragraph', content });
  }

  const last = blocks[blocks.length - 1];
  const lastLine = rawLines[rawLines.length - 1];
  const lazyOpen = !!last && lastLine !== undefined && !isBlank(lastLine) &&
    (last.type === 'paragraph' || ((last.type === 'blockquote' || last.type === 'list') && last.lazyOpen));
  return { blocks, blankBetween, lazyOpen };
}

// ---------------------------------------------------------------- renderer
function renderInline(node, plain) {
  let out = '';
  for (let c = node.firstChild; c; c = c.next) {
    switch (c.type) {
      case 'text': out += escapeXml(c.literal); break;
      case 'softbreak': out += '\n'; break;
      case 'linebreak': out += plain ? '\n' : '<br />\n'; break;
      case 'code': out += plain ? escapeXml(c.literal) : '<code>' + escapeXml(c.literal) + '</code>'; break;
      case 'emph': out += plain ? renderInline(c, true) : '<em>' + renderInline(c) + '</em>'; break;
      case 'strong': out += plain ? renderInline(c, true) : '<strong>' + renderInline(c) + '</strong>'; break;
      case 'link':
        if (plain) { out += renderInline(c, true); break; }
        out += '<a href="' + escapeXml(c.destination) + '"' +
          (c.title ? ' title="' + escapeXml(c.title) + '"' : '') + '>' + renderInline(c) + '</a>';
        break;
      case 'image':
        if (plain) { out += renderInline(c, true); break; }
        out += '<img src="' + escapeXml(c.destination) + '" alt="' + renderInline(c, true) + '"' +
          (c.title ? ' title="' + escapeXml(c.title) + '"' : '') + ' />';
        break;
      default: break;
    }
  }
  return out;
}

const inline = (s) => renderInline(parseInlines(s));

function renderBlocks(blocks, tight) {
  let out = '';
  for (const b of blocks) {
    switch (b.type) {
      case 'paragraph':
        out += tight ? inline(b.content) : '<p>' + inline(b.content) + '</p>\n';
        break;
      case 'heading':
        out += `<h${b.level}>` + inline(b.content) + `</h${b.level}>\n`;
        break;
      case 'hr':
        out += '<hr />\n';
        break;
      case 'code': {
        const lang = b.info ? b.info.split(/[ \t\n]+/)[0] : '';
        out += '<pre><code' + (lang ? ' class="language-' + escapeXml(lang) + '"' : '') + '>' +
          escapeXml(b.text) + '</code></pre>\n';
        break;
      }
      case 'blockquote':
        out += '<blockquote>\n' + renderBlocks(b.children, false) + '</blockquote>\n';
        break;
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        out += '<' + tag + (b.ordered && b.start !== 1 ? ' start="' + b.start + '"' : '') + '>\n';
        for (const item of b.items) {
          let inner = renderBlocks(item, b.tight);
          if (b.tight) {
            if (item.length && item[0].type !== 'paragraph') inner = '\n' + inner;
            inner = inner.replace(/\n$/, '');
            if (item.length && item[item.length - 1].type !== 'paragraph') inner += '\n';
          } else if (inner) inner = '\n' + inner;
          out += '<li>' + inner + '</li>\n';
        }
        out += '</' + tag + '>\n';
        break;
      }
      default: break;
    }
  }
  return out;
}

/** Render a Markdown string to HTML (CommonMark subset). */
export function render(markdown) {
  const src = String(markdown ?? '').replace(/\r\n?/g, '\n').replace(/\u0000/g, '\uFFFD');
  const lines = src.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return renderBlocks(parseBlocks(lines).blocks, false);
}

export default render;
