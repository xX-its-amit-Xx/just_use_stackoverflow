import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML_PATH = path.join(__dirname, 'public', 'index.html');
const STATIC_DIR = path.join(__dirname, 'public');

const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED = 5;
const MAX_BODY = 5 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, error, message) {
    super(message || error);
    this.status = status;
    this.code = error;
  }
}
const bad = (msg) => new HttpError(400, 'validation', msg);
const notFound = (msg = 'Not found') => new HttpError(404, 'not_found', msg);
const forbidden = (msg = 'Forbidden') => new HttpError(403, 'forbidden', msg);
const conflict = (msg = 'Conflict', code = 'conflict') => new HttpError(409, code, msg);

const newId = () => crypto.randomUUID();
const now = () => new Date().toISOString();

function emptyData() {
  return { users: [], boards: [], columns: [], cards: [], labels: [], comments: [], activity: [] };
}

// ---------- password hashing ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const h = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === h.length && crypto.timingSafeEqual(h, expected);
}

// ---------- validators ----------
const isStr = (v) => typeof v === 'string';
function validDate(s) {
  if (!isStr(s) || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
function checkName(v, field, max) {
  if (!isStr(v) || v.trim().length < 1 || v.length > max) throw bad(`${field} must be 1-${max} characters`);
  return v;
}
function checkWip(v) {
  if (v === null) return null;
  if (!Number.isInteger(v) || v < 1) throw bad('wipLimit must be a positive integer or null');
  return v;
}
function checkPosition(v) {
  if (!Number.isInteger(v)) throw bad('position must be an integer');
  return v;
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function createServer({ dataFile } = {}) {
  let data = emptyData();
  if (dataFile && fs.existsSync(dataFile)) {
    try {
      const loaded = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      data = { ...emptyData(), ...loaded };
    } catch {
      data = emptyData();
    }
  }
  const tokens = new Map(); // token -> userId
  const failedLogins = new Map(); // username -> [timestamps]
  let activitySeq = data.activity.reduce((m, a) => Math.max(m, a.seq || 0), 0);

  function save() {
    if (!dataFile) return;
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, dataFile);
  }

  // ---------- lookup helpers ----------
  const userById = (id) => data.users.find((u) => u.id === id);
  const publicUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName });
  const roleOf = (board, userId) => board.members.find((m) => m.userId === userId)?.role;

  function requireRole(board, user, minRole) {
    const role = roleOf(board, user.id);
    if (!role) throw forbidden('Not a member of this board');
    if (ROLE_RANK[role] < ROLE_RANK[minRole]) throw forbidden(`Requires ${minRole} role`);
    return role;
  }
  function getBoard(id) {
    const b = data.boards.find((x) => x.id === id);
    if (!b) throw notFound('Board not found');
    return b;
  }
  function getColumn(id) {
    const c = data.columns.find((x) => x.id === id);
    if (!c) throw notFound('Column not found');
    return c;
  }
  function getCard(id) {
    const c = data.cards.find((x) => x.id === id);
    if (!c) throw notFound('Card not found');
    return c;
  }
  const boardColumns = (boardId) =>
    data.columns.filter((c) => c.boardId === boardId).sort((a, b) => a.position - b.position);
  const columnCards = (columnId) =>
    data.cards.filter((c) => c.columnId === columnId).sort((a, b) => a.position - b.position);
  function compactColumns(boardId) {
    boardColumns(boardId).forEach((c, i) => (c.position = i));
  }
  function compactCards(columnId) {
    columnCards(columnId).forEach((c, i) => (c.position = i));
  }

  function logActivity(boardId, type, actorId, details = {}, cardId) {
    const entry = { id: newId(), boardId, type, actorId, at: now(), details, seq: ++activitySeq };
    if (cardId) entry.cardId = cardId;
    data.activity.push(entry);
  }
  const publicActivity = (a) => {
    const { seq, ...rest } = a;
    return rest;
  };

  const cardOut = (c) => ({
    id: c.id, boardId: c.boardId, columnId: c.columnId, title: c.title, description: c.description,
    position: c.position, assignees: [...c.assignees], labels: [...c.labels], dueDate: c.dueDate,
    createdBy: c.createdBy, createdAt: c.createdAt, updatedAt: c.updatedAt,
  });
  const columnOut = (c) => ({ id: c.id, boardId: c.boardId, name: c.name, position: c.position, wipLimit: c.wipLimit });
  const labelOut = (l) => ({ id: l.id, boardId: l.boardId, name: l.name, color: l.color });
  const memberOut = (m) => ({ userId: m.userId, username: userById(m.userId)?.username ?? null, role: m.role });
  function boardOut(b) {
    return {
      id: b.id, name: b.name, description: b.description, ownerId: b.ownerId, createdAt: b.createdAt,
      members: b.members.map(memberOut),
      labels: data.labels.filter((l) => l.boardId === b.id).map(labelOut),
      columns: boardColumns(b.id).map((c) => ({ ...columnOut(c), cards: columnCards(c.id).map(cardOut) })),
    };
  }

  function validateAssignees(board, v) {
    if (!Array.isArray(v) || !v.every(isStr)) throw bad('assignees must be an array of user ids');
    const uniq = [...new Set(v)];
    for (const id of uniq) if (!roleOf(board, id)) throw bad(`Assignee ${id} is not a board member`);
    return uniq;
  }
  function validateLabels(board, v) {
    if (!Array.isArray(v) || !v.every(isStr)) throw bad('labels must be an array of label ids');
    const uniq = [...new Set(v)];
    for (const id of uniq) {
      if (!data.labels.some((l) => l.id === id && l.boardId === board.id)) throw bad(`Label ${id} does not belong to board`);
    }
    return uniq;
  }
  function validateDue(v) {
    if (v === null) return null;
    if (!validDate(v)) throw bad('dueDate must be YYYY-MM-DD or null');
    return v;
  }
  const body = (b) => {
    if (b === null || typeof b !== 'object' || Array.isArray(b)) throw bad('Request body must be a JSON object');
    return b;
  };

  // ---------- route handlers ----------
  const routes = [];
  const route = (method, pattern, handler, { auth = true } = {}) => {
    const keys = [];
    const re = new RegExp(
      '^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$'
    );
    routes.push({ method, re, keys, handler, auth });
  };

  // Auth
  route('POST', '/api/auth/register', ({ getBody }) => {
    const b = body(getBody());
    if (!isStr(b.username)) throw bad('username is required');
    const username = b.username.toLowerCase();
    if (!/^[a-z0-9_]{3,32}$/.test(username)) throw bad('username must be 3-32 chars of [a-z0-9_]');
    if (!isStr(b.password) || b.password.length < 8) throw bad('password must be at least 8 characters');
    let displayName = username;
    if (b.displayName !== undefined && b.displayName !== null) {
      if (!isStr(b.displayName) || b.displayName.length > 100) throw bad('displayName must be a string up to 100 chars');
      if (b.displayName.trim()) displayName = b.displayName;
    }
    if (data.users.some((u) => u.username === username)) throw conflict('Username already taken');
    const { salt, hash } = hashPassword(b.password);
    const user = { id: newId(), username, displayName, passwordSalt: salt, passwordHash: hash, createdAt: now() };
    data.users.push(user);
    save();
    return [201, { user: publicUser(user) }];
  }, { auth: false });

  route('POST', '/api/auth/login', ({ getBody }) => {
    const b = body(getBody());
    if (!isStr(b.username) || !isStr(b.password)) throw new HttpError(401, 'unauthenticated', 'Invalid credentials');
    const username = b.username.toLowerCase();
    const t = Date.now();
    const attempts = (failedLogins.get(username) || []).filter((x) => t - x < LOGIN_WINDOW_MS);
    failedLogins.set(username, attempts);
    if (attempts.length >= MAX_FAILED) throw new HttpError(429, 'rate_limited', 'Too many failed login attempts');
    const user = data.users.find((u) => u.username === username);
    if (!user || !verifyPassword(b.password, user.passwordSalt, user.passwordHash)) {
      attempts.push(t);
      throw new HttpError(401, 'unauthenticated', 'Invalid credentials');
    }
    failedLogins.delete(username);
    const token = crypto.randomBytes(32).toString('hex');
    tokens.set(token, user.id);
    return [200, { token, user: publicUser(user) }];
  }, { auth: false });

  route('POST', '/api/auth/logout', ({ token }) => {
    tokens.delete(token);
    return [204];
  });
  route('GET', '/api/auth/me', ({ user }) => [200, { user: publicUser(user) }]);

  // Boards
  route('POST', '/api/boards', ({ user, getBody }) => {
    const b = body(getBody());
    const name = checkName(b.name, 'name', 100);
    let description = '';
    if (b.description !== undefined && b.description !== null) {
      if (!isStr(b.description) || b.description.length > 5000) throw bad('description must be a string');
      description = b.description;
    }
    let cols = ['To Do', 'In Progress', 'Done'];
    if (b.columns !== undefined) {
      if (!Array.isArray(b.columns)) throw bad('columns must be an array of names');
      cols = b.columns.map((c) => checkName(c, 'column name', 100));
    }
    const board = { id: newId(), name, description, ownerId: user.id, createdAt: now(), members: [{ userId: user.id, role: 'owner' }] };
    data.boards.push(board);
    logActivity(board.id, 'board.created', user.id, { name });
    cols.forEach((cn, i) => {
      const col = { id: newId(), boardId: board.id, name: cn, position: i, wipLimit: null, createdAt: now() };
      data.columns.push(col);
      logActivity(board.id, 'column.created', user.id, { columnId: col.id, name: cn });
    });
    save();
    return [201, boardOut(board)];
  });

  route('GET', '/api/boards', ({ user }) => [
    200,
    data.boards
      .filter((b) => roleOf(b, user.id))
      .map((b) => ({ id: b.id, name: b.name, role: roleOf(b, user.id) })),
  ]);

  route('GET', '/api/boards/:id', ({ user, params }) => {
    const board = getBoard(params.id);
    requireRole(board, user, 'viewer');
    return [200, boardOut(board)];
  });

  route('PATCH', '/api/boards/:id', ({ user, params, getBody }) => {
    const board = getBoard(params.id);
    requireRole(board, user, 'owner');
    const b = body(getBody());
    if (b.name !== undefined) board.name = checkName(b.name, 'name', 100);
    if (b.description !== undefined) {
      if (b.description !== null && (!isStr(b.description) || b.description.length > 5000)) throw bad('description must be a string');
      board.description = b.description ?? '';
    }
    logActivity(board.id, 'board.updated', user.id, {});
    save();
    return [200, boardOut(board)];
  });

  route('DELETE', '/api/boards/:id', ({ user, params }) => {
    const board = getBoard(params.id);
    requireRole(board, user, 'owner');
    const cardIds = new Set(data.cards.filter((c) => c.boardId === board.id).map((c) => c.id));
    data.comments = data.comments.filter((c) => !cardIds.has(c.cardId));
    data.cards = data.cards.filter((c) => c.boardId !== board.id);
    data.columns = data.columns.filter((c) => c.boardId !== board.id);
    data.labels = data.labels.filter((l) => l.boardId !== board.id);
    data.activity = data.activity.filter((a) => a.boardId !== board.id);
    data.boards = data.boards.filter((b) => b.id !== board.id);
    save();
    return [204];
  });

  // Members
  route('GET', '/api/boards/:id/members', ({ user, params }) => {
    const board = getBoard(params.id);
    requireRole(board, user, 'viewer');
    return [200, board.members.map(memberOut)];
  });

  route('POST', '/api/boards/:id/members', ({ user, params, getBody }) => {
    const board = getBoard(params.id);
    requireRole(board, user, 'owner');
    const b = body(getBody());
    if (!isStr(b.username) || !b.username) throw bad('username is required');
    if (b.role !== 'editor' && b.role !== 'viewer') throw bad('role must be editor or viewer');
    const target = data.users.find((u) => u.username === b.username.toLowerCase());
    if (!target) throw notFound('User not found');
    if (roleOf(board, target.id)) throw conflict('User is already a member');
    const m = { userId: target.id, role: b.role };
    board.members.push(m);
    logActivity(board.id, 'member.added', user.id, { userId: target.id, username: target.username, role: b.role });
    save();
    return [201, memberOut(m)];
  });

  route('PATCH', '/api/boards/:id/members/:userId', ({ user, params, getBody }) => {
    const board = getBoard(params.id);
    requireRole(board, user, 'owner');
    const b = body(getBody());
    const m = board.members.find((x) => x.userId === params.userId);
    if (!m) throw notFound('Member not found');
    if (b.role !== 'editor' && b.role !== 'viewer') throw bad('role must be editor or viewer');
    if (m.role === 'owner') throw bad('Cannot change the owner role');
    m.role = b.role;
    logActivity(board.id, 'member.updated', user.id, { userId: m.userId, role: m.role });
    save();
    return [200, memberOut(m)];
  });

  route('DELETE', '/api/boards/:id/members/:userId', ({ user, params }) => {
    const board = getBoard(params.id);
    const myRole = requireRole(board, user, 'viewer');
    if (myRole !== 'owner' && params.userId !== user.id) throw forbidden('Only the owner can remove other members');
    const m = board.members.find((x) => x.userId === params.userId);
    if (!m) throw notFound('Member not found');
    if (m.role === 'owner') throw bad('Cannot remove the board owner');
    board.members = board.members.filter((x) => x !== m);
    for (const c of data.cards) {
      if (c.boardId === board.id && c.assignees.includes(m.userId)) c.assignees = c.assignees.filter((a) => a !== m.userId);
    }
    logActivity(board.id, 'member.removed', user.id, { userId: m.userId });
    save();
    return [204];
  });

  // Columns
  route('POST', '/api/boards/:id/columns', ({ user, params, getBody }) => {
    const board = getBoard(params.id);
    requireRole(board, user, 'editor');
    const b = body(getBody());
    const name = checkName(b.name, 'name', 100);
    const wipLimit = b.wipLimit === undefined ? null : checkWip(b.wipLimit);
    const col = { id: newId(), boardId: board.id, name, position: boardColumns(board.id).length, wipLimit, createdAt: now() };
    data.columns.push(col);
    logActivity(board.id, 'column.created', user.id, { columnId: col.id, name });
    save();
    return [201, columnOut(col)];
  });

  route('GET', '/api/columns/:id', ({ user, params }) => {
    const col = getColumn(params.id);
    requireRole(getBoard(col.boardId), user, 'viewer');
    return [200, { ...columnOut(col), cards: columnCards(col.id).map(cardOut) }];
  });

  route('PATCH', '/api/columns/:id', ({ user, params, getBody }) => {
    const col = getColumn(params.id);
    const board = getBoard(col.boardId);
    requireRole(board, user, 'editor');
    const b = body(getBody());
    const name = b.name !== undefined ? checkName(b.name, 'name', 100) : col.name;
    const wipLimit = b.wipLimit !== undefined ? checkWip(b.wipLimit) : col.wipLimit;
    const position = b.position !== undefined ? checkPosition(b.position) : undefined;
    col.name = name;
    col.wipLimit = wipLimit;
    if (position !== undefined) {
      const others = boardColumns(board.id).filter((c) => c !== col);
      const p = clamp(position, 0, others.length);
      others.splice(p, 0, col);
      others.forEach((c, i) => (c.position = i));
    }
    logActivity(board.id, 'column.updated', user.id, { columnId: col.id });
    save();
    return [200, columnOut(col)];
  });

  route('DELETE', '/api/columns/:id', ({ user, params, query }) => {
    const col = getColumn(params.id);
    const board = getBoard(col.boardId);
    requireRole(board, user, 'editor');
    const cards = data.cards.filter((c) => c.columnId === col.id);
    if (cards.length && query.get('force') !== 'true') throw conflict('Column still has cards');
    const ids = new Set(cards.map((c) => c.id));
    data.comments = data.comments.filter((c) => !ids.has(c.cardId));
    data.cards = data.cards.filter((c) => !ids.has(c.id));
    data.columns = data.columns.filter((c) => c !== col);
    compactColumns(board.id);
    logActivity(board.id, 'column.deleted', user.id, { columnId: col.id, name: col.name });
    save();
    return [204];
  });

  // Cards
  route('POST', '/api/columns/:id/cards', ({ user, params, getBody }) => {
    const col = getColumn(params.id);
    const board = getBoard(col.boardId);
    requireRole(board, user, 'editor');
    const b = body(getBody());
    const title = checkName(b.title, 'title', 200);
    let description = '';
    if (b.description !== undefined && b.description !== null) {
      if (!isStr(b.description) || b.description.length > 10000) throw bad('description must be a string');
      description = b.description;
    }
    const assignees = b.assignees === undefined ? [] : validateAssignees(board, b.assignees);
    const labels = b.labels === undefined ? [] : validateLabels(board, b.labels);
    const dueDate = b.dueDate === undefined ? null : validateDue(b.dueDate);
    const position = b.position === undefined || b.position === null ? undefined : checkPosition(b.position);
    const existing = columnCards(col.id);
    if (col.wipLimit != null && existing.length >= col.wipLimit) throw conflict('Column WIP limit reached', 'wip_limit');
    const t = now();
    const card = {
      id: newId(), boardId: board.id, columnId: col.id, title, description, position: 0,
      assignees, labels, dueDate, createdBy: user.id, createdAt: t, updatedAt: t,
    };
    const p = position === undefined ? existing.length : clamp(position, 0, existing.length);
    existing.splice(p, 0, card);
    existing.forEach((c, i) => (c.position = i));
    data.cards.push(card);
    logActivity(board.id, 'card.created', user.id, { title, columnId: col.id }, card.id);
    save();
    return [201, cardOut(card)];
  });

  route('GET', '/api/cards/:id', ({ user, params }) => {
    const card = getCard(params.id);
    requireRole(getBoard(card.boardId), user, 'viewer');
    return [200, cardOut(card)];
  });

  route('PATCH', '/api/cards/:id', ({ user, params, getBody }) => {
    const card = getCard(params.id);
    const board = getBoard(card.boardId);
    requireRole(board, user, 'editor');
    const b = body(getBody());
    const upd = {};
    if (b.title !== undefined) upd.title = checkName(b.title, 'title', 200);
    if (b.description !== undefined) {
      if (b.description !== null && (!isStr(b.description) || b.description.length > 10000)) throw bad('description must be a string');
      upd.description = b.description ?? '';
    }
    if (b.assignees !== undefined) upd.assignees = validateAssignees(board, b.assignees);
    if (b.labels !== undefined) upd.labels = validateLabels(board, b.labels);
    if (b.dueDate !== undefined) upd.dueDate = validateDue(b.dueDate);
    Object.assign(card, upd);
    let t = now();
    if (t <= card.updatedAt) t = new Date(Date.parse(card.updatedAt) + 1).toISOString();
    card.updatedAt = t;
    logActivity(board.id, 'card.updated', user.id, { fields: Object.keys(upd) }, card.id);
    save();
    return [200, cardOut(card)];
  });

  route('DELETE', '/api/cards/:id', ({ user, params }) => {
    const card = getCard(params.id);
    const board = getBoard(card.boardId);
    requireRole(board, user, 'editor');
    data.cards = data.cards.filter((c) => c !== card);
    data.comments = data.comments.filter((c) => c.cardId !== card.id);
    compactCards(card.columnId);
    logActivity(board.id, 'card.deleted', user.id, { title: card.title, columnId: card.columnId }, card.id);
    save();
    return [204];
  });

  route('POST', '/api/cards/:id/move', ({ user, params, getBody }) => {
    const card = getCard(params.id);
    const board = getBoard(card.boardId);
    requireRole(board, user, 'editor');
    const b = body(getBody());
    if (!isStr(b.columnId) || !b.columnId) throw bad('columnId is required');
    const position = b.position === undefined || b.position === null ? undefined : checkPosition(b.position);
    const target = data.columns.find((c) => c.id === b.columnId);
    if (!target) throw bad('Target column not found');
    if (target.boardId !== board.id) throw bad('Target column must be on the same board');
    const fromColumnId = card.columnId;
    const fromPosition = card.position;
    const same = target.id === fromColumnId;
    const targetCards = columnCards(target.id).filter((c) => c !== card);
    if (!same && target.wipLimit != null && targetCards.length >= target.wipLimit) {
      throw conflict('Column WIP limit reached', 'wip_limit');
    }
    const p = position === undefined ? targetCards.length : clamp(position, 0, targetCards.length);
    card.columnId = target.id;
    targetCards.splice(p, 0, card);
    targetCards.forEach((c, i) => (c.position = i));
    if (!same) compactCards(fromColumnId);
    card.updatedAt = now();
    logActivity(board.id, 'card.moved', user.id, {
      fromColumnId, toColumnId: target.id, fromPosition, toPosition: card.position,
    }, card.id);
    save();
    return [200, cardOut(card)];
  });

  // Labels
  route('GET', '/api/boards/:id/labels', ({ user, params }) => {
    const board = getBoard(params.id);
    requireRole(board, user, 'viewer');
    return [200, data.labels.filter((l) => l.boardId === board.id).map(labelOut)];
  });

  route('POST', '/api/boards/:id/labels', ({ user, params, getBody }) => {
    const board = getBoard(params.id);
    requireRole(board, user, 'editor');
    const b = body(getBody());
    const name = checkName(b.name, 'name', 50);
    if (!isStr(b.color) || !/^#[0-9a-fA-F]{6}$/.test(b.color)) throw bad('color must be #rrggbb');
    if (data.labels.some((l) => l.boardId === board.id && l.name.toLowerCase() === name.toLowerCase())) {
      throw conflict('Label name already exists on this board');
    }
    const label = { id: newId(), boardId: board.id, name, color: b.color };
    data.labels.push(label);
    logActivity(board.id, 'label.created', user.id, { labelId: label.id, name });
    save();
    return [201, labelOut(label)];
  });

  route('PATCH', '/api/labels/:id', ({ user, params, getBody }) => {
    const label = data.labels.find((l) => l.id === params.id);
    if (!label) throw notFound('Label not found');
    const board = getBoard(label.boardId);
    requireRole(board, user, 'editor');
    const b = body(getBody());
    const name = b.name !== undefined ? checkName(b.name, 'name', 50) : label.name;
    if (b.color !== undefined && (!isStr(b.color) || !/^#[0-9a-fA-F]{6}$/.test(b.color))) throw bad('color must be #rrggbb');
    if (data.labels.some((l) => l !== label && l.boardId === board.id && l.name.toLowerCase() === name.toLowerCase())) {
      throw conflict('Label name already exists on this board');
    }
    label.name = name;
    if (b.color !== undefined) label.color = b.color;
    save();
    return [200, labelOut(label)];
  });

  route('DELETE', '/api/labels/:id', ({ user, params }) => {
    const label = data.labels.find((l) => l.id === params.id);
    if (!label) throw notFound('Label not found');
    const board = getBoard(label.boardId);
    requireRole(board, user, 'editor');
    data.labels = data.labels.filter((l) => l !== label);
    for (const c of data.cards) if (c.labels.includes(label.id)) c.labels = c.labels.filter((x) => x !== label.id);
    logActivity(board.id, 'label.deleted', user.id, { labelId: label.id, name: label.name });
    save();
    return [204];
  });

  // Comments
  const commentOut = (c) => ({ id: c.id, cardId: c.cardId, authorId: c.authorId, body: c.body, createdAt: c.createdAt });
  route('POST', '/api/cards/:id/comments', ({ user, params, getBody }) => {
    const card = getCard(params.id);
    const board = getBoard(card.boardId);
    requireRole(board, user, 'editor');
    const b = body(getBody());
    if (!isStr(b.body) || b.body.trim().length < 1 || b.body.length > 5000) throw bad('body must be 1-5000 characters');
    const comment = { id: newId(), cardId: card.id, authorId: user.id, body: b.body, createdAt: now(), seq: ++activitySeq };
    data.comments.push(comment);
    logActivity(board.id, 'comment.added', user.id, { commentId: comment.id }, card.id);
    save();
    return [201, commentOut(comment)];
  });

  route('GET', '/api/cards/:id/comments', ({ user, params }) => {
    const card = getCard(params.id);
    requireRole(getBoard(card.boardId), user, 'viewer');
    const list = data.comments.filter((c) => c.cardId === card.id);
    // insertion order is chronological
    return [200, list.map(commentOut)];
  });

  route('DELETE', '/api/comments/:id', ({ user, params }) => {
    const comment = data.comments.find((c) => c.id === params.id);
    if (!comment) throw notFound('Comment not found');
    const card = getCard(comment.cardId);
    const board = getBoard(card.boardId);
    const role = requireRole(board, user, 'viewer');
    if (comment.authorId !== user.id && role !== 'owner') throw forbidden('Only the author or board owner may delete');
    data.comments = data.comments.filter((c) => c !== comment);
    logActivity(board.id, 'comment.deleted', user.id, { commentId: comment.id }, card.id);
    save();
    return [204];
  });

  // Search
  route('GET', '/api/boards/:id/cards', ({ user, params, query }) => {
    const board = getBoard(params.id);
    requireRole(board, user, 'viewer');
    const q = query.get('q');
    const assignee = query.get('assignee');
    const label = query.get('label');
    const column = query.get('column');
    const dueBefore = query.get('due_before');
    if (dueBefore && !validDate(dueBefore)) throw bad('due_before must be YYYY-MM-DD');
    const ql = q ? q.toLowerCase() : '';
    const colPos = new Map(boardColumns(board.id).map((c) => [c.id, c.position]));
    const result = data.cards
      .filter((c) => c.boardId === board.id)
      .filter((c) => !ql || c.title.toLowerCase().includes(ql) || (c.description || '').toLowerCase().includes(ql))
      .filter((c) => !assignee || c.assignees.includes(assignee))
      .filter((c) => !label || c.labels.includes(label))
      .filter((c) => !column || c.columnId === column)
      .filter((c) => !dueBefore || (c.dueDate && c.dueDate < dueBefore))
      .sort((a, b) => (colPos.get(a.columnId) - colPos.get(b.columnId)) || (a.position - b.position));
    return [200, result.map(cardOut)];
  });

  // Activity
  route('GET', '/api/boards/:id/activity', ({ user, params, query }) => {
    const board = getBoard(params.id);
    requireRole(board, user, 'viewer');
    let limit = 50;
    const l = query.get('limit');
    if (l !== null && l !== '') {
      if (!/^\d+$/.test(l)) throw bad('limit must be a positive integer');
      limit = Number(l);
      if (limit < 1) throw bad('limit must be a positive integer');
    }
    const list = data.activity
      .filter((a) => a.boardId === board.id)
      .sort((a, b) => (b.seq || 0) - (a.seq || 0))
      .slice(0, limit)
      .map(publicActivity);
    return [200, list];
  });

  // ---------- HTTP plumbing ----------
  function send(res, status, payload) {
    if (status === 204 || payload === undefined) {
      res.writeHead(status);
      return res.end();
    }
    const s = JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s) });
    res.end(s);
  }
  const sendError = (res, e) => send(res, e.status, { error: e.code, message: e.message });

  function serveStatic(req, res, pathname) {
    let file;
    if (pathname === '/' || pathname === '/index.html') file = INDEX_HTML_PATH;
    else if (pathname.startsWith('/static/')) {
      const rel = decodeURIComponent(pathname.slice('/static/'.length));
      file = path.resolve(STATIC_DIR, rel);
      if (!file.startsWith(STATIC_DIR + path.sep)) return false;
    } else return false;
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
    const ext = path.extname(file);
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    const content = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Content-Length': content.length });
    res.end(req.method === 'HEAD' ? undefined : content);
    return true;
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) tooBig = true;
      else chunks.push(c);
    });
    req.on('end', () => {
      try {
        handle(req, res, Buffer.concat(chunks).toString('utf8'), tooBig);
      } catch (e) {
        if (e instanceof HttpError) sendError(res, e);
        else {
          console.error(e);
          send(res, 500, { error: 'internal', message: 'Internal server error' });
        }
      }
    });
    req.on('error', () => {});
  });

  function handle(req, res, raw, tooBig) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if ((req.method === 'GET' || req.method === 'HEAD') && !pathname.startsWith('/api')) {
      if (serveStatic(req, res, pathname)) return;
      throw notFound('Route not found');
    }
    let match = null;
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(pathname);
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        match = { r, params };
        break;
      }
    }
    if (!match) throw notFound('Route not found');
    let user = null;
    let token = null;
    if (match.r.auth) {
      const h = req.headers.authorization || '';
      const m = /^Bearer\s+(\S+)$/i.exec(h);
      token = m ? m[1] : null;
      const uid = token ? tokens.get(token) : undefined;
      user = uid ? userById(uid) : null;
      if (!user) throw new HttpError(401, 'unauthenticated', 'Authentication required');
    }
    let parsed;
    let parsedDone = false;
    const getBody = () => {
      if (parsedDone) return parsed;
      if (tooBig) throw bad('Request body too large');
      if (!raw.trim()) parsed = {};
      else {
        try {
          parsed = JSON.parse(raw);
        } catch {
          throw new HttpError(400, 'invalid_json', 'Invalid JSON body');
        }
      }
      parsedDone = true;
      return parsed;
    };
    // Parse body eagerly for mutating requests so invalid JSON → 400 consistently.
    if (req.method !== 'GET' && req.method !== 'DELETE' && raw.trim()) getBody();
    const [status, payload] = match.r.handler({ req, user, token, params: match.params, query: url.searchParams, getBody });
    send(res, status, payload);
  }

  return server;
}
