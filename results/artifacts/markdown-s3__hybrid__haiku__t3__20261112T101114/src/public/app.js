// Single-page editor for the markdown wiki. Uses only the public /api routes.
const $ = (sel) => document.querySelector(sel);
const view = $('#view');
const notice = $('#notice');

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  if (res.status !== 204) {
    try {
      data = await res.json();
    } catch {
      data = null;
    }
  }
  return { ok: res.ok, status: res.status, data };
}

function flash(text, kind = '') {
  notice.textContent = text;
  notice.className = kind;
  notice.hidden = false;
  clearTimeout(flash.timer);
  flash.timer = setTimeout(() => (notice.hidden = true), 4000);
}

// ---------- sidebar ----------

let currentSlug = null;
let sidebarSearch = '';

async function loadTags() {
  const { data } = await api('GET', '/api/tags');
  const select = $('#tag-filter');
  const selected = select.value;
  select.innerHTML = '<option value="">All tags</option>' +
    (data || []).map((t) => `<option value="${esc(t.tag)}">${esc(t.tag)} (${t.count})</option>`).join('');
  select.value = selected;
}

async function loadList() {
  const tag = $('#tag-filter').value;
  const sort = $('#sort').value;
  const list = $('#page-list');
  if (sidebarSearch) {
    const { data } = await api('GET', `/api/search?q=${encodeURIComponent(sidebarSearch)}`);
    list.innerHTML = (data || []).map((r) => `
      <li data-slug="${esc(r.slug)}" class="${r.slug === currentSlug ? 'active' : ''}">
        <a href="#/page/${encodeURIComponent(r.slug)}">${esc(r.title)}</a>
        <div class="snippet">${r.snippet}</div>
      </li>`).join('') || '<li class="meta">No matches</li>';
    return;
  }
  const qs = new URLSearchParams({ sort });
  if (tag) qs.set('tag', tag);
  const { data } = await api('GET', `/api/pages?${qs}`);
  list.innerHTML = (data || []).map((p) => `
    <li data-slug="${esc(p.slug)}" class="${p.slug === currentSlug ? 'active' : ''}">
      <a href="#/page/${encodeURIComponent(p.slug)}">${esc(p.title)}</a>
      <div class="meta">${esc(p.slug)} · v${p.version}</div>
    </li>`).join('') || '<li class="meta">No pages yet</li>';
}

// ---------- views ----------

function tagsHtml(tags) {
  return tags.length ? `<div class="tags">${tags.map((t) => `<span>${esc(t)}</span>`).join('')}</div>` : '';
}

function backlinksHtml(page) {
  const back = page.backlinks.length
    ? `<ul>${page.backlinks.map((s) => `<li><a href="#/page/${encodeURIComponent(s)}">${esc(s)}</a></li>`).join('')}</ul>`
    : '<p class="meta">No pages link here.</p>';
  const links = page.links.length
    ? `<ul>${page.links.map((s) => `<li><a href="#/page/${encodeURIComponent(s)}">${esc(s)}</a></li>`).join('')}</ul>`
    : '<p class="meta">No wiki links.</p>';
  return `
    <div class="panel"><h3>Backlinks</h3>${back}</div>
    <div class="panel"><h3>Links from this page</h3>${links}</div>`;
}

async function showPage(slug) {
  currentSlug = slug;
  const { ok, status, data } = await api('GET', `/api/pages/${encodeURIComponent(slug)}`);
  if (!ok) {
    view.innerHTML = `<h2>Not found</h2><p>${status === 404 ? 'This page does not exist.' : esc(data?.message || '')}</p>`;
    return;
  }
  view.innerHTML = `
    <div class="toolbar">
      <a href="#/edit/${encodeURIComponent(slug)}"><button type="button">Edit</button></a>
      <a href="#/history/${encodeURIComponent(slug)}"><button type="button">History</button></a>
      <a href="/wiki/${encodeURIComponent(slug)}" target="_blank"><button type="button">Standalone</button></a>
      <button type="button" id="delete-page">Delete</button>
    </div>
    <h2>${esc(data.title)}</h2>
    ${tagsHtml(data.tags)}
    <div class="article">${data.html}</div>
    ${backlinksHtml(data)}`;
  $('#delete-page').onclick = async () => {
    if (!confirm(`Delete "${data.title}" and its history?`)) return;
    const del = await api('DELETE', `/api/pages/${encodeURIComponent(slug)}`);
    if (del.status === 204) {
      flash('Page deleted', 'ok');
      location.hash = '#/';
    } else {
      flash('Delete failed', 'error');
    }
  };
  loadList();
}

// Editor state: the version we loaded (baseVersion) and what the user typed.
function showEditor({ slug, page, isNew }) {
  currentSlug = slug;
  const title = page?.title ?? '';
  const body = page?.body ?? '';
  const tags = (page?.tags ?? []).join(', ');
  view.innerHTML = `
    <h2>${isNew ? 'New page' : 'Edit page'}</h2>
    <div class="field">
      <label>Slug <input id="f-slug" ${isNew ? '' : 'disabled'} value="${esc(slug || '')}" placeholder="my-page"></label>
    </div>
    <div class="field"><label>Title <input id="f-title" value="${esc(title)}" maxlength="200"></label></div>
    <div class="field"><label>Tags (comma separated) <input id="f-tags" value="${esc(tags)}"></label></div>
    <div class="edit-grid">
      <textarea id="f-body" spellcheck="false">${esc(body)}</textarea>
      <div id="preview" class="preview article"></div>
    </div>
    <div class="toolbar" style="margin-top:12px">
      <button type="button" id="save">Save</button>
      <button type="button" id="cancel">Cancel</button>
      <span id="save-state" class="meta"></span>
    </div>`;
  const baseVersion = page ? page.version : undefined;

  let timer;
  const refreshPreview = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const { data } = await api('POST', '/api/render', { markdown: $('#f-body').value });
      if (data) $('#preview').innerHTML = data.html;
    }, 200);
  };
  $('#f-body').addEventListener('input', refreshPreview);
  refreshPreview();

  $('#cancel').onclick = () => {
    location.hash = slug ? `#/page/${encodeURIComponent(slug)}` : '#/';
  };

  const payloadFromForm = () => ({
    title: $('#f-title').value,
    body: $('#f-body').value,
    tags: $('#f-tags').value.split(',').map((t) => t.trim()).filter(Boolean),
  });

  $('#save').onclick = async () => {
    const targetSlug = isNew ? $('#f-slug').value.trim() : slug;
    if (!targetSlug) return flash('Slug is required', 'error');
    const payload = payloadFromForm();
    if (baseVersion !== undefined) payload.baseVersion = baseVersion;
    const res = await api('PUT', `/api/pages/${encodeURIComponent(targetSlug)}`, payload);
    if (res.ok) {
      flash(res.status === 201 ? 'Page created' : 'Saved', 'ok');
      location.hash = `#/page/${encodeURIComponent(targetSlug)}`;
      return;
    }
    if (res.status === 409) {
      showConflict(targetSlug, res.data?.currentVersion, payload);
      return;
    }
    flash(res.data?.message || `Save failed (${res.status})`, 'error');
  };
}

// Conflict: someone else saved a newer version. Offer reload or force-overwrite.
function showConflict(slug, currentVersion, payload) {
  flash(`Conflict: the page changed (now version ${currentVersion}).`, 'error');
  const box = document.createElement('div');
  box.innerHTML = `<button type="button" id="reload">Discard my edits and reload</button>
    <button type="button" id="overwrite">Overwrite with my version</button>`;
  notice.appendChild(box);
  $('#reload').onclick = () => (location.hash = `#/page/${encodeURIComponent(slug)}`);
  $('#overwrite').onclick = async () => {
    const res = await api('PUT', `/api/pages/${encodeURIComponent(slug)}`, { ...payload, baseVersion: currentVersion });
    if (res.ok) {
      flash('Saved over the conflicting version', 'ok');
      location.hash = `#/page/${encodeURIComponent(slug)}`;
    } else {
      flash(res.data?.message || 'Save failed', 'error');
    }
  };
}

async function showHistory(slug) {
  currentSlug = slug;
  const { ok, data } = await api('GET', `/api/pages/${encodeURIComponent(slug)}/history`);
  if (!ok) {
    view.innerHTML = '<h2>Not found</h2>';
    return;
  }
  const rows = data.map((h, idx) => {
    const prev = data[idx + 1];
    const diffLink = prev
      ? `<a href="#/diff/${encodeURIComponent(slug)}/${prev.version}/${h.version}">diff vs v${prev.version}</a>`
      : '';
    return `<tr>
      <td>v${h.version}</td><td>${esc(h.title)}</td><td>${esc(h.updatedAt)}</td>
      <td><a href="#/version/${encodeURIComponent(slug)}/${h.version}">view</a></td>
      <td>${diffLink}</td>
      <td><button type="button" data-revert="${h.version}">Revert to this</button></td></tr>`;
  }).join('');
  view.innerHTML = `
    <h2>History: ${esc(slug)}</h2>
    <table class="history"><thead><tr><th>Version</th><th>Title</th><th>Updated</th><th></th><th></th><th></th></tr></thead>
    <tbody>${rows}</tbody></table>
    <p><a href="#/page/${encodeURIComponent(slug)}">Back to page</a></p>`;
  view.querySelectorAll('[data-revert]').forEach((btn) => {
    btn.onclick = async () => {
      const res = await api('POST', `/api/pages/${encodeURIComponent(slug)}/revert`, { version: Number(btn.dataset.revert) });
      if (res.ok) {
        flash(`Reverted; now version ${res.data.version}`, 'ok');
        location.hash = `#/history/${encodeURIComponent(slug)}`;
      } else {
        flash(res.data?.message || 'Revert failed', 'error');
      }
    };
  });
}

async function showVersion(slug, n) {
  const { ok, data } = await api('GET', `/api/pages/${encodeURIComponent(slug)}/versions/${n}`);
  if (!ok) {
    view.innerHTML = '<h2>Version not found</h2>';
    return;
  }
  const { data: rendered } = await api('POST', '/api/render', { markdown: data.body });
  view.innerHTML = `
    <div class="toolbar"><a href="#/history/${encodeURIComponent(slug)}"><button type="button">Back to history</button></a></div>
    <h2>${esc(data.title)} <span class="meta">v${data.version}</span></h2>
    ${tagsHtml(data.tags)}
    <div class="article">${rendered?.html ?? ''}</div>`;
}

async function showDiff(slug, from, to) {
  const { ok, data } = await api('GET', `/api/pages/${encodeURIComponent(slug)}/diff?from=${from}&to=${to}`);
  if (!ok) {
    view.innerHTML = '<h2>Diff unavailable</h2>';
    return;
  }
  const lines = data.lines.map((l) => {
    const cls = l.op === '+' ? 'diff-add' : l.op === '-' ? 'diff-del' : 'diff-ctx';
    const mark = l.op === ' ' ? '  ' : `${l.op} `;
    return `<span class="${cls}">${esc(mark + l.text)}</span>`;
  }).join('');
  view.innerHTML = `
    <div class="toolbar"><a href="#/history/${encodeURIComponent(slug)}"><button type="button">Back to history</button></a></div>
    <h2>${esc(slug)}: v${from} → v${to}</h2>
    <pre class="diff">${lines || '<span class="diff-ctx">(no lines)</span>'}</pre>`;
}

// ---------- routing ----------

const dec = (s) => decodeURIComponent(s);

async function route() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map((p) => p);
  const [kind, a, b, c] = parts;
  currentSlug = null;
  if (kind === 'page' && a) {
    await showPage(dec(a));
  } else if (kind === 'new') {
    showEditor({ slug: null, page: null, isNew: true });
  } else if (kind === 'edit' && a) {
    const slug = dec(a);
    const { ok, data } = await api('GET', `/api/pages/${encodeURIComponent(slug)}`);
    if (!ok) {
      view.innerHTML = '<h2>Not found</h2>';
      return;
    }
    showEditor({ slug, page: data, isNew: false });
  } else if (kind === 'history' && a) {
    await showHistory(dec(a));
  } else if (kind === 'version' && a && b) {
    await showVersion(dec(a), Number(b));
  } else if (kind === 'diff' && a && b && c) {
    await showDiff(dec(a), Number(b), Number(c));
  } else {
    view.innerHTML = '<h2>Welcome</h2><p>Pick a page from the list, or create a new one.</p>';
  }
  loadList();
}

// ---------- wiring ----------

$('#new-page').onclick = () => (location.hash = '#/new');
$('#tag-filter').onchange = () => loadList();
$('#sort').onchange = () => loadList();
$('#search-form').onsubmit = (e) => e.preventDefault();
let searchTimer;
$('#search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    sidebarSearch = e.target.value.trim();
    loadList();
  }, 150);
});
window.addEventListener('hashchange', route);

await loadTags();
await route();
