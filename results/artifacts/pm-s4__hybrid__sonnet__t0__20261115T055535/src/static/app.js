const $app = document.getElementById('app');
const st = { token: localStorage.getItem('token'), user: null, ws: [], wsId: null, projects: [], pid: null, view: 'board', issue: null, results: null, notifOpen: false, notifs: [], err: '' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(method, path, body, raw) {
  const r = await fetch(path, { method, headers: { ...(body && !raw ? { 'content-type': 'application/json' } : raw ? { 'content-type': 'text/csv' } : {}), ...(st.token ? { authorization: 'Bearer ' + st.token } : {}) }, body: body ? (raw ? body : JSON.stringify(body)) : undefined });
  const ct = r.headers.get('content-type') || '';
  const data = r.status === 204 ? null : ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(data?.message || r.statusText);
  return data;
}
const proj = () => st.projects.find(p => p.id === st.pid);
async function guard(fn) { try { st.err = ''; await fn(); } catch (e) { st.err = e.message; } render(); }
async function boot() {
  if (st.token) { try { st.user = (await api('GET', '/api/auth/me')).user; await loadWs(); } catch { st.token = null; localStorage.removeItem('token'); } }
  render();
}
async function loadWs() {
  st.ws = await api('GET', '/api/workspaces');
  if (!st.wsId && st.ws.length) st.wsId = st.ws[0].id;
  await loadProjects();
}
async function loadProjects() {
  st.projects = st.wsId ? await api('GET', `/api/workspaces/${st.wsId}/projects`) : [];
  if (!st.projects.find(p => p.id === st.pid)) st.pid = st.projects[0]?.id || null;
  await loadProjectData();
}
async function loadProjectData() {
  st.issues = []; st.sprints = [];
  if (!st.pid) return;
  [st.issues, st.sprints] = await Promise.all([api('GET', `/api/projects/${st.pid}/issues`), api('GET', `/api/projects/${st.pid}/sprints`)]);
}
function render() {
  if (!st.user) return renderAuth();
  const p = proj();
  $app.innerHTML = `<header><b>PM</b>
    <select id="wsSel">${st.ws.map(w => `<option value="${w.id}" ${w.id === st.wsId ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select>
    <button id="newWs">+ Workspace</button>
    <select id="prSel">${st.projects.map(x => `<option value="${x.id}" ${x.id === st.pid ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
    <button id="newPr">+ Project</button>
    <input id="q" placeholder='search e.g. status:"In Progress" -label:x' size="36"><button id="go">Search</button>
    <button id="bell">Notifications</button><span>${esc(st.user.displayName)}</span><button id="logout">Logout</button></header>
    <main>${st.err ? `<p class="err">${esc(st.err)}</p>` : ''}
    ${p ? `<nav>${['board', 'backlog', 'report', 'settings'].map(v => `<button data-view="${v}">${v}</button>`).join('')}<button id="newIssue">+ Issue</button></nav>` : '<p>Create a workspace and a project to begin.</p>'}
    <div id="content"></div></main>${st.notifOpen ? `<div class="notif"><button id="readAll">Mark all read</button>${st.notifs.map(n => `<div class="${n.read ? 'muted' : ''}">${esc(n.type)} on <a href="#" data-open="${esc(n.issueKey)}">${esc(n.issueKey)}</a></div>`).join('') || 'No notifications'}</div>` : ''}`;
  const $ = id => document.getElementById(id);
  $('wsSel').onchange = e => guard(async () => { st.wsId = e.target.value; st.pid = null; await loadProjects(); });
  $('prSel').onchange = e => guard(async () => { st.pid = e.target.value; await loadProjectData(); });
  $('newWs').onclick = () => guard(async () => { const name = prompt('Workspace name'); if (!name) return; const key = prompt('Key (2-10 uppercase letters)'); const w = await api('POST', '/api/workspaces', { name, key }); st.wsId = w.id; await loadWs(); });
  $('newPr').onclick = () => guard(async () => { const name = prompt('Project name'); if (!name) return; const key = prompt('Key'); const x = await api('POST', `/api/workspaces/${st.wsId}/projects`, { name, key }); st.pid = x.id; await loadProjects(); });
  $('go').onclick = () => guard(async () => { st.results = await api('GET', `/api/search?q=${encodeURIComponent($('q').value)}${st.pid ? '&project=' + st.pid : ''}`); st.view = 'search'; });
  $('q').onkeydown = e => { if (e.key === 'Enter') $('go').click(); };
  $('bell').onclick = () => guard(async () => { st.notifOpen = !st.notifOpen; if (st.notifOpen) st.notifs = await api('GET', '/api/notifications'); });
  $('logout').onclick = async () => { try { await api('POST', '/api/auth/logout'); } catch {} st.token = null; st.user = null; localStorage.removeItem('token'); render(); };
  if (st.notifOpen) { $('readAll').onclick = () => guard(async () => { await api('POST', '/api/notifications/read', { all: true }); st.notifs = await api('GET', '/api/notifications'); }); }
  document.querySelectorAll('[data-view]').forEach(b => b.onclick = () => guard(async () => { st.view = b.dataset.view; st.issue = null; await loadProjectData(); }));
  document.querySelectorAll('[data-open]').forEach(a => a.onclick = e => { e.preventDefault(); guard(async () => { st.issue = a.dataset.open; st.view = 'issue'; st.notifOpen = false; }); });
  if ($('newIssue')) $('newIssue').onclick = () => guard(async () => { const title = prompt('Title'); if (!title) return; const type = prompt('Type (bug|feature|task|epic|subtask)', 'task'); await api('POST', `/api/projects/${st.pid}/issues`, { title, type }); await loadProjectData(); });
  if (!p) return;
  const c = $('content');
  ({ board: viewBoard, backlog: viewBacklog, report: viewReport, settings: viewSettings, issue: viewIssue, search: viewSearch }[st.view] || viewBoard)(c, p);
}
function renderAuth() {
  $app.innerHTML = `<div class="auth"><h2>Project Manager</h2>${st.err ? `<div class="err">${esc(st.err)}</div>` : ''}
  <input id="u" placeholder="username"><input id="pw" type="password" placeholder="password"><input id="dn" placeholder="display name (register)">
  <button id="login">Login</button><button id="reg">Register</button></div>`;
  const v = id => document.getElementById(id).value;
  document.getElementById('login').onclick = async () => { try { const r = await api('POST', '/api/auth/login', { username: v('u'), password: v('pw') }); st.token = r.token; st.user = r.user; localStorage.setItem('token', r.token); st.err = ''; await loadWs(); } catch (e) { st.err = e.message; } render(); };
  document.getElementById('reg').onclick = async () => { try { await api('POST', '/api/auth/register', { username: v('u'), password: v('pw'), displayName: v('dn') || undefined }); st.err = 'Registered — now log in.'; } catch (e) { st.err = e.message; } render(); };
}
const card = i => `<div class="card" draggable="true" data-key="${esc(i.key)}"><b>${esc(i.key)}</b> ${esc(i.title)}<div class="muted">${esc(i.type)} · ${esc(i.priority)}${i.storyPoints != null ? ' · ' + i.storyPoints + 'pt' : ''}</div></div>`;
function wireCards(c) { c.querySelectorAll('[data-key]').forEach(el => { el.onclick = () => guard(async () => { st.issue = el.dataset.key; st.view = 'issue'; }); el.ondragstart = e => e.dataTransfer.setData('text/plain', el.dataset.key); }); }
function viewBoard(c, p) {
  c.innerHTML = `<div class="board">${p.workflow.statuses.map(s => `<div class="col" data-status="${esc(s.name)}"><b>${esc(s.name)}</b> <span class="muted">${esc(s.category)}</span>${st.issues.filter(i => i.status === s.name).map(card).join('')}</div>`).join('')}</div>`;
  wireCards(c);
  c.querySelectorAll('.col').forEach(col => {
    col.ondragover = e => { e.preventDefault(); col.classList.add('over'); }; col.ondragleave = () => col.classList.remove('over');
    col.ondrop = e => { e.preventDefault(); const key = e.dataTransfer.getData('text/plain'); guard(async () => { await api('PATCH', `/api/issues/${key}`, { status: col.dataset.status }); await loadProjectData(); }); };
  });
}
function viewBacklog(c) {
  const sp = st.sprints.filter(s => s.state !== 'completed');
  const sec = (title, items, extra = '') => `<div class="panel"><b>${title}</b> ${extra}${items.map(card).join('') || '<div class="muted">empty</div>'}</div>`;
  c.innerHTML = `<div class="panel"><button id="newSprint">+ Sprint</button></div>` +
    sp.map(s => sec(`${esc(s.name)} (${s.state})`, st.issues.filter(i => i.sprintId === s.id), s.state === 'planned' ? `<button data-start="${s.id}">Start</button>` : `<button data-complete="${s.id}">Complete</button>`)).join('') +
    sec('Backlog', st.issues.filter(i => !i.sprintId || !sp.find(s => s.id === i.sprintId)));
  wireCards(c);
  c.querySelectorAll('.card').forEach(el => { el.oncontextmenu = e => { e.preventDefault(); guard(async () => { const names = sp.map(s => s.name).join(', '); const n = prompt('Move to sprint (' + names + ') or blank for backlog'); const s = sp.find(x => x.name === n); await api('PATCH', `/api/issues/${el.dataset.key}`, { sprintId: s ? s.id : null }); await loadProjectData(); }); }; });
  c.querySelector('#newSprint').onclick = () => guard(async () => { const name = prompt('Sprint name'); if (!name) return; await api('POST', `/api/projects/${st.pid}/sprints`, { name, startDate: prompt('Start (YYYY-MM-DD, optional)') || undefined, endDate: prompt('End (YYYY-MM-DD, optional)') || undefined }); await loadProjectData(); });
  c.querySelectorAll('[data-start]').forEach(b => b.onclick = () => guard(async () => { await api('POST', `/api/sprints/${b.dataset.start}/start`); await loadProjectData(); }));
  c.querySelectorAll('[data-complete]').forEach(b => b.onclick = () => guard(async () => { const o = sp.filter(s => s.id !== b.dataset.complete); const n = prompt('Carry over to sprint name or "backlog"', 'backlog'); const t = o.find(s => s.name === n); await api('POST', `/api/sprints/${b.dataset.complete}/complete`, { carryOverTo: t ? t.id : 'backlog' }); await loadProjectData(); }));
}
async function viewReport(c) {
  c.innerHTML = `<div class="panel">Sprint: <select id="spSel">${st.sprints.map(s => `<option value="${s.id}">${esc(s.name)} (${s.state})</option>`).join('')}</select><div id="rep"></div></div>`;
  const load = async () => {
    const id = c.querySelector('#spSel').value; if (!id) return;
    const r = await api('GET', `/api/sprints/${id}/report`);
    const max = Math.max(1, ...r.burndown.map(b => b.remainingPoints)); const W = 400, H = 160, n = r.burndown.length;
    const pts = r.burndown.map((b, k) => `${20 + (n > 1 ? k * (W - 40) / (n - 1) : 0)},${H - 20 - b.remainingPoints / max * (H - 40)}`).join(' ');
    c.querySelector('#rep').innerHTML = `<p>Committed: ${r.committedPoints} · Completed: ${r.completedPoints} (${r.completedIssues} issues) · Carried over: ${r.carriedOver}</p>
      <svg id="burndown" width="${W}" height="${H}" style="background:#fafafa;border:1px solid #ccc"><polyline fill="none" stroke="#0747a6" stroke-width="2" points="${pts}"/>
      ${r.burndown.map((b, k) => `<circle cx="${20 + (n > 1 ? k * (W - 40) / (n - 1) : 0)}" cy="${H - 20 - b.remainingPoints / max * (H - 40)}" r="3"><title>${b.date}: ${b.remainingPoints}</title></circle>`).join('')}</svg>`;
  };
  c.querySelector('#spSel').onchange = () => guard(load); await guard(load);
}
async function viewSearch(c) {
  c.innerHTML = `<div class="panel"><b>Search results</b>${(st.results || []).map(card).join('') || '<div class="muted">none</div>'}</div>`; wireCards(c);
}
async function viewIssue(c) {
  const [i, hist, cms] = await Promise.all([api('GET', `/api/issues/${st.issue}`), api('GET', `/api/issues/${st.issue}/history`), api('GET', `/api/issues/${st.issue}/comments`)]);
  const p = proj();
  c.innerHTML = `<div class="panel"><h3>${esc(i.key)} ${esc(i.title)}</h3><p>${esc(i.description)}</p>
   <div class="row">Status <select id="stSel">${p.workflow.statuses.map(s => `<option ${s.name === i.status ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
   Priority <select id="prio">${['urgent', 'high', 'medium', 'low', 'none'].map(x => `<option ${x === i.priority ? 'selected' : ''}>${x}</option>`).join('')}</select>
   <button id="watch">Watch</button><button id="del">Delete</button></div>
   <div class="muted">type ${esc(i.type)} · labels ${esc(i.labels.join(', '))} · points ${esc(i.storyPoints)} · due ${esc(i.dueDate)}</div>
   ${i.progress ? `<p>Epic progress: ${i.progress.done}/${i.progress.total} issues, ${i.progress.points_done}/${i.progress.points_total} pts</p>` : ''}
   <h4>Subtasks</h4>${i.children.map(k => `<div><a href="#" data-open="${esc(k)}">${esc(k)}</a></div>`).join('') || '<span class="muted">none</span>'}<div><button id="addSub">+ Subtask</button></div>
   <h4>Links</h4>${i.links.map(l => `<div>${esc(l.type)} <a href="#" data-open="${esc(l.key)}">${esc(l.key)}</a></div>`).join('') || '<span class="muted">none</span>'}
   <div><select id="lt"><option>blocks</option><option>relates</option><option>duplicates</option></select><input id="lk" placeholder="KEY-1"><button id="addLink">Link</button></div>
   <h4>Comments</h4>${cms.map(m => `<div class="card">${esc(m.body)} ${m.edited ? '<i>(edited)</i>' : ''}</div>`).join('')}
   <div class="row"><input id="cb" size="50" placeholder="comment (@user to mention)"><button id="addC">Comment</button></div>
   <h4>History</h4><table>${hist.map(h => `<tr><td>${esc(h.at)}</td><td>${esc(h.field)}</td><td>${esc(JSON.stringify(h.from))} → ${esc(JSON.stringify(h.to))}</td></tr>`).join('')}</table></div>`;
  const $ = s => c.querySelector(s); const reload = () => { st.err = ''; render(); };
  $('#stSel').onchange = e => guard(async () => { await api('PATCH', `/api/issues/${i.key}`, { status: e.target.value }); await loadProjectData(); });
  $('#prio').onchange = e => guard(async () => { await api('PATCH', `/api/issues/${i.key}`, { priority: e.target.value }); await loadProjectData(); });
  $('#watch').onclick = () => guard(async () => { await api('POST', `/api/issues/${i.key}/watch`); });
  $('#del').onclick = () => guard(async () => { await api('DELETE', `/api/issues/${i.key}`); st.view = 'board'; await loadProjectData(); });
  $('#addSub').onclick = () => guard(async () => { const t = prompt('Title'); if (t) await api('POST', `/api/projects/${st.pid}/issues`, { title: t, type: 'subtask', parentId: i.id }); await loadProjectData(); });
  $('#addLink').onclick = () => guard(async () => { await api('POST', `/api/issues/${i.key}/links`, { type: $('#lt').value, target: $('#lk').value }); });
  $('#addC').onclick = () => guard(async () => { await api('POST', `/api/issues/${i.key}/comments`, { body: $('#cb').value }); });
  c.querySelectorAll('[data-open]').forEach(a => a.onclick = e => { e.preventDefault(); guard(async () => { st.issue = a.dataset.open; }); });
}
async function viewSettings(c, p) {
  const hooks = await api('GET', `/api/projects/${p.id}/webhooks`).catch(() => []);
  c.innerHTML = `<div class="panel"><h4>Workflow</h4><textarea id="wf" rows="8" cols="60">${esc(JSON.stringify({ statuses: p.workflow.statuses, transitions: p.workflow.transitions }, null, 1))}</textarea>
   <div><input id="remap" placeholder='remap JSON e.g. {"Old":"New"}' size="40"><button id="saveWf">Save workflow</button></div></div>
   <div class="panel"><h4>Members</h4>${p.members.map(m => `<div>${esc(m.username)} — ${esc(m.role)}</div>`).join('')}
   <div class="row"><input id="mu" placeholder="username"><select id="mr"><option>lead</option><option>developer</option><option>viewer</option></select><button id="addM">Add/Set</button></div></div>
   <div class="panel"><h4>Webhooks</h4>${hooks.map(h => `<div>${esc(h.url)} [${esc(h.events.join(','))}]</div>`).join('')}
   <div class="row"><input id="wu" placeholder="https://..."><input id="ws" placeholder="secret"><button id="addH">Add (all events)</button></div></div>
   <div class="panel"><a href="#" id="exp">Export CSV</a> · <input type="file" id="imp"></div>`;
  const $ = s => c.querySelector(s);
  $('#saveWf').onclick = () => guard(async () => { const b = JSON.parse($('#wf').value); if ($('#remap').value) b.remap = JSON.parse($('#remap').value); await api('PUT', `/api/projects/${p.id}/workflow`, b); await loadProjects(); });
  $('#addM').onclick = () => guard(async () => { await api('POST', `/api/projects/${p.id}/members`, { username: $('#mu').value, role: $('#mr').value }); await loadProjects(); });
  $('#addH').onclick = () => guard(async () => { await api('POST', `/api/projects/${p.id}/webhooks`, { url: $('#wu').value, secret: $('#ws').value, events: ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'] }); });
  $('#exp').onclick = e => { e.preventDefault(); guard(async () => { const t = await api('GET', `/api/projects/${p.id}/export.csv`); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([t], { type: 'text/csv' })); a.download = p.key + '.csv'; a.click(); }); };
  $('#imp').onchange = e => guard(async () => { const t = await e.target.files[0].text(); const r = await api('POST', `/api/projects/${p.id}/import.csv`, t, true); st.err = `Imported ${r.created}; errors: ${r.errors.map(x => x.line + ':' + x.message).join('; ') || 'none'}`; await loadProjectData(); });
}
boot();
