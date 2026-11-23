import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
import { createHmac } from 'node:crypto';
import http from 'node:http';

async function start(opts = {}) {
  let now = new Date('2026-03-02T10:00:00Z');
  const clock = () => now;
  const srv = createServer({ clock, ...opts });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, b, t, raw) => {
    const headers = {};
    if (t) headers.authorization = `Bearer ${t}`;
    let body;
    if (raw !== undefined) { headers['content-type'] = 'text/csv'; body = raw; }
    else if (b !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(b); }
    const r = await fetch(base + p, { method: m, headers, body });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: r.status, body: json, text, headers: r.headers };
  };
  return { srv, call, setNow: (d) => { now = new Date(d); }, close: () => new Promise((r) => srv.close(r)) };
}

async function userWithToken(call, username) {
  await call('POST', '/api/auth/register', { username, password: 'password123' });
  const r = await call('POST', '/api/auth/login', { username, password: 'password123' });
  return r.body.token;
}

test('auth: register, login, me, logout, rate limit', async () => {
  const { call, close } = await start();
  try {
    assert.equal((await call('POST', '/api/auth/register', { username: 'bob', password: 'short' })).status, 400);
    const reg = await call('POST', '/api/auth/register', { username: 'bob', password: 'password123' });
    assert.equal(reg.status, 201);
    assert.equal(reg.body.user.username, 'bob');
    assert.equal(reg.body.user.password, undefined);
    assert.equal((await call('POST', '/api/auth/register', { username: 'bob', password: 'password123' })).status, 409);
    for (let i = 0; i < 5; i++) {
      assert.equal((await call('POST', '/api/auth/login', { username: 'bob', password: 'wrongwrong' })).status, 401);
    }
    assert.equal((await call('POST', '/api/auth/login', { username: 'bob', password: 'password123' })).status, 429);
  } finally { await close(); }
});

test('auth: login, me, logout and api tokens', async () => {
  const { call, close } = await start();
  try {
    const token = await userWithToken(call, 'carol');
    const me = await call('GET', '/api/auth/me', undefined, token);
    assert.equal(me.body.user.username, 'carol');
    const tok = await call('POST', '/api/tokens', { name: 'ci' }, token);
    assert.equal(tok.status, 201);
    assert.ok(tok.body.token);
    const list = await call('GET', '/api/tokens', undefined, token);
    assert.equal(list.body[0].token, undefined);
    assert.equal((await call('GET', '/api/auth/me', undefined, tok.body.token)).status, 200);
    await call('DELETE', `/api/tokens/${tok.body.id}`, undefined, token);
    assert.equal((await call('GET', '/api/auth/me', undefined, tok.body.token)).status, 401);
    await call('POST', '/api/auth/logout', undefined, token);
    assert.equal((await call('GET', '/api/auth/me', undefined, token)).status, 401);
  } finally { await close(); }
});

test('workspace RBAC, projects, guests', async () => {
  const { call, close } = await start();
  try {
    const alice = await userWithToken(call, 'alice');
    const bob = await userWithToken(call, 'bobby');
    const guest = await userWithToken(call, 'gina');
    const ws = (await call('POST', '/api/workspaces', { name: 'Acme', key: 'ACME' }, alice)).body;
    assert.equal(ws.role, 'admin');
    assert.equal((await call('POST', '/api/workspaces', { name: 'X', key: 'ACME' }, alice)).status, 409);
    await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'bobby', role: 'member' }, alice);
    await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'gina', role: 'guest' }, alice);
    const pr = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Web', key: 'WEB' }, alice)).body;
    assert.equal((await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'G', key: 'GG' }, guest)).status, 403);
    assert.equal((await call('GET', `/api/projects/${pr.id}`, undefined, guest)).status, 403);
    assert.equal((await call('GET', `/api/projects/${pr.id}`, undefined, bob)).status, 200);
    await call('POST', `/api/projects/${pr.id}/members`, { username: 'gina', role: 'viewer' }, alice);
    assert.equal((await call('GET', `/api/projects/${pr.id}`, undefined, guest)).status, 200);
    // viewer cannot create issues
    assert.equal((await call('POST', `/api/projects/${pr.id}/issues`, { title: 'x' }, guest)).status, 403);
    // last admin protection
    assert.equal((await call('PATCH', `/api/workspaces/${ws.id}/members/alice`, { role: 'member' }, alice)).status, 400);
    assert.equal((await call('GET', `/api/workspaces/${ws.id}/audit`, undefined, bob)).status, 403);
    const audit = await call('GET', `/api/workspaces/${ws.id}/audit`, undefined, alice);
    assert.equal(audit.status, 200);
    assert.ok(audit.body.some((a) => a.action === 'member.added'));
  } finally { await close(); }
});

test('issues: keys, hierarchy, workflow, blocking, history, epic progress', async () => {
  const { call, close } = await start();
  try {
    const t = await userWithToken(call, 'dev1user');
    const ws = (await call('POST', '/api/workspaces', { name: 'W', key: 'WWW' }, t)).body;
    const pr = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'P', key: 'PRJ' }, t)).body;
    const a = await call('POST', `/api/projects/${pr.id}/issues`, { type: 'task', title: 'A', storyPoints: 3 }, t);
    const b = await call('POST', `/api/projects/${pr.id}/issues`, { type: 'task', title: 'B' }, t);
    assert.equal(a.body.key, 'PRJ-1');
    assert.equal(b.body.key, 'PRJ-2');
    assert.equal(a.body.status, 'Todo');
    const sub = await call('POST', `/api/projects/${pr.id}/issues`, { type: 'subtask', title: 'S', parentId: a.body.key }, t);
    assert.equal(sub.status, 201);
    assert.equal((await call('POST', `/api/projects/${pr.id}/issues`, { type: 'subtask', title: 'S' }, t)).status, 400);
    assert.equal((await call('POST', `/api/projects/${pr.id}/issues`, { type: 'epic', title: 'E', parentId: a.body.key }, t)).status, 400);
    const epic = (await call('POST', `/api/projects/${pr.id}/issues`, { type: 'epic', title: 'E' }, t)).body;
    assert.equal((await call('POST', `/api/projects/${pr.id}/issues`, { type: 'task', title: 'x', epicId: a.body.key }, t)).status, 400);
    await call('PATCH', `/api/issues/${a.body.key}`, { epicId: epic.key }, t);

    // link blocks: A blocks B; B cannot be completed while A unresolved
    const link = await call('POST', `/api/issues/${a.body.key}/links`, { type: 'blocks', target: b.body.key }, t);
    assert.equal(link.status, 201);
    const bd = await call('GET', `/api/issues/${b.body.key}`, undefined, t);
    assert.ok(bd.body.links.some((l) => l.type === 'blocked_by' && l.target === a.body.key));
    assert.equal((await call('PATCH', `/api/issues/${b.body.key}`, { status: 'Done' }, t)).status, 409);
    // invalid transition not needed (default allows all); complete A first
    const ad = await call('PATCH', `/api/issues/${a.body.key}`, { status: 'Done' }, t);
    assert.equal(ad.status, 200);
    assert.ok(ad.body.resolvedAt);
    assert.equal((await call('PATCH', `/api/issues/${b.body.key}`, { status: 'Done' }, t)).status, 200);

    const hist = await call('GET', `/api/issues/${a.body.key}/history`, undefined, t);
    assert.ok(hist.body.some((h) => h.field === 'status' && h.to === 'Done'));

    const ep = await call('GET', `/api/issues/${epic.key}`, undefined, t);
    assert.equal(ep.body.progress.total, 1);
    assert.equal(ep.body.progress.points_total, 3);
    assert.equal(ep.body.progress.points_done, 3);

    const parent = await call('GET', `/api/issues/${a.body.key}`, undefined, t);
    assert.deepEqual(parent.body.children, [sub.body.key]);
    await call('DELETE', `/api/issues/${a.body.key}`, undefined, t);
    assert.equal((await call('GET', `/api/issues/${sub.body.key}`, undefined, t)).status, 404);
    const c = await call('POST', `/api/projects/${pr.id}/issues`, { type: 'task', title: 'C' }, t);
    assert.equal(c.body.key, 'PRJ-5', 'keys are never reused');
  } finally { await close(); }
});

test('custom workflow: invalid transitions and remap', async () => {
  const { call, close } = await start();
  try {
    const t = await userWithToken(call, 'wfuser');
    const ws = (await call('POST', '/api/workspaces', { name: 'W', key: 'WFW' }, t)).body;
    const pr = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'P', key: 'WFP' }, t)).body;
    const iss = (await call('POST', `/api/projects/${pr.id}/issues`, { type: 'bug', title: 'bug' }, t)).body;
    assert.equal(iss.status, 'Todo');
    const wf = {
      statuses: [{ name: 'New', category: 'unstarted' }, { name: 'Doing', category: 'started' }, { name: 'Closed', category: 'completed' }],
      transitions: [['New', 'Doing'], ['Doing', 'Closed']],
      remap: { Todo: 'New' },
    };
    assert.equal((await call('PUT', `/api/projects/${pr.id}/workflow`, { ...wf, remap: undefined }, t)).status, 400);
    assert.equal((await call('PUT', `/api/projects/${pr.id}/workflow`, wf, t)).status, 200);
    assert.equal((await call('GET', `/api/issues/${iss.key}`, undefined, t)).body.status, 'New');
    assert.equal((await call('PATCH', `/api/issues/${iss.key}`, { status: 'Closed' }, t)).status, 409);
    assert.equal((await call('PATCH', `/api/issues/${iss.key}`, { status: 'Doing' }, t)).status, 200);
    // Doing is in use; removing it without remap is rejected
    const noMap = await call('PUT', `/api/projects/${pr.id}/workflow`, {
      statuses: [{ name: 'New', category: 'unstarted' }, { name: 'Closed', category: 'completed' }],
    }, t);
    assert.equal(noMap.status, 400);
    const ok = await call('PUT', `/api/projects/${pr.id}/workflow`, {
      statuses: [{ name: 'New', category: 'unstarted' }, { name: 'Closed', category: 'completed' }],
      remap: { Doing: 'Closed' },
    }, t);
    assert.equal(ok.status, 200);
    const after = (await call('GET', `/api/issues/${iss.key}`, undefined, t)).body;
    assert.equal(after.status, 'Closed');
    assert.ok(after.resolvedAt);
  } finally { await close(); }
});

test('search query language', async () => {
  const { call, close } = await start();
  try {
    const t = await userWithToken(call, 'squser');
    const ws = (await call('POST', '/api/workspaces', { name: 'S', key: 'SQW' }, t)).body;
    const pr = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'P', key: 'SQP' }, t)).body;
    const mk = (body) => call('POST', `/api/projects/${pr.id}/issues`, body, t);
    await mk({ type: 'bug', title: 'Login crash', priority: 'high', labels: ['auth'], storyPoints: 5 });
    await mk({ type: 'task', title: 'Docs update', labels: ['wontfix'], storyPoints: 1 });
    await mk({ type: 'bug', title: 'Other "exact phrase" here', priority: 'low' });
    const q = async (s) => (await call('GET', `/api/search?q=${encodeURIComponent(s)}`, undefined, t)).body.map((i) => i.title);
    assert.equal((await q('type:bug')).length, 2);
    assert.deepEqual(await q('label:auth'), ['Login crash']);
    assert.deepEqual(await q('-label:wontfix').then((r) => r.length), 2);
    assert.deepEqual(await q('points:>3'), ['Login crash']);
    assert.deepEqual(await q('login'), ['Login crash']);
    assert.deepEqual(await q('key:SQP-2'), ['Docs update']);
    assert.deepEqual(await q('priority:high'), ['Login crash']);
    assert.deepEqual(await q('assignee:none').then((r) => r.length), 3);
    assert.equal((await call('GET', `/api/search?q=${encodeURIComponent('type:bogus')}`, undefined, t)).status, 400);
    assert.equal((await call('GET', `/api/search?q=${encodeURIComponent('"unterminated')}`, undefined, t)).status, 400);
  } finally { await close(); }
});

test('sprints, burndown and report', async () => {
  const { call, close, setNow } = await start();
  try {
    const t = await userWithToken(call, 'spuser');
    const ws = (await call('POST', '/api/workspaces', { name: 'S', key: 'SPW' }, t)).body;
    const pr = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'P', key: 'SPP' }, t)).body;
    const sp = (await call('POST', `/api/projects/${pr.id}/sprints`, { name: 'S1', startDate: '2026-03-02', endDate: '2026-03-06' }, t)).body;
    const i1 = (await call('POST', `/api/projects/${pr.id}/issues`, { type: 'task', title: 'one', storyPoints: 3, sprintId: sp.id }, t)).body;
    await call('POST', `/api/projects/${pr.id}/issues`, { type: 'task', title: 'two', storyPoints: 2, sprintId: sp.id }, t);
    assert.equal((await call('POST', `/api/sprints/${sp.id}/start`, undefined, t)).status, 200);
    assert.equal((await call('POST', `/api/projects/${pr.id}/sprints`, { name: 'S2' }, t)).status, 201);
    const sp2 = (await call('GET', `/api/projects/${pr.id}/sprints`, undefined, t)).body[1];
    assert.equal((await call('POST', `/api/sprints/${sp2.id}/start`, undefined, t)).status, 409);
    setNow('2026-03-03T12:00:00Z');
    await call('PATCH', `/api/issues/${i1.key}`, { status: 'Done' }, t);
    setNow('2026-03-04T12:00:00Z');
    const rep = (await call('GET', `/api/sprints/${sp.id}/report`, undefined, t)).body;
    assert.equal(rep.committedPoints, 5);
    assert.equal(rep.completedPoints, 3);
    assert.equal(rep.burndown[0].remainingPoints, 5);
    assert.equal(rep.burndown[1].remainingPoints, 2);
    assert.equal(rep.burndown.at(-1).date, '2026-03-04');
    const done = await call('POST', `/api/sprints/${sp.id}/complete`, { carryOverTo: sp2.id }, t);
    assert.equal(done.status, 200);
    assert.equal(done.body.state, 'completed');
    const rep2 = (await call('GET', `/api/sprints/${sp.id}/report`, undefined, t)).body;
    assert.equal(rep2.carriedOver, 1);
    assert.equal(rep2.completedIssues, 1);
  } finally { await close(); }
});

test('comments, mentions, notifications, watchers', async () => {
  const { call, close } = await start();
  try {
    const a = await userWithToken(call, 'ann');
    const b = await userWithToken(call, 'ben');
    const ws = (await call('POST', '/api/workspaces', { name: 'N', key: 'NTW' }, a)).body;
    await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'ben', role: 'member' }, a);
    const pr = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'P', key: 'NTP' }, a)).body;
    const iss = (await call('POST', `/api/projects/${pr.id}/issues`, { type: 'task', title: 'n' }, a)).body;
    const c = await call('POST', `/api/issues/${iss.key}/comments`, { body: 'hi @ben.' }, a);
    assert.equal(c.status, 201);
    const n = await call('GET', '/api/notifications?unread=true', undefined, b);
    assert.equal(n.body[0].type, 'mention');
    await call('PATCH', `/api/issues/${iss.key}`, { assigneeId: null, status: 'Done' }, b);
    const ann = await call('GET', '/api/notifications', undefined, a);
    assert.ok(ann.body.some((x) => x.type === 'status_changed'));
    await call('POST', '/api/notifications/read', { all: true }, a);
    assert.equal((await call('GET', '/api/notifications?unread=true', undefined, a)).body.length, 0);
    const edit = await call('PATCH', `/api/comments/${c.body.id}`, { body: 'edited' }, a);
    assert.equal(edit.body.edited, true);
    assert.equal((await call('PATCH', `/api/comments/${c.body.id}`, { body: 'x' }, b)).status, 403);
  } finally { await close(); }
});

test('csv export/import round trip with row errors', async () => {
  const { call, close } = await start();
  try {
    const t = await userWithToken(call, 'csvuser');
    const ws = (await call('POST', '/api/workspaces', { name: 'C', key: 'CSW' }, t)).body;
    const pr = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'P', key: 'CSP' }, t)).body;
    await call('POST', `/api/projects/${pr.id}/issues`, { type: 'task', title: 'Has, comma "quote"', labels: ['x', 'y'] }, t);
    const ex = await call('GET', `/api/projects/${pr.id}/export.csv`, undefined, t);
    assert.equal(ex.status, 200);
    const header = ex.text.split('\r\n')[0];
    assert.equal(header, 'key,type,title,status,priority,assignee,labels,storyPoints,parent,epic,sprint,dueDate,createdAt,resolvedAt');
    assert.ok(ex.text.includes('"Has, comma ""quote"""'));
    const csv = `${header}\r\nx,task,Imported,Todo,high,,a;b,2,,,,2026-05-01,,\r\nx,bogus,Bad,Todo,none,,,,,,,,,\r\n`;
    const im = await call('POST', `/api/projects/${pr.id}/import.csv`, undefined, t, csv);
    assert.equal(im.body.created, 1);
    assert.equal(im.body.errors.length, 1);
    assert.equal(im.body.errors[0].line, 3);
  } finally { await close(); }
});

test('webhooks deliver signed payloads and record status', async () => {
  const received = [];
  const hook = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ sig: req.headers['x-pm-signature'], body });
      res.writeHead(received.length === 1 ? 500 : 200); res.end();
    });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const hookUrl = `http://127.0.0.1:${hook.address().port}/h`;
  const { call, close } = await start();
  try {
    const t = await userWithToken(call, 'hkuser');
    const ws = (await call('POST', '/api/workspaces', { name: 'H', key: 'HKW' }, t)).body;
    const pr = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'P', key: 'HKP' }, t)).body;
    const wh = await call('POST', `/api/projects/${pr.id}/webhooks`, { url: hookUrl, events: ['issue.created'], secret: 'shh' }, t);
    assert.equal(wh.status, 201);
    await call('POST', `/api/projects/${pr.id}/issues`, { type: 'task', title: 'hook me' }, t);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(received.length, 2, 'retried once after 500');
    const expected = 'sha256=' + createHmac('sha256', 'shh').update(received[1].body).digest('hex');
    assert.equal(received[1].sig, expected);
    const del = (await call('GET', `/api/webhooks/${wh.body.id}/deliveries`, undefined, t)).body;
    assert.equal(del[0].status, 200);
    assert.equal(del[0].attempts, 2);
  } finally { await close(); hook.close(); }
});

test('serves SPA and static files', async () => {
  const { call, close } = await start();
  try {
    const r = await call('GET', '/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/html/);
    assert.equal((await call('GET', '/static/app.js')).status, 200);
    assert.equal((await call('GET', '/static/../server.js')).status, 404);
  } finally { await close(); }
});
