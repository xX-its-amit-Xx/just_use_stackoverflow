import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { parseCsv, toCsv } from '../src/csv.js';
import { parseQuery } from '../src/search.js';

async function start(opts = {}) {
  const srv = createServer(opts);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, b, t, extra = {}) => {
    const headers = { ...(b !== undefined && !(typeof b === 'string') ? { 'content-type': 'application/json' } : {}), ...extra };
    if (t) headers.authorization = `Bearer ${t}`;
    const r = await fetch(base + p, { method: m, headers, body: b === undefined ? undefined : typeof b === 'string' ? b : JSON.stringify(b) });
    const text = await r.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, body };
  };
  return { srv, call, close: () => new Promise((r) => srv.close(r)) };
}

async function user(call, name) {
  await call('POST', '/api/auth/register', { username: name, password: 'password123' });
  const { body } = await call('POST', '/api/auth/login', { username: name, password: 'password123' });
  return { token: body.token, user: body.user };
}

test('auth: register, login, me, logout, token auth, 429 lockout', async () => {
  const { call, close } = await start();
  try {
    const r = await call('POST', '/api/auth/register', { username: 'bob', password: 'password123' });
    assert.equal(r.status, 201);
    assert.equal(r.body.user.username, 'bob');
    assert.equal(r.body.user.password, undefined);
    assert.equal((await call('POST', '/api/auth/register', { username: 'bob', password: 'password123' })).status, 409);
    const login = await call('POST', '/api/auth/login', { username: 'bob', password: 'password123' });
    assert.equal(login.status, 200);
    assert.equal((await call('GET', '/api/auth/me', undefined, login.body.token)).body.user.username, 'bob');
    assert.equal((await call('GET', '/api/auth/me')).status, 401);
    const tok = await call('POST', '/api/tokens', { name: 'ci' }, login.body.token);
    assert.equal(tok.status, 201);
    assert.ok(tok.body.token);
    assert.equal((await call('GET', '/api/auth/me', undefined, tok.body.token)).status, 200);
    const list = await call('GET', '/api/tokens', undefined, login.body.token);
    assert.equal(list.body[0].token, undefined);
    assert.equal((await call('DELETE', `/api/tokens/${tok.body.id}`, undefined, login.body.token)).status, 204);
    assert.equal((await call('GET', '/api/auth/me', undefined, tok.body.token)).status, 401);
    assert.equal((await call('POST', '/api/auth/logout', undefined, login.body.token)).status, 204);
    assert.equal((await call('GET', '/api/auth/me', undefined, login.body.token)).status, 401);
    for (let i = 0; i < 5; i++) {
      assert.equal((await call('POST', '/api/auth/login', { username: 'bob', password: 'wrong-pass' })).status, 401);
    }
    assert.equal((await call('POST', '/api/auth/login', { username: 'bob', password: 'password123' })).status, 429);
  } finally { await close(); }
});

test('workspaces, RBAC, projects, members', async () => {
  const { call, close } = await start();
  try {
    const a = await user(call, 'alice');
    const b = await user(call, 'bobby');
    const g = await user(call, 'gina');
    const ws = (await call('POST', '/api/workspaces', { name: 'Acme', key: 'ACME' }, a.token)).body;
    assert.equal(ws.role, 'admin');
    assert.equal((await call('POST', '/api/workspaces', { name: 'X', key: 'acme' }, a.token)).status, 400);
    assert.equal((await call('POST', '/api/workspaces/' + ws.id + '/members', { username: 'bobby', role: 'member' }, a.token)).status, 201);
    assert.equal((await call('POST', '/api/workspaces/' + ws.id + '/members', { username: 'gina', role: 'guest' }, a.token)).status, 201);
    assert.equal((await call('GET', '/api/workspaces/' + ws.id, undefined, b.token)).status, 200);
    const p = await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Web', key: 'WEB' }, a.token);
    assert.equal(p.status, 201);
    const pid = p.body.id;
    // workspace member without project access -> 403
    assert.equal((await call('GET', `/api/projects/${pid}`, undefined, b.token)).status, 403);
    assert.equal((await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'G', key: 'GGG' }, g.token)).status, 403);
    assert.equal((await call('POST', `/api/projects/${pid}/members`, { username: 'bobby', role: 'developer' }, a.token)).status, 201);
    assert.equal((await call('GET', `/api/projects/${pid}`, undefined, b.token)).status, 200);
    // guest not added -> 403
    assert.equal((await call('GET', `/api/projects/${pid}`, undefined, g.token)).status, 403);
    // last admin cannot be removed
    assert.equal((await call('DELETE', `/api/workspaces/${ws.id}/members/${a.user.id}`, undefined, a.token)).status, 400);
    assert.equal((await call('GET', `/api/projects/nope`, undefined, a.token)).status, 404);
    // default workflow
    assert.deepEqual(p.body.workflow.statuses.map((s) => s.name), ['Backlog', 'Todo', 'In Progress', 'In Review', 'Done']);
  } finally { await close(); }
});

test('issues: keys, subtasks, epics, transitions, links, blocked, history, resolvedAt', async () => {
  const { call, close } = await start();
  try {
    const a = await user(call, 'alice');
    const ws = (await call('POST', '/api/workspaces', { name: 'Acme', key: 'ACME' }, a.token)).body;
    const pid = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Web', key: 'WEB' }, a.token)).body.id;
    const i1 = await call('POST', `/api/projects/${pid}/issues`, { type: 'task', title: 'Hello' }, a.token);
    assert.equal(i1.body.key, 'WEB-1');
    const i2 = await call('POST', `/api/projects/${pid}/issues`, { type: 'task', title: 'Two' }, a.token);
    assert.equal(i2.body.key, 'WEB-2');
    assert.equal((await call('POST', `/api/projects/${pid}/issues`, { type: 'subtask', title: 'x' }, a.token)).status, 400);
    const sub = await call('POST', `/api/projects/${pid}/issues`, { type: 'subtask', title: 'sub', parentId: i1.body.id }, a.token);
    assert.equal(sub.status, 201);
    const epic = await call('POST', `/api/projects/${pid}/issues`, { type: 'epic', title: 'E' }, a.token);
    assert.equal((await call('POST', `/api/projects/${pid}/issues`, { type: 'epic', title: 'E2', parentId: i1.body.id }, a.token)).status, 400);
    await call('PATCH', `/api/issues/${i1.body.key}`, { epicId: epic.body.id, storyPoints: 3 }, a.token);
    await call('PATCH', `/api/issues/${i2.body.key}`, { storyPoints: 5 }, a.token);
    const parent = (await call('GET', `/api/issues/WEB-1`, undefined, a.token)).body;
    assert.deepEqual(parent.children, ['WEB-3']);
    // transitions: default allows any -> any
    const t = await call('PATCH', `/api/issues/WEB-1`, { status: 'Done' }, a.token);
    assert.equal(t.status, 200);
    assert.ok(t.body.resolvedAt);
    await call('PATCH', `/api/issues/WEB-1`, { status: 'Todo' }, a.token);
    assert.equal((await call('GET', `/api/issues/WEB-1`, undefined, a.token)).body.resolvedAt, null);
    // links & blocked
    const link = await call('POST', `/api/issues/WEB-2/links`, { type: 'blocks', target: 'WEB-1' }, a.token);
    assert.equal(link.status, 201);
    const tgt = (await call('GET', `/api/issues/WEB-1`, undefined, a.token)).body;
    assert.ok(tgt.links.some((l) => l.type === 'blocked_by' && l.target === 'WEB-2'));
    const blocked = await call('PATCH', `/api/issues/WEB-1`, { status: 'Done' }, a.token);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, 'blocked');
    await call('PATCH', `/api/issues/WEB-2`, { status: 'Done' }, a.token);
    assert.equal((await call('PATCH', `/api/issues/WEB-1`, { status: 'Done' }, a.token)).status, 200);
    // history
    const hist = (await call('GET', `/api/issues/WEB-1/history`, undefined, a.token)).body;
    assert.ok(hist.some((h) => h.field === 'status' && h.to === 'Done'));
    // deleting parent deletes subtask
    assert.equal((await call('DELETE', `/api/issues/WEB-1`, undefined, a.token)).status, 204);
    assert.equal((await call('GET', `/api/issues/WEB-3`, undefined, a.token)).status, 404);
    // key never reused
    assert.equal((await call('POST', `/api/projects/${pid}/issues`, { type: 'task', title: 'new' }, a.token)).body.key, 'WEB-5');
    // custom workflow: removing in-use statuses needs a remap
    const wf = { statuses: [{ name: 'Open', category: 'unstarted' }, { name: 'Done', category: 'completed' }], transitions: [['Open', 'Done']] };
    assert.equal((await call('PUT', `/api/projects/${pid}/workflow`, wf, a.token)).status, 400);
    wf.remap = { Backlog: 'Open', Todo: 'Open', 'In Progress': 'Open' };
    assert.equal((await call('PUT', `/api/projects/${pid}/workflow`, wf, a.token)).status, 200);
    assert.equal((await call('PATCH', `/api/issues/WEB-4`, { status: 'Done' }, a.token)).status, 200);
    assert.equal((await call('PATCH', `/api/issues/WEB-4`, { status: 'Open' }, a.token)).status, 409);
  } finally { await close(); }
});

test('comments, mentions, watchers, notifications', async () => {
  const { call, close } = await start();
  try {
    const a = await user(call, 'alice');
    const b = await user(call, 'bobby');
    const ws = (await call('POST', '/api/workspaces', { name: 'Acme', key: 'ACME' }, a.token)).body;
    await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'bobby', role: 'member' }, a.token);
    const pid = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Web', key: 'WEB' }, a.token)).body.id;
    await call('POST', `/api/projects/${pid}/members`, { username: 'bobby', role: 'developer' }, a.token);
    await call('POST', `/api/projects/${pid}/issues`, { type: 'bug', title: 'Crash', assigneeId: b.user.id }, a.token);
    const c = await call('POST', `/api/issues/WEB-1/comments`, { body: 'hi @bobby' }, a.token);
    assert.equal(c.status, 201);
    const n = (await call('GET', '/api/notifications?unread=true', undefined, b.token)).body;
    assert.ok(n.some((x) => x.type === 'mention' && x.issueKey === 'WEB-1'));
    const ed = await call('PATCH', `/api/comments/${c.body.id}`, { body: 'edited' }, a.token);
    assert.equal(ed.body.edited, true);
    assert.equal((await call('PATCH', `/api/comments/${c.body.id}`, { body: 'x' }, b.token)).status, 403);
    await call('POST', `/api/notifications/read`, { all: true }, b.token);
    assert.equal((await call('GET', '/api/notifications?unread=true', undefined, b.token)).body.length, 0);
    await call('PATCH', `/api/issues/WEB-1`, { status: 'Done' }, a.token);
    const after = (await call('GET', '/api/notifications', undefined, b.token)).body;
    assert.equal(after[0].type, 'issue.status_changed');
  } finally { await close(); }
});

test('sprints, report, burndown with injected clock', async () => {
  let now = new Date('2026-03-02T10:00:00Z');
  const { call, close } = await start({ clock: () => now });
  try {
    const a = await user(call, 'alice');
    const ws = (await call('POST', '/api/workspaces', { name: 'Acme', key: 'ACME' }, a.token)).body;
    const pid = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Web', key: 'WEB' }, a.token)).body.id;
    const s = (await call('POST', `/api/projects/${pid}/sprints`, { name: 'S1', startDate: '2026-03-02', endDate: '2026-03-06' }, a.token)).body;
    await call('POST', `/api/projects/${pid}/issues`, { type: 'task', title: 'A', storyPoints: 3, sprintId: s.id }, a.token);
    await call('POST', `/api/projects/${pid}/issues`, { type: 'task', title: 'B', storyPoints: 2, sprintId: s.id }, a.token);
    assert.equal((await call('POST', `/api/sprints/${s.id}/start`, undefined, a.token)).status, 200);
    const s2 = (await call('POST', `/api/projects/${pid}/sprints`, { name: 'S2' }, a.token)).body;
    assert.equal((await call('POST', `/api/sprints/${s2.id}/start`, undefined, a.token)).status, 409);
    now = new Date('2026-03-03T10:00:00Z');
    await call('PATCH', `/api/issues/WEB-1`, { status: 'Done' }, a.token);
    now = new Date('2026-03-04T10:00:00Z');
    const rep = (await call('GET', `/api/sprints/${s.id}/report`, undefined, a.token)).body;
    assert.equal(rep.committedPoints, 5);
    assert.equal(rep.completedPoints, 3);
    assert.equal(rep.completedIssues, 1);
    assert.deepEqual(rep.burndown.map((d) => d.remainingPoints), [5, 2, 2]);
    const done = (await call('POST', `/api/sprints/${s.id}/complete`, { carryOverTo: 'backlog' }, a.token)).body;
    assert.equal(done.state, 'completed');
    assert.equal(done.carriedOver, 1);
    const issue = (await call('GET', '/api/issues/WEB-2', undefined, a.token)).body;
    assert.equal(issue.sprintId, null);
  } finally { await close(); }
});

test('search query language', async () => {
  const { call, close } = await start();
  try {
    const a = await user(call, 'alice');
    const ws = (await call('POST', '/api/workspaces', { name: 'Acme', key: 'ACME' }, a.token)).body;
    const pid = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Web', key: 'WEB' }, a.token)).body.id;
    await call('POST', `/api/projects/${pid}/issues`, { type: 'bug', title: 'Login Broken', priority: 'high', labels: ['auth', 'wontfix'], storyPoints: 5, dueDate: '2026-01-10' }, a.token);
    await call('POST', `/api/projects/${pid}/issues`, { type: 'task', title: 'Docs', priority: 'low', labels: ['docs'], storyPoints: 1 }, a.token);
    const q = async (s) => (await call('GET', `/api/search?q=${encodeURIComponent(s)}`, undefined, a.token));
    assert.equal((await q('type:bug')).body.length, 1);
    assert.equal((await q('type:bug -label:wontfix')).body.length, 0);
    assert.equal((await q('label:auth priority:high')).body.length, 1);
    assert.equal((await q('points:>3')).body.length, 1);
    assert.equal((await q('due:<2026-02-01')).body.length, 1);
    assert.equal((await q('assignee:none')).body.length, 2);
    assert.equal((await q('key:web-2')).body[0].key, 'WEB-2');
    assert.equal((await q('"login broken"')).body.length, 1);
    assert.equal((await q('is:open')).body.length, 2);
    assert.equal((await q('status:"In Progress"')).body.length, 0);
    assert.equal((await q('type:bogus')).status, 400);
    assert.equal((await q('"unterminated')).status, 400);
    assert.equal((await q('bogus:1')).status, 400);
  } finally { await close(); }
});

test('csv parser and writer (RFC 4180)', () => {
  const recs = parseCsv('a,b\r\n"x,1","he said ""hi"""\r\n\r\n"multi\nline",z\n');
  assert.deepEqual(recs.map((r) => r.fields), [['a', 'b'], ['x,1', 'he said "hi"'], ['multi\nline', 'z']]);
  assert.equal(recs[1].line, 2);
  assert.equal(toCsv(['a', 'b'], [['1,2', 'q"']]), 'a,b\r\n"1,2","q"""\r\n');
});

test('csv export and import through the HTTP API', async () => {
  const { call, close } = await start();
  try {
    const a = await user(call, 'alice');
    const ws = (await call('POST', '/api/workspaces', { name: 'Acme', key: 'ACME' }, a.token)).body;
    const pid = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Web', key: 'WEB' }, a.token)).body.id;
    await call('POST', `/api/projects/${pid}/issues`, { type: 'task', title: 'Has, comma "quote"', labels: ['x', 'y'], storyPoints: 2 }, a.token);
    const exp = await call('GET', `/api/projects/${pid}/export.csv`, undefined, a.token);
    assert.equal(exp.status, 200);
    const lines = exp.body.split('\r\n');
    assert.equal(lines[0], 'key,type,title,status,priority,assignee,labels,storyPoints,parent,epic,sprint,dueDate,createdAt,resolvedAt');
    assert.ok(lines[1].startsWith('WEB-1,task,"Has, comma ""quote""",Todo,none,,x;y,2,'));
    const imp = await call('POST', `/api/projects/${pid}/import.csv`,
      'key,type,title,status,priority,assignee,labels,storyPoints,parent,epic,sprint,dueDate\r\n' +
      ',bug,Imported one,Todo,high,alice,a;b,3,,,,2026-05-01\r\n' +
      ',bogus,Bad type,,,,,,,,,\r\n' +
      ',task,,,,,,,,,,\r\n' +
      ',subtask,Child,,,,,,WEB-9,,,\r\n', a.token, { 'content-type': 'text/csv' });
    assert.equal(imp.status, 200);
    assert.equal(imp.body.created, 1);
    assert.deepEqual(imp.body.errors.map((e) => e.line), [3, 4, 5]);
    const got = (await call('GET', '/api/issues/WEB-2', undefined, a.token)).body;
    assert.equal(got.title, 'Imported one');
    assert.equal(got.priority, 'high');
    assert.deepEqual(got.labels, ['a', 'b']);
  } finally { await close(); }
});

test('webhooks deliver signed payloads and record status', async () => {
  const received = [];
  const hook = (await import('node:http')).createServer((req, res) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => { received.push({ sig: req.headers['x-pm-signature'], data }); res.writeHead(200); res.end('ok'); });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const { call, close } = await start();
  try {
    const a = await user(call, 'alice');
    const ws = (await call('POST', '/api/workspaces', { name: 'Acme', key: 'ACME' }, a.token)).body;
    const pid = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Web', key: 'WEB' }, a.token)).body.id;
    const url = `http://127.0.0.1:${hook.address().port}/hook`;
    const wh = await call('POST', `/api/projects/${pid}/webhooks`, { url, events: ['issue.created'], secret: 'shh' }, a.token);
    assert.equal(wh.status, 201);
    await call('POST', `/api/projects/${pid}/issues`, { type: 'task', title: 'Hook me' }, a.token);
    assert.equal(received.length, 1);
    const expected = 'sha256=' + crypto.createHmac('sha256', 'shh').update(received[0].data).digest('hex');
    assert.equal(received[0].sig, expected);
    assert.equal(JSON.parse(received[0].data).event, 'issue.created');
    const dl = (await call('GET', `/api/webhooks/${wh.body.id}/deliveries`, undefined, a.token)).body;
    assert.equal(dl[0].status, 200);
    assert.equal(dl[0].attempts, 1);
    const audit = (await call('GET', `/api/workspaces/${ws.id}/audit`, undefined, a.token)).body;
    assert.ok(audit.some((x) => x.action === 'webhook.created'));
  } finally { await close(); hook.close(); }
});

test('persists to dataFile and reloads', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-'));
  const file = path.join(dir, 'db.json');
  const s1 = await start({ dataFile: file });
  const a = await user(s1.call, 'alice');
  await s1.call('POST', '/api/workspaces', { name: 'Acme', key: 'ACME' }, a.token);
  await s1.close();
  const s2 = await start({ dataFile: file });
  try {
    const login = await s2.call('POST', '/api/auth/login', { username: 'alice', password: 'password123' });
    const list = await s2.call('GET', '/api/workspaces', undefined, login.body.token);
    assert.equal(list.body[0].key, 'ACME');
  } finally { await s2.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('query parser unit', () => {
  const t = parseQuery('type:bug -label:x "exact phrase" free');
  assert.equal(t.length, 4);
  assert.equal(t[1].neg, true);
  assert.equal(t[2].value, 'exact phrase');
});
