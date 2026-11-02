import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path'; import fs from 'node:fs'; import os from 'node:os';
const APP = process.env.APP_DIR;
const { createServer } = await import(path.join(APP, 'src/server.js'));

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kb-')), 'data.json');
async function start(dataFile) {
  const srv = createServer({ dataFile }); await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const req = async (method, p, body, token, raw) => {
    const headers = {}; if (body !== undefined) headers['content-type'] = 'application/json'; if (token) headers.authorization = `Bearer ${token}`;
    const r = await fetch(base + p, { method, headers, body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text(); let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: r.status, body: json, headers: r.headers };
  };
  const user = async (username, password = 'password123') => {
    await req('POST', '/api/auth/register', { username, password });
    const r = await req('POST', '/api/auth/login', { username, password }); return { token: r.body.token, id: r.body.user.id, username };
  };
  return { srv, base, req, user, close: () => new Promise(r => { srv.closeAllConnections?.(); srv.close(r); }) };
}

let S, A, B, C, board;
before(async () => {
  S = await start(tmpFile());
  A = await S.user('alice'); B = await S.user('bob'); C = await S.user('carol');
  board = (await S.req('POST', '/api/boards', { name: 'Main', description: 'd' }, A.token)).body;
  await S.req('POST', `/api/boards/${board.id}/members`, { username: 'bob', role: 'editor' }, A.token);
  await S.req('POST', `/api/boards/${board.id}/members`, { username: 'carol', role: 'viewer' }, A.token);
});
after(async () => { await S.close(); });
const getBoard = async (id = board.id, t = A.token) => (await S.req('GET', `/api/boards/${id}`, undefined, t)).body;
const colId = async (i, id = board.id) => (await getBoard(id)).columns[i].id;

// ---- auth ----
test('register validation', async () => {
  assert.equal((await S.req('POST', '/api/auth/register', { username: 'ab', password: 'password123' })).status, 400);
  assert.equal((await S.req('POST', '/api/auth/register', { username: 'bad name', password: 'password123' })).status, 400);
  assert.equal((await S.req('POST', '/api/auth/register', { username: 'dave', password: 'short' })).status, 400);
  assert.equal((await S.req('POST', '/api/auth/register', { username: 'ALICE', password: 'password123' })).status, 409);
  const r = await S.req('POST', '/api/auth/register', { username: 'Erin_1', password: 'password123', displayName: 'Erin' });
  assert.equal(r.status, 201); assert.equal(r.body.user.username, 'erin_1'); assert.equal(r.body.user.displayName, 'Erin');
  assert.ok(!('password' in r.body.user) && !('passwordHash' in r.body.user));
});
test('invalid json -> 400', async () => { assert.equal((await S.req('POST', '/api/auth/register', undefined, null, '{nope')).status, 400); });
test('login, me, logout', async () => {
  assert.equal((await S.req('POST', '/api/auth/login', { username: 'alice', password: 'wrongpass1' })).status, 401);
  const u = await S.user('frank');
  const me = await S.req('GET', '/api/auth/me', undefined, u.token); assert.equal(me.status, 200); assert.equal(me.body.user.username, 'frank');
  assert.equal((await S.req('POST', '/api/auth/logout', undefined, u.token)).status, 204);
  assert.equal((await S.req('GET', '/api/auth/me', undefined, u.token)).status, 401);
});
test('auth required', async () => {
  assert.equal((await S.req('GET', '/api/boards')).status, 401);
  assert.equal((await S.req('GET', '/api/boards', undefined, 'garbage')).status, 401);
});
test('login rate limit', async () => {
  await S.user('gina');
  for (let i = 0; i < 5; i++) await S.req('POST', '/api/auth/login', { username: 'gina', password: 'nopenope' + i });
  assert.equal((await S.req('POST', '/api/auth/login', { username: 'gina', password: 'password123' })).status, 429);
});
test('error body shape and unknown route', async () => {
  const r = await S.req('GET', '/api/nothing-here', undefined, A.token); assert.equal(r.status, 404);
  assert.equal(typeof r.body.error, 'string'); assert.equal(typeof r.body.message, 'string');
});
// ---- boards ----
test('board created with default columns and owner', async () => {
  const b = await getBoard(); assert.equal(b.name, 'Main'); assert.equal(b.ownerId, A.id);
  assert.deepEqual(b.columns.map(c => c.name), ['To Do', 'In Progress', 'Done']); assert.deepEqual(b.columns.map(c => c.position), [0, 1, 2]);
  assert.ok(b.columns.every(c => Array.isArray(c.cards) && c.wipLimit == null));
  const roles = Object.fromEntries(b.members.map(m => [m.username, m.role])); assert.deepEqual(roles, { alice: 'owner', bob: 'editor', carol: 'viewer' });
});
test('custom columns and validation', async () => {
  const r = await S.req('POST', '/api/boards', { name: 'X', columns: ['A', 'B'] }, B.token); assert.equal(r.status, 201);
  assert.deepEqual((await getBoard(r.body.id, B.token)).columns.map(c => c.name), ['A', 'B']);
  assert.equal((await S.req('POST', '/api/boards', { name: '' }, B.token)).status, 400);
  assert.equal((await S.req('POST', '/api/boards', { name: 'x'.repeat(101) }, B.token)).status, 400);
});
test('list boards shows role', async () => {
  const r = await S.req('GET', '/api/boards', undefined, C.token); assert.equal(r.status, 200);
  const m = r.body.find(b => b.id === board.id); assert.equal(m.role, 'viewer'); assert.equal(m.name, 'Main');
});
test('non-member 403, unknown 404', async () => {
  const outsider = await S.user('henry');
  assert.equal((await S.req('GET', `/api/boards/${board.id}`, undefined, outsider.token)).status, 403);
  assert.equal((await S.req('GET', '/api/boards/does-not-exist', undefined, outsider.token)).status, 404);
  const col = await colId(0);
  assert.equal((await S.req('POST', `/api/columns/${col}/cards`, { title: 'x' }, outsider.token)).status, 403);
});
test('board settings owner only', async () => {
  assert.equal((await S.req('PATCH', `/api/boards/${board.id}`, { name: 'Hack' }, B.token)).status, 403);
  const r = await S.req('PATCH', `/api/boards/${board.id}`, { description: 'new' }, A.token); assert.equal(r.status, 200);
  assert.equal((await getBoard()).description, 'new');
});
test('members management', async () => {
  const b2 = (await S.req('POST', '/api/boards', { name: 'M' }, A.token)).body;
  assert.equal((await S.req('POST', `/api/boards/${b2.id}/members`, { username: 'nobody_here', role: 'editor' }, A.token)).status, 404);
  const add = await S.req('POST', `/api/boards/${b2.id}/members`, { username: 'bob', role: 'viewer' }, A.token);
  assert.equal(add.status, 201); assert.equal(add.body.userId, B.id);
  assert.equal((await S.req('POST', `/api/boards/${b2.id}/members`, { username: 'bob', role: 'viewer' }, A.token)).status, 409);
  assert.equal((await S.req('POST', `/api/boards/${b2.id}/members`, { username: 'carol', role: 'editor' }, B.token)).status, 403);
  assert.equal((await S.req('PATCH', `/api/boards/${b2.id}/members/${B.id}`, { role: 'editor' }, A.token)).status, 200);
  assert.equal((await getBoard(b2.id)).members.find(m => m.userId === B.id).role, 'editor');
  assert.equal((await S.req('DELETE', `/api/boards/${b2.id}/members/${A.id}`, undefined, A.token)).status, 400);
  assert.equal((await S.req('DELETE', `/api/boards/${b2.id}/members/${B.id}`, undefined, B.token)).status, 204);
  assert.equal((await S.req('GET', `/api/boards/${b2.id}`, undefined, B.token)).status, 403);
});
test('delete board owner only', async () => {
  const b2 = (await S.req('POST', '/api/boards', { name: 'Del' }, A.token)).body;
  await S.req('POST', `/api/boards/${b2.id}/members`, { username: 'bob', role: 'editor' }, A.token);
  assert.equal((await S.req('DELETE', `/api/boards/${b2.id}`, undefined, B.token)).status, 403);
  assert.equal((await S.req('DELETE', `/api/boards/${b2.id}`, undefined, A.token)).status, 204);
  assert.equal((await S.req('GET', `/api/boards/${b2.id}`, undefined, A.token)).status, 404);
});
// ---- columns ----
test('columns create, rename, reorder, wip', async () => {
  const b = (await S.req('POST', '/api/boards', { name: 'Cols', columns: ['a', 'b', 'c'] }, A.token)).body;
  const nc = await S.req('POST', `/api/boards/${b.id}/columns`, { name: 'd', wipLimit: 2 }, A.token);
  assert.equal(nc.status, 201); assert.equal(nc.body.position, 3); assert.equal(nc.body.wipLimit, 2);
  assert.equal((await S.req('POST', `/api/boards/${b.id}/columns`, { name: 'e', wipLimit: 0 }, A.token)).status, 400);
  assert.equal((await S.req('PATCH', `/api/columns/${nc.body.id}`, { position: 0, name: 'D' }, A.token)).status, 200);
  let cols = (await getBoard(b.id)).columns; assert.deepEqual(cols.map(c => c.name), ['D', 'a', 'b', 'c']); assert.deepEqual(cols.map(c => c.position), [0, 1, 2, 3]);
  await S.req('PATCH', `/api/columns/${cols[1].id}`, { position: 99 }, A.token);
  cols = (await getBoard(b.id)).columns; assert.deepEqual(cols.map(c => c.name), ['D', 'b', 'c', 'a']);
  assert.equal((await S.req('PATCH', `/api/columns/${cols[0].id}`, { wipLimit: null }, A.token)).status, 200);
  assert.equal((await getBoard(b.id)).columns[0].wipLimit, null);
});
test('viewer cannot mutate', async () => {
  const col = await colId(0);
  assert.equal((await S.req('POST', `/api/boards/${board.id}/columns`, { name: 'v' }, C.token)).status, 403);
  assert.equal((await S.req('POST', `/api/columns/${col}/cards`, { title: 'v' }, C.token)).status, 403);
  assert.equal((await S.req('GET', `/api/boards/${board.id}`, undefined, C.token)).status, 200);
});
test('delete column with cards', async () => {
  const b = (await S.req('POST', '/api/boards', { name: 'DC', columns: ['a', 'b', 'c'] }, A.token)).body;
  const cols = (await getBoard(b.id)).columns;
  const card = (await S.req('POST', `/api/columns/${cols[1].id}/cards`, { title: 't' }, A.token)).body;
  assert.equal((await S.req('DELETE', `/api/columns/${cols[1].id}`, undefined, A.token)).status, 409);
  assert.equal((await S.req('DELETE', `/api/columns/${cols[1].id}?force=true`, undefined, A.token)).status, 204);
  const after = (await getBoard(b.id)).columns; assert.deepEqual(after.map(c => c.name), ['a', 'c']); assert.deepEqual(after.map(c => c.position), [0, 1]);
  assert.equal((await S.req('GET', `/api/cards/${card.id}`, undefined, A.token)).status, 404);
  assert.equal((await S.req('DELETE', `/api/columns/${after[0].id}`, undefined, A.token)).status, 204);
});
// ---- cards ----
test('card create shape and defaults', async () => {
  const col = await colId(0);
  const r = await S.req('POST', `/api/columns/${col}/cards`, { title: 'First', description: 'desc', dueDate: '2030-01-02', assignees: [B.id] }, B.token);
  assert.equal(r.status, 201);
  const c = r.body; assert.equal(c.title, 'First'); assert.equal(c.columnId, col); assert.equal(c.boardId, board.id); assert.equal(c.createdBy, B.id);
  assert.deepEqual(c.assignees, [B.id]); assert.deepEqual(c.labels, []); assert.equal(c.dueDate, '2030-01-02'); assert.equal(typeof c.position, 'number');
  assert.ok(!Number.isNaN(Date.parse(c.createdAt)) && !Number.isNaN(Date.parse(c.updatedAt)));
});
test('card validation', async () => {
  const col = await colId(0); const outsider = await S.user('ivan');
  assert.equal((await S.req('POST', `/api/columns/${col}/cards`, { title: '' }, A.token)).status, 400);
  assert.equal((await S.req('POST', `/api/columns/${col}/cards`, { title: 'x'.repeat(201) }, A.token)).status, 400);
  assert.equal((await S.req('POST', `/api/columns/${col}/cards`, { title: 'x', dueDate: '2030-02-31' }, A.token)).status, 400);
  assert.equal((await S.req('POST', `/api/columns/${col}/cards`, { title: 'x', assignees: [outsider.id] }, A.token)).status, 400);
  assert.equal((await S.req('POST', `/api/columns/${col}/cards`, { title: 'x', labels: ['nolabel'] }, A.token)).status, 400);
  assert.equal((await S.req('POST', '/api/columns/nope/cards', { title: 'x' }, A.token)).status, 404);
});
test('card positions, insert, update, delete', async () => {
  const b = (await S.req('POST', '/api/boards', { name: 'Pos' }, A.token)).body; const col = (await getBoard(b.id)).columns[0].id;
  const mk = async (title, position) => (await S.req('POST', `/api/columns/${col}/cards`, { title, ...(position !== undefined ? { position } : {}) }, A.token)).body;
  const c1 = await mk('one'); const c2 = await mk('two'); await mk('zero', 0);
  let cards = (await getBoard(b.id)).columns[0].cards; assert.deepEqual(cards.map(c => c.title), ['zero', 'one', 'two']); assert.deepEqual(cards.map(c => c.position), [0, 1, 2]);
  const before = c1.updatedAt; await new Promise(r => setTimeout(r, 5));
  const up = await S.req('PATCH', `/api/cards/${c1.id}`, { title: 'ONE', dueDate: null }, A.token); assert.equal(up.status, 200); assert.equal(up.body.title, 'ONE');
  assert.ok(Date.parse(up.body.updatedAt) >= Date.parse(before));
  assert.equal((await S.req('GET', `/api/cards/${c1.id}`, undefined, A.token)).body.title, 'ONE');
  assert.equal((await S.req('DELETE', `/api/cards/${c2.id}`, undefined, A.token)).status, 204);
  assert.equal((await S.req('GET', `/api/cards/${c2.id}`, undefined, A.token)).status, 404);
});
test('wip limit on create and move', async () => {
  const b = (await S.req('POST', '/api/boards', { name: 'WIP', columns: ['a', 'b'] }, A.token)).body; const cols = (await getBoard(b.id)).columns;
  await S.req('PATCH', `/api/columns/${cols[1].id}`, { wipLimit: 1 }, A.token);
  assert.equal((await S.req('POST', `/api/columns/${cols[1].id}/cards`, { title: 'in' }, A.token)).status, 201);
  const full = await S.req('POST', `/api/columns/${cols[1].id}/cards`, { title: 'over' }, A.token); assert.equal(full.status, 409); assert.equal(full.body.error, 'wip_limit');
  const x = (await S.req('POST', `/api/columns/${cols[0].id}/cards`, { title: 'x' }, A.token)).body;
  const mv = await S.req('POST', `/api/cards/${x.id}/move`, { columnId: cols[1].id }, A.token); assert.equal(mv.status, 409); assert.equal(mv.body.error, 'wip_limit');
});
test('move cards within and across columns keeps contiguous order', async () => {
  const b = (await S.req('POST', '/api/boards', { name: 'Move', columns: ['a', 'b'] }, A.token)).body; const cols = (await getBoard(b.id)).columns;
  const ids = []; for (const t of ['c0', 'c1', 'c2', 'c3']) ids.push((await S.req('POST', `/api/columns/${cols[0].id}/cards`, { title: t }, A.token)).body.id);
  let r = await S.req('POST', `/api/cards/${ids[3]}/move`, { columnId: cols[0].id, position: 0 }, A.token); assert.equal(r.status, 200);
  let bd = await getBoard(b.id); assert.deepEqual(bd.columns[0].cards.map(c => c.title), ['c3', 'c0', 'c1', 'c2']);
  r = await S.req('POST', `/api/cards/${ids[0]}/move`, { columnId: cols[1].id, position: 0 }, A.token); assert.equal(r.status, 200); assert.equal(r.body.columnId, cols[1].id);
  await S.req('POST', `/api/cards/${ids[1]}/move`, { columnId: cols[1].id }, A.token);
  await S.req('POST', `/api/cards/${ids[2]}/move`, { columnId: cols[1].id, position: 1 }, A.token);
  bd = await getBoard(b.id);
  assert.deepEqual(bd.columns[0].cards.map(c => c.title), ['c3']); assert.deepEqual(bd.columns[0].cards.map(c => c.position), [0]);
  assert.deepEqual(bd.columns[1].cards.map(c => c.title), ['c0', 'c2', 'c1']); assert.deepEqual(bd.columns[1].cards.map(c => c.position), [0, 1, 2]);
  const other = (await S.req('POST', '/api/boards', { name: 'Other' }, A.token)).body; const oc = (await getBoard(other.id)).columns[0].id;
  assert.equal((await S.req('POST', `/api/cards/${ids[3]}/move`, { columnId: oc }, A.token)).status, 400);
});
// ---- labels ----
test('labels', async () => {
  const b = (await S.req('POST', '/api/boards', { name: 'Lab' }, A.token)).body; const col = (await getBoard(b.id)).columns[0].id;
  assert.equal((await S.req('POST', `/api/boards/${b.id}/labels`, { name: 'bug', color: 'red' }, A.token)).status, 400);
  const l = await S.req('POST', `/api/boards/${b.id}/labels`, { name: 'Bug', color: '#ff0000' }, A.token); assert.equal(l.status, 201);
  assert.deepEqual({ name: l.body.name, color: l.body.color, boardId: l.body.boardId }, { name: 'Bug', color: '#ff0000', boardId: b.id });
  assert.equal((await S.req('POST', `/api/boards/${b.id}/labels`, { name: 'bug', color: '#00ff00' }, A.token)).status, 409);
  const card = (await S.req('POST', `/api/columns/${col}/cards`, { title: 't', labels: [l.body.id] }, A.token)).body; assert.deepEqual(card.labels, [l.body.id]);
  assert.ok((await getBoard(b.id)).labels.some(x => x.id === l.body.id));
  assert.equal((await S.req('DELETE', `/api/labels/${l.body.id}`, undefined, A.token)).status, 204);
  assert.deepEqual((await S.req('GET', `/api/cards/${card.id}`, undefined, A.token)).body.labels, []);
});
// ---- comments ----
test('comments', async () => {
  const col = await colId(0); const card = (await S.req('POST', `/api/columns/${col}/cards`, { title: 'commented' }, A.token)).body;
  const c1 = await S.req('POST', `/api/cards/${card.id}/comments`, { body: 'first' }, B.token); assert.equal(c1.status, 201); assert.equal(c1.body.authorId, B.id);
  await S.req('POST', `/api/cards/${card.id}/comments`, { body: 'second' }, A.token);
  assert.equal((await S.req('POST', `/api/cards/${card.id}/comments`, { body: '' }, A.token)).status, 400);
  assert.equal((await S.req('POST', `/api/cards/${card.id}/comments`, { body: 'v' }, C.token)).status, 403);
  const list = await S.req('GET', `/api/cards/${card.id}/comments`, undefined, C.token); assert.deepEqual(list.body.map(c => c.body), ['first', 'second']);
  const c3 = (await S.req('POST', `/api/cards/${card.id}/comments`, { body: 'by alice' }, A.token)).body;
  assert.equal((await S.req('DELETE', `/api/comments/${c3.id}`, undefined, B.token)).status, 403);
  assert.equal((await S.req('DELETE', `/api/comments/${c1.body.id}`, undefined, A.token)).status, 204);
  assert.equal((await S.req('DELETE', `/api/comments/${c3.id}`, undefined, A.token)).status, 204);
  assert.deepEqual((await S.req('GET', `/api/cards/${card.id}/comments`, undefined, A.token)).body.map(c => c.body), ['second']);
});
// ---- search ----
test('search filters', async () => {
  const b = (await S.req('POST', '/api/boards', { name: 'Search', columns: ['a', 'b'] }, A.token)).body;
  await S.req('POST', `/api/boards/${b.id}/members`, { username: 'bob', role: 'editor' }, A.token);
  const cols = (await getBoard(b.id)).columns; const lab = (await S.req('POST', `/api/boards/${b.id}/labels`, { name: 'ui', color: '#123456' }, A.token)).body;
  const mk = (col, body) => S.req('POST', `/api/columns/${col}/cards`, body, A.token).then(r => r.body);
  const k1 = await mk(cols[1].id, { title: 'Fix login bug', assignees: [B.id], dueDate: '2030-01-10' });
  const k2 = await mk(cols[0].id, { title: 'Write docs', description: 'Login page docs', labels: [lab.id], dueDate: '2030-03-01' });
  const k3 = await mk(cols[0].id, { title: 'Refactor', assignees: [B.id] });
  const q = async qs => (await S.req('GET', `/api/boards/${b.id}/cards?${qs}`, undefined, A.token)).body.map(c => c.id);
  assert.deepEqual(await q('q=LOGIN'), [k2.id, k1.id]);
  assert.deepEqual(await q(`assignee=${B.id}`), [k3.id, k1.id]);
  assert.deepEqual(await q(`label=${lab.id}`), [k2.id]);
  assert.deepEqual(await q(`column=${cols[0].id}`), [k2.id, k3.id]);
  assert.deepEqual(await q('due_before=2030-02-01'), [k1.id]);
  assert.deepEqual(await q(`q=login&assignee=${B.id}`), [k1.id]);
});
// ---- activity ----
test('activity log', async () => {
  const b = (await S.req('POST', '/api/boards', { name: 'Act', columns: ['a', 'b'] }, A.token)).body; const cols = (await getBoard(b.id)).columns;
  await S.req('POST', `/api/boards/${b.id}/members`, { username: 'bob', role: 'editor' }, A.token);
  await S.req('POST', `/api/boards/${b.id}/columns`, { name: 'c' }, A.token);
  const card = (await S.req('POST', `/api/columns/${cols[0].id}/cards`, { title: 't' }, B.token)).body;
  await S.req('PATCH', `/api/cards/${card.id}`, { title: 't2' }, B.token);
  await S.req('POST', `/api/cards/${card.id}/move`, { columnId: cols[1].id }, B.token);
  await S.req('POST', `/api/cards/${card.id}/comments`, { body: 'hi' }, B.token);
  await S.req('DELETE', `/api/cards/${card.id}`, undefined, A.token);
  const act = (await S.req('GET', `/api/boards/${b.id}/activity`, undefined, A.token)).body;
  const types = act.map(a => a.type);
  for (const t of ['board.created', 'member.added', 'column.created', 'card.created', 'card.updated', 'card.moved', 'comment.added', 'card.deleted']) assert.ok(types.includes(t), t);
  assert.equal(types[0], 'card.deleted'); assert.equal(act[0].actorId, A.id);
  const mv = act.find(a => a.type === 'card.moved'); assert.equal(mv.details.fromColumnId, cols[0].id); assert.equal(mv.details.toColumnId, cols[1].id); assert.equal(mv.cardId, card.id);
  assert.equal((await S.req('GET', `/api/boards/${b.id}/activity?limit=2`, undefined, A.token)).body.length, 2);
});
// ---- persistence ----
test('persistence across restart and hashed passwords', async () => {
  const f = tmpFile(); const s1 = await start(f); const u = await s1.user('pat', 'supersecret99');
  const bd = (await s1.req('POST', '/api/boards', { name: 'Persist' }, u.token)).body; const col = (await s1.req('GET', `/api/boards/${bd.id}`, undefined, u.token)).body.columns[0].id;
  await s1.req('POST', `/api/columns/${col}/cards`, { title: 'survives' }, u.token); await s1.close();
  const raw = fs.readFileSync(f, 'utf8'); assert.ok(!raw.includes('supersecret99'));
  const s2 = await start(f);
  const login = await s2.req('POST', '/api/auth/login', { username: 'pat', password: 'supersecret99' }); assert.equal(login.status, 200);
  const b2 = (await s2.req('GET', `/api/boards/${bd.id}`, undefined, login.body.token)).body; assert.equal(b2.columns[0].cards[0].title, 'survives');
  await s2.close();
});
// ---- UI ----
test('web UI served', async () => {
  const r = await fetch(S.base + '/'); assert.equal(r.status, 200); assert.match(r.headers.get('content-type') || '', /text\/html/);
  const html = await r.text(); assert.match(html, /<html/i);
  const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]);
  let js = html; for (const s of scripts) js += await (await fetch(new URL(s, S.base + '/'))).text();
  assert.match(js, /\/api\/auth\/login/); assert.match(js, /\/api\/boards/); assert.match(js, /move/);
});
