import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../src/server.js';

async function setup(clock) {
  const srv = createServer({ clock }); await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, b, t, raw) => {
    const r = await fetch(base + p, { method: m, headers: { ...(raw ? { 'content-type': 'text/csv' } : { 'content-type': 'application/json' }), ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b === undefined ? undefined : raw ? b : JSON.stringify(b) });
    const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body };
  };
  const user = async name => { await call('POST', '/api/auth/register', { username: name, password: 'password123' }); return (await call('POST', '/api/auth/login', { username: name, password: 'password123' })).body.token; };
  return { srv, call, user };
}

test('full flow', async () => {
  let now = new Date('2025-01-01T10:00:00Z');
  const { srv, call, user } = await setup(() => now);
  const a = await user('alice'), b = await user('bob'), g = await user('gina');
  const ws = (await call('POST', '/api/workspaces', { name: 'Acme', key: 'ACME' }, a)).body;
  assert.equal((await call('POST', '/api/workspaces', { name: 'X', key: 'ACME' }, a)).status, 409);
  await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'bob', role: 'member' }, a);
  await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'gina', role: 'guest' }, a);
  const me = (await call('GET', '/api/auth/me', undefined, a)).body.user;
  assert.equal((await call('DELETE', `/api/workspaces/${ws.id}/members/${me.id}`, undefined, a)).status, 400);
  const pr = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Web', key: 'WEB' }, a)).body;
  assert.equal((await call('GET', `/api/projects/${pr.id}`, undefined, g)).status, 403);
  assert.equal((await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Z', key: 'ZZ' }, g)).status, 403);
  const mk = async (o, t = a) => (await call('POST', `/api/projects/${pr.id}/issues`, o, t));
  const epic = (await mk({ type: 'epic', title: 'E' })).body;
  const i1 = (await mk({ title: 'One', storyPoints: 5, epicId: epic.key, assigneeId: 'bob' })).body;
  assert.equal(i1.key, 'WEB-2'); assert.equal(i1.status, 'Todo');
  assert.equal((await mk({ type: 'subtask', title: 's' })).status, 400);
  const sub = (await mk({ type: 'subtask', title: 's', parentId: i1.key })).body;
  assert.equal((await call('GET', `/api/issues/${i1.key}`, undefined, a)).body.children[0], sub.key);
  // notifications for bob
  const nots = (await call('GET', '/api/notifications?unread=true', undefined, b)).body;
  assert.equal(nots[0].type, 'assignment');
  // sprint
  const sp = (await call('POST', `/api/projects/${pr.id}/sprints`, { name: 'S1', startDate: '2025-01-01', endDate: '2025-01-05' }, a)).body;
  await call('PATCH', `/api/issues/${i1.key}`, { sprintId: sp.id }, a);
  assert.equal((await call('POST', `/api/sprints/${sp.id}/start`, undefined, a)).body.state, 'active');
  now = new Date('2025-01-03T10:00:00Z');
  // blocked
  const i3 = (await mk({ title: 'Blocker' })).body;
  assert.equal((await call('POST', `/api/issues/${i3.key}/links`, { type: 'blocks', target: i1.key }, a)).status, 201);
  assert.equal((await call('GET', `/api/issues/${i1.key}`, undefined, a)).body.links[0].type, 'blocked_by');
  const r = await call('PATCH', `/api/issues/${i1.key}`, { status: 'Done' }, a);
  assert.equal(r.status, 409); assert.equal(r.body.error, 'blocked');
  await call('PATCH', `/api/issues/${i3.key}`, { status: 'Done' }, a);
  const d = await call('PATCH', `/api/issues/${i1.key}`, { status: 'Done' }, a);
  assert.equal(d.status, 200); assert.ok(d.body.resolvedAt);
  assert.equal((await call('GET', `/api/issues/${epic.key}`, undefined, a)).body.progress.done, 1);
  const rep = (await call('GET', `/api/sprints/${sp.id}/report`, undefined, a)).body;
  assert.equal(rep.committedPoints, 5); assert.equal(rep.completedPoints, 5);
  assert.deepEqual(rep.burndown.map(x => x.remainingPoints), [5, 5, 0]);
  // search
  const s1 = (await call('GET', '/api/search?q=' + encodeURIComponent('is:resolved assignee:bob -label:x'), undefined, a)).body;
  assert.deepEqual(s1.map(i => i.key), [i1.key]);
  assert.equal((await call('GET', '/api/search?q=' + encodeURIComponent('status:"oops'), undefined, a)).status, 400);
  assert.equal((await call('GET', '/api/search?q=' + encodeURIComponent('points:>3 due:<2030-01-01'), undefined, a)).status, 200);
  // history
  const h = (await call('GET', `/api/issues/${i1.key}/history`, undefined, a)).body;
  assert.ok(h.some(x => x.field === 'status' && x.to === 'Done'));
  // workflow remap
  const wf = { statuses: [{ name: 'Open', category: 'unstarted' }, { name: 'Closed', category: 'completed' }], transitions: [['Open', 'Closed']] };
  assert.equal((await call('PUT', `/api/projects/${pr.id}/workflow`, wf, a)).status, 400);
  assert.equal((await call('PUT', `/api/projects/${pr.id}/workflow`, { ...wf, remap: { Todo: 'Open', Done: 'Closed' } }, a)).status, 200);
  assert.equal((await call('GET', `/api/issues/${i1.key}`, undefined, a)).body.status, 'Closed');
  assert.equal((await call('PATCH', `/api/issues/${i1.key}`, { status: 'Open' }, a)).body.error, 'invalid_transition');
  // csv
  const csv = (await call('GET', `/api/projects/${pr.id}/export.csv`, undefined, a)).body;
  assert.ok(csv.startsWith('key,type,title,status,priority,assignee,labels,storyPoints,parent,epic,sprint,dueDate,createdAt,resolvedAt\r\n'));
  const imp = (await call('POST', `/api/projects/${pr.id}/import.csv`, 'key,type,title,status\n,task,"Hello, ""w""",Open\n,task,,Open\n,bug,Bad status,Nope\n', a, true)).body;
  assert.equal(imp.created, 1); assert.deepEqual(imp.errors.map(e => e.line), [3, 4]);
  // audit
  const au = await call('GET', `/api/workspaces/${ws.id}/audit`, undefined, a);
  assert.ok(au.body.some(x => x.action === 'workflow.updated'));
  assert.equal((await call('GET', `/api/workspaces/${ws.id}/audit`, undefined, b)).status, 403);
  // stats
  assert.equal((await call('GET', `/api/projects/${pr.id}/stats`, undefined, a)).status, 200);
  srv.close();
});

test('login rate limit and tokens', async () => {
  const { srv, call, user } = await setup();
  const t = await user('carol');
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/auth/login', { username: 'carol', password: 'nope' })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { username: 'carol', password: 'password123' })).status, 429);
  const tk = (await call('POST', '/api/tokens', { name: 'ci' }, t)).body;
  assert.equal((await call('GET', '/api/auth/me', undefined, tk.token)).status, 200);
  assert.equal((await call('GET', '/api/tokens', undefined, t)).body[0].token, undefined);
  assert.equal((await call('GET', '/api/auth/me')).status, 401);
  srv.close();
});

test('webhooks signed with retries', async () => {
  const got = [];
  let n = 0;
  const recv = http.createServer((req, res) => { let d = ''; req.on('data', c => d += c); req.on('end', () => { got.push({ sig: req.headers['x-pm-signature'], d }); res.statusCode = ++n < 2 ? 500 : 200; res.end(); }); });
  await new Promise(r => recv.listen(0, r));
  const { srv, call, user } = await setup();
  const a = await user('dan');
  const ws = (await call('POST', '/api/workspaces', { name: 'A', key: 'AA' }, a)).body;
  const pr = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'W', key: 'WW' }, a)).body;
  const wh = (await call('POST', `/api/projects/${pr.id}/webhooks`, { url: `http://127.0.0.1:${recv.address().port}/`, events: ['issue.created'], secret: 's3' }, a)).body;
  await call('POST', `/api/projects/${pr.id}/issues`, { title: 'x' }, a);
  for (let i = 0; i < 50 && got.length < 2; i++) await new Promise(r => setTimeout(r, 50));
  await new Promise(r => setTimeout(r, 50));
  const dl = (await call('GET', `/api/webhooks/${wh.id}/deliveries`, undefined, a)).body;
  assert.equal(dl[0].status, 200); assert.equal(dl[0].attempts, 2);
  const { createHmac } = await import('node:crypto');
  assert.equal(got[0].sig, 'sha256=' + createHmac('sha256', 's3').update(got[0].d).digest('hex'));
  srv.close(); recv.close();
});

test('UI served', async () => {
  const { srv } = await setup();
  const base = `http://127.0.0.1:${srv.address().port}`;
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/static/app.js')).status, 200);
  assert.equal((await fetch(base + '/static/../server.js')).status, 404);
  srv.close();
});
