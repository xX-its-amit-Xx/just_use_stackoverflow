// Single-page editor UI. Uses only the public JSON API.
const $ = (id) => document.getElementById(id);
const state = { slug: null, version: null, tag: null };

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, data };
}

function status(msg, error = false) {
  const el = $('status');
  el.textContent = msg;
  el.className = 'status' + (error ? ' error' : '');
}

async function loadTags() {
  const { data } = await api('GET', '/api/tags');
  const el = $('tags');
  el.innerHTML = '';
  for (const t of data || []) {
    const span = document.createElement('span');
    span.className = 'tag' + (state.tag === t.tag ? ' active' : '');
    span.textContent = `${t.tag} (${t.count})`;
    span.onclick = () => { state.tag = state.tag === t.tag ? null : t.tag; refreshList(); };
    el.appendChild(span);
  }
}

async function refreshList() {
  const params = new URLSearchParams({ sort: $('sort').value });
  if (state.tag) params.set('tag', state.tag);
  const { data } = await api('GET', '/api/pages?' + params);
  const ul = $('page-list');
  ul.innerHTML = '';
  for (const p of data || []) {
    const li = document.createElement('li');
    li.innerHTML = `<a data-slug="${esc(p.slug)}">${esc(p.title)}</a> ${p.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}`;
    li.querySelector('a').onclick = () => openPage(p.slug);
    ul.appendChild(li);
  }
  loadTags();
}

function fillList(el, items, render) {
  el.innerHTML = '';
  for (const it of items) { const li = document.createElement('li'); li.innerHTML = render(it); el.appendChild(li); }
}

function showMeta(toc, backlinks, links) {
  fillList($('toc'), toc || [], (h) => `<a href="#${esc(h.slug)}" style="padding-left:${(h.level - 1) * 0.7}rem">${esc(h.text)}</a>`);
  if (backlinks) fillList($('backlinks'), backlinks, (s) => `<a data-open="${esc(s)}">${esc(s)}</a>`);
  if (links) fillList($('links'), links, (s) => `<a data-open="${esc(s)}">${esc(s)}</a>`);
}

async function openPage(slug) {
  const { ok, data } = await api('GET', '/api/pages/' + encodeURIComponent(slug));
  $('history').innerHTML = '';
  if (!ok) {
    newPage(slug);
    status(`Page "${slug}" does not exist yet — write it and save.`);
    return;
  }
  state.slug = data.slug; state.version = data.version;
  $('slug').value = data.slug; $('slug').disabled = true;
  $('title').value = data.title;
  $('tags-input').value = data.tags.join(', ');
  $('body').value = data.body;
  $('preview').innerHTML = data.html;
  $('view-link').href = '/wiki/' + data.slug;
  showMeta(data.toc, data.backlinks, data.links);
  status(`Version ${data.version}, updated ${data.updatedAt}`);
}

function newPage(slug = '') {
  state.slug = null; state.version = null;
  $('slug').value = slug; $('slug').disabled = false;
  $('title').value = ''; $('tags-input').value = ''; $('body').value = '';
  $('preview').innerHTML = '';
  showMeta([], [], []);
  status('New page');
}

let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(async () => {
    const { ok, data } = await api('POST', '/api/render', { markdown: $('body').value });
    if (ok) { $('preview').innerHTML = data.html; showMeta(data.toc); }
  }, 200);
}

async function save() {
  const slug = state.slug || $('slug').value.trim();
  const payload = {
    title: $('title').value,
    body: $('body').value,
    tags: $('tags-input').value.split(',').map((t) => t.trim()).filter(Boolean),
  };
  if (state.version !== null) payload.baseVersion = state.version;
  const res = await api('PUT', '/api/pages/' + encodeURIComponent(slug), payload);
  if (res.status === 409) {
    const overwrite = confirm(`This page was changed elsewhere (now version ${res.data.currentVersion}). Overwrite with your text?`);
    if (overwrite) {
      state.version = res.data.currentVersion;
      return save();
    }
    status('Save cancelled because of a conflict. Reload the page to see the latest version.', true);
    return;
  }
  if (!res.ok) { status(res.data ? res.data.message : 'Save failed', true); return; }
  await openPage(res.data.slug);
  status(`Saved version ${res.data.version}`);
  refreshList();
}

async function del() {
  if (!state.slug || !confirm(`Delete "${state.slug}"?`)) return;
  await api('DELETE', '/api/pages/' + encodeURIComponent(state.slug));
  newPage();
  refreshList();
}

async function showHistory() {
  if (!state.slug) return;
  const slug = state.slug;
  const { data } = await api('GET', `/api/pages/${encodeURIComponent(slug)}/history`);
  const el = $('history');
  el.innerHTML = '<h3>History</h3>';
  const ul = document.createElement('ul');
  ul.className = 'plain';
  for (const h of data || []) {
    const li = document.createElement('li');
    li.innerHTML = `v${h.version} — ${esc(h.title)} <small>${esc(h.updatedAt)}</small>
      <button data-a="diff">Diff with current</button> <button data-a="revert">Revert</button>`;
    li.querySelector('[data-a=diff]').onclick = async () => {
      const r = await api('GET', `/api/pages/${encodeURIComponent(slug)}/diff?from=${h.version}&to=${state.version}`);
      const box = document.createElement('div');
      box.className = 'diff';
      box.innerHTML = r.data.lines.map((l) => `<pre class="${l.op === '+' ? 'add' : l.op === '-' ? 'del' : ''}">${esc(l.op + ' ' + l.text)}</pre>`).join('');
      const old = li.querySelector('.diff'); if (old) old.remove();
      li.appendChild(box);
    };
    li.querySelector('[data-a=revert]').onclick = async () => {
      const r = await api('POST', `/api/pages/${encodeURIComponent(slug)}/revert`, { version: h.version });
      if (r.ok) { await openPage(slug); showHistory(); refreshList(); }
    };
    ul.appendChild(li);
  }
  el.appendChild(ul);
}

let searchTimer = null;
function scheduleSearch() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const q = $('search').value.trim();
    const el = $('search-results');
    if (!q) { el.innerHTML = ''; return; }
    const { data } = await api('GET', '/api/search?q=' + encodeURIComponent(q));
    el.innerHTML = '<h3>Search results</h3>' + (data || []).map((r) =>
      `<p><a data-open="${esc(r.slug)}"><strong>${esc(r.title)}</strong></a><br><small>${r.snippet}</small></p>`).join('');
  }, 200);
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a');
  if (!a) return;
  if (a.dataset.open) { e.preventDefault(); openPage(a.dataset.open); return; }
  const href = a.getAttribute('href') || '';
  if (href.startsWith('/wiki/') && a.closest('#preview')) { e.preventDefault(); openPage(decodeURIComponent(href.slice(6))); }
});

$('body').addEventListener('input', schedulePreview);
$('save').onclick = save;
$('delete').onclick = del;
$('history-btn').onclick = showHistory;
$('new-page').onclick = () => newPage();
$('sort').onchange = refreshList;
$('search').addEventListener('input', scheduleSearch);

refreshList();
const initial = new URLSearchParams(location.search).get('page');
if (initial) openPage(initial); else newPage();
