import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseQuery, matches, QueryError } from './search.js';
import { toCsv, parseCsv } from './csv.js';

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');
const CATS = ['backlog', 'unstarted', 'started', 'completed'];
const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIOS = ['urgent', 'high', 'medium', 'low', 'none'];
const WS_ROLES = ['admin', 'member', 'guest'];
const PROJ_ROLES = ['lead', 'developer', 'viewer'];
const EVENTS = ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'];
const LINK_TYPES = ['blocks', 'relates', 'duplicates'];
const INVERSE = { blocks: 'blocked_by', relates: 'relates', duplicates: 'duplicated_by' };
const DEFAULT_STATUSES = [['Backlog', 'backlog'], ['Todo', 'unstarted'], ['In Progress', 'started'], ['In Review', 'started'], ['Done', 'completed']];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

class HttpError extends Error {
  constructor(status, error, message) { super(message || error); this.status = status; this.error = error; }
}
const bad = (m) => new HttpError(400, 'validation_error', m);
const notFound = (m = 'not found') => new HttpError(404, 'not_found', m);
const forbidden = (m = 'forbidden') => new HttpError(403, 'forbidden', m);
const conflict = (m, code = 'conflict') => new HttpError(409, code, m);

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const uid = () => crypto.randomUUID();
const isStr = (v) => typeof v === 'string';
const isDate = (s) => isStr(s) && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
}
function checkPassword(pw, stored) {
  const [, salt, hash] = stored.split('$');
  const h = crypto.scryptSync(pw, salt, 32);
  const b = Buffer.from(hash, 'hex');
  return b.length === h.length && crypto.timingSafeEqual(b, h);
}

export function createServer({ dataFile, clock } = {}) {
  const now = () => (clock ? clock() : new Date());
  const iso = () => now().toISOString();
  let db = { users: [], sessions: [], tokens: [], workspaces: [], projects: [], issues: [], comments: [], notifications: [], sprints: [], webhooks: [], deliveries: [], audit: [], seq: 0 };
  if (dataFile && fs.existsSync(dataFile)) {
    try { db = { ...db, ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) }; } catch { /* start fresh */ }
  }
  let dirty = false;
  const save = () => {
    if (!dataFile) return;
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, dataFile);
  };
  const loginFails = new Map();

  // ---------- lookups ----------
  const userById = (id) => db.users.find(u => u.id === id);
  const userByName = (n) => { n = String(n).toLowerCase(); return db.users.find(u => u.username.toLowerCase() === n); };
  const wsById = (id) => db.workspaces.find(w => w.id === id);
  const projById = (id) => db.projects.find(p => p.id === id);
  const issueByKey = (k) => db.issues.find(i => i.key === k);
  const issueById = (id) => db.issues.find(i => i.id === id);
  const sprintById = (id) => db.sprints.find(s => s.id === id);
  const pubUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName, createdAt: u.createdAt });

  function wsRole(user, ws) { const m = ws.members.find(m => m.userId === user.id); return m ? m.role : null; }
  function projRole(user, p) {
    const ws = wsById(p.workspaceId); if (!ws) return null;
    const wr = wsRole(user, ws); if (!wr) return null;
    if (wr === 'admin') return 'lead';
    const pm = p.members.find(m => m.userId === user.id);
    if (pm) return pm.role;
    return wr === 'guest' ? null : 'developer';
  }
  const userCanSeeProject = (uid_, p) => { const u = userById(uid_); return !!u && !!projRole(u, p); };

  function getWs(user, id, roles) {
    const ws = wsById(id); if (!ws) throw notFound('workspace not found');
    const r = wsRole(user, ws); if (!r) throw notFound('workspace not found');
    if (roles && !roles.includes(r)) throw forbidden();
    return { ws, role: r };
  }
  function getProj(user, id, need) {
    const p = projById(id); if (!p) throw notFound('project not found');
    const r = projRole(user, p); if (!r) throw notFound('project not found');
    if (need === 'write' && r === 'viewer') throw forbidden();
    if (need === 'lead' && r !== 'lead') throw forbidden();
    return { p, role: r };
  }
  function getIssue(user, key, need) {
    const i = issueByKey(key) || issueById(key); if (!i) throw notFound('issue not found');
    const p = projById(i.projectId); const r = projRole(user, p); if (!r) throw notFound('issue not found');
    if (need === 'write' && r === 'viewer') throw forbidden();
    return { i, p, role: r };
  }
  const catOf = (p, status) => (p.workflow.statuses.find(s => s.name === status) || {}).category;
  const isDone = (i) => catOf(projById(i.projectId), i.status) === 'completed';
  const audit = (wsId, action, actorId, details) => db.audit.push({ id: uid(), workspaceId: wsId, action, type: action, actorId, at: iso(), details });

  // ---------- serialization ----------
  function outIssue(i, detail) {
    const o = {};
    for (const k of Object.keys(i)) if (!k.startsWith('_')) o[k] = i[k];
    if (detail) {
      o.children = db.issues.filter(c => c.parentId === i.id).map(c => c.key);
      if (i.type === 'epic') {
        const m = db.issues.filter(c => c.epicId === i.id);
        o.progress = { total: m.length, done: m.filter(isDone).length, points_total: m.reduce((a, c) => a + (c.storyPoints || 0), 0), points_done: m.filter(isDone).reduce((a, c) => a + (c.storyPoints || 0), 0) };
      }
    }
    o.links = [];
    for (const l of db.links || []) {
      if (l.from === i.id) { const t = issueById(l.to); if (t) o.links.push({ id: l.id, type: l.type, key: t.key, target: t.key }); }
      else if (l.to === i.id) { const t = issueById(l.from); if (t) o.links.push({ id: l.id, type: INVERSE[l.type], key: t.key, target: t.key }); }
    }
    return o;
  }
  db.links = db.links || [];
  const outWs = (ws, user) => ({ id: ws.id, name: ws.name, key: ws.key, createdAt: ws.createdAt, role: wsRole(user, ws), members: ws.members.map(m => ({ userId: m.userId, username: userById(m.userId)?.username, role: m.role })) });
  const outProj = (p, user) => ({ id: p.id, workspaceId: p.workspaceId, name: p.name, key: p.key, createdAt: p.createdAt, workflow: p.workflow, role: projRole(user, p), members: p.members.map(m => ({ userId: m.userId, username: userById(m.userId)?.username, role: m.role })) });
  const outComment = (c) => ({ id: c.id, issueId: c.issueId, issueKey: c.issueKey, authorId: c.authorId, body: c.body, edited: !!c.edited, createdAt: c.createdAt, updatedAt: c.updatedAt });
  const outSprint = (s) => ({ id: s.id, projectId: s.projectId, name: s.name, startDate: s.startDate, endDate: s.endDate, state: s.state, createdAt: s.createdAt, startedAt: s.startedAt, completedAt: s.completedAt });
  const outHook = (h) => ({ id: h.id, projectId: h.projectId, url: h.url, events: h.events, createdAt: h.createdAt });

  // ---------- notifications & webhooks ----------
  function notify(userIds, type, issue, actorId) {
    for (const id of new Set(userIds)) {
      if (id === actorId) continue;
      const u = userById(id); if (!u) continue;
      if (!userCanSeeProject(id, projById(issue.projectId))) continue;
      db.notifications.push({ id: uid(), seq: ++db.seq, userId: id, type, issueKey: issue.key, actorId, at: iso(), read: false });
    }
  }
  async function deliver(h, delivery, body) {
    const sig = 'sha256=' + crypto.createHmac('sha256', h.secret || '').update(body).digest('hex');
    for (let a = 1; a <= 3; a++) {
      delivery.attempts = a;
      try {
        const r = await fetch(h.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pm-signature': sig }, body, signal: AbortSignal.timeout(5000) });
        delivery.responseStatus = r.status;
        if (r.status >= 200 && r.status < 300) { delivery.status = 'delivered'; delivery.lastError = null; break; }
        delivery.lastError = `HTTP ${r.status}`;
      } catch (e) { delivery.lastError = String(e.message || e); }
      delivery.status = a < 3 ? 'retrying' : 'failed';
      if (a < 3) await new Promise(r => setTimeout(r, 50 * a));
    }
    try { save(); } catch { /* ignore */ }
  }
  function fire(event, issue, actorId, extra) {
    const p = projById(issue.projectId);
    for (const h of db.webhooks.filter(h => h.projectId === p.id && h.events.includes(event))) {
      const at = iso();
      const body = JSON.stringify({ event, issue: outIssue(issue), actorId, at, ...(extra || {}) });
      const delivery = { id: uid(), webhookId: h.id, event, status: 'pending', attempts: 0, lastError: null, createdAt: at };
      db.deliveries.push(delivery);
      deliver(h, delivery, body);
    }
  }

  // ---------- issue logic ----------
  const hist = (i, field, from, to, actorId) => { i._history.push({ field, from, to, actorId, at: iso() }); };
  function setStatus(i, p, status) {
    const cat = catOf(p, status); const t = iso();
    i.status = status;
    if (cat === 'completed') { if (!i.resolvedAt) { i.resolvedAt = t; i._resolveLog.push({ at: t, resolved: true }); } }
    else if (i.resolvedAt) { i.resolvedAt = null; i._resolveLog.push({ at: t, resolved: false }); }
    if (cat === 'started' && !i._startedAt) i._startedAt = t;
  }
  function validateStructure(p, o) {
    if (o.type === 'subtask') {
      if (!o.parentId) throw bad('subtask requires parentId');
      const par = issueById(o.parentId);
      if (!par || par.projectId !== p.id) throw bad('parent must be an issue in the same project');
      if (par.type === 'subtask') throw bad('parent cannot be a subtask');
    } else if (o.parentId) throw bad('only subtasks can have a parent');
    if (o.epicId) {
      const e = issueById(o.epicId);
      if (!e || e.projectId !== p.id || e.type !== 'epic') throw bad('epicId must reference an epic in the project');
      if (o.type === 'epic') throw bad('epics cannot belong to an epic');
    }
  }
  function normIssueFields(p, b, cur) {
    const out = {};
    if ('title' in b) { if (!isStr(b.title) || !b.title.trim()) throw bad('title required'); out.title = b.title.trim(); }
    if ('description' in b) { if (b.description != null && !isStr(b.description)) throw bad('description must be a string'); out.description = b.description ?? ''; }
    if ('type' in b) { if (!TYPES.includes(b.type)) throw bad('invalid type'); out.type = b.type; }
    if ('priority' in b) { if (!PRIOS.includes(b.priority)) throw bad('invalid priority'); out.priority = b.priority; }
    if ('labels' in b) { if (!Array.isArray(b.labels) || b.labels.some(l => !isStr(l) || !l.trim())) throw bad('labels must be strings'); out.labels = [...new Set(b.labels.map(l => l.trim()))]; }
    if ('storyPoints' in b) { if (b.storyPoints !== null && (typeof b.storyPoints !== 'number' || !isFinite(b.storyPoints) || b.storyPoints < 0)) throw bad('invalid storyPoints'); out.storyPoints = b.storyPoints; }
    if ('dueDate' in b) { if (b.dueDate !== null && !isDate(b.dueDate)) throw bad('dueDate must be YYYY-MM-DD'); out.dueDate = b.dueDate; }
    if ('assigneeId' in b) {
      if (b.assigneeId !== null) {
        const u = isStr(b.assigneeId) && (userById(b.assigneeId) || userByName(b.assigneeId));
        if (!u || !userCanSeeProject(u.id, p)) throw bad('invalid assignee');
        out.assigneeId = u.id;
      } else out.assigneeId = null;
    }
    for (const f of ['parentId', 'epicId']) if (f in b) {
      if (b[f] === null) out[f] = null;
      else { const x = isStr(b[f]) && (issueById(b[f]) || issueByKey(b[f])); if (!x) throw bad(`invalid ${f}`); out[f] = x.id; }
    }
    if ('sprintId' in b) {
      if (b.sprintId === null) out.sprintId = null;
      else { const s = isStr(b.sprintId) && sprintById(b.sprintId); if (!s || s.projectId !== p.id) throw bad('invalid sprintId'); if (s.state === 'completed') throw bad('sprint is completed'); out.sprintId = s.id; }
    }
    return out;
  }
  function addToSprintLog(i) {
    if (!i.sprintId) return;
    const s = sprintById(i.sprintId);
    s.everIds = s.everIds || [];
    if (!s.everIds.includes(i.id)) s.everIds.push(i.id);
  }
  function createIssue(p, user, b) {
    const f = normIssueFields(p, b);
    if (!f.title) throw bad('title required');
    const o = { type: 'task', description: '', priority: 'none', labels: [], storyPoints: null, assigneeId: null, parentId: null, epicId: null, sprintId: null, dueDate: null, ...f };
    validateStructure(p, o);
    const st = p.workflow.statuses;
    let status = (st.find(s => s.category === 'unstarted') || st[0]).name;
    if (b.status !== undefined) { if (!st.some(s => s.name === b.status)) throw bad('invalid status'); status = b.status; }
    const t = iso();
    p.counter = (p.counter || 0) + 1;
    const i = { id: uid(), key: `${p.key}-${p.counter}`, projectId: p.id, type: o.type, title: o.title, description: o.description, status, priority: o.priority, assigneeId: o.assigneeId, reporterId: user.id, labels: o.labels, storyPoints: o.storyPoints, parentId: o.parentId, epicId: o.epicId, sprintId: o.sprintId, dueDate: o.dueDate, watchers: [], createdAt: t, updatedAt: t, resolvedAt: null, _history: [], _resolveLog: [], _pointsLog: [{ at: t, v: o.storyPoints }], _startedAt: null };
    setStatus(i, p, status);
    i.watchers.push(user.id);
    if (i.assigneeId && !i.watchers.includes(i.assigneeId)) i.watchers.push(i.assigneeId);
    db.issues.push(i);
    addToSprintLog(i);
    return i;
  }
  function updateIssue(i, p, user, b) {
    const f = normIssueFields(p, b);
    const next = { type: i.type, parentId: i.parentId, epicId: i.epicId, ...f };
    if ('type' in f || 'parentId' in f || 'epicId' in f) validateStructure(p, next);
    let newStatus;
    if ('status' in b && b.status !== i.status) {
      if (!isStr(b.status) || !p.workflow.statuses.some(s => s.name === b.status)) throw bad('invalid status');
      if (!p.workflow.transitions.some(([a, c]) => a === i.status && c === b.status)) throw conflict(`transition ${i.status} -> ${b.status} not allowed`, 'invalid_transition');
      if (catOf(p, b.status) === 'completed') {
        const blockers = db.links.filter(l => l.type === 'blocks' && l.to === i.id).map(l => issueById(l.from)).filter(x => x && !isDone(x));
        if (blockers.length) throw conflict(`blocked by ${blockers.map(x => x.key).join(', ')}`, 'blocked');
      }
      newStatus = b.status;
    } else if ('status' in b && !isStr(b.status)) throw bad('invalid status');
    const changes = [];
    for (const k of Object.keys(f)) {
      if (JSON.stringify(f[k]) !== JSON.stringify(i[k])) { changes.push([k, i[k], f[k]]); }
    }
    const prevAssignee = i.assigneeId; const prevStatus = i.status;
    for (const [k, from, to] of changes) {
      i[k] = to; hist(i, k, from, to, user.id);
      if (k === 'storyPoints') i._pointsLog.push({ at: iso(), v: to });
    }
    if (newStatus) { setStatus(i, p, newStatus); hist(i, 'status', prevStatus, newStatus, user.id); changes.push(['status']); }
    if (!changes.length) return false;
    if ('sprintId' in f) addToSprintLog(i);
    i.updatedAt = iso();
    if (i.assigneeId !== prevAssignee && i.assigneeId) {
      if (!i.watchers.includes(i.assigneeId)) i.watchers.push(i.assigneeId);
      notify([...i.watchers.filter(w => w !== i.assigneeId), i.assigneeId], 'assignment', i, user.id);
    }
    if (newStatus) notify(i.watchers, 'status_change', i, user.id);
    return true;
  }
  function deleteIssue(i) {
    const kids = db.issues.filter(c => c.parentId === i.id);
    for (const k of kids) deleteIssue(k);
    for (const c of db.issues) if (c.epicId === i.id) { c.epicId = null; }
    db.links = db.links.filter(l => l.from !== i.id && l.to !== i.id);
    db.comments = db.comments.filter(c => c.issueId !== i.id);
    db.issues = db.issues.filter(x => x !== i);
  }

  // ---------- reporting ----------
  const dayEnd = (d) => Date.parse(d + 'T23:59:59.999Z');
  function pointsAt(i, t) { let v = null; for (const e of i._pointsLog) if (Date.parse(e.at) <= t) v = e.v; return v || 0; }
  function resolvedAt(i, t) { let r = false; for (const e of i._resolveLog) if (Date.parse(e.at) <= t) r = e.resolved; return r; }
  function sprintReport(s) {
    const p = projById(s.projectId);
    const ids = new Set([...(s.everIds || []), ...db.issues.filter(i => i.sprintId === s.id).map(i => i.id)]);
    const all = [...ids].map(issueById).filter(Boolean);
    const current = db.issues.filter(i => i.sprintId === s.id);
    const committed = s.committedPoints != null ? s.committedPoints : current.reduce((a, i) => a + (i.storyPoints || 0), 0);
    const completed = all.filter(i => isDone(i) && (i.sprintId === s.id || (s.completedIds || []).includes(i.id)));
    const burndown = [];
    if (s.startDate) {
      const today = now().toISOString().slice(0, 10);
      const last = s.endDate && s.endDate < today ? s.endDate : today;
      for (let d = new Date(s.startDate + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= last && burndown.length < 1000; d = new Date(d.getTime() + 86400000)) {
        const ds = d.toISOString().slice(0, 10); const t = dayEnd(ds);
        let rem = 0;
        for (const i of all) {
          if (Date.parse(i.createdAt) > t && !(s.committedIds || []).includes(i.id)) continue;
          if (!resolvedAt(i, t)) rem += pointsAt(i, t);
        }
        burndown.push({ date: ds, remainingPoints: rem });
      }
    }
    return {
      committedPoints: committed,
      completedPoints: completed.reduce((a, i) => a + (i.storyPoints || 0), 0),
      completedIssues: completed.length,
      carriedOver: s.carriedOver || 0,
      burndown,
    };
  }

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, handler, auth: opts.auth !== false });
  };

  // auth
  route('POST', '/api/auth/register', ({ body }) => {
    const { username, password, displayName } = body || {};
    if (!isStr(username) || !/^[A-Za-z0-9_.-]{3,32}$/.test(username)) throw bad('username must be 3-32 chars (letters, digits, _ . -)');
    if (!isStr(password) || password.length < 8) throw bad('password must be at least 8 characters');
    if (displayName != null && !isStr(displayName)) throw bad('displayName must be a string');
    if (userByName(username)) throw conflict('username taken');
    const u = { id: uid(), username, displayName: displayName || username, passwordHash: hashPassword(password), createdAt: iso() };
    db.users.push(u);
    return [201, pubUser(u)];
  }, { auth: false });
  route('POST', '/api/auth/login', ({ body, req }) => {
    const { username, password } = body || {};
    if (!isStr(username) || !isStr(password)) throw bad('username and password required');
    const k = username.toLowerCase(); const t = now().getTime();
    const f = loginFails.get(k);
    if (f && t - f.first < 60000 && f.n >= 5) throw new HttpError(429, 'rate_limited', 'too many failed login attempts');
    const u = userByName(username);
    if (!u || !checkPassword(password, u.passwordHash)) {
      const cur = f && t - f.first < 60000 ? f : { first: t, n: 0 };
      cur.n++; loginFails.set(k, cur);
      throw new HttpError(401, 'unauthorized', 'invalid credentials');
    }
    loginFails.delete(k);
    const token = crypto.randomBytes(32).toString('hex');
    db.sessions.push({ hash: sha(token), userId: u.id, createdAt: iso() });
    return [200, { token, user: pubUser(u) }];
  }, { auth: false });
  route('POST', '/api/auth/logout', ({ session }) => {
    if (session) db.sessions = db.sessions.filter(s => s !== session);
    return [204];
  });
  route('GET', '/api/auth/me', ({ user }) => [200, pubUser(user)]);
  route('PATCH', '/api/auth/me', ({ user, body }) => {
    const { displayName, password, currentPassword } = body || {};
    if (displayName !== undefined) { if (!isStr(displayName) || !displayName.trim()) throw bad('invalid displayName'); }
    if (password !== undefined) {
      if (!isStr(password) || password.length < 8) throw bad('password must be at least 8 characters');
      if (!isStr(currentPassword)) throw bad('currentPassword required');
    }
    if ((password !== undefined || currentPassword !== undefined) && isStr(currentPassword) && !checkPassword(currentPassword, user.passwordHash)) throw forbidden('current password incorrect');
    if (displayName !== undefined) user.displayName = displayName.trim();
    if (password !== undefined) user.passwordHash = hashPassword(password);
    return [200, pubUser(user)];
  });

  // tokens
  route('POST', '/api/tokens', ({ user, body }) => {
    if (!isStr(body?.name) || !body.name.trim()) throw bad('name required');
    const token = 'pmt_' + crypto.randomBytes(24).toString('hex');
    const t = { id: uid(), userId: user.id, name: body.name.trim(), hash: sha(token), createdAt: iso() };
    db.tokens.push(t);
    for (const w of db.workspaces) if (wsRole(user, w)) audit(w.id, 'token.created', user.id, { tokenId: t.id, name: t.name });
    return [201, { id: t.id, name: t.name, token, createdAt: t.createdAt }];
  });
  route('GET', '/api/tokens', ({ user }) => [200, db.tokens.filter(t => t.userId === user.id).map(t => ({ id: t.id, name: t.name, createdAt: t.createdAt }))]);
  route('DELETE', '/api/tokens/:id', ({ user, params }) => {
    const t = db.tokens.find(t => t.id === params.id && t.userId === user.id); if (!t) throw notFound('token not found');
    db.tokens = db.tokens.filter(x => x !== t);
    for (const w of db.workspaces) if (wsRole(user, w)) audit(w.id, 'token.deleted', user.id, { tokenId: t.id, name: t.name });
    return [204];
  });

  // workspaces
  route('POST', '/api/workspaces', ({ user, body }) => {
    const { name, key } = body || {};
    if (!isStr(name) || !name.trim()) throw bad('name required');
    if (!isStr(key) || !/^[A-Z]{2,10}$/.test(key)) throw bad('key must be 2-10 uppercase letters');
    if (db.workspaces.some(w => w.key === key)) throw conflict('workspace key taken');
    const ws = { id: uid(), name: name.trim(), key, createdAt: iso(), members: [{ userId: user.id, role: 'admin' }] };
    db.workspaces.push(ws);
    audit(ws.id, 'member.added', user.id, { userId: user.id, role: 'admin' });
    return [201, outWs(ws, user)];
  });
  route('GET', '/api/workspaces', ({ user }) => [200, db.workspaces.filter(w => wsRole(user, w)).map(w => outWs(w, user))]);
  route('GET', '/api/workspaces/:id', ({ user, params }) => [200, outWs(getWs(user, params.id).ws, user)]);
  route('GET', '/api/workspaces/:id/members', ({ user, params }) => [200, outWs(getWs(user, params.id).ws, user).members]);
  const findMember = (ws, ref) => ws.members.find(m => m.userId === ref || userById(m.userId)?.username.toLowerCase() === String(ref).toLowerCase());
  route('POST', '/api/workspaces/:id/members', ({ user, params, body }) => {
    const { ws } = getWs(user, params.id, ['admin']);
    const { username, role } = body || {};
    if (!isStr(username)) throw bad('username required');
    if (!WS_ROLES.includes(role)) throw bad('invalid role');
    const u = userByName(username); if (!u) throw notFound('user not found');
    if (ws.members.some(m => m.userId === u.id)) throw conflict('already a member');
    ws.members.push({ userId: u.id, role });
    audit(ws.id, 'member.added', user.id, { userId: u.id, username: u.username, role });
    return [201, { userId: u.id, username: u.username, role }];
  });
  route('PATCH', '/api/workspaces/:id/members/:uid', ({ user, params, body }) => {
    const { ws } = getWs(user, params.id, ['admin']);
    const m = findMember(ws, params.uid); if (!m) throw notFound('member not found');
    if (!WS_ROLES.includes(body?.role)) throw bad('invalid role');
    if (m.role === 'admin' && body.role !== 'admin' && ws.members.filter(x => x.role === 'admin').length === 1) throw bad('cannot demote the last admin');
    const from = m.role; m.role = body.role;
    audit(ws.id, 'member.role_changed', user.id, { userId: m.userId, from, to: m.role });
    return [200, { userId: m.userId, username: userById(m.userId)?.username, role: m.role }];
  });
  route('DELETE', '/api/workspaces/:id/members/:uid', ({ user, params }) => {
    const { ws } = getWs(user, params.id, ['admin']);
    const m = findMember(ws, params.uid); if (!m) throw notFound('member not found');
    if (m.role === 'admin' && ws.members.filter(x => x.role === 'admin').length === 1) throw bad('cannot remove the last admin');
    ws.members = ws.members.filter(x => x !== m);
    for (const p of db.projects.filter(p => p.workspaceId === ws.id)) p.members = p.members.filter(x => x.userId !== m.userId);
    audit(ws.id, 'member.removed', user.id, { userId: m.userId });
    return [204];
  });
  route('GET', '/api/workspaces/:id/audit', ({ user, params }) => {
    const { ws } = getWs(user, params.id, ['admin']);
    return [200, db.audit.filter(a => a.workspaceId === ws.id)];
  });

  // projects
  route('POST', '/api/workspaces/:id/projects', ({ user, params, body }) => {
    const { ws, role } = getWs(user, params.id);
    if (role === 'guest') throw forbidden('guests cannot create projects');
    const { name, key } = body || {};
    if (!isStr(name) || !name.trim()) throw bad('name required');
    if (!isStr(key) || !/^[A-Z]{2,10}$/.test(key)) throw bad('key must be 2-10 uppercase letters');
    if (db.projects.some(p => p.key === key)) throw conflict('project key taken');
    const statuses = DEFAULT_STATUSES.map(([name, category]) => ({ name, category }));
    const transitions = [];
    for (const a of statuses) for (const b of statuses) if (a !== b) transitions.push([a.name, b.name]);
    const p = { id: uid(), workspaceId: ws.id, name: name.trim(), key, createdAt: iso(), counter: 0, members: [{ userId: user.id, role: 'lead' }], workflow: { statuses, transitions } };
    db.projects.push(p);
    return [201, outProj(p, user)];
  });
  route('GET', '/api/workspaces/:id/projects', ({ user, params }) => {
    const { ws } = getWs(user, params.id);
    return [200, db.projects.filter(p => p.workspaceId === ws.id && projRole(user, p)).map(p => outProj(p, user))];
  });
  route('GET', '/api/projects/:id', ({ user, params }) => [200, outProj(getProj(user, params.id).p, user)]);
  route('GET', '/api/projects/:id/members', ({ user, params }) => [200, outProj(getProj(user, params.id).p, user).members]);
  const projMemberTarget = (p, ref) => p.members.find(m => m.userId === ref || userById(m.userId)?.username.toLowerCase() === String(ref).toLowerCase());
  route('POST', '/api/projects/:id/members', ({ user, params, body }) => {
    const { p } = getProj(user, params.id, 'lead');
    const { username, role } = body || {};
    if (!isStr(username)) throw bad('username required');
    if (!PROJ_ROLES.includes(role)) throw bad('invalid role');
    const u = userByName(username); if (!u) throw notFound('user not found');
    if (!wsRole(u, wsById(p.workspaceId))) throw bad('user is not a workspace member');
    if (p.members.some(m => m.userId === u.id)) throw conflict('already a project member');
    p.members.push({ userId: u.id, role });
    return [201, { userId: u.id, username: u.username, role }];
  });
  route('PATCH', '/api/projects/:id/members/:uid', ({ user, params, body }) => {
    const { p } = getProj(user, params.id, 'lead');
    const m = projMemberTarget(p, params.uid); if (!m) throw notFound('member not found');
    if (!PROJ_ROLES.includes(body?.role)) throw bad('invalid role');
    m.role = body.role;
    return [200, { userId: m.userId, username: userById(m.userId)?.username, role: m.role }];
  });
  route('DELETE', '/api/projects/:id/members/:uid', ({ user, params }) => {
    const { p } = getProj(user, params.id, 'lead');
    const m = projMemberTarget(p, params.uid); if (!m) throw notFound('member not found');
    p.members = p.members.filter(x => x !== m);
    return [204];
  });
  route('PUT', '/api/projects/:id/workflow', ({ user, params, body }) => {
    const { p } = getProj(user, params.id, 'lead');
    const { statuses, transitions, remap } = body || {};
    if (!Array.isArray(statuses) || !statuses.length) throw bad('statuses required');
    const names = new Set();
    for (const s of statuses) {
      if (!s || !isStr(s.name) || !s.name.trim()) throw bad('status name required');
      if (!CATS.includes(s.category)) throw bad('invalid status category');
      if (names.has(s.name)) throw bad('duplicate status name');
      names.add(s.name);
    }
    let trans = transitions;
    if (trans === undefined) { trans = []; for (const a of names) for (const b of names) if (a !== b) trans.push([a, b]); }
    if (!Array.isArray(trans) || trans.some(t => !Array.isArray(t) || t.length !== 2 || !names.has(t[0]) || !names.has(t[1]))) throw bad('transitions must be [from, to] pairs of existing statuses');
    if (remap !== undefined && (typeof remap !== 'object' || remap === null || Array.isArray(remap))) throw bad('remap must be an object');
    const rm = remap || {};
    for (const [from, to] of Object.entries(rm)) if (!isStr(to) || !names.has(to)) throw bad(`remap target ${to} is not a status`);
    const issues = db.issues.filter(i => i.projectId === p.id);
    const removed = new Set(p.workflow.statuses.map(s => s.name).filter(n => !names.has(n)));
    for (const i of issues) if (removed.has(i.status) && !(i.status in rm)) throw bad(`status "${i.status}" is in use and needs a remap`);
    for (const i of issues) {
      if (removed.has(i.status)) {
        const from = i.status;
        const newCat = statuses.find(s => s.name === rm[from]).category;
        setStatusWith(i, rm[from], newCat);
        hist(i, 'status', from, rm[from], user.id); i.updatedAt = iso();
      } else {
        const newCat = statuses.find(s => s.name === i.status).category;
        if (newCat !== catOf(p, i.status)) { setStatusWith(i, i.status, newCat); }
      }
    }
    p.workflow = { statuses: statuses.map(s => ({ name: s.name, category: s.category })), transitions: trans.map(t => [t[0], t[1]]) };
    audit(p.workspaceId, 'workflow.updated', user.id, { projectId: p.id });
    return [200, outProj(p, user)];
  });
  function setStatusWith(i, status, cat) {
    const t = iso(); i.status = status;
    if (cat === 'completed') { if (!i.resolvedAt) { i.resolvedAt = t; i._resolveLog.push({ at: t, resolved: true }); } }
    else if (i.resolvedAt) { i.resolvedAt = null; i._resolveLog.push({ at: t, resolved: false }); }
    if (cat === 'started' && !i._startedAt) i._startedAt = t;
  }

  // issues
  route('POST', '/api/projects/:id/issues', ({ user, params, body }) => {
    const { p } = getProj(user, params.id, 'write');
    const i = createIssue(p, user, body || {});
    fire('issue.created', i, user.id);
    return [201, outIssue(i, true)];
  });
  route('GET', '/api/projects/:id/issues', ({ user, params }) => {
    const { p } = getProj(user, params.id);
    return [200, db.issues.filter(i => i.projectId === p.id).map(i => outIssue(i))];
  });
  route('GET', '/api/issues/:key', ({ user, params }) => [200, outIssue(getIssue(user, params.key).i, true)]);
  route('PATCH', '/api/issues/:key', ({ user, params, body }) => {
    const { i, p } = getIssue(user, params.key, 'write');
    if (updateIssue(i, p, user, body || {})) fire('issue.updated', i, user.id);
    return [200, outIssue(i, true)];
  });
  route('DELETE', '/api/issues/:key', ({ user, params }) => {
    const { i } = getIssue(user, params.key, 'write');
    fire('issue.deleted', i, user.id);
    deleteIssue(i);
    return [204];
  });
  route('GET', '/api/issues/:key/history', ({ user, params }) => [200, getIssue(user, params.key).i._history]);

  route('POST', '/api/issues/:key/links', ({ user, params, body }) => {
    const { i } = getIssue(user, params.key, 'write');
    const { type, target } = body || {};
    if (!LINK_TYPES.includes(type)) throw bad('invalid link type');
    if (!isStr(target)) throw bad('target required');
    const t = issueByKey(target); if (!t) throw notFound('target issue not found');
    if (!projRole(user, projById(t.projectId))) throw notFound('target issue not found');
    if (t.id === i.id) throw bad('cannot link an issue to itself');
    if (db.links.some(l => (l.from === i.id && l.to === t.id && l.type === type) || (type === 'relates' && l.from === t.id && l.to === i.id && l.type === type))) throw conflict('link exists');
    const l = { id: uid(), type, from: i.id, to: t.id };
    db.links.push(l);
    hist(i, 'links', null, `${type} ${t.key}`, user.id);
    return [201, { id: l.id, type, source: i.key, target: t.key, links: outIssue(i).links }];
  });
  route('DELETE', '/api/issues/:key/links/:id', ({ user, params }) => {
    const { i } = getIssue(user, params.key, 'write');
    const l = db.links.find(l => l.id === params.id && (l.from === i.id || l.to === i.id)); if (!l) throw notFound('link not found');
    db.links = db.links.filter(x => x !== l);
    return [204];
  });

  // watchers
  route('POST', '/api/issues/:key/watch', ({ user, params }) => {
    const { i } = getIssue(user, params.key);
    if (!i.watchers.includes(user.id)) i.watchers.push(user.id);
    return [200, outIssue(i, true)];
  });
  route('DELETE', '/api/issues/:key/watch', ({ user, params }) => {
    const { i } = getIssue(user, params.key);
    i.watchers = i.watchers.filter(w => w !== user.id);
    return [200, outIssue(i, true)];
  });

  // comments
  route('POST', '/api/issues/:key/comments', ({ user, params, body }) => {
    const { i } = getIssue(user, params.key, 'write');
    if (!isStr(body?.body) || !body.body.trim()) throw bad('body required');
    const t = iso();
    const c = { id: uid(), issueId: i.id, issueKey: i.key, authorId: user.id, body: body.body, edited: false, createdAt: t, updatedAt: t };
    db.comments.push(c);
    const mentioned = new Set();
    for (const m of body.body.matchAll(/@([A-Za-z0-9_.-]+)/g)) {
      const u = userByName(m[1].replace(/[.-]+$/, ''));
      if (u) mentioned.add(u.id);
    }
    notify([...mentioned], 'mention', i, user.id);
    notify(i.watchers.filter(w => !mentioned.has(w)), 'comment', i, user.id);
    fire('comment.created', i, user.id, { comment: outComment(c) });
    return [201, outComment(c)];
  });
  route('GET', '/api/issues/:key/comments', ({ user, params }) => {
    const { i } = getIssue(user, params.key);
    return [200, db.comments.filter(c => c.issueId === i.id).map(outComment)];
  });
  route('PATCH', '/api/comments/:id', ({ user, params, body }) => {
    const c = db.comments.find(c => c.id === params.id); if (!c) throw notFound('comment not found');
    getIssue(user, c.issueKey);
    if (c.authorId !== user.id) throw forbidden('only the author can edit');
    if (!isStr(body?.body) || !body.body.trim()) throw bad('body required');
    c.body = body.body; c.edited = true; c.updatedAt = iso();
    return [200, outComment(c)];
  });
  route('DELETE', '/api/comments/:id', ({ user, params }) => {
    const c = db.comments.find(c => c.id === params.id); if (!c) throw notFound('comment not found');
    const { role } = getIssue(user, c.issueKey);
    if (c.authorId !== user.id && role !== 'lead') throw forbidden();
    db.comments = db.comments.filter(x => x !== c);
    return [204];
  });

  // notifications
  route('GET', '/api/notifications', ({ user, query }) => {
    let l = db.notifications.filter(n => n.userId === user.id);
    if (query.get('unread') === 'true') l = l.filter(n => !n.read);
    l = l.sort((a, b) => b.seq - a.seq);
    return [200, l.map(n => ({ id: n.id, type: n.type, issueKey: n.issueKey, actorId: n.actorId, at: n.at, read: n.read }))];
  });
  route('POST', '/api/notifications/read', ({ user, body }) => {
    const mine = db.notifications.filter(n => n.userId === user.id);
    let n = 0;
    if (body?.all === true) { for (const x of mine) if (!x.read) { x.read = true; n++; } }
    else if (Array.isArray(body?.ids)) { for (const x of mine) if (body.ids.includes(x.id) && !x.read) { x.read = true; n++; } }
    else throw bad('ids or all required');
    return [200, { updated: n }];
  });

  // sprints
  route('POST', '/api/projects/:id/sprints', ({ user, params, body }) => {
    const { p } = getProj(user, params.id, 'write');
    const { name, startDate, endDate } = body || {};
    if (!isStr(name) || !name.trim()) throw bad('name required');
    if (startDate != null && !isDate(startDate)) throw bad('invalid startDate');
    if (endDate != null && !isDate(endDate)) throw bad('invalid endDate');
    if (startDate && endDate && endDate < startDate) throw bad('endDate before startDate');
    const s = { id: uid(), projectId: p.id, name: name.trim(), startDate: startDate || null, endDate: endDate || null, state: 'planned', createdAt: iso(), everIds: [] };
    db.sprints.push(s);
    return [201, outSprint(s)];
  });
  route('GET', '/api/projects/:id/sprints', ({ user, params }) => [200, db.sprints.filter(s => s.projectId === getProj(user, params.id).p.id).map(outSprint)]);
  const getSprint = (user, id, need) => { const s = sprintById(id); if (!s) throw notFound('sprint not found'); getProj(user, s.projectId, need); return s; };
  route('GET', '/api/sprints/:id', ({ user, params }) => [200, outSprint(getSprint(user, params.id))]);
  route('POST', '/api/sprints/:id/start', ({ user, params }) => {
    const s = getSprint(user, params.id, 'write');
    if (s.state !== 'planned') throw conflict('sprint is not planned');
    if (db.sprints.some(x => x.projectId === s.projectId && x.state === 'active')) throw conflict('another sprint is already active');
    s.state = 'active'; s.startedAt = iso();
    if (!s.startDate) s.startDate = s.startedAt.slice(0, 10);
    const cur = db.issues.filter(i => i.sprintId === s.id);
    s.committedIds = cur.map(i => i.id);
    s.committedPoints = cur.reduce((a, i) => a + (i.storyPoints || 0), 0);
    return [200, outSprint(s)];
  });
  route('POST', '/api/sprints/:id/complete', ({ user, params, body }) => {
    const s = getSprint(user, params.id, 'write');
    if (s.state !== 'active') throw conflict('sprint is not active');
    const target = body?.carryOverTo ?? 'backlog';
    let ts = null;
    if (target !== 'backlog') {
      ts = isStr(target) && sprintById(target);
      if (!ts || ts.projectId !== s.projectId || ts.id === s.id || ts.state === 'completed') throw bad('invalid carryOverTo');
    }
    const p = projById(s.projectId);
    s.completedIds = []; s.carriedOver = 0;
    for (const i of db.issues.filter(i => i.sprintId === s.id)) {
      if (isDone(i)) { s.completedIds.push(i.id); continue; }
      hist(i, 'sprintId', s.id, ts ? ts.id : null, user.id);
      i.sprintId = ts ? ts.id : null; i.updatedAt = iso(); s.carriedOver++;
      addToSprintLog(i);
    }
    s.state = 'completed'; s.completedAt = iso();
    void p;
    return [200, outSprint(s)];
  });
  route('GET', '/api/sprints/:id/report', ({ user, params }) => [200, sprintReport(getSprint(user, params.id))]);

  route('GET', '/api/projects/:id/stats', ({ user, params }) => {
    const { p } = getProj(user, params.id);
    const issues = db.issues.filter(i => i.projectId === p.id);
    const byStatus = {}; for (const s of p.workflow.statuses) byStatus[s.name] = 0;
    const byType = {}; const byAssignee = {};
    for (const i of issues) {
      byStatus[i.status] = (byStatus[i.status] || 0) + 1;
      byType[i.type] = (byType[i.type] || 0) + 1;
      const a = i.assigneeId ? userById(i.assigneeId)?.username : 'unassigned';
      byAssignee[a] = (byAssignee[a] || 0) + 1;
    }
    const times = issues.filter(i => i.resolvedAt && i._startedAt).map(i => (Date.parse(i.resolvedAt) - Date.parse(i._startedAt)) / 3600000);
    const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length : null;
    return [200, { total: issues.length, byStatus, byType, byAssignee, avgCycleTimeHours: avg, averageCycleTimeHours: avg }];
  });

  // search
  route('GET', '/api/search', ({ user, query }) => {
    const q = query.get('q') || '';
    let terms;
    try { terms = parseQuery(q); } catch (e) { if (e instanceof QueryError) throw bad(e.message); throw e; }
    const sort = query.get('sort') || 'updated';
    if (!['updated', 'created', 'priority'].includes(sort)) throw bad('invalid sort');
    let projects = db.projects.filter(p => projRole(user, p));
    const pf = query.get('project');
    if (pf) projects = projects.filter(p => p.id === pf || p.key === pf);
    const ctx = { me: user.id, userByName, sprintById, categoryOf: (i) => catOf(projById(i.projectId), i.status) };
    const ids = new Set(projects.map(p => p.id));
    const res = db.issues.filter(i => ids.has(i.projectId) && terms.every(t => matches(i, t, ctx)));
    const idx = new Map(db.issues.map((x, n) => [x, n]));
    const rank = (i) => PRIOS.indexOf(i.priority);
    res.sort((a, b) => {
      let c = 0;
      if (sort === 'priority') c = rank(a) - rank(b);
      else if (sort === 'created') c = b.createdAt < a.createdAt ? -1 : b.createdAt > a.createdAt ? 1 : 0;
      else c = b.updatedAt < a.updatedAt ? -1 : b.updatedAt > a.updatedAt ? 1 : 0;
      return c || idx.get(b) - idx.get(a);
    });
    return [200, res.map(i => outIssue(i))];
  });

  // import/export
  const HEADER = ['key', 'type', 'title', 'status', 'priority', 'assignee', 'labels', 'storyPoints', 'parent', 'epic', 'sprint', 'dueDate', 'createdAt', 'resolvedAt'];
  route('GET', '/api/projects/:id/export.csv', ({ user, params }) => {
    const { p } = getProj(user, params.id);
    const rows = [HEADER];
    for (const i of db.issues.filter(i => i.projectId === p.id)) {
      rows.push([i.key, i.type, i.title, i.status, i.priority, i.assigneeId ? userById(i.assigneeId)?.username : '', i.labels.join(';'), i.storyPoints ?? '', i.parentId ? issueById(i.parentId)?.key : '', i.epicId ? issueById(i.epicId)?.key : '', i.sprintId ? sprintById(i.sprintId)?.name : '', i.dueDate || '', i.createdAt, i.resolvedAt || '']);
    }
    return [200, toCsv(rows), 'text/csv; charset=utf-8'];
  });
  route('POST', '/api/projects/:id/import.csv', ({ user, params, rawBody }) => {
    const { p } = getProj(user, params.id, 'write');
    let rows;
    try { rows = parseCsv(rawBody); } catch (e) { throw bad('malformed CSV: ' + e.message); }
    if (!rows.length) throw bad('empty CSV');
    const head = rows[0].fields.map(h => h.trim());
    if (!head.includes('title') || !head.includes('type')) throw bad('CSV header must include type and title');
    const errors = []; let created = 0;
    for (const { line, fields } of rows.slice(1)) {
      const r = {}; head.forEach((h, n) => { r[h] = (fields[n] ?? '').trim(); });
      try {
        if (fields.length > head.length) throw bad('too many columns');
        const b = { title: r.title, type: r.type || 'task' };
        if (!r.title) throw bad('title required');
        if (r.priority) b.priority = r.priority;
        if (r.description) b.description = r.description;
        if (r.assignee) { const u = userByName(r.assignee); if (!u) throw bad(`unknown assignee ${r.assignee}`); b.assigneeId = u.id; }
        if (r.labels) b.labels = r.labels.split(';').map(s => s.trim()).filter(Boolean);
        if (r.storyPoints) { const n = Number(r.storyPoints); if (isNaN(n)) throw bad('invalid storyPoints'); b.storyPoints = n; }
        if (r.parent) { const x = issueByKey(r.parent); if (!x || x.projectId !== p.id) throw bad(`unknown parent ${r.parent}`); b.parentId = x.id; }
        if (r.epic) { const x = issueByKey(r.epic); if (!x || x.projectId !== p.id) throw bad(`unknown epic ${r.epic}`); b.epicId = x.id; }
        if (r.sprint) { const s = db.sprints.find(s => s.projectId === p.id && (s.name === r.sprint || s.id === r.sprint)); if (!s) throw bad(`unknown sprint ${r.sprint}`); b.sprintId = s.id; }
        if (r.dueDate) b.dueDate = r.dueDate;
        if (r.status) b.status = r.status;
        const i = createIssue(p, user, b);
        created++;
        fire('issue.created', i, user.id);
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        errors.push({ line, message: e.message });
      }
    }
    return [200, { created, errors }];
  });

  // webhooks
  route('POST', '/api/projects/:id/webhooks', ({ user, params, body }) => {
    const { p } = getProj(user, params.id, 'lead');
    const { url, events, secret } = body || {};
    let u; try { u = new URL(url); } catch { throw bad('invalid url'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw bad('invalid url');
    if (!Array.isArray(events) || !events.length || events.some(e => !EVENTS.includes(e))) throw bad('invalid events');
    if (!isStr(secret) || !secret) throw bad('secret required');
    const h = { id: uid(), projectId: p.id, url, events: [...new Set(events)], secret, createdAt: iso() };
    db.webhooks.push(h);
    audit(p.workspaceId, 'webhook.created', user.id, { webhookId: h.id, projectId: p.id, url });
    return [201, outHook(h)];
  });
  route('GET', '/api/projects/:id/webhooks', ({ user, params }) => {
    const { p } = getProj(user, params.id, 'lead');
    return [200, db.webhooks.filter(h => h.projectId === p.id).map(outHook)];
  });
  const getHook = (user, id) => { const h = db.webhooks.find(h => h.id === id); if (!h) throw notFound('webhook not found'); const { p } = getProj(user, h.projectId, 'lead'); return { h, p }; };
  route('DELETE', '/api/webhooks/:id', ({ user, params }) => {
    const { h, p } = getHook(user, params.id);
    db.webhooks = db.webhooks.filter(x => x !== h);
    audit(p.workspaceId, 'webhook.deleted', user.id, { webhookId: h.id, projectId: p.id });
    return [204];
  });
  route('GET', '/api/webhooks/:id/deliveries', ({ user, params }) => {
    const { h } = getHook(user, params.id);
    return [200, db.deliveries.filter(d => d.webhookId === h.id)];
  });

  // ---------- http plumbing ----------
  function send(res, status, payload, ctype) {
    if (status === 204) { res.writeHead(204); return res.end(); }
    const data = ctype ? payload : JSON.stringify(payload);
    res.writeHead(status, { 'content-type': ctype || 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
    res.end(data);
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []; let n = 0;
      req.on('data', c => { n += c.length; if (n > 10e6) { reject(new HttpError(400, 'validation_error', 'body too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }
  function authenticate(req) {
    const h = req.headers.authorization || '';
    const m = /^Bearer\s+(\S+)$/i.exec(h);
    if (!m) return null;
    const hash = sha(m[1]);
    const s = db.sessions.find(s => s.hash === hash);
    if (s) { const user = userById(s.userId); return user ? { user, session: s } : null; }
    const t = db.tokens.find(t => t.hash === hash);
    if (t) { const user = userById(t.userId); return user ? { user, session: null } : null; }
    return null;
  }
  function serveStatic(res, pathname) {
    let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/static\//, '');
    const file = path.resolve(STATIC_DIR, rel);
    if (!file.startsWith(STATIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: 'not_found', message: 'not found' });
    send(res, 200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream');
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const pathname = url.pathname;
      if (req.method === 'GET' && (pathname === '/' || pathname.startsWith('/static/'))) return serveStatic(res, pathname);
      let match = null; let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== req.method) continue;
        match = { r, m }; break;
      }
      if (!match) {
        if (pathMatched) throw new HttpError(405, 'method_not_allowed', 'method not allowed');
        throw notFound('route not found');
      }
      const { r, m } = match;
      const params = {}; r.keys.forEach((k, n) => { params[k] = decodeURIComponent(m[n + 1]); });
      let auth = null;
      if (r.auth) { auth = authenticate(req); if (!auth) throw new HttpError(401, 'unauthorized', 'authentication required'); }
      let body; let rawBody = '';
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        rawBody = await readBody(req);
        const ct = req.headers['content-type'] || '';
        if (rawBody && !/csv|text\/plain/.test(ct)) {
          try { body = JSON.parse(rawBody); } catch { throw bad('invalid JSON body'); }
        }
      }
      const out = r.handler({ req, user: auth?.user, session: auth?.session, params, query: url.searchParams, body, rawBody });
      if (req.method !== 'GET') { try { save(); } catch { /* ignore */ } }
      send(res, out[0] ?? 200, out[1], out[2]);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.error, message: e.message });
      console.error(e);
      send(res, 500, { error: 'internal_error', message: 'internal error' });
    }
  });
  return server;
}
