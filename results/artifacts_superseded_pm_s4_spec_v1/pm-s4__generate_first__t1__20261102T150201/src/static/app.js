// pm-s4 SPA — uses only the public REST API.
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const st = { token: localStorage.getItem('pm_token'), user: null, workspaces: [], ws: null, projects: [], project: null, view: 'board', issueKey: null, notifOpen: false, msg: '' };

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json', ...(st.token ? { authorization: 'Bearer ' + st.token } : {}) }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  const text = await r.text(); let data = null;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) { const e = new Error(data?.message || r.statusText); e.status = r.status; throw e; }
  return data;
}
const run = (fn) => async (...a) => { try { st.msg = ''; await fn(...a); } catch (e) { st.msg = e.message; } render(); };

async function boot() {
  if (st.token) { try { st.user = await api('GET', '/api/auth/me'); await loadWs(); } catch { st.token = null; localStorage.removeItem('pm_token'); } }
  render();
}
async function loadWs() {
  st.workspaces = await api('GET', '/api/workspaces');
  if (!st.ws || !st.workspaces.find(w => w.id === st.ws.id)) st.ws = st.workspaces[0] || null;
  else st.ws = st.workspaces.find(w => w.id === st.ws.id);
  await loadProjects();
}
async function loadProjects() {
  st.projects = st.ws ? await api('GET', `/api/workspaces/${st.ws.id}/projects`) : [];
  if (!st.project || !st.projects.find(p => p.id === st.project.id)) st.project = st.projects[0] || null;
  else st.project = st.projects.find(p => p.id === st.project.id);
}
const form = (el) => Object.fromEntries(new FormData(el));

function render() {
  const app = $('#app');
  if (!st.user) return renderAuth(app);
  app.innerHTML = `
  <header><b>pm-s4</b>
    <select id="wsSel">${st.workspaces.map(w => `<option value="${w.id}" ${st.ws?.id === w.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select>
    <button id="newWs">+ Workspace</button>
    <select id="prSel">${st.projects.map(p => `<option value="${p.id}" ${st.project?.id === p.id ? 'selected' : ''}>${esc(p.key)} — ${esc(p.name)}</option>`).join('')}</select>
    <button id="newPr">+ Project</button>
    <nav>${['board', 'backlog', 'report', 'settings'].map(v => `<button data-view="${v}" ${st.view === v ? 'disabled' : ''}>${v}</button>`).join('')}</nav>
    <form id="searchForm"><input name="q" placeholder='search: status:"In Progress" -label:x' size="36"><button>Search</button></form>
    <button id="notifBtn">🔔 <span id="nCount"></span></button>
    <span>${esc(st.user.username)}</span><button id="logout">Logout</button>
  </header>
  <div class="err" id="msg">${esc(st.msg)}</div>
  <main id="main"></main><div id="notifPanel"></div>`;
  $('#wsSel').onchange = run(async (e) => { st.ws = st.workspaces.find(w => w.id === e.target.value); st.project = null; await loadProjects(); });
  $('#prSel').onchange = run(async (e) => { st.project = st.projects.find(p => p.id === e.target.value); });
  $('#newWs').onclick = run(async () => { const name = prompt('Workspace name'); if (!name) return; const key = prompt('Key (2-10 uppercase letters)'); await api('POST', '/api/workspaces', { name, key }); await loadWs(); });
  $('#newPr').onclick = run(async () => { if (!st.ws) return; const name = prompt('Project name'); if (!name) return; const key = prompt('Key (2-10 uppercase letters)'); await api('POST', `/api/workspaces/${st.ws.id}/projects`, { name, key }); await loadProjects(); });
  document.querySelectorAll('nav [data-view]').forEach(b => b.onclick = () => { st.view = b.dataset.view; st.issueKey = null; render(); });
  $('#logout').onclick = run(async () => { await api('POST', '/api/auth/logout').catch(() => {}); st.token = null; st.user = null; localStorage.removeItem('pm_token'); });
  $('#searchForm').onsubmit = run(async (e) => { e.preventDefault(); st.view = 'search'; st.query = form(e.target).q; st.issueKey = null; });
  $('#notifBtn').onclick = run(async () => { st.notifOpen = !st.notifOpen; });
  renderMain();
  renderNotifs();
}

function renderAuth(app) {
  app.innerHTML = `<main><div class="panel"><h2>pm-s4</h2><div class="err">${esc(st.msg)}</div>
  <form id="login"><h3>Login</h3><div class="row"><input name="username" placeholder="username"><input name="password" type="password" placeholder="password"><button>Login</button></div></form>
  <form id="register"><h3>Register</h3><div class="row"><input name="username" placeholder="username"><input name="password" type="password" placeholder="password (8+)"><input name="displayName" placeholder="display name"><button>Register</button></div></form></div></main>`;
  $('#login').onsubmit = run(async (e) => { e.preventDefault(); const r = await api('POST', '/api/auth/login', form(e.target)); st.token = r.token; localStorage.setItem('pm_token', r.token); st.user = r.user; await loadWs(); });
  $('#register').onsubmit = run(async (e) => { e.preventDefault(); const f = form(e.target); await api('POST', '/api/auth/register', f); const r = await api('POST', '/api/auth/login', f); st.token = r.token; localStorage.setItem('pm_token', r.token); st.user = r.user; await loadWs(); });
}

async function renderMain() {
  const m = $('#main');
  if (!st.project) { m.innerHTML = '<div class="panel">Create a workspace and project to get started.</div>'; return; }
  try {
    if (st.issueKey) return await renderIssue(m);
    if (st.view === 'board') return await renderBoard(m);
    if (st.view === 'backlog') return await renderBacklog(m);
    if (st.view === 'report') return await renderReport(m);
    if (st.view === 'settings') return await renderSettings(m);
    if (st.view === 'search') return await renderSearch(m);
  } catch (e) { m.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

const card = (i) => `<div class="card" draggable="true" data-key="${i.key}"><small>${esc(i.key)} · ${esc(i.type)} · ${esc(i.priority)}</small><div>${esc(i.title)}</div><small>${i.storyPoints != null ? i.storyPoints + ' pts' : ''}</small></div>`;
function wireCards(root) { root.querySelectorAll('.card').forEach(c => { c.onclick = () => { st.issueKey = c.dataset.key; render(); }; c.ondragstart = (e) => e.dataTransfer.setData('text/plain', c.dataset.key); }); }
function newIssueForm() {
  return `<form id="newIssue" class="row"><select name="type">${['task', 'bug', 'feature', 'epic'].map(t => `<option>${t}</option>`).join('')}</select><input name="title" placeholder="New issue title"><input name="storyPoints" type="number" placeholder="pts" style="width:60px"><button>Create</button></form>`;
}
function wireNewIssue() {
  $('#newIssue').onsubmit = run(async (e) => { e.preventDefault(); const f = form(e.target); const b = { type: f.type, title: f.title }; if (f.storyPoints !== '') b.storyPoints = Number(f.storyPoints); await api('POST', `/api/projects/${st.project.id}/issues`, b); });
}

async function renderBoard(m) {
  const issues = await api('GET', `/api/projects/${st.project.id}/issues`);
  const wf = st.project.workflow;
  m.innerHTML = `<div class="panel">${newIssueForm()}</div><div class="board">${wf.statuses.map(s => `<div class="col" data-status="${esc(s.name)}"><b>${esc(s.name)}</b> <small>(${issues.filter(i => i.status === s.name).length})</small>${issues.filter(i => i.status === s.name).map(card).join('')}</div>`).join('')}</div>`;
  wireNewIssue(); wireCards(m);
  m.querySelectorAll('.col').forEach(col => {
    col.ondragover = (e) => { e.preventDefault(); col.classList.add('over'); };
    col.ondragleave = () => col.classList.remove('over');
    col.ondrop = run(async (e) => { e.preventDefault(); const key = e.dataTransfer.getData('text/plain'); await api('PATCH', `/api/issues/${key}`, { status: col.dataset.status }); });
  });
}

async function renderBacklog(m) {
  const [issues, sprints] = await Promise.all([api('GET', `/api/projects/${st.project.id}/issues`), api('GET', `/api/projects/${st.project.id}/sprints`)]);
  const sprintOpts = (cur) => `<option value="">Backlog</option>` + sprints.filter(s => s.state !== 'completed').map(s => `<option value="${s.id}" ${cur === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  const list = (arr) => arr.map(i => `<div class="row"><a href="#" data-key="${i.key}">${esc(i.key)}</a> ${esc(i.title)} <small>${i.storyPoints ?? ''}</small><select data-move="${i.key}">${sprintOpts(i.sprintId)}</select></div>`).join('') || '<i>empty</i>';
  m.innerHTML = `<div class="panel">${newIssueForm()}</div>
  <div class="panel"><form id="newSprint" class="row"><input name="name" placeholder="Sprint name"><input name="startDate" type="date"><input name="endDate" type="date"><button>Create sprint</button></form></div>
  ${sprints.filter(s => s.state !== 'completed').map(s => `<div class="panel"><h3>${esc(s.name)} <small>${s.state} ${s.startDate || ''} ${s.endDate || ''}</small></h3>
    ${s.state === 'planned' ? `<button data-start="${s.id}">Start</button>` : `<button data-complete="${s.id}">Complete</button>`}
    ${list(issues.filter(i => i.sprintId === s.id))}</div>`).join('')}
  <div class="panel"><h3>Backlog</h3>${list(issues.filter(i => !i.sprintId))}</div>`;
  wireNewIssue();
  m.querySelectorAll('a[data-key]').forEach(a => a.onclick = (e) => { e.preventDefault(); st.issueKey = a.dataset.key; render(); });
  m.querySelectorAll('[data-move]').forEach(s => s.onchange = run(async () => { await api('PATCH', `/api/issues/${s.dataset.move}`, { sprintId: s.value || null }); }));
  m.querySelectorAll('[data-start]').forEach(b => b.onclick = run(async () => { await api('POST', `/api/sprints/${b.dataset.start}/start`, {}); }));
  m.querySelectorAll('[data-complete]').forEach(b => b.onclick = run(async () => { const t = prompt('Carry over to sprint id or "backlog"', 'backlog'); if (!t) return; await api('POST', `/api/sprints/${b.dataset.complete}/complete`, { carryOverTo: t }); }));
  $('#newSprint').onsubmit = run(async (e) => { e.preventDefault(); const f = form(e.target); const b = { name: f.name }; if (f.startDate) b.startDate = f.startDate; if (f.endDate) b.endDate = f.endDate; await api('POST', `/api/projects/${st.project.id}/sprints`, b); });
}

function burndownSvg(points) {
  const W = 600, H = 240, pad = 30;
  if (!points.length) return '<i>No burndown data yet.</i>';
  const max = Math.max(1, ...points.map(p => p.remainingPoints));
  const x = (i) => pad + (points.length === 1 ? 0 : i * (W - 2 * pad) / (points.length - 1));
  const y = (v) => H - pad - v * (H - 2 * pad) / max;
  const line = points.map((p, i) => `${x(i)},${y(p.remainingPoints)}`).join(' ');
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" id="burndown"><rect width="${W}" height="${H}" fill="#fff"/>
  <line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" stroke="#999"/><line x1="${pad}" y1="${pad}" x2="${pad}" y2="${H - pad}" stroke="#999"/>
  <text x="2" y="${pad}" font-size="10">${max}</text><text x="2" y="${H - pad}" font-size="10">0</text>
  <polyline fill="none" stroke="#0747a6" stroke-width="2" points="${line}"/>
  ${points.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.remainingPoints)}" r="3" fill="#0747a6"><title>${p.date}: ${p.remainingPoints}</title></circle>`).join('')}
  <text x="${pad}" y="${H - 8}" font-size="10">${points[0].date}</text><text x="${W - pad - 60}" y="${H - 8}" font-size="10">${points[points.length - 1].date}</text></svg>`;
}
async function renderReport(m) {
  const sprints = await api('GET', `/api/projects/${st.project.id}/sprints`);
  const stats = await api('GET', `/api/projects/${st.project.id}/stats`);
  const sel = st.reportSprint && sprints.find(s => s.id === st.reportSprint) ? st.reportSprint : (sprints.find(s => s.state === 'active') || sprints[sprints.length - 1])?.id;
  let rep = null; if (sel) rep = await api('GET', `/api/sprints/${sel}/report`);
  m.innerHTML = `<div class="panel"><h3>Sprint report</h3><select id="repSel">${sprints.map(s => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${esc(s.name)} (${s.state})</option>`).join('')}</select>
  ${rep ? `<p>Committed: ${rep.committedPoints} · Completed: ${rep.completedPoints} pts / ${rep.completedIssues} issues · Carried over: ${rep.carriedOver}</p>${burndownSvg(rep.burndown)}` : '<p>No sprints.</p>'}</div>
  <div class="panel"><h3>Project stats</h3><pre>${esc(JSON.stringify(stats, null, 2))}</pre></div>`;
  const rs = $('#repSel'); if (rs) rs.onchange = run(async () => { st.reportSprint = rs.value; });
}

async function renderSearch(m) {
  const res = await api('GET', `/api/search?q=${encodeURIComponent(st.query || '')}&project=${st.project.id}`).catch(e => { m.innerHTML = `<div class="err">${esc(e.message)}</div>`; return null; });
  if (!res) return;
  m.innerHTML = `<div class="panel"><h3>Results for "${esc(st.query)}" (${res.length})</h3>${res.map(card).join('')}</div>`;
  wireCards(m);
}

async function renderIssue(m) {
  const key = st.issueKey;
  const [i, hist, comments] = await Promise.all([api('GET', `/api/issues/${key}`), api('GET', `/api/issues/${key}/history`), api('GET', `/api/issues/${key}/comments`)]);
  const wf = st.project.workflow;
  m.innerHTML = `<div class="panel"><button id="back">← back</button><h2>${esc(i.key)} ${esc(i.title)}</h2>
  <form id="edit" class="row"><select name="status">${wf.statuses.map(s => `<option ${s.name === i.status ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
  <select name="priority">${['urgent', 'high', 'medium', 'low', 'none'].map(p => `<option ${p === i.priority ? 'selected' : ''}>${p}</option>`).join('')}</select>
  <input name="title" value="${esc(i.title)}"><input name="storyPoints" type="number" value="${i.storyPoints ?? ''}" style="width:60px"><button>Save</button>
  <button type="button" id="watch">Watch/Unwatch</button><button type="button" id="del">Delete</button></form>
  <p>${esc(i.description || '')}</p>
  ${i.progress ? `<p>Epic progress: ${i.progress.done}/${i.progress.total} issues, ${i.progress.points_done}/${i.progress.points_total} pts</p>` : ''}
  <h4>Subtasks</h4>${i.children.map(c => `<a href="#" data-key="${c}">${c}</a> `).join('') || '<i>none</i>'}
  <form id="sub" class="row"><input name="title" placeholder="New subtask"><button>Add subtask</button></form>
  <h4>Links</h4>${i.links.map(l => `<div>${esc(l.type)} <a href="#" data-key="${l.key}">${l.key}</a></div>`).join('') || '<i>none</i>'}
  <form id="link" class="row"><select name="type"><option>blocks</option><option>relates</option><option>duplicates</option></select><input name="target" placeholder="ABC-1"><button>Link</button></form>
  <h4>Comments</h4>${comments.map(c => `<div class="card">${esc(c.body)} <small>${esc(c.createdAt)}${c.edited ? ' (edited)' : ''}</small></div>`).join('')}
  <form id="cmt" class="row"><textarea name="body" placeholder="Comment (use @username)"></textarea><button>Comment</button></form>
  <h4>History</h4><table>${hist.map(h => `<tr><td>${esc(h.at)}</td><td>${esc(h.field)}</td><td>${esc(JSON.stringify(h.from))}</td><td>${esc(JSON.stringify(h.to))}</td></tr>`).join('')}</table></div>`;
  $('#back').onclick = () => { st.issueKey = null; render(); };
  m.querySelectorAll('a[data-key]').forEach(a => a.onclick = (e) => { e.preventDefault(); st.issueKey = a.dataset.key; render(); });
  $('#edit').onsubmit = run(async (e) => { e.preventDefault(); const f = form(e.target); await api('PATCH', `/api/issues/${key}`, { status: f.status, priority: f.priority, title: f.title, storyPoints: f.storyPoints === '' ? null : Number(f.storyPoints) }); });
  $('#watch').onclick = run(async () => { await api(i.watchers.includes(st.user.id) ? 'DELETE' : 'POST', `/api/issues/${key}/watch`); });
  $('#del').onclick = run(async () => { if (confirm('Delete issue?')) { await api('DELETE', `/api/issues/${key}`); st.issueKey = null; } });
  $('#sub').onsubmit = run(async (e) => { e.preventDefault(); await api('POST', `/api/projects/${st.project.id}/issues`, { type: 'subtask', title: form(e.target).title, parentId: i.id }); });
  $('#link').onsubmit = run(async (e) => { e.preventDefault(); await api('POST', `/api/issues/${key}/links`, form(e.target)); });
  $('#cmt').onsubmit = run(async (e) => { e.preventDefault(); await api('POST', `/api/issues/${key}/comments`, form(e.target)); });
}

async function renderSettings(m) {
  const p = st.project;
  const [hooks, members] = await Promise.all([api('GET', `/api/projects/${p.id}/webhooks`).catch(() => []), api('GET', `/api/projects/${p.id}/members`)]);
  m.innerHTML = `<div class="panel"><h3>Workflow</h3>
  <textarea id="wf" rows="12" cols="70">${esc(JSON.stringify({ statuses: p.workflow.statuses, transitions: p.workflow.transitions }, null, 2))}</textarea><br>
  <input id="remap" placeholder='remap JSON e.g. {"Old":"New"}' size="40"><button id="saveWf">Save workflow</button></div>
  <div class="panel"><h3>Members</h3>${members.map(x => `<div>${esc(x.username)} — ${x.role}</div>`).join('')}
  <form id="addMem" class="row"><input name="username" placeholder="username"><select name="role"><option>developer</option><option>lead</option><option>viewer</option></select><button>Add</button></form></div>
  <div class="panel"><h3>Webhooks</h3>${hooks.map(h => `<div>${esc(h.url)} [${h.events.join(', ')}] <button data-del="${h.id}">delete</button></div>`).join('')}
  <form id="addHook" class="row"><input name="url" placeholder="https://..."><input name="events" value="issue.created,issue.updated" size="30"><input name="secret" placeholder="secret"><button>Add webhook</button></form></div>
  <div class="panel"><h3>API tokens</h3><form id="addTok" class="row"><input name="name" placeholder="token name"><button>Create</button></form><div id="tokOut"></div></div>`;
  $('#saveWf').onclick = run(async () => {
    const body = JSON.parse($('#wf').value); const r = $('#remap').value.trim(); if (r) body.remap = JSON.parse(r);
    const wf = await api('PUT', `/api/projects/${p.id}/workflow`, body); p.workflow = wf;
  });
  $('#addMem').onsubmit = run(async (e) => { e.preventDefault(); await api('POST', `/api/projects/${p.id}/members`, form(e.target)); });
  $('#addHook').onsubmit = run(async (e) => { e.preventDefault(); const f = form(e.target); await api('POST', `/api/projects/${p.id}/webhooks`, { url: f.url, secret: f.secret, events: f.events.split(',').map(s => s.trim()).filter(Boolean) }); });
  m.querySelectorAll('[data-del]').forEach(b => b.onclick = run(async () => { await api('DELETE', `/api/webhooks/${b.dataset.del}`); }));
  $('#addTok').onsubmit = async (e) => { e.preventDefault(); try { const t = await api('POST', '/api/tokens', form(e.target)); $('#tokOut').textContent = 'Token (shown once): ' + t.token; } catch (err) { $('#tokOut').textContent = err.message; } };
}

async function renderNotifs() {
  const panel = $('#notifPanel');
  let list = [];
  try { list = await api('GET', '/api/notifications'); } catch { /* ignore */ }
  const unread = list.filter(n => !n.read).length;
  const c = $('#nCount'); if (c) c.textContent = unread ? `(${unread})` : '';
  if (!st.notifOpen) { panel.innerHTML = ''; return; }
  panel.innerHTML = `<div class="notif"><button id="readAll">Mark all read</button>${list.map(n => `<div class="${n.read ? '' : 'unread'}">${esc(n.type)} on <a href="#" data-key="${n.issueKey}">${esc(n.issueKey)}</a> <small>${esc(n.at)}</small></div>`).join('') || '<i>No notifications</i>'}</div>`;
  $('#readAll').onclick = run(async () => { await api('POST', '/api/notifications/read', { all: true }); });
  panel.querySelectorAll('a[data-key]').forEach(a => a.onclick = (e) => { e.preventDefault(); st.issueKey = a.dataset.key; st.notifOpen = false; render(); });
}

boot();
