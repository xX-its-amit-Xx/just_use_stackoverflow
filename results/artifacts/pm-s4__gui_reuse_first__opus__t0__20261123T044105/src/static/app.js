// pm-s4 single-page app. Uses only the public JSON API.
const $ = (sel, el = document) => el.querySelector(sel);
const app = $('#app');
const state = { token: localStorage.getItem('pm_token'), me: null, workspaces: [], workspace: null, projects: [], project: null, users: {} };

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v !== null && v !== undefined) el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
const svg = (tag, attrs = {}) => { const el = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v); return el; };

function toast(msg) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 3500); }

async function api(method, path, body, raw = false) {
  const headers = {};
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  let payload;
  if (body !== undefined) {
    if (raw) { headers['content-type'] = 'text/csv'; payload = body; }
    else { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  }
  const res = await fetch(path, { method, headers, body: payload });
  if (res.status === 401 && !path.startsWith('/api/auth/login')) { logoutLocal(); throw new Error('Please log in'); }
  if (res.status === 204) return null;
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) { const err = new Error(data?.message || `HTTP ${res.status}`); err.status = res.status; err.code = data?.error; throw err; }
  return data;
}
const safe = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message); } };

function logoutLocal() { state.token = null; state.me = null; localStorage.removeItem('pm_token'); $('#topbar').hidden = true; location.hash = '#/login'; }

async function userName(id) {
  if (!id) return '—';
  if (!state.users[id]) { try { state.users[id] = await api('GET', `/api/users/${id}`); } catch { state.users[id] = { username: id }; } }
  return state.users[id].username;
}

// ---------- auth views ----------
function renderLogin() {
  $('#topbar').hidden = true;
  const msg = h('div', { class: 'error' });
  const form = h('form', {
    onsubmit: async e => {
      e.preventDefault();
      const f = new FormData(form);
      try {
        if (e.submitter?.value === 'register') await api('POST', '/api/auth/register', { username: f.get('username'), password: f.get('password'), displayName: f.get('displayName') || undefined });
        const r = await api('POST', '/api/auth/login', { username: f.get('username'), password: f.get('password') });
        state.token = r.token; localStorage.setItem('pm_token', r.token); state.me = r.user;
        await boot();
        location.hash = '#/board';
      } catch (err) { msg.textContent = err.message; }
    }
  },
  h('h2', {}, 'Sign in'),
  h('input', { name: 'username', placeholder: 'Username', required: true, autocomplete: 'username' }),
  h('input', { name: 'password', type: 'password', placeholder: 'Password (min 8 chars)', required: true }),
  h('input', { name: 'displayName', placeholder: 'Display name (register only)' }),
  h('div', { class: 'row' }, h('button', { class: 'primary', value: 'login' }, 'Log in'), h('button', { value: 'register' }, 'Register')),
  msg);
  app.replaceChildren(h('div', { class: 'card-box' }, form));
}

// ---------- shell ----------
async function boot() {
  state.me = (await api('GET', '/api/auth/me')).user;
  $('#topbar').hidden = false;
  $('#whoami').textContent = state.me.displayName;
  await loadWorkspaces();
  refreshNotifCount();
}
async function loadWorkspaces() {
  state.workspaces = await api('GET', '/api/workspaces');
  const sel = $('#ws-select');
  const saved = localStorage.getItem('pm_ws');
  state.workspace = state.workspaces.find(w => w.id === saved) || state.workspaces[0] || null;
  sel.replaceChildren(...state.workspaces.map(w => h('option', { value: w.id, selected: w.id === state.workspace?.id }, `${w.name} (${w.key})`)), h('option', { value: '__new' }, '+ New workspace…'));
  await loadProjects();
}
async function loadProjects() {
  state.projects = state.workspace ? await api('GET', `/api/workspaces/${state.workspace.id}/projects`) : [];
  const saved = localStorage.getItem('pm_project');
  state.project = state.projects.find(p => p.id === saved) || state.projects[0] || null;
  $('#project-select').replaceChildren(...state.projects.map(p => h('option', { value: p.id, selected: p.id === state.project?.id }, `${p.name} (${p.key})`)), h('option', { value: '__new' }, '+ New project…'));
}
async function reloadProject() { if (state.project) { state.project = await api('GET', `/api/projects/${state.project.id}`); } }

$('#ws-select').addEventListener('change', safe(async e => {
  if (e.target.value === '__new') {
    const name = prompt('Workspace name'); const key = name && prompt('Workspace key (2-10 uppercase letters)');
    if (name && key) { const w = await api('POST', '/api/workspaces', { name, key }); localStorage.setItem('pm_ws', w.id); }
  } else localStorage.setItem('pm_ws', e.target.value);
  await loadWorkspaces(); route();
}));
$('#project-select').addEventListener('change', safe(async e => {
  if (e.target.value === '__new') {
    if (!state.workspace) return toast('Create a workspace first');
    const name = prompt('Project name'); const key = name && prompt('Project key (e.g. WEB)');
    if (name && key) { const p = await api('POST', `/api/workspaces/${state.workspace.id}/projects`, { name, key }); localStorage.setItem('pm_project', p.id); }
  } else localStorage.setItem('pm_project', e.target.value);
  await loadProjects(); route();
}));
$('#logout-btn').addEventListener('click', safe(async () => { await api('POST', '/api/auth/logout'); logoutLocal(); }));
$('#search-form').addEventListener('submit', e => { e.preventDefault(); location.hash = '#/search?q=' + encodeURIComponent($('#search-input').value); });

// ---------- notifications ----------
async function refreshNotifCount() {
  try { const n = await api('GET', '/api/notifications?unread=true'); $('#notif-count').textContent = n.length || ''; } catch { /* ignore */ }
}
$('#notif-btn').addEventListener('click', safe(async () => {
  const panel = $('#notif-panel');
  if (!panel.hidden) { panel.hidden = true; return; }
  const list = await api('GET', '/api/notifications');
  const rows = await Promise.all(list.map(async n => h('div', { class: n.read ? '' : 'unread' },
    h('a', { href: `#/issue/${n.issueKey}` }, n.issueKey), ` ${n.type.replace('_', ' ')} by ${await userName(n.actorId)} `, h('span', { class: 'muted' }, new Date(n.at).toLocaleString()))));
  panel.replaceChildren(h('div', { class: 'row' }, h('strong', {}, 'Notifications'),
    h('button', { onclick: safe(async () => { await api('POST', '/api/notifications/read', { all: true }); panel.hidden = true; refreshNotifCount(); }) }, 'Mark all read')),
    ...(rows.length ? rows : [h('p', { class: 'muted' }, 'Nothing yet')]));
  panel.hidden = false;
}));

// ---------- board ----------
function issueCard(issue) {
  return h('div', { class: 'issue-card', draggable: 'true', 'data-key': issue.key,
    ondragstart: e => e.dataTransfer.setData('text/plain', issue.key), ondblclick: () => { location.hash = `#/issue/${issue.key}`; } },
  h('div', { class: 'key' }, h('a', { href: `#/issue/${issue.key}` }, issue.key), ' · ', issue.type),
  h('div', {}, issue.title),
  h('div', {}, h('span', { class: `pill prio-${issue.priority}` }, issue.priority), issue.storyPoints != null ? h('span', { class: 'pill' }, `${issue.storyPoints} pts`) : null,
    ...issue.labels.map(l => h('span', { class: 'pill' }, l))));
}
async function renderBoard() {
  if (!state.project) return renderEmpty();
  await reloadProject();
  const issues = await api('GET', `/api/projects/${state.project.id}/issues`);
  const sprints = await api('GET', `/api/projects/${state.project.id}/sprints`);
  const active = sprints.find(s => s.state === 'active');
  const onlyActive = active && localStorage.getItem('pm_board_sprint') !== 'all';
  const shown = onlyActive ? issues.filter(i => i.sprintId === active.id) : issues;
  const cols = state.project.workflow.statuses.map(s => {
    const col = h('div', { class: 'column', 'data-status': s.name,
      ondragover: e => { e.preventDefault(); col.classList.add('over'); },
      ondragleave: () => col.classList.remove('over'),
      ondrop: safe(async e => {
        e.preventDefault(); col.classList.remove('over');
        const key = e.dataTransfer.getData('text/plain');
        try { await api('PATCH', `/api/issues/${key}`, { status: s.name }); } catch (err) { toast(err.code === 'invalid_transition' ? `Transition not allowed: ${err.message}` : err.message); }
        renderBoard();
      }) },
    h('h3', {}, `${s.name} (${shown.filter(i => i.status === s.name).length})`), ...shown.filter(i => i.status === s.name).map(issueCard));
    return col;
  });
  app.replaceChildren(
    h('div', { class: 'row' }, h('h2', {}, `${state.project.name} board`), active ? h('span', { class: 'pill' }, `Active sprint: ${active.name}`) : null,
      active ? h('button', { onclick: () => { localStorage.setItem('pm_board_sprint', onlyActive ? 'all' : 'sprint'); renderBoard(); } }, onlyActive ? 'Show all issues' : 'Show active sprint only') : null,
      newIssueForm()),
    h('div', { class: 'board' }, ...cols));
}
function newIssueForm(extra = {}) {
  const form = h('form', { class: 'row', onsubmit: safe(async e => {
    e.preventDefault();
    const f = new FormData(form);
    const body = { title: f.get('title'), type: f.get('type'), priority: f.get('priority'), ...extra };
    if (f.get('points')) body.storyPoints = Number(f.get('points'));
    const issue = await api('POST', `/api/projects/${state.project.id}/issues`, body);
    toast(`Created ${issue.key}`); route();
  }) },
  h('input', { name: 'title', placeholder: 'New issue title', required: true }),
  h('select', { name: 'type' }, ...['task', 'bug', 'feature', 'epic'].map(t => h('option', {}, t))),
  h('select', { name: 'priority' }, ...['none', 'low', 'medium', 'high', 'urgent'].map(t => h('option', {}, t))),
  h('input', { name: 'points', type: 'number', min: '0', placeholder: 'pts', style: 'width:4rem' }),
  h('button', { class: 'primary' }, 'Create'));
  return form;
}
function renderEmpty() {
  app.replaceChildren(h('div', { class: 'panel' }, h('p', {}, state.workspace ? 'No project yet. Use the project switcher to create one.' : 'No workspace yet. Use the workspace switcher to create one.')));
}

// ---------- backlog / sprint planning ----------
async function renderBacklog() {
  if (!state.project) return renderEmpty();
  const pid = state.project.id;
  const [issues, sprints] = await Promise.all([api('GET', `/api/projects/${pid}/issues`), api('GET', `/api/projects/${pid}/sprints`)]);
  const openSprints = sprints.filter(s => s.state !== 'completed');
  const moveSelect = issue => h('select', { onchange: safe(async e => { await api('PATCH', `/api/issues/${issue.key}`, { sprintId: e.target.value || null }); renderBacklog(); }) },
    h('option', { value: '' }, 'Backlog'), ...openSprints.map(s => h('option', { value: s.id, selected: issue.sprintId === s.id }, s.name)));
  const table = list => h('table', {}, h('tr', {}, h('th', {}, 'Key'), h('th', {}, 'Title'), h('th', {}, 'Status'), h('th', {}, 'Pts'), h('th', {}, 'Sprint')),
    ...list.map(i => h('tr', {}, h('td', {}, h('a', { href: `#/issue/${i.key}` }, i.key)), h('td', {}, i.title), h('td', {}, i.status), h('td', {}, i.storyPoints ?? ''), h('td', {}, moveSelect(i)))));
  const sprintBlocks = openSprints.map(s => {
    const list = issues.filter(i => i.sprintId === s.id);
    const pts = list.reduce((a, i) => a + (i.storyPoints || 0), 0);
    return h('div', { class: 'sprint' },
      h('div', { class: 'row' }, h('strong', {}, s.name), h('span', { class: 'pill' }, s.state), h('span', { class: 'muted' }, `${s.startDate || '?'} → ${s.endDate || '?'} · ${list.length} issues · ${pts} pts`),
        s.state === 'planned' ? h('button', { onclick: safe(async () => { await api('POST', `/api/sprints/${s.id}/start`, {}); renderBacklog(); }) }, 'Start sprint') : null,
        s.state === 'active' ? h('button', { onclick: safe(async () => {
          const others = openSprints.filter(x => x.id !== s.id);
          const choice = prompt(`Carry unfinished issues to: "backlog" or one of: ${others.map(o => o.name).join(', ')}`, 'backlog');
          if (choice === null) return;
          const target = others.find(o => o.name === choice)?.id || 'backlog';
          await api('POST', `/api/sprints/${s.id}/complete`, { carryOverTo: target }); renderBacklog();
        }) }, 'Complete sprint') : null,
        h('a', { href: `#/report/${s.id}` }, 'Report')),
      table(list));
  });
  const sprintForm = h('form', { class: 'row', onsubmit: safe(async e => {
    e.preventDefault(); const f = new FormData(sprintForm);
    await api('POST', `/api/projects/${pid}/sprints`, { name: f.get('name'), startDate: f.get('startDate') || undefined, endDate: f.get('endDate') || undefined });
    renderBacklog();
  }) }, h('input', { name: 'name', placeholder: 'Sprint name', required: true }), h('input', { name: 'startDate', type: 'date' }), h('input', { name: 'endDate', type: 'date' }), h('button', {}, 'Create sprint'));
  app.replaceChildren(h('h2', {}, 'Backlog & sprint planning'), sprintForm, ...sprintBlocks,
    h('div', { class: 'sprint' }, h('div', { class: 'row' }, h('strong', {}, 'Backlog'), newIssueForm()), table(issues.filter(i => !i.sprintId && i.type !== 'subtask'))));
}

// ---------- issue detail ----------
async function renderIssue(key) {
  const issue = await api('GET', `/api/issues/${key}`);
  const project = await api('GET', `/api/projects/${issue.projectId}`);
  const [comments, history] = await Promise.all([api('GET', `/api/issues/${key}/comments`), api('GET', `/api/issues/${key}/history`)]);
  const patch = body => safe(async () => { await api('PATCH', `/api/issues/${key}`, body); renderIssue(key); })();
  const statusSel = h('select', { onchange: e => patch({ status: e.target.value }) }, ...project.workflow.statuses.map(s => h('option', { selected: s.name === issue.status }, s.name)));
  const prioSel = h('select', { onchange: e => patch({ priority: e.target.value }) }, ...['urgent', 'high', 'medium', 'low', 'none'].map(p => h('option', { selected: p === issue.priority }, p)));
  const assigneeSel = h('select', { onchange: e => patch({ assigneeId: e.target.value || null }) }, h('option', { value: '' }, 'Unassigned'),
    ...project.members.map(m => h('option', { value: m.userId, selected: m.userId === issue.assigneeId }, m.username)));
  const title = h('input', { value: issue.title, style: 'width:100%;font-size:1.2rem', onchange: e => patch({ title: e.target.value }) });
  const desc = h('textarea', { rows: '6', style: 'width:100%', onchange: e => patch({ description: e.target.value }) }); desc.value = issue.description || '';
  const labels = h('input', { value: issue.labels.join(', '), onchange: e => patch({ labels: e.target.value.split(',').map(s => s.trim()).filter(Boolean) }) });
  const points = h('input', { type: 'number', min: '0', value: issue.storyPoints ?? '', style: 'width:5rem', onchange: e => patch({ storyPoints: e.target.value === '' ? null : Number(e.target.value) }) });
  const due = h('input', { type: 'date', value: issue.dueDate || '', onchange: e => patch({ dueDate: e.target.value || null }) });
  const watching = issue.watchers.includes(state.me.id);

  const commentForm = h('form', { onsubmit: safe(async e => { e.preventDefault(); await api('POST', `/api/issues/${key}/comments`, { body: new FormData(commentForm).get('body') }); renderIssue(key); }) },
    h('textarea', { name: 'body', rows: '3', style: 'width:100%', placeholder: 'Comment… use @username to mention', required: true }), h('button', { class: 'primary' }, 'Comment'));
  const commentEls = await Promise.all(comments.map(async c => h('div', { class: 'comment' },
    h('div', { class: 'muted' }, `${await userName(c.authorId)} · ${new Date(c.createdAt).toLocaleString()}${c.edited ? ' (edited)' : ''}`),
    h('div', {}, c.body),
    c.authorId === state.me.id ? h('button', { onclick: safe(async () => { const b = prompt('Edit comment', c.body); if (b) { await api('PATCH', `/api/comments/${c.id}`, { body: b }); renderIssue(key); } }) }, 'Edit') : null)));
  const linkForm = h('form', { class: 'row', onsubmit: safe(async e => { e.preventDefault(); const f = new FormData(linkForm); await api('POST', `/api/issues/${key}/links`, { type: f.get('type'), target: f.get('target') }); renderIssue(key); }) },
    h('select', { name: 'type' }, h('option', {}, 'blocks'), h('option', {}, 'relates'), h('option', {}, 'duplicates')), h('input', { name: 'target', placeholder: 'ABC-12', required: true }), h('button', {}, 'Link'));
  const subForm = h('form', { class: 'row', onsubmit: safe(async e => { e.preventDefault(); await api('POST', `/api/projects/${issue.projectId}/issues`, { type: 'subtask', parentId: issue.id, title: new FormData(subForm).get('title') }); renderIssue(key); }) },
    h('input', { name: 'title', placeholder: 'New subtask', required: true }), h('button', {}, 'Add subtask'));
  const histLines = await Promise.all(history.slice().reverse().map(async x => `${new Date(x.at).toLocaleString()} ${await userName(x.actorId)}: ${x.field} ${JSON.stringify(x.from)} → ${JSON.stringify(x.to)}`));

  app.replaceChildren(h('div', { class: 'detail' },
    h('div', { class: 'panel' }, h('div', { class: 'muted' }, `${issue.key} · ${issue.type}`), title, h('h4', {}, 'Description'), desc,
      issue.type !== 'subtask' ? [h('h4', {}, 'Subtasks'), h('ul', {}, ...issue.children.map(k => h('li', {}, h('a', { href: `#/issue/${k}` }, k)))), subForm] : null,
      issue.progress ? h('p', {}, `Epic progress: ${issue.progress.done}/${issue.progress.total} issues, ${issue.progress.points_done}/${issue.progress.points_total} pts`) : null,
      h('h4', {}, 'Links'), h('ul', {}, ...issue.links.map(l => h('li', {}, `${l.type.replace('_', ' ')} `, h('a', { href: `#/issue/${l.issueKey}` }, l.issueKey),
        ' ', h('button', { onclick: safe(async () => { await api('DELETE', `/api/issues/${key}/links/${l.id}`); renderIssue(key); }) }, '×')))), linkForm,
      h('h4', {}, 'Comments'), ...commentEls, commentForm,
      h('h4', {}, 'History'), h('pre', { class: 'history' }, histLines.join('\n') || 'No changes yet')),
    h('div', { class: 'panel' },
      h('div', { class: 'row' }, 'Status ', statusSel), h('div', { class: 'row' }, 'Priority ', prioSel), h('div', { class: 'row' }, 'Assignee ', assigneeSel),
      h('div', { class: 'row' }, 'Labels ', labels), h('div', { class: 'row' }, 'Points ', points), h('div', { class: 'row' }, 'Due ', due),
      h('div', { class: 'row muted' }, `Reporter: ${await userName(issue.reporterId)}`),
      issue.parentId ? h('div', { class: 'row' }, 'Parent: ', h('a', { href: `#/issue/${issue.parentId}` }, 'open')) : null,
      h('div', { class: 'row muted' }, `Created ${new Date(issue.createdAt).toLocaleString()}`),
      issue.resolvedAt ? h('div', { class: 'row muted' }, `Resolved ${new Date(issue.resolvedAt).toLocaleString()}`) : null,
      h('div', { class: 'row' }, h('button', { onclick: safe(async () => { await api(watching ? 'DELETE' : 'POST', `/api/issues/${key}/watch`); renderIssue(key); }) }, watching ? 'Unwatch' : 'Watch'), `${issue.watchers.length} watching`),
      h('div', { class: 'row' }, h('button', { onclick: safe(async () => { if (confirm(`Delete ${key}?`)) { await api('DELETE', `/api/issues/${key}`); location.hash = '#/board'; } }) }, 'Delete issue')))));
}

// ---------- search ----------
async function renderSearch(q) {
  $('#search-input').value = q;
  const sort = new URLSearchParams(location.hash.split('?')[1] || '').get('sort') || 'updated';
  let results;
  try { results = await api('GET', `/api/search?q=${encodeURIComponent(q)}&sort=${sort}`); } catch (e) { app.replaceChildren(h('p', { class: 'error' }, `Query error: ${e.message}`)); return; }
  app.replaceChildren(h('div', { class: 'row' }, h('h2', {}, `Search: ${q || '(all)'}`), 'Sort ',
    h('select', { onchange: e => { location.hash = `#/search?q=${encodeURIComponent(q)}&sort=${e.target.value}`; } }, ...['updated', 'created', 'priority'].map(s => h('option', { selected: s === sort }, s)))),
  h('table', {}, h('tr', {}, h('th', {}, 'Key'), h('th', {}, 'Title'), h('th', {}, 'Type'), h('th', {}, 'Status'), h('th', {}, 'Priority'), h('th', {}, 'Updated')),
    ...results.map(i => h('tr', {}, h('td', {}, h('a', { href: `#/issue/${i.key}` }, i.key)), h('td', {}, i.title), h('td', {}, i.type), h('td', {}, i.status), h('td', {}, i.priority), h('td', {}, new Date(i.updatedAt).toLocaleString())))));
}

// ---------- reports ----------
function burndownChart(report) {
  const W = 600, H = 260, P = 36;
  const el = svg('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Burndown chart' });
  const data = report.burndown;
  const maxY = Math.max(report.committedPoints || 0, ...data.map(d => d.remainingPoints), 1);
  const x = i => P + (data.length <= 1 ? 0 : (i * (W - 2 * P)) / (data.length - 1));
  const y = v => H - P - (v / maxY) * (H - 2 * P);
  el.append(svg('line', { x1: P, y1: H - P, x2: W - P, y2: H - P, stroke: '#999' }), svg('line', { x1: P, y1: P, x2: P, y2: H - P, stroke: '#999' }));
  const lbl = (tx, ty, text, anchor = 'middle') => { const t = svg('text', { x: tx, y: ty, 'font-size': 10, 'text-anchor': anchor }); t.textContent = text; el.append(t); };
  lbl(P - 4, y(maxY) + 4, maxY, 'end'); lbl(P - 4, H - P + 4, 0, 'end');
  if (data.length) {
    el.append(svg('line', { x1: x(0), y1: y(data[0].remainingPoints), x2: x(data.length - 1), y2: y(0), stroke: '#bbb', 'stroke-dasharray': '4 4' }));
    el.append(svg('polyline', { points: data.map((d, i) => `${x(i)},${y(d.remainingPoints)}`).join(' '), fill: 'none', stroke: '#0052cc', 'stroke-width': 2 }));
    data.forEach((d, i) => { el.append(svg('circle', { cx: x(i), cy: y(d.remainingPoints), r: 3, fill: '#0052cc' })); lbl(x(i), H - P + 14, d.date.slice(5)); });
  }
  return el;
}
async function renderReport(sprintId) {
  const [sprint, report] = await Promise.all([api('GET', `/api/sprints/${sprintId}`), api('GET', `/api/sprints/${sprintId}/report`)]);
  app.replaceChildren(h('div', { class: 'panel' }, h('h2', {}, `Sprint report: ${sprint.name}`),
    h('p', {}, `Committed ${report.committedPoints} pts · Completed ${report.completedPoints} pts (${report.completedIssues} issues) · Carried over ${report.carriedOver}`),
    burndownChart(report)));
}
async function renderReports() {
  if (!state.project) return renderEmpty();
  const [sprints, stats] = await Promise.all([api('GET', `/api/projects/${state.project.id}/sprints`), api('GET', `/api/projects/${state.project.id}/stats`)]);
  const kv = obj => h('table', {}, ...Object.entries(obj).map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, v))));
  const byAssignee = {};
  for (const [k, v] of Object.entries(stats.byAssignee)) byAssignee[k === 'unassigned' ? 'unassigned' : await userName(k)] = v;
  app.replaceChildren(h('h2', {}, 'Reports'),
    h('div', { class: 'panel' }, h('h3', {}, 'Sprints'), h('ul', {}, ...sprints.map(s => h('li', {}, h('a', { href: `#/report/${s.id}` }, s.name), ` (${s.state})`)))),
    h('div', { class: 'panel' }, h('h3', {}, 'Project stats'),
      h('p', {}, `Average cycle time: ${stats.avgCycleTimeHours == null ? 'n/a' : stats.avgCycleTimeHours.toFixed(1) + ' h'}`),
      h('h4', {}, 'By status'), kv(stats.byStatus), h('h4', {}, 'By type'), kv(stats.byType), h('h4', {}, 'By assignee'), kv(byAssignee)),
    h('div', { class: 'panel' }, h('h3', {}, 'Import / export'),
      h('button', { onclick: safe(async () => {
        const csv = await api('GET', `/api/projects/${state.project.id}/export.csv`);
        const a = h('a', { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: `${state.project.key}.csv` }); a.click();
      }) }, 'Export CSV'),
      h('input', { type: 'file', accept: '.csv,text/csv', onchange: safe(async e => {
        const text = await e.target.files[0].text();
        const r = await api('POST', `/api/projects/${state.project.id}/import.csv`, text, true);
        toast(`Imported ${r.created}; ${r.errors.length} errors${r.errors.length ? ': ' + r.errors.map(x => `line ${x.line}: ${x.message}`).join('; ') : ''}`);
      }) })));
}

// ---------- settings ----------
async function renderSettings() {
  if (!state.project) return renderEmpty();
  await reloadProject();
  const p = state.project;
  const wfText = h('textarea', { rows: '8', style: 'width:100%' });
  wfText.value = p.workflow.statuses.map(s => `${s.name} | ${s.category}`).join('\n');
  const trText = h('textarea', { rows: '6', style: 'width:100%', placeholder: 'From -> To (one per line); leave empty for any → any' });
  const all = p.workflow.statuses.length * (p.workflow.statuses.length - 1) === p.workflow.transitions.length;
  trText.value = all ? '' : p.workflow.transitions.map(([a, b]) => `${a} -> ${b}`).join('\n');
  const remapText = h('input', { style: 'width:100%', placeholder: 'Remap removed statuses: Old=New, Other=New' });
  const saveWf = safe(async () => {
    const statuses = wfText.value.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const [name, category] = l.split('|').map(s => s.trim()); return { name, category }; });
    const tr = trText.value.split('\n').map(l => l.trim()).filter(Boolean).map(l => l.split('->').map(s => s.trim()));
    const remap = Object.fromEntries(remapText.value.split(',').map(s => s.trim()).filter(Boolean).map(s => s.split('=').map(x => x.trim())));
    await api('PUT', `/api/projects/${p.id}/workflow`, { statuses, transitions: tr.length ? tr : undefined, remap });
    toast('Workflow saved'); renderSettings();
  });
  const memberForm = h('form', { class: 'row', onsubmit: safe(async e => { e.preventDefault(); const f = new FormData(memberForm); await api('POST', `/api/projects/${p.id}/members`, { username: f.get('username'), role: f.get('role') }); renderSettings(); }) },
    h('input', { name: 'username', placeholder: 'username', required: true }), h('select', { name: 'role' }, h('option', {}, 'developer'), h('option', {}, 'viewer'), h('option', {}, 'lead')), h('button', {}, 'Add member'));
  let webhooks = [];
  try { webhooks = await api('GET', `/api/projects/${p.id}/webhooks`); } catch { /* not a lead */ }
  const hookForm = h('form', { class: 'row', onsubmit: safe(async e => {
    e.preventDefault(); const f = new FormData(hookForm);
    await api('POST', `/api/projects/${p.id}/webhooks`, { url: f.get('url'), secret: f.get('secret'), events: f.getAll('events') }); renderSettings();
  }) }, h('input', { name: 'url', placeholder: 'https://example.com/hook', required: true }), h('input', { name: 'secret', placeholder: 'secret' }),
  ...['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'].map(ev => h('label', {}, h('input', { type: 'checkbox', name: 'events', value: ev, checked: true }), ev)), h('button', {}, 'Add webhook'));
  const hookRows = webhooks.map(w => h('li', {}, `${w.url} [${w.events.join(', ')}] `,
    h('button', { onclick: safe(async () => { const d = await api('GET', `/api/webhooks/${w.id}/deliveries`); alert(d.map(x => `${x.at} ${x.event} status=${x.status} attempts=${x.attempts} ${x.lastError || ''}`).join('\n') || 'No deliveries'); }) }, 'Deliveries'),
    h('button', { onclick: safe(async () => { await api('DELETE', `/api/webhooks/${w.id}`); renderSettings(); }) }, 'Delete')));
  const wsMembers = state.workspace ? await api('GET', `/api/workspaces/${state.workspace.id}/members`).catch(() => []) : [];
  const wsForm = h('form', { class: 'row', onsubmit: safe(async e => { e.preventDefault(); const f = new FormData(wsForm); await api('POST', `/api/workspaces/${state.workspace.id}/members`, { username: f.get('username'), role: f.get('role') }); renderSettings(); }) },
    h('input', { name: 'username', placeholder: 'username', required: true }), h('select', { name: 'role' }, h('option', {}, 'member'), h('option', {}, 'guest'), h('option', {}, 'admin')), h('button', {}, 'Invite to workspace'));
  const tokens = await api('GET', '/api/tokens');
  app.replaceChildren(h('h2', {}, `Settings: ${p.name}`),
    h('div', { class: 'panel' }, h('h3', {}, 'Workflow'), h('p', { class: 'muted' }, 'One status per line: Name | category (backlog, unstarted, started, completed)'), wfText,
      h('p', { class: 'muted' }, 'Transitions'), trText, remapText, h('button', { class: 'primary', onclick: saveWf }, 'Save workflow')),
    h('div', { class: 'panel' }, h('h3', {}, 'Project members'), h('ul', {}, ...p.members.map(m => h('li', {}, `${m.username} — ${m.role} `,
      h('button', { onclick: safe(async () => { await api('DELETE', `/api/projects/${p.id}/members/${m.userId}`); renderSettings(); }) }, 'Remove')))), memberForm),
    h('div', { class: 'panel' }, h('h3', {}, 'Workspace members'), h('ul', {}, ...wsMembers.map(m => h('li', {}, `${m.username} — ${m.role}`))), wsForm,
      h('button', { onclick: safe(async () => { const a = await api('GET', `/api/workspaces/${state.workspace.id}/audit`); alert(a.map(x => `${x.at} ${x.action} ${JSON.stringify(x.details)}`).join('\n') || 'Empty'); }) }, 'View audit log')),
    h('div', { class: 'panel' }, h('h3', {}, 'Webhooks'), h('ul', {}, ...hookRows), hookForm),
    h('div', { class: 'panel' }, h('h3', {}, 'Personal API tokens'), h('ul', {}, ...tokens.map(t => h('li', {}, `${t.name} `, h('button', { onclick: safe(async () => { await api('DELETE', `/api/tokens/${t.id}`); renderSettings(); }) }, 'Revoke')))),
      h('button', { onclick: safe(async () => { const name = prompt('Token name'); if (name) { const t = await api('POST', '/api/tokens', { name }); prompt('Copy your token now (shown once):', t.token); renderSettings(); } }) }, 'New token')));
}

// ---------- router ----------
async function route() {
  const hash = location.hash || '#/board';
  if (!state.token) return renderLogin();
  if (!state.me) { try { await boot(); } catch { return renderLogin(); } }
  document.querySelectorAll('#tabs a').forEach(a => a.classList.toggle('active', hash.startsWith(a.getAttribute('href'))));
  $('#notif-panel').hidden = true;
  const [pathPart, qs] = hash.slice(1).split('?');
  const parts = pathPart.split('/').filter(Boolean);
  try {
    switch (parts[0]) {
      case 'login': return renderLogin();
      case 'issue': return await renderIssue(decodeURIComponent(parts[1]));
      case 'backlog': return await renderBacklog();
      case 'reports': return await renderReports();
      case 'report': return await renderReport(parts[1]);
      case 'settings': return await renderSettings();
      case 'search': return await renderSearch(new URLSearchParams(qs || '').get('q') || '');
      default: return await renderBoard();
    }
  } catch (e) { app.replaceChildren(h('p', { class: 'error' }, e.message)); }
  finally { refreshNotifCount(); }
}
window.addEventListener('hashchange', route);
route();
