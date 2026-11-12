import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../../src/server.js';
import { createDocument } from '../../src/core/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(HERE, '..', '..', '.test-data-' + process.pid);

let server;
let base;
let tokens = {};

async function api(method, p, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: r.status, body: json, headers: r.headers, text };
}

function startServer() {
  server = createServer({ dataDir: DATA });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    base = `http://127.0.0.1:${server.address().port}`;
    resolve();
  }));
}

before(async () => {
  fs.rmSync(DATA, { recursive: true, force: true });
  await startServer();
  await api('POST', '/api/auth/register', { body: { username: 'alice', password: 'secret1' } });
  await api('POST', '/api/auth/register', { body: { username: 'bob', password: 'secret2' } });
  await api('POST', '/api/auth/register', { body: { username: 'carol', password: 'secret3' } });
  tokens.alice = (await api('POST', '/api/auth/login', { body: { username: 'alice', password: 'secret1' } })).body.token;
  tokens.bob = (await api('POST', '/api/auth/login', { body: { username: 'bob', password: 'secret2' } })).body.token;
  tokens.carol = (await api('POST', '/api/auth/login', { body: { username: 'carol', password: 'secret3' } })).body.token;
});

after(async () => {
  server.closeAllConnections();
  server.close();
  fs.rmSync(DATA, { recursive: true, force: true });
});

test('auth: register, login, errors', async () => {
  const r = await api('POST', '/api/auth/register', { body: { username: 'dan', password: 'secret4' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.username, 'dan');
  assert.equal((await api('POST', '/api/auth/register', { body: { username: 'dan', password: 'secret4' } })).status, 409);
  assert.equal((await api('POST', '/api/auth/login', { body: { username: 'dan', password: 'wrong!!' } })).status, 401);
  const ok = await api('POST', '/api/auth/login', { body: { username: 'dan', password: 'secret4' } });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
  assert.equal((await api('GET', '/api/docs')).status, 401);
  assert.equal((await api('POST', '/api/auth/register', { body: { username: 'x' } })).status, 400);
});

let docId;

test('documents: create, list, get, access control', async () => {
  const c = await api('POST', '/api/docs', { token: tokens.alice, body: { title: 'Plan' } });
  assert.equal(c.status, 201);
  docId = c.body.id;
  assert.equal(c.body.title, 'Plan');
  assert.equal(c.body.role, 'owner');
  const list = await api('GET', '/api/docs', { token: tokens.alice });
  assert.equal(list.status, 200);
  assert.ok(list.body.some((d) => d.id === docId));
  assert.equal((await api('GET', `/api/docs/${docId}`, { token: tokens.bob })).status, 403);
  assert.equal((await api('GET', '/api/docs/nope-nope', { token: tokens.alice })).status, 404);
  const g = await api('GET', `/api/docs/${docId}`, { token: tokens.alice });
  assert.equal(g.status, 200);
  assert.ok(Array.isArray(g.body.elements));
  assert.equal(g.body.title, 'Plan');
});

test('sharing: only owner can share; viewers cannot write', async () => {
  assert.equal(
    (await api('POST', `/api/docs/${docId}/share`, { token: tokens.bob, body: { username: 'bob', role: 'editor' } })).status,
    403,
  );
  assert.equal(
    (await api('POST', `/api/docs/${docId}/share`, { token: tokens.alice, body: { username: 'nobody', role: 'editor' } })).status,
    404,
  );
  assert.equal(
    (await api('POST', `/api/docs/${docId}/share`, { token: tokens.alice, body: { username: 'bob', role: 'admin' } })).status,
    400,
  );
  assert.equal(
    (await api('POST', `/api/docs/${docId}/share`, { token: tokens.alice, body: { username: 'bob', role: 'editor' } })).status,
    200,
  );
  assert.equal(
    (await api('POST', `/api/docs/${docId}/share`, { token: tokens.alice, body: { username: 'carol', role: 'viewer' } })).status,
    200,
  );
  assert.equal((await api('GET', `/api/docs/${docId}`, { token: tokens.carol })).status, 200);
});

const client = (actor) => createDocument({ id: docId, actor });

test('sync: editors post ops, viewers are refused, long poll returns new ops', async () => {
  const doc = client('alice-1');
  doc.apply({ type: 'add', element: { id: 'r1', type: 'rect', x: 0, y: 0, width: 100, height: 50, text: 'One' } });
  doc.apply({ type: 'add', element: { id: 'r2', type: 'rect', x: 300, y: 0, width: 100, height: 50 } });
  doc.apply({ type: 'add', element: { id: 'c1', type: 'connector', source: { elementId: 'r1' }, target: { elementId: 'r2' }, routing: 'orthogonal' } });
  const ops = doc.pendingOps();
  const bad = await api('POST', `/api/docs/${docId}/ops`, { token: tokens.carol, body: { ops } });
  assert.equal(bad.status, 403);
  const ok = await api('POST', `/api/docs/${docId}/ops`, { token: tokens.bob, body: { ops } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.seq, ops.length);
  const again = await api('POST', `/api/docs/${docId}/ops`, { token: tokens.bob, body: { ops } });
  assert.equal(again.body.seq, ops.length, 'duplicates are not logged twice');
  const got = await api('GET', `/api/docs/${docId}/ops?since=0`, { token: tokens.carol });
  assert.equal(got.body.ops.length, ops.length);
  assert.equal(got.body.seq, ops.length);
  const waiting = api('GET', `/api/docs/${docId}/ops?since=${ops.length}&wait=1`, { token: tokens.carol });
  await new Promise((r) => setTimeout(r, 50));
  await api('POST', `/api/docs/${docId}/ops`, {
    token: tokens.alice,
    body: { ops: [{ id: 'zz:1', actor: 'zz', clock: 1, type: 'update', writes: [{ e: 'el', i: 'r1', f: 'text', v: 'Two', s: [999, 'zz'] }] }] },
  });
  const w = await waiting;
  assert.equal(w.body.ops.length, 1);
  const snap = await api('GET', `/api/docs/${docId}`, { token: tokens.carol });
  assert.equal(snap.body.elements.find((e) => e.id === 'r1').text, 'Two');
  assert.equal(snap.body.elements.find((e) => e.id === 'c1').type, 'connector');
});

test('versions: save, list, restore', async () => {
  const v = await api('POST', `/api/docs/${docId}/versions`, { token: tokens.alice, body: { label: 'v1' } });
  assert.equal(v.status, 201);
  const vid = v.body.id;
  await api('POST', `/api/docs/${docId}/ops`, {
    token: tokens.alice,
    body: { ops: [{ id: 'zz:2', actor: 'zz', clock: 2, type: 'remove', writes: [{ e: 'el', i: 'r2', f: '__exists', v: false, s: [1000, 'zz'] }] }] },
  });
  assert.equal((await api('GET', `/api/docs/${docId}`, { token: tokens.alice })).body.elements.some((e) => e.id === 'r2'), false);
  const list = await api('GET', `/api/docs/${docId}/versions`, { token: tokens.carol });
  assert.equal(list.body[0].label, 'v1');
  const r = await api('POST', `/api/docs/${docId}/versions/${vid}/restore`, { token: tokens.alice });
  assert.equal(r.status, 200);
  const after = await api('GET', `/api/docs/${docId}`, { token: tokens.alice });
  assert.ok(after.body.elements.some((e) => e.id === 'r2'));
  assert.ok(after.body.elements.some((e) => e.id === 'c1'));
  assert.equal(after.body.elements.find((e) => e.id === 'r1').text, 'Two');
  assert.equal((await api('POST', `/api/docs/${docId}/versions/${vid}/restore`, { token: tokens.carol })).status, 403);
});

test('comments: anchored threads and resolve', async () => {
  const c = await api('POST', `/api/docs/${docId}/comments`, { token: tokens.carol, body: { elementId: 'r1', text: 'Looks good?' } });
  assert.equal(c.status, 201);
  const reply = await api('POST', `/api/docs/${docId}/comments`, { token: tokens.alice, body: { elementId: 'r1', text: 'Yes', parentId: c.body.id } });
  assert.equal(reply.body.parentId, c.body.id);
  const list = await api('GET', `/api/docs/${docId}/comments`, { token: tokens.bob });
  assert.equal(list.body.length, 2);
  const res = await api('POST', `/api/docs/${docId}/comments/${c.body.id}/resolve`, { token: tokens.alice });
  assert.equal(res.body.resolved, true);
  assert.equal((await api('POST', `/api/docs/${docId}/comments`, { token: tokens.alice, body: { elementId: 'r1' } })).status, 400);
});

test('exports: SVG and JSON', async () => {
  const svg = await api('GET', `/api/docs/${docId}/export.svg`, { token: tokens.alice });
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get('content-type'), /image\/svg\+xml/);
  assert.ok(svg.text.includes('data-id="r1"'));
  const json = await api('GET', `/api/docs/${docId}/export.json`, { token: tokens.alice });
  assert.equal(json.status, 200);
  assert.ok(json.body.layers.some((l) => l.id === 'default'));
});

test('websocket: handshake and relay of presence and ops', async () => {
  const port = server.address().port;
  const open = (token) =>
    new Promise((resolve, reject) => {
      const sock = net.connect(port, '127.0.0.1');
      const key = crypto.randomBytes(16).toString('base64');
      let buf = Buffer.alloc(0);
      const frames = [];
      let headerDone = false;
      sock.on('error', reject);
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        if (!headerDone) {
          const i = buf.indexOf('\r\n\r\n');
          if (i === -1) return;
          const head = buf.subarray(0, i).toString();
          if (!head.startsWith('HTTP/1.1 101')) return reject(new Error(head));
          headerDone = true;
          buf = buf.subarray(i + 4);
          resolve({ sock, frames, head });
        }
        while (buf.length >= 2) {
          const len = buf[1] & 0x7f;
          if (buf.length < 2 + len) break;
          frames.push(JSON.parse(buf.subarray(2, 2 + len).toString()));
          buf = buf.subarray(2 + len);
        }
      });
      sock.write(
        `GET /ws/docs/${docId}?token=${token} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
  const send = (sock, obj) => {
    const payload = Buffer.from(JSON.stringify(obj));
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
    const header = Buffer.from([0x81, 0x80 | payload.length]);
    sock.write(Buffer.concat([header, mask, masked]));
  };
  const a = await open(tokens.alice);
  const b = await open(tokens.bob);
  const sawHello = await waitFor(() => a.frames.find((f) => f.type === 'hello'));
  assert.ok(sawHello);
  send(b.sock, { type: 'presence', actor: 'bob-1', cursor: { x: 5, y: 6 }, selection: ['r1'] });
  const p = await waitFor(() => a.frames.find((f) => f.type === 'presence'));
  assert.equal(p.actor, 'bob-1');
  assert.deepEqual(p.cursor, { x: 5, y: 6 });
  a.sock.destroy();
  b.sock.destroy();
});

async function waitFor(fn, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  return null;
}

test('persistence: restart keeps documents, ops and users', async () => {
  // Upgraded WebSocket sockets keep close() from calling back; stopping listening is enough here.
  server.closeAllConnections();
  server.close();
  await startServer();
  const snap = await api('GET', `/api/docs/${docId}`, { token: tokens.alice });
  assert.equal(snap.status, 200);
  assert.ok(snap.body.elements.some((e) => e.id === 'r1'));
  const login = await api('POST', '/api/auth/login', { body: { username: 'alice', password: 'secret1' } });
  assert.equal(login.status, 200);
  const old = await api('GET', '/api/docs', { token: tokens.alice });
  assert.equal(old.status, 200);
  assert.ok(old.body.some((d) => d.id === docId));
});

test('delete is owner-only', async () => {
  assert.equal((await api('DELETE', `/api/docs/${docId}`, { token: tokens.bob })).status, 403);
  assert.equal((await api('DELETE', `/api/docs/${docId}`, { token: tokens.alice })).status, 200);
  assert.equal((await api('GET', `/api/docs/${docId}`, { token: tokens.alice })).status, 404);
});

test('static: index served at /', async () => {
  const r = await fetch(base + '/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /<title>diagram-s5<\/title>/);
  assert.equal((await fetch(base + '/static/app.css')).status, 200);
  assert.equal((await fetch(base + '/static/core/index.js')).status, 200);
  assert.equal((await fetch(base + '/static/%2e%2e/package.json')).status, 404);
});
