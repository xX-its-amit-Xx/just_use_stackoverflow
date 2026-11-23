const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', hellip: '…', mdash: '—', ndash: '–' };
function decodeEnt(s) {
  return s.replace(/&(?:#[xX]([0-9a-fA-F]{1,6})|#(\d{1,7})|([A-Za-z][A-Za-z0-9]*));/g, (m, h, d, n) => {
    if (h || d) { const c = h ? parseInt(h, 16) : parseInt(d, 10); return c && c <= 0x10ffff && !(c >= 0xd800 && c < 0xe000) ? String.fromCodePoint(c) : '�'; }
    return ENT[n] !== undefined ? ENT[n] : m;
  });
}
const unescapeMd = (s) => s.replace(/\\([!-\/:-@\[-`{-~])/g, '$1');
function normUrl(u) {
  u = decodeEnt(unescapeMd(u));
  let out = '';
  for (const ch of u) {
    if (/[A-Za-z0-9;\/?:@&=+$,\-_.!~*'()#]/.test(ch)) out += ch;
    else if (ch === '%' ) out += /^%[0-9a-fA-F]{2}/.test(u.slice(out.length)) ? '%' : '%25';
    else out += [...new TextEncoder().encode(ch)].map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('');
  }
  return esc(out);
}
const isPunct = (c) => c !== undefined && /[\p{P}\p{S}]/u.test(c);
const isWs = (c) => c === undefined || /[\s ]/u.test(c);

function parseLinkTail(s, pos) {
  // s[pos] === '(' ; returns {dest,title,end} or null
  let i = pos + 1;
  const skip = () => { while (i < s.length && /[ \t\n]/.test(s[i])) i++; };
  skip();
  let dest = '';
  if (s[i] === '<') {
    i++;
    while (i < s.length && s[i] !== '>' && s[i] !== '\n' && s[i] !== '<') { if (s[i] === '\\' && i + 1 < s.length) { dest += s[i++]; } dest += s[i++]; }
    if (s[i] !== '>') return null;
    i++;
  } else {
    let depth = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\' && i + 1 < s.length && /[!-\/:-@\[-`{-~]/.test(s[i + 1])) { dest += c + s[i + 1]; i += 2; continue; }
      if (c === '(') depth++;
      else if (c === ')') { if (depth === 0) break; depth--; }
      else if (/[\s\x00-\x1f]/.test(c)) break;
      dest += c; i++;
    }
    if (depth !== 0) return null;
  }
  const before = i;
  skip();
  let title = null;
  if (i > before && /["'(]/.test(s[i])) {
    const open = s[i], close = open === '(' ? ')' : open;
    let j = i + 1, t = '';
    while (j < s.length && s[j] !== close) { if (s[j] === '\\' && j + 1 < s.length) t += s[j++]; t += s[j++]; }
    if (s[j] !== close) return null;
    title = t; i = j + 1; skip();
  }
  if (s[i] !== ')') return null;
  return { dest, title, end: i + 1 };
}

function renderNodes(nodes) {
  return nodes.map((n) => (n.t === 'd' ? n.ch.repeat(n.n) : n.v)).join('');
}
function processEmph(nodes, from) {
  for (let ci = from; ci < nodes.length; ci++) {
    const c = nodes[ci];
    if (c.t !== 'd' || !c.close || c.n === 0) continue;
    let oi = -1;
    for (let k = ci - 1; k >= from; k--) {
      const o = nodes[k];
      if (o.t === 'd' && o.open && o.n > 0 && o.ch === c.ch &&
        !((o.close || c.open) && (o.orig + c.orig) % 3 === 0 && !(o.orig % 3 === 0 && c.orig % 3 === 0))) { oi = k; break; }
    }
    if (oi < 0) { if (!c.open) c.close = false; continue; }
    const o = nodes[oi];
    const strong = o.n >= 2 && c.n >= 2;
    const use = strong ? 2 : 1;
    const inner = renderNodes(nodes.slice(oi + 1, ci));
    o.n -= use; c.n -= use;
    const el = { t: 'x', v: (strong ? '<strong>' : '<em>') + inner + (strong ? '</strong>' : '</em>') };
    nodes.splice(oi + 1, ci - oi - 1, el);
    ci = c.n > 0 ? oi + 1 : oi + 2;
  }
  for (const n of nodes) if (n.t === 'd') { n.t = 't'; n.v = n.ch.repeat(n.n); }
}

function inline(s) {
  const nodes = [];
  const brackets = [];
  let buf = '';
  const flush = () => { if (buf) { nodes.push({ t: 't', v: esc(buf) }); buf = ''; } };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      if (s[i + 1] === '\n') { flush(); nodes.push({ t: 'x', v: '<br />\n' }); i += 2; while (s[i] === ' ') i++; continue; }
      if (/[!-\/:-@\[-`{-~]/.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
      buf += c; i++; continue;
    }
    if (c === '`') {
      let n = 0; while (s[i + n] === '`') n++;
      let j = i + n, found = -1;
      while (j < s.length) {
        if (s[j] === '`') { let m = 0; while (s[j + m] === '`') m++; if (m === n) { found = j; break; } j += m; } else j++;
      }
      if (found < 0) { buf += '`'.repeat(n); i += n; continue; }
      let code = s.slice(i + n, found).replace(/\n/g, ' ');
      if (/[^ ]/.test(code) && code[0] === ' ' && code[code.length - 1] === ' ') code = code.slice(1, -1);
      flush(); nodes.push({ t: 'x', v: '<code>' + esc(code) + '</code>' }); i = found + n; continue;
    }
    if (c === '&') {
      const m = /^&(?:#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[A-Za-z][A-Za-z0-9]*);/.exec(s.slice(i, i + 40));
      if (m) { const d = decodeEnt(m[0]); if (d !== m[0]) { buf += d; i += m[0].length; continue; } }
      buf += c; i++; continue;
    }
    if (c === '<') {
      const m = /^<([A-Za-z][A-Za-z0-9+.\-]{1,31}:[^\s<>]*)>/.exec(s.slice(i));
      const em = /^<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*)>/.exec(s.slice(i));
      if (m) { flush(); nodes.push({ t: 'x', v: `<a href="${normUrl(m[1])}">${esc(m[1])}</a>` }); i += m[0].length; continue; }
      if (em) { flush(); nodes.push({ t: 'x', v: `<a href="mailto:${normUrl(em[1])}">${esc(em[1])}</a>` }); i += em[0].length; continue; }
      buf += c; i++; continue;
    }
    if (c === '\n') {
      const hard = / {2,}$/.test(buf);
      buf = buf.replace(/ +$/, '');
      flush(); nodes.push({ t: 'x', v: hard ? '<br />\n' : '\n' }); i++;
      while (s[i] === ' ') i++;
      continue;
    }
    if (c === '*' || c === '_') {
      let n = 0; while (s[i + n] === c) n++;
      const before = i > 0 ? [...s.slice(Math.max(0, i - 2), i)].pop() : undefined;
      const after = s[i + n] !== undefined ? String.fromCodePoint(s.codePointAt(i + n)) : undefined;
      const lf = !isWs(after) && (!isPunct(after) || isWs(before) || isPunct(before));
      const rf = !isWs(before) && (!isPunct(before) || isWs(after) || isPunct(after));
      const open = c === '*' ? lf : lf && (!rf || isPunct(before));
      const close = c === '*' ? rf : rf && (!lf || isPunct(after));
      flush(); nodes.push({ t: 'd', ch: c, n, orig: n, open, close }); i += n; continue;
    }
    if (c === '[' || (c === '!' && s[i + 1] === '[')) {
      flush();
      const img = c === '!';
      nodes.push({ t: 't', v: img ? '![' : '[' });
      brackets.push({ idx: nodes.length - 1, img, active: true, pos: i + (img ? 2 : 1) });
      i += img ? 2 : 1; continue;
    }
    if (c === ']') {
      const b = brackets.pop();
      if (!b || !b.active) { buf += c; i++; continue; }
      flush();
      const tail = s[i + 1] === '(' ? parseLinkTail(s, i + 1) : null;
      if (!tail) { buf += c; i++; continue; }
      processEmph(nodes, b.idx + 1);
      const innerNodes = nodes.slice(b.idx + 1);
      let html;
      const title = tail.title !== null ? ` title="${esc(decodeEnt(unescapeMd(tail.title)))}"` : '';
      if (b.img) {
        const alt = innerNodes.map((n) => n.v).join('').replace(/<[^>]*>/g, '');
        html = `<img src="${normUrl(tail.dest)}" alt="${alt}"${title} />`;
      } else {
        html = `<a href="${normUrl(tail.dest)}"${title}>${renderNodes(innerNodes)}</a>`;
        for (const o of brackets) if (!o.img) o.active = false;
      }
      nodes.splice(b.idx, nodes.length - b.idx, { t: 'x', v: html });
      i = tail.end; continue;
    }
    buf += c; i++;
  }
  flush();
  processEmph(nodes, 0);
  return renderNodes(nodes);
}

const reFence = /^( {0,3})(`{3,}|~{3,})[ \t]*([^\n]*?)[ \t]*$/;
const reHr = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const reAtx = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const reItem = /^( {0,3})([-*+]|\d{1,9}[.)])( +|\t|$)/;
const reQuote = /^ {0,3}>/;

function interrupts(line) {
  if (reHr.test(line) || reAtx.test(line) || reQuote.test(line)) return true;
  const f = reFence.exec(line);
  if (f && !(f[2][0] === '`' && f[3].includes('`'))) return true;
  const m = reItem.exec(line);
  if (m && line.slice(m[0].length).trim() !== '' && (/^[-*+]/.test(m[2]) || /^1[.)]/.test(m[2]))) return true;
  return false;
}

function blocks(lines, tight = false) {
  let out = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^[ \t]*$/.test(line)) { i++; continue; }
    let m;
    if ((m = reFence.exec(line)) && !(m[2][0] === '`' && m[3].includes('`'))) {
      const indent = m[1].length, ch = m[2][0], len = m[2].length;
      const info = unescapeMd(decodeEnt(m[3])).split(/\s+/)[0];
      const body = [];
      i++;
      while (i < lines.length) {
        const cm = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[i]);
        if (cm && cm[1][0] === ch && cm[1].length >= len) { i++; break; }
        body.push(lines[i].replace(new RegExp('^ {0,' + indent + '}'), '')); i++;
      }
      out += `<pre><code${info ? ` class="language-${esc(info)}"` : ''}>${body.length ? esc(body.join('\n')) + '\n' : ''}</code></pre>\n`;
      continue;
    }
    if (reHr.test(line)) { out += '<hr />\n'; i++; continue; }
    if ((m = reAtx.exec(line))) {
      let t = (m[2] || '').replace(/[ \t]+#+[ \t]*$/, '').replace(/^#+[ \t]*$/, '').trim();
      out += `<h${m[1].length}>${inline(t)}</h${m[1].length}>\n`; i++; continue;
    }
    if (reQuote.test(line)) {
      const inner = [];
      while (i < lines.length) {
        if (reQuote.test(lines[i])) inner.push(lines[i].replace(/^ {0,3}> ?/, ''));
        else if (/^[ \t]*$/.test(lines[i]) || interrupts(lines[i]) || !inner.length || /^[ \t]*$/.test(inner[inner.length - 1]) || reFence.test(inner[inner.length - 1])) break;
        else inner.push(lines[i]);
        i++;
      }
      out += `<blockquote>\n${blocks(inner)}</blockquote>\n`; continue;
    }
    if ((m = reItem.exec(line))) {
      const ordered = /\d/.test(m[2][0]);
      const delim = ordered ? m[2].slice(-1) : m[2];
      const start = ordered ? parseInt(m[2], 10) : 1;
      const items = [];
      let loose = false, sawBlankBetween = false;
      while (i < lines.length) {
        const im = reItem.exec(lines[i]);
        if (!im || (ordered ? !/\d/.test(im[2][0]) || im[2].slice(-1) !== delim : im[2] !== delim) || reHr.test(lines[i])) break;
        let spaces = im[3].replace(/\t/g, '    ').length;
        const rest0 = lines[i].slice(im[0].length);
        if (rest0.trim() === '' ) spaces = 1; else if (spaces > 4) spaces = 1;
        const cw = im[1].length + im[2].length + spaces;
        const first = spaces === 1 && im[3].length > 4 ? ' '.repeat(im[3].length - 1) + rest0 : rest0;
        const body = [first];
        i++;
        while (i < lines.length) {
          const l = lines[i];
          if (/^[ \t]*$/.test(l)) { body.push(''); i++; continue; }
          const ind = /^ */.exec(l)[0].length;
          if (ind >= cw) { body.push(l.slice(cw)); i++; continue; }
          const prevBlank = /^[ \t]*$/.test(body[body.length - 1]);
          if (prevBlank || interrupts(l) || reItem.test(l)) break;
          body.push(l.trim()); i++;
        }
        let trailing = 0;
        while (body.length && /^[ \t]*$/.test(body[body.length - 1])) { body.pop(); trailing++; }
        if (body.length === 1 && body[0].trim() === '') body.length = 0;
        items.push(body);
        if (trailing) {
          // blank line(s) followed by another item => loose
          { const nm = i < lines.length && reItem.exec(lines[i]); if (nm && (ordered ? /\d/.test(nm[2][0]) && nm[2].slice(-1) === delim : nm[2] === delim)) loose = true; }
        }
        if (i < lines.length && /^[ \t]*$/.test(lines[i - 1] ?? '')) { /* handled */ }
        // internal blank lines between direct children
        if (body.some((l, k) => l === '' && body[k + 1] !== undefined && body[k + 1] !== '' && !inFence(body, k))) loose = true;
      }
      const tag = ordered ? 'ol' : 'ul';
      out += `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>\n`;
      for (const b of items) {
        let h = blocks(b, !loose);
        if (loose) out += `<li>\n${h}</li>\n`;
        else out += `<li>${/^<(ul|ol|pre|blockquote|h\d|hr)/.test(h) ? '\n' : ''}${/<\/(ul|ol|pre|blockquote)>\n$/.test(h) ? h : h.replace(/\n$/, '')}</li>\n`;
      }
      out += `</${tag}>\n`;
      continue;
    }
    if (/^( {4}|\t)/.test(line)) {
      const body = [];
      while (i < lines.length && (/^( {4}|\t)/.test(lines[i]) || (/^[ \t]*$/.test(lines[i]) && lines.slice(i).find((l) => !/^[ \t]*$/.test(l)) !== undefined && /^( {4}|\t)/.test(lines.slice(i).find((l) => !/^[ \t]*$/.test(l)))))) {
        body.push(lines[i].replace(/^( {4}|\t)/, '')); i++;
      }
      out += `<pre><code>${esc(body.join('\n'))}\n</code></pre>\n`; continue;
    }
    // paragraph
    const para = [line.replace(/^[ \t]+/, '')];
    i++;
    let setext = 0;
    while (i < lines.length && !/^[ \t]*$/.test(lines[i])) {
      if (/^ {0,3}=+[ \t]*$/.test(lines[i])) { setext = 1; i++; break; }
      if (/^ {0,3}-+[ \t]*$/.test(lines[i])) { setext = 2; i++; break; }
      if (interrupts(lines[i])) break;
      para.push(lines[i].replace(/^[ \t]+/, '')); i++;
    }
    const text = inline(para.join('\n').replace(/[ \t]+$/, ''));
    if (setext) out += `<h${setext}>${text}</h${setext}>\n`;
    else out += tight ? text + '\n' : `<p>${text}</p>\n`;
  }
  return out;
}
function inFence(body, k) {
  let open = false;
  for (let j = 0; j <= k; j++) if (/^ {0,3}(```|~~~)/.test(body[j])) open = !open;
  return open;
}

export function render(markdown) {
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
  return blocks(lines);
}
