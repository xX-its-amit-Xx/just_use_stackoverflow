import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createServer } from '../src/server.js';

async function setup(clock) {
  const srv = createServer({ clock }); await new Promise(r => srv.listen(0, r)); const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, b, t, raw) => { const r = await fetch(base + p, { method: m, headers: { ...(raw ? { 'content-type': 'text/csv' } : { 'content-type': 'application/json' }), ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: raw ? b : b && JSON.stringify(b) }); const txt = await r.text(); let body; try { body = JSON.parse(txt); } catch { body = txt; } return { status: r.status, body }; };
  const user = async (name) => { await call('POST', '/api/auth/register', { username: name, password: 'password123' }); return (await call('POST', '/api/auth/login', { username: name, password: 'password123' })).body.token; };
  return { srv, call, user };
}

test('full flow', async () => {
  let t = new Date('2024-01-01T10:00:00Z');
  const { srv, call, user } = await setup(() => t);
  const a = await user('alice'), b = await user('bob');
  const ws = (await call('POST', '/api/workspaces', { name: 'A', key: 'ACME' }, a)).body;
  assert.equal((await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'bob', role: 'member' }, a)).status, 201);
  const p = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'W', key: 'WEB' }, a)).body;
  const mk = async (o) => (await call('POST', `/api/projects/${p.id}/issues`, o, a)).body;
  const i1 = await mk({ title: 'one @bob', type: 'bug', storyPoints: 5, labels: ['x'] });
  const i2 = await mk({ title: 'two', storyPoints: 3 });
  assert.equal(i2.key, 'WEB-2'); assert.equal(i1.status, 'Todo');
  // links / blocked
  assert.equal((await call('POST', '/api/issues/WEB-1/links', { type: 'blocks', target: 'WEB-2' }, a)).status, 201);
  assert.equal((await call('GET', '/api/issues/WEB-2', null, a)).body.links[0].type, 'blocked_by');
  const r = await call('PATCH', '/api/issues/WEB-2', { status: 'Done' }, a);
  assert.equal(r.status, 409); assert.equal(r.body.error, 'blocked');
  // sprint + burndown
  const sp = (await call('POST', `/api/projects/${p.id}/sprints`, { name: 'S1', startDate: '2024-01-01', endDate: '2024-01-05' }, a)).body;
  await call('PATCH', '/api/issues/WEB-1', { sprintId: sp.id }, a);
  await call('PATCH', '/api/issues/WEB-2', { sprintId: sp.id }, a);
  assert.equal((await call('POST', `/api/sprints/${sp.id}/start`, null, a)).status, 200);
  t = new Date('2024-01-02T10:00:00Z');
  await call('PATCH', '/api/issues/WEB-1', { status: 'Done' }, a);
  t = new Date('2024-01-03T10:00:00Z');
  const rep = (await call('GET', `/api/sprints/${sp.id}/report`, null, a)).body;
  assert.equal(rep.committedPoints, 8); assert.equal(rep.completedPoints, 5);
  assert.deepEqual(rep.burndown.map(x => x.remainingPoints), [8, 3, 3]);
  // notifications
  await call('POST', '/api/issues/WEB-1/comments', { body: 'hi @bob' }, a);
  const n = (await call('GET', '/api/notifications?unread=true', null, b)).body;
  assert.ok(n.length >= 1);
  // search
  const s = await call('GET', '/api/search?q=' + encodeURIComponent('type:bug -label:wontfix is:resolved'), null, a);
  assert.deepEqual(s.body.map(x => x.key), ['WEB-1']);
  assert.equal((await call('GET', '/api/search?q=' + encodeURIComponent('status:"oops'), null, a)).status, 400);
  // csv
  const csv = await call('GET', `/api/projects/${p.id}/export.csv`, null, a);
  assert.ok(csv.body.startsWith('key,type,title'));
  const imp = await call('POST', `/api/projects/${p.id}/import.csv`, 'key,type,title,status,priority\n,task,"Hi, there",Todo,high\n,task,,Todo,high\n,bogus,x,Todo,high\n', a, true);
  assert.equal(imp.body.created, 1); assert.equal(imp.body.errors.length, 2); assert.equal(imp.body.errors[0].line, 3);
  // workflow remap
  const w = await call('PUT', `/api/projects/${p.id}/workflow`, { statuses: [{ name: 'Open', category: 'unstarted' }, { name: 'Closed', category: 'completed' }], transitions: [['Open', 'Closed']] }, a);
  assert.equal(w.status, 400);
  const w2 = await call('PUT', `/api/projects/${p.id}/workflow`, { statuses: [{ name: 'Open', category: 'unstarted' }, { name: 'Closed', category: 'completed' }], transitions: [['Open', 'Closed']], remap: { Todo: 'Open', Done: 'Closed', Backlog: 'Open', 'In Progress': 'Open', 'In Review': 'Open' } }, a);
  assert.equal(w2.status, 200);
  assert.equal((await call('GET', `/api/workspaces/${ws.id}/audit`, null, a)).status, 200);
  assert.equal((await call('GET', `/api/workspaces/${ws.id}/audit`, null, b)).status, 403);
  // tokens
  const tk = (await call('POST', '/api/tokens', { name: 'ci' }, a)).body;
  assert.equal((await call('GET', '/api/auth/me', null, tk.token)).status, 200);
  srv.close(); srv.closeAllConnections();
});

test('webhook signature + retries', async () => {
  const got = [];
  const hook = http.createServer((req, res) => { let d = ''; req.on('data', c => d += c); req.on('end', () => { got.push({ sig: req.headers['x-pm-signature'], d }); res.statusCode = got.length < 2 ? 500 : 200; res.end(); }); });
  await new Promise(r => hook.listen(0, r));
  const { srv, call, user } = await setup();
  const a = await user('alice');
  const ws = (await call('POST', '/api/workspaces', { name: 'A', key: 'ACME' }, a)).body;
  const p = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'W', key: 'WEB' }, a)).body;
  const h = (await call('POST', `/api/projects/${p.id}/webhooks`, { url: `http://127.0.0.1:${hook.address().port}/`, events: ['issue.created'], secret: 's3' }, a)).body;
  await call('POST', `/api/projects/${p.id}/issues`, { title: 'x' }, a);
  await new Promise(r => setTimeout(r, 500));
  const d = (await call('GET', `/api/webhooks/${h.id}/deliveries`, null, a)).body;
  assert.equal(d[0].attempts, 2); assert.equal(d[0].status, 'delivered');
  assert.equal(got[0].sig, 'sha256=' + crypto.createHmac('sha256', 's3').update(got[0].d).digest('hex'));
  srv.close(); srv.closeAllConnections(); hook.close();
});
