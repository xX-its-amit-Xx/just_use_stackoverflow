// Single-page editor. Uses only the public /api endpoints.

const $ = (sel) => document.querySelector(sel);
const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const c of children) node.append(c);
  return node;
};

const state = {
  page: null, // last loaded page view (or null for a new page)
  slug: null, // slug being edited
  version: 0, // version the editor is based on (0 = new page)
  previewTimer: null,
};

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body !== undefined ? { 'content-type': 'application/json' } : {},
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.message || res.statusText);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function setStatus(text, isError = false) {
  const s = $('#status');
  s.textContent = text;
  s.className = isError ? 'error' : 'muted';
  if (text) setTimeout(() => { if (s.textContent === text) s.textContent = ''; }, 4000);
}

function showOnly(id) {
  for (const sec of ['welcome', 'editor']) $('#' + sec).hidden = sec !== id;
}

// ---------- sidebar ----------

async function loadTags() {
  const tags = await api('/api/tags');
  const sel = $('#tag-filter');
  const current = sel.value;
  sel.replaceChildren(el('option', { value: '', textContent: 'All tags' }));
  for (const { tag, count } of tags) {
    sel.append(el('option', { value: tag, textContent: `${tag} (${count})` }));
  }
  sel.value = current;
}

async function loadList() {
  const params = new URLSearchParams();
  if ($('#tag-filter').value) params.set('tag', $('#tag-filter').value);
  params.set('sort', $('#sort').value);
  const pages = await api('/api/pages?' + params.toString());
  const ul = $('#page-list');
  ul.replaceChildren(
    ...pages.map((p) =>
      el('li', {},
        el('a', { href: `#/${p.slug}`, className: p.slug === state.slug ? 'active' : '', textContent: p.title }),
        el('span', { className: 'muted', textContent: ` v${p.version}` }),
      ),
    ),
  );
  if (!pages.length) ul.append(el('li', { className: 'muted', textContent: 'No pages yet.' }));
}

let searchTimer = null;
function onSearchInput() {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 250);
}

async function runSearch() {
  const q = $('#search').value.trim();
  const results = $('#search-results');
  if (!q) {
    results.hidden = true;
    $('#page-list').hidden = false;
    return;
  }
  const hits = await api('/api/search?q=' + encodeURIComponent(q));
  results.replaceChildren(
    ...hits.map((h) => {
      const li = el('li');
      li.append(el('a', { href: `#/${h.slug}`, textContent: h.title }));
      const snip = el('div', { className: 'snippet' });
      snip.innerHTML = h.snippet; // server escapes everything except <mark>
      li.append(snip);
      return li;
    }),
  );
  if (!hits.length) results.append(el('li', { className: 'muted', textContent: 'No matches.' }));
  results.hidden = false;
  $('#page-list').hidden = true;
}

// ---------- editor ----------

function parseTags(text) {
  return text.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
}

function fillForm(slug, title, body, tags) {
  $('#slug').value = slug;
  $('#slug').readOnly = state.version > 0;
  $('#title').value = title;
  $('#tags').value = tags.join(', ');
  $('#body').value = body;
}

function linkList(target, slugs) {
  target.replaceChildren(
    ...(slugs.length
      ? slugs.map((s, i) => [i ? ', ' : '', el('a', { href: `#/${s}`, textContent: s })]).flat()
      : [el('span', { className: 'muted', textContent: 'none' })]),
  );
}

async function openPage(slug) {
  state.slug = slug;
  let view = null;
  try {
    view = await api(`/api/pages/${encodeURIComponent(slug)}`);
  } catch (err) {
    if (err.status !== 404) throw err;
  }
  $('#conflict').hidden = true;
  showOnly('editor');
  if (view) {
    state.page = view;
    state.version = view.version;
    $('#editor-title-heading').textContent = view.title;
    $('#version-label').textContent = `version ${view.version}`;
    fillForm(view.slug, view.title, view.body, view.tags);
    $('#delete').hidden = false;
    linkList($('#links'), view.links);
    linkList($('#backlinks'), view.backlinks);
    await loadHistory(slug);
  } else {
    state.page = null;
    state.version = 0;
    $('#editor-title-heading').textContent = `New page: ${slug}`;
    $('#version-label').textContent = 'not saved yet';
    fillForm(slug, slug.replace(/[-_]+/g, ' '), '', []);
    $('#delete').hidden = true;
    linkList($('#links'), []);
    linkList($('#backlinks'), []);
    $('#history').replaceChildren(el('li', { className: 'muted', textContent: 'No history yet.' }));
    $('#diff-from').replaceChildren();
    $('#diff-to').replaceChildren();
  }
  $('#diff').textContent = '';
  await refreshPreview();
  await loadList();
}

function showNew() {
  state.slug = null;
  state.page = null;
  state.version = 0;
  showOnly('editor');
  $('#editor-title-heading').textContent = 'New page';
  $('#version-label').textContent = 'not saved yet';
  fillForm('', '', '', []);
  $('#slug').readOnly = false;
  $('#delete').hidden = true;
  $('#history').replaceChildren();
  $('#diff').textContent = '';
  linkList($('#links'), []);
  linkList($('#backlinks'), []);
  refreshPreview();
  $('#slug').focus();
}

async function refreshPreview() {
  const markdown = $('#body').value;
  try {
    const { html } = await api('/api/render', { method: 'POST', body: { markdown } });
    $('#preview').innerHTML = html;
  } catch (err) {
    setStatus(`Preview failed: ${err.message}`, true);
  }
}

function onBodyInput() {
  clearTimeout(state.previewTimer);
  state.previewTimer = setTimeout(refreshPreview, 250);
}

async function save(overwrite = false) {
  const slug = $('#slug').value.trim();
  const body = {
    title: $('#title').value,
    body: $('#body').value,
    tags: parseTags($('#tags').value),
  };
  if (!overwrite) body.baseVersion = state.version;
  try {
    const saved = await api(`/api/pages/${encodeURIComponent(slug)}`, { method: 'PUT', body });
    state.slug = saved.slug;
    state.version = saved.version;
    $('#conflict').hidden = true;
    setStatus('Saved.');
    if (location.hash !== `#/${saved.slug}`) {
      location.hash = `#/${saved.slug}`; // triggers openPage via hashchange
    } else {
      await openPage(saved.slug);
    }
  } catch (err) {
    if (err.status === 409) {
      $('#conflict-version').textContent = String(err.data.currentVersion);
      $('#conflict').hidden = false;
      setStatus('Conflict: the page changed since you opened it.', true);
    } else {
      setStatus(`Save failed: ${err.message}`, true);
    }
  }
}

async function loadHistory(slug) {
  const versions = await api(`/api/pages/${encodeURIComponent(slug)}/history`);
  const list = $('#history');
  list.replaceChildren(
    ...versions.map((v) =>
      el('li', {},
        el('span', { textContent: `v${v.version} — ${v.title} — ${new Date(v.updatedAt).toLocaleString()} ` }),
        el('button', {
          type: 'button',
          textContent: 'Revert',
          onclick: () => revert(slug, v.version),
        }),
      ),
    ),
  );
  const fill = (sel) =>
    sel.replaceChildren(...versions.map((v) => el('option', { value: v.version, textContent: `v${v.version}` })));
  fill($('#diff-from'));
  fill($('#diff-to'));
  if (versions.length > 1) {
    $('#diff-from').value = String(versions[1].version);
    $('#diff-to').value = String(versions[0].version);
  }
}

async function revert(slug, version) {
  if (!confirm(`Revert to version ${version}? This creates a new version.`)) return;
  try {
    await api(`/api/pages/${encodeURIComponent(slug)}/revert`, { method: 'POST', body: { version } });
    setStatus(`Reverted to version ${version}.`);
    await openPage(slug);
  } catch (err) {
    setStatus(`Revert failed: ${err.message}`, true);
  }
}

async function showDiff() {
  const from = $('#diff-from').value;
  const to = $('#diff-to').value;
  if (!from || !to) return;
  const d = await api(`/api/pages/${encodeURIComponent(state.slug)}/diff?from=${from}&to=${to}`);
  const pre = $('#diff');
  pre.replaceChildren(
    ...d.lines.map((l) => {
      const line = el('span', { className: `diff-${l.op === ' ' ? 'same' : l.op === '+' ? 'add' : 'del'}`, textContent: `${l.op} ${l.text}\n` });
      return line;
    }),
  );
}

async function deletePage() {
  if (!state.slug || !confirm(`Delete "${state.slug}" and its history?`)) return;
  await api(`/api/pages/${encodeURIComponent(state.slug)}`, { method: 'DELETE' });
  setStatus('Deleted.');
  location.hash = '#/';
  await loadList();
  await loadTags();
}

// ---------- routing and wiring ----------

async function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  try {
    if (hash === 'new') {
      showNew();
    } else if (hash) {
      await openPage(decodeURIComponent(hash));
    } else {
      showOnly('welcome');
      state.slug = null;
      await loadList();
    }
  } catch (err) {
    setStatus(`Error: ${err.message}`, true);
  }
}

$('#page-form').addEventListener('submit', (e) => {
  e.preventDefault();
  save(false);
});
$('#conflict-reload').addEventListener('click', () => openPage(state.slug));
$('#conflict-overwrite').addEventListener('click', () => save(true));
$('#delete').addEventListener('click', deletePage);
$('#body').addEventListener('input', onBodyInput);
$('#diff-go').addEventListener('click', showDiff);
$('#search').addEventListener('input', onSearchInput);
$('#tag-filter').addEventListener('change', loadList);
$('#sort').addEventListener('change', loadList);
window.addEventListener('hashchange', route);

// Wiki links inside the preview navigate within the app.
$('#preview').addEventListener('click', (e) => {
  const a = e.target.closest('a.wikilink');
  if (!a) return;
  e.preventDefault();
  location.hash = a.getAttribute('href').replace(/^\/wiki\//, '#/');
});

(async function init() {
  await loadTags();
  await route();
})();
