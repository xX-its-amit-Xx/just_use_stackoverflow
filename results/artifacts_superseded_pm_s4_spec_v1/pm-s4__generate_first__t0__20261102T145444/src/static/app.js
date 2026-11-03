const $app = document.getElementById('app');
const S = { token: localStorage.getItem('token'), me: null, ws: [], wsId: null, projects: [], pid: null, view: 'board', issue: null, msg: '', notif: null };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(method, path, body, raw) {
  const r = await fetch(path, { method, headers: { ...(S.token ? { authorization: 'Bearer ' + S.token } : {}), 'content-type': raw ? 'text/csv' : 'application/json' }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
  const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) { const e = new Error(j?.message || r.statusText); e.status = r.status; throw e; }
  return j;
}
const h = (html) => { $app.innerHTML = html; };
const proj = () => S.projects.find(p => p.id === S.pid);
async function guard(fn) { try { S.msg = ''; await fn(); } catch (e) { S.msg = e.message; if (e.status === 401 && S.token) { logout(); return; } render(); } }
function logout() { S.token = null; localStorage.removeItem('token'); S.me = null; render(); }

async function boot() {
  if (S.token) { try { S.me = await api('GET', '/api/auth/me'); S.ws = await api('GET', '/api/workspaces'); S.wsId = S.wsId || S.ws[0]?.id; await loadProjects(); } catch { S.token = null; } }
  render();
}
async function loadProjects() {
  S.projects = S.wsId ? await api('GET', `/api/workspaces/${S.wsId}/projects`) : [];
  if (!S.projects.find(p => p.id === S.pid)) S.pid = S.projects[0]?.id || null;
}
function loginView() {
  h(`<main><div class="panel"><h2>Project Manager</h2><p class="err">${esc(S.msg)}</p>
  <input id="u" placeholder="username"><input id="p" type="password" placeholder="password">
  <button id="login">Login</button><button id="reg">Register</button></div></main>`);
  const creds = () => ({ username: document.getElementById('u').value, password: document.getElementById('p').value });
  document.getElementById('login').onclick = () => guard(async () => { const r = await api('POST', '/api/auth/login', creds()); S.token = r.token; localStorage.setItem('token', r.token); await boot(); });
  document.getElementById('reg').onclick = () => guard(async () => { await api('POST', '/api/auth/register', creds()); const r = await api('POST', '/api/auth/login', creds()); S.token = r.token; localStorage.setItem('token', r.token); await boot(); });
}
function render() {
  if (!S.token || !S.me) return loginView();
  h(`<header><b>PM</b>
   <select id="wsel">${S.ws.map(w => `<option value="${w.id}" ${w.id === S.wsId ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select>
   <button id="newws">+ Workspace</button>
   <select id="psel">${S.projects.map(p => `<option value="${p.id}" ${p.id === S.pid ? 'selected' : ''}>${esc(p.key)} ${esc(p.name)}</option>`).join('')}</select>
   <button id="newp">+ Project</button>
   <nav>${['board', 'backlog', 'sprints', 'settings'].map(v => `<button data-v="${v}">${v}</button>`).join('')}</nav>
   <input id="q" placeholder='search e.g. status:"In Progress" -label:x'><button id="go">Search</button>
   <button id="bell">Notifications</button><span>${esc(S.me.username)}</span><button id="out">Logout</button></header>
   <main><p class="err">${esc(S.msg)}</p><div id="view"></div></main>`);
  const $ = (id) => document.getElementById(id);
  $('wsel').onchange = (e) => guard(async () => { S.wsId = e.target.value; S.pid = null; await loadProjects(); render(); });
  $('psel').onchange = (e) => { S.pid = e.target.value; render(); };
  $('newws').onclick = () => guard(async () => { const name = prompt('Workspace name'); const key = name && prompt('Key (2-10 uppercase letters)'); if (!key) return; const w = await api('POST', '/api/workspaces', { name, key }); S.ws.push(w); S.wsId = w.id; await loadProjects(); render(); });
  $('newp').onclick = () => guard(async () => { const name = prompt('Project name'); const key = name && prompt('Key'); if (!key) return; const p = await api('POST', `/api/workspaces/${S.wsId}/projects`, { name, key }); S.pid = p.id; await loadProjects(); render(); });
  document.querySelectorAll('nav button').forEach(b => b.onclick = () => { S.view = b.dataset.v; S.issue = null; render(); });
  $('out').onclick = () => guard(async () => { await api('POST', '/api/auth/logout'); logout(); });
  $('go').onclick = () => { S.view = 'search'; S.q = $('q').value; render(); };
  $('bell').onclick = () => guard(async () => { S.view = 'notifications'; render(); });
  guard(async () => {
    const v = S.issue ? 'issue' : S.view;
    if (!proj() && !['search', 'notifications'].includes(v)) { $('view').innerHTML = '<p>Create or select a project.</p>'; return; }
    await ({ board, backlog, sprints, settings, issue: issueView, search: searchView, notifications: notifView }[v] || board)($('view'));
  });
}
const issueCard = (i) => `<div class="card" draggable="true" data-key="${i.key}"><b>${esc(i.key)}</b> ${esc(i.title)}<div class="muted">${esc(i.type)} · ${esc(i.priority)}${i.storyPoints != null ? ' · ' + i.storyPoints + 'pt' : ''}</div></div>`;
function openOnClick(el) { el.querySelectorAll('.card').forEach(c => c.onclick = () => guard(async () => { S.issue = c.dataset.key; render(); })); }
async function board(el) {
  const p = proj(); const issues = await api('GET', `/api/projects/${p.id}/issues`);
  el.innerHTML = `<div class="panel"><input id="nt" placeholder="New issue title"><select id="ntype">${['task', 'bug', 'feature', 'epic'].map(t => `<option>${t}</option>`).join('')}</select><button id="add">Create</button></div>
   <div class="board">${p.workflow.statuses.map(s => `<div class="col" data-s="${esc(s.name)}"><b>${esc(s.name)}</b> <span class="muted">${s.category}</span>${issues.filter(i => i.status === s.name).map(issueCard).join('')}</div>`).join('')}</div>`;
  openOnClick(el);
  el.querySelector('#add').onclick = () => guard(async () => { await api('POST', `/api/projects/${p.id}/issues`, { title: el.querySelector('#nt').value, type: el.querySelector('#ntype').value }); render(); });
  el.querySelectorAll('.card').forEach(c => c.ondragstart = (e) => e.dataTransfer.setData('text/plain', c.dataset.key));
  el.querySelectorAll('.col').forEach(col => {
    col.ondragover = (e) => { e.preventDefault(); col.classList.add('over'); };
    col.ondragleave = () => col.classList.remove('over');
    col.ondrop = (e) => { e.preventDefault(); const key = e.dataTransfer.getData('text/plain'); guard(async () => { await api('PATCH', `/api/issues/${key}`, { status: col.dataset.s }); render(); }); };
  });
}
async function backlog(el) {
  const p = proj(); const [issues, sprints] = await Promise.all([api('GET', `/api/projects/${p.id}/issues`), api('GET', `/api/projects/${p.id}/sprints`)]);
  const open = sprints.filter(s => s.state !== 'completed');
  const sel = (i) => `<select data-k="${i.key}"><option value="">Backlog</option>${open.map(s => `<option value="${s.id}" ${s.id === i.sprintId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`;
  const group = (title, list) => `<div class="panel"><h3>${esc(title)}</h3>${list.map(i => `<div>${issueCard(i)}${sel(i)}</div>`).join('') || '<span class="muted">empty</span>'}</div>`;
  el.innerHTML = `<div class="panel"><input id="sn" placeholder="Sprint name"><button id="ns">Create sprint</button></div>` +
    open.map(s => group(`${s.name} (${s.state})`, issues.filter(i => i.sprintId === s.id))).join('') + group('Backlog', issues.filter(i => !i.sprintId));
  openOnClick(el);
  el.querySelector('#ns').onclick = () => guard(async () => { await api('POST', `/api/projects/${p.id}/sprints`, { name: el.querySelector('#sn').value }); render(); });
  el.querySelectorAll('select[data-k]').forEach(s => s.onchange = () => guard(async () => { await api('PATCH', `/api/issues/${s.dataset.k}`, { sprintId: s.value || null }); render(); }));
}
function burndownSvg(data) {
  if (!data.length) return '<p class="muted">No data</p>';
  const W = 480, H = 200, max = Math.max(1, ...data.map(d => d.remainingPoints));
  const x = (i) => 30 + (data.length === 1 ? 0 : i * (W - 40) / (data.length - 1)), y = (v) => H - 20 - v * (H - 40) / max;
  return `<svg id="burndown" width="${W}" height="${H}" style="background:#fff"><line x1="30" y1="${H - 20}" x2="${W - 10}" y2="${H - 20}" stroke="#999"/><line x1="30" y1="10" x2="30" y2="${H - 20}" stroke="#999"/>
  <polyline fill="none" stroke="#0052cc" stroke-width="2" points="${data.map((d, i) => `${x(i)},${y(d.remainingPoints)}`).join(' ')}"/>
  ${data.map((d, i) => `<circle cx="${x(i)}" cy="${y(d.remainingPoints)}" r="3" fill="#0052cc"><title>${d.date}: ${d.remainingPoints}</title></circle>`).join('')}
  <text x="2" y="14" font-size="10">${max}</text><text x="10" y="${H - 20}" font-size="10">0</text></svg>`;
}
async function sprints(el) {
  const p = proj(); const list = await api('GET', `/api/projects/${p.id}/sprints`);
  const reps = {}; for (const s of list) if (s.state !== 'planned') reps[s.id] = await api('GET', `/api/sprints/${s.id}/report`);
  el.innerHTML = list.map(s => { const r = reps[s.id]; return `<div class="panel"><h3>${esc(s.name)} <span class="muted">${s.state} ${esc(s.startDate || '')} ${esc(s.endDate || '')}</span></h3>
   ${s.state === 'planned' ? `<button data-start="${s.id}">Start</button>` : ''}
   ${s.state === 'active' ? `<select data-co="${s.id}"><option value="backlog">carry over to backlog</option>${list.filter(o => o.id !== s.id && o.state === 'planned').map(o => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}</select><button data-done="${s.id}">Complete</button>` : ''}
   ${r ? `<p>Committed ${r.committedPoints} · Completed ${r.completedPoints} (${r.completedIssues} issues) · Carried over ${r.carriedOver}</p>${burndownSvg(r.burndown)}` : ''}</div>`; }).join('') || '<p>No sprints.</p>';
  el.querySelectorAll('[data-start]').forEach(b => b.onclick = () => guard(async () => { await api('POST', `/api/sprints/${b.dataset.start}/start`); render(); }));
  el.querySelectorAll('[data-done]').forEach(b => b.onclick = () => guard(async () => { await api('POST', `/api/sprints/${b.dataset.done}/complete`, { carryOverTo: el.querySelector(`[data-co="${b.dataset.done}"]`).value }); render(); }));
}
async function issueView(el) {
  const i = await api('GET', `/api/issues/${S.issue}`);
  const [comments, history] = await Promise.all([api('GET', `/api/issues/${i.key}/comments`), api('GET', `/api/issues/${i.key}/history`)]);
  const p = proj();
  el.innerHTML = `<div class="panel"><button id="back">← Back</button><h2>${esc(i.key)} ${esc(i.title)}</h2>
   <p>${esc(i.description)}</p>
   <label>Status <select id="st">${p.workflow.statuses.map(s => `<option ${s.name === i.status ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
   <label>Priority <select id="pr">${['urgent', 'high', 'medium', 'low', 'none'].map(x => `<option ${x === i.priority ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
   <button id="watch">${i.watchers.includes(S.me.id) ? 'Unwatch' : 'Watch'}</button><button id="del">Delete</button>
   ${i.progress ? `<p>Epic progress: ${i.progress.done}/${i.progress.total} issues, ${i.progress.points_done}/${i.progress.points_total} points</p>` : ''}
   <h3>Subtasks</h3><ul>${i.children.map(k => `<li>${esc(k)}</li>`).join('')}</ul>
   <input id="sub" placeholder="Subtask title"><button id="addsub">Add subtask</button>
   <h3>Links</h3><ul>${i.links.map(l => `<li>${esc(l.type)} ${esc(l.key)} — ${esc(l.title)}</li>`).join('')}</ul>
   <select id="lt"><option>blocks</option><option>relates</option><option>duplicates</option></select><input id="lk" placeholder="KEY-1"><button id="addl">Link</button>
   <h3>Comments</h3>${comments.map(c => `<div class="card">${esc(c.body)} <span class="muted">${c.edited ? '(edited) ' : ''}${esc(c.createdAt)}</span></div>`).join('')}
   <textarea id="cb" placeholder="Comment (use @username)"></textarea><button id="addc">Comment</button>
   <h3>History</h3><ul>${history.map(x => `<li class="muted">${esc(x.at)}: ${esc(x.field)} ${esc(JSON.stringify(x.from))} → ${esc(JSON.stringify(x.to))}</li>`).join('')}</ul></div>`;
  const $ = (id) => el.querySelector('#' + id); const patch = (b) => guard(async () => { await api('PATCH', `/api/issues/${i.key}`, b); render(); });
  $('back').onclick = () => { S.issue = null; render(); };
  $('st').onchange = (e) => patch({ status: e.target.value }); $('pr').onchange = (e) => patch({ priority: e.target.value });
  $('watch').onclick = () => guard(async () => { await api(i.watchers.includes(S.me.id) ? 'DELETE' : 'POST', `/api/issues/${i.key}/watch`); render(); });
  $('del').onclick = () => guard(async () => { if (confirm('Delete?')) { await api('DELETE', `/api/issues/${i.key}`); S.issue = null; render(); } });
  $('addsub').onclick = () => guard(async () => { await api('POST', `/api/projects/${p.id}/issues`, { type: 'subtask', title: $('sub').value, parentId: i.id }); render(); });
  $('addl').onclick = () => guard(async () => { await api('POST', `/api/issues/${i.key}/links`, { type: $('lt').value, target: $('lk').value }); render(); });
  $('addc').onclick = () => guard(async () => { await api('POST', `/api/issues/${i.key}/comments`, { body: $('cb').value }); render(); });
}
async function searchView(el) {
  const r = await api('GET', '/api/search?q=' + encodeURIComponent(S.q || '') + (S.pid && S.scope ? '&project=' + S.pid : ''));
  el.innerHTML = `<h3>Search: ${esc(S.q)}</h3>` + (r.map(issueCard).join('') || '<p>No results</p>'); openOnClick(el);
}
async function notifView(el) {
  const list = await api('GET', '/api/notifications');
  el.innerHTML = `<div class="panel"><h3>Notifications</h3><button id="all">Mark all read</button>${list.map(n => `<div class="card" data-key="${esc(n.issueKey)}" style="${n.read ? 'opacity:.6' : ''}">${esc(n.type)} on ${esc(n.issueKey)} <span class="muted">${esc(n.at)}</span></div>`).join('') || '<p>None</p>'}</div>`;
  openOnClick(el); el.querySelector('#all').onclick = () => guard(async () => { await api('POST', '/api/notifications/read', { all: true }); render(); });
}
async function settings(el) {
  const p = proj();
  const [members, hooks] = await Promise.all([api('GET', `/api/projects/${p.id}/members`), api('GET', `/api/projects/${p.id}/webhooks`).catch(() => [])]);
  el.innerHTML = `<div class="panel"><h3>Workflow</h3>
   <textarea id="wf" rows="8" cols="60">${esc(JSON.stringify({ statuses: p.workflow.statuses, transitions: p.workflow.transitions, remap: {} }, null, 1))}</textarea><br>
   <button id="savewf">Save workflow</button> <span class="muted">Provide remap for removed in-use statuses.</span></div>
   <div class="panel"><h3>Members</h3><ul>${members.map(m => `<li>${esc(m.username)} — ${esc(m.role)}</li>`).join('')}</ul>
   <input id="mu" placeholder="username"><select id="mr"><option>developer</option><option>lead</option><option>viewer</option></select><button id="addm">Add/Set</button></div>
   <div class="panel"><h3>Webhooks</h3><ul>${hooks.map(w => `<li>${esc(w.url)} [${esc(w.events.join(','))}] <button data-del="${w.id}">x</button></li>`).join('')}</ul>
   <input id="wu" placeholder="https://..."><input id="ws" placeholder="secret"><select id="we" multiple>${['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'].map(e => `<option>${e}</option>`).join('')}</select><button id="addw">Add</button></div>
   <div class="panel"><h3>CSV</h3><a href="#" id="exp">Export</a> <input type="file" id="imp"></div>`;
  const $ = (id) => el.querySelector('#' + id);
  $('savewf').onclick = () => guard(async () => { await api('PUT', `/api/projects/${p.id}/workflow`, JSON.parse($('wf').value)); await loadProjects(); render(); });
  $('addm').onclick = () => guard(async () => { await api('POST', `/api/projects/${p.id}/members`, { username: $('mu').value, role: $('mr').value }); render(); });
  $('addw').onclick = () => guard(async () => { await api('POST', `/api/projects/${p.id}/webhooks`, { url: $('wu').value, secret: $('ws').value, events: [...$('we').selectedOptions].map(o => o.value) }); render(); });
  el.querySelectorAll('[data-del]').forEach(b => b.onclick = () => guard(async () => { await api('DELETE', `/api/webhooks/${b.dataset.del}`); render(); }));
  $('exp').onclick = (e) => { e.preventDefault(); guard(async () => { const t = await api('GET', `/api/projects/${p.id}/export.csv`); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([t], { type: 'text/csv' })); a.download = p.key + '.csv'; a.click(); }); };
  $('imp').onchange = (e) => guard(async () => { const r = await api('POST', `/api/projects/${p.id}/import.csv`, await e.target.files[0].text(), true); S.msg = `Imported ${r.created}; ${r.errors.length} errors`; render(); });
}
boot();
