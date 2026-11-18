import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../../src/server.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanban-'));
const dataFile = path.join(dir, 'data.json');
let srv, base;

before(async () => { srv = createServer({ dataFile }); await new Promise((r) => srv.listen(0, r)); base = `http://127.0.0.1:${srv.address().port}`; });
after(() => { srv.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function req(method, p, body, token) {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
}
async function user(name) {
  await req('POST', '/api/auth/register', { username: name, password: 'password123' });
  const r = await req('POST', '/api/auth/login', { username: name, password: 'password123' });
  return { token: r.body.token, id: r.body.user.id };
}

test('full flow', async () => {
  const a = await user('Alice_1');
  const b = await user('bob');
  assert.equal((await req('POST', '/api/auth/register', { username: 'alice_1', password: 'password123' })).status, 409);
  assert.equal((await req('POST', '/api/auth/register', { username: 'xy', password: 'password123' })).status, 400);
  assert.equal((await req('POST', '/api/boards', '{bad', a.token)).status, 400);
  assert.equal((await req('GET', '/api/boards')).status, 401);
  assert.equal((await req('GET', '/api/nope', undefined, a.token)).status, 404);

  const board = (await req('POST', '/api/boards', { name: 'B' }, a.token)).body;
  assert.equal(board.columns.length, 3);
  const [c0, c1] = board.columns;
  assert.equal((await req('GET', `/api/boards/${board.id}`, undefined, b.token)).status, 403);
  assert.equal((await req('POST', `/api/boards/${board.id}/members`, { username: 'bob', role: 'viewer' }, a.token)).status, 201);
  assert.equal((await req('POST', `/api/columns/${c0.id}/cards`, { title: 'x' }, b.token)).status, 403);

  await req('PATCH', `/api/columns/${c1.id}`, { wipLimit: 1 }, a.token);
  const k1 = (await req('POST', `/api/columns/${c0.id}/cards`, { title: 'one', dueDate: '2030-01-01' }, a.token)).body;
  const k2 = (await req('POST', `/api/columns/${c0.id}/cards`, { title: 'two' }, a.token)).body;
  const k3 = (await req('POST', `/api/columns/${c0.id}/cards`, { title: 'zero', position: 0 }, a.token)).body;
  assert.equal(k3.position, 0);
  const mv = await req('POST', `/api/cards/${k1.id}/move`, { columnId: c1.id }, a.token);
  assert.equal(mv.status, 200);
  const wip = await req('POST', `/api/cards/${k2.id}/move`, { columnId: c1.id }, a.token);
  assert.equal(wip.status, 409); assert.equal(wip.body.error, 'wip_limit');
  const full = (await req('GET', `/api/boards/${board.id}`, undefined, a.token)).body;
  assert.deepEqual(full.columns[0].cards.map((c) => [c.title, c.position]), [['zero', 0], ['two', 1]]);

  const lbl = (await req('POST', `/api/boards/${board.id}/labels`, { name: 'Bug', color: '#ff0000' }, a.token)).body;
  assert.equal((await req('POST', `/api/boards/${board.id}/labels`, { name: 'bug', color: '#ff0000' }, a.token)).status, 409);
  await req('PATCH', `/api/cards/${k2.id}`, { labels: [lbl.id] }, a.token);
  assert.equal((await req('GET', `/api/boards/${board.id}/cards?label=${lbl.id}`, undefined, b.token)).body.length, 1);
  assert.equal((await req('GET', `/api/boards/${board.id}/cards?due_before=2031-01-01`, undefined, b.token)).body.length, 1);
  await req('DELETE', `/api/labels/${lbl.id}`, undefined, a.token);
  assert.deepEqual((await req('GET', `/api/cards/${k2.id}`, undefined, a.token)).body.labels, []);

  const act = (await req('GET', `/api/boards/${board.id}/activity`, undefined, a.token)).body;
  const moved = act.find((e) => e.type === 'card.moved');
  assert.equal(moved.details.toColumnId, c1.id);
  assert.equal(act[act.length - 1].type, 'board.created');

  assert.equal((await req('DELETE', `/api/columns/${c0.id}`, undefined, a.token)).status, 409);
  assert.equal((await req('DELETE', `/api/columns/${c0.id}?force=true`, undefined, a.token)).status, 204);

  // persistence
  const raw = fs.readFileSync(dataFile, 'utf8');
  assert.ok(!raw.includes('password123'));
  const s2 = createServer({ dataFile }); await new Promise((r) => s2.listen(0, r));
  const r2 = await fetch(`http://127.0.0.1:${s2.address().port}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'bob', password: 'password123' }) });
  assert.equal(r2.status, 200);
  s2.close();

  const html = await fetch(base + '/');
  assert.match(html.headers.get('content-type'), /text\/html/);
});

test('login rate limit', async () => {
  await user('carol');
  for (let i = 0; i < 5; i++) assert.equal((await req('POST', '/api/auth/login', { username: 'carol', password: 'wrongpass' })).status, 401);
  assert.equal((await req('POST', '/api/auth/login', { username: 'carol', password: 'password123' })).status, 429);
});
