import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseQuery, matches, QueryError } from './search.js';
import { parseCsv, toCsv } from './csv.js';

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIOS = ['urgent', 'high', 'medium', 'low', 'none'];
const CATS = ['backlog', 'unstarted', 'started', 'completed'];
const WS_ROLES = ['admin', 'member', 'guest'];
const PROJ_ROLES = ['lead', 'developer', 'viewer'];
const RANK = { viewer: 0, developer: 1, lead: 2 };
const LINK_INV = { blocks: 'blocked_by', relates: 'relates', duplicates: 'duplicated_by' };
const DEFAULT_STATUSES = [['Backlog', 'backlog'], ['Todo', 'unstarted'], ['In Progress', 'started'], ['In Review', 'started'], ['Done', 'completed']];

class HttpError extends Error {
  constructor(status, error, message) { super(message || error); this.status = status; this.error = error; }
}
const bad = (m) => new HttpError(400, 'validation_error', m);
const notFound = (m = 'Not found') => new HttpError(404, 'not_found', m);
const forbidden = (m = 'Forbidden') => new HttpError(403, 'forbidden', m);
const conflict = (m, code = 'conflict') => new HttpError(409, code, m);

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rid = () => crypto.randomUUID();
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v) => typeof v === 'string';

function hashPw(pw) { const salt = crypto.randomBytes(16).toString('hex'); return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex'); }
function checkPw(pw, stored) {
  const [salt, h] = stored.split(':');
  const a = Buffer.from(crypto.scryptSync(pw, salt, 32).toString('hex')), b = Buffer.from(h);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const pub = (o) => { const r = {}; for (const k of Object.keys(o)) if (!k.startsWith('_')) r[k] = o[k]; return r; };

export function createServer({ dataFile, clock } = {}) {
  const now = () => (clock ? clock() : new Date());
  const iso = () => now().toISOString();
  const today = () => iso().slice(0, 10);

  let db = { users: {}, sessions: {}, apiTokens: {}, workspaces: {}, projects: {}, issues: {}, links: {}, comments: {}, notifications: {}, sprints: {}, webhooks: {}, deliveries: {}, audit: [], seq: 0 };
  if (dataFile && fs.existsSync(dataFile)) {
    try { db = { ...db, ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) }; } catch { /* start fresh */ }
  }
  let saveTimer = null;
  function saveNow() {
    if (!dataFile) return;
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, dataFile);
  }
  function save() { if (!dataFile) return; saveNow(); }
  const failures = {}; // login rate limit

  const vals = (o) => Object.values(o);
  const userByName = (n) => vals(db.users).find(u => u.username.toLowerCase() === String(n).toLowerCase());
  const pubUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName, createdAt: u.createdAt });

  // ---------- access ----------
  function wsRole(user, ws) { const m = ws.members.find(m => m.userId === user.id); return m ? m.role : null; }
  function getWs(user, id, admin = false) {
    const ws = db.workspaces[id]; if (!ws) throw notFound('Workspace not found');
    const role = wsRole(user, ws); if (!role) throw notFound('Workspace not found');
    if (admin && role !== 'admin') throw forbidden('Admin only');
    return ws;
  }
  function projRole(user, p) {
    const ws = db.workspaces[p.workspaceId]; if (!ws) return null;
    const wr = wsRole(user, ws); if (!wr) return null;
    if (wr === 'admin') return 'lead';
    const pm = p.members.find(m => m.userId === user.id);
    if (wr === 'guest') return pm ? pm.role : null;
    return pm ? pm.role : 'developer';
  }
  function getProject(user, id, min = 'viewer') {
    const p = db.projects[id]; if (!p) throw notFound('Project not found');
    const r = projRole(user, p); if (!r) throw notFound('Project not found');
    if (RANK[r] < RANK[min]) throw forbidden('Insufficient project role');
    return p;
  }
  function getIssue(user, key, min = 'viewer') {
    let found = null;
    for (const i of vals(db.issues)) {
      if (i.key === key || i.id === key) { const p = db.projects[i.projectId]; const r = p && projRole(user, p); if (r) { found = [i, p, r]; break; } }
    }
    if (!found) throw notFound('Issue not found');
    if (RANK[found[2]] < RANK[min]) throw forbidden('Insufficient project role');
    return found[0];
  }
  const audit = (wsId, action, actorId, details = {}) => { db.audit.push({ id: rid(), workspaceId: wsId, action, actorId, at: iso(), ...details }); };

  // ---------- issue helpers ----------
  const statusDef = (p, name) => p.workflow.statuses.find(s => s.name === name);
  const catOf = (p, name) => statusDef(p, name)?.category;
  const isDone = (p, issue) => catOf(p, issue.status) === 'completed';
  function record(issue, field, from, to, actorId) {
    db.seq++; issue._useq = db.seq;
    (issue._history ||= []).push({ field, from: from ?? null, to: to ?? null, actorId, at: iso() });
  }
  function view(issue, full = false) {
    const o = pub(issue); delete o.history;
    if (full) {
      const p = db.projects[issue.projectId];
      o.children = vals(db.issues).filter(i => i.parentId === issue.id).map(i => i.key);
      if (issue.type === 'epic') {
        const m = vals(db.issues).filter(i => i.epicId === issue.id);
        o.progress = { total: m.length, done: m.filter(i => isDone(p, i)).length, points_total: m.reduce((s, i) => s + (i.storyPoints || 0), 0), points_done: m.filter(i => isDone(p, i)).reduce((s, i) => s + (i.storyPoints || 0), 0) };
      }
      o.links = [];
      for (const l of vals(db.links)) {
        if (l.sourceId === issue.id) { const t = db.issues[l.targetId]; if (t) o.links.push({ id: l.id, type: l.type, key: t.key, target: t.key, title: t.title, status: t.status }); }
        else if (l.targetId === issue.id) { const s = db.issues[l.sourceId]; if (s) o.links.push({ id: l.id, type: LINK_INV[l.type], key: s.key, target: s.key, title: s.title, status: s.status }); }
      }
    }
    return o;
  }
  function checkUserInProject(p, uid) {
    const u = db.users[uid]; if (!u) throw bad('Unknown user');
    if (!projRole(u, p)) throw bad('User cannot access this project');
  }
  function validateFields(p, d, cur) {
    const out = {};
    if ('title' in d) { if (!isStr(d.title) || !d.title.trim() || d.title.length > 300) throw bad('title required (1-300 chars)'); out.title = d.title.trim(); }
    if ('description' in d) { if (d.description !== null && !isStr(d.description)) throw bad('description must be string'); out.description = d.description ?? ''; }
    if ('type' in d) { if (!TYPES.includes(d.type)) throw bad('invalid type'); out.type = d.type; }
    if ('priority' in d) { if (!PRIOS.includes(d.priority)) throw bad('invalid priority'); out.priority = d.priority; }
    if ('status' in d) { if (!isStr(d.status) || !statusDef(p, d.status)) throw bad('unknown status'); out.status = d.status; }
    if ('assignee' in d && !('assigneeId' in d)) { if (d.assignee === null || d.assignee === '') d.assigneeId = null; else { const u = userByName(d.assignee); if (!u) throw bad('Unknown assignee'); d.assigneeId = u.id; } }
    if ('assigneeId' in d) { if (d.assigneeId !== null) { if (!isStr(d.assigneeId)) throw bad('invalid assigneeId'); checkUserInProject(p, d.assigneeId); } out.assigneeId = d.assigneeId; }
    if ('labels' in d) { if (!Array.isArray(d.labels) || d.labels.some(l => !isStr(l) || !l.trim())) throw bad('labels must be array of strings'); out.labels = [...new Set(d.labels.map(l => l.trim()))]; }
    if ('storyPoints' in d) { if (d.storyPoints !== null && (typeof d.storyPoints !== 'number' || !isFinite(d.storyPoints) || d.storyPoints < 0)) throw bad('storyPoints must be non-negative number'); out.storyPoints = d.storyPoints; }
    if ('dueDate' in d) { if (d.dueDate !== null && (!isStr(d.dueDate) || !/^\d{4}-\d{2}-\d{2}$/.test(d.dueDate) || isNaN(Date.parse(d.dueDate)))) throw bad('dueDate must be YYYY-MM-DD'); out.dueDate = d.dueDate; }
    if ('sprintId' in d) {
      if (d.sprintId !== null) { const s = db.sprints[d.sprintId]; if (!s || s.projectId !== p.id) throw bad('Unknown sprint'); if (s.state === 'completed') throw bad('Sprint is completed'); }
      out.sprintId = d.sprintId;
    }
    const type = out.type ?? cur?.type;
    if ('parentId' in d || 'type' in d) {
      const parentId = 'parentId' in d ? d.parentId : cur?.parentId ?? null;
      if (parentId !== null && parentId !== undefined) {
        const par = db.issues[parentId];
        if (!par || par.projectId !== p.id) throw bad('Invalid parent');
        if (par.subtask || par.type === 'subtask') throw bad('Parent cannot be a subtask');
        if (type === 'epic') throw bad('Epics cannot have parents');
        if (cur && par.id === cur.id) throw bad('Issue cannot be its own parent');
      } else if (type === 'subtask') throw bad('Subtasks require a parentId');
      if ('parentId' in d) out.parentId = parentId ?? null;
    }
    if ('epicId' in d) {
      if (d.epicId !== null) { const e = db.issues[d.epicId]; if (!e || e.projectId !== p.id || e.type !== 'epic') throw bad('epicId must reference an epic'); }
      out.epicId = d.epicId;
    }
    return out;
  }
  function createIssue(p, user, d, silent = false) {
    if (!isObj(d)) throw bad('Body must be an object');
    if (!('title' in d)) throw bad('title required');
    if (!('type' in d)) d = { ...d, type: 'task' };
    const f = validateFields(p, d, null);
    if (f.type === 'subtask' && !f.parentId) throw bad('Subtasks require a parentId');
    p.issueCounter = (p.issueCounter || 0) + 1;
    const first = p.workflow.statuses.find(s => s.category === 'unstarted') || p.workflow.statuses[0];
    const t = iso();
    const issue = {
      id: rid(), key: `${p.key}-${p.issueCounter}`, projectId: p.id, type: f.type, title: f.title, description: f.description ?? '',
      status: f.status ?? first.name, priority: f.priority ?? 'none', assigneeId: f.assigneeId ?? null, reporterId: user.id,
      labels: f.labels ?? [], storyPoints: f.storyPoints ?? null, parentId: f.parentId ?? null, epicId: f.epicId ?? null,
      sprintId: f.sprintId ?? null, dueDate: f.dueDate ?? null, watchers: [], createdAt: t, updatedAt: t, resolvedAt: null,
    };
    if (catOf(p, issue.status) === 'completed') issue.resolvedAt = t;
    issue.watchers.push(user.id);
    if (issue.assigneeId && !issue.watchers.includes(issue.assigneeId)) issue.watchers.push(issue.assigneeId);
    db.seq++; issue._useq = db.seq; issue._history = [];
    db.issues[issue.id] = issue;
    if (!silent) emit(p, 'issue.created', issue, user.id);
    return issue;
  }
  function notify(userId, type, issue, actorId, extra = {}) {
    const n = { id: rid(), userId, type, issueKey: issue.key, actorId, at: iso(), read: false, ...extra };
    db.notifications[n.id] = n; return n;
  }
  function notifyWatchers(issue, type, actorId, skip = new Set()) {
    for (const w of issue.watchers) if (w !== actorId && !skip.has(w)) notify(w, type, issue, actorId);
  }
  function updateIssue(p, user, issue, d) {
    if (!isObj(d)) throw bad('Body must be an object');
    const f = validateFields(p, d, issue);
    const prevStatus = issue.status;
    if (f.status !== undefined && f.status !== issue.status) {
      const ok = p.workflow.transitions.some(([a, b]) => a === issue.status && b === f.status);
      if (!ok) throw conflict(`Transition ${issue.status} -> ${f.status} not allowed`, 'invalid_transition');
      if (catOf(p, f.status) === 'completed') {
        const blockers = vals(db.links).filter(l => l.type === 'blocks' && l.targetId === issue.id).map(l => db.issues[l.sourceId]).filter(s => s && !s.resolvedAt);
        if (blockers.length) throw conflict('Issue is blocked by ' + blockers.map(b => b.key).join(', '), 'blocked');
      }
    }
    const changed = [];
    for (const [k, v] of Object.entries(f)) {
      if (k === 'description' && v === issue.description) continue;
      if (JSON.stringify(issue[k]) === JSON.stringify(v)) continue;
      changed.push([k, issue[k], v]);
    }
    const t = iso();
    for (const [k, from, to] of changed) { record(issue, k, from, to, user.id); issue[k] = to; }
    if (changed.length) {
      issue.updatedAt = t;
      if (f.status !== undefined && f.status !== prevStatus) {
        const done = catOf(p, issue.status) === 'completed';
        if (done) issue.resolvedAt = t; else issue.resolvedAt = null;
      }
      if (f.assigneeId && !issue.watchers.includes(f.assigneeId)) issue.watchers.push(f.assigneeId);
      if (f.status !== undefined && f.status !== prevStatus) notifyWatchers(issue, 'status_changed', user.id);
      if (changed.some(c => c[0] === 'assigneeId')) notifyWatchers(issue, 'assigned', user.id);
      emit(p, 'issue.updated', issue, user.id);
    }
    return issue;
  }
  function deleteIssue(p, user, issue) {
    for (const c of vals(db.issues).filter(i => i.parentId === issue.id)) deleteIssue(p, user, c);
    for (const i of vals(db.issues)) if (i.epicId === issue.id) i.epicId = null;
    for (const l of vals(db.links)) if (l.sourceId === issue.id || l.targetId === issue.id) delete db.links[l.id];
    for (const c of vals(db.comments)) if (c.issueId === issue.id) delete db.comments[c.id];
    delete db.issues[issue.id];
    emit(p, 'issue.deleted', issue, user.id);
  }

  // ---------- webhooks ----------
  const pendingDeliveries = new Set();
  function emit(p, event, issue, actorId, extra = {}) {
    for (const h of vals(db.webhooks)) {
      if (h.projectId !== p.id || !h.events.includes(event)) continue;
      const at = iso();
      const body = JSON.stringify({ event, issue: pub(issue), actorId, at, ...extra });
      const d = { id: rid(), webhookId: h.id, event, status: 'pending', attempts: 0, lastError: null, at };
      db.deliveries[d.id] = d;
      const pr = deliver(h, d, body).finally(() => pendingDeliveries.delete(pr));
      pendingDeliveries.add(pr);
    }
  }
  async function deliver(h, d, body) {
    const sig = 'sha256=' + crypto.createHmac('sha256', h.secret || '').update(body).digest('hex');
    for (let a = 1; a <= 3; a++) {
      d.attempts = a;
      try {
        const r = await fetch(h.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pm-signature': sig, 'x-pm-event': d.event }, body, signal: AbortSignal.timeout(5000) });
        d.httpStatus = r.status;
        if (r.ok) { d.status = 'success'; d.lastError = null; break; }
        d.lastError = `HTTP ${r.status}`;
      } catch (e) { d.lastError = String(e.message || e); }
      d.status = 'failed';
      if (a < 3) await new Promise(r => setTimeout(r, 50 * a));
    }
    save();
  }

  // ---------- history replay ----------
  function stateAt(issue, T) { // returns snapshot of status/sprintId/storyPoints at ISO time T, or null if not yet existing
    if (issue.createdAt > T) return null;
    const s = { status: issue.status, sprintId: issue.sprintId, storyPoints: issue.storyPoints };
    const h = issue._history || [];
    for (let i = h.length - 1; i >= 0; i--) if (h[i].at > T && h[i].field in s) s[h[i].field] = h[i].from;
    return s;
  }
  function sprintReport(sp) {
    const p = db.projects[sp.projectId];
    const issues = vals(db.issues).filter(i => i.projectId === p.id);
    const doneAt = (st) => catOf(p, st.status) === 'completed';
    const inSprintAt = (T) => issues.map(i => [i, stateAt(i, T)]).filter(([, s]) => s && s.sprintId === sp.id);
    let committed = 0;
    if (sp.startedAt) committed = inSprintAt(sp.startedAt).reduce((a, [, s]) => a + (s.storyPoints || 0), 0);
    let completedPoints, completedIssues, carriedOver;
    if (sp.state === 'completed' && sp.result) ({ completedPoints, completedIssues, carriedOver } = sp.result);
    else {
      const cur = issues.filter(i => i.sprintId === sp.id && isDone(p, i));
      completedPoints = cur.reduce((a, i) => a + (i.storyPoints || 0), 0); completedIssues = cur.length; carriedOver = 0;
    }
    const burndown = [];
    if (sp.startDate) {
      const end = [today(), sp.endDate].filter(Boolean).sort()[0];
      for (let d = new Date(sp.startDate + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= end; d = new Date(d.getTime() + 86400000)) {
        const day = d.toISOString().slice(0, 10);
        const T = day + 'T23:59:59.999Z';
        const rem = inSprintAt(T).filter(([, s]) => !doneAt(s)).reduce((a, [, s]) => a + (s.storyPoints || 0), 0);
        burndown.push({ date: day, remainingPoints: rem });
        if (burndown.length > 1000) break;
      }
    }
    return { committedPoints: committed, completedPoints, completedIssues, carriedOver, burndown };
  }

  // ---------- routing ----------
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, handler, auth: opts.auth !== false, raw: opts.raw });
  };

  // --- auth
  route('POST', '/api/auth/register', ({ body }) => {
    const { username, password } = body;
    if (!isStr(username) || !/^[A-Za-z0-9_.-]{3,32}$/.test(username)) throw bad('username must be 3-32 chars (letters, digits, _ . -)');
    if (!isStr(password) || password.length < 8) throw bad('password must be at least 8 characters');
    if (body.displayName != null && !isStr(body.displayName)) throw bad('displayName must be a string');
    if (userByName(username)) throw conflict('Username taken');
    const u = { id: rid(), username, displayName: body.displayName || username, passwordHash: hashPw(password), createdAt: iso() };
    db.users[u.id] = u; save();
    return [201, pubUser(u)];
  }, { auth: false });
  route('POST', '/api/auth/login', ({ body }) => {
    const { username, password } = body;
    if (!isStr(username) || !isStr(password)) throw bad('username and password required');
    const k = username.toLowerCase(); const t = now().getTime();
    const f = (failures[k] = (failures[k] || []).filter(x => t - x < 60000));
    if (f.length >= 10) throw new HttpError(429, 'rate_limited', 'Too many failed attempts');
    const u = userByName(username);
    if (!u || !checkPw(password, u.passwordHash)) { f.push(t); throw new HttpError(401, 'unauthorized', 'Invalid credentials'); }
    failures[k] = [];
    const token = 'pms_' + crypto.randomBytes(24).toString('hex');
    db.sessions[sha(token)] = { userId: u.id, createdAt: iso() }; save();
    return [200, { token, user: pubUser(u) }];
  }, { auth: false });
  route('POST', '/api/auth/logout', ({ tokenHash }) => { delete db.sessions[tokenHash]; save(); return [204]; });
  route('GET', '/api/auth/me', ({ user }) => [200, pubUser(user)]);
  route('PATCH', '/api/auth/me', ({ user, body }) => {
    if ('displayName' in body) { if (!isStr(body.displayName) || !body.displayName.trim()) throw bad('invalid displayName'); }
    if ('password' in body) {
      if (!isStr(body.password) || body.password.length < 8) throw bad('password must be at least 8 characters');
      if (!isStr(body.currentPassword)) throw bad('currentPassword required');
      if (!checkPw(body.currentPassword, user.passwordHash)) throw forbidden('Current password incorrect');
      user.passwordHash = hashPw(body.password);
    }
    if ('displayName' in body) user.displayName = body.displayName.trim();
    save(); return [200, pubUser(user)];
  });

  // --- tokens
  route('POST', '/api/tokens', ({ user, body }) => {
    if (!isStr(body.name) || !body.name.trim()) throw bad('name required');
    const token = 'pmt_' + crypto.randomBytes(24).toString('hex');
    const t = { id: rid(), userId: user.id, name: body.name.trim(), hash: sha(token), createdAt: iso() };
    db.apiTokens[t.id] = t;
    for (const ws of vals(db.workspaces)) if (wsRole(user, ws)) audit(ws.id, 'token.created', user.id, { tokenId: t.id, name: t.name });
    save(); return [201, { id: t.id, name: t.name, token, createdAt: t.createdAt }];
  });
  route('GET', '/api/tokens', ({ user }) => [200, vals(db.apiTokens).filter(t => t.userId === user.id).map(t => ({ id: t.id, name: t.name, createdAt: t.createdAt }))]);
  route('DELETE', '/api/tokens/:id', ({ user, params }) => {
    const t = db.apiTokens[params.id]; if (!t || t.userId !== user.id) throw notFound('Token not found');
    delete db.apiTokens[t.id];
    for (const ws of vals(db.workspaces)) if (wsRole(user, ws)) audit(ws.id, 'token.deleted', user.id, { tokenId: t.id, name: t.name });
    save(); return [204];
  });

  // --- workspaces
  const wsView = (ws) => ({ id: ws.id, name: ws.name, key: ws.key, createdAt: ws.createdAt, members: ws.members.map(m => ({ userId: m.userId, username: db.users[m.userId]?.username, role: m.role })) });
  route('POST', '/api/workspaces', ({ user, body }) => {
    if (!isStr(body.name) || !body.name.trim()) throw bad('name required');
    if (!isStr(body.key) || !/^[A-Z]{2,10}$/.test(body.key)) throw bad('key must be 2-10 uppercase letters');
    if (vals(db.workspaces).some(w => w.key === body.key)) throw conflict('Workspace key taken');
    const ws = { id: rid(), name: body.name.trim(), key: body.key, createdAt: iso(), members: [{ userId: user.id, role: 'admin' }] };
    db.workspaces[ws.id] = ws; audit(ws.id, 'workspace.created', user.id); save();
    return [201, wsView(ws)];
  });
  route('GET', '/api/workspaces', ({ user }) => [200, vals(db.workspaces).filter(w => wsRole(user, w)).map(wsView)]);
  route('GET', '/api/workspaces/:id', ({ user, params }) => [200, wsView(getWs(user, params.id))]);
  route('GET', '/api/workspaces/:id/members', ({ user, params }) => [200, wsView(getWs(user, params.id)).members]);
  route('POST', '/api/workspaces/:id/members', ({ user, params, body }) => {
    const ws = getWs(user, params.id, true);
    if (!isStr(body.username)) throw bad('username required');
    if (!WS_ROLES.includes(body.role)) throw bad('invalid role');
    const u = userByName(body.username); if (!u) throw notFound('User not found');
    if (ws.members.some(m => m.userId === u.id)) throw conflict('Already a member');
    ws.members.push({ userId: u.id, role: body.role });
    audit(ws.id, 'member.added', user.id, { targetUserId: u.id, role: body.role }); save();
    return [201, { userId: u.id, username: u.username, role: body.role }];
  });
  const findWsMember = (ws, ref) => ws.members.find(m => m.userId === ref || db.users[m.userId]?.username === ref);
  const adminCount = (ws) => ws.members.filter(m => m.role === 'admin').length;
  route('PATCH', '/api/workspaces/:id/members/:uid', ({ user, params, body }) => {
    const ws = getWs(user, params.id, true);
    const m = findWsMember(ws, params.uid); if (!m) throw notFound('Member not found');
    if (!WS_ROLES.includes(body.role)) throw bad('invalid role');
    if (m.role === 'admin' && body.role !== 'admin' && adminCount(ws) <= 1) throw bad('Cannot demote the last admin');
    const from = m.role; m.role = body.role;
    audit(ws.id, 'member.role_changed', user.id, { targetUserId: m.userId, from, to: body.role }); save();
    return [200, { userId: m.userId, username: db.users[m.userId]?.username, role: m.role }];
  });
  route('DELETE', '/api/workspaces/:id/members/:uid', ({ user, params }) => {
    const ws = getWs(user, params.id, true);
    const m = findWsMember(ws, params.uid); if (!m) throw notFound('Member not found');
    if (m.role === 'admin' && adminCount(ws) <= 1) throw bad('Cannot remove the last admin');
    ws.members = ws.members.filter(x => x !== m);
    for (const p of vals(db.projects)) if (p.workspaceId === ws.id) p.members = p.members.filter(x => x.userId !== m.userId);
    audit(ws.id, 'member.removed', user.id, { targetUserId: m.userId }); save();
    return [204];
  });
  route('GET', '/api/workspaces/:id/audit', ({ user, params }) => {
    const ws = getWs(user, params.id, true);
    return [200, db.audit.filter(a => a.workspaceId === ws.id)];
  });

  // --- projects
  const projView = (p, user) => ({ id: p.id, workspaceId: p.workspaceId, name: p.name, key: p.key, createdAt: p.createdAt, role: projRole(user, p), workflow: p.workflow, members: p.members.map(m => ({ userId: m.userId, username: db.users[m.userId]?.username, role: m.role })) });
  route('POST', '/api/workspaces/:id/projects', ({ user, params, body }) => {
    const ws = getWs(user, params.id);
    if (wsRole(user, ws) === 'guest') throw forbidden('Guests cannot create projects');
    if (!isStr(body.name) || !body.name.trim()) throw bad('name required');
    if (!isStr(body.key) || !/^[A-Z]{2,10}$/.test(body.key)) throw bad('key must be 2-10 uppercase letters');
    if (vals(db.projects).some(p => p.workspaceId === ws.id && p.key === body.key)) throw conflict('Project key taken');
    const statuses = DEFAULT_STATUSES.map(([name, category]) => ({ name, category }));
    const transitions = []; for (const a of statuses) for (const b of statuses) if (a.name !== b.name) transitions.push([a.name, b.name]);
    const p = { id: rid(), workspaceId: ws.id, name: body.name.trim(), key: body.key, createdAt: iso(), issueCounter: 0, members: [{ userId: user.id, role: 'lead' }], workflow: { statuses, transitions } };
    db.projects[p.id] = p; save();
    return [201, projView(p, user)];
  });
  route('GET', '/api/workspaces/:id/projects', ({ user, params }) => {
    const ws = getWs(user, params.id);
    return [200, vals(db.projects).filter(p => p.workspaceId === ws.id && projRole(user, p)).map(p => projView(p, user))];
  });
  route('GET', '/api/projects/:id', ({ user, params }) => [200, projView(getProject(user, params.id), user)]);
  route('POST', '/api/projects/:id/members', ({ user, params, body }) => {
    const p = getProject(user, params.id, 'lead');
    if (!isStr(body.username)) throw bad('username required');
    if (!PROJ_ROLES.includes(body.role)) throw bad('invalid role');
    const u = userByName(body.username); if (!u) throw notFound('User not found');
    const ws = db.workspaces[p.workspaceId];
    if (!wsRole(u, ws)) throw bad('User must be a workspace member first');
    if (p.members.some(m => m.userId === u.id)) throw conflict('Already a project member');
    p.members.push({ userId: u.id, role: body.role });
    audit(ws.id, 'project.member_added', user.id, { projectId: p.id, targetUserId: u.id, role: body.role }); save();
    return [201, { userId: u.id, username: u.username, role: body.role }];
  });
  route('PATCH', '/api/projects/:id/members/:uid', ({ user, params, body }) => {
    const p = getProject(user, params.id, 'lead');
    const m = p.members.find(m => m.userId === params.uid || db.users[m.userId]?.username === params.uid); if (!m) throw notFound('Member not found');
    if (!PROJ_ROLES.includes(body.role)) throw bad('invalid role');
    const from = m.role; m.role = body.role;
    audit(p.workspaceId, 'project.member_role_changed', user.id, { projectId: p.id, targetUserId: m.userId, from, to: body.role }); save();
    return [200, { userId: m.userId, username: db.users[m.userId]?.username, role: m.role }];
  });
  route('DELETE', '/api/projects/:id/members/:uid', ({ user, params }) => {
    const p = getProject(user, params.id, 'lead');
    const m = p.members.find(m => m.userId === params.uid || db.users[m.userId]?.username === params.uid); if (!m) throw notFound('Member not found');
    p.members = p.members.filter(x => x !== m);
    audit(p.workspaceId, 'project.member_removed', user.id, { projectId: p.id, targetUserId: m.userId }); save();
    return [204];
  });
  route('GET', '/api/projects/:id/workflow', ({ user, params }) => [200, getProject(user, params.id).workflow]);
  route('PUT', '/api/projects/:id/workflow', ({ user, params, body }) => {
    const p = getProject(user, params.id, 'lead');
    if (!Array.isArray(body.statuses) || !body.statuses.length) throw bad('statuses required');
    const names = new Set();
    for (const s of body.statuses) {
      if (!isObj(s) || !isStr(s.name) || !s.name.trim()) throw bad('status name required');
      if (!CATS.includes(s.category)) throw bad('invalid status category');
      if (names.has(s.name)) throw bad('duplicate status name');
      names.add(s.name);
    }
    let transitions = body.transitions;
    if (transitions === undefined) { transitions = []; for (const a of names) for (const b of names) if (a !== b) transitions.push([a, b]); }
    if (!Array.isArray(transitions)) throw bad('transitions must be an array');
    for (const t of transitions) if (!Array.isArray(t) || t.length !== 2 || !names.has(t[0]) || !names.has(t[1])) throw bad('transition references unknown status');
    const remap = body.remap ?? {};
    if (!isObj(remap)) throw bad('remap must be an object');
    const issues = vals(db.issues).filter(i => i.projectId === p.id);
    const removedInUse = [...new Set(issues.map(i => i.status))].filter(s => !names.has(s));
    for (const s of removedInUse) if (!isStr(remap[s]) || !names.has(remap[s])) throw bad(`Status "${s}" is in use; provide remap`);
    const statuses = body.statuses.map(s => ({ name: s.name, category: s.category }));
    p.workflow = { statuses, transitions: transitions.map(t => [t[0], t[1]]) };
    const t = iso();
    for (const i of issues) {
      if (remap[i.status] && !names.has(i.status)) { record(i, 'status', i.status, remap[i.status], user.id); i.status = remap[i.status]; i.updatedAt = t; }
      const done = catOf(p, i.status) === 'completed';
      if (done && !i.resolvedAt) i.resolvedAt = t; else if (!done && i.resolvedAt) i.resolvedAt = null;
    }
    audit(p.workspaceId, 'workflow.updated', user.id, { projectId: p.id }); save();
    return [200, p.workflow];
  });

  // --- issues
  route('POST', '/api/projects/:id/issues', ({ user, params, body }) => {
    const p = getProject(user, params.id, 'developer');
    const i = createIssue(p, user, body); save(); return [201, view(i, true)];
  });
  route('GET', '/api/projects/:id/issues', ({ user, params, query }) => {
    const p = getProject(user, params.id);
    return [200, vals(db.issues).filter(i => i.projectId === p.id).map(i => view(i))];
  });
  route('GET', '/api/issues/:key', ({ user, params }) => [200, view(getIssue(user, params.key), true)]);
  route('PATCH', '/api/issues/:key', ({ user, params, body }) => {
    const i = getIssue(user, params.key, 'developer'); const p = db.projects[i.projectId];
    updateIssue(p, user, i, body); save(); return [200, view(i, true)];
  });
  route('DELETE', '/api/issues/:key', ({ user, params }) => {
    const i = getIssue(user, params.key, 'developer'); deleteIssue(db.projects[i.projectId], user, i); save(); return [204];
  });
  route('GET', '/api/issues/:key/history', ({ user, params }) => [200, (getIssue(user, params.key)._history || []).map(h => ({ ...h }))]);
  route('POST', '/api/issues/:key/watch', ({ user, params }) => {
    const i = getIssue(user, params.key); if (!i.watchers.includes(user.id)) i.watchers.push(user.id); save(); return [200, view(i, true)];
  });
  route('DELETE', '/api/issues/:key/watch', ({ user, params }) => {
    const i = getIssue(user, params.key); i.watchers = i.watchers.filter(w => w !== user.id); save(); return [200, view(i, true)];
  });
  route('POST', '/api/issues/:key/links', ({ user, params, body }) => {
    const i = getIssue(user, params.key, 'developer');
    if (!(body.type in LINK_INV)) throw bad('invalid link type');
    if (!isStr(body.target)) throw bad('target required');
    const t = getIssue(user, body.target, 'viewer');
    if (t.id === i.id) throw bad('Cannot link an issue to itself');
    const exists = vals(db.links).some(l => (l.sourceId === i.id && l.targetId === t.id && l.type === body.type) || (body.type === 'relates' && l.type === 'relates' && l.sourceId === t.id && l.targetId === i.id));
    if (exists) throw conflict('Link already exists');
    const l = { id: rid(), type: body.type, sourceId: i.id, targetId: t.id };
    db.links[l.id] = l; i.updatedAt = iso(); save();
    return [201, { id: l.id, type: l.type, key: t.key, target: t.key }];
  });
  route('DELETE', '/api/issues/:key/links/:lid', ({ user, params }) => {
    const i = getIssue(user, params.key, 'developer');
    const l = db.links[params.lid]; if (!l || (l.sourceId !== i.id && l.targetId !== i.id)) throw notFound('Link not found');
    delete db.links[l.id]; save(); return [204];
  });

  // --- comments
  const cView = (c) => { const i = db.issues[c.issueId]; return { id: c.id, issueKey: i?.key, issueId: c.issueId, authorId: c.authorId, body: c.body, createdAt: c.createdAt, updatedAt: c.updatedAt, edited: c.edited }; };
  const cBody = (b) => { const t = b.body ?? b.text; if (!isStr(t) || !t.trim()) throw bad('body required'); return t; };
  route('POST', '/api/issues/:key/comments', ({ user, params, body }) => {
    const i = getIssue(user, params.key, 'developer'); const p = db.projects[i.projectId];
    const text = cBody(body);
    const c = { id: rid(), issueId: i.id, authorId: user.id, body: text, createdAt: iso(), updatedAt: iso(), edited: false };
    db.comments[c.id] = c;
    const mentioned = new Set();
    for (const m of text.matchAll(/@([A-Za-z0-9_.-]+)/g)) {
      const u = userByName(m[1].replace(/[.-]+$/, '')) || userByName(m[1]);
      if (u && u.id !== user.id && projRole(u, p)) mentioned.add(u.id);
    }
    for (const uid of mentioned) notify(uid, 'mention', i, user.id);
    notifyWatchers(i, 'comment', user.id, mentioned);
    emit(p, 'comment.created', i, user.id, { comment: cView(c) });
    save(); return [201, cView(c)];
  });
  route('GET', '/api/issues/:key/comments', ({ user, params }) => {
    const i = getIssue(user, params.key);
    return [200, vals(db.comments).filter(c => c.issueId === i.id).map(cView)];
  });
  route('PATCH', '/api/comments/:id', ({ user, params, body }) => {
    const c = db.comments[params.id]; if (!c) throw notFound('Comment not found');
    getIssue(user, c.issueId);
    if (c.authorId !== user.id) throw forbidden('Only the author can edit');
    c.body = cBody(body); c.edited = true; c.updatedAt = iso(); save(); return [200, cView(c)];
  });
  route('DELETE', '/api/comments/:id', ({ user, params }) => {
    const c = db.comments[params.id]; if (!c) throw notFound('Comment not found');
    const i = getIssue(user, c.issueId);
    if (c.authorId !== user.id && projRole(user, db.projects[i.projectId]) !== 'lead') throw forbidden('Not allowed');
    delete db.comments[c.id]; save(); return [204];
  });

  // --- notifications
  const nView = (n) => ({ id: n.id, type: n.type, issueKey: n.issueKey, actorId: n.actorId, at: n.at, read: n.read });
  route('GET', '/api/notifications', ({ user, query }) => {
    let l = vals(db.notifications).filter(n => n.userId === user.id);
    if (query.get('unread') === 'true') l = l.filter(n => !n.read);
    return [200, l.reverse().map(nView)];
  });
  route('POST', '/api/notifications/read', ({ user, body }) => {
    const mine = vals(db.notifications).filter(n => n.userId === user.id);
    if (body.all === true) mine.forEach(n => { n.read = true; });
    else if (Array.isArray(body.ids)) { const s = new Set(body.ids); mine.forEach(n => { if (s.has(n.id)) n.read = true; }); }
    else throw bad('ids or all required');
    save(); return [200, { ok: true }];
  });

  // --- sprints
  const spView = (s) => pub(s);
  const getSprint = (user, id, min = 'viewer') => { const s = db.sprints[id]; if (!s) throw notFound('Sprint not found'); getProject(user, s.projectId, min); return s; };
  route('POST', '/api/projects/:id/sprints', ({ user, params, body }) => {
    const p = getProject(user, params.id, 'developer');
    if (!isStr(body.name) || !body.name.trim()) throw bad('name required');
    for (const k of ['startDate', 'endDate']) if (body[k] != null && (!isStr(body[k]) || !/^\d{4}-\d{2}-\d{2}$/.test(body[k]) || isNaN(Date.parse(body[k])))) throw bad(`${k} must be YYYY-MM-DD`);
    if (body.startDate && body.endDate && body.endDate < body.startDate) throw bad('endDate before startDate');
    const s = { id: rid(), projectId: p.id, name: body.name.trim(), state: 'planned', startDate: body.startDate ?? null, endDate: body.endDate ?? null, createdAt: iso() };
    db.sprints[s.id] = s; save(); return [201, spView(s)];
  });
  route('GET', '/api/projects/:id/sprints', ({ user, params }) => { const p = getProject(user, params.id); return [200, vals(db.sprints).filter(s => s.projectId === p.id).map(spView)]; });
  route('GET', '/api/sprints/:id', ({ user, params }) => [200, spView(getSprint(user, params.id))]);
  route('POST', '/api/sprints/:id/start', ({ user, params }) => {
    const s = getSprint(user, params.id, 'developer');
    if (s.state !== 'planned') throw conflict('Sprint is not planned');
    if (vals(db.sprints).some(x => x.projectId === s.projectId && x.state === 'active')) throw conflict('Another sprint is already active');
    s.state = 'active'; s.startedAt = iso(); if (!s.startDate) s.startDate = today();
    if (s.endDate && s.endDate < s.startDate) s.endDate = s.startDate;
    save(); return [200, spView(s)];
  });
  route('POST', '/api/sprints/:id/complete', ({ user, params, body }) => {
    const s = getSprint(user, params.id, 'developer'); const p = db.projects[s.projectId];
    if (s.state !== 'active') throw conflict('Sprint is not active');
    const target = body.carryOverTo ?? 'backlog';
    let tid = null;
    if (target !== 'backlog') {
      const t = db.sprints[target];
      if (!isStr(target) || !t || t.projectId !== s.projectId || t.id === s.id || t.state === 'completed') throw bad('Invalid carryOverTo');
      tid = t.id;
    }
    const inS = vals(db.issues).filter(i => i.projectId === p.id && i.sprintId === s.id);
    const done = inS.filter(i => isDone(p, i)), open = inS.filter(i => !isDone(p, i));
    s.result = { completedPoints: done.reduce((a, i) => a + (i.storyPoints || 0), 0), completedIssues: done.length, carriedOver: open.length };
    for (const i of open) { record(i, 'sprintId', i.sprintId, tid, user.id); i.sprintId = tid; i.updatedAt = iso(); }
    s.state = 'completed'; s.completedAt = iso(); save(); return [200, spView(s)];
  });
  route('GET', '/api/sprints/:id/report', ({ user, params }) => [200, sprintReport(getSprint(user, params.id))]);

  route('GET', '/api/projects/:id/stats', ({ user, params }) => {
    const p = getProject(user, params.id);
    const issues = vals(db.issues).filter(i => i.projectId === p.id);
    const byStatus = Object.fromEntries(p.workflow.statuses.map(s => [s.name, 0])), byType = Object.fromEntries(TYPES.map(t => [t, 0])), byAssignee = {};
    const cycles = [];
    for (const i of issues) {
      byStatus[i.status] = (byStatus[i.status] || 0) + 1; byType[i.type] = (byType[i.type] || 0) + 1;
      const a = i.assigneeId ? db.users[i.assigneeId]?.username || i.assigneeId : 'unassigned'; byAssignee[a] = (byAssignee[a] || 0) + 1;
      if (i.resolvedAt) {
        let start = null;
        const h = (i._history || []).find(h => h.field === 'status' && catOf(p, h.to) === 'started');
        if (h) start = h.at; else if (!(i._history || []).some(h => h.field === 'status')) { /* created directly */ start = null; }
        if (!start) { const firstFrom = (i._history || []).find(h => h.field === 'status'); const init = firstFrom ? firstFrom.from : i.status; if (catOf(p, init) === 'started') start = i.createdAt; }
        if (start) cycles.push((Date.parse(i.resolvedAt) - Date.parse(start)) / 3600000);
      }
    }
    const avg = cycles.length ? cycles.reduce((a, b) => a + b, 0) / cycles.length : null;
    return [200, { total: issues.length, byStatus, byType, byAssignee, avgCycleTimeHours: avg, averageCycleTimeHours: avg, cycleTimeHours: avg }];
  });

  // --- search
  route('GET', '/api/search', ({ user, query }) => {
    let terms;
    try { terms = parseQuery(query.get('q') || ''); } catch (e) { if (e instanceof QueryError) throw bad(e.message); throw e; }
    const sort = query.get('sort') || 'updated';
    if (!['updated', 'created', 'priority'].includes(sort)) throw bad('invalid sort');
    const projQ = query.get('project');
    const ctx = { me: user.id, userByName, sprintOf: (i) => db.sprints[i.sprintId] };
    const accessible = new Map();
    let list = vals(db.issues).filter(i => {
      if (!accessible.has(i.projectId)) { const p = db.projects[i.projectId]; accessible.set(i.projectId, p && projRole(user, p) ? p : null); }
      const p = accessible.get(i.projectId); if (!p) return false;
      if (projQ && p.id !== projQ && p.key !== projQ) return false;
      return terms.every(t => matches(i, t, ctx));
    });
    const pr = (i) => PRIOS.length - PRIOS.indexOf(i.priority);
    list.sort((a, b) => {
      if (sort === 'priority') return (pr(b) - pr(a)) || (b._useq - a._useq);
      if (sort === 'created') return (b.createdAt < a.createdAt ? -1 : b.createdAt > a.createdAt ? 1 : 0) || vals(db.issues).indexOf(b) - vals(db.issues).indexOf(a);
      return (b.updatedAt < a.updatedAt ? -1 : b.updatedAt > a.updatedAt ? 1 : 0) || (b._useq - a._useq);
    });
    return [200, list.map(i => view(i))];
  });

  // --- CSV
  const COLS = ['key', 'type', 'title', 'status', 'priority', 'assignee', 'labels', 'storyPoints', 'parent', 'epic', 'sprint', 'dueDate', 'createdAt', 'resolvedAt'];
  route('GET', '/api/projects/:id/export.csv', ({ user, params }) => {
    const p = getProject(user, params.id);
    const rows = [COLS];
    for (const i of vals(db.issues).filter(i => i.projectId === p.id)) {
      rows.push([i.key, i.type, i.title, i.status, i.priority, i.assigneeId ? db.users[i.assigneeId]?.username : '', i.labels.join(';'), i.storyPoints, i.parentId ? db.issues[i.parentId]?.key : '', i.epicId ? db.issues[i.epicId]?.key : '', i.sprintId, i.dueDate, i.createdAt, i.resolvedAt]);
    }
    return [200, toCsv(rows), 'text/csv; charset=utf-8'];
  });
  route('POST', '/api/projects/:id/import.csv', ({ user, params, rawBody }) => {
    const p = getProject(user, params.id, 'developer');
    let rows;
    try { rows = parseCsv(rawBody); } catch (e) { throw bad('Malformed CSV: ' + e.message); }
    if (!rows.length) throw bad('Empty CSV');
    const header = rows[0].cells.map(h => h.trim());
    if (!header.includes('title')) throw bad('Missing title column');
    const errors = []; let created = 0;
    for (const r of rows.slice(1)) {
      try {
        const g = (c) => { const ix = header.indexOf(c); const v = ix >= 0 ? (r.cells[ix] ?? '').trim() : ''; return v; };
        if (r.cells.length > header.length) throw bad('Too many fields');
        const d = { title: g('title') };
        if (g('type')) d.type = g('type');
        if (g('status')) d.status = g('status');
        if (g('priority')) d.priority = g('priority');
        if (g('assignee')) { const u = userByName(g('assignee')); if (!u) throw bad('Unknown assignee: ' + g('assignee')); d.assigneeId = u.id; }
        if (g('labels')) d.labels = g('labels').split(';').map(s => s.trim()).filter(Boolean);
        if (g('storyPoints')) { const n = Number(g('storyPoints')); if (!isFinite(n)) throw bad('Invalid storyPoints'); d.storyPoints = n; }
        const ref = (v, what) => { const t = vals(db.issues).find(i => i.projectId === p.id && (i.key === v || i.id === v)); if (!t) throw bad(`Unknown ${what}: ${v}`); return t.id; };
        if (g('parent')) d.parentId = ref(g('parent'), 'parent');
        if (g('epic')) d.epicId = ref(g('epic'), 'epic');
        if (g('sprint')) { const s = vals(db.sprints).find(s => s.projectId === p.id && (s.id === g('sprint') || s.name === g('sprint'))); if (!s) throw bad('Unknown sprint: ' + g('sprint')); d.sprintId = s.id; }
        if (g('dueDate')) d.dueDate = g('dueDate');
        createIssue(p, user, d); created++;
      } catch (e) {
        if (e instanceof HttpError) errors.push({ line: r.line, message: e.message }); else throw e;
      }
    }
    save(); return [200, { created, errors }];
  }, { raw: true });

  // --- webhooks
  const hView = (h) => ({ id: h.id, projectId: h.projectId, url: h.url, events: h.events, createdAt: h.createdAt });
  const EVENTS = ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'];
  route('POST', '/api/projects/:id/webhooks', ({ user, params, body }) => {
    const p = getProject(user, params.id, 'lead');
    let u; try { u = new URL(body.url); } catch { throw bad('valid url required'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw bad('url must be http(s)');
    if (!Array.isArray(body.events) || !body.events.length || body.events.some(e => !EVENTS.includes(e))) throw bad('invalid events');
    if (body.secret != null && !isStr(body.secret)) throw bad('secret must be string');
    const h = { id: rid(), projectId: p.id, url: body.url, events: [...new Set(body.events)], secret: body.secret || '', createdAt: iso() };
    db.webhooks[h.id] = h; audit(p.workspaceId, 'webhook.created', user.id, { projectId: p.id, webhookId: h.id, url: h.url }); save();
    return [201, hView(h)];
  });
  route('GET', '/api/projects/:id/webhooks', ({ user, params }) => { const p = getProject(user, params.id, 'lead'); return [200, vals(db.webhooks).filter(h => h.projectId === p.id).map(hView)]; });
  const getHook = (user, id) => { const h = db.webhooks[id]; if (!h) throw notFound('Webhook not found'); getProject(user, h.projectId, 'lead'); return h; };
  route('DELETE', '/api/webhooks/:id', ({ user, params }) => {
    const h = getHook(user, params.id); delete db.webhooks[h.id];
    audit(db.projects[h.projectId].workspaceId, 'webhook.deleted', user.id, { projectId: h.projectId, webhookId: h.id }); save(); return [204];
  });
  route('GET', '/api/webhooks/:id/deliveries', ({ user, params }) => {
    const h = getHook(user, params.id);
    return [200, vals(db.deliveries).filter(d => d.webhookId === h.id).map(d => ({ ...d }))];
  });

  // ---------- server ----------
  async function readBody(req) {
    const chunks = []; let n = 0;
    for await (const c of req) { n += c.length; if (n > 5 * 1024 * 1024) throw new HttpError(413, 'too_large', 'Body too large'); chunks.push(c); }
    return Buffer.concat(chunks).toString('utf8');
  }
  function send(res, status, payload, ctype) {
    if (status === 204) { res.writeHead(204); return res.end(); }
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    res.writeHead(status, { 'content-type': ctype || 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
    res.end(data);
  }
  function serveStatic(req, res, pathname) {
    let rel = pathname === '/' || pathname === '/index.html' ? 'index.html' : pathname.replace(/^\/static\//, '');
    const file = path.normalize(path.join(STATIC_DIR, rel));
    if (!file.startsWith(STATIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: 'not_found', message: 'Not found' });
    const data = fs.readFileSync(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-length': data.length });
    res.end(data);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const pathname = url.pathname;
      if (req.method === 'GET' && (pathname === '/' || pathname.startsWith('/static/') || pathname === '/index.html')) return serveStatic(req, res, pathname);
      if (!pathname.startsWith('/api/')) throw notFound();
      let match = null, pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(pathname); if (!m) continue;
        pathMatched = true;
        if (r.method !== req.method) continue;
        match = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) }; break;
      }
      if (!match) { if (pathMatched) throw new HttpError(405, 'method_not_allowed', 'Method not allowed'); throw notFound('Route not found'); }
      let user = null, tokenHash = null;
      if (match.r.auth) {
        const h = req.headers.authorization || '';
        const m = /^Bearer\s+(.+)$/i.exec(h);
        if (!m) throw new HttpError(401, 'unauthorized', 'Authentication required');
        tokenHash = sha(m[1].trim());
        const s = db.sessions[tokenHash] || vals(db.apiTokens).find(t => t.hash === tokenHash);
        user = s && db.users[s.userId];
        if (!user) throw new HttpError(401, 'unauthorized', 'Invalid token');
      }
      const rawBody = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : '';
      let body = {};
      if (!match.r.raw && rawBody.trim()) {
        try { body = JSON.parse(rawBody); } catch { throw bad('Invalid JSON'); }
        if (!isObj(body)) throw bad('Body must be a JSON object');
      }
      const out = match.r.handler({ req, user, tokenHash, params: match.params, query: url.searchParams, body, rawBody });
      send(res, out[0], out[1], out[2]);
    } catch (e) {
      if (e instanceof HttpError) send(res, e.status, { error: e.error, message: e.message });
      else { console.error(e); send(res, 500, { error: 'internal_error', message: 'Internal server error' }); }
    }
  });
  return server;
}
