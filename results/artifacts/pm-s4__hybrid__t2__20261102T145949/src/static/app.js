const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const S = { token: localStorage.getItem('pm_token'), user: null, ws: [], wsId: null, projects: [], pid: null, view: 'board', issue: null, err: '' };
async function api(method, path, body, raw) {
  const r = await fetch(path, { method, headers: { ...(raw ? { 'content-type': 'text/csv' } : { 'content-type': 'application/json' }), ...(S.token ? { authorization: 'Bearer ' + S.token } : {}) }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch { d = t; }
  if (!r.ok) throw new Error((d && d.message) || r.statusText);
  return d;
}
const guard = (fn) => async (...a) => { try { S.err = ''; await fn(...a); } catch (e) { S.err = e.message; } render(); };
const proj = () => S.projects.find((p) => p.id === S.pid);
async function boot() {
  if (S.token) { try { S.user = await api('GET', '/api/auth/me'); await loadWs(); } catch { S.token = null; localStorage.removeItem('pm_token'); } }
  render();
}
async function loadWs() {
  S.ws = await api('GET', '/api/workspaces');
  if (!S.wsId && S.ws.length) S.wsId = S.ws[0].id;
  await loadProjects();
}
async function loadProjects() {
  S.projects = S.wsId ? await api('GET', `/api/workspaces/${S.wsId}/projects`) : [];
  if (!S.projects.find((p) => p.id === S.pid)) S.pid = S.projects[0]?.id || null;
}
function authView() {
  return `<main class="panel"><h2>pm-s4</h2><div class="err">${esc(S.err)}</div>
  <input id="u" placeholder="username"><input id="p" type="password" placeholder="password">
  <button id="login">Login</button><button id="reg">Register</button></main>`;
}
function bindAuth() {
  const cred = () => ({ username: $('#u').value, password: $('#p').value });
  $('#login').onclick = guard(async () => { const r = await api('POST', '/api/auth/login', cred()); S.token = r.token; localStorage.setItem('pm_token', r.token); S.user = r.user; await loadWs(); });
  $('#reg').onclick = guard(async () => { await api('POST', '/api/auth/register', cred()); const r = await api('POST', '/api/auth/login', cred()); S.token = r.token; localStorage.setItem('pm_token', r.token); S.user = r.user; await loadWs(); });
}
async function render() {
  const app = $('#app');
  if (!S.user) { app.innerHTML = authView(); return bindAuth(); }
  let body = '';
  try { body = await viewBody(); } catch (e) { S.err = e.message; }
  app.innerHTML = `<header><b>pm-s4</b>
  <select id="wsel">${S.ws.map((w) => `<option value="${w.id}" ${w.id === S.wsId ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select><button id="newws">+ws</button>
  <select id="psel">${S.projects.map((p) => `<option value="${p.id}" ${p.id === S.pid ? 'selected' : ''}>${esc(p.key)} ${esc(p.name)}</option>`).join('')}</select><button id="newp">+project</button>
  <input id="q" placeholder='search e.g. status:"In Progress" -label:x'><button id="sq">Search</button>
  <button id="notif">Notifications</button><button id="out">Logout (${esc(S.user.username)})</button></header>
  <main><nav>${['board', 'backlog', 'sprints', 'settings'].map((v) => `<button data-v="${v}">${v}</button>`).join('')}</nav>
  <div class="err">${esc(S.err)}</div>${body}</main>`;
  bind();
}
async function viewBody() {
  if (S.view === 'search') return S.searchHtml;
  if (S.view === 'notif') {
    const n = await api('GET', '/api/notifications');
    return `<div class="panel"><h3>Notifications</h3><button id="readall">Mark all read</button>${n.map((x) => `<div class="${x.read ? 'muted' : ''}">${esc(x.type)} <a href="#" data-open="${esc(x.issueKey)}">${esc(x.issueKey)}</a> ${esc(x.at)}</div>`).join('')}</div>`;
  }
  if (S.view === 'issue') return issueView();
  if (!proj()) return '<div class="panel">Create a workspace and a project to start.</div>';
  const p = proj();
  const issues = await api('GET', `/api/projects/${p.id}/issues`);
  if (S.view === 'board') {
    return `<div class="panel"><input id="nt" placeholder="new issue title"><select id="ntype">${['task', 'bug', 'feature', 'epic'].map((t) => `<option>${t}</option>`).join('')}</select><button id="addi">Add</button></div>
    <div class="board">${p.workflow.statuses.map((s) => `<div class="col" data-status="${esc(s.name)}"><b>${esc(s.name)}</b>
    ${issues.filter((i) => i.status === s.name).map((i) => `<div class="card" draggable="true" data-key="${i.key}"><span class="muted">${i.key} ${i.type}</span><br>${esc(i.title)}</div>`).join('')}</div>`).join('')}</div>`;
  }
  const sprints = await api('GET', `/api/projects/${p.id}/sprints`);
  if (S.view === 'backlog') {
    const sel = (i) => `<select data-assign="${i.key}"><option value="">backlog</option>${sprints.filter((s) => s.state !== 'completed').map((s) => `<option value="${s.id}" ${s.id === i.sprintId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`;
    return `<div class="panel"><h3>Backlog / sprint planning</h3><input id="spn" placeholder="sprint name"><button id="addsp">Create sprint</button>
    ${sprints.map((s) => `<h4>${esc(s.name)} (${s.state})</h4>${issues.filter((i) => i.sprintId === s.id).map((i) => `<div><a href="#" data-open="${i.key}">${i.key}</a> ${esc(i.title)} ${sel(i)}</div>`).join('')}`).join('')}
    <h4>Backlog</h4>${issues.filter((i) => !i.sprintId).map((i) => `<div><a href="#" data-open="${i.key}">${i.key}</a> ${esc(i.title)} ${sel(i)}</div>`).join('')}</div>`;
  }
  if (S.view === 'sprints') {
    let h = '<div class="panel"><h3>Sprints</h3>';
    for (const s of sprints) {
      h += `<div><b>${esc(s.name)}</b> ${s.state} ${s.state === 'planned' ? `<button data-start="${s.id}">Start</button>` : ''}${s.state === 'active' ? `<button data-complete="${s.id}">Complete</button>` : ''}<button data-report="${s.id}">Report</button></div>`;
    }
    if (S.report) h += S.report;
    return h + '</div>';
  }
  if (S.view === 'settings') {
    const wh = await api('GET', `/api/projects/${p.id}/webhooks`).catch(() => []);
    return `<div class="panel"><h3>Workflow</h3><textarea id="wf" rows="8" cols="60">${esc(JSON.stringify({ statuses: p.workflow.statuses, transitions: p.workflow.transitions }, null, 1))}</textarea><br>
    remap (JSON): <input id="remap" value="{}"><button id="savewf">Save workflow</button></div>
    <div class="panel"><h3>Members</h3>${p.members.map((m) => `<div>${esc(m.username)} ${m.role}</div>`).join('')}
    <input id="mu" placeholder="username"><select id="mr"><option>developer</option><option>lead</option><option>viewer</option></select><button id="addm">Add</button></div>
    <div class="panel"><h3>Webhooks</h3>${wh.map((w) => `<div>${esc(w.url)} ${w.events.join(',')} <button data-hist="${w.id}">deliveries</button></div>`).join('')}
    <input id="whu" placeholder="url"><input id="whs" placeholder="secret"><input id="whe" value="issue.created,issue.updated"><button id="addwh">Add</button><pre>${esc(S.deliv || '')}</pre></div>`;
  }
  return '';
}
async function issueView() {
  const i = await api('GET', `/api/issues/${S.issue}`);
  const [h, c] = await Promise.all([api('GET', `/api/issues/${S.issue}/history`), api('GET', `/api/issues/${S.issue}/comments`)]);
  const p = S.projects.find((x) => x.id === i.projectId) || proj();
  return `<div class="panel"><h3>${i.key} ${esc(i.title)}</h3><div>${i.type} | priority ${i.priority} | points ${i.storyPoints ?? '-'} | sprint ${i.sprintId ?? '-'}</div>
  <p>${esc(i.description)}</p>
  <div>Status: <select id="ist">${p.workflow.statuses.map((s) => `<option ${s.name === i.status ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
  <button id="watch">Watch</button><button id="unwatch">Unwatch</button><button id="delissue">Delete</button></div>
  ${i.progress ? `<div>Progress: ${i.progress.done}/${i.progress.total} (${i.progress.points_done}/${i.progress.points_total} pts)</div>` : ''}
  <h4>Subtasks</h4>${i.children.map((k) => `<a href="#" data-open="${k}">${k}</a> `).join('')}
  <div><input id="stt" placeholder="subtask title"><button id="addsub">Add subtask</button></div>
  <h4>Links</h4>${i.links.map((l) => `<div>${l.type} <a href="#" data-open="${esc(l.target)}">${esc(l.target)}</a></div>`).join('')}
  <select id="lt"><option>blocks</option><option>relates</option><option>duplicates</option></select><input id="ltg" placeholder="KEY-1"><button id="addl">Link</button>
  <h4>Comments</h4>${c.map((x) => `<div><span class="muted">${esc(x.createdAt)}${x.edited ? ' (edited)' : ''}</span> ${esc(x.body)}</div>`).join('')}
  <input id="cb" placeholder="comment (use @user)"><button id="addc">Comment</button>
  <h4>History</h4>${h.map((x) => `<div class="muted">${esc(x.at)} ${esc(x.field)}: ${esc(JSON.stringify(x.from))} → ${esc(JSON.stringify(x.to))}</div>`).join('')}</div>`;
}
function burndownSvg(b) {
  if (!b.length) return '<p class="muted">No burndown yet.</p>';
  const W = 400, H = 150, max = Math.max(1, ...b.map((x) => x.remainingPoints));
  const pts = b.map((x, i) => `${20 + (b.length === 1 ? 0 : (i * (W - 40)) / (b.length - 1))},${H - 20 - (x.remainingPoints / max) * (H - 40)}`).join(' ');
  return `<svg id="burndown" width="${W}" height="${H}" style="background:#fff;border:1px solid #ccc"><polyline fill="none" stroke="#e63946" stroke-width="2" points="${pts}"/><text x="4" y="12" font-size="10">${max}</text><text x="4" y="${H - 6}" font-size="10">0</text></svg>`;
}
function bind() {
  const on = (sel, fn) => { const e = $(sel); if (e) e.onclick = guard(fn); };
  $('#wsel').onchange = guard(async (e) => { S.wsId = $('#wsel').value; await loadProjects(); });
  $('#psel').onchange = guard(async () => { S.pid = $('#psel').value; });
  on('#newws', async () => { const name = prompt('Workspace name'); const key = name && prompt('Key (2-10 uppercase letters)'); if (!key) return; const w = await api('POST', '/api/workspaces', { name, key }); S.wsId = w.id; await loadWs(); });
  on('#newp', async () => { const name = prompt('Project name'); const key = name && prompt('Key (2-10 uppercase letters)'); if (!key) return; const p = await api('POST', `/api/workspaces/${S.wsId}/projects`, { name, key }); await loadProjects(); S.pid = p.id; });
  on('#out', async () => { await api('POST', '/api/auth/logout').catch(() => {}); S.token = null; S.user = null; localStorage.removeItem('pm_token'); });
  on('#notif', async () => { S.view = 'notif'; });
  on('#sq', async () => { const r = await api('GET', '/api/search?q=' + encodeURIComponent($('#q').value) + (S.pid ? '&project=' + S.pid : '')); S.searchHtml = `<div class="panel"><h3>Results (${r.length})</h3>${r.map((i) => `<div><a href="#" data-open="${i.key}">${i.key}</a> ${esc(i.title)} [${esc(i.status)}]</div>`).join('')}</div>`; S.view = 'search'; });
  document.querySelectorAll('nav button').forEach((b) => { b.onclick = () => { S.view = b.dataset.v; S.report = ''; render(); }; });
  document.querySelectorAll('[data-open]').forEach((a) => { a.onclick = (e) => { e.preventDefault(); S.issue = a.dataset.open; S.view = 'issue'; render(); }; });
  document.querySelectorAll('.card').forEach((c) => {
    c.ondragstart = (e) => e.dataTransfer.setData('text/plain', c.dataset.key);
    c.onclick = () => { S.issue = c.dataset.key; S.view = 'issue'; render(); };
  });
  document.querySelectorAll('.col').forEach((col) => {
    col.ondragover = (e) => e.preventDefault();
    col.ondrop = guard(async (e) => { e.preventDefault(); await api('PATCH', `/api/issues/${e.dataTransfer.getData('text/plain')}`, { status: col.dataset.status }); });
  });
  on('#addi', async () => { await api('POST', `/api/projects/${S.pid}/issues`, { title: $('#nt').value, type: $('#ntype').value }); });
  on('#readall', async () => { await api('POST', '/api/notifications/read', { all: true }); });
  document.querySelectorAll('[data-assign]').forEach((s) => { s.onchange = guard(async () => { await api('PATCH', `/api/issues/${s.dataset.assign}`, { sprintId: s.value || null }); }); });
  on('#addsp', async () => { await api('POST', `/api/projects/${S.pid}/sprints`, { name: $('#spn').value }); });
  document.querySelectorAll('[data-start]').forEach((b) => { b.onclick = guard(async () => { await api('POST', `/api/sprints/${b.dataset.start}/start`); }); });
  document.querySelectorAll('[data-complete]').forEach((b) => { b.onclick = guard(async () => { await api('POST', `/api/sprints/${b.dataset.complete}/complete`, { carryOverTo: 'backlog' }); }); });
  document.querySelectorAll('[data-report]').forEach((b) => { b.onclick = guard(async () => { const r = await api('GET', `/api/sprints/${b.dataset.report}/report`); S.report = `<p>Committed ${r.committedPoints} pts, completed ${r.completedPoints} pts (${r.completedIssues} issues), carried over ${r.carriedOver}</p>` + burndownSvg(r.burndown); }); });
  on('#savewf', async () => { const w = JSON.parse($('#wf').value); w.remap = JSON.parse($('#remap').value || '{}'); await api('PUT', `/api/projects/${S.pid}/workflow`, w); await loadProjects(); });
  on('#addm', async () => { await api('POST', `/api/projects/${S.pid}/members`, { username: $('#mu').value, role: $('#mr').value }); await loadProjects(); });
  on('#addwh', async () => { await api('POST', `/api/projects/${S.pid}/webhooks`, { url: $('#whu').value, secret: $('#whs').value, events: $('#whe').value.split(',').map((s) => s.trim()) }); });
  document.querySelectorAll('[data-hist]').forEach((b) => { b.onclick = guard(async () => { S.deliv = JSON.stringify(await api('GET', `/api/webhooks/${b.dataset.hist}/deliveries`), null, 1); }); });
  const ist = $('#ist'); if (ist) ist.onchange = guard(async () => { await api('PATCH', `/api/issues/${S.issue}`, { status: ist.value }); });
  on('#watch', async () => { await api('POST', `/api/issues/${S.issue}/watch`); });
  on('#unwatch', async () => { await api('DELETE', `/api/issues/${S.issue}/watch`); });
  on('#delissue', async () => { await api('DELETE', `/api/issues/${S.issue}`); S.view = 'board'; });
  on('#addsub', async () => { await api('POST', `/api/projects/${S.pid}/issues`, { type: 'subtask', title: $('#stt').value, parentId: S.issue }); });
  on('#addl', async () => { await api('POST', `/api/issues/${S.issue}/links`, { type: $('#lt').value, target: $('#ltg').value }); });
  on('#addc', async () => { await api('POST', `/api/issues/${S.issue}/comments`, { body: $('#cb').value }); });
}
boot();
