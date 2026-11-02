import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { HTML } from './ui.js';

class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const E = (s, c, m) => new HttpError(s, c, m || c);
const bad = m => E(400, 'validation', m);
const nid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const isStr = v => typeof v === 'string';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = v => isStr(v) && DATE_RE.test(v) && !isNaN(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;

const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 32, (e, k) => e ? rej(e) : res(k)));

export function createServer({ dataFile } = {}) {
  let db = { users: [], boards: [], columns: [], cards: [], labels: [], comments: [], activity: [] };
  if (dataFile && fs.existsSync(dataFile)) {
    try { db = { ...db, ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) }; } catch {}
  }
  const save = () => { if (dataFile) { const t = dataFile + '.tmp'; fs.writeFileSync(t, JSON.stringify(db)); fs.renameSync(t, dataFile); } };
  const sessions = new Map();
  const fails = new Map();

  const pubUser = u => ({ id: u.id, username: u.username, displayName: u.displayName });
  const log = (boardId, type, actorId, cardId, details = {}) => {
    const e = { id: nid(), boardId, type, actorId, at: now(), details };
    if (cardId) e.cardId = cardId;
    db.activity.push(e);
  };
  const colCards = colId => db.cards.filter(c => c.columnId === colId).sort((a, b) => a.position - b.position);
  const boardCols = bid => db.columns.filter(c => c.boardId === bid).sort((a, b) => a.position - b.position);
  const compact = list => list.forEach((c, i) => { c.position = i; });
  const clampPos = (p, n) => Math.max(0, Math.min(n, p));
  const checkPos = p => { if (!Number.isInteger(p)) throw bad('position must be an integer'); };

  function getBoard(id) { const b = db.boards.find(x => x.id === id); if (!b) throw E(404, 'not_found', 'board not found'); return b; }
  function roleOf(b, u) { const m = b.members.find(x => x.userId === u.id); return m ? m.role : null; }
  function access(b, u, need) { // need: 'read'|'write'|'owner'
    const r = roleOf(b, u);
    if (!r) throw E(403, 'forbidden', 'not a member');
    if (need === 'owner' && r !== 'owner') throw E(403, 'forbidden', 'owner only');
    if (need === 'write' && r === 'viewer') throw E(403, 'forbidden', 'read only');
    return r;
  }
  function getCol(id) { const c = db.columns.find(x => x.id === id); if (!c) throw E(404, 'not_found', 'column not found'); return c; }
  function getCard(id) { const c = db.cards.find(x => x.id === id); if (!c) throw E(404, 'not_found', 'card not found'); return c; }
  const boardOut = b => ({
    id: b.id, name: b.name, description: b.description, ownerId: b.ownerId, createdAt: b.createdAt,
    members: b.members.map(m => ({ userId: m.userId, username: db.users.find(u => u.id === m.userId)?.username, role: m.role })),
    labels: db.labels.filter(l => l.boardId === b.id),
    columns: boardCols(b.id).map(c => ({ id: c.id, name: c.name, position: c.position, wipLimit: c.wipLimit, cards: colCards(c.id) })),
  });
  const colOut = c => ({ id: c.id, boardId: c.boardId, name: c.name, position: c.position, wipLimit: c.wipLimit });

  function checkWip(col, excludeCardId) {
    if (col.wipLimit != null && colCards(col.id).filter(c => c.id !== excludeCardId).length >= col.wipLimit)
      throw E(409, 'wip_limit', 'column WIP limit reached');
  }
  function checkAssignees(b, a) {
    if (!Array.isArray(a) || !a.every(x => isStr(x) && b.members.some(m => m.userId === x))) throw bad('assignees must be board members');
    return [...new Set(a)];
  }
  function checkLabels(b, l) {
    if (!Array.isArray(l) || !l.every(x => isStr(x) && db.labels.some(y => y.id === x && y.boardId === b.id))) throw bad('invalid labels');
    return [...new Set(l)];
  }
  const checkDue = d => { if (d !== null && !validDate(d)) throw bad('dueDate must be YYYY-MM-DD or null'); };
  const checkWipLimit = w => { if (w !== null && !(Number.isInteger(w) && w > 0)) throw bad('wipLimit must be positive integer or null'); };
  const checkName = (n, max, what = 'name') => { if (!isStr(n) || n.trim().length < 1 || n.length > max) throw bad(`${what} must be 1-${max} chars`); };

  // routes: [method, regex, handler(ctx)]
  const routes = [];
  const R = (m, p, h, open) => routes.push([m, new RegExp('^' + p.replace(/:\w+/g, '([^/]+)') + '$'), h, open]);

  R('POST', '/api/auth/register', async ({ body }) => {
    const { username, password, displayName } = body;
    if (!isStr(username) || !/^[a-zA-Z0-9_]{3,32}$/.test(username)) throw bad('invalid username');
    if (!isStr(password) || password.length < 8) throw bad('password must be at least 8 chars');
    if (displayName !== undefined && (!isStr(displayName) || !displayName.trim() || displayName.length > 100)) throw bad('invalid displayName');
    const uname = username.toLowerCase();
    if (db.users.some(u => u.username === uname)) throw E(409, 'conflict', 'username taken');
    const salt = crypto.randomBytes(16);
    const hash = await scrypt(password, salt);
    if (db.users.some(u => u.username === uname)) throw E(409, 'conflict', 'username taken');
    const u = { id: nid(), username: uname, displayName: displayName ?? uname, salt: salt.toString('hex'), hash: hash.toString('hex') };
    db.users.push(u); save();
    return [201, { user: pubUser(u) }];
  }, true);
  R('POST', '/api/auth/login', async ({ body }) => {
    const { username, password } = body;
    if (!isStr(username) || !isStr(password)) throw bad('username and password required');
    const uname = username.toLowerCase();
    const cut = Date.now() - 15 * 60 * 1000;
    const f = (fails.get(uname) || []).filter(t => t > cut);
    fails.set(uname, f);
    if (f.length >= 5) throw E(429, 'rate_limited', 'too many failed attempts');
    const u = db.users.find(x => x.username === uname);
    let ok = false;
    if (u) {
      const h = await scrypt(password, Buffer.from(u.salt, 'hex'));
      ok = crypto.timingSafeEqual(h, Buffer.from(u.hash, 'hex'));
    }
    if (!ok) { f.push(Date.now()); throw E(401, 'unauthorized', 'invalid credentials'); }
    fails.delete(uname);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, u.id);
    return [200, { token, user: pubUser(u) }];
  }, true);
  R('POST', '/api/auth/logout', ({ token }) => { sessions.delete(token); return [204]; });
  R('GET', '/api/auth/me', ({ user }) => [200, { user: pubUser(user) }]);

  R('POST', '/api/boards', ({ body, user }) => {
    checkName(body.name, 100);
    if (body.description !== undefined && !isStr(body.description)) throw bad('description must be string');
    const names = body.columns ?? ['To Do', 'In Progress', 'Done'];
    if (!Array.isArray(names)) throw bad('columns must be array');
    names.forEach(n => checkName(n, 100, 'column name'));
    const b = { id: nid(), name: body.name, description: body.description ?? '', ownerId: user.id, createdAt: now(), members: [{ userId: user.id, role: 'owner' }] };
    db.boards.push(b);
    names.forEach((n, i) => db.columns.push({ id: nid(), boardId: b.id, name: n, position: i, wipLimit: null }));
    log(b.id, 'board.created', user.id, null, { name: b.name });
    save();
    return [201, boardOut(b)];
  });
  R('GET', '/api/boards', ({ user }) => [200, db.boards.filter(b => roleOf(b, user)).map(b => ({ id: b.id, name: b.name, role: roleOf(b, user) }))]);
  R('GET', '/api/boards/:id', ({ p, user }) => { const b = getBoard(p[0]); access(b, user, 'read'); return [200, boardOut(b)]; });
  R('PATCH', '/api/boards/:id', ({ p, user, body }) => {
    const b = getBoard(p[0]); access(b, user, 'owner');
    if (body.name !== undefined) checkName(body.name, 100);
    if (body.description !== undefined && !isStr(body.description)) throw bad('description must be string');
    if (body.name !== undefined) b.name = body.name;
    if (body.description !== undefined) b.description = body.description;
    save(); return [200, boardOut(b)];
  });
  R('DELETE', '/api/boards/:id', ({ p, user }) => {
    const b = getBoard(p[0]); access(b, user, 'owner');
    const cardIds = new Set(db.cards.filter(c => c.boardId === b.id).map(c => c.id));
    db.boards = db.boards.filter(x => x !== b);
    db.columns = db.columns.filter(c => c.boardId !== b.id);
    db.cards = db.cards.filter(c => c.boardId !== b.id);
    db.labels = db.labels.filter(l => l.boardId !== b.id);
    db.comments = db.comments.filter(c => !cardIds.has(c.cardId));
    db.activity = db.activity.filter(a => a.boardId !== b.id);
    save(); return [204];
  });
  R('POST', '/api/boards/:id/members', ({ p, user, body }) => {
    const b = getBoard(p[0]); access(b, user, 'owner');
    if (!isStr(body.username)) throw bad('username required');
    if (!['editor', 'viewer'].includes(body.role)) throw bad('role must be editor or viewer');
    const t = db.users.find(u => u.username === body.username.toLowerCase());
    if (!t) throw E(404, 'not_found', 'user not found');
    if (roleOf(b, t)) throw E(409, 'conflict', 'already a member');
    b.members.push({ userId: t.id, role: body.role });
    log(b.id, 'member.added', user.id, null, { userId: t.id, role: body.role });
    save(); return [201, { userId: t.id, username: t.username, role: body.role }];
  });
  R('PATCH', '/api/boards/:id/members/:uid', ({ p, user, body }) => {
    const b = getBoard(p[0]); access(b, user, 'owner');
    if (!['editor', 'viewer'].includes(body.role)) throw bad('role must be editor or viewer');
    const m = b.members.find(x => x.userId === p[1]);
    if (!m) throw E(404, 'not_found', 'member not found');
    if (m.role === 'owner') throw bad('cannot change owner role');
    m.role = body.role; save();
    return [200, { userId: m.userId, username: db.users.find(u => u.id === m.userId)?.username, role: m.role }];
  });
  R('DELETE', '/api/boards/:id/members/:uid', ({ p, user }) => {
    const b = getBoard(p[0]);
    const r = access(b, user, 'read');
    if (p[1] !== user.id && r !== 'owner') throw E(403, 'forbidden', 'owner only');
    const m = b.members.find(x => x.userId === p[1]);
    if (!m) throw E(404, 'not_found', 'member not found');
    if (m.role === 'owner') throw bad('cannot remove owner');
    b.members = b.members.filter(x => x !== m);
    db.cards.filter(c => c.boardId === b.id).forEach(c => { c.assignees = c.assignees.filter(a => a !== m.userId); });
    save(); return [204];
  });

  R('POST', '/api/boards/:id/columns', ({ p, user, body }) => {
    const b = getBoard(p[0]); access(b, user, 'write');
    checkName(body.name, 100);
    const w = body.wipLimit ?? null; checkWipLimit(w);
    const c = { id: nid(), boardId: b.id, name: body.name, position: boardCols(b.id).length, wipLimit: w };
    db.columns.push(c);
    log(b.id, 'column.created', user.id, null, { columnId: c.id, name: c.name });
    save(); return [201, colOut(c)];
  });
  R('PATCH', '/api/columns/:id', ({ p, user, body, query }) => {
    const c = getCol(p[0]); const b = getBoard(c.boardId); access(b, user, 'write');
    if (body.name !== undefined) checkName(body.name, 100);
    if (body.wipLimit !== undefined) checkWipLimit(body.wipLimit);
    if (body.position !== undefined) checkPos(body.position);
    if (body.name !== undefined) c.name = body.name;
    if (body.wipLimit !== undefined) c.wipLimit = body.wipLimit;
    if (body.position !== undefined) {
      const list = boardCols(b.id).filter(x => x !== c);
      list.splice(clampPos(body.position, list.length), 0, c);
      compact(list);
    }
    save(); return [200, colOut(c)];
  });
  R('DELETE', '/api/columns/:id', ({ p, user, query }) => {
    const c = getCol(p[0]); const b = getBoard(c.boardId); access(b, user, 'write');
    const cards = colCards(c.id);
    if (cards.length && query.get('force') !== 'true') throw E(409, 'conflict', 'column has cards');
    const ids = new Set(cards.map(x => x.id));
    db.cards = db.cards.filter(x => x.columnId !== c.id);
    db.comments = db.comments.filter(x => !ids.has(x.cardId));
    db.columns = db.columns.filter(x => x !== c);
    compact(boardCols(b.id));
    save(); return [204];
  });

  R('POST', '/api/columns/:id/cards', ({ p, user, body }) => {
    const col = getCol(p[0]); const b = getBoard(col.boardId); access(b, user, 'write');
    checkName(body.title, 200, 'title');
    if (body.description !== undefined && !isStr(body.description)) throw bad('description must be string');
    const assignees = body.assignees === undefined ? [] : checkAssignees(b, body.assignees);
    const labels = body.labels === undefined ? [] : checkLabels(b, body.labels);
    const due = body.dueDate ?? null; checkDue(due);
    if (body.position !== undefined && body.position !== null) checkPos(body.position);
    checkWip(col);
    const list = colCards(col.id);
    const t = now();
    const card = { id: nid(), boardId: b.id, columnId: col.id, title: body.title, description: body.description ?? '', position: 0, assignees, labels, dueDate: due, createdBy: user.id, createdAt: t, updatedAt: t };
    const pos = body.position == null ? list.length : clampPos(body.position, list.length);
    list.splice(pos, 0, card); compact(list);
    db.cards.push(card);
    log(b.id, 'card.created', user.id, card.id, { title: card.title, columnId: col.id });
    save(); return [201, card];
  });
  R('GET', '/api/cards/:id', ({ p, user }) => { const c = getCard(p[0]); access(getBoard(c.boardId), user, 'read'); return [200, c]; });
  R('PATCH', '/api/cards/:id', ({ p, user, body }) => {
    const c = getCard(p[0]); const b = getBoard(c.boardId); access(b, user, 'write');
    if (body.title !== undefined) checkName(body.title, 200, 'title');
    if (body.description !== undefined && !isStr(body.description)) throw bad('description must be string');
    const a = body.assignees === undefined ? undefined : checkAssignees(b, body.assignees);
    const l = body.labels === undefined ? undefined : checkLabels(b, body.labels);
    if (body.dueDate !== undefined) checkDue(body.dueDate);
    const changed = [];
    for (const [k, v] of [['title', body.title], ['description', body.description], ['assignees', a], ['labels', l], ['dueDate', body.dueDate]])
      if (v !== undefined) { c[k] = v; changed.push(k); }
    c.updatedAt = now();
    log(b.id, 'card.updated', user.id, c.id, { fields: changed });
    save(); return [200, c];
  });
  R('DELETE', '/api/cards/:id', ({ p, user }) => {
    const c = getCard(p[0]); const b = getBoard(c.boardId); access(b, user, 'write');
    db.cards = db.cards.filter(x => x !== c);
    db.comments = db.comments.filter(x => x.cardId !== c.id);
    compact(colCards(c.columnId));
    log(b.id, 'card.deleted', user.id, c.id, { title: c.title, columnId: c.columnId });
    save(); return [204];
  });
  R('POST', '/api/cards/:id/move', ({ p, user, body }) => {
    const c = getCard(p[0]); const b = getBoard(c.boardId); access(b, user, 'write');
    if (!isStr(body.columnId)) throw bad('columnId required');
    const target = db.columns.find(x => x.id === body.columnId);
    if (!target || target.boardId !== c.boardId) throw bad('target column must be on the same board');
    if (body.position !== undefined && body.position !== null) checkPos(body.position);
    const from = c.columnId;
    if (from !== target.id) checkWip(target);
    const src = colCards(from).filter(x => x !== c);
    const dst = from === target.id ? src : colCards(target.id);
    const pos = body.position == null ? dst.length : clampPos(body.position, dst.length);
    dst.splice(pos, 0, c);
    c.columnId = target.id;
    compact(dst); if (dst !== src) compact(src);
    c.updatedAt = now();
    log(b.id, 'card.moved', user.id, c.id, { fromColumnId: from, toColumnId: target.id, position: c.position });
    save(); return [200, c];
  });

  R('POST', '/api/boards/:id/labels', ({ p, user, body }) => {
    const b = getBoard(p[0]); access(b, user, 'write');
    checkName(body.name, 50);
    if (!isStr(body.color) || !/^#[0-9a-fA-F]{6}$/.test(body.color)) throw bad('color must be #rrggbb');
    if (db.labels.some(l => l.boardId === b.id && l.name.toLowerCase() === body.name.toLowerCase())) throw E(409, 'conflict', 'label exists');
    const l = { id: nid(), boardId: b.id, name: body.name, color: body.color };
    db.labels.push(l); save(); return [201, l];
  });
  R('DELETE', '/api/labels/:id', ({ p, user }) => {
    const l = db.labels.find(x => x.id === p[0]); if (!l) throw E(404, 'not_found', 'label not found');
    access(getBoard(l.boardId), user, 'write');
    db.labels = db.labels.filter(x => x !== l);
    db.cards.forEach(c => { c.labels = c.labels.filter(x => x !== l.id); });
    save(); return [204];
  });

  R('POST', '/api/cards/:id/comments', ({ p, user, body }) => {
    const c = getCard(p[0]); const b = getBoard(c.boardId); access(b, user, 'write');
    if (!isStr(body.body) || body.body.length < 1 || body.body.length > 5000) throw bad('body must be 1-5000 chars');
    const m = { id: nid(), cardId: c.id, authorId: user.id, body: body.body, createdAt: now() };
    db.comments.push(m);
    log(b.id, 'comment.added', user.id, c.id, { commentId: m.id });
    save(); return [201, m];
  });
  R('GET', '/api/cards/:id/comments', ({ p, user }) => {
    const c = getCard(p[0]); access(getBoard(c.boardId), user, 'read');
    return [200, db.comments.filter(x => x.cardId === c.id)];
  });
  R('DELETE', '/api/comments/:id', ({ p, user }) => {
    const m = db.comments.find(x => x.id === p[0]); if (!m) throw E(404, 'not_found', 'comment not found');
    const b = getBoard(getCard(m.cardId).boardId);
    const r = access(b, user, 'read');
    if (m.authorId !== user.id && r !== 'owner') throw E(403, 'forbidden', 'not allowed');
    db.comments = db.comments.filter(x => x !== m); save(); return [204];
  });

  R('GET', '/api/boards/:id/cards', ({ p, user, query }) => {
    const b = getBoard(p[0]); access(b, user, 'read');
    const q = query.get('q'), as = query.get('assignee'), lb = query.get('label'), co = query.get('column'), db_ = query.get('due_before');
    if (db_ && !validDate(db_)) throw bad('due_before must be YYYY-MM-DD');
    const cols = new Map(boardCols(b.id).map(c => [c.id, c.position]));
    const out = db.cards.filter(c => c.boardId === b.id &&
      (!q || (c.title + '\n' + c.description).toLowerCase().includes(q.toLowerCase())) &&
      (!as || c.assignees.includes(as)) && (!lb || c.labels.includes(lb)) && (!co || c.columnId === co) &&
      (!db_ || (c.dueDate && c.dueDate < db_)));
    out.sort((x, y) => (cols.get(x.columnId) - cols.get(y.columnId)) || (x.position - y.position));
    return [200, out];
  });
  R('GET', '/api/boards/:id/activity', ({ p, user, query }) => {
    const b = getBoard(p[0]); access(b, user, 'read');
    let limit = 50;
    if (query.get('limit') !== null) { limit = Number(query.get('limit')); if (!Number.isInteger(limit) || limit < 1) throw bad('invalid limit'); }
    return [200, db.activity.filter(a => a.boardId === b.id).reverse().slice(0, limit)];
  });

  const send = (res, status, body, type = 'application/json') => {
    const data = body === undefined ? '' : (type === 'application/json' ? JSON.stringify(body) : body);
    res.writeHead(status, { 'content-type': type + (type === 'application/json' ? '' : '; charset=utf-8'), 'content-length': Buffer.byteLength(data) });
    res.end(status === 204 ? undefined : data);
  };

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const path = url.pathname;
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) return send(res, 200, HTML, 'text/html');
      if (!path.startsWith('/api/')) throw E(404, 'not_found', 'not found');
      const chunks = []; for await (const ch of req) chunks.push(ch);
      const raw = Buffer.concat(chunks).toString('utf8');
      let match = null, pathMatched = false;
      for (const r of routes) { const m = r[1].exec(path); if (m) { pathMatched = true; if (r[0] === req.method) { match = [r, m]; break; } } }
      if (!match) throw pathMatched ? E(404, 'not_found', 'method not found') : E(404, 'not_found', 'not found');
      const [[, , handler, open], m] = match;
      let user = null, token = null;
      if (!open) {
        const h = req.headers.authorization || '';
        token = h.startsWith('Bearer ') ? h.slice(7).trim() : null;
        const uid = token && sessions.get(token);
        user = uid && db.users.find(u => u.id === uid);
        if (!user) throw E(401, 'unauthorized', 'authentication required');
      }
      let body = {};
      if (['POST', 'PATCH', 'PUT'].includes(req.method) && raw.trim()) {
        try { body = JSON.parse(raw); } catch { throw bad('invalid JSON'); }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('body must be an object');
      }
      const [status, out] = await handler({ p: m.slice(1).map(decodeURIComponent), user, token, body, query: url.searchParams });
      send(res, status, out);
    } catch (e) {
      if (e instanceof HttpError) send(res, e.status, { error: e.code, message: e.message });
      else { console.error(e); send(res, 500, { error: 'internal', message: 'internal error' }); }
    }
  });
}
