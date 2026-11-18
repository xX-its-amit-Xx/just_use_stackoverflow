import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  ISSUE_TYPES, PRIORITIES, WS_ROLES, PROJ_ROLES, CATEGORIES, WEBHOOK_EVENTS, PROJECT_KEY_RE,
  HttpError, bad, unauthenticated, forbidden, notFound, conflict,
  newId, newToken, sha256, hashPassword, verifyPassword, validDate,
  readBody, sendJson, sendError,
} from './util.js';
import { parseCsv, toCsv } from './csv.js';
import { parseQuery, compileTerms } from './search.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(here, 'static');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
const PRIO_RANK = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
const ISSUE_FIELDS = ['type', 'title', 'description', 'status', 'priority', 'assigneeId', 'labels', 'storyPoints', 'parentId', 'epicId', 'sprintId', 'dueDate'];
const CSV_COLUMNS = ['key', 'type', 'title', 'status', 'priority', 'assignee', 'labels', 'storyPoints', 'parent', 'epic', 'sprint', 'dueDate', 'createdAt', 'resolvedAt'];
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;

function emptyDb() {
  return { users: [], sessions: [], apiTokens: [], workspaces: [], projects: [], issues: [], history: [], comments: [], links: [], notifications: [], sprints: [], webhooks: [], deliveries: [], audit: [] };
}

function loadDb(file) {
  const base = emptyDb();
  if (file && fs.existsSync(file)) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...base, ...parsed };
  }
  return base;
}

function saveDb(file, db) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, file);
}

function defaultWorkflow() {
  const statuses = [
    { name: 'Backlog', category: 'backlog' },
    { name: 'Todo', category: 'unstarted' },
    { name: 'In Progress', category: 'started' },
    { name: 'In Review', category: 'started' },
    { name: 'Done', category: 'completed' },
  ];
  return { statuses, transitions: allPairs(statuses.map((s) => s.name)) };
}

function allPairs(names) {
  const out = [];
  for (const a of names) for (const b of names) if (a !== b) out.push([a, b]);
  return out;
}

const day = (d) => d.toISOString().slice(0, 10);
const nextDay = (d) => new Date(Date.parse(`${d}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);

export function createServer({ dataFile, clock } = {}) {
  const db = loadDb(dataFile);
  const nowDate = () => (clock ? new Date(clock()) : new Date());
  const nowIso = () => nowDate().toISOString();
  const loginFailures = new Map();

  // ---------- lookup helpers ----------
  const userById = (id) => db.users.find((u) => u.id === id);
  const publicUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName });
  const wsById = (id) => db.workspaces.find((w) => w.id === id);
  const projById = (id) => db.projects.find((p) => p.id === id);
  const sprintById = (id) => db.sprints.find((s) => s.id === id);
  const issueByKey = (key) => db.issues.find((i) => i.key === String(key).toUpperCase());
  const wsRole = (ws, user) => (ws.members.find((m) => m.userId === user.id) || {}).role || null;
  const roleFor = (project, user) => {
    const ws = wsById(project.workspaceId);
    if (ws && wsRole(ws, user) === 'admin') return 'lead';
    const m = project.members.find((x) => x.userId === user.id);
    return m ? m.role : null;
  };
  const catOf = (project, status) => (project.workflow.statuses.find((s) => s.name === status) || {}).category || 'backlog';
  const isDone = (issue, project) => catOf(project || projById(issue.projectId), issue.status) === 'completed';
  const usernameOf = (id) => (id && userById(id) ? userById(id).username : null);
  const activeSprintId = (projectId) => {
    const s = db.sprints.find((x) => x.projectId === projectId && x.state === 'active');
    return s ? s.id : null;
  };

  function requireWs(id, user, adminOnly = false) {
    const ws = wsById(id);
    if (!ws) throw notFound('workspace not found');
    const role = wsRole(ws, user);
    if (!role) throw forbidden('not a workspace member');
    if (adminOnly && role !== 'admin') throw forbidden('workspace admin required');
    return { ws, role };
  }

  function requireProject(id, user, roles) {
    const project = projById(id);
    if (!project) throw notFound('project not found');
    const role = roleFor(project, user);
    if (!role) throw forbidden('no access to project');
    if (roles && !roles.includes(role)) throw forbidden('insufficient project role');
    return { project, role };
  }

  function requireIssue(key, user, roles) {
    const issue = issueByKey(key);
    if (!issue) throw notFound('issue not found');
    const project = projById(issue.projectId);
    const role = roleFor(project, user);
    if (!role) throw forbidden('no access to project');
    if (roles && !roles.includes(role)) throw forbidden('insufficient project role');
    return { issue, project, role };
  }

  function requireSprint(id, user, roles) {
    const sprint = sprintById(id);
    if (!sprint) throw notFound('sprint not found');
    const { project, role } = requireProject(sprint.projectId, user, roles);
    return { sprint, project, role };
  }

  const audit = (wsId, action, actorId, details) => {
    db.audit.push({ id: newId(), workspaceId: wsId, action, actorId, details, at: nowIso() });
  };

  // ---------- views ----------
  const memberView = (m) => {
    const u = userById(m.userId);
    return { userId: m.userId, username: u ? u.username : null, displayName: u ? u.displayName : null, role: m.role };
  };
  const wsView = (ws, role) => ({ id: ws.id, name: ws.name, key: ws.key, createdAt: ws.createdAt, role });
  const projectView = (p, user) => ({
    id: p.id, workspaceId: p.workspaceId, name: p.name, key: p.key, createdAt: p.createdAt,
    role: roleFor(p, user), workflow: p.workflow, members: p.members.map(memberView),
  });
  const issueView = (i) => ({
    id: i.id, key: i.key, projectId: i.projectId, type: i.type, title: i.title, description: i.description,
    status: i.status, priority: i.priority, assigneeId: i.assigneeId, reporterId: i.reporterId, labels: i.labels,
    storyPoints: i.storyPoints, parentId: i.parentId, epicId: i.epicId, sprintId: i.sprintId, dueDate: i.dueDate,
    watchers: i.watchers, createdAt: i.createdAt, updatedAt: i.updatedAt, resolvedAt: i.resolvedAt,
  });
  const linksFor = (issue) => {
    const out = [];
    for (const l of db.links) {
      if (l.sourceId === issue.id) {
        const t = db.issues.find((x) => x.id === l.targetId);
        if (t) out.push({ id: l.id, type: l.type, target: t.key });
      } else if (l.targetId === issue.id) {
        const s = db.issues.find((x) => x.id === l.sourceId);
        const inv = { blocks: 'blocked_by', duplicates: 'duplicated_by', relates: 'relates' }[l.type];
        if (s) out.push({ id: l.id, type: inv, target: s.key });
      }
    }
    return out;
  };
  const issueDetail = (issue) => {
    const v = issueView(issue);
    v.children = db.issues.filter((i) => i.parentId === issue.id).map((i) => i.key);
    v.links = linksFor(issue);
    if (issue.type === 'epic') {
      const project = projById(issue.projectId);
      const kids = db.issues.filter((i) => i.epicId === issue.id);
      const done = kids.filter((k) => isDone(k, project));
      v.progress = {
        total: kids.length,
        done: done.length,
        points_total: kids.reduce((a, k) => a + (k.storyPoints || 0), 0),
        points_done: done.reduce((a, k) => a + (k.storyPoints || 0), 0),
      };
    }
    return v;
  };

  // ---------- value reconstruction (for history / burndown) ----------
  function valueAt(issue, field, tMs) {
    const h = db.history.find((x) => x.issueId === issue.id && x.field === field && Date.parse(x.at) > tMs);
    return h ? h.from : issue[field];
  }

  // ---------- notifications / webhooks ----------
  function notify(userIds, type, issue, actorId) {
    const at = nowIso();
    const project = projById(issue.projectId);
    for (const uid of new Set(userIds)) {
      if (uid === actorId) continue;
      const u = userById(uid);
      if (!u || !roleFor(project, u)) continue;
      db.notifications.push({ id: newId(), userId: uid, type, issueKey: issue.key, actorId, at, read: false });
    }
  }

  async function deliver(hook, event, issue, actorId) {
    const at = nowIso();
    const body = JSON.stringify({ event, issue: issueView(issue), actorId, at });
    const sig = 'sha256=' + crypto.createHmac('sha256', hook.secret).update(body).digest('hex');
    const d = { id: newId(), webhookId: hook.id, event, status: null, attempts: 0, lastError: null, at };
    db.deliveries.push(d);
    for (let attempt = 1; attempt <= 3; attempt++) {
      d.attempts = attempt;
      try {
        const r = await fetch(hook.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-pm-signature': sig, 'x-pm-event': event },
          body,
          signal: AbortSignal.timeout(3000),
        });
        await r.arrayBuffer().catch(() => {});
        d.status = r.status;
        if (r.ok) { d.lastError = null; break; }
        d.lastError = `HTTP ${r.status}`;
      } catch (e) {
        d.status = null;
        d.lastError = String((e && e.message) || e);
      }
    }
  }

  async function emit(projectId, event, issue, actorId) {
    const hooks = db.webhooks.filter((h) => h.projectId === projectId && h.events.includes(event));
    for (const h of hooks) await deliver(h, event, issue, actorId);
  }

  // ---------- validation ----------
  function resolveIssueRef(project, ref) {
    const i = db.issues.find((x) => (x.id === ref || x.key === String(ref).toUpperCase()) && x.projectId === project.id);
    if (!i) throw bad(`issue ${ref} not found in project`);
    return i;
  }

  // Validates issue fields present in f. cur is the existing issue (null on create).
  function normalizeFields(project, f, cur) {
    const out = {};
    if ('type' in f) {
      if (!ISSUE_TYPES.includes(f.type)) throw bad('invalid type');
      out.type = f.type;
    }
    if ('title' in f) {
      if (typeof f.title !== 'string' || !f.title.trim()) throw bad('title is required');
      out.title = f.title.trim();
    }
    if ('description' in f) {
      if (f.description !== null && typeof f.description !== 'string') throw bad('invalid description');
      out.description = f.description ?? '';
    }
    if ('priority' in f) {
      if (!PRIORITIES.includes(f.priority)) throw bad('invalid priority');
      out.priority = f.priority;
    }
    if ('labels' in f) {
      if (!Array.isArray(f.labels) || f.labels.some((l) => typeof l !== 'string')) throw bad('labels must be an array of strings');
      out.labels = [...new Set(f.labels.map((l) => l.trim()).filter(Boolean))];
    }
    if ('storyPoints' in f) {
      if (f.storyPoints !== null && (typeof f.storyPoints !== 'number' || !(f.storyPoints >= 0))) throw bad('invalid storyPoints');
      out.storyPoints = f.storyPoints;
    }
    if ('dueDate' in f) {
      if (f.dueDate !== null && !validDate(f.dueDate)) throw bad('dueDate must be YYYY-MM-DD');
      out.dueDate = f.dueDate;
    }
    if ('assignee' in f && !('assigneeId' in f)) {
      if (f.assignee === null || f.assignee === '') out.assigneeId = null;
      else {
        const u = db.users.find((x) => x.username === f.assignee);
        if (!u) throw bad('unknown assignee');
        out.assigneeId = u.id;
      }
    }
    if ('assigneeId' in f) {
      if (f.assigneeId === null || f.assigneeId === '') out.assigneeId = null;
      else {
        if (!userById(f.assigneeId)) throw bad('unknown assignee');
        out.assigneeId = f.assigneeId;
      }
    }
    if (out.assigneeId) {
      if (!wsRole(wsById(project.workspaceId), { id: out.assigneeId })) throw bad('assignee is not a workspace member');
    }
    if ('sprintId' in f) {
      if (f.sprintId === null || f.sprintId === '') out.sprintId = null;
      else {
        const s = db.sprints.find((x) => x.id === f.sprintId && x.projectId === project.id);
        if (!s) throw bad('sprint not found in project');
        out.sprintId = s.id;
      }
    }
    if ('epicId' in f) {
      if (f.epicId === null || f.epicId === '') out.epicId = null;
      else {
        const e = resolveIssueRef(project, f.epicId);
        if (e.type !== 'epic') throw bad('epicId must reference an epic');
        out.epicId = e.id;
      }
    }
    if ('parentId' in f) {
      if (f.parentId === null || f.parentId === '') out.parentId = null;
      else {
        const p = resolveIssueRef(project, f.parentId);
        if (p.type === 'subtask') throw bad('parent cannot be a subtask');
        out.parentId = p.id;
      }
    }
    const effType = out.type ?? (cur ? cur.type : 'task');
    if (effType === 'subtask') {
      const effParent = 'parentId' in out ? out.parentId : cur ? cur.parentId : null;
      if (!effParent) throw bad('subtasks require a non-subtask parentId');
      if (cur && out.type === 'subtask' && db.issues.some((i) => i.parentId === cur.id)) {
        throw bad('an issue with subtasks cannot become a subtask');
      }
    } else {
      if (out.parentId) throw bad('only subtasks may have a parentId');
      out.parentId = null;
      if (effType === 'epic' && cur && 'parentId' in f && f.parentId) throw bad('epics cannot have parents');
    }
    return out;
  }

  function issueRoleCheckAndStatus(project, issue, newStatus) {
    const st = project.workflow.statuses.find((s) => s.name === newStatus);
    if (!st) throw bad('unknown status');
    const from = issue ? issue.status : null;
    if (issue && !project.workflow.transitions.some(([a, b]) => a === from && b === newStatus)) {
      throw conflict('invalid_transition', `cannot move from ${from} to ${newStatus}`);
    }
    if (st.category === 'completed' && issue) {
      const blockers = db.links.filter((l) => l.type === 'blocks' && l.targetId === issue.id)
        .map((l) => db.issues.find((x) => x.id === l.sourceId))
        .filter((s) => s && !isDone(s));
      if (blockers.length) throw conflict('blocked', `blocked by unresolved ${blockers.map((b) => b.key).join(', ')}`);
    }
    return st;
  }

  // ---------- auth ----------
  function authenticate(req) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    if (!m) throw unauthenticated();
    const hash = sha256(m[1].trim());
    const sess = db.sessions.find((s) => s.hash === hash);
    const tok = sess ? null : db.apiTokens.find((t) => t.hash === hash);
    if (!sess && !tok) throw unauthenticated('invalid token');
    const user = userById((sess || tok).userId);
    if (!user) throw unauthenticated('invalid token');
    return { user, session: sess || null };
  }

  // ---------- routing ----------
  const routes = [];
  function route(method, pattern, opts, fn) {
    const names = [];
    const re = new RegExp('^' + pattern.split('/').map((seg) => {
      if (seg.startsWith(':')) { names.push(seg.slice(1)); return '([^/]+)'; }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('/') + '$');
    routes.push({ method, re, names, auth: opts.auth !== false, raw: !!opts.raw, fn });
  }
  const R = (method, pattern, fn) => route(method, pattern, {}, fn);
  const RP = (method, pattern, fn) => route(method, pattern, { auth: false }, fn);

  // ----- auth & accounts -----
  RP('POST', '/api/auth/register', async ({ body }) => {
    const { username, password } = body || {};
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) throw bad('username must be 3-32 chars of letters, digits, _ . -');
    if (typeof password !== 'string' || password.length < 8) throw bad('password must be at least 8 characters');
    if (body.displayName !== undefined && (typeof body.displayName !== 'string' || !body.displayName.trim())) throw bad('invalid displayName');
    if (db.users.some((u) => u.username === username)) throw conflict('conflict', 'username taken');
    const user = { id: newId(), username, displayName: body.displayName ? body.displayName.trim() : username, passwordHash: hashPassword(password), createdAt: nowIso() };
    db.users.push(user);
    return { status: 201, body: { user: publicUser(user) } };
  });

  RP('POST', '/api/auth/login', async ({ body }) => {
    const { username, password } = body || {};
    if (typeof username !== 'string' || typeof password !== 'string') throw bad('username and password required');
    const nowMs = nowDate().getTime();
    const recent = (loginFailures.get(username) || []).filter((t) => nowMs - t < LOGIN_WINDOW_MS);
    loginFailures.set(username, recent);
    if (recent.length >= LOGIN_MAX_FAILURES) throw new HttpError(429, 'rate_limited', 'too many failed login attempts');
    const user = db.users.find((u) => u.username === username);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      recent.push(nowMs);
      throw new HttpError(401, 'invalid_credentials', 'invalid username or password');
    }
    loginFailures.delete(username);
    const token = newToken();
    db.sessions.push({ id: newId(), hash: sha256(token), userId: user.id, createdAt: nowIso() });
    return { body: { token, user: publicUser(user) } };
  });

  R('POST', '/api/auth/logout', async ({ session }) => {
    if (session) db.sessions = db.sessions.filter((s) => s.id !== session.id);
    return undefined;
  });

  R('GET', '/api/auth/me', async ({ user }) => ({ body: { user: publicUser(user) } }));

  R('PATCH', '/api/auth/me', async ({ user, body }) => {
    body = body || {};
    if (typeof body.currentPassword !== 'string') throw bad('currentPassword required');
    if (!verifyPassword(body.currentPassword, user.passwordHash)) throw forbidden('current password is incorrect');
    if (body.displayName !== undefined) {
      if (typeof body.displayName !== 'string' || !body.displayName.trim()) throw bad('invalid displayName');
      user.displayName = body.displayName.trim();
    }
    if (body.password !== undefined) {
      if (typeof body.password !== 'string' || body.password.length < 8) throw bad('password must be at least 8 characters');
      user.passwordHash = hashPassword(body.password);
    }
    return { body: { user: publicUser(user) } };
  });

  R('POST', '/api/tokens', async ({ user, body }) => {
    if (!body || typeof body.name !== 'string' || !body.name.trim()) throw bad('name required');
    const token = newToken();
    const rec = { id: newId(), userId: user.id, name: body.name.trim(), hash: sha256(token), createdAt: nowIso() };
    db.apiTokens.push(rec);
    for (const ws of db.workspaces) if (wsRole(ws, user) === 'admin') audit(ws.id, 'token.created', user.id, { tokenId: rec.id, name: rec.name });
    return { status: 201, body: { id: rec.id, name: rec.name, token } };
  });

  R('GET', '/api/tokens', async ({ user }) => ({
    body: db.apiTokens.filter((t) => t.userId === user.id).map((t) => ({ id: t.id, name: t.name, createdAt: t.createdAt })),
  }));

  R('DELETE', '/api/tokens/:id', async ({ user, params }) => {
    const t = db.apiTokens.find((x) => x.id === params.id && x.userId === user.id);
    if (!t) throw notFound('token not found');
    db.apiTokens = db.apiTokens.filter((x) => x.id !== t.id);
    for (const ws of db.workspaces) if (wsRole(ws, user) === 'admin') audit(ws.id, 'token.deleted', user.id, { tokenId: t.id });
    return undefined;
  });

  // ----- workspaces -----
  R('POST', '/api/workspaces', async ({ user, body }) => {
    const { name, key } = body || {};
    if (typeof name !== 'string' || !name.trim()) throw bad('name required');
    if (typeof key !== 'string' || !PROJECT_KEY_RE.test(key)) throw bad('key must be 2-10 uppercase letters');
    if (db.workspaces.some((w) => w.key === key)) throw conflict('conflict', 'workspace key taken');
    const ws = { id: newId(), name: name.trim(), key, createdAt: nowIso(), members: [{ userId: user.id, role: 'admin' }] };
    db.workspaces.push(ws);
    audit(ws.id, 'workspace.created', user.id, { key });
    return { status: 201, body: wsView(ws, 'admin') };
  });

  R('GET', '/api/workspaces', async ({ user }) => ({
    body: db.workspaces.filter((w) => wsRole(w, user)).map((w) => wsView(w, wsRole(w, user))),
  }));

  R('GET', '/api/workspaces/:id', async ({ user, params }) => {
    const { ws, role } = requireWs(params.id, user);
    return { body: { ...wsView(ws, role), members: ws.members.map(memberView) } };
  });

  R('PATCH', '/api/workspaces/:id', async ({ user, params, body }) => {
    const { ws } = requireWs(params.id, user, true);
    if (body && body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) throw bad('invalid name');
      ws.name = body.name.trim();
    }
    return { body: wsView(ws, 'admin') };
  });

  R('GET', '/api/workspaces/:id/members', async ({ user, params }) => {
    const { ws } = requireWs(params.id, user);
    return { body: ws.members.map(memberView) };
  });

  R('POST', '/api/workspaces/:id/members', async ({ user, params, body }) => {
    const { ws } = requireWs(params.id, user, true);
    const { username, role } = body || {};
    if (!WS_ROLES.includes(role)) throw bad('invalid role');
    const target = db.users.find((u) => u.username === username);
    if (!target) throw notFound('user not found');
    if (wsRole(ws, target)) throw conflict('conflict', 'already a member');
    ws.members.push({ userId: target.id, role });
    audit(ws.id, 'member.added', user.id, { userId: target.id, role });
    return { status: 201, body: memberView({ userId: target.id, role }) };
  });

  R('PATCH', '/api/workspaces/:id/members/:userId', async ({ user, params, body }) => {
    const { ws } = requireWs(params.id, user, true);
    const m = ws.members.find((x) => x.userId === params.userId);
    if (!m) throw notFound('member not found');
    const role = body && body.role;
    if (!WS_ROLES.includes(role)) throw bad('invalid role');
    if (m.role === 'admin' && role !== 'admin' && ws.members.filter((x) => x.role === 'admin').length <= 1) {
      throw bad('the last admin cannot be demoted');
    }
    const old = m.role;
    m.role = role;
    audit(ws.id, 'member.role_changed', user.id, { userId: m.userId, from: old, to: role });
    return { body: memberView(m) };
  });

  R('DELETE', '/api/workspaces/:id/members/:userId', async ({ user, params }) => {
    const { ws } = requireWs(params.id, user, true);
    const m = ws.members.find((x) => x.userId === params.userId);
    if (!m) throw notFound('member not found');
    if (m.role === 'admin' && ws.members.filter((x) => x.role === 'admin').length <= 1) {
      throw bad('the last admin cannot be removed');
    }
    ws.members = ws.members.filter((x) => x.userId !== m.userId);
    for (const p of db.projects) if (p.workspaceId === ws.id) p.members = p.members.filter((x) => x.userId !== m.userId);
    audit(ws.id, 'member.removed', user.id, { userId: m.userId });
    return undefined;
  });

  R('GET', '/api/workspaces/:id/projects', async ({ user, params }) => {
    const { ws } = requireWs(params.id, user);
    return { body: db.projects.filter((p) => p.workspaceId === ws.id && roleFor(p, user)).map((p) => projectView(p, user)) };
  });

  R('POST', '/api/workspaces/:id/projects', async ({ user, params, body }) => {
    const { ws, role } = requireWs(params.id, user);
    if (role === 'guest') throw forbidden('guests cannot create projects');
    const { name, key } = body || {};
    if (typeof name !== 'string' || !name.trim()) throw bad('name required');
    if (typeof key !== 'string' || !PROJECT_KEY_RE.test(key)) throw bad('key must be 2-10 uppercase letters');
    if (db.projects.some((p) => p.key === key)) throw conflict('conflict', 'project key taken');
    const p = {
      id: newId(), workspaceId: ws.id, name: name.trim(), key, createdAt: nowIso(),
      members: [{ userId: user.id, role: 'lead' }], workflow: defaultWorkflow(), nextNumber: 1,
    };
    db.projects.push(p);
    return { status: 201, body: projectView(p, user) };
  });

  R('GET', '/api/workspaces/:id/audit', async ({ user, params }) => {
    const { ws } = requireWs(params.id, user, true);
    return { body: db.audit.filter((a) => a.workspaceId === ws.id) };
  });

  // ----- projects -----
  R('GET', '/api/projects/:id', async ({ user, params }) => {
    const { project } = requireProject(params.id, user);
    return { body: projectView(project, user) };
  });

  R('PATCH', '/api/projects/:id', async ({ user, params, body }) => {
    const { project } = requireProject(params.id, user, ['lead']);
    if (body && body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) throw bad('invalid name');
      project.name = body.name.trim();
    }
    return { body: projectView(project, user) };
  });

  R('POST', '/api/projects/:id/members', async ({ user, params, body }) => {
    const { project } = requireProject(params.id, user, ['lead']);
    const { username, role } = body || {};
    if (!PROJ_ROLES.includes(role)) throw bad('invalid role');
    const target = db.users.find((u) => u.username === username);
    if (!target) throw notFound('user not found');
    if (!wsRole(wsById(project.workspaceId), target)) throw bad('user is not a workspace member');
    if (project.members.some((m) => m.userId === target.id)) throw conflict('conflict', 'already a project member');
    project.members.push({ userId: target.id, role });
    return { status: 201, body: memberView({ userId: target.id, role }) };
  });

  R('PATCH', '/api/projects/:id/members/:userId', async ({ user, params, body }) => {
    const { project } = requireProject(params.id, user, ['lead']);
    const m = project.members.find((x) => x.userId === params.userId);
    if (!m) throw notFound('member not found');
    if (!PROJ_ROLES.includes(body && body.role)) throw bad('invalid role');
    if (m.role === 'lead' && body.role !== 'lead' && project.members.filter((x) => x.role === 'lead').length <= 1) {
      throw bad('the last lead cannot be demoted');
    }
    m.role = body.role;
    return { body: memberView(m) };
  });

  R('DELETE', '/api/projects/:id/members/:userId', async ({ user, params }) => {
    const { project } = requireProject(params.id, user, ['lead']);
    const m = project.members.find((x) => x.userId === params.userId);
    if (!m) throw notFound('member not found');
    if (m.role === 'lead' && project.members.filter((x) => x.role === 'lead').length <= 1) {
      throw bad('the last lead cannot be removed');
    }
    project.members = project.members.filter((x) => x.userId !== m.userId);
    return undefined;
  });

  R('PUT', '/api/projects/:id/workflow', async ({ user, params, body }) => {
    const { project } = requireProject(params.id, user, ['lead']);
    const { statuses, transitions, remap = {} } = body || {};
    if (!Array.isArray(statuses) || statuses.length === 0) throw bad('statuses required');
    const names = [];
    const clean = statuses.map((s) => {
      if (!s || typeof s.name !== 'string' || !s.name.trim()) throw bad('invalid status name');
      if (!CATEGORIES.includes(s.category)) throw bad('invalid status category');
      const name = s.name.trim();
      if (names.includes(name)) throw bad('duplicate status name');
      names.push(name);
      return { name, category: s.category };
    });
    if (remap === null || typeof remap !== 'object' || Array.isArray(remap)) throw bad('remap must be an object');
    for (const v of Object.values(remap)) if (!names.includes(v)) throw bad('remap target is not a status');
    let trans;
    if (transitions === undefined) trans = allPairs(names);
    else {
      if (!Array.isArray(transitions)) throw bad('transitions must be an array');
      trans = transitions.map((t) => {
        if (!Array.isArray(t) || t.length !== 2 || !names.includes(t[0]) || !names.includes(t[1])) throw bad('invalid transition');
        return [t[0], t[1]];
      });
    }
    // Check in-use statuses that are removed are mapped.
    const projIssues = db.issues.filter((i) => i.projectId === project.id);
    const removed = project.workflow.statuses.map((s) => s.name).filter((n) => !names.includes(n));
    const plan = [];
    for (const issue of projIssues) {
      if (names.includes(issue.status)) continue;
      const target = remap[issue.status];
      if (!target) throw bad(`status "${issue.status}" is in use and must be remapped`);
      plan.push([issue, target]);
    }
    const at = nowIso();
    for (const [issue, target] of plan) {
      db.history.push({ id: newId(), issueId: issue.id, field: 'status', from: issue.status, to: target, actorId: user.id, at });
      issue.status = target;
      issue.updatedAt = at;
    }
    // Refresh resolvedAt for all issues against the new categories.
    for (const issue of projIssues) {
      const done = (clean.find((s) => s.name === issue.status) || {}).category === 'completed';
      if (done && !issue.resolvedAt) issue.resolvedAt = at;
      if (!done && issue.resolvedAt) issue.resolvedAt = null;
    }
    project.workflow = { statuses: clean, transitions: trans };
    audit(project.workspaceId, 'workflow.updated', user.id, { projectId: project.id, removed, remapped: plan.length });
    return { body: projectView(project, user) };
  });

  R('GET', '/api/projects/:id/stats', async ({ user, params }) => {
    const { project } = requireProject(params.id, user);
    const issues = db.issues.filter((i) => i.projectId === project.id);
    const byStatus = {};
    const byType = {};
    const byAssignee = {};
    for (const i of issues) {
      byStatus[i.status] = (byStatus[i.status] || 0) + 1;
      byType[i.type] = (byType[i.type] || 0) + 1;
      const a = usernameOf(i.assigneeId) || 'unassigned';
      byAssignee[a] = (byAssignee[a] || 0) + 1;
    }
    const cycles = [];
    for (const i of issues) {
      if (!i.resolvedAt) continue;
      const started = db.history
        .filter((h) => h.issueId === i.id && h.field === 'status' && catOf(project, h.to) === 'started')
        .sort((a, b) => a.at.localeCompare(b.at))[0];
      if (!started) continue;
      cycles.push((Date.parse(i.resolvedAt) - Date.parse(started.at)) / 3600000);
    }
    const avg = cycles.length ? Math.round((cycles.reduce((a, b) => a + b, 0) / cycles.length) * 100) / 100 : null;
    return { body: { total: issues.length, byStatus, byType, byAssignee, averageCycleTimeHours: avg } };
  });

  R('GET', '/api/projects/:id/issues', async ({ user, params }) => {
    const { project } = requireProject(params.id, user);
    return { body: db.issues.filter((i) => i.projectId === project.id).map(issueView) };
  });

  R('POST', '/api/projects/:id/issues', async ({ user, params, body }) => {
    const { project } = requireProject(params.id, user, ['lead', 'developer']);
    const f = body && typeof body === 'object' ? body : {};
    if (typeof f.title !== 'string') throw bad('title is required');
    const vals = normalizeFields(project, f, null);
    let status;
    if (f.status !== undefined) {
      issueRoleCheckAndStatus(project, null, f.status);
      status = f.status;
    } else {
      const first = project.workflow.statuses.find((s) => s.category === 'unstarted') || project.workflow.statuses[0];
      status = first.name;
    }
    const at = nowIso();
    const number = project.nextNumber || 1;
    project.nextNumber = number + 1;
    const issue = {
      id: newId(), key: `${project.key}-${number}`, projectId: project.id,
      type: vals.type || 'task', title: vals.title, description: vals.description ?? '', status,
      priority: vals.priority || 'none', assigneeId: vals.assigneeId ?? null, reporterId: user.id,
      labels: vals.labels || [], storyPoints: vals.storyPoints ?? null, parentId: vals.parentId ?? null,
      epicId: vals.epicId ?? null, sprintId: vals.sprintId ?? null, dueDate: vals.dueDate ?? null,
      watchers: [user.id], createdAt: at, updatedAt: at,
      resolvedAt: isDone({ status, projectId: project.id }, project) ? at : null,
    };
    if (issue.assigneeId && issue.assigneeId !== user.id) issue.watchers.push(issue.assigneeId);
    db.issues.push(issue);
    if (issue.assigneeId && issue.assigneeId !== user.id) notify([issue.assigneeId], 'issue.assigned', issue, user.id);
    await emit(project.id, 'issue.created', issue, user.id);
    return { status: 201, body: issueDetail(issue) };
  });

  R('POST', '/api/projects/:id/sprints', async ({ user, params, body }) => {
    const { project } = requireProject(params.id, user, ['lead', 'developer']);
    const { name, startDate = null, endDate = null } = body || {};
    if (typeof name !== 'string' || !name.trim()) throw bad('name required');
    if (startDate !== null && !validDate(startDate)) throw bad('invalid startDate');
    if (endDate !== null && !validDate(endDate)) throw bad('invalid endDate');
    if (startDate && endDate && endDate < startDate) throw bad('endDate before startDate');
    const sprint = { id: newId(), projectId: project.id, name: name.trim(), startDate, endDate, state: 'planned', createdAt: nowIso(), startedAt: null, completedAt: null, carriedOver: 0 };
    db.sprints.push(sprint);
    return { status: 201, body: sprint };
  });

  R('GET', '/api/projects/:id/sprints', async ({ user, params }) => {
    const { project } = requireProject(params.id, user);
    return { body: db.sprints.filter((s) => s.projectId === project.id) };
  });

  R('GET', '/api/projects/:id/export.csv', async ({ user, params }) => {
    const { project } = requireProject(params.id, user);
    const rows = db.issues.filter((i) => i.projectId === project.id).map((i) => {
      const parent = i.parentId ? db.issues.find((x) => x.id === i.parentId) : null;
      const epic = i.epicId ? db.issues.find((x) => x.id === i.epicId) : null;
      const sprint = i.sprintId ? sprintById(i.sprintId) : null;
      return [
        i.key, i.type, i.title, i.status, i.priority, usernameOf(i.assigneeId) || '', i.labels.join(';'),
        i.storyPoints ?? '', parent ? parent.key : '', epic ? epic.key : '', sprint ? sprint.name : '',
        i.dueDate || '', i.createdAt, i.resolvedAt || '',
      ];
    });
    return { raw: toCsv(CSV_COLUMNS, rows), type: 'text/csv; charset=utf-8' };
  });

  R('POST', '/api/projects/:id/import.csv', async ({ user, params, body }) => {
    const { project } = requireProject(params.id, user, ['lead', 'developer']);
    let records;
    try {
      records = parseCsv(typeof body === 'string' ? body : '');
    } catch (e) {
      throw bad(`invalid CSV: ${e.message}`);
    }
    if (!records.length) throw bad('CSV is empty');
    const header = records[0].fields.map((h) => h.trim().toLowerCase());
    if (!header.includes('title')) throw bad('CSV header must include title');
    const col = (fields, name) => {
      const idx = header.indexOf(name);
      return idx < 0 ? '' : (fields[idx] ?? '').trim();
    };
    const created = [];
    const errors = [];
    const keyMap = new Map(); // csv key -> new issue key
    const wsObj = wsById(project.workspaceId);
    const initial = project.workflow.statuses.find((s) => s.category === 'unstarted') || project.workflow.statuses[0];
    for (const rec of records.slice(1)) {
      const line = rec.line;
      const fail = (message) => errors.push({ line, message });
      try {
        const title = col(rec.fields, 'title');
        if (!title) throw new Error('title is required');
        const type = col(rec.fields, 'type') || 'task';
        if (!ISSUE_TYPES.includes(type)) throw new Error('invalid type');
        const priority = col(rec.fields, 'priority') || 'none';
        if (!PRIORITIES.includes(priority)) throw new Error('invalid priority');
        const status = col(rec.fields, 'status') || initial.name;
        if (!project.workflow.statuses.some((s) => s.name === status)) throw new Error(`unknown status ${status}`);
        const assigneeName = col(rec.fields, 'assignee');
        let assigneeId = null;
        if (assigneeName) {
          const u = db.users.find((x) => x.username === assigneeName);
          if (!u || !wsRole(wsObj, u)) throw new Error(`unknown assignee ${assigneeName}`);
          assigneeId = u.id;
        }
        const labelsRaw = col(rec.fields, 'labels');
        const labels = labelsRaw ? labelsRaw.split(';').map((l) => l.trim()).filter(Boolean) : [];
        const spRaw = col(rec.fields, 'storypoints');
        let storyPoints = null;
        if (spRaw !== '') {
          storyPoints = Number(spRaw);
          if (!Number.isFinite(storyPoints) || storyPoints < 0) throw new Error('invalid storyPoints');
        }
        const resolveRef = (raw) => {
          if (!raw) return null;
          const k = keyMap.get(raw) || raw;
          const found = db.issues.find((x) => x.projectId === project.id && x.key === k.toUpperCase());
          if (!found) throw new Error(`unknown reference ${raw}`);
          return found;
        };
        const parent = resolveRef(col(rec.fields, 'parent'));
        if (parent && parent.type === 'subtask') throw new Error('parent cannot be a subtask');
        const epic = resolveRef(col(rec.fields, 'epic'));
        if (epic && epic.type !== 'epic') throw new Error('epic must reference an epic');
        let sprintId = null;
        const sprintRaw = col(rec.fields, 'sprint');
        if (sprintRaw) {
          const s = db.sprints.find((x) => x.projectId === project.id && (x.name === sprintRaw || x.id === sprintRaw));
          if (!s) throw new Error(`unknown sprint ${sprintRaw}`);
          sprintId = s.id;
        }
        const dueDate = col(rec.fields, 'duedate') || null;
        if (dueDate && !validDate(dueDate)) throw new Error('dueDate must be YYYY-MM-DD');
        if (type === 'subtask' && !parent) throw new Error('subtasks require a parent');
        if (type !== 'subtask' && parent) throw new Error('only subtasks may have a parent');
        const at = nowIso();
        const number = project.nextNumber || 1;
        project.nextNumber = number + 1;
        const issue = {
          id: newId(), key: `${project.key}-${number}`, projectId: project.id, type, title, description: '',
          status, priority, assigneeId, reporterId: user.id, labels, storyPoints, parentId: parent ? parent.id : null,
          epicId: epic ? epic.id : null, sprintId, dueDate, watchers: [user.id], createdAt: at, updatedAt: at,
          resolvedAt: catOf(project, status) === 'completed' ? at : null,
        };
        if (assigneeId && assigneeId !== user.id) issue.watchers.push(assigneeId);
        db.issues.push(issue);
        const origKey = col(rec.fields, 'key');
        if (origKey) keyMap.set(origKey, issue.key);
        created.push(issue.key);
        await emit(project.id, 'issue.created', issue, user.id);
      } catch (e) {
        fail(e.message);
      }
    }
    return { body: { created: created.length, errors } };
  });

  // ----- webhooks -----
  R('POST', '/api/projects/:id/webhooks', async ({ user, params, body }) => {
    const { project } = requireProject(params.id, user, ['lead']);
    const { url, events, secret } = body || {};
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) throw bad('url must be http(s)');
    if (!Array.isArray(events) || !events.length || events.some((e) => !WEBHOOK_EVENTS.includes(e))) throw bad('invalid events');
    if (typeof secret !== 'string' || !secret) throw bad('secret required');
    const hook = { id: newId(), projectId: project.id, url, events: [...new Set(events)], secret, createdAt: nowIso() };
    db.webhooks.push(hook);
    audit(project.workspaceId, 'webhook.created', user.id, { projectId: project.id, webhookId: hook.id });
    return { status: 201, body: { id: hook.id, projectId: hook.projectId, url: hook.url, events: hook.events, createdAt: hook.createdAt } };
  });

  R('GET', '/api/projects/:id/webhooks', async ({ user, params }) => {
    const { project } = requireProject(params.id, user, ['lead']);
    return { body: db.webhooks.filter((h) => h.projectId === project.id).map((h) => ({ id: h.id, projectId: h.projectId, url: h.url, events: h.events, createdAt: h.createdAt })) };
  });

  const requireHook = (id, user) => {
    const hook = db.webhooks.find((h) => h.id === id);
    if (!hook) throw notFound('webhook not found');
    requireProject(hook.projectId, user, ['lead']);
    return hook;
  };

  R('DELETE', '/api/webhooks/:id', async ({ user, params }) => {
    const hook = requireHook(params.id, user);
    db.webhooks = db.webhooks.filter((h) => h.id !== hook.id);
    audit(projById(hook.projectId).workspaceId, 'webhook.deleted', user.id, { webhookId: hook.id });
    return undefined;
  });

  R('GET', '/api/webhooks/:id/deliveries', async ({ user, params }) => {
    const hook = requireHook(params.id, user);
    return { body: db.deliveries.filter((d) => d.webhookId === hook.id).map((d) => ({ id: d.id, event: d.event, status: d.status, attempts: d.attempts, lastError: d.lastError, at: d.at })) };
  });

  // ----- issues -----
  R('GET', '/api/issues/:key', async ({ user, params }) => {
    const { issue } = requireIssue(params.key, user);
    return { body: issueDetail(issue) };
  });

  R('PATCH', '/api/issues/:key', async ({ user, params, body }) => {
    const { issue, project } = requireIssue(params.key, user, ['lead', 'developer']);
    const f = body && typeof body === 'object' ? body : {};
    const vals = normalizeFields(project, f, issue);
    let newStatus;
    if ('status' in f && f.status !== issue.status) {
      issueRoleCheckAndStatus(project, issue, f.status);
      newStatus = f.status;
    }
    const at = nowIso();
    const changes = [];
    for (const field of Object.keys(vals)) {
      if (JSON.stringify(issue[field]) !== JSON.stringify(vals[field])) changes.push([field, issue[field], vals[field]]);
    }
    if (newStatus !== undefined) changes.push(['status', issue.status, newStatus]);
    if (!changes.length) return { body: issueDetail(issue) };
    for (const [field, from, to] of changes) {
      db.history.push({ id: newId(), issueId: issue.id, field, from, to, actorId: user.id, at });
      issue[field] = to;
    }
    if (newStatus !== undefined) {
      const done = catOf(project, newStatus) === 'completed';
      issue.resolvedAt = done ? issue.resolvedAt || at : null;
    }
    issue.updatedAt = at;
    const assigneeChange = changes.find((c) => c[0] === 'assigneeId');
    if (assigneeChange && issue.assigneeId && !issue.watchers.includes(issue.assigneeId)) issue.watchers.push(issue.assigneeId);
    if (newStatus !== undefined) notify(issue.watchers, 'issue.status_changed', issue, user.id);
    if (assigneeChange) notify(issue.watchers, 'issue.assigned', issue, user.id);
    await emit(project.id, 'issue.updated', issue, user.id);
    return { body: issueDetail(issue) };
  });

  R('DELETE', '/api/issues/:key', async ({ user, params }) => {
    const { issue, project } = requireIssue(params.key, user, ['lead', 'developer']);
    const doomed = [issue, ...db.issues.filter((i) => i.parentId === issue.id)];
    const ids = new Set(doomed.map((d) => d.id));
    for (const d of doomed) await emit(project.id, 'issue.deleted', d, user.id);
    db.issues = db.issues.filter((i) => !ids.has(i.id));
    db.history = db.history.filter((h) => !ids.has(h.issueId));
    db.comments = db.comments.filter((c) => !ids.has(c.issueId));
    db.links = db.links.filter((l) => !ids.has(l.sourceId) && !ids.has(l.targetId));
    for (const i of db.issues) if (i.epicId && ids.has(i.epicId)) i.epicId = null;
    return undefined;
  });

  R('GET', '/api/issues/:key/history', async ({ user, params }) => {
    const { issue } = requireIssue(params.key, user);
    return { body: db.history.filter((h) => h.issueId === issue.id).map((h) => ({ field: h.field, from: h.from, to: h.to, actorId: h.actorId, at: h.at })) };
  });

  R('POST', '/api/issues/:key/links', async ({ user, params, body }) => {
    const { issue, project } = requireIssue(params.key, user, ['lead', 'developer']);
    const { type, target } = body || {};
    if (!['blocks', 'relates', 'duplicates'].includes(type)) throw bad('invalid link type');
    if (typeof target !== 'string') throw bad('target required');
    const t = issueByKey(target);
    if (!t) throw notFound('target issue not found');
    if (!roleFor(projById(t.projectId), user)) throw forbidden('no access to target issue');
    if (t.id === issue.id) throw bad('an issue cannot link to itself');
    const dup = db.links.some((l) => l.type === type && ((l.sourceId === issue.id && l.targetId === t.id) || (type === 'relates' && l.sourceId === t.id && l.targetId === issue.id)));
    if (dup) throw conflict('conflict', 'link already exists');
    const link = { id: newId(), type, sourceId: issue.id, targetId: t.id, createdAt: nowIso() };
    db.links.push(link);
    return { status: 201, body: { id: link.id, type, source: issue.key, target: t.key } };
  });

  R('DELETE', '/api/issues/:key/links/:linkId', async ({ user, params }) => {
    const { issue } = requireIssue(params.key, user, ['lead', 'developer']);
    const l = db.links.find((x) => x.id === params.linkId && (x.sourceId === issue.id || x.targetId === issue.id));
    if (!l) throw notFound('link not found');
    db.links = db.links.filter((x) => x.id !== l.id);
    return undefined;
  });

  R('POST', '/api/issues/:key/watch', async ({ user, params }) => {
    const { issue } = requireIssue(params.key, user);
    if (!issue.watchers.includes(user.id)) issue.watchers.push(user.id);
    return { body: { watching: true, watchers: issue.watchers } };
  });

  R('DELETE', '/api/issues/:key/watch', async ({ user, params }) => {
    const { issue } = requireIssue(params.key, user);
    issue.watchers = issue.watchers.filter((w) => w !== user.id);
    return { body: { watching: false, watchers: issue.watchers } };
  });

  const commentView = (c) => ({ id: c.id, issueKey: c.issueKey, authorId: c.authorId, body: c.body, createdAt: c.createdAt, updatedAt: c.updatedAt, edited: c.edited });

  R('GET', '/api/issues/:key/comments', async ({ user, params }) => {
    const { issue } = requireIssue(params.key, user);
    return { body: db.comments.filter((c) => c.issueId === issue.id).map(commentView) };
  });

  R('POST', '/api/issues/:key/comments', async ({ user, params, body }) => {
    const { issue, project } = requireIssue(params.key, user);
    const text = body && body.body;
    if (typeof text !== 'string' || !text.trim()) throw bad('body required');
    const at = nowIso();
    const c = { id: newId(), issueId: issue.id, issueKey: issue.key, authorId: user.id, body: text, createdAt: at, updatedAt: at, edited: false };
    db.comments.push(c);
    const mentioned = [...new Set([...text.matchAll(/@([A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?)/g)].map((m) => m[1]))]
      .map((n) => db.users.find((u) => u.username === n))
      .filter((u) => u && roleFor(project, u));
    const mentionIds = mentioned.map((u) => u.id);
    notify(mentionIds, 'mention', issue, user.id);
    notify(issue.watchers.filter((w) => !mentionIds.includes(w)), 'comment.created', issue, user.id);
    await emit(project.id, 'comment.created', issue, user.id);
    return { status: 201, body: commentView(c) };
  });

  const requireComment = (id, user) => {
    const c = db.comments.find((x) => x.id === id);
    if (!c) throw notFound('comment not found');
    const issue = db.issues.find((i) => i.id === c.issueId);
    const role = roleFor(projById(issue.projectId), user);
    if (!role) throw forbidden('no access to project');
    return { c, role };
  };

  R('PATCH', '/api/comments/:id', async ({ user, params, body }) => {
    const { c } = requireComment(params.id, user);
    if (c.authorId !== user.id) throw forbidden('only the author can edit');
    const text = body && body.body;
    if (typeof text !== 'string' || !text.trim()) throw bad('body required');
    c.body = text;
    c.edited = true;
    c.updatedAt = nowIso();
    return { body: commentView(c) };
  });

  R('DELETE', '/api/comments/:id', async ({ user, params }) => {
    const { c, role } = requireComment(params.id, user);
    if (c.authorId !== user.id && role !== 'lead') throw forbidden('only the author or a lead can delete');
    db.comments = db.comments.filter((x) => x.id !== c.id);
    return undefined;
  });

  // ----- notifications -----
  R('GET', '/api/notifications', async ({ user, query }) => {
    let list = db.notifications.filter((n) => n.userId === user.id).reverse();
    if (query.get('unread') === 'true') list = list.filter((n) => !n.read);
    list.sort((a, b) => b.at.localeCompare(a.at));
    return { body: list.map((n) => ({ id: n.id, type: n.type, issueKey: n.issueKey, actorId: n.actorId, at: n.at, read: n.read })) };
  });

  R('POST', '/api/notifications/read', async ({ user, body }) => {
    const mine = db.notifications.filter((n) => n.userId === user.id);
    if (body && body.all === true) mine.forEach((n) => { n.read = true; });
    else if (body && Array.isArray(body.ids)) {
      const ids = new Set(body.ids);
      mine.filter((n) => ids.has(n.id)).forEach((n) => { n.read = true; });
    } else throw bad('ids or all required');
    return undefined;
  });

  // ----- sprints -----
  R('GET', '/api/sprints/:id', async ({ user, params }) => ({ body: requireSprint(params.id, user).sprint }));

  R('POST', '/api/sprints/:id/start', async ({ user, params }) => {
    const { sprint, project } = requireSprint(params.id, user, ['lead', 'developer']);
    if (sprint.state !== 'planned') throw conflict('invalid_state', 'sprint is not planned');
    if (activeSprintId(project.id)) throw conflict('conflict', 'another sprint is already active');
    const at = nowDate();
    sprint.state = 'active';
    sprint.startedAt = at.toISOString();
    if (!sprint.startDate) sprint.startDate = day(at);
    return { body: sprint };
  });

  R('POST', '/api/sprints/:id/complete', async ({ user, params, body }) => {
    const { sprint, project } = requireSprint(params.id, user, ['lead', 'developer']);
    if (sprint.state !== 'active') throw conflict('invalid_state', 'sprint is not active');
    const target = (body && body.carryOverTo) || 'backlog';
    let targetId = null;
    if (target !== 'backlog') {
      const t = db.sprints.find((s) => s.id === target && s.projectId === project.id);
      if (!t || t.state === 'completed') throw bad('carryOverTo must be "backlog" or an open sprint in this project');
      targetId = t.id;
    }
    const at = nowIso();
    let carried = 0;
    for (const issue of db.issues.filter((i) => i.sprintId === sprint.id && !isDone(i, project))) {
      db.history.push({ id: newId(), issueId: issue.id, field: 'sprintId', from: sprint.id, to: targetId, actorId: user.id, at });
      issue.sprintId = targetId;
      issue.updatedAt = at;
      carried++;
    }
    sprint.state = 'completed';
    sprint.completedAt = at;
    sprint.carriedOver = carried;
    return { body: sprint };
  });

  R('GET', '/api/sprints/:id/report', async ({ user, params }) => {
    const { sprint, project } = requireSprint(params.id, user);
    const nowMs = nowDate().getTime();
    const startMs = sprint.startedAt ? Date.parse(sprint.startedAt) : nowMs;
    const projIssues = db.issues.filter((i) => i.projectId === project.id);
    const pointsAt = (i, t) => valueAt(i, 'storyPoints', t) || 0;
    const inSprintAt = (i, t) => i.createdAt && Date.parse(i.createdAt) <= t && valueAt(i, 'sprintId', t) === sprint.id;
    const doneAt = (i, t) => catOf(project, valueAt(i, 'status', t)) === 'completed';

    const committed = projIssues.filter((i) => inSprintAt(i, startMs)).reduce((a, i) => a + pointsAt(i, startMs), 0);
    const members = projIssues.filter((i) => i.sprintId === sprint.id);
    const completedNow = members.filter((i) => isDone(i, project));
    const completedPoints = completedNow.reduce((a, i) => a + (i.storyPoints || 0), 0);

    const today = day(nowDate());
    const startDay = sprint.startDate || day(new Date(sprint.startedAt || sprint.createdAt));
    const last = sprint.endDate && sprint.endDate < today ? sprint.endDate : today;
    const burndown = [];
    for (let d = startDay; d <= last; d = nextDay(d)) {
      const t = Date.parse(`${d}T23:59:59.999Z`);
      const remaining = projIssues
        .filter((i) => i.createdAt && Date.parse(i.createdAt) <= t && valueAt(i, 'sprintId', t) === sprint.id && !doneAt(i, t))
        .reduce((a, i) => a + pointsAt(i, t), 0);
      burndown.push({ date: d, remainingPoints: remaining });
    }
    return {
      body: {
        committedPoints: committed,
        completedPoints,
        completedIssues: completedNow.length,
        carriedOver: sprint.carriedOver || 0,
        burndown,
      },
    };
  });

  // ----- search -----
  R('GET', '/api/search', async ({ user, query }) => {
    const q = query.get('q') || '';
    let preds;
    try {
      preds = compileTerms(parseQuery(q));
    } catch (e) {
      throw bad(`malformed query: ${e.message}`);
    }
    let projects = db.projects.filter((p) => roleFor(p, user));
    const pv = query.get('project');
    if (pv) {
      const p = db.projects.find((x) => x.id === pv || x.key === pv.toUpperCase());
      if (!p) throw notFound('project not found');
      if (!roleFor(p, user)) throw forbidden('no access to project');
      projects = [p];
    }
    const ids = new Set(projects.map((p) => p.id));
    const ctx = { user, isDone: (i) => isDone(i), usernameOf, activeSprintId };
    let list = db.issues.filter((i) => ids.has(i.projectId) && preds.every((p) => p(i, ctx)));
    const sort = query.get('sort') || 'updated';
    const cmpDesc = (a, b, f) => (a[f] < b[f] ? 1 : a[f] > b[f] ? -1 : 0);
    if (sort === 'updated') list.sort((a, b) => cmpDesc(a, b, 'updatedAt'));
    else if (sort === 'created') list.sort((a, b) => cmpDesc(a, b, 'createdAt'));
    else if (sort === 'priority') list.sort((a, b) => PRIO_RANK[a.priority] - PRIO_RANK[b.priority]);
    else throw bad('invalid sort');
    return { body: list.map(issueView) };
  });

  // ----- static / UI -----
  async function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/static\//, '');
    const file = path.normalize(path.join(STATIC_DIR, rel));
    if (!file.startsWith(STATIC_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return false;
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
    return true;
  }

  // ---------- dispatcher ----------
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if (req.method === 'GET' && (pathname === '/' || pathname.startsWith('/static/'))) {
      if (await serveStatic(res, pathname)) return;
    }
    let matched = null;
    let params = {};
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      matched = r;
      params = {};
      r.names.forEach((n, idx) => { params[n] = decodeURIComponent(m[idx + 1]); });
      break;
    }
    if (!matched) return sendError(res, 404, 'not_found', 'no such route');

    const raw = await readBody(req);
    let body;
    const ct = String(req.headers['content-type'] || '');
    if (ct.includes('text/csv')) body = raw;
    else if (raw.trim()) {
      try {
        body = JSON.parse(raw);
      } catch {
        return sendError(res, 400, 'validation_error', 'invalid JSON body');
      }
    }
    const ctx = { params, query: url.searchParams, body, user: null, session: null };
    if (matched.auth) Object.assign(ctx, authenticate(req));
    const result = await matched.fn(ctx);
    if (req.method !== 'GET') {
      if (dataFile) saveDb(dataFile, db);
    }
    if (result === undefined || result === null) return sendJson(res, 204);
    if (result.raw !== undefined) {
      res.writeHead(200, { 'content-type': result.type });
      return res.end(result.raw);
    }
    return sendJson(res, result.status || 200, result.body);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (err instanceof HttpError) return sendError(res, err.status, err.code, err.message);
      console.error(err);
      if (!res.headersSent) sendError(res, 500, 'internal', 'internal error');
    });
  });
  return server;
}
