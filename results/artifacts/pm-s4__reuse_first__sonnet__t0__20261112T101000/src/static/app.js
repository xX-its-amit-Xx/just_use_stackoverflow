// Single-page app. Uses only the public REST API.
const $app = document.getElementById('app');
const S = { token: localStorage.getItem('token'), me: null, ws: [], wsId: null, projects: [], projId: null, view: 'board', issueKey: null, err: '' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(method, path, body, raw) {
  const r = await fetch(path, { method, headers: { ...(raw ? { 'content-type': 'text/csv' } : { 'content-type': 'application/json' }), ...(S.token ? { authorization: 'Bearer ' + S.token } : {}) }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error((j && j.message) || r.statusText);
  return j;
}
const guard = (fn) => async (...a) => { try { S.err = ''; await fn(...a); } catch (e) { S.err = e.message; render(); } };
const proj = () => S.projects.find((p) => p.id === S.projId);

async function loadWs() { S.ws = await api('GET', '/api/workspaces'); if (!S.wsId && S.ws[0]) S.wsId = S.ws[0].id; await loadProjects(); }
async function loadProjects() { S.projects = S.wsId ? await api('GET', `/api/workspaces/${S.wsId}/projects`) : []; if (!proj()) S.projId = S.projects[0]?.id || null; }
async function boot() {
  if (S.token) { try { S.me = (await api('GET', '/api/auth/me')).user; await loadWs(); } catch { S.token = null; localStorage.removeItem('token'); } }
  render();
}

function render() {
  if (!S.me) return renderAuth();
  $app.innerHTML = `<header><b>PM</b>
    <select id="wsSel">${S.ws.map((w) => `<option value="${w.id}" ${w.id === S.wsId ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select>
    <button id="newWs">+ Workspace</button>
    <select id="prSel">${S.projects.map((p) => `<option value="${p.id}" ${p.id === S.projId ? 'selected' : ''}>${esc(p.name)} (${esc(p.key)})</option>`).join('')}</select>
    <button id="newPr">+ Project</button>
    <nav>${['board', 'backlog', 'sprints', 'notifications', 'settings'].map((v) => `<button data-view="${v}">${v}</button>`).join('')}</nav>
    <input id="q" placeholder='search: status:"In Progress" -label:x' size="36"><button id="go">Search</button>
    <span style="margin-left:auto">${esc(S.me.displayName)} <button id="logout">Logout</button></span></header>
    <main>${S.err ? `<p class="err">${esc(S.err)}</p>` : ''}<div id="view"></div></main>`;
  const $ = (id) => document.getElementById(id);
  $('wsSel').onchange = guard(async (e) => { S.wsId = e.target.value; S.projId = null; await loadProjects(); render(); });
  $('prSel').onchange = (e) => { S.projId = e.target.value; render(); };
  $('newWs').onclick = guard(async () => { const name = prompt('Name'); const key = name && prompt('Key (2-10 capitals)'); if (!key) return; const w = await api('POST', '/api/workspaces', { name, key }); S.wsId = w.id; await loadWs(); render(); });
  $('newPr').onclick = guard(async () => { const name = prompt('Name'); const key = name && prompt('Key (2-10 capitals)'); if (!key) return; const p = await api('POST', `/api/workspaces/${S.wsId}/projects`, { name, key }); S.projId = p.id; await loadProjects(); render(); });
  $('logout').onclick = guard(async () => { await api('POST', '/api/auth/logout'); localStorage.removeItem('token'); S.token = null; S.me = null; render(); });
  $('go').onclick = guard(() => { S.view = 'search'; S.query = $('q').value; render(); });
  $('q').onkeydown = (e) => { if (e.key === 'Enter') $('go').click(); };
  document.querySelectorAll('nav button').forEach((b) => (b.onclick = () => { S.view = b.dataset.view; S.issueKey = null; render(); }));
  if (S.issueKey) return viewIssue();
  ({ board: viewBoard, backlog: viewBacklog, sprints: viewSprints, notifications: viewNotifs, settings: viewSettings, search: viewSearch }[S.view])().catch((e) => { S.err = e.message; render(); });
}

function renderAuth() {
  $app.innerHTML = `<main><div class="panel" style="max-width:320px;margin:40px auto"><h2>Sign in</h2>${S.err ? `<p class="err">${esc(S.err)}</p>` : ''}
    <div class="row"><input id="u" placeholder="username"></div><div class="row"><input id="p" type="password" placeholder="password"></div>
    <div class="row"><input id="d" placeholder="display name (register)"></div>
    <div class="row"><button id="li">Login</button><button id="rg">Register</button></div></div></main>`;
  const val = (id) => document.getElementById(id).value;
  const login = async () => { const r = await api('POST', '/api/auth/login', { username: val('u'), password: val('p') }); S.token = r.token; localStorage.setItem('token', r.token); S.me = r.user; S.err = ''; await loadWs(); render(); };
  document.getElementById('li').onclick = guard(login);
  document.getElementById('rg').onclick = guard(async () => { await api('POST', '/api/auth/register', { username: val('u'), password: val('p'), displayName: val('d') || undefined }); await login(); });
}

const card = (i) => `<div class="card" draggable="true" data-key="${esc(i.key)}"><a href="#" data-open="${esc(i.key)}">${esc(i.key)}</a> ${esc(i.title)}<br><small>${esc(i.type)} · ${esc(i.priority)}${i.storyPoints != null ? ' · ' + i.storyPoints + 'pt' : ''}</small></div>`;
function wireOpen(root) { root.querySelectorAll('[data-open]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); S.issueKey = a.dataset.open; render(); })); }
const newIssueForm = () => `<div class="row"><select id="nt">${['task', 'bug', 'feature', 'epic'].map((t) => `<option>${t}</option>`).join('')}</select><input id="ni" placeholder="New issue title"><input id="np" size="3" placeholder="pts"><button id="nb">Create</button></div>`;
function wireNew(root) {
  const b = root.querySelector('#nb'); if (!b) return;
  b.onclick = guard(async () => { const sp = root.querySelector('#np').value; await api('POST', `/api/projects/${S.projId}/issues`, { type: root.querySelector('#nt').value, title: root.querySelector('#ni').value, ...(sp ? { storyPoints: Number(sp) } : {}) }); render(); });
}

async function viewBoard() {
  const p = await api('GET', `/api/projects/${S.projId}`); const issues = await api('GET', `/api/projects/${S.projId}/issues`);
  const v = document.getElementById('view');
  v.innerHTML = newIssueForm() + `<div class="board">${p.workflow.statuses.map((s) => `<div class="col" data-status="${esc(s.name)}"><b>${esc(s.name)}</b>${issues.filter((i) => i.status === s.name).map(card).join('')}</div>`).join('')}</div>`;
  wireOpen(v); wireNew(v);
  v.querySelectorAll('.card').forEach((c) => (c.ondragstart = (e) => e.dataTransfer.setData('text/plain', c.dataset.key)));
  v.querySelectorAll('.col').forEach((c) => {
    c.ondragover = (e) => e.preventDefault();
    c.ondrop = guard(async (e) => { e.preventDefault(); await api('PATCH', `/api/issues/${e.dataTransfer.getData('text/plain')}`, { status: c.dataset.status }); render(); });
  });
}

async function viewBacklog() {
  const [issues, sprints] = await Promise.all([api('GET', `/api/projects/${S.projId}/issues`), api('GET', `/api/projects/${S.projId}/sprints`)]);
  const open = sprints.filter((s) => s.state !== 'completed'); const v = document.getElementById('view');
  const group = (title, list, sid) => `<div class="panel"><h3>${esc(title)}</h3>${list.map((i) => `<div class="row">${card(i)}<select data-move="${esc(i.key)}"><option value="">Backlog</option>${open.map((s) => `<option value="${s.id}" ${s.id === i.sprintId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>`).join('') || '<i>empty</i>'}</div>`;
  v.innerHTML = newIssueForm() + open.map((s) => group(`${s.name} (${s.state})`, issues.filter((i) => i.sprintId === s.id))).join('') + group('Backlog', issues.filter((i) => !i.sprintId));
  wireOpen(v); wireNew(v);
  v.querySelectorAll('[data-move]').forEach((sel) => (sel.onchange = guard(async () => { await api('PATCH', `/api/issues/${sel.dataset.move}`, { sprintId: sel.value || null }); render(); })));
}

async function viewSprints() {
  const sprints = await api('GET', `/api/projects/${S.projId}/sprints`); const v = document.getElementById('view');
  v.innerHTML = `<div class="row"><input id="sn" placeholder="Sprint name"><input id="sd" type="date"><input id="se" type="date"><button id="sc">Create sprint</button></div>` +
    sprints.map((s) => `<div class="panel"><b>${esc(s.name)}</b> [${s.state}] ${esc(s.startDate || '')} → ${esc(s.endDate || '')}
      ${s.state === 'planned' ? `<button data-start="${s.id}">Start</button>` : ''}${s.state === 'active' ? `<button data-complete="${s.id}">Complete</button>` : ''}
      <button data-report="${s.id}">Report</button><div id="rep-${s.id}"></div></div>`).join('');
  v.querySelector('#sc').onclick = guard(async () => { await api('POST', `/api/projects/${S.projId}/sprints`, { name: v.querySelector('#sn').value, startDate: v.querySelector('#sd').value || undefined, endDate: v.querySelector('#se').value || undefined }); render(); });
  v.querySelectorAll('[data-start]').forEach((b) => (b.onclick = guard(async () => { await api('POST', `/api/sprints/${b.dataset.start}/start`); render(); })));
  v.querySelectorAll('[data-complete]').forEach((b) => (b.onclick = guard(async () => { await api('POST', `/api/sprints/${b.dataset.complete}/complete`, { carryOverTo: 'backlog' }); render(); })));
  v.querySelectorAll('[data-report]').forEach((b) => (b.onclick = guard(async () => {
    const r = await api('GET', `/api/sprints/${b.dataset.report}/report`);
    document.getElementById('rep-' + b.dataset.report).innerHTML = `<p>Committed ${r.committedPoints} · Completed ${r.completedPoints} (${r.completedIssues} issues) · Carried over ${r.carriedOver}</p>` + burndownSvg(r.burndown);
  })));
}
function burndownSvg(data) {
  if (!data.length) return '<i>No burndown yet</i>';
  const W = 400, H = 160, m = 24, max = Math.max(1, ...data.map((d) => d.remainingPoints));
  const x = (i) => m + (data.length === 1 ? 0 : (i * (W - 2 * m)) / (data.length - 1)), y = (v) => H - m - (v / max) * (H - 2 * m);
  const pts = data.map((d, i) => `${x(i)},${y(d.remainingPoints)}`).join(' ');
  return `<svg width="${W}" height="${H}" role="img" aria-label="burndown"><line x1="${m}" y1="${H - m}" x2="${W - m}" y2="${H - m}" stroke="#888"/><line x1="${m}" y1="${m}" x2="${m}" y2="${H - m}" stroke="#888"/>
    <polyline fill="none" stroke="#0747a6" stroke-width="2" points="${pts}"/>${data.map((d, i) => `<circle cx="${x(i)}" cy="${y(d.remainingPoints)}" r="3"><title>${esc(d.date)}: ${d.remainingPoints}</title></circle>`).join('')}
    <text x="2" y="${m}" font-size="10">${max}</text><text x="2" y="${H - m}" font-size="10">0</text></svg>`;
}

async function viewSearch() {
  const issues = await api('GET', `/api/search?q=${encodeURIComponent(S.query || '')}&project=${encodeURIComponent(S.projId || '')}`);
  const v = document.getElementById('view');
  v.innerHTML = `<div class="panel"><h3>Results (${issues.length})</h3>` + (issues.map(card).join('') || '<i>none</i>') + '</div>'; wireOpen(v);
}

async function viewNotifs() {
  const ns = await api('GET', '/api/notifications'); const v = document.getElementById('view');
  v.innerHTML = `<div class="panel"><button id="ra">Mark all read</button>` + ns.map((n) => `<div class="${n.read ? '' : 'unread'}">${esc(n.type)} on <a href="#" data-open="${esc(n.issueKey)}">${esc(n.issueKey)}</a> <small>${esc(n.at)}</small></div>`).join('') + '</div>';
  wireOpen(v); v.querySelector('#ra').onclick = guard(async () => { await api('POST', '/api/notifications/read', { all: true }); render(); });
}

async function viewIssue() {
  const v = document.getElementById('view');
  const [i, hist, comments] = await Promise.all([api('GET', `/api/issues/${S.issueKey}`), api('GET', `/api/issues/${S.issueKey}/history`), api('GET', `/api/issues/${S.issueKey}/comments`)]);
  const p = proj() || await api('GET', `/api/projects/${i.projectId}`);
  v.innerHTML = `<div class="panel"><button id="back">← Back</button><h2>${esc(i.key)} ${esc(i.title)}</h2>
    <div class="row"><label>Status <select id="st">${(p.workflow?.statuses || []).map((s) => `<option ${s.name === i.status ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
    <label>Priority <select id="pr">${['urgent', 'high', 'medium', 'low', 'none'].map((x) => `<option ${x === i.priority ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
    <button id="watch">Watch</button><button id="del">Delete</button></div>
    <p>${esc(i.description)}</p><small>${esc(i.type)} · points ${i.storyPoints ?? '-'} · labels ${esc(i.labels.join(', '))}</small>
    ${i.progress ? `<p>Epic progress: ${i.progress.done}/${i.progress.total} issues, ${i.progress.points_done}/${i.progress.points_total} pts</p>` : ''}
    <h3>Subtasks</h3>${i.children.map((k) => `<div><a href="#" data-open="${esc(k)}">${esc(k)}</a></div>`).join('') || '<i>none</i>'}
    ${i.type !== 'subtask' && i.type !== 'epic' ? `<div class="row"><input id="sub" placeholder="New subtask"><button id="subb">Add</button></div>` : ''}
    <h3>Links</h3>${i.links.map((l) => `<div>${esc(l.type)} <a href="#" data-open="${esc(l.key)}">${esc(l.key)}</a></div>`).join('') || '<i>none</i>'}
    <div class="row"><select id="lt"><option>blocks</option><option>relates</option><option>duplicates</option></select><input id="lk" placeholder="KEY-1"><button id="lb">Link</button></div>
    <h3>Comments</h3>${comments.map((c) => `<div class="card"><small>${esc(c.createdAt)}${c.edited ? ' (edited)' : ''}</small><br>${esc(c.body)}</div>`).join('')}
    <div class="row"><input id="cb" size="50" placeholder="Comment (use @username)"><button id="cbb">Post</button></div>
    <h3>History</h3><table>${hist.map((h) => `<tr><td>${esc(h.at)}</td><td>${esc(h.field)}</td><td>${esc(JSON.stringify(h.from))} → ${esc(JSON.stringify(h.to))}</td></tr>`).join('')}</table></div>`;
  wireOpen(v);
  const $ = (id) => v.querySelector('#' + id); const done = guard(async (fn) => { await fn(); render(); });
  $('back').onclick = () => { S.issueKey = null; render(); };
  $('st').onchange = () => done(() => api('PATCH', `/api/issues/${i.key}`, { status: $('st').value }));
  $('pr').onchange = () => done(() => api('PATCH', `/api/issues/${i.key}`, { priority: $('pr').value }));
  $('watch').onclick = () => done(() => api('POST', `/api/issues/${i.key}/watch`));
  $('del').onclick = () => confirm('Delete?') && done(async () => { await api('DELETE', `/api/issues/${i.key}`); S.issueKey = null; });
  $('lb').onclick = () => done(() => api('POST', `/api/issues/${i.key}/links`, { type: $('lt').value, target: $('lk').value }));
  $('cbb').onclick = () => done(() => api('POST', `/api/issues/${i.key}/comments`, { body: $('cb').value }));
  if ($('subb')) $('subb').onclick = () => done(() => api('POST', `/api/projects/${i.projectId}/issues`, { type: 'subtask', title: $('sub').value, parentId: i.id }));
}

async function viewSettings() {
  const p = await api('GET', `/api/projects/${S.projId}`); const v = document.getElementById('view');
  const hooks = p.role === 'lead' ? await api('GET', `/api/projects/${S.projId}/webhooks`) : [];
  v.innerHTML = `<div class="panel"><h3>Workflow</h3><p><small>One status per line: <code>name | category</code>. Transitions: one per line <code>from -> to</code>. Removed in-use statuses: <code>old => new</code> lines.</small></p>
    <textarea id="wfs" rows="6" cols="40">${p.workflow.statuses.map((s) => `${s.name} | ${s.category}`).join('\n')}</textarea>
    <textarea id="wft" rows="6" cols="40">${p.workflow.transitions.map((t) => `${t[0]} -> ${t[1]}`).join('\n')}</textarea>
    <textarea id="wfr" rows="6" cols="30" placeholder="old => new"></textarea><br><button id="wfb">Save workflow</button></div>
    <div class="panel"><h3>Members</h3>${p.members.map((m) => `<div>${esc(m.user.username)} — ${m.role}</div>`).join('')}
    <div class="row"><input id="mu" placeholder="username"><select id="mr"><option>developer</option><option>viewer</option><option>lead</option></select><button id="mb">Add</button></div></div>
    <div class="panel"><h3>Webhooks</h3>${hooks.map((h) => `<div>${esc(h.url)} [${h.events.join(', ')}] <button data-dh="${h.id}">Delete</button> <button data-dl="${h.id}">Deliveries</button></div>`).join('')}<pre id="dl"></pre>
    <div class="row"><input id="wu" placeholder="https://..."><input id="we" value="issue.created,issue.updated" size="30"><input id="ws" placeholder="secret"><button id="wb">Add</button></div></div>
    <div class="panel"><h3>CSV</h3><a href="#" id="exp">Export CSV</a> <input type="file" id="imp" accept=".csv"></div>`;
  const $ = (id) => v.querySelector('#' + id);
  $('wfb').onclick = guard(async () => {
    const lines = (id) => $(id).value.split('\n').map((l) => l.trim()).filter(Boolean);
    const statuses = lines('wfs').map((l) => { const [name, category] = l.split('|').map((x) => x.trim()); return { name, category }; });
    const transitions = lines('wft').map((l) => l.split('->').map((x) => x.trim()));
    const remap = Object.fromEntries(lines('wfr').map((l) => l.split('=>').map((x) => x.trim())));
    await api('PUT', `/api/projects/${S.projId}/workflow`, { statuses, transitions, remap }); render();
  });
  $('mb').onclick = guard(async () => { await api('POST', `/api/projects/${S.projId}/members`, { username: $('mu').value, role: $('mr').value }); render(); });
  $('wb').onclick = guard(async () => { await api('POST', `/api/projects/${S.projId}/webhooks`, { url: $('wu').value, events: $('we').value.split(',').map((x) => x.trim()), secret: $('ws').value }); render(); });
  v.querySelectorAll('[data-dh]').forEach((b) => (b.onclick = guard(async () => { await api('DELETE', `/api/webhooks/${b.dataset.dh}`); render(); })));
  v.querySelectorAll('[data-dl]').forEach((b) => (b.onclick = guard(async () => { $('dl').textContent = JSON.stringify(await api('GET', `/api/webhooks/${b.dataset.dl}/deliveries`), null, 1); })));
  $('exp').onclick = guard(async (e) => { e.preventDefault(); const t = await api('GET', `/api/projects/${S.projId}/export.csv`); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([t], { type: 'text/csv' })); a.download = p.key + '.csv'; a.click(); });
  $('imp').onchange = guard(async (e) => { const r = await api('POST', `/api/projects/${S.projId}/import.csv`, null, await e.target.files[0].text()); alert(`Imported ${r.created}; errors: ${JSON.stringify(r.errors)}`); render(); });
}

boot();
