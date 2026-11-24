const $ = (s, r = document) => r.querySelector(s);
const st = { token: localStorage.getItem('token'), user: null, ws: [], wsId: null, projects: [], pid: null, view: 'board', sub: null, notif: false };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function api(method, path, body, raw) {
  const r = await fetch(path, { method, headers: { ...(body !== undefined && !raw ? { 'content-type': 'application/json' } : {}), ...(st.token ? { authorization: 'Bearer ' + st.token } : {}) }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
  const ct = r.headers.get('content-type') || '';
  const data = r.status === 204 ? null : ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) throw new Error(data?.message || r.statusText);
  return data;
}
const proj = () => st.projects.find((p) => p.id === st.pid);
const app = $('#app');
const html = (h) => { app.innerHTML = h; };
const on = (sel, ev, fn) => document.querySelectorAll(sel).forEach((e) => e.addEventListener(ev, fn));
const fail = (e) => alert(e.message);

async function boot() {
  if (!st.token) return authView();
  try { st.user = (await api('GET', '/api/auth/me')).user; } catch { st.token = null; localStorage.removeItem('token'); return authView(); }
  st.ws = await api('GET', '/api/workspaces');
  if (!st.wsId || !st.ws.find((w) => w.id === st.wsId)) st.wsId = st.ws[0]?.id || null;
  st.projects = st.wsId ? await api('GET', `/api/workspaces/${st.wsId}/projects`) : [];
  if (!st.projects.find((p) => p.id === st.pid)) st.pid = st.projects[0]?.id || null;
  render();
}
function authView(msg = '') {
  html(`<main><div class="panel"><h2>pm-s4</h2><div class="err">${esc(msg)}</div>
  <input id="u" placeholder="username"><input id="p" type="password" placeholder="password"><input id="d" placeholder="display name (register)">
  <button id="login">Login</button><button id="reg">Register</button></div></main>`);
  const creds = () => ({ username: $('#u').value, password: $('#p').value });
  $('#login').onclick = async () => { try { const r = await api('POST', '/api/auth/login', creds()); st.token = r.token; localStorage.setItem('token', r.token); boot(); } catch (e) { authView(e.message); } };
  $('#reg').onclick = async () => { try { await api('POST', '/api/auth/register', { ...creds(), displayName: $('#d').value || undefined }); const r = await api('POST', '/api/auth/login', creds()); st.token = r.token; localStorage.setItem('token', r.token); boot(); } catch (e) { authView(e.message); } };
}
function render() {
  const tabs = ['board', 'backlog', 'sprints', 'settings'];
  html(`<header><b>pm-s4</b>
  <select id="wssel">${st.ws.map((w) => `<option value="${w.id}" ${w.id === st.wsId ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select><button id="newws">+ws</button>
  <select id="psel">${st.projects.map((p) => `<option value="${p.id}" ${p.id === st.pid ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select><button id="newp">+project</button>
  <nav>${tabs.map((t) => `<button data-v="${t}">${t}</button>`).join('')}</nav>
  <input id="q" placeholder='search: status:"In Progress" -label:x' size="36"><button id="go">Search</button>
  <button id="bell">Notifications</button><span>${esc(st.user.displayName)}</span><button id="out">Logout</button></header>
  <div id="notif" hidden></div><main id="main"></main>`);
  $('#wssel').onchange = (e) => { st.wsId = e.target.value; st.pid = null; boot(); };
  $('#psel').onchange = (e) => { st.pid = e.target.value; render(); };
  $('#newws').onclick = async () => { const name = prompt('Workspace name'), key = prompt('Key (2-10 uppercase letters)'); if (name && key) try { const w = await api('POST', '/api/workspaces', { name, key }); st.wsId = w.id; boot(); } catch (e) { fail(e); } };
  $('#newp').onclick = async () => { const name = prompt('Project name'), key = prompt('Key'); if (name && key) try { const p = await api('POST', `/api/workspaces/${st.wsId}/projects`, { name, key }); st.pid = p.id; boot(); } catch (e) { fail(e); } };
  on('nav button', 'click', (e) => { st.view = e.target.dataset.v; st.sub = null; render(); });
  $('#go').onclick = () => { st.view = 'search'; st.sub = $('#q').value; render(); };
  $('#q').onkeydown = (e) => { if (e.key === 'Enter') $('#go').click(); };
  $('#out').onclick = async () => { await api('POST', '/api/auth/logout').catch(() => {}); localStorage.removeItem('token'); st.token = null; boot(); };
  $('#bell').onclick = notifications;
  if (!proj() && st.view !== 'search') return ($('#main').innerHTML = '<div class="panel">Create or select a project.</div>');
  ({ board, backlog, sprints, settings, search, issue }[st.view] || board)();
}
async function notifications() {
  const box = $('#notif'); box.hidden = !box.hidden; if (box.hidden) return;
  const list = await api('GET', '/api/notifications');
  box.innerHTML = `<button id="readall">Mark all read</button>` + list.map((n) => `<div class="${n.read ? 'small' : ''}"><a href="#" data-k="${n.issueKey}">${esc(n.issueKey)}</a> ${esc(n.type)} <span class="small">${esc(n.at)}</span></div>`).join('');
  $('#readall').onclick = async () => { await api('POST', '/api/notifications/read', { all: true }); notifications(); notifications(); };
  box.querySelectorAll('a').forEach((a) => (a.onclick = (e) => { e.preventDefault(); openIssue(a.dataset.k); }));
}
const openIssue = (k) => { st.view = 'issue'; st.sub = k; render(); };
const newIssueForm = () => `<div class="panel"><input id="nt" placeholder="New issue title"><select id="ntype">${['task', 'bug', 'feature', 'epic'].map((t) => `<option>${t}</option>`).join('')}</select><button id="addi">Add</button></div>`;
const bindNew = () => { $('#addi').onclick = async () => { try { await api('POST', `/api/projects/${st.pid}/issues`, { title: $('#nt').value, type: $('#ntype').value }); render(); } catch (e) { fail(e); } }; };
const card = (i) => `<div class="card" draggable="true" data-k="${i.key}"><b>${esc(i.key)}</b> ${esc(i.title)}<div class="small">${esc(i.type)} · ${esc(i.priority)}${i.storyPoints != null ? ' · ' + i.storyPoints + 'pt' : ''}</div></div>`;
const bindCards = () => on('.card', 'click', (e) => openIssue(e.currentTarget.dataset.k));

async function board() {
  const p = proj(); const issues = await api('GET', `/api/projects/${p.id}/issues`);
  $('#main').innerHTML = newIssueForm() + `<div class="board">${p.workflow.statuses.map((s) => `<div class="col" data-s="${esc(s.name)}"><h4>${esc(s.name)}</h4>${issues.filter((i) => i.status === s.name).map(card).join('')}</div>`).join('')}</div>`;
  bindNew(); bindCards();
  on('.card', 'dragstart', (e) => e.dataTransfer.setData('text/plain', e.currentTarget.dataset.k));
  on('.col', 'dragover', (e) => { e.preventDefault(); e.currentTarget.classList.add('over'); });
  on('.col', 'dragleave', (e) => e.currentTarget.classList.remove('over'));
  on('.col', 'drop', async (e) => { e.preventDefault(); try { await api('PATCH', `/api/issues/${e.dataTransfer.getData('text/plain')}`, { status: e.currentTarget.dataset.s }); } catch (er) { fail(er); } render(); });
}
async function backlog() {
  const p = proj(); const [issues, sprints] = await Promise.all([api('GET', `/api/projects/${p.id}/issues`), api('GET', `/api/projects/${p.id}/sprints`)]);
  const opts = (cur) => `<option value="">Backlog</option>` + sprints.filter((s) => s.state !== 'completed').map((s) => `<option value="${s.id}" ${s.id === cur ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
  const row = (i) => `<tr><td><a href="#" data-k="${i.key}">${i.key}</a></td><td>${esc(i.title)}</td><td>${i.storyPoints ?? ''}</td><td><select data-k="${i.key}" class="sp">${opts(i.sprintId)}</select></td></tr>`;
  const groups = [{ name: 'Backlog', id: null }, ...sprints.filter((s) => s.state !== 'completed')];
  $('#main').innerHTML = newIssueForm() + groups.map((g) => `<div class="panel"><h3>${esc(g.name)} ${g.state ? `<span class="small">${g.state}</span>` : ''}</h3><table>${issues.filter((i) => (i.sprintId || null) === g.id && i.type !== 'subtask').map(row).join('')}</table></div>`).join('') +
    `<div class="panel"><input id="sn" placeholder="Sprint name"><button id="adds">Create sprint</button></div>`;
  bindNew();
  $('#adds').onclick = async () => { try { await api('POST', `/api/projects/${p.id}/sprints`, { name: $('#sn').value }); render(); } catch (e) { fail(e); } };
  on('.sp', 'change', async (e) => { try { await api('PATCH', `/api/issues/${e.target.dataset.k}`, { sprintId: e.target.value || null }); } catch (er) { fail(er); } render(); });
  on('a[data-k]', 'click', (e) => { e.preventDefault(); openIssue(e.target.dataset.k); });
}
async function sprints() {
  const p = proj(); const list = await api('GET', `/api/projects/${p.id}/sprints`);
  $('#main').innerHTML = list.map((s) => `<div class="panel"><b>${esc(s.name)}</b> <span class="small">${s.state} ${esc(s.startDate || '')} ${esc(s.endDate || '')}</span>
    ${s.state === 'planned' ? `<button data-a="start" data-id="${s.id}">Start</button>` : ''}${s.state === 'active' ? `<button data-a="complete" data-id="${s.id}">Complete</button>` : ''}
    <button data-a="report" data-id="${s.id}">Report</button><div id="rep-${s.id}"></div></div>`).join('') || '<div class="panel">No sprints</div>';
  on('button[data-a]', 'click', async (e) => {
    const { a, id } = e.target.dataset;
    try {
      if (a === 'start') { await api('POST', `/api/sprints/${id}/start`); render(); }
      else if (a === 'complete') { await api('POST', `/api/sprints/${id}/complete`, { carryOverTo: 'backlog' }); render(); }
      else { const r = await api('GET', `/api/sprints/${id}/report`); $(`#rep-${id}`).innerHTML = `<p>Committed ${r.committedPoints} · Completed ${r.completedPoints} (${r.completedIssues} issues) · Carried over ${r.carriedOver}</p>` + burndown(r.burndown, r.committedPoints); }
    } catch (er) { fail(er); }
  });
}
function burndown(data, max) {
  const W = 400, H = 160, m = Math.max(max, ...data.map((d) => d.remainingPoints), 1);
  const x = (i) => 30 + (data.length < 2 ? 0 : (i * (W - 40)) / (data.length - 1)), y = (v) => H - 20 - (v / m) * (H - 40);
  const pts = data.map((d, i) => `${x(i)},${y(d.remainingPoints)}`).join(' ');
  return `<svg width="${W}" height="${H}" style="background:#fff;border:1px solid #ccc"><line x1="30" y1="${H - 20}" x2="${W - 10}" y2="${H - 20}" stroke="#999"/><line x1="30" y1="10" x2="30" y2="${H - 20}" stroke="#999"/>
  <text x="2" y="14" font-size="10">${m}</text><text x="10" y="${H - 20}" font-size="10">0</text><polyline fill="none" stroke="#0747a6" stroke-width="2" points="${pts}"/>
  ${data.map((d, i) => `<circle cx="${x(i)}" cy="${y(d.remainingPoints)}" r="3" fill="#0747a6"><title>${d.date}: ${d.remainingPoints}</title></circle>`).join('')}</svg>`;
}
async function search() {
  const q = st.sub || ''; let list = [], msg = '';
  try { list = await api('GET', `/api/search?q=${encodeURIComponent(q)}${st.pid ? '&project=' + encodeURIComponent(proj().key) : ''}`); } catch (e) { msg = e.message; }
  $('#q').value = q;
  $('#main').innerHTML = `<div class="panel"><div class="err">${esc(msg)}</div><table>${list.map((i) => `<tr><td><a href="#" data-k="${i.key}">${i.key}</a></td><td>${esc(i.title)}</td><td>${esc(i.status)}</td><td>${esc(i.priority)}</td></tr>`).join('')}</table></div>`;
  on('a[data-k]', 'click', (e) => { e.preventDefault(); openIssue(e.target.dataset.k); });
}
async function issue() {
  const k = st.sub; const [i, hist, comments] = await Promise.all([api('GET', `/api/issues/${k}`), api('GET', `/api/issues/${k}/history`), api('GET', `/api/issues/${k}/comments`)]);
  const p = proj();
  $('#main').innerHTML = `<div class="panel"><h2>${esc(i.key)} ${esc(i.title)}</h2><p>${esc(i.description)}</p>
  <div>Status: <select id="stsel">${(p?.workflow.statuses || []).map((s) => `<option ${s.name === i.status ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select>
  Priority: <select id="prsel">${['urgent', 'high', 'medium', 'low', 'none'].map((s) => `<option ${s === i.priority ? 'selected' : ''}>${s}</option>`).join('')}</select>
  <button id="watch">Watch</button><button id="del">Delete</button></div>
  <div class="small">type ${i.type} · points ${i.storyPoints ?? '-'} · labels ${esc(i.labels.join(', '))}</div>
  ${i.progress ? `<p>Epic progress: ${i.progress.done}/${i.progress.total} issues, ${i.progress.points_done}/${i.progress.points_total} pts</p>` : ''}
  <h4>Subtasks</h4>${i.children.map((c) => `<a href="#" data-k="${c}">${c}</a> `).join('') || '<span class="small">none</span>'}
  <div><input id="stt" placeholder="New subtask"><button id="adds">Add</button></div>
  <h4>Links</h4>${i.links.map((l) => `${esc(l.type)} <a href="#" data-k="${l.key}">${l.key}</a> <button data-l="${l.id}">x</button><br>`).join('')}
  <select id="lt"><option>blocks</option><option>relates</option><option>duplicates</option></select><input id="lk" placeholder="KEY-1"><button id="addl">Link</button>
  <h4>Comments</h4>${comments.map((c) => `<div class="card"><span class="small">${esc(c.createdAt)}${c.edited ? ' (edited)' : ''}</span><br>${esc(c.body)}</div>`).join('')}
  <textarea id="cb" placeholder="Comment (use @username)"></textarea><button id="addc">Comment</button>
  <h4>History</h4><table>${hist.map((h) => `<tr><td>${esc(h.at)}</td><td>${esc(h.field)}</td><td>${esc(h.from)} → ${esc(h.to)}</td></tr>`).join('')}</table></div>`;
  const act = (fn) => async () => { try { await fn(); } catch (e) { fail(e); } issue(); };
  $('#stsel').onchange = act(() => api('PATCH', `/api/issues/${k}`, { status: $('#stsel').value }));
  $('#prsel').onchange = act(() => api('PATCH', `/api/issues/${k}`, { priority: $('#prsel').value }));
  $('#watch').onclick = act(() => api('POST', `/api/issues/${k}/watch`));
  $('#del').onclick = async () => { if (confirm('Delete?')) { await api('DELETE', `/api/issues/${k}`); st.view = 'board'; render(); } };
  $('#adds').onclick = act(() => api('POST', `/api/projects/${i.projectId}/issues`, { type: 'subtask', title: $('#stt').value, parentId: k }));
  $('#addl').onclick = act(() => api('POST', `/api/issues/${k}/links`, { type: $('#lt').value, target: $('#lk').value }));
  $('#addc').onclick = act(() => api('POST', `/api/issues/${k}/comments`, { body: $('#cb').value }));
  on('button[data-l]', 'click', act(() => api('DELETE', `/api/issues/${k}/links/${event.target.dataset.l}`)));
  on('a[data-k]', 'click', (e) => { e.preventDefault(); openIssue(e.target.dataset.k); });
}
async function settings() {
  const p = await api('GET', `/api/projects/${st.pid}`); const hooks = await api('GET', `/api/projects/${p.id}/webhooks`).catch(() => []);
  $('#main').innerHTML = `<div class="panel"><h3>Workflow</h3><textarea id="wf" rows="12" cols="60">${esc(JSON.stringify(p.workflow, null, 2))}</textarea><br>
  <div class="small">Remap (JSON, for removed in-use statuses)</div><input id="rm" value="{}"><button id="savewf">Save workflow</button></div>
  <div class="panel"><h3>Members</h3><table>${p.members.map((m) => `<tr><td>${esc(m.username)}</td><td>${m.role}</td></tr>`).join('')}</table>
  <input id="mu" placeholder="username"><select id="mr"><option>developer</option><option>viewer</option><option>lead</option></select><button id="addm">Add</button></div>
  <div class="panel"><h3>Webhooks</h3>${hooks.map((h) => `<div>${esc(h.url)} ${h.events.join(',')} <button data-d="${h.id}">delete</button> <button data-del="${h.id}">deliveries</button></div>`).join('')}
  <input id="wu" placeholder="https://..."><input id="we" value="issue.created,issue.updated"><input id="wsec" placeholder="secret"><button id="addw">Add</button><pre id="dl"></pre></div>`;
  const act = (fn) => async () => { try { await fn(); } catch (e) { fail(e); } await boot(); st.view = 'settings'; render(); };
  $('#savewf').onclick = act(async () => { const w = JSON.parse($('#wf').value); await api('PUT', `/api/projects/${p.id}/workflow`, { ...w, remap: JSON.parse($('#rm').value || '{}') }); });
  $('#addm').onclick = act(() => api('POST', `/api/projects/${p.id}/members`, { username: $('#mu').value, role: $('#mr').value }));
  $('#addw').onclick = act(() => api('POST', `/api/projects/${p.id}/webhooks`, { url: $('#wu').value, events: $('#we').value.split(',').map((s) => s.trim()), secret: $('#wsec').value }));
  on('button[data-d]', 'click', async (e) => { await api('DELETE', `/api/webhooks/${e.target.dataset.d}`); settings(); });
  on('button[data-del]', 'click', async (e) => { $('#dl').textContent = JSON.stringify(await api('GET', `/api/webhooks/${e.target.dataset.del}/deliveries`), null, 1); });
}
boot();
