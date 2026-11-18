// kanban-s3: JSON REST API over node:http, plus a static single-page UI.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(HERE, 'static');
const MAX_BODY = 1024 * 1024;
const DEFAULT_COLUMNS = ['To Do', 'In Progress', 'Done'];
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const USERNAME_RE = /^[a-z0-9_]{3,32}$/;
const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml' };

class HttpError extends Error {
  constructor(status, error, message) {
    super(message || error);
    this.status = status;
    this.error = error;
  }
}
const bad = (msg) => new HttpError(400, 'validation', msg);
const unauthenticated = (msg = 'Authentication required') => new HttpError(401, 'unauthenticated', msg);
const forbidden = (msg = 'Forbidden') => new HttpError(403, 'forbidden', msg);
const notFound = (msg = 'Not found') => new HttpError(404, 'not_found', msg);
const conflict = (msg, code = 'conflict') => new HttpError(409, code, msg);
const rateLimited = (msg) => new HttpError(429, 'rate_limited', msg);

const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();
const isStr = (v) => typeof v === 'string';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function emptyData() {
  return { users: [], boards: [], members: [], columns: [], cards: [], labels: [], comments: [], activity: [] };
}

function loadData(file) {
  if (!file || !fs.existsSync(file)) return emptyData();
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return emptyData();
  return { ...emptyData(), ...JSON.parse(raw) };
}

function saveData(file, data) {
  if (!file) return;
  const abs = path.resolve(file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.${uuid()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, abs);
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) tooLarge = true;
      else chunks.push(chunk);
    });
    req.on('end', () => (tooLarge ? reject(bad('Request body too large')) : resolve(Buffer.concat(chunks).toString('utf8'))));
    req.on('error', reject);
  });
}

function parseBody(raw) {
  if (!raw || !raw.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw bad('Invalid JSON body');
  }
  if (!isObj(parsed)) throw bad('Body must be a JSON object');
  return parsed;
}

function send(res, status, payload) {
  if (status === 204 || payload === undefined) {
    res.writeHead(204);
    res.end();
    return;
  }
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function sendError(res, err) {
  send(res, err.status, { error: err.error, message: err.message });
}

function compileRoute(method, pattern, handler, options = {}) {
  const names = [];
  const source = pattern.replace(/:([a-zA-Z]+)/g, (_, name) => {
    names.push(name);
    return '([^/]+)';
  });
  return { method, re: new RegExp(`^${source}/?$`), names, handler, public: !!options.public };
}

export function createServer({ dataFile } = {}) {
  const data = loadData(dataFile);
  const sessions = new Map(); // token -> userId (sessions are not persisted)
  const loginFailures = new Map(); // lower-case username -> [timestamps ms]

  // ---------- lookups and access ----------
  const userById = (id) => data.users.find((u) => u.id === id);
  const publicUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName });
  const boardOr404 = (id) => {
    const board = data.boards.find((b) => b.id === id);
    if (!board) throw notFound('Board not found');
    return board;
  };
  const columnOr404 = (id) => {
    const col = data.columns.find((c) => c.id === id);
    if (!col) throw notFound('Column not found');
    return col;
  };
  const cardOr404 = (id) => {
    const card = data.cards.find((c) => c.id === id);
    if (!card) throw notFound('Card not found');
    return card;
  };
  const labelOr404 = (id) => {
    const label = data.labels.find((l) => l.id === id);
    if (!label) throw notFound('Label not found');
    return label;
  };
  const commentOr404 = (id) => {
    const c = data.comments.find((x) => x.id === id);
    if (!c) throw notFound('Comment not found');
    return c;
  };
  const roleOf = (boardId, userId) => data.members.find((m) => m.boardId === boardId && m.userId === userId)?.role ?? null;
  const requireRole = (boardId, userId, minRole) => {
    const role = roleOf(boardId, userId);
    if (!role) throw forbidden('Not a member of this board');
    if (ROLE_RANK[role] < ROLE_RANK[minRole]) throw forbidden(`Requires ${minRole} role or higher`);
    return role;
  };

  // ---------- positions / views ----------
  const boardColumns = (boardId) => data.columns.filter((c) => c.boardId === boardId).sort((a, b) => a.position - b.position);
  const cardsInColumn = (columnId, exceptId) =>
    data.cards.filter((c) => c.columnId === columnId && c.id !== exceptId).sort((a, b) => a.position - b.position);
  const reindex = (list) => list.forEach((item, i) => { item.position = i; });
  const reindexColumns = (boardId) => reindex(boardColumns(boardId));
  const clamp = (i, max) => Math.min(Math.max(i, 0), max);
  const cardView = (c) => ({ ...c, assignees: [...c.assignees], labels: [...c.labels] });
  const columnView = (col) => ({
    id: col.id,
    boardId: col.boardId,
    name: col.name,
    position: col.position,
    wipLimit: col.wipLimit,
    cards: cardsInColumn(col.id).map(cardView),
  });
  const boardDetail = (board) => ({
    id: board.id,
    name: board.name,
    description: board.description,
    ownerId: board.ownerId,
    createdAt: board.createdAt,
    members: data.members
      .filter((m) => m.boardId === board.id)
      .map((m) => ({ userId: m.userId, username: userById(m.userId)?.username ?? null, role: m.role })),
    labels: data.labels.filter((l) => l.boardId === board.id).map((l) => ({ ...l })),
    columns: boardColumns(board.id).map(columnView),
  });
  const commentView = (c) => ({ id: c.id, cardId: c.cardId, authorId: c.authorId, body: c.body, createdAt: c.createdAt });

  const record = (boardId, type, actorId, details = {}, cardId) => {
    data.activity.push({ id: uuid(), boardId, type, actorId, ...(cardId ? { cardId } : {}), at: now(), details });
  };

  // ---------- validation helpers ----------
  const requireText = (v, field, min, max) => {
    if (!isStr(v)) throw bad(`${field} must be a string`);
    const t = v.trim();
    if (t.length < min || t.length > max) throw bad(`${field} must be ${min}-${max} characters`);
    return t;
  };
  const parseWipLimit = (v) => {
    if (v === undefined || v === null) return null;
    if (!Number.isInteger(v) || v <= 0) throw bad('wipLimit must be a positive integer or null');
    return v;
  };
  const parseDueDate = (v) => {
    if (v === undefined || v === null) return null;
    if (!isStr(v) || !DATE_RE.test(v)) throw bad('dueDate must be YYYY-MM-DD');
    const d = new Date(`${v}T00:00:00Z`);
    if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw bad('dueDate is not a valid date');
    return v;
  };
  const parseIntPosition = (v) => {
    if (v === undefined || v === null) return undefined;
    if (!Number.isInteger(v)) throw bad('position must be an integer');
    return v;
  };
  const parseAssignees = (boardId, v) => {
    if (v === undefined) return undefined;
    if (v === null) return [];
    if (!Array.isArray(v) || !v.every(isStr)) throw bad('assignees must be an array of user ids');
    const ids = [...new Set(v)];
    for (const id of ids) {
      if (!data.members.some((m) => m.boardId === boardId && m.userId === id)) throw bad('assignees must be board members');
    }
    return ids;
  };
  const parseLabels = (boardId, v) => {
    if (v === undefined) return undefined;
    if (v === null) return [];
    if (!Array.isArray(v) || !v.every(isStr)) throw bad('labels must be an array of label ids');
    const ids = [...new Set(v)];
    for (const id of ids) {
      if (!data.labels.some((l) => l.id === id && l.boardId === boardId)) throw bad('labels must belong to this board');
    }
    return ids;
  };
  const parseDescription = (v) => {
    if (v === undefined) return undefined;
    if (v === null) return '';
    if (!isStr(v)) throw bad('description must be a string');
    return v;
  };

  // ---------- auth ----------
  const issueToken = (userId) => {
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, userId);
    return token;
  };

  function register({ body }) {
    if (!isStr(body.username)) throw bad('username is required');
    const username = body.username.toLowerCase();
    if (!USERNAME_RE.test(username)) throw bad('username must be 3-32 characters of a-z, 0-9, _');
    if (!isStr(body.password) || body.password.length < 8) throw bad('password must be at least 8 characters');
    const displayName = body.displayName === undefined || body.displayName === null ? username : body.displayName;
    if (!isStr(displayName) || !displayName.trim() || displayName.trim().length > 100) throw bad('displayName must be 1-100 characters');
    if (data.users.some((u) => u.username === username)) throw conflict('Username already taken');
    const user = {
      id: uuid(),
      username,
      displayName: displayName.trim(),
      passwordHash: hashPassword(body.password),
      createdAt: now(),
    };
    data.users.push(user);
    return [201, { user: publicUser(user) }];
  }

  function login({ body }) {
    if (!isStr(body.username) || !isStr(body.password)) throw bad('username and password are required');
    const key = body.username.trim().toLowerCase();
    const cutoff = Date.now() - LOGIN_WINDOW_MS;
    const recent = (loginFailures.get(key) || []).filter((t) => t > cutoff);
    loginFailures.set(key, recent);
    if (recent.length >= LOGIN_MAX_FAILURES) throw rateLimited('Too many failed login attempts; try again later');
    const user = data.users.find((u) => u.username === key);
    if (!user || !verifyPassword(body.password, user.passwordHash)) {
      recent.push(Date.now());
      throw unauthenticated('Invalid username or password');
    }
    loginFailures.delete(key);
    return [200, { token: issueToken(user.id), user: publicUser(user) }];
  }

  function logout({ token }) {
    sessions.delete(token);
    return [204];
  }

  function me({ user }) {
    return [200, { user: publicUser(user) }];
  }

  // ---------- boards ----------
  function listBoards({ user }) {
    const out = data.members
      .filter((m) => m.userId === user.id)
      .map((m) => {
        const b = data.boards.find((x) => x.id === m.boardId);
        return b ? { id: b.id, name: b.name, role: m.role } : null;
      })
      .filter(Boolean);
    return [200, out];
  }

  function createBoard({ body, user }) {
    const name = requireText(body.name, 'name', 1, 100);
    if (body.description !== undefined && body.description !== null && !isStr(body.description)) throw bad('description must be a string');
    const description = body.description ?? '';
    let columnNames = DEFAULT_COLUMNS;
    if (body.columns !== undefined && body.columns !== null) {
      if (!Array.isArray(body.columns)) throw bad('columns must be an array of names');
      columnNames = body.columns.map((c) => requireText(c, 'column name', 1, 100));
    }
    const board = { id: uuid(), name, description, ownerId: user.id, createdAt: now() };
    data.boards.push(board);
    data.members.push({ boardId: board.id, userId: user.id, role: 'owner' });
    columnNames.forEach((n, i) => data.columns.push({ id: uuid(), boardId: board.id, name: n, position: i, wipLimit: null }));
    record(board.id, 'board.created', user.id, { name });
    return [201, boardDetail(board)];
  }

  function getBoard({ params, user }) {
    const board = boardOr404(params.id);
    requireRole(board.id, user.id, 'viewer');
    return [200, boardDetail(board)];
  }

  function updateBoard({ params, body, user }) {
    const board = boardOr404(params.id);
    requireRole(board.id, user.id, 'owner');
    if (body.name !== undefined) board.name = requireText(body.name, 'name', 1, 100);
    if (body.description !== undefined) {
      if (body.description !== null && !isStr(body.description)) throw bad('description must be a string');
      board.description = body.description ?? '';
    }
    return [200, boardDetail(board)];
  }

  function deleteBoard({ params, user }) {
    const board = boardOr404(params.id);
    requireRole(board.id, user.id, 'owner');
    const cardIds = new Set(data.cards.filter((c) => c.boardId === board.id).map((c) => c.id));
    data.comments = data.comments.filter((c) => !cardIds.has(c.cardId));
    data.cards = data.cards.filter((c) => c.boardId !== board.id);
    data.columns = data.columns.filter((c) => c.boardId !== board.id);
    data.labels = data.labels.filter((l) => l.boardId !== board.id);
    data.members = data.members.filter((m) => m.boardId !== board.id);
    data.activity = data.activity.filter((a) => a.boardId !== board.id);
    data.boards = data.boards.filter((b) => b.id !== board.id);
    return [204];
  }

  // ---------- members ----------
  function addMember({ params, body, user }) {
    const board = boardOr404(params.id);
    requireRole(board.id, user.id, 'owner');
    if (!isStr(body.username)) throw bad('username is required');
    if (body.role !== 'editor' && body.role !== 'viewer') throw bad('role must be editor or viewer');
    const target = data.users.find((u) => u.username === body.username.trim().toLowerCase());
    if (!target) throw notFound('User not found');
    if (roleOf(board.id, target.id)) throw conflict('User is already a member');
    data.members.push({ boardId: board.id, userId: target.id, role: body.role });
    record(board.id, 'member.added', user.id, { userId: target.id, username: target.username, role: body.role });
    return [201, { userId: target.id, username: target.username, role: body.role }];
  }

  function updateMember({ params, body, user }) {
    const board = boardOr404(params.id);
    requireRole(board.id, user.id, 'owner');
    if (body.role !== 'editor' && body.role !== 'viewer') throw bad('role must be editor or viewer');
    const member = data.members.find((m) => m.boardId === board.id && m.userId === params.userId);
    if (!member) throw notFound('Member not found');
    if (member.role === 'owner') throw bad('The owner role cannot be changed');
    member.role = body.role;
    return [200, { userId: member.userId, username: userById(member.userId)?.username ?? null, role: member.role }];
  }

  function removeMember({ params, user }) {
    const board = boardOr404(params.id);
    const actorRole = roleOf(board.id, user.id);
    if (!actorRole) throw forbidden('Not a member of this board');
    if (actorRole !== 'owner' && params.userId !== user.id) throw forbidden('Only the owner can remove other members');
    const member = data.members.find((m) => m.boardId === board.id && m.userId === params.userId);
    if (!member) throw notFound('Member not found');
    if (member.role === 'owner') throw bad('The owner cannot be removed');
    data.members = data.members.filter((m) => m !== member);
    for (const card of data.cards) {
      if (card.boardId === board.id) card.assignees = card.assignees.filter((id) => id !== params.userId);
    }
    return [204];
  }

  // ---------- columns ----------
  function createColumn({ params, body, user }) {
    const board = boardOr404(params.id);
    requireRole(board.id, user.id, 'editor');
    const name = requireText(body.name, 'name', 1, 100);
    const wipLimit = parseWipLimit(body.wipLimit);
    const position = boardColumns(board.id).length;
    const col = { id: uuid(), boardId: board.id, name, position, wipLimit };
    data.columns.push(col);
    record(board.id, 'column.created', user.id, { columnId: col.id, name });
    return [201, columnView(col)];
  }

  function updateColumn({ params, body, user }) {
    const col = columnOr404(params.id);
    requireRole(col.boardId, user.id, 'editor');
    const name = body.name === undefined ? undefined : requireText(body.name, 'name', 1, 100);
    const wipLimit = body.wipLimit === undefined ? undefined : parseWipLimit(body.wipLimit);
    const position = parseIntPosition(body.position);
    if (name !== undefined) col.name = name;
    if (wipLimit !== undefined) col.wipLimit = wipLimit;
    if (position !== undefined) {
      const others = boardColumns(col.boardId).filter((c) => c.id !== col.id);
      others.splice(clamp(position, others.length), 0, col);
      reindex(others);
    }
    return [200, columnView(col)];
  }

  function deleteColumn({ params, query, user }) {
    const col = columnOr404(params.id);
    requireRole(col.boardId, user.id, 'editor');
    const cards = cardsInColumn(col.id);
    if (cards.length > 0 && query.get('force') !== 'true') {
      throw conflict('Column still has cards; use ?force=true to delete them too');
    }
    const cardIds = new Set(cards.map((c) => c.id));
    for (const card of cards) record(col.boardId, 'card.deleted', user.id, { title: card.title, columnId: col.id }, card.id);
    data.comments = data.comments.filter((c) => !cardIds.has(c.cardId));
    data.cards = data.cards.filter((c) => !cardIds.has(c.id));
    data.columns = data.columns.filter((c) => c.id !== col.id);
    reindexColumns(col.boardId);
    return [204];
  }

  // ---------- cards ----------
  function createCard({ params, body, user }) {
    const col = columnOr404(params.id);
    requireRole(col.boardId, user.id, 'editor');
    const title = requireText(body.title, 'title', 1, 200);
    const description = parseDescription(body.description) ?? '';
    const assignees = parseAssignees(col.boardId, body.assignees) ?? [];
    const labels = parseLabels(col.boardId, body.labels) ?? [];
    const dueDate = parseDueDate(body.dueDate);
    const requested = parseIntPosition(body.position);
    const siblings = cardsInColumn(col.id);
    if (col.wipLimit !== null && siblings.length >= col.wipLimit) throw conflict('Column WIP limit reached', 'wip_limit');
    const index = requested === undefined ? siblings.length : clamp(requested, siblings.length);
    const card = {
      id: uuid(),
      boardId: col.boardId,
      columnId: col.id,
      title,
      description,
      position: index,
      assignees,
      labels,
      dueDate,
      createdBy: user.id,
      createdAt: now(),
      updatedAt: now(),
    };
    siblings.splice(index, 0, card);
    data.cards.push(card);
    reindex(siblings);
    record(col.boardId, 'card.created', user.id, { title, columnId: col.id }, card.id);
    return [201, cardView(card)];
  }

  function getCard({ params, user }) {
    const card = cardOr404(params.id);
    requireRole(card.boardId, user.id, 'viewer');
    return [200, cardView(card)];
  }

  function updateCard({ params, body, user }) {
    const card = cardOr404(params.id);
    requireRole(card.boardId, user.id, 'editor');
    const updates = {};
    if (body.title !== undefined) updates.title = requireText(body.title, 'title', 1, 200);
    if (body.description !== undefined) updates.description = parseDescription(body.description);
    if (body.assignees !== undefined) updates.assignees = parseAssignees(card.boardId, body.assignees);
    if (body.labels !== undefined) updates.labels = parseLabels(card.boardId, body.labels);
    if (body.dueDate !== undefined) updates.dueDate = parseDueDate(body.dueDate);
    Object.assign(card, updates, { updatedAt: now() });
    record(card.boardId, 'card.updated', user.id, { fields: Object.keys(updates) }, card.id);
    return [200, cardView(card)];
  }

  function deleteCard({ params, user }) {
    const card = cardOr404(params.id);
    requireRole(card.boardId, user.id, 'editor');
    data.comments = data.comments.filter((c) => c.cardId !== card.id);
    data.cards = data.cards.filter((c) => c !== card);
    reindex(cardsInColumn(card.columnId));
    record(card.boardId, 'card.deleted', user.id, { title: card.title, columnId: card.columnId }, card.id);
    return [204];
  }

  function moveCard({ params, body, user }) {
    const card = cardOr404(params.id);
    requireRole(card.boardId, user.id, 'editor');
    if (!isStr(body.columnId)) throw bad('columnId is required');
    const target = data.columns.find((c) => c.id === body.columnId);
    if (!target || target.boardId !== card.boardId) throw bad('Target column must be on the same board');
    const requested = parseIntPosition(body.position);
    const fromColumnId = card.columnId;
    const others = cardsInColumn(target.id, card.id);
    if (target.id !== fromColumnId && target.wipLimit !== null && others.length >= target.wipLimit) {
      throw conflict('Target column WIP limit reached', 'wip_limit');
    }
    const index = requested === undefined ? others.length : clamp(requested, others.length);
    const source = target.id !== fromColumnId ? cardsInColumn(fromColumnId, card.id) : null;
    others.splice(index, 0, card);
    card.columnId = target.id;
    card.updatedAt = now();
    reindex(others);
    if (source) reindex(source);
    record(card.boardId, 'card.moved', user.id, { fromColumnId, toColumnId: target.id, position: index }, card.id);
    return [200, cardView(card)];
  }

  // ---------- labels ----------
  function createLabel({ params, body, user }) {
    const board = boardOr404(params.id);
    requireRole(board.id, user.id, 'editor');
    const name = requireText(body.name, 'name', 1, 50);
    if (!isStr(body.color) || !COLOR_RE.test(body.color)) throw bad('color must be #rrggbb');
    if (data.labels.some((l) => l.boardId === board.id && l.name.toLowerCase() === name.toLowerCase())) {
      throw conflict('A label with this name already exists');
    }
    const label = { id: uuid(), boardId: board.id, name, color: body.color };
    data.labels.push(label);
    return [201, { ...label }];
  }

  function deleteLabel({ params, user }) {
    const label = labelOr404(params.id);
    requireRole(label.boardId, user.id, 'editor');
    data.labels = data.labels.filter((l) => l !== label);
    for (const card of data.cards) card.labels = card.labels.filter((id) => id !== label.id);
    return [204];
  }

  // ---------- comments ----------
  function addComment({ params, body, user }) {
    const card = cardOr404(params.id);
    requireRole(card.boardId, user.id, 'editor');
    if (!isStr(body.body) || body.body.trim().length < 1 || body.body.length > 5000) throw bad('body must be 1-5000 characters');
    const comment = { id: uuid(), cardId: card.id, authorId: user.id, body: body.body, createdAt: now() };
    data.comments.push(comment);
    record(card.boardId, 'comment.added', user.id, { commentId: comment.id }, card.id);
    return [201, commentView(comment)];
  }

  function listComments({ params, user }) {
    const card = cardOr404(params.id);
    requireRole(card.boardId, user.id, 'viewer');
    return [200, data.comments.filter((c) => c.cardId === card.id).map(commentView)];
  }

  function deleteComment({ params, user }) {
    const comment = commentOr404(params.id);
    const card = cardOr404(comment.cardId);
    const role = requireRole(card.boardId, user.id, 'viewer');
    if (comment.authorId !== user.id && role !== 'owner') throw forbidden('Only the author or the board owner can delete this comment');
    data.comments = data.comments.filter((c) => c !== comment);
    return [204];
  }

  // ---------- search and activity ----------
  function searchCards({ params, query, user }) {
    const board = boardOr404(params.id);
    requireRole(board.id, user.id, 'viewer');
    const q = query.get('q')?.toLowerCase();
    const assignee = query.get('assignee');
    const label = query.get('label');
    const column = query.get('column');
    const dueBefore = query.get('due_before');
    if (dueBefore !== null && !(DATE_RE.test(dueBefore) && !Number.isNaN(Date.parse(`${dueBefore}T00:00:00Z`)))) {
      throw bad('due_before must be YYYY-MM-DD');
    }
    const colPos = new Map(boardColumns(board.id).map((c) => [c.id, c.position]));
    const out = data.cards
      .filter((c) => c.boardId === board.id)
      .filter((c) => !q || c.title.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
      .filter((c) => !assignee || c.assignees.includes(assignee))
      .filter((c) => !label || c.labels.includes(label))
      .filter((c) => !column || c.columnId === column)
      .filter((c) => !dueBefore || (c.dueDate !== null && c.dueDate < dueBefore))
      .sort((a, b) => (colPos.get(a.columnId) ?? 0) - (colPos.get(b.columnId) ?? 0) || a.position - b.position);
    return [200, out.map(cardView)];
  }

  function listActivity({ params, query, user }) {
    const board = boardOr404(params.id);
    requireRole(board.id, user.id, 'viewer');
    let limit = 50;
    const raw = query.get('limit');
    if (raw !== null) {
      if (!/^\d+$/.test(raw) || Number(raw) < 1) throw bad('limit must be a positive integer');
      limit = Number(raw);
    }
    const entries = data.activity.filter((a) => a.boardId === board.id).slice().reverse().slice(0, limit);
    return [200, entries.map((a) => ({ ...a }))];
  }

  // ---------- routing ----------
  const routes = [
    compileRoute('POST', '/api/auth/register', register, { public: true }),
    compileRoute('POST', '/api/auth/login', login, { public: true }),
    compileRoute('POST', '/api/auth/logout', logout),
    compileRoute('GET', '/api/auth/me', me),
    compileRoute('GET', '/api/boards', listBoards),
    compileRoute('POST', '/api/boards', createBoard),
    compileRoute('GET', '/api/boards/:id', getBoard),
    compileRoute('PATCH', '/api/boards/:id', updateBoard),
    compileRoute('DELETE', '/api/boards/:id', deleteBoard),
    compileRoute('POST', '/api/boards/:id/members', addMember),
    compileRoute('PATCH', '/api/boards/:id/members/:userId', updateMember),
    compileRoute('DELETE', '/api/boards/:id/members/:userId', removeMember),
    compileRoute('POST', '/api/boards/:id/columns', createColumn),
    compileRoute('PATCH', '/api/columns/:id', updateColumn),
    compileRoute('DELETE', '/api/columns/:id', deleteColumn),
    compileRoute('POST', '/api/columns/:id/cards', createCard),
    compileRoute('GET', '/api/cards/:id', getCard),
    compileRoute('PATCH', '/api/cards/:id', updateCard),
    compileRoute('DELETE', '/api/cards/:id', deleteCard),
    compileRoute('POST', '/api/cards/:id/move', moveCard),
    compileRoute('POST', '/api/boards/:id/labels', createLabel),
    compileRoute('DELETE', '/api/labels/:id', deleteLabel),
    compileRoute('POST', '/api/cards/:id/comments', addComment),
    compileRoute('GET', '/api/cards/:id/comments', listComments),
    compileRoute('DELETE', '/api/comments/:id', deleteComment),
    compileRoute('GET', '/api/boards/:id/cards', searchCards),
    compileRoute('GET', '/api/boards/:id/activity', listActivity),
  ];

  function matchRoute(method, pathname) {
    for (const route of routes) {
      const m = route.re.exec(pathname);
      if (!m || route.method !== method) continue;
      const params = {};
      route.names.forEach((name, i) => { params[name] = decodeURIComponent(m[i + 1]); });
      return { route, params };
    }
    return null;
  }

  function serveStatic(res, relPath) {
    const file = path.normalize(path.join(STATIC_DIR, relPath));
    if (!file.startsWith(STATIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return sendError(res, notFound('Not found'));
    }
    res.writeHead(200, { 'content-type': CONTENT_TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) return serveStatic(res, 'index.html');
    if (req.method === 'GET' && pathname.startsWith('/static/')) {
      return serveStatic(res, decodeURIComponent(pathname.slice('/static/'.length)));
    }
    const raw = await readRawBody(req);
    const match = matchRoute(req.method, pathname);
    if (!match || !pathname.startsWith('/api/')) throw notFound('Route not found');
    const { route, params } = match;

    let token = null;
    let user = null;
    if (!route.public) {
      const header = req.headers.authorization || '';
      const m = /^Bearer\s+(\S+)$/i.exec(header);
      token = m ? m[1] : null;
      const userId = token ? sessions.get(token) : undefined;
      user = userId ? userById(userId) : undefined;
      if (!user) throw unauthenticated();
    }
    const body = parseBody(raw);
    const [status, payload] = await route.handler({ params, query: url.searchParams, body, user, token });
    if (req.method !== 'GET') saveData(dataFile, data);
    send(res, status, payload);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof HttpError) return sendError(res, err);
      console.error(err);
      sendError(res, new HttpError(500, 'internal', 'Internal server error'));
    });
  });
  return server;
}
