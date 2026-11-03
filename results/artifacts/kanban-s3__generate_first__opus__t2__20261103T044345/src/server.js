import http from 'node:http';
import crypto from 'node:crypto';
import { createStore } from './store.js';
import { INDEX_HTML, APP_JS, APP_CSS } from './ui.js';

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
const conflict = (msg = 'Conflict', code = 'conflict') => new HttpError(409, code, msg);
const unauth = (msg = 'Authentication required') => new HttpError(401, 'unauthenticated', msg);

const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED = 5;
const MAX_BODY = 1024 * 1024;

const newId = () => crypto.randomUUID();
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}
function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [scheme, saltHex, hashHex] = stored.split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function strField(v, name, min, max) {
  if (typeof v !== 'string') throw bad(`${name} must be a string`);
  const t = v.trim();
  if (t.length < min || v.length > max) throw bad(`${name} must be ${min}-${max} characters`);
  return min > 0 ? t : v;
}

function nowAfter(prev) {
  let t = Date.now();
  if (prev) {
    const p = Date.parse(prev);
    if (!Number.isNaN(p) && t <= p) t = p + 1;
  }
  return new Date(t).toISOString();
}

export function createServer({ dataFile } = {}) {
  const store = createStore(dataFile);
  const { users, boards, columns, cards, labels, comments, activity } = store.data;
  const sessions = new Map(); // token -> userId
  const failedLogins = new Map(); // username -> [timestamps]

  // ---------- helpers ----------
  const publicUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName });
  const findUserByName = (name) => {
    const n = String(name).toLowerCase();
    for (const u of users.values()) if (u.username === n) return u;
    return null;
  };

  const boardColumns = (boardId) =>
    [...columns.values()].filter((c) => c.boardId === boardId).sort((a, b) => a.position - b.position);
  const columnCards = (columnId) =>
    [...cards.values()].filter((c) => c.columnId === columnId).sort((a, b) => a.position - b.position);
  const boardLabels = (boardId) => [...labels.values()].filter((l) => l.boardId === boardId);

  const compactColumns = (boardId) => boardColumns(boardId).forEach((c, i) => { c.position = i; });
  const setOrder = (list) => list.forEach((c, i) => { c.position = i; });

  function roleOf(board, userId) {
    const m = board.members.find((x) => x.userId === userId);
    return m ? m.role : null;
  }
  function requireRole(board, userId, minRole) {
    const role = roleOf(board, userId);
    if (!role) throw forbidden('Not a member of this board');
    if (ROLE_RANK[role] < ROLE_RANK[minRole]) throw forbidden(`Requires ${minRole} role`);
    return role;
  }
  function getBoard(id) {
    const b = boards.get(id);
    if (!b) throw notFound('Board not found');
    return b;
  }
  function getColumn(id) {
    const c = columns.get(id);
    if (!c) throw notFound('Column not found');
    return c;
  }
  function getCard(id) {
    const c = cards.get(id);
    if (!c) throw notFound('Card not found');
    return c;
  }

  function log(boardId, type, actorId, details = {}, cardId) {
    const e = { id: newId(), boardId, type, actorId, at: new Date().toISOString(), details };
    if (cardId) e.cardId = cardId;
    activity.set(e.id, e);
  }

  const columnOut = (c) => ({ id: c.id, boardId: c.boardId, name: c.name, position: c.position, wipLimit: c.wipLimit ?? null });
  const cardOut = (c) => ({ ...c, assignees: [...c.assignees], labels: [...c.labels] });
  const membersOut = (b) => b.members.map((m) => {
    const u = users.get(m.userId);
    return { userId: m.userId, username: u ? u.username : null, displayName: u ? u.displayName : null, role: m.role };
  });
  function boardOut(b) {
    return {
      id: b.id, name: b.name, description: b.description, ownerId: b.ownerId, createdAt: b.createdAt,
      members: membersOut(b),
      labels: boardLabels(b.id),
      columns: boardColumns(b.id).map((c) => ({ ...columnOut(c), cards: columnCards(c.id).map(cardOut) })),
    };
  }

  function parseWip(v) {
    if (v === null || v === undefined) return null;
    if (!Number.isInteger(v) || v < 1) throw bad('wipLimit must be a positive integer or null');
    return v;
  }
  function parsePosition(v) {
    if (v === undefined || v === null) return undefined;
    if (typeof v !== 'number' || !Number.isInteger(v)) throw bad('position must be an integer');
    return v;
  }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function validateAssignees(board, v) {
    if (!Array.isArray(v)) throw bad('assignees must be an array');
    const out = [];
    for (const id of v) {
      if (typeof id !== 'string' || !roleOf(board, id)) throw bad('assignees must be board members');
      if (!out.includes(id)) out.push(id);
    }
    return out;
  }
  function validateLabels(board, v) {
    if (!Array.isArray(v)) throw bad('labels must be an array');
    const out = [];
    for (const id of v) {
      const l = typeof id === 'string' ? labels.get(id) : null;
      if (!l || l.boardId !== board.id) throw bad('labels must belong to the board');
      if (!out.includes(id)) out.push(id);
    }
    return out;
  }
  function validateDue(v) {
    if (v === null || v === undefined) return null;
    if (!isValidDate(v)) throw bad('dueDate must be YYYY-MM-DD or null');
    return v;
  }

  function deleteCardData(cardId) {
    cards.delete(cardId);
    for (const cm of [...comments.values()]) if (cm.cardId === cardId) comments.delete(cm.id);
  }

  // ---------- route handlers ----------
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, handler, auth: opts.auth !== false });
  };

  // auth
  route('POST', '/api/auth/register', ({ body }) => {
    const { username, password, displayName } = body;
    if (typeof username !== 'string' || !/^[a-zA-Z0-9_]{3,32}$/.test(username)) throw bad('username must be 3-32 chars of [a-z0-9_]');
    if (typeof password !== 'string' || password.length < 8) throw bad('password must be at least 8 characters');
    let dn = username.toLowerCase();
    if (displayName !== undefined && displayName !== null) dn = strField(displayName, 'displayName', 1, 100);
    const uname = username.toLowerCase();
    if (findUserByName(uname)) throw conflict('Username already taken');
    const u = { id: newId(), username: uname, displayName: dn, passwordHash: hashPassword(password), createdAt: new Date().toISOString() };
    users.set(u.id, u);
    return [201, { user: publicUser(u) }, true];
  }, { auth: false });

  route('POST', '/api/auth/login', ({ body }) => {
    const { username, password } = body;
    if (typeof username !== 'string' || typeof password !== 'string') throw bad('username and password required');
    const key = username.toLowerCase();
    const now = Date.now();
    const attempts = (failedLogins.get(key) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
    failedLogins.set(key, attempts);
    if (attempts.length >= MAX_FAILED) throw new HttpError(429, 'rate_limited', 'Too many failed login attempts');
    const u = findUserByName(key);
    if (!u || !verifyPassword(password, u.passwordHash)) {
      attempts.push(now);
      throw new HttpError(401, 'invalid_credentials', 'Invalid username or password');
    }
    failedLogins.delete(key);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, u.id);
    return [200, { token, user: publicUser(u) }];
  }, { auth: false });

  route('POST', '/api/auth/logout', ({ token }) => {
    sessions.delete(token);
    return [204];
  });
  route('GET', '/api/auth/me', ({ user }) => [200, { user: publicUser(user) }]);

  // boards
  route('POST', '/api/boards', ({ user, body }) => {
    const name = strField(body.name, 'name', 1, 100);
    let description = '';
    if (body.description !== undefined && body.description !== null) {
      if (typeof body.description !== 'string' || body.description.length > 5000) throw bad('description must be a string');
      description = body.description;
    }
    let colNames = ['To Do', 'In Progress', 'Done'];
    if (body.columns !== undefined && body.columns !== null) {
      if (!Array.isArray(body.columns)) throw bad('columns must be an array of names');
      colNames = body.columns.map((c) => strField(c, 'column name', 1, 100));
    }
    const b = { id: newId(), name, description, ownerId: user.id, createdAt: new Date().toISOString(), members: [{ userId: user.id, role: 'owner' }] };
    boards.set(b.id, b);
    log(b.id, 'board.created', user.id, { name });
    colNames.forEach((n, i) => {
      const c = { id: newId(), boardId: b.id, name: n, position: i, wipLimit: null };
      columns.set(c.id, c);
      log(b.id, 'column.created', user.id, { columnId: c.id, name: n });
    });
    return [201, boardOut(b), true];
  });

  route('GET', '/api/boards', ({ user }) => {
    const out = [];
    for (const b of boards.values()) {
      const role = roleOf(b, user.id);
      if (role) out.push({ id: b.id, name: b.name, description: b.description, role });
    }
    return [200, out];
  });

  route('GET', '/api/boards/:id', ({ user, params }) => {
    const b = getBoard(params.id);
    requireRole(b, user.id, 'viewer');
    return [200, boardOut(b)];
  });

  route('PATCH', '/api/boards/:id', ({ user, params, body }) => {
    const b = getBoard(params.id);
    requireRole(b, user.id, 'owner');
    const changes = {};
    if (has(body, 'name')) changes.name = strField(body.name, 'name', 1, 100);
    if (has(body, 'description')) {
      if (body.description !== null && (typeof body.description !== 'string' || body.description.length > 5000)) throw bad('description must be a string');
      changes.description = body.description ?? '';
    }
    Object.assign(b, changes);
    log(b.id, 'board.updated', user.id, { changes: Object.keys(changes) });
    return [200, boardOut(b), true];
  });

  route('DELETE', '/api/boards/:id', ({ user, params }) => {
    const b = getBoard(params.id);
    requireRole(b, user.id, 'owner');
    for (const c of [...cards.values()]) if (c.boardId === b.id) deleteCardData(c.id);
    for (const c of [...columns.values()]) if (c.boardId === b.id) columns.delete(c.id);
    for (const l of [...labels.values()]) if (l.boardId === b.id) labels.delete(l.id);
    for (const a of [...activity.values()]) if (a.boardId === b.id) activity.delete(a.id);
    boards.delete(b.id);
    return [204, null, true];
  });

  // members
  route('GET', '/api/boards/:id/members', ({ user, params }) => {
    const b = getBoard(params.id);
    requireRole(b, user.id, 'viewer');
    return [200, membersOut(b)];
  });

  route('POST', '/api/boards/:id/members', ({ user, params, body }) => {
    const b = getBoard(params.id);
    requireRole(b, user.id, 'owner');
    if (typeof body.username !== 'string') throw bad('username required');
    if (body.role !== 'editor' && body.role !== 'viewer') throw bad('role must be editor or viewer');
    const u = findUserByName(body.username);
    if (!u) throw notFound('User not found');
    if (roleOf(b, u.id)) throw conflict('User is already a member');
    b.members.push({ userId: u.id, role: body.role });
    log(b.id, 'member.added', user.id, { userId: u.id, role: body.role });
    return [201, { userId: u.id, username: u.username, role: body.role }, true];
  });

  route('PATCH', '/api/boards/:id/members/:userId', ({ user, params, body }) => {
    const b = getBoard(params.id);
    requireRole(b, user.id, 'owner');
    const m = b.members.find((x) => x.userId === params.userId);
    if (!m) throw notFound('Member not found');
    if (body.role !== 'editor' && body.role !== 'viewer') throw bad('role must be editor or viewer');
    if (m.role === 'owner') throw bad('Cannot change the owner role');
    m.role = body.role;
    log(b.id, 'member.updated', user.id, { userId: m.userId, role: m.role });
    const u = users.get(m.userId);
    return [200, { userId: m.userId, username: u ? u.username : null, role: m.role }, true];
  });

  route('DELETE', '/api/boards/:id/members/:userId', ({ user, params }) => {
    const b = getBoard(params.id);
    const myRole = roleOf(b, user.id);
    if (!myRole) throw forbidden('Not a member of this board');
    if (myRole !== 'owner' && params.userId !== user.id) throw forbidden('Only the owner can remove other members');
    const m = b.members.find((x) => x.userId === params.userId);
    if (!m) throw notFound('Member not found');
    if (m.role === 'owner') throw bad('Cannot remove the board owner');
    b.members = b.members.filter((x) => x.userId !== params.userId);
    for (const c of cards.values()) {
      if (c.boardId === b.id && c.assignees.includes(params.userId)) c.assignees = c.assignees.filter((x) => x !== params.userId);
    }
    log(b.id, 'member.removed', user.id, { userId: params.userId });
    return [204, null, true];
  });

  // columns
  route('GET', '/api/boards/:id/columns', ({ user, params }) => {
    const b = getBoard(params.id);
    requireRole(b, user.id, 'viewer');
    return [200, boardColumns(b.id).map(columnOut)];
  });

  route('POST', '/api/boards/:id/columns', ({ user, params, body }) => {
    const b = getBoard(params.id);
    requireRole(b, user.id, 'editor');
    const name = strField(body.name, 'name', 1, 100);
    const wipLimit = parseWip(body.wipLimit);
    const c = { id: newId(), boardId: b.id, name, position: boardColumns(b.id).length, wipLimit };
    columns.set(c.id, c);
    log(b.id, 'column.created', user.id, { columnId: c.id, name });
    return [201, columnOut(c), true];
  });

  route('GET', '/api/columns/:id', ({ user, params }) => {
    const c = getColumn(params.id);
    requireRole(getBoard(c.boardId), user.id, 'viewer');
    return [200, { ...columnOut(c), cards: columnCards(c.id).map(cardOut) }];
  });

  route('PATCH', '/api/columns/:id', ({ user, params, body }) => {
    const c = getColumn(params.id);
    const b = getBoard(c.boardId);
    requireRole(b, user.id, 'editor');
    let name, wip, pos;
    if (has(body, 'name')) name = strField(body.name, 'name', 1, 100);
    if (has(body, 'wipLimit')) wip = parseWip(body.wipLimit);
    if (has(body, 'position')) {
      if (typeof body.position !== 'number' || !Number.isInteger(body.position)) throw bad('position must be an integer');
      pos = body.position;
    }
    if (name !== undefined) c.name = name;
    if (has(body, 'wipLimit')) c.wipLimit = wip;
    if (pos !== undefined) {
      const list = boardColumns(b.id).filter((x) => x.id !== c.id);
      list.splice(clamp(pos, 0, list.length), 0, c);
      setOrder(list);
    }
    log(b.id, 'column.updated', user.id, { columnId: c.id, changes: Object.keys(body) });
    return [200, columnOut(c), true];
  });

  route('DELETE', '/api/columns/:id', ({ user, params, query }) => {
    const c = getColumn(params.id);
    const b = getBoard(c.boardId);
    requireRole(b, user.id, 'editor');
    const cs = columnCards(c.id);
    if (cs.length && query.get('force') !== 'true') throw conflict('Column still has cards', 'column_not_empty');
    for (const card of cs) deleteCardData(card.id);
    columns.delete(c.id);
    compactColumns(b.id);
    log(b.id, 'column.deleted', user.id, { columnId: c.id, name: c.name, cardsDeleted: cs.length });
    return [204, null, true];
  });

  // cards
  route('POST', '/api/columns/:id/cards', ({ user, params, body }) => {
    const col = getColumn(params.id);
    const b = getBoard(col.boardId);
    requireRole(b, user.id, 'editor');
    const title = strField(body.title, 'title', 1, 200);
    let description = '';
    if (body.description !== undefined && body.description !== null) {
      if (typeof body.description !== 'string' || body.description.length > 10000) throw bad('description must be a string');
      description = body.description;
    }
    const assignees = body.assignees == null ? [] : validateAssignees(b, body.assignees);
    const lbls = body.labels == null ? [] : validateLabels(b, body.labels);
    const dueDate = validateDue(body.dueDate);
    const pos = parsePosition(body.position);
    const list = columnCards(col.id);
    if (col.wipLimit != null && list.length >= col.wipLimit) throw conflict(`WIP limit of ${col.wipLimit} reached`, 'wip_limit');
    const now = new Date().toISOString();
    const card = {
      id: newId(), boardId: b.id, columnId: col.id, title, description, position: 0,
      assignees, labels: lbls, dueDate, createdBy: user.id, createdAt: now, updatedAt: now,
    };
    cards.set(card.id, card);
    list.splice(pos === undefined ? list.length : clamp(pos, 0, list.length), 0, card);
    setOrder(list);
    log(b.id, 'card.created', user.id, { columnId: col.id, title }, card.id);
    return [201, cardOut(card), true];
  });

  route('GET', '/api/cards/:id', ({ user, params }) => {
    const c = getCard(params.id);
    requireRole(getBoard(c.boardId), user.id, 'viewer');
    return [200, cardOut(c)];
  });

  route('PATCH', '/api/cards/:id', ({ user, params, body }) => {
    const c = getCard(params.id);
    const b = getBoard(c.boardId);
    requireRole(b, user.id, 'editor');
    const ch = {};
    if (has(body, 'title')) ch.title = strField(body.title, 'title', 1, 200);
    if (has(body, 'description')) {
      if (body.description !== null && (typeof body.description !== 'string' || body.description.length > 10000)) throw bad('description must be a string');
      ch.description = body.description ?? '';
    }
    if (has(body, 'assignees')) ch.assignees = body.assignees === null ? [] : validateAssignees(b, body.assignees);
    if (has(body, 'labels')) ch.labels = body.labels === null ? [] : validateLabels(b, body.labels);
    if (has(body, 'dueDate')) ch.dueDate = validateDue(body.dueDate);
    Object.assign(c, ch);
    c.updatedAt = nowAfter(c.updatedAt);
    log(b.id, 'card.updated', user.id, { fields: Object.keys(ch) }, c.id);
    return [200, cardOut(c), true];
  });

  route('DELETE', '/api/cards/:id', ({ user, params }) => {
    const c = getCard(params.id);
    const b = getBoard(c.boardId);
    requireRole(b, user.id, 'editor');
    deleteCardData(c.id);
    setOrder(columnCards(c.columnId));
    log(b.id, 'card.deleted', user.id, { columnId: c.columnId, title: c.title }, c.id);
    return [204, null, true];
  });

  route('POST', '/api/cards/:id/move', ({ user, params, body }) => {
    const c = getCard(params.id);
    const b = getBoard(c.boardId);
    requireRole(b, user.id, 'editor');
    if (typeof body.columnId !== 'string') throw bad('columnId required');
    const target = columns.get(body.columnId);
    if (!target || target.boardId !== b.id) throw bad('Target column must be on the same board');
    const pos = parsePosition(body.position);
    const fromColumnId = c.columnId;
    const fromPosition = c.position;
    if (target.id !== fromColumnId) {
      const tlist = columnCards(target.id);
      if (target.wipLimit != null && tlist.length >= target.wipLimit) throw conflict(`WIP limit of ${target.wipLimit} reached`, 'wip_limit');
      const slist = columnCards(fromColumnId).filter((x) => x.id !== c.id);
      setOrder(slist);
      c.columnId = target.id;
      tlist.splice(pos === undefined ? tlist.length : clamp(pos, 0, tlist.length), 0, c);
      setOrder(tlist);
    } else {
      const list = columnCards(target.id).filter((x) => x.id !== c.id);
      list.splice(pos === undefined ? list.length : clamp(pos, 0, list.length), 0, c);
      setOrder(list);
    }
    c.updatedAt = nowAfter(c.updatedAt);
    log(b.id, 'card.moved', user.id, { fromColumnId, toColumnId: target.id, fromPosition, toPosition: c.position }, c.id);
    return [200, cardOut(c), true];
  });

  // labels
  route('GET', '/api/boards/:id/labels', ({ user, params }) => {
    const b = getBoard(params.id);
    requireRole(b, user.id, 'viewer');
    return [200, boardLabels(b.id)];
  });

  const validColor = (v) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
  route('POST', '/api/boards/:id/labels', ({ user, params, body }) => {
    const b = getBoard(params.id);
    requireRole(b, user.id, 'editor');
    const name = strField(body.name, 'name', 1, 50);
    if (!validColor(body.color)) throw bad('color must be #rrggbb');
    const lower = name.toLowerCase();
    if (boardLabels(b.id).some((l) => l.name.toLowerCase() === lower)) throw conflict('Label name already exists');
    const l = { id: newId(), boardId: b.id, name, color: body.color };
    labels.set(l.id, l);
    log(b.id, 'label.created', user.id, { labelId: l.id, name });
    return [201, l, true];
  });

  route('PATCH', '/api/labels/:id', ({ user, params, body }) => {
    const l = labels.get(params.id);
    if (!l) throw notFound('Label not found');
    const b = getBoard(l.boardId);
    requireRole(b, user.id, 'editor');
    let name, color;
    if (has(body, 'name')) {
      name = strField(body.name, 'name', 1, 50);
      const lower = name.toLowerCase();
      if (boardLabels(b.id).some((x) => x.id !== l.id && x.name.toLowerCase() === lower)) throw conflict('Label name already exists');
    }
    if (has(body, 'color')) {
      if (!validColor(body.color)) throw bad('color must be #rrggbb');
      color = body.color;
    }
    if (name !== undefined) l.name = name;
    if (color !== undefined) l.color = color;
    return [200, l, true];
  });

  route('DELETE', '/api/labels/:id', ({ user, params }) => {
    const l = labels.get(params.id);
    if (!l) throw notFound('Label not found');
    const b = getBoard(l.boardId);
    requireRole(b, user.id, 'editor');
    labels.delete(l.id);
    for (const c of cards.values()) if (c.labels.includes(l.id)) c.labels = c.labels.filter((x) => x !== l.id);
    log(b.id, 'label.deleted', user.id, { labelId: l.id, name: l.name });
    return [204, null, true];
  });

  // comments
  route('POST', '/api/cards/:id/comments', ({ user, params, body }) => {
    const c = getCard(params.id);
    const b = getBoard(c.boardId);
    requireRole(b, user.id, 'editor');
    if (typeof body.body !== 'string' || body.body.trim().length < 1 || body.body.length > 5000) throw bad('body must be 1-5000 characters');
    const cm = { id: newId(), cardId: c.id, authorId: user.id, body: body.body, createdAt: new Date().toISOString() };
    comments.set(cm.id, cm);
    log(b.id, 'comment.added', user.id, { commentId: cm.id }, c.id);
    return [201, cm, true];
  });

  route('GET', '/api/cards/:id/comments', ({ user, params }) => {
    const c = getCard(params.id);
    requireRole(getBoard(c.boardId), user.id, 'viewer');
    return [200, [...comments.values()].filter((x) => x.cardId === c.id)];
  });

  route('DELETE', '/api/comments/:id', ({ user, params }) => {
    const cm = comments.get(params.id);
    if (!cm) throw notFound('Comment not found');
    const card = getCard(cm.cardId);
    const b = getBoard(card.boardId);
    const role = roleOf(b, user.id);
    if (!role) throw forbidden('Not a member of this board');
    if (cm.authorId !== user.id && role !== 'owner') throw forbidden('Only the author or board owner can delete this comment');
    comments.delete(cm.id);
    log(b.id, 'comment.deleted', user.id, { commentId: cm.id }, card.id);
    return [204, null, true];
  });

  // search
  route('GET', '/api/boards/:id/cards', ({ user, params, query }) => {
    const b = getBoard(params.id);
    requireRole(b, user.id, 'viewer');
    const q = query.get('q');
    const assignee = query.get('assignee');
    const label = query.get('label');
    const column = query.get('column');
    const due = query.get('due_before');
    if (due && !isValidDate(due)) throw bad('due_before must be YYYY-MM-DD');
    const ql = q ? q.toLowerCase() : '';
    const out = [];
    for (const col of boardColumns(b.id)) {
      if (column && col.id !== column) continue;
      for (const c of columnCards(col.id)) {
        if (ql && !c.title.toLowerCase().includes(ql) && !(c.description || '').toLowerCase().includes(ql)) continue;
        if (assignee && !c.assignees.includes(assignee)) continue;
        if (label && !c.labels.includes(label)) continue;
        if (due && (!c.dueDate || !(c.dueDate < due))) continue;
        out.push(cardOut(c));
      }
    }
    return [200, out];
  });

  // activity
  route('GET', '/api/boards/:id/activity', ({ user, params, query }) => {
    const b = getBoard(params.id);
    requireRole(b, user.id, 'viewer');
    let limit = 50;
    const raw = query.get('limit');
    if (raw !== null && raw !== '') {
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0) throw bad('limit must be a non-negative integer');
      limit = n;
    }
    const list = [...activity.values()].filter((a) => a.boardId === b.id).reverse();
    return [200, list.slice(0, limit)];
  });

  // ---------- request handling ----------
  function send(res, status, body, extraHeaders = {}) {
    if (status === 204 || body === undefined || body === null) {
      res.writeHead(status, extraHeaders);
      res.end();
      return;
    }
    const s = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s), ...extraHeaders });
    res.end(s);
  }
  const sendError = (res, err) => send(res, err.status, { error: err.code, message: err.message });

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (d) => {
        size += d.length;
        if (size > MAX_BODY) { reject(new HttpError(413, 'payload_too_large', 'Body too large')); req.destroy(); return; }
        chunks.push(d);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function serveStatic(req, res, pathname) {
    const assets = {
      '/': ['text/html; charset=utf-8', INDEX_HTML],
      '/index.html': ['text/html; charset=utf-8', INDEX_HTML],
      '/static/app.js': ['application/javascript; charset=utf-8', APP_JS],
      '/static/app.css': ['text/css; charset=utf-8', APP_CSS],
    };
    const a = assets[pathname];
    if (!a || (req.method !== 'GET' && req.method !== 'HEAD')) return false;
    res.writeHead(200, { 'Content-Type': a[0], 'Content-Length': Buffer.byteLength(a[1]) });
    res.end(req.method === 'HEAD' ? undefined : a[1]);
    return true;
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/') && serveStatic(req, res, pathname)) return;

    let matched = null;
    let pathMatched = false;
    for (const r of routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== req.method) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      matched = { r, params };
      break;
    }
    if (!matched) {
      throw pathMatched ? new HttpError(404, 'not_found', 'Route not found') : notFound('Route not found');
    }

    const ctx = { params: matched.params, query: url.searchParams, body: {} };
    if (matched.r.auth) {
      const h = req.headers.authorization || '';
      const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
      if (!m) throw unauth();
      const userId = sessions.get(m[1]);
      const user = userId && users.get(userId);
      if (!user) throw unauth('Invalid or expired token');
      ctx.user = user;
      ctx.token = m[1];
    }
    if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
      const raw = await readBody(req);
      if (raw.trim()) {
        let parsed;
        try { parsed = JSON.parse(raw); } catch { throw new HttpError(400, 'invalid_json', 'Invalid JSON body'); }
        if (!isObj(parsed)) throw bad('Body must be a JSON object');
        ctx.body = parsed;
      }
    } else {
      req.resume();
    }
    const [status, body, mutated] = matched.r.handler(ctx);
    if (mutated) store.save();
    send(res, status, body);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) { res.end(); return; }
      if (err instanceof HttpError) sendError(res, err);
      else {
        console.error(err);
        send(res, 500, { error: 'internal', message: 'Internal server error' });
      }
    });
  });
  return server;
}
