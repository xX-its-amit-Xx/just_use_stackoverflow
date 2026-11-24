// Collaboration server: REST API, long-poll + WebSocket sync, persistence, static editor.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { createDocument, DiagramError } from './core/index.js';
import { WsConnection, rejectUpgrade } from './ws.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');
const CORE_DIR = path.join(HERE, 'core');
const MAX_BODY = 20 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code || ({ 400: 'bad_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 413: 'payload_too_large' }[status] ?? 'error');
  }
}
const bad = (m) => new HttpError(400, m);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon',
};

function writeJsonAtomic(file, data) {
  const tmp = file + '.' + process.pid + '.' + randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function readJson(file, dflt) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; }
}

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: scryptSync(String(password), salt, 32).toString('hex') };
}

function isCrdtOp(op) {
  return op && typeof op === 'object' && typeof op.id === 'string' && Array.isArray(op.changes);
}

export function createServer({ dataDir, longPollTimeout = 25000 } = {}) {
  if (!dataDir) throw new Error('dataDir is required');
  const docsDir = path.join(dataDir, 'docs');
  fs.mkdirSync(docsDir, { recursive: true });
  const usersFile = path.join(dataDir, 'users.json');
  const auth = readJson(usersFile, { users: {}, tokens: {} });
  auth.users ||= {}; auth.tokens ||= {};
  const saveAuth = () => writeJsonAtomic(usersFile, auth);

  // ---------------------------------------------------------------- docs store
  const docs = new Map(); // id -> entry
  const metaFile = id => path.join(docsDir, `${id}.json`);
  const opsFile = id => path.join(docsDir, `${id}.ops.jsonl`);

  function loadEntry(meta) {
    const doc = createDocument({ id: meta.id, actor: 'server' });
    const ops = [];
    let raw = '';
    try { raw = fs.readFileSync(opsFile(meta.id), 'utf8'); } catch { /* none */ }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let op;
      try { op = JSON.parse(line); } catch { continue; }
      if (!isCrdtOp(op) || doc.hasOp(op.id)) continue;
      try { doc.receive([op]); ops.push(op); } catch { /* skip */ }
    }
    return { meta, doc, ops, waiters: new Set(), sockets: new Set() };
  }

  for (const f of fs.readdirSync(docsDir)) {
    if (!f.endsWith('.json')) continue;
    const meta = readJson(path.join(docsDir, f), null);
    if (meta && meta.id && !meta.deleted) docs.set(meta.id, loadEntry(meta));
  }

  const saveMeta = (entry) => {
    entry.meta.updatedAt = new Date().toISOString();
    writeJsonAtomic(metaFile(entry.meta.id), { ...entry.meta, snapshot: entry.doc.toJSON(), seq: entry.ops.length });
  };

  function roleOf(entry, username) {
    if (entry.meta.owner === username) return 'owner';
    return entry.meta.shares?.[username] ?? null;
  }

  function access(id, user, need = 'viewer') {
    const entry = docs.get(id);
    if (!entry) throw new HttpError(404, 'document not found');
    const role = roleOf(entry, user);
    if (!role) throw new HttpError(403, 'no access to this document');
    if (need === 'editor' && role === 'viewer') throw new HttpError(403, 'editor role required');
    if (need === 'owner' && role !== 'owner') throw new HttpError(403, 'owner role required');
    return { entry, role };
  }

  function docSummary(entry, user) {
    const m = entry.meta;
    return {
      id: m.id, title: m.title, owner: m.owner, role: roleOf(entry, user),
      createdAt: m.createdAt, updatedAt: m.updatedAt, seq: entry.ops.length,
      shares: Object.entries(m.shares || {}).map(([username, role]) => ({ username, role })),
    };
  }

  /** Persist + broadcast ops already applied to the server replica. */
  function commitLocal(entry) {
    const added = entry.doc.pendingOps();
    if (added.length) {
      fs.appendFileSync(opsFile(entry.meta.id), added.map(o => JSON.stringify(o)).join('\n') + '\n');
      entry.ops.push(...added);
      saveMeta(entry);
      notify(entry, added);
    }
    return added;
  }

  /** Integrate ops (CRDT ops or high-level ops) into the doc; returns newly logged ops. */
  function integrate(entry, input) {
    const list = Array.isArray(input) ? input : input && typeof input === 'object' ? [input] : null;
    if (!list) throw bad('ops must be an array');
    const added = [];
    for (const op of list) {
      if (isCrdtOp(op)) {
        if (entry.doc.hasOp(op.id)) continue;
        if (!op.changes.every(ch => ch && typeof ch === 'object' && typeof ch.id === 'string' && (ch.k === 'e' || ch.k === 'l'))) throw bad('malformed op changes');
        const clean = { id: op.id, actor: String(op.actor ?? ''), clock: Number(op.clock) || 0, changes: op.changes };
        entry.doc.receive([clean]);
        added.push(clean);
      } else if (op && typeof op === 'object' && typeof op.type === 'string') {
        try { entry.doc.apply(op); } catch (e) {
          if (e instanceof DiagramError) throw bad(e.message);
          throw e;
        }
        added.push(...entry.doc.pendingOps());
      } else {
        throw bad('malformed op');
      }
    }
    entry.doc.pendingOps();
    if (added.length) {
      fs.appendFileSync(opsFile(entry.meta.id), added.map(o => JSON.stringify(o)).join('\n') + '\n');
      entry.ops.push(...added);
      saveMeta(entry);
      notify(entry, added);
    }
    return added;
  }

  function notify(entry, added, except) {
    const seq = entry.ops.length;
    for (const w of [...entry.waiters]) w();
    const msg = JSON.stringify({ type: 'ops', ops: added, seq });
    for (const s of entry.sockets) if (s !== except) s.ws.send(msg);
  }

  // ---------------------------------------------------------------- helpers
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', c => {
        size += c.length;
        if (size > MAX_BODY) { reject(new HttpError(413, 'body too large')); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        const s = Buffer.concat(chunks).toString('utf8');
        if (!s.trim()) return resolve({});
        try { resolve(JSON.parse(s)); } catch { reject(bad('invalid JSON body')); }
      });
      req.on('error', reject);
    });
  }

  function send(res, status, body, headers = {}) {
    if (res.headersSent) return;
    if (typeof body === 'string' || Buffer.isBuffer(body)) {
      res.writeHead(status, { 'Content-Length': Buffer.byteLength(body), ...headers });
      res.end(body);
      return;
    }
    const s = JSON.stringify(body ?? {});
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s), 'Cache-Control': 'no-store', ...headers });
    res.end(s);
  }

  function userFromToken(token) {
    if (!token) return null;
    const u = auth.tokens[token];
    return u && auth.users[u] ? u : null;
  }

  function authenticate(req) {
    const h = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    const user = userFromToken(m && m[1].trim());
    if (!user) throw new HttpError(401, 'missing or invalid token');
    return user;
  }

  function serveStatic(res, file, root) {
    const resolved = path.resolve(root, '.' + path.sep + file);
    if (!resolved.startsWith(root + path.sep) && resolved !== root) throw new HttpError(404, 'not found');
    let data;
    try { data = fs.readFileSync(resolved); } catch { throw new HttpError(404, 'not found'); }
    send(res, 200, data, { 'Content-Type': MIME[path.extname(resolved)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
  }

  const newId = () => randomBytes(8).toString('hex');

  // ---------------------------------------------------------------- routes
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const method = req.method;

    if (method === 'GET' && (p === '/' || p === '/index.html')) return serveStatic(res, 'index.html', PUBLIC_DIR);
    if (method === 'GET' && p.startsWith('/static/')) {
      const rel = decodeURIComponent(p.slice('/static/'.length));
      if (rel.startsWith('core/')) return serveStatic(res, rel.slice(5), CORE_DIR);
      return serveStatic(res, rel, PUBLIC_DIR);
    }
    if (!p.startsWith('/api/')) throw new HttpError(404, 'not found');

    // auth (public)
    if (p === '/api/auth/register' && method === 'POST') {
      const { username, password } = await readBody(req);
      if (typeof username !== 'string' || !username.trim() || typeof password !== 'string' || !password) throw bad('username and password are required');
      if (!/^[\w.@-]{1,64}$/.test(username)) throw bad('invalid username');
      if (auth.users[username]) throw new HttpError(409, 'username already taken');
      auth.users[username] = { username, ...hashPassword(password), createdAt: new Date().toISOString() };
      saveAuth();
      return send(res, 201, { user: { username, id: username } });
    }
    if (p === '/api/auth/login' && method === 'POST') {
      const { username, password } = await readBody(req);
      if (typeof username !== 'string' || typeof password !== 'string') throw bad('username and password are required');
      const u = auth.users[username];
      if (!u) throw new HttpError(401, 'invalid credentials');
      const { hash } = hashPassword(password, u.salt);
      if (!timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(u.hash, 'hex'))) throw new HttpError(401, 'invalid credentials');
      const token = randomBytes(24).toString('hex');
      auth.tokens[token] = username;
      saveAuth();
      return send(res, 200, { token, user: { username, id: username } });
    }

    const user = authenticate(req);
    if (p === '/api/auth/me' && method === 'GET') return send(res, 200, { user: { username: user, id: user } });
    if (p === '/api/auth/logout' && method === 'POST') {
      const tok = /^Bearer\s+(.+)$/i.exec(req.headers.authorization)[1].trim();
      delete auth.tokens[tok]; saveAuth();
      return send(res, 200, { ok: true });
    }

    if (p === '/api/docs') {
      if (method === 'GET') {
        const list = [...docs.values()].filter(e => roleOf(e, user)).map(e => docSummary(e, user));
        list.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
        return send(res, 200, list);
      }
      if (method === 'POST') {
        const body = await readBody(req);
        const title = body.title === undefined ? 'Untitled' : body.title;
        if (typeof title !== 'string') throw bad('title must be a string');
        const id = newId();
        const now = new Date().toISOString();
        const meta = { id, title, owner: user, shares: {}, createdAt: now, updatedAt: now, versions: [], comments: [] };
        const entry = { meta, doc: createDocument({ id, actor: 'server' }), ops: [], waiters: new Set(), sockets: new Set() };
        docs.set(id, entry);
        fs.writeFileSync(opsFile(id), '');
        saveMeta(entry);
        if (body.snapshot && typeof body.snapshot === 'object') {
          try { entry.doc.loadSnapshot(body.snapshot); } catch (e) { throw bad('invalid snapshot: ' + e.message); }
          commitLocal(entry);
        }
        return send(res, 201, docSummary(entry, user));
      }
      throw new HttpError(404, 'not found');
    }

    const m = /^\/api\/docs\/([^/]+)(?:\/(.*))?$/.exec(p);
    if (!m) throw new HttpError(404, 'not found');
    const id = decodeURIComponent(m[1]);
    const rest = m[2] ?? '';

    if (rest === '') {
      if (method === 'GET') {
        const { entry } = access(id, user);
        const snap = entry.doc.toJSON();
        return send(res, 200, { ...snap, ...docSummary(entry, user), snapshot: snap });
      }
      if (method === 'DELETE') {
        const { entry } = access(id, user, 'owner');
        docs.delete(id);
        for (const s of entry.sockets) s.ws.close(1000);
        for (const w of [...entry.waiters]) w();
        try { fs.rmSync(metaFile(id), { force: true }); fs.rmSync(opsFile(id), { force: true }); } catch { /* ignore */ }
        return send(res, 200, { ok: true, id });
      }
      if (method === 'PATCH' || method === 'PUT') {
        const { entry } = access(id, user, 'editor');
        const body = await readBody(req);
        if (body.title !== undefined) {
          if (typeof body.title !== 'string') throw bad('title must be a string');
          entry.meta.title = body.title;
        }
        saveMeta(entry);
        return send(res, 200, docSummary(entry, user));
      }
      throw new HttpError(404, 'not found');
    }

    if (rest === 'share') {
      if (method === 'GET') {
        const { entry } = access(id, user);
        return send(res, 200, docSummary(entry, user).shares);
      }
      if (method !== 'POST') throw new HttpError(404, 'not found');
      const { entry } = access(id, user, 'owner');
      const { username, role } = await readBody(req);
      if (typeof username !== 'string' || !username) throw bad('username is required');
      if (role !== 'editor' && role !== 'viewer' && role !== null && role !== 'none') throw bad('role must be editor or viewer');
      if (!auth.users[username]) throw new HttpError(404, 'user not found');
      if (username === entry.meta.owner) throw bad('cannot change the owner role');
      if (role === null || role === 'none') delete entry.meta.shares[username];
      else entry.meta.shares[username] = role;
      saveMeta(entry);
      return send(res, 200, { ok: true, id, username, role, shares: docSummary(entry, user).shares });
    }

    if (rest === 'ops') {
      if (method === 'POST') {
        const { entry } = access(id, user, 'editor');
        const body = await readBody(req);
        const added = integrate(entry, body.ops);
        return send(res, 200, { seq: entry.ops.length, accepted: added.length });
      }
      if (method === 'GET') {
        const { entry } = access(id, user);
        const sinceRaw = url.searchParams.get('since');
        let since = sinceRaw === null || sinceRaw === '' ? 0 : Number(sinceRaw);
        if (!Number.isFinite(since) || since < 0) throw bad('since must be a non-negative number');
        since = Math.floor(since);
        const wait = ['1', 'true', 'yes'].includes(url.searchParams.get('wait') ?? '');
        const reply = () => send(res, 200, { ops: entry.ops.slice(since), seq: entry.ops.length });
        if (!wait || entry.ops.length > since) return reply();
        await new Promise(resolve => {
          let done = false;
          const finish = () => {
            if (done) return; done = true;
            clearTimeout(timer); entry.waiters.delete(finish); waiters.delete(finish);
            resolve();
          };
          const timer = setTimeout(finish, longPollTimeout);
          entry.waiters.add(finish); waiters.add(finish);
          req.on('close', finish);
          res.on('close', finish);
        });
        return reply();
      }
      throw new HttpError(404, 'not found');
    }

    if (rest === 'export.svg' && method === 'GET') {
      const { entry } = access(id, user);
      const padding = url.searchParams.has('padding') ? Number(url.searchParams.get('padding')) : 10;
      return send(res, 200, entry.doc.toSVG({ padding }), { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Content-Disposition': `attachment; filename="${id}.svg"` });
    }
    if (rest === 'export.json' && method === 'GET') {
      const { entry } = access(id, user);
      return send(res, 200, entry.doc.toJSON(), { 'Content-Disposition': `attachment; filename="${id}.json"` });
    }

    // versions
    if (rest === 'versions') {
      if (method === 'GET') {
        const { entry } = access(id, user);
        return send(res, 200, (entry.meta.versions || []).map(({ snapshot, ...v }) => v));
      }
      if (method === 'POST') {
        const { entry } = access(id, user, 'editor');
        const body = await readBody(req);
        if (body.label !== undefined && typeof body.label !== 'string') throw bad('label must be a string');
        const v = { id: newId(), label: body.label ?? `Version ${(entry.meta.versions || []).length + 1}`, createdAt: new Date().toISOString(), createdBy: user, seq: entry.ops.length, snapshot: entry.doc.toJSON() };
        (entry.meta.versions ||= []).push(v);
        saveMeta(entry);
        const { snapshot, ...pub } = v;
        return send(res, 201, pub);
      }
      throw new HttpError(404, 'not found');
    }
    let vm = /^versions\/([^/]+)(\/restore)?$/.exec(rest);
    if (vm) {
      const vid = decodeURIComponent(vm[1]);
      if (vm[2] && method === 'POST') {
        const { entry } = access(id, user, 'editor');
        const v = (entry.meta.versions || []).find(x => x.id === vid);
        if (!v) throw new HttpError(404, 'version not found');
        entry.doc.loadSnapshot(v.snapshot);
        commitLocal(entry);
        const snap = entry.doc.toJSON();
        return send(res, 200, { ok: true, version: vid, seq: entry.ops.length, ...snap, snapshot: snap });
      }
      if (!vm[2] && method === 'GET') {
        const { entry } = access(id, user);
        const v = (entry.meta.versions || []).find(x => x.id === vid);
        if (!v) throw new HttpError(404, 'version not found');
        return send(res, 200, v);
      }
      throw new HttpError(404, 'not found');
    }

    // comments
    if (rest === 'comments') {
      if (method === 'GET') {
        const { entry } = access(id, user);
        let list = entry.meta.comments || [];
        const el = url.searchParams.get('elementId');
        if (el) list = list.filter(c => c.elementId === el);
        return send(res, 200, list);
      }
      if (method === 'POST') {
        const { entry } = access(id, user);
        const body = await readBody(req);
        if (typeof body.text !== 'string' || !body.text.trim()) throw bad('text is required');
        const comments = (entry.meta.comments ||= []);
        if (body.parentId || body.threadId) {
          const parent = comments.find(c => c.id === (body.parentId || body.threadId));
          if (!parent) throw new HttpError(404, 'comment not found');
          const reply = { id: newId(), author: user, text: body.text, createdAt: new Date().toISOString() };
          parent.replies.push(reply);
          saveMeta(entry); broadcastComments(entry);
          return send(res, 201, reply);
        }
        if (typeof body.elementId !== 'string' || !body.elementId) throw bad('elementId is required');
        const c = { id: newId(), elementId: body.elementId, text: body.text, author: user, createdAt: new Date().toISOString(), resolved: false, replies: [] };
        comments.push(c);
        saveMeta(entry); broadcastComments(entry);
        return send(res, 201, c);
      }
      throw new HttpError(404, 'not found');
    }
    const cm = /^comments\/([^/]+)(?:\/(replies|resolve|reopen|unresolve))?$/.exec(rest);
    if (cm) {
      const { entry } = access(id, user);
      const comments = (entry.meta.comments ||= []);
      const c = comments.find(x => x.id === decodeURIComponent(cm[1]));
      if (!c) throw new HttpError(404, 'comment not found');
      const action = cm[2];
      if (!action && method === 'GET') return send(res, 200, c);
      if (action === 'replies' && method === 'POST') {
        const body = await readBody(req);
        if (typeof body.text !== 'string' || !body.text.trim()) throw bad('text is required');
        const reply = { id: newId(), author: user, text: body.text, createdAt: new Date().toISOString() };
        c.replies.push(reply);
        saveMeta(entry); broadcastComments(entry);
        return send(res, 201, reply);
      }
      if ((action === 'resolve' || action === 'reopen' || action === 'unresolve') && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
        const body = await readBody(req);
        c.resolved = action === 'resolve' ? body.resolved !== false : false;
        c.resolvedBy = c.resolved ? user : null;
        c.resolvedAt = c.resolved ? new Date().toISOString() : null;
        saveMeta(entry); broadcastComments(entry);
        return send(res, 200, c);
      }
      if (!action && (method === 'PATCH' || method === 'PUT')) {
        const body = await readBody(req);
        if (body.text !== undefined) {
          if (c.author !== user) throw new HttpError(403, 'only the author can edit a comment');
          if (typeof body.text !== 'string' || !body.text.trim()) throw bad('text must be a non-empty string');
          c.text = body.text;
        }
        if (body.resolved !== undefined) {
          c.resolved = !!body.resolved;
          c.resolvedBy = c.resolved ? user : null;
          c.resolvedAt = c.resolved ? new Date().toISOString() : null;
        }
        saveMeta(entry); broadcastComments(entry);
        return send(res, 200, c);
      }
      if (!action && method === 'DELETE') {
        if (c.author !== user && roleOf(entry, user) !== 'owner') throw new HttpError(403, 'cannot delete this comment');
        entry.meta.comments = comments.filter(x => x !== c);
        saveMeta(entry); broadcastComments(entry);
        return send(res, 200, { ok: true });
      }
      throw new HttpError(404, 'not found');
    }

    throw new HttpError(404, 'not found');
  }

  function broadcastComments(entry) {
    const msg = JSON.stringify({ type: 'comments', comments: entry.meta.comments });
    for (const s of entry.sockets) s.ws.send(msg);
  }

  const waiters = new Set();
  const allSockets = new Set();

  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      if (err instanceof HttpError) return send(res, err.status, { error: err.code, message: err.message });
      if (err instanceof DiagramError) return send(res, 400, { error: 'bad_request', message: err.message });
      send(res, 500, { error: 'internal', message: String(err && err.message || err) });
    });
  });

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    const url = new URL(req.url, 'http://localhost');
    const m = /^\/ws\/docs\/([^/]+)\/?$/.exec(url.pathname);
    if (!m) return rejectUpgrade(socket, 404, 'not found');
    let token = url.searchParams.get('token');
    if (!token) { const h = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || ''); token = h && h[1]; }
    const user = userFromToken(token);
    if (!user) return rejectUpgrade(socket, 401, 'missing or invalid token');
    const id = decodeURIComponent(m[1]);
    const entry = docs.get(id);
    if (!entry) return rejectUpgrade(socket, 404, 'document not found');
    const role = roleOf(entry, user);
    if (!role) return rejectUpgrade(socket, 403, 'no access');
    const ws = WsConnection.upgrade(req, socket, head);
    if (!ws) return;
    const client = { ws, user, actor: url.searchParams.get('actor') || user, role };
    entry.sockets.add(client); allSockets.add(client);
    ws.on('close', () => {
      entry.sockets.delete(client); allSockets.delete(client);
      const msg = JSON.stringify({ type: 'leave', actor: client.actor, user });
      for (const s of entry.sockets) s.ws.send(msg);
    });
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(String(data)); } catch { ws.send({ type: 'error', error: 'bad_request', message: 'invalid JSON' }); return; }
      if (!msg || typeof msg !== 'object') return;
      try {
        if (msg.type === 'ops') {
          if (roleOf(entry, user) === 'viewer' || !roleOf(entry, user)) { ws.send({ type: 'error', error: 'forbidden', message: 'editor role required' }); return; }
          if (!docs.has(id)) return;
          const added = integrateFrom(entry, msg.ops, client);
          ws.send({ type: 'ack', seq: entry.ops.length, accepted: added.length, ref: msg.ref });
        } else if (msg.type === 'presence') {
          if (msg.actor) client.actor = String(msg.actor);
          const out = JSON.stringify({ type: 'presence', actor: client.actor, user, cursor: msg.cursor ?? null, selection: msg.selection ?? [], color: msg.color, name: msg.name ?? user });
          for (const s of entry.sockets) if (s !== client) s.ws.send(out);
        } else if (msg.type === 'sync') {
          const since = Math.max(0, Math.floor(Number(msg.since) || 0));
          ws.send({ type: 'ops', ops: entry.ops.slice(since), seq: entry.ops.length });
        } else if (msg.type === 'ping') {
          ws.send({ type: 'pong' });
        }
      } catch (e) {
        ws.send({ type: 'error', error: e instanceof HttpError ? e.code : 'bad_request', message: e.message });
      }
    });
  });

  function integrateFrom(entry, ops, client) {
    // like integrate() but do not echo ops back to the sender
    const sockets = entry.sockets;
    const others = new Set([...sockets].filter(s => s !== client));
    entry.sockets = others;
    try { return integrate(entry, ops); } finally { entry.sockets = sockets; }
  }

  const origClose = server.close.bind(server);
  server.close = (cb) => {
    for (const w of [...waiters]) w();
    for (const c of [...allSockets]) c.ws.terminate();
    const r = origClose(cb);
    server.closeAllConnections?.();
    return r;
  };

  return server;
}
