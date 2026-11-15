import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
test('features', async () => {
  let t0 = new Date('2025-01-01T10:00:00Z');
  const srv = createServer({ clock: () => t0 }); await new Promise(r => srv.listen(0, r)); const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, b, t, raw) => { const r = await fetch(base + p, { method: m, headers: { ...(raw ? {'content-type':'text/csv'} : {'content-type': 'application/json'}), ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b && (raw ? b : JSON.stringify(b)) }); const x = await r.text(); let j; try { j = JSON.parse(x); } catch { j = x; } return { status: r.status, body: j }; };
  const login = async (u) => { await call('POST', '/api/auth/register', { username: u, password: 'password123' }); return (await call('POST', '/api/auth/login', { username: u, password: 'password123' })).body.token; };
  const a = await login('alice'), b = await login('bob');
  const ws = (await call('POST', '/api/workspaces', { name: 'Acme', key: 'ACME' }, a)).body;
  assert.equal((await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'bob', role: 'member' }, a)).status, 201);
  const pr = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Web', key: 'WEB' }, a)).body;
  const mk = async (o, t = a) => (await call('POST', `/api/projects/${pr.id}/issues`, o, t));
  const i1 = (await mk({ type: 'task', title: 'one', storyPoints: 5, assigneeId: undefined })).body;
  const i2 = (await mk({ type: 'bug', title: 'two', labels: ['x'], priority: 'high' })).body;
  assert.equal(i1.status, 'Todo');
  const sp = (await call('POST', `/api/projects/${pr.id}/sprints`, { name: 'S1', startDate: '2025-01-01', endDate: '2025-01-05' }, a)).body;
  await call('PATCH', `/api/issues/${i1.key}`, { sprintId: sp.id }, a);
  assert.equal((await call('POST', `/api/sprints/${sp.id}/start`, null, a)).status, 200);
  assert.equal((await call('POST', `/api/projects/${pr.id}/sprints`, { name: 'S2' }, a)).status, 201);
  t0 = new Date('2025-01-02T10:00:00Z');
  await call('PATCH', `/api/issues/${i1.key}`, { status: 'In Progress' }, a);
  t0 = new Date('2025-01-03T10:00:00Z');
  await call('POST', `/api/issues/${i2.key}/links`, { type: 'blocks', target: i1.key }, a);
  assert.equal((await call('PATCH', `/api/issues/${i1.key}`, { status: 'Done' }, a)).body.error, 'blocked');
  assert.equal((await call('GET', `/api/issues/${i1.key}`, null, a)).body.links[0].type, 'blocked_by');
  await call('PATCH', `/api/issues/${i2.key}`, { status: 'Done' }, a);
  assert.equal((await call('PATCH', `/api/issues/${i1.key}`, { status: 'Done' }, a)).status, 200);
  const rep = (await call('GET', `/api/sprints/${sp.id}/report`, null, a)).body;
  assert.deepEqual(rep.burndown.map(x => x.remainingPoints), [5, 5, 0]);
  assert.equal(rep.completedPoints, 5);
  // search
  const q = async (s) => (await call('GET', '/api/search?q=' + encodeURIComponent(s), null, a));
  assert.deepEqual((await q('type:bug -label:wontfix label:x')).body.map(i => i.key), [i2.key]);
  assert.equal((await q('is:resolved status:"Done"')).body.length, 2);
  assert.equal((await q('points:>3')).body.length, 1);
  assert.equal((await q('status:"oops')).status, 400);
  assert.equal((await q('foo:bar')).status, 400);
  // comments/notifications
  await call('POST', `/api/issues/${i1.key}/comments`, { body: 'hi @bob' }, a);
  const n = (await call('GET', '/api/notifications?unread=true', null, b)).body;
  assert.equal(n.length, 1); assert.equal(n[0].type, 'mention');
  // csv
  const csv = (await call('GET', `/api/projects/${pr.id}/export.csv`, null, a)).body;
  assert.ok(csv.startsWith('key,type,title,status'));
  const imp = (await call('POST', `/api/projects/${pr.id}/import.csv`, 'title,type,priority\n"a, b",bug,high\nx,nope,high\n', a, true)).body;
  assert.equal(imp.created, 1); assert.equal(imp.errors[0].line, 3);
  // workflow remap
  const wf = { statuses: [{ name: 'Open', category: 'unstarted' }, { name: 'Closed', category: 'completed' }], transitions: [['Open', 'Closed'], ['Closed', 'Open']] };
  assert.equal((await call('PUT', `/api/projects/${pr.id}/workflow`, wf, a)).status, 400);
  assert.equal((await call('PUT', `/api/projects/${pr.id}/workflow`, { ...wf, remap: { Todo: 'Open', Done: 'Closed', Backlog: 'Open', 'In Progress': 'Open', 'In Review': 'Open' } }, a)).status, 200);
  assert.equal((await call('GET', `/api/projects/${pr.id}/stats`, null, a)).status, 200);
  assert.equal((await call('GET', `/api/workspaces/${ws.id}/audit`, null, a)).body.length > 0, true);
  assert.equal((await call('GET', `/api/workspaces/${ws.id}/audit`, null, b)).status, 403);
  for (let k = 0; k < 5; k++) await call('POST', '/api/auth/login', { username: 'bob', password: 'x' });
  assert.equal((await call('POST', '/api/auth/login', { username: 'bob', password: 'password123' })).status, 429);
  srv.close();
});
