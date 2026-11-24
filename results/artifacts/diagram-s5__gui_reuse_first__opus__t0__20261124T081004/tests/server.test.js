import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { createDocument } from '../src/core/index.js';

async function start(dataDir) {
  const server = createServer({ dataDir });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, url, body, token) => {
    const res = await fetch(base + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const ct = res.headers.get('content-type') || '';
    return { status: res.status, body: ct.includes('json') ? await res.json() : await res.text(), headers: res.headers };
  };
  return { server, base, call, close: () => new Promise(r => server.close(r)) };
}

async function user(call, name) {
  assert.equal((await call('POST', '/api/auth/register', { username: name, password: 'pw' })).status, 201);
  const r = await call('POST', '/api/auth/login', { username: name, password: 'pw' });
  assert.equal(r.status, 200);
  return r.body.token;
}

test('server end to end', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-'));
  let s = await start(dir);
  const alice = await user(s.call, 'alice');
  const bob = await user(s.call, 'bob');
  assert.equal((await s.call('POST', '/api/auth/register', { username: 'alice', password: 'x' })).status, 409);
  assert.equal((await s.call('POST', '/api/auth/login', { username: 'alice', password: 'bad' })).status, 401);
  assert.equal((await s.call('GET', '/api/docs')).status, 401);
  const created = await s.call('POST', '/api/docs', { title: 'T' }, alice);
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal((await s.call('GET', `/api/docs/${id}`, undefined, bob)).status, 403);
  assert.equal((await s.call('GET', `/api/docs/nope`, undefined, bob)).status, 404);

  const d = createDocument({ id, actor: 'a1' });
  d.apply({ type: 'add', element: { id: 'r1', type: 'rect', x: 0, y: 0, width: 10, height: 10, text: '<x>' } });
  d.apply({ type: 'add', element: { id: 'r2', type: 'ellipse', x: 50, y: 0, width: 10, height: 10 } });
  const post = await s.call('POST', `/api/docs/${id}/ops`, { ops: d.pendingOps() }, alice);
  assert.equal(post.status, 200); assert.equal(post.body.seq, 2);
  const g = await s.call('GET', `/api/docs/${id}`, undefined, alice);
  assert.equal(g.body.elements.length, 2); assert.equal(g.body.title, 'T');

  assert.equal((await s.call('POST', `/api/docs/${id}/share`, { username: 'bob', role: 'viewer' }, alice)).status, 200);
  assert.equal((await s.call('GET', `/api/docs/${id}`, undefined, bob)).status, 200);
  assert.equal((await s.call('POST', `/api/docs/${id}/ops`, { ops: [] }, bob)).status, 403);
  assert.equal((await s.call('DELETE', `/api/docs/${id}`, undefined, bob)).status, 403);

  // long poll
  const pending = s.call('GET', `/api/docs/${id}/ops?since=2&wait=1`, undefined, bob);
  await new Promise(r => setTimeout(r, 50));
  d.apply({ type: 'update', id: 'r1', patch: { x: 5 } });
  await s.call('POST', `/api/docs/${id}/ops`, { ops: d.pendingOps() }, alice);
  const lp = await pending;
  assert.equal(lp.body.ops.length, 1); assert.equal(lp.body.seq, 3);
  const b2 = createDocument({ id, actor: 'b' });
  b2.receive((await s.call('GET', `/api/docs/${id}/ops?since=0`, undefined, bob)).body.ops);
  assert.deepEqual(b2.toJSON(), d.toJSON());

  // websocket
  const wsA = new WebSocket(`${s.base.replace('http', 'ws')}/ws/docs/${id}?token=${alice}`);
  const wsB = new WebSocket(`${s.base.replace('http', 'ws')}/ws/docs/${id}?token=${bob}`);
  await Promise.all([wsA, wsB].map(w => new Promise((res, rej) => { w.onopen = res; w.onerror = rej; })));
  const gotPresence = new Promise(res => { wsB.onmessage = ev => { const m = JSON.parse(ev.data); if (m.type === 'presence') res(m); }; });
  wsA.send(JSON.stringify({ type: 'presence', actor: 'a1', cursor: { x: 1, y: 2 }, selection: ['r1'] }));
  const pm = await gotPresence;
  assert.equal(pm.actor, 'a1'); assert.deepEqual(pm.cursor, { x: 1, y: 2 }); assert.deepEqual(pm.selection, ['r1']);
  const gotOps = new Promise(res => { wsB.onmessage = ev => { const m = JSON.parse(ev.data); if (m.type === 'ops') res(m); }; });
  d.apply({ type: 'update', id: 'r2', patch: { y: 9 } });
  wsA.send(JSON.stringify({ type: 'ops', ops: d.pendingOps() }));
  const om = await gotOps;
  assert.equal(om.ops.length, 1); assert.equal(om.seq, 4);
  wsA.close(); wsB.close();

  // versions
  const v = await s.call('POST', `/api/docs/${id}/versions`, { label: 'v1' }, alice);
  assert.equal(v.status, 201);
  d.apply({ type: 'remove', id: 'r1' });
  await s.call('POST', `/api/docs/${id}/ops`, { ops: d.pendingOps() }, alice);
  assert.equal((await s.call('GET', `/api/docs/${id}`, undefined, alice)).body.elements.length, 1);
  const vs = await s.call('GET', `/api/docs/${id}/versions`, undefined, alice);
  assert.equal(vs.body.length, 1);
  assert.equal((await s.call('POST', `/api/docs/${id}/versions/${v.body.id}/restore`, {}, alice)).status, 200);
  assert.equal((await s.call('GET', `/api/docs/${id}`, undefined, alice)).body.elements.length, 2);

  // comments
  const c = await s.call('POST', `/api/docs/${id}/comments`, { elementId: 'r1', text: 'hi' }, bob);
  assert.equal(c.status, 201);
  assert.equal((await s.call('POST', `/api/docs/${id}/comments/${c.body.id}/replies`, { text: 'yo' }, alice)).status, 201);
  const rs = await s.call('POST', `/api/docs/${id}/comments/${c.body.id}/resolve`, {}, alice);
  assert.equal(rs.body.resolved, true);
  const cl = await s.call('GET', `/api/docs/${id}/comments`, undefined, alice);
  assert.equal(cl.body[0].replies.length, 1);

  // exports
  const svg = await s.call('GET', `/api/docs/${id}/export.svg`, undefined, alice);
  assert.match(svg.headers.get('content-type'), /svg/);
  assert.ok(svg.body.includes('data-id="r1"')); assert.ok(svg.body.includes('&lt;x&gt;'));
  const js = await s.call('GET', `/api/docs/${id}/export.json`, undefined, alice);
  assert.equal(js.body.elements.length, 2);
  const html = await s.call('GET', '/');
  assert.equal(html.status, 200);
  assert.equal((await s.call('GET', '/static/app.js')).status, 200);
  assert.equal((await s.call('GET', '/static/core/index.js')).status, 200);

  // restart safety
  const before = (await s.call('GET', `/api/docs/${id}`, undefined, alice)).body;
  await s.close();
  s = await start(dir);
  const after = await s.call('GET', `/api/docs/${id}`, undefined, alice);
  assert.equal(after.status, 200);
  assert.deepEqual(after.body.elements, before.elements);
  assert.equal(after.body.seq, before.seq);
  assert.equal((await s.call('GET', `/api/docs/${id}/comments`, undefined, bob)).body.length, 1);
  // high-level ops are accepted too
  const hl = await s.call('POST', `/api/docs/${id}/ops`, { ops: [{ type: 'add', element: { id: 'r9', type: 'rect' } }] }, alice);
  assert.equal(hl.status, 200);
  assert.equal((await s.call('POST', `/api/docs/${id}/ops`, { ops: [{ type: 'bogus' }] }, alice)).status, 400);
  assert.equal((await s.call('DELETE', `/api/docs/${id}`, undefined, alice)).status, 200);
  assert.equal((await s.call('GET', `/api/docs/${id}`, undefined, alice)).status, 404);
  await s.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
