const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
let token = localStorage.getItem('token'); let me = null;
const S = { ws: null, project: null, view: 'board', issue: null, err: '' };
async function api(method, path, body, raw) {
  const r = await fetch(path, { method, headers: { ...(body && !raw ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? (raw ? body : JSON.stringify(body)) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(j?.message || r.status);
  return j;
}
const app = $('#app');
async function boot() {
  if (!token) return loginView();
  try { me = await api('GET', '/api/auth/me'); } catch { token = null; return loginView(); }
  S.workspaces = await api('GET', '/api/workspaces');
  if (!S.ws && S.workspaces.length) S.ws = S.workspaces[0].id;
  S.projects = S.ws ? await api('GET', `/api/workspaces/${S.ws}/projects`) : [];
  if (!S.project || !S.projects.find((p) => p.id === S.project)) S.project = S.projects[0]?.id || null;
  S.notes = await api('GET', '/api/notifications?unread=true');
  render();
}
function loginView(msg = '') {
  app.innerHTML = `<form class="login" id="lf"><h2>Project Manager</h2><input name="u" placeholder="username"><input name="p" type="password" placeholder="password"><button>Login</button><button type="button" id="reg">Register</button><div class="err">${esc(msg)}</div></form>`;
  const go = async (path) => { const f = $('#lf'); try { await api('POST', path, { username: f.u.value, password: f.p.value }); if (path.includes('register')) return go('/api/auth/login'); token = (await api('POST', path, { username: f.u.value, password: f.p.value })).token; localStorage.setItem('token', token); boot(); } catch (e) { loginView(e.message); } };
  $('#lf').onsubmit = (e) => { e.preventDefault(); go('/api/auth/login'); };
  $('#reg').onclick = () => go('/api/auth/register');
}
function render() {
  const proj = S.projects.find((p) => p.id === S.project);
  app.innerHTML = `<header><b>PM</b>
  <select id="wsel">${S.workspaces.map((w) => `<option value="${w.id}" ${w.id === S.ws ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select>
  <button id="nws">+ws</button>
  <select id="psel">${S.projects.map((p) => `<option value="${p.id}" ${p.id === S.project ? 'selected' : ''}>${esc(p.key)} ${esc(p.name)}</option>`).join('')}</select>
  <button id="npr">+project</button>
  <input id="q" placeholder='search e.g. status:"In Progress" -label:x'><button id="go">Search</button>
  <nav><button data-v="board">Board</button><button data-v="backlog">Backlog</button><button data-v="report">Report</button><button data-v="settings">Settings</button></nav>
  <button id="bell">🔔 ${S.notes.length}</button><span>${esc(me.username)}</span><button id="out">Logout</button></header>
  <main><div class="err">${esc(S.err)}</div><div id="view"></div></main>`;
  S.err = '';
  $('#wsel').onchange = (e) => { S.ws = e.target.value; S.project = null; boot(); };
  $('#psel').onchange = (e) => { S.project = e.target.value; render(); };
  $('#nws').onclick = async () => { const name = prompt('Workspace name'); const key = prompt('Key (2-10 uppercase letters)'); if (name) try { const w = await api('POST', '/api/workspaces', { name, key }); S.ws = w.id; } catch (e) { S.err = e.message; } boot(); };
  $('#npr').onclick = async () => { const name = prompt('Project name'); const key = prompt('Key'); if (name) try { const p = await api('POST', `/api/workspaces/${S.ws}/projects`, { name, key }); S.project = p.id; } catch (e) { S.err = e.message; } boot(); };
  $('#out').onclick = async () => { await api('POST', '/api/auth/logout').catch(() => {}); localStorage.removeItem('token'); token = null; loginView(); };
  document.querySelectorAll('nav button').forEach((b) => (b.onclick = () => { S.view = b.dataset.v; S.issue = null; render(); }));
  $('#go').onclick = () => search($('#q').value);
  $('#q').onkeydown = (e) => { if (e.key === 'Enter') search(e.target.value); };
  $('#bell').onclick = notesView;
  if (!proj) { $('#view').innerHTML = '<p>Create a workspace and a project to begin.</p>'; return; }
  if (S.issue) return issueView(S.issue);
  ({ board: boardView, backlog: backlogView, report: reportView, settings: settingsView })[S.view](proj);
}
const card = (i) => `<div class="card" draggable="true" data-key="${i.key}"><a data-open="${i.key}">${i.key}</a> ${esc(i.title)}<br><small>${i.type} · ${i.priority}${i.storyPoints != null ? ' · ' + i.storyPoints + 'pt' : ''}</small></div>`;
function wire(root) { root.querySelectorAll('[data-open]').forEach((a) => (a.onclick = () => { S.issue = a.dataset.open; render(); })); }
async function boardView(proj) {
  const issues = await api('GET', `/api/projects/${proj.id}/issues`);
  const v = $('#view');
  v.innerHTML = `<button id="ni">+ New issue</button><div class="board">${proj.workflow.statuses.map((s) => `<div class="col" data-st="${esc(s.name)}"><h4>${esc(s.name)}</h4>${issues.filter((i) => i.status === s.name).map(card).join('')}</div>`).join('')}</div>`;
  wire(v);
  $('#ni').onclick = async () => { const title = prompt('Title'); if (title) try { await api('POST', `/api/projects/${proj.id}/issues`, { title, type: 'task' }); } catch (e) { S.err = e.message; } render(); };
  v.querySelectorAll('.card').forEach((c) => (c.ondragstart = (e) => e.dataTransfer.setData('text/plain', c.dataset.key)));
  v.querySelectorAll('.col').forEach((c) => { c.ondragover = (e) => e.preventDefault(); c.ondrop = async (e) => { e.preventDefault(); try { await api('PATCH', `/api/issues/${e.dataTransfer.getData('text/plain')}`, { status: c.dataset.st }); } catch (er) { S.err = er.message; } render(); }; });
}
async function backlogView(proj) {
  const [issues, sprints] = await Promise.all([api('GET', `/api/projects/${proj.id}/issues`), api('GET', `/api/projects/${proj.id}/sprints`)]);
  const v = $('#view');
  const list = (arr) => arr.map((i) => `<div class="card" data-key="${i.key}"><a data-open="${i.key}">${i.key}</a> ${esc(i.title)} <select data-mv="${i.key}"><option value="">Backlog</option>${sprints.filter((s) => s.state !== 'completed').map((s) => `<option value="${s.id}" ${i.sprintId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>`).join('');
  v.innerHTML = `<button id="ns">+ Sprint</button>${sprints.filter((s) => s.state !== 'completed').map((s) => `<div class="panel"><h4>${esc(s.name)} (${s.state})
   ${s.state === 'planned' ? `<button data-start="${s.id}">Start</button>` : `<button data-done="${s.id}">Complete</button>`}</h4>${list(issues.filter((i) => i.sprintId === s.id))}</div>`).join('')}
   <div class="panel"><h4>Backlog</h4>${list(issues.filter((i) => !i.sprintId))}</div>`;
  wire(v);
  const act = async (fn) => { try { await fn(); } catch (e) { S.err = e.message; } render(); };
  $('#ns').onclick = () => { const name = prompt('Sprint name'); if (name) act(() => api('POST', `/api/projects/${proj.id}/sprints`, { name })); };
  v.querySelectorAll('[data-start]').forEach((b) => (b.onclick = () => act(() => api('POST', `/api/sprints/${b.dataset.start}/start`, {}))));
  v.querySelectorAll('[data-done]').forEach((b) => (b.onclick = () => act(() => api('POST', `/api/sprints/${b.dataset.done}/complete`, { carryOverTo: 'backlog' }))));
  v.querySelectorAll('[data-mv]').forEach((s) => (s.onchange = () => act(() => api('PATCH', `/api/issues/${s.dataset.mv}`, { sprintId: s.value || null }))));
}
async function reportView(proj) {
  const sprints = await api('GET', `/api/projects/${proj.id}/sprints`);
  const v = $('#view'); v.innerHTML = `<select id="sp">${sprints.map((s) => `<option value="${s.id}">${esc(s.name)} (${s.state})</option>`).join('')}</select><div id="rep"></div>`;
  const load = async () => {
    const id = $('#sp').value; if (!id) return;
    const r = await api('GET', `/api/sprints/${id}/report`);
    const W = 500, H = 200, max = Math.max(1, r.committedPoints, ...r.burndown.map((b) => b.remainingPoints));
    const pts = r.burndown.map((b, i) => `${20 + (i * (W - 40)) / Math.max(1, r.burndown.length - 1)},${H - 20 - (b.remainingPoints / max) * (H - 40)}`).join(' ');
    $('#rep').innerHTML = `<div class="panel">Committed ${r.committedPoints} · Completed ${r.completedPoints} · Issues done ${r.completedIssues} · Carried over ${r.carriedOver}</div>
    <svg id="burndown" width="${W}" height="${H}" style="background:#fff"><polyline fill="none" stroke="#0052cc" stroke-width="2" points="${pts}"/><line x1="20" y1="${H - 20}" x2="${W - 20}" y2="${H - 20}" stroke="#999"/></svg>`;
  };
  $('#sp').onchange = load; load();
}
async function settingsView(proj) {
  const hooks = await api('GET', `/api/projects/${proj.id}/webhooks`).catch(() => []);
  const v = $('#view');
  v.innerHTML = `<div class="panel"><h4>Workflow</h4><textarea id="wf" cols="60" rows="8">${esc(JSON.stringify(proj.workflow, null, 1))}</textarea><br>Remap (JSON): <input id="rm" value="{}"><button id="sw">Save workflow</button></div>
  <div class="panel"><h4>Members</h4>${proj.members.map((m) => `<div>${esc(m.username)} — ${m.role}</div>`).join('')}<input id="mu" placeholder="username"><select id="mr"><option>developer</option><option>lead</option><option>viewer</option></select><button id="am">Add</button></div>
  <div class="panel"><h4>Webhooks</h4>${hooks.map((h) => `<div>${esc(h.url)} [${h.events}] <button data-dh="${h.id}">x</button></div>`).join('')}<input id="hu" placeholder="url"><input id="hs" placeholder="secret"><button id="ah">Add (all events)</button></div>`;
  const act = async (fn) => { try { await fn(); await boot(); } catch (e) { S.err = e.message; render(); } };
  $('#sw').onclick = () => act(() => { const w = JSON.parse($('#wf').value); return api('PUT', `/api/projects/${proj.id}/workflow`, { ...w, remap: JSON.parse($('#rm').value || '{}') }); });
  $('#am').onclick = () => act(() => api('POST', `/api/projects/${proj.id}/members`, { username: $('#mu').value, role: $('#mr').value }));
  $('#ah').onclick = () => act(() => api('POST', `/api/projects/${proj.id}/webhooks`, { url: $('#hu').value, secret: $('#hs').value, events: ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'] }));
  v.querySelectorAll('[data-dh]').forEach((b) => (b.onclick = () => act(() => api('DELETE', `/api/webhooks/${b.dataset.dh}`))));
}
async function search(q) {
  try {
    const r = await api('GET', `/api/search?q=${encodeURIComponent(q)}${S.project ? '&project=' + S.project : ''}`);
    S.issue = null; $('#view').innerHTML = `<div class="panel"><h4>${r.length} result(s)</h4>${r.map(card).join('')}</div>`; wire($('#view'));
  } catch (e) { $('#view').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}
async function notesView() {
  const all = await api('GET', '/api/notifications');
  $('#view').innerHTML = `<div class="panel"><h4>Notifications</h4><button id="mr">Mark all read</button>${all.map((n) => `<div>${n.read ? '' : '• '}${esc(n.type)} on <a data-open="${n.issueKey}">${n.issueKey}</a> ${esc(n.at)}</div>`).join('')}</div>`;
  wire($('#view'));
  $('#mr').onclick = async () => { await api('POST', '/api/notifications/read', { all: true }); boot(); };
}
async function issueView(key) {
  const [i, hist, cms] = await Promise.all([api('GET', `/api/issues/${key}`), api('GET', `/api/issues/${key}/history`), api('GET', `/api/issues/${key}/comments`)]);
  const v = $('#view');
  v.innerHTML = `<div class="panel"><button id="back">← back</button><h3>${i.key} ${esc(i.title)}</h3><p>${esc(i.description)}</p>
  <div>Status: <select id="st">${S.projects.find((p) => p.id === i.projectId).workflow.statuses.map((s) => `<option ${s.name === i.status ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select> · ${i.type} · ${i.priority}</div>
  <h4>Subtasks</h4>${i.children.map((k) => `<a data-open="${k}">${k}</a> `).join('')}<button id="ast">+ subtask</button>
  <h4>Links</h4>${i.links.map((l) => `${l.type} <a data-open="${l.target}">${l.target}</a> `).join('')}<br><select id="lt"><option>blocks</option><option>relates</option><option>duplicates</option></select><input id="ltg" placeholder="KEY-1"><button id="al">Link</button>
  <h4>Comments</h4>${cms.map((c) => `<div><b>${esc(c.authorId.slice(0, 4))}</b> ${esc(c.body)}${c.edited ? ' (edited)' : ''}</div>`).join('')}<input id="cb" placeholder="comment (@user)"><button id="ac">Post</button>
  <h4>History</h4>${hist.map((h) => `<div>${esc(h.field)}: ${esc(JSON.stringify(h.from))} → ${esc(JSON.stringify(h.to))} <small>${esc(h.at)}</small></div>`).join('')}</div>`;
  wire(v);
  const act = async (fn) => { try { await fn(); } catch (e) { S.err = e.message; } render(); };
  $('#back').onclick = () => { S.issue = null; render(); };
  $('#st').onchange = (e) => act(() => api('PATCH', `/api/issues/${key}`, { status: e.target.value }));
  $('#ac').onclick = () => act(() => api('POST', `/api/issues/${key}/comments`, { body: $('#cb').value }));
  $('#al').onclick = () => act(() => api('POST', `/api/issues/${key}/links`, { type: $('#lt').value, target: $('#ltg').value }));
  $('#ast').onclick = () => { const t = prompt('Title'); if (t) act(() => api('POST', `/api/projects/${i.projectId}/issues`, { title: t, type: 'subtask', parentId: i.id })); };
}
boot();
