// pm-s4 single-page app. Talks only to the public JSON API.
const app = document.getElementById('app');
const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'];
const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const CATEGORIES = ['backlog', 'unstarted', 'started', 'completed'];

const S = {
  token: localStorage.getItem('pm_token'),
  me: null,
  workspaces: [],
  ws: null,
  projects: [],
  project: null,
  wsMembers: [],
  notifications: [],
  notifOpen: false,
};

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, el = document) => el.querySelector(sel);

async function api(method, path, body, { text, raw } = {}) {
  const headers = {};
  if (S.token) headers.authorization = `Bearer ${S.token}`;
  let payload;
  if (text !== undefined) {
    headers['content-type'] = 'text/csv';
    payload = text;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers, body: payload });
  if (res.status === 401 && S.token) {
    S.token = null;
    localStorage.removeItem('pm_token');
    showAuth('Session expired, please log in again.');
    throw new Error('unauthenticated');
  }
  if (raw) return res;
  if (res.status === 204) return null;
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error((data && data.message) || res.statusText);
    err.code = data && data.error;
    err.status = res.status;
    throw err;
  }
  return data;
}

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString() : '');
const memberName = (id) => {
  const m = S.wsMembers.find((x) => x.userId === id);
  return m ? m.username : (id ? id.slice(0, 6) : 'unassigned');
};
const statusCat = (name) => (S.project.workflow.statuses.find((s) => s.name === name) || {}).category;

function showError(container, err) {
  const el = container.querySelector('.msg') || container.appendChild(Object.assign(document.createElement('div'), { className: 'msg error' }));
  el.textContent = err.message;
}

function toast(msg) {
  alert(msg);
}

// ---------------- auth ----------------
function showAuth(note = '') {
  app.innerHTML = `
    <div class="auth panel">
      <h2>pm-s4</h2>
      <p class="muted">${esc(note)}</p>
      <form id="login">
        <h3>Log in</h3>
        <input name="username" placeholder="Username" required>
        <input name="password" type="password" placeholder="Password" required>
        <button class="primary">Log in</button>
        <div class="error" id="login-err"></div>
      </form>
      <hr>
      <form id="register">
        <h3>Register</h3>
        <input name="username" placeholder="Username (3-32 chars)" required>
        <input name="displayName" placeholder="Display name (optional)">
        <input name="password" type="password" placeholder="Password (min 8 chars)" required>
        <button>Create account</button>
        <div class="error" id="reg-err"></div>
      </form>
    </div>`;
  $('#login').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const r = await api('POST', '/api/auth/login', { username: f.get('username'), password: f.get('password') });
      S.token = r.token;
      localStorage.setItem('pm_token', r.token);
      boot();
    } catch (err) {
      $('#login-err').textContent = err.message;
    }
  };
  $('#register').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('POST', '/api/auth/register', {
        username: f.get('username'), password: f.get('password'), displayName: f.get('displayName') || undefined,
      });
      const r = await api('POST', '/api/auth/login', { username: f.get('username'), password: f.get('password') });
      S.token = r.token;
      localStorage.setItem('pm_token', r.token);
      boot();
    } catch (err) {
      $('#reg-err').textContent = err.message;
    }
  };
}

// ---------------- context loading ----------------
async function loadWorkspaces() {
  S.workspaces = await api('GET', '/api/workspaces');
  const savedWs = localStorage.getItem('pm_ws');
  S.ws = S.workspaces.find((w) => w.id === savedWs) || S.workspaces[0] || null;
}

async function loadWorkspaceContext() {
  S.projects = [];
  S.project = null;
  S.wsMembers = [];
  if (!S.ws) return;
  localStorage.setItem('pm_ws', S.ws.id);
  S.wsMembers = await api('GET', `/api/workspaces/${S.ws.id}/members`);
  S.projects = await api('GET', `/api/workspaces/${S.ws.id}/projects`);
  const savedProj = localStorage.getItem('pm_proj');
  S.project = S.projects.find((p) => p.id === savedProj) || S.projects[0] || null;
  if (S.project) await refreshProject();
}

async function refreshProject() {
  if (!S.project) return;
  localStorage.setItem('pm_proj', S.project.id);
  S.project = await api('GET', `/api/projects/${S.project.id}`);
}

async function loadNotifications() {
  try {
    S.notifications = await api('GET', '/api/notifications');
  } catch {
    S.notifications = [];
  }
}

async function boot() {
  if (!S.token) return showAuth();
  try {
    S.me = (await api('GET', '/api/auth/me')).user;
  } catch {
    return showAuth();
  }
  await loadWorkspaces();
  await loadWorkspaceContext();
  await loadNotifications();
  if (!location.hash) location.hash = '#/board';
  render();
}

// ---------------- shell ----------------
function shell(content, active) {
  const wsOpts = S.workspaces.map((w) => `<option value="${w.id}" ${S.ws && w.id === S.ws.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('');
  const projOpts = S.projects.map((p) => `<option value="${p.id}" ${S.project && p.id === S.project.id ? 'selected' : ''}>${esc(p.key)} · ${esc(p.name)}</option>`).join('');
  const unread = S.notifications.filter((n) => !n.read).length;
  const nav = [['board', 'Board'], ['backlog', 'Backlog'], ['sprints', 'Sprints'], ['search', 'Search'], ['settings', 'Settings']]
    .map(([k, label]) => `<a href="#/${k}" class="${active === k ? 'active' : ''}">${label}</a>`).join('');
  app.innerHTML = `
    <header class="top">
      <span class="brand">pm-s4</span>
      <select id="ws-switch" aria-label="Workspace">${wsOpts || '<option>No workspace</option>'}</select>
      <select id="proj-switch" aria-label="Project">${projOpts || '<option>No project</option>'}</select>
      <nav>${S.project ? nav : ''}</nav>
      <div class="right">
        <button id="new-ws" title="Create workspace">+ Workspace</button>
        <button id="notif-btn">🔔 ${unread ? `<b>${unread}</b>` : ''}</button>
        <span>${esc(S.me.displayName)}</span>
        <button id="logout">Log out</button>
      </div>
    </header>
    <main>${content}</main>
    <div id="notif-panel"></div>`;
  $('#ws-switch').onchange = async (e) => {
    S.ws = S.workspaces.find((w) => w.id === e.target.value);
    await loadWorkspaceContext();
    render();
  };
  $('#proj-switch').onchange = async (e) => {
    S.project = S.projects.find((p) => p.id === e.target.value);
    await refreshProject();
    render();
  };
  $('#new-ws').onclick = async () => {
    const name = prompt('Workspace name?');
    if (!name) return;
    const key = prompt('Workspace key (2-10 uppercase letters)?');
    if (!key) return;
    try {
      const w = await api('POST', '/api/workspaces', { name, key });
      await loadWorkspaces();
      S.ws = S.workspaces.find((x) => x.id === w.id);
      await loadWorkspaceContext();
      render();
    } catch (err) { toast(err.message); }
  };
  $('#logout').onclick = async () => {
    try { await api('POST', '/api/auth/logout'); } catch { /* ignore */ }
    S.token = null;
    localStorage.removeItem('pm_token');
    showAuth('Logged out.');
  };
  $('#notif-btn').onclick = async () => {
    S.notifOpen = !S.notifOpen;
    await loadNotifications();
    renderNotifications();
  };
  renderNotifications();
}

function renderNotifications() {
  const panel = $('#notif-panel');
  if (!panel) return;
  if (!S.notifOpen) { panel.innerHTML = ''; return; }
  const items = S.notifications.slice(0, 50).map((n) => `
      <div class="item ${n.read ? '' : 'unread'}">
        <a href="#/issue/${esc(n.issueKey)}">${esc(n.issueKey)}</a> · ${esc(n.type)}
        <div class="muted">${esc(fmtDate(n.at))}</div>
      </div>`).join('') || '<p class="muted">No notifications.</p>';
  panel.innerHTML = `<div class="notif"><div class="row"><b class="grow">Notifications</b>
    <button id="mark-all">Mark all read</button></div>${items}</div>`;
  $('#mark-all').onclick = async () => {
    await api('POST', '/api/notifications/read', { all: true });
    await loadNotifications();
    renderNotifications();
  };
}

function needProject() {
  return '<div class="panel">Create or join a project to get started. Use the workspace controls above.</div>';
}

// ---------------- router ----------------
async function render() {
  const hash = location.hash || '#/board';
  const [, view, arg] = hash.split('/');
  try {
    if (!S.ws) {
      shell(`<div class="panel"><p>You have no workspace yet. Click <b>+ Workspace</b> to create one.</p></div>`, '');
      return;
    }
    if (!S.project) {
      shell(needProject() + `<div class="panel"><h3>New project</h3>${projectForm()}</div>`, view);
      bindProjectForm();
      return;
    }
    if (view === 'issue') return await viewIssue(arg);
    if (view === 'backlog') return await viewBacklog();
    if (view === 'sprints') return await viewSprints();
    if (view === 'search') return await viewSearch();
    if (view === 'settings') return await viewSettings();
    return await viewBoard();
  } catch (err) {
    if (err.message === 'unauthenticated') return;
    shell(`<div class="panel error">${esc(err.message)}</div>`, view);
  }
}
window.addEventListener('hashchange', () => render());

// ---------------- board ----------------
async function viewBoard() {
  const issues = await api('GET', `/api/projects/${S.project.id}/issues`);
  const statuses = S.project.workflow.statuses;
  const cols = statuses.map((s) => {
    const cards = issues.filter((i) => i.status === s.name).map(cardHtml).join('');
    return `<div class="col" data-status="${esc(s.name)}">
      <h3>${esc(s.name)} <span class="muted">${issues.filter((i) => i.status === s.name).length}</span></h3>${cards}</div>`;
  }).join('');
  shell(`
    <div class="row"><h2 class="grow">${esc(S.project.name)} board</h2>
      <a class="pill" href="#/backlog">+ create issue in backlog</a></div>
    <div class="board" id="board">${cols}</div>`, 'board');
  const board = $('#board');
  board.querySelectorAll('.card').forEach((card) => {
    card.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', card.dataset.key));
    card.addEventListener('click', () => { location.hash = `#/issue/${card.dataset.key}`; });
  });
  board.querySelectorAll('.col').forEach((col) => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('over'); });
    col.addEventListener('dragleave', () => col.classList.remove('over'));
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('over');
      const key = e.dataTransfer.getData('text/plain');
      if (!key) return;
      try {
        await api('PATCH', `/api/issues/${key}`, { status: col.dataset.status });
      } catch (err) {
        toast(err.message);
      }
      render();
    });
  });
}

function cardHtml(i) {
  return `<div class="card" draggable="true" data-key="${esc(i.key)}">
    <div class="key">${esc(i.key)} · ${esc(i.type)}</div>
    <div class="title">${esc(i.title)}</div>
    <span class="pill prio-${esc(i.priority)}">${esc(i.priority)}</span>
    ${i.storyPoints != null ? `<span class="pill">${esc(i.storyPoints)} pts</span>` : ''}
    <span class="pill">${esc(memberName(i.assigneeId))}</span>
  </div>`;
}

// ---------------- backlog & sprints planning ----------------
async function viewBacklog() {
  const [issues, sprints] = await Promise.all([
    api('GET', `/api/projects/${S.project.id}/issues`),
    api('GET', `/api/projects/${S.project.id}/sprints`),
  ]);
  const open = sprints.filter((s) => s.state !== 'completed');
  const sprintOpts = (selected) => ['<option value="">Backlog</option>']
    .concat(open.map((s) => `<option value="${s.id}" ${selected === s.id ? 'selected' : ''}>${esc(s.name)}</option>`)).join('');
  const issueRow = (i) => `<tr>
      <td><a class="key" href="#/issue/${esc(i.key)}">${esc(i.key)}</a></td>
      <td>${esc(i.title)}</td><td>${esc(i.status)}</td><td>${esc(i.priority)}</td>
      <td>${i.storyPoints ?? ''}</td>
      <td><select data-move="${esc(i.key)}">${sprintOpts(i.sprintId)}</select></td></tr>`;
  const notDone = (i) => statusCat(i.status) !== 'completed';
  const sprintBlocks = sprints.filter((s) => s.state !== 'completed').map((s) => {
    const items = issues.filter((i) => i.sprintId === s.id);
    const actions = s.state === 'planned'
      ? `<button data-sprint-start="${s.id}" class="primary">Start sprint</button>`
      : `<select id="carry-${s.id}"><option value="backlog">Carry unfinished to backlog</option>${open.filter((o) => o.id !== s.id && o.state === 'planned').map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}</select>
         <button data-sprint-complete="${s.id}">Complete sprint</button>`;
    return `<div class="panel"><div class="row"><b class="grow">${esc(s.name)} <span class="pill">${esc(s.state)}</span></b>${actions}</div>
      <table><tbody>${items.map(issueRow).join('') || '<tr><td class="muted">No issues planned.</td></tr>'}</tbody></table></div>`;
  }).join('');
  const backlog = issues.filter((i) => !i.sprintId && notDone(i));
  shell(`
    <div class="panel"><h3>Create issue</h3>${issueForm()}</div>
    <div class="panel"><div class="row"><h3 class="grow">Sprints</h3></div>
      <form id="sprint-form" class="row"><input name="name" placeholder="Sprint name" required>
      <input name="startDate" type="date"><input name="endDate" type="date">
      <button>Create sprint</button></form><div class="error" id="sprint-err"></div></div>
    ${sprintBlocks}
    <div class="panel"><h3>Backlog</h3><table><thead><tr><th>Key</th><th>Title</th><th>Status</th><th>Priority</th><th>Pts</th><th>Sprint</th></tr></thead>
      <tbody>${backlog.map(issueRow).join('') || '<tr><td class="muted">Backlog is empty.</td></tr>'}</tbody></table></div>`, 'backlog');
  bindIssueForm(() => render());
  $('#sprint-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = { name: f.get('name') };
    if (f.get('startDate')) body.startDate = f.get('startDate');
    if (f.get('endDate')) body.endDate = f.get('endDate');
    try { await api('POST', `/api/projects/${S.project.id}/sprints`, body); render(); } catch (err) { $('#sprint-err').textContent = err.message; }
  };
  document.querySelectorAll('[data-move]').forEach((sel) => {
    sel.onchange = async () => {
      try { await api('PATCH', `/api/issues/${sel.dataset.move}`, { sprintId: sel.value || null }); render(); } catch (err) { toast(err.message); }
    };
  });
  document.querySelectorAll('[data-sprint-start]').forEach((b) => {
    b.onclick = async () => { try { await api('POST', `/api/sprints/${b.dataset.sprintStart}/start`); render(); } catch (err) { toast(err.message); } };
  });
  document.querySelectorAll('[data-sprint-complete]').forEach((b) => {
    b.onclick = async () => {
      const carry = $(`#carry-${b.dataset.sprintComplete}`).value;
      try {
        await api('POST', `/api/sprints/${b.dataset.sprintComplete}/complete`, { carryOverTo: carry === 'backlog' ? 'backlog' : carry });
        render();
      } catch (err) { toast(err.message); }
    };
  });
}

function issueForm() {
  return `<form id="issue-form" class="grid2">
    <label>Title<input name="title" required></label>
    <label>Type<select name="type">${TYPES.map((t) => `<option ${t === 'task' ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    <label>Priority<select name="priority">${PRIORITIES.map((p) => `<option ${p === 'none' ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
    <label>Story points<input name="storyPoints" type="number" min="0" step="any"></label>
    <label>Description<textarea name="description"></textarea></label>
    <div><button class="primary">Create</button> <span class="error" id="issue-err"></span></div>
  </form>`;
}

function bindIssueForm(after) {
  const form = $('#issue-form');
  if (!form) return;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    const body = { title: f.get('title'), type: f.get('type'), priority: f.get('priority'), description: f.get('description') || null };
    if (f.get('storyPoints') !== '') body.storyPoints = Number(f.get('storyPoints'));
    try {
      await api('POST', `/api/projects/${S.project.id}/issues`, body);
      after();
    } catch (err) {
      $('#issue-err').textContent = err.message;
    }
  };
}

// ---------------- issue detail ----------------
async function viewIssue(key) {
  const [i, history, comments] = await Promise.all([
    api('GET', `/api/issues/${key}`),
    api('GET', `/api/issues/${key}/history`),
    api('GET', `/api/issues/${key}/comments`),
  ]);
  const sprints = await api('GET', `/api/projects/${S.project.id}/sprints`);
  const issues = await api('GET', `/api/projects/${S.project.id}/issues`);
  const epics = issues.filter((x) => x.type === 'epic');
  const statuses = S.project.workflow.statuses;
  const watching = i.watchers.includes(S.me.id);
  const sel = (name, opts, cur) => `<select name="${name}">${opts.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(cur ?? '') ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
  const progress = i.progress ? `<div class="panel"><b>Epic progress</b>
      <div>${i.progress.done}/${i.progress.total} issues · ${i.progress.points_done}/${i.progress.points_total} pts</div>
      <div class="progress"><div style="width:${i.progress.total ? Math.round(100 * i.progress.done / i.progress.total) : 0}%"></div></div></div>` : '';
  const linkRows = i.links.map((l) => `<li>${esc(l.type)} <a href="#/issue/${esc(l.target)}">${esc(l.target)}</a>
      <button class="linklike" data-unlink="${esc(l.id)}">remove</button></li>`).join('') || '<li class="muted">No links.</li>';
  const children = i.children.map((k) => `<li><a href="#/issue/${esc(k)}">${esc(k)}</a></li>`).join('') || '<li class="muted">No subtasks.</li>';
  const commentsHtml = comments.map((c) => `<div class="comment">
      <div class="meta">${esc(memberName(c.authorId))} · ${esc(fmtDate(c.createdAt))} ${c.edited ? '(edited)' : ''}
        ${c.authorId === S.me.id ? `<button class="linklike" data-edit-comment="${esc(c.id)}">edit</button>` : ''}</div>
      <div>${esc(c.body)}</div></div>`).join('') || '<p class="muted">No comments yet.</p>';
  const historyHtml = history.slice().reverse().map((h) => `<li class="muted">${esc(fmtDate(h.at))} · ${esc(memberName(h.actorId))}: ${esc(h.field)} ${esc(h.from ?? '∅')} → ${esc(h.to ?? '∅')}</li>`).join('') || '<li class="muted">No changes yet.</li>';

  shell(`
    <p><a href="#/board">← Back</a></p>
    <div class="panel">
      <div class="row"><span class="muted">${esc(i.key)} · ${esc(i.type)}</span><span class="grow"></span>
        <button id="watch">${watching ? 'Unwatch' : 'Watch'}</button>
        <button id="delete-issue" class="danger">Delete</button></div>
      <form id="edit-form" class="grid2">
        <label>Title<input name="title" value="${esc(i.title)}"></label>
        <label>Status ${sel('status', statuses.map((s) => [s.name, s.name]), i.status)}</label>
        <label>Type ${sel('type', TYPES.map((t) => [t, t]), i.type)}</label>
        <label>Priority ${sel('priority', PRIORITIES.map((p) => [p, p]), i.priority)}</label>
        <label>Assignee ${sel('assigneeId', [['', 'Unassigned']].concat(S.project.members.map((m) => [m.userId, m.username])), i.assigneeId)}</label>
        <label>Story points<input name="storyPoints" type="number" min="0" step="any" value="${esc(i.storyPoints ?? '')}"></label>
        <label>Labels (comma separated)<input name="labels" value="${esc(i.labels.join(', '))}"></label>
        <label>Due date<input name="dueDate" type="date" value="${esc(i.dueDate || '')}"></label>
        <label>Sprint ${sel('sprintId', [['', 'Backlog']].concat(sprints.filter((s) => s.state !== 'completed').map((s) => [s.id, s.name])), i.sprintId)}</label>
        <label>Epic ${sel('epicId', [['', 'No epic']].concat(epics.filter((x) => x.id !== i.id).map((x) => [x.id, x.key])), i.epicId)}</label>
        <label style="grid-column: span 2">Description<textarea name="description">${esc(i.description || '')}</textarea></label>
        <div style="grid-column: span 2"><button class="primary">Save</button> <span class="error" id="edit-err"></span></div>
      </form>
    </div>
    ${progress}
    <div class="grid2">
      <div class="panel"><h3>Subtasks</h3><ul>${children}</ul>
        ${i.type !== 'epic' && i.type !== 'subtask' ? `<form id="sub-form" class="row"><input name="title" placeholder="Subtask title" required><button>Add subtask</button></form>` : ''}</div>
      <div class="panel"><h3>Links</h3><ul>${linkRows}</ul>
        <form id="link-form" class="row">${sel('type', [['blocks', 'blocks'], ['relates', 'relates'], ['duplicates', 'duplicates']], 'blocks')}
        <input name="target" placeholder="Target key e.g. WEB-3" required><button>Link</button></form>
        <div class="error" id="link-err"></div></div>
    </div>
    <div class="grid2">
      <div class="panel"><h3>Comments</h3>${commentsHtml}
        <form id="comment-form"><textarea name="body" placeholder="Write a comment. Mention with @username"></textarea>
        <button class="primary">Comment</button></form><div class="error" id="comment-err"></div></div>
      <div class="panel"><h3>History</h3><ul>${historyHtml}</ul></div>
    </div>`, 'board');

  $('#edit-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = {};
    for (const k of ['title', 'status', 'type', 'priority']) body[k] = f.get(k);
    body.assigneeId = f.get('assigneeId') || null;
    body.sprintId = f.get('sprintId') || null;
    body.epicId = f.get('epicId') || null;
    body.dueDate = f.get('dueDate') || null;
    body.description = f.get('description') || null;
    body.storyPoints = f.get('storyPoints') === '' ? null : Number(f.get('storyPoints'));
    body.labels = f.get('labels').split(',').map((x) => x.trim()).filter(Boolean);
    try {
      await api('PATCH', `/api/issues/${key}`, body);
      render();
    } catch (err) {
      $('#edit-err').textContent = err.message;
    }
  };
  $('#watch').onclick = async () => {
    await api(watching ? 'DELETE' : 'POST', `/api/issues/${key}/watch`);
    render();
  };
  $('#delete-issue').onclick = async () => {
    if (!confirm(`Delete ${key}?`)) return;
    await api('DELETE', `/api/issues/${key}`);
    location.hash = '#/board';
  };
  const subForm = $('#sub-form');
  if (subForm) {
    subForm.onsubmit = async (e) => {
      e.preventDefault();
      await api('POST', `/api/projects/${S.project.id}/issues`, { type: 'subtask', title: new FormData(subForm).get('title'), parentId: i.id });
      render();
    };
  }
  $('#link-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('POST', `/api/issues/${key}/links`, { type: f.get('type'), target: f.get('target') });
      render();
    } catch (err) { $('#link-err').textContent = err.message; }
  };
  document.querySelectorAll('[data-unlink]').forEach((b) => {
    b.onclick = async () => { await api('DELETE', `/api/issues/${key}/links/${b.dataset.unlink}`); render(); };
  });
  $('#comment-form').onsubmit = async (e) => {
    e.preventDefault();
    const text = new FormData(e.target).get('body');
    try {
      await api('POST', `/api/issues/${key}/comments`, { body: text });
      render();
    } catch (err) { $('#comment-err').textContent = err.message; }
  };
  document.querySelectorAll('[data-edit-comment]').forEach((b) => {
    b.onclick = async () => {
      const current = comments.find((c) => c.id === b.dataset.editComment);
      const text = prompt('Edit comment', current.body);
      if (text === null) return;
      await api('PATCH', `/api/comments/${current.id}`, { body: text });
      render();
    };
  });
}

// ---------------- search ----------------
async function viewSearch() {
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const q = params.get('q') || '';
  const sort = params.get('sort') || 'updated';
  let results = null;
  let error = '';
  if (params.has('q')) {
    try {
      results = await api('GET', `/api/search?${new URLSearchParams({ q, sort, project: S.project.id })}`);
    } catch (err) {
      error = err.message;
    }
  }
  shell(`
    <div class="panel">
      <form id="search-form" class="row">
        <input name="q" class="grow" value="${esc(q)}" placeholder='e.g. status:"In Progress" type:bug -label:wontfix priority:high due:<2027-01-01 points:>3'>
        <select name="sort">${['updated', 'created', 'priority'].map((s) => `<option ${s === sort ? 'selected' : ''}>${s}</option>`).join('')}</select>
        <button class="primary">Search</button>
      </form>
      <p class="muted">Terms are ANDed. Fields: status, type, priority, assignee (me|username|none), label, sprint (active|id|none), is (open|resolved), due (&lt;, &gt;), points (&gt;, &lt;), key.</p>
      ${error ? `<div class="error">${esc(error)}</div>` : ''}
    </div>
    ${results ? `<div class="panel"><table><thead><tr><th>Key</th><th>Title</th><th>Status</th><th>Priority</th><th>Assignee</th><th>Pts</th></tr></thead><tbody>
      ${results.map((i) => `<tr><td><a class="key" href="#/issue/${esc(i.key)}">${esc(i.key)}</a></td><td>${esc(i.title)}</td><td>${esc(i.status)}</td><td>${esc(i.priority)}</td><td>${esc(memberName(i.assigneeId))}</td><td>${i.storyPoints ?? ''}</td></tr>`).join('') || '<tr><td class="muted">No matches.</td></tr>'}
      </tbody></table></div>` : ''}`, 'search');
  $('#search-form').onsubmit = (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    location.hash = `#/search?${new URLSearchParams({ q: f.get('q'), sort: f.get('sort') })}`;
  };
}

// ---------------- sprint reports ----------------
async function viewSprints() {
  const sprints = await api('GET', `/api/projects/${S.project.id}/sprints`);
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const sel = params.get('sprint') || (sprints.find((s) => s.state === 'active') || sprints[sprints.length - 1] || {}).id;
  let body = '<p class="muted">No sprints yet.</p>';
  if (sel) {
    const r = await api('GET', `/api/sprints/${sel}/report`);
    const s = sprints.find((x) => x.id === sel);
    body = `<div class="panel"><h3>${esc(s.name)} <span class="pill">${esc(s.state)}</span></h3>
      <div class="row">
        <div><b>${r.committedPoints}</b><div class="muted">committed pts</div></div>
        <div><b>${r.completedPoints}</b><div class="muted">completed pts</div></div>
        <div><b>${r.completedIssues}</b><div class="muted">completed issues</div></div>
        <div><b>${r.carriedOver}</b><div class="muted">carried over</div></div>
      </div>
      ${burndownSvg(r.burndown)}
    </div>`;
  }
  shell(`
    <div class="panel row"><b>Sprint</b>
      <select id="sprint-pick">${sprints.map((s) => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${esc(s.name)} (${esc(s.state)})</option>`).join('')}</select></div>
    ${body}`, 'sprints');
  $('#sprint-pick').onchange = (e) => { location.hash = `#/sprints?sprint=${e.target.value}`; };
}

function burndownSvg(points) {
  if (!points.length) return '<p class="muted">No days in range yet.</p>';
  const W = 720, H = 220, P = 30;
  const max = Math.max(1, ...points.map((p) => p.remainingPoints));
  const x = (i) => P + (points.length === 1 ? 0 : (i * (W - 2 * P)) / (points.length - 1));
  const y = (v) => H - P - (v / max) * (H - 2 * P);
  const line = points.map((p, i) => `${x(i)},${y(p.remainingPoints)}`).join(' ');
  const labels = points.map((p, i) => (i % Math.ceil(points.length / 6) === 0
    ? `<text x="${x(i)}" y="${H - 8}" font-size="10" text-anchor="middle">${esc(p.date.slice(5))}</text>` : '')).join('');
  return `<svg class="burndown" viewBox="0 0 ${W} ${H}" role="img" aria-label="Burndown chart">
    <line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" stroke="#97a0af"/>
    <line x1="${P}" y1="${P}" x2="${P}" y2="${H - P}" stroke="#97a0af"/>
    <text x="4" y="${P}" font-size="10">${max}</text>
    <polyline points="${line}" fill="none" stroke="#0052cc" stroke-width="2"/>
    ${points.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.remainingPoints)}" r="3" fill="#0052cc"><title>${esc(p.date)}: ${p.remainingPoints} pts</title></circle>`).join('')}
    ${labels}</svg>`;
}

// ---------------- settings ----------------
function projectForm() {
  return `<form id="proj-form" class="row"><input name="name" placeholder="Project name" required>
    <input name="key" placeholder="KEY (2-10 letters)" required><button class="primary">Create project</button></form>
    <div class="error" id="proj-err"></div>`;
}

function bindProjectForm() {
  const form = $('#proj-form');
  if (!form) return;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(form);
    try {
      const p = await api('POST', `/api/workspaces/${S.ws.id}/projects`, { name: f.get('name'), key: f.get('key') });
      S.project = p;
      localStorage.setItem('pm_proj', p.id);
      await loadWorkspaceContext();
      location.hash = '#/board';
      render();
    } catch (err) { $('#proj-err').textContent = err.message; }
  };
}

async function viewSettings() {
  const [webhooks, sprints] = await Promise.all([
    api('GET', `/api/projects/${S.project.id}/webhooks`).catch(() => null),
    api('GET', `/api/projects/${S.project.id}/sprints`),
  ]);
  const p = S.project;
  const myRole = p.myRole;
  const canLead = myRole === 'lead';
  const isWsAdmin = (S.ws.myRole === 'admin');
  const wf = p.workflow;
  const wfStatuses = wf.statuses.map((s) => `${s.name} | ${s.category}`).join('\n');
  const wfTransitions = wf.transitions.map(([a, b]) => `${a} -> ${b}`).join('\n');
  const hooksHtml = (webhooks || []).map((w) => `<li>${esc(w.url)} [${esc(w.events.join(', '))}]
      <button class="linklike" data-deliveries="${esc(w.id)}">deliveries</button>
      <button class="linklike danger" data-del-hook="${esc(w.id)}">delete</button>
      <div id="del-${esc(w.id)}" class="muted"></div></li>`).join('') || '<li class="muted">No webhooks.</li>';

  shell(`
    <div class="grid2">
      <div class="panel"><h3>Project</h3>
        <p>${esc(p.name)} (${esc(p.key)}) · your role: <b>${esc(myRole || 'none')}</b></p>
        <div class="row"><a class="pill" href="#" id="export">Export CSV</a>
        <input type="file" id="import-file" accept=".csv,text/csv"><button id="import-btn">Import CSV</button></div>
        <div id="import-result" class="muted"></div>
        ${canLead ? `<form id="rename" class="row"><input name="name" value="${esc(p.name)}"><button>Rename</button></form>` : ''}
      </div>
      <div class="panel"><h3>Members (project)</h3>
        <table><tbody>${p.members.map((m) => `<tr><td>${esc(m.username)}</td><td>
          ${canLead ? `<select data-role="${esc(m.userId)}">${['lead', 'developer', 'viewer'].map((r) => `<option ${r === m.role ? 'selected' : ''}>${r}</option>`).join('')}</select>
          <button class="linklike danger" data-remove-member="${esc(m.userId)}">remove</button>` : esc(m.role)}</td></tr>`).join('')}</tbody></table>
        ${canLead ? `<form id="add-member" class="row"><select name="username">${S.wsMembers.filter((w) => !p.members.some((m) => m.userId === w.userId)).map((w) => `<option>${esc(w.username)}</option>`).join('')}</select>
          <select name="role"><option>developer</option><option>viewer</option><option>lead</option></select><button>Add</button></form>` : ''}
        <div class="error" id="member-err"></div>
      </div>
    </div>
    <div class="grid2">
      <div class="panel"><h3>Workflow</h3>
        <form id="wf-form" class="grid2">
          <label>Statuses (one per line: Name | category)<textarea name="statuses" ${canLead ? '' : 'disabled'}>${esc(wfStatuses)}</textarea></label>
          <label>Transitions (From -> To, one per line; blank = any to any)<textarea name="transitions" ${canLead ? '' : 'disabled'}>${esc(wfTransitions)}</textarea></label>
          <label>Remap in-use statuses (Old -> New)<textarea name="remap" ${canLead ? '' : 'disabled'}></textarea></label>
          ${canLead ? '<div><button class="primary">Save workflow</button> <span class="error" id="wf-err"></span></div>' : ''}
        </form>
      </div>
      <div class="panel"><h3>Webhooks</h3><ul>${hooksHtml}</ul>
        <div id="deliveries"></div>
        ${canLead ? `<form id="hook-form" class="grid2">
          <label>URL<input name="url" required placeholder="https://example.com/hook"></label>
          <label>Secret<input name="secret" required></label>
          <label><span><input type="checkbox" name="events" value="issue.created" checked> issue.created</span></label>
          <label><span><input type="checkbox" name="events" value="issue.updated" checked> issue.updated</span></label>
          <label><span><input type="checkbox" name="events" value="issue.deleted"> issue.deleted</span></label>
          <label><span><input type="checkbox" name="events" value="comment.created"> comment.created</span></label>
          <div><button>Add webhook</button> <span class="error" id="hook-err"></span></div></form>` : '<p class="muted">Only leads can manage webhooks.</p>'}
      </div>
    </div>
    <div class="grid2">
      <div class="panel"><h3>Sprints</h3><ul>${sprints.map((s) => `<li>${esc(s.name)} · ${esc(s.state)} ${esc(s.startDate || '')} ${esc(s.endDate || '')}</li>`).join('') || '<li class="muted">None.</li>'}</ul>
        <a href="#/sprints">View reports →</a></div>
      <div class="panel"><h3>Workspace: ${esc(S.ws.name)}</h3>
        <table><tbody>${S.wsMembers.map((m) => `<tr><td>${esc(m.username)}</td><td>${esc(m.role)}</td></tr>`).join('')}</tbody></table>
        ${isWsAdmin ? `<form id="ws-add" class="row"><input name="username" placeholder="username" required>
          <select name="role"><option>member</option><option>guest</option><option>admin</option></select><button>Add to workspace</button></form>
          <div class="error" id="ws-err"></div>` : '<p class="muted">Workspace admins manage members.</p>'}
      </div>
    </div>`, 'settings');

  $('#export').onclick = async (e) => {
    e.preventDefault();
    const res = await api('GET', `/api/projects/${p.id}/export.csv`, undefined, { raw: true });
    const blob = new Blob([await res.text()], { type: 'text/csv' });
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${p.key}.csv` });
    a.click();
  };
  $('#import-btn').onclick = async () => {
    const file = $('#import-file').files[0];
    if (!file) return;
    try {
      const r = await api('POST', `/api/projects/${p.id}/import.csv`, undefined, { text: await file.text() });
      $('#import-result').textContent = `Created ${r.created}; ${r.errors.length} error(s): ${r.errors.map((x) => `line ${x.line}: ${x.message}`).join('; ')}`;
    } catch (err) { $('#import-result').textContent = err.message; }
  };
  if (canLead) {
    $('#rename').onsubmit = async (e) => {
      e.preventDefault();
      await api('PATCH', `/api/projects/${p.id}`, { name: new FormData(e.target).get('name') });
      await refreshProject(); render();
    };
    document.querySelectorAll('[data-role]').forEach((sel) => {
      sel.onchange = async () => { await api('PATCH', `/api/projects/${p.id}/members/${sel.dataset.role}`, { role: sel.value }); await refreshProject(); render(); };
    });
    document.querySelectorAll('[data-remove-member]').forEach((b) => {
      b.onclick = async () => {
        try { await api('DELETE', `/api/projects/${p.id}/members/${b.dataset.removeMember}`); await refreshProject(); render(); } catch (err) { $('#member-err').textContent = err.message; }
      };
    });
    $('#add-member').onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try { await api('POST', `/api/projects/${p.id}/members`, { username: f.get('username'), role: f.get('role') }); await refreshProject(); render(); } catch (err) { $('#member-err').textContent = err.message; }
    };
    $('#wf-form').onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const statuses = f.get('statuses').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const [name, category] = l.split('|').map((x) => x.trim());
        return { name, category };
      });
      const transitions = f.get('transitions').split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.split('->').map((x) => x.trim()));
      const remap = {};
      f.get('remap').split('\n').map((l) => l.trim()).filter(Boolean).forEach((l) => {
        const [from, to] = l.split('->').map((x) => x.trim());
        remap[from] = to;
      });
      try {
        await api('PUT', `/api/projects/${p.id}/workflow`, { statuses, transitions: transitions.length ? transitions : undefined, remap });
        await refreshProject(); render();
      } catch (err) { $('#wf-err').textContent = err.message; }
    };
    $('#hook-form').onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const events = [...e.target.querySelectorAll('input[name=events]:checked')].map((x) => x.value);
      try { await api('POST', `/api/projects/${p.id}/webhooks`, { url: f.get('url'), secret: f.get('secret'), events }); render(); } catch (err) { $('#hook-err').textContent = err.message; }
    };
    document.querySelectorAll('[data-del-hook]').forEach((b) => {
      b.onclick = async () => { await api('DELETE', `/api/webhooks/${b.dataset.delHook}`); render(); };
    });
  }
  document.querySelectorAll('[data-deliveries]').forEach((b) => {
    b.onclick = async () => {
      const list = await api('GET', `/api/webhooks/${b.dataset.deliveries}/deliveries`);
      $('#deliveries').innerHTML = `<h4>Deliveries</h4><table><thead><tr><th>Event</th><th>Status</th><th>Attempts</th><th>Last error</th></tr></thead><tbody>${list.map((d) => `<tr><td>${esc(d.event)}</td><td>${esc(d.status ?? '–')}</td><td>${esc(d.attempts)}</td><td>${esc(d.lastError || '')}</td></tr>`).join('') || '<tr><td class="muted">None yet.</td></tr>'}</tbody></table>`;
    };
  });
  if (isWsAdmin) {
    $('#ws-add').onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        const m = await api('POST', `/api/workspaces/${S.ws.id}/members`, { username: f.get('username'), role: f.get('role') });
        S.wsMembers.push(m);
        render();
      } catch (err) { $('#ws-err').textContent = err.message; }
    };
  }
}

boot();
