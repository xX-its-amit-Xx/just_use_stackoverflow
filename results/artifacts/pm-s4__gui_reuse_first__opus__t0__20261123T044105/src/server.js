// pm-s4 — lightweight project-management server. node:http + stdlib only.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parse as csvParse } from './vendor/csv-parse.js';
import { stringify as csvStringify } from './vendor/csv-stringify.js';
import { compileQuery, QueryError } from './search.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, 'static');

const ISSUE_TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'];
const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
const CATEGORIES = ['backlog', 'unstarted', 'started', 'completed', 'canceled'];
const WS_ROLES = ['admin', 'member', 'guest'];
const PROJECT_ROLES = ['lead', 'developer', 'viewer'];
const ROLE_RANK = { viewer: 0, developer: 1, lead: 2 };
const LINK_TYPES = ['blocks', 'relates', 'duplicates'];
const LINK_INVERSE = { blocks: 'blocked_by', relates: 'relates', duplicates: 'duplicated_by' };
const WEBHOOK_EVENTS = ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'];
const CSV_COLUMNS = ['key', 'type', 'title', 'status', 'priority', 'assignee', 'labels', 'storyPoints', 'parent', 'epic', 'sprint', 'dueDate', 'createdAt', 'resolvedAt'];
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 5;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}
const bad = (msg, code = 'validation_error') => new HttpError(400, code, msg);
const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found`);
const forbidden = (msg = 'Forbidden') => new HttpError(403, 'forbidden', msg);
const conflict = (msg, code = 'conflict') => new HttpError(409, code, msg);

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const newId = () => crypto.randomUUID();
const newToken = (prefix = '') => prefix + crypto.randomBytes(24).toString('hex');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 32, { N: 1024, r: 8, p: 1 }).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const h = hashPassword(password, salt).hash;
  return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex'));
}

function emptyDb() {
  return {
    users: [], sessions: [], apiTokens: [], workspaces: [], projects: [], issues: [], links: [],
    history: [], comments: [], notifications: [], sprints: [], webhooks: [], deliveries: [], audit: []
  };
}

const isStr = v => typeof v === 'string';
const isNonEmptyStr = v => typeof v === 'string' && v.trim() !== '';

export function createServer({ dataFile, clock } = {}) {
  const now = () => (clock ? new Date(clock()) : new Date());
  const nowIso = () => now().toISOString();

  // ---------- persistence ----------
  let db = emptyDb();
  if (dataFile && fs.existsSync(dataFile)) {
    try {
      const raw = fs.readFileSync(dataFile, 'utf8');
      if (raw.trim()) db = { ...emptyDb(), ...JSON.parse(raw) };
    } catch { db = emptyDb(); }
  }
  function save() {
    if (!dataFile) return;
    const tmp = `${dataFile}.${process.pid}.tmp`;
    fs.mkdirSync(path.dirname(path.resolve(dataFile)), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, dataFile);
  }
  const loginFailures = new Map();

  // ---------- views & lookups ----------
  const userById = id => db.users.find(u => u.id === id);
  const userByName = name => isStr(name) ? db.users.find(u => u.username.toLowerCase() === name.toLowerCase()) : undefined;
  const publicUser = u => u ? { id: u.id, username: u.username, displayName: u.displayName } : null;

  function wsMember(ws, userId) { return ws.members.find(m => m.userId === userId); }
  function getWorkspace(id, user) {
    const ws = db.workspaces.find(w => w.id === id);
    if (!ws) throw notFound('Workspace');
    const m = wsMember(ws, user.id);
    if (!m) throw forbidden('Not a member of this workspace');
    return { ws, role: m.role };
  }
  function wsView(ws, userId) {
    const m = wsMember(ws, userId);
    return { id: ws.id, name: ws.name, key: ws.key, createdAt: ws.createdAt, role: m ? m.role : null };
  }
  function wsMemberView(m) {
    const u = userById(m.userId);
    return { userId: m.userId, username: u?.username, displayName: u?.displayName, role: m.role };
  }

  function projectRole(project, userId) {
    const ws = db.workspaces.find(w => w.id === project.workspaceId);
    if (!ws) return null;
    const m = wsMember(ws, userId);
    if (!m) return null;
    if (m.role === 'admin') return 'lead';
    const pm = project.members.find(x => x.userId === userId);
    if (pm) return pm.role;
    if (m.role === 'guest' || project.private) return null;
    return 'developer';
  }
  function getProject(idOrKey, user, minRole = 'viewer') {
    let p = db.projects.find(x => x.id === idOrKey);
    if (!p && isStr(idOrKey)) {
      const visible = db.projects.filter(x => x.key === idOrKey.toUpperCase());
      p = visible.find(x => projectRole(x, user.id)) || visible[0];
    }
    if (!p) throw notFound('Project');
    const role = projectRole(p, user.id);
    if (!role) throw forbidden('No access to this project');
    if (ROLE_RANK[role] < ROLE_RANK[minRole]) throw forbidden(`Requires project role ${minRole}`);
    return { project: p, role };
  }
  function projectView(p, userId) {
    return {
      id: p.id, workspaceId: p.workspaceId, name: p.name, key: p.key, description: p.description || '',
      private: !!p.private, workflow: p.workflow, members: p.members.map(projMemberView),
      createdAt: p.createdAt, role: userId ? projectRole(p, userId) : undefined
    };
  }
  function projMemberView(m) {
    const u = userById(m.userId);
    return { userId: m.userId, username: u?.username, displayName: u?.displayName, role: m.role };
  }
  const canSeeProject = (p, userId) => !!projectRole(p, userId);

  const statusDef = (project, name) => project.workflow.statuses.find(s => s.name === name);
  const categoryOf = (project, name) => statusDef(project, name)?.category;
  const projectOf = issue => db.projects.find(p => p.id === issue.projectId);
  const isResolved = issue => !!issue.resolvedAt;

  function findIssue(keyOrId) {
    if (!isStr(keyOrId)) return undefined;
    return db.issues.find(i => i.id === keyOrId) || db.issues.find(i => i.key === keyOrId.toUpperCase());
  }
  function getIssue(key, user, minRole = 'viewer') {
    const issue = findIssue(key);
    if (!issue) throw notFound('Issue');
    const { project, role } = getProject(issue.projectId, user, minRole);
    return { issue, project, role };
  }
  function issueLinks(issue) {
    const out = [];
    for (const l of db.links) {
      if (l.sourceId === issue.id) {
        const t = db.issues.find(i => i.id === l.targetId);
        if (t) out.push({ id: l.id, type: l.type, issueKey: t.key, issueId: t.id });
      } else if (l.targetId === issue.id) {
        const s = db.issues.find(i => i.id === l.sourceId);
        if (s) out.push({ id: l.id, type: LINK_INVERSE[l.type], issueKey: s.key, issueId: s.id });
      }
    }
    return out;
  }
  function issueView(issue) {
    const v = {
      id: issue.id, key: issue.key, projectId: issue.projectId, type: issue.type, title: issue.title,
      description: issue.description, status: issue.status, priority: issue.priority, assigneeId: issue.assigneeId,
      reporterId: issue.reporterId, labels: [...issue.labels], storyPoints: issue.storyPoints, parentId: issue.parentId,
      epicId: issue.epicId, sprintId: issue.sprintId, dueDate: issue.dueDate, watchers: [...issue.watchers],
      createdAt: issue.createdAt, updatedAt: issue.updatedAt, resolvedAt: issue.resolvedAt, startedAt: issue.startedAt || null
    };
    v.children = db.issues.filter(c => c.parentId === issue.id).map(c => c.key);
    v.links = issueLinks(issue);
    if (issue.type === 'epic') {
      const kids = db.issues.filter(c => c.epicId === issue.id);
      const done = kids.filter(isResolved);
      const pts = arr => arr.reduce((s, c) => s + (typeof c.storyPoints === 'number' ? c.storyPoints : 0), 0);
      v.progress = { total: kids.length, done: done.length, points_total: pts(kids), points_done: pts(done) };
    }
    return v;
  }
  function sprintView(s) {
    return {
      id: s.id, projectId: s.projectId, name: s.name, goal: s.goal || '', state: s.state, startDate: s.startDate,
      endDate: s.endDate, startedAt: s.startedAt, completedAt: s.completedAt, createdAt: s.createdAt,
      issueKeys: db.issues.filter(i => i.sprintId === s.id).map(i => i.key)
    };
  }

  // ---------- audit, notifications, webhooks ----------
  function audit(workspaceId, actorId, action, details = {}) {
    db.audit.push({ id: newId(), workspaceId, action, actorId, at: nowIso(), details });
  }
  function notify(userId, type, issue, actorId, extra = {}) {
    if (!userId || userId === actorId) return;
    db.notifications.push({ id: newId(), userId, type, issueKey: issue.key, actorId, at: nowIso(), read: false, ...extra });
  }
  function notifyWatchers(issue, type, actorId, skip = new Set(), extra = {}) {
    for (const w of issue.watchers) if (!skip.has(w)) notify(w, type, issue, actorId, extra);
  }

  const pendingDeliveries = new Set();
  function emit(project, event, payload) {
    const hooks = db.webhooks.filter(h => h.projectId === project.id && h.events.includes(event));
    for (const h of hooks) {
      const body = JSON.stringify({ event, ...payload });
      const delivery = { id: newId(), webhookId: h.id, event, status: null, attempts: 0, lastError: null, at: nowIso(), deliveredAt: null };
      db.deliveries.push(delivery);
      const p = deliver(h, delivery, body).finally(() => pendingDeliveries.delete(p));
      pendingDeliveries.add(p);
    }
  }
  async function deliver(hook, delivery, body) {
    const sig = 'sha256=' + crypto.createHmac('sha256', hook.secret || '').update(body).digest('hex');
    for (let attempt = 1; attempt <= 3; attempt++) {
      delivery.attempts = attempt;
      try {
        const res = await fetch(hook.url, {
          method: 'POST', body,
          headers: { 'content-type': 'application/json', 'x-pm-signature': sig, 'x-pm-event': delivery.event, 'x-pm-delivery': delivery.id },
          signal: AbortSignal.timeout(5000)
        });
        delivery.status = res.status;
        try { await res.arrayBuffer(); } catch { /* ignore */ }
        if (res.ok) { delivery.lastError = null; delivery.deliveredAt = new Date().toISOString(); break; }
        delivery.lastError = `HTTP ${res.status}`;
      } catch (e) {
        delivery.lastError = e?.cause?.message || e?.message || String(e);
      }
      if (attempt < 3) await new Promise(r => setTimeout(r, 25 * attempt));
    }
    try { save(); } catch { /* ignore */ }
  }

  // ---------- history ----------
  function record(issue, field, from, to, actorId, at) {
    const norm = v => (Array.isArray(v) ? [...v] : v === undefined ? null : v);
    db.history.push({ id: newId(), issueId: issue.id, field, from: norm(from), to: norm(to), actorId, at });
  }
  function valueAt(issue, field, t) {
    // value of field at time t (ms) reconstructed from history
    let v = issue[field];
    const hs = db.history.filter(h => h.issueId === issue.id && h.field === field);
    for (let k = hs.length - 1; k >= 0; k--) {
      if (Date.parse(hs[k].at) > t) v = hs[k].from; else break;
    }
    return v;
  }

  // ---------- validation helpers ----------
  function resolveIssueRef(ref, project) {
    if (ref === null || ref === undefined || ref === '') return null;
    const i = findIssue(String(ref));
    if (!i || i.projectId !== project.id) throw bad(`Referenced issue "${ref}" not found in project`);
    return i;
  }
  function resolveAssignee(val, project) {
    if (val === null || val === undefined || val === '') return null;
    if (!isStr(val)) throw bad('assigneeId must be a string');
    const u = userById(val) || userByName(val);
    if (!u) throw bad('Assignee not found');
    if (!canSeeProject(project, u.id)) throw bad('Assignee has no access to this project');
    return u.id;
  }
  function resolveSprint(val, project) {
    if (val === null || val === undefined || val === '' || val === 'backlog') return null;
    const s = db.sprints.find(x => x.projectId === project.id && (x.id === val || x.name === val));
    if (!s) throw bad('Sprint not found in project');
    if (s.state === 'completed') throw bad('Sprint is completed');
    return s.id;
  }
  function checkLabels(v) {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || !v.every(isStr)) throw bad('labels must be an array of strings');
    return [...new Set(v.map(s => s.trim()).filter(Boolean))];
  }
  function checkPoints(v) {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw bad('storyPoints must be a non-negative number');
    return v;
  }
  function checkDue(v) {
    if (v === undefined || v === null || v === '') return null;
    if (!isStr(v)) throw bad('dueDate must be a date string');
    const d = v.length > 10 && !isNaN(Date.parse(v)) ? v.slice(0, 10) : v;
    if (!DATE_RE.test(d) || isNaN(Date.parse(d))) throw bad('dueDate must be YYYY-MM-DD');
    return d;
  }

  // Validate hierarchy constraints: returns {parentId, epicId}
  function checkHierarchy(type, parentRef, epicRef, project, selfId) {
    let parentId = null, epicId = null;
    const parent = resolveIssueRef(parentRef, project);
    if (parent) {
      if (type === 'epic') throw bad('Epics cannot have a parent');
      if (parent.type === 'subtask') throw bad('Parent cannot be a subtask');
      if (parent.id === selfId) throw bad('Issue cannot be its own parent');
      parentId = parent.id;
    }
    if (type === 'subtask' && !parentId) throw bad('Subtasks require a parentId');
    if (epicRef !== null && epicRef !== undefined && epicRef !== '') {
      const e = findIssue(String(epicRef));
      if (!e || e.projectId !== project.id) throw bad('Epic not found in project');
      if (e.type !== 'epic') throw bad('epicId must reference an epic');
      if (type === 'epic') throw bad('Epics cannot belong to an epic');
      if (e.id === selfId) throw bad('Issue cannot be its own epic');
      epicId = e.id;
    }
    return { parentId, epicId };
  }

  function setStatus(issue, project, newStatus, actorId, at) {
    const oldCat = categoryOf(project, issue.status);
    const newCat = categoryOf(project, newStatus);
    record(issue, 'status', issue.status, newStatus, actorId, at);
    issue.status = newStatus;
    if (newCat === 'completed' && oldCat !== 'completed') issue.resolvedAt = at;
    else if (newCat !== 'completed') issue.resolvedAt = null;
    if (newCat === 'started' && !issue.startedAt) issue.startedAt = at;
  }

  function createIssue(project, user, body) {
    if (!body || typeof body !== 'object') throw bad('Body required');
    if (!isNonEmptyStr(body.title)) throw bad('title is required');
    if (body.title.length > 500) throw bad('title too long');
    const type = body.type === undefined || body.type === null ? 'task' : body.type;
    if (!ISSUE_TYPES.includes(type)) throw bad('Invalid type');
    const priority = body.priority === undefined || body.priority === null ? 'none' : body.priority;
    if (!PRIORITIES.includes(priority)) throw bad('Invalid priority');
    if (body.description !== undefined && body.description !== null && !isStr(body.description)) throw bad('description must be a string');
    let status;
    if (body.status !== undefined && body.status !== null) {
      if (!statusDef(project, body.status)) throw bad('Unknown status');
      status = body.status;
    } else {
      status = (project.workflow.statuses.find(s => s.category === 'unstarted') || project.workflow.statuses[0]).name;
    }
    const assigneeId = resolveAssignee(body.assigneeId !== undefined ? body.assigneeId : body.assignee, project);
    const labels = checkLabels(body.labels);
    const storyPoints = checkPoints(body.storyPoints);
    const dueDate = checkDue(body.dueDate);
    const sprintId = resolveSprint(body.sprintId, project);
    const { parentId, epicId } = checkHierarchy(type, body.parentId ?? body.parent, body.epicId ?? body.epic, project, null);
    const at = nowIso();
    project.issueSeq = (project.issueSeq || 0) + 1;
    const cat = categoryOf(project, status);
    const issue = {
      id: newId(), key: `${project.key}-${project.issueSeq}`, projectId: project.id, type, title: body.title.trim(),
      description: body.description || '', status, priority, assigneeId, reporterId: user.id, labels, storyPoints,
      parentId, epicId, sprintId, dueDate, watchers: [], createdAt: at, updatedAt: at,
      resolvedAt: cat === 'completed' ? at : null, startedAt: cat === 'started' ? at : null
    };
    issue.watchers.push(user.id);
    if (assigneeId && !issue.watchers.includes(assigneeId)) issue.watchers.push(assigneeId);
    db.issues.push(issue);
    if (assigneeId) notify(assigneeId, 'assignment', issue, user.id);
    emit(project, 'issue.created', { issue: issueView(issue), actorId: user.id, at });
    return issue;
  }

  function updateIssue(issue, project, user, body) {
    if (!body || typeof body !== 'object') throw bad('Body required');
    const at = nowIso();
    const changes = {};
    if ('title' in body) {
      if (!isNonEmptyStr(body.title)) throw bad('title must be a non-empty string');
      changes.title = body.title.trim();
    }
    if ('description' in body) {
      if (body.description !== null && !isStr(body.description)) throw bad('description must be a string');
      changes.description = body.description || '';
    }
    if ('type' in body) { if (!ISSUE_TYPES.includes(body.type)) throw bad('Invalid type'); changes.type = body.type; }
    if ('priority' in body) { if (!PRIORITIES.includes(body.priority)) throw bad('Invalid priority'); changes.priority = body.priority; }
    if ('assigneeId' in body || 'assignee' in body) changes.assigneeId = resolveAssignee('assigneeId' in body ? body.assigneeId : body.assignee, project);
    if ('labels' in body) changes.labels = checkLabels(body.labels);
    if ('storyPoints' in body) changes.storyPoints = checkPoints(body.storyPoints);
    if ('dueDate' in body) changes.dueDate = checkDue(body.dueDate);
    if ('sprintId' in body) {
      const sid = body.sprintId;
      if (sid !== null && sid !== '' && sid !== 'backlog' && sid === issue.sprintId) changes.sprintId = sid;
      else changes.sprintId = resolveSprint(sid, project);
    }
    const type = changes.type ?? issue.type;
    if ('parentId' in body || 'epicId' in body || 'type' in body || 'parent' in body || 'epic' in body) {
      const pRef = 'parentId' in body ? body.parentId : 'parent' in body ? body.parent : issue.parentId;
      const eRef = 'epicId' in body ? body.epicId : 'epic' in body ? body.epic : issue.epicId;
      const h = checkHierarchy(type, pRef, eRef, project, issue.id);
      if (type === 'subtask' && db.issues.some(c => c.parentId === issue.id)) throw bad('An issue with subtasks cannot become a subtask');
      if (issue.type === 'epic' && type !== 'epic' && db.issues.some(c => c.epicId === issue.id)) throw bad('Epic has issues; cannot change type');
      changes.parentId = h.parentId; changes.epicId = h.epicId;
    }
    let newStatus;
    if ('status' in body && body.status !== issue.status) {
      if (!statusDef(project, body.status)) throw bad('Unknown status');
      const allowed = project.workflow.transitions.some(([f, t]) => (f === issue.status || f === '*') && (t === body.status || t === '*'));
      if (!allowed) throw conflict(`Transition from "${issue.status}" to "${body.status}" is not allowed`, 'invalid_transition');
      if (categoryOf(project, body.status) === 'completed') {
        const blockers = db.links.filter(l => l.type === 'blocks' && l.targetId === issue.id)
          .map(l => db.issues.find(i => i.id === l.sourceId)).filter(b => b && !isResolved(b));
        if (blockers.length) throw conflict(`Blocked by ${blockers.map(b => b.key).join(', ')}`, 'blocked');
      }
      newStatus = body.status;
    }
    // apply
    let changed = false;
    const oldAssignee = issue.assigneeId;
    const oldStatus = issue.status;
    for (const [f, v] of Object.entries(changes)) {
      const cur = issue[f];
      const same = Array.isArray(v) ? JSON.stringify(v) === JSON.stringify(cur) : v === cur;
      if (same) continue;
      record(issue, f, cur, v, user.id, at);
      issue[f] = v;
      changed = true;
    }
    if (newStatus !== undefined) { setStatus(issue, project, newStatus, user.id, at); changed = true; }
    if (changed) {
      issue.updatedAt = at;
      if (newStatus !== undefined) notifyWatchers(issue, 'status_change', user.id, new Set(), { from: oldStatus, to: newStatus });
      if (issue.assigneeId !== oldAssignee) {
        if (issue.assigneeId && !issue.watchers.includes(issue.assigneeId)) issue.watchers.push(issue.assigneeId);
        notifyWatchers(issue, 'assignment', user.id);
      }
      emit(project, 'issue.updated', { issue: issueView(issue), actorId: user.id, at, changes: Object.keys(changes).concat(newStatus !== undefined ? ['status'] : []) });
    }
    return issue;
  }

  function deleteIssue(issue, project, user) {
    const at = nowIso();
    const victims = [issue, ...db.issues.filter(c => c.parentId === issue.id)];
    const ids = new Set(victims.map(v => v.id));
    const views = victims.map(issueView);
    db.issues = db.issues.filter(i => !ids.has(i.id));
    db.links = db.links.filter(l => !ids.has(l.sourceId) && !ids.has(l.targetId));
    db.comments = db.comments.filter(c => !ids.has(c.issueId));
    for (const i of db.issues) if (ids.has(i.epicId)) { record(i, 'epicId', i.epicId, null, user.id, at); i.epicId = null; }
    for (const v of views) emit(project, 'issue.deleted', { issue: v, actorId: user.id, at });
  }

  // ---------- auth ----------
  function authenticate(req) {
    const h = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return null;
    const tok = m[1].trim();
    const hh = sha256(tok);
    const s = db.sessions.find(x => x.tokenHash === hh);
    if (s) { const u = userById(s.userId); return u ? { user: u, session: s } : null; }
    const t = db.apiTokens.find(x => x.tokenHash === hh);
    if (t) { const u = userById(t.userId); if (u) { t.lastUsedAt = nowIso(); return { user: u, apiToken: t }; } }
    return null;
  }

  // ---------- workflow ----------
  function defaultWorkflow() {
    const statuses = [
      { name: 'Backlog', category: 'backlog' }, { name: 'Todo', category: 'unstarted' },
      { name: 'In Progress', category: 'started' }, { name: 'In Review', category: 'started' },
      { name: 'Done', category: 'completed' }
    ];
    return { statuses, transitions: allTransitions(statuses) };
  }
  function allTransitions(statuses) {
    const t = [];
    for (const a of statuses) for (const b of statuses) if (a.name !== b.name) t.push([a.name, b.name]);
    return t;
  }

  // ---------- reporting ----------
  const dayStr = d => new Date(d).toISOString().slice(0, 10);
  function sprintReport(sprint, project) {
    const inSprintNow = db.issues.filter(i => i.sprintId === sprint.id);
    const pts = i => (typeof i.storyPoints === 'number' ? i.storyPoints : 0);
    let committedPoints = sprint.committedPoints;
    if (committedPoints === undefined || committedPoints === null) committedPoints = sprint.state === 'planned' ? inSprintNow.reduce((s, i) => s + pts(i), 0) : 0;
    let completedPoints, completedIssues, carriedOver;
    if (sprint.state === 'completed' && sprint.completedPoints !== undefined) {
      completedPoints = sprint.completedPoints; completedIssues = sprint.completedIssues; carriedOver = sprint.carriedOver;
    } else {
      const done = inSprintNow.filter(isResolved);
      completedPoints = done.reduce((s, i) => s + pts(i), 0); completedIssues = done.length; carriedOver = 0;
    }
    const burndown = [];
    const start = sprint.startDate || (sprint.startedAt && dayStr(sprint.startedAt));
    if (start && sprint.state !== 'planned') {
      const today = dayStr(now());
      let last = today;
      if (sprint.endDate && sprint.endDate.slice(0, 10) < last) last = sprint.endDate.slice(0, 10);
      const nowMs = now().getTime();
      for (let d = start.slice(0, 10); d <= last; d = dayStr(Date.parse(d + 'T00:00:00Z') + 86400000)) {
        const t = Math.min(Date.parse(d + 'T00:00:00Z') + 86400000 - 1, nowMs);
        let remaining = 0;
        for (const i of db.issues) {
          if (i.projectId !== project.id) continue;
          if (Date.parse(i.createdAt) > t) continue;
          if (valueAt(i, 'sprintId', t) !== sprint.id) continue;
          const st = valueAt(i, 'status', t);
          if (categoryOf(project, st) === 'completed') continue;
          const p = valueAt(i, 'storyPoints', t);
          remaining += typeof p === 'number' ? p : 0;
        }
        burndown.push({ date: d, remainingPoints: remaining });
        if (burndown.length > 3660) break;
      }
    }
    return { sprintId: sprint.id, state: sprint.state, committedPoints, completedPoints, completedIssues, carriedOver, burndown };
  }

  function projectStats(project) {
    const issues = db.issues.filter(i => i.projectId === project.id);
    const byStatus = {}, byType = {}, byAssignee = {};
    for (const s of project.workflow.statuses) byStatus[s.name] = 0;
    for (const t of ISSUE_TYPES) byType[t] = 0;
    for (const i of issues) {
      byStatus[i.status] = (byStatus[i.status] || 0) + 1;
      byType[i.type] = (byType[i.type] || 0) + 1;
      const a = i.assigneeId || 'unassigned';
      byAssignee[a] = (byAssignee[a] || 0) + 1;
    }
    const cycles = issues.filter(i => i.resolvedAt && i.startedAt).map(i => (Date.parse(i.resolvedAt) - Date.parse(i.startedAt)) / 3600000).filter(h => h >= 0);
    const avg = cycles.length ? cycles.reduce((a, b) => a + b, 0) / cycles.length : null;
    return { total: issues.length, byStatus, byType, byAssignee, avgCycleTimeHours: avg, averageCycleTimeHours: avg, resolvedCount: issues.filter(isResolved).length };
  }

  // ---------- CSV ----------
  function exportCsv(project) {
    const rows = [CSV_COLUMNS];
    const issues = db.issues.filter(i => i.projectId === project.id).sort((a, b) => Number(a.key.split('-').pop()) - Number(b.key.split('-').pop()));
    for (const i of issues) {
      const ref = id => (id ? db.issues.find(x => x.id === id)?.key || '' : '');
      rows.push([
        i.key, i.type, i.title, i.status, i.priority, i.assigneeId ? userById(i.assigneeId)?.username || '' : '',
        i.labels.join(';'), i.storyPoints === null || i.storyPoints === undefined ? '' : String(i.storyPoints),
        ref(i.parentId), ref(i.epicId), i.sprintId ? db.sprints.find(s => s.id === i.sprintId)?.name || '' : '',
        i.dueDate || '', i.createdAt || '', i.resolvedAt || ''
      ].map(v => String(v)));
    }
    return csvStringify(rows, { eof: true, newline: '\r\n' });
  }

  function importCsv(project, user, text) {
    let rows;
    try { rows = csvParse(text.replace(/^﻿/, '')); } catch (e) { throw bad(`Malformed CSV: ${e.message}`); }
    if (!rows.length) throw bad('CSV is empty');
    const header = rows[0].map(h => String(h).trim());
    const idx = {};
    header.forEach((h, k) => { const c = CSV_COLUMNS.find(x => x.toLowerCase() === h.toLowerCase()); if (c) idx[c] = k; });
    if (idx.title === undefined) throw bad('CSV header must include title');
    let created = 0;
    const createdKeys = [];
    const errors = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const line = r + 1;
      if (row.every(v => String(v).trim() === '')) continue;
      const get = c => (idx[c] === undefined ? '' : String(row[idx[c]] ?? '').trim());
      try {
        const body = { title: get('title') };
        if (get('type')) body.type = get('type').toLowerCase();
        if (get('priority')) body.priority = get('priority').toLowerCase();
        if (get('status')) {
          const st = project.workflow.statuses.find(s => s.name.toLowerCase() === get('status').toLowerCase());
          if (!st) throw bad(`Unknown status "${get('status')}"`);
          body.status = st.name;
        }
        if (get('assignee')) {
          const u = userByName(get('assignee'));
          if (!u) throw bad(`Unknown assignee "${get('assignee')}"`);
          body.assigneeId = u.id;
        }
        if (get('labels')) body.labels = get('labels').split(';').map(s => s.trim()).filter(Boolean);
        if (get('storyPoints')) {
          const n = Number(get('storyPoints'));
          if (!Number.isFinite(n)) throw bad('storyPoints must be a number');
          body.storyPoints = n;
        }
        if (get('parent')) body.parentId = get('parent');
        if (get('epic')) body.epicId = get('epic');
        if (get('sprint')) body.sprintId = get('sprint');
        if (get('dueDate')) body.dueDate = get('dueDate');
        const issue = createIssue(project, user, body);
        created++; createdKeys.push(issue.key);
      } catch (e) {
        if (e instanceof HttpError) errors.push({ line, message: e.message });
        else throw e;
      }
    }
    return { created, createdKeys, errors };
  }

  // ---------- body / response ----------
  async function readBody(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) { size += c.length; if (size > 10 * 1024 * 1024) throw new HttpError(413, 'payload_too_large', 'Body too large'); chunks.push(c); }
    return Buffer.concat(chunks).toString('utf8');
  }
  function send(res, status, body, headers = {}) {
    if (status === 204 || body === undefined) { res.writeHead(status, headers); res.end(); return; }
    const data = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data), ...headers });
    res.end(data);
  }

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }).replace(/\./g, '\\.') + '$');
    routes.push({ method, re, keys, handler, auth: opts.auth !== false, raw: !!opts.raw });
  };

  // Auth
  route('POST', '/api/auth/register', ({ body }) => {
    const { username, password, displayName } = body || {};
    if (!isStr(username) || !/^[A-Za-z0-9_.-]{2,40}$/.test(username)) throw bad('username must be 2-40 chars of letters, digits, _ . -');
    if (!isStr(password) || password.length < 8) throw bad('password must be at least 8 characters');
    if (displayName !== undefined && displayName !== null && !isStr(displayName)) throw bad('displayName must be a string');
    if (userByName(username)) throw conflict('Username already taken');
    const { salt, hash } = hashPassword(password);
    const u = { id: newId(), username, displayName: (displayName && displayName.trim()) || username, salt, hash, createdAt: nowIso() };
    db.users.push(u);
    return [201, { user: publicUser(u) }];
  }, { auth: false });

  route('POST', '/api/auth/login', ({ body }) => {
    const { username, password } = body || {};
    if (!isStr(username) || !isStr(password)) throw bad('username and password required');
    const k = username.toLowerCase();
    const t = now().getTime();
    const fails = (loginFailures.get(k) || []).filter(x => t - x < LOGIN_WINDOW_MS);
    loginFailures.set(k, fails);
    if (fails.length >= LOGIN_MAX_FAILS) throw new HttpError(429, 'rate_limited', 'Too many failed login attempts');
    const u = userByName(username);
    if (!u || !verifyPassword(password, u.salt, u.hash)) {
      fails.push(t);
      throw new HttpError(401, 'invalid_credentials', 'Invalid username or password');
    }
    loginFailures.delete(k);
    const token = newToken();
    db.sessions.push({ id: newId(), tokenHash: sha256(token), userId: u.id, createdAt: nowIso() });
    return [200, { token, user: publicUser(u) }];
  }, { auth: false });

  route('POST', '/api/auth/logout', ({ auth }) => {
    if (auth.session) db.sessions = db.sessions.filter(s => s !== auth.session);
    return [204];
  });
  route('GET', '/api/auth/me', ({ user }) => [200, { user: publicUser(user) }]);
  route('PATCH', '/api/auth/me', ({ user, body }) => {
    body = body || {};
    const { displayName, password, currentPassword } = body;
    if (password !== undefined) {
      if (!isStr(password) || password.length < 8) throw bad('password must be at least 8 characters');
      if (!isStr(currentPassword)) throw bad('currentPassword required');
    }
    if (currentPassword !== undefined && (!isStr(currentPassword) || !verifyPassword(currentPassword, user.salt, user.hash))) {
      throw forbidden('currentPassword is incorrect');
    }
    if (displayName !== undefined) {
      if (!isNonEmptyStr(displayName)) throw bad('displayName must be a non-empty string');
      user.displayName = displayName.trim();
    }
    if (password !== undefined) Object.assign(user, hashPassword(password));
    return [200, { user: publicUser(user) }];
  });

  // API tokens
  const userWorkspaces = userId => db.workspaces.filter(w => wsMember(w, userId));
  route('POST', '/api/tokens', ({ user, body }) => {
    const name = body?.name;
    if (!isNonEmptyStr(name)) throw bad('name required');
    const token = newToken('pm_');
    const t = { id: newId(), userId: user.id, name: name.trim(), tokenHash: sha256(token), createdAt: nowIso(), lastUsedAt: null };
    db.apiTokens.push(t);
    for (const w of userWorkspaces(user.id)) audit(w.id, user.id, 'token.created', { tokenId: t.id, name: t.name });
    return [201, { id: t.id, name: t.name, token, createdAt: t.createdAt }];
  });
  route('GET', '/api/tokens', ({ user }) => [200, db.apiTokens.filter(t => t.userId === user.id).map(t => ({ id: t.id, name: t.name, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt }))]);
  route('DELETE', '/api/tokens/:id', ({ user, params }) => {
    const t = db.apiTokens.find(x => x.id === params.id && x.userId === user.id);
    if (!t) throw notFound('Token');
    db.apiTokens = db.apiTokens.filter(x => x !== t);
    for (const w of userWorkspaces(user.id)) audit(w.id, user.id, 'token.deleted', { tokenId: t.id, name: t.name });
    return [204];
  });

  // Users (lookup for UI)
  route('GET', '/api/users/:id', ({ params }) => {
    const u = userById(params.id) || userByName(params.id);
    if (!u) throw notFound('User');
    return [200, publicUser(u)];
  });

  // Workspaces
  route('POST', '/api/workspaces', ({ user, body }) => {
    const { name, key } = body || {};
    if (!isNonEmptyStr(name)) throw bad('name required');
    if (!isStr(key) || !/^[A-Z]{2,10}$/.test(key)) throw bad('key must be 2-10 uppercase letters');
    if (db.workspaces.some(w => w.key === key)) throw conflict('Workspace key already in use');
    const ws = { id: newId(), name: name.trim(), key, members: [{ userId: user.id, role: 'admin' }], createdAt: nowIso() };
    db.workspaces.push(ws);
    audit(ws.id, user.id, 'workspace.created', { name: ws.name, key });
    return [201, wsView(ws, user.id)];
  });
  route('GET', '/api/workspaces', ({ user }) => [200, userWorkspaces(user.id).map(w => wsView(w, user.id))]);
  route('GET', '/api/workspaces/:id', ({ user, params }) => {
    const { ws } = getWorkspace(params.id, user);
    return [200, { ...wsView(ws, user.id), members: ws.members.map(wsMemberView) }];
  });
  route('PATCH', '/api/workspaces/:id', ({ user, params, body }) => {
    const { ws, role } = getWorkspace(params.id, user);
    if (role !== 'admin') throw forbidden('Admin only');
    if (body?.name !== undefined) { if (!isNonEmptyStr(body.name)) throw bad('name invalid'); ws.name = body.name.trim(); }
    return [200, wsView(ws, user.id)];
  });
  route('GET', '/api/workspaces/:id/members', ({ user, params }) => {
    const { ws } = getWorkspace(params.id, user);
    return [200, ws.members.map(wsMemberView)];
  });
  route('POST', '/api/workspaces/:id/members', ({ user, params, body }) => {
    const { ws, role } = getWorkspace(params.id, user);
    if (role !== 'admin') throw forbidden('Admin only');
    const { username, role: newRole = 'member' } = body || {};
    if (!WS_ROLES.includes(newRole)) throw bad('Invalid role');
    const u = userByName(username) || (isStr(body?.userId) && userById(body.userId));
    if (!isStr(username) && !body?.userId) throw bad('username required');
    if (!u) throw notFound('User');
    if (wsMember(ws, u.id)) throw conflict('User is already a member');
    const m = { userId: u.id, role: newRole };
    ws.members.push(m);
    audit(ws.id, user.id, 'member.added', { userId: u.id, username: u.username, role: newRole });
    return [201, wsMemberView(m)];
  });
  const findWsMemberParam = (ws, p) => {
    const u = userById(p) || userByName(p);
    const m = u && wsMember(ws, u.id);
    if (!m) throw notFound('Member');
    return m;
  };
  route('PATCH', '/api/workspaces/:id/members/:userId', ({ user, params, body }) => {
    const { ws, role } = getWorkspace(params.id, user);
    if (role !== 'admin') throw forbidden('Admin only');
    const m = findWsMemberParam(ws, params.userId);
    const newRole = body?.role;
    if (!WS_ROLES.includes(newRole)) throw bad('Invalid role');
    if (m.role === 'admin' && newRole !== 'admin' && ws.members.filter(x => x.role === 'admin').length === 1) throw bad('Cannot demote the last admin', 'last_admin');
    const old = m.role;
    m.role = newRole;
    if (old !== newRole) audit(ws.id, user.id, 'member.role_changed', { userId: m.userId, from: old, to: newRole });
    return [200, wsMemberView(m)];
  });
  route('DELETE', '/api/workspaces/:id/members/:userId', ({ user, params }) => {
    const { ws, role } = getWorkspace(params.id, user);
    if (role !== 'admin') throw forbidden('Admin only');
    const m = findWsMemberParam(ws, params.userId);
    if (m.role === 'admin' && ws.members.filter(x => x.role === 'admin').length === 1) throw bad('Cannot remove the last admin', 'last_admin');
    ws.members = ws.members.filter(x => x !== m);
    for (const p of db.projects.filter(p => p.workspaceId === ws.id)) p.members = p.members.filter(x => x.userId !== m.userId);
    audit(ws.id, user.id, 'member.removed', { userId: m.userId });
    return [204];
  });
  route('GET', '/api/workspaces/:id/audit', ({ user, params }) => {
    const { ws, role } = getWorkspace(params.id, user);
    if (role !== 'admin') throw forbidden('Admin only');
    return [200, db.audit.filter(a => a.workspaceId === ws.id).slice().reverse()];
  });

  // Projects
  route('POST', '/api/workspaces/:id/projects', ({ user, params, body }) => {
    const { ws, role } = getWorkspace(params.id, user);
    if (role === 'guest') throw forbidden('Guests cannot create projects');
    const { name, key, description } = body || {};
    if (!isNonEmptyStr(name)) throw bad('name required');
    if (!isStr(key) || !/^[A-Z][A-Z0-9]{1,9}$/.test(key)) throw bad('key must be 2-10 uppercase letters/digits');
    if (db.projects.some(p => p.workspaceId === ws.id && p.key === key)) throw conflict('Project key already in use');
    const p = {
      id: newId(), workspaceId: ws.id, name: name.trim(), key, description: isStr(description) ? description : '',
      private: !!body.private, members: [{ userId: user.id, role: 'lead' }], workflow: defaultWorkflow(), issueSeq: 0, createdAt: nowIso()
    };
    db.projects.push(p);
    audit(ws.id, user.id, 'project.created', { projectId: p.id, key });
    return [201, projectView(p, user.id)];
  });
  route('GET', '/api/workspaces/:id/projects', ({ user, params }) => {
    const { ws } = getWorkspace(params.id, user);
    return [200, db.projects.filter(p => p.workspaceId === ws.id && canSeeProject(p, user.id)).map(p => projectView(p, user.id))];
  });
  route('GET', '/api/projects', ({ user }) => [200, db.projects.filter(p => canSeeProject(p, user.id)).map(p => projectView(p, user.id))]);
  route('GET', '/api/projects/:id', ({ user, params }) => [200, projectView(getProject(params.id, user).project, user.id)]);
  route('PATCH', '/api/projects/:id', ({ user, params, body }) => {
    const { project } = getProject(params.id, user, 'lead');
    if (body?.name !== undefined) { if (!isNonEmptyStr(body.name)) throw bad('name invalid'); project.name = body.name.trim(); }
    if (body?.description !== undefined) { if (!isStr(body.description)) throw bad('description invalid'); project.description = body.description; }
    if (body?.private !== undefined) project.private = !!body.private;
    return [200, projectView(project, user.id)];
  });
  route('GET', '/api/projects/:id/members', ({ user, params }) => [200, getProject(params.id, user).project.members.map(projMemberView)]);
  route('POST', '/api/projects/:id/members', ({ user, params, body }) => {
    const { project } = getProject(params.id, user, 'lead');
    const { username, role = 'developer' } = body || {};
    if (!PROJECT_ROLES.includes(role)) throw bad('Invalid role');
    if (!isStr(username) && !isStr(body?.userId)) throw bad('username required');
    const u = userByName(username) || userById(body?.userId);
    if (!u) throw notFound('User');
    const ws = db.workspaces.find(w => w.id === project.workspaceId);
    if (!wsMember(ws, u.id)) { ws.members.push({ userId: u.id, role: 'guest' }); audit(ws.id, user.id, 'member.added', { userId: u.id, role: 'guest', via: 'project' }); }
    let m = project.members.find(x => x.userId === u.id);
    if (m) { if (m.role === role) throw conflict('Already a project member'); m.role = role; }
    else { m = { userId: u.id, role }; project.members.push(m); }
    audit(ws.id, user.id, 'project.member.added', { projectId: project.id, userId: u.id, role });
    return [201, projMemberView(m)];
  });
  const findProjMember = (project, p) => {
    const u = userById(p) || userByName(p);
    const m = u && project.members.find(x => x.userId === u.id);
    if (!m) throw notFound('Member');
    return m;
  };
  route('PATCH', '/api/projects/:id/members/:userId', ({ user, params, body }) => {
    const { project } = getProject(params.id, user, 'lead');
    const m = findProjMember(project, params.userId);
    if (!PROJECT_ROLES.includes(body?.role)) throw bad('Invalid role');
    const old = m.role; m.role = body.role;
    audit(project.workspaceId, user.id, 'project.member.role_changed', { projectId: project.id, userId: m.userId, from: old, to: m.role });
    return [200, projMemberView(m)];
  });
  route('DELETE', '/api/projects/:id/members/:userId', ({ user, params }) => {
    const { project } = getProject(params.id, user, 'lead');
    const m = findProjMember(project, params.userId);
    project.members = project.members.filter(x => x !== m);
    audit(project.workspaceId, user.id, 'project.member.removed', { projectId: project.id, userId: m.userId });
    return [204];
  });

  // Workflow
  route('GET', '/api/projects/:id/workflow', ({ user, params }) => [200, getProject(params.id, user).project.workflow]);
  route('PUT', '/api/projects/:id/workflow', ({ user, params, body }) => {
    const { project } = getProject(params.id, user, 'lead');
    const { statuses, transitions, remap = {} } = body || {};
    if (!Array.isArray(statuses) || statuses.length === 0) throw bad('statuses must be a non-empty array');
    const names = new Set();
    const clean = statuses.map(s => {
      if (!s || !isNonEmptyStr(s.name)) throw bad('Each status needs a name');
      if (!CATEGORIES.includes(s.category)) throw bad(`Invalid category for status "${s.name}"`);
      const name = s.name.trim();
      if (names.has(name)) throw bad(`Duplicate status "${name}"`);
      names.add(name);
      return { name, category: s.category };
    });
    let trans;
    if (transitions === undefined || transitions === null) trans = allTransitions(clean);
    else {
      if (!Array.isArray(transitions)) throw bad('transitions must be an array');
      trans = transitions.map(t => {
        if (!Array.isArray(t) || t.length !== 2) throw bad('Each transition must be [from, to]');
        const [f, to] = t;
        if (!(f === '*' || names.has(f)) || !(to === '*' || names.has(to))) throw bad(`Transition references unknown status`);
        return [f, to];
      });
    }
    if (remap === null || typeof remap !== 'object' || Array.isArray(remap)) throw bad('remap must be an object');
    for (const [o, n] of Object.entries(remap)) if (!names.has(n)) throw bad(`remap target "${n}" for "${o}" is not a status`);
    const issues = db.issues.filter(i => i.projectId === project.id);
    const moves = [];
    for (const i of issues) {
      if (names.has(i.status)) continue;
      const target = remap[i.status];
      if (!target) throw bad(`Status "${i.status}" is in use; provide a remap`, 'status_in_use');
      moves.push([i, target]);
    }
    const before = project.workflow;
    const at = nowIso();
    project.workflow = { statuses: clean, transitions: trans };
    for (const [i, target] of moves) {
      const wasCompleted = !!i.resolvedAt;
      record(i, 'status', i.status, target, user.id, at);
      i.status = target;
      const cat = categoryOf(project, target);
      if (cat === 'completed' && !wasCompleted) i.resolvedAt = at;
      else if (cat !== 'completed') i.resolvedAt = null;
      if (cat === 'started' && !i.startedAt) i.startedAt = at;
      i.updatedAt = at;
    }
    audit(project.workspaceId, user.id, 'workflow.updated', { projectId: project.id, from: before.statuses.map(s => s.name), to: clean.map(s => s.name), remapped: moves.length });
    return [200, project.workflow];
  });

  // Issues
  route('POST', '/api/projects/:id/issues', ({ user, params, body }) => {
    const { project } = getProject(params.id, user, 'developer');
    return [201, issueView(createIssue(project, user, body))];
  });
  route('GET', '/api/projects/:id/issues', ({ user, params, query }) => {
    const { project } = getProject(params.id, user);
    let list = db.issues.filter(i => i.projectId === project.id);
    for (const f of ['status', 'type', 'priority', 'assigneeId', 'epicId', 'parentId']) if (query.has(f)) list = list.filter(i => (i[f] ?? '') === query.get(f));
    if (query.has('sprintId')) { const s = query.get('sprintId'); list = list.filter(i => (s === 'none' || s === 'backlog' || s === '') ? !i.sprintId : i.sprintId === s); }
    return [200, list.map(issueView)];
  });
  route('GET', '/api/issues/:key', ({ user, params }) => [200, issueView(getIssue(params.key, user).issue)]);
  route('PATCH', '/api/issues/:key', ({ user, params, body }) => {
    const { issue, project } = getIssue(params.key, user, 'developer');
    return [200, issueView(updateIssue(issue, project, user, body))];
  });
  route('DELETE', '/api/issues/:key', ({ user, params }) => {
    const { issue, project } = getIssue(params.key, user, 'developer');
    deleteIssue(issue, project, user);
    return [204];
  });
  route('GET', '/api/issues/:key/history', ({ user, params }) => {
    const { issue } = getIssue(params.key, user);
    return [200, db.history.filter(h => h.issueId === issue.id).map(h => ({ field: h.field, from: h.from, to: h.to, actorId: h.actorId, at: h.at }))];
  });

  // Links
  route('GET', '/api/issues/:key/links', ({ user, params }) => [200, issueLinks(getIssue(params.key, user).issue)]);
  route('POST', '/api/issues/:key/links', ({ user, params, body }) => {
    const { issue, project } = getIssue(params.key, user, 'developer');
    const { type, target } = body || {};
    if (!LINK_TYPES.includes(type)) throw bad('Invalid link type');
    if (!isNonEmptyStr(target)) throw bad('target required');
    const t = findIssue(target);
    if (!t) throw notFound('Target issue');
    if (!canSeeProject(projectOf(t), user.id)) throw forbidden('No access to target issue');
    if (t.id === issue.id) throw bad('Cannot link an issue to itself');
    const dup = db.links.find(l => l.type === type && ((l.sourceId === issue.id && l.targetId === t.id) || (type === 'relates' && l.sourceId === t.id && l.targetId === issue.id)));
    if (dup) throw conflict('Link already exists');
    const l = { id: newId(), type, sourceId: issue.id, targetId: t.id, createdAt: nowIso(), actorId: user.id };
    db.links.push(l);
    const at = nowIso();
    record(issue, 'links', null, `${type} ${t.key}`, user.id, at);
    record(t, 'links', null, `${LINK_INVERSE[type]} ${issue.key}`, user.id, at);
    issue.updatedAt = at;
    return [201, { id: l.id, type, source: issue.key, target: t.key, createdAt: l.createdAt }];
  });
  route('DELETE', '/api/issues/:key/links/:linkId', ({ user, params }) => {
    const { issue } = getIssue(params.key, user, 'developer');
    const l = db.links.find(x => x.id === params.linkId && (x.sourceId === issue.id || x.targetId === issue.id));
    if (!l) throw notFound('Link');
    db.links = db.links.filter(x => x !== l);
    return [204];
  });

  // Watchers
  route('POST', '/api/issues/:key/watch', ({ user, params }) => {
    const { issue } = getIssue(params.key, user);
    if (!issue.watchers.includes(user.id)) issue.watchers.push(user.id);
    return [200, { watching: true, watchers: [...issue.watchers] }];
  });
  route('DELETE', '/api/issues/:key/watch', ({ user, params }) => {
    const { issue } = getIssue(params.key, user);
    issue.watchers = issue.watchers.filter(w => w !== user.id);
    return [200, { watching: false, watchers: [...issue.watchers] }];
  });

  // Comments
  const commentView = c => ({ id: c.id, issueId: c.issueId, issueKey: findIssue(c.issueId)?.key, authorId: c.authorId, body: c.body, createdAt: c.createdAt, updatedAt: c.updatedAt, edited: !!c.edited });
  function mentionsIn(text, project) {
    const out = new Set();
    for (const m of text.matchAll(/(^|[^A-Za-z0-9_.-])@([A-Za-z0-9_.-]*[A-Za-z0-9_])/g)) {
      const u = userByName(m[2]);
      if (u && canSeeProject(project, u.id)) out.add(u.id);
    }
    return out;
  }
  route('GET', '/api/issues/:key/comments', ({ user, params }) => {
    const { issue } = getIssue(params.key, user);
    return [200, db.comments.filter(c => c.issueId === issue.id).map(commentView)];
  });
  route('POST', '/api/issues/:key/comments', ({ user, params, body }) => {
    const { issue, project } = getIssue(params.key, user);
    if (!isNonEmptyStr(body?.body)) throw bad('body required');
    if (body.body.length > 20000) throw bad('body too long');
    const at = nowIso();
    const c = { id: newId(), issueId: issue.id, authorId: user.id, body: body.body, createdAt: at, updatedAt: at, edited: false };
    db.comments.push(c);
    const mentioned = mentionsIn(c.body, project);
    for (const uid of mentioned) notify(uid, 'mention', issue, user.id, { commentId: c.id });
    notifyWatchers(issue, 'comment', user.id, mentioned, { commentId: c.id });
    emit(project, 'comment.created', { issue: issueView(issue), comment: commentView(c), actorId: user.id, at });
    return [201, commentView(c)];
  });
  function getComment(id, user) {
    const c = db.comments.find(x => x.id === id);
    if (!c) throw notFound('Comment');
    const { issue, project, role } = getIssue(c.issueId, user);
    return { c, issue, project, role };
  }
  const patchComment = ({ user, params, body }) => {
    const { c, issue, project } = getComment(params.commentId || params.id, user);
    if (c.authorId !== user.id) throw forbidden('Only the author can edit');
    if (!isNonEmptyStr(body?.body)) throw bad('body required');
    const before = mentionsIn(c.body, project);
    c.body = body.body; c.updatedAt = nowIso(); c.edited = true;
    for (const uid of mentionsIn(c.body, project)) if (!before.has(uid)) notify(uid, 'mention', issue, user.id, { commentId: c.id });
    return [200, commentView(c)];
  };
  const deleteComment = ({ user, params }) => {
    const { c, role } = getComment(params.commentId || params.id, user);
    if (c.authorId !== user.id && role !== 'lead') throw forbidden('Only the author can delete');
    db.comments = db.comments.filter(x => x !== c);
    return [204];
  };
  route('PATCH', '/api/comments/:id', patchComment);
  route('DELETE', '/api/comments/:id', deleteComment);
  route('PATCH', '/api/issues/:key/comments/:commentId', patchComment);
  route('DELETE', '/api/issues/:key/comments/:commentId', deleteComment);

  // Notifications
  route('GET', '/api/notifications', ({ user, query }) => {
    let list = db.notifications.filter(n => n.userId === user.id);
    const unread = query.get('unread');
    if (unread === 'true' || unread === '1') list = list.filter(n => !n.read);
    list = list.map((n, k) => [n, k]).sort((a, b) => (b[0].at < a[0].at ? -1 : b[0].at > a[0].at ? 1 : b[1] - a[1])).map(x => x[0]);
    return [200, list.map(({ userId, ...n }) => n)];
  });
  route('POST', '/api/notifications/read', ({ user, body }) => {
    const mine = db.notifications.filter(n => n.userId === user.id);
    let updated = 0;
    if (body?.all === true) { for (const n of mine) if (!n.read) { n.read = true; updated++; } }
    else if (Array.isArray(body?.ids)) {
      const ids = new Set(body.ids);
      for (const n of mine) if (ids.has(n.id) && !n.read) { n.read = true; updated++; }
    } else throw bad('Provide ids or all: true');
    return [200, { updated }];
  });

  // Sprints
  route('POST', '/api/projects/:id/sprints', ({ user, params, body }) => {
    const { project } = getProject(params.id, user, 'developer');
    const { name, startDate, endDate, goal } = body || {};
    if (!isNonEmptyStr(name)) throw bad('name required');
    const sd = checkDue(startDate), ed = checkDue(endDate);
    if (sd && ed && ed < sd) throw bad('endDate must be on/after startDate');
    const s = { id: newId(), projectId: project.id, name: name.trim(), goal: isStr(goal) ? goal : '', state: 'planned', startDate: sd, endDate: ed, startedAt: null, completedAt: null, createdAt: nowIso() };
    db.sprints.push(s);
    return [201, sprintView(s)];
  });
  route('GET', '/api/projects/:id/sprints', ({ user, params }) => {
    const { project } = getProject(params.id, user);
    return [200, db.sprints.filter(s => s.projectId === project.id).map(sprintView)];
  });
  function getSprint(id, user, minRole = 'viewer') {
    const s = db.sprints.find(x => x.id === id);
    if (!s) throw notFound('Sprint');
    const { project } = getProject(s.projectId, user, minRole);
    return { sprint: s, project };
  }
  route('GET', '/api/sprints/:id', ({ user, params }) => [200, sprintView(getSprint(params.id, user).sprint)]);
  route('PATCH', '/api/sprints/:id', ({ user, params, body }) => {
    const { sprint } = getSprint(params.id, user, 'developer');
    if (body?.name !== undefined) { if (!isNonEmptyStr(body.name)) throw bad('name invalid'); sprint.name = body.name.trim(); }
    if (body?.goal !== undefined) sprint.goal = String(body.goal ?? '');
    if (body?.startDate !== undefined) sprint.startDate = checkDue(body.startDate);
    if (body?.endDate !== undefined) sprint.endDate = checkDue(body.endDate);
    return [200, sprintView(sprint)];
  });
  route('DELETE', '/api/sprints/:id', ({ user, params }) => {
    const { sprint } = getSprint(params.id, user, 'lead');
    if (sprint.state === 'active') throw conflict('Cannot delete an active sprint');
    const at = nowIso();
    for (const i of db.issues) if (i.sprintId === sprint.id && sprint.state !== 'completed') { record(i, 'sprintId', i.sprintId, null, user.id, at); i.sprintId = null; }
    db.sprints = db.sprints.filter(s => s !== sprint);
    return [204];
  });
  route('POST', '/api/sprints/:id/issues', ({ user, params, body }) => {
    const { sprint, project } = getSprint(params.id, user, 'developer');
    if (sprint.state === 'completed') throw bad('Sprint is completed');
    const keys = body?.issueKeys || body?.keys || body?.issues;
    if (!Array.isArray(keys)) throw bad('issueKeys required');
    const issues = keys.map(k => { const i = findIssue(k); if (!i || i.projectId !== project.id) throw bad(`Issue ${k} not in project`); return i; });
    for (const i of issues) updateIssue(i, project, user, { sprintId: sprint.id });
    return [200, sprintView(sprint)];
  });
  route('POST', '/api/sprints/:id/start', ({ user, params, body }) => {
    const { sprint, project } = getSprint(params.id, user, 'developer');
    if (sprint.state !== 'planned') throw conflict('Sprint is not planned');
    if (db.sprints.some(s => s.projectId === project.id && s.state === 'active')) throw conflict('Another sprint is already active');
    const at = nowIso();
    if (body?.startDate !== undefined) sprint.startDate = checkDue(body.startDate);
    if (body?.endDate !== undefined) sprint.endDate = checkDue(body.endDate);
    if (!sprint.startDate) sprint.startDate = at.slice(0, 10);
    sprint.state = 'active'; sprint.startedAt = at;
    sprint.committedPoints = db.issues.filter(i => i.sprintId === sprint.id).reduce((s, i) => s + (typeof i.storyPoints === 'number' ? i.storyPoints : 0), 0);
    sprint.committedIssues = db.issues.filter(i => i.sprintId === sprint.id).length;
    return [200, sprintView(sprint)];
  });
  route('POST', '/api/sprints/:id/complete', ({ user, params, body }) => {
    const { sprint, project } = getSprint(params.id, user, 'developer');
    if (sprint.state !== 'active') throw conflict('Sprint is not active');
    const dest = body?.carryOverTo ?? 'backlog';
    let destId = null;
    if (dest !== 'backlog' && dest !== null) {
      const d = db.sprints.find(s => s.id === dest && s.projectId === project.id);
      if (!d) throw bad('carryOverTo sprint not found');
      if (d.state === 'completed' || d.id === sprint.id) throw bad('carryOverTo sprint must not be completed');
      destId = d.id;
    }
    const at = nowIso();
    const inSprint = db.issues.filter(i => i.sprintId === sprint.id);
    const done = inSprint.filter(isResolved);
    const open = inSprint.filter(i => !isResolved(i));
    sprint.completedPoints = done.reduce((s, i) => s + (typeof i.storyPoints === 'number' ? i.storyPoints : 0), 0);
    sprint.completedIssues = done.length;
    sprint.carriedOver = open.length;
    sprint.carriedOverKeys = open.map(i => i.key);
    sprint.state = 'completed'; sprint.completedAt = at;
    for (const i of open) { record(i, 'sprintId', i.sprintId, destId, user.id, at); i.sprintId = destId; i.updatedAt = at; }
    return [200, { ...sprintView(sprint), carriedOver: open.map(i => i.key), carriedOverTo: destId || 'backlog' }];
  });
  route('GET', '/api/sprints/:id/report', ({ user, params }) => {
    const { sprint, project } = getSprint(params.id, user);
    return [200, sprintReport(sprint, project)];
  });
  route('GET', '/api/projects/:id/stats', ({ user, params }) => [200, projectStats(getProject(params.id, user).project)]);

  // Search
  route('GET', '/api/search', ({ user, query }) => {
    const q = query.get('q') || '';
    const sort = query.get('sort') || 'updated';
    if (!['updated', 'created', 'priority'].includes(sort)) throw bad('Invalid sort');
    let projects = db.projects.filter(p => canSeeProject(p, user.id));
    if (query.get('project')) {
      const { project } = getProject(query.get('project'), user);
      projects = [project];
    }
    let pred;
    try {
      pred = compileQuery(q, {
        meId: user.id, userByName, isResolved,
        activeSprintId: pid => db.sprints.find(s => s.projectId === pid && s.state === 'active')?.id || null
      });
    } catch (e) {
      if (e instanceof QueryError) throw bad(e.message, 'invalid_query');
      throw e;
    }
    const pids = new Set(projects.map(p => p.id));
    const list = db.issues.map((i, n) => [i, n]).filter(([i]) => pids.has(i.projectId) && pred(i));
    const byDesc = f => (a, b) => (a[0][f] < b[0][f] ? 1 : a[0][f] > b[0][f] ? -1 : b[1] - a[1]);
    if (sort === 'priority') list.sort((a, b) => (PRIORITY_RANK[a[0].priority] - PRIORITY_RANK[b[0].priority]) || byDesc('updatedAt')(a, b));
    else list.sort(byDesc(sort === 'created' ? 'createdAt' : 'updatedAt'));
    return [200, list.map(([i]) => issueView(i))];
  });

  // CSV
  route('GET', '/api/projects/:id/export.csv', ({ user, params }) => {
    const { project } = getProject(params.id, user);
    return [200, exportCsv(project), { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${project.key}.csv"` }];
  });
  route('POST', '/api/projects/:id/import.csv', ({ user, params, rawBody, req }) => {
    const { project } = getProject(params.id, user, 'developer');
    let text = rawBody;
    if (/json/i.test(req.headers['content-type'] || '')) {
      try { const j = JSON.parse(rawBody); if (isStr(j?.csv)) text = j.csv; } catch { /* treat as raw */ }
    }
    if (!isStr(text) || !text.trim()) throw bad('CSV body required');
    return [200, importCsv(project, user, text)];
  }, { raw: true });

  // Webhooks
  const webhookView = h => ({ id: h.id, projectId: h.projectId, url: h.url, events: [...h.events], createdAt: h.createdAt });
  route('POST', '/api/projects/:id/webhooks', ({ user, params, body }) => {
    const { project } = getProject(params.id, user, 'lead');
    const { url, events, secret } = body || {};
    let u;
    try { u = new URL(url); } catch { throw bad('url must be a valid URL'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw bad('url must be http(s)');
    if (!Array.isArray(events) || !events.length || !events.every(e => WEBHOOK_EVENTS.includes(e))) throw bad('events invalid');
    if (secret !== undefined && secret !== null && !isStr(secret)) throw bad('secret must be a string');
    const h = { id: newId(), projectId: project.id, url, events: [...new Set(events)], secret: secret || '', createdAt: nowIso(), createdBy: user.id };
    db.webhooks.push(h);
    audit(project.workspaceId, user.id, 'webhook.created', { webhookId: h.id, projectId: project.id, url });
    return [201, webhookView(h)];
  });
  route('GET', '/api/projects/:id/webhooks', ({ user, params }) => {
    const { project } = getProject(params.id, user, 'lead');
    return [200, db.webhooks.filter(h => h.projectId === project.id).map(webhookView)];
  });
  function getWebhook(id, user) {
    const h = db.webhooks.find(x => x.id === id);
    if (!h) throw notFound('Webhook');
    const { project } = getProject(h.projectId, user, 'lead');
    return { h, project };
  }
  route('GET', '/api/webhooks/:id', ({ user, params }) => [200, webhookView(getWebhook(params.id, user).h)]);
  route('DELETE', '/api/webhooks/:id', ({ user, params }) => {
    const { h, project } = getWebhook(params.id, user);
    db.webhooks = db.webhooks.filter(x => x !== h);
    audit(project.workspaceId, user.id, 'webhook.deleted', { webhookId: h.id, projectId: project.id, url: h.url });
    return [204];
  });
  route('GET', '/api/webhooks/:id/deliveries', ({ user, params }) => {
    const { h } = getWebhook(params.id, user);
    return [200, db.deliveries.filter(d => d.webhookId === h.id).map(d => ({ id: d.id, event: d.event, status: d.status, attempts: d.attempts, lastError: d.lastError, at: d.at, deliveredAt: d.deliveredAt }))];
  });

  // ---------- static ----------
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
  function serveStatic(res, rel) {
    const file = path.normalize(path.join(STATIC_DIR, rel));
    if (!file.startsWith(STATIC_DIR + path.sep)) { send(res, 404, { error: 'not_found', message: 'Not found' }); return; }
    fs.readFile(file, (err, data) => {
      if (err) { send(res, 404, { error: 'not_found', message: 'Not found' }); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-length': data.length });
      res.end(data);
    });
  }

  // ---------- dispatcher ----------
  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    if (req.method === 'GET' && !pathname.startsWith('/api')) {
      if (pathname === '/' || pathname === '/index.html') return serveStatic(res, 'index.html');
      if (pathname.startsWith('/static/')) return serveStatic(res, decodeURIComponent(pathname.slice('/static/'.length)));
      if (pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      return serveStatic(res, 'index.html');
    }
    let matched = null, methodMismatch = false;
    for (const r of routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      if (r.method !== req.method) { methodMismatch = true; continue; }
      matched = { r, params: Object.fromEntries(r.keys.map((k, n) => [k, decodeURIComponent(m[n + 1])])) };
      break;
    }
    if (!matched) {
      if (methodMismatch) throw new HttpError(405, 'method_not_allowed', 'Method not allowed');
      throw notFound('Route');
    }
    let auth = null;
    if (matched.r.auth) {
      auth = authenticate(req);
      if (!auth) throw new HttpError(401, 'unauthorized', 'Authentication required');
    }
    const rawBody = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : '';
    let body = {};
    if (!matched.r.raw && rawBody.trim()) {
      try { body = JSON.parse(rawBody); } catch { throw bad('Invalid JSON body', 'invalid_json'); }
    }
    const out = await matched.r.handler({ req, user: auth?.user, auth, params: matched.params, body, rawBody, query: url.searchParams });
    const [status, payload, headers] = out;
    if (req.method !== 'GET' || auth?.apiToken) save();
    if (typeof payload === 'string') {
      res.writeHead(status, { 'content-length': Buffer.byteLength(payload), ...headers });
      res.end(payload);
    } else send(res, status, payload, headers);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      if (res.headersSent) { res.end(); return; }
      if (err instanceof HttpError) send(res, err.status, { error: err.code, message: err.message });
      else { console.error(err); send(res, 500, { error: 'internal_error', message: 'Internal server error' }); }
    });
  });
  server.flushDeliveries = () => Promise.all([...pendingDeliveries]);
  return server;
}
