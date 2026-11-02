import http from 'node:http';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { HTML } from './ui.js';

class HttpError extends Error { constructor(status, error, message) { super(message || error); this.status = status; this.code = error; } }
const E = (s, c, m) => new HttpError(s, c, m);
const bad = (m) => E(400, 'validation', m);
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const isStr = (v) => typeof v === 'string';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s) => isStr(s) && DATE_RE.test(s) && !isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;

export function createServer({ dataFile } = {}) {
  let db = { users: [], boards: [], members: [], columns: [], cards: [], labels: [], comments: [], activity: [] };
  if (dataFile && fs.existsSync(dataFile)) {
    try { db = { ...db, ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) }; } catch {}
  }
  const sessions = new Map();
  const fails = new Map();
  const save = () => { if (dataFile) fs.writeFileSync(dataFile, JSON.stringify(db)); };

  const pubUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName });
  const log = (boardId, type, actorId, cardId, details = {}) => {
    const e = { id: uid(), boardId, type, actorId, at: now(), details };
    if (cardId) e.cardId = cardId;
    db.activity.push(e);
  };
  const role = (boardId, userId) => db.members.find((m) => m.boardId === boardId && m.userId === userId)?.role;
  const RANK = { viewer: 1, editor: 2, owner: 3 };
  const need = (boardId, user, min) => {
    const r = role(boardId, user.id);
    if (!r) throw E(403, 'forbidden', 'not a member');
    if (RANK[r] < RANK[min]) throw E(403, 'forbidden', 'insufficient role');
    return r;
  };
  const getBoard = (id) => db.boards.find((b) => b.id === id) || (() => { throw E(404, 'not_found', 'board not found'); })();
  const getCol = (id) => db.columns.find((c) => c.id === id) || (() => { throw E(404, 'not_found', 'column not found'); })();
  const getCard = (id) => db.cards.find((c) => c.id === id) || (() => { throw E(404, 'not_found', 'card not found'); })();
  const colCards = (colId) => db.cards.filter((c) => c.columnId === colId).sort((a, b) => a.position - b.position);
  const boardCols = (bid) => db.columns.filter((c) => c.boardId === bid).sort((a, b) => a.position - b.position);
  const renum = (arr) => arr.forEach((x, i) => { x.position = i; });
  const clampPos = (p, n) => Math.max(0, Math.min(n, p));
  const optPos = (v) => { if (v === undefined || v === null) return undefined; if (!Number.isInteger(v)) throw bad('position must be integer'); return v; };
  const wipOk = (col, extra = 1) => !(col.wipLimit && colCards(col.id).length + extra > col.wipLimit);
  const checkWip = (v) => { if (v === undefined || v === null) return null; if (!Number.isInteger(v) || v < 1) throw bad('wipLimit must be positive integer'); return v; };
  const cardOut = (c) => ({ ...c, assignees: [...c.assignees], labels: [...c.labels] });
  const reqStr = (v, min, max, name) => { if (!isStr(v) || v.length < min || v.length > max) throw bad(`${name} must be ${min}-${max} chars`); return v; };

  function validateCardRefs(boardId, assignees, labels) {
    if (assignees !== undefined) {
      if (!Array.isArray(assignees) || !assignees.every(isStr)) throw bad('assignees must be array');
      for (const a of assignees) if (!role(boardId, a)) throw bad('assignee not a board member');
    }
    if (labels !== undefined) {
      if (!Array.isArray(labels) || !labels.every(isStr)) throw bad('labels must be array');
      for (const l of labels) if (!db.labels.some((x) => x.id === l && x.boardId === boardId)) throw bad('label not on board');
    }
  }
  function boardView(b) {
    return {
      id: b.id, name: b.name, description: b.description, ownerId: b.ownerId, createdAt: b.createdAt,
      members: db.members.filter((m) => m.boardId === b.id).map((m) => ({ userId: m.userId, username: db.users.find((u) => u.id === m.userId)?.username, role: m.role })),
      labels: db.labels.filter((l) => l.boardId === b.id),
      columns: boardCols(b.id).map((c) => ({ id: c.id, name: c.name, position: c.position, wipLimit: c.wipLimit, cards: colCards(c.id).map(cardOut) })),
    };
  }
  function removeCards(pred) {
    const ids = new Set(db.cards.filter(pred).map((c) => c.id));
    db.cards = db.cards.filter((c) => !ids.has(c.id));
    db.comments = db.comments.filter((c) => !ids.has(c.cardId));
  }
  const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');

  // routes: [method, regex, handler(ctx)] ; ctx: {user, params, body, query}
  const routes = [];
  const R = (m, p, h, auth = true) => routes.push([m, new RegExp('^' + p.replace(/:\w+/g, '([^/]+)') + '$'), h, auth]);

  R('POST', '/api/auth/register', ({ body }) => {
    const { username, password } = body;
    if (!isStr(username) || !/^[a-zA-Z0-9_]{3,32}$/.test(username)) throw bad('invalid username');
    if (!isStr(password) || password.length < 8) throw bad('password too short');
    if (body.displayName !== undefined && !isStr(body.displayName)) throw bad('invalid displayName');
    const un = username.toLowerCase();
    if (db.users.some((u) => u.username === un)) throw E(409, 'conflict', 'username taken');
    const salt = crypto.randomBytes(16).toString('hex');
    const u = { id: uid(), username: un, displayName: body.displayName || un, salt, hash: hashPw(password, salt) };
    db.users.push(u);
    return [201, { user: pubUser(u) }];
  }, false);
  R('POST', '/api/auth/login', ({ body }) => {
    const { username, password } = body;
    if (!isStr(username) || !isStr(password)) throw bad('username and password required');
    const un = username.toLowerCase();
    const cutoff = Date.now() - 15 * 60 * 1000;
    const f = (fails.get(un) || []).filter((t) => t > cutoff);
    fails.set(un, f);
    if (f.length >= 5) throw E(429, 'rate_limited', 'too many attempts');
    const u = db.users.find((x) => x.username === un);
    const ok = u && crypto.timingSafeEqual(Buffer.from(hashPw(password, u.salt), 'hex'), Buffer.from(u.hash, 'hex'));
    if (!ok) { f.push(Date.now()); throw E(401, 'unauthorized', 'invalid credentials'); }
    const token = crypto.randomBytes(24).toString('hex');
    sessions.set(token, u.id);
    return [200, { token, user: pubUser(u) }];
  }, false);
  R('POST', '/api/auth/logout', ({ token }) => { sessions.delete(token); return [204]; });
  R('GET', '/api/auth/me', ({ user }) => [200, { user: pubUser(user) }]);

  // boards
  R('POST', '/api/boards', ({ user, body }) => {
    reqStr(body.name, 1, 100, 'name');
    if (body.description !== undefined && body.description !== null && !isStr(body.description)) throw bad('invalid description');
    let names = ['To Do', 'In Progress', 'Done'];
    if (body.columns !== undefined) {
      if (!Array.isArray(body.columns) || !body.columns.every((n) => isStr(n) && n.length >= 1 && n.length <= 100)) throw bad('invalid columns');
      names = body.columns;
    }
    const b = { id: uid(), name: body.name, description: body.description || '', ownerId: user.id, createdAt: now() };
    db.boards.push(b);
    db.members.push({ boardId: b.id, userId: user.id, role: 'owner' });
    names.forEach((n, i) => db.columns.push({ id: uid(), boardId: b.id, name: n, position: i, wipLimit: null }));
    log(b.id, 'board.created', user.id, null, { name: b.name });
    return [201, boardView(b)];
  });
  R('GET', '/api/boards', ({ user }) => [200, db.members.filter((m) => m.userId === user.id).map((m) => {
    const b = db.boards.find((x) => x.id === m.boardId); return { id: b.id, name: b.name, role: m.role };
  })]);
  R('GET', '/api/boards/:id', ({ user, params }) => { const b = getBoard(params[0]); need(b.id, user, 'viewer'); return [200, boardView(b)]; });
  R('PATCH', '/api/boards/:id', ({ user, params, body }) => {
    const b = getBoard(params[0]); need(b.id, user, 'owner');
    if (body.name !== undefined) reqStr(body.name, 1, 100, 'name');
    if (body.description !== undefined && !isStr(body.description)) throw bad('invalid description');
    if (body.name !== undefined) b.name = body.name;
    if (body.description !== undefined) b.description = body.description;
    return [200, boardView(b)];
  });
  R('DELETE', '/api/boards/:id', ({ user, params }) => {
    const b = getBoard(params[0]); need(b.id, user, 'owner');
    removeCards((c) => c.boardId === b.id);
    for (const k of ['columns', 'labels', 'members', 'activity']) db[k] = db[k].filter((x) => x.boardId !== b.id);
    db.boards = db.boards.filter((x) => x !== b);
    return [204];
  });
  R('POST', '/api/boards/:id/members', ({ user, params, body }) => {
    const b = getBoard(params[0]); need(b.id, user, 'owner');
    if (!isStr(body.username)) throw bad('username required');
    if (body.role !== 'editor' && body.role !== 'viewer') throw bad('invalid role');
    const u = db.users.find((x) => x.username === body.username.toLowerCase());
    if (!u) throw E(404, 'not_found', 'user not found');
    if (role(b.id, u.id)) throw E(409, 'conflict', 'already member');
    db.members.push({ boardId: b.id, userId: u.id, role: body.role });
    log(b.id, 'member.added', user.id, null, { userId: u.id, role: body.role });
    return [201, { userId: u.id, username: u.username, role: body.role }];
  });
  R('PATCH', '/api/boards/:id/members/:uid', ({ user, params, body }) => {
    const b = getBoard(params[0]); need(b.id, user, 'owner');
    const m = db.members.find((x) => x.boardId === b.id && x.userId === params[1]);
    if (!m) throw E(404, 'not_found', 'member not found');
    if (body.role !== 'editor' && body.role !== 'viewer') throw bad('invalid role');
    if (m.role === 'owner') throw bad('cannot change owner role');
    m.role = body.role;
    return [200, { userId: m.userId, username: db.users.find((u) => u.id === m.userId)?.username, role: m.role }];
  });
  R('DELETE', '/api/boards/:id/members/:uid', ({ user, params }) => {
    const b = getBoard(params[0]);
    need(b.id, user, 'viewer');
    if (params[1] !== user.id) need(b.id, user, 'owner');
    const m = db.members.find((x) => x.boardId === b.id && x.userId === params[1]);
    if (!m) throw E(404, 'not_found', 'member not found');
    if (m.role === 'owner') throw bad('cannot remove owner');
    db.members = db.members.filter((x) => x !== m);
    for (const c of db.cards.filter((c) => c.boardId === b.id)) c.assignees = c.assignees.filter((a) => a !== m.userId);
    return [204];
  });

  // columns
  R('POST', '/api/boards/:id/columns', ({ user, params, body }) => {
    const b = getBoard(params[0]); need(b.id, user, 'editor');
    reqStr(body.name, 1, 100, 'name');
    const w = checkWip(body.wipLimit);
    const c = { id: uid(), boardId: b.id, name: body.name, position: boardCols(b.id).length, wipLimit: w };
    db.columns.push(c);
    log(b.id, 'column.created', user.id, null, { columnId: c.id, name: c.name });
    return [201, { ...c }];
  });
  R('PATCH', '/api/columns/:id', ({ user, params, body }) => {
    const c = getCol(params[0]); need(c.boardId, user, 'editor');
    if (body.name !== undefined) reqStr(body.name, 1, 100, 'name');
    const w = body.wipLimit !== undefined ? checkWip(body.wipLimit) : undefined;
    const p = optPos(body.position);
    if (body.name !== undefined) c.name = body.name;
    if (w !== undefined) c.wipLimit = w;
    if (p !== undefined) {
      const cols = boardCols(c.boardId).filter((x) => x !== c);
      cols.splice(clampPos(p, cols.length), 0, c);
      renum(cols);
    }
    return [200, { ...c }];
  });
  R('DELETE', '/api/columns/:id', ({ user, params, query }) => {
    const c = getCol(params[0]); need(c.boardId, user, 'editor');
    const n = colCards(c.id).length;
    if (n && query.get('force') !== 'true') throw E(409, 'conflict', 'column has cards');
    removeCards((x) => x.columnId === c.id);
    db.columns = db.columns.filter((x) => x !== c);
    renum(boardCols(c.boardId));
    return [204];
  });

  // cards
  R('POST', '/api/columns/:id/cards', ({ user, params, body }) => {
    const col = getCol(params[0]); need(col.boardId, user, 'editor');
    reqStr(body.title, 1, 200, 'title');
    if (body.description !== undefined && body.description !== null && !isStr(body.description)) throw bad('invalid description');
    if (body.dueDate !== undefined && body.dueDate !== null && !validDate(body.dueDate)) throw bad('invalid dueDate');
    validateCardRefs(col.boardId, body.assignees, body.labels);
    const p = optPos(body.position);
    if (!wipOk(col)) throw E(409, 'wip_limit', 'WIP limit reached');
    const t = now();
    const card = { id: uid(), boardId: col.boardId, columnId: col.id, title: body.title, description: body.description || '', position: 0,
      assignees: body.assignees || [], labels: body.labels || [], dueDate: body.dueDate ?? null, createdBy: user.id, createdAt: t, updatedAt: t };
    const list = colCards(col.id);
    list.splice(p === undefined ? list.length : clampPos(p, list.length), 0, card);
    db.cards.push(card);
    renum(list);
    log(col.boardId, 'card.created', user.id, card.id, { columnId: col.id, title: card.title });
    return [201, cardOut(card)];
  });
  R('GET', '/api/cards/:id', ({ user, params }) => { const c = getCard(params[0]); need(c.boardId, user, 'viewer'); return [200, cardOut(c)]; });
  R('PATCH', '/api/cards/:id', ({ user, params, body }) => {
    const c = getCard(params[0]); need(c.boardId, user, 'editor');
    if (body.title !== undefined) reqStr(body.title, 1, 200, 'title');
    if (body.description !== undefined && body.description !== null && !isStr(body.description)) throw bad('invalid description');
    if (body.dueDate !== undefined && body.dueDate !== null && !validDate(body.dueDate)) throw bad('invalid dueDate');
    validateCardRefs(c.boardId, body.assignees, body.labels);
    for (const k of ['title', 'description', 'assignees', 'labels', 'dueDate']) if (body[k] !== undefined) c[k] = body[k];
    if (c.description === null) c.description = '';
    c.updatedAt = now();
    log(c.boardId, 'card.updated', user.id, c.id, { fields: Object.keys(body) });
    return [200, cardOut(c)];
  });
  R('DELETE', '/api/cards/:id', ({ user, params }) => {
    const c = getCard(params[0]); need(c.boardId, user, 'editor');
    removeCards((x) => x === c);
    renum(colCards(c.columnId));
    log(c.boardId, 'card.deleted', user.id, c.id, { columnId: c.columnId, title: c.title });
    return [204];
  });
  R('POST', '/api/cards/:id/move', ({ user, params, body }) => {
    const c = getCard(params[0]); need(c.boardId, user, 'editor');
    if (!isStr(body.columnId)) throw bad('columnId required');
    const target = db.columns.find((x) => x.id === body.columnId);
    if (!target) throw E(404, 'not_found', 'column not found');
    if (target.boardId !== c.boardId) throw bad('column on different board');
    const p = optPos(body.position);
    const from = c.columnId;
    if (from !== target.id && !wipOk(target)) throw E(409, 'wip_limit', 'WIP limit reached');
    const src = colCards(from).filter((x) => x !== c);
    const dst = from === target.id ? src : colCards(target.id);
    dst.splice(p === undefined ? dst.length : clampPos(p, dst.length), 0, c);
    c.columnId = target.id;
    if (src !== dst) renum(src);
    renum(dst);
    c.updatedAt = now();
    log(c.boardId, 'card.moved', user.id, c.id, { fromColumnId: from, toColumnId: target.id });
    return [200, cardOut(c)];
  });

  // labels
  R('POST', '/api/boards/:id/labels', ({ user, params, body }) => {
    const b = getBoard(params[0]); need(b.id, user, 'editor');
    reqStr(body.name, 1, 100, 'name');
    if (!isStr(body.color) || !/^#[0-9a-fA-F]{6}$/.test(body.color)) throw bad('invalid color');
    if (db.labels.some((l) => l.boardId === b.id && l.name.toLowerCase() === body.name.toLowerCase())) throw E(409, 'conflict', 'label exists');
    const l = { id: uid(), boardId: b.id, name: body.name, color: body.color };
    db.labels.push(l);
    return [201, { ...l }];
  });
  R('DELETE', '/api/labels/:id', ({ user, params }) => {
    const l = db.labels.find((x) => x.id === params[0]);
    if (!l) throw E(404, 'not_found', 'label not found');
    need(l.boardId, user, 'editor');
    db.labels = db.labels.filter((x) => x !== l);
    for (const c of db.cards) c.labels = c.labels.filter((x) => x !== l.id);
    return [204];
  });

  // comments
  R('POST', '/api/cards/:id/comments', ({ user, params, body }) => {
    const c = getCard(params[0]); need(c.boardId, user, 'editor');
    reqStr(body.body, 1, 5000, 'body');
    const m = { id: uid(), cardId: c.id, authorId: user.id, body: body.body, createdAt: now() };
    db.comments.push(m);
    log(c.boardId, 'comment.added', user.id, c.id, { commentId: m.id });
    return [201, m];
  });
  R('GET', '/api/cards/:id/comments', ({ user, params }) => {
    const c = getCard(params[0]); need(c.boardId, user, 'viewer');
    return [200, db.comments.filter((m) => m.cardId === c.id)];
  });
  R('DELETE', '/api/comments/:id', ({ user, params }) => {
    const m = db.comments.find((x) => x.id === params[0]);
    if (!m) throw E(404, 'not_found', 'comment not found');
    const card = getCard(m.cardId);
    const r = need(card.boardId, user, 'viewer');
    if (m.authorId !== user.id && r !== 'owner') throw E(403, 'forbidden', 'not allowed');
    db.comments = db.comments.filter((x) => x !== m);
    return [204];
  });

  // search & activity
  R('GET', '/api/boards/:id/cards', ({ user, params, query }) => {
    const b = getBoard(params[0]); need(b.id, user, 'viewer');
    const q = query.get('q'), as = query.get('assignee'), lb = query.get('label'), col = query.get('column'), due = query.get('due_before');
    if (due !== null && !validDate(due)) throw bad('invalid due_before');
    const pos = new Map(db.columns.map((c) => [c.id, c.position]));
    return [200, db.cards.filter((c) => c.boardId === b.id
      && (!q || c.title.toLowerCase().includes(q.toLowerCase()) || (c.description || '').toLowerCase().includes(q.toLowerCase()))
      && (!as || c.assignees.includes(as)) && (!lb || c.labels.includes(lb)) && (!col || c.columnId === col)
      && (due === null || (c.dueDate && c.dueDate < due)))
      .sort((a, b2) => pos.get(a.columnId) - pos.get(b2.columnId) || a.position - b2.position).map(cardOut)];
  });
  R('GET', '/api/boards/:id/activity', ({ user, params, query }) => {
    const b = getBoard(params[0]); need(b.id, user, 'viewer');
    let limit = 50;
    if (query.has('limit')) { limit = Number(query.get('limit')); if (!Number.isInteger(limit) || limit < 1) throw bad('invalid limit'); }
    return [200, db.activity.filter((a) => a.boardId === b.id).reverse().slice(0, limit)];
  });

  async function handle(req, res) {
    const send = (status, obj, type = 'application/json') => {
      const data = obj === undefined ? '' : type === 'application/json' ? JSON.stringify(obj) : obj;
      res.writeHead(status, { 'content-type': type + (type === 'application/json' ? '' : '; charset=utf-8') });
      res.end(status === 204 ? undefined : data);
    };
    try {
      const url = new URL(req.url, 'http://x');
      const path = url.pathname.replace(/(.)\/$/, '$1');
      if (req.method === 'GET' && path === '/') return send(200, HTML, 'text/html');
      if (path.startsWith('/static/')) throw E(404, 'not_found', 'not found');
      let matched = null, pathMatch = false;
      for (const r of routes) {
        const m = r[1].exec(path);
        if (m) { pathMatch = true; if (r[0] === req.method) { matched = [r, m.slice(1).map(decodeURIComponent)]; break; } }
      }
      if (!matched) throw pathMatch ? E(405, 'method_not_allowed', 'method not allowed') : E(404, 'not_found', 'not found');
      const [[, , handler, auth], params] = matched;
      let user = null, token = null;
      if (auth) {
        const h = req.headers.authorization || '';
        token = h.startsWith('Bearer ') ? h.slice(7) : null;
        const id = token && sessions.get(token);
        user = id && db.users.find((u) => u.id === id);
        if (!user) throw E(401, 'unauthorized', 'authentication required');
      }
      let body = {};
      if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
        const chunks = [];
        for await (const ch of req) chunks.push(ch);
        const raw = Buffer.concat(chunks).toString('utf8');
        if (raw.trim()) {
          try { body = JSON.parse(raw); } catch { throw bad('invalid JSON'); }
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('body must be an object');
      }
      const out = handler({ user, token, params, body, query: url.searchParams });
      if (req.method !== 'GET') save();
      send(out[0], out[1]);
    } catch (e) {
      if (e instanceof HttpError) return send(e.status, { error: e.code, message: e.message });
      console.error(e);
      send(500, { error: 'internal', message: 'internal error' });
    }
  }
  return http.createServer(handle);
}
