// pm-s4 single-page application. Uses only the public JSON API.
const $app = document.getElementById('app');
const state = {
  token: localStorage.getItem('pm_token'), user: null, workspaces: [], ws: null, projects: [], project: null,
  tab: 'board', issues: [], sprints: [], unread: 0,
};

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children.flat()) if (c) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

async function api(method, path, body, opts = {}) {
  const headers = {};
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  let payload;
  if (body !== undefined) {
    if (opts.csv) { headers['content-type'] = 'text/csv'; payload = body; }
    else { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  }
  const res = await fetch(path, { method, headers, body: payload });
  if (res.status === 401 && !path.startsWith('/api/auth/')) { logoutLocal(); throw new Error('Session expired'); }
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.message) || `HTTP ${res.status}`);
  return data;
}
const usersCache = new Map();
const userName = id => (id ? (usersCache.get(id)?.username || id) : '—');

function logoutLocal() { state.token = null; state.user = null; localStorage.removeItem('pm_token'); render(); }
function flash(msg) { alert(msg); }
async function guard(fn) { try { await fn(); } catch (e) { flash(e.message); } }

// ---------- auth ----------
function renderAuth() {
  let mode = 'login';
  const err = h('div', { class: 'error' });
  const u = h('input', { name: 'username', autocomplete: 'username' });
  const p = h('input', { name: 'password', type: 'password', autocomplete: 'current-password' });
  const d = h('input', { name: 'displayName' });
  const dLabel = h('label', { style: 'display:none' }, 'Display name', d);
  const title = h('h2', {}, 'Sign in');
  const toggle = h('a', { href: '#', onclick: e => { e.preventDefault(); mode = mode === 'login' ? 'register' : 'login'; title.textContent = mode === 'login' ? 'Sign in' : 'Register'; dLabel.style.display = mode === 'login' ? 'none' : ''; toggle.textContent = mode === 'login' ? 'Create an account' : 'Have an account? Sign in'; } }, 'Create an account');
  const form = h('form', { class: 'card auth', onsubmit: async e => {
    e.preventDefault(); err.textContent = '';
    try {
      if (mode === 'register') await api('POST', '/api/auth/register', { username: u.value, password: p.value, ...(d.value ? { displayName: d.value } : {}) });
      const r = await api('POST', '/api/auth/login', { username: u.value, password: p.value });
      state.token = r.token; state.user = r.user; localStorage.setItem('pm_token', r.token);
      await boot();
    } catch (ex) { err.textContent = ex.message; }
  } }, title, h('label', {}, 'Username', u), h('label', {}, 'Password', p), dLabel, err, h('button', { class: 'primary', type: 'submit' }, 'Continue'), ' ', toggle);
  $app.replaceChildren(form);
}

// ---------- boot ----------
async function boot() {
  if (!state.token) return renderAuth();
  try { state.user = (await api('GET', '/api/auth/me')).user; } catch { return logoutLocal(); }
  usersCache.set(state.user.id, state.user);
  state.workspaces = await api('GET', '/api/workspaces');
  const savedWs = localStorage.getItem('pm_ws');
  state.ws = state.workspaces.find(w => w.id === savedWs) || state.workspaces[0] || null;
  await loadProjects();
  render();
}
async function loadProjects() {
  state.projects = state.ws ? await api('GET', `/api/workspaces/${state.ws.id}/projects`) : [];
  if (state.ws) {
    try { for (const m of await api('GET', `/api/workspaces/${state.ws.id}/members`)) usersCache.set(m.userId, { id: m.userId, username: m.username, displayName: m.displayName }); } catch { /* ignore */ }
  }
  const saved = localStorage.getItem('pm_project');
  state.project = state.projects.find(p => p.id === saved) || state.projects[0] || null;
  await loadProjectData();
}
async function loadProjectData() {
  if (!state.project) { state.issues = []; state.sprints = []; return; }
  state.project = await api('GET', `/api/projects/${state.project.id}`);
  state.issues = await api('GET', `/api/projects/${state.project.id}/issues`);
  state.sprints = await api('GET', `/api/projects/${state.project.id}/sprints`);
}
async function refreshUnread() {
  try { state.unread = (await api('GET', '/api/notifications?unread=true')).length; } catch { state.unread = 0; }
}

// ---------- layout ----------
async function render() {
  if (!state.token || !state.user) return renderAuth();
  await refreshUnread();
  const wsSel = h('select', { onchange: async e => { state.ws = state.workspaces.find(w => w.id === e.target.value); localStorage.setItem('pm_ws', state.ws.id); await loadProjects(); render(); } },
    state.workspaces.map(w => h('option', { value: w.id, selected: state.ws && w.id === state.ws.id }, `${w.name} (${w.key})`)));
  const prSel = h('select', { onchange: async e => { state.project = state.projects.find(p => p.id === e.target.value); localStorage.setItem('pm_project', state.project.id); await loadProjectData(); render(); } },
    state.projects.map(p => h('option', { value: p.id, selected: state.project && p.id === state.project.id }, `${p.name} (${p.key})`)));
  const search = h('input', { placeholder: 'Search: status:"In Progress" assignee:me -label:wontfix', size: 40, onkeydown: e => { if (e.key === 'Enter') { state.tab = 'search'; state.searchQ = e.target.value; render(); } }, value: state.searchQ || '' });
  const header = h('header', {},
    h('strong', {}, 'PM'), 'Workspace:', wsSel, h('button', { onclick: newWorkspace }, '+'),
    'Project:', prSel, state.ws && state.ws.role !== 'guest' ? h('button', { onclick: newProject }, '+') : null,
    h('span', { class: 'grow' }), search,
    h('button', { onclick: () => { state.tab = 'notifications'; render(); } }, `🔔 ${state.unread}`),
    h('span', {}, state.user.displayName),
    h('button', { onclick: async () => { try { await api('POST', '/api/auth/logout'); } catch { /* ignore */ } logoutLocal(); } }, 'Logout'));
  const tabs = ['board', 'backlog', 'reports', 'settings', 'workspace', 'account'];
  const nav = h('nav', { class: 'tabs' }, tabs.map(t => h('button', { class: state.tab === t ? 'active' : '', onclick: () => { state.tab = t; render(); } }, t[0].toUpperCase() + t.slice(1))));
  const main = h('main');
  $app.replaceChildren(header, nav, main);
  try {
    const view = { board: viewBoard, backlog: viewBacklog, reports: viewReports, settings: viewSettings, workspace: viewWorkspace, account: viewAccount, search: viewSearch, notifications: viewNotifications }[state.tab];
    main.append(await view());
  } catch (e) { main.append(h('div', { class: 'error' }, e.message)); }
}

async function newWorkspace() {
  const name = prompt('Workspace name'); if (!name) return;
  const key = prompt('Workspace key (2-10 uppercase letters)'); if (!key) return;
  await guard(async () => { const ws = await api('POST', '/api/workspaces', { name, key }); state.workspaces.push(ws); state.ws = ws; localStorage.setItem('pm_ws', ws.id); await loadProjects(); render(); });
}
async function newProject() {
  if (!state.ws) return flash('Create a workspace first');
  const name = prompt('Project name'); if (!name) return;
  const key = prompt('Project key (uppercase)'); if (!key) return;
  await guard(async () => { const p = await api('POST', `/api/workspaces/${state.ws.id}/projects`, { name, key }); localStorage.setItem('pm_project', p.id); await loadProjects(); render(); });
}

function issueCard(i, draggable = true) {
  return h('div', { class: 'issue', draggable: draggable ? 'true' : null, ondragstart: e => e.dataTransfer.setData('text/plain', i.key), onclick: () => openIssue(i.key) },
    h('div', { class: 'k' }, `${i.key} · ${i.type}`), h('div', {}, i.title),
    h('div', {}, h('span', { class: `pill p-${i.priority}` }, i.priority), i.storyPoints != null ? h('span', { class: 'pill' }, `${i.storyPoints} pts`) : null,
      i.labels.map(l => h('span', { class: 'pill' }, l)), i.assigneeId ? h('span', { class: 'muted' }, ' @' + userName(i.assigneeId)) : null));
}

// ---------- board ----------
async function viewBoard() {
  if (!state.project) return h('div', { class: 'card' }, 'No project selected. Create one with the + button.');
  const active = state.sprints.find(s => s.state === 'active');
  const issues = active ? state.issues.filter(i => i.sprintId === active.id) : state.issues;
  const quick = h('form', { onsubmit: async e => { e.preventDefault(); const t = e.target.title.value.trim(); if (!t) return; await guard(async () => { await api('POST', `/api/projects/${state.project.id}/issues`, { title: t, type: e.target.type.value, ...(active ? { sprintId: active.id } : {}) }); await loadProjectData(); render(); }); } },
    h('input', { name: 'title', placeholder: 'New issue title' }), ' ', h('select', { name: 'type' }, ['task', 'bug', 'feature', 'epic'].map(t => h('option', {}, t))), ' ', h('button', { class: 'primary' }, 'Create'));
  const board = h('div', { class: 'board' }, state.project.workflow.statuses.map(s => {
    const col = h('div', { class: 'column',
      ondragover: e => { e.preventDefault(); col.classList.add('over'); },
      ondragleave: () => col.classList.remove('over'),
      ondrop: async e => { e.preventDefault(); col.classList.remove('over'); const key = e.dataTransfer.getData('text/plain'); await guard(async () => { await api('PATCH', `/api/issues/${key}`, { status: s.name }); }); await loadProjectData(); render(); } },
      h('h3', {}, `${s.name} (${issues.filter(i => i.status === s.name).length})`),
      issues.filter(i => i.status === s.name).map(i => issueCard(i)));
    return col;
  }));
  return h('div', {}, h('div', { class: 'card' }, active ? `Active sprint: ${active.name}` : 'No active sprint — showing all issues', h('div', {}, quick)), board);
}

// ---------- backlog / sprint planning ----------
async function viewBacklog() {
  if (!state.project) return h('div', { class: 'card' }, 'No project selected.');
  const pid = state.project.id;
  const reload = async () => { await loadProjectData(); render(); };
  const sprintOptions = cur => [h('option', { value: '' }, 'Backlog'), ...state.sprints.filter(s => s.state !== 'completed').map(s => h('option', { value: s.id, selected: cur === s.id }, s.name))];
  const row = i => h('tr', {}, h('td', {}, h('a', { href: '#', onclick: e => { e.preventDefault(); openIssue(i.key); } }, i.key)), h('td', {}, i.title), h('td', {}, i.status), h('td', {}, i.storyPoints ?? ''),
    h('td', {}, h('select', { onchange: e => guard(async () => { await api('PATCH', `/api/issues/${i.key}`, { sprintId: e.target.value || null }); await reload(); }) }, sprintOptions(i.sprintId))));
  const section = (title, list, actions) => h('div', { class: 'card' }, h('h3', {}, title, ' ', actions), h('table', {}, h('tr', {}, ['Key', 'Title', 'Status', 'Pts', 'Sprint'].map(x => h('th', {}, x))), list.map(row)));
  const sprintsEls = state.sprints.filter(s => s.state !== 'completed').map(s => section(`${s.name} [${s.state}] ${s.startDate || ''} → ${s.endDate || ''}`, state.issues.filter(i => i.sprintId === s.id),
    s.state === 'planned' ? h('button', { onclick: () => guard(async () => { await api('POST', `/api/sprints/${s.id}/start`, {}); await reload(); }) }, 'Start')
      : h('button', { onclick: () => guard(async () => { const other = state.sprints.find(x => x.state === 'planned'); const to = other && confirm(`Carry unfinished issues to ${other.name}? (Cancel = backlog)`) ? other.id : 'backlog'; await api('POST', `/api/sprints/${s.id}/complete`, { carryOverTo: to }); await reload(); }) }, 'Complete')));
  const newSprint = h('form', { class: 'card', onsubmit: e => { e.preventDefault(); const f = e.target; guard(async () => { await api('POST', `/api/projects/${pid}/sprints`, { name: f.sname.value, ...(f.start.value ? { startDate: f.start.value } : {}), ...(f.end.value ? { endDate: f.end.value } : {}) }); await reload(); }); } },
    h('strong', {}, 'New sprint '), h('input', { name: 'sname', placeholder: 'Name', required: true }), ' start ', h('input', { name: 'start', type: 'date' }), ' end ', h('input', { name: 'end', type: 'date' }), ' ', h('button', { class: 'primary' }, 'Create'));
  const csv = h('div', { class: 'card' }, h('strong', {}, 'CSV: '), h('a', { href: '#', onclick: async e => { e.preventDefault(); await guard(async () => { const text = await api('GET', `/api/projects/${pid}/export.csv`); const blob = new Blob([text], { type: 'text/csv' }); const a = h('a', { href: URL.createObjectURL(blob), download: `${state.project.key}.csv` }); a.click(); }); } }, 'Export'), ' | Import: ',
    h('input', { type: 'file', accept: '.csv,text/csv', onchange: async e => { const f = e.target.files[0]; if (!f) return; await guard(async () => { const r = await api('POST', `/api/projects/${pid}/import.csv`, await f.text(), { csv: true }); flash(`Created ${r.created}; errors: ${r.errors.map(x => `line ${x.line}: ${x.message}`).join('; ') || 'none'}`); await reload(); }); } }));
  return h('div', {}, newSprint, sprintsEls, section('Backlog', state.issues.filter(i => !i.sprintId), null), csv);
}

// ---------- issue detail ----------
async function openIssue(key) {
  const modal = h('div', { class: 'modal', onclick: e => { if (e.target === modal) close(); } });
  const close = async () => { modal.remove(); await loadProjectData(); render(); };
  document.body.append(modal);
  const draw = async () => {
    let issue, comments, history;
    try {
      [issue, comments, history] = await Promise.all([api('GET', `/api/issues/${key}`), api('GET', `/api/issues/${key}/comments`), api('GET', `/api/issues/${key}/history`)]);
    } catch (e) { modal.replaceChildren(h('div', { class: 'card' }, h('div', { class: 'error' }, e.message), h('button', { onclick: close }, 'Close'))); return; }
    const project = state.project && state.project.id === issue.projectId ? state.project : await api('GET', `/api/projects/${issue.projectId}`);
    const patch = body => guard(async () => { await api('PATCH', `/api/issues/${key}`, body); await draw(); });
    const field = (label, el) => h('label', {}, label, el);
    const members = [...usersCache.values()];
    const detail = h('div', { class: 'card' },
      h('div', { class: 'row' }, h('h2', {}, `${issue.key}`), h('div', { style: 'text-align:right' }, h('button', { onclick: () => guard(async () => { await api(issue.watchers.includes(state.user.id) ? 'DELETE' : 'POST', `/api/issues/${key}/watch`); await draw(); }) }, issue.watchers.includes(state.user.id) ? 'Unwatch' : 'Watch'), ' ',
        h('button', { onclick: () => { if (confirm('Delete issue?')) guard(async () => { await api('DELETE', `/api/issues/${key}`); close(); }); } }, 'Delete'), ' ', h('button', { onclick: close }, 'Close'))),
      field('Title', h('input', { value: issue.title, onchange: e => patch({ title: e.target.value }) })),
      field('Description', h('textarea', { rows: 4, onchange: e => patch({ description: e.target.value }) }, issue.description || '')),
      h('div', { class: 'row' },
        field('Status', h('select', { onchange: e => patch({ status: e.target.value }) }, project.workflow.statuses.map(s => h('option', { selected: s.name === issue.status }, s.name)))),
        field('Type', h('select', { onchange: e => patch({ type: e.target.value }) }, ['bug', 'feature', 'task', 'epic', 'subtask'].map(t => h('option', { selected: t === issue.type }, t)))),
        field('Priority', h('select', { onchange: e => patch({ priority: e.target.value }) }, ['urgent', 'high', 'medium', 'low', 'none'].map(t => h('option', { selected: t === issue.priority }, t)))),
        field('Assignee', h('select', { onchange: e => patch({ assigneeId: e.target.value || null }) }, h('option', { value: '' }, '—'), members.map(m => h('option', { value: m.id, selected: m.id === issue.assigneeId }, m.username))))),
      h('div', { class: 'row' },
        field('Story points', h('input', { type: 'number', min: 0, value: issue.storyPoints ?? '', onchange: e => patch({ storyPoints: e.target.value === '' ? null : Number(e.target.value) }) })),
        field('Labels (comma separated)', h('input', { value: issue.labels.join(', '), onchange: e => patch({ labels: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }) })),
        field('Due date', h('input', { type: 'date', value: issue.dueDate || '', onchange: e => patch({ dueDate: e.target.value || null }) })),
        field('Epic key', h('input', { value: issue.epicId ? (state.issues.find(i => i.id === issue.epicId)?.key || issue.epicId) : '', onchange: e => patch({ epicId: e.target.value.trim() || null }) }))),
      h('p', { class: 'muted' }, `Reporter ${userName(issue.reporterId)} · created ${issue.createdAt} · updated ${issue.updatedAt}${issue.resolvedAt ? ' · resolved ' + issue.resolvedAt : ''}`),
      issue.progress ? h('p', {}, `Epic progress: ${issue.progress.done}/${issue.progress.total} issues, ${issue.progress.points_done}/${issue.progress.points_total} points`) : null,
      h('h3', {}, 'Subtasks'), h('ul', {}, issue.children.map(k => h('li', {}, h('a', { href: '#', onclick: e => { e.preventDefault(); modal.remove(); openIssue(k); } }, k)))),
      issue.type !== 'subtask' && issue.type !== 'epic' ? h('form', { onsubmit: e => { e.preventDefault(); guard(async () => { await api('POST', `/api/projects/${issue.projectId}/issues`, { type: 'subtask', parentId: issue.id, title: e.target.st.value }); await draw(); }); } }, h('input', { name: 'st', placeholder: 'New subtask' }), h('button', {}, 'Add')) : null,
      h('h3', {}, 'Links'), h('ul', {}, issue.links.map(l => h('li', {}, `${l.type} `, h('a', { href: '#', onclick: e => { e.preventDefault(); modal.remove(); openIssue(l.key); } }, l.key), ' ', h('button', { onclick: () => guard(async () => { await api('DELETE', `/api/issues/${key}/links/${l.id}`); await draw(); }) }, '×')))),
      h('form', { onsubmit: e => { e.preventDefault(); guard(async () => { await api('POST', `/api/issues/${key}/links`, { type: e.target.lt.value, target: e.target.tg.value.trim() }); await draw(); }); } }, h('select', { name: 'lt' }, ['blocks', 'relates', 'duplicates'].map(t => h('option', {}, t))), h('input', { name: 'tg', placeholder: 'Target key' }), h('button', {}, 'Link')),
      h('h3', {}, 'Comments'),
      comments.map(c => h('div', { class: 'card' }, h('div', { class: 'muted' }, `${userName(c.authorId)} · ${c.createdAt}${c.edited ? ' (edited)' : ''}`), h('div', { style: 'white-space:pre-wrap' }, c.body),
        c.authorId === state.user.id ? h('button', { onclick: () => { const b = prompt('Edit comment', c.body); if (b) guard(async () => { await api('PATCH', `/api/comments/${c.id}`, { body: b }); await draw(); }); } }, 'Edit') : null)),
      h('form', { onsubmit: e => { e.preventDefault(); guard(async () => { await api('POST', `/api/issues/${key}/comments`, { body: e.target.cb.value }); await draw(); }); } }, h('textarea', { name: 'cb', rows: 2, style: 'width:100%', placeholder: 'Comment (use @username to mention)' }), h('button', { class: 'primary' }, 'Comment')),
      h('h3', {}, 'History'), h('table', {}, history.map(x => h('tr', {}, h('td', {}, x.at), h('td', {}, userName(x.actorId)), h('td', {}, x.field), h('td', {}, JSON.stringify(x.from)), h('td', {}, '→ ' + JSON.stringify(x.to))))));
    modal.replaceChildren(detail);
  };
  await draw();
}

// ---------- search ----------
async function viewSearch() {
  const sort = state.searchSort || 'updated';
  const results = await api('GET', `/api/search?q=${encodeURIComponent(state.searchQ || '')}&sort=${sort}`);
  return h('div', { class: 'card' }, h('h3', {}, `Search results (${results.length}) `,
    h('select', { onchange: e => { state.searchSort = e.target.value; render(); } }, ['updated', 'created', 'priority'].map(s => h('option', { selected: s === sort }, s)))),
  results.map(i => issueCard(i, false)));
}

// ---------- notifications ----------
async function viewNotifications() {
  const list = await api('GET', '/api/notifications');
  return h('div', { class: 'card' }, h('h3', {}, 'Notifications ', h('button', { onclick: () => guard(async () => { await api('POST', '/api/notifications/read', { all: true }); render(); }) }, 'Mark all read')),
    list.length ? list.map(n => h('div', { class: 'notif' + (n.read ? '' : ' unread') }, `${n.at} — ${n.type} on `, h('a', { href: '#', onclick: async e => { e.preventDefault(); await api('POST', '/api/notifications/read', { ids: [n.id] }); openIssue(n.issueKey); } }, n.issueKey), ` by ${userName(n.actorId)}`)) : h('p', { class: 'muted' }, 'Nothing here.'));
}

// ---------- reports ----------
function burndownChart(report) {
  const W = 600, H = 240, P = 36;
  const pts = report.burndown;
  const max = Math.max(1, report.committedPoints, ...pts.map(p => p.remainingPoints));
  const x = i => P + (pts.length <= 1 ? 0 : (i * (W - 2 * P)) / (pts.length - 1));
  const y = v => H - P - (v * (H - 2 * P)) / max;
  const s = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Burndown chart' });
  s.append(svg('line', { x1: P, y1: H - P, x2: W - P, y2: H - P, stroke: '#999' }), svg('line', { x1: P, y1: P, x2: P, y2: H - P, stroke: '#999' }));
  s.append(svg('text', { x: 4, y: P, 'font-size': 11 }, String(max)), svg('text', { x: 4, y: H - P, 'font-size': 11 }, '0'));
  if (pts.length) {
    s.append(svg('line', { x1: x(0), y1: y(report.committedPoints), x2: x(pts.length - 1), y2: y(0), stroke: '#bbb', 'stroke-dasharray': '4 4' }));
    s.append(svg('polyline', { fill: 'none', stroke: '#4c6ef5', 'stroke-width': 2, points: pts.map((p, i) => `${x(i)},${y(p.remainingPoints)}`).join(' ') }));
    pts.forEach((p, i) => { s.append(svg('circle', { cx: x(i), cy: y(p.remainingPoints), r: 3, fill: '#4c6ef5' }, svg('title', {}, `${p.date}: ${p.remainingPoints}`))); });
    s.append(svg('text', { x: P, y: H - 10, 'font-size': 11 }, pts[0].date), svg('text', { x: W - P - 60, y: H - 10, 'font-size': 11 }, pts[pts.length - 1].date));
  }
  return s;
}
async function viewReports() {
  if (!state.project) return h('div', { class: 'card' }, 'No project selected.');
  const stats = await api('GET', `/api/projects/${state.project.id}/stats`);
  const wrap = h('div', {});
  const kv = obj => h('table', {}, Object.entries(obj).map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, v))));
  wrap.append(h('div', { class: 'card row' },
    h('div', {}, h('h3', {}, 'By status'), kv(stats.byStatus)), h('div', {}, h('h3', {}, 'By type'), kv(stats.byType)),
    h('div', {}, h('h3', {}, 'By assignee'), kv(Object.fromEntries(Object.entries(stats.byAssignee).map(([k, v]) => [k === 'unassigned' ? k : userName(k), v])))),
    h('div', {}, h('h3', {}, 'Avg cycle time'), h('p', {}, stats.averageCycleTimeHours == null ? '—' : `${stats.averageCycleTimeHours.toFixed(1)} h`))));
  for (const s of state.sprints.filter(s => s.state !== 'planned')) {
    const r = await api('GET', `/api/sprints/${s.id}/report`);
    wrap.append(h('div', { class: 'card' }, h('h3', {}, `Sprint ${s.name} (${s.state})`),
      h('p', {}, `Committed ${r.committedPoints} pts · completed ${r.completedPoints} pts · ${r.completedIssues} issues done · ${r.carriedOver} carried over`), burndownChart(r)));
  }
  return wrap;
}

// ---------- project settings ----------
async function viewSettings() {
  if (!state.project) return h('div', { class: 'card' }, 'No project selected.');
  const p = state.project;
  const reload = async () => { await loadProjectData(); render(); };
  // workflow editor
  const wfText = h('textarea', { rows: 7, style: 'width:100%' }, p.workflow.statuses.map(s => `${s.name}:${s.category}`).join('\n'));
  const trText = h('textarea', { rows: 5, style: 'width:100%', placeholder: 'Leave empty for any → any' }, p.workflow.transitions.map(t => `${t[0]} -> ${t[1]}`).join('\n'));
  const remapText = h('input', { style: 'width:100%', placeholder: 'Old Status=New Status; ...' });
  const wf = h('div', { class: 'card' }, h('h3', {}, 'Workflow'), h('p', { class: 'muted' }, 'One status per line as Name:category (backlog|unstarted|started|completed)'), wfText,
    h('p', { class: 'muted' }, 'Transitions, one per line: From -> To'), trText, h('label', {}, 'Remap removed statuses', remapText),
    h('button', { class: 'primary', onclick: () => guard(async () => {
      const statuses = wfText.value.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const i = l.lastIndexOf(':'); return { name: l.slice(0, i).trim(), category: l.slice(i + 1).trim() }; });
      const tl = trText.value.split('\n').map(l => l.trim()).filter(Boolean);
      const transitions = tl.length ? tl.map(l => l.split('->').map(x => x.trim())) : undefined;
      const remap = Object.fromEntries(remapText.value.split(';').map(x => x.trim()).filter(Boolean).map(x => x.split('=').map(y => y.trim())));
      await api('PUT', `/api/projects/${p.id}/workflow`, { statuses, transitions, remap });
      await reload();
    }) }, 'Save workflow'));
  // members
  const members = await api('GET', `/api/projects/${p.id}/members`);
  const mem = h('div', { class: 'card' }, h('h3', {}, 'Project members'),
    h('table', {}, members.map(m => h('tr', {}, h('td', {}, m.username), h('td', {}, h('select', { onchange: e => guard(async () => { await api('PATCH', `/api/projects/${p.id}/members/${m.userId}`, { role: e.target.value }); }) }, ['lead', 'developer', 'viewer'].map(r => h('option', { selected: r === m.role }, r)))),
      h('td', {}, h('button', { onclick: () => guard(async () => { await api('DELETE', `/api/projects/${p.id}/members/${m.userId}`); await reload(); }) }, 'Remove'))))),
    h('form', { onsubmit: e => { e.preventDefault(); guard(async () => { await api('POST', `/api/projects/${p.id}/members`, { username: e.target.un.value, role: e.target.role.value }); await reload(); }); } },
      h('input', { name: 'un', placeholder: 'username' }), h('select', { name: 'role' }, ['developer', 'viewer', 'lead'].map(r => h('option', {}, r))), h('button', {}, 'Add')));
  // webhooks
  let hooks = [];
  try { hooks = await api('GET', `/api/projects/${p.id}/webhooks`); } catch { /* not a lead */ }
  const hk = h('div', { class: 'card' }, h('h3', {}, 'Webhooks'),
    hooks.map(w => h('div', {}, `${w.url} [${w.events.join(', ')}] `,
      h('button', { onclick: () => guard(async () => { const d = await api('GET', `/api/webhooks/${w.id}/deliveries`); flash(d.map(x => `${x.event}: status ${x.status} attempts ${x.attempts}${x.lastError ? ' ' + x.lastError : ''}`).join('\n') || 'No deliveries'); }) }, 'Deliveries'), ' ',
      h('button', { onclick: () => guard(async () => { await api('DELETE', `/api/webhooks/${w.id}`); await reload(); }) }, 'Delete'))),
    h('form', { onsubmit: e => { e.preventDefault(); const f = e.target; guard(async () => { await api('POST', `/api/projects/${p.id}/webhooks`, { url: f.url.value, secret: f.secret.value, events: [...f.querySelectorAll('input[type=checkbox]:checked')].map(c => c.value) }); await reload(); }); } },
      h('input', { name: 'url', placeholder: 'https://example.com/hook', size: 30 }), h('input', { name: 'secret', placeholder: 'secret' }),
      ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'].map(ev => h('label', { style: 'display:inline' }, h('input', { type: 'checkbox', value: ev, checked: true }), ev, ' ')), h('button', {}, 'Add webhook')));
  return h('div', {}, wf, mem, hk);
}

// ---------- workspace ----------
async function viewWorkspace() {
  if (!state.ws) return h('div', { class: 'card' }, 'No workspace yet. ', h('button', { class: 'primary', onclick: newWorkspace }, 'Create workspace'));
  const ws = state.ws;
  const members = await api('GET', `/api/workspaces/${ws.id}/members`);
  const isAdmin = ws.role === 'admin';
  const el = h('div', {}, h('div', { class: 'card' }, h('h3', {}, `Members of ${ws.name}`),
    h('table', {}, members.map(m => h('tr', {}, h('td', {}, m.username), h('td', {}, isAdmin ? h('select', { onchange: e => guard(async () => { await api('PATCH', `/api/workspaces/${ws.id}/members/${m.userId}`, { role: e.target.value }); render(); }) }, ['admin', 'member', 'guest'].map(r => h('option', { selected: r === m.role }, r))) : m.role),
      h('td', {}, isAdmin ? h('button', { onclick: () => guard(async () => { await api('DELETE', `/api/workspaces/${ws.id}/members/${m.userId}`); render(); }) }, 'Remove') : null)))),
    isAdmin ? h('form', { onsubmit: e => { e.preventDefault(); guard(async () => { await api('POST', `/api/workspaces/${ws.id}/members`, { username: e.target.un.value, role: e.target.role.value }); await loadProjects(); render(); }); } },
      h('input', { name: 'un', placeholder: 'username' }), h('select', { name: 'role' }, ['member', 'guest', 'admin'].map(r => h('option', {}, r))), h('button', {}, 'Add')) : null));
  if (isAdmin) {
    const log = await api('GET', `/api/workspaces/${ws.id}/audit`);
    el.append(h('div', { class: 'card' }, h('h3', {}, 'Audit log'), h('table', {}, log.slice().reverse().map(a => h('tr', {}, h('td', {}, a.at), h('td', {}, userName(a.actorId)), h('td', {}, a.action), h('td', {}, JSON.stringify(a.details)))))));
  }
  return el;
}

// ---------- account ----------
async function viewAccount() {
  const tokens = await api('GET', '/api/tokens');
  const out = h('div', { class: 'muted' });
  return h('div', {},
    h('form', { class: 'card', onsubmit: e => { e.preventDefault(); const f = e.target; guard(async () => { const body = { currentPassword: f.cur.value }; if (f.dn.value) body.displayName = f.dn.value; if (f.pw.value) body.password = f.pw.value; state.user = (await api('PATCH', '/api/auth/me', body)).user; render(); }); } },
      h('h3', {}, 'Profile'), h('label', {}, 'Display name', h('input', { name: 'dn', value: state.user.displayName })), h('label', {}, 'New password', h('input', { name: 'pw', type: 'password' })),
      h('label', {}, 'Current password', h('input', { name: 'cur', type: 'password', required: true })), h('button', { class: 'primary' }, 'Save')),
    h('div', { class: 'card' }, h('h3', {}, 'API tokens'), h('table', {}, tokens.map(t => h('tr', {}, h('td', {}, t.name), h('td', {}, t.createdAt), h('td', {}, h('button', { onclick: () => guard(async () => { await api('DELETE', `/api/tokens/${t.id}`); render(); }) }, 'Revoke'))))),
      h('form', { onsubmit: e => { e.preventDefault(); guard(async () => { const t = await api('POST', '/api/tokens', { name: e.target.tn.value }); out.textContent = `New token (shown once): ${t.token}`; }); } }, h('input', { name: 'tn', placeholder: 'Token name' }), h('button', {}, 'Create token')), out));
}

boot();
