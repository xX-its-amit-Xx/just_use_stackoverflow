import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, scryptSync, timingSafeEqual, randomUUID } from 'node:crypto';
import { createDocument, fromJSON, DiagramError } from './core/index.js';
import { acceptUpgrade } from './ws.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };

class HttpError extends Error {
  constructor(status, error, message) { super(message || error); this.status = status; this.error = error; }
}
const bad = (m) => new HttpError(400, 'bad_request', m);

export function createServer({ dataDir }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const usersFile = path.join(dataDir, '_users.json');
  const tokensFile = path.join(dataDir, '_tokens.json');
  const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
  const writeJson = (f, v) => { const t = f + '.tmp'; fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, f); };
  const users = readJson(usersFile, {}); // username -> {id, username, salt, hash}
  const tokens = readJson(tokensFile, {}); // token -> username
  const states = new Map();

  function loadDoc(id) {
    const metaFile = path.join(dataDir, `${id}.json`);
    const meta = readJson(metaFile, null);
    if (!meta) return null;
    const doc = createDocument({ id, actor: 'server' });
    const ops = [];
    const opids = new Set();
    try {
      const lines = fs.readFileSync(path.join(dataDir, `${id}.ops.jsonl`), 'utf8').split('\n');
      for (const l of lines) { if (!l.trim()) continue; try { const op = JSON.parse(l); ops.push(op); opids.add(opKey(op)); } catch { /* torn line */ } }
    } catch { /* no log */ }
    doc.receive(ops);
    return { meta, doc, ops, opids, waiters: new Set(), sockets: new Set() };
  }
  for (const f of fs.readdirSync(dataDir)) {
    if (f.startsWith('_') || !f.endsWith('.json')) continue;
    const id = f.slice(0, -5);
    const st = loadDoc(id);
    if (st) states.set(id, st);
  }
  const saveMeta = (st) => writeJson(path.join(dataDir, `${st.meta.id}.json`), st.meta);
  const opKey = (op) => op.opid || `${op.actor}:${op.clk}:${op.kind}:${op.ent}:${op.id}`;

  function hashPw(pw, salt) { return scryptSync(pw, salt, 32).toString('hex'); }

  function authUser(req, url) {
    let tok = null;
    const h = req.headers.authorization || '';
    if (/^Bearer /i.test(h)) tok = h.slice(7).trim();
    else if (url?.searchParams.get('token')) tok = url.searchParams.get('token');
    const u = tok && tokens[tok];
    if (!u || !users[u]) throw new HttpError(401, 'unauthorized', 'missing or invalid token');
    return users[u];
  }
  const roleOf = (st, username) => (st.meta.owner === username ? 'owner' : st.meta.shares[username] || null);
  function docFor(id, user, need) {
    const st = states.get(id);
    if (!st) throw new HttpError(404, 'not_found', 'document not found');
    const role = roleOf(st, user.username);
    if (!role) throw new HttpError(403, 'forbidden', 'no access to this document');
    if (need === 'edit' && role === 'viewer') throw new HttpError(403, 'forbidden', 'editor role required');
    if (need === 'owner' && role !== 'owner') throw new HttpError(403, 'forbidden', 'owner role required');
    return { st, role };
  }

  function ingest(st, ops, from, sender) {
    if (!Array.isArray(ops)) throw bad('ops must be an array');
    const fresh = [];
    const keys = new Set();
    for (const op of ops) {
      if (!op || typeof op !== 'object') throw bad('malformed op');
      const k = opKey(op);
      if (st.opids.has(k) || keys.has(k)) continue;
      keys.add(k);
      fresh.push(op);
    }
    try { st.doc.receive(fresh); } catch (e) { if (e instanceof DiagramError) throw bad(e.message); throw e; }
    if (fresh.length) {
      for (const k of keys) st.opids.add(k);
      st.ops.push(...fresh);
      fs.appendFileSync(path.join(dataDir, `${st.meta.id}.ops.jsonl`), fresh.map((o) => JSON.stringify(o)).join('\n') + '\n');
      const seq = st.ops.length;
      for (const s of st.sockets) if (s !== sender) s.send({ type: 'ops', ops: fresh, seq, from });
      for (const w of [...st.waiters]) w();
    }
    return st.ops.length;
  }

  const snapshot = (st, role) => ({ ...st.doc.toJSON(), id: st.meta.id, title: st.meta.title, owner: st.meta.owner, role, seq: st.ops.length, created: st.meta.created });
  const brief = (st, role) => ({ id: st.meta.id, title: st.meta.title, owner: st.meta.owner, role, created: st.meta.created, updated: st.meta.updated, seq: st.ops.length });

  async function readBody(req) {
    const chunks = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > 20 * 1024 * 1024) throw new HttpError(400, 'bad_request', 'body too large'); chunks.push(c); }
    if (!n) return {};
    try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); return v ?? {}; } catch { throw bad('invalid JSON body'); }
  }
  const send = (res, status, body, headers = {}) => {
    const isStr = typeof body === 'string';
    res.writeHead(status, { 'content-type': isStr ? 'text/plain' : 'application/json', ...headers });
    res.end(isStr ? body : JSON.stringify(body));
  };

  async function handleApi(req, res, url) {
    const p = url.pathname;
    const m = req.method;
    let r;
    if (p === '/api/auth/register' && m === 'POST') {
      const b = await readBody(req);
      if (typeof b.username !== 'string' || !b.username.trim() || typeof b.password !== 'string' || !b.password) throw bad('username and password required');
      if (users[b.username]) throw new HttpError(409, 'conflict', 'username taken');
      const salt = randomBytes(16).toString('hex');
      users[b.username] = { id: randomUUID(), username: b.username, salt, hash: hashPw(b.password, salt) };
      writeJson(usersFile, users);
      return send(res, 201, { user: { id: users[b.username].id, username: b.username } });
    }
    if (p === '/api/auth/login' && m === 'POST') {
      const b = await readBody(req);
      const u = typeof b.username === 'string' ? users[b.username] : null;
      if (!u || typeof b.password !== 'string' || !timingSafeEqual(Buffer.from(hashPw(b.password, u.salt), 'hex'), Buffer.from(u.hash, 'hex'))) throw new HttpError(401, 'unauthorized', 'invalid credentials');
      const token = randomBytes(24).toString('hex');
      tokens[token] = u.username;
      writeJson(tokensFile, tokens);
      return send(res, 200, { token, user: { id: u.id, username: u.username } });
    }
    const user = authUser(req, url);
    if (p === '/api/auth/me' && m === 'GET') return send(res, 200, { user: { id: user.id, username: user.username } });
    if (p === '/api/docs' && m === 'POST') {
      const b = await readBody(req);
      if (b.title !== undefined && typeof b.title !== 'string') throw bad('title must be a string');
      const id = randomUUID();
      const now = new Date().toISOString();
      const st = { meta: { id, title: b.title || 'Untitled', owner: user.username, shares: {}, versions: [], comments: [], created: now, updated: now }, doc: createDocument({ id, actor: 'server' }), ops: [], opids: new Set(), waiters: new Set(), sockets: new Set() };
      states.set(id, st);
      saveMeta(st);
      fs.writeFileSync(path.join(dataDir, `${id}.ops.jsonl`), '');
      return send(res, 201, brief(st, 'owner'));
    }
    if (p === '/api/docs' && m === 'GET') {
      const list = [];
      for (const st of states.values()) { const role = roleOf(st, user.username); if (role) list.push(brief(st, role)); }
      return send(res, 200, { docs: list });
    }
    if ((r = /^\/api\/docs\/([^/]+)(?:\/(.*))?$/.exec(p))) {
      const id = r[1], sub = r[2] || '';
      if (sub === '') {
        if (m === 'GET') { const { st, role } = docFor(id, user); return send(res, 200, snapshot(st, role)); }
        if (m === 'DELETE') {
          const { st } = docFor(id, user, 'owner');
          states.delete(id);
          for (const s of st.sockets) s.close(1000);
          for (const f of [`${id}.json`, `${id}.ops.jsonl`]) fs.rmSync(path.join(dataDir, f), { force: true });
          return send(res, 200, { ok: true });
        }
      }
      if (sub === 'share' && m === 'POST') {
        const { st } = docFor(id, user, 'owner');
        const b = await readBody(req);
        if (typeof b.username !== 'string' || !['editor', 'viewer'].includes(b.role)) throw bad('username and role (editor|viewer) required');
        if (!users[b.username]) throw new HttpError(404, 'not_found', 'user not found');
        if (b.username === st.meta.owner) throw bad('cannot share with owner');
        st.meta.shares[b.username] = b.role;
        saveMeta(st);
        return send(res, 200, { username: b.username, role: b.role, shares: st.meta.shares });
      }
      if ((r = /^share\/([^/]+)$/.exec(sub)) && m === 'DELETE') {
        const { st } = docFor(id, user, 'owner');
        delete st.meta.shares[decodeURIComponent(r[1])];
        saveMeta(st);
        return send(res, 200, { shares: st.meta.shares });
      }
      if (sub === 'ops' && m === 'POST') {
        const { st } = docFor(id, user, 'edit');
        const b = await readBody(req);
        const seq = ingest(st, b.ops, user.username, null);
        st.meta.updated = new Date().toISOString();
        saveMeta(st);
        return send(res, 200, { seq });
      }
      if (sub === 'ops' && m === 'GET') {
        const { st } = docFor(id, user);
        const since = Number(url.searchParams.get('since') || 0);
        if (!Number.isInteger(since) || since < 0) throw bad('since must be a non-negative integer');
        const respond = () => send(res, 200, { ops: st.ops.slice(since), seq: st.ops.length });
        if (url.searchParams.get('wait') === '1' && st.ops.length <= since) {
          let done = false;
          const finish = () => { if (done) return; done = true; clearTimeout(t); st.waiters.delete(finish); if (!res.writableEnded) respond(); };
          const t = setTimeout(finish, 25000);
          st.waiters.add(finish);
          req.on('close', () => { done = true; clearTimeout(t); st.waiters.delete(finish); });
          return;
        }
        return respond();
      }
      if (sub === 'versions' && m === 'POST') {
        const { st } = docFor(id, user, 'edit');
        const b = await readBody(req);
        const v = { id: randomUUID(), label: typeof b.label === 'string' ? b.label : '', created: new Date().toISOString(), author: user.username, seq: st.ops.length, snapshot: st.doc.toJSON() };
        st.meta.versions.push(v);
        saveMeta(st);
        const { snapshot: _s, ...pub } = v;
        return send(res, 201, pub);
      }
      if (sub === 'versions' && m === 'GET') {
        const { st } = docFor(id, user);
        return send(res, 200, { versions: st.meta.versions.map(({ snapshot: _s, ...v }) => v) });
      }
      if ((r = /^versions\/([^/]+)\/restore$/.exec(sub)) && m === 'POST') {
        const { st } = docFor(id, user, 'edit');
        const v = st.meta.versions.find((x) => x.id === r[1]);
        if (!v) throw new HttpError(404, 'not_found', 'version not found');
        st.doc.pendingOps();
        st.doc.restore(v.snapshot);
        const ops = st.doc.pendingOps();
        // already integrated in st.doc: log and broadcast directly
        for (const o of ops) st.opids.add(opKey(o));
        st.ops.push(...ops);
        if (ops.length) fs.appendFileSync(path.join(dataDir, `${id}.ops.jsonl`), ops.map((o) => JSON.stringify(o)).join('\n') + '\n');
        for (const s of st.sockets) s.send({ type: 'ops', ops, seq: st.ops.length, from: user.username, restore: true });
        for (const w of [...st.waiters]) w();
        st.meta.updated = new Date().toISOString();
        saveMeta(st);
        return send(res, 200, { restored: v.id, seq: st.ops.length });
      }
      if (sub === 'comments' && m === 'POST') {
        const { st } = docFor(id, user);
        const b = await readBody(req);
        if (typeof b.text !== 'string' || !b.text.trim()) throw bad('text required');
        if (typeof b.elementId !== 'string' || !b.elementId) throw bad('elementId required');
        if (!st.doc.get(b.elementId)) throw new HttpError(404, 'not_found', 'element not found');
        const c = { id: randomUUID(), elementId: b.elementId, author: user.username, text: b.text, created: new Date().toISOString(), resolved: false, replies: [] };
        st.meta.comments.push(c);
        saveMeta(st);
        for (const s of st.sockets) s.send({ type: 'comments' });
        return send(res, 201, c);
      }
      if (sub === 'comments' && m === 'GET') {
        const { st } = docFor(id, user);
        let list = st.meta.comments;
        const el = url.searchParams.get('elementId');
        if (el) list = list.filter((c) => c.elementId === el);
        return send(res, 200, { comments: list });
      }
      if ((r = /^comments\/([^/]+)(?:\/(replies|resolve|unresolve))?$/.exec(sub))) {
        const { st, role } = docFor(id, user);
        const c = st.meta.comments.find((x) => x.id === r[1]);
        if (!c) throw new HttpError(404, 'not_found', 'comment not found');
        const notify = () => { saveMeta(st); for (const s of st.sockets) s.send({ type: 'comments' }); };
        if (r[2] === 'replies' && m === 'POST') {
          const b = await readBody(req);
          if (typeof b.text !== 'string' || !b.text.trim()) throw bad('text required');
          const rep = { id: randomUUID(), author: user.username, text: b.text, created: new Date().toISOString() };
          c.replies.push(rep); notify();
          return send(res, 201, rep);
        }
        if ((r[2] === 'resolve' || r[2] === 'unresolve') && m === 'POST') {
          const b = await readBody(req);
          c.resolved = r[2] === 'resolve' ? b.resolved !== false : false;
          notify();
          return send(res, 200, c);
        }
        if (!r[2] && m === 'PATCH') {
          const b = await readBody(req);
          if (typeof b.resolved === 'boolean') c.resolved = b.resolved;
          notify();
          return send(res, 200, c);
        }
        if (!r[2] && m === 'DELETE') {
          if (c.author !== user.username && role !== 'owner') throw new HttpError(403, 'forbidden', 'cannot delete this comment');
          st.meta.comments = st.meta.comments.filter((x) => x !== c);
          notify();
          return send(res, 200, { ok: true });
        }
      }
      if (sub === 'export.svg' && m === 'GET') {
        const { st } = docFor(id, user);
        return send(res, 200, st.doc.toSVG({ padding: Number(url.searchParams.get('padding')) || 20 }), { 'content-type': 'image/svg+xml' });
      }
      if (sub === 'export.json' && m === 'GET') {
        const { st } = docFor(id, user);
        return send(res, 200, st.doc.toJSON(), { 'content-disposition': `attachment; filename="${id}.json"` });
      }
    }
    throw new HttpError(404, 'not_found', 'no such route');
  }

  function serveStatic(req, res, url) {
    let rel = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/static\//, '');
    let base = path.join(HERE, 'public');
    if (rel.startsWith('core/')) { base = path.join(HERE, 'core'); rel = rel.slice(5); }
    const file = path.normalize(path.join(base, rel));
    if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new HttpError(404, 'not_found', 'no such file');
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/static/'))) serveStatic(req, res, url);
      else throw new HttpError(404, 'not_found', 'not found');
    } catch (e) {
      if (res.headersSent) { res.end(); return; }
      if (e instanceof HttpError) send(res, e.status, { error: e.error, message: e.message });
      else if (e instanceof DiagramError) send(res, 400, { error: 'bad_request', message: e.message });
      else { console.error(e); send(res, 500, { error: 'internal', message: 'internal error' }); }
    }
  });

  server.on('upgrade', (req, socket) => {
    let st, user, role;
    try {
      const url = new URL(req.url, 'http://localhost');
      const m = /^\/ws\/docs\/([^/]+)$/.exec(url.pathname);
      if (!m) throw new HttpError(404, 'not_found', '');
      user = authUser(req, url);
      ({ st, role } = docFor(m[1], user));
    } catch (e) {
      const code = e.status || 400;
      socket.write(`HTTP/1.1 ${code} ${http.STATUS_CODES[code] || 'Error'}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
      return;
    }
    const ws = acceptUpgrade(req, socket);
    if (!ws) return;
    ws.username = user.username;
    ws.actorId = null;
    st.sockets.add(ws);
    const peers = [...st.sockets].filter((s) => s !== ws).map((s) => s.username);
    ws.send({ type: 'hello', seq: st.ops.length, role, user: user.username, peers });
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return ws.send({ type: 'error', message: 'invalid JSON' }); }
      if (msg.type === 'ops') {
        if (role === 'viewer') return ws.send({ type: 'error', error: 'forbidden', message: 'editor role required' });
        try { const seq = ingest(st, msg.ops, user.username, ws); st.meta.updated = new Date().toISOString(); ws.send({ type: 'ack', seq, ref: msg.ref }); } catch (e) { ws.send({ type: 'error', error: 'bad_request', message: e.message }); }
      } else if (msg.type === 'presence') {
        ws.actorId = msg.actor || ws.actorId || user.username;
        const out = { type: 'presence', actor: ws.actorId, user: user.username, cursor: msg.cursor ?? null, selection: msg.selection ?? [] };
        for (const s of st.sockets) if (s !== ws) s.send(out);
      } else if (msg.type === 'ping') ws.send({ type: 'pong' });
    });
    ws.on('close', () => {
      st.sockets.delete(ws);
      for (const s of st.sockets) s.send({ type: 'leave', actor: ws.actorId || user.username, user: user.username });
    });
  });

  return server;
}
