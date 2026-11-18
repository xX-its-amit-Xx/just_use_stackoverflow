const $ = (id) => document.getElementById(id);
let version;
const api = async (m, u, b) => { const r = await fetch(u, { method: m, headers: { 'content-type': 'application/json' }, body: b ? JSON.stringify(b) : undefined }); return { status: r.status, data: r.status === 204 ? null : await r.json() }; };
const el = (t, text, fn) => { const e = document.createElement(t); e.textContent = text; if (fn) e.onclick = fn; return e; };
async function loadList() {
  const tag = $('tagfilter').value, q = $('search').value.trim();
  const tags = (await api('GET', '/api/tags')).data;
  const sel = $('tagfilter'); const cur = sel.value;
  sel.replaceChildren(el('option', 'all tags')); sel.firstChild.value = '';
  for (const t of tags) { const o = el('option', `${t.tag} (${t.count})`); o.value = t.tag; sel.append(o); }
  sel.value = cur;
  const items = q ? (await api('GET', '/api/search?q=' + encodeURIComponent(q))).data : (await api('GET', '/api/pages?tag=' + encodeURIComponent(tag))).data;
  $('list').replaceChildren(...(Array.isArray(items) ? items : []).map((p) => { const li = el('li', p.title, () => open(p.slug)); li.style.cursor = 'pointer'; return li; }));
}
async function open(slug) {
  const { status, data } = await api('GET', '/api/pages/' + slug);
  if (status !== 200) return;
  $('slug').value = data.slug; $('title').value = data.title; $('body').value = data.body; $('tags').value = data.tags.join(', ');
  version = data.version; $('preview').innerHTML = data.html;
  $('backlinks').replaceChildren(...data.backlinks.map((s) => el('li', s, () => open(s))));
  loadHistory(slug);
}
async function loadHistory(slug) {
  const h = (await api('GET', `/api/pages/${slug}/history`)).data;
  $('history').replaceChildren(...h.map((v, i) => {
    const li = el('li', `v${v.version} ${v.title} `);
    if (i + 1 < h.length) li.append(el('button', 'diff', async () => {
      const d = (await api('GET', `/api/pages/${slug}/diff?from=${h[i + 1].version}&to=${v.version}`)).data;
      $('diff').replaceChildren(...d.lines.map((l) => { const s = el('div', l.op + ' ' + l.text); s.className = l.op === '+' ? 'add' : l.op === '-' ? 'del' : ''; return s; }));
    }));
    li.append(el('button', 'revert', async () => { await api('POST', `/api/pages/${slug}/revert`, { version: v.version }); open(slug); loadList(); }));
    return li;
  }));
}
let timer;
$('body').oninput = () => { clearTimeout(timer); timer = setTimeout(async () => { $('preview').innerHTML = (await api('POST', '/api/render', { markdown: $('body').value })).data.html; }, 200); };
$('save').onclick = async () => {
  const slug = $('slug').value.trim();
  const payload = { title: $('title').value, body: $('body').value, tags: $('tags').value.split(',').map((s) => s.trim()).filter(Boolean) };
  if (version) payload.baseVersion = version;
  const { status, data } = await api('PUT', '/api/pages/' + slug, payload);
  if (status === 409) { $('status').textContent = `Conflict: server is at v${data.currentVersion}. Reload the page to merge, or save again to overwrite.`; version = data.currentVersion; return; }
  if (status >= 400) { $('status').textContent = data.message; return; }
  $('status').textContent = 'Saved v' + data.version; version = data.version; open(slug); loadList();
};
$('new').onclick = () => { for (const i of ['slug', 'title', 'body', 'tags']) $(i).value = ''; version = undefined; $('preview').innerHTML = ''; };
$('search').oninput = loadList; $('tagfilter').onchange = loadList;
loadList();
