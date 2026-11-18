import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HttpError, bad, unauth, forbidden, notFound, conflict, newId,
  reqStr, optStr, isDate, readRaw, parseJson, isObj,
} from './util.js';
import { loadState, saveState } from './store.js';
import { parseCSV, formatCSV } from './csv.js';
import { parseQuery, buildMatcher } from './query.js';
import { sprintReport, projectStats, snapshotAt, isoDay } from './reports.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(here, 'public');

const WS_ROLES = ['admin', 'member', 'guest'];
const PROJ_ROLES = ['lead', 'developer', 'viewer'];
const RANK = { viewer: 1, developer: 2, lead: 3 };
const ISSUE_TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'];
const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
const LINK_TYPES = ['blocks', 'relates', 'duplicates'];
const INVERSE = { blocks: 'blocked_by', blocked_by: 'blocks', duplicates: 'duplicated_by', duplicated_by: 'duplicates', relates: 'relates' };
const CATEGORIES = ['backlog', 'unstarted', 'started', 'completed'];
const EVENTS = ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'];
const ISSUE_FIELDS = ['type', 'title', 'description', 'status', 'priority', 'assigneeId', 'labels', 'storyPoints', 'parentId', 'epicId', 'sprintId', 'dueDate'];
const CSV_HEADER = ['key', 'type', 'title', 'status', 'priority', 'assignee', 'labels', 'storyPoints', 'parent', 'epic', 'sprint', 'dueDate', 'createdAt', 'resolvedAt'];
const DEFAULT_STATUSES = [
  { name: 'Backlog', category: 'backlog' },
  { name: 'Todo', category: 'unstarted' },
  { name: 'In Progress', category: 'started' },
  { name: 'In Review', category: 'started' },
  { name: 'Done', category: 'completed' },
];
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
};

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `scrypt$${salt}$${crypto.scryptSync(pw, salt, 64).toString('hex')}`;
}
function verifyPassword(pw, stored) {
  const [, salt, hex] = String(stored).split('$');
  const expected = Buffer.from(hex || '', 'hex');
  const actual = crypto.scryptSync(pw, salt || '', expected.length || 64);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
const byNum = (a, b) => Number(a.key.split('-').pop()) - Number(b.key.split('-').pop());

export function createServer({ dataFile, clock } = {}) {
  const nowDate = () => (clock ? new Date(clock()) : new Date());
  const nowIso = () => nowDate().toISOString();
  const state = loadState(dataFile);
  const persist = () => saveState(dataFile, state);
  const loginFailures = new Map();
  const routes = [];
  const R = (status, body, type) => ({ status, body, type });

  // ---------- lookups
  const userById = (id) => state.users.find((u) => u.id === id) || null;
  const userByName = (name) => {
    const n = String(name).toLowerCase();
    return state.users.find((u) => u.username.toLowerCase() === n) || null;
  };
  const userByParam = (p) => state.users.find((u) => u.id === p) || userByName(p) || null;
  const publicUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName });
  const wsById = (id) => state.workspaces.find((w) => w.id === id) || null;
  const projectById = (id) => state.projects.find((p) => p.id === id) || null;
  const sprintById = (id) => state.sprints.find((s) => s.id === id) || null;
  const issueById = (id) => state.issues.find((i) => i.id === id) || null;
  const membership = (wsId, uid) => state.workspaceMembers.find((m) => m.workspaceId === wsId && m.userId === uid) || null;
  const username = (uid) => userById(uid)?.username ?? '';
  const statusInfo = (p, name) => p.workflow.statuses.find((s) => s.name === name) || null;
  const categoryIn = (p, name) => statusInfo(p, name)?.category;
  const initialStatus = (p) => (p.workflow.statuses.find((s) => s.category === 'unstarted') || p.workflow.statuses[0]).name;
  const isDone = (issue) => categoryIn(projectById(issue.projectId), issue.status) === 'completed';
  const histOf = (issueId) => {
    const out = [];
    for (let k = state.history.length - 1; k >= 0; k--) if (state.history[k].issueId === issueId) out.push(state.history[k]);
    return out;
  };

  // ---------- access control
  function projectRole(userId, project) {
    const m = membership(project.workspaceId, userId);
    if (!m) return null;
    if (m.role === 'admin') return 'lead';
    const pm = state.projectMembers.find((x) => x.projectId === project.id && x.userId === userId);
    return pm ? pm.role : null;
  }
  function requireWs(user, wsId, roles) {
    const ws = wsById(wsId);
    if (!ws) throw notFound('Workspace not found');
    const m = membership(wsId, user.id);
    if (!m) throw forbidden('Not a member of this workspace');
    if (roles && !roles.includes(m.role)) throw forbidden('Insufficient workspace role');
    return { ws, role: m.role };
  }
  function requireProject(user, projectId, min = 'viewer') {
    const project = projectById(projectId);
    if (!project) throw notFound('Project not found');
    const role = projectRole(user.id, project);
    if (!role) throw forbidden('No access to this project');
    if (RANK[role] < RANK[min]) throw forbidden(`Requires project role ${min} or higher`);
    return { project, role };
  }
  function requireIssue(user, key, min = 'viewer') {
    const issue = state.issues.find((i) => i.key === key);
    if (!issue) throw notFound('Issue not found');
    const { project, role } = requireProject(user, issue.projectId, min);
    return { issue, project, role };
  }
  const requireSprint = (user, id, min = 'developer') => {
    const s = sprintById(id);
    if (!s) throw notFound('Sprint not found');
    return { sprint: s, ...requireProject(user, s.projectId, min) };
  };

  // ---------- domain helpers
  function audit(workspaceId, actorId, action, details = {}) {
    state.audit.push({ id: newId(), workspaceId, action, actorId, at: nowIso(), details });
  }
  function auditAllWorkspaces(userId, action, details) {
    for (const m of state.workspaceMembers.filter((x) => x.userId === userId)) audit(m.workspaceId, userId, action, details);
  }
  function notify(userIds, actorId, type, issue) {
    const project = projectById(issue.projectId);
    for (const uid of new Set(userIds)) {
      if (!uid || uid === actorId || !projectRole(uid, project)) continue;
      state.notifications.push({ id: newId(), userId: uid, type, issueKey: issue.key, actorId, at: nowIso(), read: false });
    }
  }
  function normField(project, field, v) {
    switch (field) {
      case 'type':
        if (!ISSUE_TYPES.includes(v)) throw bad('invalid type');
        return v;
      case 'title':
        return reqStr(v, 'title', 500);
      case 'description':
        return optStr(v, 'description', 20000);
      case 'status':
        if (typeof v !== 'string' || !statusInfo(project, v)) throw bad(`unknown status: ${v}`);
        return v;
      case 'priority':
        if (!PRIORITIES.includes(v)) throw bad('invalid priority');
        return v;
      case 'assigneeId': {
        if (v == null || v === '') return null;
        const u = userById(v);
        if (!u) throw bad('assigneeId does not reference a user');
        if (!projectRole(u.id, project)) throw bad('assignee has no access to this project');
        return u.id;
      }
      case 'labels':
        if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw bad('labels must be an array of strings');
        return [...new Set(v.map((s) => s.trim()).filter(Boolean))];
      case 'storyPoints':
        if (v == null) return null;
        if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw bad('storyPoints must be a non-negative number');
        return v;
      case 'parentId':
      case 'epicId':
      case 'sprintId':
        if (v == null || v === '') return null;
        if (typeof v !== 'string') throw bad(`${field} must be an id string`);
        return v;
      case 'dueDate':
        if (v == null || v === '') return null;
        if (!isDate(v)) throw bad('dueDate must be YYYY-MM-DD');
        return v;
      default:
        throw bad(`field not editable: ${field}`);
    }
  }
  function checkStructure(project, cand, existing) {
    if (cand.type === 'subtask') {
      if (!cand.parentId) throw bad('subtasks require a parentId');
      const parent = issueById(cand.parentId);
      if (!parent || parent.projectId !== project.id) throw bad('parentId must reference an issue in the same project');
      if (parent.type === 'subtask') throw bad('parent of a subtask must not be a subtask');
      if (existing && parent.id === existing.id) throw bad('issue cannot be its own parent');
      if (existing && state.issues.some((i) => i.parentId === existing.id)) throw bad('an issue with subtasks cannot become a subtask');
    } else if (cand.parentId) {
      throw bad(cand.type === 'epic' ? 'epics cannot have a parent' : 'only subtasks may have a parent');
    }
    if (cand.epicId) {
      const e = issueById(cand.epicId);
      if (!e || e.projectId !== project.id || e.type !== 'epic') throw bad('epicId must reference an epic in this project');
      if (existing && e.id === existing.id) throw bad('issue cannot be its own epic');
    }
    if (cand.sprintId) {
      const s = sprintById(cand.sprintId);
      if (!s || s.projectId !== project.id) throw bad('sprintId must reference a sprint in this project');
      if (s.state === 'completed' && (!existing || existing.sprintId !== cand.sprintId)) throw bad('cannot add issues to a completed sprint');
    }
  }
  function createIssue(project, actor, input) {
    const raw = {
      type: input.type,
      title: input.title,
      description: input.description,
      status: input.status ?? initialStatus(project),
      priority: input.priority ?? 'none',
      assigneeId: input.assigneeId,
      labels: input.labels ?? [],
      storyPoints: input.storyPoints,
      parentId: input.parentId,
      epicId: input.epicId,
      sprintId: input.sprintId,
      dueDate: input.dueDate,
    };
    if (raw.type == null) throw bad('type is required');
    if (raw.title == null) throw bad('title is required');
    const cand = {};
    for (const f of ISSUE_FIELDS) cand[f] = normField(project, f, raw[f]);
    checkStructure(project, cand, null);
    project.counter = (project.counter || 0) + 1;
    const t = nowIso();
    const watchers = new Set([actor.id]);
    if (cand.assigneeId) watchers.add(cand.assigneeId);
    const issue = {
      id: newId(),
      key: `${project.key}-${project.counter}`,
      projectId: project.id,
      ...cand,
      reporterId: actor.id,
      watchers: [...watchers],
      createdAt: t,
      updatedAt: t,
      resolvedAt: categoryIn(project, cand.status) === 'completed' ? t : null,
    };
    state.issues.push(issue);
    return issue;
  }
  // Applies field changes, records history, updates resolvedAt, notifies watchers.
  function applyChanges(issue, project, actor, changes) {
    const t = nowIso();
    const prevStatus = issue.status;
    const changed = [];
    for (const [field, to] of Object.entries(changes)) {
      const from = issue[field];
      if (JSON.stringify(from) === JSON.stringify(to)) continue;
      state.history.push({ id: newId(), issueId: issue.id, field, from, to, actorId: actor.id, at: t });
      issue[field] = to;
      changed.push(field);
    }
    if (!changed.length) return changed;
    if (changed.includes('status')) {
      const wasDone = categoryIn(project, prevStatus) === 'completed';
      const nowDone = categoryIn(project, issue.status) === 'completed';
      if (nowDone && !wasDone) issue.resolvedAt = t;
      if (!nowDone && wasDone) issue.resolvedAt = null;
    }
    if (changed.includes('assigneeId') && issue.assigneeId && !issue.watchers.includes(issue.assigneeId)) {
      issue.watchers.push(issue.assigneeId);
    }
    issue.updatedAt = t;
    if (changed.includes('status')) notify(issue.watchers, actor.id, 'status_changed', issue);
    if (changed.includes('assigneeId')) notify(issue.watchers, actor.id, 'assigned', issue);
    return changed;
  }
  function issueView(i) {
    return { ...i, labels: [...i.labels], watchers: [...i.watchers] };
  }
  function issueDetail(issue) {
    const children = state.issues.filter((i) => i.parentId === issue.id).sort(byNum).map((i) => i.key);
    const links = [];
    const ref = (id, type, o) => ({ id, type, key: o.key, title: o.title, status: o.status });
    for (const l of state.links) {
      if (l.from === issue.id) {
        const o = issueById(l.to);
        if (o) links.push(ref(l.id, l.type, o));
      } else if (l.to === issue.id) {
        const o = issueById(l.from);
        if (o) links.push(ref(l.id, INVERSE[l.type], o));
      }
    }
    const out = {
      ...issueView(issue),
      parentKey: issueById(issue.parentId)?.key ?? null,
      epicKey: issueById(issue.epicId)?.key ?? null,
      children,
      links,
    };
    if (issue.type === 'epic') {
      const members = state.issues.filter((i) => i.epicId === issue.id);
      const done = members.filter(isDone);
      out.progress = {
        total: members.length,
        done: done.length,
        points_total: members.reduce((a, i) => a + (i.storyPoints || 0), 0),
        points_done: done.reduce((a, i) => a + (i.storyPoints || 0), 0),
      };
    }
    return out;
  }
  async function emit(project, event, issue, actorId) {
    const hooks = state.webhooks.filter((w) => w.projectId === project.id && w.events.includes(event));
    await Promise.all(hooks.map((h) => deliver(h, event, issue, actorId)));
  }
  async function deliver(h, event, issue, actorId) {
    const at = nowIso();
    const body = JSON.stringify({ event, issue, actorId, at });
    const sig = `sha256=${crypto.createHmac('sha256', h.secret).update(body).digest('hex')}`;
    const d = { id: newId(), webhookId: h.id, event, status: null, attempts: 0, lastError: null, at };
    state.deliveries.push(d);
    for (let attempt = 1; attempt <= 3; attempt++) {
      d.attempts = attempt;
      try {
        const r = await fetch(h.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-pm-event': event, 'X-PM-Signature': sig },
          body,
          signal: AbortSignal.timeout(2000),
        });
        await r.text().catch(() => {});
        d.status = r.status;
        if (r.ok) { d.lastError = null; return; }
        d.lastError = `HTTP ${r.status}`;
      } catch (e) {
        d.status = null;
        d.lastError = e?.message || String(e);
      }
    }
  }
  function sprintsActive(projectId) {
    return state.sprints.find((s) => s.projectId === projectId && s.state === 'active')?.id ?? null;
  }
  function isDateStr(v, field) {
    if (v == null) return null;
    if (!isDate(v)) throw bad(`${field} must be YYYY-MM-DD`);
    return v;
  }

  // ---------- auth
  function authenticate(req) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    if (!m) return null;
    const hash = sha(m[1].trim());
    const sess = state.sessions.find((s) => s.tokenHash === hash);
    if (sess) {
      const user = userById(sess.userId);
      return user ? { user } : null;
    }
    const tok = state.apiTokens.find((t) => t.tokenHash === hash);
    if (tok) {
      const user = userById(tok.userId);
      if (user) tok.lastUsedAt = nowIso();
      return user ? { user } : null;
    }
    return null;
  }

  const add = (method, pattern, handler, auth = true) => {
    const names = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; })}$`);
    routes.push({ method, re, names, handler, auth });
  };

  // ---------- routes: auth
  add('POST', '/api/auth/register', ({ json }) => {
    const b = json();
    const username = reqStr(b.username, 'username', 32);
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) throw bad('username must be 3-32 characters [A-Za-z0-9_.-]');
    const password = b.password;
    if (typeof password !== 'string' || password.length < 8) throw bad('password must be at least 8 characters');
    if (password.length > 200) throw bad('password is too long');
    const displayName = b.displayName == null ? username : reqStr(b.displayName, 'displayName', 100);
    if (userByName(username)) throw conflict('username already taken');
    const user = { id: newId(), username, displayName, passwordHash: hashPassword(password), createdAt: nowIso() };
    state.users.push(user);
    return R(201, { user: publicUser(user) });
  }, false);

  add('POST', '/api/auth/login', ({ json }) => {
    const b = json();
    const username = typeof b.username === 'string' ? b.username : '';
    const password = typeof b.password === 'string' ? b.password : '';
    if (!username || !password) throw bad('username and password are required');
    const key = username.toLowerCase();
    const t = nowDate().getTime();
    const recent = (loginFailures.get(key) || []).filter((x) => t - x < 15 * 60000);
    loginFailures.set(key, recent);
    if (recent.length >= 5) throw new HttpError(429, 'rate_limited', 'Too many failed login attempts; try again later');
    const user = userByName(username);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      recent.push(t);
      throw unauth('Invalid username or password');
    }
    loginFailures.delete(key);
    const token = crypto.randomBytes(32).toString('base64url');
    state.sessions.push({ tokenHash: sha(token), userId: user.id, createdAt: nowIso() });
    return R(200, { token, user: publicUser(user) });
  }, false);

  add('POST', '/api/auth/logout', ({ req, user }) => {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    if (m) {
      const h = sha(m[1].trim());
      state.sessions = state.sessions.filter((s) => s.tokenHash !== h);
    }
    return undefined;
  });

  add('GET', '/api/auth/me', ({ user }) => R(200, { user: publicUser(user) }));

  add('PATCH', '/api/auth/me', ({ user, json }) => {
    const b = json();
    if (typeof b.currentPassword !== 'string' || !b.currentPassword) throw bad('currentPassword is required');
    const u = userById(user.id);
    if (!verifyPassword(b.currentPassword, u.passwordHash)) throw forbidden('Current password is incorrect');
    if (b.displayName !== undefined) u.displayName = reqStr(b.displayName, 'displayName', 100);
    if (b.password !== undefined) {
      if (typeof b.password !== 'string' || b.password.length < 8) throw bad('password must be at least 8 characters');
      u.passwordHash = hashPassword(b.password);
    }
    return R(200, { user: publicUser(u) });
  });

  // ---------- personal API tokens
  add('POST', '/api/tokens', ({ user, json }) => {
    const b = json();
    const name = reqStr(b.name, 'name', 100);
    const token = `pat_${crypto.randomBytes(24).toString('base64url')}`;
    const rec = { id: newId(), userId: user.id, name, tokenHash: sha(token), createdAt: nowIso(), lastUsedAt: null };
    state.apiTokens.push(rec);
    auditAllWorkspaces(user.id, 'token.created', { tokenId: rec.id, name });
    return R(201, { id: rec.id, name, token });
  });
  add('GET', '/api/tokens', ({ user }) =>
    R(200, state.apiTokens.filter((t) => t.userId === user.id).map((t) => ({ id: t.id, name: t.name, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt }))));
  add('DELETE', '/api/tokens/:id', ({ user, params }) => {
    const t = state.apiTokens.find((x) => x.id === params.id);
    if (!t) throw notFound('Token not found');
    if (t.userId !== user.id) throw forbidden('Token belongs to another user');
    state.apiTokens = state.apiTokens.filter((x) => x.id !== t.id);
    auditAllWorkspaces(user.id, 'token.deleted', { tokenId: t.id });
    return undefined;
  });

  // ---------- workspaces & members
  add('POST', '/api/workspaces', ({ user, json }) => {
    const b = json();
    const name = reqStr(b.name, 'name', 100);
    if (typeof b.key !== 'string' || !/^[A-Z]{2,10}$/.test(b.key)) throw bad('key must be 2-10 uppercase letters');
    if (state.workspaces.some((w) => w.key === b.key)) throw conflict('workspace key already exists');
    const ws = { id: newId(), name, key: b.key, createdAt: nowIso() };
    state.workspaces.push(ws);
    state.workspaceMembers.push({ workspaceId: ws.id, userId: user.id, role: 'admin' });
    audit(ws.id, user.id, 'workspace.created', { name });
    return R(201, { ...ws, role: 'admin' });
  });
  add('GET', '/api/workspaces', ({ user }) =>
    R(200, state.workspaceMembers.filter((m) => m.userId === user.id).map((m) => ({ ...wsById(m.workspaceId), role: m.role }))));
  add('GET', '/api/workspaces/:id', ({ user, params }) => {
    const { ws, role } = requireWs(user, params.id);
    return R(200, { ...ws, role });
  });
  add('GET', '/api/workspaces/:id/members', ({ user, params }) => {
    requireWs(user, params.id);
    return R(200, state.workspaceMembers.filter((m) => m.workspaceId === params.id).map((m) => {
      const u = userById(m.userId);
      return { userId: u.id, username: u.username, displayName: u.displayName, role: m.role };
    }));
  });
  add('POST', '/api/workspaces/:id/members', ({ user, params, json }) => {
    requireWs(user, params.id, ['admin']);
    const b = json();
    const target = userByName(b.username ?? '');
    if (!target) throw notFound('User not found');
    if (!WS_ROLES.includes(b.role)) throw bad('role must be admin, member or guest');
    if (membership(params.id, target.id)) throw conflict('user is already a member');
    state.workspaceMembers.push({ workspaceId: params.id, userId: target.id, role: b.role });
    audit(params.id, user.id, 'membership.added', { username: target.username, role: b.role });
    return R(201, { userId: target.id, username: target.username, displayName: target.displayName, role: b.role });
  });
  const memberTarget = (wsId, param) => {
    const target = userByParam(param);
    const m = target && membership(wsId, target.id);
    if (!m) throw notFound('Member not found');
    return { target, m };
  };
  const adminCount = (wsId) => state.workspaceMembers.filter((m) => m.workspaceId === wsId && m.role === 'admin').length;
  add('PATCH', '/api/workspaces/:id/members/:user', ({ user, params, json }) => {
    requireWs(user, params.id, ['admin']);
    const b = json();
    if (!WS_ROLES.includes(b.role)) throw bad('role must be admin, member or guest');
    const { target, m } = memberTarget(params.id, params.user);
    if (m.role === 'admin' && b.role !== 'admin' && adminCount(params.id) <= 1) throw bad('cannot demote the last admin');
    const from = m.role;
    m.role = b.role;
    audit(params.id, user.id, 'membership.role_changed', { username: target.username, from, to: b.role });
    return R(200, { userId: target.id, username: target.username, displayName: target.displayName, role: m.role });
  });
  add('DELETE', '/api/workspaces/:id/members/:user', ({ user, params }) => {
    requireWs(user, params.id, ['admin']);
    const { target, m } = memberTarget(params.id, params.user);
    if (m.role === 'admin' && adminCount(params.id) <= 1) throw bad('cannot remove the last admin');
    state.workspaceMembers = state.workspaceMembers.filter((x) => x !== m);
    const projIds = state.projects.filter((p) => p.workspaceId === params.id).map((p) => p.id);
    state.projectMembers = state.projectMembers.filter((x) => !(x.userId === target.id && projIds.includes(x.projectId)));
    audit(params.id, user.id, 'membership.removed', { username: target.username });
    return undefined;
  });
  add('GET', '/api/workspaces/:id/audit', ({ user, params }) => {
    requireWs(user, params.id, ['admin']);
    return R(200, state.audit.filter((a) => a.workspaceId === params.id));
  });

  // ---------- projects & workflows
  const projectView = (p) => ({
    id: p.id, workspaceId: p.workspaceId, name: p.name, key: p.key, createdAt: p.createdAt,
    workflow: { statuses: p.workflow.statuses.map((s) => ({ ...s })), transitions: p.workflow.transitions.map((t) => [...t]) },
  });
  const allPairs = (names) => names.flatMap((a) => names.filter((b) => b !== a).map((b) => [a, b]));

  add('POST', '/api/workspaces/:id/projects', ({ user, params, json }) => {
    requireWs(user, params.id, ['admin', 'member']);
    const b = json();
    const name = reqStr(b.name, 'name', 100);
    if (typeof b.key !== 'string' || !/^[A-Z]{2,10}$/.test(b.key)) throw bad('key must be 2-10 uppercase letters');
    if (state.projects.some((p) => p.key === b.key)) throw conflict('project key already exists');
    const project = {
      id: newId(), workspaceId: params.id, name, key: b.key, createdAt: nowIso(), counter: 0,
      workflow: { statuses: DEFAULT_STATUSES.map((s) => ({ ...s })), transitions: allPairs(DEFAULT_STATUSES.map((s) => s.name)) },
    };
    state.projects.push(project);
    state.projectMembers.push({ projectId: project.id, userId: user.id, role: 'lead' });
    audit(params.id, user.id, 'project.created', { key: b.key });
    return R(201, projectView(project));
  });
  add('GET', '/api/workspaces/:id/projects', ({ user, params }) => {
    requireWs(user, params.id);
    return R(200, state.projects.filter((p) => p.workspaceId === params.id && projectRole(user.id, p)).map(projectView));
  });
  add('GET', '/api/projects/:id', ({ user, params }) => {
    const { project, role } = requireProject(user, params.id);
    const members = state.projectMembers.filter((m) => m.projectId === project.id).map((m) => ({
      userId: m.userId, username: username(m.userId), role: m.role,
    }));
    return R(200, { ...projectView(project), myRole: role, members });
  });
  add('PATCH', '/api/projects/:id', ({ user, params, json }) => {
    const { project } = requireProject(user, params.id, 'lead');
    const b = json();
    if (b.name !== undefined) project.name = reqStr(b.name, 'name', 100);
    audit(project.workspaceId, user.id, 'project.updated', { key: project.key });
    return R(200, projectView(project));
  });
  add('PUT', '/api/projects/:id/workflow', ({ user, params, json }) => {
    const { project } = requireProject(user, params.id, 'lead');
    const b = json();
    if (!Array.isArray(b.statuses) || b.statuses.length === 0) throw bad('statuses must be a non-empty array');
    const statuses = b.statuses.map((s) => {
      if (!isObj(s)) throw bad('each status must be an object');
      const name = reqStr(s.name, 'status name', 50).trim();
      if (!CATEGORIES.includes(s.category)) throw bad(`invalid category for ${name}`);
      return { name, category: s.category };
    });
    const names = statuses.map((s) => s.name);
    if (new Set(names).size !== names.length) throw bad('status names must be unique');
    if (!Array.isArray(b.transitions)) throw bad('transitions must be an array of [from, to] pairs');
    const transitions = b.transitions.map((t) => {
      if (!Array.isArray(t) || t.length !== 2 || !names.includes(t[0]) || !names.includes(t[1])) {
        throw bad('transitions must reference existing statuses');
      }
      return [t[0], t[1]];
    });
    const remap = b.remap == null ? {} : b.remap;
    if (!isObj(remap)) throw bad('remap must be an object');
    const removed = project.workflow.statuses.map((s) => s.name).filter((n) => !names.includes(n));
    const moves = [];
    for (const i of state.issues.filter((x) => x.projectId === project.id)) {
      if (!removed.includes(i.status)) continue;
      const target = remap[i.status];
      if (!target || !names.includes(target)) throw bad(`status "${i.status}" is in use and must be remapped to an existing status`);
      moves.push([i, target]);
    }
    project.workflow = { statuses, transitions };
    for (const [i, target] of moves) applyChanges(i, project, user, { status: target });
    audit(project.workspaceId, user.id, 'workflow.updated', { statuses: names, remapped: moves.length });
    return R(200, projectView(project));
  });

  add('GET', '/api/projects/:id/members', ({ user, params }) => {
    requireProject(user, params.id);
    return R(200, state.projectMembers.filter((m) => m.projectId === params.id).map((m) => ({ userId: m.userId, username: username(m.userId), role: m.role })));
  });
  add('POST', '/api/projects/:id/members', ({ user, params, json }) => {
    const { project } = requireProject(user, params.id, 'lead');
    const b = json();
    const target = userByParam(b.username ?? b.userId ?? '');
    if (!target) throw notFound('User not found');
    if (!membership(project.workspaceId, target.id)) throw bad('user is not a member of this workspace');
    if (!PROJ_ROLES.includes(b.role)) throw bad('role must be lead, developer or viewer');
    if (state.projectMembers.some((m) => m.projectId === project.id && m.userId === target.id)) throw conflict('user is already a project member');
    state.projectMembers.push({ projectId: project.id, userId: target.id, role: b.role });
    audit(project.workspaceId, user.id, 'project.member_added', { project: project.key, username: target.username, role: b.role });
    return R(201, { userId: target.id, username: target.username, role: b.role });
  });
  add('PATCH', '/api/projects/:id/members/:user', ({ user, params, json }) => {
    const { project } = requireProject(user, params.id, 'lead');
    const b = json();
    if (!PROJ_ROLES.includes(b.role)) throw bad('role must be lead, developer or viewer');
    const target = userByParam(params.user);
    const pm = target && state.projectMembers.find((m) => m.projectId === project.id && m.userId === target.id);
    if (!pm) throw notFound('Project member not found');
    pm.role = b.role;
    audit(project.workspaceId, user.id, 'project.member_role_changed', { project: project.key, username: target.username, role: b.role });
    return R(200, { userId: target.id, username: target.username, role: pm.role });
  });
  add('DELETE', '/api/projects/:id/members/:user', ({ user, params }) => {
    const { project } = requireProject(user, params.id, 'lead');
    const target = userByParam(params.user);
    if (!target || !state.projectMembers.some((m) => m.projectId === project.id && m.userId === target.id)) throw notFound('Project member not found');
    state.projectMembers = state.projectMembers.filter((m) => !(m.projectId === project.id && m.userId === target.id));
    audit(project.workspaceId, user.id, 'project.member_removed', { project: project.key, username: target.username });
    return undefined;
  });

  add('GET', '/api/projects/:id/stats', ({ user, params }) => {
    const { project } = requireProject(user, params.id);
    const issues = state.issues.filter((i) => i.projectId === project.id);
    return R(200, projectStats(issues, {
      histOf,
      categoryOf: (name) => categoryIn(project, name),
      username,
    }));
  });

  // ---------- issues
  add('POST', '/api/projects/:id/issues', async ({ user, params, json }) => {
    const { project } = requireProject(user, params.id, 'developer');
    const issue = createIssue(project, user, json());
    await emit(project, 'issue.created', issueView(issue), user.id);
    return R(201, issueDetail(issue));
  });
  add('GET', '/api/projects/:id/issues', ({ user, params }) => {
    const { project } = requireProject(user, params.id);
    return R(200, state.issues.filter((i) => i.projectId === project.id).sort(byNum).map(issueView));
  });
  add('GET', '/api/issues/:key', ({ user, params }) => {
    const { issue } = requireIssue(user, params.key);
    return R(200, issueDetail(issue));
  });
  add('PATCH', '/api/issues/:key', async ({ user, params, json }) => {
    const { issue, project } = requireIssue(user, params.key, 'developer');
    const b = json();
    const cand = {};
    for (const f of ISSUE_FIELDS) {
      if (!(f in b)) continue;
      if (f === 'title' || f === 'type' || f === 'status' || f === 'priority' || f === 'description' || f === 'assigneeId'
        || f === 'labels' || f === 'storyPoints' || f === 'parentId' || f === 'epicId' || f === 'sprintId' || f === 'dueDate') {
        cand[f] = normField(project, f, b[f]);
      }
    }
    const merged = { ...issueView(issue), ...cand };
    if (!('description' in cand)) merged.description = issue.description;
    checkStructure(project, merged, issue);
    if (cand.status !== undefined && cand.status !== issue.status) {
      const ok = project.workflow.transitions.some(([f, t]) => f === issue.status && t === cand.status);
      if (!ok) throw conflict(`transition ${issue.status} -> ${cand.status} is not allowed`, 'invalid_transition');
      if (categoryIn(project, cand.status) === 'completed') {
        const blockers = state.links
          .filter((l) => l.type === 'blocks' && l.to === issue.id)
          .map((l) => issueById(l.from))
          .filter((x) => x && !isDone(x));
        if (blockers.length) throw conflict(`blocked by unresolved issue ${blockers[0].key}`, 'blocked');
      }
    }
    const changed = applyChanges(issue, project, user, cand);
    if (changed.length) await emit(project, 'issue.updated', issueView(issue), user.id);
    return R(200, issueDetail(issue));
  });
  add('DELETE', '/api/issues/:key', async ({ user, params }) => {
    const { issue, project } = requireIssue(user, params.key, 'developer');
    const ids = new Set([issue.id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const i of state.issues) if (i.parentId && ids.has(i.parentId) && !ids.has(i.id)) { ids.add(i.id); grew = true; }
    }
    const victims = state.issues.filter((i) => ids.has(i.id));
    for (const v of victims) {
      const snapshot = issueView(v);
      state.issues = state.issues.filter((x) => x.id !== v.id);
      state.links = state.links.filter((l) => l.from !== v.id && l.to !== v.id);
      state.comments = state.comments.filter((c) => c.issueId !== v.id);
      for (const other of state.issues) {
        if (other.epicId === v.id) applyChanges(other, project, user, { epicId: null });
      }
      await emit(project, 'issue.deleted', snapshot, user.id);
    }
    return undefined;
  });
  add('GET', '/api/issues/:key/history', ({ user, params }) => {
    const { issue } = requireIssue(user, params.key);
    return R(200, histOf(issue.id).reverse().map((h) => ({ field: h.field, from: h.from, to: h.to, actorId: h.actorId, at: h.at })));
  });
  add('POST', '/api/issues/:key/watch', ({ user, params }) => {
    const { issue } = requireIssue(user, params.key);
    if (!issue.watchers.includes(user.id)) issue.watchers.push(user.id);
    return undefined;
  });
  add('DELETE', '/api/issues/:key/watch', ({ user, params }) => {
    const { issue } = requireIssue(user, params.key);
    issue.watchers = issue.watchers.filter((x) => x !== user.id);
    return undefined;
  });

  // ---------- links
  add('POST', '/api/issues/:key/links', ({ user, params, json }) => {
    const { issue } = requireIssue(user, params.key, 'developer');
    const b = json();
    if (!LINK_TYPES.includes(b.type)) throw bad('type must be blocks, relates or duplicates');
    const target = state.issues.find((i) => i.key === b.target);
    if (!target) throw notFound('Link target not found');
    if (target.id === issue.id) throw bad('an issue cannot link to itself');
    requireProject(user, target.projectId);
    if (state.links.some((l) => l.from === issue.id && l.to === target.id && l.type === b.type)) throw conflict('link already exists');
    const link = { id: newId(), from: issue.id, to: target.id, type: b.type };
    state.links.push(link);
    return R(201, { id: link.id, type: link.type, from: issue.key, to: target.key });
  });
  add('DELETE', '/api/issues/:key/links/:linkId', ({ user, params }) => {
    const { issue } = requireIssue(user, params.key, 'developer');
    const link = state.links.find((l) => l.id === params.linkId);
    if (!link || (link.from !== issue.id && link.to !== issue.id)) throw notFound('Link not found');
    state.links = state.links.filter((l) => l.id !== link.id);
    return undefined;
  });

  // ---------- comments & notifications
  const commentView = (c) => ({ id: c.id, issueId: c.issueId, issueKey: c.issueKey, authorId: c.authorId, body: c.body, createdAt: c.createdAt, updatedAt: c.updatedAt, edited: c.edited });
  add('POST', '/api/issues/:key/comments', async ({ user, params, json }) => {
    const { issue, project } = requireIssue(user, params.key);
    const body = reqStr(json().body, 'body', 10000);
    const c = { id: newId(), issueId: issue.id, issueKey: issue.key, authorId: user.id, body, createdAt: nowIso(), updatedAt: null, edited: false };
    state.comments.push(c);
    const mentioned = [...new Set([...body.matchAll(/(?:^|\s)@([A-Za-z0-9_.-]{3,32})/g)]
      .map((m) => m[1].replace(/[.-]+$/, ''))
      .map((n) => userByName(n))
      .filter(Boolean)
      .map((u) => u.id))];
    notify(mentioned, user.id, 'mention', issue);
    notify(issue.watchers.filter((w) => !mentioned.includes(w)), user.id, 'commented', issue);
    await emit(project, 'comment.created', issueView(issue), user.id);
    return R(201, commentView(c));
  });
  add('GET', '/api/issues/:key/comments', ({ user, params }) => {
    const { issue } = requireIssue(user, params.key);
    return R(200, state.comments.filter((c) => c.issueId === issue.id).map(commentView));
  });
  add('PATCH', '/api/comments/:id', ({ user, params, json }) => {
    const c = state.comments.find((x) => x.id === params.id);
    if (!c) throw notFound('Comment not found');
    requireIssue(user, issueById(c.issueId).key);
    if (c.authorId !== user.id) throw forbidden('Only the author can edit this comment');
    c.body = reqStr(json().body, 'body', 10000);
    c.edited = true;
    c.updatedAt = nowIso();
    return R(200, commentView(c));
  });
  add('DELETE', '/api/comments/:id', ({ user, params }) => {
    const c = state.comments.find((x) => x.id === params.id);
    if (!c) throw notFound('Comment not found');
    const issue = issueById(c.issueId);
    const { role } = requireIssue(user, issue.key);
    if (c.authorId !== user.id && role !== 'lead') throw forbidden('Only the author or a lead can delete this comment');
    state.comments = state.comments.filter((x) => x.id !== c.id);
    return undefined;
  });
  add('GET', '/api/notifications', ({ user, query }) => {
    let list = state.notifications.filter((n) => n.userId === user.id);
    if (query.get('unread') === 'true') list = list.filter((n) => !n.read);
    list.sort((a, b) => b.at.localeCompare(a.at));
    return R(200, list.map((n) => ({ id: n.id, type: n.type, issueKey: n.issueKey, actorId: n.actorId, at: n.at, read: n.read })));
  });
  add('POST', '/api/notifications/read', ({ user, json }) => {
    const b = json();
    const mine = state.notifications.filter((n) => n.userId === user.id);
    if (b.all === true) mine.forEach((n) => { n.read = true; });
    else if (Array.isArray(b.ids)) {
      const ids = new Set(b.ids);
      mine.forEach((n) => { if (ids.has(n.id)) n.read = true; });
    } else throw bad('provide ids or all: true');
    return undefined;
  });

  // ---------- sprints
  add('POST', '/api/projects/:id/sprints', ({ user, params, json }) => {
    const { project } = requireProject(user, params.id, 'developer');
    const b = json();
    const name = reqStr(b.name, 'name', 100);
    const startDate = isDateStr(b.startDate, 'startDate');
    const endDate = isDateStr(b.endDate, 'endDate');
    if (startDate && endDate && endDate < startDate) throw bad('endDate must not be before startDate');
    const sprint = { id: newId(), projectId: project.id, name, state: 'planned', startDate, endDate, startedAt: null, completedAt: null, carriedOver: [] };
    state.sprints.push(sprint);
    return R(201, sprint);
  });
  add('GET', '/api/projects/:id/sprints', ({ user, params }) => {
    requireProject(user, params.id);
    return R(200, state.sprints.filter((s) => s.projectId === params.id));
  });
  add('POST', '/api/sprints/:id/start', ({ user, params }) => {
    const { sprint } = requireSprint(user, params.id);
    if (sprint.state !== 'planned') throw conflict('only planned sprints can be started', 'invalid_state');
    if (sprintsActive(sprint.projectId)) throw conflict('project already has an active sprint');
    sprint.state = 'active';
    sprint.startedAt = nowIso();
    return R(200, sprint);
  });
  add('POST', '/api/sprints/:id/complete', async ({ user, params, json }) => {
    const { sprint, project } = requireSprint(user, params.id);
    const b = json();
    if (sprint.state !== 'active') throw conflict('only active sprints can be completed', 'invalid_state');
    let target = null;
    if (b.carryOverTo != null && b.carryOverTo !== 'backlog') {
      const t = sprintById(b.carryOverTo);
      if (!t || t.projectId !== project.id || t.state === 'completed') throw bad('carryOverTo must be "backlog" or an open sprint in this project');
      target = t.id;
    }
    const unfinished = state.issues.filter((i) => i.sprintId === sprint.id && !isDone(i)).sort(byNum);
    for (const i of unfinished) applyChanges(i, project, user, { sprintId: target });
    sprint.carriedOver = unfinished.map((i) => i.key);
    sprint.state = 'completed';
    sprint.completedAt = nowIso();
    return R(200, sprint);
  });
  add('GET', '/api/sprints/:id/report', ({ user, params }) => {
    const { sprint, project } = requireSprint(user, params.id, 'viewer');
    const issues = state.issues.filter((i) => i.projectId === project.id);
    return R(200, sprintReport(sprint, { issues, histOf, isDone: (s) => categoryIn(project, s) === 'completed', now: nowDate().getTime() }));
  });

  // ---------- search
  add('GET', '/api/search', ({ user, query }) => {
    const clauses = parseQuery(query.get('q') || '');
    const sort = query.get('sort') || 'updated';
    if (!['updated', 'created', 'priority'].includes(sort)) throw bad('sort must be updated, created or priority');
    let visible = state.projects.filter((p) => projectRole(user.id, p));
    const pj = query.get('project');
    if (pj) {
      const p = state.projects.find((x) => x.id === pj || x.key === pj);
      if (!p) throw notFound('Project not found');
      if (!projectRole(user.id, p)) throw forbidden('No access to this project');
      visible = [p];
    }
    const ids = new Set(visible.map((p) => p.id));
    const match = buildMatcher(clauses, {
      meId: user.id,
      userByName,
      activeSprintOf: sprintsActive,
    });
    const results = state.issues.filter((i) => ids.has(i.projectId) && match(i));
    if (sort === 'updated') results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    else if (sort === 'created') results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    else results.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.updatedAt.localeCompare(a.updatedAt));
    return R(200, results.map(issueView));
  });

  // ---------- CSV import / export
  add('GET', '/api/projects/:id/export.csv', ({ user, params }) => {
    const { project } = requireProject(user, params.id);
    const issues = state.issues.filter((i) => i.projectId === project.id).sort(byNum);
    const rows = [CSV_HEADER, ...issues.map((i) => [
      i.key, i.type, i.title, i.status, i.priority, username(i.assigneeId) || '',
      i.labels.join(';'), i.storyPoints ?? '', issueById(i.parentId)?.key ?? '', issueById(i.epicId)?.key ?? '',
      sprintById(i.sprintId)?.name ?? '', i.dueDate ?? '', i.createdAt, i.resolvedAt ?? '',
    ])];
    return R(200, formatCSV(rows), 'text/csv; charset=utf-8');
  });
  add('POST', '/api/projects/:id/import.csv', async ({ user, params, raw }) => {
    const { project } = requireProject(user, params.id, 'developer');
    let rows;
    try {
      rows = parseCSV(raw.replace(/^﻿/, ''));
    } catch (e) {
      throw bad(`invalid CSV: ${e.message}`);
    }
    if (!rows.length) return R(200, { created: 0, errors: [] });
    const header = rows[0].map((h) => h.trim().toLowerCase());
    for (const need of ['type', 'title']) if (!header.includes(need)) throw bad(`missing column: ${need}`);
    const errors = [];
    const created = [];
    for (let idx = 1; idx < rows.length; idx++) {
      const r = rows[idx];
      const line = idx + 1;
      if (r.every((c) => c.trim() === '')) continue;
      const col = (name) => {
        const k = header.indexOf(name);
        return k < 0 ? undefined : (r[k] ?? '').trim();
      };
      try {
        const input = { type: col('type')?.toLowerCase(), title: col('title') };
        const status = col('status'); if (status) input.status = status;
        const priority = col('priority'); if (priority) input.priority = priority.toLowerCase();
        const labels = col('labels'); if (labels) input.labels = labels.split(';').map((s) => s.trim()).filter(Boolean);
        const sp = col('storypoints'); if (sp) {
          if (Number.isNaN(Number(sp))) throw bad('invalid storyPoints');
          input.storyPoints = Number(sp);
        }
        const due = col('duedate'); if (due) input.dueDate = due;
        const assignee = col('assignee'); if (assignee) {
          const u = userByName(assignee);
          if (!u) throw bad(`unknown assignee: ${assignee}`);
          input.assigneeId = u.id;
        }
        const parent = col('parent'); if (parent) {
          const p = state.issues.find((i) => i.key === parent && i.projectId === project.id);
          if (!p) throw bad(`unknown parent: ${parent}`);
          input.parentId = p.id;
        }
        const epic = col('epic'); if (epic) {
          const e = state.issues.find((i) => i.key === epic && i.projectId === project.id);
          if (!e) throw bad(`unknown epic: ${epic}`);
          input.epicId = e.id;
        }
        const sprint = col('sprint'); if (sprint) {
          const s = state.sprints.find((x) => x.projectId === project.id && (x.name === sprint || x.id === sprint));
          if (!s) throw bad(`unknown sprint: ${sprint}`);
          input.sprintId = s.id;
        }
        created.push(createIssue(project, user, input));
      } catch (e) {
        if (e instanceof HttpError) errors.push({ line, message: e.message });
        else throw e;
      }
    }
    for (const i of created) await emit(project, 'issue.created', issueView(i), user.id);
    return R(200, { created: created.length, errors });
  });

  // ---------- webhooks
  add('POST', '/api/projects/:id/webhooks', ({ user, params, json }) => {
    const { project } = requireProject(user, params.id, 'lead');
    const b = json();
    let u;
    try { u = new URL(b.url); } catch { throw bad('url must be a valid http(s) URL'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw bad('url must be http or https');
    if (!Array.isArray(b.events) || b.events.length === 0 || b.events.some((e) => !EVENTS.includes(e))) {
      throw bad(`events must be a non-empty subset of ${EVENTS.join(', ')}`);
    }
    const secret = reqStr(b.secret, 'secret', 200);
    const hook = { id: newId(), projectId: project.id, url: b.url, events: [...new Set(b.events)], secret, active: true, createdAt: nowIso() };
    state.webhooks.push(hook);
    audit(project.workspaceId, user.id, 'webhook.created', { project: project.key, url: b.url });
    return R(201, { id: hook.id, projectId: hook.projectId, url: hook.url, events: hook.events, active: true, createdAt: hook.createdAt });
  });
  add('GET', '/api/projects/:id/webhooks', ({ user, params }) => {
    requireProject(user, params.id, 'lead');
    return R(200, state.webhooks.filter((w) => w.projectId === params.id).map((w) => ({
      id: w.id, projectId: w.projectId, url: w.url, events: w.events, active: w.active, createdAt: w.createdAt,
    })));
  });
  add('DELETE', '/api/webhooks/:id', ({ user, params }) => {
    const w = state.webhooks.find((x) => x.id === params.id);
    if (!w) throw notFound('Webhook not found');
    const { project } = requireProject(user, w.projectId, 'lead');
    state.webhooks = state.webhooks.filter((x) => x.id !== w.id);
    audit(project.workspaceId, user.id, 'webhook.deleted', { url: w.url });
    return undefined;
  });
  add('GET', '/api/webhooks/:id/deliveries', ({ user, params }) => {
    const w = state.webhooks.find((x) => x.id === params.id);
    if (!w) throw notFound('Webhook not found');
    requireProject(user, w.projectId, 'lead');
    return R(200, state.deliveries.filter((d) => d.webhookId === w.id).map((d) => ({
      id: d.id, event: d.event, status: d.status, attempts: d.attempts, lastError: d.lastError, at: d.at,
    })));
  });

  // ---------- HTTP plumbing
  function send(res, result) {
    if (!result) {
      res.writeHead(204);
      return res.end();
    }
    if (result.type) {
      res.writeHead(result.status, { 'content-type': result.type });
      return res.end(result.body);
    }
    const data = JSON.stringify(result.body);
    res.writeHead(result.status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
    res.end(data);
  }
  function sendError(res, status, error, message) {
    const data = JSON.stringify({ error, message });
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
    res.end(data);
  }
  function serveStatic(req, res, pathname) {
    if (req.method !== 'GET') return sendError(res, 405, 'method_not_allowed', 'Method not allowed');
    let rel = null;
    if (pathname === '/') rel = 'index.html';
    else if (pathname.startsWith('/static/')) rel = pathname.slice('/static/'.length);
    if (!rel) return sendError(res, 404, 'not_found', 'Not found');
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendError(res, 404, 'not_found', 'Not found');
    fs.readFile(file, (err, data) => {
      if (err) return sendError(res, 404, 'not_found', 'Not found');
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, url.pathname);
      let found = null;
      let pathFound = false;
      for (const r of routes) {
        const m = r.re.exec(url.pathname);
        if (!m) continue;
        pathFound = true;
        if (r.method === req.method) { found = { r, m }; break; }
      }
      if (!found) {
        await readRaw(req).catch(() => {});
        if (pathFound) throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
        throw notFound('No such route');
      }
      const { r, m } = found;
      const params = {};
      r.names.forEach((n, k) => { params[n] = decodeURIComponent(m[k + 1]); });
      const raw = await readRaw(req);
      const ctx = { req, params, query: url.searchParams, raw, json: () => parseJson(raw), user: null };
      if (r.auth) {
        const auth = authenticate(req);
        if (!auth) throw unauth();
        ctx.user = auth.user;
      }
      const result = await r.handler(ctx);
      if (req.method !== 'GET') persist();
      send(res, result);
    } catch (err) {
      if (err instanceof HttpError) return sendError(res, err.status, err.error, err.message);
      console.error(err);
      sendError(res, 500, 'internal', 'Internal server error');
    }
  });
  return server;
}
