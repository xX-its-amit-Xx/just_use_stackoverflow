// kanban-s3: multi-user Kanban JSON API over node:http.
// All state lives in one `db` object; it is persisted synchronously after every
// successful mutating request when a dataFile is configured.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
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
};

class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}
const bad = (msg) => new HttpError(400, 'validation', msg);
const unauth = (msg = 'Authentication required') => new HttpError(401, 'unauthenticated', msg);
const forbidden = (msg = 'Forbidden') => new HttpError(403, 'forbidden', msg);
const notFound = (msg = 'Not found') => new HttpError(404, 'not_found', msg);
const conflict = (msg = 'Conflict', code = 'conflict') => new HttpError(409, code, msg);

const now = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonNeg = (v) => Number.isInteger(v) && v >= 0;
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

function emptyDb() {
  return { users: [], boards: [], columns: [], cards: [], labels: [], comments: [], activity: [] };
}

function validName(v, max, what) {
  if (typeof v !== 'string') throw bad(`${what} must be a string`);
  const t = v.trim();
  if (t.length < 1 || t.length > max) throw bad(`${what} must be 1-${max} characters`);
  return t;
}

function validIndex(v, what) {
  if (v === undefined || v === null) return undefined;
  if (!isNonNeg(v)) throw bad(`${what} must be a non-negative integer`);
  return v;
}

function validWip(v) {
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v) || v < 1) throw bad('wipLimit must be a positive integer or null');
  return v;
}

function validDate(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad('dueDate must be YYYY-MM-DD or null');
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw bad('dueDate is not a valid date');
  return v;
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(password, salt, 64).toString('hex') };
}

function verifyPassword(password, user) {
  const { hash } = hashPassword(password, user.passwordSalt);
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(user.passwordHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
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
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'payload_too_large', 'Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, body) {
  if (status === 204 || body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function sendError(res, err) {
  if (err instanceof HttpError) {
    sendJson(res, err.status, { error: err.code, message: err.message });
  } else {
    console.error(err);
    sendJson(res, 500, { error: 'internal', message: 'Internal server error' });
  }
}

function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) {
      sendError(res, notFound('Not found'));
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

function compileRoute(method, pattern, fn, auth = true) {
  const names = [];
  const re = new RegExp(
    '^' + pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$'
  );
  return { method, re, names, fn, auth };
}

export function createServer({ dataFile } = {}) {
  let db = emptyDb();
  if (dataFile && fs.existsSync(dataFile)) {
    const raw = fs.readFileSync(dataFile, 'utf8');
    if (raw.trim()) db = { ...emptyDb(), ...JSON.parse(raw) };
  }

  const sessions = new Map(); // token -> userId (in memory only)
  const failures = new Map(); // username -> [epoch ms of failed attempts]

  function save() {
    if (!dataFile) return;
    const tmp = `${dataFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, dataFile);
  }

  // ---------- lookups ----------
  const findUser = (id) => db.users.find((u) => u.id === id);
  const findBoard = (id) => db.boards.find((b) => b.id === id);
  const findColumn = (id) => db.columns.find((c) => c.id === id);
  const findCard = (id) => db.cards.find((c) => c.id === id);
  const findLabel = (id) => db.labels.find((l) => l.id === id);
  const findComment = (id) => db.comments.find((c) => c.id === id);
  const columnsOfBoard = (boardId) =>
    db.columns.filter((c) => c.boardId === boardId).sort((a, b) => a.position - b.position);
  const cardsInColumn = (columnId) =>
    db.cards.filter((c) => c.columnId === columnId).sort((a, b) => a.position - b.position);

  function boardAccess(user, boardId, minRole = 'viewer') {
    const board = findBoard(boardId);
    if (!board) throw notFound('Board not found');
    const m = board.members.find((x) => x.userId === user.id);
    if (!m || ROLE_RANK[m.role] < ROLE_RANK[minRole]) throw forbidden('Insufficient role on this board');
    return { board, role: m.role };
  }

  function columnAccess(user, columnId, minRole) {
    const column = findColumn(columnId);
    if (!column) throw notFound('Column not found');
    const { board, role } = boardAccess(user, column.boardId, minRole);
    return { board, column, role };
  }

  function cardAccess(user, cardId, minRole) {
    const card = findCard(cardId);
    if (!card) throw notFound('Card not found');
    const { board, role } = boardAccess(user, card.boardId, minRole);
    return { board, card, role };
  }

  function logActivity(boardId, type, actorId, cardId, details = {}) {
    const entry = { id: uid(), boardId, type, actorId };
    if (cardId) entry.cardId = cardId;
    entry.at = now();
    entry.details = details;
    db.activity.push(entry);
  }

  function reindexColumn(columnId) {
    cardsInColumn(columnId).forEach((c, i) => { c.position = i; });
  }

  function reindexBoardColumns(boardId) {
    columnsOfBoard(boardId).forEach((c, i) => { c.position = i; });
  }

  function removeCards(cardIds) {
    const set = new Set(cardIds);
    db.cards = db.cards.filter((c) => !set.has(c.id));
    db.comments = db.comments.filter((c) => !set.has(c.cardId));
  }

  // ---------- views ----------
  const labelView = (l) => ({ id: l.id, boardId: l.boardId, name: l.name, color: l.color });
  const cardView = (c) => ({ ...c, assignees: [...c.assignees], labels: [...c.labels] });
  const columnView = (c) => ({
    id: c.id,
    boardId: c.boardId,
    name: c.name,
    position: c.position,
    wipLimit: c.wipLimit,
    cards: cardsInColumn(c.id).map(cardView),
  });

  function boardDetail(board) {
    return {
      id: board.id,
      name: board.name,
      description: board.description,
      ownerId: board.ownerId,
      createdAt: board.createdAt,
      members: board.members.map((m) => {
        const u = findUser(m.userId);
        return { userId: m.userId, username: u ? u.username : null, role: m.role };
      }),
      labels: db.labels.filter((l) => l.boardId === board.id).map(labelView),
      columns: columnsOfBoard(board.id).map(columnView),
    };
  }

  function validateAssignees(board, value) {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw bad('assignees must be an array of user ids');
    const out = [...new Set(value)];
    for (const uidValue of out) {
      if (!board.members.some((m) => m.userId === uidValue)) throw bad(`assignee ${uidValue} is not a board member`);
    }
    return out;
  }

  function validateLabels(board, value) {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) throw bad('labels must be an array of label ids');
    const out = [...new Set(value)];
    for (const lid of out) {
      const l = findLabel(lid);
      if (!l || l.boardId !== board.id) throw bad(`label ${lid} does not belong to this board`);
    }
    return out;
  }

  // ---------- auth handlers ----------
  function register({ body }) {
    if (!isObj(body)) throw bad('Body must be a JSON object');
    if (typeof body.username !== 'string') throw bad('username is required');
    const username = body.username.toLowerCase();
    if (!/^[a-z0-9_]{3,32}$/.test(username)) throw bad('username must be 3-32 characters of a-z, 0-9, _');
    if (typeof body.password !== 'string' || body.password.length < 8) throw bad('password must be at least 8 characters');
    let displayName = username;
    if (body.displayName !== undefined && body.displayName !== null) {
      displayName = validName(body.displayName, 100, 'displayName');
    }
    if (db.users.some((u) => u.username === username)) throw conflict('Username already taken');
    const { salt, hash } = hashPassword(body.password);
    const user = {
      id: uid(),
      username,
      displayName,
      passwordSalt: salt,
      passwordHash: hash,
      createdAt: now(),
    };
    db.users.push(user);
    return [201, { user: publicUser(user) }];
  }

  function recentFailures(username) {
    const cutoff = Date.now() - LOGIN_WINDOW_MS;
    const recent = (failures.get(username) || []).filter((t) => t > cutoff);
    failures.set(username, recent);
    return recent;
  }

  function login({ body }) {
    if (!isObj(body) || typeof body.username !== 'string' || typeof body.password !== 'string') {
      throw bad('username and password are required');
    }
    const username = body.username.trim().toLowerCase();
    const recent = recentFailures(username);
    if (recent.length >= LOGIN_MAX_FAILURES) {
      throw new HttpError(429, 'rate_limited', 'Too many failed login attempts; try again later');
    }
    const user = db.users.find((u) => u.username === username);
    if (!user || !verifyPassword(body.password, user)) {
      recent.push(Date.now());
      failures.set(username, recent);
      throw unauth('Invalid username or password');
    }
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, user.id);
    return [200, { token, user: publicUser(user) }];
  }

  function logout({ token }) {
    sessions.delete(token);
    return [204];
  }

  function me({ user }) {
    return [200, { user: publicUser(user) }];
  }

  // ---------- boards ----------
  function createBoard({ user, body }) {
    if (!isObj(body)) throw bad('Body must be a JSON object');
    const name = validName(body.name, 100, 'name');
    let description = '';
    if (body.description !== undefined && body.description !== null) {
      if (typeof body.description !== 'string') throw bad('description must be a string');
      description = body.description;
    }
    let columnNames = DEFAULT_COLUMNS;
    if (body.columns !== undefined && body.columns !== null) {
      if (!Array.isArray(body.columns)) throw bad('columns must be an array of names');
      columnNames = body.columns.map((c) => validName(c, 100, 'column name'));
    }
    const board = {
      id: uid(),
      name,
      description,
      ownerId: user.id,
      createdAt: now(),
      members: [{ userId: user.id, role: 'owner' }],
    };
    db.boards.push(board);
    columnNames.forEach((n, i) => {
      db.columns.push({ id: uid(), boardId: board.id, name: n, position: i, wipLimit: null });
    });
    logActivity(board.id, 'board.created', user.id, null, { name });
    return [201, boardDetail(board)];
  }

  function listBoards({ user }) {
    const out = [];
    for (const b of db.boards) {
      const m = b.members.find((x) => x.userId === user.id);
      if (m) out.push({ id: b.id, name: b.name, role: m.role });
    }
    return [200, out];
  }

  function getBoard({ user, params }) {
    const { board } = boardAccess(user, params.id, 'viewer');
    return [200, boardDetail(board)];
  }

  function patchBoard({ user, params, body }) {
    const { board } = boardAccess(user, params.id, 'owner');
    if (!isObj(body)) throw bad('Body must be a JSON object');
    const updates = {};
    if (body.name !== undefined) updates.name = validName(body.name, 100, 'name');
    if (body.description !== undefined) {
      if (body.description === null) updates.description = '';
      else if (typeof body.description === 'string') updates.description = body.description;
      else throw bad('description must be a string');
    }
    Object.assign(board, updates);
    return [200, boardDetail(board)];
  }

  function deleteBoard({ user, params }) {
    const { board } = boardAccess(user, params.id, 'owner');
    const cardIds = db.cards.filter((c) => c.boardId === board.id).map((c) => c.id);
    removeCards(cardIds);
    db.boards = db.boards.filter((b) => b.id !== board.id);
    db.columns = db.columns.filter((c) => c.boardId !== board.id);
    db.labels = db.labels.filter((l) => l.boardId !== board.id);
    db.activity = db.activity.filter((a) => a.boardId !== board.id);
    return [204];
  }

  // ---------- members ----------
  function parseRole(v) {
    if (v !== 'editor' && v !== 'viewer') throw bad('role must be editor or viewer');
    return v;
  }

  function addMember({ user, params, body }) {
    const { board } = boardAccess(user, params.id, 'owner');
    if (!isObj(body) || typeof body.username !== 'string') throw bad('username is required');
    const role = parseRole(body.role);
    const target = db.users.find((u) => u.username === body.username.trim().toLowerCase());
    if (!target) throw notFound('User not found');
    if (board.members.some((m) => m.userId === target.id)) throw conflict('User is already a member');
    board.members.push({ userId: target.id, role });
    logActivity(board.id, 'member.added', user.id, null, { userId: target.id, username: target.username, role });
    return [201, { userId: target.id, username: target.username, role }];
  }

  function patchMember({ user, params, body }) {
    const { board } = boardAccess(user, params.id, 'owner');
    if (!isObj(body)) throw bad('Body must be a JSON object');
    const role = parseRole(body.role);
    const member = board.members.find((m) => m.userId === params.userId);
    if (!member) throw notFound('Member not found');
    if (member.role === 'owner') throw bad('Cannot change the owner role');
    member.role = role;
    const u = findUser(member.userId);
    return [200, { userId: member.userId, username: u ? u.username : null, role }];
  }

  function removeMember({ user, params }) {
    const { board, role } = boardAccess(user, params.id, 'viewer');
    if (role !== 'owner' && params.userId !== user.id) throw forbidden('Only the owner can remove other members');
    const member = board.members.find((m) => m.userId === params.userId);
    if (!member) throw notFound('Member not found');
    if (member.role === 'owner') throw bad('Cannot remove the board owner');
    board.members = board.members.filter((m) => m !== member);
    return [204];
  }

  // ---------- columns ----------
  function createColumn({ user, params, body }) {
    const { board } = boardAccess(user, params.id, 'editor');
    if (!isObj(body)) throw bad('Body must be a JSON object');
    const name = validName(body.name, 100, 'name');
    const wipLimit = validWip(body.wipLimit);
    const position = columnsOfBoard(board.id).length;
    const column = { id: uid(), boardId: board.id, name, position, wipLimit };
    db.columns.push(column);
    logActivity(board.id, 'column.created', user.id, null, { columnId: column.id, name });
    return [201, columnView(column)];
  }

  function patchColumn({ user, params, body }) {
    const { board, column } = columnAccess(user, params.id, 'editor');
    if (!isObj(body)) throw bad('Body must be a JSON object');
    const name = body.name !== undefined ? validName(body.name, 100, 'name') : undefined;
    const wipLimit = body.wipLimit !== undefined ? validWip(body.wipLimit) : undefined;
    const position = body.position !== undefined ? validIndex(body.position, 'position') : undefined;
    if (name !== undefined) column.name = name;
    if (wipLimit !== undefined) column.wipLimit = wipLimit;
    if (position !== undefined) {
      const cols = columnsOfBoard(board.id);
      const others = cols.filter((c) => c.id !== column.id);
      others.splice(clamp(position, 0, others.length), 0, column);
      others.forEach((c, i) => { c.position = i; });
    }
    return [200, columnView(column)];
  }

  function deleteColumn({ user, params, query }) {
    const { board, column } = columnAccess(user, params.id, 'editor');
    const cards = cardsInColumn(column.id);
    if (cards.length > 0 && query.force !== 'true') {
      throw conflict('Column still contains cards; use force=true to delete them', 'conflict');
    }
    removeCards(cards.map((c) => c.id));
    db.columns = db.columns.filter((c) => c.id !== column.id);
    reindexBoardColumns(board.id);
    return [204];
  }

  // ---------- cards ----------
  function createCard({ user, params, body }) {
    const { board, column } = columnAccess(user, params.id, 'editor');
    if (!isObj(body)) throw bad('Body must be a JSON object');
    const title = validName(body.title, 200, 'title');
    let description = '';
    if (body.description !== undefined && body.description !== null) {
      if (typeof body.description !== 'string') throw bad('description must be a string');
      description = body.description;
    }
    const assignees = validateAssignees(board, body.assignees) || [];
    const labels = validateLabels(board, body.labels) || [];
    const dueDate = validDate(body.dueDate);
    const position = validIndex(body.position, 'position');
    if (column.wipLimit !== null && cardsInColumn(column.id).length >= column.wipLimit) {
      throw conflict('WIP limit reached for this column', 'wip_limit');
    }
    const t = now();
    const card = {
      id: uid(),
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
    const list = cardsInColumn(column.id);
    list.splice(position === undefined ? list.length : clamp(position, 0, list.length), 0, card);
    db.cards.push(card);
    list.forEach((c, i) => { c.position = i; });
    logActivity(board.id, 'card.created', user.id, card.id, { columnId: column.id, title });
    return [201, cardView(card)];
  }

  function getCard({ user, params }) {
    const { card } = cardAccess(user, params.id, 'viewer');
    return [200, cardView(card)];
  }

  function patchCard({ user, params, body }) {
    const { board, card } = cardAccess(user, params.id, 'editor');
    if (!isObj(body)) throw bad('Body must be a JSON object');
    const updates = {};
    if (body.title !== undefined) updates.title = validName(body.title, 200, 'title');
    if (body.description !== undefined) {
      if (body.description === null) updates.description = '';
      else if (typeof body.description === 'string') updates.description = body.description;
      else throw bad('description must be a string');
    }
    if (body.assignees !== undefined) updates.assignees = validateAssignees(board, body.assignees) || [];
    if (body.labels !== undefined) updates.labels = validateLabels(board, body.labels) || [];
    if (body.dueDate !== undefined) updates.dueDate = validDate(body.dueDate);
    Object.assign(card, updates, { updatedAt: now() });
    logActivity(board.id, 'card.updated', user.id, card.id, { fields: Object.keys(updates) });
    return [200, cardView(card)];
  }

  function deleteCard({ user, params }) {
    const { board, card } = cardAccess(user, params.id, 'editor');
    removeCards([card.id]);
    reindexColumn(card.columnId);
    logActivity(board.id, 'card.deleted', user.id, card.id, { title: card.title });
    return [204];
  }

  function moveCard({ user, params, body }) {
    const { board, card } = cardAccess(user, params.id, 'editor');
    if (!isObj(body) || typeof body.columnId !== 'string') throw bad('columnId is required');
    const target = db.columns.find((c) => c.id === body.columnId && c.boardId === board.id);
    if (!target) throw bad('Target column must exist on the same board');
    const position = validIndex(body.position, 'position');
    const fromColumnId = card.columnId;
    const sameColumn = target.id === fromColumnId;
    const sourceOthers = cardsInColumn(fromColumnId).filter((c) => c.id !== card.id);
    const list = sameColumn ? sourceOthers : cardsInColumn(target.id);
    if (!sameColumn && target.wipLimit !== null && list.length >= target.wipLimit) {
      throw conflict('WIP limit reached for target column', 'wip_limit');
    }
    const idx = position === undefined ? list.length : clamp(position, 0, list.length);
    card.columnId = target.id;
    card.updatedAt = now();
    list.splice(idx, 0, card);
    list.forEach((c, i) => { c.position = i; });
    if (!sameColumn) sourceOthers.forEach((c, i) => { c.position = i; });
    logActivity(board.id, 'card.moved', user.id, card.id, {
      fromColumnId,
      toColumnId: target.id,
      position: idx,
    });
    return [200, cardView(card)];
  }

  // ---------- labels ----------
  function createLabel({ user, params, body }) {
    const { board } = boardAccess(user, params.id, 'editor');
    if (!isObj(body)) throw bad('Body must be a JSON object');
    const name = validName(body.name, 50, 'name');
    if (typeof body.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(body.color)) {
      throw bad('color must be a #rrggbb hex string');
    }
    const lower = name.toLowerCase();
    if (db.labels.some((l) => l.boardId === board.id && l.name.toLowerCase() === lower)) {
      throw conflict('Label name already exists on this board');
    }
    const label = { id: uid(), boardId: board.id, name, color: body.color };
    db.labels.push(label);
    return [201, labelView(label)];
  }

  function deleteLabel({ user, params }) {
    const label = findLabel(params.id);
    if (!label) throw notFound('Label not found');
    boardAccess(user, label.boardId, 'editor');
    db.labels = db.labels.filter((l) => l.id !== label.id);
    for (const c of db.cards) {
      if (c.labels.includes(label.id)) c.labels = c.labels.filter((x) => x !== label.id);
    }
    return [204];
  }

  // ---------- comments ----------
  function addComment({ user, params, body }) {
    const { board, card } = cardAccess(user, params.id, 'editor');
    if (!isObj(body) || typeof body.body !== 'string' || body.body.length < 1 || body.body.length > 5000) {
      throw bad('body must be a string of 1-5000 characters');
    }
    const comment = {
      id: uid(),
      cardId: card.id,
      authorId: user.id,
      body: body.body,
      createdAt: now(),
    };
    db.comments.push(comment);
    logActivity(board.id, 'comment.added', user.id, card.id, { commentId: comment.id });
    return [201, { ...comment }];
  }

  function listComments({ user, params }) {
    const { card } = cardAccess(user, params.id, 'viewer');
    return [200, db.comments.filter((c) => c.cardId === card.id).map((c) => ({ ...c }))];
  }

  function deleteComment({ user, params }) {
    const comment = findComment(params.id);
    if (!comment) throw notFound('Comment not found');
    const card = findCard(comment.cardId);
    if (!card) throw notFound('Comment not found');
    const { role } = boardAccess(user, card.boardId, 'viewer');
    if (comment.authorId !== user.id && role !== 'owner') throw forbidden('Only the author or board owner can delete this comment');
    db.comments = db.comments.filter((c) => c.id !== comment.id);
    return [204];
  }

  // ---------- search & activity ----------
  function searchCards({ user, params, query }) {
    const { board } = boardAccess(user, params.id, 'viewer');
    if (query.due_before !== undefined && query.due_before !== '') validDate(query.due_before);
    const q = query.q ? query.q.toLowerCase() : '';
    const colPos = new Map(columnsOfBoard(board.id).map((c) => [c.id, c.position]));
    let cards = db.cards.filter((c) => c.boardId === board.id);
    if (q) {
      cards = cards.filter((c) => c.title.toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q));
    }
    if (query.assignee) cards = cards.filter((c) => c.assignees.includes(query.assignee));
    if (query.label) cards = cards.filter((c) => c.labels.includes(query.label));
    if (query.column) cards = cards.filter((c) => c.columnId === query.column);
    if (query.due_before) cards = cards.filter((c) => c.dueDate && c.dueDate < query.due_before);
    cards.sort((a, b) => (colPos.get(a.columnId) - colPos.get(b.columnId)) || (a.position - b.position));
    return [200, cards.map(cardView)];
  }

  function listActivity({ user, params, query }) {
    const { board } = boardAccess(user, params.id, 'viewer');
    let limit = 50;
    if (query.limit !== undefined) {
      if (!/^\d+$/.test(query.limit) || Number(query.limit) < 1) throw bad('limit must be a positive integer');
      limit = Number(query.limit);
    }
    const entries = db.activity.filter((a) => a.boardId === board.id).slice(-limit).reverse();
    return [200, entries.map((a) => ({ ...a }))];
  }

  // ---------- routing ----------
  const routes = [
    compileRoute('POST', '/api/auth/register', register, false),
    compileRoute('POST', '/api/auth/login', login, false),
    compileRoute('POST', '/api/auth/logout', logout),
    compileRoute('GET', '/api/auth/me', me),
    compileRoute('POST', '/api/boards', createBoard),
    compileRoute('GET', '/api/boards', listBoards),
    compileRoute('GET', '/api/boards/:id', getBoard),
    compileRoute('PATCH', '/api/boards/:id', patchBoard),
    compileRoute('DELETE', '/api/boards/:id', deleteBoard),
    compileRoute('POST', '/api/boards/:id/members', addMember),
    compileRoute('PATCH', '/api/boards/:id/members/:userId', patchMember),
    compileRoute('DELETE', '/api/boards/:id/members/:userId', removeMember),
    compileRoute('POST', '/api/boards/:id/columns', createColumn),
    compileRoute('PATCH', '/api/columns/:id', patchColumn),
    compileRoute('DELETE', '/api/columns/:id', deleteColumn),
    compileRoute('POST', '/api/columns/:id/cards', createCard),
    compileRoute('GET', '/api/cards/:id', getCard),
    compileRoute('PATCH', '/api/cards/:id', patchCard),
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

  function serveStatic(req, res, pathname) {
    const rel = pathname.slice('/static/'.length);
    const staticDir = path.join(PUBLIC_DIR, 'static');
    const file = path.resolve(staticDir, rel);
    if (!rel || !file.startsWith(staticDir + path.sep)) {
      sendError(res, notFound('Not found'));
      return;
    }
    sendFile(res, file);
  }

  async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;

      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
        return;
      }
      if (req.method === 'GET' && pathname.startsWith('/static/')) {
        serveStatic(req, res, pathname);
        return;
      }

      let matched = null;
      let params = {};
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(pathname);
        if (!m) continue;
        matched = r;
        r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
        break;
      }
      if (!matched) throw notFound('Route not found');

      let token = null;
      let user = null;
      if (matched.auth) {
        const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization || '');
        if (!m) throw unauth();
        const userId = sessions.get(m[1]);
        user = userId ? findUser(userId) : null;
        if (!user) throw unauth('Invalid or expired token');
        token = m[1];
      }

      const raw = await readBody(req);
      let body = {};
      if (raw.trim() !== '') {
        try {
          body = JSON.parse(raw);
        } catch {
          throw bad('Request body is not valid JSON');
        }
      }

      const query = Object.fromEntries(url.searchParams);
      const [status, payload] = matched.fn({ params, query, body, user, token });
      if (req.method !== 'GET' && status < 400) save();
      sendJson(res, status, payload);
    } catch (err) {
      sendError(res, err);
    }
  }

  return http.createServer((req, res) => { handle(req, res); });
}
