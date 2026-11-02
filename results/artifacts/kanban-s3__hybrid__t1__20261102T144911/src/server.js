import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { HTML } from './ui.js';

class HttpError extends Error {
  constructor(status, error, message) { super(message || error); this.status = status; this.error = error; }
}
const bad = (m) => new HttpError(400, 'validation', m);
const forbidden = (m = 'forbidden') => new HttpError(403, 'forbidden', m);
const notFound = (m = 'not found') => new HttpError(404, 'not_found', m);
const conflict = (m, code = 'conflict') => new HttpError(409, code, m);

const isStr = (v) => typeof v === 'string';
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const validDate = (s) => {
  if (!isStr(s) || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
};
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();

function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pw, salt, 32).toString('hex') };
}

export function createServer({ dataFile } = {}) {
  let db = { users: [], boards: [], columns: [], cards: [], labels: [], comments: [], activity: [] };
  if (dataFile && fs.existsSync(dataFile)) {
    try { db = { ...db, ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) }; } catch { /* ignore */ }
  }
  const tokens = new Map();
  const failures = new Map(); // username -> [timestamps]
  const save = () => {
    if (!dataFile) return;
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, dataFile);
  };

  const pubUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName });
  const log = (boardId, type, actorId, cardId, details = {}) => {
    const e = { id: uid(), boardId, type, actorId, at: now(), details };
    if (cardId) e.cardId = cardId;
    db.activity.push(e);
  };

  // ---- lookups
  const getBoard = (id) => { const b = db.boards.find((x) => x.id === id); if (!b) throw notFound('board not found'); return b; };
  const roleOf = (b, userId) => b.members.find((m) => m.userId === userId)?.role;
  const need = (b, user, level) => {
    const r = roleOf(b, user.id);
    if (!r) throw forbidden('not a member');
    const rank = { viewer: 0, editor: 1, owner: 2 };
    if (rank[r] < rank[level]) throw forbidden('insufficient role');
    return r;
  };
  const colsOf = (boardId) => db.columns.filter((c) => c.boardId === boardId).sort((a, b) => a.position - b.position);
  const cardsOf = (colId) => db.cards.filter((c) => c.columnId === colId).sort((a, b) => a.position - b.position);
  const compactCol = (colId) => cardsOf(colId).forEach((c, i) => { c.position = i; });
  const compactBoard = (boardId) => colsOf(boardId).forEach((c, i) => { c.position = i; });
  const getColumn = (id) => { const c = db.columns.find((x) => x.id === id); if (!c) throw notFound('column not found'); return c; };
  const getCard = (id) => { const c = db.cards.find((x) => x.id === id); if (!c) throw notFound('card not found'); return c; };
  const cardOut = (c) => ({ id: c.id, boardId: c.boardId, columnId: c.columnId, title: c.title, description: c.description, position: c.position, assignees: c.assignees, labels: c.labels, dueDate: c.dueDate, createdBy: c.createdBy, createdAt: c.createdAt, updatedAt: c.updatedAt });
  const colOut = (c) => ({ id: c.id, boardId: c.boardId, name: c.name, position: c.position, wipLimit: c.wipLimit });
  const boardOut = (b) => ({
    id: b.id, name: b.name, description: b.description, ownerId: b.ownerId, createdAt: b.createdAt,
    members: b.members.map((m) => ({ userId: m.userId, username: db.users.find((u) => u.id === m.userId)?.username, role: m.role })),
    labels: db.labels.filter((l) => l.boardId === b.id).map(labelOut),
    columns: colsOf(b.id).map((c) => ({ ...colOut(c), cards: cardsOf(c.id).map(cardOut) })),
  });
  const labelOut = (l) => ({ id: l.id, boardId: l.boardId, name: l.name, color: l.color });

  const validName = (v, max, what = 'name') => {
    if (!isStr(v) || v.trim().length < 1 || v.length > max) throw bad(`${what} must be 1-${max} chars`);
  };
  const validWip = (v) => {
    if (v !== null && !(Number.isInteger(v) && v > 0)) throw bad('wipLimit must be positive integer or null');
  };
  const checkRefs = (b, assignees, labels) => {
    if (assignees !== undefined) {
      if (!Array.isArray(assignees) || assignees.some((a) => !isStr(a) || !roleOf(b, a))) throw bad('invalid assignees');
    }
    if (labels !== undefined) {
      if (!Array.isArray(labels) || labels.some((l) => !isStr(l) || !db.labels.some((x) => x.id === l && x.boardId === b.id))) throw bad('invalid labels');
    }
  };
  const insertCard = (card, col, position) => {
    const list = cardsOf(col.id).filter((c) => c !== card);
    let p = position === undefined || position === null ? list.length : Math.max(0, Math.min(position, list.length));
    list.splice(p, 0, card);
    card.columnId = col.id;
    list.forEach((c, i) => { c.position = i; });
  };
  const checkPos = (p) => { if (p !== undefined && p !== null && !Number.isInteger(p)) throw bad('position must be integer'); };

  // ---- routes
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
    if (!isStr(password) || password.length < 8) throw bad('password too short');
    if (displayName !== undefined && displayName !== null && (!isStr(displayName) || displayName.length > 100)) throw bad('invalid displayName');
    const un = username.toLowerCase();
    if (db.users.some((u) => u.username === un)) throw conflict('username taken');
    const { salt, hash } = hashPw(password);
    const u = { id: uid(), username: un, displayName: displayName || un, salt, hash };
    db.users.push(u);
    save();
    return [201, { user: pubUser(u) }];
  });
  route('POST', '/api/auth/login', false, ({ body }) => {
    if (!isObj(body) || !isStr(body.username) || !isStr(body.password)) throw bad('username and password required');
    const un = body.username.toLowerCase();
    const t = Date.now();
    const recent = (failures.get(un) || []).filter((x) => t - x < 15 * 60 * 1000);
    failures.set(un, recent);
    if (recent.length >= 5) throw new HttpError(429, 'rate_limited', 'too many failed attempts');
    const u = db.users.find((x) => x.username === un);
    let ok = false;
    if (u) {
      const h = crypto.scryptSync(body.password, u.salt, 32);
      ok = crypto.timingSafeEqual(h, Buffer.from(u.hash, 'hex'));
    }
    if (!ok) { recent.push(t); throw new HttpError(401, 'unauthorized', 'invalid credentials'); }
    const token = crypto.randomBytes(32).toString('hex');
    tokens.set(token, u.id);
    return [200, { token, user: pubUser(u) }];
  });
  route('POST', '/api/auth/logout', true, ({ token }) => { tokens.delete(token); return [204]; });
  route('GET', '/api/auth/me', true, ({ user }) => [200, { user: pubUser(user) }]);

  // boards
  route('POST', '/api/boards', true, ({ body, user }) => {
    if (!isObj(body)) throw bad('body required');
    validName(body.name, 100);
    if (body.description !== undefined && body.description !== null && !isStr(body.description)) throw bad('invalid description');
    let names = ['To Do', 'In Progress', 'Done'];
    if (body.columns !== undefined) {
      if (!Array.isArray(body.columns) || body.columns.some((n) => !isStr(n) || !n.trim() || n.length > 100)) throw bad('invalid columns');
      names = body.columns;
    }
    const b = { id: uid(), name: body.name, description: body.description || '', ownerId: user.id, createdAt: now(), members: [{ userId: user.id, role: 'owner' }] };
    db.boards.push(b);
    names.forEach((n, i) => db.columns.push({ id: uid(), boardId: b.id, name: n, position: i, wipLimit: null }));
    log(b.id, 'board.created', user.id, null, { name: b.name });
    names.forEach((n, i) => { const c = colsOf(b.id)[i]; log(b.id, 'column.created', user.id, null, { columnId: c.id, name: n }); });
    save();
    return [201, boardOut(b)];
  });
  route('GET', '/api/boards', true, ({ user }) => [200, db.boards.filter((b) => roleOf(b, user.id)).map((b) => ({ id: b.id, name: b.name, role: roleOf(b, user.id) }))]);
  route('GET', '/api/boards/:id', true, ({ user, params }) => {
    const b = getBoard(params.id); need(b, user, 'viewer'); return [200, boardOut(b)];
  });
  route('PATCH', '/api/boards/:id', true, ({ user, params, body }) => {
    const b = getBoard(params.id); need(b, user, 'owner');
    if (!isObj(body)) throw bad('body required');
    if (body.name !== undefined) validName(body.name, 100);
    if (body.description !== undefined && body.description !== null && !isStr(body.description)) throw bad('invalid description');
    if (body.name !== undefined) b.name = body.name;
    if (body.description !== undefined) b.description = body.description || '';
    save();
    return [200, boardOut(b)];
  });
  route('DELETE', '/api/boards/:id', true, ({ user, params }) => {
    const b = getBoard(params.id); need(b, user, 'owner');
    db.boards = db.boards.filter((x) => x !== b);
    db.columns = db.columns.filter((x) => x.boardId !== b.id);
    const cardIds = new Set(db.cards.filter((x) => x.boardId === b.id).map((x) => x.id));
    db.cards = db.cards.filter((x) => x.boardId !== b.id);
    db.labels = db.labels.filter((x) => x.boardId !== b.id);
    db.comments = db.comments.filter((x) => !cardIds.has(x.cardId));
    db.activity = db.activity.filter((x) => x.boardId !== b.id);
    save();
    return [204];
  });

  // members
  route('POST', '/api/boards/:id/members', true, ({ user, params, body }) => {
    const b = getBoard(params.id); need(b, user, 'owner');
    if (!isObj(body) || !isStr(body.username)) throw bad('username required');
    if (!['editor', 'viewer'].includes(body.role)) throw bad('invalid role');
    const u = db.users.find((x) => x.username === body.username.toLowerCase());
    if (!u) throw notFound('user not found');
    if (roleOf(b, u.id)) throw conflict('already a member');
    b.members.push({ userId: u.id, role: body.role });
    log(b.id, 'member.added', user.id, null, { userId: u.id, username: u.username, role: body.role });
    save();
    return [201, { userId: u.id, username: u.username, role: body.role }];
  });
  route('PATCH', '/api/boards/:id/members/:userId', true, ({ user, params, body }) => {
    const b = getBoard(params.id); need(b, user, 'owner');
    if (!isObj(body) || !['editor', 'viewer'].includes(body.role)) throw bad('invalid role');
    const m = b.members.find((x) => x.userId === params.userId);
    if (!m) throw notFound('member not found');
    if (m.role === 'owner') throw bad('cannot change owner role');
    m.role = body.role;
    save();
    const u = db.users.find((x) => x.id === m.userId);
    return [200, { userId: m.userId, username: u?.username, role: m.role }];
  });
  route('DELETE', '/api/boards/:id/members/:userId', true, ({ user, params }) => {
    const b = getBoard(params.id);
    const r = need(b, user, 'viewer');
    if (r !== 'owner' && params.userId !== user.id) throw forbidden('only owner can remove others');
    const m = b.members.find((x) => x.userId === params.userId);
    if (!m) throw notFound('member not found');
    if (m.role === 'owner') throw bad('cannot remove owner');
    b.members = b.members.filter((x) => x !== m);
    for (const c of db.cards) if (c.boardId === b.id) c.assignees = c.assignees.filter((a) => a !== m.userId);
    save();
    return [204];
  });

  // columns
  route('POST', '/api/boards/:id/columns', true, ({ user, params, body }) => {
    const b = getBoard(params.id); need(b, user, 'editor');
    if (!isObj(body)) throw bad('body required');
    validName(body.name, 100);
    if (body.wipLimit !== undefined) validWip(body.wipLimit);
    const c = { id: uid(), boardId: b.id, name: body.name, position: colsOf(b.id).length, wipLimit: body.wipLimit ?? null };
    db.columns.push(c);
    log(b.id, 'column.created', user.id, null, { columnId: c.id, name: c.name });
    save();
    return [201, colOut(c)];
  });
  route('PATCH', '/api/columns/:id', true, ({ user, params, body }) => {
    const c = getColumn(params.id); const b = getBoard(c.boardId); need(b, user, 'editor');
    if (!isObj(body)) throw bad('body required');
    if (body.name !== undefined) validName(body.name, 100);
    if (body.wipLimit !== undefined) validWip(body.wipLimit);
    if (body.position !== undefined && !Number.isInteger(body.position)) throw bad('invalid position');
    if (body.name !== undefined) c.name = body.name;
    if (body.wipLimit !== undefined) c.wipLimit = body.wipLimit;
    if (body.position !== undefined) {
      const list = colsOf(b.id).filter((x) => x !== c);
      list.splice(Math.max(0, Math.min(body.position, list.length)), 0, c);
      list.forEach((x, i) => { x.position = i; });
    }
    save();
    return [200, colOut(c)];
  });
  route('DELETE', '/api/columns/:id', true, ({ user, params, query }) => {
    const c = getColumn(params.id); const b = getBoard(c.boardId); need(b, user, 'editor');
    const cards = cardsOf(c.id);
    if (cards.length && query.get('force') !== 'true') throw conflict('column has cards');
    const ids = new Set(cards.map((x) => x.id));
    db.cards = db.cards.filter((x) => x.columnId !== c.id);
    db.comments = db.comments.filter((x) => !ids.has(x.cardId));
    for (const x of cards) log(b.id, 'card.deleted', user.id, x.id, { title: x.title, columnId: c.id });
    db.columns = db.columns.filter((x) => x !== c);
    compactBoard(b.id);
    save();
    return [204];
  });

  // cards
  route('POST', '/api/columns/:id/cards', true, ({ user, params, body }) => {
    const col = getColumn(params.id); const b = getBoard(col.boardId); need(b, user, 'editor');
    if (!isObj(body)) throw bad('body required');
    validName(body.title, 200, 'title');
    if (body.description !== undefined && body.description !== null && !isStr(body.description)) throw bad('invalid description');
    if (body.dueDate !== undefined && body.dueDate !== null && !validDate(body.dueDate)) throw bad('invalid dueDate');
    checkRefs(b, body.assignees, body.labels);
    checkPos(body.position);
    if (col.wipLimit && cardsOf(col.id).length >= col.wipLimit) throw conflict('WIP limit reached', 'wip_limit');
    const t = now();
    const card = { id: uid(), boardId: b.id, columnId: col.id, title: body.title, description: body.description || '', position: 0, assignees: [...new Set(body.assignees || [])], labels: [...new Set(body.labels || [])], dueDate: body.dueDate ?? null, createdBy: user.id, createdAt: t, updatedAt: t };
    db.cards.push(card);
    insertCard(card, col, body.position);
    log(b.id, 'card.created', user.id, card.id, { title: card.title, columnId: col.id });
    save();
    return [201, cardOut(card)];
  });
  route('GET', '/api/cards/:id', true, ({ user, params }) => {
    const c = getCard(params.id); need(getBoard(c.boardId), user, 'viewer'); return [200, cardOut(c)];
  });
  route('PATCH', '/api/cards/:id', true, ({ user, params, body }) => {
    const c = getCard(params.id); const b = getBoard(c.boardId); need(b, user, 'editor');
    if (!isObj(body)) throw bad('body required');
    if (body.title !== undefined) validName(body.title, 200, 'title');
    if (body.description !== undefined && body.description !== null && !isStr(body.description)) throw bad('invalid description');
    if (body.dueDate !== undefined && body.dueDate !== null && !validDate(body.dueDate)) throw bad('invalid dueDate');
    checkRefs(b, body.assignees, body.labels);
    const changed = [];
    for (const k of ['title', 'description', 'assignees', 'labels', 'dueDate']) {
      if (body[k] !== undefined) {
        c[k] = k === 'description' ? (body[k] || '') : (Array.isArray(body[k]) ? [...new Set(body[k])] : body[k]);
        changed.push(k);
      }
    }
    c.updatedAt = now();
    log(b.id, 'card.updated', user.id, c.id, { fields: changed });
    save();
    return [200, cardOut(c)];
  });
  route('DELETE', '/api/cards/:id', true, ({ user, params }) => {
    const c = getCard(params.id); const b = getBoard(c.boardId); need(b, user, 'editor');
    db.cards = db.cards.filter((x) => x !== c);
    db.comments = db.comments.filter((x) => x.cardId !== c.id);
    compactCol(c.columnId);
    log(b.id, 'card.deleted', user.id, c.id, { title: c.title, columnId: c.columnId });
    save();
    return [204];
  });
  route('POST', '/api/cards/:id/move', true, ({ user, params, body }) => {
    const c = getCard(params.id); const b = getBoard(c.boardId); need(b, user, 'editor');
    if (!isObj(body) || !isStr(body.columnId)) throw bad('columnId required');
    checkPos(body.position);
    const target = db.columns.find((x) => x.id === body.columnId);
    if (!target) throw notFound('column not found');
    if (target.boardId !== b.id) throw bad('column on different board');
    const from = c.columnId;
    if (from !== target.id && target.wipLimit && cardsOf(target.id).length >= target.wipLimit) throw conflict('WIP limit reached', 'wip_limit');
    insertCard(c, target, body.position);
    if (from !== target.id) compactCol(from);
    c.updatedAt = now();
    log(b.id, 'card.moved', user.id, c.id, { fromColumnId: from, toColumnId: target.id, position: c.position });
    save();
    return [200, cardOut(c)];
  });

  // labels
  route('POST', '/api/boards/:id/labels', true, ({ user, params, body }) => {
    const b = getBoard(params.id); need(b, user, 'editor');
    if (!isObj(body)) throw bad('body required');
    validName(body.name, 50);
    if (!isStr(body.color) || !/^#[0-9a-fA-F]{6}$/.test(body.color)) throw bad('invalid color');
    if (db.labels.some((l) => l.boardId === b.id && l.name.toLowerCase() === body.name.toLowerCase())) throw conflict('label exists');
    const l = { id: uid(), boardId: b.id, name: body.name, color: body.color };
    db.labels.push(l);
    save();
    return [201, labelOut(l)];
  });
  route('DELETE', '/api/labels/:id', true, ({ user, params }) => {
    const l = db.labels.find((x) => x.id === params.id);
    if (!l) throw notFound('label not found');
    need(getBoard(l.boardId), user, 'editor');
    db.labels = db.labels.filter((x) => x !== l);
    for (const c of db.cards) c.labels = c.labels.filter((x) => x !== l.id);
    save();
    return [204];
  });

  // comments
  route('POST', '/api/cards/:id/comments', true, ({ user, params, body }) => {
    const c = getCard(params.id); const b = getBoard(c.boardId); need(b, user, 'editor');
    if (!isObj(body) || !isStr(body.body) || body.body.length < 1 || body.body.length > 5000) throw bad('body must be 1-5000 chars');
    const m = { id: uid(), cardId: c.id, authorId: user.id, body: body.body, createdAt: now() };
    db.comments.push(m);
    log(b.id, 'comment.added', user.id, c.id, { commentId: m.id });
    save();
    return [201, m];
  });
  route('GET', '/api/cards/:id/comments', true, ({ user, params }) => {
    const c = getCard(params.id); need(getBoard(c.boardId), user, 'viewer');
    return [200, db.comments.filter((x) => x.cardId === c.id)];
  });
  route('DELETE', '/api/comments/:id', true, ({ user, params }) => {
    const m = db.comments.find((x) => x.id === params.id);
    if (!m) throw notFound('comment not found');
    const b = getBoard(getCard(m.cardId).boardId);
    const r = need(b, user, 'viewer');
    if (m.authorId !== user.id && r !== 'owner') throw forbidden('not allowed');
    db.comments = db.comments.filter((x) => x !== m);
    save();
    return [204];
  });

  // search + activity
  route('GET', '/api/boards/:id/cards', true, ({ user, params, query }) => {
    const b = getBoard(params.id); need(b, user, 'viewer');
    const q = query.get('q'); const as = query.get('assignee'); const lb = query.get('label'); const cl = query.get('column'); const db_ = query.get('due_before');
    if (db_ !== null && !validDate(db_)) throw bad('invalid due_before');
    const colPos = new Map(colsOf(b.id).map((c) => [c.id, c.position]));
    const res = db.cards.filter((c) => c.boardId === b.id).filter((c) =>
      (!q || c.title.toLowerCase().includes(q.toLowerCase()) || c.description.toLowerCase().includes(q.toLowerCase())) &&
      (!as || c.assignees.includes(as)) && (!lb || c.labels.includes(lb)) && (!cl || c.columnId === cl) &&
      (db_ === null || (c.dueDate && c.dueDate < db_)));
    res.sort((a, c) => colPos.get(a.columnId) - colPos.get(c.columnId) || a.position - c.position);
    return [200, res.map(cardOut)];
  });
  route('GET', '/api/boards/:id/activity', true, ({ user, params, query }) => {
    const b = getBoard(params.id); need(b, user, 'viewer');
    let limit = 50;
    if (query.has('limit')) {
      limit = Number(query.get('limit'));
      if (!Number.isInteger(limit) || limit < 1) throw bad('invalid limit');
    }
    const list = db.activity.filter((x) => x.boardId === b.id);
    return [200, list.slice().reverse().slice(0, limit)];
  });

  // ---- server
  const send = (res, status, data, headers = {}) => {
    if (data === undefined) { res.writeHead(status, headers); return res.end(); }
    const s = JSON.stringify(data);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s), ...headers });
    res.end(s);
  };

  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      try {
        const url = new URL(req.url, 'http://x');
        const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
        if (req.method === 'GET' && path === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          return res.end(HTML);
        }
        if (path.startsWith('/static/')) throw notFound();
        let matched = null; let params = {}; let pathMatched = false;
        for (const r of routes) {
          const m = r.re.exec(path);
          if (!m) continue;
          pathMatched = true;
          if (r.method !== req.method) continue;
          matched = r;
          r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
          break;
        }
        if (!matched) throw pathMatched ? new HttpError(405, 'method_not_allowed', 'method not allowed') : notFound('route not found');
        let user = null; let token = null;
        if (matched.auth) {
          const h = req.headers.authorization || '';
          const m = /^Bearer (.+)$/.exec(h);
          token = m ? m[1] : null;
          const uidv = token && tokens.get(token);
          user = uidv && db.users.find((u) => u.id === uidv);
          if (!user) throw new HttpError(401, 'unauthorized', 'authentication required');
        }
        let body;
        if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (raw.trim()) {
            try { body = JSON.parse(raw); } catch { throw bad('invalid JSON'); }
          }
        }
        const [status, data] = matched.fn({ user, token, params, body, query: url.searchParams });
        send(res, status, data);
      } catch (e) {
        if (e instanceof HttpError) return send(res, e.status, { error: e.error, message: e.message });
        console.error(e);
        send(res, 500, { error: 'internal', message: 'internal error' });
      }
    });
  });
}
