import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';

let srv, base, dir;
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-test-'));
  srv = createServer({ dataFile: path.join(dir, 'data.json') });
  await new Promise((r) => srv.listen(0, r));
  base = `http://127.0.0.1:${srv.address().port}`;
});
after(() => { srv.closeAllConnections?.(); srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function call(method, p, body, token) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

let n = 0;
async function user(name) {
  const username = `${name}_${++n}`.replace(/[^a-z0-9_]/g, '');
  const r = await call('POST', '/api/auth/register', { username, password: 'password123' });
  assert.equal(r.status, 201);
  const l = await call('POST', '/api/auth/login', { username, password: 'password123' });
  return { id: r.body.user.id, username, token: l.body.token };
}

test('register validation and conflicts', async () => {
  assert.equal((await call('POST', '/api/auth/register', { username: 'ab', password: 'password123' })).status, 400);
  assert.equal((await call('POST', '/api/auth/register', { username: 'Bad-Name', password: 'password123' })).status, 400);
  assert.equal((await call('POST', '/api/auth/register', { username: 'okuser', password: 'short' })).status, 400);
  const ok = await call('POST', '/api/auth/register', { username: 'MixedCase', password: 'password123' });
  assert.equal(ok.status, 201);
  assert.equal(ok.body.user.username, 'mixedcase');
  assert.equal(ok.body.user.displayName, 'mixedcase');
  assert.equal(ok.body.user.password, undefined);
  assert.equal((await call('POST', '/api/auth/register', { username: 'mixedcase', password: 'password123' })).status, 409);
});

test('invalid JSON is 400 and unknown routes are 404', async () => {
  const r = await call('POST', '/api/auth/register', '{bad json');
  assert.equal(r.status, 400);
  assert.equal((await call('GET', '/api/nope')).status, 404);
});

test('auth required, logout, me', async () => {
  const u = await user('auth');
  assert.equal((await call('GET', '/api/boards')).status, 401);
  assert.equal((await call('GET', '/api/boards', undefined, 'garbage')).status, 401);
  const me = await call('GET', '/api/auth/me', undefined, u.token);
  assert.equal(me.status, 200);
  assert.equal(me.body.user.username, u.username);
  assert.equal((await call('POST', '/api/auth/logout', undefined, u.token)).status, 204);
  assert.equal((await call('GET', '/api/auth/me', undefined, u.token)).status, 401);
});

test('login rate limiting after 5 failures', async () => {
  const name = `limit_${Date.now()}`;
  await call('POST', '/api/auth/register', { username: name, password: 'password123' });
  for (let i = 0; i < 5; i++) assert.equal((await call('POST', '/api/auth/login', { username: name, password: 'wrongpass' })).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { username: name, password: 'password123' })).status, 429);
});

test('board lifecycle, roles and membership', async () => {
  const owner = await user('owner');
  const ed = await user('editor');
  const vw = await user('viewer');
  const outsider = await user('outsider');

  const created = await call('POST', '/api/boards', { name: 'Project' }, owner.token);
  assert.equal(created.status, 201);
  const bid = created.body.id;
  assert.deepEqual(created.body.columns.map((c) => c.name), ['To Do', 'In Progress', 'Done']);
  assert.deepEqual(created.body.columns.map((c) => c.position), [0, 1, 2]);
  assert.equal((await call('POST', '/api/boards', { name: '' }, owner.token)).status, 400);

  assert.equal((await call('GET', `/api/boards/${bid}`, undefined, outsider.token)).status, 403);
  assert.equal((await call('GET', '/api/boards/nope', undefined, owner.token)).status, 404);

  assert.equal((await call('POST', `/api/boards/${bid}/members`, { username: ed.username, role: 'editor' }, owner.token)).status, 201);
  assert.equal((await call('POST', `/api/boards/${bid}/members`, { username: vw.username, role: 'viewer' }, owner.token)).status, 201);
  assert.equal((await call('POST', `/api/boards/${bid}/members`, { username: ed.username, role: 'editor' }, owner.token)).status, 409);
  assert.equal((await call('POST', `/api/boards/${bid}/members`, { username: 'ghostuser', role: 'editor' }, owner.token)).status, 404);
  assert.equal((await call('POST', `/api/boards/${bid}/members`, { username: outsider.username, role: 'editor' }, ed.token)).status, 403);

  const list = await call('GET', '/api/boards', undefined, vw.token);
  assert.deepEqual(list.body, [{ id: bid, name: 'Project', role: 'viewer' }]);

  // viewer cannot create columns; editor can
  assert.equal((await call('POST', `/api/boards/${bid}/columns`, { name: 'X' }, vw.token)).status, 403);
  assert.equal((await call('POST', `/api/boards/${bid}/columns`, { name: 'Review' }, ed.token)).status, 201);
  // only owner patches board
  assert.equal((await call('PATCH', `/api/boards/${bid}`, { name: 'Renamed' }, ed.token)).status, 403);
  assert.equal((await call('PATCH', `/api/boards/${bid}`, { name: 'Renamed' }, owner.token)).body.name, 'Renamed');

  // member role changes and removal
  assert.equal((await call('PATCH', `/api/boards/${bid}/members/${vw.id}`, { role: 'editor' }, owner.token)).status, 200);
  assert.equal((await call('PATCH', `/api/boards/${bid}/members/${owner.id}`, { role: 'viewer' }, owner.token)).status, 400);
  assert.equal((await call('DELETE', `/api/boards/${bid}/members/${owner.id}`, undefined, owner.token)).status, 400);
  assert.equal((await call('DELETE', `/api/boards/${bid}/members/${vw.id}`, undefined, ed.token)).status, 403);
  assert.equal((await call('DELETE', `/api/boards/${bid}/members/${vw.id}`, undefined, vw.token)).status, 204);

  assert.equal((await call('DELETE', `/api/boards/${bid}`, undefined, ed.token)).status, 403);
  assert.equal((await call('DELETE', `/api/boards/${bid}`, undefined, owner.token)).status, 204);
  assert.equal((await call('GET', `/api/boards/${bid}`, undefined, owner.token)).status, 404);
});

test('cards, wip limits, moves, positions, search, comments, activity', async () => {
  const owner = await user('cards');
  const ed = await user('cardsed');
  const bid = (await call('POST', '/api/boards', { name: 'Work', columns: ['A', 'B'] }, owner.token)).body.id;
  await call('POST', `/api/boards/${bid}/members`, { username: ed.username, role: 'editor' }, owner.token);
  const board = (await call('GET', `/api/boards/${bid}`, undefined, owner.token)).body;
  const [colA, colB] = board.columns;

  const lab = await call('POST', `/api/boards/${bid}/labels`, { name: 'Bug', color: '#ff0000' }, owner.token);
  assert.equal(lab.status, 201);
  assert.equal((await call('POST', `/api/boards/${bid}/labels`, { name: 'bug', color: '#ff0000' }, owner.token)).status, 409);
  assert.equal((await call('POST', `/api/boards/${bid}/labels`, { name: 'x', color: 'red' }, owner.token)).status, 400);

  const c1 = await call('POST', `/api/columns/${colA.id}/cards`, { title: 'first', description: 'hello world', labels: [lab.body.id], dueDate: '2026-05-01' }, ed.token);
  assert.equal(c1.status, 201);
  const c2 = await call('POST', `/api/columns/${colA.id}/cards`, { title: 'second', assignees: [ed.id] }, ed.token);
  assert.equal(c2.body.position, 1);
  const c3 = await call('POST', `/api/columns/${colA.id}/cards`, { title: 'top', position: 0 }, ed.token);
  assert.equal(c3.body.position, 0);
  const aCards = (await call('GET', `/api/boards/${bid}`, undefined, owner.token)).body.columns[0].cards;
  assert.deepEqual(aCards.map((c) => c.title), ['top', 'first', 'second']);
  assert.deepEqual(aCards.map((c) => c.position), [0, 1, 2]);

  assert.equal((await call('POST', `/api/columns/${colA.id}/cards`, { title: 'x', assignees: ['nobody'] }, ed.token)).status, 400);
  assert.equal((await call('POST', `/api/columns/${colA.id}/cards`, { title: 'x', dueDate: '2026-02-30' }, ed.token)).status, 400);

  // WIP limit
  const wip = await call('POST', `/api/boards/${bid}/columns`, { name: 'Limited', wipLimit: 1 }, owner.token);
  const limited = wip.body;
  assert.equal((await call('POST', `/api/columns/${limited.id}/cards`, { title: 'one' }, ed.token)).status, 201);
  assert.equal((await call('POST', `/api/columns/${limited.id}/cards`, { title: 'two' }, ed.token)).status, 409);

  // move first card into B at position 0 and check compaction
  const moved = await call('POST', `/api/cards/${c1.body.id}/move`, { columnId: colB.id, position: 0 }, ed.token);
  assert.equal(moved.status, 200);
  assert.equal(moved.body.columnId, colB.id);
  assert.equal(moved.body.position, 0);
  const after = (await call('GET', `/api/boards/${bid}`, undefined, owner.token)).body;
  assert.deepEqual(after.columns[0].cards.map((c) => c.position), [0, 1]);
  // cross-board target is rejected
  const other = (await call('POST', '/api/boards', { name: 'Other' }, owner.token)).body;
  assert.equal((await call('POST', `/api/cards/${c1.body.id}/move`, { columnId: other.columns[0].id }, ed.token)).status, 400);

  // search
  const s1 = await call('GET', `/api/boards/${bid}/cards?q=HELLO`, undefined, owner.token);
  assert.deepEqual(s1.body.map((c) => c.title), ['first']);
  const s2 = await call('GET', `/api/boards/${bid}/cards?label=${lab.body.id}`, undefined, owner.token);
  assert.equal(s2.body.length, 1);
  const s3 = await call('GET', `/api/boards/${bid}/cards?due_before=2026-05-01`, undefined, owner.token);
  assert.equal(s3.body.length, 0);
  const s4 = await call('GET', `/api/boards/${bid}/cards?due_before=2026-05-02`, undefined, owner.token);
  assert.equal(s4.body.length, 1);
  const s5 = await call('GET', `/api/boards/${bid}/cards?assignee=${ed.id}`, undefined, owner.token);
  assert.equal(s5.body[0].title, 'second');

  // patch card
  const p = await call('PATCH', `/api/cards/${c2.body.id}`, { title: 'second!', dueDate: null }, ed.token);
  assert.equal(p.body.title, 'second!');
  assert.equal(p.body.dueDate, null);

  // comments
  const cm = await call('POST', `/api/cards/${c2.body.id}/comments`, { body: 'looks good' }, ed.token);
  assert.equal(cm.status, 201);
  assert.equal((await call('POST', `/api/cards/${c2.body.id}/comments`, { body: '' }, ed.token)).status, 400);
  assert.equal((await call('DELETE', `/api/comments/${cm.body.id}`, undefined, owner.token)).status, 204);

  // activity
  const act = await call('GET', `/api/boards/${bid}/activity?limit=5`, undefined, owner.token);
  assert.equal(act.body.length, 5);
  const types = (await call('GET', `/api/boards/${bid}/activity`, undefined, owner.token)).body.map((a) => a.type);
  for (const t of ['board.created', 'column.created', 'card.created', 'card.updated', 'card.moved', 'comment.added', 'member.added']) {
    assert.ok(types.includes(t), `missing ${t}`);
  }
  assert.equal(types[0], 'comment.added');
  assert.ok(types.indexOf('card.updated') < types.indexOf('card.moved'));

  // column delete requires force when non-empty
  assert.equal((await call('DELETE', `/api/columns/${colB.id}`, undefined, owner.token)).status, 409);
  assert.equal((await call('DELETE', `/api/columns/${colB.id}?force=true`, undefined, owner.token)).status, 204);
  assert.equal((await call('GET', `/api/cards/${c1.body.id}`, undefined, owner.token)).status, 404);

  // delete label removes it from cards
  await call('DELETE', `/api/labels/${lab.body.id}`, undefined, owner.token);
  assert.deepEqual((await call('GET', `/api/cards/${c2.body.id}`, undefined, owner.token)).body.labels, []);
});

test('column reordering keeps positions contiguous', async () => {
  const owner = await user('reorder');
  const bid = (await call('POST', '/api/boards', { name: 'R', columns: ['a', 'b', 'c'] }, owner.token)).body.id;
  const cols = (await call('GET', `/api/boards/${bid}`, undefined, owner.token)).body.columns;
  const r = await call('PATCH', `/api/columns/${cols[0].id}`, { position: 2 }, owner.token);
  assert.equal(r.status, 200);
  const names = (await call('GET', `/api/boards/${bid}`, undefined, owner.token)).body.columns.map((c) => [c.name, c.position]);
  assert.deepEqual(names, [['b', 0], ['c', 1], ['a', 2]]);
});

test('persistence: a new server on the same file sees data and passwords are hashed', async () => {
  const file = path.join(dir, 'persist.json');
  const s1 = createServer({ dataFile: file });
  await new Promise((r) => s1.listen(0, r));
  const b1 = `http://127.0.0.1:${s1.address().port}`;
  await fetch(b1 + '/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'persisted', password: 'supersecret1' }) });
  s1.close();
  s1.closeAllConnections?.();
  const raw = fs.readFileSync(file, 'utf8');
  assert.equal(raw.includes('supersecret1'), false);
  const s2 = createServer({ dataFile: file });
  await new Promise((r) => s2.listen(0, r));
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  const res = await fetch(b2 + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'persisted', password: 'supersecret1' }) });
  assert.equal(res.status, 200);
  s2.close();
  s2.closeAllConnections?.();
});

test('web UI is served at /', async () => {
  const res = await fetch(base + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
});
