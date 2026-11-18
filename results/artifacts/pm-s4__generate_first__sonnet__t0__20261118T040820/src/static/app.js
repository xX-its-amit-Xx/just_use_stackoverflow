const $app = document.getElementById('app');
const S = { token: localStorage.getItem('token'), user: null, ws: [], wsId: null, projects: [], projId: null, view: 'board', issue: null, notifOpen: false };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json', ...(S.token ? { authorization: 'Bearer ' + S.token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
  if (!r.ok) throw Object.assign(new Error(j?.message || r.statusText), { status: r.status });
  return j;
}
const proj = () => S.projects.find((p) => p.id === S.projId);
const h = (html) => { $app.innerHTML = html; };
const on = (sel, ev, fn) => document.querySelectorAll(sel).forEach((e) => e.addEventListener(ev, fn));
const val = (id) => document.getElementById(id).value;
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { alert(e.message); } };

async function boot() {
  if (!S.token) return loginView();
  try { S.user = (await api('GET', '/api/auth/me')).user; } catch { S.token = null; localStorage.removeItem('token'); return loginView(); }
  S.ws = await api('GET', '/api/workspaces');
  if (!S.wsId || !S.ws.some((w) => w.id === S.wsId)) S.wsId = S.ws[0]?.id || null;
  S.projects = S.wsId ? await api('GET', `/api/workspaces/${S.wsId}/projects`) : [];
  if (!S.projects.some((p) => p.id === S.projId)) S.projId = S.projects[0]?.id || null;
  render();
}
function loginView(msg = '') {
  h(`<main><div class="panel"><h2>pm-s4</h2><div class="err">${esc(msg)}</div>
  <input id="u" placeholder="username"><input id="p" type="password" placeholder="password"><input id="d" placeholder="display name (register)">
  <button id="login">Login</button><button id="reg">Register</button></div></main>`);
  document.getElementById('login').onclick = async () => {
    try { const r = await api('POST', '/api/auth/login', { username: val('u'), password: val('p') }); S.token = r.token; localStorage.setItem('token', r.token); boot(); } catch (e) { loginView(e.message); }
  };
  document.getElementById('reg').onclick = async () => {
    try { await api('POST', '/api/auth/register', { username: val('u'), password: val('p'), displayName: val('d') || undefined }); document.getElementById('login').click(); } catch (e) { loginView(e.message); }
  };
}
function header() {
  return `<header><b>pm-s4</b>
  <select id="wsSel">${S.ws.map((w) => `<option value="${w.id}" ${w.id === S.wsId ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select>
  <button id="newWs">+ Workspace</button>
  <select id="prSel">${S.projects.map((p) => `<option value="${p.id}" ${p.id === S.projId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
  <button id="newPr">+ Project</button>
  <nav>${['board', 'backlog', 'report', 'settings'].map((v) => `<button data-v="${v}">${v}</button>`).join('')}</nav>
  <input id="q" placeholder='search: status:"In Progress" type:bug' size="34"><button id="doSearch">Search</button>
  <button id="bell">Notifications</button><span>${esc(S.user.displayName)}</span><button id="logout">Logout</button></header>
  <div id="notif"></div>`;
}
function bindHeader() {
  document.getElementById('wsSel').onchange = (e) => { S.wsId = e.target.value; S.projId = null; boot(); };
  document.getElementById('prSel').onchange = (e) => { S.projId = e.target.value; render(); };
  document.getElementById('newWs').onclick = guard(async () => { const name = prompt('Workspace name'); const key = name && prompt('Key (2-10 capital letters)'); if (!key) return; const w = await api('POST', '/api/workspaces', { name, key }); S.wsId = w.id; S.projId = null; boot(); });
  document.getElementById('newPr').onclick = guard(async () => { const name = prompt('Project name'); const key = name && prompt('Key'); if (!key) return; const p = await api('POST', `/api/workspaces/${S.wsId}/projects`, { name, key }); S.projId = p.id; boot(); });
  on('nav button', 'click', (e) => { S.view = e.target.dataset.v; S.issue = null; render(); });
  document.getElementById('logout').onclick = async () => { try { await api('POST', '/api/auth/logout'); } catch {} S.token = null; localStorage.removeItem('token'); loginView(); };
  document.getElementById('doSearch').onclick = guard(async () => { S.view = 'search'; S.issue = null; S.results = await api('GET', `/api/search?q=${encodeURIComponent(val('q'))}${S.projId ? '&project=' + S.projId : ''}`); render(); });
  document.getElementById('bell').onclick = guard(async () => {
    const box = document.getElementById('notif'); if (box.innerHTML) { box.innerHTML = ''; return; }
    const ns = await api('GET', '/api/notifications');
    box.innerHTML = `<div class="notif"><button id="readAll">Mark all read</button>${ns.map((n) => `<div class="${n.read ? 'muted' : ''}">${esc(n.type)} <a data-k="${esc(n.issueKey)}" class="nk">${esc(n.issueKey)}</a> <small>${esc(n.at)}</small></div>`).join('') || 'none'}</div>`;
    document.getElementById('readAll').onclick = guard(async () => { await api('POST', '/api/notifications/read', { all: true }); box.innerHTML = ''; });
    on('.nk', 'click', (e) => { box.innerHTML = ''; openIssue(e.target.dataset.k); });
  });
}
async function render() {
  if (!S.user) return;
  let body = '<main>Create a workspace and project to begin.</main>';
  if (S.projId) {
    try {
      if (S.issue) body = await issueView(); else if (S.view === 'board') body = await boardView(); else if (S.view === 'backlog') body = await backlogView();
      else if (S.view === 'report') body = await reportView(); else if (S.view === 'settings') body = await settingsView(); else if (S.view === 'search') body = searchView();
    } catch (e) { body = `<main class="err">${esc(e.message)}</main>`; }
  }
  h(header() + body); bindHeader(); bindView();
}
const card = (i) => `<div class="card" draggable="true" data-key="${i.key}"><a class="open" data-key="${i.key}">${i.key}</a> ${esc(i.title)}<br><small class="muted">${i.type} · ${i.priority}${i.storyPoints != null ? ' · ' + i.storyPoints + 'pt' : ''}</small></div>`;
async function boardView() {
  const p = proj(); const issues = await api('GET', `/api/projects/${p.id}/issues`);
  return `<main><button id="newIssue">+ Issue</button><div class="board">${p.workflow.statuses.map((s) => `<div class="col" data-status="${esc(s.name)}"><b>${esc(s.name)}</b> <small>(${issues.filter((i) => i.status === s.name).length})</small>${issues.filter((i) => i.status === s.name && i.type !== 'subtask').map(card).join('')}</div>`).join('')}</div></main>`;
}
async function backlogView() {
  const p = proj(); const [issues, sprints] = await Promise.all([api('GET', `/api/projects/${p.id}/issues`), api('GET', `/api/projects/${p.id}/sprints`)]);
  const sel = (i) => `<select class="mv" data-key="${i.key}"><option value="">Backlog</option>${sprints.filter((s) => s.state !== 'completed').map((s) => `<option value="${s.id}" ${i.sprintId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`;
  const row = (i) => `<div class="card"><a class="open" data-key="${i.key}">${i.key}</a> ${esc(i.title)} ${sel(i)}</div>`;
  return `<main><button id="newIssue">+ Issue</button><div class="panel"><input id="spName" placeholder="Sprint name"><input id="spStart" type="date"><input id="spEnd" type="date"><button id="newSprint">Create sprint</button></div>
  ${sprints.map((s) => `<div class="panel"><b>${esc(s.name)}</b> [${s.state}] ${s.state === 'planned' ? `<button class="spStart" data-id="${s.id}">Start</button>` : ''}${s.state === 'active' ? `<button class="spDone" data-id="${s.id}">Complete</button>` : ''}
  ${issues.filter((i) => i.sprintId === s.id).map(row).join('')}</div>`).join('')}
  <div class="panel"><b>Backlog</b>${issues.filter((i) => !i.sprintId).map(row).join('')}</div></main>`;
}
async function reportView() {
  const p = proj(); const sprints = await api('GET', `/api/projects/${p.id}/sprints`); const stats = await api('GET', `/api/projects/${p.id}/stats`);
  let out = `<main><div class="panel"><b>Stats</b> total ${stats.total}; avg cycle time ${stats.avgCycleTimeHours == null ? 'n/a' : stats.avgCycleTimeHours.toFixed(1) + 'h'}<br>${Object.entries(stats.byStatus).map(([k, v]) => `${esc(k)}: ${v}`).join(' | ')}</div>`;
  for (const s of sprints) {
    const r = await api('GET', `/api/sprints/${s.id}/report`);
    out += `<div class="panel"><b>${esc(s.name)}</b> [${s.state}] committed ${r.committedPoints}, completed ${r.completedPoints} (${r.completedIssues} issues), carried over ${r.carriedOver}${burndown(r.burndown)}</div>`;
  }
  return out + '</main>';
}
function burndown(d) {
  if (!d.length) return '<div class="muted">No burndown data</div>';
  const W = 400, H = 150, max = Math.max(1, ...d.map((x) => x.remainingPoints)); const x = (i) => 30 + (d.length === 1 ? 0 : i * (W - 40) / (d.length - 1)); const y = (v) => H - 20 - v * (H - 40) / max;
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><line x1="30" y1="${H - 20}" x2="${W - 10}" y2="${H - 20}" stroke="#999"/><line x1="30" y1="10" x2="30" y2="${H - 20}" stroke="#999"/>
  <polyline fill="none" stroke="#0052cc" stroke-width="2" points="${d.map((p, i) => `${x(i)},${y(p.remainingPoints)}`).join(' ')}"/>
  ${d.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.remainingPoints)}" r="3" fill="#0052cc"><title>${p.date}: ${p.remainingPoints}</title></circle>`).join('')}
  <text x="2" y="14" font-size="10">${max}</text><text x="10" y="${H - 20}" font-size="10">0</text></svg>`;
}
function searchView() { return `<main><div class="panel"><b>${S.results?.total ?? 0} results</b>${(S.results?.issues || []).map((i) => `<div class="card"><a class="open" data-key="${i.key}">${i.key}</a> ${esc(i.title)} <small>${esc(i.status)}</small></div>`).join('')}</div></main>`; }
async function settingsView() {
  const p = proj(); const full = await api('GET', `/api/projects/${p.id}`); const hooks = await api('GET', `/api/projects/${p.id}/webhooks`).catch(() => []);
  const wf = full.workflow;
  return `<main><div class="panel"><b>Workflow</b><br><textarea id="wfJson" rows="10" cols="60">${esc(JSON.stringify(wf, null, 2))}</textarea><br>
  <input id="wfRemap" placeholder='remap JSON e.g. {"Old":"New"}' size="40"><button id="saveWf">Save workflow</button></div>
  <div class="panel"><b>Members</b>${full.members.map((m) => `<div>${esc(m.username)} (${m.role}) <button class="rmM" data-id="${m.userId}">remove</button></div>`).join('')}
  <input id="mUser" placeholder="username"><select id="mRole"><option>developer</option><option>lead</option><option>viewer</option></select><button id="addM">Add</button></div>
  <div class="panel"><b>Webhooks</b>${hooks.map((w) => `<div>${esc(w.url)} [${w.events.join(',')}] <button class="rmH" data-id="${w.id}">delete</button></div>`).join('')}
  <input id="hUrl" placeholder="https://..."><input id="hSecret" placeholder="secret"><input id="hEv" value="issue.created,issue.updated"><button id="addH">Add</button></div>
  <div class="panel"><a href="#" id="exp">Export CSV</a> <input type="file" id="imp"></div></main>`;
}
async function issueView() {
  const i = await api('GET', `/api/issues/${S.issue}`); const [cm, hist] = await Promise.all([api('GET', `/api/issues/${i.key}/comments`), api('GET', `/api/issues/${i.key}/history`)]);
  const p = proj();
  return `<main><button id="back">← Back</button><div class="panel"><h2>${i.key} ${esc(i.title)}</h2>
  <div>Type ${i.type} · Priority ${i.priority} · Points ${i.storyPoints ?? '-'} · Due ${i.dueDate ?? '-'}</div>
  <div>Status <select id="stSel">${p.workflow.statuses.map((s) => `<option ${s.name === i.status ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
  <button id="watch">${i.watchers.includes(S.user.id) ? 'Unwatch' : 'Watch'}</button> <button id="delIssue">Delete</button></div>
  <p>${esc(i.description)}</p>
  ${i.progress ? `<div>Epic progress: ${i.progress.done}/${i.progress.total} issues, ${i.progress.points_done}/${i.progress.points_total} pts</div>` : ''}
  <h4>Subtasks</h4>${i.children.map((k) => `<div><a class="open" data-key="${k}">${k}</a></div>`).join('') || '<span class="muted">none</span>'}
  <div><input id="subT" placeholder="new subtask title"><button id="addSub">Add subtask</button></div>
  <h4>Links</h4>${i.links.map((l) => `<div>${l.type} <a class="open" data-key="${l.key}">${l.key}</a></div>`).join('') || '<span class="muted">none</span>'}
  <div><select id="lkType"><option>blocks</option><option>relates</option><option>duplicates</option></select><input id="lkTarget" placeholder="KEY-1"><button id="addLink">Link</button></div>
  <h4>Comments</h4>${cm.map((c) => `<div class="card">${esc(c.body)} ${c.edited ? '<i>(edited)</i>' : ''}<br><small class="muted">${esc(c.createdAt)}</small></div>`).join('')}
  <textarea id="cmBody" placeholder="Comment (use @username to mention)"></textarea><button id="addCm">Comment</button>
  <h4>History</h4>${hist.map((x) => `<div class="muted">${esc(x.at)} ${esc(x.field)}: ${esc(JSON.stringify(x.from))} → ${esc(JSON.stringify(x.to))}</div>`).join('')}</div></main>`;
}
const openIssue = (k) => { S.issue = k; render(); };
function bindView() {
  on('.open', 'click', (e) => openIssue(e.target.dataset.key));
  const ni = document.getElementById('newIssue');
  if (ni) ni.onclick = guard(async () => { const title = prompt('Title'); if (!title) return; const type = prompt('Type (bug|feature|task|epic)', 'task'); await api('POST', `/api/projects/${S.projId}/issues`, { title, type }); render(); });
  on('.card[draggable]', 'dragstart', (e) => e.dataTransfer.setData('text/plain', e.currentTarget.dataset.key));
  on('.col', 'dragover', (e) => { e.preventDefault(); e.currentTarget.classList.add('over'); });
  on('.col', 'dragleave', (e) => e.currentTarget.classList.remove('over'));
  on('.col', 'drop', guard(async (e) => { e.preventDefault(); const key = e.dataTransfer.getData('text/plain'); try { await api('PATCH', `/api/issues/${key}`, { status: e.currentTarget.dataset.status }); } finally { render(); } }));
  on('.mv', 'change', guard(async (e) => { await api('PATCH', `/api/issues/${e.target.dataset.key}`, { sprintId: e.target.value || null }); render(); }));
  const g = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = guard(fn); };
  g('newSprint', async () => { await api('POST', `/api/projects/${S.projId}/sprints`, { name: val('spName'), startDate: val('spStart') || undefined, endDate: val('spEnd') || undefined }); render(); });
  on('.spStart', 'click', guard(async (e) => { await api('POST', `/api/sprints/${e.target.dataset.id}/start`); render(); }));
  on('.spDone', 'click', guard(async (e) => { await api('POST', `/api/sprints/${e.target.dataset.id}/complete`, { carryOverTo: 'backlog' }); render(); }));
  g('saveWf', async () => { const w = JSON.parse(val('wfJson')); const remap = val('wfRemap') ? JSON.parse(val('wfRemap')) : undefined; const r = await api('PUT', `/api/projects/${S.projId}/workflow`, { ...w, remap }); const p = proj(); p.workflow = r.workflow; render(); });
  g('addM', async () => { await api('POST', `/api/projects/${S.projId}/members`, { username: val('mUser'), role: val('mRole') }); render(); });
  on('.rmM', 'click', guard(async (e) => { await api('DELETE', `/api/projects/${S.projId}/members/${e.target.dataset.id}`); render(); }));
  g('addH', async () => { await api('POST', `/api/projects/${S.projId}/webhooks`, { url: val('hUrl'), secret: val('hSecret'), events: val('hEv').split(',').map((x) => x.trim()) }); render(); });
  on('.rmH', 'click', guard(async (e) => { await api('DELETE', `/api/webhooks/${e.target.dataset.id}`); render(); }));
  const exp = document.getElementById('exp');
  if (exp) exp.onclick = guard(async (e) => { e.preventDefault(); const r = await fetch(`/api/projects/${S.projId}/export.csv`, { headers: { authorization: 'Bearer ' + S.token } }); const a = document.createElement('a'); a.href = URL.createObjectURL(await r.blob()); a.download = 'export.csv'; a.click(); });
  const imp = document.getElementById('imp');
  if (imp) imp.onchange = guard(async () => { const text = await imp.files[0].text(); const r = await fetch(`/api/projects/${S.projId}/import.csv`, { method: 'POST', headers: { authorization: 'Bearer ' + S.token, 'content-type': 'text/csv' }, body: text }); const j = await r.json(); alert(`Created ${j.created}, errors ${j.errors?.length}`); });
  g('back', async () => { S.issue = null; render(); });
  const st = document.getElementById('stSel');
  if (st) st.onchange = guard(async () => { try { await api('PATCH', `/api/issues/${S.issue}`, { status: st.value }); } finally { render(); } });
  g('watch', async () => { const i = await api('GET', `/api/issues/${S.issue}`); await api(i.watchers.includes(S.user.id) ? 'DELETE' : 'POST', `/api/issues/${S.issue}/watch`); render(); });
  g('delIssue', async () => { if (confirm('Delete?')) { await api('DELETE', `/api/issues/${S.issue}`); S.issue = null; render(); } });
  g('addSub', async () => { await api('POST', `/api/projects/${S.projId}/issues`, { title: val('subT'), type: 'subtask', parentId: S.issue }); render(); });
  g('addLink', async () => { await api('POST', `/api/issues/${S.issue}/links`, { type: val('lkType'), target: val('lkTarget') }); render(); });
  g('addCm', async () => { await api('POST', `/api/issues/${S.issue}/comments`, { body: val('cmBody') }); render(); });
}
boot();
