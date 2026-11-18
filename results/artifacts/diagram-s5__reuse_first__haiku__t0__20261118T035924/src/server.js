// Collaboration server: auth, documents, op log, long-poll and WebSocket sync,
// version history, comments and exports. Standard library only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createDocument, DiagramError } from './core/index.js';
import { acceptKey, encodeFrame, FrameParser } from './ws.js';

const scrypt = promisify(scryptCb);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');
const SERVER_ACTOR = 'server';
const LONG_POLL_MS = 25000;
const MAX_BODY = 8 * 1024 * 1024;
const ROLES = new Set(['editor', 'viewer']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, name, message) {
    super(message);
    this.status = status;
    this.errName = name;
  }
}

const bad = (msg) => new HttpError(400, 'BadRequest', msg);

// Writes a JSON file atomically (temp file + rename).
function writeJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function createServer({ dataDir }) {
  if (!dataDir) throw new TypeError('createServer: dataDir required');
  const docsDir = path.join(dataDir, 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  const usersFile = path.join(dataDir, 'users.json');
  const sessionsFile = path.join(dataDir, 'sessions.json');

  const users = new Map(Object.entries(readJson(usersFile, {})));   // username -> {username, salt, hash, createdAt}
  const sessions = new Map(Object.entries(readJson(sessionsFile, {}))); // token -> username
  const metas = new Map();   // docId -> meta
  const runtime = new Map(); // docId -> {doc, seq, ops: [{seq, batch}], seen: Set, sockets: Set, waiters: Set}

  for (const f of fs.readdirSync(docsDir)) {
    if (!f.endsWith('.json')) continue;
    const meta = readJson(path.join(docsDir, f), null);
    if (meta && meta.id) metas.set(meta.id, meta);
  }

  const saveUsers = () => writeJson(usersFile, Object.fromEntries(users));
  const saveSessions = () => writeJson(sessionsFile, Object.fromEntries(sessions));
  const saveMeta = (meta) => writeJson(path.join(docsDir, `${meta.id}.json`), meta);
  const opLogFile = (id) => path.join(docsDir, `${id}.oplog.jsonl`);

  // ---------- documents at runtime ----------
  function load(id) {
    if (runtime.has(id)) return runtime.get(id);
    const doc = createDocument({ id, actor: SERVER_ACTOR });
    const rt = { doc, seq: 0, ops: [], seen: new Set(), sockets: new Set(), waiters: new Set() };
    const file = opLogFile(id);
    if (fs.existsSync(file)) {
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        let rec;
        try { rec = JSON.parse(line); } catch { continue; }
        if (!rec?.batch) continue;
        rt.seq = Math.max(rt.seq, rec.seq);
        rt.ops.push(rec);
        rt.seen.add(rec.batch.id);
        doc.receive([rec.batch]);
      }
    }
    doc.pendingOps();
    runtime.set(id, rt);
    return rt;
  }

  // Persists batches, applies them, and notifies sockets and long-pollers.
  function commit(id, batches) {
    const rt = load(id);
    const fresh = [];
    for (const batch of batches) {
      if (rt.seen.has(batch.id)) continue;
      rt.seen.add(batch.id);
      rt.seq += 1;
      const rec = { seq: rt.seq, batch };
      fs.appendFileSync(opLogFile(id), JSON.stringify(rec) + '\n');
      rt.ops.push(rec);
      fresh.push(rec);
    }
    if (fresh.length === 0) return rt.seq;
    rt.doc.receive(fresh.map((r) => r.batch));
    const meta = metas.get(id);
    if (meta) { meta.updatedAt = new Date().toISOString(); saveMeta(meta); }
    const wire = fresh.map((r) => ({ seq: r.seq, ...r.batch }));
    broadcast(rt, { type: 'ops', ops: wire, seq: rt.seq });
    for (const w of [...rt.waiters]) w();
    return rt.seq;
  }

  function broadcast(rt, msg) {
    const frame = encodeFrame(0x1, Buffer.from(JSON.stringify(msg)));
    for (const s of rt.sockets) if (!s.destroyed) s.write(frame);
  }

  // Applies public operations (server-side replica) and commits the generated batches.
  // On failure the operations applied so far are still committed, so the
  // server replica never drifts from its log.
  function applyPublicOps(id, ops) {
    const rt = load(id);
    try {
      for (const op of ops) rt.doc.apply(op);
    } finally {
      commit(id, rt.doc.pendingOps());
    }
    return rt.seq;
  }

  // ---------- auth ----------
  async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
    const key = await scrypt(password, salt, 64);
    return { salt, hash: key.toString('hex') };
  }

  async function checkPassword(user, password) {
    const { hash } = await hashPassword(password, user.salt);
    return timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.hash, 'hex'));
  }

  // REST uses the Authorization header; the WebSocket upgrade may also pass ?token=.
  function authUser(req, url, { allowQuery = false } = {}) {
    const header = req.headers.authorization || '';
    const m = /^Bearer (.+)$/.exec(header);
    const token = m ? m[1] : (allowQuery ? url?.searchParams.get('token') : null);
    const username = token && sessions.get(token);
    if (!username) throw new HttpError(401, 'Unauthorized', 'missing or invalid token');
    return username;
  }

  function roleOf(meta, username) {
    if (meta.owner === username) return 'owner';
    return meta.members[username] ?? null;
  }

  function docFor(username, id, minRole) {
    const meta = metas.get(id);
    const role = meta ? roleOf(meta, username) : null;
    if (!meta || !role) throw new HttpError(404, 'NotFound', 'document not found');
    if (minRole === 'editor' && role === 'viewer') throw new HttpError(403, 'Forbidden', 'viewers cannot edit');
    if (minRole === 'owner' && role !== 'owner') throw new HttpError(403, 'Forbidden', 'owner only');
    return { meta, role };
  }

  // ---------- HTTP plumbing ----------
  function sendJson(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
    res.end(data);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { reject(new HttpError(400, 'BadRequest', 'body too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function jsonBody(req) {
    const text = await readBody(req);
    if (!text.trim()) return {};
    try {
      const v = JSON.parse(text);
      if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not object');
      return v;
    } catch {
      throw bad('body must be a JSON object');
    }
  }

  const str = (v, name, max = 200) => {
    if (typeof v !== 'string' || v.trim() === '' || v.length > max) throw bad(`${name} must be a non-empty string`);
    return v;
  };

  function publicDoc(meta, username) {
    const rt = load(meta.id);
    return {
      ...rt.doc.toJSON(),
      title: meta.title, owner: meta.owner, role: roleOf(meta, username),
      members: meta.members, seq: rt.seq, createdAt: meta.createdAt, updatedAt: meta.updatedAt,
    };
  }

  // ---------- route handlers ----------
  async function handleApi(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent); // ['api', ...]
    const method = req.method;
    const sub = parts.slice(1);

    if (method === 'POST' && sub.join('/') === 'auth/register') {
      const body = await jsonBody(req);
      const username = str(body.username, 'username', 32);
      if (!/^[A-Za-z0-9_]{3,32}$/.test(username)) throw bad('username: 3-32 letters, digits or _');
      if (typeof body.password !== 'string' || body.password.length < 6) throw bad('password must be at least 6 characters');
      if (users.has(username)) throw new HttpError(409, 'Conflict', 'username taken');
      const { salt, hash } = await hashPassword(body.password);
      users.set(username, { username, salt, hash, createdAt: new Date().toISOString() });
      saveUsers();
      return sendJson(res, 201, { user: { username } });
    }

    if (method === 'POST' && sub.join('/') === 'auth/login') {
      const body = await jsonBody(req);
      const user = users.get(String(body.username ?? ''));
      if (!user || typeof body.password !== 'string' || !(await checkPassword(user, body.password))) {
        throw new HttpError(401, 'Unauthorized', 'invalid username or password');
      }
      const token = randomBytes(32).toString('hex');
      sessions.set(token, user.username);
      saveSessions();
      return sendJson(res, 200, { token, user: { username: user.username } });
    }

    if (sub[0] !== 'docs') throw new HttpError(404, 'NotFound', 'no such route');
    const me = authUser(req, url);

    if (sub.length === 1) {
      if (method === 'GET') {
        const list = [...metas.values()]
          .filter((m) => roleOf(m, me))
          .map((m) => ({ id: m.id, title: m.title, owner: m.owner, role: roleOf(m, me), updatedAt: m.updatedAt }));
        return sendJson(res, 200, list);
      }
      if (method === 'POST') {
        const body = await jsonBody(req);
        const title = str(body.title, 'title');
        const id = randomUUID();
        const now = new Date().toISOString();
        const meta = { id, title, owner: me, members: {}, createdAt: now, updatedAt: now, versions: [], comments: [] };
        metas.set(id, meta);
        saveMeta(meta);
        load(id);
        return sendJson(res, 201, publicDoc(meta, me));
      }
      throw new HttpError(405, 'MethodNotAllowed', 'method not allowed');
    }

    const id = sub[1];
    const rest = sub.slice(2);

    if (rest.length === 0) {
      if (method === 'GET') {
        const { meta } = docFor(me, id);
        return sendJson(res, 200, publicDoc(meta, me));
      }
      if (method === 'PATCH') {
        const { meta } = docFor(me, id, 'editor');
        const body = await jsonBody(req);
        meta.title = str(body.title, 'title');
        meta.updatedAt = new Date().toISOString();
        saveMeta(meta);
        return sendJson(res, 200, publicDoc(meta, me));
      }
      if (method === 'DELETE') {
        const { meta } = docFor(me, id, 'owner');
        runtime.delete(id);
        metas.delete(id);
        for (const f of [`${id}.json`, `${id}.oplog.jsonl`]) fs.rmSync(path.join(docsDir, f), { force: true });
        return sendJson(res, 200, { id: meta.id, deleted: true });
      }
    }

    if (rest[0] === 'share' && method === 'POST' && rest.length === 1) {
      const { meta } = docFor(me, id, 'owner');
      const body = await jsonBody(req);
      const username = str(body.username, 'username', 32);
      const role = body.role ?? 'editor';
      if (!ROLES.has(role)) throw bad('role must be editor or viewer');
      if (!users.has(username)) throw new HttpError(404, 'NotFound', 'no such user');
      if (username === meta.owner) throw bad('owner already has full access');
      meta.members[username] = role;
      saveMeta(meta);
      return sendJson(res, 200, { id, members: meta.members });
    }

    if (rest[0] === 'ops' && rest.length === 1) {
      if (method === 'POST') {
        docFor(me, id, 'editor');
        const body = await jsonBody(req);
        if (!Array.isArray(body.ops)) throw bad('ops must be an array');
        const { batches, publicOps } = splitOps(body.ops);
        try {
          applyPublicOps(id, publicOps);
          commit(id, batches);
        } catch (err) {
          throw toHttp(err);
        }
        return sendJson(res, 200, { seq: load(id).seq });
      }
      if (method === 'GET') {
        docFor(me, id);
        const since = Number(url.searchParams.get('since') ?? 0) || 0;
        const rt = load(id);
        const wait = url.searchParams.get('wait') === '1';
        const pick = () => rt.ops.filter((r) => r.seq > since).map((r) => ({ seq: r.seq, ...r.batch }));
        let ops = pick();
        if (ops.length === 0 && wait) {
          await new Promise((resolve) => {
            const done = () => { clearTimeout(timer); rt.waiters.delete(done); resolve(); };
            const timer = setTimeout(done, LONG_POLL_MS);
            rt.waiters.add(done);
          });
          ops = pick();
        }
        return sendJson(res, 200, { ops, seq: rt.seq });
      }
    }

    if (rest[0] === 'versions') {
      const meta = docFor(me, id).meta;
      if (rest.length === 1 && method === 'GET') {
        return sendJson(res, 200, meta.versions.map(({ snapshot, ...v }) => v));
      }
      if (rest.length === 1 && method === 'POST') {
        docFor(me, id, 'editor');
        const body = await jsonBody(req);
        const label = str(body.label ?? new Date().toISOString(), 'label');
        const rt = load(id);
        const v = { id: randomUUID(), label, seq: rt.seq, createdAt: new Date().toISOString(), author: me, snapshot: rt.doc.toJSON() };
        meta.versions.push(v);
        saveMeta(meta);
        const { snapshot, ...out } = v;
        return sendJson(res, 201, out);
      }
      if (rest.length === 3 && rest[2] === 'restore' && method === 'POST') {
        docFor(me, id, 'editor');
        const v = meta.versions.find((x) => x.id === rest[1]);
        if (!v) throw new HttpError(404, 'NotFound', 'no such version');
        const rt = load(id);
        try {
          rt.doc.restore(v.snapshot);
        } catch (err) {
          throw toHttp(err);
        }
        const seq = commit(id, rt.doc.pendingOps());
        return sendJson(res, 200, { id, restored: v.id, seq });
      }
    }

    if (rest[0] === 'comments') {
      const meta = docFor(me, id).meta;
      if (rest.length === 1 && method === 'GET') return sendJson(res, 200, meta.comments);
      if (rest.length === 1 && method === 'POST') {
        const body = await jsonBody(req);
        const c = {
          id: randomUUID(), elementId: str(body.elementId, 'elementId'), author: me,
          body: str(body.body, 'body', 5000), resolved: false, createdAt: new Date().toISOString(), replies: [],
        };
        meta.comments.push(c);
        saveMeta(meta);
        return sendJson(res, 201, c);
      }
      if (rest.length === 3 && rest[2] === 'replies' && method === 'POST') {
        const c = meta.comments.find((x) => x.id === rest[1]);
        if (!c) throw new HttpError(404, 'NotFound', 'no such comment');
        const body = await jsonBody(req);
        const reply = { id: randomUUID(), author: me, body: str(body.body, 'body', 5000), createdAt: new Date().toISOString() };
        c.replies.push(reply);
        saveMeta(meta);
        return sendJson(res, 201, reply);
      }
      if (rest.length === 3 && rest[2] === 'resolve' && method === 'POST') {
        const c = meta.comments.find((x) => x.id === rest[1]);
        if (!c) throw new HttpError(404, 'NotFound', 'no such comment');
        const body = await jsonBody(req);
        c.resolved = body.resolved === undefined ? true : Boolean(body.resolved);
        saveMeta(meta);
        return sendJson(res, 200, c);
      }
    }

    if (rest.length === 1 && rest[0] === 'export.svg' && method === 'GET') {
      docFor(me, id);
      const svg = load(id).doc.toSVG();
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Length': Buffer.byteLength(svg) });
      return res.end(svg);
    }
    if (rest.length === 1 && rest[0] === 'export.json' && method === 'GET') {
      docFor(me, id);
      return sendJson(res, 200, load(id).doc.toJSON());
    }

    throw new HttpError(404, 'NotFound', 'no such route');
  }

  // Client entries are either replicated batches (have `writes`) or public operations (have `type`).
  function splitOps(entries) {
    const batches = [], publicOps = [];
    for (const e of entries) {
      if (Array.isArray(e.writes) && typeof e.id === 'string') batches.push(e);
      else if (typeof e.type === 'string') publicOps.push(e);
      else throw bad('each op must be a batch or an operation');
    }
    return { batches, publicOps };
  }

  function toHttp(err) {
    if (err instanceof HttpError) return err;
    if (err instanceof DiagramError) return new HttpError(400, 'DiagramError', err.message);
    return err;
  }

  // /static/core/* and /static/vendor/* expose the browser-safe core library;
  // everything else under /static/ comes from src/public.
  const STATIC_ROOTS = [
    ['/static/core/', path.join(HERE, 'core')],
    ['/static/vendor/', path.join(HERE, 'vendor')],
    ['/static/', PUBLIC_DIR],
  ];
  async function handleStatic(req, res, url) {
    let root = null, rel = null;
    if (url.pathname === '/') { root = PUBLIC_DIR; rel = 'index.html'; }
    else {
      for (const [prefix, dir] of STATIC_ROOTS) {
        if (url.pathname.startsWith(prefix)) { root = dir; rel = url.pathname.slice(prefix.length); break; }
      }
    }
    if (!root || !rel) return false;
    const file = path.normalize(path.join(root, rel));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return false;
    }
    const data = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': data.length });
    res.end(data);
    return true;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/') || url.pathname === '/api') {
        return await handleApi(req, res, url);
      }
      if (req.method === 'GET' && await handleStatic(req, res, url)) return;
      sendJson(res, 404, { error: 'NotFound', message: 'not found' });
    } catch (err) {
      const e = toHttp(err);
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.errName, message: e.message });
      console.error(err);
      sendJson(res, 500, { error: 'InternalError', message: 'internal error' });
    }
  });

  // ---------- WebSocket: /ws/docs/:id?token= ----------
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://localhost');
    const m = /^\/ws\/docs\/([^/]+)$/.exec(url.pathname);
    if (!m) { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); return socket.destroy(); }
    let me, meta, role;
    try {
      me = authUser(req, url, { allowQuery: true });
      ({ meta, role } = docFor(me, decodeURIComponent(m[1])));
    } catch (err) {
      const status = err.status === 404 ? 404 : 401;
      socket.write(`HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Not Found'}\r\n\r\n`);
      return socket.destroy();
    }
    const key = req.headers['sec-websocket-key'];
    if (!key) { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); return socket.destroy(); }
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`);
    socket.setNoDelay(true);
    const id = meta.id;
    const rt = load(id);
    rt.sockets.add(socket);
    const send = (obj) => { if (!socket.destroyed) socket.write(encodeFrame(0x1, Buffer.from(JSON.stringify(obj)))); };
    send({ type: 'hello', user: me, role, seq: rt.seq });

    const parser = new FrameParser({
      onMessage: (text) => {
        let msg;
        try { msg = JSON.parse(text); } catch { return send({ type: 'error', message: 'bad json' }); }
        if (msg.type === 'ops') {
          if (role === 'viewer') return send({ type: 'error', message: 'viewers cannot edit' });
          if (!Array.isArray(msg.ops)) return send({ type: 'error', message: 'ops must be an array' });
          try {
            const { batches, publicOps } = splitOps(msg.ops);
            applyPublicOps(id, publicOps);
            const seq = commit(id, batches);
            send({ type: 'ack', seq, ackId: msg.ackId ?? null });
          } catch (err) {
            const e = toHttp(err);
            send({ type: 'error', message: e.message, ackId: msg.ackId ?? null });
          }
        } else if (msg.type === 'presence') {
          const out = { type: 'presence', actor: me, cursor: msg.cursor ?? null, selection: msg.selection ?? [] };
          const frame = encodeFrame(0x1, Buffer.from(JSON.stringify(out)));
          for (const s of rt.sockets) if (s !== socket && !s.destroyed) s.write(frame);
        } else {
          send({ type: 'error', message: `unknown message type: ${msg.type}` });
        }
      },
      onPing: (payload) => { if (!socket.destroyed) socket.write(encodeFrame(0xa, payload)); },
      onClose: () => socket.end(encodeFrame(0x8)),
      onError: () => socket.destroy(),
    });
    socket.on('data', (c) => parser.push(c));
    const cleanup = () => {
      rt.sockets.delete(socket);
      for (const s of rt.sockets) if (!s.destroyed) s.write(encodeFrame(0x1, Buffer.from(JSON.stringify({ type: 'left', actor: me }))));
    };
    socket.on('close', cleanup);
    socket.on('error', () => socket.destroy());
  });

  return server;
}
