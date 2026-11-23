import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const USERNAME_RE = /^[a-z0-9_]{3,32}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const MAX_BODY = 1024 * 1024;
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}
const bad = (msg) => new HttpError(400, 'validation', msg);
const unauthorized = (msg = 'authentication required') => new HttpError(401, 'unauthenticated', msg);
const forbidden = (msg = 'forbidden') => new HttpError(403, 'forbidden', msg);
const notFound = (msg = 'not found') => new HttpError(404, 'not_found', msg);
const conflict = (msg, code = 'conflict') => new HttpError(409, code, msg);

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

function emptyState() {
  return { users: {}, boards: {}, columns: {}, cards: {}, labels: {}, comments: {}, activity: [] };
}

function loadState(file) {
  if (!file || !fs.existsSync(file)) return emptyState();
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return emptyState();
  return { ...emptyState(), ...JSON.parse(raw) };
}

function saveState(file, state) {
  if (!file) return;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(pw, stored) {
  const [, saltHex, hashHex] = stored.split('$');
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(pw, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function isDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function requireObject(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('body must be a JSON object');
  return body;
}

function cleanStr(v, name, min, max, trim = true) {
  if (typeof v !== 'string') throw bad(`${name} must be a string`);
  const s = trim ? v.trim() : v;
  if (s.length < min || s.length > max) throw bad(`${name} must be ${min}-${max} characters`);
  return s;
}

function cleanDescription(v) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string' || v.length > 10000) throw bad('description must be a string up to 10000 characters');
  return v;
}

function cleanDueDate(v) {
  if (v === undefined || v === null) return null;
  if (!isDate(v)) throw bad('dueDate must be YYYY-MM-DD or null');
  return v;
}

function cleanPosition(v) {
  if (v === undefined || v === null) return undefined;
  if (!Number.isInteger(v)) throw bad('position must be an integer');
  return v;
}

function cleanWip(v) {
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v) || v <= 0) throw bad('wipLimit must be a positive integer or null');
  return v;
}

function cleanRole(v, allowed) {
  if (!allowed.includes(v)) throw bad(`role must be one of ${allowed.join(', ')}`);
  return v;
}

function publicUser(u) {
  return { id: u.id, username: u.username, displayName: u.displayName };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'payload_too_large', 'body too large'));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const s = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

function sendStatic(res, rel) {
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) throw notFound();
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  res.end(fs.readFileSync(file));
}

export function createServer({ dataFile } = {}) {
  const state = loadState(dataFile);
  const tokens = new Map(); // token -> userId (in memory only)
  const loginFailures = new Map(); // username -> [timestamps]
  const routes = [];
  const add = (method, pattern, auth, handler) =>
    routes.push({ method, re: new RegExp(`^${pattern}$`), auth, handler });
  const ID = '([^/]+)';

  // ---------- lookups ----------
  const loadBoard = (id) => {
    const b = state.boards[id];
    if (!b) throw notFound('board not found');
    return b;
  };
  const loadColumn = (id) => {
    const c = state.columns[id];
    if (!c) throw notFound('column not found');
    return c;
  };
  const loadCard = (id) => {
    const c = state.cards[id];
    if (!c) throw notFound('card not found');
    return c;
  };
  const loadLabel = (id) => {
    const l = state.labels[id];
    if (!l) throw notFound('label not found');
    return l;
  };
  const boardMember = (board, userId) => board.members.find((m) => m.userId === userId);
  const requireBoard = (id, user, minRole = 'viewer') => {
    const b = loadBoard(id);
    const m = boardMember(b, user.id);
    if (!m) throw forbidden('not a board member');
    if (ROLE_RANK[m.role] < ROLE_RANK[minRole]) throw forbidden('insufficient role');
    return b;
  };
  const boardColumns = (boardId) =>
    Object.values(state.columns)
      .filter((c) => c.boardId === boardId)
      .sort((a, b) => a.position - b.position);
  const cardsInColumn = (columnId) =>
    Object.values(state.cards)
      .filter((c) => c.columnId === columnId)
      .sort((a, b) => a.position - b.position);
  const boardLabels = (boardId) => Object.values(state.labels).filter((l) => l.boardId === boardId);
  const compact = (list) => list.forEach((x, i) => { x.position = i; });

  // ---------- views ----------
  const cardView = (c) => ({
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
  const colView = (c) => ({
    id: c.id,
    boardId: c.boardId,
    name: c.name,
    position: c.position,
    wipLimit: c.wipLimit,
    cards: cardsInColumn(c.id).map(cardView),
  });
  const labelView = (l) => ({ id: l.id, boardId: l.boardId, name: l.name, color: l.color });
  const boardView = (b) => ({
    id: b.id,
    name: b.name,
    description: b.description,
    ownerId: b.ownerId,
    createdAt: b.createdAt,
    members: b.members.map((m) => ({ userId: m.userId, username: state.users[m.userId]?.username, role: m.role })),
    labels: boardLabels(b.id).map(labelView),
    columns: boardColumns(b.id).map(colView),
  });

  // ---------- helpers ----------
  const log = (boardId, type, actorId, details = {}, cardId) => {
    const e = { id: uid(), boardId, type, actorId, at: now(), details };
    if (cardId) e.cardId = cardId;
    state.activity.push(e);
  };
  const removeCommentsOf = (cardId) => {
    for (const c of Object.values(state.comments)) if (c.cardId === cardId) delete state.comments[c.id];
  };
  const removeCard = (card, actorId) => {
    removeCommentsOf(card.id);
    delete state.cards[card.id];
    compact(cardsInColumn(card.columnId));
    log(card.boardId, 'card.deleted', actorId, { title: card.title, columnId: card.columnId }, card.id);
  };
  const placeCard = (card, columnId, position) => {
    const list = cardsInColumn(columnId).filter((c) => c.id !== card.id);
    const idx = position === undefined ? list.length : clamp(position, 0, list.length);
    list.splice(idx, 0, card);
    compact(list);
  };
  const placeColumn = (col, position) => {
    const list = boardColumns(col.boardId).filter((c) => c.id !== col.id);
    list.splice(clamp(position, 0, list.length), 0, col);
    compact(list);
  };
  const cleanAssignees = (board, v) => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw bad('assignees must be an array of user ids');
    const out = [...new Set(v)];
    for (const id of out) if (!boardMember(board, id)) throw bad(`assignee ${id} is not a board member`);
    return out;
  };
  const cleanLabels = (board, v) => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw bad('labels must be an array of label ids');
    const out = [...new Set(v)];
    for (const id of out) {
      const l = state.labels[id];
      if (!l || l.boardId !== board.id) throw bad(`label ${id} does not belong to this board`);
    }
    return out;
  };
  const deleteBoard = (b) => {
    for (const c of Object.values(state.cards)) if (c.boardId === b.id) removeCommentsOf(c.id);
    for (const c of Object.values(state.cards)) if (c.boardId === b.id) delete state.cards[c.id];
    for (const c of Object.values(state.columns)) if (c.boardId === b.id) delete state.columns[c.id];
    for (const l of Object.values(state.labels)) if (l.boardId === b.id) delete state.labels[l.id];
    state.activity = state.activity.filter((a) => a.boardId !== b.id);
    delete state.boards[b.id];
  };

  // ---------- auth ----------
  const authenticate = (req) => {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization || '');
    if (!m) throw unauthorized();
    const userId = tokens.get(m[1]);
    const user = userId && state.users[userId];
    if (!user) throw unauthorized('invalid or logged-out token');
    return { user, token: m[1] };
  };

  // ---------- auth routes ----------
  add('POST', '/api/auth/register', false, ({ body }) => {
    const b = requireObject(body);
    if (typeof b.username !== 'string') throw bad('username must be a string');
    const username = b.username.toLowerCase();
    if (!USERNAME_RE.test(username)) throw bad('username must be 3-32 chars of [a-z0-9_]');
    if (typeof b.password !== 'string' || b.password.length < 8) throw bad('password must be at least 8 characters');
    const displayName = b.displayName === undefined || b.displayName === null
      ? username
      : cleanStr(b.displayName, 'displayName', 1, 100);
    if (Object.values(state.users).some((u) => u.username === username)) throw conflict('username taken');
    const user = { id: uid(), username, displayName, passwordHash: hashPassword(b.password) };
    state.users[user.id] = user;
    return { status: 201, data: { user: publicUser(user) } };
  });

  add('POST', '/api/auth/login', false, ({ body }) => {
    const b = requireObject(body);
    if (typeof b.username !== 'string' || typeof b.password !== 'string') throw bad('username and password are required');
    const username = b.username.toLowerCase();
    const cutoff = Date.now() - LOGIN_WINDOW_MS;
    const fails = (loginFailures.get(username) || []).filter((t) => t > cutoff);
    loginFailures.set(username, fails);
    if (fails.length >= LOGIN_MAX_FAILURES) {
      throw new HttpError(429, 'rate_limited', 'too many failed login attempts; try again later');
    }
    const user = Object.values(state.users).find((u) => u.username === username);
    if (!user || !verifyPassword(b.password, user.passwordHash)) {
      fails.push(Date.now());
      throw unauthorized('invalid credentials');
    }
    const token = crypto.randomBytes(32).toString('hex');
    tokens.set(token, user.id);
    return { status: 200, data: { token, user: publicUser(user) } };
  });

  add('POST', '/api/auth/logout', true, ({ token }) => {
    tokens.delete(token);
    return null;
  });

  add('GET', '/api/auth/me', true, ({ user }) => ({ status: 200, data: { user: publicUser(user) } }));

  // ---------- boards ----------
  add('POST', '/api/boards', true, ({ user, body }) => {
    const b = requireObject(body);
    const name = cleanStr(b.name, 'name', 1, 100);
    const description = cleanDescription(b.description);
    let columnNames = ['To Do', 'In Progress', 'Done'];
    if (b.columns !== undefined && b.columns !== null) {
      if (!Array.isArray(b.columns)) throw bad('columns must be an array of names');
      columnNames = b.columns.map((n) => cleanStr(n, 'column name', 1, 100));
    }
    const board = {
      id: uid(),
      name,
      description,
      ownerId: user.id,
      createdAt: now(),
      members: [{ userId: user.id, role: 'owner' }],
    };
    state.boards[board.id] = board;
    columnNames.forEach((n, i) => {
      const col = { id: uid(), boardId: board.id, name: n, position: i, wipLimit: null };
      state.columns[col.id] = col;
    });
    log(board.id, 'board.created', user.id, { name });
    return { status: 201, data: boardView(board) };
  });

  add('GET', '/api/boards', true, ({ user }) => {
    const out = Object.values(state.boards)
      .map((b) => ({ b, m: boardMember(b, user.id) }))
      .filter((x) => x.m)
      .map(({ b, m }) => ({ id: b.id, name: b.name, role: m.role }));
    return { status: 200, data: out };
  });

  add('GET', `/api/boards/${ID}`, true, ({ user, params }) => {
    const b = requireBoard(params[0], user, 'viewer');
    return { status: 200, data: boardView(b) };
  });

  add('PATCH', `/api/boards/${ID}`, true, ({ user, params, body }) => {
    const b = requireBoard(params[0], user, 'owner');
    const p = requireObject(body);
    const name = p.name === undefined ? undefined : cleanStr(p.name, 'name', 1, 100);
    const description = p.description === undefined ? undefined : cleanDescription(p.description);
    if (name !== undefined) b.name = name;
    if (description !== undefined) b.description = description;
    return { status: 200, data: boardView(b) };
  });

  add('DELETE', `/api/boards/${ID}`, true, ({ user, params }) => {
    const b = requireBoard(params[0], user, 'owner');
    deleteBoard(b);
    return null;
  });

  // ---------- members ----------
  add('POST', `/api/boards/${ID}/members`, true, ({ user, params, body }) => {
    const b = requireBoard(params[0], user, 'owner');
    const p = requireObject(body);
    if (typeof p.username !== 'string') throw bad('username must be a string');
    const role = cleanRole(p.role, ['editor', 'viewer']);
    const target = Object.values(state.users).find((u) => u.username === p.username.toLowerCase());
    if (!target) throw notFound('user not found');
    if (boardMember(b, target.id)) throw conflict('already a member');
    b.members.push({ userId: target.id, role });
    log(b.id, 'member.added', user.id, { userId: target.id, username: target.username, role });
    return { status: 201, data: { userId: target.id, username: target.username, role } };
  });

  add('PATCH', `/api/boards/${ID}/members/${ID}`, true, ({ user, params, body }) => {
    const b = requireBoard(params[0], user, 'owner');
    const p = requireObject(body);
    const m = boardMember(b, params[1]);
    if (!m) throw notFound('member not found');
    const role = cleanRole(p.role, ['editor', 'viewer']);
    if (m.role === 'owner') throw bad('cannot change the owner role');
    m.role = role;
    return { status: 200, data: { userId: m.userId, username: state.users[m.userId]?.username, role } };
  });

  add('DELETE', `/api/boards/${ID}/members/${ID}`, true, ({ user, params }) => {
    const b = requireBoard(params[0], user, 'viewer');
    const m = boardMember(b, params[1]);
    if (!m) throw notFound('member not found');
    const isOwner = boardMember(b, user.id).role === 'owner';
    if (!isOwner && user.id !== params[1]) throw forbidden('only the owner can remove other members');
    if (m.role === 'owner') throw bad('cannot remove the board owner');
    b.members = b.members.filter((x) => x.userId !== params[1]);
    for (const c of Object.values(state.cards)) {
      if (c.boardId === b.id) c.assignees = c.assignees.filter((a) => a !== params[1]);
    }
    return null;
  });

  // ---------- columns ----------
  add('POST', `/api/boards/${ID}/columns`, true, ({ user, params, body }) => {
    const b = requireBoard(params[0], user, 'editor');
    const p = requireObject(body);
    const name = cleanStr(p.name, 'name', 1, 100);
    const wipLimit = cleanWip(p.wipLimit);
    const col = { id: uid(), boardId: b.id, name, position: boardColumns(b.id).length, wipLimit };
    state.columns[col.id] = col;
    log(b.id, 'column.created', user.id, { columnId: col.id, name });
    return { status: 201, data: colView(col) };
  });

  add('PATCH', '/api/columns/' + ID, true, ({ user, params, body }) => {
    const col = loadColumn(params[0]);
    requireBoard(col.boardId, user, 'editor');
    const p = requireObject(body);
    const name = p.name === undefined ? undefined : cleanStr(p.name, 'name', 1, 100);
    const wipLimit = p.wipLimit === undefined ? undefined : cleanWip(p.wipLimit);
    const position = p.position === undefined ? undefined : cleanPosition(p.position);
    if (name !== undefined) col.name = name;
    if (wipLimit !== undefined) col.wipLimit = wipLimit;
    if (position !== undefined) placeColumn(col, position);
    return { status: 200, data: colView(col) };
  });

  add('DELETE', '/api/columns/' + ID, true, ({ user, params, query }) => {
    const col = loadColumn(params[0]);
    requireBoard(col.boardId, user, 'editor');
    const cards = cardsInColumn(col.id);
    if (cards.length > 0 && query.get('force') !== 'true') {
      throw conflict('column is not empty; use ?force=true', 'conflict');
    }
    for (const c of cards) removeCard(c, user.id);
    delete state.columns[col.id];
    compact(boardColumns(col.boardId));
    return null;
  });

  // ---------- cards ----------
  add('POST', `/api/columns/${ID}/cards`, true, ({ user, params, body }) => {
    const col = loadColumn(params[0]);
    const b = requireBoard(col.boardId, user, 'editor');
    const p = requireObject(body);
    const title = cleanStr(p.title, 'title', 1, 200);
    const description = cleanDescription(p.description);
    const assignees = cleanAssignees(b, p.assignees);
    const labels = cleanLabels(b, p.labels);
    const dueDate = cleanDueDate(p.dueDate);
    const position = cleanPosition(p.position);
    if (col.wipLimit && cardsInColumn(col.id).length >= col.wipLimit) {
      throw conflict('WIP limit reached for this column', 'wip_limit');
    }
    const t = now();
    const card = {
      id: uid(),
      boardId: b.id,
      columnId: col.id,
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
    state.cards[card.id] = card;
    placeCard(card, col.id, position);
    log(b.id, 'card.created', user.id, { title, columnId: col.id }, card.id);
    return { status: 201, data: cardView(card) };
  });

  add('GET', '/api/cards/' + ID, true, ({ user, params }) => {
    const card = loadCard(params[0]);
    requireBoard(card.boardId, user, 'viewer');
    return { status: 200, data: cardView(card) };
  });

  add('PATCH', '/api/cards/' + ID, true, ({ user, params, body }) => {
    const card = loadCard(params[0]);
    const b = requireBoard(card.boardId, user, 'editor');
    const p = requireObject(body);
    const changes = {};
    if (p.title !== undefined) changes.title = cleanStr(p.title, 'title', 1, 200);
    if (p.description !== undefined) changes.description = cleanDescription(p.description);
    if (p.assignees !== undefined) changes.assignees = cleanAssignees(b, p.assignees);
    if (p.labels !== undefined) changes.labels = cleanLabels(b, p.labels);
    if (p.dueDate !== undefined) changes.dueDate = cleanDueDate(p.dueDate);
    Object.assign(card, changes);
    card.updatedAt = now();
    log(b.id, 'card.updated', user.id, { changes: Object.keys(changes) }, card.id);
    return { status: 200, data: cardView(card) };
  });

  add('DELETE', '/api/cards/' + ID, true, ({ user, params }) => {
    const card = loadCard(params[0]);
    requireBoard(card.boardId, user, 'editor');
    removeCard(card, user.id);
    return null;
  });

  add('POST', `/api/cards/${ID}/move`, true, ({ user, params, body }) => {
    const card = loadCard(params[0]);
    const b = requireBoard(card.boardId, user, 'editor');
    const p = requireObject(body);
    if (typeof p.columnId !== 'string') throw bad('columnId must be a string');
    const target = state.columns[p.columnId];
    if (!target || target.boardId !== b.id) throw bad('target column must be on the same board');
    const position = cleanPosition(p.position);
    const fromColumnId = card.columnId;
    if (fromColumnId !== target.id && target.wipLimit && cardsInColumn(target.id).length >= target.wipLimit) {
      throw conflict('WIP limit reached for target column', 'wip_limit');
    }
    card.columnId = target.id;
    if (fromColumnId !== target.id) compact(cardsInColumn(fromColumnId));
    placeCard(card, target.id, position);
    card.updatedAt = now();
    log(b.id, 'card.moved', user.id, { fromColumnId, toColumnId: target.id, position: card.position }, card.id);
    return { status: 200, data: cardView(card) };
  });

  add('GET', `/api/boards/${ID}/cards`, true, ({ user, params, query }) => {
    const b = requireBoard(params[0], user, 'viewer');
    const q = query.get('q');
    const assignee = query.get('assignee');
    const label = query.get('label');
    const column = query.get('column');
    const dueBefore = query.get('due_before');
    if (dueBefore && !isDate(dueBefore)) throw bad('due_before must be YYYY-MM-DD');
    const needle = q ? q.toLowerCase() : '';
    const colPos = new Map(boardColumns(b.id).map((c) => [c.id, c.position]));
    const list = Object.values(state.cards)
      .filter((c) => c.boardId === b.id)
      .filter((c) => !needle || c.title.toLowerCase().includes(needle) || (c.description || '').toLowerCase().includes(needle))
      .filter((c) => !assignee || c.assignees.includes(assignee))
      .filter((c) => !label || c.labels.includes(label))
      .filter((c) => !column || c.columnId === column)
      .filter((c) => !dueBefore || (c.dueDate && c.dueDate < dueBefore))
      .sort((x, y) => (colPos.get(x.columnId) - colPos.get(y.columnId)) || (x.position - y.position));
    return { status: 200, data: list.map(cardView) };
  });

  // ---------- labels ----------
  add('POST', `/api/boards/${ID}/labels`, true, ({ user, params, body }) => {
    const b = requireBoard(params[0], user, 'editor');
    const p = requireObject(body);
    const name = cleanStr(p.name, 'name', 1, 50);
    if (typeof p.color !== 'string' || !COLOR_RE.test(p.color)) throw bad('color must be #rrggbb');
    if (boardLabels(b.id).some((l) => l.name.toLowerCase() === name.toLowerCase())) {
      throw conflict('label name already exists on this board');
    }
    const label = { id: uid(), boardId: b.id, name, color: p.color };
    state.labels[label.id] = label;
    return { status: 201, data: labelView(label) };
  });

  add('DELETE', '/api/labels/' + ID, true, ({ user, params }) => {
    const label = loadLabel(params[0]);
    requireBoard(label.boardId, user, 'editor');
    delete state.labels[label.id];
    for (const c of Object.values(state.cards)) c.labels = c.labels.filter((l) => l !== label.id);
    return null;
  });

  // ---------- comments ----------
  add('POST', `/api/cards/${ID}/comments`, true, ({ user, params, body }) => {
    const card = loadCard(params[0]);
    requireBoard(card.boardId, user, 'editor');
    const p = requireObject(body);
    if (typeof p.body !== 'string' || p.body.trim().length === 0 || p.body.length > 5000) {
      throw bad('body must be 1-5000 characters');
    }
    const comment = { id: uid(), cardId: card.id, authorId: user.id, body: p.body, createdAt: now() };
    state.comments[comment.id] = comment;
    log(card.boardId, 'comment.added', user.id, { commentId: comment.id }, card.id);
    return { status: 201, data: { ...comment } };
  });

  add('GET', `/api/cards/${ID}/comments`, true, ({ user, params }) => {
    const card = loadCard(params[0]);
    requireBoard(card.boardId, user, 'viewer');
    const list = Object.values(state.comments)
      .filter((c) => c.cardId === card.id)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    return { status: 200, data: list.map((c) => ({ ...c })) };
  });

  add('DELETE', '/api/comments/' + ID, true, ({ user, params }) => {
    const comment = state.comments[params[0]];
    if (!comment) throw notFound('comment not found');
    const card = loadCard(comment.cardId);
    const b = requireBoard(card.boardId, user, 'viewer');
    if (comment.authorId !== user.id && boardMember(b, user.id).role !== 'owner') {
      throw forbidden('only the author or board owner can delete this comment');
    }
    delete state.comments[comment.id];
    return null;
  });

  // ---------- activity ----------
  add('GET', `/api/boards/${ID}/activity`, true, ({ user, params, query }) => {
    const b = requireBoard(params[0], user, 'viewer');
    const raw = query.get('limit');
    let limit = 50;
    if (raw !== null && raw !== '') {
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw bad('limit must be a positive integer');
      limit = Number(raw);
    }
    const list = state.activity.filter((a) => a.boardId === b.id).reverse().slice(0, limit);
    return { status: 200, data: list.map((a) => ({ ...a })) };
  });

  // ---------- dispatch ----------
  async function handle(req, res) {
    const raw = await readBody(req);
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    if (req.method === 'GET' && p === '/') return sendStatic(res, 'index.html');
    if (req.method === 'GET' && p.startsWith('/static/')) {
      let rel;
      try { rel = decodeURIComponent(p.slice('/static/'.length)); } catch { throw notFound(); }
      return sendStatic(res, rel);
    }
    let route = null;
    let params = null;
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(p);
      if (m) {
        route = r;
        try { params = m.slice(1).map(decodeURIComponent); } catch { throw notFound(); }
        break;
      }
    }
    if (!route) throw notFound('no such route');
    const ctx = { params, query: url.searchParams, user: null, token: null, body: {} };
    if (route.auth) Object.assign(ctx, authenticate(req));
    if (raw.trim()) {
      try { ctx.body = JSON.parse(raw); } catch { throw bad('invalid JSON body'); }
    }
    const out = route.handler(ctx);
    if (dataFile && req.method !== 'GET') saveState(dataFile, state);
    if (!out) {
      res.writeHead(204);
      return res.end();
    }
    return sendJson(res, out.status, out.data);
  }

  return http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) return res.end();
      if (err instanceof HttpError) {
        sendJson(res, err.status, { error: err.code, message: err.message });
      } else {
        console.error(err);
        sendJson(res, 500, { error: 'internal', message: 'internal error' });
      }
    });
  });
}
