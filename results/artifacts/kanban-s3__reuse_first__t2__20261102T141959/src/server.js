import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { HTML } from './ui.js';

class HttpError extends Error { constructor(s, code, msg) { super(msg || code); this.status = s; this.code = code; } }
const E = (s, c, m) => new HttpError(s, c, m);
const bad = m => E(400, 'validation', m);
const forbid = () => E(403, 'forbidden', 'forbidden');
const nf = () => E(404, 'not_found', 'not found');
const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const isStr = v => typeof v === 'string';
const isDate = v => isStr(v) && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;

export function createServer({ dataFile } = {}) {
  let db = { users: [], boards: [], members: [], columns: [], cards: [], labels: [], comments: [], activity: [] };
  if (dataFile && fs.existsSync(dataFile)) {
    try { db = { ...db, ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) }; } catch {}
  }
  const save = () => { if (dataFile) { const t = dataFile + '.tmp'; fs.writeFileSync(t, JSON.stringify(db)); fs.renameSync(t, dataFile); } };
  const sessions = new Map();
  const fails = new Map();

  const pubUser = u => ({ id: u.id, username: u.username, displayName: u.displayName });
  const log = (boardId, type, actorId, cardId, details = {}) => {
    const e = { id: uid(), boardId, type, actorId, at: now(), details };
    if (cardId) e.cardId = cardId;
    db.activity.push(e);
  };
  const hash = (pw, salt) => crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 64).toString('hex');

  const roleOf = (boardId, userId) => db.members.find(m => m.boardId === boardId && m.userId === userId)?.role;
  const getBoard = id => db.boards.find(b => b.id === id) || (() => { throw nf(); })();
  const need = (boardId, user, min) => {
    const r = roleOf(boardId, user.id);
    if (!r) throw forbid();
    const rank = { viewer: 0, editor: 1, owner: 2 };
    if (rank[r] < rank[min]) throw forbid();
    return r;
  };
  const colCards = cid => db.cards.filter(c => c.columnId === cid).sort((a, b) => a.position - b.position);
  const boardCols = bid => db.columns.filter(c => c.boardId === bid).sort((a, b) => a.position - b.position);
  const renum = list => list.forEach((x, i) => { x.position = i; });
  const getCol = id => db.columns.find(c => c.id === id) || (() => { throw nf(); })();
  const getCard = id => db.cards.find(c => c.id === id) || (() => { throw nf(); })();
  const insertAt = (list, item, pos) => {
    const p = pos === undefined || pos === null ? list.length : Math.max(0, Math.min(pos, list.length));
    list.splice(p, 0, item); renum(list);
  };
  const optPos = v => {
    if (v === undefined || v === null) return undefined;
    if (!Number.isInteger(v) || v < 0) throw bad('invalid position');
    return v;
  };
  const colOut = c => ({ id: c.id, boardId: c.boardId, name: c.name, position: c.position, wipLimit: c.wipLimit });
  const cardOut = c => ({ ...c });
  const checkWip = col => { if (col.wipLimit && colCards(col.id).length >= col.wipLimit) throw E(409, 'wip_limit', 'WIP limit reached'); };
  const checkWipVal = v => { if (v !== null && v !== undefined && !(Number.isInteger(v) && v > 0)) throw bad('wipLimit must be positive integer or null'); };

  function validateCardRefs(board, body, partial) {
    if (body.assignees !== undefined) {
      if (!Array.isArray(body.assignees) || !body.assignees.every(a => isStr(a) && roleOf(board, a))) throw bad('invalid assignees');
    }
    if (body.labels !== undefined) {
      if (!Array.isArray(body.labels) || !body.labels.every(l => db.labels.some(x => x.id === l && x.boardId === board))) throw bad('invalid labels');
    }
    if (body.dueDate !== undefined && body.dueDate !== null && !isDate(body.dueDate)) throw bad('invalid dueDate');
    if (body.description !== undefined && !isStr(body.description)) throw bad('invalid description');
  }
  const checkTitle = t => { if (!isStr(t) || t.length < 1 || t.length > 200) throw bad('title must be 1-200 chars'); };

  function deleteCards(pred) { db.cards = db.cards.filter(c => !pred(c)); }

  // ---- routes ----
  const routes = [];
  const R = (method, path, auth, fn) => {
    const keys = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, auth, fn });
  };

  R('POST', '/api/auth/register', false, ({ body }) => {
    const { username, password } = body;
    if (!isStr(username) || !/^[a-zA-Z0-9_]{3,32}$/.test(username)) throw bad('invalid username');
    if (!isStr(password) || password.length < 8) throw bad('password too short');
    if (body.displayName !== undefined && (!isStr(body.displayName) || !body.displayName.trim())) throw bad('invalid displayName');
    const un = username.toLowerCase();
    if (db.users.some(u => u.username === un)) throw E(409, 'conflict', 'username taken');
    const salt = crypto.randomBytes(16).toString('hex');
    const u = { id: uid(), username: un, displayName: body.displayName ?? un, salt, hash: hash(password, salt), createdAt: now() };
    db.users.push(u); save();
    return [201, { user: pubUser(u) }];
  });
  R('POST', '/api/auth/login', false, ({ body }) => {
    const { username, password } = body;
    if (!isStr(username) || !isStr(password)) throw bad('username and password required');
    const un = username.toLowerCase();
    const t = Date.now();
    const f = (fails.get(un) || []).filter(x => t - x < 15 * 60000);
    fails.set(un, f);
    if (f.length >= 5) throw E(429, 'rate_limited', 'too many attempts');
    const u = db.users.find(x => x.username === un);
    let ok = false;
    if (u) { const a = Buffer.from(hash(password, u.salt), 'hex'), b = Buffer.from(u.hash, 'hex'); ok = crypto.timingSafeEqual(a, b); }
    if (!ok) { f.push(t); throw E(401, 'unauthorized', 'invalid credentials'); }
    fails.delete(un);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, u.id);
    return [200, { token, user: pubUser(u) }];
  });
  R('POST', '/api/auth/logout', true, ({ token }) => { sessions.delete(token); return [204]; });
  R('GET', '/api/auth/me', true, ({ user }) => [200, { user: pubUser(user) }]);

  const boardView = b => ({
    id: b.id, name: b.name, description: b.description, ownerId: b.ownerId, createdAt: b.createdAt,
    members: db.members.filter(m => m.boardId === b.id).map(m => ({ userId: m.userId, username: db.users.find(u => u.id === m.userId)?.username, role: m.role })),
    labels: db.labels.filter(l => l.boardId === b.id),
    columns: boardCols(b.id).map(c => ({ ...colOut(c), cards: colCards(c.id).map(cardOut) })),
  });
  const optName = (v, max) => { if (!isStr(v) || v.trim().length < 1 || v.length > max) throw bad('invalid name'); };

  R('POST', '/api/boards', true, ({ body, user }) => {
    optName(body.name, 100);
    if (body.description !== undefined && !isStr(body.description)) throw bad('invalid description');
    let names = body.columns ?? ['To Do', 'In Progress', 'Done'];
    if (!Array.isArray(names) || !names.every(n => isStr(n) && n.length >= 1 && n.length <= 100)) throw bad('invalid columns');
    const b = { id: uid(), name: body.name, description: body.description ?? '', ownerId: user.id, createdAt: now() };
    db.boards.push(b);
    db.members.push({ boardId: b.id, userId: user.id, role: 'owner' });
    names.forEach((n, i) => db.columns.push({ id: uid(), boardId: b.id, name: n, position: i, wipLimit: null }));
    log(b.id, 'board.created', user.id, null, { name: b.name });
    save();
    return [201, boardView(b)];
  });
  R('GET', '/api/boards', true, ({ user }) => [200, db.members.filter(m => m.userId === user.id).map(m => {
    const b = db.boards.find(x => x.id === m.boardId); return { id: b.id, name: b.name, role: m.role };
  })]);
  R('GET', '/api/boards/:id', true, ({ p, user }) => { const b = getBoard(p.id); need(b.id, user, 'viewer'); return [200, boardView(b)]; });
  R('PATCH', '/api/boards/:id', true, ({ p, user, body }) => {
    const b = getBoard(p.id); need(b.id, user, 'owner');
    if (body.name !== undefined) optName(body.name, 100);
    if (body.description !== undefined && !isStr(body.description)) throw bad('invalid description');
    if (body.name !== undefined) b.name = body.name;
    if (body.description !== undefined) b.description = body.description;
    save(); return [200, boardView(b)];
  });
  R('DELETE', '/api/boards/:id', true, ({ p, user }) => {
    const b = getBoard(p.id); need(b.id, user, 'owner');
    const cardIds = new Set(db.cards.filter(c => c.boardId === b.id).map(c => c.id));
    db.boards = db.boards.filter(x => x.id !== b.id);
    for (const k of ['members', 'columns', 'cards', 'labels', 'activity']) db[k] = db[k].filter(x => x.boardId !== b.id);
    db.comments = db.comments.filter(c => !cardIds.has(c.cardId));
    save(); return [204];
  });
  R('POST', '/api/boards/:id/members', true, ({ p, user, body }) => {
    const b = getBoard(p.id); need(b.id, user, 'owner');
    if (!['editor', 'viewer'].includes(body.role)) throw bad('invalid role');
    if (!isStr(body.username)) throw bad('username required');
    const u = db.users.find(x => x.username === body.username.toLowerCase());
    if (!u) throw nf();
    if (roleOf(b.id, u.id)) throw E(409, 'conflict', 'already a member');
    db.members.push({ boardId: b.id, userId: u.id, role: body.role });
    log(b.id, 'member.added', user.id, null, { userId: u.id, role: body.role });
    save(); return [201, { userId: u.id, username: u.username, role: body.role }];
  });
  R('PATCH', '/api/boards/:id/members/:uid', true, ({ p, user, body }) => {
    const b = getBoard(p.id); need(b.id, user, 'owner');
    const m = db.members.find(x => x.boardId === b.id && x.userId === p.uid);
    if (!m) throw nf();
    if (!['editor', 'viewer'].includes(body.role)) throw bad('invalid role');
    if (m.role === 'owner') throw bad('cannot change owner role');
    m.role = body.role; save();
    return [200, { userId: m.userId, username: db.users.find(u => u.id === m.userId)?.username, role: m.role }];
  });
  R('DELETE', '/api/boards/:id/members/:uid', true, ({ p, user }) => {
    const b = getBoard(p.id);
    const r = need(b.id, user, 'viewer');
    if (r !== 'owner' && user.id !== p.uid) throw forbid();
    const m = db.members.find(x => x.boardId === b.id && x.userId === p.uid);
    if (!m) throw nf();
    if (m.role === 'owner') throw bad('cannot remove owner');
    db.members = db.members.filter(x => x !== m);
    for (const c of db.cards.filter(c => c.boardId === b.id)) c.assignees = c.assignees.filter(a => a !== p.uid);
    save(); return [204];
  });

  // columns
  R('POST', '/api/boards/:id/columns', true, ({ p, user, body }) => {
    const b = getBoard(p.id); need(b.id, user, 'editor');
    optName(body.name, 100); checkWipVal(body.wipLimit);
    const c = { id: uid(), boardId: b.id, name: body.name, position: boardCols(b.id).length, wipLimit: body.wipLimit ?? null };
    db.columns.push(c);
    log(b.id, 'column.created', user.id, null, { columnId: c.id, name: c.name });
    save(); return [201, colOut(c)];
  });
  R('PATCH', '/api/columns/:id', true, ({ p, user, body }) => {
    const c = getCol(p.id); need(c.boardId, user, 'editor');
    if (body.name !== undefined) optName(body.name, 100);
    if (body.wipLimit !== undefined) checkWipVal(body.wipLimit);
    if (body.position !== undefined && !Number.isInteger(body.position)) throw bad('invalid position');
    if (body.name !== undefined) c.name = body.name;
    if (body.wipLimit !== undefined) c.wipLimit = body.wipLimit;
    if (body.position !== undefined) {
      const list = boardCols(c.boardId).filter(x => x !== c);
      insertAt(list, c, body.position);
    }
    save(); return [200, colOut(c)];
  });
  R('DELETE', '/api/columns/:id', true, ({ p, user, query }) => {
    const c = getCol(p.id); need(c.boardId, user, 'editor');
    const has = colCards(c.id);
    if (has.length && query.get('force') !== 'true') throw E(409, 'conflict', 'column has cards');
    const ids = new Set(has.map(x => x.id));
    deleteCards(x => x.columnId === c.id);
    db.comments = db.comments.filter(x => !ids.has(x.cardId));
    db.columns = db.columns.filter(x => x !== c);
    renum(boardCols(c.boardId));
    save(); return [204];
  });

  // cards
  R('POST', '/api/columns/:id/cards', true, ({ p, user, body }) => {
    const col = getCol(p.id); need(col.boardId, user, 'editor');
    checkTitle(body.title); validateCardRefs(col.boardId, body);
    const pos = optPos(body.position);
    checkWip(col);
    const t = now();
    const card = { id: uid(), boardId: col.boardId, columnId: col.id, title: body.title, description: body.description ?? '', position: 0,
      assignees: [...new Set(body.assignees ?? [])], labels: [...new Set(body.labels ?? [])], dueDate: body.dueDate ?? null, createdBy: user.id, createdAt: t, updatedAt: t };
    const list = colCards(col.id);
    insertAt(list, card, pos);
    db.cards.push(card);
    log(col.boardId, 'card.created', user.id, card.id, { columnId: col.id, title: card.title });
    save(); return [201, cardOut(card)];
  });
  R('GET', '/api/cards/:id', true, ({ p, user }) => { const c = getCard(p.id); need(c.boardId, user, 'viewer'); return [200, cardOut(c)]; });
  R('PATCH', '/api/cards/:id', true, ({ p, user, body }) => {
    const c = getCard(p.id); need(c.boardId, user, 'editor');
    if (body.title !== undefined) checkTitle(body.title);
    validateCardRefs(c.boardId, body);
    const changed = [];
    for (const k of ['title', 'description', 'assignees', 'labels', 'dueDate']) if (body[k] !== undefined) { c[k] = body[k]; changed.push(k); }
    c.updatedAt = now();
    log(c.boardId, 'card.updated', user.id, c.id, { fields: changed });
    save(); return [200, cardOut(c)];
  });
  R('DELETE', '/api/cards/:id', true, ({ p, user }) => {
    const c = getCard(p.id); need(c.boardId, user, 'editor');
    db.cards = db.cards.filter(x => x !== c);
    db.comments = db.comments.filter(x => x.cardId !== c.id);
    renum(colCards(c.columnId));
    log(c.boardId, 'card.deleted', user.id, c.id, { columnId: c.columnId, title: c.title });
    save(); return [204];
  });
  R('POST', '/api/cards/:id/move', true, ({ p, user, body }) => {
    const c = getCard(p.id); need(c.boardId, user, 'editor');
    if (!isStr(body.columnId)) throw bad('columnId required');
    const target = db.columns.find(x => x.id === body.columnId);
    if (!target || target.boardId !== c.boardId) throw bad('invalid target column');
    const pos = optPos(body.position);
    const from = c.columnId;
    if (from !== target.id) checkWip(target);
    const src = colCards(from).filter(x => x !== c);
    renum(src);
    const dst = from === target.id ? src : colCards(target.id);
    c.columnId = target.id;
    insertAt(dst, c, pos);
    c.updatedAt = now();
    log(c.boardId, 'card.moved', user.id, c.id, { fromColumnId: from, toColumnId: target.id, position: c.position });
    save(); return [200, cardOut(c)];
  });

  // labels
  R('POST', '/api/boards/:id/labels', true, ({ p, user, body }) => {
    const b = getBoard(p.id); need(b.id, user, 'editor');
    optName(body.name, 100);
    if (!isStr(body.color) || !/^#[0-9a-fA-F]{6}$/.test(body.color)) throw bad('invalid color');
    if (db.labels.some(l => l.boardId === b.id && l.name.toLowerCase() === body.name.toLowerCase())) throw E(409, 'conflict', 'label exists');
    const l = { id: uid(), boardId: b.id, name: body.name, color: body.color };
    db.labels.push(l); save(); return [201, l];
  });
  R('DELETE', '/api/labels/:id', true, ({ p, user }) => {
    const l = db.labels.find(x => x.id === p.id); if (!l) throw nf();
    need(l.boardId, user, 'editor');
    db.labels = db.labels.filter(x => x !== l);
    for (const c of db.cards) c.labels = c.labels.filter(x => x !== l.id);
    save(); return [204];
  });

  // comments
  R('POST', '/api/cards/:id/comments', true, ({ p, user, body }) => {
    const c = getCard(p.id); need(c.boardId, user, 'editor');
    if (!isStr(body.body) || body.body.length < 1 || body.body.length > 5000) throw bad('invalid body');
    const m = { id: uid(), cardId: c.id, authorId: user.id, body: body.body, createdAt: now() };
    db.comments.push(m);
    log(c.boardId, 'comment.added', user.id, c.id, { commentId: m.id });
    save(); return [201, m];
  });
  R('GET', '/api/cards/:id/comments', true, ({ p, user }) => {
    const c = getCard(p.id); need(c.boardId, user, 'viewer');
    return [200, db.comments.filter(x => x.cardId === c.id)];
  });
  R('DELETE', '/api/comments/:id', true, ({ p, user }) => {
    const m = db.comments.find(x => x.id === p.id); if (!m) throw nf();
    const c = db.cards.find(x => x.id === m.cardId);
    const r = need(c.boardId, user, 'viewer');
    if (m.authorId !== user.id && r !== 'owner') throw forbid();
    db.comments = db.comments.filter(x => x !== m); save(); return [204];
  });

  // search & activity
  R('GET', '/api/boards/:id/cards', true, ({ p, user, query }) => {
    const b = getBoard(p.id); need(b.id, user, 'viewer');
    const q = query.get('q')?.toLowerCase(), as = query.get('assignee'), lb = query.get('label'), col = query.get('column'), db4 = query.get('due_before');
    if (db4 && !isDate(db4)) throw bad('invalid due_before');
    const cols = new Map(boardCols(b.id).map(c => [c.id, c.position]));
    const out = db.cards.filter(c => c.boardId === b.id
      && (!q || c.title.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
      && (!as || c.assignees.includes(as)) && (!lb || c.labels.includes(lb)) && (!col || c.columnId === col)
      && (!db4 || (c.dueDate && c.dueDate < db4)));
    out.sort((a, b2) => cols.get(a.columnId) - cols.get(b2.columnId) || a.position - b2.position);
    return [200, out.map(cardOut)];
  });
  R('GET', '/api/boards/:id/activity', true, ({ p, user, query }) => {
    const b = getBoard(p.id); need(b.id, user, 'viewer');
    let lim = query.has('limit') ? Number(query.get('limit')) : 50;
    if (!Number.isInteger(lim) || lim < 1) throw bad('invalid limit');
    return [200, db.activity.filter(a => a.boardId === b.id).reverse().slice(0, lim)];
  });

  const server = http.createServer((req, res) => {
    const send = (s, b, type = 'application/json') => {
      if (s === 204) { res.writeHead(204); return res.end(); }
      const data = type === 'application/json' ? JSON.stringify(b) : b;
      res.writeHead(s, { 'content-type': type + (type === 'application/json' ? '' : '; charset=utf-8') });
      res.end(data);
    };
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      try {
        const url = new URL(req.url, 'http://x');
        const path = url.pathname.replace(/(.)\/$/, '$1');
        if (req.method === 'GET' && path === '/') return send(200, HTML, 'text/html');
        let matched = null, pathMatched = false;
        for (const r of routes) {
          const m = r.re.exec(path);
          if (!m) continue;
          pathMatched = true;
          if (r.method !== req.method) continue;
          const p = {}; r.keys.forEach((k, i) => { p[k] = decodeURIComponent(m[i + 1]); });
          matched = { r, p }; break;
        }
        if (!matched) throw pathMatched ? E(405, 'method_not_allowed', 'method not allowed') : nf();
        let user = null, token = null;
        if (matched.r.auth) {
          const h = req.headers.authorization || '';
          token = h.startsWith('Bearer ') ? h.slice(7).trim() : null;
          const id = token && sessions.get(token);
          user = id && db.users.find(u => u.id === id);
          if (!user) throw E(401, 'unauthorized', 'authentication required');
        }
        let body = {};
        if (['POST', 'PATCH', 'PUT'].includes(req.method)) {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (raw.trim()) {
            try { body = JSON.parse(raw); } catch { throw bad('invalid JSON'); }
            if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('body must be an object');
          }
        }
        const [s, out] = matched.r.fn({ p: matched.p, user, token, body, query: url.searchParams });
        send(s, out);
      } catch (e) {
        if (e instanceof HttpError) send(e.status, { error: e.code, message: e.message });
        else { console.error(e); send(500, { error: 'internal', message: 'internal error' }); }
      }
    });
  });
  return server;
}
