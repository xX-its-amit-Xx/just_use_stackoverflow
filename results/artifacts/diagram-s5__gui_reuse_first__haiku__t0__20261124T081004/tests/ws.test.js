import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { createServer } from '../src/server.js';
import { FrameParser, acceptKey } from '../src/ws.js';

let dataDir, server, port;
const openSockets = [];

async function post(p, body, token) {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, data: await r.json() };
}

// Minimal WS client: handshake, masked sends, frame reading into a queue.
function connect(docId, token) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host: '127.0.0.1', port }, () => {
      const key = crypto.randomBytes(16).toString('base64');
      sock.write(`GET /ws/docs/${docId}?token=${token} HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
      let head = Buffer.alloc(0);
      const onData = (chunk) => {
        head = Buffer.concat([head, chunk]);
        const idx = head.indexOf('\r\n\r\n');
        if (idx < 0) return;
        sock.off('data', onData);
        const status = head.toString('latin1').split('\r\n')[0];
        if (!status.includes(' 101 ')) return reject(new Error(status));
        assert.equal(head.toString('latin1').includes(`Sec-WebSocket-Accept: ${acceptKey(key)}`), true);
        const messages = [];
        const waiters = [];
        const parser = new FrameParser({ onMessage: (op, data) => {
          const msg = JSON.parse(data.toString('utf8'));
          const w = waiters.shift();
          if (w) w(msg); else messages.push(msg);
        } });
        const rest = head.subarray(idx + 4);
        if (rest.length) parser.push(rest);
        sock.on('data', c => parser.push(c));
        resolve({
          next: () => new Promise(r => { if (messages.length) r(messages.shift()); else waiters.push(r); }),
          send: (obj) => {
            const payload = Buffer.from(JSON.stringify(obj));
            const mask = crypto.randomBytes(4);
            const masked = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]));
            const header = payload.length < 126 ? Buffer.from([0x81, 0x80 | payload.length]) : Buffer.from([0x81, 0xfe, payload.length >> 8, payload.length & 255]);
            sock.write(Buffer.concat([header, mask, masked]));
          },
          close: () => sock.destroy(),
        });
      };
      sock.on('data', onData);
    });
    openSockets.push(sock);
    sock.on('error', reject);
  });
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diagram-s5-ws-'));
  server = createServer({ dataDir });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(async () => {
  for (const s of openSockets) s.destroy();
  server.closeAllConnections?.();
  await new Promise(r => server.close(r));
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('websocket: editors sync ops, viewers are refused, presence is relayed', async () => {
  const owner = await post('/api/auth/register', { username: 'wsowner', password: 'secret123' });
  assert.equal(owner.status, 201);
  const ownerToken = (await post('/api/auth/login', { username: 'wsowner', password: 'secret123' })).data.token;
  await post('/api/auth/register', { username: 'wsviewer', password: 'secret123' });
  const viewerToken = (await post('/api/auth/login', { username: 'wsviewer', password: 'secret123' })).data.token;
  const docId = (await post('/api/docs', { title: 'WS' }, ownerToken)).data.id;
  await post(`/api/docs/${docId}/share`, { username: 'wsviewer', role: 'viewer' }, ownerToken);

  const a = await connect(docId, ownerToken);
  assert.equal((await a.next()).type, 'hello');
  const b = await connect(docId, ownerToken);
  assert.equal((await b.next()).type, 'hello');

  const env = { id: 'ws@1', actor: 'ws', lamport: 1, writes: [
    { k: 'el', id: 'w1', f: 'alive', v: true, t: [1, 'ws'] },
    { k: 'el', id: 'w1', f: 'type', v: 'rect', t: [1, 'ws'] },
  ] };
  a.send({ type: 'ops', ops: [env] });
  // The sender receives the broadcast and the ack in either order.
  let ack, own;
  for (let i = 0; i < 2; i++) {
    const m = await a.next();
    if (m.type === 'ack') ack = m; else own = m;
  }
  assert.equal(ack.seq, 1);
  assert.equal(own.ops[0].id, 'ws@1');
  const pushed = await b.next();
  assert.equal(pushed.type, 'ops');
  assert.equal(pushed.ops[0].id, 'ws@1');

  a.send({ type: 'presence', actor: 'alice', cursor: { x: 3, y: 4 }, selection: ['w1'] });
  const pres = await b.next();
  assert.equal(pres.type, 'presence');
  assert.equal(pres.actor, 'alice');
  assert.deepEqual(pres.selection, ['w1']);

  const v = await connect(docId, viewerToken);
  assert.equal((await v.next()).role, 'viewer');
  v.send({ type: 'ops', ops: [{ ...env, id: 'ws@2' }] });
  assert.equal((await v.next()).type, 'error');

  const bad = await new Promise(resolve => {
    const s = net.createConnection({ host: '127.0.0.1', port }, () => {
      s.write(`GET /ws/docs/${docId}?token=bogus HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    let buf = '';
    s.on('data', d => { buf += d; });
    s.on('close', () => resolve(buf));
    s.on('error', () => resolve(buf));
  });
  assert.match(bad, /^HTTP\/1\.1 401/);
});
