// pm-s4 single-page app — uses only the public JSON API.
const $app = document.getElementById('app');
const state = { token: localStorage.getItem('pm_token'), user: null, workspaces: [], ws: null, projects: [], project: null, view: 'board', members: [], sprints: [] };

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(method, path, body, raw) {
  const headers = {};
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  if (body !== undefined && !raw) headers['content-type'] = 'application/json';
  if (raw) headers['content-type'] = 'text/csv';
  const res = await fetch(path, { method, headers, body: body === undefined ? undefined : raw ? body : JSON.stringify(body) });
  if (res.status === 401 && path !== '/api/auth/login') { logout(true); throw new Error('Session expired'); }
  const text = await res.text();
  let data = null; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
  return data;
}
const userName = id => state.members.find(m => m.userId === id)?.username || (id ? id.slice(0, 6) : '—');
function h(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild; }
function flash(msg) { alert(msg); }

// ---------- auth ----------
function renderAuth(err = '') {
  $app.innerHTML = `<div class="auth panel"><h2>pm-s4</h2>
    <input id="u" placeholder="username"><input id="p" type="password" placeholder="password">
    <input id="d" placeholder="display name (register)">
    <button class="primary" id="login">Log in</button> <button id="reg">Register</button><p class="err">${esc(err)}</p></div>`;
  const val = id => document.getElementById(id).value;
  document.getElementById('login').onclick = async () => {
    try { const r = await api('POST', '/api/auth/login', { username: val('u'), password: val('p') }); state.token = r.token; localStorage.setItem('pm_token', r.token); boot(); }
    catch (e) { renderAuth(e.message); }
  };
  document.getElementById('reg').onclick = async () => {
    try { await api('POST', '/api/auth/register', { username: val('u'), password: val('p'), displayName: val('d') || undefined }); renderAuth('Registered — now log in'); }
    catch (e) { renderAuth(e.message); }
  };
}
async function logout(silent) {
  if (!silent) try { await api('POST', '/api/auth/logout'); } catch {}
  state.token = null; localStorage.removeItem('pm_token'); renderAuth();
}

// ---------- shell ----------
async function boot() {
  if (!state.token) return renderAuth();
  try { state.user = (await api('GET', '/api/auth/me')).user; } catch { return renderAuth(); }
  state.workspaces = await api('GET', '/api/workspaces');
  if (!state.ws && state.workspaces.length) state.ws = state.workspaces[0];
  await loadWorkspace();
}
async function loadWorkspace() {
  if (state.ws) {
    state.projects = await api('GET', `/api/workspaces/${state.ws.id}/projects`);
    state.members = await api('GET', `/api/workspaces/${state.ws.id}/members`);
    if (!state.project || !state.projects.some(p => p.id === state.project.id)) state.project = state.projects[0] || null;
  } else { state.projects = []; state.project = null; }
  await render();
}
async function render() {
  let unread = 0;
  try { unread = (await api('GET', '/api/notifications?unread=true')).length; } catch {}
  $app.innerHTML = '';
  const header = h(`<header><b>pm-s4</b>
    <select id="wsSel">${state.workspaces.map(w => `<option value="${w.id}" ${w.id === state.ws?.id ? 'selected' : ''}>${esc(w.name)} (${esc(w.key)})</option>`).join('')}</select>
    <button id="newWs">+ Workspace</button>
    <select id="pSel">${state.projects.map(p => `<option value="${p.id}" ${p.id === state.project?.id ? 'selected' : ''}>${esc(p.name)} (${esc(p.key)})</option>`).join('')}</select>
    <button id="newP">+ Project</button>
    <input id="q" class="grow" placeholder='Search e.g. status:"In Progress" assignee:me -label:wontfix'>
    <button id="notif">🔔 ${unread ? `<span class="badge">${unread}</span>` : ''}</button>
    <span>${esc(state.user.displayName)}</span><button id="out">Log out</button></header>`);
  $app.append(header);
  const nav = h(`<nav style="padding:8px 12px">${['board', 'backlog', 'report', 'settings', 'account'].map(v => `<button data-v="${v}" class="${state.view === v ? 'active' : ''}">${v[0].toUpperCase() + v.slice(1)}</button>`).join(' ')}</nav>`);
  $app.append(nav);
  const main = h('<main></main>'); $app.append(main);
  header.querySelector('#wsSel').onchange = e => { state.ws = state.workspaces.find(w => w.id === e.target.value); state.project = null; loadWorkspace(); };
  header.querySelector('#pSel').onchange = e => { state.project = state.projects.find(p => p.id === e.target.value); render(); };
  header.querySelector('#newWs').onclick = async () => {
    const name = prompt('Workspace name'); if (!name) return; const key = prompt('Key (2-10 uppercase letters)'); if (!key) return;
    try { state.ws = await api('POST', '/api/workspaces', { name, key }); state.workspaces = await api('GET', '/api/workspaces'); loadWorkspace(); } catch (e) { flash(e.message); }
  };
  header.querySelector('#newP').onclick = async () => {
    if (!state.ws) return flash('Create a workspace first');
    const name = prompt('Project name'); if (!name) return; const key = prompt('Project key'); if (!key) return;
    try { state.project = await api('POST', `/api/workspaces/${state.ws.id}/projects`, { name, key }); loadWorkspace(); } catch (e) { flash(e.message); }
  };
  header.querySelector('#q').onkeydown = e => { if (e.key === 'Enter') runSearch(e.target.value, main); };
  header.querySelector('#notif').onclick = () => showNotifications();
  header.querySelector('#out').onclick = () => logout();
  nav.querySelectorAll('button').forEach(b => b.onclick = () => { state.view = b.dataset.v; render(); });
  if (state.view === 'account') return renderAccount(main);
  if (!state.project) { main.innerHTML = '<div class="panel">No project selected. Create a workspace and project to begin.</div>'; return; }
  state.project = await api('GET', `/api/projects/${state.project.id}`);
  state.sprints = await api('GET', `/api/projects/${state.project.id}/sprints`);
  ({ board: renderBoard, backlog: renderBacklog, report: renderReport, settings: renderSettings }[state.view] || renderBoard)(main);
}

// ---------- board ----------
async function renderBoard(main) {
  const p = state.project;
  const active = state.sprints.find(s => s.state === 'active');
  const issues = await api('GET', `/api/projects/${p.id}/issues`);
  main.append(h(`<div style="margin-bottom:8px"><button class="primary" id="ni">+ Issue</button> ${active ? `Active sprint: <b>${esc(active.name)}</b>` : ''}</div>`));
  main.querySelector('#ni').onclick = () => newIssue();
  const board = h('<div class="board"></div>');
  for (const s of p.workflow.statuses) {
    const col = h(`<div class="col" data-status="${esc(s.name)}"><b>${esc(s.name)}</b> <small>${s.category}</small></div>`);
    for (const i of issues.filter(x => x.status === s.name && x.type !== 'epic')) {
      const card = h(`<div class="card" draggable="true" data-key="${esc(i.key)}"><div class="k">${esc(i.key)} · ${i.type} · ${i.priority}</div>${esc(i.title)}<div class="k">${i.assigneeId ? '@' + esc(userName(i.assigneeId)) : ''} ${i.storyPoints ?? ''}</div></div>`);
      card.ondragstart = e => e.dataTransfer.setData('text/plain', i.key);
      card.onclick = () => openIssue(i.key);
      col.append(card);
    }
    col.ondragover = e => { e.preventDefault(); col.classList.add('over'); };
    col.ondragleave = () => col.classList.remove('over');
    col.ondrop = async e => {
      e.preventDefault(); col.classList.remove('over');
      const key = e.dataTransfer.getData('text/plain');
      try { await api('PATCH', `/api/issues/${key}`, { status: s.name }); } catch (err) { flash(err.message); }
      render();
    };
    board.append(col);
  }
  main.append(board);
}
async function newIssue(defaults = {}) {
  const p = state.project;
  const m = modal(`<h3>New issue in ${esc(p.key)}</h3>
    <label>Title <input id="t" style="width:100%"></label>
    <label>Type <select id="ty">${['task', 'bug', 'feature', 'epic', 'subtask'].map(t => `<option ${t === (defaults.type || 'task') ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    <label>Priority <select id="pr">${['none', 'low', 'medium', 'high', 'urgent'].map(t => `<option>${t}</option>`).join('')}</select></label>
    <label>Parent key (subtasks) <input id="pa" value="${esc(defaults.parentId || '')}"></label>
    <label>Story points <input id="sp" type="number" min="0"></label>
    <label>Description <textarea id="de"></textarea></label>
    <button class="primary" id="ok">Create</button>`);
  m.querySelector('#ok').onclick = async () => {
    const v = id => m.querySelector(id).value;
    const body = { title: v('#t'), type: v('#ty'), priority: v('#pr'), description: v('#de') };
    if (v('#pa')) body.parentId = v('#pa');
    if (v('#sp') !== '') body.storyPoints = Number(v('#sp'));
    if (defaults.sprintId) body.sprintId = defaults.sprintId;
    try { await api('POST', `/api/projects/${p.id}/issues`, body); m.remove(); render(); } catch (e) { flash(e.message); }
  };
}
function modal(html) {
  const m = h(`<div class="modal"><div><button style="float:right" class="x">✕</button>${html}</div></div>`);
  m.querySelector('.x').onclick = () => m.remove();
  m.onclick = e => { if (e.target === m) m.remove(); };
  document.body.append(m);
  return m;
}

// ---------- issue detail ----------
async function openIssue(key) {
  const [i, comments, history] = await Promise.all([api('GET', `/api/issues/${key}`), api('GET', `/api/issues/${key}/comments`), api('GET', `/api/issues/${key}/history`)]);
  document.querySelectorAll('.modal').forEach(x => x.remove());
  const p = state.project;
  const m = modal(`<h3>${esc(i.key)} — ${esc(i.title)}</h3>
    <div><label>Status <select id="st">${p.workflow.statuses.map(s => `<option ${s.name === i.status ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></label>
    <label>Assignee <select id="as"><option value="">Unassigned</option>${state.members.map(mm => `<option value="${mm.userId}" ${mm.userId === i.assigneeId ? 'selected' : ''}>${esc(mm.username)}</option>`).join('')}</select></label>
    <label>Priority <select id="pr">${['urgent', 'high', 'medium', 'low', 'none'].map(x => `<option ${x === i.priority ? 'selected' : ''}>${x}</option>`).join('')}</select></label>
    <label>Labels <input id="lb" value="${esc(i.labels.join(', '))}"></label>
    <label>Story points <input id="sp" type="number" value="${i.storyPoints ?? ''}"></label>
    <label>Due <input id="du" type="date" value="${i.dueDate || ''}"></label>
    <label>Description <textarea id="de">${esc(i.description)}</textarea></label>
    <button class="primary" id="save">Save</button> <button id="watch">${i.watchers.includes(state.user.id) ? 'Unwatch' : 'Watch'}</button> <button id="del">Delete</button></div>
    ${i.progress ? `<p>Epic progress: ${i.progress.done}/${i.progress.total} issues, ${i.progress.points_done}/${i.progress.points_total} points</p>` : ''}
    <h4>Subtasks</h4><ul>${i.children.map(c => `<li><a href="#" data-k="${esc(c)}">${esc(c)}</a></li>`).join('')}</ul><button id="sub">+ Subtask</button>
    <h4>Links</h4><ul>${i.links.map(l => `<li>${l.type} <a href="#" data-k="${esc(l.key)}">${esc(l.key)}</a></li>`).join('')}</ul>
    <select id="lt"><option>blocks</option><option>relates</option><option>duplicates</option></select><input id="lk" placeholder="target key"><button id="addl">Link</button>
    <h4>Comments</h4>${comments.map(c => `<div class="panel"><b>${esc(userName(c.authorId))}</b> <small>${c.createdAt}${c.edited ? ' (edited)' : ''}</small><p>${esc(c.body)}</p>${c.authorId === state.user.id ? `<button data-edit="${c.id}">Edit</button>` : ''}</div>`).join('')}
    <textarea id="cm" placeholder="Comment — use @username to mention"></textarea><button id="addc">Comment</button>
    <h4>History</h4><table>${history.map(x => `<tr><td>${x.at}</td><td>${esc(userName(x.actorId))}</td><td>${esc(x.field)}</td><td>${esc(JSON.stringify(x.from))} → ${esc(JSON.stringify(x.to))}</td></tr>`).join('')}</table>`);
  const v = s => m.querySelector(s).value;
  const wrap = fn => async () => { try { await fn(); openIssue(key); } catch (e) { flash(e.message); } };
  m.querySelector('#save').onclick = wrap(async () => {
    await api('PATCH', `/api/issues/${key}`, {
      status: v('#st'), assigneeId: v('#as') || null, priority: v('#pr'), description: v('#de'),
      labels: v('#lb').split(',').map(s => s.trim()).filter(Boolean), storyPoints: v('#sp') === '' ? null : Number(v('#sp')), dueDate: v('#du') || null,
    });
  });
  m.querySelector('#watch').onclick = wrap(() => api(i.watchers.includes(state.user.id) ? 'DELETE' : 'POST', `/api/issues/${key}/watch`));
  m.querySelector('#del').onclick = async () => { if (!confirm('Delete issue?')) return; try { await api('DELETE', `/api/issues/${key}`); m.remove(); render(); } catch (e) { flash(e.message); } };
  m.querySelector('#sub').onclick = () => { m.remove(); newIssue({ type: 'subtask', parentId: i.key }); };
  m.querySelector('#addl').onclick = wrap(() => api('POST', `/api/issues/${key}/links`, { type: v('#lt'), target: v('#lk') }));
  m.querySelector('#addc').onclick = wrap(() => api('POST', `/api/issues/${key}/comments`, { body: v('#cm') }));
  m.querySelectorAll('[data-edit]').forEach(b => b.onclick = wrap(async () => {
    const body = prompt('Edit comment', comments.find(c => c.id === b.dataset.edit).body); if (body) await api('PATCH', `/api/comments/${b.dataset.edit}`, { body });
  }));
  m.querySelectorAll('[data-k]').forEach(a => a.onclick = e => { e.preventDefault(); openIssue(a.dataset.k); });
}

// ---------- backlog / sprints ----------
async function renderBacklog(main) {
  const p = state.project;
  const issues = await api('GET', `/api/projects/${p.id}/issues`);
  main.append(h(`<div class="panel"><button id="ns">+ Sprint</button> <button id="ni">+ Issue</button></div>`));
  main.querySelector('#ns').onclick = async () => {
    const name = prompt('Sprint name'); if (!name) return;
    const startDate = prompt('Start date (YYYY-MM-DD, optional)') || undefined, endDate = prompt('End date (YYYY-MM-DD, optional)') || undefined;
    try { await api('POST', `/api/projects/${p.id}/sprints`, { name, startDate, endDate }); render(); } catch (e) { flash(e.message); }
  };
  main.querySelector('#ni').onclick = () => newIssue();
  const open = state.sprints.filter(s => s.state !== 'completed');
  const section = (title, list, sprint) => {
    const el = h(`<div class="panel col" style="min-height:60px"><h4>${esc(title)}</h4></div>`);
    if (sprint) {
      if (sprint.state === 'planned') { const b = h('<button>Start sprint</button>'); b.onclick = async () => { try { await api('POST', `/api/sprints/${sprint.id}/start`, {}); render(); } catch (e) { flash(e.message); } }; el.append(b); }
      if (sprint.state === 'active') {
        const b = h('<button>Complete sprint</button>');
        b.onclick = async () => { const to = prompt('Carry unfinished issues to sprint id or "backlog"', 'backlog'); if (!to) return; try { await api('POST', `/api/sprints/${sprint.id}/complete`, { carryOverTo: to }); render(); } catch (e) { flash(e.message); } };
        el.append(b);
      }
      el.append(h(`<small> ${sprint.state} ${sprint.startDate || ''} → ${sprint.endDate || ''} · id ${sprint.id}</small>`));
    }
    for (const i of list) {
      const row = h(`<div class="card" draggable="true">${esc(i.key)} ${esc(i.title)} <small>${esc(i.status)} · ${i.storyPoints ?? '-'} pts</small></div>`);
      row.ondragstart = e => e.dataTransfer.setData('text/plain', i.key);
      row.onclick = () => openIssue(i.key);
      el.append(row);
    }
    el.ondragover = e => e.preventDefault();
    el.ondrop = async e => { e.preventDefault(); try { await api('PATCH', `/api/issues/${e.dataTransfer.getData('text/plain')}`, { sprintId: sprint ? sprint.id : null }); render(); } catch (err) { flash(err.message); } };
    main.append(el);
  };
  for (const s of open) section(`Sprint: ${s.name}`, issues.filter(i => i.sprintId === s.id), s);
  section('Backlog', issues.filter(i => !i.sprintId), null);
}

// ---------- report ----------
async function renderReport(main) {
  const p = state.project;
  const stats = await api('GET', `/api/projects/${p.id}/stats`);
  main.append(h(`<div class="panel"><h3>Project stats</h3><p>Avg cycle time: ${stats.avgCycleTimeHours == null ? '—' : stats.avgCycleTimeHours.toFixed(1) + ' h'}</p>
    <table><tr><th>Status</th><th>Count</th></tr>${Object.entries(stats.byStatus).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${v}</td></tr>`).join('')}</table></div>`));
  const sel = h(`<div class="panel"><h3>Sprint report</h3><select>${state.sprints.filter(s => s.state !== 'planned').map(s => `<option value="${s.id}">${esc(s.name)} (${s.state})</option>`).join('')}</select><div class="out"></div></div>`);
  main.append(sel);
  const show = async id => {
    if (!id) return;
    const r = await api('GET', `/api/sprints/${id}/report`);
    sel.querySelector('.out').innerHTML = `<p>Committed ${r.committedPoints} pts · Completed ${r.completedPoints} pts (${r.completedIssues} issues) · Carried over ${r.carriedOver}</p>${burndownSvg(r.burndown)}`;
  };
  sel.querySelector('select').onchange = e => show(e.target.value);
  show(sel.querySelector('select').value);
}
function burndownSvg(points) {
  if (!points.length) return '<p>No burndown data yet.</p>';
  const W = 600, H = 240, P = 30;
  const max = Math.max(1, ...points.map(p => p.remainingPoints));
  const x = i => P + (points.length === 1 ? 0 : i * (W - 2 * P) / (points.length - 1));
  const y = v => H - P - v * (H - 2 * P) / max;
  const line = points.map((p, i) => `${x(i)},${y(p.remainingPoints)}`).join(' ');
  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Burndown chart">
    <line x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" stroke="#999"/><line x1="${P}" y1="${P}" x2="${P}" y2="${H - P}" stroke="#999"/>
    <line x1="${x(0)}" y1="${y(points[0].remainingPoints)}" x2="${x(points.length - 1)}" y2="${y(0)}" stroke="#ccc" stroke-dasharray="4"/>
    <polyline fill="none" stroke="#0052cc" stroke-width="2" points="${line}"/>
    ${points.map((p, i) => `<circle cx="${x(i)}" cy="${y(p.remainingPoints)}" r="3" fill="#0052cc"><title>${p.date}: ${p.remainingPoints}</title></circle>`).join('')}
    <text x="${P}" y="${H - 8}" font-size="10">${points[0].date}</text><text x="${W - P - 60}" y="${H - 8}" font-size="10">${points[points.length - 1].date}</text>
    <text x="4" y="${P}" font-size="10">${max}</text></svg>`;
}

// ---------- settings ----------
async function renderSettings(main) {
  const p = state.project;
  const wf = p.workflow;
  const wfPanel = h(`<div class="panel"><h3>Workflow</h3>
    <p>Statuses (one per line, "Name|category"):</p><textarea id="sts" rows="6">${esc(wf.statuses.map(s => `${s.name}|${s.category}`).join('\n'))}</textarea>
    <p>Transitions (one per line "From>To"; leave empty for any→any):</p><textarea id="trs" rows="6">${esc(wf.transitions.map(t => t.join('>')).join('\n'))}</textarea>
    <p>Remap removed statuses (one per line "Old>New"):</p><textarea id="rm" rows="2"></textarea><button class="primary" id="swf">Save workflow</button></div>`);
  main.append(wfPanel);
  wfPanel.querySelector('#swf').onclick = async () => {
    const lines = s => wfPanel.querySelector(s).value.split('\n').map(x => x.trim()).filter(Boolean);
    const statuses = lines('#sts').map(l => { const [name, category] = l.split('|'); return { name: name.trim(), category: (category || '').trim() }; });
    const tr = lines('#trs').map(l => l.split('>').map(x => x.trim()));
    const remap = Object.fromEntries(lines('#rm').map(l => l.split('>').map(x => x.trim())));
    try { await api('PUT', `/api/projects/${p.id}/workflow`, { statuses, transitions: tr.length ? tr : undefined, remap }); render(); } catch (e) { flash(e.message); }
  };
  const members = await api('GET', `/api/projects/${p.id}/members`);
  const mp = h(`<div class="panel"><h3>Project members</h3><table>${members.map(m => `<tr><td>${esc(m.username)}</td><td>${m.role}</td></tr>`).join('')}</table>
    <input id="mu" placeholder="username"><select id="mr"><option>developer</option><option>viewer</option><option>lead</option></select><button id="am">Add</button>
    <h3>Workspace members</h3><table>${state.members.map(m => `<tr><td>${esc(m.username)}</td><td>${m.role}</td></tr>`).join('')}</table>
    <input id="wu" placeholder="username"><select id="wr"><option>member</option><option>guest</option><option>admin</option></select><button id="aw">Add to workspace</button></div>`);
  main.append(mp);
  mp.querySelector('#am').onclick = async () => { try { await api('POST', `/api/projects/${p.id}/members`, { username: mp.querySelector('#mu').value, role: mp.querySelector('#mr').value }); render(); } catch (e) { flash(e.message); } };
  mp.querySelector('#aw').onclick = async () => { try { await api('POST', `/api/workspaces/${state.ws.id}/members`, { username: mp.querySelector('#wu').value, role: mp.querySelector('#wr').value }); loadWorkspace(); } catch (e) { flash(e.message); } };
  let hooks = [];
  try { hooks = await api('GET', `/api/projects/${p.id}/webhooks`); } catch {}
  const wp = h(`<div class="panel"><h3>Webhooks</h3><table>${hooks.map(x => `<tr><td>${esc(x.url)}</td><td>${x.events.join(', ')}</td><td><button data-d="${x.id}">Deliveries</button><button data-x="${x.id}">Delete</button></td></tr>`).join('')}</table>
    <input id="hu" placeholder="https://example.com/hook" style="width:300px"><input id="hs" placeholder="secret">
    ${['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'].map(e => `<label style="display:inline"><input type="checkbox" value="${e}" checked> ${e}</label>`).join(' ')}
    <button id="ah">Add webhook</button><div id="dl"></div>
    <h3>CSV</h3><button id="ex">Export CSV</button> <input type="file" id="imf" accept=".csv,text/csv"><button id="im">Import CSV</button><pre id="imr"></pre></div>`);
  main.append(wp);
  wp.querySelector('#ah').onclick = async () => {
    const events = [...wp.querySelectorAll('input[type=checkbox]:checked')].map(c => c.value);
    try { await api('POST', `/api/projects/${p.id}/webhooks`, { url: wp.querySelector('#hu').value, secret: wp.querySelector('#hs').value, events }); render(); } catch (e) { flash(e.message); }
  };
  wp.querySelectorAll('[data-x]').forEach(b => b.onclick = async () => { await api('DELETE', `/api/webhooks/${b.dataset.x}`); render(); });
  wp.querySelectorAll('[data-d]').forEach(b => b.onclick = async () => {
    const d = await api('GET', `/api/webhooks/${b.dataset.d}/deliveries`);
    wp.querySelector('#dl').innerHTML = `<table>${d.map(x => `<tr><td>${x.event}</td><td>${x.status ?? '…'}</td><td>${x.attempts}</td><td>${esc(x.lastError || '')}</td></tr>`).join('')}</table>`;
  });
  wp.querySelector('#ex').onclick = async () => {
    const res = await fetch(`/api/projects/${p.id}/export.csv`, { headers: { authorization: `Bearer ${state.token}` } });
    const url = URL.createObjectURL(await res.blob());
    const a = document.createElement('a'); a.href = url; a.download = `${p.key}.csv`; a.click(); URL.revokeObjectURL(url);
  };
  wp.querySelector('#im').onclick = async () => {
    const f = wp.querySelector('#imf').files[0]; if (!f) return;
    try { const r = await api('POST', `/api/projects/${p.id}/import.csv`, await f.text(), true); wp.querySelector('#imr').textContent = JSON.stringify(r, null, 2); } catch (e) { flash(e.message); }
  };
  if (state.ws.role === 'admin') {
    const audit = await api('GET', `/api/workspaces/${state.ws.id}/audit`);
    main.append(h(`<div class="panel"><h3>Audit log</h3><table>${audit.slice(-50).reverse().map(a => `<tr><td>${a.at}</td><td>${esc(userName(a.actorId))}</td><td>${esc(a.action)}</td><td><small>${esc(JSON.stringify(a.details))}</small></td></tr>`).join('')}</table></div>`));
  }
}

// ---------- account ----------
async function renderAccount(main) {
  const tokens = await api('GET', '/api/tokens');
  const el = h(`<div class="panel"><h3>Profile</h3><label>Display name <input id="dn" value="${esc(state.user.displayName)}"></label>
    <label>New password <input id="np" type="password"></label><label>Current password <input id="cp" type="password"></label><button id="sv">Save</button>
    <h3>API tokens</h3><table>${tokens.map(t => `<tr><td>${esc(t.name)}</td><td>${t.createdAt}</td><td><button data-x="${t.id}">Revoke</button></td></tr>`).join('')}</table>
    <input id="tn" placeholder="token name"><button id="nt">Create token</button><pre id="tv"></pre></div>`);
  main.append(el);
  el.querySelector('#sv').onclick = async () => {
    const body = { displayName: el.querySelector('#dn').value, currentPassword: el.querySelector('#cp').value };
    if (el.querySelector('#np').value) body.password = el.querySelector('#np').value;
    try { state.user = (await api('PATCH', '/api/auth/me', body)).user; render(); } catch (e) { flash(e.message); }
  };
  el.querySelector('#nt').onclick = async () => { try { const t = await api('POST', '/api/tokens', { name: el.querySelector('#tn').value }); el.querySelector('#tv').textContent = `Copy now, shown once: ${t.token}`; } catch (e) { flash(e.message); } };
  el.querySelectorAll('[data-x]').forEach(b => b.onclick = async () => { await api('DELETE', `/api/tokens/${b.dataset.x}`); render(); });
}

// ---------- search / notifications ----------
async function runSearch(q, main) {
  try {
    const res = await api('GET', `/api/search?q=${encodeURIComponent(q)}`);
    main.innerHTML = `<div class="panel"><h3>Search: ${esc(q)} (${res.length})</h3><table>${res.map(i => `<tr data-k="${esc(i.key)}" style="cursor:pointer"><td>${esc(i.key)}</td><td>${esc(i.title)}</td><td>${esc(i.status)}</td><td>${i.priority}</td></tr>`).join('')}</table></div>`;
    main.querySelectorAll('[data-k]').forEach(r => r.onclick = () => openIssue(r.dataset.k));
  } catch (e) { flash(e.message); }
}
async function showNotifications() {
  const list = await api('GET', '/api/notifications');
  const m = modal(`<h3>Notifications</h3><button id="ra">Mark all read</button><table>${list.map(n => `<tr class="notif ${n.read ? '' : 'unread'}" data-id="${n.id}" data-k="${esc(n.issueKey)}"><td>${n.at}</td><td>${esc(n.type)}</td><td>${esc(n.issueKey)}</td><td>${esc(userName(n.actorId))}</td></tr>`).join('')}</table>`);
  m.querySelector('#ra').onclick = async () => { await api('POST', '/api/notifications/read', { all: true }); m.remove(); render(); };
  m.querySelectorAll('tr[data-id]').forEach(r => r.onclick = async () => { await api('POST', '/api/notifications/read', { ids: [r.dataset.id] }); m.remove(); openIssue(r.dataset.k); });
}

boot();
