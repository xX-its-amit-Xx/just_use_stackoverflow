import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML_PATH = path.join(__dirname, 'public', 'index.html');
const STATIC_DIR = path.join(__dirname, 'public');

const DEFAULT_COLUMNS = ['To Do', 'In Progress', 'Done'];
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED = 5;
const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };

class HttpError extends Error {
  constructor(status, code, message, extra) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
const bad = (msg) => new HttpError(400, 'validation_error', msg);
const notFound = (msg = 'Not found') => new HttpError(404, 'not_found', msg);
const forbidden = (msg = 'Forbidden') => new HttpError(403, 'forbidden', msg);
const conflict = (msg, code = 'conflict') => new HttpError(409, code, msg);
const unauth = (msg = 'Authentication required') => new HttpError(401, 'unauthorized', msg);

function emptyDb() {
  return { users: [], boards: [], members: [], columns: [], cards: [], labels: [], comments: [], activity: [] };
}

function newId() {
  return crypto.randomUUID();
}

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

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function checkString(v, field, min, max) {
  if (typeof v !== 'string') throw bad(`${field} must be a string`);
  if (v.trim().length < min || v.length > max) throw bad(`${field} must be ${min}-${max} characters`);
  return v;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

function parsePosition(v, field = 'position') {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v)) throw bad(`${field} must be an integer`);
  return v;
}

function validateWip(v) {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) throw bad('wipLimit must be a positive integer or null');
  return v;
}

export function createServer({ dataFile } = {}) {
  let db = emptyDb();
  if (dataFile && fs.existsSync(dataFile)) {
    try {
      const raw = fs.readFileSync(dataFile, 'utf8');
      if (raw.trim()) db = { ...emptyDb(), ...JSON.parse(raw) };
    } catch {
      db = emptyDb();
    }
  }
  const sessions = new Map(); // token -> userId
  const failedLogins = new Map(); // username -> [timestamps]

  function save() {
    if (!dataFile) return;
    const dir = path.dirname(path.resolve(dataFile));
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${dataFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, dataFile);
  }

  // ---------- helpers ----------
  const publicUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName });
  const userById = (id) => db.users.find((u) => u.id === id);
  const memberRole = (boardId, userId) => db.members.find((m) => m.boardId === boardId && m.userId === userId)?.role;

  function nowIso() {
    return new Date().toISOString();
  }

  function logActivity(boardId, type, actorId, details = {}, cardId) {
    const entry = { id: newId(), boardId, type, actorId, at: nowIso(), details };
    if (cardId) entry.cardId = cardId;
    db.activity.push(entry);
  }

  function getBoard(id) {
    const b = db.boards.find((x) => x.id === id);
    if (!b) throw notFound('Board not found');
    return b;
  }

  function requireRole(boardId, user, minRole) {
    const role = memberRole(boardId, user.id);
    if (!role) throw forbidden('Not a member of this board');
    if (ROLE_RANK[role] < ROLE_RANK[minRole]) throw forbidden(`Requires ${minRole} role`);
    return role;
  }

  function columnsOf(boardId) {
    return db.columns.filter((c) => c.boardId === boardId).sort((a, b) => a.position - b.position);
  }
  function cardsOf(columnId) {
    return db.cards.filter((c) => c.columnId === columnId).sort((a, b) => a.position - b.position);
  }
  function compactColumns(boardId) {
    columnsOf(boardId).forEach((c, i) => (c.position = i));
  }
  function compactCards(columnId) {
    cardsOf(columnId).forEach((c, i) => (c.position = i));
  }

  const columnView = (c) => ({ id: c.id, boardId: c.boardId, name: c.name, position: c.position, wipLimit: c.wipLimit ?? null });
  const cardView = (c) => ({
    id: c.id, boardId: c.boardId, columnId: c.columnId, title: c.title, description: c.description,
    position: c.position, assignees: [...c.assignees], labels: [...c.labels], dueDate: c.dueDate ?? null,
    createdBy: c.createdBy, createdAt: c.createdAt, updatedAt: c.updatedAt,
  });
  const labelView = (l) => ({ id: l.id, boardId: l.boardId, name: l.name, color: l.color });
  const memberView = (m) => {
    const u = userById(m.userId);
    return { userId: m.userId, username: u?.username, displayName: u?.displayName, role: m.role };
  };

  function boardView(b) {
    return {
      id: b.id, name: b.name, description: b.description, ownerId: b.ownerId, createdAt: b.createdAt,
      members: db.members.filter((m) => m.boardId === b.id).map(memberView),
      labels: db.labels.filter((l) => l.boardId === b.id).map(labelView),
      columns: columnsOf(b.id).map((c) => ({ ...columnView(c), cards: cardsOf(c.id).map(cardView) })),
    };
  }

  function resolveColumn(id) {
    const c = db.columns.find((x) => x.id === id);
    if (!c) throw notFound('Column not found');
    return c;
  }
  function resolveCard(id) {
    const c = db.cards.find((x) => x.id === id);
    if (!c) throw notFound('Card not found');
    return c;
  }

  function validateAssignees(boardId, v) {
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw bad('assignees must be an array of user ids');
    const uniq = [...new Set(v)];
    for (const uid of uniq) if (!memberRole(boardId, uid)) throw bad(`Assignee ${uid} is not a board member`);
    return uniq;
  }
  function validateLabels(boardId, v) {
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw bad('labels must be an array of label ids');
    const uniq = [...new Set(v)];
    for (const lid of uniq) {
      const l = db.labels.find((x) => x.id === lid);
      if (!l || l.boardId !== boardId) throw bad(`Label ${lid} does not belong to this board`);
    }
    return uniq;
  }
  function validateDue(v) {
    if (v === null) return null;
    if (!isValidDate(v)) throw bad('dueDate must be YYYY-MM-DD or null');
    return v;
  }
  function validateDescription(v) {
    if (v === null) return '';
    if (typeof v !== 'string') throw bad('description must be a string');
    if (v.length > 10000) throw bad('description too long');
    return v;
  }

  function deleteCardData(cardIds) {
    const set = new Set(cardIds);
    db.cards = db.cards.filter((c) => !set.has(c.id));
    db.comments = db.comments.filter((c) => !set.has(c.cardId));
  }

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
    routes.push({ method, re, keys, handler, auth: opts.auth !== false });
  };

  // Auth
  route('POST', '/api/auth/register', ({ body }) => {
    const { username, password, displayName } = body;
    if (typeof username !== 'string') throw bad('username is required');
    const uname = username.toLowerCase();
    if (!/^[a-z0-9_]{3,32}$/.test(uname)) throw bad('username must be 3-32 characters of [a-z0-9_]');
    if (typeof password !== 'string' || password.length < 8) throw bad('password must be at least 8 characters');
    let dn = uname;
    if (displayName !== undefined && displayName !== null) {
      if (typeof displayName !== 'string' || displayName.length > 100) throw bad('displayName must be a string up to 100 characters');
      if (displayName.trim()) dn = displayName;
    }
    if (db.users.some((u) => u.username === uname)) throw conflict('Username already taken');
    const { salt, hash } = hashPassword(password);
    const user = { id: newId(), username: uname, displayName: dn, passwordSalt: salt, passwordHash: hash, createdAt: nowIso() };
    db.users.push(user);
    save();
    return [201, { user: publicUser(user) }];
  }, { auth: false });

  route('POST', '/api/auth/login', ({ body }) => {
    const { username, password } = body;
    if (typeof username !== 'string' || typeof password !== 'string') throw bad('username and password are required');
    const uname = username.toLowerCase();
    const now = Date.now();
    const attempts = (failedLogins.get(uname) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
    failedLogins.set(uname, attempts);
    if (attempts.length >= MAX_FAILED) throw new HttpError(429, 'rate_limited', 'Too many failed login attempts');
    const user = db.users.find((u) => u.username === uname);
    if (!user || !verifyPassword(password, user.passwordSalt, user.passwordHash)) {
      attempts.push(now);
      throw new HttpError(401, 'invalid_credentials', 'Invalid username or password');
    }
    failedLogins.delete(uname);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, user.id);
    return [200, { token, user: publicUser(user) }];
  }, { auth: false });

  route('POST', '/api/auth/logout', ({ token }) => {
    sessions.delete(token);
    return [204];
  });
  route('GET', '/api/auth/me', ({ user }) => [200, { user: publicUser(user) }]);

  // Boards
  route('POST', '/api/boards', ({ body, user }) => {
    const name = checkString(body.name, 'name', 1, 100);
    const description = body.description === undefined ? '' : validateDescription(body.description);
    let cols = DEFAULT_COLUMNS;
    if (body.columns !== undefined) {
      if (!Array.isArray(body.columns)) throw bad('columns must be an array of names');
      cols = body.columns.map((c) => checkString(c, 'column name', 1, 100));
    }
    const board = { id: newId(), name, description, ownerId: user.id, createdAt: nowIso() };
    db.boards.push(board);
    db.members.push({ boardId: board.id, userId: user.id, role: 'owner' });
    logActivity(board.id, 'board.created', user.id, { name });
    cols.forEach((cname, i) => {
      const col = { id: newId(), boardId: board.id, name: cname, position: i, wipLimit: null };
      db.columns.push(col);
      logActivity(board.id, 'column.created', user.id, { columnId: col.id, name: cname });
    });
    save();
    return [201, boardView(board)];
  });

  route('GET', '/api/boards', ({ user }) => {
    const list = db.members.filter((m) => m.userId === user.id).map((m) => {
      const b = db.boards.find((x) => x.id === m.boardId);
      return b && { id: b.id, name: b.name, role: m.role };
    }).filter(Boolean);
    return [200, list];
  });

  route('GET', '/api/boards/:id', ({ params, user }) => {
    const b = getBoard(params.id);
    requireRole(b.id, user, 'viewer');
    return [200, boardView(b)];
  });

  route('PATCH', '/api/boards/:id', ({ params, user, body }) => {
    const b = getBoard(params.id);
    requireRole(b.id, user, 'owner');
    const changes = {};
    if (body.name !== undefined) changes.name = checkString(body.name, 'name', 1, 100);
    if (body.description !== undefined) changes.description = validateDescription(body.description);
    Object.assign(b, changes);
    logActivity(b.id, 'board.updated', user.id, { changes: Object.keys(changes) });
    save();
    return [200, boardView(b)];
  });

  route('DELETE', '/api/boards/:id', ({ params, user }) => {
    const b = getBoard(params.id);
    requireRole(b.id, user, 'owner');
    const cardIds = db.cards.filter((c) => c.boardId === b.id).map((c) => c.id);
    deleteCardData(cardIds);
    db.boards = db.boards.filter((x) => x.id !== b.id);
    db.members = db.members.filter((x) => x.boardId !== b.id);
    db.columns = db.columns.filter((x) => x.boardId !== b.id);
    db.labels = db.labels.filter((x) => x.boardId !== b.id);
    db.activity = db.activity.filter((x) => x.boardId !== b.id);
    save();
    return [204];
  });

  // Members
  route('GET', '/api/boards/:id/members', ({ params, user }) => {
    const b = getBoard(params.id);
    requireRole(b.id, user, 'viewer');
    return [200, db.members.filter((m) => m.boardId === b.id).map(memberView)];
  });

  route('POST', '/api/boards/:id/members', ({ params, user, body }) => {
    const b = getBoard(params.id);
    requireRole(b.id, user, 'owner');
    if (typeof body.username !== 'string' || !body.username) throw bad('username is required');
    if (body.role !== 'editor' && body.role !== 'viewer') throw bad('role must be editor or viewer');
    const target = db.users.find((u) => u.username === body.username.toLowerCase());
    if (!target) throw notFound('User not found');
    if (memberRole(b.id, target.id)) throw conflict('User is already a member');
    const m = { boardId: b.id, userId: target.id, role: body.role };
    db.members.push(m);
    logActivity(b.id, 'member.added', user.id, { userId: target.id, username: target.username, role: m.role });
    save();
    return [201, { userId: target.id, username: target.username, role: m.role }];
  });

  route('PATCH', '/api/boards/:id/members/:userId', ({ params, user, body }) => {
    const b = getBoard(params.id);
    requireRole(b.id, user, 'owner');
    const m = db.members.find((x) => x.boardId === b.id && x.userId === params.userId);
    if (!m) throw notFound('Member not found');
    if (body.role !== 'editor' && body.role !== 'viewer') throw bad('role must be editor or viewer');
    if (m.role === 'owner') throw bad('Cannot change the owner role');
    const from = m.role;
    m.role = body.role;
    logActivity(b.id, 'member.updated', user.id, { userId: m.userId, fromRole: from, toRole: m.role });
    save();
    const u = userById(m.userId);
    return [200, { userId: m.userId, username: u?.username, role: m.role }];
  });

  route('DELETE', '/api/boards/:id/members/:userId', ({ params, user }) => {
    const b = getBoard(params.id);
    const myRole = requireRole(b.id, user, 'viewer');
    if (myRole !== 'owner' && params.userId !== user.id) throw forbidden('Only the owner can remove other members');
    const m = db.members.find((x) => x.boardId === b.id && x.userId === params.userId);
    if (!m) throw notFound('Member not found');
    if (m.role === 'owner') throw bad('Cannot remove the board owner');
    db.members = db.members.filter((x) => x !== m);
    for (const c of db.cards) {
      if (c.boardId === b.id && c.assignees.includes(m.userId)) c.assignees = c.assignees.filter((a) => a !== m.userId);
    }
    logActivity(b.id, 'member.removed', user.id, { userId: m.userId });
    save();
    return [204];
  });

  // Columns
  route('POST', '/api/boards/:id/columns', ({ params, user, body }) => {
    const b = getBoard(params.id);
    requireRole(b.id, user, 'editor');
    const name = checkString(body.name, 'name', 1, 100);
    const wipLimit = body.wipLimit === undefined ? null : validateWip(body.wipLimit);
    const col = { id: newId(), boardId: b.id, name, position: columnsOf(b.id).length, wipLimit };
    db.columns.push(col);
    logActivity(b.id, 'column.created', user.id, { columnId: col.id, name });
    save();
    return [201, { ...columnView(col), cards: [] }];
  });

  route('GET', '/api/columns/:id', ({ params, user }) => {
    const col = resolveColumn(params.id);
    requireRole(col.boardId, user, 'viewer');
    return [200, { ...columnView(col), cards: cardsOf(col.id).map(cardView) }];
  });

  route('PATCH', '/api/columns/:id', ({ params, user, body }) => {
    const col = resolveColumn(params.id);
    requireRole(col.boardId, user, 'editor');
    const name = body.name !== undefined ? checkString(body.name, 'name', 1, 100) : undefined;
    const wip = body.wipLimit !== undefined ? validateWip(body.wipLimit) : undefined;
    const pos = parsePosition(body.position);
    if (name !== undefined) col.name = name;
    if (wip !== undefined) col.wipLimit = wip;
    if (pos !== undefined) {
      const cols = columnsOf(col.boardId).filter((c) => c !== col);
      const p = clamp(pos, 0, cols.length);
      cols.splice(p, 0, col);
      cols.forEach((c, i) => (c.position = i));
    }
    logActivity(col.boardId, 'column.updated', user.id, { columnId: col.id });
    save();
    return [200, { ...columnView(col), cards: cardsOf(col.id).map(cardView) }];
  });

  route('DELETE', '/api/columns/:id', ({ params, user, query }) => {
    const col = resolveColumn(params.id);
    requireRole(col.boardId, user, 'editor');
    const cards = cardsOf(col.id);
    if (cards.length && query.get('force') !== 'true') throw conflict('Column still has cards', 'column_not_empty');
    deleteCardData(cards.map((c) => c.id));
    db.columns = db.columns.filter((c) => c !== col);
    compactColumns(col.boardId);
    logActivity(col.boardId, 'column.deleted', user.id, { columnId: col.id, name: col.name, deletedCards: cards.length });
    save();
    return [204];
  });

  // Cards
  route('POST', '/api/columns/:id/cards', ({ params, user, body }) => {
    const col = resolveColumn(params.id);
    requireRole(col.boardId, user, 'editor');
    const title = checkString(body.title, 'title', 1, 200);
    const description = body.description === undefined ? '' : validateDescription(body.description);
    const assignees = body.assignees === undefined || body.assignees === null ? [] : validateAssignees(col.boardId, body.assignees);
    const labels = body.labels === undefined || body.labels === null ? [] : validateLabels(col.boardId, body.labels);
    const dueDate = body.dueDate === undefined ? null : validateDue(body.dueDate);
    const pos = parsePosition(body.position);
    const existing = cardsOf(col.id);
    if (col.wipLimit != null && existing.length >= col.wipLimit) {
      throw conflict(`Column WIP limit of ${col.wipLimit} reached`, 'wip_limit');
    }
    const ts = nowIso();
    const card = {
      id: newId(), boardId: col.boardId, columnId: col.id, title, description, position: 0,
      assignees, labels, dueDate, createdBy: user.id, createdAt: ts, updatedAt: ts,
    };
    const p = pos === undefined ? existing.length : clamp(pos, 0, existing.length);
    existing.splice(p, 0, card);
    existing.forEach((c, i) => (c.position = i));
    db.cards.push(card);
    logActivity(col.boardId, 'card.created', user.id, { title, columnId: col.id }, card.id);
    save();
    return [201, cardView(card)];
  });

  route('GET', '/api/cards/:id', ({ params, user }) => {
    const card = resolveCard(params.id);
    requireRole(card.boardId, user, 'viewer');
    return [200, cardView(card)];
  });

  route('PATCH', '/api/cards/:id', ({ params, user, body }) => {
    const card = resolveCard(params.id);
    requireRole(card.boardId, user, 'editor');
    const changes = {};
    if (body.title !== undefined) changes.title = checkString(body.title, 'title', 1, 200);
    if (body.description !== undefined) changes.description = validateDescription(body.description);
    if (body.assignees !== undefined) changes.assignees = body.assignees === null ? [] : validateAssignees(card.boardId, body.assignees);
    if (body.labels !== undefined) changes.labels = body.labels === null ? [] : validateLabels(card.boardId, body.labels);
    if (body.dueDate !== undefined) changes.dueDate = validateDue(body.dueDate);
    Object.assign(card, changes);
    let ts = nowIso();
    if (ts <= card.updatedAt) ts = new Date(Date.parse(card.updatedAt) + 1).toISOString();
    card.updatedAt = ts;
    logActivity(card.boardId, 'card.updated', user.id, { fields: Object.keys(changes) }, card.id);
    save();
    return [200, cardView(card)];
  });

  route('DELETE', '/api/cards/:id', ({ params, user }) => {
    const card = resolveCard(params.id);
    requireRole(card.boardId, user, 'editor');
    deleteCardData([card.id]);
    compactCards(card.columnId);
    logActivity(card.boardId, 'card.deleted', user.id, { title: card.title, columnId: card.columnId }, card.id);
    save();
    return [204];
  });

  route('POST', '/api/cards/:id/move', ({ params, user, body }) => {
    const card = resolveCard(params.id);
    requireRole(card.boardId, user, 'editor');
    if (typeof body.columnId !== 'string' || !body.columnId) throw bad('columnId is required');
    const pos = parsePosition(body.position);
    const target = db.columns.find((c) => c.id === body.columnId);
    if (!target) throw notFound('Target column not found');
    if (target.boardId !== card.boardId) throw bad('Target column must be on the same board');
    const fromColumnId = card.columnId;
    const fromPosition = card.position;
    const sameColumn = target.id === fromColumnId;
    const targetCards = cardsOf(target.id).filter((c) => c !== card);
    if (!sameColumn && target.wipLimit != null && targetCards.length >= target.wipLimit) {
      throw conflict(`Column WIP limit of ${target.wipLimit} reached`, 'wip_limit');
    }
    card.columnId = target.id;
    const p = pos === undefined ? targetCards.length : clamp(pos, 0, targetCards.length);
    targetCards.splice(p, 0, card);
    targetCards.forEach((c, i) => (c.position = i));
    if (!sameColumn) compactCards(fromColumnId);
    card.updatedAt = nowIso();
    logActivity(card.boardId, 'card.moved', user.id, {
      fromColumnId, toColumnId: target.id, fromPosition, toPosition: card.position,
    }, card.id);
    save();
    return [200, cardView(card)];
  });

  // Labels
  route('GET', '/api/boards/:id/labels', ({ params, user }) => {
    const b = getBoard(params.id);
    requireRole(b.id, user, 'viewer');
    return [200, db.labels.filter((l) => l.boardId === b.id).map(labelView)];
  });

  function validateColor(v) {
    if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) throw bad('color must be #rrggbb');
    return v;
  }

  route('POST', '/api/boards/:id/labels', ({ params, user, body }) => {
    const b = getBoard(params.id);
    requireRole(b.id, user, 'editor');
    const name = checkString(body.name, 'name', 1, 50);
    const color = validateColor(body.color);
    if (db.labels.some((l) => l.boardId === b.id && l.name.toLowerCase() === name.toLowerCase())) {
      throw conflict('Label name already exists on this board');
    }
    const label = { id: newId(), boardId: b.id, name, color };
    db.labels.push(label);
    logActivity(b.id, 'label.created', user.id, { labelId: label.id, name });
    save();
    return [201, labelView(label)];
  });

  route('PATCH', '/api/labels/:id', ({ params, user, body }) => {
    const label = db.labels.find((l) => l.id === params.id);
    if (!label) throw notFound('Label not found');
    requireRole(label.boardId, user, 'editor');
    const name = body.name !== undefined ? checkString(body.name, 'name', 1, 50) : undefined;
    const color = body.color !== undefined ? validateColor(body.color) : undefined;
    if (name !== undefined && db.labels.some((l) => l !== label && l.boardId === label.boardId && l.name.toLowerCase() === name.toLowerCase())) {
      throw conflict('Label name already exists on this board');
    }
    if (name !== undefined) label.name = name;
    if (color !== undefined) label.color = color;
    save();
    return [200, labelView(label)];
  });

  route('DELETE', '/api/labels/:id', ({ params, user }) => {
    const label = db.labels.find((l) => l.id === params.id);
    if (!label) throw notFound('Label not found');
    requireRole(label.boardId, user, 'editor');
    db.labels = db.labels.filter((l) => l !== label);
    for (const c of db.cards) {
      if (c.labels.includes(label.id)) c.labels = c.labels.filter((x) => x !== label.id);
    }
    logActivity(label.boardId, 'label.deleted', user.id, { labelId: label.id, name: label.name });
    save();
    return [204];
  });

  // Comments
  const commentView = (c) => ({ id: c.id, cardId: c.cardId, authorId: c.authorId, body: c.body, createdAt: c.createdAt });

  route('POST', '/api/cards/:id/comments', ({ params, user, body }) => {
    const card = resolveCard(params.id);
    requireRole(card.boardId, user, 'editor');
    const text = checkString(body.body, 'body', 1, 5000);
    const comment = { id: newId(), cardId: card.id, boardId: card.boardId, authorId: user.id, body: text, createdAt: nowIso(), seq: db.comments.length };
    db.comments.push(comment);
    logActivity(card.boardId, 'comment.added', user.id, { commentId: comment.id }, card.id);
    save();
    return [201, commentView(comment)];
  });

  route('GET', '/api/cards/:id/comments', ({ params, user }) => {
    const card = resolveCard(params.id);
    requireRole(card.boardId, user, 'viewer');
    // db.comments is append-only ordered, so array order = oldest first
    return [200, db.comments.filter((c) => c.cardId === card.id).map(commentView)];
  });

  route('DELETE', '/api/comments/:id', ({ params, user }) => {
    const comment = db.comments.find((c) => c.id === params.id);
    if (!comment) throw notFound('Comment not found');
    const card = db.cards.find((c) => c.id === comment.cardId);
    const boardId = card ? card.boardId : comment.boardId;
    const role = requireRole(boardId, user, 'viewer');
    if (comment.authorId !== user.id && role !== 'owner') throw forbidden('Only the author or board owner can delete this comment');
    db.comments = db.comments.filter((c) => c !== comment);
    logActivity(boardId, 'comment.deleted', user.id, { commentId: comment.id }, comment.cardId);
    save();
    return [204];
  });

  // Search
  route('GET', '/api/boards/:id/cards', ({ params, user, query }) => {
    const b = getBoard(params.id);
    requireRole(b.id, user, 'viewer');
    const q = query.get('q');
    const assignee = query.get('assignee');
    const label = query.get('label');
    const column = query.get('column');
    const dueBefore = query.get('due_before');
    if (dueBefore && !isValidDate(dueBefore)) throw bad('due_before must be YYYY-MM-DD');
    const ql = q ? q.toLowerCase() : '';
    const colPos = new Map(columnsOf(b.id).map((c) => [c.id, c.position]));
    const result = db.cards.filter((c) => {
      if (c.boardId !== b.id) return false;
      if (ql && !c.title.toLowerCase().includes(ql) && !(c.description || '').toLowerCase().includes(ql)) return false;
      if (assignee && !c.assignees.includes(assignee)) return false;
      if (label && !c.labels.includes(label)) return false;
      if (column && c.columnId !== column) return false;
      if (dueBefore && (!c.dueDate || !(c.dueDate < dueBefore))) return false;
      return true;
    }).sort((a, z) => (colPos.get(a.columnId) - colPos.get(z.columnId)) || (a.position - z.position));
    return [200, result.map(cardView)];
  });

  // Activity
  route('GET', '/api/boards/:id/activity', ({ params, user, query }) => {
    const b = getBoard(params.id);
    requireRole(b.id, user, 'viewer');
    let limit = 50;
    const raw = query.get('limit');
    if (raw !== null && raw !== '') {
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw bad('limit must be a positive integer');
      limit = Math.min(Number(raw), 1000);
    }
    const entries = [];
    for (let i = db.activity.length - 1; i >= 0 && entries.length < limit; i--) {
      const a = db.activity[i];
      if (a.boardId === b.id) entries.push(a);
    }
    return [200, entries];
  });

  // ---------- request handling ----------
  function send(res, status, body, headers = {}) {
    if (body === undefined || status === 204) {
      res.writeHead(status, headers);
      res.end();
      return;
    }
    const payload = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload), ...headers });
    res.end(payload);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > 2 * 1024 * 1024) {
          reject(new HttpError(413, 'payload_too_large', 'Request body too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    let file;
    if (pathname === '/' || pathname === '/index.html') file = INDEX_HTML_PATH;
    else if (pathname.startsWith('/static/')) {
      const rel = decodeURIComponent(pathname.slice('/static/'.length));
      file = path.join(STATIC_DIR, rel);
      if (!file.startsWith(STATIC_DIR + path.sep)) return false;
    } else return false;
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
    const ext = path.extname(file);
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
    const data = fs.readFileSync(file);
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream', 'Content-Length': data.length });
    res.end(req.method === 'HEAD' ? undefined : data);
    return true;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/') && serveStatic(req, res, pathname)) return;

    let matched = null;
    let params = {};
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(pathname);
      if (m) {
        matched = r;
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        break;
      }
    }
    if (!matched) throw notFound('Route not found');

    let user = null;
    let token = null;
    if (matched.auth) {
      const h = req.headers.authorization || '';
      const m = /^Bearer\s+(\S+)$/i.exec(h);
      token = m ? m[1] : null;
      const uid = token ? sessions.get(token) : null;
      user = uid ? userById(uid) : null;
      if (!user) throw unauth();
    }

    let body = {};
    if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
      const raw = await readBody(req);
      if (raw.trim()) {
        try {
          body = JSON.parse(raw);
        } catch {
          throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON');
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('Request body must be a JSON object');
      }
    } else {
      req.resume();
    }

    const [status, out] = matched.handler({ req, params, query: url.searchParams, body, user, token });
    send(res, status, out);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof HttpError) {
        send(res, err.status, { error: err.code, message: err.message, ...(err.extra || {}) });
      } else {
        console.error(err);
        send(res, 500, { error: 'internal_error', message: 'Internal server error' });
      }
    });
  });
  return server;
}
