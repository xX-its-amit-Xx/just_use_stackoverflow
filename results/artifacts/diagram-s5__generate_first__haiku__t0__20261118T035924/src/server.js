// Collaboration server: JSON API, long-poll and WebSocket sync, persistence, static files.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDocument, fromJSON, toSVG, DiagramError } from './core/index.js';
import { handshakeResponse, encodeFrame, FrameParser } from './ws.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(HERE, 'static');
const CORE_DIR = path.join(HERE, 'core');
const MAX_BODY = 20 * 1024 * 1024;
const POLL_TIMEOUT_MS = 25000;
const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const fail = (status, code, message) => {
  throw new HttpError(status, code, message);
};

function sendJSON(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function sendError(res, status, code, message) {
  sendJSON(res, status, { error: code, message });
}

function readJSON(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'too_large', 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'bad_json', 'invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function writeFileAtomic(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

function readJSONFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function requireString(body, key, { max = 10000, optional = false } = {}) {
  const v = body?.[key];
  if (v === undefined && optional) return undefined;
  if (typeof v !== 'string' || v.trim() === '' || v.length > max) fail(400, 'bad_request', `${key} must be a non-empty string`);
  return v;
}

/**
 * Creates the HTTP server. Data layout under dataDir:
 *   users.json, sessions.json, docs/<id>.json (metadata + snapshot), docs/<id>.log (op log, JSON lines)
 */
export function createServer({ dataDir }) {
  const docsDir = path.join(dataDir, 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  const usersFile = path.join(dataDir, 'users.json');
  const sessionsFile = path.join(dataDir, 'sessions.json');

  let users = readJSONFile(usersFile, { users: [] }).users;
  let sessions = readJSONFile(sessionsFile, {});
  const docs = new Map();

  const saveUsers = () => writeFileAtomic(usersFile, JSON.stringify({ users }, null, 2));
  const saveSessions = () => writeFileAtomic(sessionsFile, JSON.stringify(sessions));

  // ----- document runtime -----
  function persistDoc(rt) {
    const payload = { meta: rt.meta, state: rt.doc.toJSON() };
    writeFileAtomic(path.join(docsDir, `${rt.meta.id}.json`), JSON.stringify(payload));
  }

  function loadDoc(id) {
    const file = path.join(docsDir, `${id}.json`);
    const payload = readJSONFile(file, null);
    if (!payload) return null;
    const meta = payload.meta;
    const doc = fromJSON(payload.state, { actor: 'server' });
    const log = [];
    const logFile = path.join(docsDir, `${id}.log`);
    if (fs.existsSync(logFile)) {
      for (const line of fs.readFileSync(logFile, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          log.push(JSON.parse(line));
        } catch {
          break; // torn last line after a crash
        }
      }
    }
    const seen = new Set();
    for (const entry of log) {
      for (const op of entry.ops) seen.add(typeof op.oid === 'string' ? op.oid : JSON.stringify(op));
      if (entry.seq > meta.seq) doc.receive(entry.ops);
    }
    const seq = log.length ? Math.max(meta.seq, log[log.length - 1].seq) : meta.seq;
    meta.seq = seq;
    return { meta, doc, log, seen, waiters: new Set(), clients: new Set() };
  }

  for (const f of fs.readdirSync(docsDir)) {
    if (!f.endsWith('.json')) continue;
    const rt = loadDoc(f.slice(0, -5));
    if (rt) docs.set(rt.meta.id, rt);
  }

  function getDoc(id) {
    const rt = docs.get(id);
    if (!rt) fail(404, 'not_found', 'document not found');
    return rt;
  }

  function roleOf(rt, username) {
    if (rt.meta.owner === username) return 'owner';
    return rt.meta.shares[username] ?? null;
  }

  function requireRole(rt, user, min) {
    const role = roleOf(rt, user.username);
    if (!role) fail(404, 'not_found', 'document not found');
    if (ROLE_RANK[role] < ROLE_RANK[min]) fail(403, 'forbidden', `requires ${min} role`);
    return role;
  }

  function summary(rt, username) {
    const { id, title, owner, createdAt, updatedAt, seq } = rt.meta;
    return { id, title, owner, role: roleOf(rt, username), createdAt, updatedAt, seq };
  }

  /** Applies client ops to the replica, appends them to the log and broadcasts. */
  function acceptOps(rt, ops, sender) {
    if (!Array.isArray(ops)) fail(400, 'bad_request', 'ops must be an array');
    const fresh = ops.filter((op) => !rt.seen.has(opKey(op)));
    try {
      rt.doc.receive(fresh);
    } catch (err) {
      fail(400, 'bad_op', err.message);
    }
    return commit(rt, fresh, sender);
  }

  function opKey(op) {
    return op && typeof op.oid === 'string' ? op.oid : JSON.stringify(op);
  }

  function commit(rt, ops, sender) {
    if (ops.length === 0) return rt.meta.seq;
    rt.meta.seq += 1;
    rt.meta.updatedAt = new Date().toISOString();
    const entry = { seq: rt.meta.seq, ops };
    rt.log.push(entry);
    for (const op of ops) rt.seen.add(opKey(op));
    fs.appendFileSync(path.join(docsDir, `${rt.meta.id}.log`), JSON.stringify(entry) + '\n');
    persistDoc(rt);
    for (const w of rt.waiters) w();
    rt.waiters.clear();
    const msg = encodeFrame(1, Buffer.from(JSON.stringify({ type: 'ops', ops, seq: rt.meta.seq })));
    for (const c of rt.clients) {
      if (c !== sender) c.socket.write(msg);
    }
    return rt.meta.seq;
  }

  function serverOpsAfterLocalChange(rt, mutate) {
    mutate();
    const ops = rt.doc.pendingOps();
    return commit(rt, ops, null);
  }

  // ----- auth -----
  function authUser(req) {
    const h = req.headers.authorization ?? '';
    const token = h.startsWith('Bearer ') ? h.slice(7).trim() : null;
    if (!token) fail(401, 'unauthorized', 'missing bearer token');
    return authUserFromToken(token);
  }

  function authUserFromToken(token) {
    const s = sessions[token];
    if (!s) fail(401, 'unauthorized', 'invalid token');
    const user = users.find((u) => u.username === s.username);
    if (!user) fail(401, 'unauthorized', 'invalid token');
    return { username: user.username, id: user.id };
  }

  // ----- API handlers -----
  async function api(req, res, url) {
    const p = url.pathname;
    const m = req.method;
    if (p === '/api/auth/register' && m === 'POST') {
      const body = await readJSON(req);
      const username = requireString(body, 'username', { max: 32 });
      const password = requireString(body, 'password', { max: 1000 });
      if (!/^[A-Za-z0-9_.-]{1,32}$/.test(username)) fail(400, 'bad_request', 'invalid username');
      if (users.some((u) => u.username === username)) fail(409, 'conflict', 'username taken');
      const salt = crypto.randomBytes(16).toString('hex');
      const user = { id: crypto.randomUUID(), username, salt, hash: hashPassword(password, salt) };
      users.push(user);
      saveUsers();
      return sendJSON(res, 201, { user: { id: user.id, username } });
    }
    if (p === '/api/auth/login' && m === 'POST') {
      const body = await readJSON(req);
      const username = requireString(body, 'username', { max: 32 });
      const password = requireString(body, 'password', { max: 1000 });
      const user = users.find((u) => u.username === username);
      if (!user || hashPassword(password, user.salt) !== user.hash) fail(401, 'unauthorized', 'invalid credentials');
      const token = crypto.randomBytes(32).toString('hex');
      sessions[token] = { username, createdAt: new Date().toISOString() };
      saveSessions();
      return sendJSON(res, 200, { token, user: { id: user.id, username } });
    }

    if (!p.startsWith('/api/')) fail(404, 'not_found', 'no such route');
    const user = authUser(req);

    if (p === '/api/docs' && m === 'POST') {
      const body = await readJSON(req);
      const title = body.title === undefined ? 'Untitled' : requireString(body, 'title', { max: 200 });
      const id = crypto.randomUUID();
      const now = new Date().toISOString();
      const doc = createDocument({ id, actor: 'server' });
      const rt = {
        meta: { id, title, owner: user.username, shares: {}, versions: [], comments: [], seq: 0, createdAt: now, updatedAt: now },
        doc,
        log: [],
        seen: new Set(),
        waiters: new Set(),
        clients: new Set(),
      };
      docs.set(id, rt);
      persistDoc(rt);
      return sendJSON(res, 201, summary(rt, user.username));
    }
    if (p === '/api/docs' && m === 'GET') {
      const list = [...docs.values()].filter((rt) => roleOf(rt, user.username)).map((rt) => summary(rt, user.username));
      return sendJSON(res, 200, { docs: list });
    }

    const parts = p.split('/').filter(Boolean); // api, docs, :id, ...
    if (parts[1] !== 'docs' || parts.length < 3) fail(404, 'not_found', 'no such route');
    const id = parts[2];
    const rest = parts.slice(3);
    const rt = getDoc(id);

    if (rest.length === 0 && m === 'GET') {
      requireRole(rt, user, 'viewer');
      return sendJSON(res, 200, {
        ...rt.doc.toJSON(),
        title: rt.meta.title,
        owner: rt.meta.owner,
        role: roleOf(rt, user.username),
        seq: rt.meta.seq,
        createdAt: rt.meta.createdAt,
        updatedAt: rt.meta.updatedAt,
      });
    }
    if (rest.length === 0 && m === 'DELETE') {
      requireRole(rt, user, 'owner');
      docs.delete(id);
      for (const c of rt.clients) c.socket.destroy();
      for (const f of [`${id}.json`, `${id}.log`]) fs.rmSync(path.join(docsDir, f), { force: true });
      res.writeHead(204);
      return res.end();
    }

    if (rest[0] === 'share' && m === 'POST') {
      requireRole(rt, user, 'owner');
      const body = await readJSON(req);
      const target = requireString(body, 'username', { max: 32 });
      const role = body.role;
      if (role !== 'editor' && role !== 'viewer') fail(400, 'bad_request', 'role must be editor or viewer');
      if (!users.some((u) => u.username === target)) fail(404, 'not_found', 'user not found');
      if (target === rt.meta.owner) fail(400, 'bad_request', 'cannot share with the owner');
      rt.meta.shares[target] = role;
      persistDoc(rt);
      return sendJSON(res, 200, { id, shares: rt.meta.shares });
    }

    if (rest[0] === 'ops' && m === 'POST') {
      requireRole(rt, user, 'editor');
      const body = await readJSON(req);
      const seq = acceptOps(rt, body.ops, null);
      return sendJSON(res, 200, { seq });
    }
    if (rest[0] === 'ops' && m === 'GET') {
      requireRole(rt, user, 'viewer');
      const since = Number(url.searchParams.get('since') ?? 0) || 0;
      const wait = url.searchParams.get('wait') === '1';
      const collect = () => {
        const entries = rt.log.filter((e) => e.seq > since);
        return { ops: entries.flatMap((e) => e.ops), seq: rt.meta.seq };
      };
      const first = collect();
      if (first.ops.length > 0 || !wait || rt.meta.seq > since) return sendJSON(res, 200, first);
      await new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          rt.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, POLL_TIMEOUT_MS);
        rt.waiters.add(done);
        req.on('close', () => {
          if (rt.waiters.has(done)) done();
        });
      });
      return sendJSON(res, 200, collect());
    }

    if (rest[0] === 'versions' && rest.length === 1 && m === 'POST') {
      requireRole(rt, user, 'editor');
      const body = await readJSON(req);
      const label = requireString(body, 'label', { max: 200, optional: true }) ?? `Version ${rt.meta.versions.length + 1}`;
      const v = {
        id: crypto.randomUUID(),
        label,
        seq: rt.meta.seq,
        createdAt: new Date().toISOString(),
        createdBy: user.username,
        snapshot: rt.doc.toJSON(),
      };
      rt.meta.versions.push(v);
      persistDoc(rt);
      const { snapshot, ...meta } = v;
      return sendJSON(res, 201, meta);
    }
    if (rest[0] === 'versions' && rest.length === 1 && m === 'GET') {
      requireRole(rt, user, 'viewer');
      return sendJSON(res, 200, { versions: rt.meta.versions.map(({ snapshot, ...meta }) => meta) });
    }
    if (rest[0] === 'versions' && rest.length === 3 && rest[2] === 'restore' && m === 'POST') {
      requireRole(rt, user, 'editor');
      const v = rt.meta.versions.find((x) => x.id === rest[1]);
      if (!v) fail(404, 'not_found', 'version not found');
      const seq = serverOpsAfterLocalChange(rt, () => restoreSnapshot(rt.doc, v.snapshot));
      return sendJSON(res, 200, { seq, restored: v.id });
    }

    if (rest[0] === 'comments' && rest.length === 1 && m === 'GET') {
      requireRole(rt, user, 'viewer');
      return sendJSON(res, 200, { comments: rt.meta.comments });
    }
    if (rest[0] === 'comments' && rest.length === 1 && m === 'POST') {
      requireRole(rt, user, 'viewer');
      const body = await readJSON(req);
      const text = requireString(body, 'text', { max: 5000 });
      const elementId = body.elementId ?? null;
      if (elementId !== null && (typeof elementId !== 'string' || !rt.doc.get(elementId))) {
        fail(404, 'not_found', 'anchor element not found');
      }
      const c = {
        id: crypto.randomUUID(),
        elementId,
        author: user.username,
        text,
        createdAt: new Date().toISOString(),
        resolved: false,
        replies: [],
      };
      rt.meta.comments.push(c);
      persistDoc(rt);
      return sendJSON(res, 201, c);
    }
    if (rest[0] === 'comments' && rest.length === 3 && rest[2] === 'replies' && m === 'POST') {
      requireRole(rt, user, 'viewer');
      const c = rt.meta.comments.find((x) => x.id === rest[1]);
      if (!c) fail(404, 'not_found', 'comment not found');
      const body = await readJSON(req);
      const text = requireString(body, 'text', { max: 5000 });
      const reply = { id: crypto.randomUUID(), author: user.username, text, createdAt: new Date().toISOString() };
      c.replies.push(reply);
      persistDoc(rt);
      return sendJSON(res, 201, reply);
    }
    if (rest[0] === 'comments' && rest.length === 3 && rest[2] === 'resolve' && m === 'POST') {
      requireRole(rt, user, 'viewer');
      const c = rt.meta.comments.find((x) => x.id === rest[1]);
      if (!c) fail(404, 'not_found', 'comment not found');
      const body = await readJSON(req);
      c.resolved = body.resolved === undefined ? true : Boolean(body.resolved);
      persistDoc(rt);
      return sendJSON(res, 200, c);
    }

    if (rest[0] === 'export.svg' && m === 'GET') {
      requireRole(rt, user, 'viewer');
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8' });
      return res.end(toSVG(rt.doc));
    }
    if (rest[0] === 'export.json' && m === 'GET') {
      requireRole(rt, user, 'viewer');
      res.writeHead(200, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="${rt.meta.id}.json"`,
      });
      return res.end(JSON.stringify(rt.doc.toJSON(), null, 2));
    }

    fail(404, 'not_found', 'no such route');
  }

  /** Makes the replica's visible state equal to a snapshot, using ordinary operations. */
  function restoreSnapshot(doc, snap) {
    const current = new Map(doc.elements().map((e) => [e.id, e]));
    const wanted = new Map(snap.elements.map((e) => [e.id, e]));
    doc.transaction(() => {
      for (const l of snap.layers) {
        if (doc.layers().some((x) => x.id === l.id)) doc.apply({ type: 'updateLayer', id: l.id, patch: { locked: false, visible: true } });
        else doc.apply({ type: 'addLayer', layer: { id: l.id, name: l.name, visible: true, locked: false } });
      }
      for (const l of doc.layers()) {
        if (!snap.layers.some((x) => x.id === l.id) && l.id !== 'default') doc.apply({ type: 'removeLayer', id: l.id });
      }
      for (const [id] of current) if (!wanted.has(id)) doc.apply({ type: 'remove', id });
      const shapes = snap.elements.filter((e) => e.type !== 'connector');
      const conns = snap.elements.filter((e) => e.type === 'connector');
      for (const e of shapes) {
        const { id, type, style, ...rest } = e;
        if (current.has(id)) doc.apply({ type: 'update', id, patch: rest });
        else doc.apply({ type: 'add', element: { ...rest, id, type, style: {} } });
        doc.apply({ type: 'setStyle', ids: [id], style });
      }
      for (const e of conns) {
        const { id, type, style, ...rest } = e;
        if (current.has(id)) doc.apply({ type: 'remove', id });
        doc.apply({ type: 'add', element: { ...rest, id, type, style: {} } });
        doc.apply({ type: 'setStyle', ids: [id], style });
      }
      for (const l of snap.layers) doc.apply({ type: 'updateLayer', id: l.id, patch: { locked: l.locked, visible: l.visible, name: l.name, order: l.order } });
    });
  }

  // ----- WebSocket -----
  function handleUpgrade(req, socket, head) {
    const url = new URL(req.url, 'http://localhost');
    const m = /^\/ws\/docs\/([A-Za-z0-9-]+)$/.exec(url.pathname);
    const reject = (code, text) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (!m) return reject(404, 'Not Found');
    let user;
    try {
      user = authUserFromToken(url.searchParams.get('token') ?? '');
    } catch {
      return reject(401, 'Unauthorized');
    }
    const rt = docs.get(m[1]);
    if (!rt) return reject(404, 'Not Found');
    const role = roleOf(rt, user.username);
    if (!role) return reject(404, 'Not Found');
    const key = req.headers['sec-websocket-key'];
    if (!key) return reject(400, 'Bad Request');
    socket.write(handshakeResponse(key));
    const client = { socket, user: user.username, role, parser: new FrameParser(), actor: null };
    rt.clients.add(client);
    socket.write(encodeFrame(1, Buffer.from(JSON.stringify({ type: 'hello', seq: rt.meta.seq, role }))));
    const drop = () => rt.clients.delete(client);
    socket.on('error', drop);
    socket.on('close', drop);
    socket.on('data', (chunk) => {
      let messages;
      try {
        messages = client.parser.feed(chunk);
      } catch {
        socket.destroy();
        return;
      }
      for (const msg of messages) {
        if (msg.opcode === 8) {
          socket.end(encodeFrame(8));
          drop();
          return;
        }
        if (msg.opcode === 9) {
          socket.write(encodeFrame(10, msg.payload));
          continue;
        }
        if (msg.opcode !== 1) continue;
        let data;
        try {
          data = JSON.parse(msg.payload.toString('utf8'));
        } catch {
          continue;
        }
        handleWsMessage(rt, client, data);
      }
    });
  }

  function send(client, obj) {
    client.socket.write(encodeFrame(1, Buffer.from(JSON.stringify(obj))));
  }

  function handleWsMessage(rt, client, data) {
    if (!data || typeof data !== 'object') return;
    if (data.type === 'ops') {
      if (ROLE_RANK[client.role] < ROLE_RANK.editor) return send(client, { type: 'error', error: 'forbidden' });
      try {
        const seq = acceptOps(rt, data.ops, client);
        send(client, { type: 'ack', seq });
      } catch (err) {
        send(client, { type: 'error', error: err.code ?? 'bad_op', message: err.message });
      }
      return;
    }
    if (data.type === 'presence') {
      const out = {
        type: 'presence',
        actor: typeof data.actor === 'string' ? data.actor : client.user,
        user: client.user,
        cursor: data.cursor ?? null,
        selection: Array.isArray(data.selection) ? data.selection : [],
      };
      client.actor = out.actor;
      const frame = encodeFrame(1, Buffer.from(JSON.stringify(out)));
      for (const c of rt.clients) if (c !== client) c.socket.write(frame);
    }
  }

  // ----- static & routing -----
  function serveStatic(res, baseDir, rel) {
    const file = path.normalize(path.join(baseDir, rel));
    if (!file.startsWith(baseDir + path.sep)) return sendError(res, 404, 'not_found', 'not found');
    fs.readFile(file, (err, data) => {
      if (err) return sendError(res, 404, 'not_found', 'not found');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    });
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname === '/' || url.pathname === '/index.html') return serveStatic(res, STATIC_DIR, 'index.html');
      if (url.pathname.startsWith('/static/core/')) return serveStatic(res, CORE_DIR, url.pathname.slice('/static/core/'.length));
      if (url.pathname.startsWith('/static/')) return serveStatic(res, STATIC_DIR, url.pathname.slice('/static/'.length));
      await api(req, res, url);
    } catch (err) {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) return sendError(res, err.status, err.code, err.message);
      if (err instanceof DiagramError) return sendError(res, 400, err.code ?? 'bad_request', err.message);
      sendError(res, 500, 'internal', 'internal error');
    }
  }

  const server = http.createServer((req, res) => {
    route(req, res);
  });
  server.on('upgrade', (req, socket, head) => {
    handleUpgrade(req, socket, head);
  });
  return server;
}
