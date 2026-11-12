import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createServer } from '../src/server.js';

async function setup(clock) {
  const srv = createServer({ clock }); await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, b, t, raw) => { const r = await fetch(base + p, { method: m, headers: { ...(raw ? { 'content-type': 'text/csv' } : { 'content-type': 'application/json' }), ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: raw ?? (b && JSON.stringify(b)) }); const text = await r.text(); let body = null; try { body = JSON.parse(text); } catch { body = text; } return { status: r.status, body }; };
  const user = async (name) => { await call('POST', '/api/auth/register', { username: name, password: 'password123' }); return (await call('POST', '/api/auth/login', { username: name, password: 'password123' })).body.token; };
  return { srv, call, user };
}

test('full flow: workflow, links, notifications, search, csv', async () => {
  const { srv, call, user } = await setup();
  const a = await user('alice'), b = await user('bob'), g = await user('gus');
  const ws = (await call('POST', '/api/workspaces', { name: 'Acme', key: 'ACME' }, a)).body;
  assert.equal((await call('POST', '/api/workspaces', { name: 'x', key: 'acme' }, a)).status, 400);
  await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'bob', role: 'member' }, a);
  await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'gus', role: 'guest' }, a);
  const pr = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Web', key: 'WEB' }, a)).body;
  assert.equal((await call('GET', `/api/projects/${pr.id}`, null, g)).status, 403);
  assert.equal((await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'N', key: 'NN' }, g)).status, 403);
  const i1 = (await call('POST', `/api/projects/${pr.id}/issues`, { type: 'task', title: 'First bug', priority: 'high', storyPoints: 3, labels: ['x'], assigneeId: null }, a)).body;
  const i2 = (await call('POST', `/api/projects/${pr.id}/issues`, { type: 'bug', title: 'Second', labels: ['wontfix'] }, a)).body;
  assert.equal(i2.key, 'WEB-2'); assert.equal(i1.status, 'Todo');
  await call('POST', `/api/issues/WEB-1/links`, { type: 'blocks', target: 'WEB-2' }, a);
  const t = (await call('GET', '/api/issues/WEB-2', null, a)).body;
  assert.equal(t.links[0].type, 'blocked_by');
  assert.equal((await call('PATCH', '/api/issues/WEB-2', { status: 'Done' }, a)).body.error, 'blocked');
  assert.equal((await call('PATCH', '/api/issues/WEB-1', { status: 'Done' }, a)).body.resolvedAt != null, true);
  assert.equal((await call('PATCH', '/api/issues/WEB-2', { status: 'Done' }, a)).status, 200);
  const h = (await call('GET', '/api/issues/WEB-1/history', null, a)).body;
  assert.equal(h[0].field, 'status');
  // subtasks
  assert.equal((await call('POST', `/api/projects/${pr.id}/issues`, { type: 'subtask', title: 's' }, a)).status, 400);
  const st = await call('POST', `/api/projects/${pr.id}/issues`, { type: 'subtask', title: 's', parentId: i1.id }, a);
  assert.equal(st.status, 201);
  assert.deepEqual((await call('GET', '/api/issues/WEB-1', null, a)).body.children, ['WEB-3']);
  // comments + mentions
  await call('POST', '/api/issues/WEB-1/comments', { body: 'hi @bob' }, a);
  const n = (await call('GET', '/api/notifications?unread=true', null, b)).body;
  assert.equal(n[0].type, 'mention');
  // search
  const s1 = (await call('GET', '/api/search?q=' + encodeURIComponent('-label:wontfix type:task "first bug"'), null, a)).body;
  assert.deepEqual(s1.map((i) => i.key), ['WEB-1']);
  assert.equal((await call('GET', '/api/search?q=' + encodeURIComponent('status:"unterminated'), null, a)).status, 400);
  assert.equal((await call('GET', '/api/search?q=points:>2', null, a)).body.length, 1);
  // csv
  const csv = (await call('GET', `/api/projects/${pr.id}/export.csv`, null, a)).body;
  assert.ok(csv.startsWith('key,type,title,status,priority,assignee,labels,storyPoints,parent,epic,sprint,dueDate,createdAt,resolvedAt'));
  const imp = await call('POST', `/api/projects/${pr.id}/import.csv`, null, a, 'key,type,title,status,priority\nX,task,"Hello, ""w""",Todo,high\nX,bogus,T,Todo,high\n');
  assert.equal(imp.body.created, 1); assert.equal(imp.body.errors[0].line, 3);
  // workflow remap
  const wf = { statuses: [{ name: 'New', category: 'unstarted' }, { name: 'Closed', category: 'completed' }], transitions: [['New', 'Closed']] };
  assert.equal((await call('PUT', `/api/projects/${pr.id}/workflow`, wf, a)).status, 400);
  assert.equal((await call('PUT', `/api/projects/${pr.id}/workflow`, { ...wf, remap: { Todo: 'New', Done: 'Closed' } }, a)).status, 200);
  assert.equal((await call('GET', '/api/issues/WEB-1', null, a)).body.status, 'Closed');
  assert.equal((await call('PATCH', '/api/issues/WEB-1', { status: 'New' }, a)).body.error, 'invalid_transition');
  assert.ok((await call('GET', `/api/workspaces/${ws.id}/audit`, null, a)).body.some((x) => x.action === 'workflow.updated'));
  srv.close();
});

test('login rate limit and api tokens', async () => {
  const { srv, call, user } = await setup();
  const a = await user('carol');
  const tk = (await call('POST', '/api/tokens', { name: 'ci' }, a)).body;
  assert.equal((await call('GET', '/api/auth/me', null, tk.token)).status, 200);
  assert.equal(JSON.stringify((await call('GET', '/api/tokens', null, a)).body).includes(tk.token), false);
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/auth/login', { username: 'carol', password: 'nope' })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { username: 'carol', password: 'password123' })).status, 429);
  srv.close();
});

test('sprints, burndown, webhooks', async () => {
  let t = new Date('2025-01-01T10:00:00Z');
  const { srv, call, user } = await setup(() => t);
  const received = []; const rx = http.createServer((q, s) => { let d = ''; q.on('data', (c) => d += c); q.on('end', () => { received.push({ sig: q.headers['x-pm-signature'], d }); s.end('ok'); }); });
  await new Promise((r) => rx.listen(0, r));
  const a = await user('dan');
  const ws = (await call('POST', '/api/workspaces', { name: 'A', key: 'AA' }, a)).body;
  const pr = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'P', key: 'PP' }, a)).body;
  const wh = (await call('POST', `/api/projects/${pr.id}/webhooks`, { url: `http://127.0.0.1:${rx.address().port}/`, events: ['issue.created'], secret: 's3' }, a)).body;
  const sp = (await call('POST', `/api/projects/${pr.id}/sprints`, { name: 'S1', endDate: '2025-01-10' }, a)).body;
  await call('POST', `/api/projects/${pr.id}/issues`, { title: 'a', storyPoints: 5, sprintId: sp.id }, a);
  await call('POST', `/api/projects/${pr.id}/issues`, { title: 'b', storyPoints: 3, sprintId: sp.id }, a);
  assert.equal((await call('POST', `/api/sprints/${sp.id}/start`, null, a)).body.state, 'active');
  t = new Date('2025-01-02T10:00:00Z');
  await call('PATCH', '/api/issues/PP-1', { status: 'Done' }, a);
  t = new Date('2025-01-03T10:00:00Z');
  const rep = (await call('GET', `/api/sprints/${sp.id}/report`, null, a)).body;
  assert.equal(rep.committedPoints, 8);
  assert.deepEqual(rep.burndown.map((x) => x.remainingPoints), [8, 3, 3]);
  const done = (await call('POST', `/api/sprints/${sp.id}/complete`, { carryOverTo: 'backlog' }, a)).body;
  assert.equal(done.state, 'completed');
  const rep2 = (await call('GET', `/api/sprints/${sp.id}/report`, null, a)).body;
  assert.equal(rep2.completedPoints, 5); assert.equal(rep2.carriedOver, 1);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(received.length, 2);
  assert.equal(received[0].sig, 'sha256=' + crypto.createHmac('sha256', 's3').update(received[0].d).digest('hex'));
  const dl = (await call('GET', `/api/webhooks/${wh.id}/deliveries`, null, a)).body;
  assert.equal(dl[0].status, 200);
  srv.close(); rx.close();
});

test('serves SPA', async () => {
  const { srv } = await setup(); const base = `http://127.0.0.1:${srv.address().port}`;
  assert.match(await (await fetch(base + '/')).text(), /<html/i);
  assert.equal((await fetch(base + '/static/app.js')).status, 200);
  srv.close();
});
