import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { createDocument } from '../src/core/index.js';

async function boot(dir) {
  const s = createServer({ dataDir: dir });
  await new Promise((r) => s.listen(0, r));
  const base = `http://127.0.0.1:${s.address().port}`;
  const call = async (method, p, body, token) => {
    const r = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
    return { status: r.status, body: j };
  };
  return { s, base, call };
}

test('server flow', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dg-'));
  let { s, base, call } = await boot(dir);
  assert.equal((await call('POST', '/api/auth/register', { username: 'al', password: 'pw' })).status, 201);
  assert.equal((await call('POST', '/api/auth/register', { username: 'al', password: 'pw' })).status, 409);
  await call('POST', '/api/auth/register', { username: 'bo', password: 'pw' });
  const ta = (await call('POST', '/api/auth/login', { username: 'al', password: 'pw' })).body.token;
  const tb = (await call('POST', '/api/auth/login', { username: 'bo', password: 'pw' })).body.token;
  assert.equal((await call('POST', '/api/auth/login', { username: 'al', password: 'x' })).status, 401);
  assert.equal((await call('GET', '/api/docs')).status, 401);
  const doc = (await call('POST', '/api/docs', { title: 'T' }, ta)).body;
  assert.equal((await call('GET', `/api/docs/${doc.id}`, null, tb)).status, 403);
  assert.equal((await call('POST', `/api/docs/${doc.id}/share`, { username: 'bo', role: 'viewer' }, ta)).status, 200);
  const c = createDocument({ id: doc.id, actor: 'cl' });
  c.apply({ type: 'add', element: { id: 'r1', type: 'rect', x: 1, y: 2, width: 3, height: 4 } });
  const ops = c.pendingOps();
  assert.equal((await call('POST', `/api/docs/${doc.id}/ops`, { ops }, tb)).status, 403);
  const ws = new WebSocket(`ws://127.0.0.1:${s.address().port}/ws/docs/${doc.id}?token=${tb}`);
  const got = [];
  ws.onmessage = (e) => got.push(JSON.parse(e.data));
  await new Promise((r) => (ws.onopen = r));
  const r1 = await call('POST', `/api/docs/${doc.id}/ops`, { ops }, ta);
  assert.equal(r1.body.seq, ops.length);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok(got.some((m) => m.type === 'ops'));
  ws.close();
  const v = (await call('POST', `/api/docs/${doc.id}/versions`, { label: 'v1' }, ta)).body;
  c.apply({ type: 'remove', id: 'r1' });
  await call('POST', `/api/docs/${doc.id}/ops`, { ops: c.pendingOps() }, ta);
  assert.equal((await call('GET', `/api/docs/${doc.id}`, null, ta)).body.elements.length, 0);
  await call('POST', `/api/docs/${doc.id}/versions/${v.id}/restore`, {}, ta);
  assert.equal((await call('GET', `/api/docs/${doc.id}`, null, ta)).body.elements.length, 1);
  const cm = await call('POST', `/api/docs/${doc.id}/comments`, { elementId: 'r1', text: 'hi' }, tb);
  assert.equal(cm.status, 201);
  assert.equal((await call('POST', `/api/docs/${doc.id}/comments/${cm.body.id}/resolve`, {}, ta)).body.resolved, true);
  const svg = await call('GET', `/api/docs/${doc.id}/export.svg`, null, ta);
  assert.match(svg.body, /<svg/);
  const poll = await call('GET', `/api/docs/${doc.id}/ops?since=0`, null, ta);
  assert.ok(poll.body.ops.length >= ops.length);
  s.close(); s.closeAllConnections?.();
  ({ s, base, call } = await boot(dir));
  assert.equal((await call('GET', `/api/docs/${doc.id}`, null, ta)).body.elements.length, 1);
  s.close(); s.closeAllConnections?.();
  assert.equal((await fetch(base + '/').catch(() => ({ status: 0 }))).status, 0);
});
