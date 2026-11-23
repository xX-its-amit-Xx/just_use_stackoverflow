// pm-s4 — lightweight project management server (Node.js stdlib only).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseCSV, toCSV } from './csv.js';
import { compile, QueryError, TYPES, PRIORITIES } from './search.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');

const WS_ROLES = ['admin', 'member', 'guest'];
const PROJECT_ROLES = ['lead', 'developer', 'viewer'];
const ROLE_RANK = { viewer: 1, developer: 2, lead: 3 };
const CATEGORIES = ['backlog', 'unstarted', 'started', 'completed'];
const LINK_TYPES = ['blocks', 'relates', 'duplicates'];
const INVERSE_LINK = { blocks: 'blocked_by', relates: 'relates', duplicates: 'duplicated_by' };
const WEBHOOK_EVENTS = ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'];
const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const ISSUE_FIELDS = ['type', 'title', 'description', 'status', 'priority', 'assigneeId', 'labels', 'storyPoints', 'parentId', 'epicId', 'sprintId', 'dueDate'];

class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}
const badRequest = (msg, code = 'validation_error') => new HttpError(400, code, msg);
const notFound = (msg = 'not found') => new HttpError(404, 'not_found', msg);
const forbidden = (msg = 'forbidden') => new HttpError(403, 'forbidden', msg);
const conflict = (msg, code = 'conflict') => new HttpError(409, code, msg);

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = (prefix = '') => prefix + crypto.randomBytes(24).toString('hex');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 32).toString('hex');
  return { salt, hash };
}
function verifyPassword(password, rec) {
  const { hash } = hashPassword(password, rec.salt);
  const a = Buffer.from(hash, 'hex'); const b = Buffer.from(rec.hash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function emptyDb() {
  return {
    seq: 0, users: [], sessions: [], apiTokens: [], workspaces: [], wsMembers: [], projects: [], projMembers: [],
    issues: [], history: [], links: [], comments: [], notifications: [], sprints: [], webhooks: [], deliveries: [],
    audit: [], loginFailures: {},
  };
}

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const dayOf = d => new Date(d).toISOString().slice(0, 10);
function isValidDateOnly(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d) && d.toISOString().slice(0, 10) === s;
}
function isValidDateish(s) {
  if (typeof s !== 'string' || !s) return false;
  if (isValidDateOnly(s)) return true;
  return /^\d{4}-\d{2}-\d{2}T/.test(s) && !isNaN(new Date(s));
}
const sameValue = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function createServer({ dataFile, clock } = {}) {
  const now = () => (clock ? new Date(clock()) : new Date());
  const nowIso = () => now().toISOString();

  let db = emptyDb();
  if (dataFile && fs.existsSync(dataFile)) {
    try {
      const raw = fs.readFileSync(dataFile, 'utf8');
      if (raw.trim()) db = Object.assign(emptyDb(), JSON.parse(raw));
    } catch { db = emptyDb(); }
  }
  function save() {
    if (!dataFile) return;
    const tmp = dataFile + '.' + process.pid + '.tmp';
    fs.mkdirSync(path.dirname(path.resolve(dataFile)), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, dataFile);
  }
  const newId = () => String(++db.seq);

  // ---------- lookups ----------
  const userById = id => db.users.find(u => u.id === id);
  const userByName = name => db.users.find(u => u.username.toLowerCase() === String(name).toLowerCase());
  const publicUser = u => u && { id: u.id, username: u.username, displayName: u.displayName };
  const projectById = id => db.projects.find(p => p.id === id);
  const sprintById = id => db.sprints.find(s => s.id === id);
  const issueById = id => db.issues.find(i => i.id === id);
  const issueByRef = ref => {
    if (ref === null || ref === undefined) return undefined;
    const s = String(ref);
    return db.issues.find(i => i.id === s) || db.issues.find(i => i.key === s.toUpperCase());
  };
  const wsMember = (wsId, userId) => db.wsMembers.find(m => m.workspaceId === wsId && m.userId === userId);
  const wsRole = (wsId, userId) => wsMember(wsId, userId)?.role ?? null;

  function projectRole(project, userId) {
    const wr = wsRole(project.workspaceId, userId);
    if (!wr) return null;
    if (wr === 'admin') return 'lead';
    const pm = db.projMembers.find(m => m.projectId === project.id && m.userId === userId);
    if (pm) return pm.role;
    if (wr === 'member') return 'developer';
    return null;
  }
  const canSeeProject = (project, userId) => !!projectRole(project, userId);

  function requireWorkspace(id, user, adminOnly = false) {
    const ws = db.workspaces.find(w => w.id === id);
    if (!ws) throw notFound('workspace not found');
    const role = wsRole(ws.id, user.id);
    if (!role) throw forbidden('not a member of this workspace');
    if (adminOnly && role !== 'admin') throw forbidden('workspace admin required');
    return { ws, role };
  }
  function requireProject(id, user, minRole = 'viewer') {
    const project = projectById(id) || db.projects.find(p => p.key === String(id).toUpperCase() && canSeeProject(p, user.id));
    if (!project) throw notFound('project not found');
    const role = projectRole(project, user.id);
    if (!role) throw forbidden('no access to this project');
    if (ROLE_RANK[role] < ROLE_RANK[minRole]) throw forbidden(`project ${minRole} role required`);
    return { project, role };
  }
  function requireIssue(key, user, minRole = 'viewer') {
    const issue = issueByRef(key);
    if (!issue) throw notFound('issue not found');
    const { project, role } = requireProject(issue.projectId, user, minRole);
    return { issue, project, role };
  }

  const statusDef = (project, name) => project.workflow.statuses.find(s => s.name === name);
  const isCompletedStatus = (project, name) => statusDef(project, name)?.category === 'completed';

  // ---------- serialization ----------
  function issueLinks(issue) {
    const out = [];
    for (const l of db.links) {
      if (l.sourceId === issue.id) {
        const t = issueById(l.targetId); if (!t) continue;
        out.push({ id: l.id, type: l.type, key: t.key, issueKey: t.key, issueId: t.id, direction: 'outward' });
      } else if (l.targetId === issue.id) {
        const s = issueById(l.sourceId); if (!s) continue;
        out.push({ id: l.id, type: INVERSE_LINK[l.type], key: s.key, issueKey: s.key, issueId: s.id, direction: 'inward' });
      }
    }
    return out;
  }
  function serializeIssue(issue) {
    const { _initial, number, ...pub } = issue;
    pub.labels = [...(issue.labels || [])];
    pub.watchers = [...(issue.watchers || [])];
    pub.children = db.issues.filter(i => i.parentId === issue.id).sort((a, b) => a.number - b.number).map(i => i.key);
    pub.links = issueLinks(issue);
    pub.blockedBy = pub.links.filter(l => l.type === 'blocked_by').map(l => l.key);
    if (issue.type === 'epic') {
      const kids = db.issues.filter(i => i.epicId === issue.id);
      const project = projectById(issue.projectId);
      let done = 0, pt = 0, pd = 0;
      for (const k of kids) {
        const pts = typeof k.storyPoints === 'number' ? k.storyPoints : 0;
        pt += pts;
        if (isCompletedStatus(project, k.status)) { done++; pd += pts; }
      }
      pub.progress = { total: kids.length, done, points_total: pt, points_done: pd };
    }
    return pub;
  }
  function serializeProject(p, userId) {
    const { issueSeq, ...pub } = p;
    return { ...pub, workflow: structuredClone(p.workflow), role: userId ? projectRole(p, userId) : undefined };
  }
  const serializeSprint = s => {
    const { committedIssueIds, completedIssueIds, carriedOverIds, ...pub } = s;
    return pub;
  };

  // ---------- side effects: audit, notifications, webhooks ----------
  function audit(workspaceId, action, actorId, details = {}) {
    db.audit.push({ id: newId(), workspaceId, action, type: action, actorId, at: nowIso(), details });
  }
  function auditUserWorkspaces(userId, action, details) {
    for (const m of db.wsMembers.filter(m => m.userId === userId)) audit(m.workspaceId, action, userId, details);
  }
  function notify(userIds, type, issue, actorId, extra = {}) {
    const project = projectById(issue.projectId);
    const seen = new Set();
    for (const uid of userIds) {
      if (!uid || uid === actorId || seen.has(uid)) continue;
      seen.add(uid);
      if (!userById(uid) || !canSeeProject(project, uid)) continue;
      db.notifications.push({ id: newId(), userId: uid, type, issueKey: issue.key, issueId: issue.id, actorId, at: nowIso(), read: false, ...extra });
    }
  }
  const pendingDeliveries = new Set();
  function emitWebhook(projectId, event, payloadExtra) {
    const hooks = db.webhooks.filter(h => h.projectId === projectId && h.events.includes(event) && h.active !== false);
    for (const hook of hooks) {
      const payload = { event, ...payloadExtra, at: nowIso() };
      const body = JSON.stringify(payload);
      const delivery = { id: newId(), webhookId: hook.id, event, status: null, attempts: 0, lastError: null, createdAt: nowIso(), payload };
      db.deliveries.push(delivery);
      const p = deliver(hook, delivery, body).catch(() => {}).finally(() => pendingDeliveries.delete(p));
      pendingDeliveries.add(p);
    }
  }
  async function deliver(hook, delivery, body) {
    const sig = 'sha256=' + crypto.createHmac('sha256', hook.secret || '').update(body).digest('hex');
    for (let attempt = 1; attempt <= 3; attempt++) {
      delivery.attempts = attempt;
      try {
        const res = await fetch(hook.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-pm-signature': sig, 'x-pm-event': delivery.event, 'x-pm-delivery': delivery.id },
          body,
          signal: AbortSignal.timeout(5000),
        });
        delivery.status = res.status;
        try { await res.arrayBuffer(); } catch { /* ignore */ }
        if (res.status >= 200 && res.status < 300) { delivery.lastError = null; delivery.deliveredAt = nowIso(); break; }
        delivery.lastError = `HTTP ${res.status}`;
      } catch (e) {
        delivery.lastError = e?.cause?.code || e?.message || String(e);
      }
      try { save(); } catch { /* ignore */ }
      if (attempt < 3) await new Promise(r => setTimeout(r, 50 * attempt));
    }
    try { save(); } catch { /* ignore */ }
  }

  // ---------- workflow ----------
  function defaultWorkflow() {
    const statuses = [
      { name: 'Backlog', category: 'backlog' },
      { name: 'Todo', category: 'unstarted' },
      { name: 'In Progress', category: 'started' },
      { name: 'In Review', category: 'started' },
      { name: 'Done', category: 'completed' },
    ];
    return { statuses, transitions: allTransitions(statuses) };
  }
  function allTransitions(statuses) {
    const t = [];
    for (const a of statuses) for (const b of statuses) if (a.name !== b.name) t.push([a.name, b.name]);
    return t;
  }
  const initialStatus = project => (project.workflow.statuses.find(s => s.category === 'unstarted') || project.workflow.statuses[0]).name;
  const transitionAllowed = (project, from, to) => from === to || project.workflow.transitions.some(([a, b]) => a === from && b === to);

  // ---------- issue validation ----------
  function normalizeIssueInput(project, raw, existing) {
    const out = {};
    if ('type' in raw) {
      if (!TYPES.includes(raw.type)) throw badRequest(`type must be one of ${TYPES.join(', ')}`);
      out.type = raw.type;
    }
    if ('title' in raw) {
      if (typeof raw.title !== 'string' || !raw.title.trim()) throw badRequest('title is required');
      if (raw.title.length > 500) throw badRequest('title too long');
      out.title = raw.title.trim();
    }
    if ('description' in raw) {
      if (raw.description !== null && typeof raw.description !== 'string') throw badRequest('description must be a string');
      out.description = raw.description ?? '';
    }
    if ('status' in raw) {
      if (typeof raw.status !== 'string' || !statusDef(project, raw.status)) throw badRequest(`unknown status: ${raw.status}`);
      out.status = raw.status;
    }
    if ('priority' in raw) {
      if (!PRIORITIES.includes(raw.priority)) throw badRequest(`priority must be one of ${PRIORITIES.join(', ')}`);
      out.priority = raw.priority;
    }
    if ('assigneeId' in raw || 'assignee' in raw) {
      const v = 'assigneeId' in raw ? raw.assigneeId : raw.assignee;
      if (v === null || v === '') out.assigneeId = null;
      else {
        const u = userById(String(v)) || userByName(String(v));
        if (!u) throw badRequest('assignee not found');
        if (!canSeeProject(project, u.id)) throw badRequest('assignee has no access to this project');
        out.assigneeId = u.id;
      }
    }
    if ('labels' in raw) {
      if (raw.labels === null) out.labels = [];
      else {
        if (!Array.isArray(raw.labels) || raw.labels.some(l => typeof l !== 'string' || !l.trim())) throw badRequest('labels must be an array of non-empty strings');
        out.labels = [...new Set(raw.labels.map(l => l.trim()))];
      }
    }
    if ('storyPoints' in raw) {
      const v = raw.storyPoints;
      if (v === null) out.storyPoints = null;
      else if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw badRequest('storyPoints must be a non-negative number');
      else out.storyPoints = v;
    }
    if ('parentId' in raw) {
      if (raw.parentId === null || raw.parentId === '') out.parentId = null;
      else {
        const p = issueByRef(raw.parentId);
        if (!p || p.projectId !== project.id) throw badRequest('parent must be an issue in the same project');
        out.parentId = p.id;
      }
    }
    if ('epicId' in raw) {
      if (raw.epicId === null || raw.epicId === '') out.epicId = null;
      else {
        const e = issueByRef(raw.epicId);
        if (!e || e.type !== 'epic') throw badRequest('epicId must reference an epic');
        if (e.projectId !== project.id) throw badRequest('epic must be in the same project');
        out.epicId = e.id;
      }
    }
    if ('sprintId' in raw) {
      if (raw.sprintId === null || raw.sprintId === '') out.sprintId = null;
      else {
        const s = sprintById(String(raw.sprintId));
        if (!s || s.projectId !== project.id) throw badRequest('sprint not found in this project');
        if (s.state === 'completed') throw badRequest('cannot add issues to a completed sprint');
        out.sprintId = s.id;
      }
    }
    if ('dueDate' in raw) {
      if (raw.dueDate === null || raw.dueDate === '') out.dueDate = null;
      else if (!isValidDateish(raw.dueDate)) throw badRequest('dueDate must be YYYY-MM-DD');
      else out.dueDate = raw.dueDate;
    }
    // Structural rules on the resulting state
    const final = { ...(existing || { type: 'task', parentId: null, epicId: null }), ...out };
    if (final.type === 'subtask') {
      if (!final.parentId) throw badRequest('subtasks require a parentId');
      const parent = issueById(final.parentId);
      if (!parent || parent.type === 'subtask') throw badRequest('parent of a subtask must be a non-subtask issue');
    } else if (final.parentId) {
      const parent = issueById(final.parentId);
      if (final.type === 'epic') throw badRequest('epics cannot have a parent');
      if (!parent || parent.type === 'subtask') throw badRequest('parent cannot be a subtask');
    }
    if (final.type === 'epic' && final.epicId) throw badRequest('epics cannot belong to an epic');
    if (existing) {
      if (final.parentId === existing.id) throw badRequest('issue cannot be its own parent');
      if (final.epicId === existing.id) throw badRequest('issue cannot be its own epic');
      if (out.type && out.type !== 'epic' && existing.type === 'epic' && db.issues.some(i => i.epicId === existing.id)) throw badRequest('epic still has issues');
      if (out.type === 'subtask' && db.issues.some(i => i.parentId === existing.id)) throw badRequest('issue with subtasks cannot become a subtask');
    }
    return out;
  }

  function isBlocked(issue) {
    return db.links.some(l => {
      if (l.type !== 'blocks' || l.targetId !== issue.id) return false;
      const src = issueById(l.sourceId);
      return src && !src.resolvedAt;
    });
  }

  function createIssue(project, raw, actor) {
    if (!('title' in raw)) throw badRequest('title is required');
    const fields = normalizeIssueInput(project, raw, null);
    const at = nowIso();
    const status = fields.status || initialStatus(project);
    project.issueSeq = (project.issueSeq || 0) + 1;
    const n = project.issueSeq;
    const issue = {
      id: newId(), key: `${project.key}-${n}`, number: n, projectId: project.id,
      type: fields.type || 'task', title: fields.title, description: fields.description ?? '',
      status, priority: fields.priority || 'none', assigneeId: fields.assigneeId ?? null, reporterId: actor.id,
      labels: fields.labels || [], storyPoints: fields.storyPoints ?? null, parentId: fields.parentId ?? null,
      epicId: fields.epicId ?? null, sprintId: fields.sprintId ?? null, dueDate: fields.dueDate ?? null,
      watchers: [], createdAt: at, updatedAt: at, resolvedAt: isCompletedStatus(project, status) ? at : null,
    };
    issue.watchers = [...new Set([actor.id, issue.assigneeId].filter(Boolean))];
    issue._initial = { status: issue.status, storyPoints: issue.storyPoints, sprintId: issue.sprintId };
    db.issues.push(issue);
    if (issue.assigneeId && issue.assigneeId !== actor.id) notify([issue.assigneeId], 'assigned', issue, actor.id);
    emitWebhook(project.id, 'issue.created', { issue: serializeIssue(issue), actorId: actor.id });
    return issue;
  }

  function recordHistory(issue, field, from, to, actorId, at) {
    db.history.push({ id: newId(), issueId: issue.id, field, from: from ?? null, to: to ?? null, actorId, at });
  }

  function updateIssue(issue, project, raw, actor) {
    const fields = normalizeIssueInput(project, raw, issue);
    const changes = {};
    for (const f of ISSUE_FIELDS) if (f in fields && !sameValue(issue[f], fields[f])) changes[f] = fields[f];
    if ('status' in changes) {
      if (!transitionAllowed(project, issue.status, changes.status)) {
        throw conflict(`transition from "${issue.status}" to "${changes.status}" is not allowed`, 'invalid_transition');
      }
      if (isCompletedStatus(project, changes.status) && isBlocked(issue)) throw conflict('issue is blocked by unresolved issues', 'blocked');
    }
    if (!Object.keys(changes).length) return issue;
    const at = nowIso();
    for (const [f, v] of Object.entries(changes)) {
      recordHistory(issue, f, Array.isArray(issue[f]) ? [...issue[f]] : issue[f], Array.isArray(v) ? [...v] : v, actor.id, at);
      issue[f] = v;
    }
    if ('status' in changes) {
      const completed = isCompletedStatus(project, issue.status);
      if (completed && !issue.resolvedAt) issue.resolvedAt = at;
      if (!completed) issue.resolvedAt = null;
    }
    if ('assigneeId' in changes && issue.assigneeId && !issue.watchers.includes(issue.assigneeId)) issue.watchers.push(issue.assigneeId);
    issue.updatedAt = at;
    if ('status' in changes) notify(issue.watchers, 'status_changed', issue, actor.id, { to: issue.status });
    if ('assigneeId' in changes && issue.assigneeId) notify(issue.watchers, 'assigned', issue, actor.id, { assigneeId: issue.assigneeId });
    emitWebhook(project.id, 'issue.updated', { issue: serializeIssue(issue), changes: Object.keys(changes), actorId: actor.id });
    return issue;
  }

  function deleteIssue(issue, actor) {
    const ids = new Set([issue.id]);
    for (const i of db.issues) if (i.parentId === issue.id) ids.add(i.id);
    const project = projectById(issue.projectId);
    const removed = db.issues.filter(i => ids.has(i.id));
    db.issues = db.issues.filter(i => !ids.has(i.id));
    db.links = db.links.filter(l => !ids.has(l.sourceId) && !ids.has(l.targetId));
    db.comments = db.comments.filter(c => !ids.has(c.issueId));
    for (const i of db.issues) {
      if (ids.has(i.epicId)) i.epicId = null;
      if (ids.has(i.parentId)) i.parentId = null;
    }
    for (const r of removed) emitWebhook(project.id, 'issue.deleted', { issue: serializeIssueBare(r), actorId: actor.id });
  }
  const serializeIssueBare = issue => { const { _initial, number, ...pub } = issue; return pub; };

  // ---------- sprint report ----------
  function issueStateAt(issue, t) {
    if (new Date(issue.createdAt).getTime() > t) return null;
    const st = { ...(issue._initial || { status: issue.status, storyPoints: issue.storyPoints, sprintId: issue.sprintId }) };
    for (const h of db.history) {
      if (h.issueId !== issue.id || !(h.field in st)) continue;
      if (new Date(h.at).getTime() > t) continue;
      st[h.field] = h.to;
    }
    return st;
  }
  function sprintReport(sprint) {
    const project = projectById(sprint.projectId);
    const pts = i => (typeof i.storyPoints === 'number' ? i.storyPoints : 0);
    const inSprint = db.issues.filter(i => i.sprintId === sprint.id);
    let committedPoints, completedPoints, completedIssues, carriedOver;
    if (sprint.state === 'planned') {
      committedPoints = inSprint.reduce((a, i) => a + pts(i), 0);
    } else {
      committedPoints = sprint.committedPoints ?? 0;
    }
    if (sprint.state === 'completed') {
      completedPoints = sprint.completedPoints ?? 0;
      completedIssues = (sprint.completedIssueIds || []).length;
      carriedOver = (sprint.carriedOverIds || []).length;
    } else {
      const done = inSprint.filter(i => isCompletedStatus(project, i.status));
      completedPoints = done.reduce((a, i) => a + pts(i), 0);
      completedIssues = done.length;
      carriedOver = 0;
    }
    const burndown = [];
    const startSrc = sprint.startDate || sprint.startedAt;
    if (startSrc) {
      const start = new Date(dayOf(startSrc) + 'T00:00:00Z');
      const today = dayOf(now());
      let endDay = today;
      if (sprint.endDate && dayOf(sprint.endDate) < endDay) endDay = dayOf(sprint.endDate);
      const completedAtMs = sprint.completedAt ? new Date(sprint.completedAt).getTime() : Infinity;
      const nowMs = now().getTime();
      const candidates = db.issues.filter(i => i.projectId === sprint.projectId);
      for (let d = new Date(start); dayOf(d) <= endDay && burndown.length < 3660; d = new Date(d.getTime() + 86400000)) {
        const date = dayOf(d);
        let t = new Date(date + 'T23:59:59.999Z').getTime();
        t = Math.min(t, completedAtMs, nowMs);
        let remaining = 0;
        for (const iss of candidates) {
          const st = issueStateAt(iss, t);
          if (!st || st.sprintId !== sprint.id) continue;
          if (isCompletedStatus(project, st.status)) continue;
          remaining += typeof st.storyPoints === 'number' ? st.storyPoints : 0;
        }
        burndown.push({ date, remainingPoints: remaining });
      }
    }
    return { sprintId: sprint.id, state: sprint.state, committedPoints, completedPoints, completedIssues, carriedOver, burndown };
  }

  // ---------- CSV ----------
  const CSV_HEADER = ['key', 'type', 'title', 'status', 'priority', 'assignee', 'labels', 'storyPoints', 'parent', 'epic', 'sprint', 'dueDate', 'createdAt', 'resolvedAt'];
  function exportCsv(project) {
    const rows = [CSV_HEADER];
    const issues = db.issues.filter(i => i.projectId === project.id).sort((a, b) => a.number - b.number);
    for (const i of issues) {
      rows.push([
        i.key, i.type, i.title, i.status, i.priority, i.assigneeId ? userById(i.assigneeId)?.username ?? '' : '',
        (i.labels || []).join(';'), i.storyPoints ?? '', i.parentId ? issueById(i.parentId)?.key ?? '' : '',
        i.epicId ? issueById(i.epicId)?.key ?? '' : '', i.sprintId ? sprintById(i.sprintId)?.name ?? '' : '',
        i.dueDate ?? '', i.createdAt, i.resolvedAt ?? '',
      ]);
    }
    return toCSV(rows);
  }
  function importCsv(project, text, actor) {
    let records;
    try { records = parseCSV(text); } catch (e) { throw badRequest('malformed CSV: ' + e.message, 'invalid_csv'); }
    if (!records.length) throw badRequest('CSV is empty', 'invalid_csv');
    const header = records[0].fields.map(h => h.trim());
    const idx = {};
    header.forEach((h, i) => { const canon = CSV_HEADER.find(c => c.toLowerCase() === h.toLowerCase()); if (canon && !(canon in idx)) idx[canon] = i; });
    if (!('title' in idx)) throw badRequest('CSV header must include a title column', 'invalid_csv');
    let created = 0;
    const errors = [];
    const createdKeys = [];
    for (const rec of records.slice(1)) {
      const get = c => (c in idx ? (rec.fields[idx[c]] ?? '').trim() : '');
      try {
        if (rec.fields.length !== header.length) throw badRequest(`expected ${header.length} fields, got ${rec.fields.length}`);
        const raw = { title: get('title') };
        const type = get('type'); if (type) raw.type = type.toLowerCase();
        const status = get('status');
        if (status) {
          const def = project.workflow.statuses.find(s => s.name.toLowerCase() === status.toLowerCase());
          raw.status = def ? def.name : status;
        }
        const priority = get('priority'); if (priority) raw.priority = priority.toLowerCase();
        const assignee = get('assignee');
        if (assignee) { const u = userByName(assignee); if (!u) throw badRequest(`unknown assignee: ${assignee}`); raw.assigneeId = u.id; }
        const labels = get('labels'); if (labels) raw.labels = labels.split(';').map(s => s.trim()).filter(Boolean);
        const sp = get('storyPoints');
        if (sp) { const n = Number(sp); if (!Number.isFinite(n)) throw badRequest(`invalid storyPoints: ${sp}`); raw.storyPoints = n; }
        const parent = get('parent');
        if (parent) { const p = issueByRef(parent); if (!p || p.projectId !== project.id) throw badRequest(`unknown parent: ${parent}`); raw.parentId = p.id; }
        const epic = get('epic');
        if (epic) { const e = issueByRef(epic); if (!e || e.projectId !== project.id) throw badRequest(`unknown epic: ${epic}`); raw.epicId = e.id; }
        const sprint = get('sprint');
        if (sprint) {
          const s = db.sprints.find(x => x.projectId === project.id && (x.id === sprint || x.name === sprint));
          if (!s) throw badRequest(`unknown sprint: ${sprint}`);
          raw.sprintId = s.id;
        }
        const due = get('dueDate'); if (due) raw.dueDate = due;
        const issue = createIssue(project, raw, actor);
        created++; createdKeys.push(issue.key);
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        errors.push({ line: rec.line, message: e.message });
      }
    }
    return { created, errors, keys: createdKeys };
  }

  // ---------- routing ----------
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const names = [];
    const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, n) => { names.push(n); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, names, handler, auth: opts.auth !== false, raw: !!opts.raw });
  };

  // ===== Auth =====
  function validateUsername(u) {
    if (typeof u !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(u)) throw badRequest('username must be 1-64 characters of letters, digits, _ . -');
  }
  function validatePassword(p, field = 'password') {
    if (typeof p !== 'string' || p.length < 8) throw badRequest(`${field} must be at least 8 characters`);
    if (p.length > 1024) throw badRequest(`${field} too long`);
  }
  function validateDisplayName(d) {
    if (typeof d !== 'string' || !d.trim() || d.length > 200) throw badRequest('displayName must be a non-empty string');
  }

  route('POST', '/api/auth/register', ({ body }) => {
    const { username, password, displayName } = body;
    validateUsername(username);
    validatePassword(password);
    if (displayName !== undefined && displayName !== null) validateDisplayName(displayName);
    if (userByName(username)) throw conflict('username already taken');
    const user = { id: newId(), username, displayName: displayName ? displayName.trim() : username, password: hashPassword(password), createdAt: nowIso() };
    db.users.push(user);
    return [201, { user: publicUser(user) }];
  }, { auth: false });

  route('POST', '/api/auth/login', ({ body }) => {
    const { username, password } = body;
    if (typeof username !== 'string' || typeof password !== 'string' || !username) throw badRequest('username and password are required');
    const k = username.toLowerCase();
    const t = now().getTime();
    const fails = (db.loginFailures[k] || []).filter(x => t - x < LOGIN_WINDOW_MS);
    db.loginFailures[k] = fails;
    if (fails.length >= LOGIN_MAX_FAILURES) throw new HttpError(429, 'rate_limited', 'too many failed login attempts; try again later');
    const user = userByName(username);
    if (!user || !verifyPassword(password, user.password)) {
      fails.push(t);
      db.loginFailures[k] = fails;
      throw new HttpError(401, 'invalid_credentials', 'invalid username or password');
    }
    delete db.loginFailures[k];
    const token = randomToken('s_');
    db.sessions.push({ hash: sha256(token), userId: user.id, createdAt: nowIso() });
    return [200, { token, user: publicUser(user) }];
  }, { auth: false });

  route('POST', '/api/auth/logout', ({ tokenHash, authKind }) => {
    if (authKind === 'session') db.sessions = db.sessions.filter(s => s.hash !== tokenHash);
    return [204, null];
  });
  route('GET', '/api/auth/me', ({ user }) => [200, { user: publicUser(user) }]);
  route('PATCH', '/api/auth/me', ({ user, body }) => {
    const { displayName, password, currentPassword } = body;
    if (typeof currentPassword !== 'string' || !currentPassword) throw badRequest('currentPassword is required');
    if (!verifyPassword(currentPassword, user.password)) throw new HttpError(403, 'invalid_credentials', 'current password is incorrect');
    if (displayName !== undefined) validateDisplayName(displayName);
    if (password !== undefined) validatePassword(password);
    if (displayName !== undefined) user.displayName = displayName.trim();
    if (password !== undefined) user.password = hashPassword(password);
    return [200, { user: publicUser(user) }];
  });

  // ===== API tokens =====
  route('POST', '/api/tokens', ({ user, body }) => {
    const { name } = body;
    if (typeof name !== 'string' || !name.trim() || name.length > 200) throw badRequest('name is required');
    const token = randomToken('pm_');
    const rec = { id: newId(), userId: user.id, name: name.trim(), hash: sha256(token), createdAt: nowIso(), lastUsedAt: null };
    db.apiTokens.push(rec);
    auditUserWorkspaces(user.id, 'token.created', { tokenId: rec.id, name: rec.name });
    return [201, { id: rec.id, name: rec.name, token, createdAt: rec.createdAt }];
  });
  route('GET', '/api/tokens', ({ user }) => [200, db.apiTokens.filter(t => t.userId === user.id).map(t => ({ id: t.id, name: t.name, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt }))]);
  route('DELETE', '/api/tokens/:id', ({ user, params }) => {
    const t = db.apiTokens.find(x => x.id === params.id);
    if (!t) throw notFound('token not found');
    if (t.userId !== user.id) throw notFound('token not found');
    db.apiTokens = db.apiTokens.filter(x => x !== t);
    auditUserWorkspaces(user.id, 'token.deleted', { tokenId: t.id, name: t.name });
    return [204, null];
  });

  // ===== Workspaces =====
  const serializeWs = (ws, userId) => ({ ...ws, role: wsRole(ws.id, userId) });
  const memberView = m => { const u = userById(m.userId); return { userId: m.userId, username: u?.username, displayName: u?.displayName, role: m.role, user: publicUser(u) }; };
  function findMemberParam(list, param) {
    return list.find(m => m.userId === param) || list.find(m => userById(m.userId)?.username.toLowerCase() === String(param).toLowerCase());
  }

  route('POST', '/api/workspaces', ({ user, body }) => {
    const { name, key } = body;
    if (typeof name !== 'string' || !name.trim()) throw badRequest('name is required');
    if (typeof key !== 'string' || !/^[A-Z]{2,10}$/.test(key)) throw badRequest('key must be 2-10 uppercase letters');
    if (db.workspaces.some(w => w.key === key)) throw conflict('workspace key already in use');
    const ws = { id: newId(), name: name.trim(), key, createdAt: nowIso(), createdBy: user.id };
    db.workspaces.push(ws);
    db.wsMembers.push({ workspaceId: ws.id, userId: user.id, role: 'admin', addedAt: nowIso() });
    audit(ws.id, 'workspace.created', user.id, { name: ws.name, key });
    return [201, serializeWs(ws, user.id)];
  });
  route('GET', '/api/workspaces', ({ user }) => [200, db.workspaces.filter(w => wsRole(w.id, user.id)).map(w => serializeWs(w, user.id))]);
  route('GET', '/api/workspaces/:id', ({ user, params }) => { const { ws } = requireWorkspace(params.id, user); return [200, serializeWs(ws, user.id)]; });
  route('PATCH', '/api/workspaces/:id', ({ user, params, body }) => {
    const { ws } = requireWorkspace(params.id, user, true);
    if (body.name !== undefined) { if (typeof body.name !== 'string' || !body.name.trim()) throw badRequest('invalid name'); ws.name = body.name.trim(); }
    return [200, serializeWs(ws, user.id)];
  });
  route('GET', '/api/workspaces/:id/members', ({ user, params }) => {
    const { ws } = requireWorkspace(params.id, user);
    return [200, db.wsMembers.filter(m => m.workspaceId === ws.id).map(memberView)];
  });
  route('POST', '/api/workspaces/:id/members', ({ user, params, body }) => {
    const { ws } = requireWorkspace(params.id, user, true);
    const { username, userId } = body;
    const role = body.role ?? 'member';
    if (!WS_ROLES.includes(role)) throw badRequest(`role must be one of ${WS_ROLES.join(', ')}`);
    if (!username && !userId) throw badRequest('username is required');
    const target = username ? userByName(username) : userById(String(userId));
    if (!target) throw notFound('user not found');
    if (wsMember(ws.id, target.id)) throw conflict('user is already a member');
    const m = { workspaceId: ws.id, userId: target.id, role, addedAt: nowIso() };
    db.wsMembers.push(m);
    audit(ws.id, 'member.added', user.id, { userId: target.id, username: target.username, role });
    return [201, memberView(m)];
  });
  const adminCount = wsId => db.wsMembers.filter(m => m.workspaceId === wsId && m.role === 'admin').length;
  route('PATCH', '/api/workspaces/:id/members/:userId', ({ user, params, body }) => {
    const { ws } = requireWorkspace(params.id, user, true);
    const m = findMemberParam(db.wsMembers.filter(x => x.workspaceId === ws.id), params.userId);
    if (!m) throw notFound('member not found');
    const { role } = body;
    if (!WS_ROLES.includes(role)) throw badRequest(`role must be one of ${WS_ROLES.join(', ')}`);
    if (m.role === 'admin' && role !== 'admin' && adminCount(ws.id) <= 1) throw badRequest('cannot demote the last admin', 'last_admin');
    const from = m.role;
    m.role = role;
    if (from !== role) audit(ws.id, 'member.role_changed', user.id, { userId: m.userId, from, to: role });
    return [200, memberView(m)];
  });
  route('DELETE', '/api/workspaces/:id/members/:userId', ({ user, params }) => {
    const { ws } = requireWorkspace(params.id, user, true);
    const m = findMemberParam(db.wsMembers.filter(x => x.workspaceId === ws.id), params.userId);
    if (!m) throw notFound('member not found');
    if (m.role === 'admin' && adminCount(ws.id) <= 1) throw badRequest('cannot remove the last admin', 'last_admin');
    db.wsMembers = db.wsMembers.filter(x => x !== m);
    const projIds = new Set(db.projects.filter(p => p.workspaceId === ws.id).map(p => p.id));
    db.projMembers = db.projMembers.filter(pm => !(pm.userId === m.userId && projIds.has(pm.projectId)));
    audit(ws.id, 'member.removed', user.id, { userId: m.userId });
    return [204, null];
  });
  route('GET', '/api/workspaces/:id/audit', ({ user, params }) => {
    const { ws } = requireWorkspace(params.id, user, true);
    return [200, db.audit.filter(a => a.workspaceId === ws.id)];
  });

  // ===== Projects =====
  route('POST', '/api/workspaces/:id/projects', ({ user, params, body }) => {
    const { ws, role } = requireWorkspace(params.id, user);
    if (role === 'guest') throw forbidden('guests cannot create projects');
    const { name, key } = body;
    if (typeof name !== 'string' || !name.trim()) throw badRequest('name is required');
    if (typeof key !== 'string' || !/^[A-Z][A-Z0-9]{1,9}$/.test(key)) throw badRequest('key must be 2-10 uppercase letters');
    if (db.projects.some(p => p.key === key)) throw conflict('project key already in use');
    const p = { id: newId(), workspaceId: ws.id, name: name.trim(), key, description: typeof body.description === 'string' ? body.description : '', workflow: defaultWorkflow(), issueSeq: 0, createdAt: nowIso(), createdBy: user.id };
    db.projects.push(p);
    if (role !== 'admin') db.projMembers.push({ projectId: p.id, userId: user.id, role: 'lead', addedAt: nowIso() });
    audit(ws.id, 'project.created', user.id, { projectId: p.id, key });
    return [201, serializeProject(p, user.id)];
  });
  route('GET', '/api/workspaces/:id/projects', ({ user, params }) => {
    const { ws } = requireWorkspace(params.id, user);
    return [200, db.projects.filter(p => p.workspaceId === ws.id && canSeeProject(p, user.id)).map(p => serializeProject(p, user.id))];
  });
  route('GET', '/api/projects', ({ user }) => [200, db.projects.filter(p => canSeeProject(p, user.id)).map(p => serializeProject(p, user.id))]);
  route('GET', '/api/projects/:id', ({ user, params }) => { const { project } = requireProject(params.id, user); return [200, serializeProject(project, user.id)]; });
  route('PATCH', '/api/projects/:id', ({ user, params, body }) => {
    const { project } = requireProject(params.id, user, 'lead');
    if (body.name !== undefined) { if (typeof body.name !== 'string' || !body.name.trim()) throw badRequest('invalid name'); project.name = body.name.trim(); }
    if (body.description !== undefined) { if (typeof body.description !== 'string') throw badRequest('invalid description'); project.description = body.description; }
    return [200, serializeProject(project, user.id)];
  });
  route('DELETE', '/api/projects/:id', ({ user, params }) => {
    const { project } = requireProject(params.id, user, 'lead');
    for (const i of db.issues.filter(x => x.projectId === project.id && !x.parentId)) deleteIssue(i, user);
    db.issues = db.issues.filter(i => i.projectId !== project.id);
    db.sprints = db.sprints.filter(s => s.projectId !== project.id);
    db.projMembers = db.projMembers.filter(m => m.projectId !== project.id);
    db.webhooks = db.webhooks.filter(w => w.projectId !== project.id);
    db.projects = db.projects.filter(p => p !== project);
    audit(project.workspaceId, 'project.deleted', user.id, { projectId: project.id });
    return [204, null];
  });

  // project members
  const projMemberView = m => { const u = userById(m.userId); return { userId: m.userId, username: u?.username, displayName: u?.displayName, role: m.role, user: publicUser(u) }; };
  route('GET', '/api/projects/:id/members', ({ user, params }) => {
    const { project } = requireProject(params.id, user);
    const explicit = db.projMembers.filter(m => m.projectId === project.id).map(projMemberView);
    return [200, explicit];
  });
  route('POST', '/api/projects/:id/members', ({ user, params, body }) => {
    const { project } = requireProject(params.id, user, 'lead');
    const role = body.role ?? 'developer';
    if (!PROJECT_ROLES.includes(role)) throw badRequest(`role must be one of ${PROJECT_ROLES.join(', ')}`);
    if (!body.username && !body.userId) throw badRequest('username is required');
    const target = body.username ? userByName(body.username) : userById(String(body.userId));
    if (!target) throw notFound('user not found');
    if (!wsRole(project.workspaceId, target.id)) throw badRequest('user is not a member of the workspace');
    const existing = db.projMembers.find(m => m.projectId === project.id && m.userId === target.id);
    if (existing) throw conflict('user is already a project member');
    const m = { projectId: project.id, userId: target.id, role, addedAt: nowIso() };
    db.projMembers.push(m);
    audit(project.workspaceId, 'project.member_added', user.id, { projectId: project.id, userId: target.id, role });
    return [201, projMemberView(m)];
  });
  route('PATCH', '/api/projects/:id/members/:userId', ({ user, params, body }) => {
    const { project } = requireProject(params.id, user, 'lead');
    const m = findMemberParam(db.projMembers.filter(x => x.projectId === project.id), params.userId);
    if (!m) throw notFound('member not found');
    if (!PROJECT_ROLES.includes(body.role)) throw badRequest(`role must be one of ${PROJECT_ROLES.join(', ')}`);
    const from = m.role; m.role = body.role;
    if (from !== m.role) audit(project.workspaceId, 'project.member_role_changed', user.id, { projectId: project.id, userId: m.userId, from, to: m.role });
    return [200, projMemberView(m)];
  });
  route('DELETE', '/api/projects/:id/members/:userId', ({ user, params }) => {
    const { project } = requireProject(params.id, user, 'lead');
    const m = findMemberParam(db.projMembers.filter(x => x.projectId === project.id), params.userId);
    if (!m) throw notFound('member not found');
    db.projMembers = db.projMembers.filter(x => x !== m);
    audit(project.workspaceId, 'project.member_removed', user.id, { projectId: project.id, userId: m.userId });
    return [204, null];
  });

  // workflow
  route('GET', '/api/projects/:id/workflow', ({ user, params }) => { const { project } = requireProject(params.id, user); return [200, structuredClone(project.workflow)]; });
  route('PUT', '/api/projects/:id/workflow', ({ user, params, body }) => {
    const { project } = requireProject(params.id, user, 'lead');
    const { statuses, transitions, remap } = body;
    if (!Array.isArray(statuses) || !statuses.length) throw badRequest('statuses must be a non-empty array');
    const names = new Set();
    const newStatuses = statuses.map(s => {
      if (!isPlainObject(s) || typeof s.name !== 'string' || !s.name.trim()) throw badRequest('each status needs a name');
      if (!CATEGORIES.includes(s.category)) throw badRequest(`category must be one of ${CATEGORIES.join(', ')}`);
      const name = s.name.trim();
      if (names.has(name)) throw badRequest(`duplicate status: ${name}`);
      names.add(name);
      return { name, category: s.category };
    });
    let newTransitions;
    if (transitions === undefined || transitions === null) newTransitions = allTransitions(newStatuses);
    else {
      if (!Array.isArray(transitions)) throw badRequest('transitions must be an array');
      const seen = new Set();
      newTransitions = [];
      for (const t of transitions) {
        let pair = t;
        if (isPlainObject(t)) pair = [t.from, t.to];
        if (!Array.isArray(pair) || pair.length !== 2 || !names.has(pair[0]) || !names.has(pair[1])) throw badRequest('each transition must be [from, to] referencing defined statuses');
        const k = JSON.stringify(pair);
        if (!seen.has(k)) { seen.add(k); newTransitions.push([pair[0], pair[1]]); }
      }
    }
    if (remap !== undefined && remap !== null && !isPlainObject(remap)) throw badRequest('remap must be an object');
    const map = remap || {};
    const issues = db.issues.filter(i => i.projectId === project.id);
    const removedInUse = new Set(issues.filter(i => !names.has(i.status)).map(i => i.status));
    for (const old of removedInUse) {
      if (!(old in map)) throw badRequest(`status "${old}" is in use; provide remap`, 'remap_required');
      if (!names.has(map[old])) throw badRequest(`remap target "${map[old]}" is not a defined status`);
    }
    for (const [k, v] of Object.entries(map)) if (!names.has(v) && removedInUse.has(k)) throw badRequest(`remap target "${v}" is not a defined status`);
    const at = nowIso();
    const oldWorkflow = project.workflow;
    project.workflow = { statuses: newStatuses, transitions: newTransitions };
    for (const i of issues) {
      if (!names.has(i.status)) {
        const to = map[i.status];
        recordHistory(i, 'status', i.status, to, user.id, at);
        i.status = to;
        i.updatedAt = at;
      }
      const completed = isCompletedStatus(project, i.status);
      if (completed && !i.resolvedAt) i.resolvedAt = at;
      if (!completed && i.resolvedAt) i.resolvedAt = null;
    }
    audit(project.workspaceId, 'workflow.updated', user.id, { projectId: project.id, from: oldWorkflow.statuses.map(s => s.name), to: newStatuses.map(s => s.name) });
    return [200, { ...structuredClone(project.workflow), projectId: project.id }];
  });

  // ===== Issues =====
  route('POST', '/api/projects/:id/issues', ({ user, params, body }) => {
    const { project } = requireProject(params.id, user, 'developer');
    const issue = createIssue(project, body, user);
    return [201, serializeIssue(issue)];
  });
  route('GET', '/api/projects/:id/issues', ({ user, params, query }) => {
    const { project } = requireProject(params.id, user);
    let list = db.issues.filter(i => i.projectId === project.id);
    if (query.get('status')) list = list.filter(i => i.status === query.get('status'));
    if (query.get('sprintId')) list = list.filter(i => (query.get('sprintId') === 'none' ? !i.sprintId : i.sprintId === query.get('sprintId')));
    if (query.get('type')) list = list.filter(i => i.type === query.get('type'));
    return [200, list.sort((a, b) => a.number - b.number).map(serializeIssue)];
  });
  route('GET', '/api/issues/:key', ({ user, params }) => { const { issue } = requireIssue(params.key, user); return [200, serializeIssue(issue)]; });
  route('PATCH', '/api/issues/:key', ({ user, params, body }) => {
    const { issue, project } = requireIssue(params.key, user, 'developer');
    updateIssue(issue, project, body, user);
    return [200, serializeIssue(issue)];
  });
  route('DELETE', '/api/issues/:key', ({ user, params }) => {
    const { issue } = requireIssue(params.key, user, 'developer');
    deleteIssue(issue, user);
    return [204, null];
  });
  route('GET', '/api/issues/:key/history', ({ user, params }) => {
    const { issue } = requireIssue(params.key, user);
    return [200, db.history.filter(h => h.issueId === issue.id).map(({ issueId, ...h }) => h)];
  });
  route('POST', '/api/issues/:key/watch', ({ user, params }) => {
    const { issue } = requireIssue(params.key, user);
    if (!issue.watchers.includes(user.id)) issue.watchers.push(user.id);
    return [200, serializeIssue(issue)];
  });
  route('DELETE', '/api/issues/:key/watch', ({ user, params }) => {
    const { issue } = requireIssue(params.key, user);
    issue.watchers = issue.watchers.filter(w => w !== user.id);
    return [200, serializeIssue(issue)];
  });

  // links
  route('GET', '/api/issues/:key/links', ({ user, params }) => { const { issue } = requireIssue(params.key, user); return [200, issueLinks(issue)]; });
  route('POST', '/api/issues/:key/links', ({ user, params, body }) => {
    const { issue } = requireIssue(params.key, user, 'developer');
    const { type, target } = body;
    if (!LINK_TYPES.includes(type)) throw badRequest(`type must be one of ${LINK_TYPES.join(', ')}`);
    if (!target) throw badRequest('target is required');
    const t = issueByRef(target);
    if (!t) throw badRequest('target issue not found');
    const tp = projectById(t.projectId);
    if (!canSeeProject(tp, user.id)) throw badRequest('target issue not found');
    if (t.id === issue.id) throw badRequest('cannot link an issue to itself');
    const dup = db.links.find(l => l.type === type && ((l.sourceId === issue.id && l.targetId === t.id) || (type === 'relates' && l.sourceId === t.id && l.targetId === issue.id)));
    if (dup) throw conflict('link already exists');
    const link = { id: newId(), type, sourceId: issue.id, targetId: t.id, createdAt: nowIso(), createdBy: user.id };
    db.links.push(link);
    const at = link.createdAt;
    issue.updatedAt = at; t.updatedAt = at;
    return [201, { id: link.id, type, source: issue.key, target: t.key, createdAt: link.createdAt }];
  });
  route('DELETE', '/api/issues/:key/links/:linkId', ({ user, params }) => {
    const { issue } = requireIssue(params.key, user, 'developer');
    const l = db.links.find(x => x.id === params.linkId && (x.sourceId === issue.id || x.targetId === issue.id));
    if (!l) throw notFound('link not found');
    db.links = db.links.filter(x => x !== l);
    return [204, null];
  });

  // ===== Comments =====
  const serializeComment = c => { const issue = issueById(c.issueId); return { ...c, issueKey: issue?.key }; };
  route('GET', '/api/issues/:key/comments', ({ user, params }) => {
    const { issue } = requireIssue(params.key, user);
    return [200, db.comments.filter(c => c.issueId === issue.id).map(serializeComment)];
  });
  route('POST', '/api/issues/:key/comments', ({ user, params, body }) => {
    const { issue, project } = requireIssue(params.key, user, 'developer');
    const text = body.body ?? body.text;
    if (typeof text !== 'string' || !text.trim()) throw badRequest('body is required');
    if (text.length > 20000) throw badRequest('body too long');
    const at = nowIso();
    const c = { id: newId(), issueId: issue.id, authorId: user.id, body: text, createdAt: at, updatedAt: at, edited: false };
    db.comments.push(c);
    issue.updatedAt = at;
    const mentioned = new Set();
    for (const m of text.matchAll(/(^|[^A-Za-z0-9_.@-])@([A-Za-z0-9_.-]+)/g)) {
      const name = m[2].replace(/[.-]+$/, '');
      const u = userByName(name);
      if (u && u.id !== user.id && canSeeProject(project, u.id)) mentioned.add(u.id);
    }
    notify([...mentioned], 'mention', issue, user.id, { commentId: c.id });
    notify(issue.watchers.filter(w => !mentioned.has(w)), 'comment', issue, user.id, { commentId: c.id });
    emitWebhook(project.id, 'comment.created', { issue: serializeIssue(issue), comment: serializeComment(c), actorId: user.id });
    return [201, serializeComment(c)];
  });
  function findComment(id, user, issueKey) {
    const c = db.comments.find(x => x.id === id);
    if (!c) throw notFound('comment not found');
    const issue = issueById(c.issueId);
    if (issueKey) { const i2 = issueByRef(issueKey); if (!i2 || i2.id !== c.issueId) throw notFound('comment not found'); }
    const { project, role } = requireProject(issue.projectId, user);
    return { c, issue, project, role };
  }
  const editComment = ({ user, params, body }) => {
    const { c } = findComment(params.id, user, params.key);
    if (c.authorId !== user.id) throw forbidden('only the author can edit a comment');
    const text = body.body ?? body.text;
    if (typeof text !== 'string' || !text.trim()) throw badRequest('body is required');
    if (text !== c.body) { c.body = text; c.edited = true; c.updatedAt = nowIso(); }
    else c.edited = true;
    return [200, serializeComment(c)];
  };
  const removeComment = ({ user, params }) => {
    const { c, role } = findComment(params.id, user, params.key);
    if (c.authorId !== user.id && role !== 'lead') throw forbidden('only the author can delete a comment');
    db.comments = db.comments.filter(x => x !== c);
    return [204, null];
  };
  route('GET', '/api/comments/:id', ({ user, params }) => [200, serializeComment(findComment(params.id, user).c)]);
  route('PATCH', '/api/comments/:id', editComment);
  route('DELETE', '/api/comments/:id', removeComment);
  route('PATCH', '/api/issues/:key/comments/:id', editComment);
  route('DELETE', '/api/issues/:key/comments/:id', removeComment);

  // ===== Notifications =====
  const serializeNotif = ({ userId, ...n }) => n;
  route('GET', '/api/notifications', ({ user, query }) => {
    let list = db.notifications.filter(n => n.userId === user.id);
    const unread = query.get('unread');
    if (unread === 'true' || unread === '1') list = list.filter(n => !n.read);
    list = list.map((n, i) => [n, i]).sort((a, b) => (b[0].at < a[0].at ? -1 : b[0].at > a[0].at ? 1 : b[1] - a[1])).map(x => x[0]);
    return [200, list.map(serializeNotif)];
  });
  route('POST', '/api/notifications/read', ({ user, body }) => {
    let count = 0;
    if (body.all === true) {
      for (const n of db.notifications) if (n.userId === user.id && !n.read) { n.read = true; count++; }
    } else if (Array.isArray(body.ids)) {
      const ids = new Set(body.ids.map(String));
      for (const n of db.notifications) if (n.userId === user.id && ids.has(n.id) && !n.read) { n.read = true; count++; }
    } else throw badRequest('provide ids or all: true');
    return [200, { updated: count }];
  });

  // ===== Sprints =====
  function validateSprintDates(start, end) {
    if (start !== undefined && start !== null && !isValidDateish(start)) throw badRequest('startDate must be a date');
    if (end !== undefined && end !== null && !isValidDateish(end)) throw badRequest('endDate must be a date');
    if (start && end && new Date(end) < new Date(start)) throw badRequest('endDate must be on or after startDate');
  }
  route('POST', '/api/projects/:id/sprints', ({ user, params, body }) => {
    const { project } = requireProject(params.id, user, 'developer');
    const { name, startDate, endDate, goal } = body;
    if (typeof name !== 'string' || !name.trim()) throw badRequest('name is required');
    validateSprintDates(startDate, endDate);
    const s = { id: newId(), projectId: project.id, name: name.trim(), goal: typeof goal === 'string' ? goal : '', state: 'planned', startDate: startDate ?? null, endDate: endDate ?? null, createdAt: nowIso(), startedAt: null, completedAt: null };
    db.sprints.push(s);
    return [201, serializeSprint(s)];
  });
  route('GET', '/api/projects/:id/sprints', ({ user, params }) => {
    const { project } = requireProject(params.id, user);
    return [200, db.sprints.filter(s => s.projectId === project.id).map(serializeSprint)];
  });
  function requireSprint(id, user, minRole = 'viewer') {
    const s = sprintById(id);
    if (!s) throw notFound('sprint not found');
    const { project } = requireProject(s.projectId, user, minRole);
    return { sprint: s, project };
  }
  route('GET', '/api/sprints/:id', ({ user, params }) => {
    const { sprint } = requireSprint(params.id, user);
    const issues = db.issues.filter(i => i.sprintId === sprint.id).map(i => i.key);
    return [200, { ...serializeSprint(sprint), issues }];
  });
  route('PATCH', '/api/sprints/:id', ({ user, params, body }) => {
    const { sprint } = requireSprint(params.id, user, 'developer');
    if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) throw badRequest('invalid name');
    const start = body.startDate !== undefined ? body.startDate : sprint.startDate;
    const end = body.endDate !== undefined ? body.endDate : sprint.endDate;
    validateSprintDates(start, end);
    if (body.name !== undefined) sprint.name = body.name.trim();
    if (body.goal !== undefined) sprint.goal = String(body.goal);
    sprint.startDate = start ?? null; sprint.endDate = end ?? null;
    return [200, serializeSprint(sprint)];
  });
  route('DELETE', '/api/sprints/:id', ({ user, params }) => {
    const { sprint } = requireSprint(params.id, user, 'developer');
    if (sprint.state === 'active') throw conflict('cannot delete an active sprint');
    for (const i of db.issues) if (i.sprintId === sprint.id) i.sprintId = null;
    db.sprints = db.sprints.filter(s => s !== sprint);
    return [204, null];
  });
  route('POST', '/api/sprints/:id/start', ({ user, params, body }) => {
    const { sprint, project } = requireSprint(params.id, user, 'developer');
    if (sprint.state !== 'planned') throw conflict(`sprint is ${sprint.state}`, 'invalid_state');
    if (db.sprints.some(s => s.projectId === project.id && s.state === 'active')) throw conflict('project already has an active sprint', 'active_sprint_exists');
    if (body && (body.startDate !== undefined || body.endDate !== undefined)) {
      validateSprintDates(body.startDate ?? sprint.startDate, body.endDate ?? sprint.endDate);
      if (body.startDate !== undefined) sprint.startDate = body.startDate;
      if (body.endDate !== undefined) sprint.endDate = body.endDate;
    }
    sprint.state = 'active';
    sprint.startedAt = nowIso();
    if (!sprint.startDate) sprint.startDate = dayOf(now());
    const issues = db.issues.filter(i => i.sprintId === sprint.id);
    sprint.committedIssueIds = issues.map(i => i.id);
    sprint.committedPoints = issues.reduce((a, i) => a + (typeof i.storyPoints === 'number' ? i.storyPoints : 0), 0);
    return [200, serializeSprint(sprint)];
  });
  route('POST', '/api/sprints/:id/complete', ({ user, params, body }) => {
    const { sprint, project } = requireSprint(params.id, user, 'developer');
    if (sprint.state !== 'active') throw conflict(`sprint is ${sprint.state}`, 'invalid_state');
    const carry = body.carryOverTo ?? 'backlog';
    let target = null;
    if (carry !== 'backlog' && carry !== null) {
      target = sprintById(String(carry));
      if (!target || target.projectId !== project.id || target.id === sprint.id) throw badRequest('carryOverTo must be a sprint in this project or "backlog"');
      if (target.state === 'completed') throw badRequest('cannot carry over to a completed sprint');
    }
    const at = nowIso();
    const issues = db.issues.filter(i => i.sprintId === sprint.id);
    const done = issues.filter(i => isCompletedStatus(project, i.status));
    const undone = issues.filter(i => !isCompletedStatus(project, i.status));
    sprint.completedIssueIds = done.map(i => i.id);
    sprint.completedPoints = done.reduce((a, i) => a + (typeof i.storyPoints === 'number' ? i.storyPoints : 0), 0);
    sprint.carriedOverIds = undone.map(i => i.id);
    sprint.state = 'completed';
    sprint.completedAt = at;
    sprint.carriedOverTo = target ? target.id : 'backlog';
    for (const i of undone) {
      const to = target ? target.id : null;
      recordHistory(i, 'sprintId', i.sprintId, to, user.id, at);
      i.sprintId = to;
      i.updatedAt = at;
    }
    return [200, { ...serializeSprint(sprint), completedIssues: done.map(i => i.key), carriedOver: undone.map(i => i.key) }];
  });
  route('GET', '/api/sprints/:id/report', ({ user, params }) => {
    const { sprint } = requireSprint(params.id, user);
    return [200, sprintReport(sprint)];
  });

  // ===== Stats =====
  route('GET', '/api/projects/:id/stats', ({ user, params }) => {
    const { project } = requireProject(params.id, user);
    const issues = db.issues.filter(i => i.projectId === project.id);
    const byStatus = {}; for (const s of project.workflow.statuses) byStatus[s.name] = 0;
    const byType = {}; for (const t of TYPES) byType[t] = 0;
    const byAssignee = {};
    const byPriority = {}; for (const p of PRIORITIES) byPriority[p] = 0;
    const cycles = [];
    for (const i of issues) {
      byStatus[i.status] = (byStatus[i.status] || 0) + 1;
      byType[i.type] = (byType[i.type] || 0) + 1;
      byPriority[i.priority] = (byPriority[i.priority] || 0) + 1;
      const ak = i.assigneeId || 'unassigned';
      byAssignee[ak] = (byAssignee[ak] || 0) + 1;
      if (i.resolvedAt) {
        let start = null;
        const startedNames = new Set(project.workflow.statuses.filter(s => s.category === 'started').map(s => s.name));
        if (i._initial && startedNames.has(i._initial.status)) start = i.createdAt;
        if (!start) {
          const h = db.history.find(h => h.issueId === i.id && h.field === 'status' && startedNames.has(h.to));
          if (h) start = h.at;
        }
        if (start) {
          const hrs = (new Date(i.resolvedAt) - new Date(start)) / 3600000;
          if (hrs >= 0) cycles.push(hrs);
        }
      }
    }
    const avg = cycles.length ? cycles.reduce((a, b) => a + b, 0) / cycles.length : null;
    return [200, {
      total: issues.length, byStatus, byType, byPriority, byAssignee,
      averageCycleTimeHours: avg, avgCycleTimeHours: avg, cycleTimeSamples: cycles.length,
      open: issues.filter(i => !i.resolvedAt).length, resolved: issues.filter(i => i.resolvedAt).length,
    }];
  });

  // ===== Search =====
  route('GET', '/api/search', ({ user, query }) => {
    const q = query.get('q') ?? '';
    const sort = query.get('sort') || 'updated';
    if (!['updated', 'created', 'priority'].includes(sort)) throw badRequest('sort must be updated, created or priority', 'invalid_query');
    let projects = db.projects.filter(p => canSeeProject(p, user.id));
    const pParam = query.get('project');
    if (pParam) {
      const p = db.projects.find(x => x.id === pParam) || db.projects.find(x => x.key === pParam.toUpperCase());
      if (!p) throw notFound('project not found');
      if (!canSeeProject(p, user.id)) throw forbidden('no access to this project');
      projects = [p];
    }
    let pred;
    try {
      pred = compile(q, { userId: user.id, findUserByName: userByName, sprintById, projectOf: i => projectById(i.projectId), issueById });
    } catch (e) {
      if (e instanceof QueryError) throw badRequest(e.message, 'invalid_query');
      throw e;
    }
    const pids = new Set(projects.map(p => p.id));
    let results = db.issues.filter(i => pids.has(i.projectId) && pred(i));
    const byNum = (a, b) => (a.projectId === b.projectId ? b.number - a.number : (Number(b.id) - Number(a.id)));
    if (sort === 'updated') results.sort((a, b) => (a.updatedAt === b.updatedAt ? byNum(a, b) : a.updatedAt < b.updatedAt ? 1 : -1));
    else if (sort === 'created') results.sort((a, b) => (a.createdAt === b.createdAt ? byNum(a, b) : a.createdAt < b.createdAt ? 1 : -1));
    else results.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : byNum(a, b)));
    const limit = Math.min(Math.max(parseInt(query.get('limit') || '1000', 10) || 1000, 1), 5000);
    return [200, results.slice(0, limit).map(serializeIssue)];
  });

  // ===== CSV =====
  route('GET', '/api/projects/:id/export.csv', ({ user, params }) => {
    const { project } = requireProject(params.id, user);
    return { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${project.key}.csv"` }, text: exportCsv(project) };
  });
  route('POST', '/api/projects/:id/import.csv', ({ user, params, rawBody, req }) => {
    const { project } = requireProject(params.id, user, 'developer');
    let text = rawBody;
    const ct = String(req.headers['content-type'] || '');
    if (ct.includes('application/json')) {
      try { const j = JSON.parse(rawBody || '{}'); text = typeof j.csv === 'string' ? j.csv : typeof j === 'string' ? j : ''; } catch { throw badRequest('invalid JSON body', 'invalid_json'); }
    }
    if (!text || !text.trim()) throw badRequest('CSV body is required', 'invalid_csv');
    const result = importCsv(project, text, user);
    return [200, result];
  }, { raw: true });

  // ===== Webhooks =====
  const serializeHook = h => { const { secret, ...pub } = h; return { ...pub, hasSecret: !!secret }; };
  route('POST', '/api/projects/:id/webhooks', ({ user, params, body }) => {
    const { project } = requireProject(params.id, user, 'lead');
    const { url, events, secret } = body;
    let u;
    try { u = new URL(url); } catch { throw badRequest('url must be a valid http(s) URL'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw badRequest('url must be http or https');
    if (!Array.isArray(events) || !events.length || events.some(e => !WEBHOOK_EVENTS.includes(e))) throw badRequest(`events must be a non-empty subset of ${WEBHOOK_EVENTS.join(', ')}`);
    if (secret !== undefined && secret !== null && typeof secret !== 'string') throw badRequest('secret must be a string');
    const h = { id: newId(), projectId: project.id, url, events: [...new Set(events)], secret: secret || '', active: true, createdAt: nowIso(), createdBy: user.id };
    db.webhooks.push(h);
    audit(project.workspaceId, 'webhook.created', user.id, { projectId: project.id, webhookId: h.id, url, events: h.events });
    return [201, serializeHook(h)];
  });
  route('GET', '/api/projects/:id/webhooks', ({ user, params }) => {
    const { project } = requireProject(params.id, user, 'lead');
    return [200, db.webhooks.filter(h => h.projectId === project.id).map(serializeHook)];
  });
  function requireHook(id, user) {
    const h = db.webhooks.find(x => x.id === id);
    if (!h) throw notFound('webhook not found');
    const { project } = requireProject(h.projectId, user, 'lead');
    return { h, project };
  }
  route('GET', '/api/webhooks/:id', ({ user, params }) => [200, serializeHook(requireHook(params.id, user).h)]);
  route('DELETE', '/api/webhooks/:id', ({ user, params }) => {
    const { h, project } = requireHook(params.id, user);
    db.webhooks = db.webhooks.filter(x => x !== h);
    audit(project.workspaceId, 'webhook.deleted', user.id, { projectId: project.id, webhookId: h.id });
    return [204, null];
  });
  route('GET', '/api/webhooks/:id/deliveries', ({ user, params }) => {
    const { h } = requireHook(params.id, user);
    return [200, db.deliveries.filter(d => d.webhookId === h.id).map(({ payload, ...d }) => d)];
  });

  // ---------- request handling ----------
  function authenticate(req) {
    const h = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(h.trim());
    if (!m) return null;
    const token = m[1].trim();
    const hash = sha256(token);
    const s = db.sessions.find(x => x.hash === hash);
    if (s) { const u = userById(s.userId); if (u) return { user: u, tokenHash: hash, authKind: 'session' }; }
    const t = db.apiTokens.find(x => x.hash === hash);
    if (t) { const u = userById(t.userId); if (u) { t.lastUsedAt = nowIso(); return { user: u, tokenHash: hash, authKind: 'api' }; } }
    return null;
  }

  function send(res, status, body, headers = {}) {
    if (status === 204 || body === null || body === undefined) {
      res.writeHead(status, headers); res.end(); return;
    }
    const data = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data), ...headers });
    res.end(data);
  }
  const sendError = (res, status, code, message) => send(res, status, { error: code, message });

  function readBody(req, limit = 10 * 1024 * 1024) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      req.on('data', c => { size += c.length; if (size > limit) { reject(new HttpError(413, 'payload_too_large', 'request body too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon' };
  function serveStatic(res, rel, method) {
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendError(res, 404, 'not_found', 'not found');
    fs.readFile(file, (err, data) => {
      if (err) return sendError(res, 404, 'not_found', 'not found');
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-length': data.length, 'cache-control': 'no-cache' });
      res.end(method === 'HEAD' ? undefined : data);
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const pathname = url.pathname;
    const method = req.method.toUpperCase();
    if (!pathname.startsWith('/api/') && pathname !== '/api') {
      if (method !== 'GET' && method !== 'HEAD') return sendError(res, 405, 'method_not_allowed', 'method not allowed');
      if (pathname.startsWith('/static/')) return serveStatic(res, decodeURIComponent(pathname.slice('/static/'.length)), method);
      return serveStatic(res, 'index.html', method);
    }
    let matched = null; let methodMismatch = false;
    for (const r of routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      if (r.method !== method) { methodMismatch = true; continue; }
      const params = {};
      r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
      matched = { r, params };
      break;
    }
    if (!matched) {
      if (methodMismatch) return sendError(res, 405, 'method_not_allowed', 'method not allowed');
      return sendError(res, 404, 'not_found', 'route not found');
    }
    const { r, params } = matched;
    const rawBody = await readBody(req);
    let body = {};
    if (!r.raw && rawBody.trim()) {
      try { body = JSON.parse(rawBody); } catch { throw badRequest('invalid JSON body', 'invalid_json'); }
      if (!isPlainObject(body)) throw badRequest('JSON body must be an object', 'invalid_json');
    }
    let auth = null;
    if (r.auth) {
      auth = authenticate(req);
      if (!auth) throw new HttpError(401, 'unauthorized', 'authentication required');
    }
    const ctx = { req, res, params, query: url.searchParams, body, rawBody, user: auth?.user, tokenHash: auth?.tokenHash, authKind: auth?.authKind };
    let result;
    try {
      result = r.handler(ctx);
    } finally {
      if (method !== 'GET' && method !== 'HEAD') save();
    }
    if (Array.isArray(result)) return send(res, result[0], result[1]);
    if (result && result.text !== undefined) {
      res.writeHead(result.status, { ...result.headers, 'content-length': Buffer.byteLength(result.text) });
      return res.end(result.text);
    }
    return send(res, 200, result);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
      if (err instanceof HttpError) return sendError(res, err.status, err.code, err.message);
      console.error(err);
      sendError(res, 500, 'internal_error', 'internal server error');
    });
  });
  server.on('close', () => { try { save(); } catch { /* ignore */ } });
  server.pendingDeliveries = pendingDeliveries;
  return server;
}
