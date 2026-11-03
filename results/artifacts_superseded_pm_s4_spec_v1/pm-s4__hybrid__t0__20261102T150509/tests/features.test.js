import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { createServer } from '../src/server.js';

test('full flow', async () => {
  let t = Date.parse('2026-03-01T10:00:00Z');
  const srv = createServer({ clock: () => new Date(t) }); await new Promise(r => srv.listen(0, r)); srv.unref();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, b, tk, raw) => { const r = await fetch(base + p, { method: m, headers: { ...(raw ? { 'content-type': 'text/csv' } : { 'content-type': 'application/json' }), ...(tk ? { authorization: `Bearer ${tk}` } : {}) }, body: raw ? b : b && JSON.stringify(b) }); const text = await r.text(); let body; try { body = JSON.parse(text); } catch { body = text; } return { status: r.status, body }; };
  const login = async (u) => { await call('POST', '/api/auth/register', { username: u, password: 'password123' }); return (await call('POST', '/api/auth/login', { username: u, password: 'password123' })).body.token; };
  const a = await login('alice'), b = await login('bob'); await login('carol');
  const ws = (await call('POST', '/api/workspaces', { name: 'A', key: 'ACME' }, a)).body;
  assert.equal((await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'bob', role: 'member' }, a)).status, 201);
  assert.equal((await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'carol', role: 'guest' }, a)).status, 201);
  const pr = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Web', key: 'WEB' }, a)).body;
  const c = (await call('POST', '/api/auth/login', { username: 'carol', password: 'password123' })).body.token;
  assert.equal((await call('GET', `/api/workspaces/${ws.id}/projects`, null, c)).body.length, 0);
  const mk = (x) => call('POST', `/api/projects/${pr.id}/issues`, x, a);
  const i1 = (await mk({ type: 'task', title: 'one', storyPoints: 3, assigneeId: null })).body;
  const ep = (await mk({ type: 'epic', title: 'epic' })).body;
  assert.equal(i1.status, 'Todo');
  const i3 = (await mk({ type: 'bug', title: 'Crash on save', labels: ['x'], epicId: ep.id, storyPoints: 5 })).body;
  assert.equal((await mk({ type: 'subtask', title: 's' })).status, 400);
  const sub = (await mk({ type: 'subtask', title: 's', parentId: i1.id })).body;
  assert.equal((await call('GET', '/api/issues/WEB-1', null, a)).body.children[0], sub.key);
  // links/blocked
  await call('POST', '/api/issues/WEB-1/links', { type: 'blocks', target: 'WEB-3' }, a);
  assert.equal((await call('GET', '/api/issues/WEB-3', null, a)).body.links[0].type, 'blocked_by');
  const bl = await call('PATCH', '/api/issues/WEB-3', { status: 'Done' }, a); assert.equal(bl.status, 409); assert.equal(bl.body.error, 'blocked');
  // sprint
  const sp = (await call('POST', `/api/projects/${pr.id}/sprints`, { name: 'S1', startDate: '2026-03-01', endDate: '2026-03-10' }, a)).body;
  await call('PATCH', '/api/issues/WEB-1', { sprintId: sp.id }, a); await call('PATCH', '/api/issues/WEB-3', { sprintId: sp.id }, a);
  assert.equal((await call('POST', `/api/sprints/${sp.id}/start`, {}, a)).status, 200);
  t += 86400000 * 2;
  await call('PATCH', '/api/issues/WEB-1', { status: 'Done' }, a);
  assert.ok((await call('GET', '/api/issues/WEB-1', null, a)).body.resolvedAt);
  const rep = (await call('GET', `/api/sprints/${sp.id}/report`, null, a)).body;
  assert.equal(rep.committedPoints, 8); assert.equal(rep.completedPoints, 3);
  assert.deepEqual(rep.burndown.map(x => x.remainingPoints), [8, 8, 5]);
  const ep2 = (await call('GET', '/api/issues/WEB-2', null, a)).body; assert.equal(ep2.progress.total, 1);
  // notifications / mentions
  await call('POST', '/api/issues/WEB-3/comments', { body: 'hi @bob' }, a);
  const nb = (await call('GET', '/api/notifications?unread=true', null, b)).body; assert.equal(nb[0].type, 'mention');
  // search
  const s = (q) => call('GET', '/api/search?q=' + encodeURIComponent(q), null, a);
  assert.equal((await s('type:bug label:x')).body.length, 1);
  assert.equal((await s('-type:bug is:open')).body.length, 2);
  assert.equal((await s('"crash on" points:>3')).body[0].key, 'WEB-3');
  assert.equal((await s('status:"In Progress"')).body.length, 0);
  assert.equal((await s('foo:bar')).status, 400);
  assert.equal((await s('"abc')).status, 400);
  // csv
  const csv = (await call('GET', `/api/projects/${pr.id}/export.csv`, null, a)).body;
  assert.ok(csv.startsWith('key,type,title'));
  const imp = await call('POST', `/api/projects/${pr.id}/import.csv`, 'key,type,title,status,priority\nX,task,"A, b",Todo,high\nX,nope,bad,Todo,high\n', a, true);
  assert.equal(imp.body.created, 1); assert.equal(imp.body.errors[0].line, 3);
  // workflow remap
  const wf = { statuses: [{ name: 'Open', category: 'unstarted' }, { name: 'Closed', category: 'completed' }], transitions: [['Open', 'Closed']] };
  assert.equal((await call('PUT', `/api/projects/${pr.id}/workflow`, wf, a)).status, 400);
  assert.equal((await call('PUT', `/api/projects/${pr.id}/workflow`, { ...wf, remap: { Todo: 'Open', Done: 'Closed' } }, a)).status, 200);
  assert.equal((await call('GET', '/api/issues/WEB-1', null, a)).body.status, 'Closed');
  // last admin
  assert.equal((await call('DELETE', `/api/workspaces/${ws.id}/members/${(await call('GET', '/api/auth/me', null, a)).body.id}`, null, a)).status, 400);
  assert.equal((await call('GET', `/api/workspaces/${ws.id}/audit`, null, a)).status, 200);
  // delete parent
  await call('DELETE', '/api/issues/WEB-1', null, a);
  assert.equal((await call('GET', `/api/issues/${sub.key}`, null, a)).status, 404);
  srv.close();
});

test('webhook signature', async () => {
  const got = [];
  const hook = http.createServer((req, res) => { let d = ''; req.on('data', x => d += x); req.on('end', () => { got.push({ sig: req.headers['x-pm-signature'], d }); res.end('ok'); }); });
  await new Promise(r => hook.listen(0, r));
  const srv = createServer(); await new Promise(r => srv.listen(0, r)); srv.unref(); const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, b, tk) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(tk ? { authorization: `Bearer ${tk}` } : {}) }, body: b && JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  await call('POST', '/api/auth/register', { username: 'dan', password: 'password123' });
  const tk = (await call('POST', '/api/auth/login', { username: 'dan', password: 'password123' })).body.token;
  const api = (await call('POST', '/api/tokens', { name: 'x' }, tk)).body.token;
  const ws = (await call('POST', '/api/workspaces', { name: 'A', key: 'AB' }, api)).body;
  const pr = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'W', key: 'WW' }, api)).body;
  const h = (await call('POST', `/api/projects/${pr.id}/webhooks`, { url: `http://127.0.0.1:${hook.address().port}/`, events: ['issue.created'], secret: 's3' }, api)).body;
  await call('POST', `/api/projects/${pr.id}/issues`, { type: 'task', title: 'x' }, api);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(got.length, 1);
  assert.equal(got[0].sig, 'sha256=' + crypto.createHmac('sha256', 's3').update(got[0].d).digest('hex'));
  assert.equal((await call('GET', `/api/webhooks/${h.id}/deliveries`, null, api)).body[0].attempts, 1);
  srv.close(); hook.close();
});
