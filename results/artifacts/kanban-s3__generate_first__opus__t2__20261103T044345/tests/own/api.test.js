import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../../src/server.js';

async function start(opts) {
  const srv = createServer(opts); await new Promise((r) => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const req = async (method, p, body, t) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  };
  const user = async (name) => {
    await req('POST', '/api/auth/register', { username: name, password: 'password123' });
    const r = await req('POST', '/api/auth/login', { username: name, password: 'password123' });
    return { token: r.body.token, id: r.body.user.id };
  };
  return { srv, base, req, user };
}

test('full flow', async () => {
  const { srv, base, req, user } = await start();
  try {
    assert.equal((await req('POST', '/api/auth/register', { username: 'ab', password: 'password123' })).status, 400);
    assert.equal((await req('POST', '/api/auth/register', { username: 'abc', password: 'short' })).status, 400);
    assert.equal((await req('POST', '/api/auth/register', '{bad')).status, 400);
    const a = await user('Alice');
    assert.equal((await req('POST', '/api/auth/register', { username: 'alice', password: 'password123' })).status, 409);
    const bo = await user('bob'); const v = await user('vic'); const x = await user('xen');
    assert.equal((await req('GET', '/api/auth/me')).status, 401);
    const me = await req('GET', '/api/auth/me', undefined, a.token);
    assert.deepEqual(Object.keys(me.body.user).sort(), ['displayName', 'id', 'username']);
    assert.equal(me.body.user.username, 'alice');

    const b = (await req('POST', '/api/boards', { name: 'B' }, a.token)).body;
    assert.deepEqual(b.columns.map((c) => c.name), ['To Do', 'In Progress', 'Done']);
    assert.equal((await req('POST', `/api/boards/${b.id}/members`, { username: 'bob', role: 'editor' }, a.token)).status, 201);
    assert.equal((await req('POST', `/api/boards/${b.id}/members`, { username: 'bob', role: 'editor' }, a.token)).status, 409);
    assert.equal((await req('POST', `/api/boards/${b.id}/members`, { username: 'nobody', role: 'editor' }, a.token)).status, 404);
    await req('POST', `/api/boards/${b.id}/members`, { username: 'vic', role: 'viewer' }, a.token);
    assert.equal((await req('GET', `/api/boards/${b.id}`, undefined, x.token)).status, 403);
    assert.equal((await req('GET', `/api/boards/nope`, undefined, x.token)).status, 404);
    assert.equal((await req('DELETE', `/api/boards/${b.id}/members/${a.id}`, undefined, a.token)).status, 400);

    const [c0, c1, c2] = b.columns;
    assert.equal((await req('POST', `/api/columns/${c0.id}/cards`, { title: 'x' }, v.token)).status, 403);
    const k1 = (await req('POST', `/api/columns/${c0.id}/cards`, { title: 'One', assignees: [bo.id], dueDate: '2026-01-05' }, bo.token)).body;
    const k2 = (await req('POST', `/api/columns/${c0.id}/cards`, { title: 'Two', description: 'hello World' }, bo.token)).body;
    const k3 = (await req('POST', `/api/columns/${c0.id}/cards`, { title: 'Zero', position: 0 }, bo.token)).body;
    assert.equal(k3.position, 0);
    assert.equal((await req('POST', `/api/columns/${c0.id}/cards`, { title: 'bad', assignees: [x.id] }, bo.token)).status, 400);
    assert.equal((await req('POST', `/api/columns/${c0.id}/cards`, { title: 'bad', dueDate: '2026-13-01' }, bo.token)).status, 400);

    const col = (await req('PATCH', `/api/columns/${c2.id}`, { wipLimit: 1 }, bo.token)).body;
    assert.equal(col.wipLimit, 1);
    assert.equal((await req('POST', `/api/cards/${k1.id}/move`, { columnId: c2.id }, bo.token)).status, 200);
    const w = await req('POST', `/api/cards/${k2.id}/move`, { columnId: c2.id }, bo.token);
    assert.equal(w.status, 409); assert.equal(w.body.error, 'wip_limit');
    assert.equal((await req('POST', `/api/columns/${c2.id}/cards`, { title: 'w' }, bo.token)).body.error, 'wip_limit');

    let full = (await req('GET', `/api/boards/${b.id}`, undefined, v.token)).body;
    assert.deepEqual(full.columns[0].cards.map((c) => [c.title, c.position]), [['Zero', 0], ['Two', 1]]);
    await req('POST', `/api/cards/${k2.id}/move`, { columnId: c0.id, position: 0 }, bo.token);
    full = (await req('GET', `/api/boards/${b.id}`, undefined, v.token)).body;
    assert.deepEqual(full.columns[0].cards.map((c) => c.title), ['Two', 'Zero']);

    const lab = await req('POST', `/api/boards/${b.id}/labels`, { name: 'Bug', color: '#ff0000' }, bo.token);
    assert.equal(lab.status, 201);
    assert.equal((await req('POST', `/api/boards/${b.id}/labels`, { name: 'bug', color: '#ff0000' }, bo.token)).status, 409);
    assert.equal((await req('POST', `/api/boards/${b.id}/labels`, { name: 'x', color: 'red' }, bo.token)).status, 400);
    const p = await req('PATCH', `/api/cards/${k2.id}`, { labels: [lab.body.id] }, bo.token);
    assert.equal(p.status, 200); assert.notEqual(p.body.updatedAt, k2.updatedAt);

    let s = (await req('GET', `/api/boards/${b.id}/cards?q=WORLD`, undefined, v.token)).body;
    assert.deepEqual(s.map((c) => c.id), [k2.id]);
    s = (await req('GET', `/api/boards/${b.id}/cards?due_before=2026-01-06`, undefined, v.token)).body;
    assert.deepEqual(s.map((c) => c.id), [k1.id]);
    s = (await req('GET', `/api/boards/${b.id}/cards?due_before=2026-01-05`, undefined, v.token)).body;
    assert.equal(s.length, 0);
    s = (await req('GET', `/api/boards/${b.id}/cards`, undefined, v.token)).body;
    assert.deepEqual(s.map((c) => c.title), ['Two', 'Zero', 'One']);

    await req('DELETE', `/api/labels/${lab.body.id}`, undefined, bo.token);
    assert.deepEqual((await req('GET', `/api/cards/${k2.id}`, undefined, v.token)).body.labels, []);

    const cm = await req('POST', `/api/cards/${k2.id}/comments`, { body: 'hi' }, bo.token);
    assert.equal(cm.status, 201);
    assert.equal((await req('POST', `/api/cards/${k2.id}/comments`, { body: 'hi' }, v.token)).status, 403);
    await req('POST', `/api/boards/${b.id}/members`, { username: 'xen', role: 'editor' }, a.token);
    assert.equal((await req('DELETE', `/api/comments/${cm.body.id}`, undefined, x.token)).status, 403);
    assert.equal((await req('DELETE', `/api/comments/${cm.body.id}`, undefined, a.token)).status, 204);

    assert.equal((await req('DELETE', `/api/columns/${c0.id}`, undefined, bo.token)).status, 409);
    assert.equal((await req('DELETE', `/api/columns/${c0.id}?force=true`, undefined, bo.token)).status, 204);
    full = (await req('GET', `/api/boards/${b.id}`, undefined, v.token)).body;
    assert.deepEqual(full.columns.map((c) => [c.id, c.position]), [[c1.id, 0], [c2.id, 1]]);
    await req('PATCH', `/api/columns/${c2.id}`, { position: -5 }, bo.token);
    full = (await req('GET', `/api/boards/${b.id}`, undefined, v.token)).body;
    assert.deepEqual(full.columns.map((c) => [c.id, c.position]), [[c2.id, 0], [c1.id, 1]]);

    const act = (await req('GET', `/api/boards/${b.id}/activity?limit=100`, undefined, v.token)).body;
    const types = new Set(act.map((e) => e.type));
    for (const t of ['board.created', 'column.created', 'card.created', 'card.updated', 'card.moved', 'comment.added', 'member.added']) assert.ok(types.has(t), t);
    const mv = act.find((e) => e.type === 'card.moved');
    assert.ok(mv.details.fromColumnId && mv.details.toColumnId);
    assert.equal((await req('GET', `/api/boards/${b.id}/activity?limit=2`, undefined, v.token)).body.length, 2);

    assert.equal((await req('GET', '/api/nope', undefined, a.token)).status, 404);
    const html = await fetch(base + '/');
    assert.match(html.headers.get('content-type'), /text\/html/);

    assert.equal((await req('POST', '/api/auth/logout', undefined, a.token)).status, 204);
    assert.equal((await req('GET', '/api/auth/me', undefined, a.token)).status, 401);
  } finally { srv.close(); }
});

test('login rate limit', async () => {
  const { srv, req } = await start();
  try {
    await req('POST', '/api/auth/register', { username: 'carol', password: 'password123' });
    for (let i = 0; i < 5; i++) assert.equal((await req('POST', '/api/auth/login', { username: 'carol', password: 'wrongwrong' })).status, 401);
    assert.equal((await req('POST', '/api/auth/login', { username: 'carol', password: 'password123' })).status, 429);
  } finally { srv.close(); }
});

test('persistence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-'));
  const file = path.join(dir, 'data.json');
  let s = await start({ dataFile: file });
  const u = await s.user('dave');
  const b = (await s.req('POST', '/api/boards', { name: 'P' }, u.token)).body;
  s.srv.close();
  assert.ok(!fs.readFileSync(file, 'utf8').includes('password123'));
  s = await start({ dataFile: file });
  const u2 = await s.user('dave');
  const r = await s.req('GET', `/api/boards/${b.id}`, undefined, u2.token);
  assert.equal(r.status, 200); assert.equal(r.body.columns.length, 3);
  s.srv.close();
  fs.rmSync(dir, { recursive: true });
});
