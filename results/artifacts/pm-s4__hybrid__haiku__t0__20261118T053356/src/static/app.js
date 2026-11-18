// pm-s4 single-page app. Uses only the public REST API.
const app = document.getElementById('app');
const state = {
  token: localStorage.getItem('pm_token'),
  me: null,
  workspaces: [],
  ws: null,          // { id, name, key, role }
  projects: [],      // projects visible in current workspace
  project: null,     // project view (members, workflow, role)
  unread: 0,
};

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(method, path, body, opts = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = opts.contentType || 'application/json';
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  const r = await fetch(path, { method, headers, body: body === undefined ? undefined : opts.contentType ? body : JSON.stringify(body) });
  if (r.status === 204) return null;
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    const err = new Error((data && data.message) || r.statusText);
    err.code = data && data.error;
    err.status = r.status;
    throw err;
  }
  return data;
}

const toast = (msg, isErr = false) => {
  const el = document.createElement('div');
  el.className = 'card-panel';
  el.style.cssText = `position:fixed;right:16px;bottom:16px;z-index:9;max-width:360px;${isErr ? 'border-left:4px solid #b00020' : 'border-left:4px solid #2f6fed'}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
};

const fail = (e) => toast(e.message || String(e), true);
const go = (hash) => { location.hash = hash; };

// ---------- bootstrap ----------
async function boot() {
  if (!state.token) return showLogin();
  try {
    state.me = (await api('GET', '/api/auth/me')).user;
  } catch {
    state.token = null;
    localStorage.removeItem('pm_token');
    return showLogin();
  }
  await loadWorkspaces();
  route();
}

async function loadWorkspaces() {
  state.workspaces = await api('GET', '/api/workspaces');
  const savedId = localStorage.getItem('pm_ws');
  state.ws = state.workspaces.find((w) => w.id === savedId) || state.workspaces[0] || null;
  await loadProjects();
}

async function loadProjects() {
  state.projects = state.ws ? await api('GET', `/api/workspaces/${state.ws.id}/projects`) : [];
  const savedP = localStorage.getItem('pm_project');
  const p = state.projects.find((x) => x.id === savedP) || state.projects[0] || null;
  state.project = p ? await api('GET', `/api/projects/${p.id}`) : null;
  if (state.project) localStorage.setItem('pm_project', state.project.id);
  if (state.ws) localStorage.setItem('pm_ws', state.ws.id);
}

// ---------- shell ----------
function showLogin(mode = 'login') {
  app.innerHTML = `
    <div class="login card-panel">
      <h2>${mode === 'login' ? 'Sign in' : 'Create account'}</h2>
      <form id="authForm">
        <input name="username" placeholder="Username" required minlength="3" autocomplete="username">
        ${mode === 'register' ? '<input name="displayName" placeholder="Display name (optional)">' : ''}
        <input name="password" type="password" placeholder="Password (min 8)" required minlength="8" autocomplete="current-password">
        <button class="primary" type="submit">${mode === 'login' ? 'Sign in' : 'Register'}</button>
        <div id="authErr" class="error"></div>
        <a href="#" id="switchMode">${mode === 'login' ? 'Need an account? Register' : 'Have an account? Sign in'}</a>
      </form>
    </div>`;
  document.getElementById('switchMode').onclick = (e) => { e.preventDefault(); showLogin(mode === 'login' ? 'register' : 'login'); };
  document.getElementById('authForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      if (mode === 'register') {
        await api('POST', '/api/auth/register', f);
      }
      const { token, user } = await api('POST', '/api/auth/login', { username: f.username, password: f.password });
      state.token = token;
      state.me = user;
      localStorage.setItem('pm_token', token);
      await loadWorkspaces();
      route();
    } catch (err) {
      document.getElementById('authErr').textContent = err.message;
    }
  };
}

function shell(content, activeTab) {
  const wsOpts = state.workspaces.map((w) => `<option value="${esc(w.id)}" ${state.ws && w.id === state.ws.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('');
  const pOpts = state.projects.map((p) => `<option value="${esc(p.id)}" ${state.project && p.id === state.project.id ? 'selected' : ''}>${esc(p.name)} (${esc(p.key)})</option>`).join('');
  const tab = (name, label) => `<a href="#/${name}" class="${activeTab === name ? 'active' : ''}">${label}</a>`;
  app.innerHTML = `
    <header>
      <span class="brand">pm-s4</span>
      <select id="wsSel">${wsOpts || '<option>No workspaces</option>'}</select>
      <select id="pSel">${pOpts || '<option>No projects</option>'}</select>
      <nav>${tab('board', 'Board')} ${tab('backlog', 'Backlog')} ${tab('sprints', 'Sprints')} ${tab('settings', 'Settings')}</nav>
      <span class="spacer"></span>
      <form id="searchForm" style="display:flex;gap:4px">
        <input id="q" placeholder='Search e.g. type:bug -label:x "login"' size="28" value="${esc(activeTab === 'search' ? state.lastQuery || '' : '')}">
      </form>
      <button id="notifBtn">🔔 <span id="unread">${state.unread || ''}</span></button>
      <button id="newWs">+ Workspace</button>
      <span>${esc(state.me.displayName)}</span>
      <button id="logout">Log out</button>
    </header>
    <main>${content}</main>
    <div id="notifPanel" class="card-panel" style="display:none;position:fixed;right:16px;top:56px;width:340px;max-height:60vh;overflow:auto;z-index:8"></div>`;
  document.getElementById('wsSel').onchange = async (e) => {
    state.ws = state.workspaces.find((w) => w.id === e.target.value);
    localStorage.removeItem('pm_project');
    await loadProjects();
    route();
  };
  document.getElementById('pSel').onchange = async (e) => {
    localStorage.setItem('pm_project', e.target.value);
    await loadProjects();
    route();
  };
  document.getElementById('searchForm').onsubmit = (e) => {
    e.preventDefault();
    go(`#/search?q=${encodeURIComponent(document.getElementById('q').value)}`);
  };
  document.getElementById('logout').onclick = async () => {
    try { await api('POST', '/api/auth/logout'); } catch { /* ignore */ }
    state.token = null;
    localStorage.removeItem('pm_token');
    showLogin();
  };
  document.getElementById('newWs').onclick = () => newWorkspaceForm();
  document.getElementById('notifBtn').onclick = toggleNotifications;
  refreshUnread();
}

function newWorkspaceForm() {
  const name = prompt('Workspace name?');
  if (!name) return;
  const key = prompt('Workspace key (2-10 uppercase letters)?');
  if (!key) return;
  api('POST', '/api/workspaces', { name, key })
    .then(async (w) => { state.workspaces.push(w); state.ws = w; localStorage.setItem('pm_ws', w.id); await loadProjects(); route(); })
    .catch(fail);
}

// ---------- notifications ----------
async function refreshUnread() {
  try {
    const list = await api('GET', '/api/notifications?unread=true');
    state.unread = list.length;
    const el = document.getElementById('unread');
    if (el) el.textContent = state.unread || '';
  } catch { /* ignore */ }
}

async function toggleNotifications() {
  const panel = document.getElementById('notifPanel');
  if (panel.style.display === 'block') { panel.style.display = 'none'; return; }
  const list = await api('GET', '/api/notifications');
  panel.innerHTML = `<h3>Notifications</h3>
    <button class="ghost" id="markAll">Mark all read</button>
    ${list.length ? '' : '<p class="muted">Nothing yet.</p>'}
    ${list.map((n) => `<div style="padding:6px 0;border-bottom:1px solid #eee;${n.read ? 'opacity:.6' : ''}">
      <a href="#/issue/${esc(n.issueKey)}">${esc(n.issueKey)}</a> <span class="badge">${esc(n.type)}</span>
      <div class="muted">${esc(new Date(n.at).toLocaleString())}</div></div>`).join('')}`;
  panel.style.display = 'block';
  document.getElementById('markAll').onclick = async () => {
    await api('POST', '/api/notifications/read', { all: true });
    await refreshUnread();
    panel.style.display = 'none';
  };
}

// ---------- router ----------
function route() {
  if (!state.token) return showLogin();
  if (!state.ws) return noWorkspace();
  const [pathPart, qs = ''] = location.hash.replace(/^#/, '').split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const params = new URLSearchParams(qs);
  const page = parts[0] || 'board';
  if (!state.project && page !== 'search') return noProject();
  if (page === 'issue' && parts[1]) return issueView(parts[1]);
  if (page === 'backlog') return backlogView();
  if (page === 'sprints') return sprintsView(parts[1]);
  if (page === 'settings') return settingsView();
  if (page === 'search') return searchView(params.get('q') || '');
  return boardView();
}

function noWorkspace() {
  shell(`<div class="card-panel"><h2>Create a workspace</h2>
    <form class="inline" id="wsForm"><input name="name" placeholder="Name" required><input name="key" placeholder="KEY" required pattern="[A-Z]{2,10}"><button class="primary">Create</button></form>
    <div id="err" class="error"></div></div>`, '');
  document.getElementById('wsForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      const w = await api('POST', '/api/workspaces', f);
      state.workspaces.push(w);
      state.ws = w;
      localStorage.setItem('pm_ws', w.id);
      await loadProjects();
      route();
    } catch (err) { document.getElementById('err').textContent = err.message; }
  };
}

function noProject() {
  const canCreate = state.ws.role !== 'guest';
  shell(`<div class="card-panel"><h2>No project yet</h2>
    ${canCreate ? `<form class="inline" id="pForm"><input name="name" placeholder="Name" required><input name="key" placeholder="KEY" required pattern="[A-Z]{2,10}"><button class="primary">Create project</button></form>` : '<p class="muted">You have no projects. Ask an admin to add you.</p>'}
    <div id="err" class="error"></div></div>`, '');
  const form = document.getElementById('pForm');
  if (form) form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      const f = Object.fromEntries(new FormData(e.target));
      const p = await api('POST', `/api/workspaces/${state.ws.id}/projects`, f);
      localStorage.setItem('pm_project', p.id);
      await loadProjects();
      route();
    } catch (err) { document.getElementById('err').textContent = err.message; }
  };
}

const canEdit = () => state.project && (state.project.role === 'lead' || state.project.role === 'developer');
const statusesOf = () => state.project.workflow.statuses;
const categoryOf = (name) => (statusesOf().find((s) => s.name === name) || {}).category;
const usernameMap = () => Object.fromEntries((state.project.members || []).map((m) => [m.userId, m.username]));

async function projectIssues(q = '') {
  return api('GET', `/api/search?project=${state.project.id}&q=${encodeURIComponent(q)}`);
}

async function wsMembers() {
  return api('GET', `/api/workspaces/${state.ws.id}/members`);
}

// ---------- board ----------
async function boardView() {
  const issues = await projectIssues('');
  const cols = statusesOf().map((s) => {
    const cards = issues.filter((i) => i.status === s.name);
    return `<div class="column" data-status="${esc(s.name)}">
      <h3>${esc(s.name)} <span class="muted">${cards.length}</span></h3>
      ${cards.map((i) => `<div class="card" draggable="true" data-key="${esc(i.key)}">
        <div class="key">${esc(i.key)} · ${esc(i.type)}</div>
        <a href="#/issue/${esc(i.key)}">${esc(i.title)}</a>
        <div><span class="badge prio-${esc(i.priority)}">${esc(i.priority)}</span>${i.storyPoints != null ? `<span class="badge">${esc(i.storyPoints)} pts</span>` : ''}
        ${i.assigneeId ? `<span class="badge">${esc(usernameMap()[i.assigneeId] || '?')}</span>` : ''}</div>
      </div>`).join('')}
    </div>`;
  }).join('');
  shell(`<h2>${esc(state.project.name)} board</h2>
    ${canEdit() ? '<form class="inline" id="newIssue"><input name="title" placeholder="New issue title" required><select name="type">' + ['task', 'bug', 'feature', 'epic'].map((t) => `<option>${t}</option>`).join('') + '</select><button class="primary">Create</button></form>' : ''}
    <div class="board">${cols}</div><div id="err" class="error"></div>`, 'board');
  const nf = document.getElementById('newIssue');
  if (nf) nf.onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try { await api('POST', `/api/projects/${state.project.id}/issues`, f); boardView(); } catch (err) { fail(err); }
  };
  document.querySelectorAll('.card').forEach((card) => {
    card.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', card.dataset.key));
  });
  document.querySelectorAll('.column').forEach((col) => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drop-over'); });
    col.addEventListener('dragleave', () => col.classList.remove('drop-over'));
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('drop-over');
      const key = e.dataTransfer.getData('text/plain');
      try {
        await api('PATCH', `/api/issues/${key}`, { status: col.dataset.status });
        boardView();
      } catch (err) {
        document.getElementById('err').textContent = `${key}: ${err.message}`;
      }
    });
  });
}

// ---------- backlog & sprint planning ----------
async function backlogView() {
  const [issues, sprints] = await Promise.all([
    projectIssues(),
    api('GET', `/api/projects/${state.project.id}/sprints`),
  ]);
  const open = sprints.filter((s) => s.state !== 'completed');
  const backlog = issues.filter((i) => !i.sprintId);
  const sprintOpts = (sel) => `<option value="">Backlog</option>` + open.map((s) => `<option value="${esc(s.id)}" ${sel === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  const row = (i) => `<tr><td>${esc(i.key)}</td><td><a href="#/issue/${esc(i.key)}">${esc(i.title)}</a></td><td>${esc(i.status)}</td><td>${i.storyPoints ?? ''}</td>
    <td>${canEdit() ? `<select data-move="${esc(i.key)}">${sprintOpts(i.sprintId)}</select>` : ''}</td></tr>`;
  const sprintBlocks = sprints.map((s) => {
    const list = issues.filter((i) => i.sprintId === s.id);
    const actions = !canEdit() ? '' : s.state === 'planned'
      ? `<button class="primary" data-start="${esc(s.id)}">Start sprint</button>`
      : s.state === 'active'
        ? `<select id="carry-${esc(s.id)}"><option value="backlog">Carry over to backlog</option>${open.filter((o) => o.id !== s.id && o.state === 'planned').map((o) => `<option value="${esc(o.id)}">${esc(o.name)}</option>`).join('')}</select>
           <button class="danger" data-complete="${esc(s.id)}">Complete sprint</button>`
        : '';
    return `<div class="card-panel"><h3>${esc(s.name)} <span class="badge">${esc(s.state)}</span>
      <span class="muted">${esc(s.startDate || '')} ${s.endDate ? '→ ' + esc(s.endDate) : ''}</span></h3>
      <div>${actions}</div>
      ${list.length ? `<table>${list.map(row).join('')}</table>` : '<p class="muted">No issues in this sprint.</p>'}
      ${s.state === 'completed' ? `<p class="muted">Carried over: ${s.carriedOver}</p>` : ''}
    </div>`;
  }).join('');
  shell(`<h2>Backlog</h2>
    ${canEdit() ? `<form class="inline" id="newSprint"><input name="name" placeholder="Sprint name" required><input name="startDate" type="date"><input name="endDate" type="date"><button class="primary">Plan sprint</button></form>` : ''}
    <div class="two-col">
      <div>${sprintBlocks || '<p class="muted">No sprints yet.</p>'}</div>
      <div class="card-panel"><h3>Backlog (${backlog.length})</h3>
        ${canEdit() ? `<form class="inline" id="newIssue"><input name="title" placeholder="New backlog item" required><input name="storyPoints" type="number" min="0" step="1" size="4" placeholder="pts"><button class="primary">Add</button></form>` : ''}
        <table>${backlog.map(row).join('') || '<tr><td class="muted">Empty</td></tr>'}</table>
      </div>
    </div><div id="err" class="error"></div>`, 'backlog');
  const ns = document.getElementById('newSprint');
  if (ns) ns.onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (!f.startDate) delete f.startDate;
    if (!f.endDate) delete f.endDate;
    try { await api('POST', `/api/projects/${state.project.id}/sprints`, f); backlogView(); } catch (err) { fail(err); }
  };
  const ni = document.getElementById('newIssue');
  if (ni) ni.onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const body = { title: f.title };
    if (f.storyPoints !== '') body.storyPoints = Number(f.storyPoints);
    try { await api('POST', `/api/projects/${state.project.id}/issues`, body); backlogView(); } catch (err) { fail(err); }
  };
  document.querySelectorAll('[data-move]').forEach((sel) => sel.onchange = async () => {
    try { await api('PATCH', `/api/issues/${sel.dataset.move}`, { sprintId: sel.value || null }); backlogView(); } catch (err) { fail(err); }
  });
  document.querySelectorAll('[data-start]').forEach((b) => b.onclick = async () => {
    try { await api('POST', `/api/sprints/${b.dataset.start}/start`); backlogView(); } catch (err) { fail(err); }
  });
  document.querySelectorAll('[data-complete]').forEach((b) => b.onclick = async () => {
    const id = b.dataset.complete;
    try {
      await api('POST', `/api/sprints/${id}/complete`, { carryOverTo: document.getElementById(`carry-${id}`).value });
      backlogView();
    } catch (err) { fail(err); }
  });
}

// ---------- sprint report ----------
async function sprintsView(sprintId) {
  const sprints = await api('GET', `/api/projects/${state.project.id}/sprints`);
  const chosen = sprints.find((s) => s.id === sprintId) || sprints.find((s) => s.state === 'active') || sprints.find((s) => s.state === 'completed') || sprints[0];
  const picker = `<select id="sprintPick">${sprints.map((s) => `<option value="${esc(s.id)}" ${chosen && chosen.id === s.id ? 'selected' : ''}>${esc(s.name)} (${esc(s.state)})</option>`).join('')}</select>`;
  let body = '<p class="muted">No sprints yet.</p>';
  if (chosen) {
    const r = await api('GET', `/api/sprints/${chosen.id}/report`);
    body = `<div class="card-panel">
      <p>Committed: <b>${r.committedPoints}</b> pts · Completed: <b>${r.completedPoints}</b> pts · Issues done: <b>${r.completedIssues}</b> · Carried over: <b>${r.carriedOver}</b></p>
      ${burndownSvg(r.burndown)}
    </div>`;
  }
  shell(`<h2>Sprint report</h2>${picker}${body}`, 'sprints');
  document.getElementById('sprintPick').onchange = (e) => go(`#/sprints/${e.target.value}`);
}

function burndownSvg(points) {
  if (!points.length) return '<p class="muted">No burndown data yet.</p>';
  const W = 640, H = 260, P = 36;
  const max = Math.max(1, ...points.map((p) => p.remainingPoints));
  const x = (i) => P + (points.length === 1 ? 0 : (i * (W - 2 * P)) / (points.length - 1));
  const y = (v) => H - P - (v * (H - 2 * P)) / max;
  const path = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.remainingPoints).toFixed(1)}`).join(' ');
  const labels = points.map((p, i) => `<text x="${x(i).toFixed(1)}" y="${H - 12}" font-size="10" text-anchor="middle">${esc(p.date.slice(5))}</text>`).join('');
  const dots = points.map((p, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(p.remainingPoints).toFixed(1)}" r="3" fill="#2f6fed"><title>${esc(p.date)}: ${p.remainingPoints} pts</title></circle>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Burndown chart">
    <line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" stroke="#999"/>
    <line x1="${P}" y1="${P}" x2="${P}" y2="${H - P}" stroke="#999"/>
    <text x="${P - 6}" y="${P}" font-size="10" text-anchor="end">${max}</text>
    <text x="${P - 6}" y="${H - P}" font-size="10" text-anchor="end">0</text>
    <path d="${path}" fill="none" stroke="#2f6fed" stroke-width="2"/>${dots}${labels}</svg>`;
}

// ---------- issue detail ----------
async function issueView(key) {
  const [issue, comments, history] = await Promise.all([
    api('GET', `/api/issues/${encodeURIComponent(key)}`),
    api('GET', `/api/issues/${encodeURIComponent(key)}/comments`),
    api('GET', `/api/issues/${encodeURIComponent(key)}/history`),
  ]);
  const names = usernameMap();
  const editable = canEdit();
  const isWatching = issue.watchers.includes(state.me.id);
  const statusSel = `<select id="fStatus" ${editable ? '' : 'disabled'}>${statusesOf().map((s) => `<option ${s.name === issue.status ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>`;
  const assigneeSel = `<select id="fAssignee" ${editable ? '' : 'disabled'}><option value="">Unassigned</option>${(state.project.members || []).map((m) => `<option value="${esc(m.userId)}" ${issue.assigneeId === m.userId ? 'selected' : ''}>${esc(m.username)}</option>`).join('')}</select>`;
  const prioSel = `<select id="fPrio" ${editable ? '' : 'disabled'}>${['urgent', 'high', 'medium', 'low', 'none'].map((p) => `<option ${p === issue.priority ? 'selected' : ''}>${p}</option>`).join('')}</select>`;
  const progress = issue.progress ? `<p>Epic progress: ${issue.progress.done}/${issue.progress.total} issues · ${issue.progress.points_done}/${issue.progress.points_total} pts</p>` : '';
  shell(`
    <div class="two-col">
      <div>
        <div class="card-panel">
          <div class="key muted">${esc(issue.key)} · ${esc(issue.type)}</div>
          <h2 id="title" ${editable ? 'contenteditable="true"' : ''}>${esc(issue.title)}</h2>
          <p>${esc(issue.description || '')}</p>
          ${progress}
          <h3>Subtasks</h3>
          <div>${issue.children.map((k) => `<a href="#/issue/${esc(k)}">${esc(k)}</a>`).join(', ') || '<span class="muted">none</span>'}</div>
          ${editable && issue.type === 'subtask' ? '' : ''}
          ${editable && issue.type !== 'subtask' ? `<form class="inline" id="subForm"><input name="title" placeholder="New subtask" required><button class="ghost">Add subtask</button></form>` : ''}
        </div>
        <div class="card-panel"><h3>Comments</h3>
          ${comments.map((c) => `<div style="padding:6px 0;border-bottom:1px solid #eee">
            <b>${esc(names[c.authorId] || c.authorId)}</b> <span class="muted">${esc(new Date(c.createdAt).toLocaleString())}${c.edited ? ' · edited' : ''}</span>
            <div>${esc(c.body)}</div>
            ${c.authorId === state.me.id ? `<button class="ghost" data-edit="${esc(c.id)}">Edit</button>` : ''}
          </div>`).join('') || '<p class="muted">No comments.</p>'}
          <form class="inline" id="commentForm"><textarea name="body" placeholder="Write a comment, @mention users" required></textarea><button class="primary">Comment</button></form>
        </div>
      </div>
      <div>
        <div class="card-panel">
          <p>Status: ${statusSel}</p>
          <p>Assignee: ${assigneeSel}</p>
          <p>Priority: ${prioSel}</p>
          <p>Story points: <input id="fPoints" type="number" min="0" value="${issue.storyPoints ?? ''}" ${editable ? '' : 'disabled'} size="4"></p>
          <p>Due: <input id="fDue" type="date" value="${esc(issue.dueDate || '')}" ${editable ? '' : 'disabled'}></p>
          <p>Labels: <input id="fLabels" value="${esc(issue.labels.join(', '))}" ${editable ? '' : 'disabled'}></p>
          <button class="ghost" id="watchBtn">${isWatching ? 'Unwatch' : 'Watch'}</button>
          ${editable ? '<button class="primary" id="saveBtn">Save</button>' : ''}
          ${editable ? '<button class="danger" id="delBtn">Delete</button>' : ''}
        </div>
        <div class="card-panel"><h3>Links</h3>
          ${issue.links.map((l) => `<div>${esc(l.type)} <a href="#/issue/${esc(l.target)}">${esc(l.target)}</a></div>`).join('') || '<span class="muted">none</span>'}
          ${editable ? `<form class="inline" id="linkForm"><select name="type"><option>blocks</option><option>relates</option><option>duplicates</option></select><input name="target" placeholder="KEY-n" required size="8"><button class="ghost">Link</button></form>` : ''}
        </div>
        <div class="card-panel"><h3>History</h3>
          <table>${history.map((h) => `<tr><td class="muted">${esc(new Date(h.at).toLocaleString())}</td><td>${esc(h.field)}: ${esc(h.from ?? '∅')} → ${esc(h.to ?? '∅')}</td></tr>`).join('') || '<tr><td class="muted">No changes.</td></tr>'}</table>
        </div>
      </div>
    </div>`, 'issue');

  const patch = async (body) => {
    try { await api('PATCH', `/api/issues/${key}`, body); issueView(key); } catch (err) { fail(err); }
  };
  if (editable) {
    document.getElementById('fStatus').onchange = (e) => patch({ status: e.target.value });
    document.getElementById('fAssignee').onchange = (e) => patch({ assigneeId: e.target.value || null });
    document.getElementById('fPrio').onchange = (e) => patch({ priority: e.target.value });
    document.getElementById('saveBtn').onclick = () => patch({
      title: document.getElementById('title').textContent.trim(),
      storyPoints: document.getElementById('fPoints').value === '' ? null : Number(document.getElementById('fPoints').value),
      dueDate: document.getElementById('fDue').value || null,
      labels: document.getElementById('fLabels').value.split(',').map((s) => s.trim()).filter(Boolean),
    });
    document.getElementById('delBtn').onclick = async () => {
      if (!confirm(`Delete ${key}?`)) return;
      try { await api('DELETE', `/api/issues/${key}`); go('#/board'); } catch (err) { fail(err); }
    };
    const sf = document.getElementById('subForm');
    if (sf) sf.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('POST', `/api/projects/${state.project.id}/issues`, { type: 'subtask', title: new FormData(e.target).get('title'), parentId: issue.id });
        issueView(key);
      } catch (err) { fail(err); }
    };
    document.getElementById('linkForm').onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      try { await api('POST', `/api/issues/${key}/links`, f); issueView(key); } catch (err) { fail(err); }
    };
  }
  document.getElementById('watchBtn').onclick = async () => {
    try { await api(isWatching ? 'DELETE' : 'POST', `/api/issues/${key}/watch`); issueView(key); } catch (err) { fail(err); }
  };
  document.getElementById('commentForm').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('POST', `/api/issues/${key}/comments`, { body: new FormData(e.target).get('body') }); issueView(key); } catch (err) { fail(err); }
  };
  document.querySelectorAll('[data-edit]').forEach((b) => b.onclick = async () => {
    const current = comments.find((c) => c.id === b.dataset.edit);
    const body = prompt('Edit comment', current.body);
    if (body === null) return;
    try { await api('PATCH', `/api/comments/${current.id}`, { body }); issueView(key); } catch (err) { fail(err); }
  });
}

// ---------- search ----------
async function searchView(q) {
  state.lastQuery = q;
  let results = [];
  let err = '';
  try {
    results = await api('GET', `/api/search?q=${encodeURIComponent(q)}&sort=updated`);
  } catch (e) { err = e.message; }
  const names = usernameMap();
  shell(`<h2>Search</h2>
    <p class="muted">Terms: status:"In Progress" type:bug priority:high assignee:me|name|none label:x sprint:active|id|none is:open|resolved due:&lt;2026-01-01 points:&gt;3 key:ABC-1 -label:x "exact phrase"</p>
    <div class="error">${esc(err)}</div>
    <table><tr><th>Key</th><th>Title</th><th>Status</th><th>Priority</th><th>Assignee</th><th>Pts</th></tr>
    ${results.map((i) => `<tr><td><a href="#/issue/${esc(i.key)}">${esc(i.key)}</a></td><td>${esc(i.title)}</td><td>${esc(i.status)}</td><td>${esc(i.priority)}</td><td>${esc(names[i.assigneeId] || '')}</td><td>${i.storyPoints ?? ''}</td></tr>`).join('')}
    </table>`, 'search');
}

// ---------- settings ----------
async function settingsView() {
  if (state.project.role !== 'lead') {
    shell('<p class="error">Project settings require the lead role.</p>', 'settings');
    return;
  }
  const hooks = await api('GET', `/api/projects/${state.project.id}/webhooks`);
  const deliveries = await Promise.all(hooks.map(async (h) => ({ h, d: await api('GET', `/api/webhooks/${h.id}/deliveries`) })));
  const wf = { statuses: state.project.workflow.statuses, transitions: state.project.workflow.transitions };
  shell(`<h2>Project settings · ${esc(state.project.name)} (${esc(state.project.key)})</h2>
    <div class="two-col">
      <div>
        <div class="card-panel"><h3>Members</h3>
          <table>${state.project.members.map((m) => `<tr><td>${esc(m.username)}</td>
            <td><select data-role="${esc(m.userId)}">${['lead', 'developer', 'viewer'].map((r) => `<option ${r === m.role ? 'selected' : ''}>${r}</option>`).join('')}</select></td>
            <td><button class="danger" data-remove="${esc(m.userId)}">Remove</button></td></tr>`).join('')}</table>
          <form class="inline" id="addMember"><input name="username" placeholder="username" required><select name="role"><option>developer</option><option>lead</option><option>viewer</option></select><button class="primary">Add</button></form>
        </div>
        <div class="card-panel"><h3>Webhooks</h3>
          ${deliveries.map(({ h, d }) => `<div style="border-bottom:1px solid #eee;padding:6px 0"><b>${esc(h.url)}</b> <span class="muted">${esc(h.events.join(', '))}</span>
            <button class="danger" data-hook="${esc(h.id)}">Delete</button>
            <div class="muted">${d.slice(0, 5).map((x) => `${esc(x.event)} → ${x.status ?? 'error'} (${x.attempts} attempt${x.attempts === 1 ? '' : 's'}${x.lastError ? ', ' + esc(x.lastError) : ''})`).join('<br>') || 'No deliveries yet'}</div></div>`).join('') || '<p class="muted">No webhooks.</p>'}
          <form class="inline" id="hookForm"><input name="url" placeholder="https://…" required size="28"><input name="secret" placeholder="secret" required size="10">
            <select name="events" multiple size="3"><option selected>issue.created</option><option selected>issue.updated</option><option>issue.deleted</option><option selected>comment.created</option></select><button class="primary">Add</button></form>
        </div>
      </div>
      <div class="card-panel"><h3>Workflow</h3>
        <p class="muted">Edit statuses (name + category: backlog|unstarted|started|completed), transitions as [from,to] pairs, and a remap for in-use statuses being removed.</p>
        <textarea id="wfText">${esc(JSON.stringify({ ...wf, remap: {} }, null, 2))}</textarea>
        <button class="primary" id="saveWf">Save workflow</button>
      </div>
    </div><div id="err" class="error"></div>`, 'settings');

  document.querySelectorAll('[data-role]').forEach((sel) => sel.onchange = async () => {
    try { await api('PATCH', `/api/projects/${state.project.id}/members/${sel.dataset.role}`, { role: sel.value }); await loadProjects(); settingsView(); } catch (err) { fail(err); }
  });
  document.querySelectorAll('[data-remove]').forEach((b) => b.onclick = async () => {
    try { await api('DELETE', `/api/projects/${state.project.id}/members/${b.dataset.remove}`); await loadProjects(); settingsView(); } catch (err) { fail(err); }
  });
  document.getElementById('addMember').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('POST', `/api/projects/${state.project.id}/members`, Object.fromEntries(new FormData(e.target))); await loadProjects(); settingsView(); } catch (err) { fail(err); }
  };
  document.querySelectorAll('[data-hook]').forEach((b) => b.onclick = async () => {
    try { await api('DELETE', `/api/webhooks/${b.dataset.hook}`); settingsView(); } catch (err) { fail(err); }
  });
  document.getElementById('hookForm').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const events = [...e.target.events.selectedOptions].map((o) => o.value);
    try {
      await api('POST', `/api/projects/${state.project.id}/webhooks`, { url: fd.get('url'), secret: fd.get('secret'), events });
      settingsView();
    } catch (err) { fail(err); }
  };
  document.getElementById('saveWf').onclick = async () => {
    try {
      const body = JSON.parse(document.getElementById('wfText').value);
      await api('PUT', `/api/projects/${state.project.id}/workflow`, body);
      await loadProjects();
      settingsView();
    } catch (err) { document.getElementById('err').textContent = err.message; }
  };
}

// ---------- start ----------
window.addEventListener('hashchange', () => { if (state.token && state.me) route(); });
setInterval(() => { if (state.token && state.me) refreshUnread(); }, 30000);
boot();
