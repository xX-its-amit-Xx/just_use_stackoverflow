import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scryptSync, randomBytes, timingSafeEqual, randomUUID } from 'node:crypto';
import { Router } from './router.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---- password hashing -------------------------------------------------------
// Adapted from Stack Overflow answer https://stackoverflow.com/a/67038052
// (CC BY-SA 4.0) to "Password hashing in nodejs using built-in crypto";
// converted from async TypeScript class to sync functions.
function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const buf = scryptSync(password, salt, 64);
  return `${buf.toString('hex')}.${salt}`;
}
function comparePassword(stored, supplied) {
  const [hashed, salt] = String(stored).split('.');
  if (!hashed || !salt) return false;
  const hashedBuf = Buffer.from(hashed, 'hex');
  const suppliedBuf = scryptSync(supplied, salt, 64);
  return hashedBuf.length === suppliedBuf.length && timingSafeEqual(hashedBuf, suppliedBuf);
}

// ---- helpers ----------------------------------------------------------------
class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}
const bad = (msg) => new HttpError(400, 'validation', msg);
const notFound = (msg = 'Not found') => new HttpError(404, 'not_found', msg);
const forbidden = (msg = 'Forbidden') => new HttpError(403, 'forbidden', msg);
const conflict = (msg, code = 'conflict') => new HttpError(409, code, msg);

const now = () => new Date().toISOString();
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function validDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
function str(v, name, min, max, { optional = false } = {}) {
  if (v === undefined && optional) return undefined;
  if (typeof v !== 'string') throw bad(`${name} must be a string`);
  const t = v.trim();
  if (t.length < min || v.length > max) throw bad(`${name} must be ${min}-${max} characters`);
  return v;
}
function wip(v) {
  if (v === null) return null;
  if (!Number.isInteger(v) || v < 1) throw bad('wipLimit must be a positive integer or null');
  return v;
}
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function emptyData() {
  return { users: [], boards: [], columns: [], cards: [], labels: [], comments: [], activity: [] };
}

export function createServer({ dataFile } = {}) {
  let data = emptyData();
  if (dataFile && fs.existsSync(dataFile)) {
    try {
      const raw = fs.readFileSync(dataFile, 'utf8');
      if (raw.trim()) data = { ...emptyData(), ...JSON.parse(raw) };
    } catch (e) {
      throw new Error(`Cannot load data file ${dataFile}: ${e.message}`);
    }
  }
  function save() {
    if (!dataFile) return;
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, dataFile);
  }

  const sessions = new Map(); // token -> userId
  const loginFailures = new Map(); // username -> [timestamps]
  const WINDOW = 15 * 60 * 1000;

  // ---- lookups ----
  const userById = (id) => data.users.find((u) => u.id === id);
  const publicUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName });
  const boardById = (id) => data.boards.find((b) => b.id === id);
  const columnById = (id) => data.columns.find((c) => c.id === id);
  const cardById = (id) => data.cards.find((c) => c.id === id);
  const labelById = (id) => data.labels.find((l) => l.id === id);
  const commentById = (id) => data.comments.find((c) => c.id === id);
  const boardColumns = (boardId) =>
    data.columns.filter((c) => c.boardId === boardId).sort((a, b) => a.position - b.position);
  const columnCards = (columnId) =>
    data.cards.filter((c) => c.columnId === columnId).sort((a, b) => a.position - b.position);
  const roleOf = (board, userId) => board.members.find((m) => m.userId === userId)?.role;

  function access(board, user, minRole) {
    const role = roleOf(board, user.id);
    if (!role) throw forbidden('Not a member of this board');
    if (ROLE_RANK[role] < ROLE_RANK[minRole]) throw forbidden(`Requires ${minRole} role`);
    return role;
  }
  function getBoard(id, user, minRole) {
    const b = boardById(id);
    if (!b) throw notFound('Board not found');
    access(b, user, minRole);
    return b;
  }
  function getColumn(id, user, minRole) {
    const c = columnById(id);
    if (!c) throw notFound('Column not found');
    const b = boardById(c.boardId);
    if (!b) throw notFound('Column not found');
    access(b, user, minRole);
    return { column: c, board: b };
  }
  function getCard(id, user, minRole) {
    const c = cardById(id);
    if (!c) throw notFound('Card not found');
    const b = boardById(c.boardId);
    if (!b) throw notFound('Card not found');
    access(b, user, minRole);
    return { card: c, board: b };
  }

  function log(boardId, type, actorId, details = {}, cardId) {
    const e = { id: randomUUID(), boardId, type, actorId, at: now(), details };
    if (cardId) e.cardId = cardId;
    data.activity.push(e);
  }

  function memberView(board, m) {
    return { userId: m.userId, username: userById(m.userId)?.username ?? null, role: m.role };
  }
  function boardView(b) {
    return {
      id: b.id,
      name: b.name,
      description: b.description,
      ownerId: b.ownerId,
      createdAt: b.createdAt,
      members: b.members.map((m) => memberView(b, m)),
      labels: data.labels.filter((l) => l.boardId === b.id),
      columns: boardColumns(b.id).map((c) => ({ ...c, cards: columnCards(c.id) })),
    };
  }
  const columnView = (c) => ({ ...c });

  function compact(list) {
    list.forEach((x, i) => (x.position = i));
  }
  function compactColumn(columnId) {
    compact(columnCards(columnId));
  }

  function validateAssignees(board, v) {
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw bad('assignees must be an array of user ids');
    for (const id of v) if (!roleOf(board, id)) throw bad(`Assignee ${id} is not a board member`);
    return [...new Set(v)];
  }
  function validateLabels(board, v) {
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw bad('labels must be an array of label ids');
    for (const id of v) {
      const l = labelById(id);
      if (!l || l.boardId !== board.id) throw bad(`Label ${id} does not belong to this board`);
    }
    return [...new Set(v)];
  }
  function validateDue(v) {
    if (v === null) return null;
    if (!validDate(v)) throw bad('dueDate must be YYYY-MM-DD or null');
    return v;
  }
  function validatePosition(v) {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw bad('position must be an integer');
    return Math.trunc(v);
  }

  function deleteCardsWhere(pred) {
    const ids = new Set(data.cards.filter(pred).map((c) => c.id));
    data.cards = data.cards.filter((c) => !ids.has(c.id));
    data.comments = data.comments.filter((c) => !ids.has(c.cardId));
    return ids;
  }

  // ---- routes ----
  const r = new Router();

  // auth
  r.post('/api/auth/register', ({ body }) => {
    const { username, password, displayName } = body;
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_]{3,32}$/.test(username)) {
      throw bad('username must be 3-32 characters of [a-z0-9_]');
    }
    if (typeof password !== 'string' || password.length < 8) throw bad('password must be at least 8 characters');
    if (displayName !== undefined && displayName !== null && (typeof displayName !== 'string' || displayName.length > 100)) {
      throw bad('displayName must be a string');
    }
    const uname = username.toLowerCase();
    if (data.users.some((u) => u.username === uname)) throw conflict('Username already taken');
    const user = {
      id: randomUUID(),
      username: uname,
      displayName: displayName && displayName.trim() ? displayName : uname,
      passwordHash: hashPassword(password),
      createdAt: now(),
    };
    data.users.push(user);
    save();
    return [201, { user: publicUser(user) }];
  }, { public: true });

  r.post('/api/auth/login', ({ body }) => {
    const { username, password } = body;
    if (typeof username !== 'string' || typeof password !== 'string') throw bad('username and password required');
    const uname = username.toLowerCase();
    const t = Date.now();
    const fails = (loginFailures.get(uname) || []).filter((x) => t - x < WINDOW);
    loginFailures.set(uname, fails);
    if (fails.length >= 5) throw new HttpError(429, 'rate_limited', 'Too many failed login attempts');
    const user = data.users.find((u) => u.username === uname);
    if (!user || !comparePassword(user.passwordHash, password)) {
      fails.push(t);
      throw new HttpError(401, 'unauthenticated', 'Invalid username or password');
    }
    const token = randomBytes(32).toString('hex');
    sessions.set(token, user.id);
    return [200, { token, user: publicUser(user) }];
  }, { public: true });

  r.post('/api/auth/logout', ({ token }) => {
    sessions.delete(token);
    return [204];
  });
  r.get('/api/auth/me', ({ user }) => [200, { user: publicUser(user) }]);

  // boards
  r.post('/api/boards', ({ user, body }) => {
    const name = str(body.name, 'name', 1, 100);
    let description = '';
    if (body.description !== undefined && body.description !== null) {
      if (typeof body.description !== 'string') throw bad('description must be a string');
      description = body.description;
    }
    let cols = ['To Do', 'In Progress', 'Done'];
    if (body.columns !== undefined) {
      if (!Array.isArray(body.columns)) throw bad('columns must be an array of names');
      cols = body.columns.map((c) => str(c, 'column name', 1, 100));
    }
    const board = {
      id: randomUUID(),
      name,
      description,
      ownerId: user.id,
      createdAt: now(),
      members: [{ userId: user.id, role: 'owner' }],
    };
    data.boards.push(board);
    log(board.id, 'board.created', user.id, { name });
    cols.forEach((cn, i) => {
      const col = { id: randomUUID(), boardId: board.id, name: cn, position: i, wipLimit: null };
      data.columns.push(col);
      log(board.id, 'column.created', user.id, { columnId: col.id, name: cn });
    });
    save();
    return [201, boardView(board)];
  });

  r.get('/api/boards', ({ user }) => [
    200,
    data.boards
      .filter((b) => roleOf(b, user.id))
      .map((b) => ({ id: b.id, name: b.name, role: roleOf(b, user.id) })),
  ]);

  r.get('/api/boards/:id', ({ user, params }) => [200, boardView(getBoard(params.id, user, 'viewer'))]);

  r.patch('/api/boards/:id', ({ user, params, body }) => {
    const b = getBoard(params.id, user, 'owner');
    const name = body.name !== undefined ? str(body.name, 'name', 1, 100) : undefined;
    if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') {
      throw bad('description must be a string');
    }
    if (name !== undefined) b.name = name;
    if (body.description !== undefined) b.description = body.description ?? '';
    log(b.id, 'board.updated', user.id, { name: b.name });
    save();
    return [200, boardView(b)];
  });

  r.delete('/api/boards/:id', ({ user, params }) => {
    const b = getBoard(params.id, user, 'owner');
    deleteCardsWhere((c) => c.boardId === b.id);
    data.columns = data.columns.filter((c) => c.boardId !== b.id);
    data.labels = data.labels.filter((l) => l.boardId !== b.id);
    data.activity = data.activity.filter((a) => a.boardId !== b.id);
    data.boards = data.boards.filter((x) => x.id !== b.id);
    save();
    return [204];
  });

  // members
  r.get('/api/boards/:id/members', ({ user, params }) => {
    const b = getBoard(params.id, user, 'viewer');
    return [200, b.members.map((m) => memberView(b, m))];
  });

  r.post('/api/boards/:id/members', ({ user, params, body }) => {
    const b = getBoard(params.id, user, 'owner');
    if (typeof body.username !== 'string' || !body.username) throw bad('username required');
    if (body.role !== 'editor' && body.role !== 'viewer') throw bad('role must be editor or viewer');
    const target = data.users.find((u) => u.username === body.username.toLowerCase());
    if (!target) throw notFound('User not found');
    if (roleOf(b, target.id)) throw conflict('User is already a member');
    const m = { userId: target.id, role: body.role };
    b.members.push(m);
    log(b.id, 'member.added', user.id, { userId: target.id, username: target.username, role: m.role });
    save();
    return [201, memberView(b, m)];
  });

  r.patch('/api/boards/:id/members/:userId', ({ user, params, body }) => {
    const b = getBoard(params.id, user, 'owner');
    const m = b.members.find((x) => x.userId === params.userId);
    if (!m) throw notFound('Member not found');
    if (body.role !== 'editor' && body.role !== 'viewer') throw bad('role must be editor or viewer');
    if (m.role === 'owner') throw bad('Cannot change the owner role');
    m.role = body.role;
    log(b.id, 'member.updated', user.id, { userId: m.userId, role: m.role });
    save();
    return [200, memberView(b, m)];
  });

  r.delete('/api/boards/:id/members/:userId', ({ user, params }) => {
    const b = boardById(params.id);
    if (!b) throw notFound('Board not found');
    const myRole = roleOf(b, user.id);
    if (!myRole) throw forbidden('Not a member of this board');
    const m = b.members.find((x) => x.userId === params.userId);
    if (myRole !== 'owner' && params.userId !== user.id) throw forbidden('Only the owner can remove members');
    if (!m) throw notFound('Member not found');
    if (m.role === 'owner') throw bad('Cannot remove the board owner');
    b.members = b.members.filter((x) => x !== m);
    for (const c of data.cards) {
      if (c.boardId === b.id && c.assignees.includes(m.userId)) c.assignees = c.assignees.filter((a) => a !== m.userId);
    }
    log(b.id, 'member.removed', user.id, { userId: m.userId });
    save();
    return [204];
  });

  // columns
  r.post('/api/boards/:id/columns', ({ user, params, body }) => {
    const b = getBoard(params.id, user, 'editor');
    const name = str(body.name, 'name', 1, 100);
    const wipLimit = body.wipLimit === undefined ? null : wip(body.wipLimit);
    const col = { id: randomUUID(), boardId: b.id, name, position: boardColumns(b.id).length, wipLimit };
    data.columns.push(col);
    log(b.id, 'column.created', user.id, { columnId: col.id, name });
    save();
    return [201, columnView(col)];
  });

  r.get('/api/columns/:id', ({ user, params }) => {
    const { column } = getColumn(params.id, user, 'viewer');
    return [200, { ...column, cards: columnCards(column.id) }];
  });

  r.patch('/api/columns/:id', ({ user, params, body }) => {
    const { column, board } = getColumn(params.id, user, 'editor');
    const name = body.name !== undefined ? str(body.name, 'name', 1, 100) : undefined;
    const wipLimit = body.wipLimit !== undefined ? wip(body.wipLimit) : undefined;
    const position = body.position !== undefined ? validatePosition(body.position) : undefined;
    if (name !== undefined) column.name = name;
    if (wipLimit !== undefined) column.wipLimit = wipLimit;
    if (position !== undefined) {
      const cols = boardColumns(board.id).filter((c) => c !== column);
      cols.splice(clamp(position, 0, cols.length), 0, column);
      compact(cols);
    }
    log(board.id, 'column.updated', user.id, { columnId: column.id });
    save();
    return [200, columnView(column)];
  });

  r.delete('/api/columns/:id', ({ user, params, query }) => {
    const { column, board } = getColumn(params.id, user, 'editor');
    const hasCards = data.cards.some((c) => c.columnId === column.id);
    if (hasCards && query.get('force') !== 'true') throw conflict('Column still has cards');
    for (const c of columnCards(column.id)) {
      log(board.id, 'card.deleted', user.id, { columnId: column.id, title: c.title, reason: 'column.deleted' }, c.id);
    }
    deleteCardsWhere((c) => c.columnId === column.id);
    data.columns = data.columns.filter((c) => c !== column);
    compact(boardColumns(board.id));
    log(board.id, 'column.deleted', user.id, { columnId: column.id, name: column.name });
    save();
    return [204];
  });

  // cards
  r.post('/api/columns/:id/cards', ({ user, params, body }) => {
    const { column, board } = getColumn(params.id, user, 'editor');
    const title = str(body.title, 'title', 1, 200);
    let description = '';
    if (body.description !== undefined && body.description !== null) {
      if (typeof body.description !== 'string') throw bad('description must be a string');
      description = body.description;
    }
    const assignees = body.assignees === undefined || body.assignees === null ? [] : validateAssignees(board, body.assignees);
    const labels = body.labels === undefined || body.labels === null ? [] : validateLabels(board, body.labels);
    const dueDate = body.dueDate === undefined ? null : validateDue(body.dueDate);
    const position = body.position === undefined || body.position === null ? undefined : validatePosition(body.position);
    const cards = columnCards(column.id);
    if (column.wipLimit && cards.length >= column.wipLimit) {
      throw conflict(`Column WIP limit (${column.wipLimit}) reached`, 'wip_limit');
    }
    const t = now();
    const card = {
      id: randomUUID(),
      boardId: board.id,
      columnId: column.id,
      title,
      description,
      position: 0,
      assignees,
      labels,
      dueDate,
      createdBy: user.id,
      createdAt: t,
      updatedAt: t,
    };
    cards.splice(position === undefined ? cards.length : clamp(position, 0, cards.length), 0, card);
    compact(cards);
    data.cards.push(card);
    log(board.id, 'card.created', user.id, { columnId: column.id, title }, card.id);
    save();
    return [201, card];
  });

  r.get('/api/cards/:id', ({ user, params }) => [200, getCard(params.id, user, 'viewer').card]);

  r.patch('/api/cards/:id', ({ user, params, body }) => {
    const { card, board } = getCard(params.id, user, 'editor');
    const upd = {};
    if (body.title !== undefined) upd.title = str(body.title, 'title', 1, 200);
    if (body.description !== undefined) {
      if (body.description !== null && typeof body.description !== 'string') throw bad('description must be a string');
      upd.description = body.description ?? '';
    }
    if (body.assignees !== undefined) upd.assignees = validateAssignees(board, body.assignees ?? []);
    if (body.labels !== undefined) upd.labels = validateLabels(board, body.labels ?? []);
    if (body.dueDate !== undefined) upd.dueDate = validateDue(body.dueDate);
    Object.assign(card, upd);
    let t = now();
    if (t <= card.updatedAt) t = new Date(Date.parse(card.updatedAt) + 1).toISOString();
    card.updatedAt = t;
    log(board.id, 'card.updated', user.id, { fields: Object.keys(upd) }, card.id);
    save();
    return [200, card];
  });

  r.delete('/api/cards/:id', ({ user, params }) => {
    const { card, board } = getCard(params.id, user, 'editor');
    deleteCardsWhere((c) => c.id === card.id);
    compactColumn(card.columnId);
    log(board.id, 'card.deleted', user.id, { columnId: card.columnId, title: card.title }, card.id);
    save();
    return [204];
  });

  r.post('/api/cards/:id/move', ({ user, params, body }) => {
    const { card, board } = getCard(params.id, user, 'editor');
    if (typeof body.columnId !== 'string') throw bad('columnId required');
    const target = columnById(body.columnId);
    if (!target || target.boardId !== board.id) throw bad('Target column must be on the same board');
    const position = body.position === undefined || body.position === null ? undefined : validatePosition(body.position);
    const fromColumnId = card.columnId;
    const fromPosition = card.position;
    const same = fromColumnId === target.id;
    const targetCards = columnCards(target.id).filter((c) => c !== card);
    if (!same && target.wipLimit && targetCards.length >= target.wipLimit) {
      throw conflict(`Column WIP limit (${target.wipLimit}) reached`, 'wip_limit');
    }
    targetCards.splice(position === undefined ? targetCards.length : clamp(position, 0, targetCards.length), 0, card);
    card.columnId = target.id;
    compact(targetCards);
    if (!same) compactColumn(fromColumnId);
    card.updatedAt = now();
    log(
      board.id,
      'card.moved',
      user.id,
      { fromColumnId, toColumnId: target.id, fromPosition, toPosition: card.position },
      card.id
    );
    save();
    return [200, card];
  });

  // labels
  r.get('/api/boards/:id/labels', ({ user, params }) => {
    const b = getBoard(params.id, user, 'viewer');
    return [200, data.labels.filter((l) => l.boardId === b.id)];
  });

  r.post('/api/boards/:id/labels', ({ user, params, body }) => {
    const b = getBoard(params.id, user, 'editor');
    const name = str(body.name, 'name', 1, 50);
    if (typeof body.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(body.color)) throw bad('color must be #rrggbb');
    if (data.labels.some((l) => l.boardId === b.id && l.name.toLowerCase() === name.toLowerCase())) {
      throw conflict('Label name already exists on this board');
    }
    const label = { id: randomUUID(), boardId: b.id, name, color: body.color };
    data.labels.push(label);
    log(b.id, 'label.created', user.id, { labelId: label.id, name });
    save();
    return [201, label];
  });

  r.patch('/api/labels/:id', ({ user, params, body }) => {
    const label = labelById(params.id);
    if (!label) throw notFound('Label not found');
    const b = getBoard(label.boardId, user, 'editor');
    const name = body.name !== undefined ? str(body.name, 'name', 1, 50) : undefined;
    if (body.color !== undefined && (typeof body.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(body.color))) {
      throw bad('color must be #rrggbb');
    }
    if (name !== undefined && data.labels.some((l) => l !== label && l.boardId === b.id && l.name.toLowerCase() === name.toLowerCase())) {
      throw conflict('Label name already exists on this board');
    }
    if (name !== undefined) label.name = name;
    if (body.color !== undefined) label.color = body.color;
    save();
    return [200, label];
  });

  r.delete('/api/labels/:id', ({ user, params }) => {
    const label = labelById(params.id);
    if (!label) throw notFound('Label not found');
    const b = getBoard(label.boardId, user, 'editor');
    data.labels = data.labels.filter((l) => l !== label);
    for (const c of data.cards) if (c.labels.includes(label.id)) c.labels = c.labels.filter((x) => x !== label.id);
    log(b.id, 'label.deleted', user.id, { labelId: label.id, name: label.name });
    save();
    return [204];
  });

  // comments
  r.post('/api/cards/:id/comments', ({ user, params, body }) => {
    const { card, board } = getCard(params.id, user, 'editor');
    const text = str(body.body, 'body', 1, 5000);
    const c = { id: randomUUID(), cardId: card.id, authorId: user.id, body: text, createdAt: now() };
    data.comments.push(c);
    log(board.id, 'comment.added', user.id, { commentId: c.id }, card.id);
    save();
    return [201, c];
  });

  r.get('/api/cards/:id/comments', ({ user, params }) => {
    const { card } = getCard(params.id, user, 'viewer');
    return [200, data.comments.filter((c) => c.cardId === card.id)];
  });

  r.delete('/api/comments/:id', ({ user, params }) => {
    const c = commentById(params.id);
    if (!c) throw notFound('Comment not found');
    const card = cardById(c.cardId);
    const b = card && boardById(card.boardId);
    if (!b) throw notFound('Comment not found');
    const role = roleOf(b, user.id);
    if (!role) throw forbidden('Not a member of this board');
    if (c.authorId !== user.id && role !== 'owner') throw forbidden('Only the author or board owner may delete');
    data.comments = data.comments.filter((x) => x !== c);
    log(b.id, 'comment.deleted', user.id, { commentId: c.id }, card.id);
    save();
    return [204];
  });

  // search
  r.get('/api/boards/:id/cards', ({ user, params, query }) => {
    const b = getBoard(params.id, user, 'viewer');
    const q = query.get('q');
    const assignee = query.get('assignee');
    const label = query.get('label');
    const column = query.get('column');
    const dueBefore = query.get('due_before');
    if (dueBefore && !validDate(dueBefore)) throw bad('due_before must be YYYY-MM-DD');
    const ql = q ? q.toLowerCase() : '';
    const out = [];
    for (const col of boardColumns(b.id)) {
      if (column && col.id !== column) continue;
      for (const c of columnCards(col.id)) {
        if (ql && !c.title.toLowerCase().includes(ql) && !(c.description || '').toLowerCase().includes(ql)) continue;
        if (assignee && !c.assignees.includes(assignee)) continue;
        if (label && !c.labels.includes(label)) continue;
        if (dueBefore && (!c.dueDate || !(c.dueDate < dueBefore))) continue;
        out.push(c);
      }
    }
    return [200, out];
  });

  // activity
  r.get('/api/boards/:id/activity', ({ user, params, query }) => {
    const b = getBoard(params.id, user, 'viewer');
    let limit = 50;
    const l = query.get('limit');
    if (l !== null && l !== '') {
      const n = Number(l);
      if (!Number.isInteger(n) || n < 0) throw bad('limit must be a non-negative integer');
      limit = n;
    }
    const entries = data.activity.filter((a) => a.boardId === b.id).reverse();
    return [200, entries.slice(0, limit)];
  });

  // ---- static ----
  const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
  function serveStatic(res, pathname, method) {
    let file;
    if (pathname === '/' || pathname === '/index.html') file = path.join(PUBLIC_DIR, 'index.html');
    else if (pathname.startsWith('/static/')) {
      const rel = path.normalize(decodeURIComponent(pathname.slice('/static/'.length)));
      if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
      file = path.join(PUBLIC_DIR, rel);
    } else return false;
    let content;
    try {
      content = fs.readFileSync(file);
    } catch {
      return false;
    }
    res.writeHead(200, {
      'Content-Type': STATIC_TYPES[path.extname(file)] || 'application/octet-stream',
      'Content-Length': content.length,
    });
    res.end(method === 'HEAD' ? undefined : content);
    return true;
  }

  // ---- dispatch ----
  function send(res, status, payload) {
    if (payload === undefined || status === 204) {
      res.writeHead(status);
      res.end();
      return;
    }
    const s = JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s) });
    res.end(s);
  }
  function sendError(res, err) {
    if (err instanceof HttpError) send(res, err.status, { error: err.code, message: err.message });
    else {
      console.error(err);
      send(res, 500, { error: 'internal', message: 'Internal server error' });
    }
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const pathname = url.pathname;
        if (!pathname.startsWith('/api/') && pathname !== '/api') {
          if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(res, pathname, req.method)) return;
          throw notFound('Route not found');
        }
        const { handler, opts, params } = r.find(req.method, pathname);
        if (!handler) throw notFound('Route not found');
        const ctx = { params, query: url.searchParams, body: {}, user: null, token: null };
        if (!opts.public) {
          const auth = req.headers.authorization || '';
          const m = /^Bearer\s+(\S+)$/i.exec(auth);
          const uid = m && sessions.get(m[1]);
          const user = uid && userById(uid);
          if (!user) throw new HttpError(401, 'unauthenticated', 'Authentication required');
          ctx.user = user;
          ctx.token = m[1];
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        if (raw.trim()) {
          try {
            ctx.body = JSON.parse(raw);
          } catch {
            throw bad('Invalid JSON body');
          }
          if (['POST', 'PATCH', 'PUT'].includes(req.method) && !isObj(ctx.body)) throw bad('Body must be a JSON object');
        }
        if (!isObj(ctx.body)) ctx.body = {};
        const [status, payload] = handler(ctx);
        send(res, status, payload);
      } catch (err) {
        sendError(res, err);
      }
    });
    req.on('error', (err) => sendError(res, err));
  });
  return server;
}
