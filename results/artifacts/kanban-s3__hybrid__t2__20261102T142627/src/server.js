import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

class HttpError extends Error {
  constructor(status, error, message) { super(message || error); this.status = status; this.code = error; }
}
const bad = (m) => new HttpError(400, 'validation', m);
const forbidden = (m = 'forbidden') => new HttpError(403, 'forbidden', m);
const notFound = (m = 'not found') => new HttpError(404, 'not_found', m);
const conflict = (m, code = 'conflict') => new HttpError(409, code, m);

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const isStr = (v) => typeof v === 'string';
const isDate = (v) => isStr(v) && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;

function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return salt + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPw(pw, stored) {
  const [salt, h] = stored.split(':');
  const a = Buffer.from(crypto.scryptSync(pw, salt, 64).toString('hex'));
  const b = Buffer.from(h);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createServer({ dataFile } = {}) {
  let db = { users: [], boards: [], columns: [], cards: [], labels: [], comments: [], activity: [] };
  if (dataFile && fs.existsSync(dataFile)) {
    try { db = { ...db, ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) }; } catch { /* ignore */ }
  }
  const sessions = new Map(); // token -> userId
  const failures = new Map(); // username -> [timestamps]

  function save() {
    if (!dataFile) return;
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, dataFile);
  }
  const pubUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName });
  const log = (boardId, type, actorId, cardId, details = {}) => {
    const e = { id: uid(), boardId, type, actorId, at: now(), details };
    if (cardId) e.cardId = cardId;
    db.activity.push(e);
  };

  // ---- lookups
  const getBoard = (id) => db.boards.find((b) => b.id === id) || (() => { throw notFound('board not found'); })();
  const getColumn = (id) => db.columns.find((c) => c.id === id) || (() => { throw notFound('column not found'); })();
  const getCard = (id) => db.cards.find((c) => c.id === id) || (() => { throw notFound('card not found'); })();
  const getLabel = (id) => db.labels.find((c) => c.id === id) || (() => { throw notFound('label not found'); })();
  const getComment = (id) => db.comments.find((c) => c.id === id) || (() => { throw notFound('comment not found'); })();
  const roleOf = (board, userId) => board.members.find((m) => m.userId === userId)?.role || null;
  function need(board, user, level) { // level: 'viewer' | 'editor' | 'owner'
    const r = roleOf(board, user.id);
    if (!r) throw forbidden('not a member of this board');
    const rank = { viewer: 1, editor: 2, owner: 3 };
    if (rank[r] < rank[level]) throw forbidden('insufficient role');
    return r;
  }
  const colCards = (colId) => db.cards.filter((c) => c.columnId === colId).sort((a, b) => a.position - b.position);
  const boardCols = (boardId) => db.columns.filter((c) => c.boardId === boardId).sort((a, b) => a.position - b.position);
  const renumber = (list) => list.forEach((x, i) => { x.position = i; });
  const clampPos = (p, n) => Math.max(0, Math.min(n, p));
  function optPos(v) {
    if (v === undefined || v === null) return undefined;
    if (!Number.isInteger(v)) throw bad('position must be an integer');
    return v;
  }

  function boardView(b) {
    return {
      id: b.id, name: b.name, description: b.description, ownerId: b.ownerId, createdAt: b.createdAt,
      members: b.members.map((m) => ({ userId: m.userId, username: db.users.find((u) => u.id === m.userId)?.username, role: m.role })),
      labels: db.labels.filter((l) => l.boardId === b.id),
      columns: boardCols(b.id).map((c) => ({ id: c.id, name: c.name, position: c.position, wipLimit: c.wipLimit, cards: colCards(c.id) })),
    };
  }
  const colView = (c) => ({ id: c.id, boardId: c.boardId, name: c.name, position: c.position, wipLimit: c.wipLimit });

  function validWip(v) {
    if (v === null) return null;
    if (!Number.isInteger(v) || v < 1) throw bad('wipLimit must be a positive integer or null');
    return v;
  }
  function checkAssigneesLabels(board, assignees, labels) {
    if (assignees !== undefined) {
      if (!Array.isArray(assignees) || !assignees.every((a) => isStr(a) && roleOf(board, a))) throw bad('assignees must be board members');
    }
    if (labels !== undefined) {
      if (!Array.isArray(labels) || !labels.every((l) => isStr(l) && db.labels.some((x) => x.id === l && x.boardId === board.id))) throw bad('labels must belong to the board');
    }
  }

  // ---- routes
  const routes = [];
  const route = (method, pattern, auth, fn) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, auth, fn });
  };

  route('POST', '/api/auth/register', false, ({ body }) => {
    const { username, password, displayName } = body;
    if (!isStr(username) || !/^[a-zA-Z0-9_]{3,32}$/.test(username)) throw bad('invalid username');
    if (!isStr(password) || password.length < 8) throw bad('password must be at least 8 characters');
    if (displayName !== undefined && displayName !== null && (!isStr(displayName) || !displayName.trim())) throw bad('invalid displayName');
    const name = username.toLowerCase();
    if (db.users.some((u) => u.username === name)) throw conflict('username taken');
    const u = { id: uid(), username: name, displayName: displayName || name, passwordHash: hashPw(password) };
    db.users.push(u);
    save();
    return [201, { user: pubUser(u) }];
  });
  route('POST', '/api/auth/login', false, ({ body }) => {
    const { username, password } = body;
    if (!isStr(username) || !isStr(password)) throw bad('username and password required');
    const name = username.toLowerCase();
    const cutoff = Date.now() - 15 * 60 * 1000;
    const fl = (failures.get(name) || []).filter((t) => t > cutoff);
    failures.set(name, fl);
    if (fl.length >= 5) throw new HttpError(429, 'rate_limited', 'too many failed attempts');
    const u = db.users.find((x) => x.username === name);
    if (!u || !checkPw(password, u.passwordHash)) {
      fl.push(Date.now());
      throw new HttpError(401, 'unauthorized', 'invalid credentials');
    }
    failures.delete(name);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, u.id);
    return [200, { token, user: pubUser(u) }];
  });
  route('POST', '/api/auth/logout', true, ({ token }) => { sessions.delete(token); return [204]; });
  route('GET', '/api/auth/me', true, ({ user }) => [200, { user: pubUser(user) }]);

  // boards
  route('POST', '/api/boards', true, ({ user, body }) => {
    const { name, description, columns } = body;
    if (!isStr(name) || name.length < 1 || name.length > 100) throw bad('name must be 1-100 chars');
    if (description !== undefined && description !== null && !isStr(description)) throw bad('invalid description');
    let cols = ['To Do', 'In Progress', 'Done'];
    if (columns !== undefined) {
      if (!Array.isArray(columns) || !columns.every((c) => isStr(c) && c.length >= 1 && c.length <= 100)) throw bad('invalid columns');
      cols = columns;
    }
    const b = { id: uid(), name, description: description || '', ownerId: user.id, createdAt: now(), members: [{ userId: user.id, role: 'owner' }] };
    db.boards.push(b);
    log(b.id, 'board.created', user.id, null, { name });
    cols.forEach((n, i) => {
      const c = { id: uid(), boardId: b.id, name: n, position: i, wipLimit: null };
      db.columns.push(c);
      log(b.id, 'column.created', user.id, null, { columnId: c.id, name: n });
    });
    save();
    return [201, boardView(b)];
  });
  route('GET', '/api/boards', true, ({ user }) =>
    [200, db.boards.filter((b) => roleOf(b, user.id)).map((b) => ({ id: b.id, name: b.name, role: roleOf(b, user.id) }))]);
  route('GET', '/api/boards/:id', true, ({ user, params }) => {
    const b = getBoard(params.id); need(b, user, 'viewer'); return [200, boardView(b)];
  });
  route('PATCH', '/api/boards/:id', true, ({ user, params, body }) => {
    const b = getBoard(params.id); need(b, user, 'owner');
    if (body.name !== undefined && (!isStr(body.name) || body.name.length < 1 || body.name.length > 100)) throw bad('name must be 1-100 chars');
    if (body.description !== undefined && body.description !== null && !isStr(body.description)) throw bad('invalid description');
    if (body.name !== undefined) b.name = body.name;
    if (body.description !== undefined) b.description = body.description || '';
    save();
    return [200, boardView(b)];
  });
  route('DELETE', '/api/boards/:id', true, ({ user, params }) => {
    const b = getBoard(params.id); need(b, user, 'owner');
    db.boards = db.boards.filter((x) => x.id !== b.id);
    db.columns = db.columns.filter((x) => x.boardId !== b.id);
    const cardIds = new Set(db.cards.filter((x) => x.boardId === b.id).map((x) => x.id));
    db.cards = db.cards.filter((x) => x.boardId !== b.id);
    db.labels = db.labels.filter((x) => x.boardId !== b.id);
    db.comments = db.comments.filter((x) => !cardIds.has(x.cardId));
    db.activity = db.activity.filter((x) => x.boardId !== b.id);
    save();
    return [204];
  });

  // members
  route('POST', '/api/boards/:id/members', true, ({ user, params, body }) => {
    const b = getBoard(params.id); need(b, user, 'owner');
    if (!isStr(body.username)) throw bad('username required');
    if (body.role !== 'editor' && body.role !== 'viewer') throw bad('role must be editor or viewer');
    const u = db.users.find((x) => x.username === body.username.toLowerCase());
    if (!u) throw notFound('user not found');
    if (roleOf(b, u.id)) throw conflict('already a member');
    b.members.push({ userId: u.id, role: body.role });
    log(b.id, 'member.added', user.id, null, { userId: u.id, role: body.role });
    save();
    return [201, { userId: u.id, username: u.username, role: body.role }];
  });
  route('PATCH', '/api/boards/:id/members/:userId', true, ({ user, params, body }) => {
    const b = getBoard(params.id); need(b, user, 'owner');
    if (body.role !== 'editor' && body.role !== 'viewer') throw bad('role must be editor or viewer');
    const m = b.members.find((x) => x.userId === params.userId);
    if (!m) throw notFound('member not found');
    if (m.role === 'owner') throw bad('cannot change owner role');
    m.role = body.role;
    save();
    const u = db.users.find((x) => x.id === m.userId);
    return [200, { userId: m.userId, username: u?.username, role: m.role }];
  });
  route('DELETE', '/api/boards/:id/members/:userId', true, ({ user, params }) => {
    const b = getBoard(params.id);
    need(b, user, 'viewer');
    const isOwner = roleOf(b, user.id) === 'owner';
    if (!isOwner && params.userId !== user.id) throw forbidden('only the owner can remove others');
    const m = b.members.find((x) => x.userId === params.userId);
    if (!m) throw notFound('member not found');
    if (m.role === 'owner') throw bad('cannot remove the owner');
    b.members = b.members.filter((x) => x !== m);
    db.cards.filter((c) => c.boardId === b.id).forEach((c) => { c.assignees = c.assignees.filter((a) => a !== m.userId); });
    save();
    return [204];
  });

  // columns
  route('POST', '/api/boards/:id/columns', true, ({ user, params, body }) => {
    const b = getBoard(params.id); need(b, user, 'editor');
    if (!isStr(body.name) || body.name.length < 1 || body.name.length > 100) throw bad('name must be 1-100 chars');
    const wip = body.wipLimit === undefined ? null : validWip(body.wipLimit);
    const c = { id: uid(), boardId: b.id, name: body.name, position: boardCols(b.id).length, wipLimit: wip };
    db.columns.push(c);
    log(b.id, 'column.created', user.id, null, { columnId: c.id, name: c.name });
    save();
    return [201, colView(c)];
  });
  route('PATCH', '/api/columns/:id', true, ({ user, params, body }) => {
    const c = getColumn(params.id); const b = getBoard(c.boardId); need(b, user, 'editor');
    if (body.name !== undefined && (!isStr(body.name) || body.name.length < 1 || body.name.length > 100)) throw bad('invalid name');
    if (body.wipLimit !== undefined) validWip(body.wipLimit);
    if (body.position !== undefined && !Number.isInteger(body.position)) throw bad('position must be an integer');
    if (body.name !== undefined) c.name = body.name;
    if (body.wipLimit !== undefined) c.wipLimit = body.wipLimit;
    if (body.position !== undefined) {
      const list = boardCols(b.id).filter((x) => x !== c);
      list.splice(clampPos(body.position, list.length), 0, c);
      renumber(list);
    }
    save();
    return [200, colView(c)];
  });
  route('DELETE', '/api/columns/:id', true, ({ user, params, query }) => {
    const c = getColumn(params.id); const b = getBoard(c.boardId); need(b, user, 'editor');
    const cards = colCards(c.id);
    if (cards.length && query.get('force') !== 'true') throw conflict('column has cards');
    const ids = new Set(cards.map((x) => x.id));
    db.cards = db.cards.filter((x) => x.columnId !== c.id);
    db.comments = db.comments.filter((x) => !ids.has(x.cardId));
    db.columns = db.columns.filter((x) => x !== c);
    renumber(boardCols(b.id));
    save();
    return [204];
  });

  // cards
  route('POST', '/api/columns/:id/cards', true, ({ user, params, body }) => {
    const col = getColumn(params.id); const b = getBoard(col.boardId); need(b, user, 'editor');
    if (!isStr(body.title) || body.title.length < 1 || body.title.length > 200) throw bad('title must be 1-200 chars');
    if (body.description !== undefined && body.description !== null && !isStr(body.description)) throw bad('invalid description');
    if (body.dueDate !== undefined && body.dueDate !== null && !isDate(body.dueDate)) throw bad('dueDate must be YYYY-MM-DD');
    checkAssigneesLabels(b, body.assignees, body.labels);
    const pos = optPos(body.position);
    const list = colCards(col.id);
    if (col.wipLimit != null && list.length >= col.wipLimit) throw conflict('WIP limit reached', 'wip_limit');
    const t = now();
    const card = {
      id: uid(), boardId: b.id, columnId: col.id, title: body.title, description: body.description || '', position: 0,
      assignees: [...new Set(body.assignees || [])], labels: [...new Set(body.labels || [])], dueDate: body.dueDate ?? null,
      createdBy: user.id, createdAt: t, updatedAt: t,
    };
    list.splice(pos === undefined ? list.length : clampPos(pos, list.length), 0, card);
    renumber(list);
    db.cards.push(card);
    log(b.id, 'card.created', user.id, card.id, { title: card.title, columnId: col.id });
    save();
    return [201, card];
  });
  route('GET', '/api/cards/:id', true, ({ user, params }) => {
    const c = getCard(params.id); need(getBoard(c.boardId), user, 'viewer'); return [200, c];
  });
  route('PATCH', '/api/cards/:id', true, ({ user, params, body }) => {
    const card = getCard(params.id); const b = getBoard(card.boardId); need(b, user, 'editor');
    if (body.title !== undefined && (!isStr(body.title) || body.title.length < 1 || body.title.length > 200)) throw bad('title must be 1-200 chars');
    if (body.description !== undefined && body.description !== null && !isStr(body.description)) throw bad('invalid description');
    if (body.dueDate !== undefined && body.dueDate !== null && !isDate(body.dueDate)) throw bad('dueDate must be YYYY-MM-DD');
    checkAssigneesLabels(b, body.assignees, body.labels);
    const changed = [];
    for (const k of ['title', 'description', 'dueDate']) if (body[k] !== undefined) { card[k] = k === 'description' ? body[k] || '' : body[k]; changed.push(k); }
    if (body.assignees !== undefined) { card.assignees = [...new Set(body.assignees)]; changed.push('assignees'); }
    if (body.labels !== undefined) { card.labels = [...new Set(body.labels)]; changed.push('labels'); }
    card.updatedAt = now();
    log(b.id, 'card.updated', user.id, card.id, { fields: changed });
    save();
    return [200, card];
  });
  route('DELETE', '/api/cards/:id', true, ({ user, params }) => {
    const card = getCard(params.id); const b = getBoard(card.boardId); need(b, user, 'editor');
    db.cards = db.cards.filter((x) => x !== card);
    db.comments = db.comments.filter((x) => x.cardId !== card.id);
    renumber(colCards(card.columnId));
    log(b.id, 'card.deleted', user.id, card.id, { title: card.title, columnId: card.columnId });
    save();
    return [204];
  });
  route('POST', '/api/cards/:id/move', true, ({ user, params, body }) => {
    const card = getCard(params.id); const b = getBoard(card.boardId); need(b, user, 'editor');
    if (!isStr(body.columnId)) throw bad('columnId required');
    const target = db.columns.find((c) => c.id === body.columnId);
    if (!target || target.boardId !== b.id) throw bad('target column must be on the same board');
    const pos = optPos(body.position);
    const fromId = card.columnId;
    const same = fromId === target.id;
    if (!same) {
      const n = colCards(target.id).length;
      if (target.wipLimit != null && n >= target.wipLimit) throw conflict('WIP limit reached', 'wip_limit');
    }
    const src = colCards(fromId).filter((c) => c !== card);
    const dst = same ? src : colCards(target.id);
    dst.splice(pos === undefined ? dst.length : clampPos(pos, dst.length), 0, card);
    card.columnId = target.id;
    if (!same) renumber(src);
    renumber(dst);
    card.updatedAt = now();
    log(b.id, 'card.moved', user.id, card.id, { fromColumnId: fromId, toColumnId: target.id, position: card.position });
    save();
    return [200, card];
  });

  // labels
  route('POST', '/api/boards/:id/labels', true, ({ user, params, body }) => {
    const b = getBoard(params.id); need(b, user, 'editor');
    if (!isStr(body.name) || !body.name.trim() || body.name.length > 100) throw bad('invalid name');
    if (!isStr(body.color) || !/^#[0-9a-fA-F]{6}$/.test(body.color)) throw bad('color must be #rrggbb');
    if (db.labels.some((l) => l.boardId === b.id && l.name.toLowerCase() === body.name.toLowerCase())) throw conflict('label exists');
    const l = { id: uid(), boardId: b.id, name: body.name, color: body.color };
    db.labels.push(l);
    save();
    return [201, l];
  });
  route('DELETE', '/api/labels/:id', true, ({ user, params }) => {
    const l = getLabel(params.id); const b = getBoard(l.boardId); need(b, user, 'editor');
    db.labels = db.labels.filter((x) => x !== l);
    db.cards.forEach((c) => { if (c.labels.includes(l.id)) c.labels = c.labels.filter((x) => x !== l.id); });
    save();
    return [204];
  });

  // comments
  route('POST', '/api/cards/:id/comments', true, ({ user, params, body }) => {
    const card = getCard(params.id); const b = getBoard(card.boardId); need(b, user, 'editor');
    if (!isStr(body.body) || body.body.length < 1 || body.body.length > 5000) throw bad('body must be 1-5000 chars');
    const c = { id: uid(), cardId: card.id, authorId: user.id, body: body.body, createdAt: now() };
    db.comments.push(c);
    log(b.id, 'comment.added', user.id, card.id, { commentId: c.id });
    save();
    return [201, c];
  });
  route('GET', '/api/cards/:id/comments', true, ({ user, params }) => {
    const card = getCard(params.id); need(getBoard(card.boardId), user, 'viewer');
    return [200, db.comments.filter((c) => c.cardId === card.id)];
  });
  route('DELETE', '/api/comments/:id', true, ({ user, params }) => {
    const c = getComment(params.id); const card = getCard(c.cardId); const b = getBoard(card.boardId);
    need(b, user, 'viewer');
    if (c.authorId !== user.id && roleOf(b, user.id) !== 'owner') throw forbidden('not allowed');
    db.comments = db.comments.filter((x) => x !== c);
    save();
    return [204];
  });

  // search + activity
  route('GET', '/api/boards/:id/cards', true, ({ user, params, query }) => {
    const b = getBoard(params.id); need(b, user, 'viewer');
    const q = query.get('q'), assignee = query.get('assignee'), label = query.get('label'), column = query.get('column'), due = query.get('due_before');
    if (due !== null && !isDate(due)) throw bad('due_before must be YYYY-MM-DD');
    const colPos = new Map(db.columns.filter((c) => c.boardId === b.id).map((c) => [c.id, c.position]));
    const res = db.cards.filter((c) => c.boardId === b.id).filter((c) =>
      (!q || c.title.toLowerCase().includes(q.toLowerCase()) || (c.description || '').toLowerCase().includes(q.toLowerCase())) &&
      (!assignee || c.assignees.includes(assignee)) &&
      (!label || c.labels.includes(label)) &&
      (!column || c.columnId === column) &&
      (due === null || due === '' || (c.dueDate && c.dueDate < due)));
    res.sort((a, b2) => (colPos.get(a.columnId) - colPos.get(b2.columnId)) || (a.position - b2.position));
    return [200, res];
  });
  route('GET', '/api/boards/:id/activity', true, ({ user, params, query }) => {
    const b = getBoard(params.id); need(b, user, 'viewer');
    let limit = 50;
    if (query.has('limit')) {
      limit = Number(query.get('limit'));
      if (!Number.isInteger(limit) || limit < 1) throw bad('invalid limit');
    }
    return [200, db.activity.filter((a) => a.boardId === b.id).reverse().slice(0, limit)];
  });

  // ---- http plumbing
  const MIME = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };
  function send(res, status, obj, headers = {}) {
    if (status === 204) { res.writeHead(204); return res.end(); }
    const s = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s), ...headers });
    res.end(s);
  }
  function serveFile(res, file, type) {
    try {
      const data = fs.readFileSync(file);
      res.writeHead(200, { 'content-type': type, 'content-length': data.length });
      res.end(data);
    } catch { send(res, 404, { error: 'not_found', message: 'not found' }); }
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const url = new URL(req.url, 'http://x');
        const p = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
        if (req.method === 'GET' && p === '/') return serveFile(res, path.join(HERE, 'static', 'index.html'), 'text/html; charset=utf-8');
        if (req.method === 'GET' && p.startsWith('/static/')) {
          const rel = path.normalize(decodeURIComponent(p.slice(8)));
          if (rel.startsWith('..') || path.isAbsolute(rel)) throw notFound();
          return serveFile(res, path.join(HERE, 'static', rel), MIME[path.extname(rel)] || 'application/octet-stream');
        }
        let matched = null, pathMatched = false;
        for (const r of routes) {
          const m = r.re.exec(p);
          if (!m) continue;
          pathMatched = true;
          if (r.method !== req.method) continue;
          const params = {};
          r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
          matched = { r, params };
          break;
        }
        if (!matched) {
          if (pathMatched) throw new HttpError(405, 'method_not_allowed', 'method not allowed');
          throw notFound('route not found');
        }
        let user = null, token = null;
        if (matched.r.auth) {
          const h = req.headers.authorization || '';
          const mm = /^Bearer (.+)$/.exec(h);
          token = mm ? mm[1] : null;
          const uidv = token && sessions.get(token);
          user = uidv && db.users.find((u) => u.id === uidv);
          if (!user) throw new HttpError(401, 'unauthorized', 'authentication required');
        }
        let body = {};
        if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (raw.trim()) {
            try { body = JSON.parse(raw); } catch { throw bad('invalid JSON'); }
            if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('body must be a JSON object');
          }
        }
        const [status, out] = matched.r.fn({ user, token, params: matched.params, body, query: url.searchParams });
        send(res, status, out);
      } catch (e) {
        if (e instanceof HttpError) send(res, e.status, { error: e.code, message: e.message });
        else { console.error(e); send(res, 500, { error: 'internal', message: 'internal error' }); }
      }
    });
  });
  return server;
}
