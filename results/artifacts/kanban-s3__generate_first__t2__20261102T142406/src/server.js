import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { UI_HTML } from './ui.js';

class HttpError extends Error {
  constructor(status, error, message) { super(message || error); this.status = status; this.error = error; }
}
const E = {
  bad: (m) => new HttpError(400, 'validation', m || 'invalid input'),
  unauth: () => new HttpError(401, 'unauthenticated', 'authentication required'),
  forbid: (m) => new HttpError(403, 'forbidden', m || 'forbidden'),
  nf: (m) => new HttpError(404, 'not_found', m || 'not found'),
  conflict: (m, code) => new HttpError(409, code || 'conflict', m || 'conflict'),
};

const id = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const isStr = (v) => typeof v === 'string';
const isDate = (v) => isStr(v) && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;

function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}

export function createServer({ dataFile } = {}) {
  let db = { users: {}, boards: {}, members: {}, columns: {}, cards: {}, labels: {}, comments: {}, activity: [] };
  if (dataFile && fs.existsSync(dataFile)) {
    try { db = { ...db, ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) }; } catch { /* ignore */ }
  }
  // members: { boardId: { userId: role } }
  const sessions = new Map();
  const fails = new Map();

  const save = () => {
    if (!dataFile) return;
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, dataFile);
  };

  const pubUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName });
  const log = (boardId, type, actorId, cardId, details = {}) => {
    const e = { id: id(), boardId, type, actorId, at: now(), details };
    if (cardId) e.cardId = cardId;
    db.activity.push(e);
  };

  // ---- helpers
  const getBoard = (bid, user, minRole) => {
    const b = db.boards[bid];
    if (!b) throw E.nf('board not found');
    const role = (db.members[bid] || {})[user.id];
    if (!role) throw E.forbid('not a member');
    if (minRole === 'editor' && role === 'viewer') throw E.forbid('editor role required');
    if (minRole === 'owner' && role !== 'owner') throw E.forbid('owner role required');
    return { b, role };
  };
  const colCards = (cid) => Object.values(db.cards).filter((c) => c.columnId === cid).sort((a, b) => a.position - b.position);
  const boardCols = (bid) => Object.values(db.columns).filter((c) => c.boardId === bid).sort((a, b) => a.position - b.position);
  const renumber = (arr) => arr.forEach((x, i) => { x.position = i; });
  const intOrNull = (v) => v === null || (Number.isInteger(v) && v > 0);
  const posOk = (v) => Number.isInteger(v);

  const checkCardRefs = (b, body, out) => {
    if (body.assignees !== undefined) {
      if (!Array.isArray(body.assignees) || !body.assignees.every((a) => isStr(a) && (db.members[b.id] || {})[a])) throw E.bad('assignees must be board members');
      out.assignees = [...new Set(body.assignees)];
    }
    if (body.labels !== undefined) {
      if (!Array.isArray(body.labels) || !body.labels.every((l) => isStr(l) && db.labels[l] && db.labels[l].boardId === b.id)) throw E.bad('labels must belong to board');
      out.labels = [...new Set(body.labels)];
    }
    if (body.dueDate !== undefined && body.dueDate !== null && !isDate(body.dueDate)) throw E.bad('dueDate must be YYYY-MM-DD');
    if (body.dueDate !== undefined) out.dueDate = body.dueDate;
    if (body.description !== undefined && !isStr(body.description)) throw E.bad('description must be string');
  };

  const boardView = (b) => ({
    id: b.id, name: b.name, description: b.description, ownerId: b.ownerId, createdAt: b.createdAt,
    members: Object.entries(db.members[b.id] || {}).map(([userId, role]) => ({ userId, username: db.users[userId]?.username, role })),
    labels: Object.values(db.labels).filter((l) => l.boardId === b.id),
    columns: boardCols(b.id).map((c) => ({ id: c.id, name: c.name, position: c.position, wipLimit: c.wipLimit, cards: colCards(c.id) })),
  });
  const colView = (c) => ({ id: c.id, boardId: c.boardId, name: c.name, position: c.position, wipLimit: c.wipLimit });

  // ---- routes
  const routes = [];
  const route = (method, path, auth, fn) => {
    const keys = [];
    const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, auth, fn });
  };

  // auth
  route('POST', '/api/auth/register', false, ({ body }) => {
    const { username, password } = body;
    if (!isStr(username) || !/^[a-z0-9_]{3,32}$/i.test(username)) throw E.bad('invalid username');
    if (!isStr(password) || password.length < 8) throw E.bad('password must be at least 8 chars');
    if (body.displayName !== undefined && (!isStr(body.displayName) || !body.displayName.trim())) throw E.bad('invalid displayName');
    const uname = username.toLowerCase();
    if (Object.values(db.users).some((u) => u.username === uname)) throw E.conflict('username taken');
    const { salt, hash } = hashPw(password);
    const u = { id: id(), username: uname, displayName: body.displayName ?? uname, salt, hash };
    db.users[u.id] = u;
    save();
    return [201, { user: pubUser(u) }];
  });
  route('POST', '/api/auth/login', false, ({ body }) => {
    const { username, password } = body;
    if (!isStr(username) || !isStr(password)) throw E.bad('username and password required');
    const uname = username.toLowerCase();
    const t = Date.now();
    const list = (fails.get(uname) || []).filter((x) => t - x < 15 * 60 * 1000);
    fails.set(uname, list);
    if (list.length >= 5) throw new HttpError(429, 'rate_limited', 'too many failed attempts');
    const u = Object.values(db.users).find((x) => x.username === uname);
    let ok = false;
    if (u) {
      const h = crypto.scryptSync(password, u.salt, 64);
      ok = crypto.timingSafeEqual(h, Buffer.from(u.hash, 'hex'));
    }
    if (!ok) { list.push(t); throw new HttpError(401, 'unauthenticated', 'invalid credentials'); }
    fails.delete(uname);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, u.id);
    return [200, { token, user: pubUser(u) }];
  });
  route('POST', '/api/auth/logout', true, ({ token }) => { sessions.delete(token); return [204]; });
  route('GET', '/api/auth/me', true, ({ user }) => [200, { user: pubUser(user) }]);

  // boards
  route('POST', '/api/boards', true, ({ body, user }) => {
    if (!isStr(body.name) || body.name.length < 1 || body.name.length > 100) throw E.bad('name 1-100 chars');
    if (body.description !== undefined && !isStr(body.description)) throw E.bad('description must be string');
    let cols = ['To Do', 'In Progress', 'Done'];
    if (body.columns !== undefined) {
      if (!Array.isArray(body.columns) || !body.columns.every((c) => isStr(c) && c.length >= 1 && c.length <= 100)) throw E.bad('columns must be array of names');
      cols = body.columns;
    }
    const b = { id: id(), name: body.name, description: body.description ?? '', ownerId: user.id, createdAt: now() };
    db.boards[b.id] = b;
    db.members[b.id] = { [user.id]: 'owner' };
    cols.forEach((name, i) => { const c = { id: id(), boardId: b.id, name, position: i, wipLimit: null }; db.columns[c.id] = c; });
    log(b.id, 'board.created', user.id, null, { name: b.name });
    save();
    return [201, boardView(b)];
  });
  route('GET', '/api/boards', true, ({ user }) => [200, Object.values(db.boards)
    .filter((b) => (db.members[b.id] || {})[user.id])
    .map((b) => ({ id: b.id, name: b.name, role: db.members[b.id][user.id] }))]);
  route('GET', '/api/boards/:id', true, ({ params, user }) => [200, boardView(getBoard(params.id, user).b)]);
  route('PATCH', '/api/boards/:id', true, ({ params, user, body }) => {
    const { b } = getBoard(params.id, user, 'owner');
    if (body.name !== undefined && (!isStr(body.name) || body.name.length < 1 || body.name.length > 100)) throw E.bad('name 1-100 chars');
    if (body.description !== undefined && !isStr(body.description)) throw E.bad('description must be string');
    if (body.name !== undefined) b.name = body.name;
    if (body.description !== undefined) b.description = body.description;
    save();
    return [200, boardView(b)];
  });
  route('DELETE', '/api/boards/:id', true, ({ params, user }) => {
    const { b } = getBoard(params.id, user, 'owner');
    for (const k of ['columns', 'cards', 'labels']) for (const x of Object.values(db[k])) if (x.boardId === b.id) delete db[k][x.id];
    for (const cm of Object.values(db.comments)) if (!db.cards[cm.cardId]) delete db.comments[cm.id];
    db.activity = db.activity.filter((a) => a.boardId !== b.id);
    delete db.members[b.id]; delete db.boards[b.id];
    save();
    return [204];
  });
  route('POST', '/api/boards/:id/members', true, ({ params, user, body }) => {
    const { b } = getBoard(params.id, user, 'owner');
    if (!isStr(body.username)) throw E.bad('username required');
    if (!['editor', 'viewer'].includes(body.role)) throw E.bad('role must be editor or viewer');
    const u = Object.values(db.users).find((x) => x.username === body.username.toLowerCase());
    if (!u) throw E.nf('user not found');
    if (db.members[b.id][u.id]) throw E.conflict('already a member');
    db.members[b.id][u.id] = body.role;
    log(b.id, 'member.added', user.id, null, { userId: u.id, role: body.role });
    save();
    return [201, { userId: u.id, username: u.username, role: body.role }];
  });
  route('PATCH', '/api/boards/:id/members/:uid', true, ({ params, user, body }) => {
    const { b } = getBoard(params.id, user, 'owner');
    if (!['editor', 'viewer'].includes(body.role)) throw E.bad('role must be editor or viewer');
    const cur = db.members[b.id][params.uid];
    if (!cur) throw E.nf('member not found');
    if (cur === 'owner') throw E.bad('cannot change owner role');
    db.members[b.id][params.uid] = body.role;
    save();
    return [200, { userId: params.uid, username: db.users[params.uid]?.username, role: body.role }];
  });
  route('DELETE', '/api/boards/:id/members/:uid', true, ({ params, user }) => {
    const { b, role } = getBoard(params.id, user);
    if (role !== 'owner' && params.uid !== user.id) throw E.forbid('owner role required');
    const cur = db.members[b.id][params.uid];
    if (!cur) throw E.nf('member not found');
    if (cur === 'owner') throw E.bad('cannot remove owner');
    delete db.members[b.id][params.uid];
    for (const c of Object.values(db.cards)) if (c.boardId === b.id) c.assignees = c.assignees.filter((a) => a !== params.uid);
    save();
    return [204];
  });

  // columns
  route('POST', '/api/boards/:id/columns', true, ({ params, user, body }) => {
    const { b } = getBoard(params.id, user, 'editor');
    if (!isStr(body.name) || body.name.length < 1 || body.name.length > 100) throw E.bad('name 1-100 chars');
    if (body.wipLimit !== undefined && !intOrNull(body.wipLimit)) throw E.bad('wipLimit must be positive integer or null');
    const c = { id: id(), boardId: b.id, name: body.name, position: boardCols(b.id).length, wipLimit: body.wipLimit ?? null };
    db.columns[c.id] = c;
    log(b.id, 'column.created', user.id, null, { columnId: c.id, name: c.name });
    save();
    return [201, colView(c)];
  });
  const getCol = (cid, user, min) => {
    const c = db.columns[cid];
    if (!c) throw E.nf('column not found');
    return { c, ...getBoard(c.boardId, user, min) };
  };
  route('PATCH', '/api/columns/:id', true, ({ params, user, body }) => {
    const { c, b } = getCol(params.id, user, 'editor');
    if (body.name !== undefined && (!isStr(body.name) || body.name.length < 1 || body.name.length > 100)) throw E.bad('name 1-100 chars');
    if (body.wipLimit !== undefined && !intOrNull(body.wipLimit)) throw E.bad('wipLimit must be positive integer or null');
    if (body.position !== undefined && !posOk(body.position)) throw E.bad('position must be integer');
    if (body.name !== undefined) c.name = body.name;
    if (body.wipLimit !== undefined) c.wipLimit = body.wipLimit;
    if (body.position !== undefined) {
      const cols = boardCols(b.id).filter((x) => x.id !== c.id);
      cols.splice(Math.max(0, Math.min(body.position, cols.length)), 0, c);
      renumber(cols);
    }
    save();
    return [200, colView(c)];
  });
  route('DELETE', '/api/columns/:id', true, ({ params, user, query }) => {
    const { c, b } = getCol(params.id, user, 'editor');
    const cards = colCards(c.id);
    if (cards.length && query.get('force') !== 'true') throw E.conflict('column has cards');
    for (const cd of cards) { delete db.cards[cd.id]; for (const cm of Object.values(db.comments)) if (cm.cardId === cd.id) delete db.comments[cm.id]; }
    delete db.columns[c.id];
    renumber(boardCols(b.id));
    save();
    return [204];
  });

  // cards
  const getCard = (cid, user, min) => {
    const c = db.cards[cid];
    if (!c) throw E.nf('card not found');
    return { card: c, ...getBoard(c.boardId, user, min) };
  };
  route('POST', '/api/columns/:id/cards', true, ({ params, user, body }) => {
    const { c, b } = getCol(params.id, user, 'editor');
    if (!isStr(body.title) || body.title.length < 1 || body.title.length > 200) throw E.bad('title 1-200 chars');
    const extra = {};
    checkCardRefs(b, body, extra);
    if (body.position !== undefined && !posOk(body.position)) throw E.bad('position must be integer');
    const cards = colCards(c.id);
    if (c.wipLimit != null && cards.length >= c.wipLimit) throw E.conflict('WIP limit reached', 'wip_limit');
    const t = now();
    const card = { id: id(), boardId: b.id, columnId: c.id, title: body.title, description: body.description ?? '', position: 0,
      assignees: extra.assignees ?? [], labels: extra.labels ?? [], dueDate: extra.dueDate ?? null, createdBy: user.id, createdAt: t, updatedAt: t };
    db.cards[card.id] = card;
    cards.splice(body.position === undefined ? cards.length : Math.max(0, Math.min(body.position, cards.length)), 0, card);
    renumber(cards);
    log(b.id, 'card.created', user.id, card.id, { title: card.title, columnId: c.id });
    save();
    return [201, card];
  });
  route('GET', '/api/cards/:id', true, ({ params, user }) => [200, getCard(params.id, user).card]);
  route('PATCH', '/api/cards/:id', true, ({ params, user, body }) => {
    const { card, b } = getCard(params.id, user, 'editor');
    if (body.title !== undefined && (!isStr(body.title) || body.title.length < 1 || body.title.length > 200)) throw E.bad('title 1-200 chars');
    const extra = {};
    checkCardRefs(b, body, extra);
    const changed = [];
    if (body.title !== undefined) { card.title = body.title; changed.push('title'); }
    if (body.description !== undefined) { card.description = body.description; changed.push('description'); }
    for (const k of ['assignees', 'labels', 'dueDate']) if (k in extra) { card[k] = extra[k]; changed.push(k); }
    card.updatedAt = now();
    log(b.id, 'card.updated', user.id, card.id, { fields: changed });
    save();
    return [200, card];
  });
  route('DELETE', '/api/cards/:id', true, ({ params, user }) => {
    const { card, b } = getCard(params.id, user, 'editor');
    delete db.cards[card.id];
    for (const cm of Object.values(db.comments)) if (cm.cardId === card.id) delete db.comments[cm.id];
    renumber(colCards(card.columnId));
    log(b.id, 'card.deleted', user.id, card.id, { title: card.title });
    save();
    return [204];
  });
  route('POST', '/api/cards/:id/move', true, ({ params, user, body }) => {
    const { card, b } = getCard(params.id, user, 'editor');
    if (!isStr(body.columnId)) throw E.bad('columnId required');
    if (body.position !== undefined && !posOk(body.position)) throw E.bad('position must be integer');
    const target = db.columns[body.columnId];
    if (!target || target.boardId !== b.id) throw E.bad('target column must be on the same board');
    const from = card.columnId;
    const same = from === target.id;
    if (!same && target.wipLimit != null && colCards(target.id).length >= target.wipLimit) throw E.conflict('WIP limit reached', 'wip_limit');
    const src = colCards(from).filter((x) => x.id !== card.id);
    const dst = same ? src : colCards(target.id);
    dst.splice(body.position === undefined ? dst.length : Math.max(0, Math.min(body.position, dst.length)), 0, card);
    card.columnId = target.id;
    renumber(src); renumber(dst);
    card.updatedAt = now();
    log(b.id, 'card.moved', user.id, card.id, { fromColumnId: from, toColumnId: target.id, position: card.position });
    save();
    return [200, card];
  });

  // labels
  route('POST', '/api/boards/:id/labels', true, ({ params, user, body }) => {
    const { b } = getBoard(params.id, user, 'editor');
    if (!isStr(body.name) || !body.name.trim() || body.name.length > 100) throw E.bad('invalid name');
    if (!isStr(body.color) || !/^#[0-9a-fA-F]{6}$/.test(body.color)) throw E.bad('color must be #rrggbb');
    if (Object.values(db.labels).some((l) => l.boardId === b.id && l.name.toLowerCase() === body.name.toLowerCase())) throw E.conflict('label exists');
    const l = { id: id(), boardId: b.id, name: body.name, color: body.color };
    db.labels[l.id] = l;
    save();
    return [201, l];
  });
  route('DELETE', '/api/labels/:id', true, ({ params, user }) => {
    const l = db.labels[params.id];
    if (!l) throw E.nf('label not found');
    getBoard(l.boardId, user, 'editor');
    delete db.labels[l.id];
    for (const c of Object.values(db.cards)) if (c.boardId === l.boardId) c.labels = c.labels.filter((x) => x !== l.id);
    save();
    return [204];
  });

  // comments
  route('POST', '/api/cards/:id/comments', true, ({ params, user, body }) => {
    const { card, b } = getCard(params.id, user, 'editor');
    if (!isStr(body.body) || body.body.length < 1 || body.body.length > 5000) throw E.bad('body 1-5000 chars');
    const cm = { id: id(), cardId: card.id, authorId: user.id, body: body.body, createdAt: now() };
    db.comments[cm.id] = cm;
    log(b.id, 'comment.added', user.id, card.id, { commentId: cm.id });
    save();
    return [201, cm];
  });
  route('GET', '/api/cards/:id/comments', true, ({ params, user }) => {
    const { card } = getCard(params.id, user);
    return [200, Object.values(db.comments).filter((c) => c.cardId === card.id)];
  });
  route('DELETE', '/api/comments/:id', true, ({ params, user }) => {
    const cm = db.comments[params.id];
    if (!cm) throw E.nf('comment not found');
    const card = db.cards[cm.cardId];
    const { role } = getBoard(card.boardId, user);
    if (cm.authorId !== user.id && role !== 'owner') throw E.forbid('not allowed');
    delete db.comments[cm.id];
    save();
    return [204];
  });

  // search & activity
  route('GET', '/api/boards/:id/cards', true, ({ params, user, query }) => {
    const { b } = getBoard(params.id, user);
    const q = (query.get('q') || '').toLowerCase();
    const assignee = query.get('assignee'), label = query.get('label'), column = query.get('column'), due = query.get('due_before');
    if (due && !isDate(due)) throw E.bad('due_before must be YYYY-MM-DD');
    const out = [];
    for (const col of boardCols(b.id)) {
      if (column && col.id !== column) continue;
      for (const c of colCards(col.id)) {
        if (q && !(c.title.toLowerCase().includes(q) || (c.description || '').toLowerCase().includes(q))) continue;
        if (assignee && !c.assignees.includes(assignee)) continue;
        if (label && !c.labels.includes(label)) continue;
        if (due && !(c.dueDate && c.dueDate < due)) continue;
        out.push(c);
      }
    }
    return [200, out];
  });
  route('GET', '/api/boards/:id/activity', true, ({ params, user, query }) => {
    const { b } = getBoard(params.id, user);
    let limit = 50;
    if (query.has('limit')) {
      limit = Number(query.get('limit'));
      if (!Number.isInteger(limit) || limit < 1) throw E.bad('invalid limit');
    }
    const items = db.activity.filter((a) => a.boardId === b.id);
    return [200, items.reverse().slice(0, limit)];
  });

  // ---- server
  const send = (res, status, obj, headers = {}) => {
    if (status === 204) { res.writeHead(204); return res.end(); }
    const s = JSON.stringify(obj);
    res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s), ...headers });
    res.end(s);
  };

  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      try {
        const url = new URL(req.url, 'http://x');
        const p = url.pathname;
        if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          return res.end(UI_HTML);
        }
        let match = null, params = {};
        let pathMatched = false;
        for (const r of routes) {
          const m = r.re.exec(p);
          if (!m) continue;
          pathMatched = true;
          if (r.method !== req.method) continue;
          match = r;
          r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
          break;
        }
        if (!match) throw pathMatched ? new HttpError(405, 'method_not_allowed', 'method not allowed') : E.nf('route not found');
        let user = null, token = null;
        if (match.auth) {
          const h = req.headers.authorization || '';
          const mm = /^Bearer (.+)$/.exec(h);
          token = mm && mm[1];
          const uid = token && sessions.get(token);
          user = uid && db.users[uid];
          if (!user) throw E.unauth();
        }
        let body = {};
        if (chunks.length && (req.method === 'POST' || req.method === 'PATCH' || req.method === 'PUT')) {
          const raw = Buffer.concat(chunks).toString('utf8');
          if (raw.trim()) {
            try { body = JSON.parse(raw); } catch { throw E.bad('invalid JSON'); }
            if (body === null || typeof body !== 'object' || Array.isArray(body)) throw E.bad('body must be an object');
          }
        }
        const [status, out] = match.fn({ params, query: url.searchParams, body, user, token });
        send(res, status, out);
      } catch (e) {
        if (e instanceof HttpError) send(res, e.status, { error: e.error, message: e.message });
        else { console.error(e); send(res, 500, { error: 'internal', message: 'internal error' }); }
      }
    });
  });
}
