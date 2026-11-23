import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';

async function setup(opts = {}) {
  let t = opts.start ? new Date(opts.start).getTime() : Date.now();
  const clock = () => new Date(t);
  const srv = createServer({ clock, dataFile: opts.dataFile });
  await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, b, tok, headers = {}) => {
    const isStr = typeof b === 'string';
    const r = await fetch(base + p, { method: m, headers: { 'content-type': isStr ? 'text/csv' : 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...headers }, body: b === undefined ? undefined : isStr ? b : JSON.stringify(b) });
    const text = await r.text();
    let body = null; try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body, headers: r.headers };
  };
  const user = async name => {
    await call('POST', '/api/auth/register', { username: name, password: 'password123' });
    const r = await call('POST', '/api/auth/login', { username: name, password: 'password123' });
    return { token: r.body.token, id: r.body.user.id };
  };
  return { srv, call, user, advance: ms => { t += ms; }, setTime: d => { t = new Date(d).getTime(); }, close: () => srv.close() };
}

async function basic(ctx) {
  const alice = await ctx.user('alice');
  const ws = (await ctx.call('POST', '/api/workspaces', { name: 'Acme', key: 'ACME' }, alice.token)).body;
  const pr = (await ctx.call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Web', key: 'WEB' }, alice.token)).body;
  return { alice, ws, pr };
}

test('auth flow, rate limiting, tokens', async () => {
  const c = await setup();
  try {
    assert.equal((await c.call('POST', '/api/auth/register', { username: 'bob', password: 'password123' })).status, 201);
    assert.equal((await c.call('POST', '/api/auth/register', { username: 'bob', password: 'password123' })).status, 409);
    assert.equal((await c.call('POST', '/api/auth/register', { username: 'x' })).status, 400);
    for (let i = 0; i < 5; i++) assert.equal((await c.call('POST', '/api/auth/login', { username: 'bob', password: 'wrong' })).status, 401);
    const r = await c.call('POST', '/api/auth/login', { username: 'bob', password: 'password123' });
    assert.equal(r.status, 429); assert.equal(r.body.error, 'rate_limited');
    c.advance(16 * 60 * 1000);
    const ok = await c.call('POST', '/api/auth/login', { username: 'bob', password: 'password123' });
    assert.equal(ok.status, 200);
    const tok = ok.body.token;
    assert.equal((await c.call('GET', '/api/auth/me', undefined, tok)).body.user.username, 'bob');
    const at = await c.call('POST', '/api/tokens', { name: 'ci' }, tok);
    assert.equal(at.status, 201); assert.ok(at.body.token);
    assert.equal((await c.call('GET', '/api/auth/me', undefined, at.body.token)).status, 200);
    const list = await c.call('GET', '/api/tokens', undefined, tok);
    assert.equal(list.body.length, 1); assert.equal(list.body[0].token, undefined);
    assert.equal((await c.call('DELETE', `/api/tokens/${at.body.id}`, undefined, tok)).status, 204);
    assert.equal((await c.call('GET', '/api/auth/me', undefined, at.body.token)).status, 401);
    const p = await c.call('PATCH', '/api/auth/me', { displayName: 'Bobby', currentPassword: 'password123' }, tok);
    assert.equal(p.body.user.displayName, 'Bobby');
    assert.equal((await c.call('POST', '/api/auth/logout', undefined, tok)).status, 204);
    assert.equal((await c.call('GET', '/api/auth/me', undefined, tok)).status, 401);
  } finally { c.close(); }
});

test('rbac, guests, last admin', async () => {
  const c = await setup();
  try {
    const { alice, ws, pr } = await basic(c);
    const bob = await c.user('bob'); const gus = await c.user('gus'); const eve = await c.user('eve');
    assert.equal((await c.call('POST', `/api/workspaces/${ws.id}/members`, { username: 'bob', role: 'member' }, alice.token)).status, 201);
    assert.equal((await c.call('POST', `/api/workspaces/${ws.id}/members`, { username: 'gus', role: 'guest' }, alice.token)).status, 201);
    assert.equal((await c.call('POST', `/api/workspaces/${ws.id}/members`, { username: 'eve', role: 'guest' }, bob.token)).status, 403);
    assert.equal((await c.call('GET', `/api/projects/${pr.id}`, undefined, gus.token)).status, 403);
    assert.equal((await c.call('GET', `/api/projects/${pr.id}`, undefined, eve.token)).status, 403);
    assert.equal((await c.call('GET', `/api/projects/nope`, undefined, eve.token)).status, 404);
    assert.equal((await c.call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'X', key: 'XX' }, gus.token)).status, 403);
    assert.equal((await c.call('GET', `/api/workspaces/${ws.id}/projects`, undefined, gus.token)).body.length, 0);
    assert.equal((await c.call('POST', `/api/projects/${pr.id}/members`, { username: 'gus', role: 'viewer' }, alice.token)).status, 201);
    assert.equal((await c.call('GET', `/api/projects/${pr.id}`, undefined, gus.token)).status, 200);
    assert.equal((await c.call('POST', `/api/projects/${pr.id}/issues`, { title: 'x' }, gus.token)).status, 403);
    assert.equal((await c.call('POST', `/api/projects/${pr.id}/issues`, { title: 'x' }, bob.token)).status, 201);
    assert.equal((await c.call('DELETE', `/api/workspaces/${ws.id}/members/${alice.id}`, undefined, alice.token)).status, 400);
    assert.equal((await c.call('PATCH', `/api/workspaces/${ws.id}/members/${bob.id}`, { role: 'admin' }, alice.token)).status, 200);
    assert.equal((await c.call('DELETE', `/api/workspaces/${ws.id}/members/${alice.id}`, undefined, bob.token)).status, 204);
    const audit = await c.call('GET', `/api/workspaces/${ws.id}/audit`, undefined, bob.token);
    assert.ok(audit.body.some(a => a.action === 'member.added'));
    assert.ok(audit.body.some(a => a.action === 'member.removed'));
    assert.equal((await c.call('POST', '/api/workspaces', { name: 'B', key: 'ACME' }, bob.token)).status, 409);
    assert.equal((await c.call('POST', '/api/workspaces', { name: 'B', key: 'a' }, bob.token)).status, 400);
  } finally { c.close(); }
});

test('issues, workflow, links, history', async () => {
  const c = await setup();
  try {
    const { alice, pr } = await basic(c);
    assert.equal(pr.workflow.statuses.length, 5);
    const mk = async b => (await c.call('POST', `/api/projects/${pr.id}/issues`, b, alice.token));
    const a = (await mk({ type: 'task', title: 'A', storyPoints: 3 })).body;
    assert.equal(a.status, 'Todo');
    const b = (await mk({ type: 'bug', title: 'B' })).body;
    assert.equal(b.key, 'WEB-2');
    assert.equal((await mk({ type: 'subtask', title: 'S' })).status, 400);
    const s = (await mk({ type: 'subtask', title: 'S', parentId: a.id })).body;
    assert.equal((await mk({ type: 'subtask', title: 'S2', parentId: s.key })).status, 400);
    const epic = (await mk({ type: 'epic', title: 'E' })).body;
    assert.equal((await mk({ type: 'epic', title: 'E2', parentId: a.id })).status, 400);
    assert.equal((await mk({ type: 'task', title: 'T', epicId: a.id })).status, 400);
    await c.call('PATCH', `/api/issues/${a.key}`, { epicId: epic.id }, alice.token);
    let g = (await c.call('GET', `/api/issues/${a.key}`, undefined, alice.token)).body;
    assert.deepEqual(g.children, [s.key]);
    // links
    const l = await c.call('POST', `/api/issues/${b.key}/links`, { type: 'blocks', target: a.key }, alice.token);
    assert.equal(l.status, 201);
    g = (await c.call('GET', `/api/issues/${a.key}`, undefined, alice.token)).body;
    assert.ok(g.links.some(x => x.type === 'blocked_by' && x.key === b.key));
    const blocked = await c.call('PATCH', `/api/issues/${a.key}`, { status: 'Done' }, alice.token);
    assert.equal(blocked.status, 409); assert.equal(blocked.body.error, 'blocked');
    await c.call('PATCH', `/api/issues/${b.key}`, { status: 'Done' }, alice.token);
    const done = await c.call('PATCH', `/api/issues/${a.key}`, { status: 'Done' }, alice.token);
    assert.equal(done.status, 200); assert.ok(done.body.resolvedAt);
    const ep = (await c.call('GET', `/api/issues/${epic.key}`, undefined, alice.token)).body;
    assert.deepEqual(ep.progress, { total: 1, done: 1, points_total: 3, points_done: 3 });
    const re = await c.call('PATCH', `/api/issues/${a.key}`, { status: 'Todo' }, alice.token);
    assert.equal(re.body.resolvedAt, null);
    const hist = (await c.call('GET', `/api/issues/${a.key}/history`, undefined, alice.token)).body;
    assert.deepEqual(hist.map(h => h.field), ['epicId', 'status', 'status']);
    assert.equal(hist[1].from, 'Todo'); assert.equal(hist[1].to, 'Done');
    // custom workflow
    const bad = await c.call('PUT', `/api/projects/${pr.id}/workflow`, { statuses: [{ name: 'Open', category: 'unstarted' }, { name: 'Closed', category: 'completed' }], transitions: [['Open', 'Closed']] }, alice.token);
    assert.equal(bad.status, 400);
    const ok = await c.call('PUT', `/api/projects/${pr.id}/workflow`, { statuses: [{ name: 'Open', category: 'unstarted' }, { name: 'Closed', category: 'completed' }], transitions: [['Open', 'Closed']], remap: { Todo: 'Open', Done: 'Closed' } }, alice.token);
    assert.equal(ok.status, 200);
    g = (await c.call('GET', `/api/issues/${a.key}`, undefined, alice.token)).body;
    assert.equal(g.status, 'Open');
    const bkey = (await c.call('GET', `/api/issues/${b.key}`, undefined, alice.token)).body;
    assert.equal(bkey.status, 'Closed');
    const inv = await c.call('PATCH', `/api/issues/${b.key}`, { status: 'Open' }, alice.token);
    assert.equal(inv.status, 409); assert.equal(inv.body.error, 'invalid_transition');
    // delete parent deletes subtasks
    assert.equal((await c.call('DELETE', `/api/issues/${a.key}`, undefined, alice.token)).status, 204);
    assert.equal((await c.call('GET', `/api/issues/${s.key}`, undefined, alice.token)).status, 404);
    const n = (await mk({ title: 'after' })).body;
    assert.equal(n.key, 'WEB-5');
  } finally { c.close(); }
});

test('comments, mentions, watchers, notifications', async () => {
  const c = await setup();
  try {
    const { alice, ws, pr } = await basic(c);
    const bob = await c.user('bob'); const carl = await c.user('carl');
    await c.call('POST', `/api/workspaces/${ws.id}/members`, { username: 'bob', role: 'member' }, alice.token);
    const is = (await c.call('POST', `/api/projects/${pr.id}/issues`, { title: 'X', assigneeId: bob.id }, alice.token)).body;
    assert.deepEqual(is.watchers.sort(), [alice.id, bob.id].sort());
    await c.call('PATCH', `/api/issues/${is.key}`, { status: 'In Progress' }, alice.token);
    const cm = await c.call('POST', `/api/issues/${is.key}/comments`, { body: 'hey @carl and @bob' }, alice.token);
    assert.equal(cm.status, 201);
    const nb = (await c.call('GET', '/api/notifications?unread=true', undefined, bob.token)).body;
    assert.ok(nb.some(n => n.type === 'status_changed'));
    assert.ok(nb.some(n => n.type === 'mention'));
    assert.equal(nb[0].issueKey, is.key);
    assert.equal((await c.call('GET', '/api/notifications', undefined, carl.token)).body.length, 0);
    assert.equal((await c.call('GET', '/api/notifications', undefined, alice.token)).body.length, 0);
    await c.call('POST', '/api/notifications/read', { all: true }, bob.token);
    assert.equal((await c.call('GET', '/api/notifications?unread=true', undefined, bob.token)).body.length, 0);
    assert.equal((await c.call('PATCH', `/api/comments/${cm.body.id}`, { body: 'x' }, bob.token)).status, 403);
    const ed = await c.call('PATCH', `/api/comments/${cm.body.id}`, { body: 'edited' }, alice.token);
    assert.equal(ed.body.edited, true);
    await c.call('DELETE', `/api/issues/${is.key}/watch`, undefined, bob.token);
    await c.call('POST', `/api/issues/${is.key}/comments`, { body: 'again' }, alice.token);
    assert.equal((await c.call('GET', '/api/notifications?unread=true', undefined, bob.token)).body.length, 0);
  } finally { c.close(); }
});

test('sprints and burndown, stats', async () => {
  const c = await setup({ start: '2026-03-01T10:00:00Z' });
  try {
    const { alice, pr } = await basic(c);
    const sp = (await c.call('POST', `/api/projects/${pr.id}/sprints`, { name: 'S1', startDate: '2026-03-01', endDate: '2026-03-05' }, alice.token)).body;
    const sp2 = (await c.call('POST', `/api/projects/${pr.id}/sprints`, { name: 'S2' }, alice.token)).body;
    const a = (await c.call('POST', `/api/projects/${pr.id}/issues`, { title: 'A', storyPoints: 5, sprintId: sp.id }, alice.token)).body;
    const b = (await c.call('POST', `/api/projects/${pr.id}/issues`, { title: 'B', storyPoints: 3, sprintId: sp.id }, alice.token)).body;
    assert.equal((await c.call('POST', `/api/sprints/${sp.id}/start`, {}, alice.token)).status, 200);
    assert.equal((await c.call('POST', `/api/sprints/${sp2.id}/start`, {}, alice.token)).status, 409);
    c.advance(86400000);
    await c.call('PATCH', `/api/issues/${a.key}`, { status: 'In Progress' }, alice.token);
    c.advance(3600000 * 2);
    await c.call('PATCH', `/api/issues/${a.key}`, { status: 'Done' }, alice.token);
    c.advance(86400000);
    const rep = (await c.call('GET', `/api/sprints/${sp.id}/report`, undefined, alice.token)).body;
    assert.equal(rep.committedPoints, 8);
    assert.equal(rep.completedPoints, 5);
    assert.deepEqual(rep.burndown, [{ date: '2026-03-01', remainingPoints: 8 }, { date: '2026-03-02', remainingPoints: 3 }, { date: '2026-03-03', remainingPoints: 3 }]);
    const done = await c.call('POST', `/api/sprints/${sp.id}/complete`, { carryOverTo: sp2.id }, alice.token);
    assert.equal(done.status, 200);
    assert.equal((await c.call('GET', `/api/issues/${b.key}`, undefined, alice.token)).body.sprintId, sp2.id);
    const rep2 = (await c.call('GET', `/api/sprints/${sp.id}/report`, undefined, alice.token)).body;
    assert.equal(rep2.carriedOver, 1); assert.equal(rep2.completedIssues, 1);
    const st = (await c.call('GET', `/api/projects/${pr.id}/stats`, undefined, alice.token)).body;
    assert.equal(st.byStatus.Done, 1); assert.equal(st.byType.task, 2);
    assert.equal(st.averageCycleTimeHours, 2);
  } finally { c.close(); }
});

test('search query language', async () => {
  const c = await setup();
  try {
    const { alice, pr } = await basic(c);
    const mk = async b => (await c.call('POST', `/api/projects/${pr.id}/issues`, b, alice.token)).body;
    await mk({ type: 'bug', title: 'Login broken', priority: 'high', labels: ['auth'], storyPoints: 5, assigneeId: alice.id, dueDate: '2026-01-10' });
    await mk({ type: 'feature', title: 'Dark mode', description: 'nice theme', labels: ['wontfix'], storyPoints: 1 });
    const x = await mk({ type: 'task', title: 'Write docs', priority: 'low' });
    await c.call('PATCH', `/api/issues/${x.key}`, { status: 'In Progress' }, alice.token);
    const s = async q => (await c.call('GET', `/api/search?q=${encodeURIComponent(q)}`, undefined, alice.token));
    assert.deepEqual((await s('status:"In Progress"')).body.map(i => i.key), [x.key]);
    assert.equal((await s('type:bug')).body.length, 1);
    assert.equal((await s('assignee:me')).body.length, 1);
    assert.equal((await s('assignee:none')).body.length, 2);
    assert.equal((await s('-label:wontfix')).body.length, 2);
    assert.equal((await s('points:>3')).body.length, 1);
    assert.equal((await s('due:<2026-02-01')).body.length, 1);
    assert.equal((await s('THEME')).body.length, 1);
    assert.equal((await s('"dark mode"')).body.length, 1);
    assert.equal((await s('is:open')).body.length, 3);
    assert.equal((await s('key:WEB-1')).body.length, 1);
    assert.equal((await s('sprint:none')).body.length, 3);
    assert.equal((await s('status:"open')).status, 400);
    assert.equal((await s('bogus:1')).status, 400);
    assert.equal((await s('priority:mega')).status, 400);
    const pr2 = (await c.call('GET', `/api/search?q=&sort=priority`, undefined, alice.token)).body;
    assert.equal(pr2[0].priority, 'high');
    const upd = (await c.call('GET', `/api/search?q=`, undefined, alice.token)).body;
    assert.equal(upd[0].key, x.key);
    const eve = await c.user('eve');
    assert.equal((await c.call('GET', `/api/search?q=`, undefined, eve.token)).body.length, 0);
  } finally { c.close(); }
});

test('csv export/import', async () => {
  const c = await setup();
  try {
    const { alice, pr } = await basic(c);
    await c.call('POST', `/api/projects/${pr.id}/issues`, { title: 'Has, comma "q"', labels: ['a', 'b'], assigneeId: alice.id }, alice.token);
    const ex = await c.call('GET', `/api/projects/${pr.id}/export.csv`, undefined, alice.token);
    assert.equal(ex.status, 200);
    assert.match(ex.headers.get('content-type'), /text\/csv/);
    const lines = ex.body.split('\r\n');
    assert.equal(lines[0], 'key,type,title,status,priority,assignee,labels,storyPoints,parent,epic,sprint,dueDate,createdAt,resolvedAt');
    assert.ok(lines[1].startsWith('WEB-1,task,"Has, comma ""q""",Todo,none,alice,a;b,'));
    const csv = 'key,type,title,status,priority,assignee,labels,storyPoints,parent,epic,sprint,dueDate,createdAt,resolvedAt\r\n' +
      'X-1,bug,"Imported, one",Todo,high,alice,x;y,3,,,,2026-05-01,,\r\n' +
      'X-2,badtype,Nope,,,,,,,,,,,\r\n' +
      'X-3,subtask,Child,,,,,,WEB-1,,,,,\r\n';
    const im = await c.call('POST', `/api/projects/${pr.id}/import.csv`, csv, alice.token);
    assert.equal(im.status, 200);
    assert.equal(im.body.created, 2);
    assert.deepEqual(im.body.errors.map(e => e.line), [3]);
    const g = (await c.call('GET', `/api/issues/WEB-2`, undefined, alice.token)).body;
    assert.equal(g.title, 'Imported, one'); assert.deepEqual(g.labels, ['x', 'y']); assert.equal(g.storyPoints, 3);
  } finally { c.close(); }
});

test('webhooks with signature and retries', async () => {
  const received = [];
  let failNext = 2;
  const hook = http.createServer((req, res) => {
    let b = ''; req.on('data', d => { b += d; }); req.on('end', () => {
      received.push({ body: b, sig: req.headers['x-pm-signature'] });
      if (req.url === '/fail' && failNext-- > 0) { res.writeHead(500); return res.end(); }
      res.writeHead(200); res.end('ok');
    });
  });
  await new Promise(r => hook.listen(0, r));
  const hp = hook.address().port;
  const c = await setup();
  try {
    const { alice, pr, ws } = await basic(c);
    const w = await c.call('POST', `/api/projects/${pr.id}/webhooks`, { url: `http://127.0.0.1:${hp}/ok`, events: ['issue.created'], secret: 's3cret' }, alice.token);
    assert.equal(w.status, 201);
    const w2 = (await c.call('POST', `/api/projects/${pr.id}/webhooks`, { url: `http://127.0.0.1:${hp}/fail`, events: ['issue.created'], secret: 'x' }, alice.token)).body;
    await c.call('POST', `/api/projects/${pr.id}/issues`, { title: 'X' }, alice.token);
    await new Promise(r => setTimeout(r, 600));
    const okRec = received.find(r => JSON.parse(r.body).event === 'issue.created' && r.sig === 'sha256=' + crypto.createHmac('sha256', 's3cret').update(r.body).digest('hex'));
    assert.ok(okRec);
    const d = (await c.call('GET', `/api/webhooks/${w.body.id}/deliveries`, undefined, alice.token)).body;
    assert.equal(d[0].status, 200); assert.equal(d[0].attempts, 1);
    const d2 = (await c.call('GET', `/api/webhooks/${w2.id}/deliveries`, undefined, alice.token)).body;
    assert.equal(d2[0].status, 200); assert.equal(d2[0].attempts, 3);
    const audit = (await c.call('GET', `/api/workspaces/${ws.id}/audit`, undefined, alice.token)).body;
    assert.ok(audit.some(a => a.action === 'webhook.created'));
  } finally { c.close(); hook.close(); }
});

test('persistence and SPA', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-'));
  const dataFile = path.join(dir, 'db.json');
  let c = await setup({ dataFile });
  const { alice, pr } = await basic(c);
  await c.call('POST', `/api/projects/${pr.id}/issues`, { title: 'persist' }, alice.token);
  const html = await fetch(`http://127.0.0.1:${c.srv.address().port}/`);
  assert.match(await html.text(), /<div id="app">/);
  const js = await fetch(`http://127.0.0.1:${c.srv.address().port}/static/app.js`);
  assert.equal(js.status, 200);
  c.close();
  c = await setup({ dataFile });
  try {
    const g = await c.call('GET', '/api/issues/WEB-1', undefined, alice.token);
    assert.equal(g.body.title, 'persist');
  } finally { c.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
