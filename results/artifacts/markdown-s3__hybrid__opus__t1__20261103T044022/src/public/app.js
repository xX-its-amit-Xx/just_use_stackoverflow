// Single-page editor. Uses only the public JSON API.
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const state = { slug: null, version: null, dirty: false };

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) { const e = new Error((data && data.message) || res.statusText); e.status = res.status; e.data = data; throw e; }
  return data;
}

function setStatus(msg) { $('status').textContent = msg; }

async function loadList() {
  const tag = $('tag-filter').value;
  const sort = $('sort').value;
  const qs = new URLSearchParams({ sort }); if (tag) qs.set('tag', tag);
  const [pages, tags] = await Promise.all([api('GET', '/api/pages?' + qs), api('GET', '/api/tags')]);
  $('page-list').innerHTML = pages.map((p) => `<li data-slug="${esc(p.slug)}" class="${p.slug === state.slug ? 'active' : ''}">${esc(p.title)}${p.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</li>`).join('') || '<li><em>No pages</em></li>';
  const sel = $('tag-filter');
  sel.innerHTML = '<option value="">All tags</option>' + tags.map((t) => `<option value="${esc(t.tag)}">${esc(t.tag)} (${t.count})</option>`).join('');
  sel.value = tag;
}

let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(updatePreview, 200);
}
async function updatePreview() {
  try {
    const { html, toc } = await api('POST', '/api/render', { markdown: $('body').value });
    $('preview').innerHTML = html;
    $('toc').innerHTML = toc.map((h) => `<li style="margin-left:${(h.level - 1)}em"><a href="#${esc(h.slug)}" data-anchor="${esc(h.slug)}">${esc(h.text)}</a></li>`).join('');
  } catch (e) { setStatus('Preview failed: ' + e.message); }
}

function fillEditor(page) {
  state.slug = page ? page.slug : null;
  state.version = page ? page.version : null;
  state.dirty = false;
  $('slug').value = page ? page.slug : '';
  $('slug').readOnly = !!page;
  $('title').value = page ? page.title : '';
  $('tags').value = page ? page.tags.join(', ') : '';
  $('body').value = page ? page.body : '';
  $('backlinks').innerHTML = page ? (page.backlinks.map((s) => `<li><a href="#page/${esc(s)}">${esc(s)}</a></li>`).join('') || '<li><em>none</em></li>') : '';
  $('view-link').href = page ? '/wiki/' + encodeURIComponent(page.slug) : '#';
  $('conflict').hidden = true;
  setStatus(page ? `Version ${page.version}` : 'New page');
  updatePreview();
}

async function openPage(slug) {
  try {
    const page = await api('GET', '/api/pages/' + encodeURIComponent(slug));
    fillEditor(page);
  } catch (e) {
    if (e.status === 404) { fillEditor(null); $('slug').value = slug; $('title').value = slug; setStatus('New page'); }
    else setStatus(e.message);
  }
  showHistory(false);
  loadList();
}

async function save(force = false) {
  const slug = $('slug').value.trim();
  const payload = {
    title: $('title').value,
    body: $('body').value,
    tags: $('tags').value.split(',').map((t) => t.trim()).filter(Boolean),
  };
  if (state.slug && state.version != null && !force) payload.baseVersion = state.version;
  try {
    const page = await api('PUT', '/api/pages/' + encodeURIComponent(slug), payload);
    state.slug = page.slug; state.version = page.version; state.dirty = false;
    $('slug').readOnly = true;
    $('conflict').hidden = true;
    setStatus(`Saved — version ${page.version}`);
    if (location.hash !== '#page/' + page.slug) location.hash = 'page/' + page.slug;
    else await openPage(page.slug);
  } catch (e) {
    if (e.status === 409) {
      $('conflict-version').textContent = e.data.currentVersion;
      $('conflict').hidden = false;
      setStatus('Conflict');
    } else setStatus('Save failed: ' + e.message);
  }
}

function showHistory(on) {
  $('history-view').hidden = !on;
  $('editor-view').hidden = on;
}

async function openHistory() {
  if (!state.slug) return;
  const hist = await api('GET', `/api/pages/${encodeURIComponent(state.slug)}/history`);
  $('history-list').innerHTML = hist.map((h) => `<li>v${h.version} — ${esc(h.title)} <small>${esc(h.updatedAt)}</small> <button data-revert="${h.version}">Revert to this</button></li>`).join('');
  const opts = hist.map((h) => `<option value="${h.version}">v${h.version}</option>`).join('');
  $('diff-from').innerHTML = opts; $('diff-to').innerHTML = opts;
  $('diff-to').value = String(hist[0].version);
  $('diff-from').value = String(hist[1] ? hist[1].version : hist[0].version);
  $('diff').innerHTML = '';
  showHistory(true);
  showDiff();
}

async function showDiff() {
  const d = await api('GET', `/api/pages/${encodeURIComponent(state.slug)}/diff?from=${$('diff-from').value}&to=${$('diff-to').value}`);
  $('diff').innerHTML = d.lines.map((l) => `<span class="${l.op === '+' ? 'add' : l.op === '-' ? 'del' : 'same'}">${esc(l.op + ' ' + l.text)}</span>`).join('');
}

async function doSearch(q) {
  if (!q.trim()) { $('search-results').hidden = true; return; }
  const results = await api('GET', '/api/search?q=' + encodeURIComponent(q));
  $('results-list').innerHTML = results.map((r) => `<li data-slug="${esc(r.slug)}"><strong>${esc(r.title)}</strong><br><small>${r.snippet}</small></li>`).join('') || '<li><em>No matches</em></li>';
  $('search-results').hidden = false;
}

function route() {
  const h = location.hash.replace(/^#/, '');
  const m = h.match(/^(?:page|edit)\/(.+)$/);
  if (m) openPage(decodeURIComponent(m[1]));
  else { fillEditor(null); loadList(); showHistory(false); }
}

$('body').addEventListener('input', () => { state.dirty = true; schedulePreview(); });
$('save').addEventListener('click', () => save(false));
$('conflict-reload').addEventListener('click', () => openPage(state.slug));
$('conflict-overwrite').addEventListener('click', () => save(true));
$('delete').addEventListener('click', async () => {
  if (!state.slug || !confirm('Delete this page and its history?')) return;
  await api('DELETE', '/api/pages/' + encodeURIComponent(state.slug));
  location.hash = '';
  fillEditor(null); loadList();
});
$('new-page').addEventListener('click', () => { location.hash = ''; fillEditor(null); });
$('history-btn').addEventListener('click', openHistory);
$('history-close').addEventListener('click', () => showHistory(false));
$('diff-btn').addEventListener('click', showDiff);
$('history-list').addEventListener('click', async (ev) => {
  const v = ev.target.dataset && ev.target.dataset.revert;
  if (!v) return;
  await api('POST', `/api/pages/${encodeURIComponent(state.slug)}/revert`, { version: Number(v) });
  await openPage(state.slug);
});
$('tag-filter').addEventListener('change', loadList);
$('sort').addEventListener('change', loadList);
for (const id of ['page-list', 'results-list']) {
  $(id).addEventListener('click', (ev) => {
    const li = ev.target.closest('li[data-slug]');
    if (li) location.hash = 'page/' + li.dataset.slug;
  });
}
let searchTimer;
$('search').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => doSearch($('search').value), 250); });
$('search-form').addEventListener('submit', (ev) => { ev.preventDefault(); doSearch($('search').value); });
$('preview').addEventListener('click', (ev) => {
  const a = ev.target.closest('a.wikilink');
  if (a) { ev.preventDefault(); location.hash = 'page/' + a.getAttribute('href').replace('/wiki/', ''); }
});
window.addEventListener('hashchange', route);
route();
