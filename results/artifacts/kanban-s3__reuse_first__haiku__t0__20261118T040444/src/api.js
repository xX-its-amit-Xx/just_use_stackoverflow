// REST API route table and domain logic for the kanban service.
import { randomBytes, randomUUID } from 'node:crypto';
import { hashPassword, verifyPassword } from './auth.js';
import { compileRoute } from './router.js';
import {
  badRequest, unauthorized, forbidden, notFound, conflict, rateLimited,
  nowIso, requireString, parseDescription, parseWip, parseDate, parseIndex,
} from './util.js';

const DEFAULT_COLUMNS = ['To Do', 'In Progress', 'Done'];
const RANK = { viewer: 1, editor: 2, owner: 3 };
const MEMBER_ROLES = ['editor', 'viewer'];
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

export function createApi(db) {
  const sessions = new Map(); // token -> userId (not persisted)
  const failures = new Map(); // username -> [timestamps of failed logins]
  const routes = [];
  const add = (method, pattern, opts, handler) => routes.push(compileRoute(method, pattern, opts, handler));

  // ---- lookups -----------------------------------------------------------
  const userById = (id) => db.users.find((u) => u.id === id);
  const publicUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName });
  const roleIn = (board, userId) => board.members.find((m) => m.userId === userId)?.role ?? null;
  const boardOf = (id) => db.boards.find((b) => b.id === id);
  const columnsOf = (boardId) => db.columns.filter((c) => c.boardId === boardId).sort((a, b) => a.position - b.position);
  const cardsIn = (columnId) => db.cards.filter((c) => c.columnId === columnId).sort((a, b) => a.position - b.position);
  const labelsOf = (boardId) => db.labels.filter((l) => l.boardId === boardId);
  const renumber = (list) => list.forEach((x, i) => { x.position = i; });

  function access(board, user, min = 'viewer') {
    const role = roleIn(board, user.id);
    if (!role) throw forbidden('not a member of this board');
    if (RANK[role] < RANK[min]) throw forbidden(`requires ${min} role`);
    return role;
  }
  function boardAccess(boardId, user, min) {
    const board = boardOf(boardId);
    if (!board) throw notFound('board not found');
    access(board, user, min);
    return board;
  }
  function columnAccess(columnId, user, min) {
    const column = db.columns.find((c) => c.id === columnId);
    if (!column) throw notFound('column not found');
    return { column, board: boardAccess(column.boardId, user, min) };
  }
  function cardAccess(cardId, user, min) {
    const card = db.cards.find((c) => c.id === cardId);
    if (!card) throw notFound('card not found');
    return { card, board: boardAccess(card.boardId, user, min) };
  }

  // ---- views -------------------------------------------------------------
  const labelView = (l) => ({ id: l.id, boardId: l.boardId, name: l.name, color: l.color });
  const columnView = (c) => ({ id: c.id, boardId: c.boardId, name: c.name, position: c.position, wipLimit: c.wipLimit });
  const cardView = (c) => ({
    id: c.id, boardId: c.boardId, columnId: c.columnId, title: c.title, description: c.description,
    position: c.position, assignees: [...c.assignees], labels: [...c.labels], dueDate: c.dueDate,
    createdBy: c.createdBy, createdAt: c.createdAt, updatedAt: c.updatedAt,
  });
  function boardView(board) {
    return {
      id: board.id,
      name: board.name,
      description: board.description,
      ownerId: board.ownerId,
      createdAt: board.createdAt,
      members: board.members.map((m) => ({ userId: m.userId, username: userById(m.userId)?.username ?? null, role: m.role })),
      labels: labelsOf(board.id).map(labelView),
      columns: columnsOf(board.id).map((c) => ({
        id: c.id, name: c.name, position: c.position, wipLimit: c.wipLimit,
        cards: cardsIn(c.id).map(cardView),
      })),
    };
  }

  // ---- domain helpers ----------------------------------------------------
  function log(boardId, type, actorId, details = {}, cardId) {
    const entry = { id: randomUUID(), boardId, type, actorId, at: nowIso(), details };
    if (cardId) entry.cardId = cardId;
    db.activity.push(entry);
  }
  function validateAssignees(board, value) {
    if (!Array.isArray(value)) throw badRequest('assignees must be an array of user ids');
    const ids = [...new Set(value)];
    for (const uid of ids) {
      if (typeof uid !== 'string' || !board.members.some((m) => m.userId === uid)) {
        throw badRequest('assignees must be members of the board');
      }
    }
    return ids;
  }
  function validateLabels(board, value) {
    if (!Array.isArray(value)) throw badRequest('labels must be an array of label ids');
    const ids = [...new Set(value)];
    for (const lid of ids) {
      if (typeof lid !== 'string' || !db.labels.some((l) => l.id === lid && l.boardId === board.id)) {
        throw badRequest('labels must belong to this board');
      }
    }
    return ids;
  }
  // Insert card into column at position (default: end), keeping positions 0..n-1.
  function placeCard(card, columnId, position) {
    const list = cardsIn(columnId).filter((c) => c !== card);
    const idx = position == null ? list.length : clamp(position, 0, list.length);
    list.splice(idx, 0, card);
    card.columnId = columnId;
    renumber(list);
  }
  function removeCard(card, actorId) {
    db.cards = db.cards.filter((c) => c !== card);
    db.comments = db.comments.filter((c) => c.cardId !== card.id);
    renumber(cardsIn(card.columnId));
    log(card.boardId, 'card.deleted', actorId, { title: card.title, columnId: card.columnId }, card.id);
  }

  // ---- auth --------------------------------------------------------------
  add('POST', '/api/auth/register', { auth: false, json: true }, ({ body }) => {
    if (typeof body.username !== 'string' || !/^[a-z0-9_]{3,32}$/.test(body.username.toLowerCase())) {
      throw badRequest('username must be 3-32 characters of a-z, 0-9 or _');
    }
    const username = body.username.toLowerCase();
    if (typeof body.password !== 'string' || body.password.length < 8) {
      throw badRequest('password must be at least 8 characters');
    }
    const displayName = body.displayName === undefined || body.displayName === null
      ? username
      : requireString(body.displayName, 'displayName', 1, 100);
    if (db.users.some((u) => u.username === username)) throw conflict('username already taken');
    const user = { id: randomUUID(), username, displayName, passwordHash: hashPassword(body.password), createdAt: nowIso() };
    db.users.push(user);
    return { status: 201, body: { user: publicUser(user) } };
  });

  add('POST', '/api/auth/login', { auth: false, json: true }, ({ body }) => {
    if (typeof body.username !== 'string' || typeof body.password !== 'string') {
      throw badRequest('username and password are required');
    }
    const username = body.username.toLowerCase();
    const now = Date.now();
    const recent = (failures.get(username) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
    failures.set(username, recent);
    if (recent.length >= LOGIN_MAX_FAILURES) throw rateLimited('too many failed login attempts; try again later');
    const user = db.users.find((u) => u.username === username);
    if (!user || !verifyPassword(body.password, user.passwordHash)) {
      recent.push(now);
      throw unauthorized('invalid username or password');
    }
    failures.delete(username);
    const token = randomBytes(32).toString('hex');
    sessions.set(token, user.id);
    return { status: 200, body: { token, user: publicUser(user) } };
  });

  add('POST', '/api/auth/logout', {}, ({ token }) => {
    sessions.delete(token);
    return { status: 204 };
  });

  add('GET', '/api/auth/me', {}, ({ user }) => ({ status: 200, body: { user: publicUser(user) } }));

  // ---- boards ------------------------------------------------------------
  add('POST', '/api/boards', { json: true }, ({ user, body }) => {
    const name = requireString(body.name, 'name', 1, 100);
    const description = parseDescription(body.description);
    let names = DEFAULT_COLUMNS;
    if (body.columns !== undefined && body.columns !== null) {
      if (!Array.isArray(body.columns)) throw badRequest('columns must be an array of names');
      names = body.columns.map((n) => requireString(n, 'column name', 1, 100));
    }
    const board = {
      id: randomUUID(), name, description, ownerId: user.id, createdAt: nowIso(),
      members: [{ userId: user.id, role: 'owner' }],
    };
    db.boards.push(board);
    names.forEach((n, i) => db.columns.push({ id: randomUUID(), boardId: board.id, name: n, position: i, wipLimit: null }));
    log(board.id, 'board.created', user.id, { name });
    return { status: 201, body: boardView(board) };
  });

  add('GET', '/api/boards', {}, ({ user }) => ({
    status: 200,
    body: db.boards.flatMap((b) => {
      const role = roleIn(b, user.id);
      return role ? [{ id: b.id, name: b.name, role }] : [];
    }),
  }));

  add('GET', '/api/boards/:id', {}, ({ params, user }) => ({ status: 200, body: boardView(boardAccess(params.id, user)) }));

  add('PATCH', '/api/boards/:id', { json: true }, ({ params, user, body }) => {
    const board = boardAccess(params.id, user, 'owner');
    const name = body.name === undefined ? undefined : requireString(body.name, 'name', 1, 100);
    const description = body.description === undefined ? undefined : parseDescription(body.description);
    if (name !== undefined) board.name = name;
    if (description !== undefined) board.description = description;
    return { status: 200, body: boardView(board) };
  });

  add('DELETE', '/api/boards/:id', {}, ({ params, user }) => {
    const board = boardAccess(params.id, user, 'owner');
    const cardIds = new Set(db.cards.filter((c) => c.boardId === board.id).map((c) => c.id));
    db.boards = db.boards.filter((b) => b !== board);
    db.columns = db.columns.filter((c) => c.boardId !== board.id);
    db.cards = db.cards.filter((c) => c.boardId !== board.id);
    db.labels = db.labels.filter((l) => l.boardId !== board.id);
    db.comments = db.comments.filter((c) => !cardIds.has(c.cardId));
    db.activity = db.activity.filter((a) => a.boardId !== board.id);
    return { status: 204 };
  });

  // ---- members -----------------------------------------------------------
  add('POST', '/api/boards/:id/members', { json: true }, ({ params, user, body }) => {
    const board = boardAccess(params.id, user, 'owner');
    if (!MEMBER_ROLES.includes(body.role)) throw badRequest('role must be editor or viewer');
    if (typeof body.username !== 'string') throw badRequest('username is required');
    const username = body.username.toLowerCase();
    const target = db.users.find((u) => u.username === username);
    if (!target) throw notFound('user not found');
    if (roleIn(board, target.id)) throw conflict('user is already a member of this board');
    board.members.push({ userId: target.id, role: body.role });
    log(board.id, 'member.added', user.id, { userId: target.id, username: target.username, role: body.role });
    return { status: 201, body: { userId: target.id, username: target.username, role: body.role } };
  });

  add('PATCH', '/api/boards/:id/members/:userId', { json: true }, ({ params, user, body }) => {
    const board = boardAccess(params.id, user, 'owner');
    if (!MEMBER_ROLES.includes(body.role)) throw badRequest('role must be editor or viewer');
    const m = board.members.find((x) => x.userId === params.userId);
    if (!m) throw notFound('member not found');
    if (m.role === 'owner') throw badRequest('cannot change the owner role');
    m.role = body.role;
    return { status: 200, body: { userId: m.userId, username: userById(m.userId)?.username ?? null, role: m.role } };
  });

  add('DELETE', '/api/boards/:id/members/:userId', {}, ({ params, user }) => {
    const board = boardAccess(params.id, user);
    const actorRole = roleIn(board, user.id);
    const m = board.members.find((x) => x.userId === params.userId);
    if (!m) throw notFound('member not found');
    if (m.role === 'owner') throw badRequest('cannot remove the board owner');
    if (actorRole !== 'owner' && user.id !== m.userId) throw forbidden('only the owner can remove other members');
    board.members = board.members.filter((x) => x !== m);
    return { status: 204 };
  });

  // ---- columns -----------------------------------------------------------
  add('POST', '/api/boards/:id/columns', { json: true }, ({ params, user, body }) => {
    const board = boardAccess(params.id, user, 'editor');
    const name = requireString(body.name, 'name', 1, 100);
    const wipLimit = parseWip(body.wipLimit);
    const col = { id: randomUUID(), boardId: board.id, name, position: columnsOf(board.id).length, wipLimit };
    db.columns.push(col);
    log(board.id, 'column.created', user.id, { columnId: col.id, name });
    return { status: 201, body: columnView(col) };
  });

  add('PATCH', '/api/columns/:id', { json: true }, ({ params, user, body }) => {
    const { column, board } = columnAccess(params.id, user, 'editor');
    const name = body.name === undefined ? undefined : requireString(body.name, 'name', 1, 100);
    const wipLimit = body.wipLimit === undefined ? undefined : parseWip(body.wipLimit);
    let position;
    if (body.position !== undefined) {
      if (!Number.isInteger(body.position)) throw badRequest('position must be an integer');
      position = body.position;
    }
    if (name !== undefined) column.name = name;
    if (wipLimit !== undefined) column.wipLimit = wipLimit;
    if (position !== undefined) {
      const list = columnsOf(board.id).filter((c) => c !== column);
      list.splice(clamp(position, 0, list.length), 0, column);
      renumber(list);
    }
    return { status: 200, body: columnView(column) };
  });

  add('DELETE', '/api/columns/:id', {}, ({ params, user, query }) => {
    const { column, board } = columnAccess(params.id, user, 'editor');
    const cards = cardsIn(column.id);
    if (cards.length && query.get('force') !== 'true') throw conflict('column still contains cards');
    for (const card of cards) removeCard(card, user.id);
    db.columns = db.columns.filter((c) => c !== column);
    renumber(columnsOf(board.id));
    return { status: 204 };
  });

  // ---- cards -------------------------------------------------------------
  add('POST', '/api/columns/:id/cards', { json: true }, ({ params, user, body }) => {
    const { column, board } = columnAccess(params.id, user, 'editor');
    const title = requireString(body.title, 'title', 1, 200);
    const description = parseDescription(body.description);
    const assignees = body.assignees === undefined || body.assignees === null ? [] : validateAssignees(board, body.assignees);
    const labels = body.labels === undefined || body.labels === null ? [] : validateLabels(board, body.labels);
    const dueDate = parseDate(body.dueDate);
    const position = parseIndex(body.position);
    if (column.wipLimit && cardsIn(column.id).length >= column.wipLimit) {
      throw conflict('column WIP limit reached', 'wip_limit');
    }
    const now = nowIso();
    const card = {
      id: randomUUID(), boardId: board.id, columnId: column.id, title, description, position: 0,
      assignees, labels, dueDate, createdBy: user.id, createdAt: now, updatedAt: now,
    };
    db.cards.push(card);
    placeCard(card, column.id, position);
    log(board.id, 'card.created', user.id, { title, columnId: column.id }, card.id);
    return { status: 201, body: cardView(card) };
  });

  add('GET', '/api/cards/:id', {}, ({ params, user }) => ({ status: 200, body: cardView(cardAccess(params.id, user).card) }));

  add('PATCH', '/api/cards/:id', { json: true }, ({ params, user, body }) => {
    const { card, board } = cardAccess(params.id, user, 'editor');
    const up = {};
    if (body.title !== undefined) up.title = requireString(body.title, 'title', 1, 200);
    if (body.description !== undefined) up.description = parseDescription(body.description);
    if (body.assignees !== undefined) up.assignees = validateAssignees(board, body.assignees);
    if (body.labels !== undefined) up.labels = validateLabels(board, body.labels);
    if (body.dueDate !== undefined) up.dueDate = parseDate(body.dueDate);
    Object.assign(card, up, { updatedAt: nowIso() });
    log(board.id, 'card.updated', user.id, { fields: Object.keys(up) }, card.id);
    return { status: 200, body: cardView(card) };
  });

  add('DELETE', '/api/cards/:id', {}, ({ params, user }) => {
    const { card } = cardAccess(params.id, user, 'editor');
    removeCard(card, user.id);
    return { status: 204 };
  });

  add('POST', '/api/cards/:id/move', { json: true }, ({ params, user, body }) => {
    const { card, board } = cardAccess(params.id, user, 'editor');
    if (typeof body.columnId !== 'string') throw badRequest('columnId is required');
    const target = db.columns.find((c) => c.id === body.columnId && c.boardId === board.id);
    if (!target) throw badRequest('target column must exist on the same board');
    const position = parseIndex(body.position);
    const fromColumnId = card.columnId;
    if (target.id !== fromColumnId && target.wipLimit && cardsIn(target.id).length >= target.wipLimit) {
      throw conflict('column WIP limit reached', 'wip_limit');
    }
    placeCard(card, target.id, position);
    if (fromColumnId !== target.id) renumber(cardsIn(fromColumnId));
    log(board.id, 'card.moved', user.id, { fromColumnId, toColumnId: target.id, position: card.position }, card.id);
    return { status: 200, body: cardView(card) };
  });

  add('GET', '/api/boards/:id/cards', {}, ({ params, user, query }) => {
    const board = boardAccess(params.id, user);
    const q = (query.get('q') || '').toLowerCase();
    const assignee = query.get('assignee') || '';
    const label = query.get('label') || '';
    const column = query.get('column') || '';
    const dueBefore = query.get('due_before') || '';
    if (dueBefore) parseDate(dueBefore);
    const colPos = new Map(columnsOf(board.id).map((c) => [c.id, c.position]));
    return {
      status: 200,
      body: db.cards
        .filter((c) => c.boardId === board.id
          && (!q || c.title.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
          && (!assignee || c.assignees.includes(assignee))
          && (!label || c.labels.includes(label))
          && (!column || c.columnId === column)
          && (!dueBefore || (c.dueDate !== null && c.dueDate < dueBefore)))
        .sort((a, b) => (colPos.get(a.columnId) - colPos.get(b.columnId)) || a.position - b.position)
        .map(cardView),
    };
  });

  // ---- labels ------------------------------------------------------------
  add('POST', '/api/boards/:id/labels', { json: true }, ({ params, user, body }) => {
    const board = boardAccess(params.id, user, 'editor');
    const name = requireString(body.name, 'name', 1, 50);
    if (typeof body.color !== 'string' || !HEX_COLOR.test(body.color)) throw badRequest('color must be #rrggbb');
    if (labelsOf(board.id).some((l) => l.name.toLowerCase() === name.toLowerCase())) {
      throw conflict('label name already exists on this board');
    }
    const label = { id: randomUUID(), boardId: board.id, name, color: body.color };
    db.labels.push(label);
    return { status: 201, body: labelView(label) };
  });

  add('DELETE', '/api/labels/:id', {}, ({ params, user }) => {
    const label = db.labels.find((l) => l.id === params.id);
    if (!label) throw notFound('label not found');
    boardAccess(label.boardId, user, 'editor');
    db.labels = db.labels.filter((l) => l !== label);
    for (const c of db.cards) c.labels = c.labels.filter((x) => x !== label.id);
    return { status: 204 };
  });

  // ---- comments ----------------------------------------------------------
  add('POST', '/api/cards/:id/comments', { json: true }, ({ params, user, body }) => {
    const { card, board } = cardAccess(params.id, user, 'editor');
    if (typeof body.body !== 'string' || body.body.trim().length < 1 || body.body.length > 5000) {
      throw badRequest('body must be 1-5000 characters');
    }
    const comment = { id: randomUUID(), cardId: card.id, authorId: user.id, body: body.body, createdAt: nowIso() };
    db.comments.push(comment);
    log(board.id, 'comment.added', user.id, { commentId: comment.id }, card.id);
    return { status: 201, body: { ...comment } };
  });

  add('GET', '/api/cards/:id/comments', {}, ({ params, user }) => {
    const { card } = cardAccess(params.id, user);
    return { status: 200, body: db.comments.filter((c) => c.cardId === card.id).map((c) => ({ ...c })) };
  });

  add('DELETE', '/api/comments/:id', {}, ({ params, user }) => {
    const comment = db.comments.find((c) => c.id === params.id);
    if (!comment) throw notFound('comment not found');
    const card = db.cards.find((c) => c.id === comment.cardId);
    const board = boardAccess(card.boardId, user);
    if (comment.authorId !== user.id && roleIn(board, user.id) !== 'owner') {
      throw forbidden('only the author or the board owner can delete this comment');
    }
    db.comments = db.comments.filter((c) => c !== comment);
    return { status: 204 };
  });

  // ---- activity ----------------------------------------------------------
  add('GET', '/api/boards/:id/activity', {}, ({ params, user, query }) => {
    const board = boardAccess(params.id, user);
    const raw = query.get('limit');
    let limit = 50;
    if (raw !== null) {
      if (!/^\d+$/.test(raw)) throw badRequest('limit must be a non-negative integer');
      limit = Number(raw);
    }
    const entries = db.activity.filter((a) => a.boardId === board.id).reverse().slice(0, limit);
    return { status: 200, body: entries.map((a) => ({ ...a })) };
  });

  return {
    routes,
    userForToken(token) {
      const uid = sessions.get(token);
      return uid ? userById(uid) ?? null : null;
    },
    dropToken(token) {
      sessions.delete(token);
    },
  };
}
