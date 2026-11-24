// pm-s4 single-page app. Talks to the server only through the public JSON API.
const app = document.getElementById('app');
const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'];
const ISSUE_TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const CATEGORIES = ['backlog', 'unstarted', 'started', 'completed'];

const S = {
  token: localStorage.getItem('pm-token'),
  me: null,
  workspaces: [],
  ws: null,          // workspace detail (members)
  projects: [],      // projects in current workspace
  project: null,     // project detail (workflow, members, role)
  issues: [],        // issues of current project
  sprints: [],       // sprints of current project
  notifications: [],
  notifOpen: false,
  error: '',
  flash: '',
  loginMode: 'login',
};

// ---------- helpers ----------
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const route = () => {
  const hash = location.hash.replace(/^#\/?/, '');
  const [page, ...rest] = hash.split('/');
  return { page: page || 'board', arg: decodeURIComponent(rest.join('/') || '') };
};
const go = (hash) => { location.hash = hash; };
const canWrite = () => ['lead', 'developer'].includes(S.project?.role);
const isLead = () => S.project?.role === 'lead';
const userName = (id) => {
  if (!id) return '';
  const m = (S.project?.members || []).find((x) => x.userId === id);
  if (m) return m.username;
  const w = (S.ws?.members || []).find((x) => x.userId === id);
  return w ? w.username : id.slice(0, 6);
};
const sprintLabel = (id) => S.sprints.find((s) => s.id === id)?.name || '';
const statusCategory = (name) => S.project?.workflow.statuses.find((s) => s.name === name)?.category;
const isDone = (name) => statusCategory(name) === 'completed';
const selectOptions = (items, selected, labelFn = (x) => x, valueFn = (x) => x) =>
  items.map((it) => `<option value="${esc(valueFn(it))}" ${String(valueFn(it)) === String(selected ?? '') ? 'selected' : ''}>${esc(labelFn(it))}</option>`).join('');

async function api(method, path, body, { raw, type } = {}) {
  const headers = {};
  if (S.token) headers.authorization = `Bearer ${S.token}`;
  let payload;
  if (raw !== undefined) { headers['content-type'] = type || 'text/csv'; payload = raw; }
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(path, { method, headers, body: payload });
  if (res.status === 204) return null;
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    if (res.status === 401 && S.token) {
      S.token = null;
      localStorage.removeItem('pm-token');
      S.me = null;
    }
    const err = new Error(data?.message || res.statusText);
    err.code = data?.error;
    err.status = res.status;
    throw err;
  }
  return data;
}

// Runs an action, shows any error in the top bar, re-renders.
async function run(fn) {
  try {
    S.error = '';
    await fn();
  } catch (err) {
    S.error = err.message;
  }
  await render();
}

// ---------- data loading ----------
async function loadNotifications() {
  if (!S.token) return;
  try { S.notifications = await api('GET', '/api/notifications'); } catch { /* ignore */ }
}

async function loadWorkspaces() {
  S.workspaces = await api('GET', '/api/workspaces');
  const saved = localStorage.getItem('pm-ws');
  const wsId = S.workspaces.find((w) => w.id === saved)?.id || S.workspaces[0]?.id;
  if (wsId) await selectWorkspace(wsId, false);
  else { S.ws = null; S.projects = []; S.project = null; }
}

async function selectWorkspace(wsId, reload = true) {
  localStorage.setItem('pm-ws', wsId);
  S.ws = await api('GET', `/api/workspaces/${wsId}`);
  S.projects = await api('GET', `/api/workspaces/${wsId}/projects`);
  const savedP = localStorage.getItem('pm-project');
  const proj = S.projects.find((p) => p.id === savedP) || S.projects[0];
  S.project = null;
  S.issues = [];
  S.sprints = [];
  if (proj) await selectProject(proj.id, false);
  if (reload) await render();
}

async function selectProject(pid, reload = true) {
  localStorage.setItem('pm-project', pid);
  S.project = await api('GET', `/api/projects/${pid}`);
  await refreshProject();
  if (reload) await render();
}

async function refreshProject() {
  if (!S.project) return;
  const [issues, sprints] = await Promise.all([
    api('GET', `/api/projects/${S.project.id}/issues`),
    api('GET', `/api/projects/${S.project.id}/sprints`),
  ]);
  S.issues = issues;
  S.sprints = sprints;
  S.project = await api('GET', `/api/projects/${S.project.id}`);
}

// ---------- rendering ----------
async function render() {
  if (!S.token) return renderLogin();
  if (!S.me) {
    try { S.me = (await api('GET', '/api/auth/me')).user; } catch { return renderLogin(); }
  }
  if (!S.ws && !S.workspaces.length) {
    try { await loadWorkspaces(); } catch { /* ignore */ }
  }
  await loadNotifications();
  const r = route();
  let body = '';
  if (r.page === 'workspace') body = viewWorkspace();
  else if (!S.project) body = `<div class="card-box">No project yet. <a data-act="nav" data-to="#/workspace">Create a workspace or project</a>.</div>`;
  else if (r.page === 'backlog') body = viewBacklog();
  else if (r.page === 'sprints') body = viewSprints(r.arg);
  else if (r.page === 'settings') body = viewSettings();
  else if (r.page === 'issue') body = await viewIssue(r.arg);
  else if (r.page === 'search') body = await viewSearch(r.arg);
  else body = viewBoard();
  app.innerHTML = shell(r.page) + (S.flash ? `<div class="card-box">${esc(S.flash)}</div>` : '') + (S.error ? `<div class="err">${esc(S.error)}</div>` : '') + `<main>${body}</main>`;
  S.flash = '';
  await afterRender();
}

function renderLogin() {
  const reg = S.loginMode === 'register';
  app.innerHTML = `
    <div class="card-box centered">
      <h2>${reg ? 'Create account' : 'Sign in'}</h2>
      <form data-form="auth">
        <div class="field"><label>Username</label><input name="username" required minlength="3"></div>
        ${reg ? '<div class="field"><label>Display name</label><input name="displayName"></div>' : ''}
        <div class="field"><label>Password</label><input name="password" type="password" required minlength="8"></div>
        <div class="row"><button class="primary" type="submit">${reg ? 'Register' : 'Log in'}</button>
        <a data-act="toggle-login">${reg ? 'Have an account? Log in' : 'New here? Register'}</a></div>
        ${S.error ? `<div class="err">${esc(S.error)}</div>` : ''}
      </form>
    </div>`;
}

function shell(page) {
  const wsOpts = selectOptions(S.workspaces, S.ws?.id, (w) => `${w.name} (${w.key})`, (w) => w.id);
  const projOpts = selectOptions(S.projects, S.project?.id, (p) => `${p.name} (${p.key})`, (p) => p.id);
  const tab = (name, label) => `<a data-act="nav" data-to="#/${name}" class="${page === name ? 'active' : ''}">${label}</a>`;
  const count = S.notifications.filter((n) => !n.read).length;
  const panel = S.notifOpen ? `<div class="panel">${S.notifications.length ? S.notifications.map((n) => `
      <div class="n ${n.read ? '' : 'unread'}" data-act="open-notif" data-id="${esc(n.id)}" data-key="${esc(n.issueKey)}">
        <b>${esc(n.type.replace('_', ' '))}</b> on ${esc(n.issueKey)}<div class="muted">${esc(userName(n.actorId) || 'someone')} · ${new Date(n.at).toLocaleString()}</div>
      </div>`).join('') : '<div class="n muted">No notifications</div>'}
      <div class="n"><a data-act="read-all">Mark all read</a></div></div>` : '';
  return `
    <header class="top">
      <strong>pm-s4</strong>
      <select data-change="ws">${wsOpts || '<option>No workspaces</option>'}</select>
      <select data-change="project">${projOpts || '<option>No projects</option>'}</select>
      <nav class="tabs">${tab('board', 'Board')}${tab('backlog', 'Backlog')}${tab('sprints', 'Sprints')}${tab('settings', 'Project settings')}${tab('workspace', 'Workspace')}</nav>
      <form data-form="search" class="row"><input name="q" placeholder='Search e.g. status:"In Progress" -label:x' value="${esc(route().page === 'search' ? route().arg : '')}"></form>
      <span class="bell"><a data-act="toggle-notif">🔔 <span class="count">${count || ''}</span></a>${panel}</span>
      <span>${esc(S.me?.displayName || S.me?.username)} · <a data-act="logout">log out</a></span>
    </header>`;
}

// Board
function viewBoard() {
  const cols = S.project.workflow.statuses.map((st) => {
    const items = S.issues.filter((i) => i.status === st.name && i.type !== 'subtask');
    return `<div class="column" data-drop="${esc(st.name)}">
      <h3>${esc(st.name)} <span class="muted">${items.length}</span></h3>
      ${items.map(cardHtml).join('')}
    </div>`;
  }).join('');
  return `${canWrite() ? newIssueForm() : ''}
    <p class="muted">Drag cards between columns to change status.</p>
    <div class="board">${cols}</div>`;
}

function newIssueForm() {
  return `<form data-form="new-issue" class="card-box row" style="margin-bottom:12px">
    <input name="title" placeholder="New issue title" required style="min-width:260px">
    <select name="type">${selectOptions(ISSUE_TYPES.filter((t) => t !== 'subtask'), 'task')}</select>
    <select name="priority">${selectOptions(PRIORITIES, 'none')}</select>
    <button class="primary" type="submit">Create</button>
  </form>`;
}

function cardHtml(i) {
  return `<div class="card" draggable="true" data-drag="${esc(i.key)}" data-act="open-issue" data-key="${esc(i.key)}">
    <div class="key">${esc(i.key)} · ${esc(i.type)}</div>
    <div class="title">${esc(i.title)}</div>
    <span class="badge prio-${esc(i.priority)}">${esc(i.priority)}</span>
    ${i.storyPoints != null ? `<span class="badge">${esc(i.storyPoints)} pts</span>` : ''}
    ${i.assigneeId ? `<span class="badge">@${esc(userName(i.assigneeId))}</span>` : ''}
  </div>`;
}

// Backlog and sprint planning
function viewBacklog() {
  const backlog = S.issues.filter((i) => !i.sprintId && i.type !== 'subtask');
  const sprintBoxes = S.sprints.filter((s) => s.state !== 'completed').map((s) => {
    const items = S.issues.filter((i) => i.sprintId === s.id);
    return `<div class="sprint-box">
      <div class="row"><strong>${esc(s.name)}</strong><span class="badge">${esc(s.state)}</span>
        <span class="muted">${esc(s.startDate || '')} ${s.endDate ? '→ ' + esc(s.endDate) : ''}</span>
        <span class="grow"></span>
        ${canWrite() && s.state === 'planned' ? `<button data-act="start-sprint" data-id="${esc(s.id)}">Start</button>` : ''}
        ${canWrite() && s.state === 'active' ? `<button data-act="complete-sprint" data-id="${esc(s.id)}">Complete…</button>` : ''}
        <a data-act="nav" data-to="#/sprints/${esc(s.id)}">Report</a>
      </div>
      ${items.map((i) => `<div class="row" style="margin-top:4px"><a data-act="open-issue" data-key="${esc(i.key)}">${esc(i.key)}</a> ${esc(i.title)}
        <span class="badge">${esc(i.status)}</span>${canWrite() ? `<button data-act="move-sprint" data-key="${esc(i.key)}" data-sprint="">Remove</button>` : ''}</div>`).join('') || '<div class="muted">Empty</div>'}
    </div>`;
  }).join('');
  return `<div class="grid2">
    <div>
      <h3>Backlog (${backlog.length})</h3>
      ${backlog.map((i) => `<div class="card-box row" style="margin-bottom:6px">
        <a data-act="open-issue" data-key="${esc(i.key)}">${esc(i.key)}</a><span class="grow">${esc(i.title)}</span>
        <span class="badge">${esc(i.status)}</span>
        ${canWrite() && S.sprints.some((s) => s.state !== 'completed') ? `<select data-change="move-sprint" data-key="${esc(i.key)}"><option value="">Move to sprint…</option>${selectOptions(S.sprints.filter((s) => s.state !== 'completed'), '', (s) => s.name, (s) => s.id)}</select>` : ''}
      </div>`).join('') || '<div class="muted">Backlog is empty.</div>'}
    </div>
    <div>
      ${canWrite() ? `<form data-form="new-sprint" class="card-box" style="margin-bottom:10px">
        <strong>New sprint</strong>
        <div class="field"><input name="name" placeholder="Sprint name" required></div>
        <div class="row"><input name="startDate" type="date"><input name="endDate" type="date"></div>
        <div style="margin-top:6px"><button class="primary" type="submit">Create sprint</button></div>
      </form>` : ''}
      <h3>Sprints</h3>${sprintBoxes || '<div class="muted">No open sprints.</div>'}
    </div>
  </div>`;
}

function viewSprints(sprintId) {
  const sprints = S.sprints;
  const current = sprints.find((s) => s.id === sprintId) || sprints.find((s) => s.state === 'active') || sprints[sprints.length - 1];
  if (!current) return '<div class="card-box">No sprints yet.</div>';
  return `<div class="row"><strong>Sprint report</strong>
    <select data-change="report-sprint">${selectOptions(sprints, current.id, (s) => `${s.name} (${s.state})`, (s) => s.id)}</select></div>
    <div id="report" class="card-box" style="margin-top:10px"><span class="muted">Loading report…</span></div>`;
}

async function loadReport(sprintId) {
  const el = document.getElementById('report');
  if (!el) return;
  try {
    const r = await api('GET', `/api/sprints/${sprintId}/report`);
    el.innerHTML = `
      <div class="row"><div class="card-box">Committed: <b>${r.committedPoints}</b> pts</div>
      <div class="card-box">Completed: <b>${r.completedPoints}</b> pts (${r.completedIssues.length} issues)</div>
      <div class="card-box">Carried over: <b>${r.carriedOver.length}</b></div></div>
      <p><b>Completed issues:</b> ${r.completedIssues.map((k) => `<a data-act="open-issue" data-key="${esc(k)}">${esc(k)}</a>`).join(', ') || '<span class="muted">none</span>'}</p>
      <p><b>Carried over:</b> ${r.carriedOver.map(esc).join(', ') || '<span class="muted">none</span>'}</p>
      ${burndownSvg(r.burndown)}`;
  } catch (err) {
    el.innerHTML = `<div class="err">${esc(err.message)}</div>`;
  }
}

function burndownSvg(points) {
  if (!points.length) return '<p class="muted">No burndown data yet.</p>';
  const W = 640, H = 260, P = 36;
  const max = Math.max(1, ...points.map((p) => p.remainingPoints));
  const x = (i) => P + (points.length === 1 ? 0 : (i * (W - 2 * P)) / (points.length - 1));
  const y = (v) => H - P - (v / max) * (H - 2 * P);
  const line = points.map((p, i) => `${x(i)},${y(p.remainingPoints)}`).join(' ');
  const labels = points.map((p, i) => `<text x="${x(i)}" y="${H - P + 16}" font-size="10" text-anchor="middle">${esc(p.date.slice(5))}</text>`).join('');
  const dots = points.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.remainingPoints)}" r="3" fill="#3b6fe0"><title>${esc(p.date)}: ${p.remainingPoints}</title></circle>`).join('');
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Burndown chart">
    <line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" stroke="#999"/>
    <line x1="${P}" y1="${P}" x2="${P}" y2="${H - P}" stroke="#999"/>
    <text x="4" y="${P}" font-size="10">${max}</text>
    <text x="4" y="${H - P}" font-size="10">0</text>
    <polyline points="${line}" fill="none" stroke="#3b6fe0" stroke-width="2"/>
    ${dots}${labels}</svg>`;
}

// Issue detail
async function viewIssue(key) {
  if (!key) return '<div class="card-box">No issue selected.</div>';
  let i;
  try { i = await api('GET', `/api/issues/${encodeURIComponent(key)}`); } catch (err) { return `<div class="err">${esc(err.message)}</div>`; }
  const w = canWrite();
  const dis = w ? '' : 'disabled';
  const sel = (name, opts, cur) => `<select data-change="field" data-key="${esc(i.key)}" data-field="${name}" ${dis}>${opts}</select>`;
  const watching = i.watchers.includes(S.me.id);
  const epics = S.issues.filter((x) => x.type === 'epic' && x.id !== i.id);
  return `<div class="grid2"><div>
    <div class="card-box">
      <div class="key muted">${esc(i.key)} · ${esc(i.type)} · reporter ${esc(userName(i.reporterId))}</div>
      <h2 style="margin:4px 0"><input data-blur="title" data-key="${esc(i.key)}" value="${esc(i.title)}" style="width:100%;font-size:20px" ${dis}></h2>
      <div class="field"><label>Description</label><textarea data-blur="description" data-key="${esc(i.key)}" ${dis}>${esc(i.description)}</textarea></div>
      <div class="row"><button data-act="watch" data-key="${esc(i.key)}" data-on="${watching ? '0' : '1'}">${watching ? 'Unwatch' : 'Watch'}</button>
        ${w ? `<button class="danger" data-act="delete-issue" data-key="${esc(i.key)}">Delete</button>` : ''}</div>
    </div>
    <div class="card-box" style="margin-top:12px"><strong>Subtasks</strong>
      <ul>${i.children.map((k) => `<li><a data-act="open-issue" data-key="${esc(k)}">${esc(k)}</a></li>`).join('') || '<li class="muted">None</li>'}</ul>
      ${w && i.type !== 'subtask' ? `<form data-form="subtask" data-parent="${esc(i.key)}" class="row"><input name="title" placeholder="Subtask title" required><button type="submit">Add subtask</button></form>` : ''}
    </div>
    ${i.progress ? `<div class="card-box" style="margin-top:12px">Epic progress: ${i.progress.done}/${i.progress.total} issues · ${i.progress.points_done}/${i.progress.points_total} pts</div>` : ''}
    <div class="card-box" style="margin-top:12px"><strong>Comments</strong>
      ${i.comments.map((c) => `<div style="border-top:1px solid var(--line);padding:6px 0">
        <div class="muted">${esc(userName(c.authorId))} · ${new Date(c.createdAt).toLocaleString()} ${c.edited ? '(edited)' : ''}
          ${c.authorId === S.me.id ? `<a data-act="edit-comment" data-id="${esc(c.id)}">edit</a>` : ''}</div>
        <div>${esc(c.body)}</div></div>`).join('') || '<div class="muted">No comments</div>'}
      ${w ? `<form data-form="comment" data-key="${esc(i.key)}" style="margin-top:8px"><textarea name="body" placeholder="Write a comment (use @username to mention)" required></textarea><button class="primary" type="submit">Comment</button></form>` : ''}
    </div>
  </div><div>
    <div class="card-box">
      <div class="field"><label>Status</label>${sel('status', selectOptions(S.project.workflow.statuses, i.status, (s) => s.name, (s) => s.name))}</div>
      <div class="field"><label>Type</label>${sel('type', selectOptions(ISSUE_TYPES, i.type))}</div>
      <div class="field"><label>Priority</label>${sel('priority', selectOptions(PRIORITIES, i.priority))}</div>
      <div class="field"><label>Assignee</label>${sel('assigneeId', `<option value="">Unassigned</option>` + selectOptions(S.project.members, i.assigneeId, (m) => m.username, (m) => m.userId))}</div>
      <div class="field"><label>Story points</label><input data-blur="storyPoints" data-key="${esc(i.key)}" value="${esc(i.storyPoints ?? '')}" ${dis}></div>
      <div class="field"><label>Labels (comma separated)</label><input data-blur="labels" data-key="${esc(i.key)}" value="${esc(i.labels.join(', '))}" ${dis}></div>
      <div class="field"><label>Due date</label><input type="date" data-blur="dueDate" data-key="${esc(i.key)}" value="${esc(i.dueDate || '')}" ${dis}></div>
      <div class="field"><label>Sprint</label>${sel('sprintId', `<option value="">Backlog</option>` + selectOptions(S.sprints, i.sprintId, (s) => s.name, (s) => s.id))}</div>
      <div class="field"><label>Epic</label>${sel('epicId', `<option value="">None</option>` + selectOptions(epics, i.epicId, (e) => e.key, (e) => e.id))}</div>
      <div class="muted">Created ${new Date(i.createdAt).toLocaleString()}${i.resolvedAt ? ` · resolved ${new Date(i.resolvedAt).toLocaleString()}` : ''}</div>
    </div>
    <div class="card-box" style="margin-top:12px"><strong>Links</strong>
      <ul>${i.links.map((l) => `<li>${esc(l.type)} <a data-act="open-issue" data-key="${esc(l.target)}">${esc(l.target)}</a>
        ${w ? `<a class="danger" data-act="unlink" data-key="${esc(i.key)}" data-type="${esc(l.type)}" data-target="${esc(l.target)}">✕</a>` : ''}</li>`).join('') || '<li class="muted">None</li>'}</ul>
      ${w ? `<form data-form="link" data-key="${esc(i.key)}" class="row"><select name="type"><option value="blocks">blocks</option><option value="relates">relates</option><option value="duplicates">duplicates</option></select>
        <input name="target" placeholder="ISSUE-KEY" required style="width:110px"><button type="submit">Link</button></form>` : ''}
    </div>
    <div class="card-box" style="margin-top:12px"><strong>History</strong>
      <div id="history"><span class="muted">Loading…</span></div>
    </div>
  </div></div>`;
}

async function loadHistory(key) {
  const el = document.getElementById('history');
  if (!el) return;
  const h = await api('GET', `/api/issues/${encodeURIComponent(key)}/history`);
  el.innerHTML = h.map((x) => `<div class="muted" style="margin-bottom:4px">${new Date(x.at).toLocaleString()} · ${esc(userName(x.actorId))} changed <b>${esc(x.field)}</b>: ${esc(JSON.stringify(x.from))} → ${esc(JSON.stringify(x.to))}</div>`).join('') || '<span class="muted">No changes</span>';
}

// Search
async function viewSearch(q) {
  if (!q) return '<div class="card-box">Type a query in the search bar. Examples: <code>type:bug priority:high</code>, <code>is:open -label:wontfix</code>, <code>"login crash"</code>.</div>';
  try {
    const results = await api('GET', `/api/search?q=${encodeURIComponent(q)}`);
    return `<h3>${results.length} result(s) for <code>${esc(q)}</code></h3>
      <table><tr><th>Key</th><th>Title</th><th>Status</th><th>Priority</th><th>Assignee</th></tr>
      ${results.map((i) => `<tr><td><a data-act="open-issue" data-key="${esc(i.key)}">${esc(i.key)}</a></td><td>${esc(i.title)}</td><td>${esc(i.status)}</td><td>${esc(i.priority)}</td><td>${esc(userName(i.assigneeId))}</td></tr>`).join('')}
      </table>`;
  } catch (err) {
    return `<div class="err">${esc(err.message)}</div>`;
  }
}

// Workspace management
function viewWorkspace() {
  const admin = S.ws?.role === 'admin';
  const ws = S.ws;
  return `<div class="grid2"><div>
    <div class="card-box"><h3>Workspace ${ws ? esc(ws.name) + ' (' + esc(ws.key) + ')' : ''}</h3>
      ${ws ? `<table><tr><th>User</th><th>Role</th><th></th></tr>${ws.members.map((m) => `<tr><td>${esc(m.username)}</td><td>
        ${admin ? `<select data-change="ws-role" data-user="${esc(m.userId)}">${selectOptions(['admin', 'member', 'guest'], m.role)}</select>` : esc(m.role)}</td>
        <td>${admin ? `<button class="danger" data-act="ws-remove" data-user="${esc(m.userId)}">Remove</button>` : ''}</td></tr>`).join('')}</table>` : ''}
      ${admin && ws ? `<form data-form="ws-add-member" class="row" style="margin-top:8px"><input name="username" placeholder="username" required>
        <select name="role">${selectOptions(['member', 'guest', 'admin'], 'member')}</select><button type="submit">Add member</button></form>` : ''}
    </div>
    ${admin && ws ? `<div class="card-box" style="margin-top:12px"><strong>Audit log</strong><div id="audit"><span class="muted">Loading…</span></div></div>` : ''}
  </div><div>
    <form data-form="new-ws" class="card-box"><strong>New workspace</strong>
      <div class="field"><input name="name" placeholder="Name" required></div>
      <div class="field"><input name="key" placeholder="KEY (2-10 uppercase letters)" required pattern="[A-Z]{2,10}"></div>
      <button class="primary" type="submit">Create workspace</button></form>
    ${ws ? `<form data-form="new-project" class="card-box" style="margin-top:12px"><strong>New project in ${esc(ws.name)}</strong>
      <div class="field"><input name="name" placeholder="Name" required></div>
      <div class="field"><input name="key" placeholder="KEY (2-10 uppercase letters)" required pattern="[A-Z]{2,10}"></div>
      <button class="primary" type="submit">Create project</button></form>` : ''}
    <form data-form="new-token" class="card-box" style="margin-top:12px"><strong>API token</strong>
      <div class="field"><input name="name" placeholder="Token name" required></div>
      <button type="submit">Create token</button></form>
  </div></div>`;
}

async function loadAudit() {
  const el = document.getElementById('audit');
  if (!el || !S.ws) return;
  const rows = await api('GET', `/api/workspaces/${S.ws.id}/audit`);
  el.innerHTML = rows.slice(-50).reverse().map((a) => `<div class="muted" style="margin-bottom:4px">${new Date(a.at).toLocaleString()} · ${esc(userName(a.actorId))} · ${esc(a.action)} ${esc(JSON.stringify(a.detail))}</div>`).join('') || '<span class="muted">Empty</span>';
}

// Project settings: workflow, members, webhooks, import/export
function viewSettings() {
  const wf = S.project.workflow;
  const inUse = (name) => S.issues.some((i) => i.status === name);
  const lead = isLead();
  const names = wf.statuses.map((s) => s.name);
  const transitionRows = names.map((from) => `<tr><th>${esc(from)}</th>${names.map((to) => from === to ? '<td>—</td>' :
    `<td><input type="checkbox" data-tr="${esc(from)}|${esc(to)}" ${wf.transitions.some(([a, b]) => a === from && b === to) ? 'checked' : ''} ${lead ? '' : 'disabled'}></td>`).join('')}</tr>`).join('');
  return `<div class="grid2"><div>
    <div class="card-box"><h3>Workflow</h3>
      <form data-form="workflow">
        ${wf.statuses.map((s, idx) => `<div class="row" style="margin-bottom:4px">
          <input data-status-name="${idx}" value="${esc(s.name)}" ${lead ? '' : 'disabled'}>
          <select data-status-cat="${idx}" ${lead ? '' : 'disabled'}>${selectOptions(CATEGORIES, s.category)}</select>
          ${lead ? `<button type="button" data-act="wf-remove" data-idx="${idx}">✕</button>` : ''}
          ${lead && names.includes(s.name) ? '' : ''}</div>`).join('')}
        ${lead ? `<div class="row"><button type="button" data-act="wf-add">Add status</button></div>
        <h4>Transitions (rows = from, columns = to)</h4><div style="overflow:auto"><table>${transitionRows}</table></div>
        <h4>Remap statuses that are removed and in use</h4>
        <div id="remap">${wf.statuses.filter((s) => inUse(s.name)).map((s) => `<div class="muted">${esc(s.name)} → <select data-remap-for="${esc(s.name)}"><option value="">(keep if still present)</option>${selectOptions(names, '')}</select></div>`).join('') || '<span class="muted">No statuses in use.</span>'}</div>
        <div style="margin-top:8px"><button class="primary" type="submit">Save workflow</button></div>` : ''}
      </form>
    </div>
    <div class="card-box" style="margin-top:12px"><h3>Members</h3>
      <table><tr><th>User</th><th>Role</th><th></th></tr>${S.project.members.map((m) => `<tr><td>${esc(m.username)}</td><td>
        ${lead ? `<select data-change="pm-role" data-user="${esc(m.userId)}">${selectOptions(['lead', 'developer', 'viewer'], m.role)}</select>` : esc(m.role)}</td>
        <td>${lead ? `<button class="danger" data-act="pm-remove" data-user="${esc(m.userId)}">Remove</button>` : ''}</td></tr>`).join('')}</table>
      ${lead ? `<form data-form="pm-add" class="row" style="margin-top:8px"><input name="username" placeholder="username" required>
        <select name="role">${selectOptions(['developer', 'lead', 'viewer'], 'developer')}</select><button type="submit">Add member</button></form>` : ''}
    </div>
  </div><div>
    <div class="card-box"><h3>Import / export</h3>
      <p><button data-act="export-csv">Download CSV export</button></p>
      ${canWrite() ? `<form data-form="import"><input type="file" name="file" accept=".csv,text/csv" required> <button type="submit">Import CSV</button></form>` : ''}
      <div id="import-result" class="muted"></div>
    </div>
    <div class="card-box" style="margin-top:12px"><h3>Webhooks</h3>
      <div id="hooks"><span class="muted">Loading…</span></div>
      ${lead ? `<form data-form="webhook" style="margin-top:8px">
        <div class="field"><input name="url" placeholder="https://example.com/hook" required></div>
        <div class="field"><input name="secret" placeholder="Secret (for HMAC signature)"></div>
        <div class="row">${['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'].map((e) => `<label><input type="checkbox" name="events" value="${e}" checked> ${e}</label>`).join('')}</div>
        <button type="submit" style="margin-top:6px">Add webhook</button></form>` : ''}
    </div>
    <div class="card-box" style="margin-top:12px"><h3>Stats</h3><div id="stats"><span class="muted">Loading…</span></div></div>
  </div></div>`;
}

async function loadSettingsExtras() {
  const hooksEl = document.getElementById('hooks');
  if (hooksEl && isLead()) {
    const hooks = await api('GET', `/api/projects/${S.project.id}/webhooks`);
    hooksEl.innerHTML = hooks.map((h) => `<div class="card-box" style="margin-bottom:6px"><div>${esc(h.url)}</div>
      <div class="muted">${esc(h.events.join(', '))}</div>
      <div class="row"><button data-act="hook-deliveries" data-id="${esc(h.id)}">Deliveries</button><button class="danger" data-act="hook-delete" data-id="${esc(h.id)}">Delete</button></div>
      <div id="deliveries-${esc(h.id)}"></div></div>`).join('') || '<span class="muted">No webhooks</span>';
  } else if (hooksEl) hooksEl.innerHTML = '<span class="muted">Leads can manage webhooks.</span>';
  const statsEl = document.getElementById('stats');
  if (statsEl) {
    const st = await api('GET', `/api/projects/${S.project.id}/stats`);
    statsEl.innerHTML = `<div>Total issues: ${st.total}</div><div>Avg cycle time: ${st.avgCycleTimeHours ?? 'n/a'} h</div>
      <div class="muted">By status: ${Object.entries(st.byStatus).map(([k, v]) => `${esc(k)} ${v}`).join(' · ')}</div>
      <div class="muted">By type: ${Object.entries(st.byType).map(([k, v]) => `${esc(k)} ${v}`).join(' · ')}</div>
      <div class="muted">By assignee: ${Object.entries(st.byAssignee).map(([k, v]) => `${esc(k)} ${v}`).join(' · ')}</div>`;
  }
}

// ---------- events ----------
async function afterMutation(keepIssueKey) {
  await refreshProject();
  if (keepIssueKey) S.flash = '';
}

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) {
    if (S.notifOpen && !e.target.closest('.bell')) { S.notifOpen = false; render(); }
    return;
  }
  const act = el.dataset.act;
  if (act === 'nav') { e.preventDefault(); go(el.dataset.to); return; }
  if (act === 'toggle-login') { S.loginMode = S.loginMode === 'login' ? 'register' : 'login'; S.error = ''; return renderLogin(); }
  if (act === 'logout') {
    return run(async () => {
      try { await api('POST', '/api/auth/logout'); } catch { /* ignore */ }
      S.token = null; S.me = null; localStorage.removeItem('pm-token');
    });
  }
  if (act === 'toggle-notif') { S.notifOpen = !S.notifOpen; return render(); }
  if (act === 'open-notif') {
    return run(async () => {
      S.notifOpen = false;
      await api('POST', '/api/notifications/read', { ids: [el.dataset.id] });
      go(`#/issue/${el.dataset.key}`);
    });
  }
  if (act === 'read-all') return run(async () => { S.notifOpen = false; await api('POST', '/api/notifications/read', { all: true }); });
  if (act === 'open-issue') {
    if (e.target.closest('select,input,button') && el.tagName !== 'A' && !el.matches('.card')) return;
    e.preventDefault();
    return go(`#/issue/${el.dataset.key}`);
  }
  if (act === 'start-sprint') return run(async () => { await api('POST', `/api/sprints/${el.dataset.id}/start`); await refreshProject(); });
  if (act === 'complete-sprint') {
    const target = prompt('Carry unfinished issues to: "backlog" or another sprint id', 'backlog');
    if (target === null) return;
    return run(async () => {
      await api('POST', `/api/sprints/${el.dataset.id}/complete`, { carryOverTo: target.trim() || 'backlog' });
      await refreshProject();
    });
  }
  if (act === 'move-sprint') return run(async () => { await api('PATCH', `/api/issues/${el.dataset.key}`, { sprintId: null }); await refreshProject(); });
  if (act === 'watch') return run(async () => {
    await api(el.dataset.on === '1' ? 'POST' : 'DELETE', `/api/issues/${el.dataset.key}/watch`);
  });
  if (act === 'delete-issue') {
    if (!confirm(`Delete ${el.dataset.key}?`)) return;
    return run(async () => { await api('DELETE', `/api/issues/${el.dataset.key}`); await refreshProject(); go('#/board'); });
  }
  if (act === 'unlink') return run(async () => {
    await api('DELETE', `/api/issues/${el.dataset.key}/links?type=${encodeURIComponent(el.dataset.type)}&target=${encodeURIComponent(el.dataset.target)}`);
  });
  if (act === 'edit-comment') {
    const body = prompt('Edit comment');
    if (body == null) return;
    return run(async () => { await api('PATCH', `/api/comments/${el.dataset.id}`, { body }); });
  }
  if (act === 'ws-remove') return run(async () => { await api('DELETE', `/api/workspaces/${S.ws.id}/members/${el.dataset.user}`); await selectWorkspace(S.ws.id, false); });
  if (act === 'pm-remove') return run(async () => { await api('DELETE', `/api/projects/${S.project.id}/members/${el.dataset.user}`); await refreshProject(); });
  if (act === 'wf-add') return run(async () => {
    const wf = readWorkflowForm(true);
    wf.statuses.push({ name: `Status ${wf.statuses.length + 1}`, category: 'started' });
    S.project.workflow = wf;
    S.flash = 'Added a status row — rename it, then save the workflow.';
  });
  if (act === 'wf-remove') return run(async () => {
    const wf = readWorkflowForm(true);
    wf.statuses.splice(Number(el.dataset.idx), 1);
    S.project.workflow = wf;
  });
  if (act === 'export-csv') return run(async () => {
    const res = await fetch(`/api/projects/${S.project.id}/export.csv`, { headers: { authorization: `Bearer ${S.token}` } });
    if (!res.ok) throw new Error('export failed');
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a');
    a.href = url;
    a.download = `${S.project.key}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  });
  if (act === 'hook-delete') return run(async () => { await api('DELETE', `/api/webhooks/${el.dataset.id}`); await render(); });
  if (act === 'hook-deliveries') {
    const target = document.getElementById(`deliveries-${el.dataset.id}`);
    try {
      const list = await api('GET', `/api/webhooks/${el.dataset.id}/deliveries`);
      target.innerHTML = list.slice(-10).reverse().map((d) => `<div class="muted">${esc(d.event)} · status ${esc(d.status)} · attempts ${d.attempts}${d.lastError ? ` · ${esc(d.lastError)}` : ''}</div>`).join('') || '<div class="muted">No deliveries yet</div>';
    } catch (err) { target.innerHTML = `<div class="err">${esc(err.message)}</div>`; }
  }
});

function readWorkflowForm(includeTransitions = false) {
  const statuses = [];
  document.querySelectorAll('[data-status-name]').forEach((input) => {
    const idx = input.dataset.statusName;
    statuses.push({ name: input.value.trim(), category: document.querySelector(`[data-status-cat="${idx}"]`).value });
  });
  const transitions = [];
  document.querySelectorAll('[data-tr]').forEach((cb) => {
    if (cb.checked) transitions.push(cb.dataset.tr.split('|'));
  });
  return { statuses, transitions: includeTransitions ? transitions : undefined, _pairs: transitions };
}

document.addEventListener('submit', async (e) => {
  const form = e.target.closest('[data-form]');
  if (!form) return;
  e.preventDefault();
  const kind = form.dataset.form;
  const f = new FormData(form);
  const val = (k) => String(f.get(k) ?? '').trim();
  if (kind === 'auth') {
    return run(async () => {
      const body = { username: val('username'), password: String(f.get('password')) };
      if (S.loginMode === 'register') {
        if (val('displayName')) body.displayName = val('displayName');
        await api('POST', '/api/auth/register', body);
      }
      const res = await api('POST', '/api/auth/login', body);
      S.token = res.token; localStorage.setItem('pm-token', res.token); S.me = res.user;
      S.loginMode = 'login';
      await loadWorkspaces();
      if (!location.hash) go('#/board');
    });
  }
  if (kind === 'search') return go(`#/search/${encodeURIComponent(val('q'))}`);
  if (kind === 'new-issue') return run(async () => {
    const issue = await api('POST', `/api/projects/${S.project.id}/issues`, { title: val('title'), type: val('type'), priority: val('priority') });
    await refreshProject();
    S.flash = `Created ${issue.key}`;
  });
  if (kind === 'new-sprint') return run(async () => {
    const body = { name: val('name') };
    if (val('startDate')) body.startDate = val('startDate');
    if (val('endDate')) body.endDate = val('endDate');
    await api('POST', `/api/projects/${S.project.id}/sprints`, body);
    await refreshProject();
  });
  if (kind === 'subtask') return run(async () => {
    await api('POST', `/api/projects/${S.project.id}/issues`, { type: 'subtask', title: val('title'), parentId: (await api('GET', `/api/issues/${form.dataset.parent}`)).id });
    await refreshProject();
  });
  if (kind === 'comment') return run(async () => {
    await api('POST', `/api/issues/${form.dataset.key}/comments`, { body: val('body') });
  });
  if (kind === 'link') return run(async () => {
    await api('POST', `/api/issues/${form.dataset.key}/links`, { type: val('type'), target: val('target').toUpperCase() });
  });
  if (kind === 'workflow') return run(async () => {
    const wf = readWorkflowForm(true);
    const remap = {};
    document.querySelectorAll('[data-remap-for]').forEach((sel) => { if (sel.value) remap[sel.dataset.remapFor] = sel.value; });
    const names = wf.statuses.map((s) => s.name);
    const transitions = wf._pairs.filter(([a, b]) => names.includes(a) && names.includes(b));
    await api('PUT', `/api/projects/${S.project.id}/workflow`, { statuses: wf.statuses, transitions, remap });
    await refreshProject();
    S.flash = 'Workflow saved';
  });
  if (kind === 'pm-add') return run(async () => {
    await api('POST', `/api/projects/${S.project.id}/members`, { username: val('username'), role: val('role') });
    await refreshProject();
  });
  if (kind === 'webhook') return run(async () => {
    const events = f.getAll('events');
    await api('POST', `/api/projects/${S.project.id}/webhooks`, { url: val('url'), secret: val('secret'), events });
    S.flash = 'Webhook added';
  });
  if (kind === 'import') return run(async () => {
    const file = f.get('file');
    const text = await file.text();
    const res = await fetch(`/api/projects/${S.project.id}/import.csv`, { method: 'POST', headers: { authorization: `Bearer ${S.token}`, 'content-type': 'text/csv' }, body: text });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message);
    document.getElementById('import-result').innerHTML = `Created ${data.created}. ${data.errors.map((x) => `Line ${x.line}: ${esc(x.message)}`).join('<br>')}`;
    await refreshProject();
  });
  if (kind === 'new-ws') return run(async () => {
    const ws = await api('POST', '/api/workspaces', { name: val('name'), key: val('key') });
    await loadWorkspaces();
    await selectWorkspace(ws.id, false);
    S.flash = `Workspace ${ws.name} created`;
  });
  if (kind === 'new-project') return run(async () => {
    const p = await api('POST', `/api/workspaces/${S.ws.id}/projects`, { name: val('name'), key: val('key') });
    await selectWorkspace(S.ws.id, false);
    await selectProject(p.id, false);
    S.flash = `Project ${p.name} created`;
  });
  if (kind === 'ws-add-member') return run(async () => {
    await api('POST', `/api/workspaces/${S.ws.id}/members`, { username: val('username'), role: val('role') });
    await selectWorkspace(S.ws.id, false);
  });
  if (kind === 'new-token') return run(async () => {
    const t = await api('POST', '/api/tokens', { name: val('name') });
    S.flash = `API token (shown once): ${t.token}`;
  });
});

document.addEventListener('change', async (e) => {
  const el = e.target;
  const kind = el.dataset.change;
  if (!kind) return;
  if (kind === 'ws') return run(() => selectWorkspace(el.value));
  if (kind === 'project') return run(() => selectProject(el.value));
  if (kind === 'move-sprint') return run(async () => {
    await api('PATCH', `/api/issues/${el.dataset.key}`, { sprintId: el.value || null });
    await refreshProject();
  });
  if (kind === 'report-sprint') {
    await loadReport(el.value);
    return;
  }
  if (kind === 'field') return run(async () => {
    const value = el.value === '' ? null : el.value;
    await api('PATCH', `/api/issues/${el.dataset.key}`, { [el.dataset.field]: value });
    await refreshProject();
    S.flash = `${el.dataset.field} updated`;
  });
  if (kind === 'pm-role') return run(async () => {
    await api('PATCH', `/api/projects/${S.project.id}/members/${el.dataset.user}`, { role: el.value });
    await refreshProject();
  });
  if (kind === 'ws-role') return run(async () => {
    await api('PATCH', `/api/workspaces/${S.ws.id}/members/${el.dataset.user}`, { role: el.value });
    await selectWorkspace(S.ws.id, false);
  });
});

// Field blur handlers for text inputs (title, description, points, labels, due date)
document.addEventListener('focusout', (e) => {
  const el = e.target;
  const field = el.dataset.blur;
  if (!field || !canWrite()) return;
  const original = el.defaultValue;
  if (el.value === original) return;
  run(async () => {
    let value = el.value;
    if (field === 'storyPoints') value = value === '' ? null : Number(value);
    if (field === 'labels') value = value.split(',').map((x) => x.trim()).filter(Boolean);
    if (value === '') value = null;
    if (field === 'description' && value === null) value = '';
    await api('PATCH', `/api/issues/${el.dataset.key}`, { [field]: value });
    await refreshProject();
    S.flash = `${field} saved`;
  });
});

// Drag and drop on the board
let dragKey = null;
document.addEventListener('dragstart', (e) => {
  const card = e.target.closest('[data-drag]');
  if (!card) return;
  dragKey = card.dataset.drag;
  e.dataTransfer.setData('text/plain', dragKey);
});
document.addEventListener('dragover', (e) => {
  const col = e.target.closest('[data-drop]');
  if (!col) return;
  e.preventDefault();
  col.classList.add('over');
});
document.addEventListener('dragleave', (e) => {
  e.target.closest?.('[data-drop]')?.classList.remove('over');
});
document.addEventListener('drop', (e) => {
  const col = e.target.closest('[data-drop]');
  if (!col || !dragKey) return;
  e.preventDefault();
  col.classList.remove('over');
  const status = col.dataset.drop;
  const key = dragKey;
  dragKey = null;
  run(async () => {
    await api('PATCH', `/api/issues/${key}`, { status });
    await refreshProject();
  });
});

// Navigation: hash changes re-render the page.
window.addEventListener('hashchange', () => { S.error = ''; render(); });
// Post-render hooks: fill in asynchronously loaded panels.
async function afterRender() {
  const r = route();
  if (r.page === 'sprints') {
    const sel = document.querySelector('[data-change="report-sprint"]');
    if (sel) await loadReport(sel.value);
  } else if (r.page === 'issue') {
    await loadHistory(r.arg).catch(() => {});
  } else if (r.page === 'settings') {
    await loadSettingsExtras().catch((err) => { S.error = err.message; });
  } else if (r.page === 'workspace') {
    await loadAudit().catch(() => {});
  }
}

async function boot() {
  if (!location.hash) location.hash = '#/board';
  if (S.token) {
    try {
      S.me = (await api('GET', '/api/auth/me')).user;
      await loadWorkspaces();
    } catch { S.token = null; localStorage.removeItem('pm-token'); }
  }
  await render();
  // Poll notifications without re-rendering the page, so typed input is kept.
  setInterval(async () => {
    if (!S.token) return;
    await loadNotifications();
    const count = S.notifications.filter((n) => !n.read).length;
    const badge = document.querySelector('.bell .count');
    if (badge) badge.textContent = count || '';
  }, 30000);
}

boot();
