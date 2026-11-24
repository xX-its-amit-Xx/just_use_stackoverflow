import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { toCsv, parseCsv } from './csv.js';
import { parseQuery, matches, QueryError } from './search.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dirname, 'static');

const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'];
const PRIO_RANK = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
const CATEGORIES = ['backlog', 'unstarted', 'started', 'completed'];
const WS_ROLES = ['admin', 'member', 'guest'];
const PROJ_ROLES = ['lead', 'developer', 'viewer'];
const ROLE_RANK = { viewer: 1, developer: 2, lead: 3 };
const LINK_TYPES = ['blocks', 'relates', 'duplicates'];
const INVERSE = { blocks: 'blocked_by', relates: 'relates', duplicates: 'duplicated_by' };
const WEBHOOK_EVENTS = ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'];
const KEY_RE = /^[A-Z]{2,10}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISSUE_FIELDS = ['type', 'title', 'description', 'status', 'priority', 'assigneeId', 'labels', 'storyPoints', 'parentId', 'epicId', 'sprintId', 'dueDate'];
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS = 5;

class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}
const bad = (msg, code = 'validation_error') => new HttpError(400, code, msg);
const notFound = (what = 'resource') => new HttpError(404, 'not_found', `${what} not found`);
const forbidden = (msg = 'forbidden') => new HttpError(403, 'forbidden', msg);
const conflict = (code, msg) => new HttpError(409, code, msg || code);

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pw, salt, 32).toString('hex') };
}
function verifyPassword(pw, user) {
  const h = crypto.scryptSync(pw, user.salt, 32);
  const stored = Buffer.from(user.passwordHash, 'hex');
  return stored.length === h.length && crypto.timingSafeEqual(h, stored);
}

function emptyDb() {
  return {
    seq: 0, users: [], sessions: [], apiTokens: [], workspaces: [], wsMembers: [], projects: [], projMembers: [],
    issues: [], history: [], links: [], comments: [], notifications: [], sprints: [], webhooks: [], deliveries: [], audit: [],
  };
}

export function createServer({ dataFile, clock } = {}) {
  const now = () => (clock ? new Date(clock()) : new Date());
  const nowIso = () => now().toISOString();
  let db = emptyDb();
  if (dataFile && fs.existsSync(dataFile)) {
    try { db = { ...emptyDb(), ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) }; } catch { db = emptyDb(); }
  }
  const loginFailures = new Map();
  const newId = () => { db.seq++; return db.seq.toString(36) + crypto.randomBytes(4).toString('hex'); };
  const nextSeq = () => ++db.seq;
  function save() {
    if (!dataFile) return;
    try {
      fs.mkdirSync(path.dirname(path.resolve(dataFile)), { recursive: true });
      const tmp = dataFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(db));
      fs.renameSync(tmp, dataFile);
    } catch (e) { /* ignore persistence errors */ }
  }

  // ---------- lookups ----------
  const userById = id => db.users.find(u => u.id === id);
  const userByName = n => db.users.find(u => u.username.toLowerCase() === String(n).toLowerCase());
  const pubUser = u => u && ({ id: u.id, username: u.username, displayName: u.displayName });
  const wsMember = (wsId, userId) => db.wsMembers.find(m => m.workspaceId === wsId && m.userId === userId);
  const projMember = (pId, userId) => db.projMembers.find(m => m.projectId === pId && m.userId === userId);
  const projectById = id => db.projects.find(p => p.id === id);
  const issueById = id => db.issues.find(i => i.id === id);
  const issueByKey = k => db.issues.find(i => i.key === String(k).toUpperCase());
  const sprintById = id => db.sprints.find(s => s.id === id);

  function projectRole(project, userId) {
    const wm = wsMember(project.workspaceId, userId);
    if (!wm) return null;
    if (wm.role === 'admin') return 'lead';
    const pm = projMember(project.id, userId);
    if (pm) return pm.role;
    if (wm.role === 'member') return 'developer';
    return null;
  }
  const canSee = (project, userId) => !!projectRole(project, userId);

  function getWorkspace(id, user, minAdmin = false) {
    const ws = db.workspaces.find(w => w.id === id);
    if (!ws) throw notFound('workspace');
    const m = wsMember(ws.id, user.id);
    if (!m) throw forbidden('not a workspace member');
    if (minAdmin && m.role !== 'admin') throw forbidden('workspace admin required');
    return { ws, role: m.role };
  }
  function getProject(id, user, minRole = 'viewer') {
    const p = projectById(id) || db.projects.find(x => x.key === String(id).toUpperCase());
    if (!p) throw notFound('project');
    const role = projectRole(p, user.id);
    if (!role) throw forbidden('no access to project');
    if (ROLE_RANK[role] < ROLE_RANK[minRole]) throw forbidden(`${minRole} role required`);
    return { project: p, role };
  }
  function getIssue(key, user, minRole = 'viewer') {
    const issue = issueByKey(key) || issueById(key);
    if (!issue) throw notFound('issue');
    const { project, role } = getProject(issue.projectId, user, 'viewer');
    if (ROLE_RANK[role] < ROLE_RANK[minRole]) throw forbidden(`${minRole} role required`);
    return { issue, project, role };
  }
  function getSprint(id, user, minRole = 'viewer') {
    const s = sprintById(id);
    if (!s) throw notFound('sprint');
    const { project, role } = getProject(s.projectId, user, minRole);
    return { sprint: s, project, role };
  }

  const statusDef = (project, name) => project.workflow.statuses.find(s => s.name === name);
  const categoryOf = (project, name) => statusDef(project, name)?.category || null;
  const issueCategory = issue => { const p = projectById(issue.projectId); return p ? categoryOf(p, issue.status) : null; };

  function audit(workspaceId, actorId, action, details = {}) {
    db.audit.push({ id: newId(), seq: nextSeq(), workspaceId, actorId, action, details, at: nowIso() });
  }
  function auditUserWorkspaces(userId, action, details) {
    for (const m of db.wsMembers.filter(m => m.userId === userId)) audit(m.workspaceId, userId, action, details);
  }

  // ---------- notifications ----------
  function notify(userId, type, issue, actorId, extra = {}) {
    if (!userId || userId === actorId) return;
    const p = projectById(issue.projectId);
    if (!p || !canSee(p, userId)) return;
    db.notifications.push({ id: newId(), seq: nextSeq(), userId, type, issueKey: issue.key, actorId, at: nowIso(), read: false, ...extra });
  }
  function addWatcher(issue, userId) {
    if (userId && !issue.watchers.includes(userId)) issue.watchers.push(userId);
  }

  // ---------- webhooks ----------
  function fireWebhooks(project, event, issue, actorId, extra = {}) {
    const hooks = db.webhooks.filter(h => h.projectId === project.id && h.events.includes(event));
    for (const hook of hooks) {
      const payload = { event, issue: issue ? serializeIssue(issue) : null, actorId, at: nowIso(), ...extra };
      const body = JSON.stringify(payload);
      const sig = 'sha256=' + crypto.createHmac('sha256', hook.secret || '').update(body).digest('hex');
      const d = { id: newId(), seq: nextSeq(), webhookId: hook.id, event, status: null, attempts: 0, lastError: null, success: false, createdAt: nowIso() };
      db.deliveries.push(d);
      (async () => {
        for (let attempt = 1; attempt <= 3; attempt++) {
          d.attempts = attempt;
          try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 5000);
            const res = await fetch(hook.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pm-signature': sig, 'x-pm-event': event, 'x-pm-delivery': d.id }, body, signal: ctrl.signal });
            clearTimeout(timer);
            try { await res.arrayBuffer(); } catch {}
            d.status = res.status;
            if (res.ok) { d.success = true; d.lastError = null; break; }
            d.lastError = `HTTP ${res.status}`;
          } catch (e) {
            d.lastError = String(e?.cause?.message || e?.message || e);
          }
          save();
          if (attempt < 3) await new Promise(r => setTimeout(r, 50 * attempt));
        }
        d.completedAt = nowIso();
        save();
      })();
    }
  }

  // ---------- serialization ----------
  function serializeIssue(i) {
    const { seq, number, ...rest } = i;
    return { ...rest };
  }
  function issueDetail(i) {
    const out = serializeIssue(i);
    out.children = db.issues.filter(c => c.parentId === i.id).sort((a, b) => a.number - b.number).map(c => c.key);
    out.links = linksOf(i);
    if (i.type === 'epic') {
      const kids = db.issues.filter(c => c.epicId === i.id);
      const done = kids.filter(c => issueCategory(c) === 'completed');
      const pts = arr => arr.reduce((s, c) => s + (typeof c.storyPoints === 'number' ? c.storyPoints : 0), 0);
      out.progress = { total: kids.length, done: done.length, points_total: pts(kids), points_done: pts(done) };
    }
    return out;
  }
  function linksOf(i) {
    const out = [];
    for (const l of db.links) {
      if (l.sourceId === i.id) { const t = issueById(l.targetId); if (t) out.push({ id: l.id, type: l.type, issueKey: t.key, target: t.key, direction: 'outward' }); }
      else if (l.targetId === i.id) { const s = issueById(l.sourceId); if (s) out.push({ id: l.id, type: INVERSE[l.type], issueKey: s.key, target: s.key, direction: 'inward' }); }
    }
    return out;
  }
  const pubProject = p => ({ id: p.id, workspaceId: p.workspaceId, name: p.name, key: p.key, workflow: p.workflow, createdAt: p.createdAt, updatedAt: p.updatedAt });
  const pubSprint = s => ({ ...s });
  const pubComment = c => ({ ...c });
  const pubNotif = n => ({ id: n.id, type: n.type, issueKey: n.issueKey, actorId: n.actorId, at: n.at, read: n.read, ...(n.commentId ? { commentId: n.commentId } : {}) });
  const pubHook = h => ({ id: h.id, projectId: h.projectId, url: h.url, events: h.events, createdAt: h.createdAt, hasSecret: !!h.secret });
  const pubDelivery = d => ({ id: d.id, webhookId: d.webhookId, event: d.event, status: d.status, attempts: d.attempts, lastError: d.lastError, success: d.success, createdAt: d.createdAt });

  // ---------- validation helpers ----------
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  function reqString(body, f, { optional = false, max = 10000 } = {}) {
    const v = body[f];
    if (v === undefined || v === null) { if (optional) return undefined; throw bad(`${f} is required`); }
    if (typeof v !== 'string') throw bad(`${f} must be a string`);
    if (!optional && !v.trim()) throw bad(`${f} must not be empty`);
    if (v.length > max) throw bad(`${f} too long`);
    return v;
  }
  function validDate(v) {
    if (typeof v !== 'string') return false;
    const d = v.slice(0, 10);
    if (!DATE_RE.test(d)) return false;
    const t = new Date(d + 'T00:00:00Z');
    return !isNaN(t) && t.toISOString().slice(0, 10) === d && (v.length === 10 || !isNaN(Date.parse(v)));
  }
  function resolveIssueRef(ref) {
    if (ref === null || ref === undefined || ref === '') return null;
    const i = issueById(ref) || issueByKey(ref);
    return i || undefined;
  }

  // Normalize & validate a candidate issue field set (full state) for a project.
  function validateIssueState(project, st, selfId) {
    if (!TYPES.includes(st.type)) throw bad('invalid type');
    if (typeof st.title !== 'string' || !st.title.trim()) throw bad('title is required');
    if (st.title.length > 500) throw bad('title too long');
    if (st.description !== null && typeof st.description !== 'string') throw bad('description must be a string');
    if (!PRIORITIES.includes(st.priority)) throw bad('invalid priority');
    if (!Array.isArray(st.labels) || st.labels.some(l => typeof l !== 'string' || !l.trim())) throw bad('labels must be an array of strings');
    st.labels = [...new Set(st.labels.map(l => l.trim()))];
    if (st.storyPoints !== null && (typeof st.storyPoints !== 'number' || !isFinite(st.storyPoints) || st.storyPoints < 0)) throw bad('storyPoints must be a non-negative number');
    if (st.dueDate !== null && !validDate(st.dueDate)) throw bad('dueDate must be YYYY-MM-DD');
    if (st.dueDate) st.dueDate = st.dueDate.slice(0, 10);
    if (st.assigneeId !== null) {
      const u = userById(st.assigneeId);
      if (!u) throw bad('assignee not found');
      if (!canSee(project, u.id)) throw bad('assignee has no access to project');
    }
    if (st.sprintId !== null) {
      const s = sprintById(st.sprintId);
      if (!s || s.projectId !== project.id) throw bad('sprint not found in project');
    }
    if (st.parentId !== null) {
      if (st.type === 'epic') throw bad('epics cannot have a parent');
      const p = issueById(st.parentId);
      if (!p) throw bad('parent not found');
      if (p.projectId !== project.id) throw bad('parent must be in the same project');
      if (p.type === 'subtask') throw bad('parent cannot be a subtask');
      if (p.type === 'epic' && st.type === 'subtask') { /* allowed? subtasks under epics are unusual but permit */ }
      if (selfId) {
        let cur = p; const seen = new Set();
        while (cur) { if (cur.id === selfId) throw bad('parent cycle'); if (seen.has(cur.id)) break; seen.add(cur.id); cur = cur.parentId ? issueById(cur.parentId) : null; }
      }
    } else if (st.type === 'subtask') throw bad('subtasks require a parentId');
    if (selfId && st.type === 'subtask' && db.issues.some(c => c.parentId === selfId)) throw bad('an issue with subtasks cannot become a subtask');
    if (st.epicId !== null) {
      if (st.type === 'epic') throw bad('epics cannot belong to an epic');
      const e = issueById(st.epicId);
      if (!e || e.type !== 'epic') throw bad('epicId must reference an epic');
      if (e.projectId !== project.id) throw bad('epic must be in the same project');
    }
    if (selfId && st.type !== 'epic' && db.issues.some(c => c.epicId === selfId)) throw bad('issue has epic children and must remain an epic');
    if (!statusDef(project, st.status)) throw bad('unknown status');
  }

  function readIssueInput(body, st) {
    for (const f of ISSUE_FIELDS) {
      if (!(f in body)) continue;
      let v = body[f];
      if (f === 'parentId' || f === 'epicId') {
        if (v === null || v === '') v = null;
        else { const r = resolveIssueRef(v); if (!r) throw bad(`${f} not found`); v = r.id; }
      } else if (['assigneeId', 'sprintId', 'dueDate', 'storyPoints', 'description'].includes(f)) {
        if (v === '' || v === undefined) v = null;
      }
      if (f === 'labels' && v === null) v = [];
      if (f === 'type' || f === 'priority') v = typeof v === 'string' ? v.toLowerCase() : v;
      st[f] = v;
    }
    if ('assignee' in body && !('assigneeId' in body)) {
      const a = body.assignee;
      if (a === null || a === '') st.assigneeId = null;
      else { const u = userByName(a) || userById(a); if (!u) throw bad('assignee not found'); st.assigneeId = u.id; }
    }
    if ('parent' in body && !('parentId' in body)) { const r = resolveIssueRef(body.parent); if (r === undefined) throw bad('parent not found'); st.parentId = r ? r.id : null; }
    if ('epic' in body && !('epicId' in body)) { const r = resolveIssueRef(body.epic); if (r === undefined) throw bad('epic not found'); st.epicId = r ? r.id : null; }
  }

  function initialStatus(project) {
    const s = project.workflow.statuses.find(s => s.category === 'unstarted') || project.workflow.statuses[0];
    return s.name;
  }

  function createIssue(project, user, body) {
    if (!isObj(body)) throw bad('body must be an object');
    const st = { type: 'task', title: undefined, description: null, status: initialStatus(project), priority: 'none', assigneeId: null, labels: [], storyPoints: null, parentId: null, epicId: null, sprintId: null, dueDate: null };
    readIssueInput(body, st);
    if (st.status === undefined || st.status === null) st.status = initialStatus(project);
    validateIssueState(project, st, null);
    const n = (project.issueCounter || 0) + 1;
    project.issueCounter = n;
    const t = nowIso();
    const issue = {
      id: newId(), key: `${project.key}-${n}`, number: n, projectId: project.id, ...st,
      reporterId: user.id, watchers: [], createdAt: t, updatedAt: t,
      resolvedAt: categoryOf(project, st.status) === 'completed' ? t : null,
    };
    addWatcher(issue, user.id); addWatcher(issue, issue.assigneeId);
    db.issues.push(issue);
    if (issue.assigneeId) notify(issue.assigneeId, 'assigned', issue, user.id);
    fireWebhooks(project, 'issue.created', issue, user.id);
    return issue;
  }

  function recordHistory(issue, field, from, to, actorId) {
    db.history.push({ id: newId(), seq: nextSeq(), issueId: issue.id, field, from: from === undefined ? null : from, to: to === undefined ? null : to, actorId, at: nowIso() });
  }

  function isBlocked(issue) {
    return db.links.some(l => l.type === 'blocks' && l.targetId === issue.id && (() => { const s = issueById(l.sourceId); return s && issueCategory(s) !== 'completed'; })());
  }

  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  function updateIssue(issue, project, user, body, { skipWebhook = false } = {}) {
    if (!isObj(body)) throw bad('body must be an object');
    const st = {}; for (const f of ISSUE_FIELDS) st[f] = Array.isArray(issue[f]) ? [...issue[f]] : issue[f];
    readIssueInput(body, st);
    validateIssueState(project, st, issue.id);
    const changed = ISSUE_FIELDS.filter(f => !same(st[f], issue[f]));
    if (changed.includes('status')) {
      const ok = project.workflow.transitions.some(([a, b]) => a === issue.status && b === st.status);
      if (!ok) throw conflict('invalid_transition', `cannot transition from ${issue.status} to ${st.status}`);
      if (categoryOf(project, st.status) === 'completed' && isBlocked(issue)) throw conflict('blocked', 'issue is blocked by an unresolved issue');
    }
    if (!changed.length) return issue;
    const prevStatus = issue.status, prevAssignee = issue.assigneeId;
    for (const f of changed) { recordHistory(issue, f, issue[f], st[f], user.id); issue[f] = st[f]; }
    const t = nowIso();
    issue.updatedAt = t;
    if (changed.includes('status')) {
      const wasDone = categoryOf(project, prevStatus) === 'completed';
      const isDone = categoryOf(project, issue.status) === 'completed';
      if (isDone && !wasDone) issue.resolvedAt = t;
      if (!isDone) issue.resolvedAt = null;
    }
    if (changed.includes('assigneeId')) addWatcher(issue, issue.assigneeId);
    if (changed.includes('status')) for (const w of issue.watchers) notify(w, 'status_changed', issue, user.id, { from: prevStatus, to: issue.status });
    if (changed.includes('assigneeId') && issue.assigneeId) for (const w of issue.watchers) notify(w, 'assigned', issue, user.id);
    if (!skipWebhook) fireWebhooks(project, 'issue.updated', issue, user.id, { changes: changed });
    return issue;
  }

  function deleteIssue(issue, project, user) {
    const toDelete = new Set([issue.id]);
    let grew = true;
    while (grew) { grew = false; for (const c of db.issues) if (c.parentId && toDelete.has(c.parentId) && !toDelete.has(c.id)) { toDelete.add(c.id); grew = true; } }
    const removed = db.issues.filter(i => toDelete.has(i.id));
    db.issues = db.issues.filter(i => !toDelete.has(i.id));
    for (const i of db.issues) if (i.epicId && toDelete.has(i.epicId)) { i.epicId = null; }
    db.links = db.links.filter(l => !toDelete.has(l.sourceId) && !toDelete.has(l.targetId));
    db.comments = db.comments.filter(c => !toDelete.has(c.issueId));
    for (const r of removed) fireWebhooks(project, 'issue.deleted', r, user.id);
  }

  // ---------- history reconstruction ----------
  function historyFor(issueId) { return db.history.filter(h => h.issueId === issueId).sort((a, b) => a.seq - b.seq); }
  function valueAt(issue, hist, field, t) {
    for (const h of hist) if (h.field === field && Date.parse(h.at) > t) return h.from;
    return issue[field];
  }
  function stateAt(issue, t) {
    if (Date.parse(issue.createdAt) > t) return null;
    const hist = historyFor(issue.id);
    return { sprintId: valueAt(issue, hist, 'sprintId', t), status: valueAt(issue, hist, 'status', t), storyPoints: valueAt(issue, hist, 'storyPoints', t) };
  }
  const pts = v => (typeof v === 'number' ? v : 0);

  function sprintReport(sprint, project) {
    const nowMs = now().getTime();
    const projIssues = db.issues.filter(i => i.projectId === project.id);
    const isDone = status => categoryOf(project, status) === 'completed';
    const startT = sprint.startedAt ? Date.parse(sprint.startedAt) : null;
    const endT = sprint.completedAt ? Date.parse(sprint.completedAt) : nowMs;
    let committedPoints = 0, completedPoints = 0, completedIssues = 0, carriedOver = 0;
    for (const i of projIssues) {
      if (startT !== null) {
        const s = stateAt(i, startT);
        if (s && s.sprintId === sprint.id) committedPoints += pts(s.storyPoints);
      } else if (i.sprintId === sprint.id) committedPoints += pts(i.storyPoints);
      const e = sprint.completedAt ? stateAt(i, endT) : { sprintId: i.sprintId, status: i.status, storyPoints: i.storyPoints };
      if (e && e.sprintId === sprint.id) {
        if (isDone(e.status)) { completedIssues++; completedPoints += pts(e.storyPoints); }
        else if (sprint.state === 'completed') carriedOver++;
      }
    }
    if (sprint.state === 'completed' && typeof sprint.carriedOverCount === 'number') carriedOver = sprint.carriedOverCount;
    const burndown = [];
    const startDate = sprint.startDate || (sprint.startedAt ? sprint.startedAt.slice(0, 10) : null);
    if (startDate) {
      const today = now().toISOString().slice(0, 10);
      let last = today;
      if (sprint.endDate && sprint.endDate.slice(0, 10) < last) last = sprint.endDate.slice(0, 10);
      let d = new Date(startDate.slice(0, 10) + 'T00:00:00Z');
      let guard = 0;
      while (d.toISOString().slice(0, 10) <= last && guard++ < 3660) {
        const ds = d.toISOString().slice(0, 10);
        let t = Date.parse(ds + 'T23:59:59.999Z');
        if (t > nowMs) t = nowMs;
        let remaining = 0;
        for (const i of projIssues) {
          const s = stateAt(i, t);
          if (s && s.sprintId === sprint.id && !isDone(s.status)) remaining += pts(s.storyPoints);
        }
        burndown.push({ date: ds, remainingPoints: remaining });
        d = new Date(d.getTime() + 86400000);
      }
    }
    return { sprintId: sprint.id, committedPoints, completedPoints, completedIssues, carriedOver, burndown };
  }

  function projectStats(project) {
    const issues = db.issues.filter(i => i.projectId === project.id);
    const byStatus = {}; for (const s of project.workflow.statuses) byStatus[s.name] = 0;
    const byType = {}; for (const t of TYPES) byType[t] = 0;
    const byAssignee = {}; const byPriority = {};
    for (const i of issues) {
      byStatus[i.status] = (byStatus[i.status] || 0) + 1;
      byType[i.type] = (byType[i.type] || 0) + 1;
      const a = i.assigneeId ? (userById(i.assigneeId)?.username || i.assigneeId) : 'unassigned';
      byAssignee[a] = (byAssignee[a] || 0) + 1;
      byPriority[i.priority] = (byPriority[i.priority] || 0) + 1;
    }
    const cycles = [];
    for (const i of issues) {
      if (!i.resolvedAt) continue;
      const hist = historyFor(i.id);
      let startAt = null;
      const firstStatus = hist.find(h => h.field === 'status');
      const initial = firstStatus ? firstStatus.from : i.status;
      if (categoryOf(project, initial) === 'started') startAt = i.createdAt;
      else { const h = hist.find(h => h.field === 'status' && categoryOf(project, h.to) === 'started'); if (h) startAt = h.at; }
      if (startAt) cycles.push((Date.parse(i.resolvedAt) - Date.parse(startAt)) / 3600000);
    }
    const avg = cycles.length ? cycles.reduce((a, b) => a + b, 0) / cycles.length : null;
    return { total: issues.length, byStatus, byType, byAssignee, byPriority, averageCycleTimeHours: avg, avgCycleTimeHours: avg, cycleTimeHours: avg, resolvedCount: issues.filter(i => i.resolvedAt).length };
  }

  // ---------- comments ----------
  function addComment(issue, project, user, body) {
    const text = reqString(body, 'body', { max: 50000 });
    const t = nowIso();
    const c = { id: newId(), issueId: issue.id, issueKey: issue.key, authorId: user.id, body: text, createdAt: t, updatedAt: t, edited: false };
    db.comments.push(c);
    const mentioned = new Set();
    for (const m of text.matchAll(/(^|[^A-Za-z0-9_.-])@([A-Za-z0-9_.-]+)/g)) {
      const name = m[2].replace(/[.-]+$/, '');
      const u = userByName(name) || userByName(m[2]);
      if (u && u.id !== user.id && canSee(project, u.id)) mentioned.add(u.id);
    }
    for (const uid of mentioned) notify(uid, 'mention', issue, user.id, { commentId: c.id });
    for (const w of issue.watchers) if (!mentioned.has(w)) notify(w, 'comment', issue, user.id, { commentId: c.id });
    fireWebhooks(project, 'comment.created', issue, user.id, { comment: pubComment(c) });
    return c;
  }

  // ---------- auth ----------
  function authenticate(req) {
    const h = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return null;
    const hash = sha256(m[1].trim());
    const s = db.sessions.find(s => s.tokenHash === hash);
    if (s) return userById(s.userId) || null;
    const t = db.apiTokens.find(t => t.tokenHash === hash);
    if (t) { t.lastUsedAt = nowIso(); return userById(t.userId) || null; }
    return null;
  }

  // ---------- workflow ----------
  function setWorkflow(project, user, body) {
    if (!isObj(body)) throw bad('body must be an object');
    const { statuses, transitions, remap = {} } = body;
    if (!Array.isArray(statuses) || !statuses.length) throw bad('statuses must be a non-empty array');
    const names = new Set();
    const norm = statuses.map(s => {
      if (!isObj(s) || typeof s.name !== 'string' || !s.name.trim()) throw bad('each status needs a name');
      if (!CATEGORIES.includes(s.category)) throw bad(`invalid category for status ${s.name}`);
      const name = s.name.trim();
      if (names.has(name)) throw bad(`duplicate status ${name}`);
      names.add(name);
      return { name, category: s.category };
    });
    let tr;
    if (transitions === undefined || transitions === null) {
      tr = []; for (const a of norm) for (const b of norm) if (a.name !== b.name) tr.push([a.name, b.name]);
    } else {
      if (!Array.isArray(transitions)) throw bad('transitions must be an array');
      tr = [];
      for (const t of transitions) {
        let pair = t;
        if (isObj(t)) pair = [t.from, t.to];
        if (!Array.isArray(pair) || pair.length !== 2) throw bad('each transition must be [from, to]');
        const [a, b] = pair;
        if (a === '*' || b === '*') {
          for (const x of norm) for (const y of norm) if ((a === '*' || a === x.name) && (b === '*' || b === y.name) && x.name !== y.name) tr.push([x.name, y.name]);
          continue;
        }
        if (!names.has(a) || !names.has(b)) throw bad(`transition references unknown status`);
        if (!tr.some(([x, y]) => x === a && y === b)) tr.push([a, b]);
      }
    }
    if (!isObj(remap)) throw bad('remap must be an object');
    const issues = db.issues.filter(i => i.projectId === project.id);
    for (const i of issues) {
      if (names.has(i.status)) continue;
      const target = remap[i.status];
      if (!target) throw bad(`status "${i.status}" is in use; provide remap`, 'remap_required');
      if (!names.has(target)) throw bad(`remap target "${target}" is not a valid status`);
    }
    const old = project.workflow;
    project.workflow = { statuses: norm, transitions: tr };
    project.updatedAt = nowIso();
    const cat = n => norm.find(s => s.name === n)?.category;
    for (const i of issues) {
      if (names.has(i.status)) {
        // category change may affect resolution
        if (cat(i.status) === 'completed' && !i.resolvedAt) i.resolvedAt = nowIso();
        if (cat(i.status) !== 'completed' && i.resolvedAt) i.resolvedAt = null;
        continue;
      }
      const to = remap[i.status];
      recordHistory(i, 'status', i.status, to, user.id);
      i.status = to; i.updatedAt = nowIso();
      if (cat(to) === 'completed') { if (!i.resolvedAt) i.resolvedAt = nowIso(); } else i.resolvedAt = null;
    }
    audit(project.workspaceId, user.id, 'workflow.updated', { projectId: project.id, statuses: norm.map(s => s.name), previous: old.statuses.map(s => s.name) });
    return project.workflow;
  }

  // ---------- CSV ----------
  const CSV_HEADER = ['key', 'type', 'title', 'status', 'priority', 'assignee', 'labels', 'storyPoints', 'parent', 'epic', 'sprint', 'dueDate', 'createdAt', 'resolvedAt'];
  function exportCsv(project) {
    const rows = [CSV_HEADER];
    const issues = db.issues.filter(i => i.projectId === project.id).sort((a, b) => a.number - b.number);
    for (const i of issues) {
      rows.push([i.key, i.type, i.title, i.status, i.priority, i.assigneeId ? userById(i.assigneeId)?.username || '' : '', (i.labels || []).join(';'),
        i.storyPoints ?? '', i.parentId ? issueById(i.parentId)?.key || '' : '', i.epicId ? issueById(i.epicId)?.key || '' : '',
        i.sprintId ? sprintById(i.sprintId)?.name || i.sprintId : '', i.dueDate || '', i.createdAt, i.resolvedAt || '']);
    }
    return toCsv(rows);
  }
  function importCsv(project, user, text) {
    let records;
    try { records = parseCsv(text); } catch (e) { throw bad('malformed CSV: ' + e.message); }
    // track physical line numbers
    if (!records.length) throw bad('CSV is empty');
    const header = records[0].map(h => h.trim());
    const idx = {}; header.forEach((h, n) => { idx[h] = n; });
    if (idx.title === undefined) throw bad('CSV header must include title');
    const lineNos = computeLineNumbers(text);
    let created = 0; const errors = []; const createdIssues = [];
    for (let r = 1; r < records.length; r++) {
      const rec = records[r];
      const line = lineNos[r] ?? r + 1;
      if (rec.length === 1 && rec[0].trim() === '') continue;
      const get = k => (idx[k] !== undefined ? (rec[idx[k]] ?? '').trim() : '');
      try {
        const body = { title: get('title') };
        if (get('type')) body.type = get('type').toLowerCase();
        if (get('priority')) body.priority = get('priority').toLowerCase();
        if (get('status')) { if (!statusDef(project, get('status'))) throw bad(`unknown status "${get('status')}"`); body.status = get('status'); }
        if (get('assignee')) { const u = userByName(get('assignee')); if (!u) throw bad(`unknown assignee "${get('assignee')}"`); body.assigneeId = u.id; }
        if (get('labels')) body.labels = get('labels').split(';').map(s => s.trim()).filter(Boolean);
        if (get('storyPoints')) { const n = Number(get('storyPoints')); if (!isFinite(n)) throw bad('storyPoints must be a number'); body.storyPoints = n; }
        if (get('parent')) { const p = issueByKey(get('parent')); if (!p) throw bad(`unknown parent "${get('parent')}"`); body.parentId = p.id; }
        if (get('epic')) { const e = issueByKey(get('epic')); if (!e) throw bad(`unknown epic "${get('epic')}"`); body.epicId = e.id; }
        if (get('sprint')) {
          const v = get('sprint');
          const s = db.sprints.find(s => s.projectId === project.id && (s.id === v || s.name === v));
          if (!s) throw bad(`unknown sprint "${v}"`); body.sprintId = s.id;
        }
        if (get('dueDate')) body.dueDate = get('dueDate');
        if (get('description')) body.description = get('description');
        const issue = createIssue(project, user, body);
        created++; createdIssues.push(issue.key);
      } catch (e) {
        if (e instanceof HttpError) errors.push({ line, message: e.message });
        else throw e;
      }
    }
    return { created, errors, keys: createdIssues };
  }
  function computeLineNumbers(text) {
    // starting physical line number of each record
    const out = []; let line = 1; let inQ = false; let start = true;
    for (let i = 0; i < text.length; i++) {
      if (start) { out.push(line); start = false; }
      const c = text[i];
      if (c === '"') inQ = !inQ;
      else if (c === '\n') { line++; if (!inQ) start = true; }
      else if (c === '\r' && text[i + 1] !== '\n') { line++; if (!inQ) start = true; }
    }
    return out;
  }

  // ---------- routing ----------
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, handler, auth: opts.auth !== false, raw: !!opts.raw });
  };

  // auth
  route('POST', '/api/auth/register', ({ body }) => {
    if (!isObj(body)) throw bad('body must be an object');
    const username = reqString(body, 'username', { max: 64 }).trim();
    if (!/^[A-Za-z0-9_.-]{2,64}$/.test(username)) throw bad('invalid username');
    const password = body.password;
    if (typeof password !== 'string' || password.length < 6) throw bad('password must be at least 6 characters');
    if (body.displayName !== undefined && body.displayName !== null && typeof body.displayName !== 'string') throw bad('displayName must be a string');
    if (userByName(username)) throw conflict('username_taken', 'username already exists');
    const { salt, hash } = hashPassword(password);
    const u = { id: newId(), username, displayName: (body.displayName && body.displayName.trim()) || username, salt, passwordHash: hash, createdAt: nowIso() };
    db.users.push(u);
    return [201, { user: pubUser(u) }];
  }, { auth: false });

  route('POST', '/api/auth/login', ({ body }) => {
    if (!isObj(body) || typeof body.username !== 'string' || typeof body.password !== 'string') throw bad('username and password required');
    const key = body.username.toLowerCase();
    const t = now().getTime();
    const fails = (loginFailures.get(key) || []).filter(x => t - x < LOGIN_WINDOW_MS);
    loginFailures.set(key, fails);
    if (fails.length >= MAX_FAILS) throw new HttpError(429, 'rate_limited', 'too many failed login attempts');
    const u = userByName(body.username);
    if (!u || !verifyPassword(body.password, u)) {
      fails.push(t);
      throw new HttpError(401, 'invalid_credentials', 'invalid username or password');
    }
    loginFailures.delete(key);
    const token = crypto.randomBytes(32).toString('hex');
    db.sessions.push({ id: newId(), userId: u.id, tokenHash: sha256(token), createdAt: nowIso() });
    return [200, { token, user: pubUser(u) }];
  }, { auth: false });

  route('POST', '/api/auth/logout', ({ req }) => {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    const hash = sha256(m[1].trim());
    db.sessions = db.sessions.filter(s => s.tokenHash !== hash);
    return [204];
  });
  route('GET', '/api/auth/me', ({ user }) => [200, { user: pubUser(user) }]);
  route('PATCH', '/api/auth/me', ({ user, body }) => {
    if (!isObj(body)) throw bad('body must be an object');
    const wantsPw = body.password !== undefined;
    if (wantsPw || body.currentPassword !== undefined) {
      if (typeof body.currentPassword !== 'string') throw bad('currentPassword is required');
      if (!verifyPassword(body.currentPassword, user)) throw new HttpError(401, 'invalid_credentials', 'current password is incorrect');
    }
    if (body.displayName !== undefined) {
      if (typeof body.displayName !== 'string' || !body.displayName.trim()) throw bad('displayName must be a non-empty string');
    }
    if (wantsPw && (typeof body.password !== 'string' || body.password.length < 6)) throw bad('password must be at least 6 characters');
    if (body.displayName !== undefined) user.displayName = body.displayName.trim();
    if (wantsPw) { const { salt, hash } = hashPassword(body.password); user.salt = salt; user.passwordHash = hash; }
    return [200, { user: pubUser(user) }];
  });

  // tokens
  route('POST', '/api/tokens', ({ user, body }) => {
    if (!isObj(body)) throw bad('body must be an object');
    const name = reqString(body, 'name', { max: 200 }).trim();
    const token = 'pm_' + crypto.randomBytes(24).toString('hex');
    const rec = { id: newId(), userId: user.id, name, tokenHash: sha256(token), createdAt: nowIso(), lastUsedAt: null };
    db.apiTokens.push(rec);
    auditUserWorkspaces(user.id, 'token.created', { tokenId: rec.id, name });
    return [201, { id: rec.id, name, token, createdAt: rec.createdAt }];
  });
  route('GET', '/api/tokens', ({ user }) => [200, db.apiTokens.filter(t => t.userId === user.id).map(t => ({ id: t.id, name: t.name, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt }))]);
  route('DELETE', '/api/tokens/:id', ({ user, params }) => {
    const t = db.apiTokens.find(t => t.id === params.id);
    if (!t) throw notFound('token');
    if (t.userId !== user.id) throw notFound('token');
    db.apiTokens = db.apiTokens.filter(x => x !== t);
    auditUserWorkspaces(user.id, 'token.deleted', { tokenId: t.id, name: t.name });
    return [204];
  });

  // users (for UI lookups)
  route('GET', '/api/users/:id', ({ params }) => { const u = userById(params.id) || userByName(params.id); if (!u) throw notFound('user'); return [200, pubUser(u)]; });

  // workspaces
  const pubWs = (ws, role) => ({ id: ws.id, name: ws.name, key: ws.key, createdAt: ws.createdAt, ...(role ? { role } : {}) });
  route('POST', '/api/workspaces', ({ user, body }) => {
    if (!isObj(body)) throw bad('body must be an object');
    const name = reqString(body, 'name', { max: 200 }).trim();
    const key = body.key;
    if (typeof key !== 'string' || !KEY_RE.test(key)) throw bad('key must be 2-10 uppercase letters');
    if (db.workspaces.some(w => w.key === key)) throw conflict('key_taken', 'workspace key already exists');
    const ws = { id: newId(), name, key, createdAt: nowIso(), createdBy: user.id };
    db.workspaces.push(ws);
    db.wsMembers.push({ workspaceId: ws.id, userId: user.id, role: 'admin', addedAt: nowIso() });
    audit(ws.id, user.id, 'workspace.created', { name, key });
    return [201, pubWs(ws, 'admin')];
  });
  route('GET', '/api/workspaces', ({ user }) => [200, db.wsMembers.filter(m => m.userId === user.id).map(m => { const ws = db.workspaces.find(w => w.id === m.workspaceId); return ws && pubWs(ws, m.role); }).filter(Boolean)]);
  route('GET', '/api/workspaces/:id', ({ user, params }) => { const { ws, role } = getWorkspace(params.id, user); return [200, pubWs(ws, role)]; });
  const pubWsMember = m => { const u = userById(m.userId); return { userId: m.userId, username: u?.username, displayName: u?.displayName, role: m.role }; };
  route('GET', '/api/workspaces/:id/members', ({ user, params }) => { const { ws } = getWorkspace(params.id, user); return [200, db.wsMembers.filter(m => m.workspaceId === ws.id).map(pubWsMember)]; });
  route('POST', '/api/workspaces/:id/members', ({ user, params, body }) => {
    const { ws } = getWorkspace(params.id, user, true);
    if (!isObj(body)) throw bad('body must be an object');
    const role = body.role ?? 'member';
    if (!WS_ROLES.includes(role)) throw bad('invalid role');
    if (typeof body.username !== 'string' && typeof body.userId !== 'string') throw bad('username is required');
    const u = body.username ? userByName(body.username) : userById(body.userId);
    if (!u) throw notFound('user');
    const existing = wsMember(ws.id, u.id);
    if (existing) throw conflict('already_member', 'user is already a member');
    const m = { workspaceId: ws.id, userId: u.id, role, addedAt: nowIso() };
    db.wsMembers.push(m);
    audit(ws.id, user.id, 'member.added', { userId: u.id, username: u.username, role });
    return [201, pubWsMember(m)];
  });
  const findWsMemberParam = (ws, p) => { const u = userById(p) || userByName(p); const m = u && wsMember(ws.id, u.id); if (!m) throw notFound('member'); return m; };
  const adminCount = wsId => db.wsMembers.filter(m => m.workspaceId === wsId && m.role === 'admin').length;
  route('PATCH', '/api/workspaces/:id/members/:userId', ({ user, params, body }) => {
    const { ws } = getWorkspace(params.id, user, true);
    const m = findWsMemberParam(ws, params.userId);
    if (!isObj(body) || !WS_ROLES.includes(body.role)) throw bad('invalid role');
    if (m.role === 'admin' && body.role !== 'admin' && adminCount(ws.id) <= 1) throw bad('cannot demote the last admin', 'last_admin');
    const from = m.role; m.role = body.role;
    if (from !== m.role) audit(ws.id, user.id, 'member.role_changed', { userId: m.userId, username: userById(m.userId)?.username, from, to: m.role });
    return [200, pubWsMember(m)];
  });
  route('DELETE', '/api/workspaces/:id/members/:userId', ({ user, params }) => {
    const { ws } = getWorkspace(params.id, user, true);
    const m = findWsMemberParam(ws, params.userId);
    if (m.role === 'admin' && adminCount(ws.id) <= 1) throw bad('cannot remove the last admin', 'last_admin');
    db.wsMembers = db.wsMembers.filter(x => x !== m);
    const projIds = new Set(db.projects.filter(p => p.workspaceId === ws.id).map(p => p.id));
    db.projMembers = db.projMembers.filter(pm => !(pm.userId === m.userId && projIds.has(pm.projectId)));
    audit(ws.id, user.id, 'member.removed', { userId: m.userId, username: userById(m.userId)?.username, role: m.role });
    return [204];
  });
  route('GET', '/api/workspaces/:id/audit', ({ user, params }) => {
    const { ws } = getWorkspace(params.id, user, true);
    return [200, db.audit.filter(a => a.workspaceId === ws.id).sort((a, b) => a.seq - b.seq).map(({ seq, ...a }) => a)];
  });

  // projects
  route('POST', '/api/workspaces/:id/projects', ({ user, params, body }) => {
    const { ws, role } = getWorkspace(params.id, user);
    if (role === 'guest') throw forbidden('guests cannot create projects');
    if (!isObj(body)) throw bad('body must be an object');
    const name = reqString(body, 'name', { max: 200 }).trim();
    const key = body.key;
    if (typeof key !== 'string' || !KEY_RE.test(key)) throw bad('key must be 2-10 uppercase letters');
    if (db.projects.some(p => p.key === key)) throw conflict('key_taken', 'project key already exists');
    const statuses = [['Backlog', 'backlog'], ['Todo', 'unstarted'], ['In Progress', 'started'], ['In Review', 'started'], ['Done', 'completed']].map(([name, category]) => ({ name, category }));
    const transitions = []; for (const a of statuses) for (const b of statuses) if (a !== b) transitions.push([a.name, b.name]);
    const t = nowIso();
    const p = { id: newId(), workspaceId: ws.id, name, key, workflow: { statuses, transitions }, issueCounter: 0, createdAt: t, updatedAt: t, createdBy: user.id };
    db.projects.push(p);
    db.projMembers.push({ projectId: p.id, userId: user.id, role: 'lead', addedAt: t });
    audit(ws.id, user.id, 'project.created', { projectId: p.id, key });
    return [201, pubProject(p)];
  });
  route('GET', '/api/workspaces/:id/projects', ({ user, params }) => {
    const { ws } = getWorkspace(params.id, user);
    return [200, db.projects.filter(p => p.workspaceId === ws.id && canSee(p, user.id)).map(p => ({ ...pubProject(p), role: projectRole(p, user.id) }))];
  });
  route('GET', '/api/projects', ({ user }) => [200, db.projects.filter(p => canSee(p, user.id)).map(p => ({ ...pubProject(p), role: projectRole(p, user.id) }))]);
  route('GET', '/api/projects/:id', ({ user, params }) => { const { project, role } = getProject(params.id, user); return [200, { ...pubProject(project), role }]; });
  route('PATCH', '/api/projects/:id', ({ user, params, body }) => {
    const { project } = getProject(params.id, user, 'lead');
    if (!isObj(body)) throw bad('body must be an object');
    if (body.name !== undefined) project.name = reqString(body, 'name').trim();
    project.updatedAt = nowIso();
    return [200, pubProject(project)];
  });
  route('DELETE', '/api/projects/:id', ({ user, params }) => {
    const { project } = getProject(params.id, user, 'lead');
    const ids = new Set(db.issues.filter(i => i.projectId === project.id).map(i => i.id));
    db.issues = db.issues.filter(i => !ids.has(i.id));
    db.links = db.links.filter(l => !ids.has(l.sourceId) && !ids.has(l.targetId));
    db.comments = db.comments.filter(c => !ids.has(c.issueId));
    db.sprints = db.sprints.filter(s => s.projectId !== project.id);
    db.webhooks = db.webhooks.filter(w => w.projectId !== project.id);
    db.projMembers = db.projMembers.filter(m => m.projectId !== project.id);
    db.projects = db.projects.filter(p => p !== project);
    audit(project.workspaceId, user.id, 'project.deleted', { projectId: project.id, key: project.key });
    return [204];
  });
  const pubProjMember = (project, m) => { const u = userById(m.userId); return { userId: m.userId, username: u?.username, displayName: u?.displayName, role: m.role }; };
  route('GET', '/api/projects/:id/members', ({ user, params }) => {
    const { project } = getProject(params.id, user);
    const explicit = db.projMembers.filter(m => m.projectId === project.id).map(m => pubProjMember(project, m));
    const seen = new Set(explicit.map(m => m.userId));
    const implicit = db.wsMembers.filter(m => m.workspaceId === project.workspaceId && !seen.has(m.userId) && projectRole(project, m.userId))
      .map(m => { const u = userById(m.userId); return { userId: m.userId, username: u?.username, displayName: u?.displayName, role: projectRole(project, m.userId), implicit: true }; });
    return [200, [...explicit, ...implicit]];
  });
  route('POST', '/api/projects/:id/members', ({ user, params, body }) => {
    const { project } = getProject(params.id, user, 'lead');
    if (!isObj(body)) throw bad('body must be an object');
    const role = body.role ?? 'developer';
    if (!PROJ_ROLES.includes(role)) throw bad('invalid role');
    if (typeof body.username !== 'string' && typeof body.userId !== 'string') throw bad('username is required');
    const u = body.username ? userByName(body.username) : userById(body.userId);
    if (!u) throw notFound('user');
    if (!wsMember(project.workspaceId, u.id)) {
      db.wsMembers.push({ workspaceId: project.workspaceId, userId: u.id, role: 'guest', addedAt: nowIso() });
      audit(project.workspaceId, user.id, 'member.added', { userId: u.id, username: u.username, role: 'guest' });
    }
    let m = projMember(project.id, u.id);
    if (m) { const from = m.role; m.role = role; audit(project.workspaceId, user.id, 'project.member_role_changed', { projectId: project.id, userId: u.id, from, to: role }); return [200, pubProjMember(project, m)]; }
    m = { projectId: project.id, userId: u.id, role, addedAt: nowIso() };
    db.projMembers.push(m);
    audit(project.workspaceId, user.id, 'project.member_added', { projectId: project.id, userId: u.id, username: u.username, role });
    return [201, pubProjMember(project, m)];
  });
  const findProjMember = (project, p) => { const u = userById(p) || userByName(p); const m = u && projMember(project.id, u.id); if (!m) throw notFound('member'); return m; };
  route('PATCH', '/api/projects/:id/members/:userId', ({ user, params, body }) => {
    const { project } = getProject(params.id, user, 'lead');
    const m = findProjMember(project, params.userId);
    if (!isObj(body) || !PROJ_ROLES.includes(body.role)) throw bad('invalid role');
    const from = m.role; m.role = body.role;
    audit(project.workspaceId, user.id, 'project.member_role_changed', { projectId: project.id, userId: m.userId, from, to: m.role });
    return [200, pubProjMember(project, m)];
  });
  route('DELETE', '/api/projects/:id/members/:userId', ({ user, params }) => {
    const { project } = getProject(params.id, user, 'lead');
    const m = findProjMember(project, params.userId);
    db.projMembers = db.projMembers.filter(x => x !== m);
    audit(project.workspaceId, user.id, 'project.member_removed', { projectId: project.id, userId: m.userId });
    return [204];
  });

  // workflow
  route('GET', '/api/projects/:id/workflow', ({ user, params }) => [200, getProject(params.id, user).project.workflow]);
  route('PUT', '/api/projects/:id/workflow', ({ user, params, body }) => {
    const { project } = getProject(params.id, user, 'lead');
    return [200, setWorkflow(project, user, body)];
  });

  // issues
  route('POST', '/api/projects/:id/issues', ({ user, params, body }) => {
    const { project } = getProject(params.id, user, 'developer');
    return [201, issueDetail(createIssue(project, user, body))];
  });
  route('GET', '/api/projects/:id/issues', ({ user, params, query }) => {
    const { project } = getProject(params.id, user);
    let list = db.issues.filter(i => i.projectId === project.id);
    if (query.get('status')) list = list.filter(i => i.status === query.get('status'));
    if (query.get('type')) list = list.filter(i => i.type === query.get('type'));
    if (query.has('sprintId')) { const s = query.get('sprintId'); list = list.filter(i => (s === '' || s === 'none' || s === 'backlog') ? !i.sprintId : i.sprintId === s); }
    return [200, list.sort((a, b) => a.number - b.number).map(serializeIssue)];
  });
  route('GET', '/api/issues/:key', ({ user, params }) => [200, issueDetail(getIssue(params.key, user).issue)]);
  route('PATCH', '/api/issues/:key', ({ user, params, body }) => {
    const { issue, project } = getIssue(params.key, user, 'developer');
    return [200, issueDetail(updateIssue(issue, project, user, body))];
  });
  route('DELETE', '/api/issues/:key', ({ user, params }) => {
    const { issue, project } = getIssue(params.key, user, 'developer');
    deleteIssue(issue, project, user);
    return [204];
  });
  route('GET', '/api/issues/:key/history', ({ user, params }) => {
    const { issue } = getIssue(params.key, user);
    return [200, historyFor(issue.id).map(h => ({ field: h.field, from: h.from, to: h.to, actorId: h.actorId, at: h.at }))];
  });

  // links
  route('POST', '/api/issues/:key/links', ({ user, params, body }) => {
    const { issue } = getIssue(params.key, user, 'developer');
    if (!isObj(body)) throw bad('body must be an object');
    let type = body.type;
    let src = issue, tgtRef = body.target ?? body.targetKey;
    if (type === 'blocked_by') { type = 'blocks'; }
    if (!LINK_TYPES.includes(type)) throw bad('invalid link type');
    if (typeof tgtRef !== 'string' || !tgtRef) throw bad('target is required');
    const target = issueByKey(tgtRef) || issueById(tgtRef);
    if (!target) throw notFound('target issue');
    const tp = projectById(target.projectId);
    if (!canSee(tp, user.id)) throw forbidden('no access to target issue');
    if (target.id === issue.id) throw bad('cannot link an issue to itself');
    let a = src, b = target;
    if (body.type === 'blocked_by') { a = target; b = src; }
    const dup = db.links.find(l => l.type === type && ((l.sourceId === a.id && l.targetId === b.id) || (type === 'relates' && l.sourceId === b.id && l.targetId === a.id)));
    if (dup) throw conflict('link_exists', 'link already exists');
    const link = { id: newId(), type, sourceId: a.id, targetId: b.id, createdAt: nowIso(), createdBy: user.id };
    db.links.push(link);
    return [201, { id: link.id, type: body.type, source: issue.key, target: target.key, issueKey: target.key, createdAt: link.createdAt }];
  });
  route('GET', '/api/issues/:key/links', ({ user, params }) => [200, linksOf(getIssue(params.key, user).issue)]);
  route('DELETE', '/api/issues/:key/links/:linkId', ({ user, params }) => {
    const { issue } = getIssue(params.key, user, 'developer');
    const l = db.links.find(l => l.id === params.linkId && (l.sourceId === issue.id || l.targetId === issue.id));
    if (!l) throw notFound('link');
    db.links = db.links.filter(x => x !== l);
    return [204];
  });

  // watchers
  route('POST', '/api/issues/:key/watch', ({ user, params }) => {
    const { issue } = getIssue(params.key, user);
    addWatcher(issue, user.id);
    return [200, { watchers: issue.watchers }];
  });
  route('DELETE', '/api/issues/:key/watch', ({ user, params }) => {
    const { issue } = getIssue(params.key, user);
    issue.watchers = issue.watchers.filter(w => w !== user.id);
    return [200, { watchers: issue.watchers }];
  });
  route('GET', '/api/issues/:key/watchers', ({ user, params }) => [200, getIssue(params.key, user).issue.watchers]);

  // comments
  route('GET', '/api/issues/:key/comments', ({ user, params }) => {
    const { issue } = getIssue(params.key, user);
    return [200, db.comments.filter(c => c.issueId === issue.id).map(pubComment)];
  });
  route('POST', '/api/issues/:key/comments', ({ user, params, body }) => {
    const { issue, project } = getIssue(params.key, user);
    if (!isObj(body)) throw bad('body must be an object');
    return [201, pubComment(addComment(issue, project, user, body))];
  });
  const findComment = (user, id, key) => {
    const c = db.comments.find(c => c.id === id);
    if (!c) throw notFound('comment');
    const { issue, project, role } = getIssue(c.issueId, user);
    if (key && issue.key !== String(key).toUpperCase() && issue.id !== key) throw notFound('comment');
    return { c, issue, project, role };
  };
  const patchComment = ({ user, params, body }) => {
    const { c } = findComment(user, params.commentId, params.key);
    if (c.authorId !== user.id) throw forbidden('only the author can edit a comment');
    if (!isObj(body)) throw bad('body must be an object');
    const text = reqString(body, 'body', { max: 50000 });
    c.body = text; c.edited = true; c.updatedAt = nowIso();
    return [200, pubComment(c)];
  };
  const deleteComment = ({ user, params }) => {
    const { c, role } = findComment(user, params.commentId, params.key);
    if (c.authorId !== user.id && role !== 'lead') throw forbidden('only the author can delete a comment');
    db.comments = db.comments.filter(x => x !== c);
    return [204];
  };
  route('PATCH', '/api/comments/:commentId', patchComment);
  route('PUT', '/api/comments/:commentId', patchComment);
  route('DELETE', '/api/comments/:commentId', deleteComment);
  route('PATCH', '/api/issues/:key/comments/:commentId', patchComment);
  route('PUT', '/api/issues/:key/comments/:commentId', patchComment);
  route('DELETE', '/api/issues/:key/comments/:commentId', deleteComment);

  // notifications
  route('GET', '/api/notifications', ({ user, query }) => {
    let list = db.notifications.filter(n => n.userId === user.id);
    const u = query.get('unread');
    if (u === 'true' || u === '1') list = list.filter(n => !n.read);
    return [200, list.sort((a, b) => b.seq - a.seq).map(pubNotif)];
  });
  route('POST', '/api/notifications/read', ({ user, body }) => {
    if (!isObj(body)) throw bad('body must be an object');
    let list = db.notifications.filter(n => n.userId === user.id);
    if (body.all === true) { /* all */ }
    else if (Array.isArray(body.ids)) { const ids = new Set(body.ids); list = list.filter(n => ids.has(n.id)); }
    else throw bad('ids or all:true required');
    let updated = 0;
    for (const n of list) if (!n.read) { n.read = true; updated++; }
    return [200, { updated }];
  });

  // sprints
  route('POST', '/api/projects/:id/sprints', ({ user, params, body }) => {
    const { project } = getProject(params.id, user, 'developer');
    if (!isObj(body)) throw bad('body must be an object');
    const name = reqString(body, 'name', { max: 200 }).trim();
    for (const f of ['startDate', 'endDate']) if (body[f] !== undefined && body[f] !== null && !validDate(body[f])) throw bad(`${f} must be YYYY-MM-DD`);
    const startDate = body.startDate ? body.startDate.slice(0, 10) : null;
    const endDate = body.endDate ? body.endDate.slice(0, 10) : null;
    if (startDate && endDate && endDate < startDate) throw bad('endDate must not be before startDate');
    const s = { id: newId(), projectId: project.id, name, goal: typeof body.goal === 'string' ? body.goal : null, state: 'planned', startDate, endDate, createdAt: nowIso(), startedAt: null, completedAt: null };
    db.sprints.push(s);
    return [201, pubSprint(s)];
  });
  route('GET', '/api/projects/:id/sprints', ({ user, params }) => { const { project } = getProject(params.id, user); return [200, db.sprints.filter(s => s.projectId === project.id).map(pubSprint)]; });
  route('GET', '/api/sprints/:id', ({ user, params }) => [200, pubSprint(getSprint(params.id, user).sprint)]);
  route('PATCH', '/api/sprints/:id', ({ user, params, body }) => {
    const { sprint } = getSprint(params.id, user, 'developer');
    if (!isObj(body)) throw bad('body must be an object');
    if (body.name !== undefined) sprint.name = reqString(body, 'name').trim();
    for (const f of ['startDate', 'endDate']) if (body[f] !== undefined) { if (body[f] !== null && !validDate(body[f])) throw bad(`${f} must be YYYY-MM-DD`); sprint[f] = body[f] ? body[f].slice(0, 10) : null; }
    if (body.goal !== undefined) sprint.goal = body.goal;
    return [200, pubSprint(sprint)];
  });
  route('DELETE', '/api/sprints/:id', ({ user, params }) => {
    const { sprint } = getSprint(params.id, user, 'developer');
    if (sprint.state === 'active') throw conflict('sprint_active', 'cannot delete active sprint');
    for (const i of db.issues) if (i.sprintId === sprint.id) { recordHistory(i, 'sprintId', i.sprintId, null, user.id); i.sprintId = null; }
    db.sprints = db.sprints.filter(s => s !== sprint);
    return [204];
  });
  route('POST', '/api/sprints/:id/start', ({ user, params, body }) => {
    const { sprint, project } = getSprint(params.id, user, 'developer');
    if (sprint.state !== 'planned') throw conflict('invalid_state', `sprint is ${sprint.state}`);
    if (db.sprints.some(s => s.projectId === project.id && s.state === 'active')) throw conflict('sprint_active', 'project already has an active sprint');
    if (isObj(body)) {
      for (const f of ['startDate', 'endDate']) if (body[f] !== undefined && body[f] !== null) { if (!validDate(body[f])) throw bad(`${f} must be YYYY-MM-DD`); sprint[f] = body[f].slice(0, 10); }
    }
    sprint.state = 'active'; sprint.startedAt = nowIso();
    if (!sprint.startDate) sprint.startDate = sprint.startedAt.slice(0, 10);
    return [200, pubSprint(sprint)];
  });
  route('POST', '/api/sprints/:id/complete', ({ user, params, body }) => {
    const { sprint, project } = getSprint(params.id, user, 'developer');
    if (sprint.state !== 'active') throw conflict('invalid_state', `sprint is ${sprint.state}`);
    const carry = isObj(body) && body.carryOverTo !== undefined && body.carryOverTo !== null ? body.carryOverTo : 'backlog';
    let target = null;
    if (carry !== 'backlog') {
      target = sprintById(carry);
      if (!target || target.projectId !== project.id) throw bad('carryOverTo sprint not found');
      if (target.id === sprint.id) throw bad('cannot carry over to the same sprint');
      if (target.state === 'completed') throw bad('cannot carry over to a completed sprint');
    }
    const unfinished = db.issues.filter(i => i.sprintId === sprint.id && categoryOf(project, i.status) !== 'completed');
    const t = nowIso();
    sprint.state = 'completed'; sprint.completedAt = t;
    // record report snapshot before moving
    for (const i of unfinished) { recordHistory(i, 'sprintId', i.sprintId, target ? target.id : null, user.id); i.sprintId = target ? target.id : null; i.updatedAt = t; }
    sprint.carriedOverCount = unfinished.length;
    sprint.carriedOverKeys = unfinished.map(i => i.key);
    sprint.carriedOverTo = target ? target.id : 'backlog';
    return [200, { ...pubSprint(sprint), carriedOver: unfinished.map(i => i.key) }];
  });
  route('GET', '/api/sprints/:id/report', ({ user, params }) => {
    const { sprint, project } = getSprint(params.id, user);
    return [200, sprintReport(sprint, project)];
  });
  route('GET', '/api/projects/:id/stats', ({ user, params }) => [200, projectStats(getProject(params.id, user).project)]);

  // search
  route('GET', '/api/search', ({ user, query }) => {
    let terms;
    try { terms = parseQuery(query.get('q') || ''); } catch (e) { if (e instanceof QueryError) throw bad(e.message, 'invalid_query'); throw e; }
    let projects = db.projects.filter(p => canSee(p, user.id));
    const pf = query.get('project');
    if (pf) {
      const p = db.projects.find(p => p.id === pf || p.key === pf.toUpperCase());
      if (!p) throw notFound('project');
      if (!canSee(p, user.id)) throw forbidden('no access to project');
      projects = [p];
    }
    const pids = new Set(projects.map(p => p.id));
    const activeSprintIds = new Set(db.sprints.filter(s => s.state === 'active').map(s => s.id));
    const ctx = { userId: user.id, userByName, category: issueCategory, activeSprintIds };
    const list = db.issues.filter(i => pids.has(i.projectId) && matches(i, terms, ctx));
    const sort = query.get('sort') || 'updated';
    if (!['updated', 'created', 'priority'].includes(sort)) throw bad('invalid sort');
    const tie = (a, b) => (b.updatedAt.localeCompare(a.updatedAt)) || (b.seqUpd || 0) - (a.seqUpd || 0) || (b.number - a.number);
    if (sort === 'created') list.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.number - a.number);
    else if (sort === 'priority') list.sort((a, b) => PRIO_RANK[a.priority] - PRIO_RANK[b.priority] || tie(a, b));
    else list.sort(tie);
    return [200, list.map(serializeIssue)];
  });

  // csv
  route('GET', '/api/projects/:id/export.csv', ({ user, params }) => {
    const { project } = getProject(params.id, user);
    return [200, exportCsv(project), { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${project.key}.csv"` }];
  });
  route('POST', '/api/projects/:id/import.csv', ({ user, params, rawBody, req }) => {
    const { project } = getProject(params.id, user, 'developer');
    let text = rawBody;
    const ct = req.headers['content-type'] || '';
    if (ct.includes('application/json')) {
      try { const j = JSON.parse(rawBody); if (j && typeof j.csv === 'string') text = j.csv; } catch {}
    }
    return [200, importCsv(project, user, text)];
  }, { raw: true });

  // webhooks
  route('POST', '/api/projects/:id/webhooks', ({ user, params, body }) => {
    const { project } = getProject(params.id, user, 'lead');
    if (!isObj(body)) throw bad('body must be an object');
    const url = reqString(body, 'url', { max: 2000 });
    let u; try { u = new URL(url); } catch { throw bad('invalid url'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw bad('url must be http(s)');
    const events = body.events;
    if (!Array.isArray(events) || !events.length || events.some(e => !WEBHOOK_EVENTS.includes(e))) throw bad('invalid events');
    if (body.secret !== undefined && body.secret !== null && typeof body.secret !== 'string') throw bad('secret must be a string');
    const h = { id: newId(), projectId: project.id, url, events: [...new Set(events)], secret: body.secret || '', createdAt: nowIso(), createdBy: user.id };
    db.webhooks.push(h);
    audit(project.workspaceId, user.id, 'webhook.created', { projectId: project.id, webhookId: h.id, url });
    return [201, pubHook(h)];
  });
  route('GET', '/api/projects/:id/webhooks', ({ user, params }) => { const { project } = getProject(params.id, user, 'lead'); return [200, db.webhooks.filter(h => h.projectId === project.id).map(pubHook)]; });
  const getHook = (user, id) => { const h = db.webhooks.find(h => h.id === id); if (!h) throw notFound('webhook'); const { project } = getProject(h.projectId, user, 'lead'); return { h, project }; };
  route('GET', '/api/webhooks/:id', ({ user, params }) => [200, pubHook(getHook(user, params.id).h)]);
  route('DELETE', '/api/webhooks/:id', ({ user, params }) => {
    const { h, project } = getHook(user, params.id);
    db.webhooks = db.webhooks.filter(x => x !== h);
    audit(project.workspaceId, user.id, 'webhook.deleted', { projectId: project.id, webhookId: h.id, url: h.url });
    return [204];
  });
  route('GET', '/api/webhooks/:id/deliveries', ({ user, params }) => {
    const { h } = getHook(user, params.id);
    return [200, db.deliveries.filter(d => d.webhookId === h.id).sort((a, b) => a.seq - b.seq).map(pubDelivery)];
  });

  // ---------- static ----------
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
  function serveStatic(res, rel) {
    const file = path.normalize(path.join(STATIC_DIR, rel));
    if (!file.startsWith(STATIC_DIR + path.sep)) return false;
    let data; try { data = fs.readFileSync(file); } catch { return false; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(data);
    return true;
  }

  function send(res, status, body, headers = {}) {
    if (status === 204 || body === undefined) { res.writeHead(status, headers); return res.end(); }
    if (typeof body === 'string') { res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers }); return res.end(body); }
    const s = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
    res.end(s);
  }
  const sendError = (res, status, code, message) => send(res, status, { error: code, message });

  async function readBody(req) {
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > 10 * 1024 * 1024) throw new HttpError(413, 'payload_too_large', 'body too large'); chunks.push(c); }
    return Buffer.concat(chunks).toString('utf8');
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) { if (serveStatic(res, 'index.html')) return; }
      if (req.method === 'GET' && p.startsWith('/static/')) { if (serveStatic(res, decodeURIComponent(p.slice(8)))) return; return sendError(res, 404, 'not_found', 'file not found'); }
      if (!p.startsWith('/api/')) {
        if (req.method === 'GET' && !path.extname(p)) { if (serveStatic(res, 'index.html')) return; }
        return sendError(res, 404, 'not_found', 'not found');
      }
      let matched = null; let methodMismatch = false;
      for (const r of routes) {
        const m = r.re.exec(p);
        if (!m) continue;
        if (r.method !== req.method) { methodMismatch = true; continue; }
        const params = {}; r.keys.forEach((k, n) => { params[k] = decodeURIComponent(m[n + 1]); });
        matched = { r, params }; break;
      }
      if (!matched) return methodMismatch ? sendError(res, 405, 'method_not_allowed', 'method not allowed') : sendError(res, 404, 'not_found', 'not found');
      const rawBody = await readBody(req);
      let body = {};
      if (!matched.r.raw && rawBody.trim()) {
        try { body = JSON.parse(rawBody); } catch { return sendError(res, 400, 'invalid_json', 'request body is not valid JSON'); }
      }
      let user = null;
      if (matched.r.auth) {
        user = authenticate(req);
        if (!user) return sendError(res, 401, 'unauthenticated', 'authentication required');
      }
      const out = await matched.r.handler({ req, user, params: matched.params, body, rawBody, query: url.searchParams });
      if (req.method !== 'GET') save();
      send(res, out[0], out[1], out[2]);
    } catch (e) {
      if (e instanceof HttpError) return sendError(res, e.status, e.code, e.message);
      console.error(e);
      sendError(res, 500, 'internal_error', 'internal server error');
    }
  });
  return server;
}
