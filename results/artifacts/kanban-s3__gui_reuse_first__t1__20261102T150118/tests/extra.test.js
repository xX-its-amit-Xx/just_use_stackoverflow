import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createServer } from '../src/server.js';
test('flow', async () => {
  const f = process.env.TMPDIR + '/k.json'; try { fs.unlinkSync(f); } catch {}
  const srv = createServer({ dataFile: f }); await new Promise(r => srv.listen(0, r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, b, t) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b ? JSON.stringify(b) : undefined }); return [r.status, r.status === 204 ? null : await r.json()]; };
  await call('POST', '/api/auth/register', { username: 'a', password: 'password1' }).then(([s]) => assert.equal(s, 400));
  await call('POST', '/api/auth/register', { username: 'alice', password: 'password1' });
  const [, { token }] = await call('POST', '/api/auth/login', { username: 'alice', password: 'password1' });
  const [, b] = await call('POST', '/api/boards', { name: 'B' }, token);
  const cols = b.columns;
  await call('PATCH', `/api/columns/${cols[1].id}`, { wipLimit: 1 }, token);
  const [s1, c1] = await call('POST', `/api/columns/${cols[0].id}/cards`, { title: 'x' }, token); assert.equal(s1, 201);
  const [, c2] = await call('POST', `/api/columns/${cols[0].id}/cards`, { title: 'y', position: 0 }, token);
  assert.equal((await call('POST', `/api/cards/${c1.id}/move`, { columnId: cols[1].id }, token))[0], 200);
  const [s3, e3] = await call('POST', `/api/cards/${c2.id}/move`, { columnId: cols[1].id }, token);
  assert.equal(s3, 409); assert.equal(e3.error, 'wip_limit');
  const [, full] = await call('GET', `/api/boards/${b.id}`, null, token);
  assert.equal(full.columns[0].cards[0].position, 0);
  const srv2 = createServer({ dataFile: f }); await new Promise(r => srv2.listen(0, r));
  assert.ok(!fs.readFileSync(f, 'utf8').includes('password1'));
  for (let i = 0; i < 5; i++) await call('POST', '/api/auth/login', { username: 'bob', password: 'zzzzzzzzz' });
  assert.equal((await call('POST', '/api/auth/login', { username: 'bob', password: 'zzzzzzzzz' }))[0], 429);
  srv.close(); srv2.close();
});
