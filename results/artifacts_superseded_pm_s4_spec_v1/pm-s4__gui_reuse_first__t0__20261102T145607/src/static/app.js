// pm-s4 SPA — uses only the public REST API.
const $app = document.getElementById('app');
const S = { token: localStorage.getItem('pm_token'), me: null, ws: [], wsId: null, projects: [], pid: null, view: 'board', issueKey: null, err: '', notifs: [], showNotif: false, q: '' };
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v === true) e.setAttribute(k, ''); else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
};
async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { 'content-type': 'application/json', ...(S.token ? { authorization: 'Bearer ' + S.token } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const t = await r.text(); let d = null; try { d = JSON.parse(t); } catch { d = t; }
  if (!r.ok) { const e = new Error((d && d.message) || r.statusText); e.status = r.status; e.code = d && d.error; throw e; }
  return d;
}
const guard = fn => async (...a) => { try { S.err = ''; await fn(...a); } catch (e) { S.err = e.message; if (e.status === 401 && S.token) { logout(true); } } render(); };
const cur = () => S.projects.find(p => p.id === S.pid);
const uname = id => { const w = S.ws.find(x => x.id === S.wsId); const m = w && w.members.find(m => m.userId === id); return m ? m.username : id || '—'; };

async function boot() {
  if (S.token) { try { S.me = await api('GET', '/api/auth/me'); await loadWs(); } catch { logout(true); } }
  render();
}
function logout(local) { if (!local) api('POST', '/api/auth/logout').catch(() => {}); localStorage.removeItem('pm_token'); S.token = null; S.me = null; render(); }
async function loadWs() {
  S.ws = await api('GET', '/api/workspaces');
  if (!S.ws.find(w => w.id === S.wsId)) S.wsId = S.ws[0] && S.ws[0].id;
  await loadProjects(); await loadNotifs();
}
async function loadProjects() {
  S.projects = S.wsId ? await api('GET', `/api/workspaces/${S.wsId}/projects`) : [];
  if (!S.projects.find(p => p.id === S.pid)) S.pid = S.projects[0] && S.projects[0].id;
  S.issues = null; S.sprints = null;
}
async function loadNotifs() { S.notifs = await api('GET', '/api/notifications'); }
async function loadIssues() { if (S.pid) { S.issues = S.q ? await api('GET', `/api/search?project=${S.pid}&q=${encodeURIComponent(S.q)}`) : await api('GET', `/api/projects/${S.pid}/issues`); S.sprints = await api('GET', `/api/projects/${S.pid}/sprints`); } }

function authView() {
  const u = h('input', { placeholder: 'username', id: 'u' }), p = h('input', { type: 'password', placeholder: 'password', id: 'p' });
  const go = reg => guard(async () => {
    if (reg) await api('POST', '/api/auth/register', { username: u.value, password: p.value });
    const r = await api('POST', '/api/auth/login', { username: u.value, password: p.value });
    S.token = r.token; localStorage.setItem('pm_token', r.token); S.me = r.user; await loadWs();
  })();
  return h('div', { class: 'auth panel' }, h('h2', {}, 'Project Manager'), u, p, h('button', { onclick: () => go(false) }, 'Log in'), ' ', h('button', { onclick: () => go(true) }, 'Register'), h('div', { class: 'err' }, S.err));
}
function headerView() {
  const wsSel = h('select', { onchange: e => guard(async () => { S.wsId = e.target.value; await loadProjects(); })() }, S.ws.map(w => h('option', { value: w.id, selected: w.id === S.wsId }, w.name)));
  const prSel = h('select', { onchange: e => { S.pid = e.target.value; S.issues = null; S.issueKey = null; render(); } }, S.projects.map(p => h('option', { value: p.id, selected: p.id === S.pid }, `${p.key} ${p.name}`)));
  const q = h('input', { placeholder: 'search: status:"In Progress" -label:x', size: 34, value: S.q, onkeydown: e => { if (e.key === 'Enter') { S.q = e.target.value; S.view = 'board'; S.issueKey = null; S.issues = null; guard(async () => {})(); } } });
  const unread = S.notifs.filter(n => !n.read).length;
  return h('header', {}, h('b', {}, 'PM'), wsSel,
    h('button', { onclick: () => { const name = prompt('Workspace name'), key = name && prompt('Key (2-10 uppercase letters)'); if (key) guard(async () => { const w = await api('POST', '/api/workspaces', { name, key }); S.wsId = w.id; await loadWs(); })(); } }, '+ws'),
    prSel,
    h('button', { onclick: () => { const name = prompt('Project name'), key = name && prompt('Project key'); if (key) guard(async () => { const p = await api('POST', `/api/workspaces/${S.wsId}/projects`, { name, key }); S.pid = p.id; await loadProjects(); S.pid = p.id; })(); } }, '+project'),
    h('nav', {}, ['board', 'backlog', 'report', 'settings'].map(v => h('button', { onclick: () => { S.view = v; S.issueKey = null; S.issues = null; render(); } }, v))),
    q, h('button', { onclick: () => { S.showNotif = !S.showNotif; guard(loadNotifs)(); } }, `🔔 ${unread}`),
    h('span', {}, S.me.username), h('button', { onclick: () => logout() }, 'Logout'));
}
function issueForm() {
  const t = h('input', { placeholder: 'New issue title' }), ty = h('select', {}, ['task', 'bug', 'feature', 'epic'].map(x => h('option', {}, x)));
  return h('div', {}, t, ty, h('button', { onclick: () => guard(async () => { await api('POST', `/api/projects/${S.pid}/issues`, { title: t.value, type: ty.value }); S.issues = null; })() }, 'Create'));
}
function card(i) {
  return h('div', { class: 'card', draggable: 'true', ondragstart: e => e.dataTransfer.setData('text/plain', i.key), onclick: () => { S.issueKey = i.key; S.detail = null; render(); } },
    h('div', { class: 'small' }, `${i.key} · ${i.type} · ${i.priority}`), h('div', {}, i.title), h('div', { class: 'small' }, `${uname(i.assigneeId)} ${i.storyPoints ?? ''}`));
}
function boardView() {
  const p = cur();
  return h('div', {}, issueForm(), h('div', { class: 'board' }, p.workflow.statuses.map(s => h('div', {
    class: 'col', ondragover: e => e.preventDefault(),
    ondrop: e => { e.preventDefault(); const key = e.dataTransfer.getData('text/plain'); guard(async () => { await api('PATCH', `/api/issues/${key}`, { status: s.name }); S.issues = null; })(); },
  }, h('b', {}, s.name), S.issues.filter(i => i.status === s.name).map(card)))));
}
function backlogView() {
  const sprints = S.sprints.filter(s => s.state !== 'completed');
  const name = h('input', { placeholder: 'Sprint name' });
  const sect = (title, list, sp) => h('div', { class: 'panel' }, h('b', {}, title), ' ',
    sp && sp.state === 'planned' ? h('button', { onclick: guard(async () => { await api('POST', `/api/sprints/${sp.id}/start`); }) }, 'Start') : null,
    sp && sp.state === 'active' ? h('button', { onclick: guard(async () => { await api('POST', `/api/sprints/${sp.id}/complete`, { carryOverTo: 'backlog' }); S.issues = null; }) }, 'Complete') : null,
    list.map(i => h('div', { class: 'card' }, h('span', { onclick: () => { S.issueKey = i.key; S.detail = null; render(); } }, `${i.key} ${i.title} [${i.status}] `),
      h('select', { onchange: e => guard(async () => { await api('PATCH', `/api/issues/${i.key}`, { sprintId: e.target.value || null }); S.issues = null; })() },
        h('option', { value: '' }, 'Backlog'), sprints.map(s => h('option', { value: s.id, selected: s.id === i.sprintId }, s.name))))));
  return h('div', {}, issueForm(), h('div', {}, name, h('button', { onclick: guard(async () => { await api('POST', `/api/projects/${S.pid}/sprints`, { name: name.value }); S.issues = null; }) }, 'Add sprint')),
    sprints.map(s => sect(`${s.name} (${s.state})`, S.issues.filter(i => i.sprintId === s.id), s)), sect('Backlog', S.issues.filter(i => !i.sprintId || !sprints.some(s => s.id === i.sprintId))));
}
function chart(data) {
  const W = 500, H = 200, max = Math.max(1, ...data.map(d => d.remainingPoints)), n = Math.max(1, data.length - 1);
  const pts = data.map((d, k) => `${30 + k * (W - 40) / n},${H - 20 - d.remainingPoints * (H - 40) / max}`).join(' ');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('width', W); svg.setAttribute('height', H);
  svg.innerHTML = `<rect width="${W}" height="${H}" fill="#fff" stroke="#ccc"/><polyline fill="none" stroke="#0052cc" stroke-width="2" points="${pts}"/><text x="4" y="14" font-size="11">${max} pts</text>` +
    data.map((d, k) => `<text x="${30 + k * (W - 40) / n}" y="${H - 5}" font-size="9">${d.date.slice(5)}</text>`).join('');
  return svg;
}
function reportView() {
  if (!S.reports) { S.reports = []; Promise.all(S.sprints.filter(s => s.state !== 'planned').map(async s => ({ s, r: await api('GET', `/api/sprints/${s.id}/report`) }))).then(r => { S.reports = r; render(); }); }
  return h('div', {}, !S.reports.length ? h('div', { class: 'panel' }, 'No started sprints.') : null,
    S.reports.map(({ s, r }) => h('div', { class: 'panel' }, h('h3', {}, `${s.name} (${s.state})`),
      h('div', {}, `Committed ${r.committedPoints} pts · Completed ${r.completedPoints} pts · ${r.completedIssues} issues · carried over ${r.carriedOver}`), chart(r.burndown))));
}
function detailView() {
  if (!S.detail || S.detail.key !== S.issueKey) {
    Promise.all([api('GET', `/api/issues/${S.issueKey}`), api('GET', `/api/issues/${S.issueKey}/comments`), api('GET', `/api/issues/${S.issueKey}/history`)])
      .then(([i, c, hi]) => { S.detail = i; S.comments = c; S.history = hi; render(); }).catch(e => { S.err = e.message; S.issueKey = null; render(); });
    return h('div', {}, 'Loading…');
  }
  const i = S.detail, p = cur(); const reload = () => { S.detail = null; S.issues = null; };
  const cm = h('textarea', { rows: 2, cols: 50, placeholder: 'Comment (use @username)' });
  const lt = h('input', { placeholder: 'target key' }), lty = h('select', {}, ['blocks', 'relates', 'duplicates'].map(x => h('option', {}, x)));
  const st = h('select', { onchange: e => guard(async () => { await api('PATCH', `/api/issues/${i.key}`, { status: e.target.value }); reload(); })() }, p.workflow.statuses.map(s => h('option', { selected: s.name === i.status }, s.name)));
  const pr = h('select', { onchange: e => guard(async () => { await api('PATCH', `/api/issues/${i.key}`, { priority: e.target.value }); reload(); })() }, ['urgent', 'high', 'medium', 'low', 'none'].map(s => h('option', { selected: s === i.priority }, s)));
  const as = h('select', { onchange: e => guard(async () => { await api('PATCH', `/api/issues/${i.key}`, { assigneeId: e.target.value || null }); reload(); })() },
    h('option', { value: '' }, 'unassigned'), S.ws.find(w => w.id === S.wsId).members.map(m => h('option', { value: m.userId, selected: m.userId === i.assigneeId }, m.username)));
  const sub = h('input', { placeholder: 'Subtask title' });
  return h('div', { class: 'panel' }, h('button', { onclick: () => { S.issueKey = null; render(); } }, '← back'),
    h('h2', {}, `${i.key}: ${i.title}`), h('div', {}, 'Status ', st, ' Priority ', pr, ' Assignee ', as),
    h('p', {}, i.description || h('i', {}, 'no description')),
    i.progress ? h('div', {}, `Epic progress: ${i.progress.done}/${i.progress.total} issues, ${i.progress.points_done}/${i.progress.points_total} pts`) : null,
    h('h4', {}, 'Subtasks'), i.children.map(k => h('div', {}, h('a', { href: '#', onclick: e => { e.preventDefault(); S.issueKey = k; S.detail = null; render(); } }, k))),
    h('div', {}, sub, h('button', { onclick: () => guard(async () => { await api('POST', `/api/projects/${S.pid}/issues`, { title: sub.value, type: 'subtask', parentId: i.id }); reload(); })() }, 'Add subtask')),
    h('h4', {}, 'Links'), i.links.map(l => h('div', {}, `${l.type} `, h('a', { href: '#', onclick: e => { e.preventDefault(); S.issueKey = l.target; S.detail = null; render(); } }, l.target), ' ',
      h('button', { onclick: () => guard(async () => { await api('DELETE', `/api/issues/${i.key}/links/${l.id}`); reload(); })() }, 'x'))),
    h('div', {}, lty, lt, h('button', { onclick: () => guard(async () => { await api('POST', `/api/issues/${i.key}/links`, { type: lty.value, target: lt.value }); reload(); })() }, 'Link')),
    h('div', {}, h('button', { onclick: () => guard(async () => { await api(i.watchers.includes(S.me.id) ? 'DELETE' : 'POST', `/api/issues/${i.key}/watch`); reload(); })() }, i.watchers.includes(S.me.id) ? 'Unwatch' : 'Watch'), ' ',
      h('button', { onclick: () => confirm('Delete?') && guard(async () => { await api('DELETE', `/api/issues/${i.key}`); S.issueKey = null; S.issues = null; })() }, 'Delete')),
    h('h4', {}, 'Comments'), S.comments.map(c => h('div', { class: 'card' }, h('div', { class: 'small' }, `${uname(c.authorId)} ${c.createdAt}${c.edited ? ' (edited)' : ''}`), c.body)),
    cm, h('button', { onclick: () => guard(async () => { await api('POST', `/api/issues/${i.key}/comments`, { body: cm.value }); S.detail = null; })() }, 'Comment'),
    h('h4', {}, 'History'), h('table', {}, S.history.map(x => h('tr', {}, h('td', {}, x.at), h('td', {}, uname(x.actorId)), h('td', {}, x.field), h('td', {}, `${JSON.stringify(x.from)} → ${JSON.stringify(x.to)}`)))));
}
function settingsView() {
  const p = cur();
  const wfText = h('textarea', { rows: 10, cols: 60 }, JSON.stringify({ statuses: p.workflow.statuses, transitions: p.workflow.transitions }, null, 1));
  const remap = h('input', { placeholder: 'remap JSON e.g. {"Old":"New"}', size: 40 });
  const mu = h('input', { placeholder: 'username' }), mr = h('select', {}, ['developer', 'lead', 'viewer'].map(x => h('option', {}, x)));
  const wu = h('input', { placeholder: 'workspace member username' }), wr = h('select', {}, ['member', 'admin', 'guest'].map(x => h('option', {}, x)));
  const url = h('input', { placeholder: 'https://…' }), sec = h('input', { placeholder: 'secret' });
  if (!S.hooks) { S.hooks = []; api('GET', `/api/projects/${p.id}/webhooks`).then(x => { S.hooks = x; render(); }).catch(() => {}); }
  return h('div', {},
    h('div', { class: 'panel' }, h('h3', {}, 'Workflow'), wfText, h('div', {}, remap),
      h('button', { onclick: guard(async () => { const b = JSON.parse(wfText.value); if (remap.value) b.remap = JSON.parse(remap.value); await api('PUT', `/api/projects/${p.id}/workflow`, b); await loadProjects(); S.pid = p.id; }) }, 'Save workflow')),
    h('div', { class: 'panel' }, h('h3', {}, 'Project members'), p.members.map(m => h('div', {}, `${m.username} — ${m.role}`)), mu, mr,
      h('button', { onclick: guard(async () => { await api('POST', `/api/projects/${p.id}/members`, { username: mu.value, role: mr.value }); await loadProjects(); S.pid = p.id; }) }, 'Add')),
    h('div', { class: 'panel' }, h('h3', {}, 'Workspace members'), S.ws.find(w => w.id === S.wsId).members.map(m => h('div', {}, `${m.username} — ${m.role}`)), wu, wr,
      h('button', { onclick: guard(async () => { await api('POST', `/api/workspaces/${S.wsId}/members`, { username: wu.value, role: wr.value }); await loadWs(); }) }, 'Add')),
    h('div', { class: 'panel' }, h('h3', {}, 'Webhooks'), S.hooks.map(w => h('div', {}, `${w.url} [${w.events.join(',')}] `, h('button', { onclick: guard(async () => { await api('DELETE', `/api/webhooks/${w.id}`); S.hooks = null; }) }, 'x'))), url, sec,
      h('button', { onclick: guard(async () => { await api('POST', `/api/projects/${p.id}/webhooks`, { url: url.value, secret: sec.value, events: ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'] }); S.hooks = null; }) }, 'Add webhook')),
    h('div', { class: 'panel' }, h('a', { href: '#', onclick: async e => { e.preventDefault(); const r = await fetch(`/api/projects/${p.id}/export.csv`, { headers: { authorization: 'Bearer ' + S.token } }); const u = URL.createObjectURL(await r.blob()); h('a', { href: u, download: `${p.key}.csv` }).click(); } }, 'Export CSV')));
}
function notifView() {
  return h('div', { class: 'notif' }, h('button', { onclick: guard(async () => { await api('POST', '/api/notifications/read', { all: true }); await loadNotifs(); }) }, 'Mark all read'),
    !S.notifs.length ? h('div', {}, 'Nothing yet') : null,
    S.notifs.slice(0, 20).map(n => h('div', { style: n.read ? 'opacity:.6' : 'font-weight:bold' }, h('a', { href: '#', onclick: e => { e.preventDefault(); S.issueKey = n.issueKey; S.detail = null; S.showNotif = false; render(); } }, `${n.type} ${n.issueKey}`), ` by ${uname(n.actorId)}`)));
}
function render() {
  $app.replaceChildren();
  if (!S.me) return $app.append(authView());
  $app.append(headerView(), S.showNotif ? notifView() : '');
  const main = h('main', {}, S.err ? h('div', { class: 'err' }, S.err) : null);
  $app.append(main);
  if (!S.pid) { main.append(h('div', { class: 'panel' }, 'Create a workspace and a project to begin.')); return; }
  if (S.issueKey) { main.append(detailView()); return; }
  if (S.view === 'settings') { main.append(settingsView()); return; }
  if (!S.issues || !S.sprints) { loadIssues().then(render).catch(e => { S.err = e.message; S.issues = []; S.sprints = []; render(); }); return; }
  if (S.q) main.append(h('div', { class: 'small' }, `Search: ${S.q} (${S.issues.length} results) `, h('button', { onclick: () => { S.q = ''; S.issues = null; render(); } }, 'clear')));
  if (S.view === 'report') S.reports = S.reports || null;
  main.append(S.view === 'backlog' ? backlogView() : S.view === 'report' ? reportView() : boardView());
}
boot();
