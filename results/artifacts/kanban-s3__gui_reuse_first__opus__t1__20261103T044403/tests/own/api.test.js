import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../../src/server.js';

async function start(opts) {
  const srv = createServer(opts); await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const req = async (method, p, body, t, raw) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: raw ?? (body == null ? undefined : JSON.stringify(body)) });
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
  const { srv, req, user, base } = await start();
  try {
    assert.equal((await req('POST', '/api/auth/register', { username: 'ab', password: 'password123' })).status, 400);
    assert.equal((await req('POST', '/api/auth/register', { username: 'abc', password: 'short' })).status, 400);
    assert.equal((await req('POST', '/api/auth/register', {}, null, '{bad')).status, 400);
    const a = await user('Alice'); const b = await user('bob'); const c = await user('carol');
    assert.equal((await req('POST', '/api/auth/register', { username: 'ALICE', password: 'password123' })).status, 409);
    assert.equal((await req('GET', '/api/auth/me', null, a.token)).body.user.username, 'alice');
    assert.equal((await req('GET', '/api/boards')).status, 401);
    assert.equal((await req('GET', '/api/nope', null, a.token)).status, 404);
    const board = (await req('POST', '/api/boards', { name: 'B' }, a.token)).body;
    assert.deepEqual(board.columns.map(c => c.name), ['To Do', 'In Progress', 'Done']);
    assert.equal((await req('GET', `/api/boards/${board.id}`, null, b.token)).status, 403);
    assert.equal((await req('GET', `/api/boards/xxx`, null, b.token)).status, 404);
    assert.equal((await req('POST', `/api/boards/${board.id}/members`, { username: 'bob', role: 'editor' }, a.token)).status, 201);
    assert.equal((await req('POST', `/api/boards/${board.id}/members`, { username: 'bob', role: 'editor' }, a.token)).status, 409);
    assert.equal((await req('POST', `/api/boards/${board.id}/members`, { username: 'zed', role: 'editor' }, a.token)).status, 404);
    assert.equal((await req('POST', `/api/boards/${board.id}/members`, { username: 'carol', role: 'viewer' }, a.token)).status, 201);
    const [todo, prog] = board.columns;
    assert.equal((await req('POST', `/api/columns/${todo.id}/cards`, { title: 'x' }, c.token)).status, 403);
    assert.equal((await req('PATCH', `/api/columns/${prog.id}`, { wipLimit: 1 }, b.token)).status, 200);
    const c1 = (await req('POST', `/api/columns/${todo.id}/cards`, { title: 'one', assignees: [b.id], dueDate: '2026-01-05' }, b.token)).body;
    const c2 = (await req('POST', `/api/columns/${todo.id}/cards`, { title: 'two', description: 'Hello World' }, b.token)).body;
    const c0 = (await req('POST', `/api/columns/${todo.id}/cards`, { title: 'zero', position: 0 }, b.token)).body;
    assert.equal(c0.position, 0);
    assert.equal((await req('POST', `/api/columns/${todo.id}/cards`, { title: 'bad', assignees: ['nobody'] }, b.token)).status, 400);
    let mv = await req('POST', `/api/cards/${c1.id}/move`, { columnId: prog.id }, b.token);
    assert.equal(mv.status, 200);
    mv = await req('POST', `/api/cards/${c2.id}/move`, { columnId: prog.id }, b.token);
    assert.equal(mv.status, 409); assert.equal(mv.body.error, 'wip_limit');
    assert.equal((await req('POST', `/api/columns/${prog.id}/cards`, { title: 't' }, b.token)).body.error, 'wip_limit');
    const full = (await req('GET', `/api/boards/${board.id}`, null, c.token)).body;
    assert.deepEqual(full.columns[0].cards.map(x => [x.title, x.position]), [['zero', 0], ['two', 1]]);
    const lab = (await req('POST', `/api/boards/${board.id}/labels`, { name: 'Bug', color: '#ff0000' }, b.token)).body;
    assert.equal((await req('POST', `/api/boards/${board.id}/labels`, { name: 'bug', color: '#ff0000' }, b.token)).status, 409);
    assert.equal((await req('POST', `/api/boards/${board.id}/labels`, { name: 'x', color: 'red' }, b.token)).status, 400);
    assert.equal((await req('PATCH', `/api/cards/${c2.id}`, { labels: [lab.id] }, b.token)).body.labels[0], lab.id);
    assert.equal((await req('GET', `/api/boards/${board.id}/cards?q=hello`, null, c.token)).body.length, 1);
    assert.equal((await req('GET', `/api/boards/${board.id}/cards?label=${lab.id}`, null, c.token)).body[0].id, c2.id);
    assert.equal((await req('GET', `/api/boards/${board.id}/cards?due_before=2026-01-06`, null, c.token)).body[0].id, c1.id);
    assert.equal((await req('GET', `/api/boards/${board.id}/cards?due_before=2026-01-05`, null, c.token)).body.length, 0);
    assert.equal((await req('DELETE', `/api/labels/${lab.id}`, null, b.token)).status, 204);
    assert.deepEqual((await req('GET', `/api/cards/${c2.id}`, null, c.token)).body.labels, []);
    const cm = (await req('POST', `/api/cards/${c1.id}/comments`, { body: 'hi' }, b.token)).body;
    assert.equal((await req('POST', `/api/cards/${c1.id}/comments`, { body: 'hi' }, c.token)).status, 403);
    assert.equal((await req('GET', `/api/cards/${c1.id}/comments`, null, c.token)).body.length, 1);
    assert.equal((await req('DELETE', `/api/comments/${cm.id}`, null, c.token)).status, 403);
    assert.equal((await req('DELETE', `/api/comments/${cm.id}`, null, a.token)).status, 204);
    const act = (await req('GET', `/api/boards/${board.id}/activity`, null, c.token)).body;
    const types = act.map(e => e.type);
    for (const t of ['board.created', 'column.created', 'card.created', 'card.updated', 'card.moved', 'comment.added', 'member.added']) assert.ok(types.includes(t), t);
    assert.equal(act.find(e => e.type === 'card.moved').details.toColumnId, prog.id);
    assert.equal((await req('GET', `/api/boards/${board.id}/activity?limit=2`, null, c.token)).body.length, 2);
    // column reorder + delete
    const cols = (await req('PATCH', `/api/columns/${todo.id}`, { position: 99 }, b.token)).body;
    assert.equal(cols.position, 2);
    assert.equal((await req('DELETE', `/api/columns/${todo.id}`, null, b.token)).status, 409);
    assert.equal((await req('DELETE', `/api/columns/${todo.id}?force=true`, null, b.token)).status, 204);
    const after = (await req('GET', `/api/boards/${board.id}`, null, a.token)).body;
    assert.deepEqual(after.columns.map(c => c.position), [0, 1]);
    // members
    assert.equal((await req('DELETE', `/api/boards/${board.id}/members/${a.id}`, null, a.token)).status, 400);
    assert.equal((await req('DELETE', `/api/boards/${board.id}/members/${c.id}`, null, b.token)).status, 403);
    assert.equal((await req('DELETE', `/api/boards/${board.id}/members/${c.id}`, null, c.token)).status, 204);
    assert.equal((await req('PATCH', `/api/boards/${board.id}`, { name: 'N' }, b.token)).status, 403);
    assert.equal((await req('DELETE', `/api/boards/${board.id}`, null, a.token)).status, 204);
    // UI
    const ui = await fetch(base + '/');
    assert.match(ui.headers.get('content-type'), /text\/html/);
    assert.equal((await fetch(base + '/static/app.js')).status, 200);
    assert.equal((await req('POST', '/api/auth/logout', null, a.token)).status, 204);
    assert.equal((await req('GET', '/api/auth/me', null, a.token)).status, 401);
  } finally { srv.close(); }
});

test('rate limiting', async () => {
  const { srv, req } = await start();
  try {
    await req('POST', '/api/auth/register', { username: 'dave', password: 'password123' });
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
  try {
    const a2 = await s.user('erin');
    assert.equal((await s.req('GET', `/api/boards/${board.id}`, null, a2.token)).body.name, 'P');
  } finally { s.srv.close(); fs.rmSync(dir, { recursive: true }); }
});
