import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dir = path.dirname(fileURLToPath(import.meta.url));

class HttpError extends Error {
  constructor(status, error, message) { super(message || error); this.status = status; this.error = error; }
}
const bad = (m) => new HttpError(400, 'validation', m);
const forbidden = (m = 'forbidden') => new HttpError(403, 'forbidden', m);
const notFound = (m = 'not found') => new HttpError(404, 'not_found', m);
const conflict = (m, code = 'conflict') => new HttpError(409, code, m);

const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const isStr = (v) => typeof v === 'string';
const isDate = (v) => isStr(v) && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v + 'T00:00:00Z')) &&
  new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;

function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pw, salt, 32).toString('hex') };
}

export function createServer({ dataFile } = {}) {
  let db = { users: {}, boards: {}, columns: {}, cards: {}, labels: {}, comments: {}, activity: [] };
  if (dataFile && fs.existsSync(dataFile)) {
    try { db = { ...db, ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) }; } catch {}
  }
  const tokens = new Map();
  const fails = new Map(); // username -> [timestamps]

  function save() {
    if (!dataFile) return;
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, dataFile);
  }
  const pubUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName });

  function log(boardId, type, actorId, cardId, details = {}) {
    const e = { id: uid(), boardId, type, actorId, at: now(), details };
    if (cardId) e.cardId = cardId;
    db.activity.push(e);
  }

  // ---- helpers
  const colCards = (colId) => Object.values(db.cards).filter(c => c.columnId === colId).sort((a, b) => a.position - b.position);
  const boardCols = (bid) => Object.values(db.columns).filter(c => c.boardId === bid).sort((a, b) => a.position - b.position);
  const renum = (list) => list.forEach((x, i) => { x.position = i; });
  const clampPos = (p, n) => Math.max(0, Math.min(n, p));
  function checkPos(p) {
    if (!Number.isInteger(p)) throw bad('position must be an integer');
    return p;
  }

  function getBoard(id) { const b = db.boards[id]; if (!b) throw notFound('board not found'); return b; }
  const ROLE = { viewer: 1, editor: 2, owner: 3 };
  function access(user, board, min) {
    const m = board.members.find(m => m.userId === user.id);
    if (!m) throw forbidden('not a member of this board');
    if (ROLE[m.role] < ROLE[min]) throw forbidden('insufficient role');
    return m.role;
  }
  function getCol(id) { const c = db.columns[id]; if (!c) throw notFound('column not found'); return c; }
  function getCard(id) { const c = db.cards[id]; if (!c) throw notFound('card not found'); return c; }

  function validWip(v) {
    if (v === null) return null;
    if (!Number.isInteger(v) || v < 1) throw bad('wipLimit must be a positive integer or null');
    return v;
  }
  function validCardFields(board, b, partial) {
    const out = {};
    if (!partial || 'title' in b) {
      if (!isStr(b.title) || b.title.length < 1 || b.title.length > 200) throw bad('title must be 1-200 chars');
      out.title = b.title;
    }
    if ('description' in b) {
      if (b.description !== null && !isStr(b.description)) throw bad('description must be string');
      out.description = b.description ?? '';
    }
    if ('assignees' in b) {
      if (!Array.isArray(b.assignees) || !b.assignees.every(a => isStr(a) && board.members.some(m => m.userId === a))) throw bad('assignees must be board members');
      out.assignees = [...new Set(b.assignees)];
    }
    if ('labels' in b) {
      if (!Array.isArray(b.labels) || !b.labels.every(l => isStr(l) && db.labels[l] && db.labels[l].boardId === board.id)) throw bad('labels must belong to the board');
      out.labels = [...new Set(b.labels)];
    }
    if ('dueDate' in b) {
      if (b.dueDate !== null && !isDate(b.dueDate)) throw bad('dueDate must be YYYY-MM-DD or null');
      out.dueDate = b.dueDate;
    }
    return out;
  }
  function boardView(b) {
    return {
      id: b.id, name: b.name, description: b.description, ownerId: b.ownerId, createdAt: b.createdAt,
      members: b.members.map(m => ({ userId: m.userId, username: db.users[m.userId]?.username, role: m.role })),
      labels: Object.values(db.labels).filter(l => l.boardId === b.id),
      columns: boardCols(b.id).map(c => ({ id: c.id, name: c.name, position: c.position, wipLimit: c.wipLimit, cards: colCards(c.id) })),
    };
  }
  function deleteCardRecords(cardId) {
    delete db.cards[cardId];
    for (const [id, c] of Object.entries(db.comments)) if (c.cardId === cardId) delete db.comments[id];
  }

  // ---- routes
  const routes = [];
  const route = (method, pattern, opts, fn) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, auth: opts.auth !== false, fn });
  };
  const mut = { mutates: true };

  route('POST', '/api/auth/register', { auth: false }, ({ body }) => {
    let { username, password, displayName } = body;
    if (!isStr(username)) throw bad('username required');
    username = username.toLowerCase();
    if (!/^[a-z0-9_]{3,32}$/.test(username)) throw bad('invalid username');
    if (!isStr(password) || password.length < 8) throw bad('password must be at least 8 chars');
    if (displayName !== undefined && displayName !== null && (!isStr(displayName) || !displayName.trim())) throw bad('invalid displayName');
    if (Object.values(db.users).some(u => u.username === username)) throw conflict('username taken');
    const { salt, hash } = hashPw(password);
    const u = { id: uid(), username, displayName: displayName || username, salt, hash };
    db.users[u.id] = u;
    return [201, { user: pubUser(u) }, true];
  });

  route('POST', '/api/auth/login', { auth: false }, ({ body }) => {
    const { username, password } = body;
    if (!isStr(username) || !isStr(password)) throw bad('username and password required');
    const key = username.toLowerCase();
    const t = Date.now();
    const list = (fails.get(key) || []).filter(x => t - x < 15 * 60 * 1000);
    fails.set(key, list);
    if (list.length >= 5) throw new HttpError(429, 'rate_limited', 'too many failed attempts');
    const u = Object.values(db.users).find(u => u.username === key);
    let ok = false;
    if (u) {
      const h = Buffer.from(hashPw(password, u.salt).hash, 'hex');
      ok = crypto.timingSafeEqual(h, Buffer.from(u.hash, 'hex'));
    }
    if (!ok) { list.push(t); throw new HttpError(401, 'unauthorized', 'invalid credentials'); }
    fails.delete(key);
    const token = crypto.randomBytes(32).toString('hex');
    tokens.set(token, u.id);
    return [200, { token, user: pubUser(u) }];
  });

  route('POST', '/api/auth/logout', {}, ({ token }) => { tokens.delete(token); return [204]; });
  route('GET', '/api/auth/me', {}, ({ user }) => [200, { user: pubUser(user) }]);

  // boards
  route('POST', '/api/boards', {}, ({ user, body }) => {
    const { name, description, columns } = body;
    if (!isStr(name) || name.length < 1 || name.length > 100) throw bad('name must be 1-100 chars');
    if (description !== undefined && description !== null && !isStr(description)) throw bad('description must be string');
    let names = ['To Do', 'In Progress', 'Done'];
    if (columns !== undefined) {
      if (!Array.isArray(columns) || !columns.every(c => isStr(c) && c.length >= 1 && c.length <= 100)) throw bad('columns must be array of names');
      names = columns;
    }
    const b = { id: uid(), name, description: description || '', ownerId: user.id, createdAt: now(), members: [{ userId: user.id, role: 'owner' }] };
    db.boards[b.id] = b;
    log(b.id, 'board.created', user.id, null, { name });
    names.forEach((n, i) => {
      const c = { id: uid(), boardId: b.id, name: n, position: i, wipLimit: null };
      db.columns[c.id] = c;
      log(b.id, 'column.created', user.id, null, { columnId: c.id, name: n });
    });
    return [201, boardView(b), true];
  });
  route('GET', '/api/boards', {}, ({ user }) => [200, Object.values(db.boards)
    .filter(b => b.members.some(m => m.userId === user.id))
    .map(b => ({ id: b.id, name: b.name, role: b.members.find(m => m.userId === user.id).role }))]);
  route('GET', '/api/boards/:id', {}, ({ user, p }) => { const b = getBoard(p.id); access(user, b, 'viewer'); return [200, boardView(b)]; });
  route('PATCH', '/api/boards/:id', {}, ({ user, p, body }) => {
    const b = getBoard(p.id); access(user, b, 'owner');
    if ('name' in body && (!isStr(body.name) || body.name.length < 1 || body.name.length > 100)) throw bad('name must be 1-100 chars');
    if ('description' in body && body.description !== null && !isStr(body.description)) throw bad('description must be string');
    if ('name' in body) b.name = body.name;
    if ('description' in body) b.description = body.description ?? '';
    return [200, boardView(b), true];
  });
  route('DELETE', '/api/boards/:id', {}, ({ user, p }) => {
    const b = getBoard(p.id); access(user, b, 'owner');
    for (const c of Object.values(db.cards)) if (c.boardId === b.id) deleteCardRecords(c.id);
    for (const [id, c] of Object.entries(db.columns)) if (c.boardId === b.id) delete db.columns[id];
    for (const [id, l] of Object.entries(db.labels)) if (l.boardId === b.id) delete db.labels[id];
    db.activity = db.activity.filter(a => a.boardId !== b.id);
    delete db.boards[b.id];
    return [204, undefined, true];
  });

  // members
  route('POST', '/api/boards/:id/members', {}, ({ user, p, body }) => {
    const b = getBoard(p.id); access(user, b, 'owner');
    if (!isStr(body.username)) throw bad('username required');
    if (body.role !== 'editor' && body.role !== 'viewer') throw bad('role must be editor or viewer');
    const u = Object.values(db.users).find(u => u.username === body.username.toLowerCase());
    if (!u) throw notFound('user not found');
    if (b.members.some(m => m.userId === u.id)) throw conflict('already a member');
    b.members.push({ userId: u.id, role: body.role });
    log(b.id, 'member.added', user.id, null, { userId: u.id, role: body.role });
    return [201, { userId: u.id, username: u.username, role: body.role }, true];
  });
  route('PATCH', '/api/boards/:id/members/:uid', {}, ({ user, p, body }) => {
    const b = getBoard(p.id); access(user, b, 'owner');
    const m = b.members.find(m => m.userId === p.uid);
    if (!m) throw notFound('member not found');
    if (body.role !== 'editor' && body.role !== 'viewer') throw bad('role must be editor or viewer');
    if (m.role === 'owner') throw bad('cannot change owner role');
    m.role = body.role;
    return [200, { userId: m.userId, username: db.users[m.userId]?.username, role: m.role }, true];
  });
  route('DELETE', '/api/boards/:id/members/:uid', {}, ({ user, p }) => {
    const b = getBoard(p.id);
    if (p.uid === user.id) access(user, b, 'viewer'); else access(user, b, 'owner');
    const m = b.members.find(m => m.userId === p.uid);
    if (!m) throw notFound('member not found');
    if (m.role === 'owner') throw bad('cannot remove the owner');
    b.members = b.members.filter(x => x !== m);
    for (const c of Object.values(db.cards)) if (c.boardId === b.id) c.assignees = c.assignees.filter(a => a !== p.uid);
    return [204, undefined, true];
  });

  // columns
  route('POST', '/api/boards/:id/columns', {}, ({ user, p, body }) => {
    const b = getBoard(p.id); access(user, b, 'editor');
    if (!isStr(body.name) || body.name.length < 1 || body.name.length > 100) throw bad('name must be 1-100 chars');
    const wip = 'wipLimit' in body ? validWip(body.wipLimit) : null;
    const c = { id: uid(), boardId: b.id, name: body.name, position: boardCols(b.id).length, wipLimit: wip };
    db.columns[c.id] = c;
    log(b.id, 'column.created', user.id, null, { columnId: c.id, name: c.name });
    return [201, { ...c, cards: [] }, true];
  });
  route('PATCH', '/api/columns/:id', {}, ({ user, p, body }) => {
    const c = getCol(p.id); const b = getBoard(c.boardId); access(user, b, 'editor');
    if ('name' in body && (!isStr(body.name) || body.name.length < 1 || body.name.length > 100)) throw bad('name must be 1-100 chars');
    const wip = 'wipLimit' in body ? validWip(body.wipLimit) : undefined;
    if ('position' in body) checkPos(body.position);
    if ('name' in body) c.name = body.name;
    if (wip !== undefined) c.wipLimit = wip;
    if ('position' in body) {
      const list = boardCols(b.id).filter(x => x.id !== c.id);
      list.splice(clampPos(body.position, list.length), 0, c);
      renum(list);
    }
    return [200, { ...c, cards: colCards(c.id) }, true];
  });
  route('DELETE', '/api/columns/:id', {}, ({ user, p, query }) => {
    const c = getCol(p.id); const b = getBoard(c.boardId); access(user, b, 'editor');
    const cards = colCards(c.id);
    if (cards.length && query.get('force') !== 'true') throw conflict('column has cards');
    cards.forEach(x => deleteCardRecords(x.id));
    delete db.columns[c.id];
    renum(boardCols(b.id));
    return [204, undefined, true];
  });

  // cards
  route('POST', '/api/columns/:id/cards', {}, ({ user, p, body }) => {
    const col = getCol(p.id); const b = getBoard(col.boardId); access(user, b, 'editor');
    const f = validCardFields(b, body, false);
    if ('position' in body && body.position !== null) checkPos(body.position);
    const list = colCards(col.id);
    if (col.wipLimit && list.length >= col.wipLimit) throw conflict('WIP limit reached', 'wip_limit');
    const t = now();
    const card = {
      id: uid(), boardId: b.id, columnId: col.id, title: f.title, description: f.description ?? '', position: 0,
      assignees: f.assignees ?? [], labels: f.labels ?? [], dueDate: f.dueDate ?? null, createdBy: user.id, createdAt: t, updatedAt: t,
    };
    db.cards[card.id] = card;
    const pos = body.position == null ? list.length : clampPos(body.position, list.length);
    list.splice(pos, 0, card); renum(list);
    log(b.id, 'card.created', user.id, card.id, { title: card.title, columnId: col.id });
    return [201, card, true];
  });
  route('GET', '/api/cards/:id', {}, ({ user, p }) => { const c = getCard(p.id); access(user, getBoard(c.boardId), 'viewer'); return [200, c]; });
  route('PATCH', '/api/cards/:id', {}, ({ user, p, body }) => {
    const card = getCard(p.id); const b = getBoard(card.boardId); access(user, b, 'editor');
    const f = validCardFields(b, body, true);
    Object.assign(card, f); card.updatedAt = now();
    log(b.id, 'card.updated', user.id, card.id, { fields: Object.keys(f) });
    return [200, card, true];
  });
  route('DELETE', '/api/cards/:id', {}, ({ user, p }) => {
    const card = getCard(p.id); const b = getBoard(card.boardId); access(user, b, 'editor');
    deleteCardRecords(card.id);
    renum(colCards(card.columnId));
    log(b.id, 'card.deleted', user.id, card.id, { title: card.title, columnId: card.columnId });
    return [204, undefined, true];
  });
  route('POST', '/api/cards/:id/move', {}, ({ user, p, body }) => {
    const card = getCard(p.id); const b = getBoard(card.boardId); access(user, b, 'editor');
    if (!isStr(body.columnId)) throw bad('columnId required');
    const target = db.columns[body.columnId];
    if (!target || target.boardId !== b.id) throw bad('target column must be on the same board');
    if ('position' in body && body.position !== null) checkPos(body.position);
    const from = card.columnId;
    const same = from === target.id;
    const tlist = colCards(target.id).filter(x => x.id !== card.id);
    if (!same && target.wipLimit && tlist.length >= target.wipLimit) throw conflict('WIP limit reached', 'wip_limit');
    const slist = same ? null : colCards(from).filter(x => x.id !== card.id);
    const pos = body.position == null ? tlist.length : clampPos(body.position, tlist.length);
    card.columnId = target.id;
    tlist.splice(pos, 0, card); renum(tlist);
    if (slist) renum(slist);
    card.updatedAt = now();
    log(b.id, 'card.moved', user.id, card.id, { fromColumnId: from, toColumnId: target.id, position: card.position });
    return [200, card, true];
  });

  // labels
  route('POST', '/api/boards/:id/labels', {}, ({ user, p, body }) => {
    const b = getBoard(p.id); access(user, b, 'editor');
    if (!isStr(body.name) || body.name.trim().length < 1 || body.name.length > 100) throw bad('name required');
    if (!isStr(body.color) || !/^#[0-9a-fA-F]{6}$/.test(body.color)) throw bad('color must be #rrggbb');
    const lc = body.name.toLowerCase();
    if (Object.values(db.labels).some(l => l.boardId === b.id && l.name.toLowerCase() === lc)) throw conflict('label exists');
    const l = { id: uid(), boardId: b.id, name: body.name, color: body.color };
    db.labels[l.id] = l;
    return [201, l, true];
  });
  route('DELETE', '/api/labels/:id', {}, ({ user, p }) => {
    const l = db.labels[p.id]; if (!l) throw notFound('label not found');
    access(user, getBoard(l.boardId), 'editor');
    delete db.labels[l.id];
    for (const c of Object.values(db.cards)) if (c.boardId === l.boardId && c.labels.includes(l.id)) c.labels = c.labels.filter(x => x !== l.id);
    return [204, undefined, true];
  });

  // comments
  route('POST', '/api/cards/:id/comments', {}, ({ user, p, body }) => {
    const card = getCard(p.id); const b = getBoard(card.boardId); access(user, b, 'editor');
    if (!isStr(body.body) || body.body.length < 1 || body.body.length > 5000) throw bad('body must be 1-5000 chars');
    const c = { id: uid(), cardId: card.id, authorId: user.id, body: body.body, createdAt: now() };
    db.comments[c.id] = c;
    log(b.id, 'comment.added', user.id, card.id, { commentId: c.id });
    return [201, c, true];
  });
  route('GET', '/api/cards/:id/comments', {}, ({ user, p }) => {
    const card = getCard(p.id); access(user, getBoard(card.boardId), 'viewer');
    return [200, Object.values(db.comments).filter(c => c.cardId === card.id)];
  });
  route('DELETE', '/api/comments/:id', {}, ({ user, p }) => {
    const c = db.comments[p.id]; if (!c) throw notFound('comment not found');
    const b = getBoard(db.cards[c.cardId].boardId);
    access(user, b, 'viewer');
    if (c.authorId !== user.id && b.ownerId !== user.id) throw forbidden('only author or owner');
    delete db.comments[c.id];
    return [204, undefined, true];
  });

  // search
  route('GET', '/api/boards/:id/cards', {}, ({ user, p, query }) => {
    const b = getBoard(p.id); access(user, b, 'viewer');
    const q = query.get('q'), assignee = query.get('assignee'), label = query.get('label'), column = query.get('column'), due = query.get('due_before');
    if (due && !isDate(due)) throw bad('due_before must be YYYY-MM-DD');
    const out = [];
    for (const col of boardCols(b.id)) {
      if (column && col.id !== column) continue;
      for (const c of colCards(col.id)) {
        if (q && !(c.title.toLowerCase().includes(q.toLowerCase()) || (c.description || '').toLowerCase().includes(q.toLowerCase()))) continue;
        if (assignee && !c.assignees.includes(assignee)) continue;
        if (label && !c.labels.includes(label)) continue;
        if (due && !(c.dueDate && c.dueDate < due)) continue;
        out.push(c);
      }
    }
    return [200, out];
  });

  route('GET', '/api/boards/:id/activity', {}, ({ user, p, query }) => {
    const b = getBoard(p.id); access(user, b, 'viewer');
    let limit = 50;
    if (query.has('limit')) { limit = Number(query.get('limit')); if (!Number.isInteger(limit) || limit < 1) throw bad('invalid limit'); }
    const list = db.activity.filter(a => a.boardId === b.id).reverse().slice(0, limit);
    return [200, list];
  });

  // ---- dispatch
  function send(res, status, body, headers = {}) {
    if (body === undefined) { res.writeHead(status, headers); return res.end(); }
    const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(data);
  }
  const STATIC = { '/': ['index.html', 'text/html; charset=utf-8'], '/static/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/static/style.css': ['style.css', 'text/css; charset=utf-8'] };

  async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://x');
      const pathname = url.pathname;
      if (req.method === 'GET' && STATIC[pathname]) {
        const [f, type] = STATIC[pathname];
        return send(res, 200, fs.readFileSync(path.join(__dir, 'public', f)), { 'content-type': type });
      }
      if (!pathname.startsWith('/api/')) throw notFound('route not found');
      let match, params;
      let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== req.method) continue;
        match = r; params = {}; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        break;
      }
      if (!match) throw notFound(pathMatched ? 'method not allowed' : 'route not found');
      let user, token;
      if (match.auth) {
        const h = req.headers.authorization || '';
        const mm = /^Bearer (.+)$/.exec(h);
        token = mm && mm[1];
        const uidv = token && tokens.get(token);
        user = uidv && db.users[uidv];
        if (!user) throw new HttpError(401, 'unauthorized', 'missing or invalid token');
      }
      let body = {};
      if (['POST', 'PATCH', 'PUT'].includes(req.method)) {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const raw = Buffer.concat(chunks).toString('utf8');
        if (raw.trim()) {
          try { body = JSON.parse(raw); } catch { throw bad('invalid JSON'); }
          if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('body must be an object');
        }
      }
      const [status, out, changed] = match.fn({ user, token, p: params, body, query: url.searchParams });
      if (changed) save();
      send(res, status, out);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.error, message: e.message });
      console.error(e);
      send(res, 500, { error: 'internal', message: 'internal error' });
    }
  }

  return http.createServer(handle);
}
