const $ = (id) => document.getElementById(id);
let version = null;
async function api(method, url, body) {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text();
  return { status: r.status, data: t ? JSON.parse(t) : null };
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function loadList() {
  const tag = $('tagfilter').value;
  const { data } = await api('GET', '/api/pages' + (tag ? '?tag=' + encodeURIComponent(tag) : ''));
  $('pages').innerHTML = data.map((p) => `<li><a href="#" data-slug="${esc(p.slug)}">${esc(p.title)}</a></li>`).join('');
  const tags = (await api('GET', '/api/tags')).data;
  const cur = $('tagfilter').value;
  $('tagfilter').innerHTML = '<option value="">All tags</option>' + tags.map((t) => `<option value="${esc(t.tag)}">${esc(t.tag)} (${t.count})</option>`).join('');
  $('tagfilter').value = cur;
}
async function openPage(slug) {
  const { status, data } = await api('GET', '/api/pages/' + encodeURIComponent(slug));
  if (status !== 200) return;
  $('slug').value = data.slug; $('title').value = data.title; $('body').value = data.body; $('tags').value = data.tags.join(', ');
  version = data.version; $('status').textContent = 'version ' + version;
  $('backlinks').innerHTML = data.backlinks.map((s) => `<a href="#" data-slug="${esc(s)}">${esc(s)}</a>`).join(', ') || 'none';
  $('preview').innerHTML = data.html; $('history').innerHTML = ''; $('diff').innerHTML = '';
}
let timer;
$('body').addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(async () => { const { data } = await api('POST', '/api/render', { markdown: $('body').value }); $('preview').innerHTML = data.html; }, 200);
});
$('save').onclick = async () => {
  const slug = $('slug').value.trim();
  const payload = { title: $('title').value, body: $('body').value, tags: $('tags').value.split(',').map((s) => s.trim()).filter(Boolean) };
  if (version !== null) payload.baseVersion = version;
  const { status, data } = await api('PUT', '/api/pages/' + encodeURIComponent(slug), payload);
  if (status === 409) {
    if (confirm('Conflict: page is now at version ' + data.currentVersion + '. Overwrite with your changes?')) { version = data.currentVersion; $('save').onclick(); }
    return;
  }
  if (status >= 400) { $('status').textContent = data.message; return; }
  await openPage(slug); await loadList();
};
$('new').onclick = () => { version = null; for (const i of ['slug', 'title', 'body', 'tags']) $(i).value = ''; $('preview').innerHTML = ''; $('status').textContent = 'new page'; };
document.addEventListener('click', (e) => { const s = e.target.dataset && e.target.dataset.slug; if (s) { e.preventDefault(); openPage(s); } });
$('tagfilter').onchange = loadList;
$('search').addEventListener('input', async () => {
  const q = $('search').value.trim();
  if (!q) { $('results').innerHTML = ''; return; }
  const { data } = await api('GET', '/api/search?q=' + encodeURIComponent(q));
  $('results').innerHTML = data.map((r) => `<li><a href="#" data-slug="${esc(r.slug)}">${esc(r.title)}</a><br><small>${r.snippet}</small></li>`).join('');
});
$('histbtn').onclick = async () => {
  const slug = $('slug').value; if (!slug) return;
  const { data } = await api('GET', `/api/pages/${encodeURIComponent(slug)}/history`);
  $('history').innerHTML = data.map((h, i) => `<li>v${h.version} ${esc(h.title)} ${esc(h.updatedAt)} ${data[i + 1] ? `<button data-from="${data[i + 1].version}" data-to="${h.version}">diff</button>` : ''} <button data-rev="${h.version}">revert</button></li>`).join('');
};
$('history').addEventListener('click', async (e) => {
  const slug = $('slug').value;
  if (e.target.dataset.rev) { await api('POST', `/api/pages/${encodeURIComponent(slug)}/revert`, { version: Number(e.target.dataset.rev) }); await openPage(slug); }
  if (e.target.dataset.from) {
    const { data } = await api('GET', `/api/pages/${encodeURIComponent(slug)}/diff?from=${e.target.dataset.from}&to=${e.target.dataset.to}`);
    $('diff').innerHTML = data.lines.map((l) => `<pre class="${l.op === '-' ? 'del' : l.op === '+' ? 'add' : ''}">${esc(l.op + ' ' + l.text)}</pre>`).join('');
  }
});
loadList();
