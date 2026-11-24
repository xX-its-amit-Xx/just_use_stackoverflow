const $ = (id) => document.getElementById(id);
let version = null;
const api = async (method, url, body) => {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const t = r.status === 204 ? null : await r.json(); return { status: r.status, data: t };
};
const li = (text, fn) => { const e = document.createElement('li'); e.textContent = text; e.style.cursor = 'pointer'; e.onclick = fn; return e; };
async function loadList() {
  const tag = $('tag').value;
  const { data } = await api('GET', '/api/pages' + (tag ? '?tag=' + encodeURIComponent(tag) : ''));
  $('list').replaceChildren(...data.map((p) => li(p.title, () => open(p.slug))));
  const tags = (await api('GET', '/api/tags')).data;
  $('tag').replaceChildren(new Option('all tags', ''), ...tags.map((t) => new Option(`${t.tag} (${t.count})`, t.tag)));
  $('tag').value = tag;
}
async function open(slug) {
  const { status, data } = await api('GET', '/api/pages/' + slug);
  if (status !== 200) return;
  $('slug').value = data.slug; $('title').value = data.title; $('body').value = data.body; $('tags').value = data.tags.join(', ');
  version = data.version; $('preview').innerHTML = data.html; $('msg').textContent = '';
  $('backlinks').replaceChildren(...data.backlinks.map((s) => li(s, () => open(s))));
  const h = (await api('GET', `/api/pages/${slug}/history`)).data;
  $('history').replaceChildren(...h.map((v) => li(`v${v.version} ${v.title} (${v.updatedAt})`, () => showDiff(slug, Math.max(1, v.version - 1), v.version))));
  $('diff').textContent = '';
}
async function showDiff(slug, from, to) {
  const { data } = await api('GET', `/api/pages/${slug}/diff?from=${from}&to=${to}`);
  $('diff').replaceChildren(...data.lines.map((l) => { const s = document.createElement('span'); s.className = l.op === '+' ? 'p' : l.op === '-' ? 'm' : ''; s.textContent = l.op + ' ' + l.text + '\n'; return s; }));
}
let timer;
$('body').oninput = () => { clearTimeout(timer); timer = setTimeout(async () => { $('preview').innerHTML = (await api('POST', '/api/render', { markdown: $('body').value })).data.html; }, 200); };
$('save').onclick = async () => {
  const slug = $('slug').value;
  const tags = $('tags').value.split(',').map((s) => s.trim()).filter(Boolean);
  const payload = { title: $('title').value, body: $('body').value, tags };
  if (version != null) payload.baseVersion = version;
  const { status, data } = await api('PUT', '/api/pages/' + slug, payload);
  if (status === 409) { $('msg').textContent = `Conflict: page is now at version ${data.currentVersion}. Reload to merge.`; return; }
  if (status >= 400) { $('msg').textContent = data.message; return; }
  await open(slug); await loadList();
};
$('del').onclick = async () => { await api('DELETE', '/api/pages/' + $('slug').value); $('new').click(); loadList(); };
$('new').onclick = () => { for (const i of ['slug', 'title', 'tags', 'body']) $(i).value = ''; version = null; $('preview').innerHTML = ''; };
$('tag').onchange = loadList;
$('q').oninput = async () => {
  if (!$('q').value.trim()) return $('results').replaceChildren();
  const { data } = await api('GET', '/api/search?q=' + encodeURIComponent($('q').value));
  $('results').replaceChildren(...data.map((r) => { const e = li('', () => open(r.slug)); e.innerHTML = `<b></b> ${r.snippet}`; e.firstChild.textContent = r.title; return e; }));
};
loadList();
