const $ = (id) => document.getElementById(id);
let version = null;
const api = async (url, opt) => { const r = await fetch(url, opt && { ...opt, headers: { 'content-type': 'application/json' }, body: opt.body && JSON.stringify(opt.body) }); return { status: r.status, data: r.status === 204 ? null : await r.json() }; };
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function refreshList() {
  const tag = $('tag').value, q = $('q').value.trim();
  const tags = (await api('/api/tags')).data;
  $('tag').innerHTML = '<option value="">all tags</option>' + tags.map((t) => `<option ${t.tag === tag ? 'selected' : ''} value="${esc(t.tag)}">${esc(t.tag)} (${t.count})</option>`).join('');
  let items;
  if (q) items = (await api('/api/search?q=' + encodeURIComponent(q))).data.map((r) => ({ slug: r.slug, title: r.title, snip: r.snippet }));
  else items = (await api('/api/pages' + (tag ? '?tag=' + encodeURIComponent(tag) : ''))).data;
  $('list').innerHTML = items.map((p) => `<li><a href="#" data-slug="${esc(p.slug)}">${esc(p.title)}</a>${p.snip ? '<br><small>' + p.snip + '</small>' : ''}</li>`).join('');
}
async function preview() { const r = await api('/api/render', { method: 'POST', body: { markdown: $('body').value } }); $('preview').innerHTML = r.data.html; }
async function open(slug) {
  const r = await api('/api/pages/' + slug); if (r.status !== 200) return;
  const p = r.data; version = p.version;
  $('slug').value = p.slug; $('title').value = p.title; $('tags').value = p.tags.join(', '); $('body').value = p.body; $('preview').innerHTML = p.html;
  $('backlinks').innerHTML = p.backlinks.map((s) => `<li><a href="#" data-slug="${esc(s)}">${esc(s)}</a></li>`).join('');
  const h = (await api(`/api/pages/${slug}/history`)).data;
  $('history').innerHTML = h.map((v, i) => `<li>v${v.version} ${esc(v.title)} ${h[i + 1] ? `<a href="#" data-diff="${h[i + 1].version},${v.version}">diff</a>` : ''} <a href="#" data-revert="${v.version}">revert</a></li>`).join('');
  $('diff').textContent = '';
}
async function save() {
  const slug = $('slug').value.trim();
  const body = { title: $('title').value, body: $('body').value, tags: $('tags').value.split(',').map((t) => t.trim()).filter(Boolean) };
  if (version !== null) body.baseVersion = version;
  const r = await api('/api/pages/' + slug, { method: 'PUT', body });
  if (r.status === 409) { $('msg').textContent = `Conflict: server is at version ${r.data.currentVersion}. Reload the page to merge.`; return; }
  if (r.status >= 400) { $('msg').textContent = r.data.message; return; }
  $('msg').textContent = 'Saved v' + r.data.version; await open(slug); refreshList();
}
document.addEventListener('click', async (e) => {
  const t = e.target;
  if (t.dataset.slug) { e.preventDefault(); open(t.dataset.slug); }
  if (t.dataset.revert) { e.preventDefault(); const s = $('slug').value; await api(`/api/pages/${s}/revert`, { method: 'POST', body: { version: Number(t.dataset.revert) } }); open(s); }
  if (t.dataset.diff) {
    e.preventDefault(); const [a, b] = t.dataset.diff.split(',');
    const d = (await api(`/api/pages/${$('slug').value}/diff?from=${a}&to=${b}`)).data;
    $('diff').innerHTML = d.lines.map((l) => `<div class="${l.op === '+' ? 'add' : l.op === '-' ? 'del' : ''}">${esc(l.op + ' ' + l.text)}</div>`).join('');
  }
  if (t.tagName === 'A' && t.classList.contains('wikilink') && t.closest('#preview')) { e.preventDefault(); const s = t.getAttribute('href').split('/').pop(); if (!t.classList.contains('missing')) open(s); else { version = null; $('slug').value = s; $('title').value = t.textContent; $('body').value = ''; } }
});
$('save').onclick = save; $('body').oninput = preview; $('q').oninput = refreshList; $('tag').onchange = refreshList;
$('new').onclick = () => { version = null; for (const i of ['slug', 'title', 'tags', 'body']) $(i).value = ''; $('preview').innerHTML = ''; };
refreshList();
