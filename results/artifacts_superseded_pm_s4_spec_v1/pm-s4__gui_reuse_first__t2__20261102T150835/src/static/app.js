const $ = (s) => document.querySelector(s);
const S = { token: localStorage.getItem('pm_token'), me: null, ws: [], wsId: null, projects: [], pid: null, view: 'board', issue: null, err: '', q: '', notifs: null };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function api(method, path, body, raw) {
  const r = await fetch(path, { method, headers: { ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}), ...(S.token ? { authorization: 'Bearer ' + S.token } : {}) }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch { d = t; }
  if (!r.ok) throw new Error(d?.message || r.statusText);
  return d;
}
const proj = () => S.projects.find((p) => p.id === S.pid);
async function guard(fn) { try { S.err = ''; await fn(); } catch (e) { S.err = e.message; } render(); }
async function boot() {
  if (S.token) { try { S.me = await api('GET', '/api/auth/me'); await loadWs(); } catch { S.token = null; localStorage.removeItem('pm_token'); } }
  render();
}
async function loadWs() {
  S.ws = await api('GET', '/api/workspaces'); if (!S.wsId || !S.ws.some((w) => w.id === S.wsId)) S.wsId = S.ws[0]?.id || null; await loadProjects();
}
async function loadProjects() {
  S.projects = S.wsId ? await api('GET', `/api/workspaces/${S.wsId}/projects`) : []; if (!proj()) S.pid = S.projects[0]?.id || null;
}
function render() {
  const app = $('#app');
  if (!S.me) {
    app.innerHTML = `<main><div class="panel"><h2>pm-s4</h2><p class="err">${esc(S.err)}</p>
    <input id="u" placeholder="username"> <input id="p" type="password" placeholder="password">
    <button id="login">Login</button> <button id="reg">Register</button></div></main>`;
    $('#login').onclick = () => guard(async () => { const r = await api('POST', '/api/auth/login', { username: $('#u').value, password: $('#p').value }); S.token = r.token; localStorage.setItem('pm_token', r.token); S.me = r.user; await loadWs(); });
    $('#reg').onclick = () => guard(async () => { await api('POST', '/api/auth/register', { username: $('#u').value, password: $('#p').value }); const r = await api('POST', '/api/auth/login', { username: $('#u').value, password: $('#p').value }); S.token = r.token; localStorage.setItem('pm_token', r.token); S.me = r.user; await loadWs(); });
    return;
  }
  app.innerHTML = `<header><b>pm-s4</b>
   <select id="wsel">${S.ws.map((w) => `<option value="${w.id}" ${w.id === S.wsId ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select><button id="newws">+ws</button>
   <select id="psel">${S.projects.map((p) => `<option value="${p.id}" ${p.id === S.pid ? 'selected' : ''}>${esc(p.key)} ${esc(p.name)}</option>`).join('')}</select><button id="newp">+project</button>
   <span class="tabs"><button data-v="board">Board</button><button data-v="backlog">Backlog</button><button data-v="report">Sprint report</button><button data-v="settings">Settings</button></span>
   <input id="q" placeholder='search: status:"In Progress" type:bug' value="${esc(S.q)}" size="32"><button id="sbtn">Search</button>
   <button id="nbtn">Notifications</button><button id="out">Logout (${esc(S.me.username)})</button></header>
   <main><p class="err">${esc(S.err)}</p><div id="view"></div></main>${S.notifs ? '<div class="notif" id="notif"></div>' : ''}`;
  $('#wsel').onchange = (e) => guard(async () => { S.wsId = e.target.value; S.pid = null; await loadProjects(); S.view = 'board'; await draw(); });
  $('#psel').onchange = (e) => guard(async () => { S.pid = e.target.value; await draw(); });
  $('#newws').onclick = () => guard(async () => { const name = prompt('Workspace name'); const key = prompt('Key (2-10 uppercase letters)'); if (!name || !key) return; const w = await api('POST', '/api/workspaces', { name, key }); S.wsId = w.id; await loadWs(); });
  $('#newp').onclick = () => guard(async () => { const name = prompt('Project name'); const key = prompt('Key (2-10 uppercase letters)'); if (!name || !key) return; const p = await api('POST', `/api/workspaces/${S.wsId}/projects`, { name, key }); S.pid = p.id; await loadProjects(); });
  document.querySelectorAll('[data-v]').forEach((b) => (b.onclick = () => { S.view = b.dataset.v; S.issue = null; guard(draw); }));
  $('#q').onkeydown = (e) => { if (e.key === 'Enter') $('#sbtn').click(); };
  $('#sbtn').onclick = () => { S.q = $('#q').value; S.view = 'search'; S.issue = null; guard(draw); };
  $('#nbtn').onclick = () => guard(async () => { S.notifs = S.notifs ? null : await api('GET', '/api/notifications'); render(); drawNotifs(); });
  $('#out').onclick = async () => { try { await api('POST', '/api/auth/logout'); } catch {} S.token = null; S.me = null; localStorage.removeItem('pm_token'); render(); };
  if (S.notifs) drawNotifs();
  draw();
}
function drawNotifs() {
  const n = $('#notif'); if (!n) return;
  n.innerHTML = (S.notifs.length ? S.notifs.map((x) => `<div>${x.read ? '' : '• '}${esc(x.type)} on <a href="#" data-k="${esc(x.issueKey)}">${esc(x.issueKey)}</a></div>`).join('') : 'No notifications') + '<button id="readall">Mark all read</button>';
  n.querySelectorAll('[data-k]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); S.notifs = null; guard(async () => { S.issue = a.dataset.k; render(); }); }));
  $('#readall').onclick = () => guard(async () => { await api('POST', '/api/notifications/read', { all: true }); S.notifs = await api('GET', '/api/notifications'); });
}
async function draw() {
  const v = $('#view'); if (!v) return;
  try {
    if (S.issue) return await drawIssue(v);
    if (S.view === 'search') return await drawSearch(v);
    if (!proj()) { v.innerHTML = '<div class="panel">Create or select a workspace and project.</div>'; return; }
    if (S.view === 'board') return await drawBoard(v);
    if (S.view === 'backlog') return await drawBacklog(v);
    if (S.view === 'report') return await drawReport(v);
    if (S.view === 'settings') return await drawSettings(v);
  } catch (e) { S.err = e.message; $('.err').textContent = S.err; }
}
const card = (i) => `<div class="card" draggable="true" data-key="${esc(i.key)}"><a href="#" data-open="${esc(i.key)}">${esc(i.key)}</a> ${esc(i.title)}<br><small>${esc(i.type)} · ${esc(i.priority)}${i.storyPoints != null ? ' · ' + i.storyPoints + 'pt' : ''}</small></div>`;
function wireOpen(v) { v.querySelectorAll('[data-open]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); S.issue = a.dataset.open; guard(async () => {}); })); }
function newIssueForm() { return `<div class="panel"><input id="nt" placeholder="New issue title"> <select id="ntype">${['task', 'bug', 'feature', 'epic'].map((t) => `<option>${t}</option>`).join('')}</select> <button id="nadd">Create</button></div>`; }
function wireNew(v) { const b = v.querySelector('#nadd'); if (b) b.onclick = () => guard(async () => { await api('POST', `/api/projects/${S.pid}/issues`, { title: $('#nt').value, type: $('#ntype').value }); }); }
async function drawBoard(v) {
  const p = proj(); const issues = await api('GET', `/api/projects/${S.pid}/issues`);
  v.innerHTML = newIssueForm() + `<div class="board">${p.workflow.statuses.map((s) => `<div class="col" data-status="${esc(s.name)}"><b>${esc(s.name)}</b> (${issues.filter((i) => i.status === s.name).length})${issues.filter((i) => i.status === s.name).map(card).join('')}</div>`).join('')}</div>`;
  wireNew(v); wireOpen(v);
  v.querySelectorAll('.card').forEach((c) => (c.ondragstart = (e) => e.dataTransfer.setData('text/plain', c.dataset.key)));
  v.querySelectorAll('.col').forEach((c) => { c.ondragover = (e) => e.preventDefault(); c.ondrop = (e) => { e.preventDefault(); const key = e.dataTransfer.getData('text/plain'); guard(async () => { await api('PATCH', `/api/issues/${key}`, { status: c.dataset.status }); }); }; });
}
async function drawBacklog(v) {
  const [issues, sprints] = await Promise.all([api('GET', `/api/projects/${S.pid}/issues`), api('GET', `/api/projects/${S.pid}/sprints`)]);
  const row = (i) => `<div class="card">${esc(i.key)} ${esc(i.title)} <select data-mv="${esc(i.key)}"><option value="">Backlog</option>${sprints.filter((s) => s.state !== 'completed').map((s) => `<option value="${s.id}" ${i.sprintId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>`;
  v.innerHTML = newIssueForm() + `<div class="panel"><input id="sn" placeholder="Sprint name"> <input id="sd" type="date"> <input id="ed" type="date"> <button id="sadd">Create sprint</button></div>`
    + sprints.filter((s) => s.state !== 'completed').map((s) => `<div class="panel"><b>${esc(s.name)}</b> [${s.state}] ${s.state === 'planned' ? `<button data-start="${s.id}">Start</button>` : `<button data-done="${s.id}">Complete</button>`}${issues.filter((i) => i.sprintId === s.id).map(row).join('')}</div>`).join('')
    + `<div class="panel"><b>Backlog</b>${issues.filter((i) => !i.sprintId).map(row).join('')}</div>`;
  wireNew(v);
  v.querySelector('#sadd').onclick = () => guard(async () => { await api('POST', `/api/projects/${S.pid}/sprints`, { name: $('#sn').value, startDate: $('#sd').value || undefined, endDate: $('#ed').value || undefined }); });
  v.querySelectorAll('[data-mv]').forEach((s) => (s.onchange = () => guard(async () => { await api('PATCH', `/api/issues/${s.dataset.mv}`, { sprintId: s.value || null }); })));
  v.querySelectorAll('[data-start]').forEach((b) => (b.onclick = () => guard(async () => { await api('POST', `/api/sprints/${b.dataset.start}/start`); })));
  v.querySelectorAll('[data-done]').forEach((b) => (b.onclick = () => guard(async () => { await api('POST', `/api/sprints/${b.dataset.done}/complete`, { carryOverTo: 'backlog' }); })));
}
async function drawReport(v) {
  const sprints = await api('GET', `/api/projects/${S.pid}/sprints`);
  v.innerHTML = `<div class="panel"><select id="rs">${sprints.map((s) => `<option value="${s.id}">${esc(s.name)} (${s.state})</option>`).join('')}</select><div id="rep"></div></div>`;
  const show = async () => {
    const id = $('#rs').value; if (!id) return; const r = await api('GET', `/api/sprints/${id}/report`);
    const W = 600, H = 220, max = Math.max(1, r.committedPoints, ...r.burndown.map((b) => b.remainingPoints)); const n = Math.max(1, r.burndown.length - 1);
    const pts = r.burndown.map((b, k) => `${40 + (k / n) * (W - 60)},${H - 30 - (b.remainingPoints / max) * (H - 50)}`).join(' ');
    $('#rep').innerHTML = `<p>Committed ${r.committedPoints} · Completed ${r.completedPoints} pts (${r.completedIssues} issues) · Carried over ${r.carriedOver}</p>
     <svg width="${W}" height="${H}" style="background:#fff;border:1px solid #ccc"><line x1="40" y1="${H - 30}" x2="${W - 20}" y2="${H - 30}" stroke="#999"/><line x1="40" y1="10" x2="40" y2="${H - 30}" stroke="#999"/>
     <polyline fill="none" stroke="#0747a6" stroke-width="2" points="${pts}"/><text x="4" y="14" font-size="11">${max}</text>
     ${r.burndown.map((b, k) => `<circle cx="${40 + (k / n) * (W - 60)}" cy="${H - 30 - (b.remainingPoints / max) * (H - 50)}" r="3" fill="#0747a6"><title>${b.date}: ${b.remainingPoints}</title></circle>`).join('')}</svg>`;
  };
  $('#rs').onchange = show; await show();
}
async function drawSearch(v) {
  const r = await api('GET', `/api/search?q=${encodeURIComponent(S.q)}&project=${S.pid || ''}`);
  v.innerHTML = `<div class="panel"><b>${r.length} results</b>${r.map(card).join('')}</div>`; wireOpen(v);
}
async function drawIssue(v) {
  const i = await api('GET', `/api/issues/${S.issue}`); const [hist, comments] = await Promise.all([api('GET', `/api/issues/${S.issue}/history`), api('GET', `/api/issues/${S.issue}/comments`)]);
  const p = S.projects.find((x) => x.id === i.projectId) || proj();
  v.innerHTML = `<div class="panel"><button id="back">← Back</button> <h2>${esc(i.key)} ${esc(i.title)}</h2>
   <p>${esc(i.description)}</p>
   Status <select id="st">${p.workflow.statuses.map((s) => `<option ${s.name === i.status ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
   Priority <select id="pr">${['urgent', 'high', 'medium', 'low', 'none'].map((x) => `<option ${x === i.priority ? 'selected' : ''}>${x}</option>`).join('')}</select>
   <button id="watch">Watch</button> <button id="del">Delete</button>
   <h3>Subtasks</h3>${i.children.map((k) => `<div><a href="#" data-open="${esc(k)}">${esc(k)}</a></div>`).join('') || 'None'}
   <div><input id="sub" placeholder="Subtask title"><button id="subadd">Add subtask</button></div>
   ${i.progress ? `<p>Epic progress: ${i.progress.done}/${i.progress.total} issues, ${i.progress.points_done}/${i.progress.points_total} pts</p>` : ''}
   <h3>Links</h3>${i.links.map((l) => `<div>${esc(l.type)} <a href="#" data-open="${esc(l.target)}">${esc(l.target)}</a></div>`).join('') || 'None'}
   <div><select id="lt"><option>blocks</option><option>relates</option><option>duplicates</option></select><input id="ltg" placeholder="KEY-1"><button id="ladd">Link</button></div>
   <h3>Comments</h3>${comments.map((c) => `<div class="card">${esc(c.body)} ${c.edited ? '<small>(edited)</small>' : ''}</div>`).join('')}
   <textarea id="cb" placeholder="Comment (use @username to mention)"></textarea><button id="cadd">Comment</button>
   <h3>History</h3>${hist.map((h) => `<div><small>${esc(h.at)}</small> ${esc(h.field)}: ${esc(JSON.stringify(h.from))} → ${esc(JSON.stringify(h.to))}</div>`).join('')}</div>`;
  wireOpen(v);
  $('#back').onclick = () => { S.issue = null; guard(async () => {}); };
  $('#st').onchange = (e) => guard(async () => { await api('PATCH', `/api/issues/${i.key}`, { status: e.target.value }); });
  $('#pr').onchange = (e) => guard(async () => { await api('PATCH', `/api/issues/${i.key}`, { priority: e.target.value }); });
  $('#watch').onclick = () => guard(async () => { await api('POST', `/api/issues/${i.key}/watch`); });
  $('#del').onclick = () => guard(async () => { await api('DELETE', `/api/issues/${i.key}`); S.issue = null; });
  $('#subadd').onclick = () => guard(async () => { await api('POST', `/api/projects/${i.projectId}/issues`, { type: 'subtask', title: $('#sub').value, parentId: i.id }); });
  $('#ladd').onclick = () => guard(async () => { await api('POST', `/api/issues/${i.key}/links`, { type: $('#lt').value, target: $('#ltg').value }); });
  $('#cadd').onclick = () => guard(async () => { await api('POST', `/api/issues/${i.key}/comments`, { body: $('#cb').value }); });
}
async function drawSettings(v) {
  const p = await api('GET', `/api/projects/${S.pid}`); const hooks = p.role === 'lead' ? await api('GET', `/api/projects/${S.pid}/webhooks`) : [];
  v.innerHTML = `<div class="panel"><h3>Workflow</h3><textarea id="wf">${esc(JSON.stringify({ statuses: p.workflow.statuses, transitions: p.workflow.transitions }, null, 1))}</textarea>
   <input id="remap" placeholder='remap JSON e.g. {"Todo":"Backlog"}'> <button id="wfs">Save workflow</button></div>
   <div class="panel"><h3>Members</h3>${p.members.map((m) => `<div>${esc(m.username)} — ${esc(m.role)}</div>`).join('')}
   <input id="mu" placeholder="username"> <select id="mr"><option>developer</option><option>lead</option><option>viewer</option></select> <button id="madd">Add</button></div>
   <div class="panel"><h3>Webhooks</h3>${hooks.map((h) => `<div>${esc(h.url)} [${esc(h.events.join(','))}]</div>`).join('')}
   <input id="wu" placeholder="https://..."> <input id="ws" placeholder="secret"> <button id="wadd">Add (all events)</button></div>
   <div class="panel"><a href="/api/projects/${p.id}/export.csv" id="exp">Export CSV</a> (requires Authorization; use API token)</div>`;
  $('#wfs').onclick = () => guard(async () => { const b = JSON.parse($('#wf').value); const r = $('#remap').value; if (r) b.remap = JSON.parse(r); await api('PUT', `/api/projects/${S.pid}/workflow`, b); await loadProjects(); });
  $('#madd').onclick = () => guard(async () => { await api('POST', `/api/projects/${S.pid}/members`, { username: $('#mu').value, role: $('#mr').value }); await loadProjects(); });
  $('#wadd').onclick = () => guard(async () => { await api('POST', `/api/projects/${S.pid}/webhooks`, { url: $('#wu').value, secret: $('#ws').value, events: ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'] }); });
}
boot();
