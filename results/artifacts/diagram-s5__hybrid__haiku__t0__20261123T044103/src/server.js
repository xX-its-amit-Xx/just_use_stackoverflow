// Collaboration server: REST + long-poll + WebSocket on node:http, file persistence.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createDocument, DiagramError } from './core/index.js';
import { diffOps } from './diff.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(HERE, 'static');
const CORE_DIR = path.join(HERE, 'core');
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const LONG_POLL_MS = 25000;
const MAX_BODY = 5 * 1024 * 1024;
const ROLES = new Set(['editor', 'viewer']);
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
  constructor(status, error, message) {
    super(message);
    this.status = status;
    this.error = error;
  }
}

const ERROR_NAMES = { 400: 'bad_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'conflict' };

function send(res, status, body) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function sendError(res, status, message) {
  send(res, status, { error: ERROR_NAMES[status] ?? 'error', message });
}

function writeFileAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function checkPassword(password, rec) {
  const { hash } = hashPassword(password, rec.salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(rec.hash, 'hex'));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(400, 'bad_request', 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJSON(req) {
  const text = await readBody(req);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'bad_request', 'invalid JSON body');
  }
}

// ---- WebSocket framing (RFC 6455, server side, no dependencies) -------------
function wsFrame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

function wsParse(buf) {
  const frames = [];
  let rest = buf;
  while (rest.length >= 2) {
    const fin = (rest[0] & 0x80) !== 0;
    const opcode = rest[0] & 0x0f;
    const masked = (rest[1] & 0x80) !== 0;
    let len = rest[1] & 0x7f;
    let off = 2;
    if (len === 126) {
      if (rest.length < 4) break;
      len = rest.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (rest.length < 10) break;
      len = Number(rest.readBigUInt64BE(2));
      off = 10;
    }
    const need = off + (masked ? 4 : 0) + len;
    if (rest.length < need) break;
    let mask = null;
    if (masked) {
      mask = rest.subarray(off, off + 4);
      off += 4;
    }
    const payload = Buffer.from(rest.subarray(off, off + len));
    if (mask) for (let i = 0; i < len; i++) payload[i] ^= mask[i % 4];
    frames.push({ fin, opcode, payload });
    rest = rest.subarray(need);
  }
  return { frames, rest };
}

// ---- server -----------------------------------------------------------------
export function createServer({ dataDir }) {
  if (!dataDir) throw new Error('dataDir is required');
  const docsDir = path.join(dataDir, 'docs');
  const usersFile = path.join(dataDir, 'users.json');
  fs.mkdirSync(docsDir, { recursive: true });

  let users = { users: {}, tokens: {} };
  if (fs.existsSync(usersFile)) users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
  const saveUsers = () => writeFileAtomic(usersFile, JSON.stringify(users));

  const docs = new Map(); // id -> record

  const metaFile = (id) => path.join(docsDir, `${id}.json`);
  const logFile = (id) => path.join(docsDir, `${id}.log`);

  function saveMeta(rec) {
    const { id, title, owner, members, createdAt, versions, comments } = rec.meta;
    writeFileAtomic(metaFile(id), JSON.stringify({ id, title, owner, members, createdAt, versions, comments }));
  }

  function loadDocs() {
    for (const f of fs.readdirSync(docsDir)) {
      if (!f.endsWith('.json')) continue;
      const meta = JSON.parse(fs.readFileSync(path.join(docsDir, f), 'utf8'));
      const doc = createDocument({ id: meta.id, actor: 'server' });
      const log = [];
      const lf = logFile(meta.id);
      if (fs.existsSync(lf)) {
        for (const line of fs.readFileSync(lf, 'utf8').split('\n')) {
          if (line.trim()) log.push(JSON.parse(line));
        }
      }
      if (log.length) doc.receive(log);
      docs.set(meta.id, { meta, doc, log, ids: new Set(log.map((e) => e.id)), waiters: [], sockets: new Set() });
    }
  }
  loadDocs();

  const userOf = (req) => {
    const h = req.headers.authorization ?? '';
    const m = /^Bearer\s+(\S+)$/.exec(h);
    if (!m) return null;
    return users.tokens[m[1]] ?? null;
  };

  const roleOf = (rec, username) => {
    if (!rec || !username) return null;
    if (rec.meta.owner === username) return 'owner';
    return rec.meta.members[username] ?? null;
  };

  function requireUser(req) {
    const u = userOf(req);
    if (!u) throw new HttpError(401, 'unauthorized', 'missing or invalid token');
    return u;
  }

  function requireDoc(username, id, minRole = 'viewer') {
    const rec = docs.get(id);
    const role = roleOf(rec, username);
    if (!rec || !role) throw new HttpError(404, 'not_found', 'document not found');
    if (minRole === 'owner' && role !== 'owner') throw new HttpError(403, 'forbidden', 'owner only');
    if (minRole === 'editor' && role === 'viewer') throw new HttpError(403, 'forbidden', 'editor role required');
    return { rec, role };
  }

  function notify(rec) {
    const pending = rec.waiters;
    rec.waiters = [];
    for (const w of pending) {
      if (rec.log.length > w.since) w.done(); else rec.waiters.push(w);
    }
  }

  function broadcast(rec, msg, except = null) {
    const data = wsFrame(0x1, Buffer.from(JSON.stringify(msg)));
    for (const s of rec.sockets) if (s !== except) s.write(data);
  }

  // Append envelopes (from clients or server-generated) to the document log.
  function appendOps(rec, envs) {
    const fresh = [];
    for (const env of envs) {
      if (rec.ids.has(env.id)) continue;
      rec.ids.add(env.id);
      rec.log.push(env);
      fresh.push(env);
    }
    if (fresh.length) {
      fs.appendFileSync(logFile(rec.meta.id), fresh.map((e) => `${JSON.stringify(e)}\n`).join(''));
      notify(rec);
    }
    return fresh;
  }

  function acceptOps(rec, ops) {
    if (!Array.isArray(ops)) throw new HttpError(400, 'bad_request', 'ops must be an array');
    const fresh = ops.filter((e) => e && typeof e.id === 'string' && !rec.ids.has(e.id));
    try {
      rec.doc.receive(ops);
    } catch (e) {
      if (e instanceof DiagramError) throw new HttpError(400, 'bad_request', e.message);
      throw e;
    }
    const added = appendOps(rec, fresh.map((e) => structuredClone(e)));
    if (added.length) broadcast(rec, { type: 'ops', ops: added, seq: rec.log.length });
    return rec.log.length;
  }

  // Apply server-generated ops (e.g. version restore) through the document replica.
  function applyServerOps(rec, fn) {
    try {
      rec.doc.transaction(fn);
    } catch (e) {
      if (e instanceof DiagramError) throw new HttpError(409, 'conflict', e.message);
      throw e;
    }
    const envs = rec.doc.pendingOps();
    const added = appendOps(rec, envs);
    if (added.length) broadcast(rec, { type: 'ops', ops: added, seq: rec.log.length });
    return rec.log.length;
  }

  function docSummary(rec, role) {
    return {
      id: rec.meta.id,
      title: rec.meta.title,
      owner: rec.meta.owner,
      role,
      createdAt: rec.meta.createdAt,
      seq: rec.log.length,
    };
  }

  // ---- REST handlers ----------------------------------------------------------
  async function handleApi(req, res, url) {
    const p = url.pathname;
    const method = req.method;

    if (p === '/api/auth/register' && method === 'POST') {
      const body = await readJSON(req);
      const { username, password } = body;
      if (typeof username !== 'string' || !/^[A-Za-z0-9_.-]{1,32}$/.test(username)) {
        throw new HttpError(400, 'bad_request', 'invalid username');
      }
      if (typeof password !== 'string' || password.length < 6) {
        throw new HttpError(400, 'bad_request', 'password must be at least 6 characters');
      }
      if (users.users[username]) throw new HttpError(409, 'conflict', 'username taken');
      const { salt, hash } = hashPassword(password);
      users.users[username] = { username, salt, hash, createdAt: new Date().toISOString() };
      saveUsers();
      return send(res, 201, { user: { username } });
    }

    if (p === '/api/auth/login' && method === 'POST') {
      const body = await readJSON(req);
      const rec = typeof body.username === 'string' ? users.users[body.username] : undefined;
      if (!rec || typeof body.password !== 'string' || !checkPassword(body.password, rec)) {
        throw new HttpError(401, 'unauthorized', 'invalid username or password');
      }
      const token = crypto.randomBytes(24).toString('hex');
      users.tokens[token] = rec.username;
      saveUsers();
      return send(res, 200, { token, user: { username: rec.username } });
    }

    if (!p.startsWith('/api/')) throw new HttpError(404, 'not_found', 'no such route');
    const username = requireUser(req);

    if (p === '/api/docs' && method === 'POST') {
      const body = await readJSON(req);
      const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 200) : 'Untitled';
      const id = crypto.randomUUID();
      const meta = { id, title, owner: username, members: {}, createdAt: new Date().toISOString(), versions: [], comments: [] };
      const rec = { meta, doc: createDocument({ id, actor: 'server' }), log: [], ids: new Set(), waiters: [], sockets: new Set() };
      docs.set(id, rec);
      saveMeta(rec);
      return send(res, 201, docSummary(rec, 'owner'));
    }

    if (p === '/api/docs' && method === 'GET') {
      const out = [];
      for (const rec of docs.values()) {
        const role = roleOf(rec, username);
        if (role) out.push(docSummary(rec, role));
      }
      out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
      return send(res, 200, out);
    }

    const m = /^\/api\/docs\/([^/]+)(\/.*)?$/.exec(p);
    if (!m) throw new HttpError(404, 'not_found', 'no such route');
    const id = decodeURIComponent(m[1]);
    const sub = m[2] ?? '';

    if (sub === '' && method === 'GET') {
      const { rec, role } = requireDoc(username, id);
      return send(res, 200, {
        ...rec.doc.toJSON(),
        title: rec.meta.title,
        owner: rec.meta.owner,
        members: rec.meta.members,
        createdAt: rec.meta.createdAt,
        role,
        seq: rec.log.length,
      });
    }

    if (sub === '' && method === 'DELETE') {
      const { rec } = requireDoc(username, id, 'owner');
      docs.delete(id);
      for (const s of rec.sockets) s.destroy();
      for (const f of [metaFile(id), logFile(id)]) if (fs.existsSync(f)) fs.unlinkSync(f);
      return send(res, 200, { deleted: true, id });
    }

    if (sub === '/share' && method === 'POST') {
      const { rec } = requireDoc(username, id, 'owner');
      const body = await readJSON(req);
      if (typeof body.username !== 'string' || !users.users[body.username]) {
        throw new HttpError(404, 'not_found', 'user not found');
      }
      if (!ROLES.has(body.role)) throw new HttpError(400, 'bad_request', 'role must be editor or viewer');
      if (body.username === rec.meta.owner) throw new HttpError(400, 'bad_request', 'owner already has access');
      rec.meta.members[body.username] = body.role;
      saveMeta(rec);
      return send(res, 200, { id, members: rec.meta.members });
    }

    if (sub === '/ops' && method === 'POST') {
      const { rec } = requireDoc(username, id, 'editor');
      const body = await readJSON(req);
      const seq = acceptOps(rec, body.ops);
      return send(res, 200, { seq });
    }

    if (sub === '/ops' && method === 'GET') {
      const { rec } = requireDoc(username, id);
      const since = url.searchParams.get('since') ?? '0';
      if (!/^\d+$/.test(since)) throw new HttpError(400, 'bad_request', 'since must be a non-negative integer');
      const from = Number(since);
      const wait = url.searchParams.get('wait') === '1';
      if (rec.log.length > from || !wait) {
        return send(res, 200, { ops: rec.log.slice(from), seq: rec.log.length });
      }
      await new Promise((resolve) => {
        const w = { since: from, done: () => { clearTimeout(w.timer); resolve(); } };
        w.timer = setTimeout(() => {
          rec.waiters = rec.waiters.filter((x) => x !== w);
          resolve();
        }, LONG_POLL_MS);
        rec.waiters.push(w);
      });
      if (!docs.has(id)) throw new HttpError(404, 'not_found', 'document not found');
      return send(res, 200, { ops: rec.log.slice(from), seq: rec.log.length });
    }

    if (sub === '/versions' && method === 'POST') {
      const { rec } = requireDoc(username, id, 'editor');
      const body = await readJSON(req);
      const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim().slice(0, 200) : 'Version';
      const v = {
        id: crypto.randomUUID(),
        label,
        seq: rec.log.length,
        createdAt: new Date().toISOString(),
        author: username,
        snapshot: rec.doc.toJSON(),
      };
      rec.meta.versions.push(v);
      saveMeta(rec);
      return send(res, 201, { id: v.id, label, seq: v.seq, createdAt: v.createdAt, author: username });
    }

    if (sub === '/versions' && method === 'GET') {
      const { rec } = requireDoc(username, id);
      return send(res, 200, rec.meta.versions.map(({ snapshot, ...rest }) => rest));
    }

    const vm = /^\/versions\/([^/]+)\/restore$/.exec(sub);
    if (vm && method === 'POST') {
      const { rec } = requireDoc(username, id, 'editor');
      const v = rec.meta.versions.find((x) => x.id === decodeURIComponent(vm[1]));
      if (!v) throw new HttpError(404, 'not_found', 'version not found');
      const seq = applyServerOps(rec, () => {
        for (const op of diffOps(rec.doc.toJSON(), v.snapshot)) {
          // Elements may already be gone through a cascade (removed shape takes its connectors).
          if ((op.type === 'remove' || op.type === 'update') && !rec.doc.get(op.id)) continue;
          rec.doc.apply(op);
        }
      });
      return send(res, 200, { seq, restored: v.id });
    }

    if (sub === '/comments' && method === 'POST') {
      const { rec } = requireDoc(username, id);
      const body = await readJSON(req);
      if (typeof body.body !== 'string' || !body.body.trim()) throw new HttpError(400, 'bad_request', 'body required');
      let elementId = body.elementId;
      let parentId = null;
      if (body.parentId) {
        const parent = rec.meta.comments.find((c) => c.id === body.parentId);
        if (!parent) throw new HttpError(404, 'not_found', 'parent comment not found');
        parentId = parent.id;
        elementId = parent.elementId;
      }
      if (typeof elementId !== 'string' || !elementId) throw new HttpError(400, 'bad_request', 'elementId required');
      const c = {
        id: crypto.randomUUID(),
        elementId,
        parentId,
        body: body.body.trim(),
        author: username,
        resolved: false,
        createdAt: new Date().toISOString(),
      };
      rec.meta.comments.push(c);
      saveMeta(rec);
      return send(res, 201, c);
    }

    if (sub === '/comments' && method === 'GET') {
      const { rec } = requireDoc(username, id);
      const filter = url.searchParams.get('elementId');
      const roots = rec.meta.comments.filter((c) => !c.parentId && (!filter || c.elementId === filter));
      const threads = roots.map((r) => ({
        ...r,
        replies: rec.meta.comments.filter((c) => c.parentId === r.id),
      }));
      return send(res, 200, threads);
    }

    const cm = /^\/comments\/([^/]+)\/resolve$/.exec(sub);
    if (cm && method === 'POST') {
      const { rec } = requireDoc(username, id);
      const body = await readJSON(req);
      const c = rec.meta.comments.find((x) => x.id === decodeURIComponent(cm[1]));
      if (!c) throw new HttpError(404, 'not_found', 'comment not found');
      const root = c.parentId ? rec.meta.comments.find((x) => x.id === c.parentId) : c;
      root.resolved = body.resolved === undefined ? true : Boolean(body.resolved);
      saveMeta(rec);
      return send(res, 200, root);
    }

    if (sub === '/export.svg' && method === 'GET') {
      const { rec } = requireDoc(username, id);
      const svg = rec.doc.toSVG();
      res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Content-Length': Buffer.byteLength(svg) });
      return res.end(svg);
    }

    if (sub === '/export.json' && method === 'GET') {
      const { rec } = requireDoc(username, id);
      res.setHeader('Content-Disposition', `attachment; filename="${rec.meta.id}.json"`);
      return send(res, 200, rec.doc.toJSON());
    }

    throw new HttpError(404, 'not_found', 'no such route');
  }

  function serveFile(res, baseDir, rel) {
    const file = path.resolve(baseDir, '.' + path.posix.normalize('/' + rel));
    if (!file.startsWith(path.resolve(baseDir) + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/') || url.pathname === '/api') {
        await handleApi(req, res, url);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405);
        return res.end();
      }
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return serveFile(res, STATIC_DIR, 'index.html');
      }
      if (url.pathname.startsWith('/static/core/')) {
        return serveFile(res, CORE_DIR, url.pathname.slice('/static/core/'.length));
      }
      if (url.pathname.startsWith('/static/')) {
        return serveFile(res, STATIC_DIR, url.pathname.slice('/static/'.length));
      }
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('not found');
    } catch (err) {
      if (res.headersSent) return res.destroy();
      if (err instanceof HttpError) return sendError(res, err.status, err.message);
      if (err instanceof DiagramError) return sendError(res, 400, err.message);
      console.error(err);
      return sendError(res, 500, 'internal error');
    }
  });

  // ---- WebSocket upgrade -----------------------------------------------------
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://localhost');
    const m = /^\/ws\/docs\/([^/]+)$/.exec(url.pathname);
    const reject = (status, msg) => {
      socket.write(`HTTP/1.1 ${status} ${msg}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      socket.destroy();
    };
    if (!m) return reject(404, 'Not Found');
    const token = url.searchParams.get('token');
    const username = token ? users.tokens[token] : null;
    if (!username) return reject(401, 'Unauthorized');
    let role;
    let rec;
    try {
      ({ rec, role } = requireDoc(username, decodeURIComponent(m[1])));
    } catch {
      return reject(404, 'Not Found');
    }
    const key = req.headers['sec-websocket-key'];
    if (req.headers.upgrade?.toLowerCase() !== 'websocket' || !key) return reject(400, 'Bad Request');
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '', '',
    ].join('\r\n'));
    socket.setNoDelay(true);
    rec.sockets.add(socket);
    socket.write(wsFrame(0x1, Buffer.from(JSON.stringify({ type: 'hello', docId: rec.meta.id, role, seq: rec.log.length }))));
    let buf = Buffer.alloc(0);
    let fragments = [];
    const cleanup = () => rec.sockets.delete(socket);
    socket.on('close', cleanup);
    socket.on('error', cleanup);
    // http.Server sockets are half-open by default; close our side when the client hangs up.
    socket.on('end', () => socket.end());
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const parsed = wsParse(buf);
      buf = parsed.rest;
      for (const f of parsed.frames) {
        if (f.opcode === 0x8) {
          socket.end(wsFrame(0x8, Buffer.alloc(0)));
          return;
        }
        if (f.opcode === 0x9) { socket.write(wsFrame(0xa, f.payload)); continue; }
        if (f.opcode === 0xa) continue;
        if (f.opcode === 0x0 || f.opcode === 0x1) {
          fragments.push(f.payload);
          if (!f.fin) continue;
          const text = Buffer.concat(fragments).toString('utf8');
          fragments = [];
          handleWsMessage(text);
        }
      }
    });

    function handleWsMessage(text) {
      let msg;
      try {
        msg = JSON.parse(text);
      } catch {
        return socket.write(wsFrame(0x1, Buffer.from(JSON.stringify({ type: 'error', message: 'invalid JSON' }))));
      }
      if (msg.type === 'ops') {
        if (role === 'viewer') {
          return socket.write(wsFrame(0x1, Buffer.from(JSON.stringify({ type: 'error', message: 'viewers cannot edit' }))));
        }
        try {
          const seq = acceptOps(rec, msg.ops);
          socket.write(wsFrame(0x1, Buffer.from(JSON.stringify({ type: 'ack', seq }))));
        } catch (e) {
          const message = e instanceof HttpError ? e.message : 'internal error';
          socket.write(wsFrame(0x1, Buffer.from(JSON.stringify({ type: 'error', message }))));
        }
        return;
      }
      if (msg.type === 'presence') {
        broadcast(rec, {
          type: 'presence',
          actor: typeof msg.actor === 'string' ? msg.actor : username,
          username,
          cursor: msg.cursor ?? null,
          selection: Array.isArray(msg.selection) ? msg.selection : [],
        }, socket);
      }
    }
  });

  server.documents = docs;
  return server;
}
