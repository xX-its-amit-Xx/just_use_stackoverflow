// SPA using only the public REST API.
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const S = { token: localStorage.getItem('pm_token'), user: null, wss: [], ws: null, projects: [], project: null, view: 'board', issues: [], sprints: [], q: '', notifs: [], showNotifs: false, issue: null, msg: '' };

async function api(method, path, body, raw) {
  const r = await fetch(path, { method, headers: { ...(body && !raw ? { 'content-type': 'application/json' } : {}), ...(S.token ? { authorization: 'Bearer ' + S.token } : {}) }, body: body ? (raw ? body : JSON.stringify(body)) : undefined });
  const ct = r.headers.get('content-type') || '';
  const data = r.status === 204 ? null : ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error((data && data.message) || r.statusText);
  return data;
}
const run = async (fn) => { try { S.msg = ''; await fn(); } catch (e) { S.msg = e.message; } render(); };

async function boot() {
  if (!S.token) return render();
  try { S.user = await api('GET', '/api/auth/me'); await loadWs(); } catch { S.token = null; localStorage.removeItem('pm_token'); }
  render();
}
async function loadWs() {
  S.wss = await api('GET', '/api/workspaces');
  if (!S.ws || !S.wss.find((w) => w.id === S.ws.id)) S.ws = S.wss[0] || null;
  await loadProjects();
}
async function loadProjects() {
  S.projects = S.ws ? await api('GET', `/api/workspaces/${S.ws.id}/projects`) : [];
  if (!S.project || !S.projects.find((p) => p.id === S.project.id)) S.project = S.projects[0] || null;
  await loadProject();
}
async function loadProject() {
  if (!S.project) { S.issues = []; S.sprints = []; return; }
  S.project = await api('GET', `/api/projects/${S.project.id}`);
  S.sprints = await api('GET', `/api/projects/${S.project.id}/sprints`);
  S.issues = S.q ? await api('GET', `/api/search?q=${encodeURIComponent(S.q)}&project=${S.project.id}`) : await api('GET', `/api/projects/${S.project.id}/issues`);
  S.notifs = await api('GET', '/api/notifications');
}

function render() {
  const app = $('#app');
  if (!S.user) return (app.innerHTML = authView(), bindAuth());
  app.innerHTML = `<header>
    <b>PM</b>
    <select id="wsSel">${S.wss.map((w) => `<option value="${w.id}" ${S.ws?.id === w.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select>
    <button id="newWs">+ ws</button>
    <select id="prSel">${S.projects.map((p) => `<option value="${p.id}" ${S.project?.id === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
    <button id="newPr">+ project</button>
    <nav>${['board', 'backlog', 'report', 'settings'].map((v) => `<button data-v="${v}">${v}</button>`).join('')}</nav>
    <input id="q" placeholder='search: status:"In Progress" -label:x' value="${esc(S.q)}" size="32"><button id="go">Search</button>
    <button id="bell">🔔 ${S.notifs.filter((n) => !n.read).length}</button>
    <span>${esc(S.user.username)}</span><button id="logout">Logout</button></header>
    ${S.showNotifs ? `<div class="notif"><button id="readAll">Mark all read</button>${S.notifs.map((n) => `<div style="${n.read ? 'opacity:.5' : ''}">${esc(n.type)} <a class="link" data-open="${esc(n.issueKey)}">${esc(n.issueKey)}</a></div>`).join('') || 'none'}</div>` : ''}
    <main><div class="err">${esc(S.msg)}</div>${S.issue ? '' : ''}<div id="view">${S.project ? viewHtml() : '<p>Create a workspace and a project to begin.</p>'}</div><div id="detail">${S.issue ? detailHtml() : ''}</div></main>`;
  bindMain();
}

function authView() {
  return `<main><div class="panel" style="max-width:320px;margin:40px auto"><h2>Project Manager</h2><div class="err">${esc(S.msg)}</div>
  <form id="authForm"><p><input name="username" placeholder="username" required></p><p><input name="password" type="password" placeholder="password" required></p>
  <button name="act" value="login">Login</button> <button name="act" value="register" type="button" id="reg">Register</button></form></div></main>`;
}
function bindAuth() {
  const f = $('#authForm');
  const doAuth = (reg) => run(async () => {
    const b = { username: f.username.value, password: f.password.value };
    if (reg) await api('POST', '/api/auth/register', b);
    const r = await api('POST', '/api/auth/login', b);
    S.token = r.token; localStorage.setItem('pm_token', r.token); S.user = r.user; await loadWs();
  });
  f.onsubmit = (e) => { e.preventDefault(); doAuth(false); };
  $('#reg').onclick = () => doAuth(true);
}

const statuses = () => S.project.workflow.statuses;
const card = (i) => `<div class="card" draggable="true" data-key="${esc(i.key)}"><a class="link" data-open="${esc(i.key)}">${esc(i.key)}</a> ${esc(i.title)}<br><small>${esc(i.type)} · ${esc(i.priority)}${i.storyPoints != null ? ' · ' + i.storyPoints + 'pt' : ''}</small></div>`;

function viewHtml() {
  if (S.view === 'board') return `<div class="board">${statuses().map((s) => `<div class="col" data-status="${esc(s.name)}"><h4>${esc(s.name)}</h4>${S.issues.filter((i) => i.status === s.name).map(card).join('')}</div>`).join('')}</div>
    <div class="panel"><form id="newIssue"><input name="title" placeholder="New issue title" required> <select name="type">${['task', 'bug', 'feature', 'epic'].map((t) => `<option>${t}</option>`).join('')}</select> <button>Create</button></form></div>`;
  if (S.view === 'backlog') {
    const groups = [...S.sprints.filter((s) => s.state !== 'completed').map((s) => [s, S.issues.filter((i) => i.sprintId === s.id)]), [null, S.issues.filter((i) => !i.sprintId)]];
    return `<div class="panel"><form id="newSprint"><input name="name" placeholder="Sprint name" required> <input name="startDate" type="date"> <input name="endDate" type="date"> <button>Create sprint</button></form></div>` +
      groups.map(([s, list]) => `<div class="panel"><h3>${s ? esc(s.name) + ' (' + s.state + ')' : 'Backlog'}</h3>
      ${s && s.state === 'planned' ? `<button data-start="${s.id}">Start</button>` : ''}${s && s.state === 'active' ? `<button data-complete="${s.id}">Complete (carry to backlog)</button>` : ''}
      <table>${list.map((i) => `<tr><td><a class="link" data-open="${esc(i.key)}">${esc(i.key)}</a></td><td>${esc(i.title)}</td><td>${esc(i.status)}</td><td><select data-sprintfor="${esc(i.key)}"><option value="">backlog</option>${S.sprints.filter((x) => x.state !== 'completed').map((x) => `<option value="${x.id}" ${i.sprintId === x.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></td></tr>`).join('')}</table></div>`).join('');
  }
  if (S.view === 'report') return `<div class="panel"><select id="spSel">${S.sprints.map((s) => `<option value="${s.id}">${esc(s.name)} (${s.state})</option>`).join('')}</select> <button id="showRep">Show report</button><div id="rep"></div></div>`;
  if (S.view === 'settings') return settingsHtml();
  return '';
}

function settingsHtml() {
  const p = S.project;
  return `<div class="panel"><h3>Workflow</h3><p>One status per line: <code>name|category</code> (backlog, unstarted, started, completed)</p>
    <textarea id="wfStatuses" rows="6" cols="40">${statuses().map((s) => s.name + '|' + s.category).join('\n')}</textarea>
    <p>Transitions (<code>from&gt;to</code> per line; blank = allow all)</p><textarea id="wfTrans" rows="4" cols="40">${p.workflow.transitions.length === statuses().length * (statuses().length - 1) ? '' : p.workflow.transitions.map((t) => t.join('>')).join('\n')}</textarea>
    <p>Remap (<code>old>new</code> per line)</p><textarea id="wfRemap" rows="2" cols="40"></textarea><br><button id="saveWf">Save workflow</button></div>
  <div class="panel"><h3>Members</h3><ul>${p.members.map((m) => `<li>${esc(m.username)} — ${esc(m.role)}</li>`).join('')}</ul>
    <form id="addMember"><input name="username" placeholder="username" required> <select name="role"><option>developer</option><option>lead</option><option>viewer</option></select> <button>Add</button></form></div>
  <div class="panel"><h3>Webhooks</h3><div id="hooks"></div><form id="addHook"><input name="url" placeholder="https://..." required> <input name="secret" placeholder="secret" required> <button>Add</button></form></div>`;
}

function detailHtml() {
  const i = S.issue;
  return `<div class="panel"><h3>${esc(i.key)} ${esc(i.title)} <button id="closeDetail">×</button></h3>
  <p>Status: <select id="dStatus">${statuses().map((s) => `<option ${s.name === i.status ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
  Priority: <select id="dPrio">${['urgent', 'high', 'medium', 'low', 'none'].map((p) => `<option ${p === i.priority ? 'selected' : ''}>${p}</option>`).join('')}</select>
  <button id="watch">Watch</button> <button id="delIssue">Delete</button></p>
  <p>${esc(i.description || '')}</p>
  <p>Subtasks: ${i.children.map((k) => `<a class="link" data-open="${esc(k)}">${esc(k)}</a>`).join(', ') || 'none'}
  <form id="addSub"><input name="title" placeholder="new subtask" required><button>Add</button></form></p>
  ${i.progress ? `<p>Epic progress: ${i.progress.done}/${i.progress.total} issues, ${i.progress.points_done}/${i.progress.points_total} pts</p>` : ''}
  <p>Links: ${i.links.map((l) => `${esc(l.type)} <a class="link" data-open="${esc(l.target)}">${esc(l.target)}</a>`).join(', ') || 'none'}
  <form id="addLink"><select name="type"><option>blocks</option><option>relates</option><option>duplicates</option></select><input name="target" placeholder="KEY-1" required><button>Link</button></form></p>
  <h4>Comments</h4><div id="comments">${(S.comments || []).map((c) => `<p><small>${esc(c.createdAt)}${c.edited ? ' (edited)' : ''}</small> ${esc(c.body)}</p>`).join('')}</div>
  <form id="addComment"><input name="body" placeholder="comment (@user to mention)" required><button>Post</button></form>
  <h4>History</h4><ul>${(S.history || []).map((h) => `<li>${esc(h.at)}: ${esc(h.field)} ${esc(JSON.stringify(h.from))} → ${esc(JSON.stringify(h.to))}</li>`).join('')}</ul></div>`;
}

async function openIssue(key) {
  S.issue = await api('GET', `/api/issues/${key}`);
  S.comments = await api('GET', `/api/issues/${key}/comments`);
  S.history = await api('GET', `/api/issues/${key}/history`);
}
const refresh = async () => { await loadProject(); if (S.issue) await openIssue(S.issue.key); };

function burndownSvg(b) {
  const W = 480, H = 200, max = Math.max(1, ...b.map((d) => d.remainingPoints));
  const x = (i) => 30 + (b.length < 2 ? 0 : (i * (W - 50)) / (b.length - 1)), y = (v) => H - 20 - (v / max) * (H - 40);
  return `<svg width="${W}" height="${H}" style="background:#fff;border:1px solid #ccc"><polyline fill="none" stroke="#0052cc" stroke-width="2" points="${b.map((d, i) => x(i) + ',' + y(d.remainingPoints)).join(' ')}"/>
  ${b.map((d, i) => `<circle cx="${x(i)}" cy="${y(d.remainingPoints)}" r="3" fill="#0052cc"><title>${d.date}: ${d.remainingPoints}</title></circle>`).join('')}
  <text x="2" y="14" font-size="10">${max} pts</text><text x="2" y="${H - 6}" font-size="10">0</text></svg>`;
}

function bindMain() {
  const on = (sel, ev, fn) => { const e = $(sel); if (e) e[ev] = fn; };
  on('#wsSel', 'onchange', (e) => run(async () => { S.ws = S.wss.find((w) => w.id === e.target.value); S.project = null; await loadProjects(); }));
  on('#prSel', 'onchange', (e) => run(async () => { S.project = S.projects.find((p) => p.id === e.target.value); S.issue = null; await loadProject(); }));
  on('#newWs', 'onclick', () => { const name = prompt('Workspace name'); const key = name && prompt('Key (2-10 uppercase letters)'); if (key) run(async () => { await api('POST', '/api/workspaces', { name, key }); await loadWs(); }); });
  on('#newPr', 'onclick', () => { const name = prompt('Project name'); const key = name && prompt('Key'); if (key && S.ws) run(async () => { await api('POST', `/api/workspaces/${S.ws.id}/projects`, { name, key }); S.project = null; await loadProjects(); }); });
  document.querySelectorAll('nav button').forEach((b) => (b.onclick = () => { S.view = b.dataset.v; render(); if (S.view === 'settings') loadHooks(); }));
  on('#go', 'onclick', () => run(async () => { S.q = $('#q').value.trim(); await loadProject(); }));
  on('#q', 'onkeydown', (e) => { if (e.key === 'Enter') $('#go').click(); });
  on('#bell', 'onclick', () => { S.showNotifs = !S.showNotifs; render(); });
  on('#readAll', 'onclick', () => run(async () => { await api('POST', '/api/notifications/read', { all: true }); await loadProject(); }));
  on('#logout', 'onclick', () => run(async () => { await api('POST', '/api/auth/logout').catch(() => {}); S.token = null; S.user = null; localStorage.removeItem('pm_token'); }));
  document.querySelectorAll('[data-open]').forEach((a) => (a.onclick = () => run(() => openIssue(a.dataset.open))));
  // drag and drop
  document.querySelectorAll('.card').forEach((c) => (c.ondragstart = (e) => e.dataTransfer.setData('text/plain', c.dataset.key)));
  document.querySelectorAll('.col').forEach((c) => {
    c.ondragover = (e) => e.preventDefault();
    c.ondrop = (e) => { e.preventDefault(); const key = e.dataTransfer.getData('text/plain'); run(async () => { await api('PATCH', `/api/issues/${key}`, { status: c.dataset.status }); await refresh(); }); };
  });
  const form = (sel, fn) => { const f = $(sel); if (f) f.onsubmit = (e) => { e.preventDefault(); run(async () => { await fn(Object.fromEntries(new FormData(f))); await refresh(); }); }; };
  form('#newIssue', (d) => api('POST', `/api/projects/${S.project.id}/issues`, d));
  form('#newSprint', (d) => api('POST', `/api/projects/${S.project.id}/sprints`, { name: d.name, startDate: d.startDate || undefined, endDate: d.endDate || undefined }));
  form('#addSub', (d) => api('POST', `/api/projects/${S.project.id}/issues`, { type: 'subtask', title: d.title, parentId: S.issue.id }));
  form('#addLink', (d) => api('POST', `/api/issues/${S.issue.key}/links`, d));
  form('#addComment', (d) => api('POST', `/api/issues/${S.issue.key}/comments`, d));
  form('#addMember', (d) => api('POST', `/api/projects/${S.project.id}/members`, d));
  form('#addHook', (d) => api('POST', `/api/projects/${S.project.id}/webhooks`, { ...d, events: ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'] }));
  document.querySelectorAll('[data-start]').forEach((b) => (b.onclick = () => run(async () => { await api('POST', `/api/sprints/${b.dataset.start}/start`); await refresh(); })));
  document.querySelectorAll('[data-complete]').forEach((b) => (b.onclick = () => run(async () => { await api('POST', `/api/sprints/${b.dataset.complete}/complete`, { carryOverTo: 'backlog' }); await refresh(); })));
  document.querySelectorAll('[data-sprintfor]').forEach((s) => (s.onchange = () => run(async () => { await api('PATCH', `/api/issues/${s.dataset.sprintfor}`, { sprintId: s.value || null }); await refresh(); })));
  on('#dStatus', 'onchange', (e) => run(async () => { await api('PATCH', `/api/issues/${S.issue.key}`, { status: e.target.value }); await refresh(); }));
  on('#dPrio', 'onchange', (e) => run(async () => { await api('PATCH', `/api/issues/${S.issue.key}`, { priority: e.target.value }); await refresh(); }));
  on('#watch', 'onclick', () => run(async () => { await api('POST', `/api/issues/${S.issue.key}/watch`); await refresh(); }));
  on('#delIssue', 'onclick', () => run(async () => { await api('DELETE', `/api/issues/${S.issue.key}`); S.issue = null; await loadProject(); }));
  on('#closeDetail', 'onclick', () => { S.issue = null; render(); });
  on('#showRep', 'onclick', () => run(async () => {
    const id = $('#spSel').value; if (!id) return;
    const r = await api('GET', `/api/sprints/${id}/report`);
    $('#rep').innerHTML = `<p>Committed ${r.committedPoints} pts · Completed ${r.completedPoints} pts (${r.completedIssues} issues) · Carried over ${r.carriedOver}</p>` + burndownSvg(r.burndown);
  }).then?.(() => {}));
  on('#saveWf', 'onclick', () => run(async () => {
    const sts = $('#wfStatuses').value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [name, category] = l.split('|'); return { name: name.trim(), category: (category || '').trim() }; });
    const pairs = (id) => $(id).value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.split('>').map((x) => x.trim()));
    let transitions = pairs('#wfTrans');
    if (!transitions.length) transitions = sts.flatMap((a) => sts.filter((b) => b.name !== a.name).map((b) => [a.name, b.name]));
    const remap = Object.fromEntries(pairs('#wfRemap'));
    await api('PUT', `/api/projects/${S.project.id}/workflow`, { statuses: sts, transitions, remap });
    await refresh();
  }));
}
async function loadHooks() {
  try { const h = await api('GET', `/api/projects/${S.project.id}/webhooks`); const el = $('#hooks'); if (el) el.innerHTML = h.map((w) => `<div>${esc(w.url)} [${w.events.join(', ')}]</div>`).join('') || 'none'; } catch {}
}
boot();
