import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../../src/server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, '..', '..', `.test-data-${process.pid}`);
let server;
let base;

async function listen() {
  server = createServer({ dataDir });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
}

async function call(method, p, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + p, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const ct = res.headers.get('content-type') ?? '';
  const text = await res.text();
  return { status: res.status, body: ct.includes('json') && text ? JSON.parse(text) : text, headers: res.headers };
}

// Minimal RFC 6455 client used only in tests.
function wsConnect(p) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const sock = net.connect(port, '127.0.0.1');
    const key = crypto.randomBytes(16).toString('base64');
    let buf = Buffer.alloc(0);
    let headerDone = false;
    const messages = [];
    const waiters = [];
    const client = {
      messages,
      send(obj) {
        const payload = Buffer.from(JSON.stringify(obj));
        const mask = crypto.randomBytes(4);
        const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
        let header;
        if (payload.length < 126) header = Buffer.from([0x81, 0x80 | payload.length]);
        else { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(payload.length, 2); }
        sock.write(Buffer.concat([header, mask, masked]));
      },
      next(pred = () => true, timeout = 3000) {
        const found = messages.findIndex(pred);
        if (found >= 0) return Promise.resolve(messages.splice(found, 1)[0]);
        return new Promise((res, rej) => {
          const t = setTimeout(() => rej(new Error('timeout waiting for ws message')), timeout);
          waiters.push((m) => { if (pred(m)) { clearTimeout(t); res(m); return true; } return false; });
        });
      },
      close() { sock.end(); },
    };
    const deliver = (m) => {
      messages.push(m);
      for (const w of [...waiters]) {
        if (w(m)) { waiters.splice(waiters.indexOf(w), 1); messages.splice(messages.indexOf(m), 1); break; }
      }
    };
    sock.on('connect', () => {
      sock.write([
        `GET ${p} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Upgrade: websocket', 'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`, 'Sec-WebSocket-Version: 13', '', '',
      ].join('\r\n'));
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!headerDone) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = buf.subarray(0, idx).toString();
        headerDone = true;
        buf = buf.subarray(idx + 4);
        const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        if (!head.startsWith('HTTP/1.1 101') || !head.includes(accept)) return reject(new Error(head));
        resolve(client);
      }
      while (buf.length >= 2) {
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
        if (buf.length < off + len) break;
        const text = buf.subarray(off, off + len).toString();
        buf = buf.subarray(off + len);
        deliver(JSON.parse(text));
      }
    });
    sock.on('error', reject);
    client.statusFail = () => {};
  });
}

before(async () => { await listen(); });
after(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let owner;
let editor;
let viewer;
let docId;

test('auth: register, duplicate, login, token required', async () => {
  let r = await call('POST', '/api/auth/register', { body: { username: 'alice', password: 'secret1' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.username, 'alice');
  assert.equal((await call('POST', '/api/auth/register', { body: { username: 'alice', password: 'secret1' } })).status, 409);
  assert.equal((await call('POST', '/api/auth/register', { body: { username: 'x', password: 'short' } })).status, 400);
  await call('POST', '/api/auth/register', { body: { username: 'bob', password: 'secret2' } });
  await call('POST', '/api/auth/register', { body: { username: 'carol', password: 'secret3' } });
  r = await call('POST', '/api/auth/login', { body: { username: 'alice', password: 'wrong!!' } });
  assert.equal(r.status, 401);
  r = await call('POST', '/api/auth/login', { body: { username: 'alice', password: 'secret1' } });
  assert.equal(r.status, 200);
  owner = r.body.token;
  editor = (await call('POST', '/api/auth/login', { body: { username: 'bob', password: 'secret2' } })).body.token;
  viewer = (await call('POST', '/api/auth/login', { body: { username: 'carol', password: 'secret3' } })).body.token;
  assert.equal((await call('GET', '/api/docs')).status, 401);
  assert.equal((await call('GET', '/api/docs', { token: 'nope' })).status, 401);
});

test('documents: create, list, get, share, roles', async () => {
  let r = await call('POST', '/api/docs', { token: owner, body: { title: 'Plan' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.title, 'Plan');
  docId = r.body.id;
  r = await call('GET', '/api/docs', { token: owner });
  assert.equal(r.body.length, 1);
  assert.equal((await call('GET', `/api/docs/${docId}`, { token: viewer })).status, 404);
  assert.equal((await call('POST', `/api/docs/${docId}/share`, { token: owner, body: { username: 'bob', role: 'editor' } })).status, 200);
  assert.equal((await call('POST', `/api/docs/${docId}/share`, { token: owner, body: { username: 'carol', role: 'viewer' } })).status, 200);
  assert.equal((await call('POST', `/api/docs/${docId}/share`, { token: owner, body: { username: 'nobody', role: 'viewer' } })).status, 404);
  assert.equal((await call('POST', `/api/docs/${docId}/share`, { token: owner, body: { username: 'carol', role: 'boss' } })).status, 400);
  assert.equal((await call('POST', `/api/docs/${docId}/share`, { token: editor, body: { username: 'carol', role: 'viewer' } })).status, 403);
  r = await call('GET', `/api/docs/${docId}`, { token: viewer });
  assert.equal(r.status, 200);
  assert.equal(r.body.role, 'viewer');
  assert.equal(r.body.title, 'Plan');
  assert.ok(Array.isArray(r.body.elements));
  r = await call('GET', '/api/docs', { token: editor });
  assert.equal(r.body[0].role, 'editor');
});

const add = (id, x = 0) => ({ id: `op-${id}`, actor: 'A', clock: 1, op: { type: 'add', element: { id, type: 'rect', x, y: 0, width: 50, height: 40, style: {} } } });

test('ops: viewer forbidden, editor accepted, incremental sync', async () => {
  let r = await call('POST', `/api/docs/${docId}/ops`, { token: viewer, body: { ops: [add('r1')] } });
  assert.equal(r.status, 403);
  r = await call('POST', `/api/docs/${docId}/ops`, { token: editor, body: { ops: [add('r1'), add('r2', 100)] } });
  assert.equal(r.status, 200);
  assert.equal(r.body.seq, 2);
  r = await call('POST', `/api/docs/${docId}/ops`, { token: editor, body: { ops: [add('r1')] } });
  assert.equal(r.body.seq, 2); // duplicate ignored
  r = await call('POST', `/api/docs/${docId}/ops`, { token: editor, body: { ops: [{ id: 'bad', actor: 'A', clock: 2, op: { type: 'nope' } }] } });
  assert.equal(r.status, 400);
  r = await call('GET', `/api/docs/${docId}/ops?since=1`, { token: viewer });
  assert.equal(r.body.ops.length, 1);
  assert.equal(r.body.seq, 2);
  const doc = await call('GET', `/api/docs/${docId}`, { token: viewer });
  assert.deepEqual(doc.body.elements.map((e) => e.id).sort(), ['r1', 'r2']);
});

test('long-poll wakes up when ops arrive', async () => {
  const pending = call('GET', `/api/docs/${docId}/ops?since=2&wait=1`, { token: viewer });
  await new Promise((r) => setTimeout(r, 150));
  await call('POST', `/api/docs/${docId}/ops`, { token: editor, body: { ops: [add('r3', 5)] } });
  const r = await pending;
  assert.equal(r.body.ops.length, 1);
  assert.equal(r.body.seq, 3);
});

test('websocket: broadcast ops and presence, viewers cannot write', async () => {
  const ws1 = await wsConnect(`/ws/docs/${docId}?token=${editor}`);
  const ws2 = await wsConnect(`/ws/docs/${docId}?token=${viewer}`);
  assert.equal((await ws1.next((m) => m.type === 'hello')).role, 'editor');
  assert.equal((await ws2.next((m) => m.type === 'hello')).role, 'viewer');
  ws1.send({ type: 'ops', ops: [add('ws1')] });
  const got = await ws2.next((m) => m.type === 'ops');
  assert.equal(got.ops[0].op.element.id, 'ws1');
  ws2.send({ type: 'ops', ops: [add('nope')] });
  assert.equal((await ws2.next((m) => m.type === 'error')).message, 'viewers cannot edit');
  ws1.send({ type: 'presence', actor: 'A-actor', cursor: [1, 2], selection: ['r1'] });
  const p = await ws2.next((m) => m.type === 'presence');
  assert.equal(p.actor, 'A-actor');
  assert.deepEqual(p.cursor, [1, 2]);
  const r = await call('GET', `/api/docs/${docId}/ops?since=3`, { token: viewer });
  assert.equal(r.body.ops.length, 1);
  ws1.close(); ws2.close();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await call('POST', `/api/docs/${docId}/ops`, { token: editor, body: { ops: [add('after')] } })).status, 200);
});

test('versions: snapshot and restore', async () => {
  let r = await call('POST', `/api/docs/${docId}/versions`, { token: owner, body: { label: 'v1' } });
  assert.equal(r.status, 201);
  const vid = r.body.id;
  r = await call('POST', `/api/docs/${docId}/ops`, { token: editor, body: { ops: [{ id: 'del', actor: 'A', clock: 99, op: { type: 'remove', id: 'r1' } }] } });
  assert.equal(r.status, 200);
  r = await call('GET', `/api/docs/${docId}/versions`, { token: viewer });
  assert.equal(r.body[0].label, 'v1');
  assert.equal(r.body[0].snapshot, undefined);
  r = await call('POST', `/api/docs/${docId}/versions/${vid}/restore`, { token: viewer });
  assert.equal(r.status, 403);
  r = await call('POST', `/api/docs/${docId}/versions/${vid}/restore`, { token: editor });
  assert.equal(r.status, 200);
  const doc = await call('GET', `/api/docs/${docId}`, { token: viewer });
  assert.ok(doc.body.elements.some((e) => e.id === 'r1'));
});

test('comments: threads and resolve', async () => {
  let r = await call('POST', `/api/docs/${docId}/comments`, { token: viewer, body: { elementId: 'r2', body: 'looks good?' } });
  assert.equal(r.status, 201);
  const cid = r.body.id;
  r = await call('POST', `/api/docs/${docId}/comments`, { token: editor, body: { parentId: cid, body: 'yes' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.elementId, 'r2');
  r = await call('GET', `/api/docs/${docId}/comments?elementId=r2`, { token: owner });
  assert.equal(r.body.length, 1);
  assert.equal(r.body[0].replies.length, 1);
  r = await call('POST', `/api/docs/${docId}/comments/${cid}/resolve`, { token: owner, body: {} });
  assert.equal(r.body.resolved, true);
});

test('exports and delete', async () => {
  const svg = await call('GET', `/api/docs/${docId}/export.svg`, { token: owner });
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(svg.body, /<svg/);
  const json = await call('GET', `/api/docs/${docId}/export.json`, { token: owner });
  assert.equal(json.body.id, docId);
  assert.equal((await call('DELETE', `/api/docs/${docId}`, { token: editor })).status, 403);
});

test('restart keeps documents and their op log', async () => {
  const before = (await call('GET', `/api/docs/${docId}`, { token: owner })).body;
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await listen();
  const tok = (await call('POST', '/api/auth/login', { body: { username: 'alice', password: 'secret1' } })).body.token;
  const after = (await call('GET', `/api/docs/${docId}`, { token: tok })).body;
  assert.deepEqual(after.elements, before.elements);
  assert.equal(after.seq, before.seq);
  assert.equal((await call('GET', '/api/docs', { token: tok })).body.length, 1);
  assert.equal((await call('GET', '/', {})).status, 200);
});

test('static files and delete', async () => {
  const html = await call('GET', '/');
  assert.match(html.body, /diagram-s5/);
  assert.equal((await call('GET', '/static/app.js')).status, 200);
  assert.equal((await call('GET', '/static/core/index.js')).status, 200);
  assert.equal((await call('GET', '/static/../package.json')).status, 404);
  const created = (await call('POST', '/api/docs', { token: owner, body: { title: 'Tmp' } })).body;
  assert.equal((await call('DELETE', `/api/docs/${created.id}`, { token: owner })).status, 200);
  assert.equal((await call('GET', `/api/docs/${created.id}`, { token: owner })).status, 404);
});
