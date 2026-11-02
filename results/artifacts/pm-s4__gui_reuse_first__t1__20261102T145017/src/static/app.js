// pm-s4 SPA — uses only the public REST API
const $app = document.getElementById('app');
const S = { token: localStorage.getItem('pm_token'), me: null, wss: [], ws: null, projects: [], project: null, view: 'board', issues: [], sprints: [], sel: null, msg: '', notes: [], showNotes: false, searchResults: null, users: {} };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json', ...(S.token ? { authorization: 'Bearer ' + S.token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { j = t; }
  if (!r.ok) throw new Error(j?.message || r.statusText); return j;
}
const act = fn => async (...a) => { try { S.msg = ''; await fn(...a); } catch (e) { S.msg = e.message; } render(); };
const $ = (sel, root = $app) => root.querySelector(sel);
const val = sel => $(sel)?.value;

async function loadAll() {
  S.me = await api('GET', '/api/auth/me'); S.wss = await api('GET', '/api/workspaces');
  S.ws = S.wss.find(w => w.id === S.ws?.id) || S.wss[0] || null;
  for (const w of S.wss) for (const m of w.members) S.users[m.userId] = m.username;
  S.projects = S.ws ? await api('GET', `/api/workspaces/${S.ws.id}/projects`) : [];
  S.project = S.projects.find(p => p.id === S.project?.id) || S.projects[0] || null;
  if (S.project) { S.issues = await api('GET', `/api/projects/${S.project.id}/issues`); S.sprints = await api('GET', `/api/projects/${S.project.id}/sprints`); } else { S.issues = []; S.sprints = []; }
  S.notes = await api('GET', '/api/notifications');
}
async function render() {
  if (!S.token) return renderAuth();
  try { if (!S.me) await loadAll(); } catch (e) { S.token = null; localStorage.removeItem('pm_token'); return renderAuth(); }
  $app.innerHTML = `<header><b>pm-s4</b>
    <select id="wsSel">${S.wss.map(w => `<option value="${w.id}" ${w.id === S.ws?.id ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select>
    <button id="newWs">+ Workspace</button>
    <select id="prSel">${S.projects.map(p => `<option value="${p.id}" ${p.id === S.project?.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
    <button id="newPr">+ Project</button>
    <nav>${['board', 'backlog', 'report', 'settings'].map(v => `<button data-view="${v}" ${S.view === v ? 'disabled' : ''}>${v}</button>`).join('')}</nav>
    <input id="q" placeholder='search: status:"In Progress" type:bug' size="34"><button id="go">Search</button>
    <button id="bell">🔔 ${S.notes.filter(n => !n.read).length}</button><span>${esc(S.me.username)}</span><button id="logout">Logout</button></header>
    <main>${S.msg ? `<p class="err">${esc(S.msg)}</p>` : ''}${S.showNotes ? notesHtml() : ''}<div id="view"></div></main><div id="detail"></div>`;
  $('#wsSel').onchange = act(async e => { S.ws = S.wss.find(w => w.id === e.target.value); S.project = null; await loadAll(); });
  $('#prSel').onchange = act(async e => { S.project = S.projects.find(p => p.id === e.target.value); await loadAll(); });
  $('#newWs').onclick = act(async () => { const name = prompt('Workspace name'); if (!name) return; const key = prompt('Key (2-10 capital letters)'); const w = await api('POST', '/api/workspaces', { name, key }); S.ws = w; await loadAll(); });
  $('#newPr').onclick = act(async () => { if (!S.ws) return; const name = prompt('Project name'); if (!name) return; const key = prompt('Key'); const p = await api('POST', `/api/workspaces/${S.ws.id}/projects`, { name, key }); S.project = p; await loadAll(); });
  document.querySelectorAll('[data-view]').forEach(b => b.onclick = act(async () => { S.view = b.dataset.view; S.searchResults = null; }));
  $('#go').onclick = act(async () => { const q = val('#q'); S.searchResults = q ? await api('GET', '/api/search?q=' + encodeURIComponent(q)) : null; });
  $('#q').onkeydown = e => { if (e.key === 'Enter') $('#go').click(); };
  $('#bell').onclick = act(async () => { S.showNotes = !S.showNotes; S.notes = await api('GET', '/api/notifications'); });
  $('#logout').onclick = act(async () => { await api('POST', '/api/auth/logout').catch(() => {}); S.token = null; S.me = null; localStorage.removeItem('pm_token'); });
  const v = $('#view');
  if (S.showNotes) { const r = $('#readAll'); if (r) r.onclick = act(async () => { await api('POST', '/api/notifications/read', { all: true }); S.notes = await api('GET', '/api/notifications'); }); }
  if (S.searchResults) { v.innerHTML = `<div class="panel"><h3>Search results (${S.searchResults.length})</h3>${S.searchResults.map(cardHtml).join('')}</div>`; bindCards(v); }
  else if (!S.project) v.innerHTML = '<p>Create a workspace and a project to get started.</p>';
  else if (S.view === 'board') renderBoard(v); else if (S.view === 'backlog') renderBacklog(v); else if (S.view === 'report') await renderReport(v); else renderSettings(v);
  if (S.sel) await renderDetail();
}
const notesHtml = () => `<div class="panel"><b>Notifications</b> <button id="readAll">Mark all read</button>${S.notes.map(n => `<div class="${n.read ? 'muted' : ''}">${esc(n.type)} on ${esc(n.issueKey)} by ${esc(S.users[n.actorId] || n.actorId)} · ${esc(n.at)}</div>`).join('') || '<p class="muted">none</p>'}</div>`;
function renderAuth() {
  $app.innerHTML = `<main><div class="panel" style="max-width:320px;margin:60px auto"><h2>pm-s4</h2>${S.msg ? `<p class="err">${esc(S.msg)}</p>` : ''}
   <label>Username <input id="u"></label><label>Password <input id="p" type="password"></label>
   <button id="login">Login</button> <button id="reg">Register</button></div></main>`;
  const login = async () => { const r = await api('POST', '/api/auth/login', { username: val('#u'), password: val('#p') }); S.token = r.token; localStorage.setItem('pm_token', r.token); S.me = null; };
  $('#login').onclick = act(login);
  $('#reg').onclick = act(async () => { await api('POST', '/api/auth/register', { username: val('#u'), password: val('#p') }); await login(); });
}
const cardHtml = i => `<div class="card" draggable="true" data-key="${esc(i.key)}"><b>${esc(i.key)}</b> ${esc(i.title)}<span class="badge">${esc(i.type)}</span><span class="badge">${esc(i.priority)}</span>${i.storyPoints != null ? `<span class="badge">${i.storyPoints}</span>` : ''}${i.assigneeId ? `<span class="badge">@${esc(S.users[i.assigneeId] || '')}</span>` : ''}</div>`;
function bindCards(root) { root.querySelectorAll('.card').forEach(c => { c.onclick = act(async () => { S.sel = c.dataset.key; }); c.ondragstart = e => e.dataTransfer.setData('text/plain', c.dataset.key); }); }
function newIssueForm() { return `<div class="panel"><input id="nt" placeholder="New issue title"> <select id="ntype">${['task', 'bug', 'feature', 'epic'].map(t => `<option>${t}</option>`).join('')}</select> <button id="addIssue">Create</button></div>`; }
function bindNew() { $('#addIssue').onclick = act(async () => { await api('POST', `/api/projects/${S.project.id}/issues`, { title: val('#nt'), type: val('#ntype') }); await loadAll(); }); }
function renderBoard(v) {
  const sts = S.project.workflow.statuses;
  v.innerHTML = newIssueForm() + `<div class="board">${sts.map(s => `<div class="col" data-status="${esc(s.name)}"><b>${esc(s.name)}</b> <span class="muted">${S.issues.filter(i => i.status === s.name).length}</span>${S.issues.filter(i => i.status === s.name).map(cardHtml).join('')}</div>`).join('')}</div>`;
  bindNew(); bindCards(v);
  v.querySelectorAll('.col').forEach(col => { col.ondragover = e => e.preventDefault(); col.ondrop = act(async e => { e.preventDefault(); const key = e.dataTransfer.getData('text/plain'); await api('PATCH', `/api/issues/${key}`, { status: col.dataset.status }); await loadAll(); }); });
}
function renderBacklog(v) {
  const group = sid => S.issues.filter(i => (i.sprintId || null) === sid);
  const opts = cur => `<option value="">Backlog</option>` + S.sprints.filter(s => s.state !== 'completed').map(s => `<option value="${s.id}" ${s.id === cur ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  const row = i => `<div class="card" data-key="${esc(i.key)}" style="cursor:pointer"><b>${esc(i.key)}</b> ${esc(i.title)} <select class="mv" data-key="${esc(i.key)}">${opts(i.sprintId)}</select></div>`;
  v.innerHTML = newIssueForm() + `<div class="panel"><input id="sn" placeholder="Sprint name"> <input id="sd" type="date"> <input id="ed" type="date"> <button id="addSp">Create sprint</button></div>` +
    S.sprints.map(s => `<div class="panel"><h3>${esc(s.name)} <span class="badge">${s.state}</span> ${s.state === 'planned' ? `<button class="st" data-id="${s.id}">Start</button>` : ''}${s.state === 'active' ? `<button class="cp" data-id="${s.id}">Complete</button>` : ''}</h3>${group(s.id).map(row).join('') || '<span class="muted">empty</span>'}</div>`).join('') +
    `<div class="panel"><h3>Backlog</h3>${group(null).map(row).join('')}</div>`;
  bindNew();
  v.querySelectorAll('.card').forEach(c => c.onclick = act(async e => { if (e.target.tagName === 'SELECT') return; S.sel = c.dataset.key; }));
  v.querySelectorAll('.mv').forEach(s => s.onchange = act(async e => { await api('PATCH', `/api/issues/${s.dataset.key}`, { sprintId: e.target.value || null }); await loadAll(); }));
  $('#addSp').onclick = act(async () => { await api('POST', `/api/projects/${S.project.id}/sprints`, { name: val('#sn'), startDate: val('#sd') || undefined, endDate: val('#ed') || undefined }); await loadAll(); });
  v.querySelectorAll('.st').forEach(b => b.onclick = act(async () => { await api('POST', `/api/sprints/${b.dataset.id}/start`); await loadAll(); }));
  v.querySelectorAll('.cp').forEach(b => b.onclick = act(async () => { const to = prompt('Carry unfinished issues to (sprint id or "backlog")', 'backlog'); await api('POST', `/api/sprints/${b.dataset.id}/complete`, { carryOverTo: to || 'backlog' }); await loadAll(); }));
}
async function renderReport(v) {
  const s = S.sprints.find(x => x.state === 'active') || S.sprints[S.sprints.length - 1];
  if (!s) { v.innerHTML = '<p>No sprints yet.</p>'; return; }
  const r = await api('GET', `/api/sprints/${s.id}/report`); const W = 600, H = 240, P = 30, max = Math.max(1, r.committedPoints, ...r.burndown.map(d => d.remainingPoints));
  const pts = r.burndown.map((d, k) => `${P + (r.burndown.length > 1 ? k * (W - 2 * P) / (r.burndown.length - 1) : 0)},${H - P - d.remainingPoints / max * (H - 2 * P)}`).join(' ');
  v.innerHTML = `<div class="panel"><h3>${esc(s.name)} report</h3><p>Committed ${r.committedPoints} · Completed ${r.completedPoints} pts · ${r.completedIssues} issues done · ${r.carriedOver} carried over</p>
   <svg id="burndown" width="${W}" height="${H}" style="background:#fafbfc"><line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" stroke="#999"/><line x1="${P}" y1="${P}" x2="${P}" y2="${H - P}" stroke="#999"/><polyline fill="none" stroke="#0052cc" stroke-width="2" points="${pts}"/><text x="4" y="${P}" font-size="10">${max}</text>
   ${r.burndown.map((d, k) => `<text x="${P + (r.burndown.length > 1 ? k * (W - 2 * P) / (r.burndown.length - 1) : 0)}" y="${H - 10}" font-size="9">${esc(d.date.slice(5))}</text>`).join('')}</svg></div>`;
}
function renderSettings(v) {
  const p = S.project; const st = p.workflow.statuses.map(s => `${s.name}:${s.category}`).join('\n'); const tr = p.workflow.transitions.map(t => t.join('>')).join('\n');
  v.innerHTML = `<div class="panel"><h3>Workflow</h3><p class="muted">One status per line as name:category. Transitions as from>to per line.</p><textarea id="wst" rows="6" cols="40">${esc(st)}</textarea><textarea id="wtr" rows="6" cols="40">${esc(tr)}</textarea><br><label>Remap (old>new per line) <textarea id="wrm" rows="2" cols="30"></textarea></label><button id="saveWf">Save workflow</button></div>
  <div class="panel"><h3>Members</h3>${p.members.map(m => `<div>${esc(S.users[m.userId] || m.userId)} — ${m.role}</div>`).join('')}<input id="mu" placeholder="username"> <select id="mr"><option>developer</option><option>viewer</option><option>lead</option></select> <button id="addM">Add</button></div>
  <div class="panel"><h3>Webhooks</h3><div id="hooks"></div><input id="hu" placeholder="https://..."> <input id="hs" placeholder="secret"> <button id="addH">Add (all events)</button></div>`;
  $('#saveWf').onclick = act(async () => {
    const statuses = val('#wst').split('\n').filter(x => x.trim()).map(l => { const [name, category] = l.split(':'); return { name: name.trim(), category: (category || '').trim() }; });
    const transitions = val('#wtr').split('\n').filter(x => x.trim()).map(l => l.split('>').map(x => x.trim()));
    const remap = Object.fromEntries(val('#wrm').split('\n').filter(x => x.includes('>')).map(l => l.split('>').map(x => x.trim())));
    await api('PUT', `/api/projects/${p.id}/workflow`, { statuses, transitions, remap }); await loadAll();
  });
  $('#addM').onclick = act(async () => { await api('POST', `/api/projects/${p.id}/members`, { username: val('#mu'), role: val('#mr') }); await loadAll(); });
  $('#addH').onclick = act(async () => { await api('POST', `/api/projects/${p.id}/webhooks`, { url: val('#hu'), secret: val('#hs'), events: ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'] }); await render(); });
  api('GET', `/api/projects/${p.id}/webhooks`).then(hs => { const el = $('#hooks'); if (el) el.innerHTML = hs.map(h => `<div>${esc(h.url)} <span class="badge">${esc(h.events.join(','))}</span></div>`).join(''); }).catch(() => {});
}
async function renderDetail() {
  let i, hist, com; try { i = await api('GET', `/api/issues/${S.sel}`); hist = await api('GET', `/api/issues/${S.sel}/history`); com = await api('GET', `/api/issues/${S.sel}/comments`); } catch (e) { S.sel = null; return; }
  const sts = S.project.workflow.statuses;
  $('#detail').innerHTML = `<div class="dialog"><button id="close">×</button> <h3>${esc(i.key)} ${esc(i.title)}</h3>
   <label>Status <select id="ds">${sts.map(s => `<option ${s.name === i.status ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
   <label>Priority <select id="dp">${['urgent', 'high', 'medium', 'low', 'none'].map(x => `<option ${x === i.priority ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
   <label>Points <input id="dpts" type="number" value="${i.storyPoints ?? ''}"></label>
   <label>Description <textarea id="dd" rows="3" style="width:95%">${esc(i.description)}</textarea></label><button id="save">Save</button> <button id="watch">Watch</button> <button id="del">Delete</button>
   ${i.progress ? `<p>Epic progress: ${i.progress.done}/${i.progress.total} (${i.progress.points_done}/${i.progress.points_total} pts)</p>` : ''}
   <h4>Subtasks</h4>${i.children.map(k => `<div><a href="#" class="open" data-key="${esc(k)}">${esc(k)}</a></div>`).join('')}${i.type !== 'subtask' ? '<input id="st" placeholder="new subtask title"> <button id="addSt">Add</button>' : ''}
   <h4>Links</h4>${i.links.map(l => `<div>${esc(l.type)} <a href="#" class="open" data-key="${esc(l.target)}">${esc(l.target)}</a></div>`).join('')}
   <select id="lt"><option>blocks</option><option>relates</option><option>duplicates</option></select> <input id="lk" placeholder="KEY-1" size="8"> <button id="addL">Link</button>
   <h4>Comments</h4>${com.map(c => `<div class="card" style="cursor:auto"><b>${esc(S.users[c.authorId] || '')}</b> ${esc(c.body)}${c.edited ? ' <i>(edited)</i>' : ''}</div>`).join('')}
   <textarea id="cb" rows="2" style="width:95%" placeholder="Comment, use @username"></textarea><button id="addC">Comment</button>
   <h4>History</h4>${hist.map(h => `<div class="muted">${esc(h.at.slice(0, 16))} ${esc(h.field)}: ${esc(h.from)} → ${esc(h.to)}</div>`).join('')}</div>`;
  const d = $('#detail'); const refresh = fn => act(async () => { await fn(); await loadAll(); });
  $('#close', d).onclick = act(async () => { S.sel = null; $('#detail').innerHTML = ''; });
  $('#save', d).onclick = refresh(() => api('PATCH', `/api/issues/${i.key}`, { status: val('#ds'), priority: val('#dp'), storyPoints: val('#dpts') === '' ? null : Number(val('#dpts')), description: val('#dd') }));
  $('#watch', d).onclick = refresh(() => api('POST', `/api/issues/${i.key}/watch`));
  $('#del', d).onclick = refresh(async () => { await api('DELETE', `/api/issues/${i.key}`); S.sel = null; });
  $('#addSt', d)?.addEventListener('click', refresh(() => api('POST', `/api/projects/${S.project.id}/issues`, { type: 'subtask', title: val('#st'), parentId: i.id })));
  $('#addL', d).onclick = refresh(() => api('POST', `/api/issues/${i.key}/links`, { type: val('#lt'), target: val('#lk') }));
  $('#addC', d).onclick = refresh(() => api('POST', `/api/issues/${i.key}/comments`, { body: val('#cb') }));
  d.querySelectorAll('.open').forEach(a => a.onclick = act(async e => { e.preventDefault(); S.sel = a.dataset.key; }));
}
render();
