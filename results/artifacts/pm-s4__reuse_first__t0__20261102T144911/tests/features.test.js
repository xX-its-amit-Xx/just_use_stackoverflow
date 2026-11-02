import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createServer } from '../src/server.js';

async function setup(clock) {
  const srv = createServer({ clock }); await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, b, t, raw) => { const r = await fetch(base + p, { method: m, headers: { ...(raw ? { 'content-type': 'text/csv' } : { 'content-type': 'application/json' }), ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b === undefined ? undefined : raw ? b : JSON.stringify(b) }); const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch { body = text; } return { status: r.status, body }; };
  const user = async (name) => { await call('POST', '/api/auth/register', { username: name, password: 'password123' }); return (await call('POST', '/api/auth/login', { username: name, password: 'password123' })).body.token; };
  return { srv, call, user };
}

test('full flow', async () => {
  let t = new Date('2024-01-01T10:00:00Z');
  const { srv, call, user } = await setup(() => t);
  const a = await user('alice'), b = await user('bob');
  const ws = (await call('POST', '/api/workspaces', { name: 'A', key: 'AC' }, a)).body;
  assert.equal((await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'bob', role: 'member' }, a)).status, 201);
  assert.equal((await call('PATCH', `/api/workspaces/${ws.id}/members/${(await call('GET', '/api/auth/me', undefined, a)).body.id}`, { role: 'member' }, a)).status, 400);
  const pr = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'W', key: 'WEB' }, a)).body;
  const mk = (b2, tok = a) => call('POST', `/api/projects/${pr.id}/issues`, b2, tok);
  const i1 = (await mk({ title: 'one', type: 'bug', storyPoints: 5, assigneeId: 'bob', labels: ['x'] })).body;
  assert.equal(i1.status, 'Todo'); assert.deepEqual(i1.watchers.length, 2);
  const i2 = (await mk({ title: 'two', storyPoints: 3 })).body;
  // links / blocked
  await call('POST', `/api/issues/${i1.key}/links`, { type: 'blocks', target: i2.key }, a);
  assert.equal((await call('GET', `/api/issues/${i2.key}`, undefined, a)).body.links[0].type, 'blocked_by');
  const r = await call('PATCH', `/api/issues/${i2.key}`, { status: 'Done' }, a);
  assert.equal(r.status, 409); assert.equal(r.body.error, 'blocked');
  // sprint
  const sp = (await call('POST', `/api/projects/${pr.id}/sprints`, { name: 'S1', startDate: '2024-01-01', endDate: '2024-01-14' }, a)).body;
  await call('PATCH', `/api/issues/${i1.key}`, { sprintId: sp.id }, a);
  await call('PATCH', `/api/issues/${i2.key}`, { sprintId: sp.id }, a);
  assert.equal((await call('POST', `/api/sprints/${sp.id}/start`, undefined, a)).status, 200);
  t = new Date('2024-01-02T10:00:00Z');
  assert.equal((await call('PATCH', `/api/issues/${i1.key}`, { status: 'Done' }, a)).body.resolvedAt, '2024-01-02T10:00:00.000Z');
  t = new Date('2024-01-03T10:00:00Z');
  const rep = (await call('GET', `/api/sprints/${sp.id}/report`, undefined, a)).body;
  assert.equal(rep.committedPoints, 8); assert.equal(rep.completedPoints, 5);
  assert.deepEqual(rep.burndown.map((d) => d.remainingPoints), [8, 3, 3]);
  // notifications for bob (assignee, watcher)
  const n = (await call('GET', '/api/notifications?unread=true', undefined, b)).body;
  assert.equal(n[0].type, 'status_changed');
  await call('POST', `/api/issues/${i1.key}/comments`, { body: 'hi @alice' }, b);
  assert.ok((await call('GET', '/api/notifications', undefined, a)).body.some((x) => x.type === 'mentioned'));
  // complete sprint
  const c = await call('POST', `/api/sprints/${sp.id}/complete`, { carryOverTo: 'backlog' }, a);
  assert.equal(c.body.state, 'completed');
  // search
  const s = (await call('GET', '/api/search?q=' + encodeURIComponent('type:bug -label:wontfix assignee:bob one'), undefined, a)).body;
  assert.equal(s.length, 1);
  assert.equal((await call('GET', '/api/search?q=' + encodeURIComponent('status:"oops'), undefined, a)).status, 400);
  assert.equal((await call('GET', '/api/search?q=' + encodeURIComponent('points:>3 is:resolved'), undefined, a)).body.length, 1);
  // csv roundtrip
  const csv = (await call('GET', `/api/projects/${pr.id}/export.csv`, undefined, a)).body;
  assert.ok(csv.startsWith('key,type,title,status,priority,assignee,labels,storyPoints,parent,epic,sprint,dueDate,createdAt,resolvedAt\r\n'));
  const imp = await call('POST', `/api/projects/${pr.id}/import.csv`, 'title,type,status\n"a, ""q""",bug,Todo\nbad,nope,Todo\n', a, true);
  assert.equal(imp.body.created, 1); assert.equal(imp.body.errors[0].line, 3);
  // workflow remap
  const wf = { statuses: [{ name: 'New', category: 'unstarted' }, { name: 'Done', category: 'completed' }], transitions: [['New', 'Done']] };
  assert.equal((await call('PUT', `/api/projects/${pr.id}/workflow`, wf, a)).status, 400);
  assert.equal((await call('PUT', `/api/projects/${pr.id}/workflow`, { ...wf, remap: { Todo: 'New' } }, a)).status, 200);
  assert.equal((await call('GET', `/api/workspaces/${ws.id}/audit`, undefined, a)).body[0].type, 'workflow.updated');
  // subtask cascade
  const parent = (await mk({ title: 'p' })).body;
  await mk({ title: 'c', type: 'subtask', parentId: parent.key });
  assert.equal((await call('GET', `/api/issues/${parent.key}`, undefined, a)).body.children.length, 1);
  await call('DELETE', `/api/issues/${parent.key}`, undefined, a);
  assert.equal((await call('GET', `/api/projects/${pr.id}/issues`, undefined, a)).body.some((x) => x.title === 'c'), false);
  srv.close();
});

test('webhook delivery with retries and signature; tokens; rate limit', async () => {
  const { srv, call, user } = await setup();
  const a = await user('alice');
  const got = [];
  let n = 0;
  const hook = http.createServer((req, res) => { let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => { got.push({ d, sig: req.headers['x-pm-signature'] }); res.statusCode = ++n < 2 ? 500 : 200; res.end(); }); });
  await new Promise((r) => hook.listen(0, r));
  const ws = (await call('POST', '/api/workspaces', { name: 'A', key: 'AC' }, a)).body;
  const pr = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'W', key: 'WEB' }, a)).body;
  const wh = (await call('POST', `/api/projects/${pr.id}/webhooks`, { url: `http://127.0.0.1:${hook.address().port}/`, events: ['issue.created'], secret: 's3' }, a)).body;
  await call('POST', `/api/projects/${pr.id}/issues`, { title: 'x' }, a);
  await new Promise((r) => setTimeout(r, 500));
  const d = (await call('GET', `/api/webhooks/${wh.id}/deliveries`, undefined, a)).body;
  assert.equal(d[0].attempts, 2); assert.equal(d[0].status, 'delivered');
  assert.equal(got[1].sig, 'sha256=' + crypto.createHmac('sha256', 's3').update(got[1].d).digest('hex'));
  const tk = (await call('POST', '/api/tokens', { name: 't' }, a)).body;
  assert.equal((await call('GET', '/api/auth/me', undefined, tk.token)).status, 200);
  assert.equal((await call('GET', '/api/tokens', undefined, a)).body[0].token, undefined);
  for (let i = 0; i < 5; i++) await call('POST', '/api/auth/login', { username: 'alice', password: 'wrongwrong' });
  assert.equal((await call('POST', '/api/auth/login', { username: 'alice', password: 'wrongwrong' })).status, 429);
  assert.equal((await call('GET', '/')).status, 200);
  hook.close(); srv.close();
});
