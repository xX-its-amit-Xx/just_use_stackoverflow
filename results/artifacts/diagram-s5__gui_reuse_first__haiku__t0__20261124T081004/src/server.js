import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDocument, DiagramError } from './core/index.js';
import { Store } from './store.js';
import { FrameParser, encodeFrame, acceptKey } from './ws.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');
const LONG_POLL_MS = 25000;
const MAX_BODY = 20 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const USER_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const ROLES = ['editor', 'viewer'];
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const badRequest = m => new HttpError(400, 'bad_request', m);

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

function sendError(res, err) {
  if (res.headersSent) { res.end(); return; }
  if (err instanceof HttpError) {
    sendJson(res, err.status, { error: err.code, message: err.message });
  } else if (err instanceof DiagramError) {
    sendJson(res, 400, { error: 'bad_request', message: err.message });
  } else {
    sendJson(res, 500, { error: 'internal', message: 'internal server error' });
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'too_large', 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const text = await readBody(req);
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not object');
    return v;
  } catch {
    throw badRequest('body must be a JSON object');
  }
}

function validEnvelope(env) {
  return env && typeof env === 'object' && typeof env.id === 'string' && Array.isArray(env.writes) &&
    Number.isFinite(env.lamport) && env.writes.every(w => w && (w.k === 'el' || w.k === 'ly') &&
      typeof w.id === 'string' && typeof w.f === 'string');
}

const isoNow = () => new Date().toISOString();

export function createServer({ dataDir }) {
  const store = new Store(dataDir);
  const metas = new Map();
  for (const id of store.listDocIds()) {
    const m = store.readMeta(id);
    if (m) metas.set(id, m);
  }
  const live = new Map(); // id -> live document state (loaded on demand)

  function saveMeta(meta) {
    metas.set(meta.id, meta);
    store.writeMeta(meta);
  }

  function getLive(id) {
    let ld = live.get(id);
    if (ld) return ld;
    const meta = metas.get(id);
    if (!meta) return null;
    ld = { meta, doc: createDocument({ id, actor: 'server' }), log: [], seen: new Set(), waiters: new Set(), sockets: new Set() };
    for (const env of store.readOps(id)) {
      if (ld.seen.has(env.id)) continue;
      ld.seen.add(env.id);
      ld.log.push(env);
      ld.doc.receive(env);
    }
    live.set(id, ld);
    return ld;
  }

  function requireDoc(id) {
    if (!ID_RE.test(id)) throw new HttpError(404, 'not_found', 'document not found');
    const ld = getLive(id);
    if (!ld) throw new HttpError(404, 'not_found', 'document not found');
    return ld;
  }

  function roleOf(meta, username) {
    if (meta.owner === username) return 'owner';
    return meta.members[username] || null;
  }

  function requireRole(ld, user, minRoles) {
    const role = roleOf(ld.meta, user.username);
    if (!role) throw new HttpError(403, 'forbidden', 'no access to this document');
    if (minRoles && !minRoles.includes(role)) throw new HttpError(403, 'forbidden', 'insufficient permissions');
    return role;
  }

  function appendOps(ld, envs) {
    if (!Array.isArray(envs)) throw badRequest('ops must be an array');
    for (const env of envs) if (!validEnvelope(env)) throw badRequest('invalid operation envelope');
    const fresh = [];
    for (const env of envs) {
      if (ld.seen.has(env.id)) continue;
      ld.seen.add(env.id);
      fresh.push(env);
    }
    try {
      ld.doc.receive(fresh);
    } catch (err) {
      for (const env of fresh) ld.seen.delete(env.id);
      throw badRequest(err.message);
    }
    if (fresh.length) {
      ld.log.push(...fresh);
      store.appendOps(ld.meta.id, fresh);
      ld.meta.updatedAt = isoNow();
      store.writeMeta(ld.meta);
      notify(ld, fresh);
    }
    return { seq: ld.log.length, fresh };
  }

  function notify(ld, fresh) {
    for (const w of [...ld.waiters]) {
      ld.waiters.delete(w);
      clearTimeout(w.timer);
      sendJson(w.res, 200, { ops: ld.log.slice(w.since), seq: ld.log.length });
    }
    const msg = JSON.stringify({ type: 'ops', ops: fresh, seq: ld.log.length });
    for (const s of ld.sockets) s.send(1, msg);
  }

  function authenticate(req, url) {
    let token = null;
    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ')) token = h.slice(7).trim();
    else if (url.searchParams.get('token')) token = url.searchParams.get('token');
    const username = token && store.users.tokens[token];
    if (!username || !store.users.users[username]) throw new HttpError(401, 'unauthorized', 'missing or invalid token');
    return { username, token };
  }

  function publicUser(u) {
    return { username: u.username, createdAt: u.createdAt };
  }

  function docSummary(meta, role, seq) {
    return {
      id: meta.id, title: meta.title, owner: meta.owner, role,
      createdAt: meta.createdAt, updatedAt: meta.updatedAt, seq,
    };
  }

  async function handleApi(req, res, url) {
    const method = req.method;
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // after 'api'

    if (parts[0] === 'auth' && method === 'POST' && parts[1] === 'register') {
      const body = await readJsonBody(req);
      const { username, password } = body;
      if (typeof username !== 'string' || !USER_RE.test(username)) throw badRequest('invalid username');
      if (typeof password !== 'string' || password.length < 6) throw badRequest('password must be at least 6 characters');
      if (store.users.users[username]) throw new HttpError(409, 'conflict', 'username already taken');
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = crypto.scryptSync(password, salt, 64).toString('hex');
      const user = { username, salt, hash, createdAt: isoNow() };
      store.users.users[username] = user;
      store.saveUsers();
      return sendJson(res, 201, { user: publicUser(user) });
    }
    if (parts[0] === 'auth' && method === 'POST' && parts[1] === 'login') {
      const body = await readJsonBody(req);
      const u = typeof body.username === 'string' ? store.users.users[body.username] : undefined;
      if (!u || typeof body.password !== 'string') throw new HttpError(401, 'unauthorized', 'invalid credentials');
      const hash = crypto.scryptSync(body.password, u.salt, 64);
      const ok = crypto.timingSafeEqual(hash, Buffer.from(u.hash, 'hex'));
      if (!ok) throw new HttpError(401, 'unauthorized', 'invalid credentials');
      const token = crypto.randomBytes(32).toString('hex');
      store.users.tokens[token] = u.username;
      store.saveUsers();
      return sendJson(res, 200, { token, user: publicUser(u) });
    }

    const user = authenticate(req, url);
    if (parts[0] !== 'docs') throw new HttpError(404, 'not_found', 'no such route');

    // /api/docs
    if (parts.length === 1) {
      if (method === 'GET') {
        const list = [];
        for (const meta of metas.values()) {
          const role = roleOf(meta, user.username);
          if (role) list.push(docSummary(meta, role, getLive(meta.id)?.log.length ?? 0));
        }
        list.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
        return sendJson(res, 200, list);
      }
      if (method === 'POST') {
        const body = await readJsonBody(req);
        const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 200) : 'Untitled';
        const id = crypto.randomBytes(8).toString('hex');
        const now = isoNow();
        const meta = { id, title, owner: user.username, members: {}, createdAt: now, updatedAt: now, versions: [], comments: [] };
        saveMeta(meta);
        store.appendOps(id, []);
        const ld = getLive(id);
        return sendJson(res, 201, { ...docSummary(meta, 'owner', ld.log.length), members: meta.members });
      }
      throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    }

    const id = parts[1];
    const sub = parts[2];

    if (parts.length === 2) {
      if (method === 'GET') {
        const ld = requireDoc(id);
        const role = requireRole(ld, user);
        return sendJson(res, 200, {
          ...ld.doc.toJSON(),
          id,
          title: ld.meta.title,
          owner: ld.meta.owner,
          role,
          members: ld.meta.members,
          createdAt: ld.meta.createdAt,
          updatedAt: ld.meta.updatedAt,
          seq: ld.log.length,
        });
      }
      if (method === 'DELETE') {
        const ld = requireDoc(id);
        requireRole(ld, user, ['owner']);
        for (const s of ld.sockets) s.close();
        for (const w of ld.waiters) { clearTimeout(w.timer); sendJson(w.res, 410, { error: 'gone', message: 'document deleted' }); }
        live.delete(id);
        metas.delete(id);
        store.deleteDoc(id);
        res.writeHead(204);
        return res.end();
      }
      throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    }

    if (sub === 'share' && parts.length === 3 && method === 'POST') {
      const ld = requireDoc(id);
      requireRole(ld, user, ['owner']);
      const body = await readJsonBody(req);
      if (typeof body.username !== 'string' || !store.users.users[body.username]) throw new HttpError(404, 'not_found', 'user not found');
      if (!ROLES.includes(body.role)) throw badRequest('role must be editor or viewer');
      if (body.username === ld.meta.owner) throw badRequest('cannot change the owner role');
      ld.meta.members[body.username] = body.role;
      ld.meta.updatedAt = isoNow();
      saveMeta(ld.meta);
      return sendJson(res, 200, { id, members: ld.meta.members });
    }

    if (sub === 'ops' && parts.length === 3) {
      const ld = requireDoc(id);
      if (method === 'POST') {
        requireRole(ld, user, ['owner', 'editor']);
        const body = await readJsonBody(req);
        const { seq, fresh } = appendOps(ld, body.ops);
        return sendJson(res, 200, { seq, accepted: fresh.length });
      }
      if (method === 'GET') {
        requireRole(ld, user);
        const since = Math.max(0, parseInt(url.searchParams.get('since') || '0', 10) || 0);
        if (ld.log.length > since || url.searchParams.get('wait') !== '1') {
          return sendJson(res, 200, { ops: ld.log.slice(since), seq: ld.log.length });
        }
        const waiter = { since, res, timer: null };
        waiter.timer = setTimeout(() => {
          ld.waiters.delete(waiter);
          sendJson(res, 200, { ops: [], seq: ld.log.length });
        }, LONG_POLL_MS);
        ld.waiters.add(waiter);
        res.on('close', () => { ld.waiters.delete(waiter); clearTimeout(waiter.timer); });
        return undefined;
      }
      throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    }

    if (sub === 'versions') {
      const ld = requireDoc(id);
      if (parts.length === 3 && method === 'GET') {
        requireRole(ld, user);
        return sendJson(res, 200, ld.meta.versions.map(v => ({ id: v.id, label: v.label, seq: v.seq, createdAt: v.createdAt })));
      }
      if (parts.length === 3 && method === 'POST') {
        requireRole(ld, user, ['owner', 'editor']);
        const body = await readJsonBody(req);
        const label = typeof body.label === 'string' && body.label ? body.label.slice(0, 200) : `Version ${ld.meta.versions.length + 1}`;
        const v = { id: crypto.randomBytes(6).toString('hex'), label, seq: ld.log.length, createdAt: isoNow(), snapshot: ld.doc.toJSON() };
        ld.meta.versions.push(v);
        saveMeta(ld.meta);
        return sendJson(res, 201, { id: v.id, label: v.label, seq: v.seq, createdAt: v.createdAt });
      }
      if (parts.length === 5 && parts[4] === 'restore' && method === 'POST') {
        requireRole(ld, user, ['owner', 'editor']);
        const v = ld.meta.versions.find(x => x.id === parts[3]);
        if (!v) throw new HttpError(404, 'not_found', 'version not found');
        ld.doc.pendingOps();
        ld.doc.restore(v.snapshot);
        const envs = ld.doc.pendingOps();
        const { seq } = appendOps(ld, envs);
        return sendJson(res, 200, { seq, restored: v.id });
      }
    }

    if (sub === 'comments') {
      const ld = requireDoc(id);
      if (parts.length === 3 && method === 'GET') {
        requireRole(ld, user);
        const roots = ld.meta.comments.filter(c => !c.parentId);
        return sendJson(res, 200, roots.map(r => ({
          ...r,
          replies: ld.meta.comments.filter(c => c.parentId === r.id),
        })));
      }
      if (parts.length === 3 && method === 'POST') {
        requireRole(ld, user);
        const body = await readJsonBody(req);
        if (typeof body.body !== 'string' || !body.body.trim()) throw badRequest('body is required');
        let parentId = null;
        if (body.parentId) {
          const parent = ld.meta.comments.find(c => c.id === body.parentId);
          if (!parent) throw new HttpError(404, 'not_found', 'parent comment not found');
          parentId = parent.id;
        }
        const elementId = parentId ? ld.meta.comments.find(c => c.id === parentId).elementId : body.elementId;
        if (typeof elementId !== 'string' || !ld.doc.get(elementId)) {
          throw new HttpError(404, 'not_found', 'anchor element not found');
        }
        const c = {
          id: crypto.randomBytes(6).toString('hex'),
          elementId,
          parentId,
          author: user.username,
          body: body.body.slice(0, 5000),
          resolved: false,
          createdAt: isoNow(),
        };
        ld.meta.comments.push(c);
        saveMeta(ld.meta);
        return sendJson(res, 201, c);
      }
      if (parts.length === 5 && parts[4] === 'resolve' && method === 'POST') {
        requireRole(ld, user);
        const c = ld.meta.comments.find(x => x.id === parts[3] && !x.parentId);
        if (!c) throw new HttpError(404, 'not_found', 'comment thread not found');
        const body = await readJsonBody(req);
        c.resolved = body.resolved === undefined ? true : !!body.resolved;
        saveMeta(ld.meta);
        return sendJson(res, 200, c);
      }
    }

    if (sub === 'export.svg' && parts.length === 3 && method === 'GET') {
      const ld = requireDoc(id);
      requireRole(ld, user);
      const svg = ld.doc.toSVG();
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Content-Disposition': `attachment; filename="${id}.svg"` });
      return res.end(svg);
    }
    if (sub === 'export.json' && parts.length === 3 && method === 'GET') {
      const ld = requireDoc(id);
      requireRole(ld, user);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="${id}.json"` });
      return res.end(JSON.stringify(ld.doc.toJSON(), null, 2));
    }

    throw new HttpError(404, 'not_found', 'no such route');
  }

  // /static/* -> src/public; /static/lib/core/* -> src/core; /static/lib/vendor/* -> src/vendor
  const STATIC_ROOTS = [
    ['/static/lib/core/', path.join(HERE, 'core')],
    ['/static/lib/vendor/', path.join(HERE, 'vendor')],
    ['/static/', PUBLIC_DIR],
  ];

  function serveStatic(req, res, url) {
    let root = null;
    let rel;
    if (url.pathname === '/') {
      root = PUBLIC_DIR;
      rel = 'index.html';
    } else {
      for (const [prefix, dir] of STATIC_ROOTS) {
        if (url.pathname.startsWith(prefix)) { root = dir; rel = url.pathname.slice(prefix.length); break; }
      }
    }
    const file = root && rel ? path.resolve(root, decodeURIComponent(rel)) : null;
    if (!file || !file.startsWith(root + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer((req, res) => {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return sendError(res, badRequest('bad url'));
    }
    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url).catch(err => sendError(res, err));
    } else {
      serveStatic(req, res, url);
    }
  });

  server.on('upgrade', (req, socket) => {
    const reject = (status, text) => {
      socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    try {
      const url = new URL(req.url, 'http://localhost');
      const m = url.pathname.match(/^\/ws\/docs\/([^/]+)$/);
      if (!m) return reject(404, 'Not Found');
      if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !req.headers['sec-websocket-key']) {
        return reject(400, 'Bad Request');
      }
      let user;
      try { user = authenticate(req, url); } catch { return reject(401, 'Unauthorized'); }
      if (!ID_RE.test(m[1])) return reject(404, 'Not Found');
      const ld = getLive(m[1]);
      if (!ld) return reject(404, 'Not Found');
      const role = roleOf(ld.meta, user.username);
      if (!role) return reject(403, 'Forbidden');

      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(req.headers['sec-websocket-key'])}\r\n\r\n`);
      setupSocket(ld, user, role, socket);
    } catch {
      reject(500, 'Internal Server Error');
    }
  });

  function setupSocket(ld, user, role, socket) {
    const conn = {
      send(opcode, data) {
        if (socket.destroyed) return;
        socket.write(encodeFrame(opcode, Buffer.from(String(data), 'utf8')));
      },
      close() {
        if (!socket.destroyed) socket.end(encodeFrame(8, Buffer.alloc(0)));
        ld.sockets.delete(conn);
      },
    };
    ld.sockets.add(conn);
    const parser = new FrameParser({
      onPing: payload => { if (!socket.destroyed) socket.write(encodeFrame(10, payload)); },
      onClose: () => { ld.sockets.delete(conn); socket.end(); },
      onMessage: (opcode, data) => {
        let msg;
        try { msg = JSON.parse(data.toString('utf8')); } catch { return conn.send(1, JSON.stringify({ type: 'error', message: 'invalid JSON' })); }
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'ops') {
          if (role === 'viewer') return conn.send(1, JSON.stringify({ type: 'error', message: 'viewers cannot edit' }));
          try {
            const { seq } = appendOps(ld, msg.ops);
            conn.send(1, JSON.stringify({ type: 'ack', seq }));
          } catch (err) {
            conn.send(1, JSON.stringify({ type: 'error', message: err.message }));
          }
        } else if (msg.type === 'presence') {
          const out = JSON.stringify({
            type: 'presence',
            actor: typeof msg.actor === 'string' ? msg.actor : user.username,
            cursor: msg.cursor ?? null,
            selection: Array.isArray(msg.selection) ? msg.selection : [],
          });
          for (const s of ld.sockets) if (s !== conn) s.send(1, out);
        } else if (msg.type === 'ping') {
          conn.send(1, JSON.stringify({ type: 'pong' }));
        }
      },
    });
    socket.on('data', chunk => parser.push(chunk));
    socket.on('close', () => ld.sockets.delete(conn));
    socket.on('error', () => ld.sockets.delete(conn));
    conn.send(1, JSON.stringify({ type: 'hello', seq: ld.log.length, role }));
  }

  return server;
}
