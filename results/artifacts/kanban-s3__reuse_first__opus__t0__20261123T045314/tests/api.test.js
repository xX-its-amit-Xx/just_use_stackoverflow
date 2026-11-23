import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';

async function start(opts) {
  const srv = createServer(opts); await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const req = async (method, p, body, t) => {
    const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)) });
    const text = await res.text();
    return { status: res.status, body: text ? (res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text) : null, headers: res.headers };
  };
  const user = async (u) => { await req('POST', '/api/auth/register', { username: u, password: 'password123' }); const r = await req('POST', '/api/auth/login', { username: u, password: 'password123' }); return { token: r.body.token, id: r.body.user.id }; };
  return { srv, req, user, base };
}

test('full flow', async () => {
  const { srv, req, user } = await start();
  try {
    assert.equal((await req('POST', '/api/auth/register', { username: 'ab', password: 'password123' })).status, 400);
    assert.equal((await req('POST', '/api/auth/register', { username: 'Bob', password: 'short' })).status, 400);
    const a = await user('alice'); const b = await user('bob');
    assert.equal((await req('POST', '/api/auth/register', { username: 'ALICE', password: 'password123' })).status, 409);
    assert.equal((await req('GET', '/api/boards')).status, 401);
    assert.equal((await req('POST', '/api/boards', '{bad', a.token)).status, 400);
    const me = await req('GET', '/api/auth/me', undefined, a.token);
    assert.deepEqual(Object.keys(me.body.user).sort(), ['displayName', 'id', 'username']);
    const board = (await req('POST', '/api/boards', { name: 'B' }, a.token)).body;
    assert.equal(board.columns.length, 3);
    assert.equal((await req('GET', `/api/boards/${board.id}`, undefined, b.token)).status, 403);
    assert.equal((await req('GET', `/api/boards/nope`, undefined, b.token)).status, 404);
    assert.equal((await req('POST', `/api/boards/${board.id}/members`, { username: 'bob', role: 'viewer' }, a.token)).status, 201);
    assert.equal((await req('POST', `/api/boards/${board.id}/members`, { username: 'bob', role: 'viewer' }, a.token)).status, 409);
    const [c0, c1] = board.columns;
    assert.equal((await req('POST', `/api/columns/${c0.id}/cards`, { title: 'x' }, b.token)).status, 403);
    await req('PATCH', `/api/columns/${c1.id}`, { wipLimit: 1 }, a.token);
    const k1 = (await req('POST', `/api/columns/${c0.id}/cards`, { title: 'one', dueDate: '2030-01-01' }, a.token)).body;
    const k2 = (await req('POST', `/api/columns/${c0.id}/cards`, { title: 'two' }, a.token)).body;
    const k3 = (await req('POST', `/api/columns/${c0.id}/cards`, { title: 'zero', position: 0 }, a.token)).body;
    let bd = (await req('GET', `/api/boards/${board.id}`, undefined, a.token)).body;
    assert.deepEqual(bd.columns[0].cards.map(c => c.title), ['zero', 'one', 'two']);
    assert.equal((await req('POST', `/api/cards/${k1.id}/move`, { columnId: c1.id }, a.token)).status, 200);
    const w = await req('POST', `/api/cards/${k2.id}/move`, { columnId: c1.id }, a.token);
    assert.equal(w.status, 409); assert.equal(w.body.error, 'wip_limit');
    await req('POST', `/api/cards/${k2.id}/move`, { columnId: c0.id, position: 0 }, a.token);
    bd = (await req('GET', `/api/boards/${board.id}`, undefined, a.token)).body;
    assert.deepEqual(bd.columns[0].cards.map(c => [c.title, c.position]), [['two', 0], ['zero', 1]]);
    const lab = (await req('POST', `/api/boards/${board.id}/labels`, { name: 'Bug', color: '#ff0000' }, a.token)).body;
    assert.equal((await req('POST', `/api/boards/${board.id}/labels`, { name: 'bug', color: '#ff0000' }, a.token)).status, 409);
    assert.equal((await req('POST', `/api/boards/${board.id}/labels`, { name: 'x', color: 'red' }, a.token)).status, 400);
    await req('PATCH', `/api/cards/${k3.id}`, { labels: [lab.id], assignees: [b.id] }, a.token);
    assert.equal((await req('PATCH', `/api/cards/${k3.id}`, { assignees: ['zzz'] }, a.token)).status, 400);
    let s = (await req('GET', `/api/boards/${board.id}/cards?label=${lab.id}&assignee=${b.id}&q=ZER`, undefined, b.token)).body;
    assert.deepEqual(s.map(c => c.id), [k3.id]);
    s = (await req('GET', `/api/boards/${board.id}/cards?due_before=2030-01-02`, undefined, b.token)).body;
    assert.deepEqual(s.map(c => c.id), [k1.id]);
    await req('DELETE', `/api/labels/${lab.id}`, undefined, a.token);
    assert.deepEqual((await req('GET', `/api/cards/${k3.id}`, undefined, a.token)).body.labels, []);
    const cm = (await req('POST', `/api/cards/${k3.id}/comments`, { body: 'hi' }, a.token));
    assert.equal(cm.status, 201);
    assert.equal((await req('POST', `/api/cards/${k3.id}/comments`, { body: 'hi' }, b.token)).status, 403);
    assert.equal((await req('DELETE', `/api/comments/${cm.body.id}`, undefined, b.token)).status, 403);
    assert.equal((await req('DELETE', `/api/comments/${cm.body.id}`, undefined, a.token)).status, 204);
    assert.equal((await req('DELETE', `/api/columns/${c0.id}`, undefined, a.token)).status, 409);
    assert.equal((await req('DELETE', `/api/columns/${c0.id}?force=true`, undefined, a.token)).status, 204);
    bd = (await req('GET', `/api/boards/${board.id}`, undefined, a.token)).body;
    assert.deepEqual(bd.columns.map(c => c.position), [0, 1]);
    await req('PATCH', `/api/columns/${bd.columns[1].id}`, { position: -5 }, a.token);
    bd = (await req('GET', `/api/boards/${board.id}`, undefined, a.token)).body;
    assert.equal(bd.columns[0].name, 'Done');
    const act = (await req('GET', `/api/boards/${board.id}/activity?limit=100`, undefined, a.token)).body;
    for (const t of ['board.created', 'column.created', 'card.created', 'card.updated', 'card.moved', 'card.deleted', 'comment.added', 'member.added']) assert.ok(act.some(x => x.type === t), t);
    assert.equal(act[act.length - 1].type, 'board.created');
    assert.equal((await req('DELETE', `/api/boards/${board.id}/members/${a.id}`, undefined, a.token)).status, 400);
    assert.equal((await req('DELETE', `/api/boards/${board.id}/members/${b.id}`, undefined, b.token)).status, 204);
    assert.equal((await req('POST', '/api/auth/logout', undefined, a.token)).status, 204);
    assert.equal((await req('GET', '/api/auth/me', undefined, a.token)).status, 401);
    assert.equal((await req('GET', '/api/nothing', undefined, b.token)).status, 404);
    const ui = await req('GET', '/');
    assert.equal(ui.status, 200); assert.match(ui.headers.get('content-type'), /text\/html/);
  } finally { srv.close(); }
});

test('rate limit', async () => {
  const { srv, req, user } = await start();
  try {
    await user('carol');
    for (let i = 0; i < 5; i++) assert.equal((await req('POST', '/api/auth/login', { username: 'carol', password: 'wrongwrong' })).status, 401);
    assert.equal((await req('POST', '/api/auth/login', { username: 'carol', password: 'password123' })).status, 429);
  } finally { srv.close(); }
});

test('persistence', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-'));
  const dataFile = path.join(dir, 'd.json');
  let s = await start({ dataFile });
  const a = await s.user('dave');
  await s.req('POST', '/api/boards', { name: 'P' }, a.token);
  s.srv.close();
  assert.ok(!fs.readFileSync(dataFile, 'utf8').includes('password123'));
  s = await start({ dataFile });
  const l = await s.req('POST', '/api/auth/login', { username: 'dave', password: 'password123' });
  const boards = (await s.req('GET', '/api/boards', undefined, l.body.token)).body;
  assert.equal(boards[0].name, 'P');
  s.srv.close();
  fs.rmSync(dir, { recursive: true });
});
