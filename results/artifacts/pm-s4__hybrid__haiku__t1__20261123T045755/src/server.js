import http from 'node:http';
import { randomUUID, createHmac } from 'node:crypto';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { resolve as resolvePath, dirname, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, bad, unauthorized, forbidden, notFound, conflict, rateLimited } from './errors.js';
import { hashPassword, verifyPassword, sha256, newToken } from './crypto.js';
import { loadState, saveState } from './store.js';
import { compileQuery } from './search.js';
import { toCsv, parseCsv } from './csv.js';
import { isStr, isNonEmptyStr, validDate, dayRange } from './util.js';
import {
  WS_ROLES, PROJECT_ROLES, ROLE_RANK, TYPES, PRIORITIES, PRIORITY_RANK, CATEGORIES, LINK_TYPES, EVENTS,
  DEFAULT_STATUSES, TRACKED, defaultTransitions,
} from './constants.js';

const PUBLIC_DIR = resolvePath(dirname(fileURLToPath(import.meta.url)), 'public');
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
const KEY_RE = /^[A-Z]{2,10}$/;
const CSV_COLUMNS = ['key', 'type', 'title', 'status', 'priority', 'assignee', 'labels', 'storyPoints',
  'parent', 'epic', 'sprint', 'dueDate', 'createdAt', 'resolvedAt'];
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png',
};

const uuid = () => randomUUID();
const objBody = (ctx) => ctx.body ?? {};
const catOf = (project, status) => project.statuses.find((s) => s.name === status)?.category ?? 'backlog';
const sumPoints = (list) => list.reduce((s, i) => s + (i.storyPoints ?? 0), 0);
const round2 = (n) => Math.round(n * 100) / 100;

function normPoints(v) {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw bad('storyPoints must be a non-negative number or null');
  return v;
}

function normLabels(v) {
  if (!Array.isArray(v) || !v.every(isNonEmptyStr)) throw bad('labels must be an array of non-empty strings');
  return [...new Set(v.map((s) => s.trim()))];
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, payload, headers = {}) {
  if (status === 204) { res.writeHead(204); res.end(); return; }
  if (typeof payload === 'string') {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers });
    res.end(payload);
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(payload));
}

function sendError(res, err) {
  if (err instanceof HttpError) return send(res, err.status, { error: err.code, message: err.message });
  console.error(err);
  return send(res, 500, { error: 'internal_error', message: 'Internal server error' });
}

function serveStatic(path, res) {
  const rel = path === '/' ? 'index.html' : path.slice('/static/'.length);
  const file = resolvePath(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + sep) || !existsSync(file) || statSync(file).isDirectory()) {
    return send(res, 404, { error: 'not_found', message: 'Not found' });
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
}

export function createServer({ dataFile, clock = () => new Date() } = {}) {
  const state = loadState(dataFile);
  const nowIso = () => clock().toISOString();
  const todayStr = () => nowIso().slice(0, 10);
  const persist = () => saveState(dataFile, state);

  // ---------- lookups ----------
  const userById = (id) => state.users.find((u) => u.id === id);
  const userByName = (name) => state.users.find((u) => u.username === name);
  const userPub = (u) => ({ id: u.id, username: u.username, displayName: u.displayName });
  const wsById = (id) => state.workspaces.find((w) => w.id === id);
  const projById = (id) => state.projects.find((p) => p.id === id);
  const issueById = (id) => state.issues.find((i) => i.id === id);
  const issueByKey = (key) => state.issues.find((i) => i.key === String(key).toUpperCase());
  const sprintById = (id) => state.sprints.find((s) => s.id === id);
  const keyOf = (id) => (id ? issueById(id)?.key ?? '' : '');
  const projectIssues = (project) => state.issues
    .filter((i) => i.projectId === project.id)
    .sort((a, b) => Number(a.key.split('-').pop()) - Number(b.key.split('-').pop()));
  const isDone = (issue) => catOf(projById(issue.projectId), issue.status) === 'completed';

  // ---------- auth & access ----------
  function currentAuth(req) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    if (!m) return null;
    const hash = sha256(m[1].trim());
    const token = state.tokens.find((t) => t.hash === hash);
    if (!token) return null;
    const user = userById(token.userId);
    return user ? { user, token } : null;
  }

  function requireUser(ctx) {
    if (!ctx.auth) throw unauthorized();
    return ctx.auth.user;
  }

  function issueToken(user, kind, name) {
    const token = newToken();
    state.tokens.push({ id: uuid(), userId: user.id, name, kind, hash: sha256(token), createdAt: nowIso() });
    return token;
  }

  function audit(workspaceId, action, actorId, details = {}) {
    state.audit.push({ id: uuid(), workspaceId, action, actorId, at: nowIso(), details });
  }

  function wsRoleOf(ws, user) {
    return ws.members.find((m) => m.userId === user.id)?.role ?? null;
  }

  function requireWorkspace(id, user, needAdmin = false) {
    const ws = wsById(id);
    if (!ws) throw notFound('Workspace not found');
    const role = wsRoleOf(ws, user);
    if (!role) throw forbidden('Not a member of this workspace');
    if (needAdmin && role !== 'admin') throw forbidden('Workspace admin role required');
    return { ws, role };
  }

  // Effective project role: workspace admin => lead; explicit membership; workspace member => developer; guest => none.
  function roleFor(project, user) {
    const ws = wsById(project.workspaceId);
    const wr = ws && wsRoleOf(ws, user);
    if (!wr) return null;
    if (wr === 'admin') return 'lead';
    const pm = project.members.find((m) => m.userId === user.id);
    if (pm) return pm.role;
    if (wr === 'member') return 'developer';
    return null;
  }

  function requireProject(id, user, min = null) {
    const project = projById(id);
    if (!project) throw notFound('Project not found');
    const role = roleFor(project, user);
    if (!role) throw forbidden('No access to this project');
    if (min && ROLE_RANK[role] < ROLE_RANK[min]) throw forbidden(`Requires ${min} role on this project`);
    return { project, role };
  }

  function requireIssue(key, user, min = 'viewer') {
    const issue = issueByKey(key);
    if (!issue) throw notFound('Issue not found');
    const { project, role } = requireProject(issue.projectId, user, min);
    return { issue, project, role };
  }

  function requireSprint(id, user, min = 'viewer') {
    const sprint = sprintById(id);
    if (!sprint) throw notFound('Sprint not found');
    const { project, role } = requireProject(sprint.projectId, user, min);
    return { sprint, project, role };
  }

  function projView(project, user) {
    return {
      id: project.id,
      workspaceId: project.workspaceId,
      name: project.name,
      key: project.key,
      workflow: { statuses: project.statuses, transitions: project.transitions },
      members: project.members.flatMap((m) => {
        const u = userById(m.userId);
        return u ? [{ userId: u.id, username: u.username, role: m.role }] : [];
      }),
      role: user ? roleFor(project, user) : null,
      createdAt: project.createdAt,
    };
  }

  function wsView(ws, user) {
    return {
      id: ws.id,
      name: ws.name,
      key: ws.key,
      role: wsRoleOf(ws, user),
      members: ws.members.flatMap((m) => {
        const u = userById(m.userId);
        return u ? [{ userId: u.id, username: u.username, displayName: u.displayName, role: m.role }] : [];
      }),
      createdAt: ws.createdAt,
    };
  }

  // ---------- issue helpers ----------
  function issueOut(issue) {
    const { _initial, ...rest } = issue;
    return rest;
  }

  function linksOf(issue) {
    const inverse = { blocks: 'blocked_by', duplicates: 'duplicated_by', relates: 'relates' };
    const out = [];
    for (const l of state.links) {
      if (l.source === issue.id) out.push({ id: l.id, type: l.type, target: keyOf(l.target) });
      else if (l.target === issue.id) out.push({ id: l.id, type: inverse[l.type], target: keyOf(l.source) });
    }
    return out;
  }

  function issueDetail(issue) {
    const children = state.issues.filter((i) => i.parentId === issue.id).map((i) => i.key);
    const out = { ...issueOut(issue), children, links: linksOf(issue) };
    if (issue.type === 'epic') {
      const kids = state.issues.filter((i) => i.epicId === issue.id);
      const done = kids.filter(isDone);
      out.progress = {
        total: kids.length,
        done: done.length,
        points_total: sumPoints(kids),
        points_done: sumPoints(done),
      };
    }
    return out;
  }

  function isBlocked(issue) {
    return state.links.some((l) => {
      if (l.type !== 'blocks' || l.target !== issue.id) return false;
      const src = issueById(l.source);
      return !!src && !isDone(src);
    });
  }

  function addWatcher(issue, userId) {
    if (!issue.watchers.includes(userId)) issue.watchers.push(userId);
  }

  function notify(userIds, type, issue, actorId) {
    const at = nowIso();
    for (const uid of new Set(userIds)) {
      if (uid === actorId) continue;
      state.notifications.push({ id: uuid(), userId: uid, type, issueKey: issue.key, actorId, at, read: false });
    }
  }

  function syncResolved(issue, project, at) {
    const done = catOf(project, issue.status) === 'completed';
    if (done && !issue.resolvedAt) issue.resolvedAt = at;
    else if (!done && issue.resolvedAt) issue.resolvedAt = null;
  }

  function trackedOf(issue) {
    return Object.fromEntries(TRACKED.map((f) => [f, structuredClone(issue[f])]));
  }

  function resolveUserRef(project, b) {
    let u;
    if ('assigneeId' in b) {
      if (b.assigneeId == null) return null;
      u = userById(b.assigneeId);
    } else {
      if (b.assignee == null || b.assignee === '') return null;
      u = userByName(b.assignee);
    }
    if (!u || !roleFor(project, u)) throw bad('Assignee must be a user with access to this project');
    return u.id;
  }

  function issueRefInProject(project, ref) {
    if (!isStr(ref)) throw bad('Issue reference must be a string');
    const issue = state.issues.find((i) => i.projectId === project.id && (i.id === ref || i.key === ref.toUpperCase()));
    if (!issue) throw bad(`Issue "${ref}" not found in this project`);
    return issue;
  }

  function resolveSprint(project, ref) {
    const s = sprintById(ref);
    if (!s || s.projectId !== project.id) throw bad('Sprint not found in this project');
    if (s.state === 'completed') throw bad('Cannot assign issues to a completed sprint');
    return s;
  }

  // Validates the set of changed fields; returns only the fields present in b, normalized.
  function normalizeIssueFields(project, b) {
    const out = {};
    if ('title' in b) {
      if (!isNonEmptyStr(b.title) || b.title.length > 500) throw bad('title must be a non-empty string (max 500 chars)');
      out.title = b.title.trim();
    }
    if ('description' in b) {
      if (b.description !== null && !isStr(b.description)) throw bad('description must be a string');
      out.description = b.description ?? '';
    }
    if ('type' in b) {
      if (!TYPES.includes(b.type)) throw bad('Invalid type');
      out.type = b.type;
    }
    if ('priority' in b) {
      if (!PRIORITIES.includes(b.priority)) throw bad('Invalid priority');
      out.priority = b.priority;
    }
    if ('status' in b) {
      if (!project.statuses.some((s) => s.name === b.status)) throw bad(`Unknown status "${b.status}"`);
      out.status = b.status;
    }
    if ('labels' in b) out.labels = normLabels(b.labels);
    if ('storyPoints' in b) out.storyPoints = normPoints(b.storyPoints);
    if ('dueDate' in b) {
      if (b.dueDate !== null && !validDate(b.dueDate)) throw bad('dueDate must be YYYY-MM-DD or null');
      out.dueDate = b.dueDate;
    }
    if ('assigneeId' in b || 'assignee' in b) out.assigneeId = resolveUserRef(project, b);
    if ('parentId' in b) out.parentId = b.parentId == null ? null : issueRefInProject(project, b.parentId).id;
    if ('epicId' in b) {
      if (b.epicId == null) out.epicId = null;
      else {
        const e = issueRefInProject(project, b.epicId);
        if (e.type !== 'epic') throw bad('epicId must reference an epic');
        out.epicId = e.id;
      }
    }
    if ('sprintId' in b) out.sprintId = b.sprintId == null ? null : resolveSprint(project, b.sprintId).id;
    return out;
  }

  function checkHierarchy(merged, selfId) {
    if (merged.type === 'subtask') {
      if (!merged.parentId) throw bad('Subtasks require a parentId');
      if (merged.parentId === selfId) throw bad('An issue cannot be its own parent');
      if (issueById(merged.parentId)?.type === 'subtask') throw bad('A subtask cannot have a subtask parent');
      if (selfId && state.issues.some((i) => i.parentId === selfId)) {
        throw bad('An issue with subtasks cannot become a subtask');
      }
    } else if (merged.parentId) {
      throw bad('Only subtasks can have a parentId');
    }
    if (selfId && merged.epicId === selfId) throw bad('An issue cannot be its own epic');
  }

  function emit(project, event, issue, actorId) {
    const hooks = state.webhooks.filter((w) => w.projectId === project.id && w.events.includes(event));
    for (const wh of hooks) {
      const d = { id: uuid(), webhookId: wh.id, event, status: null, attempts: 0, lastError: null, at: nowIso() };
      state.deliveries.push(d);
      const body = JSON.stringify({ event, issue: issueOut(issue), actorId, at: nowIso() });
      deliver(wh, d, body);
    }
  }

  async function deliver(wh, d, body) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      d.attempts = attempt;
      try {
        const sig = 'sha256=' + createHmac('sha256', wh.secret).update(body).digest('hex');
        const r = await fetch(wh.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-pm-signature': sig, 'x-pm-event': d.event },
          body,
          signal: AbortSignal.timeout(5000),
        });
        await r.arrayBuffer().catch(() => {});
        d.status = r.status;
        if (r.ok) { d.lastError = null; break; }
        d.lastError = `HTTP ${r.status}`;
      } catch (e) {
        d.status = null;
        d.lastError = String(e?.message ?? e);
      }
    }
    persist();
  }

  // Creates an issue from a validated body. Used by the create route and CSV import.
  function createIssue(project, user, b) {
    if (!('title' in b)) throw bad('title is required');
    const fields = normalizeIssueFields(project, b);
    const merged = {
      type: 'task', description: '', status: project.statuses.find((s) => s.category === 'unstarted')?.name
        ?? project.statuses[0].name, priority: 'none', assigneeId: null, labels: [], storyPoints: null,
      parentId: null, epicId: null, sprintId: null, dueDate: null,
      ...fields,
    };
    checkHierarchy(merged, null);
    const at = nowIso();
    const issue = {
      id: uuid(),
      key: `${project.key}-${project.nextSeq}`,
      projectId: project.id,
      ...merged,
      reporterId: user.id,
      watchers: [],
      createdAt: at,
      updatedAt: at,
      resolvedAt: null,
    };
    project.nextSeq++;
    issue._initial = trackedOf(issue);
    addWatcher(issue, user.id);
    if (issue.assigneeId) addWatcher(issue, issue.assigneeId);
    syncResolved(issue, project, at);
    state.issues.push(issue);
    emit(project, 'issue.created', issue, user.id);
    return issue;
  }

  function stateAt(issue, atMs) {
    const s = structuredClone(issue._initial);
    for (const h of state.history) {
      if (h.issueId === issue.id && Date.parse(h.at) <= atMs) s[h.field] = h.to;
    }
    return s;
  }

  function startedAt(issue, project) {
    if (catOf(project, issue._initial.status) === 'started') return issue.createdAt;
    const h = state.history.find((x) => x.issueId === issue.id && x.field === 'status' && catOf(project, x.to) === 'started');
    return h ? h.at : null;
  }

  function makeEnv(user) {
    return {
      actor: user,
      userByName,
      sprintById,
      catOf: (i) => catOf(projById(i.projectId), i.status),
    };
  }

  // ---------- routes ----------
  const ROUTES = [];
  function add(method, pattern, handler) {
    const names = [];
    const src = pattern.replace(/\./g, '\\.').replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; });
    ROUTES.push({ method, re: new RegExp('^' + src + '$'), names, handler });
  }

  // --- auth ---
  add('POST', '/api/auth/register', (ctx) => {
    const b = objBody(ctx);
    if (!isStr(b.username) || !USERNAME_RE.test(b.username)) throw bad('username must be 3-32 chars: letters, digits, _ . -');
    if (!isStr(b.password) || b.password.length < 8) throw bad('password must be at least 8 characters');
    if (b.displayName != null && !isStr(b.displayName)) throw bad('displayName must be a string');
    if (userByName(b.username)) throw conflict('username_taken', 'Username already taken');
    const user = {
      id: uuid(),
      username: b.username,
      displayName: isNonEmptyStr(b.displayName) ? b.displayName.trim() : b.username,
      passwordHash: hashPassword(b.password),
      createdAt: nowIso(),
    };
    state.users.push(user);
    return [201, { user: userPub(user) }];
  });

  add('POST', '/api/auth/login', (ctx) => {
    const b = objBody(ctx);
    if (!isStr(b.username) || !isStr(b.password)) throw bad('username and password are required');
    const nowMs = clock().getTime();
    const recent = (state.loginFailures[b.username] || []).filter((t) => nowMs - t < LOGIN_WINDOW_MS);
    state.loginFailures[b.username] = recent;
    if (recent.length >= LOGIN_MAX_FAILURES) throw rateLimited('Too many failed login attempts; try again later');
    const user = userByName(b.username);
    if (!user || !verifyPassword(b.password, user.passwordHash)) {
      recent.push(nowMs);
      throw unauthorized('Invalid username or password');
    }
    delete state.loginFailures[b.username];
    const token = issueToken(user, 'session', 'session');
    return [200, { token, user: userPub(user) }];
  });

  add('POST', '/api/auth/logout', (ctx) => {
    requireUser(ctx);
    state.tokens = state.tokens.filter((t) => t.id !== ctx.auth.token.id);
    return [204];
  });

  add('GET', '/api/auth/me', (ctx) => [200, { user: userPub(requireUser(ctx)) }]);

  add('PATCH', '/api/auth/me', (ctx) => {
    const user = requireUser(ctx);
    const b = objBody(ctx);
    if (!isStr(b.currentPassword)) throw bad('currentPassword is required');
    if (!verifyPassword(b.currentPassword, user.passwordHash)) throw forbidden('Current password is incorrect');
    if (b.displayName !== undefined) {
      if (!isNonEmptyStr(b.displayName)) throw bad('displayName must be a non-empty string');
      user.displayName = b.displayName.trim();
    }
    if (b.password !== undefined) {
      if (!isStr(b.password) || b.password.length < 8) throw bad('password must be at least 8 characters');
      user.passwordHash = hashPassword(b.password);
    }
    return [200, { user: userPub(user) }];
  });

  // --- API tokens ---
  add('POST', '/api/tokens', (ctx) => {
    const user = requireUser(ctx);
    const b = objBody(ctx);
    if (!isNonEmptyStr(b.name)) throw bad('name is required');
    const token = issueToken(user, 'api', b.name.trim());
    const rec = state.tokens[state.tokens.length - 1];
    for (const ws of state.workspaces) {
      if (wsRoleOf(ws, user)) audit(ws.id, 'token.created', user.id, { tokenId: rec.id, name: rec.name });
    }
    return [201, { id: rec.id, name: rec.name, token }];
  });

  add('GET', '/api/tokens', (ctx) => {
    const user = requireUser(ctx);
    return [200, state.tokens.filter((t) => t.userId === user.id && t.kind === 'api')
      .map((t) => ({ id: t.id, name: t.name, createdAt: t.createdAt }))];
  });

  add('DELETE', '/api/tokens/:id', (ctx) => {
    const user = requireUser(ctx);
    const rec = state.tokens.find((t) => t.id === ctx.params.id && t.userId === user.id && t.kind === 'api');
    if (!rec) throw notFound('Token not found');
    state.tokens = state.tokens.filter((t) => t !== rec);
    for (const ws of state.workspaces) {
      if (wsRoleOf(ws, user)) audit(ws.id, 'token.deleted', user.id, { tokenId: rec.id });
    }
    return [204];
  });

  // --- workspaces ---
  add('POST', '/api/workspaces', (ctx) => {
    const user = requireUser(ctx);
    const b = objBody(ctx);
    if (!isNonEmptyStr(b.name)) throw bad('name is required');
    if (!isStr(b.key) || !KEY_RE.test(b.key)) throw bad('key must be 2-10 uppercase letters');
    if (state.workspaces.some((w) => w.key === b.key)) throw conflict('key_taken', 'Workspace key already in use');
    const at = nowIso();
    const ws = {
      id: uuid(), name: b.name.trim(), key: b.key,
      members: [{ userId: user.id, role: 'admin' }], createdAt: at, updatedAt: at,
    };
    state.workspaces.push(ws);
    audit(ws.id, 'workspace.created', user.id, {});
    return [201, wsView(ws, user)];
  });

  add('GET', '/api/workspaces', (ctx) => {
    const user = requireUser(ctx);
    return [200, state.workspaces.filter((w) => wsRoleOf(w, user)).map((w) => wsView(w, user))];
  });

  add('GET', '/api/workspaces/:id', (ctx) => {
    const user = requireUser(ctx);
    const { ws } = requireWorkspace(ctx.params.id, user);
    return [200, wsView(ws, user)];
  });

  add('POST', '/api/workspaces/:id/members', (ctx) => {
    const user = requireUser(ctx);
    const { ws } = requireWorkspace(ctx.params.id, user, true);
    const b = objBody(ctx);
    const target = isStr(b.username) ? userByName(b.username) : undefined;
    if (!target) throw notFound('User not found');
    if (!WS_ROLES.includes(b.role)) throw bad('role must be admin, member or guest');
    if (wsRoleOf(ws, target)) throw conflict('already_member', 'User is already a workspace member');
    ws.members.push({ userId: target.id, role: b.role });
    audit(ws.id, 'member.added', user.id, { username: target.username, role: b.role });
    return [201, { userId: target.id, username: target.username, role: b.role }];
  });

  add('PATCH', '/api/workspaces/:id/members/:username', (ctx) => {
    const user = requireUser(ctx);
    const { ws } = requireWorkspace(ctx.params.id, user, true);
    const target = userByName(ctx.params.username);
    const m = target && ws.members.find((x) => x.userId === target.id);
    if (!m) throw notFound('Member not found');
    const b = objBody(ctx);
    if (!WS_ROLES.includes(b.role)) throw bad('role must be admin, member or guest');
    const admins = ws.members.filter((x) => x.role === 'admin').length;
    if (m.role === 'admin' && b.role !== 'admin' && admins === 1) throw bad('Cannot demote the last admin');
    const from = m.role;
    m.role = b.role;
    audit(ws.id, 'member.role_changed', user.id, { username: target.username, from, to: b.role });
    return [200, { userId: target.id, username: target.username, role: b.role }];
  });

  add('DELETE', '/api/workspaces/:id/members/:username', (ctx) => {
    const user = requireUser(ctx);
    const { ws } = requireWorkspace(ctx.params.id, user, true);
    const target = userByName(ctx.params.username);
    const m = target && ws.members.find((x) => x.userId === target.id);
    if (!m) throw notFound('Member not found');
    const admins = ws.members.filter((x) => x.role === 'admin').length;
    if (m.role === 'admin' && admins === 1) throw bad('Cannot remove the last admin');
    ws.members = ws.members.filter((x) => x !== m);
    for (const p of state.projects) {
      if (p.workspaceId === ws.id) p.members = p.members.filter((x) => x.userId !== target.id);
    }
    audit(ws.id, 'member.removed', user.id, { username: target.username });
    return [204];
  });

  add('GET', '/api/workspaces/:id/audit', (ctx) => {
    const user = requireUser(ctx);
    const { ws } = requireWorkspace(ctx.params.id, user, true);
    return [200, state.audit.filter((a) => a.workspaceId === ws.id)];
  });

  // --- projects ---
  add('GET', '/api/workspaces/:id/projects', (ctx) => {
    const user = requireUser(ctx);
    const { ws } = requireWorkspace(ctx.params.id, user);
    return [200, state.projects.filter((p) => p.workspaceId === ws.id && roleFor(p, user))
      .map((p) => projView(p, user))];
  });

  add('POST', '/api/workspaces/:id/projects', (ctx) => {
    const user = requireUser(ctx);
    const { ws, role } = requireWorkspace(ctx.params.id, user);
    if (role === 'guest') throw forbidden('Guests cannot create projects');
    const b = objBody(ctx);
    if (!isNonEmptyStr(b.name)) throw bad('name is required');
    if (!isStr(b.key) || !KEY_RE.test(b.key)) throw bad('key must be 2-10 uppercase letters');
    if (state.projects.some((p) => p.key === b.key)) throw conflict('key_taken', 'Project key already in use');
    const at = nowIso();
    const project = {
      id: uuid(), workspaceId: ws.id, name: b.name.trim(), key: b.key,
      members: [{ userId: user.id, role: 'lead' }],
      statuses: DEFAULT_STATUSES.map((s) => ({ ...s })),
      transitions: defaultTransitions(DEFAULT_STATUSES),
      nextSeq: 1, createdAt: at, updatedAt: at,
    };
    state.projects.push(project);
    audit(ws.id, 'project.created', user.id, { projectId: project.id, key: project.key });
    return [201, projView(project, user)];
  });

  add('GET', '/api/projects/:id', (ctx) => {
    const user = requireUser(ctx);
    const { project } = requireProject(ctx.params.id, user);
    return [200, projView(project, user)];
  });

  add('PATCH', '/api/projects/:id', (ctx) => {
    const user = requireUser(ctx);
    const { project } = requireProject(ctx.params.id, user, 'lead');
    const b = objBody(ctx);
    if (!isNonEmptyStr(b.name)) throw bad('name must be a non-empty string');
    project.name = b.name.trim();
    project.updatedAt = nowIso();
    return [200, projView(project, user)];
  });

  add('POST', '/api/projects/:id/members', (ctx) => {
    const user = requireUser(ctx);
    const { project } = requireProject(ctx.params.id, user, 'lead');
    const b = objBody(ctx);
    const target = isStr(b.username) ? userByName(b.username) : undefined;
    if (!target) throw notFound('User not found');
    const ws = wsById(project.workspaceId);
    if (!wsRoleOf(ws, target)) throw bad('User must be a workspace member');
    if (!PROJECT_ROLES.includes(b.role)) throw bad('role must be lead, developer or viewer');
    if (project.members.some((m) => m.userId === target.id)) throw conflict('already_member', 'User already a project member');
    project.members.push({ userId: target.id, role: b.role });
    audit(ws.id, 'project.member.added', user.id, { projectId: project.id, username: target.username, role: b.role });
    return [201, { userId: target.id, username: target.username, role: b.role }];
  });

  add('PATCH', '/api/projects/:id/members/:username', (ctx) => {
    const user = requireUser(ctx);
    const { project } = requireProject(ctx.params.id, user, 'lead');
    const target = userByName(ctx.params.username);
    const m = target && project.members.find((x) => x.userId === target.id);
    if (!m) throw notFound('Project member not found');
    const b = objBody(ctx);
    if (!PROJECT_ROLES.includes(b.role)) throw bad('role must be lead, developer or viewer');
    const from = m.role;
    m.role = b.role;
    audit(project.workspaceId, 'project.member.role_changed', user.id, { projectId: project.id, username: target.username, from, to: b.role });
    return [200, { userId: target.id, username: target.username, role: b.role }];
  });

  add('DELETE', '/api/projects/:id/members/:username', (ctx) => {
    const user = requireUser(ctx);
    const { project } = requireProject(ctx.params.id, user, 'lead');
    const target = userByName(ctx.params.username);
    if (!target || !project.members.some((m) => m.userId === target.id)) throw notFound('Project member not found');
    project.members = project.members.filter((m) => m.userId !== target.id);
    audit(project.workspaceId, 'project.member.removed', user.id, { projectId: project.id, username: target.username });
    return [204];
  });

  add('PUT', '/api/projects/:id/workflow', (ctx) => {
    const user = requireUser(ctx);
    const { project } = requireProject(ctx.params.id, user, 'lead');
    const b = objBody(ctx);
    if (!Array.isArray(b.statuses) || b.statuses.length === 0) throw bad('statuses must be a non-empty array');
    const statuses = b.statuses.map((s) => {
      if (!s || !isNonEmptyStr(s.name) || !CATEGORIES.includes(s.category)) {
        throw bad('each status needs a name and a category (backlog|unstarted|started|completed)');
      }
      return { name: s.name.trim(), category: s.category };
    });
    const names = statuses.map((s) => s.name);
    if (new Set(names).size !== names.length) throw bad('status names must be unique');
    let transitions;
    if (b.transitions === undefined) transitions = defaultTransitions(statuses);
    else {
      if (!Array.isArray(b.transitions)) throw bad('transitions must be an array of [from, to] pairs');
      transitions = b.transitions.map((t) => {
        if (!Array.isArray(t) || t.length !== 2 || !names.includes(t[0]) || !names.includes(t[1])) {
          throw bad('transitions must reference existing statuses');
        }
        return [t[0], t[1]];
      });
    }
    const remap = b.remap ?? {};
    if (typeof remap !== 'object' || Array.isArray(remap)) throw bad('remap must be an object');
    const newNames = new Set(names);
    const removed = new Set(project.statuses.map((s) => s.name).filter((n) => !newNames.has(n)));
    const affected = state.issues.filter((i) => i.projectId === project.id && removed.has(i.status));
    for (const i of affected) {
      const to = remap[i.status];
      if (!isStr(to) || !newNames.has(to)) {
        throw bad(`Status "${i.status}" is in use and removed; provide remap.${i.status} to an existing status`);
      }
    }
    const at = nowIso();
    for (const i of affected) {
      state.history.push({ issueId: i.id, field: 'status', from: i.status, to: remap[i.status], actorId: user.id, at });
      i.status = remap[i.status];
      i.updatedAt = at;
    }
    project.statuses = statuses;
    project.transitions = transitions;
    project.updatedAt = at;
    for (const i of state.issues) if (i.projectId === project.id) syncResolved(i, project, at);
    audit(project.workspaceId, 'workflow.updated', user.id, { projectId: project.id, remapped: affected.length });
    return [200, projView(project, user)];
  });

  add('GET', '/api/projects/:id/issues', (ctx) => {
    const user = requireUser(ctx);
    const { project } = requireProject(ctx.params.id, user, 'viewer');
    return [200, projectIssues(project).map(issueOut)];
  });

  add('POST', '/api/projects/:id/issues', (ctx) => {
    const user = requireUser(ctx);
    const { project } = requireProject(ctx.params.id, user, 'developer');
    const issue = createIssue(project, user, objBody(ctx));
    return [201, issueOut(issue)];
  });

  add('GET', '/api/projects/:id/stats', (ctx) => {
    const user = requireUser(ctx);
    const { project } = requireProject(ctx.params.id, user, 'viewer');
    const issues = projectIssues(project);
    const byStatus = Object.fromEntries(project.statuses.map((s) => [s.name, 0]));
    const byType = Object.fromEntries(TYPES.map((t) => [t, 0]));
    const byAssignee = {};
    for (const i of issues) {
      byStatus[i.status] = (byStatus[i.status] ?? 0) + 1;
      byType[i.type]++;
      const name = i.assigneeId ? (userById(i.assigneeId)?.username ?? 'unknown') : 'unassigned';
      byAssignee[name] = (byAssignee[name] ?? 0) + 1;
    }
    const cycles = [];
    for (const i of issues) {
      if (!i.resolvedAt) continue;
      const s = startedAt(i, project);
      if (!s) continue;
      const h = (Date.parse(i.resolvedAt) - Date.parse(s)) / 3600000;
      if (h >= 0) cycles.push(h);
    }
    const avg = cycles.length ? round2(cycles.reduce((a, b) => a + b, 0) / cycles.length) : null;
    return [200, { total: issues.length, byStatus, byType, byAssignee, avgCycleTimeHours: avg, averageCycleTimeHours: avg }];
  });

  // --- issues ---
  add('GET', '/api/issues/:key', (ctx) => {
    const user = requireUser(ctx);
    const { issue } = requireIssue(ctx.params.key, user, 'viewer');
    return [200, issueDetail(issue)];
  });

  add('PATCH', '/api/issues/:key', (ctx) => {
    const user = requireUser(ctx);
    const { issue, project } = requireIssue(ctx.params.key, user, 'developer');
    const fields = normalizeIssueFields(project, objBody(ctx));
    const merged = { ...trackedOf(issue), ...fields };
    checkHierarchy(merged, issue.id);
    if ('status' in fields && fields.status !== issue.status) {
      if (!project.transitions.some(([a, z]) => a === issue.status && z === fields.status)) {
        throw conflict('invalid_transition', `Transition from "${issue.status}" to "${fields.status}" is not allowed`);
      }
      if (catOf(project, fields.status) === 'completed' && isBlocked(issue)) {
        throw conflict('blocked', 'Issue is blocked by an unresolved issue');
      }
    }
    const changed = Object.keys(fields).filter((f) => JSON.stringify(issue[f]) !== JSON.stringify(fields[f]));
    if (changed.length === 0) return [200, issueDetail(issue)];
    const at = nowIso();
    const actor = requireUser(ctx);
    for (const f of changed) {
      state.history.push({ issueId: issue.id, field: f, from: issue[f], to: fields[f], actorId: actor.id, at });
      issue[f] = fields[f];
    }
    if (changed.includes('assigneeId') && issue.assigneeId) addWatcher(issue, issue.assigneeId);
    issue.updatedAt = at;
    syncResolved(issue, project, at);
    if (changed.includes('status')) notify(issue.watchers, 'status_changed', issue, actor.id);
    if (changed.includes('assigneeId')) notify(issue.watchers, 'assigned', issue, actor.id);
    emit(project, 'issue.updated', issue, actor.id);
    return [200, issueDetail(issue)];
  });

  add('DELETE', '/api/issues/:key', (ctx) => {
    const user = requireUser(ctx);
    const { issue, project } = requireIssue(ctx.params.key, user, 'developer');
    const doomed = [];
    const collect = (node) => {
      doomed.push(node);
      for (const c of state.issues.filter((i) => i.parentId === node.id)) collect(c);
    };
    collect(issue);
    const ids = new Set(doomed.map((d) => d.id));
    for (const d of doomed) emit(project, 'issue.deleted', d, user.id);
    state.issues = state.issues.filter((i) => !ids.has(i.id));
    for (const i of state.issues) if (ids.has(i.epicId)) i.epicId = null;
    state.links = state.links.filter((l) => !ids.has(l.source) && !ids.has(l.target));
    state.comments = state.comments.filter((c) => !ids.has(c.issueId));
    state.history = state.history.filter((h) => !ids.has(h.issueId));
    return [204];
  });

  add('GET', '/api/issues/:key/history', (ctx) => {
    const user = requireUser(ctx);
    const { issue } = requireIssue(ctx.params.key, user, 'viewer');
    return [200, state.history.filter((h) => h.issueId === issue.id)
      .map((h) => ({ field: h.field, from: h.from, to: h.to, actorId: h.actorId, at: h.at }))];
  });

  add('POST', '/api/issues/:key/links', (ctx) => {
    const user = requireUser(ctx);
    const { issue } = requireIssue(ctx.params.key, user, 'developer');
    const b = objBody(ctx);
    if (!LINK_TYPES.includes(b.type)) throw bad('type must be blocks, relates or duplicates');
    const target = isStr(b.target) ? issueByKey(b.target) : undefined;
    if (!target) throw notFound('Target issue not found');
    requireProject(target.projectId, user, 'viewer');
    if (target.id === issue.id) throw bad('An issue cannot link to itself');
    const dup = state.links.some((l) => (l.source === issue.id && l.target === target.id && l.type === b.type)
      || (b.type === 'relates' && l.type === 'relates' && l.source === target.id && l.target === issue.id));
    if (dup) throw conflict('duplicate_link', 'Link already exists');
    const link = { id: uuid(), type: b.type, source: issue.id, target: target.id, createdAt: nowIso() };
    state.links.push(link);
    return [201, { id: link.id, type: link.type, target: target.key }];
  });

  add('DELETE', '/api/issues/:key/links/:linkId', (ctx) => {
    const user = requireUser(ctx);
    const { issue } = requireIssue(ctx.params.key, user, 'developer');
    const link = state.links.find((l) => l.id === ctx.params.linkId && (l.source === issue.id || l.target === issue.id));
    if (!link) throw notFound('Link not found');
    state.links = state.links.filter((l) => l !== link);
    return [204];
  });

  add('POST', '/api/issues/:key/watch', (ctx) => {
    const user = requireUser(ctx);
    const { issue } = requireIssue(ctx.params.key, user, 'viewer');
    addWatcher(issue, user.id);
    return [204];
  });

  add('DELETE', '/api/issues/:key/watch', (ctx) => {
    const user = requireUser(ctx);
    const { issue } = requireIssue(ctx.params.key, user, 'viewer');
    issue.watchers = issue.watchers.filter((w) => w !== user.id);
    return [204];
  });

  // --- comments ---
  const commentView = (c) => ({
    id: c.id, issueKey: c.issueKey, authorId: c.authorId, body: c.body,
    createdAt: c.createdAt, updatedAt: c.updatedAt, edited: c.edited,
  });

  add('GET', '/api/issues/:key/comments', (ctx) => {
    const user = requireUser(ctx);
    const { issue } = requireIssue(ctx.params.key, user, 'viewer');
    return [200, state.comments.filter((c) => c.issueId === issue.id).map(commentView)];
  });

  add('POST', '/api/issues/:key/comments', (ctx) => {
    const user = requireUser(ctx);
    const { issue, project } = requireIssue(ctx.params.key, user, 'developer');
    const b = objBody(ctx);
    if (!isNonEmptyStr(b.body)) throw bad('body is required');
    const at = nowIso();
    const comment = {
      id: uuid(), issueId: issue.id, issueKey: issue.key, authorId: user.id, body: b.body,
      createdAt: at, updatedAt: at, edited: false,
    };
    state.comments.push(comment);
    const mentioned = new Set();
    for (const m of b.body.matchAll(/@([A-Za-z0-9_.-]+)/g)) {
      const name = m[1].replace(/\.+$/, '');
      const u = userByName(name);
      if (u && roleFor(project, u)) mentioned.add(u.id);
    }
    mentioned.delete(user.id);
    notify([...mentioned], 'mention', issue, user.id);
    notify(issue.watchers.filter((w) => !mentioned.has(w)), 'comment', issue, user.id);
    emit(project, 'comment.created', issue, user.id);
    return [201, commentView(comment)];
  });

  add('PATCH', '/api/comments/:id', (ctx) => {
    const user = requireUser(ctx);
    const comment = state.comments.find((c) => c.id === ctx.params.id);
    if (!comment) throw notFound('Comment not found');
    requireProject(issueById(comment.issueId).projectId, user, 'viewer');
    if (comment.authorId !== user.id) throw forbidden('Only the author can edit this comment');
    const b = objBody(ctx);
    if (!isNonEmptyStr(b.body)) throw bad('body is required');
    comment.body = b.body;
    comment.edited = true;
    comment.updatedAt = nowIso();
    return [200, commentView(comment)];
  });

  // --- notifications ---
  add('GET', '/api/notifications', (ctx) => {
    const user = requireUser(ctx);
    const unread = ctx.query.get('unread') === 'true';
    const list = state.notifications.filter((n) => n.userId === user.id && (!unread || !n.read)).reverse();
    return [200, list.map((n) => ({ id: n.id, type: n.type, issueKey: n.issueKey, actorId: n.actorId, at: n.at, read: n.read }))];
  });

  add('POST', '/api/notifications/read', (ctx) => {
    const user = requireUser(ctx);
    const b = objBody(ctx);
    const mine = state.notifications.filter((n) => n.userId === user.id);
    if (b.all === true) {
      for (const n of mine) n.read = true;
    } else if (Array.isArray(b.ids)) {
      const ids = new Set(b.ids);
      for (const n of mine) if (ids.has(n.id)) n.read = true;
    } else {
      throw bad('Provide ids (array) or all: true');
    }
    return [204];
  });

  // --- sprints ---
  const sprintView = (s) => ({
    id: s.id, projectId: s.projectId, name: s.name, startDate: s.startDate, endDate: s.endDate,
    state: s.state, startedAt: s.startedAt, completedAt: s.completedAt, committedPoints: s.committedPoints,
  });

  add('POST', '/api/projects/:id/sprints', (ctx) => {
    const user = requireUser(ctx);
    const { project } = requireProject(ctx.params.id, user, 'developer');
    const b = objBody(ctx);
    if (!isNonEmptyStr(b.name)) throw bad('name is required');
    if (b.startDate != null && !validDate(b.startDate)) throw bad('startDate must be YYYY-MM-DD');
    if (b.endDate != null && !validDate(b.endDate)) throw bad('endDate must be YYYY-MM-DD');
    if (b.startDate && b.endDate && b.endDate < b.startDate) throw bad('endDate must not be before startDate');
    const sprint = {
      id: uuid(), projectId: project.id, name: b.name.trim(),
      startDate: b.startDate ?? null, endDate: b.endDate ?? null,
      state: 'planned', startedAt: null, completedAt: null, committedPoints: null, report: null,
      createdAt: nowIso(),
    };
    state.sprints.push(sprint);
    return [201, sprintView(sprint)];
  });

  add('GET', '/api/projects/:id/sprints', (ctx) => {
    const user = requireUser(ctx);
    const { project } = requireProject(ctx.params.id, user, 'viewer');
    return [200, state.sprints.filter((s) => s.projectId === project.id).map(sprintView)];
  });

  add('GET', '/api/sprints/:id', (ctx) => {
    const user = requireUser(ctx);
    const { sprint } = requireSprint(ctx.params.id, user, 'viewer');
    return [200, sprintView(sprint)];
  });

  add('POST', '/api/sprints/:id/start', (ctx) => {
    const user = requireUser(ctx);
    const { sprint, project } = requireSprint(ctx.params.id, user, 'developer');
    if (sprint.state !== 'planned') throw conflict('invalid_state', 'Only planned sprints can be started');
    if (state.sprints.some((s) => s.projectId === project.id && s.state === 'active')) {
      throw conflict('active_sprint_exists', 'Project already has an active sprint');
    }
    sprint.state = 'active';
    sprint.startedAt = nowIso();
    sprint.startDate = sprint.startDate ?? todayStr();
    sprint.committedPoints = sumPoints(state.issues.filter((i) => i.sprintId === sprint.id));
    return [200, sprintView(sprint)];
  });

  add('POST', '/api/sprints/:id/complete', (ctx) => {
    const user = requireUser(ctx);
    const { sprint, project } = requireSprint(ctx.params.id, user, 'developer');
    if (sprint.state !== 'active') throw conflict('invalid_state', 'Only active sprints can be completed');
    const b = objBody(ctx);
    const carry = b.carryOverTo ?? 'backlog';
    let target = null;
    if (carry !== 'backlog') {
      target = sprintById(carry);
      if (!target || target.projectId !== project.id || target.id === sprint.id || target.state === 'completed') {
        throw bad('carryOverTo must be "backlog" or another open sprint in this project');
      }
    }
    const inSprint = state.issues.filter((i) => i.sprintId === sprint.id);
    const done = inSprint.filter((i) => catOf(project, i.status) === 'completed');
    const unfinished = inSprint.filter((i) => catOf(project, i.status) !== 'completed');
    const at = nowIso();
    for (const i of unfinished) {
      const to = target ? target.id : null;
      state.history.push({ issueId: i.id, field: 'sprintId', from: i.sprintId, to, actorId: user.id, at });
      i.sprintId = to;
      i.updatedAt = at;
    }
    sprint.report = {
      committedPoints: sprint.committedPoints ?? sumPoints(inSprint),
      completedPoints: sumPoints(done),
      completedIssues: done.length,
      carriedOver: unfinished.length,
    };
    sprint.state = 'completed';
    sprint.completedAt = at;
    return [200, sprintView(sprint)];
  });

  add('GET', '/api/sprints/:id/report', (ctx) => {
    const user = requireUser(ctx);
    const { sprint, project } = requireSprint(ctx.params.id, user, 'viewer');
    const inSprint = state.issues.filter((i) => i.sprintId === sprint.id);
    let committedPoints;
    let completedPoints;
    let completedIssues;
    let carriedOver;
    if (sprint.state === 'completed') {
      ({ committedPoints, completedPoints, completedIssues, carriedOver } = sprint.report);
    } else {
      const done = inSprint.filter((i) => catOf(project, i.status) === 'completed');
      committedPoints = sprint.committedPoints ?? sumPoints(inSprint);
      completedPoints = sumPoints(done);
      completedIssues = done.length;
      carriedOver = 0;
    }
    const start = sprint.startDate ?? (sprint.startedAt ? sprint.startedAt.slice(0, 10) : null);
    const endLimit = [todayStr(), sprint.endDate].filter(Boolean).sort()[0];
    const burndown = [];
    if (start) {
      const projectIssues2 = state.issues.filter((i) => i.projectId === project.id);
      for (const day of dayRange(start, endLimit)) {
        const atMs = Date.parse(`${day}T23:59:59.999Z`);
        let remainingPoints = 0;
        for (const i of projectIssues2) {
          const s = stateAt(i, atMs);
          if (s.sprintId !== sprint.id) continue;
          if (catOf(project, s.status) === 'completed') continue;
          remainingPoints += s.storyPoints ?? 0;
        }
        burndown.push({ date: day, remainingPoints });
      }
    }
    return [200, {
      sprintId: sprint.id, state: sprint.state,
      committedPoints, completedPoints, completedIssues, carriedOver, burndown,
    }];
  });

  // --- search ---
  add('GET', '/api/search', (ctx) => {
    const user = requireUser(ctx);
    const q = ctx.query.get('q') ?? '';
    const sort = ctx.query.get('sort') ?? 'updated';
    if (!['updated', 'created', 'priority'].includes(sort)) throw bad('sort must be updated, created or priority');
    const pf = ctx.query.get('project');
    let projects = state.projects.filter((p) => roleFor(p, user));
    if (pf) {
      const p = state.projects.find((x) => x.id === pf || x.key === pf.toUpperCase());
      if (!p) throw notFound('Project not found');
      if (!roleFor(p, user)) throw forbidden('No access to this project');
      projects = [p];
    }
    const ids = new Set(projects.map((p) => p.id));
    const pred = compileQuery(q);
    const env = makeEnv(user);
    const results = state.issues.filter((i) => ids.has(i.projectId) && pred(i, env));
    if (sort === 'updated') results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    else if (sort === 'created') results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    else results.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || b.updatedAt.localeCompare(a.updatedAt));
    return [200, results.map(issueOut)];
  });

  // --- webhooks ---
  add('POST', '/api/projects/:id/webhooks', (ctx) => {
    const user = requireUser(ctx);
    const { project } = requireProject(ctx.params.id, user, 'lead');
    const b = objBody(ctx);
    let url;
    try { url = new URL(b.url); } catch { throw bad('url must be a valid http(s) URL'); }
    if (!['http:', 'https:'].includes(url.protocol)) throw bad('url must be http or https');
    if (!Array.isArray(b.events) || b.events.length === 0 || !b.events.every((e) => EVENTS.includes(e))) {
      throw bad(`events must be a non-empty subset of ${EVENTS.join(', ')}`);
    }
    if (!isNonEmptyStr(b.secret)) throw bad('secret is required');
    const wh = {
      id: uuid(), projectId: project.id, url: b.url, events: [...new Set(b.events)],
      secret: b.secret, createdAt: nowIso(),
    };
    state.webhooks.push(wh);
    audit(project.workspaceId, 'webhook.created', user.id, { projectId: project.id, webhookId: wh.id, url: wh.url });
    return [201, { id: wh.id, projectId: wh.projectId, url: wh.url, events: wh.events, createdAt: wh.createdAt }];
  });

  add('GET', '/api/projects/:id/webhooks', (ctx) => {
    const user = requireUser(ctx);
    const { project } = requireProject(ctx.params.id, user, 'lead');
    return [200, state.webhooks.filter((w) => w.projectId === project.id)
      .map((w) => ({ id: w.id, projectId: w.projectId, url: w.url, events: w.events, createdAt: w.createdAt }))];
  });

  add('DELETE', '/api/webhooks/:id', (ctx) => {
    const user = requireUser(ctx);
    const wh = state.webhooks.find((w) => w.id === ctx.params.id);
    if (!wh) throw notFound('Webhook not found');
    const { project } = requireProject(wh.projectId, user, 'lead');
    state.webhooks = state.webhooks.filter((w) => w !== wh);
    audit(project.workspaceId, 'webhook.deleted', user.id, { projectId: project.id, webhookId: wh.id });
    return [204];
  });

  add('GET', '/api/webhooks/:id/deliveries', (ctx) => {
    const user = requireUser(ctx);
    const wh = state.webhooks.find((w) => w.id === ctx.params.id);
    if (!wh) throw notFound('Webhook not found');
    requireProject(wh.projectId, user, 'lead');
    return [200, state.deliveries.filter((d) => d.webhookId === wh.id)
      .map((d) => ({ id: d.id, event: d.event, status: d.status, attempts: d.attempts, lastError: d.lastError, at: d.at }))];
  });

  // --- CSV import / export ---
  add('GET', '/api/projects/:id/export.csv', (ctx) => {
    const user = requireUser(ctx);
    const { project } = requireProject(ctx.params.id, user, 'viewer');
    const rows = projectIssues(project).map((i) => [
      i.key, i.type, i.title, i.status, i.priority,
      i.assigneeId ? (userById(i.assigneeId)?.username ?? '') : '',
      i.labels.join(';'),
      i.storyPoints ?? '',
      keyOf(i.parentId),
      keyOf(i.epicId),
      i.sprintId ? (sprintById(i.sprintId)?.name ?? '') : '',
      i.dueDate ?? '',
      i.createdAt,
      i.resolvedAt ?? '',
    ]);
    return [200, toCsv(CSV_COLUMNS, rows), {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${project.key}.csv"`,
    }];
  });

  add('POST', '/api/projects/:id/import.csv', (ctx) => {
    const user = requireUser(ctx);
    const { project } = requireProject(ctx.params.id, user, 'developer');
    let rows;
    try { rows = parseCsv(ctx.raw ?? ''); } catch (e) { throw bad(e.message || 'Malformed CSV'); }
    if (rows.length === 0) throw bad('CSV has no header row');
    const header = rows[0].fields.map((h) => h.trim().toLowerCase());
    for (const col of CSV_COLUMNS) {
      if (!header.includes(col.toLowerCase())) throw bad(`CSV is missing column "${col}"`);
    }
    const idx = {};
    header.forEach((h, i) => { idx[h] = i; });
    const errors = [];
    let created = 0;
    for (const row of rows.slice(1)) {
      try {
        if (row.fields.length !== header.length) {
          throw new Error(`expected ${header.length} columns, got ${row.fields.length}`);
        }
        const get = (name) => (row.fields[idx[name.toLowerCase()]] ?? '').trim();
        const body = { type: get('type') || 'task', title: get('title'), priority: get('priority') || 'none' };
        if (get('status')) body.status = get('status');
        if (get('assignee')) body.assignee = get('assignee');
        if (get('labels')) body.labels = get('labels').split(';').map((s) => s.trim()).filter(Boolean);
        if (get('storypoints')) {
          const n = Number(get('storypoints'));
          if (Number.isNaN(n)) throw new Error('storyPoints must be a number');
          body.storyPoints = n;
        }
        if (get('parent')) body.parentId = get('parent');
        if (get('epic')) body.epicId = get('epic');
        if (get('sprint')) {
          const s = state.sprints.find((x) => x.projectId === project.id && x.name === get('sprint'));
          if (!s) throw new Error(`unknown sprint "${get('sprint')}"`);
          body.sprintId = s.id;
        }
        if (get('duedate')) body.dueDate = get('duedate');
        createIssue(project, user, body);
        created++;
      } catch (e) {
        errors.push({ line: row.line, message: e.message });
      }
    }
    return [200, { created, errors }];
  });

  // --- static & SPA ---
  // (handled outside the router; see dispatch)

  // ---------- dispatch ----------
  function dispatch(req, res, raw) {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    if (req.method === 'GET' && (path === '/' || path.startsWith('/static/'))) return serveStatic(path, res);

    let match = null;
    let pathHit = false;
    for (const r of ROUTES) {
      const m = r.re.exec(path);
      if (!m) continue;
      pathHit = true;
      if (r.method !== req.method) continue;
      const params = {};
      r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
      match = { r, params };
      break;
    }
    if (!match) {
      return pathHit
        ? send(res, 405, { error: 'method_not_allowed', message: 'Method not allowed' })
        : send(res, 404, { error: 'not_found', message: 'Not found' });
    }

    const ct = String(req.headers['content-type'] || '');
    const isText = ct.includes('text/csv') || ct.startsWith('text/plain');
    let body;
    if (raw.length > 0 && !isText) {
      try { body = JSON.parse(raw); } catch { return sendError(res, bad('Invalid JSON body')); }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return sendError(res, bad('JSON body must be an object'));
      }
    }
    const ctx = {
      params: match.params,
      body,
      raw,
      query: url.searchParams,
      auth: currentAuth(req),
    };

    let result;
    try {
      result = match.r.handler(ctx);
    } catch (err) {
      result = err;
    }
    if (req.method !== 'GET') persist();
    if (result instanceof Error) return sendError(res, result);
    if (!result) return send(res, 204);
    const [status = 200, payload, headers] = result;
    return send(res, status, payload, headers);
  }

  return http.createServer((req, res) => {
    collectBody(req)
      .then((raw) => dispatch(req, res, raw))
      .catch((err) => sendError(res, err));
  });
}
