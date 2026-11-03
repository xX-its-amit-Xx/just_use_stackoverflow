const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function isPunct(c) { return c !== undefined && /[\p{P}\p{S}]/u.test(c); }
function isWs(c) { return c === undefined || /\s/.test(c); }

function inline(src) {
  // tokenise into nodes; delimiter-run handling for emphasis
  const out = []; // {t:'html',v} | {t:'delim',ch,n,canOpen,canClose}
  let i = 0, buf = '';
  const flush = () => { if (buf) { out.push({ t: 'html', v: esc(buf) }); buf = ''; } };
  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && i + 1 < src.length && /[!-\/:-@\[-`{-~]/.test(src[i + 1])) { buf += src[i + 1]; i += 2; continue; }
    if (c === '\\' && src[i + 1] === '\n') { flush(); out.push({ t: 'html', v: '<br />\n' }); i += 2; continue; }
    if (c === '`') {
      let n = 0; while (src[i + n] === '`') n++;
      const fence = '`'.repeat(n);
      let j = i + n, found = -1;
      while (j < src.length) {
        const k = src.indexOf('`', j);
        if (k < 0) break;
        let m = 0; while (src[k + m] === '`') m++;
        if (m === n) { found = k; break; }
        j = k + m;
      }
      if (found >= 0) {
        flush();
        let code = src.slice(i + n, found).replace(/\n/g, ' ');
        if (/[^ ]/.test(code) && code.startsWith(' ') && code.endsWith(' ')) code = code.slice(1, -1);
        out.push({ t: 'html', v: '<code>' + esc(code) + '</code>' });
        i = found + n; continue;
      }
      buf += fence; i += n; continue;
    }
    if (c === '!' && src[i + 1] === '[' || c === '[') {
      const img = c === '!';
      const start = i + (img ? 1 : 0);
      // find matching ]
      let depth = 0, j = start, end = -1;
      for (; j < src.length; j++) {
        if (src[j] === '\\') { j++; continue; }
        if (src[j] === '`') { const m = /^`+/.exec(src.slice(j))[0]; const k = src.indexOf(m, j + m.length); if (k > 0) { j = k + m.length - 1; continue; } }
        if (src[j] === '[') depth++;
        else if (src[j] === ']') { depth--; if (depth === 0) { end = j; break; } }
      }
      if (end > 0 && src[end + 1] === '(') {
        const m = /^\(\s*(?:<([^<>\n]*)>|((?:[^\s()\\]|\\.|\([^\s()]*\))*))(?:\s+(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|\(((?:[^)\\]|\\.)*)\)))?\s*\)/.exec(src.slice(end + 1));
        if (m) {
          const unesc = s => s.replace(/\\([!-\/:-@\[-`{-~])/g, '$1');
          const url = unesc(m[1] ?? m[2] ?? '');
          const title = m[3] ?? m[4] ?? m[5];
          const label = src.slice(start + 1, end);
          const href = esc(encodeURI(url).replace(/%25([0-9A-Fa-f]{2})/g, '%$1'));
          const t = title !== undefined ? ` title="${esc(unesc(title))}"` : '';
          flush();
          if (img) out.push({ t: 'html', v: `<img src="${href}" alt="${esc(plain(label))}"${t} />` });
          else out.push({ t: 'html', v: `<a href="${href}"${t}>${inline(label)}</a>` });
          i = end + 1 + m[0].length; continue;
        }
      }
      buf += c; i++; continue;
    }
    if (c === '*' || c === '_') {
      let n = 0; while (src[i + n] === c) n++;
      const before = src[i - 1], after = src[i + n];
      const lf = !isWs(after) && (!isPunct(after) || isWs(before) || isPunct(before));
      const rf = !isWs(before) && (!isPunct(before) || isWs(after) || isPunct(after));
      let canOpen, canClose;
      if (c === '*') { canOpen = lf; canClose = rf; }
      else { canOpen = lf && (!rf || isPunct(before)); canClose = rf && (!lf || isPunct(after)); }
      flush();
      out.push({ t: 'delim', ch: c, n, orig: n, canOpen, canClose, pre: '', post: '' });
      i += n; continue;
    }
    if (c === '\n') {
      buf = buf.replace(/ +$/, (m) => { if (m.length >= 2) { flush(); out.push({ t: 'html', v: '<br />' }); } return ''; });
      buf += '\n'; i++;
      while (src[i] === ' ') i++;
      continue;
    }
    buf += c; i++;
  }
  flush();
  // process emphasis
  for (let ci = 0; ci < out.length; ci++) {
    const cl = out[ci];
    if (cl.t !== 'delim' || !cl.canClose) continue;
    while (cl.n > 0) {
      let oi = -1;
      for (let k = ci - 1; k >= 0; k--) {
        const o = out[k];
        if (o.t === 'delim' && o.ch === cl.ch && o.canOpen && o.n > 0) {
          if ((o.canClose || cl.canOpen) && (o.orig + cl.orig) % 3 === 0 && !(o.orig % 3 === 0 && cl.orig % 3 === 0)) continue;
          oi = k; break;
        }
      }
      if (oi < 0) break;
      const o = out[oi];
      const use = o.n >= 2 && cl.n >= 2 ? 2 : 1;
      const tag = use === 2 ? 'strong' : 'em';
      o.n -= use; cl.n -= use;
      o.post = `<${tag}>` + o.post; // innermost opener tag emitted last => placed after remaining
      // content between becomes wrapped: collapse nodes between oi and ci
      let inner = '';
      for (let k = oi + 1; k < ci; k++) inner += render1(out[k]);
      const wrapped = { t: 'html', v: `<${tag}>${inner}</${tag}>` };
      o.post = o.post.slice(`<${tag}>`.length);
      out.splice(oi + 1, ci - oi - 1, wrapped);
      ci = oi + 2;
    }
  }
  return out.map(render1).join('');
}
function render1(n) { return n.t === 'html' ? n.v : n.ch.repeat(n.n); }
function plain(s) { return inline(s).replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"'); }

const reHr = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const reAtx = /^ {0,3}(#{1,6})(?:[ \t]+|$)(.*)$/;
const reFence = /^( {0,3})(`{3,}|~{3,})\s*([^`]*)$/;
const reList = /^( {0,3})([-*+]|\d{1,9}[.)])(?:[ \t]+(.*)|$)/;

export function render(markdown) {
  const lines = String(markdown).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const blank = l => /^\s*$/.test(l);
  const startsBlock = l => reAtx.test(l) || reFence.test(l) || reHr.test(l) || /^ {0,3}>/.test(l) ||
    (() => { const m = reList.exec(l); return m && m[3] !== undefined && m[3].trim() !== '' && (/^[-*+]/.test(m[2]) || m[2].startsWith('1.') || m[2].startsWith('1)')); })();
  while (i < lines.length) {
    const l = lines[i];
    if (blank(l)) { i++; continue; }
    let m;
    if ((m = reFence.exec(l))) {
      const [, indent, fence, info] = m;
      const ch = fence[0]; i++;
      const body = [];
      const close = new RegExp(`^ {0,3}${ch === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
      while (i < lines.length && !close.test(lines[i])) {
        body.push(lines[i].replace(new RegExp(`^ {0,${indent.length}}`), '')); i++;
      }
      i++;
      const lang = info.trim().split(/\s+/)[0];
      const cls = lang ? ` class="language-${esc(lang.replace(/\\([!-\/:-@\[-`{-~])/g, '$1'))}"` : '';
      out.push(`<pre><code${cls}>${body.length ? esc(body.join('\n')) + '\n' : ''}</code></pre>`);
      continue;
    }
    if (reHr.test(l)) { out.push('<hr />'); i++; continue; }
    if ((m = reAtx.exec(l))) {
      const text = m[2].replace(/[ \t]+#+[ \t]*$/, '').replace(/^#+[ \t]*$/, '').trim();
      out.push(`<h${m[1].length}>${inline(text)}</h${m[1].length}>`); i++; continue;
    }
    if (/^ {0,3}>/.test(l)) {
      const q = [];
      while (i < lines.length && !blank(lines[i])) {
        if (/^ {0,3}>/.test(lines[i])) q.push(lines[i].replace(/^ {0,3}> ?/, ''));
        else if (q.length && !startsBlock(lines[i])) q.push(lines[i]);
        else break;
        i++;
      }
      const inner = render(q.join('\n'));
      out.push(`<blockquote>\n${inner}</blockquote>`); continue;
    }
    if ((m = reList.exec(l))) {
      const ordered = /\d/.test(m[2][0]);
      const marker = ordered ? m[2].slice(-1) : m[2];
      const start = ordered ? parseInt(m[2], 10) : 1;
      const items = [];
      let loose = false, sawBlank = false;
      while (i < lines.length) {
        const mm = reList.exec(lines[i]);
        if (mm && !reHr.test(lines[i]) && (ordered ? /\d/.test(mm[2][0]) && mm[2].slice(-1) === marker : mm[2] === marker)) {
          if (sawBlank) loose = true;
          sawBlank = false;
          items.push([mm[3] ?? '']); i++;
          continue;
        }
        if (blank(lines[i])) {
          let j = i; while (j < lines.length && blank(lines[j])) j++;
          if (j < lines.length && /^ {2,}\S/.test(lines[j]) && items.length) { sawBlank = true; i = j; items[items.length - 1].push(''); continue; }
          if (j < lines.length) { const m2 = reList.exec(lines[j]); if (m2 && !reHr.test(lines[j])) { sawBlank = true; i = j; continue; } }
          break;
        }
        if (/^ {2,}\S/.test(lines[i]) && items.length) { items[items.length - 1].push(lines[i].trim()); i++; sawBlank = false; continue; }
        if (!startsBlock(lines[i]) && items.length && !sawBlank) { items[items.length - 1].push(lines[i].trim()); i++; continue; }
        break;
      }
      const lis = items.map(it => {
        const txt = it.join('\n').trim();
        if (loose) return `<li>${render(txt)}</li>`;
        return `<li>${inline(txt)}</li>`;
      });
      const tag = ordered ? 'ol' : 'ul';
      const attr = ordered && start !== 1 ? ` start="${start}"` : '';
      out.push(`<${tag}${attr}>\n${lis.join('\n')}\n</${tag}>`); continue;
    }
    // paragraph (with setext support)
    const p = [];
    let setext = 0;
    while (i < lines.length && !blank(lines[i])) {
      if (p.length && /^ {0,3}(=+|-+)[ \t]*$/.test(lines[i])) { setext = lines[i].trim()[0] === '=' ? 1 : 2; i++; break; }
      if (p.length && startsBlock(lines[i])) break;
      p.push(lines[i].replace(/^[ \t]+/, '')); i++;
    }
    const text = inline(p.join('\n').replace(/[ \t]+$/, ''));
    out.push(setext ? `<h${setext}>${text}</h${setext}>` : `<p>${text}</p>`);
  }
  return out.join('\n') + (out.length ? '\n' : '');
}
