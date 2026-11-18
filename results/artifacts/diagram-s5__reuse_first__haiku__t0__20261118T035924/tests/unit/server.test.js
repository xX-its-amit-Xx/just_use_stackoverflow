import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { createServer } from '../../src/server.js';
import { createDocument } from '../../src/core/index.js';

let dir, srv, base;
const call = async (method, p, body, token) => {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-s5-test-'));
  srv = createServer({ dataDir: dir });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
});

after(() => {
  srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('auth: register, login, error codes', async () => {
  assert.equal((await call('POST', '/api/auth/register', { username: 'alice', password: 'secret1' })).status, 201);
  assert.equal((await call('POST', '/api/auth/register', { username: 'alice', password: 'secret1' })).status, 409);
  assert.equal((await call('POST', '/api/auth/register', { username: 'x', password: 'secret1' })).status, 400);
  assert.equal((await call('POST', '/api/auth/login', { username: 'alice', password: 'wrong' })).status, 401);
  const login = await call('POST', '/api/auth/login', { username: 'alice', password: 'secret1' });
  assert.equal(login.status, 200);
  assert.ok(login.body.token);
  assert.equal((await call('GET', '/api/docs')).status, 401);
});

test('documents, sharing and roles', async () => {
  await call('POST', '/api/auth/register', { username: 'bobby', password: 'secret1' });
  const alice = (await call('POST', '/api/auth/login', { username: 'alice', password: 'secret1' })).body.token;
  const bob = (await call('POST', '/api/auth/login', { username: 'bobby', password: 'secret1' })).body.token;
  const created = await call('POST', '/api/docs', { title: 'Plan' }, alice);
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal((await call('GET', `/api/docs/${id}`, undefined, bob)).status, 404);
  assert.equal((await call('POST', `/api/docs/${id}/share`, { username: 'bobby', role: 'viewer' }, alice)).status, 200);
  assert.equal((await call('GET', `/api/docs/${id}`, undefined, bob)).status, 200);
  const viewerOps = await call('POST', `/api/docs/${id}/ops`, { ops: [{ type: 'add', element: { id: 'v', type: 'rect' } }] }, bob);
  assert.equal(viewerOps.status, 403);
  assert.equal((await call('POST', `/api/docs/${id}/share`, { username: 'bobby', role: 'editor' }, bob)).status, 403);
  assert.equal((await call('POST', `/api/docs/${id}/share`, { username: 'nobody', role: 'editor' }, alice)).status, 404);
  assert.equal((await call('DELETE', `/api/docs/${id}`, undefined, bob)).status, 403);
  const list = await call('GET', '/api/docs', undefined, bob);
  assert.ok(list.body.some((d) => d.id === id && d.role === 'viewer'));
  const got = await call('GET', `/api/docs/${id}`, undefined, alice);
  assert.equal(got.body.title, 'Plan');
  assert.deepEqual(got.body.elements, []);
  assert.equal((await call('DELETE', `/api/docs/${id}`, undefined, alice)).status, 200);
  assert.equal((await call('GET', `/api/docs/${id}`, undefined, alice)).status, 404);
});

test('ops: public operations and replicated batches; long-poll; exports', async () => {
  const alice = (await call('POST', '/api/auth/login', { username: 'alice', password: 'secret1' })).body.token;
  const id = (await call('POST', '/api/docs', { title: 'Ops' }, alice)).body.id;
  const pub = await call('POST', `/api/docs/${id}/ops`, { ops: [{ type: 'add', element: { id: 'r1', type: 'rect', x: 1, y: 2, width: 3, height: 4 } }] }, alice);
  assert.deepEqual(pub.body, { seq: 1 });
  const bad = await call('POST', `/api/docs/${id}/ops`, { ops: [{ type: 'move', ids: ['nope'], dx: 1, dy: 1 }] }, alice);
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, 'DiagramError');

  const client = createDocument({ id, actor: 'client-1' });
  client.apply({ type: 'add', element: { id: 'r2', type: 'ellipse', x: 50, y: 50, width: 20, height: 20 } });
  const batch = await call('POST', `/api/docs/${id}/ops`, { ops: client.pendingOps() }, alice);
  assert.equal(batch.body.seq, 2);
  const since = await call('GET', `/api/docs/${id}/ops?since=0`, undefined, alice);
  assert.equal(since.body.ops.length, 2);

  const waiting = call('GET', `/api/docs/${id}/ops?since=2&wait=1`, undefined, alice);
  setTimeout(() => call('POST', `/api/docs/${id}/ops`, { ops: [{ type: 'update', id: 'r1', patch: { text: 'hi' } }] }, alice), 200);
  const woke = await waiting;
  assert.equal(woke.body.ops.length, 1);
  assert.equal(woke.body.ops[0].seq, 3);

  const svg = await fetch(`${base}/api/docs/${id}/export.svg`, { headers: { authorization: `Bearer ${alice}` } });
  assert.match(svg.headers.get('content-type'), /image\/svg\+xml/);
  assert.ok((await svg.text()).includes('data-id="r1"'));
  const json = await call('GET', `/api/docs/${id}/export.json`, undefined, alice);
  assert.equal(json.body.elements.length, 2);
});

test('versions, restore, comments and resolve', async () => {
  const alice = (await call('POST', '/api/auth/login', { username: 'alice', password: 'secret1' })).body.token;
  const id = (await call('POST', '/api/docs', { title: 'Versions' }, alice)).body.id;
  await call('POST', `/api/docs/${id}/ops`, { ops: [{ type: 'add', element: { id: 'a', type: 'rect', x: 0, y: 0, width: 5, height: 5 } }] }, alice);
  const v = await call('POST', `/api/docs/${id}/versions`, { label: 'v1' }, alice);
  assert.equal(v.status, 201);
  await call('POST', `/api/docs/${id}/ops`, { ops: [{ type: 'remove', id: 'a' }] }, alice);
  assert.equal((await call('GET', `/api/docs/${id}`, undefined, alice)).body.elements.length, 0);
  assert.equal((await call('POST', `/api/docs/${id}/versions/${v.body.id}/restore`, undefined, alice)).status, 200);
  assert.deepEqual((await call('GET', `/api/docs/${id}`, undefined, alice)).body.elements.map((e) => e.id), ['a']);
  assert.equal((await call('GET', `/api/docs/${id}/versions`, undefined, alice)).body.length, 1);

  const c = await call('POST', `/api/docs/${id}/comments`, { elementId: 'a', body: 'check' }, alice);
  assert.equal(c.status, 201);
  assert.equal((await call('POST', `/api/docs/${id}/comments/${c.body.id}/replies`, { body: 'ok' }, alice)).status, 201);
  const resolved = await call('POST', `/api/docs/${id}/comments/${c.body.id}/resolve`, {}, alice);
  assert.equal(resolved.body.resolved, true);
  const list = await call('GET', `/api/docs/${id}/comments`, undefined, alice);
  assert.equal(list.body[0].replies.length, 1);
});

test('websocket: handshake, ops ack, broadcast and presence', async () => {
  const alice = (await call('POST', '/api/auth/login', { username: 'alice', password: 'secret1' })).body.token;
  const id = (await call('POST', '/api/docs', { title: 'WS' }, alice)).body.id;
  const connect = () => {
    const sock = net.connect(srv.address().port, '127.0.0.1');
    const chunks = [];
    sock.on('data', (c) => chunks.push(c));
    sock.write(`GET /ws/docs/${id}?token=${alice} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${crypto.randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    return { sock, text: () => Buffer.concat(chunks).toString('utf8') };
  };
  const send = (sock, obj) => {
    const p = Buffer.from(JSON.stringify(obj));
    const mask = crypto.randomBytes(4);
    const head = p.length < 126 ? Buffer.from([0x81, 0x80 | p.length]) : Buffer.from([0x81, 0x80 | 126, p.length >> 8, p.length & 255]);
    sock.write(Buffer.concat([head, mask, Buffer.from(p.map((b, i) => b ^ mask[i % 4]))]));
  };
  const a = connect(), b = connect();
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(a.text().startsWith('HTTP/1.1 101') || a.text().includes('101 Switching'));
  const c1 = createDocument({ id, actor: 'ws-client' });
  for (let i = 0; i < 3; i++) c1.apply({ type: 'add', element: { id: `n${i}`, type: 'rect', x: i, y: i, width: 30, height: 30, text: 'a fairly long label that makes the frame payload exceed one hundred and twenty six bytes '.repeat(1) + i } });
  send(a.sock, { type: 'ops', ops: c1.pendingOps(), ackId: 9 });
  send(b.sock, { type: 'presence', cursor: [4, 5], selection: ['n0'] });
  await new Promise((r) => setTimeout(r, 200));
  assert.ok(a.text().includes('"type":"ack"') && a.text().includes('"ackId":9'));
  assert.ok(b.text().includes('"type":"ops"'));
  assert.ok(a.text().includes('"type":"presence"'));
  const doc = (await call('GET', `/api/docs/${id}`, undefined, alice)).body;
  assert.equal(doc.elements.length, 3);
  a.sock.destroy(); b.sock.destroy();
});

test('state survives a restart', async () => {
  const alice = (await call('POST', '/api/auth/login', { username: 'alice', password: 'secret1' })).body.token;
  const id = (await call('POST', '/api/docs', { title: 'Durable' }, alice)).body.id;
  await call('POST', `/api/docs/${id}/ops`, { ops: [{ type: 'add', element: { id: 'keep', type: 'diamond', x: 1, y: 1, width: 2, height: 2 } }] }, alice);
  srv.close();
  srv = createServer({ dataDir: dir });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}`;
  const after = await call('GET', `/api/docs/${id}`, undefined, alice);
  assert.equal(after.status, 200);
  assert.ok(after.body.elements.some((e) => e.id === 'keep'));
  assert.equal(after.body.seq, 1);
});
