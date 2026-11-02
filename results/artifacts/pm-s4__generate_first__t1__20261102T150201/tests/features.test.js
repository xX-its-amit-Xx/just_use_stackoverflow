import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createServer } from '../src/server.js';

async function setup(clock) {
  const srv = createServer({ clock }); await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, b, t, ct) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': ct || 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b === undefined ? undefined : (typeof b === 'string' ? b : JSON.stringify(b)) }); const text = await r.text(); let body; try { body = JSON.parse(text); } catch { body = text; } return { status: r.status, body }; };
  const user = async (name) => { await call('POST', '/api/auth/register', { username: name, password: 'password123' }); return (await call('POST', '/api/auth/login', { username: name, password: 'password123' })).body.token; };
  return { srv, call, user };
}

test('workflow, transitions, blocking, history', async () => {
  const { srv, call, user } = await setup();
  const t = await user('alice');
  const ws = (await call('POST', '/api/workspaces', { name: 'A', key: 'AC' }, t)).body;
  const p = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'W', key: 'WEB' }, t)).body;
  const a = (await call('POST', `/api/projects/${p.id}/issues`, { type: 'task', title: 'a' }, t)).body;
  const b = (await call('POST', `/api/projects/${p.id}/issues`, { type: 'bug', title: 'b', storyPoints: 3 }, t)).body;
  assert.equal(a.status, 'Todo');
  assert.equal((await call('POST', `/api/issues/${a.key}/links`, { type: 'blocks', target: b.key }, t)).status, 201);
  assert.equal((await call('GET', `/api/issues/${b.key}`, undefined, t)).body.links[0].type, 'blocked_by');
  const r = await call('PATCH', `/api/issues/${b.key}`, { status: 'Done' }, t);
  assert.equal(r.status, 409); assert.equal(r.body.error, 'blocked');
  assert.equal((await call('PATCH', `/api/issues/${a.key}`, { status: 'Done' }, t)).body.resolvedAt !== null, true);
  const ok = await call('PATCH', `/api/issues/${b.key}`, { status: 'Done' }, t);
  assert.equal(ok.status, 200);
  const h = (await call('GET', `/api/issues/${b.key}/history`, undefined, t)).body;
  assert.equal(h[0].field, 'status');
  // custom workflow
  const bad = await call('PUT', `/api/projects/${p.id}/workflow`, { statuses: [{ name: 'Open', category: 'unstarted' }, { name: 'Closed', category: 'completed' }], transitions: [['Open', 'Closed']] }, t);
  assert.equal(bad.status, 400);
  const good = await call('PUT', `/api/projects/${p.id}/workflow`, { statuses: [{ name: 'Open', category: 'unstarted' }, { name: 'Closed', category: 'completed' }], transitions: [['Open', 'Closed']], remap: { Todo: 'Open', Done: 'Closed', Backlog: 'Open', 'In Progress': 'Open', 'In Review': 'Open' } }, t);
  assert.equal(good.status, 200);
  assert.equal((await call('PATCH', `/api/issues/${b.key}`, { status: 'Open' }, t)).body.error, 'invalid_transition');
  // search
  const s = await call('GET', '/api/search?q=' + encodeURIComponent('type:bug -label:x is:resolved'), undefined, t);
  assert.equal(s.body.length, 1);
  assert.equal((await call('GET', '/api/search?q=' + encodeURIComponent('status:"oops'), undefined, t)).status, 400);
  srv.close();
});

test('rbac, subtasks, epics, notifications, csv, tokens', async () => {
  const { srv, call, user } = await setup();
  const t = await user('alice'); const g = await user('gus'); const bo = await user('bob');
  const ws = (await call('POST', '/api/workspaces', { name: 'A', key: 'AC' }, t)).body;
  assert.equal((await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'gus', role: 'guest' }, t)).status, 201);
  await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'bob', role: 'member' }, t);
  assert.equal((await call('DELETE', `/api/workspaces/${ws.id}/members/${(await call('GET', '/api/auth/me', undefined, t)).body.id}`, undefined, t)).status, 400);
  const p = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'W', key: 'WEB' }, t)).body;
  assert.equal((await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'X', key: 'XX' }, g)).status, 403);
  assert.equal((await call('GET', `/api/workspaces/${ws.id}/projects`, undefined, g)).body.length, 0);
  const epic = (await call('POST', `/api/projects/${p.id}/issues`, { type: 'epic', title: 'E' }, t)).body;
  const par = (await call('POST', `/api/projects/${p.id}/issues`, { type: 'task', title: 'P', epicId: epic.id, storyPoints: 2 }, t)).body;
  assert.equal((await call('POST', `/api/projects/${p.id}/issues`, { type: 'subtask', title: 'S' }, t)).status, 400);
  const sub = await call('POST', `/api/projects/${p.id}/issues`, { type: 'subtask', title: 'S', parentId: par.id }, t);
  assert.equal(sub.status, 201);
  assert.deepEqual((await call('GET', `/api/issues/${par.key}`, undefined, t)).body.children, [sub.body.key]);
  assert.equal((await call('GET', `/api/issues/${epic.key}`, undefined, t)).body.progress.points_total, 2);
  // notifications
  await call('POST', `/api/issues/${par.key}/watch`, undefined, bo);
  await call('POST', `/api/issues/${par.key}/comments`, { body: 'hi @bob' }, t);
  const n = (await call('GET', '/api/notifications?unread=true', undefined, bo)).body;
  assert.equal(n.length, 1); assert.equal(n[0].type, 'mention');
  await call('POST', '/api/notifications/read', { all: true }, bo);
  assert.equal((await call('GET', '/api/notifications?unread=true', undefined, bo)).body.length, 0);
  // csv
  const csv = await call('GET', `/api/projects/${p.id}/export.csv`, undefined, t);
  assert.ok(csv.body.startsWith('key,type,title,status,priority,assignee,labels,storyPoints,parent,epic,sprint,dueDate,createdAt,resolvedAt'));
  const imp = await call('POST', `/api/projects/${p.id}/import.csv`, 'key,type,title,status,priority,assignee,labels,storyPoints,parent,epic,sprint,dueDate,createdAt,resolvedAt\r\n,task,"Hello, ""x""",Todo,high,,a;b,5,,,,2025-01-01,,\r\n,task,,,,,,,,,,,,\r\n', t, 'text/csv');
  assert.equal(imp.body.created, 1); assert.equal(imp.body.errors[0].line, 3);
  // tokens
  const tk = (await call('POST', '/api/tokens', { name: 'x' }, t)).body;
  assert.equal((await call('GET', '/api/auth/me', undefined, tk.token)).status, 200);
  assert.equal((await call('GET', '/api/tokens', undefined, t)).body[0].token, undefined);
  const au = await call('GET', `/api/workspaces/${ws.id}/audit`, undefined, t);
  assert.ok(au.body.some(e => e.action === 'token.created'));
  srv.close();
});

test('sprints, burndown, webhooks', async () => {
  let cur = new Date('2025-03-01T10:00:00Z');
  const { srv, call, user } = await setup(() => new Date(cur));
  const t = await user('alice');
  const ws = (await call('POST', '/api/workspaces', { name: 'A', key: 'AC' }, t)).body;
  const p = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'W', key: 'WEB' }, t)).body;
  const sp = (await call('POST', `/api/projects/${p.id}/sprints`, { name: 'S1' }, t)).body;
  const i1 = (await call('POST', `/api/projects/${p.id}/issues`, { title: 'one', storyPoints: 5, sprintId: sp.id }, t)).body;
  const i2 = (await call('POST', `/api/projects/${p.id}/issues`, { title: 'two', storyPoints: 3, sprintId: sp.id }, t)).body;
  assert.equal((await call('POST', `/api/sprints/${sp.id}/start`, {}, t)).status, 200);
  const sp2 = (await call('POST', `/api/projects/${p.id}/sprints`, { name: 'S2' }, t)).body;
  assert.equal((await call('POST', `/api/sprints/${sp2.id}/start`, {}, t)).status, 409);
  cur = new Date('2025-03-02T10:00:00Z');
  await call('PATCH', `/api/issues/${i1.key}`, { status: 'Done' }, t);
  cur = new Date('2025-03-03T10:00:00Z');
  const rep = (await call('GET', `/api/sprints/${sp.id}/report`, undefined, t)).body;
  assert.deepEqual(rep.burndown, [{ date: '2025-03-01', remainingPoints: 8 }, { date: '2025-03-02', remainingPoints: 3 }, { date: '2025-03-03', remainingPoints: 3 }]);
  assert.equal(rep.committedPoints, 8); assert.equal(rep.completedPoints, 5);
  await call('POST', `/api/sprints/${sp.id}/complete`, { carryOverTo: 'backlog' }, t);
  const rep2 = (await call('GET', `/api/sprints/${sp.id}/report`, undefined, t)).body;
  assert.equal(rep2.carriedOver, 1);
  assert.equal((await call('GET', `/api/issues/${i2.key}`, undefined, t)).body.sprintId, null);
  // webhook
  const got = [];
  const recv = http.createServer((req, res) => { let d = ''; req.on('data', c => d += c); req.on('end', () => { got.push({ h: req.headers, d }); res.writeHead(got.length === 1 ? 500 : 200); res.end(); }); });
  await new Promise(r => recv.listen(0, r));
  const wh = (await call('POST', `/api/projects/${p.id}/webhooks`, { url: `http://127.0.0.1:${recv.address().port}/`, events: ['issue.created'], secret: 'shh' }, t)).body;
  await call('POST', `/api/projects/${p.id}/issues`, { title: 'hook' }, t);
  for (let i = 0; i < 50 && got.length < 2; i++) await new Promise(r => setTimeout(r, 50));
  await new Promise(r => setTimeout(r, 50));
  assert.equal(got.length, 2);
  assert.equal(got[1].h['x-pm-signature'], 'sha256=' + crypto.createHmac('sha256', 'shh').update(got[1].d).digest('hex'));
  const dl = (await call('GET', `/api/webhooks/${wh.id}/deliveries`, undefined, t)).body;
  assert.equal(dl[0].attempts, 2); assert.equal(dl[0].status, 'success');
  recv.close(); srv.close();
});
