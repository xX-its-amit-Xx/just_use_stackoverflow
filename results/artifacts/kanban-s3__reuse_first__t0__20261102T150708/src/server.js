import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { HTML } from './ui.js';

class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const bad = (m) => new HttpError(400, 'validation', m);
const notFound = (m = 'not found') => new HttpError(404, 'not_found', m);
const forbidden = (m = 'forbidden') => new HttpError(403, 'forbidden', m);
const conflict = (m, code = 'conflict') => new HttpError(409, code, m);
const RANK = { viewer: 1, editor: 2, owner: 3 };
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const isInt = (n) => Number.isInteger(n);
const isStr = (s) => typeof s === 'string';

function validDate(s) {
  if (!isStr(s) || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}

export function createServer({ dataFile } = {}) {
  let db = { users: [], boards: [], columns: [], cards: [], labels: [], comments: [], activity: [] };
  if (dataFile && fs.existsSync(dataFile)) {
    try { db = { ...db, ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) }; } catch { /* start empty */ }
  }
  const sessions = new Map(); // token -> userId
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
  const getBoard = (id) => db.boards.find((b) => b.id === id) || (() => { throw notFound('board not found'); })();
  const roleOf = (board, user) => board.members.find((m) => m.userId === user.id)?.role;
  function access(board, user, min = 'viewer') {
    const r = roleOf(board, user);
    if (!r) throw forbidden('not a board member');
    if (RANK[r] < RANK[min]) throw forbidden('insufficient role');
    return r;
  }
  const colsOf = (boardId) => db.columns.filter((c) => c.boardId === boardId).sort((a, b) => a.position - b.position);
  const cardsIn = (colId) => db.cards.filter((c) => c.columnId === colId).sort((a, b) => a.position - b.position);
  const renum = (list) => list.forEach((x, i) => { x.position = i; });
  const clampPos = (p, n) => Math.max(0, Math.min(p, n));
  function reqCol(id) {
    const c = db.columns.find((x) => x.id === id);
    if (!c) throw notFound('column not found');
    return c;
  }
  function reqCard(id) {
    const c = db.cards.find((x) => x.id === id);
    if (!c) throw notFound('card not found');
    return c;
  }
  const boardView = (b) => ({
    id: b.id, name: b.name, description: b.description, ownerId: b.ownerId, createdAt: b.createdAt,
    members: b.members.map((m) => ({ userId: m.userId, username: db.users.find((u) => u.id === m.userId)?.username, role: m.role })),
    labels: db.labels.filter((l) => l.boardId === b.id),
    columns: colsOf(b.id).map((c) => ({ id: c.id, name: c.name, position: c.position, wipLimit: c.wipLimit, cards: cardsIn(c.id) })),
  });

  // ---- validators
  function checkWip(col, excludeCard) {
    if (col.wipLimit != null && cardsIn(col.id).filter((c) => c.id !== excludeCard).length >= col.wipLimit)
      throw conflict('column WIP limit reached', 'wip_limit');
  }
  const checkWipField = (v) => {
    if (v !== null && !(isInt(v) && v > 0)) throw bad('wipLimit must be a positive integer or null');
  };
  function checkAssignees(board, a) {
    if (!Array.isArray(a) || a.some((x) => !isStr(x) || !board.members.some((m) => m.userId === x))) throw bad('assignees must be board members');
    return [...new Set(a)];
  }
  function checkLabels(board, l) {
    if (!Array.isArray(l) || l.some((x) => !db.labels.some((y) => y.id === x && y.boardId === board.id))) throw bad('labels must belong to the board');
    return [...new Set(l)];
  }
  const checkDue = (d) => { if (d !== null && !validDate(d)) throw bad('dueDate must be YYYY-MM-DD or null'); };
  const checkPos = (p) => { if (!isInt(p) || p < 0) throw bad('position must be a non-negative integer'); };
  const checkName = (n, max, what = 'name') => {
    if (!isStr(n) || n.trim().length < 1 || n.length > max) throw bad(`${what} must be 1-${max} chars`);
  };

  // ---- routes
  const routes = [];
  const route = (method, path, fn) => {
    const keys = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, fn });
  };

  // auth
  route('POST', '/api/auth/register', ({ body }) => {
    const { username, password, displayName } = body;
    if (!isStr(username) || !/^[a-z0-9_]{3,32}$/i.test(username)) throw bad('invalid username');
    if (!isStr(password) || password.length < 8) throw bad('password must be at least 8 chars');
    if (displayName !== undefined && (!isStr(displayName) || !displayName.trim())) throw bad('invalid displayName');
    const name = username.toLowerCase();
    if (db.users.some((u) => u.username === name)) throw conflict('username taken');
    const u = { id: uid(), username: name, displayName: displayName ?? name, password: hashPw(password), createdAt: now() };
    db.users.push(u);
    return [201, { user: pubUser(u) }];
  });
  route('POST', '/api/auth/login', ({ body }) => {
    const { username, password } = body;
    if (!isStr(username) || !isStr(password)) throw bad('username and password required');
    const name = username.toLowerCase();
    const t = Date.now();
    const recent = (failures.get(name) || []).filter((x) => t - x < 15 * 60 * 1000);
    failures.set(name, recent);
    if (recent.length >= 5) throw new HttpError(429, 'rate_limited', 'too many failed attempts');
    const u = db.users.find((x) => x.username === name);
    let ok = false;
    if (u) {
      const h = Buffer.from(hashPw(password, u.password.salt).hash, 'hex');
      ok = crypto.timingSafeEqual(h, Buffer.from(u.password.hash, 'hex'));
    }
    if (!ok) { recent.push(t); throw new HttpError(401, 'unauthorized', 'invalid credentials'); }
    failures.delete(name);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, u.id);
    return [200, { token, user: pubUser(u) }];
  });
  route('POST', '/api/auth/logout', ({ token }) => { sessions.delete(token); return [204]; });
  route('GET', '/api/auth/me', ({ user }) => [200, { user: pubUser(user) }]);

  // boards
  route('POST', '/api/boards', ({ body, user }) => {
    checkName(body.name, 100);
    if (body.description !== undefined && !isStr(body.description)) throw bad('invalid description');
    const names = body.columns ?? ['To Do', 'In Progress', 'Done'];
    if (!Array.isArray(names) || names.some((n) => !isStr(n) || !n.trim() || n.length > 100)) throw bad('invalid columns');
    const b = { id: uid(), name: body.name, description: body.description ?? '', ownerId: user.id, createdAt: now(), members: [{ userId: user.id, role: 'owner' }] };
    db.boards.push(b);
    log(b.id, 'board.created', user.id, null, { name: b.name });
    names.forEach((n, i) => {
      const c = { id: uid(), boardId: b.id, name: n, position: i, wipLimit: null };
      db.columns.push(c);
      log(b.id, 'column.created', user.id, null, { columnId: c.id, name: n });
    });
    return [201, boardView(b)];
  });
  route('GET', '/api/boards', ({ user }) => [200, db.boards.filter((b) => roleOf(b, user)).map((b) => ({ id: b.id, name: b.name, role: roleOf(b, user) }))]);
  route('GET', '/api/boards/:id', ({ p, user }) => { const b = getBoard(p.id); access(b, user); return [200, boardView(b)]; });
  route('PATCH', '/api/boards/:id', ({ p, body, user }) => {
    const b = getBoard(p.id); access(b, user, 'owner');
    if (body.name !== undefined) checkName(body.name, 100);
    if (body.description !== undefined && !isStr(body.description)) throw bad('invalid description');
    if (body.name !== undefined) b.name = body.name;
    if (body.description !== undefined) b.description = body.description;
    return [200, boardView(b)];
  });
  route('DELETE', '/api/boards/:id', ({ p, user }) => {
    const b = getBoard(p.id); access(b, user, 'owner');
    const cardIds = new Set(db.cards.filter((c) => c.boardId === b.id).map((c) => c.id));
    db.boards = db.boards.filter((x) => x !== b);
    db.columns = db.columns.filter((c) => c.boardId !== b.id);
    db.cards = db.cards.filter((c) => c.boardId !== b.id);
    db.labels = db.labels.filter((c) => c.boardId !== b.id);
    db.comments = db.comments.filter((c) => !cardIds.has(c.cardId));
    db.activity = db.activity.filter((c) => c.boardId !== b.id);
    return [204];
  });

  // members
  route('POST', '/api/boards/:id/members', ({ p, body, user }) => {
    const b = getBoard(p.id); access(b, user, 'owner');
    if (!isStr(body.username)) throw bad('username required');
    if (body.role !== 'editor' && body.role !== 'viewer') throw bad('role must be editor or viewer');
    const u = db.users.find((x) => x.username === body.username.toLowerCase());
    if (!u) throw notFound('user not found');
    if (roleOf(b, u)) throw conflict('already a member');
    b.members.push({ userId: u.id, role: body.role });
    log(b.id, 'member.added', user.id, null, { userId: u.id, role: body.role });
    return [201, { userId: u.id, username: u.username, role: body.role }];
  });
  route('PATCH', '/api/boards/:id/members/:userId', ({ p, body, user }) => {
    const b = getBoard(p.id); access(b, user, 'owner');
    if (body.role !== 'editor' && body.role !== 'viewer') throw bad('role must be editor or viewer');
    const m = b.members.find((x) => x.userId === p.userId);
    if (!m) throw notFound('member not found');
    if (m.role === 'owner') throw bad('cannot change owner role');
    m.role = body.role;
    return [200, { userId: m.userId, username: db.users.find((u) => u.id === m.userId)?.username, role: m.role }];
  });
  route('DELETE', '/api/boards/:id/members/:userId', ({ p, user }) => {
    const b = getBoard(p.id);
    access(b, user);
    if (user.id !== p.userId) access(b, user, 'owner');
    const m = b.members.find((x) => x.userId === p.userId);
    if (!m) throw notFound('member not found');
    if (m.role === 'owner') throw bad('cannot remove the owner');
    b.members = b.members.filter((x) => x !== m);
    for (const c of db.cards) if (c.boardId === b.id) c.assignees = c.assignees.filter((a) => a !== m.userId);
    return [204];
  });

  // columns
  route('POST', '/api/boards/:id/columns', ({ p, body, user }) => {
    const b = getBoard(p.id); access(b, user, 'editor');
    checkName(body.name, 100);
    const wip = body.wipLimit ?? null; checkWipField(wip);
    const c = { id: uid(), boardId: b.id, name: body.name, position: colsOf(b.id).length, wipLimit: wip };
    db.columns.push(c);
    log(b.id, 'column.created', user.id, null, { columnId: c.id, name: c.name });
    return [201, { ...c, cards: [] }];
  });
  route('PATCH', '/api/columns/:id', ({ p, body, user }) => {
    const c = reqCol(p.id); access(getBoard(c.boardId), user, 'editor');
    if (body.name !== undefined) checkName(body.name, 100);
    if (body.wipLimit !== undefined) checkWipField(body.wipLimit);
    if (body.position !== undefined) checkPos(body.position);
    if (body.name !== undefined) c.name = body.name;
    if (body.wipLimit !== undefined) c.wipLimit = body.wipLimit;
    if (body.position !== undefined) {
      const list = colsOf(c.boardId).filter((x) => x !== c);
      list.splice(clampPos(body.position, list.length), 0, c);
      renum(list);
    }
    return [200, { ...c }];
  });
  route('DELETE', '/api/columns/:id', ({ p, query, user }) => {
    const c = reqCol(p.id); access(getBoard(c.boardId), user, 'editor');
    const cards = cardsIn(c.id);
    if (cards.length && query.get('force') !== 'true') throw conflict('column still has cards');
    db.cards = db.cards.filter((x) => x.columnId !== c.id);
    const ids = new Set(cards.map((x) => x.id));
    db.comments = db.comments.filter((x) => !ids.has(x.cardId));
    db.columns = db.columns.filter((x) => x !== c);
    renum(colsOf(c.boardId));
    return [204];
  });

  // cards
  route('POST', '/api/columns/:id/cards', ({ p, body, user }) => {
    const col = reqCol(p.id); const b = getBoard(col.boardId); access(b, user, 'editor');
    checkName(body.title, 200, 'title');
    if (body.description !== undefined && !isStr(body.description)) throw bad('invalid description');
    const assignees = body.assignees === undefined ? [] : checkAssignees(b, body.assignees);
    const labels = body.labels === undefined ? [] : checkLabels(b, body.labels);
    const due = body.dueDate ?? null; checkDue(due);
    if (body.position !== undefined && body.position !== null) checkPos(body.position);
    checkWip(col);
    const list = cardsIn(col.id);
    const t = now();
    const card = { id: uid(), boardId: b.id, columnId: col.id, title: body.title, description: body.description ?? '', position: 0, assignees, labels, dueDate: due, createdBy: user.id, createdAt: t, updatedAt: t };
    db.cards.push(card);
    list.splice(body.position == null ? list.length : clampPos(body.position, list.length), 0, card);
    renum(list);
    log(b.id, 'card.created', user.id, card.id, { columnId: col.id, title: card.title });
    return [201, card];
  });
  route('GET', '/api/cards/:id', ({ p, user }) => { const c = reqCard(p.id); access(getBoard(c.boardId), user); return [200, c]; });
  route('PATCH', '/api/cards/:id', ({ p, body, user }) => {
    const card = reqCard(p.id); const b = getBoard(card.boardId); access(b, user, 'editor');
    if (body.title !== undefined) checkName(body.title, 200, 'title');
    if (body.description !== undefined && !isStr(body.description)) throw bad('invalid description');
    const a = body.assignees === undefined ? undefined : checkAssignees(b, body.assignees);
    const l = body.labels === undefined ? undefined : checkLabels(b, body.labels);
    if (body.dueDate !== undefined) checkDue(body.dueDate);
    const changed = [];
    for (const [k, v] of [['title', body.title], ['description', body.description], ['assignees', a], ['labels', l], ['dueDate', body.dueDate]])
      if (v !== undefined) { card[k] = v; changed.push(k); }
    card.updatedAt = now();
    log(b.id, 'card.updated', user.id, card.id, { fields: changed });
    return [200, card];
  });
  route('DELETE', '/api/cards/:id', ({ p, user }) => {
    const card = reqCard(p.id); const b = getBoard(card.boardId); access(b, user, 'editor');
    db.cards = db.cards.filter((x) => x !== card);
    db.comments = db.comments.filter((x) => x.cardId !== card.id);
    renum(cardsIn(card.columnId));
    log(b.id, 'card.deleted', user.id, card.id, { columnId: card.columnId, title: card.title });
    return [204];
  });
  route('POST', '/api/cards/:id/move', ({ p, body, user }) => {
    const card = reqCard(p.id); const b = getBoard(card.boardId); access(b, user, 'editor');
    if (!isStr(body.columnId)) throw bad('columnId required');
    const target = db.columns.find((c) => c.id === body.columnId);
    if (!target || target.boardId !== b.id) throw bad('target column must be on the same board');
    if (body.position !== undefined && body.position !== null) checkPos(body.position);
    const from = card.columnId;
    if (from !== target.id) checkWip(target);
    const src = cardsIn(from).filter((x) => x !== card);
    const dst = from === target.id ? src : cardsIn(target.id);
    dst.splice(body.position == null ? dst.length : clampPos(body.position, dst.length), 0, card);
    card.columnId = target.id;
    renum(src); renum(dst);
    card.updatedAt = now();
    log(b.id, 'card.moved', user.id, card.id, { fromColumnId: from, toColumnId: target.id, position: card.position });
    return [200, card];
  });

  // labels
  route('POST', '/api/boards/:id/labels', ({ p, body, user }) => {
    const b = getBoard(p.id); access(b, user, 'editor');
    checkName(body.name, 100);
    if (!isStr(body.color) || !/^#[0-9a-fA-F]{6}$/.test(body.color)) throw bad('color must be #rrggbb');
    if (db.labels.some((l) => l.boardId === b.id && l.name.toLowerCase() === body.name.toLowerCase())) throw conflict('label name exists');
    const l = { id: uid(), boardId: b.id, name: body.name, color: body.color };
    db.labels.push(l);
    return [201, l];
  });
  route('DELETE', '/api/labels/:id', ({ p, user }) => {
    const l = db.labels.find((x) => x.id === p.id);
    if (!l) throw notFound('label not found');
    access(getBoard(l.boardId), user, 'editor');
    db.labels = db.labels.filter((x) => x !== l);
    for (const c of db.cards) c.labels = c.labels.filter((x) => x !== l.id);
    return [204];
  });

  // comments
  route('POST', '/api/cards/:id/comments', ({ p, body, user }) => {
    const card = reqCard(p.id); const b = getBoard(card.boardId); access(b, user, 'editor');
    if (!isStr(body.body) || body.body.length < 1 || body.body.length > 5000) throw bad('body must be 1-5000 chars');
    const c = { id: uid(), cardId: card.id, authorId: user.id, body: body.body, createdAt: now() };
    db.comments.push(c);
    log(b.id, 'comment.added', user.id, card.id, { commentId: c.id });
    return [201, c];
  });
  route('GET', '/api/cards/:id/comments', ({ p, user }) => {
    const card = reqCard(p.id); access(getBoard(card.boardId), user);
    return [200, db.comments.filter((c) => c.cardId === card.id)];
  });
  route('DELETE', '/api/comments/:id', ({ p, user }) => {
    const c = db.comments.find((x) => x.id === p.id);
    if (!c) throw notFound('comment not found');
    const card = db.cards.find((x) => x.id === c.cardId);
    const b = getBoard(card.boardId); access(b, user);
    if (c.authorId !== user.id && b.ownerId !== user.id) throw forbidden('only author or owner');
    db.comments = db.comments.filter((x) => x !== c);
    return [204];
  });

  // search + activity
  route('GET', '/api/boards/:id/cards', ({ p, query, user }) => {
    const b = getBoard(p.id); access(b, user);
    const q = query.get('q')?.toLowerCase(), as = query.get('assignee'), lb = query.get('label'), col = query.get('column'), due = query.get('due_before');
    if (due && !validDate(due)) throw bad('due_before must be YYYY-MM-DD');
    const out = [];
    for (const c of colsOf(b.id)) {
      if (col && c.id !== col) continue;
      for (const k of cardsIn(c.id)) {
        if (q && !(k.title.toLowerCase().includes(q) || k.description.toLowerCase().includes(q))) continue;
        if (as && !k.assignees.includes(as)) continue;
        if (lb && !k.labels.includes(lb)) continue;
        if (due && !(k.dueDate && k.dueDate < due)) continue;
        out.push(k);
      }
    }
    return [200, out];
  });
  route('GET', '/api/boards/:id/activity', ({ p, query, user }) => {
    const b = getBoard(p.id); access(b, user);
    let limit = 50;
    if (query.has('limit')) {
      limit = Number(query.get('limit'));
      if (!isInt(limit) || limit < 1) throw bad('invalid limit');
    }
    return [200, db.activity.filter((a) => a.boardId === b.id).reverse().slice(0, limit)];
  });

  // ---- dispatch
  function send(res, status, body, headers = {}) {
    if (status === 204) { res.writeHead(204); return res.end(); }
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': typeof body === 'string' ? 'text/html; charset=utf-8' : 'application/json', ...headers });
    res.end(data);
  }

  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const url = new URL(req.url, 'http://x');
        const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
        if (req.method === 'GET' && path === '/') return send(res, 200, HTML);
        if (path.startsWith('/static/')) throw notFound();
        let match, params, pathMatched = false;
        for (const r of routes) {
          const m = r.re.exec(path);
          if (!m) continue;
          pathMatched = true;
          if (r.method !== req.method) continue;
          match = r; params = {};
          r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
          break;
        }
        if (!match) throw pathMatched ? new HttpError(405, 'method_not_allowed', 'method not allowed') : notFound('route not found');
        let user, token;
        const isPublic = path === '/api/auth/register' || path === '/api/auth/login';
        if (!isPublic) {
          const h = req.headers.authorization || '';
          token = /^Bearer (.+)$/i.exec(h)?.[1];
          const uidv = token && sessions.get(token);
          user = uidv && db.users.find((u) => u.id === uidv);
          if (!user) throw new HttpError(401, 'unauthorized', 'authentication required');
        }
        let body = {};
        if (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT') {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (raw.trim()) {
            try { body = JSON.parse(raw); } catch { throw bad('invalid JSON'); }
          }
          if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('body must be a JSON object');
        }
        const [status, out] = match.fn({ p: params, body, query: url.searchParams, user, token });
        if (req.method !== 'GET') save();
        send(res, status, out);
      } catch (e) {
        if (e instanceof HttpError) {
          if (req.method !== 'GET') { try { save(); } catch { /* ignore */ } }
          return send(res, e.status, { error: e.code, message: e.message });
        }
        console.error(e);
        send(res, 500, { error: 'internal', message: 'internal error' });
      }
    });
  });
}
