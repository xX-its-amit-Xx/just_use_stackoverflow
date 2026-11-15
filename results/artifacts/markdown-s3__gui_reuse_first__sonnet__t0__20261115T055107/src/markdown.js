// Markdown renderer: CommonMark-style + GFM tables/strikethrough, safe by default, wiki links.
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', hellip: '…', mdash: '—', ndash: '–', hearts: '♥', auml: 'ä', ouml: 'ö', uuml: 'ü', Auml: 'Ä', ouml_: '', frac12: '½', ngsp: ' ' };

export function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function decodeEntities(s) {
  return s.replace(/&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([A-Za-z][A-Za-z0-9]{1,31}));/g, (m, hx, dc, nm) => {
    if (hx || dc) {
      let cp = hx ? parseInt(hx, 16) : parseInt(dc, 10);
      if (!cp || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
      return String.fromCodePoint(cp);
    }
    return Object.prototype.hasOwnProperty.call(ENT, nm) && ENT[nm] ? ENT[nm] : m;
  });
}
const unescapeMd = (s) => decodeEntities(s.replace(/\\([!-\/:-@\[-`{-~])/g, '$1'));

export function slugify(text, seen) {
  let s = String(text).toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-');
  if (seen) {
    if (!seen.has(s)) { seen.set(s, 0); return s; }
    let n = seen.get(s) + 1, slug = s + '-' + n;
    while (seen.has(slug)) { n++; slug = s + '-' + n; }
    seen.set(s, n); seen.set(slug, 0);
    return slug;
  }
  return s;
}

function normUrl(u) {
  return u.replace(/%[0-9a-fA-F]{2}|[A-Za-z0-9;\/?:@&=+$,\-_.!~*'()#]|[\s\S]/gu, (c) => {
    if (c.length > 1 && c[0] === '%') return c;
    if (/^[A-Za-z0-9;\/?:@&=+$,\-_.!~*'()#]$/.test(c)) return c;
    if (c === '%') return '%25';
    return [...Buffer.from(c, 'utf8')].map((b) => '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('');
  });
}
function safeUrl(u) {
  const m = /^\s*([a-zA-Z][a-zA-Z0-9+.\-]*):/.exec(u.replace(/[\u0000-\u001f]/g, ''));
  if (m) {
    const sch = m[1].toLowerCase();
    if (sch === 'javascript' || sch === 'vbscript' || sch === 'file') return '#';
    if (sch === 'data' && !/^\s*data:image\/(png|gif|jpeg|webp);/i.test(u)) return '#';
  }
  return u;
}
const hrefOf = (u) => escapeHtml(normUrl(safeUrl(u)));
const normLabel = (s) => s.trim().replace(/\s+/g, ' ').toLowerCase().replace(/ß/g, 'ss');

// ---------- inline ----------
const isWs = (c) => c === undefined || /[\s ]/u.test(c);
const isPunct = (c) => c !== undefined && /[\p{P}\p{S}]/u.test(c);

function parseDest(s, i) {
  // returns {url, end} or null; s[i] is first char after '('/ws
  if (s[i] === '<') {
    let j = i + 1, out = '';
    while (j < s.length && s[j] !== '>' && s[j] !== '\n' && s[j] !== '<') { if (s[j] === '\\' && j + 1 < s.length) { out += s[j] + s[j + 1]; j += 2; } else out += s[j++]; }
    if (s[j] !== '>') return null;
    return { url: unescapeMd(out), end: j + 1 };
  }
  let j = i, depth = 0;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && /[!-\/:-@\[-`{-~]/.test(s[j + 1])) { j += 2; continue; }
    if (c === '(') depth++;
    else if (c === ')') { if (depth === 0) break; depth--; }
    else if (/\s/.test(c) || c < ' ') break;
    j++;
  }
  if (depth !== 0) return null;
  return { url: unescapeMd(s.slice(i, j)), end: j };
}
function parseTitle(s, i) {
  const o = s[i];
  if (o !== '"' && o !== "'" && o !== '(') return null;
  const cl = o === '(' ? ')' : o;
  let j = i + 1, out = '';
  while (j < s.length) {
    if (s[j] === '\\' && j + 1 < s.length) { out += s[j] + s[j + 1]; j += 2; continue; }
    if (s[j] === cl) return { title: unescapeMd(out), end: j + 1 };
    if (o === '(' && s[j] === '(') return null;
    out += s[j++];
  }
  return null;
}
function parseLabel(s, i) {
  // s[i]==='[' ; returns {label, end} (end after ']')
  let j = i + 1, out = '';
  while (j < s.length) {
    if (s[j] === '\\' && j + 1 < s.length) { out += s[j] + s[j + 1]; j += 2; continue; }
    if (s[j] === '[') return null;
    if (s[j] === ']') return out.trim() && out.length <= 999 ? { label: out, end: j + 1 } : null;
    out += s[j++];
  }
  return null;
}

function inline(text, ctx) {
  const s = text;
  const nodes = [];
  const brackets = [];
  let i = 0, buf = '';
  const flush = () => { if (buf) { nodes.push({ h: escapeHtml(buf) }); buf = ''; } };
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      if (s[i + 1] === '\n') { flush(); nodes.push({ h: '<br />\n' }); i += 2; while (s[i] === ' ') i++; continue; }
      if (i + 1 < s.length && /[!-\/:-@\[-`{-~]/.test(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
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
      if (/^ .* $/s.test(code) && /[^ ]/.test(code)) code = code.slice(1, -1);
      flush(); nodes.push({ h: '<code>' + escapeHtml(code) + '</code>' });
      i = found + n; continue;
    }
    if (c === '&') {
      const m = /^&(?:#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/.exec(s.slice(i, i + 40));
      if (m) { const d = decodeEntities(m[0]); buf += d; i += m[0].length; continue; }
      buf += c; i++; continue;
    }
    if (c === '\n') {
      // soft/hard break
      const hard = / {2,}$/.test(buf);
      buf = buf.replace(/ +$/, '');
      flush(); nodes.push({ h: hard ? '<br />\n' : '\n' }); i++;
      while (s[i] === ' ' || s[i] === '\t') i++;
      continue;
    }
    if (c === '<') {
      const rest = s.slice(i);
      let m = /^<([A-Za-z][A-Za-z0-9+.\-]{1,31}:[^\s<>]*)>/.exec(rest);
      if (m) { flush(); nodes.push({ h: `<a href="${hrefOf(m[1])}">${escapeHtml(m[1])}</a>` }); i += m[0].length; continue; }
      m = /^<([A-Za-z0-9.!#$%&'*+\/=?^_`{|}~\-]+@[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9\-]{0,61}[A-Za-z0-9])?)*)>/.exec(rest);
      if (m) { flush(); nodes.push({ h: `<a href="mailto:${hrefOf(m[1])}">${escapeHtml(m[1])}</a>` }); i += m[0].length; continue; }
      buf += c; i++; continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      let n = 0; while (s[i + n] === c) n++;
      if (c === '~' && n !== 2) { buf += s.slice(i, i + n); i += n; continue; }
      const before = i === 0 ? undefined : [...s.slice(Math.max(0, i - 2), i)].pop();
      const after = [...s.slice(i + n, i + n + 2)][0];
      const wsA = isWs(after), wsB = isWs(before), pA = isPunct(after), pB = isPunct(before);
      const left = !wsA && (!pA || wsB || pB);
      const right = !wsB && (!pB || wsA || pA);
      let canOpen, canClose;
      if (c === '_') { canOpen = left && (!right || pB); canClose = right && (!left || pA); }
      else { canOpen = left; canClose = right; }
      flush();
      nodes.push({ d: true, ch: c, n, orig: n, canOpen, canClose, h: c.repeat(n) });
      i += n; continue;
    }
    if (c === '[') {
      if (s[i + 1] === '[' && ctx.wiki) {
        const m = /^\[\[([^\[\]\n]+?)\]\]/.exec(s.slice(i));
        if (m) {
          flush();
          let target = m[1], label = m[1];
          const p = m[1].indexOf('|');
          if (p >= 0) { target = m[1].slice(0, p); label = m[1].slice(p + 1); }
          target = target.trim(); label = label.trim();
          const slug = slugify(target);
          const ex = ctx.wiki.exists(slug);
          nodes.push({ h: `<a href="/wiki/${escapeHtml(normUrl(slug))}" class="wikilink${ex ? '' : ' missing'}">${escapeHtml(label)}</a>` });
          i += m[0].length; continue;
        }
      }
      flush();
      const node = { h: '[', br: true, active: true, img: false, pos: i };
      nodes.push(node); brackets.push(node); i++; continue;
    }
    if (c === '!' && s[i + 1] === '[') {
      flush();
      const node = { h: '![', br: true, active: true, img: true, pos: i };
      nodes.push(node); brackets.push(node); i += 2; continue;
    }
    if (c === ']') {
      const op = brackets.pop();
      if (!op) { buf += c; i++; continue; }
      flush();
      const idx = nodes.indexOf(op);
      if (!op.active) { op.br = false; buf += ']'; i++; continue; }
      let url = null, title = null, end = i + 1;
      // inline link
      if (s[i + 1] === '(') {
        let j = i + 2;
        while (/[ \t\n]/.test(s[j] || '')) j++;
        let d = s[j] === ')' ? { url: '', end: j } : parseDest(s, j);
        if (d) {
          j = d.end;
          let k = j; while (/[ \t\n]/.test(s[k] || '')) k++;
          let t = null;
          if (k > j) { t = parseTitle(s, k); if (t) { k = t.end; while (/[ \t\n]/.test(s[k] || '')) k++; } }
          if (s[k] === ')') { url = d.url; title = t ? t.title : null; end = k + 1; }
        }
      }
      if (url === null) {
        const inner = s.slice(op.pos + (op.img ? 2 : 1), i);
        let lab = null, e2 = i + 1;
        if (s[i + 1] === '[') {
          const l = parseLabel(s, i + 1);
          if (l) { lab = l.label; e2 = l.end; }
          else if (s[i + 2] === ']') { lab = inner; e2 = i + 3; }
        } else lab = inner;
        const def = lab !== null && ctx.refs.get(normLabel(lab));
        if (def) { url = def.url; title = def.title; end = e2; }
      }
      if (url === null) { op.br = false; buf += ']'; i++; continue; }
      const inside = nodes.slice(idx + 1);
      nodes.length = idx + 1;
      const innerHtml = emphasis(inside);
      nodes.pop();
      if (op.img) {
        const alt = innerHtml.replace(/<img [^>]*alt="([^"]*)"[^>]*>/g, '$1').replace(/<[^>]+>/g, '');
        nodes.push({ h: `<img src="${hrefOf(url)}" alt="${alt}"${title != null ? ` title="${escapeHtml(title)}"` : ''} />` });
      } else {
        nodes.push({ h: `<a href="${hrefOf(url)}"${title != null ? ` title="${escapeHtml(title)}"` : ''}>${innerHtml}</a>` });
        for (const b of brackets) if (!b.img) b.active = false;
      }
      i = end; continue;
    }
    buf += c; i++;
  }
  flush();
  return emphasis(nodes);
}

function emphasis(nodes) {
  nodes = nodes.map((n) => ({ ...n }));
  for (let ci = 0; ci < nodes.length; ci++) {
    const cl = nodes[ci];
    if (!cl.d || !cl.canClose || cl.n === 0) continue;
    while (cl.n > 0) {
      let oi = -1;
      for (let k = ci - 1; k >= 0; k--) {
        const o = nodes[k];
        if (!o.d || o.ch !== cl.ch || !o.canOpen || o.n === 0) continue;
        if (cl.ch === '~') { if (o.n !== 2 || cl.n !== 2) continue; }
        else if ((o.canClose || cl.canOpen) && (o.orig + cl.orig) % 3 === 0 && !(o.orig % 3 === 0 && cl.orig % 3 === 0)) continue;
        oi = k; break;
      }
      if (oi < 0) break;
      const o = nodes[oi];
      const strong = cl.ch === '~' ? false : o.n >= 2 && cl.n >= 2;
      const tag = cl.ch === '~' ? 'del' : strong ? 'strong' : 'em';
      const use = cl.ch === '~' ? 2 : strong ? 2 : 1;
      const inner = nodes.slice(oi + 1, ci).map((x) => x.h).join('');
      o.n -= use; cl.n -= use; o.h = o.ch.repeat(o.n); cl.h = cl.ch.repeat(cl.n);
      const mid = { h: `<${tag}>${inner}</${tag}>` };
      nodes.splice(oi + 1, ci - oi - 1, mid);
      ci = oi + 2;
    }
  }
  return nodes.map((n) => (n.d ? escapeHtml(n.h) : n.h)).join('');
}

// ---------- blocks ----------
const indentOf = (l) => { let n = 0; while (l[n] === ' ') n++; return n; };
const isBlank = (l) => /^\s*$/.test(l);
const HR = /^ {0,3}([-*_])([ \t]*\1){2,}[ \t]*$/;
const ATX = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ITEM = /^( {0,3})([-+*]|\d{1,9}[.)])([ \t]+|$)/;
const startsBlock = (l, forPara = true) => {
  if (HR.test(l) || ATX.test(l)) return true;
  const f = FENCE.exec(l); if (f && !(f[1][0] === '`' && f[2].includes('`'))) return true;
  if (/^ {0,3}>/.test(l)) return true;
  const m = ITEM.exec(l);
  if (m && m[3].length && l.slice(m[0].length).trim() && (/^[-+*]/.test(m[2]) || parseInt(m[2], 10) === 1)) return true;
  return false;
};
const expandTabs = (l) => {
  if (!l.includes('\t')) return l;
  let out = '', col = 0, i = 0;
  while (i < l.length && (l[i] === ' ' || l[i] === '\t')) { if (l[i] === '\t') { const n = 4 - (col % 4); out += ' '.repeat(n); col += n; } else { out += ' '; col++; } i++; }
  return out + l.slice(i);
};

function splitRow(l) {
  let t = l.trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const cells = []; let cur = '';
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '\\' && t[i + 1] === '|') { cur += '|'; i++; }
    else if (t[i] === '|') { cells.push(cur.trim()); cur = ''; }
    else cur += t[i];
  }
  cells.push(cur.trim());
  return cells;
}
const DELIM = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

function extractDefs(text, refs) {
  for (;;) {
    const m = /^ {0,3}\[/.exec(text);
    if (!m) return text;
    const l = parseLabel(text, m[0].length - 1);
    if (!l || text[l.end] !== ':') return text;
    let j = l.end + 1;
    while (/[ \t\n]/.test(text[j] || '')) j++;
    const d = parseDest(text, j);
    if (!d || (d.url === '' && text[j] !== '<')) return text;
    j = d.end;
    let k = j; while (/[ \t]/.test(text[k] || '')) k++;
    let nl = false; if (text[k] === '\n') { nl = true; k++; while (/[ \t]/.test(text[k] || '')) k++; }
    let t = null;
    if ((k > j) && (text[k] !== undefined)) t = parseTitle(text, k);
    let endPos;
    if (t) { let e = t.end; while (/[ \t]/.test(text[e] || '')) e++; if (e >= text.length || text[e] === '\n') endPos = e; else t = null; }
    if (!t) { let e = j; while (/[ \t]/.test(text[e] || '')) e++; if (e >= text.length || text[e] === '\n') endPos = e; else return text; }
    const key = normLabel(l.label);
    if (!refs.has(key)) refs.set(key, { url: d.url, title: t ? t.title : null });
    text = text.slice(endPos + 1);
    if (!text) return '';
  }
}

function parseBlocks(lines, refs) {
  const out = [];
  let i = 0, para = [], sawBlank = false;
  const push = (b) => { b.blankBefore = sawBlank && out.length > 0; sawBlank = false; out.push(b); };
  const flush = () => {
    if (!para.length) return;
    let text = para.map((l) => l.replace(/^[ \t]+/, '')).join('\n');
    para = [];
    text = extractDefs(text, refs);
    if (text.trim()) push({ t: 'p', text: text.replace(/[ \t]+$/, '') });
  };
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { flush(); sawBlank = true; i++; continue; }
    const ind = indentOf(line);
    if (ind >= 4) {
      if (para.length) { para.push(line); i++; continue; }
      const code = [];
      while (i < lines.length && (isBlank(lines[i]) || indentOf(lines[i]) >= 4)) { code.push(lines[i].slice(Math.min(4, indentOf(lines[i])))); i++; }
      while (code.length && isBlank(code[code.length - 1])) { code.pop(); }
      // blanks consumed after code: remember
      let k = i; if (k > 0 && isBlank(lines[k - 1])) sawBlank = true;
      push({ t: 'code', info: '', text: code.map((l) => (isBlank(l) ? l.replace(/^ {0,4}/, '') : l)).join('\n') + '\n' });
      continue;
    }
    const fm = FENCE.exec(line);
    if (fm && !(fm[1][0] === '`' && fm[2].includes('`'))) {
      flush();
      const ch = fm[1][0], len = fm[1].length, info = unescapeMd(fm[2].trim()).split(/\s+/)[0] || '';
      const body = []; i++;
      const close = new RegExp(`^ {0,3}\\${ch}{${len},}[ \\t]*$`);
      while (i < lines.length && !close.test(lines[i])) { let l = lines[i]; const n = Math.min(ind, indentOf(l)); body.push(l.slice(n)); i++; }
      i++;
      push({ t: 'code', info, text: body.length ? body.join('\n') + '\n' : '' });
      continue;
    }
    if (ATX.test(line)) {
      flush();
      const m = /^ {0,3}(#{1,6})(.*)$/.exec(line);
      let c = m[2].replace(/^[ \t]+/, '').replace(/[ \t]+#+[ \t]*$/, '').replace(/^#+[ \t]*$/, '').trim();
      push({ t: 'h', level: m[1].length, text: c }); i++; continue;
    }
    if (para.length) {
      const sm = /^ {0,3}(=+|-+)[ \t]*$/.exec(line);
      if (sm) {
        const text = para.map((l) => l.replace(/^[ \t]+/, '')).join('\n'); para = [];
        const t2 = extractDefs(text, refs);
        if (t2.trim()) { push({ t: 'h', level: sm[1][0] === '=' ? 1 : 2, text: t2.trim() }); i++; continue; }
        // all defs: fallthrough treat line as ordinary
      }
    }
    if (HR.test(line)) { flush(); push({ t: 'hr' }); i++; continue; }
    if (para.length === 1 && DELIM.test(line) && line.includes('-') && (line.includes('|') || para[0].includes('|'))) {
      const head = splitRow(para[0]), dl = splitRow(line);
      if (head.length === dl.length && dl.every((c) => /^:?-+:?$/.test(c))) {
        para = [];
        const aligns = dl.map((c) => (c[0] === ':' ? (c.endsWith(':') ? 'center' : 'left') : c.endsWith(':') ? 'right' : null));
        const rows = []; i++;
        while (i < lines.length && !isBlank(lines[i]) && !startsBlock(lines[i])) {
          const r = splitRow(lines[i]); while (r.length < head.length) r.push(''); rows.push(r.slice(0, head.length)); i++;
        }
        push({ t: 'table', head, aligns, rows }); continue;
      }
    }
    if (/^ {0,3}>/.test(line)) {
      flush();
      const inner = [];
      while (i < lines.length) {
        const l = lines[i];
        if (/^ {0,3}>/.test(l)) { inner.push(l.replace(/^ {0,3}> ?/, '')); i++; }
        else if (!isBlank(l) && inner.length && !isBlank(inner[inner.length - 1]) && !startsBlock(l) && !/^ {4,}/.test(inner[inner.length - 1]) && !/^\s*(```|~~~)/.test(inner[inner.length - 1])) { inner.push(l); i++; }
        else break;
      }
      push({ t: 'bq', children: parseBlocks(inner, refs) }); continue;
    }
    const im = ITEM.exec(line);
    if (im && !(para.length && !startsBlock(line))) {
      flush();
      i = parseList(lines, i, refs, push);
      continue;
    }
    para.push(line); i++;
  }
  flush();
  return out;
}

function parseList(lines, i, refs, push) {
  const first = ITEM.exec(lines[i]);
  const ordered = /\d/.test(first[2][0]);
  const delim = ordered ? first[2].slice(-1) : first[2];
  const start = ordered ? parseInt(first[2], 10) : 1;
  const items = []; let loose = false, blankBetween = false;
  for (;;) {
    const m = ITEM.exec(lines[i]);
    const mw = m[2].length;
    const rest = lines[i].slice(m[0].length);
    let spaces = m[3].length, content;
    const baseInd = m[1].length;
    if (!rest.trim()) { spaces = 1; content = ''; }
    else if (spaces >= 5) { spaces = 1; content = lines[i].slice(baseInd + mw + 1); }
    else content = rest;
    const ci = baseInd + mw + spaces;
    const body = [content];
    let j = i + 1, lastBlankIdx = -1, inFence = null;
    while (j < lines.length) {
      const l = lines[j];
      if (isBlank(l)) {
        let k = j; while (k < lines.length && isBlank(lines[k])) k++;
        if (k >= lines.length) break;
        if (indentOf(lines[k]) >= ci && !(body.length === 1 && !body[0].trim() && k > j)) { for (; j < k; j++) body.push(''); continue; }
        break;
      }
      if (indentOf(l) >= ci) { body.push(l.slice(ci)); j++; continue; }
      // lazy continuation
      const prev = body[body.length - 1];
      if (prev.trim() && !startsBlock(l) && !ITEM.test(l) && !/^ {0,3}(```|~~~)/.test(prev.trimStart()) && !/^ {4,}/.test(prev) && !/^ {0,3}>/.test(l)) { body.push(l.trimStart()); j++; continue; }
      break;
    }
    while (body.length && isBlank(body[body.length - 1])) body.pop();
    const children = parseBlocks(body, refs);
    if (children.some((c, idx) => idx > 0 && c.blankBefore)) loose = true;
    items.push(children);
    i = j;
    // next item?
    let k = i; while (k < lines.length && isBlank(lines[k])) k++;
    if (k >= lines.length) { break; }
    if (HR.test(lines[k])) break;
    const nm = ITEM.exec(lines[k]);
    if (!nm) break;
    const nOrdered = /\d/.test(nm[2][0]);
    if (nOrdered !== ordered || (nOrdered ? nm[2].slice(-1) : nm[2]) !== delim) break;
    if (k > i) blankBetween = true;
    i = k;
  }
  push({ t: 'list', ordered, start, items, loose: loose || blankBetween });
  return i;
}

// ---------- rendering ----------
function plainText(html) { return decodeEntities(html.replace(/<[^>]+>/g, '')); }

function renderBlocks(blocks, ctx, tight = false) {
  let out = '';
  for (const b of blocks) {
    switch (b.t) {
      case 'p': { const h = inline(b.text, ctx); out += tight ? h + '\n' : `<p>${h}</p>\n`; break; }
      case 'h': {
        const h = inline(b.text, ctx);
        const slug = slugify(plainText(h).trim(), ctx.seen);
        ctx.toc.push({ level: b.level, text: plainText(h).trim(), slug });
        out += `<h${b.level}${ctx.ids ? ` id="${escapeHtml(slug)}"` : ''}>${h}</h${b.level}>\n`; break;
      }
      case 'hr': out += '<hr />\n'; break;
      case 'code': out += `<pre><code${b.info ? ` class="language-${escapeHtml(b.info)}"` : ''}>${escapeHtml(b.text)}</code></pre>\n`; break;
      case 'bq': out += `<blockquote>\n${renderBlocks(b.children, ctx)}</blockquote>\n`; break;
      case 'list': {
        const tag = b.ordered ? 'ol' : 'ul';
        out += `<${tag}${b.ordered && b.start !== 1 ? ` start="${b.start}"` : ''}>\n`;
        for (const it of b.items) {
          let inner = renderBlocks(it, ctx, !b.loose);
          if (!b.loose && it.length && it[0].t !== 'p') inner = '\n' + inner;
          out += `<li>${inner.replace(/\n$/, it.length && it[it.length - 1].t === 'p' && !b.loose ? '' : '\n')}</li>\n`;
        }
        out += `</${tag}>\n`; break;
      }
      case 'table': {
        const al = (i) => (b.aligns[i] ? ` align="${b.aligns[i]}"` : '');
        out += '<table>\n<thead>\n<tr>\n' + b.head.map((c, i) => `<th${al(i)}>${inline(c, ctx)}</th>\n`).join('') + '</tr>\n</thead>\n';
        if (b.rows.length) out += '<tbody>\n' + b.rows.map((r) => '<tr>\n' + r.map((c, i) => `<td${al(i)}>${inline(c, ctx)}</td>\n`).join('') + '</tr>\n').join('') + '</tbody>\n';
        out += '</table>\n'; break;
      }
    }
  }
  return out;
}

function run(markdown, { headingIds = false, wikiLinks } = {}) {
  const lines = String(markdown ?? '').replace(/\r\n?/g, '\n').split('\n').map(expandTabs);
  const refs = new Map();
  const blocks = parseBlocks(lines, refs);
  const ctx = { refs, ids: headingIds, wiki: wikiLinks && typeof wikiLinks.exists === 'function' ? wikiLinks : null, seen: new Map(), toc: [] };
  const html = renderBlocks(blocks, ctx);
  return { html, toc: ctx.toc };
}

export function render(markdown, opts = {}) { return run(markdown, opts).html; }
export function toc(markdown) { return run(markdown, {}).toc; }
