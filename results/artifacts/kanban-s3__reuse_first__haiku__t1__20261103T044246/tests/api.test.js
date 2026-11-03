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
  const call = async (method, p, body, token) => {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json };
  };
  return { srv, call, close: () => new Promise((r) => srv.close(r)) };
}

async function userWithToken(call, username, password = 'password123') {
  const reg = await call('POST', '/api/auth/register', { username, password });
  assert.equal(reg.status, 201);
  const login = await call('POST', '/api/auth/login', { username, password });
  assert.equal(login.status, 200);
  return { id: reg.body.user.id, token: login.body.token };
}

test('register validation, duplicates, hashed password, me, logout', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-'));
  const file = path.join(dir, 'data.json');
  const { call, close } = await start({ dataFile: file });
  try {
    assert.equal((await call('POST', '/api/auth/register', { username: 'ab', password: 'password123' })).status, 400);
    assert.equal((await call('POST', '/api/auth/register', { username: 'Bad-Name', password: 'password123' })).status, 400);
    assert.equal((await call('POST', '/api/auth/register', { username: 'bob', password: 'short' })).status, 400);
    const r = await call('POST', '/api/auth/register', { username: 'Bob_1', password: 'password123' });
    assert.equal(r.status, 201);
    assert.equal(r.body.user.username, 'bob_1');
    assert.equal(r.body.user.displayName, 'bob_1');
    assert.equal((await call('POST', '/api/auth/register', { username: 'BOB_1', password: 'password123' })).status, 409);
    assert.equal((await call('POST', '/api/auth/login', { username: 'bob_1', password: 'nope-nope' })).status, 401);
    const login = await call('POST', '/api/auth/login', { username: 'bob_1', password: 'password123' });
    assert.equal(login.status, 200);
    assert.equal((await call('GET', '/api/auth/me', undefined, login.body.token)).body.user.username, 'bob_1');
    assert.equal((await call('POST', '/api/auth/logout', undefined, login.body.token)).status, 204);
    assert.equal((await call('GET', '/api/auth/me', undefined, login.body.token)).status, 401);
    assert.equal((await call('GET', '/api/auth/me')).status, 401);
    assert.equal(fs.readFileSync(file, 'utf8').includes('password123'), false);
  } finally { await close(); }
});

test('login rate limiting after 5 failures', async () => {
  const { call, close } = await start();
  try {
    await call('POST', '/api/auth/register', { username: 'carol', password: 'password123' });
    for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/auth/login', { username: 'carol', password: 'wrongpass' })).status, 401);
    assert.equal((await call('POST', '/api/auth/login', { username: 'carol', password: 'password123' })).status, 429);
  } finally { await close(); }
});

test('invalid JSON → 400, unknown route → 404, unauthenticated → 401', async () => {
  const { call, close } = await start();
  try {
    assert.equal((await call('POST', '/api/auth/login', '{bad json')).status, 400);
    assert.equal((await call('GET', '/api/nope')).status, 404);
    assert.equal((await call('GET', '/api/boards')).status, 401);
  } finally { await close(); }
});

test('boards, roles, members', async () => {
  const { call, close } = await start();
  try {
    const owner = await userWithToken(call, 'owner1');
    const ed = await userWithToken(call, 'editor1');
    const vw = await userWithToken(call, 'viewer1');
    const outsider = await userWithToken(call, 'outsider1');

    const b = await call('POST', '/api/boards', { name: 'Proj' }, owner.token);
    assert.equal(b.status, 201);
    assert.deepEqual(b.body.columns.map((c) => c.name), ['To Do', 'In Progress', 'Done']);
    assert.deepEqual(b.body.columns.map((c) => c.position), [0, 1, 2]);
    const bid = b.body.id;
    assert.equal((await call('POST', '/api/boards', { name: '' }, owner.token)).status, 400);

    assert.equal((await call('GET', `/api/boards/${bid}`, undefined, outsider.token)).status, 403);
    assert.equal((await call('GET', '/api/boards/nope', undefined, owner.token)).status, 404);

    assert.equal((await call('POST', `/api/boards/${bid}/members`, { username: 'editor1', role: 'editor' }, owner.token)).status, 201);
    assert.equal((await call('POST', `/api/boards/${bid}/members`, { username: 'editor1', role: 'viewer' }, owner.token)).status, 409);
    assert.equal((await call('POST', `/api/boards/${bid}/members`, { username: 'ghost', role: 'viewer' }, owner.token)).status, 404);
    assert.equal((await call('POST', `/api/boards/${bid}/members`, { username: 'viewer1', role: 'viewer' }, ed.token)).status, 403);
    assert.equal((await call('POST', `/api/boards/${bid}/members`, { username: 'viewer1', role: 'owner' }, owner.token)).status, 400);
    assert.equal((await call('POST', `/api/boards/${bid}/members`, { username: 'viewer1', role: 'viewer' }, owner.token)).status, 201);

    const mine = await call('GET', '/api/boards', undefined, ed.token);
    assert.deepEqual(mine.body.map((x) => x.role), ['editor']);

    // viewer can read but not write
    assert.equal((await call('GET', `/api/boards/${bid}`, undefined, vw.token)).status, 200);
    assert.equal((await call('POST', `/api/boards/${bid}/columns`, { name: 'X' }, vw.token)).status, 403);
    // editor cannot edit board settings
    assert.equal((await call('PATCH', `/api/boards/${bid}`, { name: 'New' }, ed.token)).status, 403);
    assert.equal((await call('PATCH', `/api/boards/${bid}`, { name: 'New' }, owner.token)).body.name, 'New');

    // members: viewer removes self ok; editor cannot remove others
    assert.equal((await call('DELETE', `/api/boards/${bid}/members/${ed.id}`, undefined, vw.token)).status, 403);
    assert.equal((await call('PATCH', `/api/boards/${bid}/members/${vw.id}`, { role: 'editor' }, owner.token)).status, 200);
    assert.equal((await call('DELETE', `/api/boards/${bid}/members/${owner.id}`, undefined, owner.token)).status, 400);
    assert.equal((await call('DELETE', `/api/boards/${bid}/members/${vw.id}`, undefined, vw.token)).status, 204);
    assert.equal((await call('GET', `/api/boards/${bid}`, undefined, vw.token)).status, 403);

    assert.equal((await call('DELETE', `/api/boards/${bid}`, undefined, ed.token)).status, 403);
    assert.equal((await call('DELETE', `/api/boards/${bid}`, undefined, owner.token)).status, 204);
    assert.equal((await call('GET', `/api/boards/${bid}`, undefined, owner.token)).status, 404);
  } finally { await close(); }
});

test('columns: reorder, wip, delete with cards', async () => {
  const { call, close } = await start();
  try {
    const u = await userWithToken(call, 'colsuser');
    const bid = (await call('POST', '/api/boards', { name: 'C', columns: ['A', 'B', 'C'] }, u.token)).body.id;
    const board = (await call('GET', `/api/boards/${bid}`, undefined, u.token)).body;
    const [a, b, c] = board.columns;
    const moved = await call('PATCH', `/api/columns/${c.id}`, { position: 0 }, u.token);
    assert.equal(moved.status, 200);
    const after = (await call('GET', `/api/boards/${bid}`, undefined, u.token)).body.columns;
    assert.deepEqual(after.map((x) => x.name), ['C', 'A', 'B']);
    assert.deepEqual(after.map((x) => x.position), [0, 1, 2]);
    assert.equal((await call('PATCH', `/api/columns/${a.id}`, { position: 99 }, u.token)).status, 200);
    const again = (await call('GET', `/api/boards/${bid}`, undefined, u.token)).body.columns;
    assert.deepEqual(again.map((x) => x.name), ['C', 'B', 'A']);

    const bad = await call('POST', `/api/boards/${bid}/columns`, { name: 'W', wipLimit: 0 }, u.token);
    assert.equal(bad.status, 400);
    const wip = await call('POST', `/api/boards/${bid}/columns`, { name: 'W', wipLimit: 1 }, u.token);
    assert.equal(wip.status, 201);
    assert.equal((await call('POST', `/api/columns/${wip.body.id}/cards`, { title: 'one' }, u.token)).status, 201);
    const second = await call('POST', `/api/columns/${wip.body.id}/cards`, { title: 'two' }, u.token);
    assert.equal(second.status, 409);
    assert.equal(second.body.error, 'wip_limit');

    assert.equal((await call('DELETE', `/api/columns/${wip.body.id}`, undefined, u.token)).status, 409);
    assert.equal((await call('DELETE', `/api/columns/${wip.body.id}?force=true`, undefined, u.token)).status, 204);
    const final = (await call('GET', `/api/boards/${bid}`, undefined, u.token)).body;
    assert.deepEqual(final.columns.map((x) => x.position), [0, 1, 2]);
  } finally { await close(); }
});

test('cards: create, validation, positions, move, wip', async () => {
  const { call, close } = await start();
  try {
    const u = await userWithToken(call, 'cardsuser');
    const other = await userWithToken(call, 'cardsother');
    const bid = (await call('POST', '/api/boards', { name: 'Cards' }, u.token)).body.id;
    await call('POST', `/api/boards/${bid}/members`, { username: 'cardsother', role: 'editor' }, u.token);
    const [todo, doing] = (await call('GET', `/api/boards/${bid}`, undefined, u.token)).body.columns;
    const label = (await call('POST', `/api/boards/${bid}/labels`, { name: 'Bug', color: '#ff0000' }, u.token)).body;
    assert.equal((await call('POST', `/api/boards/${bid}/labels`, { name: 'bug', color: '#ff0000' }, u.token)).status, 409);
    assert.equal((await call('POST', `/api/boards/${bid}/labels`, { name: 'x', color: 'red' }, u.token)).status, 400);

    assert.equal((await call('POST', `/api/columns/${todo.id}/cards`, { title: '' }, u.token)).status, 400);
    assert.equal((await call('POST', `/api/columns/${todo.id}/cards`, { title: 'x', dueDate: '2026-02-30' }, u.token)).status, 400);
    assert.equal((await call('POST', `/api/columns/${todo.id}/cards`, { title: 'x', assignees: ['nobody'] }, u.token)).status, 400);
    assert.equal((await call('POST', `/api/columns/${todo.id}/cards`, { title: 'x', labels: ['nolabel'] }, u.token)).status, 400);

    const c1 = await call('POST', `/api/columns/${todo.id}/cards`, { title: 'first', dueDate: '2026-05-01', assignees: [other.id], labels: [label.id] }, u.token);
    assert.equal(c1.status, 201);
    const c2 = await call('POST', `/api/columns/${todo.id}/cards`, { title: 'second', description: 'Hello World' }, u.token);
    const c3 = await call('POST', `/api/columns/${todo.id}/cards`, { title: 'third', position: 0 }, u.token);
    const cards = (await call('GET', `/api/boards/${bid}`, undefined, u.token)).body.columns[0].cards;
    assert.deepEqual(cards.map((c) => c.title), ['third', 'first', 'second']);
    assert.deepEqual(cards.map((c) => c.position), [0, 1, 2]);

    // move c2 to doing at position 0
    const mv = await call('POST', `/api/cards/${c2.body.id}/move`, { columnId: doing.id, position: 0 }, u.token);
    assert.equal(mv.status, 200);
    const board = (await call('GET', `/api/boards/${bid}`, undefined, u.token)).body;
    assert.deepEqual(board.columns[0].cards.map((c) => c.position), [0, 1]);
    assert.deepEqual(board.columns[1].cards.map((c) => c.title), ['second']);
    assert.equal(board.columns[1].cards[0].position, 0);

    // move to other board's column → 400
    const otherBoard = (await call('POST', '/api/boards', { name: 'O' }, other.token)).body;
    assert.equal((await call('POST', `/api/cards/${c1.body.id}/move`, { columnId: otherBoard.columns[0].id }, u.token)).status, 400);

    // search
    const q = await call('GET', `/api/boards/${bid}/cards?q=WORLD`, undefined, u.token);
    assert.deepEqual(q.body.map((c) => c.title), ['second']);
    const ass = await call('GET', `/api/boards/${bid}/cards?assignee=${other.id}`, undefined, u.token);
    assert.deepEqual(ass.body.map((c) => c.title), ['first']);
    const lab = await call('GET', `/api/boards/${bid}/cards?label=${label.id}`, undefined, u.token);
    assert.equal(lab.body.length, 1);
    const due = await call('GET', `/api/boards/${bid}/cards?due_before=2026-05-01`, undefined, u.token);
    assert.equal(due.body.length, 0);
    const due2 = await call('GET', `/api/boards/${bid}/cards?due_before=2026-05-02`, undefined, u.token);
    assert.equal(due2.body.length, 1);

    // patch + updatedAt
    const patched = await call('PATCH', `/api/cards/${c1.body.id}`, { title: 'renamed', dueDate: null }, u.token);
    assert.equal(patched.body.title, 'renamed');
    assert.equal(patched.body.dueDate, null);
    assert.ok(patched.body.updatedAt >= c1.body.updatedAt);

    // deleting label strips it from cards
    assert.equal((await call('DELETE', `/api/labels/${label.id}`, undefined, u.token)).status, 204);
    assert.deepEqual((await call('GET', `/api/cards/${c1.body.id}`, undefined, u.token)).body.labels, []);

    // comments
    const cm = await call('POST', `/api/cards/${c1.body.id}/comments`, { body: 'hi' }, other.token);
    assert.equal(cm.status, 201);
    assert.equal((await call('POST', `/api/cards/${c1.body.id}/comments`, { body: '' }, other.token)).status, 400);
    assert.equal((await call('GET', `/api/cards/${c1.body.id}/comments`, undefined, u.token)).body.length, 1);
    assert.equal((await call('DELETE', `/api/comments/${cm.body.id}`, undefined, other.token)).status, 204);

    // activity newest-first
    const act = (await call('GET', `/api/boards/${bid}/activity?limit=3`, undefined, u.token)).body;
    assert.equal(act.length, 3);
    assert.ok(act[0].at >= act[1].at);
    assert.equal((await call('GET', `/api/boards/${bid}/activity`, undefined, u.token)).status, 200);
    const types = new Set((await call('GET', `/api/boards/${bid}/activity`, undefined, u.token)).body.map((a) => a.type));
    for (const t of ['board.created', 'card.created', 'card.moved', 'comment.added', 'member.added']) assert.ok(types.has(t), t);

    // delete card
    assert.equal((await call('DELETE', `/api/cards/${c3.body.id}`, undefined, u.token)).status, 204);
    assert.equal((await call('GET', `/api/cards/${c3.body.id}`, undefined, u.token)).status, 404);
  } finally { await close(); }
});

test('data persists across server instances', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-'));
  const file = path.join(dir, 'data.json');
  let s = await start({ dataFile: file });
  const u = await userWithToken(s.call, 'persist1');
  const bid = (await s.call('POST', '/api/boards', { name: 'Keep' }, u.token)).body.id;
  await s.close();
  s = await start({ dataFile: file });
  try {
    const login = await s.call('POST', '/api/auth/login', { username: 'persist1', password: 'password123' });
    assert.equal(login.status, 200);
    const boards = await s.call('GET', '/api/boards', undefined, login.body.token);
    assert.equal(boards.body[0].id, bid);
  } finally { await s.close(); }
});

test('web UI served at / and under /static', async () => {
  const srv = createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  try {
    const home = await fetch(base + '/');
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /text\/html/);
    assert.match(await home.text(), /<script src="\/static\/app.js"/);
    const js = await fetch(base + '/static/app.js');
    assert.equal(js.status, 200);
    assert.equal((await fetch(base + '/static/missing.js')).status, 404);
    assert.equal((await fetch(base + '/static/..%2Fserver.js')).status, 404);
  } finally { srv.close(); }
});
