// pm-s4 single-page app. Talks to the public JSON API only.
const $ = (sel) => document.querySelector(sel);
const app = $('#app');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const S = {
  token: localStorage.getItem('pm.token'),
  me: null,
  workspaces: [],
  ws: null,
  projects: [],
  project: null,
  members: [],
  statuses: [],
};

class Fail extends Error {}

async function api(method, path, body, { raw = false } = {}) {
  const headers = {};
  if (S.token) headers.authorization = `Bearer ${S.token}`;
  let payload;
  if (body !== undefined) {
    if (typeof body === 'string') {
      headers['content-type'] = 'text/csv';
      payload = body;
    } else {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
  }
  const res = await fetch(path, { method, headers, body: payload });
  if (res.status === 204) return null;
  if (raw) return res.text();
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/auth/login') logout(false);
    throw new Fail(data.message || `HTTP ${res.status}`);
  }
  return data;
}

function flash(msg, isError = false) {
  const el = $('#flash');
  el.textContent = msg;
  el.className = isError ? 'error' : '';
  el.hidden = false;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => (el.hidden = true), 3500);
}

function logout(callApi = true) {
  if (callApi && S.token) api('POST', '/api/auth/logout').catch(() => {});
  S.token = null;
  S.me = null;
  localStorage.removeItem('pm.token');
  $('#topbar').hidden = true;
  location.hash = '#/login';
}

// ---------- chrome ----------
async function loadContext() {
  const [{ user }, { workspaces }] = [await api('GET', '/api/auth/me'), { workspaces: await api('GET', '/api/workspaces') }];
  S.me = user;
  S.workspaces = workspaces;
  $('#whoami').textContent = user.displayName;
  if (!S.ws || !workspaces.some((w) => w.id === S.ws.id)) S.ws = workspaces[0] || null;
  S.projects = S.ws ? await api('GET', `/api/workspaces/${S.ws.id}/projects`) : [];
  renderTopbar();
}

function renderTopbar() {
  $('#wsSelect').innerHTML = S.workspaces.map((w) => `<option value="${esc(w.id)}" ${S.ws && S.ws.id === w.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')
    || '<option value="">(no workspace)</option>';
  const pid = S.project?.id;
  $('#projSelect').innerHTML = S.projects.map((p) => `<option value="${esc(p.id)}" ${pid === p.id ? 'selected' : ''}>${esc(p.key)} · ${esc(p.name)}</option>`).join('')
    || '<option value="">(no projects)</option>';
}

async function selectProject(pid) {
  S.project = await api('GET', `/api/projects/${pid}`);
  S.members = S.project.members;
  S.statuses = S.project.workflow.statuses;
  localStorage.setItem('pm.project', pid);
}

async function refreshNotifications() {
  const list = await api('GET', '/api/notifications');
  const unread = list.filter((n) => !n.read).length;
  $('#unreadCount').textContent = String(unread);
  return list;
}

function usernameOf(id) {
  return S.members.find((m) => m.userId === id)?.username || '';
}

// ---------- routing ----------
const routes = [];
const route = (re, fn) => routes.push({ re, fn });

async function render() {
  if (!S.token) {
    $('#topbar').hidden = true;
    const h = location.hash;
    if (h.startsWith('#/register')) return renderRegister();
    return renderLogin();
  }
  try {
    if (!S.me) await loadContext();
    $('#topbar').hidden = false;
    if (!S.project) {
      const saved = localStorage.getItem('pm.project');
      const pick = S.projects.find((p) => p.id === saved) || S.projects[0];
      if (pick) await selectProject(pick.id);
    }
    if (!location.hash || location.hash === '#/login' || location.hash === '#/register') location.hash = '#/board';
    const hash = location.hash.slice(1) || '/board';
    for (const r of routes) {
      const m = r.re.exec(hash);
      if (m) return await r.fn(...m.slice(1).map(decodeURIComponent));
    }
    app.innerHTML = '<p>Not found.</p>';
  } catch (err) {
    app.innerHTML = `<p class="err">${esc(err.message)}</p>`;
  }
}

window.addEventListener('hashchange', render);

// ---------- auth ----------
function renderLogin() {
  app.innerHTML = `
    <div class="auth">
      <h2>Log in</h2>
      <form id="loginForm">
        <label>Username <input name="username" required autocomplete="username"></label>
        <label>Password <input name="password" type="password" required autocomplete="current-password"></label>
        <button class="primary" type="submit">Log in</button>
        <p class="err" id="loginErr"></p>
      </form>
      <p><a href="#/register">Create an account</a></p>
    </div>`;
  $('#loginForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      const out = await api('POST', '/api/auth/login', { username: f.get('username'), password: f.get('password') });
      S.token = out.token;
      localStorage.setItem('pm.token', out.token);
      S.me = null;
      S.project = null;
      location.hash = '#/board';
      render();
    } catch (err) {
      $('#loginErr').textContent = err.message;
    }
  };
}

function renderRegister() {
  app.innerHTML = `
    <div class="auth">
      <h2>Create account</h2>
      <form id="regForm">
        <label>Username <input name="username" required></label>
        <label>Display name <input name="displayName"></label>
        <label>Password (min 8) <input name="password" type="password" required minlength="8"></label>
        <button class="primary" type="submit">Register</button>
        <p class="err" id="regErr"></p>
      </form>
      <p><a href="#/login">Back to log in</a></p>
    </div>`;
  $('#regForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('POST', '/api/auth/register', { username: f.get('username'), password: f.get('password'), displayName: f.get('displayName') || undefined });
      await api('POST', '/api/auth/login', { username: f.get('username'), password: f.get('password') }).then((o) => {
        S.token = o.token;
        localStorage.setItem('pm.token', o.token);
      });
      S.me = null;
      location.hash = '#/board';
      render();
    } catch (err) {
      $('#regErr').textContent = err.message;
    }
  };
}

// ---------- topbar events ----------
$('#wsSelect').onchange = async (e) => {
  S.ws = S.workspaces.find((w) => w.id === e.target.value);
  S.project = null;
  S.projects = await api('GET', `/api/workspaces/${S.ws.id}/projects`);
  if (S.projects[0]) await selectProject(S.projects[0].id);
  renderTopbar();
  location.hash = '#/board';
  render();
};
$('#projSelect').onchange = async (e) => {
  await selectProject(e.target.value);
  renderTopbar();
  render();
};
$('#logoutBtn').onclick = () => logout(true);
$('#searchForm').onsubmit = (e) => {
  e.preventDefault();
  location.hash = `#/search/${encodeURIComponent($('#searchInput').value)}`;
};
$('#notifBtn').onclick = async () => {
  const panel = $('#notifPanel');
  if (!panel.hidden) return (panel.hidden = true);
  const list = await refreshNotifications();
  panel.innerHTML = `
    <div class="row"><strong>Notifications</strong>
      <button id="markAll" type="button">Mark all read</button></div>
    <ul>${list.slice(0, 50).map((n) => `<li class="${n.read ? '' : 'unread'}">
      <a href="#/issue/${esc(n.issueKey)}">${esc(n.issueKey)}</a> · ${esc(n.type)} · ${esc(new Date(n.at).toLocaleString())}</li>`).join('') || '<li>None</li>'}</ul>`;
  panel.hidden = false;
  $('#markAll').onclick = async () => {
    await api('POST', '/api/notifications/read', { all: true });
    panel.hidden = true;
    refreshNotifications();
  };
};

// ---------- board ----------
route(/^\/board$/, async () => {
  if (!S.ws) {
    app.innerHTML = `<section class="card-box"><h3>No workspace yet</h3>
      <form id="newWs" class="inline row">
        <input name="name" placeholder="Workspace name" required>
        <input name="key" placeholder="KEY (2-10 capitals)" pattern="[A-Z]{2,10}" required>
        <button class="primary" type="submit">Create workspace</button>
      </form></section>`;
    $('#newWs').onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        const w = await api('POST', '/api/workspaces', { name: f.get('name'), key: f.get('key') });
        S.workspaces = await api('GET', '/api/workspaces');
        S.ws = w;
        S.projects = [];
        renderTopbar();
        render();
      } catch (err) { flash(err.message, true); }
    };
    return;
  }
  if (!S.project) {
    app.innerHTML = `<section class="card-box"><h3>No project selected</h3>
      <form id="newProject" class="inline row">
        <input name="name" placeholder="Project name" required>
        <input name="key" placeholder="KEY (2-10 capitals)" pattern="[A-Z]{2,10}" required>
        <button class="primary" type="submit">Create project</button>
      </form></section>`;
    $('#newProject').onsubmit = async (e) => {
      e.preventDefault();
      const f = new FormData(e.target);
      try {
        const p = await api('POST', `/api/workspaces/${S.ws.id}/projects`, { name: f.get('name'), key: f.get('key') });
        S.projects = await api('GET', `/api/workspaces/${S.ws.id}/projects`);
        await selectProject(p.id);
        renderTopbar();
        render();
      } catch (err) { flash(err.message, true); }
    };
    return;
  }
  const issues = await api('GET', `/api/projects/${S.project.id}/issues`);
  const cols = S.statuses.map((s) => ({ ...s, issues: issues.filter((i) => i.status === s.name) }));
  app.innerHTML = `<h2>${esc(S.project.name)} board</h2><div class="board">${cols.map((c) => `
    <div class="column" data-status="${esc(c.name)}">
      <h3>${esc(c.name)} (${c.issues.length})</h3>
      ${c.issues.map((i) => `
        <div class="card" draggable="true" data-key="${esc(i.key)}">
          <div class="key">${esc(i.key)} · ${esc(i.type)}</div>
          <a href="#/issue/${esc(i.key)}">${esc(i.title)}</a>
          <div class="meta"><span class="prio-${esc(i.priority)}">${esc(i.priority)}</span>
            ${i.storyPoints != null ? ` · ${esc(i.storyPoints)} pts` : ''}
            ${i.assigneeId ? ` · @${esc(usernameOf(i.assigneeId))}` : ''}</div>
          <div>${i.labels.map((l) => `<span class="tag">${esc(l)}</span>`).join('')}</div>
        </div>`).join('')}
    </div>`).join('')}</div>`;

  app.querySelectorAll('.card').forEach((card) => {
    card.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', card.dataset.key));
  });
  app.querySelectorAll('.column').forEach((col) => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drop'); });
    col.addEventListener('dragleave', () => col.classList.remove('drop'));
    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('drop');
      const key = e.dataTransfer.getData('text/plain');
      try {
        await api('PATCH', `/api/issues/${key}`, { status: col.dataset.status });
        render();
      } catch (err) {
        flash(err.message, true);
      }
    });
  });
});

// ---------- backlog & sprint planning ----------
route(/^\/backlog$/, async () => {
  const [issues, sprints] = await Promise.all([
    api('GET', `/api/projects/${S.project.id}/issues`),
    api('GET', `/api/projects/${S.project.id}/sprints`),
  ]);
  const sprintOptions = (sel) => `<option value="">Backlog</option>${sprints.filter((s) => s.state !== 'completed' || s.id === sel)
    .map((s) => `<option value="${esc(s.id)}" ${s.id === sel ? 'selected' : ''}>${esc(s.name)} (${esc(s.state)})</option>`).join('')}`;
  const groups = [{ id: null, name: 'Backlog' }, ...sprints.map((s) => ({ id: s.id, name: `${s.name} · ${s.state}`, sprint: s }))];
  app.innerHTML = `
    <section class="card-box">
      <form class="inline row" id="newSprint">
        <input name="name" placeholder="Sprint name" required>
        <input name="startDate" type="date">
        <input name="endDate" type="date">
        <button class="primary" type="submit">Create sprint</button>
      </form>
    </section>
    <section class="card-box">
      <form class="inline row" id="newIssue">
        <input name="title" placeholder="New issue title" required>
        <select name="type">${['task', 'bug', 'feature', 'epic'].map((t) => `<option>${t}</option>`).join('')}</select>
        <input name="storyPoints" type="number" min="0" placeholder="points">
        <button class="primary" type="submit">Add to backlog</button>
      </form>
    </section>
    ${groups.map((g) => {
      const list = issues.filter((i) => (i.sprintId || null) === g.id);
      return `<section class="card-box"><h3>${esc(g.name)}
        ${g.sprint ? sprintActions(g.sprint) : ''}</h3>
        <table><thead><tr><th>Key</th><th>Title</th><th>Status</th><th>Pts</th><th>Sprint</th></tr></thead><tbody>
        ${list.map((i) => `<tr>
          <td>${esc(i.key)}</td>
          <td><a href="#/issue/${esc(i.key)}">${esc(i.title)}</a></td>
          <td>${esc(i.status)}</td>
          <td>${esc(i.storyPoints ?? '')}</td>
          <td><select data-move="${esc(i.key)}">${sprintOptions(i.sprintId)}</select></td>
        </tr>`).join('') || '<tr><td colspan="5">No issues</td></tr>'}
        </tbody></table></section>`;
    }).join('')}`;

  $('#newSprint').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('POST', `/api/projects/${S.project.id}/sprints`, {
        name: f.get('name'), startDate: f.get('startDate') || undefined, endDate: f.get('endDate') || undefined,
      });
      render();
    } catch (err) { flash(err.message, true); }
  };
  $('#newIssue').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('POST', `/api/projects/${S.project.id}/issues`, {
        title: f.get('title'), type: f.get('type'), storyPoints: f.get('storyPoints') ? Number(f.get('storyPoints')) : null,
      });
      render();
    } catch (err) { flash(err.message, true); }
  };
  app.querySelectorAll('select[data-move]').forEach((sel) => {
    sel.onchange = async () => {
      try {
        await api('PATCH', `/api/issues/${sel.dataset.move}`, { sprintId: sel.value || null });
        render();
      } catch (err) { flash(err.message, true); }
    };
  });
  app.querySelectorAll('[data-sprint-action]').forEach((btn) => {
    btn.onclick = async () => {
      try {
        const [action, id] = btn.dataset.sprintAction.split(':');
        if (action === 'start') await api('POST', `/api/sprints/${id}/start`);
        if (action === 'complete') {
          const target = prompt('Carry unfinished issues to: "backlog" or a sprint id', 'backlog');
          if (target === null) return;
          await api('POST', `/api/sprints/${id}/complete`, { carryOverTo: target.trim() || 'backlog' });
        }
        render();
      } catch (err) { flash(err.message, true); }
    };
  });
});

function sprintActions(s) {
  if (s.state === 'planned') return ` <button data-sprint-action="start:${esc(s.id)}">Start</button>`;
  if (s.state === 'active') return ` <button data-sprint-action="complete:${esc(s.id)}">Complete</button> <a href="#/sprint/${esc(s.id)}">Report</a>`;
  return ` <a href="#/sprint/${esc(s.id)}">Report</a>`;
}

// ---------- sprint report ----------
async function renderSprint(id) {
  const sprints = await api('GET', `/api/projects/${S.project.id}/sprints`);
  const target = id || sprints.find((s) => s.state === 'active')?.id || sprints[sprints.length - 1]?.id;
  if (!target) return (app.innerHTML = '<p>No sprints yet.</p>');
  const r = await api('GET', `/api/sprints/${target}/report`);
  const sprint = sprints.find((s) => s.id === target);
  const pts = r.burndown.map((b) => b.remainingPoints);
  const max = Math.max(1, r.committedPoints, ...pts);
  const W = 720;
  const H = 220;
  const x = (i) => 30 + (r.burndown.length <= 1 ? 0 : (i * (W - 40)) / (r.burndown.length - 1));
  const y = (v) => 10 + (H - 40) * (1 - v / max);
  const line = r.burndown.map((b, i) => `${x(i)},${y(b.remainingPoints)}`).join(' ');
  const ideal = r.burndown.length > 1
    ? `${x(0)},${y(r.committedPoints)} ${x(r.burndown.length - 1)},${y(0)}` : '';
  app.innerHTML = `
    <h2>Sprint report: ${esc(sprint?.name || '')} <small>(${esc(sprint?.state || '')})</small></h2>
    <p>Committed: <strong>${r.committedPoints}</strong> pts · Completed: <strong>${r.completedPoints}</strong> pts
      (${r.completedIssues} issues) · Carried over: <strong>${r.carriedOver}</strong></p>
    <svg class="burndown" viewBox="0 0 ${W} ${H}" role="img" aria-label="Burndown chart">
      <polyline points="${ideal}" fill="none" stroke="#9ca3af" stroke-dasharray="4 4"/>
      <polyline points="${line}" fill="none" stroke="#2563eb" stroke-width="2"/>
      ${r.burndown.map((b, i) => `<circle cx="${x(i)}" cy="${y(b.remainingPoints)}" r="3" fill="#2563eb"><title>${esc(b.date)}: ${b.remainingPoints}</title></circle>`).join('')}
      <text x="4" y="14" font-size="10">${max}</text>
      <text x="4" y="${H - 22}" font-size="10">0</text>
    </svg>
    <table><thead><tr><th>Date</th><th>Remaining points</th></tr></thead><tbody>
      ${r.burndown.map((b) => `<tr><td>${esc(b.date)}</td><td>${b.remainingPoints}</td></tr>`).join('')}
    </tbody></table>`;
}
route(/^\/sprint$/, () => renderSprint(null));
route(/^\/sprint\/([^/]+)$/, (id) => renderSprint(id));

// ---------- issue detail ----------
route(/^\/issue\/([^/]+)$/, async (key) => {
  const i = await api('GET', `/api/issues/${key}`);
  const [comments, history, sprints, me] = await Promise.all([
    api('GET', `/api/issues/${key}/comments`),
    api('GET', `/api/issues/${key}/history`),
    api('GET', `/api/projects/${S.project.id}/sprints`),
    Promise.resolve(S.me),
  ]);
  const watching = i.watchers.includes(me.id);
  const opt = (list, sel, labelFn = (x) => x) => list.map((x) => `<option value="${esc(x.value ?? x)}" ${(x.value ?? x) === sel ? 'selected' : ''}>${esc(labelFn(x))}</option>`).join('');
  app.innerHTML = `
    <h2><span class="key">${esc(i.key)}</span> ${esc(i.title)}</h2>
    <p><button id="watchBtn" type="button">${watching ? 'Unwatch' : 'Watch'}</button>
      <button id="deleteBtn" type="button">Delete</button></p>
    <section class="card-box">
      <form id="issueForm" class="row">
        <label>Title <input name="title" value="${esc(i.title)}"></label>
        <label>Status <select name="status">${opt(S.statuses.map((s) => s.name), i.status)}</select></label>
        <label>Type <select name="type">${opt(['task', 'bug', 'feature', 'epic', 'subtask'], i.type)}</select></label>
        <label>Priority <select name="priority">${opt(['urgent', 'high', 'medium', 'low', 'none'], i.priority)}</select></label>
        <label>Assignee <select name="assigneeId"><option value="">Unassigned</option>${S.members.map((m) => `<option value="${esc(m.userId)}" ${m.userId === i.assigneeId ? 'selected' : ''}>${esc(m.username)}</option>`).join('')}</select></label>
        <label>Points <input name="storyPoints" type="number" min="0" value="${esc(i.storyPoints ?? '')}"></label>
        <label>Due <input name="dueDate" type="date" value="${esc(i.dueDate ?? '')}"></label>
        <label>Sprint <select name="sprintId"><option value="">Backlog</option>${sprints.filter((s) => s.state !== 'completed' || s.id === i.sprintId).map((s) => `<option value="${esc(s.id)}" ${s.id === i.sprintId ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
        <label>Labels (comma separated) <input name="labels" value="${esc(i.labels.join(', '))}"></label>
      </form>
      <label>Description <textarea name="description" form="issueForm" rows="4">${esc(i.description)}</textarea></label>
      <p><button class="primary" type="submit" form="issueForm">Save</button></p>
    </section>
    ${i.progress ? `<p>Epic progress: ${i.progress.done}/${i.progress.total} issues · ${i.progress.points_done}/${i.progress.points_total} pts</p>` : ''}
    <section class="card-box"><h3>Subtasks</h3>
      <ul>${i.children.map((k) => `<li><a href="#/issue/${esc(k)}">${esc(k)}</a></li>`).join('') || '<li>None</li>'}</ul>
      ${i.type !== 'subtask' && i.type !== 'epic' ? `<form id="subForm" class="inline row"><input name="title" placeholder="Subtask title" required><button type="submit">Add subtask</button></form>` : ''}
    </section>
    <section class="card-box"><h3>Links</h3>
      <ul>${i.links.map((l) => `<li>${esc(l.type)} <a href="#/issue/${esc(l.key)}">${esc(l.key)}</a></li>`).join('') || '<li>None</li>'}</ul>
      <form id="linkForm" class="inline row">
        <select name="type"><option>blocks</option><option>relates</option><option>duplicates</option></select>
        <input name="target" placeholder="Target key, e.g. ${esc(S.project.key)}-1" required>
        <button type="submit">Add link</button>
      </form>
    </section>
    <section class="card-box"><h3>Comments</h3>
      ${comments.map((c) => `<div class="comment"><small>${esc(usernameOf(c.authorId) || c.authorId)} · ${esc(new Date(c.createdAt).toLocaleString())}${c.edited ? ' · edited' : ''}</small>
        <div>${esc(c.body)}</div>
        ${c.authorId === me.id ? `<button data-edit="${esc(c.id)}" type="button">Edit</button>` : ''}</div>`).join('') || '<p>No comments</p>'}
      <form id="commentForm" class="inline row"><textarea name="body" rows="2" placeholder="Write a comment. Mention with @username" required></textarea><button type="submit">Comment</button></form>
    </section>
    <section class="card-box"><h3>History</h3>
      <table><thead><tr><th>When</th><th>Field</th><th>From</th><th>To</th><th>By</th></tr></thead><tbody>
      ${history.map((h) => `<tr><td>${esc(new Date(h.at).toLocaleString())}</td><td>${esc(h.field)}</td><td>${esc(h.from ?? '')}</td><td>${esc(h.to ?? '')}</td><td>${esc(usernameOf(h.actorId))}</td></tr>`).join('') || '<tr><td colspan="5">No changes</td></tr>'}
      </tbody></table>
    </section>`;

  $('#issueForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const body = {
      title: f.get('title'),
      status: f.get('status'),
      type: f.get('type'),
      priority: f.get('priority'),
      assigneeId: f.get('assigneeId') || null,
      storyPoints: f.get('storyPoints') === '' ? null : Number(f.get('storyPoints')),
      dueDate: f.get('dueDate') || null,
      sprintId: f.get('sprintId') || null,
      labels: String(f.get('labels') || '').split(',').map((s) => s.trim()).filter(Boolean),
      description: app.querySelector('textarea[name=description]').value,
    };
    try {
      await api('PATCH', `/api/issues/${key}`, body);
      flash('Saved');
      render();
    } catch (err) { flash(err.message, true); }
  };
  $('#watchBtn').onclick = async () => {
    await api(watching ? 'DELETE' : 'POST', `/api/issues/${key}/watch`);
    render();
  };
  $('#deleteBtn').onclick = async () => {
    if (!confirm(`Delete ${key}?`)) return;
    await api('DELETE', `/api/issues/${key}`);
    location.hash = '#/board';
  };
  if ($('#subForm')) {
    $('#subForm').onsubmit = async (e) => {
      e.preventDefault();
      const title = new FormData(e.target).get('title');
      try {
        await api('POST', `/api/projects/${S.project.id}/issues`, { title, type: 'subtask', parentId: i.id });
        render();
      } catch (err) { flash(err.message, true); }
    };
  }
  $('#linkForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('POST', `/api/issues/${key}/links`, { type: f.get('type'), target: f.get('target') });
      render();
    } catch (err) { flash(err.message, true); }
  };
  $('#commentForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('POST', `/api/issues/${key}/comments`, { body: new FormData(e.target).get('body') });
      render();
    } catch (err) { flash(err.message, true); }
  };
  app.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.onclick = async () => {
      const current = comments.find((c) => c.id === btn.dataset.edit);
      const text = prompt('Edit comment', current.body);
      if (text === null) return;
      try {
        await api('PATCH', `/api/comments/${current.id}`, { body: text });
        render();
      } catch (err) { flash(err.message, true); }
    };
  });
});

// ---------- search ----------
route(/^\/search\/(.*)$/, async (q) => {
  $('#searchInput').value = q;
  let issues;
  try {
    const qs = new URLSearchParams({ q, project: S.project?.key || '' });
    issues = await api('GET', `/api/search?${qs}`);
  } catch (err) {
    app.innerHTML = `<p class="err">${esc(err.message)}</p>`;
    return;
  }
  app.innerHTML = `<h2>Search results (${issues.length})</h2><table><thead><tr><th>Key</th><th>Title</th><th>Status</th><th>Priority</th><th>Assignee</th></tr></thead><tbody>
    ${issues.map((i) => `<tr><td>${esc(i.key)}</td><td><a href="#/issue/${esc(i.key)}">${esc(i.title)}</a></td><td>${esc(i.status)}</td><td>${esc(i.priority)}</td><td>${esc(i.assigneeId ? usernameOf(i.assigneeId) : '')}</td></tr>`).join('') || '<tr><td colspan="5">No matches</td></tr>'}
    </tbody></table>`;
});

// ---------- settings ----------
route(/^\/settings$/, async () => {
  const hooks = await api('GET', `/api/projects/${S.project.id}/webhooks`).catch(() => null);
  const wfJson = JSON.stringify({ statuses: S.statuses, transitions: S.project.workflow.transitions }, null, 2);
  const members = await api('GET', `/api/workspaces/${S.ws.id}/members`).catch(() => []);
  app.innerHTML = `
    <h2>Project settings · ${esc(S.project.name)} (${esc(S.project.key)})</h2>
    <section class="card-box"><h3>Workflow</h3>
      <p>Edit statuses (name + category: backlog|unstarted|started|completed) and transitions as JSON.
        Removing an in-use status requires a <code>remap</code> object.</p>
      <textarea id="wfText" rows="12">${esc(wfJson)}</textarea>
      <textarea id="wfRemap" rows="2" placeholder='remap, e.g. {"Old": "New"}'>{}</textarea>
      <p><button class="primary" id="wfSave" type="button">Save workflow</button></p>
    </section>
    <section class="card-box"><h3>Members</h3>
      <table><thead><tr><th>User</th><th>Role</th></tr></thead><tbody>
      ${S.project.members.map((m) => `<tr><td>${esc(m.username)}</td><td>${esc(m.role)}</td></tr>`).join('')}
      </tbody></table>
      <form id="memberForm" class="inline row">
        <select name="username">${members.map((m) => `<option value="${esc(m.username)}">${esc(m.username)} (${esc(m.role)})</option>`).join('')}</select>
        <select name="role"><option>developer</option><option>lead</option><option>viewer</option></select>
        <button type="submit">Add member</button>
      </form>
    </section>
    <section class="card-box"><h3>Webhooks</h3>
      <ul>${(hooks || []).map((h) => `<li>${esc(h.url)} [${esc(h.events.join(', '))}]
        <button data-hook-del="${esc(h.id)}" type="button">Delete</button>
        <button data-hook-log="${esc(h.id)}" type="button">Deliveries</button></li>`).join('') || '<li>None</li>'}</ul>
      <form id="hookForm" class="inline row">
        <input name="url" type="url" placeholder="https://example.test/hook" required>
        <input name="secret" placeholder="HMAC secret" required>
        <select name="events" multiple size="4"><option>issue.created</option><option>issue.updated</option><option>issue.deleted</option><option>comment.created</option></select>
        <button type="submit">Add webhook</button>
      </form>
      <pre id="hookLog"></pre>
    </section>`;

  $('#wfSave').onclick = async () => {
    try {
      const body = JSON.parse($('#wfText').value);
      body.remap = JSON.parse($('#wfRemap').value || '{}');
      const out = await api('PUT', `/api/projects/${S.project.id}/workflow`, body);
      S.project = out;
      S.statuses = out.workflow.statuses;
      flash('Workflow saved');
      render();
    } catch (err) { flash(err.message, true); }
  };
  $('#memberForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await api('POST', `/api/projects/${S.project.id}/members`, { username: f.get('username'), role: f.get('role') });
      render();
    } catch (err) { flash(err.message, true); }
  };
  $('#hookForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const events = [...e.target.events.selectedOptions].map((o) => o.value);
    try {
      await api('POST', `/api/projects/${S.project.id}/webhooks`, { url: f.get('url'), secret: f.get('secret'), events });
      render();
    } catch (err) { flash(err.message, true); }
  };
  app.querySelectorAll('[data-hook-del]').forEach((b) => {
    b.onclick = async () => { await api('DELETE', `/api/webhooks/${b.dataset.hookDel}`); render(); };
  });
  app.querySelectorAll('[data-hook-log]').forEach((b) => {
    b.onclick = async () => {
      const d = await api('GET', `/api/webhooks/${b.dataset.hookLog}/deliveries`);
      $('#hookLog').textContent = JSON.stringify(d, null, 2);
    };
  });
});

// Tokens + audit are reachable through the API; the SPA does not need extra screens for them.
render();
