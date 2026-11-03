// Single-page app; talks only to the public REST API.
const $app = document.getElementById('app');
const S = { token: localStorage.getItem('token'), me: null, ws: [], wsId: null, projects: [], projId: null, project: null, view: 'board', issues: [], sprints: [], q: '', issueKey: null, notifOpen: false, err: '' };

async function api(method, path, body, raw) {
  const r = await fetch(path, { method, headers: { ...(body && !raw ? { 'content-type': 'application/json' } : {}), ...(S.token ? { authorization: 'Bearer ' + S.token } : {}) }, body: body ? (raw ? body : JSON.stringify(body)) : undefined });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error((j && j.message) || r.statusText);
  return j;
}
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
async function guard(fn) { try { S.err = ''; await fn(); } catch (e) { S.err = e.message; } render(); }

async function boot() {
  if (S.token) { try { S.me = await api('GET', '/api/auth/me'); await loadWs(); } catch { S.token = null; localStorage.removeItem('token'); } }
  render();
}
async function loadWs() {
  S.ws = await api('GET', '/api/workspaces');
  if (!S.wsId || !S.ws.find(w => w.id === S.wsId)) S.wsId = S.ws[0]?.id || null;
  await loadProjects();
}
async function loadProjects() {
  S.projects = S.wsId ? await api('GET', `/api/workspaces/${S.wsId}/projects`) : [];
  if (!S.projId || !S.projects.find(p => p.id === S.projId)) S.projId = S.projects[0]?.id || null;
  await loadProject();
}
async function loadProject() {
  S.project = S.projId ? await api('GET', `/api/projects/${S.projId}`) : null;
  S.issues = S.project ? await api('GET', `/api/projects/${S.projId}/issues?q=${encodeURIComponent(S.q)}`) : [];
  S.sprints = S.project ? await api('GET', `/api/projects/${S.projId}/sprints`) : [];
  S.notifs = await api('GET', '/api/notifications');
}

function render() {
  if (!S.me) return renderAuth();
  const unread = (S.notifs || []).filter(n => !n.read).length;
  $app.innerHTML = `<header>
    <b>PM</b>
    <select id="wsSel">${S.ws.map(w => `<option value="${w.id}" ${w.id === S.wsId ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select>
    <button id="newWs">+ workspace</button>
    <select id="projSel">${S.projects.map(p => `<option value="${p.id}" ${p.id === S.projId ? 'selected' : ''}>${esc(p.key)} - ${esc(p.name)}</option>`).join('')}</select>
    <button id="newProj">+ project</button>
    <form id="searchForm"><input id="q" size="40" placeholder='search: status:"In Progress" type:bug -label:x' value="${esc(S.q)}"><button>Search</button></form>
    <button id="bell">🔔 ${unread}</button><span>${esc(S.me.username)}</span><button id="logout">Logout</button></header>
    ${S.notifOpen ? `<div class="notif"><button id="readAll">Mark all read</button>${(S.notifs || []).slice(0, 20).map(n => `<div>${n.read ? '' : '• '}${esc(n.type)} <a href="#" data-open="${esc(n.issueKey)}">${esc(n.issueKey)}</a></div>`).join('') || 'none'}</div>` : ''}
    ${S.project ? `<nav>${['board', 'backlog', 'report', 'settings'].map(v => `<button data-view="${v}" class="${S.view === v ? 'active' : ''}">${v}</button>`).join('')}</nav>` : ''}
    <main>${S.err ? `<p class="err">${esc(S.err)}</p>` : ''}<div id="view"></div></main>`;
  bindHeader();
  const v = $('#view');
  if (!S.project) v.innerHTML = '<p>Create a workspace and a project to begin.</p>';
  else if (S.issueKey) renderIssue(v);
  else if (S.view === 'board') renderBoard(v);
  else if (S.view === 'backlog') renderBacklog(v);
  else if (S.view === 'report') renderReport(v);
  else renderSettings(v);
}

function renderAuth() {
  $app.innerHTML = `<main><div class="panel" style="max-width:320px;margin:60px auto"><h2>Project Manager</h2>${S.err ? `<p class="err">${esc(S.err)}</p>` : ''}
    <form id="authForm"><p><input name="username" placeholder="username" required></p><p><input name="password" type="password" placeholder="password" required></p>
    <button value="login">Login</button> <button value="register">Register</button></form></div></main>`;
  $('#authForm').onsubmit = e => {
    e.preventDefault();
    const f = new FormData(e.target), mode = e.submitter.value, body = { username: f.get('username'), password: f.get('password') };
    guard(async () => {
      if (mode === 'register') await api('POST', '/api/auth/register', body);
      const r = await api('POST', '/api/auth/login', body);
      S.token = r.token; localStorage.setItem('token', r.token); S.me = r.user; await loadWs();
    });
  };
}

function bindHeader() {
  $('#wsSel').onchange = e => guard(async () => { S.wsId = e.target.value; S.projId = null; await loadProjects(); });
  $('#projSel').onchange = e => guard(async () => { S.projId = e.target.value; S.issueKey = null; await loadProject(); });
  $('#newWs').onclick = () => { const name = prompt('Workspace name'); const key = name && prompt('Key (2-10 uppercase letters)'); if (key) guard(async () => { const w = await api('POST', '/api/workspaces', { name, key }); S.wsId = w.id; S.projId = null; await loadWs(); }); };
  $('#newProj').onclick = () => { const name = prompt('Project name'); const key = name && prompt('Key (2-10 uppercase letters)'); if (key) guard(async () => { const p = await api('POST', `/api/workspaces/${S.wsId}/projects`, { name, key }); S.projId = p.id; await loadProjects(); }); };
  $('#searchForm').onsubmit = e => { e.preventDefault(); S.q = $('#q').value; S.issueKey = null; guard(loadProject); };
  $('#logout').onclick = async () => { try { await api('POST', '/api/auth/logout'); } catch {} localStorage.removeItem('token'); S.token = null; S.me = null; render(); };
  $('#bell').onclick = () => { S.notifOpen = !S.notifOpen; render(); };
  const ra = $('#readAll'); if (ra) ra.onclick = () => guard(async () => { await api('POST', '/api/notifications/read', { all: true }); await loadProject(); });
  $$('[data-view]').forEach(b => b.onclick = () => { S.view = b.dataset.view; S.issueKey = null; guard(loadProject); });
  $$('[data-open]').forEach(a => a.onclick = e => { e.preventDefault(); S.issueKey = a.dataset.open; S.notifOpen = false; render(); });
}

const card = i => `<div class="card" draggable="true" data-key="${esc(i.key)}"><span class="tag">${esc(i.type)}</span><b>${esc(i.key)}</b> ${esc(i.title)}<br><span class="tag">${esc(i.priority)}</span>${i.storyPoints != null ? `<span class="tag">${i.storyPoints} pts</span>` : ''}${i.labels.map(l => `<span class="tag">${esc(l)}</span>`).join('')}</div>`;
function bindCards(root) {
  $$('.card', root).forEach(c => { c.onclick = () => { S.issueKey = c.dataset.key; render(); }; c.ondragstart = e => e.dataTransfer.setData('text/plain', c.dataset.key); });
}

function renderBoard(v) {
  const wf = S.project.workflow;
  v.innerHTML = `<form class="inline" id="newIssue"><input name="title" placeholder="New issue title" required><select name="type">${['task', 'bug', 'feature', 'epic'].map(t => `<option>${t}</option>`).join('')}</select><button>Create</button></form>
   <div class="board">${wf.statuses.map(s => `<div class="col" data-status="${esc(s.name)}"><h4>${esc(s.name)}</h4>${S.issues.filter(i => i.status === s.name).map(card).join('')}</div>`).join('')}</div>`;
  bindCards(v);
  $$('.col', v).forEach(col => {
    col.ondragover = e => { e.preventDefault(); col.classList.add('over'); };
    col.ondragleave = () => col.classList.remove('over');
    col.ondrop = e => { e.preventDefault(); const key = e.dataTransfer.getData('text/plain'); guard(async () => { await api('PATCH', `/api/issues/${key}`, { status: col.dataset.status }); await loadProject(); }); };
  });
  $('#newIssue').onsubmit = e => { e.preventDefault(); const f = new FormData(e.target); guard(async () => { await api('POST', `/api/projects/${S.projId}/issues`, { title: f.get('title'), type: f.get('type') }); await loadProject(); }); };
}

function renderBacklog(v) {
  const groups = [...S.sprints.filter(s => s.state !== 'completed').map(s => ({ s, items: S.issues.filter(i => i.sprintId === s.id) })), { s: null, items: S.issues.filter(i => !i.sprintId) }];
  v.innerHTML = `<form class="inline" id="newSprint"><input name="name" placeholder="Sprint name" required><input name="startDate" type="date"><input name="endDate" type="date"><button>Create sprint</button></form>` +
    groups.map(g => `<div class="panel"><h3>${g.s ? `${esc(g.s.name)} <small>(${g.s.state})</small>` : 'Backlog'}
      ${g.s && g.s.state === 'planned' ? `<button data-start="${g.s.id}">Start</button>` : ''}${g.s && g.s.state === 'active' ? `<button data-complete="${g.s.id}">Complete</button>` : ''}
      ${g.s ? `<button data-report="${g.s.id}">Report</button>` : ''}</h3>
      <div data-sprint="${g.s ? g.s.id : ''}" class="dropzone">${g.items.map(card).join('') || '<i>empty</i>'}</div></div>`).join('');
  bindCards(v);
  $$('.dropzone', v).forEach(z => { z.ondragover = e => e.preventDefault(); z.ondrop = e => { e.preventDefault(); const key = e.dataTransfer.getData('text/plain'); guard(async () => { await api('PATCH', `/api/issues/${key}`, { sprintId: z.dataset.sprint || null }); await loadProject(); }); }; });
  $('#newSprint').onsubmit = e => { e.preventDefault(); const f = new FormData(e.target); const b = { name: f.get('name') }; if (f.get('startDate')) b.startDate = f.get('startDate'); if (f.get('endDate')) b.endDate = f.get('endDate'); guard(async () => { await api('POST', `/api/projects/${S.projId}/sprints`, b); await loadProject(); }); };
  $$('[data-start]', v).forEach(b => b.onclick = () => guard(async () => { await api('POST', `/api/sprints/${b.dataset.start}/start`); await loadProject(); }));
  $$('[data-complete]', v).forEach(b => b.onclick = () => guard(async () => { const to = prompt('Carry over unfinished issues to (sprint id or "backlog")', 'backlog'); if (to) { await api('POST', `/api/sprints/${b.dataset.complete}/complete`, { carryOverTo: to }); await loadProject(); } }));
  $$('[data-report]', v).forEach(b => b.onclick = () => { S.sprintId = b.dataset.report; S.view = 'report'; guard(async () => {}); });
}

async function renderReport(v) {
  const sp = S.sprints.find(s => s.id === S.sprintId) || S.sprints.find(s => s.state === 'active') || S.sprints[0];
  if (!sp) { v.innerHTML = '<p>No sprints yet.</p>'; return; }
  v.innerHTML = `<div class="panel"><select id="spSel">${S.sprints.map(s => `<option value="${s.id}" ${s.id === sp.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select><div id="rep">Loading…</div></div>`;
  $('#spSel').onchange = e => { S.sprintId = e.target.value; render(); };
  try {
    const r = await api('GET', `/api/sprints/${sp.id}/report`);
    const W = 600, H = 240, P = 30, max = Math.max(1, r.committedPoints, ...r.burndown.map(b => b.remainingPoints));
    const n = r.burndown.length, x = i => P + (n > 1 ? i * (W - 2 * P) / (n - 1) : 0), y = val => H - P - val * (H - 2 * P) / max;
    const pts = r.burndown.map((b, i) => `${x(i)},${y(b.remainingPoints)}`).join(' ');
    $('#rep').innerHTML = `<p>Committed: ${r.committedPoints} pts · Completed: ${r.completedPoints} pts (${r.completedIssues} issues) · Carried over: ${r.carriedOver}</p>
      <svg id="burndown" width="${W}" height="${H}" style="background:#fff;border:1px solid #ddd"><line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" stroke="#999"/><line x1="${P}" y1="${P}" x2="${P}" y2="${H - P}" stroke="#999"/>
      <polyline fill="none" stroke="#0747a6" stroke-width="2" points="${pts}"/>${r.burndown.map((b, i) => `<circle cx="${x(i)}" cy="${y(b.remainingPoints)}" r="3" fill="#0747a6"><title>${b.date}: ${b.remainingPoints}</title></circle>`).join('')}
      <text x="${P}" y="${P - 8}" font-size="11">${max} pts</text></svg>`;
  } catch (e) { $('#rep').textContent = e.message; }
}

async function renderIssue(v) {
  let i, hist, comments;
  try { [i, hist, comments] = await Promise.all([api('GET', `/api/issues/${S.issueKey}`), api('GET', `/api/issues/${S.issueKey}/history`), api('GET', `/api/issues/${S.issueKey}/comments`)]); }
  catch (e) { v.innerHTML = `<p class="err">${esc(e.message)}</p>`; return; }
  v.innerHTML = `<button id="back">← back</button><div class="panel"><h2>${esc(i.key)} ${esc(i.title)}</h2>
    <p>${esc(i.type)} · ${esc(i.priority)} · points ${i.storyPoints ?? '-'} · assignee ${esc(i.assigneeId || '-')} · ${i.resolvedAt ? 'resolved ' + esc(i.resolvedAt) : 'open'}</p>
    <p>${esc(i.description)}</p>
    <form class="inline" id="edit"><select name="status">${S.project.workflow.statuses.map(s => `<option ${s.name === i.status ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
      <select name="priority">${['urgent', 'high', 'medium', 'low', 'none'].map(p => `<option ${p === i.priority ? 'selected' : ''}>${p}</option>`).join('')}</select>
      <input name="storyPoints" type="number" min="0" placeholder="points" value="${i.storyPoints ?? ''}"><button>Save</button>
      <button type="button" id="watch">Watch/Unwatch</button><button type="button" id="del">Delete</button></form></div>
    <div class="panel"><h3>Subtasks</h3>${i.children.map(k => `<a href="#" data-open="${esc(k)}">${esc(k)}</a> `).join('') || '<i>none</i>'}
      <form class="inline" id="sub"><input name="title" placeholder="Subtask title" required><button>Add subtask</button></form>
      ${i.progress ? `<p>Epic progress: ${i.progress.done}/${i.progress.total} issues, ${i.progress.points_done}/${i.progress.points_total} pts</p>` : ''}</div>
    <div class="panel"><h3>Links</h3>${i.links.map(l => `<div>${esc(l.type)} <a href="#" data-open="${esc(l.key)}">${esc(l.key)}</a> ${esc(l.title)}</div>`).join('') || '<i>none</i>'}
      <form class="inline" id="link"><select name="type"><option>blocks</option><option>relates</option><option>duplicates</option></select><input name="target" placeholder="ABC-1" required><button>Add link</button></form></div>
    <div class="panel"><h3>Comments</h3>${comments.map(c => `<div><b>${esc(c.authorId.slice(0, 6))}</b> ${esc(c.body)} ${c.edited ? '<i>(edited)</i>' : ''}</div>`).join('')}
      <form class="inline" id="cmt"><input name="body" size="50" placeholder="Comment (use @username)" required><button>Comment</button></form></div>
    <div class="panel"><h3>History</h3><table>${hist.map(h => `<tr><td>${esc(h.at)}</td><td>${esc(h.field)}</td><td>${esc(JSON.stringify(h.from))} → ${esc(JSON.stringify(h.to))}</td></tr>`).join('')}</table></div>`;
  const k = S.issueKey, done = fn => e => { e.preventDefault(); guard(async () => { await fn(new FormData(e.target)); await loadProject(); }); };
  $('#back').onclick = () => { S.issueKey = null; render(); };
  $$('[data-open]', v).forEach(a => a.onclick = e => { e.preventDefault(); S.issueKey = a.dataset.open; render(); });
  $('#edit').onsubmit = done(f => api('PATCH', `/api/issues/${k}`, { status: f.get('status'), priority: f.get('priority'), storyPoints: f.get('storyPoints') === '' ? null : Number(f.get('storyPoints')) }));
  $('#watch').onclick = () => guard(async () => { await api(i.watchers.includes(S.me.id) ? 'DELETE' : 'POST', `/api/issues/${k}/watch`); });
  $('#del').onclick = () => { if (confirm('Delete issue?')) guard(async () => { await api('DELETE', `/api/issues/${k}`); S.issueKey = null; await loadProject(); }); };
  $('#sub').onsubmit = done(f => api('POST', `/api/projects/${S.projId}/issues`, { title: f.get('title'), type: 'subtask', parentId: i.id }));
  $('#link').onsubmit = done(f => api('POST', `/api/issues/${k}/links`, { type: f.get('type'), target: f.get('target') }));
  $('#cmt').onsubmit = done(f => api('POST', `/api/issues/${k}/comments`, { body: f.get('body') }));
}

async function renderSettings(v) {
  let hooks = [];
  try { hooks = await api('GET', `/api/projects/${S.projId}/webhooks`); } catch {}
  const wf = S.project.workflow;
  v.innerHTML = `<div class="panel"><h3>Workflow</h3><p>One status per line as <code>Name:category</code> (backlog|unstarted|started|completed). Transitions: empty = any → any, else lines <code>From&gt;To</code>.</p>
    <form id="wf"><textarea name="statuses" rows="6" cols="40">${esc(wf.statuses.map(s => `${s.name}:${s.category}`).join('\n'))}</textarea>
    <textarea name="transitions" rows="6" cols="40">${esc((wf.transitions || []).map(t => t.join('>')).join('\n'))}</textarea>
    <br><input name="remap" size="50" placeholder='remap JSON e.g. {"Todo":"Open"}'><button>Save workflow</button></form></div>
    <div class="panel"><h3>Members</h3>${(S.project.members || []).map(m => `<div>${esc(m.username)} (${m.role})</div>`).join('') || '<i>none</i>'}
    <form class="inline" id="mem"><input name="username" placeholder="username" required><select name="role"><option>developer</option><option>viewer</option><option>lead</option></select><button>Add project member</button></form>
    <form class="inline" id="wsmem"><input name="username" placeholder="username" required><select name="role"><option>member</option><option>guest</option><option>admin</option></select><button>Add workspace member</button></form></div>
    <div class="panel"><h3>Webhooks</h3>${hooks.map(h => `<div>${esc(h.url)} [${h.events.join(', ')}] <a href="#" data-dlv="${h.id}">deliveries</a> <button data-delhook="${h.id}">x</button></div>`).join('') || '<i>none</i>'}
    <form class="inline" id="hook"><input name="url" placeholder="https://…" required><input name="events" value="issue.created,issue.updated" size="30"><input name="secret" placeholder="secret"><button>Add webhook</button></form><pre id="dlv"></pre></div>
    <div class="panel"><a href="/api/projects/${S.projId}/export.csv" id="exp">Export CSV</a> · <label>Import CSV <input type="file" id="imp" accept=".csv,text/csv"></label></div>`;
  $('#wf').onsubmit = e => { e.preventDefault(); const f = new FormData(e.target);
    guard(async () => {
      const statuses = f.get('statuses').split('\n').map(l => l.trim()).filter(Boolean).map(l => { const [name, category] = l.split(':'); return { name: name.trim(), category: (category || '').trim() }; });
      const tr = f.get('transitions').split('\n').map(l => l.trim()).filter(Boolean).map(l => l.split('>').map(x => x.trim()));
      const body = { statuses, transitions: tr.length ? tr : null }; if (f.get('remap')) body.remap = JSON.parse(f.get('remap'));
      await api('PUT', `/api/projects/${S.projId}/workflow`, body); await loadProject();
    }); };
  $('#mem').onsubmit = e => { e.preventDefault(); const f = new FormData(e.target); guard(async () => { await api('POST', `/api/projects/${S.projId}/members`, { username: f.get('username'), role: f.get('role') }); await loadProject(); }); };
  $('#wsmem').onsubmit = e => { e.preventDefault(); const f = new FormData(e.target); guard(async () => { await api('POST', `/api/workspaces/${S.wsId}/members`, { username: f.get('username'), role: f.get('role') }); }); };
  $('#hook').onsubmit = e => { e.preventDefault(); const f = new FormData(e.target); guard(async () => { await api('POST', `/api/projects/${S.projId}/webhooks`, { url: f.get('url'), events: f.get('events').split(',').map(s => s.trim()), secret: f.get('secret') }); }); };
  $$('[data-delhook]', v).forEach(b => b.onclick = () => guard(async () => { await api('DELETE', `/api/webhooks/${b.dataset.delhook}`); }));
  $$('[data-dlv]', v).forEach(a => a.onclick = async e => { e.preventDefault(); $('#dlv').textContent = JSON.stringify(await api('GET', `/api/webhooks/${a.dataset.dlv}/deliveries`), null, 1); });
  $('#exp').onclick = async e => { e.preventDefault(); const t = await api('GET', `/api/projects/${S.projId}/export.csv`); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([t], { type: 'text/csv' })); a.download = 'export.csv'; a.click(); };
  $('#imp').onchange = e => guard(async () => { const text = await e.target.files[0].text(); const r = await api('POST', `/api/projects/${S.projId}/import.csv`, text, true); alert(`Created ${r.created}; errors: ${JSON.stringify(r.errors)}`); await loadProject(); });
}

boot();
