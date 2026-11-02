import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { INDEX_HTML } from './ui.js';

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
class HttpError extends Error { constructor(s, code, msg) { super(msg || code); this.status = s; this.code = code; } }
const bad = (m) => new HttpError(400, 'validation', m);
const forbidden = () => new HttpError(403, 'forbidden', 'forbidden');
const notFound = (m) => new HttpError(404, 'not_found', m || 'not found');
const isStr = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max;
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;

export function createServer({ dataFile } = {}) {
  let db = { users: [], boards: [], members: [], columns: [], cards: [], labels: [], comments: [], activity: [] };
  if (dataFile && fs.existsSync(dataFile)) {
    try { db = { ...db, ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) }; } catch {}
  }
  const save = () => { if (dataFile) { fs.writeFileSync(dataFile + '.tmp', JSON.stringify(db)); fs.renameSync(dataFile + '.tmp', dataFile); } };
  const sessions = new Map();
  const fails = new Map();

  const pubUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName });
  const log = (boardId, type, actorId, cardId, details = {}) => {
    const e = { id: uid(), boardId, type, actorId, at: now(), details };
    if (cardId) e.cardId = cardId;
    db.activity.push(e);
  };
  const roleOf = (boardId, userId) => db.members.find(m => m.boardId === boardId && m.userId === userId)?.role;
  const getBoard = (id) => db.boards.find(b => b.id === id) || (() => { throw notFound('board not found'); })();
  const access = (boardId, user, need) => {
    const role = roleOf(boardId, user.id);
    if (!role) throw forbidden();
    if (need === 'owner' && role !== 'owner') throw forbidden();
    if (need === 'editor' && role === 'viewer') throw forbidden();
    return role;
  };
  const boardCtx = (id, user, need) => { const b = getBoard(id); access(b.id, user, need); return b; };
  const colCtx = (id, user, need) => { const c = db.columns.find(x => x.id === id); if (!c) throw notFound('column not found'); access(c.boardId, user, need); return c; };
  const cardCtx = (id, user, need) => { const c = db.cards.find(x => x.id === id); if (!c) throw notFound('card not found'); access(c.boardId, user, need); return c; };
  const colCards = (colId) => db.cards.filter(c => c.columnId === colId).sort((a, b) => a.position - b.position);
  const boardCols = (bid) => db.columns.filter(c => c.boardId === bid).sort((a, b) => a.position - b.position);
  const compactCol = (colId) => colCards(colId).forEach((c, i) => { c.position = i; });
  const compactBoard = (bid) => boardCols(bid).forEach((c, i) => { c.position = i; });
  const clampPos = (p, n) => Math.max(0, Math.min(n, p));
  const optPos = (p) => { if (p === undefined || p === null) return undefined; if (!Number.isInteger(p)) throw bad('position must be integer'); return p; };

  const hashPw = (pw) => { const salt = crypto.randomBytes(16).toString('hex'); return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex'); };
  const checkPw = (pw, stored) => {
    const [salt, h] = stored.split(':');
    const a = Buffer.from(h, 'hex'), b = crypto.scryptSync(pw, salt, 64);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  const fullBoard = (b) => ({
    id: b.id, name: b.name, description: b.description, ownerId: b.ownerId, createdAt: b.createdAt,
    members: db.members.filter(m => m.boardId === b.id).map(m => ({ userId: m.userId, username: db.users.find(u => u.id === m.userId)?.username, role: m.role })),
    labels: db.labels.filter(l => l.boardId === b.id),
    columns: boardCols(b.id).map(c => ({ id: c.id, name: c.name, position: c.position, wipLimit: c.wipLimit, cards: colCards(c.id) })),
  });

  const validWip = (w) => { if (w === null) return null; if (!Number.isInteger(w) || w < 1) throw bad('wipLimit must be positive integer or null'); return w; };
  const checkAssLabels = (boardId, assignees, labels) => {
    if (assignees !== undefined) {
      if (!Array.isArray(assignees) || assignees.some(a => typeof a !== 'string' || !roleOf(boardId, a))) throw bad('invalid assignees');
    }
    if (labels !== undefined) {
      if (!Array.isArray(labels) || labels.some(l => !db.labels.some(x => x.id === l && x.boardId === boardId))) throw bad('invalid labels');
    }
  };

  // routes: [method, regex, handler(ctx)]
  const routes = [];
  const R = (method, path, auth, fn) => routes.push({ method, re: new RegExp('^' + path.replace(/:\w+/g, '([^/]+)') + '$'), auth, fn });

  R('POST', '/api/auth/register', false, ({ body }) => {
    const { username, password } = body;
    if (typeof username !== 'string' || !/^[A-Za-z0-9_]{3,32}$/.test(username)) throw bad('invalid username');
    if (typeof password !== 'string' || password.length < 8) throw bad('password too short');
    let displayName = body.displayName ?? username;
    if (!isStr(displayName, 1, 100)) throw bad('invalid displayName');
    const un = username.toLowerCase();
    if (db.users.some(u => u.username === un)) throw new HttpError(409, 'conflict', 'username taken');
    const u = { id: uid(), username: un, displayName, passwordHash: hashPw(password) };
    db.users.push(u); save();
    return [201, { user: pubUser(u) }];
  });
  R('POST', '/api/auth/login', false, ({ body }) => {
    const { username, password } = body;
    if (typeof username !== 'string' || typeof password !== 'string') throw new HttpError(401, 'unauthorized', 'bad credentials');
    const un = username.toLowerCase();
    const t = Date.now();
    const f = (fails.get(un) || []).filter(x => t - x < 15 * 60 * 1000);
    fails.set(un, f);
    if (f.length >= 5) throw new HttpError(429, 'rate_limited', 'too many attempts');
    const u = db.users.find(x => x.username === un);
    if (!u || !checkPw(password, u.passwordHash)) { f.push(t); throw new HttpError(401, 'unauthorized', 'bad credentials'); }
    fails.delete(un);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, u.id);
    return [200, { token, user: pubUser(u) }];
  });
  R('POST', '/api/auth/logout', true, ({ token }) => { sessions.delete(token); return [204]; });
  R('GET', '/api/auth/me', true, ({ user }) => [200, { user: pubUser(user) }]);

  R('POST', '/api/boards', true, ({ body, user }) => {
    if (!isStr(body.name, 1, 100)) throw bad('invalid name');
    if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') throw bad('invalid description');
    let cols = body.columns ?? ['To Do', 'In Progress', 'Done'];
    if (!Array.isArray(cols) || cols.some(c => !isStr(c, 1, 100))) throw bad('invalid columns');
    const b = { id: uid(), name: body.name, description: body.description || '', ownerId: user.id, createdAt: now() };
    db.boards.push(b);
    db.members.push({ boardId: b.id, userId: user.id, role: 'owner' });
    log(b.id, 'board.created', user.id, null, { name: b.name });
    cols.forEach((n, i) => {
      const c = { id: uid(), boardId: b.id, name: n, position: i, wipLimit: null };
      db.columns.push(c); log(b.id, 'column.created', user.id, null, { columnId: c.id, name: n });
    });
    save();
    return [201, fullBoard(b)];
  });
  R('GET', '/api/boards', true, ({ user }) => [200, db.members.filter(m => m.userId === user.id).map(m => {
    const b = db.boards.find(x => x.id === m.boardId); return { id: b.id, name: b.name, role: m.role };
  })]);
  R('GET', '/api/boards/:id', true, ({ user, params }) => [200, fullBoard(boardCtx(params[0], user))]);
  R('PATCH', '/api/boards/:id', true, ({ user, params, body }) => {
    const b = boardCtx(params[0], user, 'owner');
    if (body.name !== undefined && !isStr(body.name, 1, 100)) throw bad('invalid name');
    if (body.description !== undefined && typeof body.description !== 'string') throw bad('invalid description');
    if (body.name !== undefined) b.name = body.name;
    if (body.description !== undefined) b.description = body.description;
    save(); return [200, fullBoard(b)];
  });
  R('DELETE', '/api/boards/:id', true, ({ user, params }) => {
    const b = boardCtx(params[0], user, 'owner');
    const id = b.id;
    const cardIds = new Set(db.cards.filter(c => c.boardId === id).map(c => c.id));
    db.boards = db.boards.filter(x => x.id !== id);
    db.members = db.members.filter(x => x.boardId !== id);
    db.columns = db.columns.filter(x => x.boardId !== id);
    db.cards = db.cards.filter(x => x.boardId !== id);
    db.labels = db.labels.filter(x => x.boardId !== id);
    db.comments = db.comments.filter(x => !cardIds.has(x.cardId));
    db.activity = db.activity.filter(x => x.boardId !== id);
    save(); return [204];
  });

  R('POST', '/api/boards/:id/members', true, ({ user, params, body }) => {
    const b = boardCtx(params[0], user, 'owner');
    if (!['editor', 'viewer'].includes(body.role)) throw bad('invalid role');
    if (typeof body.username !== 'string') throw bad('invalid username');
    const u = db.users.find(x => x.username === body.username.toLowerCase());
    if (!u) throw notFound('user not found');
    if (roleOf(b.id, u.id)) throw new HttpError(409, 'conflict', 'already a member');
    db.members.push({ boardId: b.id, userId: u.id, role: body.role });
    log(b.id, 'member.added', user.id, null, { userId: u.id, role: body.role });
    save(); return [201, { userId: u.id, username: u.username, role: body.role }];
  });
  R('PATCH', '/api/boards/:id/members/:uid', true, ({ user, params, body }) => {
    const b = boardCtx(params[0], user, 'owner');
    const m = db.members.find(x => x.boardId === b.id && x.userId === params[1]);
    if (!m) throw notFound('member not found');
    if (!['editor', 'viewer'].includes(body.role)) throw bad('invalid role');
    if (m.role === 'owner') throw bad('cannot change owner role');
    m.role = body.role; save();
    const u = db.users.find(x => x.id === m.userId);
    return [200, { userId: m.userId, username: u?.username, role: m.role }];
  });
  R('DELETE', '/api/boards/:id/members/:uid', true, ({ user, params }) => {
    const b = getBoard(params[0]);
    const role = roleOf(b.id, user.id);
    if (!role) throw forbidden();
    if (role !== 'owner' && user.id !== params[1]) throw forbidden();
    const m = db.members.find(x => x.boardId === b.id && x.userId === params[1]);
    if (!m) throw notFound('member not found');
    if (m.role === 'owner') throw bad('cannot remove owner');
    db.members = db.members.filter(x => x !== m);
    db.cards.forEach(c => { if (c.boardId === b.id) c.assignees = c.assignees.filter(a => a !== m.userId); });
    save(); return [204];
  });

  R('POST', '/api/boards/:id/columns', true, ({ user, params, body }) => {
    const b = boardCtx(params[0], user, 'editor');
    if (!isStr(body.name, 1, 100)) throw bad('invalid name');
    const wip = body.wipLimit === undefined ? null : validWip(body.wipLimit);
    const c = { id: uid(), boardId: b.id, name: body.name, position: boardCols(b.id).length, wipLimit: wip };
    db.columns.push(c); log(b.id, 'column.created', user.id, null, { columnId: c.id, name: c.name });
    save(); return [201, { ...c }];
  });
  R('PATCH', '/api/columns/:id', true, ({ user, params, body }) => {
    const c = colCtx(params[0], user, 'editor');
    if (body.name !== undefined && !isStr(body.name, 1, 100)) throw bad('invalid name');
    const wip = body.wipLimit === undefined ? undefined : validWip(body.wipLimit);
    const pos = optPos(body.position);
    if (body.name !== undefined) c.name = body.name;
    if (wip !== undefined) c.wipLimit = wip;
    if (pos !== undefined) {
      const cols = boardCols(c.boardId).filter(x => x !== c);
      cols.splice(clampPos(pos, cols.length), 0, c);
      cols.forEach((x, i) => { x.position = i; });
    }
    save(); return [200, { ...c }];
  });
  R('DELETE', '/api/columns/:id', true, ({ user, params, query }) => {
    const c = colCtx(params[0], user, 'editor');
    const cards = colCards(c.id);
    if (cards.length && query.get('force') !== 'true') throw new HttpError(409, 'conflict', 'column not empty');
    const ids = new Set(cards.map(x => x.id));
    db.cards = db.cards.filter(x => !ids.has(x.id));
    db.comments = db.comments.filter(x => !ids.has(x.cardId));
    db.columns = db.columns.filter(x => x !== c);
    compactBoard(c.boardId); save(); return [204];
  });

  const cardInput = (b, body, partial) => {
    if (!partial || body.title !== undefined) if (!isStr(body.title, 1, 200)) throw bad('invalid title');
    if (body.description !== undefined && typeof body.description !== 'string') throw bad('invalid description');
    if (body.dueDate !== undefined && body.dueDate !== null && !isDate(body.dueDate)) throw bad('invalid dueDate');
    checkAssLabels(b, body.assignees, body.labels);
  };
  R('POST', '/api/columns/:id/cards', true, ({ user, params, body }) => {
    const col = colCtx(params[0], user, 'editor');
    cardInput(col.boardId, body, false);
    const pos = optPos(body.position);
    const list = colCards(col.id);
    if (col.wipLimit && list.length >= col.wipLimit) throw new HttpError(409, 'wip_limit', 'WIP limit reached');
    const t = now();
    const card = { id: uid(), boardId: col.boardId, columnId: col.id, title: body.title, description: body.description ?? '', position: 0,
      assignees: [...new Set(body.assignees || [])], labels: [...new Set(body.labels || [])], dueDate: body.dueDate ?? null, createdBy: user.id, createdAt: t, updatedAt: t };
    list.splice(pos === undefined ? list.length : clampPos(pos, list.length), 0, card);
    db.cards.push(card);
    list.forEach((c, i) => { c.position = i; });
    log(col.boardId, 'card.created', user.id, card.id, { columnId: col.id, title: card.title });
    save(); return [201, card];
  });
  R('GET', '/api/cards/:id', true, ({ user, params }) => [200, cardCtx(params[0], user)]);
  R('PATCH', '/api/cards/:id', true, ({ user, params, body }) => {
    const c = cardCtx(params[0], user, 'editor');
    cardInput(c.boardId, body, true);
    for (const k of ['title', 'description', 'dueDate']) if (body[k] !== undefined) c[k] = body[k];
    if (body.assignees !== undefined) c.assignees = [...new Set(body.assignees)];
    if (body.labels !== undefined) c.labels = [...new Set(body.labels)];
    c.updatedAt = now();
    log(c.boardId, 'card.updated', user.id, c.id, { fields: Object.keys(body) });
    save(); return [200, c];
  });
  R('DELETE', '/api/cards/:id', true, ({ user, params }) => {
    const c = cardCtx(params[0], user, 'editor');
    db.cards = db.cards.filter(x => x !== c);
    db.comments = db.comments.filter(x => x.cardId !== c.id);
    compactCol(c.columnId);
    log(c.boardId, 'card.deleted', user.id, c.id, { columnId: c.columnId, title: c.title });
    save(); return [204];
  });
  R('POST', '/api/cards/:id/move', true, ({ user, params, body }) => {
    const c = cardCtx(params[0], user, 'editor');
    if (typeof body.columnId !== 'string') throw bad('columnId required');
    const target = db.columns.find(x => x.id === body.columnId);
    if (!target) throw notFound('column not found');
    if (target.boardId !== c.boardId) throw bad('column on a different board');
    const pos = optPos(body.position);
    const from = c.columnId;
    const same = from === target.id;
    if (!same && target.wipLimit && colCards(target.id).length >= target.wipLimit) throw new HttpError(409, 'wip_limit', 'WIP limit reached');
    const list = colCards(target.id).filter(x => x !== c);
    list.splice(pos === undefined ? list.length : clampPos(pos, list.length), 0, c);
    c.columnId = target.id;
    list.forEach((x, i) => { x.position = i; });
    if (!same) compactCol(from);
    c.updatedAt = now();
    log(c.boardId, 'card.moved', user.id, c.id, { fromColumnId: from, toColumnId: target.id, position: c.position });
    save(); return [200, c];
  });

  R('POST', '/api/boards/:id/labels', true, ({ user, params, body }) => {
    const b = boardCtx(params[0], user, 'editor');
    if (!isStr(body.name, 1, 50)) throw bad('invalid name');
    if (typeof body.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(body.color)) throw bad('invalid color');
    if (db.labels.some(l => l.boardId === b.id && l.name.toLowerCase() === body.name.toLowerCase())) throw new HttpError(409, 'conflict', 'label exists');
    const l = { id: uid(), boardId: b.id, name: body.name, color: body.color };
    db.labels.push(l); save(); return [201, l];
  });
  R('DELETE', '/api/labels/:id', true, ({ user, params }) => {
    const l = db.labels.find(x => x.id === params[0]);
    if (!l) throw notFound('label not found');
    access(l.boardId, user, 'editor');
    db.labels = db.labels.filter(x => x !== l);
    db.cards.forEach(c => { c.labels = c.labels.filter(x => x !== l.id); });
    save(); return [204];
  });

  R('POST', '/api/cards/:id/comments', true, ({ user, params, body }) => {
    const c = cardCtx(params[0], user, 'editor');
    if (!isStr(body.body, 1, 5000)) throw bad('invalid body');
    const m = { id: uid(), cardId: c.id, authorId: user.id, body: body.body, createdAt: now() };
    db.comments.push(m);
    log(c.boardId, 'comment.added', user.id, c.id, { commentId: m.id });
    save(); return [201, m];
  });
  R('GET', '/api/cards/:id/comments', true, ({ user, params }) => {
    const c = cardCtx(params[0], user);
    return [200, db.comments.filter(x => x.cardId === c.id)];
  });
  R('DELETE', '/api/comments/:id', true, ({ user, params }) => {
    const m = db.comments.find(x => x.id === params[0]);
    if (!m) throw notFound('comment not found');
    const card = db.cards.find(x => x.id === m.cardId);
    const role = roleOf(card.boardId, user.id);
    if (!role) throw forbidden();
    if (m.authorId !== user.id && role !== 'owner') throw forbidden();
    db.comments = db.comments.filter(x => x !== m); save(); return [204];
  });

  R('GET', '/api/boards/:id/cards', true, ({ user, params, query }) => {
    const b = boardCtx(params[0], user);
    const q = query.get('q')?.toLowerCase(), as = query.get('assignee'), lb = query.get('label'), col = query.get('column'), due = query.get('due_before');
    if (due && !isDate(due)) throw bad('invalid due_before');
    const pos = new Map(boardCols(b.id).map(c => [c.id, c.position]));
    const out = db.cards.filter(c => c.boardId === b.id
      && (!q || c.title.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
      && (!as || c.assignees.includes(as)) && (!lb || c.labels.includes(lb)) && (!col || c.columnId === col)
      && (!due || (c.dueDate && c.dueDate < due)));
    out.sort((a, b2) => pos.get(a.columnId) - pos.get(b2.columnId) || a.position - b2.position);
    return [200, out];
  });
  R('GET', '/api/boards/:id/activity', true, ({ user, params, query }) => {
    const b = boardCtx(params[0], user);
    let limit = 50;
    if (query.has('limit')) { limit = Number(query.get('limit')); if (!Number.isInteger(limit) || limit < 1) throw bad('invalid limit'); }
    return [200, db.activity.filter(a => a.boardId === b.id).reverse().slice(0, limit)];
  });

  const send = (res, status, body, headers = {}) => {
    if (body === undefined) { res.writeHead(status, headers); return res.end(); }
    const isStr = typeof body === 'string';
    res.writeHead(status, { 'content-type': isStr ? 'text/html; charset=utf-8' : 'application/json', ...headers });
    res.end(isStr ? body : JSON.stringify(body));
  };

  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      try {
        const url = new URL(req.url, 'http://x');
        const path = url.pathname;
        if (req.method === 'GET' && (path === '/' || path === '/index.html')) return send(res, 200, INDEX_HTML);
        if (!path.startsWith('/api/')) throw notFound('route not found');
        const route = routes.find(r => r.method === req.method && r.re.test(path));
        if (!route) throw notFound('route not found');
        let user, token;
        if (route.auth) {
          const h = req.headers.authorization || '';
          token = h.startsWith('Bearer ') ? h.slice(7) : null;
          const id = token && sessions.get(token);
          user = id && db.users.find(u => u.id === id);
          if (!user) throw new HttpError(401, 'unauthorized', 'authentication required');
        }
        let body = {};
        if (req.method !== 'GET' && req.method !== 'DELETE' || chunks.length) {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (raw.trim()) {
            try { body = JSON.parse(raw); } catch { throw bad('invalid JSON'); }
            if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('body must be an object');
          }
        }
        const params = path.match(route.re).slice(1).map(decodeURIComponent);
        const [status, out] = route.fn({ user, token, params, body, query: url.searchParams });
        send(res, status, out);
      } catch (e) {
        if (e instanceof HttpError) send(res, e.status, { error: e.code, message: e.message });
        else { console.error(e); send(res, 500, { error: 'internal', message: 'internal error' }); }
      }
    });
  });
}
