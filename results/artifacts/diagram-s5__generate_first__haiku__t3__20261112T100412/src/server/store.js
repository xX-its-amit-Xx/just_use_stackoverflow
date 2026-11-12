import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createDocument } from '../core/index.js';

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const USERS_FILE = 'users.json';

function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

/** A loaded document: the server-side replica plus its op log. */
export class LiveDoc {
  constructor(store, meta) {
    this.store = store;
    this.meta = meta;
    this.doc = createDocument({ id: meta.id, actor: 'server' });
    this.ops = [];
    this.seen = new Set();
    this.sockets = new Set();
    this.waiters = [];
    this.logFile = path.join(store.dir, `${meta.id}.ops.jsonl`);
    if (fs.existsSync(this.logFile)) {
      for (const line of fs.readFileSync(this.logFile, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const op = JSON.parse(line);
        if (this.seen.has(op.id)) continue;
        this.seen.add(op.id);
        this.ops.push(op);
        this.doc.receive(op);
      }
    }
    this.doc.pendingOps();
    this.meta.seq = this.ops.length;
  }

  get seq() {
    return this.ops.length;
  }

  /**
   * Integrates ops (from clients or from server-side changes). Returns the ops that were new.
   * Throws DiagramError for malformed ops; nothing is applied in that case.
   */
  ingest(ops) {
    for (const op of ops) {
      if (!op || typeof op.id !== 'string' || !Array.isArray(op.writes)) {
        throw new Error('malformed op');
      }
    }
    const fresh = [];
    for (const op of ops) {
      if (this.seen.has(op.id)) continue;
      this.seen.add(op.id);
      fresh.push(op);
    }
    if (fresh.length === 0) return fresh;
    this.doc.receive(fresh);
    this.ops.push(...fresh);
    fs.appendFileSync(this.logFile, fresh.map((o) => JSON.stringify(o) + '\n').join(''));
    this.meta.seq = this.ops.length;
    this.store.saveMeta(this.meta);
    this.notify();
    return fresh;
  }

  /** Flushes ops produced by server-side changes to the local replica. */
  flushLocal() {
    const pending = this.doc.pendingOps();
    return pending.length ? this.ingest(pending) : [];
  }

  notify() {
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws) w();
  }
}

export class Store {
  constructor(dataDir) {
    this.dir = path.resolve(dataDir);
    fs.mkdirSync(this.dir, { recursive: true });
    const usersPath = path.join(this.dir, USERS_FILE);
    this.usersPath = usersPath;
    this.auth = fs.existsSync(usersPath)
      ? JSON.parse(fs.readFileSync(usersPath, 'utf8'))
      : { users: {}, sessions: {} };
    this.metas = new Map();
    this.live = new Map();
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith('.json') || name === USERS_FILE) continue;
      const meta = JSON.parse(fs.readFileSync(path.join(this.dir, name), 'utf8'));
      if (meta && meta.id) this.metas.set(meta.id, meta);
    }
  }

  saveAuth() {
    writeAtomic(this.usersPath, JSON.stringify(this.auth));
  }

  saveMeta(meta) {
    writeAtomic(path.join(this.dir, `${meta.id}.json`), JSON.stringify(meta));
  }

  newId() {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  }

  createDoc(meta) {
    this.metas.set(meta.id, meta);
    this.saveMeta(meta);
    return this.liveDoc(meta.id);
  }

  liveDoc(id) {
    let l = this.live.get(id);
    if (!l) {
      const meta = this.metas.get(id);
      if (!meta) return null;
      l = new LiveDoc(this, meta);
      this.live.set(id, l);
    }
    return l;
  }

  deleteDoc(id) {
    this.metas.delete(id);
    this.live.delete(id);
    for (const f of [`${id}.json`, `${id}.ops.jsonl`]) {
      const p = path.join(this.dir, f);
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  }

  /** Owner, or a member with an explicit role. */
  roleOf(meta, username) {
    if (meta.owner === username) return 'owner';
    return meta.members[username] ?? null;
  }

  hashPassword(password, salt) {
    return crypto.scryptSync(password, salt, 32).toString('hex');
  }

  register(username, password) {
    if (this.auth.users[username]) return false;
    const salt = crypto.randomBytes(16).toString('hex');
    this.auth.users[username] = { username, salt, hash: this.hashPassword(password, salt) };
    this.saveAuth();
    return true;
  }

  verify(username, password) {
    const u = this.auth.users[username];
    if (!u) return false;
    const h = Buffer.from(this.hashPassword(password, u.salt), 'hex');
    const want = Buffer.from(u.hash, 'hex');
    return h.length === want.length && crypto.timingSafeEqual(h, want);
  }

  login(username) {
    const token = crypto.randomBytes(24).toString('hex');
    this.auth.sessions[token] = username;
    this.saveAuth();
    return token;
  }

  userFor(token) {
    if (!token) return null;
    const name = this.auth.sessions[token];
    return name && this.auth.users[name] ? name : null;
  }
}
