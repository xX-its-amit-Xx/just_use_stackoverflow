import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from '../../src/server.js';
import { parseCSV, formatCSV } from '../../src/csv.js';
import { parseQuery } from '../../src/query.js';

async function start(opts = {}) {
  const srv = createServer(opts);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, b, t, raw) => {
    const headers = { ...(t ? { authorization: `Bearer ${t}` } : {}) };
    let body;
    if (raw !== undefined) { headers['content-type'] = 'text/csv'; body = raw; }
    else if (b !== undefined) { headers['content-type'] = 'application/json'; body = JSON.stringify(b); }
    const r = await fetch(base + p, { method: m, headers, body });
    const text = await r.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: r.status, body: json, text };
  };
  return { srv, call, base };
}

async function user(call, name) {
  await call('POST', '/api/auth/register', { username: name, password: 'password123' });
  return (await call('POST', '/api/auth/login', { username: name, password: 'password123' })).body.token;
}

test('auth: register, login, rate limit, me, logout', async () => {
  const { srv, call } = await start();
  try {
    assert.equal((await call('POST', '/api/auth/register', { username: 'bob', password: 'password123' })).status, 201);
    assert.equal((await call('POST', '/api/auth/register', { username: 'bob', password: 'password123' })).status, 409);
    assert.equal((await call('POST', '/api/auth/register', { username: 'x', password: 'short' })).status, 400);
    for (let k = 0; k < 5; k++) assert.equal((await call('POST', '/api/auth/login', { username: 'bob', password: 'wrong-pass' })).status, 401);
    assert.equal((await call('POST', '/api/auth/login', { username: 'bob', password: 'password123' })).status, 429);
  } finally { srv.close(); }
  const s2 = await start();
  try {
    const tok = await user(s2.call, 'carol');
    const me = await s2.call('GET', '/api/auth/me', undefined, tok);
    assert.equal(me.body.user.username, 'carol');
    assert.equal(me.body.user.passwordHash, undefined);
    assert.equal((await s2.call('GET', '/api/auth/me')).status, 401);
    assert.equal((await s2.call('POST', '/api/auth/logout', undefined, tok)).status, 204);
    assert.equal((await s2.call('GET', '/api/auth/me', undefined, tok)).status, 401);
  } finally { s2.srv.close(); }
});

test('API tokens authenticate and can be revoked', async () => {
  const { srv, call } = await start();
  try {
    const tok = await user(call, 'dana');
    const t = (await call('POST', '/api/tokens', { name: 'ci' }, tok)).body;
    assert.match(t.token, /^pat_/);
    assert.equal((await call('GET', '/api/auth/me', undefined, t.token)).status, 200);
    assert.equal((await call('GET', '/api/tokens', undefined, tok)).body[0].token, undefined);
    assert.equal((await call('DELETE', `/api/tokens/${t.id}`, undefined, tok)).status, 204);
    assert.equal((await call('GET', '/api/auth/me', undefined, t.token)).status, 401);
  } finally { srv.close(); }
});

test('workspaces, RBAC, projects, workflow, issues', async () => {
  const { srv, call } = await start();
  try {
    const a = await user(call, 'alice');
    const b = await user(call, 'bob2');
    const g = await user(call, 'gina');
    const ws = (await call('POST', '/api/workspaces', { name: 'Acme', key: 'ACME' }, a)).body;
    assert.equal((await call('POST', '/api/workspaces', { name: 'Dup', key: 'ACME' }, a)).status, 409);
    assert.equal((await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'bob2', role: 'member' }, a)).status, 201);
    assert.equal((await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'gina', role: 'guest' }, a)).status, 201);
    // guest cannot create projects
    assert.equal((await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'G', key: 'GG' }, g)).status, 403);
    const pr = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Web', key: 'WEB' }, b)).body;
    assert.equal(pr.workflow.statuses.length, 5);
    // member without project membership -> 403
    assert.equal((await call('GET', `/api/projects/${pr.id}`, undefined, a)).status, 200);
    assert.equal((await call('GET', `/api/projects/${pr.id}`, undefined, g)).status, 403);
    assert.equal((await call('POST', `/api/projects/${pr.id}/members`, { username: 'gina', role: 'viewer' }, b)).status, 201);
    assert.equal((await call('GET', `/api/projects/${pr.id}`, undefined, g)).status, 200);
    // viewer cannot create issues
    assert.equal((await call('POST', `/api/projects/${pr.id}/issues`, { type: 'task', title: 'x' }, g)).status, 403);
    const i1 = await call('POST', `/api/projects/${pr.id}/issues`, { type: 'task', title: 'First', storyPoints: 3 }, b);
    assert.equal(i1.status, 201);
    assert.equal(i1.body.key, 'WEB-1');
    assert.equal(i1.body.status, 'Todo');
    assert.equal((await call('POST', `/api/projects/${pr.id}/issues`, { type: 'subtask', title: 'orphan' }, b)).status, 400);
    const sub = await call('POST', `/api/projects/${pr.id}/issues`, { type: 'subtask', title: 'sub', parentId: i1.body.id }, b);
    assert.equal(sub.status, 201);
    const epic = (await call('POST', `/api/projects/${pr.id}/issues`, { type: 'epic', title: 'E' }, b)).body;
    assert.equal((await call('POST', `/api/projects/${pr.id}/issues`, { type: 'epic', title: 'E2', parentId: i1.body.id }, b)).status, 400);
    await call('PATCH', `/api/issues/${i1.body.key}`, { epicId: epic.id }, b);
    const detail = (await call('GET', `/api/issues/${i1.body.key}`, undefined, b)).body;
    assert.deepEqual(detail.children, [sub.body.key]);
    const edetail = (await call('GET', `/api/issues/${epic.key}`, undefined, b)).body;
    assert.equal(edetail.progress.total, 1);
    assert.equal(edetail.progress.points_total, 3);
    // transitions: default allows any -> any
    const t1 = await call('PATCH', `/api/issues/${i1.body.key}`, { status: 'Done' }, b);
    assert.equal(t1.status, 200);
    assert.ok(t1.body.resolvedAt);
    const back = await call('PATCH', `/api/issues/${i1.body.key}`, { status: 'In Progress' }, b);
    assert.equal(back.body.resolvedAt, null);
    // custom workflow with invalid transition
    const wf = await call('PUT', `/api/projects/${pr.id}/workflow`, {
      statuses: [{ name: 'Open', category: 'unstarted' }, { name: 'Closed', category: 'completed' }],
      transitions: [['Open', 'Closed']],
    }, g);
    assert.equal(wf.status, 403); // gina is a viewer, not lead
    const wf2 = await call('PUT', `/api/projects/${pr.id}/workflow`, {
      statuses: [{ name: 'Open', category: 'unstarted' }, { name: 'Closed', category: 'completed' }],
      transitions: [['Open', 'Closed']],
    }, a);
    assert.equal(wf2.status, 400); // in-use statuses removed without remap
    const wf3 = await call('PUT', `/api/projects/${pr.id}/workflow`, {
      statuses: [{ name: 'Open', category: 'unstarted' }, { name: 'Closed', category: 'completed' }],
      transitions: [['Open', 'Closed']],
      remap: { Todo: 'Open', 'In Progress': 'Open', Done: 'Closed', Backlog: 'Open', 'In Review': 'Open' },
    }, a);
    assert.equal(wf3.status, 200);
    const bad = await call('PATCH', `/api/issues/${i1.body.key}`, { status: 'Open' }, b);
    assert.equal(bad.status, 200); // already Open after remap; no-op
    const inv = await call('PATCH', `/api/issues/${i1.body.key}`, { status: 'Closed' }, b);
    assert.equal(inv.status, 200);
    const inv2 = await call('PATCH', `/api/issues/${i1.body.key}`, { status: 'Open' }, b);
    assert.equal(inv2.status, 409); // Closed -> Open is not in the custom workflow
    assert.equal(inv2.body.error, 'invalid_transition');
    const hist = (await call('GET', `/api/issues/${i1.body.key}/history`, undefined, b)).body;
    assert.ok(hist.some((h) => h.field === 'status' && h.to === 'Closed'));
    // audit visible to admin only
    assert.equal((await call('GET', `/api/workspaces/${ws.id}/audit`, undefined, b)).status, 403);
    const audit = await call('GET', `/api/workspaces/${ws.id}/audit`, undefined, a);
    assert.ok(audit.body.some((x) => x.action === 'workflow.updated'));
    // last admin cannot be removed
    assert.equal((await call('DELETE', `/api/workspaces/${ws.id}/members/alice`, undefined, a)).status, 400);
  } finally { srv.close(); }
});

test('links, blocking, comments, mentions, notifications', async () => {
  const { srv, call } = await start();
  try {
    const a = await user(call, 'alice');
    const b = await user(call, 'bob2');
    const ws = (await call('POST', '/api/workspaces', { name: 'Acme', key: 'ACME' }, a)).body;
    await call('POST', `/api/workspaces/${ws.id}/members`, { username: 'bob2', role: 'member' }, a);
    const pr = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Web', key: 'WEB' }, a)).body;
    await call('POST', `/api/projects/${pr.id}/members`, { username: 'bob2', role: 'developer' }, a);
    const x = (await call('POST', `/api/projects/${pr.id}/issues`, { type: 'task', title: 'X' }, a)).body;
    const y = (await call('POST', `/api/projects/${pr.id}/issues`, { type: 'bug', title: 'Y', assigneeId: undefined }, b)).body;
    assert.equal((await call('POST', `/api/issues/${x.key}/links`, { type: 'blocks', target: y.key }, a)).status, 201);
    const yd = (await call('GET', `/api/issues/${y.key}`, undefined, a)).body;
    assert.equal(yd.links[0].type, 'blocked_by');
    const blocked = await call('PATCH', `/api/issues/${y.key}`, { status: 'Done' }, a);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, 'blocked');
    await call('PATCH', `/api/issues/${x.key}`, { status: 'Done' }, a);
    assert.equal((await call('PATCH', `/api/issues/${y.key}`, { status: 'Done' }, a)).status, 200);
    // comment mention notifies bob (watcher-less) if he can see the project
    const c = await call('POST', `/api/issues/${x.key}/comments`, { body: 'hey @bob2 look' }, a);
    assert.equal(c.status, 201);
    const n = (await call('GET', '/api/notifications?unread=true', undefined, b)).body;
    assert.equal(n[0].type, 'mention');
    assert.equal((await call('POST', '/api/notifications/read', { all: true }, b)).status, 204);
    assert.equal((await call('GET', '/api/notifications?unread=true', undefined, b)).body.length, 0);
    // author-only edit
    const e = await call('PATCH', `/api/comments/${c.body.id}`, { body: 'edited' }, b);
    assert.equal(e.status, 403);
    const e2 = await call('PATCH', `/api/comments/${c.body.id}`, { body: 'edited' }, a);
    assert.equal(e2.body.edited, true);
  } finally { srv.close(); }
});

test('sprints, report, stats, search', async () => {
  let now = Date.parse('2026-01-01T10:00:00Z');
  const { srv, call } = await start({ clock: () => new Date(now) });
  try {
    const a = await user(call, 'alice');
    const ws = (await call('POST', '/api/workspaces', { name: 'Acme', key: 'ACME' }, a)).body;
    const pr = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Web', key: 'WEB' }, a)).body;
    const s1 = (await call('POST', `/api/projects/${pr.id}/sprints`, { name: 'S1', startDate: '2026-01-01', endDate: '2026-01-03' }, a)).body;
    const s2 = (await call('POST', `/api/projects/${pr.id}/sprints`, { name: 'S2' }, a)).body;
    const i1 = (await call('POST', `/api/projects/${pr.id}/issues`, { type: 'task', title: 'Login page', storyPoints: 5, sprintId: s1.id, labels: ['ui'], priority: 'high', dueDate: '2026-02-01' }, a)).body;
    const i2 = (await call('POST', `/api/projects/${pr.id}/issues`, { type: 'bug', title: 'Crash on save', storyPoints: 2, sprintId: s1.id, priority: 'urgent' }, a)).body;
    assert.equal((await call('POST', `/api/sprints/${s1.id}/start`, undefined, a)).status, 200);
    assert.equal((await call('POST', `/api/sprints/${s2.id}/start`, undefined, a)).status, 409);
    now += 24 * 3600e3;
    await call('PATCH', `/api/issues/${i1.key}`, { status: 'Done' }, a);
    now += 3600e3;
    const rep = (await call('GET', `/api/sprints/${s1.id}/report`, undefined, a)).body;
    assert.equal(rep.committedPoints, 7);
    assert.equal(rep.completedPoints, 5);
    assert.deepEqual(rep.completedIssues, [i1.key]);
    assert.deepEqual(rep.burndown.map((d) => d.remainingPoints), [7, 2]);
    const comp = await call('POST', `/api/sprints/${s1.id}/complete`, { carryOverTo: s2.id }, a);
    assert.equal(comp.body.state, 'completed');
    assert.deepEqual(comp.body.carriedOver, [i2.key]);
    assert.equal((await call('GET', `/api/issues/${i2.key}`, undefined, a)).body.sprintId, s2.id);
    // search
    const q = async (s) => (await call('GET', `/api/search?q=${encodeURIComponent(s)}`, undefined, a));
    assert.equal((await q('label:ui')).body.length, 1);
    assert.equal((await q('priority:urgent')).body.length, 1);
    assert.equal((await q('-label:ui')).body.length, 1);
    assert.equal((await q('"crash on"')).body.length, 1);
    assert.equal((await q('type:bug is:open')).body.length, 1);
    assert.equal((await q('due:<2026-03-01')).body.length, 1);
    assert.equal((await q('points:>3')).body.length, 1);
    assert.equal((await q(`sprint:${s2.id}`)).body.length, 1);
    assert.equal((await q('key:WEB-1')).body[0].key, 'WEB-1');
    assert.equal((await q('status:"Done"')).body.length, 1);
    assert.equal((await q('assignee:none')).body.length, 2);
    assert.equal((await q('type:nope')).status, 400);
    assert.equal((await q('label:"open')).status, 400);
    assert.equal((await q('foo:bar')).status, 400);
    const stats = (await call('GET', `/api/projects/${pr.id}/stats`, undefined, a)).body;
    assert.equal(stats.total, 2);
    assert.equal(stats.byType.bug, 1);
    assert.equal(stats.byAssignee.unassigned, 2);
    assert.ok(stats.avgCycleTimeHours >= 0);
  } finally { srv.close(); }
});

test('CSV export/import round trip', async () => {
  const { srv, call } = await start();
  try {
    const a = await user(call, 'alice');
    const ws = (await call('POST', '/api/workspaces', { name: 'Acme', key: 'ACME' }, a)).body;
    const pr = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Web', key: 'WEB' }, a)).body;
    await call('POST', `/api/projects/${pr.id}/issues`, { type: 'task', title: 'Has, comma "quote"', labels: ['a', 'b'], storyPoints: 2 }, a);
    const csv = (await call('GET', `/api/projects/${pr.id}/export.csv`, undefined, a)).text;
    assert.match(csv.split('\r\n')[0], /^key,type,title,status,priority,assignee,labels,storyPoints,parent,epic,sprint,dueDate,createdAt,resolvedAt$/);
    assert.ok(csv.includes('"Has, comma ""quote"""'));
    const pr2 = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Two', key: 'TWO' }, a)).body;
    const imp = await call('POST', `/api/projects/${pr2.id}/import.csv`, undefined, a, 'key,type,title,labels,storyPoints\nX,task,Good,a;b,3\nX,bogus,Bad,,\nX,bug,Also good,,\n');
    assert.equal(imp.body.created, 2);
    assert.equal(imp.body.errors.length, 1);
    assert.equal(imp.body.errors[0].line, 3);
    const list = (await call('GET', `/api/projects/${pr2.id}/issues`, undefined, a)).body;
    assert.deepEqual(list.map((i) => i.key), ['TWO-1', 'TWO-2']);
  } finally { srv.close(); }
});

test('webhooks deliver signed payloads and record attempts', async () => {
  const received = [];
  const recv = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { received.push({ sig: req.headers['x-pm-signature'], body }); res.writeHead(received.length === 1 ? 500 : 200); res.end(); });
  });
  await new Promise((r) => recv.listen(0, '127.0.0.1', r));
  const { srv, call } = await start();
  try {
    const a = await user(call, 'alice');
    const ws = (await call('POST', '/api/workspaces', { name: 'Acme', key: 'ACME' }, a)).body;
    const pr = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Web', key: 'WEB' }, a)).body;
    const hook = (await call('POST', `/api/projects/${pr.id}/webhooks`, {
      url: `http://127.0.0.1:${recv.address().port}/hook`, events: ['issue.created'], secret: 's3cret',
    }, a)).body;
    await call('POST', `/api/projects/${pr.id}/issues`, { type: 'task', title: 'Hook me' }, a);
    assert.equal(received.length, 2);
    const expected = 'sha256=' + (await import('node:crypto')).createHmac('sha256', 's3cret').update(received[1].body).digest('hex');
    assert.equal(received[1].sig, expected);
    assert.equal(JSON.parse(received[1].body).event, 'issue.created');
    const d = (await call('GET', `/api/webhooks/${hook.id}/deliveries`, undefined, a)).body;
    assert.equal(d[0].attempts, 2);
    assert.equal(d[0].status, 200);
  } finally { srv.close(); recv.close(); }
});

test('CSV parser and query parser basics', () => {
  assert.deepEqual(parseCSV('a,"b,""c""",\r\n1,2,3\n'), [['a', 'b,"c"', ''], ['1', '2', '3']]);
  assert.equal(formatCSV([['a', 'x"y']]), 'a,"x""y"\r\n');
  assert.throws(() => parseQuery('"unterminated'));
  assert.equal(parseQuery('-label:x  free "two words"').length, 3);
});
