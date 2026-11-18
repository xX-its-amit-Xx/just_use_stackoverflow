// Single-page editor. Uses only the public HTTP API.

const $ = (id) => document.getElementById(id);
const api = async (method, url, body) => {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return { status: res.status, data: null };
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
};
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const state = {
  slug: null, // currently open page slug (null = new page)
  version: 0, // version the editor is based on (0 for new)
  loadedTitle: '', loadedBody: '', loadedTags: '',
  creating: false,
};

function setStatus(msg) {
  $('status').textContent = msg;
}

function isDirty() {
  return $('title').value !== state.loadedTitle || $('editor').value !== state.loadedBody || $('tags').value !== state.loadedTags;
}

// ---- page list ----
async function loadTags() {
  const { data } = await api('GET', '/api/tags');
  const sel = $('tag-filter');
  const current = sel.value;
  sel.innerHTML = '<option value="">All tags</option>' +
    data.map((t) => `<option value="${esc(t.tag)}">${esc(t.tag)} (${t.count})</option>`).join('');
  sel.value = current;
}

async function loadList() {
  const params = new URLSearchParams();
  if ($('tag-filter').value) params.set('tag', $('tag-filter').value);
  params.set('sort', $('sort').value);
  const { data } = await api('GET', `/api/pages?${params}`);
  const ul = $('page-list');
  ul.innerHTML = '';
  for (const p of data) {
    const li = document.createElement('li');
    li.dataset.slug = p.slug;
    if (p.slug === state.slug) li.classList.add('active');
    li.innerHTML = `${esc(p.title)}<span class="meta">${esc(p.slug)} · v${p.version}</span>`;
    li.addEventListener('click', () => openPage(p.slug));
    ul.appendChild(li);
  }
}

// ---- open / new / save / delete ----
function fillEditor(page) {
  $('title').value = page.title;
  $('editor').value = page.body;
  $('tags').value = page.tags.join(', ');
  state.loadedTitle = page.title;
  state.loadedBody = page.body;
  state.loadedTags = $('tags').value;
}

function parseTags(text) {
  return text.split(',').map((t) => t.trim()).filter(Boolean);
}

async function openPage(slug) {
  if (isDirty() && !confirm('Discard unsaved changes?')) return;
  const { status, data } = await api('GET', `/api/pages/${encodeURIComponent(slug)}`);
  if (status !== 200) {
    setStatus(`Could not open ${slug} (${status})`);
    return;
  }
  state.slug = data.slug;
  state.version = data.version;
  state.creating = false;
  $('new-slug-row').hidden = true;
  fillEditor(data);
  $('view-link').href = `/wiki/${encodeURIComponent(data.slug)}`;
  $('view-link').hidden = false;
  $('conflict').hidden = true;
  setStatus(`Version ${data.version} · updated ${new Date(data.updatedAt).toLocaleString()}`);
  renderPanels(data);
  await Promise.all([loadList(), updatePreview()]);
}

function newPage() {
  if (isDirty() && !confirm('Discard unsaved changes?')) return;
  state.slug = null;
  state.version = 0;
  state.creating = true;
  fillEditor({ title: '', body: '', tags: [] });
  $('new-slug-row').hidden = false;
  $('new-slug').value = '';
  $('view-link').hidden = true;
  $('conflict').hidden = true;
  setStatus('New page (not saved)');
  renderPanels(null);
  updatePreview();
  loadList();
  $('title').focus();
}

async function save(force = false) {
  const slug = state.creating ? $('new-slug').value.trim() : state.slug;
  if (!slug) {
    setStatus('A slug is required for a new page');
    return;
  }
  const payload = { title: $('title').value, body: $('editor').value, tags: parseTags($('tags').value) };
  if (!force) payload.baseVersion = state.version;
  const { status, data } = await api('PUT', `/api/pages/${encodeURIComponent(slug)}`, payload);
  if (status === 409) {
    $('conflict-version').textContent = data.currentVersion;
    $('conflict').hidden = false;
    setStatus('Save failed: conflict');
    return;
  }
  if (status !== 200 && status !== 201) {
    setStatus(`Save failed: ${data && data.message ? data.message : status}`);
    return;
  }
  state.slug = data.slug;
  state.creating = false;
  state.version = data.version;
  $('new-slug-row').hidden = true;
  $('conflict').hidden = true;
  fillEditor(data);
  $('view-link').href = `/wiki/${encodeURIComponent(data.slug)}`;
  $('view-link').hidden = false;
  setStatus(`Saved version ${data.version}`);
  await openPageDetails(data.slug);
  await Promise.all([loadList(), loadTags()]);
}

async function openPageDetails(slug) {
  const { data } = await api('GET', `/api/pages/${encodeURIComponent(slug)}`);
  renderPanels(data);
  $('preview').innerHTML = data.html;
}

async function deletePage() {
  if (!state.slug) return;
  if (!confirm(`Delete "${state.slug}" and its history?`)) return;
  const { status } = await api('DELETE', `/api/pages/${encodeURIComponent(state.slug)}`);
  if (status !== 204) {
    setStatus(`Delete failed (${status})`);
    return;
  }
  state.slug = null;
  state.creating = false;
  fillEditor({ title: '', body: '', tags: [] });
  $('view-link').hidden = true;
  setStatus('Deleted');
  renderPanels(null);
  $('preview').innerHTML = '';
  await Promise.all([loadList(), loadTags()]);
}

// ---- preview ----
let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(updatePreview, 250);
}
async function updatePreview() {
  const { status, data } = await api('POST', '/api/render', { markdown: $('editor').value });
  if (status === 200) $('preview').innerHTML = data.html;
}

// ---- side panels ----
function renderPanels(page) {
  const fill = (id, items, render) => {
    const ul = $(id);
    ul.innerHTML = '';
    if (!items || items.length === 0) {
      const li = document.createElement('li');
      li.textContent = '—';
      ul.appendChild(li);
      return;
    }
    for (const it of items) ul.appendChild(render(it));
  };
  const pageLink = (slug) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.textContent = slug;
    a.addEventListener('click', () => openPage(slug));
    li.appendChild(a);
    return li;
  };
  fill('backlinks', page && page.backlinks, pageLink);
  fill('links', page && page.links, pageLink);
  fill('toc', page && page.toc, (h) => {
    const li = document.createElement('li');
    li.style.marginLeft = `${(h.level - 1) * 0.8}rem`;
    const a = document.createElement('a');
    a.href = `#${h.slug}`;
    a.textContent = h.text;
    li.appendChild(a);
    return li;
  });
  loadHistory();
}

async function loadHistory() {
  const ul = $('history');
  const fromSel = $('diff-from');
  const toSel = $('diff-to');
  fromSel.innerHTML = '';
  toSel.innerHTML = '';
  ul.innerHTML = '';
  $('diff').innerHTML = '';
  if (!state.slug) return;
  const { data } = await api('GET', `/api/pages/${encodeURIComponent(state.slug)}/history`);
  if (!Array.isArray(data)) return;
  for (const v of data) {
    const li = document.createElement('li');
    li.textContent = `v${v.version} — ${v.title} (${new Date(v.updatedAt).toLocaleString()}) `;
    const view = document.createElement('a');
    view.textContent = 'view';
    view.addEventListener('click', () => showVersion(v.version));
    li.appendChild(view);
    ul.appendChild(li);
    for (const sel of [fromSel, toSel]) {
      const opt = document.createElement('option');
      opt.value = v.version;
      opt.textContent = `v${v.version}`;
      sel.appendChild(opt);
    }
  }
  // default: compare previous version (from) with latest (to)
  if (data.length >= 2) fromSel.value = data[1].version;
  if (data.length >= 1) toSel.value = data[0].version;
}

async function showVersion(n) {
  const { data } = await api('GET', `/api/pages/${encodeURIComponent(state.slug)}/versions/${n}`);
  $('diff').textContent = `--- version ${data.version} ---\n${data.body}`;
}

async function showDiff() {
  if (!state.slug) return;
  const from = $('diff-from').value;
  const to = $('diff-to').value;
  if (!from || !to) return;
  const { status, data } = await api('GET', `/api/pages/${encodeURIComponent(state.slug)}/diff?from=${from}&to=${to}`);
  if (status !== 200) {
    $('diff').textContent = `Diff failed (${status})`;
    return;
  }
  const pre = $('diff');
  pre.innerHTML = '';
  for (const l of data.lines) {
    const span = document.createElement('span');
    span.className = l.op === '+' ? 'add' : l.op === '-' ? 'del' : 'ctx';
    span.textContent = `${l.op} ${l.text}`;
    pre.appendChild(span);
  }
}

async function revert() {
  if (!state.slug) return;
  const version = Number($('diff-from').value);
  if (!version) return;
  if (!confirm(`Revert "${state.slug}" to version ${version}? This creates a new version.`)) return;
  const { status, data } = await api('POST', `/api/pages/${encodeURIComponent(state.slug)}/revert`, { version });
  if (status !== 200) {
    setStatus(`Revert failed (${status})`);
    return;
  }
  await openPage(state.slug);
  setStatus(`Reverted to version ${version}; now version ${data.version}`);
}

// ---- search ----
let searchTimer = null;
$('search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 200);
});
async function runSearch() {
  const q = $('search').value.trim();
  const box = $('search-results');
  if (!q) {
    box.hidden = true;
    return;
  }
  const { status, data } = await api('GET', `/api/search?q=${encodeURIComponent(q)}`);
  box.innerHTML = '';
  if (status !== 200) return;
  for (const r of data) {
    const a = document.createElement('a');
    a.innerHTML = `<strong>${esc(r.title)}</strong> <small>${esc(r.slug)}</small><div class="snippet">${r.snippet}</div>`;
    a.addEventListener('click', () => {
      box.hidden = true;
      $('search').value = '';
      openPage(r.slug);
    });
    box.appendChild(a);
  }
  if (data.length === 0) box.textContent = 'No matches';
  box.hidden = false;
}

// ---- wiring ----
$('save').addEventListener('click', () => save(false));
$('new-page').addEventListener('click', newPage);
$('delete').addEventListener('click', deletePage);
$('conflict-reload').addEventListener('click', () => state.slug && openPage(state.slug));
$('conflict-overwrite').addEventListener('click', async () => {
  // Re-base on the current server version, then save with our content.
  const { data } = await api('GET', `/api/pages/${encodeURIComponent(state.slug)}`);
  state.version = data.version;
  await save(false);
});
$('editor').addEventListener('input', schedulePreview);
$('title').addEventListener('input', () => setStatus(isDirty() ? 'Unsaved changes' : ''));
$('editor').addEventListener('input', () => setStatus(isDirty() ? 'Unsaved changes' : ''));
$('tag-filter').addEventListener('change', loadList);
$('sort').addEventListener('change', loadList);
$('diff-show').addEventListener('click', showDiff);
$('revert').addEventListener('click', revert);
$('preview').addEventListener('click', (ev) => {
  const a = ev.target.closest('a');
  if (!a) return;
  const href = a.getAttribute('href') || '';
  if (href.startsWith('/wiki/')) {
    ev.preventDefault();
    openPage(decodeURIComponent(href.slice('/wiki/'.length)));
  }
});
window.addEventListener('keydown', (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key === 's') {
    ev.preventDefault();
    save(false);
  }
});

(async function init() {
  await loadTags();
  await loadList();
  const first = await api('GET', '/api/pages?sort=title');
  if (Array.isArray(first.data) && first.data.length) await openPage(first.data[0].slug);
  else newPage();
})();
