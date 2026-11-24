// Single-page app; talks only to the public REST API.
const $app = document.getElementById('app');
let token = localStorage.getItem('pmToken');
const S = { ws: null, project: null, view: 'board', issue: null, msg: '', results: null, notifOpen: false };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(method, path, body, raw) {
  const r = await fetch(path, { method, headers: { ...(raw ? { 'content-type': 'text/csv' } : body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
  const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) { const e = new Error((data && data.message) || r.statusText); e.status = r.status; throw e; }
  return data;
}
const h = (html) => { $app.innerHTML = html; };
const on = (sel, ev, fn) => document.querySelectorAll(sel).forEach(el => el.addEventListener(ev, fn));
const guard = (fn) => async (e) => { try { S.msg = ''; await fn(e); } catch (err) { S.msg = err.message; render(); } };

async function render() {
  if (!token) return renderAuth();
  const [me, wss] = await Promise.all([api('GET', '/api/auth/me'), api('GET', '/api/workspaces')]).catch(() => { token = null; localStorage.removeItem('pmToken'); return [null, []]; });
  if (!me) return renderAuth();
  S.me = me.user; S.wss = wss;
  if (!S.ws || !wss.find(w => w.id === S.ws)) S.ws = wss[0]?.id || null;
  S.projects = S.ws ? await api('GET', `/api/workspaces/${S.ws}/projects`) : [];
  if (!S.projects.find(p => p.id === S.project)) S.project = S.projects[0]?.id || null;
  S.proj = S.projects.find(p => p.id === S.project);
  S.notifs = await api('GET', '/api/notifications?unread=true');
  const body = S.proj ? await renderView() : '<div class="panel">Create a workspace and project to begin.</div>';
  h(`<header><b>PM</b>
    <select id="wsSel">${S.wss.map(w => `<option value="${w.id}" ${w.id === S.ws ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select>
    <button id="newWs">+ Workspace</button>
    <select id="prSel">${S.projects.map(p => `<option value="${p.id}" ${p.id === S.project ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
    <button id="newPr">+ Project</button>
    <nav>${['board', 'backlog', 'report', 'settings'].map(v => `<button data-view="${v}">${v}</button>`).join('')}</nav>
    <input id="q" placeholder='search: status:"In Progress" -label:x' size="34" value="${esc(S.q || '')}"><button id="go">Search</button>
    <button id="bell">🔔 ${S.notifs.length}</button><span>${esc(S.me.displayName)}</span><button id="logout">Logout</button></header>
    <main>${S.msg ? `<p class="err">${esc(S.msg)}</p>` : ''}${S.results ? resultsHtml() : ''}${body}</main>${S.notifOpen ? notifHtml() : ''}`);
  bind();
}
function renderAuth() {
  h(`<div class="auth panel"><h2>Project Manager</h2>${S.msg ? `<p class="err">${esc(S.msg)}</p>` : ''}
    <input id="u" placeholder="username"><input id="p" type="password" placeholder="password"><input id="d" placeholder="display name (register)">
    <button id="login">Login</button> <button id="reg">Register</button></div>`);
  const cred = () => ({ username: document.getElementById('u').value, password: document.getElementById('p').value });
  document.getElementById('login').onclick = guard(async () => { const r = await api('POST', '/api/auth/login', cred()); token = r.token; localStorage.setItem('pmToken', token); render(); });
  document.getElementById('reg').onclick = guard(async () => { await api('POST', '/api/auth/register', { ...cred(), displayName: document.getElementById('d').value || undefined }); const r = await api('POST', '/api/auth/login', cred()); token = r.token; localStorage.setItem('pmToken', token); render(); });
}
const issueCard = (i) => `<div class="card" draggable="true" data-key="${i.key}"><a href="#" data-open="${i.key}">${i.key}</a> ${esc(i.title)}<br><small>${i.type} · ${i.priority}${i.storyPoints != null ? ' · ' + i.storyPoints + 'pt' : ''}</small></div>`;
const resultsHtml = () => `<div class="panel"><b>Search results (${S.results.length})</b> <button id="clr">clear</button>${S.results.map(issueCard).join('')}</div>`;
const notifHtml = () => `<div class="notif"><b>Notifications</b> <button id="readAll">mark all read</button>${S.notifs.map(n => `<div>${esc(n.type)} on <a href="#" data-open="${n.issueKey}">${n.issueKey}</a></div>`).join('') || '<div>none</div>'}</div>`;

async function renderView() {
  if (S.issue) return issueView();
  const p = S.proj;
  const issues = await api('GET', `/api/projects/${p.id}/issues`);
  S.issues = issues;
  if (S.view === 'board') return `<div class="board">${p.workflow.statuses.map(s => `<div class="col" data-status="${esc(s.name)}"><b>${esc(s.name)}</b> (${issues.filter(i => i.status === s.name).length})${issues.filter(i => i.status === s.name && i.type !== 'epic' || i.status === s.name).map(issueCard).join('')}</div>`).join('')}</div>
    <div class="panel"><input id="nt" placeholder="New issue title"><select id="ntype">${['task', 'bug', 'feature', 'epic'].map(t => `<option>${t}</option>`).join('')}</select><button id="addIssue">Add</button></div>`;
  if (S.view === 'backlog') {
    S.sprints = await api('GET', `/api/projects/${p.id}/sprints`);
    const sel = (i) => `<select data-sp="${i.key}"><option value="">backlog</option>${S.sprints.filter(s => s.state !== 'completed').map(s => `<option value="${s.id}" ${i.sprintId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`;
    return `<div class="panel"><h3>Sprints</h3>${S.sprints.map(s => `<div>${esc(s.name)} [${s.state}] ${s.state === 'planned' ? `<button data-start="${s.id}">Start</button>` : ''}${s.state === 'active' ? `<button data-complete="${s.id}">Complete</button>` : ''}</div>`).join('')}
      <input id="spn" placeholder="Sprint name"><input id="sps" type="date"><input id="spe" type="date"><button id="addSprint">Create sprint</button></div>
      <div class="panel"><h3>Issues</h3><table>${issues.map(i => `<tr><td><a href="#" data-open="${i.key}">${i.key}</a></td><td>${esc(i.title)}</td><td>${i.status}</td><td>${i.storyPoints ?? ''}</td><td>${sel(i)}</td></tr>`).join('')}</table></div>`;
  }
  if (S.view === 'report') {
    S.sprints = await api('GET', `/api/projects/${p.id}/sprints`);
    const sp = S.sprints.find(s => s.id === S.sprintSel) || S.sprints.find(s => s.state === 'active') || S.sprints[0];
    let rep = '';
    if (sp) { const r = await api('GET', `/api/sprints/${sp.id}/report`); rep = `<p>Committed ${r.committedPoints} · Completed ${r.completedPoints} (${r.completedIssues} issues) · Carried over ${r.carriedOver}</p>${burndown(r.burndown, r.committedPoints)}`; }
    const stats = await api('GET', `/api/projects/${p.id}/stats`);
    return `<div class="panel"><select id="spSel">${S.sprints.map(s => `<option value="${s.id}" ${sp && s.id === sp.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>${rep || 'No sprints'}</div>
      <div class="panel"><b>Stats</b><pre>${esc(JSON.stringify(stats, null, 1))}</pre></div>`;
  }
  return settingsView();
}
function burndown(pts, max) {
  if (!pts.length) return '<p>No data yet</p>';
  const W = 480, H = 200, m = Math.max(max, ...pts.map(p => p.remainingPoints), 1);
  const x = (i) => 30 + (pts.length === 1 ? 0 : i * (W - 40) / (pts.length - 1)), y = (v) => H - 20 - v * (H - 40) / m;
  return `<svg width="${W}" height="${H}" role="img" aria-label="burndown"><rect width="${W}" height="${H}" fill="#fff" stroke="#ccc"/>
    <polyline fill="none" stroke="#0052cc" stroke-width="2" points="${pts.map((p, i) => `${x(i)},${y(p.remainingPoints)}`).join(' ')}"/>
    ${pts.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.remainingPoints)}" r="3" fill="#0052cc"><title>${p.date}: ${p.remainingPoints}</title></circle>`).join('')}
    <text x="4" y="14" font-size="10">${m}</text><text x="4" y="${H - 20}" font-size="10">0</text></svg>`;
}
async function settingsView() {
  const p = S.proj;
  const [members, hooks] = await Promise.all([api('GET', `/api/projects/${p.id}/members`), api('GET', `/api/projects/${p.id}/webhooks`).catch(() => [])]);
  return `<div class="panel"><h3>Workflow</h3><textarea id="wf" rows="9" cols="70">${esc(JSON.stringify({ statuses: p.workflow.statuses, transitions: p.workflow.transitions, remap: {} }, null, 1))}</textarea><br><button id="saveWf">Save workflow</button></div>
    <div class="panel"><h3>Members</h3>${members.map(m => `<div>${esc(m.username)} — ${m.role}</div>`).join('')}
      <input id="mu" placeholder="username"><select id="mr"><option>developer</option><option>viewer</option><option>lead</option></select><button id="addMember">Add</button></div>
    <div class="panel"><h3>Webhooks</h3>${hooks.map(w => `<div>${esc(w.url)} [${w.events.join(', ')}] <button data-delhook="${w.id}">delete</button></div>`).join('')}
      <input id="wu" placeholder="https://..."><input id="ws" placeholder="secret"><button id="addHook">Add webhook</button></div>
    <div class="panel"><a href="#" id="exp">Export CSV</a> · import CSV: <input type="file" id="imp"></div>`;
}
async function issueView() {
  const k = S.issue;
  const [i, hist, comments] = await Promise.all([api('GET', `/api/issues/${k}`), api('GET', `/api/issues/${k}/history`), api('GET', `/api/issues/${k}/comments`)]);
  return `<div class="panel"><button id="back">← back</button><h2>${i.key} ${esc(i.title)}</h2><p>${esc(i.description)}</p>
    <p>Status: <select id="st">${S.proj.workflow.statuses.map(s => `<option ${s.name === i.status ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select> · ${i.type} · ${i.priority} · ${i.storyPoints ?? '-'} pts</p>
    ${i.progress ? `<p>Epic progress: ${i.progress.done}/${i.progress.total} (${i.progress.points_done}/${i.progress.points_total} pts)</p>` : ''}
    <h4>Subtasks</h4>${i.children.map(c => `<a href="#" data-open="${c}">${c}</a> `).join('') || 'none'}<br><input id="subt" placeholder="subtask title"><button id="addSub">Add subtask</button>
    <h4>Links</h4>${i.links.map(l => `${l.type} <a href="#" data-open="${l.target}">${l.target}</a>`).join('<br>') || 'none'}<br>
    <select id="lt"><option>blocks</option><option>relates</option><option>duplicates</option></select><input id="ltg" placeholder="KEY-1"><button id="addLink">Link</button>
    <h4>Comments</h4>${comments.map(c => `<div><small>${c.createdAt}${c.edited ? ' (edited)' : ''}</small> ${esc(c.body)}</div>`).join('')}<input id="cm" placeholder="Comment (@user to mention)" size="50"><button id="addCm">Post</button>
    <h4>History</h4>${hist.map(e => `<div><small>${e.at}</small> ${e.field}: ${esc(JSON.stringify(e.from))} → ${esc(JSON.stringify(e.to))}</div>`).join('') || 'none'}
    <p><button id="watch">Watch</button></p></div>`;
}
const val = (id) => document.getElementById(id)?.value;
function bind() {
  const $ = (id) => document.getElementById(id);
  $('wsSel').onchange = (e) => { S.ws = e.target.value; S.project = null; S.issue = null; render(); };
  $('prSel').onchange = (e) => { S.project = e.target.value; S.issue = null; render(); };
  $('newWs').onclick = guard(async () => { const name = prompt('Workspace name'); const key = name && prompt('Key (2-10 uppercase letters)'); if (key) { const w = await api('POST', '/api/workspaces', { name, key }); S.ws = w.id; } render(); });
  $('newPr').onclick = guard(async () => { const name = prompt('Project name'); const key = name && prompt('Key (2-10 uppercase letters)'); if (key) { const p = await api('POST', `/api/workspaces/${S.ws}/projects`, { name, key }); S.project = p.id; } render(); });
  on('[data-view]', 'click', (e) => { S.view = e.target.dataset.view; S.issue = null; render(); });
  $('go').onclick = guard(async () => { S.q = val('q'); S.results = S.q ? await api('GET', '/api/search?q=' + encodeURIComponent(S.q)) : null; render(); });
  $('q').onkeydown = (e) => { if (e.key === 'Enter') $('go').click(); };
  $('bell').onclick = () => { S.notifOpen = !S.notifOpen; render(); };
  $('logout').onclick = async () => { await api('POST', '/api/auth/logout').catch(() => {}); token = null; localStorage.removeItem('pmToken'); render(); };
  $('clr')?.addEventListener('click', () => { S.results = null; render(); });
  $('readAll')?.addEventListener('click', guard(async () => { await api('POST', '/api/notifications/read', { all: true }); render(); }));
  on('[data-open]', 'click', (e) => { e.preventDefault(); S.issue = e.target.dataset.open; S.results = null; S.notifOpen = false; render(); });
  // board drag and drop
  on('.card', 'dragstart', (e) => e.dataTransfer.setData('text/plain', e.currentTarget.dataset.key));
  on('.col', 'dragover', (e) => e.preventDefault());
  on('.col', 'drop', guard(async (e) => { e.preventDefault(); const key = e.dataTransfer.getData('text/plain'); await api('PATCH', `/api/issues/${key}`, { status: e.currentTarget.dataset.status }); render(); }));
  $('addIssue')?.addEventListener('click', guard(async () => { await api('POST', `/api/projects/${S.project}/issues`, { type: val('ntype'), title: val('nt') }); render(); }));
  on('[data-sp]', 'change', guard(async (e) => { await api('PATCH', `/api/issues/${e.target.dataset.sp}`, { sprintId: e.target.value || null }); render(); }));
  on('[data-start]', 'click', guard(async (e) => { await api('POST', `/api/sprints/${e.target.dataset.start}/start`, {}); render(); }));
  on('[data-complete]', 'click', guard(async (e) => { await api('POST', `/api/sprints/${e.target.dataset.complete}/complete`, { carryOverTo: 'backlog' }); render(); }));
  $('addSprint')?.addEventListener('click', guard(async () => { await api('POST', `/api/projects/${S.project}/sprints`, { name: val('spn'), startDate: val('sps') || undefined, endDate: val('spe') || undefined }); render(); }));
  $('spSel')?.addEventListener('change', (e) => { S.sprintSel = e.target.value; render(); });
  $('saveWf')?.addEventListener('click', guard(async () => { await api('PUT', `/api/projects/${S.project}/workflow`, JSON.parse(val('wf'))); render(); }));
  $('addMember')?.addEventListener('click', guard(async () => { await api('POST', `/api/projects/${S.project}/members`, { username: val('mu'), role: val('mr') }); render(); }));
  $('addHook')?.addEventListener('click', guard(async () => { await api('POST', `/api/projects/${S.project}/webhooks`, { url: val('wu'), secret: val('ws'), events: ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'] }); render(); }));
  on('[data-delhook]', 'click', guard(async (e) => { await api('DELETE', `/api/webhooks/${e.target.dataset.delhook}`); render(); }));
  $('exp')?.addEventListener('click', guard(async (e) => { e.preventDefault(); const t = await api('GET', `/api/projects/${S.project}/export.csv`); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([t], { type: 'text/csv' })); a.download = 'export.csv'; a.click(); }));
  $('imp')?.addEventListener('change', guard(async (e) => { const r = await api('POST', `/api/projects/${S.project}/import.csv`, await e.target.files[0].text(), true); S.msg = `Imported ${r.created}, ${r.errors.length} errors`; render(); }));
  // issue detail
  $('back')?.addEventListener('click', () => { S.issue = null; render(); });
  $('st')?.addEventListener('change', guard(async (e) => { await api('PATCH', `/api/issues/${S.issue}`, { status: e.target.value }); render(); }));
  $('addSub')?.addEventListener('click', guard(async () => { await api('POST', `/api/projects/${S.project}/issues`, { type: 'subtask', title: val('subt'), parentId: S.issue }); render(); }));
  $('addLink')?.addEventListener('click', guard(async () => { await api('POST', `/api/issues/${S.issue}/links`, { type: val('lt'), target: val('ltg') }); render(); }));
  $('addCm')?.addEventListener('click', guard(async () => { await api('POST', `/api/issues/${S.issue}/comments`, { body: val('cm') }); render(); }));
  $('watch')?.addEventListener('click', guard(async () => { await api('POST', `/api/issues/${S.issue}/watch`, {}); render(); }));
}
render();
