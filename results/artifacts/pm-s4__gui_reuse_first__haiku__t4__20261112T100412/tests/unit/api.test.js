import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { createServer } from '../../src/server.js';

// Starts a server with an injectable clock and returns helpers.
async function start(opts = {}) {
  let t = opts.start ? Date.parse(opts.start) : Date.parse('2026-03-02T10:00:00Z');
  const clock = () => new Date(t);
  const srv = createServer({ clock, ...opts.serverOpts });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, p, body, token, headers = {}) => {
    const isText = typeof body === 'string';
    const res = await fetch(base + p, {
      method,
      headers: {
        ...(isText ? { 'content-type': 'text/csv' } : body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : isText ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json, text, headers: res.headers };
  };
  const user = async (username, password = 'password123') => {
    await call('POST', '/api/auth/register', { username, password });
    const r = await call('POST', '/api/auth/login', { username, password });
    return { token: r.body.token, id: r.body.user.id };
  };
  return {
    srv, base, call, user,
    advance: (ms) => { t += ms; },
    setTime: (iso) => { t = Date.parse(iso); },
    close: () => new Promise((r) => { srv.closeAllConnections?.(); srv.close(r); }),
  };
}

async function setup() {
  const env = await start();
  const alice = await env.user('alice');
  const ws = (await env.call('POST', '/api/workspaces', { name: 'Acme', key: 'ACME' }, alice.token)).body;
  const proj = (await env.call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Web', key: 'WEB' }, alice.token)).body;
  return { ...env, alice, ws, proj };
}

test('auth: register, login, me, rate limiting, logout', async () => {
  const env = await start();
  try {
    const dup = await env.call('POST', '/api/auth/register', { username: 'bob', password: 'password123' });
    assert.equal(dup.status, 201);
    assert.equal((await env.call('POST', '/api/auth/register', { username: 'bob', password: 'password123' })).status, 409);
    assert.equal((await env.call('POST', '/api/auth/register', { username: 'x', password: 'short' })).status, 400);
    const ok = await env.call('POST', '/api/auth/login', { username: 'bob', password: 'password123' });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.token);
    assert.equal((await env.call('GET', '/api/auth/me', undefined, ok.body.token)).body.user.username, 'bob');
    assert.equal((await env.call('GET', '/api/auth/me')).status, 401);
    for (let i = 0; i < 5; i++) {
      assert.equal((await env.call('POST', '/api/auth/login', { username: 'bob', password: 'nope-nope' })).status, 401);
    }
    assert.equal((await env.call('POST', '/api/auth/login', { username: 'bob', password: 'password123' })).status, 429);
    const lo = await env.call('POST', '/api/auth/logout', undefined, ok.body.token);
    assert.equal(lo.status, 204);
    assert.equal((await env.call('GET', '/api/auth/me', undefined, ok.body.token)).status, 401);
  } finally { await env.close(); }
});

test('auth: password hashing is salted and PATCH /me needs currentPassword', async () => {
  const env = await start();
  try {
    const u = await env.user('carol');
    const bad = await env.call('PATCH', '/api/auth/me', { displayName: 'Carol' }, u.token);
    assert.equal(bad.status, 400);
    const wrong = await env.call('PATCH', '/api/auth/me', { displayName: 'Carol', currentPassword: 'nope-nope' }, u.token);
    assert.equal(wrong.status, 403);
    const ok = await env.call('PATCH', '/api/auth/me', { displayName: 'Carol C', currentPassword: 'password123' }, u.token);
    assert.equal(ok.body.user.displayName, 'Carol C');
  } finally { await env.close(); }
});

test('personal API tokens authenticate and are listed without secrets', async () => {
  const env = await start();
  try {
    const u = await env.user('dan');
    const t = await env.call('POST', '/api/tokens', { name: 'ci' }, u.token);
    assert.equal(t.status, 201);
    assert.ok(t.body.token);
    const me = await env.call('GET', '/api/auth/me', undefined, t.body.token);
    assert.equal(me.status, 200);
    const list = await env.call('GET', '/api/tokens', undefined, u.token);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].token, undefined);
    assert.equal((await env.call('DELETE', `/api/tokens/${t.body.id}`, undefined, u.token)).status, 204);
    assert.equal((await env.call('GET', '/api/auth/me', undefined, t.body.token)).status, 401);
  } finally { await env.close(); }
});

test('workspaces: admin, members, last-admin protection, guests', async () => {
  const { call, alice, ws, close, user } = await setup();
  try {
    const bob = await user('bob');
    assert.equal((await call('GET', `/api/workspaces/${ws.id}`, undefined, bob.token)).status, 403);
    assert.equal((await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'bob', role: 'member' }, alice.token)).status, 201);
    assert.equal((await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'bob', role: 'member' }, alice.token)).status, 409);
    assert.equal((await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'bob', role: 'member' }, bob.token)).status, 403);
    assert.equal((await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'nobody', role: 'member' }, alice.token)).status, 404);
    assert.equal((await call('DELETE', `/api/workspaces/${ws.id}/members/${alice.id}`, undefined, alice.token)).status, 400);
    const carol = await user('carol');
    await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'carol', role: 'guest' }, alice.token);
    assert.equal((await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'G', key: 'GGG' }, carol.token)).status, 403);
    const audit = await call('GET', `/api/workspaces/${ws.id}/audit`, undefined, alice.token);
    assert.equal(audit.status, 200);
    assert.ok(audit.body.some((a) => a.action === 'member.added'));
  } finally { await close(); }
});

test('projects: default workflow, guest visibility, 403 without access', async () => {
  const { call, alice, ws, proj, close, user } = await setup();
  try {
    assert.deepEqual(proj.workflow.statuses.map((s) => s.name), ['Backlog', 'Todo', 'In Progress', 'In Review', 'Done']);
    assert.equal((await call('GET', `/api/projects/${proj.id}`, undefined, alice.token)).status, 200);
    const carol = await user('carol');
    await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'carol', role: 'guest' }, alice.token);
    assert.equal((await call('GET', `/api/projects/${proj.id}`, undefined, carol.token)).status, 403);
    assert.equal((await call('POST', `/api/projects/${proj.id}/members`, { username: 'carol', role: 'viewer' }, alice.token)).status, 201);
    const got = await call('GET', `/api/projects/${proj.id}`, undefined, carol.token);
    assert.equal(got.status, 200);
    assert.equal(got.body.myRole, 'viewer');
    assert.equal((await call('GET', '/api/projects/nope', undefined, alice.token)).status, 404);
  } finally { await close(); }
});

test('issues: sequential keys, subtasks, epics, links, blocking', async () => {
  const { call, alice, proj, close } = await setup();
  try {
    const mk = (body) => call('POST', `/api/projects/${proj.id}/issues`, body, alice.token);
    const a = await mk({ type: 'task', title: 'Hello' });
    assert.equal(a.status, 201);
    assert.equal(a.body.key, 'WEB-1');
    const epic = (await mk({ type: 'epic', title: 'Epic', storyPoints: 3 })).body;
    const sub = await mk({ type: 'subtask', title: 'Sub', parentId: a.body.key });
    assert.equal(sub.status, 201);
    assert.equal((await mk({ type: 'subtask', title: 'bad' })).status, 400);
    assert.equal((await mk({ type: 'subtask', title: 'bad', parentId: sub.body.key })).status, 400);
    assert.equal((await mk({ type: 'epic', title: 'bad', parentId: a.body.key })).status, 400);
    const child = await mk({ type: 'task', title: 'Child', epicId: epic.key, storyPoints: 2 });
    assert.equal(child.status, 201);
    assert.equal((await mk({ type: 'task', title: 'x', epicId: a.body.key })).status, 400);
    const e = (await call('GET', `/api/issues/${epic.key}`, undefined, alice.token)).body;
    assert.deepEqual(e.progress, { total: 1, done: 0, points_total: 2, points_done: 0 });
    const parent = (await call('GET', `/api/issues/${a.body.key}`, undefined, alice.token)).body;
    assert.deepEqual(parent.children, [sub.body.key]);

    const l = await call('POST', `/api/issues/${a.body.key}/links`, { type: 'blocks', target: child.body.key }, alice.token);
    assert.equal(l.status, 201);
    const target = (await call('GET', `/api/issues/${child.body.key}`, undefined, alice.token)).body;
    assert.ok(target.links.some((x) => x.type === 'blocked_by' && x.key === a.body.key));
    const blocked = await call('PATCH', `/api/issues/${child.body.key}`, { status: 'Done' }, alice.token);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, 'blocked');
    await call('PATCH', `/api/issues/${a.body.key}`, { status: 'Done' }, alice.token);
    const ok = await call('PATCH', `/api/issues/${child.body.key}`, { status: 'Done' }, alice.token);
    assert.equal(ok.status, 200);
    assert.ok(ok.body.resolvedAt);

    // deleting a parent deletes its subtasks
    assert.equal((await call('DELETE', `/api/issues/${a.body.key}`, undefined, alice.token)).status, 204);
    assert.equal((await call('GET', `/api/issues/${sub.body.key}`, undefined, alice.token)).status, 404);
  } finally { await close(); }
});

test('workflow transitions, remap, history', async () => {
  const { call, alice, proj, close } = await setup();
  try {
    const i = (await call('POST', `/api/projects/${proj.id}/issues`, { type: 'bug', title: 'B' }, alice.token)).body;
    const r = await call('PATCH', `/api/issues/${i.key}`, { status: 'Done' }, alice.token);
    assert.equal(r.status, 200);
    const hist = (await call('GET', `/api/issues/${i.key}/history`, undefined, alice.token)).body;
    // initial status is the first "unstarted" status (Todo in the default workflow)
    assert.deepEqual(hist.map((h) => [h.field, h.from, h.to]), [['status', 'Todo', 'Done']]);
    assert.ok(Object.keys(hist[0]).every((k) => ['field', 'from', 'to', 'actorId', 'at'].includes(k)));

    // custom workflow: only Todo -> Done allowed
    const wf = await call('PUT', `/api/projects/${proj.id}/workflow`, {
      statuses: [{ name: 'Todo', category: 'unstarted' }, { name: 'Done', category: 'completed' }, { name: 'Doing', category: 'started' }],
      transitions: [['Todo', 'Done']],
    }, alice.token);
    assert.equal(wf.status, 200);
    // i is in Done which was kept; removing "Backlog" was not in use anymore
    const x = (await call('POST', `/api/projects/${proj.id}/issues`, { type: 'task', title: 'X', status: 'Todo' }, alice.token)).body;
    assert.equal((await call('PATCH', `/api/issues/${x.key}`, { status: 'Doing' }, alice.token)).status, 409);
    assert.equal((await call('PATCH', `/api/issues/${x.key}`, { status: 'Done' }, alice.token)).status, 200);
    // removing an in-use status (Done holds i and x) without remap is 400
    const bad = await call('PUT', `/api/projects/${proj.id}/workflow`, { statuses: [{ name: 'Todo', category: 'unstarted' }, { name: 'Doing', category: 'started' }] }, alice.token);
    assert.equal(bad.status, 400);
    const ok = await call('PUT', `/api/projects/${proj.id}/workflow`, {
      statuses: [{ name: 'Todo', category: 'unstarted' }, { name: 'Doing', category: 'started' }],
      remap: { Done: 'Todo' },
    }, alice.token);
    assert.equal(ok.status, 200);
    const after = (await call('GET', `/api/issues/${x.key}`, undefined, alice.token)).body;
    assert.equal(after.status, 'Todo');
    assert.equal(after.resolvedAt, null);
  } finally { await close(); }
});

test('comments, mentions, watchers, notifications', async () => {
  const { call, alice, ws, proj, close, user } = await setup();
  try {
    const bob = await user('bob');
    await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'bob', role: 'member' }, alice.token);
    const i = (await call('POST', `/api/projects/${proj.id}/issues`, { type: 'task', title: 'C', assignee: 'bob' }, alice.token)).body;
    assert.ok(i.watchers.includes(bob.id));
    const c = await call('POST', `/api/issues/${i.key}/comments`, { body: 'hi @bob please look' }, alice.token);
    assert.equal(c.status, 201);
    const n = await call('GET', '/api/notifications?unread=true', undefined, bob.token);
    assert.equal(n.status, 200);
    assert.ok(n.body.some((x) => x.type === 'mention' && x.issueKey === i.key));
    assert.equal((await call('GET', '/api/notifications', undefined, alice.token)).body.length, 0);
    const edit = await call('PATCH', `/api/comments/${c.body.id}`, { body: 'edited' }, alice.token);
    assert.equal(edit.body.edited, true);
    assert.equal((await call('PATCH', `/api/comments/${c.body.id}`, { body: 'x' }, bob.token)).status, 403);
    assert.equal((await call('POST', '/api/notifications/read', { all: true }, bob.token)).status, 204);
    assert.equal((await call('GET', '/api/notifications?unread=true', undefined, bob.token)).body.length, 0);
    assert.equal((await call('POST', `/api/issues/${i.key}/watch`, undefined, alice.token)).status, 200);
  } finally { await close(); }
});

test('sprints: lifecycle, one active, burndown and report', async () => {
  const { call, alice, proj, close, advance } = await setup();
  try {
    const sp = (await call('POST', `/api/projects/${proj.id}/sprints`, { name: 'S1', startDate: '2026-03-02', endDate: '2026-03-06' }, alice.token)).body;
    assert.equal(sp.state, 'planned');
    const s2 = (await call('POST', `/api/projects/${proj.id}/sprints`, { name: 'S2' }, alice.token)).body;
    const a = (await call('POST', `/api/projects/${proj.id}/issues`, { type: 'task', title: 'a', storyPoints: 3, sprintId: sp.id }, alice.token)).body;
    await call('POST', `/api/projects/${proj.id}/issues`, { type: 'task', title: 'b', storyPoints: 5, sprintId: sp.id }, alice.token);
    assert.equal((await call('POST', `/api/sprints/${sp.id}/start`, undefined, alice.token)).status, 200);
    assert.equal((await call('POST', `/api/sprints/${s2.id}/start`, undefined, alice.token)).status, 409);
    advance(24 * 3600 * 1000); // 2026-03-03 10:00
    await call('PATCH', `/api/issues/${a.key}`, { status: 'Todo' }, alice.token);
    await call('PATCH', `/api/issues/${a.key}`, { status: 'In Progress' }, alice.token);
    advance(24 * 3600 * 1000); // 2026-03-04
    await call('PATCH', `/api/issues/${a.key}`, { status: 'Done' }, alice.token);
    const rep = (await call('GET', `/api/sprints/${sp.id}/report`, undefined, alice.token)).body;
    assert.equal(rep.committedPoints, 8);
    assert.equal(rep.completedPoints, 3);
    assert.equal(rep.completedIssues, 1);
    assert.equal(rep.burndown.length, 3);
    assert.deepEqual(rep.burndown.map((b) => b.date), ['2026-03-02', '2026-03-03', '2026-03-04']);
    assert.deepEqual(rep.burndown.map((b) => b.remainingPoints), [8, 8, 5]);
    const done = await call('POST', `/api/sprints/${sp.id}/complete`, { carryOverTo: s2.id }, alice.token);
    assert.equal(done.body.state, 'completed');
    const after = (await call('GET', `/api/sprints/${sp.id}/report`, undefined, alice.token)).body;
    assert.equal(after.carriedOver, 1);
  } finally { await close(); }
});

test('search query language', async () => {
  const { call, alice, proj, close } = await setup();
  try {
    const mk = (b) => call('POST', `/api/projects/${proj.id}/issues`, b, alice.token);
    await mk({ type: 'bug', title: 'Login crash', priority: 'high', labels: ['auth'], storyPoints: 5, dueDate: '2026-04-01', assignee: 'alice' });
    await mk({ type: 'task', title: 'Docs for login', description: 'Explain the "magic link"', labels: ['wontfix'], storyPoints: 1 });
    await mk({ type: 'feature', title: 'Dark mode', priority: 'low' });
    const q = async (s, extra = '') => (await call('GET', `/api/search?q=${encodeURIComponent(s)}${extra}`, undefined, alice.token));
    assert.equal((await q('type:bug')).body.length, 1);
    assert.equal((await q('login')).body.length, 2);
    assert.equal((await q('login -label:wontfix')).body.length, 1);
    assert.equal((await q('"magic link"')).body.length, 1);
    assert.equal((await q('priority:high')).body[0].title, 'Login crash');
    assert.equal((await q('assignee:me')).body.length, 1);
    assert.equal((await q('assignee:none')).body.length, 2);
    assert.equal((await q('points:>3')).body.length, 1);
    assert.equal((await q('due:<2026-05-01')).body.length, 1);
    assert.equal((await q('due:>2026-05-01')).body.length, 0);
    assert.equal((await q('is:open')).body.length, 3);
    assert.equal((await q('label:auth')).body.length, 1);
    assert.equal((await q('status:"In Progress"')).body.length, 0);
    const key = (await q('key:WEB-1')).body;
    assert.equal(key.length, 1);
    assert.equal((await q('type:bogus')).status, 400);
    assert.equal((await q('foo:bar')).status, 400);
    assert.equal((await q('"unterminated')).status, 400);
    assert.equal((await q('-')).status, 400);
    assert.equal((await q('x', '&sort=bogus')).status, 400);
    const pri = (await q('', '&sort=priority')).body.map((i) => i.priority);
    assert.equal(pri[0], 'high');
  } finally { await close(); }
});

test('CSV export and import with per-row errors', async () => {
  const { call, alice, proj, close } = await setup();
  try {
    await call('POST', `/api/projects/${proj.id}/issues`, { type: 'task', title: 'Has, comma', labels: ['a', 'b'], storyPoints: 2 }, alice.token);
    const ex = await call('GET', `/api/projects/${proj.id}/export.csv`, undefined, alice.token);
    assert.equal(ex.status, 200);
    const lines = ex.text.split('\r\n');
    assert.equal(lines[0], 'key,type,title,status,priority,assignee,labels,storyPoints,parent,epic,sprint,dueDate,createdAt,resolvedAt');
    assert.equal(lines[1].startsWith('WEB-1,task,"Has, comma",Todo,none,,a;b,2,'), true);

    const csv = [
      'key,type,title,status,priority,assignee,labels,storyPoints,parent,epic,sprint,dueDate,createdAt,resolvedAt',
      ',task,"Multi, quoted ""title""",Todo,high,alice,x;y,3,,,,2026-05-01,,',
      ',bogus,Bad type,,,,,,,,,,,',
      ',task,,,,,,,,,,,,',
      ',subtask,Orphan,,,,,,WEB-99,,,,,,',
    ].join('\r\n');
    const imp = await call('POST', `/api/projects/${proj.id}/import.csv`, csv, alice.token, { 'content-type': 'text/csv' });
    assert.equal(imp.status, 200);
    assert.equal(imp.body.created, 1);
    assert.equal(imp.body.errors.length, 3);
    assert.deepEqual(imp.body.errors.map((e) => e.line), [3, 4, 5]);
    const list = (await call('GET', `/api/projects/${proj.id}/issues`, undefined, alice.token)).body;
    const created = list.find((x) => x.title === 'Multi, quoted "title"');
    assert.ok(created);
    assert.equal(created.key, 'WEB-2');
    assert.equal(created.priority, 'high');
  } finally { await close(); }
});

test('webhooks: signed delivery with retries recorded', async () => {
  const { call, alice, proj, close } = await setup();
  const received = [];
  const receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ sig: req.headers['x-pm-signature'], body, event: JSON.parse(body).event });
      res.writeHead(received.length === 1 ? 500 : 200);
      res.end('ok');
    });
  });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${receiver.address().port}/hook`;
  try {
    const hook = await call('POST', `/api/projects/${proj.id}/webhooks`, { url, events: ['issue.created'], secret: 's3cret' }, alice.token);
    assert.equal(hook.status, 201);
    assert.equal(hook.body.secret, undefined);
    await call('POST', `/api/projects/${proj.id}/issues`, { type: 'task', title: 'Hooked' }, alice.token);
    let deliveries = [];
    for (let i = 0; i < 100; i++) {
      deliveries = (await call('GET', `/api/webhooks/${hook.body.id}/deliveries`, undefined, alice.token)).body;
      if (deliveries.length && deliveries[0].status === 200) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(deliveries[0].status, 200);
    assert.equal(deliveries[0].attempts, 2);
    assert.equal(deliveries[0].lastError, null);
    const first = received[0];
    const expected = `sha256=${crypto.createHmac('sha256', 's3cret').update(first.body).digest('hex')}`;
    assert.equal(first.sig, expected);
    assert.equal(first.event, 'issue.created');
  } finally {
    await close();
    receiver.close();
  }
});

test('persistence: state survives restart via dataFile', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-s4-'));
  const dataFile = path.join(dir, 'data.json');
  const first = await start({ serverOpts: { dataFile } });
  const u = await first.user('erin');
  const ws = (await first.call('POST', '/api/workspaces', { name: 'P', key: 'PERS' }, u.token)).body;
  await first.close();
  const second = await start({ serverOpts: { dataFile } });
  try {
    const login = await second.call('POST', '/api/auth/login', { username: 'erin', password: 'password123' });
    assert.equal(login.status, 200);
    const got = await second.call('GET', `/api/workspaces/${ws.id}`, undefined, login.body.token);
    assert.equal(got.status, 200);
  } finally {
    await second.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('static SPA is served from /', async () => {
  const env = await start();
  try {
    const r = await env.call('GET', '/');
    assert.equal(r.status, 200);
    assert.match(r.text, /<title>pm-s4/);
    const js = await env.call('GET', '/static/app.js');
    assert.equal(js.status, 200);
    assert.equal((await env.call('GET', '/static/../server.js')).status, 404);
  } finally { await env.close(); }
});
