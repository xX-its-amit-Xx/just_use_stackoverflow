// kanban-s3 HTTP server: JSON API over node:http plus a static single-page UI.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };
const DEFAULT_COLUMNS = ['To Do', 'In Progress', 'Done'];
const USERNAME_RE = /^[a-z0-9_]{3,32}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const LOCK_MAX_FAILURES = 5;
const LOCK_WINDOW_MS = 15 * 60 * 1000;
const MAX_BODY = 1024 * 1024;
const STATIC_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();

class HttpError extends Error {
  constructor(status, error, message) {
    super(message);
    this.status = status;
    this.error = error;
  }
}
const badRequest = (m) => new HttpError(400, 'validation', m);
const unauthenticated = (m = 'Authentication required') => new HttpError(401, 'unauthenticated', m);
const forbidden = (m = 'Forbidden') => new HttpError(403, 'forbidden', m);
const notFound = (m = 'Not found') => new HttpError(404, 'not_found', m);
const conflict = (m, code = 'conflict') => new HttpError(409, code, m);

// ---------- persistence ----------
function emptyState() {
  return { users: [], boards: [], members: [], columns: [], cards: [], labels: [], comments: [], activity: [] };
}

function loadState(file) {
  if (!file) return emptyState();
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return emptyState();
    throw err;
  }
  if (!raw.trim()) return emptyState();
  return { ...emptyState(), ...JSON.parse(raw) };
}

function saveState(file, state) {
  if (!file) return;
  const abs = path.resolve(file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = `${abs}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, abs);
}

// ---------- crypto helpers ----------
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}

// ---------- validation helpers ----------
function requireString(v, field, max) {
  if (typeof v !== 'string' || v.trim().length === 0 || v.length > max) {
    throw badRequest(`${field} must be a string of 1-${max} characters`);
  }
  return v;
}

function optionalText(v, field) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string') throw badRequest(`${field} must be a string`);
  return v;
}

function parsePosition(v) {
  if (v === undefined || v === null) return undefined;
  if (!Number.isInteger(v)) throw badRequest('position must be an integer');
  return v;
}

function parseWip(v) {
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v) || v < 1) throw badRequest('wipLimit must be a positive integer or null');
  return v;
}

function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(s);
}

function parseDueDate(v) {
  if (v === undefined || v === null) return null;
  if (!isValidDate(v)) throw badRequest('dueDate must be YYYY-MM-DD or null');
  return v;
}

// ---------- view helpers ----------
const userView = (u) => ({ id: u.id, username: u.username, displayName: u.displayName });
const labelView = (l) => ({ id: l.id, boardId: l.boardId, name: l.name, color: l.color });
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
const columnView = (state, col) => ({
  id: col.id,
  boardId: col.boardId,
  name: col.name,
  position: col.position,
  wipLimit: col.wipLimit,
  cards: cardsInColumn(state, col.id).map(cardView),
});

function boardDetail(state, board) {
  const members = state.members
    .filter((m) => m.boardId === board.id)
    .map((m) => {
      const u = state.users.find((x) => x.id === m.userId);
      return { userId: m.userId, username: u ? u.username : null, role: m.role };
    });
  const labels = state.labels.filter((l) => l.boardId === board.id).map(labelView);
  const columns = sortByPosition(state.columns.filter((c) => c.boardId === board.id)).map((c) =>
    columnView(state, c),
  );
  return {
    id: board.id,
    name: board.name,
    description: board.description,
    ownerId: board.ownerId,
    createdAt: board.createdAt,
    members,
    labels,
    columns,
  };
}

// ---------- ordering helpers ----------
const sortByPosition = (arr) => arr.slice().sort((a, b) => a.position - b.position);
const cardsInColumn = (state, columnId) =>
  sortByPosition(state.cards.filter((c) => c.columnId === columnId));
const renumber = (list) => list.forEach((x, i) => (x.position = i));
const clampIndex = (p, len) => Math.min(Math.max(p, 0), len);

function addActivity(state, { boardId, type, actorId, cardId, details }) {
  const entry = { id: newId(), boardId, type, actorId, at: now(), details: details ?? {} };
  if (cardId !== undefined) entry.cardId = cardId;
  state.activity.push(entry);
}

// ---------- access helpers ----------
function roleOn(state, boardId, userId) {
  const m = state.members.find((x) => x.boardId === boardId && x.userId === userId);
  return m ? m.role : null;
}

function requireBoard(state, boardId, user, minRole = 'viewer') {
  const board = state.boards.find((b) => b.id === boardId);
  if (!board) throw notFound('Board not found');
  const role = roleOn(state, boardId, user.id);
  if (!role || ROLE_RANK[role] < ROLE_RANK[minRole]) throw forbidden('Insufficient role on this board');
  return { board, role };
}

function columnOr404(state, id) {
  const col = state.columns.find((c) => c.id === id);
  if (!col) throw notFound('Column not found');
  return col;
}

function cardOr404(state, id) {
  const card = state.cards.find((c) => c.id === id);
  if (!card) throw notFound('Card not found');
  return card;
}

// ---------- auth ----------
function authenticate(app, req) {
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization || '');
  if (!m) throw unauthenticated();
  const userId = app.sessions.get(m[1]);
  const user = userId && app.state.users.find((u) => u.id === userId);
  if (!user) throw unauthenticated('Invalid or logged-out token');
  return { token: m[1], user };
}

// ---------- handlers: auth ----------
async function registerH({ app, body }) {
  const username = typeof body.username === 'string' ? body.username.toLowerCase() : '';
  if (!USERNAME_RE.test(username)) throw badRequest('username must be 3-32 chars of a-z, 0-9, _');
  if (typeof body.password !== 'string' || body.password.length < 8) {
    throw badRequest('password must be at least 8 characters');
  }
  const displayName =
    body.displayName === undefined || body.displayName === null
      ? username
      : requireString(body.displayName, 'displayName', 100);
  if (app.state.users.some((u) => u.username === username)) throw conflict('Username already taken');
  const user = {
    id: newId(),
    username,
    displayName,
    passwordHash: hashPassword(body.password),
    createdAt: now(),
  };
  app.state.users.push(user);
  return { status: 201, body: { user: userView(user) } };
}

async function loginH({ app, body }) {
  const username = typeof body.username === 'string' ? body.username.toLowerCase() : '';
  if (!username || typeof body.password !== 'string' || !body.password) {
    throw badRequest('username and password are required');
  }
  const t = Date.now();
  const recent = (app.failures.get(username) || []).filter((x) => t - x < LOCK_WINDOW_MS);
  app.failures.set(username, recent);
  if (recent.length >= LOCK_MAX_FAILURES) {
    throw new HttpError(429, 'rate_limited', 'Too many failed login attempts; try again later');
  }
  const user = app.state.users.find((u) => u.username === username);
  if (!user || !verifyPassword(body.password, user.passwordHash)) {
    recent.push(t);
    throw unauthenticated('Invalid username or password');
  }
  const token = crypto.randomBytes(32).toString('hex');
  app.sessions.set(token, user.id);
  return { body: { token, user: userView(user) } };
}

async function logoutH({ app, token }) {
  app.sessions.delete(token);
  return { status: 204 };
}

async function meH({ user }) {
  return { body: { user: userView(user) } };
}

// ---------- handlers: boards ----------
async function listBoardsH({ app, user }) {
  const out = [];
  for (const m of app.state.members) {
    if (m.userId !== user.id) continue;
    const b = app.state.boards.find((x) => x.id === m.boardId);
    if (b) out.push({ id: b.id, name: b.name, role: m.role });
  }
  return { body: out };
}

async function createBoardH({ app, user, body }) {
  const name = requireString(body.name, 'name', 100);
  const description = optionalText(body.description, 'description');
  let columns = DEFAULT_COLUMNS;
  if (body.columns !== undefined && body.columns !== null) {
    if (!Array.isArray(body.columns)) throw badRequest('columns must be an array of names');
    columns = body.columns.map((c) => requireString(c, 'column name', 100));
  }
  const state = app.state;
  const board = { id: newId(), name, description, ownerId: user.id, createdAt: now() };
  state.boards.push(board);
  state.members.push({ boardId: board.id, userId: user.id, role: 'owner' });
  addActivity(state, { boardId: board.id, type: 'board.created', actorId: user.id, details: { name } });
  columns.forEach((colName, i) => {
    const col = { id: newId(), boardId: board.id, name: colName, position: i, wipLimit: null };
    state.columns.push(col);
    addActivity(state, { boardId: board.id, type: 'column.created', actorId: user.id, details: { columnId: col.id, name: colName } });
  });
  return { status: 201, body: boardDetail(state, board) };
}

async function getBoardH({ app, user, params }) {
  const { board } = requireBoard(app.state, params.id, user);
  return { body: boardDetail(app.state, board) };
}

async function patchBoardH({ app, user, params, body }) {
  const { board } = requireBoard(app.state, params.id, user, 'owner');
  if (body.name !== undefined) board.name = requireString(body.name, 'name', 100);
  if (body.description !== undefined) board.description = optionalText(body.description, 'description');
  return { body: boardDetail(app.state, board) };
}

async function deleteBoardH({ app, user, params }) {
  const { board } = requireBoard(app.state, params.id, user, 'owner');
  const s = app.state;
  const cardIds = new Set(s.cards.filter((c) => c.boardId === board.id).map((c) => c.id));
  s.comments = s.comments.filter((c) => !cardIds.has(c.cardId));
  s.cards = s.cards.filter((c) => c.boardId !== board.id);
  s.columns = s.columns.filter((c) => c.boardId !== board.id);
  s.labels = s.labels.filter((l) => l.boardId !== board.id);
  s.members = s.members.filter((m) => m.boardId !== board.id);
  s.activity = s.activity.filter((a) => a.boardId !== board.id);
  s.boards = s.boards.filter((b) => b.id !== board.id);
  return { status: 204 };
}

// ---------- handlers: members ----------
async function addMemberH({ app, user, params, body }) {
  const { board } = requireBoard(app.state, params.id, user, 'owner');
  const s = app.state;
  if (typeof body.username !== 'string' || !body.username) throw badRequest('username is required');
  if (body.role !== 'editor' && body.role !== 'viewer') throw badRequest('role must be editor or viewer');
  const target = s.users.find((u) => u.username === body.username.toLowerCase());
  if (!target) throw notFound('User not found');
  if (roleOn(s, board.id, target.id)) throw conflict('User is already a member');
  s.members.push({ boardId: board.id, userId: target.id, role: body.role });
  addActivity(s, {
    boardId: board.id,
    type: 'member.added',
    actorId: user.id,
    details: { userId: target.id, username: target.username, role: body.role },
  });
  return { status: 201, body: { userId: target.id, username: target.username, role: body.role } };
}

async function patchMemberH({ app, user, params, body }) {
  const { board } = requireBoard(app.state, params.id, user, 'owner');
  const s = app.state;
  if (body.role !== 'editor' && body.role !== 'viewer') throw badRequest('role must be editor or viewer');
  const member = s.members.find((m) => m.boardId === board.id && m.userId === params.userId);
  if (!member) throw notFound('Member not found');
  if (member.role === 'owner') throw badRequest('Cannot change the owner role');
  member.role = body.role;
  const u = s.users.find((x) => x.id === member.userId);
  return { body: { userId: member.userId, username: u ? u.username : null, role: member.role } };
}

async function removeMemberH({ app, user, params }) {
  const s = app.state;
  const board = s.boards.find((b) => b.id === params.id);
  if (!board) throw notFound('Board not found');
  const callerRole = roleOn(s, board.id, user.id);
  if (!callerRole) throw forbidden('Not a member of this board');
  if (callerRole !== 'owner' && params.userId !== user.id) throw forbidden('Only the owner can remove members');
  const member = s.members.find((m) => m.boardId === board.id && m.userId === params.userId);
  if (!member) throw notFound('Member not found');
  if (member.role === 'owner') throw badRequest('Cannot remove the owner');
  s.members = s.members.filter((m) => m !== member);
  for (const c of s.cards) {
    if (c.boardId === board.id) c.assignees = c.assignees.filter((a) => a !== params.userId);
  }
  return { status: 204 };
}

// ---------- handlers: columns ----------
async function createColumnH({ app, user, params, body }) {
  const { board } = requireBoard(app.state, params.id, user, 'editor');
  const s = app.state;
  const name = requireString(body.name, 'name', 100);
  const wipLimit = parseWip(body.wipLimit);
  const position = s.columns.filter((c) => c.boardId === board.id).length;
  const col = { id: newId(), boardId: board.id, name, position, wipLimit };
  s.columns.push(col);
  addActivity(s, { boardId: board.id, type: 'column.created', actorId: user.id, details: { columnId: col.id, name } });
  return { status: 201, body: columnView(s, col) };
}

async function patchColumnH({ app, user, params, body }) {
  const s = app.state;
  const col = columnOr404(s, params.id);
  requireBoard(s, col.boardId, user, 'editor');
  const name = body.name === undefined ? undefined : requireString(body.name, 'name', 100);
  const wip = body.wipLimit === undefined ? undefined : parseWip(body.wipLimit);
  const position = parsePosition(body.position);
  if (name !== undefined) col.name = name;
  if (wip !== undefined) col.wipLimit = wip;
  if (position !== undefined) {
    const cols = sortByPosition(s.columns.filter((c) => c.boardId === col.boardId));
    cols.splice(cols.indexOf(col), 1);
    cols.splice(clampIndex(position, cols.length), 0, col);
    renumber(cols);
  }
  return { body: columnView(s, col) };
}

async function deleteColumnH({ app, user, params, query }) {
  const s = app.state;
  const col = columnOr404(s, params.id);
  requireBoard(s, col.boardId, user, 'editor');
  const cards = cardsInColumn(s, col.id);
  if (cards.length > 0 && query.get('force') !== 'true') {
    throw conflict('Column still contains cards; use ?force=true to delete them too');
  }
  for (const card of cards) {
    addActivity(s, { boardId: card.boardId, type: 'card.deleted', actorId: user.id, cardId: card.id, details: { title: card.title, columnId: col.id } });
  }
  const cardIds = new Set(cards.map((c) => c.id));
  s.comments = s.comments.filter((c) => !cardIds.has(c.cardId));
  s.cards = s.cards.filter((c) => !cardIds.has(c.id));
  s.columns = s.columns.filter((c) => c !== col);
  renumber(sortByPosition(s.columns.filter((c) => c.boardId === col.boardId)));
  return { status: 204 };
}

// ---------- handlers: cards ----------
function validateAssignees(s, boardId, v) {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw badRequest('assignees must be an array of user ids');
  const ids = [...new Set(v)];
  for (const id of ids) {
    if (!roleOn(s, boardId, id)) throw badRequest('assignees must be board members');
  }
  return ids;
}

function validateLabels(s, boardId, v) {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw badRequest('labels must be an array of label ids');
  const ids = [...new Set(v)];
  for (const id of ids) {
    if (!s.labels.some((l) => l.id === id && l.boardId === boardId)) throw badRequest('labels must belong to this board');
  }
  return ids;
}

async function createCardH({ app, user, params, body }) {
  const s = app.state;
  const col = columnOr404(s, params.id);
  requireBoard(s, col.boardId, user, 'editor');
  const title = requireString(body.title, 'title', 200);
  const description = optionalText(body.description, 'description');
  const assignees = body.assignees === undefined || body.assignees === null ? [] : validateAssignees(s, col.boardId, body.assignees);
  const labels = body.labels === undefined || body.labels === null ? [] : validateLabels(s, col.boardId, body.labels);
  const dueDate = parseDueDate(body.dueDate);
  const position = parsePosition(body.position);
  const list = cardsInColumn(s, col.id);
  if (col.wipLimit != null && list.length >= col.wipLimit) {
    throw conflict('Column WIP limit reached', 'wip_limit');
  }
  const ts = now();
  const card = {
    id: newId(),
    boardId: col.boardId,
    columnId: col.id,
    title,
    description,
    position: 0,
    assignees,
    labels,
    dueDate,
    createdBy: user.id,
    createdAt: ts,
    updatedAt: ts,
  };
  const idx = position === undefined ? list.length : clampIndex(position, list.length);
  list.splice(idx, 0, card);
  s.cards.push(card);
  renumber(list);
  addActivity(s, { boardId: col.boardId, type: 'card.created', actorId: user.id, cardId: card.id, details: { title, columnId: col.id } });
  return { status: 201, body: cardView(card) };
}

async function getCardH({ app, user, params }) {
  const card = cardOr404(app.state, params.id);
  requireBoard(app.state, card.boardId, user, 'viewer');
  return { body: cardView(card) };
}

async function patchCardH({ app, user, params, body }) {
  const s = app.state;
  const card = cardOr404(s, params.id);
  requireBoard(s, card.boardId, user, 'editor');
  const changes = {};
  if (body.title !== undefined) changes.title = requireString(body.title, 'title', 200);
  if (body.description !== undefined) changes.description = optionalText(body.description, 'description');
  if (body.assignees !== undefined) changes.assignees = body.assignees === null ? [] : validateAssignees(s, card.boardId, body.assignees);
  if (body.labels !== undefined) changes.labels = body.labels === null ? [] : validateLabels(s, card.boardId, body.labels);
  if (body.dueDate !== undefined) changes.dueDate = parseDueDate(body.dueDate);
  Object.assign(card, changes);
  card.updatedAt = now();
  addActivity(s, { boardId: card.boardId, type: 'card.updated', actorId: user.id, cardId: card.id, details: { fields: Object.keys(changes) } });
  return { body: cardView(card) };
}

async function deleteCardH({ app, user, params }) {
  const s = app.state;
  const card = cardOr404(s, params.id);
  requireBoard(s, card.boardId, user, 'editor');
  s.comments = s.comments.filter((c) => c.cardId !== card.id);
  const list = cardsInColumn(s, card.columnId).filter((c) => c !== card);
  s.cards = s.cards.filter((c) => c !== card);
  renumber(list);
  addActivity(s, { boardId: card.boardId, type: 'card.deleted', actorId: user.id, cardId: card.id, details: { title: card.title, columnId: card.columnId } });
  return { status: 204 };
}

async function moveCardH({ app, user, params, body }) {
  const s = app.state;
  const card = cardOr404(s, params.id);
  requireBoard(s, card.boardId, user, 'editor');
  const target = s.columns.find((c) => c.id === body.columnId);
  if (!target || target.boardId !== card.boardId) throw badRequest('columnId must be a column on this board');
  const position = parsePosition(body.position);
  const fromColumnId = card.columnId;
  const sameColumn = fromColumnId === target.id;
  if (!sameColumn && target.wipLimit != null && cardsInColumn(s, target.id).length >= target.wipLimit) {
    throw conflict('Target column WIP limit reached', 'wip_limit');
  }
  const fromList = cardsInColumn(s, fromColumnId).filter((c) => c !== card);
  const toList = sameColumn ? fromList : cardsInColumn(s, target.id);
  const idx = position === undefined ? toList.length : clampIndex(position, toList.length);
  card.columnId = target.id;
  toList.splice(idx, 0, card);
  renumber(toList);
  if (!sameColumn) renumber(fromList);
  card.updatedAt = now();
  addActivity(s, {
    boardId: card.boardId,
    type: 'card.moved',
    actorId: user.id,
    cardId: card.id,
    details: { fromColumnId, toColumnId: target.id },
  });
  return { body: cardView(card) };
}

// ---------- handlers: labels ----------
async function createLabelH({ app, user, params, body }) {
  const s = app.state;
  const { board } = requireBoard(s, params.id, user, 'editor');
  const name = requireString(body.name, 'name', 50);
  if (typeof body.color !== 'string' || !COLOR_RE.test(body.color)) throw badRequest('color must be #rrggbb');
  const lower = name.toLowerCase();
  if (s.labels.some((l) => l.boardId === board.id && l.name.toLowerCase() === lower)) {
    throw conflict('Label name already exists on this board');
  }
  const label = { id: newId(), boardId: board.id, name, color: body.color };
  s.labels.push(label);
  return { status: 201, body: labelView(label) };
}

async function deleteLabelH({ app, user, params }) {
  const s = app.state;
  const label = s.labels.find((l) => l.id === params.id);
  if (!label) throw notFound('Label not found');
  requireBoard(s, label.boardId, user, 'editor');
  s.labels = s.labels.filter((l) => l !== label);
  for (const c of s.cards) c.labels = c.labels.filter((id) => id !== label.id);
  return { status: 204 };
}

// ---------- handlers: comments ----------
async function addCommentH({ app, user, params, body }) {
  const s = app.state;
  const card = cardOr404(s, params.id);
  requireBoard(s, card.boardId, user, 'editor');
  const text = requireString(body.body, 'body', 5000);
  const comment = { id: newId(), cardId: card.id, authorId: user.id, body: text, createdAt: now() };
  s.comments.push(comment);
  addActivity(s, { boardId: card.boardId, type: 'comment.added', actorId: user.id, cardId: card.id, details: { commentId: comment.id } });
  return { status: 201, body: { ...comment } };
}

async function listCommentsH({ app, user, params }) {
  const s = app.state;
  const card = cardOr404(s, params.id);
  requireBoard(s, card.boardId, user, 'viewer');
  return { body: s.comments.filter((c) => c.cardId === card.id).map((c) => ({ ...c })) };
}

async function deleteCommentH({ app, user, params }) {
  const s = app.state;
  const comment = s.comments.find((c) => c.id === params.id);
  if (!comment) throw notFound('Comment not found');
  const card = cardOr404(s, comment.cardId);
  const { role } = requireBoard(s, card.boardId, user, 'viewer');
  if (comment.authorId !== user.id && role !== 'owner') throw forbidden('Only the author or board owner can delete this comment');
  s.comments = s.comments.filter((c) => c !== comment);
  return { status: 204 };
}

// ---------- handlers: search & activity ----------
async function searchCardsH({ app, user, params, query }) {
  const s = app.state;
  requireBoard(s, params.id, user, 'viewer');
  const q = query.get('q');
  const assignee = query.get('assignee');
  const label = query.get('label');
  const column = query.get('column');
  const dueBefore = query.get('due_before');
  if (dueBefore && !isValidDate(dueBefore)) throw badRequest('due_before must be YYYY-MM-DD');
  let cards = s.cards.filter((c) => c.boardId === params.id);
  if (q) {
    const ql = q.toLowerCase();
    cards = cards.filter((c) => c.title.toLowerCase().includes(ql) || (c.description || '').toLowerCase().includes(ql));
  }
  if (assignee) cards = cards.filter((c) => c.assignees.includes(assignee));
  if (label) cards = cards.filter((c) => c.labels.includes(label));
  if (column) cards = cards.filter((c) => c.columnId === column);
  if (dueBefore) cards = cards.filter((c) => c.dueDate && c.dueDate < dueBefore);
  const colPos = new Map(s.columns.map((c) => [c.id, c.position]));
  cards.sort((a, b) => colPos.get(a.columnId) - colPos.get(b.columnId) || a.position - b.position);
  return { body: cards.map(cardView) };
}

async function activityH({ app, user, params, query }) {
  const s = app.state;
  requireBoard(s, params.id, user, 'viewer');
  const raw = query.get('limit');
  let limit = 50;
  if (raw !== null) {
    if (!/^\d+$/.test(raw) || Number(raw) < 1) throw badRequest('limit must be a positive integer');
    limit = Number(raw);
  }
  const entries = s.activity.filter((a) => a.boardId === params.id).reverse().slice(0, limit);
  return { body: entries.map((a) => ({ ...a })) };
}

// ---------- routing ----------
const routes = [];
function route(method, pattern, handler, { auth = true } = {}) {
  const keys = [];
  const source = pattern.replace(/:([A-Za-z]+)/g, (_, k) => {
    keys.push(k);
    return '([^/]+)';
  });
  routes.push({ method, re: new RegExp(`^${source}/?$`), keys, handler, auth });
}

route('POST', '/api/auth/register', registerH, { auth: false });
route('POST', '/api/auth/login', loginH, { auth: false });
route('POST', '/api/auth/logout', logoutH);
route('GET', '/api/auth/me', meH);
route('GET', '/api/boards', listBoardsH);
route('POST', '/api/boards', createBoardH);
route('GET', '/api/boards/:id', getBoardH);
route('PATCH', '/api/boards/:id', patchBoardH);
route('DELETE', '/api/boards/:id', deleteBoardH);
route('POST', '/api/boards/:id/members', addMemberH);
route('PATCH', '/api/boards/:id/members/:userId', patchMemberH);
route('DELETE', '/api/boards/:id/members/:userId', removeMemberH);
route('POST', '/api/boards/:id/columns', createColumnH);
route('GET', '/api/boards/:id/cards', searchCardsH);
route('GET', '/api/boards/:id/activity', activityH);
route('POST', '/api/boards/:id/labels', createLabelH);
route('PATCH', '/api/columns/:id', patchColumnH);
route('DELETE', '/api/columns/:id', deleteColumnH);
route('POST', '/api/columns/:id/cards', createCardH);
route('GET', '/api/cards/:id', getCardH);
route('PATCH', '/api/cards/:id', patchCardH);
route('DELETE', '/api/cards/:id', deleteCardH);
route('POST', '/api/cards/:id/move', moveCardH);
route('POST', '/api/cards/:id/comments', addCommentH);
route('GET', '/api/cards/:id/comments', listCommentsH);
route('DELETE', '/api/comments/:id', deleteCommentH);
route('DELETE', '/api/labels/:id', deleteLabelH);

// ---------- transport ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (c) => {
      if (failed) return;
      size += c.length;
      if (size > MAX_BODY) {
        failed = true;
        reject(badRequest('Request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (!failed) reject(err);
    });
  });
}

function parseBody(raw) {
  if (!raw || !raw.trim()) return {};
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid_json', 'Malformed JSON body');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest('Body must be a JSON object');
  }
  return value;
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function serveStatic(res, pathname) {
  let rel;
  if (pathname === '/') {
    rel = 'index.html';
  } else {
    try {
      rel = decodeURIComponent(pathname.slice('/static/'.length));
    } catch {
      throw notFound();
    }
  }
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw notFound('No such file');
  }
  const type = STATIC_TYPES[path.extname(file)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type });
  res.end(fs.readFileSync(file));
}

async function handle(app, req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if (req.method === 'GET' && (pathname === '/' || pathname.startsWith('/static/'))) {
      return serveStatic(res, pathname);
    }
    let match = null;
    for (const r of routes) {
      const m = r.re.exec(pathname);
      if (m && r.method === req.method) {
        match = { r, m };
        break;
      }
    }
    if (!match) {
      await readBody(req).catch(() => {});
      throw notFound('No such route');
    }
    const { r, m } = match;
    const params = {};
    r.keys.forEach((k, i) => {
      params[k] = decodeURIComponent(m[i + 1]);
    });
    let auth = { token: null, user: null };
    if (r.auth) auth = authenticate(app, req);
    const raw = await readBody(req);
    const body = req.method === 'POST' || req.method === 'PATCH' ? parseBody(raw) : {};
    const result = await r.handler({ app, params, query: url.searchParams, body, user: auth.user, token: auth.token });
    const status = result?.status ?? 200;
    if (req.method !== 'GET') saveState(app.dataFile, app.state);
    if (status === 204) {
      res.writeHead(204);
      res.end();
      return;
    }
    return send(res, status, result.body);
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.error, message: err.message });
    console.error(err);
    return send(res, 500, { error: 'internal', message: 'Internal server error' });
  }
}

export function createServer({ dataFile } = {}) {
  const app = {
    state: loadState(dataFile),
    dataFile,
    sessions: new Map(),
    failures: new Map(),
  };
  return http.createServer((req, res) => {
    handle(app, req, res);
  });
}
