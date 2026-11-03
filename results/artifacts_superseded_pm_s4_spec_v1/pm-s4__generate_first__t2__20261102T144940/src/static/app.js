// pm-s4 SPA — uses only the public REST API
const $app = document.getElementById('app');
const S = { token: localStorage.getItem('token'), user: null, workspaces: [], ws: null, projects: [], project: null, view: 'board', issues: [], sprints: [], notifs: [], error: '', modal: null, results: null, report: null };

async function api(method, path, body, raw) {
  const r = await fetch(path, { method, headers: { ...(raw ? { 'content-type': 'text/csv' } : body ? { 'content-type': 'application/json' } : {}), ...(S.token ? { authorization: 'Bearer ' + S.token } : {}) }, body: raw ?? (body ? JSON.stringify(body) : undefined) });
  const text = await r.text(); let data = null; try { data = JSON.parse(text); } catch { data = text; }
  if (!r.ok) { if (r.status === 401 && S.token) { S.token = null; localStorage.removeItem('token'); } throw new Error(data?.message || r.statusText); }
  return data;
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const act = (fn) => async (...a) => { try { S.error = ''; await fn(...a); } catch (e) { S.error = e.message; } render(); };
const $ = (sel, root = document) => root.querySelector(sel);
const on = (sel, ev, fn) => document.querySelectorAll(sel).forEach(el => el.addEventListener(ev, e => fn(e, el)));

async function loadAll() {
  S.user = await api('GET', '/api/auth/me');
  S.workspaces = await api('GET', '/api/workspaces');
  if (!S.ws || !S.workspaces.find(w => w.id === S.ws.id)) S.ws = S.workspaces[0] || null;
  S.projects = S.ws ? await api('GET', `/api/workspaces/${S.ws.id}/projects`) : [];
  if (!S.project || !S.projects.find(p => p.id === S.project.id)) S.project = S.projects[0] || null;
  else S.project = S.projects.find(p => p.id === S.project.id);
  S.issues = []; S.sprints = [];
  if (S.project) { S.issues = await api('GET', `/api/projects/${S.project.id}/issues`); S.sprints = await api('GET', `/api/projects/${S.project.id}/sprints`); }
  S.notifs = await api('GET', '/api/notifications');
}
async function refresh() { await loadAll(); }

function loginView() {
  $app.innerHTML = `<div class="login panel"><h2>pm-s4</h2><div class="err">${esc(S.error)}</div>
  <input id="u" placeholder="username"><input id="p" type="password" placeholder="password">
  <button id="login">Log in</button> <button id="reg">Register</button></div>`;
  const creds = () => ({ username: $('#u').value, password: $('#p').value });
  $('#login').onclick = act(async () => { const r = await api('POST', '/api/auth/login', creds()); S.token = r.token; localStorage.setItem('token', r.token); await loadAll(); });
  $('#reg').onclick = act(async () => { await api('POST', '/api/auth/register', creds()); const r = await api('POST', '/api/auth/login', creds()); S.token = r.token; localStorage.setItem('token', r.token); await loadAll(); });
}

function card(i) {
  return `<div class="card" draggable="true" data-key="${esc(i.key)}"><b>${esc(i.key)}</b> ${esc(i.title)}<br><small>${esc(i.type)} · ${esc(i.priority)}${i.storyPoints != null ? ' · ' + i.storyPoints + 'pt' : ''}</small></div>`;
}
function boardView() {
  const sts = S.project.workflow.statuses;
  return `<div class="board">${sts.map(s => `<div class="col" data-status="${esc(s.name)}"><h4>${esc(s.name)} <span class="badge">${S.issues.filter(i => i.status === s.name).length}</span></h4>${S.issues.filter(i => i.status === s.name).map(card).join('')}</div>`).join('')}</div>`;
}
function backlogView() {
  const bySprint = (id) => S.issues.filter(i => (i.sprintId || null) === id);
  const sprintBlock = (s) => `<div class="panel"><h4>${esc(s.name)} <span class="badge">${s.state}</span> ${s.startDate || ''} ${s.endDate ? '→ ' + s.endDate : ''}
   ${s.state === 'planned' ? `<button data-start="${s.id}">Start</button>` : ''}${s.state === 'active' ? `<button data-complete="${s.id}">Complete</button>` : ''}
   ${s.state !== 'planned' ? `<button data-report="${s.id}">Report</button>` : ''}</h4>
   ${bySprint(s.id).map(i => issueRow(i)).join('') || '<small>No issues</small>'}</div>`;
  return `<div class="panel"><input id="sname" placeholder="Sprint name"> <input id="sstart" type="date"> <input id="send" type="date"> <button id="addsprint">Create sprint</button></div>
  ${S.sprints.filter(s => s.state !== 'completed').map(sprintBlock).join('')}
  <div class="panel"><h4>Backlog</h4>${bySprint(null).map(i => issueRow(i)).join('') || '<small>Empty</small>'}</div>`;
}
function issueRow(i) {
  const opts = S.sprints.filter(s => s.state !== 'completed').map(s => `<option value="${s.id}" ${i.sprintId === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  return `<div class="card" data-key="${esc(i.key)}"><b>${esc(i.key)}</b> ${esc(i.title)} <span class="badge">${esc(i.status)}</span>
    <select data-plan="${esc(i.key)}" onclick="event.stopPropagation()"><option value="">Backlog</option>${opts}</select></div>`;
}
function reportView() {
  const r = S.report; if (!r) return '';
  const w = 520, h = 220, pad = 30; const pts = r.burndown; const max = Math.max(1, ...pts.map(p => p.remainingPoints));
  const x = (n) => pad + (pts.length > 1 ? n * (w - 2 * pad) / (pts.length - 1) : 0), y = (v) => h - pad - v * (h - 2 * pad) / max;
  const line = pts.map((p, n) => `${x(n)},${y(p.remainingPoints)}`).join(' ');
  return `<div class="panel"><h3>Sprint report</h3><p>Committed ${r.committedPoints} · Completed ${r.completedPoints} (${r.completedIssues} issues) · Carried over ${r.carriedOver}</p>
  <svg id="burndown" width="${w}" height="${h}" style="background:#fafafa"><line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="#999"/><line x1="${pad}" y1="${pad}" x2="${pad}" y2="${h - pad}" stroke="#999"/>
  <polyline fill="none" stroke="#0747a6" stroke-width="2" points="${line}"/>${pts.map((p, n) => `<circle cx="${x(n)}" cy="${y(p.remainingPoints)}" r="3" fill="#0747a6"><title>${p.date}: ${p.remainingPoints}</title></circle>`).join('')}
  <text x="${pad}" y="14" font-size="11">max ${max} pts</text></svg></div>`;
}
function settingsView() {
  const p = S.project;
  return `<div class="panel"><h3>Workflow</h3><p><small>One status per line: <code>Name:category</code> (backlog|unstarted|started|completed). Transitions: <code>From>To</code> lines; blank = any→any. Remap lines: <code>Old=>New</code>.</small></p>
  <textarea id="wf-st" rows="6" cols="40">${p.workflow.statuses.map(s => s.name + ':' + s.category).join('\n')}</textarea>
  <textarea id="wf-tr" rows="6" cols="30" placeholder="From>To"></textarea><textarea id="wf-rm" rows="6" cols="30" placeholder="Old=>New"></textarea><br><button id="savewf">Save workflow</button></div>
  <div class="panel"><h3>Members</h3><table>${p.members.map(m => `<tr><td>${esc(m.username)}</td><td>${m.role}</td><td><button data-rmmember="${m.userId}">Remove</button></td></tr>`).join('')}</table>
  <input id="mname" placeholder="username"> <select id="mrole"><option>developer</option><option>lead</option><option>viewer</option></select> <button id="addmember">Add</button></div>
  <div class="panel"><h3>Webhooks</h3><div id="hooks"></div><input id="hurl" placeholder="https://..."> <input id="hsecret" placeholder="secret">
  <select id="hev" multiple size="4"><option>issue.created</option><option>issue.updated</option><option>issue.deleted</option><option>comment.created</option></select> <button id="addhook">Add webhook</button></div>
  <div class="panel"><h3>Workspace</h3><input id="wmname" placeholder="username"> <select id="wmrole"><option>member</option><option>admin</option><option>guest</option></select> <button id="addwm">Add to workspace</button>
  <table>${S.ws.members.map(m => `<tr><td>${esc(m.username)}</td><td>${m.role}</td></tr>`).join('')}</table></div>
  <div class="panel"><h3>CSV</h3><a href="#" id="export">Export CSV</a> · <input type="file" id="importfile" accept=".csv"></div>`;
}
function notifView() {
  return `<div class="panel"><h3>Notifications</h3><button id="readall">Mark all read</button>${S.notifs.map(n => `<div class="notif ${n.read ? '' : 'unread'}" data-key="${esc(n.issueKey)}">${esc(n.type)} — ${esc(n.issueKey)} <small>${esc(n.at)}</small></div>`).join('') || '<small>None</small>'}</div>`;
}
function searchView() {
  return `<div class="panel"><h3>Search results</h3>${(S.results || []).map(i => issueRow(i)).join('') || '<small>No results</small>'}</div>`;
}
function modalView() {
  const m = S.modal; if (!m) return '';
  const i = m.issue;
  return `<div class="modal" id="modal"><div><button id="closem" style="float:right">×</button><h3>${esc(i.key)} ${esc(i.title)}</h3>
  <p>${esc(i.description)}</p>
  <p>Status: <select id="mstatus">${S.project.workflow.statuses.map(s => `<option ${s.name === i.status ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
  Priority: <select id="mprio">${['urgent', 'high', 'medium', 'low', 'none'].map(p => `<option ${p === i.priority ? 'selected' : ''}>${p}</option>`).join('')}</select>
  <button id="watch">Watch</button> <button id="delissue">Delete</button></p>
  <p>Type: ${i.type} · Points: ${i.storyPoints ?? '-'} · Labels: ${esc(i.labels.join(', '))} · Due: ${i.dueDate || '-'}</p>
  <h4>Subtasks</h4>${i.children.map(k => `<div class="card" data-key="${esc(k)}">${esc(k)}</div>`).join('') || '<small>None</small>'}
  <input id="subtitle" placeholder="New subtask title"><button id="addsub">Add subtask</button>
  ${i.progress ? `<p>Epic progress: ${i.progress.done}/${i.progress.total} issues, ${i.progress.points_done}/${i.progress.points_total} pts</p>` : ''}
  <h4>Links</h4>${i.links.map(l => `<div>${esc(l.type)} ${esc(l.key)} <button data-rmlink="${l.id}">x</button></div>`).join('') || '<small>None</small>'}
  <select id="ltype"><option>blocks</option><option>relates</option><option>duplicates</option></select><input id="ltarget" placeholder="KEY-1"><button id="addlink">Link</button>
  <h4>Comments</h4>${m.comments.map(c => `<div class="panel">${esc(c.body)}${c.edited ? ' <small>(edited)</small>' : ''}<br><small>${esc(c.createdAt)}</small></div>`).join('')}
  <textarea id="cbody" rows="2" style="width:100%" placeholder="Comment (use @username)"></textarea><button id="addc">Comment</button>
  <h4>History</h4><table>${m.history.map(h => `<tr><td>${esc(h.field)}</td><td>${esc(JSON.stringify(h.from))} → ${esc(JSON.stringify(h.to))}</td><td>${esc(h.at)}</td></tr>`).join('')}</table></div></div>`;
}

function render() {
  if (!S.token) return loginView();
  if (!S.user) return;
  const tabs = ['board', 'backlog', 'report', 'settings', 'notifications', 'search'];
  $app.innerHTML = `<header><b>pm-s4</b>
   <select id="wsel">${S.workspaces.map(w => `<option value="${w.id}" ${S.ws?.id === w.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select>
   <button id="newws">+ workspace</button>
   <select id="psel">${S.projects.map(p => `<option value="${p.id}" ${S.project?.id === p.id ? 'selected' : ''}>${esc(p.key)} ${esc(p.name)}</option>`).join('')}</select>
   <button id="newproj">+ project</button>
   <input id="q" placeholder='search e.g. status:"In Progress" -label:x' size="36" value="${esc(S.q || '')}"><button id="go">Search</button>
   <span style="flex:1"></span><button id="newissue">+ issue</button><button id="bell">🔔 ${S.notifs.filter(n => !n.read).length}</button>
   <span>${esc(S.user.username)}</span><button id="logout">Logout</button></header>
   <nav>${tabs.map(t => `<button data-tab="${t}" class="${S.view === t ? 'active' : ''}">${t}</button>`).join('')}</nav>
   <main><div class="err">${esc(S.error)}</div>${S.project || S.view === 'notifications' || S.view === 'search' ? ({ board: () => boardView(), backlog: () => backlogView(), report: () => reportView() || '<div class="panel">Pick a sprint report from the backlog.</div>', settings: () => settingsView(), notifications: notifView, search: searchView }[S.view]()) : '<div class="panel">Create a workspace and a project to begin.</div>'}</main>${modalView()}`;
  bind();
}

async function openIssue(key) {
  const [issue, comments, history] = await Promise.all([api('GET', `/api/issues/${key}`), api('GET', `/api/issues/${key}/comments`), api('GET', `/api/issues/${key}/history`)]);
  S.modal = { issue, comments, history };
}
const reopen = async () => { const k = S.modal.issue.key; await refresh(); await openIssue(k); };

function bind() {
  $('#wsel').onchange = act(async (e) => { S.ws = S.workspaces.find(w => w.id === e.target.value); S.project = null; await loadAll(); });
  $('#psel').onchange = act(async (e) => { S.project = S.projects.find(p => p.id === e.target.value); await loadAll(); });
  $('#newws').onclick = act(async () => { const name = prompt('Workspace name'); if (!name) return; const key = prompt('Key (2-10 uppercase letters)'); S.ws = await api('POST', '/api/workspaces', { name, key }); await loadAll(); });
  $('#newproj').onclick = act(async () => { if (!S.ws) return; const name = prompt('Project name'); if (!name) return; const key = prompt('Key (2-10 uppercase letters)'); S.project = await api('POST', `/api/workspaces/${S.ws.id}/projects`, { name, key }); await loadAll(); });
  $('#newissue').onclick = act(async () => { if (!S.project) return; const title = prompt('Title'); if (!title) return; const type = prompt('Type (bug|feature|task|epic)', 'task') || 'task'; await api('POST', `/api/projects/${S.project.id}/issues`, { title, type }); await refresh(); });
  $('#logout').onclick = act(async () => { try { await api('POST', '/api/auth/logout'); } catch { /* */ } S.token = null; localStorage.removeItem('token'); S.user = null; });
  const doSearch = act(async () => { S.q = $('#q').value; S.results = await api('GET', `/api/search?q=${encodeURIComponent(S.q)}${S.project ? '&project=' + S.project.key : ''}`); S.view = 'search'; });
  $('#go').onclick = doSearch; $('#q').onkeydown = (e) => { if (e.key === 'Enter') doSearch(); };
  $('#bell').onclick = () => { S.view = 'notifications'; render(); };
  on('[data-tab]', 'click', (e, el) => { S.view = el.dataset.tab; render(); });
  on('.card[data-key], .notif[data-key]', 'click', act(async (e, el) => { await openIssue(el.dataset.key); }));
  // drag & drop board
  on('.card[draggable]', 'dragstart', (e, el) => e.dataTransfer.setData('text/plain', el.dataset.key));
  on('.col', 'dragover', (e, el) => { e.preventDefault(); el.classList.add('over'); });
  on('.col', 'dragleave', (e, el) => el.classList.remove('over'));
  on('.col', 'drop', act(async (e, el) => { e.preventDefault(); const key = e.dataTransfer.getData('text/plain'); await api('PATCH', `/api/issues/${key}`, { status: el.dataset.status }); await refresh(); }));
  // backlog
  if ($('#addsprint')) $('#addsprint').onclick = act(async () => { await api('POST', `/api/projects/${S.project.id}/sprints`, { name: $('#sname').value, startDate: $('#sstart').value || undefined, endDate: $('#send').value || undefined }); await refresh(); });
  on('[data-start]', 'click', act(async (e, el) => { await api('POST', `/api/sprints/${el.dataset.start}/start`); await refresh(); }));
  on('[data-complete]', 'click', act(async (e, el) => { const planned = S.sprints.filter(s => s.state === 'planned'); const to = planned.length ? prompt('Carry over to sprint name (blank = backlog)', '') : ''; const t = planned.find(s => s.name === to); await api('POST', `/api/sprints/${el.dataset.complete}/complete`, { carryOverTo: t ? t.id : 'backlog' }); await refresh(); }));
  on('[data-report]', 'click', act(async (e, el) => { S.report = await api('GET', `/api/sprints/${el.dataset.report}/report`); S.view = 'report'; }));
  on('[data-plan]', 'change', act(async (e, el) => { await api('PATCH', `/api/issues/${el.dataset.plan}`, { sprintId: el.value || null }); await refresh(); }));
  // settings
  if ($('#savewf')) {
    $('#savewf').onclick = act(async () => {
      const statuses = $('#wf-st').value.split('\n').map(l => l.trim()).filter(Boolean).map(l => { const [name, category] = l.split(':'); return { name: name.trim(), category: (category || '').trim() }; });
      const body = { statuses }; const tr = $('#wf-tr').value.split('\n').map(l => l.trim()).filter(Boolean).map(l => l.split('>').map(x => x.trim()));
      if (tr.length) body.transitions = tr;
      const rm = {}; $('#wf-rm').value.split('\n').map(l => l.trim()).filter(Boolean).forEach(l => { const [a, b] = l.split('=>'); rm[a.trim()] = b.trim(); });
      if (Object.keys(rm).length) body.remap = rm;
      await api('PUT', `/api/projects/${S.project.id}/workflow`, body); await refresh();
    });
    $('#addmember').onclick = act(async () => { await api('POST', `/api/projects/${S.project.id}/members`, { username: $('#mname').value, role: $('#mrole').value }); await refresh(); });
    on('[data-rmmember]', 'click', act(async (e, el) => { await api('DELETE', `/api/projects/${S.project.id}/members/${el.dataset.rmmember}`); await refresh(); }));
    $('#addwm').onclick = act(async () => { await api('POST', `/api/workspaces/${S.ws.id}/members`, { username: $('#wmname').value, role: $('#wmrole').value }); await refresh(); });
    $('#addhook').onclick = act(async () => { await api('POST', `/api/projects/${S.project.id}/webhooks`, { url: $('#hurl').value, secret: $('#hsecret').value, events: [...$('#hev').selectedOptions].map(o => o.value) }); await refresh(); });
    api('GET', `/api/projects/${S.project.id}/webhooks`).then(hs => { const el = $('#hooks'); if (el) el.innerHTML = hs.map(h => `<div>${esc(h.url)} [${esc(h.events.join(', '))}] <button data-delhook="${h.id}">Delete</button></div>`).join(''); on('[data-delhook]', 'click', act(async (e, b) => { await api('DELETE', `/api/webhooks/${b.dataset.delhook}`); })); }).catch(() => {});
    $('#export').onclick = act(async (e) => { e.preventDefault(); const csv = await api('GET', `/api/projects/${S.project.id}/export.csv`); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = `${S.project.key}.csv`; a.click(); });
    $('#importfile').onchange = act(async (e) => { const f = e.target.files[0]; if (!f) return; const r = await api('POST', `/api/projects/${S.project.id}/import.csv`, null, await f.text()); S.error = `Imported ${r.created}; ${r.errors.length} errors`; await refresh(); });
  }
  if ($('#readall')) $('#readall').onclick = act(async () => { await api('POST', '/api/notifications/read', { all: true }); S.notifs = await api('GET', '/api/notifications'); });
  // modal
  if (S.modal) {
    const k = S.modal.issue.key;
    $('#closem').onclick = () => { S.modal = null; render(); };
    $('#mstatus').onchange = act(async (e) => { await api('PATCH', `/api/issues/${k}`, { status: e.target.value }); await reopen(); });
    $('#mprio').onchange = act(async (e) => { await api('PATCH', `/api/issues/${k}`, { priority: e.target.value }); await reopen(); });
    $('#watch').onclick = act(async () => { await api('POST', `/api/issues/${k}/watch`); await reopen(); });
    $('#delissue').onclick = act(async () => { await api('DELETE', `/api/issues/${k}`); S.modal = null; await refresh(); });
    $('#addsub').onclick = act(async () => { await api('POST', `/api/projects/${S.project.id}/issues`, { title: $('#subtitle').value, type: 'subtask', parentId: S.modal.issue.id }); await reopen(); });
    $('#addlink').onclick = act(async () => { await api('POST', `/api/issues/${k}/links`, { type: $('#ltype').value, target: $('#ltarget').value }); await reopen(); });
    on('[data-rmlink]', 'click', act(async (e, el) => { await api('DELETE', `/api/issues/${k}/links/${el.dataset.rmlink}`); await reopen(); }));
    $('#addc').onclick = act(async () => { await api('POST', `/api/issues/${k}/comments`, { body: $('#cbody').value }); await reopen(); });
  }
}

(async () => { if (S.token) { try { await loadAll(); } catch { S.token = null; } } render(); })();
