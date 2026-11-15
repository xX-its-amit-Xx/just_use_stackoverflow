import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../../src/server.js';

async function start(opts) {
  const srv = createServer(opts);
  await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const req = async (method, p, body, token) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  };
  const user = async (username) => {
    await req('POST', '/api/auth/register', { username, password: 'password123' });
    const r = await req('POST', '/api/auth/login', { username, password: 'password123' });
    return { token: r.body.token, id: r.body.user.id };
  };
  return { srv, base, req, user, close: () => new Promise((r) => srv.close(r)) };
}

test('auth flow', async () => {
  const t = await start();
  const { req } = t;
  let r = await req('POST', '/api/auth/register', { username: 'Bob_1', password: 'password123' });
  assert.equal(r.status, 201);
  assert.deepEqual(Object.keys(r.body.user).sort(), ['displayName', 'id', 'username']);
  assert.equal(r.body.user.username, 'bob_1');
  assert.equal(r.body.user.displayName, 'bob_1');
  assert.equal((await req('POST', '/api/auth/register', { username: 'BOB_1', password: 'password123' })).status, 409);
  assert.equal((await req('POST', '/api/auth/register', { username: 'ab', password: 'password123' })).status, 400);
  assert.equal((await req('POST', '/api/auth/register', { username: 'abc', password: 'short' })).status, 400);
  assert.equal((await req('POST', '/api/auth/register', '{bad')).status, 400);
  r = await req('POST', '/api/auth/login', { username: 'bob_1', password: 'password123' });
  assert.equal(r.status, 200);
  const tok = r.body.token;
  assert.equal((await req('GET', '/api/auth/me', undefined, tok)).status, 200);
  assert.equal((await req('GET', '/api/auth/me')).status, 401);
  assert.equal((await req('POST', '/api/auth/logout', undefined, tok)).status, 204);
  assert.equal((await req('GET', '/api/auth/me', undefined, tok)).status, 401);
  for (let i = 0; i < 5; i++) assert.equal((await req('POST', '/api/auth/login', { username: 'bob_1', password: 'wrongwrong' })).status, 401);
  assert.equal((await req('POST', '/api/auth/login', { username: 'bob_1', password: 'password123' })).status, 429);
  r = await req('GET', '/nope');
  assert.equal(r.status, 404);
  assert.equal(r.body.error, 'not_found');
  await t.close();
});

test('boards, roles, columns, cards, moves, wip, labels, comments, search, activity', async () => {
  const t = await start();
  const { req } = t;
  const alice = await t.user('alice');
  const bob = await t.user('bob');
  const carol = await t.user('carol');
  let r = await req('POST', '/api/boards', { name: 'Proj' }, alice.token);
  assert.equal(r.status, 201);
  const board = r.body;
  assert.deepEqual(board.columns.map((c) => c.name), ['To Do', 'In Progress', 'Done']);
  const [todo, doing, done] = board.columns;
  assert.equal((await req('GET', `/api/boards/${board.id}`, undefined, bob.token)).status, 403);
  assert.equal((await req('GET', `/api/boards/xyz`, undefined, bob.token)).status, 404);
  assert.equal((await req('POST', `/api/boards/${board.id}/members`, { username: 'bob', role: 'editor' }, alice.token)).status, 201);
  assert.equal((await req('POST', `/api/boards/${board.id}/members`, { username: 'bob', role: 'editor' }, alice.token)).status, 409);
  assert.equal((await req('POST', `/api/boards/${board.id}/members`, { username: 'zzz', role: 'editor' }, alice.token)).status, 404);
  assert.equal((await req('POST', `/api/boards/${board.id}/members`, { username: 'carol', role: 'viewer' }, alice.token)).status, 201);
  assert.equal((await req('PATCH', `/api/boards/${board.id}`, { name: 'X' }, bob.token)).status, 403);
  assert.equal((await req('POST', `/api/columns/${todo.id}/cards`, { title: 'v' }, carol.token)).status, 403);
  assert.equal((await req('DELETE', `/api/boards/${board.id}/members/${alice.id}`, undefined, alice.token)).status, 400);

  r = await req('GET', '/api/boards', undefined, bob.token);
  assert.deepEqual(r.body, [{ id: board.id, name: 'Proj', role: 'editor' }]);

  const c1 = (await req('POST', `/api/columns/${todo.id}/cards`, { title: 'one', assignees: [bob.id] }, bob.token)).body;
  const c2 = (await req('POST', `/api/columns/${todo.id}/cards`, { title: 'two', dueDate: '2026-01-10' }, bob.token)).body;
  const c0 = (await req('POST', `/api/columns/${todo.id}/cards`, { title: 'zero', position: 0, description: 'Find ME' }, bob.token)).body;
  assert.equal(c0.position, 0);
  r = await req('GET', `/api/boards/${board.id}`, undefined, carol.token);
  assert.deepEqual(r.body.columns[0].cards.map((c) => c.title), ['zero', 'one', 'two']);
  assert.equal((await req('POST', `/api/columns/${todo.id}/cards`, { title: 'x', assignees: ['nobody'] }, bob.token)).status, 400);
  assert.equal((await req('POST', `/api/columns/${todo.id}/cards`, { title: '' }, bob.token)).status, 400);
  assert.equal((await req('POST', `/api/columns/${todo.id}/cards`, { title: 'x', dueDate: '2026-13-01' }, bob.token)).status, 400);

  // wip
  r = await req('PATCH', `/api/columns/${doing.id}`, { wipLimit: 1 }, bob.token);
  assert.equal(r.status, 200);
  r = await req('POST', `/api/cards/${c1.id}/move`, { columnId: doing.id }, bob.token);
  assert.equal(r.status, 200);
  assert.equal(r.body.columnId, doing.id);
  r = await req('POST', `/api/cards/${c2.id}/move`, { columnId: doing.id }, bob.token);
  assert.equal(r.status, 409);
  assert.equal(r.body.error, 'wip_limit');
  r = await req('POST', `/api/columns/${doing.id}/cards`, { title: 'q' }, bob.token);
  assert.equal(r.body.error, 'wip_limit');
  r = await req('GET', `/api/boards/${board.id}`, undefined, carol.token);
  assert.deepEqual(r.body.columns[0].cards.map((c) => [c.title, c.position]), [['zero', 0], ['two', 1]]);
  // reorder within column
  r = await req('POST', `/api/cards/${c2.id}/move`, { columnId: todo.id, position: 0 }, bob.token);
  assert.equal(r.body.position, 0);

  // other board column
  const other = (await req('POST', '/api/boards', { name: 'Other', columns: ['A'] }, bob.token)).body;
  assert.equal((await req('POST', `/api/cards/${c2.id}/move`, { columnId: other.columns[0].id }, bob.token)).status, 400);

  // column reorder
  r = await req('PATCH', `/api/columns/${done.id}`, { position: 0 }, bob.token);
  r = await req('GET', `/api/boards/${board.id}`, undefined, bob.token);
  assert.deepEqual(r.body.columns.map((c) => [c.name, c.position]), [['Done', 0], ['To Do', 1], ['In Progress', 2]]);

  // labels
  r = await req('POST', `/api/boards/${board.id}/labels`, { name: 'Bug', color: '#ff0000' }, bob.token);
  assert.equal(r.status, 201);
  const label = r.body;
  assert.equal((await req('POST', `/api/boards/${board.id}/labels`, { name: 'bug', color: '#ff0000' }, bob.token)).status, 409);
  assert.equal((await req('POST', `/api/boards/${board.id}/labels`, { name: 'x', color: 'red' }, bob.token)).status, 400);
  r = await req('PATCH', `/api/cards/${c0.id}`, { labels: [label.id] }, bob.token);
  assert.deepEqual(r.body.labels, [label.id]);

  // search
  r = await req('GET', `/api/boards/${board.id}/cards?q=find`, undefined, carol.token);
  assert.deepEqual(r.body.map((c) => c.id), [c0.id]);
  r = await req('GET', `/api/boards/${board.id}/cards?label=${label.id}`, undefined, carol.token);
  assert.deepEqual(r.body.map((c) => c.id), [c0.id]);
  r = await req('GET', `/api/boards/${board.id}/cards?due_before=2026-01-11`, undefined, carol.token);
  assert.deepEqual(r.body.map((c) => c.id), [c2.id]);
  r = await req('GET', `/api/boards/${board.id}/cards?due_before=2026-01-10`, undefined, carol.token);
  assert.deepEqual(r.body, []);
  r = await req('GET', `/api/boards/${board.id}/cards?assignee=${bob.id}`, undefined, carol.token);
  assert.deepEqual(r.body.map((c) => c.id), [c1.id]);
  r = await req('GET', `/api/boards/${board.id}/cards`, undefined, carol.token);
  assert.deepEqual(r.body.map((c) => c.title), ['two', 'zero', 'one']);

  assert.equal((await req('DELETE', `/api/labels/${label.id}`, undefined, bob.token)).status, 204);
  r = await req('GET', `/api/cards/${c0.id}`, undefined, bob.token);
  assert.deepEqual(r.body.labels, []);

  // comments
  r = await req('POST', `/api/cards/${c0.id}/comments`, { body: 'hi' }, bob.token);
  assert.equal(r.status, 201);
  const cm = r.body;
  await req('POST', `/api/cards/${c0.id}/comments`, { body: 'second' }, alice.token);
  assert.equal((await req('POST', `/api/cards/${c0.id}/comments`, { body: 'v' }, carol.token)).status, 403);
  r = await req('GET', `/api/cards/${c0.id}/comments`, undefined, carol.token);
  assert.deepEqual(r.body.map((c) => c.body), ['hi', 'second']);
  const cm2 = r.body[1];
  assert.equal((await req('DELETE', `/api/comments/${cm2.id}`, undefined, bob.token)).status, 403);
  assert.equal((await req('DELETE', `/api/comments/${cm.id}`, undefined, alice.token)).status, 204);

  // column delete
  assert.equal((await req('DELETE', `/api/columns/${todo.id}`, undefined, bob.token)).status, 409);
  assert.equal((await req('DELETE', `/api/columns/${todo.id}?force=true`, undefined, bob.token)).status, 204);
  r = await req('GET', `/api/boards/${board.id}`, undefined, bob.token);
  assert.deepEqual(r.body.columns.map((c) => c.position), [0, 1]);
  assert.equal((await req('GET', `/api/cards/${c0.id}`, undefined, bob.token)).status, 404);

  // activity
  r = await req('GET', `/api/boards/${board.id}/activity`, undefined, carol.token);
  const types = r.body.map((a) => a.type);
  for (const ty of ['board.created', 'column.created', 'card.created', 'card.updated', 'card.moved', 'comment.added', 'member.added']) assert.ok(types.includes(ty), ty);
  assert.equal(types.at(-1), 'board.created');
  const mv = r.body.find((a) => a.type === 'card.moved');
  assert.equal(mv.details.fromColumnId, todo.id);
  r = await req('GET', `/api/boards/${board.id}/activity?limit=2`, undefined, carol.token);
  assert.equal(r.body.length, 2);

  // remove self
  assert.equal((await req('DELETE', `/api/boards/${board.id}/members/${bob.id}`, undefined, carol.token)).status, 403);
  assert.equal((await req('DELETE', `/api/boards/${board.id}/members/${carol.id}`, undefined, carol.token)).status, 204);
  assert.equal((await req('DELETE', `/api/boards/${board.id}`, undefined, bob.token)).status, 403);
  assert.equal((await req('DELETE', `/api/boards/${board.id}`, undefined, alice.token)).status, 204);
  assert.equal((await req('GET', `/api/boards/${board.id}`, undefined, alice.token)).status, 404);
  await t.close();
});

test('persistence and UI', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-'));
  const dataFile = path.join(dir, 'data.json');
  let t = await start({ dataFile });
  const a = await t.user('dave');
  const b = (await t.req('POST', '/api/boards', { name: 'Persist' }, a.token)).body;
  await t.close();
  assert.ok(!fs.readFileSync(dataFile, 'utf8').includes('password123'));
  t = await start({ dataFile });
  const r = await t.req('POST', '/api/auth/login', { username: 'dave', password: 'password123' });
  assert.equal(r.status, 200);
  const g = await t.req('GET', `/api/boards/${b.id}`, undefined, r.body.token);
  assert.equal(g.body.name, 'Persist');
  const html = await fetch(t.base + '/');
  assert.match(html.headers.get('content-type'), /text\/html/);
  assert.equal((await fetch(t.base + '/static/app.js')).status, 200);
  await t.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
