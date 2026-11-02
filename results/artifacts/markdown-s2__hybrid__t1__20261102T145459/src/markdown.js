// markdown-s2: safe Markdown -> HTML renderer (written from scratch).
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const PUNCT = /[\p{P}\p{S}]/u;
const ASCII_PUNCT = /[!-\/:-@\[-`{-~]/;
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '©', reg: '®', hellip: '…', mdash: '—', ndash: '–', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', times: '×', euro: '€', trade: '™', deg: '°', hearts: '♥', laquo: '«', raquo: '»', middot: '·', bull: '•', larr: '←', rarr: '→', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', ouml_: 'ö', eacute: 'é', egrave: 'è', szlig: 'ß', ngsp: '\u2002', Dcaron: 'Ď', HilbertSpace: 'ℋ', DifferentialD: 'ⅆ', ClockwiseContourIntegral: '∲', ngE: '≧̸' };
function decodeEntity(name) {
  let m;
  if ((m = /^#[xX]([0-9a-fA-F]{1,6})$/.exec(name))) return cp(parseInt(m[1], 16));
  if ((m = /^#(\d{1,7})$/.exec(name))) return cp(parseInt(m[1], 10));
  return Object.hasOwn(ENT, name) ? ENT[name] : null;
}
function cp(n) { return n === 0 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff) ? '\ufffd' : String.fromCodePoint(n); }
function unescapeStr(s) {
  return s.replace(/\\([!-\/:-@\[-`{-~])|&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (m, a, b) => {
    if (a) return a;
    const d = decodeEntity(b); return d === null ? m : d;
  });
}
const normLabel = s => s.trim().replace(/\s+/g, ' ').toLowerCase().toUpperCase();

export function slugify(text, seen) {
  let slug = String(text).toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
  if (!seen) return slug;
  if (!seen.has(slug)) { seen.set(slug, 0); return slug; }
  let n = seen.get(slug) + 1, c;
  while (seen.has((c = `${slug}-${n}`))) n++;
  seen.set(slug, n); seen.set(c, 0);
  return c;
}

// ---------- URL handling ----------
function safeUrl(u) {
  const t = u.replace(/[\x00-\x20\u00a0]/g, '');
  if (/^(javascript|vbscript|file|data):/i.test(t) && !/^data:image\/(png|gif|jpeg|webp);/i.test(t)) return '#';
  return u;
}
function encodeUrl(u) {
  u = safeUrl(u);
  let out = '';
  for (const ch of u) {
    if (/[A-Za-z0-9;\/?:@&=+$,\-_.!~*'()#%]/.test(ch)) out += ch;
    else out += encodeURIComponent(ch).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  }
  out = out.replace(/%(?![0-9a-fA-F]{2})/g, '%25');
  return esc(out);
}

// ---------- link pieces (shared by inline + definitions) ----------
function parseDest(s, pos) {
  if (s[pos] === '<') {
    let i = pos + 1;
    while (i < s.length) {
      if (s[i] === '\\' && i + 1 < s.length) i += 2;
      else if (s[i] === '>') return { url: unescapeStr(s.slice(pos + 1, i)), end: i + 1 };
      else if (s[i] === '\n' || s[i] === '<') return null;
      else i++;
    }
    return null;
  }
  let i = pos, depth = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && ASCII_PUNCT.test(s[i + 1])) i += 2;
    else if (c === '(') { depth++; i++; }
    else if (c === ')') { if (depth === 0) break; depth--; i++; }
    else if (/[\s\x00-\x1f]/.test(c)) break;
    else i++;
  }
  if (depth !== 0) return null;
  return { url: unescapeStr(s.slice(pos, i)), end: i };
}
function parseTitle(s, pos) {
  const o = s[pos];
  const cl = o === '"' ? '"' : o === "'" ? "'" : o === '(' ? ')' : null;
  if (!cl) return null;
  let i = pos + 1;
  while (i < s.length) {
    if (s[i] === '\\' && i + 1 < s.length) i += 2;
    else if (s[i] === cl) return { title: unescapeStr(s.slice(pos + 1, i)), end: i + 1 };
    else if (o === '(' && s[i] === '(') return null;
    else i++;
  }
  return null;
}
const skipWs = (s, i) => { while (i < s.length && /\s/.test(s[i])) i++; return i; };

function parseLinkDefs(text, defs) {
  for (;;) {
    let m = /^ {0,3}\[/.exec(text);
    if (!m) break;
    let i = m[0].length, j = i;
    while (j < text.length && text[j] !== ']') { if (text[j] === '\\') j++; else if (text[j] === '[') return text; j++; }
    if (text[j] !== ']' || text[j + 1] !== ':') break;
    const label = text.slice(i, j);
    if (!label.trim() || label.length > 999) break;
    let p = skipWs(text, j + 2);
    const d = parseDest(text, p);
    if (!d || (d.end === p)) break;
    p = d.end;
    let q = skipWs(text, p), title = null, end = p;
    if (q > p && q < text.length) {
      const t = parseTitle(text, q);
      if (t) {
        let e = t.end; while (e < text.length && (text[e] === ' ' || text[e] === '\t')) e++;
        if (e >= text.length || text[e] === '\n') { title = t.title; end = e; }
      }
    }
    if (title === null) {
      let e = p; while (e < text.length && (text[e] === ' ' || text[e] === '\t')) e++;
      if (e < text.length && text[e] !== '\n') break;
      end = e;
    }
    const key = normLabel(label);
    if (!defs.has(key)) defs.set(key, { url: d.url, title });
    text = text.slice(end).replace(/^\n/, '');
  }
  return text;
}

// ---------- inline ----------
function parseInline(s, defs) {
  let nodes = [];
  const text = v => { if (v) nodes.push({ t: 'text', v }); };
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < n && ASCII_PUNCT.test(s[i + 1])) { text(s[i + 1]); i += 2; }
      else if (s[i + 1] === '\n') { nodes.push({ t: 'hard' }); i += 2; while (s[i] === ' ' || s[i] === '\t') i++; }
      else { text('\\'); i++; }
    } else if (c === '`') {
      let j = i; while (s[j] === '`') j++;
      const len = j - i; let k = j, found = -1;
      while (k < n) {
        if (s[k] === '`') { let e = k; while (s[e] === '`') e++; if (e - k === len) { found = k; break; } k = e; } else k++;
      }
      if (found < 0) { text(s.slice(i, j)); i = j; }
      else {
        let code = s.slice(j, found).replace(/\n/g, ' ');
        if (code.length > 2 && code[0] === ' ' && code[code.length - 1] === ' ' && /[^ ]/.test(code)) code = code.slice(1, -1);
        nodes.push({ t: 'code', v: code }); i = found + len;
      }
    } else if (c === '&') {
      const m = /^&(#[xX][0-9a-fA-F]{1,6}|#\d{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/.exec(s.slice(i, i + 40));
      const d = m && decodeEntity(m[1]);
      if (m && d !== null) { text(d); i += m[0].length; } else { text('&'); i++; }
    } else if (c === '<') {
      const rest = s.slice(i);
      let m;
      if ((m = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)>/.exec(rest))) {
        nodes.push({ t: 'link', href: m[1], title: null, children: [{ t: 'text', v: m[1] }] }); i += m[0].length;
      } else if ((m = /^<([a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*)>/.exec(rest))) {
        nodes.push({ t: 'link', href: 'mailto:' + m[1], title: null, children: [{ t: 'text', v: m[1] }] }); i += m[0].length;
      } else { text('<'); i++; }
    } else if (c === '*' || c === '_' || c === '~') {
      let j = i; while (s[j] === c) j++;
      const count = j - i;
      const before = i === 0 ? ' ' : s[i - 1], after = j >= n ? ' ' : s[j];
      const ws = x => /\s/.test(x) || x === '\u00a0';
      const left = !ws(after) && (!PUNCT.test(after) || ws(before) || PUNCT.test(before));
      const right = !ws(before) && (!PUNCT.test(before) || ws(after) || PUNCT.test(after));
      let canOpen, canClose;
      if (c === '_') { canOpen = left && (!right || PUNCT.test(before)); canClose = right && (!left || PUNCT.test(after)); }
      else { canOpen = left; canClose = right; }
      if (c === '~' && count > 2) { canOpen = canClose = false; }
      nodes.push({ t: 'delim', ch: c, count, orig: count, canOpen, canClose });
      i = j;
    } else if (c === '[' || (c === '!' && s[i + 1] === '[')) {
      const image = c === '!';
      nodes.push({ t: 'bracket', image, active: true, after: i + (image ? 2 : 1) });
      i += image ? 2 : 1;
    } else if (c === ']') {
      let bi = -1;
      for (let k = nodes.length - 1; k >= 0; k--) if (nodes[k].t === 'bracket') { bi = k; break; }
      if (bi < 0) { text(']'); i++; continue; }
      const b = nodes[bi];
      if (!b.active) { nodes[bi] = { t: 'text', v: b.image ? '![' : '[' }; text(']'); i++; continue; }
      let res = null;
      const raw = s.slice(b.after, i);
      if (s[i + 1] === '(') {
        let p = skipWs(s, i + 2), d = null;
        if (s[p] === ')') d = { url: '', end: p };
        else {
          d = parseDest(s, p);
          if (d) {
            let q = skipWs(s, d.end), title = null;
            if (q > d.end && s[q] !== ')') { const t = parseTitle(s, q); if (t) { title = t.title; q = skipWs(s, t.end); } else d = null; }
            if (d && s[q] === ')') res = { url: d.url, title, end: q + 1 }; else d = null;
          }
        }
        if (d && !res && s[p] === ')') res = { url: '', title: null, end: p + 1 };
      }
      if (!res) {
        let label = null, end = i + 1;
        if (s[i + 1] === '[') {
          const m = /^\[((?:[^\[\]\\]|\\.)*)\]/.exec(s.slice(i + 1, i + 1002));
          if (m) { if (m[1].trim()) { label = m[1]; end = i + 1 + m[0].length; } else { label = raw; end = i + 3; } }
          else label = raw;
        } else label = raw;
        if (label && label.trim() && label.length <= 999) {
          const def = defs.get(normLabel(label));
          if (def) res = { url: def.url, title: def.title, end };
        }
      }
      if (res) {
        const inner = procEm(nodes.slice(bi + 1));
        nodes.length = bi;
        nodes.push({ t: b.image ? 'image' : 'link', href: res.url, title: res.title, children: inner });
        if (!b.image) for (const o of nodes) if (o.t === 'bracket' && !o.image) o.active = false;
        i = res.end;
      } else { nodes[bi] = { t: 'text', v: b.image ? '![' : '[' }; text(']'); i++; }
    } else if (c === '\n') {
      const last = nodes[nodes.length - 1];
      let hard = false;
      if (last && last.t === 'text') {
        const m = /( *)$/.exec(last.v);
        if (m[1].length >= 2) hard = true;
        last.v = last.v.slice(0, last.v.length - m[1].length);
      }
      nodes.push({ t: hard ? 'hard' : 'soft' }); i++;
      while (s[i] === ' ' || s[i] === '\t') i++;
    } else {
      let j = i + 1;
      while (j < n && !'\\`&<*_~[]!\n'.includes(s[j])) j++;
      text(s.slice(i, j)); i = j;
    }
  }
  return procEm(nodes);
}
function procEm(nodes) {
  let ci = 0;
  while (ci < nodes.length) {
    const c = nodes[ci];
    if (c.t !== 'delim' || !c.canClose) { ci++; continue; }
    let oi = -1;
    for (let j = ci - 1; j >= 0; j--) {
      const o = nodes[j];
      if (o.t !== 'delim' || o.ch !== c.ch || !o.canOpen) continue;
      if (c.ch === '~') { if (o.count !== c.count) continue; }
      else if ((o.canClose || c.canOpen) && (o.orig + c.orig) % 3 === 0 && !(o.orig % 3 === 0 && c.orig % 3 === 0)) continue;
      oi = j; break;
    }
    if (oi < 0) { ci++; continue; }
    const o = nodes[oi];
    const use = c.ch === '~' ? c.count : (o.count >= 2 && c.count >= 2 ? 2 : 1);
    const wrapper = { t: c.ch === '~' ? 'del' : use === 2 ? 'strong' : 'em', children: nodes.slice(oi + 1, ci) };
    o.count -= use; c.count -= use;
    const repl = [];
    if (o.count > 0) repl.push(o);
    repl.push(wrapper);
    if (c.count > 0) repl.push(c);
    nodes.splice(oi, ci - oi + 1, ...repl);
    ci = oi + (o.count > 0 ? 1 : 0) + 1;
  }
  return nodes;
}
function inlineHtml(nodes) {
  let out = '';
  for (const n of nodes) {
    switch (n.t) {
      case 'text': out += esc(n.v); break;
      case 'delim': out += n.ch.repeat(n.count); break;
      case 'bracket': out += n.image ? '![' : '['; break;
      case 'code': out += '<code>' + esc(n.v) + '</code>'; break;
      case 'soft': out += '\n'; break;
      case 'hard': out += '<br />\n'; break;
      case 'em': out += '<em>' + inlineHtml(n.children) + '</em>'; break;
      case 'strong': out += '<strong>' + inlineHtml(n.children) + '</strong>'; break;
      case 'del': out += '<del>' + inlineHtml(n.children) + '</del>'; break;
      case 'link': out += '<a href="' + encodeUrl(n.href) + '"' + (n.title ? ' title="' + esc(n.title) + '"' : '') + '>' + inlineHtml(n.children) + '</a>'; break;
      case 'image': out += '<img src="' + encodeUrl(n.href) + '" alt="' + esc(inlineText(n.children)) + '"' + (n.title ? ' title="' + esc(n.title) + '"' : '') + ' />'; break;
    }
  }
  return out;
}
function inlineText(nodes) {
  let out = '';
  for (const n of nodes) {
    switch (n.t) {
      case 'text': case 'code': out += n.v; break;
      case 'delim': out += n.ch.repeat(n.count); break;
      case 'bracket': out += n.image ? '![' : '['; break;
      case 'soft': case 'hard': out += '\n'; break;
      default: if (n.children) out += inlineText(n.children);
    }
  }
  return out;
}

// ---------- blocks ----------
const isBlank = l => /^[ \t]*$/.test(l);
const indentOf = l => { let i = 0; while (l[i] === ' ') i++; return i; };
const hrRe = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const fenceRe = /^( {0,3})(`{3,}|~{3,})[ \t]*(.*)$/;
const listRe = /^( {0,3})([-+*]|\d{1,9}[.)])([ \t]+|$)(.*)$/;
const atxRe = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const bqRe = /^ {0,3}>/;
const delimRowRe = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

function isFenceOpen(l) { const m = fenceRe.exec(l); return m && !(m[2][0] === '`' && m[3].includes('`')) ? m : null; }
function interrupts(l) {
  if (hrRe.test(l) || atxRe.test(l) || isFenceOpen(l) || bqRe.test(l)) return true;
  const m = listRe.exec(l);
  if (m && m[4].trim() !== '') { if (/^\d/.test(m[2])) return parseInt(m[2], 10) === 1; return true; }
  return false;
}
function startsBlock(l) { return hrRe.test(l) || atxRe.test(l) || isFenceOpen(l) || bqRe.test(l) || listRe.test(l); }

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  const cells = []; let cur = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length) { if (s[i + 1] === '|') { cur += '|'; } else cur += s[i] + s[i + 1]; i++; }
    else if (s[i] === '|') { cells.push(cur); cur = ''; }
    else cur += s[i];
  }
  cells.push(cur);
  if (cells.length && cells[cells.length - 1].trim() === '' && /\|\s*$/.test(s)) cells.pop();
  return cells.map(c => c.trim());
}

function lastIsPara(blocks) {
  const b = blocks[blocks.length - 1];
  if (!b || b.blankAfter) return false;
  if (b.t === 'p') return true;
  if (b.t === 'bq') return lastIsPara(b.children);
  if (b.t === 'list') { const it = b.items[b.items.length - 1]; return lastIsPara(it.children); }
  return false;
}

function parseBlocks(lines, defs) {
  const out = [];
  let i = 0, blank = false;
  const n = lines.length;
  const push = node => { if (blank && out.length) { node.blankBefore = true; out[out.length - 1].blankAfter = true; } blank = false; out.push(node); };
  while (i < n) {
    const l = lines[i];
    if (isBlank(l)) { blank = true; i++; continue; }
    if (indentOf(l) >= 4) {
      const buf = [];
      while (i < n && (isBlank(lines[i]) || indentOf(lines[i]) >= 4)) { buf.push(isBlank(lines[i]) ? lines[i].slice(4) : lines[i].slice(4)); i++; }
      while (buf.length && isBlank(buf[buf.length - 1])) { buf.pop(); }
      // put back trailing blanks consumed
      let consumed = 0; while (i - 1 - consumed >= 0 && isBlank(lines[i - 1 - consumed])) consumed++;
      if (consumed) { blank = false; }
      push({ t: 'code', info: '', text: buf.join('\n') + '\n' });
      if (consumed) { blank = true; }
      continue;
    }
    let m;
    if ((m = isFenceOpen(l))) {
      const ind = m[1].length, ch = m[2][0], len = m[2].length;
      const info = unescapeStr(m[3].trim());
      const buf = []; i++;
      while (i < n) {
        const cm = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[i]);
        if (cm && cm[1][0] === ch && cm[1].length >= len) { i++; break; }
        let x = lines[i], k = 0; while (k < ind && x[k] === ' ') k++;
        buf.push(x.slice(k)); i++;
      }
      push({ t: 'code', info, text: buf.length ? buf.join('\n') + '\n' : '' });
      continue;
    }
    if (hrRe.test(l)) { push({ t: 'hr' }); i++; continue; }
    if ((m = atxRe.exec(l))) {
      let c = (m[2] || '').replace(/[ \t]+#+[ \t]*$/, '').replace(/^#+[ \t]*$/, '').trim();
      push({ t: 'h', level: m[1].length, text: c }); i++; continue;
    }
    if (bqRe.test(l)) {
      const inner = [];
      while (i < n) {
        const x = lines[i];
        if (bqRe.test(x)) { inner.push(x.replace(/^ {0,3}> ?/, '')); i++; }
        else if (!isBlank(x) && !startsBlock(x) && lastIsPara(parseBlocks(inner, new Map()))) { inner.push(x); i++; }
        else break;
      }
      push({ t: 'bq', children: parseBlocks(inner, defs) });
      continue;
    }
    if ((m = listRe.exec(l))) {
      const r = parseList(lines, i, defs);
      push(r.node); i = r.i; continue;
    }
    // paragraph / setext / table
    let plines = [l.replace(/^[ \t]+/, '')];
    i++;
    if (i < n && delimRowRe.test(lines[i]) && (l.includes('|') || lines[i].includes('|'))) {
      const head = splitRow(l), dr = splitRow(lines[i]);
      if (head.length === dr.length && dr.every(c => /^:?-+:?$/.test(c))) {
        const align = dr.map(c => c.startsWith(':') ? (c.endsWith(':') ? 'center' : 'left') : c.endsWith(':') ? 'right' : null);
        i++;
        const rows = [];
        while (i < n && !isBlank(lines[i]) && !interrupts(lines[i])) {
          const cells = splitRow(lines[i]);
          while (cells.length < head.length) cells.push('');
          rows.push(cells.slice(0, head.length)); i++;
        }
        push({ t: 'table', align, head, rows });
        continue;
      }
    }
    let setext = 0;
    while (i < n) {
      const x = lines[i];
      if (isBlank(x)) break;
      if (/^ {0,3}=+[ \t]*$/.test(x)) { setext = 1; i++; break; }
      if (/^ {0,3}-+[ \t]*$/.test(x)) { setext = 2; i++; break; }
      if (interrupts(x)) break;
      plines.push(x.replace(/^[ \t]+/, '')); i++;
    }
    let text = plines.join('\n');
    text = parseLinkDefs(text, defs);
    if (text.trim() === '') { if (setext) { /* only defs; underline becomes text */ } continue; }
    text = text.replace(/[ \t]+$/, '');
    if (setext) push({ t: 'h', level: setext, text });
    else push({ t: 'p', text });
  }
  return out;
}

function parseList(lines, i, defs) {
  const n = lines.length;
  const first = listRe.exec(lines[i]);
  const ordered = /^\d/.test(first[2]);
  const mtype = ordered ? first[2].slice(-1) : first[2];
  const start = ordered ? parseInt(first[2], 10) : null;
  const items = [];
  let blankBetween = false;
  for (;;) {
    const m = listRe.exec(lines[i]);
    const marker = m[2], sp = m[3].replace(/\t/g, '    ').length, rest = m[4];
    let ci, firstLine;
    if (rest.trim() === '') { ci = m[1].length + marker.length + 1; firstLine = ''; }
    else if (sp >= 5) { ci = m[1].length + marker.length + 1; firstLine = ' '.repeat(sp - 1) + rest; }
    else { ci = m[1].length + marker.length + sp; firstLine = rest; }
    const il = [firstLine]; i++;
    while (i < n) {
      const x = lines[i];
      if (isBlank(x)) {
        if (il.length === 1 && il[0] === '') break;
        il.push(''); i++; continue;
      }
      if (indentOf(x) >= ci) { il.push(x.slice(ci)); i++; continue; }
      if (il[il.length - 1] !== '' && !startsBlock(x) && lastIsPara(parseBlocks(il, new Map()))) { il.push(x.replace(/^[ \t]+/, '')); i++; continue; }
      break;
    }
    let trailing = false;
    while (il.length > 1 && il[il.length - 1] === '') { il.pop(); trailing = true; }
    if (il.length === 1 && il[0] === '' ) { /* empty item */ }
    const children = parseBlocks(il, defs);
    items.push({ children, trailing });
    // skip blank lines before the next item
    let j = i; while (j < n && isBlank(lines[j])) j++;
    const nm = j < n && !hrRe.test(lines[j]) && listRe.exec(lines[j]);
    if (nm && (/^\d/.test(nm[2]) === ordered) && (ordered ? nm[2].slice(-1) : nm[2]) === mtype) { if (j > i) items[items.length - 1].trailing = true; i = j; continue; }
    break;
  }
  let loose = false;
  items.forEach((it, k) => {
    if (it.trailing && k < items.length - 1) loose = true;
    it.children.forEach((c, idx) => { if (idx > 0 && c.blankBefore) loose = true; });
  });
  return { node: { t: 'list', ordered, start, items, tight: !loose }, i };
}

// ---------- rendering ----------
function renderBlocks(blocks, ctx, tight = false) {
  let out = '';
  for (const b of blocks) {
    switch (b.t) {
      case 'p': {
        const h = inlineHtml(parseInline(b.text, ctx.defs));
        out += tight ? h + '\n' : '<p>' + h + '</p>\n'; break;
      }
      case 'h': {
        const nodes = parseInline(b.text, ctx.defs);
        const id = ctx.headingIds ? ' id="' + esc(slugify(inlineText(nodes), ctx.seen)) + '"' : '';
        out += `<h${b.level}${id}>${inlineHtml(nodes)}</h${b.level}>\n`; break;
      }
      case 'code': {
        const cls = b.info ? ' class="language-' + esc(b.info.split(/\s+/)[0]) + '"' : '';
        out += `<pre><code${cls}>${esc(b.text)}</code></pre>\n`; break;
      }
      case 'hr': out += '<hr />\n'; break;
      case 'bq': out += '<blockquote>\n' + renderBlocks(b.children, ctx) + '</blockquote>\n'; break;
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        out += `<${tag}${b.ordered && b.start !== 1 ? ` start="${b.start}"` : ''}>\n`;
        for (const it of b.items) {
          let inner = renderBlocks(it.children, ctx, b.tight);
          if (b.tight) {
            // separate non-paragraph blocks from preceding inline text by newline
            inner = '';
            let prevP = false;
            for (const c of it.children) {
              const r = renderBlocks([c], ctx, true);
              if (c.t === 'p') inner += r.replace(/\n$/, ''), prevP = true;
              else inner += (prevP ? '\n' : '') + r, prevP = false;
            }
          }
          out += '<li>' + (!b.tight && inner ? '\n' : '') + inner + '</li>\n';
        }
        out += `</${tag}>\n`; break;
      }
      case 'table': {
        const cell = (tag, c, k) => `<${tag}${b.align[k] ? ` align="${b.align[k]}"` : ''}>${inlineHtml(parseInline(c, ctx.defs))}</${tag}>`;
        out += '<table>\n<thead>\n<tr>\n' + b.head.map((c, k) => cell('th', c, k)).join('\n') + '\n</tr>\n</thead>\n';
        if (b.rows.length) out += '<tbody>\n' + b.rows.map(r => '<tr>\n' + r.map((c, k) => cell('td', c, k)).join('\n') + '\n</tr>\n').join('') + '</tbody>\n';
        out += '</table>\n'; break;
      }
    }
  }
  return out;
}
const prep = md => String(md).replace(/\r\n?/g, '\n').replace(/\0/g, '\ufffd').split('\n').map(l => l.replace(/^[ ]*\t[ \t]*/, w => { let col = 0; for (const ch of w) col = ch === '\t' ? (col + 4) - (col % 4) : col + 1; return ' '.repeat(col); }));

export function render(markdown, { headingIds = false } = {}) {
  const defs = new Map();
  const blocks = parseBlocks(prep(markdown), defs);
  return renderBlocks(blocks, { defs, headingIds, seen: new Map() });
}
export function toc(markdown) {
  const defs = new Map();
  const blocks = parseBlocks(prep(markdown), defs);
  const seen = new Map(), res = [];
  (function walk(bs) {
    for (const b of bs) {
      if (b.t === 'h') { const text = inlineText(parseInline(b.text, defs)); res.push({ level: b.level, text, slug: slugify(text, seen) }); }
      else if (b.t === 'bq') walk(b.children);
      else if (b.t === 'list') b.items.forEach(it => walk(it.children));
    }
  })(blocks);
  return res;
}
