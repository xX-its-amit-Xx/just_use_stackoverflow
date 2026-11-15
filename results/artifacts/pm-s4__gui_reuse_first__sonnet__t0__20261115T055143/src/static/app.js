// pm-s4 SPA — uses only the public REST API.
const $app = document.getElementById('app');
const S = { token: localStorage.getItem('token'), me: null, ws: [], wsId: null, projects: [], pid: null, project: null, tab: 'board', issues: [], sprints: [], members: [], issue: null, msg: '', notifs: null, results: null, report: null };
async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json', ...(S.token ? { authorization: 'Bearer ' + S.token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let j = null; try { j = t ? JSON.parse(t) : null; } catch { j = t; }
  if (!r.ok) throw new Error((j && j.message) || r.statusText);
  return j;
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const act = async (fn) => { try { S.msg = ''; await fn(); } catch (e) { S.msg = e.message; } render(); };
const uname = (id) => (S.members.find((m) => m.userId === id) || {}).username || '';

async function boot() {
  if (S.token) { try { S.me = (await api('GET', '/api/auth/me')).user; await loadWs(); } catch { S.token = null; localStorage.removeItem('token'); } }
  render();
}
async function loadWs() {
  S.ws = await api('GET', '/api/workspaces');
  if (!S.wsId && S.ws.length) S.wsId = S.ws[0].id;
  if (S.wsId) { S.projects = await api('GET', `/api/workspaces/${S.wsId}/projects`); }
  if (S.pid && !S.projects.find((p) => p.id === S.pid)) S.pid = null;
  if (!S.pid && S.projects.length) S.pid = S.projects[0].id;
  await loadProject();
}
async function loadProject() {
  if (!S.pid) { S.project = null; return; }
  S.project = await api('GET', `/api/projects/${S.pid}`);
  [S.issues, S.sprints, S.members] = await Promise.all([api('GET', `/api/projects/${S.pid}/issues`), api('GET', `/api/projects/${S.pid}/sprints`), api('GET', `/api/projects/${S.pid}/members`)]);
  if (S.issue) S.issue = await api('GET', `/api/issues/${S.issue.key}`).catch(() => null);
}
function authView() {
  return `<main><div class="panel"><h2>pm-s4</h2><form id="login" class="inline"><input name="username" placeholder="username"><input name="password" type="password" placeholder="password"><input name="displayName" placeholder="display name (register)"><button>Login</button><button type="button" id="reg">Register</button></form><div class="err">${esc(S.msg)}</div></div></main>`;
}
function wire() {
  const $ = (s) => $app.querySelector(s);
  const form = (sel, fn) => { const f = $(sel); if (f) f.onsubmit = (e) => { e.preventDefault(); act(() => fn(Object.fromEntries(new FormData(f)))); }; };
  const on = (sel, ev, fn) => $app.querySelectorAll(sel).forEach((el) => { el['on' + ev] = (e) => fn(e, el); });
  if (!S.me) {
    form('#login', async (d) => { const r = await api('POST', '/api/auth/login', d); S.token = r.token; localStorage.setItem('token', r.token); S.me = r.user; await loadWs(); });
    const reg = $('#reg'); if (reg) reg.onclick = () => act(async () => { const d = Object.fromEntries(new FormData($('#login'))); await api('POST', '/api/auth/register', d); const r = await api('POST', '/api/auth/login', d); S.token = r.token; localStorage.setItem('token', r.token); S.me = r.user; await loadWs(); });
    return;
  }
  on('#wsel', 'change', (e) => act(async () => { S.wsId = e.target.value; S.pid = null; await loadWs(); }));
  on('#psel', 'change', (e) => act(async () => { S.pid = e.target.value; S.issue = null; await loadProject(); }));
  on('[data-tab]', 'click', (e, el) => act(async () => { S.tab = el.dataset.tab; S.issue = null; if (S.tab === 'report') await loadReport(); }));
  on('#logout', 'click', () => act(async () => { await api('POST', '/api/auth/logout').catch(() => {}); localStorage.removeItem('token'); S.token = null; S.me = null; }));
  form('#newws', async (d) => { await api('POST', '/api/workspaces', d); S.wsId = null; await loadWs(); });
  form('#newproj', async (d) => { const p = await api('POST', `/api/workspaces/${S.wsId}/projects`, d); S.pid = p.id; await loadWs(); });
  form('#search', async (d) => { S.results = await api('GET', `/api/search?q=${encodeURIComponent(d.q)}${S.pid ? '&project=' + S.pid : ''}`); S.tab = 'search'; S.issue = null; });
  on('#bell', 'click', () => act(async () => { S.notifs = S.notifs ? null : await api('GET', '/api/notifications'); }));
  on('#readall', 'click', () => act(async () => { await api('POST', '/api/notifications/read', { all: true }); S.notifs = await api('GET', '/api/notifications'); }));
  form('#newissue', async (d) => { if (d.storyPoints) d.storyPoints = Number(d.storyPoints); else delete d.storyPoints; await api('POST', `/api/projects/${S.pid}/issues`, d); await loadProject(); });
  on('[data-open]', 'click', (e, el) => act(async () => { S.issue = await api('GET', `/api/issues/${el.dataset.open}`); S.comments = await api('GET', `/api/issues/${el.dataset.open}/comments`); S.history = await api('GET', `/api/issues/${el.dataset.open}/history`); }));
  // drag and drop
  on('.card', 'dragstart', (e, el) => e.dataTransfer.setData('text/plain', el.dataset.key));
  on('.col', 'dragover', (e) => e.preventDefault());
  on('.col', 'drop', (e, el) => { e.preventDefault(); const key = e.dataTransfer.getData('text/plain'); act(async () => { await api('PATCH', `/api/issues/${key}`, { status: el.dataset.status }); await loadProject(); }); });
  on('[data-sprint]', 'change', (e, el) => act(async () => { await api('PATCH', `/api/issues/${el.dataset.issue}`, { sprintId: el.value || null }); await loadProject(); }));
  form('#newsprint', async (d) => { for (const k of Object.keys(d)) if (!d[k]) delete d[k]; await api('POST', `/api/projects/${S.pid}/sprints`, d); await loadProject(); });
  on('[data-start]', 'click', (e, el) => act(async () => { await api('POST', `/api/sprints/${el.dataset.start}/start`); await loadProject(); }));
  on('[data-complete]', 'click', (e, el) => act(async () => { await api('POST', `/api/sprints/${el.dataset.complete}/complete`, { carryOverTo: 'backlog' }); await loadProject(); }));
  on('[data-report]', 'click', (e, el) => act(async () => { S.reportId = el.dataset.report; S.tab = 'report'; await loadReport(); }));
  // issue detail
  form('#comment', async (d) => { await api('POST', `/api/issues/${S.issue.key}/comments`, d); S.comments = await api('GET', `/api/issues/${S.issue.key}/comments`); S.history = await api('GET', `/api/issues/${S.issue.key}/history`); });
  form('#editissue', async (d) => { const b = {}; if (d.status) b.status = d.status; if (d.priority) b.priority = d.priority; b.title = d.title; b.assigneeId = d.assigneeId || null; await api('PATCH', `/api/issues/${S.issue.key}`, b); await loadProject(); S.history = await api('GET', `/api/issues/${S.issue.key}/history`); });
  form('#newlink', async (d) => { await api('POST', `/api/issues/${S.issue.key}/links`, d); await loadProject(); });
  form('#newsub', async (d) => { await api('POST', `/api/projects/${S.pid}/issues`, { ...d, type: 'subtask', parentId: S.issue.id }); await loadProject(); });
  on('#watch', 'click', () => act(async () => { await api('POST', `/api/issues/${S.issue.key}/watch`); await loadProject(); }));
  // settings
  form('#wf', async (d) => {
    const statuses = d.statuses.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [name, category] = l.split(':').map((x) => x.trim()); return { name, category }; });
    const remap = d.remap ? JSON.parse(d.remap) : undefined;
    await api('PUT', `/api/projects/${S.pid}/workflow`, { statuses, transitions: statuses.flatMap((a) => statuses.filter((b) => b !== a).map((b) => [a.name, b.name])), remap }); await loadProject();
  });
  form('#addmember', async (d) => { await api('POST', `/api/projects/${S.pid}/members`, d); await loadProject(); });
  form('#addhook', async (d) => { d.events = d.events.split(',').map((x) => x.trim()); await api('POST', `/api/projects/${S.pid}/webhooks`, d); S.hooks = await api('GET', `/api/projects/${S.pid}/webhooks`); });
}
async function loadReport() {
  const id = S.reportId || (S.sprints.find((s) => s.state === 'active') || S.sprints[0] || {}).id;
  S.report = id ? { id, ...(await api('GET', `/api/sprints/${id}/report`)) } : null;
}
const card = (i) => `<div class="card" draggable="true" data-key="${i.key}"><a href="#" data-open="${i.key}" onclick="return false">${i.key}</a> ${esc(i.title)}<br><small>${i.type} · ${i.priority} · ${esc(uname(i.assigneeId))}${i.storyPoints != null ? ' · ' + i.storyPoints + 'pt' : ''}</small></div>`;
function board() {
  return `<div class="board">${S.project.workflow.statuses.map((s) => `<div class="col" data-status="${esc(s.name)}"><b>${esc(s.name)}</b> <small>${s.category}</small>${S.issues.filter((i) => i.status === s.name).map(card).join('')}</div>`).join('')}</div>`;
}
function backlog() {
  const opt = (sel) => `<option value="">Backlog</option>${S.sprints.filter((s) => s.state !== 'completed').map((s) => `<option value="${s.id}" ${s.id === sel ? 'selected' : ''}>${esc(s.name)} (${s.state})</option>`).join('')}`;
  return `<form id="newsprint" class="inline"><input name="name" placeholder="sprint name" required><input name="startDate" type="date"><input name="endDate" type="date"><button>Create sprint</button></form>
  ${S.sprints.map((s) => `<div class="panel"><b>${esc(s.name)}</b> [${s.state}] ${s.state === 'planned' ? `<button data-start="${s.id}">Start</button>` : ''}${s.state === 'active' ? `<button data-complete="${s.id}">Complete</button>` : ''}<button data-report="${s.id}">Report</button>${S.issues.filter((i) => i.sprintId === s.id).map(row(opt)).join('')}</div>`).join('')}
  <div class="panel"><b>Backlog</b>${S.issues.filter((i) => !i.sprintId).map(row(opt)).join('')}</div>`;
}
const row = (opt) => (i) => `<div>${card(i)}<select data-sprint data-issue="${i.key}">${opt(i.sprintId)}</select></div>`;
function detail() {
  const i = S.issue; if (!i) return '';
  const statuses = S.project.workflow.statuses;
  return `<div class="panel"><h3>${i.key} ${esc(i.title)}</h3><p>${esc(i.description)}</p>
  <form id="editissue" class="inline"><input name="title" value="${esc(i.title)}"><select name="status">${statuses.map((s) => `<option ${s.name === i.status ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select><select name="priority">${['urgent', 'high', 'medium', 'low', 'none'].map((p) => `<option ${p === i.priority ? 'selected' : ''}>${p}</option>`).join('')}</select><select name="assigneeId"><option value="">unassigned</option>${S.members.map((m) => `<option value="${m.userId}" ${m.userId === i.assigneeId ? 'selected' : ''}>${esc(m.username)}</option>`).join('')}</select><button>Save</button> <button type="button" id="watch">Watch</button></form>
  ${i.progress ? `<p>Epic progress: ${i.progress.done}/${i.progress.total} issues, ${i.progress.points_done}/${i.progress.points_total} points</p>` : ''}
  <h4>Subtasks</h4>${(i.children || []).map((k) => `<a href="#" data-open="${k}" onclick="return false">${k}</a> `).join('')}<form id="newsub" class="inline"><input name="title" placeholder="new subtask" required><button>Add</button></form>
  <h4>Links</h4>${(i.links || []).map((l) => `<div>${l.type} <a href="#" data-open="${l.key}" onclick="return false">${l.key}</a></div>`).join('')}<form id="newlink" class="inline"><select name="type"><option>blocks</option><option>relates</option><option>duplicates</option></select><input name="target" placeholder="ABC-1" required><button>Link</button></form>
  <h4>Comments</h4>${(S.comments || []).map((c) => `<div><b>${esc(uname(c.authorId))}</b> ${esc(c.body)}${c.edited ? ' (edited)' : ''}</div>`).join('')}<form id="comment" class="inline"><input name="body" placeholder="comment (@user to mention)" required><button>Comment</button></form>
  <h4>History</h4>${(S.history || []).map((h) => `<div><small>${esc(h.at)} ${esc(uname(h.actorId))}: ${esc(h.field)} ${esc(JSON.stringify(h.from))} → ${esc(JSON.stringify(h.to))}</small></div>`).join('')}</div>`;
}
function report() {
  const r = S.report; if (!r) return '<p>No sprint.</p>';
  const W = 480, H = 200, pad = 30, n = r.burndown.length, max = Math.max(1, ...r.burndown.map((b) => b.remainingPoints), r.committedPoints);
  const pts = r.burndown.map((b, k) => `${pad + (n > 1 ? (k * (W - 2 * pad)) / (n - 1) : 0)},${H - pad - (b.remainingPoints / max) * (H - 2 * pad)}`).join(' ');
  return `<div class="panel"><h3>Sprint report</h3><p>Committed ${r.committedPoints} pts · Completed ${r.completedPoints} pts (${r.completedIssues} issues) · Carried over ${r.carriedOver}</p>
  <svg id="burndown" width="${W}" height="${H}" style="background:#fff;border:1px solid #ccc"><line x1="${pad}" y1="${H - pad}" x2="${W - pad}" y2="${H - pad}" stroke="#999"/><line x1="${pad}" y1="${pad}" x2="${pad}" y2="${H - pad}" stroke="#999"/><polyline fill="none" stroke="#0052cc" stroke-width="2" points="${pts}"/><text x="4" y="${pad}" font-size="10">${max}</text>${r.burndown.map((b, k) => `<circle cx="${pad + (n > 1 ? (k * (W - 2 * pad)) / (n - 1) : 0)}" cy="${H - pad - (b.remainingPoints / max) * (H - 2 * pad)}" r="3" fill="#0052cc"><title>${b.date}: ${b.remainingPoints}</title></circle>`).join('')}</svg></div>`;
}
function settings() {
  const w = S.project.workflow;
  return `<div class="panel"><h3>Workflow</h3><form id="wf"><textarea name="statuses" rows="6" cols="40">${w.statuses.map((s) => s.name + ':' + s.category).join('\n')}</textarea><br><input name="remap" placeholder='remap JSON e.g. {"Old":"New"}' size="40"><button>Save workflow</button></form></div>
  <div class="panel"><h3>Members</h3>${S.members.map((m) => `<div>${esc(m.username)} — ${m.role}</div>`).join('')}<form id="addmember" class="inline"><input name="username" placeholder="username" required><select name="role"><option>developer</option><option>lead</option><option>viewer</option></select><button>Add</button></form></div>
  <div class="panel"><h3>Webhooks</h3>${(S.hooks || []).map((h) => `<div>${esc(h.url)} [${h.events}]</div>`).join('')}<form id="addhook" class="inline"><input name="url" placeholder="https://…" required><input name="events" value="issue.created,issue.updated"><input name="secret" placeholder="secret" required><button>Add</button></form></div>`;
}
function render() {
  if (!S.me) { $app.innerHTML = authView(); return wire(); }
  const tabs = ['board', 'backlog', 'report', 'settings'];
  $app.innerHTML = `<header><b>pm-s4</b><select id="wsel">${S.ws.map((w) => `<option value="${w.id}" ${w.id === S.wsId ? 'selected' : ''}>${esc(w.name)}</option>`).join('')}</select>
  <select id="psel">${S.projects.map((p) => `<option value="${p.id}" ${p.id === S.pid ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select>
  <form id="search" style="margin:0"><input name="q" placeholder='status:"In Progress" assignee:me -label:x'><button>Search</button></form>
  <span class="tabs">${tabs.map((t) => `<button data-tab="${t}">${t}</button>`).join('')}</span><button id="bell">🔔</button><span>${esc(S.me.displayName)}</span><button id="logout">Logout</button></header>
  ${S.notifs ? `<div class="notif"><button id="readall">Mark all read</button>${S.notifs.map((n) => `<div style="${n.read ? '' : 'font-weight:bold'}">${n.type} ${n.issueKey}</div>`).join('') || 'none'}</div>` : ''}
  <main><div class="err">${esc(S.msg)}</div>
  <form id="newws" class="inline"><input name="name" placeholder="workspace name"><input name="key" placeholder="KEY"><button>New workspace</button></form>
  ${S.wsId ? '<form id="newproj" class="inline"><input name="name" placeholder="project name"><input name="key" placeholder="KEY"><button>New project</button></form>' : ''}
  ${S.project ? `<form id="newissue" class="inline"><input name="title" placeholder="new issue" required><select name="type"><option>task</option><option>bug</option><option>feature</option><option>epic</option></select><input name="storyPoints" type="number" placeholder="pts" style="width:60px"><button>Create</button></form>
  ${S.tab === 'board' ? board() : S.tab === 'backlog' ? backlog() : S.tab === 'report' ? report() : S.tab === 'settings' ? settings() : (S.results || []).map(card).join('') || 'No results'}
  ${detail()}` : '<p>Create or select a project.</p>'}</main>`;
  wire();
}
boot();
