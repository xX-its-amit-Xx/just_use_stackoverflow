// Single-page editor UI. Uses only the public JSON API.
const $ = (id) => document.getElementById(id);
const state = { slug: null, version: null };

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) { const e = new Error(data?.message || res.statusText); e.status = res.status; e.data = data; throw e; }
  return data;
}

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function setStatus(msg, isError = false) { $('status').textContent = msg; $('status').className = isError ? 'error' : ''; }

async function loadTags() {
  const tags = await api('GET', '/api/tags');
  const sel = $('tag-filter'); const cur = sel.value;
  sel.innerHTML = '<option value="">All</option>' + tags.map((t) => `<option value="${esc(t.tag)}">${esc(t.tag)} (${t.count})</option>`).join('');
  sel.value = tags.some((t) => t.tag === cur) ? cur : '';
}

async function loadList() {
  const params = new URLSearchParams({ sort: $('sort').value });
  if ($('tag-filter').value) params.set('tag', $('tag-filter').value);
  const pages = await api('GET', '/api/pages?' + params);
  $('page-list').innerHTML = pages.map((p) =>
    `<li><a href="#/page/${esc(p.slug)}" class="${p.slug === state.slug ? 'active' : ''}">${esc(p.title)}</a></li>`).join('');
}

let previewTimer;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    try { const r = await api('POST', '/api/render', { markdown: $('editor').value }); $('preview').innerHTML = r.html; }
    catch (e) { setStatus('Preview failed: ' + e.message, true); }
  }, 200);
}

function renderBacklinks(list) {
  $('backlinks').innerHTML = (list || []).map((s) => `<li><a href="#/page/${esc(s)}">${esc(s)}</a></li>`).join('') || '<li><em>none</em></li>';
}

async function openPage(slug) {
  $('history').hidden = true;
  try {
    const p = await api('GET', '/api/pages/' + encodeURIComponent(slug));
    state.slug = p.slug; state.version = p.version;
    $('slug').value = p.slug; $('slug').disabled = true;
    $('title').value = p.title; $('tags').value = p.tags.join(', ');
    $('editor').value = p.body; $('preview').innerHTML = p.html;
    renderBacklinks(p.backlinks);
    setStatus(`v${p.version}`);
  } catch (e) {
    if (e.status === 404) { newPage(slug); setStatus('New page'); } else setStatus(e.message, true);
  }
  loadList();
}

function newPage(slug = '') {
  state.slug = null; state.version = null;
  $('slug').value = slug; $('slug').disabled = false;
  $('title').value = ''; $('tags').value = ''; $('editor').value = '';
  $('preview').innerHTML = ''; renderBacklinks([]); $('history').hidden = true;
  setStatus('');
}

async function save() {
  const slug = state.slug || $('slug').value.trim();
  const payload = {
    title: $('title').value,
    body: $('editor').value,
    tags: $('tags').value.split(',').map((t) => t.trim()).filter(Boolean),
  };
  if (state.version != null) payload.baseVersion = state.version;
  try {
    const p = await api('PUT', '/api/pages/' + encodeURIComponent(slug), payload);
    state.slug = p.slug; state.version = p.version; $('slug').disabled = true;
    setStatus(`Saved v${p.version}`);
    if (location.hash !== '#/page/' + p.slug) location.hash = '#/page/' + p.slug;
    await Promise.all([loadTags(), loadList()]);
  } catch (e) {
    if (e.status === 409) {
      const overwrite = confirm(`This page was changed elsewhere (now v${e.data.currentVersion}). Overwrite with your version?\nCancel keeps your text in the editor so you can merge manually.`);
      if (overwrite) { state.version = e.data.currentVersion; return save(); }
      setStatus(`Conflict: server has v${e.data.currentVersion}`, true);
    } else setStatus(e.message, true);
  }
}

async function showHistory() {
  if (!state.slug) return;
  const hist = await api('GET', `/api/pages/${encodeURIComponent(state.slug)}/history`);
  $('history').hidden = false; $('diff').innerHTML = '';
  $('history-list').innerHTML = hist.map((h, i) => {
    const prev = hist[i + 1];
    return `<li>v${h.version} — ${esc(h.title)} <small>${esc(h.updatedAt)}</small>
      ${prev ? `<button data-diff="${prev.version},${h.version}">diff vs v${prev.version}</button>` : ''}
      <button data-revert="${h.version}">revert to this</button></li>`;
  }).join('');
}

$('history-list').addEventListener('click', async (ev) => {
  const t = ev.target;
  if (t.dataset.diff) {
    const [from, to] = t.dataset.diff.split(',');
    const d = await api('GET', `/api/pages/${encodeURIComponent(state.slug)}/diff?from=${from}&to=${to}`);
    $('diff').innerHTML = `<h3>v${d.from} → v${d.to}</h3>` + d.lines.map((l) =>
      `<pre class="diff-line ${l.op === '+' ? 'add' : l.op === '-' ? 'del' : ''}">${esc(l.op + ' ' + l.text)}</pre>`).join('');
  } else if (t.dataset.revert) {
    await api('POST', `/api/pages/${encodeURIComponent(state.slug)}/revert`, { version: Number(t.dataset.revert) });
    await openPage(state.slug); await loadTags();
  }
});

let searchTimer;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const q = $('search').value.trim();
    if (!q) { $('search-results').innerHTML = ''; return; }
    const results = await api('GET', '/api/search?q=' + encodeURIComponent(q));
    $('search-results').innerHTML = results.map((r) =>
      `<div class="result"><a href="#/page/${esc(r.slug)}">${esc(r.title)}</a><br><small>${r.snippet}</small></div>`).join('') || '<em>No results</em>';
  }, 200);
});

$('editor').addEventListener('input', schedulePreview);
$('save').addEventListener('click', save);
$('history-btn').addEventListener('click', showHistory);
$('new-page').addEventListener('click', () => { location.hash = '#/'; newPage(); });
$('delete').addEventListener('click', async () => {
  if (!state.slug || !confirm(`Delete page "${state.slug}"?`)) return;
  await api('DELETE', '/api/pages/' + encodeURIComponent(state.slug));
  location.hash = '#/'; newPage(); await Promise.all([loadTags(), loadList()]);
});
$('tag-filter').addEventListener('change', loadList);
$('sort').addEventListener('change', loadList);
document.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); } });
// Wiki links in the preview navigate inside the SPA.
$('preview').addEventListener('click', (e) => {
  const a = e.target.closest('a.wikilink');
  if (a) { e.preventDefault(); location.hash = '#/page/' + a.getAttribute('href').replace(/^\/wiki\//, ''); }
});

function route() {
  const m = location.hash.match(/^#\/page\/(.+)$/);
  if (m) openPage(decodeURIComponent(m[1])); else { newPage(); loadList(); }
}
window.addEventListener('hashchange', route);
loadTags().then(route);
