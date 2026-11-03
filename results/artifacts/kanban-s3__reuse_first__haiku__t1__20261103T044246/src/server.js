// Kanban board service: JSON REST API over node:http with file persistence.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const DEFAULT_COLUMNS = ['To Do', 'In Progress', 'Done'];
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const ACTIVITY_DEFAULT_LIMIT = 50;
const MAX_BODY_BYTES = 1024 * 1024;
const USERNAME_RE = /^[a-z0-9_]{3,32}$/;
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };
const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };

class HttpError extends Error {
  constructor(status, error, message) {
    super(message || error);
    this.status = status;
    this.error = error;
  }
}
const fail = (status, error, message) => { throw new HttpError(status, error, message); };
const bad = (message) => fail(400, 'validation_error', message);
const now = () => new Date().toISOString();
const newId = () => crypto.randomUUID();

function emptyState() {
  return { users: [], boards: [], members: [], columns: [], cards: [], labels: [], comments: [], activity: [] };
}

function loadState(file) {
  if (!file || !fs.existsSync(file)) return emptyState();
  const raw = fs.readFileSync(file, 'utf8').trim();
  return raw ? { ...emptyState(), ...JSON.parse(raw) } : emptyState();
}

function saveState(file, state) {
  if (!file) return;
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
}

// scrypt-based salted password hashing: "scrypt$<salt>$<hash>"
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [, salt, hashHex] = String(stored).split('$');
  const expected = Buffer.from(hashHex || '', 'hex');
  const actual = crypto.scryptSync(password, salt || '', 64);
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}

function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function checkName(v, label, max) {
  if (typeof v !== 'string') bad(`${label} must be a string`);
  const t = v.trim();
  if (t.length < 1 || t.length > max) bad(`${label} must be 1-${max} characters`);
  return t;
}

function checkDescription(v) {
  if (v == null) return '';
  if (typeof v !== 'string' || v.length > 10000) bad('description must be a string up to 10000 characters');
  return v;
}

function checkWipLimit(v) {
  if (v == null) return null;
  if (!Number.isInteger(v) || v < 1) bad('wipLimit must be a positive integer or null');
  return v;
}

function checkPosition(v) {
  if (v == null) return null;
  if (!Number.isInteger(v)) bad('position must be an integer');
  return Math.max(0, v);
}

function clamp(n, lo, hi) {
  return Math.min(Math.max(n, lo), hi);
}

export function createServer({ dataFile } = {}) {
  const state = loadState(dataFile);
  const sessions = new Map(); // token -> userId (sessions are not persisted)
  const loginFailures = new Map(); // username -> [timestamps of failed attempts]
  const routes = [];

  const route = (method, pattern, handler, { auth = true, body = false } = {}) => {
    const names = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
    routes.push({ method, re, names, handler, auth, body });
  };

  // ---------- helpers over state ----------
  const user = (id) => state.users.find((u) => u.id === id);
  const userOut = (u) => ({ id: u.id, username: u.username, displayName: u.displayName });
  const boardOrFail = (id) => state.boards.find((b) => b.id === id) || fail(404, 'not_found', 'Board not found');
  const columnOrFail = (id) => state.columns.find((c) => c.id === id) || fail(404, 'not_found', 'Column not found');
  const cardOrFail = (id) => state.cards.find((c) => c.id === id) || fail(404, 'not_found', 'Card not found');
  const commentOrFail = (id) => state.comments.find((c) => c.id === id) || fail(404, 'not_found', 'Comment not found');
  const labelOrFail = (id) => state.labels.find((l) => l.id === id) || fail(404, 'not_found', 'Label not found');
  const memberOf = (boardId, userId) => state.members.find((m) => m.boardId === boardId && m.userId === userId);

  // Resolve a board-scoped resource and enforce membership + minimum role.
  function access(boardId, actor, min = 'viewer') {
    const board = boardOrFail(boardId);
    const m = memberOf(boardId, actor.id);
    if (!m) fail(403, 'forbidden', 'Not a member of this board');
    if (ROLE_RANK[m.role] < ROLE_RANK[min]) fail(403, 'forbidden', `Requires ${min} role`);
    return { board, role: m.role };
  }

  const columnsOf = (boardId) => state.columns.filter((c) => c.boardId === boardId).sort((a, b) => a.position - b.position);
  const cardsIn = (columnId) => state.cards.filter((c) => c.columnId === columnId).sort((a, b) => a.position - b.position);
  const renumber = (list) => list.forEach((item, i) => { item.position = i; });

  function logActivity(boardId, type, actorId, details = {}, cardId) {
    const entry = { id: newId(), boardId, type, actorId, at: now(), details };
    if (cardId) entry.cardId = cardId;
    state.activity.push(entry);
  }

  function boardDetail(board) {
    return {
      id: board.id,
      name: board.name,
      description: board.description,
      ownerId: board.ownerId,
      createdAt: board.createdAt,
      members: state.members.filter((m) => m.boardId === board.id).map((m) => ({
        userId: m.userId,
        username: user(m.userId)?.username ?? null,
        role: m.role,
      })),
      labels: state.labels.filter((l) => l.boardId === board.id),
      columns: columnsOf(board.id).map((c) => ({
        id: c.id,
        name: c.name,
        position: c.position,
        wipLimit: c.wipLimit,
        cards: cardsIn(c.id),
      })),
    };
  }

  function removeCards(cardIds) {
    const set = new Set(cardIds);
    state.cards = state.cards.filter((c) => !set.has(c.id));
    state.comments = state.comments.filter((c) => !set.has(c.cardId));
  }

  // Validate card fields. Returns only the keys that were supplied (or all when !partial).
  function cardFields(boardId, body, partial) {
    const out = {};
    const has = (k) => Object.prototype.hasOwnProperty.call(body, k) && body[k] !== undefined;
    if (!partial || has('title')) out.title = checkName(body.title, 'title', 200);
    if (!partial || has('description')) out.description = checkDescription(body.description);
    if (!partial || has('assignees')) {
      const v = body.assignees ?? [];
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) bad('assignees must be an array of user ids');
      out.assignees = [...new Set(v)];
      for (const uid of out.assignees) {
        if (!memberOf(boardId, uid)) bad('assignee must be a board member');
      }
    }
    if (!partial || has('labels')) {
      const v = body.labels ?? [];
      if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) bad('labels must be an array of label ids');
      out.labels = [...new Set(v)];
      for (const lid of out.labels) {
        if (!state.labels.some((l) => l.id === lid && l.boardId === boardId)) bad('label does not belong to this board');
      }
    }
    if (!partial || has('dueDate')) {
      const v = body.dueDate ?? null;
      if (v !== null && !isValidDate(v)) bad('dueDate must be YYYY-MM-DD or null');
      out.dueDate = v;
    }
    return out;
  }

  // Insert card into column at requested index (default: end) and renumber.
  function placeCard(card, column, requested) {
    const list = cardsIn(column.id).filter((c) => c.id !== card.id);
    const idx = requested == null ? list.length : clamp(requested, 0, list.length);
    list.splice(idx, 0, card);
    card.columnId = column.id;
    renumber(list);
    return list;
  }

  function checkWip(column, currentCount) {
    if (column.wipLimit != null && currentCount >= column.wipLimit) {
      fail(409, 'wip_limit', `Column "${column.name}" is at its WIP limit`);
    }
  }

  // ---------- auth ----------
  function authenticate(req) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    if (!m) fail(401, 'unauthorized', 'Missing bearer token');
    const uid = sessions.get(m[1]);
    const u = uid && user(uid);
    if (!u) fail(401, 'unauthorized', 'Invalid or expired token');
    return { ...u, token: m[1] };
  }

  function recentFailures(username) {
    const cutoff = Date.now() - LOGIN_WINDOW_MS;
    const recent = (loginFailures.get(username) || []).filter((t) => t > cutoff);
    loginFailures.set(username, recent);
    return recent;
  }

  // ---------- routes: auth ----------
  route('POST', '/api/auth/register', async ({ body: getBody }) => {
    const body = getBody();
    const username = typeof body.username === 'string' ? body.username.toLowerCase() : '';
    if (!USERNAME_RE.test(username)) bad('username must be 3-32 characters of a-z, 0-9, _');
    if (typeof body.password !== 'string' || body.password.length < 8) bad('password must be at least 8 characters');
    const displayName = body.displayName == null ? username : checkName(body.displayName, 'displayName', 100);
    if (state.users.some((u) => u.username === username)) fail(409, 'conflict', 'Username already taken');
    const u = { id: newId(), username, displayName, passwordHash: hashPassword(body.password), createdAt: now() };
    state.users.push(u);
    return [201, { user: userOut(u) }];
  }, { auth: false, body: true });

  route('POST', '/api/auth/login', async ({ body: getBody }) => {
    const body = getBody();
    if (typeof body.username !== 'string' || typeof body.password !== 'string') bad('username and password are required');
    const username = body.username.toLowerCase();
    const failures = recentFailures(username);
    if (failures.length >= LOGIN_MAX_FAILURES) fail(429, 'rate_limited', 'Too many failed login attempts; try again later');
    const u = state.users.find((x) => x.username === username);
    if (!u || !verifyPassword(body.password, u.passwordHash)) {
      loginFailures.set(username, [...failures, Date.now()]);
      fail(401, 'unauthorized', 'Invalid username or password');
    }
    loginFailures.delete(username);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, u.id);
    return [200, { token, user: userOut(u) }];
  }, { auth: false, body: true });

  route('POST', '/api/auth/logout', async ({ user: me }) => {
    sessions.delete(me.token);
    return [204];
  });

  route('GET', '/api/auth/me', async ({ user: me }) => [200, { user: userOut(me) }]);

  // ---------- routes: boards ----------
  route('POST', '/api/boards', async ({ user: me, body: getBody }) => {
    const body = getBody();
    const name = checkName(body.name, 'name', 100);
    const description = checkDescription(body.description);
    const columnNames = body.columns === undefined ? DEFAULT_COLUMNS : body.columns;
    if (!Array.isArray(columnNames) || !columnNames.every((n) => typeof n === 'string')) bad('columns must be an array of names');
    const cleanCols = columnNames.map((n) => checkName(n, 'column name', 100));
    const board = { id: newId(), name, description, ownerId: me.id, createdAt: now() };
    state.boards.push(board);
    state.members.push({ boardId: board.id, userId: me.id, role: 'owner' });
    cleanCols.forEach((cname, i) => state.columns.push({ id: newId(), boardId: board.id, name: cname, position: i, wipLimit: null }));
    logActivity(board.id, 'board.created', me.id, { name });
    return [201, boardDetail(board)];
  }, { body: true });

  route('GET', '/api/boards', async ({ user: me }) => {
    const out = state.members.filter((m) => m.userId === me.id).map((m) => {
      const b = state.boards.find((x) => x.id === m.boardId);
      return b ? { id: b.id, name: b.name, role: m.role } : null;
    }).filter(Boolean);
    return [200, out];
  });

  route('GET', '/api/boards/:id', async ({ user: me, params }) => {
    const { board } = access(params.id, me);
    return [200, boardDetail(board)];
  });

  route('PATCH', '/api/boards/:id', async ({ user: me, params, body: getBody }) => {
    const { board } = access(params.id, me, 'owner');
    const body = getBody();
    if (body.name !== undefined) board.name = checkName(body.name, 'name', 100);
    if (body.description !== undefined) board.description = checkDescription(body.description);
    board.updatedAt = now();
    return [200, boardDetail(board)];
  }, { body: true });

  route('DELETE', '/api/boards/:id', async ({ user: me, params }) => {
    const { board } = access(params.id, me, 'owner');
    const cardIds = state.cards.filter((c) => c.boardId === board.id).map((c) => c.id);
    removeCards(cardIds);
    state.columns = state.columns.filter((c) => c.boardId !== board.id);
    state.labels = state.labels.filter((l) => l.boardId !== board.id);
    state.members = state.members.filter((m) => m.boardId !== board.id);
    state.activity = state.activity.filter((a) => a.boardId !== board.id);
    state.boards = state.boards.filter((b) => b.id !== board.id);
    return [204];
  });

  // ---------- routes: members ----------
  route('POST', '/api/boards/:id/members', async ({ user: me, params, body: getBody }) => {
    const { board } = access(params.id, me, 'owner');
    const body = getBody();
    if (body.role !== 'editor' && body.role !== 'viewer') bad('role must be editor or viewer');
    const uname = typeof body.username === 'string' ? body.username.toLowerCase() : '';
    const target = state.users.find((u) => u.username === uname);
    if (!target) fail(404, 'not_found', 'User not found');
    if (memberOf(board.id, target.id)) fail(409, 'conflict', 'User is already a member');
    state.members.push({ boardId: board.id, userId: target.id, role: body.role });
    logActivity(board.id, 'member.added', me.id, { userId: target.id, username: target.username, role: body.role });
    return [201, { userId: target.id, username: target.username, role: body.role }];
  }, { body: true });

  route('PATCH', '/api/boards/:id/members/:userId', async ({ user: me, params, body: getBody }) => {
    const { board } = access(params.id, me, 'owner');
    const body = getBody();
    if (body.role !== 'editor' && body.role !== 'viewer') bad('role must be editor or viewer');
    const m = memberOf(board.id, params.userId) || fail(404, 'not_found', 'Member not found');
    if (m.role === 'owner') bad('the owner role cannot be changed');
    m.role = body.role;
    return [200, { userId: m.userId, username: user(m.userId)?.username ?? null, role: m.role }];
  }, { body: true });

  route('DELETE', '/api/boards/:id/members/:userId', async ({ user: me, params }) => {
    const { board, role } = access(params.id, me);
    const isSelf = params.userId === me.id;
    if (!isSelf && role !== 'owner') fail(403, 'forbidden', 'Only the owner can remove other members');
    const m = memberOf(board.id, params.userId) || fail(404, 'not_found', 'Member not found');
    if (m.role === 'owner') bad('the owner cannot be removed');
    state.members = state.members.filter((x) => x !== m);
    for (const c of state.cards) {
      if (c.boardId === board.id) c.assignees = c.assignees.filter((a) => a !== params.userId);
    }
    return [204];
  });

  // ---------- routes: columns ----------
  route('POST', '/api/boards/:id/columns', async ({ user: me, params, body: getBody }) => {
    const { board } = access(params.id, me, 'editor');
    const body = getBody();
    const name = checkName(body.name, 'name', 100);
    const wipLimit = checkWipLimit(body.wipLimit ?? null);
    const position = columnsOf(board.id).length;
    const col = { id: newId(), boardId: board.id, name, position, wipLimit };
    state.columns.push(col);
    logActivity(board.id, 'column.created', me.id, { columnId: col.id, name });
    return [201, { id: col.id, name, position, wipLimit, cards: [] }];
  }, { body: true });

  route('PATCH', '/api/columns/:id', async ({ user: me, params, body: getBody }) => {
    const col = columnOrFail(params.id);
    access(col.boardId, me, 'editor');
    const body = getBody();
    if (body.name !== undefined) col.name = checkName(body.name, 'name', 100);
    if (body.wipLimit !== undefined) col.wipLimit = checkWipLimit(body.wipLimit);
    if (body.position !== undefined && body.position !== null) {
      const pos = checkPosition(body.position);
      const others = columnsOf(col.boardId).filter((c) => c.id !== col.id);
      others.splice(clamp(pos, 0, others.length), 0, col);
      renumber(others);
    }
    return [200, { id: col.id, boardId: col.boardId, name: col.name, position: col.position, wipLimit: col.wipLimit }];
  }, { body: true });

  route('DELETE', '/api/columns/:id', async ({ user: me, params, query }) => {
    const col = columnOrFail(params.id);
    access(col.boardId, me, 'editor');
    const cards = cardsIn(col.id);
    if (cards.length > 0 && query.get('force') !== 'true') {
      fail(409, 'conflict', 'Column still contains cards; use ?force=true to delete them');
    }
    for (const c of cards) logActivity(col.boardId, 'card.deleted', me.id, { title: c.title, columnId: col.id }, c.id);
    removeCards(cards.map((c) => c.id));
    state.columns = state.columns.filter((c) => c.id !== col.id);
    renumber(columnsOf(col.boardId));
    return [204];
  });

  // ---------- routes: cards ----------
  route('POST', '/api/columns/:id/cards', async ({ user: me, params, body: getBody }) => {
    const col = columnOrFail(params.id);
    access(col.boardId, me, 'editor');
    const body = getBody();
    const f = cardFields(col.boardId, body, false);
    const requested = checkPosition(body.position);
    checkWip(col, cardsIn(col.id).length);
    const card = {
      id: newId(), boardId: col.boardId, columnId: col.id, title: f.title, description: f.description,
      position: 0, assignees: f.assignees, labels: f.labels, dueDate: f.dueDate,
      createdBy: me.id, createdAt: now(), updatedAt: null,
    };
    card.updatedAt = card.createdAt;
    placeCard(card, col, requested);
    state.cards.push(card);
    logActivity(col.boardId, 'card.created', me.id, { columnId: col.id, title: card.title }, card.id);
    return [201, card];
  }, { body: true });

  route('GET', '/api/boards/:id/cards', async ({ user: me, params, query }) => {
    const { board } = access(params.id, me);
    const q = (query.get('q') || '').toLowerCase();
    const assignee = query.get('assignee');
    const label = query.get('label');
    const column = query.get('column');
    const dueBefore = query.get('due_before');
    if (dueBefore !== null && !isValidDate(dueBefore)) bad('due_before must be YYYY-MM-DD');
    const colPos = new Map(columnsOf(board.id).map((c) => [c.id, c.position]));
    const out = state.cards.filter((c) => c.boardId === board.id
      && (!q || c.title.toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q))
      && (!assignee || c.assignees.includes(assignee))
      && (!label || c.labels.includes(label))
      && (!column || c.columnId === column)
      && (!dueBefore || (c.dueDate && c.dueDate < dueBefore)));
    out.sort((a, b) => (colPos.get(a.columnId) - colPos.get(b.columnId)) || (a.position - b.position));
    return [200, out];
  });

  route('GET', '/api/cards/:id', async ({ user: me, params }) => {
    const card = cardOrFail(params.id);
    access(card.boardId, me);
    return [200, card];
  });

  route('PATCH', '/api/cards/:id', async ({ user: me, params, body: getBody }) => {
    const card = cardOrFail(params.id);
    access(card.boardId, me, 'editor');
    const body = getBody();
    const f = cardFields(card.boardId, body, true);
    Object.assign(card, f);
    card.updatedAt = now();
    logActivity(card.boardId, 'card.updated', me.id, { fields: Object.keys(f) }, card.id);
    return [200, card];
  }, { body: true });

  route('DELETE', '/api/cards/:id', async ({ user: me, params }) => {
    const card = cardOrFail(params.id);
    access(card.boardId, me, 'editor');
    removeCards([card.id]);
    renumber(cardsIn(card.columnId));
    logActivity(card.boardId, 'card.deleted', me.id, { title: card.title, columnId: card.columnId }, card.id);
    return [204];
  });

  route('POST', '/api/cards/:id/move', async ({ user: me, params, body: getBody }) => {
    const card = cardOrFail(params.id);
    access(card.boardId, me, 'editor');
    const body = getBody();
    if (typeof body.columnId !== 'string') bad('columnId is required');
    const target = state.columns.find((c) => c.id === body.columnId && c.boardId === card.boardId);
    if (!target) bad('target column must exist on the same board');
    const requested = checkPosition(body.position);
    const fromColumnId = card.columnId;
    if (target.id !== fromColumnId) checkWip(target, cardsIn(target.id).length);
    const source = cardsIn(fromColumnId).filter((c) => c.id !== card.id);
    renumber(source);
    placeCard(card, target, requested);
    card.updatedAt = now();
    logActivity(card.boardId, 'card.moved', me.id, { fromColumnId, toColumnId: target.id, position: card.position }, card.id);
    return [200, card];
  }, { body: true });

  // ---------- routes: labels ----------
  route('POST', '/api/boards/:id/labels', async ({ user: me, params, body: getBody }) => {
    const { board } = access(params.id, me, 'editor');
    const body = getBody();
    const name = checkName(body.name, 'name', 50);
    if (typeof body.color !== 'string' || !COLOR_RE.test(body.color)) bad('color must be #rrggbb');
    if (state.labels.some((l) => l.boardId === board.id && l.name.toLowerCase() === name.toLowerCase())) {
      fail(409, 'conflict', 'Label name already exists on this board');
    }
    const label = { id: newId(), boardId: board.id, name, color: body.color };
    state.labels.push(label);
    return [201, label];
  }, { body: true });

  route('DELETE', '/api/labels/:id', async ({ user: me, params }) => {
    const label = labelOrFail(params.id);
    access(label.boardId, me, 'editor');
    state.labels = state.labels.filter((l) => l.id !== label.id);
    for (const c of state.cards) c.labels = c.labels.filter((l) => l !== label.id);
    return [204];
  });

  // ---------- routes: comments ----------
  route('POST', '/api/cards/:id/comments', async ({ user: me, params, body: getBody }) => {
    const card = cardOrFail(params.id);
    access(card.boardId, me, 'editor');
    const body = getBody();
    if (typeof body.body !== 'string' || body.body.length < 1 || body.body.length > 5000) bad('body must be 1-5000 characters');
    const comment = { id: newId(), cardId: card.id, authorId: me.id, body: body.body, createdAt: now() };
    state.comments.push(comment);
    logActivity(card.boardId, 'comment.added', me.id, { commentId: comment.id }, card.id);
    return [201, comment];
  }, { body: true });

  route('GET', '/api/cards/:id/comments', async ({ user: me, params }) => {
    const card = cardOrFail(params.id);
    access(card.boardId, me);
    return [200, state.comments.filter((c) => c.cardId === card.id)];
  });

  route('DELETE', '/api/comments/:id', async ({ user: me, params }) => {
    const comment = commentOrFail(params.id);
    const card = cardOrFail(comment.cardId);
    const { role } = access(card.boardId, me);
    if (comment.authorId !== me.id && role !== 'owner') fail(403, 'forbidden', 'Only the author or board owner can delete this comment');
    state.comments = state.comments.filter((c) => c.id !== comment.id);
    return [204];
  });

  // ---------- routes: activity ----------
  route('GET', '/api/boards/:id/activity', async ({ user: me, params, query }) => {
    access(params.id, me);
    const raw = query.get('limit');
    let limit = ACTIVITY_DEFAULT_LIMIT;
    if (raw !== null) {
      if (!/^\d+$/.test(raw) || Number(raw) < 1) bad('limit must be a positive integer');
      limit = Number(raw);
    }
    const entries = state.activity.filter((a) => a.boardId === params.id).reverse().slice(0, limit);
    return [200, entries];
  });

  // ---------- HTTP plumbing ----------
  function matchRoute(method, pathname) {
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      const params = {};
      r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
      return { r, params };
    }
    return null;
  }

  function readRaw(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => { size += c.length; if (size <= MAX_BODY_BYTES) chunks.push(c); });
      req.on('end', () => (size > MAX_BODY_BYTES ? reject(new HttpError(413, 'payload_too_large', 'Request body too large')) : resolve(Buffer.concat(chunks).toString('utf8'))));
      req.on('error', reject);
    });
  }

  function parseBody(raw) {
    if (!raw.trim()) return {};
    let v;
    try { v = JSON.parse(raw); } catch { fail(400, 'invalid_json', 'Request body is not valid JSON'); }
    if (v === null || typeof v !== 'object' || Array.isArray(v)) bad('request body must be a JSON object');
    return v;
  }

  function sendJson(res, status, body) {
    if (status === 204 || body === undefined) {
      res.writeHead(status);
      return res.end();
    }
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
    res.end(data);
  }

  function sendError(res, status, error, message) {
    sendJson(res, status, { error, message: message || error });
  }

  function serveStatic(res, pathname) {
    const name = pathname === '/' || pathname === '/index.html' ? 'index.html'
      : pathname.startsWith('/static/') ? pathname.slice('/static/'.length) : null;
    if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) return sendError(res, 404, 'not_found', 'Not found');
    const file = path.join(PUBLIC_DIR, name);
    fs.readFile(file, (err, data) => {
      if (err) return sendError(res, 404, 'not_found', 'Not found');
      res.writeHead(200, { 'Content-Type': CONTENT_TYPES[path.extname(name)] || 'application/octet-stream' });
      res.end(data);
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if (req.method === 'GET' && !pathname.startsWith('/api/')) return serveStatic(res, pathname);
    const raw = await readRaw(req);
    const hit = matchRoute(req.method, pathname);
    if (!hit) return sendError(res, 404, 'not_found', 'Route not found');
    const { r, params } = hit;
    const me = r.auth ? authenticate(req) : null;
    const ctx = { user: me, params, query: url.searchParams, body: () => parseBody(raw) };
    const [status, body] = await r.handler(ctx);
    if (req.method !== 'GET' && status < 300) saveState(dataFile, state);
    sendJson(res, status, body);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof HttpError) return sendError(res, err.status, err.error, err.message);
      console.error(err);
      sendError(res, 500, 'internal_error', 'Internal server error');
    });
  });
  return server;
}
