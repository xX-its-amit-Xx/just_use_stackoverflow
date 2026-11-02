import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../src/server.js';
test('register + login + create board', async () => {
  const srv = createServer(); await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const post = (p, b, t) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: JSON.stringify(b) });
  assert.equal((await post('/api/auth/register', { username: 'alice', password: 'password123' })).status, 201);
  const { token } = await (await post('/api/auth/login', { username: 'alice', password: 'password123' })).json();
  const res = await post('/api/boards', { name: 'B' }, token);
  assert.equal(res.status, 201);
  srv.close();
});
