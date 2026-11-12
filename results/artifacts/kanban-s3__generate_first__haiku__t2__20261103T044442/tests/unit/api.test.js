import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../../src/server.js';

async function start(opts) {
  const srv = createServer(opts);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (method, p, body, token) => {
    const res = await fetch(base + p, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { srv, base, call };
}

async function userWithToken(call, username) {
  await call('POST', '/api/auth/register', { username, password: 'password123' });
  const { body } = await call('POST', '/api/auth/login', { username, password: 'password123' });
  return { token: body.token, user: body.user };
}

test('auth: register validation, duplicate, login, me, logout', async (t) => {
  const { srv, call } = await start();
  t.after(() => srv.close());
  assert.equal((await call('POST', '/api/auth/register', { username: 'ab', password: 'password123' })).status, 400);
  assert.equal((await call('POST', '/api/auth/register', { username: 'bob', password: 'short' })).status, 400);
  const r = await call('POST', '/api/auth/register', { username: 'Bob_1', password: 'password123' });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.username, 'bob_1');
  assert.equal(r.body.user.displayName, 'bob_1');
  assert.equal(r.body.user.passwordHash, undefined);
  assert.equal((await call('POST', '/api/auth/register', { username: 'BOB_1', password: 'password123' })).status, 409);
  const l = await call('POST', '/api/auth/login', { username: 'bob_1', password: 'password123' });
  assert.equal(l.status, 200);
  assert.equal((await call('GET', '/api/auth/me', undefined, l.body.token)).body.user.username, 'bob_1');
  assert.equal((await call('POST', '/api/auth/logout', undefined, l.body.token)).status, 204);
  assert.equal((await call('GET', '/api/auth/me', undefined, l.body.token)).status, 401);
  assert.equal((await call('GET', '/api/boards')).status, 401);
});

test('invalid JSON → 400; unknown route → 404 JSON error', async (t) => {
  const { srv, call } = await start();
  t.after(() => srv.close());
  const r = await call('POST', '/api/auth/login', '{bad json');
  assert.equal(r.status, 400);
  assert.equal(typeof r.body.error, 'string');
  const n = await call('GET', '/api/nope');
  assert.equal(n.status, 404);
  assert.equal(n.body.error, 'not_found');
});

test('login rate limit after 5 failures', async (t) => {
  const { srv, call } = await start();
  t.after(() => srv.close());
  await call('POST', '/api/auth/register', { username: 'carol', password: 'password123' });
  for (let i = 0; i < 5; i++) {
    assert.equal((await call('POST', '/api/auth/login', { username: 'carol', password: 'wrongpass' })).status, 401);
  }
  assert.equal((await call('POST', '/api/auth/login', { username: 'carol', password: 'password123' })).status, 429);
});

test('boards, roles, members, columns', async (t) => {
  const { srv, call } = await start();
  t.after(() => srv.close());
  const owner = await userWithToken(call, 'owner1');
  const ed = await userWithToken(call, 'editor1');
  const vw = await userWithToken(call, 'viewer1');
  const outsider = await userWithToken(call, 'outsider1');

  const b = await call('POST', '/api/boards', { name: 'Proj' }, owner.token);
  assert.equal(b.status, 201);
  const boardId = b.body.id;
  assert.deepEqual(b.body.columns.map((c) => c.name), ['To Do', 'In Progress', 'Done']);
  assert.deepEqual(b.body.columns.map((c) => c.position), [0, 1, 2]);
  assert.equal((await call('POST', '/api/boards', { name: '' }, owner.token)).status, 400);

  assert.equal((await call('GET', `/api/boards/${boardId}`, undefined, outsider.token)).status, 403);
  assert.equal((await call('GET', '/api/boards/nope', undefined, owner.token)).status, 404);

  assert.equal((await call('POST', `/api/boards/${boardId}/members`, { username: 'editor1', role: 'editor' }, owner.token)).status, 201);
  assert.equal((await call('POST', `/api/boards/${boardId}/members`, { username: 'viewer1', role: 'viewer' }, owner.token)).status, 201);
  assert.equal((await call('POST', `/api/boards/${boardId}/members`, { username: 'editor1', role: 'editor' }, owner.token)).status, 409);
  assert.equal((await call('POST', `/api/boards/${boardId}/members`, { username: 'ghost', role: 'editor' }, owner.token)).status, 404);
  assert.equal((await call('POST', `/api/boards/${boardId}/members`, { username: 'outsider1', role: 'owner' }, owner.token)).status, 400);

  // viewer cannot create columns; editor can
  assert.equal((await call('POST', `/api/boards/${boardId}/columns`, { name: 'X' }, vw.token)).status, 403);
  const c = await call('POST', `/api/boards/${boardId}/columns`, { name: 'Review' }, ed.token);
  assert.equal(c.status, 201);
  assert.equal(c.body.position, 3);

  // editor cannot patch the board; owner can
  assert.equal((await call('PATCH', `/api/boards/${boardId}`, { name: 'New' }, ed.token)).status, 403);
  assert.equal((await call('PATCH', `/api/boards/${boardId}`, { name: 'New' }, owner.token)).body.name, 'New');

  // list boards
  const list = await call('GET', '/api/boards', undefined, vw.token);
  assert.deepEqual(list.body.map((x) => [x.name, x.role]), [['New', 'viewer']]);

  // member changes
  const vUser = vw.user.id;
  assert.equal((await call('PATCH', `/api/boards/${boardId}/members/${vUser}`, { role: 'editor' }, owner.token)).status, 200);
  assert.equal((await call('PATCH', `/api/boards/${boardId}/members/${owner.user.id}`, { role: 'viewer' }, owner.token)).status, 400);
  assert.equal((await call('DELETE', `/api/boards/${boardId}/members/${owner.user.id}`, undefined, owner.token)).status, 400);
  assert.equal((await call('DELETE', `/api/boards/${boardId}/members/${vUser}`, undefined, outsider.token)).status, 403);
  assert.equal((await call('DELETE', `/api/boards/${boardId}/members/${vUser}`, undefined, vw.token)).status, 204);
  assert.equal((await call('GET', `/api/boards/${boardId}`, undefined, vw.token)).status, 403);

  assert.equal((await call('DELETE', `/api/boards/${boardId}`, undefined, ed.token)).status, 403);
  assert.equal((await call('DELETE', `/api/boards/${boardId}`, undefined, owner.token)).status, 204);
  assert.equal((await call('GET', `/api/boards/${boardId}`, undefined, owner.token)).status, 404);
});

test('cards: wip limits, moves, positions, validation, labels, search', async (t) => {
  const { srv, call } = await start();
  t.after(() => srv.close());
  const owner = await userWithToken(call, 'owner2');
  const mem = await userWithToken(call, 'member2');
  const board = (await call('POST', '/api/boards', { name: 'Work', columns: ['A', 'B'] }, owner.token)).body;
  await call('POST', `/api/boards/${board.id}/members`, { username: 'member2', role: 'editor' }, owner.token);
  const [colA, colB] = board.columns;

  const wip = await call('POST', `/api/boards/${board.id}/columns`, { name: 'Limited', wipLimit: 1 }, owner.token);
  const limited = wip.body;
  assert.equal((await call('POST', `/api/boards/${board.id}/columns`, { name: 'Bad', wipLimit: 0 }, owner.token)).status, 400);

  const c1 = await call('POST', `/api/columns/${colA.id}/cards`, { title: 'one', description: 'Alpha text' }, owner.token);
  const c2 = await call('POST', `/api/columns/${colA.id}/cards`, { title: 'two', dueDate: '2030-01-05' }, mem.token);
  const c3 = await call('POST', `/api/columns/${colA.id}/cards`, { title: 'three', position: 0 }, owner.token);
  assert.equal(c3.status, 201);
  const got = await call('GET', `/api/boards/${board.id}`, undefined, owner.token);
  const aCards = got.body.columns[0].cards.map((c) => [c.title, c.position]);
  assert.deepEqual(aCards, [['three', 0], ['one', 1], ['two', 2]]);

  // WIP
  assert.equal((await call('POST', `/api/columns/${limited.id}/cards`, { title: 'x' }, owner.token)).status, 201);
  const over = await call('POST', `/api/columns/${limited.id}/cards`, { title: 'y' }, owner.token);
  assert.equal(over.status, 409);
  assert.equal(over.body.error, 'wip_limit');

  // validation
  assert.equal((await call('POST', `/api/columns/${colA.id}/cards`, { title: '' }, owner.token)).status, 400);
  assert.equal((await call('POST', `/api/columns/${colA.id}/cards`, { title: 'z', dueDate: '2030-02-30' }, owner.token)).status, 400);
  assert.equal((await call('POST', `/api/columns/${colA.id}/cards`, { title: 'z', assignees: ['nobody'] }, owner.token)).status, 400);
  assert.equal((await call('POST', `/api/columns/${colA.id}/cards`, { title: 'z', labels: ['nope'] }, owner.token)).status, 400);

  // labels
  const lab = await call('POST', `/api/boards/${board.id}/labels`, { name: 'Bug', color: '#ff0000' }, owner.token);
  assert.equal(lab.status, 201);
  assert.equal((await call('POST', `/api/boards/${board.id}/labels`, { name: 'bug', color: '#ff0000' }, owner.token)).status, 409);
  assert.equal((await call('POST', `/api/boards/${board.id}/labels`, { name: 'Other', color: 'red' }, owner.token)).status, 400);
  const pat = await call('PATCH', `/api/cards/${c1.body.id}`, { labels: [lab.body.id], assignees: [owner.user.id] }, owner.token);
  assert.equal(pat.status, 200);
  assert.deepEqual(pat.body.labels, [lab.body.id]);

  // move c1 to column B at position 0
  const mv = await call('POST', `/api/cards/${c1.body.id}/move`, { columnId: colB.id, position: 0 }, owner.token);
  assert.equal(mv.status, 200);
  assert.equal(mv.body.columnId, colB.id);
  assert.equal(mv.body.position, 0);
  const afterMove = (await call('GET', `/api/boards/${board.id}`, undefined, owner.token)).body;
  assert.deepEqual(afterMove.columns[0].cards.map((c) => c.position), [0, 1]);
  assert.deepEqual(afterMove.columns[1].cards.map((c) => [c.title, c.position]), [['one', 0]]);
  assert.equal((await call('POST', `/api/cards/${c1.body.id}/move`, { columnId: 'nope' }, owner.token)).status, 400);

  // search
  const s = await call('GET', `/api/boards/${board.id}/cards?q=ALPHA`, undefined, owner.token);
  assert.deepEqual(s.body.map((c) => c.title), ['one']);
  const d = await call('GET', `/api/boards/${board.id}/cards?due_before=2031-01-01`, undefined, owner.token);
  assert.deepEqual(d.body.map((c) => c.title), ['two']);
  const d2 = await call('GET', `/api/boards/${board.id}/cards?due_before=2030-01-05`, undefined, owner.token);
  assert.deepEqual(d2.body, []);
  const byLabel = await call('GET', `/api/boards/${board.id}/cards?label=${lab.body.id}`, undefined, owner.token);
  assert.equal(byLabel.body.length, 1);

  // comments
  const cm = await call('POST', `/api/cards/${c2.body.id}/comments`, { body: 'hello' }, mem.token);
  assert.equal(cm.status, 201);
  assert.equal((await call('DELETE', `/api/comments/${cm.body.id}`, undefined, owner.token)).status, 204);

  // activity
  const act = await call('GET', `/api/boards/${board.id}/activity?limit=5`, undefined, owner.token);
  assert.equal(act.body.length, 5);
  assert.equal(act.body[0].type, 'comment.added');
  assert.equal(act.body[1].type, 'card.moved');
  assert.equal(act.body[1].details.toColumnId, colB.id);
  assert.equal((await call('GET', `/api/boards/${board.id}/activity`, undefined, owner.token)).body.some((a) => a.type === 'board.created'), true);

  // card deletion & column force delete
  assert.equal((await call('DELETE', `/api/columns/${colA.id}`, undefined, owner.token)).status, 409);
  assert.equal((await call('DELETE', `/api/columns/${colA.id}?force=true`, undefined, owner.token)).status, 204);
  const fin = (await call('GET', `/api/boards/${board.id}`, undefined, owner.token)).body;
  assert.deepEqual(fin.columns.map((c) => c.position), fin.columns.map((_, i) => i));
  assert.deepEqual(fin.columns.map((c) => c.name), ['B', 'Limited']);
});

test('persistence: data survives a new server and password is hashed', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-'));
  const dataFile = path.join(dir, 'data.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const first = await start({ dataFile });
  const u = await userWithToken(first.call, 'persist1');
  await first.call('POST', '/api/boards', { name: 'Saved' }, u.token);
  first.srv.close();
  assert.equal(fs.readFileSync(dataFile, 'utf8').includes('password123'), false);

  const second = await start({ dataFile });
  t.after(() => second.srv.close());
  const login = await second.call('POST', '/api/auth/login', { username: 'persist1', password: 'password123' });
  assert.equal(login.status, 200);
  const list = await second.call('GET', '/api/boards', undefined, login.body.token);
  assert.deepEqual(list.body.map((b) => b.name), ['Saved']);
});

test('UI is served at / and static assets under /static/', async (t) => {
  const { srv, base } = await start();
  t.after(() => srv.close());
  const html = await fetch(base + '/');
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-type'), /text\/html/);
  const js = await fetch(base + '/static/app.js');
  assert.equal(js.status, 200);
  assert.equal((await fetch(base + '/static/../server.js')).status, 404);
});
