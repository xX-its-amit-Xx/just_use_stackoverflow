// pm-s4: JSON REST API on node:http plus static SPA. Stdlib only.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { regexToParams } from './vendor/regexparam.js';
import { loadDb, saveDb } from './store.js';
import { parseQuery, matches, QueryError } from './search.js';
import { toCsv, parseCsv } from './csv.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');

const WS_ROLES = ['admin', 'member', 'guest'];
const PROJ_ROLES = ['lead', 'developer', 'viewer'];
const RANK = { viewer: 1, developer: 2, lead: 3 };
const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'];
const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const CATEGORIES = ['backlog', 'unstarted', 'started', 'completed'];
const EVENTS = ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'];
const LINK_TYPES = ['blocks', 'relates', 'duplicates'];
const INVERSE_LINK = { blocks: 'blocked_by', relates: 'relates', duplicates: 'duplicated_by' };
const DEFAULT_STATUSES = [
  { name: 'Backlog', category: 'backlog' },
  { name: 'Todo', category: 'unstarted' },
  { name: 'In Progress', category: 'started' },
  { name: 'In Review', category: 'started' },
  { name: 'Done', category: 'completed' },
];
const ISSUE_FIELDS = ['type', 'title', 'description', 'status', 'priority', 'assigneeId', 'labels', 'storyPoints', 'parentId', 'epicId', 'sprintId', 'dueDate'];
const CSV_HEADER = ['key', 'type', 'title', 'status', 'priority', 'assignee', 'labels', 'storyPoints', 'parent', 'epic', 'sprint', 'dueDate', 'createdAt', 'resolvedAt'];
const USERNAME_RE = /^[a-zA-Z0-9_]+(?:[.-][a-zA-Z0-9_]+)*$/;
const KEY_RE = /^[A-Z]{2,10}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const MAX_BODY = 5 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export class ApiError extends Error {
  constructor(status, error, message) {
    super(message || error);
    this.status = status;
    this.error = error;
  }
}
const bad = (m) => new ApiError(400, 'validation_failed', m);
const forbidden = (m = 'forbidden') => new ApiError(403, 'forbidden', m);
const notFound = (m = 'not found') => new ApiError(404, 'not_found', m);
const conflict = (code, m) => new ApiError(409, code, m || code);

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const isStr = (v, max = 500) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;
const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sum = (arr, f) => arr.reduce((acc, x) => acc + (f(x) || 0), 0);
const round2 = (n) => Math.round(n * 100) / 100;

function isDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, passwordHash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
function checkPassword(user, pw) {
  const got = crypto.scryptSync(pw, user.salt, 64);
  const want = Buffer.from(user.passwordHash, 'hex');
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

function parseJsonBody(raw) {
  if (!raw || !raw.trim()) return {};
  let v;
  try {
    v = JSON.parse(raw);
  } catch {
    throw bad('invalid JSON body');
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw bad('JSON object expected');
  return v;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new ApiError(413, 'payload_too_large', 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, status, payload, type = 'application/json; charset=utf-8') {
  if (status === 204) {
    res.writeHead(204);
    res.end();
    return;
  }
  const body = type.startsWith('application/json') ? JSON.stringify(payload) : payload;
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

export function createServer({ dataFile, clock } = {}) {
  const db = loadDb(dataFile);
  const now = () => (clock ? clock() : new Date());
  const iso = () => now().toISOString();
  const uid = () => crypto.randomUUID();
  const persist = () => {
    try {
      saveDb(dataFile, db);
    } catch (err) {
      console.error('failed to persist state:', err);
    }
  };

  // ---------- lookups ----------
  const userById = (id) => db.users.find((u) => u.id === id);
  const userByName = (name) => db.users.find((u) => u.username === String(name).toLowerCase());
  const wsById = (id) => db.workspaces.find((w) => w.id === id);
  const projectById = (id) => db.projects.find((p) => p.id === id);
  const issueById = (id) => db.issues.find((i) => i.id === id);
  const issueByKey = (key) => db.issues.find((i) => i.key === String(key).toUpperCase());
  const sprintById = (id) => db.sprints.find((s) => s.id === id);
  const wsMember = (ws, userId) => ws.members.find((m) => m.userId === userId);

  // ---------- access control ----------
  // Workspace admins act as project leads; workspace members without an explicit project role
  // act as developers; guests see only explicitly added projects.
  function projectRole(user, project) {
    const ws = wsById(project.workspaceId);
    const wm = ws && wsMember(ws, user.id);
    if (!wm) return null;
    if (wm.role === 'admin') return 'lead';
    const pm = project.members.find((m) => m.userId === user.id);
    if (pm) return pm.role;
    return wm.role === 'member' ? 'developer' : null;
  }
  const canSee = (user, project) => !!projectRole(user, project);

  function projectAccess(user, pid, min = 'viewer') {
    const project = projectById(pid);
    if (!project) throw notFound('project not found');
    const role = projectRole(user, project);
    if (!role || RANK[role] < RANK[min]) throw forbidden();
    return { project, role };
  }
  function issueAccess(user, key, min = 'viewer') {
    const issue = issueByKey(key);
    if (!issue) throw notFound('issue not found');
    const project = projectById(issue.projectId);
    const role = projectRole(user, project);
    if (!role || RANK[role] < RANK[min]) throw forbidden();
    return { issue, project, role };
  }
  function sprintAccess(user, sid, min = 'viewer') {
    const sprint = sprintById(sid);
    if (!sprint) throw notFound('sprint not found');
    projectAccess(user, sprint.projectId, min);
    return sprint;
  }
  function wsAccess(user, wid, adminOnly = false) {
    const ws = wsById(wid);
    if (!ws) throw notFound('workspace not found');
    const m = wsMember(ws, user.id);
    if (!m) throw forbidden();
    if (adminOnly && m.role !== 'admin') throw forbidden('workspace admin required');
    return { ws, role: m.role };
  }
  const visibleProjects = (user) => db.projects.filter((p) => canSee(user, p));

  // ---------- audit ----------
  function audit(ws, actorId, action, details = {}) {
    db.audit.push({ id: uid(), workspaceId: ws.id, actorId, action, details, at: iso() });
  }
  function auditUser(userId, action, details) {
    for (const ws of db.workspaces) if (wsMember(ws, userId)) audit(ws, userId, action, details);
  }

  // ---------- views ----------
  const userRef = (u) => ({ id: u.id, username: u.username, displayName: u.displayName });
  const workspaceView = (ws, userId) => ({
    id: ws.id,
    name: ws.name,
    key: ws.key,
    role: wsMember(ws, userId)?.role ?? null,
    createdAt: ws.createdAt,
  });
  const projectView = (p, role) => ({
    id: p.id,
    workspaceId: p.workspaceId,
    name: p.name,
    key: p.key,
    workflow: p.workflow,
    members: p.members.map((m) => ({ userId: m.userId, username: userById(m.userId)?.username ?? null, role: m.role })),
    ...(role !== undefined ? { myRole: role } : {}),
    createdAt: p.createdAt,
    updatedAt: p.updatedAt,
  });
  const issueView = (i) => ({
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
  const sprintView = (s) => ({
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
  const commentView = (c, issueKey) => ({
    id: c.id,
    issueId: c.issueId,
    issueKey,
    authorId: c.authorId,
    body: c.body,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    edited: c.edited,
  });
  const notificationView = (n) => ({ id: n.id, type: n.type, issueKey: n.issueKey, actorId: n.actorId, at: n.at, read: n.read });
  const hookView = (h) => ({ id: h.id, projectId: h.projectId, url: h.url, events: [...h.events], createdAt: h.createdAt });

  // ---------- workflow helpers ----------
  const statusOf = (project, name) => project.workflow.statuses.find((s) => s.name === name);
  const catOf = (project, name) => statusOf(project, name)?.category ?? null;
  const initialStatus = (project) =>
    (project.workflow.statuses.find((s) => s.category === 'unstarted') || project.workflow.statuses[0]).name;
  const allPairs = (names) => names.flatMap((a) => names.filter((b) => b !== a).map((b) => [a, b]));

  // ---------- links / blocking ----------
  function linksOf(issue, user) {
    const out = [];
    for (const l of db.links) {
      if (l.from === issue.id) {
        const o = issueById(l.to);
        if (o && canSee(user, projectById(o.projectId))) out.push({ id: l.id, type: l.type, key: o.key });
      } else if (l.to === issue.id) {
        const o = issueById(l.from);
        if (o && canSee(user, projectById(o.projectId))) out.push({ id: l.id, type: INVERSE_LINK[l.type], key: o.key });
      }
    }
    return out;
  }
  function blockersOf(issue) {
    return db.links
      .filter((l) => l.type === 'blocks' && l.to === issue.id)
      .map((l) => issueById(l.from))
      .filter((b) => b && catOf(projectById(b.projectId), b.status) !== 'completed');
  }
  function issueDetail(issue, user) {
    const project = projectById(issue.projectId);
    const v = issueView(issue);
    v.children = db.issues
      .filter((c) => c.parentId === issue.id)
      .sort((a, b) => a.number - b.number)
      .map((c) => c.key);
    if (issue.type === 'epic') {
      const kids = db.issues.filter((c) => c.epicId === issue.id);
      const done = kids.filter((c) => catOf(project, c.status) === 'completed');
      v.progress = {
        total: kids.length,
        done: done.length,
        points_total: sum(kids, (c) => c.storyPoints),
        points_done: sum(done, (c) => c.storyPoints),
      };
    }
    v.links = linksOf(issue, user);
    return v;
  }

  // ---------- history ----------
  const historyOf = (issue) => db.history.filter((h) => h.issueId === issue.id);
  function recordChange(issue, field, from, to, actorId, t) {
    db.history.push({ id: uid(), issueId: issue.id, field, from, to, actorId, at: t });
  }
  // Applies a status change (history + resolvedAt bookkeeping). Transition checks are the caller's job.
  // fromCat/toCat are the status categories before and after, so callers can pass whichever workflow applies.
  function applyStatus(issue, to, fromCat, toCat, actorId, t) {
    const from = issue.status;
    if (from === to) return;
    recordChange(issue, 'status', from, to, actorId, t);
    issue.status = to;
    const wasDone = fromCat === 'completed';
    const nowDone = toCat === 'completed';
    if (nowDone && !wasDone) issue.resolvedAt = t;
    else if (!nowDone) issue.resolvedAt = null;
    issue.updatedAt = t;
  }

  // ---------- notifications & webhooks ----------
  function notify(userIds, type, issue, actorId) {
    const t = iso();
    const project = projectById(issue.projectId);
    for (const recipient of new Set(userIds)) {
      if (recipient === actorId) continue;
      const u = userById(recipient);
      if (!u || !canSee(u, project)) continue;
      db.notifications.push({ id: uid(), seq: ++db.seq, userId: recipient, type, issueKey: issue.key, actorId, at: t, read: false });
    }
  }

  function emit(project, event, issue, actorId) {
    const hooks = db.webhooks.filter((w) => w.projectId === project.id && w.events.includes(event));
    for (const hook of hooks) {
      const delivery = { id: uid(), webhookId: hook.id, event, status: null, attempts: 0, lastError: null, at: iso() };
      db.deliveries.push(delivery);
      const body = JSON.stringify({ event, issue: issueView(issue), actorId, at: iso() });
      deliver(hook, delivery, body).catch((err) => console.error('webhook delivery error:', err));
    }
  }

  async function deliver(hook, delivery, body) {
    const sig = `sha256=${crypto.createHmac('sha256', hook.secret).update(body).digest('hex')}`;
    for (let attempt = 1; attempt <= 3; attempt++) {
      delivery.attempts = attempt;
      try {
        const res = await fetch(hook.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-pm-signature': sig, 'x-pm-event': delivery.event },
          body,
          signal: AbortSignal.timeout(5000),
        });
        await res.arrayBuffer().catch(() => {});
        delivery.status = res.status;
        delivery.lastError = res.ok ? null : `HTTP ${res.status}`;
        if (res.ok) break;
      } catch (err) {
        delivery.status = null;
        delivery.lastError = String(err?.message || err);
      }
      persist();
      if (attempt < 3) await new Promise((r) => setTimeout(r, 100 * attempt));
    }
    persist();
  }

  // ---------- issue field resolution ----------
  function resolveRef(project, ref) {
    if (ref == null || ref === '') return null;
    const it = db.issues.find((i) => i.projectId === project.id && (i.id === ref || i.key === String(ref).toUpperCase()));
    if (!it) throw bad(`unknown issue reference "${ref}"`);
    return it;
  }

  // Returns the full, validated field set for an issue after applying body `b` onto `current`
  // (or onto defaults when creating).
  function resolveFields(project, b, current) {
    const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
    const f = current
      ? {
          type: current.type,
          title: current.title,
          description: current.description,
          status: current.status,
          priority: current.priority,
          assigneeId: current.assigneeId,
          labels: [...current.labels],
          storyPoints: current.storyPoints,
          parentId: current.parentId,
          epicId: current.epicId,
          sprintId: current.sprintId,
          dueDate: current.dueDate,
        }
      : {
          type: 'task',
          title: null,
          description: '',
          status: initialStatus(project),
          priority: 'none',
          assigneeId: null,
          labels: [],
          storyPoints: null,
          parentId: null,
          epicId: null,
          sprintId: null,
          dueDate: null,
        };

    if (has('type')) {
      if (!TYPES.includes(b.type)) throw bad('invalid type');
      f.type = b.type;
    }
    if (has('title')) {
      if (!isStr(b.title, 500)) throw bad('title must be a non-empty string');
      f.title = b.title.trim();
    }
    if (!f.title) throw bad('title is required');
    if (has('description')) {
      if (b.description != null && typeof b.description !== 'string') throw bad('description must be a string');
      f.description = b.description ?? '';
    }
    if (has('status')) {
      if (!statusOf(project, b.status)) throw bad(`unknown status "${b.status}"`);
      f.status = b.status;
    }
    if (has('priority')) {
      if (!PRIORITIES.includes(b.priority)) throw bad('invalid priority');
      f.priority = b.priority;
    }
    if (has('assigneeId') || has('assignee')) {
      const useId = has('assigneeId');
      const raw = useId ? b.assigneeId : b.assignee;
      if (raw == null || raw === '') {
        f.assigneeId = null;
      } else {
        const u = useId ? userById(raw) : userByName(raw);
        if (!u || !canSee(u, project)) throw bad('assignee must be a project member');
        f.assigneeId = u.id;
      }
    }
    if (has('labels')) {
      if (!Array.isArray(b.labels) || b.labels.some((l) => !isStr(l, 50))) throw bad('labels must be non-empty strings');
      f.labels = [...new Set(b.labels.map((l) => l.trim()))];
    }
    if (has('storyPoints')) {
      if (b.storyPoints != null && (typeof b.storyPoints !== 'number' || !Number.isFinite(b.storyPoints) || b.storyPoints < 0)) {
        throw bad('storyPoints must be a non-negative number');
      }
      f.storyPoints = b.storyPoints ?? null;
    }
    if (has('parentId')) f.parentId = resolveRef(project, b.parentId)?.id ?? null;
    if (has('epicId')) {
      const e = resolveRef(project, b.epicId);
      if (e && e.type !== 'epic') throw bad('epicId must reference an epic');
      f.epicId = e?.id ?? null;
    }
    if (has('sprintId')) {
      if (b.sprintId == null || b.sprintId === '') {
        f.sprintId = null;
      } else {
        const s = db.sprints.find((x) => x.id === b.sprintId && x.projectId === project.id);
        if (!s) throw bad('unknown sprint');
        f.sprintId = s.id;
      }
    }
    if (has('dueDate')) {
      if (b.dueDate != null && !isDate(b.dueDate)) throw bad('dueDate must be YYYY-MM-DD');
      f.dueDate = b.dueDate ?? null;
    }

    // invariants
    if (f.type === 'subtask' && !f.parentId) throw bad('subtasks require a non-subtask parent');
    if (f.type !== 'subtask' && f.parentId) throw bad('only subtasks can have a parent');
    if (f.parentId) {
      const parent = issueById(f.parentId);
      if (parent.type === 'subtask') throw bad('parent cannot be a subtask');
      if (current && parent.id === current.id) throw bad('issue cannot be its own parent');
    }
    if (f.type === 'epic' && f.epicId) throw bad('epics cannot belong to an epic');
    if (f.epicId && current && f.epicId === current.id) throw bad('issue cannot be its own epic');
    if (current && current.type === 'epic' && f.type !== 'epic' && db.issues.some((c) => c.epicId === current.id)) {
      throw bad('epic still has issues assigned to it');
    }
    if (current && f.type === 'subtask' && current.type !== 'subtask' && db.issues.some((c) => c.parentId === current.id)) {
      throw bad('issue has subtasks and cannot become a subtask');
    }
    return f;
  }

  function createIssue(project, b, actorId) {
    const f = resolveFields(project, b, null);
    const number = project.nextNumber;
    project.nextNumber += 1;
    const t = iso();
    const issue = {
      id: uid(),
      number,
      key: `${project.key}-${number}`,
      projectId: project.id,
      ...f,
      reporterId: actorId,
      watchers: [actorId],
      createdAt: t,
      updatedAt: t,
      resolvedAt: catOf(project, f.status) === 'completed' ? t : null,
    };
    if (issue.assigneeId && !issue.watchers.includes(issue.assigneeId)) issue.watchers.push(issue.assigneeId);
    db.issues.push(issue);
    project.updatedAt = t;
    emit(project, 'issue.created', issue, actorId);
    if (issue.assigneeId && issue.assigneeId !== actorId) notify([issue.assigneeId], 'assignment', issue, actorId);
    return issue;
  }

  // ---------- statistics & reports ----------
  function historyMap() {
    const m = new Map();
    for (const h of db.history) {
      if (!m.has(h.issueId)) m.set(h.issueId, []);
      m.get(h.issueId).push(h);
    }
    return m;
  }
  // Reconstructs the tracked fields of an issue as of time t (ms) from its history.
  function stateAt(issue, t, hist) {
    const st = {};
    for (const field of ['status', 'storyPoints', 'sprintId']) {
      const first = hist.find((h) => h.field === field);
      st[field] = first ? first.from : issue[field];
    }
    for (const h of hist) if (Date.parse(h.at) <= t && h.field in st) st[h.field] = h.to;
    st.exists = Date.parse(issue.createdAt) <= t;
    return st;
  }

  function sprintReport(sprint) {
    const project = projectById(sprint.projectId);
    const issues = db.issues.filter((i) => i.projectId === project.id);
    const hm = historyMap();
    const H = (i) => hm.get(i.id) || [];

    const startT = sprint.startedAt ? Date.parse(sprint.startedAt) : now().getTime();
    const committed = issues.filter((i) => {
      const s = stateAt(i, startT, H(i));
      return s.exists && s.sprintId === sprint.id;
    });
    const inSprint = issues.filter((i) => i.sprintId === sprint.id);
    const done = inSprint.filter((i) => catOf(project, i.status) === 'completed');

    const today = iso().slice(0, 10);
    const start = sprint.startDate || (sprint.startedAt || sprint.createdAt).slice(0, 10);
    let end = today;
    if (sprint.endDate && sprint.endDate < end) end = sprint.endDate;
    const burndown = [];
    for (let d = start; d <= end; d = addDays(d, 1)) {
      const t = Date.parse(`${d}T23:59:59.999Z`);
      let remaining = 0;
      for (const i of issues) {
        const s = stateAt(i, t, H(i));
        if (s.exists && s.sprintId === sprint.id && catOf(project, s.status) !== 'completed') remaining += s.storyPoints || 0;
      }
      burndown.push({ date: d, remainingPoints: remaining });
    }

    return {
      committedPoints: sum(committed, (i) => i.storyPoints),
      completedPoints: sum(done, (i) => i.storyPoints),
      completedIssues: done.length,
      carriedOver: sprint.carriedOver || 0,
      burndown,
    };
  }

  function projectStats(project) {
    const issues = db.issues.filter((i) => i.projectId === project.id);
    const byStatus = Object.fromEntries(project.workflow.statuses.map((s) => [s.name, 0]));
    const byType = Object.fromEntries(TYPES.map((t) => [t, 0]));
    const byAssignee = {};
    for (const i of issues) {
      byStatus[i.status] = (byStatus[i.status] || 0) + 1;
      byType[i.type] = (byType[i.type] || 0) + 1;
      const name = i.assigneeId ? userById(i.assigneeId)?.username ?? 'unassigned' : 'unassigned';
      byAssignee[name] = (byAssignee[name] || 0) + 1;
    }
    const hm = historyMap();
    const hours = [];
    for (const i of issues) {
      if (!i.resolvedAt) continue;
      const hist = hm.get(i.id) || [];
      const firstFrom = hist.find((h) => h.field === 'status');
      const initial = firstFrom ? firstFrom.from : i.status;
      let started = catOf(project, initial) === 'started' ? i.createdAt : null;
      if (!started) {
        const h = hist.find((x) => x.field === 'status' && catOf(project, x.to) === 'started');
        if (h) started = h.at;
      }
      if (started) hours.push((Date.parse(i.resolvedAt) - Date.parse(started)) / 3600000);
    }
    return {
      total: issues.length,
      byStatus,
      byType,
      byAssignee,
      avgCycleTimeHours: hours.length ? round2(hours.reduce((a, b) => a + b, 0) / hours.length) : null,
    };
  }

  // ---------- CSV ----------
  function rowToInput(project, row) {
    const input = { title: row.title, type: row.type || 'task', priority: row.priority || 'none' };
    if (row.description) input.description = row.description;
    if (row.status) input.status = row.status;
    if (row.assignee) input.assignee = row.assignee;
    if (row.labels) input.labels = row.labels.split(';').map((s) => s.trim()).filter(Boolean);
    if (row.storypoints) {
      const n = Number(row.storypoints);
      if (!Number.isFinite(n)) throw bad('invalid storyPoints');
      input.storyPoints = n;
    }
    if (row.parent) input.parentId = row.parent;
    if (row.epic) input.epicId = row.epic;
    if (row.sprint) {
      const s = db.sprints.find((x) => x.projectId === project.id && (x.id === row.sprint || x.name === row.sprint));
      if (!s) throw bad(`unknown sprint "${row.sprint}"`);
      input.sprintId = s.id;
    }
    if (row.duedate) input.dueDate = row.duedate;
    return input;
  }

  // ---------- routing ----------
  const routes = [];
  const route = (method, pattern, handler, auth = true) => {
    const { keys, pattern: re } = regexToParams(pattern);
    routes.push({ method, keys, re, handler, auth });
  };

  // ===== auth =====
  route('POST', '/api/auth/register', ({ body }) => {
    const b = body();
    if (typeof b.username !== 'string' || b.username.length < 3 || b.username.length > 32 || !USERNAME_RE.test(b.username)) {
      throw bad('username must be 3-32 letters, digits, underscore, dot or hyphen');
    }
    if (typeof b.password !== 'string' || b.password.length < 8) throw bad('password must be at least 8 characters');
    if (b.displayName != null && !isStr(b.displayName, 100)) throw bad('displayName must be a short string');
    const uname = b.username.toLowerCase();
    if (db.users.some((u) => u.username === uname)) throw conflict('username_taken', 'username already exists');
    const { salt, passwordHash } = hashPassword(b.password);
    const user = {
      id: uid(),
      username: uname,
      displayName: b.displayName ? b.displayName.trim() : b.username,
      salt,
      passwordHash,
      createdAt: iso(),
    };
    db.users.push(user);
    return [201, { user: userRef(user) }];
  }, false);

  route('POST', '/api/auth/login', ({ body }) => {
    const b = body();
    if (typeof b.username !== 'string' || typeof b.password !== 'string') throw bad('username and password required');
    const key = b.username.toLowerCase();
    const t = now().getTime();
    const fails = (db.loginFailures[key] || []).filter((x) => t - x < LOGIN_WINDOW_MS);
    db.loginFailures[key] = fails;
    if (fails.length >= LOGIN_MAX_FAILURES) throw new ApiError(429, 'rate_limited', 'too many failed login attempts; try again later');
    const user = userByName(key);
    if (!user || !checkPassword(user, b.password)) {
      fails.push(t);
      throw new ApiError(401, 'invalid_credentials', 'invalid username or password');
    }
    delete db.loginFailures[key];
    const token = crypto.randomBytes(32).toString('hex');
    db.sessions.push({ hash: sha256(token), userId: user.id, createdAt: iso() });
    return [200, { token, user: userRef(user) }];
  }, false);

  route('POST', '/api/auth/logout', ({ token }) => {
    const h = sha256(token);
    db.sessions = db.sessions.filter((s) => s.hash !== h);
    return [204];
  });

  route('GET', '/api/auth/me', ({ user }) => [200, { user: userRef(user) }]);

  route('PATCH', '/api/auth/me', ({ user, token, body }) => {
    const b = body();
    if (typeof b.currentPassword !== 'string') throw bad('currentPassword is required');
    const rec = userById(user.id);
    if (!checkPassword(rec, b.currentPassword)) throw forbidden('current password is incorrect');
    if (b.displayName !== undefined) {
      if (!isStr(b.displayName, 100)) throw bad('displayName must be a short string');
      rec.displayName = b.displayName.trim();
    }
    if (b.password !== undefined) {
      if (typeof b.password !== 'string' || b.password.length < 8) throw bad('password must be at least 8 characters');
      Object.assign(rec, hashPassword(b.password));
      // Other sessions of this user are signed out; the current one stays valid.
      const keep = sha256(token || '');
      db.sessions = db.sessions.filter((s) => s.userId !== rec.id || s.hash === keep);
    }
    return [200, { user: userRef(rec) }];
  });

  route('POST', '/api/tokens', ({ user, body }) => {
    const b = body();
    if (!isStr(b.name, 100)) throw bad('name is required');
    const token = `pmt_${crypto.randomBytes(24).toString('hex')}`;
    const rec = { id: uid(), name: b.name.trim(), userId: user.id, hash: sha256(token), createdAt: iso() };
    db.apiTokens.push(rec);
    auditUser(user.id, 'token.created', { tokenId: rec.id, name: rec.name });
    return [201, { id: rec.id, name: rec.name, token }];
  });

  route('GET', '/api/tokens', ({ user }) =>
    [200, db.apiTokens.filter((t) => t.userId === user.id).map((t) => ({ id: t.id, name: t.name, createdAt: t.createdAt }))]);

  route('DELETE', '/api/tokens/:id', ({ user, params }) => {
    const t = db.apiTokens.find((x) => x.id === params.id && x.userId === user.id);
    if (!t) throw notFound('token not found');
    db.apiTokens = db.apiTokens.filter((x) => x !== t);
    auditUser(user.id, 'token.deleted', { tokenId: t.id, name: t.name });
    return [204];
  });

  // ===== workspaces =====
  route('GET', '/api/workspaces', ({ user }) =>
    [200, db.workspaces.filter((w) => wsMember(w, user.id)).map((w) => workspaceView(w, user.id))]);

  route('POST', '/api/workspaces', ({ user, body }) => {
    const b = body();
    if (!isStr(b.name, 100)) throw bad('name is required');
    if (typeof b.key !== 'string' || !KEY_RE.test(b.key)) throw bad('key must be 2-10 uppercase letters');
    if (db.workspaces.some((w) => w.key === b.key)) throw conflict('key_taken', 'workspace key already in use');
    const ws = {
      id: uid(),
      name: b.name.trim(),
      key: b.key,
      members: [{ userId: user.id, role: 'admin' }],
      createdAt: iso(),
    };
    db.workspaces.push(ws);
    audit(ws, user.id, 'workspace.created', { key: ws.key });
    return [201, workspaceView(ws, user.id)];
  });

  route('GET', '/api/workspaces/:id', ({ user, params }) => {
    const { ws } = wsAccess(user, params.id);
    return [200, workspaceView(ws, user.id)];
  });

  route('GET', '/api/workspaces/:id/members', ({ user, params }) => {
    const { ws } = wsAccess(user, params.id);
    return [200, ws.members.map((m) => ({ ...userRef(userById(m.userId)), role: m.role }))];
  });

  const findMemberTarget = (ws, ref) => {
    const u = db.users.find((x) => x.id === ref || x.username === String(ref).toLowerCase());
    const m = u && wsMember(ws, u.id);
    if (!m) throw notFound('member not found');
    return { user: u, member: m };
  };

  route('POST', '/api/workspaces/:id/members', ({ user, params, body }) => {
    const { ws } = wsAccess(user, params.id, true);
    const b = body();
    if (typeof b.username !== 'string') throw bad('username is required');
    if (!WS_ROLES.includes(b.role)) throw bad('invalid role');
    const target = userByName(b.username);
    if (!target) throw notFound('user not found');
    if (wsMember(ws, target.id)) throw conflict('already_member', 'user is already a member');
    ws.members.push({ userId: target.id, role: b.role });
    audit(ws, user.id, 'member.added', { username: target.username, role: b.role });
    return [201, { ...userRef(target), role: b.role }];
  });

  route('PATCH', '/api/workspaces/:id/members/:userId', ({ user, params, body }) => {
    const { ws } = wsAccess(user, params.id, true);
    const { user: target, member } = findMemberTarget(ws, params.userId);
    const b = body();
    if (!WS_ROLES.includes(b.role)) throw bad('invalid role');
    if (member.role === 'admin' && b.role !== 'admin' && ws.members.filter((m) => m.role === 'admin').length === 1) {
      throw bad('the last admin cannot be demoted');
    }
    const from = member.role;
    member.role = b.role;
    audit(ws, user.id, 'member.role_changed', { username: target.username, from, to: b.role });
    return [200, { ...userRef(target), role: b.role }];
  });

  route('DELETE', '/api/workspaces/:id/members/:userId', ({ user, params }) => {
    const { ws } = wsAccess(user, params.id, true);
    const { user: target, member } = findMemberTarget(ws, params.userId);
    if (member.role === 'admin' && ws.members.filter((m) => m.role === 'admin').length === 1) {
      throw bad('the last admin cannot be removed');
    }
    ws.members = ws.members.filter((m) => m !== member);
    for (const p of db.projects.filter((x) => x.workspaceId === ws.id)) {
      p.members = p.members.filter((m) => m.userId !== target.id);
    }
    audit(ws, user.id, 'member.removed', { username: target.username });
    return [204];
  });

  route('GET', '/api/workspaces/:id/audit', ({ user, params }) => {
    const { ws } = wsAccess(user, params.id, true);
    return [200, db.audit.filter((a) => a.workspaceId === ws.id)];
  });

  route('GET', '/api/workspaces/:id/projects', ({ user, params }) => {
    const { ws } = wsAccess(user, params.id);
    return [200, db.projects.filter((p) => p.workspaceId === ws.id && canSee(user, p)).map((p) => projectView(p, projectRole(user, p)))];
  });

  route('POST', '/api/workspaces/:id/projects', ({ user, params, body }) => {
    const { ws, role } = wsAccess(user, params.id);
    if (role === 'guest') throw forbidden('guests cannot create projects');
    const b = body();
    if (!isStr(b.name, 100)) throw bad('name is required');
    if (typeof b.key !== 'string' || !KEY_RE.test(b.key)) throw bad('key must be 2-10 uppercase letters');
    if (db.projects.some((p) => p.key === b.key)) throw conflict('key_taken', 'project key already in use');
    const t = iso();
    const project = {
      id: uid(),
      workspaceId: ws.id,
      name: b.name.trim(),
      key: b.key,
      workflow: {
        statuses: DEFAULT_STATUSES.map((s) => ({ ...s })),
        transitions: allPairs(DEFAULT_STATUSES.map((s) => s.name)),
      },
      members: [{ userId: user.id, role: 'lead' }],
      nextNumber: 1,
      createdAt: t,
      updatedAt: t,
    };
    db.projects.push(project);
    audit(ws, user.id, 'project.created', { key: project.key });
    return [201, projectView(project, projectRole(user, project))];
  });

  // ===== projects =====
  route('GET', '/api/projects/:id', ({ user, params }) => {
    const { project, role } = projectAccess(user, params.id);
    return [200, projectView(project, role)];
  });

  route('GET', '/api/projects/:id/members', ({ user, params }) => {
    const { project } = projectAccess(user, params.id);
    return [200, projectView(project).members];
  });

  const findProjectMember = (project, ref) => {
    const u = db.users.find((x) => x.id === ref || x.username === String(ref).toLowerCase());
    const m = u && project.members.find((x) => x.userId === u.id);
    if (!m) throw notFound('project member not found');
    return { user: u, member: m };
  };

  route('POST', '/api/projects/:id/members', ({ user, params, body }) => {
    const { project } = projectAccess(user, params.id, 'lead');
    const b = body();
    const target = typeof b.username === 'string' ? userByName(b.username) : null;
    if (!target) throw notFound('user not found');
    const ws = wsById(project.workspaceId);
    if (!wsMember(ws, target.id)) throw bad('user is not a workspace member');
    if (!PROJ_ROLES.includes(b.role)) throw bad('invalid role');
    if (project.members.some((m) => m.userId === target.id)) throw conflict('already_member', 'user is already a project member');
    project.members.push({ userId: target.id, role: b.role });
    audit(ws, user.id, 'project.member.added', { project: project.key, username: target.username, role: b.role });
    return [201, { ...userRef(target), role: b.role }];
  });

  route('PATCH', '/api/projects/:id/members/:userId', ({ user, params, body }) => {
    const { project } = projectAccess(user, params.id, 'lead');
    const { user: target, member } = findProjectMember(project, params.userId);
    const b = body();
    if (!PROJ_ROLES.includes(b.role)) throw bad('invalid role');
    member.role = b.role;
    audit(wsById(project.workspaceId), user.id, 'project.member.role_changed', { project: project.key, username: target.username, to: b.role });
    return [200, { ...userRef(target), role: b.role }];
  });

  route('DELETE', '/api/projects/:id/members/:userId', ({ user, params }) => {
    const { project } = projectAccess(user, params.id, 'lead');
    const { user: target, member } = findProjectMember(project, params.userId);
    project.members = project.members.filter((m) => m !== member);
    audit(wsById(project.workspaceId), user.id, 'project.member.removed', { project: project.key, username: target.username });
    return [204];
  });

  route('PUT', '/api/projects/:id/workflow', ({ user, params, body }) => {
    const { project } = projectAccess(user, params.id, 'lead');
    const b = body();
    if (!Array.isArray(b.statuses) || b.statuses.length === 0) throw bad('statuses must be a non-empty array');
    const statuses = b.statuses.map((s) => {
      if (!s || !isStr(s.name, 50)) throw bad('each status needs a name');
      if (!CATEGORIES.includes(s.category)) throw bad('invalid status category');
      return { name: s.name.trim(), category: s.category };
    });
    const names = statuses.map((s) => s.name);
    if (new Set(names).size !== names.length) throw bad('status names must be unique');
    let transitions;
    if (b.transitions === undefined) {
      transitions = allPairs(names);
    } else {
      if (!Array.isArray(b.transitions)) throw bad('transitions must be an array');
      transitions = b.transitions.map((t) => {
        if (!Array.isArray(t) || t.length !== 2) throw bad('each transition must be [from, to]');
        if (!names.includes(t[0]) || !names.includes(t[1])) throw bad('transition references unknown status');
        return [t[0], t[1]];
      });
    }
    const remap = b.remap && typeof b.remap === 'object' ? b.remap : {};
    const removed = project.workflow.statuses.map((s) => s.name).filter((n) => !names.includes(n));
    const affected = db.issues.filter((i) => i.projectId === project.id && removed.includes(i.status));
    for (const i of affected) {
      const target = remap[i.status];
      if (!target || !names.includes(target)) throw bad(`status "${i.status}" is in use; provide a remap to an existing status`);
    }
    const t = iso();
    const newCatOf = (name) => statuses.find((s) => s.name === name)?.category ?? null;
    for (const i of affected) {
      const target = remap[i.status];
      applyStatus(i, target, catOf(project, i.status), newCatOf(target), user.id, t);
    }
    project.workflow = { statuses, transitions };
    project.updatedAt = t;
    audit(wsById(project.workspaceId), user.id, 'workflow.updated', { project: project.key, statuses: names.length, remapped: affected.length });
    return [200, projectView(project, projectRole(user, project))];
  });

  route('GET', '/api/projects/:id/stats', ({ user, params }) => {
    const { project } = projectAccess(user, params.id);
    return [200, projectStats(project)];
  });

  route('GET', '/api/projects/:id/issues', ({ user, params }) => {
    const { project } = projectAccess(user, params.id);
    return [200, db.issues.filter((i) => i.projectId === project.id).sort((a, b) => a.number - b.number).map(issueView)];
  });

  route('POST', '/api/projects/:id/issues', ({ user, params, body }) => {
    const { project } = projectAccess(user, params.id, 'developer');
    const issue = createIssue(project, body(), user.id);
    return [201, issueDetail(issue, user)];
  });

  route('GET', '/api/projects/:id/export.csv', ({ user, params }) => {
    const { project } = projectAccess(user, params.id);
    const rows = db.issues
      .filter((i) => i.projectId === project.id)
      .sort((a, b) => a.number - b.number)
      .map((i) => [
        i.key,
        i.type,
        i.title,
        i.status,
        i.priority,
        i.assigneeId ? userById(i.assigneeId)?.username ?? '' : '',
        i.labels.join(';'),
        i.storyPoints ?? '',
        i.parentId ? issueById(i.parentId)?.key ?? '' : '',
        i.epicId ? issueById(i.epicId)?.key ?? '' : '',
        i.sprintId ? sprintById(i.sprintId)?.name ?? '' : '',
        i.dueDate ?? '',
        i.createdAt,
        i.resolvedAt ?? '',
      ]);
    return { csv: toCsv(rows, CSV_HEADER) };
  });

  route('POST', '/api/projects/:id/import.csv', ({ user, params, text }) => {
    const { project } = projectAccess(user, params.id, 'developer');
    let records;
    try {
      records = parseCsv(text);
    } catch (err) {
      throw bad(`malformed CSV: ${err.message}`);
    }
    if (records.length === 0) throw bad('CSV is empty');
    const header = records[0].fields.map((h) => h.trim().toLowerCase());
    if (!header.includes('title')) throw bad('CSV header must include a title column');
    let created = 0;
    const errors = [];
    for (const rec of records.slice(1)) {
      const row = {};
      header.forEach((h, idx) => {
        row[h] = (rec.fields[idx] ?? '').trim();
      });
      try {
        createIssue(project, rowToInput(project, row), user.id);
        created++;
      } catch (err) {
        if (!(err instanceof ApiError)) throw err;
        errors.push({ line: rec.line, message: err.message });
      }
    }
    return [200, { created, errors }];
  });

  route('POST', '/api/projects/:id/webhooks', ({ user, params, body }) => {
    const { project } = projectAccess(user, params.id, 'lead');
    const b = body();
    let url;
    try {
      url = new URL(b.url);
    } catch {
      throw bad('url must be a valid URL');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw bad('url must be http or https');
    if (!Array.isArray(b.events) || b.events.length === 0 || b.events.some((e) => !EVENTS.includes(e))) {
      throw bad(`events must be a non-empty subset of ${EVENTS.join(', ')}`);
    }
    if (!isStr(b.secret, 200)) throw bad('secret is required');
    const hook = { id: uid(), projectId: project.id, url: b.url, events: [...new Set(b.events)], secret: b.secret, createdAt: iso() };
    db.webhooks.push(hook);
    audit(wsById(project.workspaceId), user.id, 'webhook.created', { project: project.key, url: hook.url, events: hook.events });
    return [201, hookView(hook)];
  });

  route('GET', '/api/projects/:id/webhooks', ({ user, params }) => {
    projectAccess(user, params.id, 'lead');
    return [200, db.webhooks.filter((h) => h.projectId === params.id).map(hookView)];
  });

  const webhookAccess = (user, id) => {
    const hook = db.webhooks.find((h) => h.id === id);
    if (!hook) throw notFound('webhook not found');
    const project = projectById(hook.projectId);
    projectAccess(user, project.id, 'lead');
    return { hook, project };
  };

  route('DELETE', '/api/webhooks/:id', ({ user, params }) => {
    const { hook, project } = webhookAccess(user, params.id);
    db.webhooks = db.webhooks.filter((h) => h !== hook);
    audit(wsById(project.workspaceId), user.id, 'webhook.deleted', { project: project.key, url: hook.url });
    return [204];
  });

  route('GET', '/api/webhooks/:id/deliveries', ({ user, params }) => {
    const { hook } = webhookAccess(user, params.id);
    return [
      200,
      db.deliveries
        .filter((d) => d.webhookId === hook.id)
        .map((d) => ({ id: d.id, event: d.event, status: d.status, attempts: d.attempts, lastError: d.lastError, at: d.at })),
    ];
  });

  // ===== sprints =====
  route('POST', '/api/projects/:id/sprints', ({ user, params, body }) => {
    const { project } = projectAccess(user, params.id, 'developer');
    const b = body();
    if (!isStr(b.name, 200)) throw bad('name is required');
    if (b.startDate != null && !isDate(b.startDate)) throw bad('startDate must be YYYY-MM-DD');
    if (b.endDate != null && !isDate(b.endDate)) throw bad('endDate must be YYYY-MM-DD');
    if (b.startDate && b.endDate && b.startDate > b.endDate) throw bad('startDate must not be after endDate');
    const s = {
      id: uid(),
      projectId: project.id,
      name: b.name.trim(),
      state: 'planned',
      startDate: b.startDate ?? null,
      endDate: b.endDate ?? null,
      startedAt: null,
      completedAt: null,
      carriedOver: 0,
      createdAt: iso(),
    };
    db.sprints.push(s);
    return [201, sprintView(s)];
  });

  route('GET', '/api/projects/:id/sprints', ({ user, params }) => {
    const { project } = projectAccess(user, params.id);
    return [200, db.sprints.filter((s) => s.projectId === project.id).map(sprintView)];
  });

  route('GET', '/api/sprints/:id', ({ user, params }) => [200, sprintView(sprintAccess(user, params.id))]);

  route('POST', '/api/sprints/:id/start', ({ user, params }) => {
    const s = sprintAccess(user, params.id, 'developer');
    if (s.state !== 'planned') throw conflict('invalid_state', 'only a planned sprint can be started');
    if (db.sprints.some((x) => x.projectId === s.projectId && x.state === 'active')) {
      throw conflict('active_sprint_exists', 'project already has an active sprint');
    }
    s.state = 'active';
    s.startedAt = iso();
    if (!s.startDate) s.startDate = s.startedAt.slice(0, 10);
    return [200, sprintView(s)];
  });

  route('POST', '/api/sprints/:id/complete', ({ user, params, body }) => {
    const s = sprintAccess(user, params.id, 'developer');
    if (s.state !== 'active') throw conflict('invalid_state', 'only an active sprint can be completed');
    const b = body();
    const target = b.carryOverTo == null ? 'backlog' : b.carryOverTo;
    let targetId = null;
    if (target !== 'backlog') {
      const t = db.sprints.find((x) => x.id === target && x.projectId === s.projectId);
      if (!t || t.state === 'completed' || t.id === s.id) throw bad('carryOverTo must be "backlog" or another open sprint in the project');
      targetId = t.id;
    }
    const project = projectById(s.projectId);
    const t = iso();
    let moved = 0;
    for (const i of db.issues.filter((x) => x.sprintId === s.id && catOf(project, x.status) !== 'completed')) {
      recordChange(i, 'sprintId', i.sprintId, targetId, user.id, t);
      i.sprintId = targetId;
      i.updatedAt = t;
      moved++;
    }
    s.state = 'completed';
    s.completedAt = t;
    s.carriedOver = moved;
    return [200, sprintView(s)];
  });

  route('GET', '/api/sprints/:id/report', ({ user, params }) => [200, sprintReport(sprintAccess(user, params.id))]);

  // ===== issues =====
  route('GET', '/api/issues/:key', ({ user, params }) => {
    const { issue } = issueAccess(user, params.key);
    return [200, issueDetail(issue, user)];
  });

  route('PATCH', '/api/issues/:key', ({ user, params, body }) => {
    const { issue, project } = issueAccess(user, params.key, 'developer');
    const f = resolveFields(project, body(), issue);
    const changes = ISSUE_FIELDS.filter((k) => !sameValue(issue[k], f[k]));
    if (changes.includes('status')) {
      const from = issue.status;
      const to = f.status;
      if (!project.workflow.transitions.some(([a, c]) => a === from && c === to)) {
        throw conflict('invalid_transition', `transition from "${from}" to "${to}" is not allowed`);
      }
      if (catOf(project, to) === 'completed' && catOf(project, from) !== 'completed' && blockersOf(issue).length > 0) {
        throw conflict('blocked', 'issue is blocked by unresolved issues');
      }
    }
    if (changes.length === 0) return [200, issueDetail(issue, user)];
    const t = iso();
    for (const k of changes) {
      if (k === 'status') continue;
      recordChange(issue, k, issue[k], f[k], user.id, t);
      issue[k] = f[k];
    }
    if (changes.includes('status')) {
      // issue.status still holds the previous value here (status is skipped in the loop above).
      applyStatus(issue, f.status, catOf(project, issue.status), catOf(project, f.status), user.id, t);
    }
    if (issue.assigneeId && !issue.watchers.includes(issue.assigneeId)) issue.watchers.push(issue.assigneeId);
    issue.updatedAt = t;
    if (changes.includes('status')) notify(issue.watchers, 'status', issue, user.id);
    if (changes.includes('assigneeId')) notify(issue.watchers, 'assignment', issue, user.id);
    emit(project, 'issue.updated', issue, user.id);
    return [200, issueDetail(issue, user)];
  });

  route('DELETE', '/api/issues/:key', ({ user, params }) => {
    const { issue, project } = issueAccess(user, params.key, 'developer');
    const doomed = new Set();
    const stack = [issue];
    while (stack.length) {
      const x = stack.pop();
      if (doomed.has(x.id)) continue;
      doomed.add(x.id);
      for (const c of db.issues) if (c.parentId === x.id) stack.push(c);
    }
    for (const d of db.issues.filter((i) => doomed.has(i.id))) emit(project, 'issue.deleted', d, user.id);
    db.issues = db.issues.filter((i) => !doomed.has(i.id));
    db.comments = db.comments.filter((c) => !doomed.has(c.issueId));
    db.history = db.history.filter((h) => !doomed.has(h.issueId));
    db.links = db.links.filter((l) => !doomed.has(l.from) && !doomed.has(l.to));
    for (const i of db.issues) if (i.epicId && doomed.has(i.epicId)) i.epicId = null;
    return [204];
  });

  route('GET', '/api/issues/:key/history', ({ user, params }) => {
    const { issue } = issueAccess(user, params.key);
    return [200, historyOf(issue).map((h) => ({ field: h.field, from: h.from, to: h.to, actorId: h.actorId, at: h.at }))];
  });

  route('POST', '/api/issues/:key/links', ({ user, params, body }) => {
    const { issue } = issueAccess(user, params.key, 'developer');
    const b = body();
    if (!LINK_TYPES.includes(b.type)) throw bad('type must be blocks, relates or duplicates');
    const target = issueByKey(b.target);
    if (!target) throw notFound('target issue not found');
    if (!canSee(user, projectById(target.projectId))) throw forbidden();
    if (target.id === issue.id) throw bad('an issue cannot link to itself');
    if (db.links.some((l) => l.type === b.type && l.from === issue.id && l.to === target.id)) throw conflict('link_exists', 'link already exists');
    const link = { id: uid(), type: b.type, from: issue.id, to: target.id, createdAt: iso() };
    db.links.push(link);
    return [201, { id: link.id, type: link.type, key: target.key }];
  });

  route('DELETE', '/api/issues/:key/links/:linkId', ({ user, params }) => {
    const { issue } = issueAccess(user, params.key, 'developer');
    const link = db.links.find((l) => l.id === params.linkId && (l.from === issue.id || l.to === issue.id));
    if (!link) throw notFound('link not found');
    db.links = db.links.filter((l) => l !== link);
    return [204];
  });

  route('POST', '/api/issues/:key/watch', ({ user, params }) => {
    const { issue } = issueAccess(user, params.key);
    if (!issue.watchers.includes(user.id)) issue.watchers.push(user.id);
    return [200, { key: issue.key, watchers: [...issue.watchers] }];
  });

  route('DELETE', '/api/issues/:key/watch', ({ user, params }) => {
    const { issue } = issueAccess(user, params.key);
    issue.watchers = issue.watchers.filter((w) => w !== user.id);
    return [200, { key: issue.key, watchers: [...issue.watchers] }];
  });

  // ===== comments =====
  const mentionsIn = (text) => [...text.matchAll(/(^|[^A-Za-z0-9_])@([a-zA-Z0-9_]+(?:[.-][a-zA-Z0-9_]+)*)/g)].map((m) => m[2].toLowerCase());

  route('GET', '/api/issues/:key/comments', ({ user, params }) => {
    const { issue } = issueAccess(user, params.key);
    return [200, db.comments.filter((c) => c.issueId === issue.id).map((c) => commentView(c, issue.key))];
  });

  route('POST', '/api/issues/:key/comments', ({ user, params, body }) => {
    const { issue, project } = issueAccess(user, params.key);
    const b = body();
    if (!isStr(b.body, 10000)) throw bad('body is required');
    const t = iso();
    const c = { id: uid(), issueId: issue.id, authorId: user.id, body: b.body, createdAt: t, updatedAt: t, edited: false };
    db.comments.push(c);
    const mentioned = [...new Set(mentionsIn(b.body))]
      .map((name) => userByName(name))
      .filter((u) => u && u.id !== user.id && canSee(u, project))
      .map((u) => u.id);
    notify(mentioned, 'mention', issue, user.id);
    notify(issue.watchers.filter((w) => !mentioned.includes(w)), 'comment', issue, user.id);
    emit(project, 'comment.created', issue, user.id);
    return [201, commentView(c, issue.key)];
  });

  const commentAccess = (user, id) => {
    const c = db.comments.find((x) => x.id === id);
    if (!c) throw notFound('comment not found');
    const issue = issueById(c.issueId);
    const project = projectById(issue.projectId);
    const role = projectRole(user, project);
    if (!role) throw forbidden();
    return { c, issue, project, role };
  };

  route('PATCH', '/api/comments/:id', ({ user, params, body }) => {
    const { c, issue } = commentAccess(user, params.id);
    if (c.authorId !== user.id) throw forbidden('only the author can edit a comment');
    const b = body();
    if (!isStr(b.body, 10000)) throw bad('body is required');
    c.body = b.body;
    c.edited = true;
    c.updatedAt = iso();
    return [200, commentView(c, issue.key)];
  });

  route('DELETE', '/api/comments/:id', ({ user, params }) => {
    const { c, role } = commentAccess(user, params.id);
    if (c.authorId !== user.id && role !== 'lead') throw forbidden('only the author or a project lead can delete a comment');
    db.comments = db.comments.filter((x) => x !== c);
    return [204];
  });

  // ===== notifications =====
  route('GET', '/api/notifications', ({ user, query }) => {
    const unreadOnly = query.get('unread') === 'true';
    const list = db.notifications
      .filter((n) => n.userId === user.id && (!unreadOnly || !n.read))
      .sort((a, b) => b.seq - a.seq)
      .map(notificationView);
    return [200, list];
  });

  route('POST', '/api/notifications/read', ({ user, body }) => {
    const b = body();
    const mine = db.notifications.filter((n) => n.userId === user.id);
    if (b.all === true) {
      for (const n of mine) n.read = true;
    } else if (Array.isArray(b.ids)) {
      const ids = new Set(b.ids);
      for (const n of mine) if (ids.has(n.id)) n.read = true;
    } else {
      throw bad('ids array or all: true is required');
    }
    return [204];
  });

  // ===== search =====
  const searchView = (i, user) => {
    const project = projectById(i.projectId);
    return {
      key: i.key,
      type: i.type,
      priority: i.priority,
      title: i.title,
      description: i.description,
      labels: i.labels,
      storyPoints: i.storyPoints,
      dueDate: i.dueDate,
      status: i.status,
      category: catOf(project, i.status),
      assigneeId: i.assigneeId,
      assigneeUsername: i.assigneeId ? userById(i.assigneeId)?.username ?? null : null,
      sprintId: i.sprintId,
      sprintState: i.sprintId ? sprintById(i.sprintId)?.state ?? null : null,
      meId: user.id,
    };
  };

  route('GET', '/api/search', ({ user, query }) => {
    let terms;
    try {
      terms = parseQuery(query.get('q') || '');
    } catch (err) {
      if (err instanceof QueryError) throw bad(err.message);
      throw err;
    }
    const sort = query.get('sort') || 'updated';
    if (!['updated', 'created', 'priority'].includes(sort)) throw bad('sort must be updated, created or priority');
    let projects = visibleProjects(user);
    const pk = query.get('project');
    if (pk) {
      const p = db.projects.find((x) => x.id === pk || x.key === pk.toUpperCase());
      if (!p) throw notFound('project not found');
      if (!canSee(user, p)) throw forbidden();
      projects = [p];
    }
    const pids = new Set(projects.map((p) => p.id));
    let list = db.issues.filter((i) => pids.has(i.projectId) && matches(terms, searchView(i, user)));
    if (sort === 'updated') list.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    if (sort === 'created') list.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    if (sort === 'priority') {
      list.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (a.updatedAt < b.updatedAt ? 1 : -1));
    }
    return [200, list.map(issueView)];
  });

  // ---------- dispatch ----------
  const bearerToken = (req) => {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    return m ? m[1].trim() : null;
  };
  function authUser(token) {
    if (!token) return null;
    const h = sha256(token);
    const session = db.sessions.find((s) => s.hash === h);
    if (session) return userById(session.userId) || null;
    const api = db.apiTokens.find((t) => t.hash === h);
    return api ? userById(api.userId) || null : null;
  }

  function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.slice('/static/'.length);
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      send(res, 404, { error: 'not_found', message: 'no such file' });
      return;
    }
    const type = MIME[path.extname(file)] || 'application/octet-stream';
    send(res, 200, fs.readFileSync(file), type);
  }

  async function dispatch(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    if ((req.method === 'GET' || req.method === 'HEAD') && (pathname === '/' || pathname.startsWith('/static/'))) {
      serveStatic(res, pathname);
      return;
    }
    const raw = await readBody(req);
    let matched = null;
    let params = {};
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      matched = r;
      r.keys.forEach((k, idx) => {
        params[k] = decodeURIComponent(m[idx + 1]);
      });
      break;
    }
    if (!matched) throw notFound('no such route');
    const token = bearerToken(req);
    let user = null;
    if (matched.auth) {
      user = authUser(token);
      if (!user) throw new ApiError(401, 'unauthenticated', 'authentication required');
    }
    const ctx = {
      params,
      query: url.searchParams,
      user,
      token,
      text: raw,
      body: () => parseJsonBody(raw),
    };
    const out = matched.handler(ctx);
    if (out && out.csv !== undefined) {
      send(res, 200, out.csv, 'text/csv; charset=utf-8');
      return;
    }
    const [status, payload] = out;
    send(res, status, payload);
  }

  const server = http.createServer(async (req, res) => {
    try {
      await dispatch(req, res);
    } catch (err) {
      if (err instanceof ApiError) {
        send(res, err.status, { error: err.error, message: err.message });
      } else {
        console.error(err);
        send(res, 500, { error: 'internal_error', message: 'internal server error' });
      }
    } finally {
      if (req.method !== 'GET') persist();
    }
  });
  return server;
}
