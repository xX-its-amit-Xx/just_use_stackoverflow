import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../../src/server.js';
import { parseCsv } from '../../src/csv.js';

let srv, base, now;
before(async () => {
  now = new Date('2026-03-02T12:00:00Z');
  srv = createServer({ clock: () => new Date(now) });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => new Promise((r) => srv.close(r)));

async function call(method, path, body, token, raw) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (raw !== undefined) { headers['content-type'] = 'text/csv'; payload = raw; }
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(base + path, { method, headers, body: payload });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, body: json, text };
}

async function login(username) {
  await call('POST', '/api/auth/register', { username, password: 'password123' });
  return (await call('POST', '/api/auth/login', { username, password: 'password123' })).body.token;
}

test('auth: register, login, me, logout, password rules', async () => {
  const r = await call('POST', '/api/auth/register', { username: 'bob', password: 'password123', displayName: 'Bob' });
  assert.equal(r.status, 201);
  assert.deepEqual(Object.keys(r.body.user).sort(), ['displayName', 'id', 'username']);
  assert.equal((await call('POST', '/api/auth/register', { username: 'bob', password: 'password123' })).status, 409);
  assert.equal((await call('POST', '/api/auth/register', { username: 'bobby', password: 'short' })).status, 400);
  const bad = await call('POST', '/api/auth/login', { username: 'bob', password: 'wrongwrong' });
  assert.equal(bad.status, 401);
  const ok = await call('POST', '/api/auth/login', { username: 'bob', password: 'password123' });
  assert.equal(ok.status, 200);
  assert.equal((await call('GET', '/api/auth/me', undefined, ok.body.token)).body.user.username, 'bob');
  assert.equal((await call('GET', '/api/auth/me')).status, 401);
  assert.equal((await call('POST', '/api/auth/logout', undefined, ok.body.token)).status, 204);
  assert.equal((await call('GET', '/api/auth/me', undefined, ok.body.token)).status, 401);
});

test('login rate limit: 5 failures per username in 15 minutes -> 429', async () => {
  await call('POST', '/api/auth/register', { username: 'carol', password: 'password123' });
  for (let i = 0; i < 5; i++) {
    assert.equal((await call('POST', '/api/auth/login', { username: 'carol', password: 'nope-nope' })).status, 401);
  }
  assert.equal((await call('POST', '/api/auth/login', { username: 'carol', password: 'password123' })).status, 429);
});

test('api tokens authenticate and are shown once', async () => {
  const t = await login('dave');
  const created = await call('POST', '/api/tokens', { name: 'ci' }, t);
  assert.equal(created.status, 201);
  assert.ok(created.body.token);
  assert.equal((await call('GET', '/api/auth/me', undefined, created.body.token)).status, 200);
  const list = await call('GET', '/api/tokens', undefined, t);
  assert.equal(list.body.length, 1);
  assert.equal(list.body[0].token, undefined);
  assert.equal((await call('DELETE', `/api/tokens/${created.body.id}`, undefined, t)).status, 204);
  assert.equal((await call('GET', '/api/auth/me', undefined, created.body.token)).status, 401);
});

test('workspaces, RBAC and project access', async () => {
  const owner = await login('owner1');
  const member = await login('member1');
  const guest = await login('guest1');
  const outsider = await login('outsider1');
  const ws = (await call('POST', '/api/workspaces', { name: 'Acme', key: 'ACME' }, owner)).body;
  assert.equal(ws.key, 'ACME');
  assert.equal((await call('POST', '/api/workspaces', { name: 'Dup', key: 'ACME' }, owner)).status, 409);
  assert.equal((await call('POST', '/api/workspaces', { name: 'x', key: 'acme' }, owner)).status, 400);
  assert.equal((await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'member1', role: 'member' }, member)).status, 403);
  assert.equal((await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'member1', role: 'member' }, owner)).status, 201);
  assert.equal((await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'guest1', role: 'guest' }, owner)).status, 201);
  assert.equal((await call('GET', `/api/workspaces/${ws.id}`, undefined, outsider)).status, 403);
  assert.equal((await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'G', key: 'GST' }, guest)).status, 403);
  const pr = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Web', key: 'WEB' }, member)).body;
  assert.equal(pr.key, 'WEB');
  // member is lead of the project they created; outsider and non-added members get 403
  assert.equal((await call('GET', `/api/projects/${pr.id}`, undefined, outsider)).status, 403);
  const ownerProj = await call('GET', `/api/projects/${pr.id}`, undefined, owner);
  assert.equal(ownerProj.status, 200, 'workspace admin acts as lead');
  assert.equal((await call('GET', `/api/projects/${pr.id}`, undefined, guest)).status, 403);
  assert.equal((await call('POST', `/api/projects/${pr.id}/members`, { username: 'guest1', role: 'viewer' }, member)).status, 201);
  assert.equal((await call('GET', `/api/projects/${pr.id}`, undefined, guest)).status, 200);
  // last admin protections
  assert.equal((await call('DELETE', `/api/workspaces/${ws.id}/members/owner1`, undefined, owner)).status, 400);
  assert.equal((await call('PATCH', `/api/workspaces/${ws.id}/members/owner1`, { role: 'member' }, owner)).status, 400);
  const audit = await call('GET', `/api/workspaces/${ws.id}/audit`, undefined, owner);
  assert.equal(audit.status, 200);
  assert.ok(audit.body.some((a) => a.action === 'member.added'));
});

test('issues: keys sequential, subtasks, epics, links, workflow and blocking', async () => {
  const t = await login('lead2');
  const ws = (await call('POST', '/api/workspaces', { name: 'Flow', key: 'FLOW' }, t)).body;
  const p = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Proj', key: 'PRJ' }, t)).body;
  const mk = (b) => call('POST', `/api/projects/${p.id}/issues`, b, t);
  const a = await mk({ type: 'task', title: 'A' });
  assert.equal(a.status, 201);
  assert.equal(a.body.key, 'PRJ-1');
  assert.equal(a.body.status, 'Todo');
  assert.equal(a.body.priority, 'none');
  const b = await mk({ type: 'bug', title: 'B', priority: 'high' });
  assert.equal(b.body.key, 'PRJ-2');
  assert.equal((await mk({ type: 'subtask', title: 'no parent' })).status, 400);
  const sub = await mk({ type: 'subtask', title: 'S', parentId: a.body.id });
  assert.equal(sub.status, 201);
  assert.equal((await mk({ type: 'subtask', title: 'bad', parentId: sub.body.id })).status, 400);
  const epic = await mk({ type: 'epic', title: 'E' });
  assert.equal((await mk({ type: 'epic', title: 'E2', parentId: a.body.id })).status, 400);
  const withEpic = await mk({ type: 'task', title: 'C', epicId: epic.body.id, storyPoints: 3 });
  assert.equal(withEpic.status, 201);
  const detail = await call('GET', '/api/issues/PRJ-1', undefined, t);
  assert.deepEqual(detail.body.children, ['PRJ-3']);
  // workflow transitions
  const bad = await call('PATCH', '/api/issues/PRJ-1', { status: 'Done' }, t);
  assert.equal(bad.status, 200, 'default workflow allows any->any');
  assert.ok(bad.body.resolvedAt);
  const reopen = await call('PATCH', '/api/issues/PRJ-1', { status: 'Todo' }, t);
  assert.equal(reopen.body.resolvedAt, null);
  // links: blocks -> blocked_by inverse, completing blocked issue is 409
  assert.equal((await call('POST', '/api/issues/PRJ-2/links', { type: 'blocks', target: 'PRJ-1' }, t)).status, 201);
  const inv = await call('GET', '/api/issues/PRJ-1', undefined, t);
  assert.ok(inv.body.links.some((l) => l.type === 'blocked_by' && l.target === 'PRJ-2'));
  const blocked = await call('PATCH', '/api/issues/PRJ-1', { status: 'Done' }, t);
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.error, 'blocked');
  // epic progress
  const e = await call('GET', `/api/issues/${epic.body.key}`, undefined, t);
  assert.deepEqual(e.body.progress, { total: 1, done: 0, points_total: 3, points_done: 0 });
  // history
  const hist = await call('GET', '/api/issues/PRJ-1/history', undefined, t);
  assert.ok(hist.body.some((h) => h.field === 'status' && h.to === 'Done' && h.actorId));
  // delete parent deletes subtasks
  assert.equal((await call('DELETE', '/api/issues/PRJ-1', undefined, t)).status, 204);
  assert.equal((await call('GET', '/api/issues/PRJ-3', undefined, t)).status, 404);
  // key never reused
  assert.equal((await mk({ type: 'task', title: 'D' })).body.key, 'PRJ-6');
});

test('custom workflow: transitions enforced, removal needs remap', async () => {
  const t = await login('lead3');
  const ws = (await call('POST', '/api/workspaces', { name: 'WF', key: 'WFX' }, t)).body;
  const p = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'W', key: 'WKF' }, t)).body;
  const issue = (await call('POST', `/api/projects/${p.id}/issues`, { type: 'task', title: 'x' }, t)).body;
  const wf = {
    statuses: [{ name: 'Open', category: 'unstarted' }, { name: 'Doing', category: 'started' }, { name: 'Closed', category: 'completed' }],
    transitions: [['Open', 'Doing'], ['Doing', 'Closed']],
  };
  assert.equal((await call('PUT', `/api/projects/${p.id}/workflow`, { ...wf, remap: { Todo: 'Open' } }, t)).status, 200);
  const r = await call('PATCH', `/api/issues/${issue.key}`, { status: 'Closed' }, t);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'invalid_transition');
  assert.equal((await call('PATCH', `/api/issues/${issue.key}`, { status: 'Doing' }, t)).status, 200);
  // Doing is in use; removing it without remap must fail
  const noRemap = await call('PUT', `/api/projects/${p.id}/workflow`, { statuses: [{ name: 'Open', category: 'unstarted' }, { name: 'Closed', category: 'completed' }] }, t);
  assert.equal(noRemap.status, 400);
  const withRemap = await call('PUT', `/api/projects/${p.id}/workflow`, { statuses: [{ name: 'Open', category: 'unstarted' }, { name: 'Closed', category: 'completed' }], remap: { Doing: 'Open' } }, t);
  assert.equal(withRemap.status, 200);
  assert.equal((await call('GET', `/api/issues/${issue.key}`, undefined, t)).body.status, 'Open');
});

test('comments, mentions, watchers and notifications', async () => {
  const alice = await login('alice9');
  const bob = await login('bob9');
  const ws = (await call('POST', '/api/workspaces', { name: 'Notif', key: 'NTF' }, alice)).body;
  await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'bob9', role: 'member' }, alice);
  const p = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'N', key: 'NTP' }, alice)).body;
  await call('POST', `/api/projects/${p.id}/members`, { username: 'bob9', role: 'developer' }, alice);
  const issue = (await call('POST', `/api/projects/${p.id}/issues`, { type: 'task', title: 'Notify me', assigneeId: null }, alice)).body;
  // assigning bob notifies watchers (alice is reporter/watcher)
  await call('PATCH', `/api/issues/${issue.key}`, { assigneeId: (await call('GET', '/api/auth/me', undefined, bob)).body.user.id }, alice);
  const bn = await call('GET', '/api/notifications?unread=true', undefined, bob);
  assert.ok(bn.body.some((n) => n.type === 'assigned' && n.issueKey === issue.key));
  const comment = await call('POST', `/api/issues/${issue.key}/comments`, { body: 'hi @bob9 please check' }, alice);
  assert.equal(comment.status, 201);
  const bobNotes = await call('GET', '/api/notifications', undefined, bob);
  assert.ok(bobNotes.body.some((n) => n.type === 'mention'));
  assert.equal(bobNotes.body[0].read, false);
  const ids = bobNotes.body.map((n) => n.id);
  assert.equal((await call('POST', '/api/notifications/read', { ids }, bob)).status, 200);
  assert.equal((await call('GET', '/api/notifications?unread=true', undefined, bob)).body.length, 0);
  // actor is not notified of own comment
  const aliceNotes = await call('GET', '/api/notifications', undefined, alice);
  assert.ok(!aliceNotes.body.some((n) => n.type === 'comment'));
  // edit by author only
  assert.equal((await call('PATCH', `/api/comments/${comment.body.id}`, { body: 'x' }, bob)).status, 403);
  const edited = await call('PATCH', `/api/comments/${comment.body.id}`, { body: 'edited' }, alice);
  assert.equal(edited.body.edited, true);
  assert.equal((await call('POST', `/api/issues/${issue.key}/watch`, undefined, bob)).status, 200);
});

test('sprints: lifecycle, one active, burndown and report', async () => {
  const t = await login('scrum1');
  const ws = (await call('POST', '/api/workspaces', { name: 'Scrum', key: 'SCR' }, t)).body;
  const p = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'S', key: 'SPR' }, t)).body;
  now = new Date('2026-03-01T08:00:00Z');
  const s1 = (await call('POST', `/api/projects/${p.id}/sprints`, { name: 'S1', startDate: '2026-03-01', endDate: '2026-03-05' }, t)).body;
  const s2 = (await call('POST', `/api/projects/${p.id}/sprints`, { name: 'S2' }, t)).body;
  const i1 = (await call('POST', `/api/projects/${p.id}/issues`, { type: 'task', title: 'one', storyPoints: 3, sprintId: s1.id }, t)).body;
  await call('POST', `/api/projects/${p.id}/issues`, { type: 'task', title: 'two', storyPoints: 5, sprintId: s1.id }, t);
  assert.equal((await call('POST', `/api/sprints/${s1.id}/start`, undefined, t)).status, 200);
  assert.equal((await call('POST', `/api/sprints/${s2.id}/start`, undefined, t)).status, 409);
  now = new Date('2026-03-02T09:00:00Z');
  await call('PATCH', `/api/issues/${i1.key}`, { status: 'Done' }, t);
  now = new Date('2026-03-03T09:00:00Z');
  const r = await call('GET', `/api/sprints/${s1.id}/report`, undefined, t);
  assert.equal(r.status, 200);
  assert.equal(r.body.committedPoints, 8);
  assert.equal(r.body.completedPoints, 3);
  assert.deepEqual(r.body.completedIssues, [i1.key]);
  assert.deepEqual(r.body.burndown.map((d) => d.date), ['2026-03-01', '2026-03-02', '2026-03-03']);
  assert.deepEqual(r.body.burndown.map((d) => d.remainingPoints), [8, 5, 5]);
  const done = await call('POST', `/api/sprints/${s1.id}/complete`, { carryOverTo: s2.id }, t);
  assert.equal(done.body.state, 'completed');
  assert.deepEqual(done.body.carriedOver, ['SPR-2']);
  const s2issues = await call('GET', `/api/search?q=${encodeURIComponent('sprint:' + s2.id)}`, undefined, t);
  assert.equal(s2issues.body.length, 1);
  assert.equal(s2issues.body[0].key, 'SPR-2');
});

test('search query language', async () => {
  const t = await login('searcher');
  const ws = (await call('POST', '/api/workspaces', { name: 'Search', key: 'SRC' }, t)).body;
  const p = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Q', key: 'QRY' }, t)).body;
  const mk = (b) => call('POST', `/api/projects/${p.id}/issues`, b, t);
  await mk({ type: 'bug', title: 'Login crash', priority: 'high', labels: ['ui', 'wontfix'], dueDate: '2026-04-01', storyPoints: 5 });
  await mk({ type: 'task', title: 'Write docs', status: 'In Progress', labels: ['docs'], storyPoints: 2 });
  await mk({ type: 'feature', title: 'Dark mode', description: 'theme toggle', priority: 'low' });
  const q = async (s, extra = '') => (await call('GET', `/api/search?q=${encodeURIComponent(s)}${extra}`, undefined, t));
  assert.equal((await q('type:bug')).body.length, 1);
  assert.equal((await q('status:"In Progress"')).body.length, 1);
  assert.equal((await q('priority:high')).body.length, 1);
  assert.equal((await q('label:docs')).body.length, 1);
  assert.equal((await q('-label:wontfix')).body.length, 2);
  assert.equal((await q('due:<2026-05-01')).body.length, 1);
  assert.equal((await q('due:>2026-05-01')).body.length, 0);
  assert.equal((await q('points:>3')).body.length, 1);
  assert.equal((await q('key:QRY-3')).body[0].title, 'Dark mode');
  assert.equal((await q('is:open')).body.length, 3);
  assert.equal((await q('"login CRASH"')).body.length, 1);
  assert.equal((await q('theme')).body.length, 1);
  assert.equal((await q('assignee:me')).body.length, 0);
  assert.equal((await q('assignee:none')).body.length, 3);
  assert.equal((await q('sprint:none')).body.length, 3);
  assert.equal((await q('priority:high', '&sort=bogus')).status, 400);
  assert.equal((await q('status:"In Progress')).status, 400);
  assert.equal((await q('nosuchkey:val')).status, 400);
  assert.equal((await q('due:notadate')).status, 400);
  assert.equal((await q('status:"Done"x')).status, 400);
  // visibility: outsider sees nothing
  const other = await login('stranger');
  assert.equal((await call('GET', `/api/search?q=`, undefined, other)).body.length, 0);
});

test('csv export/import round trip with per-line errors', async () => {
  const t = await login('csv1');
  const ws = (await call('POST', '/api/workspaces', { name: 'CSV', key: 'CSV' }, t)).body;
  const p = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'C', key: 'CSVP' }, t)).body;
  const csv = [
    'key,type,title,status,priority,labels,storyPoints',
    'x,task,"Quoted, title",Todo,high,a;b,3',
    'x,bogus,Bad type,,,,',
    'x,bug,"Multi',
    'line",,,,',
    'x,bug,,,,,',
    '',
  ].join('\r\n');
  const up = await call('POST', `/api/projects/${p.id}/import.csv`, undefined, t, csv);
  assert.equal(up.status, 200);
  assert.equal(up.body.created, 2);
  assert.equal(up.body.errors.length, 2);
  assert.equal(up.body.errors[0].line, 3);
  const ex = await call('GET', `/api/projects/${p.id}/export.csv`, undefined, t);
  assert.equal(ex.status, 200);
  const rows = parseCsv(ex.text).map((r) => r.fields);
  assert.deepEqual(rows[0], ['key', 'type', 'title', 'status', 'priority', 'assignee', 'labels', 'storyPoints', 'parent', 'epic', 'sprint', 'dueDate', 'createdAt', 'resolvedAt']);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1].slice(0, 8), ['CSVP-1', 'task', 'Quoted, title', 'Todo', 'high', '', 'a;b', '3']);
  assert.equal(rows[2][2], 'Multi\r\nline');
});

test('webhooks: signed delivery, retries and recorded status', async () => {
  const crypto = await import('node:crypto');
  const received = [];
  let failNext = 1;
  const hook = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ sig: req.headers['x-pm-signature'], body });
      if (failNext-- > 0) { res.writeHead(500); res.end(); } else { res.writeHead(204); res.end(); }
    });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${hook.address().port}/hook`;
  const t = await login('hookowner');
  const ws = (await call('POST', '/api/workspaces', { name: 'Hooks', key: 'HKS' }, t)).body;
  const p = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'H', key: 'HOK' }, t)).body;
  const h = await call('POST', `/api/projects/${p.id}/webhooks`, { url, events: ['issue.created'], secret: 'shh' }, t);
  assert.equal(h.status, 201);
  await call('POST', `/api/projects/${p.id}/issues`, { type: 'task', title: 'hooked' }, t);
  let deliveries = [];
  for (let i = 0; i < 100; i++) {
    deliveries = (await call('GET', `/api/webhooks/${h.body.id}/deliveries`, undefined, t)).body;
    if (deliveries.length && deliveries[0].status === 204) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(deliveries[0].status, 204);
  assert.equal(deliveries[0].attempts, 2);
  assert.equal(received.length, 2);
  const expected = 'sha256=' + crypto.createHmac('sha256', 'shh').update(received[1].body).digest('hex');
  assert.equal(received[1].sig, expected);
  assert.equal(JSON.parse(received[1].body).event, 'issue.created');
  await new Promise((r) => hook.close(r));
});
