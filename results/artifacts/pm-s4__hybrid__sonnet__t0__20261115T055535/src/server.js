import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { toCsv, parseCsv } from './csv.js';
import { parseQuery, matches, QueryError } from './search.js';

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');
class HttpError extends Error { constructor(status, code, message) { super(message || code); this.status = status; this.code = code; } }
const bad = m => new HttpError(400, 'validation_error', m);
const forbidden = m => new HttpError(403, 'forbidden', m || 'forbidden');
const notFound = m => new HttpError(404, 'not_found', m || 'not found');
const conflict = (m, code = 'conflict') => new HttpError(409, code, m);

const CATS = ['backlog', 'unstarted', 'started', 'completed'];
const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIOS = ['urgent', 'high', 'medium', 'low', 'none'];
const WS_ROLES = ['admin', 'member', 'guest'];
const PROJ_ROLES = ['lead', 'developer', 'viewer'];
const EVENTS = ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'];
const LINK_TYPES = ['blocks', 'relates', 'duplicates'];
const INVERSE = { blocks: 'blocked_by', relates: 'relates', duplicates: 'duplicated_by' };
const DEFAULT_STATUSES = [['Backlog', 'backlog'], ['Todo', 'unstarted'], ['In Progress', 'started'], ['In Review', 'started'], ['Done', 'completed']];

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const uid = () => crypto.randomUUID();
const isStr = v => typeof v === 'string' && v.trim() !== '';
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pw, salt, 32).toString('hex') };
}
function checkPw(pw, u) {
  const h = Buffer.from(crypto.scryptSync(pw, u.salt, 32).toString('hex'));
  const e = Buffer.from(u.hash);
  return h.length === e.length && crypto.timingSafeEqual(h, e);
}

export function createServer({ dataFile, clock } = {}) {
  const now = () => (clock ? clock() : new Date());
  const iso = () => now().toISOString();
  let S = { users: [], sessions: [], apiTokens: [], workspaces: [], projects: [], issues: [], comments: [], sprints: [], notifications: [], webhooks: [], deliveries: [], audit: [] };
  if (dataFile && fs.existsSync(dataFile)) {
    try { S = { ...S, ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) }; } catch { /* ignore */ }
  }
  const failures = new Map(); // username -> [ms]
  const save = () => {
    if (!dataFile) return;
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(S)); fs.renameSync(tmp, dataFile);
  };

  // ---------- lookups ----------
  const userById = id => S.users.find(u => u.id === id);
  const userByName = n => typeof n === 'string' ? S.users.find(u => u.username.toLowerCase() === n.toLowerCase()) : undefined;
  const pubUser = u => ({ id: u.id, username: u.username, displayName: u.displayName });
  const wsById = id => S.workspaces.find(w => w.id === id);
  const projById = id => S.projects.find(p => p.id === id);
  const issueByKey = k => S.issues.find(i => i.key === k);
  const issueById = id => S.issues.find(i => i.id === id);
  const issueRef = r => typeof r === 'string' ? (issueById(r) || issueByKey(r)) : undefined;
  const sprintById = id => S.sprints.find(s => s.id === id);
  const usernameOf = id => userById(id)?.username;

  const wsRole = (u, ws) => ws.members.find(m => m.userId === u.id)?.role || null;
  function projRole(u, p) {
    const ws = wsById(p.workspaceId); const r = wsRole(u, ws);
    if (!r) return null;
    if (r === 'admin') return 'lead';
    const pm = p.members.find(m => m.userId === u.id);
    if (pm) return pm.role;
    return r === 'member' ? 'developer' : null;
  }
  const RANK = { viewer: 1, developer: 2, lead: 3 };
  function needProj(u, p, min = 'viewer') {
    const r = projRole(u, p);
    if (!r || RANK[r] < RANK[min]) throw forbidden();
    return r;
  }
  function needWs(u, ws, roles) {
    const r = wsRole(u, ws);
    if (!r || (roles && !roles.includes(r))) throw forbidden();
    return r;
  }
  const getProject = id => projById(id) || (() => { throw notFound('project not found'); })();
  const getWs = id => wsById(id) || (() => { throw notFound('workspace not found'); })();
  const getIssue = k => issueByKey(k) || (() => { throw notFound('issue not found'); })();
  const getSprint = id => sprintById(id) || (() => { throw notFound('sprint not found'); })();

  function audit(wsId, action, actor, details) {
    S.audit.push({ id: uid(), workspaceId: wsId, action, actorId: actor?.id || null, at: iso(), details: details || {} });
  }

  // ---------- views ----------
  const pubProject = p => ({ id: p.id, workspaceId: p.workspaceId, name: p.name, key: p.key, workflow: p.workflow, members: p.members.map(m => ({ ...m, username: usernameOf(m.userId) })), createdAt: p.createdAt });
  const pubWs = w => ({ id: w.id, name: w.name, key: w.key, createdAt: w.createdAt, members: w.members.map(m => ({ ...m, username: usernameOf(m.userId) })) });
  function isResolvedCat(p, status) { return p.workflow.statuses.find(s => s.name === status)?.category === 'completed'; }
  function issueView(i, full = true) {
    const o = {};
    for (const k of Object.keys(i)) if (!k.startsWith('_')) o[k] = i[k];
    if (!full) return o;
    const links = [];
    for (const x of S.issues) {
      for (const l of x.links) {
        if (x.id === i.id) { const t = issueById(l.targetId); if (t) links.push({ id: l.id, type: l.type, key: t.key, issueId: t.id }); }
        else if (l.targetId === i.id) links.push({ id: l.id, type: INVERSE[l.type], key: x.key, issueId: x.id });
      }
    }
    o.links = links;
    o.children = S.issues.filter(c => c.parentId === i.id).map(c => c.key);
    if (i.type === 'epic') {
      const p = projById(i.projectId); const m = S.issues.filter(c => c.epicId === i.id);
      const d = m.filter(c => isResolvedCat(p, c.status));
      const sum = a => a.reduce((s, c) => s + (c.storyPoints || 0), 0);
      o.progress = { total: m.length, done: d.length, points_total: sum(m), points_done: sum(d) };
    }
    delete o.links_; return o;
  }
  const storedIssue = i => i; // alias

  // ---------- notifications / webhooks ----------
  function canSee(userId, p) { const u = userById(userId); return !!u && !!projRole(u, p); }
  function notify(userIds, type, issue, actor, p) {
    for (const id of new Set(userIds)) {
      if (id === actor.id || !canSee(id, p)) continue;
      S.notifications.push({ id: uid(), userId: id, type, issueKey: issue.key, actorId: actor.id, at: iso(), read: false });
    }
  }
  async function deliver(wh, d, body) {
    for (let a = 1; a <= 3; a++) {
      d.attempts = a;
      try {
        const sig = crypto.createHmac('sha256', wh.secret).update(body).digest('hex');
        const r = await fetch(wh.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pm-signature': 'sha256=' + sig }, body, signal: AbortSignal.timeout(5000) });
        d.status = r.status;
        if (r.status >= 200 && r.status < 300) { d.lastError = null; break; }
        d.lastError = 'HTTP ' + r.status;
      } catch (e) { d.status = null; d.lastError = String(e.message || e); }
      save();
      if (a < 3) await new Promise(r => setTimeout(r, 30 * a));
    }
    save();
  }
  function emit(event, issue, actor, extra = {}) {
    const p = projById(issue.projectId);
    for (const wh of S.webhooks.filter(w => w.projectId === p.id && w.events.includes(event))) {
      const body = JSON.stringify({ event, issue: issueView(issue), actorId: actor?.id || null, at: iso(), ...extra });
      const d = { id: uid(), webhookId: wh.id, event, status: null, attempts: 0, lastError: null, createdAt: iso() };
      S.deliveries.push(d);
      deliver(wh, d, body).catch(() => {});
    }
  }

  // ---------- history helpers ----------
  function record(issue, field, from, to, actor, hidden = false) {
    if (sameJson(from, to)) return;
    const h = { field, from, to, actorId: actor?.id || null, at: iso() };
    if (hidden) h.hidden = true;
    issue._history.push(h);
  }
  function valueAt(issue, field, t) {
    const e = issue._history.find(h => h.field === field && new Date(h.at) > t);
    return e ? e.from : issue[field];
  }

  // ---------- issue logic ----------
  function statusCat(p, name) { return p.workflow.statuses.find(s => s.name === name)?.category; }
  function checkRefs(p, i) {
    if (i.parentId != null) {
      const par = issueById(i.parentId);
      if (!par) throw bad('parent not found');
      if (par.projectId !== p.id) throw bad('parent must be in same project');
      if (par.type === 'subtask') throw bad('parent cannot be a subtask');
      if (i.type === 'epic') throw bad('epics cannot have parents');
      if (par.id === i.id) throw bad('self parent');
    } else if (i.type === 'subtask') throw bad('subtask requires parentId');
    if (i.epicId != null) {
      const e = issueById(i.epicId);
      if (!e || e.projectId !== p.id || e.type !== 'epic') throw bad('epicId must reference an epic in the project');
    }
    if (i.sprintId != null) { const s = sprintById(i.sprintId); if (!s || s.projectId !== p.id) throw bad('sprint not found in project'); }
  }
  function normalizeFields(p, b, target, isCreate) {
    const t = target;
    if ('title' in b) { if (!isStr(b.title)) throw bad('title required'); t.title = b.title.trim(); }
    if ('description' in b) { if (b.description != null && typeof b.description !== 'string') throw bad('description must be string'); t.description = b.description ?? ''; }
    if ('type' in b) { if (!TYPES.includes(b.type)) throw bad('invalid type'); t.type = b.type; }
    if ('priority' in b) { if (!PRIOS.includes(b.priority)) throw bad('invalid priority'); t.priority = b.priority; }
    if ('labels' in b) { if (!Array.isArray(b.labels) || b.labels.some(l => typeof l !== 'string')) throw bad('labels must be string array'); t.labels = [...new Set(b.labels)]; }
    if ('storyPoints' in b) { if (b.storyPoints != null && (typeof b.storyPoints !== 'number' || !isFinite(b.storyPoints) || b.storyPoints < 0)) throw bad('invalid storyPoints'); t.storyPoints = b.storyPoints ?? null; }
    if ('dueDate' in b) { if (b.dueDate != null && (typeof b.dueDate !== 'string' || isNaN(Date.parse(b.dueDate)))) throw bad('invalid dueDate'); t.dueDate = b.dueDate ?? null; }
    if ('assigneeId' in b || 'assignee' in b) {
      let id = b.assigneeId;
      if (!('assigneeId' in b)) { if (b.assignee == null) id = null; else { const u = userByName(b.assignee); if (!u) throw bad('unknown assignee'); id = u.id; } }
      if (id != null) {
        const u = userById(id);
        if (!u) throw bad('unknown assignee');
        if (!projRole(u, p)) throw bad('assignee has no access to project');
      }
      t.assigneeId = id ?? null;
    }
    for (const [f, rf] of [['parentId', 'parent'], ['epicId', 'epic']]) {
      if (f in b) {
        if (b[f] == null) t[f] = null;
        else { const r = issueRef(b[f]); if (!r) throw bad(f + ' not found'); t[f] = r.id; }
      }
    }
    if ('sprintId' in b) { if (b.sprintId != null && !sprintById(b.sprintId)) throw bad('sprint not found'); t.sprintId = b.sprintId ?? null; }
  }
  function setStatus(issue, p, status, actor) {
    const from = issue.status;
    if (from === status) return;
    const cat = statusCat(p, status);
    if (!cat) throw bad('unknown status');
    if (!p.workflow.transitions.some(([a, b]) => a === from && b === status)) throw conflict(`transition ${from} -> ${status} not allowed`, 'invalid_transition');
    if (cat === 'completed') {
      const blockers = S.issues.filter(x => !x.resolvedAt && x.links.some(l => l.type === 'blocks' && l.targetId === issue.id));
      if (blockers.length) throw conflict('blocked by ' + blockers.map(b => b.key).join(','), 'blocked');
    }
    applyStatus(issue, p, status, actor);
  }
  function applyStatus(issue, p, status, actor) {
    const from = issue.status; const cat = statusCat(p, status);
    issue.status = status; record(issue, 'status', from, status, actor);
    if (cat === 'started' && !issue._startedAt) issue._startedAt = iso();
    if (cat === 'completed' && !issue.resolvedAt) { issue.resolvedAt = iso(); record(issue, 'resolvedAt', null, issue.resolvedAt, actor, true); if (!issue._startedAt) issue._startedAt = issue.resolvedAt; }
    else if (cat !== 'completed' && issue.resolvedAt) { record(issue, 'resolvedAt', issue.resolvedAt, null, actor, true); issue.resolvedAt = null; }
  }
  function createIssue(p, b, actor) {
    if (!isObj(b)) throw bad('body required');
    if (!isStr(b.title)) throw bad('title required');
    const type = b.type ?? 'task';
    if (!TYPES.includes(type)) throw bad('invalid type');
    const initial = p.workflow.statuses.find(s => s.category === 'unstarted') || p.workflow.statuses[0];
    const t = { id: uid(), key: null, projectId: p.id, type, title: '', description: '', status: initial.name, priority: 'none', assigneeId: null, reporterId: actor.id, labels: [], storyPoints: null, parentId: null, epicId: null, sprintId: null, dueDate: null, watchers: [], createdAt: iso(), updatedAt: iso(), resolvedAt: null, links: [], _history: [], _startedAt: null };
    normalizeFields(p, b, t, true);
    if (b.status != null) { if (!statusCat(p, b.status)) throw bad('unknown status'); t.status = b.status; }
    checkRefs(p, t);
    p.nextNumber = (p.nextNumber || 1);
    t.key = `${p.key}-${p.nextNumber++}`;
    const cat = statusCat(p, t.status);
    if (cat === 'started') t._startedAt = t.createdAt;
    if (cat === 'completed') { t.resolvedAt = t.createdAt; t._startedAt = t.createdAt; }
    t.watchers = [...new Set([t.reporterId, t.assigneeId].filter(Boolean))];
    S.issues.push(t);
    emit('issue.created', t, actor);
    return t;
  }
  function updateIssue(issue, b, actor) {
    if (!isObj(b)) throw bad('body required');
    const p = projById(issue.projectId);
    const snap = JSON.parse(JSON.stringify({ ...issue, _history: undefined }));
    const draft = { ...issue };
    const fieldsB = { ...b }; delete fieldsB.status;
    normalizeFields(p, fieldsB, draft, false);
    checkRefs(p, draft);
    if ('type' in b && draft.type !== issue.type && draft.type === 'epic' && issue.parentId) throw bad('epics cannot have parents');
    const statusChange = b.status !== undefined && b.status !== issue.status;
    if (b.status !== undefined && !isStr(b.status)) throw bad('invalid status');
    if (statusChange) setStatusDryRun(issue, p, b.status);
    // apply
    const keys = ['title', 'description', 'type', 'priority', 'labels', 'storyPoints', 'dueDate', 'assigneeId', 'parentId', 'epicId', 'sprintId'];
    const changed = [];
    for (const k of keys) if (!sameJson(issue[k], draft[k])) { record(issue, k, issue[k], draft[k], actor); issue[k] = draft[k]; changed.push(k); }
    let statusFrom = issue.status;
    if (statusChange) { applyStatus(issue, p, b.status, actor); changed.push('status'); }
    if (!changed.length) return;
    issue.updatedAt = iso();
    if (changed.includes('assigneeId') && issue.assigneeId && !issue.watchers.includes(issue.assigneeId)) issue.watchers.push(issue.assigneeId);
    if (changed.includes('status')) notify(issue.watchers, 'status_changed', issue, actor, p);
    if (changed.includes('assigneeId') && issue.assigneeId) notify([issue.assigneeId, ...issue.watchers], 'assigned', issue, actor, p);
    emit('issue.updated', issue, actor, { changes: changed });
    void snap; void statusFrom;
  }
  function setStatusDryRun(issue, p, status) {
    const copy = { ...issue, _history: [...issue._history] };
    const cat = statusCat(p, status);
    if (!cat) throw bad('unknown status');
    if (!p.workflow.transitions.some(([a, b]) => a === issue.status && b === status)) throw conflict(`transition ${issue.status} -> ${status} not allowed`, 'invalid_transition');
    if (cat === 'completed') {
      const blockers = S.issues.filter(x => !x.resolvedAt && x.links.some(l => l.type === 'blocks' && l.targetId === copy.id));
      if (blockers.length) throw conflict('blocked by ' + blockers.map(b => b.key).join(','), 'blocked');
    }
  }
  function deleteIssue(issue, actor) {
    const ids = new Set([issue.id]);
    for (const c of S.issues) if (c.parentId === issue.id) ids.add(c.id);
    const removed = S.issues.filter(i => ids.has(i.id));
    S.issues = S.issues.filter(i => !ids.has(i.id));
    for (const i of S.issues) {
      i.links = i.links.filter(l => !ids.has(l.targetId));
      if (ids.has(i.epicId)) i.epicId = null;
    }
    S.comments = S.comments.filter(c => !ids.has(c.issueId));
    for (const r of removed) emit('issue.deleted', r, actor);
  }

  // ---------- auth ----------
  function authenticate(req) {
    const h = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) throw new HttpError(401, 'unauthenticated', 'authentication required');
    const hash = sha(m[1].trim());
    const s = S.sessions.find(x => x.hash === hash) || S.apiTokens.find(x => x.hash === hash);
    const u = s && userById(s.userId);
    if (!u) throw new HttpError(401, 'unauthenticated', 'invalid token');
    req.tokenHash = hash;
    return u;
  }

  // ---------- routing ----------
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const names = []; const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '$');
    routes.push({ method, re, names, handler, auth: opts.auth !== false });
  };
  const json = (code, body) => ({ code, body });
  const empty = () => ({ code: 204 });

  // auth
  route('POST', '/api/auth/register', ({ body }) => {
    if (!isObj(body)) throw bad('body required');
    if (!isStr(body.username) || !/^[A-Za-z0-9_.-]{2,32}$/.test(body.username)) throw bad('invalid username');
    if (typeof body.password !== 'string' || body.password.length < 6) throw bad('password must be at least 6 characters');
    if (body.displayName != null && typeof body.displayName !== 'string') throw bad('invalid displayName');
    if (userByName(body.username)) throw conflict('username taken');
    const { salt, hash } = hashPw(body.password);
    const u = { id: uid(), username: body.username, displayName: body.displayName || body.username, salt, hash, createdAt: iso() };
    S.users.push(u);
    return json(201, { user: pubUser(u) });
  }, { auth: false });
  route('POST', '/api/auth/login', ({ body }) => {
    if (!isObj(body) || !isStr(body.username) || typeof body.password !== 'string') throw bad('username and password required');
    const name = body.username.toLowerCase(); const t = now().getTime();
    const list = (failures.get(name) || []).filter(x => t - x < 15 * 60000); failures.set(name, list);
    if (list.length >= 5) throw new HttpError(429, 'rate_limited', 'too many failed attempts');
    const u = userByName(body.username);
    if (!u || !checkPw(body.password, u)) { list.push(t); throw new HttpError(401, 'unauthenticated', 'invalid credentials'); }
    failures.delete(name);
    const token = crypto.randomBytes(32).toString('hex');
    S.sessions.push({ hash: sha(token), userId: u.id, createdAt: iso() });
    return json(200, { token, user: pubUser(u) });
  }, { auth: false });
  route('POST', '/api/auth/logout', ({ req }) => { S.sessions = S.sessions.filter(s => s.hash !== req.tokenHash); return empty(); });
  route('GET', '/api/auth/me', ({ user }) => json(200, { user: pubUser(user) }));
  route('PATCH', '/api/auth/me', ({ user, body }) => {
    if (!isObj(body)) throw bad('body required');
    if (typeof body.currentPassword !== 'string') throw bad('currentPassword required');
    if (!checkPw(body.currentPassword, user)) throw forbidden('current password incorrect');
    if ('displayName' in body) { if (!isStr(body.displayName)) throw bad('invalid displayName'); user.displayName = body.displayName; }
    if ('password' in body) {
      if (typeof body.password !== 'string' || body.password.length < 6) throw bad('password must be at least 6 characters');
      Object.assign(user, hashPw(body.password));
    }
    return json(200, { user: pubUser(user) });
  });

  // api tokens
  route('POST', '/api/tokens', ({ user, body }) => {
    if (!isObj(body) || !isStr(body.name)) throw bad('name required');
    const token = 'pmt_' + crypto.randomBytes(24).toString('hex');
    const t = { id: uid(), userId: user.id, name: body.name, hash: sha(token), createdAt: iso() };
    S.apiTokens.push(t);
    for (const w of S.workspaces) if (wsRole(user, w)) audit(w.id, 'token.created', user, { tokenId: t.id, name: t.name });
    return json(201, { id: t.id, name: t.name, token });
  });
  route('GET', '/api/tokens', ({ user }) => json(200, S.apiTokens.filter(t => t.userId === user.id).map(t => ({ id: t.id, name: t.name, createdAt: t.createdAt }))));
  route('DELETE', '/api/tokens/:id', ({ user, params }) => {
    const t = S.apiTokens.find(x => x.id === params.id && x.userId === user.id);
    if (!t) throw notFound();
    S.apiTokens = S.apiTokens.filter(x => x !== t);
    for (const w of S.workspaces) if (wsRole(user, w)) audit(w.id, 'token.revoked', user, { tokenId: t.id, name: t.name });
    return empty();
  });

  // workspaces
  route('POST', '/api/workspaces', ({ user, body }) => {
    if (!isObj(body) || !isStr(body.name)) throw bad('name required');
    if (typeof body.key !== 'string' || !/^[A-Z]{2,10}$/.test(body.key)) throw bad('key must be 2-10 uppercase letters');
    if (S.workspaces.some(w => w.key === body.key)) throw conflict('workspace key exists');
    const w = { id: uid(), name: body.name.trim(), key: body.key, createdAt: iso(), members: [{ userId: user.id, role: 'admin' }] };
    S.workspaces.push(w);
    audit(w.id, 'workspace.created', user, {});
    return json(201, pubWs(w));
  });
  route('GET', '/api/workspaces', ({ user }) => json(200, S.workspaces.filter(w => wsRole(user, w)).map(pubWs)));
  route('GET', '/api/workspaces/:id', ({ user, params }) => { const w = getWs(params.id); needWs(user, w); return json(200, pubWs(w)); });
  route('POST', '/api/workspaces/:id/members', ({ user, params, body }) => {
    const w = getWs(params.id); needWs(user, w, ['admin']);
    if (!isObj(body) || !isStr(body.username)) throw bad('username required');
    if (!WS_ROLES.includes(body.role)) throw bad('invalid role');
    const u = userByName(body.username); if (!u) throw notFound('user not found');
    if (w.members.some(m => m.userId === u.id)) throw conflict('already a member');
    w.members.push({ userId: u.id, role: body.role });
    audit(w.id, 'member.added', user, { userId: u.id, username: u.username, role: body.role });
    return json(201, { userId: u.id, username: u.username, role: body.role });
  });
  const adminCount = w => w.members.filter(m => m.role === 'admin').length;
  route('PATCH', '/api/workspaces/:id/members/:uid', ({ user, params, body }) => {
    const w = getWs(params.id); needWs(user, w, ['admin']);
    const m = w.members.find(x => x.userId === params.uid); if (!m) throw notFound('member not found');
    if (!isObj(body) || !WS_ROLES.includes(body.role)) throw bad('invalid role');
    if (m.role === 'admin' && body.role !== 'admin' && adminCount(w) <= 1) throw bad('cannot demote the last admin');
    const from = m.role; m.role = body.role;
    audit(w.id, 'member.role_changed', user, { userId: m.userId, from, to: m.role });
    return json(200, { userId: m.userId, username: usernameOf(m.userId), role: m.role });
  });
  route('DELETE', '/api/workspaces/:id/members/:uid', ({ user, params }) => {
    const w = getWs(params.id); needWs(user, w, ['admin']);
    const m = w.members.find(x => x.userId === params.uid); if (!m) throw notFound('member not found');
    if (m.role === 'admin' && adminCount(w) <= 1) throw bad('cannot remove the last admin');
    w.members = w.members.filter(x => x !== m);
    for (const p of S.projects.filter(p => p.workspaceId === w.id)) p.members = p.members.filter(x => x.userId !== m.userId);
    audit(w.id, 'member.removed', user, { userId: m.userId, username: usernameOf(m.userId) });
    return empty();
  });
  route('GET', '/api/workspaces/:id/audit', ({ user, params }) => {
    const w = getWs(params.id); needWs(user, w, ['admin']);
    return json(200, S.audit.filter(a => a.workspaceId === w.id).map(a => ({ ...a, type: a.action })).reverse());
  });

  // projects
  route('POST', '/api/workspaces/:id/projects', ({ user, params, body }) => {
    const w = getWs(params.id); needWs(user, w, ['admin', 'member']);
    if (!isObj(body) || !isStr(body.name)) throw bad('name required');
    if (typeof body.key !== 'string' || !/^[A-Z][A-Z0-9]{1,9}$/.test(body.key)) throw bad('key must be 2-10 uppercase letters/digits');
    if (S.projects.some(p => p.key === body.key)) throw conflict('project key exists');
    const names = DEFAULT_STATUSES.map(s => s[0]);
    const p = {
      id: uid(), workspaceId: w.id, name: body.name.trim(), key: body.key, createdAt: iso(), nextNumber: 1,
      members: [{ userId: user.id, role: 'lead' }],
      workflow: { statuses: DEFAULT_STATUSES.map(([name, category]) => ({ name, category })), transitions: names.flatMap(a => names.filter(b => b !== a).map(b => [a, b])) },
    };
    S.projects.push(p);
    return json(201, pubProject(p));
  });
  route('GET', '/api/workspaces/:id/projects', ({ user, params }) => {
    const w = getWs(params.id); needWs(user, w);
    return json(200, S.projects.filter(p => p.workspaceId === w.id && projRole(user, p)).map(pubProject));
  });
  route('GET', '/api/projects/:id', ({ user, params }) => { const p = getProject(params.id); needProj(user, p); return json(200, pubProject(p)); });
  route('POST', '/api/projects/:id/members', ({ user, params, body }) => {
    const p = getProject(params.id); needProj(user, p, 'lead');
    if (!isObj(body) || !isStr(body.username)) throw bad('username required');
    if (!PROJ_ROLES.includes(body.role)) throw bad('invalid role');
    const u = userByName(body.username); if (!u) throw notFound('user not found');
    if (!wsRole(u, wsById(p.workspaceId))) throw bad('user is not a workspace member');
    const ex = p.members.find(m => m.userId === u.id);
    if (ex) ex.role = body.role; else p.members.push({ userId: u.id, role: body.role });
    audit(p.workspaceId, 'project.member_set', user, { projectId: p.id, userId: u.id, role: body.role });
    return json(201, { userId: u.id, username: u.username, role: body.role });
  });
  route('PATCH', '/api/projects/:id/members/:uid', ({ user, params, body }) => {
    const p = getProject(params.id); needProj(user, p, 'lead');
    const m = p.members.find(x => x.userId === params.uid); if (!m) throw notFound('member not found');
    if (!isObj(body) || !PROJ_ROLES.includes(body.role)) throw bad('invalid role');
    m.role = body.role; audit(p.workspaceId, 'project.member_set', user, { projectId: p.id, userId: m.userId, role: m.role });
    return json(200, { userId: m.userId, username: usernameOf(m.userId), role: m.role });
  });
  route('DELETE', '/api/projects/:id/members/:uid', ({ user, params }) => {
    const p = getProject(params.id); needProj(user, p, 'lead');
    const m = p.members.find(x => x.userId === params.uid); if (!m) throw notFound('member not found');
    p.members = p.members.filter(x => x !== m);
    audit(p.workspaceId, 'project.member_removed', user, { projectId: p.id, userId: m.userId });
    return empty();
  });
  route('PUT', '/api/projects/:id/workflow', ({ user, params, body }) => {
    const p = getProject(params.id); needProj(user, p, 'lead');
    if (!isObj(body) || !Array.isArray(body.statuses) || !body.statuses.length) throw bad('statuses required');
    const statuses = [];
    for (const s of body.statuses) {
      if (!isObj(s) || !isStr(s.name) || !CATS.includes(s.category)) throw bad('invalid status');
      if (statuses.some(x => x.name === s.name)) throw bad('duplicate status ' + s.name);
      statuses.push({ name: s.name, category: s.category });
    }
    const names = statuses.map(s => s.name);
    let transitions;
    if (body.transitions == null) transitions = names.flatMap(a => names.filter(b => b !== a).map(b => [a, b]));
    else {
      if (!Array.isArray(body.transitions)) throw bad('transitions must be array');
      transitions = [];
      for (const t of body.transitions) {
        if (!Array.isArray(t) || t.length !== 2 || !names.includes(t[0]) || !names.includes(t[1])) throw bad('invalid transition');
        transitions.push([t[0], t[1]]);
      }
    }
    const remap = body.remap == null ? {} : body.remap;
    if (!isObj(remap)) throw bad('remap must be object');
    const issues = S.issues.filter(i => i.projectId === p.id);
    for (const i of issues) {
      if (!names.includes(i.status)) {
        const to = remap[i.status];
        if (!to) throw bad(`status "${i.status}" is in use and needs a remap`);
        if (!names.includes(to)) throw bad(`remap target "${to}" does not exist`);
      }
    }
    const old = p.workflow;
    p.workflow = { statuses, transitions };
    for (const i of issues) {
      if (!names.includes(i.status)) applyStatus(i, p, remap[i.status], user);
      else { // category may have changed
        const cat = statusCat(p, i.status);
        if (cat === 'completed' && !i.resolvedAt) { i.resolvedAt = iso(); record(i, 'resolvedAt', null, i.resolvedAt, user, true); }
        else if (cat !== 'completed' && i.resolvedAt) { record(i, 'resolvedAt', i.resolvedAt, null, user, true); i.resolvedAt = null; }
      }
    }
    audit(p.workspaceId, 'workflow.updated', user, { projectId: p.id, from: old.statuses.map(s => s.name), to: names });
    return json(200, pubProject(p));
  });

  // issues
  route('POST', '/api/projects/:id/issues', ({ user, params, body }) => {
    const p = getProject(params.id); needProj(user, p, 'developer');
    return json(201, issueView(createIssue(p, body, user)));
  });
  route('GET', '/api/projects/:id/issues', ({ user, params, query }) => {
    const p = getProject(params.id); needProj(user, p);
    return json(200, S.issues.filter(i => i.projectId === p.id).map(i => issueView(i)));
  });
  route('GET', '/api/issues/:key', ({ user, params }) => { const i = getIssue(params.key); needProj(user, projById(i.projectId)); return json(200, issueView(i)); });
  route('PATCH', '/api/issues/:key', ({ user, params, body }) => {
    const i = getIssue(params.key); needProj(user, projById(i.projectId), 'developer');
    updateIssue(i, body, user); return json(200, issueView(i));
  });
  route('DELETE', '/api/issues/:key', ({ user, params }) => {
    const i = getIssue(params.key); needProj(user, projById(i.projectId), 'developer');
    deleteIssue(i, user); return empty();
  });
  route('GET', '/api/issues/:key/history', ({ user, params }) => {
    const i = getIssue(params.key); needProj(user, projById(i.projectId));
    return json(200, i._history.filter(h => !h.hidden).map(({ field, from, to, actorId, at }) => ({ field, from, to, actorId, at })));
  });
  route('POST', '/api/issues/:key/links', ({ user, params, body }) => {
    const i = getIssue(params.key); needProj(user, projById(i.projectId), 'developer');
    if (!isObj(body) || !LINK_TYPES.includes(body.type)) throw bad('invalid link type');
    const t = typeof body.target === 'string' ? (issueByKey(body.target) || issueById(body.target)) : null;
    if (!t) throw bad('target not found');
    if (t.id === i.id) throw bad('cannot link to self');
    needProj(user, projById(t.projectId));
    if (i.links.some(l => l.type === body.type && l.targetId === t.id)) throw conflict('link exists');
    i.links.push({ id: uid(), type: body.type, targetId: t.id });
    i.updatedAt = iso();
    return json(201, issueView(i));
  });
  route('DELETE', '/api/issues/:key/links/:lid', ({ user, params }) => {
    const i = getIssue(params.key); needProj(user, projById(i.projectId), 'developer');
    let found = false;
    for (const x of S.issues) { const n = x.links.length; x.links = x.links.filter(l => !(l.id === params.lid && (x.id === i.id || l.targetId === i.id))); if (x.links.length !== n) found = true; }
    if (!found) throw notFound(); return empty();
  });

  // comments / watchers
  const pubComment = c => ({ id: c.id, issueKey: issueById(c.issueId)?.key, issueId: c.issueId, authorId: c.authorId, body: c.body, createdAt: c.createdAt, updatedAt: c.updatedAt, edited: c.edited });
  route('POST', '/api/issues/:key/comments', ({ user, params, body }) => {
    const i = getIssue(params.key); const p = projById(i.projectId); needProj(user, p, 'developer');
    if (!isObj(body) || !isStr(body.body)) throw bad('body required');
    const c = { id: uid(), issueId: i.id, authorId: user.id, body: body.body, createdAt: iso(), updatedAt: iso(), edited: false };
    S.comments.push(c);
    const mentioned = new Set();
    for (const m of body.body.matchAll(/@([A-Za-z0-9_.-]+)/g)) {
      const u = userByName(m[1].replace(/[.-]+$/, ''));
      if (u) mentioned.add(u.id);
    }
    notify([...mentioned], 'mention', i, user, p);
    notify(i.watchers.filter(w => !mentioned.has(w)), 'comment', i, user, p);
    i.updatedAt = iso();
    emit('comment.created', i, user, { comment: pubComment(c) });
    return json(201, pubComment(c));
  });
  route('GET', '/api/issues/:key/comments', ({ user, params }) => {
    const i = getIssue(params.key); needProj(user, projById(i.projectId));
    return json(200, S.comments.filter(c => c.issueId === i.id).map(pubComment));
  });
  const patchComment = ({ user, params, body }) => {
    const c = S.comments.find(x => x.id === params.id); if (!c) throw notFound('comment not found');
    const i = issueById(c.issueId); needProj(user, projById(i.projectId));
    if (c.authorId !== user.id) throw forbidden('only the author can edit');
    if (!isObj(body) || !isStr(body.body)) throw bad('body required');
    c.body = body.body; c.edited = true; c.updatedAt = iso();
    return json(200, pubComment(c));
  };
  route('PATCH', '/api/comments/:id', patchComment);
  route('PATCH', '/api/issues/:key/comments/:id', patchComment);
  const delComment = ({ user, params }) => {
    const c = S.comments.find(x => x.id === params.id); if (!c) throw notFound('comment not found');
    const p = projById(issueById(c.issueId).projectId);
    if (c.authorId !== user.id && projRole(user, p) !== 'lead') throw forbidden();
    S.comments = S.comments.filter(x => x !== c); return empty();
  };
  route('DELETE', '/api/comments/:id', delComment);
  route('DELETE', '/api/issues/:key/comments/:id', delComment);
  route('POST', '/api/issues/:key/watch', ({ user, params }) => {
    const i = getIssue(params.key); needProj(user, projById(i.projectId));
    if (!i.watchers.includes(user.id)) i.watchers.push(user.id);
    return json(200, issueView(i));
  });
  route('DELETE', '/api/issues/:key/watch', ({ user, params }) => {
    const i = getIssue(params.key); needProj(user, projById(i.projectId));
    i.watchers = i.watchers.filter(w => w !== user.id);
    return json(200, issueView(i));
  });
  route('GET', '/api/notifications', ({ user, query }) => {
    let l = S.notifications.filter(n => n.userId === user.id);
    if (query.get('unread') === 'true') l = l.filter(n => !n.read);
    return json(200, l.slice().reverse().map(({ id, type, issueKey, actorId, at, read }) => ({ id, type, issueKey, actorId, at, read })));
  });
  route('POST', '/api/notifications/read', ({ user, body }) => {
    if (!isObj(body)) throw bad('body required');
    let n = 0;
    if (body.all === true) { for (const x of S.notifications) if (x.userId === user.id && !x.read) { x.read = true; n++; } }
    else if (Array.isArray(body.ids)) { for (const x of S.notifications) if (x.userId === user.id && body.ids.includes(x.id) && !x.read) { x.read = true; n++; } }
    else throw bad('ids or all required');
    return json(200, { updated: n });
  });

  // sprints
  const pubSprint = s => { const o = {}; for (const k of Object.keys(s)) if (!k.startsWith('_')) o[k] = s[k]; return o; };
  const dateOnly = (v, name) => { if (v == null) return null; if (typeof v !== 'string' || isNaN(Date.parse(v))) throw bad('invalid ' + name); return v.slice(0, 10); };
  route('POST', '/api/projects/:id/sprints', ({ user, params, body }) => {
    const p = getProject(params.id); needProj(user, p, 'developer');
    if (!isObj(body) || !isStr(body.name)) throw bad('name required');
    const startDate = dateOnly(body.startDate, 'startDate'), endDate = dateOnly(body.endDate, 'endDate');
    if (startDate && endDate && endDate < startDate) throw bad('endDate before startDate');
    const s = { id: uid(), projectId: p.id, name: body.name.trim(), startDate, endDate, state: 'planned', createdAt: iso(), startedAt: null, completedAt: null };
    S.sprints.push(s); return json(201, pubSprint(s));
  });
  route('GET', '/api/projects/:id/sprints', ({ user, params }) => { const p = getProject(params.id); needProj(user, p); return json(200, S.sprints.filter(s => s.projectId === p.id).map(pubSprint)); });
  route('GET', '/api/sprints/:id', ({ user, params }) => { const s = getSprint(params.id); needProj(user, projById(s.projectId)); return json(200, pubSprint(s)); });
  route('POST', '/api/sprints/:id/start', ({ user, params }) => {
    const s = getSprint(params.id); needProj(user, projById(s.projectId), 'developer');
    if (s.state !== 'planned') throw conflict('sprint is not planned');
    if (S.sprints.some(x => x.projectId === s.projectId && x.state === 'active')) throw conflict('another sprint is already active');
    s.state = 'active'; s.startedAt = iso(); if (!s.startDate) s.startDate = s.startedAt.slice(0, 10);
    s._committed = S.issues.filter(i => i.sprintId === s.id).reduce((a, i) => a + (i.storyPoints || 0), 0);
    s.committedPoints = s._committed;
    return json(200, pubSprint(s));
  });
  route('POST', '/api/sprints/:id/complete', ({ user, params, body }) => {
    const s = getSprint(params.id); const p = projById(s.projectId); needProj(user, p, 'developer');
    if (s.state !== 'active') throw conflict('sprint is not active');
    const to = isObj(body) && body.carryOverTo != null ? body.carryOverTo : 'backlog';
    let target = null;
    if (to !== 'backlog') {
      target = sprintById(to);
      if (!target || target.projectId !== s.projectId || target.id === s.id || target.state === 'completed') throw bad('invalid carryOverTo');
    }
    const mine = S.issues.filter(i => i.sprintId === s.id);
    const unfinished = mine.filter(i => !i.resolvedAt), done = mine.filter(i => i.resolvedAt);
    s._completedIssues = done.length; s._completedPoints = done.reduce((a, i) => a + (i.storyPoints || 0), 0); s._carriedOver = unfinished.length;
    for (const i of unfinished) { record(i, 'sprintId', i.sprintId, target ? target.id : null, user); i.sprintId = target ? target.id : null; i.updatedAt = iso(); }
    s.state = 'completed'; s.completedAt = iso();
    return json(200, pubSprint(s));
  });
  route('GET', '/api/sprints/:id/report', ({ user, params }) => {
    const s = getSprint(params.id); const p = projById(s.projectId); needProj(user, p);
    const live = S.issues.filter(i => i.sprintId === s.id);
    const sum = a => a.reduce((x, i) => x + (i.storyPoints || 0), 0);
    const burndown = [];
    if (s.startDate) {
      const today = now(); const todayStr = today.toISOString().slice(0, 10);
      let last = todayStr; if (s.endDate && s.endDate < last) last = s.endDate;
      for (let d = new Date(s.startDate + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= last; d = new Date(d.getTime() + 86400000)) {
        const ds = d.toISOString().slice(0, 10);
        let t = new Date(ds + 'T23:59:59.999Z'); if (t > today) t = today;
        let rem = 0;
        for (const i of S.issues) {
          if (i.projectId !== p.id || new Date(i.createdAt) > t) continue;
          if (valueAt(i, 'sprintId', t) !== s.id || valueAt(i, 'resolvedAt', t)) continue;
          rem += valueAt(i, 'storyPoints', t) || 0;
        }
        burndown.push({ date: ds, remainingPoints: rem });
      }
    }
    const completed = s.state === 'completed';
    const doneNow = live.filter(i => i.resolvedAt);
    return json(200, {
      committedPoints: s.state === 'planned' ? sum(live) : s._committed,
      completedPoints: completed ? s._completedPoints : sum(doneNow),
      completedIssues: completed ? s._completedIssues : doneNow.length,
      carriedOver: completed ? s._carriedOver : 0,
      burndown,
    });
  });
  route('GET', '/api/projects/:id/stats', ({ user, params }) => {
    const p = getProject(params.id); needProj(user, p);
    const byStatus = {}, byType = {}, byAssignee = {};
    for (const s of p.workflow.statuses) byStatus[s.name] = 0;
    const cyc = [];
    for (const i of S.issues.filter(x => x.projectId === p.id)) {
      byStatus[i.status] = (byStatus[i.status] || 0) + 1;
      byType[i.type] = (byType[i.type] || 0) + 1;
      const a = i.assigneeId ? usernameOf(i.assigneeId) : 'unassigned'; byAssignee[a] = (byAssignee[a] || 0) + 1;
      if (i.resolvedAt && i._startedAt) cyc.push((new Date(i.resolvedAt) - new Date(i._startedAt)) / 3600000);
    }
    const avg = cyc.length ? cyc.reduce((a, b) => a + b, 0) / cyc.length : null;
    return json(200, { byStatus, byType, byAssignee, averageCycleTimeHours: avg, avgCycleTimeHours: avg, cycleTimeHours: avg, total: Object.values(byType).reduce((a, b) => a + b, 0) });
  });

  // search
  route('GET', '/api/search', ({ user, query }) => {
    const q = query.get('q') || '';
    let terms; try { terms = parseQuery(q); } catch (e) { if (e instanceof QueryError) throw bad('malformed query: ' + e.message); throw e; }
    const sort = query.get('sort') || 'updated';
    if (!['updated', 'created', 'priority'].includes(sort)) throw bad('invalid sort');
    let projects = S.projects.filter(p => projRole(user, p));
    const pf = query.get('project');
    if (pf) { projects = projects.filter(p => p.id === pf || p.key === pf); }
    const ids = new Set(projects.map(p => p.id));
    const ctx = { me: user.id, usernameOf, sprintById };
    let res = S.issues.filter(i => ids.has(i.projectId) && terms.every(t => matches(i, t, ctx) !== t.neg));
    const rank = p => PRIOS.indexOf(p);
    const upd = (a, b) => b.updatedAt.localeCompare(a.updatedAt) || S.issues.indexOf(b) - S.issues.indexOf(a);
    if (sort === 'created') res.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || S.issues.indexOf(b) - S.issues.indexOf(a));
    else if (sort === 'priority') res.sort((a, b) => rank(a.priority) - rank(b.priority) || upd(a, b));
    else res.sort(upd);
    return json(200, res.map(i => issueView(i)));
  });

  // csv
  const COLS = ['key', 'type', 'title', 'status', 'priority', 'assignee', 'labels', 'storyPoints', 'parent', 'epic', 'sprint', 'dueDate', 'createdAt', 'resolvedAt'];
  route('GET', '/api/projects/:id/export.csv', ({ user, params }) => {
    const p = getProject(params.id); needProj(user, p);
    const rows = [COLS];
    for (const i of S.issues.filter(x => x.projectId === p.id)) rows.push([i.key, i.type, i.title, i.status, i.priority, i.assigneeId ? usernameOf(i.assigneeId) : '', i.labels.join(';'), i.storyPoints ?? '', i.parentId ? issueById(i.parentId)?.key : '', i.epicId ? issueById(i.epicId)?.key : '', i.sprintId ? sprintById(i.sprintId)?.name : '', i.dueDate || '', i.createdAt, i.resolvedAt || '']);
    return { code: 200, raw: toCsv(rows), type: 'text/csv; charset=utf-8' };
  });
  route('POST', '/api/projects/:id/import.csv', ({ user, params, rawBody }) => {
    const p = getProject(params.id); needProj(user, p, 'developer');
    let recs; try { recs = parseCsv(rawBody || ''); } catch (e) { throw bad('malformed CSV: ' + e.message); }
    if (!recs.length) throw bad('empty CSV');
    const header = recs[0].cells.map(h => h.trim());
    if (!header.includes('title')) throw bad('missing title column');
    let created = 0; const errors = [];
    for (const r of recs.slice(1)) {
      const row = {}; header.forEach((h, k) => { row[h] = r.cells[k] ?? ''; });
      try {
        if (r.cells.length > header.length) throw bad('too many columns');
        const b = { title: row.title };
        if (!isStr(row.title)) throw bad('title required');
        if (row.type) b.type = row.type;
        if (row.status) b.status = row.status;
        if (row.priority) b.priority = row.priority;
        if (row.assignee) { const u = userByName(row.assignee); if (!u) throw bad('unknown assignee ' + row.assignee); b.assigneeId = u.id; }
        if (row.labels) b.labels = row.labels.split(';').map(s => s.trim()).filter(Boolean);
        if (row.storyPoints !== '' && row.storyPoints != null) { const n = Number(row.storyPoints); if (!isFinite(n)) throw bad('invalid storyPoints'); b.storyPoints = n; }
        for (const [col, f] of [['parent', 'parentId'], ['epic', 'epicId']]) if (row[col]) { const x = issueByKey(row[col]); if (!x || x.projectId !== p.id) throw bad(`unknown ${col} ${row[col]}`); b[f] = x.id; }
        if (row.sprint) { const s = S.sprints.find(x => x.projectId === p.id && x.name === row.sprint); if (!s) throw bad('unknown sprint ' + row.sprint); b.sprintId = s.id; }
        if (row.dueDate) b.dueDate = row.dueDate;
        createIssue(p, b, user); created++;
      } catch (e) { if (e instanceof HttpError) errors.push({ line: r.line, message: e.message }); else throw e; }
    }
    return json(200, { created, errors });
  });

  // webhooks
  const pubHook = w => ({ id: w.id, projectId: w.projectId, url: w.url, events: w.events, createdAt: w.createdAt });
  route('POST', '/api/projects/:id/webhooks', ({ user, params, body }) => {
    const p = getProject(params.id); needProj(user, p, 'lead');
    if (!isObj(body) || !isStr(body.url) || !/^https?:\/\/.+/.test(body.url)) throw bad('valid url required');
    if (!Array.isArray(body.events) || !body.events.length || body.events.some(e => !EVENTS.includes(e))) throw bad('invalid events');
    if (typeof body.secret !== 'string' || !body.secret) throw bad('secret required');
    const w = { id: uid(), projectId: p.id, url: body.url, events: [...new Set(body.events)], secret: body.secret, createdAt: iso() };
    S.webhooks.push(w); audit(p.workspaceId, 'webhook.created', user, { webhookId: w.id, url: w.url });
    return json(201, pubHook(w));
  });
  route('GET', '/api/projects/:id/webhooks', ({ user, params }) => { const p = getProject(params.id); needProj(user, p, 'lead'); return json(200, S.webhooks.filter(w => w.projectId === p.id).map(pubHook)); });
  route('DELETE', '/api/webhooks/:id', ({ user, params }) => {
    const w = S.webhooks.find(x => x.id === params.id); if (!w) throw notFound();
    const p = projById(w.projectId); needProj(user, p, 'lead');
    S.webhooks = S.webhooks.filter(x => x !== w); audit(p.workspaceId, 'webhook.deleted', user, { webhookId: w.id });
    return empty();
  });
  route('GET', '/api/webhooks/:id/deliveries', ({ user, params }) => {
    const w = S.webhooks.find(x => x.id === params.id); if (!w) throw notFound();
    needProj(user, projById(w.projectId), 'lead');
    return json(200, S.deliveries.filter(d => d.webhookId === w.id).map(d => ({ ...d })));
  });

  // ---------- http ----------
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
  function serveStatic(res, rel) {
    const f = path.normalize(path.join(STATIC_DIR, rel));
    if (!f.startsWith(STATIC_DIR) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { send(res, 404, { error: 'not_found', message: 'not found' }); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
  }
  function send(res, code, body) {
    if (code === 204 || body === undefined) { res.writeHead(code); res.end(); return; }
    const s = JSON.stringify(body); res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(s);
  }
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try {
        const url = new URL(req.url, 'http://x'); const p = url.pathname;
        if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveStatic(res, 'index.html');
        if (req.method === 'GET' && p.startsWith('/static/')) return serveStatic(res, decodeURIComponent(p.slice(8)));
        if (!p.startsWith('/api/')) throw notFound();
        const rawBody = Buffer.concat(chunks).toString('utf8');
        let matched = null, pathMatched = false;
        for (const r of routes) {
          const m = r.re.exec(p); if (!m) continue;
          pathMatched = true;
          if (r.method !== req.method) continue;
          matched = { r, params: Object.fromEntries(r.names.map((n, k) => [n, decodeURIComponent(m[k + 1])])) }; break;
        }
        if (!matched) throw pathMatched ? new HttpError(405, 'method_not_allowed', 'method not allowed') : notFound('route not found');
        const user = matched.r.auth ? authenticate(req) : null;
        let body;
        if (!p.endsWith('/import.csv') && rawBody.trim()) { try { body = JSON.parse(rawBody); } catch { throw bad('invalid JSON body'); } }
        const out = matched.r.handler({ req, user, params: matched.params, query: url.searchParams, body, rawBody });
        if (matched.r.method !== 'GET') save();
        if (out.raw !== undefined) { res.writeHead(out.code, { 'content-type': out.type }); res.end(out.raw); }
        else send(res, out.code, out.body);
      } catch (e) {
        if (e instanceof HttpError) send(res, e.status, { error: e.code, message: e.message });
        else { console.error(e); send(res, 500, { error: 'internal_error', message: 'internal error' }); }
      }
    });
  });
  return server;
}
