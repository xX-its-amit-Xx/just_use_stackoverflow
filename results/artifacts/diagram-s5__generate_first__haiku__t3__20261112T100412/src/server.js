import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store, ID_RE } from './server/store.js';
import { acceptHandshake, WsConnection } from './server/ws.js';
import { DiagramError } from './core/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');
const CORE_DIR = path.join(HERE, 'core');
const MAX_BODY = 5 * 1024 * 1024;
const LONG_POLL_MS = 25000;
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
    super(message ?? error);
    this.status = status;
    this.error = error;
  }
}

const bad = (msg) => new HttpError(400, 'bad_request', msg);

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

function sendError(res, err) {
  if (err instanceof HttpError) {
    sendJson(res, err.status, { error: err.error, message: err.message });
    return;
  }
  if (err instanceof DiagramError) {
    sendJson(res, 409, { error: 'conflict', message: err.message });
    return;
  }
  sendJson(res, 500, { error: 'internal', message: 'internal server error' });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'payload_too_large', 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const text = await readBody(req);
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('body must be a JSON object');
    return v;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw bad('malformed JSON body');
  }
}

const isWrite = (w) =>
  w &&
  (w.e === 'el' || w.e === 'ly') &&
  typeof w.i === 'string' &&
  typeof w.f === 'string' &&
  Array.isArray(w.s) &&
  w.s.length === 2 &&
  typeof w.s[0] === 'number' &&
  typeof w.s[1] === 'string';

function validateOps(ops) {
  if (!Array.isArray(ops)) throw bad('ops must be an array');
  for (const op of ops) {
    if (!op || typeof op !== 'object' || typeof op.id !== 'string' || !Array.isArray(op.writes)) {
      throw bad('each op needs id and writes');
    }
    if (!op.writes.every(isWrite)) throw bad('malformed write in op');
  }
  return ops;
}

/** Makes the document's visible content equal to a version snapshot, as ordinary undoable ops. */
function restoreSnapshot(doc, snap) {
  const snapLayers = snap.layers ?? [];
  const snapLayerIds = new Set(snapLayers.map((l) => l.id));
  doc.transaction(() => {
    for (const l of doc.layers()) {
      if (l.locked) doc.apply({ type: 'updateLayer', id: l.id, patch: { locked: false } });
    }
    for (const l of doc.layers()) {
      if (!snapLayerIds.has(l.id) && l.id !== 'default') doc.apply({ type: 'removeLayer', id: l.id });
    }
    for (const l of snapLayers) {
      if (doc.layers().some((x) => x.id === l.id)) {
        doc.apply({ type: 'updateLayer', id: l.id, patch: { name: l.name, visible: l.visible, order: l.order } });
      } else {
        doc.apply({ type: 'addLayer', layer: { id: l.id, name: l.name, visible: l.visible, order: l.order } });
      }
    }
    const snapEls = snap.elements ?? [];
    const snapIds = new Set(snapEls.map((e) => e.id));
    for (const e of doc.elements()) {
      if (!snapIds.has(e.id) && doc.get(e.id)) doc.apply({ type: 'remove', id: e.id });
    }
    const addWith = (e) => {
      if (!doc.get(e.id)) doc.apply({ type: 'add', element: e });
    };
    snapEls.filter((e) => e.type !== 'connector').forEach(addWith);
    snapEls.filter((e) => e.type === 'connector').forEach(addWith);
    for (const e of snapEls) {
      const cur = doc.get(e.id);
      if (!cur) continue;
      const patch = {};
      for (const [k, v] of Object.entries(e)) {
        if (k === 'id' || k === 'type' || k === 'style') continue;
        if (JSON.stringify(cur[k]) !== JSON.stringify(v)) patch[k] = v;
      }
      if (Object.keys(patch).length) doc.apply({ type: 'update', id: e.id, patch });
      const style = {};
      for (const [k, v] of Object.entries(e.style ?? {})) {
        if (JSON.stringify(cur.style[k]) !== JSON.stringify(v)) style[k] = v;
      }
      if (Object.keys(style).length) doc.apply({ type: 'setStyle', ids: [e.id], style });
    }
    for (const l of snapLayers) {
      if (l.locked) doc.apply({ type: 'updateLayer', id: l.id, patch: { locked: true } });
    }
  });
}

export function createServer({ dataDir }) {
  const store = new Store(dataDir);
  const wsByDoc = new Map();

  const roleFor = (meta, user) => store.roleOf(meta, user);

  function loadDoc(id, user, needRole) {
    if (!ID_RE.test(id)) throw new HttpError(404, 'not_found', 'document not found');
    const meta = store.metas.get(id);
    if (!meta) throw new HttpError(404, 'not_found', 'document not found');
    const role = roleFor(meta, user);
    if (!role) throw new HttpError(403, 'forbidden', 'no access to this document');
    if (needRole && !needRole.includes(role)) throw new HttpError(403, 'forbidden', `requires role: ${needRole.join(' or ')}`);
    const live = store.liveDoc(id);
    return { meta, live, role };
  }

  function broadcast(live, msg, except = null) {
    for (const ws of live.sockets) if (ws !== except) ws.send(msg);
  }

  function submitOps(live, ops, origin = null) {
    const fresh = live.ingest(ops);
    if (fresh.length) broadcast(live, { type: 'ops', ops: fresh, seq: live.seq }, origin);
    return live.seq;
  }

  function docSummary(meta, role) {
    return {
      id: meta.id,
      title: meta.title,
      owner: meta.owner,
      role,
      seq: meta.seq ?? 0,
      createdAt: meta.createdAt,
      updatedAt: meta.updatedAt,
    };
  }

  // ----------------------------------------------------------- routes

  async function route(req, res, url) {
    const p = url.pathname;
    const method = req.method;
    const parts = p.split('/').filter(Boolean);

    if (method === 'GET' && (p === '/' || p === '/index.html')) {
      return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
    }
    if (method === 'GET' && p.startsWith('/static/')) {
      let rel = decodeURIComponent(p.slice('/static/'.length));
      let base = PUBLIC_DIR;
      if (rel.startsWith('core/')) {
        base = CORE_DIR;
        rel = rel.slice('core/'.length);
      }
      const file = path.normalize(path.join(base, rel));
      if (!file.startsWith(base + path.sep)) throw new HttpError(404, 'not_found', 'not found');
      return serveFile(res, file);
    }
    if (parts[0] !== 'api') throw new HttpError(404, 'not_found', 'not found');

    // ---- auth
    if (parts[1] === 'auth') {
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'method not allowed');
      const body = await readJson(req);
      if (parts[2] === 'register') {
        const { username, password } = body;
        if (typeof username !== 'string' || !/^[A-Za-z0-9_.-]{2,32}$/.test(username)) {
          throw bad('username must be 2-32 characters: letters, digits, _ . -');
        }
        if (typeof password !== 'string' || password.length < 6) throw bad('password must be at least 6 characters');
        if (!store.register(username, password)) throw new HttpError(409, 'conflict', 'username already taken');
        return sendJson(res, 201, { user: { username } });
      }
      if (parts[2] === 'login') {
        const { username, password } = body;
        if (typeof username !== 'string' || typeof password !== 'string') throw bad('username and password required');
        if (!store.verify(username, password)) throw new HttpError(401, 'unauthorized', 'invalid credentials');
        return sendJson(res, 200, { token: store.login(username), user: { username } });
      }
      throw new HttpError(404, 'not_found', 'not found');
    }

    // ---- everything else needs a bearer token
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    const user = m ? store.userFor(m[1].trim()) : null;
    if (!user) throw new HttpError(401, 'unauthorized', 'missing or invalid token');

    if (parts[1] !== 'docs') throw new HttpError(404, 'not_found', 'not found');

    // ---- collection
    if (parts.length === 2) {
      if (method === 'GET') {
        const list = [];
        for (const meta of store.metas.values()) {
          const role = roleFor(meta, user);
          if (role) list.push(docSummary(meta, role));
        }
        list.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
        return sendJson(res, 200, list);
      }
      if (method === 'POST') {
        const body = await readJson(req);
        const title = body.title === undefined ? 'Untitled' : body.title;
        if (typeof title !== 'string' || !title.trim()) throw bad('title must be a non-empty string');
        const now = new Date().toISOString();
        const meta = {
          id: store.newId(),
          title: title.trim(),
          owner: user,
          members: {},
          createdAt: now,
          updatedAt: now,
          seq: 0,
          versions: [],
          comments: [],
        };
        store.createDoc(meta);
        return sendJson(res, 201, docSummary(meta, 'owner'));
      }
      throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    }

    const id = parts[2];
    const sub = parts[3];

    // ---- document
    if (parts.length === 3) {
      if (method === 'GET') {
        const { meta, live, role } = loadDoc(id, user);
        return sendJson(res, 200, { ...live.doc.toJSON(), ...docSummary(meta, role), members: meta.members });
      }
      if (method === 'DELETE') {
        const { meta } = loadDoc(id, user, ['owner']);
        store.deleteDoc(meta.id);
        for (const ws of wsByDoc.get(meta.id) ?? []) ws.close();
        wsByDoc.delete(meta.id);
        return sendJson(res, 200, { ok: true, id: meta.id });
      }
      throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    }

    if (sub === 'share' && parts.length === 4 && method === 'POST') {
      const { meta } = loadDoc(id, user, ['owner']);
      const body = await readJson(req);
      const { username, role } = body;
      if (typeof username !== 'string' || !store.auth.users[username]) {
        throw new HttpError(404, 'not_found', 'no such user');
      }
      if (role !== 'editor' && role !== 'viewer') throw bad('role must be editor or viewer');
      if (username === meta.owner) throw bad('owner role cannot be changed');
      meta.members[username] = role;
      meta.updatedAt = new Date().toISOString();
      store.saveMeta(meta);
      return sendJson(res, 200, { id: meta.id, username, role, members: meta.members });
    }

    // ---- sync
    if (sub === 'ops' && parts.length === 4) {
      if (method === 'POST') {
        const { live } = loadDoc(id, user, ['owner', 'editor']);
        const body = await readJson(req);
        const ops = validateOps(body.ops);
        const seq = submitOps(live, ops);
        return sendJson(res, 200, { seq });
      }
      if (method === 'GET') {
        const { live } = loadDoc(id, user);
        const since = Math.max(0, parseInt(url.searchParams.get('since') ?? '0', 10) || 0);
        const wait = url.searchParams.get('wait') === '1';
        if (live.seq <= since && wait) {
          await new Promise((resolve) => {
            const timer = setTimeout(() => {
              live.waiters = live.waiters.filter((w) => w !== done);
              resolve();
            }, LONG_POLL_MS);
            const done = () => {
              clearTimeout(timer);
              resolve();
            };
            live.waiters.push(done);
            req.on('close', () => {
              clearTimeout(timer);
              live.waiters = live.waiters.filter((w) => w !== done);
              resolve();
            });
          });
        }
        return sendJson(res, 200, { ops: live.ops.slice(since), seq: live.seq });
      }
      throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    }

    // ---- versions
    if (sub === 'versions') {
      if (parts.length === 4 && method === 'GET') {
        const { meta } = loadDoc(id, user);
        return sendJson(
          res,
          200,
          meta.versions.map(({ id: vid, label, createdAt, seq }) => ({ id: vid, label, createdAt, seq })),
        );
      }
      if (parts.length === 4 && method === 'POST') {
        const { meta, live } = loadDoc(id, user, ['owner', 'editor']);
        const body = await readJson(req);
        const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : 'Version';
        const snapshot = live.doc.toJSON();
        const v = { id: crypto.randomUUID().slice(0, 8), label, createdAt: new Date().toISOString(), seq: live.seq, snapshot };
        meta.versions.push(v);
        store.saveMeta(meta);
        return sendJson(res, 201, { id: v.id, label: v.label, createdAt: v.createdAt, seq: v.seq });
      }
      if (parts.length === 6 && parts[5] === 'restore' && method === 'POST') {
        const { meta, live } = loadDoc(id, user, ['owner', 'editor']);
        const v = meta.versions.find((x) => x.id === parts[4]);
        if (!v) throw new HttpError(404, 'not_found', 'version not found');
        try {
          restoreSnapshot(live.doc, v.snapshot);
        } finally {
          const fresh = live.ingest(live.doc.pendingOps());
          if (fresh.length) broadcast(live, { type: 'ops', ops: fresh, seq: live.seq });
        }
        return sendJson(res, 200, { seq: live.seq });
      }
      throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    }

    // ---- comments
    if (sub === 'comments') {
      if (parts.length === 4 && method === 'GET') {
        const { meta } = loadDoc(id, user);
        const filter = url.searchParams.get('elementId');
        const list = meta.comments.filter((c) => filter === null || c.elementId === filter);
        return sendJson(res, 200, list);
      }
      if (parts.length === 4 && method === 'POST') {
        const { meta } = loadDoc(id, user);
        const body = await readJson(req);
        if (typeof body.elementId !== 'string' || !body.elementId) throw bad('elementId required');
        if (typeof body.text !== 'string' || !body.text.trim()) throw bad('text required');
        let parentId = null;
        if (body.parentId !== undefined && body.parentId !== null) {
          const parent = meta.comments.find((c) => c.id === body.parentId);
          if (!parent) throw new HttpError(404, 'not_found', 'parent comment not found');
          parentId = parent.id;
        }
        const c = {
          id: crypto.randomUUID().slice(0, 8),
          elementId: body.elementId,
          parentId,
          author: user,
          text: body.text,
          resolved: false,
          createdAt: new Date().toISOString(),
        };
        meta.comments.push(c);
        store.saveMeta(meta);
        return sendJson(res, 201, c);
      }
      if (parts.length === 6 && parts[5] === 'resolve' && method === 'POST') {
        const { meta } = loadDoc(id, user);
        const body = await readJson(req);
        const c = meta.comments.find((x) => x.id === parts[4]);
        if (!c) throw new HttpError(404, 'not_found', 'comment not found');
        c.resolved = body.resolved === undefined ? true : !!body.resolved;
        store.saveMeta(meta);
        return sendJson(res, 200, c);
      }
      throw new HttpError(405, 'method_not_allowed', 'method not allowed');
    }

    // ---- exports
    if (sub === 'export.svg' && method === 'GET' && parts.length === 4) {
      const { live } = loadDoc(id, user);
      const svg = live.doc.toSVG();
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Length': Buffer.byteLength(svg) });
      return res.end(svg);
    }
    if (sub === 'export.json' && method === 'GET' && parts.length === 4) {
      const { live } = loadDoc(id, user);
      return sendJson(res, 200, live.doc.toJSON());
    }

    throw new HttpError(404, 'not_found', 'not found');
  }

  function serveFile(res, file) {
    fs.readFile(file, (err, data) => {
      if (err) return sendJson(res, 404, { error: 'not_found', message: 'not found' });
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream',
        'Content-Length': data.length,
      });
      res.end(data);
    });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    route(req, res, url).catch((err) => {
      if (!(err instanceof HttpError) && !(err instanceof DiagramError)) {
        process.stderr.write(`[server] ${err?.stack ?? err}\n`);
      }
      if (!res.headersSent) sendError(res, err);
      else res.end();
    });
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const m = /^\/ws\/docs\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    const reject = (code, text) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (!m) return reject(404, 'Not Found');
    const user = store.userFor(url.searchParams.get('token'));
    if (!user) return reject(401, 'Unauthorized');
    const meta = store.metas.get(m[1]);
    if (!meta) return reject(404, 'Not Found');
    const role = roleFor(meta, user);
    if (!role) return reject(403, 'Forbidden');
    const live = store.liveDoc(meta.id);
    acceptHandshake(req, socket);
    if (head && head.length) socket.unshift(head);
    let conn;
    conn = new WsConnection(socket, {
      onMessage: (msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'ops') {
          if (role !== 'owner' && role !== 'editor') return conn.send({ type: 'error', message: 'read-only access' });
          try {
            const ops = validateOps(msg.ops);
            submitOps(live, ops, conn);
          } catch (e) {
            conn.send({ type: 'error', message: e.message });
          }
        } else if (msg.type === 'presence') {
          broadcast(
            live,
            { type: 'presence', actor: typeof msg.actor === 'string' ? msg.actor : user, cursor: msg.cursor ?? null, selection: msg.selection ?? [] },
            conn,
          );
        }
      },
      onClose: () => {
        live.sockets.delete(conn);
        wsByDoc.get(meta.id)?.delete(conn);
      },
    });
    live.sockets.add(conn);
    if (!wsByDoc.has(meta.id)) wsByDoc.set(meta.id, new Set());
    wsByDoc.get(meta.id).add(conn);
    conn.send({ type: 'hello', seq: live.seq, role });
  });

  return server;
}
