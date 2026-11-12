import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../../src/server.js';

let srv, base, dir;
before(async () => {
  dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'kanban-test-'));
  srv = createServer({ dataFile: path.join(dir, 'data.json') });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => {
  srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function call(method, p, { body, token, raw } = {}) {
  const headers = {};
  if (body !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(base + p, { method, headers, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function user(name) {
  await call('POST', '/api/auth/register', { body: { username: name, password: 'password123' } });
  const r = await call('POST', '/api/auth/login', { body: { username: name, password: 'password123' } });
  return { token: r.json.token, user: r.json.user };
}

test('auth: register validation, duplicates, login, me, logout', async () => {
  assert.equal((await call('POST', '/api/auth/register', { body: { username: 'ab', password: 'password123' } })).status, 400);
  assert.equal((await call('POST', '/api/auth/register', { body: { username: 'bob', password: 'short' } })).status, 400);
  const r = await call('POST', '/api/auth/register', { body: { username: 'Bobby', password: 'password123' } });
  assert.equal(r.status, 201);
  assert.equal(r.json.user.username, 'bobby');
  assert.equal(r.json.user.displayName, 'bobby');
  assert.equal(r.json.user.passwordHash, undefined);
  assert.equal((await call('POST', '/api/auth/register', { body: { username: 'BOBBY', password: 'password123' } })).status, 409);
  assert.equal((await call('POST', '/api/auth/login', { body: { username: 'bobby', password: 'wrongwrong' } })).status, 401);
  const ok = await call('POST', '/api/auth/login', { body: { username: 'bobby', password: 'password123' } });
  assert.equal(ok.status, 200);
  assert.equal((await call('GET', '/api/auth/me', { token: ok.json.token })).json.user.username, 'bobby');
  assert.equal((await call('POST', '/api/auth/logout', { token: ok.json.token })).status, 204);
  assert.equal((await call('GET', '/api/auth/me', { token: ok.json.token })).status, 401);
  assert.equal((await call('GET', '/api/boards')).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { raw: '{bad json' })).status, 400);
  assert.equal((await call('GET', '/api/nope')).status, 404);
});

test('login is rate limited after 5 failures', async () => {
  await call('POST', '/api/auth/register', { body: { username: 'lockme', password: 'password123' } });
  for (let i = 0; i < 5; i++) {
    assert.equal((await call('POST', '/api/auth/login', { body: { username: 'lockme', password: 'nope-nope' } })).status, 401);
  }
  assert.equal((await call('POST', '/api/auth/login', { body: { username: 'lockme', password: 'password123' } })).status, 429);
});

test('passwords are hashed in the data file', async () => {
  const data = fs.readFileSync(path.join(dir, 'data.json'), 'utf8');
  assert.ok(!data.includes('password123'));
  assert.ok(data.includes('scrypt$'));
});

test('boards, members, roles and columns', async () => {
  const owner = await user('owner1');
  const ed = await user('editor1');
  const vw = await user('viewer1');
  const other = await user('other1');
  const b = await call('POST', '/api/boards', { token: owner.token, body: { name: 'Proj' } });
  assert.equal(b.status, 201);
  const boardId = b.json.id;
  assert.deepEqual(b.json.columns.map((c) => c.name), ['To Do', 'In Progress', 'Done']);
  assert.equal((await call('GET', `/api/boards/${boardId}`, { token: other.token })).status, 403);
  assert.equal((await call('GET', '/api/boards/nope', { token: other.token })).status, 404);
  assert.equal((await call('POST', `/api/boards/${boardId}/members`, { token: owner.token, body: { username: 'editor1', role: 'editor' } })).status, 201);
  assert.equal((await call('POST', `/api/boards/${boardId}/members`, { token: owner.token, body: { username: 'viewer1', role: 'viewer' } })).status, 201);
  assert.equal((await call('POST', `/api/boards/${boardId}/members`, { token: owner.token, body: { username: 'viewer1', role: 'viewer' } })).status, 409);
  assert.equal((await call('POST', `/api/boards/${boardId}/members`, { token: owner.token, body: { username: 'ghost', role: 'viewer' } })).status, 404);
  assert.equal((await call('GET', '/api/boards', { token: ed.token })).json[0].role, 'editor');
  // viewer cannot create columns, editor can
  assert.equal((await call('POST', `/api/boards/${boardId}/columns`, { token: vw.token, body: { name: 'X' } })).status, 403);
  const col = await call('POST', `/api/boards/${boardId}/columns`, { token: ed.token, body: { name: 'Review' } });
  assert.equal(col.status, 201);
  // editor cannot change board settings
  assert.equal((await call('PATCH', `/api/boards/${boardId}`, { token: ed.token, body: { name: 'Z' } })).status, 403);
  // move column to front
  const moved = await call('PATCH', `/api/columns/${col.json.id}`, { token: owner.token, body: { position: 0 } });
  assert.equal(moved.status, 200);
  const detail = (await call('GET', `/api/boards/${boardId}`, { token: owner.token })).json;
  assert.deepEqual(detail.columns.map((c) => c.name), ['Review', 'To Do', 'In Progress', 'Done']);
  assert.deepEqual(detail.columns.map((c) => c.position), [0, 1, 2, 3]);
  // role changes and removal
  assert.equal((await call('PATCH', `/api/boards/${boardId}/members/${owner.user.id}`, { token: owner.token, body: { role: 'viewer' } })).status, 400);
  assert.equal((await call('DELETE', `/api/boards/${boardId}/members/${owner.user.id}`, { token: owner.token })).status, 400);
  assert.equal((await call('DELETE', `/api/boards/${boardId}/members/${vw.user.id}`, { token: ed.token })).status, 403);
  assert.equal((await call('DELETE', `/api/boards/${boardId}/members/${vw.user.id}`, { token: vw.token })).status, 204);
  assert.equal((await call('GET', `/api/boards/${boardId}`, { token: vw.token })).status, 403);
  assert.equal((await call('DELETE', `/api/boards/${boardId}`, { token: ed.token })).status, 403);
});

test('cards: validation, positions, WIP limits, move, search, activity', async () => {
  const owner = await user('owner2');
  const ed = await user('editor2');
  const b = (await call('POST', '/api/boards', { token: owner.token, body: { name: 'Work', columns: ['A', 'B'] } })).json;
  await call('POST', `/api/boards/${b.id}/members`, { token: owner.token, body: { username: 'editor2', role: 'editor' } });
  const [colA, colB] = b.columns;
  const lbl = await call('POST', `/api/boards/${b.id}/labels`, { token: owner.token, body: { name: 'Bug', color: '#ff0000' } });
  assert.equal(lbl.status, 201);
  assert.equal((await call('POST', `/api/boards/${b.id}/labels`, { token: owner.token, body: { name: 'bug', color: '#ff0000' } })).status, 409);
  assert.equal((await call('POST', `/api/boards/${b.id}/labels`, { token: owner.token, body: { name: 'x', color: 'red' } })).status, 400);

  const c1 = await call('POST', `/api/columns/${colA.id}/cards`, { token: ed.token, body: { title: 'first', description: 'alpha beta' } });
  const c2 = await call('POST', `/api/columns/${colA.id}/cards`, { token: ed.token, body: { title: 'second', dueDate: '2030-01-05', labels: [lbl.json.id] } });
  const c3 = await call('POST', `/api/columns/${colA.id}/cards`, { token: ed.token, body: { title: 'inserted', position: 0, assignees: [owner.user.id] } });
  assert.equal(c1.status, 201);
  assert.equal(c3.json.position, 0);
  assert.equal((await call('POST', `/api/columns/${colA.id}/cards`, { token: ed.token, body: { title: 'x', dueDate: '2030-02-30' } })).status, 400);
  assert.equal((await call('POST', `/api/columns/${colA.id}/cards`, { token: ed.token, body: { title: 'x', assignees: ['nobody'] } })).status, 400);
  assert.equal((await call('POST', `/api/columns/${colA.id}/cards`, { token: ed.token, body: { title: '' } })).status, 400);

  // WIP limit on column B
  assert.equal((await call('PATCH', `/api/columns/${colB.id}`, { token: owner.token, body: { wipLimit: 1 } })).status, 200);
  const m1 = await call('POST', `/api/cards/${c1.json.id}/move`, { token: ed.token, body: { columnId: colB.id } });
  assert.equal(m1.status, 200);
  assert.equal(m1.json.columnId, colB.id);
  const m2 = await call('POST', `/api/cards/${c2.json.id}/move`, { token: ed.token, body: { columnId: colB.id } });
  assert.equal(m2.status, 409);
  assert.equal(m2.json.error, 'wip_limit');
  assert.equal((await call('POST', `/api/columns/${colB.id}/cards`, { token: ed.token, body: { title: 'over' } })).json.error, 'wip_limit');
  assert.equal((await call('POST', `/api/cards/${c2.json.id}/move`, { token: ed.token, body: { columnId: 'nope' } })).status, 400);

  // positions remain contiguous in source
  const detail = (await call('GET', `/api/boards/${b.id}`, { token: owner.token })).json;
  const srcCards = detail.columns[0].cards;
  assert.deepEqual(srcCards.map((c) => c.position), srcCards.map((_, i) => i));
  assert.equal(srcCards[0].title, 'inserted');

  // search
  const q = await call('GET', `/api/boards/${b.id}/cards?q=ALPHA`, { token: owner.token });
  assert.deepEqual(q.json.map((c) => c.title), ['first']);
  const due = await call('GET', `/api/boards/${b.id}/cards?due_before=2031-01-01`, { token: owner.token });
  assert.deepEqual(due.json.map((c) => c.title), ['second']);
  const byLabel = await call('GET', `/api/boards/${b.id}/cards?label=${lbl.json.id}`, { token: owner.token });
  assert.equal(byLabel.json.length, 1);
  assert.equal((await call('GET', `/api/boards/${b.id}/cards?due_before=bad`, { token: owner.token })).status, 400);

  // patch + delete card
  const p = await call('PATCH', `/api/cards/${c2.json.id}`, { token: ed.token, body: { title: 'renamed', dueDate: null } });
  assert.equal(p.json.title, 'renamed');
  assert.equal(p.json.dueDate, null);
  assert.equal((await call('DELETE', `/api/cards/${c3.json.id}`, { token: ed.token })).status, 204);

  // comments
  const cm = await call('POST', `/api/cards/${c1.json.id}/comments`, { token: ed.token, body: { body: 'hi' } });
  assert.equal(cm.status, 201);
  assert.equal((await call('GET', `/api/cards/${c1.json.id}/comments`, { token: owner.token })).json.length, 1);
  assert.equal((await call('DELETE', `/api/comments/${cm.json.id}`, { token: owner.token })).status, 204);

  // activity newest first
  const act = (await call('GET', `/api/boards/${b.id}/activity?limit=3`, { token: owner.token })).json;
  assert.equal(act.length, 3);
  assert.ok(act[0].at >= act[1].at);
  const all = (await call('GET', `/api/boards/${b.id}/activity`, { token: owner.token })).json;
  const types = new Set(all.map((a) => a.type));
  for (const t of ['board.created', 'column.created', 'card.created', 'card.updated', 'card.moved', 'card.deleted', 'comment.added', 'member.added']) {
    assert.ok(types.has(t), `missing ${t}`);
  }
  const moved = all.find((a) => a.type === 'card.moved');
  assert.equal(moved.details.fromColumnId, colA.id);
  assert.equal(moved.details.toColumnId, colB.id);

  // column deletion needs force when it has cards
  assert.equal((await call('DELETE', `/api/columns/${colB.id}`, { token: owner.token })).status, 409);
  assert.equal((await call('DELETE', `/api/columns/${colB.id}?force=true`, { token: owner.token })).status, 204);
  assert.equal((await call('GET', `/api/boards/${b.id}`, { token: owner.token })).json.columns.length, 1);

  // board deletion
  assert.equal((await call('DELETE', `/api/boards/${b.id}`, { token: owner.token })).status, 204);
  assert.equal((await call('GET', `/api/boards/${b.id}`, { token: owner.token })).status, 404);
});

test('persistence: a new server on the same file sees data', async () => {
  const file = path.join(dir, 'persist.json');
  const s1 = createServer({ dataFile: file });
  await new Promise((r) => s1.listen(0, '127.0.0.1', r));
  const b1 = `http://127.0.0.1:${s1.address().port}`;
  await fetch(`${b1}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'persist', password: 'password123' }) });
  s1.close();
  const s2 = createServer({ dataFile: file });
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  const r = await fetch(`${b2}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'persist', password: 'password123' }) });
  assert.equal(r.status, 200);
  s2.close();
});

test('serves the web UI', async () => {
  const html = await fetch(`${base}/`);
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-type'), /text\/html/);
  const js = await fetch(`${base}/static/app.js`);
  assert.equal(js.status, 200);
  assert.equal((await fetch(`${base}/static/..%2Fserver.js`)).status, 404);
});
