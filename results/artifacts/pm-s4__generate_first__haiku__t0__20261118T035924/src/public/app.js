// pm-s4 single-page app. Uses only the public REST API.

const app = document.getElementById('app');
const state = {
  token: localStorage.getItem('pmToken'),
  me: null,
  workspaces: [],
  ws: null,
  projects: [],
  project: null,
  seq: 0,
};

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString() : '');
const go = (hash) => { location.hash = hash; };

async function api(method, path, body, opts = {}) {
  const headers = {};
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  let payload;
  if (opts.raw !== undefined) {
    headers['content-type'] = opts.contentType || 'text/csv';
    payload = opts.raw;
  } else if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const res = await fetch(path, { method, headers, body: payload });
  if (res.status === 204) return null;
  const isJson = (res.headers.get('content-type') || '').includes('json');
  const data = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error((data && data.message) || res.statusText);
    err.status = res.status;
    err.code = data && data.error;
    throw err;
  }
  return data;
}

function parseRoute() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [pathPart, queryPart = ''] = raw.split('?');
  const seg = pathPart.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
  return { seg, q: new URLSearchParams(queryPart) };
}

function alertErr(err) {
  window.alert(err.message || String(err));
}

// Maps user ids to usernames using whatever project/member data is loaded.
const nameCache = {};
function nameOf(uid) {
  if (!uid) return 'unassigned';
  if (state.me && uid === state.me.id) return state.me.username;
  if (state.project) {
    const m = state.project.members.find((x) => x.userId === uid);
    if (m) return m.username;
  }
  return nameCache[uid] || uid.slice(0, 8);
}

// ---------- shell & routing ----------
async function render() {
  const my = ++state.seq;
  const r = parseRoute();
  try {
    if (!state.token) return renderLogin();
    if (!state.me) {
      try {
        state.me = (await api('GET', '/api/auth/me')).user;
      } catch (e) {
        state.token = null;
        localStorage.removeItem('pmToken');
        return renderLogin();
      }
    }
    state.workspaces = await api('GET', '/api/workspaces');
    if (my !== state.seq) return;

    const [kind, a, b, c, d] = r.seg;
    if (kind === 'issue' && a) {
      const issue = await api('GET', `/api/issues/${encodeURIComponent(a)}`);
      await loadProjectContext(issue.projectId);
      if (my !== state.seq) return;
      return withShell(r, () => viewIssue(issue, r));
    }
    if (kind === 'w' && a) {
      state.ws = state.workspaces.find((w) => w.id === a) || null;
      if (!state.ws) throw new Error('Workspace not found or not accessible');
      state.projects = await api('GET', `/api/workspaces/${a}/projects`);
      if (b === 'p' && c) {
        state.project = await api('GET', `/api/projects/${c}`);
        if (my !== state.seq) return;
        return withShell(r, () => {
          if (d === 'backlog') return viewBacklog();
          if (d === 'sprint' && r.seg[5]) return viewSprint(r.seg[5]);
          if (d === 'settings') return viewSettings();
          if (d === 'search') return viewSearch(r);
          return viewBoard();
        });
      }
      return withShell(r, () => viewWorkspace());
    }
    if (kind === 'search') return withShell(r, () => viewSearch(r));

    // Home: send the user to their first project, or the workspace page.
    if (state.workspaces.length) {
      const ws = state.workspaces[0];
      const projects = await api('GET', `/api/workspaces/${ws.id}/projects`);
      if (projects.length) return go(`#/w/${ws.id}/p/${projects[0].id}/board`);
      return go(`#/w/${ws.id}`);
    }
    state.ws = null; state.project = null; state.projects = [];
    return withShell(r, () => {
      app.querySelector('main').innerHTML = `
        <div class="card-box">
          <h2>Welcome</h2>
          <p class="muted">You are not in any workspace yet. Create one to get started.</p>
          <form id="newWs" class="row">
            <input name="name" placeholder="Workspace name" required>
            <input name="key" placeholder="KEY (2-10 caps)" pattern="[A-Z]{2,10}" required>
            <button class="primary">Create workspace</button>
          </form>
          <p class="error" id="err"></p>
        </div>`;
      $('#newWs').onsubmit = async (ev) => {
        ev.preventDefault();
        const f = Object.fromEntries(new FormData(ev.target));
        try { const ws = await api('POST', '/api/workspaces', f); go(`#/w/${ws.id}`); } catch (e) { $('#err').textContent = e.message; }
      };
    });
  } catch (err) {
    app.innerHTML = `<main><p class="error">${esc(err.message)}</p><p><a href="#/">Back to start</a></p></main>`;
  }
}

async function loadProjectContext(projectId) {
  state.project = await api('GET', `/api/projects/${projectId}`);
  state.ws = state.workspaces.find((w) => w.id === state.project.workspaceId) || null;
  state.projects = state.ws ? await api('GET', `/api/workspaces/${state.ws.id}/projects`) : [];
}

async function withShell(r, body) {
  app.innerHTML = `${header(r)}<main id="main"></main>`;
  bindHeader();
  await body();
}

function header(r) {
  const wsOpts = state.workspaces.map((w) => `<option value="${w.id}" ${state.ws && w.id === state.ws.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('');
  const pOpts = state.projects.map((p) => `<option value="${p.id}" ${state.project && p.id === state.project.id ? 'selected' : ''}>${esc(p.key)} · ${esc(p.name)}</option>`).join('');
  const nav = state.project ? `
    <a href="#/w/${state.ws.id}/p/${state.project.id}/board">Board</a>
    <a href="#/w/${state.ws.id}/p/${state.project.id}/backlog">Backlog</a>
    <a href="#/w/${state.ws.id}/p/${state.project.id}/settings">Settings</a>` : '';
  return `
    <header class="top">
      <strong class="brand">pm-s4</strong>
      <select id="wsSel"><option value="">Workspace…</option>${wsOpts}</select>
      <select id="pSel" ${state.ws ? '' : 'disabled'}><option value="">Project…</option>${pOpts}</select>
      ${nav}
      ${state.ws ? `<a href="#/w/${state.ws.id}">Workspace</a>` : ''}
      <form id="searchForm"><input id="q" size="36" placeholder='Search e.g. status:"In Progress" -label:wontfix' value="${esc(r.q.get('q') || '')}"></form>
      <button id="bell" title="Notifications">🔔 <span id="unread"></span></button>
      <span class="me">${esc(state.me.displayName)} <button id="logout" class="link" style="color:#fff">Log out</button></span>
    </header>
    <div id="notif" class="panel hidden"></div>`;
}

function bindHeader() {
  $('#wsSel').onchange = (e) => e.target.value && go(`#/w/${e.target.value}`);
  $('#pSel').onchange = (e) => e.target.value && state.ws && go(`#/w/${state.ws.id}/p/${e.target.value}/board`);
  $('#searchForm').onsubmit = (e) => {
    e.preventDefault();
    const q = $('#q').value;
    const pid = state.project ? `&project=${state.project.id}` : '';
    go(`#/search?q=${encodeURIComponent(q)}${pid}`);
  };
  $('#logout').onclick = async () => {
    try { await api('POST', '/api/auth/logout'); } catch (e) { /* ignore */ }
    localStorage.removeItem('pmToken');
    state.token = null; state.me = null;
    go('#/login');
    render();
  };
  $('#bell').onclick = toggleNotifications;
  refreshUnread();
}

async function refreshUnread() {
  try {
    const list = await api('GET', '/api/notifications?unread=true');
    const el = $('#unread');
    if (el) el.textContent = list.length ? String(list.length) : '';
  } catch (e) { /* ignore */ }
}

async function toggleNotifications() {
  const panel = $('#notif');
  if (!panel.classList.contains('hidden')) { panel.classList.add('hidden'); return; }
  const list = await api('GET', '/api/notifications');
  const label = {
    status_changed: 'changed status of',
    assigned: 'assigned',
    comment: 'commented on',
    mention: 'mentioned you in',
  };
  panel.innerHTML = `
    <div class="row"><strong>Notifications</strong><button id="markAll" class="link" style="margin-left:auto">Mark all read</button></div>
    ${list.length ? list.map((n) => `
      <div class="n ${n.read ? '' : 'unread'}" data-key="${esc(n.issueKey)}" data-id="${esc(n.id)}">
        ${esc(n.actorId === state.me.id ? 'You' : nameOf(n.actorId))} ${esc(label[n.type] || n.type)} <a href="#/issue/${esc(n.issueKey)}">${esc(n.issueKey)}</a>
        <div class="muted">${fmtDate(n.at)}</div>
      </div>`).join('') : '<p class="muted">No notifications.</p>'}`;
  panel.classList.remove('hidden');
  $('#markAll').onclick = async () => {
    await api('POST', '/api/notifications/read', { all: true });
    panel.classList.add('hidden');
    refreshUnread();
  };
  panel.querySelectorAll('.n').forEach((el) => el.onclick = async () => {
    await api('POST', '/api/notifications/read', { ids: [el.dataset.id] });
    panel.classList.add('hidden');
    go(`#/issue/${el.dataset.key}`);
  });
}

// ---------- auth ----------
function renderLogin(mode = 'login', msg = '') {
  app.innerHTML = `
    <div class="auth">
      <h1>pm-s4</h1>
      <form id="authForm">
        <label>Username <input name="username" required autocomplete="username"></label>
        ${mode === 'register' ? '<label>Display name <input name="displayName" autocomplete="name"></label>' : ''}
        <label>Password <input type="password" name="password" required minlength="8" autocomplete="current-password"></label>
        <p><button class="primary">${mode === 'login' ? 'Log in' : 'Register'}</button></p>
        <p><button type="button" id="toggleMode" class="link">${mode === 'login' ? 'Create an account' : 'Have an account? Log in'}</button></p>
        <p class="error" id="authErr">${esc(msg)}</p>
      </form>
    </div>`;
  $('#toggleMode').onclick = () => renderLogin(mode === 'login' ? 'register' : 'login');
  $('#authForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try {
      if (mode === 'register') await api('POST', '/api/auth/register', f);
      const r = await api('POST', '/api/auth/login', { username: f.username, password: f.password });
      state.token = r.token;
      state.me = r.user;
      localStorage.setItem('pmToken', r.token);
      go('#/');
      render();
    } catch (err) {
      renderLogin(mode, err.message);
    }
  };
}

// ---------- board ----------
function card(i) {
  const pts = i.storyPoints != null ? ` · ${i.storyPoints}pt` : '';
  return `
    <div class="card" draggable="true" data-key="${esc(i.key)}">
      <a href="#/issue/${esc(i.key)}">${esc(i.key)}</a> <span class="badge">${esc(i.type)}</span>
      <div class="title">${esc(i.title)}</div>
      <div class="meta">${esc(i.priority)} · ${esc(i.assignee || 'unassigned')}${pts}</div>
    </div>`;
}

async function viewBoard() {
  const p = state.project;
  const issues = await api('GET', `/api/projects/${p.id}/issues`);
  const types = ['task', 'bug', 'feature', 'epic'];
  const cols = p.workflow.statuses.map((s) => {
    const items = issues.filter((i) => i.status === s.name);
    return `
      <div class="col" data-status="${esc(s.name)}">
        <h3>${esc(s.name)} <span class="cnt">${items.length}</span></h3>
        ${items.map(card).join('')}
      </div>`;
  }).join('');
  $('#main').innerHTML = `
    <form id="newIssue" class="row">
      <select name="type">${types.map((t) => `<option>${t}</option>`).join('')}</select>
      <input name="title" placeholder="What needs to be done?" required size="40">
      <button class="primary">Create issue</button>
    </form>
    <div class="board">${cols}</div>
    <p class="error" id="err"></p>`;

  $('#newIssue').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try { await api('POST', `/api/projects/${p.id}/issues`, f); viewBoard(); } catch (err) { alertErr(err); }
  };
  $('#main').querySelectorAll('.card').forEach((el) => {
    el.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', el.dataset.key));
  });
  $('#main').querySelectorAll('.col').forEach((col) => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('over'); });
    col.addEventListener('dragleave', () => col.classList.remove('over'));
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('over');
      const key = e.dataTransfer.getData('text/plain');
      const current = issues.find((i) => i.key === key);
      if (!current || current.status === col.dataset.status) return;
      try {
        await api('PATCH', `/api/issues/${key}`, { status: col.dataset.status });
        viewBoard();
      } catch (err) {
        alertErr(err);
      }
    });
  });
}

// ---------- backlog & sprints ----------
async function viewBacklog() {
  const p = state.project;
  const [issues, sprints] = await Promise.all([
    api('GET', `/api/projects/${p.id}/issues`),
    api('GET', `/api/projects/${p.id}/sprints`),
  ]);
  for (const i of issues) nameCache[i.assigneeId] = i.assignee;
  const open = sprints.filter((s) => s.state !== 'completed');
  const moveSelect = (issue) => `
    <select data-move="${esc(issue.key)}">
      <option value="">Backlog</option>
      ${open.map((s) => `<option value="${s.id}" ${issue.sprintId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}
    </select>`;
  const row = (i) => `
    <div class="issue-row">
      <a href="#/issue/${esc(i.key)}">${esc(i.key)}</a>
      <span class="t">${esc(i.title)} <span class="badge">${esc(i.status)}</span></span>
      <span class="muted">${i.storyPoints ?? ''}</span>
      ${moveSelect(i)}
    </div>`;
  const backlogItems = issues.filter((i) => !i.sprintId);
  const sprintBlocks = sprints.map((s) => {
    const items = issues.filter((i) => i.sprintId === s.id);
    const actions = s.state === 'planned'
      ? `<button data-start="${s.id}" class="primary">Start sprint</button>`
      : s.state === 'active'
        ? `<select id="carry-${s.id}">
             <option value="backlog">Backlog</option>
             ${open.filter((o) => o.id !== s.id && o.state !== 'completed').map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}
           </select>
           <button data-complete="${s.id}" class="primary">Complete sprint</button>`
        : '';
    return `
      <section class="card-box">
        <div class="row">
          <h3 style="margin:0">${esc(s.name)} <span class="badge">${esc(s.state)}</span></h3>
          <span class="muted">${esc(s.startDate || '')} ${s.endDate ? '→ ' + esc(s.endDate) : ''}</span>
          <a href="#/w/${state.ws.id}/p/${p.id}/sprint/${s.id}" style="margin-left:auto">Report</a>
        </div>
        ${items.map(row).join('') || '<p class="muted">No issues in this sprint.</p>'}
        <div class="row">${actions}</div>
      </section>`;
  }).join('');
  $('#main').innerHTML = `
    <div class="grid">
      <div>
        <h2>Backlog</h2>
        <div class="card-box">${backlogItems.map(row).join('') || '<p class="muted">Backlog is empty.</p>'}</div>
      </div>
      <div>
        <h2>Sprints</h2>
        <form id="newSprint" class="card-box">
          <strong>New sprint</strong>
          <label>Name <input name="name" required></label>
          <label>Start <input type="date" name="startDate"></label>
          <label>End <input type="date" name="endDate"></label>
          <button class="primary">Create sprint</button>
        </form>
        ${sprintBlocks}
      </div>
    </div>
    <p class="error" id="err"></p>`;

  $('#newSprint').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    if (!f.startDate) delete f.startDate;
    if (!f.endDate) delete f.endDate;
    try { await api('POST', `/api/projects/${p.id}/sprints`, f); viewBacklog(); } catch (err) { alertErr(err); }
  };
  $('#main').querySelectorAll('select[data-move]').forEach((sel) => sel.onchange = async () => {
    try {
      await api('PATCH', `/api/issues/${sel.dataset.move}`, { sprintId: sel.value || null });
      viewBacklog();
    } catch (err) { alertErr(err); }
  });
  $('#main').querySelectorAll('[data-start]').forEach((btn) => btn.onclick = async () => {
    try { await api('POST', `/api/sprints/${btn.dataset.start}/start`); viewBacklog(); } catch (err) { alertErr(err); }
  });
  $('#main').querySelectorAll('[data-complete]').forEach((btn) => btn.onclick = async () => {
    const carryOverTo = $(`#carry-${btn.dataset.complete}`).value;
    try { await api('POST', `/api/sprints/${btn.dataset.complete}/complete`, { carryOverTo }); viewBacklog(); } catch (err) { alertErr(err); }
  });
}

async function viewSprint(sid) {
  const [sprint, report] = await Promise.all([
    api('GET', `/api/sprints/${sid}`),
    api('GET', `/api/sprints/${sid}/report`),
  ]);
  const pts = report.burndown;
  const W = 640; const H = 260; const PAD = 30;
  const max = Math.max(1, report.committedPoints, ...pts.map((d) => d.remainingPoints));
  const x = (i) => (pts.length <= 1 ? PAD : PAD + (i * (W - 2 * PAD)) / (pts.length - 1));
  const y = (v) => H - PAD - (v * (H - 2 * PAD)) / max;
  const actual = pts.map((d, i) => `${x(i)},${y(d.remainingPoints)}`).join(' ');
  const ideal = pts.length ? `${x(0)},${y(report.committedPoints)} ${x(pts.length - 1)},${y(0)}` : '';
  const svg = pts.length ? `
    <svg class="burndown" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">
      <line x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}" stroke="#c1c7d0"/>
      <line x1="${PAD}" y1="${PAD}" x2="${PAD}" y2="${H - PAD}" stroke="#c1c7d0"/>
      <text x="4" y="${PAD}" font-size="11">${max}</text>
      <text x="4" y="${H - PAD}" font-size="11">0</text>
      <polyline class="ideal" points="${ideal}"/>
      <polyline class="actual" points="${actual}"/>
      ${pts.map((d, i) => `<circle cx="${x(i)}" cy="${y(d.remainingPoints)}" r="3" fill="#0052cc"><title>${esc(d.date)}: ${d.remainingPoints} pts</title></circle>`).join('')}
      <text x="${PAD}" y="${H - 8}" font-size="11">${esc(pts[0].date)}</text>
      <text x="${W - PAD}" y="${H - 8}" font-size="11" text-anchor="end">${esc(pts[pts.length - 1].date)}</text>
    </svg>` : '<p class="muted">No burndown data yet (sprint has no start date).</p>';
  $('#main').innerHTML = `
    <h2>${esc(sprint.name)} <span class="badge">${esc(sprint.state)}</span></h2>
    <div class="card-box">
      <p>Committed points: <strong>${report.committedPoints}</strong> ·
         Completed points: <strong>${report.completedPoints}</strong> ·
         Completed issues: <strong>${report.completedIssues.length}</strong> ·
         Carried over: <strong>${report.carriedOver.length}</strong></p>
      ${svg}
    </div>
    <div class="card-box">
      <h3>Completed</h3>
      ${report.completedIssues.map((k) => `<div><a href="#/issue/${esc(k)}">${esc(k)}</a></div>`).join('') || '<p class="muted">None</p>'}
      <h3>Carried over</h3>
      ${report.carriedOver.map((k) => `<div><a href="#/issue/${esc(k)}">${esc(k)}</a></div>`).join('') || '<p class="muted">None</p>'}
    </div>`;
}

// ---------- issue detail ----------
async function viewIssue(issue, r) {
  const p = state.project;
  const [comments, history] = await Promise.all([
    api('GET', `/api/issues/${issue.key}/comments`),
    api('GET', `/api/issues/${issue.key}/history`),
  ]);
  const statuses = p.workflow.statuses.map((s) => s.name);
  const allowed = new Set([issue.status, ...p.workflow.transitions.filter(([a]) => a === issue.status).map(([, b]) => b)]);
  const sprints = await api('GET', `/api/projects/${p.id}/sprints`);
  const sprint = sprints.find((s) => s.id === issue.sprintId);
  const watching = issue.watchers.includes(state.me.id);
  const parent = issue.parentId ? issue.parentId : null;
  const isParentKey = parent ? issue.children : [];
  $('#main').innerHTML = `
    <h2>${esc(issue.key)} <span class="badge">${esc(issue.type)}</span></h2>
    <div class="grid">
      <div>
        <div class="card-box">
          <form id="issueForm">
            <label>Title <input name="title" value="${esc(issue.title)}" required></label>
            <label>Description <textarea name="description">${esc(issue.description)}</textarea></label>
            <div class="row">
              <label style="flex:1">Status
                <select name="status">${statuses.map((s) => `<option ${s === issue.status ? 'selected' : ''} ${allowed.has(s) ? '' : 'disabled'}>${esc(s)}</option>`).join('')}</select>
              </label>
              <label style="flex:1">Type
                <select name="type">${['task', 'bug', 'feature', 'epic', 'subtask'].map((t) => `<option ${t === issue.type ? 'selected' : ''} ${t === 'subtask' && !issue.parentId ? 'disabled' : ''}>${t}</option>`).join('')}</select>
              </label>
              <label style="flex:1">Priority
                <select name="priority">${['urgent', 'high', 'medium', 'low', 'none'].map((t) => `<option ${t === issue.priority ? 'selected' : ''}>${t}</option>`).join('')}</select>
              </label>
            </div>
            <div class="row">
              <label style="flex:1">Assignee
                <select name="assigneeId">
                  <option value="">Unassigned</option>
                  ${p.members.map((m) => `<option value="${m.userId}" ${m.userId === issue.assigneeId ? 'selected' : ''}>${esc(m.username)}</option>`).join('')}
                </select>
              </label>
              <label style="flex:1">Story points <input type="number" min="0" step="any" name="storyPoints" value="${issue.storyPoints ?? ''}"></label>
              <label style="flex:1">Due date <input type="date" name="dueDate" value="${esc(issue.dueDate || '')}"></label>
            </div>
            <label>Labels (comma separated) <input name="labels" value="${esc(issue.labels.join(', '))}"></label>
            <p class="muted">Sprint: ${sprint ? esc(sprint.name) : 'Backlog'} · Reporter: ${esc(nameOf(issue.reporterId))} · Updated ${fmtDate(issue.updatedAt)}</p>
            <div class="row">
              <button class="primary">Save</button>
              <button type="button" id="watchBtn">${watching ? 'Unwatch' : 'Watch'}</button>
              <button type="button" id="deleteBtn" class="danger" style="margin-left:auto">Delete issue</button>
            </div>
            <p class="error" id="err"></p>
          </form>
        </div>

        <div class="card-box">
          <h3>Comments</h3>
          ${comments.map((c) => `
            <div class="comment">
              <div class="who">${esc(nameOf(c.authorId))} · ${fmtDate(c.createdAt)} ${c.edited ? '(edited)' : ''}
                ${c.authorId === state.me.id ? `<button class="link" data-edit="${esc(c.id)}">edit</button>` : ''}</div>
              <div>${esc(c.body)}</div>
            </div>`).join('') || '<p class="muted">No comments.</p>'}
          <form id="commentForm" class="row">
            <textarea name="body" placeholder="Add a comment. Mention people with @username"></textarea>
            <button class="primary">Comment</button>
          </form>
        </div>

        <div class="card-box">
          <h3>History</h3>
          ${history.slice().reverse().map((h) => `
            <div class="muted">${fmtDate(h.at)} · ${esc(nameOf(h.actorId))} changed <strong>${esc(h.field)}</strong>
              from <code>${esc(JSON.stringify(h.from))}</code> to <code>${esc(JSON.stringify(h.to))}</code></div>`).join('') || '<p class="muted">No changes yet.</p>'}
        </div>
      </div>

      <aside>
        ${issue.type === 'epic' ? `
          <div class="card-box">
            <h3>Epic progress</h3>
            <p>${issue.progress.done}/${issue.progress.total} issues done ·
               ${issue.progress.points_done}/${issue.progress.points_total} points</p>
          </div>` : ''}
        ${issue.parentId ? `<div class="card-box"><h3>Parent</h3><a href="#/issue/${esc(issue.parentId)}">${esc(issue.parentId)}</a></div>` : ''}
        <div class="card-box">
          <h3>Subtasks</h3>
          ${isParentKey.map((k) => `<div><a href="#/issue/${esc(k)}">${esc(k)}</a></div>`).join('') || '<p class="muted">None</p>'}
          <form id="subtaskForm" class="row">
            <input name="title" placeholder="New subtask" required style="flex:1">
            <button>Add</button>
          </form>
        </div>
        <div class="card-box">
          <h3>Links</h3>
          ${issue.links.map((l, idx) => `
            <div class="issue-row"><span class="t">${esc(l.type)} <a href="#/issue/${esc(l.target)}">${esc(l.target)}</a></span>
              <button class="link danger" data-unlink="${idx}">remove</button></div>`).join('') || '<p class="muted">No links.</p>'}
          <form id="linkForm" class="row">
            <select name="type"><option>blocks</option><option>relates</option><option>duplicates</option></select>
            <input name="target" placeholder="KEY-12" required size="8">
            <button>Link</button>
          </form>
        </div>
        ${issue.epicId ? `<div class="card-box"><h3>Epic</h3><a href="#/issue/${esc(issue.epicId)}">${esc(issue.epicId)}</a></div>` : ''}
      </aside>
    </div>`;

  $('#issueForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = {};
    const fields = {
      title: f.get('title'),
      description: f.get('description'),
      status: f.get('status'),
      type: f.get('type'),
      priority: f.get('priority'),
      storyPoints: f.get('storyPoints') === '' ? null : Number(f.get('storyPoints')),
      dueDate: f.get('dueDate') || null,
      labels: String(f.get('labels') || '').split(',').map((s) => s.trim()).filter(Boolean),
    };
    for (const [k, v] of Object.entries(fields)) {
      const before = issue[k];
      if (JSON.stringify(before ?? null) !== JSON.stringify(v ?? null)) body[k] = v;
    }
    const assigneeId = f.get('assigneeId') || null;
    if (assigneeId !== (issue.assigneeId || null)) body.assigneeId = assigneeId;
    try {
      if (Object.keys(body).length) await api('PATCH', `/api/issues/${issue.key}`, body);
      render();
    } catch (err) {
      $('#err').textContent = err.message;
    }
  };
  $('#watchBtn').onclick = async () => {
    try {
      await api(watching ? 'DELETE' : 'POST', `/api/issues/${issue.key}/watch`);
      render();
    } catch (err) { alertErr(err); }
  };
  $('#deleteBtn').onclick = async () => {
    if (!window.confirm(`Delete ${issue.key} and its subtasks?`)) return;
    try {
      await api('DELETE', `/api/issues/${issue.key}`);
      go(`#/w/${state.ws.id}/p/${p.id}/board`);
    } catch (err) { alertErr(err); }
  };
  $('#commentForm').onsubmit = async (e) => {
    e.preventDefault();
    const body = new FormData(e.target).get('body');
    try { await api('POST', `/api/issues/${issue.key}/comments`, { body }); render(); } catch (err) { alertErr(err); }
  };
  document.querySelectorAll('[data-edit]').forEach((btn) => btn.onclick = async () => {
    const c = comments.find((x) => x.id === btn.dataset.edit);
    const body = window.prompt('Edit comment', c.body);
    if (body === null) return;
    try { await api('PATCH', `/api/comments/${c.id}`, { body }); render(); } catch (err) { alertErr(err); }
  });
  $('#subtaskForm').onsubmit = async (e) => {
    e.preventDefault();
    const title = new FormData(e.target).get('title');
    try {
      await api('POST', `/api/projects/${p.id}/issues`, { title, type: 'subtask', parentId: issue.id });
      render();
    } catch (err) { alertErr(err); }
  };
  $('#linkForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try { await api('POST', `/api/issues/${issue.key}/links`, f); render(); } catch (err) { alertErr(err); }
  };
  document.querySelectorAll('[data-unlink]').forEach((btn) => btn.onclick = async () => {
    const l = issue.links[Number(btn.dataset.unlink)];
    try { await api('DELETE', `/api/issues/${issue.key}/links/${l.type}/${l.target}`); render(); } catch (err) { alertErr(err); }
  });
}

// ---------- search ----------
async function viewSearch(r) {
  const q = r.q.get('q') || '';
  const project = r.q.get('project') || '';
  $('#main').innerHTML = `
    <h2>Search</h2>
    <form id="sf" class="row">
      <input name="q" value="${esc(q)}" size="60" placeholder='status:"In Progress" type:bug -label:wontfix points:>3 due:<2027-01-01'>
      <select name="sort"><option value="updated">Recently updated</option><option value="created">Recently created</option><option value="priority">Priority</option></select>
      <button class="primary">Search</button>
    </form>
    <div id="results"></div>`;
  $('#sf').onsubmit = (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const pid = project ? `&project=${project}` : '';
    go(`#/search?q=${encodeURIComponent(f.q)}${pid}`);
  };
  if (!q) return;
  try {
    const params = new URLSearchParams({ q });
    if (project) params.set('project', project);
    const list = await api('GET', `/api/search?${params}`);
    $('#results').innerHTML = `<table><thead><tr><th>Key</th><th>Title</th><th>Status</th><th>Priority</th><th>Assignee</th></tr></thead><tbody>
      ${list.map((i) => `<tr><td><a href="#/issue/${esc(i.key)}">${esc(i.key)}</a></td><td>${esc(i.title)}</td><td>${esc(i.status)}</td><td>${esc(i.priority)}</td><td>${esc(i.assignee || '')}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No matches.</td></tr>'}
      </tbody></table>`;
  } catch (err) {
    $('#results').innerHTML = `<p class="error">${esc(err.message)}</p>`;
  }
}

// ---------- workspace ----------
async function viewWorkspace() {
  const ws = state.ws;
  const members = await api('GET', `/api/workspaces/${ws.id}/members`);
  const isAdmin = ws.role === 'admin';
  let audit = [];
  if (isAdmin) { try { audit = await api('GET', `/api/workspaces/${ws.id}/audit`); } catch (e) { audit = []; } }
  $('#main').innerHTML = `
    <h2>${esc(ws.name)} <span class="muted">(${esc(ws.key)}) · your role: ${esc(ws.role)}</span></h2>
    <div class="grid">
      <div>
        <div class="card-box">
          <h3>Projects</h3>
          ${state.projects.map((p) => `<div><a href="#/w/${ws.id}/p/${p.id}/board">${esc(p.key)} · ${esc(p.name)}</a></div>`).join('') || '<p class="muted">No projects you can see.</p>'}
          ${ws.role !== 'guest' ? `
          <form id="newProject" class="row">
            <input name="name" placeholder="Project name" required>
            <input name="key" placeholder="KEY" pattern="[A-Z]{2,10}" required size="8">
            <button>Create project</button>
          </form>` : ''}
        </div>
        ${isAdmin ? `
        <div class="card-box">
          <h3>Audit log</h3>
          ${audit.slice(0, 100).map((a) => `<div class="muted">${fmtDate(a.at)} · ${esc(a.action)} · ${esc(nameOf(a.actorId))}</div>`).join('') || '<p class="muted">Empty.</p>'}
        </div>` : ''}
      </div>
      <div>
        <div class="card-box">
          <h3>Members</h3>
          ${members.map((m) => `
            <div class="issue-row"><span class="t">${esc(m.username)}</span>
              ${isAdmin ? `<select data-wsrole="${esc(m.username)}">
                ${['admin', 'member', 'guest'].map((r) => `<option ${r === m.role ? 'selected' : ''}>${r}</option>`).join('')}
              </select>
              <button class="link danger" data-wsremove="${esc(m.username)}">remove</button>` : `<span class="badge">${esc(m.role)}</span>`}
            </div>`).join('')}
          ${isAdmin ? `
          <form id="addWsMember" class="row">
            <input name="username" placeholder="username" required size="12">
            <select name="role"><option>member</option><option>admin</option><option>guest</option></select>
            <button>Add</button>
          </form>` : ''}
        </div>
      </div>
    </div>
    <p class="error" id="err"></p>`;

  if ($('#newProject')) {
    $('#newProject').onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      try { const pr = await api('POST', `/api/workspaces/${ws.id}/projects`, f); go(`#/w/${ws.id}/p/${pr.id}/board`); } catch (err) { alertErr(err); }
    };
  }
  if ($('#addWsMember')) {
    $('#addWsMember').onsubmit = async (e) => {
      e.preventDefault();
      try { await api('POST', `/api/workspaces/${ws.id}/members`, Object.fromEntries(new FormData(e.target))); viewWorkspace(); } catch (err) { alertErr(err); }
    };
  }
  document.querySelectorAll('[data-wsrole]').forEach((sel) => sel.onchange = async () => {
    try { await api('PATCH', `/api/workspaces/${ws.id}/members/${encodeURIComponent(sel.dataset.wsrole)}`, { role: sel.value }); viewWorkspace(); } catch (err) { alertErr(err); }
  });
  document.querySelectorAll('[data-wsremove]').forEach((btn) => btn.onclick = async () => {
    if (!window.confirm(`Remove ${btn.dataset.wsremove} from workspace?`)) return;
    try { await api('DELETE', `/api/workspaces/${ws.id}/members/${encodeURIComponent(btn.dataset.wsremove)}`); viewWorkspace(); } catch (err) { alertErr(err); }
  });
}

// ---------- project settings ----------
async function viewSettings() {
  const p = state.project;
  const [wf, hooks] = await Promise.all([
    api('GET', `/api/projects/${p.id}/workflow`),
    api('GET', `/api/projects/${p.id}/webhooks`).catch(() => null),
  ]);
  const cats = ['backlog', 'unstarted', 'started', 'completed'];
  $('#main').innerHTML = `
    <h2>${esc(p.key)} · ${esc(p.name)} settings</h2>
    <div class="grid">
      <div>
        <div class="card-box">
          <h3>Workflow</h3>
          <div id="statuses">
            ${wf.statuses.map((s) => `
              <div class="row st-row">
                <input name="sname" value="${esc(s.name)}" required>
                <select name="scat">${cats.map((c) => `<option ${c === s.category ? 'selected' : ''}>${c}</option>`).join('')}</select>
                <button type="button" class="link danger" data-rm>remove</button>
              </div>`).join('')}
          </div>
          <div class="row">
            <button type="button" id="addStatus">Add status</button>
          </div>
          <label>Transitions (one per line: <code>From -> To</code>)
            <textarea id="transitions">${wf.transitions.map(([a, b]) => `${a} -> ${b}`).join('\n')}</textarea>
          </label>
          <div class="row">
            <button type="button" id="allTransitions">Allow any → any</button>
          </div>
          <label>Remap for removed statuses (JSON, e.g. {"Old": "New"})
            <textarea id="remap">{}</textarea>
          </label>
          <div class="row"><button class="primary" id="saveWf">Save workflow</button></div>
          <p class="error" id="wfErr"></p>
        </div>

        <div class="card-box">
          <h3>Project name</h3>
          <form id="projName" class="row">
            <input name="name" value="${esc(p.name)}" required>
            <button>Save</button>
          </form>
        </div>

        <div class="card-box">
          <h3>Import / export issues (CSV)</h3>
          <div class="row">
            <button id="exportBtn">Export CSV</button>
            <input type="file" id="importFile" accept=".csv,text/csv">
          </div>
          <pre class="raw hidden" id="importResult"></pre>
        </div>
      </div>

      <div>
        <div class="card-box">
          <h3>Members</h3>
          ${p.members.map((m) => `
            <div class="issue-row"><span class="t">${esc(m.username)}</span>
              <select data-prole="${esc(m.username)}">
                ${['lead', 'developer', 'viewer'].map((r) => `<option ${r === m.role ? 'selected' : ''}>${r}</option>`).join('')}
              </select>
              <button class="link danger" data-premove="${esc(m.username)}">remove</button>
            </div>`).join('')}
          <form id="addMember" class="row">
            <input name="username" placeholder="username" required size="12">
            <select name="role"><option>developer</option><option>lead</option><option>viewer</option></select>
            <button>Add</button>
          </form>
        </div>

        <div class="card-box">
          <h3>Webhooks</h3>
          ${(hooks || []).map((h) => `
            <div class="issue-row">
              <span class="t">${esc(h.url)} <span class="muted">${h.events.join(', ')}</span></span>
              <button class="link" data-deliv="${esc(h.id)}">deliveries</button>
              <button class="link danger" data-hookdel="${esc(h.id)}">delete</button>
            </div>
            <div id="deliv-${esc(h.id)}"></div>`).join('') || '<p class="muted">No webhooks.</p>'}
          ${hooks === null ? '<p class="muted">Only project leads can manage webhooks.</p>' : `
          <form id="addHook">
            <label>URL <input name="url" type="url" required></label>
            <label>Secret <input name="secret" required></label>
            <label><input type="checkbox" name="events" value="issue.created" checked> issue.created</label>
            <label><input type="checkbox" name="events" value="issue.updated" checked> issue.updated</label>
            <label><input type="checkbox" name="events" value="issue.deleted"> issue.deleted</label>
            <label><input type="checkbox" name="events" value="comment.created"> comment.created</label>
            <button class="primary">Add webhook</button>
          </form>`}
        </div>
      </div>
    </div>
    <p class="error" id="err"></p>`;

  const statusRows = () => document.querySelectorAll('#statuses .st-row');
  const bindRemove = () => document.querySelectorAll('[data-rm]').forEach((b) => b.onclick = () => b.closest('.st-row').remove());
  bindRemove();
  $('#addStatus').onclick = () => {
    const row = document.createElement('div');
    row.className = 'row st-row';
    row.innerHTML = `<input name="sname" required placeholder="Status name"><select name="scat">${cats.map((c) => `<option>${c}</option>`).join('')}</select><button type="button" class="link danger" data-rm>remove</button>`;
    $('#statuses').appendChild(row);
    bindRemove();
  };
  $('#allTransitions').onclick = () => {
    const names = [...statusRows()].map((r) => r.querySelector('[name=sname]').value.trim()).filter(Boolean);
    const lines = [];
    for (const a of names) for (const b of names) if (a !== b) lines.push(`${a} -> ${b}`);
    $('#transitions').value = lines.join('\n');
  };
  $('#saveWf').onclick = async () => {
    $('#wfErr').textContent = '';
    try {
      const statuses = [...statusRows()].map((r) => ({
        name: r.querySelector('[name=sname]').value.trim(),
        category: r.querySelector('[name=scat]').value,
      }));
      const transitions = $('#transitions').value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
        const [a, b] = l.split('->').map((s) => s.trim());
        return [a, b];
      });
      let remap = {};
      try { remap = JSON.parse($('#remap').value || '{}'); } catch (e) { throw new Error('Remap must be valid JSON'); }
      await api('PUT', `/api/projects/${p.id}/workflow`, { statuses, transitions, remap });
      viewSettings();
    } catch (err) {
      $('#wfErr').textContent = err.message;
    }
  };
  $('#projName').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('PATCH', `/api/projects/${p.id}`, Object.fromEntries(new FormData(e.target))); render(); } catch (err) { alertErr(err); }
  };
  $('#exportBtn').onclick = async () => {
    const res = await fetch(`/api/projects/${p.id}/export.csv`, { headers: { authorization: `Bearer ${state.token}` } });
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${p.key}-issues.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  $('#importFile').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    try {
      const r = await api('POST', `/api/projects/${p.id}/import.csv`, undefined, { raw: text, contentType: 'text/csv' });
      const out = $('#importResult');
      out.classList.remove('hidden');
      out.textContent = `Created ${r.created} issue(s).\n` + r.errors.map((x) => `line ${x.line}: ${x.message}`).join('\n');
    } catch (err) { alertErr(err); }
  };
  document.querySelectorAll('[data-prole]').forEach((sel) => sel.onchange = async () => {
    try { await api('POST', `/api/projects/${p.id}/members`, { username: sel.dataset.prole, role: sel.value }); viewSettings(); } catch (err) { alertErr(err); }
  });
  document.querySelectorAll('[data-premove]').forEach((btn) => btn.onclick = async () => {
    try { await api('DELETE', `/api/projects/${p.id}/members/${encodeURIComponent(btn.dataset.premove)}`); viewSettings(); } catch (err) { alertErr(err); }
  });
  $('#addMember').onsubmit = async (e) => {
    e.preventDefault();
    try { await api('POST', `/api/projects/${p.id}/members`, Object.fromEntries(new FormData(e.target))); viewSettings(); } catch (err) { alertErr(err); }
  };
  if ($('#addHook')) {
    $('#addHook').onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      const body = { url: f.get('url'), secret: f.get('secret'), events: f.getAll('events') };
      try { await api('POST', `/api/projects/${p.id}/webhooks`, body); viewSettings(); } catch (err) { alertErr(err); }
    };
  }
  document.querySelectorAll('[data-hookdel]').forEach((btn) => btn.onclick = async () => {
    try { await api('DELETE', `/api/webhooks/${btn.dataset.hookdel}`); viewSettings(); } catch (err) { alertErr(err); }
  });
  document.querySelectorAll('[data-deliv]').forEach((btn) => btn.onclick = async () => {
    const box = $(`#deliv-${btn.dataset.deliv}`);
    try {
      const list = await api('GET', `/api/webhooks/${btn.dataset.deliv}/deliveries`);
      box.innerHTML = list.map((d) => `<div class="muted">${esc(d.event)} · status ${esc(d.status ?? '—')} · attempts ${d.attempts}${d.lastError ? ` · ${esc(d.lastError)}` : ''}</div>`).join('') || '<div class="muted">No deliveries.</div>';
    } catch (err) { alertErr(err); }
  });
}

window.addEventListener('hashchange', render);
render();
