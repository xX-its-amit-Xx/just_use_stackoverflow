import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');
const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };
const DEFAULT_COLUMNS = ['To Do', 'In Progress', 'Done'];
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const MAX_BODY_BYTES = 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const bad = (message) => new HttpError(400, 'validation', message);
const unauthorized = (message) => new HttpError(401, 'unauthenticated', message);
const forbidden = (message = 'forbidden') => new HttpError(403, 'forbidden', message);
const notFound = (what = 'resource') => new HttpError(404, 'not_found', `${what} not found`);
const conflict = (message, code = 'conflict') => new HttpError(409, code, message);

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const objBody = (b) => {
  if (b === undefined) return {};
  if (!isObj(b)) throw bad('body must be a JSON object');
  return b;
};
function str(v, field, min, max) {
  if (typeof v !== 'string') throw bad(`${field} must be a string`);
  const t = v.trim();
  if (t.length < min || t.length > max) throw bad(`${field} must be ${min}-${max} characters`);
  return t;
}
function optPosition(v) {
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v) || v < 0) throw bad('position must be a non-negative integer');
  return v;
}
function parseWip(v) {
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v) || v <= 0) throw bad('wipLimit must be a positive integer or null');
  return v;
}
function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function loadData(file) {
  const empty = { users: [], boards: [], columns: [], cards: [], labels: [], comments: [], activity: [] };
  if (!file || !fs.existsSync(file)) return empty;
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return empty;
  return { ...empty, ...JSON.parse(raw) };
}
function saveData(file, db) {
  if (!file) return;
  const abs = path.resolve(file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, abs);
}

function buildRoutes(db, sessions, failures) {
  const routes = [];
  const add = (method, pattern, handler, auth = true) =>
    routes.push({ method, re: new RegExp(`^${pattern}$`), handler, auth });

  // ---- helpers -----------------------------------------------------------
  const publicUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName });
  const memberOf = (board, userId) => board.members.find((m) => m.userId === userId);
  const userName = (id) => db.users.find((u) => u.id === id)?.username ?? null;
  function boardAccess(boardId, user, minRole = 'viewer') {
    const board = db.boards.find((b) => b.id === boardId);
    if (!board) throw notFound('board');
    const m = memberOf(board, user.id);
    if (!m) throw forbidden('not a member of this board');
    if (ROLE_RANK[m.role] < ROLE_RANK[minRole]) throw forbidden(`requires ${minRole} role`);
    return { board, role: m.role };
  }
  function columnAccess(columnId, user, minRole) {
    const column = db.columns.find((c) => c.id === columnId);
    if (!column) throw notFound('column');
    return { column, ...boardAccess(column.boardId, user, minRole) };
  }
  function cardAccess(cardId, user, minRole) {
    const card = db.cards.find((c) => c.id === cardId);
    if (!card) throw notFound('card');
    return { card, ...boardAccess(card.boardId, user, minRole) };
  }
  const columnsOf = (boardId) =>
    db.columns.filter((c) => c.boardId === boardId).sort((a, b) => a.position - b.position);
  const cardsOfColumn = (columnId) =>
    db.cards.filter((c) => c.columnId === columnId).sort((a, b) => a.position - b.position);
  const renumberColumns = (boardId) => columnsOf(boardId).forEach((c, i) => { c.position = i; });
  const renumberCards = (columnId) => cardsOfColumn(columnId).forEach((c, i) => { c.position = i; });
  function placeCard(card, columnId, index) {
    card.columnId = columnId;
    const list = cardsOfColumn(columnId).filter((c) => c !== card);
    list.splice(clamp(index ?? list.length, 0, list.length), 0, card);
    list.forEach((c, i) => { c.position = i; });
  }
  function logActivity(boardId, type, actorId, details = {}, cardId) {
    const entry = { id: uid(), boardId, type, actorId, at: now(), details };
    if (cardId) entry.cardId = cardId;
    db.activity.push(entry);
  }
  const labelOut = (l) => ({ id: l.id, boardId: l.boardId, name: l.name, color: l.color });
  const columnOut = (c) => ({ id: c.id, boardId: c.boardId, name: c.name, position: c.position, wipLimit: c.wipLimit });
  const cardOut = (c) => ({
    id: c.id,
    boardId: c.boardId,
    columnId: c.columnId,
    title: c.title,
    description: c.description,
    position: c.position,
    assignees: [...c.assignees],
    labels: [...c.labels],
    dueDate: c.dueDate,
    createdBy: c.createdBy,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  });
  const commentOut = (c) => ({ id: c.id, cardId: c.cardId, authorId: c.authorId, body: c.body, createdAt: c.createdAt });
  function boardOut(board) {
    return {
      id: board.id,
      name: board.name,
      description: board.description,
      ownerId: board.ownerId,
      createdAt: board.createdAt,
      members: board.members.map((m) => ({ userId: m.userId, username: userName(m.userId), role: m.role })),
      labels: db.labels.filter((l) => l.boardId === board.id).map(labelOut),
      columns: columnsOf(board.id).map((c) => ({
        ...columnOut(c),
        cards: cardsOfColumn(c.id).map(cardOut),
      })),
    };
  }
  function cardFields(board, b, creating) {
    const out = {};
    if (b.title !== undefined || creating) out.title = str(b.title, 'title', 1, 200);
    if (b.description !== undefined) {
      if (b.description !== null && typeof b.description !== 'string') throw bad('description must be a string');
      out.description = b.description ?? '';
    }
    if (b.assignees !== undefined) {
      const arr = b.assignees ?? [];
      if (!Array.isArray(arr) || arr.some((x) => typeof x !== 'string')) throw bad('assignees must be an array of user ids');
      const ids = [...new Set(arr)];
      for (const id of ids) if (!memberOf(board, id)) throw bad(`assignee ${id} is not a board member`);
      out.assignees = ids;
    }
    if (b.labels !== undefined) {
      const arr = b.labels ?? [];
      if (!Array.isArray(arr) || arr.some((x) => typeof x !== 'string')) throw bad('labels must be an array of label ids');
      const ids = [...new Set(arr)];
      for (const id of ids) {
        if (!db.labels.some((l) => l.id === id && l.boardId === board.id)) throw bad(`label ${id} does not belong to this board`);
      }
      out.labels = ids;
    }
    if (b.dueDate !== undefined) {
      if (b.dueDate !== null && !validDate(b.dueDate)) throw bad('dueDate must be YYYY-MM-DD or null');
      out.dueDate = b.dueDate ?? null;
    }
    return out;
  }

  // ---- auth --------------------------------------------------------------
  add('POST', '/api/auth/register', ({ body }) => {
    const b = objBody(body);
    const username = typeof b.username === 'string' ? b.username.toLowerCase() : '';
    if (!/^[a-z0-9_]{3,32}$/.test(username)) throw bad('username must be 3-32 characters of a-z, 0-9, _');
    if (typeof b.password !== 'string' || b.password.length < 8) throw bad('password must be at least 8 characters');
    let displayName = username;
    if (b.displayName !== undefined && b.displayName !== null) {
      displayName = str(b.displayName, 'displayName', 1, 100);
    }
    if (db.users.some((u) => u.username === username)) throw conflict('username already taken');
    const user = { id: uid(), username, displayName, passwordHash: hashPassword(b.password), createdAt: now() };
    db.users.push(user);
    return [201, { user: publicUser(user) }];
  }, false);

  add('POST', '/api/auth/login', ({ body }) => {
    const b = objBody(body);
    const username = typeof b.username === 'string' ? b.username.toLowerCase() : '';
    if (!username || typeof b.password !== 'string') throw bad('username and password are required');
    const t = Date.now();
    const recent = (failures.get(username) || []).filter((x) => t - x < LOGIN_WINDOW_MS);
    failures.set(username, recent);
    if (recent.length >= LOGIN_MAX_FAILURES) throw new HttpError(429, 'rate_limited', 'too many failed login attempts; try again later');
    const user = db.users.find((u) => u.username === username);
    if (!user || !verifyPassword(b.password, user.passwordHash)) {
      recent.push(t);
      throw unauthorized('invalid credentials');
    }
    failures.delete(username);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, user.id);
    return [200, { token, user: publicUser(user) }];
  }, false);

  add('POST', '/api/auth/logout', (ctx) => {
    sessions.delete(ctx.token);
    return [204];
  });

  add('GET', '/api/auth/me', (ctx) => [200, { user: publicUser(ctx.user) }]);

  // ---- boards ------------------------------------------------------------
  add('POST', '/api/boards', ({ body, user }) => {
    const b = objBody(body);
    const name = str(b.name, 'name', 1, 100);
    const description = b.description === undefined || b.description === null ? '' : b.description;
    if (typeof description !== 'string') throw bad('description must be a string');
    let columnNames = DEFAULT_COLUMNS;
    if (b.columns !== undefined && b.columns !== null) {
      if (!Array.isArray(b.columns)) throw bad('columns must be an array of names');
      columnNames = b.columns.map((c) => str(c, 'column name', 1, 100));
    }
    const board = {
      id: uid(), name, description, ownerId: user.id, createdAt: now(),
      members: [{ userId: user.id, role: 'owner' }],
    };
    db.boards.push(board);
    columnNames.forEach((n, i) => {
      const col = { id: uid(), boardId: board.id, name: n, position: i, wipLimit: null };
      db.columns.push(col);
      logActivity(board.id, 'column.created', user.id, { columnId: col.id, name: n });
    });
    logActivity(board.id, 'board.created', user.id, { name });
    return [201, boardOut(board)];
  });

  add('GET', '/api/boards', ({ user }) => [
    200,
    db.boards.filter((b) => memberOf(b, user.id)).map((b) => ({ id: b.id, name: b.name, role: memberOf(b, user.id).role })),
  ]);

  add('GET', '/api/boards/([^/]+)', (ctx, boardId) => {
    const { board } = boardAccess(boardId, ctx.user, 'viewer');
    return [200, boardOut(board)];
  });

  add('PATCH', '/api/boards/([^/]+)', ({ body, user }, boardId) => {
    const { board } = boardAccess(boardId, user, 'owner');
    const b = objBody(body);
    const out = {};
    if (b.name !== undefined) out.name = str(b.name, 'name', 1, 100);
    if (b.description !== undefined) {
      if (b.description !== null && typeof b.description !== 'string') throw bad('description must be a string');
      out.description = b.description ?? '';
    }
    Object.assign(board, out);
    return [200, boardOut(board)];
  });

  add('DELETE', '/api/boards/([^/]+)', (ctx, boardId) => {
    const { board } = boardAccess(boardId, ctx.user, 'owner');
    const cardIds = new Set(db.cards.filter((c) => c.boardId === board.id).map((c) => c.id));
    db.comments = db.comments.filter((c) => !cardIds.has(c.cardId));
    db.cards = db.cards.filter((c) => c.boardId !== board.id);
    db.columns = db.columns.filter((c) => c.boardId !== board.id);
    db.labels = db.labels.filter((l) => l.boardId !== board.id);
    db.activity = db.activity.filter((a) => a.boardId !== board.id);
    db.boards = db.boards.filter((b) => b !== board);
    return [204];
  });

  // ---- members -----------------------------------------------------------
  add('POST', '/api/boards/([^/]+)/members', ({ body, user }, boardId) => {
    const { board } = boardAccess(boardId, user, 'owner');
    const b = objBody(body);
    if (b.role !== 'editor' && b.role !== 'viewer') throw bad('role must be editor or viewer');
    const username = typeof b.username === 'string' ? b.username.toLowerCase() : '';
    const target = db.users.find((u) => u.username === username);
    if (!target) throw notFound('user');
    if (memberOf(board, target.id)) throw conflict('user is already a member');
    board.members.push({ userId: target.id, role: b.role });
    logActivity(board.id, 'member.added', user.id, { userId: target.id, username: target.username, role: b.role });
    return [201, { userId: target.id, username: target.username, role: b.role }];
  });

  add('PATCH', '/api/boards/([^/]+)/members/([^/]+)', ({ body, user }, boardId, userId) => {
    const { board } = boardAccess(boardId, user, 'owner');
    const b = objBody(body);
    if (b.role !== 'editor' && b.role !== 'viewer') throw bad('role must be editor or viewer');
    const m = memberOf(board, userId);
    if (!m) throw notFound('member');
    if (m.role === 'owner') throw bad('the owner role cannot be changed');
    m.role = b.role;
    return [200, { userId, username: userName(userId), role: m.role }];
  });

  add('DELETE', '/api/boards/([^/]+)/members/([^/]+)', ({ user }, boardId, userId) => {
    const { board, role } = boardAccess(boardId, user, 'viewer');
    if (role !== 'owner' && user.id !== userId) throw forbidden('only the owner can remove other members');
    const m = memberOf(board, userId);
    if (!m) throw notFound('member');
    if (m.role === 'owner') throw bad('the owner cannot be removed');
    board.members = board.members.filter((x) => x !== m);
    for (const card of db.cards) {
      if (card.boardId === board.id) card.assignees = card.assignees.filter((a) => a !== userId);
    }
    return [204];
  });

  // ---- columns -----------------------------------------------------------
  add('POST', '/api/boards/([^/]+)/columns', ({ body, user }, boardId) => {
    const { board } = boardAccess(boardId, user, 'editor');
    const b = objBody(body);
    const name = str(b.name, 'name', 1, 100);
    const wipLimit = parseWip(b.wipLimit);
    const col = { id: uid(), boardId: board.id, name, position: columnsOf(board.id).length, wipLimit };
    db.columns.push(col);
    logActivity(board.id, 'column.created', user.id, { columnId: col.id, name });
    return [201, columnOut(col)];
  });

  add('PATCH', '/api/columns/([^/]+)', ({ body, user }, columnId) => {
    const { column } = columnAccess(columnId, user, 'editor');
    const b = objBody(body);
    const out = {};
    if (b.name !== undefined) out.name = str(b.name, 'name', 1, 100);
    if (b.wipLimit !== undefined) out.wipLimit = parseWip(b.wipLimit);
    if (b.position !== undefined && (!Number.isInteger(b.position) || b.position < 0)) {
      throw bad('position must be a non-negative integer');
    }
    Object.assign(column, out);
    if (b.position !== undefined) {
      const cols = columnsOf(column.boardId).filter((c) => c !== column);
      cols.splice(clamp(b.position, 0, cols.length), 0, column);
      cols.forEach((c, i) => { c.position = i; });
    }
    return [200, columnOut(column)];
  });

  add('DELETE', '/api/columns/([^/]+)', (ctx, columnId) => {
    const { column } = columnAccess(columnId, ctx.user, 'editor');
    const cards = cardsOfColumn(column.id);
    if (cards.length && ctx.query.get('force') !== 'true') {
      throw conflict('column still has cards; use ?force=true to delete them too');
    }
    for (const card of cards) {
      db.comments = db.comments.filter((c) => c.cardId !== card.id);
      logActivity(column.boardId, 'card.deleted', ctx.user.id, { title: card.title, columnId: column.id }, card.id);
    }
    db.cards = db.cards.filter((c) => c.columnId !== column.id);
    db.columns = db.columns.filter((c) => c !== column);
    renumberColumns(column.boardId);
    return [204];
  });

  // ---- cards -------------------------------------------------------------
  add('POST', '/api/columns/([^/]+)/cards', ({ body, user }, columnId) => {
    const { column, board } = columnAccess(columnId, user, 'editor');
    const b = objBody(body);
    const f = cardFields(board, b, true);
    const position = optPosition(b.position);
    if (column.wipLimit != null && cardsOfColumn(column.id).length >= column.wipLimit) {
      throw conflict('column WIP limit reached', 'wip_limit');
    }
    const card = {
      id: uid(), boardId: board.id, columnId: column.id, title: f.title,
      description: f.description ?? '', position: 0,
      assignees: f.assignees ?? [], labels: f.labels ?? [], dueDate: f.dueDate ?? null,
      createdBy: user.id, createdAt: now(), updatedAt: now(),
    };
    db.cards.push(card);
    placeCard(card, column.id, position);
    logActivity(board.id, 'card.created', user.id, { title: card.title, columnId: column.id }, card.id);
    return [201, cardOut(card)];
  });

  add('GET', '/api/cards/([^/]+)', (ctx, cardId) => {
    const { card } = cardAccess(cardId, ctx.user, 'viewer');
    return [200, cardOut(card)];
  });

  add('PATCH', '/api/cards/([^/]+)', ({ body, user }, cardId) => {
    const { card, board } = cardAccess(cardId, user, 'editor');
    const b = objBody(body);
    const f = cardFields(board, b, false);
    Object.assign(card, f, { updatedAt: now() });
    logActivity(board.id, 'card.updated', user.id, { fields: Object.keys(f) }, card.id);
    return [200, cardOut(card)];
  });

  add('DELETE', '/api/cards/([^/]+)', ({ user }, cardId) => {
    const { card, board } = cardAccess(cardId, user, 'editor');
    db.comments = db.comments.filter((c) => c.cardId !== card.id);
    db.cards = db.cards.filter((c) => c !== card);
    renumberCards(card.columnId);
    logActivity(board.id, 'card.deleted', user.id, { title: card.title, columnId: card.columnId }, card.id);
    return [204];
  });

  add('POST', '/api/cards/([^/]+)/move', ({ body, user }, cardId) => {
    const { card, board } = cardAccess(cardId, user, 'editor');
    const b = objBody(body);
    if (typeof b.columnId !== 'string') throw bad('columnId is required');
    const target = db.columns.find((c) => c.id === b.columnId);
    if (!target || target.boardId !== board.id) throw bad('target column must be on the same board');
    const position = optPosition(b.position);
    const fromColumnId = card.columnId;
    const fromPosition = card.position;
    if (target.id !== fromColumnId && target.wipLimit != null
      && cardsOfColumn(target.id).length >= target.wipLimit) {
      throw conflict('target column WIP limit reached', 'wip_limit');
    }
    card.columnId = target.id;
    renumberCards(fromColumnId);
    placeCard(card, target.id, position);
    card.updatedAt = now();
    logActivity(board.id, 'card.moved', user.id, {
      fromColumnId, toColumnId: target.id, fromPosition, toPosition: card.position,
    }, card.id);
    return [200, cardOut(card)];
  });

  // ---- labels ------------------------------------------------------------
  add('POST', '/api/boards/([^/]+)/labels', ({ body, user }, boardId) => {
    const { board } = boardAccess(boardId, user, 'editor');
    const b = objBody(body);
    const name = str(b.name, 'name', 1, 50);
    if (typeof b.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(b.color)) throw bad('color must be #rrggbb');
    if (db.labels.some((l) => l.boardId === board.id && l.name.toLowerCase() === name.toLowerCase())) {
      throw conflict('label name already exists on this board');
    }
    const label = { id: uid(), boardId: board.id, name, color: b.color };
    db.labels.push(label);
    return [201, labelOut(label)];
  });

  add('DELETE', '/api/labels/([^/]+)', ({ user }, labelId) => {
    const label = db.labels.find((l) => l.id === labelId);
    if (!label) throw notFound('label');
    boardAccess(label.boardId, user, 'editor');
    db.labels = db.labels.filter((l) => l !== label);
    for (const card of db.cards) card.labels = card.labels.filter((x) => x !== labelId);
    return [204];
  });

  // ---- comments ----------------------------------------------------------
  add('POST', '/api/cards/([^/]+)/comments', ({ body, user }, cardId) => {
    const { card, board } = cardAccess(cardId, user, 'editor');
    const b = objBody(body);
    if (typeof b.body !== 'string' || b.body.length < 1 || b.body.length > 5000) {
      throw bad('body must be 1-5000 characters');
    }
    const comment = { id: uid(), cardId: card.id, authorId: user.id, body: b.body, createdAt: now() };
    db.comments.push(comment);
    logActivity(board.id, 'comment.added', user.id, { commentId: comment.id }, card.id);
    return [201, commentOut(comment)];
  });

  add('GET', '/api/cards/([^/]+)/comments', ({ user }, cardId) => {
    const { card } = cardAccess(cardId, user, 'viewer');
    return [200, db.comments.filter((c) => c.cardId === card.id).map(commentOut)];
  });

  add('DELETE', '/api/comments/([^/]+)', ({ user }, commentId) => {
    const comment = db.comments.find((c) => c.id === commentId);
    if (!comment) throw notFound('comment');
    const { role } = cardAccess(comment.cardId, user, 'viewer');
    if (comment.authorId !== user.id && role !== 'owner') throw forbidden('only the author or board owner can delete this comment');
    db.comments = db.comments.filter((c) => c !== comment);
    return [204];
  });

  // ---- search & activity -------------------------------------------------
  add('GET', '/api/boards/([^/]+)/cards', (ctx, boardId) => {
    boardAccess(boardId, ctx.user, 'viewer');
    const qp = ctx.query;
    const q = (qp.get('q') || '').toLowerCase();
    const assignee = qp.get('assignee');
    const label = qp.get('label');
    const column = qp.get('column');
    const dueBefore = qp.get('due_before');
    if (dueBefore && !validDate(dueBefore)) throw bad('due_before must be YYYY-MM-DD');
    const colPos = new Map(columnsOf(boardId).map((c) => [c.id, c.position]));
    const result = db.cards
      .filter((c) => c.boardId === boardId)
      .filter((c) => !q || c.title.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
      .filter((c) => !assignee || c.assignees.includes(assignee))
      .filter((c) => !label || c.labels.includes(label))
      .filter((c) => !column || c.columnId === column)
      .filter((c) => !dueBefore || (c.dueDate !== null && c.dueDate < dueBefore))
      .sort((a, b) => (colPos.get(a.columnId) - colPos.get(b.columnId)) || (a.position - b.position));
    return [200, result.map(cardOut)];
  });

  add('GET', '/api/boards/([^/]+)/activity', (ctx, boardId) => {
    boardAccess(boardId, ctx.user, 'viewer');
    const raw = ctx.query.get('limit');
    let limit = 50;
    if (raw !== null) {
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw bad('limit must be a positive integer');
      limit = Number(raw);
    }
    const entries = db.activity.filter((a) => a.boardId === boardId).reverse().slice(0, limit);
    return [200, entries];
  });

  return routes;
}

function findRoute(routes, method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const m = route.re.exec(pathname);
    if (m) return { route, params: m.slice(1).map((p) => decodeURIComponent(p)) };
  }
  return null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { tooLarge = true; return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (tooLarge) reject(new HttpError(413, 'validation', 'request body too large'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function serveStatic(pathname, res) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/static\//, '');
  if (pathname !== '/' && !pathname.startsWith('/static/')) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: 'not_found', message: 'route not found' }));
  }
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: 'not_found', message: 'route not found' }));
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

export function createServer({ dataFile } = {}) {
  const db = loadData(dataFile);
  const sessions = new Map();
  const failures = new Map();
  const routes = buildRoutes(db, sessions, failures);

  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    try {
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        return serveStatic(url.pathname, res);
      }
      const raw = await readBody(req);
      let body;
      if (raw.trim()) {
        try { body = JSON.parse(raw); } catch { throw bad('invalid JSON body'); }
      }
      const match = findRoute(routes, req.method, url.pathname);
      if (!match) throw new HttpError(404, 'not_found', 'route not found');
      let user = null;
      let token = null;
      if (match.route.auth) {
        const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
        token = m ? m[1] : null;
        const userId = token ? sessions.get(token) : undefined;
        user = userId ? db.users.find((u) => u.id === userId) : null;
        if (!user) throw unauthorized('missing, invalid or logged-out token');
      }
      const [status, payload] = await match.route.handler({ body, query: url.searchParams, user, token }, ...match.params);
      if (req.method !== 'GET' && status < 300) saveData(dataFile, db);
      if (status === 204 || payload === undefined) {
        res.writeHead(status);
        return res.end();
      }
      return send(res, status, payload);
    } catch (err) {
      if (err instanceof HttpError) {
        if (!res.headersSent) send(res, err.status, { error: err.code, message: err.message });
        return;
      }
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: 'internal', message: 'internal server error' });
    }
  });
}
