import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseQuery, matches } from './search.js';
import { formatCsv, parseCsv } from './csv.js';

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');
const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIOS = ['urgent', 'high', 'medium', 'low', 'none'];
const CATS = ['backlog', 'unstarted', 'started', 'completed'];
const WS_ROLES = ['admin', 'member', 'guest'];
const PROJ_ROLES = ['lead', 'developer', 'viewer'];
const RANK = { viewer: 1, developer: 2, lead: 3 };
const EVENTS = ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'];
const LINK_TYPES = ['blocks', 'relates', 'duplicates'];
const INVERSE = { blocks: 'blocked_by', duplicates: 'duplicated_by', relates: 'relates' };
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

class HttpError extends Error {
  constructor(status, error, message) { super(message); this.status = status; this.error = error; }
}
const bad = (m) => new HttpError(400, 'validation_error', m);
const forbidden = (m = 'forbidden') => new HttpError(403, 'forbidden', m);
const notFound = (m = 'not found') => new HttpError(404, 'not_found', m);
const conflict = (m, code = 'conflict') => new HttpError(409, code, m);

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const uid = () => crypto.randomUUID();
const isStr = (v) => typeof v === 'string';
const isDate = (s) => isStr(s) && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function checkPassword(pw, stored) {
  const [salt, h] = stored.split(':');
  const a = crypto.scryptSync(pw, salt, 32), b = Buffer.from(h, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function createServer({ dataFile, clock } = {}) {
  const nowDate = () => (clock ? new Date(clock()) : new Date());
  const now = () => nowDate().toISOString();
  const today = () => now().slice(0, 10);

  let db = { users: [], sessions: [], tokens: [], workspaces: [], projects: [], issues: [], links: [], history: [], comments: [], notifications: [], sprints: [], webhooks: [], deliveries: [], audit: [] };
  if (dataFile && fs.existsSync(dataFile)) {
    try { db = { ...db, ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) }; } catch { /* start empty */ }
  }
  const save = () => {
    if (!dataFile) return;
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, dataFile);
  };

  const failures = new Map(); // login rate limit

  // ---------- lookups ----------
  const userById = (id) => db.users.find((u) => u.id === id);
  const userByName = (n) => isStr(n) ? db.users.find((u) => u.username.toLowerCase() === n.toLowerCase()) : undefined;
  const userRef = (ref) => userById(ref) || userByName(ref);
  const pubUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName, createdAt: u.createdAt });
  const wsOf = (project) => db.workspaces.find((w) => w.id === project.workspaceId);
  const wsMember = (ws, userId) => ws.members.find((m) => m.userId === userId);
  function projRole(userId, project) {
    const ws = wsOf(project);
    const wm = ws && wsMember(ws, userId);
    if (!wm) return null;
    if (wm.role === 'admin') return 'lead';
    const pm = project.members.find((m) => m.userId === userId);
    if (pm) return pm.role;
    return wm.role === 'member' ? 'developer' : null;
  }
  const projectById = (id) => db.projects.find((p) => p.id === id);
  const catOf = (project, status) => (project.workflow.statuses.find((s) => s.name === status) || {}).category;
  const issueCat = (i) => catOf(projectById(i.projectId), i.status);

  function needProject(ctx, id, min = 'viewer') {
    const project = projectById(id);
    if (!project) throw notFound('project not found');
    const role = projRole(ctx.user.id, project);
    if (!role) throw notFound('project not found');
    if (RANK[role] < RANK[min]) throw forbidden('insufficient project role');
    return { project, role, ws: wsOf(project) };
  }
  function needIssue(ctx, key, min = 'viewer') {
    const cands = db.issues.filter((i) => i.key === key || i.id === key);
    for (const issue of cands) {
      const project = projectById(issue.projectId);
      const role = projRole(ctx.user.id, project);
      if (!role) continue;
      if (RANK[role] < RANK[min]) throw forbidden('insufficient project role');
      return { issue, project, role };
    }
    throw notFound('issue not found');
  }
  function needWs(ctx, id, adminOnly = false) {
    const ws = db.workspaces.find((w) => w.id === id);
    if (!ws) throw notFound('workspace not found');
    const m = wsMember(ws, ctx.user.id);
    if (!m) throw forbidden('not a workspace member');
    if (adminOnly && m.role !== 'admin') throw forbidden('admin only');
    return { ws, role: m.role };
  }
  const issueByRef = (project, ref) => isStr(ref) ? db.issues.find((i) => i.projectId === project.id && (i.id === ref || i.key === ref)) : undefined;

  // ---------- serialization ----------
  function serWs(ws) {
    return { id: ws.id, name: ws.name, key: ws.key, createdAt: ws.createdAt, members: ws.members.map((m) => ({ userId: m.userId, username: userById(m.userId)?.username, role: m.role })) };
  }
  const serProject = (p) => ({ id: p.id, workspaceId: p.workspaceId, name: p.name, key: p.key, createdAt: p.createdAt, workflow: p.workflow, members: p.members.map((m) => ({ userId: m.userId, username: userById(m.userId)?.username, role: m.role })) });
  function serIssue(i, full = true) {
    const o = { id: i.id, key: i.key, projectId: i.projectId, type: i.type, title: i.title, description: i.description, status: i.status, priority: i.priority, assigneeId: i.assigneeId, reporterId: i.reporterId, labels: i.labels, storyPoints: i.storyPoints, parentId: i.parentId, epicId: i.epicId, sprintId: i.sprintId, dueDate: i.dueDate, watchers: i.watchers, createdAt: i.createdAt, updatedAt: i.updatedAt, resolvedAt: i.resolvedAt };
    if (!full) return o;
    const project = projectById(i.projectId);
    o.children = db.issues.filter((c) => c.parentId === i.id).map((c) => c.key);
    o.links = [];
    for (const l of db.links) {
      if (l.sourceId === i.id) { const t = db.issues.find((x) => x.id === l.targetId); if (t) o.links.push({ id: l.id, type: l.type, target: t.key, key: t.key }); }
      else if (l.targetId === i.id) { const s = db.issues.find((x) => x.id === l.sourceId); if (s) o.links.push({ id: l.id, type: INVERSE[l.type], target: s.key, key: s.key }); }
    }
    if (i.type === 'epic') {
      const kids = db.issues.filter((c) => c.epicId === i.id);
      const done = kids.filter((c) => catOf(project, c.status) === 'completed');
      const sum = (a) => a.reduce((s, c) => s + (c.storyPoints || 0), 0);
      o.progress = { total: kids.length, done: done.length, points_total: sum(kids), points_done: sum(done) };
    }
    return o;
  }

  // ---------- audit / notifications / webhooks ----------
  function audit(wsId, type, actorId, details = {}) {
    db.audit.push({ id: uid(), workspaceId: wsId, type, action: type, actorId, at: now(), details });
  }
  function notify(issue, type, actorId, recipients, extra = {}) {
    const seen = new Set();
    for (const r of recipients) {
      if (!r || r === actorId || seen.has(r)) continue;
      seen.add(r);
      db.notifications.push({ id: uid(), userId: r, type, issueKey: issue.key, actorId, at: now(), read: false, ...extra });
    }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function fire(project, event, issue, actorId, extra = {}) {
    for (const wh of db.webhooks) {
      if (wh.projectId !== project.id || !wh.events.includes(event)) continue;
      const body = JSON.stringify({ event, issue: serIssue(issue, false), actorId, at: now(), ...extra });
      const d = { id: uid(), webhookId: wh.id, event, status: 'pending', attempts: 0, lastError: null, createdAt: now() };
      db.deliveries.push(d);
      deliver(wh, d, body).catch(() => {});
    }
  }
  async function deliver(wh, d, body) {
    const sig = 'sha256=' + crypto.createHmac('sha256', wh.secret).update(body).digest('hex');
    for (let a = 1; a <= 3; a++) {
      d.attempts = a;
      try {
        const res = await fetch(wh.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pm-signature': sig, 'x-pm-event': d.event }, body, signal: AbortSignal.timeout(5000) });
        if (res.ok) { d.status = 'delivered'; d.lastError = null; save(); return; }
        d.lastError = `HTTP ${res.status}`;
      } catch (e) { d.lastError = String(e.message || e); }
      d.status = a < 3 ? 'retrying' : 'failed';
      save();
      if (a < 3) await sleep(50 * a);
    }
  }

  // ---------- issue logic ----------
  function record(issue, field, from, to, actorId) {
    db.history.push({ issueId: issue.id, field, from, to, actorId, at: now() });
  }
  function initialStatus(project) {
    const s = project.workflow.statuses;
    return (s.find((x) => x.category === 'unstarted') || s[0]).name;
  }
  function ensureWatcher(issue, userId) { if (userId && !issue.watchers.includes(userId)) issue.watchers.push(userId); }

  function resolveUser(project, ref) {
    const u = userRef(ref);
    if (!u || !projRole(u.id, project)) throw bad('assignee must be a user with access to the project');
    return u.id;
  }
  // Validate input fields into normalized `out`; cross-check merged state.
  function normalize(project, current, input) {
    const out = {};
    if ('type' in input) { if (!TYPES.includes(input.type)) throw bad('invalid type'); out.type = input.type; }
    if ('title' in input) { if (!isStr(input.title) || !input.title.trim()) throw bad('title is required'); if (input.title.length > 300) throw bad('title too long'); out.title = input.title.trim(); }
    if ('description' in input) { if (input.description !== null && !isStr(input.description)) throw bad('invalid description'); out.description = input.description ?? ''; }
    if ('priority' in input) { if (!PRIOS.includes(input.priority)) throw bad('invalid priority'); out.priority = input.priority; }
    if ('assigneeId' in input) out.assigneeId = input.assigneeId === null || input.assigneeId === '' ? null : resolveUser(project, input.assigneeId);
    if ('labels' in input) { if (!Array.isArray(input.labels) || input.labels.some((l) => !isStr(l) || !l.trim())) throw bad('invalid labels'); out.labels = [...new Set(input.labels.map((l) => l.trim()))]; }
    if ('storyPoints' in input) { const p = input.storyPoints; if (p !== null && !(typeof p === 'number' && Number.isFinite(p) && p >= 0)) throw bad('invalid storyPoints'); out.storyPoints = p; }
    if ('dueDate' in input) { if (input.dueDate !== null && !isDate(input.dueDate)) throw bad('invalid dueDate'); out.dueDate = input.dueDate; }
    for (const f of ['parentId', 'epicId']) {
      if (f in input) {
        if (input[f] === null || input[f] === '') out[f] = null;
        else { const t = issueByRef(project, input[f]); if (!t) throw bad(`${f} not found in project`); out[f] = t.id; }
      }
    }
    if ('sprintId' in input) {
      if (input.sprintId === null || input.sprintId === '') out.sprintId = null;
      else {
        const sp = db.sprints.find((s) => s.id === input.sprintId && s.projectId === project.id);
        if (!sp) throw bad('sprint not found in project');
        if (sp.state === 'completed') throw bad('sprint is completed');
        out.sprintId = sp.id;
      }
    }
    const m = { ...current, ...out };
    if (m.type === 'subtask') {
      const p = m.parentId && db.issues.find((i) => i.id === m.parentId);
      if (!p || p.projectId !== project.id || p.type === 'subtask') throw bad('subtask requires a non-subtask parent in the same project');
    } else if (m.parentId) throw bad('only subtasks can have a parent');
    if (m.epicId) {
      const e = db.issues.find((i) => i.id === m.epicId);
      if (!e || e.type !== 'epic' || e.projectId !== project.id) throw bad('epicId must reference an epic');
      if (m.type === 'epic') throw bad('epics cannot belong to an epic');
    }
    return out;
  }

  function createIssue(project, input, actor, extraStatus) {
    const base = { type: 'task', description: '', priority: 'none', assigneeId: null, labels: [], storyPoints: null, parentId: null, epicId: null, sprintId: null, dueDate: null };
    if (!('title' in input)) throw bad('title is required');
    const out = normalize(project, base, input);
    let status = initialStatus(project);
    if (extraStatus !== undefined && extraStatus !== null && extraStatus !== '') {
      if (!project.workflow.statuses.some((s) => s.name === extraStatus)) throw bad('unknown status');
      status = extraStatus;
    }
    const n = project.nextNumber++;
    const t = now();
    const issue = { id: uid(), key: `${project.key}-${n}`, projectId: project.id, ...base, ...out, status, reporterId: actor.id, watchers: [], createdAt: t, updatedAt: t, resolvedAt: catOf(project, status) === 'completed' ? t : null };
    ensureWatcher(issue, actor.id); ensureWatcher(issue, issue.assigneeId);
    db.issues.push(issue);
    fire(project, 'issue.created', issue, actor.id);
    return issue;
  }

  function isBlocked(issue) {
    return db.links.some((l) => l.type === 'blocks' && l.targetId === issue.id && (() => { const s = db.issues.find((x) => x.id === l.sourceId); return s && issueCat(s) !== 'completed'; })());
  }

  function updateIssue(issue, project, input, actor) {
    const out = normalize(project, issue, input);
    const changes = [];
    for (const [f, v] of Object.entries(out)) if (JSON.stringify(issue[f]) !== JSON.stringify(v)) changes.push([f, v]);
    let statusChange = null;
    if ('status' in input) {
      if (!isStr(input.status) || !project.workflow.statuses.some((s) => s.name === input.status)) throw bad('unknown status');
      if (input.status !== issue.status) {
        if (!project.workflow.transitions.some(([a, b]) => a === issue.status && b === input.status)) throw conflict(`transition ${issue.status} -> ${input.status} not allowed`, 'invalid_transition');
        if (catOf(project, input.status) === 'completed' && isBlocked(issue)) throw conflict('issue is blocked by an unresolved issue', 'blocked');
        statusChange = input.status;
      }
    }
    if (!changes.length && !statusChange) return false;
    const t = now();
    const oldAssignee = issue.assigneeId;
    for (const [f, v] of changes) { record(issue, f, issue[f], v, actor.id); issue[f] = v; }
    if (statusChange) {
      record(issue, 'status', issue.status, statusChange, actor.id);
      issue.status = statusChange;
      issue.resolvedAt = catOf(project, statusChange) === 'completed' ? t : null;
    }
    issue.updatedAt = t;
    if (issue.assigneeId !== oldAssignee) ensureWatcher(issue, issue.assigneeId);
    if (statusChange) notify(issue, 'status_changed', actor.id, issue.watchers, { from: undefined });
    if (issue.assigneeId !== oldAssignee && issue.assigneeId) notify(issue, 'assigned', actor.id, issue.watchers);
    fire(project, 'issue.updated', issue, actor.id);
    return true;
  }

  function deleteIssue(issue, project, actor) {
    const kids = db.issues.filter((c) => c.parentId === issue.id);
    for (const k of kids) deleteIssue(k, project, actor);
    for (const c of db.issues) if (c.epicId === issue.id) c.epicId = null;
    db.issues = db.issues.filter((i) => i.id !== issue.id);
    db.links = db.links.filter((l) => l.sourceId !== issue.id && l.targetId !== issue.id);
    db.comments = db.comments.filter((c) => c.issueId !== issue.id);
    db.history = db.history.filter((h) => h.issueId !== issue.id);
    fire(project, 'issue.deleted', issue, actor.id);
  }

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, public: !!opts.public, raw: !!opts.raw });
  };
  const ok = (body, status = 200) => ({ status, body });

  // --- auth
  route('POST', '/api/auth/register', (ctx) => {
    const { username, password, displayName } = ctx.body;
    if (!isStr(username) || !/^[A-Za-z0-9_.-]{3,32}$/.test(username)) throw bad('username must be 3-32 chars [A-Za-z0-9_.-]');
    if (!isStr(password) || password.length < 8) throw bad('password must be at least 8 characters');
    if (displayName !== undefined && !isStr(displayName)) throw bad('invalid displayName');
    if (userByName(username)) throw conflict('username taken');
    const u = { id: uid(), username, displayName: displayName || username, passwordHash: hashPassword(password), createdAt: now() };
    db.users.push(u);
    return ok(pubUser(u), 201);
  }, { public: true });
  route('POST', '/api/auth/login', (ctx) => {
    const { username, password } = ctx.body;
    if (!isStr(username) || !isStr(password)) throw bad('username and password required');
    const k = ctx.ip + '|' + username.toLowerCase();
    const t = nowDate().getTime();
    const f = (failures.get(k) || []).filter((x) => t - x < 60000);
    if (f.length >= 5) { failures.set(k, f); throw new HttpError(429, 'rate_limited', 'too many failed login attempts'); }
    const u = userByName(username);
    if (!u || !checkPassword(password, u.passwordHash)) {
      f.push(t); failures.set(k, f);
      throw new HttpError(401, 'unauthorized', 'invalid credentials');
    }
    failures.delete(k);
    const token = crypto.randomBytes(32).toString('hex');
    db.sessions.push({ hash: sha(token), userId: u.id, createdAt: now() });
    return ok({ token, user: pubUser(u) });
  }, { public: true });
  route('POST', '/api/auth/logout', (ctx) => {
    if (ctx.sessionHash) db.sessions = db.sessions.filter((s) => s.hash !== ctx.sessionHash);
    return { status: 204, body: null };
  });
  route('GET', '/api/auth/me', (ctx) => ok(pubUser(ctx.user)));
  route('PATCH', '/api/auth/me', (ctx) => {
    const { displayName, password, currentPassword } = ctx.body;
    if (displayName !== undefined) { if (!isStr(displayName) || !displayName.trim()) throw bad('invalid displayName'); }
    if (password !== undefined) {
      if (!isStr(password) || password.length < 8) throw bad('password must be at least 8 characters');
      if (!isStr(currentPassword)) throw bad('currentPassword required');
      if (!checkPassword(currentPassword, ctx.user.passwordHash)) throw forbidden('current password incorrect');
    }
    if (displayName !== undefined) ctx.user.displayName = displayName.trim();
    if (password !== undefined) ctx.user.passwordHash = hashPassword(password);
    return ok(pubUser(ctx.user));
  });

  // --- tokens
  route('POST', '/api/tokens', (ctx) => {
    const { name } = ctx.body;
    if (!isStr(name) || !name.trim()) throw bad('name required');
    const token = 'pm_' + crypto.randomBytes(24).toString('hex');
    const t = { id: uid(), userId: ctx.user.id, name: name.trim(), hash: sha(token), createdAt: now() };
    db.tokens.push(t);
    for (const ws of db.workspaces) if (wsMember(ws, ctx.user.id)) audit(ws.id, 'token.created', ctx.user.id, { tokenId: t.id, name: t.name });
    return ok({ id: t.id, name: t.name, token }, 201);
  });
  route('GET', '/api/tokens', (ctx) => ok(db.tokens.filter((t) => t.userId === ctx.user.id).map((t) => ({ id: t.id, name: t.name, createdAt: t.createdAt }))));
  route('DELETE', '/api/tokens/:id', (ctx) => {
    const t = db.tokens.find((x) => x.id === ctx.params.id && x.userId === ctx.user.id);
    if (!t) throw notFound('token not found');
    db.tokens = db.tokens.filter((x) => x !== t);
    for (const ws of db.workspaces) if (wsMember(ws, ctx.user.id)) audit(ws.id, 'token.deleted', ctx.user.id, { tokenId: t.id, name: t.name });
    return { status: 204, body: null };
  });

  // --- workspaces
  route('POST', '/api/workspaces', (ctx) => {
    const { name, key } = ctx.body;
    if (!isStr(name) || !name.trim()) throw bad('name required');
    if (!isStr(key) || !/^[A-Z]{2,10}$/.test(key)) throw bad('key must be 2-10 uppercase letters');
    if (db.workspaces.some((w) => w.key === key)) throw conflict('workspace key taken');
    const ws = { id: uid(), name: name.trim(), key, createdAt: now(), members: [{ userId: ctx.user.id, role: 'admin' }] };
    db.workspaces.push(ws);
    audit(ws.id, 'workspace.created', ctx.user.id, { key });
    return ok(serWs(ws), 201);
  });
  route('GET', '/api/workspaces', (ctx) => ok(db.workspaces.filter((w) => wsMember(w, ctx.user.id)).map(serWs)));
  route('GET', '/api/workspaces/:id', (ctx) => ok(serWs(needWs(ctx, ctx.params.id).ws)));
  route('POST', '/api/workspaces/:id/members', (ctx) => {
    const { ws } = needWs(ctx, ctx.params.id, true);
    const { username, role } = ctx.body;
    if (!WS_ROLES.includes(role)) throw bad('invalid role');
    if (!isStr(username)) throw bad('username required');
    const u = userByName(username);
    if (!u) throw notFound('user not found');
    if (wsMember(ws, u.id)) throw conflict('already a member');
    ws.members.push({ userId: u.id, role });
    audit(ws.id, 'member.added', ctx.user.id, { userId: u.id, username: u.username, role });
    return ok({ userId: u.id, username: u.username, role }, 201);
  });
  const findMember = (ws, ref) => { const u = userRef(ref); const m = u && wsMember(ws, u.id); if (!m) throw notFound('member not found'); return m; };
  const lastAdmin = (ws, m) => m.role === 'admin' && ws.members.filter((x) => x.role === 'admin').length <= 1;
  route('PATCH', '/api/workspaces/:id/members/:uid', (ctx) => {
    const { ws } = needWs(ctx, ctx.params.id, true);
    const m = findMember(ws, ctx.params.uid);
    const { role } = ctx.body;
    if (!WS_ROLES.includes(role)) throw bad('invalid role');
    if (role !== 'admin' && lastAdmin(ws, m)) throw bad('cannot demote the last admin');
    const from = m.role; m.role = role;
    audit(ws.id, 'member.role_changed', ctx.user.id, { userId: m.userId, from, to: role });
    return ok({ userId: m.userId, username: userById(m.userId)?.username, role });
  });
  route('DELETE', '/api/workspaces/:id/members/:uid', (ctx) => {
    const { ws } = needWs(ctx, ctx.params.id, true);
    const m = findMember(ws, ctx.params.uid);
    if (lastAdmin(ws, m)) throw bad('cannot remove the last admin');
    ws.members = ws.members.filter((x) => x !== m);
    for (const p of db.projects) if (p.workspaceId === ws.id) p.members = p.members.filter((x) => x.userId !== m.userId);
    audit(ws.id, 'member.removed', ctx.user.id, { userId: m.userId });
    return { status: 204, body: null };
  });
  route('GET', '/api/workspaces/:id/audit', (ctx) => {
    const { ws } = needWs(ctx, ctx.params.id, true);
    return ok(db.audit.filter((a) => a.workspaceId === ws.id).slice().reverse());
  });

  // --- projects
  route('POST', '/api/workspaces/:id/projects', (ctx) => {
    const { ws, role } = needWs(ctx, ctx.params.id);
    if (role === 'guest') throw forbidden('guests cannot create projects');
    const { name, key } = ctx.body;
    if (!isStr(name) || !name.trim()) throw bad('name required');
    if (!isStr(key) || !/^[A-Z][A-Z0-9]{1,9}$/.test(key)) throw bad('key must be 2-10 uppercase letters/digits');
    if (db.projects.some((p) => p.workspaceId === ws.id && p.key === key)) throw conflict('project key taken');
    const names = ['Backlog', 'Todo', 'In Progress', 'In Review', 'Done'];
    const cats = ['backlog', 'unstarted', 'started', 'started', 'completed'];
    const p = {
      id: uid(), workspaceId: ws.id, name: name.trim(), key, createdAt: now(), nextNumber: 1,
      members: [{ userId: ctx.user.id, role: 'lead' }],
      workflow: { statuses: names.map((n, i) => ({ name: n, category: cats[i] })), transitions: names.flatMap((a) => names.filter((b) => b !== a).map((b) => [a, b])) },
    };
    db.projects.push(p);
    return ok(serProject(p), 201);
  });
  route('GET', '/api/workspaces/:id/projects', (ctx) => {
    const { ws } = needWs(ctx, ctx.params.id);
    return ok(db.projects.filter((p) => p.workspaceId === ws.id && projRole(ctx.user.id, p)).map(serProject));
  });
  route('GET', '/api/projects/:id', (ctx) => ok(serProject(needProject(ctx, ctx.params.id).project)));
  route('GET', '/api/projects/:id/members', (ctx) => ok(serProject(needProject(ctx, ctx.params.id).project).members));
  route('POST', '/api/projects/:id/members', (ctx) => {
    const { project, ws } = needProject(ctx, ctx.params.id, 'lead');
    const { username, role } = ctx.body;
    if (!PROJ_ROLES.includes(role)) throw bad('invalid role');
    const u = userByName(username);
    if (!u) throw notFound('user not found');
    if (!wsMember(ws, u.id)) throw bad('user is not a workspace member');
    const ex = project.members.find((m) => m.userId === u.id);
    if (ex) throw conflict('already a project member');
    project.members.push({ userId: u.id, role });
    audit(ws.id, 'project.member_added', ctx.user.id, { projectId: project.id, userId: u.id, role });
    return ok({ userId: u.id, username: u.username, role }, 201);
  });
  route('PATCH', '/api/projects/:id/members/:uid', (ctx) => {
    const { project, ws } = needProject(ctx, ctx.params.id, 'lead');
    const u = userRef(ctx.params.uid);
    const m = u && project.members.find((x) => x.userId === u.id);
    if (!m) throw notFound('member not found');
    if (!PROJ_ROLES.includes(ctx.body.role)) throw bad('invalid role');
    const from = m.role; m.role = ctx.body.role;
    audit(ws.id, 'project.member_role_changed', ctx.user.id, { projectId: project.id, userId: u.id, from, to: m.role });
    return ok({ userId: u.id, username: u.username, role: m.role });
  });
  route('DELETE', '/api/projects/:id/members/:uid', (ctx) => {
    const { project, ws } = needProject(ctx, ctx.params.id, 'lead');
    const u = userRef(ctx.params.uid);
    const m = u && project.members.find((x) => x.userId === u.id);
    if (!m) throw notFound('member not found');
    project.members = project.members.filter((x) => x !== m);
    audit(ws.id, 'project.member_removed', ctx.user.id, { projectId: project.id, userId: u.id });
    return { status: 204, body: null };
  });
  route('PUT', '/api/projects/:id/workflow', (ctx) => {
    const { project, ws } = needProject(ctx, ctx.params.id, 'lead');
    const { statuses, transitions, remap = {} } = ctx.body;
    if (!Array.isArray(statuses) || !statuses.length) throw bad('statuses required');
    const names = new Set();
    for (const s of statuses) {
      if (!s || !isStr(s.name) || !s.name.trim()) throw bad('status name required');
      if (!CATS.includes(s.category)) throw bad('invalid category');
      if (names.has(s.name)) throw bad('duplicate status name');
      names.add(s.name);
    }
    if (!Array.isArray(transitions) || transitions.some((t) => !Array.isArray(t) || t.length !== 2 || !names.has(t[0]) || !names.has(t[1]))) throw bad('invalid transitions');
    if (remap === null || typeof remap !== 'object' || Array.isArray(remap)) throw bad('invalid remap');
    const issues = db.issues.filter((i) => i.projectId === project.id);
    const used = new Set(issues.map((i) => i.status));
    for (const old of used) {
      if (names.has(old)) continue;
      if (!isStr(remap[old]) || !names.has(remap[old])) throw bad(`status "${old}" is in use and needs a remap to an existing status`);
    }
    const newCat = (n) => statuses.find((s) => s.name === n).category;
    for (const i of issues) {
      let target = i.status;
      if (!names.has(i.status)) target = remap[i.status];
      if (target !== i.status) { record(i, 'status', i.status, target, ctx.user.id); i.status = target; i.updatedAt = now(); }
      const done = newCat(i.status) === 'completed';
      if (done && !i.resolvedAt) i.resolvedAt = now(); else if (!done) i.resolvedAt = null;
    }
    project.workflow = { statuses: statuses.map((s) => ({ name: s.name, category: s.category })), transitions: transitions.map((t) => [t[0], t[1]]) };
    audit(ws.id, 'workflow.updated', ctx.user.id, { projectId: project.id });
    return ok({ ...serProject(project), statuses: project.workflow.statuses, transitions: project.workflow.transitions });
  });

  // --- issues
  route('POST', '/api/projects/:id/issues', (ctx) => {
    const { project } = needProject(ctx, ctx.params.id, 'developer');
    const issue = createIssue(project, ctx.body, ctx.user, ctx.body.status);
    return ok(serIssue(issue), 201);
  });
  route('GET', '/api/projects/:id/issues', (ctx) => {
    const { project } = needProject(ctx, ctx.params.id);
    return ok(db.issues.filter((i) => i.projectId === project.id).map((i) => serIssue(i)));
  });
  route('GET', '/api/issues/:key', (ctx) => ok(serIssue(needIssue(ctx, ctx.params.key).issue)));
  route('PATCH', '/api/issues/:key', (ctx) => {
    const { issue, project } = needIssue(ctx, ctx.params.key, 'developer');
    updateIssue(issue, project, ctx.body, ctx.user);
    return ok(serIssue(issue));
  });
  route('DELETE', '/api/issues/:key', (ctx) => {
    const { issue, project } = needIssue(ctx, ctx.params.key, 'developer');
    deleteIssue(issue, project, ctx.user);
    return { status: 204, body: null };
  });
  route('GET', '/api/issues/:key/history', (ctx) => {
    const { issue } = needIssue(ctx, ctx.params.key);
    return ok(db.history.filter((h) => h.issueId === issue.id).map(({ field, from, to, actorId, at }) => ({ field, from, to, actorId, at })));
  });
  route('POST', '/api/issues/:key/links', (ctx) => {
    const { issue, project } = needIssue(ctx, ctx.params.key, 'developer');
    const { type, target } = ctx.body;
    if (!LINK_TYPES.includes(type)) throw bad('invalid link type');
    if (!isStr(target)) throw bad('target required');
    const t = db.issues.find((i) => i.key === target || i.id === target);
    if (!t || !projRole(ctx.user.id, projectById(t.projectId))) throw bad('target issue not found');
    if (t.id === issue.id) throw bad('cannot link an issue to itself');
    if (db.links.some((l) => (l.sourceId === issue.id && l.targetId === t.id && l.type === type) || (l.sourceId === t.id && l.targetId === issue.id && l.type === type && type === 'relates'))) throw conflict('link already exists');
    const l = { id: uid(), type, sourceId: issue.id, targetId: t.id };
    db.links.push(l);
    record(issue, 'links', null, `${type} ${t.key}`, ctx.user.id);
    return ok({ id: l.id, type, target: t.key, key: t.key }, 201);
  });
  route('DELETE', '/api/issues/:key/links/:id', (ctx) => {
    const { issue } = needIssue(ctx, ctx.params.key, 'developer');
    const l = db.links.find((x) => x.id === ctx.params.id && (x.sourceId === issue.id || x.targetId === issue.id));
    if (!l) throw notFound('link not found');
    db.links = db.links.filter((x) => x !== l);
    return { status: 204, body: null };
  });

  // --- comments & watchers
  const serComment = (c) => ({ id: c.id, issueId: c.issueId, authorId: c.authorId, body: c.body, createdAt: c.createdAt, updatedAt: c.updatedAt, edited: c.edited });
  function mentionIds(body, project, actorId) {
    const ids = [];
    for (const m of body.matchAll(/(?:^|[^\w@])@([A-Za-z0-9_.-]+)/g)) {
      let name = m[1];
      let u = userByName(name);
      while (!u && /[.-]$/.test(name)) { name = name.slice(0, -1); u = userByName(name); }
      if (u && u.id !== actorId && projRole(u.id, project) && !ids.includes(u.id)) ids.push(u.id);
    }
    return ids;
  }
  route('POST', '/api/issues/:key/comments', (ctx) => {
    const { issue, project } = needIssue(ctx, ctx.params.key, 'developer');
    const { body } = ctx.body;
    if (!isStr(body) || !body.trim()) throw bad('body required');
    const t = now();
    const c = { id: uid(), issueId: issue.id, authorId: ctx.user.id, body, createdAt: t, updatedAt: t, edited: false };
    db.comments.push(c);
    const mentioned = mentionIds(body, project, ctx.user.id);
    notify(issue, 'mentioned', ctx.user.id, mentioned, { commentId: c.id });
    notify(issue, 'comment_created', ctx.user.id, issue.watchers.filter((w) => !mentioned.includes(w)), { commentId: c.id });
    fire(project, 'comment.created', issue, ctx.user.id, { comment: serComment(c) });
    return ok(serComment(c), 201);
  });
  route('GET', '/api/issues/:key/comments', (ctx) => {
    const { issue } = needIssue(ctx, ctx.params.key);
    return ok(db.comments.filter((c) => c.issueId === issue.id).map(serComment));
  });
  const needComment = (ctx) => {
    const c = db.comments.find((x) => x.id === ctx.params.id);
    if (!c) throw notFound('comment not found');
    const issue = db.issues.find((i) => i.id === c.issueId);
    const project = projectById(issue.projectId);
    const role = projRole(ctx.user.id, project);
    if (!role) throw notFound('comment not found');
    return { c, issue, role };
  };
  route('PATCH', '/api/comments/:id', (ctx) => {
    const { c } = needComment(ctx);
    if (c.authorId !== ctx.user.id) throw forbidden('only the author can edit');
    if (!isStr(ctx.body.body) || !ctx.body.body.trim()) throw bad('body required');
    c.body = ctx.body.body; c.edited = true; c.updatedAt = now();
    return ok(serComment(c));
  });
  route('DELETE', '/api/comments/:id', (ctx) => {
    const { c, role } = needComment(ctx);
    if (c.authorId !== ctx.user.id && role !== 'lead') throw forbidden('not allowed');
    db.comments = db.comments.filter((x) => x !== c);
    return { status: 204, body: null };
  });
  route('POST', '/api/issues/:key/watch', (ctx) => {
    const { issue } = needIssue(ctx, ctx.params.key);
    ensureWatcher(issue, ctx.user.id);
    return ok(serIssue(issue));
  });
  route('DELETE', '/api/issues/:key/watch', (ctx) => {
    const { issue } = needIssue(ctx, ctx.params.key);
    issue.watchers = issue.watchers.filter((w) => w !== ctx.user.id);
    return ok(serIssue(issue));
  });
  const serNote = ({ id, type, issueKey, actorId, at, read, commentId }) => ({ id, type, issueKey, actorId, at, read, ...(commentId ? { commentId } : {}) });
  route('GET', '/api/notifications', (ctx) => {
    let list = db.notifications.filter((n) => n.userId === ctx.user.id);
    if (ctx.query.get('unread') === 'true') list = list.filter((n) => !n.read);
    return ok(list.slice().reverse().map(serNote));
  });
  route('POST', '/api/notifications/read', (ctx) => {
    const { ids, all } = ctx.body;
    if (all !== true && !Array.isArray(ids)) throw bad('ids or all:true required');
    let n = 0;
    for (const x of db.notifications) {
      if (x.userId !== ctx.user.id || x.read) continue;
      if (all === true || ids.includes(x.id)) { x.read = true; n++; }
    }
    return ok({ updated: n });
  });

  // --- sprints
  const serSprint = (s) => ({ id: s.id, projectId: s.projectId, name: s.name, state: s.state, startDate: s.startDate, endDate: s.endDate, createdAt: s.createdAt, startedAt: s.startedAt || null, completedAt: s.completedAt || null });
  function needSprint(ctx, min) {
    const s = db.sprints.find((x) => x.id === ctx.params.id);
    if (!s) throw notFound('sprint not found');
    const r = needProject(ctx, s.projectId, min);
    return { sprint: s, ...r };
  }
  route('POST', '/api/projects/:id/sprints', (ctx) => {
    const { project } = needProject(ctx, ctx.params.id, 'developer');
    const { name, startDate = null, endDate = null } = ctx.body;
    if (!isStr(name) || !name.trim()) throw bad('name required');
    if (startDate !== null && !isDate(startDate)) throw bad('invalid startDate');
    if (endDate !== null && !isDate(endDate)) throw bad('invalid endDate');
    if (startDate && endDate && endDate < startDate) throw bad('endDate before startDate');
    const s = { id: uid(), projectId: project.id, name: name.trim(), state: 'planned', startDate, endDate, createdAt: now() };
    db.sprints.push(s);
    return ok(serSprint(s), 201);
  });
  route('GET', '/api/projects/:id/sprints', (ctx) => ok(db.sprints.filter((s) => s.projectId === needProject(ctx, ctx.params.id).project.id).map(serSprint)));
  route('GET', '/api/sprints/:id', (ctx) => ok(serSprint(needSprint(ctx, 'viewer').sprint)));
  route('POST', '/api/sprints/:id/start', (ctx) => {
    const { sprint } = needSprint(ctx, 'developer');
    if (sprint.state !== 'planned') throw conflict('sprint is not planned');
    if (db.sprints.some((s) => s.projectId === sprint.projectId && s.state === 'active')) throw conflict('another sprint is already active');
    sprint.state = 'active'; sprint.startedAt = now();
    if (!sprint.startDate) sprint.startDate = today();
    sprint.committedIds = db.issues.filter((i) => i.sprintId === sprint.id).map((i) => i.id);
    return ok(serSprint(sprint));
  });
  route('POST', '/api/sprints/:id/complete', (ctx) => {
    const { sprint, project } = needSprint(ctx, 'developer');
    if (sprint.state !== 'active') throw conflict('sprint is not active');
    const to = ctx.body.carryOverTo ?? 'backlog';
    let target = null;
    if (to !== 'backlog') {
      target = db.sprints.find((s) => s.id === to && s.projectId === sprint.projectId && s.id !== sprint.id);
      if (!target || target.state === 'completed') throw bad('invalid carryOverTo');
    }
    sprint.carriedOverIds = [];
    for (const i of db.issues) {
      if (i.sprintId !== sprint.id || catOf(project, i.status) === 'completed') continue;
      record(i, 'sprintId', i.sprintId, target ? target.id : null, ctx.user.id);
      i.sprintId = target ? target.id : null; i.updatedAt = now();
      sprint.carriedOverIds.push(i.id);
    }
    sprint.state = 'completed'; sprint.completedAt = now();
    return ok(serSprint(sprint));
  });
  function statusAt(issue, t) {
    const hs = db.history.filter((h) => h.issueId === issue.id && h.field === 'status');
    let st = hs.length ? hs[0].from : issue.status;
    for (const h of hs) if (h.at <= t) st = h.to;
    return st;
  }
  route('GET', '/api/sprints/:id/report', (ctx) => {
    const { sprint, project } = needSprint(ctx, 'viewer');
    const pts = (i) => i.storyPoints || 0;
    const members = db.issues.filter((i) => i.sprintId === sprint.id);
    const committedIds = sprint.committedIds || members.map((i) => i.id);
    const committed = db.issues.filter((i) => committedIds.includes(i.id));
    const done = members.filter((i) => catOf(project, i.status) === 'completed');
    const burndown = [];
    if (sprint.startDate) {
      const end = sprint.endDate && sprint.endDate < today() ? sprint.endDate : today();
      const scopeIds = new Set([...committedIds, ...members.map((i) => i.id)]);
      const scope = db.issues.filter((i) => scopeIds.has(i.id));
      for (let d = new Date(sprint.startDate + 'T00:00:00.000Z'); d.toISOString().slice(0, 10) <= end; d = new Date(d.getTime() + 86400000)) {
        const day = d.toISOString().slice(0, 10);
        const eod = day + 'T23:59:59.999Z';
        let remaining = 0;
        for (const i of scope) {
          if (!committedIds.includes(i.id)) {
            const added = db.history.find((h) => h.issueId === i.id && h.field === 'sprintId' && h.to === sprint.id);
            if (added && added.at > eod) continue;
          }
          if (catOf(project, statusAt(i, eod)) !== 'completed') remaining += pts(i);
        }
        burndown.push({ date: day, remainingPoints: remaining });
      }
    }
    return ok({ committedPoints: committed.reduce((s, i) => s + pts(i), 0), completedPoints: done.reduce((s, i) => s + pts(i), 0), completedIssues: done.length, carriedOver: (sprint.carriedOverIds || []).length, burndown });
  });
  route('GET', '/api/projects/:id/stats', (ctx) => {
    const { project } = needProject(ctx, ctx.params.id);
    const issues = db.issues.filter((i) => i.projectId === project.id);
    const byStatus = Object.fromEntries(project.workflow.statuses.map((s) => [s.name, 0]));
    const byType = Object.fromEntries(TYPES.map((t) => [t, 0]));
    const byAssignee = {};
    const cycles = [];
    for (const i of issues) {
      byStatus[i.status] = (byStatus[i.status] || 0) + 1;
      byType[i.type]++;
      const a = i.assigneeId ? userById(i.assigneeId)?.username : 'unassigned';
      byAssignee[a] = (byAssignee[a] || 0) + 1;
      if (i.resolvedAt) {
        const hs = db.history.filter((h) => h.issueId === i.id && h.field === 'status');
        let start = null;
        if (catOf(project, hs.length ? hs[0].from : i.status) === 'started') start = i.createdAt;
        else { const h = hs.find((x) => catOf(project, x.to) === 'started'); if (h) start = h.at; }
        if (start) cycles.push((Date.parse(i.resolvedAt) - Date.parse(start)) / 3600000);
      }
    }
    const avg = cycles.length ? cycles.reduce((a, b) => a + b, 0) / cycles.length : null;
    return ok({ total: issues.length, byStatus, byType, byAssignee, avgCycleTimeHours: avg, by_status: byStatus, by_type: byType, by_assignee: byAssignee, avg_cycle_time_hours: avg });
  });

  // --- search
  const PRI_RANK = Object.fromEntries(PRIOS.map((p, i) => [p, PRIOS.length - i]));
  route('GET', '/api/search', (ctx) => {
    const q = ctx.query.get('q') || '';
    const sort = ctx.query.get('sort') || 'updated';
    if (!['updated', 'created', 'priority'].includes(sort)) throw bad('invalid sort');
    let terms;
    try { terms = parseQuery(q); } catch (e) { if (e.malformed) throw bad('malformed query: ' + e.message); throw e; }
    let pf = ctx.query.get('project');
    let pid = null;
    if (pf) {
      const cands = db.projects.filter((p) => (p.id === pf || p.key === pf) && projRole(ctx.user.id, p));
      if (!cands.length) throw notFound('project not found');
      pid = new Set(cands.map((p) => p.id));
    }
    const sctx = { userId: ctx.user.id, usernameOf: (id) => userById(id)?.username, sprintOf: (id) => db.sprints.find((s) => s.id === id), categoryOf: issueCat };
    const roleCache = new Map();
    const visible = (i) => { if (!roleCache.has(i.projectId)) roleCache.set(i.projectId, !!projRole(ctx.user.id, projectById(i.projectId))); return roleCache.get(i.projectId); };
    const list = db.issues.map((i, idx) => ({ i, idx })).filter(({ i }) => (!pid || pid.has(i.projectId)) && visible(i) && matches(i, terms, sctx));
    const byUpd = (a, b) => (a.i.updatedAt < b.i.updatedAt ? 1 : a.i.updatedAt > b.i.updatedAt ? -1 : b.idx - a.idx);
    if (sort === 'updated') list.sort(byUpd);
    else if (sort === 'created') list.sort((a, b) => (a.i.createdAt < b.i.createdAt ? 1 : a.i.createdAt > b.i.createdAt ? -1 : b.idx - a.idx));
    else list.sort((a, b) => PRI_RANK[b.i.priority] - PRI_RANK[a.i.priority] || byUpd(a, b));
    return ok(list.map(({ i }) => serIssue(i)));
  });

  // --- CSV
  const HEADER = ['key', 'type', 'title', 'status', 'priority', 'assignee', 'labels', 'storyPoints', 'parent', 'epic', 'sprint', 'dueDate', 'createdAt', 'resolvedAt'];
  route('GET', '/api/projects/:id/export.csv', (ctx) => {
    const { project } = needProject(ctx, ctx.params.id);
    const keyOf = (id) => db.issues.find((i) => i.id === id)?.key || '';
    const rows = [HEADER];
    for (const i of db.issues.filter((x) => x.projectId === project.id)) {
      rows.push([i.key, i.type, i.title, i.status, i.priority, i.assigneeId ? userById(i.assigneeId)?.username : '', i.labels.join(';'), i.storyPoints ?? '', i.parentId ? keyOf(i.parentId) : '', i.epicId ? keyOf(i.epicId) : '', i.sprintId ? db.sprints.find((s) => s.id === i.sprintId)?.name || '' : '', i.dueDate || '', i.createdAt, i.resolvedAt || '']);
    }
    return { status: 200, text: formatCsv(rows), type: 'text/csv; charset=utf-8' };
  });
  route('POST', '/api/projects/:id/import.csv', (ctx) => {
    const { project } = needProject(ctx, ctx.params.id, 'developer');
    let recs;
    try { recs = parseCsv(ctx.rawBody); } catch (e) { throw bad('invalid CSV: ' + e.message); }
    if (!recs.length) throw bad('empty CSV');
    const header = recs[0].fields.map((h) => h.trim());
    if (!header.includes('title')) throw bad('CSV must have a title column');
    let created = 0;
    const errors = [];
    for (const { line, fields } of recs.slice(1)) {
      const row = {};
      header.forEach((h, idx) => { row[h] = (fields[idx] ?? '').trim(); });
      try {
        const input = { title: row.title };
        if (row.type) input.type = row.type;
        if (row.priority) input.priority = row.priority;
        if (row.assignee) input.assigneeId = row.assignee;
        if (row.labels) input.labels = row.labels.split(';').map((s) => s.trim()).filter(Boolean);
        if (row.storyPoints) { const n = Number(row.storyPoints); if (!Number.isFinite(n)) throw bad('invalid storyPoints'); input.storyPoints = n; }
        if (row.parent) { if (!issueByRef(project, row.parent)) throw bad(`parent ${row.parent} not found`); input.parentId = row.parent; }
        if (row.epic) { if (!issueByRef(project, row.epic)) throw bad(`epic ${row.epic} not found`); input.epicId = row.epic; }
        if (row.sprint) { const sp = db.sprints.find((s) => s.projectId === project.id && (s.name === row.sprint || s.id === row.sprint)); if (!sp) throw bad(`sprint ${row.sprint} not found`); input.sprintId = sp.id; }
        if (row.dueDate) input.dueDate = row.dueDate;
        createIssue(project, input, ctx.user, row.status);
        created++;
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        errors.push({ line, message: e.message });
      }
    }
    return ok({ created, errors });
  }, { raw: true });

  // --- webhooks
  const serHook = (w) => ({ id: w.id, projectId: w.projectId, url: w.url, events: w.events, createdAt: w.createdAt });
  route('POST', '/api/projects/:id/webhooks', (ctx) => {
    const { project, ws } = needProject(ctx, ctx.params.id, 'lead');
    const { url, events, secret } = ctx.body;
    let u; try { u = new URL(url); } catch { throw bad('invalid url'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw bad('url must be http(s)');
    if (!Array.isArray(events) || !events.length || events.some((e) => !EVENTS.includes(e))) throw bad('invalid events');
    if (!isStr(secret) || !secret) throw bad('secret required');
    const w = { id: uid(), projectId: project.id, url, events: [...new Set(events)], secret, createdAt: now() };
    db.webhooks.push(w);
    audit(ws.id, 'webhook.created', ctx.user.id, { webhookId: w.id, projectId: project.id, url });
    return ok(serHook(w), 201);
  });
  route('GET', '/api/projects/:id/webhooks', (ctx) => ok(db.webhooks.filter((w) => w.projectId === needProject(ctx, ctx.params.id, 'lead').project.id).map(serHook)));
  const needHook = (ctx) => { const w = db.webhooks.find((x) => x.id === ctx.params.id); if (!w) throw notFound('webhook not found'); return { w, ...needProject(ctx, w.projectId, 'lead') }; };
  route('DELETE', '/api/webhooks/:id', (ctx) => {
    const { w, ws } = needHook(ctx);
    db.webhooks = db.webhooks.filter((x) => x !== w);
    audit(ws.id, 'webhook.deleted', ctx.user.id, { webhookId: w.id, projectId: w.projectId });
    return { status: 204, body: null };
  });
  route('GET', '/api/webhooks/:id/deliveries', (ctx) => {
    const { w } = needHook(ctx);
    return ok(db.deliveries.filter((d) => d.webhookId === w.id).map((d) => ({ id: d.id, event: d.event, status: d.status, attempts: d.attempts, lastError: d.lastError, createdAt: d.createdAt })));
  });

  // ---------- HTTP plumbing ----------
  function sendJson(res, status, body) {
    if (body === null || status === 204) { res.writeHead(status); return res.end(); }
    const s = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) });
    res.end(s);
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      req.on('data', (c) => { size += c.length; if (size > 5e6) { reject(bad('body too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }
  function serveStatic(res, rel) {
    const file = path.normalize(path.join(STATIC_DIR, rel));
    if (!file.startsWith(STATIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return sendJson(res, 404, { error: 'not_found', message: 'not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveStatic(res, 'index.html');
      if (req.method === 'GET' && p.startsWith('/static/')) return serveStatic(res, decodeURIComponent(p.slice(8)));
      if (!p.startsWith('/api/')) throw notFound('not found');
      let matched = null, params = {};
      let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(p);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== req.method) continue;
        matched = r; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        break;
      }
      if (!matched) throw pathMatched ? new HttpError(405, 'method_not_allowed', 'method not allowed') : notFound('not found');
      const ctx = { req, params, query: url.searchParams, ip: req.socket.remoteAddress || '', body: {}, rawBody: '' };
      if (!matched.public) {
        const m = /^Bearer (.+)$/i.exec(req.headers.authorization || '');
        if (!m) throw new HttpError(401, 'unauthorized', 'authentication required');
        const h = sha(m[1].trim());
        const s = db.sessions.find((x) => x.hash === h);
        const t = !s && db.tokens.find((x) => x.hash === h);
        const u = userById((s || t || {}).userId);
        if (!u) throw new HttpError(401, 'unauthorized', 'invalid token');
        ctx.user = u; ctx.sessionHash = s ? h : null;
      }
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        const raw = await readBody(req);
        if (matched.raw) ctx.rawBody = raw;
        else if (raw.trim()) {
          try { ctx.body = JSON.parse(raw); } catch { throw bad('invalid JSON body'); }
          if (ctx.body === null || typeof ctx.body !== 'object' || Array.isArray(ctx.body)) throw bad('JSON body must be an object');
        }
      }
      const r = matched.handler(ctx);
      if (req.method !== 'GET') save();
      if (r.text !== undefined) { res.writeHead(r.status, { 'content-type': r.type }); return res.end(r.text); }
      sendJson(res, r.status, r.body);
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.error, message: e.message });
      console.error(e);
      sendJson(res, 500, { error: 'internal_error', message: 'internal error' });
    }
  });
  return server;
}
