import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';

async function start(opts = {}) {
  const srv = createServer(opts);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, p, body, token) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return {
    srv,
    call,
    close: () => new Promise((r) => {
      srv.close(r);
      srv.closeAllConnections();
    }),
  };
}

async function userWithToken(call, username) {
  const reg = await call('POST', '/api/auth/register', { username, password: 'password123' });
  assert.equal(reg.status, 201);
  const login = await call('POST', '/api/auth/login', { username, password: 'password123' });
  assert.equal(login.status, 200);
  return { id: reg.body.user.id, token: login.body.token, username };
}

test('auth: register validation, duplicates, login, me, logout', async () => {
  const { call, close } = await start();
  try {
    assert.equal((await call('POST', '/api/auth/register', { username: 'ab', password: 'password123' })).status, 400);
    assert.equal((await call('POST', '/api/auth/register', { username: 'bob', password: 'short' })).status, 400);
    const r = await call('POST', '/api/auth/register', { username: 'Bob', password: 'password123' });
    assert.equal(r.status, 201);
    assert.equal(r.body.user.username, 'bob');
    assert.equal(r.body.user.displayName, 'bob');
    assert.equal(r.body.user.passwordHash, undefined);
    assert.equal((await call('POST', '/api/auth/register', { username: 'BOB', password: 'password123' })).status, 409);
    assert.equal((await call('POST', '/api/auth/login', { username: 'bob', password: 'wrongpass' })).status, 401);
    const login = await call('POST', '/api/auth/login', { username: 'bob', password: 'password123' });
    assert.equal(login.status, 200);
    const me = await call('GET', '/api/auth/me', undefined, login.body.token);
    assert.equal(me.body.user.username, 'bob');
    assert.equal((await call('GET', '/api/boards')).status, 401);
    assert.equal((await call('GET', '/api/boards', undefined, 'nope')).status, 401);
    assert.equal((await call('POST', '/api/auth/logout', undefined, login.body.token)).status, 204);
    assert.equal((await call('GET', '/api/auth/me', undefined, login.body.token)).status, 401);
  } finally {
    await close();
  }
});

test('login is rate limited after 5 failures, even with the right password', async () => {
  const { call, close } = await start();
  try {
    await userWithToken(call, 'carol');
    for (let i = 0; i < 5; i++) {
      assert.equal((await call('POST', '/api/auth/login', { username: 'carol', password: 'nope-nope' })).status, 401);
    }
    assert.equal((await call('POST', '/api/auth/login', { username: 'carol', password: 'password123' })).status, 429);
  } finally {
    await close();
  }
});

test('boards, roles, members and board deletion', async () => {
  const { call, close } = await start();
  try {
    const owner = await userWithToken(call, 'owner1');
    const ed = await userWithToken(call, 'editor1');
    const vw = await userWithToken(call, 'viewer1');
    const outsider = await userWithToken(call, 'outsider1');

    const b = await call('POST', '/api/boards', { name: 'Proj' }, owner.token);
    assert.equal(b.status, 201);
    assert.deepEqual(b.body.columns.map((c) => c.name), ['To Do', 'In Progress', 'Done']);
    const boardId = b.body.id;

    assert.equal((await call('POST', '/api/boards', { name: '' }, owner.token)).status, 400);
    assert.equal((await call('GET', `/api/boards/${boardId}`, undefined, outsider.token)).status, 403);
    assert.equal((await call('GET', '/api/boards/nope', undefined, owner.token)).status, 404);

    assert.equal((await call('POST', `/api/boards/${boardId}/members`, { username: 'editor1', role: 'editor' }, owner.token)).status, 201);
    assert.equal((await call('POST', `/api/boards/${boardId}/members`, { username: 'viewer1', role: 'viewer' }, owner.token)).status, 201);
    assert.equal((await call('POST', `/api/boards/${boardId}/members`, { username: 'editor1', role: 'viewer' }, owner.token)).status, 409);
    assert.equal((await call('POST', `/api/boards/${boardId}/members`, { username: 'ghost', role: 'viewer' }, owner.token)).status, 404);
    assert.equal((await call('POST', `/api/boards/${boardId}/members`, { username: 'viewer1', role: 'viewer' }, ed.token)).status, 403);

    // viewer can read but not write
    assert.equal((await call('GET', `/api/boards/${boardId}`, undefined, vw.token)).status, 200);
    assert.equal((await call('POST', `/api/boards/${boardId}/columns`, { name: 'X' }, vw.token)).status, 403);
    // editor can write columns but not change board settings
    assert.equal((await call('POST', `/api/boards/${boardId}/columns`, { name: 'Review' }, ed.token)).status, 201);
    assert.equal((await call('PATCH', `/api/boards/${boardId}`, { name: 'Renamed' }, ed.token)).status, 403);
    assert.equal((await call('PATCH', `/api/boards/${boardId}`, { name: 'Renamed' }, owner.token)).status, 200);

    const list = await call('GET', '/api/boards', undefined, ed.token);
    assert.deepEqual(list.body.map((x) => x.role), ['editor']);

    // owner cannot be removed; members may remove themselves
    assert.equal((await call('DELETE', `/api/boards/${boardId}/members/${owner.id}`, undefined, owner.token)).status, 400);
    assert.equal((await call('DELETE', `/api/boards/${boardId}/members/${vw.id}`, undefined, ed.token)).status, 403);
    assert.equal((await call('DELETE', `/api/boards/${boardId}/members/${vw.id}`, undefined, vw.token)).status, 204);

    assert.equal((await call('DELETE', `/api/boards/${boardId}`, undefined, ed.token)).status, 403);
    assert.equal((await call('DELETE', `/api/boards/${boardId}`, undefined, owner.token)).status, 204);
    assert.equal((await call('GET', `/api/boards/${boardId}`, undefined, owner.token)).status, 404);
  } finally {
    await close();
  }
});

test('columns: reorder, delete with cards needs force, wip limits on cards', async () => {
  const { call, close } = await start();
  try {
    const owner = await userWithToken(call, 'owner2');
    const { body: board } = await call('POST', '/api/boards', { name: 'W' }, owner.token);
    const cols = board.columns;
    const moved = await call('PATCH', `/api/columns/${cols[0].id}`, { position: 2 }, owner.token);
    assert.equal(moved.status, 200);
    const after = (await call('GET', `/api/boards/${board.id}`, undefined, owner.token)).body.columns;
    assert.deepEqual(after.map((c) => c.name), ['In Progress', 'Done', 'To Do']);
    assert.deepEqual(after.map((c) => c.position), [0, 1, 2]);

    const limited = await call('POST', `/api/boards/${board.id}/columns`, { name: 'Limited', wipLimit: 1 }, owner.token);
    assert.equal(limited.status, 201);
    assert.equal((await call('POST', `/api/boards/${board.id}/columns`, { name: 'Bad', wipLimit: 0 }, owner.token)).status, 400);
    const c1 = await call('POST', `/api/columns/${limited.body.id}/cards`, { title: 'one' }, owner.token);
    assert.equal(c1.status, 201);
    const c2 = await call('POST', `/api/columns/${limited.body.id}/cards`, { title: 'two' }, owner.token);
    assert.equal(c2.status, 409);
    assert.equal(c2.body.error, 'wip_limit');

    assert.equal((await call('DELETE', `/api/columns/${limited.body.id}`, undefined, owner.token)).status, 409);
    assert.equal((await call('DELETE', `/api/columns/${limited.body.id}?force=true`, undefined, owner.token)).status, 204);
    assert.equal((await call('GET', `/api/cards/${c1.body.id}`, undefined, owner.token)).status, 404);
  } finally {
    await close();
  }
});

test('cards: validation, positions, move between columns, search, labels, comments, activity', async () => {
  const { call, close } = await start();
  try {
    const owner = await userWithToken(call, 'owner3');
    const ed = await userWithToken(call, 'editor3');
    const outsider = await userWithToken(call, 'outsider3');
    const { body: board } = await call('POST', '/api/boards', { name: 'Cards' }, owner.token);
    const [todo, doing, done] = board.columns;
    await call('POST', `/api/boards/${board.id}/members`, { username: 'editor3', role: 'editor' }, owner.token);

    const label = await call('POST', `/api/boards/${board.id}/labels`, { name: 'Bug', color: '#ff0000' }, owner.token);
    assert.equal(label.status, 201);
    assert.equal((await call('POST', `/api/boards/${board.id}/labels`, { name: 'bug', color: '#ff0000' }, owner.token)).status, 409);
    assert.equal((await call('POST', `/api/boards/${board.id}/labels`, { name: 'X', color: 'red' }, owner.token)).status, 400);

    const a = await call('POST', `/api/columns/${todo.id}/cards`, { title: 'Alpha', description: 'first', dueDate: '2030-01-05', labels: [label.body.id], assignees: [owner.id] }, owner.token);
    assert.equal(a.status, 201);
    assert.equal(a.body.position, 0);
    const b = await call('POST', `/api/columns/${todo.id}/cards`, { title: 'Beta' }, ed.token);
    assert.equal(b.status, 201);
    const c = await call('POST', `/api/columns/${todo.id}/cards`, { title: 'Gamma', position: 0 }, owner.token);
    assert.equal(c.body.position, 0);
    let col = (await call('GET', `/api/boards/${board.id}`, undefined, owner.token)).body.columns[0];
    assert.deepEqual(col.cards.map((x) => x.title), ['Gamma', 'Alpha', 'Beta']);
    assert.deepEqual(col.cards.map((x) => x.position), [0, 1, 2]);

    assert.equal((await call('POST', `/api/columns/${todo.id}/cards`, { title: 'X', assignees: [outsider.id] }, owner.token)).status, 400);
    assert.equal((await call('POST', `/api/columns/${todo.id}/cards`, { title: 'X', dueDate: '2030-02-30' }, owner.token)).status, 400);
    assert.equal((await call('POST', `/api/columns/${todo.id}/cards`, { title: 'X', labels: ['nope'] }, owner.token)).status, 400);
    assert.equal((await call('POST', `/api/columns/${todo.id}/cards`, { title: '' }, owner.token)).status, 400);
    assert.equal((await call('POST', `/api/columns/${todo.id}/cards`, { title: 'X' }, outsider.token)).status, 403);

    // move Gamma into Doing at position 0; source re-compacted
    const mv = await call('POST', `/api/cards/${c.body.id}/move`, { columnId: doing.id, position: 0 }, owner.token);
    assert.equal(mv.status, 200);
    assert.equal(mv.body.columnId, doing.id);
    assert.equal((await call('POST', `/api/cards/${c.body.id}/move`, { columnId: 'missing' }, owner.token)).status, 400);
    const board2 = (await call('GET', `/api/boards/${board.id}`, undefined, owner.token)).body;
    assert.deepEqual(board2.columns[0].cards.map((x) => x.position), [0, 1]);
    assert.deepEqual(board2.columns[1].cards.map((x) => x.title), ['Gamma']);

    // search
    const s1 = await call('GET', `/api/boards/${board.id}/cards?q=ALP`, undefined, owner.token);
    assert.deepEqual(s1.body.map((x) => x.title), ['Alpha']);
    const s2 = await call('GET', `/api/boards/${board.id}/cards?label=${label.body.id}`, undefined, owner.token);
    assert.equal(s2.body.length, 1);
    const s3 = await call('GET', `/api/boards/${board.id}/cards?due_before=2030-01-05`, undefined, owner.token);
    assert.equal(s3.body.length, 0);
    const s4 = await call('GET', `/api/boards/${board.id}/cards?due_before=2030-01-06`, undefined, owner.token);
    assert.equal(s4.body.length, 1);

    // comments
    const cm = await call('POST', `/api/cards/${a.body.id}/comments`, { body: 'hi' }, ed.token);
    assert.equal(cm.status, 201);
    assert.equal((await call('POST', `/api/cards/${a.body.id}/comments`, { body: '' }, ed.token)).status, 400);
    assert.equal((await call('DELETE', `/api/comments/${cm.body.id}`, undefined, owner.token)).status, 204);
    const cm2 = await call('POST', `/api/cards/${a.body.id}/comments`, { body: 'second' }, owner.token);
    assert.equal((await call('DELETE', `/api/comments/${cm2.body.id}`, undefined, ed.token)).status, 403);

    // activity newest first and recorded types
    const act = await call('GET', `/api/boards/${board.id}/activity?limit=3`, undefined, owner.token);
    assert.equal(act.body.length, 3);
    assert.equal(act.body[0].type, 'comment.added');
    const all = await call('GET', `/api/boards/${board.id}/activity`, undefined, owner.token);
    const types = new Set(all.body.map((x) => x.type));
    for (const t of ['board.created', 'card.created', 'card.moved', 'comment.added']) assert.ok(types.has(t), t);
    assert.equal((await call('GET', `/api/boards/${board.id}/activity?limit=0`, undefined, owner.token)).status, 400);

    // delete card
    assert.equal((await call('DELETE', `/api/cards/${a.body.id}`, undefined, owner.token)).status, 204);
    assert.equal((await call('GET', `/api/cards/${a.body.id}`, undefined, owner.token)).status, 404);
  } finally {
    await close();
  }
});

test('invalid JSON → 400, unknown route → 404, index html served', async () => {
  const { srv, call, close } = await start();
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const res = await fetch(base + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
    assert.equal(res.status, 400);
    assert.equal((await call('GET', '/api/nothing')).status, 404);
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
  } finally {
    await close();
  }
});

test('file persistence: data survives a new server; password not stored in plaintext', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-test-'));
  const file = path.join(dir, 'data.json');
  const first = await start({ dataFile: file });
  let boardId;
  try {
    await userWithToken(first.call, 'persist1');
    const login = await first.call('POST', '/api/auth/login', { username: 'persist1', password: 'password123' });
    const b = await first.call('POST', '/api/boards', { name: 'Saved' }, login.body.token);
    boardId = b.body.id;
  } finally {
    await first.close();
  }
  assert.equal(fs.readFileSync(file, 'utf8').includes('password123'), false);
  const second = await start({ dataFile: file });
  try {
    const login = await second.call('POST', '/api/auth/login', { username: 'persist1', password: 'password123' });
    assert.equal(login.status, 200);
    const got = await second.call('GET', `/api/boards/${boardId}`, undefined, login.body.token);
    assert.equal(got.status, 200);
    assert.equal(got.body.name, 'Saved');
  } finally {
    await second.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
