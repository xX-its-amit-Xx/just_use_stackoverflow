import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../../src/server.js';
test('workspace -> project -> issue key', async () => {
  const srv = createServer(); await new Promise(r => srv.listen(0, r)); const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, b, t) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b && JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  await call('POST', '/api/auth/register', { username: 'alice', password: 'password123' });
  const { token } = (await call('POST', '/api/auth/login', { username: 'alice', password: 'password123' })).body;
  const ws = (await call('POST', '/api/workspaces', { name: 'Acme', key: 'ACME' }, token)).body;
  const pr = (await call('POST', `/api/workspaces/${ws.id}/projects`, { name: 'Web', key: 'WEB' }, token)).body;
  const is = await call('POST', `/api/projects/${pr.id}/issues`, { type: 'task', title: 'Hello' }, token);
  assert.equal(is.status, 201); assert.equal(is.body.key, 'WEB-1');
  srv.close();
});
