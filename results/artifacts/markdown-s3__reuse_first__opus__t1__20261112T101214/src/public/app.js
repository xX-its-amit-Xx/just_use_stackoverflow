// Single-page editor; uses only the public JSON API.
const $ = (id) => document.getElementById(id);
const state = { slug: null, version: null };

async function api(method, url, body) {
  const res = await fetch(url, {
    method, headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) { const e = new Error((data && data.message) || res.statusText); e.status = res.status; e.data = data; throw e; }
  return data;
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function status(msg, err = false) { const s = $('status'); s.textContent = msg; s.className = err ? 'error' : ''; }

async function loadTags() {
  const tags = await api('GET', '/api/tags');
  const sel = $('tag-filter'), cur = sel.value;
  sel.innerHTML = '<option value="">All tags</option>' + tags.map((t) => `<option value="${esc(t.tag)}">${esc(t.tag)} (${t.count})</option>`).join('');
  sel.value = cur;
}
async function loadList() {
  const qs = new URLSearchParams({ sort: $('sort').value });
  if ($('tag-filter').value) qs.set('tag', $('tag-filter').value);
  const pages = await api('GET', '/api/pages?' + qs);
  $('page-list').innerHTML = pages.map((p) => `<li data-slug="${esc(p.slug)}" class="${p.slug === state.slug ? 'active' : ''}">${esc(p.title)}${p.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</li>`).join('');
}
async function refreshSidebar() { await Promise.all([loadTags(), loadList()]); }

let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    try { const r = await api('POST', '/api/render', { markdown: $('editor').value }); $('preview').innerHTML = r.html; } catch (e) { status(e.message, true); }
  }, 200);
}

function newPage(slug = '') {
  state.slug = null; state.version = null;
  $('slug').value = slug; $('slug').disabled = false;
  $('title').value = ''; $('tags').value = ''; $('editor').value = '';
  $('preview').innerHTML = ''; $('backlinks').innerHTML = ''; $('history').hidden = true;
  $('view-link').removeAttribute('href');
  status('New page');
}

async function openPage(slug) {
  try {
    const p = await api('GET', '/api/pages/' + encodeURIComponent(slug));
    state.slug = p.slug; state.version = p.version;
    $('slug').value = p.slug; $('slug').disabled = true;
    $('title').value = p.title; $('tags').value = p.tags.join(', '); $('editor').value = p.body;
    $('preview').innerHTML = p.html;
    $('view-link').href = '/wiki/' + p.slug;
    $('backlinks').innerHTML = p.backlinks.map((b) => `<li data-slug="${esc(b)}">${esc(b)}</li>`).join('') || '<li><em>none</em></li>';
    $('history').hidden = true;
    location.hash = 'page/' + p.slug;
    status(`Version ${p.version}`);
    loadList();
  } catch (e) {
    if (e.status === 404) { newPage(slug); } else status(e.message, true);
  }
}

async function save(force = false) {
  const slug = $('slug').value.trim();
  const body = { title: $('title').value, body: $('editor').value, tags: $('tags').value.split(',').map((t) => t.trim()).filter(Boolean) };
  if (state.slug && !force) body.baseVersion = state.version;
  try {
    const p = await api('PUT', '/api/pages/' + encodeURIComponent(slug), body);
    state.slug = p.slug; state.version = p.version;
    status(`Saved (version ${p.version})`);
    await refreshSidebar();
    await openPage(p.slug);
  } catch (e) {
    if (e.status === 409) {
      if (confirm(`Conflict: the page was changed elsewhere (now version ${e.data.currentVersion}). Overwrite with your text?`)) return save(true);
      status('Conflict — reload the page to see the latest version', true);
    } else status(e.message, true);
  }
}

async function showHistory() {
  if (!state.slug) return;
  const h = await api('GET', `/api/pages/${state.slug}/history`);
  $('history').hidden = false;
  $('history-list').innerHTML = h.map((v) => `<li>v${v.version} — ${esc(v.title)} <small>${esc(v.updatedAt)}</small></li>`).join('');
  const opts = h.map((v) => `<option value="${v.version}">v${v.version}</option>`).join('');
  $('diff-from').innerHTML = opts; $('diff-to').innerHTML = opts;
  if (h.length > 1) $('diff-from').value = h[1].version;
  $('diff').innerHTML = '';
}
async function showDiff() {
  const d = await api('GET', `/api/pages/${state.slug}/diff?from=${$('diff-from').value}&to=${$('diff-to').value}`);
  $('diff').innerHTML = d.lines.map((l) => `<span class="${l.op === '+' ? 'add' : l.op === '-' ? 'del' : ''}">${esc(l.op + ' ' + l.text)}</span>`).join('\n');
}
async function revert() {
  try {
    await api('POST', `/api/pages/${state.slug}/revert`, { version: Number($('diff-from').value) });
    await refreshSidebar(); await openPage(state.slug);
  } catch (e) { status(e.message, true); }
}

let searchTimer = null;
function doSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const q = $('search').value.trim();
    if (!q) { $('search-results').innerHTML = ''; return; }
    const r = await api('GET', '/api/search?q=' + encodeURIComponent(q));
    $('search-results').innerHTML = r.map((x) => `<li data-slug="${esc(x.slug)}"><strong>${esc(x.title)}</strong><br><small>${x.snippet}</small></li>`).join('') || '<li><em>no results</em></li>';
  }, 200);
}

function onListClick(e) { const li = e.target.closest('li[data-slug]'); if (li) openPage(li.dataset.slug); }
$('page-list').addEventListener('click', onListClick);
$('search-results').addEventListener('click', onListClick);
$('backlinks').addEventListener('click', onListClick);
$('preview').addEventListener('click', (e) => {
  const a = e.target.closest('a.wikilink'); if (!a) return;
  e.preventDefault(); openPage(a.getAttribute('href').replace('/wiki/', ''));
});
$('editor').addEventListener('input', schedulePreview);
$('search').addEventListener('input', doSearch);
$('tag-filter').addEventListener('change', loadList);
$('sort').addEventListener('change', loadList);
$('new-page').addEventListener('click', () => newPage());
$('save').addEventListener('click', () => save());
$('history-btn').addEventListener('click', showHistory);
$('diff-btn').addEventListener('click', showDiff);
$('revert-btn').addEventListener('click', revert);
$('delete').addEventListener('click', async () => {
  if (!state.slug || !confirm(`Delete page "${state.slug}"?`)) return;
  await api('DELETE', '/api/pages/' + state.slug); newPage(); refreshSidebar();
});
document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); } });

refreshSidebar();
const m = location.hash.match(/^#(?:page|edit)\/(.+)$/);
if (m) openPage(decodeURIComponent(m[1])); else newPage();
