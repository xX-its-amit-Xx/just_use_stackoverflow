// kanban-s3 server — written from scratch (no framework-free reusable backend found).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, 'static');

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

function emptyDb() {
  return { users: [], boards: [], members: [], columns: [], cards: [], labels: [], comments: [], activity: [] };
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(pw, stored) {
  const [, salt, hash] = String(stored).split('$');
  if (!salt || !hash) return false;
  const h = crypto.scryptSync(pw, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === h.length && crypto.timingSafeEqual(h, expected);
}

const newId = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const isStr = (v) => typeof v === 'string';

function validDate(s) {
  if (!isStr(s) || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}

export function createServer({ dataFile } = {}) {
  let db = emptyDb();
  if (dataFile && fs.existsSync(dataFile)) {
    try {
      const raw = fs.readFileSync(dataFile, 'utf8');
      if (raw.trim()) db = { ...emptyDb(), ...JSON.parse(raw) };
    } catch { db = emptyDb(); }
  }
  const sessions = new Map(); // token -> userId
  const loginFails = new Map(); // username -> [timestamps]

  function save() {
    if (!dataFile) return;
    const dir = path.dirname(path.resolve(dataFile));
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${dataFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, dataFile);
  }

  // ---------- helpers ----------
  const publicUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName });
  const userById = (id) => db.users.find((u) => u.id === id);
  const membership = (boardId, userId) => db.members.find((m) => m.boardId === boardId && m.userId === userId);

  function requireRole(boardId, user, minRole) {
    const m = membership(boardId, user.id);
    if (!m) throw forbidden('Not a member of this board');
    if (ROLE_RANK[m.role] < ROLE_RANK[minRole]) throw forbidden(`Requires ${minRole} role`);
    return m;
  }
  function getBoard(id) { const b = db.boards.find((x) => x.id === id); if (!b) throw notFound('Board not found'); return b; }
  function getColumn(id) { const c = db.columns.find((x) => x.id === id); if (!c) throw notFound('Column not found'); return c; }
  function getCard(id) { const c = db.cards.find((x) => x.id === id); if (!c) throw notFound('Card not found'); return c; }
  function getLabel(id) { const l = db.labels.find((x) => x.id === id); if (!l) throw notFound('Label not found'); return l; }
  function getComment(id) { const c = db.comments.find((x) => x.id === id); if (!c) throw notFound('Comment not found'); return c; }

  const boardColumns = (boardId) => db.columns.filter((c) => c.boardId === boardId).sort((a, b) => a.position - b.position);
  const columnCards = (columnId) => db.cards.filter((c) => c.columnId === columnId).sort((a, b) => a.position - b.position);
  const reindex = (arr) => arr.forEach((x, i) => { x.position = i; });

  const columnOut = (c) => ({ id: c.id, boardId: c.boardId, name: c.name, position: c.position, wipLimit: c.wipLimit ?? null });
  const cardOut = (c) => ({
    id: c.id, boardId: c.boardId, columnId: c.columnId, title: c.title, description: c.description,
    position: c.position, assignees: [...c.assignees], labels: [...c.labels], dueDate: c.dueDate ?? null,
    createdBy: c.createdBy, createdAt: c.createdAt, updatedAt: c.updatedAt,
  });
  const labelOut = (l) => ({ id: l.id, boardId: l.boardId, name: l.name, color: l.color });
  const memberOut = (m) => ({ userId: m.userId, username: userById(m.userId)?.username ?? null, role: m.role });

  function boardOut(b) {
    return {
      id: b.id, name: b.name, description: b.description, ownerId: b.ownerId, createdAt: b.createdAt,
      members: db.members.filter((m) => m.boardId === b.id).map(memberOut),
      labels: db.labels.filter((l) => l.boardId === b.id).map(labelOut),
      columns: boardColumns(b.id).map((c) => ({ ...columnOut(c), cards: columnCards(c.id).map(cardOut) })),
    };
  }

  function log(boardId, type, actorId, cardId, details = {}) {
    const e = { id: newId(), boardId, type, actorId, at: now(), details };
    if (cardId) e.cardId = cardId;
    db.activity.push(e);
  }

  function validateWip(v) {
    if (v === null) return null;
    if (!Number.isInteger(v) || v < 1) throw bad('wipLimit must be a positive integer or null');
    return v;
  }
  function validateName(v, max, field = 'name') {
    if (!isStr(v) || v.trim().length < 1 || v.length > max) throw bad(`${field} must be 1-${max} characters`);
    return v.trim();
  }
  function validateAssignees(boardId, v) {
    if (!Array.isArray(v) || !v.every(isStr)) throw bad('assignees must be an array of user ids');
    for (const id of v) if (!membership(boardId, id)) throw bad(`Assignee ${id} is not a board member`);
    return [...new Set(v)];
  }
  function validateLabels(boardId, v) {
    if (!Array.isArray(v) || !v.every(isStr)) throw bad('labels must be an array of label ids');
    for (const id of v) if (!db.labels.some((l) => l.id === id && l.boardId === boardId)) throw bad(`Label ${id} does not belong to board`);
    return [...new Set(v)];
  }
  function validateDue(v) {
    if (v === null) return null;
    if (!validDate(v)) throw bad('dueDate must be YYYY-MM-DD or null');
    return v;
  }
  function validatePosition(v) {
    if (v === undefined || v === null) return undefined;
    if (!Number.isInteger(v)) throw bad('position must be an integer');
    return v;
  }
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function deleteCards(cardIds) {
    const set = new Set(cardIds);
    db.cards = db.cards.filter((c) => !set.has(c.id));
    db.comments = db.comments.filter((c) => !set.has(c.cardId));
  }

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, handler, auth: opts.auth !== false });
  };

  // Auth
  route('POST', '/api/auth/register', ({ body }) => {
    const { username, password, displayName } = body();
    if (!isStr(username) || !/^[a-z0-9_]{3,32}$/i.test(username)) throw bad('username must be 3-32 chars of [a-z0-9_]');
    if (!isStr(password) || password.length < 8) throw bad('password must be at least 8 characters');
    if (displayName !== undefined && displayName !== null && (!isStr(displayName) || displayName.length > 100)) throw bad('displayName must be a string');
    const uname = username.toLowerCase();
    if (db.users.some((u) => u.username === uname)) throw conflict('Username already taken');
    const user = { id: newId(), username: uname, displayName: (isStr(displayName) && displayName.trim()) ? displayName : uname, passwordHash: hashPassword(password), createdAt: now() };
    db.users.push(user);
    save();
    return [201, { user: publicUser(user) }];
  }, { auth: false });

  route('POST', '/api/auth/login', ({ body }) => {
    const { username, password } = body();
    if (!isStr(username) || !isStr(password)) throw bad('username and password required');
    const uname = username.toLowerCase();
    const t = Date.now();
    const fails = (loginFails.get(uname) || []).filter((ts) => t - ts < LOGIN_WINDOW_MS);
    loginFails.set(uname, fails);
    if (fails.length >= MAX_FAILS) throw new HttpError(429, 'rate_limited', 'Too many failed login attempts');
    const user = db.users.find((u) => u.username === uname);
    if (!user || !verifyPassword(password, user.passwordHash)) {
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
  route('POST', '/api/boards', ({ user, body }) => {
    const { name, description, columns } = body();
    const bname = validateName(name, 100);
    if (description !== undefined && description !== null && !isStr(description)) throw bad('description must be a string');
    let colNames = ['To Do', 'In Progress', 'Done'];
    if (columns !== undefined) {
      if (!Array.isArray(columns)) throw bad('columns must be an array of names');
      colNames = columns.map((c) => validateName(c, 100, 'column name'));
    }
    const b = { id: newId(), name: bname, description: description ?? '', ownerId: user.id, createdAt: now() };
    db.boards.push(b);
    db.members.push({ boardId: b.id, userId: user.id, role: 'owner' });
    log(b.id, 'board.created', user.id, null, { name: b.name });
    colNames.forEach((n, i) => {
      const c = { id: newId(), boardId: b.id, name: n, position: i, wipLimit: null };
      db.columns.push(c);
      log(b.id, 'column.created', user.id, null, { columnId: c.id, name: n });
    });
    save();
    return [201, boardOut(b)];
  });

  route('GET', '/api/boards', ({ user }) => [200, db.members.filter((m) => m.userId === user.id)
    .map((m) => { const b = db.boards.find((x) => x.id === m.boardId); return b && { id: b.id, name: b.name, role: m.role }; })
    .filter(Boolean)]);

  route('GET', '/api/boards/:id', ({ user, params }) => {
    const b = getBoard(params.id); requireRole(b.id, user, 'viewer'); return [200, boardOut(b)];
  });

  route('PATCH', '/api/boards/:id', ({ user, params, body }) => {
    const b = getBoard(params.id); requireRole(b.id, user, 'owner');
    const { name, description } = body();
    if (name !== undefined) b.name = validateName(name, 100);
    if (description !== undefined) {
      if (description !== null && !isStr(description)) throw bad('description must be a string');
      b.description = description ?? '';
    }
    log(b.id, 'board.updated', user.id, null, {});
    save();
    return [200, boardOut(b)];
  });

  route('DELETE', '/api/boards/:id', ({ user, params }) => {
    const b = getBoard(params.id); requireRole(b.id, user, 'owner');
    const cardIds = db.cards.filter((c) => c.boardId === b.id).map((c) => c.id);
    deleteCards(cardIds);
    db.boards = db.boards.filter((x) => x.id !== b.id);
    db.members = db.members.filter((x) => x.boardId !== b.id);
    db.columns = db.columns.filter((x) => x.boardId !== b.id);
    db.labels = db.labels.filter((x) => x.boardId !== b.id);
    db.activity = db.activity.filter((x) => x.boardId !== b.id);
    save();
    return [204];
  });

  // Members
  route('POST', '/api/boards/:id/members', ({ user, params, body }) => {
    const b = getBoard(params.id); requireRole(b.id, user, 'owner');
    const { username, role } = body();
    if (!isStr(username)) throw bad('username required');
    if (role !== 'editor' && role !== 'viewer') throw bad('role must be editor or viewer');
    const target = db.users.find((u) => u.username === username.toLowerCase());
    if (!target) throw notFound('User not found');
    if (membership(b.id, target.id)) throw conflict('User is already a member');
    const m = { boardId: b.id, userId: target.id, role };
    db.members.push(m);
    log(b.id, 'member.added', user.id, null, { userId: target.id, role });
    save();
    return [201, memberOut(m)];
  });

  route('PATCH', '/api/boards/:id/members/:userId', ({ user, params, body }) => {
    const b = getBoard(params.id); requireRole(b.id, user, 'owner');
    const m = membership(b.id, params.userId);
    if (!m) throw notFound('Member not found');
    const { role } = body();
    if (role !== 'editor' && role !== 'viewer') throw bad('role must be editor or viewer');
    if (m.role === 'owner') throw bad('Cannot change the owner role');
    m.role = role;
    log(b.id, 'member.updated', user.id, null, { userId: m.userId, role });
    save();
    return [200, memberOut(m)];
  });

  route('DELETE', '/api/boards/:id/members/:userId', ({ user, params }) => {
    const b = getBoard(params.id);
    const me = requireRole(b.id, user, 'viewer');
    if (me.role !== 'owner' && params.userId !== user.id) throw forbidden('Only the owner can remove other members');
    const m = membership(b.id, params.userId);
    if (!m) throw notFound('Member not found');
    if (m.role === 'owner') throw bad('Cannot remove the board owner');
    db.members = db.members.filter((x) => x !== m);
    for (const c of db.cards) if (c.boardId === b.id) c.assignees = c.assignees.filter((a) => a !== m.userId);
    log(b.id, 'member.removed', user.id, null, { userId: m.userId });
    save();
    return [204];
  });

  // Columns
  route('POST', '/api/boards/:id/columns', ({ user, params, body }) => {
    const b = getBoard(params.id); requireRole(b.id, user, 'editor');
    const { name, wipLimit } = body();
    const c = { id: newId(), boardId: b.id, name: validateName(name, 100), position: boardColumns(b.id).length, wipLimit: wipLimit === undefined ? null : validateWip(wipLimit) };
    db.columns.push(c);
    log(b.id, 'column.created', user.id, null, { columnId: c.id, name: c.name });
    save();
    return [201, { ...columnOut(c), cards: [] }];
  });

  route('PATCH', '/api/columns/:id', ({ user, params, body }) => {
    const c = getColumn(params.id); requireRole(c.boardId, user, 'editor');
    const { name, wipLimit, position } = body();
    const nm = name !== undefined ? validateName(name, 100) : undefined;
    const wl = wipLimit !== undefined ? validateWip(wipLimit) : undefined;
    const pos = validatePosition(position);
    if (nm !== undefined) c.name = nm;
    if (wl !== undefined) c.wipLimit = wl;
    if (pos !== undefined) {
      const cols = boardColumns(c.boardId).filter((x) => x !== c);
      cols.splice(clamp(pos, 0, cols.length), 0, c);
      reindex(cols);
    }
    log(c.boardId, 'column.updated', user.id, null, { columnId: c.id });
    save();
    return [200, { ...columnOut(c), cards: columnCards(c.id).map(cardOut) }];
  });

  route('DELETE', '/api/columns/:id', ({ user, params, query }) => {
    const c = getColumn(params.id); requireRole(c.boardId, user, 'editor');
    const cards = columnCards(c.id);
    if (cards.length && query.get('force') !== 'true') throw conflict('Column still has cards');
    deleteCards(cards.map((x) => x.id));
    db.columns = db.columns.filter((x) => x !== c);
    reindex(boardColumns(c.boardId));
    log(c.boardId, 'column.deleted', user.id, null, { columnId: c.id, name: c.name });
    save();
    return [204];
  });

  // Cards
  route('POST', '/api/columns/:id/cards', ({ user, params, body }) => {
    const col = getColumn(params.id); requireRole(col.boardId, user, 'editor');
    const { title, description, assignees, labels, dueDate, position } = body();
    const t = validateName(title, 200, 'title');
    if (description !== undefined && description !== null && !isStr(description)) throw bad('description must be a string');
    const as = assignees === undefined || assignees === null ? [] : validateAssignees(col.boardId, assignees);
    const ls = labels === undefined || labels === null ? [] : validateLabels(col.boardId, labels);
    const due = dueDate === undefined ? null : validateDue(dueDate);
    const pos = validatePosition(position);
    const cards = columnCards(col.id);
    if (col.wipLimit != null && cards.length >= col.wipLimit) throw conflict(`Column WIP limit (${col.wipLimit}) reached`, 'wip_limit');
    const ts = now();
    const card = { id: newId(), boardId: col.boardId, columnId: col.id, title: t, description: description ?? '', position: 0, assignees: as, labels: ls, dueDate: due, createdBy: user.id, createdAt: ts, updatedAt: ts };
    cards.splice(pos === undefined ? cards.length : clamp(pos, 0, cards.length), 0, card);
    reindex(cards);
    db.cards.push(card);
    log(col.boardId, 'card.created', user.id, card.id, { columnId: col.id, title: card.title });
    save();
    return [201, cardOut(card)];
  });

  route('GET', '/api/cards/:id', ({ user, params }) => {
    const c = getCard(params.id); requireRole(c.boardId, user, 'viewer'); return [200, cardOut(c)];
  });

  route('PATCH', '/api/cards/:id', ({ user, params, body }) => {
    const c = getCard(params.id); requireRole(c.boardId, user, 'editor');
    const { title, description, assignees, labels, dueDate } = body();
    const upd = {};
    if (title !== undefined) upd.title = validateName(title, 200, 'title');
    if (description !== undefined) { if (description !== null && !isStr(description)) throw bad('description must be a string'); upd.description = description ?? ''; }
    if (assignees !== undefined) upd.assignees = assignees === null ? [] : validateAssignees(c.boardId, assignees);
    if (labels !== undefined) upd.labels = labels === null ? [] : validateLabels(c.boardId, labels);
    if (dueDate !== undefined) upd.dueDate = validateDue(dueDate);
    Object.assign(c, upd);
    let ts = now();
    if (ts <= c.updatedAt) ts = new Date(Date.parse(c.updatedAt) + 1).toISOString();
    c.updatedAt = ts;
    log(c.boardId, 'card.updated', user.id, c.id, { fields: Object.keys(upd) });
    save();
    return [200, cardOut(c)];
  });

  route('DELETE', '/api/cards/:id', ({ user, params }) => {
    const c = getCard(params.id); requireRole(c.boardId, user, 'editor');
    deleteCards([c.id]);
    reindex(columnCards(c.columnId));
    log(c.boardId, 'card.deleted', user.id, c.id, { columnId: c.columnId, title: c.title });
    save();
    return [204];
  });

  route('POST', '/api/cards/:id/move', ({ user, params, body }) => {
    const c = getCard(params.id); requireRole(c.boardId, user, 'editor');
    const { columnId, position } = body();
    if (!isStr(columnId)) throw bad('columnId required');
    const target = db.columns.find((x) => x.id === columnId);
    if (!target || target.boardId !== c.boardId) throw bad('Target column must be on the same board');
    const pos = validatePosition(position);
    const fromColumnId = c.columnId;
    const fromPosition = c.position;
    if (target.id !== fromColumnId) {
      const tcards = columnCards(target.id);
      if (target.wipLimit != null && tcards.length >= target.wipLimit) throw conflict(`Column WIP limit (${target.wipLimit}) reached`, 'wip_limit');
      const scards = columnCards(fromColumnId).filter((x) => x !== c);
      reindex(scards);
      tcards.splice(pos === undefined ? tcards.length : clamp(pos, 0, tcards.length), 0, c);
      c.columnId = target.id;
      reindex(tcards);
    } else {
      const cards = columnCards(target.id).filter((x) => x !== c);
      cards.splice(pos === undefined ? cards.length : clamp(pos, 0, cards.length), 0, c);
      reindex(cards);
    }
    c.updatedAt = now();
    log(c.boardId, 'card.moved', user.id, c.id, { fromColumnId, toColumnId: target.id, fromPosition, toPosition: c.position });
    save();
    return [200, cardOut(c)];
  });

  // Labels
  route('POST', '/api/boards/:id/labels', ({ user, params, body }) => {
    const b = getBoard(params.id); requireRole(b.id, user, 'editor');
    const { name, color } = body();
    const nm = validateName(name, 50);
    if (!isStr(color) || !/^#[0-9a-fA-F]{6}$/.test(color)) throw bad('color must be #rrggbb');
    if (db.labels.some((l) => l.boardId === b.id && l.name.toLowerCase() === nm.toLowerCase())) throw conflict('Label name already exists on this board');
    const l = { id: newId(), boardId: b.id, name: nm, color };
    db.labels.push(l);
    log(b.id, 'label.created', user.id, null, { labelId: l.id, name: nm });
    save();
    return [201, labelOut(l)];
  });

  route('GET', '/api/boards/:id/labels', ({ user, params }) => {
    const b = getBoard(params.id); requireRole(b.id, user, 'viewer');
    return [200, db.labels.filter((l) => l.boardId === b.id).map(labelOut)];
  });

  route('DELETE', '/api/labels/:id', ({ user, params }) => {
    const l = getLabel(params.id); requireRole(l.boardId, user, 'editor');
    db.labels = db.labels.filter((x) => x !== l);
    for (const c of db.cards) if (c.boardId === l.boardId) c.labels = c.labels.filter((x) => x !== l.id);
    log(l.boardId, 'label.deleted', user.id, null, { labelId: l.id });
    save();
    return [204];
  });

  // Comments
  route('POST', '/api/cards/:id/comments', ({ user, params, body }) => {
    const c = getCard(params.id); requireRole(c.boardId, user, 'editor');
    const { body: text } = body();
    if (!isStr(text) || text.trim().length < 1 || text.length > 5000) throw bad('body must be 1-5000 characters');
    const cm = { id: newId(), cardId: c.id, boardId: c.boardId, authorId: user.id, body: text, createdAt: now() };
    db.comments.push(cm);
    log(c.boardId, 'comment.added', user.id, c.id, { commentId: cm.id });
    save();
    return [201, commentOut(cm)];
  });
  const commentOut = (cm) => ({ id: cm.id, cardId: cm.cardId, authorId: cm.authorId, body: cm.body, createdAt: cm.createdAt });

  route('GET', '/api/cards/:id/comments', ({ user, params }) => {
    const c = getCard(params.id); requireRole(c.boardId, user, 'viewer');
    return [200, db.comments.filter((x) => x.cardId === c.id).map(commentOut)];
  });

  route('DELETE', '/api/comments/:id', ({ user, params }) => {
    const cm = getComment(params.id);
    const card = db.cards.find((x) => x.id === cm.cardId);
    const boardId = card ? card.boardId : cm.boardId;
    const m = membership(boardId, user.id);
    if (!m) throw forbidden('Not a member of this board');
    if (cm.authorId !== user.id && m.role !== 'owner') throw forbidden('Only the author or board owner can delete this comment');
    db.comments = db.comments.filter((x) => x !== cm);
    log(boardId, 'comment.deleted', user.id, cm.cardId, { commentId: cm.id });
    save();
    return [204];
  });

  // Search
  route('GET', '/api/boards/:id/cards', ({ user, params, query }) => {
    const b = getBoard(params.id); requireRole(b.id, user, 'viewer');
    const q = query.get('q'); const assignee = query.get('assignee'); const label = query.get('label');
    const column = query.get('column'); const dueBefore = query.get('due_before');
    if (dueBefore && !validDate(dueBefore)) throw bad('due_before must be YYYY-MM-DD');
    const ql = q ? q.toLowerCase() : '';
    const colPos = new Map(boardColumns(b.id).map((c) => [c.id, c.position]));
    const res = db.cards.filter((c) => c.boardId === b.id
      && (!ql || c.title.toLowerCase().includes(ql) || (c.description || '').toLowerCase().includes(ql))
      && (!assignee || c.assignees.includes(assignee))
      && (!label || c.labels.includes(label))
      && (!column || c.columnId === column)
      && (!dueBefore || (c.dueDate && c.dueDate < dueBefore)))
      .sort((a, b2) => (colPos.get(a.columnId) - colPos.get(b2.columnId)) || (a.position - b2.position));
    return [200, res.map(cardOut)];
  });

  // Activity
  route('GET', '/api/boards/:id/activity', ({ user, params, query }) => {
    const b = getBoard(params.id); requireRole(b.id, user, 'viewer');
    let limit = 50;
    const raw = query.get('limit');
    if (raw !== null && raw !== '') {
      limit = Number(raw);
      if (!Number.isInteger(limit) || limit < 0) throw bad('limit must be a non-negative integer');
    }
    const entries = db.activity.map((e, i) => [e, i]).filter(([e]) => e.boardId === b.id)
      .sort((x, y) => (y[0].at < x[0].at ? -1 : y[0].at > x[0].at ? 1 : y[1] - x[1]))
      .slice(0, limit).map(([e]) => e);
    return [200, entries];
  });

  // ---------- HTTP plumbing ----------
  function send(res, status, payload, headers = {}) {
    if (payload === undefined) { res.writeHead(status, headers); res.end(); return; }
    const data = JSON.stringify(payload);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data), ...headers });
    res.end(data);
  }
  const sendError = (res, err) => send(res, err.status, { error: err.code, message: err.message });

  const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
  function serveStatic(res, file) {
    const full = path.resolve(STATIC_DIR, file);
    if (!full.startsWith(STATIC_DIR + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) return false;
    const data = fs.readFileSync(full);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Content-Length': data.length });
    res.end(data);
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

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (pathname === '/' || pathname === '/index.html') { if (serveStatic(res, 'index.html')) return; }
        if (pathname.startsWith('/static/')) { if (serveStatic(res, decodeURIComponent(pathname.slice(8)))) return; throw notFound(); }
      }
      let match = null; let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== req.method) continue;
        match = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
        break;
      }
      if (!match) throw pathMatched ? new HttpError(404, 'not_found', 'Method not supported for this route') : notFound('Route not found');
      const raw = await readBody(req);
      let parsed; let parseErr = false;
      if (raw.trim()) { try { parsed = JSON.parse(raw); } catch { parseErr = true; } }
      const body = () => {
        if (parseErr) throw bad('Invalid JSON body');
        if (parsed === undefined) return {};
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw bad('Body must be a JSON object');
        return parsed;
      };
      let user = null; let token = null;
      if (match.r.auth) {
        const h = req.headers.authorization || '';
        const mm = /^Bearer\s+(\S+)$/i.exec(h);
        token = mm ? mm[1] : null;
        const uid = token ? sessions.get(token) : null;
        user = uid ? userById(uid) : null;
        if (!user) throw new HttpError(401, 'unauthenticated', 'Authentication required');
      } else if (parseErr) {
        throw bad('Invalid JSON body');
      }
      const [status, payload] = await match.r.handler({ req, user, token, params: match.params, query: url.searchParams, body });
      send(res, status, payload);
    } catch (err) {
      if (err instanceof HttpError) return sendError(res, err);
      console.error(err);
      send(res, 500, { error: 'internal', message: 'Internal server error' });
    }
  });
  return server;
}
