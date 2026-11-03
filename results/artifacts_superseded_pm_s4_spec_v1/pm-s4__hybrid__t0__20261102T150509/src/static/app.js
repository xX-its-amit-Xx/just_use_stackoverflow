const $app = document.getElementById('app');
const S = { token: localStorage.getItem('token'), user: null, ws: [], wsId: null, projects: [], projId: null, view: 'board', issueKey: null, notif: false, msg: '' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json', ...(S.token ? { authorization: 'Bearer ' + S.token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) throw new Error((data && data.message) || r.statusText);
  return data;
}
const proj = () => S.projects.find(p => p.id === S.projId);
async function boot() {
  if (!S.token) return render();
  try { S.user = await api('GET', '/api/auth/me'); S.ws = await api('GET', '/api/workspaces'); if (!S.wsId && S.ws[0]) S.wsId = S.ws[0].id; await loadProjects(); } catch { S.token = null; localStorage.removeItem('token'); }
  render();
}
async function loadProjects() {
  S.projects = S.wsId ? await api('GET', `/api/workspaces/${S.wsId}/projects`) : [];
  if (!proj()) S.projId = S.projects[0]?.id || null;
}
const act = async (fn) => { try { S.msg = ''; await fn(); } catch (e) { S.msg = e.message; } render(); };
function on(id, ev, fn) { const el = document.getElementById(id); if (el) el.addEventListener(ev, fn); }
const val = (id) => document.getElementById(id)?.value;

function render() { (async () => { $app.innerHTML = S.token && S.user ? await shell() : authView(); bind(); })(); }

function authView() {
  return `<main><div class="panel"><h2>pm-s4</h2><div class="err">${esc(S.msg)}</div>
  <div class="row"><input id="u" placeholder="username"><input id="p" type="password" placeholder="password"></div>
  <div class="row"><button id="login">Login</button><button id="register">Register</button></div></div></main>`;
}
async function shell() {
  let body = '';
  try { body = await view(); } catch (e) { body = `<div class="err">${esc(e.message)}</div>`; }
  const unread = await api('GET', '/api/notifications?unread=true').catch(() => []);
  return `<header><b>pm-s4</b>
  <select id="wsSel">${S.ws.map(w => `<option value="${w.id}" ${w.id === S.wsId ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select>
  <button id="newWs">+ Workspace</button>
  <select id="prSel">${S.projects.map(p => `<option value="${p.id}" ${p.id === S.projId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
  <button id="newPr">+ Project</button>
  <input id="q" placeholder='search e.g. status:"In Progress" -label:x' size="36"><button id="doSearch">Search</button>
  <button id="bell">Notifications (${unread.length})</button><span>${esc(S.user.username)}</span><button id="logout">Logout</button></header>
  ${S.notif ? `<div class="notif">${unread.map(n => `<div>${esc(n.type)} <span class="link" data-issue="${esc(n.issueKey)}">${esc(n.issueKey)}</span></div>`).join('') || 'No unread'}<button id="readAll">Mark all read</button></div>` : ''}
  <main><div class="err">${esc(S.msg)}</div>
  <nav>${['board', 'backlog', 'report', 'settings'].map(v => `<button data-view="${v}">${v}</button>`).join('')}</nav>${body}</main>`;
}
async function view() {
  if (S.issueKey) return issueView();
  if (S.view === 'search') return S.results || '';
  const p = proj(); if (!p) return '<p>Create a workspace and project to begin.</p>';
  if (S.view === 'board') return boardView(p);
  if (S.view === 'backlog') return backlogView(p);
  if (S.view === 'report') return reportView(p);
  return settingsView(p);
}
const issueCard = (i) => `<div class="card" draggable="true" data-key="${esc(i.key)}"><span class="link" data-issue="${esc(i.key)}">${esc(i.key)}</span> ${esc(i.title)}<br><small>${esc(i.type)} · ${esc(i.priority)}${i.storyPoints != null ? ' · ' + i.storyPoints + 'pt' : ''}</small></div>`;
async function boardView(p) {
  const issues = await api('GET', `/api/projects/${p.id}/issues`);
  return `<div class="row"><input id="nt" placeholder="New issue title"><select id="ntype">${['task', 'bug', 'feature', 'epic'].map(t => `<option>${t}</option>`).join('')}</select><button id="addIssue">Add</button></div>
  <div class="board">${p.workflow.statuses.map(s => `<div class="col" data-status="${esc(s.name)}"><b>${esc(s.name)}</b>${issues.filter(i => i.status === s.name).map(issueCard).join('')}</div>`).join('')}</div>`;
}
async function backlogView(p) {
  const [issues, sprints] = await Promise.all([api('GET', `/api/projects/${p.id}/issues`), api('GET', `/api/projects/${p.id}/sprints`)]);
  const sel = (i) => `<select data-assign="${esc(i.key)}"><option value="">backlog</option>${sprints.filter(s => s.state !== 'completed').map(s => `<option value="${s.id}" ${i.sprintId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`;
  const group = (title, list, extra = '') => `<div class="panel"><b>${title}</b> ${extra}${list.map(i => `<div class="row">${issueCard(i)}${sel(i)}</div>`).join('')}</div>`;
  return `<div class="panel"><div class="row"><input id="spName" placeholder="Sprint name"><input id="spStart" type="date"><input id="spEnd" type="date"><button id="addSprint">Create sprint</button></div></div>
  ${sprints.filter(s => s.state !== 'completed').map(s => group(`${esc(s.name)} (${s.state})`, issues.filter(i => i.sprintId === s.id), s.state === 'planned' ? `<button data-start="${s.id}">Start</button>` : `<button data-complete="${s.id}">Complete</button>`)).join('')}
  ${group('Backlog', issues.filter(i => !i.sprintId))}`;
}
async function reportView(p) {
  const sprints = await api('GET', `/api/projects/${p.id}/sprints`);
  if (!sprints.length) return '<p>No sprints.</p>';
  const id = S.sprintId && sprints.find(s => s.id === S.sprintId) ? S.sprintId : sprints[sprints.length - 1].id;
  const r = await api('GET', `/api/sprints/${id}/report`);
  const stats = await api('GET', `/api/projects/${p.id}/stats`);
  const W = 500, H = 200, max = Math.max(1, ...r.burndown.map(b => b.remainingPoints)), n = Math.max(1, r.burndown.length - 1);
  const pts = r.burndown.map((b, k) => `${30 + k * (W - 40) / n},${H - 20 - b.remainingPoints / max * (H - 40)}`).join(' ');
  return `<div class="panel"><select id="spSel">${sprints.map(s => `<option value="${s.id}" ${s.id === id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
  <p>Committed ${r.committedPoints} · Completed ${r.completedPoints} (${r.completedIssues} issues) · Carried over ${r.carriedOver}</p>
  <svg id="burndown" width="${W}" height="${H}" style="background:#fff;border:1px solid #ccc"><polyline fill="none" stroke="#0052cc" stroke-width="2" points="${pts}"/>${r.burndown.map((b, k) => `<text x="${30 + k * (W - 40) / n}" y="${H - 4}" font-size="9">${esc(b.date.slice(5))}</text>`).join('')}<text x="2" y="14" font-size="10">${max}</text></svg>
  <pre>${esc(JSON.stringify(stats, null, 1))}</pre></div>`;
}
async function issueView() {
  const i = await api('GET', `/api/issues/${S.issueKey}`);
  const [hist, comments] = await Promise.all([api('GET', `/api/issues/${i.key}/history`), api('GET', `/api/issues/${i.key}/comments`)]);
  const p = S.projects.find(x => x.id === i.projectId) || proj();
  return `<div class="panel"><button id="back">← Back</button><h2>${esc(i.key)} ${esc(i.title)}</h2>
  <div class="row"><select id="stSel">${p.workflow.statuses.map(s => `<option ${s.name === i.status ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
  <select id="prioSel">${['urgent', 'high', 'medium', 'low', 'none'].map(x => `<option ${x === i.priority ? 'selected' : ''}>${x}</option>`).join('')}</select>
  <button id="watch">Watch</button><button id="unwatch">Unwatch</button><button id="delIssue">Delete</button></div>
  <p>${esc(i.description)}</p>
  ${i.progress ? `<p>Epic progress: ${i.progress.done}/${i.progress.total} (${i.progress.points_done}/${i.progress.points_total} pts)</p>` : ''}
  <h3>Subtasks</h3>${i.children.map(k => `<div><span class="link" data-issue="${esc(k)}">${esc(k)}</span></div>`).join('')}
  <div class="row"><input id="subT" placeholder="Subtask title"><button id="addSub">Add subtask</button></div>
  <h3>Links</h3>${i.links.map(l => `<div>${esc(l.type)} <span class="link" data-issue="${esc(l.target)}">${esc(l.target)}</span></div>`).join('')}
  <div class="row"><select id="lnType"><option>blocks</option><option>relates</option><option>duplicates</option></select><input id="lnTarget" placeholder="KEY-1"><button id="addLink">Link</button></div>
  <h3>Comments</h3>${comments.map(c => `<div><b>${esc(c.authorId === S.user.id ? S.user.username : c.authorId.slice(0, 6))}</b>: ${esc(c.body)}${c.edited ? ' (edited)' : ''}</div>`).join('')}
  <div class="row"><textarea id="cmt" placeholder="Comment (use @username)"></textarea><button id="addCmt">Comment</button></div>
  <h3>History</h3>${hist.map(h => `<div><small>${esc(h.at)} ${esc(h.field)}: ${esc(JSON.stringify(h.from))} → ${esc(JSON.stringify(h.to))}</small></div>`).join('')}</div>`;
}
async function settingsView(p) {
  const hooks = await api('GET', `/api/projects/${p.id}/webhooks`).catch(() => []);
  const wf = JSON.stringify({ statuses: p.workflow.statuses, transitions: p.workflow.transitions, remap: {} }, null, 1);
  return `<div class="panel"><h3>Workflow (JSON editor)</h3><textarea id="wf" rows="12" cols="70">${esc(wf)}</textarea><div><button id="saveWf">Save workflow</button></div></div>
  <div class="panel"><h3>Members</h3>${p.members.map(m => `<div>${esc(m.username)} — ${esc(m.role)}</div>`).join('') || '<i>none explicit</i>'}
  <div class="row"><input id="mUser" placeholder="username"><select id="mRole"><option>developer</option><option>lead</option><option>viewer</option></select><button id="addMember">Add / set role</button></div></div>
  <div class="panel"><h3>Webhooks</h3>${hooks.map(h => `<div>${esc(h.url)} [${esc(h.events.join(','))}] <button data-delhook="${h.id}">Delete</button></div>`).join('')}
  <div class="row"><input id="hUrl" placeholder="https://..."><input id="hSecret" placeholder="secret"><input id="hEvents" value="issue.created,issue.updated"><button id="addHook">Add webhook</button></div></div>`;
}

function bind() {
  on('login', 'click', () => act(async () => { const r = await api('POST', '/api/auth/login', { username: val('u'), password: val('p') }); S.token = r.token; localStorage.setItem('token', r.token); await boot(); }));
  on('register', 'click', () => act(async () => { await api('POST', '/api/auth/register', { username: val('u'), password: val('p') }); const r = await api('POST', '/api/auth/login', { username: val('u'), password: val('p') }); S.token = r.token; localStorage.setItem('token', r.token); await boot(); }));
  on('logout', 'click', () => act(async () => { await api('POST', '/api/auth/logout').catch(() => {}); S.token = null; S.user = null; localStorage.removeItem('token'); }));
  on('wsSel', 'change', () => act(async () => { S.wsId = val('wsSel'); S.projId = null; await loadProjects(); }));
  on('prSel', 'change', () => { S.projId = val('prSel'); S.issueKey = null; render(); });
  on('newWs', 'click', () => act(async () => { const name = prompt('Workspace name'); const key = name && prompt('Key (2-10 uppercase letters)'); if (!key) return; const w = await api('POST', '/api/workspaces', { name, key }); S.ws.push(w); S.wsId = w.id; await loadProjects(); }));
  on('newPr', 'click', () => act(async () => { const name = prompt('Project name'); const key = name && prompt('Key (2-10 uppercase letters)'); if (!key) return; const p = await api('POST', `/api/workspaces/${S.wsId}/projects`, { name, key }); await loadProjects(); S.projId = p.id; }));
  on('bell', 'click', () => { S.notif = !S.notif; render(); });
  on('readAll', 'click', () => act(async () => { await api('POST', '/api/notifications/read', { all: true }); }));
  on('doSearch', 'click', () => act(async () => {
    const q = encodeURIComponent(val('q')); const list = await api('GET', `/api/search?q=${q}`);
    S.view = 'search'; S.issueKey = null; S.results = `<div class="panel"><b>${list.length} results</b>${list.map(issueCard).join('')}</div>`;
  }));
  on('back', 'click', () => { S.issueKey = null; render(); });
  document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => { S.view = b.dataset.view; S.issueKey = null; render(); }));
  document.querySelectorAll('[data-issue]').forEach(b => b.addEventListener('click', () => { S.issueKey = b.dataset.issue; S.notif = false; render(); }));
  on('addIssue', 'click', () => act(async () => { await api('POST', `/api/projects/${S.projId}/issues`, { type: val('ntype'), title: val('nt') }); }));
  // drag and drop
  document.querySelectorAll('.card[data-key]').forEach(c => c.addEventListener('dragstart', e => e.dataTransfer.setData('text/plain', c.dataset.key)));
  document.querySelectorAll('.col').forEach(col => {
    col.addEventListener('dragover', e => e.preventDefault());
    col.addEventListener('drop', e => { e.preventDefault(); const key = e.dataTransfer.getData('text/plain'); act(() => api('PATCH', `/api/issues/${key}`, { status: col.dataset.status })); });
  });
  document.querySelectorAll('[data-assign]').forEach(s => s.addEventListener('change', () => act(() => api('PATCH', `/api/issues/${s.dataset.assign}`, { sprintId: s.value || null }))));
  on('addSprint', 'click', () => act(() => api('POST', `/api/projects/${S.projId}/sprints`, { name: val('spName'), startDate: val('spStart') || undefined, endDate: val('spEnd') || undefined })));
  document.querySelectorAll('[data-start]').forEach(b => b.addEventListener('click', () => act(() => api('POST', `/api/sprints/${b.dataset.start}/start`))));
  document.querySelectorAll('[data-complete]').forEach(b => b.addEventListener('click', () => act(() => api('POST', `/api/sprints/${b.dataset.complete}/complete`, { carryOverTo: 'backlog' }))));
  on('spSel', 'change', () => { S.sprintId = val('spSel'); render(); });
  on('stSel', 'change', () => act(() => api('PATCH', `/api/issues/${S.issueKey}`, { status: val('stSel') })));
  on('prioSel', 'change', () => act(() => api('PATCH', `/api/issues/${S.issueKey}`, { priority: val('prioSel') })));
  on('watch', 'click', () => act(() => api('POST', `/api/issues/${S.issueKey}/watch`)));
  on('unwatch', 'click', () => act(() => api('DELETE', `/api/issues/${S.issueKey}/watch`)));
  on('delIssue', 'click', () => act(async () => { await api('DELETE', `/api/issues/${S.issueKey}`); S.issueKey = null; }));
  on('addSub', 'click', () => act(async () => { const i = await api('GET', `/api/issues/${S.issueKey}`); await api('POST', `/api/projects/${i.projectId}/issues`, { type: 'subtask', title: val('subT'), parentId: i.id }); }));
  on('addLink', 'click', () => act(() => api('POST', `/api/issues/${S.issueKey}/links`, { type: val('lnType'), target: val('lnTarget') })));
  on('addCmt', 'click', () => act(() => api('POST', `/api/issues/${S.issueKey}/comments`, { body: val('cmt') })));
  on('saveWf', 'click', () => act(async () => { await api('PUT', `/api/projects/${S.projId}/workflow`, JSON.parse(val('wf'))); await loadProjects(); }));
  on('addMember', 'click', () => act(async () => { await api('POST', `/api/projects/${S.projId}/members`, { username: val('mUser'), role: val('mRole') }); await loadProjects(); }));
  on('addHook', 'click', () => act(() => api('POST', `/api/projects/${S.projId}/webhooks`, { url: val('hUrl'), secret: val('hSecret'), events: val('hEvents').split(',').map(s => s.trim()) })));
  document.querySelectorAll('[data-delhook]').forEach(b => b.addEventListener('click', () => act(() => api('DELETE', `/api/webhooks/${b.dataset.delhook}`))));
}
boot();
