import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createServer } from '../src/server.js';

async function setup(clock) {
  const srv = createServer({ clock }); await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, b, t, raw) => { const r = await fetch(base + p, { method: m, headers: { ...(raw ? { 'content-type': 'text/csv' } : { 'content-type': 'application/json' }), ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b == null ? undefined : raw ? b : JSON.stringify(b) }); const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch { body = text; } return { status: r.status, body }; };
  const user = async n => { await call('POST', '/api/auth/register', { username: n, password: 'password123' }); return (await call('POST', '/api/auth/login', { username: n, password: 'password123' })).body.token; };
  return { srv, call, user };
}

test('full flow', async () => {
  let t = new Date('2024-01-01T10:00:00Z');
  const { srv, call, user } = await setup(() => t);
  const a = await user('alice'), b = await user('bob'), g = await user('gus');
  const ws = (await call('POST', '/api/workspaces', { name: 'A', key: 'ACME' }, a)).body;
  await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'bob', role: 'member' }, a);
  await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'gus', role: 'guest' }, a);
  const p = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'W', key: 'WEB' }, a)).body;
  assert.equal((await call('GET', `/api/projects/${p.id}`, null, g)).status, 403);
  assert.equal((await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'X', key: 'XX' }, g)).status, 403);
  const e = (await call('POST', `/api/projects/${p.id}/issues`, { type: 'epic', title: 'E' }, a)).body;
  const i1 = (await call('POST', `/api/projects/${p.id}/issues`, { title: 'one', storyPoints: 3, epicId: e.id, assigneeId: undefined }, a)).body;
  const i2 = (await call('POST', `/api/projects/${p.id}/issues`, { title: 'two @bob', storyPoints: 2, type: 'bug', labels: ['x'] }, a)).body;
  assert.equal(i2.key, 'WEB-3');
  assert.equal(i1.status, 'Todo');
  const sub = await call('POST', `/api/projects/${p.id}/issues`, { title: 's', type: 'subtask', parentId: i1.id }, a);
  assert.equal(sub.status, 201);
  assert.equal((await call('POST', `/api/projects/${p.id}/issues`, { title: 's', type: 'subtask' }, a)).status, 400);
  // links / blocked
  await call('POST', `/api/issues/${i1.key}/links`, { type: 'blocks', target: i2.key }, a);
  const gi2 = (await call('GET', `/api/issues/${i2.key}`, null, a)).body;
  assert.equal(gi2.links[0].type, 'blocked_by');
  assert.equal((await call('PATCH', `/api/issues/${i2.key}`, { status: 'Done' }, a)).body.error, 'blocked');
  // sprint
  const sp = (await call('POST', `/api/projects/${p.id}/sprints`, { name: 'S1', startDate: '2024-01-01', endDate: '2024-01-14' }, a)).body;
  await call('PATCH', `/api/issues/${i1.key}`, { sprintId: sp.id }, a);
  await call('PATCH', `/api/issues/${i2.key}`, { sprintId: sp.id }, a);
  assert.equal((await call('POST', `/api/sprints/${sp.id}/start`, {}, a)).status, 200);
  assert.equal((await call('POST', `/api/sprints/${sp.id}/start`, {}, a)).status, 409);
  t = new Date('2024-01-03T10:00:00Z');
  const r = await call('PATCH', `/api/issues/${i1.key}`, { status: 'Done' }, a);
  assert.ok(r.body.resolvedAt);
  const rep = (await call('GET', `/api/sprints/${sp.id}/report`, null, a)).body;
  assert.equal(rep.committedPoints, 5); assert.equal(rep.completedPoints, 3);
  assert.deepEqual(rep.burndown.map(x => x.remainingPoints), [5, 5, 2]);
  // notifications
  const n = (await call('GET', '/api/notifications?unread=true', null, b)).body;
  assert.equal(n.length, 0); // mention was before bob could...
  const ge = (await call('GET', `/api/issues/${e.key}`, null, a)).body;
  assert.deepEqual(ge.progress, { total: 1, done: 1, points_total: 3, points_done: 3 });
  // search
  const s1 = (await call('GET', '/api/search?q=' + encodeURIComponent('type:bug -label:nope two'), null, a)).body;
  assert.equal(s1.length, 1);
  assert.equal((await call('GET', '/api/search?q=' + encodeURIComponent('status:"unterminated'), null, a)).status, 400);
  // csv
  const csv = (await call('GET', `/api/projects/${p.id}/export.csv`, null, a)).body;
  assert.ok(csv.startsWith('key,type,title,status'));
  const imp = (await call('POST', `/api/projects/${p.id}/import.csv`, 'key,type,title,status,priority\n,task,"hello, world",Todo,high\n,bogus,x,Todo,high\n', a, true)).body;
  assert.equal(imp.created, 1); assert.equal(imp.errors[0].line, 3);
  // workflow remap
  assert.equal((await call('PUT', `/api/projects/${p.id}/workflow`, { statuses: [{ name: 'Open', category: 'unstarted' }, { name: 'Closed', category: 'completed' }], transitions: [['Open', 'Closed']] }, a)).status, 400);
  assert.equal((await call('PUT', `/api/projects/${p.id}/workflow`, { statuses: [{ name: 'Open', category: 'unstarted' }, { name: 'Closed', category: 'completed' }], transitions: [['Open', 'Closed']], remap: { Todo: 'Open', Done: 'Closed' } }, a)).status, 200);
  assert.equal((await call('PATCH', `/api/issues/${i2.key}`, { status: 'Open' }, a)).status, 200);
  const aud = await call('GET', `/api/workspaces/${ws.id}/audit`, null, a);
  assert.ok(aud.body.some(x => x.action === 'workflow.updated'));
  srv.close();
});

test('rate limit and tokens', async () => {
  const { srv, call, user } = await setup();
  const a = await user('alice');
  for (let k = 0; k < 5; k++) assert.equal((await call('POST', '/api/auth/login', { username: 'alice', password: 'nope' })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { username: 'alice', password: 'password123' })).status, 429);
  const tk = (await call('POST', '/api/tokens', { name: 'ci' }, a)).body;
  assert.equal((await call('GET', '/api/auth/me', null, tk.token)).status, 200);
  assert.equal((await call('GET', '/api/tokens', null, a)).body[0].token, undefined);
  srv.close();
});

test('webhooks signed with retries', async () => {
  const { srv, call, user } = await setup();
  const a = await user('alice');
  const got = []; let n = 0;
  const rx = http.createServer((req, res) => { let d = ''; req.on('data', c => d += c); req.on('end', () => { got.push({ d, sig: req.headers['x-pm-signature'] }); res.statusCode = ++n < 2 ? 500 : 200; res.end(); }); });
  await new Promise(r => rx.listen(0, r));
  const ws = (await call('POST', '/api/workspaces', { name: 'A', key: 'ACME' }, a)).body;
  const p = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'W', key: 'WEB' }, a)).body;
  const wh = (await call('POST', `/api/projects/${p.id}/webhooks`, { url: `http://127.0.0.1:${rx.address().port}/`, events: ['issue.created'], secret: 's3' }, a)).body;
  await call('POST', `/api/projects/${p.id}/issues`, { title: 'x' }, a);
  await new Promise(r => setTimeout(r, 400));
  const d = (await call('GET', `/api/webhooks/${wh.id}/deliveries`, null, a)).body;
  assert.equal(d[0].status, 200); assert.equal(d[0].attempts, 2);
  assert.equal(got[0].sig, 'sha256=' + crypto.createHmac('sha256', 's3').update(got[0].d).digest('hex'));
  rx.close(); srv.close();
});
