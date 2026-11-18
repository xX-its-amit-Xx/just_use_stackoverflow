const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const PUNCT = /[\p{P}\p{S}]/u;
const ESCAPABLE = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';

function normUrl(u) {
  return esc(u.replace(/%[0-9a-fA-F]{2}|[^\x21-\x7e]|[\\"<>^`{|}\[\]]/gu, m => {
    if (m.length === 3 && m[0] === '%') return m;
    if (m === '[' || m === ']') return m === '[' ? '%5B' : '%5D';
    return encodeURIComponent(m).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  }));
}
function unescapeStr(s) {
  return decodeEntities(s.replace(/\\([!-\/:-@\[-`{-~])/g, '$1'));
}
function decodeEntities(s) {
  return s.replace(/&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|(amp|lt|gt|quot|apos|nbsp|copy|reg));/g, (m, h, d, n) => {
    if (n) return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®' }[n];
    let c = h ? parseInt(h, 16) : parseInt(d, 10);
    if (!c || c > 0x10ffff || (c >= 0xd800 && c < 0xe000)) c = 0xfffd;
    return String.fromCodePoint(c);
  });
}

function parseLinkTail(s, i) {
  // s[i] === '(' ; returns {url,title,end} or null
  let p = i + 1;
  const ws = () => { while (p < s.length && /[ \t\n]/.test(s[p])) p++; };
  ws();
  let url = '';
  if (s[p] === '<') {
    let q = p + 1;
    while (q < s.length && s[q] !== '>' && s[q] !== '\n' && s[q] !== '<') { if (s[q] === '\\') q++; q++; }
    if (s[q] !== '>') return null;
    url = s.slice(p + 1, q); p = q + 1;
  } else {
    let depth = 0, q = p;
    while (q < s.length) {
      const c = s[q];
      if (c === '\\' && q + 1 < s.length && ESCAPABLE.includes(s[q + 1])) { q += 2; continue; }
      if (c === '(') depth++;
      else if (c === ')') { if (depth === 0) break; depth--; }
      else if (/[\s\x00-\x1f]/.test(c)) break;
      q++;
    }
    if (depth !== 0) return null;
    url = s.slice(p, q); p = q;
  }
  const before = p;
  ws();
  let title = null;
  if (p > before && (s[p] === '"' || s[p] === "'" || s[p] === '(')) {
    const close = s[p] === '(' ? ')' : s[p];
    let q = p + 1;
    while (q < s.length && s[q] !== close) { if (s[q] === '\\') q++; q++; }
    if (q >= s.length) return null;
    title = s.slice(p + 1, q); p = q + 1;
    ws();
  }
  if (s[p] !== ')') return null;
  return { url: unescapeStr(url), title: title === null ? null : unescapeStr(title), end: p + 1 };
}

function inline(src) {
  const s = src;
  const nodes = [];
  const brackets = []; // {idx, image, active, pos}
  let text = '';
  const flush = () => { if (text) { nodes.push({ t: 'h', v: esc(text) }); text = ''; } };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      if (s[i + 1] === '\n') { flush(); nodes.push({ t: 'h', v: '<br />\n' }); i += 2; while (s[i] === ' ' || s[i] === '\t') i++; continue; }
      if (i + 1 < s.length && ESCAPABLE.includes(s[i + 1])) { text += s[i + 1]; i += 2; continue; }
      text += c; i++; continue;
    }
    if (c === '`') {
      let n = 1; while (s[i + n] === '`') n++;
      let j = i + n, found = -1;
      while (j < s.length) {
        if (s[j] === '`') {
          let m = 1; while (s[j + m] === '`') m++;
          if (m === n) { found = j; break; }
          j += m;
        } else j++;
      }
      if (found < 0) { text += '`'.repeat(n); i += n; continue; }
      let code = s.slice(i + n, found).replace(/\n/g, ' ');
      if (code.length > 2 && code[0] === ' ' && code[code.length - 1] === ' ' && /[^ ]/.test(code)) code = code.slice(1, -1);
      flush(); nodes.push({ t: 'h', v: '<code>' + esc(code) + '</code>' });
      i = found + n; continue;
    }
    if (c === '\n') {
      const hard = / {2,}$/.test(text);
      text = text.replace(/ +$/, '');
      flush();
      nodes.push({ t: 'h', v: hard ? '<br />\n' : '\n' });
      i++; while (s[i] === ' ' || s[i] === '\t') i++;
      continue;
    }
    if (c === '&') {
      const m = /^&(?:#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos|nbsp|copy|reg);/.exec(s.slice(i, i + 12));
      if (m) { text += decodeEntities(m[0]); i += m[0].length; continue; }
    }
    if (c === '*' || c === '_') {
      let n = 1; while (s[i + n] === c) n++;
      const before = i === 0 ? '\n' : String.fromCodePoint(s.codePointAt(i - 1 - ((s.charCodeAt(i - 1) & 0xfc00) === 0xdc00 && i > 1 ? 1 : 0)));
      const after = i + n >= s.length ? '\n' : String.fromCodePoint(s.codePointAt(i + n));
      const wsB = /\s/.test(before) || before === ' ', wsA = /\s/.test(after) || after === ' ';
      const pB = PUNCT.test(before), pA = PUNCT.test(after);
      const lf = !wsA && (!pA || wsB || pB);
      const rf = !wsB && (!pB || wsA || pA);
      let canOpen, canClose;
      if (c === '*') { canOpen = lf; canClose = rf; }
      else { canOpen = lf && (!rf || pB); canClose = rf && (!lf || pA); }
      flush();
      nodes.push({ t: 'd', ch: c, n, orig: n, canOpen, canClose, open: [], close: [] });
      i += n; continue;
    }
    if (c === '[' || (c === '!' && s[i + 1] === '[')) {
      const image = c === '!';
      flush();
      nodes.push({ t: 'h', v: image ? '![' : '[' });
      brackets.push({ idx: nodes.length - 1, image, active: true, pos: i + (image ? 2 : 1) });
      i += image ? 2 : 1; continue;
    }
    if (c === ']') {
      const b = brackets.pop();
      if (!b) { text += c; i++; continue; }
      if (!b.active) { text += c; i++; continue; }
      let r = s[i + 1] === '(' ? parseLinkTail(s, i + 1) : null;
      if (!r) { text += c; i++; continue; }
      flush();
      const inner = nodes.splice(b.idx + 1);
      nodes.pop();
      const content = render_nodes(inner);
      let h;
      if (b.image) {
        const alt = content.replace(/<[^>]*>/g, '');
        h = '<img src="' + normUrl(r.url) + '" alt="' + alt + '"' + (r.title !== null ? ' title="' + esc(r.title) + '"' : '') + ' />';
      } else {
        h = '<a href="' + normUrl(r.url) + '"' + (r.title !== null ? ' title="' + esc(r.title) + '"' : '') + '>' + content + '</a>';
        brackets.forEach(x => { if (!x.image) x.active = false; });
      }
      nodes.push({ t: 'h', v: h });
      i = r.end; continue;
    }
    text += c; i++;
  }
  flush();
  return render_nodes(nodes);
}

function render_nodes(nodes) {
  // process emphasis
  for (let ci = 0; ci < nodes.length; ci++) {
    const cl = nodes[ci];
    if (cl.t !== 'd' || !cl.canClose || cl.n === 0) continue;
    for (;;) {
      let oi = -1;
      for (let k = ci - 1; k >= 0; k--) {
        const o = nodes[k];
        if (o.t === 'd' && o.ch === cl.ch && o.canOpen && o.n > 0) {
          if ((o.canClose || cl.canOpen) && (o.orig + cl.orig) % 3 === 0 && !(o.orig % 3 === 0 && cl.orig % 3 === 0)) continue;
          oi = k; break;
        }
      }
      if (oi < 0) break;
      const o = nodes[oi];
      const use = o.n >= 2 && cl.n >= 2 ? 2 : 1;
      o.n -= use; cl.n -= use;
      o.open.unshift(use === 2 ? '<strong>' : '<em>');
      cl.close.push(use === 2 ? '</strong>' : '</em>');
      for (let k = oi + 1; k < ci; k++) if (nodes[k].t === 'd') { nodes[k].n = 0; }
      // delimiters between are no longer usable (but still output as text)
      if (cl.n === 0) break;
    }
  }
  return nodes.map(x => x.t === 'h' ? x.v : x.close.join('') + x.ch.repeat(x.n) + x.open.join('')).join('');
}

// ---------- blocks ----------
const reHr = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const reAtx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const reFence = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\n]*?)[ \t]*$/;
const reBullet = /^( {0,3})([-+*])( +|$)/;
const reOrdered = /^( {0,3})(\d{1,9})([.)])( +|$)/;
const blank = l => /^[ \t]*$/.test(l);

function listMarker(l) {
  let m = reBullet.exec(l);
  if (m) return { type: 'ul', ch: m[2], indent: m[1].length + 1 + (m[3].length > 4 || m[3] === '' ? 1 : m[3].length), rest: l.slice(m[0].length - (m[3].length > 4 ? m[3].length - 1 : m[3].length === 0 ? 0 : 0)), empty: m[3] === '' };
  m = reOrdered.exec(l);
  if (m) {
    const w = m[2].length + 1;
    const sp = m[4].length > 4 || m[4] === '' ? 1 : m[4].length;
    return { type: 'ol', ch: m[3], num: parseInt(m[2], 10), indent: m[1].length + w + sp, rest: l.slice(m[0].length - m[4].length + (m[4].length > 4 ? 1 : m[4].length)), empty: m[4] === '' };
  }
  return null;
}

function blocks(lines) {
  let out = '';
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (blank(l)) { i++; continue; }
    let m;
    if ((m = reFence.exec(l)) && !(m[2][0] === '`' && m[3].includes('`'))) {
      const fence = m[2], ind = m[1].length;
      const lang = unescapeStr(m[3]).split(/\s+/)[0];
      const body = [];
      i++;
      while (i < lines.length) {
        const cm = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[i]);
        if (cm && cm[1][0] === fence[0] && cm[1].length >= fence.length) { i++; break; }
        body.push(lines[i].replace(new RegExp('^ {0,' + ind + '}'), ''));
        i++;
      }
      out += '<pre><code' + (lang ? ' class="language-' + esc(lang) + '"' : '') + '>' + esc(body.join('\n')) + (body.length ? '\n' : '') + '</code></pre>\n';
      continue;
    }
    if (/^( {4}|\t)/.test(l)) {
      const body = [];
      while (i < lines.length && (/^( {4}|\t)/.test(lines[i]) || (blank(lines[i]) && lines.slice(i).find(x => !blank(x)) !== undefined && /^( {4}|\t)/.test(lines.slice(i).find(x => !blank(x)))))) {
        body.push(lines[i].replace(/^( {4}|\t)/, '')); i++;
      }
      out += '<pre><code>' + esc(body.join('\n')) + '\n</code></pre>\n';
      continue;
    }
    if ((m = reAtx.exec(l))) {
      out += '<h' + m[1].length + '>' + inline((m[2] || '').trim()) + '</h' + m[1].length + '>\n';
      i++; continue;
    }
    if (reHr.test(l)) { out += '<hr />\n'; i++; continue; }
    if (/^ {0,3}>/.test(l)) {
      const inner = [];
      while (i < lines.length) {
        const q = /^ {0,3}> ?(.*)$/.exec(lines[i]);
        if (q) { inner.push(q[1]); i++; }
        else if (!blank(lines[i]) && inner.length && !blank(inner[inner.length - 1]) && !startsBlock(lines[i])) { inner.push(lines[i]); i++; }
        else break;
      }
      out += '<blockquote>\n' + blocks(inner) + '</blockquote>\n';
      continue;
    }
    const lm = listMarker(l);
    if (lm) {
      const items = [];
      let loose = false;
      while (i < lines.length) {
        const mk = listMarker(lines[i]);
        if (!mk || mk.type !== lm.type || mk.ch !== lm.ch || reHr.test(lines[i])) break;
        const first = mk.empty ? '' : mk.rest;
        const body = [first];
        const ind = mk.indent;
        i++;
        let sawBlank = false;
        while (i < lines.length) {
          const x = lines[i];
          if (blank(x)) {
            // continue only if next nonblank is indented
            let j = i; while (j < lines.length && blank(lines[j])) j++;
            if (j < lines.length && new RegExp('^ {' + ind + '}').test(lines[j]) ) { for (; i < j; i++) body.push(''); sawBlank = true; continue; }
            break;
          }
          if (new RegExp('^ {' + ind + '}').test(x)) { body.push(x.slice(ind)); continue; }
          if (!blank(body[body.length - 1]) && !startsBlock(x) && !listMarker(x)) { body.push(x.trim()); i++; continue; }
          break;
        }
        void sawBlank;
        items.push(body);
        // blank lines between items
        let j = i; while (j < lines.length && blank(lines[j])) j++;
        if (j > i) {
          const nm = j < lines.length ? listMarker(lines[j]) : null;
          if (nm && nm.type === lm.type && nm.ch === lm.ch && !reHr.test(lines[j])) { loose = true; i = j; } else break;
        }
      }
      for (const b of items) {
        // item containing blank line between direct children makes list loose
        while (b.length && blank(b[b.length - 1])) b.pop();
      }
      if (items.some(b => hasInnerBlank(b))) loose = true;
      let h = lm.type === 'ol' ? '<ol' + (lm.num !== 1 ? ' start="' + lm.num + '"' : '') + '>\n' : '<ul>\n';
      for (const b of items) {
        const inner = blocks(b);
        let content = inner;
        if (!loose) content = inner.replace(/<p>([\s\S]*?)<\/p>\n/g, '$1\n').replace(/\n$/, '');
        h += '<li>' + (loose && inner ? '\n' : '') + content + (loose && inner ? '' : '') + '</li>\n';
      }
      out += h + (lm.type === 'ol' ? '</ol>\n' : '</ul>\n');
      continue;
    }
    // paragraph
    const para = [l];
    i++;
    let setext = 0;
    while (i < lines.length && !blank(lines[i])) {
      const x = lines[i];
      if (/^ {0,3}=+[ \t]*$/.test(x)) { setext = 1; i++; break; }
      if (/^ {0,3}-+[ \t]*$/.test(x)) { setext = 2; i++; break; }
      if (startsBlock(x) && !(listMarker(x) && (listMarker(x).empty || (listMarker(x).type === 'ol' && listMarker(x).num !== 1)))) break;
      para.push(x); i++;
    }
    const txt = para.map(x => x.replace(/^[ \t]+/, '')).join('\n').replace(/[ \t]+$/, '');
    if (setext) out += '<h' + setext + '>' + inline(txt) + '</h' + setext + '>\n';
    else out += '<p>' + inline(txt) + '</p>\n';
  }
  return out;
}

function hasInnerBlank(b) {
  // blank line between two blocks directly in the item (not inside a fence)
  let fence = false;
  for (let k = 0; k < b.length; k++) {
    if (/^ {0,3}(```|~~~)/.test(b[k])) fence = !fence;
    if (!fence && blank(b[k]) && k > 0 && k < b.length - 1 && !/^ /.test(b[k + 1])) return true;
  }
  return false;
}

function startsBlock(l) {
  return reHr.test(l) || reAtx.test(l) || /^ {0,3}>/.test(l) || (reFence.test(l) && !/^ *`{3,}[^`]*`/.test(l.replace(/^( *`{3,})/, '$1')) ) || !!listMarker(l);
}

export function render(markdown) {
  const lines = String(markdown).replace(/\r\n?/g, '\n').replace(/\u0000/g, '�').split('\n');
  return blocks(lines);
}
