import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { HTML } from './ui.js';

class HttpError extends Error { constructor(status, error, message) { super(message || error); this.status = status; this.error = error; } }
const E = (s, e, m) => new HttpError(s, e, m);
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const isStr = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max;
const isDate = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;

export function createServer({ dataFile } = {}) {
  let db = { users: [], boards: [], members: [], columns: [], cards: [], labels: [], comments: [], activity: [] };
  if (dataFile && fs.existsSync(dataFile)) {
    try { db = { ...db, ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) }; } catch {}
  }
  const save = () => { if (dataFile) { const t = dataFile + '.tmp'; fs.writeFileSync(t, JSON.stringify(db)); fs.renameSync(t, dataFile); } };
  const sessions = new Map();
  const fails = new Map();

  const pub = u => ({ id: u.id, username: u.username, displayName: u.displayName });
  const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
  const log = (boardId, type, actorId, cardId, details = {}) => {
    const e = { id: uid(), boardId, type, actorId, at: now(), details }; if (cardId) e.cardId = cardId; db.activity.push(e);
  };
  const roleOf = (boardId, userId) => db.members.find(m => m.boardId === boardId && m.userId === userId)?.role;
  const getBoard = id => db.boards.find(b => b.id === id) || (() => { throw E(404, 'not_found', 'board not found'); })();
  const need = (boardId, user, level) => {
    const r = roleOf(boardId, user.id);
    if (!r) throw E(403, 'forbidden', 'not a member');
    const rank = { viewer: 1, editor: 2, owner: 3 };
    if (rank[r] < rank[level]) throw E(403, 'forbidden', 'insufficient role');
    return r;
  };
  const colsOf = bid => db.columns.filter(c => c.boardId === bid).sort((a, b) => a.position - b.position);
  const cardsOf = cid => db.cards.filter(c => c.columnId === cid).sort((a, b) => a.position - b.position);
  const compact = arr => arr.forEach((x, i) => { x.position = i; });
  const findCol = id => db.columns.find(c => c.id === id) || (() => { throw E(404, 'not_found', 'column not found'); })();
  const findCard = id => db.cards.find(c => c.id === id) || (() => { throw E(404, 'not_found', 'card not found'); })();
  const clampPos = (p, n) => Math.max(0, Math.min(n, p));
  const isPos = p => Number.isInteger(p);

  const boardView = b => ({
    id: b.id, name: b.name, description: b.description, ownerId: b.ownerId, createdAt: b.createdAt,
    members: db.members.filter(m => m.boardId === b.id).map(m => ({ userId: m.userId, username: db.users.find(u => u.id === m.userId)?.username, role: m.role })),
    labels: db.labels.filter(l => l.boardId === b.id),
    columns: colsOf(b.id).map(c => ({ id: c.id, name: c.name, position: c.position, wipLimit: c.wipLimit, cards: cardsOf(c.id) })),
  });
  const validWip = w => w === null || (Number.isInteger(w) && w > 0);
  const validCardRefs = (boardId, assignees, labels) => {
    if (assignees !== undefined) {
      if (!Array.isArray(assignees) || !assignees.every(a => typeof a === 'string' && roleOf(boardId, a))) throw E(400, 'validation', 'invalid assignees');
    }
    if (labels !== undefined) {
      if (!Array.isArray(labels) || !labels.every(l => typeof l === 'string' && db.labels.some(x => x.id === l && x.boardId === boardId))) throw E(400, 'validation', 'invalid labels');
    }
  };
  const uniq = a => [...new Set(a)];

  // returns {handler} routes
  const routes = [];
  const route = (method, path, fn, open) => routes.push({ method, re: new RegExp('^' + path.replace(/:\w+/g, '([^/]+)') + '$'), fn, open });

  route('POST', '/api/auth/register', ({ body }) => {
    const { username, password } = body; let { displayName } = body;
    if (typeof username !== 'string' || !/^[A-Za-z0-9_]{3,32}$/.test(username)) throw E(400, 'validation', 'invalid username');
    if (typeof password !== 'string' || password.length < 8) throw E(400, 'validation', 'password too short');
    if (displayName !== undefined && !isStr(displayName, 1, 100)) throw E(400, 'validation', 'invalid displayName');
    const un = username.toLowerCase();
    if (db.users.some(u => u.username === un)) throw E(409, 'conflict', 'username taken');
    const salt = crypto.randomBytes(16).toString('hex');
    const u = { id: uid(), username: un, displayName: displayName || un, salt, hash: hashPw(password, salt) };
    db.users.push(u); save();
    return [201, { user: pub(u) }];
  }, true);
  route('POST', '/api/auth/login', ({ body }) => {
    const { username, password } = body;
    if (typeof username !== 'string' || typeof password !== 'string') throw E(400, 'validation', 'username and password required');
    const un = username.toLowerCase(); const t = Date.now();
    const f = (fails.get(un) || []).filter(x => t - x < 15 * 60000);
    fails.set(un, f);
    if (f.length >= 5) throw E(429, 'rate_limited', 'too many attempts');
    const u = db.users.find(x => x.username === un);
    let ok = false;
    if (u) { const a = Buffer.from(hashPw(password, u.salt), 'hex'), b = Buffer.from(u.hash, 'hex'); ok = crypto.timingSafeEqual(a, b); }
    if (!ok) { f.push(t); throw E(401, 'unauthorized', 'invalid credentials'); }
    fails.delete(un);
    const token = crypto.randomBytes(32).toString('hex'); sessions.set(token, u.id);
    return [200, { token, user: pub(u) }];
  }, true);
  route('POST', '/api/auth/logout', ({ token }) => { sessions.delete(token); return [204]; });
  route('GET', '/api/auth/me', ({ user }) => [200, { user: pub(user) }]);

  route('POST', '/api/boards', ({ body, user }) => {
    const { name, description, columns } = body;
    if (!isStr(name, 1, 100)) throw E(400, 'validation', 'invalid name');
    if (description !== undefined && description !== null && typeof description !== 'string') throw E(400, 'validation', 'invalid description');
    if (columns !== undefined && (!Array.isArray(columns) || !columns.every(c => isStr(c, 1, 100)))) throw E(400, 'validation', 'invalid columns');
    const b = { id: uid(), name, description: description || '', ownerId: user.id, createdAt: now() };
    db.boards.push(b); db.members.push({ boardId: b.id, userId: user.id, role: 'owner' });
    log(b.id, 'board.created', user.id, null, { name });
    (columns || ['To Do', 'In Progress', 'Done']).forEach((n, i) => {
      const c = { id: uid(), boardId: b.id, name: n, position: i, wipLimit: null }; db.columns.push(c);
      log(b.id, 'column.created', user.id, null, { columnId: c.id, name: n });
    });
    save(); return [201, boardView(b)];
  });
  route('GET', '/api/boards', ({ user }) => [200, db.members.filter(m => m.userId === user.id).map(m => { const b = db.boards.find(x => x.id === m.boardId); return { id: b.id, name: b.name, role: m.role }; })]);
  route('GET', '/api/boards/:id', ({ user, params }) => { const b = getBoard(params[0]); need(b.id, user, 'viewer'); return [200, boardView(b)]; });
  route('PATCH', '/api/boards/:id', ({ user, params, body }) => {
    const b = getBoard(params[0]); need(b.id, user, 'owner');
    if (body.name !== undefined && !isStr(body.name, 1, 100)) throw E(400, 'validation', 'invalid name');
    if (body.description !== undefined && typeof body.description !== 'string') throw E(400, 'validation', 'invalid description');
    if (body.name !== undefined) b.name = body.name;
    if (body.description !== undefined) b.description = body.description;
    save(); return [200, boardView(b)];
  });
  route('DELETE', '/api/boards/:id', ({ user, params }) => {
    const b = getBoard(params[0]); need(b.id, user, 'owner');
    db.boards = db.boards.filter(x => x.id !== b.id);
    for (const k of ['members', 'columns', 'cards', 'labels', 'activity']) db[k] = db[k].filter(x => x.boardId !== b.id);
    const cardIds = new Set(db.cards.map(c => c.id));
    db.comments = db.comments.filter(c => cardIds.has(c.cardId));
    save(); return [204];
  });
  route('POST', '/api/boards/:id/members', ({ user, params, body }) => {
    const b = getBoard(params[0]); need(b.id, user, 'owner');
    if (typeof body.username !== 'string' || !['editor', 'viewer'].includes(body.role)) throw E(400, 'validation', 'invalid username or role');
    const u = db.users.find(x => x.username === body.username.toLowerCase());
    if (!u) throw E(404, 'not_found', 'user not found');
    if (roleOf(b.id, u.id)) throw E(409, 'conflict', 'already a member');
    db.members.push({ boardId: b.id, userId: u.id, role: body.role });
    log(b.id, 'member.added', user.id, null, { userId: u.id, role: body.role });
    save(); return [201, { userId: u.id, username: u.username, role: body.role }];
  });
  route('PATCH', '/api/boards/:id/members/:uid', ({ user, params, body }) => {
    const b = getBoard(params[0]); need(b.id, user, 'owner');
    const m = db.members.find(x => x.boardId === b.id && x.userId === params[1]);
    if (!m) throw E(404, 'not_found', 'member not found');
    if (!['editor', 'viewer'].includes(body.role)) throw E(400, 'validation', 'invalid role');
    if (m.role === 'owner') throw E(400, 'validation', 'cannot change owner role');
    m.role = body.role; save();
    const u = db.users.find(x => x.id === m.userId);
    return [200, { userId: m.userId, username: u?.username, role: m.role }];
  });
  route('DELETE', '/api/boards/:id/members/:uid', ({ user, params }) => {
    const b = getBoard(params[0]);
    const r = roleOf(b.id, user.id); if (!r) throw E(403, 'forbidden', 'not a member');
    if (r !== 'owner' && user.id !== params[1]) throw E(403, 'forbidden', 'owner only');
    const m = db.members.find(x => x.boardId === b.id && x.userId === params[1]);
    if (!m) throw E(404, 'not_found', 'member not found');
    if (m.role === 'owner') throw E(400, 'validation', 'cannot remove owner');
    db.members = db.members.filter(x => x !== m);
    for (const c of db.cards.filter(c => c.boardId === b.id)) c.assignees = c.assignees.filter(a => a !== m.userId);
    save(); return [204];
  });

  // Columns
  route('POST', '/api/boards/:id/columns', ({ user, params, body }) => {
    const b = getBoard(params[0]); need(b.id, user, 'editor');
    if (!isStr(body.name, 1, 100)) throw E(400, 'validation', 'invalid name');
    if (body.wipLimit !== undefined && !validWip(body.wipLimit)) throw E(400, 'validation', 'invalid wipLimit');
    const c = { id: uid(), boardId: b.id, name: body.name, position: colsOf(b.id).length, wipLimit: body.wipLimit ?? null };
    db.columns.push(c); log(b.id, 'column.created', user.id, null, { columnId: c.id, name: c.name }); save();
    return [201, { ...c, cards: [] }];
  });
  route('PATCH', '/api/columns/:id', ({ user, params, body }) => {
    const c = findCol(params[0]); need(c.boardId, user, 'editor');
    if (body.name !== undefined && !isStr(body.name, 1, 100)) throw E(400, 'validation', 'invalid name');
    if (body.wipLimit !== undefined && !validWip(body.wipLimit)) throw E(400, 'validation', 'invalid wipLimit');
    if (body.position !== undefined && !isPos(body.position)) throw E(400, 'validation', 'invalid position');
    if (body.name !== undefined) c.name = body.name;
    if (body.wipLimit !== undefined) c.wipLimit = body.wipLimit;
    if (body.position !== undefined) {
      const list = colsOf(c.boardId).filter(x => x !== c);
      list.splice(clampPos(body.position, list.length), 0, c); compact(list);
    }
    save(); return [200, { ...c, cards: cardsOf(c.id) }];
  });
  route('DELETE', '/api/columns/:id', ({ user, params, query }) => {
    const c = findCol(params[0]); need(c.boardId, user, 'editor');
    const cards = cardsOf(c.id);
    if (cards.length && query.get('force') !== 'true') throw E(409, 'conflict', 'column has cards');
    const ids = new Set(cards.map(x => x.id));
    db.cards = db.cards.filter(x => !ids.has(x.id)); db.comments = db.comments.filter(x => !ids.has(x.cardId));
    db.columns = db.columns.filter(x => x !== c); compact(colsOf(c.boardId));
    save(); return [204];
  });

  // Cards
  route('POST', '/api/columns/:id/cards', ({ user, params, body }) => {
    const col = findCol(params[0]); need(col.boardId, user, 'editor');
    const { title, description, assignees, labels, dueDate, position } = body;
    if (!isStr(title, 1, 200)) throw E(400, 'validation', 'invalid title');
    if (description !== undefined && description !== null && typeof description !== 'string') throw E(400, 'validation', 'invalid description');
    if (dueDate !== undefined && dueDate !== null && !isDate(dueDate)) throw E(400, 'validation', 'invalid dueDate');
    if (position !== undefined && !isPos(position)) throw E(400, 'validation', 'invalid position');
    validCardRefs(col.boardId, assignees, labels);
    const list = cardsOf(col.id);
    if (col.wipLimit && list.length >= col.wipLimit) throw E(409, 'wip_limit', 'WIP limit reached');
    const t = now();
    const c = { id: uid(), boardId: col.boardId, columnId: col.id, title, description: description || '', position: 0, assignees: uniq(assignees || []), labels: uniq(labels || []), dueDate: dueDate ?? null, createdBy: user.id, createdAt: t, updatedAt: t };
    list.splice(position === undefined ? list.length : clampPos(position, list.length), 0, c);
    db.cards.push(c); compact(list);
    log(col.boardId, 'card.created', user.id, c.id, { columnId: col.id, title }); save();
    return [201, c];
  });
  const cardGuard = (params, user, lvl) => { const c = findCard(params[0]); need(c.boardId, user, lvl); return c; };
  route('GET', '/api/cards/:id', ({ user, params }) => [200, cardGuard(params, user, 'viewer')]);
  route('PATCH', '/api/cards/:id', ({ user, params, body }) => {
    const c = cardGuard(params, user, 'editor');
    const { title, description, assignees, labels, dueDate } = body;
    if (title !== undefined && !isStr(title, 1, 200)) throw E(400, 'validation', 'invalid title');
    if (description !== undefined && typeof description !== 'string') throw E(400, 'validation', 'invalid description');
    if (dueDate !== undefined && dueDate !== null && !isDate(dueDate)) throw E(400, 'validation', 'invalid dueDate');
    validCardRefs(c.boardId, assignees, labels);
    const changed = [];
    for (const [k, v] of [['title', title], ['description', description], ['dueDate', dueDate]]) if (v !== undefined) { c[k] = v; changed.push(k); }
    if (assignees !== undefined) { c.assignees = uniq(assignees); changed.push('assignees'); }
    if (labels !== undefined) { c.labels = uniq(labels); changed.push('labels'); }
    c.updatedAt = now(); log(c.boardId, 'card.updated', user.id, c.id, { fields: changed }); save();
    return [200, c];
  });
  route('DELETE', '/api/cards/:id', ({ user, params }) => {
    const c = cardGuard(params, user, 'editor');
    db.cards = db.cards.filter(x => x !== c); db.comments = db.comments.filter(x => x.cardId !== c.id);
    compact(cardsOf(c.columnId));
    log(c.boardId, 'card.deleted', user.id, c.id, { columnId: c.columnId, title: c.title }); save();
    return [204];
  });
  route('POST', '/api/cards/:id/move', ({ user, params, body }) => {
    const c = cardGuard(params, user, 'editor');
    if (typeof body.columnId !== 'string') throw E(400, 'validation', 'columnId required');
    if (body.position !== undefined && !isPos(body.position)) throw E(400, 'validation', 'invalid position');
    const target = db.columns.find(x => x.id === body.columnId);
    if (!target || target.boardId !== c.boardId) throw E(400, 'validation', 'invalid target column');
    const from = c.columnId;
    const tl = cardsOf(target.id).filter(x => x !== c);
    if (from !== target.id && target.wipLimit && tl.length >= target.wipLimit) throw E(409, 'wip_limit', 'WIP limit reached');
    tl.splice(body.position === undefined ? tl.length : clampPos(body.position, tl.length), 0, c);
    c.columnId = target.id; compact(tl);
    if (from !== target.id) compact(cardsOf(from));
    c.updatedAt = now();
    log(c.boardId, 'card.moved', user.id, c.id, { fromColumnId: from, toColumnId: target.id, position: c.position }); save();
    return [200, c];
  });

  // Labels
  route('POST', '/api/boards/:id/labels', ({ user, params, body }) => {
    const b = getBoard(params[0]); need(b.id, user, 'editor');
    if (!isStr(body.name, 1, 100)) throw E(400, 'validation', 'invalid name');
    if (typeof body.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(body.color)) throw E(400, 'validation', 'invalid color');
    if (db.labels.some(l => l.boardId === b.id && l.name.toLowerCase() === body.name.toLowerCase())) throw E(409, 'conflict', 'label exists');
    const l = { id: uid(), boardId: b.id, name: body.name, color: body.color };
    db.labels.push(l); save(); return [201, l];
  });
  route('DELETE', '/api/labels/:id', ({ user, params }) => {
    const l = db.labels.find(x => x.id === params[0]); if (!l) throw E(404, 'not_found', 'label not found');
    need(l.boardId, user, 'editor');
    db.labels = db.labels.filter(x => x !== l);
    for (const c of db.cards) if (c.boardId === l.boardId) c.labels = c.labels.filter(x => x !== l.id);
    save(); return [204];
  });

  // Comments
  route('POST', '/api/cards/:id/comments', ({ user, params, body }) => {
    const c = cardGuard(params, user, 'editor');
    if (!isStr(body.body, 1, 5000)) throw E(400, 'validation', 'invalid body');
    const m = { id: uid(), cardId: c.id, authorId: user.id, body: body.body, createdAt: now() };
    db.comments.push(m); log(c.boardId, 'comment.added', user.id, c.id, { commentId: m.id }); save();
    return [201, m];
  });
  route('GET', '/api/cards/:id/comments', ({ user, params }) => {
    const c = cardGuard(params, user, 'viewer');
    return [200, db.comments.filter(m => m.cardId === c.id)];
  });
  route('DELETE', '/api/comments/:id', ({ user, params }) => {
    const m = db.comments.find(x => x.id === params[0]); if (!m) throw E(404, 'not_found', 'comment not found');
    const c = db.cards.find(x => x.id === m.cardId);
    const r = roleOf(c.boardId, user.id); if (!r) throw E(403, 'forbidden', 'not a member');
    if (m.authorId !== user.id && r !== 'owner') throw E(403, 'forbidden', 'not allowed');
    db.comments = db.comments.filter(x => x !== m); save(); return [204];
  });

  // Search & activity
  route('GET', '/api/boards/:id/cards', ({ user, params, query }) => {
    const b = getBoard(params[0]); need(b.id, user, 'viewer');
    const q = query.get('q')?.toLowerCase(), as = query.get('assignee'), lb = query.get('label'), col = query.get('column'), db4 = query.get('due_before');
    if (db4 && !isDate(db4)) throw E(400, 'validation', 'invalid due_before');
    const cols = colsOf(b.id); const out = [];
    for (const c of cols) {
      if (col && c.id !== col) continue;
      for (const k of cardsOf(c.id)) {
        if (q && !(k.title.toLowerCase().includes(q) || (k.description || '').toLowerCase().includes(q))) continue;
        if (as && !k.assignees.includes(as)) continue;
        if (lb && !k.labels.includes(lb)) continue;
        if (db4 && !(k.dueDate && k.dueDate < db4)) continue;
        out.push(k);
      }
    }
    return [200, out];
  });
  route('GET', '/api/boards/:id/activity', ({ user, params, query }) => {
    const b = getBoard(params[0]); need(b.id, user, 'viewer');
    let limit = 50;
    if (query.has('limit')) { limit = Number(query.get('limit')); if (!Number.isInteger(limit) || limit < 1) throw E(400, 'validation', 'invalid limit'); }
    return [200, db.activity.filter(a => a.boardId === b.id).reverse().slice(0, limit)];
  });

  const send = (res, status, body, type = 'application/json') => {
    const data = body === undefined ? '' : (type === 'application/json' ? JSON.stringify(body) : body);
    res.writeHead(status, { 'content-type': type + (type === 'application/json' ? '' : '; charset=utf-8'), 'content-length': Buffer.byteLength(data) });
    res.end(data);
  };

  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const url = new URL(req.url, 'http://x');
        const path = url.pathname.replace(/(.)\/+$/, '$1');
        if (req.method === 'GET' && path === '/') return send(res, 200, HTML, 'text/html');
        if (!path.startsWith('/api/')) throw E(404, 'not_found', 'not found');
        let r = null, params = [];
        let pathMatched = false;
        for (const rt of routes) { const m = rt.re.exec(path); if (m) { pathMatched = true; if (rt.method === req.method) { r = rt; params = m.slice(1).map(decodeURIComponent); break; } } }
        if (!r) throw pathMatched ? E(405, 'method_not_allowed', 'method not allowed') : E(404, 'not_found', 'not found');
        let user = null, token = null;
        if (!r.open) {
          const h = req.headers.authorization || '';
          token = h.startsWith('Bearer ') ? h.slice(7).trim() : null;
          const uidv = token && sessions.get(token);
          user = uidv && db.users.find(u => u.id === uidv);
          if (!user) throw E(401, 'unauthorized', 'authentication required');
        }
        let body = {};
        const raw = Buffer.concat(chunks).toString('utf8');
        if (raw.trim()) {
          try { body = JSON.parse(raw); } catch { throw E(400, 'bad_request', 'invalid JSON'); }
          if (body === null || typeof body !== 'object' || Array.isArray(body)) throw E(400, 'validation', 'body must be an object');
        }
        const [status, out] = r.fn({ body, user, token, params, query: url.searchParams });
        if (status === 204) { res.writeHead(204); return res.end(); }
        send(res, status, out);
      } catch (e) {
        if (e instanceof HttpError) return send(res, e.status, { error: e.error, message: e.message });
        console.error(e); send(res, 500, { error: 'internal', message: 'internal error' });
      }
    });
  });
}
