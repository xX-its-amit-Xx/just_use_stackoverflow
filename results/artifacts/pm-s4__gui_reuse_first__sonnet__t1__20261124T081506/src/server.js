import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseQuery, matches, QueryError } from './search.js';
import { toCsv, parseCsv } from './csv.js';

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}
const bad = (m) => new HttpError(400, 'validation_error', m);
const forbidden = (m) => new HttpError(403, 'forbidden', m || 'forbidden');
const notFound = (m) => new HttpError(404, 'not_found', m || 'not found');

const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'];
const CATEGORIES = ['backlog', 'unstarted', 'started', 'completed'];
const WS_ROLES = ['admin', 'member', 'guest'];
const PROJECT_ROLES = ['lead', 'developer', 'viewer'];
const RANK = { viewer: 1, developer: 2, lead: 3 };
const EVENTS = ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'];
const LINK_TYPES = ['blocks', 'relates', 'duplicates'];
const INVERSE = { blocks: 'blocked_by', relates: 'relates', duplicates: 'duplicated_by' };
const DEFAULT_STATUSES = [
  { name: 'Backlog', category: 'backlog' }, { name: 'Todo', category: 'unstarted' },
  { name: 'In Progress', category: 'started' }, { name: 'In Review', category: 'started' },
  { name: 'Done', category: 'completed' }];

const R = (...a) => Object.assign(a, { isResp: true });
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rid = () => crypto.randomUUID();
const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}/.test(s) && !isNaN(Date.parse(s));

function emptyDb() {
  return { users: [], sessions: [], apiTokens: [], workspaces: [], projects: [], issues: [], links: [], comments: [],
    sprints: [], notifications: [], webhooks: [], deliveries: [], audit: [] };
}

export function createServer({ dataFile, clock } = {}) {
  let db = emptyDb();
  if (dataFile && fs.existsSync(dataFile)) {
    try { db = { ...emptyDb(), ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) }; } catch { /* start fresh */ }
  }
  const nowD = () => (clock ? new Date(clock()) : new Date());
  const now = () => nowD().toISOString();
  const failures = new Map();
  const save = () => {
    if (!dataFile) return;
    try { fs.writeFileSync(dataFile + '.tmp', JSON.stringify(db)); fs.renameSync(dataFile + '.tmp', dataFile); } catch { /* ignore */ }
  };

  // ---------- lookups ----------
  const userById = (id) => db.users.find(u => u.id === id);
  const userByName = (n) => db.users.find(u => u.username.toLowerCase() === String(n).toLowerCase());
  const pubUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName });
  const wsById = (id) => db.workspaces.find(w => w.id === id);
  const projById = (id) => db.projects.find(p => p.id === id);
  const issueById = (id) => db.issues.find(i => i.id === id);
  const sprintById = (id) => db.sprints.find(s => s.id === id);

  function projectRole(user, project) {
    const ws = wsById(project.workspaceId);
    const wm = ws && ws.members.find(m => m.userId === user.id);
    if (!wm) return null;
    if (wm.role === 'admin') return 'lead';
    const pm = project.members.find(m => m.userId === user.id);
    if (pm) return pm.role;
    return wm.role === 'member' ? 'developer' : null;
  }
  function getProject(id, user, min = 'viewer') {
    const p = projById(id);
    if (!p) throw notFound('project not found');
    const r = projectRole(user, p);
    if (!r) throw forbidden('no access to project');
    if (RANK[r] < RANK[min]) throw forbidden('insufficient project role');
    return p;
  }
  function getWorkspace(id, user, admin = false) {
    const w = wsById(id);
    if (!w) throw notFound('workspace not found');
    const m = w.members.find(x => x.userId === user.id);
    if (!m) throw forbidden('not a workspace member');
    if (admin && m.role !== 'admin') throw forbidden('admin only');
    return w;
  }
  function getIssue(key, user, min = 'viewer') {
    const all = db.issues.filter(i => i.key.toLowerCase() === String(key).toLowerCase());
    if (!all.length) throw notFound('issue not found');
    for (const i of all) {
      const p = projById(i.projectId);
      const r = projectRole(user, p);
      if (r) { if (RANK[r] < RANK[min]) throw forbidden('insufficient project role'); return i; }
    }
    throw forbidden('no access to issue');
  }
  const resolveIssueRef = (ref, project) => {
    if (ref == null) return null;
    return db.issues.find(i => i.projectId === project.id && (i.id === ref || i.key === ref)) || null;
  };
  const category = (project, status) => (project.workflow.statuses.find(s => s.name === status) || {}).category;

  function audit(wsIds, actorId, action, details) {
    for (const wid of [].concat(wsIds)) db.audit.push({ id: rid(), workspaceId: wid, at: now(), actorId, action, details: details || {} });
  }

  // ---------- issue output ----------
  function issueOut(i, full = false) {
    const o = { ...i, labels: [...i.labels], watchers: [...i.watchers] };
    const links = [];
    for (const l of db.links) {
      if (l.sourceId === i.id) { const t = issueById(l.targetId); if (t) links.push({ id: l.id, type: l.type, target: t.key, key: t.key }); }
      else if (l.targetId === i.id) { const t = issueById(l.sourceId); if (t) links.push({ id: l.id, type: INVERSE[l.type], target: t.key, key: t.key }); }
    }
    o.links = links;
    if (full) {
      o.children = db.issues.filter(c => c.parentId === i.id).map(c => c.key);
      if (i.type === 'epic') {
        const kids = db.issues.filter(c => c.epicId === i.id);
        const p = projById(i.projectId);
        const done = kids.filter(c => category(p, c.status) === 'completed');
        o.progress = { total: kids.length, done: done.length,
          points_total: kids.reduce((a, c) => a + (c.storyPoints || 0), 0), points_done: done.reduce((a, c) => a + (c.storyPoints || 0), 0) };
      }
    }
    return o;
  }

  // ---------- notifications / webhooks ----------
  function notify(userIds, type, issue, actorId) {
    const p = projById(issue.projectId);
    for (const uid of new Set(userIds)) {
      if (uid === actorId) continue;
      const u = userById(uid);
      if (!u || !projectRole(u, p)) continue;
      db.notifications.push({ id: rid(), userId: uid, type, issueKey: issue.key, actorId, at: now(), read: false });
    }
  }
  function fire(event, issue, actorId) {
    const hooks = db.webhooks.filter(h => h.projectId === issue.projectId && h.events.includes(event));
    for (const h of hooks) {
      const at = now();
      const body = JSON.stringify({ event, issue: issueOut(issue, true), actorId, at });
      const d = { id: rid(), webhookId: h.id, event, status: null, attempts: 0, lastError: null, createdAt: at };
      db.deliveries.push(d);
      const sig = 'sha256=' + crypto.createHmac('sha256', h.secret || '').update(body).digest('hex');
      (async () => {
        for (let a = 1; a <= 3; a++) {
          d.attempts = a;
          try {
            const r = await fetch(h.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pm-signature': sig }, body, signal: AbortSignal.timeout(5000) });
            d.status = r.status;
            if (r.status >= 200 && r.status < 300) { d.lastError = null; break; }
            d.lastError = 'HTTP ' + r.status;
          } catch (e) { d.status = null; d.lastError = String(e && e.message || e); }
          if (a < 3) await new Promise(r => setTimeout(r, 50 * a));
        }
        save();
      })();
    }
  }

  // ---------- history ----------
  const FIELDS = ['type', 'title', 'description', 'status', 'priority', 'assigneeId', 'labels', 'storyPoints', 'parentId', 'epicId', 'sprintId', 'dueDate'];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  function validateFields(project, data, cur, actor) {
    const out = {};
    const has = (k) => Object.prototype.hasOwnProperty.call(data, k);
    if (has('type')) { if (!TYPES.includes(data.type)) throw bad('invalid type'); out.type = data.type; }
    if (has('title')) { if (!isStr(data.title)) throw bad('title required'); out.title = data.title.trim(); }
    if (has('description')) { if (data.description != null && typeof data.description !== 'string') throw bad('invalid description'); out.description = data.description ?? ''; }
    if (has('priority')) { if (!PRIORITIES.includes(data.priority)) throw bad('invalid priority'); out.priority = data.priority; }
    if (has('labels')) {
      if (!Array.isArray(data.labels) || data.labels.some(l => !isStr(l))) throw bad('invalid labels');
      out.labels = [...new Set(data.labels.map(l => l.trim()))];
    }
    if (has('storyPoints')) {
      const v = data.storyPoints;
      if (v !== null && !(typeof v === 'number' && Number.isFinite(v) && v >= 0)) throw bad('invalid storyPoints');
      out.storyPoints = v;
    }
    if (has('dueDate')) {
      if (data.dueDate !== null && !isDate(data.dueDate)) throw bad('invalid dueDate');
      out.dueDate = data.dueDate;
    }
    if (has('assigneeId') || has('assignee')) {
      let v = has('assigneeId') ? data.assigneeId : data.assignee;
      if (v !== null && v !== undefined) {
        const u = userById(v) || userByName(v);
        if (!u || !projectRole(u, project)) throw bad('invalid assignee');
        v = u.id;
      } else v = null;
      out.assigneeId = v;
    }
    if (has('sprintId')) {
      if (data.sprintId !== null) {
        const sp = sprintById(data.sprintId);
        if (!sp || sp.projectId !== project.id) throw bad('invalid sprint');
        if (sp.state === 'completed') throw bad('sprint is completed');
      }
      out.sprintId = data.sprintId;
    }
    const type = out.type ?? cur?.type;
    if (has('parentId') || out.type !== undefined || !cur) {
      let pid = has('parentId') ? data.parentId : cur?.parentId ?? null;
      if (pid != null) {
        const par = resolveIssueRef(pid, project);
        if (!par) throw bad('invalid parent');
        if (par.type === 'subtask') throw bad('parent cannot be a subtask');
        if (cur && par.id === cur.id) throw bad('parent cannot be self');
        pid = par.id;
      } else pid = null;
      if (type === 'subtask' && !pid) throw bad('subtask requires parentId');
      if (type === 'epic' && pid) throw bad('epics cannot have parents');
      if (has('parentId') || (cur && cur.parentId !== pid)) out.parentId = pid;
      if (!cur) out.parentId = pid;
    }
    if (has('epicId')) {
      let eid = data.epicId;
      if (eid != null) {
        const e = resolveIssueRef(eid, project);
        if (!e || e.type !== 'epic') throw bad('epicId must reference an epic');
        eid = e.id;
      } else eid = null;
      out.epicId = eid;
    }
    if (has('status')) {
      if (!project.workflow.statuses.some(s => s.name === data.status)) throw bad('unknown status');
      out.status = data.status;
    }
    return out;
  }

  function applyStatus(issue, project, to, actor) {
    const from = issue.status;
    if (from === to) return;
    const cf = category(project, from), ct = category(project, to);
    if (ct === 'completed' && cf !== 'completed') {
      for (const l of db.links) {
        if (l.type === 'blocks' && l.targetId === issue.id) {
          const src = issueById(l.sourceId);
          if (src && !src.resolvedAt) throw new HttpError(409, 'blocked', 'issue is blocked by ' + src.key);
        }
      }
    }
    issue.status = to;
    if (ct === 'completed') { if (cf !== 'completed') issue.resolvedAt = now(); } else issue.resolvedAt = null;
  }

  function recordHistory(issue, field, from, to, actorId) {
    issueHistory(issue).push({ field, from, to, actorId, at: now() });
  }
  function issueHistory(issue) {
    if (!db.history) db.history = {};
    return (db.history[issue.id] ??= []);
  }

  function patchIssue(issue, project, data, actor) {
    const patch = validateFields(project, data, issue, actor);
    const before = {};
    for (const f of FIELDS) before[f] = issue[f];
    const beforeResolved = issue.resolvedAt;
    if (patch.status !== undefined && patch.status !== issue.status) {
      if (!project.workflow.transitions.some(([f, t]) => f === issue.status && t === patch.status))
        throw new HttpError(409, 'invalid_transition', `cannot move from ${issue.status} to ${patch.status}`);
      applyStatus(issue, project, patch.status, actor);
    }
    delete patch.status;
    for (const [k, v] of Object.entries(patch)) issue[k] = v;
    const changed = [];
    for (const f of FIELDS) {
      if (!same(before[f], issue[f])) { changed.push(f); recordHistory(issue, f, before[f] ?? null, issue[f] ?? null, actor.id); }
    }
    if (changed.length) {
      issue.updatedAt = now();
      if (changed.includes('sprintId') && issue.sprintId) { /* membership tracked via history */ }
      if (changed.includes('assigneeId') && issue.assigneeId && !issue.watchers.includes(issue.assigneeId)) issue.watchers.push(issue.assigneeId);
      if (changed.includes('status')) notify(issue.watchers, 'status_changed', issue, actor.id);
      if (changed.includes('assigneeId')) notify(issue.watchers, 'assigned', issue, actor.id);
    }
    void beforeResolved;
    return changed;
  }

  function createIssue(project, data, actor) {
    const d = data || {};
    if (!isStr(d.title)) throw bad('title required');
    if (!TYPES.includes(d.type)) throw bad('invalid type');
    const patch = validateFields(project, d, null, actor);
    const wf = project.workflow.statuses;
    const status = patch.status || (wf.find(s => s.category === 'unstarted') || wf[0]).name;
    const t = now();
    project.nextNumber = (project.nextNumber || 1);
    const issue = {
      id: rid(), key: `${project.key}-${project.nextNumber++}`, projectId: project.id, type: patch.type, title: patch.title,
      description: patch.description ?? '', status, priority: patch.priority ?? 'medium', assigneeId: patch.assigneeId ?? null,
      reporterId: actor.id, labels: patch.labels ?? [], storyPoints: patch.storyPoints ?? null, parentId: patch.parentId ?? null,
      epicId: patch.epicId ?? null, sprintId: patch.sprintId ?? null, dueDate: patch.dueDate ?? null, watchers: [],
      createdAt: t, updatedAt: t, resolvedAt: category(project, status) === 'completed' ? t : null };
    issue.watchers.push(actor.id);
    if (issue.assigneeId && !issue.watchers.includes(issue.assigneeId)) issue.watchers.push(issue.assigneeId);
    db.issues.push(issue);
    return issue;
  }

  function deleteIssue(issue, actor) {
    for (const c of db.issues.filter(x => x.parentId === issue.id)) deleteIssue(c, actor);
    db.issues = db.issues.filter(x => x.id !== issue.id);
    db.links = db.links.filter(l => l.sourceId !== issue.id && l.targetId !== issue.id);
    db.comments = db.comments.filter(c => c.issueId !== issue.id);
    for (const x of db.issues) if (x.epicId === issue.id) x.epicId = null;
    if (db.history) delete db.history[issue.id];
  }

  // ---------- search ----------
  function runSearch(user, q, projectParam, sort) {
    let terms;
    try { terms = parseQuery(q); } catch (e) { if (e instanceof QueryError) throw bad('malformed query: ' + e.message); throw e; }
    if (!['updated', 'created', 'priority'].includes(sort)) throw bad('invalid sort');
    let projects = db.projects.filter(p => projectRole(user, p));
    if (projectParam) {
      const p = db.projects.find(x => x.id === projectParam) || db.projects.filter(x => x.key === projectParam && projectRole(user, x))[0];
      if (!p) throw notFound('project not found');
      if (!projectRole(user, p)) throw forbidden('no access');
      projects = [p];
    }
    const ids = new Set(projects.map(p => p.id));
    const ctx = { user, usernameOf: (id) => userById(id)?.username, sprintOf: sprintById };
    let res = db.issues.filter(i => ids.has(i.projectId) && matches(i, terms, ctx)).reverse();
    if (sort === 'priority') res.sort((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) || (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    else if (sort === 'created') res.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    else res.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    return res.map(i => issueOut(i));
  }

  // ---------- sprint report ----------
  function valueAt(issue, field, T) {
    const h = (db.history?.[issue.id] || []).filter(e => e.field === field);
    if (!h.length) return issue[field] ?? null;
    let v = h[0].from;
    for (const e of h) { if (e.at <= T) v = e.to; else break; }
    return v;
  }
  function sprintReport(sp) {
    const project = projById(sp.projectId);
    const inSprint = db.issues.filter(i => i.sprintId === sp.id);
    const done = inSprint.filter(i => i.resolvedAt);
    const pts = (l) => l.reduce((a, i) => a + (i.storyPoints || 0), 0);
    const r = {
      committedPoints: sp.committedPoints ?? pts(inSprint),
      completedPoints: sp.completedPoints ?? pts(done),
      completedIssues: sp.completedIssues ?? done.length,
      carriedOver: sp.carriedOver ?? 0,
      burndown: [] };
    if (sp.startDate) {
      const today = now().slice(0, 10);
      const end = sp.endDate ? sp.endDate.slice(0, 10) : today;
      const last = end < today ? end : today;
      const candidates = db.issues.filter(i => i.projectId === project.id);
      for (let d = new Date(sp.startDate.slice(0, 10) + 'T00:00:00Z'); ; d = new Date(d.getTime() + 86400000)) {
        const ds = d.toISOString().slice(0, 10);
        if (ds > last) break;
        const T = ds + 'T23:59:59.999Z';
        let rem = 0;
        for (const i of candidates) {
          if (i.createdAt > T) continue;
          if (valueAt(i, 'sprintId', T) !== sp.id) continue;
          const st = valueAt(i, 'status', T);
          if (category(project, st) === 'completed') continue;
          rem += valueAt(i, 'storyPoints', T) || 0;
        }
        r.burndown.push({ date: ds, remainingPoints: rem });
      }
    }
    return r;
  }

  // ---------- stats ----------
  function projectStats(project) {
    const issues = db.issues.filter(i => i.projectId === project.id);
    const byStatus = {}; for (const s of project.workflow.statuses) byStatus[s.name] = 0;
    const byType = {}; for (const t of TYPES) byType[t] = 0;
    const byAssignee = {};
    let sum = 0, n = 0;
    for (const i of issues) {
      byStatus[i.status] = (byStatus[i.status] || 0) + 1;
      byType[i.type]++;
      const a = i.assigneeId ? userById(i.assigneeId)?.username : 'unassigned';
      byAssignee[a] = (byAssignee[a] || 0) + 1;
      if (i.resolvedAt) {
        let start = null;
        const h = (db.history?.[i.id] || []).filter(e => e.field === 'status');
        if (category(project, h.length ? h[0].from : i.status) === 'started') start = i.createdAt;
        for (const e of h) if (!start && category(project, e.to) === 'started') start = e.at;
        if (start) { sum += (Date.parse(i.resolvedAt) - Date.parse(start)) / 3600000; n++; }
      }
    }
    return { total: issues.length, byStatus, byType, byAssignee, avgCycleTimeHours: n ? sum / n : null };
  }

  // ---------- CSV ----------
  const CSV_COLS = ['key', 'type', 'title', 'status', 'priority', 'assignee', 'labels', 'storyPoints', 'parent', 'epic', 'sprint', 'dueDate', 'createdAt', 'resolvedAt'];
  function exportCsv(project) {
    const rows = [CSV_COLS];
    for (const i of db.issues.filter(x => x.projectId === project.id)) {
      rows.push([i.key, i.type, i.title, i.status, i.priority, i.assigneeId ? userById(i.assigneeId)?.username : '', i.labels.join(';'),
        i.storyPoints ?? '', i.parentId ? issueById(i.parentId)?.key : '', i.epicId ? issueById(i.epicId)?.key : '',
        i.sprintId ? sprintById(i.sprintId)?.name : '', i.dueDate ?? '', i.createdAt, i.resolvedAt ?? '']);
    }
    return toCsv(rows);
  }
  function importCsv(project, text, actor) {
    let rows;
    try { rows = parseCsv(text); } catch (e) { throw bad('malformed csv: ' + e.message); }
    if (!rows.length) throw bad('empty csv');
    const header = rows[0].cells.map(h => h.trim());
    const col = (n) => header.indexOf(n);
    if (col('title') < 0 || col('type') < 0) throw bad('csv header must include type and title');
    let created = 0; const errors = [];
    for (const { line, cells } of rows.slice(1)) {
      if (cells.length === 1 && cells[0].trim() === '') continue;
      const g = (n) => { const c = col(n); return c < 0 ? '' : (cells[c] ?? '').trim(); };
      try {
        const data = { type: g('type'), title: g('title') };
        if (g('status')) data.status = g('status');
        if (g('priority')) data.priority = g('priority');
        if (g('assignee')) { const u = userByName(g('assignee')); if (!u) throw bad('unknown assignee ' + g('assignee')); data.assigneeId = u.id; }
        if (g('labels')) data.labels = g('labels').split(';').map(s => s.trim()).filter(Boolean);
        if (g('storyPoints')) { const n = Number(g('storyPoints')); if (!Number.isFinite(n)) throw bad('invalid storyPoints'); data.storyPoints = n; }
        if (g('parent')) data.parentId = g('parent');
        if (g('epic')) data.epicId = g('epic');
        if (g('sprint')) {
          const sp = db.sprints.find(s => s.projectId === project.id && (s.name === g('sprint') || s.id === g('sprint')));
          if (!sp) throw bad('unknown sprint ' + g('sprint'));
          data.sprintId = sp.id;
        }
        if (g('dueDate')) data.dueDate = g('dueDate');
        const issue = createIssue(project, data, actor);
        created++;
        fire('issue.created', issue, actor.id);
      } catch (e) {
        if (e instanceof HttpError) errors.push({ line, message: e.message }); else throw e;
      }
    }
    return { created, errors };
  }

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, handler, public: !!opts.public, raw: !!opts.raw });
  };

  // auth
  route('POST', '/api/auth/register', ({ body }) => {
    const { username, password, displayName } = body;
    if (typeof username !== 'string' || !/^[A-Za-z0-9_.-]{3,32}$/.test(username)) throw bad('invalid username');
    if (typeof password !== 'string' || password.length < 6) throw bad('password too short');
    if (displayName != null && typeof displayName !== 'string') throw bad('invalid displayName');
    if (userByName(username)) throw new HttpError(409, 'conflict', 'username taken');
    const salt = crypto.randomBytes(16).toString('hex');
    const u = { id: rid(), username, displayName: displayName || username, salt, hash: crypto.scryptSync(password, salt, 32).toString('hex'), createdAt: now() };
    db.users.push(u);
    return R(201, { user: pubUser(u) });
  }, { public: true });
  const checkPw = (u, pw) => typeof pw === 'string' && crypto.timingSafeEqual(Buffer.from(crypto.scryptSync(pw, u.salt, 32).toString('hex')), Buffer.from(u.hash));
  route('POST', '/api/auth/login', ({ body }) => {
    const { username, password } = body;
    if (typeof username !== 'string' || typeof password !== 'string') throw bad('username and password required');
    const k = username.toLowerCase();
    const t = nowD().getTime();
    const recent = (failures.get(k) || []).filter(x => t - x < 15 * 60000);
    failures.set(k, recent);
    if (recent.length >= 5) throw new HttpError(429, 'rate_limited', 'too many failed attempts');
    const u = userByName(username);
    if (!u || !checkPw(u, password)) { recent.push(t); throw new HttpError(401, 'invalid_credentials', 'invalid username or password'); }
    failures.delete(k);
    const token = crypto.randomBytes(32).toString('hex');
    db.sessions.push({ hash: sha(token), userId: u.id, createdAt: now() });
    return { token, user: pubUser(u) };
  }, { public: true });
  route('POST', '/api/auth/logout', ({ token }) => { db.sessions = db.sessions.filter(s => s.hash !== sha(token)); return R(204); });
  route('GET', '/api/auth/me', ({ user }) => ({ user: pubUser(user) }));
  route('PATCH', '/api/auth/me', ({ user, body }) => {
    if (body.displayName !== undefined && !isStr(body.displayName)) throw bad('invalid displayName');
    if (body.password !== undefined) {
      if (typeof body.password !== 'string' || body.password.length < 6) throw bad('password too short');
      if (!checkPw(user, body.currentPassword)) throw forbidden('current password incorrect');
      user.salt = crypto.randomBytes(16).toString('hex');
      user.hash = crypto.scryptSync(body.password, user.salt, 32).toString('hex');
    }
    if (body.displayName !== undefined) user.displayName = body.displayName.trim();
    return { user: pubUser(user) };
  });
  route('GET', '/api/users', ({ user }) => db.users.map(pubUser));

  // tokens
  const myWs = (user) => db.workspaces.filter(w => w.members.some(m => m.userId === user.id)).map(w => w.id);
  route('POST', '/api/tokens', ({ user, body }) => {
    if (!isStr(body.name)) throw bad('name required');
    const token = 'pm_' + crypto.randomBytes(24).toString('hex');
    const t = { id: rid(), userId: user.id, name: body.name.trim(), hash: sha(token), createdAt: now() };
    db.apiTokens.push(t);
    audit(myWs(user), user.id, 'token.created', { tokenId: t.id, name: t.name });
    return R(201, { id: t.id, name: t.name, token });
  });
  route('GET', '/api/tokens', ({ user }) => db.apiTokens.filter(t => t.userId === user.id).map(t => ({ id: t.id, name: t.name, createdAt: t.createdAt })));
  route('DELETE', '/api/tokens/:id', ({ user, params }) => {
    const t = db.apiTokens.find(x => x.id === params.id && x.userId === user.id);
    if (!t) throw notFound('token not found');
    db.apiTokens = db.apiTokens.filter(x => x !== t);
    audit(myWs(user), user.id, 'token.deleted', { tokenId: t.id, name: t.name });
    return R(204);
  });

  // workspaces
  const wsOut = (w, user) => ({ id: w.id, name: w.name, key: w.key, createdAt: w.createdAt,
    role: w.members.find(m => m.userId === user.id)?.role,
    members: w.members.map(m => ({ userId: m.userId, username: userById(m.userId)?.username, displayName: userById(m.userId)?.displayName, role: m.role })) });
  route('POST', '/api/workspaces', ({ user, body }) => {
    if (!isStr(body.name)) throw bad('name required');
    if (typeof body.key !== 'string' || !/^[A-Z]{2,10}$/.test(body.key)) throw bad('key must be 2-10 uppercase letters');
    if (db.workspaces.some(w => w.key === body.key)) throw new HttpError(409, 'conflict', 'workspace key taken');
    const w = { id: rid(), name: body.name.trim(), key: body.key, createdAt: now(), members: [{ userId: user.id, role: 'admin' }] };
    db.workspaces.push(w);
    return R(201, wsOut(w, user));
  });
  route('GET', '/api/workspaces', ({ user }) => db.workspaces.filter(w => w.members.some(m => m.userId === user.id)).map(w => wsOut(w, user)));
  route('GET', '/api/workspaces/:id', ({ user, params }) => wsOut(getWorkspace(params.id, user), user));
  route('GET', '/api/workspaces/:id/members', ({ user, params }) => wsOut(getWorkspace(params.id, user), user).members);
  route('POST', '/api/workspaces/:id/members', ({ user, params, body }) => {
    const w = getWorkspace(params.id, user, true);
    if (!isStr(body.username)) throw bad('username required');
    if (!WS_ROLES.includes(body.role)) throw bad('invalid role');
    const u = userByName(body.username);
    if (!u) throw notFound('user not found');
    if (w.members.some(m => m.userId === u.id)) throw new HttpError(409, 'conflict', 'already a member');
    w.members.push({ userId: u.id, role: body.role });
    audit(w.id, user.id, 'member.added', { userId: u.id, username: u.username, role: body.role });
    return R(201, { userId: u.id, username: u.username, displayName: u.displayName, role: body.role });
  });
  const lastAdmin = (w, m) => m.role === 'admin' && w.members.filter(x => x.role === 'admin').length === 1;
  route('PATCH', '/api/workspaces/:id/members/:uid', ({ user, params, body }) => {
    const w = getWorkspace(params.id, user, true);
    const m = w.members.find(x => x.userId === params.uid);
    if (!m) throw notFound('member not found');
    if (!WS_ROLES.includes(body.role)) throw bad('invalid role');
    if (body.role !== 'admin' && lastAdmin(w, m)) throw bad('cannot demote the last admin');
    const from = m.role; m.role = body.role;
    audit(w.id, user.id, 'member.role_changed', { userId: m.userId, from, to: m.role });
    const u = userById(m.userId);
    return { userId: m.userId, username: u?.username, displayName: u?.displayName, role: m.role };
  });
  route('DELETE', '/api/workspaces/:id/members/:uid', ({ user, params }) => {
    const w = getWorkspace(params.id, user, true);
    const m = w.members.find(x => x.userId === params.uid);
    if (!m) throw notFound('member not found');
    if (lastAdmin(w, m)) throw bad('cannot remove the last admin');
    w.members = w.members.filter(x => x !== m);
    for (const p of db.projects.filter(p => p.workspaceId === w.id)) p.members = p.members.filter(x => x.userId !== m.userId);
    audit(w.id, user.id, 'member.removed', { userId: m.userId });
    return R(204);
  });
  route('GET', '/api/workspaces/:id/audit', ({ user, params }) => {
    const w = getWorkspace(params.id, user, true);
    return db.audit.filter(a => a.workspaceId === w.id).map(({ workspaceId, ...r }) => r);
  });

  // projects
  const projOut = (p, user) => ({ id: p.id, workspaceId: p.workspaceId, name: p.name, key: p.key, createdAt: p.createdAt,
    role: projectRole(user, p), workflow: p.workflow });
  route('POST', '/api/workspaces/:id/projects', ({ user, params, body }) => {
    const w = getWorkspace(params.id, user);
    const wm = w.members.find(m => m.userId === user.id);
    if (wm.role === 'guest') throw forbidden('guests cannot create projects');
    if (!isStr(body.name)) throw bad('name required');
    if (typeof body.key !== 'string' || !/^[A-Z]{2,10}$/.test(body.key)) throw bad('key must be 2-10 uppercase letters');
    if (db.projects.some(p => p.workspaceId === w.id && p.key === body.key)) throw new HttpError(409, 'conflict', 'project key taken');
    const statuses = DEFAULT_STATUSES.map(s => ({ ...s }));
    const transitions = []; for (const a of statuses) for (const b of statuses) if (a !== b) transitions.push([a.name, b.name]);
    const p = { id: rid(), workspaceId: w.id, name: body.name.trim(), key: body.key, createdAt: now(), members: [{ userId: user.id, role: 'lead' }], nextNumber: 1, workflow: { statuses, transitions } };
    db.projects.push(p);
    return R(201, projOut(p, user));
  });
  route('GET', '/api/workspaces/:id/projects', ({ user, params }) => {
    const w = getWorkspace(params.id, user);
    return db.projects.filter(p => p.workspaceId === w.id && projectRole(user, p)).map(p => projOut(p, user));
  });
  route('GET', '/api/projects/:id', ({ user, params }) => projOut(getProject(params.id, user), user));
  const pmOut = (m) => ({ userId: m.userId, username: userById(m.userId)?.username, displayName: userById(m.userId)?.displayName, role: m.role });
  route('GET', '/api/projects/:id/members', ({ user, params }) => getProject(params.id, user).members.map(pmOut));
  route('POST', '/api/projects/:id/members', ({ user, params, body }) => {
    const p = getProject(params.id, user, 'lead');
    const u = isStr(body.username) ? userByName(body.username) : isStr(body.userId) ? userById(body.userId) : null;
    if (!u) { if (isStr(body.username) || isStr(body.userId)) throw notFound('user not found'); throw bad('username required'); }
    if (!PROJECT_ROLES.includes(body.role)) throw bad('invalid role');
    const w = wsById(p.workspaceId);
    if (!w.members.some(m => m.userId === u.id)) throw bad('user is not a workspace member');
    if (p.members.some(m => m.userId === u.id)) throw new HttpError(409, 'conflict', 'already a project member');
    const m = { userId: u.id, role: body.role };
    p.members.push(m);
    audit(w.id, user.id, 'project_member.added', { projectId: p.id, userId: u.id, role: m.role });
    return R(201, pmOut(m));
  });
  route('PATCH', '/api/projects/:id/members/:uid', ({ user, params, body }) => {
    const p = getProject(params.id, user, 'lead');
    const m = p.members.find(x => x.userId === params.uid);
    if (!m) throw notFound('member not found');
    if (!PROJECT_ROLES.includes(body.role)) throw bad('invalid role');
    const from = m.role; m.role = body.role;
    audit(p.workspaceId, user.id, 'project_member.role_changed', { projectId: p.id, userId: m.userId, from, to: m.role });
    return pmOut(m);
  });
  route('DELETE', '/api/projects/:id/members/:uid', ({ user, params }) => {
    const p = getProject(params.id, user, 'lead');
    const m = p.members.find(x => x.userId === params.uid);
    if (!m) throw notFound('member not found');
    p.members = p.members.filter(x => x !== m);
    audit(p.workspaceId, user.id, 'project_member.removed', { projectId: p.id, userId: m.userId });
    return R(204);
  });
  route('PUT', '/api/projects/:id/workflow', ({ user, params, body }) => {
    const p = getProject(params.id, user, 'lead');
    const { statuses, transitions } = body;
    if (!Array.isArray(statuses) || !statuses.length) throw bad('statuses required');
    const names = new Set();
    for (const s of statuses) {
      if (!s || !isStr(s.name) || !CATEGORIES.includes(s.category)) throw bad('invalid status');
      if (names.has(s.name)) throw bad('duplicate status ' + s.name);
      names.add(s.name);
    }
    if (!Array.isArray(transitions) || transitions.some(t => !Array.isArray(t) || t.length !== 2 || !names.has(t[0]) || !names.has(t[1]))) throw bad('invalid transitions');
    const remap = body.remap || {};
    if (typeof remap !== 'object' || Array.isArray(remap)) throw bad('invalid remap');
    const issues = db.issues.filter(i => i.projectId === p.id);
    for (const s of p.workflow.statuses) {
      if (!names.has(s.name) && issues.some(i => i.status === s.name)) {
        if (!remap[s.name] || !names.has(remap[s.name])) throw bad(`status ${s.name} is in use and needs a valid remap`);
      }
    }
    const newWf = { statuses: statuses.map(s => ({ name: s.name, category: s.category })), transitions: transitions.map(t => [t[0], t[1]]) };
    const old = p.workflow;
    p.workflow = newWf;
    for (const i of issues) {
      if (!names.has(i.status) && remap[i.status]) {
        const from = i.status;
        i.status = remap[from];
        const wasDone = !!i.resolvedAt, isDone = category(p, i.status) === 'completed';
        if (isDone && !wasDone) i.resolvedAt = now(); else if (!isDone) i.resolvedAt = null;
        recordHistory(i, 'status', from, i.status, user.id);
        i.updatedAt = now();
      } else if (!!i.resolvedAt !== (category(p, i.status) === 'completed')) {
        i.resolvedAt = category(p, i.status) === 'completed' ? i.resolvedAt || now() : null;
      }
    }
    void old;
    audit(p.workspaceId, user.id, 'workflow.updated', { projectId: p.id });
    return p.workflow;
  });
  route('GET', '/api/projects/:id/workflow', ({ user, params }) => getProject(params.id, user).workflow);
  route('GET', '/api/projects/:id/stats', ({ user, params }) => projectStats(getProject(params.id, user)));

  // issues
  route('POST', '/api/projects/:id/issues', ({ user, params, body }) => {
    const p = getProject(params.id, user, 'developer');
    const i = createIssue(p, body, user);
    fire('issue.created', i, user.id);
    return R(201, issueOut(i, true));
  });
  route('GET', '/api/projects/:id/issues', ({ user, params, query }) => {
    const p = getProject(params.id, user);
    return runSearch(user, query.get('q') || '', p.id, query.get('sort') || 'updated');
  });
  route('GET', '/api/issues/:key', ({ user, params }) => issueOut(getIssue(params.key, user), true));
  route('PATCH', '/api/issues/:key', ({ user, params, body }) => {
    const i = getIssue(params.key, user, 'developer');
    const p = projById(i.projectId);
    const changed = patchIssue(i, p, body, user);
    if (changed.length) fire('issue.updated', i, user.id);
    return issueOut(i, true);
  });
  route('DELETE', '/api/issues/:key', ({ user, params }) => {
    const i = getIssue(params.key, user, 'developer');
    const snap = { ...i };
    fire('issue.deleted', snap, user.id);
    deleteIssue(i, user);
    return R(204);
  });
  route('GET', '/api/issues/:key/history', ({ user, params }) => {
    const i = getIssue(params.key, user);
    return (db.history?.[i.id] || []).map(e => ({ ...e }));
  });
  route('POST', '/api/issues/:key/links', ({ user, params, body }) => {
    const i = getIssue(params.key, user, 'developer');
    if (!LINK_TYPES.includes(body.type)) throw bad('invalid link type');
    if (!isStr(body.target)) throw bad('target required');
    const t = getIssue(body.target, user, 'developer');
    if (t.id === i.id) throw bad('cannot link an issue to itself');
    if (db.links.some(l => (l.sourceId === i.id && l.targetId === t.id && l.type === body.type) || (l.sourceId === t.id && l.targetId === i.id && l.type === body.type && body.type === 'relates')))
      throw new HttpError(409, 'conflict', 'link already exists');
    const l = { id: rid(), type: body.type, sourceId: i.id, targetId: t.id };
    db.links.push(l);
    i.updatedAt = now();
    return R(201, { id: l.id, type: l.type, target: t.key, key: t.key });
  });
  route('DELETE', '/api/issues/:key/links/:lid', ({ user, params }) => {
    const i = getIssue(params.key, user, 'developer');
    const l = db.links.find(x => x.id === params.lid && (x.sourceId === i.id || x.targetId === i.id));
    if (!l) throw notFound('link not found');
    db.links = db.links.filter(x => x !== l);
    return R(204);
  });
  route('POST', '/api/issues/:key/watch', ({ user, params }) => {
    const i = getIssue(params.key, user);
    if (!i.watchers.includes(user.id)) i.watchers.push(user.id);
    return issueOut(i, true);
  });
  route('DELETE', '/api/issues/:key/watch', ({ user, params }) => {
    const i = getIssue(params.key, user);
    i.watchers = i.watchers.filter(w => w !== user.id);
    return R(204);
  });

  // comments
  const mentionsOf = (text) => {
    const out = new Set();
    for (const m of text.matchAll(/(?:^|[^A-Za-z0-9_])@([A-Za-z0-9_.-]+)/g)) {
      let n = m[1];
      for (;;) { const u = userByName(n); if (u) { out.add(u.id); break; } if (/[.-]$/.test(n)) n = n.slice(0, -1); else break; }
    }
    return [...out];
  };
  route('GET', '/api/issues/:key/comments', ({ user, params }) => {
    const i = getIssue(params.key, user);
    return db.comments.filter(c => c.issueId === i.id).map(commentOut);
  });
  const commentOut = (c) => { const i = issueById(c.issueId); return { id: c.id, issueKey: i?.key, authorId: c.authorId, body: c.body, createdAt: c.createdAt, updatedAt: c.updatedAt, edited: c.edited }; };
  route('POST', '/api/issues/:key/comments', ({ user, params, body }) => {
    const i = getIssue(params.key, user, 'developer');
    if (!isStr(body.body)) throw bad('body required');
    const t = now();
    const c = { id: rid(), issueId: i.id, authorId: user.id, body: body.body, createdAt: t, updatedAt: t, edited: false };
    db.comments.push(c);
    const mentioned = mentionsOf(body.body);
    notify(mentioned, 'mention', i, user.id);
    const skip = new Set(mentioned);
    notify(i.watchers.filter(w => !skip.has(w)), 'comment', i, user.id);
    i.updatedAt = t;
    fire('comment.created', i, user.id);
    return R(201, commentOut(c));
  });
  route('PATCH', '/api/comments/:id', ({ user, params, body }) => {
    const c = db.comments.find(x => x.id === params.id);
    if (!c) throw notFound('comment not found');
    const i = issueById(c.issueId);
    getIssue(i.key, user);
    if (c.authorId !== user.id) throw forbidden('only the author can edit');
    if (!isStr(body.body)) throw bad('body required');
    c.body = body.body; c.edited = true; c.updatedAt = now();
    return commentOut(c);
  });
  route('DELETE', '/api/comments/:id', ({ user, params }) => {
    const c = db.comments.find(x => x.id === params.id);
    if (!c) throw notFound('comment not found');
    const i = issueById(c.issueId);
    getIssue(i.key, user);
    const p = projById(i.projectId);
    if (c.authorId !== user.id && projectRole(user, p) !== 'lead') throw forbidden('not allowed');
    db.comments = db.comments.filter(x => x !== c);
    return R(204);
  });

  // notifications
  route('GET', '/api/notifications', ({ user, query }) => {
    let l = db.notifications.filter(n => n.userId === user.id);
    if (query.get('unread') === 'true') l = l.filter(n => !n.read);
    return l.slice().reverse().map(({ userId, ...n }) => n);
  });
  route('POST', '/api/notifications/read', ({ user, body }) => {
    let n = 0;
    if (body.all === true) { for (const x of db.notifications) if (x.userId === user.id && !x.read) { x.read = true; n++; } }
    else if (Array.isArray(body.ids)) { for (const x of db.notifications) if (x.userId === user.id && !x.read && body.ids.includes(x.id)) { x.read = true; n++; } }
    else throw bad('ids or all required');
    return { updated: n };
  });

  // sprints
  const sprintOut = (s) => ({ ...s, committedPoints: undefined, completedPoints: undefined, completedIssues: undefined, carriedOver: undefined });
  route('POST', '/api/projects/:id/sprints', ({ user, params, body }) => {
    const p = getProject(params.id, user, 'developer');
    if (!isStr(body.name)) throw bad('name required');
    for (const k of ['startDate', 'endDate']) if (body[k] != null && !isDate(body[k])) throw bad('invalid ' + k);
    if (body.startDate && body.endDate && body.endDate < body.startDate) throw bad('endDate before startDate');
    const s = { id: rid(), projectId: p.id, name: body.name.trim(), state: 'planned', startDate: body.startDate || null, endDate: body.endDate || null, createdAt: now(), startedAt: null, completedAt: null };
    db.sprints.push(s);
    return R(201, sprintOut(s));
  });
  route('GET', '/api/projects/:id/sprints', ({ user, params }) => db.sprints.filter(s => s.projectId === getProject(params.id, user).id).map(sprintOut));
  const getSprint = (id, user, min = 'viewer') => {
    const s = sprintById(id);
    if (!s) throw notFound('sprint not found');
    getProject(s.projectId, user, min);
    return s;
  };
  route('GET', '/api/sprints/:id', ({ user, params }) => sprintOut(getSprint(params.id, user)));
  route('POST', '/api/sprints/:id/start', ({ user, params }) => {
    const s = getSprint(params.id, user, 'developer');
    if (s.state !== 'planned') throw new HttpError(409, 'conflict', 'sprint is not planned');
    if (db.sprints.some(x => x.projectId === s.projectId && x.state === 'active')) throw new HttpError(409, 'conflict', 'another sprint is active');
    s.state = 'active'; s.startedAt = now();
    if (!s.startDate) s.startDate = now().slice(0, 10);
    s.committedPoints = db.issues.filter(i => i.sprintId === s.id).reduce((a, i) => a + (i.storyPoints || 0), 0);
    return sprintOut(s);
  });
  route('POST', '/api/sprints/:id/complete', ({ user, params, body }) => {
    const s = getSprint(params.id, user, 'developer');
    if (s.state !== 'active') throw new HttpError(409, 'conflict', 'sprint is not active');
    const p = projById(s.projectId);
    const target = body.carryOverTo === undefined ? 'backlog' : body.carryOverTo;
    let tsp = null;
    if (target !== 'backlog') {
      tsp = sprintById(target);
      if (!tsp || tsp.projectId !== s.projectId || tsp.id === s.id || tsp.state === 'completed') throw bad('invalid carryOverTo');
    }
    const inSprint = db.issues.filter(i => i.sprintId === s.id);
    const done = inSprint.filter(i => category(p, i.status) === 'completed');
    const un = inSprint.filter(i => category(p, i.status) !== 'completed');
    s.committedPoints ??= 0;
    s.completedPoints = done.reduce((a, i) => a + (i.storyPoints || 0), 0);
    s.completedIssues = done.length;
    s.carriedOver = un.length;
    for (const i of un) { recordHistory(i, 'sprintId', s.id, tsp ? tsp.id : null, user.id); i.sprintId = tsp ? tsp.id : null; i.updatedAt = now(); }
    s.state = 'completed'; s.completedAt = now();
    return sprintOut(s);
  });
  route('GET', '/api/sprints/:id/report', ({ user, params }) => sprintReport(getSprint(params.id, user)));

  // search
  route('GET', '/api/search', ({ user, query }) => runSearch(user, query.get('q') || '', query.get('project'), query.get('sort') || 'updated'));

  // csv
  route('GET', '/api/projects/:id/export.csv', ({ user, params }) => R(200, exportCsv(getProject(params.id, user)), 'text/csv; charset=utf-8'));
  route('POST', '/api/projects/:id/import.csv', ({ user, params, rawBody }) => importCsv(getProject(params.id, user, 'developer'), rawBody, user), { raw: true });

  // webhooks
  const hookOut = (h) => ({ id: h.id, projectId: h.projectId, url: h.url, events: h.events, createdAt: h.createdAt });
  route('POST', '/api/projects/:id/webhooks', ({ user, params, body }) => {
    const p = getProject(params.id, user, 'lead');
    let u; try { u = new URL(body.url); } catch { throw bad('invalid url'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw bad('invalid url');
    if (!Array.isArray(body.events) || !body.events.length || body.events.some(e => !EVENTS.includes(e))) throw bad('invalid events');
    if (body.secret != null && typeof body.secret !== 'string') throw bad('invalid secret');
    const h = { id: rid(), projectId: p.id, url: body.url, events: [...new Set(body.events)], secret: body.secret || '', createdAt: now() };
    db.webhooks.push(h);
    audit(p.workspaceId, user.id, 'webhook.created', { webhookId: h.id, projectId: p.id, url: h.url });
    return R(201, hookOut(h));
  });
  route('GET', '/api/projects/:id/webhooks', ({ user, params }) => db.webhooks.filter(h => h.projectId === getProject(params.id, user, 'lead').id).map(hookOut));
  const getHook = (id, user) => { const h = db.webhooks.find(x => x.id === id); if (!h) throw notFound('webhook not found'); getProject(h.projectId, user, 'lead'); return h; };
  route('DELETE', '/api/webhooks/:id', ({ user, params }) => {
    const h = getHook(params.id, user);
    db.webhooks = db.webhooks.filter(x => x !== h);
    audit(projById(h.projectId).workspaceId, user.id, 'webhook.deleted', { webhookId: h.id, projectId: h.projectId });
    return R(204);
  });
  route('GET', '/api/webhooks/:id/deliveries', ({ user, params }) => {
    const h = getHook(params.id, user);
    return db.deliveries.filter(d => d.webhookId === h.id).map(d => ({ ...d }));
  });

  // ---------- http plumbing ----------
  function authenticate(req) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization || '');
    if (!m) return null;
    const h = sha(m[1]);
    const s = db.sessions.find(x => x.hash === h) || db.apiTokens.find(x => x.hash === h);
    return s ? { user: userById(s.userId), token: m[1] } : null;
  }
  const send = (res, status, data, type = 'application/json; charset=utf-8') => {
    const body = status === 204 ? '' : (typeof data === 'string' ? data : JSON.stringify(data));
    res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
    res.end(body);
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > 10_000_000) { reject(new HttpError(413, 'too_large', 'body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const p = url.pathname;
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveStatic(res, 'index.html');
      if (req.method === 'GET' && p.startsWith('/static/')) return serveStatic(res, p.slice(8));
      if (!p.startsWith('/api/')) throw notFound();
      let match = null;
      let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(p);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== req.method) continue;
        match = { r, m }; break;
      }
      if (!match) throw pathMatched ? new HttpError(405, 'method_not_allowed', 'method not allowed') : notFound('route not found');
      const { r, m } = match;
      const params = {}; r.keys.forEach((k, idx) => { params[k] = decodeURIComponent(m[idx + 1]); });
      let auth = null;
      if (!r.public) { auth = authenticate(req); if (!auth) throw new HttpError(401, 'unauthenticated', 'authentication required'); }
      let body = {}, rawBody = '';
      if (req.method !== 'GET' && req.method !== 'DELETE' || req.headers['content-length'] > 0) {
        rawBody = await readBody(req);
        if (!r.raw && rawBody.trim()) {
          try { body = JSON.parse(rawBody); } catch { throw bad('invalid JSON body'); }
          if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('body must be an object');
        }
      }
      const out = r.handler({ req, user: auth?.user, token: auth?.token, params, body, rawBody, query: url.searchParams });
      if (req.method !== 'GET') save();
      if (out && out.isResp) send(res, out[0], out[1] ?? '', out[2]);
      else send(res, 200, out);
    } catch (e) {
      if (e instanceof HttpError) send(res, e.status, { error: e.code, message: e.message });
      else { console.error(e); send(res, 500, { error: 'internal_error', message: 'internal error' }); }
    }
  });
  function serveStatic(res, rel) {
    const f = path.normalize(path.join(STATIC_DIR, rel));
    if (!f.startsWith(STATIC_DIR) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return send(res, 404, { error: 'not_found', message: 'not found' });
    const data = fs.readFileSync(f);
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'content-length': data.length });
    res.end(data);
  }
  return server;
}
