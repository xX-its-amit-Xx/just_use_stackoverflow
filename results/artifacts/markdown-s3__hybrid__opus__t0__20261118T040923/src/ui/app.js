const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const state = { slug: null, version: null };

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, data };
}
const setStatus = (t) => { $('status').textContent = t; };

async function loadList() {
  const tag = $('tag-filter').value;
  const sort = $('sort').value;
  const qs = new URLSearchParams({ sort });
  if (tag) qs.set('tag', tag);
  const { data } = await api('GET', '/api/pages?' + qs);
  $('page-list').innerHTML = (data || []).map((p) =>
    `<li data-slug="${esc(p.slug)}" class="${p.slug === state.slug ? 'active' : ''}">${esc(p.title)}${p.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</li>`).join('');
  const tags = (await api('GET', '/api/tags')).data || [];
  const sel = $('tag-filter');
  sel.innerHTML = '<option value="">(all)</option>' + tags.map((t) => `<option value="${esc(t.tag)}">${esc(t.tag)} (${t.count})</option>`).join('');
  sel.value = tags.some((t) => t.tag === tag) ? tag : '';
}

function fillPanels(page) {
  $('toc').innerHTML = (page.toc || []).map((h) => `<li style="margin-left:${(h.level - 1) * 12}px"><a href="#${esc(h.slug)}">${esc(h.text)}</a></li>`).join('');
  $('backlinks').innerHTML = (page.backlinks || []).map((s) => `<li><a href="#" data-open="${esc(s)}">${esc(s)}</a></li>`).join('') || '<li><em>none</em></li>';
}

async function openPage(slug) {
  const { ok, data } = await api('GET', '/api/pages/' + encodeURIComponent(slug));
  if (!ok) { setStatus(data?.message || 'not found'); return; }
  state.slug = data.slug; state.version = data.version;
  $('slug').value = data.slug; $('title').value = data.title; $('tags').value = data.tags.join(', ');
  $('editor').value = data.body;
  $('preview').innerHTML = data.html;
  $('view-link').href = '/wiki/' + data.slug;
  $('conflict').hidden = true;
  fillPanels(data);
  setStatus(`version ${data.version}`);
  location.hash = '/' + data.slug;
  if (!$('history').hidden) loadHistory();
  loadList();
}

function newPage() {
  state.slug = null; state.version = null;
  for (const id of ['slug', 'title', 'tags', 'editor']) $(id).value = '';
  $('preview').innerHTML = ''; $('toc').innerHTML = ''; $('backlinks').innerHTML = '';
  setStatus('new page');
}

let renderTimer = null;
function schedulePreview() {
  clearTimeout(renderTimer);
  renderTimer = setTimeout(async () => {
    const { data } = await api('POST', '/api/render', { markdown: $('editor').value });
    if (data) { $('preview').innerHTML = data.html; $('toc').innerHTML = (data.toc || []).map((h) => `<li style="margin-left:${(h.level - 1) * 12}px">${esc(h.text)}</li>`).join(''); }
  }, 250);
}

async function save(force) {
  const slug = $('slug').value.trim();
  const body = {
    title: $('title').value,
    body: $('editor').value,
    tags: $('tags').value.split(',').map((t) => t.trim()).filter(Boolean),
  };
  if (force && state.conflictVersion) body.baseVersion = state.conflictVersion;
  else if (state.slug === slug && state.version) body.baseVersion = state.version;
  const res = await api('PUT', '/api/pages/' + encodeURIComponent(slug), body);
  if (res.status === 409) {
    state.conflictVersion = res.data.currentVersion;
    $('conflict-version').textContent = res.data.currentVersion;
    $('conflict').hidden = false;
    setStatus('conflict');
    return;
  }
  if (!res.ok) { setStatus(res.data?.message || 'error'); return; }
  state.conflictVersion = null;
  await openPage(slug);
  setStatus(`saved (version ${res.data.version})`);
}

async function loadHistory() {
  if (!state.slug) return;
  const { data } = await api('GET', `/api/pages/${state.slug}/history`);
  const list = data || [];
  $('history-list').innerHTML = list.map((h) => `<li>v${h.version} — ${esc(h.title)} <small>${esc(h.updatedAt)}</small> <button data-revert="${h.version}">Revert to</button></li>`).join('');
  const opts = list.map((h) => `<option value="${h.version}">v${h.version}</option>`).join('');
  $('diff-from').innerHTML = opts; $('diff-to').innerHTML = opts;
  if (list.length > 1) $('diff-from').value = list[1].version;
}

async function showDiff() {
  const { ok, data } = await api('GET', `/api/pages/${state.slug}/diff?from=${$('diff-from').value}&to=${$('diff-to').value}`);
  if (!ok) { $('diff-output').textContent = data?.message || 'error'; return; }
  $('diff-output').innerHTML = data.lines.map((l) =>
    `<span class="${l.op === '+' ? 'diff-add' : l.op === '-' ? 'diff-del' : ''}">${esc(l.op + ' ' + l.text)}</span>`).join('');
}

let searchTimer = null;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const q = $('search').value.trim();
    if (!q) { $('search-results').innerHTML = ''; return; }
    const { data } = await api('GET', '/api/search?q=' + encodeURIComponent(q));
    $('search-results').innerHTML = (data || []).map((r) => `<div class="result" data-slug="${esc(r.slug)}"><strong>${esc(r.title)}</strong><br>${r.snippet}</div>`).join('') || '<em>no results</em>';
  }, 200);
});
$('search-results').addEventListener('click', (e) => { const el = e.target.closest('[data-slug]'); if (el) openPage(el.dataset.slug); });
$('page-list').addEventListener('click', (e) => { const el = e.target.closest('[data-slug]'); if (el) openPage(el.dataset.slug); });
$('backlinks').addEventListener('click', (e) => { const el = e.target.closest('[data-open]'); if (el) { e.preventDefault(); openPage(el.dataset.open); } });
$('preview').addEventListener('click', (e) => {
  const a = e.target.closest('a.wikilink');
  if (!a) return;
  e.preventDefault();
  const slug = a.getAttribute('href').replace('/wiki/', '');
  if (a.classList.contains('missing')) { newPage(); $('slug').value = slug; $('title').value = a.textContent; }
  else openPage(slug);
});
$('tag-filter').addEventListener('change', loadList);
$('sort').addEventListener('change', loadList);
$('editor').addEventListener('input', schedulePreview);
$('save').addEventListener('click', () => save(false));
$('new-page').addEventListener('click', newPage);
$('delete').addEventListener('click', async () => {
  if (!state.slug || !confirm(`Delete ${state.slug}?`)) return;
  await api('DELETE', '/api/pages/' + state.slug);
  newPage(); loadList();
});
$('history-btn').addEventListener('click', () => { $('history').hidden = !$('history').hidden; if (!$('history').hidden) loadHistory(); });
$('history-list').addEventListener('click', async (e) => {
  const v = e.target.dataset.revert;
  if (!v) return;
  const res = await api('POST', `/api/pages/${state.slug}/revert`, { version: Number(v) });
  if (res.ok) openPage(state.slug);
});
$('diff-btn').addEventListener('click', showDiff);
$('conflict-reload').addEventListener('click', () => openPage(state.slug));
$('conflict-overwrite').addEventListener('click', () => save(true));

loadList();
const initial = location.hash.replace(/^#\/?/, '');
if (initial) openPage(initial); else newPage();
