import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../../src/server.js';

async function start(opts = {}) {
  const srv = createServer(opts);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, p, body, token) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  };
  return { srv, call, base };
}

async function user(call, username, password = 'password123') {
  const reg = await call('POST', '/api/auth/register', { username, password });
  assert.equal(reg.status, 201);
  const login = await call('POST', '/api/auth/login', { username, password });
  assert.equal(login.status, 200);
  return { token: login.body.token, user: login.body.user };
}

test('auth: register validation, duplicates, login, me, logout', async () => {
  const { srv, call } = await start();
  try {
    assert.equal((await call('POST', '/api/auth/register', { username: 'ab', password: 'password123' })).status, 400);
    assert.equal((await call('POST', '/api/auth/register', { username: 'bad-name', password: 'password123' })).status, 400);
    assert.equal((await call('POST', '/api/auth/register', { username: 'carol', password: 'short' })).status, 400);
    const r = await call('POST', '/api/auth/register', { username: 'Carol', password: 'password123' });
    assert.equal(r.status, 201);
    assert.equal(r.body.user.username, 'carol');
    assert.equal(r.body.user.displayName, 'carol');
    assert.equal(r.body.user.password, undefined);
    assert.equal((await call('POST', '/api/auth/register', { username: 'carol', password: 'password123' })).status, 409);
    assert.equal((await call('POST', '/api/auth/login', { username: 'carol', password: 'nope-nope' })).status, 401);
    const login = await call('POST', '/api/auth/login', { username: 'carol', password: 'password123' });
    assert.equal(login.status, 200);
    assert.ok(login.body.token);
    const me = await call('GET', '/api/auth/me', undefined, login.body.token);
    assert.equal(me.body.user.username, 'carol');
    assert.equal((await call('GET', '/api/auth/me')).status, 401);
    assert.equal((await call('POST', '/api/auth/logout', undefined, login.body.token)).status, 204);
    assert.equal((await call('GET', '/api/auth/me', undefined, login.body.token)).status, 401);
  } finally { srv.close(); }
});

test('login is rate limited after 5 failures', async () => {
  const { srv, call } = await start();
  try {
    await user(call, 'dave');
    for (let i = 0; i < 5; i++) {
      assert.equal((await call('POST', '/api/auth/login', { username: 'dave', password: 'wrong-pass' })).status, 401);
    }
    assert.equal((await call('POST', '/api/auth/login', { username: 'dave', password: 'password123' })).status, 429);
  } finally { srv.close(); }
});

test('invalid JSON → 400, unknown route → 404, plaintext password not stored', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-'));
  const file = path.join(dir, 'data.json');
  const { srv, call, base } = await start({ dataFile: file });
  try {
    const res = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
    assert.equal(res.status, 400);
    assert.equal((await call('GET', '/api/nothing')).status, 404);
    await user(call, 'erin', 'supersecret1');
    assert.ok(!fs.readFileSync(file, 'utf8').includes('supersecret1'));
  } finally { srv.close(); }
});

test('boards, roles, members, columns and cards', async () => {
  const { srv, call } = await start();
  try {
    const owner = await user(call, 'owner1');
    const ed = await user(call, 'editor1');
    const vw = await user(call, 'viewer1');
    const outsider = await user(call, 'outsider1');

    const b = await call('POST', '/api/boards', { name: 'Proj' }, owner.token);
    assert.equal(b.status, 201);
    const boardId = b.body.id;
    assert.deepEqual(b.body.columns.map((c) => c.name), ['To Do', 'In Progress', 'Done']);
    assert.equal((await call('POST', '/api/boards', { name: '' }, owner.token)).status, 400);

    assert.equal((await call('POST', `/api/boards/${boardId}/members`, { username: 'editor1', role: 'editor' }, owner.token)).status, 201);
    assert.equal((await call('POST', `/api/boards/${boardId}/members`, { username: 'viewer1', role: 'viewer' }, owner.token)).status, 201);
    assert.equal((await call('POST', `/api/boards/${boardId}/members`, { username: 'editor1', role: 'editor' }, owner.token)).status, 409);
    assert.equal((await call('POST', `/api/boards/${boardId}/members`, { username: 'ghost', role: 'editor' }, owner.token)).status, 404);
    assert.equal((await call('POST', `/api/boards/${boardId}/members`, { username: 'outsider1', role: 'owner' }, owner.token)).status, 400);

    assert.equal((await call('GET', `/api/boards/${boardId}`, undefined, outsider.token)).status, 403);
    assert.equal((await call('GET', `/api/boards/nope`, undefined, owner.token)).status, 404);
    assert.equal((await call('GET', '/api/boards', undefined, outsider.token)).body.length, 0);
    assert.equal((await call('GET', '/api/boards', undefined, ed.token)).body[0].role, 'editor');

    // viewer: read only
    assert.equal((await call('POST', `/api/boards/${boardId}/columns`, { name: 'X' }, vw.token)).status, 403);
    assert.equal((await call('PATCH', `/api/boards/${boardId}`, { name: 'Hack' }, ed.token)).status, 403);
    assert.equal((await call('GET', `/api/boards/${boardId}`, undefined, vw.token)).status, 200);

    // editor: columns + cards
    const col = await call('POST', `/api/boards/${boardId}/columns`, { name: 'Review', wipLimit: 1 }, ed.token);
    assert.equal(col.status, 201);
    assert.equal(col.body.position, 3);
    const card = await call('POST', `/api/columns/${col.body.id}/cards`, { title: 'Task A', dueDate: '2026-05-01' }, ed.token);
    assert.equal(card.status, 201);
    assert.equal(card.body.position, 0);
    const wip = await call('POST', `/api/columns/${col.body.id}/cards`, { title: 'Task B' }, ed.token);
    assert.equal(wip.status, 409);
    assert.equal(wip.body.error, 'wip_limit');
    assert.equal((await call('POST', `/api/columns/${col.body.id}/cards`, { title: 'x', dueDate: '2026-02-30' }, ed.token)).status, 400);
    assert.equal((await call('POST', `/api/columns/${col.body.id}/cards`, { title: 'x', assignees: [outsider.user.id] }, ed.token)).status, 400);

    // move to To Do (no limit)
    const todo = b.body.columns[0];
    const moved = await call('POST', `/api/cards/${card.body.id}/move`, { columnId: todo.id }, ed.token);
    assert.equal(moved.status, 200);
    assert.equal(moved.body.columnId, todo.id);
    assert.equal((await call('POST', `/api/cards/${card.body.id}/move`, { columnId: 'missing' }, ed.token)).status, 400);

    const detail = await call('GET', `/api/boards/${boardId}`, undefined, owner.token);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.members.length, 3);
    assert.equal(detail.body.columns[0].cards[0].id, card.body.id);

    // activity
    const act = await call('GET', `/api/boards/${boardId}/activity?limit=3`, undefined, owner.token);
    assert.equal(act.body.length, 3);
    assert.equal(act.body[0].type, 'card.moved');
    assert.equal(act.body[0].details.toColumnId, todo.id);

    // owner-only: delete column with cards
    assert.equal((await call('DELETE', `/api/columns/${col.body.id}`, undefined, ed.token)).status, 204);
    assert.equal((await call('DELETE', `/api/boards/${boardId}`, undefined, ed.token)).status, 403);
    assert.equal((await call('DELETE', `/api/boards/${boardId}/members/${ed.user.id}`, undefined, vw.token)).status, 403);
    assert.equal((await call('DELETE', `/api/boards/${boardId}/members/${owner.user.id}`, undefined, owner.token)).status, 400);
    assert.equal((await call('DELETE', `/api/boards/${boardId}/members/${vw.user.id}`, undefined, vw.token)).status, 204);
    assert.equal((await call('DELETE', `/api/boards/${boardId}`, undefined, owner.token)).status, 204);
    assert.equal((await call('GET', `/api/boards/${boardId}`, undefined, owner.token)).status, 404);
  } finally { srv.close(); }
});

test('card placement, move between columns, and column deletion with force', async () => {
  const { srv, call } = await start();
  try {
    const o = await user(call, 'pilot1');
    const board = (await call('POST', '/api/boards', { name: 'B', columns: ['A', 'B'] }, o.token)).body;
    const [a, bcol] = board.columns;
    const mk = async (title, pos) => (await call('POST', `/api/columns/${a.id}/cards`, { title, position: pos }, o.token)).body;
    const c1 = await mk('one');
    const c2 = await mk('two');
    const c3 = await mk('three', 0);
    const orderIn = async (colId) => (await call('GET', `/api/boards/${board.id}`, undefined, o.token)).body
      .columns.find((c) => c.id === colId).cards.map((c) => c.title);
    assert.deepEqual(await orderIn(a.id), ['three', 'one', 'two']);
    assert.equal((await call('POST', `/api/cards/${c2.id}/move`, { columnId: bcol.id, position: 0 }, o.token)).status, 200);
    assert.deepEqual(await orderIn(a.id), ['three', 'one']);
    assert.deepEqual(await orderIn(bcol.id), ['two']);
    const r = await call('PATCH', `/api/columns/${bcol.id}`, { position: 0 }, o.token);
    assert.equal(r.status, 200);
    assert.equal(r.body.position, 0);
    const cols = (await call('GET', `/api/boards/${board.id}`, undefined, o.token)).body.columns;
    assert.deepEqual(cols.map((c) => [c.name, c.position]), [['B', 0], ['A', 1]]);
    assert.equal((await call('DELETE', `/api/columns/${a.id}`, undefined, o.token)).status, 409);
    assert.equal((await call('DELETE', `/api/columns/${a.id}?force=true`, undefined, o.token)).status, 204);
    assert.equal((await call('GET', `/api/cards/${c1.id}`, undefined, o.token)).status, 404);
    assert.equal(c3.id !== undefined, true);
  } finally { srv.close(); }
});

test('labels, comments, search and activity', async () => {
  const { srv, call } = await start();
  try {
    const o = await user(call, 'searcher');
    const ed = await user(call, 'helper');
    const board = (await call('POST', '/api/boards', { name: 'S' }, o.token)).body;
    await call('POST', `/api/boards/${board.id}/members`, { username: 'helper', role: 'editor' }, o.token);
    const col = board.columns[0];
    const lbl = await call('POST', `/api/boards/${board.id}/labels`, { name: 'Bug', color: '#ff0000' }, o.token);
    assert.equal(lbl.status, 201);
    assert.equal((await call('POST', `/api/boards/${board.id}/labels`, { name: 'bug', color: '#ff0000' }, o.token)).status, 409);
    assert.equal((await call('POST', `/api/boards/${board.id}/labels`, { name: 'x', color: 'red' }, o.token)).status, 400);
    const c = await call('POST', `/api/columns/${col.id}/cards`, { title: 'Fix login', description: 'Crash on SUBMIT', labels: [lbl.body.id], assignees: [ed.user.id], dueDate: '2026-03-01' }, o.token);
    await call('POST', `/api/columns/${col.id}/cards`, { title: 'Write docs', dueDate: '2026-06-01' }, o.token);
    assert.equal(c.status, 201);

    const cm = await call('POST', `/api/cards/${c.body.id}/comments`, { body: 'on it' }, ed.token);
    assert.equal(cm.status, 201);
    assert.equal((await call('POST', `/api/cards/${c.body.id}/comments`, { body: '' }, ed.token)).status, 400);
    assert.equal((await call('DELETE', `/api/comments/${cm.body.id}`, undefined, o.token)).status, 204);
    const cm2 = await call('POST', `/api/cards/${c.body.id}/comments`, { body: 'mine' }, o.token);
    assert.equal((await call('DELETE', `/api/comments/${cm2.body.id}`, undefined, ed.token)).status, 403);

    const q = await call('GET', `/api/boards/${board.id}/cards?q=submit`, undefined, o.token);
    assert.deepEqual(q.body.map((x) => x.title), ['Fix login']);
    const f = await call('GET', `/api/boards/${board.id}/cards?assignee=${ed.user.id}&label=${lbl.body.id}`, undefined, o.token);
    assert.equal(f.body.length, 1);
    const due = await call('GET', `/api/boards/${board.id}/cards?due_before=2026-03-01`, undefined, o.token);
    assert.equal(due.body.length, 0);
    const due2 = await call('GET', `/api/boards/${board.id}/cards?due_before=2026-03-02`, undefined, o.token);
    assert.equal(due2.body.length, 1);

    assert.equal((await call('DELETE', `/api/labels/${lbl.body.id}`, undefined, o.token)).status, 204);
    const after = await call('GET', `/api/cards/${c.body.id}`, undefined, o.token);
    assert.deepEqual(after.body.labels, []);

    const act = await call('GET', `/api/boards/${board.id}/activity`, undefined, o.token);
    const types = new Set(act.body.map((a) => a.type));
    for (const t of ['board.created', 'column.created', 'card.created', 'comment.added', 'member.added']) assert.ok(types.has(t), t);
  } finally { srv.close(); }
});

test('data persists across server instances', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-'));
  const file = path.join(dir, 'data.json');
  let s1 = await start({ dataFile: file });
  const o = await user(s1.call, 'persist1');
  const b = await s1.call('POST', '/api/boards', { name: 'Keep' }, o.token);
  s1.srv.close();
  const s2 = await start({ dataFile: file });
  try {
    const login = await s2.call('POST', '/api/auth/login', { username: 'persist1', password: 'password123' });
    assert.equal(login.status, 200);
    const got = await s2.call('GET', `/api/boards/${b.body.id}`, undefined, login.body.token);
    assert.equal(got.body.name, 'Keep');
  } finally { s2.srv.close(); }
});

test('static UI is served at /', async () => {
  const { srv, call } = await start();
  try {
    const res = await fetch(`http://127.0.0.1:${srv.address().port}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const js = await call('GET', '/static/app.js');
    assert.equal(js.status, 200);
  } finally { srv.close(); }
});
