import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';

async function setup(opts = {}) {
  let t = Date.parse('2026-01-05T10:00:00Z');
  const clock = () => new Date(t);
  const srv = createServer({ clock, ...opts });
  await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, b, tok, headers = {}) => {
    const isStr = typeof b === 'string';
    const r = await fetch(base + p, { method: m, headers: { 'content-type': isStr ? 'text/csv' : 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...headers }, body: b === undefined || b === null ? undefined : isStr ? b : JSON.stringify(b) });
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body };
  };
  const user = async name => {
    await call('POST', '/api/auth/register', { username: name, password: 'password123' });
    return (await call('POST', '/api/auth/login', { username: name, password: 'password123' })).body.token;
  };
  return { srv, call, user, advance: ms => { t += ms; }, close: () => srv.close() };
}

test('auth, rate limit, tokens', async () => {
  const { call, user, close } = await setup();
  const a = await user('alice');
  assert.equal((await call('GET', '/api/auth/me', null, a)).body.user.username, 'alice');
  assert.equal((await call('POST', '/api/auth/register', { username: 'alice', password: 'password123' })).status, 409);
  assert.equal((await call('GET', '/api/auth/me')).status, 401);
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/auth/login', { username: 'alice', password: 'wrongpass' })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { username: 'alice', password: 'password123' })).status, 429);
  const tk = await call('POST', '/api/tokens', { name: 'ci' }, a);
  assert.equal(tk.status, 201);
  assert.equal((await call('GET', '/api/auth/me', null, tk.body.token)).status, 200);
  const list = await call('GET', '/api/tokens', null, a);
  assert.ok(!JSON.stringify(list.body).includes(tk.body.token));
  assert.equal((await call('DELETE', `/api/tokens/${tk.body.id}`, null, a)).status, 204);
  assert.equal((await call('GET', '/api/auth/me', null, tk.body.token)).status, 401);
  assert.equal((await call('POST', '/api/auth/logout', null, a)).status, 204);
  assert.equal((await call('GET', '/api/auth/me', null, a)).status, 401);
  close();
});

test('rbac, workflow, issues, links, history, notifications', async () => {
  const { call, user, close } = await setup();
  const a = await user('alice'), b = await user('bob'), g = await user('gina');
  const ws = (await call('POST', '/api/workspaces', { name: 'Acme', key: 'ACME' }, a)).body;
  assert.equal((await call('POST', '/api/workspaces', { name: 'X', key: 'ACME' }, a)).status, 409);
  assert.equal((await call('POST', '/api/workspaces', { name: 'X', key: 'ab' }, a)).status, 400);
  assert.equal((await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'bob', role: 'member' }, a)).status, 201);
  assert.equal((await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'gina', role: 'guest' }, a)).status, 201);
  const me = (await call('GET', '/api/auth/me', null, a)).body.user;
  assert.equal((await call('DELETE', `/api/workspaces/${ws.id}/members/${me.id}`, null, a)).status, 400);
  const pr = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Web', key: 'WEB' }, a)).body;
  assert.equal(pr.workflow.statuses.length, 5);
  assert.equal((await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'G', key: 'GG' }, g)).status, 403);
  assert.equal((await call('GET', `/api/projects/${pr.id}`, null, g)).status, 403);
  assert.equal((await call('GET', `/api/projects/${pr.id}`, null, b)).status, 200);
  await call('POST', `/api/projects/${pr.id}/members`, { username: 'gina', role: 'viewer' }, a);
  assert.equal((await call('GET', `/api/projects/${pr.id}`, null, g)).status, 200);
  assert.equal((await call('POST', `/api/projects/${pr.id}/issues`, { title: 'x' }, g)).status, 403);

  const i1 = (await call('POST', `/api/projects/${pr.id}/issues`, { type: 'bug', title: 'Crash', assigneeId: 'bob', storyPoints: 3 }, a)).body;
  assert.equal(i1.status, 'Todo');
  assert.ok(i1.watchers.length === 2);
  const i2 = (await call('POST', `/api/projects/${pr.id}/issues`, { type: 'task', title: 'Blocker' }, a)).body;
  assert.equal(i2.key, 'WEB-2');
  assert.equal((await call('POST', `/api/issues/${i2.key}/links`, { type: 'blocks', target: i1.key }, a)).status, 201);
  const i1d = (await call('GET', `/api/issues/${i1.key}`, null, a)).body;
  assert.equal(i1d.links[0].type, 'blocked_by');
  assert.equal((await call('PATCH', `/api/issues/${i1.key}`, { status: 'Done' }, a)).body.error, 'blocked');
  await call('PATCH', `/api/issues/${i2.key}`, { status: 'Done' }, a);
  const done = (await call('PATCH', `/api/issues/${i1.key}`, { status: 'Done' }, a)).body;
  assert.ok(done.resolvedAt);
  const hist = (await call('GET', `/api/issues/${i1.key}/history`, null, a)).body;
  assert.ok(hist.some(h => h.field === 'status' && h.to === 'Done'));
  const notes = (await call('GET', '/api/notifications?unread=true', null, b)).body;
  assert.ok(notes.some(n => n.type === 'status_change'));
  assert.ok(notes.some(n => n.type === 'assignment'));
  await call('POST', `/api/issues/${i2.key}/comments`, { body: 'hey @bob' }, a);
  assert.equal((await call('GET', '/api/notifications', null, b)).body[0].type, 'mention');
  assert.equal((await call('POST', '/api/notifications/read', { all: true }, b)).status, 200);
  assert.equal((await call('GET', '/api/notifications?unread=true', null, b)).body.length, 0);

  // subtasks / epics
  const epic = (await call('POST', `/api/projects/${pr.id}/issues`, { type: 'epic', title: 'E' }, a)).body;
  assert.equal((await call('POST', `/api/projects/${pr.id}/issues`, { type: 'subtask', title: 's' }, a)).status, 400);
  assert.equal((await call('POST', `/api/projects/${pr.id}/issues`, { type: 'epic', title: 's', parentId: i2.id }, a)).status, 400);
  assert.equal((await call('POST', `/api/projects/${pr.id}/issues`, { type: 'task', title: 's', epicId: i2.id }, a)).status, 400);
  const st = (await call('POST', `/api/projects/${pr.id}/issues`, { type: 'subtask', title: 's', parentId: i2.id, epicId: epic.id, storyPoints: 2 }, a)).body;
  assert.deepEqual((await call('GET', `/api/issues/${i2.key}`, null, a)).body.children, [st.key]);
  assert.deepEqual((await call('GET', `/api/issues/${epic.key}`, null, a)).body.progress, { total: 1, done: 0, points_total: 2, points_done: 0 });
  assert.equal((await call('DELETE', `/api/issues/${i2.key}`, null, a)).status, 204);
  assert.equal((await call('GET', `/api/issues/${st.key}`, null, a)).status, 404);

  // workflow
  const wf = { statuses: [{ name: 'Open', category: 'unstarted' }, { name: 'Doing', category: 'started' }, { name: 'Closed', category: 'completed' }], transitions: [['Open', 'Doing'], ['Doing', 'Closed']] };
  assert.equal((await call('PUT', `/api/projects/${pr.id}/workflow`, wf, a)).status, 400);
  assert.equal((await call('PUT', `/api/projects/${pr.id}/workflow`, { ...wf, remap: { Todo: 'Open', Done: 'Closed' } }, a)).status, 200);
  const n = (await call('POST', `/api/projects/${pr.id}/issues`, { title: 'n' }, a)).body;
  assert.equal(n.status, 'Open');
  assert.equal((await call('PATCH', `/api/issues/${n.key}`, { status: 'Closed' }, a)).body.error, 'invalid_transition');
  const audit = (await call('GET', `/api/workspaces/${ws.id}/audit`, null, a)).body;
  assert.ok(audit.some(e => e.action === 'workflow.updated'));
  assert.equal((await call('GET', `/api/workspaces/${ws.id}/audit`, null, b)).status, 403);
  close();
});

test('sprints, burndown, search, csv, stats', async () => {
  const { call, user, advance, close } = await setup();
  const a = await user('alice');
  const ws = (await call('POST', '/api/workspaces', { name: 'Acme', key: 'ACME' }, a)).body;
  const pr = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Web', key: 'WEB' }, a)).body;
  const sp = (await call('POST', `/api/projects/${pr.id}/sprints`, { name: 'S1', endDate: '2026-01-09' }, a)).body;
  const sp2 = (await call('POST', `/api/projects/${pr.id}/sprints`, { name: 'S2' }, a)).body;
  const x = (await call('POST', `/api/projects/${pr.id}/issues`, { title: 'X fix', storyPoints: 5, sprintId: sp.id, labels: ['ui'], priority: 'high' }, a)).body;
  const y = (await call('POST', `/api/projects/${pr.id}/issues`, { title: 'Y "thing"', storyPoints: 3, sprintId: sp.id, dueDate: '2026-02-01' }, a)).body;
  assert.equal((await call('POST', `/api/sprints/${sp.id}/start`, {}, a)).status, 200);
  assert.equal((await call('POST', `/api/sprints/${sp2.id}/start`, {}, a)).status, 409);
  advance(86400000);
  await call('PATCH', `/api/issues/${x.key}`, { status: 'In Progress' }, a);
  advance(3600000 * 2);
  await call('PATCH', `/api/issues/${x.key}`, { status: 'Done' }, a);
  advance(86400000);
  let rep = (await call('GET', `/api/sprints/${sp.id}/report`, null, a)).body;
  assert.deepEqual(rep.burndown.map(d => d.remainingPoints), [8, 3, 3]);
  assert.equal(rep.committedPoints, 8);
  const comp = await call('POST', `/api/sprints/${sp.id}/complete`, { carryOverTo: sp2.id }, a);
  assert.equal(comp.status, 200);
  assert.equal((await call('GET', `/api/issues/${y.key}`, null, a)).body.sprintId, sp2.id);
  rep = (await call('GET', `/api/sprints/${sp.id}/report`, null, a)).body;
  assert.equal(rep.completedPoints, 5); assert.equal(rep.carriedOver, 1);
  const stats = (await call('GET', `/api/projects/${pr.id}/stats`, null, a)).body;
  assert.equal(stats.avgCycleTimeHours, 2);

  const s = async q => (await call('GET', `/api/search?q=${encodeURIComponent(q)}`, null, a));
  assert.equal((await s('status:"Done"')).body.length, 1);
  assert.equal((await s('is:open')).body[0].key, y.key);
  assert.equal((await s('-label:ui')).body.length, 1);
  assert.equal((await s('points:>3')).body.length, 1);
  assert.equal((await s('due:<2026-03-01')).body.length, 1);
  assert.equal((await s('"x fix"')).body.length, 1);
  assert.equal((await s('assignee:none fix')).body.length, 1);
  assert.equal((await s('sprint:active')).body.length, 0);
  assert.equal((await s('key:WEB-1')).body.length, 1);
  assert.equal((await s('status:"Done')).status, 400);
  assert.equal((await s('foo:bar')).status, 400);
  assert.equal((await s('')).body.length, 2);
  assert.equal((await call('GET', '/api/search?q=&sort=priority', null, a)).body[0].key, x.key);

  const csv = await call('GET', `/api/projects/${pr.id}/export.csv`, undefined, a);
  assert.ok(csv.body.startsWith('key,type,title,status,priority,assignee,labels,storyPoints,parent,epic,sprint,dueDate,createdAt,resolvedAt\r\n'));
  assert.ok(csv.body.includes('"Y ""thing"""'));
  const imp = await call('POST', `/api/projects/${pr.id}/import.csv`, 'key,type,title,status,labels\n,bug,"Multi, line",Todo,a;b\n,nope,bad,,\n,task,,Todo,\n', a);
  assert.equal(imp.body.created, 1);
  assert.deepEqual(imp.body.errors.map(e => e.line), [3, 4]);
  close();
});

test('webhooks with signature and retries; persistence', async () => {
  const got = [];
  let fail = 1;
  const hook = http.createServer((req, res) => {
    let d = ''; req.on('data', c => d += c); req.on('end', () => {
      got.push({ body: d, sig: req.headers['x-pm-signature'] });
      if (fail-- > 0) { res.writeHead(500); res.end(); } else { res.writeHead(200); res.end('ok'); }
    });
  });
  await new Promise(r => hook.listen(0, r));
  const dataFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pm-')), 'db.json');
  const { srv, call, user, close } = await setup({ dataFile });
  const a = await user('alice');
  const ws = (await call('POST', '/api/workspaces', { name: 'Acme', key: 'ACME' }, a)).body;
  const pr = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Web', key: 'WEB' }, a)).body;
  const wh = (await call('POST', `/api/projects/${pr.id}/webhooks`, { url: `http://127.0.0.1:${hook.address().port}/h`, events: ['issue.created'], secret: 's3cret' }, a)).body;
  await call('POST', `/api/projects/${pr.id}/issues`, { title: 'hi' }, a);
  await srv.flushDeliveries();
  const d = (await call('GET', `/api/webhooks/${wh.id}/deliveries`, null, a)).body;
  assert.equal(d[0].status, 200); assert.equal(d[0].attempts, 2);
  assert.equal(got[1].sig, 'sha256=' + crypto.createHmac('sha256', 's3cret').update(got[1].body).digest('hex'));
  close(); hook.close();
  const srv2 = createServer({ dataFile });
  await new Promise(r => srv2.listen(0, r));
  const r = await fetch(`http://127.0.0.1:${srv2.address().port}/api/issues/WEB-1`, { headers: { authorization: `Bearer ${a}` } });
  assert.equal(r.status, 200);
  const html = await fetch(`http://127.0.0.1:${srv2.address().port}/`);
  assert.equal(html.status, 200);
  srv2.close();
});
