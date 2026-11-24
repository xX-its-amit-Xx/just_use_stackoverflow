// JSON REST API on node:http plus static SPA hosting (SPEC.md §1–8). Stdlib only.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError, bad, unauthorized, forbidden, notFound, conflict, writeFileAtomic } from './util.js';
import { parseQuery, matchIssue, sortIssues } from './search.js';
import { parseCsv, toCsv } from './csv.js';
import { deliver } from './webhooks.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');

const CATEGORIES = ['backlog', 'unstarted', 'started', 'completed'];
const ISSUE_TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'];
const WS_ROLES = ['admin', 'member', 'guest'];
const PROJECT_ROLES = ['lead', 'developer', 'viewer'];
const WEBHOOK_EVENTS = ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'];
const LINK_TYPES = ['blocks', 'relates', 'duplicates'];
const LINK_INVERSE = { blocks: 'blocked_by', blocked_by: 'blocks', relates: 'relates', duplicates: 'duplicated_by', duplicated_by: 'duplicates' };
const TRACKED_FIELDS = ['title', 'description', 'type', 'priority', 'assigneeId', 'labels', 'storyPoints', 'parentId', 'epicId', 'sprintId', 'dueDate'];
const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
const WRITE = ['lead', 'developer'];
const LEAD = ['lead'];
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
const MAX_BODY = 2 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const allPairs = (names) => names.flatMap((a) => names.filter((b) => b !== a).map((b) => [a, b]));
const sumBy = (arr, fn) => arr.reduce((acc, x) => acc + (fn(x) ?? 0), 0);

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

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(password, salt, 64).toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}

function loadState(dataFile) {
  const empty = {
    users: [], tokens: [], workspaces: [], projects: [], issues: [], comments: [], sprints: [],
    links: [], history: [], notifications: [], webhooks: [], deliveries: [], audit: [],
  };
  if (!dataFile || !fs.existsSync(dataFile)) return empty;
  const parsed = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  for (const k of Object.keys(empty)) if (!Array.isArray(parsed[k])) parsed[k] = [];
  return parsed;
}

function removeWhere(arr, pred) {
  for (let i = arr.length - 1; i >= 0; i--) if (pred(arr[i])) arr.splice(i, 1);
}

function reqString(v, field, max) {
  if (typeof v !== 'string' || !v.trim()) throw bad(`${field} is required`);
  const t = v.trim();
  if (t.length > max) throw bad(`${field} must be at most ${max} characters`);
  return t;
}

function parseDate(v, field) {
  if (typeof v !== 'string' || !DATE_RE.test(v.slice(0, 10)) || Number.isNaN(Date.parse(v))) {
    throw bad(`${field} must be a YYYY-MM-DD date`);
  }
  return v.slice(0, 10);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'payload_too_large', 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const ok = (body) => ({ status: 200, body });
const created = (body) => ({ status: 201, body });
const noContent = () => ({ status: 204 });

export function createServer({ dataFile, clock = () => new Date() } = {}) {
  const state = loadState(dataFile);
  const loginFailures = new Map();
  const newId = () => crypto.randomUUID();
  const nowIso = () => clock().toISOString();
  const today = () => clock().toISOString().slice(0, 10);
  const persist = () => {
    if (dataFile) writeFileAtomic(dataFile, JSON.stringify(state));
  };

  // ---------- lookups & access ----------
  const userById = (uid) => state.users.find((u) => u.id === uid);
  const userByRef = (ref) => state.users.find((u) => u.id === ref || u.username === ref);
  const pubUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName });
  const wsById = (wid) => state.workspaces.find((w) => w.id === wid);
  const projById = (pid) => state.projects.find((p) => p.id === pid);
  const sprintById = (sid) => state.sprints.find((s) => s.id === sid);
  const issueById = (iid) => state.issues.find((i) => i.id === iid);
  const keyOf = (iid) => issueById(iid)?.key ?? null;

  function wsAccess(wsId, user, { admin = false } = {}) {
    const ws = wsById(wsId);
    if (!ws) throw notFound('Workspace');
    const m = ws.members.find((x) => x.userId === user.id);
    if (!m) throw forbidden('Not a member of this workspace');
    if (admin && m.role !== 'admin') throw forbidden('Workspace admin required');
    return { ws, role: m.role };
  }

  function projectRole(project, userId) {
    const ws = wsById(project.workspaceId);
    const wm = ws?.members.find((m) => m.userId === userId);
    if (wm?.role === 'admin') return 'lead';
    return project.members.find((m) => m.userId === userId)?.role ?? null;
  }

  function projAccess(projectId, user, roles = null) {
    const project = projById(projectId);
    if (!project) throw notFound('Project');
    const role = projectRole(project, user.id);
    if (!role) throw forbidden('No access to this project');
    if (roles && !roles.includes(role)) throw forbidden(`Requires project role: ${roles.join(' or ')}`);
    return { project, role };
  }

  function issueAccess(key, user, roles = null) {
    const issue = state.issues.find((i) => i.key === String(key).toUpperCase());
    if (!issue) throw notFound('Issue');
    const { project, role } = projAccess(issue.projectId, user, roles);
    return { issue, project, role };
  }

  // ---------- workflow ----------
  const categoryOf = (project, status) => project.workflow.statuses.find((s) => s.name === status)?.category ?? null;
  const isDone = (project, status) => categoryOf(project, status) === 'completed';
  const initialStatus = (wf) => (wf.statuses.find((s) => s.category === 'unstarted') || wf.statuses[0]).name;
  const transitionAllowed = (project, from, to) => project.workflow.transitions.some(([a, b]) => a === from && b === to);

  function unresolvedBlockers(issue) {
    return state.links
      .filter((l) => l.type === 'blocks' && l.targetId === issue.id)
      .map((l) => issueById(l.sourceId))
      .filter((b) => b && !isDone(projById(b.projectId), b.status));
  }

  // ---------- serialization ----------
  const serializeIssue = (issue) => {
    const { _initial, ...rest } = issue; // eslint-disable-line no-unused-vars
    return rest;
  };
  const serializeComment = (c) => ({ id: c.id, issueId: c.issueId, authorId: c.authorId, body: c.body, createdAt: c.createdAt, updatedAt: c.updatedAt, edited: c.edited });

  function issueDetail(issue) {
    const project = projById(issue.projectId);
    const links = [];
    for (const l of state.links) {
      if (l.sourceId === issue.id) links.push({ type: l.type, target: keyOf(l.targetId) });
      if (l.targetId === issue.id) links.push({ type: LINK_INVERSE[l.type], target: keyOf(l.sourceId) });
    }
    const out = {
      ...serializeIssue(issue),
      children: state.issues.filter((i) => i.parentId === issue.id).map((i) => i.key),
      links,
      comments: state.comments.filter((c) => c.issueId === issue.id).map(serializeComment),
    };
    if (issue.type === 'epic') {
      const kids = state.issues.filter((i) => i.epicId === issue.id);
      const done = kids.filter((k) => isDone(project, k.status));
      out.progress = {
        total: kids.length,
        done: done.length,
        points_total: sumBy(kids, (k) => k.storyPoints),
        points_done: sumBy(done, (k) => k.storyPoints),
      };
    }
    return out;
  }

  const userIdentityById = (uid) => (uid ? userById(uid)?.username ?? null : null);

  // ---------- notifications & webhooks ----------
  function notify(userIds, type, issue, actorId) {
    const at = nowIso();
    const project = projById(issue.projectId);
    for (const uid of new Set(userIds)) {
      if (!uid || uid === actorId) continue;
      if (!projectRole(project, uid)) continue;
      state.notifications.push({ id: newId(), userId: uid, type, issueKey: issue.key, actorId, at, read: false });
    }
  }

  function fireWebhooks(project, event, issue, actorId) {
    const at = nowIso();
    for (const hook of state.webhooks.filter((w) => w.projectId === project.id && w.events.includes(event))) {
      const body = JSON.stringify({ event, issue: serializeIssue(issue), actorId, at });
      const delivery = { id: newId(), webhookId: hook.id, event, status: null, attempts: 0, lastError: null, at };
      state.deliveries.push(delivery);
      deliver({ url: hook.url, secret: hook.secret, body, event, delivery, onUpdate: persist }).catch(() => {});
    }
  }

  function audit(workspaceId, actorId, action, detail = {}) {
    state.audit.push({ id: newId(), workspaceId, actorId, action, detail, at: nowIso() });
  }

  // ---------- issue field parsing ----------
  function parseFieldUpdates(project, input) {
    const out = {};
    const has = (k) => Object.prototype.hasOwnProperty.call(input, k);
    if (has('title')) out.title = reqString(input.title, 'title', 200);
    if (has('description')) {
      if (input.description != null && typeof input.description !== 'string') throw bad('description must be a string');
      out.description = input.description ? input.description.slice(0, 10000) : '';
    }
    if (has('type')) {
      if (!ISSUE_TYPES.includes(input.type)) throw bad(`type must be one of ${ISSUE_TYPES.join(', ')}`);
      out.type = input.type;
    }
    if (has('status')) {
      if (categoryOf(project, input.status) == null) throw bad(`unknown status: ${input.status}`);
      out.status = input.status;
    }
    if (has('priority')) {
      if (!PRIORITIES.includes(input.priority)) throw bad(`priority must be one of ${PRIORITIES.join(', ')}`);
      out.priority = input.priority;
    }
    if (has('assignee') && !has('assigneeId')) {
      if (input.assignee == null || input.assignee === '') out.assigneeId = null;
      else {
        const u = userByRef(input.assignee);
        if (!u) throw bad(`unknown assignee: ${input.assignee}`);
        out.assigneeId = u.id;
      }
    }
    if (has('assigneeId')) {
      if (input.assigneeId == null || input.assigneeId === '') out.assigneeId = null;
      else {
        if (!userById(input.assigneeId)) throw bad('assigneeId does not reference a user');
        out.assigneeId = input.assigneeId;
      }
    }
    if (out.assigneeId && !projectRole(project, out.assigneeId)) throw bad('assignee must be a project member');
    if (has('labels')) {
      const raw = typeof input.labels === 'string' ? input.labels.split(';') : input.labels;
      if (raw == null) out.labels = [];
      else {
        if (!Array.isArray(raw)) throw bad('labels must be an array of strings');
        const labels = [...new Set(raw.map((l) => {
          if (typeof l !== 'string') throw bad('labels must be strings');
          return l.trim();
        }).filter(Boolean))];
        if (labels.some((l) => l.length > 40)) throw bad('labels must be at most 40 characters');
        out.labels = labels;
      }
    }
    if (has('storyPoints')) {
      if (input.storyPoints == null || input.storyPoints === '') out.storyPoints = null;
      else {
        const n = Number(input.storyPoints);
        if (!Number.isFinite(n) || n < 0) throw bad('storyPoints must be a non-negative number');
        out.storyPoints = n;
      }
    }
    if (has('dueDate')) out.dueDate = input.dueDate == null || input.dueDate === '' ? null : parseDate(input.dueDate, 'dueDate');
    if (has('parentId')) out.parentId = input.parentId || null;
    if (has('epicId')) out.epicId = input.epicId || null;
    if (has('sprintId')) {
      if (input.sprintId == null || input.sprintId === '') out.sprintId = null;
      else {
        const sp = sprintById(input.sprintId);
        if (!sp || sp.projectId !== project.id) throw bad('sprintId must reference a sprint in this project');
        out.sprintId = sp.id;
      }
    }
    return out;
  }

  function checkStructure(project, merged, selfId) {
    if (merged.type === 'subtask') {
      if (!merged.parentId) throw bad('subtasks require a parentId');
      const parent = issueById(merged.parentId);
      if (!parent || parent.projectId !== project.id) throw bad('parentId must reference an issue in this project');
      if (parent.type === 'subtask') throw bad('a subtask cannot be the parent of another subtask');
      if (selfId && parent.id === selfId) throw bad('an issue cannot be its own parent');
      if (selfId && state.issues.some((i) => i.parentId === selfId)) throw bad('an issue with subtasks cannot become a subtask');
    } else if (merged.parentId) {
      throw bad('only subtasks may have a parentId');
    }
    if (merged.epicId) {
      if (merged.type === 'epic') throw bad('epics cannot belong to an epic');
      const epic = issueById(merged.epicId);
      if (!epic || epic.projectId !== project.id || epic.type !== 'epic') throw bad('epicId must reference an epic in this project');
    }
  }

  // ---------- issue operations ----------
  function createIssue(project, input, actor) {
    if (!input || typeof input !== 'object') throw bad('body must be an object');
    if (!ISSUE_TYPES.includes(input.type)) throw bad(`type must be one of ${ISSUE_TYPES.join(', ')}`);
    const fields = parseFieldUpdates(project, input);
    const merged = {
      type: input.type,
      title: null,
      description: '',
      status: initialStatus(project.workflow),
      priority: 'none',
      assigneeId: null,
      labels: [],
      storyPoints: null,
      parentId: null,
      epicId: null,
      sprintId: null,
      dueDate: null,
      ...fields,
    };
    if (!merged.title) throw bad('title is required');
    checkStructure(project, merged, null);
    const t = nowIso();
    project.issueSeq += 1;
    const watchers = [...new Set([actor.id, merged.assigneeId].filter(Boolean))];
    const issue = {
      id: newId(),
      key: `${project.key}-${project.issueSeq}`,
      projectId: project.id,
      ...merged,
      reporterId: actor.id,
      watchers,
      createdAt: t,
      updatedAt: t,
      resolvedAt: isDone(project, merged.status) ? t : null,
      _initial: { status: merged.status, storyPoints: merged.storyPoints, sprintId: merged.sprintId },
    };
    state.issues.push(issue);
    if (issue.assigneeId) notify([issue.assigneeId], 'assigned', issue, actor.id);
    fireWebhooks(project, 'issue.created', issue, actor.id);
    return issue;
  }

  function updateIssue(issue, project, input, actor) {
    const updates = parseFieldUpdates(project, input);
    const merged = { ...issue, ...updates };
    checkStructure(project, merged, issue.id);
    const changes = [];
    const fromStatus = issue.status;
    if (updates.status !== undefined && updates.status !== fromStatus) {
      if (!transitionAllowed(project, fromStatus, updates.status)) {
        throw conflict(`transition ${fromStatus} -> ${updates.status} is not allowed`, 'invalid_transition');
      }
      if (isDone(project, updates.status)) {
        const blockers = unresolvedBlockers(issue);
        if (blockers.length) throw conflict(`blocked by unresolved ${blockers.map((b) => b.key).join(', ')}`, 'blocked');
      }
    }
    const t = nowIso();
    for (const field of TRACKED_FIELDS.concat('status')) {
      if (updates[field] === undefined) continue;
      const from = issue[field] ?? null;
      const to = updates[field] ?? null;
      if (JSON.stringify(from) === JSON.stringify(to)) continue;
      changes.push({ field, from, to });
    }
    if (changes.length === 0) return { issue, changed: false };
    const wasDone = isDone(project, issue.status);
    for (const ch of changes) {
      issue[ch.field] = ch.to;
      state.history.push({ issueId: issue.id, field: ch.field, from: ch.from, to: ch.to, actorId: actor.id, at: t });
    }
    const nowDone = isDone(project, issue.status);
    if (!wasDone && nowDone) issue.resolvedAt = t;
    else if (wasDone && !nowDone) issue.resolvedAt = null;
    issue.updatedAt = t;
    const assignChange = changes.find((c) => c.field === 'assigneeId');
    if (assignChange && assignChange.to && !issue.watchers.includes(assignChange.to)) issue.watchers.push(assignChange.to);
    if (assignChange) notify(issue.watchers, 'assigned', issue, actor.id);
    if (changes.some((c) => c.field === 'status')) notify(issue.watchers, 'status_changed', issue, actor.id);
    fireWebhooks(project, 'issue.updated', issue, actor.id);
    return { issue, changed: true };
  }

  function deleteIssue(issue, actor) {
    for (const kid of state.issues.filter((i) => i.parentId === issue.id)) deleteIssue(kid, actor);
    const project = projById(issue.projectId);
    for (const other of state.issues.filter((i) => i.epicId === issue.id)) {
      state.history.push({ issueId: other.id, field: 'epicId', from: issue.id, to: null, actorId: actor.id, at: nowIso() });
      other.epicId = null;
    }
    fireWebhooks(project, 'issue.deleted', issue, actor.id);
    removeWhere(state.issues, (i) => i.id === issue.id);
    removeWhere(state.comments, (c) => c.issueId === issue.id);
    removeWhere(state.links, (l) => l.sourceId === issue.id || l.targetId === issue.id);
  }

  // ---------- sprints & reports ----------
  function issueStateAt(issue, t) {
    const snap = { status: issue._initial.status, storyPoints: issue._initial.storyPoints, sprintId: issue._initial.sprintId };
    for (const h of state.history) {
      if (h.issueId !== issue.id || !(h.field in snap)) continue;
      if (Date.parse(h.at) <= t) snap[h.field] = h.to;
    }
    return snap;
  }

  function sprintMembersAt(sprint, t) {
    const project = projById(sprint.projectId);
    return state.issues
      .filter((i) => i.projectId === sprint.projectId && Date.parse(i.createdAt) <= t)
      .map((i) => ({ issue: i, snap: issueStateAt(i, t) }))
      .filter((x) => x.snap.sprintId === sprint.id)
      .map((x) => ({ ...x, done: isDone(project, x.snap.status) }));
  }

  function addDays(ymd, n) {
    const d = new Date(`${ymd}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  function sprintReport(sprint) {
    const nowT = clock().getTime();
    const startT = sprint.startedAt ? Date.parse(sprint.startedAt) : nowT;
    const committed = sprintMembersAt(sprint, startT);
    const endT = sprint.completedAt ? Date.parse(sprint.completedAt) : nowT;
    const finished = sprintMembersAt(sprint, endT).filter((x) => x.done);
    const startDay = sprint.startDate || sprint.startedAt?.slice(0, 10) || null;
    const burndown = [];
    if (startDay) {
      const lastDay = sprint.endDate && sprint.endDate < today() ? sprint.endDate : today();
      for (let d = startDay; d <= lastDay; d = addDays(d, 1)) {
        const members = sprintMembersAt(sprint, Date.parse(`${d}T23:59:59.999Z`));
        const remaining = members.filter((x) => !x.done);
        burndown.push({ date: d, remainingPoints: sumBy(remaining, (x) => x.snap.storyPoints) });
      }
    }
    return {
      committedPoints: sumBy(committed, (x) => x.snap.storyPoints),
      completedPoints: sumBy(finished, (x) => x.snap.storyPoints),
      completedIssues: finished.map((x) => x.issue.key),
      carriedOver: [...(sprint.carriedOver || [])],
      burndown,
    };
  }

  // ---------- auth helpers ----------
  function authenticate(req) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    if (!m) throw unauthorized();
    const t = state.tokens.find((x) => x.hash === sha256(m[1].trim()));
    if (!t) throw unauthorized('Invalid token');
    const user = userById(t.userId);
    if (!user) throw unauthorized('Invalid token');
    return { user, token: t };
  }

  function issueToken(userId, kind, name = null) {
    const raw = (kind === 'api' ? 'pmt_' : 'pms_') + crypto.randomBytes(32).toString('base64url');
    const rec = { id: newId(), hash: sha256(raw), userId, kind, name, createdAt: nowIso() };
    state.tokens.push(rec);
    return { raw, rec };
  }

  // ---------- route handlers ----------
  const routes = [];
  const def = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const src = pattern.replace(/[.]/g, '\\.').replace(/:([A-Za-z]+)/g, (_, k) => {
      keys.push(k);
      return '([^/]+)';
    });
    routes.push({ method, re: new RegExp(`^${src}$`), keys, handler, isPublic: Boolean(opts.public) });
  };

  // Auth
  def('POST', '/api/auth/register', (c) => {
    const b = c.body();
    const username = reqString(b.username, 'username', 32);
    if (!USERNAME_RE.test(username)) throw bad('username must be 3-32 characters: letters, digits, _ . -');
    const password = typeof b.password === 'string' ? b.password : '';
    if (password.length < 8 || password.length > 200) throw bad('password must be 8-200 characters');
    if (state.users.some((u) => u.username === username)) throw conflict('username already taken');
    const user = {
      id: newId(),
      username,
      displayName: b.displayName ? reqString(b.displayName, 'displayName', 100) : username,
      passwordHash: hashPassword(password),
      createdAt: nowIso(),
    };
    state.users.push(user);
    return created({ user: pubUser(user) });
  }, { public: true });

  def('POST', '/api/auth/login', (c) => {
    const b = c.body();
    const username = typeof b.username === 'string' ? b.username : '';
    const password = typeof b.password === 'string' ? b.password : '';
    const cutoff = clock().getTime() - LOGIN_WINDOW_MS;
    const recent = (loginFailures.get(username) || []).filter((t) => t > cutoff);
    loginFailures.set(username, recent);
    if (recent.length >= LOGIN_MAX_FAILURES) {
      throw new HttpError(429, 'rate_limited', 'Too many failed login attempts; try again later');
    }
    const user = state.users.find((u) => u.username === username);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      recent.push(clock().getTime());
      throw new HttpError(401, 'invalid_credentials', 'Invalid username or password');
    }
    loginFailures.delete(username);
    const { raw } = issueToken(user.id, 'session');
    return ok({ token: raw, user: pubUser(user) });
  }, { public: true });

  def('POST', '/api/auth/logout', (c) => {
    removeWhere(state.tokens, (t) => t.id === c.token.id);
    return noContent();
  });

  def('GET', '/api/auth/me', (c) => ok({ user: pubUser(c.user) }));

  def('PATCH', '/api/auth/me', (c) => {
    const b = c.body();
    if (typeof b.currentPassword !== 'string') throw bad('currentPassword is required');
    if (!verifyPassword(b.currentPassword, c.user.passwordHash)) throw forbidden('Current password is incorrect');
    if (b.displayName !== undefined) c.user.displayName = reqString(b.displayName, 'displayName', 100);
    if (b.password !== undefined) {
      if (typeof b.password !== 'string' || b.password.length < 8 || b.password.length > 200) throw bad('password must be 8-200 characters');
      c.user.passwordHash = hashPassword(b.password);
    }
    return ok({ user: pubUser(c.user) });
  });

  // Personal tokens
  def('POST', '/api/tokens', (c) => {
    const name = reqString(c.body().name, 'name', 100);
    const { raw, rec } = issueToken(c.user.id, 'api', name);
    for (const w of state.workspaces.filter((ws) => ws.members.some((m) => m.userId === c.user.id))) {
      audit(w.id, c.user.id, 'token.created', { name });
    }
    return created({ id: rec.id, name, token: raw });
  });

  def('GET', '/api/tokens', (c) => ok(state.tokens
    .filter((t) => t.userId === c.user.id && t.kind === 'api')
    .map((t) => ({ id: t.id, name: t.name, createdAt: t.createdAt }))));

  def('DELETE', '/api/tokens/:id', (c) => {
    const t = state.tokens.find((x) => x.id === c.params.id && x.userId === c.user.id && x.kind === 'api');
    if (!t) throw notFound('Token');
    removeWhere(state.tokens, (x) => x.id === t.id);
    for (const w of state.workspaces.filter((ws) => ws.members.some((m) => m.userId === c.user.id))) {
      audit(w.id, c.user.id, 'token.deleted', { name: t.name });
    }
    return noContent();
  });

  // Workspaces
  def('POST', '/api/workspaces', (c) => {
    const b = c.body();
    const name = reqString(b.name, 'name', 100);
    const key = typeof b.key === 'string' ? b.key : '';
    if (!/^[A-Z]{2,10}$/.test(key)) throw bad('key must be 2-10 uppercase letters');
    if (state.workspaces.some((w) => w.key === key)) throw conflict('workspace key already taken');
    const ws = { id: newId(), name, key, createdAt: nowIso(), members: [{ userId: c.user.id, role: 'admin' }] };
    state.workspaces.push(ws);
    audit(ws.id, c.user.id, 'workspace.created', { name, key });
    return created({ id: ws.id, name, key, createdAt: ws.createdAt, role: 'admin' });
  });

  def('GET', '/api/workspaces', (c) => ok(state.workspaces
    .filter((w) => w.members.some((m) => m.userId === c.user.id))
    .map((w) => ({ id: w.id, name: w.name, key: w.key, role: w.members.find((m) => m.userId === c.user.id).role }))));

  def('GET', '/api/workspaces/:id', (c) => {
    const { ws, role } = wsAccess(c.params.id, c.user);
    return ok({
      id: ws.id, name: ws.name, key: ws.key, createdAt: ws.createdAt, role,
      members: ws.members.map((m) => ({ userId: m.userId, username: userById(m.userId)?.username, displayName: userById(m.userId)?.displayName, role: m.role })),
    });
  });

  def('POST', '/api/workspaces/:id/members', (c) => {
    const { ws } = wsAccess(c.params.id, c.user, { admin: true });
    const b = c.body();
    const target = typeof b.username === 'string' ? userByRef(b.username) : null;
    if (!target) throw notFound('User');
    const role = b.role ?? 'member';
    if (!WS_ROLES.includes(role)) throw bad(`role must be one of ${WS_ROLES.join(', ')}`);
    if (ws.members.some((m) => m.userId === target.id)) throw conflict('user is already a member');
    ws.members.push({ userId: target.id, role });
    audit(ws.id, c.user.id, 'member.added', { username: target.username, role });
    return created({ userId: target.id, username: target.username, role });
  });

  def('PATCH', '/api/workspaces/:id/members/:user', (c) => {
    const { ws } = wsAccess(c.params.id, c.user, { admin: true });
    const target = userByRef(c.params.user);
    const m = target && ws.members.find((x) => x.userId === target.id);
    if (!m) throw notFound('Member');
    const role = c.body().role;
    if (!WS_ROLES.includes(role)) throw bad(`role must be one of ${WS_ROLES.join(', ')}`);
    if (m.role === 'admin' && role !== 'admin' && ws.members.filter((x) => x.role === 'admin').length === 1) {
      throw bad('the last admin cannot be demoted');
    }
    const from = m.role;
    m.role = role;
    audit(ws.id, c.user.id, 'member.role_changed', { username: target.username, from, to: role });
    return ok({ userId: target.id, username: target.username, role });
  });

  def('DELETE', '/api/workspaces/:id/members/:user', (c) => {
    const { ws } = wsAccess(c.params.id, c.user, { admin: true });
    const target = userByRef(c.params.user);
    const m = target && ws.members.find((x) => x.userId === target.id);
    if (!m) throw notFound('Member');
    if (m.role === 'admin' && ws.members.filter((x) => x.role === 'admin').length === 1) {
      throw bad('the last admin cannot be removed');
    }
    removeWhere(ws.members, (x) => x.userId === target.id);
    for (const p of state.projects.filter((pr) => pr.workspaceId === ws.id)) {
      removeWhere(p.members, (x) => x.userId === target.id);
    }
    audit(ws.id, c.user.id, 'member.removed', { username: target.username });
    return noContent();
  });

  def('POST', '/api/workspaces/:id/projects', (c) => {
    const { ws, role } = wsAccess(c.params.id, c.user);
    if (role === 'guest') throw forbidden('Guests cannot create projects');
    const b = c.body();
    const name = reqString(b.name, 'name', 100);
    const key = typeof b.key === 'string' ? b.key : '';
    if (!/^[A-Z]{2,10}$/.test(key)) throw bad('key must be 2-10 uppercase letters');
    if (state.projects.some((p) => p.key === key)) throw conflict('project key already taken');
    const project = {
      id: newId(), workspaceId: ws.id, name, key, createdAt: nowIso(), issueSeq: 0,
      workflow: defaultWorkflow(), members: [{ userId: c.user.id, role: 'lead' }],
    };
    state.projects.push(project);
    audit(ws.id, c.user.id, 'project.created', { name, key });
    return created(serializeProject(project));
  });

  def('GET', '/api/workspaces/:id/projects', (c) => {
    const { ws } = wsAccess(c.params.id, c.user);
    return ok(state.projects.filter((p) => p.workspaceId === ws.id && projectRole(p, c.user.id)).map(serializeProject));
  });

  def('GET', '/api/workspaces/:id/audit', (c) => {
    const { ws } = wsAccess(c.params.id, c.user, { admin: true });
    return ok(state.audit.filter((a) => a.workspaceId === ws.id).map((a) => ({ id: a.id, action: a.action, actorId: a.actorId, detail: a.detail, at: a.at })));
  });

  function serializeProject(p) {
    return {
      id: p.id, workspaceId: p.workspaceId, name: p.name, key: p.key, createdAt: p.createdAt,
      workflow: p.workflow,
      members: p.members.map((m) => ({ userId: m.userId, username: userById(m.userId)?.username, role: m.role })),
    };
  }

  // Projects
  def('GET', '/api/projects/:id', (c) => {
    const { project, role } = projAccess(c.params.id, c.user);
    return ok({ ...serializeProject(project), role });
  });

  def('POST', '/api/projects/:id/members', (c) => {
    const { project } = projAccess(c.params.id, c.user, LEAD);
    const b = c.body();
    const target = typeof b.username === 'string' ? userByRef(b.username) : null;
    if (!target) throw notFound('User');
    if (!wsById(project.workspaceId).members.some((m) => m.userId === target.id)) throw bad('user is not a member of the workspace');
    const role = b.role ?? 'developer';
    if (!PROJECT_ROLES.includes(role)) throw bad(`role must be one of ${PROJECT_ROLES.join(', ')}`);
    if (project.members.some((m) => m.userId === target.id)) throw conflict('user is already a project member');
    project.members.push({ userId: target.id, role });
    return created({ userId: target.id, username: target.username, role });
  });

  def('PATCH', '/api/projects/:id/members/:user', (c) => {
    const { project } = projAccess(c.params.id, c.user, LEAD);
    const target = userByRef(c.params.user);
    const m = target && project.members.find((x) => x.userId === target.id);
    if (!m) throw notFound('Member');
    const role = c.body().role;
    if (!PROJECT_ROLES.includes(role)) throw bad(`role must be one of ${PROJECT_ROLES.join(', ')}`);
    m.role = role;
    return ok({ userId: target.id, username: target.username, role });
  });

  def('DELETE', '/api/projects/:id/members/:user', (c) => {
    const { project } = projAccess(c.params.id, c.user, LEAD);
    const target = userByRef(c.params.user);
    if (!target || !project.members.some((x) => x.userId === target.id)) throw notFound('Member');
    removeWhere(project.members, (x) => x.userId === target.id);
    return noContent();
  });

  def('PUT', '/api/projects/:id/workflow', (c) => {
    const { project } = projAccess(c.params.id, c.user, LEAD);
    const b = c.body();
    if (!Array.isArray(b.statuses) || b.statuses.length === 0) throw bad('statuses must be a non-empty array');
    const statuses = b.statuses.map((s) => {
      if (!s || typeof s !== 'object') throw bad('each status must be an object');
      const name = reqString(s.name, 'status name', 40);
      if (!CATEGORIES.includes(s.category)) throw bad(`category must be one of ${CATEGORIES.join(', ')}`);
      return { name, category: s.category };
    });
    const names = statuses.map((s) => s.name);
    if (new Set(names).size !== names.length) throw bad('status names must be unique');
    let transitions;
    if (b.transitions === undefined) transitions = allPairs(names);
    else {
      if (!Array.isArray(b.transitions)) throw bad('transitions must be an array of [from, to]');
      transitions = b.transitions.map((t) => {
        if (!Array.isArray(t) || t.length !== 2 || !names.includes(t[0]) || !names.includes(t[1])) {
          throw bad('each transition must be [from, to] referencing existing statuses');
        }
        return [t[0], t[1]];
      });
    }
    const remap = b.remap == null ? {} : b.remap;
    if (typeof remap !== 'object' || Array.isArray(remap)) throw bad('remap must be an object');
    const removed = project.workflow.statuses.map((s) => s.name).filter((n) => !names.includes(n));
    const members = state.issues.filter((i) => i.projectId === project.id);
    for (const old of removed) {
      if (!members.some((i) => i.status === old)) continue;
      const target = remap[old];
      if (!target) throw bad(`status "${old}" is in use and must be remapped`);
      if (!names.includes(target)) throw bad(`remap target "${target}" is not in the new workflow`);
    }
    const t = nowIso();
    for (const issue of members) {
      if (!removed.includes(issue.status)) continue;
      const from = issue.status;
      issue.status = remap[from];
      state.history.push({ issueId: issue.id, field: 'status', from, to: issue.status, actorId: c.user.id, at: t });
    }
    project.workflow = { statuses, transitions };
    for (const issue of members) {
      const done = isDone(project, issue.status);
      if (done && !issue.resolvedAt) issue.resolvedAt = t;
      if (!done && issue.resolvedAt) issue.resolvedAt = null;
    }
    audit(project.workspaceId, c.user.id, 'workflow.updated', { projectKey: project.key, statuses: names });
    return ok({ workflow: project.workflow });
  });

  def('POST', '/api/projects/:id/issues', (c) => {
    const { project } = projAccess(c.params.id, c.user, WRITE);
    const issue = createIssue(project, c.body(), c.user);
    return created(issueDetail(issue));
  });

  def('GET', '/api/projects/:id/issues', (c) => {
    const { project } = projAccess(c.params.id, c.user);
    return ok(state.issues.filter((i) => i.projectId === project.id).map(serializeIssue));
  });

  def('GET', '/api/projects/:id/stats', (c) => {
    const { project } = projAccess(c.params.id, c.user);
    const issues = state.issues.filter((i) => i.projectId === project.id);
    const byStatus = Object.fromEntries(project.workflow.statuses.map((s) => [s.name, 0]));
    const byType = Object.fromEntries(ISSUE_TYPES.map((t) => [t, 0]));
    const byAssignee = {};
    for (const i of issues) {
      byStatus[i.status] = (byStatus[i.status] || 0) + 1;
      byType[i.type] += 1;
      const who = userIdentityById(i.assigneeId) || 'unassigned';
      byAssignee[who] = (byAssignee[who] || 0) + 1;
    }
    const cycles = [];
    for (const i of issues) {
      if (!i.resolvedAt) continue;
      let start = null;
      if (categoryOf(project, i._initial.status) === 'started') start = Date.parse(i.createdAt);
      else {
        const h = state.history.find((x) => x.issueId === i.id && x.field === 'status' && categoryOf(project, x.to) === 'started');
        if (h) start = Date.parse(h.at);
      }
      if (start != null) cycles.push((Date.parse(i.resolvedAt) - start) / 3600000);
    }
    const avg = cycles.length ? Math.round((cycles.reduce((a, b) => a + b, 0) / cycles.length) * 100) / 100 : null;
    return ok({ total: issues.length, byStatus, byType, byAssignee, avgCycleTimeHours: avg });
  });

  // Sprints
  def('POST', '/api/projects/:id/sprints', (c) => {
    const { project } = projAccess(c.params.id, c.user, WRITE);
    const b = c.body();
    const name = reqString(b.name, 'name', 100);
    const startDate = b.startDate ? parseDate(b.startDate, 'startDate') : null;
    const endDate = b.endDate ? parseDate(b.endDate, 'endDate') : null;
    if (startDate && endDate && endDate < startDate) throw bad('endDate must not be before startDate');
    const sprint = {
      id: newId(), projectId: project.id, name, startDate, endDate, state: 'planned',
      startedAt: null, completedAt: null, carriedOver: [],
    };
    state.sprints.push(sprint);
    return created(serializeSprint(sprint));
  });

  def('GET', '/api/projects/:id/sprints', (c) => {
    const { project } = projAccess(c.params.id, c.user);
    return ok(state.sprints.filter((s) => s.projectId === project.id).map(serializeSprint));
  });

  const serializeSprint = (s) => ({
    id: s.id, projectId: s.projectId, name: s.name, startDate: s.startDate, endDate: s.endDate,
    state: s.state, startedAt: s.startedAt, completedAt: s.completedAt, carriedOver: s.carriedOver,
  });

  function sprintAccess(id, user, roles = null) {
    const sprint = sprintById(id);
    if (!sprint) throw notFound('Sprint');
    projAccess(sprint.projectId, user, roles);
    return sprint;
  }

  def('GET', '/api/sprints/:id', (c) => ok(serializeSprint(sprintAccess(c.params.id, c.user))));

  def('POST', '/api/sprints/:id/start', (c) => {
    const sprint = sprintAccess(c.params.id, c.user, WRITE);
    if (sprint.state !== 'planned') throw conflict(`sprint is ${sprint.state}`);
    if (state.sprints.some((s) => s.projectId === sprint.projectId && s.state === 'active')) {
      throw conflict('another sprint is already active in this project');
    }
    sprint.state = 'active';
    sprint.startedAt = nowIso();
    return ok(serializeSprint(sprint));
  });

  def('POST', '/api/sprints/:id/complete', (c) => {
    const sprint = sprintAccess(c.params.id, c.user, WRITE);
    if (sprint.state !== 'active') throw conflict(`sprint is ${sprint.state}`);
    const target = c.body().carryOverTo ?? 'backlog';
    let targetId = null;
    if (target !== 'backlog') {
      const t = sprintById(target);
      if (!t || t.projectId !== sprint.projectId) throw bad('carryOverTo must be "backlog" or a sprint in this project');
      if (t.state === 'completed' || t.id === sprint.id) throw bad('carryOverTo must be a planned or active sprint');
      targetId = t.id;
    }
    const project = projById(sprint.projectId);
    const t = nowIso();
    const carried = [];
    for (const issue of state.issues.filter((i) => i.sprintId === sprint.id)) {
      if (isDone(project, issue.status)) continue;
      state.history.push({ issueId: issue.id, field: 'sprintId', from: sprint.id, to: targetId, actorId: c.user.id, at: t });
      issue.sprintId = targetId;
      issue.updatedAt = t;
      carried.push(issue.key);
    }
    sprint.state = 'completed';
    sprint.completedAt = t;
    sprint.carriedOver = carried;
    return ok(serializeSprint(sprint));
  });

  def('GET', '/api/sprints/:id/report', (c) => {
    const sprint = sprintAccess(c.params.id, c.user);
    return ok(sprintReport(sprint));
  });

  // Issues
  def('GET', '/api/issues/:key', (c) => {
    const { issue } = issueAccess(c.params.key, c.user);
    return ok(issueDetail(issue));
  });

  def('PATCH', '/api/issues/:key', (c) => {
    const { issue, project } = issueAccess(c.params.key, c.user, WRITE);
    const { issue: updated } = updateIssue(issue, project, c.body(), c.user);
    return ok(issueDetail(updated));
  });

  def('DELETE', '/api/issues/:key', (c) => {
    const { issue } = issueAccess(c.params.key, c.user, WRITE);
    deleteIssue(issue, c.user);
    return noContent();
  });

  def('GET', '/api/issues/:key/history', (c) => {
    const { issue } = issueAccess(c.params.key, c.user);
    return ok(state.history.filter((h) => h.issueId === issue.id).map((h) => ({ field: h.field, from: h.from, to: h.to, actorId: h.actorId, at: h.at })));
  });

  def('POST', '/api/issues/:key/links', (c) => {
    const { issue } = issueAccess(c.params.key, c.user, WRITE);
    const b = c.body();
    if (!LINK_TYPES.includes(b.type)) throw bad(`type must be one of ${LINK_TYPES.join(', ')}`);
    const target = typeof b.target === 'string' ? state.issues.find((i) => i.key === b.target.toUpperCase()) : null;
    if (!target) throw notFound('Target issue');
    projAccess(target.projectId, c.user);
    if (target.id === issue.id) throw bad('an issue cannot link to itself');
    if (state.links.some((l) => l.type === b.type && l.sourceId === issue.id && l.targetId === target.id)) {
      throw conflict('link already exists');
    }
    state.links.push({ id: newId(), type: b.type, sourceId: issue.id, targetId: target.id });
    return created({ type: b.type, target: target.key });
  });

  def('DELETE', '/api/issues/:key/links', (c) => {
    const { issue } = issueAccess(c.params.key, c.user, WRITE);
    const type = c.query.get('type');
    const target = state.issues.find((i) => i.key === String(c.query.get('target') || '').toUpperCase());
    const idx = state.links.findIndex((l) => l.type === type && l.sourceId === issue.id && target && l.targetId === target.id);
    if (idx < 0) throw notFound('Link');
    state.links.splice(idx, 1);
    return noContent();
  });

  def('POST', '/api/issues/:key/watch', (c) => {
    const { issue } = issueAccess(c.params.key, c.user);
    if (!issue.watchers.includes(c.user.id)) issue.watchers.push(c.user.id);
    return ok({ watchers: [...issue.watchers] });
  });

  def('DELETE', '/api/issues/:key/watch', (c) => {
    const { issue } = issueAccess(c.params.key, c.user);
    issue.watchers = issue.watchers.filter((u) => u !== c.user.id);
    return ok({ watchers: [...issue.watchers] });
  });

  def('GET', '/api/issues/:key/comments', (c) => {
    const { issue } = issueAccess(c.params.key, c.user);
    return ok(state.comments.filter((x) => x.issueId === issue.id).map(serializeComment));
  });

  def('POST', '/api/issues/:key/comments', (c) => {
    const { issue, project } = issueAccess(c.params.key, c.user, WRITE);
    const body = reqString(c.body().body, 'body', 10000);
    const t = nowIso();
    const comment = { id: newId(), issueId: issue.id, authorId: c.user.id, body, createdAt: t, updatedAt: t, edited: false };
    state.comments.push(comment);
    notify(issue.watchers, 'comment', issue, c.user.id);
    const mentioned = new Set();
    for (const m of body.matchAll(/(?:^|[^A-Za-z0-9_])@([A-Za-z0-9_][A-Za-z0-9_.-]*)/g)) {
      const u = state.users.find((x) => x.username === m[1].replace(/\.+$/, ''));
      if (u) mentioned.add(u.id);
    }
    notify([...mentioned], 'mention', issue, c.user.id);
    fireWebhooks(project, 'comment.created', issue, c.user.id);
    return created(serializeComment(comment));
  });

  def('PATCH', '/api/comments/:id', (c) => {
    const comment = state.comments.find((x) => x.id === c.params.id);
    if (!comment) throw notFound('Comment');
    projAccess(issueById(comment.issueId).projectId, c.user);
    if (comment.authorId !== c.user.id) throw forbidden('Only the author can edit a comment');
    comment.body = reqString(c.body().body, 'body', 10000);
    comment.edited = true;
    comment.updatedAt = nowIso();
    return ok(serializeComment(comment));
  });

  def('DELETE', '/api/comments/:id', (c) => {
    const comment = state.comments.find((x) => x.id === c.params.id);
    if (!comment) throw notFound('Comment');
    const { role } = projAccess(issueById(comment.issueId).projectId, c.user);
    if (comment.authorId !== c.user.id && role !== 'lead') throw forbidden('Only the author or a lead can delete a comment');
    removeWhere(state.comments, (x) => x.id === comment.id);
    return noContent();
  });

  // Notifications
  def('GET', '/api/notifications', (c) => {
    const unreadOnly = c.query.get('unread') === 'true';
    const list = state.notifications
      .filter((n) => n.userId === c.user.id && (!unreadOnly || !n.read))
      .reverse()
      .map((n) => ({ id: n.id, type: n.type, issueKey: n.issueKey, actorId: n.actorId, at: n.at, read: n.read }));
    return ok(list);
  });

  def('POST', '/api/notifications/read', (c) => {
    const b = c.body();
    const mine = state.notifications.filter((n) => n.userId === c.user.id);
    let targets;
    if (b.all === true) targets = mine;
    else if (Array.isArray(b.ids)) {
      const set = new Set(b.ids);
      targets = mine.filter((n) => set.has(n.id));
    } else throw bad('provide ids or all: true');
    for (const n of targets) n.read = true;
    return ok({ updated: targets.length });
  });

  // Webhooks
  def('POST', '/api/projects/:id/webhooks', (c) => {
    const { project } = projAccess(c.params.id, c.user, LEAD);
    const b = c.body();
    let url;
    try {
      url = new URL(String(b.url));
    } catch {
      throw bad('url must be an absolute http(s) URL');
    }
    if (!['http:', 'https:'].includes(url.protocol)) throw bad('url must be http or https');
    if (!Array.isArray(b.events) || b.events.length === 0 || b.events.some((e) => !WEBHOOK_EVENTS.includes(e))) {
      throw bad(`events must be a non-empty subset of ${WEBHOOK_EVENTS.join(', ')}`);
    }
    if (b.secret !== undefined && typeof b.secret !== 'string') throw bad('secret must be a string');
    const hook = { id: newId(), projectId: project.id, url: url.toString(), events: [...new Set(b.events)], secret: b.secret ?? '', createdAt: nowIso() };
    state.webhooks.push(hook);
    audit(project.workspaceId, c.user.id, 'webhook.created', { projectKey: project.key, url: hook.url, events: hook.events });
    return created({ id: hook.id, projectId: hook.projectId, url: hook.url, events: hook.events, createdAt: hook.createdAt });
  });

  def('GET', '/api/projects/:id/webhooks', (c) => {
    const { project } = projAccess(c.params.id, c.user, LEAD);
    return ok(state.webhooks.filter((w) => w.projectId === project.id).map((w) => ({ id: w.id, projectId: w.projectId, url: w.url, events: w.events, createdAt: w.createdAt })));
  });

  def('DELETE', '/api/webhooks/:id', (c) => {
    const hook = state.webhooks.find((w) => w.id === c.params.id);
    if (!hook) throw notFound('Webhook');
    const { project } = projAccess(hook.projectId, c.user, LEAD);
    removeWhere(state.webhooks, (w) => w.id === hook.id);
    audit(project.workspaceId, c.user.id, 'webhook.deleted', { projectKey: project.key, url: hook.url });
    return noContent();
  });

  def('GET', '/api/webhooks/:id/deliveries', (c) => {
    const hook = state.webhooks.find((w) => w.id === c.params.id);
    if (!hook) throw notFound('Webhook');
    projAccess(hook.projectId, c.user, LEAD);
    return ok(state.deliveries
      .filter((d) => d.webhookId === hook.id)
      .map((d) => ({ id: d.id, event: d.event, status: d.status, attempts: d.attempts, lastError: d.lastError, at: d.at })));
  });

  // Search
  def('GET', '/api/search', (c) => {
    const terms = parseQuery(c.query.get('q') ?? '');
    const sort = c.query.get('sort') ?? 'updated';
    if (!['updated', 'created', 'priority'].includes(sort)) throw bad('sort must be updated, created or priority');
    let projects = state.projects.filter((p) => projectRole(p, c.user.id));
    const pf = c.query.get('project');
    if (pf) {
      const exists = state.projects.find((p) => p.id === pf || p.key === pf.toUpperCase());
      if (!exists) throw notFound('Project');
      if (!projects.includes(exists)) throw forbidden('No access to this project');
      projects = [exists];
    }
    const ids = new Set(projects.map((p) => p.id));
    const ctx = {
      me: c.user.id,
      userIdByName: (name) => state.users.find((u) => u.username.toLowerCase() === name.toLowerCase())?.id ?? null,
      activeSprintIds: (pid) => state.sprints.filter((s) => s.projectId === pid && s.state === 'active').map((s) => s.id),
      isDone: (issue) => isDone(projById(issue.projectId), issue.status),
    };
    const hits = state.issues.filter((i) => ids.has(i.projectId) && matchIssue(terms, i, ctx));
    return ok(sortIssues(hits, sort).map(serializeIssue));
  });

  // Export / import
  const CSV_HEADER = ['key', 'type', 'title', 'status', 'priority', 'assignee', 'labels', 'storyPoints', 'parent', 'epic', 'sprint', 'dueDate', 'createdAt', 'resolvedAt'];

  def('GET', '/api/projects/:id/export.csv', (c) => {
    const { project } = projAccess(c.params.id, c.user);
    const issues = state.issues
      .filter((i) => i.projectId === project.id)
      .sort((a, b) => Number(a.key.split('-').pop()) - Number(b.key.split('-').pop()));
    const rows = issues.map((i) => [
      i.key, i.type, i.title, i.status, i.priority, userIdentityById(i.assigneeId) || '',
      i.labels.join(';'), i.storyPoints ?? '', keyOf(i.parentId) || '', keyOf(i.epicId) || '',
      sprintById(i.sprintId)?.name || '', i.dueDate || '', i.createdAt, i.resolvedAt || '',
    ]);
    return { status: 200, text: toCsv(CSV_HEADER, rows), type: 'text/csv; charset=utf-8' };
  });

  def('POST', '/api/projects/:id/import.csv', (c) => {
    const { project } = projAccess(c.params.id, c.user, WRITE);
    const records = parseCsv(c.rawText());
    if (records.length === 0) throw bad('CSV is empty');
    const header = records[0].fields.map((h) => h.trim().toLowerCase());
    for (const required of ['type', 'title']) {
      if (!header.includes(required)) throw bad(`CSV header must include ${required}`);
    }
    let createdCount = 0;
    const errors = [];
    for (const rec of records.slice(1)) {
      const get = (name) => {
        const idx = header.indexOf(name);
        return idx < 0 ? '' : (rec.fields[idx] ?? '').trim();
      };
      try {
        const input = { type: get('type'), title: get('title') };
        for (const name of ['priority', 'status', 'description']) {
          if (get(name)) input[name] = get(name);
        }
        const assignee = get('assignee');
        if (assignee) input.assignee = assignee;
        const labels = get('labels');
        if (labels) input.labels = labels;
        const points = get('storypoints');
        if (points !== '') {
          if (Number.isNaN(Number(points))) throw bad('storyPoints must be a number');
          input.storyPoints = points;
        }
        const due = get('duedate');
        if (due) input.dueDate = due;
        const parent = get('parent');
        if (parent) {
          const p = state.issues.find((i) => i.key === parent.toUpperCase() && i.projectId === project.id);
          if (!p) throw bad(`parent ${parent} not found in this project`);
          input.parentId = p.id;
        }
        const epic = get('epic');
        if (epic) {
          const e = state.issues.find((i) => i.key === epic.toUpperCase() && i.projectId === project.id);
          if (!e) throw bad(`epic ${epic} not found in this project`);
          input.epicId = e.id;
        }
        const sprint = get('sprint');
        if (sprint) {
          const s = state.sprints.find((x) => x.projectId === project.id && x.name === sprint);
          if (!s) throw bad(`sprint "${sprint}" not found in this project`);
          input.sprintId = s.id;
        }
        createIssue(project, input, c.user);
        createdCount += 1;
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
        errors.push({ line: rec.line, message: err.message });
      }
    }
    return ok({ created: createdCount, errors });
  });

  // ---------- dispatch ----------
  function findRoute(method, pathname) {
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { route: r, params };
    }
    return null;
  }

  function serveStatic(res, rel) {
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return sendText(res, 404, 'Not found', 'text/plain; charset=utf-8');
    }
    const data = fs.readFileSync(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-length': data.length });
    res.end(data);
  }

  function sendText(res, status, text, type) {
    res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(text) });
    res.end(text);
  }

  function sendJson(res, status, body) {
    if (status === 204) {
      res.writeHead(204);
      res.end();
      return;
    }
    sendText(res, status, JSON.stringify(body), 'application/json; charset=utf-8');
  }

  async function handle(req, res) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
        return serveStatic(res, 'index.html');
      }
      if (req.method === 'GET' && pathname.startsWith('/static/')) {
        return serveStatic(res, decodeURIComponent(pathname.slice('/static/'.length)));
      }
      if (!pathname.startsWith('/api/')) return sendText(res, 404, 'Not found', 'text/plain; charset=utf-8');
      const raw = await readBody(req);
      const hit = findRoute(req.method, pathname);
      if (!hit) throw new HttpError(404, 'not_found', 'No such route');
      const { route, params } = hit;
      let auth = null;
      if (!route.isPublic) auth = authenticate(req);
      let parsed;
      const ctx = {
        params,
        query: url.searchParams,
        user: auth?.user ?? null,
        token: auth?.token ?? null,
        rawText: () => raw,
        body: () => {
          if (parsed !== undefined) return parsed;
          if (!raw.trim()) parsed = {};
          else {
            try {
              parsed = JSON.parse(raw);
            } catch {
              throw bad('request body must be valid JSON');
            }
          }
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw bad('request body must be a JSON object');
          return parsed;
        },
      };
      const result = await route.handler(ctx);
      if (req.method !== 'GET') persist();
      if (result.text !== undefined) return sendText(res, result.status, result.text, result.type);
      return sendJson(res, result.status, result.body);
    } catch (err) {
      if (err instanceof HttpError) {
        const headers = err.status === 429 ? { 'retry-after': '900' } : {};
        const body = JSON.stringify({ error: err.code, message: err.message });
        res.writeHead(err.status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), ...headers });
        return res.end(body);
      }
      console.error(err);
      const body = JSON.stringify({ error: 'internal_error', message: 'Internal server error' });
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
      return res.end(body);
    }
  }

  return http.createServer((req, res) => { handle(req, res); });
}
