import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../../src/server.js';

async function setup(clock) {
  const srv = createServer({ clock }); await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, b, t) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b && JSON.stringify(b) }); const txt = await r.text(); let body = null; try { body = JSON.parse(txt); } catch { body = txt; } return { status: r.status, body }; };
  const user = async n => { await call('POST', '/api/auth/register', { username: n, password: 'password123' }); return (await call('POST', '/api/auth/login', { username: n, password: 'password123' })).body.token; };
  return { srv, call, user };
}

test('full flow', async () => {
  let t = new Date('2025-01-01T10:00:00Z');
  const { srv, call, user } = await setup(() => t);
  const a = await user('alice'), b = await user('bob');
  const ws = (await call('POST', '/api/workspaces', { name: 'A', key: 'ACME' }, a)).body;
  assert.equal((await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'bob', role: 'member' }, a)).status, 201);
  const pr = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Web', key: 'WEB' }, a)).body;
  const i1 = (await call('POST', `/api/projects/${pr.id}/issues`, { type: 'task', title: 'one', storyPoints: 5, assigneeId: undefined }, a)).body;
  const i2 = (await call('POST', `/api/projects/${pr.id}/issues`, { type: 'bug', title: 'two Crash', labels: ['x'], priority: 'high' }, a)).body;
  assert.equal(i1.status, 'Todo');
  // links / blocked
  assert.equal((await call('POST', `/api/issues/${i1.key}/links`, { type: 'blocks', target: i2.key }, a)).status, 201);
  assert.equal((await call('GET', `/api/issues/${i2.key}`, null, a)).body.links[0].type, 'blocked_by');
  const r = await call('PATCH', `/api/issues/${i2.key}`, { status: 'Done' }, a);
  assert.equal(r.status, 409); assert.equal(r.body.error, 'blocked');
  // sprint
  const sp = (await call('POST', `/api/projects/${pr.id}/sprints`, { name: 'S1', endDate: '2025-01-05' }, a)).body;
  await call('PATCH', `/api/issues/${i1.key}`, { sprintId: sp.id }, a);
  await call('POST', `/api/sprints/${sp.id}/start`, null, a);
  t = new Date('2025-01-03T10:00:00Z');
  await call('PATCH', `/api/issues/${i1.key}`, { status: 'Done' }, a);
  const rep = (await call('GET', `/api/sprints/${sp.id}/report`, null, a)).body;
  assert.equal(rep.committedPoints, 5); assert.equal(rep.completedPoints, 5);
  assert.deepEqual(rep.burndown.map(x => x.remainingPoints), [5, 5, 0]);
  // search
  const s = await call('GET', '/api/search?q=' + encodeURIComponent('type:bug -label:wontfix crash'), null, a);
  assert.equal(s.body.length, 1);
  assert.equal((await call('GET', '/api/search?q=' + encodeURIComponent('status:"oops'), null, a)).status, 400);
  // notifications
  await call('POST', `/api/issues/${i2.key}/watch`, null, b);
  await call('POST', `/api/issues/${i2.key}/comments`, { body: 'hi @bob' }, a);
  const n = (await call('GET', '/api/notifications?unread=true', null, b)).body;
  assert.equal(n.length, 1); assert.equal(n[0].type, 'mention');
  // csv
  const csv = (await call('GET', `/api/projects/${pr.id}/export.csv`, null, a)).body;
  assert.ok(csv.startsWith('key,type,title,status'));
  const imp = await fetch(srv.address() && `http://127.0.0.1:${srv.address().port}/api/projects/${pr.id}/import.csv`, { method: 'POST', headers: { authorization: `Bearer ${a}`, 'content-type': 'text/csv' }, body: 'key,type,title,status,priority\n,task,"a, b",Todo,high\n,bogus,x,Todo,high\n' });
  const ij = await imp.json(); assert.equal(ij.created, 1); assert.equal(ij.errors[0].line, 3);
  // workflow remap
  const w = await call('PUT', `/api/projects/${pr.id}/workflow`, { statuses: [{ name: 'Open', category: 'unstarted' }, { name: 'Closed', category: 'completed' }], transitions: [['Open', 'Closed']] }, a);
  assert.equal(w.status, 400);
  const w2 = await call('PUT', `/api/projects/${pr.id}/workflow`, { statuses: [{ name: 'Open', category: 'unstarted' }, { name: 'Closed', category: 'completed' }], transitions: [['Open', 'Closed']], remap: { Todo: 'Open', Done: 'Closed' } }, a);
  assert.equal(w2.status, 200);
  assert.equal((await call('GET', `/api/issues/${i1.key}/history`, null, a)).body.length > 0, true);
  assert.equal((await call('GET', `/api/workspaces/${ws.id}/audit`, null, a)).body.length > 0, true);
  srv.close();
});

test('webhook delivery with retries', async () => {
  const { srv, call, user } = await setup();
  let hits = 0, sig;
  const rx = http.createServer((req, res) => { hits++; sig = req.headers['x-pm-signature']; req.resume(); res.statusCode = hits < 3 ? 500 : 200; res.end(); });
  await new Promise(r => rx.listen(0, r));
  const a = await user('alice');
  const ws = (await call('POST', '/api/workspaces', { name: 'A', key: 'ACME' }, a)).body;
  const pr = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Web', key: 'WEB' }, a)).body;
  const wh = (await call('POST', `/api/projects/${pr.id}/webhooks`, { url: `http://127.0.0.1:${rx.address().port}/`, events: ['issue.created'], secret: 's' }, a)).body;
  await call('POST', `/api/projects/${pr.id}/issues`, { title: 'x' }, a);
  await new Promise(r => setTimeout(r, 600));
  const d = (await call('GET', `/api/webhooks/${wh.id}/deliveries`, null, a)).body;
  assert.equal(d[0].attempts, 3); assert.equal(d[0].status, 'success'); assert.match(sig, /^sha256=[0-9a-f]{64}$/);
  rx.close(); srv.close();
});
