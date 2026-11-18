// kanban-s3 server — node:http only, no dependencies.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');
const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8' };

class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}
const bad = (m) => new HttpError(400, 'validation', m);
const notFound = (m = 'Not found') => new HttpError(404, 'not_found', m);
const forbidden = (m = 'Forbidden') => new HttpError(403, 'forbidden', m);
const conflict = (m, code = 'conflict') => new HttpError(409, code, m);

const ROLE_RANK = { viewer: 1, editor: 2, owner: 3 };
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;

function emptyData() {
  return { users: [], boards: [], columns: [], cards: [], labels: [], comments: [], activity: [] };
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const h = crypto.scryptSync(password, salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === h.length && crypto.timingSafeEqual(h, expected);
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';

function validDate(s) {
  if (!isStr(s) || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function createServer({ dataFile } = {}) {
  let data = emptyData();
  if (dataFile && fs.existsSync(dataFile)) {
    try {
      const raw = fs.readFileSync(dataFile, 'utf8');
      if (raw.trim()) data = { ...emptyData(), ...JSON.parse(raw) };
    } catch { data = emptyData(); }
  }
  const sessions = new Map(); // token -> userId
  const loginFails = new Map(); // username -> [timestamps]
  let lastTs = 0;

  function now() {
    let t = Date.now();
    if (t <= lastTs) t = lastTs + 1;
    lastTs = t;
    return new Date(t).toISOString();
  }
  const newId = () => crypto.randomUUID();

  function save() {
    if (!dataFile) return;
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, dataFile);
  }

  // ---------- helpers ----------
  const publicUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName });
  const userById = (id) => data.users.find((u) => u.id === id);

  function getBoard(id) {
    const b = data.boards.find((x) => x.id === id);
    if (!b) throw notFound('Board not found');
    return b;
  }
  function roleOf(board, userId) {
    const m = board.members.find((x) => x.userId === userId);
    return m ? m.role : null;
  }
  function requireRole(board, user, min) {
    const r = roleOf(board, user.id);
    if (!r) throw forbidden('Not a member of this board');
    if (ROLE_RANK[r] < ROLE_RANK[min]) throw forbidden('Insufficient role');
    return r;
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
  function compact(list) { list.forEach((x, i) => { x.position = i; }); }

  function log(boardId, type, actorId, details = {}, cardId) {
    const e = { id: newId(), boardId, type, actorId, at: now(), details };
    if (cardId) e.cardId = cardId;
    data.activity.push(e);
  }

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

  // ---------- validators ----------
  function vName(v, max, field) {
    if (!isStr(v) || v.trim().length < 1 || v.length > max) throw bad(`${field} must be 1-${max} characters`);
    return v;
  }
  function vOptStr(v, field, max = 10000) {
    if (v === undefined || v === null) return '';
    if (!isStr(v) || v.length > max) throw bad(`${field} must be a string`);
    return v;
  }
  function vWip(v) {
    if (v === undefined || v === null) return null;
    if (!Number.isInteger(v) || v < 1) throw bad('wipLimit must be a positive integer or null');
    return v;
  }
  function vPosition(v) {
    if (v === undefined || v === null) return undefined;
    if (!Number.isInteger(v)) throw bad('position must be an integer');
    return v;
  }
  function vDue(v) {
    if (v === undefined || v === null) return null;
    if (!validDate(v)) throw bad('dueDate must be YYYY-MM-DD or null');
    return v;
  }
  function vAssignees(v, board) {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || !v.every(isStr)) throw bad('assignees must be an array of user ids');
    for (const id of v) if (!roleOf(board, id)) throw bad('assignee is not a board member');
    return [...new Set(v)];
  }
  function vLabels(v, board) {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || !v.every(isStr)) throw bad('labels must be an array of label ids');
    for (const id of v) if (!data.labels.some((l) => l.id === id && l.boardId === board.id)) throw bad('label does not belong to board');
    return [...new Set(v)];
  }
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, handler, { auth = true } = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, handler, auth });
  };

  // Auth
  route('POST', '/api/auth/register', ({ body }) => {
    let { username, password, displayName } = body;
    if (!isStr(username)) throw bad('username is required');
    username = username.toLowerCase();
    if (!/^[a-z0-9_]{3,32}$/.test(username)) throw bad('username must be 3-32 chars of [a-z0-9_]');
    if (!isStr(password) || password.length < 8) throw bad('password must be at least 8 characters');
    if (displayName !== undefined && displayName !== null && (!isStr(displayName) || displayName.length > 100)) throw bad('displayName must be a string');
    if (data.users.some((u) => u.username === username)) throw conflict('Username already taken');
    const { salt, hash } = hashPassword(password);
    const user = { id: newId(), username, displayName: displayName && displayName.trim() ? displayName : username, salt, passwordHash: hash, createdAt: now() };
    data.users.push(user);
    save();
    return [201, { user: publicUser(user) }];
  }, { auth: false });

  route('POST', '/api/auth/login', ({ body }) => {
    const { username, password } = body;
    if (!isStr(username) || !isStr(password)) throw bad('username and password are required');
    const uname = username.toLowerCase();
    const t = Date.now();
    const fails = (loginFails.get(uname) || []).filter((x) => t - x < LOGIN_WINDOW_MS);
    loginFails.set(uname, fails);
    if (fails.length >= MAX_FAILS) throw new HttpError(429, 'rate_limited', 'Too many failed login attempts');
    const user = data.users.find((u) => u.username === uname);
    if (!user || !verifyPassword(password, user.salt, user.passwordHash)) {
      fails.push(t);
      throw new HttpError(401, 'unauthenticated', 'Invalid credentials');
    }
    loginFails.delete(uname);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, user.id);
    return [200, { token, user: publicUser(user) }];
  }, { auth: false });

  route('POST', '/api/auth/logout', ({ token }) => { sessions.delete(token); return [204]; });
  route('GET', '/api/auth/me', ({ user }) => [200, { user: publicUser(user) }]);

  // Boards
  route('POST', '/api/boards', ({ body, user }) => {
    const name = vName(body.name, 100, 'name');
    const description = vOptStr(body.description, 'description');
    let cols = body.columns;
    if (cols === undefined || cols === null) cols = ['To Do', 'In Progress', 'Done'];
    if (!Array.isArray(cols)) throw bad('columns must be an array of names');
    cols.forEach((c) => vName(c, 100, 'column name'));
    const board = { id: newId(), name, description, ownerId: user.id, createdAt: now(), members: [{ userId: user.id, role: 'owner' }] };
    data.boards.push(board);
    cols.forEach((n, i) => data.columns.push({ id: newId(), boardId: board.id, name: n, position: i, wipLimit: null }));
    log(board.id, 'board.created', user.id, { name });
    save();
    return [201, boardOut(board)];
  });

  route('GET', '/api/boards', ({ user }) => [200, data.boards
    .filter((b) => roleOf(b, user.id))
    .map((b) => ({ id: b.id, name: b.name, role: roleOf(b, user.id) }))]);

  route('GET', '/api/boards/:id', ({ params, user }) => {
    const b = getBoard(params.id); requireRole(b, user, 'viewer');
    return [200, boardOut(b)];
  });

  route('PATCH', '/api/boards/:id', ({ params, user, body }) => {
    const b = getBoard(params.id); requireRole(b, user, 'owner');
    const name = body.name !== undefined ? vName(body.name, 100, 'name') : b.name;
    const description = body.description !== undefined ? vOptStr(body.description, 'description') : b.description;
    b.name = name; b.description = description;
    log(b.id, 'board.updated', user.id, {});
    save();
    return [200, boardOut(b)];
  });

  route('DELETE', '/api/boards/:id', ({ params, user }) => {
    const b = getBoard(params.id); requireRole(b, user, 'owner');
    const cardIds = new Set(data.cards.filter((c) => c.boardId === b.id).map((c) => c.id));
    data.boards = data.boards.filter((x) => x.id !== b.id);
    data.columns = data.columns.filter((x) => x.boardId !== b.id);
    data.cards = data.cards.filter((x) => x.boardId !== b.id);
    data.labels = data.labels.filter((x) => x.boardId !== b.id);
    data.comments = data.comments.filter((x) => !cardIds.has(x.cardId));
    data.activity = data.activity.filter((x) => x.boardId !== b.id);
    save();
    return [204];
  });

  // Members
  route('GET', '/api/boards/:id/members', ({ params, user }) => {
    const b = getBoard(params.id); requireRole(b, user, 'viewer');
    return [200, b.members.map(memberOut)];
  });

  route('POST', '/api/boards/:id/members', ({ params, user, body }) => {
    const b = getBoard(params.id); requireRole(b, user, 'owner');
    if (!isStr(body.username)) throw bad('username is required');
    if (body.role !== 'editor' && body.role !== 'viewer') throw bad('role must be editor or viewer');
    const target = data.users.find((u) => u.username === body.username.toLowerCase());
    if (!target) throw notFound('User not found');
    if (roleOf(b, target.id)) throw conflict('User is already a member');
    const m = { userId: target.id, role: body.role };
    b.members.push(m);
    log(b.id, 'member.added', user.id, { userId: target.id, role: m.role });
    save();
    return [201, memberOut(m)];
  });

  route('PATCH', '/api/boards/:id/members/:userId', ({ params, user, body }) => {
    const b = getBoard(params.id); requireRole(b, user, 'owner');
    const m = b.members.find((x) => x.userId === params.userId);
    if (!m) throw notFound('Member not found');
    if (body.role !== 'editor' && body.role !== 'viewer') throw bad('role must be editor or viewer');
    if (m.role === 'owner') throw bad('Cannot change the owner role');
    m.role = body.role;
    log(b.id, 'member.updated', user.id, { userId: m.userId, role: m.role });
    save();
    return [200, memberOut(m)];
  });

  route('DELETE', '/api/boards/:id/members/:userId', ({ params, user }) => {
    const b = getBoard(params.id);
    const myRole = roleOf(b, user.id);
    if (!myRole) throw forbidden('Not a member of this board');
    if (myRole !== 'owner' && params.userId !== user.id) throw forbidden('Only the owner can remove members');
    const m = b.members.find((x) => x.userId === params.userId);
    if (!m) throw notFound('Member not found');
    if (m.role === 'owner') throw bad('Cannot remove the board owner');
    b.members = b.members.filter((x) => x !== m);
    for (const c of data.cards) if (c.boardId === b.id) c.assignees = c.assignees.filter((a) => a !== m.userId);
    log(b.id, 'member.removed', user.id, { userId: m.userId });
    save();
    return [204];
  });

  // Columns
  route('POST', '/api/boards/:id/columns', ({ params, user, body }) => {
    const b = getBoard(params.id); requireRole(b, user, 'editor');
    const name = vName(body.name, 100, 'name');
    const wipLimit = vWip(body.wipLimit);
    const col = { id: newId(), boardId: b.id, name, position: boardColumns(b.id).length, wipLimit };
    data.columns.push(col);
    log(b.id, 'column.created', user.id, { columnId: col.id, name });
    save();
    return [201, columnOut(col)];
  });

  route('GET', '/api/columns/:id', ({ params, user }) => {
    const col = getColumn(params.id); requireRole(getBoard(col.boardId), user, 'viewer');
    return [200, { ...columnOut(col), cards: columnCards(col.id).map(cardOut) }];
  });

  route('PATCH', '/api/columns/:id', ({ params, user, body }) => {
    const col = getColumn(params.id); const b = getBoard(col.boardId); requireRole(b, user, 'editor');
    const name = body.name !== undefined ? vName(body.name, 100, 'name') : col.name;
    const wipLimit = body.wipLimit !== undefined ? vWip(body.wipLimit) : col.wipLimit;
    const pos = vPosition(body.position);
    col.name = name; col.wipLimit = wipLimit;
    if (pos !== undefined) {
      const cols = boardColumns(b.id).filter((c) => c !== col);
      cols.splice(clamp(pos, 0, cols.length), 0, col);
      compact(cols);
    }
    log(b.id, 'column.updated', user.id, { columnId: col.id });
    save();
    return [200, columnOut(col)];
  });

  route('DELETE', '/api/columns/:id', ({ params, user, query }) => {
    const col = getColumn(params.id); const b = getBoard(col.boardId); requireRole(b, user, 'editor');
    const cards = columnCards(col.id);
    if (cards.length && query.get('force') !== 'true') throw conflict('Column still has cards');
    const ids = new Set(cards.map((c) => c.id));
    data.cards = data.cards.filter((c) => !ids.has(c.id));
    data.comments = data.comments.filter((c) => !ids.has(c.cardId));
    data.columns = data.columns.filter((c) => c !== col);
    compact(boardColumns(b.id));
    log(b.id, 'column.deleted', user.id, { columnId: col.id, name: col.name });
    save();
    return [204];
  });

  // Cards
  route('GET', '/api/columns/:id/cards', ({ params, user }) => {
    const col = getColumn(params.id); requireRole(getBoard(col.boardId), user, 'viewer');
    return [200, columnCards(col.id).map(cardOut)];
  });

  route('POST', '/api/columns/:id/cards', ({ params, user, body }) => {
    const col = getColumn(params.id); const b = getBoard(col.boardId); requireRole(b, user, 'editor');
    const title = vName(body.title, 200, 'title');
    const description = vOptStr(body.description, 'description');
    const assignees = vAssignees(body.assignees, b);
    const labels = vLabels(body.labels, b);
    const dueDate = vDue(body.dueDate);
    const pos = vPosition(body.position);
    const cards = columnCards(col.id);
    if (col.wipLimit != null && cards.length >= col.wipLimit) throw conflict('Column WIP limit reached', 'wip_limit');
    const ts = now();
    const card = { id: newId(), boardId: b.id, columnId: col.id, title, description, position: 0, assignees, labels, dueDate, createdBy: user.id, createdAt: ts, updatedAt: ts };
    data.cards.push(card);
    cards.splice(pos === undefined ? cards.length : clamp(pos, 0, cards.length), 0, card);
    compact(cards);
    log(b.id, 'card.created', user.id, { columnId: col.id, title }, card.id);
    save();
    return [201, cardOut(card)];
  });

  route('GET', '/api/cards/:id', ({ params, user }) => {
    const card = getCard(params.id); requireRole(getBoard(card.boardId), user, 'viewer');
    return [200, cardOut(card)];
  });

  route('PATCH', '/api/cards/:id', ({ params, user, body }) => {
    const card = getCard(params.id); const b = getBoard(card.boardId); requireRole(b, user, 'editor');
    const upd = {};
    if (body.title !== undefined) upd.title = vName(body.title, 200, 'title');
    if (body.description !== undefined) upd.description = vOptStr(body.description, 'description');
    if (body.assignees !== undefined) upd.assignees = vAssignees(body.assignees, b);
    if (body.labels !== undefined) upd.labels = vLabels(body.labels, b);
    if (body.dueDate !== undefined) upd.dueDate = vDue(body.dueDate);
    Object.assign(card, upd);
    card.updatedAt = now();
    log(b.id, 'card.updated', user.id, { fields: Object.keys(upd) }, card.id);
    save();
    return [200, cardOut(card)];
  });

  route('DELETE', '/api/cards/:id', ({ params, user }) => {
    const card = getCard(params.id); const b = getBoard(card.boardId); requireRole(b, user, 'editor');
    data.cards = data.cards.filter((c) => c !== card);
    data.comments = data.comments.filter((c) => c.cardId !== card.id);
    compact(columnCards(card.columnId));
    log(b.id, 'card.deleted', user.id, { columnId: card.columnId, title: card.title }, card.id);
    save();
    return [204];
  });

  route('POST', '/api/cards/:id/move', ({ params, user, body }) => {
    const card = getCard(params.id); const b = getBoard(card.boardId); requireRole(b, user, 'editor');
    if (!isStr(body.columnId)) throw bad('columnId is required');
    const target = data.columns.find((c) => c.id === body.columnId);
    if (!target || target.boardId !== b.id) throw bad('Target column must be on the same board');
    const pos = vPosition(body.position);
    const fromColumnId = card.columnId;
    const fromPosition = card.position;
    if (target.id !== fromColumnId) {
      const tcards = columnCards(target.id);
      if (target.wipLimit != null && tcards.length >= target.wipLimit) throw conflict('Column WIP limit reached', 'wip_limit');
      const scards = columnCards(fromColumnId).filter((c) => c !== card);
      compact(scards);
      card.columnId = target.id;
      tcards.splice(pos === undefined ? tcards.length : clamp(pos, 0, tcards.length), 0, card);
      compact(tcards);
    } else {
      const cards = columnCards(target.id).filter((c) => c !== card);
      cards.splice(pos === undefined ? cards.length : clamp(pos, 0, cards.length), 0, card);
      compact(cards);
    }
    card.updatedAt = now();
    log(b.id, 'card.moved', user.id, { fromColumnId, toColumnId: target.id, fromPosition, toPosition: card.position }, card.id);
    save();
    return [200, cardOut(card)];
  });

  // Labels
  route('GET', '/api/boards/:id/labels', ({ params, user }) => {
    const b = getBoard(params.id); requireRole(b, user, 'viewer');
    return [200, data.labels.filter((l) => l.boardId === b.id).map(labelOut)];
  });

  const vColor = (c) => { if (!isStr(c) || !/^#[0-9a-fA-F]{6}$/.test(c)) throw bad('color must be #rrggbb'); return c; };
  const labelDup = (boardId, name, except) => data.labels.some((l) => l.boardId === boardId && l !== except && l.name.toLowerCase() === name.toLowerCase());

  route('POST', '/api/boards/:id/labels', ({ params, user, body }) => {
    const b = getBoard(params.id); requireRole(b, user, 'editor');
    const name = vName(body.name, 50, 'name');
    const color = vColor(body.color);
    if (labelDup(b.id, name)) throw conflict('Label name already exists');
    const l = { id: newId(), boardId: b.id, name, color };
    data.labels.push(l);
    log(b.id, 'label.created', user.id, { labelId: l.id, name });
    save();
    return [201, labelOut(l)];
  });

  function getLabel(id) { const l = data.labels.find((x) => x.id === id); if (!l) throw notFound('Label not found'); return l; }

  route('PATCH', '/api/labels/:id', ({ params, user, body }) => {
    const l = getLabel(params.id); requireRole(getBoard(l.boardId), user, 'editor');
    const name = body.name !== undefined ? vName(body.name, 50, 'name') : l.name;
    const color = body.color !== undefined ? vColor(body.color) : l.color;
    if (labelDup(l.boardId, name, l)) throw conflict('Label name already exists');
    l.name = name; l.color = color;
    save();
    return [200, labelOut(l)];
  });

  route('DELETE', '/api/labels/:id', ({ params, user }) => {
    const l = getLabel(params.id); requireRole(getBoard(l.boardId), user, 'editor');
    data.labels = data.labels.filter((x) => x !== l);
    for (const c of data.cards) if (c.labels.includes(l.id)) c.labels = c.labels.filter((x) => x !== l.id);
    log(l.boardId, 'label.deleted', user.id, { labelId: l.id, name: l.name });
    save();
    return [204];
  });

  // Comments
  const commentOut = (c) => ({ id: c.id, cardId: c.cardId, authorId: c.authorId, body: c.body, createdAt: c.createdAt });

  route('POST', '/api/cards/:id/comments', ({ params, user, body }) => {
    const card = getCard(params.id); const b = getBoard(card.boardId); requireRole(b, user, 'editor');
    if (!isStr(body.body) || body.body.trim().length < 1 || body.body.length > 5000) throw bad('body must be 1-5000 characters');
    const c = { id: newId(), cardId: card.id, boardId: b.id, authorId: user.id, body: body.body, createdAt: now() };
    data.comments.push(c);
    log(b.id, 'comment.added', user.id, { commentId: c.id }, card.id);
    save();
    return [201, commentOut(c)];
  });

  route('GET', '/api/cards/:id/comments', ({ params, user }) => {
    const card = getCard(params.id); requireRole(getBoard(card.boardId), user, 'viewer');
    return [200, data.comments.filter((c) => c.cardId === card.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(commentOut)];
  });

  route('DELETE', '/api/comments/:id', ({ params, user }) => {
    const c = data.comments.find((x) => x.id === params.id);
    if (!c) throw notFound('Comment not found');
    const card = getCard(c.cardId); const b = getBoard(card.boardId);
    const r = roleOf(b, user.id);
    if (!r) throw forbidden('Not a member of this board');
    if (c.authorId !== user.id && r !== 'owner') throw forbidden('Only the author or board owner can delete this comment');
    data.comments = data.comments.filter((x) => x !== c);
    log(b.id, 'comment.deleted', user.id, { commentId: c.id }, card.id);
    save();
    return [204];
  });

  // Search
  route('GET', '/api/boards/:id/cards', ({ params, user, query }) => {
    const b = getBoard(params.id); requireRole(b, user, 'viewer');
    const q = query.get('q'); const assignee = query.get('assignee'); const label = query.get('label');
    const column = query.get('column'); const dueBefore = query.get('due_before');
    if (dueBefore && !validDate(dueBefore)) throw bad('due_before must be YYYY-MM-DD');
    const ql = q ? q.toLowerCase() : '';
    const colPos = new Map(boardColumns(b.id).map((c) => [c.id, c.position]));
    const result = data.cards.filter((c) => c.boardId === b.id
      && (!ql || c.title.toLowerCase().includes(ql) || (c.description || '').toLowerCase().includes(ql))
      && (!assignee || c.assignees.includes(assignee))
      && (!label || c.labels.includes(label))
      && (!column || c.columnId === column)
      && (!dueBefore || (c.dueDate && c.dueDate < dueBefore)))
      .sort((a, b2) => (colPos.get(a.columnId) - colPos.get(b2.columnId)) || (a.position - b2.position));
    return [200, result.map(cardOut)];
  });

  // Activity
  route('GET', '/api/boards/:id/activity', ({ params, user, query }) => {
    const b = getBoard(params.id); requireRole(b, user, 'viewer');
    let limit = 50;
    const raw = query.get('limit');
    if (raw !== null && raw !== '') {
      limit = Number(raw);
      if (!Number.isInteger(limit) || limit < 0) throw bad('limit must be a non-negative integer');
    }
    const entries = data.activity.filter((a) => a.boardId === b.id).reverse().slice(0, limit);
    return [200, entries];
  });

  // ---------- dispatcher ----------
  function send(res, status, body, headers = {}) {
    if (status === 204 || body === undefined) { res.writeHead(status, headers); res.end(); return; }
    const s = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(s), ...headers });
    res.end(s);
  }
  const sendError = (res, e) => send(res, e.status, { error: e.code, message: e.message });

  function serveStatic(req, res, pathname) {
    let file = null;
    if (pathname === '/' || pathname === '/index.html') file = 'index.html';
    else if (pathname.startsWith('/static/')) {
      const rel = pathname.slice('/static/'.length);
      if (/^[\w.-]+$/.test(rel) && !rel.includes('..')) file = rel;
    }
    if (!file) return false;
    const full = path.join(STATIC_DIR, file);
    if (!fs.existsSync(full)) return false;
    const content = fs.readFileSync(full);
    res.writeHead(200, { 'Content-Type': STATIC_TYPES[path.extname(file)] || 'application/octet-stream', 'Content-Length': content.length });
    res.end(req.method === 'HEAD' ? undefined : content);
    return true;
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      req.on('data', (c) => { size += c.length; if (size > 5e6) { reject(new HttpError(413, 'too_large', 'Body too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    try {
      if ((req.method === 'GET' || req.method === 'HEAD') && !pathname.startsWith('/api') && serveStatic(req, res, pathname)) return;
      let match = null;
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(pathname);
        if (m) { match = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) }; break; }
      }
      if (!match) throw notFound('Route not found');
      let user = null; let token = null;
      if (match.r.auth) {
        const h = req.headers.authorization || '';
        const m = /^Bearer\s+(.+)$/i.exec(h);
        token = m ? m[1].trim() : null;
        const uid = token ? sessions.get(token) : null;
        user = uid ? userById(uid) : null;
        if (!user) throw new HttpError(401, 'unauthenticated', 'Authentication required');
      }
      const raw = await readBody(req);
      let body = {};
      if (raw.trim()) {
        try { body = JSON.parse(raw); } catch { throw new HttpError(400, 'validation', 'Invalid JSON'); }
      }
      if (['POST', 'PATCH', 'PUT'].includes(req.method) && !isObj(body)) throw bad('Body must be a JSON object');
      if (!isObj(body)) body = {};
      const [status, out] = await match.r.handler({ req, params: match.params, query: url.searchParams, body, user, token });
      send(res, status, out);
    } catch (e) {
      if (e instanceof HttpError) sendError(res, e);
      else { console.error(e); send(res, 500, { error: 'internal', message: 'Internal server error' }); }
    }
  }

  return http.createServer((req, res) => { handle(req, res); });
}
