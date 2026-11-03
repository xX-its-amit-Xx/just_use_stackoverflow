const $ = s => document.querySelector(s);
const S = { token: localStorage.getItem('token'), ws: null, project: null, view: 'board', issue: null, msg: '' };
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json', ...(S.token ? { authorization: 'Bearer ' + S.token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch { d = t; }
  if (!r.ok) throw new Error((d && d.message) || r.statusText);
  return d;
}
const app = $('#app');
async function guard(f) { try { S.msg = ''; await f(); } catch (e) { S.msg = e.message; } render(); }
function login() {
  app.innerHTML = `<main><div class="panel"><h2>Project Manager</h2><p class="err">${esc(S.msg)}</p>
  <input id="u" placeholder="username"><input id="p" type="password" placeholder="password"><input id="d" placeholder="display name (register)">
  <button id="li">Login</button><button id="rg">Register</button></div></main>`;
  $('#li').onclick = () => guard(async () => { const r = await api('POST', '/api/auth/login', { username: $('#u').value, password: $('#p').value }); S.token = r.token; localStorage.setItem('token', r.token); });
  $('#rg').onclick = () => guard(async () => { await api('POST', '/api/auth/register', { username: $('#u').value, password: $('#p').value, displayName: $('#d').value || undefined }); S.msg = 'Registered; now log in.'; });
}
async function render() {
  if (!S.token) return login();
  try {
    const wss = await api('GET', '/api/workspaces');
    if (!S.ws && wss.length) S.ws = wss[0].id;
    const projects = S.ws ? await api('GET', `/api/workspaces/${S.ws}/projects`) : [];
    if (!projects.find(p => p.id === S.project)) S.project = projects[0]?.id || null;
    const proj = projects.find(p => p.id === S.project);
    const notes = await api('GET', '/api/notifications?unread=true');
    app.innerHTML = `<header><b>PM</b>
      <select id="wsel">${wss.map(w => `<option value="${w.id}" ${w.id === S.ws ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select>
      <button id="nw">+ws</button>
      <select id="psel">${projects.map(p => `<option value="${p.id}" ${p.id === S.project ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
      <button id="np">+project</button>
      <nav>${['board', 'backlog', 'report', 'settings', 'notifications'].map(v => `<button data-v="${v}">${v}${v === 'notifications' ? ' (' + notes.length + ')' : ''}</button>`).join('')}</nav>
      <input id="q" placeholder='search e.g. status:"In Progress" -label:x'><button id="qs">Search</button><button id="lo">Logout</button></header>
      <main><p class="err">${esc(S.msg)}</p><div id="view"></div></main>`;
    $('#wsel').onchange = e => { S.ws = e.target.value; S.project = null; render(); };
    $('#psel').onchange = e => { S.project = e.target.value; render(); };
    $('#nw').onclick = () => guard(async () => { const name = prompt('Workspace name'), key = prompt('Key (2-10 capital letters)'); if (name && key) S.ws = (await api('POST', '/api/workspaces', { name, key })).id; });
    $('#np').onclick = () => guard(async () => { const name = prompt('Project name'), key = prompt('Key'); if (name && key) S.project = (await api('POST', `/api/workspaces/${S.ws}/projects`, { name, key })).id; });
    document.querySelectorAll('nav button').forEach(b => b.onclick = () => { S.view = b.dataset.v; S.issue = null; render(); });
    $('#qs').onclick = () => { S.view = 'search'; S.q = $('#q').value; render(); };
    $('#lo').onclick = () => guard(async () => { await api('POST', '/api/auth/logout'); S.token = null; localStorage.removeItem('token'); });
    const v = $('#view');
    if (S.issue) return issueView(v, S.issue);
    if (S.view === 'notifications') return notesView(v, notes);
    if (S.view === 'search') return searchView(v);
    if (!proj) { v.innerHTML = '<p>Create a workspace and project to begin.</p>'; return; }
    ({ board, backlog, report, settings }[S.view] || board)(v, proj);
  } catch (e) { if (/authentication/.test(e.message)) { S.token = null; localStorage.removeItem('token'); return login(); } S.msg = e.message; app.innerHTML = `<main class="err">${esc(e.message)}</main>`; }
}
const card = i => `<div class="card" draggable="true" data-k="${i.key}"><a href="#" data-open="${i.key}">${i.key}</a> ${esc(i.title)}<br><small>${i.type} · ${i.priority} · ${i.storyPoints ?? '-'}pt</small></div>`;
function bindOpen(v) { v.querySelectorAll('[data-open]').forEach(a => a.onclick = e => { e.preventDefault(); S.issue = a.dataset.open; render(); }); }
async function newIssueForm(v, proj) {
  v.insertAdjacentHTML('afterbegin', `<div class="panel"><input id="nt" placeholder="New issue title"><select id="ntype">${['task', 'bug', 'feature', 'epic'].map(t => `<option>${t}</option>`).join('')}</select><input id="npts" size="3" placeholder="pts"><button id="nc">Create</button></div>`);
  $('#nc').onclick = () => guard(async () => { await api('POST', `/api/projects/${proj.id}/issues`, { title: $('#nt').value, type: $('#ntype').value, storyPoints: $('#npts').value ? Number($('#npts').value) : undefined }); });
}
async function board(v, proj) {
  const issues = await api('GET', `/api/projects/${proj.id}/issues`);
  v.innerHTML = `<div class="board">${proj.workflow.statuses.map(s => `<div class="col" data-s="${esc(s.name)}"><b>${esc(s.name)}</b>${issues.filter(i => i.status === s.name).map(card).join('')}</div>`).join('')}</div>`;
  newIssueForm(v, proj); bindOpen(v);
  v.querySelectorAll('.card').forEach(c => c.ondragstart = e => e.dataTransfer.setData('text/plain', c.dataset.k));
  v.querySelectorAll('.col').forEach(col => { col.ondragover = e => e.preventDefault(); col.ondrop = e => { e.preventDefault(); guard(() => api('PATCH', '/api/issues/' + e.dataTransfer.getData('text/plain'), { status: col.dataset.s })); }; });
}
async function backlog(v, proj) {
  const [issues, sprints] = await Promise.all([api('GET', `/api/projects/${proj.id}/issues`), api('GET', `/api/projects/${proj.id}/sprints`)]);
  const opts = (cur) => `<option value="">backlog</option>` + sprints.filter(s => s.state !== 'completed').map(s => `<option value="${s.id}" ${s.id === cur ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  const sect = (title, list, extra = '') => `<div class="panel"><h3>${title} ${extra}</h3>${list.map(i => `<div>${card(i)}<select data-mv="${i.key}">${opts(i.sprintId)}</select></div>`).join('') || '<i>empty</i>'}</div>`;
  v.innerHTML = `<div class="panel"><input id="sn" placeholder="Sprint name"><button id="sa">Create sprint</button></div>` +
    sprints.filter(s => s.state !== 'completed').map(s => sect(`${esc(s.name)} [${s.state}]`, issues.filter(i => i.sprintId === s.id),
      s.state === 'planned' ? `<button data-start="${s.id}">Start</button>` : `<button data-done="${s.id}">Complete</button>`)).join('') +
    sect('Backlog', issues.filter(i => !i.sprintId || !sprints.find(s => s.id === i.sprintId && s.state !== 'completed')));
  bindOpen(v);
  $('#sa').onclick = () => guard(() => api('POST', `/api/projects/${proj.id}/sprints`, { name: $('#sn').value }));
  v.querySelectorAll('[data-start]').forEach(b => b.onclick = () => guard(() => api('POST', `/api/sprints/${b.dataset.start}/start`)));
  v.querySelectorAll('[data-done]').forEach(b => b.onclick = () => guard(() => api('POST', `/api/sprints/${b.dataset.done}/complete`, { carryOverTo: 'backlog' })));
  v.querySelectorAll('[data-mv]').forEach(s => s.onchange = () => guard(() => api('PATCH', '/api/issues/' + s.dataset.mv, { sprintId: s.value || null })));
}
async function report(v, proj) {
  const sprints = await api('GET', `/api/projects/${proj.id}/sprints`);
  v.innerHTML = `<div class="panel"><select id="rs">${sprints.map(s => `<option value="${s.id}">${esc(s.name)} (${s.state})</option>`).join('')}</select><div id="rep"></div></div>`;
  const load = async () => {
    if (!$('#rs').value) return;
    const r = await api('GET', `/api/sprints/${$('#rs').value}/report`);
    const W = 500, H = 200, n = r.burndown.length, max = Math.max(1, ...r.burndown.map(b => b.remainingPoints), r.committedPoints);
    const pts = r.burndown.map((b, k) => `${30 + (n > 1 ? k * (W - 40) / (n - 1) : 0)},${H - 20 - b.remainingPoints / max * (H - 40)}`).join(' ');
    $('#rep').innerHTML = `<p>Committed ${r.committedPoints} · Completed ${r.completedPoints} (${r.completedIssues} issues) · Carried over ${r.carriedOver}</p>
      <svg id="burndown" width="${W}" height="${H}" style="background:#fff;border:1px solid #ccc"><polyline fill="none" stroke="#0052cc" stroke-width="2" points="${pts}"/>
      <text x="2" y="14" font-size="10">${max}</text><text x="2" y="${H - 20}" font-size="10">0</text>
      ${r.burndown.map((b, k) => `<text x="${30 + (n > 1 ? k * (W - 40) / (n - 1) : 0)}" y="${H - 5}" font-size="8">${b.date.slice(5)}</text>`).join('')}</svg>`;
  };
  $('#rs').onchange = load; load();
}
async function settings(v, proj) {
  const wf = proj.workflow;
  const hooks = await api('GET', `/api/projects/${proj.id}/webhooks`).catch(() => []);
  v.innerHTML = `<div class="panel"><h3>Workflow</h3><p>One status per line as <code>name:category</code> (backlog|unstarted|started|completed). Transitions default to any→any.</p>
    <textarea id="wf" rows="6" cols="40">${esc(wf.statuses.map(s => s.name + ':' + s.category).join('\n'))}</textarea><br>
    <input id="rm" placeholder='remap JSON e.g. {"Old":"New"}' size="40"><button id="wfs">Save workflow</button></div>
    <div class="panel"><h3>Members</h3><ul>${proj.members.map(m => `<li>${esc(m.username)} — ${m.role}</li>`).join('')}</ul>
    <input id="mu" placeholder="username"><select id="mr"><option>developer</option><option>lead</option><option>viewer</option></select><button id="ma">Add</button></div>
    <div class="panel"><h3>Webhooks</h3><ul>${hooks.map(h => `<li>${esc(h.url)} [${h.events}] <button data-dw="${h.id}">x</button></li>`).join('')}</ul>
    <input id="wu" placeholder="https://..."><input id="ws" placeholder="secret"><button id="wa">Add (all events)</button></div>`;
  $('#wfs').onclick = () => guard(() => {
    const statuses = $('#wf').value.split('\n').filter(Boolean).map(l => { const [name, category] = l.split(':'); return { name: name.trim(), category: (category || '').trim() }; });
    return api('PUT', `/api/projects/${proj.id}/workflow`, { statuses, remap: $('#rm').value ? JSON.parse($('#rm').value) : undefined });
  });
  $('#ma').onclick = () => guard(() => api('POST', `/api/projects/${proj.id}/members`, { username: $('#mu').value, role: $('#mr').value }));
  $('#wa').onclick = () => guard(() => api('POST', `/api/projects/${proj.id}/webhooks`, { url: $('#wu').value, secret: $('#ws').value, events: ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'] }));
  v.querySelectorAll('[data-dw]').forEach(b => b.onclick = () => guard(() => api('DELETE', '/api/webhooks/' + b.dataset.dw)));
}
async function notesView(v, notes) {
  v.innerHTML = `<div class="panel"><button id="ra">Mark all read</button>${notes.map(n => `<div class="unread">${esc(n.type)} on <a href="#" data-open="${n.issueKey}">${n.issueKey}</a> at ${n.at}</div>`).join('') || '<p>No unread notifications</p>'}</div>`;
  bindOpen(v); $('#ra').onclick = () => guard(() => api('POST', '/api/notifications/read', { all: true }));
}
async function searchView(v) {
  const res = await api('GET', '/api/search?q=' + encodeURIComponent(S.q || '') + (S.project ? '&project=' + S.project : ''));
  v.innerHTML = `<div class="panel"><h3>Results (${res.length})</h3>${res.map(card).join('')}</div>`; bindOpen(v);
}
async function issueView(v, key) {
  const [i, hist, comments] = await Promise.all([api('GET', '/api/issues/' + key), api('GET', `/api/issues/${key}/history`), api('GET', `/api/issues/${key}/comments`)]);
  v.innerHTML = `<div class="panel"><button id="back">← back</button><h2>${i.key} ${esc(i.title)}</h2><p>${esc(i.description)}</p>
    <p>Status: <b>${esc(i.status)}</b> · ${i.type} · ${i.priority} · ${i.storyPoints ?? '-'} pts · due ${i.dueDate || '-'}</p>
    ${i.progress ? `<p>Epic progress: ${i.progress.done}/${i.progress.total} issues, ${i.progress.points_done}/${i.progress.points_total} pts</p>` : ''}
    <button id="watch">Watch</button><button id="del">Delete</button>
    <h3>Subtasks</h3>${i.children.map(c => `<a href="#" data-open="${c}">${c}</a> `).join('') || '<i>none</i>'}
    <div><input id="st" placeholder="Subtask title"><button id="sta">Add subtask</button></div>
    <h3>Links</h3>${i.links.map(l => `${l.type} <a href="#" data-open="${l.target}">${l.target}</a><br>`).join('') || '<i>none</i>'}
    <div><select id="lt"><option>blocks</option><option>relates</option><option>duplicates</option></select><input id="lk" placeholder="KEY-1"><button id="la">Link</button></div>
    <h3>Comments</h3>${comments.map(c => `<div><small>${c.authorId}${c.edited ? ' (edited)' : ''}</small> ${esc(c.body)}</div>`).join('')}
    <div><input id="cb" placeholder="Comment, @mention"><button id="ca">Add</button></div>
    <h3>History</h3><table>${hist.map(h => `<tr><td>${h.at}</td><td>${h.field}</td><td>${esc(JSON.stringify(h.from))}</td><td>${esc(JSON.stringify(h.to))}</td></tr>`).join('')}</table></div>`;
  bindOpen(v);
  $('#back').onclick = () => { S.issue = null; render(); };
  $('#watch').onclick = () => guard(() => api('POST', `/api/issues/${key}/watch`));
  $('#del').onclick = () => guard(async () => { await api('DELETE', '/api/issues/' + key); S.issue = null; });
  $('#sta').onclick = () => guard(() => api('POST', `/api/projects/${i.projectId}/issues`, { type: 'subtask', title: $('#st').value, parentId: i.id }));
  $('#la').onclick = () => guard(() => api('POST', `/api/issues/${key}/links`, { type: $('#lt').value, target: $('#lk').value }));
  $('#ca').onclick = () => guard(() => api('POST', `/api/issues/${key}/comments`, { body: $('#cb').value }));
}
render();
