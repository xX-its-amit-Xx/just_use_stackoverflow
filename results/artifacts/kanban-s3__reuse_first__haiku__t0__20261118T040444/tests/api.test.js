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
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  const users = {};
  const user = async (name) => {
    await call('POST', '/api/auth/register', { username: name, password: 'password123' });
    const r = await call('POST', '/api/auth/login', { username: name, password: 'password123' });
    users[name] = { token: r.body.token, id: r.body.user.id };
    return users[name];
  };
  return { srv, call, user, users, close: () => new Promise((r) => srv.close(r)) };
}

test('register, login, me, logout', async () => {
  const t = await start();
  try {
    const r = await t.call('POST', '/api/auth/register', { username: 'Alice', password: 'password123' });
    assert.equal(r.status, 201);
    assert.equal(r.body.user.username, 'alice');
    assert.equal(r.body.user.displayName, 'alice');
    assert.equal(r.body.user.passwordHash, undefined);
    assert.equal((await t.call('POST', '/api/auth/register', { username: 'alice', password: 'password123' })).status, 409);
    assert.equal((await t.call('POST', '/api/auth/register', { username: 'bo', password: 'password123' })).status, 400);
    assert.equal((await t.call('POST', '/api/auth/register', { username: 'bobby', password: 'short' })).status, 400);
    const login = await t.call('POST', '/api/auth/login', { username: 'alice', password: 'password123' });
    assert.equal(login.status, 200);
    assert.equal((await t.call('GET', '/api/auth/me', undefined, login.body.token)).body.user.username, 'alice');
    assert.equal((await t.call('POST', '/api/auth/logout', undefined, login.body.token)).status, 204);
    assert.equal((await t.call('GET', '/api/auth/me', undefined, login.body.token)).status, 401);
    assert.equal((await t.call('GET', '/api/boards')).status, 401);
  } finally { await t.close(); }
});

test('login rate limit after 5 failures', async () => {
  const t = await start();
  try {
    await t.user('carol');
    for (let i = 0; i < 5; i++) {
      assert.equal((await t.call('POST', '/api/auth/login', { username: 'carol', password: 'wrongpass' })).status, 401);
    }
    assert.equal((await t.call('POST', '/api/auth/login', { username: 'carol', password: 'password123' })).status, 429);
  } finally { await t.close(); }
});

test('boards, roles, members', async () => {
  const t = await start();
  try {
    const owner = await t.user('owner1');
    const ed = await t.user('editor1');
    const vw = await t.user('viewer1');
    const other = await t.user('outsider');
    const b = await t.call('POST', '/api/boards', { name: 'Proj' }, owner.token);
    assert.equal(b.status, 201);
    assert.deepEqual(b.body.columns.map((c) => c.name), ['To Do', 'In Progress', 'Done']);
    const id = b.body.id;
    assert.equal((await t.call('GET', `/api/boards/${id}`, undefined, other.token)).status, 403);
    assert.equal((await t.call('GET', '/api/boards/nope', undefined, owner.token)).status, 404);
    assert.equal((await t.call('POST', `/api/boards/${id}/members`, { username: 'editor1', role: 'editor' }, owner.token)).status, 201);
    assert.equal((await t.call('POST', `/api/boards/${id}/members`, { username: 'editor1', role: 'editor' }, owner.token)).status, 409);
    assert.equal((await t.call('POST', `/api/boards/${id}/members`, { username: 'ghost', role: 'editor' }, owner.token)).status, 404);
    await t.call('POST', `/api/boards/${id}/members`, { username: 'viewer1', role: 'viewer' }, owner.token);
    assert.equal((await t.call('POST', `/api/boards/${id}/columns`, { name: 'X' }, vw.token)).status, 403);
    assert.equal((await t.call('POST', `/api/boards/${id}/columns`, { name: 'X' }, ed.token)).status, 201);
    assert.equal((await t.call('PATCH', `/api/boards/${id}`, { name: 'New' }, ed.token)).status, 403);
    assert.equal((await t.call('PATCH', `/api/boards/${id}`, { name: 'New' }, owner.token)).body.name, 'New');
    assert.equal((await t.call('GET', '/api/boards', undefined, vw.token)).body[0].role, 'viewer');
    assert.equal((await t.call('PATCH', `/api/boards/${id}/members/${ed.id}`, { role: 'viewer' }, owner.token)).body.role, 'viewer');
    assert.equal((await t.call('DELETE', `/api/boards/${id}/members/${owner.id}`, undefined, owner.token)).status, 400);
    assert.equal((await t.call('DELETE', `/api/boards/${id}/members/${vw.id}`, undefined, ed.token)).status, 403);
    assert.equal((await t.call('DELETE', `/api/boards/${id}/members/${vw.id}`, undefined, vw.token)).status, 204);
    assert.equal((await t.call('DELETE', `/api/boards/${id}`, undefined, ed.token)).status, 403);
    assert.equal((await t.call('DELETE', `/api/boards/${id}`, undefined, owner.token)).status, 204);
    assert.equal((await t.call('GET', `/api/boards/${id}`, undefined, owner.token)).status, 404);
  } finally { await t.close(); }
});

test('cards, positions, wip limits, move, search, activity, comments', async () => {
  const t = await start();
  try {
    const owner = await t.user('owner2');
    const b = (await t.call('POST', '/api/boards', { name: 'Work', columns: ['A', 'B'] }, owner.token)).body;
    const [colA, colB] = b.columns;
    const lab = await t.call('POST', `/api/boards/${b.id}/labels`, { name: 'Bug', color: '#ff0000' }, owner.token);
    assert.equal(lab.status, 201);
    assert.equal((await t.call('POST', `/api/boards/${b.id}/labels`, { name: 'bug', color: '#ff0000' }, owner.token)).status, 409);
    assert.equal((await t.call('POST', `/api/boards/${b.id}/labels`, { name: 'x', color: 'red' }, owner.token)).status, 400);

    const c1 = await t.call('POST', `/api/columns/${colA.id}/cards`, { title: 'first', dueDate: '2030-01-05', labels: [lab.body.id] }, owner.token);
    const c2 = await t.call('POST', `/api/columns/${colA.id}/cards`, { title: 'second', description: 'Hello World' }, owner.token);
    const c3 = await t.call('POST', `/api/columns/${colA.id}/cards`, { title: 'top', position: 0 }, owner.token);
    assert.equal(c1.status, 201);
    assert.equal(c1.body.position, 0);
    assert.equal(c2.body.position, 1);
    assert.equal(c3.body.position, 0);
    const pre = (await t.call('GET', `/api/boards/${b.id}`, undefined, owner.token)).body.columns[0].cards;
    assert.deepEqual(pre.map((c) => c.title), ['top', 'first', 'second']);
    assert.deepEqual(pre.map((c) => c.position), [0, 1, 2]);
    assert.equal((await t.call('POST', `/api/columns/${colA.id}/cards`, { title: 'x', dueDate: '2030-02-30' }, owner.token)).status, 400);
    assert.equal((await t.call('POST', `/api/columns/${colA.id}/cards`, { title: 'x', assignees: ['nobody'] }, owner.token)).status, 400);

    // WIP limit on column B
    assert.equal((await t.call('PATCH', `/api/columns/${colB.id}`, { wipLimit: 1 }, owner.token)).status, 200);
    assert.equal((await t.call('POST', `/api/cards/${c1.body.id}/move`, { columnId: colB.id }, owner.token)).status, 200);
    const blocked = await t.call('POST', `/api/cards/${c2.body.id}/move`, { columnId: colB.id }, owner.token);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, 'wip_limit');

    // Move back, positions contiguous
    const mv = await t.call('POST', `/api/cards/${c1.body.id}/move`, { columnId: colA.id, position: 0 }, owner.token);
    assert.equal(mv.body.position, 0);
    const board = (await t.call('GET', `/api/boards/${b.id}`, undefined, owner.token)).body;
    assert.deepEqual(board.columns[0].cards.map((c) => c.position), [0, 1, 2]);
    assert.equal(board.columns[0].cards[0].title, 'first');
    assert.equal(board.columns[1].cards.length, 0);

    const s1 = await t.call('GET', `/api/boards/${b.id}/cards?q=hello`, undefined, owner.token);
    assert.equal(s1.body.length, 1);
    const s2 = await t.call('GET', `/api/boards/${b.id}/cards?label=${lab.body.id}`, undefined, owner.token);
    assert.equal(s2.body.length, 1);
    const s3 = await t.call('GET', `/api/boards/${b.id}/cards?due_before=2030-01-05`, undefined, owner.token);
    assert.equal(s3.body.length, 0);
    const s4 = await t.call('GET', `/api/boards/${b.id}/cards?due_before=2030-01-06`, undefined, owner.token);
    assert.equal(s4.body.length, 1);

    const cm = await t.call('POST', `/api/cards/${c1.body.id}/comments`, { body: 'nice' }, owner.token);
    assert.equal(cm.status, 201);
    assert.equal((await t.call('GET', `/api/cards/${c1.body.id}/comments`, undefined, owner.token)).body.length, 1);
    assert.equal((await t.call('DELETE', `/api/comments/${cm.body.id}`, undefined, owner.token)).status, 204);

    const act = (await t.call('GET', `/api/boards/${b.id}/activity?limit=3`, undefined, owner.token)).body;
    assert.equal(act.length, 3);
    assert.deepEqual(act.map((a) => a.type), ['comment.added', 'card.moved', 'card.moved']);

    // Column delete rules
    assert.equal((await t.call('DELETE', `/api/columns/${colA.id}`, undefined, owner.token)).status, 409);
    assert.equal((await t.call('DELETE', `/api/columns/${colA.id}?force=true`, undefined, owner.token)).status, 204);
    const after = (await t.call('GET', `/api/boards/${b.id}`, undefined, owner.token)).body;
    assert.deepEqual(after.columns.map((c) => c.position), [0]);
  } finally { await t.close(); }
});

test('persistence across server instances and password not stored in plain', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-test-'));
  const file = path.join(dir, 'data.json');
  let t = await start({ dataFile: file });
  const u = await t.user('persist1');
  const b = await t.call('POST', '/api/boards', { name: 'Keep' }, u.token);
  await t.close();
  assert.equal(fs.readFileSync(file, 'utf8').includes('password123'), false);
  t = await start({ dataFile: file });
  try {
    const login = await t.call('POST', '/api/auth/login', { username: 'persist1', password: 'password123' });
    assert.equal(login.status, 200);
    const got = await t.call('GET', `/api/boards/${b.body.id}`, undefined, login.body.token);
    assert.equal(got.body.name, 'Keep');
  } finally { await t.close(); }
});

test('invalid JSON → 400, unknown route → 404, static UI served', async () => {
  const t = await start();
  try {
    const res = await fetch(`http://127.0.0.1:${t.srv.address().port}/api/auth/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad',
    });
    assert.equal(res.status, 400);
    assert.equal((await t.call('GET', '/api/nothing')).status, 404);
    const home = await fetch(`http://127.0.0.1:${t.srv.address().port}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /text\/html/);
    const js = await fetch(`http://127.0.0.1:${t.srv.address().port}/static/app.js`);
    assert.equal(js.status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${t.srv.address().port}/static/..%2Fserver.js`)).status, 404);
  } finally { await t.close(); }
});
