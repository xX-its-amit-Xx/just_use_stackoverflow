// kanban-s3: JSON REST API + static single-page UI over node:http.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(HERE, 'static');
const ROLE_LEVEL = { viewer: 1, editor: 2, owner: 3 };
const DEFAULT_COLUMNS = ['To Do', 'In Progress', 'Done'];
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const MAX_BODY = 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

// ---------- errors & small helpers ----------

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}
const bad = (msg) => new HttpError(400, 'validation', msg);
const notFound = (what) => new HttpError(404, 'not_found', `${what} not found`);
const forbidden = (msg = 'forbidden') => new HttpError(403, 'forbidden', msg);
const conflict = (msg) => new HttpError(409, 'conflict', msg);

const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

function bodyObj(v) {
  if (!isObj(v)) throw bad('body must be a JSON object');
  return v;
}

function text(v, min, max, field) {
  if (typeof v !== 'string') throw bad(`${field} must be a string`);
  const t = v.trim();
  if (t.length < min || t.length > max) throw bad(`${field} must be ${min}-${max} characters`);
  return t;
}

function optDescription(v) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string' || v.length > 10000) throw bad('description must be a string up to 10000 characters');
  return v;
}

function parseDate(v) {
  if (v === null) return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad('dueDate must be YYYY-MM-DD or null');
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw bad('dueDate is not a valid date');
  return v;
}

function parseWip(v) {
  if (v === null) return null;
  if (!Number.isInteger(v) || v < 1) throw bad('wipLimit must be a positive integer or null');
  return v;
}

function parsePosition(v) {
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v)) throw bad('position must be an integer');
  return v;
}

function idArray(v, field) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) throw bad(`${field} must be an array of ids`);
  return [...new Set(v)];
}

function parseUsername(v) {
  if (typeof v !== 'string') throw bad('username must be a string');
  const u = v.trim().toLowerCase();
  if (!/^[a-z0-9_]{3,32}$/.test(u)) throw bad('username must be 3-32 chars of [a-z0-9_]');
  return u;
}

// ---------- password hashing ----------

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(pw, stored) {
  const [, saltHex, hashHex] = String(stored).split('$');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

// ---------- store helpers ----------

function emptyDb() {
  return { users: [], boards: [], members: [], columns: [], cards: [], labels: [], comments: [], activity: [] };
}

const userById = (db, id) => db.users.find((u) => u.id === id);
const boardOf = (db, id) => db.boards.find((b) => b.id === id);
const publicUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName });

function roleOf(db, boardId, userId) {
  const m = db.members.find((x) => x.boardId === boardId && x.userId === userId);
  return m ? m.role : null;
}

function requireBoard(db, user, boardId, min) {
  const board = boardOf(db, boardId);
  if (!board) throw notFound('board');
  const role = roleOf(db, boardId, user.id);
  if (!role) throw forbidden('not a member of this board');
  if (ROLE_LEVEL[role] < ROLE_LEVEL[min]) throw forbidden(`requires ${min} role`);
  return { board, role };
}

const columnsOf = (db, boardId) =>
  db.columns.filter((c) => c.boardId === boardId).sort((a, b) => a.position - b.position);
const cardsOf = (db, columnId) =>
  db.cards.filter((c) => c.columnId === columnId).sort((a, b) => a.position - b.position);

function reindex(list) {
  list.forEach((x, i) => {
    x.position = i;
  });
}

function addActivity(db, boardId, type, actorId, details = {}, cardId) {
  const entry = { id: newId(), boardId, type, actorId };
  if (cardId !== undefined) entry.cardId = cardId;
  entry.at = now();
  entry.details = details;
  db.activity.push(entry);
}

function deleteCard(db, card) {
  db.comments = db.comments.filter((c) => c.cardId !== card.id);
  db.cards = db.cards.filter((c) => c.id !== card.id);
  reindex(cardsOf(db, card.columnId));
}

const cardView = (c) => ({ ...c, assignees: [...c.assignees], labels: [...c.labels] });
const labelView = (l) => ({ id: l.id, boardId: l.boardId, name: l.name, color: l.color });
const commentView = (c) => ({ id: c.id, cardId: c.cardId, authorId: c.authorId, body: c.body, createdAt: c.createdAt });
const columnView = (db, col) => ({
  id: col.id,
  boardId: col.boardId,
  name: col.name,
  position: col.position,
  wipLimit: col.wipLimit,
  cards: cardsOf(db, col.id).map(cardView),
});

function boardView(db, board) {
  return {
    id: board.id,
    name: board.name,
    description: board.description,
    ownerId: board.ownerId,
    createdAt: board.createdAt,
    members: db.members
      .filter((m) => m.boardId === board.id)
      .map((m) => ({ userId: m.userId, username: userById(db, m.userId)?.username ?? null, role: m.role })),
    labels: db.labels.filter((l) => l.boardId === board.id).map(labelView),
    columns: columnsOf(db, board.id).map((c) => columnView(db, c)),
  };
}

// Validates card attributes that are present in `b`; returns the fields to apply.
function cardFields(db, boardId, b) {
  const out = {};
  if (b.title !== undefined) out.title = text(b.title, 1, 200, 'title');
  if (b.description !== undefined) out.description = optDescription(b.description);
  if (b.assignees !== undefined) {
    out.assignees = idArray(b.assignees, 'assignees');
    for (const uid of out.assignees) {
      if (!roleOf(db, boardId, uid)) throw bad('assignees must be board members');
    }
  }
  if (b.labels !== undefined) {
    out.labels = idArray(b.labels, 'labels');
    for (const lid of out.labels) {
      if (!db.labels.some((l) => l.id === lid && l.boardId === boardId)) throw bad('labels must belong to this board');
    }
  }
  if (b.dueDate !== undefined) out.dueDate = parseDate(b.dueDate);
  return out;
}

// ---------- routing ----------

const ROUTES = [];
function route(method, pattern, auth, handler) {
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$');
  ROUTES.push({ method, re, auth, handler });
}

// ---- auth ----

route('POST', '/api/auth/register', false, (ctx) => {
  const b = bodyObj(ctx.json());
  const username = parseUsername(b.username);
  if (typeof b.password !== 'string' || b.password.length < 8) throw bad('password must be at least 8 characters');
  const displayName = b.displayName === undefined || b.displayName === null
    ? username
    : text(b.displayName, 1, 100, 'displayName');
  if (ctx.db.users.some((u) => u.username === username)) throw conflict('username already taken');
  const user = {
    id: newId(),
    username,
    displayName,
    passwordHash: hashPassword(b.password),
    createdAt: now(),
  };
  ctx.db.users.push(user);
  return { status: 201, body: { user: publicUser(user) } };
});

route('POST', '/api/auth/login', false, (ctx) => {
  const b = bodyObj(ctx.json());
  if (typeof b.username !== 'string' || typeof b.password !== 'string') throw bad('username and password required');
  const username = b.username.trim().toLowerCase();
  const t = Date.now();
  const recent = (ctx.failures.get(username) || []).filter((x) => t - x < LOGIN_WINDOW_MS);
  ctx.failures.set(username, recent);
  if (recent.length >= LOGIN_MAX_FAILURES) {
    throw new HttpError(429, 'rate_limited', 'too many failed login attempts; try again later');
  }
  const user = ctx.db.users.find((u) => u.username === username);
  if (!user || !verifyPassword(b.password, user.passwordHash)) {
    recent.push(t);
    throw new HttpError(401, 'unauthorized', 'invalid username or password');
  }
  ctx.failures.delete(username);
  const token = crypto.randomBytes(32).toString('hex');
  ctx.tokens.set(token, user.id);
  return { status: 200, body: { token, user: publicUser(user) } };
});

route('POST', '/api/auth/logout', true, (ctx) => {
  ctx.tokens.delete(ctx.token);
  return { status: 204 };
});

route('GET', '/api/auth/me', true, (ctx) => ({ status: 200, body: { user: publicUser(ctx.user) } }));

// ---- boards ----

route('POST', '/api/boards', true, (ctx) => {
  const { db, user } = ctx;
  const b = bodyObj(ctx.json());
  const name = text(b.name, 1, 100, 'name');
  const description = optDescription(b.description);
  let cols = b.columns === undefined || b.columns === null ? DEFAULT_COLUMNS : b.columns;
  if (!Array.isArray(cols)) throw bad('columns must be an array of names');
  cols = cols.map((c) => text(c, 1, 100, 'column name'));
  const board = { id: newId(), name, description, ownerId: user.id, createdAt: now() };
  db.boards.push(board);
  db.members.push({ boardId: board.id, userId: user.id, role: 'owner' });
  cols.forEach((n, i) => db.columns.push({ id: newId(), boardId: board.id, name: n, position: i, wipLimit: null }));
  addActivity(db, board.id, 'board.created', user.id, { name });
  return { status: 201, body: boardView(db, board) };
});

route('GET', '/api/boards', true, (ctx) => {
  const { db, user } = ctx;
  const body = db.members
    .filter((m) => m.userId === user.id)
    .map((m) => ({ id: m.boardId, name: boardOf(db, m.boardId)?.name ?? null, role: m.role }))
    .filter((x) => x.name !== null);
  return { status: 200, body };
});

route('GET', '/api/boards/:id', true, (ctx) => {
  const { board } = requireBoard(ctx.db, ctx.user, ctx.params.id, 'viewer');
  return { status: 200, body: boardView(ctx.db, board) };
});

route('PATCH', '/api/boards/:id', true, (ctx) => {
  const { board } = requireBoard(ctx.db, ctx.user, ctx.params.id, 'owner');
  const b = bodyObj(ctx.json());
  const name = b.name === undefined ? undefined : text(b.name, 1, 100, 'name');
  const description = b.description === undefined ? undefined : optDescription(b.description);
  if (name !== undefined) board.name = name;
  if (description !== undefined) board.description = description;
  return { status: 200, body: boardView(ctx.db, board) };
});

route('DELETE', '/api/boards/:id', true, (ctx) => {
  const { db } = ctx;
  const { board } = requireBoard(db, ctx.user, ctx.params.id, 'owner');
  const id = board.id;
  db.boards = db.boards.filter((b) => b.id !== id);
  db.members = db.members.filter((m) => m.boardId !== id);
  db.columns = db.columns.filter((c) => c.boardId !== id);
  db.cards = db.cards.filter((c) => c.boardId !== id);
  db.labels = db.labels.filter((l) => l.boardId !== id);
  db.comments = db.comments.filter((c) => c.boardId !== id);
  db.activity = db.activity.filter((a) => a.boardId !== id);
  return { status: 204 };
});

// ---- members ----

route('POST', '/api/boards/:id/members', true, (ctx) => {
  const { db, user } = ctx;
  const { board } = requireBoard(db, user, ctx.params.id, 'owner');
  const b = bodyObj(ctx.json());
  const username = parseUsername(b.username);
  if (b.role !== 'editor' && b.role !== 'viewer') throw bad('role must be editor or viewer');
  const target = db.users.find((u) => u.username === username);
  if (!target) throw notFound('user');
  if (roleOf(db, board.id, target.id)) throw conflict('already a member');
  db.members.push({ boardId: board.id, userId: target.id, role: b.role });
  addActivity(db, board.id, 'member.added', user.id, { userId: target.id, role: b.role });
  return { status: 201, body: { userId: target.id, username: target.username, role: b.role } };
});

route('PATCH', '/api/boards/:id/members/:userId', true, (ctx) => {
  const { db } = ctx;
  const { board } = requireBoard(db, ctx.user, ctx.params.id, 'owner');
  const b = bodyObj(ctx.json());
  if (b.role !== 'editor' && b.role !== 'viewer') throw bad('role must be editor or viewer');
  const m = db.members.find((x) => x.boardId === board.id && x.userId === ctx.params.userId);
  if (!m) throw notFound('member');
  if (m.role === 'owner') throw bad('cannot change the owner role');
  m.role = b.role;
  return { status: 200, body: { userId: m.userId, username: userById(db, m.userId)?.username ?? null, role: m.role } };
});

route('DELETE', '/api/boards/:id/members/:userId', true, (ctx) => {
  const { db, user } = ctx;
  const board = boardOf(db, ctx.params.id);
  if (!board) throw notFound('board');
  const myRole = roleOf(db, board.id, user.id);
  if (!myRole) throw forbidden('not a member of this board');
  if (myRole !== 'owner' && user.id !== ctx.params.userId) throw forbidden('requires owner role');
  const m = db.members.find((x) => x.boardId === board.id && x.userId === ctx.params.userId);
  if (!m) throw notFound('member');
  if (m.role === 'owner') throw bad('cannot remove the board owner');
  db.members = db.members.filter((x) => x !== m);
  for (const c of db.cards) {
    if (c.boardId === board.id) c.assignees = c.assignees.filter((a) => a !== m.userId);
  }
  return { status: 204 };
});

// ---- columns ----

route('POST', '/api/boards/:id/columns', true, (ctx) => {
  const { db, user } = ctx;
  const { board } = requireBoard(db, user, ctx.params.id, 'editor');
  const b = bodyObj(ctx.json());
  const name = text(b.name, 1, 100, 'name');
  const wipLimit = b.wipLimit === undefined ? null : parseWip(b.wipLimit);
  const position = columnsOf(db, board.id).length;
  const col = { id: newId(), boardId: board.id, name, position, wipLimit };
  db.columns.push(col);
  addActivity(db, board.id, 'column.created', user.id, { columnId: col.id, name });
  return { status: 201, body: columnView(db, col) };
});

route('PATCH', '/api/columns/:id', true, (ctx) => {
  const { db, user } = ctx;
  const col = db.columns.find((c) => c.id === ctx.params.id);
  if (!col) throw notFound('column');
  requireBoard(db, user, col.boardId, 'editor');
  const b = bodyObj(ctx.json());
  const name = b.name === undefined ? undefined : text(b.name, 1, 100, 'name');
  const wip = b.wipLimit === undefined ? undefined : parseWip(b.wipLimit);
  const pos = b.position === undefined ? undefined : parsePosition(b.position);
  if (name !== undefined) col.name = name;
  if (wip !== undefined) col.wipLimit = wip;
  if (pos !== undefined) {
    const others = columnsOf(db, col.boardId).filter((c) => c.id !== col.id);
    others.splice(clamp(pos, 0, others.length), 0, col);
    reindex(others);
  }
  return { status: 200, body: columnView(db, col) };
});

route('DELETE', '/api/columns/:id', true, (ctx) => {
  const { db, user } = ctx;
  const col = db.columns.find((c) => c.id === ctx.params.id);
  if (!col) throw notFound('column');
  requireBoard(db, user, col.boardId, 'editor');
  const cards = cardsOf(db, col.id);
  if (cards.length > 0 && ctx.query.get('force') !== 'true') {
    throw conflict('column still contains cards; use ?force=true to delete them');
  }
  for (const card of cards) {
    deleteCard(db, card);
    addActivity(db, col.boardId, 'card.deleted', user.id, { columnId: col.id }, card.id);
  }
  db.columns = db.columns.filter((c) => c.id !== col.id);
  reindex(columnsOf(db, col.boardId));
  return { status: 204 };
});

// ---- cards ----

route('POST', '/api/columns/:id/cards', true, (ctx) => {
  const { db, user } = ctx;
  const col = db.columns.find((c) => c.id === ctx.params.id);
  if (!col) throw notFound('column');
  requireBoard(db, user, col.boardId, 'editor');
  const b = bodyObj(ctx.json());
  if (b.title === undefined) throw bad('title is required');
  const fields = cardFields(db, col.boardId, b);
  const pos = parsePosition(b.position);
  const existing = cardsOf(db, col.id);
  if (col.wipLimit && existing.length >= col.wipLimit) {
    throw new HttpError(409, 'wip_limit', 'column WIP limit reached');
  }
  const ts = now();
  const card = {
    id: newId(),
    boardId: col.boardId,
    columnId: col.id,
    title: fields.title,
    description: fields.description ?? '',
    position: 0,
    assignees: fields.assignees ?? [],
    labels: fields.labels ?? [],
    dueDate: fields.dueDate ?? null,
    createdBy: user.id,
    createdAt: ts,
    updatedAt: ts,
  };
  db.cards.push(card);
  const index = pos === null ? existing.length : clamp(pos, 0, existing.length);
  existing.splice(index, 0, card);
  reindex(existing);
  addActivity(db, col.boardId, 'card.created', user.id, { columnId: col.id, title: card.title }, card.id);
  return { status: 201, body: cardView(card) };
});

route('GET', '/api/cards/:id', true, (ctx) => {
  const card = ctx.db.cards.find((c) => c.id === ctx.params.id);
  if (!card) throw notFound('card');
  requireBoard(ctx.db, ctx.user, card.boardId, 'viewer');
  return { status: 200, body: cardView(card) };
});

route('PATCH', '/api/cards/:id', true, (ctx) => {
  const { db, user } = ctx;
  const card = db.cards.find((c) => c.id === ctx.params.id);
  if (!card) throw notFound('card');
  requireBoard(db, user, card.boardId, 'editor');
  const b = bodyObj(ctx.json());
  const fields = cardFields(db, card.boardId, b);
  Object.assign(card, fields);
  card.updatedAt = now();
  addActivity(db, card.boardId, 'card.updated', user.id, { fields: Object.keys(fields) }, card.id);
  return { status: 200, body: cardView(card) };
});

route('DELETE', '/api/cards/:id', true, (ctx) => {
  const { db, user } = ctx;
  const card = db.cards.find((c) => c.id === ctx.params.id);
  if (!card) throw notFound('card');
  requireBoard(db, user, card.boardId, 'editor');
  deleteCard(db, card);
  addActivity(db, card.boardId, 'card.deleted', user.id, { columnId: card.columnId }, card.id);
  return { status: 204 };
});

route('POST', '/api/cards/:id/move', true, (ctx) => {
  const { db, user } = ctx;
  const card = db.cards.find((c) => c.id === ctx.params.id);
  if (!card) throw notFound('card');
  requireBoard(db, user, card.boardId, 'editor');
  const b = bodyObj(ctx.json());
  if (typeof b.columnId !== 'string') throw bad('columnId is required');
  const target = db.columns.find((c) => c.id === b.columnId);
  if (!target || target.boardId !== card.boardId) throw bad('target column must be on the same board');
  const pos = parsePosition(b.position);
  const fromId = card.columnId;
  const others = cardsOf(db, target.id).filter((c) => c.id !== card.id);
  if (target.id !== fromId && target.wipLimit && others.length >= target.wipLimit) {
    throw new HttpError(409, 'wip_limit', 'target column WIP limit reached');
  }
  const index = pos === null ? others.length : clamp(pos, 0, others.length);
  card.columnId = target.id;
  others.splice(index, 0, card);
  reindex(others);
  if (fromId !== target.id) reindex(cardsOf(db, fromId));
  addActivity(db, card.boardId, 'card.moved', user.id,
    { fromColumnId: fromId, toColumnId: target.id, position: card.position }, card.id);
  return { status: 200, body: cardView(card) };
});

// ---- labels ----

route('POST', '/api/boards/:id/labels', true, (ctx) => {
  const { db, user } = ctx;
  const { board } = requireBoard(db, user, ctx.params.id, 'editor');
  const b = bodyObj(ctx.json());
  const name = text(b.name, 1, 50, 'name');
  if (typeof b.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(b.color)) throw bad('color must be #rrggbb');
  if (db.labels.some((l) => l.boardId === board.id && l.name.toLowerCase() === name.toLowerCase())) {
    throw conflict('label name already exists on this board');
  }
  const label = { id: newId(), boardId: board.id, name, color: b.color };
  db.labels.push(label);
  return { status: 201, body: labelView(label) };
});

route('DELETE', '/api/labels/:id', true, (ctx) => {
  const { db, user } = ctx;
  const label = db.labels.find((l) => l.id === ctx.params.id);
  if (!label) throw notFound('label');
  requireBoard(db, user, label.boardId, 'editor');
  db.labels = db.labels.filter((l) => l.id !== label.id);
  for (const c of db.cards) {
    if (c.labels.includes(label.id)) c.labels = c.labels.filter((x) => x !== label.id);
  }
  return { status: 204 };
});

// ---- comments ----

route('POST', '/api/cards/:id/comments', true, (ctx) => {
  const { db, user } = ctx;
  const card = db.cards.find((c) => c.id === ctx.params.id);
  if (!card) throw notFound('card');
  requireBoard(db, user, card.boardId, 'editor');
  const b = bodyObj(ctx.json());
  const body = text(b.body, 1, 5000, 'body');
  const comment = { id: newId(), cardId: card.id, boardId: card.boardId, authorId: user.id, body, createdAt: now() };
  db.comments.push(comment);
  addActivity(db, card.boardId, 'comment.added', user.id, { commentId: comment.id }, card.id);
  return { status: 201, body: commentView(comment) };
});

route('GET', '/api/cards/:id/comments', true, (ctx) => {
  const card = ctx.db.cards.find((c) => c.id === ctx.params.id);
  if (!card) throw notFound('card');
  requireBoard(ctx.db, ctx.user, card.boardId, 'viewer');
  const list = ctx.db.comments.filter((c) => c.cardId === card.id).map(commentView);
  return { status: 200, body: list };
});

route('DELETE', '/api/comments/:id', true, (ctx) => {
  const { db, user } = ctx;
  const comment = db.comments.find((c) => c.id === ctx.params.id);
  if (!comment) throw notFound('comment');
  const { role } = requireBoard(db, user, comment.boardId, 'viewer');
  if (comment.authorId !== user.id && role !== 'owner') throw forbidden('only the author or board owner may delete');
  db.comments = db.comments.filter((c) => c !== comment);
  return { status: 204 };
});

// ---- search & activity ----

route('GET', '/api/boards/:id/cards', true, (ctx) => {
  const { db, user, query } = ctx;
  const { board } = requireBoard(db, user, ctx.params.id, 'viewer');
  const q = query.get('q');
  const assignee = query.get('assignee');
  const label = query.get('label');
  const column = query.get('column');
  const dueBefore = query.get('due_before');
  if (dueBefore) parseDate(dueBefore);
  const needle = q ? q.toLowerCase() : '';
  const colPos = new Map(columnsOf(db, board.id).map((c) => [c.id, c.position]));
  const result = db.cards
    .filter((c) => c.boardId === board.id)
    .filter((c) => !needle || c.title.toLowerCase().includes(needle) || c.description.toLowerCase().includes(needle))
    .filter((c) => !assignee || c.assignees.includes(assignee))
    .filter((c) => !label || c.labels.includes(label))
    .filter((c) => !column || c.columnId === column)
    .filter((c) => !dueBefore || (c.dueDate !== null && c.dueDate < dueBefore))
    .sort((a, b) => (colPos.get(a.columnId) - colPos.get(b.columnId)) || (a.position - b.position));
  return { status: 200, body: result.map(cardView) };
});

route('GET', '/api/boards/:id/activity', true, (ctx) => {
  const { db, user, query } = ctx;
  requireBoard(db, user, ctx.params.id, 'viewer');
  const raw = query.get('limit');
  let limit = 50;
  if (raw !== null) {
    if (!/^\d+$/.test(raw) || Number(raw) < 1) throw bad('limit must be a positive integer');
    limit = Number(raw);
  }
  const list = db.activity.filter((a) => a.boardId === ctx.params.id).reverse().slice(0, limit);
  return { status: 200, body: list };
});

// ---------- HTTP plumbing ----------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'too_large', 'request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseJson(raw) {
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw bad('invalid JSON body');
  }
}

function sendJson(res, status, body) {
  if (status === 204 || body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

function sendError(res, err) {
  sendJson(res, err.status, { error: err.code, message: err.message });
}

function serveStatic(pathname, res) {
  let rel = pathname === '/' ? 'index.html' : pathname.slice('/static/'.length);
  try {
    rel = decodeURIComponent(rel);
  } catch {
    throw notFound('file');
  }
  const file = path.resolve(STATIC_DIR, rel);
  if (!file.startsWith(STATIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw notFound('file');
  }
  const data = fs.readFileSync(file);
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'content-length': data.length,
  });
  res.end(data);
}

function loadDb(file) {
  if (!file || !fs.existsSync(file)) return emptyDb();
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return emptyDb();
  return { ...emptyDb(), ...JSON.parse(raw) };
}

function saveDb(file, db) {
  if (!file) return;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, file);
}

export function createServer({ dataFile } = {}) {
  if (dataFile) fs.mkdirSync(path.dirname(path.resolve(dataFile)), { recursive: true });
  const db = loadDb(dataFile);
  const tokens = new Map(); // token -> userId (sessions are not persisted)
  const failures = new Map(); // username -> [timestamps of failed logins]

  async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;
      if (req.method === 'GET' && (pathname === '/' || pathname.startsWith('/static/'))) {
        serveStatic(pathname, res);
        return;
      }
      let matched = null;
      for (const r of ROUTES) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(pathname);
        if (m) {
          matched = { route: r, params: { ...m.groups } };
          break;
        }
      }
      if (!matched) throw notFound('route');

      const raw = await readBody(req);
      const ctx = { db, tokens, failures, params: matched.params, query: url.searchParams, user: null, token: null, json: () => parseJson(raw) };
      if (matched.route.auth) {
        const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
        const uid = m ? tokens.get(m[1]) : undefined;
        const user = uid ? userById(db, uid) : undefined;
        if (!user) throw new HttpError(401, 'unauthorized', 'missing or invalid token');
        ctx.user = user;
        ctx.token = m[1];
      }
      const result = await matched.route.handler(ctx);
      if (req.method !== 'GET' && result.status < 400) saveDb(dataFile, db);
      sendJson(res, result.status, result.body);
    } catch (err) {
      if (err instanceof HttpError) {
        sendError(res, err);
      } else {
        console.error(err);
        sendError(res, new HttpError(500, 'internal', 'internal server error'));
      }
    }
  }

  return http.createServer((req, res) => {
    handle(req, res);
  });
}
