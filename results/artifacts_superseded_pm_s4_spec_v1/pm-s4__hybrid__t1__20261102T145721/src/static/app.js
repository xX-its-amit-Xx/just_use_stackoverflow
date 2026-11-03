const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const S = { token: localStorage.getItem('token'), ws: null, project: null, view: 'board', issue: null, msg: '' };
async function api(method, path, body, raw) {
  const r = await fetch(path, { method, headers: { ...(body && !raw ? { 'content-type': 'application/json' } : raw ? { 'content-type': 'text/csv' } : {}), ...(S.token ? { authorization: 'Bearer ' + S.token } : {}) }, body: body ? (raw ? body : JSON.stringify(body)) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error((j && j.message) || r.statusText);
  return j;
}
const app = $('#app');
function setMsg(m) { S.msg = m; }
async function render() {
  if (!S.token) return renderAuth();
  let workspaces = [], projects = [], notifs = [];
  try { workspaces = await api('GET', '/api/workspaces'); } catch { S.token = null; localStorage.removeItem('token'); return renderAuth(); }
  if (!S.ws && workspaces[0]) S.ws = workspaces[0].id;
  if (S.ws) projects = await api('GET', `/api/workspaces/${S.ws}/projects`);
  if (!S.project && projects[0]) S.project = projects[0].id;
  notifs = await api('GET', '/api/notifications?unread=true');
  app.innerHTML = `<header><b>PM</b>
    <select id="ws">${workspaces.map(w => `<option value="${w.id}" ${w.id === S.ws ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select><button id="newws">+ws</button>
    <select id="pr">${projects.map(p => `<option value="${p.id}" ${p.id === S.project ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select><button id="newpr">+project</button>
    <input id="q" placeholder='search: status:"In Progress" type:bug'><button id="go">Search</button>
    <button id="notif">Notifications (${notifs.length})</button><button id="logout">Logout</button></header>
    <main><nav><button data-v="board">Board</button><button data-v="backlog">Backlog</button><button data-v="report">Sprint report</button><button data-v="settings">Settings</button></nav>
    <div class="err">${esc(S.msg)}</div><div id="view"></div></main>`;
  S.msg = '';
  $('#ws').onchange = e => { S.ws = e.target.value; S.project = null; render(); };
  $('#pr').onchange = e => { S.project = e.target.value; render(); };
  $('#newws').onclick = async () => { const name = prompt('Workspace name'), key = prompt('Key (2-10 capital letters)'); if (name && key) try { const w = await api('POST', '/api/workspaces', { name, key }); S.ws = w.id; S.project = null; } catch (e) { setMsg(e.message); } render(); };
  $('#newpr').onclick = async () => { const name = prompt('Project name'), key = prompt('Key'); if (name && key) try { const p = await api('POST', `/api/workspaces/${S.ws}/projects`, { name, key }); S.project = p.id; } catch (e) { setMsg(e.message); } render(); };
  $('#logout').onclick = async () => { try { await api('POST', '/api/auth/logout'); } catch {} S.token = null; localStorage.removeItem('token'); render(); };
  $('#go').onclick = () => { S.view = 'search'; S.q = $('#q').value; render(); };
  $('#notif').onclick = () => { S.view = 'notifs'; render(); };
  app.querySelectorAll('nav button').forEach(b => b.onclick = () => { S.view = b.dataset.v; S.issue = null; render(); });
  const proj = projects.find(p => p.id === S.project);
  const v = $('#view');
  try {
    if (S.issue) return await renderIssue(v);
    if (S.view === 'notifs') return await renderNotifs(v);
    if (S.view === 'search') return await renderSearch(v);
    if (!proj) { v.innerHTML = '<p>Create a workspace and project to begin.</p>'; return; }
    if (S.view === 'board') await renderBoard(v, proj);
    else if (S.view === 'backlog') await renderBacklog(v, proj);
    else if (S.view === 'report') await renderReport(v, proj);
    else if (S.view === 'settings') await renderSettings(v, proj);
  } catch (e) { v.innerHTML = `<p class="err">${esc(e.message)}</p>`; }
}
function renderAuth() {
  app.innerHTML = `<main><div class="panel"><h2>Login / Register</h2><input id="u" placeholder="username"><input id="p" type="password" placeholder="password">
  <button id="li">Login</button><button id="re">Register</button><div class="err" id="e">${esc(S.msg)}</div></div></main>`;
  const cred = () => ({ username: $('#u').value, password: $('#p').value });
  $('#li').onclick = async () => { try { const r = await api('POST', '/api/auth/login', cred()); S.token = r.token; localStorage.setItem('token', r.token); S.msg = ''; render(); } catch (e) { $('#e').textContent = e.message; } };
  $('#re').onclick = async () => { try { await api('POST', '/api/auth/register', cred()); $('#li').click(); } catch (e) { $('#e').textContent = e.message; } };
}
const card = (i) => `<div class="card" draggable="true" data-id="${i.key}"><a href="#" data-open="${i.key}">${esc(i.key)}</a> ${esc(i.title)}<div class="small">${esc(i.type)} · ${esc(i.priority)} ${i.storyPoints != null ? '· ' + i.storyPoints + 'pt' : ''}</div></div>`;
function bindOpen(root) { root.querySelectorAll('[data-open]').forEach(a => a.onclick = e => { e.preventDefault(); S.issue = a.dataset.open; render(); }); }
async function addIssueForm(root, proj) {
  const f = document.createElement('div'); f.className = 'panel';
  f.innerHTML = `<input id="nt" placeholder="New issue title"><select id="ty">${['task', 'bug', 'feature', 'epic'].map(t => `<option>${t}</option>`).join('')}</select><button id="ni">Create</button>`;
  root.prepend(f);
  $('#ni', f).onclick = async () => { try { await api('POST', `/api/projects/${proj.id}/issues`, { title: $('#nt', f).value, type: $('#ty', f).value }); } catch (e) { setMsg(e.message); } render(); };
}
async function renderBoard(v, proj) {
  const issues = await api('GET', `/api/projects/${proj.id}/issues`);
  v.innerHTML = `<div class="board">${proj.workflow.statuses.map(s => `<div class="col" data-status="${esc(s.name)}"><b>${esc(s.name)}</b>${issues.filter(i => i.status === s.name).map(card).join('')}</div>`).join('')}</div>`;
  v.querySelectorAll('.card').forEach(c => c.ondragstart = e => e.dataTransfer.setData('text/plain', c.dataset.id));
  v.querySelectorAll('.col').forEach(c => {
    c.ondragover = e => { e.preventDefault(); c.classList.add('over'); };
    c.ondragleave = () => c.classList.remove('over');
    c.ondrop = async e => { e.preventDefault(); try { await api('PATCH', `/api/issues/${e.dataTransfer.getData('text/plain')}`, { status: c.dataset.status }); } catch (er) { setMsg(er.message); } render(); };
  });
  bindOpen(v); addIssueForm(v, proj);
}
async function renderBacklog(v, proj) {
  const [issues, sprints] = await Promise.all([api('GET', `/api/projects/${proj.id}/issues`), api('GET', `/api/projects/${proj.id}/sprints`)]);
  const sel = (i) => `<select data-mv="${i.key}"><option value="">Backlog</option>${sprints.filter(s => s.state !== 'completed').map(s => `<option value="${s.id}" ${i.sprintId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`;
  const row = (i) => `<div class="card">${card(i)}${sel(i)}</div>`;
  v.innerHTML = `<div class="panel"><input id="sn" placeholder="Sprint name"><input id="sd" type="date"><input id="ed" type="date"><button id="ns">Create sprint</button></div>
   ${sprints.map(s => `<div class="panel"><b>${esc(s.name)}</b> [${s.state}] ${s.state === 'planned' ? `<button data-start="${s.id}">Start</button>` : ''}${s.state === 'active' ? `<button data-done="${s.id}">Complete</button>` : ''}${issues.filter(i => i.sprintId === s.id).map(row).join('')}</div>`).join('')}
   <div class="panel"><b>Backlog</b>${issues.filter(i => !i.sprintId).map(row).join('')}</div>`;
  $('#ns').onclick = async () => { try { await api('POST', `/api/projects/${proj.id}/sprints`, { name: $('#sn').value, startDate: $('#sd').value || undefined, endDate: $('#ed').value || undefined }); } catch (e) { setMsg(e.message); } render(); };
  v.querySelectorAll('[data-start]').forEach(b => b.onclick = async () => { try { await api('POST', `/api/sprints/${b.dataset.start}/start`); } catch (e) { setMsg(e.message); } render(); });
  v.querySelectorAll('[data-done]').forEach(b => b.onclick = async () => { try { await api('POST', `/api/sprints/${b.dataset.done}/complete`, { carryOverTo: 'backlog' }); } catch (e) { setMsg(e.message); } render(); });
  v.querySelectorAll('[data-mv]').forEach(s => s.onchange = async () => { try { await api('PATCH', `/api/issues/${s.dataset.mv}`, { sprintId: s.value || null }); } catch (e) { setMsg(e.message); } render(); });
  bindOpen(v);
}
async function renderReport(v, proj) {
  const sprints = await api('GET', `/api/projects/${proj.id}/sprints`);
  const sp = sprints.find(s => s.state === 'active') || sprints[sprints.length - 1];
  if (!sp) { v.innerHTML = '<p>No sprints.</p>'; return; }
  const r = await api('GET', `/api/sprints/${sp.id}/report`);
  const W = 500, H = 200, n = r.burndown.length, max = Math.max(1, r.committedPoints, ...r.burndown.map(b => b.remainingPoints));
  const pts = r.burndown.map((b, i) => `${20 + (n > 1 ? i * (W - 40) / (n - 1) : 0)},${H - 20 - b.remainingPoints / max * (H - 40)}`).join(' ');
  v.innerHTML = `<div class="panel"><h3>${esc(sp.name)} (${sp.state})</h3><p>Committed ${r.committedPoints} · Completed ${r.completedPoints} · Issues done ${r.completedIssues} · Carried over ${r.carriedOver}</p>
  <svg width="${W}" height="${H}" style="background:#fff;border:1px solid #ccc"><polyline fill="none" stroke="#0747a6" stroke-width="2" points="${pts}"/>${r.burndown.map((b, i) => `<circle r="3" cx="${20 + (n > 1 ? i * (W - 40) / (n - 1) : 0)}" cy="${H - 20 - b.remainingPoints / max * (H - 40)}"><title>${b.date}: ${b.remainingPoints}</title></circle>`).join('')}</svg></div>`;
}
async function renderIssue(v) {
  const i = await api('GET', `/api/issues/${S.issue}`);
  const [hist, comments] = await Promise.all([api('GET', `/api/issues/${i.key}/history`), api('GET', `/api/issues/${i.key}/comments`)]);
  v.innerHTML = `<div class="panel"><button id="back">&larr; back</button><h2>${esc(i.key)} ${esc(i.title)}</h2><p>${esc(i.description)}</p>
   <p>${esc(i.type)} · ${esc(i.status)} · ${esc(i.priority)} · points ${i.storyPoints ?? '-'}</p>
   <p>Subtasks: ${i.children.map(c => `<a href="#" data-open="${c}">${c}</a>`).join(', ') || 'none'} <button id="addsub">+ subtask</button></p>
   ${i.progress ? `<p>Epic progress: ${i.progress.done}/${i.progress.total} (${i.progress.points_done}/${i.progress.points_total} pts)</p>` : ''}
   <h4>Links</h4>${i.links.map(l => `<div>${esc(l.type)} <a href="#" data-open="${l.key}">${esc(l.key)}</a></div>`).join('')}
   <select id="lt"><option>blocks</option><option>relates</option><option>duplicates</option></select><input id="lk" placeholder="KEY-1"><button id="al">Add link</button>
   <button id="watch">Watch</button>
   <h4>Comments</h4>${comments.map(c => `<div class="card">${esc(c.body)}${c.edited ? ' <i>(edited)</i>' : ''}<div class="small">${c.createdAt}</div></div>`).join('')}
   <textarea id="cb"></textarea><button id="ac">Comment</button>
   <h4>History</h4>${hist.map(h => `<div class="small">${h.at} ${esc(h.field)}: ${esc(JSON.stringify(h.from))} → ${esc(JSON.stringify(h.to))}</div>`).join('')}</div>`;
  const act = (fn) => async () => { try { await fn(); } catch (e) { setMsg(e.message); } render(); };
  $('#back').onclick = () => { S.issue = null; render(); };
  $('#ac').onclick = act(() => api('POST', `/api/issues/${i.key}/comments`, { body: $('#cb').value }));
  $('#al').onclick = act(() => api('POST', `/api/issues/${i.key}/links`, { type: $('#lt').value, target: $('#lk').value }));
  $('#watch').onclick = act(() => api('POST', `/api/issues/${i.key}/watch`));
  $('#addsub').onclick = act(() => { const t = prompt('Subtask title'); return t ? api('POST', `/api/projects/${i.projectId}/issues`, { type: 'subtask', title: t, parentId: i.id }) : null; });
  bindOpen(v);
}
async function renderNotifs(v) {
  const n = await api('GET', '/api/notifications');
  v.innerHTML = `<div class="panel"><h3>Notifications</h3><button id="all">Mark all read</button>${n.map(x => `<div class="card" style="opacity:${x.read ? .5 : 1}">${esc(x.type)} on <a href="#" data-open="${esc(x.issueKey)}">${esc(x.issueKey)}</a> <span class="small">${x.at}</span></div>`).join('') || '<p>None</p>'}</div>`;
  $('#all').onclick = async () => { await api('POST', '/api/notifications/read', { all: true }); render(); };
  bindOpen(v);
}
async function renderSearch(v) {
  let res = [];
  try { res = await api('GET', '/api/search?q=' + encodeURIComponent(S.q || '') + (S.project ? '&project=' + S.project : '')); } catch (e) { v.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  v.innerHTML = `<div class="panel"><h3>Results (${res.length})</h3>${res.map(card).join('')}</div>`; bindOpen(v);
}
async function renderSettings(v, proj) {
  const hooks = await api('GET', `/api/projects/${proj.id}/webhooks`).catch(() => []);
  v.innerHTML = `<div class="panel"><h3>Workflow</h3><textarea id="wf" rows="8" cols="60">${esc(JSON.stringify(proj.workflow, null, 2))}</textarea><br><input id="rm" placeholder='remap JSON e.g. {"Old":"New"}'><button id="sw">Save workflow</button></div>
  <div class="panel"><h3>Members</h3>${proj.members.map(m => `<div>${esc(m.username)} — ${m.role}</div>`).join('')}<input id="mu" placeholder="username"><select id="mr"><option>developer</option><option>lead</option><option>viewer</option></select><button id="am">Add</button></div>
  <div class="panel"><h3>Webhooks</h3>${hooks.map(h => `<div>${esc(h.url)} [${h.events.join(',')}] <button data-del="${h.id}">x</button></div>`).join('')}<input id="hu" placeholder="https://..."><input id="hs" placeholder="secret"><button id="ah">Add webhook</button></div>`;
  const act = (fn) => async () => { try { await fn(); } catch (e) { setMsg(e.message); } render(); };
  $('#sw').onclick = act(async () => { const w = JSON.parse($('#wf').value); const rm = $('#rm').value; await api('PUT', `/api/projects/${proj.id}/workflow`, { ...w, remap: rm ? JSON.parse(rm) : undefined }); });
  $('#am').onclick = act(() => api('POST', `/api/projects/${proj.id}/members`, { username: $('#mu').value, role: $('#mr').value }));
  $('#ah').onclick = act(() => api('POST', `/api/projects/${proj.id}/webhooks`, { url: $('#hu').value, secret: $('#hs').value, events: ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'] }));
  v.querySelectorAll('[data-del]').forEach(b => b.onclick = act(() => api('DELETE', `/api/webhooks/${b.dataset.del}`)));
}
render();
