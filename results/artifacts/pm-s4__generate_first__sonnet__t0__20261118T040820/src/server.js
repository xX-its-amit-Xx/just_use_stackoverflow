import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { parseSearch, matchIssue } from './search.js';
import { toCsv, parseCsv } from './csv.js';

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');
const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIOS = ['urgent', 'high', 'medium', 'low', 'none'];
const CATS = ['backlog', 'unstarted', 'started', 'completed'];
const WS_ROLES = ['admin', 'member', 'guest'];
const PROJ_ROLES = ['lead', 'developer', 'viewer'];
const LEVEL = { viewer: 1, developer: 2, lead: 3 };
const LINK_INV = { blocks: 'blocked_by', blocked_by: 'blocks', relates: 'relates', duplicates: 'duplicated_by', duplicated_by: 'duplicates' };
const EVENTS = ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'];

class HttpError extends Error { constructor(status, error, message) { super(message); this.status = status; this.error = error; } }
const bad = (m) => new HttpError(400, 'validation_error', m);
const notFound = (m = 'not found') => new HttpError(404, 'not_found', m);
const forbidden = (m = 'forbidden') => new HttpError(403, 'forbidden', m);
const conflict = (m, code = 'conflict') => new HttpError(409, code, m);
const sha = (s) => createHash('sha256').update(s).digest('hex');
const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const isDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d\d:?\d\d)?)?$/.test(v) && !isNaN(Date.parse(v));

function hashPw(pw) { const salt = randomBytes(16).toString('hex'); return salt + ':' + scryptSync(pw, salt, 32).toString('hex'); }
function checkPw(pw, stored) {
  const [salt, h] = stored.split(':'); const a = Buffer.from(h, 'hex'); const b = scryptSync(pw, salt, 32);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createServer({ dataFile, clock } = {}) {
  const now = () => (clock ? clock() : new Date());
  const iso = () => now().toISOString();
  let db = { users: [], workspaces: [], projects: [], issues: [], comments: [], sprints: [], notifications: [], webhooks: [], deliveries: [], tokens: [], audit: [] };
  if (dataFile && fs.existsSync(dataFile)) { try { db = { ...db, ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) }; } catch {} }
  const save = () => {
    if (!dataFile) return;
    const tmp = dataFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, dataFile);
  };
  const failures = new Map();

  const find = (arr, id) => db[arr].find((x) => x.id === id);
  const userById = (id) => find('users', id);
  const userByName = (n) => typeof n === 'string' ? db.users.find((u) => u.username.toLowerCase() === n.toLowerCase()) : undefined;
  const userOut = (u) => ({ id: u.id, username: u.username, displayName: u.displayName });

  // ---------- access ----------
  const wsRole = (user, ws) => ws.members.find((m) => m.userId === user.id)?.role || null;
  function projRole(user, p) {
    const ws = find('workspaces', p.workspaceId); if (!ws) return null;
    const wr = wsRole(user, ws); if (!wr) return null;
    if (wr === 'admin') return 'lead';
    const pm = p.members.find((m) => m.userId === user.id);
    if (pm) return pm.role;
    return wr === 'member' ? 'developer' : null;
  }
  const canSeeProject = (userId, p) => { const u = userById(userId); return !!u && !!projRole(u, p); };
  function getWs(ctx, id, minAdmin) {
    const ws = find('workspaces', id); if (!ws) throw notFound('workspace not found');
    const r = wsRole(ctx.user, ws); if (!r) throw forbidden('not a workspace member');
    if (minAdmin && r !== 'admin') throw forbidden('admin only');
    return ws;
  }
  function getProject(ctx, id, min = 'viewer') {
    const p = find('projects', id); if (!p) throw notFound('project not found');
    const r = projRole(ctx.user, p); if (!r) throw forbidden('no access to project');
    if (LEVEL[r] < LEVEL[min]) throw forbidden('insufficient project role');
    ctx.role = r; return p;
  }
  function getIssue(ctx, key, min = 'viewer') {
    const i = db.issues.find((x) => x.key === key || x.id === key); if (!i) throw notFound('issue not found');
    const p = find('projects', i.projectId); getProject(ctx, p.id, min); ctx.project = p; return i;
  }
  const getSprint = (ctx, id, min = 'viewer') => {
    const s = find('sprints', id); if (!s) throw notFound('sprint not found');
    ctx.project = getProject(ctx, s.projectId, min); return s;
  };

  function audit(wsIds, action, actorId, details) {
    for (const w of [].concat(wsIds)) if (w) db.audit.push({ id: randomUUID(), workspaceId: w, action, actorId, at: iso(), details });
  }

  // ---------- serializers ----------
  const wsOut = (ws, user) => ({ id: ws.id, name: ws.name, key: ws.key, createdAt: ws.createdAt, role: user ? wsRole(user, ws) : undefined,
    members: ws.members.map((m) => ({ userId: m.userId, username: userById(m.userId)?.username, displayName: userById(m.userId)?.displayName, role: m.role })) });
  const projOut = (p, role) => ({ id: p.id, workspaceId: p.workspaceId, name: p.name, key: p.key, workflow: p.workflow, createdAt: p.createdAt, role,
    members: p.members.map((m) => ({ userId: m.userId, username: userById(m.userId)?.username, role: m.role })) });
  const catOf = (p, status) => p.workflow.statuses.find((s) => s.name === status)?.category;
  function issueOut(i) {
    const p = find('projects', i.projectId);
    const o = {}; for (const k of Object.keys(i)) if (k[0] !== '_') o[k] = i[k];
    o.children = db.issues.filter((c) => c.parentId === i.id).map((c) => c.key);
    o.links = i.links.map((l) => ({ id: l.id, type: l.type, key: db.issues.find((x) => x.id === l.target)?.key }));
    if (i.type === 'epic') {
      const kids = db.issues.filter((c) => c.epicId === i.id);
      const done = kids.filter((c) => catOf(p, c.status) === 'completed');
      o.progress = { total: kids.length, done: done.length, points_total: kids.reduce((a, c) => a + (c.storyPoints || 0), 0), points_done: done.reduce((a, c) => a + (c.storyPoints || 0), 0) };
    }
    return o;
  }
  const commentOut = (c) => ({ id: c.id, issueKey: db.issues.find((i) => i.id === c.issueId)?.key, authorId: c.authorId, body: c.body, createdAt: c.createdAt, updatedAt: c.updatedAt, edited: c.edited });

  // ---------- notifications & webhooks ----------
  function notify(userIds, type, issue, actorId) {
    for (const uid of new Set(userIds)) {
      if (uid === actorId) continue;
      db.notifications.push({ id: randomUUID(), userId: uid, type, issueKey: issue.key, actorId, at: iso(), read: false });
    }
  }
  function fire(project, event, issue, actorId, extra = {}) {
    for (const w of db.webhooks.filter((x) => x.projectId === project.id && x.events.includes(event))) {
      const body = JSON.stringify({ event, issue: issue ? issueOut(issue) : null, actorId, at: iso(), ...extra });
      const d = { id: randomUUID(), webhookId: w.id, event, status: null, attempts: 0, lastError: null, at: iso() };
      db.deliveries.push(d);
      deliver(w, d, body);
    }
  }
  async function deliver(w, d, body) {
    const sig = 'sha256=' + createHmac('sha256', w.secret).update(body).digest('hex');
    for (let a = 1; a <= 3; a++) {
      d.attempts = a;
      try {
        const r = await fetch(w.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pm-signature': sig }, body, signal: AbortSignal.timeout(5000) });
        d.status = r.status;
        if (r.ok) { d.lastError = null; break; }
        d.lastError = `HTTP ${r.status}`;
      } catch (e) { d.lastError = String(e.message || e); d.status = null; }
      if (a < 3) await new Promise((r) => setTimeout(r, 50 * a));
    }
    try { save(); } catch {}
  }

  // ---------- issues ----------
  function resolveRef(project, ref) {
    if (typeof ref !== 'string') return null;
    return db.issues.find((x) => x.projectId === project.id && (x.id === ref || x.key === ref)) || null;
  }
  function validateFields(project, b, cur) {
    const out = {}; const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
    if (has('title')) { if (!isStr(b.title) || b.title.length > 500) throw bad('title required'); out.title = b.title.trim(); }
    if (has('description')) { if (b.description != null && typeof b.description !== 'string') throw bad('invalid description'); out.description = b.description ?? ''; }
    if (has('type')) { if (!TYPES.includes(b.type)) throw bad('invalid type'); out.type = b.type; }
    if (has('priority')) { if (!PRIOS.includes(b.priority)) throw bad('invalid priority'); out.priority = b.priority; }
    if (has('labels')) { if (!Array.isArray(b.labels) || b.labels.some((l) => !isStr(l))) throw bad('invalid labels'); out.labels = [...new Set(b.labels.map((l) => l.trim()))]; }
    if (has('storyPoints')) { if (b.storyPoints !== null && (typeof b.storyPoints !== 'number' || !isFinite(b.storyPoints) || b.storyPoints < 0)) throw bad('invalid storyPoints'); out.storyPoints = b.storyPoints; }
    if (has('dueDate')) { if (b.dueDate !== null && !isDate(b.dueDate)) throw bad('invalid dueDate'); out.dueDate = b.dueDate; }
    if (has('assigneeId')) {
      if (b.assigneeId !== null) {
        const u = userById(b.assigneeId); if (!u || !projRole(u, project)) throw bad('invalid assignee');
      }
      out.assigneeId = b.assigneeId;
    }
    const type = out.type ?? cur?.type ?? 'task';
    if (has('parentId') || has('type')) {
      let pid = has('parentId') ? b.parentId : cur?.parentId ?? null;
      if (pid != null) {
        const par = resolveRef(project, pid); if (!par) throw bad('parent not found in project');
        if (par.type === 'subtask') throw bad('parent cannot be a subtask');
        if (cur && par.id === cur.id) throw bad('cannot parent itself');
        pid = par.id;
      }
      if (type === 'epic' && pid) throw bad('epics cannot have parents');
      if (type === 'subtask' && !pid) throw bad('subtask requires parentId');
      if (has('parentId') || type === 'epic') out.parentId = type === 'epic' ? null : pid;
    }
    if (has('epicId')) {
      let eid = b.epicId;
      if (eid != null) { const e = resolveRef(project, eid); if (!e || e.type !== 'epic') throw bad('epicId must reference an epic'); eid = e.id; }
      out.epicId = eid ?? null;
    }
    if (has('sprintId')) {
      if (b.sprintId != null) { const s = find('sprints', b.sprintId); if (!s || s.projectId !== project.id) throw bad('invalid sprint'); if (s.state === 'completed') throw bad('sprint is completed'); }
      out.sprintId = b.sprintId ?? null;
    }
    return out;
  }
  const setResolveState = (project, i, status, at) => {
    const cat = catOf(project, status); const was = !!i.resolvedAt;
    if (cat === 'completed') { if (!was) { i.resolvedAt = at; i._log.push({ at, resolved: true }); } }
    else if (was) { i.resolvedAt = null; i._log.push({ at, resolved: false }); }
    if (cat === 'started' && !i._startedAt) i._startedAt = at;
  };
  function noteSprint(i) { if (i.sprintId) { const s = find('sprints', i.sprintId); if (s && !s.everIssueIds.includes(i.id)) s.everIssueIds.push(i.id); } }
  function createIssue(project, actor, b, status) {
    if (!isStr(b.title)) throw bad('title required');
    const f = validateFields(project, { type: 'task', priority: 'none', ...b, status: undefined }, null);
    const wf = project.workflow.statuses;
    let st = status ?? b.status;
    if (st != null) { if (!wf.some((s) => s.name === st)) throw bad('unknown status'); }
    else st = (wf.find((s) => s.category === 'unstarted') || wf[0]).name;
    const at = iso(); project.nextNumber++;
    const i = { id: randomUUID(), key: `${project.key}-${project.nextNumber - 1}`, projectId: project.id, type: 'task', title: '', description: '', status: st, priority: 'none',
      assigneeId: null, reporterId: actor.id, labels: [], storyPoints: null, parentId: null, epicId: null, sprintId: null, dueDate: null, watchers: [],
      createdAt: at, updatedAt: at, resolvedAt: null, links: [], ...f, _log: [], _startedAt: null, _history: [] };
    setResolveState(project, i, st, at);
    i.watchers = [...new Set([i.reporterId, i.assigneeId].filter(Boolean))];
    db.issues.push(i); noteSprint(i);
    return i;
  }
  function isBlocked(i) {
    return i.links.some((l) => l.type === 'blocked_by' && !db.issues.find((x) => x.id === l.target)?.resolvedAt && db.issues.some((x) => x.id === l.target));
  }
  function deleteIssue(i) {
    for (const c of db.issues.filter((x) => x.parentId === i.id)) deleteIssue(c);
    db.issues = db.issues.filter((x) => x.id !== i.id);
    db.comments = db.comments.filter((c) => c.issueId !== i.id);
    for (const x of db.issues) { x.links = x.links.filter((l) => l.target !== i.id); if (x.epicId === i.id) x.epicId = null; }
  }

  // ---------- routes ----------
  const routes = [];
  const R = (method, pattern, handler, auth = true) => {
    const keys = []; const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, auth });
  };

  // auth
  R('POST', '/api/auth/register', (c) => {
    const { username, password, displayName } = c.body;
    if (typeof username !== 'string' || !/^[A-Za-z0-9_.-]{3,32}$/.test(username)) throw bad('invalid username');
    if (typeof password !== 'string' || password.length < 8) throw bad('password must be at least 8 characters');
    if (displayName != null && typeof displayName !== 'string') throw bad('invalid displayName');
    if (userByName(username)) throw conflict('username taken');
    const u = { id: randomUUID(), username, displayName: displayName || username, pw: hashPw(password), createdAt: iso() };
    db.users.push(u); return [201, { user: userOut(u) }];
  }, false);
  R('POST', '/api/auth/login', (c) => {
    const { username, password } = c.body;
    if (typeof username !== 'string' || typeof password !== 'string') throw bad('username and password required');
    const k = username.toLowerCase(); const t = now().getTime();
    const fl = (failures.get(k) || []).filter((x) => t - x < 15 * 60000); failures.set(k, fl);
    if (fl.length >= 5) throw new HttpError(429, 'rate_limited', 'too many failed attempts');
    const u = userByName(username);
    if (!u || !checkPw(password, u.pw)) { fl.push(t); throw new HttpError(401, 'unauthenticated', 'invalid credentials'); }
    failures.delete(k);
    const token = randomBytes(32).toString('hex');
    db.tokens.push({ id: randomUUID(), userId: u.id, kind: 'session', hash: sha(token), createdAt: iso() });
    return [200, { token, user: userOut(u) }];
  }, false);
  R('POST', '/api/auth/logout', (c) => { db.tokens = db.tokens.filter((t) => t.id !== c.tokenRec.id); return [204]; });
  R('GET', '/api/auth/me', (c) => [200, { user: userOut(c.user) }]);
  R('PATCH', '/api/auth/me', (c) => {
    const { displayName, password, currentPassword } = c.body;
    if (displayName !== undefined && !isStr(displayName)) throw bad('invalid displayName');
    if (password !== undefined) {
      if (typeof password !== 'string' || password.length < 8) throw bad('password must be at least 8 characters');
      if (typeof currentPassword !== 'string') throw bad('currentPassword required');
      if (!checkPw(currentPassword, c.user.pw)) throw forbidden('current password incorrect');
      c.user.pw = hashPw(password);
    }
    if (displayName !== undefined) c.user.displayName = displayName;
    return [200, { user: userOut(c.user) }];
  });
  R('POST', '/api/tokens', (c) => {
    if (!isStr(c.body.name)) throw bad('name required');
    const token = 'pm_' + randomBytes(24).toString('hex');
    const rec = { id: randomUUID(), userId: c.user.id, kind: 'api', name: c.body.name, hash: sha(token), createdAt: iso() };
    db.tokens.push(rec);
    audit(db.workspaces.filter((w) => wsRole(c.user, w)).map((w) => w.id), 'token.created', c.user.id, { tokenId: rec.id, name: rec.name });
    return [201, { id: rec.id, name: rec.name, token }];
  });
  R('GET', '/api/tokens', (c) => [200, db.tokens.filter((t) => t.kind === 'api' && t.userId === c.user.id).map((t) => ({ id: t.id, name: t.name, createdAt: t.createdAt }))]);
  R('DELETE', '/api/tokens/:id', (c) => {
    const t = db.tokens.find((x) => x.id === c.params.id && x.kind === 'api' && x.userId === c.user.id); if (!t) throw notFound('token not found');
    db.tokens = db.tokens.filter((x) => x !== t);
    audit(db.workspaces.filter((w) => wsRole(c.user, w)).map((w) => w.id), 'token.deleted', c.user.id, { tokenId: t.id, name: t.name });
    return [204];
  });

  // workspaces
  R('POST', '/api/workspaces', (c) => {
    const { name, key } = c.body;
    if (!isStr(name)) throw bad('name required');
    if (typeof key !== 'string' || !/^[A-Z]{2,10}$/.test(key)) throw bad('key must be 2-10 uppercase letters');
    if (db.workspaces.some((w) => w.key === key)) throw conflict('workspace key taken');
    const ws = { id: randomUUID(), name: name.trim(), key, createdAt: iso(), members: [{ userId: c.user.id, role: 'admin' }] };
    db.workspaces.push(ws); audit(ws.id, 'workspace.created', c.user.id, { name, key });
    return [201, wsOut(ws, c.user)];
  });
  R('GET', '/api/workspaces', (c) => [200, db.workspaces.filter((w) => wsRole(c.user, w)).map((w) => wsOut(w, c.user))]);
  R('GET', '/api/workspaces/:id', (c) => [200, wsOut(getWs(c, c.params.id), c.user)]);
  const findMember = (ws, ref) => ws.members.find((m) => m.userId === ref || userById(m.userId)?.username.toLowerCase() === String(ref).toLowerCase());
  R('POST', '/api/workspaces/:id/members', (c) => {
    const ws = getWs(c, c.params.id, true); const { username, role } = c.body;
    if (!WS_ROLES.includes(role)) throw bad('invalid role');
    if (typeof username !== 'string') throw bad('username required');
    const u = userByName(username); if (!u) throw notFound('user not found');
    if (wsRole(u, ws)) throw conflict('already a member');
    ws.members.push({ userId: u.id, role }); audit(ws.id, 'member.added', c.user.id, { userId: u.id, role });
    return [201, { userId: u.id, username: u.username, role }];
  });
  R('PATCH', '/api/workspaces/:id/members/:uid', (c) => {
    const ws = getWs(c, c.params.id, true); const m = findMember(ws, c.params.uid); if (!m) throw notFound('member not found');
    if (!WS_ROLES.includes(c.body.role)) throw bad('invalid role');
    if (m.role === 'admin' && c.body.role !== 'admin' && ws.members.filter((x) => x.role === 'admin').length === 1) throw bad('cannot demote the last admin');
    const from = m.role; m.role = c.body.role; audit(ws.id, 'member.role_changed', c.user.id, { userId: m.userId, from, to: m.role });
    return [200, { userId: m.userId, username: userById(m.userId).username, role: m.role }];
  });
  R('DELETE', '/api/workspaces/:id/members/:uid', (c) => {
    const ws = getWs(c, c.params.id, true); const m = findMember(ws, c.params.uid); if (!m) throw notFound('member not found');
    if (m.role === 'admin' && ws.members.filter((x) => x.role === 'admin').length === 1) throw bad('cannot remove the last admin');
    ws.members = ws.members.filter((x) => x !== m);
    for (const p of db.projects.filter((p) => p.workspaceId === ws.id)) p.members = p.members.filter((x) => x.userId !== m.userId);
    audit(ws.id, 'member.removed', c.user.id, { userId: m.userId });
    return [204];
  });
  R('GET', '/api/workspaces/:id/audit', (c) => {
    const ws = getWs(c, c.params.id, true);
    return [200, db.audit.filter((a) => a.workspaceId === ws.id).map(({ workspaceId, ...r }) => r)];
  });

  // projects
  R('POST', '/api/workspaces/:id/projects', (c) => {
    const ws = getWs(c, c.params.id); if (wsRole(c.user, ws) === 'guest') throw forbidden('guests cannot create projects');
    const { name, key } = c.body;
    if (!isStr(name)) throw bad('name required');
    if (typeof key !== 'string' || !/^[A-Z][A-Z0-9]{1,9}$/.test(key)) throw bad('invalid project key');
    if (db.projects.some((p) => p.key === key)) throw conflict('project key taken');
    const names = ['Backlog', 'Todo', 'In Progress', 'In Review', 'Done'];
    const p = { id: randomUUID(), workspaceId: ws.id, name: name.trim(), key, createdAt: iso(), nextNumber: 1, members: [],
      workflow: { statuses: names.map((n, i) => ({ name: n, category: ['backlog', 'unstarted', 'started', 'started', 'completed'][i] })), transitions: [] } };
    for (const a of names) for (const b of names) if (a !== b) p.workflow.transitions.push([a, b]);
    if (wsRole(c.user, ws) !== 'admin') p.members.push({ userId: c.user.id, role: 'lead' });
    db.projects.push(p); return [201, projOut(p, 'lead')];
  });
  R('GET', '/api/workspaces/:id/projects', (c) => {
    const ws = getWs(c, c.params.id);
    return [200, db.projects.filter((p) => p.workspaceId === ws.id && projRole(c.user, p)).map((p) => projOut(p, projRole(c.user, p)))];
  });
  R('GET', '/api/projects/:id', (c) => { const p = getProject(c, c.params.id); return [200, projOut(p, c.role)]; });
  R('GET', '/api/projects/:id/members', (c) => [200, getProject(c, c.params.id).members.map((m) => ({ userId: m.userId, username: userById(m.userId)?.username, role: m.role }))]);
  R('POST', '/api/projects/:id/members', (c) => {
    const p = getProject(c, c.params.id, 'lead'); const { username, role } = c.body;
    if (!PROJ_ROLES.includes(role)) throw bad('invalid role');
    const u = userByName(username); if (!u) throw notFound('user not found');
    const ws = find('workspaces', p.workspaceId); if (!wsRole(u, ws)) throw bad('user is not a workspace member');
    if (p.members.some((m) => m.userId === u.id)) throw conflict('already a project member');
    p.members.push({ userId: u.id, role }); audit(ws.id, 'project_member.added', c.user.id, { projectId: p.id, userId: u.id, role });
    return [201, { userId: u.id, username: u.username, role }];
  });
  R('PATCH', '/api/projects/:id/members/:uid', (c) => {
    const p = getProject(c, c.params.id, 'lead'); const m = p.members.find((x) => x.userId === c.params.uid || userById(x.userId)?.username === c.params.uid);
    if (!m) throw notFound('member not found'); if (!PROJ_ROLES.includes(c.body.role)) throw bad('invalid role');
    const from = m.role; m.role = c.body.role; audit(p.workspaceId, 'project_member.role_changed', c.user.id, { projectId: p.id, userId: m.userId, from, to: m.role });
    return [200, { userId: m.userId, username: userById(m.userId)?.username, role: m.role }];
  });
  R('DELETE', '/api/projects/:id/members/:uid', (c) => {
    const p = getProject(c, c.params.id, 'lead'); const m = p.members.find((x) => x.userId === c.params.uid || userById(x.userId)?.username === c.params.uid);
    if (!m) throw notFound('member not found'); p.members = p.members.filter((x) => x !== m);
    audit(p.workspaceId, 'project_member.removed', c.user.id, { projectId: p.id, userId: m.userId }); return [204];
  });
  R('PUT', '/api/projects/:id/workflow', (c) => {
    const p = getProject(c, c.params.id, 'lead'); const { statuses, transitions, remap = {} } = c.body;
    if (!Array.isArray(statuses) || !statuses.length) throw bad('statuses required');
    const names = new Set();
    for (const s of statuses) {
      if (!s || !isStr(s.name) || !CATS.includes(s.category)) throw bad('invalid status');
      if (names.has(s.name)) throw bad('duplicate status'); names.add(s.name);
    }
    let tr = transitions;
    if (tr === undefined) { tr = []; for (const a of names) for (const b of names) if (a !== b) tr.push([a, b]); }
    if (!Array.isArray(tr) || tr.some((t) => !Array.isArray(t) || t.length !== 2 || !names.has(t[0]) || !names.has(t[1]))) throw bad('invalid transitions');
    if (typeof remap !== 'object' || remap === null || Array.isArray(remap)) throw bad('invalid remap');
    const old = new Set(p.workflow.statuses.map((s) => s.name));
    const inUse = db.issues.filter((i) => i.projectId === p.id && !names.has(i.status));
    for (const i of inUse) { const t = remap[i.status]; if (!t || !names.has(t)) throw bad(`status "${i.status}" is in use and needs a valid remap`); }
    const at = iso();
    p.workflow = { statuses: statuses.map((s) => ({ name: s.name, category: s.category })), transitions: tr.map((t) => [t[0], t[1]]) };
    for (const i of inUse) {
      const to = remap[i.status]; i._history.push({ field: 'status', from: i.status, to, actorId: c.user.id, at });
      i.status = to; i.updatedAt = at; setResolveState(p, i, to, at);
    }
    for (const i of db.issues.filter((x) => x.projectId === p.id)) setResolveState(p, i, i.status, at);
    audit(p.workspaceId, 'workflow.updated', c.user.id, { projectId: p.id });
    for (const i of inUse) fire(p, 'issue.updated', i, c.user.id);
    return [200, projOut(p, 'lead')];
  });

  // issues
  R('POST', '/api/projects/:id/issues', (c) => {
    const p = getProject(c, c.params.id, 'developer');
    const i = createIssue(p, c.user, c.body);
    if (i.assigneeId) notify([i.assigneeId], 'assigned', i, c.user.id);
    fire(p, 'issue.created', i, c.user.id); return [201, issueOut(i)];
  });
  R('GET', '/api/projects/:id/issues', (c) => {
    const p = getProject(c, c.params.id); return [200, db.issues.filter((i) => i.projectId === p.id).map(issueOut)];
  });
  R('GET', '/api/issues/:key', (c) => [200, issueOut(getIssue(c, c.params.key))]);
  R('PATCH', '/api/issues/:key', (c) => {
    const i = getIssue(c, c.params.key, 'developer'); const p = c.project; const b = c.body;
    const f = validateFields(p, b, i);
    let newStatus;
    if (Object.prototype.hasOwnProperty.call(b, 'status') && b.status !== i.status) {
      if (!p.workflow.statuses.some((s) => s.name === b.status)) throw bad('unknown status');
      if (!p.workflow.transitions.some((t) => t[0] === i.status && t[1] === b.status)) throw conflict(`transition ${i.status} -> ${b.status} not allowed`, 'invalid_transition');
      if (catOf(p, b.status) === 'completed' && isBlocked(i)) throw conflict('issue is blocked by an unresolved issue', 'blocked');
      newStatus = b.status;
    } else if (Object.prototype.hasOwnProperty.call(b, 'status') && typeof b.status !== 'string') throw bad('invalid status');
    if (f.type && f.type !== 'subtask' && i.type === 'subtask' && !('parentId' in f)) f.parentId = null;
    const at = iso(); const oldAssignee = i.assigneeId; const changes = [];
    for (const [k, v] of Object.entries(f)) if (JSON.stringify(i[k]) !== JSON.stringify(v)) changes.push([k, i[k], v]);
    if (newStatus) changes.push(['status', i.status, newStatus]);
    if (!changes.length) return [200, issueOut(i)];
    for (const [k, from, to] of changes) { i[k] = to; i._history.push({ field: k, from, to, actorId: c.user.id, at }); }
    if (newStatus) setResolveState(p, i, newStatus, at);
    if (f.sprintId) noteSprint(i);
    if (f.assigneeId && !i.watchers.includes(f.assigneeId)) i.watchers.push(f.assigneeId);
    i.updatedAt = at;
    if (newStatus) notify(i.watchers, 'status_changed', i, c.user.id);
    if (i.assigneeId && i.assigneeId !== oldAssignee) notify(i.watchers, 'assigned', i, c.user.id);
    fire(p, 'issue.updated', i, c.user.id); return [200, issueOut(i)];
  });
  R('DELETE', '/api/issues/:key', (c) => {
    const i = getIssue(c, c.params.key, 'developer'); const out = issueOut(i);
    const subs = db.issues.filter((x) => x.parentId === i.id);
    deleteIssue(i); fire(c.project, 'issue.deleted', out, c.user.id);
    for (const s of subs) fire(c.project, 'issue.deleted', s, c.user.id);
    return [204];
  });
  R('GET', '/api/issues/:key/history', (c) => [200, getIssue(c, c.params.key)._history.map((h) => ({ ...h }))]);
  R('POST', '/api/issues/:key/watch', (c) => { const i = getIssue(c, c.params.key); if (!i.watchers.includes(c.user.id)) i.watchers.push(c.user.id); return [200, issueOut(i)]; });
  R('DELETE', '/api/issues/:key/watch', (c) => { const i = getIssue(c, c.params.key); i.watchers = i.watchers.filter((w) => w !== c.user.id); return [200, issueOut(i)]; });
  R('POST', '/api/issues/:key/links', (c) => {
    const i = getIssue(c, c.params.key, 'developer'); const { type, target } = c.body;
    if (!['blocks', 'relates', 'duplicates'].includes(type)) throw bad('invalid link type');
    const t = db.issues.find((x) => x.key === target || x.id === target); if (!t) throw notFound('target not found');
    getProject(c, t.projectId, 'viewer');
    if (t.id === i.id) throw bad('cannot link an issue to itself');
    if (i.links.some((l) => l.type === type && l.target === t.id)) throw conflict('link exists');
    const l = { id: randomUUID(), type, target: t.id };
    i.links.push(l); t.links.push({ id: l.id, type: LINK_INV[type], target: i.id });
    return [201, issueOut(i)];
  });
  R('DELETE', '/api/issues/:key/links/:lid', (c) => {
    const i = getIssue(c, c.params.key, 'developer'); const l = i.links.find((x) => x.id === c.params.lid); if (!l) throw notFound('link not found');
    i.links = i.links.filter((x) => x !== l); const t = db.issues.find((x) => x.id === l.target); if (t) t.links = t.links.filter((x) => x.id !== l.id);
    return [204];
  });

  // comments
  R('POST', '/api/issues/:key/comments', (c) => {
    const i = getIssue(c, c.params.key, 'developer'); if (!isStr(c.body.body)) throw bad('body required');
    const at = iso(); const cm = { id: randomUUID(), issueId: i.id, authorId: c.user.id, body: c.body.body, createdAt: at, updatedAt: at, edited: false };
    db.comments.push(cm);
    const mentioned = new Set();
    for (const m of c.body.body.matchAll(/@([A-Za-z0-9_.-]+)/g)) {
      const u = userByName(m[1].replace(/[.-]+$/, '')); if (u && canSeeProject(u.id, c.project)) mentioned.add(u.id);
    }
    notify([...mentioned], 'mention', i, c.user.id);
    notify(i.watchers.filter((w) => !mentioned.has(w)), 'comment', i, c.user.id);
    fire(c.project, 'comment.created', i, c.user.id, { comment: commentOut(cm) });
    return [201, commentOut(cm)];
  });
  R('GET', '/api/issues/:key/comments', (c) => { const i = getIssue(c, c.params.key); return [200, db.comments.filter((x) => x.issueId === i.id).map(commentOut)]; });
  const getComment = (c) => {
    const cm = find('comments', c.params.id); if (!cm) throw notFound('comment not found');
    const i = find('issues', cm.issueId); c.project = getProject(c, i.projectId); return cm;
  };
  R('PATCH', '/api/comments/:id', (c) => {
    const cm = getComment(c); if (cm.authorId !== c.user.id) throw forbidden('only the author can edit');
    if (!isStr(c.body.body)) throw bad('body required');
    cm.body = c.body.body; cm.edited = true; cm.updatedAt = iso(); return [200, commentOut(cm)];
  });
  R('DELETE', '/api/comments/:id', (c) => {
    const cm = getComment(c); if (cm.authorId !== c.user.id && c.role !== 'lead') throw forbidden('not allowed');
    db.comments = db.comments.filter((x) => x !== cm); return [204];
  });

  // notifications
  R('GET', '/api/notifications', (c) => {
    let l = db.notifications.filter((n) => n.userId === c.user.id);
    if (c.query.get('unread') === 'true') l = l.filter((n) => !n.read);
    return [200, l.slice().reverse().map(({ userId, ...n }) => n)];
  });
  R('POST', '/api/notifications/read', (c) => {
    const { ids, all } = c.body; let n = 0;
    if (all !== true && !Array.isArray(ids)) throw bad('ids or all required');
    for (const x of db.notifications) if (x.userId === c.user.id && !x.read && (all === true || ids.includes(x.id))) { x.read = true; n++; }
    return [200, { updated: n }];
  });

  // sprints
  const sprintOut = (s) => { const { everIssueIds, carriedOverIds, ...r } = s; return r; };
  R('POST', '/api/projects/:id/sprints', (c) => {
    const p = getProject(c, c.params.id, 'developer'); const { name, startDate, endDate } = c.body;
    if (!isStr(name)) throw bad('name required');
    for (const d of [startDate, endDate]) if (d != null && !isDate(d)) throw bad('invalid date');
    if (startDate && endDate && endDate < startDate) throw bad('endDate before startDate');
    const s = { id: randomUUID(), projectId: p.id, name: name.trim(), state: 'planned', startDate: startDate ?? null, endDate: endDate ?? null, createdAt: iso(), startedAt: null, completedAt: null, everIssueIds: [], carriedOverIds: [] };
    db.sprints.push(s); return [201, sprintOut(s)];
  });
  R('GET', '/api/projects/:id/sprints', (c) => { const p = getProject(c, c.params.id); return [200, db.sprints.filter((s) => s.projectId === p.id).map(sprintOut)]; });
  R('GET', '/api/sprints/:id', (c) => [200, sprintOut(getSprint(c, c.params.id))]);
  R('POST', '/api/sprints/:id/start', (c) => {
    const s = getSprint(c, c.params.id, 'developer');
    if (s.state !== 'planned') throw conflict('sprint is not planned');
    if (db.sprints.some((x) => x.projectId === s.projectId && x.state === 'active')) throw conflict('another sprint is already active');
    s.state = 'active'; s.startedAt = iso(); if (!s.startDate) s.startDate = s.startedAt.slice(0, 10);
    for (const i of db.issues) if (i.sprintId === s.id) noteSprint(i);
    return [200, sprintOut(s)];
  });
  R('POST', '/api/sprints/:id/complete', (c) => {
    const s = getSprint(c, c.params.id, 'developer'); const p = c.project;
    if (s.state !== 'active') throw conflict('sprint is not active');
    const to = c.body.carryOverTo ?? 'backlog'; let target = null;
    if (to !== 'backlog') { target = find('sprints', to); if (!target || target.projectId !== p.id || target.state === 'completed' || target.id === s.id) throw bad('invalid carryOverTo'); }
    const at = iso();
    for (const i of db.issues.filter((x) => x.sprintId === s.id && catOf(p, x.status) !== 'completed')) {
      i._history.push({ field: 'sprintId', from: s.id, to: target ? target.id : null, actorId: c.user.id, at });
      i.sprintId = target ? target.id : null; i.updatedAt = at; s.carriedOverIds.push(i.id); noteSprint(i);
    }
    s.state = 'completed'; s.completedAt = at; return [200, sprintOut(s)];
  });
  R('GET', '/api/sprints/:id/report', (c) => {
    const s = getSprint(c, c.params.id); const p = c.project;
    const issues = s.everIssueIds.map((id) => find('issues', id)).filter(Boolean);
    const end = s.completedAt ? new Date(s.completedAt) : now();
    const resolvedBy = (i, t) => { let r = false; for (const e of i._log) if (new Date(e.at) <= t) r = e.resolved; return r; };
    const pts = (i) => i.storyPoints || 0;
    const done = issues.filter((i) => resolvedBy(i, end) && (i.sprintId === s.id || !s.carriedOverIds.includes(i.id)));
    const burndown = [];
    if (s.startDate) {
      const first = Date.parse(s.startDate.slice(0, 10)); const today = Date.parse(now().toISOString().slice(0, 10));
      let last = today; if (s.endDate) last = Math.min(last, Date.parse(s.endDate.slice(0, 10)));
      for (let d = first, n = 0; d <= last && n < 1000; d += 86400000, n++) {
        const eod = new Date(d + 86400000 - 1);
        burndown.push({ date: new Date(d).toISOString().slice(0, 10), remainingPoints: issues.filter((i) => !resolvedBy(i, eod)).reduce((a, i) => a + pts(i), 0) });
      }
    }
    return [200, { committedPoints: issues.reduce((a, i) => a + pts(i), 0), completedPoints: done.reduce((a, i) => a + pts(i), 0), completedIssues: done.length, carriedOver: s.carriedOverIds.length, burndown }];
  });
  R('GET', '/api/projects/:id/stats', (c) => {
    const p = getProject(c, c.params.id); const is = db.issues.filter((i) => i.projectId === p.id);
    const byStatus = {}; for (const s of p.workflow.statuses) byStatus[s.name] = 0;
    const byType = {}, byAssignee = {}; let sum = 0, n = 0;
    for (const i of is) {
      byStatus[i.status] = (byStatus[i.status] || 0) + 1; byType[i.type] = (byType[i.type] || 0) + 1;
      const a = i.assigneeId ? userById(i.assigneeId)?.username : 'unassigned'; byAssignee[a] = (byAssignee[a] || 0) + 1;
      if (i.resolvedAt && i._startedAt) { sum += (Date.parse(i.resolvedAt) - Date.parse(i._startedAt)) / 3600000; n++; }
    }
    return [200, { total: is.length, byStatus, byType, byAssignee, avgCycleTimeHours: n ? sum / n : null }];
  });

  // search
  const PRANK = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
  R('GET', '/api/search', (c) => {
    let terms; try { terms = parseSearch(c.query.get('q') || ''); } catch (e) { throw bad(e.message); }
    const sort = c.query.get('sort') || 'updated';
    if (!['updated', 'created', 'priority'].includes(sort)) throw bad('invalid sort');
    let projects = db.projects.filter((p) => projRole(c.user, p));
    const pf = c.query.get('project');
    if (pf) { projects = projects.filter((p) => p.id === pf || p.key === pf); if (!projects.length && !db.projects.some((p) => p.id === pf || p.key === pf)) throw notFound('project not found'); }
    const ids = new Set(projects.map((p) => p.id));
    const env = { user: c.user, userByName, sprint: (id) => find('sprints', id), catOf: (i) => catOf(find('projects', i.projectId), i.status), assigneeName: (i) => userById(i.assigneeId)?.username };
    let res = db.issues.filter((i) => ids.has(i.projectId) && matchIssue(i, terms, env));
    const cmp = { updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt), created: (a, b) => b.createdAt.localeCompare(a.createdAt), priority: (a, b) => PRANK[a.priority] - PRANK[b.priority] || b.updatedAt.localeCompare(a.updatedAt) }[sort];
    res = res.map((x, idx) => [x, idx]).sort((a, b) => cmp(a[0], b[0]) || b[1] - a[1]).map((x) => x[0]);
    return [200, { issues: res.map(issueOut), total: res.length }];
  });

  // csv
  const HEAD = ['key', 'type', 'title', 'status', 'priority', 'assignee', 'labels', 'storyPoints', 'parent', 'epic', 'sprint', 'dueDate', 'createdAt', 'resolvedAt'];
  R('GET', '/api/projects/:id/export.csv', (c) => {
    const p = getProject(c, c.params.id);
    const rows = [HEAD];
    for (const i of db.issues.filter((x) => x.projectId === p.id)) rows.push([i.key, i.type, i.title, i.status, i.priority, i.assigneeId ? userById(i.assigneeId)?.username : '', i.labels.join(';'),
      i.storyPoints ?? '', i.parentId ? find('issues', i.parentId)?.key : '', i.epicId ? find('issues', i.epicId)?.key : '', i.sprintId ? find('sprints', i.sprintId)?.name : '', i.dueDate ?? '', i.createdAt, i.resolvedAt ?? '']);
    return [200, toCsv(rows), 'text/csv; charset=utf-8'];
  });
  R('POST', '/api/projects/:id/import.csv', (c) => {
    const p = getProject(c, c.params.id, 'developer'); const text = c.raw.replace(/^﻿/, '');
    let rows; try { rows = parseCsv(text); } catch (e) { throw bad(e.message); }
    if (!rows.length) throw bad('empty csv');
    const head = rows[0].rec.map((h) => h.trim()); const missing = ['title'].filter((h) => !head.includes(h)); if (missing.length) throw bad('missing column: title');
    let created = 0; const errors = [];
    for (const row of rows.slice(1)) {
      const r = {}; head.forEach((h, k) => { r[h] = row.rec[k] ?? ''; });
      if (row.rec.length === 1 && row.rec[0] === '') continue;
      try {
        const b = { title: r.title, type: r.type || 'task', priority: r.priority || 'none' };
        if (r.status && !p.workflow.statuses.some((s) => s.name === r.status)) throw bad(`unknown status "${r.status}"`);
        if (r.assignee) { const u = userByName(r.assignee); if (!u || !projRole(u, p)) throw bad(`unknown assignee "${r.assignee}"`); b.assigneeId = u.id; }
        if (r.labels) b.labels = r.labels.split(';').map((x) => x.trim()).filter(Boolean);
        if (r.storyPoints !== '') { const n = Number(r.storyPoints); if (!isFinite(n) || n < 0) throw bad('invalid storyPoints'); b.storyPoints = n; }
        if (r.parent) { if (!resolveRef(p, r.parent)) throw bad(`unknown parent "${r.parent}"`); b.parentId = r.parent; }
        if (r.epic) { if (!resolveRef(p, r.epic)) throw bad(`unknown epic "${r.epic}"`); b.epicId = r.epic; }
        if (r.sprint) { const s = db.sprints.find((x) => x.projectId === p.id && (x.id === r.sprint || x.name === r.sprint)); if (!s) throw bad(`unknown sprint "${r.sprint}"`); b.sprintId = s.id; }
        if (r.dueDate) b.dueDate = r.dueDate;
        if (b.type === 'subtask' && !b.parentId) throw bad('subtask requires parent');
        const i = createIssue(p, c.user, b, r.status || undefined); created++; fire(p, 'issue.created', i, c.user.id);
      } catch (e) { if (!(e instanceof HttpError)) throw e; errors.push({ line: row.line, message: e.message }); }
    }
    return [200, { created, errors }];
  }, true);

  // webhooks
  const hookOut = (w) => ({ id: w.id, projectId: w.projectId, url: w.url, events: w.events, createdAt: w.createdAt });
  R('POST', '/api/projects/:id/webhooks', (c) => {
    const p = getProject(c, c.params.id, 'lead'); const { url, events, secret } = c.body;
    try { if (!/^https?:$/.test(new URL(url).protocol)) throw 0; } catch { throw bad('invalid url'); }
    if (!Array.isArray(events) || !events.length || events.some((e) => !EVENTS.includes(e))) throw bad('invalid events');
    if (!isStr(secret)) throw bad('secret required');
    const w = { id: randomUUID(), projectId: p.id, url, events: [...new Set(events)], secret, createdAt: iso() };
    db.webhooks.push(w); audit(p.workspaceId, 'webhook.created', c.user.id, { projectId: p.id, webhookId: w.id, url });
    return [201, hookOut(w)];
  });
  R('GET', '/api/projects/:id/webhooks', (c) => { const p = getProject(c, c.params.id, 'lead'); return [200, db.webhooks.filter((w) => w.projectId === p.id).map(hookOut)]; });
  const getHook = (c, min) => { const w = find('webhooks', c.params.id); if (!w) throw notFound('webhook not found'); c.project = getProject(c, w.projectId, min); return w; };
  R('DELETE', '/api/webhooks/:id', (c) => {
    const w = getHook(c, 'lead'); db.webhooks = db.webhooks.filter((x) => x !== w);
    audit(c.project.workspaceId, 'webhook.deleted', c.user.id, { projectId: w.projectId, webhookId: w.id }); return [204];
  });
  R('GET', '/api/webhooks/:id/deliveries', (c) => {
    const w = getHook(c, 'lead');
    return [200, db.deliveries.filter((d) => d.webhookId === w.id).map((d) => ({ id: d.id, event: d.event, status: d.status, attempts: d.attempts, lastError: d.lastError, at: d.at }))];
  });

  // ---------- http ----------
  const send = (res, status, body, type = 'application/json') => {
    const data = body === undefined ? '' : (typeof body === 'string' || Buffer.isBuffer(body)) ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(data) }); res.end(data);
  };
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
  function serveStatic(res, rel) {
    const f = path.normalize(path.join(STATIC_DIR, rel));
    if (!f.startsWith(STATIC_DIR + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return send(res, 404, { error: 'not_found', message: 'not found' });
    send(res, 200, fs.readFileSync(f), MIME[path.extname(f)] || 'application/octet-stream');
  }
  async function handle(req, res) {
    const url = new URL(req.url, 'http://x'); const pathname = url.pathname;
    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) return serveStatic(res, 'index.html');
    if (req.method === 'GET' && pathname.startsWith('/static/')) return serveStatic(res, decodeURIComponent(pathname.slice(8)));
    const chunks = []; for await (const ch of req) chunks.push(ch);
    const raw = Buffer.concat(chunks).toString('utf8');
    if (!pathname.startsWith('/api/')) throw notFound('not found');
    let route, params = {};
    let pathMatched = false;
    for (const r of routes) {
      const m = r.re.exec(pathname); if (!m) continue; pathMatched = true;
      if (r.method !== req.method) continue;
      route = r; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); break;
    }
    if (!route) throw pathMatched ? new HttpError(405, 'method_not_allowed', 'method not allowed') : notFound('route not found');
    const ctx = { req, res, params, query: url.searchParams, raw, body: {} };
    if (route.auth) {
      const m = /^Bearer (.+)$/i.exec(req.headers.authorization || '');
      const rec = m && db.tokens.find((t) => t.hash === sha(m[1].trim()));
      const user = rec && userById(rec.userId);
      if (!user) throw new HttpError(401, 'unauthenticated', 'authentication required');
      ctx.user = user; ctx.tokenRec = rec;
    }
    if (raw && !/csv/.test(req.headers['content-type'] || '') ) {
      try { ctx.body = JSON.parse(raw); } catch { throw bad('invalid JSON body'); }
      if (ctx.body === null || typeof ctx.body !== 'object' || Array.isArray(ctx.body)) throw bad('body must be an object');
    }
    const [status, body, type] = route.handler(ctx);
    if (req.method !== 'GET') save();
    send(res, status, body, type);
  }
  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (e instanceof HttpError) return send(res, e.status, { error: e.error, message: e.message });
      console.error(e); send(res, 500, { error: 'internal_error', message: 'internal error' });
    });
  });
  return server;
}
