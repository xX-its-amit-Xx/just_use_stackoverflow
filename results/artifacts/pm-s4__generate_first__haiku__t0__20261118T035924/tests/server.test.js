import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { createServer } from '../src/server.js';
import { parseCsv } from '../src/csv.js';
import { parseQuery } from '../src/search.js';

function makeClock(iso) {
  const c = { now: new Date(iso) };
  c.fn = () => c.now;
  c.set = (s) => { c.now = new Date(s); };
  return c;
}

async function start(opts = {}) {
  const srv = createServer(opts);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, p, body, token, raw) => {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    let payload;
    if (raw !== undefined) { headers['content-type'] = 'text/csv'; payload = raw; }
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(base + p, { method, headers, body: payload });
    const text = await r.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: r.status, body: data, text };
  };
  return { srv, base, call, close: () => new Promise((r) => srv.close(r)) };
}

async function userWithToken(t, username, password = 'password123') {
  await t.call('POST', '/api/auth/register', { username, password });
  const { body } = await t.call('POST', '/api/auth/login', { username, password });
  return { token: body.token, user: body.user };
}

async function setup(t) {
  const alice = await userWithToken(t, 'alice');
  const ws = (await t.call('POST', '/api/workspaces', { name: 'Acme', key: 'ACME' }, alice.token)).body;
  const pr = (await t.call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Web', key: 'WEB' }, alice.token)).body;
  return { alice, ws, pr };
}

test('auth: register, login, me, rate limit, logout', async () => {
  const t = await start({ clock: makeClock('2026-01-01T10:00:00Z').fn });
  try {
    const reg = await t.call('POST', '/api/auth/register', { username: 'bob', password: 'password123', displayName: 'Bob B' });
    assert.equal(reg.status, 201);
    assert.equal(reg.body.user.displayName, 'Bob B');
    assert.equal((await t.call('POST', '/api/auth/register', { username: 'bob', password: 'password123' })).status, 409);
    assert.equal((await t.call('POST', '/api/auth/register', { username: 'x', password: 'short' })).status, 400);
    for (let i = 0; i < 5; i++) {
      const r = await t.call('POST', '/api/auth/login', { username: 'bob', password: 'wrong-password' });
      assert.equal(r.status, 401);
      assert.equal(r.body.error, 'invalid_credentials');
    }
    const locked = await t.call('POST', '/api/auth/login', { username: 'bob', password: 'password123' });
    assert.equal(locked.status, 429);
    assert.equal((await t.call('GET', '/api/auth/me')).status, 401);
  } finally {
    await t.close();
  }
});

test('auth: login, me, patch, logout and api tokens', async () => {
  const t = await start();
  try {
    const { token, user } = await userWithToken(t, 'carol');
    assert.equal((await t.call('GET', '/api/auth/me', undefined, token)).body.user.id, user.id);
    assert.equal((await t.call('PATCH', '/api/auth/me', { displayName: 'Carol' }, token)).status, 400);
    const p = await t.call('PATCH', '/api/auth/me', { displayName: 'Carol C', currentPassword: 'password123' }, token);
    assert.equal(p.body.user.displayName, 'Carol C');
    const api = await t.call('POST', '/api/tokens', { name: 'ci' }, token);
    assert.equal(api.status, 201);
    assert.ok(api.body.token);
    const list = await t.call('GET', '/api/tokens', undefined, token);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].token, undefined);
    assert.equal((await t.call('GET', '/api/auth/me', undefined, api.body.token)).status, 200);
    await t.call('POST', '/api/auth/logout', undefined, token);
    assert.equal((await t.call('GET', '/api/auth/me', undefined, token)).status, 401);
  } finally {
    await t.close();
  }
});

test('workspaces, members, RBAC and projects', async () => {
  const t = await start();
  try {
    const { alice, ws, pr } = await setup(t);
    assert.equal(ws.key, 'ACME');
    assert.equal((await t.call('POST', '/api/workspaces', { name: 'X', key: 'ACME' }, alice.token)).status, 409);
    assert.equal((await t.call('POST', '/api/workspaces', { name: 'X', key: 'acme' }, alice.token)).status, 400);
    const bob = await userWithToken(t, 'bob');
    const carol = await userWithToken(t, 'carol');
    assert.equal((await t.call('GET', `/api/projects/${pr.id}`, undefined, bob.token)).status, 403);
    assert.equal((await t.call('POST', `/api/workspaces/${ws.id}/members`, { username: 'bob', role: 'member' }, alice.token)).status, 201);
    assert.equal((await t.call('POST', `/api/workspaces/${ws.id}/members`, { username: 'carol', role: 'guest' }, alice.token)).status, 201);
    // member without project membership: no access
    assert.equal((await t.call('GET', `/api/projects/${pr.id}`, undefined, bob.token)).status, 403);
    // guests cannot create projects
    assert.equal((await t.call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'G', key: 'GG' }, carol.token)).status, 403);
    // member can create projects
    assert.equal((await t.call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'B', key: 'BEE' }, bob.token)).status, 201);
    // add bob to WEB as developer; carol as guest can't see it until added
    assert.equal((await t.call('POST', `/api/projects/${pr.id}/members`, { username: 'bob', role: 'developer' }, alice.token)).status, 201);
    assert.equal((await t.call('GET', `/api/projects/${pr.id}`, undefined, bob.token)).status, 200);
    assert.equal((await t.call('GET', `/api/workspaces/${ws.id}/projects`, undefined, carol.token)).body.length, 0);
    // last admin cannot be removed
    const members = (await t.call('GET', `/api/workspaces/${ws.id}/members`, undefined, alice.token)).body;
    assert.equal(members.length, 3);
    assert.equal((await t.call('PATCH', `/api/workspaces/${ws.id}/members/alice`, { role: 'member' }, alice.token)).status, 400);
    assert.equal((await t.call('DELETE', `/api/workspaces/${ws.id}/members/alice`, undefined, alice.token)).status, 400);
    // non-admin cannot manage members
    assert.equal((await t.call('POST', `/api/workspaces/${ws.id}/members`, { username: 'carol', role: 'member' }, bob.token)).status, 403);
  } finally {
    await t.close();
  }
});

test('issues: keys, initial status, workflow transitions, resolvedAt, subtasks, epics, progress', async () => {
  const clock = makeClock('2026-03-02T09:00:00Z');
  const t = await start({ clock: clock.fn });
  try {
    const { alice, pr } = await setup(t);
    const a = (body) => t.call('POST', `/api/projects/${pr.id}/issues`, body, alice.token);
    const i1 = await a({ type: 'task', title: 'Hello' });
    assert.equal(i1.status, 201);
    assert.equal(i1.body.key, 'WEB-1');
    assert.equal(i1.body.status, 'Todo');
    assert.equal(i1.body.priority, 'none');
    const epic = (await a({ type: 'epic', title: 'Big', storyPoints: 5 })).body;
    assert.equal(epic.key, 'WEB-2');
    const sub = await a({ type: 'subtask', title: 'child', parentId: i1.body.id });
    assert.equal(sub.status, 201);
    assert.equal((await a({ type: 'subtask', title: 'orphan' })).status, 400);
    assert.equal((await a({ type: 'epic', title: 'x', parentId: i1.body.id })).status, 400);
    assert.equal((await a({ type: 'task', title: 'x', epicId: i1.body.id })).status, 400);
    const child = await a({ type: 'task', title: 'in epic', epicId: epic.id, storyPoints: 3 });
    assert.equal(child.status, 201);
    const parent = (await t.call('GET', `/api/issues/WEB-1`, undefined, alice.token)).body;
    assert.deepEqual(parent.children, ['WEB-3']);

    // transitions: Todo -> Done allowed in default workflow (any -> any)
    const done = await t.call('PATCH', '/api/issues/WEB-1', { status: 'Done' }, alice.token);
    assert.equal(done.status, 200);
    assert.ok(done.body.resolvedAt);
    const reopened = await t.call('PATCH', '/api/issues/WEB-1', { status: 'In Progress' }, alice.token);
    assert.equal(reopened.body.resolvedAt, null);

    // custom workflow: only Todo->In Progress->Done
    const wf = await t.call('PUT', `/api/projects/${pr.id}/workflow`, {
      statuses: [
        { name: 'Todo', category: 'unstarted' },
        { name: 'In Progress', category: 'started' },
        { name: 'Done', category: 'completed' },
      ],
      transitions: [['Todo', 'In Progress'], ['In Progress', 'Done']],
    }, alice.token);
    assert.equal(wf.status, 200);
    const bad = await t.call('PATCH', '/api/issues/WEB-2', { status: 'Done' }, alice.token);
    assert.equal(bad.status, 409);
    assert.equal(bad.body.error, 'invalid_transition');
    // removing an in-use status without remap is rejected
    const noRemap = await t.call('PUT', `/api/projects/${pr.id}/workflow`, {
      statuses: [{ name: 'Todo', category: 'unstarted' }, { name: 'Done', category: 'completed' }],
      transitions: [['Todo', 'Done']],
    }, alice.token);
    assert.equal(noRemap.status, 400);

    // epic progress
    await t.call('PATCH', '/api/issues/WEB-4', { status: 'In Progress' }, alice.token);
    await t.call('PATCH', '/api/issues/WEB-4', { status: 'Done' }, alice.token);
    const ep = (await t.call('GET', '/api/issues/WEB-2', undefined, alice.token)).body;
    assert.deepEqual(ep.progress, { total: 1, done: 1, points_total: 3, points_done: 3 });

    // deleting parent deletes subtasks
    assert.equal((await t.call('DELETE', '/api/issues/WEB-1', undefined, alice.token)).status, 204);
    assert.equal((await t.call('GET', '/api/issues/WEB-3', undefined, alice.token)).status, 404);

    // history
    const hist = (await t.call('GET', '/api/issues/WEB-4/history', undefined, alice.token)).body;
    assert.ok(hist.some((h) => h.field === 'status' && h.to === 'Done'));
  } finally {
    await t.close();
  }
});

test('links, blocked transitions, comments, mentions, watchers and notifications', async () => {
  const t = await start();
  try {
    const { alice, pr, ws } = await setup(t);
    const bob = await userWithToken(t, 'bob');
    await t.call('POST', `/api/workspaces/${ws.id}/members`, { username: 'bob', role: 'member' }, alice.token);
    await t.call('POST', `/api/projects/${pr.id}/members`, { username: 'bob', role: 'developer' }, alice.token);
    const mk = (title) => t.call('POST', `/api/projects/${pr.id}/issues`, { title, type: 'task' }, alice.token);
    await mk('blocker');
    await mk('blocked');
    const link = await t.call('POST', '/api/issues/WEB-2/links', { type: 'blocks', target: 'WEB-1' }, alice.token);
    assert.equal(link.status, 201);
    const blocker = (await t.call('GET', '/api/issues/WEB-1', undefined, alice.token)).body;
    assert.deepEqual(blocker.links, [{ type: 'blocked_by', target: 'WEB-2' }]);
    const blockedDone = await t.call('PATCH', '/api/issues/WEB-1', { status: 'Done' }, alice.token);
    assert.equal(blockedDone.status, 409);
    assert.equal(blockedDone.body.error, 'blocked');
    // comments and mentions
    const c = await t.call('POST', '/api/issues/WEB-1/comments', { body: 'hey @bob please look' }, alice.token);
    assert.equal(c.status, 201);
    const bobNotes = (await t.call('GET', '/api/notifications?unread=true', undefined, bob.token)).body;
    assert.ok(bobNotes.some((n) => n.type === 'mention' && n.issueKey === 'WEB-1'));
    assert.equal((await t.call('PATCH', `/api/comments/${c.body.id}`, { body: 'edited' }, bob.token)).status, 403);
    const edited = await t.call('PATCH', `/api/comments/${c.body.id}`, { body: 'edited' }, alice.token);
    assert.equal(edited.body.edited, true);
    // assignment notifies watchers (bob becomes assignee and watcher, actor excluded)
    await t.call('PATCH', '/api/issues/WEB-1', { assigneeId: bob.user.id }, alice.token);
    const bobAfter = (await t.call('POST', '/api/notifications/read', { all: true }, bob.token)).body;
    assert.ok(bobAfter.updated >= 1);
    await t.call('PATCH', '/api/issues/WEB-1', { status: 'In Progress' }, bob.token);
    const aliceNotes = (await t.call('GET', '/api/notifications', undefined, alice.token)).body;
    assert.ok(!aliceNotes.some((n) => n.actorId === alice.user.id));
    const bobNotes2 = (await t.call('GET', '/api/notifications', undefined, bob.token)).body;
    assert.equal(bobNotes2[0].read, true);
    // unlink
    assert.equal((await t.call('DELETE', '/api/issues/WEB-2/links/blocks/WEB-1', undefined, alice.token)).status, 204);
    assert.equal((await t.call('PATCH', '/api/issues/WEB-1', { status: 'Done' }, alice.token)).status, 200);
  } finally {
    await t.close();
  }
});

test('sprints, report and burndown with injected clock', async () => {
  const clock = makeClock('2026-04-01T12:00:00Z');
  const t = await start({ clock: clock.fn });
  try {
    const { alice, pr } = await setup(t);
    const mk = (title, storyPoints) => t.call('POST', `/api/projects/${pr.id}/issues`, { title, type: 'task', storyPoints }, alice.token);
    await mk('a', 3);
    await mk('b', 5);
    const sp = await t.call('POST', `/api/projects/${pr.id}/sprints`, { name: 'S1', startDate: '2026-04-01', endDate: '2026-04-05' }, alice.token);
    assert.equal(sp.status, 201);
    const sid = sp.body.id;
    for (const k of ['WEB-1', 'WEB-2']) {
      assert.equal((await t.call('PATCH', `/api/issues/${k}`, { sprintId: sid }, alice.token)).status, 200);
    }
    assert.equal((await t.call('POST', `/api/sprints/${sid}/start`, undefined, alice.token)).status, 200);
    const second = (await t.call('POST', `/api/projects/${pr.id}/sprints`, { name: 'S2' }, alice.token)).body;
    assert.equal((await t.call('POST', `/api/sprints/${second.id}/start`, undefined, alice.token)).status, 409);
    clock.set('2026-04-02T12:00:00Z');
    await t.call('PATCH', '/api/issues/WEB-1', { status: 'Done' }, alice.token);
    clock.set('2026-04-02T18:00:00Z');
    clock.set('2026-04-03T12:00:00Z');
    let report = (await t.call('GET', `/api/sprints/${sid}/report`, undefined, alice.token)).body;
    assert.equal(report.committedPoints, 8);
    assert.equal(report.completedPoints, 3);
    assert.deepEqual(report.completedIssues, ['WEB-1']);
    assert.deepEqual(report.burndown.map((d) => d.date), ['2026-04-01', '2026-04-02', '2026-04-03']);
    assert.deepEqual(report.burndown.map((d) => d.remainingPoints), [8, 5, 5]);
    const done = await t.call('POST', `/api/sprints/${sid}/complete`, { carryOverTo: 'backlog' }, alice.token);
    assert.equal(done.body.state, 'completed');
    report = (await t.call('GET', `/api/sprints/${sid}/report`, undefined, alice.token)).body;
    assert.deepEqual(report.carriedOver, ['WEB-2']);
    const issue2 = (await t.call('GET', '/api/issues/WEB-2', undefined, alice.token)).body;
    assert.equal(issue2.sprintId, null);
    const stats = (await t.call('GET', `/api/projects/${pr.id}/stats`, undefined, alice.token)).body;
    assert.equal(stats.total, 2);
    assert.equal(stats.byStatus.Done, 1);
    assert.equal(typeof stats.avgCycleTimeHours, 'number');
  } finally {
    await t.close();
  }
});

test('search query language', async () => {
  const t = await start();
  try {
    const { alice, pr } = await setup(t);
    const mk = (body) => t.call('POST', `/api/projects/${pr.id}/issues`, { type: 'task', ...body }, alice.token);
    await mk({ title: 'Login bug', type: 'bug', priority: 'high', labels: ['auth'], storyPoints: 5, dueDate: '2026-01-10' });
    await mk({ title: 'Docs wording', labels: ['wontfix'], storyPoints: 1, description: 'Fix the Login text' });
    await mk({ title: 'Other', priority: 'low' });
    await t.call('PATCH', '/api/issues/WEB-2', { status: 'Done' }, alice.token);
    const q = async (s) => (await t.call('GET', `/api/search?q=${encodeURIComponent(s)}`, undefined, alice.token));
    assert.deepEqual((await q('type:bug')).body.map((i) => i.key), ['WEB-1']);
    assert.deepEqual((await q('login')).body.map((i) => i.key).sort(), ['WEB-1', 'WEB-2']);
    assert.deepEqual((await q('-label:wontfix login')).body.map((i) => i.key), ['WEB-1']);
    assert.deepEqual((await q('points:>3')).body.map((i) => i.key), ['WEB-1']);
    assert.deepEqual((await q('due:<2027-01-01')).body.map((i) => i.key), ['WEB-1']);
    assert.deepEqual((await q('is:resolved')).body.map((i) => i.key), ['WEB-2']);
    assert.deepEqual((await q('status:"Done"')).body.map((i) => i.key), ['WEB-2']);
    assert.deepEqual((await q('key:web-1')).body.map((i) => i.key), ['WEB-1']);
    assert.deepEqual((await q('priority:high')).body.map((i) => i.key), ['WEB-1']);
    assert.deepEqual((await q('priority:high')).body.map((i) => i.key), ['WEB-1']);
    assert.equal((await q('points:abc')).status, 400);
    assert.equal((await q('"unterminated')).status, 400);
    assert.equal((await q('type:wibble')).status, 400);
    assert.deepEqual((await q('"Login text"')).body.map((i) => i.key), ['WEB-2']);
    const outsider = await userWithToken(t, 'mallory');
    assert.equal((await t.call('GET', '/api/search?q=login', undefined, outsider.token)).body.length, 0);
    assert.throws(() => parseQuery('bogus:1'));
  } finally {
    await t.close();
  }
});

test('csv export and import with per-row errors', async () => {
  const t = await start();
  try {
    const { alice, pr } = await setup(t);
    await t.call('POST', `/api/projects/${pr.id}/issues`, { type: 'task', title: 'Has, comma "quote"', labels: ['a', 'b'], storyPoints: 2 }, alice.token);
    const exp = await t.call('GET', `/api/projects/${pr.id}/export.csv`, undefined, alice.token);
    assert.equal(exp.status, 200);
    const records = parseCsv(exp.text);
    assert.deepEqual(records[0].fields, ['key', 'type', 'title', 'status', 'priority', 'assignee', 'labels', 'storyPoints', 'parent', 'epic', 'sprint', 'dueDate', 'createdAt', 'resolvedAt']);
    assert.equal(records[1].fields[2], 'Has, comma "quote"');
    assert.equal(records[1].fields[6], 'a;b');
    const csv = [
      'key,type,title,status,priority,assignee,labels,storyPoints,parent,epic,sprint,dueDate,createdAt,resolvedAt',
      'ignored,task,Imported one,,high,alice,x;y,3,,,,2026-05-01,,',
      'ignored,task,,,,,,,,,,,,',
      'ignored,task,Bad status,Nope,,,,,,,,,,',
      'ignored,task,Bad date,,,,,,,,,2026-13-01,,',
    ].join('\n');
    const imp = await t.call('POST', `/api/projects/${pr.id}/import.csv`, undefined, alice.token, csv);
    assert.equal(imp.status, 200);
    assert.equal(imp.body.created, 1);
    assert.equal(imp.body.errors.length, 3);
    assert.deepEqual(imp.body.errors.map((e) => e.line), [3, 4, 5]);
    const got = (await t.call('GET', '/api/search?q=key:WEB-2', undefined, alice.token)).body[0];
    assert.equal(got.title, 'Imported one');
    assert.equal(got.priority, 'high');
    assert.deepEqual(got.labels, ['x', 'y']);
    assert.equal(got.dueDate, '2026-05-01');
  } finally {
    await t.close();
  }
});

test('webhooks deliver signed payloads and record deliveries', async () => {
  const received = [];
  const hook = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(received.length === 1 ? 500 : 200);
      res.end('ok');
    });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const t = await start();
  try {
    const { alice, pr } = await setup(t);
    const url = `http://127.0.0.1:${hook.address().port}/hook`;
    const wh = await t.call('POST', `/api/projects/${pr.id}/webhooks`, { url, events: ['issue.created'], secret: 's3cret' }, alice.token);
    assert.equal(wh.status, 201);
    await t.call('POST', `/api/projects/${pr.id}/issues`, { type: 'task', title: 'hook me' }, alice.token);
    for (let i = 0; i < 100 && received.length < 2; i++) await new Promise((r) => setTimeout(r, 30));
    assert.equal(received.length, 2);
    const expected = 'sha256=' + crypto.createHmac('sha256', 's3cret').update(received[1].body).digest('hex');
    assert.equal(received[1].headers['x-pm-signature'], expected);
    const payload = JSON.parse(received[1].body);
    assert.equal(payload.event, 'issue.created');
    assert.equal(payload.issue.key, 'WEB-1');
    const dels = (await t.call('GET', `/api/webhooks/${wh.body.id}/deliveries`, undefined, alice.token)).body;
    assert.equal(dels.length, 1);
    assert.equal(dels[0].status, 200);
    assert.equal(dels[0].attempts, 2);
    const audit = (await t.call('GET', `/api/workspaces/${pr.workspaceId}/audit`, undefined, alice.token)).body;
    assert.ok(audit.some((a) => a.action === 'webhook.created'));
  } finally {
    hook.close();
    await t.close();
  }
});

test('persistence to dataFile and reload', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-s4-test-'));
  const file = path.join(dir, 'data.json');
  let t = await start({ dataFile: file });
  let key;
  try {
    const { alice, pr } = await setup(t);
    key = pr.key;
    await t.call('POST', `/api/projects/${pr.id}/issues`, { type: 'task', title: 'persist' }, alice.token);
  } finally {
    await t.close();
  }
  t = await start({ dataFile: file });
  try {
    const login = await t.call('POST', '/api/auth/login', { username: 'alice', password: 'password123' });
    const issue = await t.call('GET', `/api/issues/${key}-1`, undefined, login.body.token);
    assert.equal(issue.body.title, 'persist');
  } finally {
    await t.close();
  }
});

test('static UI is served and unknown routes return JSON 404', async () => {
  const t = await start();
  try {
    const index = await fetch(`${t.base}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /<div id="app">/);
    const js = await fetch(`${t.base}/static/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    const traversal = await fetch(`${t.base}/static/%2e%2e%2f%2e%2e%2fpackage.json`);
    assert.doesNotMatch(await traversal.text(), /"name": "pm-s4"/);
    assert.equal((await t.call('GET', '/api/nope')).status, 404);
  } finally {
    await t.close();
  }
});
