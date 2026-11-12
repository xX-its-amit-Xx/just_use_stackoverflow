const $app = document.getElementById('app');
const S = { token: localStorage.getItem('pm_token'), user: null, ws: [], wsId: null, projects: [], projectId: null, tab: 'board', issues: [], sprints: [], project: null, panel: null, issueKey: null, err: '' };

async function api(method, path, body, raw) {
  const r = await fetch(path, { method, headers: { ...(body && !raw ? { 'content-type': 'application/json' } : {}), ...(S.token ? { authorization: 'Bearer ' + S.token } : {}) }, body: body ? (raw ? body : JSON.stringify(body)) : undefined });
  const ct = r.headers.get('content-type') || '';
  const data = r.status === 204 ? null : ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(data?.message || r.statusText);
  return data;
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const on = (sel, ev, fn, root = document) => $$(sel, root).forEach(e => e.addEventListener(ev, fn));
const guard = fn => async (...a) => { try { S.err = ''; await fn(...a); } catch (e) { S.err = e.message; render(); } };

async function boot() {
  if (S.token) { try { S.user = (await api('GET', '/api/auth/me')).user; await loadWs(); } catch { S.token = null; localStorage.removeItem('pm_token'); } }
  render();
}
async function loadWs() {
  S.ws = await api('GET', '/api/workspaces');
  if (!S.wsId || !S.ws.find(w => w.id === S.wsId)) S.wsId = S.ws[0]?.id || null;
  await loadProjects();
}
async function loadProjects() {
  S.projects = S.wsId ? await api('GET', `/api/workspaces/${S.wsId}/projects`) : [];
  if (!S.projects.find(p => p.id === S.projectId)) S.projectId = S.projects[0]?.id || null;
  await loadProject();
}
async function loadProject() {
  S.project = S.projects.find(p => p.id === S.projectId) || null;
  if (S.project) { [S.issues, S.sprints] = await Promise.all([api('GET', `/api/projects/${S.projectId}/issues`), api('GET', `/api/projects/${S.projectId}/sprints`)]); }
  else { S.issues = []; S.sprints = []; }
}

function render() {
  if (!S.user) return renderLogin();
  $app.innerHTML = `<header><b>PM</b>
    <select id="wsSel">${S.ws.map(w => `<option value="${w.id}" ${w.id === S.wsId ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select>
    <button id="newWs">+ workspace</button>
    <select id="prSel">${S.projects.map(p => `<option value="${p.id}" ${p.id === S.projectId ? 'selected' : ''}>${esc(p.key)} – ${esc(p.name)}</option>`).join('')}</select>
    <button id="newPr">+ project</button>
    <form id="searchForm" class="sp"><input id="q" style="width:100%" placeholder='Search: status:"In Progress" type:bug assignee:me -label:x'></form>
    <button id="notifBtn">🔔</button><span>${esc(S.user.displayName)}</span><button id="logout">Logout</button></header>
    <nav>${['board', 'backlog', 'sprints', 'search', 'settings'].map(t => `<button data-tab="${t}" class="${S.tab === t ? 'on' : ''}">${t}</button>`).join('')}</nav>
    <main>${S.err ? `<p class="err">${esc(S.err)}</p>` : ''}<div id="view"></div></main><div id="drawer"></div>`;
  $('#wsSel').onchange = guard(async e => { S.wsId = e.target.value; await loadProjects(); render(); });
  $('#prSel').onchange = guard(async e => { S.projectId = e.target.value; await loadProject(); render(); });
  $('#newWs').onclick = guard(async () => { const name = prompt('Workspace name'); if (!name) return; const key = prompt('Key (2-10 uppercase letters)'); const w = await api('POST', '/api/workspaces', { name, key }); S.wsId = w.id; await loadWs(); render(); });
  $('#newPr').onclick = guard(async () => { if (!S.wsId) return; const name = prompt('Project name'); if (!name) return; const key = prompt('Key'); const p = await api('POST', `/api/workspaces/${S.wsId}/projects`, { name, key }); S.projectId = p.id; await loadProjects(); render(); });
  $('#logout').onclick = async () => { try { await api('POST', '/api/auth/logout'); } catch {} S.token = null; S.user = null; localStorage.removeItem('pm_token'); render(); };
  $('#notifBtn').onclick = guard(showNotifications);
  $('#searchForm').onsubmit = guard(async e => { e.preventDefault(); S.q = $('#q').value; S.tab = 'search'; render(); });
  on('nav button', 'click', guard(async e => { S.tab = e.target.dataset.tab; await loadProject(); render(); }));
  const v = $('#view');
  if (!S.project && S.tab !== 'search') { v.innerHTML = '<div class="panel">Create or select a workspace and project to begin.</div>'; return; }
  ({ board: renderBoard, backlog: renderBacklog, sprints: renderSprints, search: renderSearch, settings: renderSettings })[S.tab](v);
}

function renderLogin() {
  $app.innerHTML = `<form class="login panel"><h2>Project Manager</h2><p class="err">${esc(S.err)}</p>
    <input name="username" placeholder="username" required><input name="displayName" placeholder="display name (register)">
    <input name="password" type="password" placeholder="password (min 8)" required>
    <button value="login">Login</button> <button value="register">Register</button></form>`;
  const f = $('form'); let mode = 'login';
  $$('button', f).forEach(b => b.onclick = () => { mode = b.value; });
  f.onsubmit = guard(async e => {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(f));
    if (mode === 'register') await api('POST', '/api/auth/register', { username: d.username, password: d.password, displayName: d.displayName || undefined });
    const r = await api('POST', '/api/auth/login', { username: d.username, password: d.password });
    S.token = r.token; S.user = r.user; localStorage.setItem('pm_token', r.token);
    await loadWs(); render();
  });
}

const card = i => `<div class="card" draggable="true" data-key="${i.key}"><small>${i.key} <span class="pill">${i.type}</span><span class="pill">${i.priority}</span></small><div>${esc(i.title)}</div><small>${i.storyPoints ?? ''} ${i.assigneeId ? '👤' : ''}</small></div>`;

function renderBoard(v) {
  const sts = S.project.workflow.statuses;
  v.innerHTML = `<div class="row"><button id="newIssue">+ Issue</button></div><div class="board">${sts.map(s => `<div class="col" data-status="${esc(s.name)}"><h3>${esc(s.name)} (${S.issues.filter(i => i.status === s.name).length})</h3>${S.issues.filter(i => i.status === s.name).map(card).join('')}</div>`).join('')}</div>`;
  $('#newIssue').onclick = guard(createIssueUI);
  bindCards(v);
  on('.col', 'dragover', e => { e.preventDefault(); e.currentTarget.classList.add('over'); }, v);
  on('.col', 'dragleave', e => e.currentTarget.classList.remove('over'), v);
  on('.col', 'drop', guard(async e => {
    e.preventDefault();
    const key = e.dataTransfer.getData('text/plain'); const status = e.currentTarget.dataset.status;
    await api('PATCH', `/api/issues/${key}`, { status }); await loadProject(); render();
  }), v);
}
function bindCards(v) {
  on('.card', 'dragstart', e => e.dataTransfer.setData('text/plain', e.currentTarget.dataset.key), v);
  on('.card', 'click', guard(e => showIssue(e.currentTarget.dataset.key)), v);
}
async function createIssueUI() {
  const title = prompt('Title'); if (!title) return;
  const type = prompt('Type (bug|feature|task|epic|subtask)', 'task') || 'task';
  const body = { title, type };
  if (type === 'subtask') body.parentId = prompt('Parent key');
  await api('POST', `/api/projects/${S.projectId}/issues`, body); await loadProject(); render();
}

function renderBacklog(v) {
  const group = id => S.issues.filter(i => (i.sprintId || null) === id);
  const sec = (title, id, extra = '') => `<div class="panel"><h3>${esc(title)} ${extra}</h3>${group(id).map(i => `<div class="card" data-key="${i.key}" draggable="true">${i.key} ${esc(i.title)} <small>${i.storyPoints ?? ''}pt</small>
    <select class="mv" data-key="${i.key}"><option value="">move to…</option><option value="__backlog">Backlog</option>${S.sprints.filter(s => s.state !== 'completed').map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>`).join('') || '<small>empty</small>'}</div>`;
  v.innerHTML = `<div class="row"><button id="newSprint">+ Sprint</button><button id="newIssue">+ Issue</button></div>` +
    S.sprints.filter(s => s.state !== 'completed').map(s => sec(`${s.name} [${s.state}]`, s.id, s.state === 'planned' ? `<button data-start="${s.id}">Start</button>` : `<button data-complete="${s.id}">Complete</button>`)).join('') + sec('Backlog', null);
  $('#newIssue').onclick = guard(createIssueUI);
  $('#newSprint').onclick = guard(async () => { const name = prompt('Sprint name'); if (!name) return; await api('POST', `/api/projects/${S.projectId}/sprints`, { name, startDate: prompt('Start date YYYY-MM-DD (optional)') || undefined, endDate: prompt('End date (optional)') || undefined }); await loadProject(); render(); });
  on('[data-start]', 'click', guard(async e => { await api('POST', `/api/sprints/${e.target.dataset.start}/start`); await loadProject(); render(); }), v);
  on('[data-complete]', 'click', guard(async e => { const to = prompt('Carry over to (sprint id or "backlog")', 'backlog'); await api('POST', `/api/sprints/${e.target.dataset.complete}/complete`, { carryOverTo: to }); await loadProject(); render(); }), v);
  on('.mv', 'change', guard(async e => { const val = e.target.value; if (!val) return; await api('PATCH', `/api/issues/${e.target.dataset.key}`, { sprintId: val === '__backlog' ? null : val }); await loadProject(); render(); }), v);
  on('.mv', 'click', e => e.stopPropagation(), v);
  bindCards(v);
}

async function renderSprints(v) {
  v.innerHTML = '<div class="panel"><h3>Sprint reports</h3>' + (S.sprints.map(s => `<div class="row"><b>${esc(s.name)}</b> ${s.state} <button data-rep="${s.id}">Report</button></div>`).join('') || 'No sprints') + '</div><div id="report"></div>';
  on('[data-rep]', 'click', guard(async e => {
    const r = await api('GET', `/api/sprints/${e.target.dataset.rep}/report`);
    $('#report').innerHTML = `<div class="panel"><h3>Report</h3><p>Committed: ${r.committedPoints} · Completed: ${r.completedPoints} (${r.completedIssues} issues) · Carried over: ${r.carriedOver}</p>${burndown(r.burndown)}</div>`;
  }), v);
}
function burndown(data) {
  if (!data.length) return '<small>No burndown data yet.</small>';
  const W = 600, H = 220, P = 30, max = Math.max(1, ...data.map(d => d.remainingPoints));
  const x = i => P + (data.length === 1 ? 0 : i * (W - 2 * P) / (data.length - 1)), y = p => H - P - p * (H - 2 * P) / max;
  const pts = data.map((d, i) => `${x(i)},${y(d.remainingPoints)}`).join(' ');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:640px"><line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" stroke="#999"/><line x1="${P}" y1="${P}" x2="${P}" y2="${H - P}" stroke="#999"/>
  <polyline fill="none" stroke="#0747a6" stroke-width="2" points="${pts}"/>${data.map((d, i) => `<circle cx="${x(i)}" cy="${y(d.remainingPoints)}" r="3" fill="#0747a6"><title>${d.date}: ${d.remainingPoints}</title></circle>`).join('')}
  <text x="4" y="${P}" font-size="10">${max}</text><text x="4" y="${H - P}" font-size="10">0</text><text x="${P}" y="${H - 8}" font-size="10">${data[0].date}</text><text x="${W - P - 60}" y="${H - 8}" font-size="10">${data.at(-1).date}</text></svg>`;
}

async function renderSearch(v) {
  v.innerHTML = '<div class="panel"><h3>Search</h3><div id="res">Searching…</div></div>';
  try {
    const qs = new URLSearchParams({ q: S.q || '' }); if (S.projectId) qs.set('project', S.projectId);
    const res = await api('GET', '/api/search?' + qs);
    $('#res').innerHTML = `<table><tr><th>Key</th><th>Title</th><th>Status</th><th>Priority</th></tr>${res.map(i => `<tr class="card" data-key="${i.key}"><td>${i.key}</td><td>${esc(i.title)}</td><td>${esc(i.status)}</td><td>${i.priority}</td></tr>`).join('')}</table>`;
    on('tr.card', 'click', guard(e => showIssue(e.currentTarget.dataset.key)), v);
  } catch (e) { $('#res').innerHTML = `<span class="err">${esc(e.message)}</span>`; }
}

async function showNotifications() {
  const list = await api('GET', '/api/notifications');
  $('#drawer').innerHTML = `<div class="drawer"><button id="x">Close</button> <button id="readAll">Mark all read</button><h3>Notifications</h3>${list.map(n => `<div class="${n.read ? '' : 'unread'}">${esc(n.type)} on <a href="#" data-key="${n.issueKey}">${n.issueKey}</a> <small>${n.at}</small></div>`).join('') || 'None'}</div>`;
  $('#x').onclick = () => $('#drawer').innerHTML = '';
  $('#readAll').onclick = guard(async () => { await api('POST', '/api/notifications/read', { all: true }); await showNotifications(); });
  on('#drawer a', 'click', guard(e => { e.preventDefault(); return showIssue(e.target.dataset.key); }));
}

async function showIssue(key) {
  const [i, comments, history] = await Promise.all([api('GET', `/api/issues/${key}`), api('GET', `/api/issues/${key}/comments`), api('GET', `/api/issues/${key}/history`)]);
  const sts = S.project?.workflow.statuses || [];
  $('#drawer').innerHTML = `<div class="drawer"><button id="x">Close</button> <button id="del">Delete</button>
  <h2>${i.key} ${esc(i.title)}</h2><div class="row"><span class="pill">${i.type}</span>
  <select id="st">${sts.map(s => `<option ${s.name === i.status ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
  <select id="pr">${['urgent', 'high', 'medium', 'low', 'none'].map(p => `<option ${p === i.priority ? 'selected' : ''}>${p}</option>`).join('')}</select>
  <button id="watch">Watch</button></div>
  <p>${esc(i.description)}</p>
  ${i.progress ? `<p>Epic progress: ${i.progress.done}/${i.progress.total} (${i.progress.points_done}/${i.progress.points_total} pts)</p>` : ''}
  <h4>Subtasks</h4>${i.children.map(c => `<div><a href="#" data-key="${c}">${c}</a></div>`).join('') || '<small>none</small>'}
  <h4>Links</h4>${i.links.map(l => `<div>${l.type} <a href="#" data-key="${l.target}">${l.target}</a> <button data-unlink="${l.id}">x</button></div>`).join('') || '<small>none</small>'}
  <div class="row"><select id="lt"><option>blocks</option><option>relates</option><option>duplicates</option></select><input id="lk" placeholder="KEY-1"><button id="addLink">Add link</button></div>
  <h4>Comments</h4>${comments.map(c => `<div class="panel">${esc(c.body)} ${c.edited ? '<small>(edited)</small>' : ''}<br><small>${c.createdAt}</small></div>`).join('')}
  <textarea id="cb" placeholder="Comment (use @username to mention)"></textarea><button id="addC">Comment</button>
  <h4>History</h4>${history.map(h => `<div><small>${h.at} ${h.field}: ${esc(JSON.stringify(h.from))} → ${esc(JSON.stringify(h.to))}</small></div>`).join('') || '<small>none</small>'}</div>`;
  const reload = guard(async () => { await loadProject(); render(); await showIssue(key); });
  $('#x').onclick = () => $('#drawer').innerHTML = '';
  $('#del').onclick = guard(async () => { if (!confirm('Delete?')) return; await api('DELETE', `/api/issues/${key}`); await loadProject(); render(); });
  $('#st').onchange = guard(async e => { await api('PATCH', `/api/issues/${key}`, { status: e.target.value }); await reload(); });
  $('#pr').onchange = guard(async e => { await api('PATCH', `/api/issues/${key}`, { priority: e.target.value }); await reload(); });
  $('#watch').onclick = guard(async () => { await api('POST', `/api/issues/${key}/watch`); });
  $('#addLink').onclick = guard(async () => { await api('POST', `/api/issues/${key}/links`, { type: $('#lt').value, target: $('#lk').value }); await reload(); });
  on('[data-unlink]', 'click', guard(async e => { await api('DELETE', `/api/issues/${key}/links/${e.target.dataset.unlink}`); await reload(); }), $('#drawer'));
  $('#addC').onclick = guard(async () => { await api('POST', `/api/issues/${key}/comments`, { body: $('#cb').value }); await reload(); });
  on('#drawer a', 'click', guard(e => { e.preventDefault(); return showIssue(e.target.dataset.key); }));
}

async function renderSettings(v) {
  const p = S.project;
  const [members, hooks] = await Promise.all([api('GET', `/api/projects/${p.id}/members`), api('GET', `/api/projects/${p.id}/webhooks`).catch(() => [])]);
  const wf = p.workflow;
  v.innerHTML = `<div class="panel"><h3>Workflow</h3><small>One status per line: <code>Name|category</code>. Transitions: <code>From&gt;To</code> per line (blank = allow all). Remap: <code>Old&gt;New</code>.</small>
    <textarea id="wfS" rows="6">${wf.statuses.map(s => `${s.name}|${s.category}`).join('\n')}</textarea>
    <textarea id="wfT" rows="4">${wf.transitions.map(t => t.join('>')).join('\n')}</textarea>
    <textarea id="wfR" rows="2" placeholder="remap, e.g. Old>New"></textarea><button id="saveWf">Save workflow</button></div>
  <div class="panel"><h3>Project members</h3>${members.map(m => `<div>${esc(m.username)} – ${m.role} <button data-rm="${m.userId}">remove</button></div>`).join('')}
    <div class="row"><input id="mu" placeholder="username"><select id="mr"><option>lead</option><option selected>developer</option><option>viewer</option></select><button id="addM">Add</button></div></div>
  <div class="panel"><h3>Webhooks</h3>${hooks.map(h => `<div>${esc(h.url)} [${h.events.join(',')}] <button data-dh="${h.id}">delete</button> <button data-dl="${h.id}">deliveries</button></div>`).join('')}
    <div class="row"><input id="wu" placeholder="https://…"><input id="we" value="issue.created,issue.updated"><input id="ws" placeholder="secret"><button id="addH">Add</button></div><pre id="dl"></pre></div>
  <div class="panel"><a href="#" id="exp">Export CSV</a> · <label>Import CSV <input type="file" id="imp"></label><pre id="impRes"></pre></div>`;
  $('#saveWf').onclick = guard(async () => {
    const statuses = $('#wfS').value.split('\n').filter(l => l.trim()).map(l => { const [name, category] = l.split('|'); return { name: name.trim(), category: (category || '').trim() }; });
    const pairs = t => t.split('\n').filter(l => l.includes('>')).map(l => l.split('>').map(s => s.trim()));
    const body = { statuses, remap: Object.fromEntries(pairs($('#wfR').value)) };
    const tr = pairs($('#wfT').value); if (tr.length) body.transitions = tr;
    await api('PUT', `/api/projects/${p.id}/workflow`, body);
    await loadProjects(); render();
  });
  $('#addM').onclick = guard(async () => { await api('POST', `/api/projects/${p.id}/members`, { username: $('#mu').value, role: $('#mr').value }); render(); });
  on('[data-rm]', 'click', guard(async e => { await api('DELETE', `/api/projects/${p.id}/members/${e.target.dataset.rm}`); render(); }), v);
  $('#addH').onclick = guard(async () => { await api('POST', `/api/projects/${p.id}/webhooks`, { url: $('#wu').value, events: $('#we').value.split(',').map(s => s.trim()), secret: $('#ws').value }); render(); });
  on('[data-dh]', 'click', guard(async e => { await api('DELETE', `/api/webhooks/${e.target.dataset.dh}`); render(); }), v);
  on('[data-dl]', 'click', guard(async e => { $('#dl').textContent = JSON.stringify(await api('GET', `/api/webhooks/${e.target.dataset.dl}/deliveries`), null, 1); }), v);
  $('#exp').onclick = guard(async e => { e.preventDefault(); const t = await api('GET', `/api/projects/${p.id}/export.csv`); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([t], { type: 'text/csv' })); a.download = p.key + '.csv'; a.click(); });
  $('#imp').onchange = guard(async e => { const txt = await e.target.files[0].text(); const r = await fetch(`/api/projects/${p.id}/import.csv`, { method: 'POST', headers: { authorization: 'Bearer ' + S.token, 'content-type': 'text/csv' }, body: txt }); $('#impRes').textContent = JSON.stringify(await r.json(), null, 1); await loadProject(); });
}
boot();
