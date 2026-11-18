import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ApiError, bad, notFound, forbidden, conflict, newId, randomToken, sha256,
  hashPassword, verifyPassword, reqStr, optStr, reqPassword, pick, isValidDate,
  PRIORITIES, ISSUE_TYPES, WS_ROLES, PROJECT_ROLES, CATEGORIES, LINK_TYPES, EVENTS,
} from './util.js';
import { parseQuery, matchesAll } from './search.js';
import { parseCsv, csvLine } from './csv.js';
import { deliver } from './webhooks.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;
const RANK = { viewer: 1, developer: 2, lead: 3 };
const INVERSE_LINK = { blocks: 'blocked_by', duplicates: 'duplicated_by', relates: 'relates' };
const CSV_COLUMNS = ['key', 'type', 'title', 'status', 'priority', 'assignee', 'labels', 'storyPoints',
  'parent', 'epic', 'sprint', 'dueDate', 'createdAt', 'resolvedAt'];
const SORTS = ['updated', 'created', 'priority'];
const NONE = Symbol('no-content');

class Raw {
  constructor(body, type, filename) {
    this.body = body;
    this.type = type;
    this.filename = filename;
  }
}

function emptyState() {
  return {
    seq: 0,
    users: [],
    tokens: [],
    workspaces: [],
    projects: [],
    issues: [],
    comments: [],
    notifications: [],
    sprints: [],
    webhooks: [],
    deliveries: [],
    audit: [],
    loginFailures: {},
  };
}

function defaultWorkflow() {
  const statuses = [
    { name: 'Backlog', category: 'backlog' },
    { name: 'Todo', category: 'unstarted' },
    { name: 'In Progress', category: 'started' },
    { name: 'In Review', category: 'started' },
    { name: 'Done', category: 'completed' },
  ];
  const transitions = [];
  for (const a of statuses) for (const b of statuses) if (a !== b) transitions.push([a.name, b.name]);
  return { statuses, transitions };
}

function parseWorkflow(body) {
  if (!Array.isArray(body.statuses) || body.statuses.length === 0) throw bad('statuses must be a non-empty array');
  if (!Array.isArray(body.transitions)) throw bad('transitions must be an array');
  const seen = new Set();
  const statuses = body.statuses.map((s) => {
    if (!s || typeof s !== 'object') throw bad('invalid status');
    const name = typeof s.name === 'string' ? s.name.trim() : '';
    if (!name || name.length > 50) throw bad('invalid status name');
    if (seen.has(name.toLowerCase())) throw bad(`duplicate status "${name}"`);
    seen.add(name.toLowerCase());
    if (!CATEGORIES.includes(s.category)) throw bad('invalid status category');
    return { name, category: s.category };
  });
  const names = new Set(statuses.map((s) => s.name));
  const transitions = body.transitions.map((t) => {
    if (!Array.isArray(t) || t.length !== 2) throw bad('invalid transition');
    if (!names.has(t[0]) || !names.has(t[1])) throw bad('transition references an unknown status');
    return [t[0], t[1]];
  });
  return { statuses, transitions };
}

function normKey(k) {
  if (typeof k !== 'string' || !/^[A-Z]{2,10}$/.test(k)) throw bad('key must be 2-10 uppercase letters');
  return k;
}

function normUsername(v) {
  return typeof v === 'string' ? v.trim().toLowerCase() : '';
}

function normLabels(v) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) throw bad('labels must be an array of strings');
  return [...new Set(v.map((s) => s.trim()).filter(Boolean))];
}

function normPoints(v) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'number' && typeof v !== 'string') throw bad('storyPoints must be a non-negative number');
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw bad('storyPoints must be a non-negative number');
  return n;
}

function normDate(v) {
  if (v === undefined || v === null || v === '') return null;
  if (!isValidDate(v)) throw bad('date must be YYYY-MM-DD');
  return v;
}

function sameValue(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

const sum = (xs) => xs.reduce((a, b) => a + (b || 0), 0);
const round2 = (n) => Math.round(n * 100) / 100;

function sortByN(list) {
  return list.sort((a, b) => a._n - b._n);
}

function jsonBody(raw) {
  if (!raw || !raw.trim()) return {};
  let v;
  try {
    v = JSON.parse(raw);
  } catch {
    throw bad('request body must be valid JSON');
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw bad('request body must be a JSON object');
  return v;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 5 * 1024 * 1024) {
        reject(new ApiError(413, 'payload_too_large', 'request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = data === undefined ? '' : JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

export function createServer({ dataFile, clock } = {}) {
  const nowMs = () => (clock ? clock() : new Date()).getTime();
  const nowIso = () => new Date(nowMs()).toISOString();

  function load() {
    if (!dataFile || !fs.existsSync(dataFile)) return emptyState();
    return { ...emptyState(), ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) };
  }

  function save() {
    if (!dataFile) return;
    fs.mkdirSync(path.dirname(path.resolve(dataFile)), { recursive: true });
    const tmp = `${dataFile}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, dataFile);
  }

  let state = load();
  const seq = () => ++state.seq;

  // ---------- lookups ----------
  const userById = (uid) => state.users.find((u) => u.id === uid) || null;
  const findUserRef = (ref) => {
    const r = String(ref ?? '');
    return state.users.find((u) => u.id === r) || state.users.find((u) => u.username === r.toLowerCase()) || null;
  };
  const wsById = (id) => state.workspaces.find((w) => w.id === id) || null;
  const projById = (id) => state.projects.find((p) => p.id === id) || null;
  const issueById = (id) => state.issues.find((i) => i.id === id) || null;
  const issueByKey = (k) => state.issues.find((i) => i.key === String(k).toUpperCase()) || null;
  const resolveIssue = (ref) => (ref ? issueById(String(ref)) || issueByKey(ref) : null);
  const usernameOf = (uid) => (userById(uid) || {}).username ?? null;

  // ---------- access ----------
  const wsRoleOf = (ws, uid) => (ws.members.find((m) => m.userId === uid) || {}).role || null;

  function projRoleOf(project, uid) {
    const ws = wsById(project.workspaceId);
    if (!ws) return null;
    const wr = wsRoleOf(ws, uid);
    if (!wr) return null;
    if (wr === 'admin') return 'lead';
    const m = project.members.find((x) => x.userId === uid);
    return m ? m.role : null;
  }

  const canSee = (p, uid) => projRoleOf(p, uid) !== null;

  function requireProject(pid, user, min = 'viewer') {
    const project = projById(pid);
    if (!project) throw notFound('project not found');
    const role = projRoleOf(project, user.id);
    if (!role) throw forbidden('no access to this project');
    if (RANK[role] < RANK[min]) throw forbidden(`requires ${min} role`);
    return { project, role };
  }

  function requireIssue(key, user, min = 'viewer') {
    const issue = resolveIssue(key);
    if (!issue) throw notFound('issue not found');
    const { project, role } = requireProject(issue.projectId, user, min);
    return { issue, project, role };
  }

  function requireSprint(sid, user, min = 'viewer') {
    const sprint = state.sprints.find((s) => s.id === sid);
    if (!sprint) throw notFound('sprint not found');
    const { project } = requireProject(sprint.projectId, user, min);
    return { sprint, project };
  }

  function requireWs(wid, user, { admin = false } = {}) {
    const ws = wsById(wid);
    if (!ws) throw notFound('workspace not found');
    const role = wsRoleOf(ws, user.id);
    if (!role) throw forbidden('not a workspace member');
    if (admin && role !== 'admin') throw forbidden('workspace admin required');
    return { ws, role };
  }

  // ---------- workflow ----------
  const catOf = (project, status) => {
    const s = project.workflow.statuses.find((x) => x.name === status);
    return s ? s.category : null;
  };
  const isDone = (project, status) => catOf(project, status) === 'completed';
  const initialStatus = (wf) => (wf.statuses.find((s) => s.category === 'unstarted') || wf.statuses[0]).name;
  const transitionAllowed = (project, from, to) => project.workflow.transitions.some(([a, b]) => a === from && b === to);
  const issueDone = (issue) => {
    const p = projById(issue.projectId);
    return !!p && isDone(p, issue.status);
  };
  const isBlocked = (issue) => issue.links.some((l) => {
    if (l.type !== 'blocked_by') return false;
    const t = issueById(l.targetId);
    return !!t && !issueDone(t);
  });

  // ---------- serialization ----------
  const userOut = (u) => ({ id: u.id, username: u.username, displayName: u.displayName });
  const memberOut = (m) => ({ userId: m.userId, username: usernameOf(m.userId), displayName: (userById(m.userId) || {}).displayName ?? null, role: m.role });
  const wsOut = (ws, uid) => ({ id: ws.id, name: ws.name, key: ws.key, createdAt: ws.createdAt, role: wsRoleOf(ws, uid) });
  const projectOut = (p) => ({
    id: p.id,
    workspaceId: p.workspaceId,
    name: p.name,
    key: p.key,
    workflow: p.workflow,
    members: p.members.map((m) => ({ userId: m.userId, username: usernameOf(m.userId), role: m.role })),
    createdAt: p.createdAt,
  });
  const sprintOut = (s) => ({
    id: s.id,
    projectId: s.projectId,
    name: s.name,
    state: s.state,
    startDate: s.startDate,
    endDate: s.endDate,
    startedAt: s.startedAt,
    completedAt: s.completedAt,
    carriedOver: s.carriedOver,
    createdAt: s.createdAt,
  });
  const commentOut = (c) => ({ id: c.id, issueKey: c.issueKey, authorId: c.authorId, body: c.body, createdAt: c.createdAt, updatedAt: c.updatedAt, edited: c.edited });
  const notifOut = (n) => ({ id: n.id, type: n.type, issueKey: n.issueKey, actorId: n.actorId, at: n.at, read: n.read });
  const hookOut = (h) => ({ id: h.id, projectId: h.projectId, url: h.url, events: h.events, createdAt: h.createdAt });

  function issueOut(issue) {
    const children = sortByN(state.issues.filter((c) => c.parentId === issue.id)).map((c) => c.key);
    const out = {
      id: issue.id,
      key: issue.key,
      projectId: issue.projectId,
      type: issue.type,
      title: issue.title,
      description: issue.description,
      status: issue.status,
      priority: issue.priority,
      assigneeId: issue.assigneeId,
      assignee: usernameOf(issue.assigneeId),
      reporterId: issue.reporterId,
      labels: [...issue.labels],
      storyPoints: issue.storyPoints,
      parentId: issue.parentId,
      epicId: issue.epicId,
      sprintId: issue.sprintId,
      dueDate: issue.dueDate,
      watchers: [...issue.watchers],
      createdAt: issue.createdAt,
      updatedAt: issue.updatedAt,
      resolvedAt: issue.resolvedAt,
      children,
      links: issue.links.map((l) => ({ type: l.type, target: (issueById(l.targetId) || {}).key ?? null })),
    };
    if (issue.type === 'epic') {
      const kids = state.issues.filter((c) => c.epicId === issue.id);
      const done = kids.filter(issueDone);
      out.progress = {
        total: kids.length,
        done: done.length,
        points_total: sum(kids.map((k) => k.storyPoints)),
        points_done: sum(done.map((k) => k.storyPoints)),
      };
    }
    return out;
  }

  // ---------- audit / notifications / webhooks ----------
  function audit(wsId, actorId, action, targetId, details) {
    state.audit.push({ id: newId(), workspaceId: wsId, action, actorId, targetId: targetId ?? null, details: details ?? null, at: nowIso(), _n: seq() });
  }

  function auditProject(project, actorId, action, targetId, details) {
    audit(project.workspaceId, actorId, action, targetId, details);
  }

  function notify(userIds, type, issue, actorId) {
    const project = projById(issue.projectId);
    const at = nowIso();
    for (const uid of new Set(userIds)) {
      if (!uid || uid === actorId || !userById(uid)) continue;
      if (!projRoleOf(project, uid)) continue;
      state.notifications.push({ id: newId(), userId: uid, type, issueKey: issue.key, actorId, at, read: false, _n: seq() });
    }
  }

  function emit(project, event, issue, actorId) {
    const hooks = state.webhooks.filter((w) => w.projectId === project.id && w.events.includes(event));
    if (!hooks.length) return;
    const at = nowIso();
    const body = JSON.stringify({ event, issue: issueOut(issue), actorId, at });
    for (const hook of hooks) {
      const delivery = { id: newId(), webhookId: hook.id, projectId: project.id, event, status: null, attempts: 0, lastError: null, at, _n: seq() };
      state.deliveries.push(delivery);
      deliver({ url: hook.url, secret: hook.secret, body, delivery, onChange: save }).catch(() => {});
    }
  }

  // ---------- issue operations ----------
  function resolveIssueIn(project, ref, label) {
    if (!ref) return null;
    const i = resolveIssue(ref);
    if (!i || i.projectId !== project.id) throw bad(`unknown ${label}`);
    return i.id;
  }

  function resolveSprint(project, ref) {
    if (!ref) return null;
    const s = state.sprints.find((x) => x.id === ref && x.projectId === project.id);
    if (!s) throw bad('unknown sprint');
    return s.id;
  }

  function resolveAssignee(project, body) {
    let uid = null;
    if (body.assigneeId) {
      uid = String(body.assigneeId);
    } else if (body.assignee) {
      const u = state.users.find((x) => x.username === normUsername(body.assignee));
      if (!u) throw bad('unknown assignee');
      uid = u.id;
    }
    if (uid && !projRoleOf(project, uid)) throw bad('assignee must be a project member');
    return uid;
  }

  function checkHierarchy(project, issue, type, parentId, epicId) {
    if (type === 'subtask') {
      if (!parentId) throw bad('subtasks require a parentId');
      const parent = issueById(parentId);
      if (parent.type === 'subtask') throw bad('a subtask cannot be the parent of a subtask');
      if (issue && parent.id === issue.id) throw bad('an issue cannot be its own parent');
    } else if (parentId) {
      throw bad('only subtasks can have a parent');
    }
    if (issue && type === 'subtask' && state.issues.some((c) => c.parentId === issue.id)) {
      throw bad('an issue with subtasks cannot become a subtask');
    }
    if (epicId) {
      const e = issueById(epicId);
      if (!e || e.type !== 'epic' || e.projectId !== project.id) throw bad('epicId must reference an epic in this project');
      if (issue && e.id === issue.id) throw bad('an issue cannot be its own epic');
    }
  }

  function createIssue(project, actor, input) {
    const title = reqStr(input.title, 'title', 255);
    const type = pick(input.type ?? 'task', ISSUE_TYPES, 'type');
    const priority = pick(input.priority ?? 'none', PRIORITIES, 'priority');
    const description = optStr(input.description, 'description', 20000) ?? '';
    const status = input.status ?? initialStatus(project.workflow);
    if (catOf(project, status) === null) throw bad('unknown status');
    const parentId = resolveIssueIn(project, input.parentId, 'parent');
    const epicId = resolveIssueIn(project, input.epicId, 'epic');
    const sprintId = resolveSprint(project, input.sprintId);
    const assigneeId = resolveAssignee(project, input);
    const labels = normLabels(input.labels);
    const storyPoints = normPoints(input.storyPoints);
    const dueDate = normDate(input.dueDate);
    checkHierarchy(project, null, type, parentId, epicId);

    const t = nowIso();
    project.seq = (project.seq || 0) + 1;
    const issue = {
      id: newId(),
      key: `${project.key}-${project.seq}`,
      projectId: project.id,
      type,
      title,
      description,
      status,
      priority,
      assigneeId,
      reporterId: actor.id,
      labels,
      storyPoints,
      parentId,
      epicId,
      sprintId,
      dueDate,
      watchers: [...new Set([actor.id, assigneeId].filter(Boolean))],
      createdAt: t,
      updatedAt: t,
      resolvedAt: isDone(project, status) ? t : null,
      history: [],
      links: [],
      _n: seq(),
    };
    state.issues.push(issue);
    emit(project, 'issue.created', issue, actor.id);
    return issue;
  }

  function updateIssue(issue, project, actor, body) {
    const P = {};
    if ('title' in body) P.title = reqStr(body.title, 'title', 255);
    if ('description' in body) P.description = optStr(body.description, 'description', 20000) ?? '';
    if ('type' in body) P.type = pick(body.type, ISSUE_TYPES, 'type');
    if ('priority' in body) P.priority = pick(body.priority, PRIORITIES, 'priority');
    if ('labels' in body) P.labels = normLabels(body.labels);
    if ('storyPoints' in body) P.storyPoints = normPoints(body.storyPoints);
    if ('dueDate' in body) P.dueDate = normDate(body.dueDate);
    if ('status' in body) {
      if (catOf(project, body.status) === null) throw bad('unknown status');
      P.status = body.status;
    }
    if ('parentId' in body) P.parentId = resolveIssueIn(project, body.parentId, 'parent');
    if ('epicId' in body) P.epicId = resolveIssueIn(project, body.epicId, 'epic');
    if ('sprintId' in body) P.sprintId = resolveSprint(project, body.sprintId);
    if ('assigneeId' in body || 'assignee' in body) P.assigneeId = resolveAssignee(project, body);

    const type = P.type ?? issue.type;
    const parentId = 'parentId' in P ? P.parentId : issue.parentId;
    const epicId = 'epicId' in P ? P.epicId : issue.epicId;
    checkHierarchy(project, issue, type, parentId, epicId);

    const changes = [];
    for (const [field, value] of Object.entries(P)) {
      if (!sameValue(issue[field], value)) changes.push({ field, from: issue[field], to: value });
    }
    const statusChange = changes.find((c) => c.field === 'status');
    if (statusChange) {
      if (!transitionAllowed(project, statusChange.from, statusChange.to)) {
        throw new ApiError(409, 'invalid_transition', `cannot move from "${statusChange.from}" to "${statusChange.to}"`);
      }
      if (catOf(project, statusChange.to) === 'completed' && isBlocked(issue)) {
        throw new ApiError(409, 'blocked', 'issue is blocked by unresolved issues');
      }
    }
    if (!changes.length) return issue;

    const t = nowIso();
    for (const c of changes) {
      const to = Array.isArray(c.to) ? [...c.to] : c.to;
      issue.history.push({ field: c.field, from: c.from, to, actorId: actor.id, at: t });
      issue[c.field] = to;
    }
    issue.updatedAt = t;
    if (statusChange) {
      const wasDone = isDone(project, statusChange.from);
      const nowDone = isDone(project, statusChange.to);
      if (nowDone && !wasDone) issue.resolvedAt = t;
      else if (!nowDone) issue.resolvedAt = null;
    }
    const assigneeChanged = changes.some((c) => c.field === 'assigneeId');
    if (assigneeChanged && issue.assigneeId && !issue.watchers.includes(issue.assigneeId)) {
      issue.watchers.push(issue.assigneeId);
    }
    if (statusChange) notify(issue.watchers, 'status_changed', issue, actor.id);
    if (assigneeChanged && issue.assigneeId) notify(issue.watchers, 'assigned', issue, actor.id);
    emit(project, 'issue.updated', issue, actor.id);
    return issue;
  }

  function deleteIssue(issue, project, actor) {
    const doomed = [];
    const walk = (i) => {
      doomed.push(i);
      for (const c of state.issues) if (c.parentId === i.id) walk(c);
    };
    walk(issue);
    for (const i of doomed) emit(project, 'issue.deleted', i, actor.id);
    const ids = new Set(doomed.map((i) => i.id));
    state.issues = state.issues.filter((i) => !ids.has(i.id));
    for (const i of state.issues) {
      if (i.epicId && ids.has(i.epicId)) i.epicId = null;
      i.links = i.links.filter((l) => !ids.has(l.targetId));
    }
    state.comments = state.comments.filter((c) => !ids.has(c.issueId));
  }

  function addLink(source, target, type) {
    if (source.id === target.id) throw bad('an issue cannot link to itself');
    if (source.links.some((l) => l.type === type && l.targetId === target.id)) throw conflict('link already exists');
    source.links.push({ type, targetId: target.id });
    target.links.push({ type: INVERSE_LINK[type], targetId: source.id });
  }

  function removeLink(source, target, type) {
    source.links = source.links.filter((l) => !(l.type === type && l.targetId === target.id));
    target.links = target.links.filter((l) => !(l.type === INVERSE_LINK[type] && l.targetId === source.id));
  }

  function mentionedUsers(text) {
    const names = new Set();
    for (const m of text.matchAll(/(^|[^A-Za-z0-9_.-])@([A-Za-z0-9_](?:[A-Za-z0-9_.-]*[A-Za-z0-9_])?)/g)) {
      names.add(m[2].toLowerCase());
    }
    return [...names].map((n) => state.users.find((u) => u.username === n)).filter(Boolean);
  }

  function createComment(issue, project, actor, text) {
    const t = nowIso();
    const c = { id: newId(), issueId: issue.id, issueKey: issue.key, authorId: actor.id, body: text, createdAt: t, updatedAt: t, edited: false, _n: seq() };
    state.comments.push(c);
    const mentioned = mentionedUsers(text).filter((u) => u.id !== actor.id && projRoleOf(project, u.id));
    notify(mentioned.map((u) => u.id), 'mention', issue, actor.id);
    const mentionedIds = new Set(mentioned.map((u) => u.id));
    notify(issue.watchers.filter((uid) => !mentionedIds.has(uid)), 'comment', issue, actor.id);
    emit(project, 'comment.created', issue, actor.id);
    return c;
  }

  // ---------- sprints / reporting ----------
  function snapshotAt(issue, tMs) {
    if (Date.parse(issue.createdAt) > tMs) return null;
    const snap = { ...issue };
    for (let k = issue.history.length - 1; k >= 0; k--) {
      const h = issue.history[k];
      if (Date.parse(h.at) <= tMs) break;
      snap[h.field] = h.from;
    }
    return snap;
  }

  function sprintMembersAt(project, sprint, tMs) {
    const out = [];
    for (const i of state.issues) {
      if (i.projectId !== project.id) continue;
      const s = snapshotAt(i, tMs);
      if (s && s.sprintId === sprint.id) out.push(s);
    }
    return out;
  }

  function sprintReport(sprint, project) {
    const now = nowMs();
    const endMs = sprint.completedAt ? Date.parse(sprint.completedAt) : now;
    const startMs = sprint.startedAt ? Date.parse(sprint.startedAt) : now;
    const committed = sprintMembersAt(project, sprint, startMs);
    const finished = sprintMembersAt(project, sprint, endMs).filter((s) => isDone(project, s.status));
    const today = new Date(now).toISOString().slice(0, 10);
    const startDay = sprint.startDate || (sprint.startedAt ? sprint.startedAt.slice(0, 10) : null);
    const burndown = [];
    if (startDay) {
      let last = today;
      if (sprint.endDate && sprint.endDate < last) last = sprint.endDate;
      for (let d = Date.parse(`${startDay}T00:00:00Z`); new Date(d).toISOString().slice(0, 10) <= last; d += DAY_MS) {
        const day = new Date(d).toISOString().slice(0, 10);
        const tEnd = Date.parse(`${day}T23:59:59.999Z`);
        const remaining = sum(sprintMembersAt(project, sprint, tEnd).filter((s) => !isDone(project, s.status)).map((s) => s.storyPoints));
        burndown.push({ date: day, remainingPoints: remaining });
      }
    }
    return {
      committedPoints: sum(committed.map((s) => s.storyPoints)),
      completedPoints: sum(finished.map((s) => s.storyPoints)),
      completedIssues: finished.map((s) => s.key),
      carriedOver: sprint.carriedOver || [],
      burndown,
    };
  }

  function firstStartedAt(project, issue) {
    const h = issue.history.find((x) => x.field === 'status' && catOf(project, x.to) === 'started');
    return h ? h.at : issue.createdAt;
  }

  function projectStats(project) {
    const issues = state.issues.filter((i) => i.projectId === project.id);
    const byStatus = {};
    for (const s of project.workflow.statuses) byStatus[s.name] = 0;
    const byType = {};
    for (const t of ISSUE_TYPES) byType[t] = 0;
    const byAssignee = {};
    for (const i of issues) {
      byStatus[i.status] = (byStatus[i.status] || 0) + 1;
      byType[i.type] = (byType[i.type] || 0) + 1;
      const a = usernameOf(i.assigneeId) || 'none';
      byAssignee[a] = (byAssignee[a] || 0) + 1;
    }
    const resolved = issues.filter((i) => i.resolvedAt);
    let avgCycleTimeHours = null;
    if (resolved.length) {
      const hours = resolved.map((i) => (Date.parse(i.resolvedAt) - Date.parse(firstStartedAt(project, i))) / 3600000);
      avgCycleTimeHours = round2(sum(hours) / hours.length);
    }
    return { total: issues.length, byStatus, byType, byAssignee, avgCycleTimeHours };
  }

  function searchEnv(userId) {
    return {
      userId,
      done: issueDone,
      usernameOf,
      activeSprintId: (pid) => (state.sprints.find((s) => s.projectId === pid && s.state === 'active') || {}).id ?? null,
    };
  }

  function sortIssues(list, sort) {
    const byUpdated = (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b._n - a._n;
    if (sort === 'created') return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b._n - a._n);
    if (sort === 'priority') {
      return list.sort((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) || byUpdated(a, b));
    }
    return list.sort(byUpdated);
  }

  function buildImportInput(project, get) {
    const input = {
      title: get('title'),
      type: get('type').toLowerCase() || 'task',
      priority: get('priority').toLowerCase() || 'none',
      labels: get('labels').split(';').map((s) => s.trim()).filter(Boolean),
      storyPoints: get('storypoints') || null,
      dueDate: get('duedate') || null,
    };
    if (get('status')) input.status = get('status');
    const assignee = get('assignee');
    if (assignee) {
      const u = state.users.find((x) => x.username === normUsername(assignee));
      if (!u) throw bad(`unknown assignee "${assignee}"`);
      input.assigneeId = u.id;
    }
    const parent = get('parent');
    if (parent) {
      const p = resolveIssue(parent);
      if (!p || p.projectId !== project.id) throw bad(`unknown parent "${parent}"`);
      input.parentId = p.id;
    }
    const epic = get('epic');
    if (epic) {
      const e = resolveIssue(epic);
      if (!e || e.projectId !== project.id) throw bad(`unknown epic "${epic}"`);
      input.epicId = e.id;
    }
    const sprint = get('sprint');
    if (sprint) {
      const s = state.sprints.find((x) => x.projectId === project.id && (x.id === sprint || x.name.toLowerCase() === sprint.toLowerCase()));
      if (!s) throw bad(`unknown sprint "${sprint}"`);
      input.sprintId = s.id;
    }
    return input;
  }

  // ---------- routing ----------
  const routes = [];
  const route = (method, pattern, handler, { auth = true } = {}) => {
    const names = [];
    const re = new RegExp(`^${pattern.replace(/:([A-Za-z]+)/g, (_, n) => { names.push(n); return '([^/]+)'; })}$`);
    routes.push({ method, re, names, handler, auth });
  };

  // ---- auth ----
  route('POST', '/api/auth/register', (c) => {
    const b = c.json();
    const username = normUsername(b.username);
    if (!/^[a-z0-9_.-]{3,32}$/.test(username)) throw bad('username must be 3-32 characters: letters, digits, _ . -');
    const password = reqPassword(b.password);
    const displayName = optStr(b.displayName, 'displayName', 80)?.trim() || username;
    if (state.users.some((u) => u.username === username)) throw conflict('username already taken');
    const user = { id: newId(), username, displayName, passwordHash: hashPassword(password), createdAt: nowIso() };
    state.users.push(user);
    c.status = 201;
    return { user: userOut(user) };
  }, { auth: false });

  route('POST', '/api/auth/login', (c) => {
    const b = c.json();
    const username = normUsername(b.username);
    const password = typeof b.password === 'string' ? b.password : '';
    if (!username || !password) throw bad('username and password are required');
    const t = nowMs();
    const fails = (state.loginFailures[username] || []).filter((ts) => t - ts < LOGIN_WINDOW_MS);
    if (fails.length >= LOGIN_MAX_FAILS) throw new ApiError(429, 'rate_limited', 'too many failed login attempts; try again later');
    const user = state.users.find((u) => u.username === username);
    if (!user || !verifyPassword(password, user.passwordHash)) {
      fails.push(t);
      state.loginFailures[username] = fails;
      throw new ApiError(401, 'invalid_credentials', 'invalid username or password');
    }
    delete state.loginFailures[username];
    const token = randomToken();
    state.tokens.push({ id: newId(), userId: user.id, name: 'session', kind: 'session', hash: sha256(token), createdAt: nowIso() });
    return { token, user: userOut(user) };
  }, { auth: false });

  route('POST', '/api/auth/logout', (c) => {
    state.tokens = state.tokens.filter((t) => t.id !== c.tokenId);
    return NONE;
  });

  route('GET', '/api/auth/me', (c) => ({ user: userOut(c.user) }));

  route('PATCH', '/api/auth/me', (c) => {
    const b = c.json();
    if (typeof b.currentPassword !== 'string') throw bad('currentPassword is required');
    if (!verifyPassword(b.currentPassword, c.user.passwordHash)) throw forbidden('current password is incorrect');
    const displayName = 'displayName' in b ? reqStr(b.displayName, 'displayName', 80) : undefined;
    const passwordHash = b.password !== undefined ? hashPassword(reqPassword(b.password)) : undefined;
    if (displayName !== undefined) c.user.displayName = displayName;
    if (passwordHash !== undefined) c.user.passwordHash = passwordHash;
    return { user: userOut(c.user) };
  });

  // ---- API tokens ----
  route('POST', '/api/tokens', (c) => {
    const name = reqStr(c.json().name, 'name', 100);
    const token = randomToken();
    const rec = { id: newId(), userId: c.user.id, name, kind: 'api', hash: sha256(token), createdAt: nowIso() };
    state.tokens.push(rec);
    for (const ws of state.workspaces) if (wsRoleOf(ws, c.user.id) === 'admin') audit(ws.id, c.user.id, 'token.created', rec.id, { name });
    c.status = 201;
    return { id: rec.id, name, token };
  });

  route('GET', '/api/tokens', (c) => state.tokens
    .filter((t) => t.userId === c.user.id && t.kind === 'api')
    .map((t) => ({ id: t.id, name: t.name, createdAt: t.createdAt })));

  route('DELETE', '/api/tokens/:id', (c) => {
    const t = state.tokens.find((x) => x.id === c.params.id && x.userId === c.user.id && x.kind === 'api');
    if (!t) throw notFound('token not found');
    state.tokens = state.tokens.filter((x) => x !== t);
    for (const ws of state.workspaces) if (wsRoleOf(ws, c.user.id) === 'admin') audit(ws.id, c.user.id, 'token.deleted', t.id, { name: t.name });
    return NONE;
  });

  // ---- workspaces ----
  route('GET', '/api/workspaces', (c) => state.workspaces
    .filter((w) => wsRoleOf(w, c.user.id))
    .map((w) => wsOut(w, c.user.id)));

  route('POST', '/api/workspaces', (c) => {
    const b = c.json();
    const name = reqStr(b.name, 'name', 100);
    const key = normKey(b.key);
    if (state.workspaces.some((w) => w.key === key)) throw conflict('workspace key already in use');
    const ws = { id: newId(), name, key, members: [{ userId: c.user.id, role: 'admin' }], createdAt: nowIso() };
    state.workspaces.push(ws);
    c.status = 201;
    return wsOut(ws, c.user.id);
  });

  route('GET', '/api/workspaces/:id', (c) => wsOut(requireWs(c.params.id, c.user).ws, c.user.id));

  route('GET', '/api/workspaces/:id/members', (c) => requireWs(c.params.id, c.user).ws.members.map(memberOut));

  route('POST', '/api/workspaces/:id/members', (c) => {
    const { ws } = requireWs(c.params.id, c.user, { admin: true });
    const b = c.json();
    const u = findUserRef(b.username ?? b.userId);
    if (!u) throw notFound('user not found');
    const role = pick(b.role, WS_ROLES, 'role');
    if (ws.members.some((m) => m.userId === u.id)) throw conflict('user is already a member');
    const m = { userId: u.id, role };
    ws.members.push(m);
    audit(ws.id, c.user.id, 'member.added', u.id, { role });
    c.status = 201;
    return memberOut(m);
  });

  const adminCount = (ws) => ws.members.filter((m) => m.role === 'admin').length;

  route('PATCH', '/api/workspaces/:id/members/:ref', (c) => {
    const { ws } = requireWs(c.params.id, c.user, { admin: true });
    const u = findUserRef(c.params.ref);
    const m = u && ws.members.find((x) => x.userId === u.id);
    if (!m) throw notFound('member not found');
    const role = pick(c.json().role, WS_ROLES, 'role');
    if (m.role === 'admin' && role !== 'admin' && adminCount(ws) === 1) throw bad('cannot demote the last admin');
    if (m.role !== role) {
      audit(ws.id, c.user.id, 'member.role_changed', u.id, { from: m.role, to: role });
      m.role = role;
    }
    return memberOut(m);
  });

  route('DELETE', '/api/workspaces/:id/members/:ref', (c) => {
    const { ws } = requireWs(c.params.id, c.user, { admin: true });
    const u = findUserRef(c.params.ref);
    const m = u && ws.members.find((x) => x.userId === u.id);
    if (!m) throw notFound('member not found');
    if (m.role === 'admin' && adminCount(ws) === 1) throw bad('cannot remove the last admin');
    ws.members = ws.members.filter((x) => x !== m);
    for (const p of state.projects.filter((x) => x.workspaceId === ws.id)) {
      p.members = p.members.filter((x) => x.userId !== u.id);
    }
    audit(ws.id, c.user.id, 'member.removed', u.id, null);
    return NONE;
  });

  route('GET', '/api/workspaces/:id/audit', (c) => {
    const { ws } = requireWs(c.params.id, c.user, { admin: true });
    return state.audit
      .filter((a) => a.workspaceId === ws.id)
      .sort((a, b) => b._n - a._n)
      .map(({ id, action, actorId, targetId, details, at }) => ({ id, action, actorId, targetId, details, at }));
  });

  // ---- projects ----
  route('GET', '/api/workspaces/:id/projects', (c) => {
    const { ws } = requireWs(c.params.id, c.user);
    return state.projects.filter((p) => p.workspaceId === ws.id && canSee(p, c.user.id)).map(projectOut);
  });

  route('POST', '/api/workspaces/:id/projects', (c) => {
    const { ws, role } = requireWs(c.params.id, c.user);
    if (role === 'guest') throw forbidden('guests cannot create projects');
    const b = c.json();
    const name = reqStr(b.name, 'name', 100);
    const key = normKey(b.key);
    if (state.projects.some((p) => p.key === key)) throw conflict('project key already in use');
    const project = {
      id: newId(), workspaceId: ws.id, name, key, workflow: defaultWorkflow(),
      members: [{ userId: c.user.id, role: 'lead' }], seq: 0, createdAt: nowIso(),
    };
    state.projects.push(project);
    c.status = 201;
    return projectOut(project);
  });

  route('GET', '/api/projects/:id', (c) => projectOut(requireProject(c.params.id, c.user).project));

  route('PATCH', '/api/projects/:id', (c) => {
    const { project } = requireProject(c.params.id, c.user, 'lead');
    const b = c.json();
    const name = 'name' in b ? reqStr(b.name, 'name', 100) : undefined;
    if (name !== undefined) project.name = name;
    return projectOut(project);
  });

  route('DELETE', '/api/projects/:id', (c) => {
    const { project } = requireProject(c.params.id, c.user);
    requireWs(project.workspaceId, c.user, { admin: true });
    const hookIds = new Set(state.webhooks.filter((w) => w.projectId === project.id).map((w) => w.id));
    state.issues = state.issues.filter((i) => i.projectId !== project.id);
    const issueIds = new Set(state.issues.map((i) => i.id));
    state.comments = state.comments.filter((cm) => issueIds.has(cm.issueId));
    state.sprints = state.sprints.filter((s) => s.projectId !== project.id);
    state.webhooks = state.webhooks.filter((w) => w.projectId !== project.id);
    state.deliveries = state.deliveries.filter((d) => !hookIds.has(d.webhookId));
    state.projects = state.projects.filter((p) => p !== project);
    return NONE;
  });

  route('POST', '/api/projects/:id/members', (c) => {
    const { project } = requireProject(c.params.id, c.user, 'lead');
    const b = c.json();
    const u = findUserRef(b.username ?? b.userId);
    if (!u) throw notFound('user not found');
    if (!wsRoleOf(wsById(project.workspaceId), u.id)) throw bad('user is not a workspace member');
    const role = pick(b.role, PROJECT_ROLES, 'role');
    const existing = project.members.find((m) => m.userId === u.id);
    if (existing) {
      if (existing.role !== role) auditProject(project, c.user.id, 'project.member.role_changed', u.id, { from: existing.role, to: role });
      existing.role = role;
      return { userId: u.id, username: u.username, role };
    }
    project.members.push({ userId: u.id, role });
    auditProject(project, c.user.id, 'project.member.added', u.id, { role });
    c.status = 201;
    return { userId: u.id, username: u.username, role };
  });

  route('PATCH', '/api/projects/:id/members/:ref', (c) => {
    const { project } = requireProject(c.params.id, c.user, 'lead');
    const u = findUserRef(c.params.ref);
    const m = u && project.members.find((x) => x.userId === u.id);
    if (!m) throw notFound('project member not found');
    const role = pick(c.json().role, PROJECT_ROLES, 'role');
    if (m.role !== role) auditProject(project, c.user.id, 'project.member.role_changed', u.id, { from: m.role, to: role });
    m.role = role;
    return { userId: u.id, username: u.username, role };
  });

  route('DELETE', '/api/projects/:id/members/:ref', (c) => {
    const { project } = requireProject(c.params.id, c.user, 'lead');
    const u = findUserRef(c.params.ref);
    const m = u && project.members.find((x) => x.userId === u.id);
    if (!m) throw notFound('project member not found');
    project.members = project.members.filter((x) => x !== m);
    auditProject(project, c.user.id, 'project.member.removed', u.id, null);
    return NONE;
  });

  route('GET', '/api/projects/:id/workflow', (c) => requireProject(c.params.id, c.user).project.workflow);

  route('PUT', '/api/projects/:id/workflow', (c) => {
    const { project } = requireProject(c.params.id, c.user, 'lead');
    const b = c.json();
    const wf = parseWorkflow(b);
    const remap = b.remap === undefined || b.remap === null ? {} : b.remap;
    if (typeof remap !== 'object' || Array.isArray(remap)) throw bad('remap must be an object');
    const newNames = new Set(wf.statuses.map((s) => s.name));
    for (const to of Object.values(remap)) {
      if (!newNames.has(to)) throw bad(`remap target "${to}" is not a status in the new workflow`);
    }
    const projectIssues = state.issues.filter((i) => i.projectId === project.id);
    for (const i of projectIssues) {
      if (!newNames.has(i.status) && !Object.prototype.hasOwnProperty.call(remap, i.status)) {
        throw bad(`status "${i.status}" is in use by issues and must be remapped`);
      }
    }
    const t = nowIso();
    for (const i of projectIssues) {
      if (newNames.has(i.status)) continue;
      const to = remap[i.status];
      i.history.push({ field: 'status', from: i.status, to, actorId: c.user.id, at: t });
      i.status = to;
      i.updatedAt = t;
    }
    project.workflow = wf;
    for (const i of projectIssues) {
      const done = isDone(project, i.status);
      if (done && !i.resolvedAt) i.resolvedAt = t;
      else if (!done) i.resolvedAt = null;
    }
    auditProject(project, c.user.id, 'workflow.updated', project.id, { statuses: wf.statuses.map((s) => s.name) });
    return wf;
  });

  route('GET', '/api/projects/:id/stats', (c) => projectStats(requireProject(c.params.id, c.user).project));

  // ---- issues ----
  route('GET', '/api/projects/:id/issues', (c) => {
    const { project } = requireProject(c.params.id, c.user);
    return sortByN(state.issues.filter((i) => i.projectId === project.id)).map(issueOut);
  });

  route('POST', '/api/projects/:id/issues', (c) => {
    const { project } = requireProject(c.params.id, c.user, 'developer');
    const issue = createIssue(project, c.user, c.json());
    c.status = 201;
    return issueOut(issue);
  });

  route('GET', '/api/issues/:key', (c) => issueOut(requireIssue(c.params.key, c.user).issue));

  route('PATCH', '/api/issues/:key', (c) => {
    const { issue, project } = requireIssue(c.params.key, c.user, 'developer');
    return issueOut(updateIssue(issue, project, c.user, c.json()));
  });

  route('DELETE', '/api/issues/:key', (c) => {
    const { issue, project } = requireIssue(c.params.key, c.user, 'developer');
    deleteIssue(issue, project, c.user);
    return NONE;
  });

  route('GET', '/api/issues/:key/history', (c) => requireIssue(c.params.key, c.user).issue.history
    .map((h) => ({ field: h.field, from: h.from, to: h.to, actorId: h.actorId, at: h.at })));

  route('POST', '/api/issues/:key/links', (c) => {
    const { issue } = requireIssue(c.params.key, c.user, 'developer');
    const b = c.json();
    const type = pick(b.type, LINK_TYPES, 'link type');
    const target = resolveIssue(b.target);
    if (!target) throw notFound('target issue not found');
    requireProject(target.projectId, c.user);
    addLink(issue, target, type);
    c.status = 201;
    return { type, target: target.key };
  });

  route('DELETE', '/api/issues/:key/links/:type/:target', (c) => {
    const { issue } = requireIssue(c.params.key, c.user, 'developer');
    const target = resolveIssue(c.params.target);
    if (!target) throw notFound('target issue not found');
    removeLink(issue, target, pick(c.params.type, LINK_TYPES, 'link type'));
    return NONE;
  });

  route('POST', '/api/issues/:key/watch', (c) => {
    const { issue } = requireIssue(c.params.key, c.user);
    if (!issue.watchers.includes(c.user.id)) issue.watchers.push(c.user.id);
    return issueOut(issue);
  });

  route('DELETE', '/api/issues/:key/watch', (c) => {
    const { issue } = requireIssue(c.params.key, c.user);
    issue.watchers = issue.watchers.filter((u) => u !== c.user.id);
    return issueOut(issue);
  });

  // ---- comments ----
  route('GET', '/api/issues/:key/comments', (c) => {
    const { issue } = requireIssue(c.params.key, c.user);
    return sortByN(state.comments.filter((x) => x.issueId === issue.id)).map(commentOut);
  });

  route('POST', '/api/issues/:key/comments', (c) => {
    const { issue, project } = requireIssue(c.params.key, c.user, 'developer');
    const text = reqStr(c.json().body, 'body', 10000);
    const cm = createComment(issue, project, c.user, text);
    c.status = 201;
    return commentOut(cm);
  });

  const findComment = (id) => {
    const cm = state.comments.find((x) => x.id === id);
    if (!cm) throw notFound('comment not found');
    const issue = issueById(cm.issueId);
    return { cm, project: projById(issue.projectId) };
  };

  route('PATCH', '/api/comments/:id', (c) => {
    const { cm, project } = findComment(c.params.id);
    requireProject(project.id, c.user, 'developer');
    if (cm.authorId !== c.user.id) throw forbidden('only the author can edit this comment');
    cm.body = reqStr(c.json().body, 'body', 10000);
    cm.edited = true;
    cm.updatedAt = nowIso();
    return commentOut(cm);
  });

  route('DELETE', '/api/comments/:id', (c) => {
    const { cm, project } = findComment(c.params.id);
    const { role } = requireProject(project.id, c.user, 'viewer');
    if (cm.authorId !== c.user.id && role !== 'lead') throw forbidden('only the author or a lead can delete this comment');
    state.comments = state.comments.filter((x) => x !== cm);
    return NONE;
  });

  // ---- notifications ----
  route('GET', '/api/notifications', (c) => {
    const unread = c.query.get('unread') === 'true';
    return state.notifications
      .filter((n) => n.userId === c.user.id && (!unread || !n.read))
      .sort((a, b) => b.at.localeCompare(a.at) || b._n - a._n)
      .map(notifOut);
  });

  route('POST', '/api/notifications/read', (c) => {
    const b = c.json();
    const ids = Array.isArray(b.ids) ? new Set(b.ids) : null;
    let updated = 0;
    for (const n of state.notifications) {
      if (n.userId !== c.user.id || n.read) continue;
      if (b.all === true || (ids && ids.has(n.id))) { n.read = true; updated++; }
    }
    return { updated };
  });

  // ---- sprints ----
  route('GET', '/api/projects/:id/sprints', (c) => {
    const { project } = requireProject(c.params.id, c.user);
    return sortByN(state.sprints.filter((s) => s.projectId === project.id)).map(sprintOut);
  });

  route('POST', '/api/projects/:id/sprints', (c) => {
    const { project } = requireProject(c.params.id, c.user, 'developer');
    const b = c.json();
    const name = reqStr(b.name, 'name', 100);
    const startDate = normDate(b.startDate);
    const endDate = normDate(b.endDate);
    if (startDate && endDate && endDate < startDate) throw bad('endDate must be on or after startDate');
    const sprint = {
      id: newId(), projectId: project.id, name, state: 'planned', startDate, endDate,
      startedAt: null, completedAt: null, carriedOver: [], createdAt: nowIso(), _n: seq(),
    };
    state.sprints.push(sprint);
    c.status = 201;
    return sprintOut(sprint);
  });

  route('GET', '/api/sprints/:id', (c) => sprintOut(requireSprint(c.params.id, c.user).sprint));

  route('POST', '/api/sprints/:id/start', (c) => {
    const { sprint, project } = requireSprint(c.params.id, c.user, 'developer');
    if (sprint.state !== 'planned') throw new ApiError(409, 'invalid_state', 'only planned sprints can be started');
    if (state.sprints.some((s) => s.projectId === project.id && s.state === 'active')) {
      throw new ApiError(409, 'active_sprint_exists', 'another sprint is already active in this project');
    }
    sprint.state = 'active';
    sprint.startedAt = nowIso();
    return sprintOut(sprint);
  });

  route('POST', '/api/sprints/:id/complete', (c) => {
    const { sprint, project } = requireSprint(c.params.id, c.user, 'developer');
    if (sprint.state !== 'active') throw new ApiError(409, 'invalid_state', 'only active sprints can be completed');
    const b = c.json();
    const target = b.carryOverTo === undefined || b.carryOverTo === null ? 'backlog' : b.carryOverTo;
    let dest = null;
    if (target !== 'backlog') {
      dest = state.sprints.find((s) => s.id === target && s.projectId === project.id);
      if (!dest || dest.state === 'completed' || dest.id === sprint.id) {
        throw bad('carryOverTo must be "backlog" or a planned/active sprint in this project');
      }
    }
    const t = nowIso();
    const carried = [];
    const to = dest ? dest.id : null;
    for (const i of state.issues) {
      if (i.sprintId !== sprint.id || isDone(project, i.status)) continue;
      i.history.push({ field: 'sprintId', from: sprint.id, to, actorId: c.user.id, at: t });
      i.sprintId = to;
      i.updatedAt = t;
      carried.push(i.key);
    }
    sprint.state = 'completed';
    sprint.completedAt = t;
    sprint.carriedOver = carried;
    return sprintOut(sprint);
  });

  route('GET', '/api/sprints/:id/report', (c) => {
    const { sprint, project } = requireSprint(c.params.id, c.user);
    return sprintReport(sprint, project);
  });

  // ---- webhooks ----
  route('POST', '/api/projects/:id/webhooks', (c) => {
    const { project } = requireProject(c.params.id, c.user, 'lead');
    const b = c.json();
    let parsed;
    try {
      parsed = new URL(String(b.url || ''));
    } catch {
      throw bad('invalid url');
    }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw bad('url must be http or https');
    if (!Array.isArray(b.events) || b.events.length === 0 || b.events.some((e) => !EVENTS.includes(e))) {
      throw bad(`events must be a non-empty subset of ${EVENTS.join(', ')}`);
    }
    const secret = reqStr(b.secret, 'secret', 200);
    const hook = { id: newId(), projectId: project.id, url: parsed.toString(), events: [...new Set(b.events)], secret, createdAt: nowIso(), _n: seq() };
    state.webhooks.push(hook);
    auditProject(project, c.user.id, 'webhook.created', hook.id, { url: hook.url, events: hook.events });
    c.status = 201;
    return hookOut(hook);
  });

  route('GET', '/api/projects/:id/webhooks', (c) => {
    const { project } = requireProject(c.params.id, c.user, 'lead');
    return state.webhooks.filter((w) => w.projectId === project.id).map(hookOut);
  });

  const hookAccess = (id, user) => {
    const hook = state.webhooks.find((w) => w.id === id);
    if (!hook) throw notFound('webhook not found');
    const { project } = requireProject(hook.projectId, user, 'lead');
    return { hook, project };
  };

  route('DELETE', '/api/webhooks/:id', (c) => {
    const { hook, project } = hookAccess(c.params.id, c.user);
    state.webhooks = state.webhooks.filter((w) => w !== hook);
    state.deliveries = state.deliveries.filter((d) => d.webhookId !== hook.id);
    auditProject(project, c.user.id, 'webhook.deleted', hook.id, { url: hook.url });
    return NONE;
  });

  route('GET', '/api/webhooks/:id/deliveries', (c) => {
    const { hook } = hookAccess(c.params.id, c.user);
    return sortByN(state.deliveries.filter((d) => d.webhookId === hook.id))
      .map((d) => ({ id: d.id, event: d.event, status: d.status, attempts: d.attempts, lastError: d.lastError, at: d.at }));
  });

  // ---- search ----
  route('GET', '/api/search', (c) => {
    const terms = parseQuery(c.query.get('q') || '');
    const sort = c.query.get('sort') || 'updated';
    if (!SORTS.includes(sort)) throw bad('invalid sort');
    let projects = state.projects.filter((p) => canSee(p, c.user.id));
    const pv = c.query.get('project');
    if (pv) {
      const p = projects.find((x) => x.id === pv || x.key === pv.toUpperCase());
      if (!p) throw notFound('project not found');
      projects = [p];
    }
    const ids = new Set(projects.map((p) => p.id));
    const env = searchEnv(c.user.id);
    const list = state.issues.filter((i) => ids.has(i.projectId) && matchesAll(terms, i, env));
    return sortIssues(list, sort).map(issueOut);
  });

  // ---- import / export ----
  route('GET', '/api/projects/:id/export.csv', (c) => {
    const { project } = requireProject(c.params.id, c.user);
    const issues = sortByN(state.issues.filter((i) => i.projectId === project.id));
    const keyOf = (id) => (id ? (issueById(id) || {}).key ?? '' : '');
    const sprintName = (id) => (id ? (state.sprints.find((s) => s.id === id) || {}).name ?? '' : '');
    const rows = [CSV_COLUMNS, ...issues.map((i) => [
      i.key, i.type, i.title, i.status, i.priority, usernameOf(i.assigneeId) ?? '',
      i.labels.join(';'), i.storyPoints ?? '', keyOf(i.parentId), keyOf(i.epicId), sprintName(i.sprintId),
      i.dueDate ?? '', i.createdAt, i.resolvedAt ?? '',
    ])];
    return new Raw(rows.map(csvLine).join(''), 'text/csv; charset=utf-8', `${project.key}-issues.csv`);
  });

  route('POST', '/api/projects/:id/import.csv', (c) => {
    const { project } = requireProject(c.params.id, c.user, 'developer');
    let records;
    try {
      records = parseCsv(c.raw);
    } catch (e) {
      throw bad(e.message);
    }
    if (!records.length) return { created: 0, errors: [] };
    const header = records[0].fields.map((h) => h.trim().toLowerCase());
    if (!header.includes('title')) throw bad('CSV header must include a title column');
    const errors = [];
    let created = 0;
    for (const rec of records.slice(1)) {
      try {
        const get = (name) => {
          const idx = header.indexOf(name);
          return idx < 0 ? '' : (rec.fields[idx] ?? '').trim();
        };
        createIssue(project, c.user, buildImportInput(project, get));
        created++;
      } catch (e) {
        if (e instanceof ApiError) errors.push({ line: rec.line, message: e.message });
        else throw e;
      }
    }
    return { created, errors };
  });

  // ---------- HTTP plumbing ----------
  function authenticate(req, ctx) {
    const m = /^Bearer\s+(\S+)/i.exec(req.headers.authorization || '');
    if (!m) throw new ApiError(401, 'unauthenticated', 'missing bearer token');
    const tok = state.tokens.find((t) => t.hash === sha256(m[1]));
    if (!tok) throw new ApiError(401, 'unauthenticated', 'invalid token');
    const user = userById(tok.userId);
    if (!user) throw new ApiError(401, 'unauthenticated', 'invalid token');
    ctx.user = user;
    ctx.tokenId = tok.id;
  }

  async function dispatch(req, res, url) {
    let matched = null;
    let params = {};
    for (const r of routes) {
      const m = r.re.exec(url.pathname);
      if (m && r.method === req.method) {
        matched = r;
        try {
          params = Object.fromEntries(r.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
        } catch {
          throw bad('malformed URL encoding');
        }
        break;
      }
    }
    if (!matched) throw notFound('no such route');
    const raw = await readBody(req);
    const ctx = {
      params,
      query: url.searchParams,
      raw,
      status: 200,
      user: null,
      tokenId: null,
      json: () => jsonBody(raw),
    };
    if (matched.auth) authenticate(req, ctx);
    const data = await matched.handler(ctx);
    if (req.method !== 'GET') save();
    if (data === NONE) {
      res.writeHead(204);
      res.end();
      return;
    }
    if (data instanceof Raw) {
      const headers = { 'content-type': data.type };
      if (data.filename) headers['content-disposition'] = `attachment; filename="${data.filename}"`;
      res.writeHead(200, headers);
      res.end(data.body);
      return;
    }
    sendJson(res, ctx.status, data);
  }

  function serveStatic(req, res, pathname) {
    let rel;
    if (pathname.startsWith('/static/')) rel = pathname.slice('/static/'.length);
    else rel = 'index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        await dispatch(req, res, url);
      } else if (req.method === 'GET' || req.method === 'HEAD') {
        serveStatic(req, res, url.pathname);
      } else {
        sendJson(res, 404, { error: 'not_found', message: 'no such route' });
      }
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      if (err instanceof ApiError) {
        sendJson(res, err.status, { error: err.code, message: err.message });
      } else {
        console.error(err);
        sendJson(res, 500, { error: 'internal', message: 'internal server error' });
      }
    }
  });

  return server;
}
