import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseQuery, matchIssue } from './search.js';
import { toCsv, parseCsv } from './csv.js';

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIOS = ['urgent', 'high', 'medium', 'low', 'none'];
const CATS = ['backlog', 'unstarted', 'started', 'completed'];
const RANK = { viewer: 0, developer: 1, lead: 2 };
const LINK_TYPES = ['blocks', 'relates', 'duplicates'];
const INVERSE = { blocks: 'blocked_by', relates: 'relates', duplicates: 'duplicated_by' };
const EVENTS = ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'];

class HttpError extends Error { constructor(status, code, message) { super(message || code); this.status = status; this.code = code; } }
const bad = (m) => new HttpError(400, 'validation_error', m);
const forbidden = (m = 'forbidden') => new HttpError(403, 'forbidden', m);
const notFound = (m = 'not found') => new HttpError(404, 'not_found', m);
const conflict = (code, m) => new HttpError(409, code, m || code);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const uid = () => crypto.randomUUID();
const isStr = (v) => typeof v === 'string' && v.trim() !== '';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function createServer({ dataFile, clock } = {}) {
  const nowD = () => (clock ? new Date(clock()) : new Date());
  const now = () => nowD().toISOString();
  let S = { users: {}, sessions: {}, apiTokens: [], workspaces: {}, projects: {}, issues: {}, comments: {}, sprints: {}, links: [], notifications: [], webhooks: {}, deliveries: [], audit: [] };
  if (dataFile && fs.existsSync(dataFile)) { try { S = { ...S, ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) }; } catch {} }
  const byKey = new Map(); for (const i of Object.values(S.issues)) byKey.set(i.key, i);
  const failures = new Map();
  let saveTimer = null;
  const save = () => {
    if (!dataFile) return;
    try { fs.writeFileSync(dataFile + '.tmp', JSON.stringify(S)); fs.renameSync(dataFile + '.tmp', dataFile); } catch {}
  };
  const dirty = () => { if (!dataFile || saveTimer) return; saveTimer = setTimeout(() => { saveTimer = null; save(); }, 20); saveTimer.unref?.(); };

  // ---------- helpers ----------
  const userView = (u) => ({ id: u.id, username: u.username, displayName: u.displayName });
  const userByName = (n) => Object.values(S.users).find((u) => typeof n === 'string' && u.username.toLowerCase() === n.toLowerCase());
  const hashPw = (pw, salt = crypto.randomBytes(16).toString('hex')) => ({ salt, hash: crypto.scryptSync(pw, salt, 32).toString('hex') });
  const checkPw = (u, pw) => { const h = crypto.scryptSync(String(pw), u.salt, 32); const e = Buffer.from(u.passwordHash, 'hex'); return h.length === e.length && crypto.timingSafeEqual(h, e); };

  const wsRole = (user, ws) => ws.members.find((m) => m.userId === user.id)?.role || null;
  const projRole = (user, p) => {
    const ws = S.workspaces[p.workspaceId]; const wr = wsRole(user, ws);
    if (!wr) return null;
    if (wr === 'admin') return 'lead';
    const ex = p.members.find((m) => m.userId === user.id);
    if (ex) return ex.role;
    return wr === 'member' ? 'developer' : null;
  };
  const getWs = (user, id, adminOnly) => {
    const ws = S.workspaces[id]; if (!ws) throw notFound('workspace not found');
    const r = wsRole(user, ws); if (!r) throw forbidden();
    if (adminOnly && r !== 'admin') throw forbidden('admin required');
    return ws;
  };
  const getProject = (user, id, min = 'viewer') => {
    const p = S.projects[id]; if (!p) throw notFound('project not found');
    const r = projRole(user, p); if (!r) throw forbidden();
    if (RANK[r] < RANK[min]) throw forbidden('insufficient role');
    return p;
  };
  const getIssue = (user, key, min = 'viewer') => {
    const i = byKey.get(String(key).toUpperCase()); if (!i) throw notFound('issue not found');
    const p = S.projects[i.projectId]; const r = projRole(user, p); if (!r) throw forbidden();
    if (RANK[r] < RANK[min]) throw forbidden('insufficient role');
    return { issue: i, project: p };
  };
  const canSee = (u, p) => !!projRole(u, p);
  const audit = (wsId, actor, action, details = {}) => { S.audit.push({ id: uid(), workspaceId: wsId, action, type: action, actorId: actor.id, at: now(), details }); };
  const catOf = (p, status) => p.workflow.statuses.find((s) => s.name === status)?.category;

  const wsView = (ws) => ({ ...ws, members: ws.members.map((m) => ({ ...m, username: S.users[m.userId]?.username })) });
  const projView = (p, user) => ({ ...p, role: user ? projRole(user, p) : undefined, members: p.members.map((m) => ({ ...m, username: S.users[m.userId]?.username })) });
  const issueView = (i) => {
    const { history, startedAt, ...rest } = i;
    const links = [];
    for (const l of S.links) {
      if (l.from === i.id) { const t = S.issues[l.to]; if (t) links.push({ id: l.id, type: l.type, key: t.key, target: t.key }); }
      else if (l.to === i.id) { const t = S.issues[l.from]; if (t) links.push({ id: l.id, type: INVERSE[l.type], key: t.key, target: t.key }); }
    }
    const all = Object.values(S.issues);
    const out = { ...rest, links, children: all.filter((c) => c.parentId === i.id).map((c) => c.key) };
    if (i.type === 'epic') {
      const p = S.projects[i.projectId]; const ch = all.filter((c) => c.epicId === i.id);
      const done = ch.filter((c) => catOf(p, c.status) === 'completed');
      out.progress = { total: ch.length, done: done.length, points_total: ch.reduce((a, c) => a + (c.storyPoints || 0), 0), points_done: done.reduce((a, c) => a + (c.storyPoints || 0), 0) };
    }
    return out;
  };
  // parentId / epicId are exposed as ids; accept keys too
  const resolveRef = (project, v, what) => {
    if (v == null || v === '') return null;
    const t = S.issues[v] || byKey.get(String(v).toUpperCase());
    if (!t || t.projectId !== project.id) throw bad(`${what} must reference an issue in the same project`);
    return t.id;
  };

  function notify(project, issue, type, actor, userIds) {
    for (const uidd of new Set(userIds)) {
      if (uidd === actor.id) continue;
      const u = S.users[uidd]; if (!u || !canSee(u, project)) continue;
      S.notifications.push({ id: uid(), userId: uidd, type, issueKey: issue.key, actorId: actor.id, at: now(), read: false });
    }
  }
  const watch = (i, id) => { if (id && !i.watchers.includes(id)) i.watchers.push(id); };

  // ---------- webhooks ----------
  function fire(event, issue, actor, extra = {}) {
    for (const w of Object.values(S.webhooks)) {
      if (w.projectId !== issue.projectId || !w.events.includes(event)) continue;
      const d = { id: uid(), webhookId: w.id, event, status: null, attempts: 0, lastError: null, at: now() };
      S.deliveries.push(d);
      const body = JSON.stringify({ event, issue: issueView(issue), actorId: actor.id, at: d.at, ...extra });
      const sig = 'sha256=' + crypto.createHmac('sha256', w.secret).update(body).digest('hex');
      (async () => {
        for (let a = 0; a < 3; a++) {
          if (a) await new Promise((r) => setTimeout(r, 50 * a));
          d.attempts = a + 1;
          try {
            const r = await fetch(w.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pm-signature': sig, 'x-pm-event': event }, body, signal: AbortSignal.timeout(5000) });
            d.status = r.status;
            if (r.ok) { d.lastError = null; break; }
            d.lastError = `HTTP ${r.status}`;
          } catch (e) { d.lastError = String(e.message || e); }
          dirty();
        }
        dirty();
      })();
    }
  }

  // ---------- issue validation ----------
  function checkFields(project, b, cur) {
    const o = {};
    const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
    if (has('title')) { if (!isStr(b.title) || b.title.length > 500) throw bad('invalid title'); o.title = b.title.trim(); }
    if (has('description')) { if (b.description != null && typeof b.description !== 'string') throw bad('invalid description'); o.description = b.description ?? ''; }
    if (has('type')) { if (!TYPES.includes(b.type)) throw bad('invalid type'); o.type = b.type; }
    if (has('priority')) { if (!PRIOS.includes(b.priority)) throw bad('invalid priority'); o.priority = b.priority; }
    if (has('labels')) { if (!Array.isArray(b.labels) || b.labels.some((l) => !isStr(l))) throw bad('invalid labels'); o.labels = [...new Set(b.labels.map((l) => l.trim()))]; }
    if (has('storyPoints')) { if (b.storyPoints != null && (typeof b.storyPoints !== 'number' || !Number.isFinite(b.storyPoints) || b.storyPoints < 0)) throw bad('invalid storyPoints'); o.storyPoints = b.storyPoints ?? null; }
    if (has('dueDate')) { if (b.dueDate != null && (typeof b.dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(b.dueDate) || isNaN(Date.parse(b.dueDate)))) throw bad('invalid dueDate'); o.dueDate = b.dueDate ?? null; }
    if (has('assigneeId') || has('assignee')) {
      let id = has('assigneeId') ? b.assigneeId : (b.assignee ? userByName(b.assignee)?.id : null);
      if (has('assignee') && b.assignee && !id) throw bad('unknown assignee');
      if (id != null) { const u = S.users[id]; if (!u || !canSee(u, project)) throw bad('assignee cannot access project'); }
      o.assigneeId = id ?? null;
    }
    if (has('parentId')) o.parentId = resolveRef(project, b.parentId, 'parentId');
    if (has('epicId')) o.epicId = resolveRef(project, b.epicId, 'epicId');
    if (has('sprintId')) {
      if (b.sprintId == null) o.sprintId = null;
      else { const sp = S.sprints[b.sprintId]; if (!sp || sp.projectId !== project.id) throw bad('invalid sprintId'); if (sp.state === 'completed') throw bad('sprint is completed'); o.sprintId = sp.id; }
    }
    return o;
  }
  function checkHierarchy(project, r, selfId) {
    if (r.type === 'subtask') {
      if (!r.parentId) throw bad('subtask requires parentId');
      const par = S.issues[r.parentId];
      if (par.type === 'subtask') throw bad('parent cannot be a subtask');
      if (par.id === selfId) throw bad('invalid parent');
    } else if (r.parentId) throw bad('only subtasks may have a parent');
    if (r.epicId) { const e = S.issues[r.epicId]; if (e.type !== 'epic') throw bad('epicId must reference an epic'); if (r.type === 'epic') throw bad('epics cannot belong to epics'); }
  }
  function sprintTrack(i) {
    if (i.sprintId) { const sp = S.sprints[i.sprintId]; if (sp && !sp.memberIds.includes(i.id)) sp.memberIds.push(i.id); }
  }

  function applyStatus(project, i, to, actor, hist) {
    const from = i.status;
    if (from === to) return;
    if (!project.workflow.statuses.some((s) => s.name === to)) throw bad('unknown status');
    if (!project.workflow.transitions.some(([a, b]) => a === from && b === to)) throw conflict('invalid_transition', `cannot move from ${from} to ${to}`);
    const cat = catOf(project, to);
    if (cat === 'completed' && catOf(project, from) !== 'completed') {
      for (const l of S.links) if (l.type === 'blocks' && l.to === i.id) { const bl = S.issues[l.from]; if (bl && !bl.resolvedAt) throw conflict('blocked', `blocked by ${bl.key}`); }
    }
    hist('status', from, to);
    i.status = to;
    if (cat === 'started' && !i.startedAt) i.startedAt = now();
    if (cat === 'completed') { if (catOf(project, from) !== 'completed') { hist('resolvedAt', i.resolvedAt, now()); i.resolvedAt = now(); } }
    else if (i.resolvedAt) { hist('resolvedAt', i.resolvedAt, null); i.resolvedAt = null; }
  }

  function createIssue(project, actor, b, { strict = true } = {}) {
    const o = checkFields(project, b);
    if (!o.title) throw bad('title is required');
    const r = { type: 'task', priority: 'none', description: '', labels: [], storyPoints: null, assigneeId: null, parentId: null, epicId: null, sprintId: null, dueDate: null, ...o };
    checkHierarchy(project, r, null);
    let status = (project.workflow.statuses.find((s) => s.category === 'unstarted') || project.workflow.statuses[0]).name;
    if (b.status != null) { if (!project.workflow.statuses.some((s) => s.name === b.status)) throw bad('unknown status'); status = b.status; }
    const n = project.nextNum++;
    const t = now();
    const cat = catOf(project, status);
    const i = { id: uid(), key: `${project.key}-${n}`, projectId: project.id, ...r, status, reporterId: actor.id, watchers: [], createdAt: t, updatedAt: t, resolvedAt: cat === 'completed' ? t : null, startedAt: cat === 'started' || cat === 'completed' ? t : null, history: [] };
    watch(i, i.reporterId); watch(i, i.assigneeId);
    S.issues[i.id] = i; byKey.set(i.key, i); sprintTrack(i);
    return i;
  }

  // ---------- routes ----------
  const routes = [];
  const R = (method, pattern, handler, auth = true) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, auth });

  // auth
  R('POST', '/api/auth/register', ({ body }) => {
    const { username, password, displayName } = body;
    if (!isStr(username) || !/^[A-Za-z0-9_.-]{2,32}$/.test(username)) throw bad('invalid username');
    if (typeof password !== 'string' || password.length < 8) throw bad('password must be at least 8 characters');
    if (displayName != null && typeof displayName !== 'string') throw bad('invalid displayName');
    if (userByName(username)) throw conflict('username_taken', 'username already taken');
    const { salt, hash } = hashPw(password);
    const u = { id: uid(), username, displayName: displayName || username, salt, passwordHash: hash, createdAt: now() };
    S.users[u.id] = u;
    return [201, { user: userView(u) }];
  }, false);
  R('POST', '/api/auth/login', ({ body }) => {
    const { username, password } = body;
    if (!isStr(username) || typeof password !== 'string') throw bad('username and password required');
    const k = username.toLowerCase(); const t = nowD().getTime();
    const recent = (failures.get(k) || []).filter((x) => t - x < 15 * 60 * 1000); failures.set(k, recent);
    if (recent.length >= 5) throw new HttpError(429, 'rate_limited', 'too many failed attempts');
    const u = userByName(username);
    if (!u || !checkPw(u, password)) { recent.push(t); throw new HttpError(401, 'invalid_credentials', 'invalid username or password'); }
    failures.delete(k);
    const token = crypto.randomBytes(32).toString('hex');
    S.sessions[sha(token)] = { userId: u.id, createdAt: now() };
    return { token, user: userView(u) };
  }, false);
  R('POST', '/api/auth/logout', ({ token }) => { delete S.sessions[sha(token)]; return [204]; });
  R('GET', '/api/auth/me', ({ user }) => ({ user: userView(user) }));
  R('PATCH', '/api/auth/me', ({ user, body }) => {
    if (body.displayName !== undefined) { if (!isStr(body.displayName)) throw bad('invalid displayName'); }
    if (body.password !== undefined) {
      if (typeof body.password !== 'string' || body.password.length < 8) throw bad('password must be at least 8 characters');
      if (typeof body.currentPassword !== 'string') throw bad('currentPassword required');
      if (!checkPw(user, body.currentPassword)) throw forbidden('current password incorrect');
    } else if (body.currentPassword !== undefined && typeof body.currentPassword !== 'string') throw bad('invalid');
    if (body.displayName !== undefined) user.displayName = body.displayName.trim();
    if (body.password !== undefined) { const h = hashPw(body.password); user.salt = h.salt; user.passwordHash = h.hash; }
    return { user: userView(user) };
  });

  // tokens
  const userWorkspaces = (u) => Object.values(S.workspaces).filter((w) => wsRole(u, w));
  R('POST', '/api/tokens', ({ user, body }) => {
    if (!isStr(body.name)) throw bad('name required');
    const token = 'pmt_' + crypto.randomBytes(24).toString('hex');
    const t = { id: uid(), userId: user.id, name: body.name, hash: sha(token), createdAt: now() };
    S.apiTokens.push(t);
    for (const w of userWorkspaces(user)) audit(w.id, user, 'token.created', { tokenId: t.id, name: t.name });
    return [201, { id: t.id, name: t.name, token }];
  });
  R('GET', '/api/tokens', ({ user }) => S.apiTokens.filter((t) => t.userId === user.id).map((t) => ({ id: t.id, name: t.name, createdAt: t.createdAt })));
  R('DELETE', '/api/tokens/:id', ({ user, params }) => {
    const idx = S.apiTokens.findIndex((t) => t.id === params.id && t.userId === user.id);
    if (idx < 0) throw notFound('token not found');
    const [t] = S.apiTokens.splice(idx, 1);
    for (const w of userWorkspaces(user)) audit(w.id, user, 'token.deleted', { tokenId: t.id, name: t.name });
    return [204];
  });

  // workspaces
  R('POST', '/api/workspaces', ({ user, body }) => {
    if (!isStr(body.name)) throw bad('name required');
    if (typeof body.key !== 'string' || !/^[A-Z]{2,10}$/.test(body.key)) throw bad('key must be 2-10 uppercase letters');
    if (Object.values(S.workspaces).some((w) => w.key === body.key)) throw conflict('key_taken', 'workspace key already used');
    const ws = { id: uid(), name: body.name.trim(), key: body.key, createdAt: now(), members: [{ userId: user.id, role: 'admin' }] };
    S.workspaces[ws.id] = ws;
    audit(ws.id, user, 'workspace.created', {});
    return [201, wsView(ws)];
  });
  R('GET', '/api/workspaces', ({ user }) => userWorkspaces(user).map((w) => ({ ...wsView(w), role: wsRole(user, w) })));
  R('GET', '/api/workspaces/:id', ({ user, params }) => ({ ...wsView(getWs(user, params.id)), role: wsRole(user, S.workspaces[params.id]) }));
  const ROLES = ['admin', 'member', 'guest'];
  R('POST', '/api/workspaces/:id/members', ({ user, params, body }) => {
    const ws = getWs(user, params.id, true);
    if (!ROLES.includes(body.role)) throw bad('invalid role');
    if (!isStr(body.username)) throw bad('username required');
    const u = userByName(body.username); if (!u) throw notFound('user not found');
    if (ws.members.some((m) => m.userId === u.id)) throw conflict('already_member', 'already a member');
    ws.members.push({ userId: u.id, role: body.role });
    audit(ws.id, user, 'member.added', { userId: u.id, role: body.role });
    return [201, { userId: u.id, username: u.username, role: body.role }];
  });
  const adminCount = (ws) => ws.members.filter((m) => m.role === 'admin').length;
  R('PATCH', '/api/workspaces/:id/members/:uid', ({ user, params, body }) => {
    const ws = getWs(user, params.id, true);
    const m = ws.members.find((x) => x.userId === params.uid); if (!m) throw notFound('member not found');
    if (!ROLES.includes(body.role)) throw bad('invalid role');
    if (m.role === 'admin' && body.role !== 'admin' && adminCount(ws) <= 1) throw bad('cannot demote the last admin');
    audit(ws.id, user, 'member.role_changed', { userId: m.userId, from: m.role, to: body.role });
    m.role = body.role;
    return { userId: m.userId, username: S.users[m.userId]?.username, role: m.role };
  });
  R('DELETE', '/api/workspaces/:id/members/:uid', ({ user, params }) => {
    const ws = getWs(user, params.id, true);
    const m = ws.members.find((x) => x.userId === params.uid); if (!m) throw notFound('member not found');
    if (m.role === 'admin' && adminCount(ws) <= 1) throw bad('cannot remove the last admin');
    ws.members = ws.members.filter((x) => x !== m);
    for (const p of Object.values(S.projects)) if (p.workspaceId === ws.id) p.members = p.members.filter((x) => x.userId !== m.userId);
    audit(ws.id, user, 'member.removed', { userId: m.userId });
    return [204];
  });
  R('GET', '/api/workspaces/:id/audit', ({ user, params }) => {
    getWs(user, params.id, true);
    return S.audit.filter((a) => a.workspaceId === params.id).slice().reverse();
  });

  // projects
  R('POST', '/api/workspaces/:id/projects', ({ user, params, body }) => {
    const ws = getWs(user, params.id);
    if (wsRole(user, ws) === 'guest') throw forbidden('guests cannot create projects');
    if (!isStr(body.name)) throw bad('name required');
    if (typeof body.key !== 'string' || !/^[A-Z]{2,10}$/.test(body.key)) throw bad('key must be 2-10 uppercase letters');
    if (Object.values(S.projects).some((p) => p.key === body.key)) throw conflict('key_taken', 'project key already used');
    const names = ['Backlog', 'Todo', 'In Progress', 'In Review', 'Done'];
    const cats = ['backlog', 'unstarted', 'started', 'started', 'completed'];
    const p = { id: uid(), workspaceId: ws.id, name: body.name.trim(), key: body.key, createdAt: now(), nextNum: 1,
      workflow: { statuses: names.map((n, i) => ({ name: n, category: cats[i] })), transitions: names.flatMap((a) => names.filter((b) => b !== a).map((b) => [a, b])) },
      members: [{ userId: user.id, role: 'lead' }] };
    S.projects[p.id] = p;
    return [201, projView(p, user)];
  });
  const visibleProjects = (user, wsId) => Object.values(S.projects).filter((p) => (!wsId || p.workspaceId === wsId) && canSee(user, p));
  R('GET', '/api/workspaces/:id/projects', ({ user, params }) => { getWs(user, params.id); return visibleProjects(user, params.id).map((p) => projView(p, user)); });
  R('GET', '/api/projects', ({ user }) => visibleProjects(user).map((p) => projView(p, user)));
  R('GET', '/api/projects/:id', ({ user, params }) => projView(getProject(user, params.id), user));
  R('POST', '/api/projects/:id/members', ({ user, params, body }) => {
    const p = getProject(user, params.id, 'lead');
    if (!(body.role in RANK)) throw bad('invalid role');
    const u = userByName(body.username); if (!u) throw notFound('user not found');
    if (!wsRole(u, S.workspaces[p.workspaceId])) throw bad('user is not a workspace member');
    if (p.members.some((m) => m.userId === u.id)) throw conflict('already_member', 'already a project member');
    p.members.push({ userId: u.id, role: body.role });
    audit(p.workspaceId, user, 'project_member.added', { projectId: p.id, userId: u.id, role: body.role });
    return [201, { userId: u.id, username: u.username, role: body.role }];
  });
  R('PATCH', '/api/projects/:id/members/:uid', ({ user, params, body }) => {
    const p = getProject(user, params.id, 'lead');
    const m = p.members.find((x) => x.userId === params.uid); if (!m) throw notFound('member not found');
    if (!(body.role in RANK)) throw bad('invalid role');
    audit(p.workspaceId, user, 'project_member.role_changed', { projectId: p.id, userId: m.userId, from: m.role, to: body.role });
    m.role = body.role; return { userId: m.userId, username: S.users[m.userId]?.username, role: m.role };
  });
  R('DELETE', '/api/projects/:id/members/:uid', ({ user, params }) => {
    const p = getProject(user, params.id, 'lead');
    const m = p.members.find((x) => x.userId === params.uid); if (!m) throw notFound('member not found');
    p.members = p.members.filter((x) => x !== m);
    audit(p.workspaceId, user, 'project_member.removed', { projectId: p.id, userId: m.userId });
    return [204];
  });
  R('PUT', '/api/projects/:id/workflow', ({ user, params, body }) => {
    const p = getProject(user, params.id, 'lead');
    const { statuses, transitions } = body; const remap = body.remap ?? {};
    if (!Array.isArray(statuses) || !statuses.length) throw bad('statuses required');
    const names = new Set();
    for (const s of statuses) {
      if (!s || !isStr(s.name) || !CATS.includes(s.category)) throw bad('invalid status');
      if (names.has(s.name)) throw bad('duplicate status'); names.add(s.name);
    }
    if (!Array.isArray(transitions) || transitions.some((t) => !Array.isArray(t) || t.length !== 2 || !names.has(t[0]) || !names.has(t[1]))) throw bad('invalid transitions');
    if (typeof remap !== 'object' || Array.isArray(remap)) throw bad('invalid remap');
    const removed = p.workflow.statuses.map((s) => s.name).filter((n) => !names.has(n));
    const issues = Object.values(S.issues).filter((i) => i.projectId === p.id);
    for (const n of removed) if (issues.some((i) => i.status === n)) { if (!remap[n] || !names.has(remap[n])) throw bad(`status "${n}" is in use and needs a valid remap`); }
    const t = now();
    for (const i of issues) {
      if (names.has(i.status)) continue;
      const to = remap[i.status]; const cat = statuses.find((s) => s.name === to).category;
      i.history.push({ field: 'status', from: i.status, to, actorId: user.id, at: t }); i.status = to; i.updatedAt = t;
      if (cat === 'completed' && !i.resolvedAt) { i.history.push({ field: 'resolvedAt', from: null, to: t, actorId: user.id, at: t }); i.resolvedAt = t; }
      else if (cat !== 'completed' && i.resolvedAt) { i.history.push({ field: 'resolvedAt', from: i.resolvedAt, to: null, actorId: user.id, at: t }); i.resolvedAt = null; }
      if (cat === 'started' && !i.startedAt) i.startedAt = t;
    }
    p.workflow = { statuses: statuses.map((s) => ({ name: s.name, category: s.category })), transitions: transitions.map(([a, b]) => [a, b]) };
    audit(p.workspaceId, user, 'workflow.updated', { projectId: p.id });
    return p.workflow;
  });
  R('GET', '/api/projects/:id/workflow', ({ user, params }) => getProject(user, params.id).workflow);

  // issues
  R('POST', '/api/projects/:id/issues', ({ user, params, body }) => {
    const p = getProject(user, params.id, 'developer');
    const i = createIssue(p, user, body);
    if (i.assigneeId) notify(p, i, 'assigned', user, [i.assigneeId]);
    fire('issue.created', i, user);
    return [201, issueView(i)];
  });
  R('GET', '/api/projects/:id/issues', ({ user, params }) => { const p = getProject(user, params.id); return Object.values(S.issues).filter((i) => i.projectId === p.id).map(issueView); });
  R('GET', '/api/issues/:key', ({ user, params }) => issueView(getIssue(user, params.key).issue));
  R('PATCH', '/api/issues/:key', ({ user, params, body }) => {
    const { issue: i, project: p } = getIssue(user, params.key, 'developer');
    const o = checkFields(p, body);
    const r = { type: i.type, parentId: i.parentId, epicId: i.epicId, ...o };
    if (body.status !== undefined && !isStr(body.status)) throw bad('invalid status');
    checkHierarchy(p, r, i.id);
    if (i.type === 'epic' && r.type !== 'epic' && Object.values(S.issues).some((c) => c.epicId === i.id)) throw bad('epic has children');
    const t = now(); const hist = [];
    const h = (field, from, to) => hist.push({ field, from, to, actorId: user.id, at: t });
    const oldAssignee = i.assigneeId; const oldStatus = i.status;
    // work on a snapshot so a failed transition leaves no partial changes
    const snap = { ...i, labels: [...i.labels], watchers: [...i.watchers] };
    try {
      if (body.status !== undefined) applyStatus(p, i, body.status, user, h);
    } catch (e) { Object.assign(i, snap); throw e; }
    for (const [k, v] of Object.entries(o)) { if (!same(i[k], v)) { h(k, i[k], v); i[k] = v; } }
    if (i.type !== 'subtask' && i.parentId) { h('parentId', i.parentId, null); i.parentId = null; }
    if (!hist.length) return issueView(i);
    i.history.push(...hist); i.updatedAt = t;
    sprintTrack(i);
    if (i.assigneeId !== oldAssignee && i.assigneeId) watch(i, i.assigneeId);
    if (i.assigneeId !== oldAssignee) notify(p, i, 'assigned', user, i.watchers);
    if (i.status !== oldStatus) notify(p, i, 'status_changed', user, i.watchers);
    fire('issue.updated', i, user);
    return issueView(i);
  });
  const removeIssue = (i) => {
    S.links = S.links.filter((l) => l.from !== i.id && l.to !== i.id);
    for (const c of Object.values(S.comments)) if (c.issueId === i.id) delete S.comments[c.id];
    for (const sp of Object.values(S.sprints)) sp.memberIds = sp.memberIds.filter((x) => x !== i.id);
    delete S.issues[i.id]; byKey.delete(i.key);
  };
  R('DELETE', '/api/issues/:key', ({ user, params }) => {
    const { issue: i } = getIssue(user, params.key, 'developer');
    const snapshot = issueView(i);
    for (const c of Object.values(S.issues)) if (c.parentId === i.id) removeIssue(c);
    for (const c of Object.values(S.issues)) if (c.epicId === i.id) { c.history.push({ field: 'epicId', from: i.id, to: null, actorId: user.id, at: now() }); c.epicId = null; }
    removeIssue(i);
    fire('issue.deleted', { ...snapshot, history: [] }, user);
    return [204];
  });
  R('GET', '/api/issues/:key/history', ({ user, params }) => getIssue(user, params.key).issue.history.map(({ field, from, to, actorId, at }) => ({ field, from, to, actorId, at })));
  R('POST', '/api/issues/:key/links', ({ user, params, body }) => {
    const { issue: i } = getIssue(user, params.key, 'developer');
    if (!LINK_TYPES.includes(body.type)) throw bad('invalid link type');
    if (!isStr(body.target)) throw bad('target required');
    const t = byKey.get(body.target.toUpperCase()); if (!t) throw bad('target not found');
    if (!canSee(user, S.projects[t.projectId])) throw forbidden();
    if (t.id === i.id) throw bad('cannot link an issue to itself');
    if (S.links.some((l) => (l.from === i.id && l.to === t.id && l.type === body.type) || (l.from === t.id && l.to === i.id && (l.type === body.type && body.type === 'relates')))) throw conflict('duplicate_link', 'link exists');
    const l = { id: uid(), type: body.type, from: i.id, to: t.id }; S.links.push(l);
    return [201, { id: l.id, type: l.type, target: t.key, key: t.key, issue: issueView(i) }];
  });
  R('DELETE', '/api/issues/:key/links/:id', ({ user, params }) => {
    const { issue: i } = getIssue(user, params.key, 'developer');
    const idx = S.links.findIndex((l) => l.id === params.id && (l.from === i.id || l.to === i.id));
    if (idx < 0) throw notFound('link not found'); S.links.splice(idx, 1); return [204];
  });
  R('POST', '/api/issues/:key/watch', ({ user, params }) => { const { issue: i } = getIssue(user, params.key); watch(i, user.id); return issueView(i); });
  R('DELETE', '/api/issues/:key/watch', ({ user, params }) => { const { issue: i } = getIssue(user, params.key); i.watchers = i.watchers.filter((x) => x !== user.id); return issueView(i); });

  // comments
  const commentView = (c) => ({ id: c.id, issueKey: S.issues[c.issueId]?.key, authorId: c.authorId, body: c.body, createdAt: c.createdAt, updatedAt: c.updatedAt, edited: c.edited });
  R('POST', '/api/issues/:key/comments', ({ user, params, body }) => {
    const { issue: i, project: p } = getIssue(user, params.key, 'developer');
    if (!isStr(body.body)) throw bad('body required');
    const t = now();
    const c = { id: uid(), issueId: i.id, authorId: user.id, body: body.body, createdAt: t, updatedAt: t, edited: false };
    S.comments[c.id] = c;
    const mentioned = new Set();
    for (const m of body.body.matchAll(/@([A-Za-z0-9_.-]+)/g)) { const u = userByName(m[1].replace(/[.-]+$/, '')); if (u && canSee(u, p)) mentioned.add(u.id); }
    notify(p, i, 'mention', user, [...mentioned]);
    notify(p, i, 'comment', user, i.watchers.filter((w) => !mentioned.has(w)));
    fire('comment.created', i, user, { comment: commentView(c) });
    return [201, commentView(c)];
  });
  R('GET', '/api/issues/:key/comments', ({ user, params }) => { const { issue: i } = getIssue(user, params.key); return Object.values(S.comments).filter((c) => c.issueId === i.id).map(commentView); });
  const getComment = (user, id) => {
    const c = S.comments[id]; if (!c) throw notFound('comment not found');
    const i = S.issues[c.issueId]; const r = projRole(user, S.projects[i.projectId]); if (!r) throw forbidden();
    return { c, i, r };
  };
  R('PATCH', '/api/comments/:id', ({ user, params, body }) => {
    const { c } = getComment(user, params.id);
    if (c.authorId !== user.id) throw forbidden('only the author can edit');
    if (!isStr(body.body)) throw bad('body required');
    c.body = body.body; c.edited = true; c.updatedAt = now(); return commentView(c);
  });
  R('DELETE', '/api/comments/:id', ({ user, params }) => {
    const { c, r } = getComment(user, params.id);
    if (c.authorId !== user.id && r !== 'lead') throw forbidden();
    delete S.comments[c.id]; return [204];
  });

  // notifications
  R('GET', '/api/notifications', ({ user, query }) => {
    let l = S.notifications.filter((n) => n.userId === user.id);
    if (query.get('unread') === 'true') l = l.filter((n) => !n.read);
    return l.map(({ userId, ...n }) => n).reverse();
  });
  R('POST', '/api/notifications/read', ({ user, body }) => {
    if (body.all !== true && !Array.isArray(body.ids)) throw bad('ids or all required');
    let n = 0;
    for (const x of S.notifications) if (x.userId === user.id && !x.read && (body.all === true || body.ids.includes(x.id))) { x.read = true; n++; }
    return { updated: n };
  });

  // sprints
  const dayOf = (v) => String(v).slice(0, 10);
  const validDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) && !isNaN(Date.parse(v));
  const sprintView = (s) => { const { memberIds, snapshot, ...r } = s; return r; };
  const getSprint = (user, id, min = 'viewer') => { const s = S.sprints[id]; if (!s) throw notFound('sprint not found'); return { s, p: getProject(user, s.projectId, min) }; };
  R('POST', '/api/projects/:id/sprints', ({ user, params, body }) => {
    const p = getProject(user, params.id, 'developer');
    if (!isStr(body.name)) throw bad('name required');
    for (const k of ['startDate', 'endDate']) if (body[k] != null && !validDate(body[k])) throw bad(`invalid ${k}`);
    if (body.startDate && body.endDate && dayOf(body.endDate) < dayOf(body.startDate)) throw bad('endDate before startDate');
    const s = { id: uid(), projectId: p.id, name: body.name.trim(), startDate: body.startDate ?? null, endDate: body.endDate ?? null, state: 'planned', createdAt: now(), memberIds: [], snapshot: null };
    S.sprints[s.id] = s; return [201, sprintView(s)];
  });
  R('GET', '/api/projects/:id/sprints', ({ user, params }) => { const p = getProject(user, params.id); return Object.values(S.sprints).filter((s) => s.projectId === p.id).map(sprintView); });
  R('GET', '/api/sprints/:id', ({ user, params }) => sprintView(getSprint(user, params.id).s));
  R('POST', '/api/sprints/:id/start', ({ user, params }) => {
    const { s, p } = getSprint(user, params.id, 'developer');
    if (s.state !== 'planned') throw conflict('invalid_state', 'sprint is not planned');
    if (Object.values(S.sprints).some((x) => x.projectId === p.id && x.state === 'active')) throw conflict('sprint_active', 'another sprint is active');
    s.state = 'active'; if (!s.startDate) s.startDate = now().slice(0, 10);
    s.startedAt = now();
    for (const i of Object.values(S.issues)) if (i.sprintId === s.id) sprintTrack(i);
    return sprintView(s);
  });
  const pts = (i) => i.storyPoints || 0;
  R('POST', '/api/sprints/:id/complete', ({ user, params, body }) => {
    const { s, p } = getSprint(user, params.id, 'developer');
    if (s.state !== 'active') throw conflict('invalid_state', 'sprint is not active');
    const target = body.carryOverTo ?? 'backlog';
    let dest = null;
    if (target !== 'backlog') {
      dest = S.sprints[target];
      if (!dest || dest.projectId !== p.id || dest.id === s.id || dest.state === 'completed') throw bad('invalid carryOverTo');
    }
    const issues = Object.values(S.issues).filter((i) => i.sprintId === s.id);
    const done = issues.filter((i) => catOf(p, i.status) === 'completed');
    const open = issues.filter((i) => catOf(p, i.status) !== 'completed');
    s.snapshot = { committedPoints: s.memberIds.reduce((a, id) => a + (S.issues[id] ? pts(S.issues[id]) : 0), 0), completedPoints: done.reduce((a, i) => a + pts(i), 0), completedIssues: done.length, carriedOver: open.length };
    const t = now();
    for (const i of open) { i.history.push({ field: 'sprintId', from: s.id, to: dest ? dest.id : null, actorId: user.id, at: t }); i.sprintId = dest ? dest.id : null; i.updatedAt = t; sprintTrack(i); }
    s.state = 'completed'; s.completedAt = t;
    return sprintView(s);
  });
  R('GET', '/api/sprints/:id/report', ({ user, params }) => {
    const { s } = getSprint(user, params.id);
    const members = s.memberIds.map((id) => S.issues[id]).filter(Boolean);
    const live = { committedPoints: members.reduce((a, i) => a + pts(i), 0), completedPoints: 0, completedIssues: 0, carriedOver: 0 };
    const p = S.projects[s.projectId];
    if (s.state !== 'completed') { const cur = members.filter((i) => i.sprintId === s.id); const d = cur.filter((i) => catOf(p, i.status) === 'completed'); live.completedPoints = d.reduce((a, i) => a + pts(i), 0); live.completedIssues = d.length; }
    const base = s.snapshot || live;
    const burndown = [];
    if (s.startDate && s.state !== 'planned') {
      const today = dayOf(now()); const end = s.endDate && dayOf(s.endDate) < today ? dayOf(s.endDate) : today;
      const stopAt = s.completedAt && dayOf(s.completedAt) < end ? dayOf(s.completedAt) : end;
      for (let d = new Date(dayOf(s.startDate) + 'T00:00:00Z'), n = 0; d.toISOString().slice(0, 10) <= stopAt && n < 3660; d = new Date(d.getTime() + 86400000), n++) {
        const ds = d.toISOString().slice(0, 10); const eod = ds + 'T23:59:59.999Z';
        let rem = 0;
        for (const i of members) {
          const rh = i.history.filter((h) => h.field === 'resolvedAt' && h.at <= eod);
          let resolved;
          if (rh.length) resolved = rh[rh.length - 1].to != null;
          else resolved = !i.history.some((h) => h.field === 'resolvedAt') && !!i.resolvedAt && i.resolvedAt <= eod;
          if (!resolved) rem += pts(i);
        }
        burndown.push({ date: ds, remainingPoints: rem });
      }
    }
    return { committedPoints: base.committedPoints, completedPoints: base.completedPoints, completedIssues: base.completedIssues, carriedOver: base.carriedOver, burndown };
  });

  R('GET', '/api/projects/:id/stats', ({ user, params }) => {
    const p = getProject(user, params.id);
    const byStatus = Object.fromEntries(p.workflow.statuses.map((s) => [s.name, 0]));
    const byType = Object.fromEntries(TYPES.map((t) => [t, 0])); const byAssignee = {};
    let sum = 0, n = 0;
    for (const i of Object.values(S.issues)) {
      if (i.projectId !== p.id) continue;
      byStatus[i.status] = (byStatus[i.status] || 0) + 1; byType[i.type]++;
      const a = i.assigneeId ? S.users[i.assigneeId]?.username : 'unassigned'; byAssignee[a] = (byAssignee[a] || 0) + 1;
      if (i.resolvedAt && i.startedAt) { sum += (Date.parse(i.resolvedAt) - Date.parse(i.startedAt)) / 3600000; n++; }
    }
    const avg = n ? Math.round((sum / n) * 100) / 100 : null;
    return { byStatus, byType, byAssignee, avgCycleTimeHours: avg, averageCycleTimeHours: avg };
  });

  // search
  R('GET', '/api/search', ({ user, query }) => {
    const q = parseQuery(query.get('q') || '');
    const sort = query.get('sort') || 'updated';
    if (!['updated', 'created', 'priority'].includes(sort)) throw bad('invalid sort');
    let projects = visibleProjects(user);
    const pf = query.get('project');
    if (pf) projects = projects.filter((p) => p.id === pf || p.key === pf);
    const ids = new Set(projects.map((p) => p.id));
    const ctx = { user, S, projects: S.projects, catOf, now: nowD() };
    let res = Object.values(S.issues).filter((i) => ids.has(i.projectId) && matchIssue(q, i, ctx));
    const pr = (i) => PRIOS.indexOf(i.priority);
    const num = (i) => Number(i.key.split('-').pop());
    res.sort((a, b) => sort === 'priority' ? pr(a) - pr(b) || b.updatedAt.localeCompare(a.updatedAt) || num(b) - num(a)
      : (sort === 'created' ? b.createdAt.localeCompare(a.createdAt) : b.updatedAt.localeCompare(a.updatedAt)) || num(b) - num(a));
    return res.map(issueView);
  });

  // csv
  const COLS = ['key', 'type', 'title', 'status', 'priority', 'assignee', 'labels', 'storyPoints', 'parent', 'epic', 'sprint', 'dueDate', 'createdAt', 'resolvedAt'];
  R('GET', '/api/projects/:id/export.csv', ({ user, params }) => {
    const p = getProject(user, params.id);
    const rows = Object.values(S.issues).filter((i) => i.projectId === p.id).sort((a, b) => Number(a.key.split('-').pop()) - Number(b.key.split('-').pop())).map((i) => [
      i.key, i.type, i.title, i.status, i.priority, i.assigneeId ? S.users[i.assigneeId]?.username : '', i.labels.join(';'), i.storyPoints ?? '',
      i.parentId ? S.issues[i.parentId]?.key : '', i.epicId ? S.issues[i.epicId]?.key : '', i.sprintId ? S.sprints[i.sprintId]?.name : '', i.dueDate ?? '', i.createdAt, i.resolvedAt ?? '']);
    return { raw: toCsv([COLS, ...rows]), type: 'text/csv; charset=utf-8' };
  });
  R('POST', '/api/projects/:id/import.csv', ({ user, params, raw }) => {
    const p = getProject(user, params.id, 'developer');
    let rows; try { rows = parseCsv(raw || ''); } catch (e) { throw bad(e.message); }
    if (!rows.length) throw bad('empty csv');
    const head = rows[0].fields.map((h) => h.trim());
    if (!head.includes('title')) throw bad('missing title column');
    let created = 0; const errors = [];
    for (const row of rows.slice(1)) {
      if (row.fields.length === 1 && row.fields[0].trim() === '') continue;
      const rec = {}; head.forEach((h, k) => { rec[h] = (row.fields[k] ?? '').trim(); });
      try {
        const b = {};
        if (rec.type) b.type = rec.type;
        b.title = rec.title;
        if (rec.priority) b.priority = rec.priority;
        if (rec.labels) b.labels = rec.labels.split(';').map((x) => x.trim()).filter(Boolean);
        if (rec.storyPoints) { const n = Number(rec.storyPoints); if (!Number.isFinite(n)) throw bad('invalid storyPoints'); b.storyPoints = n; }
        if (rec.dueDate) b.dueDate = rec.dueDate;
        if (rec.status) b.status = rec.status;
        if (rec.assignee) { const u = userByName(rec.assignee); if (!u) throw bad(`unknown assignee ${rec.assignee}`); b.assigneeId = u.id; }
        if (rec.parent) { if (!byKey.has(rec.parent.toUpperCase())) throw bad(`unknown parent ${rec.parent}`); b.parentId = rec.parent; }
        if (rec.epic) { if (!byKey.has(rec.epic.toUpperCase())) throw bad(`unknown epic ${rec.epic}`); b.epicId = rec.epic; }
        if (rec.sprint) { const sp = Object.values(S.sprints).find((x) => x.projectId === p.id && (x.name === rec.sprint || x.id === rec.sprint)); if (!sp) throw bad(`unknown sprint ${rec.sprint}`); b.sprintId = sp.id; }
        const i = createIssue(p, user, b);
        created++; fire('issue.created', i, user);
      } catch (e) { if (!(e instanceof HttpError)) throw e; errors.push({ line: row.line, message: e.message }); }
    }
    return { created, errors };
  });

  // webhooks
  const hookView = (w) => { const { secret, ...r } = w; return r; };
  R('POST', '/api/projects/:id/webhooks', ({ user, params, body }) => {
    const p = getProject(user, params.id, 'lead');
    let u; try { u = new URL(body.url); } catch { throw bad('invalid url'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw bad('invalid url');
    if (!Array.isArray(body.events) || !body.events.length || body.events.some((e) => !EVENTS.includes(e))) throw bad('invalid events');
    if (!isStr(body.secret)) throw bad('secret required');
    const w = { id: uid(), projectId: p.id, url: body.url, events: [...new Set(body.events)], secret: body.secret, createdAt: now() };
    S.webhooks[w.id] = w; audit(p.workspaceId, user, 'webhook.created', { webhookId: w.id, projectId: p.id });
    return [201, hookView(w)];
  });
  R('GET', '/api/projects/:id/webhooks', ({ user, params }) => { const p = getProject(user, params.id, 'lead'); return Object.values(S.webhooks).filter((w) => w.projectId === p.id).map(hookView); });
  const getHook = (user, id) => { const w = S.webhooks[id]; if (!w) throw notFound('webhook not found'); return { w, p: getProject(user, w.projectId, 'lead') }; };
  R('DELETE', '/api/webhooks/:id', ({ user, params }) => { const { w, p } = getHook(user, params.id); delete S.webhooks[w.id]; audit(p.workspaceId, user, 'webhook.deleted', { webhookId: w.id, projectId: p.id }); return [204]; });
  R('GET', '/api/webhooks/:id/deliveries', ({ user, params }) => { const { w } = getHook(user, params.id); return S.deliveries.filter((d) => d.webhookId === w.id).map(({ webhookId, ...d }) => d); });

  // ---------- server ----------
  const send = (res, status, data, type) => {
    if (status === 204) { res.writeHead(204); return res.end(); }
    const body = type ? data : JSON.stringify(data);
    res.writeHead(status, { 'content-type': type || 'application/json; charset=utf-8' }); res.end(body);
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > 5e6) { reject(new HttpError(400, 'validation_error', 'body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      let p = url.pathname;
      if (req.method === 'GET' && (p === '/' || p.startsWith('/static/'))) {
        const f = p === '/' ? 'index.html' : decodeURIComponent(p.slice(8));
        const full = path.resolve(STATIC_DIR, f);
        if (!full.startsWith(STATIC_DIR + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) throw notFound();
        return send(res, 200, fs.readFileSync(full), MIME[path.extname(full)] || 'application/octet-stream');
      }
      if (!p.startsWith('/api/')) throw notFound();
      if (p.length > 5 && p.endsWith('/')) p = p.slice(0, -1);
      let route, params;
      let pathMatched = false;
      for (const r of routes) { const m = r.re.exec(p); if (m) { pathMatched = true; if (r.method === req.method) { route = r; params = m.groups || {}; break; } } }
      if (!route) throw pathMatched ? new HttpError(405, 'method_not_allowed', 'method not allowed') : notFound('route not found');
      let user = null, token = null;
      if (route.auth) {
        const h = req.headers.authorization || '';
        token = /^Bearer (.+)$/i.exec(h)?.[1]?.trim();
        if (token) {
          const hs = sha(token);
          const s = S.sessions[hs]; const at = S.apiTokens.find((t) => t.hash === hs);
          user = S.users[s?.userId || at?.userId] || null;
        }
        if (!user) throw new HttpError(401, 'unauthenticated', 'authentication required');
      }
      const text = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : '';
      let body = {};
      const isCsv = route.re.source.includes('import.csv');
      if (text && !isCsv) {
        try { body = JSON.parse(text); } catch { throw bad('invalid JSON'); }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('body must be an object');
      }
      const out = await route.handler({ req, user, token, params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, decodeURIComponent(v)])), body, raw: text, query: url.searchParams });
      dirty();
      if (Array.isArray(out) && typeof out[0] === 'number' && (out.length === 1 || (out.length === 2 && typeof out[1] === 'object'))) return send(res, out[0], out[1]);
      if (out && out.raw !== undefined && out.type) return send(res, 200, out.raw, out.type);
      send(res, 200, out);
    } catch (e) {
      if (e instanceof HttpError || (e.status === 400 && e.code)) return send(res, e.status, { error: e.code, message: e.message });
      console.error(e);
      send(res, 500, { error: 'internal_error', message: 'internal error' });
    }
  });
  server.on('close', () => { if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; } save(); });
  return server;
}
