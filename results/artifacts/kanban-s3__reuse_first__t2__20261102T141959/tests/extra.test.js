import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server.js';
test('cards move + wip', async () => {
  const srv = createServer(); await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, b, t) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b ? JSON.stringify(b) : undefined }); return [r.status, r.status === 204 ? null : await r.json()]; };
  await call('POST', '/api/auth/register', { username: 'bob', password: 'password123' });
  const [, { token }] = await call('POST', '/api/auth/login', { username: 'bob', password: 'password123' });
  const [, b] = await call('POST', '/api/boards', { name: 'B' }, token);
  await call('PATCH', `/api/columns/${b.columns[1].id}`, { wipLimit: 1 }, token);
  const [, c1] = await call('POST', `/api/columns/${b.columns[0].id}/cards`, { title: 'a' }, token);
  const [, c2] = await call('POST', `/api/columns/${b.columns[0].id}/cards`, { title: 'b' }, token);
  assert.equal((await call('POST', `/api/cards/${c1.id}/move`, { columnId: b.columns[1].id }, token))[0], 200);
  const [s, e] = await call('POST', `/api/cards/${c2.id}/move`, { columnId: b.columns[1].id }, token);
  assert.equal(s, 409); assert.equal(e.error, 'wip_limit');
  assert.equal((await call('GET', '/api/nope', null, token))[0], 404);
  srv.close();
});
