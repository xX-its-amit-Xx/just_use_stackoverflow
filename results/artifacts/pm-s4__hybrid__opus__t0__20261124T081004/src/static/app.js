// pm-s4 single-page app. Uses only the public JSON API.
const $app = document.getElementById('app');
const S = { token: localStorage.getItem('pm_token'), user: null, workspaces: [], ws: null, projects: [], project: null, view: 'board', users: {}, notifOpen: false, searchQ: '' };

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function h(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }

async function api(method, path, body, raw) {
  const headers = {};
  if (S.token) headers.authorization = 'Bearer ' + S.token;
  if (body !== undefined) headers['content-type'] = raw ? 'text/csv' : 'application/json';
  const r = await fetch(path, { method, headers, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
  if (r.status === 204) return null;
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) {
    if (r.status === 401 && path !== '/api/auth/login') { logoutLocal(); }
    throw new Error((data && data.message) || ('HTTP ' + r.status));
  }
  return data;
}
function logoutLocal() { S.token = null; S.user = null; localStorage.removeItem('pm_token'); render(); }
const uname = id => (id ? (S.users[id]?.username || id) : '—');

async function loadUsersFor(ws) {
  if (!ws) return;
  const members = await api('GET', `/api/workspaces/${ws.id}/members`);
  for (const m of members) S.users[m.userId] = { id: m.userId, username: m.username, displayName: m.displayName, role: m.role };
  S.wsMembers = members;
}

async function boot() {
  if (!S.token) return render();
  try {
    S.user = (await api('GET', '/api/auth/me')).user;
    S.users[S.user.id] = S.user;
    S.workspaces = await api('GET', '/api/workspaces');
    const wsId = localStorage.getItem('pm_ws');
    S.ws = S.workspaces.find(w => w.id === wsId) || S.workspaces[0] || null;
    await selectWorkspace(S.ws);
  } catch (e) { console.error(e); render(); }
}
async function selectWorkspace(ws) {
  S.ws = ws; S.project = null; S.projects = [];
  if (ws) {
    localStorage.setItem('pm_ws', ws.id);
    S.projects = await api('GET', `/api/workspaces/${ws.id}/projects`);
    await loadUsersFor(ws);
    const pid = localStorage.getItem('pm_project');
    S.project = S.projects.find(p => p.id === pid) || S.projects[0] || null;
  }
  render();
}

// ---------- rendering ----------
function render() {
  $app.innerHTML = '';
  if (!S.user) return renderLogin();
  const head = h(`<header>
    <strong>PM</strong>
    <select id="wsSel">${S.workspaces.map(w => `<option value="${w.id}" ${S.ws?.id === w.id ? 'selected' : ''}>${esc(w.name)} (${esc(w.key)})</option>`).join('')}<option value="__new">+ New workspace</option></select>
    <select id="prSel">${S.projects.map(p => `<option value="${p.id}" ${S.project?.id === p.id ? 'selected' : ''}>${esc(p.name)} (${esc(p.key)})</option>`).join('')}<option value="__new">+ New project</option></select>
    <input id="q" class="grow" placeholder='Search e.g. status:"In Progress" assignee:me -label:wontfix' value="${esc(S.searchQ)}">
    <button id="notifBtn">🔔 <span id="nCount"></span></button>
    <span>${esc(S.user.displayName)}</span>
    <button id="logout">Logout</button>
  </header>`);
  $app.append(head);
  head.querySelector('#wsSel').onchange = async e => {
    if (e.target.value === '__new') {
      const name = prompt('Workspace name'); const key = name && prompt('Workspace key (2-10 uppercase letters)');
      if (key) { try { const ws = await api('POST', '/api/workspaces', { name, key }); S.workspaces = await api('GET', '/api/workspaces'); return selectWorkspace(S.workspaces.find(w => w.id === ws.id)); } catch (err) { alert(err.message); } }
      return render();
    }
    selectWorkspace(S.workspaces.find(w => w.id === e.target.value));
  };
  head.querySelector('#prSel').onchange = async e => {
    if (e.target.value === '__new') {
      if (!S.ws) { alert('Create a workspace first'); return render(); }
      const name = prompt('Project name'); const key = name && prompt('Project key (2-10 uppercase letters)');
      if (key) { try { const p = await api('POST', `/api/workspaces/${S.ws.id}/projects`, { name, key }); S.projects = await api('GET', `/api/workspaces/${S.ws.id}/projects`); S.project = S.projects.find(x => x.id === p.id); } catch (err) { alert(err.message); } }
      return render();
    }
    S.project = S.projects.find(p => p.id === e.target.value); localStorage.setItem('pm_project', S.project.id); render();
  };
  head.querySelector('#q').onkeydown = e => { if (e.key === 'Enter') { S.searchQ = e.target.value; S.view = 'search'; render(); } };
  head.querySelector('#logout').onclick = async () => { try { await api('POST', '/api/auth/logout'); } catch {} logoutLocal(); };
  head.querySelector('#notifBtn').onclick = () => { S.notifOpen = !S.notifOpen; renderNotifs(); };
  refreshNotifCount();

  const views = [['board', 'Board'], ['backlog', 'Backlog & Sprints'], ['reports', 'Reports'], ['settings', 'Settings'], ['search', 'Search'], ['account', 'Account']];
  const nav = h(`<nav>${views.map(([v, l]) => `<button data-v="${v}" class="${S.view === v ? 'active' : ''}">${l}</button>`).join('')}</nav>`);
  nav.onclick = e => { const v = e.target.dataset.v; if (v) { S.view = v; render(); } };
  $app.append(nav);
  const main = h('<main></main>');
  $app.append(main);
  if (S.notifOpen) renderNotifs();
  const fn = { board: viewBoard, backlog: viewBacklog, reports: viewReports, settings: viewSettings, search: viewSearch, account: viewAccount }[S.view];
  if (S.view !== 'account' && S.view !== 'search' && !S.project) { main.innerHTML = '<div class="panel">Select or create a workspace and project using the selectors above.</div>'; return; }
  fn(main).catch(err => { main.append(h(`<div class="panel err">${esc(err.message)}</div>`)); });
}

function renderLogin() {
  const el = h(`<div class="panel login"><h2>PM — sign in</h2>
    <input id="u" placeholder="Username"><input id="p" type="password" placeholder="Password">
    <input id="d" placeholder="Display name (register only)">
    <div class="row"><button id="login">Login</button><button id="reg">Register</button></div><div class="err" id="err"></div></div>`);
  $app.append(el);
  const v = id => el.querySelector(id).value;
  const err = m => { el.querySelector('#err').textContent = m; };
  const login = async () => {
    try { const r = await api('POST', '/api/auth/login', { username: v('#u'), password: v('#p') }); S.token = r.token; localStorage.setItem('pm_token', r.token); boot(); } catch (e) { err(e.message); }
  };
  el.querySelector('#login').onclick = login;
  el.querySelector('#p').onkeydown = e => { if (e.key === 'Enter') login(); };
  el.querySelector('#reg').onclick = async () => {
    try { await api('POST', '/api/auth/register', { username: v('#u'), password: v('#p'), displayName: v('#d') || undefined }); await login(); } catch (e) { err(e.message); }
  };
}

async function refreshNotifCount() {
  try { const n = await api('GET', '/api/notifications?unread=true'); const c = document.getElementById('nCount'); if (c) c.textContent = n.length || ''; } catch {}
}
async function renderNotifs() {
  document.querySelector('.notif')?.remove();
  if (!S.notifOpen) return;
  const list = await api('GET', '/api/notifications');
  const el = h(`<div class="panel notif"><div class="row"><strong>Notifications</strong><button id="readAll">Mark all read</button></div>
    ${list.map(n => `<div class="${n.read ? '' : 'unread'}" data-key="${esc(n.issueKey)}" data-id="${n.id}" style="cursor:pointer;padding:4px 0">${esc(n.type)} · ${esc(n.issueKey)} by ${esc(uname(n.actorId))}<br><small>${esc(n.at)}</small></div>`).join('') || '<em>Nothing yet</em>'}</div>`);
  el.querySelector('#readAll').onclick = async () => { await api('POST', '/api/notifications/read', { all: true }); renderNotifs(); refreshNotifCount(); };
  el.onclick = async e => { const d = e.target.closest('[data-key]'); if (!d) return; await api('POST', '/api/notifications/read', { ids: [d.dataset.id] }); refreshNotifCount(); openIssue(d.dataset.key); };
  document.body.append(el);
}

function card(i) {
  return `<div class="card" draggable="true" data-key="${esc(i.key)}"><div class="k">${esc(i.key)} · ${esc(i.type)}</div>${esc(i.title)}
    <div><span class="pill p-${i.priority}">${esc(i.priority)}</span>${i.storyPoints != null ? `<span class="pill">${i.storyPoints} pts</span>` : ''}${i.assigneeId ? `<span class="pill">@${esc(uname(i.assigneeId))}</span>` : ''}${(i.labels || []).map(l => `<span class="pill">${esc(l)}</span>`).join('')}</div></div>`;
}
function bindCards(root) { root.querySelectorAll('.card').forEach(c => { c.onclick = () => openIssue(c.dataset.key); c.ondragstart = e => e.dataTransfer.setData('text/plain', c.dataset.key); }); }

async function newIssueForm(container, extra = {}) {
  const f = h(`<div class="panel row"><select id="t">${['task', 'bug', 'feature', 'epic', 'subtask'].map(t => `<option>${t}</option>`).join('')}</select>
    <input id="ti" placeholder="New issue title" style="flex:1"><input id="parent" placeholder="Parent key (subtasks)" size="12"><button id="add">Create</button><span class="err" id="e"></span></div>`);
  f.querySelector('#add').onclick = async () => {
    const body = { type: f.querySelector('#t').value, title: f.querySelector('#ti').value, ...extra };
    const par = f.querySelector('#parent').value.trim(); if (par) body.parentId = par;
    try { await api('POST', `/api/projects/${S.project.id}/issues`, body); render(); } catch (e) { f.querySelector('#e').textContent = e.message; }
  };
  container.append(f);
}

async function viewBoard(main) {
  const p = await api('GET', `/api/projects/${S.project.id}`); S.project = { ...S.project, ...p };
  const sprints = await api('GET', `/api/projects/${p.id}/sprints`);
  const active = sprints.find(s => s.state === 'active');
  let issues = await api('GET', `/api/projects/${p.id}/issues`);
  const onlyActive = active && S.boardActiveOnly !== false;
  if (onlyActive) issues = issues.filter(i => i.sprintId === active.id);
  await newIssueForm(main);
  const toggle = h(`<div class="row">${active ? `<label><input type="checkbox" id="ao" ${onlyActive ? 'checked' : ''}> Only active sprint (${esc(active.name)})</label>` : '<em>No active sprint — showing all issues</em>'}<span class="err" id="be"></span></div>`);
  main.append(toggle);
  toggle.querySelector('#ao')?.addEventListener('change', e => { S.boardActiveOnly = e.target.checked; render(); });
  const board = h('<div class="board"></div>');
  for (const st of p.workflow.statuses) {
    const col = h(`<div class="col" data-status="${esc(st.name)}"><h3>${esc(st.name)} <small>(${st.category})</small></h3>${issues.filter(i => i.status === st.name).map(card).join('')}</div>`);
    col.ondragover = e => { e.preventDefault(); col.classList.add('over'); };
    col.ondragleave = () => col.classList.remove('over');
    col.ondrop = async e => {
      e.preventDefault(); col.classList.remove('over');
      const key = e.dataTransfer.getData('text/plain');
      try { await api('PATCH', `/api/issues/${key}`, { status: st.name }); render(); } catch (err) { toggle.querySelector('#be').textContent = `${key}: ${err.message}`; }
    };
    board.append(col);
  }
  main.append(board); bindCards(board);
}

async function viewBacklog(main) {
  const pid = S.project.id;
  const [sprints, issues] = await Promise.all([api('GET', `/api/projects/${pid}/sprints`), api('GET', `/api/projects/${pid}/issues`)]);
  await newIssueForm(main);
  const cs = h(`<div class="panel row"><input id="sn" placeholder="Sprint name"><input id="sd" type="date"><input id="ed" type="date"><button id="cs">Create sprint</button><span class="err" id="e"></span></div>`);
  cs.querySelector('#cs').onclick = async () => {
    try { await api('POST', `/api/projects/${pid}/sprints`, { name: cs.querySelector('#sn').value, startDate: cs.querySelector('#sd').value || undefined, endDate: cs.querySelector('#ed').value || undefined }); render(); } catch (e) { cs.querySelector('#e').textContent = e.message; }
  };
  main.append(cs);
  const open = sprints.filter(s => s.state !== 'completed');
  const section = (title, list, sprint) => {
    const el = h(`<div class="panel col" style="width:auto" data-sprint="${sprint ? sprint.id : ''}"><div class="row"><strong>${esc(title)}</strong>
      ${sprint ? `<span class="pill">${sprint.state}</span> ${esc(sprint.startDate || '')} → ${esc(sprint.endDate || '')}` : ''}
      ${sprint?.state === 'planned' ? '<button data-act="start">Start</button>' : ''}${sprint?.state === 'active' ? '<button data-act="complete">Complete</button>' : ''}
      <span>${list.reduce((s, i) => s + (i.storyPoints || 0), 0)} pts</span><span class="err"></span></div>${list.map(card).join('') || '<em>Drop issues here</em>'}</div>`);
    el.ondragover = e => e.preventDefault();
    el.ondrop = async e => { e.preventDefault(); const key = e.dataTransfer.getData('text/plain'); try { await api('PATCH', `/api/issues/${key}`, { sprintId: sprint ? sprint.id : null }); render(); } catch (err) { el.querySelector('.err').textContent = err.message; } };
    el.querySelector('[data-act]')?.addEventListener('click', async ev => {
      ev.stopPropagation();
      try {
        if (ev.target.dataset.act === 'start') await api('POST', `/api/sprints/${sprint.id}/start`);
        else {
          const others = open.filter(s => s.id !== sprint.id && s.state === 'planned');
          const to = prompt(`Carry unfinished issues to: "backlog" or sprint id\n${others.map(s => `${s.id} = ${s.name}`).join('\n')}`, 'backlog');
          if (to === null) return;
          await api('POST', `/api/sprints/${sprint.id}/complete`, { carryOverTo: to || 'backlog' });
        }
        render();
      } catch (err) { el.querySelector('.err').textContent = err.message; }
    });
    main.append(el); bindCards(el);
  };
  for (const s of open) section(s.name, issues.filter(i => i.sprintId === s.id), s);
  section('Backlog', issues.filter(i => !i.sprintId), null);
}

function burndownSvg(points) {
  const W = 560, H = 220, P = 30;
  if (!points.length) return '<em>No burndown data yet</em>';
  const max = Math.max(1, ...points.map(p => p.remainingPoints));
  const x = n => P + (points.length === 1 ? 0 : n * (W - 2 * P) / (points.length - 1));
  const y = v => H - P - v * (H - 2 * P) / max;
  const path = points.map((p, n) => `${n ? 'L' : 'M'}${x(n).toFixed(1)},${y(p.remainingPoints).toFixed(1)}`).join(' ');
  const ideal = `M${x(0)},${y(points[0].remainingPoints)} L${x(points.length - 1)},${y(0)}`;
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Burndown chart">
    <line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" stroke="#999"/><line x1="${P}" y1="${P}" x2="${P}" y2="${H - P}" stroke="#999"/>
    <text x="4" y="${P}" font-size="10">${max}</text><text x="4" y="${H - P}" font-size="10">0</text>
    <path d="${ideal}" stroke="#bbb" stroke-dasharray="4" fill="none"/><path d="${path}" stroke="#0b3d91" stroke-width="2" fill="none"/>
    ${points.map((p, n) => `<circle cx="${x(n)}" cy="${y(p.remainingPoints)}" r="3" fill="#0b3d91"><title>${p.date}: ${p.remainingPoints}</title></circle><text x="${x(n) - 14}" y="${H - 12}" font-size="9">${p.date.slice(5)}</text>`).join('')}
  </svg>`;
}

async function viewReports(main) {
  const pid = S.project.id;
  const [sprints, stats] = await Promise.all([api('GET', `/api/projects/${pid}/sprints`), api('GET', `/api/projects/${pid}/stats`)]);
  const st = h(`<div class="panel"><h3>Project stats</h3>
    <div class="row">${Object.entries(stats.byStatus).map(([k, v]) => `<span class="pill">${esc(k)}: ${v}</span>`).join('')}</div>
    <div class="row">${Object.entries(stats.byType).map(([k, v]) => `<span class="pill">${esc(k)}: ${v}</span>`).join('')}</div>
    <div class="row">${Object.entries(stats.byAssignee).map(([k, v]) => `<span class="pill">${esc(k)}: ${v}</span>`).join('')}</div>
    <div>Average cycle time: ${stats.averageCycleTimeHours == null ? '—' : stats.averageCycleTimeHours.toFixed(1) + ' h'}</div>
    <div class="row"><a href="/api/projects/${pid}/export.csv" id="exp">Export CSV</a> <input type="file" id="imp" accept=".csv,text/csv"> <span id="impRes"></span></div></div>`);
  st.querySelector('#exp').onclick = async e => {
    e.preventDefault();
    const csv = await api('GET', `/api/projects/${pid}/export.csv`);
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `${S.project.key}.csv`; a.click();
  };
  st.querySelector('#imp').onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    const r = await api('POST', `/api/projects/${pid}/import.csv`, await file.text(), true);
    st.querySelector('#impRes').textContent = `Created ${r.created}; errors: ${r.errors.map(x => `line ${x.line}: ${x.message}`).join('; ') || 'none'}`;
  };
  main.append(st);
  for (const s of sprints.filter(s => s.state !== 'planned')) {
    const r = await api('GET', `/api/sprints/${s.id}/report`);
    main.append(h(`<div class="panel"><h3>${esc(s.name)} <span class="pill">${s.state}</span></h3>
      <div>Committed ${r.committedPoints} pts · Completed ${r.completedPoints} pts · ${r.completedIssues} issues done · ${r.carriedOver} carried over</div>${burndownSvg(r.burndown)}</div>`));
  }
}

async function viewSearch(main) {
  const sort = S.searchSort || 'updated';
  const bar = h(`<div class="panel row"><input id="sq" style="flex:1" value="${esc(S.searchQ)}" placeholder='type:bug is:open "login page"'>
    <select id="ss">${['updated', 'created', 'priority'].map(x => `<option ${x === sort ? 'selected' : ''}>${x}</option>`).join('')}</select><button id="go">Search</button></div>`);
  const run = () => { S.searchQ = bar.querySelector('#sq').value; S.searchSort = bar.querySelector('#ss').value; render(); };
  bar.querySelector('#go').onclick = run; bar.querySelector('#sq').onkeydown = e => { if (e.key === 'Enter') run(); };
  main.append(bar);
  try {
    const res = await api('GET', `/api/search?q=${encodeURIComponent(S.searchQ)}&sort=${sort}`);
    const t = h(`<div class="panel"><table><tr><th>Key</th><th>Title</th><th>Status</th><th>Priority</th><th>Assignee</th><th>Updated</th></tr>
      ${res.map(i => `<tr data-key="${esc(i.key)}" style="cursor:pointer"><td>${esc(i.key)}</td><td>${esc(i.title)}</td><td>${esc(i.status)}</td><td>${esc(i.priority)}</td><td>${esc(uname(i.assigneeId))}</td><td>${esc(i.updatedAt)}</td></tr>`).join('')}</table>
      <small>${res.length} result(s)</small></div>`);
    t.onclick = e => { const r = e.target.closest('[data-key]'); if (r) openIssue(r.dataset.key); };
    main.append(t);
  } catch (e) { main.append(h(`<div class="panel err">${esc(e.message)}</div>`)); }
}

async function viewSettings(main) {
  const p = await api('GET', `/api/projects/${S.project.id}`);
  // workflow editor
  const wf = h(`<div class="panel"><h3>Workflow</h3><p>One status per line as <code>Name|category</code>; transitions as <code>From>To</code> per line (or <code>*>*</code> for any).</p>
    <div class="row"><textarea id="st" rows="7">${esc(p.workflow.statuses.map(s => `${s.name}|${s.category}`).join('\n'))}</textarea>
    <textarea id="tr" rows="7">${esc(p.workflow.transitions.map(t => t.join('>')).join('\n'))}</textarea></div>
    <div>Remap (Old=New per line): <textarea id="rm" rows="2"></textarea></div><button id="save">Save workflow</button> <span class="err" id="e"></span></div>`);
  wf.querySelector('#save').onclick = async () => {
    const statuses = wf.querySelector('#st').value.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const [name, category] = l.split('|'); return { name: name.trim(), category: (category || '').trim() }; });
    const transitions = wf.querySelector('#tr').value.split('\n').map(l => l.trim()).filter(Boolean).map(l => l.split('>').map(x => x.trim()));
    const remap = {}; wf.querySelector('#rm').value.split('\n').filter(l => l.includes('=')).forEach(l => { const [a, b] = l.split('='); remap[a.trim()] = b.trim(); });
    try { await api('PUT', `/api/projects/${p.id}/workflow`, { statuses, transitions, remap }); render(); } catch (e) { wf.querySelector('#e').textContent = e.message; }
  };
  main.append(wf);
  // project members
  const pm = await api('GET', `/api/projects/${p.id}/members`);
  const mem = h(`<div class="panel"><h3>Project members</h3><table>${pm.map(m => `<tr><td>${esc(m.username)}</td><td>${esc(m.role)}${m.implicit ? ' (via workspace)' : ''}</td><td>${m.implicit ? '' : `<button data-rm="${m.userId}">Remove</button>`}</td></tr>`).join('')}</table>
    <div class="row"><input id="mu" placeholder="username"><select id="mr"><option>developer</option><option>viewer</option><option>lead</option></select><button id="ma">Add</button><span class="err" id="e"></span></div></div>`);
  mem.onclick = async e => {
    try {
      if (e.target.id === 'ma') { await api('POST', `/api/projects/${p.id}/members`, { username: mem.querySelector('#mu').value, role: mem.querySelector('#mr').value }); render(); }
      if (e.target.dataset.rm) { await api('DELETE', `/api/projects/${p.id}/members/${e.target.dataset.rm}`); render(); }
    } catch (err) { mem.querySelector('#e').textContent = err.message; }
  };
  main.append(mem);
  // workspace members
  const wm = h(`<div class="panel"><h3>Workspace members (${esc(S.ws.name)})</h3><table>${(S.wsMembers || []).map(m => `<tr><td>${esc(m.username)}</td><td><select data-role="${m.userId}">${['admin', 'member', 'guest'].map(r => `<option ${r === m.role ? 'selected' : ''}>${r}</option>`).join('')}</select></td><td><button data-rm="${m.userId}">Remove</button></td></tr>`).join('')}</table>
    <div class="row"><input id="wu" placeholder="username"><select id="wr"><option>member</option><option>guest</option><option>admin</option></select><button id="wa">Add</button><button id="audit">Audit log</button><span class="err" id="e"></span></div><div id="al"></div></div>`);
  wm.onclick = async e => {
    try {
      if (e.target.id === 'wa') { await api('POST', `/api/workspaces/${S.ws.id}/members`, { username: wm.querySelector('#wu').value, role: wm.querySelector('#wr').value }); await loadUsersFor(S.ws); render(); }
      if (e.target.dataset.rm) { await api('DELETE', `/api/workspaces/${S.ws.id}/members/${e.target.dataset.rm}`); await loadUsersFor(S.ws); render(); }
      if (e.target.id === 'audit') { const a = await api('GET', `/api/workspaces/${S.ws.id}/audit`); wm.querySelector('#al').innerHTML = `<table>${a.map(x => `<tr><td>${esc(x.at)}</td><td>${esc(x.action)}</td><td>${esc(uname(x.actorId))}</td><td><code>${esc(JSON.stringify(x.details))}</code></td></tr>`).join('')}</table>`; }
    } catch (err) { wm.querySelector('#e').textContent = err.message; }
  };
  wm.onchange = async e => { if (e.target.dataset.role) { try { await api('PATCH', `/api/workspaces/${S.ws.id}/members/${e.target.dataset.role}`, { role: e.target.value }); await loadUsersFor(S.ws); } catch (err) { wm.querySelector('#e').textContent = err.message; render(); } } };
  main.append(wm);
  // webhooks
  let hooks = [];
  try { hooks = await api('GET', `/api/projects/${p.id}/webhooks`); } catch {}
  const evs = ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'];
  const wh = h(`<div class="panel"><h3>Webhooks</h3><table>${hooks.map(x => `<tr><td>${esc(x.url)}</td><td>${esc(x.events.join(', '))}</td><td><button data-del="${x.id}">Delete</button><button data-dl="${x.id}">Deliveries</button></td></tr>`).join('')}</table>
    <div class="row"><input id="hu" placeholder="https://example.com/hook" size="30">${evs.map(ev => `<label><input type="checkbox" value="${ev}" checked>${ev}</label>`).join('')}<input id="hs" placeholder="secret"><button id="ha">Add</button><span class="err" id="e"></span></div><div id="dl"></div></div>`);
  wh.onclick = async e => {
    try {
      if (e.target.id === 'ha') { await api('POST', `/api/projects/${p.id}/webhooks`, { url: wh.querySelector('#hu').value, events: [...wh.querySelectorAll('input[type=checkbox]:checked')].map(c => c.value), secret: wh.querySelector('#hs').value }); render(); }
      if (e.target.dataset.del) { await api('DELETE', `/api/webhooks/${e.target.dataset.del}`); render(); }
      if (e.target.dataset.dl) { const d = await api('GET', `/api/webhooks/${e.target.dataset.dl}/deliveries`); wh.querySelector('#dl').innerHTML = `<table>${d.map(x => `<tr><td>${esc(x.event)}</td><td>${x.status ?? '-'}</td><td>${x.attempts} attempt(s)</td><td>${esc(x.lastError || '')}</td></tr>`).join('')}</table>`; }
    } catch (err) { wh.querySelector('#e').textContent = err.message; }
  };
  main.append(wh);
}

async function viewAccount(main) {
  const tokens = await api('GET', '/api/tokens');
  const el = h(`<div class="panel"><h3>Account</h3>
    <div class="row"><input id="dn" value="${esc(S.user.displayName)}"><input id="np" type="password" placeholder="New password"><input id="cp" type="password" placeholder="Current password"><button id="sv">Save</button></div>
    <h3>API tokens</h3><table>${tokens.map(t => `<tr><td>${esc(t.name)}</td><td>${esc(t.createdAt)}</td><td><button data-del="${t.id}">Revoke</button></td></tr>`).join('')}</table>
    <div class="row"><input id="tn" placeholder="Token name"><button id="tc">Create token</button></div><div id="out"></div><span class="err" id="e"></span></div>`);
  el.onclick = async e => {
    try {
      if (e.target.id === 'sv') {
        const body = { displayName: el.querySelector('#dn').value, currentPassword: el.querySelector('#cp').value || undefined };
        if (el.querySelector('#np').value) body.password = el.querySelector('#np').value;
        S.user = (await api('PATCH', '/api/auth/me', body)).user; render();
      }
      if (e.target.id === 'tc') { const t = await api('POST', '/api/tokens', { name: el.querySelector('#tn').value }); el.querySelector('#out').innerHTML = `New token (copy now, shown once): <code>${esc(t.token)}</code>`; }
      if (e.target.dataset.del) { await api('DELETE', `/api/tokens/${e.target.dataset.del}`); render(); }
    } catch (err) { el.querySelector('#e').textContent = err.message; }
  };
  main.append(el);
}

// ---------- issue detail ----------
async function openIssue(key) {
  document.querySelector('.modal')?.remove();
  const i = await api('GET', `/api/issues/${key}`);
  const proj = await api('GET', `/api/projects/${i.projectId}`);
  const [comments, history, sprints, members] = await Promise.all([
    api('GET', `/api/issues/${key}/comments`), api('GET', `/api/issues/${key}/history`), api('GET', `/api/projects/${i.projectId}/sprints`), api('GET', `/api/projects/${i.projectId}/members`)]);
  for (const m of members) S.users[m.userId] = S.users[m.userId] || { id: m.userId, username: m.username };
  const allowed = new Set([i.status, ...proj.workflow.transitions.filter(([a]) => a === i.status).map(([, b]) => b)]);
  const opt = (list, cur) => list.map(([v, l]) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(l)}</option>`).join('');
  const m = h(`<div class="modal"><div class="panel">
    <div class="row"><strong>${esc(i.key)}</strong><span class="pill">${esc(i.type)}</span><span style="flex:1"></span><button id="watch">${i.watchers.includes(S.user.id) ? 'Unwatch' : 'Watch'}</button><button id="del">Delete</button><button id="close">✕</button></div>
    <input id="title" value="${esc(i.title)}" style="width:100%;font-size:18px">
    <textarea id="desc" placeholder="Description">${esc(i.description || '')}</textarea>
    <div class="row">Status <select id="status">${opt(proj.workflow.statuses.filter(s => allowed.has(s.name)).map(s => [s.name, s.name]), i.status)}</select>
      Priority <select id="priority">${opt(['urgent', 'high', 'medium', 'low', 'none'].map(x => [x, x]), i.priority)}</select>
      Assignee <select id="assignee">${opt([['', '— none —'], ...members.map(x => [x.userId, x.username])], i.assigneeId || '')}</select>
      Points <input id="points" type="number" min="0" style="width:60px" value="${i.storyPoints ?? ''}">
      Sprint <select id="sprint">${opt([['', 'Backlog'], ...sprints.filter(s => s.state !== 'completed' || s.id === i.sprintId).map(s => [s.id, s.name])], i.sprintId || '')}</select>
      Due <input id="due" type="date" value="${esc(i.dueDate || '')}"></div>
    <div class="row">Labels <input id="labels" value="${esc(i.labels.join(', '))}"> Epic key <input id="epic" size="10" value="${esc(i.epicId ? '' : '')}" placeholder="${i.epicId ? 'set' : 'none'}"><button id="save">Save</button><span class="err" id="e"></span></div>
    ${i.progress ? `<div>Epic progress: ${i.progress.done}/${i.progress.total} issues, ${i.progress.points_done}/${i.progress.points_total} pts</div>` : ''}
    <h4>Subtasks</h4><div>${i.children.map(k => `<a href="#" data-open="${esc(k)}">${esc(k)}</a>`).join(', ') || '<em>none</em>'}</div>
    <h4>Links</h4><div>${i.links.map(l => `${esc(l.type)} <a href="#" data-open="${esc(l.issueKey)}">${esc(l.issueKey)}</a> <button data-unlink="${l.id}">x</button>`).join('<br>') || '<em>none</em>'}</div>
    <div class="row"><select id="lt"><option>blocks</option><option>relates</option><option>duplicates</option></select><input id="lk" placeholder="Target key"><button id="link">Add link</button></div>
    <h4>Comments</h4><div id="comments">${comments.map(c => `<div class="panel" style="background:#f4f5f7"><b>${esc(uname(c.authorId))}</b> <small>${esc(c.createdAt)}${c.edited ? ' (edited)' : ''}</small>
      ${c.authorId === S.user.id ? `<button data-edit="${c.id}">Edit</button>` : ''}<div>${esc(c.body)}</div></div>`).join('')}</div>
    <textarea id="cbody" placeholder="Comment — use @username to mention"></textarea><button id="comment">Comment</button>
    <h4>History</h4><table>${history.map(x => `<tr><td><small>${esc(x.at)}</small></td><td>${esc(uname(x.actorId))}</td><td>${esc(x.field)}</td><td>${esc(JSON.stringify(x.from))} → ${esc(JSON.stringify(x.to))}</td></tr>`).join('')}</table>
  </div></div>`);
  const q = s => m.querySelector(s);
  const err = e => { q('#e').textContent = e.message; };
  q('#close').onclick = () => { m.remove(); render(); };
  q('#save').onclick = async () => {
    const body = { title: q('#title').value, description: q('#desc').value, priority: q('#priority').value, assigneeId: q('#assignee').value || null,
      storyPoints: q('#points').value === '' ? null : Number(q('#points').value), sprintId: q('#sprint').value || null, dueDate: q('#due').value || null,
      labels: q('#labels').value.split(',').map(s => s.trim()).filter(Boolean) };
    if (q('#status').value !== i.status) body.status = q('#status').value;
    if (q('#epic').value.trim()) body.epicId = q('#epic').value.trim();
    try { await api('PATCH', `/api/issues/${key}`, body); openIssue(key); } catch (e) { err(e); }
  };
  q('#del').onclick = async () => { if (confirm('Delete issue (and subtasks)?')) { try { await api('DELETE', `/api/issues/${key}`); m.remove(); render(); } catch (e) { err(e); } } };
  q('#watch').onclick = async () => { await api(i.watchers.includes(S.user.id) ? 'DELETE' : 'POST', `/api/issues/${key}/watch`); openIssue(key); };
  q('#link').onclick = async () => { try { await api('POST', `/api/issues/${key}/links`, { type: q('#lt').value, target: q('#lk').value.trim() }); openIssue(key); } catch (e) { err(e); } };
  q('#comment').onclick = async () => { try { await api('POST', `/api/issues/${key}/comments`, { body: q('#cbody').value }); openIssue(key); } catch (e) { err(e); } };
  m.addEventListener('click', async e => {
    if (e.target === m) { m.remove(); render(); }
    if (e.target.dataset.open) { e.preventDefault(); openIssue(e.target.dataset.open); }
    if (e.target.dataset.unlink) { await api('DELETE', `/api/issues/${key}/links/${e.target.dataset.unlink}`); openIssue(key); }
    if (e.target.dataset.edit) { const c = comments.find(c => c.id === e.target.dataset.edit); const body = prompt('Edit comment', c.body); if (body) { try { await api('PATCH', `/api/comments/${c.id}`, { body }); openIssue(key); } catch (er) { err(er); } } }
  });
  document.body.append(m);
}

boot();
