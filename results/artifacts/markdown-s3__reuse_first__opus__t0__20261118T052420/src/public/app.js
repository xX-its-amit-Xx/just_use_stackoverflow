// Single-page editor; talks only to the public JSON API.
const $ = (id) => document.getElementById(id);
const state = { slug: null, version: null };

async function api(method, url, body) {
  const res = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, data };
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const status = (msg) => { $('status').textContent = msg; };

async function loadTags() {
  const { data } = await api('GET', '/api/tags');
  const sel = $('tag-filter'); const cur = sel.value;
  sel.innerHTML = '<option value="">(all)</option>' + (data || []).map((t) => `<option value="${esc(t.tag)}">${esc(t.tag)} (${t.count})</option>`).join('');
  sel.value = cur;
}

async function loadList() {
  const params = new URLSearchParams({ sort: $('sort').value });
  if ($('tag-filter').value) params.set('tag', $('tag-filter').value);
  const { data } = await api('GET', '/api/pages?' + params);
  $('page-list').innerHTML = (data || []).map((p) => `<li data-slug="${esc(p.slug)}" class="${p.slug === state.slug ? 'active' : ''}">${esc(p.title)}</li>`).join('');
}

async function openPage(slug) {
  const { ok, data } = await api('GET', '/api/pages/' + encodeURIComponent(slug));
  if (!ok) { newPage(slug); return; }
  state.slug = data.slug; state.version = data.version;
  $('slug').value = data.slug; $('slug').disabled = true;
  $('title').value = data.title; $('tags').value = data.tags.join(', ');
  $('editor').value = data.body;
  $('preview').innerHTML = data.html;
  $('backlinks').innerHTML = data.backlinks.map((s) => `<li><a href="#${esc(s)}">${esc(s)}</a></li>`).join('') || '<li><em>none</em></li>';
  $('conflict').hidden = true; $('history').hidden = true;
  status(`version ${data.version}`);
  location.hash = data.slug;
  loadList();
}

function newPage(slug = '') {
  state.slug = null; state.version = null;
  $('slug').value = slug; $('slug').disabled = false;
  $('title').value = ''; $('tags').value = ''; $('editor').value = '';
  $('preview').innerHTML = ''; $('backlinks').innerHTML = '';
  $('conflict').hidden = true; $('history').hidden = true;
  status('new page');
}

let previewTimer;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const { ok, data } = await api('POST', '/api/render', { markdown: $('editor').value });
    if (ok) $('preview').innerHTML = data.html;
  }, 200);
}

async function save(force = false) {
  const slug = state.slug || $('slug').value.trim();
  const payload = {
    title: $('title').value, body: $('editor').value,
    tags: $('tags').value.split(',').map((t) => t.trim()).filter(Boolean),
  };
  if (!force) payload.baseVersion = state.version ?? 0;
  const res = await api('PUT', '/api/pages/' + encodeURIComponent(slug), payload);
  if (res.status === 409) {
    $('conflict-version').textContent = res.data.currentVersion;
    $('conflict').hidden = false;
    status('conflict');
    return;
  }
  if (!res.ok) { status('error: ' + (res.data?.message || res.status)); return; }
  status('saved');
  await loadTags();
  await openPage(res.data.slug);
}

async function showHistory() {
  if (!state.slug) return;
  const { data } = await api('GET', `/api/pages/${state.slug}/history`);
  $('history').hidden = false;
  $('diff').innerHTML = '';
  $('history-list').innerHTML = data.map((h) => `<li>v${h.version} — ${esc(h.title)} <small>${esc(h.updatedAt)}</small>
    ${h.version > 1 ? `<button data-diff="${h.version}">diff</button>` : ''}
    <button data-revert="${h.version}">revert</button></li>`).join('');
}

async function showDiff(v) {
  const { data } = await api('GET', `/api/pages/${state.slug}/diff?from=${v - 1}&to=${v}`);
  $('diff').innerHTML = data.lines.map((l) => `<div class="${l.op === '+' ? 'add' : l.op === '-' ? 'del' : ''}">${esc(l.op + ' ' + l.text)}</div>`).join('');
}

async function doSearch() {
  const q = $('search').value.trim();
  if (!q) { $('search-results').innerHTML = ''; return; }
  const { data } = await api('GET', '/api/search?q=' + encodeURIComponent(q));
  $('search-results').innerHTML = (data || []).map((r) => `<li data-slug="${esc(r.slug)}"><strong>${esc(r.title)}</strong><br>${r.snippet}</li>`).join('') || '<li><em>no results</em></li>';
}

$('editor').addEventListener('input', schedulePreview);
$('save').addEventListener('click', () => save(false));
$('conflict-overwrite').addEventListener('click', () => save(true));
$('conflict-reload').addEventListener('click', () => openPage(state.slug));
$('delete').addEventListener('click', async () => {
  if (!state.slug || !confirm('Delete this page?')) return;
  await api('DELETE', '/api/pages/' + state.slug);
  newPage(); loadList(); loadTags();
});
$('show-history').addEventListener('click', showHistory);
$('history-list').addEventListener('click', async (e) => {
  const d = e.target.dataset;
  if (d.diff) showDiff(Number(d.diff));
  if (d.revert) { await api('POST', `/api/pages/${state.slug}/revert`, { version: Number(d.revert) }); openPage(state.slug); }
});
$('new-page').addEventListener('click', () => newPage());
$('tag-filter').addEventListener('change', loadList);
$('sort').addEventListener('change', loadList);
let searchTimer;
$('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(doSearch, 200); });
for (const id of ['page-list', 'search-results']) {
  $(id).addEventListener('click', (e) => { const li = e.target.closest('li[data-slug]'); if (li) openPage(li.dataset.slug); });
}
// Intercept wiki links in the preview to open them in the editor.
$('preview').addEventListener('click', (e) => {
  const a = e.target.closest('a.wikilink');
  if (!a) return;
  e.preventDefault();
  openPage(a.getAttribute('href').replace('/wiki/', ''));
});
window.addEventListener('hashchange', () => { const s = location.hash.slice(1); if (s && s !== state.slug) openPage(s); });

loadTags(); loadList();
if (location.hash.length > 1) openPage(location.hash.slice(1)); else newPage();
