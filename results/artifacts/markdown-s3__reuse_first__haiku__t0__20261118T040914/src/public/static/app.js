// markdown-s3 editor UI. Talks to the server only through the public /api endpoints.
const $ = (sel) => document.querySelector(sel);
const enc = encodeURIComponent;
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;

const content = $('#content');
const list = $('#list');
const statusEl = $('#status');

// current = { slug, page } where page is the GET detail, or null when the page does not exist yet
let current = null;
let mode = 'view'; // 'view' | 'edit' | 'history'
let dirty = false;

async function api(url, { method = 'GET', body } = {}) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data.message || res.statusText);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function flash(msg, isError = false) {
  statusEl.textContent = msg;
  statusEl.className = isError ? 'error' : 'ok';
  if (!isError) {
    setTimeout(() => {
      if (statusEl.textContent === msg) statusEl.textContent = '';
    }, 3000);
  }
}

const when = (iso) => new Date(iso).toLocaleString();

function linkList(slugs) {
  if (!slugs.length) return '<p class="muted">None</p>';
  return `<ul class="links">${slugs.map((s) => `<li><a href="#/${enc(s)}">${esc(s)}</a></li>`).join('')}</ul>`;
}

// ---------- sidebar ----------

async function refreshList() {
  const sort = $('#sort').value;
  const tag = $('#tag-filter').value;
  const qs = new URLSearchParams({ sort });
  if (tag) qs.set('tag', tag);
  const pages = await api(`/api/pages?${qs}`);
  list.innerHTML =
    pages
      .map(
        (p) =>
          `<li class="${current && current.slug === p.slug ? 'active' : ''}"><a href="#/${enc(p.slug)}">${esc(p.title)}</a>` +
          (p.tags.length ? ` <span class="tags">${p.tags.map(esc).join(', ')}</span>` : '') +
          '</li>',
      )
      .join('') || '<li class="empty">No pages yet</li>';

  const tags = await api('/api/tags');
  const sel = $('#tag-filter');
  const keep = sel.value;
  sel.innerHTML =
    '<option value="">All tags</option>' +
    tags.map((t) => `<option value="${esc(t.tag)}">${esc(t.tag)} (${t.count})</option>`).join('');
  sel.value = keep;
}

let searchTimer;
$('#search').addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 250);
});

async function runSearch() {
  const q = $('#search').value.trim();
  if (!q) return refreshList();
  try {
    const hits = await api(`/api/search?q=${enc(q)}`);
    // snippets are HTML-escaped by the server; only <mark> is markup
    list.innerHTML =
      hits
        .map(
          (h) =>
            `<li><a href="#/${enc(h.slug)}">${esc(h.title)}</a><div class="snippet">${h.snippet}</div></li>`,
        )
        .join('') || '<li class="empty">No matches</li>';
  } catch (e) {
    flash(e.message, true);
  }
}

$('#tag-filter').addEventListener('change', () => refreshList().catch((e) => flash(e.message, true)));
$('#sort').addEventListener('change', () => refreshList().catch((e) => flash(e.message, true)));

$('#new-page').addEventListener('click', () => {
  const slug = prompt('Slug for the new page (a-z, 0-9, "_" and "-", starting with a letter or digit):');
  if (!slug) return;
  if (!SLUG_RE.test(slug)) return flash('Invalid slug', true);
  location.hash = `#/${enc(slug)}`;
});

// ---------- routing ----------

function slugFromHash() {
  const h = location.hash.replace(/^#\/?/, '');
  return h ? decodeURIComponent(h) : null;
}

async function route() {
  const slug = slugFromHash();
  if (!slug) {
    if (dirty && !confirm('Discard unsaved changes?')) return;
    dirty = false;
    current = null;
    mode = 'view';
    content.innerHTML = '<p class="muted">Select a page, or create a new one.</p>';
    return refreshList().catch((e) => flash(e.message, true));
  }
  if (current && slug === current.slug && mode === 'edit' && dirty) return; // same page, keep edits
  if (dirty && !confirm('Discard unsaved changes?')) {
    history.replaceState(null, '', `#/${enc(current.slug)}`);
    return;
  }
  dirty = false;
  await showPage(slug, 'view');
}

async function showPage(slug, startMode = 'view') {
  try {
    let page = null;
    try {
      page = await api(`/api/pages/${enc(slug)}`);
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    current = { slug, page };
    mode = startMode;
    renderCurrent();
    refreshList().catch((e) => flash(e.message, true));
  } catch (e) {
    flash(e.message, true);
  }
}

function renderCurrent() {
  if (!current) return;
  if (mode === 'edit') return renderEditor();
  if (mode === 'history') return renderHistory();
  renderView();
}

// ---------- view ----------

function renderView() {
  const { slug, page } = current;
  if (!page) {
    content.innerHTML = `<h2>${esc(slug)}</h2><p class="muted">This page does not exist yet.</p>
      <div class="toolbar"><button type="button" data-act="edit">Create page</button></div>`;
    return;
  }
  content.innerHTML = `
    <div class="toolbar">
      <span class="meta">v${page.version} · updated ${esc(when(page.updatedAt))}</span>
      <button type="button" data-act="edit">Edit</button>
      <button type="button" data-act="history">History</button>
      <button type="button" data-act="delete" class="danger">Delete</button>
    </div>
    <h2 class="page-title">${esc(page.title)}</h2>
    ${page.tags.length ? `<p class="tags">${page.tags.map(esc).join(', ')}</p>` : ''}
    <article class="rendered">${page.html}</article>
    <section class="panel">
      <h3>Backlinks</h3>${linkList(page.backlinks)}
      <h3>Links from this page</h3>${linkList(page.links)}
    </section>`;
}

// ---------- editor ----------

function renderEditor() {
  const { slug, page } = current;
  content.innerHTML = `
    <form id="editor">
      <div class="row">
        <input id="ed-title" placeholder="Title" maxlength="200" required value="${esc(page ? page.title : slug)}">
        <input id="ed-tags" placeholder="tags, comma separated" value="${esc(page ? page.tags.join(', ') : '')}">
      </div>
      <div class="split">
        <textarea id="ed-body" spellcheck="false" placeholder="Write Markdown here. Use [[Page Title]] for wiki links.">${esc(page ? page.body : '')}</textarea>
        <div id="preview" class="rendered"></div>
      </div>
      <div class="toolbar">
        <button type="submit">Save</button>
        <button type="button" data-act="cancel">Cancel</button>
        <span id="conflict"></span>
      </div>
    </form>`;
  const form = $('#editor');
  const body = $('#ed-body');
  form.addEventListener('input', () => {
    dirty = true;
  });
  let previewTimer;
  const updatePreview = async () => {
    try {
      const r = await api('/api/render', { method: 'POST', body: { markdown: body.value } });
      $('#preview').innerHTML = r.html;
    } catch (e) {
      flash(e.message, true);
    }
  };
  body.addEventListener('input', () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(updatePreview, 250);
  });
  updatePreview();

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    const payload = {
      title: $('#ed-title').value.trim(),
      body: body.value,
      tags: $('#ed-tags').value.split(',').map((s) => s.trim()).filter(Boolean),
      baseVersion: current.page ? current.page.version : 0,
    };
    save(slug, payload);
  });
}

async function save(slug, payload) {
  try {
    await api(`/api/pages/${enc(slug)}`, { method: 'PUT', body: payload });
    dirty = false;
    flash('Saved');
    if (slugFromHash() !== slug) {
      location.hash = `#/${enc(slug)}`; // route() shows the page
    } else {
      await showPage(slug, 'view');
    }
  } catch (e) {
    if (e.status === 409) {
      const cur = e.data.currentVersion;
      $('#conflict').innerHTML =
        `<span class="error">Conflict: the page changed (now v${esc(cur)}).</span> ` +
        `<button type="button" id="ov">Overwrite with my version</button> ` +
        `<button type="button" id="reload">Discard mine and reload</button>`;
      $('#ov').onclick = () => save(slug, { ...payload, baseVersion: cur });
      $('#reload').onclick = () => {
        dirty = false;
        showPage(slug, 'view');
      };
    } else {
      flash(e.message, true);
    }
  }
}

// ---------- history ----------

async function renderHistory() {
  const { slug, page } = current;
  if (!page) return renderView();
  const versions = await api(`/api/pages/${enc(slug)}/history`);
  const opts = versions.map((v) => `<option value="${v.version}">v${v.version}</option>`).join('');
  content.innerHTML = `
    <div class="toolbar"><button type="button" data-act="back">Back to page</button></div>
    <h2>History: ${esc(page.title)}</h2>
    <table class="history">
      <thead><tr><th>Version</th><th>Title</th><th>Updated</th><th></th></tr></thead>
      <tbody>${versions
        .map(
          (v) =>
            `<tr><td>v${v.version}</td><td>${esc(v.title)}</td><td>${esc(when(v.updatedAt))}</td>` +
            `<td><button type="button" data-act="view" data-v="${v.version}">View</button></td></tr>`,
        )
        .join('')}</tbody>
    </table>
    <section class="panel">
      <h3>Diff</h3>
      From <select id="d-from">${opts}</select>
      to <select id="d-to">${opts}</select>
      <button type="button" data-act="diff">Show diff</button>
    </section>
    <div id="history-detail"></div>`;
  if (versions.length > 1) {
    $('#d-from').value = String(versions[1].version);
    $('#d-to').value = String(versions[0].version);
  } else if (versions.length === 1) {
    $('#d-from').value = String(versions[0].version);
    $('#d-to').value = String(versions[0].version);
  }
}

async function showDiff() {
  const from = $('#d-from').value;
  const to = $('#d-to').value;
  const d = await api(`/api/pages/${enc(current.slug)}/diff?from=${from}&to=${to}`);
  const rows = d.lines
    .map((l) => {
      const cls = l.op === '+' ? 'add' : l.op === '-' ? 'del' : 'same';
      return `<div class="line ${cls}"><span class="op">${esc(l.op.trim() || ' ')}</span>${esc(l.text)}</div>`;
    })
    .join('');
  $('#history-detail').innerHTML = `<h3>Diff v${esc(from)} → v${esc(to)}</h3><div class="diff">${rows || '<p class="muted">Identical</p>'}</div>`;
}

// ---------- event delegation for content ----------

content.addEventListener('click', async (ev) => {
  const link = ev.target.closest('a.wikilink, a[href^="/wiki/"]');
  if (link) {
    ev.preventDefault();
    const slug = link.getAttribute('href').replace(/^\/wiki\//, '');
    location.hash = `#/${slug}`;
    return;
  }
  const btn = ev.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const slug = current && current.slug;
  try {
    if (act === 'edit') {
      mode = 'edit';
      renderEditor();
    } else if (act === 'cancel') {
      if (dirty && !confirm('Discard unsaved changes?')) return;
      dirty = false;
      mode = 'view';
      renderView();
    } else if (act === 'back') {
      mode = 'view';
      renderView();
    } else if (act === 'history') {
      mode = 'history';
      await renderHistory();
    } else if (act === 'delete') {
      if (!confirm('Delete this page and its entire history?')) return;
      await api(`/api/pages/${enc(slug)}`, { method: 'DELETE' });
      dirty = false;
      current = null;
      flash('Deleted');
      history.replaceState(null, '', '#/');
      content.innerHTML = '<p class="muted">Page deleted.</p>';
      await refreshList();
    } else if (act === 'view') {
      const v = await api(`/api/pages/${enc(slug)}/versions/${btn.dataset.v}`);
      $('#history-detail').innerHTML =
        `<h3>v${v.version}: ${esc(v.title)}</h3><pre class="source">${esc(v.body)}</pre>` +
        `<button type="button" data-act="revert" data-v="${v.version}">Revert to this version</button>`;
    } else if (act === 'revert') {
      await api(`/api/pages/${enc(slug)}/revert`, { method: 'POST', body: { version: Number(btn.dataset.v) } });
      flash('Reverted (new version created)');
      await showPage(slug, 'view');
    } else if (act === 'diff') {
      await showDiff();
    }
  } catch (e) {
    flash(e.message, true);
  }
});

window.addEventListener('hashchange', () => route());
route();
