import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../../src/server.js';

async function start(opts) {
  const srv = createServer(opts); await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const req = async (method, p, b, t) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b === undefined ? undefined : (typeof b === 'string' ? b : JSON.stringify(b)) });
    const text = await res.text();
    return { status: res.status, body: text ? (res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text) : null, headers: res.headers };
  };
  const user = async (u) => {
    await req('POST', '/api/auth/register', { username: u, password: 'password123' });
    const r = await req('POST', '/api/auth/login', { username: u, password: 'password123' });
    return { token: r.body.token, id: r.body.user.id };
  };
  return { srv, req, user, base };
}

test('full flow', async () => {
  const { srv, req, user } = await start();
  try {
    assert.equal((await req('POST', '/api/auth/register', { username: 'ab', password: 'password123' })).status, 400);
    assert.equal((await req('POST', '/api/auth/register', { username: 'abc', password: 'short' })).status, 400);
    const a = await user('Alice');
    assert.equal((await req('POST', '/api/auth/register', { username: 'alice', password: 'password123' })).status, 409);
    const b = await user('bob');
    const c = await user('carol');
    assert.equal((await req('GET', '/api/auth/me', undefined, a.token)).body.user.username, 'alice');
    assert.equal((await req('GET', '/api/boards')).status, 401);
    assert.equal((await req('POST', '/api/boards', '{bad', a.token)).status, 400);
    assert.equal((await req('GET', '/api/nope', undefined, a.token)).status, 404);

    const board = (await req('POST', '/api/boards', { name: 'B' }, a.token)).body;
    assert.deepEqual(board.columns.map(c => c.name), ['To Do', 'In Progress', 'Done']);
    assert.equal((await req('GET', `/api/boards/${board.id}`, undefined, b.token)).status, 403);
    assert.equal((await req('GET', `/api/boards/xyz`, undefined, b.token)).status, 404);
    assert.equal((await req('POST', `/api/boards/${board.id}/members`, { username: 'bob', role: 'editor' }, a.token)).status, 201);
    assert.equal((await req('POST', `/api/boards/${board.id}/members`, { username: 'bob', role: 'editor' }, a.token)).status, 409);
    assert.equal((await req('POST', `/api/boards/${board.id}/members`, { username: 'zzz', role: 'editor' }, a.token)).status, 404);
    assert.equal((await req('POST', `/api/boards/${board.id}/members`, { username: 'carol', role: 'viewer' }, a.token)).status, 201);
    assert.equal((await req('DELETE', `/api/boards/${board.id}/members/${a.id}`, undefined, a.token)).status, 400);

    const [todo, prog] = board.columns;
    assert.equal((await req('POST', `/api/columns/${todo.id}/cards`, { title: 'x' }, c.token)).status, 403);
    const label = (await req('POST', `/api/boards/${board.id}/labels`, { name: 'Bug', color: '#ff0000' }, b.token)).body;
    assert.equal((await req('POST', `/api/boards/${board.id}/labels`, { name: 'bug', color: '#ff0000' }, b.token)).status, 409);
    assert.equal((await req('POST', `/api/boards/${board.id}/labels`, { name: 'x', color: 'red' }, b.token)).status, 400);
    const c1 = (await req('POST', `/api/columns/${todo.id}/cards`, { title: 'one', labels: [label.id], assignees: [b.id], dueDate: '2026-01-10' }, b.token)).body;
    const c2 = (await req('POST', `/api/columns/${todo.id}/cards`, { title: 'two' }, b.token)).body;
    const c0 = (await req('POST', `/api/columns/${todo.id}/cards`, { title: 'zero', position: 0 }, b.token)).body;
    assert.equal(c0.position, 0);
    assert.equal((await req('GET', `/api/cards/${c1.id}`, undefined, a.token)).body.position, 1);
    assert.equal((await req('POST', `/api/columns/${todo.id}/cards`, { title: 'x', assignees: ['nope'] }, b.token)).status, 400);

    assert.equal((await req('PATCH', `/api/columns/${prog.id}`, { wipLimit: 1 }, a.token)).status, 200);
    let mv = await req('POST', `/api/cards/${c1.id}/move`, { columnId: prog.id }, b.token);
    assert.equal(mv.status, 200);
    mv = await req('POST', `/api/cards/${c2.id}/move`, { columnId: prog.id }, b.token);
    assert.equal(mv.status, 409); assert.equal(mv.body.error, 'wip_limit');
    const full = (await req('GET', `/api/boards/${board.id}`, undefined, a.token)).body;
    assert.deepEqual(full.columns[0].cards.map(x => [x.title, x.position]), [['zero', 0], ['two', 1]]);

    const s = await req('GET', `/api/boards/${board.id}/cards?q=ON&label=${label.id}&due_before=2026-02-01`, undefined, c.token);
    assert.deepEqual(s.body.map(x => x.id), [c1.id]);

    const cm = (await req('POST', `/api/cards/${c1.id}/comments`, { body: 'hi' }, b.token)).body;
    assert.equal((await req('POST', `/api/cards/${c1.id}/comments`, { body: 'hi' }, c.token)).status, 403);
    assert.equal((await req('GET', `/api/cards/${c1.id}/comments`, undefined, c.token)).body.length, 1);
    assert.equal((await req('DELETE', `/api/comments/${cm.id}`, undefined, c.token)).status, 403);
    assert.equal((await req('DELETE', `/api/comments/${cm.id}`, undefined, a.token)).status, 204);

    assert.equal((await req('DELETE', `/api/labels/${label.id}`, undefined, b.token)).status, 204);
    assert.deepEqual((await req('GET', `/api/cards/${c1.id}`, undefined, a.token)).body.labels, []);

    assert.equal((await req('DELETE', `/api/columns/${todo.id}`, undefined, b.token)).status, 409);
    assert.equal((await req('DELETE', `/api/columns/${todo.id}?force=true`, undefined, b.token)).status, 204);
    const after = (await req('GET', `/api/boards/${board.id}`, undefined, a.token)).body;
    assert.deepEqual(after.columns.map(x => x.position), [0, 1]);
    assert.equal((await req('PATCH', `/api/columns/${after.columns[1].id}`, { position: -5 }, b.token)).body.position, 0);

    const act = (await req('GET', `/api/boards/${board.id}/activity?limit=3`, undefined, c.token)).body;
    assert.equal(act.length, 3);
    const all = (await req('GET', `/api/boards/${board.id}/activity`, undefined, c.token)).body;
    const types = new Set(all.map(x => x.type));
    for (const t of ['board.created', 'column.created', 'card.created', 'card.moved', 'comment.added', 'member.added']) assert.ok(types.has(t), t);
    const moved = all.find(x => x.type === 'card.moved');
    assert.equal(moved.details.toColumnId, prog.id);

    assert.equal((await req('DELETE', `/api/boards/${board.id}/members/${c.id}`, undefined, c.token)).status, 204);
    assert.equal((await req('DELETE', `/api/boards/${board.id}`, undefined, b.token)).status, 403);
    assert.equal((await req('DELETE', `/api/boards/${board.id}`, undefined, a.token)).status, 204);
    assert.equal((await req('GET', `/api/cards/${c1.id}`, undefined, a.token)).status, 404);

    assert.equal((await req('POST', '/api/auth/logout', undefined, a.token)).status, 204);
    assert.equal((await req('GET', '/api/auth/me', undefined, a.token)).status, 401);

    const ui = await req('GET', '/');
    assert.equal(ui.status, 200); assert.match(ui.headers.get('content-type'), /text\/html/);
  } finally { srv.close(); }
});

test('rate limit', async () => {
  const { srv, req, user } = await start();
  try {
    await user('dave');
    for (let i = 0; i < 5; i++) assert.equal((await req('POST', '/api/auth/login', { username: 'dave', password: 'wrongpass' })).status, 401);
    assert.equal((await req('POST', '/api/auth/login', { username: 'dave', password: 'password123' })).status, 429);
  } finally { srv.close(); }
});

test('persistence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-'));
  const dataFile = path.join(dir, 'data.json');
  let s = await start({ dataFile });
  const a = await s.user('erin');
  const board = (await s.req('POST', '/api/boards', { name: 'P' }, a.token)).body;
  s.srv.close();
  assert.ok(!fs.readFileSync(dataFile, 'utf8').includes('password123'));
  s = await start({ dataFile });
  const r = await s.req('POST', '/api/auth/login', { username: 'erin', password: 'password123' });
  assert.equal(r.status, 200);
  assert.equal((await s.req('GET', `/api/boards/${board.id}`, undefined, r.body.token)).body.name, 'P');
  s.srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
