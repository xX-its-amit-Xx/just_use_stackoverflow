import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';

async function start(opts) {
  const srv = createServer(opts);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, p, { token, body, raw } = {}) => {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    let payload;
    if (raw !== undefined) { headers['content-type'] = 'application/json'; payload = raw; }
    else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(base + p, { method, headers, body: payload });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  };
  return { srv, call, close: () => new Promise((r) => srv.close(r)) };
}

async function userWithToken(call, username) {
  const reg = await call('POST', '/api/auth/register', { body: { username, password: 'password123' } });
  assert.equal(reg.status, 201);
  const login = await call('POST', '/api/auth/login', { body: { username, password: 'password123' } });
  assert.equal(login.status, 200);
  return { id: reg.body.user.id, token: login.body.token, username };
}

test('auth: register validation, duplicate, login, me, logout', async () => {
  const { call, close } = await start();
  try {
    assert.equal((await call('POST', '/api/auth/register', { body: { username: 'ab', password: 'password123' } })).status, 400);
    assert.equal((await call('POST', '/api/auth/register', { body: { username: 'bob', password: 'short' } })).status, 400);
    const r = await call('POST', '/api/auth/register', { body: { username: 'Bob_1', password: 'password123' } });
    assert.equal(r.status, 201);
    assert.equal(r.body.user.username, 'bob_1');
    assert.equal(r.body.user.displayName, 'bob_1');
    assert.equal(r.body.user.passwordHash, undefined);
    assert.equal((await call('POST', '/api/auth/register', { body: { username: 'BOB_1', password: 'password123' } })).status, 409);
    assert.equal((await call('POST', '/api/auth/login', { body: { username: 'bob_1', password: 'wrongpass' } })).status, 401);
    const login = await call('POST', '/api/auth/login', { body: { username: 'bob_1', password: 'password123' } });
    assert.equal(login.status, 200);
    const me = await call('GET', '/api/auth/me', { token: login.body.token });
    assert.equal(me.status, 200);
    assert.equal(me.body.user.username, 'bob_1');
    assert.equal((await call('POST', '/api/auth/logout', { token: login.body.token })).status, 204);
    assert.equal((await call('GET', '/api/auth/me', { token: login.body.token })).status, 401);
    assert.equal((await call('GET', '/api/auth/me')).status, 401);
    assert.equal((await call('POST', '/api/boards', { raw: '{bad' })).status, 401);
  } finally { await close(); }
});

test('login rate limit after 5 failures', async () => {
  const { call, close } = await start();
  try {
    await call('POST', '/api/auth/register', { body: { username: 'carol', password: 'password123' } });
    for (let i = 0; i < 5; i++) {
      assert.equal((await call('POST', '/api/auth/login', { body: { username: 'carol', password: 'nope-nope' } })).status, 401);
    }
    assert.equal((await call('POST', '/api/auth/login', { body: { username: 'carol', password: 'password123' } })).status, 429);
  } finally { await close(); }
});

test('boards, roles, members and column/card flows', async () => {
  const { call, close } = await start();
  try {
    const alice = await userWithToken(call, 'alice');
    const bob = await userWithToken(call, 'bobby');
    const eve = await userWithToken(call, 'eve');

    assert.equal((await call('POST', '/api/boards', { token: alice.token, body: { name: '' } })).status, 400);
    const b = await call('POST', '/api/boards', { token: alice.token, body: { name: 'Board' } });
    assert.equal(b.status, 201);
    assert.deepEqual(b.body.columns.map((c) => c.name), ['To Do', 'In Progress', 'Done']);
    const boardId = b.body.id;

    const list = await call('GET', '/api/boards', { token: bob.token });
    assert.deepEqual(list.body, []);
    assert.equal((await call('GET', `/api/boards/${boardId}`, { token: eve.token })).status, 403);
    assert.equal((await call('GET', '/api/boards/nope', { token: eve.token })).status, 404);

    // members
    assert.equal((await call('POST', `/api/boards/${boardId}/members`, { token: alice.token, body: { username: 'nobody', role: 'viewer' } })).status, 404);
    assert.equal((await call('POST', `/api/boards/${boardId}/members`, { token: alice.token, body: { username: 'bobby', role: 'owner' } })).status, 400);
    const addB = await call('POST', `/api/boards/${boardId}/members`, { token: alice.token, body: { username: 'bobby', role: 'editor' } });
    assert.equal(addB.status, 201);
    assert.equal((await call('POST', `/api/boards/${boardId}/members`, { token: alice.token, body: { username: 'bobby', role: 'viewer' } })).status, 409);
    await call('POST', `/api/boards/${boardId}/members`, { token: alice.token, body: { username: 'eve', role: 'viewer' } });
    const bobList = await call('GET', '/api/boards', { token: bob.token });
    assert.deepEqual(bobList.body, [{ id: boardId, name: 'Board', role: 'editor' }]);

    // viewer cannot create cards
    const colId = b.body.columns[0].id;
    assert.equal((await call('POST', `/api/columns/${colId}/cards`, { token: eve.token, body: { title: 'x' } })).status, 403);
    // editor can
    const c1 = await call('POST', `/api/columns/${colId}/cards`, { token: bob.token, body: { title: 'First', description: 'Hello world', dueDate: '2030-01-05' } });
    assert.equal(c1.status, 201);
    const c2 = await call('POST', `/api/columns/${colId}/cards`, { token: alice.token, body: { title: 'Second', position: 0, assignees: [bob.id] } });
    assert.equal(c2.status, 201);
    assert.equal(c2.body.position, 0);
    const detail = await call('GET', `/api/boards/${boardId}`, { token: eve.token });
    assert.deepEqual(detail.body.columns[0].cards.map((c) => c.title), ['Second', 'First']);
    assert.deepEqual(detail.body.columns[0].cards.map((c) => c.position), [0, 1]);

    // bad assignee
    assert.equal((await call('POST', `/api/columns/${colId}/cards`, { token: alice.token, body: { title: 'x', assignees: [eve.id, 'zzz'] } })).status, 400);
    assert.equal((await call('POST', `/api/columns/${colId}/cards`, { token: alice.token, body: { title: 'x', dueDate: '2030-02-30' } })).status, 400);

    // search
    const s = await call('GET', `/api/boards/${boardId}/cards?q=HELLO`, { token: alice.token });
    assert.deepEqual(s.body.map((c) => c.title), ['First']);
    const s2 = await call('GET', `/api/boards/${boardId}/cards?due_before=2030-01-05`, { token: alice.token });
    assert.equal(s2.body.length, 0);
    const s3 = await call('GET', `/api/boards/${boardId}/cards?due_before=2030-01-06`, { token: alice.token });
    assert.equal(s3.body.length, 1);

    // move card to Done, wip limit
    const doneId = b.body.columns[2].id;
    const cardFirst = c1.body.id;
    const mv = await call('POST', `/api/cards/${cardFirst}/move`, { token: bob.token, body: { columnId: doneId } });
    assert.equal(mv.status, 200);
    assert.equal(mv.body.columnId, doneId);
    assert.equal((await call('POST', `/api/cards/${cardFirst}/move`, { token: bob.token, body: { columnId: 'nope' } })).status, 400);

    const wip = await call('POST', `/api/boards/${boardId}/columns`, { token: alice.token, body: { name: 'Limited', wipLimit: 1 } });
    assert.equal(wip.status, 201);
    assert.equal((await call('POST', `/api/columns/${wip.body.id}/cards`, { token: alice.token, body: { title: 'a' } })).status, 201);
    const blocked = await call('POST', `/api/columns/${wip.body.id}/cards`, { token: alice.token, body: { title: 'b' } });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, 'wip_limit');

    // activity
    const act = await call('GET', `/api/boards/${boardId}/activity?limit=3`, { token: alice.token });
    assert.equal(act.body.length, 3);
    const types = (await call('GET', `/api/boards/${boardId}/activity`, { token: alice.token })).body.map((a) => a.type);
    assert.ok(types.includes('card.moved'));
    assert.ok(types.includes('member.added'));
    assert.equal(types[0], 'card.created');

    // owner-only settings
    assert.equal((await call('PATCH', `/api/boards/${boardId}`, { token: bob.token, body: { name: 'X' } })).status, 403);
    assert.equal((await call('PATCH', `/api/boards/${boardId}`, { token: alice.token, body: { name: 'Renamed' } })).body.name, 'Renamed');

    // removing members
    assert.equal((await call('DELETE', `/api/boards/${boardId}/members/${alice.id}`, { token: bob.token })).status, 403);
    assert.equal((await call('DELETE', `/api/boards/${boardId}/members/${alice.id}`, { token: alice.token })).status, 400);
    assert.equal((await call('DELETE', `/api/boards/${boardId}/members/${bob.id}`, { token: bob.token })).status, 204);
    assert.equal((await call('GET', `/api/boards/${boardId}`, { token: bob.token })).status, 403);

    // delete board
    assert.equal((await call('DELETE', `/api/boards/${boardId}`, { token: alice.token })).status, 204);
    assert.equal((await call('GET', `/api/boards/${boardId}`, { token: alice.token })).status, 404);
  } finally { await close(); }
});

test('column reorder, delete with cards, and card move ordering', async () => {
  const { call, close } = await start();
  try {
    const u = await userWithToken(call, 'dana');
    const b = (await call('POST', '/api/boards', { token: u.token, body: { name: 'B', columns: ['A', 'B', 'C'] } })).body;
    const [a, bcol, c] = b.columns;
    const moved = await call('PATCH', `/api/columns/${c.id}`, { token: u.token, body: { position: 0 } });
    assert.equal(moved.status, 200);
    const names = (await call('GET', `/api/boards/${b.id}`, { token: u.token })).body.columns.map((x) => x.name);
    assert.deepEqual(names, ['C', 'A', 'B']);
    const card = (await call('POST', `/api/columns/${a.id}/cards`, { token: u.token, body: { title: 'k' } })).body;
    assert.equal((await call('DELETE', `/api/columns/${a.id}`, { token: u.token })).status, 409);
    assert.equal((await call('DELETE', `/api/columns/${a.id}?force=true`, { token: u.token })).status, 204);
    assert.equal((await call('GET', `/api/cards/${card.id}`, { token: u.token })).status, 404);
    const after = (await call('GET', `/api/boards/${b.id}`, { token: u.token })).body.columns;
    assert.deepEqual(after.map((x) => x.position), [0, 1]);

    // move within same column with explicit position
    const x1 = (await call('POST', `/api/columns/${bcol.id}/cards`, { token: u.token, body: { title: '1' } })).body;
    const x2 = (await call('POST', `/api/columns/${bcol.id}/cards`, { token: u.token, body: { title: '2' } })).body;
    const x3 = (await call('POST', `/api/columns/${bcol.id}/cards`, { token: u.token, body: { title: '3' } })).body;
    await call('POST', `/api/cards/${x3.id}/move`, { token: u.token, body: { columnId: bcol.id, position: 0 } });
    const cards = (await call('GET', `/api/boards/${b.id}`, { token: u.token })).body.columns.find((x) => x.id === bcol.id).cards;
    assert.deepEqual(cards.map((x) => x.title), ['3', '1', '2']);
    assert.deepEqual(cards.map((x) => x.position), [0, 1, 2]);
    void x2;
  } finally { await close(); }
});

test('labels, comments and permissions', async () => {
  const { call, close } = await start();
  try {
    const o = await userWithToken(call, 'owen');
    const e = await userWithToken(call, 'eddie');
    const v = await userWithToken(call, 'vera');
    const b = (await call('POST', '/api/boards', { token: o.token, body: { name: 'L', columns: ['X'] } })).body;
    await call('POST', `/api/boards/${b.id}/members`, { token: o.token, body: { username: 'eddie', role: 'editor' } });
    await call('POST', `/api/boards/${b.id}/members`, { token: o.token, body: { username: 'vera', role: 'viewer' } });

    assert.equal((await call('POST', `/api/boards/${b.id}/labels`, { token: o.token, body: { name: 'Bug', color: 'red' } })).status, 400);
    const lbl = await call('POST', `/api/boards/${b.id}/labels`, { token: o.token, body: { name: 'Bug', color: '#ff0000' } });
    assert.equal(lbl.status, 201);
    assert.equal((await call('POST', `/api/boards/${b.id}/labels`, { token: o.token, body: { name: 'BUG', color: '#00ff00' } })).status, 409);

    const card = (await call('POST', `/api/columns/${b.columns[0].id}/cards`, { token: e.token, body: { title: 'c', labels: [lbl.body.id] } })).body;
    assert.deepEqual(card.labels, [lbl.body.id]);

    const com = await call('POST', `/api/cards/${card.id}/comments`, { token: e.token, body: { body: 'hi' } });
    assert.equal(com.status, 201);
    assert.equal((await call('POST', `/api/cards/${card.id}/comments`, { token: v.token, body: { body: 'hi' } })).status, 403);
    assert.equal((await call('POST', `/api/cards/${card.id}/comments`, { token: e.token, body: { body: '' } })).status, 400);
    assert.equal((await call('DELETE', `/api/comments/${com.body.id}`, { token: v.token })).status, 403);
    assert.equal((await call('DELETE', `/api/comments/${com.body.id}`, { token: o.token })).status, 204);

    const com2 = await call('POST', `/api/cards/${card.id}/comments`, { token: e.token, body: { body: 'second' } });
    assert.equal((await call('DELETE', `/api/comments/${com2.body.id}`, { token: o.token })).status, 204);
    const comments = await call('GET', `/api/cards/${card.id}/comments`, { token: v.token });
    assert.equal(comments.body.length, 0);

    assert.equal((await call('DELETE', `/api/labels/${lbl.body.id}`, { token: e.token })).status, 204);
    const fetched = await call('GET', `/api/cards/${card.id}`, { token: e.token });
    assert.deepEqual(fetched.body.labels, []);
  } finally { await close(); }
});

test('persistence across server instances; password not stored in plaintext', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-'));
  const file = path.join(dir, 'data.json');
  try {
    const s1 = await start({ dataFile: file });
    const u = await userWithToken(s1.call, 'pers');
    const b = await s1.call('POST', '/api/boards', { token: u.token, body: { name: 'Persist' } });
    await s1.close();
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes('password123'));

    const s2 = await start({ dataFile: file });
    const login = await s2.call('POST', '/api/auth/login', { body: { username: 'pers', password: 'password123' } });
    assert.equal(login.status, 200);
    const got = await s2.call('GET', `/api/boards/${b.body.id}`, { token: login.body.token });
    assert.equal(got.status, 200);
    assert.equal(got.body.name, 'Persist');
    await s2.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('invalid json, unknown routes, static UI', async () => {
  const { call, close } = await start();
  try {
    const u = await userWithToken(call, 'json');
    assert.equal((await call('POST', '/api/boards', { token: u.token, raw: '{nope' })).status, 400);
    assert.equal((await call('GET', '/api/unknown', { token: u.token })).status, 404);
    const page = await call('GET', '/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const js = await call('GET', '/static/app.js');
    assert.equal(js.status, 200);
    assert.equal((await call('GET', '/static/..%2Fserver.js')).status, 404);
  } finally { await close(); }
});
