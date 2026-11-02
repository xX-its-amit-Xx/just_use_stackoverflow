import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseQuery, matches, QueryError } from './search.js';
import { toCsv, parseCsv } from './csv.js';

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');
const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIOS = ['urgent', 'high', 'medium', 'low', 'none'];
const CATS = ['backlog', 'unstarted', 'started', 'completed'];
const WS_ROLES = ['admin', 'member', 'guest'];
const PROJ_ROLES = ['lead', 'developer', 'viewer'];
const RANK = { viewer: 1, developer: 2, lead: 3 };
const EVENTS = ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'];
const LINK_TYPES = ['blocks', 'relates', 'duplicates'];
const INVERSE = { blocks: 'blocked_by', relates: 'relates', duplicates: 'duplicated_by' };
const DEFAULT_STATUSES = [['Backlog', 'backlog'], ['Todo', 'unstarted'], ['In Progress', 'started'], ['In Review', 'started'], ['Done', 'completed']];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

class HttpError extends Error {
  constructor(status, error, message) { super(message); this.status = status; this.error = error; }
}
const bad = (m) => new HttpError(400, 'bad_request', m);
const notFound = (m = 'not found') => new HttpError(404, 'not_found', m);
const forbidden = (m = 'forbidden') => new HttpError(403, 'forbidden', m);
const conflict = (m, code = 'conflict') => new HttpError(409, code, m);

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const uid = () => crypto.randomUUID();
const isStr = (v) => typeof v === 'string';
const dateOk = (s) => isStr(s) && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
}
function checkPw(pw, stored) {
  const [, salt, h] = stored.split('$');
  const a = crypto.scryptSync(pw, salt, 32); const b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createServer({ dataFile, clock } = {}) {
  const now = () => (clock ? clock() : new Date());
  const iso = () => now().toISOString();
  let db = { users: [], sessions: [], apiTokens: [], workspaces: [], projects: [], issues: [], comments: [], sprints: [], notifications: [], webhooks: [], deliveries: [], audit: [], counters: {} };
  if (dataFile && fs.existsSync(dataFile)) {
    try { db = { ...db, ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) }; } catch { /* start empty */ }
  }
  const loginFails = new Map();
  function save() {
    if (!dataFile) return;
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, dataFile);
  }

  // ---------- lookups ----------
  const userById = (id) => db.users.find(u => u.id === id);
  const wsById = (id) => db.workspaces.find(w => w.id === id);
  const projById = (id) => db.projects.find(p => p.id === id);
  const sprintById = (id) => db.sprints.find(s => s.id === id);
  const issueById = (id) => db.issues.find(i => i.id === id);
  const wsRole = (user, ws) => ws && (ws.members.find(m => m.userId === user.id)?.role || null);
  function projRole(user, p) {
    const ws = wsById(p.workspaceId); const wr = wsRole(user, ws);
    if (!wr) return null;
    if (wr === 'admin') return 'lead';
    const pm = p.members.find(m => m.userId === user.id);
    if (pm) return pm.role;
    return wr === 'member' ? 'developer' : null;
  }
  const catOf = (p, status) => p.workflow.statuses.find(s => s.name === status)?.category;
  const isDone = (p, issue) => catOf(p, issue.status) === 'completed';

  function audit(wsId, actor, action, details = {}) {
    db.audit.push({ id: uid(), workspaceId: wsId, action, actorId: actor.id, at: iso(), details });
  }

  // ---------- serialization ----------
  const pubUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName, createdAt: u.createdAt });
  function pubWs(w, user) {
    return { id: w.id, name: w.name, key: w.key, createdAt: w.createdAt, role: wsRole(user, w), members: w.members.map(m => ({ userId: m.userId, username: userById(m.userId)?.username, role: m.role })) };
  }
  function pubProject(p, user) {
    return { id: p.id, workspaceId: p.workspaceId, name: p.name, key: p.key, createdAt: p.createdAt, workflow: p.workflow, role: projRole(user, p), members: p.members.map(m => ({ userId: m.userId, username: userById(m.userId)?.username, role: m.role })) };
  }
  function linksOf(issue) {
    const out = [];
    for (const l of db.issues.flatMap(i => i.links || [])) {
      if (l.from === issue.id) { const t = issueById(l.to); if (t) out.push({ id: l.id, type: l.type, key: t.key, target: t.key }); }
      else if (l.to === issue.id) { const t = issueById(l.from); if (t) out.push({ id: l.id, type: INVERSE[l.type], key: t.key, target: t.key }); }
    }
    return out;
  }
  function pubIssue(issue, detail = true) {
    const { history, links, ...rest } = issue;
    const out = { ...rest };
    const p = projById(issue.projectId);
    out.projectKey = p?.key;
    if (detail) {
      out.children = db.issues.filter(i => i.parentId === issue.id).map(i => i.key);
      out.links = linksOf(issue);
      if (issue.type === 'epic') {
        const ch = db.issues.filter(i => i.epicId === issue.id);
        out.progress = { total: ch.length, done: ch.filter(i => i.resolvedAt).length, points_total: ch.reduce((a, i) => a + (i.storyPoints || 0), 0), points_done: ch.filter(i => i.resolvedAt).reduce((a, i) => a + (i.storyPoints || 0), 0) };
      }
    }
    return out;
  }

  // ---------- request context helpers ----------
  function getWs(ctx, id, minAdmin = false) {
    const ws = wsById(id);
    if (!ws || !wsRole(ctx.user, ws)) throw notFound('workspace not found');
    if (minAdmin && wsRole(ctx.user, ws) !== 'admin') throw forbidden('admin only');
    return ws;
  }
  function getProject(ctx, id, min = 'viewer') {
    const p = projById(id);
    if (!p) throw notFound('project not found');
    const r = projRole(ctx.user, p);
    if (!r) throw notFound('project not found');
    if (RANK[r] < RANK[min]) throw forbidden('insufficient project role');
    ctx.role = r;
    return p;
  }
  function getIssue(ctx, key, min = 'viewer') {
    const k = String(key).toUpperCase();
    for (const i of db.issues) {
      if (i.key.toUpperCase() !== k && i.id !== key) continue;
      const p = projById(i.projectId);
      const r = projRole(ctx.user, p);
      if (!r) continue;
      if (RANK[r] < RANK[min]) throw forbidden('insufficient project role');
      ctx.role = r;
      return { issue: i, project: p };
    }
    throw notFound('issue not found');
  }
  function findIssueRef(project, ref) {
    if (!isStr(ref)) return null;
    return db.issues.find(i => i.projectId === project.id && (i.id === ref || i.key === ref.toUpperCase()));
  }
  function resolveUser(project, ref) {
    if (!isStr(ref)) throw bad('invalid assignee');
    const u = db.users.find(x => x.id === ref || x.username.toLowerCase() === ref.toLowerCase());
    if (!u || !projRole(u, project)) throw bad('assignee must be a member of the project');
    return u;
  }

  // ---------- notifications / webhooks ----------
  function notify(userIds, type, issue, actor, extra = {}) {
    const p = projById(issue.projectId);
    for (const id of new Set(userIds)) {
      if (id === actor.id) continue;
      const u = userById(id);
      if (!u || !projRole(u, p)) continue;
      db.notifications.push({ id: uid(), userId: id, type, issueKey: issue.key, actorId: actor.id, at: iso(), read: false, ...extra });
    }
  }
  function emit(event, issue, actor, extra = {}) {
    for (const wh of db.webhooks) {
      if (wh.projectId !== issue.projectId || !wh.events.includes(event)) continue;
      deliver(wh, { event, issue: pubIssue(issue), actorId: actor.id, at: iso(), ...extra }).catch(() => {});
    }
  }
  async function deliver(wh, payload) {
    const d = { id: uid(), webhookId: wh.id, event: payload.event, status: 'pending', attempts: 0, lastError: null, at: payload.at };
    db.deliveries.push(d);
    const body = JSON.stringify(payload);
    const sig = 'sha256=' + crypto.createHmac('sha256', wh.secret || '').update(body).digest('hex');
    for (let a = 1; a <= 3; a++) {
      d.attempts = a;
      try {
        const r = await fetch(wh.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pm-signature': sig, 'x-pm-event': payload.event }, body, signal: AbortSignal.timeout(5000) });
        d.responseStatus = r.status;
        if (r.ok) { d.status = 'success'; d.lastError = null; break; }
        d.lastError = `HTTP ${r.status}`;
      } catch (e) { d.lastError = String(e.message || e); }
      if (a < 3) await sleep(50 * a);
    }
    if (d.status !== 'success') d.status = 'failed';
    save();
  }

  // ---------- issue logic ----------
  const FIELDS = ['type', 'title', 'description', 'status', 'priority', 'assigneeId', 'labels', 'storyPoints', 'parentId', 'epicId', 'sprintId', 'dueDate'];
  function nextState(project, base, body, isCreate) {
    const n = {};
    for (const f of FIELDS) n[f] = base[f];
    if (body.assignee !== undefined && body.assigneeId === undefined) body = { ...body, assigneeId: body.assignee };
    if ('type' in body) { if (!TYPES.includes(body.type)) throw bad('invalid type'); n.type = body.type; }
    if ('title' in body) { if (!isStr(body.title) || !body.title.trim() || body.title.length > 500) throw bad('title is required'); n.title = body.title.trim(); }
    if ('description' in body) { if (body.description !== null && !isStr(body.description)) throw bad('invalid description'); n.description = body.description ?? ''; }
    if ('priority' in body) { if (!PRIOS.includes(body.priority)) throw bad('invalid priority'); n.priority = body.priority; }
    if ('labels' in body) {
      if (!Array.isArray(body.labels) || body.labels.some(l => !isStr(l) || !l.trim())) throw bad('invalid labels');
      n.labels = [...new Set(body.labels.map(l => l.trim()))];
    }
    if ('storyPoints' in body) {
      const v = body.storyPoints;
      if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) throw bad('invalid storyPoints');
      n.storyPoints = v;
    }
    if ('dueDate' in body) { if (body.dueDate !== null && !dateOk(body.dueDate)) throw bad('invalid dueDate'); n.dueDate = body.dueDate; }
    if ('assigneeId' in body) n.assigneeId = body.assigneeId === null || body.assigneeId === '' ? null : resolveUser(project, body.assigneeId).id;
    if ('status' in body) {
      if (!isStr(body.status) || !project.workflow.statuses.some(s => s.name === body.status)) throw bad('unknown status');
      n.status = body.status;
    }
    if ('parentId' in body) {
      if (body.parentId === null) n.parentId = null;
      else { const pi = findIssueRef(project, body.parentId); if (!pi) throw bad('parent not found in project'); n.parentId = pi.id; }
    }
    if ('epicId' in body) {
      if (body.epicId === null) n.epicId = null;
      else { const e = findIssueRef(project, body.epicId); if (!e || e.type !== 'epic') throw bad('epicId must reference an epic in the project'); n.epicId = e.id; }
    }
    if ('sprintId' in body) {
      if (body.sprintId === null) n.sprintId = null;
      else {
        const s = db.sprints.find(x => x.id === body.sprintId && x.projectId === project.id);
        if (!s) throw bad('sprint not found in project');
        if (s.state === 'completed' && base.sprintId !== s.id) throw bad('sprint is completed');
        n.sprintId = s.id;
      }
    }
    // cross validation
    if (n.type === 'subtask') {
      if (!n.parentId) throw bad('subtask requires parentId');
      const par = issueById(n.parentId);
      if (!par || par.projectId !== project.id || par.type === 'subtask') throw bad('invalid parent');
    } else if (n.parentId) throw bad('only subtasks may have a parent');
    if (n.type === 'epic' && n.epicId) throw bad('epic cannot belong to an epic');
    if (!isCreate && base.type === 'epic' && n.type !== 'epic' && db.issues.some(i => i.epicId === base.id)) throw bad('epic has children');
    return n;
  }
  function checkTransition(ctxIssue, project, newStatus) {
    const old = ctxIssue.status;
    if (old === newStatus) return;
    if (!project.workflow.transitions.some(([f, t]) => f === old && t === newStatus)) throw conflict(`transition ${old} -> ${newStatus} not allowed`, 'invalid_transition');
    if (catOf(project, newStatus) === 'completed' && catOf(project, old) !== 'completed') {
      for (const src of db.issues) {
        for (const l of src.links || []) {
          if (l.type === 'blocks' && l.to === ctxIssue.id) {
            const blocker = issueById(l.from);
            if (blocker && !isDone(projById(blocker.projectId), blocker)) throw conflict(`blocked by ${blocker.key}`, 'blocked');
          }
        }
      }
    }
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function record(issue, field, from, to, actor, at = iso()) {
    issue.history.push({ field, from, to, actorId: actor.id, at });
  }
  function noteSprint(issue) {
    if (!issue.sprintId) return;
    const s = sprintById(issue.sprintId);
    if (s && !s.scope.includes(issue.id)) s.scope.push(issue.id);
  }
  function updateIssue(issue, project, body, actor) {
    const n = nextState(project, issue, body, false);
    if (n.status !== issue.status) checkTransition(issue, project, n.status);
    const at = iso();
    const changed = [];
    for (const f of FIELDS) {
      if (same(n[f], issue[f])) continue;
      record(issue, f, issue[f], n[f], actor, at);
      changed.push(f);
    }
    if (!changed.length) return changed;
    const wasDone = isDone(project, issue);
    const prev = { status: issue.status, assigneeId: issue.assigneeId };
    for (const f of changed) issue[f] = n[f];
    if (changed.includes('status')) {
      const nowDone = isDone(project, issue);
      if (nowDone && !wasDone) issue.resolvedAt = at; else if (!nowDone && wasDone) issue.resolvedAt = null;
    }
    if (changed.includes('assigneeId') && issue.assigneeId && !issue.watchers.includes(issue.assigneeId)) issue.watchers.push(issue.assigneeId);
    if (changed.includes('sprintId')) noteSprint(issue);
    issue.updatedAt = at;
    if (changed.includes('status')) notify(issue.watchers, 'status_changed', issue, actor, { from: prev.status, to: issue.status });
    if (changed.includes('assigneeId')) notify(issue.watchers, 'assigned', issue, actor);
    emit('issue.updated', issue, actor, { changes: changed });
    return changed;
  }
  function createIssue(project, body, actor, { skipEmit = false } = {}) {
    const first = project.workflow.statuses.find(s => s.category === 'unstarted') || project.workflow.statuses[0];
    const base = { type: 'task', title: '', description: '', status: first.name, priority: 'none', assigneeId: null, labels: [], storyPoints: null, parentId: null, epicId: null, sprintId: null, dueDate: null };
    if (!isStr(body.title)) throw bad('title is required');
    const n = nextState(project, base, body, true);
    project.nextNumber = (project.nextNumber || 1);
    const num = project.nextNumber++;
    const at = iso();
    const issue = { id: uid(), key: `${project.key}-${num}`, projectId: project.id, ...n, reporterId: actor.id, watchers: [], createdAt: at, updatedAt: at, resolvedAt: catOf(project, n.status) === 'completed' ? at : null, history: [], links: [] };
    issue.watchers.push(actor.id);
    if (issue.assigneeId && !issue.watchers.includes(issue.assigneeId)) issue.watchers.push(issue.assigneeId);
    db.issues.push(issue);
    noteSprint(issue);
    if (issue.assigneeId) notify([issue.assigneeId], 'assigned', issue, actor);
    if (!skipEmit) emit('issue.created', issue, actor);
    return issue;
  }
  function deleteIssue(issue, actor) {
    const subs = db.issues.filter(i => i.parentId === issue.id);
    for (const s of subs) deleteIssue(s, actor);
    for (const e of db.issues) {
      if (e.epicId === issue.id) e.epicId = null;
      e.links = (e.links || []).filter(l => l.from !== issue.id && l.to !== issue.id);
    }
    db.comments = db.comments.filter(c => c.issueId !== issue.id);
    db.issues = db.issues.filter(i => i !== issue);
    for (const s of db.sprints) s.scope = s.scope.filter(x => x !== issue.id);
    emit('issue.deleted', issue, actor);
  }

  // ---------- search ----------
  function runSearch(ctx, q, projects, sort) {
    let terms;
    try { terms = parseQuery(q || ''); } catch (e) { if (e instanceof QueryError) throw bad('malformed query: ' + e.message); throw e; }
    const env = { me: ctx.user, userById, sprintById };
    const ids = new Set(projects.map(p => p.id));
    let res = db.issues.filter(i => ids.has(i.projectId) && terms.every(t => matches(i, t, env)));
    const pr = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
    if (sort === 'created') res.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    else if (sort === 'priority') res.sort((a, b) => pr[a.priority] - pr[b.priority] || b.updatedAt.localeCompare(a.updatedAt));
    else res.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return res;
  }

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, public: !!opts.public });
  };

  // --- auth
  route('POST', '/api/auth/register', (ctx) => {
    const { username, password, displayName } = ctx.body;
    if (!isStr(username) || !/^[A-Za-z0-9_.-]{3,32}$/.test(username)) throw bad('username must be 3-32 chars (letters, digits, _ . -)');
    if (!isStr(password) || password.length < 8) throw bad('password must be at least 8 characters');
    if (displayName !== undefined && !isStr(displayName)) throw bad('invalid displayName');
    if (db.users.some(u => u.username.toLowerCase() === username.toLowerCase())) throw conflict('username taken');
    const u = { id: uid(), username, displayName: displayName || username, passwordHash: hashPw(password), createdAt: iso() };
    db.users.push(u);
    return [201, pubUser(u)];
  }, { public: true });
  route('POST', '/api/auth/login', (ctx) => {
    const { username, password } = ctx.body;
    if (!isStr(username) || !isStr(password)) throw bad('username and password required');
    const key = username.toLowerCase();
    const t = now().getTime();
    let rec = loginFails.get(key);
    if (rec && t - rec.first > 60000) rec = null;
    if (rec && rec.count >= 5) throw new HttpError(429, 'rate_limited', 'too many failed login attempts');
    const u = db.users.find(x => x.username.toLowerCase() === key);
    if (!u || !checkPw(password, u.passwordHash)) {
      if (!rec) rec = { first: t, count: 0 };
      rec.count++; loginFails.set(key, rec);
      throw new HttpError(401, 'unauthorized', 'invalid credentials');
    }
    loginFails.delete(key);
    const token = crypto.randomBytes(32).toString('hex');
    db.sessions.push({ hash: sha(token), userId: u.id, createdAt: iso() });
    return [200, { token, user: pubUser(u) }];
  }, { public: true });
  route('POST', '/api/auth/logout', (ctx) => {
    db.sessions = db.sessions.filter(s => s.hash !== ctx.tokenHash);
    return [204];
  });
  route('GET', '/api/auth/me', (ctx) => [200, pubUser(ctx.user)]);
  route('PATCH', '/api/auth/me', (ctx) => {
    const { displayName, password, currentPassword } = ctx.body;
    if (displayName !== undefined && (!isStr(displayName) || !displayName.trim())) throw bad('invalid displayName');
    if (password !== undefined) {
      if (!isStr(password) || password.length < 8) throw bad('password must be at least 8 characters');
      if (!isStr(currentPassword)) throw bad('currentPassword required');
      if (!checkPw(currentPassword, ctx.user.passwordHash)) throw forbidden('current password incorrect');
      ctx.user.passwordHash = hashPw(password);
    }
    if (displayName !== undefined) ctx.user.displayName = displayName.trim();
    return [200, pubUser(ctx.user)];
  });

  // --- tokens
  route('POST', '/api/tokens', (ctx) => {
    if (!isStr(ctx.body.name) || !ctx.body.name.trim()) throw bad('name required');
    const token = 'pmt_' + crypto.randomBytes(24).toString('hex');
    const t = { id: uid(), userId: ctx.user.id, name: ctx.body.name.trim(), hash: sha(token), createdAt: iso() };
    db.apiTokens.push(t);
    for (const w of db.workspaces) if (wsRole(ctx.user, w)) audit(w.id, ctx.user, 'token.created', { tokenId: t.id, name: t.name });
    return [201, { id: t.id, name: t.name, token, createdAt: t.createdAt }];
  });
  route('GET', '/api/tokens', (ctx) => [200, db.apiTokens.filter(t => t.userId === ctx.user.id).map(t => ({ id: t.id, name: t.name, createdAt: t.createdAt }))]);
  route('DELETE', '/api/tokens/:id', (ctx) => {
    const t = db.apiTokens.find(x => x.id === ctx.params.id && x.userId === ctx.user.id);
    if (!t) throw notFound('token not found');
    db.apiTokens = db.apiTokens.filter(x => x !== t);
    for (const w of db.workspaces) if (wsRole(ctx.user, w)) audit(w.id, ctx.user, 'token.deleted', { tokenId: t.id, name: t.name });
    return [204];
  });

  // --- workspaces
  route('POST', '/api/workspaces', (ctx) => {
    const { name, key } = ctx.body;
    if (!isStr(name) || !name.trim()) throw bad('name required');
    if (!isStr(key) || !/^[A-Z]{2,10}$/.test(key)) throw bad('key must be 2-10 uppercase letters');
    if (db.workspaces.some(w => w.key === key)) throw conflict('workspace key taken');
    const ws = { id: uid(), name: name.trim(), key, createdAt: iso(), members: [{ userId: ctx.user.id, role: 'admin' }] };
    db.workspaces.push(ws);
    audit(ws.id, ctx.user, 'workspace.created', { key });
    return [201, pubWs(ws, ctx.user)];
  });
  route('GET', '/api/workspaces', (ctx) => [200, db.workspaces.filter(w => wsRole(ctx.user, w)).map(w => pubWs(w, ctx.user))]);
  route('GET', '/api/workspaces/:id', (ctx) => [200, pubWs(getWs(ctx, ctx.params.id), ctx.user)]);
  route('GET', '/api/workspaces/:id/members', (ctx) => [200, pubWs(getWs(ctx, ctx.params.id), ctx.user).members]);
  route('POST', '/api/workspaces/:id/members', (ctx) => {
    const ws = getWs(ctx, ctx.params.id, true);
    const { username, role } = ctx.body;
    if (!isStr(username)) throw bad('username required');
    if (!WS_ROLES.includes(role)) throw bad('invalid role');
    const u = db.users.find(x => x.username.toLowerCase() === username.toLowerCase());
    if (!u) throw notFound('user not found');
    if (ws.members.some(m => m.userId === u.id)) throw conflict('already a member');
    ws.members.push({ userId: u.id, role });
    audit(ws.id, ctx.user, 'member.added', { userId: u.id, username: u.username, role });
    return [201, { userId: u.id, username: u.username, role }];
  });
  const findWsMember = (ws, ref) => ws.members.find(m => m.userId === ref || userById(m.userId)?.username.toLowerCase() === String(ref).toLowerCase());
  route('PATCH', '/api/workspaces/:id/members/:uid', (ctx) => {
    const ws = getWs(ctx, ctx.params.id, true);
    const m = findWsMember(ws, ctx.params.uid);
    if (!m) throw notFound('member not found');
    if (!WS_ROLES.includes(ctx.body.role)) throw bad('invalid role');
    if (m.role === 'admin' && ctx.body.role !== 'admin' && ws.members.filter(x => x.role === 'admin').length === 1) throw bad('cannot demote the last admin');
    const from = m.role; m.role = ctx.body.role;
    audit(ws.id, ctx.user, 'member.role_changed', { userId: m.userId, from, to: m.role });
    return [200, { userId: m.userId, username: userById(m.userId)?.username, role: m.role }];
  });
  route('DELETE', '/api/workspaces/:id/members/:uid', (ctx) => {
    const ws = getWs(ctx, ctx.params.id, true);
    const m = findWsMember(ws, ctx.params.uid);
    if (!m) throw notFound('member not found');
    if (m.role === 'admin' && ws.members.filter(x => x.role === 'admin').length === 1) throw bad('cannot remove the last admin');
    ws.members = ws.members.filter(x => x !== m);
    for (const p of db.projects) if (p.workspaceId === ws.id) p.members = p.members.filter(x => x.userId !== m.userId);
    audit(ws.id, ctx.user, 'member.removed', { userId: m.userId });
    return [204];
  });
  route('GET', '/api/workspaces/:id/audit', (ctx) => {
    const ws = getWs(ctx, ctx.params.id, true);
    return [200, db.audit.filter(a => a.workspaceId === ws.id).slice().reverse()];
  });

  // --- projects
  route('POST', '/api/workspaces/:id/projects', (ctx) => {
    const ws = getWs(ctx, ctx.params.id);
    if (wsRole(ctx.user, ws) === 'guest') throw forbidden('guests cannot create projects');
    const { name, key } = ctx.body;
    if (!isStr(name) || !name.trim()) throw bad('name required');
    if (!isStr(key) || !/^[A-Z]{2,10}$/.test(key)) throw bad('key must be 2-10 uppercase letters');
    if (db.projects.some(p => p.workspaceId === ws.id && p.key === key)) throw conflict('project key taken');
    const p = {
      id: uid(), workspaceId: ws.id, name: name.trim(), key, createdAt: iso(), nextNumber: 1,
      members: [{ userId: ctx.user.id, role: 'lead' }],
      workflow: { statuses: DEFAULT_STATUSES.map(([name, category]) => ({ name, category })), transitions: [] },
    };
    for (const [a] of DEFAULT_STATUSES) for (const [b] of DEFAULT_STATUSES) if (a !== b) p.workflow.transitions.push([a, b]);
    db.projects.push(p);
    return [201, pubProject(p, ctx.user)];
  });
  route('GET', '/api/workspaces/:id/projects', (ctx) => {
    const ws = getWs(ctx, ctx.params.id);
    return [200, db.projects.filter(p => p.workspaceId === ws.id && projRole(ctx.user, p)).map(p => pubProject(p, ctx.user))];
  });
  route('GET', '/api/projects/:id', (ctx) => [200, pubProject(getProject(ctx, ctx.params.id), ctx.user)]);
  route('GET', '/api/projects/:id/members', (ctx) => [200, pubProject(getProject(ctx, ctx.params.id), ctx.user).members]);
  route('POST', '/api/projects/:id/members', (ctx) => {
    const p = getProject(ctx, ctx.params.id, 'lead');
    const { username, role } = ctx.body;
    if (!isStr(username)) throw bad('username required');
    if (!PROJ_ROLES.includes(role)) throw bad('invalid role');
    const u = db.users.find(x => x.username.toLowerCase() === username.toLowerCase());
    if (!u) throw notFound('user not found');
    if (!wsRole(u, wsById(p.workspaceId))) throw bad('user is not a workspace member');
    if (p.members.some(m => m.userId === u.id)) throw conflict('already a project member');
    p.members.push({ userId: u.id, role });
    audit(p.workspaceId, ctx.user, 'member.added', { projectId: p.id, userId: u.id, role });
    return [201, { userId: u.id, username: u.username, role }];
  });
  route('PATCH', '/api/projects/:id/members/:uid', (ctx) => {
    const p = getProject(ctx, ctx.params.id, 'lead');
    const m = p.members.find(x => x.userId === ctx.params.uid || userById(x.userId)?.username === ctx.params.uid);
    if (!m) throw notFound('member not found');
    if (!PROJ_ROLES.includes(ctx.body.role)) throw bad('invalid role');
    const from = m.role; m.role = ctx.body.role;
    audit(p.workspaceId, ctx.user, 'member.role_changed', { projectId: p.id, userId: m.userId, from, to: m.role });
    return [200, { userId: m.userId, username: userById(m.userId)?.username, role: m.role }];
  });
  route('DELETE', '/api/projects/:id/members/:uid', (ctx) => {
    const p = getProject(ctx, ctx.params.id, 'lead');
    const m = p.members.find(x => x.userId === ctx.params.uid || userById(x.userId)?.username === ctx.params.uid);
    if (!m) throw notFound('member not found');
    p.members = p.members.filter(x => x !== m);
    audit(p.workspaceId, ctx.user, 'member.removed', { projectId: p.id, userId: m.userId });
    return [204];
  });

  // --- workflow
  route('GET', '/api/projects/:id/workflow', (ctx) => [200, getProject(ctx, ctx.params.id).workflow]);
  route('PUT', '/api/projects/:id/workflow', (ctx) => {
    const p = getProject(ctx, ctx.params.id, 'lead');
    const { statuses, transitions, remap } = ctx.body;
    if (!Array.isArray(statuses) || !statuses.length) throw bad('statuses required');
    const names = new Set();
    for (const s of statuses) {
      if (!s || !isStr(s.name) || !s.name.trim()) throw bad('status name required');
      if (!CATS.includes(s.category)) throw bad('invalid category');
      if (names.has(s.name)) throw bad('duplicate status name');
      names.add(s.name);
    }
    if (!Array.isArray(transitions)) throw bad('transitions required');
    for (const t of transitions) if (!Array.isArray(t) || t.length !== 2 || !names.has(t[0]) || !names.has(t[1])) throw bad('transition references unknown status');
    if (remap !== undefined && (typeof remap !== 'object' || remap === null || Array.isArray(remap))) throw bad('invalid remap');
    const rm = remap || {};
    for (const [o, nw] of Object.entries(rm)) if (!names.has(nw)) throw bad(`remap target ${nw} does not exist`);
    const removed = p.workflow.statuses.map(s => s.name).filter(n => !names.has(n));
    const pIssues = db.issues.filter(i => i.projectId === p.id);
    for (const r of removed) if (pIssues.some(i => i.status === r) && !rm[r]) throw bad(`status "${r}" is in use; provide remap`);
    const newWf = { statuses: statuses.map(s => ({ name: s.name, category: s.category })), transitions: transitions.map(t => [t[0], t[1]]) };
    const at = iso();
    const old = p.workflow;
    p.workflow = newWf;
    for (const i of pIssues) {
      if (names.has(i.status) && !removed.includes(i.status)) {
        // category may have changed
        const nowDone = catOf(p, i.status) === 'completed';
        if (nowDone && !i.resolvedAt) i.resolvedAt = at; else if (!nowDone && i.resolvedAt) i.resolvedAt = null;
        continue;
      }
      const to = rm[i.status];
      record(i, 'status', i.status, to, ctx.user, at);
      i.status = to; i.updatedAt = at;
      const nowDone = catOf(p, to) === 'completed';
      if (nowDone && !i.resolvedAt) i.resolvedAt = at; else if (!nowDone) i.resolvedAt = null;
    }
    audit(p.workspaceId, ctx.user, 'workflow.updated', { projectId: p.id, statuses: newWf.statuses.map(s => s.name), previous: old.statuses.map(s => s.name) });
    return [200, p.workflow];
  });

  // --- issues
  route('POST', '/api/projects/:id/issues', (ctx) => {
    const p = getProject(ctx, ctx.params.id, 'developer');
    return [201, pubIssue(createIssue(p, ctx.body, ctx.user))];
  });
  route('GET', '/api/projects/:id/issues', (ctx) => {
    const p = getProject(ctx, ctx.params.id);
    const q = ctx.query.get('q') || '';
    return [200, runSearch(ctx, q, [p], ctx.query.get('sort')).map(i => pubIssue(i))];
  });
  route('GET', '/api/issues/:key', (ctx) => [200, pubIssue(getIssue(ctx, ctx.params.key).issue)]);
  route('PATCH', '/api/issues/:key', (ctx) => {
    const { issue, project } = getIssue(ctx, ctx.params.key, 'developer');
    updateIssue(issue, project, ctx.body, ctx.user);
    return [200, pubIssue(issue)];
  });
  route('DELETE', '/api/issues/:key', (ctx) => {
    const { issue } = getIssue(ctx, ctx.params.key, 'developer');
    deleteIssue(issue, ctx.user);
    return [204];
  });
  route('GET', '/api/issues/:key/history', (ctx) => [200, getIssue(ctx, ctx.params.key).issue.history.map(h => ({ ...h }))]);
  route('POST', '/api/issues/:key/links', (ctx) => {
    const { issue, project } = getIssue(ctx, ctx.params.key, 'developer');
    const { type, target } = ctx.body;
    if (!LINK_TYPES.includes(type)) throw bad('invalid link type');
    if (!isStr(target)) throw bad('target required');
    const t = db.issues.find(i => i.key.toUpperCase() === target.toUpperCase() && projRole(ctx.user, projById(i.projectId)));
    if (!t) throw notFound('target issue not found');
    if (t.id === issue.id) throw bad('cannot link an issue to itself');
    const exists = db.issues.some(i => (i.links || []).some(l => (l.from === issue.id && l.to === t.id && l.type === type) || (l.from === t.id && l.to === issue.id && (l.type === type && (type === 'relates')))));
    if (exists) throw conflict('link already exists');
    const l = { id: uid(), type, from: issue.id, to: t.id };
    issue.links.push(l);
    const at = iso(); issue.updatedAt = at; t.updatedAt = at;
    return [201, { id: l.id, type, key: t.key, target: t.key, issue: pubIssue(issue) }];
  });
  route('DELETE', '/api/issues/:key/links/:id', (ctx) => {
    const { issue } = getIssue(ctx, ctx.params.key, 'developer');
    for (const i of db.issues) {
      const l = (i.links || []).find(x => x.id === ctx.params.id && (x.from === issue.id || x.to === issue.id));
      if (l) { i.links = i.links.filter(x => x !== l); return [204]; }
    }
    throw notFound('link not found');
  });

  // --- comments & watchers
  const pubComment = (c) => ({ id: c.id, issueKey: issueById(c.issueId)?.key, authorId: c.authorId, body: c.body, createdAt: c.createdAt, updatedAt: c.updatedAt, edited: c.edited });
  route('POST', '/api/issues/:key/comments', (ctx) => {
    const { issue, project } = getIssue(ctx, ctx.params.key, 'developer');
    const body = ctx.body.body;
    if (!isStr(body) || !body.trim()) throw bad('body required');
    const at = iso();
    const c = { id: uid(), issueId: issue.id, authorId: ctx.user.id, body, createdAt: at, updatedAt: at, edited: false };
    db.comments.push(c);
    const mentioned = [];
    for (const m of body.matchAll(/@([A-Za-z0-9_.-]+)/g)) {
      const u = db.users.find(x => x.username.toLowerCase() === m[1].toLowerCase().replace(/[.-]+$/, '') || x.username.toLowerCase() === m[1].toLowerCase());
      if (u && projRole(u, project) && !mentioned.includes(u.id)) mentioned.push(u.id);
    }
    notify(mentioned, 'mention', issue, ctx.user, { commentId: c.id });
    notify(issue.watchers.filter(w => !mentioned.includes(w)), 'comment', issue, ctx.user, { commentId: c.id });
    emit('comment.created', issue, ctx.user, { comment: pubComment(c) });
    return [201, pubComment(c)];
  });
  route('GET', '/api/issues/:key/comments', (ctx) => {
    const { issue } = getIssue(ctx, ctx.params.key);
    return [200, db.comments.filter(c => c.issueId === issue.id).map(pubComment)];
  });
  route('PATCH', '/api/comments/:id', (ctx) => {
    const c = db.comments.find(x => x.id === ctx.params.id);
    if (!c) throw notFound('comment not found');
    getIssue(ctx, issueById(c.issueId).id);
    if (c.authorId !== ctx.user.id) throw forbidden('only the author can edit');
    if (!isStr(ctx.body.body) || !ctx.body.body.trim()) throw bad('body required');
    c.body = ctx.body.body; c.edited = true; c.updatedAt = iso();
    return [200, pubComment(c)];
  });
  route('DELETE', '/api/comments/:id', (ctx) => {
    const c = db.comments.find(x => x.id === ctx.params.id);
    if (!c) throw notFound('comment not found');
    getIssue(ctx, issueById(c.issueId).id);
    if (c.authorId !== ctx.user.id && ctx.role !== 'lead') throw forbidden('not allowed');
    db.comments = db.comments.filter(x => x !== c);
    return [204];
  });
  route('POST', '/api/issues/:key/watch', (ctx) => {
    const { issue } = getIssue(ctx, ctx.params.key);
    if (!issue.watchers.includes(ctx.user.id)) issue.watchers.push(ctx.user.id);
    return [200, pubIssue(issue)];
  });
  route('DELETE', '/api/issues/:key/watch', (ctx) => {
    const { issue } = getIssue(ctx, ctx.params.key);
    issue.watchers = issue.watchers.filter(w => w !== ctx.user.id);
    return [200, pubIssue(issue)];
  });

  // --- notifications
  const pubNotif = ({ userId, ...n }) => n;
  route('GET', '/api/notifications', (ctx) => {
    let list = db.notifications.filter(n => n.userId === ctx.user.id);
    if (ctx.query.get('unread') === 'true') list = list.filter(n => !n.read);
    return [200, list.slice().reverse().map(pubNotif)];
  });
  route('POST', '/api/notifications/read', (ctx) => {
    const { ids, all } = ctx.body;
    if (all !== true && !Array.isArray(ids)) throw bad('ids or all required');
    let n = 0;
    for (const x of db.notifications) {
      if (x.userId !== ctx.user.id || x.read) continue;
      if (all === true || ids.includes(x.id)) { x.read = true; n++; }
    }
    return [200, { updated: n }];
  });

  // --- sprints
  route('POST', '/api/projects/:id/sprints', (ctx) => {
    const p = getProject(ctx, ctx.params.id, 'developer');
    const { name, startDate, endDate } = ctx.body;
    if (!isStr(name) || !name.trim()) throw bad('name required');
    if (startDate != null && !dateOk(startDate)) throw bad('invalid startDate');
    if (endDate != null && !dateOk(endDate)) throw bad('invalid endDate');
    if (startDate && endDate && endDate < startDate) throw bad('endDate before startDate');
    const s = { id: uid(), projectId: p.id, name: name.trim(), startDate: startDate || null, endDate: endDate || null, state: 'planned', createdAt: iso(), startedAt: null, completedAt: null, scope: [], committedPoints: null, carriedOver: 0 };
    db.sprints.push(s);
    return [201, pubSprint(s)];
  });
  const pubSprint = ({ scope, ...s }) => s;
  route('GET', '/api/projects/:id/sprints', (ctx) => {
    const p = getProject(ctx, ctx.params.id);
    return [200, db.sprints.filter(s => s.projectId === p.id).map(pubSprint)];
  });
  const getSprint = (ctx, min) => {
    const s = sprintById(ctx.params.id);
    if (!s) throw notFound('sprint not found');
    return { s, p: getProject(ctx, s.projectId, min) };
  };
  route('GET', '/api/sprints/:id', (ctx) => [200, pubSprint(getSprint(ctx).s)]);
  route('PATCH', '/api/sprints/:id', (ctx) => {
    const { s } = getSprint(ctx, 'developer');
    const b = ctx.body;
    if (b.name !== undefined) { if (!isStr(b.name) || !b.name.trim()) throw bad('invalid name'); s.name = b.name.trim(); }
    if (b.startDate !== undefined) { if (b.startDate !== null && !dateOk(b.startDate)) throw bad('invalid startDate'); s.startDate = b.startDate; }
    if (b.endDate !== undefined) { if (b.endDate !== null && !dateOk(b.endDate)) throw bad('invalid endDate'); s.endDate = b.endDate; }
    return [200, pubSprint(s)];
  });
  route('POST', '/api/sprints/:id/start', (ctx) => {
    const { s, p } = getSprint(ctx, 'developer');
    if (s.state !== 'planned') throw conflict('sprint is not planned');
    if (db.sprints.some(x => x.projectId === p.id && x.state === 'active')) throw conflict('another sprint is already active');
    s.state = 'active'; s.startedAt = iso();
    if (!s.startDate) s.startDate = s.startedAt.slice(0, 10);
    const members = db.issues.filter(i => i.sprintId === s.id);
    for (const i of members) if (!s.scope.includes(i.id)) s.scope.push(i.id);
    s.committedPoints = members.reduce((a, i) => a + (i.storyPoints || 0), 0);
    return [200, pubSprint(s)];
  });
  route('POST', '/api/sprints/:id/complete', (ctx) => {
    const { s, p } = getSprint(ctx, 'developer');
    if (s.state !== 'active') throw conflict('sprint is not active');
    let target = ctx.body.carryOverTo ?? 'backlog';
    if (target !== 'backlog') {
      const t = db.sprints.find(x => x.id === target && x.projectId === p.id);
      if (!t || t.id === s.id || t.state === 'completed') throw bad('invalid carryOverTo');
    }
    const at = iso(); let carried = 0;
    for (const i of db.issues.filter(x => x.sprintId === s.id && !isDone(p, x))) {
      const to = target === 'backlog' ? null : target;
      record(i, 'sprintId', i.sprintId, to, ctx.user, at);
      i.sprintId = to; i.updatedAt = at; noteSprint(i); carried++;
    }
    s.state = 'completed'; s.completedAt = at; s.carriedOver = carried;
    return [200, pubSprint(s)];
  });
  const valueAt = (issue, field, T, cur) => {
    const h = issue.history.find(e => e.field === field && e.at > T);
    return h ? h.from : cur;
  };
  route('GET', '/api/sprints/:id/report', (ctx) => {
    const { s, p } = getSprint(ctx);
    const members = db.issues.filter(i => i.sprintId === s.id);
    const scope = s.scope.map(issueById).filter(Boolean);
    const committedPoints = s.committedPoints ?? members.reduce((a, i) => a + (i.storyPoints || 0), 0);
    const done = members.filter(i => isDone(p, i));
    const burndown = [];
    if (s.startDate && s.state !== 'planned') {
      const today = now().toISOString().slice(0, 10);
      let end = s.endDate && s.endDate < today ? s.endDate : today;
      if (s.state === 'completed' && s.completedAt) { const c = s.completedAt.slice(0, 10); if (c < end) end = c; }
      for (let d = new Date(s.startDate + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= end; d = new Date(d.getTime() + 86400000)) {
        const ds = d.toISOString().slice(0, 10);
        const T = ds + 'T23:59:59.999Z';
        let rem = 0;
        for (const i of scope) {
          if (i.createdAt > T) continue;
          const st = valueAt(i, 'status', T, i.status);
          if (catOf(p, st) === 'completed') continue;
          rem += valueAt(i, 'storyPoints', T, i.storyPoints) || 0;
        }
        burndown.push({ date: ds, remainingPoints: rem });
        if (burndown.length > 3660) break;
      }
    }
    return [200, { sprintId: s.id, committedPoints, completedPoints: done.reduce((a, i) => a + (i.storyPoints || 0), 0), completedIssues: done.length, carriedOver: s.carriedOver || 0, burndown }];
  });

  // --- stats
  route('GET', '/api/projects/:id/stats', (ctx) => {
    const p = getProject(ctx, ctx.params.id);
    const issues = db.issues.filter(i => i.projectId === p.id);
    const byStatus = {}; for (const s of p.workflow.statuses) byStatus[s.name] = 0;
    const byType = {}; for (const t of TYPES) byType[t] = 0;
    const byAssignee = {};
    const cycles = [];
    for (const i of issues) {
      byStatus[i.status] = (byStatus[i.status] || 0) + 1;
      byType[i.type] = (byType[i.type] || 0) + 1;
      const an = i.assigneeId ? userById(i.assigneeId)?.username : 'unassigned';
      byAssignee[an] = (byAssignee[an] || 0) + 1;
      if (i.resolvedAt) {
        let start = null;
        if (catOf(p, i.history.find(h => h.field === 'status') ? i.history.find(h => h.field === 'status').from : i.status) === 'started') start = i.createdAt;
        if (!start) { const h = i.history.find(e => e.field === 'status' && catOf(p, e.to) === 'started'); if (h) start = h.at; }
        if (start) cycles.push(Math.max(0, (Date.parse(i.resolvedAt) - Date.parse(start)) / 3600000));
      }
    }
    const avg = cycles.length ? cycles.reduce((a, b) => a + b, 0) / cycles.length : null;
    return [200, { total: issues.length, byStatus, byType, byAssignee, avgCycleTimeHours: avg, averageCycleTimeHours: avg, resolvedCount: cycles.length }];
  });

  // --- search
  route('GET', '/api/search', (ctx) => {
    let projects = db.projects.filter(p => projRole(ctx.user, p));
    const pf = ctx.query.get('project');
    if (pf) {
      projects = projects.filter(p => p.id === pf || p.key === pf.toUpperCase());
    }
    const sort = ctx.query.get('sort');
    if (sort && !['updated', 'created', 'priority'].includes(sort)) throw bad('invalid sort');
    return [200, runSearch(ctx, ctx.query.get('q') || '', projects, sort).map(i => pubIssue(i))];
  });

  // --- CSV
  const CSV_HEADER = ['key', 'type', 'title', 'status', 'priority', 'assignee', 'labels', 'storyPoints', 'parent', 'epic', 'sprint', 'dueDate', 'createdAt', 'resolvedAt'];
  route('GET', '/api/projects/:id/export.csv', (ctx) => {
    const p = getProject(ctx, ctx.params.id);
    const rows = [CSV_HEADER];
    for (const i of db.issues.filter(x => x.projectId === p.id)) {
      rows.push([i.key, i.type, i.title, i.status, i.priority, i.assigneeId ? userById(i.assigneeId)?.username : '', i.labels.join(';'), i.storyPoints ?? '', i.parentId ? issueById(i.parentId)?.key : '', i.epicId ? issueById(i.epicId)?.key : '', i.sprintId ? sprintById(i.sprintId)?.name : '', i.dueDate || '', i.createdAt, i.resolvedAt || '']);
    }
    return [200, toCsv(rows), 'text/csv; charset=utf-8'];
  });
  route('POST', '/api/projects/:id/import.csv', (ctx) => {
    const p = getProject(ctx, ctx.params.id, 'developer');
    const text = typeof ctx.body === 'string' ? ctx.body : '';
    let rows;
    try { rows = parseCsv(text); } catch (e) { throw bad('malformed CSV: ' + e.message); }
    if (!rows.length) throw bad('empty CSV');
    const header = rows[0].cells.map(h => h.trim());
    if (!header.includes('title')) throw bad('CSV must have a title column');
    let created = 0; const errors = [];
    for (const r of rows.slice(1)) {
      const o = {}; header.forEach((h, idx) => { o[h] = (r.cells[idx] ?? '').trim(); });
      try {
        if (r.cells.length > header.length && r.cells.slice(header.length).some(c => c !== '')) throw bad('too many columns');
        const body = { title: o.title };
        if (o.type) body.type = o.type.toLowerCase();
        if (o.status) body.status = o.status;
        if (o.priority) body.priority = o.priority.toLowerCase();
        if (o.assignee) { const u = db.users.find(x => x.username.toLowerCase() === o.assignee.toLowerCase()); if (!u) throw bad(`unknown assignee ${o.assignee}`); body.assigneeId = u.id; }
        if (o.labels) body.labels = o.labels.split(';').map(x => x.trim()).filter(Boolean);
        if (o.storyPoints) { const n = Number(o.storyPoints); if (!Number.isFinite(n)) throw bad('invalid storyPoints'); body.storyPoints = n; }
        if (o.parent) { if (!findIssueRef(p, o.parent)) throw bad(`unknown parent ${o.parent}`); body.parentId = o.parent; }
        if (o.epic) { if (!findIssueRef(p, o.epic)) throw bad(`unknown epic ${o.epic}`); body.epicId = o.epic; }
        if (o.sprint) { const s = db.sprints.find(x => x.projectId === p.id && (x.id === o.sprint || x.name === o.sprint)); if (!s) throw bad(`unknown sprint ${o.sprint}`); body.sprintId = s.id; }
        if (o.dueDate) body.dueDate = o.dueDate;
        if (!o.title) throw bad('title is required');
        createIssue(p, body, ctx.user);
        created++;
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        errors.push({ line: r.line, message: e.message });
      }
    }
    return [200, { created, errors }];
  });

  // --- webhooks
  const pubHook = ({ secret, ...w }) => w;
  route('POST', '/api/projects/:id/webhooks', (ctx) => {
    const p = getProject(ctx, ctx.params.id, 'lead');
    const { url, events, secret } = ctx.body;
    let ok = false; try { const u = new URL(url); ok = u.protocol === 'http:' || u.protocol === 'https:'; } catch { /* */ }
    if (!ok) throw bad('valid http(s) url required');
    if (!Array.isArray(events) || !events.length || events.some(e => !EVENTS.includes(e))) throw bad('invalid events');
    if (secret !== undefined && !isStr(secret)) throw bad('invalid secret');
    const w = { id: uid(), projectId: p.id, url, events: [...new Set(events)], secret: secret || '', createdAt: iso() };
    db.webhooks.push(w);
    audit(p.workspaceId, ctx.user, 'webhook.created', { projectId: p.id, webhookId: w.id, url });
    return [201, pubHook(w)];
  });
  route('GET', '/api/projects/:id/webhooks', (ctx) => {
    const p = getProject(ctx, ctx.params.id, 'lead');
    return [200, db.webhooks.filter(w => w.projectId === p.id).map(pubHook)];
  });
  const getHook = (ctx) => {
    const w = db.webhooks.find(x => x.id === ctx.params.id);
    if (!w) throw notFound('webhook not found');
    return { w, p: getProject(ctx, w.projectId, 'lead') };
  };
  route('DELETE', '/api/webhooks/:id', (ctx) => {
    const { w, p } = getHook(ctx);
    db.webhooks = db.webhooks.filter(x => x !== w);
    audit(p.workspaceId, ctx.user, 'webhook.deleted', { projectId: p.id, webhookId: w.id });
    return [204];
  });
  route('GET', '/api/webhooks/:id/deliveries', (ctx) => [200, db.deliveries.filter(d => d.webhookId === getHook(ctx).w.id).map(d => ({ ...d }))]);

  // ---------- HTTP plumbing ----------
  function send(res, status, body, ctype) {
    if (status === 204) { res.writeHead(204); return res.end(); }
    const isJson = ctype === undefined;
    const data = isJson ? JSON.stringify(body) : body;
    res.writeHead(status, { 'content-type': isJson ? 'application/json; charset=utf-8' : ctype, 'content-length': Buffer.byteLength(data) });
    res.end(data);
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      req.on('data', c => { size += c.length; if (size > 10e6) { reject(new HttpError(413, 'too_large', 'body too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }
  function serveStatic(res, rel) {
    const file = path.normalize(path.join(STATIC_DIR, rel));
    if (!file.startsWith(STATIC_DIR + path.sep) && file !== STATIC_DIR) return send(res, 404, { error: 'not_found', message: 'not found' });
    try {
      const data = fs.readFileSync(file);
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch { send(res, 404, { error: 'not_found', message: 'not found' }); }
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveStatic(res, 'index.html');
      if (req.method === 'GET' && p.startsWith('/static/')) return serveStatic(res, decodeURIComponent(p.slice(8)));
      if (!p.startsWith('/api/')) throw notFound();
      let matched = null; let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(p);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== req.method) continue;
        matched = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
        break;
      }
      if (!matched) throw pathMatched ? new HttpError(405, 'method_not_allowed', 'method not allowed') : notFound();
      const ctx = { req, params: matched.params, query: url.searchParams, user: null, body: {} };
      if (!matched.r.public) {
        const h = req.headers.authorization || '';
        const m = /^Bearer\s+(\S+)$/i.exec(h);
        if (!m) throw new HttpError(401, 'unauthorized', 'missing or invalid bearer token');
        const th = sha(m[1]);
        const rec = db.sessions.find(s => s.hash === th) || db.apiTokens.find(t => t.hash === th);
        const user = rec && userById(rec.userId);
        if (!user) throw new HttpError(401, 'unauthorized', 'invalid token');
        ctx.user = user; ctx.tokenHash = th;
      }
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        const raw = await readBody(req);
        if ((req.headers['content-type'] || '').includes('text/csv') || p.endsWith('/import.csv')) ctx.body = raw;
        else if (raw.trim()) {
          try { ctx.body = JSON.parse(raw); } catch { throw bad('invalid JSON'); }
          if (typeof ctx.body !== 'object' || ctx.body === null || Array.isArray(ctx.body)) throw bad('body must be a JSON object');
        }
      }
      const [status, body, ctype] = matched.r.handler(ctx);
      if (req.method !== 'GET') save();
      send(res, status, body, ctype);
    } catch (e) {
      if (e instanceof HttpError) send(res, e.status, { error: e.error, message: e.message });
      else { console.error(e); send(res, 500, { error: 'internal_error', message: 'internal error' }); }
    }
  });
  return server;
}
