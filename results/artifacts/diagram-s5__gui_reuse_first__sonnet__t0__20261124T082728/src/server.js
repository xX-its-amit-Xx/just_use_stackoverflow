import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDocument, fromJSON, DiagramError } from './core/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class HttpError extends Error {
  constructor(status, error, message) { super(message); this.status = status; this.error = error; }
}
const bad = (m) => new HttpError(400, 'bad_request', m);
const notFound = (m = 'not found') => new HttpError(404, 'not_found', m);
const forbidden = (m = 'forbidden') => new HttpError(403, 'forbidden', m);

export function createServer({ dataDir }) {
  dataDir = path.resolve(dataDir || './data');
  const docsDir = path.join(dataDir, 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  const usersFile = path.join(dataDir, 'users.json');
  let store = { users: {}, tokens: {} };
  if (fs.existsSync(usersFile)) { try { store = JSON.parse(fs.readFileSync(usersFile, 'utf8')); } catch { /* ignore */ } }
  const saveUsers = () => { fs.writeFileSync(usersFile + '.tmp', JSON.stringify(store)); fs.renameSync(usersFile + '.tmp', usersFile); };

  const docs = new Map(); // id -> {meta, doc, log:[], waiters:Set, sockets:Set}
  const safeId = (id) => /^[\w-]+$/.test(id);
  const metaFile = (id) => path.join(docsDir, id + '.json');
  const opsFile = (id) => path.join(docsDir, id + '.ops.jsonl');
  const saveMeta = (d) => { fs.writeFileSync(metaFile(d.meta.id) + '.tmp', JSON.stringify(d.meta)); fs.renameSync(metaFile(d.meta.id) + '.tmp', metaFile(d.meta.id)); };
  function loadDoc(id) {
    const meta = JSON.parse(fs.readFileSync(metaFile(id), 'utf8'));
    const doc = createDocument({ id, actor: 'server' });
    const log = [];
    if (fs.existsSync(opsFile(id))) {
      for (const line of fs.readFileSync(opsFile(id), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { const op = JSON.parse(line); log.push(op); } catch { /* torn write */ }
      }
      doc.receive(log);
    }
    return { meta, doc, log, waiters: new Set(), sockets: new Set() };
  }
  for (const f of fs.readdirSync(docsDir)) {
    if (f.endsWith('.json') && !f.endsWith('.ops.jsonl')) { const id = f.slice(0, -5); try { docs.set(id, loadDoc(id)); } catch { /* skip corrupt */ } }
  }

  function appendOps(d, ops) {
    const fresh = [];
    const have = d.seen ||= new Set(d.log.map((o) => o.id));
    for (const op of ops) if (!have.has(op.id)) { have.add(op.id); fresh.push(op); }
    if (!fresh.length) return d.log.length;
    d.doc.receive(fresh);
    d.doc.pendingOps();
    fs.appendFileSync(opsFile(d.meta.id), fresh.map((o) => JSON.stringify(o)).join('\n') + '\n');
    d.log.push(...fresh);
    d.meta.updatedAt = Date.now(); saveMeta(d);
    for (const w of [...d.waiters]) w();
    return d.log.length;
  }
  function validateOps(ops) {
    if (!Array.isArray(ops)) throw bad('ops must be an array');
    for (const op of ops) {
      if (!op || typeof op !== 'object' || typeof op.id !== 'string' || typeof op.eid !== 'string' || typeof op.actor !== 'string' ||
        typeof op.clock !== 'number' || !['add', 'set', 'del'].includes(op.k)) throw bad('malformed op');
      if (op.k === 'add' && (!op.props || typeof op.props !== 'object')) throw bad('malformed op');
      if (op.k === 'set' && typeof op.key !== 'string') throw bad('malformed op');
    }
  }
  function broadcast(d, msg, except) {
    const frame = wsFrame(JSON.stringify(msg));
    for (const s of d.sockets) if (s !== except && !s.destroyed) s.write(frame);
  }

  const authUser = (req, url) => {
    const h = req.headers.authorization || '';
    let token = h.startsWith('Bearer ') ? h.slice(7).trim() : null;
    if (!token && url) token = url.searchParams.get('token');
    const username = token && store.tokens[token];
    if (!username || !store.users[username]) throw new HttpError(401, 'unauthorized', 'authentication required');
    return store.users[username];
  };
  const roleOf = (d, user) => {
    if (d.meta.owner === user.username) return 'owner';
    return d.meta.shares[user.username] || null;
  };
  const getDoc = (id, user, need) => {
    const d = docs.get(id);
    if (!d) throw notFound('document not found');
    const role = roleOf(d, user);
    if (!role) throw forbidden('no access to this document');
    if (need === 'edit' && role === 'viewer') throw forbidden('read-only access');
    if (need === 'owner' && role !== 'owner') throw forbidden('owner only');
    return { d, role };
  };
  const pubDoc = (d, role) => ({ id: d.meta.id, title: d.meta.title, owner: d.meta.owner, role, createdAt: d.meta.createdAt, updatedAt: d.meta.updatedAt, seq: d.log.length });
  const hash = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');

  async function readBody(req) {
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > 20e6) throw bad('body too large'); chunks.push(c); }
    if (!chunks.length) return {};
    try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (v === null || typeof v !== 'object') throw 0; return v; } catch { throw bad('invalid JSON body'); }
  }
  const send = (res, status, body, type = 'application/json') => {
    const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(data);
  };

  async function handleApi(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // after 'api'
    const m = req.method;
    if (parts[0] === 'auth') {
      if (m !== 'POST') throw notFound();
      const b = await readBody(req);
      if (parts[1] === 'register') {
        if (typeof b.username !== 'string' || !/^[\w.@-]{1,64}$/.test(b.username)) throw bad('invalid username');
        if (typeof b.password !== 'string' || b.password.length < 1) throw bad('invalid password');
        if (store.users[b.username]) throw new HttpError(409, 'conflict', 'username taken');
        const salt = crypto.randomBytes(16).toString('hex');
        store.users[b.username] = { id: crypto.randomUUID(), username: b.username, salt, hash: hash(b.password, salt) };
        saveUsers();
        return send(res, 201, { user: { id: store.users[b.username].id, username: b.username } });
      }
      if (parts[1] === 'login') {
        const u = typeof b.username === 'string' ? store.users[b.username] : null;
        if (!u || typeof b.password !== 'string' || !crypto.timingSafeEqual(Buffer.from(hash(b.password, u.salt)), Buffer.from(u.hash))) throw new HttpError(401, 'unauthorized', 'invalid credentials');
        const token = crypto.randomBytes(24).toString('hex');
        store.tokens[token] = u.username; saveUsers();
        return send(res, 200, { token, user: { id: u.id, username: u.username } });
      }
      throw notFound();
    }
    if (parts[0] !== 'docs') throw notFound();
    const user = authUser(req, url);
    if (parts.length === 1) {
      if (m === 'POST') {
        const b = await readBody(req);
        if (b.title !== undefined && typeof b.title !== 'string') throw bad('title must be a string');
        const id = crypto.randomBytes(8).toString('hex');
        const meta = { id, title: b.title || 'Untitled', owner: user.username, shares: {}, versions: [], comments: [], createdAt: Date.now(), updatedAt: Date.now() };
        const d = { meta, doc: createDocument({ id, actor: 'server' }), log: [], waiters: new Set(), sockets: new Set() };
        docs.set(id, d); saveMeta(d); fs.writeFileSync(opsFile(id), '');
        return send(res, 201, pubDoc(d, 'owner'));
      }
      if (m === 'GET') {
        const list = [];
        for (const d of docs.values()) { const r = roleOf(d, user); if (r) list.push(pubDoc(d, r)); }
        return send(res, 200, { docs: list });
      }
      throw notFound();
    }
    const id = parts[1];
    if (!safeId(id)) throw notFound('document not found');
    const sub = parts[2];
    if (!sub) {
      if (m === 'GET') { const { d, role } = getDoc(id, user); return send(res, 200, { ...d.doc.toJSON(), ...pubDoc(d, role), docId: d.meta.id }); }
      if (m === 'DELETE') {
        const { d } = getDoc(id, user, 'owner');
        docs.delete(id);
        for (const s of d.sockets) s.destroy();
        for (const w of [...d.waiters]) w();
        fs.rmSync(metaFile(id), { force: true }); fs.rmSync(opsFile(id), { force: true });
        return send(res, 200, { ok: true });
      }
      throw notFound();
    }
    if (sub === 'share' && m === 'POST') {
      const { d } = getDoc(id, user, 'owner');
      const b = await readBody(req);
      if (!['editor', 'viewer'].includes(b.role)) throw bad('role must be editor or viewer');
      if (typeof b.username !== 'string' || !store.users[b.username]) throw notFound('user not found');
      if (b.username === d.meta.owner) throw bad('cannot share with owner');
      d.meta.shares[b.username] = b.role; saveMeta(d);
      return send(res, 200, { ok: true, username: b.username, role: b.role });
    }
    if (sub === 'ops') {
      if (m === 'POST') {
        const { d } = getDoc(id, user, 'edit');
        const b = await readBody(req);
        validateOps(b.ops);
        const before = d.log.length;
        const seq = appendOps(d, b.ops);
        if (seq > before) broadcast(d, { type: 'ops', ops: d.log.slice(before), seq });
        return send(res, 200, { seq });
      }
      if (m === 'GET') {
        const { d } = getDoc(id, user);
        const since = Number(url.searchParams.get('since') || 0);
        if (!Number.isInteger(since) || since < 0) throw bad('invalid since');
        const reply = () => send(res, 200, { ops: d.log.slice(since), seq: d.log.length });
        if (url.searchParams.get('wait') === '1' && d.log.length <= since) {
          let done = false;
          const finish = () => { if (done) return; done = true; clearTimeout(timer); d.waiters.delete(finish); if (!res.writableEnded && !res.destroyed) reply(); };
          const timer = setTimeout(finish, 25000);
          d.waiters.add(finish);
          req.on('close', () => { done = true; clearTimeout(timer); d.waiters.delete(finish); });
          return;
        }
        return reply();
      }
    }
    if (sub === 'versions') {
      if (!parts[3]) {
        if (m === 'POST') {
          const { d } = getDoc(id, user, 'edit'); const b = await readBody(req);
          const v = { id: crypto.randomBytes(6).toString('hex'), label: typeof b.label === 'string' ? b.label : '', author: user.username, createdAt: Date.now(), seq: d.log.length, snapshot: d.doc.toJSON() };
          d.meta.versions.push(v); saveMeta(d);
          return send(res, 201, { id: v.id, label: v.label, author: v.author, createdAt: v.createdAt, seq: v.seq });
        }
        if (m === 'GET') {
          const { d } = getDoc(id, user);
          return send(res, 200, { versions: d.meta.versions.map(({ snapshot, ...r }) => r) });
        }
      } else if (parts[4] === 'restore' && m === 'POST') {
        const { d } = getDoc(id, user, 'edit');
        const v = d.meta.versions.find((x) => x.id === parts[3]);
        if (!v) throw notFound('version not found');
        const before = d.log.length;
        d.doc.restoreFrom(v.snapshot);
        const seq = appendOps(d, d.doc.pendingOps().map((o) => o));
        // restoreFrom already applied locally; appendOps re-receives (idempotent via seen ids)
        broadcast(d, { type: 'ops', ops: d.log.slice(before), seq });
        return send(res, 200, { ok: true, seq });
      } else if (parts[3] && !parts[4] && m === 'GET') {
        const { d } = getDoc(id, user);
        const v = d.meta.versions.find((x) => x.id === parts[3]);
        if (!v) throw notFound('version not found');
        return send(res, 200, v);
      }
    }
    if (sub === 'comments') {
      const { d } = getDoc(id, user, m === 'GET' ? undefined : undefined);
      if (!parts[3]) {
        if (m === 'GET') return send(res, 200, { comments: d.meta.comments });
        if (m === 'POST') {
          const b = await readBody(req);
          if (typeof b.text !== 'string' || !b.text) throw bad('text required');
          if (typeof b.elementId !== 'string') throw bad('elementId required');
          if (!d.doc.get(b.elementId)) throw notFound('element not found');
          const c = { id: crypto.randomBytes(6).toString('hex'), elementId: b.elementId, author: user.username, text: b.text, createdAt: Date.now(), resolved: false, replies: [] };
          d.meta.comments.push(c); saveMeta(d);
          broadcast(d, { type: 'comments' });
          return send(res, 201, c);
        }
      } else {
        const c = d.meta.comments.find((x) => x.id === parts[3]);
        if (!c) throw notFound('comment not found');
        const act = parts[4];
        if (!act && m === 'GET') return send(res, 200, c);
        if (act === 'replies' && m === 'POST') {
          const b = await readBody(req);
          if (typeof b.text !== 'string' || !b.text) throw bad('text required');
          const r = { id: crypto.randomBytes(6).toString('hex'), author: user.username, text: b.text, createdAt: Date.now() };
          c.replies.push(r); saveMeta(d); broadcast(d, { type: 'comments' });
          return send(res, 201, r);
        }
        if ((act === 'resolve' || act === 'unresolve') && m === 'POST') {
          const b = await readBody(req);
          c.resolved = act === 'resolve' ? (b.resolved !== false) : false; saveMeta(d); broadcast(d, { type: 'comments' });
          return send(res, 200, c);
        }
        if (!act && m === 'PATCH') {
          const b = await readBody(req);
          if (typeof b.resolved === 'boolean') c.resolved = b.resolved;
          saveMeta(d); broadcast(d, { type: 'comments' });
          return send(res, 200, c);
        }
      }
    }
    if ((sub === 'export.svg' || sub === 'export.json') && m === 'GET') {
      const { d } = getDoc(id, user);
      if (sub === 'export.svg') return send(res, 200, d.doc.toSVG(), 'image/svg+xml');
      return send(res, 200, JSON.stringify(d.doc.toJSON()), 'application/json');
    }
    throw notFound();
  }

  function serveStatic(req, res, url) {
    let file;
    if (url.pathname === '/' || url.pathname === '/index.html') file = path.join(HERE, 'static', 'index.html');
    else if (url.pathname.startsWith('/static/core/')) file = path.join(HERE, 'core', url.pathname.slice(13));
    else if (url.pathname.startsWith('/static/')) file = path.join(HERE, 'static', url.pathname.slice(8));
    else return false;
    let dec; try { dec = decodeURIComponent(file); } catch { dec = ''; }
    const root = path.resolve(HERE);
    const resolved = path.resolve(dec);
    if (!resolved.startsWith(root + path.sep) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) { send(res, 404, { error: 'not_found', message: 'not found' }); return true; }
    send(res, 200, fs.readFileSync(resolved), MIME[path.extname(resolved)] || 'application/octet-stream');
    return true;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/') || url.pathname === '/api') return await handleApi(req, res, url);
      if (req.method === 'GET' && serveStatic(req, res, url)) return;
      throw notFound();
    } catch (e) {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) return send(res, e.status, { error: e.error, message: e.message });
      if (e instanceof DiagramError) return send(res, 400, { error: 'bad_request', message: e.message });
      console.error(e);
      return send(res, 500, { error: 'internal', message: 'internal error' });
    }
  });

  // ---------- WebSocket ----------
  function wsFrame(str, opcode = 1) {
    const payload = Buffer.from(str);
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | opcode, len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    return Buffer.concat([head, payload]);
  }
  server.on('upgrade', (req, socket) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const m = /^\/ws\/docs\/([\w-]+)$/.exec(url.pathname);
      if (!m) throw notFound();
      const user = authUser(req, url);
      const { d, role } = getDoc(m[1], user);
      const key = req.headers['sec-websocket-key'];
      if (!key) throw bad('missing key');
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
        crypto.createHash('sha1').update(key + WS_GUID).digest('base64') + '\r\n\r\n');
      d.sockets.add(socket);
      const actor = url.searchParams.get('actor') || user.username;
      socket.write(wsFrame(JSON.stringify({ type: 'hello', seq: d.log.length, role, actor: user.username })));
      let buf = Buffer.alloc(0), frag = null;
      const close = () => { d.sockets.delete(socket); broadcast(d, { type: 'presence', actor, gone: true }, socket); socket.destroy(); };
      const handle = (text) => {
        let msg; try { msg = JSON.parse(text); } catch { return; }
        if (msg.type === 'presence') broadcast(d, { type: 'presence', actor: msg.actor || actor, user: user.username, cursor: msg.cursor ?? null, selection: msg.selection ?? [] }, socket);
        else if (msg.type === 'ops') {
          if (role === 'viewer') return socket.write(wsFrame(JSON.stringify({ type: 'error', error: 'forbidden', message: 'read-only access' })));
          try {
            validateOps(msg.ops);
            const before = d.log.length; const seq = appendOps(d, msg.ops);
            if (seq > before) broadcast(d, { type: 'ops', ops: d.log.slice(before), seq }, socket);
            socket.write(wsFrame(JSON.stringify({ type: 'ack', seq })));
          } catch (e) { socket.write(wsFrame(JSON.stringify({ type: 'error', error: 'bad_request', message: e.message }))); }
        }
      };
      socket.on('data', (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (buf.length < 2) return;
          const fin = !!(buf[0] & 0x80), op = buf[0] & 15, masked = !!(buf[1] & 0x80);
          let len = buf[1] & 127, off = 2;
          if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
          else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
          if (len > 20e6) return close();
          if (buf.length < off + (masked ? 4 : 0) + len) return;
          let payload;
          if (masked) {
            const mask = buf.subarray(off, off + 4); payload = Buffer.from(buf.subarray(off + 4, off + 4 + len));
            for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
            off += 4;
          } else payload = Buffer.from(buf.subarray(off, off + len));
          buf = buf.subarray(off + len);
          if (op === 8) { socket.write(wsFrame('', 8)); return close(); }
          if (op === 9) { socket.write(wsFrame(payload.toString(), 10)); continue; }
          if (op === 10) continue;
          if (op === 1 || op === 2) frag = payload; else if (op === 0 && frag) frag = Buffer.concat([frag, payload]);
          if (fin && frag) { handle(frag.toString('utf8')); frag = null; }
        }
      });
      socket.on('close', close); socket.on('error', close);
    } catch (e) {
      const status = e.status || 400;
      socket.write(`HTTP/1.1 ${status} Error\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    }
  });
  return server;
}
