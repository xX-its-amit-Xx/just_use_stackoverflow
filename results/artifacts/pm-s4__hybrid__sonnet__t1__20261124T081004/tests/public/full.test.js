import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createServer } from '../../src/server.js';

async function setup(clock) {
  const srv = createServer({ clock }); await new Promise(r => srv.listen(0, r)); const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, b, t, raw) => { const r = await fetch(base + p, { method: m, headers: { ...(raw ? {} : { 'content-type': 'application/json' }), ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b === undefined ? undefined : raw ? b : JSON.stringify(b) }); const txt = await r.text(); let body = null; try { body = JSON.parse(txt); } catch { body = txt; } return { status: r.status, body }; };
  const user = async (u) => { await call('POST', '/api/auth/register', { username: u, password: 'password123' }); return (await call('POST', '/api/auth/login', { username: u, password: 'password123' })).body.token; };
  return { srv, call, user };
}

test('full flow', async () => {
  let t = new Date('2024-01-01T10:00:00Z');
  const { srv, call, user } = await setup(() => t);
  const a = await user('alice'), b = await user('bob'), g = await user('gina');
  const ws = (await call('POST', '/api/workspaces', { name: 'A', key: 'ACME' }, a)).body;
  assert.equal((await call('POST', '/api/workspaces', { name: 'A', key: 'ACME' }, a)).status, 409);
  await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'bob', role: 'member' }, a);
  await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'gina', role: 'guest' }, a);
  const me = (await call('GET', '/api/auth/me', undefined, a)).body.user;
  assert.equal((await call('DELETE', `/api/workspaces/${ws.id}/members/${me.id}`, undefined, a)).status, 400);
  const p = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Web', key: 'WEB' }, a)).body;
  assert.equal((await call('GET', `/api/projects/${p.id}`, undefined, g)).status, 403);
  assert.equal((await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'X', key: 'XX' }, g)).status, 403);
  const i1 = (await call('POST', `/api/projects/${p.id}/issues`, { type: 'task', title: 'one', storyPoints: 3, assignee: 'bob' }, a)).body;
  assert.equal(i1.status, 'Todo'); assert.deepEqual(i1.watchers.length, 2);
  const i2 = (await call('POST', `/api/projects/${p.id}/issues`, { type: 'bug', title: 'two', storyPoints: 5, labels: ['x'] }, a)).body;
  assert.equal(i2.key, 'WEB-2');
  const ep = (await call('POST', `/api/projects/${p.id}/issues`, { type: 'epic', title: 'E' }, a)).body;
  assert.equal((await call('PATCH', `/api/issues/${i1.key}`, { epicId: ep.id }, a)).status, 200);
  assert.equal((await call('PATCH', `/api/issues/${i1.key}`, { epicId: i2.id }, a)).status, 400);
  const sub = await call('POST', `/api/projects/${p.id}/issues`, { type: 'subtask', title: 's', parentId: i1.id }, a);
  assert.equal(sub.status, 201);
  assert.equal((await call('POST', `/api/projects/${p.id}/issues`, { type: 'subtask', title: 's' }, a)).status, 400);
  assert.deepEqual((await call('GET', `/api/issues/${i1.key}`, undefined, a)).body.children, [sub.body.key]);
  // notifications
  const n = (await call('GET', '/api/notifications?unread=true', undefined, b)).body;
  assert.ok(n.length >= 1);
  // blocked
  await call('POST', `/api/issues/${i2.key}/links`, { type: 'blocks', target: i1.key }, a);
  assert.ok((await call('GET', `/api/issues/${i1.key}`, undefined, a)).body.links.some(l => l.type === 'blocked_by' && l.key === i2.key));
  let r = await call('PATCH', `/api/issues/${i1.key}`, { status: 'Done' }, a); assert.equal(r.status, 409); assert.equal(r.body.error, 'blocked');
  // sprint
  const sp = (await call('POST', `/api/projects/${p.id}/sprints`, { name: 'S1', startDate: '2024-01-01', endDate: '2024-01-05' }, a)).body;
  await call('PATCH', `/api/issues/${i1.key}`, { sprintId: sp.id }, a); await call('PATCH', `/api/issues/${i2.key}`, { sprintId: sp.id }, a);
  assert.equal((await call('POST', `/api/sprints/${sp.id}/start`, undefined, a)).status, 200);
  t = new Date('2024-01-02T10:00:00Z');
  await call('PATCH', `/api/issues/${i2.key}`, { status: 'Done' }, a);
  t = new Date('2024-01-03T10:00:00Z');
  assert.equal((await call('PATCH', `/api/issues/${i1.key}`, { status: 'Done' }, a)).status, 200);
  const rep = (await call('GET', `/api/sprints/${sp.id}/report`, undefined, a)).body;
  assert.deepEqual(rep.burndown.map(x => x.remainingPoints), [8, 3, 0]);
  assert.equal(rep.committedPoints, 8);
  // search
  const s = await call('GET', '/api/search?q=' + encodeURIComponent('type:bug -label:y is:resolved "tw"'), undefined, a);
  assert.deepEqual(s.body.map(x => x.key), ['WEB-2']);
  assert.equal((await call('GET', '/api/search?q=status:"unterminated', undefined, a)).status, 400);
  assert.equal((await call('GET', '/api/search?q=assignee:me', undefined, b)).body.length, 1);
  // csv
  const csv = await call('GET', `/api/projects/${p.id}/export.csv`, undefined, a);
  assert.ok(csv.body.startsWith('key,type,title,status,priority,assignee,labels,storyPoints,parent,epic,sprint,dueDate,createdAt,resolvedAt\r\n'));
  const imp = await call('POST', `/api/projects/${p.id}/import.csv`, 'key,type,title,priority\n,task,"hi, there",high\n,task,,high\n,nope,x,low\n', a, true);
  assert.equal(imp.body.created, 1); assert.deepEqual(imp.body.errors.map(e => e.line), [3, 4]);
  // stats, history
  assert.ok((await call('GET', `/api/projects/${p.id}/stats`, undefined, a)).body.byStatus);
  assert.ok((await call('GET', `/api/issues/${i1.key}/history`, undefined, a)).body.some(h => h.field === 'status'));
  // tokens
  const tk = (await call('POST', '/api/tokens', { name: 'ci' }, a)).body;
  assert.equal((await call('GET', '/api/auth/me', undefined, tk.token)).status, 200);
  assert.equal((await call('GET', `/api/workspaces/${ws.id}/audit`, undefined, a)).status, 200);
  assert.equal((await call('GET', `/api/workspaces/${ws.id}/audit`, undefined, b)).status, 403);
  // rate limit
  for (let k = 0; k < 5; k++) assert.equal((await call('POST', '/api/auth/login', { username: 'bob', password: 'bad' })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { username: 'bob', password: 'password123' })).status, 429);
  // workflow remap
  const wf = { statuses: [{ name: 'New', category: 'unstarted' }, { name: 'Fin', category: 'completed' }], transitions: [['New', 'Fin']] };
  assert.equal((await call('PUT', `/api/projects/${p.id}/workflow`, wf, a)).status, 400);
  assert.equal((await call('PUT', `/api/projects/${p.id}/workflow`, { ...wf, remap: { Todo: 'New', Done: 'Fin', Backlog: 'New', 'In Progress': 'New', 'In Review': 'New' } }, a)).status, 200);
  // delete
  assert.equal((await call('DELETE', `/api/issues/${i1.key}`, undefined, a)).status, 204);
  assert.equal((await call('GET', `/api/issues/${sub.body.key}`, undefined, a)).status, 404);
  srv.close();
});

test('webhooks', async () => {
  const got = [];
  const hook = http.createServer((req, res) => { let d = ''; req.on('data', c => d += c); req.on('end', () => { got.push({ d, sig: req.headers['x-pm-signature'] }); res.statusCode = got.length < 2 ? 500 : 200; res.end(); }); });
  await new Promise(r => hook.listen(0, r));
  const { srv, call, user } = await setup();
  const a = await user('alice');
  const ws = (await call('POST', '/api/workspaces', { name: 'A', key: 'ACME' }, a)).body;
  const p = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Web', key: 'WEB' }, a)).body;
  const w = (await call('POST', `/api/projects/${p.id}/webhooks`, { url: `http://127.0.0.1:${hook.address().port}/`, events: ['issue.created'], secret: 's3' }, a)).body;
  await call('POST', `/api/projects/${p.id}/issues`, { title: 'x' }, a);
  await new Promise(r => setTimeout(r, 600));
  assert.equal(got.length, 2);
  assert.equal(got[1].sig, 'sha256=' + crypto.createHmac('sha256', 's3').update(got[1].d).digest('hex'));
  const dl = (await call('GET', `/api/webhooks/${w.id}/deliveries`, undefined, a)).body;
  assert.equal(dl[0].status, 200); assert.equal(dl[0].attempts, 2);
  srv.close(); hook.close();
});
