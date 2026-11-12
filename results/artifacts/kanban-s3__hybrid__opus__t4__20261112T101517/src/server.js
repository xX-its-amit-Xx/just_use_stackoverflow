import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX_HTML_PATH = path.join(__dirname, 'public', 'index.html');
const STATIC_DIR = path.join(__dirname, 'public');

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

const newId = () => crypto.randomUUID();
const now = () => new Date().toISOString();

function emptyData() {
  return { users: [], boards: [], columns: [], cards: [], labels: [], comments: [], activity: [] };
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const h = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === h.length && crypto.timingSafeEqual(h, expected);
}

// ---------- validation helpers ----------
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function str(v, field, min, max) {
  if (typeof v !== 'string') throw bad(`${field} must be a string`);
  if (v.length < min || v.length > max) throw bad(`${field} must be ${min}-${max} characters`);
  return v;
}
function trimmedName(v, field, max) {
  if (typeof v !== 'string') throw bad(`${field} must be a string`);
  const t = v.trim();
  if (t.length < 1 || t.length > max) throw bad(`${field} must be 1-${max} characters`);
  return t;
}
function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
function dueDate(v) {
  if (v === null) return null;
  if (!isValidDate(v)) throw bad('dueDate must be YYYY-MM-DD or null');
  return v;
}
function wipLimit(v) {
  if (v === null) return null;
  if (!Number.isInteger(v) || v < 1) throw bad('wipLimit must be a positive integer or null');
  return v;
}
function intPos(v, field = 'position') {
  if (!Number.isInteger(v)) throw bad(`${field} must be an integer`);
  return v;
}
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) {
        reject(new HttpError(413, 'payload_too_large', 'Body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim() === '') return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (!isObj(parsed)) return reject(bad('Body must be a JSON object'));
        resolve(parsed);
      } catch {
        reject(new HttpError(400, 'invalid_json', 'Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function send(res, status, body) {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

export function createServer({ dataFile } = {}) {
  let data = emptyData();
  if (dataFile && fs.existsSync(dataFile)) {
    try {
      const raw = fs.readFileSync(dataFile, 'utf8');
      if (raw.trim()) data = { ...emptyData(), ...JSON.parse(raw) };
    } catch (e) {
      throw new Error(`Failed to load data file ${dataFile}: ${e.message}`);
    }
  }
  const sessions = new Map(); // token -> userId
  const failedLogins = new Map(); // username -> [timestamps]

  function save() {
    if (!dataFile) return;
    const dir = path.dirname(path.resolve(dataFile));
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${dataFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, dataFile);
  }

  // ---------- lookups / presenters ----------
  const userById = (id) => data.users.find((u) => u.id === id);
  const publicUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName });
  const roleOf = (board, userId) => board.members.find((m) => m.userId === userId)?.role || null;

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
  const boardColumns = (boardId) => data.columns.filter((c) => c.boardId === boardId).sort((a, b) => a.position - b.position);
  const columnCards = (columnId) => data.cards.filter((c) => c.columnId === columnId).sort((a, b) => a.position - b.position);

  const presentColumn = (c) => ({ id: c.id, boardId: c.boardId, name: c.name, position: c.position, wipLimit: c.wipLimit });
  const presentCard = (c) => ({
    id: c.id, boardId: c.boardId, columnId: c.columnId, title: c.title, description: c.description,
    position: c.position, assignees: [...c.assignees], labels: [...c.labels], dueDate: c.dueDate,
    createdBy: c.createdBy, createdAt: c.createdAt, updatedAt: c.updatedAt,
  });
  const presentLabel = (l) => ({ id: l.id, boardId: l.boardId, name: l.name, color: l.color });
  function presentMember(m) {
    const u = userById(m.userId);
    return { userId: m.userId, username: u ? u.username : null, role: m.role };
  }
  function presentBoard(b) {
    return {
      id: b.id, name: b.name, description: b.description, ownerId: b.ownerId, createdAt: b.createdAt,
      members: b.members.map(presentMember),
      labels: data.labels.filter((l) => l.boardId === b.id).map(presentLabel),
      columns: boardColumns(b.id).map((c) => ({ ...presentColumn(c), cards: columnCards(c.id).map(presentCard) })),
    };
  }

  function log(boardId, type, actorId, details = {}, cardId) {
    const entry = { id: newId(), boardId, type, actorId, at: now(), details };
    if (cardId) entry.cardId = cardId;
    data.activity.push(entry);
  }

  function renumber(list) {
    list.forEach((x, i) => { x.position = i; });
  }

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
      if (typeof id !== 'string' || !data.labels.some((l) => l.id === id && l.boardId === board.id)) {
        throw bad('labels must belong to the board');
      }
      if (!out.includes(id)) out.push(id);
    }
    return out;
  }

  // ---------- handlers ----------
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, handler, auth: opts.auth !== false });
  };

  // Auth
  route('POST', '/api/auth/register', ({ body }) => {
    if (typeof body.username !== 'string') throw bad('username is required');
    const username = body.username.toLowerCase();
    if (!/^[a-z0-9_]{3,32}$/.test(username)) throw bad('username must be 3-32 chars of [a-z0-9_]');
    if (typeof body.password !== 'string' || body.password.length < 8) throw bad('password must be at least 8 characters');
    let displayName = username;
    if (body.displayName !== undefined && body.displayName !== null) {
      displayName = trimmedName(body.displayName, 'displayName', 100);
    }
    if (data.users.some((u) => u.username === username)) throw conflict('Username already taken');
    const { salt, hash } = hashPassword(body.password);
    const user = { id: newId(), username, displayName, passwordSalt: salt, passwordHash: hash, createdAt: now() };
    data.users.push(user);
    save();
    return [201, { user: publicUser(user) }];
  }, { auth: false });

  route('POST', '/api/auth/login', ({ body }) => {
    if (typeof body.username !== 'string' || typeof body.password !== 'string') throw bad('username and password are required');
    const username = body.username.toLowerCase();
    const t = Date.now();
    const attempts = (failedLogins.get(username) || []).filter((x) => t - x < LOGIN_WINDOW_MS);
    failedLogins.set(username, attempts);
    if (attempts.length >= MAX_FAILED) throw new HttpError(429, 'rate_limited', 'Too many failed login attempts');
    const user = data.users.find((u) => u.username === username);
    if (!user || !verifyPassword(body.password, user.passwordSalt, user.passwordHash)) {
      attempts.push(t);
      throw new HttpError(401, 'invalid_credentials', 'Invalid username or password');
    }
    failedLogins.delete(username);
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
  route('POST', '/api/boards', ({ user, body }) => {
    const name = trimmedName(body.name, 'name', 100);
    let description = '';
    if (body.description !== undefined && body.description !== null) description = str(body.description, 'description', 0, 5000);
    let colNames = ['To Do', 'In Progress', 'Done'];
    if (body.columns !== undefined) {
      if (!Array.isArray(body.columns)) throw bad('columns must be an array of names');
      colNames = body.columns.map((c) => trimmedName(c, 'column name', 100));
    }
    const board = { id: newId(), name, description, ownerId: user.id, createdAt: now(), members: [{ userId: user.id, role: 'owner' }] };
    data.boards.push(board);
    log(board.id, 'board.created', user.id, { name });
    colNames.forEach((n, i) => {
      const col = { id: newId(), boardId: board.id, name: n, position: i, wipLimit: null, createdAt: now() };
      data.columns.push(col);
      log(board.id, 'column.created', user.id, { columnId: col.id, name: n });
    });
    save();
    return [201, presentBoard(board)];
  });

  route('GET', '/api/boards', ({ user }) => [200, data.boards
    .filter((b) => roleOf(b, user.id))
    .map((b) => ({ id: b.id, name: b.name, description: b.description, role: roleOf(b, user.id) }))]);

  route('GET', '/api/boards/:id', ({ user, params }) => {
    const b = getBoard(params.id);
    requireRole(b, user, 'viewer');
    return [200, presentBoard(b)];
  });

  route('PATCH', '/api/boards/:id', ({ user, params, body }) => {
    const b = getBoard(params.id);
    requireRole(b, user, 'owner');
    const updates = {};
    if (body.name !== undefined) updates.name = trimmedName(body.name, 'name', 100);
    if (body.description !== undefined) updates.description = body.description === null ? '' : str(body.description, 'description', 0, 5000);
    Object.assign(b, updates);
    log(b.id, 'board.updated', user.id, updates);
    save();
    return [200, presentBoard(b)];
  });

  route('DELETE', '/api/boards/:id', ({ user, params }) => {
    const b = getBoard(params.id);
    requireRole(b, user, 'owner');
    const cardIds = new Set(data.cards.filter((c) => c.boardId === b.id).map((c) => c.id));
    data.comments = data.comments.filter((c) => !cardIds.has(c.cardId));
    data.cards = data.cards.filter((c) => c.boardId !== b.id);
    data.columns = data.columns.filter((c) => c.boardId !== b.id);
    data.labels = data.labels.filter((l) => l.boardId !== b.id);
    data.activity = data.activity.filter((a) => a.boardId !== b.id);
    data.boards = data.boards.filter((x) => x.id !== b.id);
    save();
    return [204];
  });

  // Members
  route('POST', '/api/boards/:id/members', ({ user, params, body }) => {
    const b = getBoard(params.id);
    requireRole(b, user, 'owner');
    if (typeof body.username !== 'string') throw bad('username is required');
    if (body.role !== 'editor' && body.role !== 'viewer') throw bad('role must be editor or viewer');
    const target = data.users.find((u) => u.username === body.username.toLowerCase());
    if (!target) throw notFound('User not found');
    if (roleOf(b, target.id)) throw conflict('User is already a member');
    const m = { userId: target.id, role: body.role };
    b.members.push(m);
    log(b.id, 'member.added', user.id, { userId: target.id, username: target.username, role: body.role });
    save();
    return [201, presentMember(m)];
  });

  route('PATCH', '/api/boards/:id/members/:userId', ({ user, params, body }) => {
    const b = getBoard(params.id);
    requireRole(b, user, 'owner');
    const m = b.members.find((x) => x.userId === params.userId);
    if (!m) throw notFound('Member not found');
    if (body.role !== 'editor' && body.role !== 'viewer') throw bad('role must be editor or viewer');
    if (m.role === 'owner') throw bad("Cannot change the owner's role");
    m.role = body.role;
    log(b.id, 'member.updated', user.id, { userId: m.userId, role: m.role });
    save();
    return [200, presentMember(m)];
  });

  route('DELETE', '/api/boards/:id/members/:userId', ({ user, params }) => {
    const b = getBoard(params.id);
    const myRole = requireRole(b, user, 'viewer');
    if (myRole !== 'owner' && params.userId !== user.id) throw forbidden('Only the owner can remove other members');
    const m = b.members.find((x) => x.userId === params.userId);
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

  // Columns
  route('POST', '/api/boards/:id/columns', ({ user, params, body }) => {
    const b = getBoard(params.id);
    requireRole(b, user, 'editor');
    const name = trimmedName(body.name, 'name', 100);
    const wl = body.wipLimit === undefined ? null : wipLimit(body.wipLimit);
    const col = { id: newId(), boardId: b.id, name, position: boardColumns(b.id).length, wipLimit: wl, createdAt: now() };
    data.columns.push(col);
    log(b.id, 'column.created', user.id, { columnId: col.id, name });
    save();
    return [201, presentColumn(col)];
  });

  route('PATCH', '/api/columns/:id', ({ user, params, body }) => {
    const col = getColumn(params.id);
    const b = getBoard(col.boardId);
    requireRole(b, user, 'editor');
    const name = body.name !== undefined ? trimmedName(body.name, 'name', 100) : undefined;
    const wl = body.wipLimit !== undefined ? wipLimit(body.wipLimit) : undefined;
    const pos = body.position !== undefined ? intPos(body.position) : undefined;
    if (name !== undefined) col.name = name;
    if (wl !== undefined) col.wipLimit = wl;
    if (pos !== undefined) {
      const cols = boardColumns(b.id).filter((c) => c !== col);
      cols.splice(clamp(pos, 0, cols.length), 0, col);
      renumber(cols);
    }
    log(b.id, 'column.updated', user.id, { columnId: col.id });
    save();
    return [200, presentColumn(col)];
  });

  route('DELETE', '/api/columns/:id', ({ user, params, query }) => {
    const col = getColumn(params.id);
    const b = getBoard(col.boardId);
    requireRole(b, user, 'editor');
    const cards = columnCards(col.id);
    if (cards.length && query.get('force') !== 'true') throw conflict('Column still has cards', 'column_not_empty');
    const ids = new Set(cards.map((c) => c.id));
    data.comments = data.comments.filter((c) => !ids.has(c.cardId));
    data.cards = data.cards.filter((c) => !ids.has(c.id));
    data.columns = data.columns.filter((c) => c !== col);
    renumber(boardColumns(b.id));
    log(b.id, 'column.deleted', user.id, { columnId: col.id, name: col.name });
    save();
    return [204];
  });

  // Cards
  route('POST', '/api/columns/:id/cards', ({ user, params, body }) => {
    const col = getColumn(params.id);
    const b = getBoard(col.boardId);
    requireRole(b, user, 'editor');
    const title = trimmedName(body.title, 'title', 200);
    const description = body.description === undefined || body.description === null ? '' : str(body.description, 'description', 0, 10000);
    const assignees = body.assignees === undefined || body.assignees === null ? [] : validateAssignees(b, body.assignees);
    const labels = body.labels === undefined || body.labels === null ? [] : validateLabels(b, body.labels);
    const due = body.dueDate === undefined ? null : dueDate(body.dueDate);
    const pos = body.position === undefined || body.position === null ? undefined : intPos(body.position);
    const cards = columnCards(col.id);
    if (col.wipLimit != null && cards.length >= col.wipLimit) throw conflict('Column WIP limit reached', 'wip_limit');
    const t = now();
    const card = {
      id: newId(), boardId: b.id, columnId: col.id, title, description, position: 0, assignees, labels,
      dueDate: due, createdBy: user.id, createdAt: t, updatedAt: t,
    };
    cards.splice(pos === undefined ? cards.length : clamp(pos, 0, cards.length), 0, card);
    renumber(cards);
    data.cards.push(card);
    log(b.id, 'card.created', user.id, { title, columnId: col.id }, card.id);
    save();
    return [201, presentCard(card)];
  });

  route('GET', '/api/cards/:id', ({ user, params }) => {
    const card = getCard(params.id);
    requireRole(getBoard(card.boardId), user, 'viewer');
    return [200, presentCard(card)];
  });

  route('PATCH', '/api/cards/:id', ({ user, params, body }) => {
    const card = getCard(params.id);
    const b = getBoard(card.boardId);
    requireRole(b, user, 'editor');
    const u = {};
    if (body.title !== undefined) u.title = trimmedName(body.title, 'title', 200);
    if (body.description !== undefined) u.description = body.description === null ? '' : str(body.description, 'description', 0, 10000);
    if (body.assignees !== undefined) u.assignees = body.assignees === null ? [] : validateAssignees(b, body.assignees);
    if (body.labels !== undefined) u.labels = body.labels === null ? [] : validateLabels(b, body.labels);
    if (body.dueDate !== undefined) u.dueDate = dueDate(body.dueDate);
    Object.assign(card, u);
    let t = now();
    if (t <= card.updatedAt) t = new Date(Date.parse(card.updatedAt) + 1).toISOString();
    card.updatedAt = t;
    log(b.id, 'card.updated', user.id, { fields: Object.keys(u) }, card.id);
    save();
    return [200, presentCard(card)];
  });

  route('DELETE', '/api/cards/:id', ({ user, params }) => {
    const card = getCard(params.id);
    const b = getBoard(card.boardId);
    requireRole(b, user, 'editor');
    data.cards = data.cards.filter((c) => c !== card);
    data.comments = data.comments.filter((c) => c.cardId !== card.id);
    renumber(columnCards(card.columnId));
    log(b.id, 'card.deleted', user.id, { title: card.title, columnId: card.columnId }, card.id);
    save();
    return [204];
  });

  route('POST', '/api/cards/:id/move', ({ user, params, body }) => {
    const card = getCard(params.id);
    const b = getBoard(card.boardId);
    requireRole(b, user, 'editor');
    if (typeof body.columnId !== 'string') throw bad('columnId is required');
    const target = data.columns.find((c) => c.id === body.columnId);
    if (!target || target.boardId !== b.id) throw bad('Target column must be on the same board');
    const pos = body.position === undefined || body.position === null ? undefined : intPos(body.position);
    const fromColumnId = card.columnId;
    const fromPosition = card.position;
    const sameColumn = target.id === fromColumnId;
    const targetCards = columnCards(target.id).filter((c) => c !== card);
    if (!sameColumn && target.wipLimit != null && targetCards.length >= target.wipLimit) {
      throw conflict('Column WIP limit reached', 'wip_limit');
    }
    if (!sameColumn) {
      renumber(columnCards(fromColumnId).filter((c) => c !== card));
      card.columnId = target.id;
    }
    targetCards.splice(pos === undefined ? targetCards.length : clamp(pos, 0, targetCards.length), 0, card);
    renumber(targetCards);
    card.updatedAt = now();
    log(b.id, 'card.moved', user.id, { fromColumnId, toColumnId: target.id, fromPosition, toPosition: card.position }, card.id);
    save();
    return [200, presentCard(card)];
  });

  // Labels
  route('POST', '/api/boards/:id/labels', ({ user, params, body }) => {
    const b = getBoard(params.id);
    requireRole(b, user, 'editor');
    const name = trimmedName(body.name, 'name', 50);
    if (typeof body.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(body.color)) throw bad('color must be #rrggbb');
    if (data.labels.some((l) => l.boardId === b.id && l.name.toLowerCase() === name.toLowerCase())) {
      throw conflict('Label name already exists on this board');
    }
    const label = { id: newId(), boardId: b.id, name, color: body.color.toLowerCase() };
    data.labels.push(label);
    log(b.id, 'label.created', user.id, { labelId: label.id, name });
    save();
    return [201, presentLabel(label)];
  });

  route('GET', '/api/boards/:id/labels', ({ user, params }) => {
    const b = getBoard(params.id);
    requireRole(b, user, 'viewer');
    return [200, data.labels.filter((l) => l.boardId === b.id).map(presentLabel)];
  });

  route('DELETE', '/api/labels/:id', ({ user, params }) => {
    const label = data.labels.find((l) => l.id === params.id);
    if (!label) throw notFound('Label not found');
    const b = getBoard(label.boardId);
    requireRole(b, user, 'editor');
    data.labels = data.labels.filter((l) => l !== label);
    for (const c of data.cards) {
      if (c.labels.includes(label.id)) c.labels = c.labels.filter((x) => x !== label.id);
    }
    log(b.id, 'label.deleted', user.id, { labelId: label.id, name: label.name });
    save();
    return [204];
  });

  // Comments
  const presentComment = (c) => ({ id: c.id, cardId: c.cardId, authorId: c.authorId, body: c.body, createdAt: c.createdAt });
  route('POST', '/api/cards/:id/comments', ({ user, params, body }) => {
    const card = getCard(params.id);
    const b = getBoard(card.boardId);
    requireRole(b, user, 'editor');
    const text = str(body.body, 'body', 1, 5000);
    if (!text.trim()) throw bad('body must not be blank');
    const c = { id: newId(), cardId: card.id, boardId: b.id, authorId: user.id, body: text, createdAt: now() };
    data.comments.push(c);
    log(b.id, 'comment.added', user.id, { commentId: c.id }, card.id);
    save();
    return [201, presentComment(c)];
  });

  route('GET', '/api/cards/:id/comments', ({ user, params }) => {
    const card = getCard(params.id);
    requireRole(getBoard(card.boardId), user, 'viewer');
    return [200, data.comments.filter((c) => c.cardId === card.id).map(presentComment)];
  });

  route('DELETE', '/api/comments/:id', ({ user, params }) => {
    const c = data.comments.find((x) => x.id === params.id);
    if (!c) throw notFound('Comment not found');
    const card = getCard(c.cardId);
    const b = getBoard(card.boardId);
    const role = requireRole(b, user, 'viewer');
    if (c.authorId !== user.id && role !== 'owner') throw forbidden('Only the author or board owner can delete this comment');
    data.comments = data.comments.filter((x) => x !== c);
    log(b.id, 'comment.deleted', user.id, { commentId: c.id }, card.id);
    save();
    return [204];
  });

  // Search
  route('GET', '/api/boards/:id/cards', ({ user, params, query }) => {
    const b = getBoard(params.id);
    requireRole(b, user, 'viewer');
    const q = query.get('q');
    const assignee = query.get('assignee');
    const label = query.get('label');
    const column = query.get('column');
    const dueBefore = query.get('due_before');
    if (dueBefore && !isValidDate(dueBefore)) throw bad('due_before must be YYYY-MM-DD');
    const needle = q ? q.toLowerCase() : '';
    const colPos = new Map(boardColumns(b.id).map((c) => [c.id, c.position]));
    const result = data.cards.filter((c) => {
      if (c.boardId !== b.id) return false;
      if (needle && !c.title.toLowerCase().includes(needle) && !(c.description || '').toLowerCase().includes(needle)) return false;
      if (assignee && !c.assignees.includes(assignee)) return false;
      if (label && !c.labels.includes(label)) return false;
      if (column && c.columnId !== column) return false;
      if (dueBefore && (!c.dueDate || !(c.dueDate < dueBefore))) return false;
      return true;
    }).sort((x, y) => (colPos.get(x.columnId) - colPos.get(y.columnId)) || (x.position - y.position));
    return [200, result.map(presentCard)];
  });

  // Activity
  route('GET', '/api/boards/:id/activity', ({ user, params, query }) => {
    const b = getBoard(params.id);
    requireRole(b, user, 'viewer');
    let limit = 50;
    const raw = query.get('limit');
    if (raw !== null && raw !== '') {
      if (!/^\d+$/.test(raw)) throw bad('limit must be a non-negative integer');
      limit = Number(raw);
    }
    const entries = [];
    for (let i = data.activity.length - 1; i >= 0 && entries.length < limit; i--) {
      if (data.activity[i].boardId === b.id) entries.push(data.activity[i]);
    }
    return [200, entries];
  });

  // ---------- dispatcher ----------
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;

    if (!pathname.startsWith('/api/') && pathname !== '/api') {
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (pathname === '/' || pathname === '/index.html') return serveFile(res, INDEX_HTML_PATH, req.method);
        if (pathname.startsWith('/static/')) {
          const rel = decodeURIComponent(pathname.slice('/static/'.length));
          const full = path.resolve(STATIC_DIR, rel);
          if (full.startsWith(STATIC_DIR + path.sep)) return serveFile(res, full, req.method);
        }
      }
      throw notFound('Route not found');
    }

    let matched = null;
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(pathname);
      if (m) {
        const params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        matched = { r, params };
        break;
      }
    }
    if (!matched) throw notFound('Route not found');

    const ctx = { params: matched.params, query: url.searchParams, body: {} };
    if (matched.r.auth) {
      const h = req.headers.authorization || '';
      const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
      if (!m) throw unauth();
      const userId = sessions.get(m[1]);
      const user = userId && userById(userId);
      if (!user) throw unauth('Invalid or expired token');
      ctx.user = user;
      ctx.token = m[1];
    }
    if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') ctx.body = await readBody(req);
    const [status, body] = matched.r.handler(ctx);
    send(res, status, body);
  }

  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
  function serveFile(res, file, method) {
    let buf;
    try { buf = fs.readFileSync(file); } catch { throw notFound('File not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': buf.length });
    res.end(method === 'HEAD' ? undefined : buf);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (res.headersSent) { res.end(); return; }
      if (err instanceof HttpError) {
        send(res, err.status, { error: err.code, message: err.message });
      } else {
        console.error(err);
        send(res, 500, { error: 'internal', message: 'Internal server error' });
      }
    });
  });
  return server;
}
