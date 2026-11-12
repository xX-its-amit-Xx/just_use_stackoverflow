import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';

async function setup(opts = {}) {
  let t = Date.parse('2026-03-02T09:00:00Z');
  const clock = () => new Date(t);
  const srv = createServer({ clock, ...opts });
  await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, b, tok, ct) => {
    const r = await fetch(base + p, { method: m, headers: { 'content-type': ct || 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: b === undefined ? undefined : typeof b === 'string' ? b : JSON.stringify(b) });
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body, headers: r.headers };
  };
  const user = async name => {
    await call('POST', '/api/auth/register', { username: name, password: 'password123' });
    const r = await call('POST', '/api/auth/login', { username: name, password: 'password123' });
    return { token: r.body.token, id: r.body.user.id };
  };
  return { srv, base, call, user, advance: ms => { t += ms; }, close: () => srv.close() };
}

test('auth, tokens, rate limit', async () => {
  const { call, user, close } = await setup();
  assert.equal((await call('POST', '/api/auth/register', { username: 'x', password: 'short' })).status, 400);
  const a = await user('alice');
  assert.equal((await call('POST', '/api/auth/register', { username: 'alice', password: 'password123' })).status, 409);
  assert.equal((await call('GET', '/api/auth/me', undefined, a.token)).body.user.username, 'alice');
  assert.equal((await call('GET', '/api/auth/me')).status, 401);
  const tk = await call('POST', '/api/tokens', { name: 'ci' }, a.token);
  assert.equal(tk.status, 201); assert.ok(tk.body.token);
  assert.equal((await call('GET', '/api/auth/me', undefined, tk.body.token)).status, 200);
  const list = await call('GET', '/api/tokens', undefined, a.token);
  assert.equal(list.body.length, 1); assert.equal(list.body[0].token, undefined);
  assert.equal((await call('DELETE', `/api/tokens/${tk.body.id}`, undefined, a.token)).status, 204);
  assert.equal((await call('GET', '/api/auth/me', undefined, tk.body.token)).status, 401);
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/auth/login', { username: 'alice', password: 'wrongwrong' })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { username: 'alice', password: 'password123' })).status, 429);
  assert.equal((await call('POST', '/api/auth/logout', undefined, a.token)).status, 204);
  assert.equal((await call('GET', '/api/auth/me', undefined, a.token)).status, 401);
  close();
});

test('workspaces, RBAC, guests, workflow, issues, links, notifications', async () => {
  const { call, user, close, advance } = await setup();
  const a = await user('alice'), b = await user('bob'), g = await user('gina');
  const ws = (await call('POST', '/api/workspaces', { name: 'Acme', key: 'ACME' }, a.token)).body;
  assert.equal((await call('POST', '/api/workspaces', { name: 'x', key: 'acme' }, a.token)).status, 400);
  assert.equal((await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'bob', role: 'member' }, a.token)).status, 201);
  assert.equal((await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'gina', role: 'guest' }, a.token)).status, 201);
  assert.equal((await call('DELETE', `/api/workspaces/${ws.id}/members/${a.id}`, undefined, a.token)).status, 400);
  assert.equal((await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'x', role: 'member' }, b.token)).status, 403);
  const pr = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Web', key: 'WEB' }, a.token)).body;
  assert.equal(pr.workflow.statuses.length, 5);
  assert.equal((await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'G', key: 'GG' }, g.token)).status, 403);
  assert.equal((await call('GET', `/api/projects/${pr.id}`, undefined, g.token)).status, 403);
  assert.equal((await call('GET', `/api/projects/${pr.id}`, undefined, b.token)).status, 200);

  const i1 = (await call('POST', `/api/projects/${pr.id}/issues`, { type: 'task', title: 'One', assigneeId: b.id, storyPoints: 3 }, a.token)).body;
  assert.equal(i1.status, 'Todo'); assert.deepEqual(i1.watchers.sort(), [a.id, b.id].sort());
  const i2 = (await call('POST', `/api/projects/${pr.id}/issues`, { type: 'bug', title: 'Two' }, a.token)).body;
  assert.equal(i2.key, 'WEB-2');
  assert.equal((await call('POST', `/api/projects/${pr.id}/issues`, { type: 'subtask', title: 'S' }, a.token)).status, 400);
  const sub = (await call('POST', `/api/projects/${pr.id}/issues`, { type: 'subtask', title: 'S', parentId: i1.id }, a.token)).body;
  assert.deepEqual((await call('GET', `/api/issues/${i1.key}`, undefined, a.token)).body.children, [sub.key]);
  const epic = (await call('POST', `/api/projects/${pr.id}/issues`, { type: 'epic', title: 'E' }, a.token)).body;
  assert.equal((await call('PATCH', `/api/issues/${i1.key}`, { epicId: i2.id }, a.token)).status, 400);
  await call('PATCH', `/api/issues/${i1.key}`, { epicId: epic.id }, a.token);

  // links & blocked
  const ln = await call('POST', `/api/issues/${i2.key}/links`, { type: 'blocks', target: i1.key }, a.token);
  assert.equal(ln.status, 201);
  const v1 = (await call('GET', `/api/issues/${i1.key}`, undefined, a.token)).body;
  assert.ok(v1.links.some(l => l.type === 'blocked_by' && l.key === i2.key));
  const blocked = await call('PATCH', `/api/issues/${i1.key}`, { status: 'Done' }, a.token);
  assert.equal(blocked.status, 409); assert.equal(blocked.body.error, 'blocked');
  await call('PATCH', `/api/issues/${i2.key}`, { status: 'Done' }, a.token);
  advance(3600000);
  await call('PATCH', `/api/issues/${i1.key}`, { status: 'In Progress' }, a.token);
  advance(2 * 3600000);
  const done = await call('PATCH', `/api/issues/${i1.key}`, { status: 'Done' }, a.token);
  assert.equal(done.status, 200); assert.ok(done.body.resolvedAt);
  const ep = (await call('GET', `/api/issues/${epic.key}`, undefined, a.token)).body;
  assert.deepEqual(ep.progress, { total: 1, done: 1, points_total: 3, points_done: 3 });
  const stats = (await call('GET', `/api/projects/${pr.id}/stats`, undefined, a.token)).body;
  assert.equal(stats.avgCycleTimeHours, 2);
  const reopen = (await call('PATCH', `/api/issues/${i1.key}`, { status: 'Todo' }, a.token)).body;
  assert.equal(reopen.resolvedAt, null);
  const hist = (await call('GET', `/api/issues/${i1.key}/history`, undefined, a.token)).body;
  assert.ok(hist.some(h => h.field === 'status' && h.from === 'In Progress' && h.to === 'Done' && h.actorId === a.id));

  // notifications
  const nb = (await call('GET', '/api/notifications?unread=true', undefined, b.token)).body;
  assert.ok(nb.length >= 1 && nb.every(n => n.issueKey && n.type && !n.read));
  assert.ok(nb.some(n => n.type === 'status_changed'));
  await call('POST', `/api/issues/${i2.key}/comments`, { body: 'hey @bob and @gina' }, a.token);
  const nb2 = (await call('GET', '/api/notifications?unread=true', undefined, b.token)).body;
  assert.equal(nb2[0].type, 'mention');
  assert.equal((await call('GET', '/api/notifications', undefined, g.token)).body.length, 0);
  await call('POST', '/api/notifications/read', { all: true }, b.token);
  assert.equal((await call('GET', '/api/notifications?unread=true', undefined, b.token)).body.length, 0);
  const cm = (await call('GET', `/api/issues/${i2.key}/comments`, undefined, a.token)).body[0];
  assert.equal((await call('PATCH', `/api/comments/${cm.id}`, { body: 'x' }, b.token)).status, 403);
  assert.equal((await call('PATCH', `/api/comments/${cm.id}`, { body: 'edited' }, a.token)).body.edited, true);

  // workflow
  const badWf = await call('PUT', `/api/projects/${pr.id}/workflow`, { statuses: [{ name: 'Open', category: 'unstarted' }, { name: 'Closed', category: 'completed' }], transitions: [['Open', 'Closed']] }, a.token);
  assert.equal(badWf.status, 400);
  const wf = await call('PUT', `/api/projects/${pr.id}/workflow`, { statuses: [{ name: 'Open', category: 'unstarted' }, { name: 'Closed', category: 'completed' }], transitions: [['Open', 'Closed']], remap: { Todo: 'Open', Done: 'Closed' } }, a.token);
  assert.equal(wf.status, 200);
  const closed = await call('PATCH', `/api/issues/${i2.key}`, { status: 'Open' }, a.token);
  assert.equal(closed.status, 409); assert.equal(closed.body.error, 'invalid_transition');
  const auditLog = (await call('GET', `/api/workspaces/${ws.id}/audit`, undefined, a.token)).body;
  assert.ok(auditLog.some(e => e.action === 'workflow.updated'));
  assert.equal((await call('GET', `/api/workspaces/${ws.id}/audit`, undefined, b.token)).status, 403);

  // delete parent deletes subtasks
  assert.equal((await call('DELETE', `/api/issues/${i1.key}`, undefined, a.token)).status, 204);
  assert.equal((await call('GET', `/api/issues/${sub.key}`, undefined, a.token)).status, 404);
  const i5 = (await call('POST', `/api/projects/${pr.id}/issues`, { title: 'after' }, a.token)).body;
  assert.equal(i5.key, 'WEB-5');
  close();
});

test('search, csv, sprints and burndown', async () => {
  const { call, user, close, advance } = await setup();
  const a = await user('alice');
  const ws = (await call('POST', '/api/workspaces', { name: 'Acme', key: 'ACME' }, a.token)).body;
  const pr = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Web', key: 'WEB' }, a.token)).body;
  const sp = (await call('POST', `/api/projects/${pr.id}/sprints`, { name: 'S1', startDate: '2026-03-02', endDate: '2026-03-06' }, a.token)).body;
  const sp2 = (await call('POST', `/api/projects/${pr.id}/sprints`, { name: 'S2' }, a.token)).body;
  const mk = b => call('POST', `/api/projects/${pr.id}/issues`, b, a.token).then(r => r.body);
  const x1 = await mk({ title: 'Login bug', type: 'bug', priority: 'high', labels: ['ui'], storyPoints: 5, sprintId: sp.id, dueDate: '2026-03-10', assigneeId: a.id });
  const x2 = await mk({ title: 'Signup page', description: 'needs "quoted, text"', type: 'feature', storyPoints: 3, sprintId: sp.id, labels: ['wontfix'] });
  const x3 = await mk({ title: 'Docs', type: 'task' });
  assert.equal((await call('POST', `/api/sprints/${sp.id}/start`, {}, a.token)).status, 200);
  assert.equal((await call('POST', `/api/sprints/${sp2.id}/start`, {}, a.token)).status, 409);
  advance(86400000);
  await call('PATCH', `/api/issues/${x2.key}`, { status: 'Done' }, a.token);
  advance(86400000);
  const rep = (await call('GET', `/api/sprints/${sp.id}/report`, undefined, a.token)).body;
  assert.equal(rep.committedPoints, 8);
  assert.deepEqual(rep.burndown, [{ date: '2026-03-02', remainingPoints: 8 }, { date: '2026-03-03', remainingPoints: 5 }, { date: '2026-03-04', remainingPoints: 5 }]);

  const s = async q => (await call('GET', `/api/search?q=${encodeURIComponent(q)}`, undefined, a.token));
  assert.deepEqual((await s('type:bug priority:high')).body.map(i => i.key), [x1.key]);
  assert.deepEqual((await s('-label:wontfix sprint:active')).body.map(i => i.key), [x1.key]);
  assert.deepEqual((await s('status:"Done"')).body.map(i => i.key), [x2.key]);
  assert.deepEqual((await s('"quoted, text"')).body.map(i => i.key), [x2.key]);
  assert.deepEqual((await s('points:>3')).body.map(i => i.key), [x1.key]);
  assert.deepEqual((await s('due:<2026-04-01 assignee:me is:open')).body.map(i => i.key), [x1.key]);
  assert.deepEqual((await s('sprint:none')).body.map(i => i.key), [x3.key]);
  assert.equal((await s('status:"In')).status, 400);
  assert.equal((await s('bogus:1')).status, 400);
  assert.equal((await s('')).body[0].key, x2.key);

  const comp = await call('POST', `/api/sprints/${sp.id}/complete`, { carryOverTo: sp2.id }, a.token);
  assert.equal(comp.status, 200);
  assert.equal((await call('GET', `/api/issues/${x1.key}`, undefined, a.token)).body.sprintId, sp2.id);
  const rep2 = (await call('GET', `/api/sprints/${sp.id}/report`, undefined, a.token)).body;
  assert.equal(rep2.completedPoints, 3); assert.equal(rep2.carriedOver, 1);

  const csv = await call('GET', `/api/projects/${pr.id}/export.csv`, undefined, a.token);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  const lines = csv.body.split('\r\n');
  assert.equal(lines[0], 'key,type,title,status,priority,assignee,labels,storyPoints,parent,epic,sprint,dueDate,createdAt,resolvedAt');
  assert.ok(csv.body.includes('alice'));
  const imp = await call('POST', `/api/projects/${pr.id}/import.csv`, 'key,type,title,status,priority\nX-1,bug,"Imported, one",Todo,high\nX-2,nope,Bad,Todo,low\n,task,"multi\nline",Done,none\n', a.token, 'text/csv');
  assert.equal(imp.body.created, 2); assert.equal(imp.body.errors.length, 1); assert.equal(imp.body.errors[0].line, 3);
  close();
});

test('webhooks with signature and retries; persistence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-'));
  const dataFile = path.join(dir, 'data.json');
  const received = [];
  let fail = 1;
  const hook = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      received.push({ b, sig: req.headers['x-pm-signature'] });
      if (fail-- > 0) { res.writeHead(500); return res.end(); }
      res.writeHead(200); res.end('ok');
    });
  });
  await new Promise(r => hook.listen(0, r));
  const { call, user, close } = await setup({ dataFile });
  const a = await user('alice');
  const ws = (await call('POST', '/api/workspaces', { name: 'Acme', key: 'ACME' }, a.token)).body;
  const pr = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Web', key: 'WEB' }, a.token)).body;
  const wh = (await call('POST', `/api/projects/${pr.id}/webhooks`, { url: `http://127.0.0.1:${hook.address().port}/h`, events: ['issue.created'], secret: 's3cret' }, a.token)).body;
  await call('POST', `/api/projects/${pr.id}/issues`, { title: 'hi' }, a.token);
  let d;
  for (let k = 0; k < 50; k++) { d = (await call('GET', `/api/webhooks/${wh.id}/deliveries`, undefined, a.token)).body; if (d[0]?.status === 200) break; await new Promise(r => setTimeout(r, 20)); }
  assert.equal(d[0].status, 200); assert.equal(d[0].attempts, 2);
  const expected = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(received[1].b).digest('hex');
  assert.equal(received[1].sig, expected);
  assert.equal(JSON.parse(received[1].b).event, 'issue.created');
  close(); hook.close();
  const s2 = await setup({ dataFile });
  const r = await s2.call('POST', '/api/auth/login', { username: 'alice', password: 'password123' });
  assert.equal(r.status, 200);
  assert.equal((await s2.call('GET', '/api/issues/WEB-1', undefined, r.body.token)).body.title, 'hi');
  s2.close();
  const html = await fetch(s2.base + '/').catch(() => null);
  assert.equal(html, null);
});

test('serves SPA', async () => {
  const { base, close } = await setup();
  const r = await fetch(base + '/'); assert.equal(r.status, 200); assert.match(await r.text(), /app\.js/);
  const j = await fetch(base + '/static/app.js'); assert.equal(j.status, 200);
  close();
});
