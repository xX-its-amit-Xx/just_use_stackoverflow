import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { toCsv, parseCsv } from './csv.js';
import { parseQuery, matches, QueryError } from './search.js';

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
class HttpError extends Error { constructor(status, error, message) { super(message || error); this.status = status; this.error = error; } }
const bad = m => new HttpError(400, 'bad_request', m);
const notFound = m => new HttpError(404, 'not_found', m || 'not found');
const forbidden = m => new HttpError(403, 'forbidden', m || 'forbidden');
const conflict = (code, m) => new HttpError(409, code || 'conflict', m);

const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIOS = ['urgent', 'high', 'medium', 'low', 'none'];
const CATS = ['backlog', 'unstarted', 'started', 'completed'];
const INVERSE = { blocks: 'blocked_by', relates: 'relates', duplicates: 'duplicated_by' };
const DEFAULT_STATUSES = [['Backlog', 'backlog'], ['Todo', 'unstarted'], ['In Progress', 'started'], ['In Review', 'started'], ['Done', 'completed']];
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const isStr = v => typeof v === 'string';
const isDate = s => isStr(s) && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
const emptyDb = () => ({ seq: 0, users: [], sessions: [], tokens: [], workspaces: [], projects: [], issues: [], comments: [], sprints: [], webhooks: [], deliveries: [], notifications: [], audit: [] });

export function createServer({ dataFile, clock } = {}) {
  const now = () => (clock ? clock() : new Date());
  const iso = () => now().toISOString();
  let db = emptyDb();
  if (dataFile && fs.existsSync(dataFile)) { try { db = { ...emptyDb(), ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) }; } catch { /* start fresh */ } }
  const save = () => { if (dataFile) { const tmp = dataFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, dataFile); } };
  const nid = () => String(++db.seq);
  const failures = new Map();

  // ---------- helpers ----------
  const user = id => db.users.find(u => u.id === id);
  const userByName = n => isStr(n) ? db.users.find(u => u.username.toLowerCase() === n.toLowerCase()) : undefined;
  const pubUser = u => ({ id: u.id, username: u.username, displayName: u.displayName });
  const ws = id => db.workspaces.find(w => w.id === id);
  const project = id => db.projects.find(p => p.id === id);
  const wsRole = (u, w) => (w.members.find(m => m.userId === u.id) || {}).role || null;
  function projRole(u, p) {
    const w = ws(p.workspaceId); if (!w) return null;
    const r = wsRole(u, w); if (!r) return null;
    if (r === 'admin') return 'lead';
    const pm = p.members.find(m => m.userId === u.id);
    if (pm) return pm.role;
    return r === 'member' ? 'developer' : null;
  }
  const userCanSeeProject = (uid, p) => { const u = user(uid); return !!u && !!projRole(u, p); };
  function getWs(u, id) { const w = ws(id); if (!w) throw notFound('workspace not found'); if (!wsRole(u, w)) throw forbidden('not a workspace member'); return w; }
  function adminWs(u, id) { const w = getWs(u, id); if (wsRole(u, w) !== 'admin') throw forbidden('admin only'); return w; }
  function getProject(u, id, need) {
    const p = project(id); if (!p) throw notFound('project not found');
    const r = projRole(u, p); if (!r) throw notFound('project not found');
    if (need === 'write' && r === 'viewer') throw forbidden('read-only role');
    if (need === 'lead' && r !== 'lead') throw forbidden('lead only');
    return p;
  }
  function getIssue(u, key, need) {
    const i = db.issues.find(x => x.key === key || x.id === key); if (!i) throw notFound('issue not found');
    const p = project(i.projectId); const r = projRole(u, p); if (!r) throw notFound('issue not found');
    if (need === 'write' && r === 'viewer') throw forbidden('read-only role');
    return [i, p];
  }
  const audit = (workspaceId, actorId, action, details) => db.audit.push({ id: nid(), workspaceId, actorId, action, details, at: iso() });
  const catOf = (p, status) => (p.workflow.statuses.find(s => s.name === status) || {}).category;
  function notify(userId, type, issue, actorId) {
    db.notifications.push({ id: nid(), userId, type, issueKey: issue.key, actorId, at: iso(), read: false });
  }
  const arrOfStrings = a => Array.isArray(a) && a.every(x => isStr(x));

  // ---------- webhooks ----------
  function fire(p, event, issue, actorId, extra) {
    const hooks = db.webhooks.filter(h => h.projectId === p.id && h.events.includes(event));
    const payload = { event, issue: issueOut(issue), actorId, at: iso(), ...(extra || {}) };
    for (const h of hooks) {
      const d = { id: nid(), webhookId: h.id, event, status: 'pending', attempts: 0, lastError: null, at: payload.at };
      db.deliveries.push(d);
      const body = JSON.stringify(payload);
      const sig = 'sha256=' + crypto.createHmac('sha256', h.secret).update(body).digest('hex');
      (async () => {
        for (let a = 1; a <= 3; a++) {
          d.attempts = a;
          try {
            const r = await fetch(h.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pm-signature': sig }, body, signal: AbortSignal.timeout(5000) });
            if (r.ok) { d.status = 'success'; d.lastError = null; break; }
            d.lastError = `HTTP ${r.status}`;
          } catch (e) { d.lastError = String(e && e.message || e); }
          d.status = 'failed';
          if (a < 3) await new Promise(r => setTimeout(r, 25 * a));
        }
        try { save(); } catch { /* ignore */ }
      })();
    }
  }

  // ---------- issues ----------
  const issueOut = i => ({ ...i, history: undefined, labels: [...i.labels], watchers: [...i.watchers] });
  function detail(i) {
    const out = issueOut(i);
    out.children = db.issues.filter(c => c.parentId === i.id && c.type === 'subtask').map(c => c.key);
    out.links = (i.links || []).map(l => ({ id: l.id, type: l.type, target: l.target }));
    if (i.type === 'epic') {
      const kids = db.issues.filter(c => c.epicId === i.id); const p = project(i.projectId);
      const done = kids.filter(c => catOf(p, c.status) === 'completed');
      out.progress = { total: kids.length, done: done.length, points_total: kids.reduce((s, c) => s + (c.storyPoints || 0), 0), points_done: done.reduce((s, c) => s + (c.storyPoints || 0), 0) };
    }
    return out;
  }
  const resolveRef = (p, ref) => isStr(ref) ? db.issues.find(x => x.projectId === p.id && (x.id === ref || x.key === ref)) : undefined;
  function checkStructure(p, type, parentId, epicId, self) {
    if (type === 'epic' && parentId) throw bad('epics cannot have parents');
    if (type === 'subtask' && !parentId) throw bad('subtask requires parentId');
    if (parentId) {
      const par = db.issues.find(x => x.id === parentId);
      if (!par || par.projectId !== p.id) throw bad('parent must be in the same project');
      if (par.type === 'subtask') throw bad('parent cannot be a subtask');
      if (self && par.id === self.id) throw bad('parent cannot be self');
    }
    if (epicId) { const e = db.issues.find(x => x.id === epicId); if (!e || e.projectId !== p.id || e.type !== 'epic') throw bad('epicId must reference an epic in this project'); }
  }
  function validateFields(p, b, self) {
    const o = {};
    if ('title' in b) { if (!isStr(b.title) || !b.title.trim()) throw bad('title required'); o.title = b.title.trim(); }
    if ('description' in b) { if (b.description != null && !isStr(b.description)) throw bad('invalid description'); o.description = b.description ?? ''; }
    if ('type' in b) { if (!TYPES.includes(b.type)) throw bad('invalid type'); o.type = b.type; }
    if ('priority' in b) { if (!PRIOS.includes(b.priority)) throw bad('invalid priority'); o.priority = b.priority; }
    if ('labels' in b) { if (!arrOfStrings(b.labels)) throw bad('labels must be strings'); o.labels = [...new Set(b.labels)]; }
    if ('storyPoints' in b) { const v = b.storyPoints; if (v != null && (typeof v !== 'number' || !isFinite(v) || v < 0)) throw bad('invalid storyPoints'); o.storyPoints = v ?? null; }
    if ('dueDate' in b) { if (b.dueDate != null && !isDate(b.dueDate)) throw bad('invalid dueDate'); o.dueDate = b.dueDate ?? null; }
    if ('assigneeId' in b) {
      if (b.assigneeId != null) { if (!isStr(b.assigneeId) || !user(b.assigneeId) || !userCanSeeProject(b.assigneeId, p)) throw bad('invalid assignee'); }
      o.assigneeId = b.assigneeId ?? null;
    }
    if ('parentId' in b) { if (b.parentId == null) o.parentId = null; else { const r = resolveRef(p, b.parentId); if (!r) throw bad('parent not found'); o.parentId = r.id; } }
    if ('epicId' in b) { if (b.epicId == null) o.epicId = null; else { const r = resolveRef(p, b.epicId); if (!r) throw bad('epic not found'); o.epicId = r.id; } }
    if ('sprintId' in b) {
      if (b.sprintId == null) o.sprintId = null;
      else { const s = db.sprints.find(x => x.id === b.sprintId); if (!s || s.projectId !== p.id) throw bad('sprint not found'); if (s.state === 'completed') throw bad('sprint completed'); o.sprintId = s.id; }
    }
    if ('status' in b) { if (!isStr(b.status) || !catOf(p, b.status)) throw bad('unknown status'); o.status = b.status; }
    return o;
  }
  function createIssue(p, actor, b, { allowStatus = true } = {}) {
    if (!b || typeof b !== 'object') throw bad('invalid body');
    if (!isStr(b.title) || !b.title.trim()) throw bad('title required');
    const body = { ...b }; if (!allowStatus || body.status == null) delete body.status;
    if (body.type == null) body.type = 'task';
    const o = validateFields(p, body);
    const type = o.type, parentId = o.parentId || null, epicId = o.epicId || null;
    checkStructure(p, type, parentId, epicId, null);
    const first = p.workflow.statuses.find(s => s.category === 'unstarted') || p.workflow.statuses[0];
    const t = iso();
    p.counter = (p.counter || 0) + 1;
    const status = o.status || first.name;
    const issue = {
      id: nid(), key: `${p.key}-${p.counter}`, projectId: p.id, type, title: o.title, description: o.description || '', status,
      priority: o.priority || 'none', assigneeId: o.assigneeId || null, reporterId: actor.id, labels: o.labels || [],
      storyPoints: o.storyPoints ?? null, parentId, epicId, sprintId: o.sprintId || null, dueDate: o.dueDate || null,
      watchers: [], createdAt: t, updatedAt: t, resolvedAt: catOf(p, status) === 'completed' ? t : null, links: [], history: [],
    };
    issue.watchers.push(actor.id);
    if (issue.assigneeId && !issue.watchers.includes(issue.assigneeId)) issue.watchers.push(issue.assigneeId);
    db.issues.push(issue);
    fire(p, 'issue.created', issue, actor.id);
    return issue;
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function patchIssue(i, p, actor, b) {
    if (!b || typeof b !== 'object') throw bad('invalid body');
    const o = validateFields(p, b, i);
    if ('title' in b && !('title' in o)) throw bad('title');
    checkStructure(p, o.type ?? i.type, 'parentId' in o ? o.parentId : i.parentId, 'epicId' in o ? o.epicId : i.epicId, i);
    let completing = false;
    if ('status' in o && o.status !== i.status) {
      const ok = p.workflow.transitions.some(([f, t]) => f === i.status && t === o.status);
      if (!ok) throw conflict('invalid_transition', `cannot move from ${i.status} to ${o.status}`);
      if (catOf(p, o.status) === 'completed') {
        for (const l of i.links) if (l.type === 'blocked_by') { const t = db.issues.find(x => x.key === l.target); if (t && !t.resolvedAt) throw conflict('blocked', `blocked by ${t.key}`); }
        completing = true;
      }
    }
    const t = iso(); const changed = [];
    for (const f of Object.keys(o)) {
      if (same(i[f], o[f])) continue;
      i.history.push({ field: f, from: i[f] ?? null, to: o[f], actorId: actor.id, at: t });
      i[f] = o[f]; changed.push(f);
    }
    if (changed.includes('status')) {
      const c = catOf(p, i.status);
      const was = i.resolvedAt;
      i.resolvedAt = c === 'completed' ? (was || t) : null;
    }
    if (changed.includes('assigneeId') && i.assigneeId && !i.watchers.includes(i.assigneeId)) i.watchers.push(i.assigneeId);
    if (changed.length) {
      i.updatedAt = t;
      const targets = new Set(i.watchers);
      const send = type => { for (const w of targets) if (w !== actor.id && userCanSeeProject(w, p)) notify(w, type, i, actor.id); };
      if (changed.includes('status')) send('status_changed');
      if (changed.includes('assigneeId')) send('assigned');
      fire(p, 'issue.updated', i, actor.id, { changes: changed });
    }
    void completing;
  }
  function deleteIssue(i, p, actor) {
    const kids = db.issues.filter(c => c.parentId === i.id).map(c => c.id);
    const gone = new Set([i.id, ...kids]);
    for (const x of db.issues) if (x.epicId === i.id) x.epicId = null;
    const removed = db.issues.filter(x => gone.has(x.id));
    db.issues = db.issues.filter(x => !gone.has(x.id));
    const keys = new Set(removed.map(x => x.key));
    for (const x of db.issues) x.links = x.links.filter(l => !keys.has(l.target));
    db.comments = db.comments.filter(c => !gone.has(c.issueId));
    for (const r of removed) fire(p, 'issue.deleted', r, actor.id);
  }

  // ---------- listing / search ----------
  const prioRank = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
  function sortIssues(list, sort) {
    const idx = new Map(db.issues.map((x, n) => [x.id, n]));
    const by = sort === 'created' ? (a, b) => (b.createdAt < a.createdAt ? -1 : b.createdAt > a.createdAt ? 1 : idx.get(b.id) - idx.get(a.id))
      : sort === 'priority' ? (a, b) => prioRank[a.priority] - prioRank[b.priority] || idx.get(a.id) - idx.get(b.id)
        : (a, b) => (b.updatedAt < a.updatedAt ? -1 : b.updatedAt > a.updatedAt ? 1 : idx.get(b.id) - idx.get(a.id));
    return list.sort(by);
  }
  function runSearch(u, q, projectRef, sort) {
    if (sort && !['updated', 'created', 'priority'].includes(sort)) throw bad('invalid sort');
    let terms; try { terms = parseQuery(q || ''); } catch (e) { if (e instanceof QueryError) throw bad(e.message); throw e; }
    const ctx = { me: u.id, userName: id => (user(id) || {}).username, sprintActive: id => (db.sprints.find(s => s.id === id) || {}).state === 'active' };
    const vis = new Set(db.projects.filter(p => projRole(u, p)).map(p => p.id));
    let pid = null;
    if (projectRef) { const p = db.projects.find(x => x.id === projectRef || x.key === projectRef); if (!p || !vis.has(p.id)) throw notFound('project not found'); pid = p.id; }
    const res = db.issues.filter(i => vis.has(i.projectId) && (!pid || i.projectId === pid) && matches(i, terms, ctx));
    return sortIssues(res, sort).map(issueOut);
  }

  // ---------- sprints ----------
  const dayEnd = d => d + 'T23:59:59.999Z';
  function valueAt(i, field, t) {
    const hs = i.history.filter(h => h.field === field);
    let v; let found = false;
    for (const h of hs) if (h.at <= t) { v = h.to; found = true; }
    if (found) return v;
    if (hs.length) return hs[0].from;
    return i[field];
  }
  function sprintReport(s) {
    const p = project(s.projectId);
    const inSprint = db.issues.filter(i => i.projectId === p.id);
    const pts = i => i.storyPoints || 0;
    let committed = 0, completedPoints = 0, completedIssues = 0, carriedOver = 0;
    if (s.state !== 'planned') {
      committed = s.committedPoints ?? 0;
      if (s.report) ({ completedPoints, completedIssues, carriedOver } = s.report);
      else for (const i of inSprint) if (i.sprintId === s.id && catOf(p, i.status) === 'completed') { completedPoints += pts(i); completedIssues++; }
    }
    const burndown = [];
    if (s.state !== 'planned') {
      const start = s.startDate || s.startedAt.slice(0, 10);
      const today = iso().slice(0, 10);
      const end = s.endDate && s.endDate < today ? s.endDate : today;
      for (let d = new Date(start + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= end; d = new Date(d.getTime() + 864e5)) {
        const ds = d.toISOString().slice(0, 10), t = dayEnd(ds); let rem = 0;
        for (const i of inSprint) {
          if (i.createdAt > t) continue;
          if (valueAt(i, 'sprintId', t) !== s.id) continue;
          if (catOf(p, valueAt(i, 'status', t)) === 'completed') continue;
          rem += valueAt(i, 'storyPoints', t) || 0;
        }
        burndown.push({ date: ds, remainingPoints: rem });
      }
    }
    return { committedPoints: committed, completedPoints, completedIssues, carriedOver, burndown };
  }
  function moveToSprint(i, sprintId, actor) {
    if (i.sprintId === sprintId) return;
    i.history.push({ field: 'sprintId', from: i.sprintId, to: sprintId, actorId: actor.id, at: iso() });
    i.sprintId = sprintId; i.updatedAt = iso();
  }

  // ---------- CSV ----------
  const CSV_HEAD = ['key', 'type', 'title', 'status', 'priority', 'assignee', 'labels', 'storyPoints', 'parent', 'epic', 'sprint', 'dueDate', 'createdAt', 'resolvedAt'];
  function exportCsv(p) {
    const rows = [CSV_HEAD];
    const key = id => (db.issues.find(x => x.id === id) || {}).key || '';
    for (const i of db.issues.filter(x => x.projectId === p.id)) {
      rows.push([i.key, i.type, i.title, i.status, i.priority, i.assigneeId ? (user(i.assigneeId) || {}).username : '', i.labels.join(';'),
        i.storyPoints ?? '', i.parentId ? key(i.parentId) : '', i.epicId ? key(i.epicId) : '', i.sprintId ? (db.sprints.find(s => s.id === i.sprintId) || {}).name || '' : '', i.dueDate || '', i.createdAt, i.resolvedAt || '']);
    }
    return toCsv(rows);
  }
  function importCsv(p, actor, text) {
    let recs; try { recs = parseCsv(text); } catch (e) { throw bad('malformed CSV: ' + e.message); }
    if (!recs.length) throw bad('empty CSV');
    const head = recs[0].cells.map(h => h.trim());
    if (!head.includes('title')) throw bad('CSV header must include title');
    let created = 0; const errors = [];
    for (const r of recs.slice(1)) {
      const row = {}; head.forEach((h, n) => { row[h] = (r.cells[n] ?? '').trim(); });
      try {
        if (r.cells.length > head.length) throw bad('too many columns');
        const b = { title: row.title };
        if (row.type) b.type = row.type;
        if (row.status) b.status = row.status;
        if (row.priority) b.priority = row.priority;
        if (row.assignee) { const u = userByName(row.assignee); if (!u) throw bad('unknown assignee ' + row.assignee); b.assigneeId = u.id; }
        if (row.labels) b.labels = row.labels.split(';').map(x => x.trim()).filter(Boolean);
        if (row.storyPoints) { const n = Number(row.storyPoints); if (!isFinite(n)) throw bad('invalid storyPoints'); b.storyPoints = n; }
        if (row.parent) { const x = resolveRef(p, row.parent); if (!x) throw bad('unknown parent ' + row.parent); b.parentId = x.id; }
        if (row.epic) { const x = resolveRef(p, row.epic); if (!x) throw bad('unknown epic ' + row.epic); b.epicId = x.id; }
        if (row.sprint) { const s = db.sprints.find(x => x.projectId === p.id && (x.id === row.sprint || x.name === row.sprint)); if (!s) throw bad('unknown sprint ' + row.sprint); b.sprintId = s.id; }
        if (row.dueDate) b.dueDate = row.dueDate;
        createIssue(p, actor, b);
        created++;
      } catch (e) { if (e instanceof HttpError) errors.push({ line: r.line, message: e.message }); else throw e; }
    }
    return { created, errors };
  }

  // ---------- auth ----------
  function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) { return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex'); }
  function checkPw(pw, stored) {
    const [salt, h] = stored.split(':'); const c = crypto.scryptSync(pw, salt, 32).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(c), Buffer.from(h));
  }
  function authenticate(req) {
    const h = req.headers.authorization || ''; const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return null; const th = sha(m[1].trim());
    const s = db.sessions.find(x => x.hash === th); if (s) return user(s.userId) || null;
    const t = db.tokens.find(x => x.hash === th); if (t) { t.lastUsedAt = iso(); return user(t.userId) || null; }
    return null;
  }

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, fn, opts = {}) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '([^/]+)') + '$'), fn, ...opts });
  const R = route;
  const ok = (body, status = 200) => ({ status, body });
  const body = c => { if (!c.body || typeof c.body !== 'object' || Array.isArray(c.body)) throw bad('JSON object body required'); return c.body; };

  R('POST', '/api/auth/register', c => {
    const b = body(c);
    if (!isStr(b.username) || !/^[A-Za-z0-9_.-]{3,32}$/.test(b.username)) throw bad('username must be 3-32 chars [A-Za-z0-9_.-]');
    if (!isStr(b.password) || b.password.length < 8) throw bad('password must be at least 8 characters');
    if (b.displayName != null && !isStr(b.displayName)) throw bad('invalid displayName');
    if (userByName(b.username)) throw conflict('conflict', 'username taken');
    const u = { id: nid(), username: b.username, displayName: b.displayName || b.username, passwordHash: hashPw(b.password), createdAt: iso() };
    db.users.push(u); return ok(pubUser(u), 201);
  }, { anon: true });
  R('POST', '/api/auth/login', c => {
    const b = body(c); if (!isStr(b.username) || !isStr(b.password)) throw bad('username and password required');
    const k = b.username.toLowerCase(); const t = now().getTime();
    const f = (failures.get(k) || []).filter(x => t - x < 60000);
    if (f.length >= 5) throw new HttpError(429, 'rate_limited', 'too many failed attempts');
    const u = userByName(b.username);
    if (!u || !checkPw(b.password, u.passwordHash)) { f.push(t); failures.set(k, f); throw new HttpError(401, 'unauthorized', 'invalid credentials'); }
    failures.delete(k);
    const token = crypto.randomBytes(32).toString('hex');
    db.sessions.push({ id: nid(), hash: sha(token), userId: u.id, createdAt: iso() });
    return ok({ token, user: pubUser(u) });
  }, { anon: true });
  R('POST', '/api/auth/logout', c => {
    const th = sha(/^Bearer\s+(.+)$/i.exec(c.req.headers.authorization)[1].trim());
    db.sessions = db.sessions.filter(s => s.hash !== th); return { status: 204 };
  });
  R('GET', '/api/auth/me', c => ok(pubUser(c.u)));
  R('PATCH', '/api/auth/me', c => {
    const b = body(c);
    if ('displayName' in b && (!isStr(b.displayName) || !b.displayName.trim())) throw bad('invalid displayName');
    if ('password' in b) {
      if (!isStr(b.password) || b.password.length < 8) throw bad('password must be at least 8 characters');
      if (!isStr(b.currentPassword)) throw bad('currentPassword required');
      if (!checkPw(b.currentPassword, c.u.passwordHash)) throw forbidden('current password incorrect');
      c.u.passwordHash = hashPw(b.password);
    }
    if ('displayName' in b) c.u.displayName = b.displayName.trim();
    return ok(pubUser(c.u));
  });
  R('POST', '/api/tokens', c => {
    const b = body(c); if (!isStr(b.name) || !b.name.trim()) throw bad('name required');
    const token = 'pm_' + crypto.randomBytes(24).toString('hex');
    const t = { id: nid(), userId: c.u.id, name: b.name.trim(), hash: sha(token), createdAt: iso() };
    db.tokens.push(t);
    for (const w of db.workspaces) if (wsRole(c.u, w)) audit(w.id, c.u.id, 'token.created', { tokenId: t.id, name: t.name });
    return ok({ id: t.id, name: t.name, token }, 201);
  });
  R('GET', '/api/tokens', c => ok(db.tokens.filter(t => t.userId === c.u.id).map(t => ({ id: t.id, name: t.name, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt || null }))));
  R('DELETE', '/api/tokens/:id', c => {
    const t = db.tokens.find(x => x.id === c.p[0] && x.userId === c.u.id); if (!t) throw notFound('token not found');
    db.tokens = db.tokens.filter(x => x !== t);
    for (const w of db.workspaces) if (wsRole(c.u, w)) audit(w.id, c.u.id, 'token.deleted', { tokenId: t.id, name: t.name });
    return { status: 204 };
  });

  // workspaces
  const wsOut = (w, u) => ({ id: w.id, name: w.name, key: w.key, role: wsRole(u, w), members: w.members.map(m => ({ userId: m.userId, username: (user(m.userId) || {}).username, displayName: (user(m.userId) || {}).displayName, role: m.role })) });
  R('POST', '/api/workspaces', c => {
    const b = body(c);
    if (!isStr(b.name) || !b.name.trim()) throw bad('name required');
    if (!isStr(b.key) || !/^[A-Z]{2,10}$/.test(b.key)) throw bad('key must be 2-10 uppercase letters');
    if (db.workspaces.some(w => w.key === b.key)) throw conflict('conflict', 'workspace key taken');
    const w = { id: nid(), name: b.name.trim(), key: b.key, members: [{ userId: c.u.id, role: 'admin' }], createdAt: iso() };
    db.workspaces.push(w); audit(w.id, c.u.id, 'workspace.created', { key: w.key });
    return ok(wsOut(w, c.u), 201);
  });
  R('GET', '/api/workspaces', c => ok(db.workspaces.filter(w => wsRole(c.u, w)).map(w => wsOut(w, c.u))));
  R('GET', '/api/workspaces/:id', c => ok(wsOut(getWs(c.u, c.p[0]), c.u)));
  R('POST', '/api/workspaces/:id/members', c => {
    const w = adminWs(c.u, c.p[0]); const b = body(c);
    if (!['admin', 'member', 'guest'].includes(b.role)) throw bad('invalid role');
    const u = userByName(b.username); if (!u) throw notFound('user not found');
    if (w.members.some(m => m.userId === u.id)) throw conflict('conflict', 'already a member');
    w.members.push({ userId: u.id, role: b.role }); audit(w.id, c.u.id, 'member.added', { userId: u.id, username: u.username, role: b.role });
    return ok(wsOut(w, c.u), 201);
  });
  const findWsMember = (w, ref) => { const m = w.members.find(x => x.userId === ref || (user(x.userId) || {}).username === ref); if (!m) throw notFound('member not found'); return m; };
  const adminCount = w => w.members.filter(m => m.role === 'admin').length;
  R('PATCH', '/api/workspaces/:id/members/:uid', c => {
    const w = adminWs(c.u, c.p[0]); const b = body(c); const m = findWsMember(w, c.p[1]);
    if (!['admin', 'member', 'guest'].includes(b.role)) throw bad('invalid role');
    if (m.role === 'admin' && b.role !== 'admin' && adminCount(w) <= 1) throw bad('cannot demote the last admin');
    const from = m.role; m.role = b.role; audit(w.id, c.u.id, 'member.role_changed', { userId: m.userId, from, to: b.role });
    return ok(wsOut(w, c.u));
  });
  R('DELETE', '/api/workspaces/:id/members/:uid', c => {
    const w = adminWs(c.u, c.p[0]); const m = findWsMember(w, c.p[1]);
    if (m.role === 'admin' && adminCount(w) <= 1) throw bad('cannot remove the last admin');
    w.members = w.members.filter(x => x !== m);
    for (const p of db.projects) if (p.workspaceId === w.id) p.members = p.members.filter(x => x.userId !== m.userId);
    audit(w.id, c.u.id, 'member.removed', { userId: m.userId }); return { status: 204 };
  });
  R('GET', '/api/workspaces/:id/audit', c => {
    const w = adminWs(c.u, c.p[0]);
    return ok(db.audit.filter(a => a.workspaceId === w.id).reverse());
  });

  // projects
  const projOut = (p, u) => ({ id: p.id, workspaceId: p.workspaceId, name: p.name, key: p.key, workflow: p.workflow, role: projRole(u, p), members: p.members.map(m => ({ userId: m.userId, username: (user(m.userId) || {}).username, role: m.role })) });
  R('POST', '/api/workspaces/:id/projects', c => {
    const w = getWs(c.u, c.p[0]); if (wsRole(c.u, w) === 'guest') throw forbidden('guests cannot create projects');
    const b = body(c);
    if (!isStr(b.name) || !b.name.trim()) throw bad('name required');
    if (!isStr(b.key) || !/^[A-Z]{2,10}$/.test(b.key)) throw bad('key must be 2-10 uppercase letters');
    if (db.projects.some(p => p.key === b.key)) throw conflict('conflict', 'project key taken');
    const statuses = DEFAULT_STATUSES.map(([name, category]) => ({ name, category }));
    const transitions = []; for (const a of statuses) for (const z of statuses) if (a !== z) transitions.push([a.name, z.name]);
    const p = { id: nid(), workspaceId: w.id, name: b.name.trim(), key: b.key, counter: 0, members: [{ userId: c.u.id, role: 'lead' }], workflow: { statuses, transitions }, createdAt: iso() };
    db.projects.push(p); return ok(projOut(p, c.u), 201);
  });
  R('GET', '/api/workspaces/:id/projects', c => { const w = getWs(c.u, c.p[0]); return ok(db.projects.filter(p => p.workspaceId === w.id && projRole(c.u, p)).map(p => projOut(p, c.u))); });
  R('GET', '/api/projects/:id', c => ok(projOut(getProject(c.u, c.p[0]), c.u)));
  R('POST', '/api/projects/:id/members', c => {
    const p = getProject(c.u, c.p[0], 'lead'); const b = body(c);
    if (!['lead', 'developer', 'viewer'].includes(b.role)) throw bad('invalid role');
    const u = userByName(b.username); if (!u) throw notFound('user not found');
    const w = ws(p.workspaceId); if (!wsRole(u, w)) throw bad('user must be a workspace member');
    if (p.members.some(m => m.userId === u.id)) throw conflict('conflict', 'already a project member');
    p.members.push({ userId: u.id, role: b.role }); audit(w.id, c.u.id, 'project.member_added', { projectId: p.id, userId: u.id, role: b.role });
    return ok(projOut(p, c.u), 201);
  });
  R('PATCH', '/api/projects/:id/members/:uid', c => {
    const p = getProject(c.u, c.p[0], 'lead'); const b = body(c);
    if (!['lead', 'developer', 'viewer'].includes(b.role)) throw bad('invalid role');
    const m = p.members.find(x => x.userId === c.p[1] || (user(x.userId) || {}).username === c.p[1]); if (!m) throw notFound('member not found');
    m.role = b.role; audit(p.workspaceId, c.u.id, 'project.member_role_changed', { projectId: p.id, userId: m.userId, role: b.role });
    return ok(projOut(p, c.u));
  });
  R('DELETE', '/api/projects/:id/members/:uid', c => {
    const p = getProject(c.u, c.p[0], 'lead');
    const m = p.members.find(x => x.userId === c.p[1] || (user(x.userId) || {}).username === c.p[1]); if (!m) throw notFound('member not found');
    p.members = p.members.filter(x => x !== m); audit(p.workspaceId, c.u.id, 'project.member_removed', { projectId: p.id, userId: m.userId });
    return { status: 204 };
  });
  R('PUT', '/api/projects/:id/workflow', c => {
    const p = getProject(c.u, c.p[0], 'lead'); const b = body(c);
    if (!Array.isArray(b.statuses) || !b.statuses.length) throw bad('statuses required');
    const names = new Set();
    for (const s of b.statuses) {
      if (!s || !isStr(s.name) || !s.name.trim() || !CATS.includes(s.category)) throw bad('each status needs name and valid category');
      if (names.has(s.name)) throw bad('duplicate status ' + s.name); names.add(s.name);
    }
    let transitions = b.transitions;
    if (transitions == null) { transitions = []; for (const a of names) for (const z of names) if (a !== z) transitions.push([a, z]); }
    if (!Array.isArray(transitions) || !transitions.every(t => Array.isArray(t) && t.length === 2 && names.has(t[0]) && names.has(t[1]))) throw bad('transitions must reference defined statuses');
    const remap = b.remap == null ? {} : b.remap;
    if (typeof remap !== 'object' || Array.isArray(remap)) throw bad('invalid remap');
    const issues = db.issues.filter(i => i.projectId === p.id);
    const used = new Set(issues.map(i => i.status));
    for (const s of used) if (!names.has(s)) { if (!isStr(remap[s]) || !names.has(remap[s])) throw bad(`status "${s}" is in use and needs a remap`); }
    const t = iso();
    p.workflow = { statuses: b.statuses.map(s => ({ name: s.name, category: s.category })), transitions: transitions.map(x => [x[0], x[1]]) };
    for (const i of issues) if (!names.has(i.status)) {
      const to = remap[i.status];
      i.history.push({ field: 'status', from: i.status, to, actorId: c.u.id, at: t }); i.status = to; i.updatedAt = t;
      i.resolvedAt = catOf(p, to) === 'completed' ? (i.resolvedAt || t) : null;
    }
    audit(p.workspaceId, c.u.id, 'workflow.updated', { projectId: p.id, statuses: p.workflow.statuses.map(s => s.name) });
    return ok(p.workflow);
  });

  // issues
  R('POST', '/api/projects/:id/issues', c => {
    const p = getProject(c.u, c.p[0], 'write'); const i = createIssue(p, c.u, body(c), { allowStatus: false }); return ok(detail(i), 201);
  });
  R('GET', '/api/projects/:id/issues', c => {
    const p = getProject(c.u, c.p[0]);
    return ok(sortIssues(db.issues.filter(i => i.projectId === p.id), c.q.get('sort')).map(issueOut));
  });
  R('GET', '/api/issues/:key', c => ok(detail(getIssue(c.u, c.p[0])[0])));
  R('PATCH', '/api/issues/:key', c => { const [i, p] = getIssue(c.u, c.p[0], 'write'); patchIssue(i, p, c.u, body(c)); return ok(detail(i)); });
  R('DELETE', '/api/issues/:key', c => { const [i, p] = getIssue(c.u, c.p[0], 'write'); deleteIssue(i, p, c.u); return { status: 204 }; });
  R('GET', '/api/issues/:key/history', c => { const [i] = getIssue(c.u, c.p[0]); return ok(i.history.map(h => ({ field: h.field, from: h.from, to: h.to, actorId: h.actorId, at: h.at }))); });
  R('POST', '/api/issues/:key/links', c => {
    const [i, p] = getIssue(c.u, c.p[0], 'write'); const b = body(c);
    if (!INVERSE[b.type]) throw bad('invalid link type');
    if (!isStr(b.target)) throw bad('target required');
    const t = db.issues.find(x => x.key === b.target);
    if (!t || !projRole(c.u, project(t.projectId))) throw bad('target not found');
    if (t.id === i.id) throw bad('cannot link to itself');
    if (i.links.some(l => l.type === b.type && l.target === t.key)) throw conflict('conflict', 'link exists');
    const id = nid();
    i.links.push({ id, type: b.type, target: t.key }); t.links.push({ id, type: INVERSE[b.type], target: i.key });
    void p; return ok(detail(i), 201);
  });
  R('DELETE', '/api/issues/:key/links/:lid', c => {
    const [i] = getIssue(c.u, c.p[0], 'write'); const l = i.links.find(x => x.id === c.p[1]); if (!l) throw notFound('link not found');
    for (const x of db.issues) x.links = x.links.filter(y => y.id !== l.id); return { status: 204 };
  });
  R('POST', '/api/issues/:key/watch', c => { const [i] = getIssue(c.u, c.p[0]); if (!i.watchers.includes(c.u.id)) i.watchers.push(c.u.id); return ok(detail(i)); });
  R('DELETE', '/api/issues/:key/watch', c => { const [i] = getIssue(c.u, c.p[0]); i.watchers = i.watchers.filter(w => w !== c.u.id); return ok(detail(i)); });

  // comments
  const commentOut = m => ({ id: m.id, issueKey: (db.issues.find(i => i.id === m.issueId) || {}).key, authorId: m.authorId, body: m.body, createdAt: m.createdAt, updatedAt: m.updatedAt, edited: m.edited });
  R('POST', '/api/issues/:key/comments', c => {
    const [i, p] = getIssue(c.u, c.p[0], 'write'); const b = body(c);
    if (!isStr(b.body) || !b.body.trim()) throw bad('body required');
    const t = iso(); const m = { id: nid(), issueId: i.id, authorId: c.u.id, body: b.body, createdAt: t, updatedAt: t, edited: false };
    db.comments.push(m);
    const mentioned = new Set();
    for (const x of b.body.matchAll(/@([A-Za-z0-9_.-]+)/g)) { const u = userByName(x[1].replace(/[.]+$/, '')); if (u && u.id !== c.u.id && userCanSeeProject(u.id, p)) mentioned.add(u.id); }
    for (const id of mentioned) notify(id, 'mention', i, c.u.id);
    for (const w of i.watchers) if (w !== c.u.id && !mentioned.has(w) && userCanSeeProject(w, p)) notify(w, 'comment', i, c.u.id);
    i.updatedAt = t;
    fire(p, 'comment.created', i, c.u.id, { comment: commentOut(m) });
    return ok(commentOut(m), 201);
  });
  R('GET', '/api/issues/:key/comments', c => { const [i] = getIssue(c.u, c.p[0]); return ok(db.comments.filter(m => m.issueId === i.id).map(commentOut)); });
  const getComment = (c, own) => {
    const m = db.comments.find(x => x.id === c.p[0]); if (!m) throw notFound('comment not found');
    const i = db.issues.find(x => x.id === m.issueId); const p = project(i.projectId); const r = projRole(c.u, p); if (!r) throw notFound('comment not found');
    if (m.authorId !== c.u.id && (own || r !== 'lead')) throw forbidden('not your comment');
    return m;
  };
  R('PATCH', '/api/comments/:id', c => {
    const m = getComment(c, true); const b = body(c); if (!isStr(b.body) || !b.body.trim()) throw bad('body required');
    m.body = b.body; m.edited = true; m.updatedAt = iso(); return ok(commentOut(m));
  });
  R('DELETE', '/api/comments/:id', c => { const m = getComment(c, false); db.comments = db.comments.filter(x => x !== m); return { status: 204 }; });

  // notifications
  const notifOut = n => ({ id: n.id, type: n.type, issueKey: n.issueKey, actorId: n.actorId, at: n.at, read: n.read });
  R('GET', '/api/notifications', c => {
    let l = db.notifications.filter(n => n.userId === c.u.id); if (c.q.get('unread') === 'true') l = l.filter(n => !n.read);
    return ok(l.slice().reverse().map(notifOut));
  });
  R('POST', '/api/notifications/read', c => {
    const b = body(c);
    if (b.all === true) for (const n of db.notifications) { if (n.userId === c.u.id) n.read = true; }
    else if (Array.isArray(b.ids) && arrOfStrings(b.ids)) { for (const n of db.notifications) if (n.userId === c.u.id && b.ids.includes(n.id)) n.read = true; }
    else throw bad('ids or all required');
    return ok({ ok: true });
  });

  // sprints
  const sprintOut = s => ({ id: s.id, projectId: s.projectId, name: s.name, state: s.state, startDate: s.startDate || null, endDate: s.endDate || null, startedAt: s.startedAt || null, completedAt: s.completedAt || null });
  const getSprint = (c, need) => { const s = db.sprints.find(x => x.id === c.p[0]); if (!s) throw notFound('sprint not found'); const p = getProject(c.u, s.projectId, need); return [s, p]; };
  R('POST', '/api/projects/:id/sprints', c => {
    const p = getProject(c.u, c.p[0], 'write'); const b = body(c);
    if (!isStr(b.name) || !b.name.trim()) throw bad('name required');
    for (const f of ['startDate', 'endDate']) if (b[f] != null && !isDate(b[f])) throw bad('invalid ' + f);
    if (b.startDate && b.endDate && b.endDate < b.startDate) throw bad('endDate before startDate');
    const s = { id: nid(), projectId: p.id, name: b.name.trim(), state: 'planned', startDate: b.startDate || null, endDate: b.endDate || null, createdAt: iso() };
    db.sprints.push(s); return ok(sprintOut(s), 201);
  });
  R('GET', '/api/projects/:id/sprints', c => { const p = getProject(c.u, c.p[0]); return ok(db.sprints.filter(s => s.projectId === p.id).map(sprintOut)); });
  R('POST', '/api/sprints/:id/start', c => {
    const [s, p] = getSprint(c, 'write');
    if (s.state !== 'planned') throw conflict('conflict', 'sprint is not planned');
    if (db.sprints.some(x => x.projectId === p.id && x.state === 'active')) throw conflict('conflict', 'another sprint is active');
    s.state = 'active'; s.startedAt = iso(); if (!s.startDate) s.startDate = s.startedAt.slice(0, 10);
    s.committedPoints = db.issues.filter(i => i.sprintId === s.id).reduce((a, i) => a + (i.storyPoints || 0), 0);
    return ok(sprintOut(s));
  });
  R('POST', '/api/sprints/:id/complete', c => {
    const [s, p] = getSprint(c, 'write'); const b = body(c);
    if (s.state !== 'active') throw conflict('conflict', 'sprint is not active');
    const dest = b.carryOverTo == null ? 'backlog' : b.carryOverTo;
    let target = null;
    if (dest !== 'backlog') { target = db.sprints.find(x => x.id === dest && x.projectId === p.id); if (!target || target.id === s.id || target.state === 'completed') throw bad('invalid carryOverTo'); }
    const mine = db.issues.filter(i => i.sprintId === s.id);
    const done = mine.filter(i => catOf(p, i.status) === 'completed'), open = mine.filter(i => catOf(p, i.status) !== 'completed');
    s.report = { completedPoints: done.reduce((a, i) => a + (i.storyPoints || 0), 0), completedIssues: done.length, carriedOver: open.length };
    for (const i of open) moveToSprint(i, target ? target.id : null, c.u);
    s.state = 'completed'; s.completedAt = iso();
    return ok(sprintOut(s));
  });
  R('GET', '/api/sprints/:id/report', c => { const [s] = getSprint(c); return ok(sprintReport(s)); });
  R('GET', '/api/projects/:id/stats', c => {
    const p = getProject(c.u, c.p[0]); const list = db.issues.filter(i => i.projectId === p.id);
    const byStatus = Object.fromEntries(p.workflow.statuses.map(s => [s.name, 0])), byType = {}, byAssignee = {};
    let sum = 0, n = 0;
    for (const i of list) {
      byStatus[i.status] = (byStatus[i.status] || 0) + 1; byType[i.type] = (byType[i.type] || 0) + 1;
      const a = i.assigneeId ? (user(i.assigneeId) || {}).username : 'unassigned'; byAssignee[a] = (byAssignee[a] || 0) + 1;
      if (i.resolvedAt) {
        let started = i.createdAt;
        const h = i.history.find(x => x.field === 'status' && catOf(p, x.to) === 'started');
        if (h) started = h.at; else if (catOf(p, i.history.find(x => x.field === 'status')?.from ?? '') === 'started') started = i.createdAt;
        sum += Math.max(0, (Date.parse(i.resolvedAt) - Date.parse(started)) / 36e5); n++;
      }
    }
    const avg = n ? sum / n : null;
    return ok({ total: list.length, byStatus, byType, byAssignee, averageCycleTimeHours: avg, avgCycleTimeHours: avg, resolvedCount: n });
  });

  // search / csv
  R('GET', '/api/search', c => ok(runSearch(c.u, c.q.get('q') || '', c.q.get('project'), c.q.get('sort'))));
  R('GET', '/api/projects/:id/export.csv', c => { const p = getProject(c.u, c.p[0]); return { status: 200, raw: exportCsv(p), type: 'text/csv; charset=utf-8' }; });
  R('POST', '/api/projects/:id/import.csv', c => { const p = getProject(c.u, c.p[0], 'write'); return ok(importCsv(p, c.u, c.text || '')); }, { raw: true });

  // webhooks
  const hookOut = h => ({ id: h.id, projectId: h.projectId, url: h.url, events: h.events, createdAt: h.createdAt });
  const EVENTS = ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'];
  R('POST', '/api/projects/:id/webhooks', c => {
    const p = getProject(c.u, c.p[0], 'lead'); const b = body(c);
    let u; try { u = new URL(b.url); } catch { throw bad('invalid url'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw bad('invalid url');
    if (!Array.isArray(b.events) || !b.events.length || !b.events.every(e => EVENTS.includes(e))) throw bad('invalid events');
    if (!isStr(b.secret) || !b.secret) throw bad('secret required');
    const h = { id: nid(), projectId: p.id, url: b.url, events: [...new Set(b.events)], secret: b.secret, createdAt: iso() };
    db.webhooks.push(h); audit(p.workspaceId, c.u.id, 'webhook.created', { webhookId: h.id, url: h.url }); return ok(hookOut(h), 201);
  });
  R('GET', '/api/projects/:id/webhooks', c => { const p = getProject(c.u, c.p[0], 'lead'); return ok(db.webhooks.filter(h => h.projectId === p.id).map(hookOut)); });
  const getHook = (c) => { const h = db.webhooks.find(x => x.id === c.p[0]); if (!h) throw notFound('webhook not found'); return [h, getProject(c.u, h.projectId, 'lead')]; };
  R('DELETE', '/api/webhooks/:id', c => {
    const [h, p] = getHook(c); db.webhooks = db.webhooks.filter(x => x !== h); audit(p.workspaceId, c.u.id, 'webhook.deleted', { webhookId: h.id }); return { status: 204 };
  });
  R('GET', '/api/webhooks/:id/deliveries', c => { const [h] = getHook(c); return ok(db.deliveries.filter(d => d.webhookId === h.id).map(d => ({ id: d.id, event: d.event, status: d.status, attempts: d.attempts, lastError: d.lastError, at: d.at }))); });

  // ---------- http ----------
  function sendJson(res, status, obj) {
    if (status === 204) { res.writeHead(204); return res.end(); }
    const s = JSON.stringify(obj); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) }); res.end(s);
  }
  function serveStatic(res, rel) {
    const f = path.normalize(path.join(STATIC_DIR, rel));
    if (!f.startsWith(STATIC_DIR) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return sendJson(res, 404, { error: 'not_found', message: 'not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); res.end(fs.readFileSync(f));
  }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x'); const pn = url.pathname;
      if (req.method === 'GET' && (pn === '/' || pn === '/index.html')) return serveStatic(res, 'index.html');
      if (req.method === 'GET' && pn.startsWith('/static/')) return serveStatic(res, decodeURIComponent(pn.slice(8)));
      if (!pn.startsWith('/api/')) throw notFound('not found');
      let matched = null, pathMatched = false;
      for (const r of routes) { const m = r.re.exec(pn); if (m) { pathMatched = true; if (r.method === req.method) { matched = { r, p: m.slice(1).map(decodeURIComponent) }; break; } } }
      if (!matched) { if (pathMatched) throw new HttpError(405, 'method_not_allowed', 'method not allowed'); throw notFound('not found'); }
      const chunks = []; let size = 0;
      for await (const ch of req) { size += ch.length; if (size > 5e6) throw new HttpError(413, 'payload_too_large', 'too large'); chunks.push(ch); }
      const raw = Buffer.concat(chunks).toString('utf8');
      const c = { req, q: url.searchParams, p: matched.p, u: null, body: null, text: raw };
      if (!matched.r.anon) { c.u = authenticate(req); if (!c.u) throw new HttpError(401, 'unauthorized', 'authentication required'); }
      if (!matched.r.raw && raw.trim() && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) { try { c.body = JSON.parse(raw); } catch { throw bad('invalid JSON'); } }
      const out = matched.r.fn(c);
      if (out.raw !== undefined) { res.writeHead(out.status, { 'content-type': out.type }); res.end(out.raw); }
      else sendJson(res, out.status, out.body);
      if (req.method !== 'GET') save();
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.error, message: e.message });
      console.error(e); sendJson(res, 500, { error: 'internal_error', message: 'internal error' });
    }
  });
  return server;
}
