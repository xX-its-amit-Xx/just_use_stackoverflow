// pm-s4 hidden evaluation suite (API contract). Not executed in the pilot; validated for syntax only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path'; import fs from 'node:fs'; import os from 'node:os'; import http from 'node:http'; import crypto from 'node:crypto';
const APP = process.env.APP_DIR;
const { createServer } = await import(path.join(APP, 'src/server.js'));

let now = new Date('2030-01-06T09:00:00Z');
const clock = () => new Date(now);
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pm-')), 'data.json');
let srv, base;
const call = async (m, p, b, t, ct = 'application/json') => {
  const h = {}; if (t) h.authorization = `Bearer ${t}`; if (b !== undefined) h['content-type'] = ct;
  const r = await fetch(base + p, { method: m, headers: h, body: b === undefined ? undefined : ct === 'application/json' ? JSON.stringify(b) : b });
  const txt = await r.text(); let body; try { body = JSON.parse(txt); } catch { body = txt; } return { status: r.status, body, headers: r.headers };
};
const user = async u => { await call('POST', '/api/auth/register', { username: u, password: 'password123' }); const r = await call('POST', '/api/auth/login', { username: u, password: 'password123' }); return { t: r.body.token, id: r.body.user.id, u }; };
let A, B, G, ws, pr;
before(async () => {
  srv = createServer({ dataFile: tmp(), clock }); await new Promise(r => srv.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${srv.address().port}`;
  A = await user('alice'); B = await user('bob'); G = await user('guest1');
  ws = (await call('POST', '/api/workspaces', { name: 'Acme', key: 'ACME' }, A.t)).body;
  await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'bob', role: 'member' }, A.t);
  await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'guest1', role: 'guest' }, A.t);
  pr = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Web', key: 'WEB' }, A.t)).body;
  await call('POST', `/api/projects/${pr.id}/members`, { username: 'bob', role: 'developer' }, A.t);
});
after(() => new Promise(r => { srv.closeAllConnections?.(); srv.close(r); }));
const issue = async (body, t = A.t, p = pr.id) => (await call('POST', `/api/projects/${p}/issues`, { type: 'task', title: 'x', ...body }, t)).body;

test('workspace key validation and uniqueness', async () => {
  assert.equal((await call('POST', '/api/workspaces', { name: 'X', key: 'acme' }, B.t)).status, 400);
  assert.equal((await call('POST', '/api/workspaces', { name: 'X', key: 'ACME' }, B.t)).status, 409);
});
test('last admin cannot be removed', async () => { assert.equal((await call('DELETE', `/api/workspaces/${ws.id}/members/${A.id}`, undefined, A.t)).status, 400); });
test('guest cannot create projects or see unshared projects', async () => {
  assert.equal((await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'G', key: 'GG' }, G.t)).status, 403);
  assert.ok([403, 404].includes((await call('GET', `/api/projects/${pr.id}`, undefined, G.t)).status));  // spec v1 did not define GET /api/projects/:id
});
test('api tokens authenticate and are shown once', async () => {
  const r = await call('POST', '/api/tokens', { name: 'ci' }, A.t); assert.equal(r.status, 201); assert.ok(r.body.token);
  const me = (await call('GET', '/api/auth/me', undefined, r.body.token)).body; assert.equal((me.user || me).username, 'alice');  // spec v1 referenced kanban-s3 for the shape
  const list = await call('GET', '/api/tokens', undefined, A.t); assert.ok(!JSON.stringify(list.body).includes(r.body.token));
  await call('DELETE', `/api/tokens/${r.body.id}`, undefined, A.t); assert.equal((await call('GET', '/api/auth/me', undefined, r.body.token)).status, 401);
});
test('issue keys are sequential and never reused', async () => {
  const p = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Seq', key: 'SEQ' }, A.t)).body;
  const i1 = await issue({}, A.t, p.id); const i2 = await issue({}, A.t, p.id);
  assert.deepEqual([i1.key, i2.key], ['SEQ-1', 'SEQ-2']); await call('DELETE', `/api/issues/${i2.key}`, undefined, A.t);
  assert.equal((await issue({}, A.t, p.id)).key, 'SEQ-3');
});
test('default workflow and initial status', async () => {
  const i = await issue({ title: 'flow' }); assert.equal(i.status, 'Todo');
  const r = await call('PATCH', `/api/issues/${i.key}`, { status: 'Done' }, A.t); assert.equal(r.status, 200); assert.ok(r.body.resolvedAt);
  const back = await call('PATCH', `/api/issues/${i.key}`, { status: 'In Progress' }, A.t); assert.equal(back.body.resolvedAt, null);
});
test('custom workflow transitions enforced and remap required', async () => {
  const p = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Wf', key: 'WF' }, A.t)).body;
  const i = await issue({}, A.t, p.id);
  const wf = { statuses: [{ name: 'Open', category: 'unstarted' }, { name: 'Doing', category: 'started' }, { name: 'Closed', category: 'completed' }], transitions: [['Open', 'Doing'], ['Doing', 'Closed']] };
  assert.equal((await call('PUT', `/api/projects/${p.id}/workflow`, wf, A.t)).status, 400);
  assert.equal((await call('PUT', `/api/projects/${p.id}/workflow`, { ...wf, remap: { Todo: 'Open' } }, A.t)).status, 200);
  assert.equal((await call('GET', `/api/issues/${i.key}`, undefined, A.t)).body.status, 'Open');
  const bad = await call('PATCH', `/api/issues/${i.key}`, { status: 'Closed' }, A.t); assert.equal(bad.status, 409); assert.equal(bad.body.error, 'invalid_transition');
  assert.equal((await call('PATCH', `/api/issues/${i.key}`, { status: 'Doing' }, A.t)).status, 200);
});
test('hierarchy: subtasks, epics, progress, cascade delete', async () => {
  const epic = await issue({ type: 'epic', title: 'E' }); const parent = await issue({ title: 'P', epicId: epic.id, storyPoints: 3 });
  const sub = await issue({ type: 'subtask', title: 'S', parentId: parent.id });
  assert.equal((await call('POST', `/api/projects/${pr.id}/issues`, { type: 'subtask', title: 'bad', parentId: sub.id }, A.t)).status, 400);
  assert.equal((await call('POST', `/api/projects/${pr.id}/issues`, { type: 'epic', title: 'bad', parentId: parent.id }, A.t)).status, 400);
  assert.deepEqual((await call('GET', `/api/issues/${parent.key}`, undefined, A.t)).body.children, [sub.key]);
  await call('PATCH', `/api/issues/${parent.key}`, { status: 'Done' }, A.t);
  const ep = (await call('GET', `/api/issues/${epic.key}`, undefined, A.t)).body; assert.equal(ep.progress.done, 1); assert.equal(ep.progress.points_done, 3);
  await call('DELETE', `/api/issues/${parent.key}`, undefined, A.t); assert.equal((await call('GET', `/api/issues/${sub.key}`, undefined, A.t)).status, 404);
});
test('blocking links prevent completion', async () => {
  const a = await issue({ title: 'blocker' }); const b = await issue({ title: 'blocked' });
  assert.equal((await call('POST', `/api/issues/${a.key}/links`, { type: 'blocks', target: b.key }, A.t)).status, 201);
  const r = await call('PATCH', `/api/issues/${b.key}`, { status: 'Done' }, A.t); assert.equal(r.status, 409); assert.equal(r.body.error, 'blocked');
  await call('PATCH', `/api/issues/${a.key}`, { status: 'Done' }, A.t); assert.equal((await call('PATCH', `/api/issues/${b.key}`, { status: 'Done' }, A.t)).status, 200);
});
test('history records field changes', async () => {
  const i = await issue({ title: 'h' }); await call('PATCH', `/api/issues/${i.key}`, { priority: 'high', assigneeId: B.id }, A.t);
  const h = (await call('GET', `/api/issues/${i.key}/history`, undefined, A.t)).body;
  assert.ok(h.some(x => x.field === 'priority' && x.to === 'high')); assert.ok(h.some(x => x.field === 'assigneeId' && x.to === B.id && x.actorId === A.id));
});
test('watchers, mentions and notifications', async () => {
  const i = await issue({ title: 'notify', assigneeId: B.id });
  await call('POST', `/api/issues/${i.key}/comments`, { body: 'hey @bob please look' }, A.t);
  await call('PATCH', `/api/issues/${i.key}`, { status: 'In Progress' }, A.t);
  const n = (await call('GET', '/api/notifications?unread=true', undefined, B.t)).body; assert.ok(n.filter(x => x.issueKey === i.key).length >= 2);
  assert.equal((await call('GET', '/api/notifications?unread=true', undefined, A.t)).body.filter(x => x.issueKey === i.key && x.actorId === A.id).length, 0);
  await call('POST', '/api/notifications/read', { all: true }, B.t); assert.equal((await call('GET', '/api/notifications?unread=true', undefined, B.t)).body.length, 0);
});
test('sprints lifecycle, single active, carry-over and burndown', async () => {
  const p = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Sp', key: 'SP' }, A.t)).body;
  const s1 = (await call('POST', `/api/projects/${p.id}/sprints`, { name: 'S1', startDate: '2030-01-06', endDate: '2030-01-10' }, A.t)).body;
  const s2 = (await call('POST', `/api/projects/${p.id}/sprints`, { name: 'S2' }, A.t)).body;
  const i1 = await issue({ storyPoints: 5, sprintId: s1.id }, A.t, p.id); const i2 = await issue({ storyPoints: 3, sprintId: s1.id }, A.t, p.id);
  assert.equal((await call('POST', `/api/sprints/${s1.id}/start`, undefined, A.t)).status, 200);
  assert.equal((await call('POST', `/api/sprints/${s2.id}/start`, undefined, A.t)).status, 409);
  now = new Date('2030-01-07T12:00:00Z'); await call('PATCH', `/api/issues/${i1.key}`, { status: 'Done' }, A.t);
  now = new Date('2030-01-08T12:00:00Z');
  const rep = (await call('GET', `/api/sprints/${s1.id}/report`, undefined, A.t)).body;
  assert.equal(rep.committedPoints, 8); assert.equal(rep.completedPoints, 5);
  assert.deepEqual(rep.burndown.map(x => x.remainingPoints), [8, 3, 3]);
  assert.equal((await call('POST', `/api/sprints/${s1.id}/complete`, { carryOverTo: s2.id }, A.t)).status, 200);
  assert.equal((await call('GET', `/api/issues/${i2.key}`, undefined, A.t)).body.sprintId, s2.id);
});
test('search query language', async () => {
  const p = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Q', key: 'QQ' }, A.t)).body;
  await call('POST', `/api/projects/${p.id}/members`, { username: 'bob', role: 'developer' }, A.t);
  const a = await issue({ type: 'bug', title: 'Login crash', priority: 'high', labels: ['auth'], assigneeId: B.id, storyPoints: 5 }, A.t, p.id);
  const b = await issue({ type: 'feature', title: 'Dark mode', labels: ['ui', 'wontfix'], dueDate: '2030-02-01' }, A.t, p.id);
  const c = await issue({ type: 'bug', title: 'Typo on login page', priority: 'low' }, A.t, p.id);
  const q = async s => (await call('GET', `/api/search?project=${p.id}&q=${encodeURIComponent(s)}`, undefined, B.t)).body.map(i => i.key).sort();
  assert.deepEqual(await q('type:bug'), [a.key, c.key].sort());
  assert.deepEqual(await q('login priority:high'), [a.key]);
  assert.deepEqual(await q('assignee:me'), [a.key]);
  assert.deepEqual(await q('assignee:none type:bug'), [c.key]);
  assert.deepEqual(await q('-label:wontfix is:open'), [a.key, c.key].sort());
  assert.deepEqual(await q('points:>3'), [a.key]);
  assert.deepEqual(await q('"dark mode"'), [b.key]);
  assert.deepEqual(await q('due:<2030-03-01'), [b.key]);
  assert.equal((await call('GET', `/api/search?q=${encodeURIComponent('status:"unterminated')}`, undefined, B.t)).status, 400);
});
test('csv export / import round trip with row errors', async () => {
  const p = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Csv', key: 'CSV' }, A.t)).body;
  await issue({ title: 'Has, comma "and quotes"', labels: ['a', 'b'] }, A.t, p.id);
  const csv = (await call('GET', `/api/projects/${p.id}/export.csv`, undefined, A.t)).body;
  assert.match(csv.split(/\r?\n/)[0], /^key,type,title,status,priority,assignee,labels,storyPoints,parent,epic,sprint,dueDate,createdAt,resolvedAt$/);
  assert.ok(csv.includes('"Has, comma ""and quotes"""')); assert.ok(csv.includes('a;b'));
  const p2 = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Csv2', key: 'CSVB' }, A.t)).body;
  const bad = csv.trim() + '\n,notatype,Bad row,Todo,none,,,,,,,,,\n';
  const r = await call('POST', `/api/projects/${p2.id}/import.csv`, bad, A.t, 'text/csv');
  assert.equal(r.body.created, 1); assert.equal(r.body.errors.length, 1); assert.equal(r.body.errors[0].line, 3);
});
test('webhooks are signed and delivered', async () => {
  const got = []; const hook = http.createServer((q, s) => { let b = ''; q.on('data', c => (b += c)); q.on('end', () => { got.push({ b, sig: q.headers['x-pm-signature'] }); s.end('ok'); }); });
  await new Promise(r => hook.listen(0, '127.0.0.1', r));
  const w = (await call('POST', `/api/projects/${pr.id}/webhooks`, { url: `http://127.0.0.1:${hook.address().port}/h`, events: ['issue.created'], secret: 's3cret' }, A.t)).body;
  await issue({ title: 'hooked' });
  for (let i = 0; i < 50 && !got.length; i++) await new Promise(r => setTimeout(r, 50));
  hook.close(); assert.equal(got.length, 1);
  assert.equal(got[0].sig, 'sha256=' + crypto.createHmac('sha256', 's3cret').update(got[0].b).digest('hex'));
  assert.equal(JSON.parse(got[0].b).event, 'issue.created');
  const d = (await call('GET', `/api/webhooks/${w.id}/deliveries`, undefined, A.t)).body;
  assert.ok(d[0].status === 200 || /^(success|delivered|ok|succeeded)$/i.test(String(d[0].status)), `delivery status ${d[0].status}`);  // spec v1 ambiguous
});
test('project stats and cycle time', async () => {
  const p = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'St', key: 'ST' }, A.t)).body;
  now = new Date('2030-03-01T00:00:00Z'); const i = await issue({ type: 'bug' }, A.t, p.id);
  await call('PATCH', `/api/issues/${i.key}`, { status: 'In Progress' }, A.t);
  now = new Date('2030-03-01T06:00:00Z'); await call('PATCH', `/api/issues/${i.key}`, { status: 'Done' }, A.t);
  const s = (await call('GET', `/api/projects/${p.id}/stats`, undefined, A.t)).body;
  assert.equal(s.byType.bug, 1); assert.equal(s.byStatus.Done, 1); assert.equal(s.avgCycleTimeHours, 6);
});
test('audit log', async () => {
  const a = (await call('GET', `/api/workspaces/${ws.id}/audit`, undefined, A.t)).body; assert.ok(a.length >= 2);
  assert.equal((await call('GET', `/api/workspaces/${ws.id}/audit`, undefined, B.t)).status, 403);
});
test('SPA served', async () => { const r = await fetch(base + '/'); assert.equal(r.status, 200); assert.match(await r.text(), /<html/i); });
