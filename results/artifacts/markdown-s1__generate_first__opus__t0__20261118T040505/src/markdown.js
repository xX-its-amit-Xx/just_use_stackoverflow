// Minimal CommonMark-subset Markdown -> HTML renderer (original implementation).

const ESC_RE = /[&<>"]/g;
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escapeHtml = s => s.replace(ESC_RE, c => ESC_MAP[c]);

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®',
  trade: '™', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’',
  ldquo: '“', rdquo: '”', laquo: '«', raquo: '»', middot: '·', bull: '•',
  deg: '°', plusmn: '±', times: '×', divide: '÷', euro: '€', pound: '£',
  yen: '¥', cent: '¢', sect: '§', para: '¶', frac12: '½', frac14: '¼',
  frac34: '¾', larr: '←', rarr: '→', uarr: '↑', darr: '↓', harr: '↔',
  ne: '≠', le: '≤', ge: '≥', infin: '∞', alpha: 'α', beta: 'β',
  gamma: 'γ', delta: 'δ', pi: 'π', sigma: 'σ', omega: 'ω', Delta: 'Δ',
  auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü',
  szlig: 'ß', eacute: 'é', egrave: 'è', aacute: 'á', agrave: 'à',
  ntilde: 'ñ', ccedil: 'ç', iexcl: '¡', iquest: '¿', shy: '­', ensp: ' ',
  emsp: ' ', thinsp: ' ', zwj: '‍', zwnj: '‌', dagger: '†', Dagger: '‡',
  permil: '‰', prime: '′', Prime: '″', oelig: 'œ', OElig: 'Œ', micro: 'µ',
  not: '¬', ordf: 'ª', ordm: 'º', sup1: '¹', sup2: '²', sup3: '³',
  acute: '´', cedil: '¸', uml: '¨', macr: '¯', curren: '¤', brvbar: '¦',
  ngE: '≧̸', HilbertSpace: 'ℋ', DifferentialD: 'ⅆ', ClockwiseContourIntegral: '∲',
};
const ENTITY_RE = /^&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([A-Za-z][A-Za-z0-9]{0,31}));/;

function decodeEntity(m) {
  let cp;
  if (m[1] !== undefined) cp = parseInt(m[1], 16);
  else if (m[2] !== undefined) cp = parseInt(m[2], 10);
  else return Object.prototype.hasOwnProperty.call(ENTITIES, m[3]) ? ENTITIES[m[3]] : null;
  if (cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
  return String.fromCodePoint(cp);
}

const ASCII_PUNCT = /^[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]$/;
const PUNCT_RE = /[\p{P}\p{S}]/u;
const WS_RE = /^[\s   -   　]$/u;

// Unescape backslash escapes and entities in a string (for URLs, titles, info strings).
function unescapeString(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && ASCII_PUNCT.test(s[i + 1])) { out += s[++i]; continue; }
    if (c === '&') {
      const m = ENTITY_RE.exec(s.slice(i));
      if (m) { const d = decodeEntity(m); if (d !== null) { out += d; i += m[0].length - 1; continue; } }
    }
    out += c;
  }
  return out;
}

const URL_SAFE = /[A-Za-z0-9;/?:@&=+$,\-_.!~*'()#]/;
function normalizeUrl(url) {
  let out = '';
  for (let i = 0; i < url.length; i++) {
    const c = url[i];
    if (c === '%' && /^[0-9a-fA-F]{2}$/.test(url.slice(i + 1, i + 3))) { out += c; continue; }
    if (URL_SAFE.test(c)) { out += c; continue; }
    const cp = url.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    if (cp > 0xffff) i++;
    if (cp >= 0xd800 && cp <= 0xdfff) { out += '%EF%BF%BD'; continue; }
    out += encodeURIComponent(ch).replace(/[!'()*]/g, x => '%' + x.charCodeAt(0).toString(16).toUpperCase());
  }
  return out;
}

// ---------------------------------------------------------------- Block parsing

function expandLeadingTabs(line) {
  // Expand tabs in the leading structural prefix (whitespace, '>' markers, list markers).
  const m = /^[ \t>]*(?:(?:[*+-]|\d{1,9}[.)])[ \t]+)?[ \t>]*/.exec(line);
  const pre = m[0];
  if (pre.indexOf('\t') < 0) return line;
  let out = '';
  for (const c of pre) {
    if (c === '\t') out += ' '.repeat(4 - (out.length % 4));
    else out += c;
  }
  return out + line.slice(pre.length);
}

function mk(type, parent) {
  return { type, parent, children: [], open: true, lines: [], lastLineBlank: false };
}

const THEMATIC_RE = /^(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/;
const ATX_RE = /^#{1,6}(?:[ \t]+|$)/;
const FENCE_RE = /^(`{3,})(?!.*`)|^(~{3,})/;
const SETEXT_RE = /^(?:=+|-+)[ \t]*$/;

function parseBlocks(src) {
  const root = mk('document', null);
  let lines = src.replace(/\r\n?/g, '\n').split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  let tip = root;

  const finalize = (b) => {
    if (!b.open) return;
    b.open = false;
    if (b.type === 'code' && !b.fenced) {
      while (b.lines.length && /^[ \t]*$/.test(b.lines[b.lines.length - 1])) b.lines.pop();
    } else if (b.type === 'list') {
      b.tight = true;
      const gap = (x, y) => y.startLine > x.endLine + 1;
      const items = b.children;
      for (let i = 0; i < items.length && b.tight; i++) {
        if (i + 1 < items.length && gap(items[i], items[i + 1])) b.tight = false;
        const subs = items[i].children;
        for (let j = 0; j + 1 < subs.length; j++) if (gap(subs[j], subs[j + 1])) { b.tight = false; break; }
      }
    }
    tip = b.parent;
  };
  const canContain = (p, t) => {
    if (p.type === 'document' || p.type === 'blockquote' || p.type === 'item') return t !== 'item';
    if (p.type === 'list') return t === 'item';
    return false;
  };
  const addChild = (type, container) => {
    while (!canContain(container, type)) { finalize(container); container = container.parent; }
    const b = mk(type, container);
    b.startLine = b.endLine = lineNo;
    container.children.push(b);
    tip = b;
    return b;
  };
  const lastOpenChild = (b) => {
    const c = b.children[b.children.length - 1];
    return c && c.open ? c : null;
  };

  let lineNo = -1;
  const touch = (b) => { while (b) { b.endLine = lineNo; b = b.parent; } };
  for (const rawLine of lines) {
    lineNo++;
    const line = expandLeadingTabs(rawLine);
    let pos = 0;
    const indentAt = () => { let p = pos; while (line[p] === ' ') p++; return p - pos; };
    const rest = () => line.slice(pos);
    const isBlankRest = () => /^[ \t]*$/.test(line.slice(pos));

    // 1. Match continuation of open containers.
    let container = root;
    let allMatched = true;
    let lineDone = false;
    let child;
    while ((child = lastOpenChild(container))) {
      const ind = indentAt();
      const blank = isBlankRest();
      let ok = false;
      switch (child.type) {
        case 'blockquote':
          if (ind <= 3 && line[pos + ind] === '>') {
            pos += ind + 1;
            if (line[pos] === ' ') pos++;
            ok = true;
          }
          break;
        case 'list':
          ok = true;
          break;
        case 'item':
          if (blank) {
            ok = child.children.length > 0;
            if (ok) pos += Math.min(ind, child.contentIndent);
          } else if (ind >= child.contentIndent) {
            pos += child.contentIndent; ok = true;
          }
          break;
        case 'code':
          if (child.fenced) {
            const r = rest().slice(ind);
            const m = ind <= 3 ? /^(`{3,}|~{3,})[ \t]*$/.exec(r) : null;
            if (m && m[1][0] === child.fenceChar && m[1].length >= child.fenceLen) {
              touch(child);
              finalize(child);
              lineDone = true;
            } else {
              pos += Math.min(ind, child.fenceOffset);
              ok = true;
            }
          } else if (ind >= 4) { pos += 4; ok = true; }
          else if (blank) { pos += ind; ok = true; }
          break;
        case 'paragraph':
          ok = !blank;
          break;
        default:
          ok = false;
      }
      if (lineDone) break;
      if (!ok) { allMatched = false; break; }
      container = child;
    }
    if (lineDone) continue;

    const lastMatched = container;
    let closedUnmatched = false;
    const closeUnmatched = () => {
      if (closedUnmatched) return;
      closedUnmatched = true;
      while (tip !== lastMatched && tip !== root) finalize(tip);
      tip = lastMatched;
    };

    // 2. Try block starts.
    let startedNew = false;
    const leafCode = container.type === 'code';
    if (!leafCode) {
      for (;;) {
        const ind = indentAt();
        const blank = isBlankRest();
        if (ind >= 4) {
          if (tip.type !== 'paragraph' && !blank) {
            pos += 4;
            closeUnmatched();
            const b = addChild('code', container);
            b.fenced = false;
            container = b;
            startedNew = true;
          }
          break;
        }
        const r = line.slice(pos + ind);
        if (r[0] === '>') {
          pos += ind + 1;
          if (line[pos] === ' ') pos++;
          closeUnmatched();
          container = addChild('blockquote', container);
          startedNew = true;
          continue;
        }
        let m;
        if ((m = ATX_RE.exec(r))) {
          closeUnmatched();
          const b = addChild('heading', container);
          b.level = m[0].trim().length;
          b.content = r.slice(m[0].length).replace(/^[ \t]*#+[ \t]*$/, '').replace(/[ \t]+#+[ \t]*$/, '');
          finalize(b);
          container = b;
          startedNew = true;
          lineDone = true;
          break;
        }
        if ((m = FENCE_RE.exec(r))) {
          const fence = m[1] || m[2];
          closeUnmatched();
          const b = addChild('code', container);
          b.fenced = true;
          b.fenceChar = fence[0];
          b.fenceLen = fence.length;
          b.fenceOffset = ind;
          b.info = unescapeString(r.slice(fence.length).trim());
          container = b;
          startedNew = true;
          lineDone = true;
          break;
        }
        if (container.type === 'paragraph' && allMatched && SETEXT_RE.test(r)) {
          closeUnmatched();
          container.type = 'heading';
          container.level = r[0] === '=' ? 1 : 2;
          container.content = container.lines.join('\n');
          finalize(container);
          startedNew = true;
          lineDone = true;
          break;
        }
        if (THEMATIC_RE.test(r.replace(/[ \t]+$/, ''))) {
          closeUnmatched();
          const b = addChild('hr', container);
          finalize(b);
          container = b;
          startedNew = true;
          lineDone = true;
          break;
        }
        // list item
        let lm = /^([*+-])(?=[ \t]|$)/.exec(r);
        let ordered = false, start = 1, delim = null, bullet = null, markerLen = 0;
        if (lm) { bullet = lm[1]; markerLen = 1; }
        else if ((lm = /^(\d{1,9})([.)])(?=[ \t]|$)/.exec(r))) {
          ordered = true; start = parseInt(lm[1], 10); delim = lm[2]; markerLen = lm[0].length;
        }
        if (lm && container.type !== 'paragraph' || lm && (/\S/.test(r.slice(markerLen)) && (!ordered || start === 1))) {
          const after = r.slice(markerLen);
          let sp = 0; while (after[sp] === ' ') sp++;
          const restBlank = /^[ \t]*$/.test(after);
          let padding;
          if (restBlank || sp === 0) padding = markerLen + 1;
          else if (sp >= 5) padding = markerLen + 1;
          else padding = markerLen + sp;
          closeUnmatched();
          // find or create list
          let list = container;
          if (!(list.type === 'list' && list.ordered === ordered && (ordered ? list.delim === delim : list.bullet === bullet))) {
            list = addChild('list', container);
            list.ordered = ordered; list.start = start; list.delim = delim; list.bullet = bullet;
          }
          const item = addChild('item', list);
          item.contentIndent = ind + padding;
          if (restBlank) pos = line.length;
          else if (sp >= 5) pos += ind + markerLen + 1;
          else pos += ind + markerLen + sp;
          container = item;
          startedNew = true;
          continue;
        }
        break;
      }
    }

    if (lineDone) {
      // nothing more to add for this line (heading/hr/fence-open/setext)
      setBlank(container, false);
      touch(container);
      continue;
    }

    const blank = isBlankRest();
    // 3. Lazy paragraph continuation
    if (!startedNew && !allMatched && tip.type === 'paragraph' && !blank) {
      tip.lines.push(line.slice(pos).replace(/^[ \t]+/, ''));
      touch(tip);
      continue;
    }
    if (!startedNew || !allMatched) closeUnmatched();
    if (startedNew && tip !== container) tip = container;

    const t = container.type;
    const llb = blank && !(t === 'blockquote' || (t === 'code' && container.fenced) ||
      (t === 'item' && container.children.length === 0 && startedNew));
    setBlank(container, llb);

    if (!blank || (t === 'code' && container.fenced)) touch(container);
    if (t === 'code') {
      container.lines.push(line.slice(pos));
    } else if (t === 'paragraph') {
      container.lines.push(line.slice(pos).replace(/^[ \t]+/, ''));
    } else if (!blank) {
      const p = addChild('paragraph', container);
      touch(p);
      p.lines.push(line.slice(pos).replace(/^[ \t]+/, ''));
    }
  }
  function setBlank(c, v) { while (c) { c.lastLineBlank = v; c = c.parent; } }
  // finalize any remaining open blocks
  const closeAll = (b) => { for (const c of b.children) closeAll(c); if (b.open && b !== root) { const s = tip; finalize(b); tip = s; } };
  closeAll(root);
  return root;
}

// ---------------------------------------------------------------- Inline parsing

function isWs(c) { return c === undefined || WS_RE.test(c); }
function isPunct(c) { return c !== undefined && PUNCT_RE.test(c); }

function parseInlines(src) {
  const s = src;
  let pos = 0;
  const root = [];
  const delims = [];
  const brackets = [];
  let arr = root;

  const pushText = (v) => {
    const last = arr[arr.length - 1];
    if (last && last.t === 'text' && !last.delim) last.v += v;
    else arr.push({ t: 'text', v });
  };

  const parseLinkTail = (p) => {
    // p points just after ']' ; expects '('
    if (s[p] !== '(') return null;
    p++;
    const skipWs = () => { while (p < s.length && /[ \t\n]/.test(s[p])) p++; };
    skipWs();
    let dest = '';
    if (s[p] === '<') {
      let q = p + 1;
      while (q < s.length && s[q] !== '>' && s[q] !== '<' && s[q] !== '\n') {
        if (s[q] === '\\' && q + 1 < s.length) q++;
        q++;
      }
      if (s[q] !== '>') return null;
      dest = s.slice(p + 1, q);
      p = q + 1;
    } else {
      let q = p, depth = 0;
      while (q < s.length) {
        const c = s[q];
        if (c === '\\' && q + 1 < s.length && ASCII_PUNCT.test(s[q + 1])) { q += 2; continue; }
        if (c === '(') depth++;
        else if (c === ')') { if (depth === 0) break; depth--; }
        else if (/[\x00-\x20\x7f]/.test(c)) break;
        q++;
      }
      if (depth !== 0) return null;
      dest = s.slice(p, q);
      p = q;
    }
    const beforeWs = p;
    skipWs();
    let title = null;
    if (p > beforeWs || s[p] === ')') {
      const c = s[p];
      if (c === '"' || c === "'" || c === '(') {
        const close = c === '(' ? ')' : c;
        let q = p + 1;
        while (q < s.length && s[q] !== close) {
          if (s[q] === '\\' && q + 1 < s.length) q++;
          else if (c === '(' && s[q] === '(') return null;
          q++;
        }
        if (q >= s.length) return null;
        title = s.slice(p + 1, q);
        p = q + 1;
        skipWs();
      }
    }
    if (s[p] !== ')') return null;
    return { dest: unescapeString(dest), title: title === null ? null : unescapeString(title), end: p + 1 };
  };

  while (pos < s.length) {
    const c = s[pos];
    if (c === '\\') {
      const n = s[pos + 1];
      if (n === '\n') { arr.push({ t: 'br' }); pos += 2; while (s[pos] === ' ' || s[pos] === '\t') pos++; continue; }
      if (n !== undefined && ASCII_PUNCT.test(n)) { pushText(n); pos += 2; continue; }
      pushText('\\'); pos++; continue;
    }
    if (c === '&') {
      const m = ENTITY_RE.exec(s.slice(pos));
      if (m) { const d = decodeEntity(m); if (d !== null) { pushText(d); pos += m[0].length; continue; } }
      pushText('&'); pos++; continue;
    }
    if (c === '`') {
      let q = pos; while (s[q] === '`') q++;
      const n = q - pos;
      let r = q, found = -1;
      while (r < s.length) {
        if (s[r] === '`') {
          let e = r; while (s[e] === '`') e++;
          if (e - r === n) { found = r; break; }
          r = e;
        } else r++;
      }
      if (found < 0) { pushText(s.slice(pos, q)); pos = q; continue; }
      let code = s.slice(q, found).replace(/\n/g, ' ');
      if (code.length >= 2 && code[0] === ' ' && code[code.length - 1] === ' ' && /[^ ]/.test(code)) code = code.slice(1, -1);
      arr.push({ t: 'code', v: code });
      pos = found + n;
      continue;
    }
    if (c === '\n') {
      // trailing spaces
      const last = arr[arr.length - 1];
      let hard = false;
      if (last && last.t === 'text' && !last.delim) {
        const m = / +$/.exec(last.v);
        if (m) { hard = m[0].length >= 2; last.v = last.v.slice(0, -m[0].length); }
      }
      arr.push({ t: hard ? 'br' : 'softbreak' });
      pos++;
      while (s[pos] === ' ' || s[pos] === '\t') pos++;
      continue;
    }
    if (c === '<') {
      const rest = s.slice(pos);
      let m = /^<([A-Za-z][A-Za-z0-9.+-]{1,31}:[^<>\x00-\x20]*)>/.exec(rest);
      if (m) { arr.push({ t: 'link', dest: m[1], title: null, c: [{ t: 'text', v: m[1] }] }); pos += m[0].length; continue; }
      m = /^<([a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/.exec(rest);
      if (m) { arr.push({ t: 'link', dest: 'mailto:' + m[1], title: null, c: [{ t: 'text', v: m[1] }] }); pos += m[0].length; continue; }
      pushText('<'); pos++; continue;
    }
    if (c === '*' || c === '_') {
      let q = pos; while (s[q] === c) q++;
      const n = q - pos;
      const before = pos === 0 ? undefined : s[pos - 1];
      const after = s[q];
      const bWs = isWs(before), aWs = isWs(after);
      const bP = isPunct(before), aP = isPunct(after);
      const left = !aWs && (!aP || bWs || bP);
      const right = !bWs && (!bP || aWs || aP);
      let canOpen, canClose;
      if (c === '*') { canOpen = left; canClose = right; }
      else { canOpen = left && (!right || bP); canClose = right && (!left || aP); }
      const node = { t: 'text', v: s.slice(pos, q), delim: true };
      arr.push(node);
      delims.push({ node, ch: c, count: n, orig: n, canOpen, canClose, arr });
      pos = q;
      continue;
    }
    if (c === '[' || (c === '!' && s[pos + 1] === '[')) {
      const image = c === '!';
      const len = image ? 2 : 1;
      const node = { t: 'text', v: s.slice(pos, pos + len), delim: true };
      arr.push(node);
      brackets.push({ node, image, active: true, delimBottom: delims.length, arr });
      pos += len;
      continue;
    }
    if (c === ']') {
      const br = brackets[brackets.length - 1];
      if (!br) { pushText(']'); pos++; continue; }
      if (!br.active) { brackets.pop(); pushText(']'); pos++; continue; }
      const tail = parseLinkTail(pos + 1);
      if (!tail) { brackets.pop(); pushText(']'); pos++; continue; }
      const a = br.arr;
      const idx = a.indexOf(br.node);
      const inner = a.splice(idx + 1);
      a.pop(); // remove bracket node
      const link = { t: br.image ? 'image' : 'link', dest: tail.dest, title: tail.title, c: inner };
      a.push(link);
      for (let i = br.delimBottom; i < delims.length; i++) delims[i].arr = inner;
      processEmphasis(delims, br.delimBottom);
      brackets.pop();
      if (!br.image) for (const b of brackets) b.active = false;
      arr = a;
      pos = tail.end;
      continue;
    }
    // plain text run
    let q = pos + 1;
    while (q < s.length && !/[\\&`\n<*_[\]!]/.test(s[q])) q++;
    pushText(s.slice(pos, q));
    pos = q;
  }
  processEmphasis(delims, 0);
  return root;
}

function processEmphasis(delims, bottom) {
  const openersBottom = {};
  let i = bottom;
  while (i < delims.length) {
    const closer = delims[i];
    if (!closer.canClose) { i++; continue; }
    const key = closer.ch + (closer.canOpen ? '1' : '0') + (closer.orig % 3);
    const lower = openersBottom[key] !== undefined ? openersBottom[key] : bottom - 1;
    let j = i - 1, found = false;
    while (j >= bottom && j > lower) {
      const op = delims[j];
      if (op.ch === closer.ch && op.canOpen) {
        const odd = (closer.canOpen || op.canClose) && (op.orig + closer.orig) % 3 === 0 &&
          !(op.orig % 3 === 0 && closer.orig % 3 === 0);
        if (!odd) { found = true; break; }
      }
      j--;
    }
    if (!found) {
      openersBottom[key] = i - 1;
      if (!closer.canOpen) delims.splice(i, 1);
      else i++;
      continue;
    }
    const op = delims[j];
    const use = closer.count >= 2 && op.count >= 2 ? 2 : 1;
    op.count -= use; closer.count -= use;
    op.node.v = op.node.v.slice(use);
    closer.node.v = closer.node.v.slice(use);
    const a = op.arr;
    const ai = a.indexOf(op.node), bi = a.indexOf(closer.node);
    const inner = a.splice(ai + 1, bi - ai - 1);
    a.splice(ai + 1, 0, { t: use === 1 ? 'em' : 'strong', c: inner });
    delims.splice(j + 1, i - j - 1);
    i = j + 1;
    if (op.count === 0) { a.splice(a.indexOf(op.node), 1); delims.splice(j, 1); i--; }
    if (closer.count === 0) { a.splice(a.indexOf(closer.node), 1); delims.splice(i, 1); }
  }
  delims.length = Math.min(delims.length, bottom);
}

function renderInlines(nodes) {
  let out = '';
  for (const n of nodes) {
    switch (n.t) {
      case 'text': out += escapeHtml(n.v); break;
      case 'softbreak': out += '\n'; break;
      case 'br': out += '<br />\n'; break;
      case 'code': out += '<code>' + escapeHtml(n.v) + '</code>'; break;
      case 'em': out += '<em>' + renderInlines(n.c) + '</em>'; break;
      case 'strong': out += '<strong>' + renderInlines(n.c) + '</strong>'; break;
      case 'link':
        out += '<a href="' + escapeHtml(normalizeUrl(n.dest)) + '"' +
          (n.title !== null ? ' title="' + escapeHtml(n.title) + '"' : '') + '>' + renderInlines(n.c) + '</a>';
        break;
      case 'image':
        out += '<img src="' + escapeHtml(normalizeUrl(n.dest)) + '" alt="' + escapeHtml(plainText(n.c)) + '"' +
          (n.title !== null ? ' title="' + escapeHtml(n.title) + '"' : '') + ' />';
        break;
    }
  }
  return out;
}

function plainText(nodes) {
  let out = '';
  for (const n of nodes) {
    if (n.t === 'text' || n.t === 'code') out += n.v;
    else if (n.t === 'softbreak' || n.t === 'br') out += '\n';
    else if (n.c) out += plainText(n.c);
  }
  return out;
}

const inline = (text) => renderInlines(parseInlines(text.trim()));

// ---------------------------------------------------------------- Rendering

function renderBlock(b, tight) {
  switch (b.type) {
    case 'document': return b.children.map(c => renderBlock(c, false)).join('');
    case 'paragraph': {
      const content = inline(b.lines.join('\n'));
      return tight ? content : '<p>' + content + '</p>\n';
    }
    case 'heading': return `<h${b.level}>` + inline(b.content) + `</h${b.level}>\n`;
    case 'hr': return '<hr />\n';
    case 'code': {
      const lang = b.fenced && b.info ? b.info.split(/[ \t]+/)[0] : '';
      const body = b.lines.length ? b.lines.join('\n') + '\n' : '';
      return '<pre><code' + (lang ? ` class="language-${escapeHtml(lang)}"` : '') + '>' + escapeHtml(body) + '</code></pre>\n';
    }
    case 'blockquote':
      return '<blockquote>\n' + b.children.map(c => renderBlock(c, false)).join('') + '</blockquote>\n';
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      const startAttr = b.ordered && b.start !== 1 ? ` start="${b.start}"` : '';
      return `<${tag}${startAttr}>\n` + b.children.map(c => renderBlock(c, b.tight)).join('') + `</${tag}>\n`;
    }
    case 'item': {
      let inner = '';
      b.children.forEach((c, i) => {
        const r = renderBlock(c, tight);
        if (tight && c.type === 'paragraph') inner += r;
        else inner += (i === 0 ? '\n' : '') + r;
      });
      if (tight && b.children.length && b.children[b.children.length - 1].type === 'paragraph') {
        // no trailing newline
      }
      return '<li>' + inner + '</li>\n';
    }
  }
  return '';
}

export function render(markdown) {
  return renderBlock(parseBlocks(String(markdown ?? '')), false);
}

export default render;
