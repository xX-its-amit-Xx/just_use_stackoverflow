import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { UI_HTML } from './ui.js';

class HttpError extends Error {
  constructor(status, error, message) { super(message); this.status = status; this.error = error; }
}
const bad = (m) => new HttpError(400, 'validation', m);
const forbidden = (m = 'forbidden') => new HttpError(403, 'forbidden', m);
const notFound = (m = 'not found') => new HttpError(404, 'not_found', m);
const conflict = (m, code = 'conflict') => new HttpError(409, code, m);

const nowIso = () => new Date().toISOString();
const uid = () => crypto.randomUUID();
const isStr = (v) => typeof v === 'string';
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function validDate(s) {
  if (!isStr(s) || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 64).toString('hex');

export function createServer({ dataFile } = {}) {
  let db = { users: {}, boards: {}, columns: {}, cards: {}, labels: {}, comments: {}, activity: [] };
  if (dataFile && fs.existsSync(dataFile)) {
    try { db = { ...db, ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) }; } catch { /* ignore */ }
  }
  const sessions = new Map(); // token -> userId
  const failures = new Map(); // username -> [timestamps]

  function save() {
    if (!dataFile) return;
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, dataFile);
  }

  const pubUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName });
  const colCards = (colId) => Object.values(db.cards).filter((c) => c.columnId === colId).sort((a, b) => a.position - b.position);
  const boardCols = (bid) => Object.values(db.columns).filter((c) => c.boardId === bid).sort((a, b) => a.position - b.position);
  const renumber = (arr) => arr.forEach((x, i) => { x.position = i; });
  const log = (boardId, type, actorId, cardId, details = {}) => {
    const e = { id: uid(), boardId, type, actorId, at: nowIso(), details };
    if (cardId) e.cardId = cardId;
    db.activity.push(e);
  };

  function boardView(b) {
    return {
      id: b.id, name: b.name, description: b.description, ownerId: b.ownerId, createdAt: b.createdAt,
      members: b.members.map((m) => ({ userId: m.userId, username: db.users[m.userId]?.username, role: m.role })),
      labels: Object.values(db.labels).filter((l) => l.boardId === b.id),
      columns: boardCols(b.id).map((c) => ({ id: c.id, name: c.name, position: c.position, wipLimit: c.wipLimit, cards: colCards(c.id) })),
    };
  }

  const roleOf = (b, userId) => b.members.find((m) => m.userId === userId)?.role;
  function access(b, user, min) {
    const r = roleOf(b, user.id);
    if (!r) throw forbidden('not a member of this board');
    const rank = { viewer: 1, editor: 2, owner: 3 };
    if (rank[r] < rank[min]) throw forbidden('insufficient role');
    return r;
  }
  function getBoard(id) { const b = db.boards[id]; if (!b) throw notFound('board not found'); return b; }
  function getColumn(id) { const c = db.columns[id]; if (!c) throw notFound('column not found'); return c; }
  function getCard(id) { const c = db.cards[id]; if (!c) throw notFound('card not found'); return c; }

  function checkPosition(p) {
    if (!Number.isInteger(p) || p < 0) throw bad('position must be a non-negative integer');
  }
  function checkWip(v) {
    if (v === null) return null;
    if (!Number.isInteger(v) || v < 1) throw bad('wipLimit must be a positive integer or null');
    return v;
  }
  function checkAssigneesLabels(b, assignees, labels) {
    if (assignees !== undefined) {
      if (!Array.isArray(assignees) || !assignees.every(isStr)) throw bad('assignees must be an array of ids');
      for (const a of assignees) if (!roleOf(b, a)) throw bad('assignee is not a board member');
    }
    if (labels !== undefined) {
      if (!Array.isArray(labels) || !labels.every(isStr)) throw bad('labels must be an array of ids');
      for (const l of labels) if (db.labels[l]?.boardId !== b.id) throw bad('label does not belong to board');
    }
  }

  function deleteCardsOf(colId) {
    for (const c of Object.values(db.cards)) if (c.columnId === colId) {
      delete db.cards[c.id];
      for (const cm of Object.values(db.comments)) if (cm.cardId === c.id) delete db.comments[cm.id];
    }
  }

  // ---- routing ----
  const routes = [];
  const route = (method, path, auth, fn) => {
    const keys = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, auth, fn });
  };

  route('POST', '/api/auth/register', false, ({ body }) => {
    if (!isObj(body)) throw bad('body required');
    const { username, password, displayName } = body;
    if (!isStr(username) || !/^[a-z0-9_]{3,32}$/i.test(username)) throw bad('invalid username');
    if (!isStr(password) || password.length < 8) throw bad('password must be at least 8 characters');
    if (displayName !== undefined && displayName !== null && (!isStr(displayName) || displayName.length > 100)) throw bad('invalid displayName');
    const un = username.toLowerCase();
    if (Object.values(db.users).some((u) => u.username === un)) throw conflict('username taken');
    const salt = crypto.randomBytes(16).toString('hex');
    const u = { id: uid(), username: un, displayName: displayName || un, salt, hash: hashPw(password, salt), createdAt: nowIso() };
    db.users[u.id] = u;
    save();
    return [201, { user: pubUser(u) }];
  });

  route('POST', '/api/auth/login', false, ({ body }) => {
    if (!isObj(body) || !isStr(body.username) || !isStr(body.password)) throw bad('username and password required');
    const un = body.username.toLowerCase();
    const now = Date.now();
    const fl = (failures.get(un) || []).filter((t) => now - t < 15 * 60 * 1000);
    failures.set(un, fl);
    if (fl.length >= 5) throw new HttpError(429, 'rate_limited', 'too many failed attempts');
    const u = Object.values(db.users).find((x) => x.username === un);
    let ok = false;
    if (u) {
      const a = Buffer.from(hashPw(body.password, u.salt), 'hex'), b = Buffer.from(u.hash, 'hex');
      ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    }
    if (!ok) { fl.push(now); throw new HttpError(401, 'unauthorized', 'invalid credentials'); }
    failures.delete(un);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, u.id);
    return [200, { token, user: pubUser(u) }];
  });

  route('POST', '/api/auth/logout', true, ({ token }) => { sessions.delete(token); return [204]; });
  route('GET', '/api/auth/me', true, ({ user }) => [200, { user: pubUser(user) }]);

  // boards
  route('POST', '/api/boards', true, ({ user, body }) => {
    if (!isObj(body)) throw bad('body required');
    const { name, description, columns } = body;
    if (!isStr(name) || name.length < 1 || name.length > 100) throw bad('name must be 1-100 chars');
    if (description !== undefined && description !== null && !isStr(description)) throw bad('invalid description');
    let names = ['To Do', 'In Progress', 'Done'];
    if (columns !== undefined) {
      if (!Array.isArray(columns) || !columns.every((c) => isStr(c) && c.length >= 1 && c.length <= 100)) throw bad('columns must be an array of names');
      names = columns;
    }
    const b = { id: uid(), name, description: description || '', ownerId: user.id, createdAt: nowIso(), members: [{ userId: user.id, role: 'owner' }] };
    db.boards[b.id] = b;
    log(b.id, 'board.created', user.id, null, { name });
    names.forEach((n, i) => {
      const c = { id: uid(), boardId: b.id, name: n, position: i, wipLimit: null };
      db.columns[c.id] = c;
      log(b.id, 'column.created', user.id, null, { columnId: c.id, name: n });
    });
    save();
    return [201, boardView(b)];
  });

  route('GET', '/api/boards', true, ({ user }) => [200,
    Object.values(db.boards).filter((b) => roleOf(b, user.id)).map((b) => ({ id: b.id, name: b.name, role: roleOf(b, user.id) }))]);

  route('GET', '/api/boards/:id', true, ({ user, params }) => {
    const b = getBoard(params.id); access(b, user, 'viewer'); return [200, boardView(b)];
  });

  route('PATCH', '/api/boards/:id', true, ({ user, params, body }) => {
    const b = getBoard(params.id); access(b, user, 'owner');
    if (!isObj(body)) throw bad('body required');
    if (body.name !== undefined && (!isStr(body.name) || body.name.length < 1 || body.name.length > 100)) throw bad('name must be 1-100 chars');
    if (body.description !== undefined && body.description !== null && !isStr(body.description)) throw bad('invalid description');
    if (body.name !== undefined) b.name = body.name;
    if (body.description !== undefined) b.description = body.description || '';
    save();
    return [200, boardView(b)];
  });

  route('DELETE', '/api/boards/:id', true, ({ user, params }) => {
    const b = getBoard(params.id); access(b, user, 'owner');
    for (const c of Object.values(db.columns)) if (c.boardId === b.id) { deleteCardsOf(c.id); delete db.columns[c.id]; }
    for (const l of Object.values(db.labels)) if (l.boardId === b.id) delete db.labels[l.id];
    db.activity = db.activity.filter((a) => a.boardId !== b.id);
    delete db.boards[b.id];
    save();
    return [204];
  });

  const ROLES = ['editor', 'viewer'];
  route('POST', '/api/boards/:id/members', true, ({ user, params, body }) => {
    const b = getBoard(params.id); access(b, user, 'owner');
    if (!isObj(body) || !isStr(body.username)) throw bad('username required');
    if (!ROLES.includes(body.role)) throw bad('role must be editor or viewer');
    const u = Object.values(db.users).find((x) => x.username === body.username.toLowerCase());
    if (!u) throw notFound('user not found');
    if (roleOf(b, u.id)) throw conflict('already a member');
    b.members.push({ userId: u.id, role: body.role });
    log(b.id, 'member.added', user.id, null, { userId: u.id, role: body.role });
    save();
    return [201, { userId: u.id, username: u.username, role: body.role }];
  });

  route('PATCH', '/api/boards/:id/members/:userId', true, ({ user, params, body }) => {
    const b = getBoard(params.id); access(b, user, 'owner');
    if (!isObj(body) || !ROLES.includes(body.role)) throw bad('role must be editor or viewer');
    const m = b.members.find((x) => x.userId === params.userId);
    if (!m) throw notFound('member not found');
    if (m.role === 'owner') throw bad('cannot change owner role');
    m.role = body.role;
    save();
    return [200, { userId: m.userId, username: db.users[m.userId]?.username, role: m.role }];
  });

  route('DELETE', '/api/boards/:id/members/:userId', true, ({ user, params }) => {
    const b = getBoard(params.id);
    const r = access(b, user, 'viewer');
    if (r !== 'owner' && params.userId !== user.id) throw forbidden('only owner can remove others');
    const m = b.members.find((x) => x.userId === params.userId);
    if (!m) throw notFound('member not found');
    if (m.role === 'owner') throw bad('cannot remove the owner');
    b.members = b.members.filter((x) => x !== m);
    for (const c of Object.values(db.cards)) if (c.boardId === b.id) c.assignees = c.assignees.filter((a) => a !== m.userId);
    save();
    return [204];
  });

  // columns
  route('POST', '/api/boards/:id/columns', true, ({ user, params, body }) => {
    const b = getBoard(params.id); access(b, user, 'editor');
    if (!isObj(body) || !isStr(body.name) || body.name.length < 1 || body.name.length > 100) throw bad('name must be 1-100 chars');
    const wip = body.wipLimit === undefined ? null : checkWip(body.wipLimit);
    const c = { id: uid(), boardId: b.id, name: body.name, position: boardCols(b.id).length, wipLimit: wip };
    db.columns[c.id] = c;
    log(b.id, 'column.created', user.id, null, { columnId: c.id, name: c.name });
    save();
    return [201, { ...c, cards: [] }];
  });

  route('PATCH', '/api/columns/:id', true, ({ user, params, body }) => {
    const c = getColumn(params.id); const b = getBoard(c.boardId); access(b, user, 'editor');
    if (!isObj(body)) throw bad('body required');
    if (body.name !== undefined && (!isStr(body.name) || body.name.length < 1 || body.name.length > 100)) throw bad('name must be 1-100 chars');
    if (body.wipLimit !== undefined) checkWip(body.wipLimit);
    if (body.position !== undefined) checkPosition(body.position);
    if (body.name !== undefined) c.name = body.name;
    if (body.wipLimit !== undefined) c.wipLimit = body.wipLimit;
    if (body.position !== undefined) {
      const cols = boardCols(b.id).filter((x) => x.id !== c.id);
      cols.splice(Math.min(body.position, cols.length), 0, c);
      renumber(cols);
    }
    save();
    return [200, { ...c, cards: colCards(c.id) }];
  });

  route('DELETE', '/api/columns/:id', true, ({ user, params, query }) => {
    const c = getColumn(params.id); const b = getBoard(c.boardId); access(b, user, 'editor');
    if (colCards(c.id).length && query.get('force') !== 'true') throw conflict('column still has cards');
    deleteCardsOf(c.id);
    delete db.columns[c.id];
    renumber(boardCols(b.id));
    save();
    return [204];
  });

  // cards
  route('POST', '/api/columns/:id/cards', true, ({ user, params, body }) => {
    const col = getColumn(params.id); const b = getBoard(col.boardId); access(b, user, 'editor');
    if (!isObj(body)) throw bad('body required');
    const { title, description, assignees, labels, dueDate, position } = body;
    if (!isStr(title) || title.length < 1 || title.length > 200) throw bad('title must be 1-200 chars');
    if (description !== undefined && description !== null && !isStr(description)) throw bad('invalid description');
    if (dueDate !== undefined && dueDate !== null && !validDate(dueDate)) throw bad('dueDate must be YYYY-MM-DD');
    if (position !== undefined && position !== null) checkPosition(position);
    checkAssigneesLabels(b, assignees, labels);
    const cards = colCards(col.id);
    if (col.wipLimit != null && cards.length >= col.wipLimit) throw conflict('WIP limit reached', 'wip_limit');
    const t = nowIso();
    const card = {
      id: uid(), boardId: b.id, columnId: col.id, title, description: description || '', position: 0,
      assignees: [...new Set(assignees || [])], labels: [...new Set(labels || [])], dueDate: dueDate ?? null,
      createdBy: user.id, createdAt: t, updatedAt: t,
    };
    db.cards[card.id] = card;
    const p = position == null ? cards.length : Math.min(position, cards.length);
    cards.splice(p, 0, card);
    renumber(cards);
    log(b.id, 'card.created', user.id, card.id, { title, columnId: col.id });
    save();
    return [201, card];
  });

  route('GET', '/api/cards/:id', true, ({ user, params }) => {
    const c = getCard(params.id); access(getBoard(c.boardId), user, 'viewer'); return [200, c];
  });

  route('PATCH', '/api/cards/:id', true, ({ user, params, body }) => {
    const card = getCard(params.id); const b = getBoard(card.boardId); access(b, user, 'editor');
    if (!isObj(body)) throw bad('body required');
    const { title, description, assignees, labels, dueDate } = body;
    if (title !== undefined && (!isStr(title) || title.length < 1 || title.length > 200)) throw bad('title must be 1-200 chars');
    if (description !== undefined && description !== null && !isStr(description)) throw bad('invalid description');
    if (dueDate !== undefined && dueDate !== null && !validDate(dueDate)) throw bad('dueDate must be YYYY-MM-DD');
    checkAssigneesLabels(b, assignees, labels);
    const changed = [];
    if (title !== undefined) { card.title = title; changed.push('title'); }
    if (description !== undefined) { card.description = description || ''; changed.push('description'); }
    if (assignees !== undefined) { card.assignees = [...new Set(assignees)]; changed.push('assignees'); }
    if (labels !== undefined) { card.labels = [...new Set(labels)]; changed.push('labels'); }
    if (dueDate !== undefined) { card.dueDate = dueDate; changed.push('dueDate'); }
    card.updatedAt = nowIso();
    log(b.id, 'card.updated', user.id, card.id, { fields: changed });
    save();
    return [200, card];
  });

  route('DELETE', '/api/cards/:id', true, ({ user, params }) => {
    const card = getCard(params.id); const b = getBoard(card.boardId); access(b, user, 'editor');
    delete db.cards[card.id];
    for (const cm of Object.values(db.comments)) if (cm.cardId === card.id) delete db.comments[cm.id];
    renumber(colCards(card.columnId));
    log(b.id, 'card.deleted', user.id, card.id, { title: card.title, columnId: card.columnId });
    save();
    return [204];
  });

  route('POST', '/api/cards/:id/move', true, ({ user, params, body }) => {
    const card = getCard(params.id); const b = getBoard(card.boardId); access(b, user, 'editor');
    if (!isObj(body) || !isStr(body.columnId)) throw bad('columnId required');
    if (body.position !== undefined && body.position !== null) checkPosition(body.position);
    const target = db.columns[body.columnId];
    if (!target || target.boardId !== b.id) throw bad('target column must be on the same board');
    const fromId = card.columnId;
    if (target.id !== fromId && target.wipLimit != null && colCards(target.id).length >= target.wipLimit)
      throw conflict('WIP limit reached', 'wip_limit');
    const src = colCards(fromId).filter((c) => c.id !== card.id);
    renumber(src);
    const dst = target.id === fromId ? src : colCards(target.id);
    const p = body.position == null ? dst.length : Math.min(body.position, dst.length);
    card.columnId = target.id;
    dst.splice(p, 0, card);
    renumber(dst);
    card.updatedAt = nowIso();
    log(b.id, 'card.moved', user.id, card.id, { fromColumnId: fromId, toColumnId: target.id, position: card.position });
    save();
    return [200, card];
  });

  // labels
  route('POST', '/api/boards/:id/labels', true, ({ user, params, body }) => {
    const b = getBoard(params.id); access(b, user, 'editor');
    if (!isObj(body) || !isStr(body.name) || body.name.length < 1 || body.name.length > 50) throw bad('name must be 1-50 chars');
    if (!isStr(body.color) || !/^#[0-9a-fA-F]{6}$/.test(body.color)) throw bad('color must be #rrggbb');
    const lower = body.name.toLowerCase();
    if (Object.values(db.labels).some((l) => l.boardId === b.id && l.name.toLowerCase() === lower)) throw conflict('label exists');
    const l = { id: uid(), boardId: b.id, name: body.name, color: body.color };
    db.labels[l.id] = l;
    save();
    return [201, l];
  });

  route('DELETE', '/api/labels/:id', true, ({ user, params }) => {
    const l = db.labels[params.id]; if (!l) throw notFound('label not found');
    access(getBoard(l.boardId), user, 'editor');
    delete db.labels[l.id];
    for (const c of Object.values(db.cards)) if (c.labels.includes(l.id)) c.labels = c.labels.filter((x) => x !== l.id);
    save();
    return [204];
  });

  // comments
  route('POST', '/api/cards/:id/comments', true, ({ user, params, body }) => {
    const card = getCard(params.id); const b = getBoard(card.boardId); access(b, user, 'editor');
    if (!isObj(body) || !isStr(body.body) || body.body.length < 1 || body.body.length > 5000) throw bad('body must be 1-5000 chars');
    const cm = { id: uid(), cardId: card.id, authorId: user.id, body: body.body, createdAt: nowIso() };
    db.comments[cm.id] = cm;
    log(b.id, 'comment.added', user.id, card.id, { commentId: cm.id });
    save();
    return [201, cm];
  });

  route('GET', '/api/cards/:id/comments', true, ({ user, params }) => {
    const card = getCard(params.id); access(getBoard(card.boardId), user, 'viewer');
    return [200, Object.values(db.comments).filter((c) => c.cardId === card.id)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0))];
  });

  route('DELETE', '/api/comments/:id', true, ({ user, params }) => {
    const cm = db.comments[params.id]; if (!cm) throw notFound('comment not found');
    const card = db.cards[cm.cardId]; const b = getBoard(card.boardId);
    const r = access(b, user, 'viewer');
    if (cm.authorId !== user.id && r !== 'owner') throw forbidden('only author or owner');
    delete db.comments[cm.id];
    save();
    return [204];
  });

  // search & activity
  route('GET', '/api/boards/:id/cards', true, ({ user, params, query }) => {
    const b = getBoard(params.id); access(b, user, 'viewer');
    const q = query.get('q'), assignee = query.get('assignee'), label = query.get('label'), column = query.get('column'), due = query.get('due_before');
    if (due && !validDate(due)) throw bad('due_before must be YYYY-MM-DD');
    const out = [];
    for (const col of boardCols(b.id)) for (const c of colCards(col.id)) {
      if (q && !(c.title.toLowerCase().includes(q.toLowerCase()) || (c.description || '').toLowerCase().includes(q.toLowerCase()))) continue;
      if (assignee && !c.assignees.includes(assignee)) continue;
      if (label && !c.labels.includes(label)) continue;
      if (column && c.columnId !== column) continue;
      if (due && !(c.dueDate && c.dueDate < due)) continue;
      out.push(c);
    }
    return [200, out];
  });

  route('GET', '/api/boards/:id/activity', true, ({ user, params, query }) => {
    const b = getBoard(params.id); access(b, user, 'viewer');
    let limit = 50;
    if (query.has('limit')) {
      limit = Number(query.get('limit'));
      if (!Number.isInteger(limit) || limit < 1) throw bad('invalid limit');
    }
    const items = db.activity.filter((a) => a.boardId === b.id);
    return [200, items.reverse().slice(0, limit)];
  });

  // ---- server ----
  function send(res, status, payload, headers = {}) {
    if (status === 204) { res.writeHead(204); return res.end(); }
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    res.writeHead(status, { 'content-type': typeof payload === 'string' ? 'text/html; charset=utf-8' : 'application/json', 'content-length': Buffer.byteLength(data), ...headers });
    res.end(data);
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const url = new URL(req.url, 'http://localhost');
        const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
        if (req.method === 'GET' && path === '/') return send(res, 200, UI_HTML);
        if (!path.startsWith('/api/')) throw notFound('not found');
        let matched = null, pathMatched = false;
        for (const r of routes) {
          const m = r.re.exec(path);
          if (!m) continue;
          pathMatched = true;
          if (r.method !== req.method) continue;
          const params = {};
          r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
          matched = { r, params };
          break;
        }
        if (!matched) throw pathMatched ? new HttpError(405, 'method_not_allowed', 'method not allowed') : notFound('route not found');
        const ctx = { params: matched.params, query: url.searchParams };
        if (matched.r.auth) {
          const h = req.headers.authorization || '';
          const mm = /^Bearer (.+)$/i.exec(h);
          const uidv = mm && sessions.get(mm[1]);
          const user = uidv && db.users[uidv];
          if (!user) throw new HttpError(401, 'unauthorized', 'authentication required');
          ctx.user = user; ctx.token = mm[1];
        }
        if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (raw.trim()) {
            try { ctx.body = JSON.parse(raw); } catch { throw bad('invalid JSON'); }
          } else ctx.body = undefined;
        }
        const [status, payload] = matched.r.fn(ctx);
        send(res, status, payload);
      } catch (e) {
        if (e instanceof HttpError) send(res, e.status, { error: e.error, message: e.message });
        else { console.error(e); send(res, 500, { error: 'internal', message: 'internal error' }); }
      }
    });
  });
  return server;
}
