import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.js';
import { createDocument } from '../src/core/index.js';

let dataDir;
let server;
let base;

const startServer = () =>
  new Promise((resolve) => {
    const s = createServer({ dataDir });
    s.listen(0, '127.0.0.1', () => resolve(s));
  });

async function call(method, url, { token, body, raw } = {}) {
  const res = await fetch(base + url, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (raw) return { status: res.status, text: await res.text(), headers: res.headers };
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function login(username) {
  await call('POST', '/api/auth/register', { body: { username, password: 'pw-' + username } });
  const r = await call('POST', '/api/auth/login', { body: { username, password: 'pw-' + username } });
  return r.body.token;
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-s5-test-'));
  server = await startServer();
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((r) => server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('auth: register, login, duplicate, bad credentials, missing token', async () => {
  const r = await call('POST', '/api/auth/register', { body: { username: 'alice', password: 'secret1' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.user.username, 'alice');
  assert.equal((await call('POST', '/api/auth/register', { body: { username: 'alice', password: 'x' } })).status, 409);
  const bad = await call('POST', '/api/auth/login', { body: { username: 'alice', password: 'nope' } });
  assert.equal(bad.status, 401);
  const ok = await call('POST', '/api/auth/login', { body: { username: 'alice', password: 'secret1' } });
  assert.equal(ok.status, 200);
  assert.ok(ok.body.token);
  assert.equal((await call('GET', '/api/docs')).status, 401);
  assert.equal((await call('GET', '/api/docs', { token: 'bogus' })).status, 401);
});

test('documents: create, list, get, permissions, share and delete', async () => {
  const owner = await login('owner1');
  const other = await login('other1');
  await call('POST', '/api/auth/register', { body: { username: 'viewer1', password: 'pw' } });
  const created = await call('POST', '/api/docs', { token: owner, body: { title: 'Plan' } });
  assert.equal(created.status, 201);
  const id = created.body.id;
  assert.equal(created.body.title, 'Plan');

  assert.equal((await call('GET', `/api/docs/${id}`, { token: other })).status, 404, 'non-member cannot read');

  const share = await call('POST', `/api/docs/${id}/share`, { token: owner, body: { username: 'other1', role: 'viewer' } });
  assert.equal(share.status, 200);
  assert.equal((await call('GET', `/api/docs/${id}`, { token: other })).status, 200);
  const list = await call('GET', '/api/docs', { token: other });
  assert.ok(list.body.docs.some((d) => d.id === id && d.role === 'viewer'));

  const denied = await call('POST', `/api/docs/${id}/ops`, { token: other, body: { ops: [] } });
  assert.equal(denied.status, 403, 'viewer cannot write');
  assert.equal((await call('POST', `/api/docs/${id}/share`, { token: other, body: { username: 'viewer1', role: 'viewer' } })).status, 403, 'viewer cannot share');
  assert.equal((await call('POST', `/api/docs/${id}/share`, { token: owner, body: { username: 'nobody', role: 'viewer' } })).status, 404);
  assert.equal((await call('POST', `/api/docs/${id}/share`, { token: owner, body: { username: 'other1', role: 'king' } })).status, 400);

  const snap = await call('GET', `/api/docs/${id}`, { token: owner });
  assert.equal(snap.body.role, 'owner');
  assert.ok(Array.isArray(snap.body.elements));
  assert.ok(Array.isArray(snap.body.layers));

  assert.equal((await call('DELETE', `/api/docs/${id}`, { token: other })).status, 403, 'viewer cannot delete');
  assert.equal((await call('DELETE', `/api/docs/${id}`, { token: owner })).status, 204);
  assert.equal((await call('GET', `/api/docs/${id}`, { token: owner })).status, 404);
});

test('sync: POST ops, GET ops since seq, idempotent and converging with a client replica', async () => {
  const token = await login('syncer');
  const id = (await call('POST', '/api/docs', { token, body: { title: 'Sync' } })).body.id;
  const client = createDocument({ id, actor: 'client-1' });
  client.apply({ type: 'add', element: { id: 'r1', type: 'rect', x: 0, y: 0, width: 10, height: 10 } });
  client.apply({ type: 'update', id: 'r1', patch: { x: 42 } });
  const ops = client.pendingOps();
  const sent = await call('POST', `/api/docs/${id}/ops`, { token, body: { ops } });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.seq, 1);
  const again = await call('POST', `/api/docs/${id}/ops`, { token, body: { ops } });
  assert.equal(again.status, 200);
  const snap = await call('GET', `/api/docs/${id}`, { token });
  assert.equal(snap.body.elements.find((e) => e.id === 'r1').x, 42);

  const got = await call('GET', `/api/docs/${id}/ops?since=0`, { token });
  assert.equal(got.body.ops.length, ops.length, 'duplicate batch is not logged twice');
  assert.equal(got.body.seq, 1);

  const waitPromise = call('GET', `/api/docs/${id}/ops?since=1&wait=1`, { token });
  setTimeout(() => {
    client.apply({ type: 'move', ids: ['r1'], dx: 1, dy: 0 });
    call('POST', `/api/docs/${id}/ops`, { token, body: { ops: client.pendingOps() } });
  }, 100);
  const polled = await waitPromise;
  assert.equal(polled.status, 200);
  assert.equal(polled.body.seq, 2);
  assert.ok(polled.body.ops.length > 0);
});

test('websocket: ops are broadcast to other clients and presence is relayed', async () => {
  const tokenA = await login('wsA');
  const tokenB = await login('wsB');
  const id = (await call('POST', '/api/docs', { token: tokenA, body: { title: 'WS' } })).body.id;
  await call('POST', `/api/docs/${id}/share`, { token: tokenA, body: { username: 'wsB', role: 'editor' } });
  const port = server.address().port;
  const open = (token) =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/docs/${id}?token=${token}`);
      ws.received = [];
      ws.onmessage = (ev) => ws.received.push(JSON.parse(ev.data));
      ws.onopen = () => resolve(ws);
      ws.onerror = reject;
    });
  const a = await open(tokenA);
  const b = await open(tokenB);
  const wait = (ws, pred) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), 3000);
      const check = () => {
        const m = ws.received.find(pred);
        if (m) {
          clearTimeout(t);
          resolve(m);
        } else setTimeout(check, 10);
      };
      check();
    });
  const client = createDocument({ id, actor: 'ws-client' });
  client.apply({ type: 'add', element: { id: 'w1', type: 'ellipse', x: 1, y: 1, width: 5, height: 5 } });
  a.send(JSON.stringify({ type: 'ops', ops: client.pendingOps() }));
  const msg = await wait(b, (m) => m.type === 'ops');
  assert.equal(msg.ops[0].op, 'create');
  await wait(a, (m) => m.type === 'ack');

  a.send(JSON.stringify({ type: 'presence', actor: 'alice-tab', cursor: { x: 3, y: 4 }, selection: ['w1'] }));
  const p = await wait(b, (m) => m.type === 'presence');
  assert.deepEqual(p.cursor, { x: 3, y: 4 });
  assert.equal(p.actor, 'alice-tab');
  a.close();
  b.close();
});

test('versions, restore and comments', async () => {
  const token = await login('versioner');
  const id = (await call('POST', '/api/docs', { token, body: { title: 'V' } })).body.id;
  const client = createDocument({ id, actor: 'v-client' });
  client.apply({ type: 'add', element: { id: 'keep', type: 'rect', x: 0, y: 0, width: 10, height: 10 } });
  await call('POST', `/api/docs/${id}/ops`, { token, body: { ops: client.pendingOps() } });
  const v = await call('POST', `/api/docs/${id}/versions`, { token, body: { label: 'first' } });
  assert.equal(v.status, 201);
  client.apply({ type: 'add', element: { id: 'extra', type: 'rect', x: 50, y: 50, width: 10, height: 10 } });
  client.apply({ type: 'remove', id: 'keep' });
  await call('POST', `/api/docs/${id}/ops`, { token, body: { ops: client.pendingOps() } });
  let snap = await call('GET', `/api/docs/${id}`, { token });
  assert.deepEqual(snap.body.elements.map((e) => e.id), ['extra']);
  const list = await call('GET', `/api/docs/${id}/versions`, { token });
  assert.equal(list.body.versions.length, 1);
  const restored = await call('POST', `/api/docs/${id}/versions/${v.body.id}/restore`, { token });
  assert.equal(restored.status, 200);
  snap = await call('GET', `/api/docs/${id}`, { token });
  assert.deepEqual(snap.body.elements.map((e) => e.id), ['keep']);

  const c = await call('POST', `/api/docs/${id}/comments`, { token, body: { text: 'Looks good', elementId: 'keep' } });
  assert.equal(c.status, 201);
  assert.equal((await call('POST', `/api/docs/${id}/comments`, { token, body: { text: 'x', elementId: 'ghost' } })).status, 404);
  const reply = await call('POST', `/api/docs/${id}/comments/${c.body.id}/replies`, { token, body: { text: 'Thanks' } });
  assert.equal(reply.status, 201);
  const resolved = await call('POST', `/api/docs/${id}/comments/${c.body.id}/resolve`, { token, body: { resolved: true } });
  assert.equal(resolved.body.resolved, true);
  const comments = await call('GET', `/api/docs/${id}/comments`, { token });
  assert.equal(comments.body.comments[0].replies.length, 1);
});

test('exports: SVG and JSON', async () => {
  const token = await login('exporter');
  const id = (await call('POST', '/api/docs', { token, body: { title: 'E' } })).body.id;
  const client = createDocument({ id, actor: 'e-client' });
  client.apply({ type: 'add', element: { id: 'a', type: 'rect', x: 0, y: 0, width: 10, height: 10 } });
  await call('POST', `/api/docs/${id}/ops`, { token, body: { ops: client.pendingOps() } });
  const svg = await call('GET', `/api/docs/${id}/export.svg`, { token, raw: true });
  assert.equal(svg.status, 200);
  assert.match(svg.headers.get('content-type'), /image\/svg\+xml/);
  assert.match(svg.text, /data-id="a"/);
  const json = await call('GET', `/api/docs/${id}/export.json`, { token, raw: true });
  assert.equal(JSON.parse(json.text).elements[0].id, 'a');
});

test('persistence: state survives a server restart', async () => {
  const token = await login('persist');
  const id = (await call('POST', '/api/docs', { token, body: { title: 'Persist' } })).body.id;
  const client = createDocument({ id, actor: 'p-client' });
  client.apply({ type: 'add', element: { id: 'keep-me', type: 'rect', x: 7, y: 8, width: 9, height: 9 } });
  await call('POST', `/api/docs/${id}/ops`, { token, body: { ops: client.pendingOps() } });
  await new Promise((r) => server.close(r));
  server = await startServer();
  base = `http://127.0.0.1:${server.address().port}`;
  const token2 = (await call('POST', '/api/auth/login', { body: { username: 'persist', password: 'pw-persist' } })).body.token;
  const snap = await call('GET', `/api/docs/${id}`, { token: token2 });
  assert.equal(snap.status, 200);
  assert.equal(snap.body.elements.find((e) => e.id === 'keep-me').x, 7);
  assert.equal(snap.body.seq, 1);
  assert.equal((await call('GET', `/api/docs/${id}/ops?since=0`, { token: token2 })).body.ops.length, 1);
});

test('static: editor page and core modules are served', async () => {
  const page = await call('GET', '/', { raw: true });
  assert.equal(page.status, 200);
  assert.match(page.text, /<html/);
  const core = await call('GET', '/static/core/index.js', { raw: true });
  assert.equal(core.status, 200);
  assert.equal((await call('GET', '/static/../package.json', { raw: true })).status, 404);
});
