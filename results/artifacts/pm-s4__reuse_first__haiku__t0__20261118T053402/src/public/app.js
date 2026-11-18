// pm-s4 single-page app. Talks only to the public /api surface.
const $ = (sel) => document.querySelector(sel);
const app = $('#app');
const state = { token: localStorage.getItem('pm.token'), user: null, wsId: localStorage.getItem('pm.ws'), projectId: localStorage.getItem('pm.project'), workspaces: [], projects: [] };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : '');

async function api(method, path, body, raw) {
  const headers = {};
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  let payload;
  if (raw !== undefined) { headers['content-type'] = 'text/csv'; payload = raw; }
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(`/api${path}`, { method, headers, body: payload });
  if (r.status === 204) return null;
  const text = await r.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!r.ok) {
    if (r.status === 401 && state.token) { logout(false); }
    const err = new Error(data?.message || r.statusText);
    err.status = r.status; err.code = data?.error;
    throw err;
  }
  return data;
}

const flash = (msg) => { const el = $('#flash'); if (el) el.textContent = msg; else alert(msg); };
const errBox = (e) => `<div class="error">${esc(e.message || e)}</div>`;
const setView = (html) => { app.innerHTML = html; };

function logout(redirect = true) {
  state.token = null; state.user = null;
  localStorage.removeItem('pm.token');
  $('#topbar').hidden = true;
  if (redirect) location.hash = '#/login';
  else route();
}

// ---------- chrome: workspace/project switchers, nav, notifications
async function loadWorkspaces() {
  state.workspaces = await api('GET', '/workspaces');
  if (!state.workspaces.find((w) => w.id === state.wsId)) state.wsId = state.workspaces[0]?.id ?? null;
  $('#ws-select').innerHTML = state.workspaces.map((w) => `<option value="${w.id}" ${w.id === state.wsId ? 'selected' : ''}>${esc(w.name)}</option>`).join('')
    || '<option value="">(no workspaces)</option>';
  if (state.wsId) {
    state.projects = await api('GET', `/workspaces/${state.wsId}/projects`);
    if (!state.projects.find((p) => p.id === state.projectId)) state.projectId = state.projects[0]?.id ?? null;
  } else state.projects = [];
  $('#proj-select').innerHTML = state.projects.map((p) => `<option value="${p.id}" ${p.id === state.projectId ? 'selected' : ''}>${esc(p.key)} · ${esc(p.name)}</option>`).join('')
    || '<option value="">(no projects)</option>';
  localStorage.setItem('pm.ws', state.wsId || '');
  localStorage.setItem('pm.project', state.projectId || '');
  const nav = [];
  if (state.projectId) {
    const p = state.projectId;
    nav.push(['board', `#/p/${p}/board`], ['backlog', `#/p/${p}/backlog`], ['settings', `#/p/${p}/settings`]);
  }
  const cur = location.hash;
  $('#nav').innerHTML = nav.map(([n, h]) => `<a href="${h}" class="${cur.includes(`/${n}`) ? 'active' : ''}">${n}</a>`).join('');
  refreshBell();
}

$('#ws-select').addEventListener('change', (e) => { state.wsId = e.target.value; state.projectId = null; localStorage.removeItem('pm.project'); location.hash = '#/ws'; });
$('#proj-select').addEventListener('change', (e) => { state.projectId = e.target.value; location.hash = `#/p/${state.projectId}/board`; });
$('#search-form').addEventListener('submit', (e) => { e.preventDefault(); location.hash = `#/search?q=${encodeURIComponent($('#search-input').value)}${state.projectId ? `&p=${state.projectId}` : ''}`; });

async function refreshBell() {
  try {
    const n = await api('GET', '/notifications?unread=true');
    $('#bell-count').textContent = n.length ? `(${n.length})` : '';
  } catch { /* ignore */ }
}
$('#bell').addEventListener('click', async () => {
  const panel = $('#notif-panel');
  if (!panel.hidden) { panel.hidden = true; return; }
  await renderNotifications();
  panel.hidden = false;
});
async function renderNotifications() {
  const list = await api('GET', '/notifications');
  $('#notif-panel').innerHTML = `<div class="row"><strong class="grow">Notifications</strong><button id="mark-all">Mark all read</button></div>`
    + (list.length ? list.slice(0, 50).map((n) => `<div class="notif ${n.read ? '' : 'unread'}">
        <a href="#/issue/${esc(n.issueKey)}">${esc(n.issueKey)}</a> · ${esc(n.type.replace('_', ' '))}
        <div class="muted">${fmt(n.at)}</div></div>`).join('') : '<p class="muted">No notifications.</p>');
  $('#mark-all').onclick = async () => { await api('POST', '/notifications/read', { all: true }); await renderNotifications(); refreshBell(); };
}

function showChrome(on) { $('#topbar').hidden = !on; }

// ---------- views
function viewLogin(mode = 'login') {
  showChrome(false);
  const register = mode === 'register';
  setView(`<div class="card login">
    <h2>${register ? 'Create account' : 'Sign in'}</h2>
    <form id="auth-form">
      <label>Username<input name="username" required minlength="3" autocomplete="username"></label>
      ${register ? '<label>Display name<input name="displayName"></label>' : ''}
      <label>Password<input name="password" type="password" required minlength="8" autocomplete="${register ? 'new-password' : 'current-password'}"></label>
      <div id="flash" class="error" hidden></div>
      <div class="row"><button class="primary" type="submit">${register ? 'Register' : 'Sign in'}</button>
      <a href="#/${register ? 'login' : 'register'}">${register ? 'Have an account?' : 'Create account'}</a></div>
    </form></div>`);
  $('#auth-form').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const box = $('#auth-form #flash');
    try {
      if (register) {
        await api('POST', '/auth/register', { username: f.username, password: f.password, displayName: f.displayName || undefined });
      }
      const { token, user } = await api('POST', '/auth/login', { username: f.username, password: f.password });
      state.token = token; state.user = user;
      localStorage.setItem('pm.token', token);
      location.hash = '#/ws';
    } catch (err) {
      box.hidden = false; box.textContent = err.message;
    }
  };
}

async function viewWorkspaceHome() {
  if (!state.wsId) {
    setView(`<div class="card"><h2>Create a workspace</h2>
      <form id="ws-form" class="row"><input name="name" placeholder="Name" required><input name="key" placeholder="KEY (2-10 caps)" pattern="[A-Z]{2,10}" required>
      <button class="primary">Create</button></form><div id="flash"></div></div>`);
    $('#ws-form').onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      try { const ws = await api('POST', '/workspaces', f); state.wsId = ws.id; await loadWorkspaces(); location.hash = '#/ws'; }
      catch (err) { flash(err.message); }
    };
    return;
  }
  const ws = state.workspaces.find((w) => w.id === state.wsId);
  setView(`<div class="card"><h2>${esc(ws.name)} <span class="muted">(${esc(ws.key)}, your role: ${esc(ws.role)})</span></h2>
    <h3>Projects</h3>
    <table><tr><th>Key</th><th>Name</th><th></th></tr>
    ${state.projects.map((p) => `<tr><td>${esc(p.key)}</td><td>${esc(p.name)}</td><td><a href="#/p/${p.id}/board">Open board</a></td></tr>`).join('') || '<tr><td colspan="3" class="muted">No projects visible.</td></tr>'}
    </table>
    ${ws.role !== 'guest' ? `<h3>New project</h3><form id="proj-form" class="row"><input name="name" placeholder="Name" required><input name="key" placeholder="KEY" pattern="[A-Z]{2,10}" required><button class="primary">Create</button></form>` : ''}
    <div id="flash"></div></div>`);
  const form = $('#proj-form');
  if (form) form.onsubmit = async (e) => {
    e.preventDefault();
    try { const p = await api('POST', `/workspaces/${state.wsId}/projects`, Object.fromEntries(new FormData(form))); state.projectId = p.id; await loadWorkspaces(); location.hash = `#/p/${p.id}/board`; }
    catch (err) { flash(err.message); }
  };
}

async function viewBoard(pid) {
  const [project, issues] = await Promise.all([api('GET', `/projects/${pid}`), api('GET', `/projects/${pid}/issues`)]);
  const statuses = project.workflow.statuses;
  const canEdit = project.myRole !== 'viewer';
  setView(`<h2>${esc(project.key)} · ${esc(project.name)} <span class="muted">board</span></h2>
    ${canEdit ? `<form id="new-issue" class="card row">
      <select name="type">${['task', 'bug', 'feature', 'epic'].map((t) => `<option>${t}</option>`).join('')}</select>
      <input name="title" class="grow" placeholder="New issue title" required>
      <input name="storyPoints" type="number" min="0" step="any" placeholder="points" style="width:90px">
      <button class="primary">Create</button></form>` : ''}
    <div id="flash" class="error" hidden></div>
    <div class="board">${statuses.map((s) => `<div class="column" data-status="${esc(s.name)}">
      <h3>${esc(s.name)} <span class="muted">${esc(s.category)}</span></h3>
      ${issues.filter((i) => i.status === s.name && !i.parentId).map((i) => card(i)).join('')}
    </div>`).join('')}</div>`);
  const nf = $('#new-issue');
  if (nf) nf.onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const body = { type: f.type, title: f.title };
    if (f.storyPoints) body.storyPoints = Number(f.storyPoints);
    try { await api('POST', `/projects/${pid}/issues`, body); viewBoard(pid); } catch (err) { $('#flash').hidden = false; $('#flash').textContent = err.message; }
  };
  if (canEdit) {
    document.querySelectorAll('.issue[data-key]').forEach((el) => {
      el.draggable = true;
      el.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/plain', el.dataset.key));
    });
    document.querySelectorAll('.column').forEach((col) => {
      col.addEventListener('dragover', (e) => e.preventDefault());
      col.addEventListener('drop', async (e) => {
        e.preventDefault();
        const key = e.dataTransfer.getData('text/plain');
        const to = col.dataset.status;
        const box = $('#flash');
        try { await api('PATCH', `/issues/${key}`, { status: to }); viewBoard(pid); }
        catch (err) { box.hidden = false; box.textContent = `${key}: ${err.message}`; }
      });
    });
  }
}

function card(i) {
  const tags = (i.labels || []).map((l) => `<span class="tag">${esc(l)}</span>`).join('');
  return `<div class="issue ${i.type} ${i.priority}" data-key="${esc(i.key)}">
    <div><a href="#/issue/${esc(i.key)}">${esc(i.key)}</a> <span class="muted">${esc(i.type)}</span></div>
    <div>${esc(i.title)}</div>
    <div class="muted"><span class="prio">${esc(i.priority)}</span>${i.storyPoints != null ? ` · ${i.storyPoints} pts` : ''}${i.dueDate ? ` · due ${esc(i.dueDate)}` : ''}</div>
    <div>${tags}</div></div>`;
}

async function viewBacklog(pid) {
  const [project, issues, sprints] = await Promise.all([
    api('GET', `/projects/${pid}`), api('GET', `/projects/${pid}/issues`), api('GET', `/projects/${pid}/sprints`),
  ]);
  const canPlan = project.myRole !== 'viewer';
  const members = project.members;
  const sprintBlock = (s) => {
    const list = issues.filter((i) => i.sprintId === s.id);
    const pts = list.reduce((a, i) => a + (i.storyPoints || 0), 0);
    const open = sprints.filter((o) => o.id !== s.id && o.state !== 'completed');
    return `<div class="card">
      <div class="sprint-head"><div><strong>${esc(s.name)}</strong> <span class="tag">${esc(s.state)}</span>
        <span class="muted">${esc(s.startDate || '')} ${s.endDate ? '→ ' + esc(s.endDate) : ''} · ${pts} pts</span></div>
        <div class="row">
          ${canPlan && s.state === 'planned' ? `<button data-start="${s.id}">Start</button>` : ''}
          ${canPlan && s.state === 'active' ? `<select id="carry-${s.id}"><option value="backlog">carry to backlog</option>${open.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}</select><button class="danger" data-complete="${s.id}">Complete</button>` : ''}
          <a href="#/p/${pid}/sprint/${s.id}">report</a>
        </div></div>
      <table>${list.map((i) => `<tr><td><a href="#/issue/${esc(i.key)}">${esc(i.key)}</a></td><td>${esc(i.title)}</td><td>${esc(i.status)}</td><td>${i.storyPoints ?? ''}</td>
        <td>${canPlan ? moveSelect(i) : ''}</td></tr>`).join('') || '<tr><td class="muted">Empty sprint</td></tr>'}</table></div>`;
  };
  const moveSelect = (i) => `<select data-move="${esc(i.key)}"><option value="">move…</option><option value="backlog">Backlog</option>${sprints.filter((s) => s.state !== 'completed').map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select>`;
  const backlog = issues.filter((i) => !i.sprintId && !i.parentId);
  setView(`<h2>${esc(project.key)} · backlog</h2>
    <div id="flash" class="error" hidden></div>
    ${canPlan ? `<form id="new-sprint" class="card row"><input name="name" placeholder="Sprint name" required>
      <label>start <input type="date" name="startDate"></label><label>end <input type="date" name="endDate"></label><button class="primary">New sprint</button></form>` : ''}
    ${sprints.filter((s) => s.state !== 'completed').map(sprintBlock).join('')}
    <div class="card"><strong>Backlog</strong> <span class="muted">${backlog.length} issues</span>
      <table>${backlog.map((i) => `<tr><td><a href="#/issue/${esc(i.key)}">${esc(i.key)}</a></td><td>${esc(i.type)}</td><td>${esc(i.title)}</td><td>${esc(i.priority)}</td><td>${i.storyPoints ?? ''}</td><td>${canPlan ? moveSelect(i) : ''}</td></tr>`).join('')}</table></div>
    ${sprints.some((s) => s.state === 'completed') ? `<div class="card"><strong>Completed sprints</strong>${sprints.filter((s) => s.state === 'completed').map((s) => `<div><a href="#/p/${pid}/sprint/${s.id}">${esc(s.name)}</a></div>`).join('')}</div>` : ''}
    <p class="muted">Members: ${members.map((m) => `${esc(m.username)} (${esc(m.role)})`).join(', ')}</p>`);
  const flash = (msg) => { const b = $('#flash'); b.hidden = false; b.textContent = msg; };
  const ns = $('#new-sprint');
  if (ns) ns.onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try { await api('POST', `/projects/${pid}/sprints`, { name: f.name, startDate: f.startDate || undefined, endDate: f.endDate || undefined }); viewBacklog(pid); }
    catch (err) { flash(err.message); }
  };
  document.querySelectorAll('[data-start]').forEach((b) => b.onclick = async () => {
    try { await api('POST', `/sprints/${b.dataset.start}/start`); viewBacklog(pid); } catch (err) { flash(err.message); }
  });
  document.querySelectorAll('[data-complete]').forEach((b) => b.onclick = async () => {
    const carryOverTo = $(`#carry-${b.dataset.complete}`).value;
    try { await api('POST', `/sprints/${b.dataset.complete}/complete`, { carryOverTo }); viewBacklog(pid); } catch (err) { flash(err.message); }
  });
  document.querySelectorAll('[data-move]').forEach((sel) => sel.onchange = async () => {
    if (!sel.value) return;
    try { await api('PATCH', `/issues/${sel.dataset.move}`, { sprintId: sel.value === 'backlog' ? null : sel.value }); viewBacklog(pid); }
    catch (err) { flash(err.message); }
  });
}

async function viewIssue(key) {
  const issue = await api('GET', `/issues/${key}`);
  const [project, comments, history, sprints, all] = await Promise.all([
    api('GET', `/projects/${issue.projectId}`), api('GET', `/issues/${key}/comments`), api('GET', `/issues/${key}/history`),
    api('GET', `/projects/${issue.projectId}/sprints`), api('GET', `/projects/${issue.projectId}/issues`),
  ]);
  state.projectId = issue.projectId;
  const canEdit = project.myRole !== 'viewer';
  const userName = (id) => project.members.find((m) => m.userId === id)?.username || (id ? id.slice(0, 8) : '—');
  const opt = (arr, cur, label = (x) => x) => arr.map((x) => `<option value="${esc(x.v ?? x)}" ${(x.v ?? x) === cur ? 'selected' : ''}>${esc(label(x))}</option>`).join('');
  const watching = issue.watchers.includes(state.user?.id);
  const statusOpts = project.workflow.statuses.map((s) => ({ v: s.name, t: s.name }));
  const epics = all.filter((i) => i.type === 'epic' && i.id !== issue.id);
  setView(`<h2>${esc(issue.key)} · ${esc(issue.title)}</h2>
    <div id="flash" class="error" hidden></div>
    <div class="row"><button id="watch">${watching ? 'Unwatch' : 'Watch'}</button>
      <a href="#/p/${issue.projectId}/board">board</a> · <a href="#/p/${issue.projectId}/backlog">backlog</a>
      ${issue.parentKey ? ` · parent <a href="#/issue/${esc(issue.parentKey)}">${esc(issue.parentKey)}</a>` : ''}
      ${issue.epicKey ? ` · epic <a href="#/issue/${esc(issue.epicKey)}">${esc(issue.epicKey)}</a>` : ''}</div>
    <div class="card kv" id="fields">
      <label>Status</label><select data-f="status" ${canEdit ? '' : 'disabled'}>${opt(statusOpts, issue.status, (x) => x.t)}</select>
      <label>Type</label><select data-f="type" ${canEdit ? '' : 'disabled'}>${opt(['bug', 'feature', 'task', 'epic', 'subtask'], issue.type)}</select>
      <label>Priority</label><select data-f="priority" ${canEdit ? '' : 'disabled'}>${opt(['urgent', 'high', 'medium', 'low', 'none'], issue.priority)}</select>
      <label>Assignee</label><select data-f="assigneeId" ${canEdit ? '' : 'disabled'}><option value="">unassigned</option>${opt(project.members.map((m) => ({ v: m.userId, t: m.username })), issue.assigneeId, (x) => x.t)}</select>
      <label>Story points</label><input data-f="storyPoints" type="number" min="0" step="any" value="${issue.storyPoints ?? ''}" ${canEdit ? '' : 'disabled'}>
      <label>Due date</label><input data-f="dueDate" type="date" value="${issue.dueDate ?? ''}" ${canEdit ? '' : 'disabled'}>
      <label>Sprint</label><select data-f="sprintId" ${canEdit ? '' : 'disabled'}><option value="">backlog</option>${opt(sprints.filter((s) => s.state !== 'completed' || s.id === issue.sprintId).map((s) => ({ v: s.id, t: s.name })), issue.sprintId, (x) => x.t)}</select>
      <label>Epic</label><select data-f="epicId" ${canEdit ? '' : 'disabled'}><option value="">none</option>${opt(epics.map((e) => ({ v: e.id, t: e.key + ' ' + e.title })), issue.epicId, (x) => x.t)}</select>
      <label>Labels</label><input data-f="labels" value="${esc(issue.labels.join(', '))}" ${canEdit ? '' : 'disabled'}>
      <label>Reporter</label><span>${esc(userName(issue.reporterId))}</span>
      <label>Created / resolved</label><span>${fmt(issue.createdAt)} / ${fmt(issue.resolvedAt) || '—'}</span>
    </div>
    <div class="card"><strong>Description</strong>
      <textarea id="desc" ${canEdit ? '' : 'disabled'}>${esc(issue.description)}</textarea>
      ${canEdit ? '<div><button id="save-desc">Save description</button></div>' : ''}</div>
    ${issue.progress ? `<div class="card">Epic progress: ${issue.progress.done}/${issue.progress.total} issues · ${issue.progress.points_done}/${issue.progress.points_total} pts</div>` : ''}
    <div class="card"><strong>Subtasks</strong>
      <ul>${issue.children.map((k) => `<li><a href="#/issue/${esc(k)}">${esc(k)}</a></li>`).join('') || '<li class="muted">none</li>'}</ul>
      ${canEdit && issue.type !== 'subtask' && issue.type !== 'epic' ? `<form id="new-sub" class="row"><input name="title" placeholder="Subtask title" required><button>Add subtask</button></form>` : ''}</div>
    <div class="card"><strong>Links</strong>
      <ul>${issue.links.map((l) => `<li>${esc(l.type)} <a href="#/issue/${esc(l.key)}">${esc(l.key)}</a> ${esc(l.title)} <span class="muted">${esc(l.status)}</span>
        ${canEdit ? `<button data-unlink="${esc(l.id)}">remove</button>` : ''}</li>`).join('') || '<li class="muted">none</li>'}</ul>
      ${canEdit ? `<form id="new-link" class="row"><select name="type"><option>blocks</option><option>relates</option><option>duplicates</option></select>
        <input name="target" placeholder="target key e.g. ${esc(project.key)}-1" required><button>Link</button></form>` : ''}</div>
    <div class="card"><strong>Comments</strong>
      ${comments.map((c) => `<div class="notif"><div class="muted">${esc(userName(c.authorId))} · ${fmt(c.createdAt)}${c.edited ? ' · edited' : ''}</div>
        <div>${esc(c.body)}</div>${c.authorId === state.user?.id ? `<button data-edit="${esc(c.id)}">edit</button>` : ''}</div>`).join('') || '<p class="muted">No comments.</p>'}
      <form id="new-comment"><textarea name="body" placeholder="Write a comment; use @username to mention"></textarea><button class="primary">Comment</button></form></div>
    <div class="card"><strong>History</strong><table>${history.map((h) => `<tr><td>${fmt(h.at)}</td><td>${esc(userName(h.actorId))}</td><td>${esc(h.field)}</td><td>${esc(JSON.stringify(h.from))}</td><td>→ ${esc(JSON.stringify(h.to))}</td></tr>`).join('') || '<tr><td class="muted">No changes yet.</td></tr>'}</table></div>`);

  const flash = (msg) => { const b = $('#flash'); b.hidden = false; b.textContent = msg; };
  const refresh = () => viewIssue(key);
  $('#watch').onclick = async () => { try { await api(watching ? 'DELETE' : 'POST', `/issues/${key}/watch`); refresh(); } catch (e) { flash(e.message); } };
  document.querySelectorAll('#fields [data-f]').forEach((el) => el.addEventListener('change', async () => {
    const f = el.dataset.f;
    let v = el.value;
    if (f === 'storyPoints') v = v === '' ? null : Number(v);
    else if (f === 'labels') v = v.split(',').map((s) => s.trim()).filter(Boolean);
    else if (['assigneeId', 'sprintId', 'epicId', 'dueDate'].includes(f)) v = v || null;
    try { await api('PATCH', `/issues/${key}`, { [f]: v }); refresh(); } catch (e) { flash(e.message); }
  }));
  const sd = $('#save-desc');
  if (sd) sd.onclick = async () => { try { await api('PATCH', `/issues/${key}`, { description: $('#desc').value }); refresh(); } catch (e) { flash(e.message); } };
  const ns = $('#new-sub');
  if (ns) ns.onsubmit = async (e) => {
    e.preventDefault();
    try { await api('POST', `/projects/${issue.projectId}/issues`, { type: 'subtask', title: new FormData(e.target).get('title'), parentId: issue.id }); refresh(); }
    catch (err) { flash(err.message); }
  };
  const nl = $('#new-link');
  if (nl) nl.onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    try { await api('POST', `/issues/${key}/links`, f); refresh(); } catch (err) { flash(err.message); }
  };
  document.querySelectorAll('[data-unlink]').forEach((b) => b.onclick = async () => {
    try { await api('DELETE', `/issues/${key}/links/${b.dataset.unlink}`); refresh(); } catch (e) { flash(e.message); }
  });
  $('#new-comment').onsubmit = async (e) => {
    e.preventDefault();
    const body = new FormData(e.target).get('body');
    if (!body.trim()) return;
    try { await api('POST', `/issues/${key}/comments`, { body }); refresh(); } catch (err) { flash(err.message); }
  };
  document.querySelectorAll('[data-edit]').forEach((b) => b.onclick = async () => {
    const body = prompt('Edit comment');
    if (body == null) return;
    try { await api('PATCH', `/comments/${b.dataset.edit}`, { body }); refresh(); } catch (e) { flash(e.message); }
  });
}

async function viewSearch(q, p) {
  const params = new URLSearchParams({ q });
  if (p) params.set('project', p);
  const sort = 'updated';
  setView(`<h2>Search</h2><div class="muted">Terms are ANDed. Examples: status:"In Progress" type:bug priority:high assignee:me label:ui sprint:active is:open due:&lt;2026-06-01 points:&gt;3 -label:wontfix "exact phrase"</div>
    <form id="sq" class="row" style="margin:8px 0"><input name="q" class="grow" value="${esc(q)}"><button class="primary">Search</button></form>
    <div id="flash" class="error" hidden></div><div id="results"></div>`);
  $('#sq').onsubmit = (e) => { e.preventDefault(); location.hash = `#/search?q=${encodeURIComponent(new FormData(e.target).get('q'))}${p ? `&p=${p}` : ''}`; };
  if (!q.trim()) return;
  try {
    const rows = await api('GET', `/search?${params}&sort=${sort}`);
    $('#results').innerHTML = `<table><tr><th>Key</th><th>Type</th><th>Title</th><th>Status</th><th>Priority</th></tr>${rows.map((i) => `<tr><td><a href="#/issue/${esc(i.key)}">${esc(i.key)}</a></td><td>${esc(i.type)}</td><td>${esc(i.title)}</td><td>${esc(i.status)}</td><td>${esc(i.priority)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">No matches.</td></tr>'}</table>`;
  } catch (e) {
    const b = $('#flash'); b.hidden = false; b.textContent = e.message;
  }
}

async function viewSprint(pid, sid) {
  const [report, sprints] = await Promise.all([api('GET', `/sprints/${sid}/report`), api('GET', `/projects/${pid}/sprints`)]);
  const s = sprints.find((x) => x.id === sid);
  const bd = report.burndown;
  const W = 640, H = 240, pad = 36;
  const max = Math.max(report.committedPoints, ...bd.map((d) => d.remainingPoints), 1);
  const x = (i) => pad + (bd.length <= 1 ? 0 : (i * (W - 2 * pad)) / (bd.length - 1));
  const y = (v) => H - pad - (v / max) * (H - 2 * pad);
  const line = bd.map((d, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.remainingPoints).toFixed(1)}`).join(' ');
  const svg = bd.length ? `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="burndown">
    <line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" stroke="#999"/>
    <line x1="${pad}" y1="${pad}" x2="${pad}" y2="${H - pad}" stroke="#999"/>
    <text x="4" y="${pad}" font-size="11">${max}</text><text x="4" y="${H - pad}" font-size="11">0</text>
    <path d="${line}" fill="none" stroke="#3658c8" stroke-width="2"/>
    ${bd.map((d, i) => `<circle cx="${x(i)}" cy="${y(d.remainingPoints)}" r="3" fill="#3658c8"><title>${esc(d.date)}: ${d.remainingPoints} pts</title></circle>`).join('')}
    <text x="${pad}" y="${H - 8}" font-size="11">${esc(bd[0].date)}</text><text x="${W - pad - 70}" y="${H - 8}" font-size="11">${esc(bd[bd.length - 1].date)}</text>
  </svg>` : '<p class="muted">Sprint has not started yet.</p>';
  setView(`<h2>${esc(s?.name || 'Sprint')} · report <span class="tag">${esc(s?.state || '')}</span></h2>
    <div class="card kv">
      <label>Committed points</label><span>${report.committedPoints}</span>
      <label>Completed points</label><span>${report.completedPoints}</span>
      <label>Completed issues</label><span>${report.completedIssues.map((k) => `<a href="#/issue/${esc(k)}">${esc(k)}</a>`).join(', ') || '—'}</span>
      <label>Carried over</label><span>${report.carriedOver.map((k) => `<a href="#/issue/${esc(k)}">${esc(k)}</a>`).join(', ') || '—'}</span>
    </div>
    <div class="card"><strong>Burndown</strong>${svg}</div>
    <a href="#/p/${pid}/backlog">← back to backlog</a>`);
}

async function viewSettings(pid) {
  const project = await api('GET', `/projects/${pid}`);
  const lead = project.myRole === 'lead';
  const webhooks = lead ? await api('GET', `/projects/${pid}/webhooks`) : [];
  const wfText = project.workflow.statuses.map((s) => `${s.name}|${s.category}`).join('\n');
  const trText = project.workflow.transitions.map(([a, b]) => `${a} -> ${b}`).join('\n');
  setView(`<h2>${esc(project.key)} · settings <span class="muted">your role: ${esc(project.myRole)}</span></h2>
    <div id="flash" class="error" hidden></div>
    <div class="card"><strong>Workflow</strong>
      ${lead ? `<form id="wf"><p class="muted">One status per line as <code>Name|category</code> (backlog, unstarted, started, completed). Transitions one per line as <code>From -> To</code>.</p>
        <div class="row"><textarea name="statuses" style="min-height:140px">${esc(wfText)}</textarea><textarea name="transitions" style="min-height:140px">${esc(trText)}</textarea></div>
        <p class="muted">Statuses removed while in use are remapped with lines <code>Old => New</code> in the box below.</p>
        <textarea name="remap" style="min-height:50px" placeholder="Old => New"></textarea>
        <div><button class="primary">Save workflow</button></div></form>` : `<pre>${esc(wfText)}</pre>`}</div>
    <div class="card"><strong>Members</strong>
      <table>${project.members.map((m) => `<tr><td>${esc(m.username)}</td><td>${esc(m.role)}</td><td>${lead ? `<button data-rm="${esc(m.username)}">remove</button>` : ''}</td></tr>`).join('')}</table>
      ${lead ? `<form id="add-mem" class="row"><input name="username" placeholder="username" required><select name="role"><option>developer</option><option>viewer</option><option>lead</option></select><button>Add member</button></form>` : ''}</div>
    ${lead ? `<div class="card"><strong>Webhooks</strong>
      <table>${webhooks.map((w) => `<tr><td>${esc(w.url)}</td><td>${esc(w.events.join(', '))}</td><td><button data-dl="${esc(w.id)}">deliveries</button> <button class="danger" data-del="${esc(w.id)}">delete</button></td></tr><tr><td colspan="3"><div id="dl-${esc(w.id)}"></div></td></tr>`).join('')}</table>
      <form id="new-hook" class="row"><input name="url" placeholder="https://…" required><input name="secret" placeholder="secret" required>
        <select name="events" multiple size="4"><option>issue.created</option><option>issue.updated</option><option>issue.deleted</option><option>comment.created</option></select><button>Add webhook</button></form></div>` : ''}`);
  const flash = (msg) => { const b = $('#flash'); b.hidden = false; b.textContent = msg; };
  if (lead) {
    $('#wf').onsubmit = async (e) => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData(e.target));
      const statuses = f.statuses.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [name, category] = l.split('|').map((x) => x.trim()); return { name, category }; });
      const transitions = f.transitions.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.split('->').map((x) => x.trim()));
      const remap = Object.fromEntries(f.remap.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.split('=>').map((x) => x.trim())));
      try { await api('PUT', `/projects/${pid}/workflow`, { statuses, transitions, remap }); viewSettings(pid); } catch (err) { flash(err.message); }
    };
    $('#add-mem').onsubmit = async (e) => {
      e.preventDefault();
      try { await api('POST', `/projects/${pid}/members`, Object.fromEntries(new FormData(e.target))); viewSettings(pid); } catch (err) { flash(err.message); }
    };
    document.querySelectorAll('[data-rm]').forEach((b) => b.onclick = async () => {
      try { await api('DELETE', `/projects/${pid}/members/${b.dataset.rm}`); viewSettings(pid); } catch (err) { flash(err.message); }
    });
    $('#new-hook').onsubmit = async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try { await api('POST', `/projects/${pid}/webhooks`, { url: fd.get('url'), secret: fd.get('secret'), events: fd.getAll('events') }); viewSettings(pid); } catch (err) { flash(err.message); }
    };
    document.querySelectorAll('[data-del]').forEach((b) => b.onclick = async () => {
      try { await api('DELETE', `/webhooks/${b.dataset.del}`); viewSettings(pid); } catch (err) { flash(err.message); }
    });
    document.querySelectorAll('[data-dl]').forEach((b) => b.onclick = async () => {
      const list = await api('GET', `/webhooks/${b.dataset.dl}/deliveries`);
      $(`#dl-${b.dataset.dl}`).innerHTML = `<table>${list.map((d) => `<tr><td>${fmt(d.at)}</td><td>${esc(d.event)}</td><td>status ${esc(d.status ?? 'none')}</td><td>attempts ${d.attempts}</td><td>${esc(d.lastError || '')}</td></tr>`).join('') || '<tr><td class="muted">No deliveries.</td></tr>'}</table>`;
    });
  }
}

async function viewAccount() {
  const tokens = await api('GET', '/tokens');
  setView(`<h2>Account</h2><div class="card"><strong>${esc(state.user?.username)}</strong>
    <form id="pw" class="row"><input name="displayName" placeholder="display name"><input name="currentPassword" type="password" placeholder="current password" required>
      <input name="password" type="password" placeholder="new password (optional)"><button>Update</button></form><div id="flash"></div></div>
    <div class="card"><strong>API tokens</strong>
      <form id="tok" class="row"><input name="name" placeholder="token name" required><button>Create token</button></form>
      <div id="new-token"></div>
      <table>${tokens.map((t) => `<tr><td>${esc(t.name)}</td><td class="muted">${fmt(t.createdAt)}</td><td><button class="danger" data-tok="${esc(t.id)}">revoke</button></td></tr>`).join('')}</table></div>
    <button id="logout">Sign out</button>`);
  $('#logout').onclick = () => logout(true);
  $('#pw').onsubmit = async (e) => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const body = { currentPassword: f.currentPassword };
    if (f.displayName) body.displayName = f.displayName;
    if (f.password) body.password = f.password;
    try { state.user = (await api('PATCH', '/auth/me', body)).user; viewAccount(); } catch (err) { flash(err.message); }
  };
  $('#tok').onsubmit = async (e) => {
    e.preventDefault();
    try { const t = await api('POST', '/tokens', { name: new FormData(e.target).get('name') }); $('#new-token').innerHTML = `<div class="card">Copy now (shown once): <code>${esc(t.token)}</code></div>`; viewAccount(); } catch (err) { flash(err.message); }
  };
  document.querySelectorAll('[data-tok]').forEach((b) => b.onclick = async () => { await api('DELETE', `/tokens/${b.dataset.tok}`); viewAccount(); });
}

// ---------- router
async function route() {
  const hash = location.hash || '#/ws';
  const [path, qs = ''] = hash.slice(1).split('?');
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts[0] === 'login' || parts[0] === 'register') {
    if (state.token && parts[0] === 'login') { location.hash = '#/ws'; return; }
    return viewLogin(parts[0]);
  }
  if (!state.token) { location.hash = '#/login'; return; }
  try {
    if (!state.user) state.user = (await api('GET', '/auth/me')).user;
    showChrome(true);
    await loadWorkspaces();
    const [a, b, c] = parts.slice(1);
    if (parts[0] === 'ws' || !parts[0]) return viewWorkspaceHome();
    if (parts[0] === 'p' && parts[1]) {
      state.projectId = parts[1];
      localStorage.setItem('pm.project', parts[1]);
      if (parts[2] === 'board') return viewBoard(parts[1]);
      if (parts[2] === 'backlog') return viewBacklog(parts[1]);
      if (parts[2] === 'settings') return viewSettings(parts[1]);
      if (parts[2] === 'sprint' && parts[3]) return viewSprint(parts[1], parts[3]);
    }
    if (parts[0] === 'issue' && parts[1]) return viewIssue(parts[1]);
    if (parts[0] === 'search') {
      const p = new URLSearchParams(qs);
      return viewSearch(p.get('q') || '', p.get('p') || '');
    }
    if (parts[0] === 'me') return viewAccount();
    return viewWorkspaceHome();
  } catch (e) {
    if (e.status === 401) return logout(true);
    setView(`<div class="card">${errBox(e)}</div>`);
  }
}

window.addEventListener('hashchange', route);
route();
