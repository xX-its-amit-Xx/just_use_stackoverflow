const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const PUNCT = /[!-\/:-@\[-`{-~\p{P}\p{S}]/u;
const isWs = c => c === undefined || /\s/.test(c);
const isP = c => c !== undefined && PUNCT.test(c);

function encodeUrl(u) {
  return esc(encodeURI(u.replace(/%(?![0-9a-fA-F]{2})/g, '%25')).replace(/%25([0-9a-fA-F]{2})/g, '%$1'));
}
function unescapeMd(s) { return s.replace(/\\([!-\/:-@\[-`{-~])/g, '$1'); }

function parseDest(s, i) {
  // returns [url, title, endIndex] or null; s[i] is after '('
  while (/\s/.test(s[i] || '')) i++;
  let url = '';
  if (s[i] === '<') {
    const j = s.indexOf('>', i);
    if (j < 0 || s.slice(i, j).includes('\n')) return null;
    url = s.slice(i + 1, j); i = j + 1;
  } else {
    let depth = 0, st = i;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\' && i + 1 < s.length) { i += 2; continue; }
      if (/\s/.test(c)) break;
      if (c === '(') depth++;
      else if (c === ')') { if (depth === 0) break; depth--; }
      i++;
    }
    if (depth !== 0) return null;
    url = s.slice(st, i);
  }
  const before = i;
  while (/\s/.test(s[i] || '')) i++;
  let title = null;
  if (i > before && (s[i] === '"' || s[i] === "'" || s[i] === '(')) {
    const close = s[i] === '(' ? ')' : s[i];
    let j = i + 1;
    while (j < s.length && s[j] !== close) { if (s[j] === '\\') j++; j++; }
    if (j >= s.length) return null;
    title = s.slice(i + 1, j); i = j + 1;
    while (/\s/.test(s[i] || '')) i++;
  }
  if (s[i] !== ')') return null;
  return [unescapeMd(url), title === null ? null : unescapeMd(title), i + 1];
}

function inline(src) {
  const nodes = []; // {t:'html'|'text'|'delim', ...}
  const brackets = [];
  let i = 0, buf = '';
  const flush = () => { if (buf) { nodes.push({ t: 'text', v: buf }); buf = ''; } };
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length) {
      if (src[i + 1] === '\n') { flush(); nodes.push({ t: 'html', v: '<br />\n' }); i += 2; continue; }
      if (/[!-\/:-@\[-`{-~]/.test(src[i + 1])) { buf += src[i + 1]; i += 2; continue; }
      buf += c; i++; continue;
    }
    if (c === '`') {
      let n = 0; while (src[i + n] === '`') n++;
      let j = i + n, found = -1;
      while (j < src.length) {
        if (src[j] === '`') {
          let m = 0; while (src[j + m] === '`') m++;
          if (m === n) { found = j; break; }
          j += m;
        } else j++;
      }
      if (found < 0) { buf += '`'.repeat(n); i += n; continue; }
      let code = src.slice(i + n, found).replace(/\n/g, ' ');
      if (code.length > 2 && code[0] === ' ' && code.at(-1) === ' ' && /[^ ]/.test(code)) code = code.slice(1, -1);
      flush(); nodes.push({ t: 'html', v: '<code>' + esc(code) + '</code>' });
      i = found + n; continue;
    }
    if (c === '*' || c === '_') {
      let n = 0; while (src[i + n] === c) n++;
      const b = src[i - 1], a = src[i + n];
      const lf = !isWs(a) && (!isP(a) || isWs(b) || isP(b));
      const rf = !isWs(b) && (!isP(b) || isWs(a) || isP(a));
      let open, close;
      if (c === '*') { open = lf; close = rf; }
      else { open = lf && (!rf || isP(b)); close = rf && (!lf || isP(a)); }
      flush();
      nodes.push({ t: 'delim', c, n, orig: n, open, close, text: c.repeat(n) });
      i += n; continue;
    }
    if (c === '[' || (c === '!' && src[i + 1] === '[')) {
      const img = c === '!';
      flush();
      nodes.push({ t: 'text', v: img ? '![' : '[' });
      brackets.push({ idx: nodes.length - 1, img, pos: i + (img ? 2 : 1), active: true });
      i += img ? 2 : 1; continue;
    }
    if (c === ']') {
      const br = brackets.pop();
      if (!br) { buf += c; i++; continue; }
      if (!br.active) { buf += c; i++; continue; }
      let r = null;
      if (src[i + 1] === '(') r = parseDest(src, i + 2);
      if (!r) { buf += c; i++; continue; }
      flush();
      const inner = nodes.splice(br.idx + 1);
      nodes.pop();
      processEmph(inner);
      let html;
      if (br.img) {
        const alt = inner.map(altText).join('');
        html = `<img src="${encodeUrl(r[0])}" alt="${esc(alt)}"` + (r[1] !== null ? ` title="${esc(r[1])}"` : '') + ' />';
      } else {
        html = `<a href="${encodeUrl(r[0])}"` + (r[1] !== null ? ` title="${esc(r[1])}"` : '') + '>' + inner.map(render1).join('') + '</a>';
        brackets.forEach(b => { if (!b.img) b.active = false; });
      }
      nodes.push({ t: 'html', v: html, alt: br.img ? null : undefined, altv: html });
      if (br.img) nodes.at(-1).altv = inner.map(altText).join('');
      else nodes.at(-1).altv = inner.map(altText).join('');
      i = r[2]; continue;
    }
    if (c === '\n') {
      // trailing spaces => hard break
      const m = buf.match(/ +$/);
      let hard = m && m[0].length >= 2;
      if (m) buf = buf.slice(0, -m[0].length);
      flush();
      nodes.push({ t: 'html', v: hard ? '<br />\n' : '\n' });
      i++; while (src[i] === ' ') i++;
      continue;
    }
    buf += c; i++;
  }
  flush();
  processEmph(nodes);
  return nodes.map(render1).join('');
}
function altText(n) { return n.t === 'text' ? n.v : n.t === 'delim' ? n.text : n.altv !== undefined ? n.altv : n.t === 'html' && n.v === '\n' ? '\n' : (n.plain ?? ''); }
function render1(n) { return n.t === 'text' ? esc(n.v) : n.t === 'delim' ? esc(n.text) : n.v; }

function processEmph(nodes) {
  // nodes mutated in place; delim nodes get replaced by html open/close tags
  const ds = [];
  for (let k = 0; k < nodes.length; k++) {
    const nd = nodes[k];
    if (nd.t !== 'delim' || !nd.close) continue;
    // find openers
    for (;;) {
      if (nd.n === 0) break;
      let o = -1;
      for (let j = k - 1; j >= 0; j--) {
        const p = nodes[j];
        if (p.t !== 'delim' || !p.open || p.c !== nd.c || p.n === 0) continue;
        if ((p.close || nd.open) && (p.orig + nd.orig) % 3 === 0 && !(p.orig % 3 === 0 && nd.orig % 3 === 0)) continue;
        o = j; break;
      }
      if (o < 0) break;
      const p = nodes[o];
      const use = p.n >= 2 && nd.n >= 2 ? 2 : 1;
      const tag = use === 2 ? 'strong' : 'em';
      p.n -= use; nd.n -= use;
      p.text = p.c.repeat(p.n); nd.text = nd.c.repeat(nd.n);
      // wrap nodes between o and k
      const mid = nodes.slice(o + 1, k);
      const inner = mid.map(render1).join('');
      const plain = mid.map(altText).join('');
      const wrapped = { t: 'html', v: `<${tag}>${inner}</${tag}>`, altv: plain };
      nodes.splice(o + 1, k - o - 1, wrapped);
      k = o + 2;
      if (p.n === 0) { p.t = 'html'; p.v = ''; p.altv = ''; }
      if (nd.n === 0) { nd.t = 'html'; nd.v = ''; nd.altv = ''; break; }
    }
  }
  for (const n of nodes) if (n.t === 'delim') { n.t = 'text'; n.v = n.text; }
}

export function render(markdown) {
  const lines = String(markdown).replace(/\r\n?/g, '\n').replace(/\0/g, '�').split('\n').map(l => l.replace(/\t/g, '    '));
  return blocks(lines).join('\n') + '\n';
}

const reHr = /^ {0,3}([-*_])( *\1){2,} *$/;
const reAtx = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const reFence = /^( {0,3})(`{3,}|~{3,})[ \t]*([^`]*?)[ \t]*$/;
const reBullet = /^( {0,3})([-*+])( +|$)/;
const reOrdered = /^( {0,3})(\d{1,9})([.)])( +|$)/;
const reQuote = /^ {0,3}> ?/;

function blocks(lines) {
  const out = [];
  let i = 0, para = [];
  const flushPara = () => {
    if (para.length) { out.push('<p>' + inline(para.map(l => l.replace(/^ +/, '')).join('\n').replace(/ +$/, '')) + '</p>'); para = []; }
  };
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { flushPara(); i++; continue; }
    let m;
    if (para.length === 0 && /^ {4}/.test(line)) {
      const code = [];
      while (i < lines.length && (/^ {4}/.test(lines[i]) || /^\s*$/.test(lines[i]))) { code.push(lines[i].slice(4)); i++; }
      while (code.length && /^\s*$/.test(code.at(-1))) code.pop();
      out.push('<pre><code>' + esc(code.join('\n') + '\n') + '</code></pre>');
      continue;
    }
    if ((m = line.match(reFence))) {
      flushPara();
      const ind = m[1].length, fence = m[2], info = m[3];
      const code = []; i++;
      while (i < lines.length) {
        const cm = lines[i].match(/^ {0,3}(`{3,}|~{3,})\s*$/);
        if (cm && cm[1][0] === fence[0] && cm[1].length >= fence.length) { i++; break; }
        code.push(lines[i].replace(new RegExp('^ {0,' + ind + '}'), '')); i++;
      }
      const lang = unescapeMd(info.split(/\s+/)[0] || '');
      out.push('<pre><code' + (lang ? ` class="language-${esc(lang)}"` : '') + '>' + (code.length ? esc(code.join('\n')) + '\n' : '') + '</code></pre>');
      continue;
    }
    if ((m = line.match(reAtx))) {
      flushPara();
      out.push(`<h${m[1].length}>${inline((m[2] || '').trim())}</h${m[1].length}>`); i++; continue;
    }
    if (para.length && (m = line.match(/^ {0,3}(=+|-+) *$/))) {
      const lvl = m[1][0] === '=' ? 1 : 2;
      const t = inline(para.map(l => l.replace(/^ +/, '')).join('\n').replace(/ +$/, '')); para = [];
      out.push(`<h${lvl}>${t}</h${lvl}>`); i++; continue;
    }
    if (reHr.test(line)) { flushPara(); out.push('<hr />'); i++; continue; }
    if (reQuote.test(line)) {
      flushPara();
      const inner = [];
      while (i < lines.length) {
        if (reQuote.test(lines[i])) inner.push(lines[i].replace(reQuote, ''));
        else if (!/^\s*$/.test(lines[i]) && inner.length && !/^\s*$/.test(inner.at(-1)) && !startsBlock(lines[i])) inner.push(lines[i]);
        else break;
        i++;
      }
      out.push('<blockquote>\n' + blocks(inner).join('\n') + (inner.length ? '\n' : '') + '</blockquote>');
      continue;
    }
    const bm = line.match(reBullet), om = line.match(reOrdered);
    if ((bm || om) && !(para.length && (om ? om[2] !== '1' : false)) && !(para.length && /^\s*$/.test(line.replace(reBullet, '').replace(reOrdered, '')))) {
      flushPara();
      const ordered = !!om && !bm;
      const marker = ordered ? om[3] : bm[2];
      const start = ordered ? parseInt(om[2], 10) : 1;
      const items = []; let loose = false, sawBlank = false;
      while (i < lines.length) {
        const l = lines[i];
        const a = l.match(reBullet), b = l.match(reOrdered);
        let mm = ordered ? b : a;
        if (!mm || (ordered ? b[3] : a[2]) !== marker || (!ordered && reHr.test(l))) break;
        if (sawBlank) loose = true;
        sawBlank = false;
        const width = mm[0].length - (mm[3] === undefined ? 0 : 0);
        const cw = (ordered ? mm[1].length + mm[2].length + 1 : mm[1].length + 1);
        let sp = mm[mm.length - 1].length;
        const contentOff = sp > 4 || sp === 0 ? cw + 1 : cw + sp;
        const item = [l.slice(contentOff > l.length ? l.length : contentOff)];
        i++;
        while (i < lines.length) {
          const x = lines[i];
          if (/^\s*$/.test(x)) {
            let j = i; while (j < lines.length && /^\s*$/.test(lines[j])) j++;
            if (j < lines.length && lines[j].search(/\S/) >= contentOff) { for (; i < j; i++) item.push(''); sawBlankInside(); continue; }
            if (j < lines.length && (ordered ? lines[j].match(reOrdered) : lines[j].match(reBullet)) && !reHr.test(lines[j])) sawBlank = true;
            i = j; break;
          }
          if (x.search(/\S/) >= contentOff) { item.push(x.slice(contentOff)); i++; continue; }
          if (!/^\s*$/.test(item.at(-1)) && !startsBlock(x) && !x.match(reBullet) && !x.match(reOrdered)) { item.push(x.trim()); i++; continue; }
          break;
        }
        function sawBlankInside() { if (item.some(s => s.trim()) ) innerBlank = true; }
        items.push(item);
        if (typeof innerBlank !== 'undefined' && innerBlank) { loose = true; }
        if (sawBlank && !(i < lines.length)) sawBlank = false;
      }
      var innerBlank;
      let html = ordered ? (start !== 1 ? `<ol start="${start}">` : '<ol>') : '<ul>';
      html += '\n';
      for (const it of items) {
        while (it.length && /^\s*$/.test(it.at(-1))) it.pop();
        const bl = blocks(it);
        let inner;
        if (!loose) inner = bl.map(x => x.replace(/^<p>([\s\S]*)<\/p>$/, '$1')).join('\n');
        else inner = '\n' + bl.join('\n') + (bl.length ? '\n' : '');
        const nl = !loose && bl.length && /^<(ul|ol|blockquote|pre|h\d|hr)/.test(bl[0]) ? '\n' : '';
        html += '<li>' + nl + inner + (!loose && bl.length && /<\/(ul|ol|blockquote|pre)>$/.test(bl.at(-1)) ? '\n' : '') + '</li>\n';
      }
      out.push(html + (ordered ? '</ol>' : '</ul>'));
      innerBlank = false;
      continue;
    }
    para.push(line); i++;
  }
  flushPara();
  return out;
}
function startsBlock(l) {
  return reHr.test(l) || reAtx.test(l) || reFence.test(l) || reQuote.test(l) || reBullet.test(l) || /^ {0,3}1[.)]( |$)/.test(l);
}
