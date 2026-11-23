import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createServer } from '../../src/server.js';

async function start(opts = {}) {
  const srv = createServer(opts);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, b, t, extra = {}) => {
    const headers = { ...(t ? { authorization: `Bearer ${t}` } : {}) };
    let body;
    if (extra.text !== undefined) { headers['content-type'] = 'text/csv'; body = extra.text; }
    else if (b !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(b); }
    const r = await fetch(base + p, { method: m, headers, body });
    const ct = r.headers.get('content-type') || '';
    const text = await r.text();
    let json = null;
    if (ct.includes('json')) { try { json = JSON.parse(text); } catch { json = null; } }
    return { status: r.status, body: json, text };
  };
  return { srv, call, base, close: () => new Promise((r) => srv.close(r)) };
}

async function user(call, username, password = 'password123') {
  await call('POST', '/api/auth/register', { username, password });
  const r = await call('POST', '/api/auth/login', { username, password });
  return { token: r.body.token, user: r.body.user };
}

test('auth: register, login, me, logout, 401, rate limit', async () => {
  let now = Date.parse('2026-03-01T10:00:00Z');
  const h = await start({ clock: () => new Date(now) });
  try {
    const reg = await h.call('POST', '/api/auth/register', { username: 'bob', password: 'password123' });
    assert.equal(reg.status, 201);
    assert.equal(reg.body.user.username, 'bob');
    assert.equal(reg.body.user.password, undefined);
    assert.equal((await h.call('POST', '/api/auth/register', { username: 'bob', password: 'password123' })).status, 409);
    assert.equal((await h.call('GET', '/api/auth/me')).status, 401);
    for (let i = 0; i < 5; i++) {
      assert.equal((await h.call('POST', '/api/auth/login', { username: 'bob', password: 'wrongwrong' })).status, 401);
    }
    assert.equal((await h.call('POST', '/api/auth/login', { username: 'bob', password: 'password123' })).status, 429);
    now += 16 * 60 * 1000;
    const login = await h.call('POST', '/api/auth/login', { username: 'bob', password: 'password123' });
    assert.equal(login.status, 200);
    const me = await h.call('GET', '/api/auth/me', undefined, login.body.token);
    assert.equal(me.body.user.username, 'bob');
    assert.equal((await h.call('POST', '/api/auth/logout', undefined, login.body.token)).status, 204);
    assert.equal((await h.call('GET', '/api/auth/me', undefined, login.body.token)).status, 401);
  } finally { await h.close(); }
});

test('api tokens authenticate and are listed without secrets', async () => {
  const h = await start();
  try {
    const { token } = await user(h.call, 'carol');
    const t = await h.call('POST', '/api/tokens', { name: 'ci' }, token);
    assert.equal(t.status, 201);
    assert.match(t.body.token, /^pmt_/);
    const list = await h.call('GET', '/api/tokens', undefined, token);
    assert.equal(list.body.length, 1);
    assert.equal(list.body[0].token, undefined);
    const me = await h.call('GET', '/api/auth/me', undefined, t.body.token);
    assert.equal(me.status, 200);
    assert.equal((await h.call('DELETE', `/api/tokens/${t.body.id}`, undefined, token)).status, 204);
    assert.equal((await h.call('GET', '/api/auth/me', undefined, t.body.token)).status, 401);
  } finally { await h.close(); }
});

test('workspaces, RBAC, last admin protection', async () => {
  const h = await start();
  try {
    const a = await user(h.call, 'alice');
    const m = await user(h.call, 'mallory');
    const ws = await h.call('POST', '/api/workspaces', { name: 'Acme', key: 'ACME' }, a.token);
    assert.equal(ws.status, 201);
    assert.equal((await h.call('POST', '/api/workspaces', { name: 'X', key: 'acme' }, a.token)).status, 409);
    assert.equal((await h.call('POST', '/api/workspaces', { name: 'X', key: 'A' }, a.token)).status, 400);
    assert.equal((await h.call('GET', `/api/workspaces/${ws.body.id}`, undefined, m.token)).status, 403);
    assert.equal((await h.call('POST', `/api/workspaces/${ws.body.id}/members`, { username: 'mallory', role: 'guest' }, a.token)).status, 201);
    assert.equal((await h.call('POST', `/api/workspaces/${ws.body.id}/projects`, { name: 'P', key: 'GG' }, m.token)).status, 403);
    assert.equal((await h.call('DELETE', `/api/workspaces/${ws.body.id}/members/alice`, undefined, a.token)).status, 400);
    assert.equal((await h.call('PATCH', `/api/workspaces/${ws.body.id}/members/mallory`, { role: 'member' }, a.token)).body.role, 'member');
    assert.equal((await h.call('DELETE', `/api/workspaces/${ws.body.id}/members/mallory`, undefined, m.token)).status, 403);
  } finally { await h.close(); }
});

test('issues: keys, subtasks, epics, links, blocked, workflow, history', async () => {
  const h = await start();
  try {
    const a = await user(h.call, 'dave');
    const ws = (await h.call('POST', '/api/workspaces', { name: 'W', key: 'WKS' }, a.token)).body;
    const p = (await h.call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Core', key: 'CORE' }, a.token)).body;
    const pid = p.id;
    assert.deepEqual(p.workflow.statuses.map((s) => s.name), ['Backlog', 'Todo', 'In Progress', 'In Review', 'Done']);
    const epic = (await h.call('POST', `/api/projects/${pid}/issues`, { type: 'epic', title: 'E' }, a.token)).body;
    assert.equal(epic.key, 'CORE-1');
    assert.equal(epic.status, 'Todo');
    const t1 = (await h.call('POST', `/api/projects/${pid}/issues`, { type: 'task', title: 'T', epicId: epic.id, storyPoints: 3 }, a.token)).body;
    assert.equal(t1.key, 'CORE-2');
    const t2 = (await h.call('POST', `/api/projects/${pid}/issues`, { type: 'task', title: 'B', storyPoints: 5 }, a.token)).body;
    const sub = await h.call('POST', `/api/projects/${pid}/issues`, { type: 'subtask', title: 'S', parentId: t1.key }, a.token);
    assert.equal(sub.status, 201);
    assert.equal((await h.call('POST', `/api/projects/${pid}/issues`, { type: 'subtask', title: 'S' }, a.token)).status, 400);
    assert.equal((await h.call('POST', `/api/projects/${pid}/issues`, { type: 'epic', title: 'E2', parentId: t1.id }, a.token)).status, 400);
    assert.equal((await h.call('POST', `/api/projects/${pid}/issues`, { type: 'task', title: 'x', epicId: t2.id }, a.token)).status, 400);

    const detail = (await h.call('GET', `/api/issues/${t1.key}`, undefined, a.token)).body;
    assert.deepEqual(detail.children, [sub.body.key]);
    const epicDetail = (await h.call('GET', `/api/issues/CORE-1`, undefined, a.token)).body;
    assert.deepEqual(epicDetail.progress, { total: 1, done: 0, points_total: 3, points_done: 0 });

    // invalid transition: workflow default allows any->any, so restrict via workflow
    const wf = await h.call('PUT', `/api/projects/${pid}/workflow`, {
      statuses: [{ name: 'Open', category: 'unstarted' }, { name: 'Doing', category: 'started' }, { name: 'Closed', category: 'completed' }],
      transitions: [['Open', 'Doing'], ['Doing', 'Closed'], ['Closed', 'Doing']],
      remap: { Todo: 'Open' },
    }, a.token);
    assert.equal(wf.status, 200, JSON.stringify(wf.body));
    const noRemap = await h.call('PUT', `/api/projects/${pid}/workflow`, {
      statuses: [{ name: 'Only', category: 'unstarted' }],
    }, a.token);
    assert.equal(noRemap.status, 400);
    assert.equal(noRemap.body.error, 'remap_required');
    const bad = await h.call('PATCH', `/api/issues/${t2.key}`, { status: 'Closed' }, a.token);
    assert.equal(bad.status, 409);
    assert.equal(bad.body.error, 'invalid_transition');
    assert.equal((await h.call('PATCH', `/api/issues/${t2.key}`, { status: 'Doing' }, a.token)).status, 200);

    // blocking: t1 blocks t2
    const link = await h.call('POST', `/api/issues/${t1.key}/links`, { type: 'blocks', target: t2.key }, a.token);
    assert.equal(link.status, 201);
    const tgt = (await h.call('GET', `/api/issues/${t2.key}`, undefined, a.token)).body;
    assert.ok(tgt.links.some((l) => l.type === 'blocked_by' && l.target === t1.key));
    const blocked = await h.call('PATCH', `/api/issues/${t2.key}`, { status: 'Closed' }, a.token);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, 'blocked');
    await h.call('PATCH', `/api/issues/${t1.key}`, { status: 'Open' }, a.token);
    await h.call('PATCH', `/api/issues/${t1.key}`, { status: 'Doing' }, a.token);
    await h.call('PATCH', `/api/issues/${t1.key}`, { status: 'Closed' }, a.token);
    const ok2 = await h.call('PATCH', `/api/issues/${t2.key}`, { status: 'Closed' }, a.token);
    assert.equal(ok2.status, 200);
    assert.ok(ok2.body.resolvedAt);
    await h.call('PATCH', `/api/issues/${t2.key}`, { status: 'Doing' }, a.token);
    const reopened = (await h.call('GET', `/api/issues/${t2.key}`, undefined, a.token)).body;
    assert.equal(reopened.resolvedAt, null);

    const hist = (await h.call('GET', `/api/issues/${t2.key}/history`, undefined, a.token)).body;
    assert.ok(hist.some((x) => x.field === 'status' && x.from === 'Todo' && x.to === 'Open'), 'remap recorded');
    assert.ok(hist.some((x) => x.field === 'status' && x.from === 'Open' && x.to === 'Doing'));
    assert.deepEqual(Object.keys(hist[0]).sort(), ['actorId', 'at', 'field', 'from', 'to']);

    // deleting parent removes subtasks
    assert.equal((await h.call('DELETE', `/api/issues/${t1.key}`, undefined, a.token)).status, 204);
    assert.equal((await h.call('GET', `/api/issues/${sub.body.key}`, undefined, a.token)).status, 404);
  } finally { await h.close(); }
});

test('comments, mentions, watchers and notifications', async () => {
  const h = await start();
  try {
    const a = await user(h.call, 'erin');
    const b = await user(h.call, 'frank');
    const ws = (await h.call('POST', '/api/workspaces', { name: 'N', key: 'NOTI' }, a.token)).body;
    await h.call('POST', `/api/workspaces/${ws.id}/members`, { username: 'frank', role: 'member' }, a.token);
    const p = (await h.call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'P', key: 'NP' }, a.token)).body;
    await h.call('POST', `/api/projects/${p.id}/members`, { username: 'frank', role: 'developer' }, a.token);
    const issue = (await h.call('POST', `/api/projects/${p.id}/issues`, { type: 'bug', title: 'Crash' }, a.token)).body;
    // frank assigned -> watcher, gets notified of comment by erin
    await h.call('PATCH', `/api/issues/${issue.key}`, { assigneeId: b.user.id }, a.token);
    const c = await h.call('POST', `/api/issues/${issue.key}/comments`, { body: 'hi @frank please look' }, a.token);
    assert.equal(c.status, 201);
    const n = (await h.call('GET', '/api/notifications?unread=true', undefined, b.token)).body;
    assert.ok(n.some((x) => x.type === 'mentioned' && x.issueKey === issue.key));
    assert.equal(n.filter((x) => x.issueKey === issue.key && x.type === 'commented').length, 0);
    const mine = (await h.call('GET', '/api/notifications', undefined, a.token)).body;
    assert.equal(mine.length, 0, 'actor is not notified of own actions');
    const r = await h.call('POST', '/api/notifications/read', { all: true }, b.token);
    assert.equal(r.status, 200);
    assert.equal((await h.call('GET', '/api/notifications?unread=true', undefined, b.token)).body.length, 0);
    const edit = await h.call('PATCH', `/api/comments/${c.body.id}`, { body: 'edited' }, a.token);
    assert.equal(edit.body.edited, true);
    assert.equal((await h.call('PATCH', `/api/comments/${c.body.id}`, { body: 'x' }, b.token)).status, 403);
    const watched = await h.call('POST', `/api/issues/${issue.key}/watch`, undefined, a.token);
    assert.equal(watched.status, 200);
  } finally { await h.close(); }
});

test('sprints: one active, complete with carry-over, report with burndown', async () => {
  let now = Date.parse('2026-05-04T09:00:00Z');
  const h = await start({ clock: () => new Date(now) });
  try {
    const a = await user(h.call, 'gina');
    const ws = (await h.call('POST', '/api/workspaces', { name: 'S', key: 'SPR' }, a.token)).body;
    const p = (await h.call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'P', key: 'SP' }, a.token)).body;
    const s1 = (await h.call('POST', `/api/projects/${p.id}/sprints`, { name: 'S1', startDate: '2026-05-04', endDate: '2026-05-08' }, a.token)).body;
    const s2 = (await h.call('POST', `/api/projects/${p.id}/sprints`, { name: 'S2' }, a.token)).body;
    const i1 = (await h.call('POST', `/api/projects/${p.id}/issues`, { type: 'task', title: 'a', storyPoints: 3, sprintId: s1.id }, a.token)).body;
    const i2 = (await h.call('POST', `/api/projects/${p.id}/issues`, { type: 'task', title: 'b', storyPoints: 5, sprintId: s1.id }, a.token)).body;
    assert.equal((await h.call('POST', `/api/sprints/${s1.id}/start`, undefined, a.token)).status, 200);
    assert.equal((await h.call('POST', `/api/sprints/${s2.id}/start`, undefined, a.token)).status, 409);
    // day 1 end: finish i1
    now = Date.parse('2026-05-05T12:00:00Z');
    await h.call('PATCH', `/api/issues/${i1.key}`, { status: 'In Progress' }, a.token);
    await h.call('PATCH', `/api/issues/${i1.key}`, { status: 'Done' }, a.token);
    now = Date.parse('2026-05-06T12:00:00Z');
    const beforeComplete = await h.call('GET', `/api/sprints/${s1.id}/report`, undefined, a.token);
    assert.equal(beforeComplete.body.committedPoints, 8);
    assert.equal(beforeComplete.body.completedPoints, 3);
    assert.equal(beforeComplete.body.completedIssues, 1);
    assert.deepEqual(beforeComplete.body.burndown.map((x) => x.date), ['2026-05-04', '2026-05-05', '2026-05-06']);
    assert.deepEqual(beforeComplete.body.burndown.map((x) => x.remainingPoints), [8, 5, 5]);
    const done = await h.call('POST', `/api/sprints/${s1.id}/complete`, { carryOverTo: s2.id }, a.token);
    assert.equal(done.status, 200);
    assert.equal(done.body.state, 'completed');
    const moved = (await h.call('GET', `/api/issues/${i2.key}`, undefined, a.token)).body;
    assert.equal(moved.sprintId, s2.id);
    const rep = (await h.call('GET', `/api/sprints/${s1.id}/report`, undefined, a.token)).body;
    assert.equal(rep.carriedOver, 1);
    const stats = (await h.call('GET', `/api/projects/${p.id}/stats`, undefined, a.token)).body;
    assert.equal(stats.total, 2);
    assert.equal(stats.byStatus.Done, 1);
  } finally { await h.close(); }
});

test('search query language', async () => {
  const h = await start();
  try {
    const a = await user(h.call, 'hank');
    const ws = (await h.call('POST', '/api/workspaces', { name: 'Q', key: 'QQQ' }, a.token)).body;
    const p = (await h.call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'P', key: 'QU' }, a.token)).body;
    const mk = (body) => h.call('POST', `/api/projects/${p.id}/issues`, body, a.token);
    await mk({ type: 'bug', title: 'Login fails on Safari', priority: 'high', storyPoints: 5, labels: ['wontfix'], dueDate: '2026-01-10' });
    await mk({ type: 'task', title: 'Write docs', priority: 'low', storyPoints: 1, labels: ['docs'] });
    await mk({ type: 'bug', title: 'Crash in "export" flow', priority: 'medium', description: 'says Safari' });
    const q = async (s, extra = '') => (await h.call('GET', `/api/search?q=${encodeURIComponent(s)}${extra}`, undefined, a.token));
    assert.equal((await q('type:bug')).body.length, 2);
    assert.equal((await q('priority:high')).body.length, 1);
    assert.equal((await q('-label:wontfix')).body.length, 2);
    assert.equal((await q('points:>3')).body.length, 1);
    assert.equal((await q('due:<2027-01-01')).body.length, 1);
    assert.equal((await q('due:>2027-01-01')).body.length, 0);
    assert.equal((await q('"crash in"')).body.length, 1);
    assert.equal((await q('safari')).body.length, 2);
    assert.equal((await q('status:"Todo"')).body.length, 3);
    assert.equal((await q('is:open')).body.length, 3);
    assert.equal((await q('assignee:none')).body.length, 3);
    assert.equal((await q('assignee:me')).body.length, 0);
    assert.equal((await q('key:QU-2')).body[0].title, 'Write docs');
    assert.equal((await q('sprint:none')).body.length, 3);
    assert.equal((await q('type:bogus')).status, 400);
    assert.equal((await q('priority:')).status, 400);
    assert.equal((await q('"unterminated')).status, 400);
    assert.equal((await q('color:red')).status, 400);
    assert.equal((await q('points:>abc')).status, 400);
    const sorted = (await h.call('GET', `/api/search?q=&sort=priority`, undefined, a.token)).body;
    assert.equal(sorted[0].priority, 'high');
  } finally { await h.close(); }
});

test('csv export and import with per-line errors', async () => {
  const h = await start();
  try {
    const a = await user(h.call, 'ivan');
    const ws = (await h.call('POST', '/api/workspaces', { name: 'C', key: 'CSV' }, a.token)).body;
    const p = (await h.call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'P', key: 'CV' }, a.token)).body;
    const csv = 'key,type,title,status,priority,assignee,labels,storyPoints,parent,epic,sprint,dueDate,createdAt,resolvedAt\n'
      + 'ignored,bug,"Fix, the ""thing""",Todo,high,ivan,a;b,2,,,,2026-02-01,,\n'
      + 'x,task,,Todo,low,,,,,,,,,\n'
      + 'y,task,Second,Nope,low,,,,,,,,,\r\n';
    const imp = await h.call('POST', `/api/projects/${p.id}/import.csv`, undefined, a.token, { text: csv });
    assert.equal(imp.status, 200);
    assert.equal(imp.body.created, 1);
    assert.deepEqual(imp.body.errors.map((e) => e.line), [3, 4]);
    const exp = await h.call('GET', `/api/projects/${p.id}/export.csv`, undefined, a.token);
    assert.equal(exp.status, 200);
    const lines = exp.text.trimEnd().split('\r\n');
    assert.equal(lines[0], 'key,type,title,status,priority,assignee,labels,storyPoints,parent,epic,sprint,dueDate,createdAt,resolvedAt');
    assert.match(lines[1], /^CV-1,bug,"Fix, the ""thing""",Todo,high,ivan,a;b,2,,,,2026-02-01,/);
  } finally { await h.close(); }
});

test('webhooks deliver signed payloads and record deliveries; retries on failure', async () => {
  const received = [];
  const recv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ headers: req.headers, body });
      res.writeHead(received.length === 1 ? 500 : 200);
      res.end('ok');
    });
  });
  await new Promise((r) => recv.listen(0, '127.0.0.1', r));
  const hookUrl = `http://127.0.0.1:${recv.address().port}/hook`;
  const h = await start();
  try {
    const a = await user(h.call, 'judy');
    const ws = (await h.call('POST', '/api/workspaces', { name: 'H', key: 'HOOK' }, a.token)).body;
    const p = (await h.call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'P', key: 'HK' }, a.token)).body;
    const hook = await h.call('POST', `/api/projects/${p.id}/webhooks`, { url: hookUrl, events: ['issue.created'], secret: 's3cret' }, a.token);
    assert.equal(hook.status, 201);
    assert.equal(hook.body.secret, undefined);
    await h.call('POST', `/api/projects/${p.id}/issues`, { type: 'task', title: 'hooked' }, a.token);
    assert.equal(received.length, 2, 'first attempt 500 then retry');
    const sig = received[1].headers['x-pm-signature'];
    const expected = `sha256=${crypto.createHmac('sha256', 's3cret').update(received[1].body).digest('hex')}`;
    assert.equal(sig, expected);
    const payload = JSON.parse(received[1].body);
    assert.equal(payload.event, 'issue.created');
    assert.equal(payload.issue.key, 'HK-1');
    const dl = (await h.call('GET', `/api/webhooks/${hook.body.id}/deliveries`, undefined, a.token)).body;
    assert.equal(dl.length, 1);
    assert.equal(dl[0].status, 200);
    assert.equal(dl[0].attempts, 2);
    const audit = (await h.call('GET', `/api/workspaces/${ws.id}/audit`, undefined, a.token)).body;
    assert.ok(audit.some((x) => x.action === 'webhook.created'));
  } finally {
    await h.close();
    await new Promise((r) => recv.close(r));
  }
});

test('persistence: data survives restart', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pm-'));
  const file = path.join(dir, 'db.json');
  let h = await start({ dataFile: file });
  const a = await user(h.call, 'kate');
  await h.call('POST', '/api/workspaces', { name: 'Persist', key: 'PER' }, a.token);
  await h.close();
  h = await start({ dataFile: file });
  try {
    const login = await h.call('POST', '/api/auth/login', { username: 'kate', password: 'password123' });
    const list = await h.call('GET', '/api/workspaces', undefined, login.body.token);
    assert.equal(list.body[0].key, 'PER');
  } finally { await h.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('static SPA is served and unknown routes are 404 JSON', async () => {
  const h = await start();
  try {
    const root = await fetch(`${h.base}/`);
    assert.equal(root.status, 200);
    assert.match(await root.text(), /<div id="app"/);
    const js = await fetch(`${h.base}/static/app.js`);
    assert.equal(js.status, 200);
    assert.equal((await fetch(`${h.base}/static/../server.js`)).status, 404);
    const nf = await h.call('GET', '/api/nope');
    assert.equal(nf.status, 404);
    assert.equal(nf.body.error, 'not_found');
  } finally { await h.close(); }
});
