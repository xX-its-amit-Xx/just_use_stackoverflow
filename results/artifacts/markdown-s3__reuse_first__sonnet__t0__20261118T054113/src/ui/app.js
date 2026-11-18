const $ = (id) => document.getElementById(id);
let version = null;
const api = async (method, url, body) => {
  const r = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = r.status === 204 ? null : await r.json();
  return { status: r.status, data };
};
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function refreshList() {
  const tag = $('tagfilter').value;
  const { data } = await api('GET', '/api/pages' + (tag ? '?tag=' + encodeURIComponent(tag) : ''));
  $('list').innerHTML = data.map((p) => `<li><a href="#" data-slug="${esc(p.slug)}">${esc(p.title)}</a></li>`).join('');
  const tags = (await api('GET', '/api/tags')).data;
  const cur = $('tagfilter').value;
  $('tagfilter').innerHTML = '<option value="">(all)</option>' + tags.map((t) => `<option value="${esc(t.tag)}">${esc(t.tag)} (${t.count})</option>`).join('');
  $('tagfilter').value = cur;
}
async function open(slug) {
  const { status, data } = await api('GET', '/api/pages/' + encodeURIComponent(slug));
  if (status !== 200) return;
  $('slug').value = data.slug; $('title').value = data.title; $('tags').value = data.tags.join(', ');
  $('body').value = data.body; version = data.version;
  $('preview').innerHTML = data.html;
  $('backlinks').innerHTML = data.backlinks.map((s) => `<a href="#" data-slug="${esc(s)}">${esc(s)}</a>`).join(', ') || '(none)';
  $('status').textContent = 'version ' + version;
  await loadHistory();
}
async function loadHistory() {
  const { status, data } = await api('GET', `/api/pages/${encodeURIComponent($('slug').value)}/history`);
  if (status !== 200) { $('history').innerHTML = ''; return; }
  $('history').innerHTML = data.map((h, i) => `<li>v${h.version} ${esc(h.title)} ${esc(h.updatedAt)}
    <button data-revert="${h.version}">revert</button>${i < data.length - 1 ? ` <button data-diff="${data[i + 1].version},${h.version}">diff with previous</button>` : ''}</li>`).join('');
}
let timer;
$('body').addEventListener('input', () => {
  clearTimeout(timer);
  timer = setTimeout(async () => { $('preview').innerHTML = (await api('POST', '/api/render', { markdown: $('body').value })).data.html; }, 150);
});
$('save').onclick = async () => {
  const slug = $('slug').value.trim();
  const tags = $('tags').value.split(',').map((t) => t.trim()).filter(Boolean);
  const payload = { title: $('title').value, body: $('body').value, tags };
  if (version != null) payload.baseVersion = version;
  const { status, data } = await api('PUT', '/api/pages/' + encodeURIComponent(slug), payload);
  if (status === 409) {
    if (confirm(`Conflict: page is now at version ${data.currentVersion}. Overwrite with your changes?`)) { version = data.currentVersion; return $('save').onclick(); }
    $('status').textContent = 'conflict'; return;
  }
  if (status >= 400) { $('status').textContent = data.message; return; }
  await refreshList(); await open(slug);
};
$('new').onclick = () => { for (const i of ['slug', 'title', 'tags', 'body']) $(i).value = ''; version = null; $('preview').innerHTML = ''; $('status').textContent = 'new'; };
$('tagfilter').onchange = refreshList;
$('search').addEventListener('input', async () => {
  const q = $('search').value.trim();
  if (!q) { $('results').innerHTML = ''; return; }
  const { status, data } = await api('GET', '/api/search?q=' + encodeURIComponent(q));
  $('results').innerHTML = status === 200 ? data.map((r) => `<div><a href="#" data-slug="${esc(r.slug)}">${esc(r.title)}</a><br><small>${r.snippet}</small></div>`).join('') : '';
});
document.body.addEventListener('click', async (e) => {
  const t = e.target;
  if (t.dataset.slug) { e.preventDefault(); open(t.dataset.slug); }
  else if (t.dataset.revert) {
    await api('POST', `/api/pages/${encodeURIComponent($('slug').value)}/revert`, { version: Number(t.dataset.revert) });
    await open($('slug').value); await refreshList();
  } else if (t.dataset.diff) {
    const [a, b] = t.dataset.diff.split(',');
    const { data } = await api('GET', `/api/pages/${encodeURIComponent($('slug').value)}/diff?from=${a}&to=${b}`);
    $('diff').innerHTML = data.lines.map((l) => `<div class="${l.op === '+' ? 'add' : l.op === '-' ? 'del' : ''}">${esc(l.op + ' ' + l.text)}</div>`).join('');
  }
});
refreshList();
