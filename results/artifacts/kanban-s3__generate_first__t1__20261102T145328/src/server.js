import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { INDEX_HTML } from './ui.js';

class HttpError extends Error {
  constructor(status, error, message) { super(message || error); this.status = status; this.code = error; }
}
const E = (s, c, m) => new HttpError(s, c, m);
const bad = (m) => E(400, 'validation', m);
const forbidden = (m = 'forbidden') => E(403, 'forbidden', m);
const notFound = (m = 'not found') => E(404, 'not_found', m);

const COLL = ['users', 'boards', 'members', 'columns', 'cards', 'labels', 'comments', 'activity'];
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';
const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function validDate(s) {
  if (!isStr(s) || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

export function createServer({ dataFile } = {}) {
  let db = {};
  for (const c of COLL) db[c] = [];
  if (dataFile && fs.existsSync(dataFile)) {
    try { const d = JSON.parse(fs.readFileSync(dataFile, 'utf8')); for (const c of COLL) if (Array.isArray(d[c])) db[c] = d[c]; } catch {}
  }
  const save = () => {
    if (!dataFile) return;
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, dataFile);
  };
  const sessions = new Map(); // token -> userId
  const failures = new Map(); // username -> [timestamps]

  const find = (coll, id) => db[coll].find((x) => x.id === id);
  const pubUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName });

  function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
    return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
  }
  function checkPw(u, pw) {
    const h = crypto.scryptSync(pw, u.salt, 64);
    const exp = Buffer.from(u.hash, 'hex');
    return h.length === exp.length && crypto.timingSafeEqual(h, exp);
  }

  function log(boardId, type, actorId, cardId, details = {}) {
    const e = { id: uid(), boardId, type, actorId, at: now(), details };
    if (cardId) e.cardId = cardId;
    db.activity.push(e);
  }

  // ---- access helpers
  const roleOf = (boardId, userId) => db.members.find((m) => m.boardId === boardId && m.userId === userId)?.role;
  function access(user, board, need) { // need: 'viewer' | 'editor' | 'owner'
    const r = roleOf(board.id, user.id);
    if (!r) throw forbidden('not a member of this board');
    const rank = { viewer: 1, editor: 2, owner: 3 };
    if (rank[r] < rank[need]) throw forbidden('insufficient role');
    return r;
  }
  function getBoard(id) { const b = find('boards', id); if (!b) throw notFound('board not found'); return b; }
  function getColumn(id) { const c = find('columns', id); if (!c) throw notFound('column not found'); return c; }
  function getCard(id) { const c = find('cards', id); if (!c) throw notFound('card not found'); return c; }

  const colCards = (colId) => db.cards.filter((c) => c.columnId === colId).sort((a, b) => a.position - b.position);
  const boardCols = (bid) => db.columns.filter((c) => c.boardId === bid).sort((a, b) => a.position - b.position);
  const renumber = (arr) => arr.forEach((x, i) => { x.position = i; });
  const clampPos = (p, n) => Math.max(0, Math.min(n, p));
  function checkPos(p) { if (!Number.isInteger(p) || p < 0) throw bad('position must be a non-negative integer'); }

  function validateAssignees(board, a) {
    if (!Array.isArray(a) || !a.every(isStr)) throw bad('assignees must be an array of user ids');
    for (const u of a) if (!roleOf(board.id, u)) throw bad('assignee is not a board member');
    return [...new Set(a)];
  }
  function validateLabels(board, l) {
    if (!Array.isArray(l) || !l.every(isStr)) throw bad('labels must be an array of label ids');
    for (const x of l) { const lb = find('labels', x); if (!lb || lb.boardId !== board.id) throw bad('label does not belong to board'); }
    return [...new Set(l)];
  }

  function boardView(b) {
    return {
      id: b.id, name: b.name, description: b.description, ownerId: b.ownerId, createdAt: b.createdAt,
      members: db.members.filter((m) => m.boardId === b.id).map((m) => ({ userId: m.userId, username: find('users', m.userId)?.username, role: m.role })),
      labels: db.labels.filter((l) => l.boardId === b.id),
      columns: boardCols(b.id).map((c) => ({ id: c.id, name: c.name, position: c.position, wipLimit: c.wipLimit, cards: colCards(c.id) })),
    };
  }
  const colView = (c) => ({ id: c.id, boardId: c.boardId, name: c.name, position: c.position, wipLimit: c.wipLimit });

  function checkWip(col, extra = 0) {
    if (col.wipLimit != null && colCards(col.id).length + extra >= col.wipLimit) throw E(409, 'wip_limit', 'column WIP limit reached');
  }
  function validWip(v) { if (v !== null && !(Number.isInteger(v) && v > 0)) throw bad('wipLimit must be a positive integer or null'); }
  function validName(v, max, what = 'name') { if (!isStr(v) || v.trim().length < 1 || v.length > max) throw bad(`${what} must be 1-${max} characters`); }

  function deleteCardsOf(pred) {
    const ids = new Set(db.cards.filter(pred).map((c) => c.id));
    db.cards = db.cards.filter((c) => !ids.has(c.id));
    db.comments = db.comments.filter((c) => !ids.has(c.cardId));
  }

  // ---- routes
  const routes = [];
  const route = (method, path, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, public: !!opts.public });
  };

  route('POST', '/api/auth/register', ({ body }) => {
    let { username, password, displayName } = body;
    if (!isStr(username)) throw bad('username required');
    username = username.toLowerCase();
    if (!/^[a-z0-9_]{3,32}$/.test(username)) throw bad('username must be 3-32 chars of [a-z0-9_]');
    if (!isStr(password) || password.length < 8) throw bad('password must be at least 8 characters');
    if (displayName != null && (!isStr(displayName) || !displayName.trim() || displayName.length > 100)) throw bad('invalid displayName');
    if (db.users.some((u) => u.username === username)) throw E(409, 'conflict', 'username taken');
    const u = { id: uid(), username, displayName: displayName ?? username, ...hashPw(password), createdAt: now() };
    db.users.push(u); save();
    return [201, { user: pubUser(u) }];
  }, { public: true });

  route('POST', '/api/auth/login', ({ body }) => {
    const { username, password } = body;
    if (!isStr(username) || !isStr(password)) throw bad('username and password required');
    const name = username.toLowerCase();
    const cutoff = Date.now() - 15 * 60 * 1000;
    const fails = (failures.get(name) || []).filter((t) => t > cutoff);
    failures.set(name, fails);
    if (fails.length >= 5) throw E(429, 'rate_limited', 'too many failed attempts');
    const u = db.users.find((x) => x.username === name);
    if (!u || !checkPw(u, password)) { fails.push(Date.now()); throw E(401, 'unauthorized', 'invalid credentials'); }
    failures.delete(name);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, u.id);
    return [200, { token, user: pubUser(u) }];
  }, { public: true });

  route('POST', '/api/auth/logout', ({ token }) => { sessions.delete(token); return [204]; });
  route('GET', '/api/auth/me', ({ user }) => [200, { user: pubUser(user) }]);

  // boards
  route('POST', '/api/boards', ({ user, body }) => {
    validName(body.name, 100);
    if (body.description != null && !isStr(body.description)) throw bad('description must be a string');
    let cols = body.columns ?? ['To Do', 'In Progress', 'Done'];
    if (!Array.isArray(cols) || !cols.every((c) => isStr(c) && c.trim() && c.length <= 100)) throw bad('columns must be an array of names');
    const b = { id: uid(), name: body.name, description: body.description ?? '', ownerId: user.id, createdAt: now() };
    db.boards.push(b);
    db.members.push({ boardId: b.id, userId: user.id, role: 'owner' });
    cols.forEach((name, i) => db.columns.push({ id: uid(), boardId: b.id, name, position: i, wipLimit: null }));
    log(b.id, 'board.created', user.id, null, { name: b.name });
    for (const c of boardCols(b.id)) log(b.id, 'column.created', user.id, null, { columnId: c.id, name: c.name });
    save();
    return [201, boardView(b)];
  });
  route('GET', '/api/boards', ({ user }) => [200, db.members.filter((m) => m.userId === user.id).map((m) => ({ id: m.boardId, name: find('boards', m.boardId).name, role: m.role }))]);
  route('GET', '/api/boards/:id', ({ user, p }) => { const b = getBoard(p.id); access(user, b, 'viewer'); return [200, boardView(b)]; });
  route('PATCH', '/api/boards/:id', ({ user, p, body }) => {
    const b = getBoard(p.id); access(user, b, 'owner');
    if (body.name !== undefined) validName(body.name, 100);
    if (body.description !== undefined && !isStr(body.description)) throw bad('description must be a string');
    if (body.name !== undefined) b.name = body.name;
    if (body.description !== undefined) b.description = body.description;
    save(); return [200, boardView(b)];
  });
  route('DELETE', '/api/boards/:id', ({ user, p }) => {
    const b = getBoard(p.id); access(user, b, 'owner');
    deleteCardsOf((c) => c.boardId === b.id);
    db.columns = db.columns.filter((c) => c.boardId !== b.id);
    db.labels = db.labels.filter((c) => c.boardId !== b.id);
    db.members = db.members.filter((c) => c.boardId !== b.id);
    db.activity = db.activity.filter((c) => c.boardId !== b.id);
    db.boards = db.boards.filter((x) => x.id !== b.id);
    save(); return [204];
  });

  // members
  route('POST', '/api/boards/:id/members', ({ user, p, body }) => {
    const b = getBoard(p.id); access(user, b, 'owner');
    if (!isStr(body.username)) throw bad('username required');
    if (body.role !== 'editor' && body.role !== 'viewer') throw bad('role must be editor or viewer');
    const t = db.users.find((u) => u.username === body.username.toLowerCase());
    if (!t) throw notFound('user not found');
    if (roleOf(b.id, t.id)) throw E(409, 'conflict', 'already a member');
    db.members.push({ boardId: b.id, userId: t.id, role: body.role });
    log(b.id, 'member.added', user.id, null, { userId: t.id, role: body.role });
    save(); return [201, { userId: t.id, username: t.username, role: body.role }];
  });
  route('PATCH', '/api/boards/:id/members/:uid', ({ user, p, body }) => {
    const b = getBoard(p.id); access(user, b, 'owner');
    const m = db.members.find((x) => x.boardId === b.id && x.userId === p.uid);
    if (!m) throw notFound('member not found');
    if (body.role !== 'editor' && body.role !== 'viewer') throw bad('role must be editor or viewer');
    if (m.role === 'owner') throw bad('cannot change owner role');
    m.role = body.role; save();
    return [200, { userId: m.userId, username: find('users', m.userId)?.username, role: m.role }];
  });
  route('DELETE', '/api/boards/:id/members/:uid', ({ user, p }) => {
    const b = getBoard(p.id); const r = access(user, b, 'viewer');
    if (r !== 'owner' && user.id !== p.uid) throw forbidden('only the owner can remove other members');
    const m = db.members.find((x) => x.boardId === b.id && x.userId === p.uid);
    if (!m) throw notFound('member not found');
    if (m.role === 'owner') throw bad('cannot remove the owner');
    db.members = db.members.filter((x) => x !== m);
    for (const c of db.cards) if (c.boardId === b.id) c.assignees = c.assignees.filter((a) => a !== p.uid);
    save(); return [204];
  });

  // columns
  route('POST', '/api/boards/:id/columns', ({ user, p, body }) => {
    const b = getBoard(p.id); access(user, b, 'editor');
    validName(body.name, 100);
    if (body.wipLimit !== undefined) validWip(body.wipLimit);
    const c = { id: uid(), boardId: b.id, name: body.name, position: boardCols(b.id).length, wipLimit: body.wipLimit ?? null };
    db.columns.push(c);
    log(b.id, 'column.created', user.id, null, { columnId: c.id, name: c.name });
    save(); return [201, colView(c)];
  });
  route('PATCH', '/api/columns/:id', ({ user, p, body }) => {
    const c = getColumn(p.id); const b = getBoard(c.boardId); access(user, b, 'editor');
    if (body.name !== undefined) validName(body.name, 100);
    if (body.wipLimit !== undefined) validWip(body.wipLimit);
    if (body.position !== undefined) checkPos(body.position);
    if (body.name !== undefined) c.name = body.name;
    if (body.wipLimit !== undefined) c.wipLimit = body.wipLimit;
    if (body.position !== undefined) {
      const cols = boardCols(b.id).filter((x) => x !== c);
      cols.splice(clampPos(body.position, cols.length), 0, c);
      renumber(cols);
    }
    save(); return [200, colView(c)];
  });
  route('DELETE', '/api/columns/:id', ({ user, p, query }) => {
    const c = getColumn(p.id); const b = getBoard(c.boardId); access(user, b, 'editor');
    if (colCards(c.id).length && query.get('force') !== 'true') throw E(409, 'conflict', 'column has cards');
    deleteCardsOf((x) => x.columnId === c.id);
    db.columns = db.columns.filter((x) => x !== c);
    renumber(boardCols(b.id));
    save(); return [204];
  });

  // cards
  route('POST', '/api/columns/:id/cards', ({ user, p, body }) => {
    const col = getColumn(p.id); const b = getBoard(col.boardId); access(user, b, 'editor');
    validName(body.title, 200, 'title');
    if (body.description != null && !isStr(body.description)) throw bad('description must be a string');
    if (body.dueDate != null && !validDate(body.dueDate)) throw bad('dueDate must be YYYY-MM-DD');
    const assignees = body.assignees === undefined ? [] : validateAssignees(b, body.assignees);
    const labels = body.labels === undefined ? [] : validateLabels(b, body.labels);
    if (body.position != null) checkPos(body.position);
    checkWip(col);
    const t = now();
    const card = { id: uid(), boardId: b.id, columnId: col.id, title: body.title, description: body.description ?? '', position: 0, assignees, labels, dueDate: body.dueDate ?? null, createdBy: user.id, createdAt: t, updatedAt: t };
    const list = colCards(col.id);
    list.splice(body.position == null ? list.length : clampPos(body.position, list.length), 0, card);
    db.cards.push(card); renumber(list);
    log(b.id, 'card.created', user.id, card.id, { title: card.title, columnId: col.id });
    save(); return [201, card];
  });
  route('GET', '/api/cards/:id', ({ user, p }) => { const c = getCard(p.id); access(user, getBoard(c.boardId), 'viewer'); return [200, c]; });
  route('PATCH', '/api/cards/:id', ({ user, p, body }) => {
    const card = getCard(p.id); const b = getBoard(card.boardId); access(user, b, 'editor');
    if (body.title !== undefined) validName(body.title, 200, 'title');
    if (body.description !== undefined && !isStr(body.description)) throw bad('description must be a string');
    if (body.dueDate != null && !validDate(body.dueDate)) throw bad('dueDate must be YYYY-MM-DD');
    const assignees = body.assignees === undefined ? undefined : validateAssignees(b, body.assignees);
    const labels = body.labels === undefined ? undefined : validateLabels(b, body.labels);
    const changed = [];
    if (body.title !== undefined) { card.title = body.title; changed.push('title'); }
    if (body.description !== undefined) { card.description = body.description; changed.push('description'); }
    if (body.dueDate !== undefined) { card.dueDate = body.dueDate; changed.push('dueDate'); }
    if (assignees) { card.assignees = assignees; changed.push('assignees'); }
    if (labels) { card.labels = labels; changed.push('labels'); }
    card.updatedAt = now();
    log(b.id, 'card.updated', user.id, card.id, { fields: changed });
    save(); return [200, card];
  });
  route('DELETE', '/api/cards/:id', ({ user, p }) => {
    const card = getCard(p.id); const b = getBoard(card.boardId); access(user, b, 'editor');
    deleteCardsOf((x) => x.id === card.id);
    renumber(colCards(card.columnId));
    log(b.id, 'card.deleted', user.id, card.id, { title: card.title });
    save(); return [204];
  });
  route('POST', '/api/cards/:id/move', ({ user, p, body }) => {
    const card = getCard(p.id); const b = getBoard(card.boardId); access(user, b, 'editor');
    if (!isStr(body.columnId)) throw bad('columnId required');
    const target = find('columns', body.columnId);
    if (!target || target.boardId !== b.id) throw bad('target column must be on the same board');
    if (body.position != null) checkPos(body.position);
    const from = card.columnId;
    if (from !== target.id) checkWip(target);
    const src = colCards(from).filter((x) => x !== card);
    if (from === target.id) {
      src.splice(body.position == null ? src.length : clampPos(body.position, src.length), 0, card);
      renumber(src);
    } else {
      renumber(src);
      const dst = colCards(target.id);
      dst.splice(body.position == null ? dst.length : clampPos(body.position, dst.length), 0, card);
      card.columnId = target.id;
      renumber(dst);
    }
    card.updatedAt = now();
    log(b.id, 'card.moved', user.id, card.id, { fromColumnId: from, toColumnId: target.id, position: card.position });
    save(); return [200, card];
  });

  // labels
  route('POST', '/api/boards/:id/labels', ({ user, p, body }) => {
    const b = getBoard(p.id); access(user, b, 'editor');
    validName(body.name, 50);
    if (!isStr(body.color) || !/^#[0-9a-fA-F]{6}$/.test(body.color)) throw bad('color must be #rrggbb');
    if (db.labels.some((l) => l.boardId === b.id && l.name.toLowerCase() === body.name.toLowerCase())) throw E(409, 'conflict', 'label exists');
    const l = { id: uid(), boardId: b.id, name: body.name, color: body.color };
    db.labels.push(l); save(); return [201, l];
  });
  route('DELETE', '/api/labels/:id', ({ user, p }) => {
    const l = find('labels', p.id); if (!l) throw notFound('label not found');
    access(user, getBoard(l.boardId), 'editor');
    db.labels = db.labels.filter((x) => x !== l);
    for (const c of db.cards) if (c.labels.includes(l.id)) c.labels = c.labels.filter((x) => x !== l.id);
    save(); return [204];
  });

  // comments
  route('POST', '/api/cards/:id/comments', ({ user, p, body }) => {
    const card = getCard(p.id); const b = getBoard(card.boardId); access(user, b, 'editor');
    if (!isStr(body.body) || body.body.length < 1 || body.body.length > 5000) throw bad('body must be 1-5000 characters');
    const c = { id: uid(), cardId: card.id, authorId: user.id, body: body.body, createdAt: now() };
    db.comments.push(c);
    log(b.id, 'comment.added', user.id, card.id, { commentId: c.id });
    save(); return [201, c];
  });
  route('GET', '/api/cards/:id/comments', ({ user, p }) => {
    const card = getCard(p.id); access(user, getBoard(card.boardId), 'viewer');
    return [200, db.comments.filter((c) => c.cardId === card.id)];
  });
  route('DELETE', '/api/comments/:id', ({ user, p }) => {
    const c = find('comments', p.id); if (!c) throw notFound('comment not found');
    const card = getCard(c.cardId); const b = getBoard(card.boardId);
    const r = access(user, b, 'viewer');
    if (c.authorId !== user.id && r !== 'owner') throw forbidden('only the author or board owner may delete');
    db.comments = db.comments.filter((x) => x !== c); save(); return [204];
  });

  // search + activity
  route('GET', '/api/boards/:id/cards', ({ user, p, query }) => {
    const b = getBoard(p.id); access(user, b, 'viewer');
    const q = query.get('q')?.toLowerCase(), assignee = query.get('assignee'), label = query.get('label'), column = query.get('column'), due = query.get('due_before');
    if (due && !validDate(due)) throw bad('due_before must be YYYY-MM-DD');
    const pos = new Map(boardCols(b.id).map((c) => [c.id, c.position]));
    const res = db.cards.filter((c) => c.boardId === b.id
      && (!q || c.title.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
      && (!assignee || c.assignees.includes(assignee))
      && (!label || c.labels.includes(label))
      && (!column || c.columnId === column)
      && (!due || (c.dueDate && c.dueDate < due)));
    res.sort((a, c) => (pos.get(a.columnId) - pos.get(c.columnId)) || (a.position - c.position));
    return [200, res];
  });
  route('GET', '/api/boards/:id/activity', ({ user, p, query }) => {
    const b = getBoard(p.id); access(user, b, 'viewer');
    let limit = 50;
    if (query.has('limit')) { limit = Number(query.get('limit')); if (!Number.isInteger(limit) || limit < 1) throw bad('invalid limit'); }
    return [200, db.activity.filter((a) => a.boardId === b.id).reverse().slice(0, limit)];
  });

  // ---- server
  function send(res, status, data, headers = {}) {
    if (data === undefined) { res.writeHead(status, headers); return res.end(); }
    const body = JSON.stringify(data);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers });
    res.end(body);
  }

  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('error', () => {});
    req.on('end', () => {
      try {
        const url = new URL(req.url, 'http://x');
        const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
        if (req.method === 'GET' && path === '/') {
          const b = INDEX_HTML;
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(b) });
          return res.end(b);
        }
        if (!path.startsWith('/api/')) throw notFound('route not found');
        let match = null, pathMatched = false;
        for (const r of routes) {
          const m = r.re.exec(path);
          if (!m) continue;
          pathMatched = true;
          if (r.method !== req.method) continue;
          match = { r, p: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
          break;
        }
        if (!match) throw notFound('route not found');
        let user = null, token = null;
        if (!match.r.public) {
          const h = req.headers.authorization || '';
          const m = /^Bearer (.+)$/i.exec(h);
          token = m?.[1];
          const uidv = token && sessions.get(token);
          user = uidv && find('users', uidv);
          if (!user) throw E(401, 'unauthorized', 'authentication required');
        }
        let body = {};
        if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (raw.trim()) {
            try { body = JSON.parse(raw); } catch { throw bad('invalid JSON'); }
            if (!isObj(body)) throw bad('body must be a JSON object');
          }
        }
        const [status, data] = match.r.handler({ user, token, body, p: match.p, query: url.searchParams });
        send(res, status, data);
      } catch (e) {
        if (e instanceof HttpError) send(res, e.status, { error: e.code, message: e.message });
        else { console.error(e); send(res, 500, { error: 'internal', message: 'internal error' }); }
      }
    });
  });
}
