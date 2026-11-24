import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../../src/server.js';

async function setup(opts = {}) {
  let t = Date.parse('2026-01-05T09:00:00Z');
  const clock = () => new Date(t);
  const srv = createServer({ clock, ...opts }); await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, b, tok, raw) => {
    const r = await fetch(base + p, { method: m, headers: { 'content-type': raw ? 'text/csv' : 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: raw ?? (b && JSON.stringify(b)) });
    const text = await r.text(); let body = text; try { body = JSON.parse(text); } catch {}
    return { status: r.status, body };
  };
  const user = async name => { await call('POST', '/api/auth/register', { username: name, password: 'password123' }); const r = await call('POST', '/api/auth/login', { username: name, password: 'password123' }); return { token: r.body.token, id: r.body.user.id }; };
  return { srv, call, user, advance: ms => { t += ms; }, close: () => srv.close() };
}

test('auth, rate limit, tokens', async () => {
  const s = await setup();
  const a = await s.user('alice');
  assert.equal((await s.call('GET', '/api/auth/me', null, a.token)).body.user.username, 'alice');
  assert.equal((await s.call('POST', '/api/auth/register', { username: 'alice', password: 'password123' })).status, 409);
  for (let i = 0; i < 5; i++) assert.equal((await s.call('POST', '/api/auth/login', { username: 'alice', password: 'x' })).status, 401);
  assert.equal((await s.call('POST', '/api/auth/login', { username: 'alice', password: 'password123' })).status, 429);
  s.advance(16 * 60 * 1000);
  assert.equal((await s.call('POST', '/api/auth/login', { username: 'alice', password: 'password123' })).status, 200);
  const tk = await s.call('POST', '/api/tokens', { name: 'ci' }, a.token);
  assert.equal(tk.status, 201);
  assert.equal((await s.call('GET', '/api/auth/me', null, tk.body.token)).status, 200);
  const list = await s.call('GET', '/api/tokens', null, a.token);
  assert.ok(!('token' in list.body[0]));
  assert.equal((await s.call('DELETE', `/api/tokens/${tk.body.id}`, null, a.token)).status, 204);
  assert.equal((await s.call('GET', '/api/auth/me', null, tk.body.token)).status, 401);
  assert.equal((await s.call('POST', '/api/auth/logout', null, a.token)).status, 204);
  assert.equal((await s.call('GET', '/api/auth/me', null, a.token)).status, 401);
  s.close();
});

test('rbac, workflow, issues, links, history, notifications', async () => {
  const s = await setup();
  const a = await s.user('alice'), b = await s.user('bob'), g = await s.user('gus');
  const ws = (await s.call('POST', '/api/workspaces', { name: 'A', key: 'AC' }, a.token)).body;
  assert.equal((await s.call('POST', '/api/workspaces', { name: 'A', key: 'ac' }, a.token)).status, 400);
  await s.call('POST', `/api/workspaces/${ws.id}/members`, { username: 'bob', role: 'member' }, a.token);
  await s.call('POST', `/api/workspaces/${ws.id}/members`, { username: 'gus', role: 'guest' }, a.token);
  assert.equal((await s.call('DELETE', `/api/workspaces/${ws.id}/members/${a.id}`, null, a.token)).status, 400);
  const pr = (await s.call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'P', key: 'PR' }, a.token)).body;
  assert.equal((await s.call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'G', key: 'GG' }, g.token)).status, 403);
  assert.equal((await s.call('GET', `/api/projects/${pr.id}`, null, g.token)).status, 403);
  assert.equal((await s.call('GET', `/api/projects/${pr.id}`, null, b.token)).status, 200);
  const i1 = (await s.call('POST', `/api/projects/${pr.id}/issues`, { type: 'task', title: 'One', assigneeId: b.id, storyPoints: 3 }, a.token)).body;
  assert.equal(i1.status, 'Todo');
  const i2 = (await s.call('POST', `/api/projects/${pr.id}/issues`, { type: 'bug', title: 'Two' }, a.token)).body;
  assert.equal(i2.key, 'PR-2');
  assert.equal((await s.call('POST', `/api/projects/${pr.id}/issues`, { type: 'subtask', title: 'S' }, a.token)).status, 400);
  const sub = (await s.call('POST', `/api/projects/${pr.id}/issues`, { type: 'subtask', title: 'S', parentId: i1.id }, a.token)).body;
  assert.deepEqual((await s.call('GET', `/api/issues/${i1.key}`, null, a.token)).body.children, [sub.key]);
  // links/blocked
  await s.call('POST', `/api/issues/${i2.key}/links`, { type: 'blocks', target: i1.key }, a.token);
  const g1 = (await s.call('GET', `/api/issues/${i1.key}`, null, a.token)).body;
  assert.equal(g1.links[0].type, 'blocked_by');
  const blocked = await s.call('PATCH', `/api/issues/${i1.key}`, { status: 'Done' }, a.token);
  assert.equal(blocked.status, 409); assert.equal(blocked.body.error, 'blocked');
  await s.call('PATCH', `/api/issues/${i2.key}`, { status: 'Done' }, a.token);
  const done = await s.call('PATCH', `/api/issues/${i1.key}`, { status: 'Done' }, a.token);
  assert.equal(done.status, 200); assert.ok(done.body.resolvedAt);
  const h = (await s.call('GET', `/api/issues/${i1.key}/history`, null, a.token)).body;
  assert.equal(h.at(-1).field, 'status'); assert.equal(h.at(-1).to, 'Done');
  // notifications for bob (assignee): assigned + status_changed
  const n = (await s.call('GET', '/api/notifications?unread=true', null, b.token)).body;
  assert.equal(n[0].type, 'status_changed');
  await s.call('POST', `/api/issues/${i2.key}/comments`, { body: 'hey @bob' }, a.token);
  const n2 = (await s.call('GET', '/api/notifications', null, b.token)).body;
  assert.equal(n2[0].type, 'mention');
  await s.call('POST', '/api/notifications/read', { all: true }, b.token);
  assert.equal((await s.call('GET', '/api/notifications?unread=true', null, b.token)).body.length, 0);
  // workflow
  const wf = { statuses: [{ name: 'Open', category: 'unstarted' }, { name: 'Closed', category: 'completed' }], transitions: [['Open', 'Closed']] };
  assert.equal((await s.call('PUT', `/api/projects/${pr.id}/workflow`, wf, b.token)).status, 403);
  assert.equal((await s.call('PUT', `/api/projects/${pr.id}/workflow`, wf, a.token)).status, 400);
  const ok = await s.call('PUT', `/api/projects/${pr.id}/workflow`, { ...wf, remap: { Todo: 'Open', Done: 'Closed' } }, a.token);
  assert.equal(ok.status, 200);
  const bad = await s.call('PATCH', `/api/issues/${i1.key}`, { status: 'Open' }, a.token);
  assert.equal(bad.body.error, 'invalid_transition');
  // search
  let r = await s.call('GET', '/api/search?q=' + encodeURIComponent('status:Closed -type:bug'), null, a.token);
  assert.deepEqual(r.body.map(i => i.key), ['PR-1']);
  r = await s.call('GET', '/api/search?q=' + encodeURIComponent('assignee:bob is:resolved'), null, a.token);
  assert.equal(r.body.length, 1);
  r = await s.call('GET', '/api/search?q=' + encodeURIComponent('"one" points:>2'), null, a.token);
  assert.equal(r.body.length, 1);
  assert.equal((await s.call('GET', '/api/search?q=' + encodeURIComponent('status:"Open'), null, a.token)).status, 400);
  assert.equal((await s.call('GET', '/api/search?q=foo:bar', null, a.token)).status, 400);
  assert.equal((await s.call('GET', '/api/search?q=', null, g.token)).body.length, 0);
  // delete parent deletes subtasks
  assert.equal((await s.call('DELETE', `/api/issues/${i1.key}`, null, a.token)).status, 204);
  assert.equal((await s.call('GET', `/api/issues/${sub.key}`, null, a.token)).status, 404);
  const i4 = (await s.call('POST', `/api/projects/${pr.id}/issues`, { title: 'Four' }, a.token)).body;
  assert.equal(i4.key, 'PR-4');
  const audit = (await s.call('GET', `/api/workspaces/${ws.id}/audit`, null, a.token)).body;
  assert.ok(audit.some(x => x.action === 'workflow.updated'));
  assert.equal((await s.call('GET', `/api/workspaces/${ws.id}/audit`, null, b.token)).status, 403);
  s.close();
});

test('sprints, report, epic progress, stats, csv', async () => {
  const s = await setup();
  const a = await s.user('alice');
  const ws = (await s.call('POST', '/api/workspaces', { name: 'A', key: 'AC' }, a.token)).body;
  const pr = (await s.call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'P', key: 'PR' }, a.token)).body;
  const sp = (await s.call('POST', `/api/projects/${pr.id}/sprints`, { name: 'S1', startDate: '2026-01-05', endDate: '2026-01-09' }, a.token)).body;
  const sp2 = (await s.call('POST', `/api/projects/${pr.id}/sprints`, { name: 'S2' }, a.token)).body;
  const epic = (await s.call('POST', `/api/projects/${pr.id}/issues`, { type: 'epic', title: 'E' }, a.token)).body;
  const x = (await s.call('POST', `/api/projects/${pr.id}/issues`, { title: 'X', storyPoints: 5, sprintId: sp.id, epicId: epic.id, labels: ['a', 'b'] }, a.token)).body;
  const y = (await s.call('POST', `/api/projects/${pr.id}/issues`, { title: 'Y, "q"', storyPoints: 3, sprintId: sp.id, epicId: epic.id }, a.token)).body;
  assert.equal((await s.call('POST', `/api/sprints/${sp.id}/start`, null, a.token)).status, 200);
  assert.equal((await s.call('POST', `/api/sprints/${sp2.id}/start`, null, a.token)).status, 409);
  s.advance(3600e3);
  await s.call('PATCH', `/api/issues/${x.key}`, { status: 'In Progress' }, a.token);
  s.advance(86400e3);
  await s.call('PATCH', `/api/issues/${x.key}`, { status: 'Done' }, a.token);
  s.advance(86400e3);
  const rep = (await s.call('GET', `/api/sprints/${sp.id}/report`, null, a.token)).body;
  assert.equal(rep.committedPoints, 8);
  assert.deepEqual(rep.burndown, [{ date: '2026-01-05', remainingPoints: 8 }, { date: '2026-01-06', remainingPoints: 3 }, { date: '2026-01-07', remainingPoints: 3 }]);
  const ep = (await s.call('GET', `/api/issues/${epic.key}`, null, a.token)).body;
  assert.deepEqual(ep.progress, { total: 2, done: 1, points_total: 8, points_done: 5 });
  const c = await s.call('POST', `/api/sprints/${sp.id}/complete`, { carryOverTo: sp2.id }, a.token);
  assert.equal(c.status, 200);
  assert.equal((await s.call('GET', `/api/issues/${y.key}`, null, a.token)).body.sprintId, sp2.id);
  const rep2 = (await s.call('GET', `/api/sprints/${sp.id}/report`, null, a.token)).body;
  assert.equal(rep2.completedPoints, 5); assert.equal(rep2.carriedOver, 1); assert.equal(rep2.completedIssues, 1);
  const st = (await s.call('GET', `/api/projects/${pr.id}/stats`, null, a.token)).body;
  assert.equal(st.averageCycleTimeHours, 24); assert.equal(st.byStatus.Done, 1);
  const csv = await s.call('GET', `/api/projects/${pr.id}/export.csv`, null, a.token);
  assert.ok(csv.body.startsWith('key,type,title,status,priority,assignee,labels,storyPoints,parent,epic,sprint,dueDate,createdAt,resolvedAt'));
  assert.ok(csv.body.includes('"Y, ""q"""')); assert.ok(csv.body.includes('a;b'));
  const imp = await s.call('POST', `/api/projects/${pr.id}/import.csv`, null, a.token,
    'key,type,title,status,priority,assignee,labels\r\n,bug,"Multi\nline",Todo,high,alice,x;y\r\n,bogus,Bad,,,,\r\n,task,,,,,\r\n,task,Fine,,,,\r\n');
  assert.equal(imp.body.created, 2); assert.deepEqual(imp.body.errors.map(e => e.line), [4, 5]);
  s.close();
});

test('webhooks signed + retries, persistence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-'));
  const dataFile = path.join(dir, 'db.json');
  let hits = 0; const got = [];
  const hook = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { hits++; got.push({ b, sig: req.headers['x-pm-signature'] }); res.writeHead(hits === 1 ? 500 : 200); res.end(); }); });
  await new Promise(r => hook.listen(0, r));
  const s = await setup({ dataFile });
  const a = await s.user('alice');
  const ws = (await s.call('POST', '/api/workspaces', { name: 'A', key: 'AC' }, a.token)).body;
  const pr = (await s.call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'P', key: 'PR' }, a.token)).body;
  const wh = (await s.call('POST', `/api/projects/${pr.id}/webhooks`, { url: `http://127.0.0.1:${hook.address().port}/h`, events: ['issue.created'], secret: 'sek' }, a.token)).body;
  await s.call('POST', `/api/projects/${pr.id}/issues`, { title: 'W' }, a.token);
  await new Promise(r => setTimeout(r, 400));
  const d = (await s.call('GET', `/api/webhooks/${wh.id}/deliveries`, null, a.token)).body;
  assert.equal(d[0].status, 200); assert.equal(d[0].attempts, 2);
  assert.equal(got[1].sig, 'sha256=' + crypto.createHmac('sha256', 'sek').update(got[1].b).digest('hex'));
  assert.equal(JSON.parse(got[1].b).event, 'issue.created');
  s.close(); hook.close();
  const srv2 = createServer({ dataFile }); await new Promise(r => srv2.listen(0, r));
  const r = await fetch(`http://127.0.0.1:${srv2.address().port}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'alice', password: 'password123' }) });
  assert.equal(r.status, 200);
  srv2.close();
});

test('serves SPA', async () => {
  const s = await setup();
  const base = `http://127.0.0.1:${s.srv.address().port}`;
  const r = await fetch(base + '/'); assert.equal(r.status, 200); assert.match(await r.text(), /static\/app\.js/);
  const j = await fetch(base + '/static/app.js'); assert.equal(j.status, 200); assert.match(j.headers.get('content-type'), /javascript/);
  assert.equal((await fetch(base + '/static/../server.js')).status, 404);
  assert.equal((await fetch(base + '/api/auth/me')).status, 401);
  s.close();
});
