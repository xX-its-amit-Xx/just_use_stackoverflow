import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  ApiError, bad, newId, hashPassword, verifyPassword, sha256, randomToken, parseDay, dayOf, addDays,
} from './util.js';
import { parseCsv, toCsv } from './csv.js';
import { parseQuery } from './query.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(HERE, 'static');

const ISSUE_TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'];
const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
const WS_ROLES = ['admin', 'member', 'guest'];
const WS_RANK = { guest: 1, member: 2, admin: 3 };
const PROJ_ROLES = ['lead', 'developer', 'viewer'];
const PROJ_RANK = { viewer: 1, developer: 2, lead: 3 };
const CATEGORIES = ['backlog', 'unstarted', 'started', 'completed'];
const WEBHOOK_EVENTS = ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'];
const LINK_TYPES = ['blocks', 'relates', 'duplicates'];
const INVERSE_LINK = { blocks: 'blocked_by', relates: 'relates', duplicates: 'duplicated_by' };
const DEFAULT_STATUSES = [
  { name: 'Backlog', category: 'backlog' },
  { name: 'Todo', category: 'unstarted' },
  { name: 'In Progress', category: 'started' },
  { name: 'In Review', category: 'started' },
  { name: 'Done', category: 'completed' },
];
const CSV_COLUMNS = ['key', 'type', 'title', 'status', 'priority', 'assignee', 'labels', 'storyPoints',
  'parent', 'epic', 'sprint', 'dueDate', 'createdAt', 'resolvedAt'];
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT = 5;
const MAX_BODY_BYTES = 5 * 1024 * 1024;

const ok = (body, status = 200) => ({ status, body });
const noContent = () => ({ status: 204 });
const forbidden = (msg = 'Forbidden') => new ApiError(403, 'forbidden', msg);
const notFound = (msg = 'Not found') => new ApiError(404, 'not_found', msg);
const conflict = (msg, code = 'conflict') => new ApiError(409, code, msg);

function emptyDb() {
  return {
    users: [], tokens: [], workspaces: [], projects: [], issues: [], comments: [], links: [],
    sprints: [], notifications: [], webhooks: [], deliveries: [], audit: [], loginFailures: [],
  };
}

function loadDb(file) {
  if (file && fs.existsSync(file)) {
    return { ...emptyDb(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  }
  return emptyDb();
}

function persist(file, db) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, file);
}

function compile(pattern) {
  const names = [];
  const src = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        names.push(seg.slice(1));
        return '([^/]+)';
      }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { re: new RegExp(`^${src}$`), names };
}

function objBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('Request body must be a JSON object');
  return body;
}

function reqString(v, name, { max = 200, min = 1 } = {}) {
  if (typeof v !== 'string') throw bad(`${name} must be a string`);
  const t = v.trim();
  if (t.length < min) throw bad(`${name} is required`);
  if (t.length > max) throw bad(`${name} is too long`);
  return t;
}

function optString(v, name, max) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw bad(`${name} must be a string`);
  if (v.length > max) throw bad(`${name} is too long`);
  return v;
}

function pick(v, list, name) {
  if (typeof v !== 'string' || !list.includes(v)) throw bad(`${name} must be one of: ${list.join(', ')}`);
  return v;
}

function normLabels(v) {
  if (v === undefined || v === null) return [];
  let arr = v;
  if (typeof v === 'string') arr = v.split(';');
  if (!Array.isArray(arr) || arr.some((x) => typeof x !== 'string')) throw bad('labels must be an array of strings');
  return [...new Set(arr.map((x) => x.trim()).filter(Boolean))];
}

function normPoints(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) throw bad('storyPoints must be a non-negative number');
  return n;
}

function normDate(v) {
  if (v === undefined || v === null || v === '') return null;
  const d = parseDay(v);
  if (!d) throw bad('dueDate must be a YYYY-MM-DD date');
  return d;
}

const pubUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName });

/** Builds the whole service around one in-memory db persisted to `dataFile`. */
export function createServer({ dataFile, clock = () => new Date() } = {}) {
  const db = loadDb(dataFile);
  const nowD = () => new Date(clock());
  const nowIso = () => nowD().toISOString();

  // ---------- lookups ----------
  const findUserByName = (name) => db.users.find((u) => u.username.toLowerCase() === String(name).toLowerCase());
  const userById = (id) => db.users.find((u) => u.id === id);
  const wsById = (id) => {
    const ws = db.workspaces.find((w) => w.id === id);
    if (!ws) throw notFound('Workspace not found');
    return ws;
  };
  const projById = (id) => {
    const p = db.projects.find((x) => x.id === id);
    if (!p) throw notFound('Project not found');
    return p;
  };
  const issueByKey = (key) => {
    const i = db.issues.find((x) => x.key === String(key).toUpperCase());
    if (!i) throw notFound('Issue not found');
    return i;
  };
  const sprintById = (id) => {
    const s = db.sprints.find((x) => x.id === id);
    if (!s) throw notFound('Sprint not found');
    return s;
  };
  const wsOf = (project) => wsById(project.workspaceId);
  const findIssueInProject = (project, ref) => {
    if (typeof ref !== 'string' || !ref) return null;
    return db.issues.find((i) => i.projectId === project.id && (i.id === ref || i.key === ref.toUpperCase())) || null;
  };

  // ---------- access control ----------
  const wsRoleOf = (ws, userId) => (ws.members.find((m) => m.userId === userId) || {}).role || null;
  const projRoleOf = (project, user) => {
    const wr = wsRoleOf(wsOf(project), user.id);
    if (!wr) return null;
    if (wr === 'admin') return 'lead';
    const m = project.members.find((x) => x.userId === user.id);
    return m ? m.role : null;
  };
  const requireWs = (user, ws, min) => {
    const r = wsRoleOf(ws, user.id);
    if (!r || WS_RANK[r] < WS_RANK[min]) throw forbidden('Insufficient workspace role');
    return r;
  };
  const requireProj = (project, user, min) => {
    const r = projRoleOf(project, user);
    if (!r) throw forbidden('No access to this project');
    if (PROJ_RANK[r] < PROJ_RANK[min]) throw forbidden('Insufficient project role');
    return r;
  };

  // ---------- workflow helpers ----------
  const categoryOf = (project, status) => {
    const s = project.workflow.statuses.find((x) => x.name === status);
    return s ? s.category : null;
  };
  const initialStatus = (project) => {
    const s = project.workflow.statuses.find((x) => x.category === 'unstarted') || project.workflow.statuses[0];
    return s.name;
  };
  const statusName = (project, v) => {
    if (typeof v !== 'string') throw bad('status must be a string');
    const s = project.workflow.statuses.find((x) => x.name.toLowerCase() === v.trim().toLowerCase());
    if (!s) throw bad(`Unknown status "${v}"`);
    return s.name;
  };
  const isDoneIssue = (issue) => {
    const p = db.projects.find((x) => x.id === issue.projectId);
    return !!p && categoryOf(p, issue.status) === 'completed';
  };
  const isBlocked = (issue) => db.links.some((l) => l.type === 'blocks' && l.to === issue.id
    && !isDoneIssue(db.issues.find((x) => x.id === l.from) || { projectId: '', status: '' }));

  // ---------- serializers ----------
  const projOut = (p, user) => ({
    id: p.id,
    workspaceId: p.workspaceId,
    name: p.name,
    key: p.key,
    createdAt: p.createdAt,
    workflow: p.workflow,
    members: p.members.map((m) => {
      const u = userById(m.userId);
      return { userId: m.userId, username: u ? u.username : null, displayName: u ? u.displayName : null, role: m.role };
    }),
    myRole: user ? projRoleOf(p, user) : null,
  });

  const issueOut = (i) => ({
    id: i.id,
    key: i.key,
    projectId: i.projectId,
    type: i.type,
    title: i.title,
    description: i.description,
    status: i.status,
    priority: i.priority,
    assigneeId: i.assigneeId,
    reporterId: i.reporterId,
    labels: [...i.labels],
    storyPoints: i.storyPoints,
    parentId: i.parentId,
    epicId: i.epicId,
    sprintId: i.sprintId,
    dueDate: i.dueDate,
    watchers: [...i.watchers],
    createdAt: i.createdAt,
    updatedAt: i.updatedAt,
    resolvedAt: i.resolvedAt,
  });

  const issueDetail = (i) => {
    const out = { ...issueOut(i) };
    out.children = db.issues.filter((c) => c.parentId === i.id).map((c) => c.key);
    out.links = db.links
      .filter((l) => l.from === i.id || l.to === i.id)
      .map((l) => (l.from === i.id
        ? { id: l.id, type: l.type, target: keyOf(l.to) }
        : { id: l.id, type: INVERSE_LINK[l.type], target: keyOf(l.from) }));
    if (i.type === 'epic') {
      const kids = db.issues.filter((c) => c.epicId === i.id);
      const done = kids.filter(isDoneIssue);
      const sum = (arr) => arr.reduce((a, c) => a + (c.storyPoints || 0), 0);
      out.progress = {
        total: kids.length,
        done: done.length,
        points_total: sum(kids),
        points_done: sum(done),
      };
    }
    return out;
  };
  const keyOf = (id) => {
    const i = db.issues.find((x) => x.id === id);
    return i ? i.key : null;
  };

  const sprintOut = (s) => ({
    id: s.id,
    projectId: s.projectId,
    name: s.name,
    state: s.state,
    startDate: s.startDate,
    endDate: s.endDate,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
    createdAt: s.createdAt,
  });

  const commentOut = (c) => ({
    id: c.id,
    issueId: c.issueId,
    authorId: c.authorId,
    body: c.body,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    edited: c.edited,
  });

  const audit = (wsId, actorId, action, details = {}) => {
    db.audit.push({ id: newId(), workspaceId: wsId, actorId, action, at: nowIso(), ...details });
  };

  // ---------- history reconstruction ----------
  /** Value of `field` on `issue` at time `T` (ms), reconstructed from history. */
  const valueAt = (issue, field, T) => {
    let found = false;
    let val;
    for (const h of issue.history) {
      if (h.field === field && Date.parse(h.at) <= T) {
        found = true;
        val = h.to;
      }
    }
    if (found) return val;
    if (Date.parse(issue.createdAt) > T) return undefined;
    return issue.initial[field];
  };

  // ---------- notifications ----------
  const notify = (userIds, type, issue, actorId) => {
    const at = nowIso();
    const project = projById(issue.projectId);
    for (const uid of new Set(userIds)) {
      if (uid === actorId) continue;
      const u = userById(uid);
      if (!u || !projRoleOf(project, u)) continue;
      db.notifications.push({ id: newId(), userId: uid, type, issueKey: issue.key, actorId, at, read: false });
    }
  };

  // ---------- webhooks ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function deliverOne(webhook, delivery, body, event) {
    const sig = `sha256=${crypto.createHmac('sha256', webhook.secret).update(body).digest('hex')}`;
    for (let attempt = 1; attempt <= 3; attempt++) {
      delivery.attempts = attempt;
      try {
        const res = await fetch(webhook.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-pm-signature': sig, 'x-pm-event': event },
          body,
          signal: AbortSignal.timeout(5000),
        });
        await res.arrayBuffer().catch(() => {});
        delivery.status = res.status;
        if (res.ok) {
          delivery.lastError = null;
          return;
        }
        delivery.lastError = `HTTP ${res.status}`;
      } catch (e) {
        delivery.status = null;
        delivery.lastError = e.message || String(e);
      }
      if (attempt < 3) await sleep(50 * attempt);
    }
  }

  async function emit(project, event, issue, actorId) {
    const hooks = db.webhooks.filter((w) => w.projectId === project.id && w.events.includes(event));
    if (!hooks.length) return;
    const at = nowIso();
    const jobs = hooks.map((w) => {
      const delivery = {
        id: newId(), webhookId: w.id, event, status: null, attempts: 0, lastError: null, createdAt: at,
      };
      db.deliveries.push(delivery);
      const body = JSON.stringify({ event, issue: issueOut(issue), actorId, at });
      return deliverOne(w, delivery, body, event);
    });
    await Promise.all(jobs);
  }

  // ---------- issue create / validate helpers ----------
  const assigneeFromBody = (b, fallback) => {
    if (b.assigneeId !== undefined) return b.assigneeId;
    if (b.assignee !== undefined) {
      if (b.assignee === null || b.assignee === '') return null;
      const u = findUserByName(b.assignee);
      if (!u) throw bad('Unknown assignee');
      return u.id;
    }
    return fallback;
  };

  const resolveAssignee = (project, id) => {
    if (id === null || id === undefined || id === '') return null;
    const u = userById(id);
    if (!u || !projRoleOf(project, u)) throw bad('assignee must be a project member');
    return u.id;
  };

  const resolveParent = (project, type, ref) => {
    if (ref === null || ref === undefined || ref === '') {
      if (type === 'subtask') throw bad('subtasks require a parentId');
      return null;
    }
    if (type !== 'subtask') throw bad(type === 'epic' ? 'epics cannot have parents' : 'only subtasks can have a parentId');
    const parent = findIssueInProject(project, ref);
    if (!parent) throw bad('parentId must reference an issue in the same project');
    if (parent.type === 'subtask') throw bad('a subtask cannot be the parent of a subtask');
    return parent;
  };

  const resolveEpic = (project, type, ref) => {
    if (ref === null || ref === undefined || ref === '') return null;
    if (type === 'epic') throw bad('epics cannot belong to an epic');
    const epic = findIssueInProject(project, ref);
    if (!epic || epic.type !== 'epic') throw bad('epicId must reference an epic in the same project');
    return epic;
  };

  const resolveSprint = (project, ref) => {
    if (ref === null || ref === undefined || ref === '') return null;
    const s = db.sprints.find((x) => x.id === ref && x.projectId === project.id);
    if (!s || s.state === 'completed') throw bad('sprintId must reference an open sprint in this project');
    return s;
  };

  function createIssue(project, user, b) {
    const type = pick(b.type ?? 'task', ISSUE_TYPES, 'type');
    const title = reqString(b.title, 'title', { max: 500 });
    const description = optString(b.description, 'description', 20000);
    const priority = pick(b.priority ?? 'none', PRIORITIES, 'priority');
    const status = b.status === undefined || b.status === null ? initialStatus(project) : statusName(project, b.status);
    const labels = normLabels(b.labels);
    const storyPoints = normPoints(b.storyPoints);
    const dueDate = normDate(b.dueDate);
    const parent = resolveParent(project, type, b.parentId);
    const epic = resolveEpic(project, type, b.epicId);
    const sprint = resolveSprint(project, b.sprintId);
    const assigneeId = resolveAssignee(project, assigneeFromBody(b, null));
    const t = nowIso();
    const sprintId = sprint ? sprint.id : null;
    const issue = {
      id: newId(),
      key: `${project.key}-${project.nextNumber}`,
      projectId: project.id,
      type,
      title,
      description,
      status,
      priority,
      assigneeId,
      reporterId: user.id,
      labels,
      storyPoints,
      parentId: parent ? parent.id : null,
      epicId: epic ? epic.id : null,
      sprintId,
      dueDate,
      watchers: [user.id],
      createdAt: t,
      updatedAt: t,
      resolvedAt: categoryOf(project, status) === 'completed' ? t : null,
      history: [],
      initial: { status, storyPoints, sprintId },
    };
    project.nextNumber++;
    if (assigneeId && !issue.watchers.includes(assigneeId)) issue.watchers.push(assigneeId);
    db.issues.push(issue);
    return issue;
  }

  // ---------- sprint reporting ----------
  function sprintReport(sprint) {
    const project = projById(sprint.projectId);
    const issues = db.issues.filter((i) => i.projectId === project.id);
    const nowT = nowD().getTime();
    const startT = sprint.startedAt ? Date.parse(sprint.startedAt) : nowT;
    const endT = sprint.completedAt ? Date.parse(sprint.completedAt) : nowT;
    const inSprint = (i, T) => valueAt(i, 'sprintId', T) === sprint.id;
    const done = (i, T) => categoryOf(project, valueAt(i, 'status', T)) === 'completed';
    const pts = (i, T) => valueAt(i, 'storyPoints', T) || 0;

    const committed = issues.filter((i) => inSprint(i, startT));
    const completed = issues.filter((i) => inSprint(i, endT) && done(i, endT));
    const carried = issues.filter((i) => (inSprint(i, startT) || i.history.some((h) => h.field === 'sprintId' && h.from === sprint.id))
      && !inSprint(i, endT) && !done(i, endT));

    const startDay = sprint.startDate || dayOf(new Date(startT));
    const today = dayOf(nowD());
    const endDay = sprint.endDate && sprint.endDate < today ? sprint.endDate : today;
    const burndown = [];
    for (let d = startDay; d <= endDay; d = addDays(d, 1)) {
      const T = Date.parse(`${d}T23:59:59.999Z`);
      let remaining = 0;
      for (const i of issues) {
        if (Date.parse(i.createdAt) <= T && inSprint(i, T) && !done(i, T)) remaining += pts(i, T);
      }
      burndown.push({ date: d, remainingPoints: remaining });
    }

    return {
      committedPoints: committed.reduce((a, i) => a + pts(i, startT), 0),
      completedPoints: completed.reduce((a, i) => a + pts(i, endT), 0),
      completedIssues: completed.length,
      carriedOver: carried.length,
      burndown,
    };
  }

  // ---------- search ----------
  function matchTerm(term, issue, user) {
    const r = (() => {
      if (term.kind === 'text') {
        const hay = `${issue.title}\n${issue.description || ''}`.toLowerCase();
        return hay.includes(term.text);
      }
      const v = term.value;
      switch (term.field) {
        case 'status':
          return issue.status.toLowerCase() === v.toLowerCase();
        case 'type':
          return issue.type === v;
        case 'priority':
          return issue.priority === v;
        case 'assignee': {
          if (v.toLowerCase() === 'none') return !issue.assigneeId;
          const target = v.toLowerCase() === 'me' ? user.username : v;
          const a = issue.assigneeId ? userById(issue.assigneeId) : null;
          return !!a && a.username.toLowerCase() === target.toLowerCase();
        }
        case 'label':
          return issue.labels.some((l) => l.toLowerCase() === v.toLowerCase());
        case 'sprint': {
          if (v.toLowerCase() === 'none') return !issue.sprintId;
          const s = issue.sprintId ? db.sprints.find((x) => x.id === issue.sprintId) : null;
          if (!s) return false;
          if (v.toLowerCase() === 'active') return s.state === 'active';
          return s.id === v || s.name.toLowerCase() === v.toLowerCase();
        }
        case 'is': {
          const open = !isDoneIssue(issue);
          return v === 'open' ? open : !open;
        }
        case 'due': {
          if (!issue.dueDate) return false;
          if (term.op === '<') return issue.dueDate < v;
          if (term.op === '>') return issue.dueDate > v;
          return issue.dueDate === v;
        }
        case 'points': {
          if (issue.storyPoints === null || issue.storyPoints === undefined) return false;
          const p = issue.storyPoints;
          switch (term.op) {
            case '>': return p > v;
            case '<': return p < v;
            case '>=': return p >= v;
            case '<=': return p <= v;
            default: return p === v;
          }
        }
        case 'key':
          return issue.key === v;
        default:
          return false;
      }
    })();
    return term.neg ? !r : r;
  }

  // ---------- routing ----------
  const routes = [];
  const add = (method, pattern, opts, handler) => {
    const { re, names } = compile(pattern);
    routes.push({ method, re, names, auth: opts.auth !== false, raw: !!opts.raw, handler });
  };
  const deleteIssueCascade = async (project, issue, user) => {
    const doomed = [issue, ...db.issues.filter((c) => c.parentId === issue.id)];
    for (const d of doomed) await emit(project, 'issue.deleted', d, user.id);
    const ids = new Set(doomed.map((d) => d.id));
    const t = nowIso();
    for (const i of db.issues) {
      if (ids.has(i.id)) continue;
      if (i.epicId && ids.has(i.epicId)) {
        i.history.push({ field: 'epicId', from: i.epicId, to: null, actorId: user.id, at: t });
        i.epicId = null;
        i.updatedAt = t;
      }
    }
    db.issues = db.issues.filter((i) => !ids.has(i.id));
    db.comments = db.comments.filter((c) => !ids.has(c.issueId));
    db.links = db.links.filter((l) => !ids.has(l.from) && !ids.has(l.to));
  };

  // ----- auth -----
  add('POST', '/api/auth/register', { auth: false }, async ({ body }) => {
    const b = objBody(body);
    const username = reqString(b.username, 'username', { max: 32 });
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) throw bad('username must be 3-32 characters: letters, digits, _ . -');
    const password = reqString(b.password, 'password', { min: 8, max: 1000 });
    const displayName = b.displayName === undefined || b.displayName === null
      ? username : reqString(b.displayName, 'displayName', { max: 100 });
    if (findUserByName(username)) throw conflict('Username already taken', 'username_taken');
    const user = { id: newId(), username, displayName, passwordHash: hashPassword(password), createdAt: nowIso() };
    db.users.push(user);
    return ok({ user: pubUser(user) }, 201);
  });

  add('POST', '/api/auth/login', { auth: false }, async ({ body }) => {
    const b = objBody(body);
    const username = reqString(b.username, 'username', { max: 100 });
    const password = reqString(b.password, 'password', { max: 1000 });
    const key = username.toLowerCase();
    const t = nowD().getTime();
    db.loginFailures = db.loginFailures.filter((f) => t - Date.parse(f.at) < RATE_WINDOW_MS);
    if (db.loginFailures.filter((f) => f.username === key).length >= RATE_LIMIT) {
      throw new ApiError(429, 'rate_limited', 'Too many failed login attempts; try again later');
    }
    const user = findUserByName(username);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      db.loginFailures.push({ username: key, at: nowIso() });
      throw new ApiError(401, 'invalid_credentials', 'Invalid username or password');
    }
    db.loginFailures = db.loginFailures.filter((f) => f.username !== key);
    const token = randomToken('pms_');
    db.tokens.push({ id: newId(), userId: user.id, name: 'session', kind: 'session', hash: sha256(token), createdAt: nowIso(), lastUsedAt: null });
    return ok({ token, user: pubUser(user) });
  });

  add('POST', '/api/auth/logout', {}, async ({ tokenRec }) => {
    db.tokens = db.tokens.filter((t) => t.id !== tokenRec.id);
    return noContent();
  });

  add('GET', '/api/auth/me', {}, async ({ user }) => ok({ user: pubUser(user) }));

  add('PATCH', '/api/auth/me', {}, async ({ user, body }) => {
    const b = objBody(body);
    if (typeof b.currentPassword !== 'string' || !b.currentPassword) throw bad('currentPassword is required');
    if (!verifyPassword(b.currentPassword, user.passwordHash)) throw new ApiError(403, 'invalid_password', 'Current password is incorrect');
    if (b.displayName !== undefined) user.displayName = reqString(b.displayName, 'displayName', { max: 100 });
    if (b.password !== undefined) user.passwordHash = hashPassword(reqString(b.password, 'password', { min: 8, max: 1000 }));
    return ok({ user: pubUser(user) });
  });

  // ----- tokens -----
  add('POST', '/api/tokens', {}, async ({ user, body }) => {
    const b = objBody(body);
    const name = reqString(b.name, 'name', { max: 100 });
    const token = randomToken('pmt_');
    const rec = { id: newId(), userId: user.id, name, kind: 'api', hash: sha256(token), createdAt: nowIso(), lastUsedAt: null };
    db.tokens.push(rec);
    for (const ws of db.workspaces.filter((w) => wsRoleOf(w, user.id))) {
      audit(ws.id, user.id, 'token.created', { tokenId: rec.id, name });
    }
    return ok({ id: rec.id, name, token, createdAt: rec.createdAt }, 201);
  });

  add('GET', '/api/tokens', {}, async ({ user }) => ok(
    db.tokens.filter((t) => t.kind === 'api' && t.userId === user.id)
      .map((t) => ({ id: t.id, name: t.name, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt })),
  ));

  add('DELETE', '/api/tokens/:id', {}, async ({ user, params }) => {
    const rec = db.tokens.find((t) => t.id === params.id && t.kind === 'api' && t.userId === user.id);
    if (!rec) throw notFound('Token not found');
    db.tokens = db.tokens.filter((t) => t.id !== rec.id);
    for (const ws of db.workspaces.filter((w) => wsRoleOf(w, user.id))) {
      audit(ws.id, user.id, 'token.deleted', { tokenId: rec.id });
    }
    return noContent();
  });

  // ----- workspaces -----
  const wsOut = (ws, user) => ({ id: ws.id, name: ws.name, key: ws.key, createdAt: ws.createdAt, myRole: wsRoleOf(ws, user.id) });
  const memberOut = (m) => {
    const u = userById(m.userId);
    return { userId: m.userId, username: u ? u.username : null, displayName: u ? u.displayName : null, role: m.role };
  };

  add('GET', '/api/workspaces', {}, async ({ user }) => ok(
    db.workspaces.filter((w) => wsRoleOf(w, user.id)).map((w) => wsOut(w, user)),
  ));

  add('POST', '/api/workspaces', {}, async ({ user, body }) => {
    const b = objBody(body);
    const name = reqString(b.name, 'name', { max: 100 });
    const key = reqString(b.key, 'key', { max: 10 }).toUpperCase();
    if (!/^[A-Z]{2,10}$/.test(key)) throw bad('key must be 2-10 uppercase letters');
    if (db.workspaces.some((w) => w.key === key)) throw conflict('Workspace key already in use', 'key_taken');
    const ws = { id: newId(), name, key, createdAt: nowIso(), members: [{ userId: user.id, role: 'admin' }] };
    db.workspaces.push(ws);
    audit(ws.id, user.id, 'workspace.created', { name, key });
    return ok(wsOut(ws, user), 201);
  });

  add('GET', '/api/workspaces/:id', {}, async ({ user, params }) => {
    const ws = wsById(params.id);
    requireWs(user, ws, 'guest');
    return ok(wsOut(ws, user));
  });

  add('GET', '/api/workspaces/:id/members', {}, async ({ user, params }) => {
    const ws = wsById(params.id);
    requireWs(user, ws, 'guest');
    return ok(ws.members.map(memberOut));
  });

  add('POST', '/api/workspaces/:id/members', {}, async ({ user, params, body }) => {
    const ws = wsById(params.id);
    requireWs(user, ws, 'admin');
    const b = objBody(body);
    const target = typeof b.username === 'string' ? findUserByName(b.username) : userById(b.userId);
    if (!target) throw notFound('User not found');
    const role = pick(b.role ?? 'member', WS_ROLES, 'role');
    if (ws.members.some((m) => m.userId === target.id)) throw conflict('User is already a member', 'already_member');
    const m = { userId: target.id, role };
    ws.members.push(m);
    audit(ws.id, user.id, 'member.added', { userId: target.id, role });
    return ok(memberOut(m), 201);
  });

  const findMember = (ws, ref) => ws.members.find((m) => {
    if (m.userId === ref) return true;
    const u = userById(m.userId);
    return !!u && u.username.toLowerCase() === String(ref).toLowerCase();
  });

  add('PATCH', '/api/workspaces/:id/members/:ref', {}, async ({ user, params, body }) => {
    const ws = wsById(params.id);
    requireWs(user, ws, 'admin');
    const m = findMember(ws, params.ref);
    if (!m) throw notFound('Member not found');
    const b = objBody(body);
    const role = b.role === undefined ? m.role : pick(b.role, WS_ROLES, 'role');
    const admins = ws.members.filter((x) => x.role === 'admin').length;
    if (m.role === 'admin' && role !== 'admin' && admins === 1) throw bad('cannot demote the last admin', 'last_admin');
    if (role !== m.role) {
      m.role = role;
      audit(ws.id, user.id, 'member.updated', { userId: m.userId, role });
    }
    return ok(memberOut(m));
  });

  add('DELETE', '/api/workspaces/:id/members/:ref', {}, async ({ user, params }) => {
    const ws = wsById(params.id);
    requireWs(user, ws, 'admin');
    const m = findMember(ws, params.ref);
    if (!m) throw notFound('Member not found');
    const admins = ws.members.filter((x) => x.role === 'admin').length;
    if (m.role === 'admin' && admins === 1) throw bad('cannot remove the last admin', 'last_admin');
    ws.members = ws.members.filter((x) => x !== m);
    audit(ws.id, user.id, 'member.removed', { userId: m.userId });
    return noContent();
  });

  add('GET', '/api/workspaces/:id/audit', {}, async ({ user, params }) => {
    const ws = wsById(params.id);
    requireWs(user, ws, 'admin');
    return ok(db.audit.filter((a) => a.workspaceId === ws.id));
  });

  add('GET', '/api/workspaces/:id/projects', {}, async ({ user, params }) => {
    const ws = wsById(params.id);
    requireWs(user, ws, 'guest');
    return ok(db.projects.filter((p) => p.workspaceId === ws.id && projRoleOf(p, user)).map((p) => projOut(p, user)));
  });

  add('POST', '/api/workspaces/:id/projects', {}, async ({ user, params, body }) => {
    const ws = wsById(params.id);
    requireWs(user, ws, 'member');
    const b = objBody(body);
    const name = reqString(b.name, 'name', { max: 100 });
    const key = reqString(b.key, 'key', { max: 10 }).toUpperCase();
    if (!/^[A-Z]{2,10}$/.test(key)) throw bad('key must be 2-10 uppercase letters');
    if (db.projects.some((p) => p.key === key)) throw conflict('Project key already in use', 'key_taken');
    const project = {
      id: newId(),
      workspaceId: ws.id,
      name,
      key,
      createdAt: nowIso(),
      workflow: {
        statuses: DEFAULT_STATUSES.map((s) => ({ ...s })),
        transitions: allPairs(DEFAULT_STATUSES.map((s) => s.name)),
      },
      members: [{ userId: user.id, role: 'lead' }],
      nextNumber: 1,
    };
    db.projects.push(project);
    audit(ws.id, user.id, 'project.created', { projectId: project.id, key });
    return ok(projOut(project, user), 201);
  });

  const allPairs = (names) => {
    const out = [];
    for (const a of names) for (const b of names) if (a !== b) out.push([a, b]);
    return out;
  };

  // ----- projects -----
  add('GET', '/api/projects/:id', {}, async ({ user, params }) => {
    const p = projById(params.id);
    requireProj(p, user, 'viewer');
    return ok(projOut(p, user));
  });

  add('PATCH', '/api/projects/:id', {}, async ({ user, params, body }) => {
    const p = projById(params.id);
    requireProj(p, user, 'lead');
    const b = objBody(body);
    if (b.name !== undefined) p.name = reqString(b.name, 'name', { max: 100 });
    return ok(projOut(p, user));
  });

  add('GET', '/api/projects/:id/members', {}, async ({ user, params }) => {
    const p = projById(params.id);
    requireProj(p, user, 'viewer');
    return ok(projOut(p, user).members);
  });

  add('POST', '/api/projects/:id/members', {}, async ({ user, params, body }) => {
    const p = projById(params.id);
    requireProj(p, user, 'lead');
    const b = objBody(body);
    const target = typeof b.username === 'string' ? findUserByName(b.username) : userById(b.userId);
    if (!target) throw notFound('User not found');
    if (!wsRoleOf(wsOf(p), target.id)) throw bad('user must be a workspace member', 'not_workspace_member');
    const role = pick(b.role ?? 'developer', PROJ_ROLES, 'role');
    if (p.members.some((m) => m.userId === target.id)) throw conflict('User is already a project member', 'already_member');
    p.members.push({ userId: target.id, role });
    return ok(projOut(p, user).members.find((m) => m.userId === target.id), 201);
  });

  const findProjMember = (p, ref) => p.members.find((m) => {
    if (m.userId === ref) return true;
    const u = userById(m.userId);
    return !!u && u.username.toLowerCase() === String(ref).toLowerCase();
  });

  add('PATCH', '/api/projects/:id/members/:ref', {}, async ({ user, params, body }) => {
    const p = projById(params.id);
    requireProj(p, user, 'lead');
    const m = findProjMember(p, params.ref);
    if (!m) throw notFound('Project member not found');
    const b = objBody(body);
    if (b.role !== undefined) m.role = pick(b.role, PROJ_ROLES, 'role');
    return ok(projOut(p, user).members.find((x) => x.userId === m.userId));
  });

  add('DELETE', '/api/projects/:id/members/:ref', {}, async ({ user, params }) => {
    const p = projById(params.id);
    requireProj(p, user, 'lead');
    const m = findProjMember(p, params.ref);
    if (!m) throw notFound('Project member not found');
    p.members = p.members.filter((x) => x !== m);
    return noContent();
  });

  add('PUT', '/api/projects/:id/workflow', {}, async ({ user, params, body }) => {
    const p = projById(params.id);
    requireProj(p, user, 'lead');
    const b = objBody(body);
    if (!Array.isArray(b.statuses) || !b.statuses.length) throw bad('statuses must be a non-empty array');
    const statuses = b.statuses.map((s) => {
      if (!s || typeof s !== 'object') throw bad('each status must be an object');
      const name = reqString(s.name, 'status name', { max: 50 });
      return { name, category: pick(s.category, CATEGORIES, 'category') };
    });
    const names = statuses.map((s) => s.name);
    if (new Set(names).size !== names.length) throw bad('status names must be unique');
    let transitions;
    if (b.transitions === undefined || b.transitions === null) {
      transitions = allPairs(names);
    } else {
      if (!Array.isArray(b.transitions)) throw bad('transitions must be an array');
      transitions = b.transitions.map((t) => {
        if (!Array.isArray(t) || t.length !== 2 || !names.includes(t[0]) || !names.includes(t[1])) {
          throw bad('each transition must be [from, to] with existing statuses');
        }
        return [t[0], t[1]];
      });
    }
    const remap = b.remap === undefined || b.remap === null ? {} : b.remap;
    if (typeof remap !== 'object' || Array.isArray(remap)) throw bad('remap must be an object');
    const oldNames = p.workflow.statuses.map((s) => s.name);
    const removed = oldNames.filter((n) => !names.includes(n));
    const t = nowIso();
    const inProject = db.issues.filter((i) => i.projectId === p.id);
    // validate remaps before mutating anything
    const plan = new Map();
    for (const i of inProject) {
      if (names.includes(i.status)) continue;
      const target = remap[i.status];
      if (typeof target !== 'string' || !names.includes(target)) {
        throw bad(`status "${i.status}" is in use and must be remapped to a new status`, 'remap_required');
      }
      plan.set(i.id, target);
    }
    for (const n of removed) {
      if (typeof remap[n] === 'string' && !names.includes(remap[n])) throw bad(`remap target "${remap[n]}" is not a status`);
    }
    p.workflow = { statuses, transitions };
    for (const i of inProject) {
      const next = plan.get(i.id);
      const doneNow = categoryOf(p, next || i.status) === 'completed';
      if (next) {
        i.history.push({ field: 'status', from: i.status, to: next, actorId: user.id, at: t });
        i.status = next;
        i.updatedAt = t;
      }
      if (doneNow && !i.resolvedAt) i.resolvedAt = t;
      if (!doneNow && i.resolvedAt) i.resolvedAt = null;
    }
    audit(p.workspaceId, user.id, 'workflow.updated', { projectId: p.id, statuses: names });
    return ok(projOut(p, user).workflow);
  });

  // ----- issues in a project -----
  add('GET', '/api/projects/:id/issues', {}, async ({ user, params, query }) => {
    const p = projById(params.id);
    requireProj(p, user, 'viewer');
    let list = db.issues.filter((i) => i.projectId === p.id);
    const sprint = query.get('sprint');
    if (sprint === 'none') list = list.filter((i) => !i.sprintId);
    else if (sprint === 'active') {
      const active = db.sprints.find((s) => s.projectId === p.id && s.state === 'active');
      list = list.filter((i) => active && i.sprintId === active.id);
    } else if (sprint) list = list.filter((i) => i.sprintId === sprint);
    const status = query.get('status');
    if (status) list = list.filter((i) => i.status.toLowerCase() === status.toLowerCase());
    return ok(list.map(issueOut));
  });

  add('POST', '/api/projects/:id/issues', {}, async ({ user, params, body }) => {
    const p = projById(params.id);
    requireProj(p, user, 'developer');
    const issue = createIssue(p, user, objBody(body));
    await emit(p, 'issue.created', issue, user.id);
    return ok(issueDetail(issue), 201);
  });

  add('GET', '/api/projects/:id/stats', {}, async ({ user, params }) => {
    const p = projById(params.id);
    requireProj(p, user, 'viewer');
    const issues = db.issues.filter((i) => i.projectId === p.id);
    const byStatus = {};
    for (const s of p.workflow.statuses) byStatus[s.name] = 0;
    const byType = {};
    for (const t of ISSUE_TYPES) byType[t] = 0;
    const byAssignee = {};
    const cycle = [];
    for (const i of issues) {
      byStatus[i.status] = (byStatus[i.status] || 0) + 1;
      byType[i.type] = (byType[i.type] || 0) + 1;
      const a = i.assigneeId ? userById(i.assigneeId) : null;
      const aKey = a ? a.username : 'unassigned';
      byAssignee[aKey] = (byAssignee[aKey] || 0) + 1;
      if (i.resolvedAt) {
        const starts = i.history
          .filter((h) => h.field === 'status' && categoryOf(p, h.to) === 'started')
          .map((h) => Date.parse(h.at));
        if (!starts.length && categoryOf(p, i.initial.status) === 'started') starts.push(Date.parse(i.createdAt));
        if (starts.length) cycle.push((Date.parse(i.resolvedAt) - Math.min(...starts)) / 3600000);
      }
    }
    const avg = cycle.length ? Math.round((cycle.reduce((a, b) => a + b, 0) / cycle.length) * 100) / 100 : null;
    return ok({
      total: issues.length,
      byStatus,
      byType,
      byAssignee,
      avgCycleTimeHours: avg,
      averageCycleTimeHours: avg,
    });
  });

  add('GET', '/api/projects/:id/export.csv', {}, async ({ user, params }) => {
    const p = projById(params.id);
    requireProj(p, user, 'viewer');
    const issues = db.issues.filter((i) => i.projectId === p.id);
    const byId = new Map(issues.map((i) => [i.id, i]));
    const rows = [CSV_COLUMNS];
    for (const i of issues) {
      const a = i.assigneeId ? userById(i.assigneeId) : null;
      const sp = i.sprintId ? db.sprints.find((s) => s.id === i.sprintId) : null;
      rows.push([
        i.key, i.type, i.title, i.status, i.priority, a ? a.username : '', i.labels.join(';'),
        i.storyPoints ?? '', i.parentId && byId.get(i.parentId) ? byId.get(i.parentId).key : '',
        i.epicId && byId.get(i.epicId) ? byId.get(i.epicId).key : '', sp ? sp.name : '',
        i.dueDate || '', i.createdAt, i.resolvedAt || '',
      ]);
    }
    return { status: 200, raw: toCsv(rows), contentType: 'text/csv; charset=utf-8' };
  });

  add('POST', '/api/projects/:id/import.csv', { raw: true }, async ({ user, params, body }) => {
    const p = projById(params.id);
    requireProj(p, user, 'developer');
    const records = parseCsv(typeof body === 'string' ? body : '');
    if (!records.length) return ok({ created: 0, errors: [] });
    const header = records[0].fields.map((h) => h.trim().toLowerCase());
    const col = (name) => header.indexOf(name.toLowerCase());
    if (col('title') < 0) throw bad('CSV header must include a title column', 'invalid_csv');
    let created = 0;
    const errors = [];
    for (const rec of records.slice(1)) {
      const get = (name) => {
        const j = col(name);
        return j >= 0 && j < rec.fields.length ? rec.fields[j].trim() : '';
      };
      try {
        const sprintName = get('sprint');
        const sprint = sprintName ? db.sprints.find((s) => s.projectId === p.id && (s.id === sprintName || s.name === sprintName)) : null;
        if (sprintName && !sprint) throw bad(`Unknown sprint "${sprintName}"`);
        const parentKey = get('parent');
        const parent = parentKey ? findIssueInProject(p, parentKey) : null;
        if (parentKey && !parent) throw bad(`Unknown parent "${parentKey}"`);
        const epicKey = get('epic');
        const epic = epicKey ? findIssueInProject(p, epicKey) : null;
        if (epicKey && !epic) throw bad(`Unknown epic "${epicKey}"`);
        const assigneeName = get('assignee');
        let assigneeId = null;
        if (assigneeName) {
          const u = findUserByName(assigneeName);
          if (!u) throw bad(`Unknown assignee "${assigneeName}"`);
          assigneeId = u.id;
        }
        const storyRaw = get('storyPoints');
        createIssue(p, user, {
          type: get('type') || 'task',
          title: get('title'),
          status: get('status') || undefined,
          priority: get('priority') || 'none',
          assigneeId,
          labels: get('labels'),
          storyPoints: storyRaw === '' ? null : Number(storyRaw),
          parentId: parent ? parent.id : null,
          epicId: epic ? epic.id : null,
          sprintId: sprint ? sprint.id : null,
          dueDate: get('dueDate') || null,
        });
        created++;
        await emit(p, 'issue.created', db.issues[db.issues.length - 1], user.id);
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        errors.push({ line: rec.line, message: e.message });
      }
    }
    return ok({ created, errors });
  });

  // ----- sprints -----
  add('GET', '/api/projects/:id/sprints', {}, async ({ user, params }) => {
    const p = projById(params.id);
    requireProj(p, user, 'viewer');
    return ok(db.sprints.filter((s) => s.projectId === p.id).map(sprintOut));
  });

  add('POST', '/api/projects/:id/sprints', {}, async ({ user, params, body }) => {
    const p = projById(params.id);
    requireProj(p, user, 'developer');
    const b = objBody(body);
    const name = reqString(b.name, 'name', { max: 100 });
    const startDate = b.startDate === undefined || b.startDate === null ? null : parseDay(b.startDate);
    const endDate = b.endDate === undefined || b.endDate === null ? null : parseDay(b.endDate);
    if (b.startDate && !startDate) throw bad('startDate must be YYYY-MM-DD');
    if (b.endDate && !endDate) throw bad('endDate must be YYYY-MM-DD');
    if (startDate && endDate && endDate < startDate) throw bad('endDate must not be before startDate');
    const s = {
      id: newId(), projectId: p.id, name, state: 'planned', startDate, endDate,
      startedAt: null, completedAt: null, createdAt: nowIso(),
    };
    db.sprints.push(s);
    return ok(sprintOut(s), 201);
  });

  add('GET', '/api/sprints/:id', {}, async ({ user, params }) => {
    const s = sprintById(params.id);
    requireProj(projById(s.projectId), user, 'viewer');
    return ok(sprintOut(s));
  });

  add('POST', '/api/sprints/:id/start', {}, async ({ user, params }) => {
    const s = sprintById(params.id);
    requireProj(projById(s.projectId), user, 'developer');
    if (s.state !== 'planned') throw conflict(`Sprint is ${s.state}`, 'invalid_state');
    if (db.sprints.some((x) => x.projectId === s.projectId && x.state === 'active')) {
      throw conflict('Project already has an active sprint', 'active_sprint_exists');
    }
    const t = nowIso();
    s.state = 'active';
    s.startedAt = t;
    if (!s.startDate) s.startDate = dayOf(new Date(t));
    return ok(sprintOut(s));
  });

  add('POST', '/api/sprints/:id/complete', {}, async ({ user, params, body }) => {
    const s = sprintById(params.id);
    const p = projById(s.projectId);
    requireProj(p, user, 'developer');
    if (s.state !== 'active') throw conflict(`Sprint is ${s.state}`, 'invalid_state');
    const b = objBody(body);
    let target = null;
    if (b.carryOverTo !== undefined && b.carryOverTo !== null && b.carryOverTo !== 'backlog') {
      target = db.sprints.find((x) => x.id === b.carryOverTo && x.projectId === p.id && x.id !== s.id);
      if (!target || target.state === 'completed') throw bad('carryOverTo must be "backlog" or an open sprint in this project');
    }
    const t = nowIso();
    const unfinished = db.issues.filter((i) => i.projectId === p.id && i.sprintId === s.id && categoryOf(p, i.status) !== 'completed');
    for (const i of unfinished) {
      const to = target ? target.id : null;
      i.history.push({ field: 'sprintId', from: s.id, to, actorId: user.id, at: t });
      i.sprintId = to;
      i.updatedAt = t;
    }
    s.state = 'completed';
    s.completedAt = t;
    return ok(sprintOut(s));
  });

  add('GET', '/api/sprints/:id/report', {}, async ({ user, params }) => {
    const s = sprintById(params.id);
    requireProj(projById(s.projectId), user, 'viewer');
    return ok(sprintReport(s));
  });

  // ----- webhooks -----
  const webhookOut = (w) => ({ id: w.id, projectId: w.projectId, url: w.url, events: [...w.events], createdAt: w.createdAt });

  add('GET', '/api/projects/:id/webhooks', {}, async ({ user, params }) => {
    const p = projById(params.id);
    requireProj(p, user, 'lead');
    return ok(db.webhooks.filter((w) => w.projectId === p.id).map(webhookOut));
  });

  add('POST', '/api/projects/:id/webhooks', {}, async ({ user, params, body }) => {
    const p = projById(params.id);
    requireProj(p, user, 'lead');
    const b = objBody(body);
    const url = reqString(b.url, 'url', { max: 2000 });
    let parsed;
    try { parsed = new URL(url); } catch { throw bad('url must be a valid http(s) URL'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw bad('url must be http or https');
    if (!Array.isArray(b.events) || !b.events.length || b.events.some((e) => !WEBHOOK_EVENTS.includes(e))) {
      throw bad(`events must be a non-empty array of: ${WEBHOOK_EVENTS.join(', ')}`);
    }
    const secret = reqString(b.secret, 'secret', { max: 500 });
    const w = { id: newId(), projectId: p.id, url, events: [...new Set(b.events)], secret, createdAt: nowIso() };
    db.webhooks.push(w);
    audit(p.workspaceId, user.id, 'webhook.created', { projectId: p.id, webhookId: w.id, url });
    return ok(webhookOut(w), 201);
  });

  const webhookById = (id) => {
    const w = db.webhooks.find((x) => x.id === id);
    if (!w) throw notFound('Webhook not found');
    return w;
  };

  add('DELETE', '/api/webhooks/:id', {}, async ({ user, params }) => {
    const w = webhookById(params.id);
    const p = projById(w.projectId);
    requireProj(p, user, 'lead');
    db.webhooks = db.webhooks.filter((x) => x !== w);
    audit(p.workspaceId, user.id, 'webhook.deleted', { projectId: p.id, webhookId: w.id });
    return noContent();
  });

  add('GET', '/api/webhooks/:id/deliveries', {}, async ({ user, params }) => {
    const w = webhookById(params.id);
    requireProj(projById(w.projectId), user, 'lead');
    return ok(db.deliveries.filter((d) => d.webhookId === w.id).map((d) => ({
      id: d.id, webhookId: d.webhookId, event: d.event, status: d.status, attempts: d.attempts, lastError: d.lastError, createdAt: d.createdAt,
    })));
  });

  // ----- issues -----
  add('GET', '/api/issues/:key', {}, async ({ user, params }) => {
    const i = issueByKey(params.key);
    requireProj(projById(i.projectId), user, 'viewer');
    return ok(issueDetail(i));
  });

  add('PATCH', '/api/issues/:key', {}, async ({ user, params, body }) => {
    const issue = issueByKey(params.key);
    const project = projById(issue.projectId);
    requireProj(project, user, 'developer');
    const b = objBody(body);
    const t = nowIso();
    const changes = [];
    const set = (field, value) => {
      if (JSON.stringify(issue[field]) !== JSON.stringify(value)) changes.push({ field, from: issue[field], to: value });
    };

    // ---- validate everything first ----
    const type = b.type !== undefined ? pick(b.type, ISSUE_TYPES, 'type') : issue.type;
    if (type === 'subtask' && issue.type !== 'subtask' && db.issues.some((x) => x.parentId === issue.id)) {
      throw bad('an issue with subtasks cannot become a subtask');
    }
    if (issue.type === 'epic' && type !== 'epic' && db.issues.some((x) => x.epicId === issue.id)) {
      throw bad('an epic with linked issues cannot change type');
    }
    const parent = resolveParent(project, type, b.parentId !== undefined ? b.parentId : issue.parentId);
    const epic = resolveEpic(project, type, b.epicId !== undefined ? b.epicId : issue.epicId);
    let sprint;
    if (b.sprintId !== undefined && b.sprintId !== issue.sprintId) sprint = resolveSprint(project, b.sprintId);
    const title = b.title !== undefined ? reqString(b.title, 'title', { max: 500 }) : issue.title;
    const description = b.description !== undefined ? optString(b.description, 'description', 20000) : issue.description;
    const priority = b.priority !== undefined ? pick(b.priority, PRIORITIES, 'priority') : issue.priority;
    const assigneeId = (b.assigneeId !== undefined || b.assignee !== undefined)
      ? resolveAssignee(project, assigneeFromBody(b, issue.assigneeId)) : issue.assigneeId;
    const labels = b.labels !== undefined ? normLabels(b.labels) : issue.labels;
    const storyPoints = b.storyPoints !== undefined ? normPoints(b.storyPoints) : issue.storyPoints;
    const dueDate = b.dueDate !== undefined ? normDate(b.dueDate) : issue.dueDate;
    const newStatus = b.status !== undefined ? statusName(project, b.status) : issue.status;
    if (newStatus !== issue.status) {
      if (!project.workflow.transitions.some(([f, to]) => f === issue.status && to === newStatus)) {
        throw conflict(`Transition from "${issue.status}" to "${newStatus}" is not allowed`, 'invalid_transition');
      }
      const wasDone = categoryOf(project, issue.status) === 'completed';
      const nowDone = categoryOf(project, newStatus) === 'completed';
      if (nowDone && !wasDone && isBlocked(issue)) {
        throw conflict('Issue is blocked by unresolved issues', 'blocked');
      }
    }

    // ---- compute diffs ----
    set('title', title);
    set('description', description);
    set('type', type);
    set('priority', priority);
    set('assigneeId', assigneeId);
    set('labels', labels);
    set('storyPoints', storyPoints);
    set('parentId', parent ? parent.id : null);
    set('epicId', epic ? epic.id : null);
    if (b.sprintId !== undefined) set('sprintId', b.sprintId === null || b.sprintId === '' ? null : (sprint ? sprint.id : issue.sprintId));
    set('dueDate', dueDate);
    set('status', newStatus);
    if (!changes.length) return ok(issueDetail(issue));

    for (const c of changes) {
      issue[c.field] = c.to;
      issue.history.push({ field: c.field, from: c.from, to: c.to, actorId: user.id, at: t });
    }
    const done = categoryOf(project, issue.status) === 'completed';
    if (done && !issue.resolvedAt) issue.resolvedAt = t;
    if (!done) issue.resolvedAt = null;
    issue.updatedAt = t;
    if (issue.assigneeId && !issue.watchers.includes(issue.assigneeId)) issue.watchers.push(issue.assigneeId);
    if (changes.some((c) => c.field === 'status')) notify(issue.watchers, 'status_changed', issue, user.id);
    if (changes.some((c) => c.field === 'assigneeId')) notify(issue.watchers, 'assigned', issue, user.id);
    await emit(project, 'issue.updated', issue, user.id);
    return ok(issueDetail(issue));
  });

  add('DELETE', '/api/issues/:key', {}, async ({ user, params }) => {
    const issue = issueByKey(params.key);
    const project = projById(issue.projectId);
    requireProj(project, user, 'developer');
    await deleteIssueCascade(project, issue, user);
    return noContent();
  });

  add('GET', '/api/issues/:key/history', {}, async ({ user, params }) => {
    const issue = issueByKey(params.key);
    requireProj(projById(issue.projectId), user, 'viewer');
    return ok(issue.history.map((h) => ({ field: h.field, from: h.from, to: h.to, actorId: h.actorId, at: h.at })));
  });

  add('POST', '/api/issues/:key/links', {}, async ({ user, params, body }) => {
    const issue = issueByKey(params.key);
    requireProj(projById(issue.projectId), user, 'developer');
    const b = objBody(body);
    const type = pick(b.type, LINK_TYPES, 'type');
    const targetRef = String(b.target ?? '');
    const target = db.issues.find((x) => x.key === targetRef.toUpperCase()) || db.issues.find((x) => x.id === targetRef);
    if (!target) throw notFound('Target issue not found');
    if (target.id === issue.id) throw bad('an issue cannot link to itself');
    requireProj(projById(target.projectId), user, 'viewer');
    if (db.links.some((l) => l.type === type && l.from === issue.id && l.to === target.id)) {
      throw conflict('Link already exists', 'duplicate_link');
    }
    db.links.push({ id: newId(), type, from: issue.id, to: target.id, createdAt: nowIso() });
    return ok(issueDetail(issue), 201);
  });

  add('DELETE', '/api/issues/:key/links/:linkId', {}, async ({ user, params }) => {
    const issue = issueByKey(params.key);
    requireProj(projById(issue.projectId), user, 'developer');
    const link = db.links.find((l) => l.id === params.linkId && (l.from === issue.id || l.to === issue.id));
    if (!link) throw notFound('Link not found');
    db.links = db.links.filter((l) => l !== link);
    return noContent();
  });

  add('POST', '/api/issues/:key/watch', {}, async ({ user, params }) => {
    const issue = issueByKey(params.key);
    requireProj(projById(issue.projectId), user, 'viewer');
    if (!issue.watchers.includes(user.id)) issue.watchers.push(user.id);
    return ok({ watchers: [...issue.watchers] });
  });

  add('DELETE', '/api/issues/:key/watch', {}, async ({ user, params }) => {
    const issue = issueByKey(params.key);
    requireProj(projById(issue.projectId), user, 'viewer');
    issue.watchers = issue.watchers.filter((id) => id !== user.id);
    return ok({ watchers: [...issue.watchers] });
  });

  add('GET', '/api/issues/:key/comments', {}, async ({ user, params }) => {
    const issue = issueByKey(params.key);
    requireProj(projById(issue.projectId), user, 'viewer');
    return ok(db.comments.filter((c) => c.issueId === issue.id).map(commentOut));
  });

  add('POST', '/api/issues/:key/comments', {}, async ({ user, params, body }) => {
    const issue = issueByKey(params.key);
    const project = projById(issue.projectId);
    requireProj(project, user, 'developer');
    const b = objBody(body);
    const text = reqString(b.body ?? b.text, 'body', { max: 10000 });
    const t = nowIso();
    const c = { id: newId(), issueId: issue.id, authorId: user.id, body: text, createdAt: t, updatedAt: t, edited: false };
    db.comments.push(c);
    if (!issue.watchers.includes(user.id)) issue.watchers.push(user.id);
    const mentioned = new Set();
    for (const m of text.matchAll(/(^|[^A-Za-z0-9_@])@([A-Za-z0-9_-]+)/g)) {
      const u = findUserByName(m[2]);
      if (u && u.id !== user.id && projRoleOf(project, u)) mentioned.add(u.id);
    }
    notify([...mentioned], 'mentioned', issue, user.id);
    notify(issue.watchers.filter((id) => !mentioned.has(id)), 'commented', issue, user.id);
    await emit(project, 'comment.created', issue, user.id);
    return ok(commentOut(c), 201);
  });

  const commentById = (id) => {
    const c = db.comments.find((x) => x.id === id);
    if (!c) throw notFound('Comment not found');
    return c;
  };

  add('PATCH', '/api/comments/:id', {}, async ({ user, params, body }) => {
    const c = commentById(params.id);
    const issue = db.issues.find((x) => x.id === c.issueId);
    requireProj(projById(issue.projectId), user, 'viewer');
    if (c.authorId !== user.id) throw forbidden('Only the author can edit a comment');
    const b = objBody(body);
    c.body = reqString(b.body ?? b.text, 'body', { max: 10000 });
    c.edited = true;
    c.updatedAt = nowIso();
    return ok(commentOut(c));
  });

  add('DELETE', '/api/comments/:id', {}, async ({ user, params }) => {
    const c = commentById(params.id);
    const issue = db.issues.find((x) => x.id === c.issueId);
    const role = projRoleOf(projById(issue.projectId), user);
    if (!role) throw forbidden('No access to this project');
    if (c.authorId !== user.id && role !== 'lead') throw forbidden('Only the author or a project lead can delete a comment');
    db.comments = db.comments.filter((x) => x !== c);
    return noContent();
  });

  // ----- search -----
  add('GET', '/api/search', {}, async ({ user, query }) => {
    const terms = parseQuery(query.get('q') ?? '');
    const sort = query.get('sort') ?? 'updated';
    if (!['updated', 'created', 'priority'].includes(sort)) throw bad('sort must be updated, created or priority');
    let projects = db.projects.filter((p) => projRoleOf(p, user));
    const pf = query.get('project');
    if (pf) {
      const p = db.projects.find((x) => x.id === pf || x.key === pf.toUpperCase());
      if (!p) throw notFound('Project not found');
      if (!projRoleOf(p, user)) throw forbidden('No access to this project');
      projects = [p];
    }
    const ids = new Set(projects.map((p) => p.id));
    let results = db.issues.filter((i) => ids.has(i.projectId) && terms.every((t) => matchTerm(t, i, user)));
    if (sort === 'updated') results.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    else if (sort === 'created') results.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    else results.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]);
    return ok(results.map(issueOut));
  });

  // ----- notifications -----
  add('GET', '/api/notifications', {}, async ({ user, query }) => {
    const unreadOnly = query.get('unread') === 'true';
    const list = db.notifications
      .filter((n) => n.userId === user.id && (!unreadOnly || !n.read))
      .reverse()
      .map((n) => ({ id: n.id, type: n.type, issueKey: n.issueKey, actorId: n.actorId, at: n.at, read: n.read }));
    return ok(list);
  });

  add('POST', '/api/notifications/read', {}, async ({ user, body }) => {
    const b = objBody(body);
    let updated = 0;
    const ids = b.all === true ? null : (Array.isArray(b.ids) ? new Set(b.ids) : null);
    if (b.all !== true && !ids) throw bad('provide ids or all: true');
    for (const n of db.notifications) {
      if (n.userId !== user.id || n.read) continue;
      if (ids && !ids.has(n.id)) continue;
      n.read = true;
      updated++;
    }
    return ok({ updated });
  });

  // ---------- HTTP plumbing ----------
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png' };

  function serveStatic(pathname, res) {
    const rel = pathname === '/' ? 'index.html' : pathname.slice('/static/'.length);
    const file = path.normalize(path.join(STATIC_DIR, rel));
    if (!file.startsWith(STATIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      return send(res, { status: 404, body: { error: 'not_found', message: 'Not found' } });
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(fs.readFileSync(file));
  }

  function send(res, out) {
    if (out.raw !== undefined) {
      res.writeHead(out.status, { 'content-type': out.contentType || 'text/plain', 'content-disposition': 'attachment; filename="issues.csv"' });
      return res.end(out.raw);
    }
    if (out.status === 204 || out.body === undefined) {
      res.writeHead(out.status);
      return res.end();
    }
    res.writeHead(out.status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(out.body));
  }

  function sendError(res, e) {
    if (e instanceof ApiError) {
      return send(res, { status: e.status, body: { error: e.code, message: e.message } });
    }
    console.error(e);
    return send(res, { status: 500, body: { error: 'internal', message: 'Internal server error' } });
  }

  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(new ApiError(413, 'payload_too_large', 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  function authenticate(req) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    if (!m) throw new ApiError(401, 'unauthenticated', 'Missing bearer token');
    const hash = sha256(m[1]);
    const rec = db.tokens.find((t) => t.hash === hash);
    if (!rec) throw new ApiError(401, 'unauthenticated', 'Invalid token');
    const user = userById(rec.userId);
    if (!user) throw new ApiError(401, 'unauthenticated', 'Invalid token');
    rec.lastUsedAt = nowIso();
    return { user, tokenRec: rec };
  }

  async function dispatch(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/static/'))) {
      return serveStatic(url.pathname, res);
    }
    let matched = null;
    let params = {};
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(url.pathname);
      if (m) {
        matched = r;
        params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
        break;
      }
    }
    if (!matched) throw new ApiError(404, 'not_found', 'No such route');
    const raw = await readBody(req);
    const ctx = { params, query: url.searchParams, user: null, tokenRec: null, body: undefined };
    if (matched.auth) {
      const a = authenticate(req);
      ctx.user = a.user;
      ctx.tokenRec = a.tokenRec;
    }
    if (matched.raw) {
      ctx.body = raw;
    } else if (raw.length) {
      try {
        ctx.body = JSON.parse(raw);
      } catch {
        throw bad('Invalid JSON body', 'invalid_json');
      }
    }
    return matched.handler(ctx);
  }

  const server = http.createServer(async (req, res) => {
    let out;
    try {
      out = await dispatch(req, res);
      if (out === undefined) return;
      send(res, out);
    } catch (e) {
      if (!res.headersSent) sendError(res, e);
      else res.end();
    } finally {
      if (req.method !== 'GET' && dataFile) {
        try { persist(dataFile, db); } catch (e) { console.error('persist failed', e); }
      }
    }
  });
  return server;
}
