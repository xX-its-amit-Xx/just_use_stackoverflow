// markdown-s2: safe Markdown -> HTML renderer (written from scratch; no third-party code).

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const esc = s => s.replace(/[&<>"]/g, c => ESC[c]);
const PUNCT = /^[\p{P}\p{S}]$/u;
const WS = /^[\s ]$/u;
const ASCII_PUNCT = /^[!-\/:-@\[-`{-~]$/;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', trade: '™', euro: '€', times: '×', auml: 'ä', ouml: 'ö', uuml: 'ü', hearts: '♥', ngsp: ' ', Dcaron: 'Ď', HilbertSpace: 'ℋ', DifferentialD: 'ⅆ', ClockwiseContourIntegral: '∲', ngE: '≧̸' };
function decodeEntity(m) {
  let g = m.slice(1, -1);
  if (g[0] === '#') {
    const n = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
    if (!n || n > 0x10ffff || (n >= 0xd800 && n < 0xe000)) return '�';
    return String.fromCodePoint(n);
  }
  return Object.prototype.hasOwnProperty.call(ENTITIES, g) ? ENTITIES[g] : m;
}
const ENT_RE = /&(?:#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g;
const unescapeStr = s => s.replace(/\\([!-\/:-@\[-`{-~])|&(?:#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g, (m, p) => p || decodeEntity(m));

function normUrl(u) {
  let out = '';
  for (let i = 0; i < u.length; i++) {
    const c = u[i];
    if (c === '%' && /^[0-9a-fA-F]{2}/.test(u.slice(i + 1, i + 3))) out += c;
    else if (/[A-Za-z0-9;\/?:@&=+$,\-_.!~*'()#]/.test(c)) out += c;
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
  const probe = u.replace(/[\x00-\x20 ​]/g, '').toLowerCase();
  if (/^(javascript|vbscript|file):/.test(probe)) return '#';
  if (/^data:/.test(probe) && !/^data:image\/(png|gif|jpeg|webp);/.test(probe)) return '#';
  return u;
}
const hrefOf = u => esc(normUrl(safeUrl(u)));

export function slugify(text, seen) {
  const base = String(text).toLowerCase().replace(/[^\p{L}\p{N} \-_]/gu, '').replace(/ /g, '-');
  if (!seen) return base;
  if (!seen.has(base)) { seen.set(base, 0); return base; }
  let n = seen.get(base);
  let cand;
  do { n++; cand = base + '-' + n; } while (seen.has(cand));
  seen.set(base, n);
  seen.set(cand, 0);
  return cand;
}

const normLabel = s => s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase();

// ---------------------------------------------------------------- inline
function parseDestTitle(s, pos, allowNl = true) {
  // returns {dest,title,end} or null; pos at start (after '(' or after ':')
  let i = pos;
  const skipWs = () => { let nl = 0; while (i < s.length && /[ \t\n]/.test(s[i])) { if (s[i] === '\n') { if (++nl > 1) break; } i++; } };
  skipWs();
  let dest = '';
  if (s[i] === '<') {
    i++;
    const st = i;
    while (i < s.length && s[i] !== '>' && s[i] !== '\n' && s[i] !== '<') { if (s[i] === '\\') i++; i++; }
    if (s[i] !== '>') return null;
    dest = s.slice(st, i); i++;
  } else {
    const st = i; let depth = 0;
    while (i < s.length) {
      const c = s[i];
      if (c === '\\' && i + 1 < s.length && ASCII_PUNCT.test(s[i + 1])) { i += 2; continue; }
      if (c === '(') depth++;
      else if (c === ')') { if (depth === 0) break; depth--; }
      else if (/[\s\x00-\x1f]/.test(c)) break;
      i++;
    }
    if (depth !== 0) return null;
    dest = s.slice(st, i);
    if (dest === '' && s[st - 0] !== undefined && false) return null;
  }
  const afterDest = i;
  skipWs();
  let title = null;
  if (i > afterDest && (s[i] === '"' || s[i] === "'" || s[i] === '(')) {
    const close = s[i] === '(' ? ')' : s[i];
    const st = ++i;
    while (i < s.length && s[i] !== close) { if (s[i] === '\\') i++; i++; }
    if (i >= s.length) return { dest, title: null, end: afterDest, noTitle: true };
    title = s.slice(st, i); i++;
    if (/\n\s*\n/.test(title)) return null;
  }
  return { dest, title, end: i, afterDest };
}

function parseInline(src, refs) {
  const s = src;
  let nodes = [];
  let text = '';
  const flush = () => { if (text) { nodes.push({ t: 'text', v: text }); text = ''; } };
  const brackets = [];
  let pos = 0;
  while (pos < s.length) {
    const c = s[pos];
    if (c === '\\') {
      const n = s[pos + 1];
      if (n === '\n') { flush(); nodes.push({ t: 'br' }); pos += 2; while (s[pos] === ' ') pos++; }
      else if (n !== undefined && ASCII_PUNCT.test(n)) { text += n; pos += 2; }
      else { text += '\\'; pos++; }
    } else if (c === '`') {
      let e = pos; while (s[e] === '`') e++;
      const run = e - pos;
      let j = e, found = -1;
      while (j < s.length) {
        if (s[j] === '`') { let k = j; while (s[k] === '`') k++; if (k - j === run) { found = j; break; } j = k; } else j++;
      }
      if (found < 0) { text += s.slice(pos, e); pos = e; }
      else {
        flush();
        let code = s.slice(e, found).replace(/\n/g, ' ');
        if (code.length > 2 && code[0] === ' ' && code[code.length - 1] === ' ' && /[^ ]/.test(code)) code = code.slice(1, -1);
        nodes.push({ t: 'code', v: code }); pos = found + run;
      }
    } else if (c === '*' || c === '_' || c === '~') {
      let e = pos; while (s[e] === c) e++;
      const run = e - pos;
      if (c === '~' && run > 2) { text += s.slice(pos, e); pos = e; continue; }
      const before = pos === 0 ? '\n' : String.fromCodePoint(s.codePointAt(pos - 1 - (pos >= 2 && /[\udc00-\udfff]/.test(s[pos - 1]) ? 1 : 0)));
      const after = e >= s.length ? '\n' : String.fromCodePoint(s.codePointAt(e));
      const aWs = WS.test(after), bWs = WS.test(before);
      const aP = PUNCT.test(after), bP = PUNCT.test(before);
      const left = !aWs && (!aP || bWs || bP);
      const right = !bWs && (!bP || aWs || aP);
      let canOpen, canClose;
      if (c === '_') { canOpen = left && (!right || bP); canClose = right && (!left || aP); }
      else { canOpen = left; canClose = right; }
      flush();
      nodes.push({ t: 'delim', ch: c, orig: run, count: run, canOpen, canClose });
      pos = e;
    } else if (c === '[' || (c === '!' && s[pos + 1] === '[')) {
      flush();
      const img = c === '!';
      const node = { t: 'text', v: img ? '![' : '[' };
      nodes.push(node);
      brackets.push({ node, img, pos: pos + (img ? 2 : 1), active: true });
      pos += img ? 2 : 1;
    } else if (c === ']') {
      const op = brackets.pop();
      if (!op) { text += ']'; pos++; continue; }
      flush();
      if (!op.active) { text += ']'; pos++; continue; }
      let dest = null, title = null, end = pos + 1;
      if (s[pos + 1] === '(') {
        const r = parseDestTitle(s, pos + 2);
        if (r) {
          let k = r.end; while (k < s.length && /[ \t\n]/.test(s[k])) k++;
          if (s[k] === ')') { dest = r.dest; title = r.title; end = k + 1; }
        }
      }
      if (dest === null) {
        let label = null, e2 = pos + 1;
        if (s[pos + 1] === '[') {
          const m = /^\[((?:[^\[\]\\]|\\.){0,999})\]/s.exec(s.slice(pos + 1));
          if (m) { if (m[1].trim()) { label = m[1]; e2 = pos + 1 + m[0].length; } else { label = s.slice(op.pos, pos); e2 = pos + 1 + m[0].length; } }
          else label = s.slice(op.pos, pos);
        } else label = s.slice(op.pos, pos);
        const ref = label && label.trim() ? refs.get(normLabel(label)) : null;
        if (ref) { dest = ref.dest; title = ref.title; end = e2; }
      }
      if (dest === null) { text += ']'; pos++; continue; }
      const idx = nodes.indexOf(op.node);
      let kids = nodes.slice(idx + 1);
      kids = processEmphasis(kids);
      nodes.length = idx;
      nodes.push({ t: op.img ? 'img' : 'link', dest: unescapeStr(dest), title: title == null ? null : unescapeStr(title), kids });
      if (!op.img) for (const b of brackets) if (!b.img) b.active = false;
      pos = end;
    } else if (c === '<') {
      const rest = s.slice(pos);
      let m = /^<([a-zA-Z][a-zA-Z0-9+.\-]{1,31}:[^\s<>]*)>/.exec(rest);
      if (m) { flush(); nodes.push({ t: 'link', dest: m[1], title: null, kids: [{ t: 'text', v: m[1] }], raw: true }); pos += m[0].length; continue; }
      m = /^<([a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/.exec(rest);
      if (m) { flush(); nodes.push({ t: 'link', dest: 'mailto:' + m[1], title: null, kids: [{ t: 'text', v: m[1] }], raw: true }); pos += m[0].length; continue; }
      text += '<'; pos++;
    } else if (c === '&') {
      ENT_RE.lastIndex = 0;
      const m = /^&(?:#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/.exec(s.slice(pos, pos + 40));
      if (m) { text += decodeEntity(m[0]); pos += m[0].length; } else { text += '&'; pos++; }
    } else if (c === '\n') {
      const hard = / {2,}$/.test(text);
      text = text.replace(/ +$/, '');
      flush();
      nodes.push({ t: hard ? 'br' : 'sb' });
      pos++; while (s[pos] === ' ') pos++;
    } else { text += c; pos++; }
  }
  flush();
  return processEmphasis(nodes);
}

function processEmphasis(nodes) {
  let ci = 0;
  while (ci < nodes.length) {
    const cl = nodes[ci];
    if (cl.t !== 'delim' || !cl.canClose) { ci++; continue; }
    let oi = ci - 1, found = -1;
    for (; oi >= 0; oi--) {
      const o = nodes[oi];
      if (o.t !== 'delim' || o.ch !== cl.ch || !o.canOpen || o.count === 0) continue;
      if (cl.ch === '~') { if (o.count !== cl.count) continue; }
      else if ((o.canClose || cl.canOpen) && (o.orig + cl.orig) % 3 === 0 && !(o.orig % 3 === 0 && cl.orig % 3 === 0)) continue;
      found = oi; break;
    }
    if (found < 0) { ci++; continue; }
    const op = nodes[found];
    const use = cl.ch === '~' ? cl.count : (op.count >= 2 && cl.count >= 2 ? 2 : 1);
    const inner = nodes.slice(found + 1, ci);
    const node = { t: cl.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em', kids: inner.map(n => n.t === 'delim' ? { t: 'text', v: n.ch.repeat(n.count) } : n) };
    op.count -= use; cl.count -= use;
    const repl = [];
    if (op.count > 0) repl.push(op);
    repl.push(node);
    const opKeep = op.count > 0 ? 1 : 0;
    let newCi = found + opKeep + 1;
    if (cl.count > 0) repl.push(cl);
    nodes.splice(found, ci - found + 1, ...repl);
    ci = cl.count > 0 ? newCi : newCi;
    if (cl.count === 0) continue;
  }
  return nodes.map(n => n.t === 'delim' ? { t: 'text', v: n.ch.repeat(n.count) } : n);
}

function renderInline(nodes) {
  let o = '';
  for (const n of nodes) {
    switch (n.t) {
      case 'text': o += esc(n.v); break;
      case 'code': o += '<code>' + esc(n.v) + '</code>'; break;
      case 'sb': o += '\n'; break;
      case 'br': o += '<br />\n'; break;
      case 'em': o += '<em>' + renderInline(n.kids) + '</em>'; break;
      case 'strong': o += '<strong>' + renderInline(n.kids) + '</strong>'; break;
      case 'del': o += '<del>' + renderInline(n.kids) + '</del>'; break;
      case 'link': o += '<a href="' + hrefOf(n.dest) + '"' + (n.title != null ? ' title="' + esc(n.title) + '"' : '') + '>' + renderInline(n.kids) + '</a>'; break;
      case 'img': o += '<img src="' + hrefOf(n.dest) + '" alt="' + esc(plain(n.kids)) + '"' + (n.title != null ? ' title="' + esc(n.title) + '"' : '') + ' />'; break;
    }
  }
  return o;
}
function plain(nodes) {
  let o = '';
  for (const n of nodes) {
    if (n.t === 'text' || n.t === 'code') o += n.v;
    else if (n.t === 'sb' || n.t === 'br') o += '\n';
    else if (n.kids) o += plain(n.kids);
  }
  return o;
}

// ---------------------------------------------------------------- blocks
const isBlank = l => /^\s*$/.test(l);
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const LIST = /^( {0,3})([-+*]|\d{1,9}[.)])([ \t]+|$)/;

function expandTabs(l) {
  if (!l.includes('\t')) return l;
  let m = /^[ \t]*/.exec(l)[0], col = 0, out = '';
  for (const ch of m) { if (ch === '\t') { const n = 4 - (col % 4); out += ' '.repeat(n); col += n; } else { out += ' '; col++; } }
  return out + l.slice(m.length);
}

function listInfo(l) {
  const m = LIST.exec(l);
  if (!m) return null;
  const marker = m[2];
  const rest = l.slice(m[0].length);
  const sp = m[3].length;
  const empty = rest.trim() === '';
  let w;
  if (empty) w = m[1].length + marker.length + 1;
  else if (sp > 4) w = m[1].length + marker.length + 1;
  else w = m[1].length + marker.length + sp;
  const ordered = marker.length > 1 || /\d/.test(marker);
  return {
    ordered, type: ordered ? marker.slice(-1) : marker, num: ordered ? parseInt(marker, 10) : 0, w, empty,
    first: empty ? '' : (sp > 4 ? ' '.repeat(sp - 1) + rest : rest),
  };
}
function isStart(l, inPara) {
  if (ATX.test(l) || HR.test(l)) return true;
  const f = FENCE.exec(l);
  if (f && !(f[2][0] === '`' && f[3].includes('`'))) return true;
  if (/^ {0,3}>/.test(l)) return true;
  const li = listInfo(l);
  if (li) { if (inPara && (li.empty || (li.ordered && li.num !== 1))) return false; return true; }
  return false;
}

function splitRow(l) {
  let t = l.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const cells = []; let cur = '';
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && t[i + 1] === '|') { cur += '|'; i++; }
    else if (t[i] === '\\' && i + 1 < t.length) { cur += t[i] + t[i + 1]; i++; }
    else if (t[i] === '|') { cells.push(cur.trim()); cur = ''; }
    else cur += t[i];
  }
  cells.push(cur.trim());
  return cells;
}
function delimRow(l) {
  if (!l || !l.includes('-') || !/^[\s|:\-]+$/.test(l)) return null;
  const cells = splitRow(l);
  if (!cells.every(c => /^:?-+:?$/.test(c))) return null;
  return cells.map(c => (c[0] === ':' ? (c.endsWith(':') ? 'center' : 'left') : c.endsWith(':') ? 'right' : null));
}

function extractDefs(text, refs) {
  for (;;) {
    const m = /^ {0,3}\[((?:[^\[\]\\]|\\.)+)\]:/s.exec(text);
    if (!m || !m[1].trim()) break;
    const r = parseDestTitle(text, m[0].length);
    if (!r) break;
    if (r.dest === '' && !/^\s*</.test(text.slice(m[0].length))) break;
    let end = r.end, title = r.title;
    const lineEnd = i => { let k = i; while (text[k] === ' ' || text[k] === '\t') k++; return text[k] === '\n' || k >= text.length ? k : -1; };
    let e = lineEnd(end);
    if (e < 0 || title == null) {
      if (title != null) { // title garbage: fall back to no title
        const e2 = lineEnd(r.afterDest); if (e2 < 0) break; title = null; e = e2;
      } else if (e < 0) break;
    }
    const key = normLabel(m[1]);
    if (!refs.has(key)) refs.set(key, { dest: r.dest, title });
    text = text.slice(e + 1);
    if (!text.trim()) return '';
  }
  return text;
}

function parseBlocks(lines, refs) {
  const out = [];
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const l = lines[i];
    if (isBlank(l)) { if (out.length) out[out.length - 1].blankAfter = true; i++; continue; }
    // indented code
    if (/^ {4}/.test(l)) {
      const buf = [];
      while (i < n && (isBlank(lines[i]) || /^ {4}/.test(lines[i]))) { buf.push(lines[i].slice(4)); i++; }
      while (buf.length && isBlank(buf[buf.length - 1])) { buf.pop(); }
      // blank lines consumed after belong to gap
      out.push({ t: 'code', v: buf.join('\n') + '\n', lang: null });
      if (i < n || true) { if (i > 0 && isBlank(lines[i - 1])) out[out.length - 1].blankAfter = true; }
      continue;
    }
    let m = FENCE.exec(l);
    if (m && !(m[2][0] === '`' && m[3].includes('`'))) {
      const ind = m[1].length, ch = m[2][0], len = m[2].length;
      const info = unescapeStr(m[3].trim());
      const buf = []; i++;
      const close = new RegExp('^ {0,3}' + (ch === '`' ? '`' : '~') + '{' + len + ',}[ \\t]*$');
      while (i < n && !close.test(lines[i])) { buf.push(lines[i].replace(new RegExp('^ {0,' + ind + '}'), '')); i++; }
      i++;
      out.push({ t: 'code', v: buf.length ? buf.join('\n') + '\n' : '', lang: info.split(/\s+/)[0] || null });
      continue;
    }
    m = ATX.exec(l);
    if (m) {
      let c = (m[2] || '').replace(/[ \t]+#+[ \t]*$/, '').replace(/^#+[ \t]*$/, '').trim();
      out.push({ t: 'h', level: m[1].length, text: c }); i++; continue;
    }
    if (HR.test(l)) { out.push({ t: 'hr' }); i++; continue; }
    if (/^ {0,3}>/.test(l)) {
      const buf = [];
      let lastPara = false;
      while (i < n) {
        const x = lines[i];
        if (/^ {0,3}>/.test(x)) {
          const y = x.replace(/^ {0,3}> ?/, '');
          buf.push(y);
          lastPara = !isBlank(y) && !/^ {4}/.test(y) && !FENCE.test(y) && !ATX.test(y) && !HR.test(y);
          i++;
        } else if (!isBlank(x) && lastPara && !isStart(x, true) ) { buf.push(x); i++; }
        else break;
      }
      out.push({ t: 'bq', kids: parseBlocks(buf, refs) });
      continue;
    }
    const li = listInfo(l);
    if (li) {
      const items = [];
      let loose = false;
      let cur = li;
      while (cur) {
        const buf = [cur.first];
        i++;
        let blanks = 0, prevBlank = cur.empty;
        let started = !cur.empty;
        while (i < n) {
          const x = lines[i];
          if (isBlank(x)) {
            if (!started && buf.length === 1 && buf[0] === '' && blanks >= 0 && i > 0 && isBlank(lines[i - 1]) ) break;
            if (!started && cur.empty && buf.length === 1) { buf.push(''); blanks++; prevBlank = true; i++; /* empty item then blank: ends */ buf.pop(); break; }
            buf.push(''); blanks++; prevBlank = true; i++; continue;
          }
          const ind = /^ */.exec(x)[0].length;
          if (ind >= cur.w) { buf.push(x.slice(cur.w)); blanks = 0; prevBlank = false; started = true; i++; continue; }
          if (!prevBlank && !isStart(x, true) && !listInfo(x) && started) { buf.push(x.replace(/^ +/, '')); i++; continue; }
          break;
        }
        const trailing = blanks;
        while (buf.length > 1 && buf[buf.length - 1] === '') buf.pop();
        const kids = parseBlocks(buf, refs);
        let iloose = false;
        for (let k = 0; k < kids.length - 1; k++) if (kids[k].blankAfter) iloose = true;
        // next item?
        let j = i; while (j < n && isBlank(lines[j])) j++;
        let nxt = null;
        if (j < n && !HR.test(lines[j])) { const c2 = listInfo(lines[j]); if (c2 && c2.ordered === li.ordered && c2.type === li.type) nxt = c2; }
        if (iloose) loose = true;
        if (nxt && trailing > 0) loose = true;
        items.push({ kids });
        if (nxt) { i = j; cur = nxt; } else cur = null;
      }
      out.push({ t: 'list', ordered: li.ordered, start: li.num, loose, items });
      continue;
    }
    // table
    if (l.includes('|') && i + 1 < n) {
      const al = delimRow(lines[i + 1]);
      const head = al ? splitRow(l) : null;
      if (al && head.length === al.length) {
        const rows = []; i += 2;
        while (i < n && !isBlank(lines[i]) && !isStart(lines[i], true)) { rows.push(splitRow(lines[i])); i++; }
        out.push({ t: 'table', al, head, rows });
        continue;
      }
    }
    // paragraph
    const buf = [l]; i++;
    let setext = 0;
    while (i < n) {
      const x = lines[i];
      if (isBlank(x)) break;
      const sm = /^ {0,3}(=+|-+)[ \t]*$/.exec(x);
      if (sm) { setext = sm[1][0] === '=' ? 1 : 2; i++; break; }
      if (isStart(x, true)) break;
      buf.push(x); i++;
    }
    let text = buf.map(x => x.replace(/^[ \t]+/, '')).join('\n').replace(/[ \t]+$/, '');
    text = extractDefs(buf.map(x => x.replace(/^[ \t]+(?=\S)/, (q, o) => o === 0 ? q : '')).join('\n'), refs);
    text = text.split('\n').map(x => x.replace(/^[ \t]+/, '')).join('\n').replace(/[ \t]+$/, '');
    if (!text.trim()) { if (setext) { /* only defs */ } continue; }
    if (setext) out.push({ t: 'h', level: setext, text });
    else out.push({ t: 'p', text });
  }
  return out;
}

function parseDoc(md) {
  const lines = String(md).replace(/\r\n?/g, '\n').replace(/\0/g, '�').split('\n').map(expandTabs);
  const refs = new Map();
  const blocks = parseBlocks(lines, refs);
  return { blocks, refs };
}

function renderBlocks(blocks, ctx, tight = false) {
  let o = '';
  for (const b of blocks) {
    switch (b.t) {
      case 'p': {
        const h = renderInline(parseInline(b.text, ctx.refs));
        o += tight ? h + '\n' : '<p>' + h + '</p>\n';
        break;
      }
      case 'h': {
        const nodes = parseInline(b.text, ctx.refs);
        const id = ctx.ids ? ' id="' + esc(slugify(plain(nodes), ctx.seen)) + '"' : '';
        o += `<h${b.level}${id}>` + renderInline(nodes) + `</h${b.level}>\n`;
        break;
      }
      case 'hr': o += '<hr />\n'; break;
      case 'code': o += '<pre><code' + (b.lang ? ' class="language-' + esc(b.lang) + '"' : '') + '>' + esc(b.v) + '</code></pre>\n'; break;
      case 'bq': o += '<blockquote>\n' + renderBlocks(b.kids, ctx) + '</blockquote>\n'; break;
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        o += '<' + tag + (b.ordered && b.start !== 1 ? ` start="${b.start}"` : '') + '>\n';
        for (const it of b.items) {
          let inner = renderBlocks(it.kids, ctx, !b.loose);
          if (!b.loose && it.kids.length && it.kids[0].t !== 'p') inner = '\n' + inner;
          o += '<li>' + (b.loose ? '\n' + inner : inner.replace(/\n$/, it.kids.length && it.kids[it.kids.length - 1].t === 'p' ? '' : '\n')) + '</li>\n';
        }
        o += '</' + tag + '>\n';
        break;
      }
      case 'table': {
        const cell = (tag, c, k) => `<${tag}${b.al[k] ? ` align="${b.al[k]}"` : ''}>` + renderInline(parseInline(c, ctx.refs)) + `</${tag}>`;
        o += '<table>\n<thead>\n<tr>\n' + b.head.map((c, k) => cell('th', c, k)).join('\n') + '\n</tr>\n</thead>\n';
        if (b.rows.length) {
          o += '<tbody>\n';
          for (const r of b.rows) {
            const cs = [];
            for (let k = 0; k < b.al.length; k++) cs.push(cell('td', r[k] || '', k));
            o += '<tr>\n' + cs.join('\n') + '\n</tr>\n';
          }
          o += '</tbody>\n';
        }
        o += '</table>\n';
        break;
      }
    }
  }
  return o;
}

export function render(markdown, { headingIds = false } = {}) {
  const { blocks, refs } = parseDoc(markdown);
  return renderBlocks(blocks, { refs, ids: headingIds, seen: new Map() });
}

export function toc(markdown) {
  const { blocks, refs } = parseDoc(markdown);
  const seen = new Map(), res = [];
  const walk = bs => {
    for (const b of bs) {
      if (b.t === 'h') { const text = plain(parseInline(b.text, refs)); res.push({ level: b.level, text, slug: slugify(text, seen) }); }
      else if (b.t === 'bq') walk(b.kids);
      else if (b.t === 'list') b.items.forEach(it => walk(it.kids));
    }
  };
  walk(blocks);
  return res;
}
