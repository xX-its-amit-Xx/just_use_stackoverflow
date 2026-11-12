import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toCSV, parseCSV } from './csv.js';
import { parseQuery, matches, QueryError } from './search.js';

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');
const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIOS = ['urgent', 'high', 'medium', 'low', 'none'];
const CATS = ['backlog', 'unstarted', 'started', 'completed'];
const WS_ROLES = ['admin', 'member', 'guest'];
const PROJ_ROLES = ['lead', 'developer', 'viewer'];
const LINK_TYPES = ['blocks', 'relates', 'duplicates'];
const EVENTS = ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'];
const CSV_HEADER = ['key', 'type', 'title', 'status', 'priority', 'assignee', 'labels', 'storyPoints', 'parent', 'epic', 'sprint', 'dueDate', 'createdAt', 'resolvedAt'];
const TRACKED = ['type', 'title', 'description', 'status', 'priority', 'assigneeId', 'labels', 'storyPoints', 'parentId', 'epicId', 'sprintId', 'dueDate'];

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const bad = m => new HttpError(400, 'validation', m);
const forbidden = (m = 'forbidden') => new HttpError(403, 'forbidden', m);
const notFound = (m = 'not found') => new HttpError(404, 'not_found', m);
const conflict = (m, code = 'conflict') => new HttpError(409, code, m);

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const uid = () => crypto.randomUUID();
const isStr = v => typeof v === 'string';
const nonEmpty = v => isStr(v) && v.trim().length > 0;
const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const validDate = s => isStr(s) && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: crypto.scryptSync(pw, salt, 32).toString('hex') };
}
function checkPassword(user, pw) {
  const h = crypto.scryptSync(String(pw), user.salt, 32);
  return crypto.timingSafeEqual(h, Buffer.from(user.passwordHash, 'hex'));
}

export function createServer({ dataFile, clock } = {}) {
  const nowDate = () => (clock ? new Date(clock()) : new Date());
  const iso = () => nowDate().toISOString();

  // ---------- storage ----------
  let db = null;
  if (dataFile && fs.existsSync(dataFile)) {
    try { db = JSON.parse(fs.readFileSync(dataFile, 'utf8')); } catch { db = null; }
  }
  if (!db) db = {};
  for (const k of ['users', 'tokens', 'workspaces', 'projects', 'issues', 'comments', 'sprints', 'webhooks', 'deliveries', 'notifications', 'audit']) db[k] ||= [];
  db.seq ||= 0;
  const save = () => {
    if (!dataFile) return;
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, dataFile);
  };
  const failures = new Map();

  // ---------- lookups ----------
  const userById = id => db.users.find(u => u.id === id);
  const userByName = n => isStr(n) ? db.users.find(u => u.username.toLowerCase() === n.toLowerCase()) : undefined;
  const pubUser = u => ({ id: u.id, username: u.username, displayName: u.displayName });
  const usernameOf = id => userById(id)?.username;
  const wsById = id => db.workspaces.find(w => w.id === id);
  const projById = id => db.projects.find(p => p.id === id);
  const sprintById = id => db.sprints.find(s => s.id === id);

  function wsRole(ws, user) { return ws.members.find(m => m.userId === user.id)?.role || null; }
  function projRole(project, user) {
    const ws = wsById(project.workspaceId);
    const r = wsRole(ws, user);
    if (!r) return null;
    if (r === 'admin') return 'lead';
    const pm = project.members.find(m => m.userId === user.id);
    if (pm) return pm.role;
    return r === 'member' ? 'developer' : null;
  }
  const canWrite = r => r === 'lead' || r === 'developer';

  function getProject(id, user, need) {
    const p = projById(id);
    if (!p) throw notFound('project not found');
    const role = projRole(p, user);
    if (!role) throw forbidden('no access to project');
    if (need === 'write' && !canWrite(role)) throw forbidden('insufficient project role');
    if (need === 'lead' && role !== 'lead') throw forbidden('lead role required');
    return { project: p, role };
  }
  function getWorkspace(id, user, needAdmin) {
    const ws = wsById(id);
    if (!ws) throw notFound('workspace not found');
    const role = wsRole(ws, user);
    if (!role) throw forbidden('not a workspace member');
    if (needAdmin && role !== 'admin') throw forbidden('admin required');
    return { ws, role };
  }
  const isKey = s => /^[A-Za-z]+-\d+$/.test(s);
  function getIssue(ref, user, need) {
    let cands = isKey(ref) ? db.issues.filter(i => i.key.toLowerCase() === ref.toLowerCase()) : db.issues.filter(i => i.id === ref);
    if (!cands.length) throw notFound('issue not found');
    let found = null, role = null;
    for (const i of cands) { const p = projById(i.projectId); const r = projRole(p, user); if (r) { found = i; role = r; break; } }
    if (!found) throw forbidden('no access to issue');
    if (need === 'write' && !canWrite(role)) throw forbidden('insufficient project role');
    return { issue: found, project: projById(found.projectId), role };
  }
  const findIssueRef = (ref, projectId) => {
    if (!isStr(ref)) return null;
    return db.issues.find(i => i.projectId === projectId && (i.id === ref || i.key.toLowerCase() === ref.toLowerCase()));
  };
  const catOf = (project, status) => project.workflow.statuses.find(s => s.name === status)?.category;
  const issueCat = i => catOf(projById(i.projectId), i.status);

  // ---------- audit / notifications ----------
  function audit(wsId, action, actorId, details = {}) {
    if (!wsId) return;
    db.audit.push({ id: uid(), workspaceId: wsId, action, type: action, actorId, details, at: iso(), n: ++db.seq });
  }
  function auditUser(userId, action, details) {
    for (const ws of db.workspaces) if (ws.members.some(m => m.userId === userId)) audit(ws.id, action, userId, details);
  }
  function notify(userId, type, issue, actorId) {
    if (userId === actorId) return;
    const u = userById(userId);
    if (!u) return;
    const p = projById(issue.projectId);
    if (!p || !projRole(p, u)) return;
    db.notifications.push({ id: uid(), userId, type, issueKey: issue.key, actorId, at: iso(), read: false, n: ++db.seq });
  }

  // ---------- webhooks ----------
  function fire(event, issue, actorId, extra = {}) {
    const hooks = db.webhooks.filter(w => w.projectId === issue.projectId && w.events.includes(event));
    for (const wh of hooks) {
      const payload = { event, issue: serializeIssue(issue), actorId, at: iso(), ...extra };
      deliver(wh, event, payload);
    }
  }
  function deliver(wh, event, payload) {
    const body = JSON.stringify(payload);
    const sig = 'sha256=' + crypto.createHmac('sha256', wh.secret).update(body).digest('hex');
    const d = { id: uid(), webhookId: wh.id, event, status: null, attempts: 0, lastError: null, createdAt: iso() };
    db.deliveries.push(d);
    (async () => {
      for (let a = 1; a <= 3; a++) {
        d.attempts = a;
        try {
          const res = await fetch(wh.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-pm-signature': sig, 'x-pm-event': event },
            body, signal: AbortSignal.timeout(5000),
          });
          d.status = res.status;
          try { await res.arrayBuffer(); } catch {}
          if (res.status >= 200 && res.status < 300) { d.lastError = null; break; }
          d.lastError = `HTTP ${res.status}`;
        } catch (e) {
          d.lastError = String(e?.message || e);
        }
        save();
        if (a < 3) await new Promise(r => { const t = setTimeout(r, 100 * a); t.unref?.(); });
      }
      save();
    })();
  }

  // ---------- serialization ----------
  function linksOf(issue) {
    const out = [];
    for (const l of issue.links) {
      const t = db.issues.find(i => i.id === l.targetId);
      if (t) out.push({ id: l.id, type: l.type, target: t.key, key: t.key, issueId: t.id, title: t.title });
    }
    for (const o of db.issues) {
      for (const l of o.links) {
        if (l.targetId !== issue.id) continue;
        const type = l.type === 'blocks' ? 'blocked_by' : l.type === 'duplicates' ? 'duplicated_by' : 'relates';
        out.push({ id: l.id, type, target: o.key, key: o.key, issueId: o.id, title: o.title });
      }
    }
    return out;
  }
  function serializeIssue(issue) {
    const o = {
      id: issue.id, key: issue.key, projectId: issue.projectId, type: issue.type, title: issue.title,
      description: issue.description, status: issue.status, priority: issue.priority,
      assigneeId: issue.assigneeId, reporterId: issue.reporterId, labels: [...issue.labels],
      storyPoints: issue.storyPoints, parentId: issue.parentId, epicId: issue.epicId, sprintId: issue.sprintId,
      dueDate: issue.dueDate, watchers: [...issue.watchers], createdAt: issue.createdAt,
      updatedAt: issue.updatedAt, resolvedAt: issue.resolvedAt,
    };
    o.children = db.issues.filter(i => i.parentId === issue.id).map(i => i.key);
    o.links = linksOf(issue);
    if (issue.type === 'epic') {
      const mem = db.issues.filter(i => i.epicId === issue.id);
      o.progress = { total: mem.length, done: 0, points_total: 0, points_done: 0 };
      for (const m of mem) {
        const pts = m.storyPoints || 0;
        o.progress.points_total += pts;
        if (issueCat(m) === 'completed') { o.progress.done++; o.progress.points_done += pts; }
      }
    }
    return o;
  }
  const serializeProject = (p, role) => ({
    id: p.id, workspaceId: p.workspaceId, name: p.name, key: p.key, createdAt: p.createdAt,
    workflow: p.workflow, role,
  });
  const serializeWs = (ws, role) => ({
    id: ws.id, name: ws.name, key: ws.key, createdAt: ws.createdAt, role,
    members: ws.members.map(m => memberOut(m)),
  });
  const memberOut = m => { const u = userById(m.userId); return { userId: m.userId, username: u?.username, displayName: u?.displayName, role: m.role }; };
  const serializeSprint = s => ({
    id: s.id, projectId: s.projectId, name: s.name, startDate: s.startDate, endDate: s.endDate, state: s.state,
    createdAt: s.createdAt, startedAt: s.startedAt, completedAt: s.completedAt,
  });
  const serializeComment = c => ({
    id: c.id, issueId: c.issueId, authorId: c.authorId, body: c.body, createdAt: c.createdAt, updatedAt: c.updatedAt, edited: c.edited,
  });

  // ---------- issue logic ----------
  function resolveUser(ref, project) {
    if (ref === null) return null;
    if (!isStr(ref)) throw bad('assigneeId must be a string or null');
    const u = userById(ref) || userByName(ref);
    if (!u) throw bad('assignee not found');
    if (!projRole(project, u)) throw bad('assignee has no access to project');
    return u.id;
  }

  // validate input fields; returns normalized partial
  function normalizeFields(project, input, existing) {
    const f = {};
    if ('type' in input) { if (!TYPES.includes(input.type)) throw bad('invalid type'); f.type = input.type; }
    if ('title' in input) { if (!nonEmpty(input.title) || input.title.length > 500) throw bad('title is required (max 500 chars)'); f.title = input.title.trim(); }
    if ('description' in input) { if (input.description !== null && !isStr(input.description)) throw bad('invalid description'); f.description = input.description ?? ''; }
    if ('priority' in input) { if (!PRIOS.includes(input.priority)) throw bad('invalid priority'); f.priority = input.priority; }
    if ('status' in input) {
      if (!isStr(input.status) || !project.workflow.statuses.some(s => s.name === input.status)) throw bad('unknown status');
      f.status = input.status;
    }
    if ('assigneeId' in input) f.assigneeId = resolveUser(input.assigneeId, project);
    if ('labels' in input) {
      if (!Array.isArray(input.labels) || input.labels.some(l => !nonEmpty(l))) throw bad('labels must be an array of non-empty strings');
      f.labels = [...new Set(input.labels.map(l => l.trim()))];
    }
    if ('storyPoints' in input) {
      const v = input.storyPoints;
      if (v !== null && (typeof v !== 'number' || !isFinite(v) || v < 0)) throw bad('storyPoints must be a non-negative number or null');
      f.storyPoints = v;
    }
    if ('dueDate' in input) {
      if (input.dueDate !== null && !validDate(input.dueDate)) throw bad('dueDate must be YYYY-MM-DD');
      f.dueDate = input.dueDate;
    }
    for (const k of ['parentId', 'epicId']) {
      if (k in input) {
        if (input[k] === null) f[k] = null;
        else {
          const t = findIssueRef(input[k], project.id);
          if (!t) throw bad(`${k} does not reference an issue in this project`);
          f[k] = t.id;
        }
      }
    }
    if ('sprintId' in input) {
      if (input.sprintId === null) f.sprintId = null;
      else {
        const s = sprintById(input.sprintId);
        if (!s || s.projectId !== project.id) throw bad('sprint not found in this project');
        if (s.state === 'completed' && existing?.sprintId !== s.id) throw bad('sprint is completed');
        f.sprintId = s.id;
      }
    }
    return f;
  }
  function crossValidate(project, merged, selfId) {
    if (merged.type === 'subtask') {
      if (!merged.parentId) throw bad('subtasks require a parentId');
      const p = db.issues.find(i => i.id === merged.parentId);
      if (!p || p.projectId !== project.id) throw bad('parent must be in the same project');
      if (p.type === 'subtask') throw bad('parent cannot be a subtask');
      if (p.id === selfId) throw bad('issue cannot be its own parent');
    } else if (merged.parentId) throw bad(merged.type === 'epic' ? 'epics cannot have parents' : 'only subtasks can have a parent');
    if (merged.epicId) {
      const e = db.issues.find(i => i.id === merged.epicId);
      if (!e || e.projectId !== project.id || e.type !== 'epic') throw bad('epicId must reference an epic');
      if (merged.type === 'epic') throw bad('epics cannot belong to epics');
    }
  }
  function applyChanges(issue, fields, actorId, { skipTransition = false, event = true } = {}) {
    const project = projById(issue.projectId);
    const at = iso();
    if ('status' in fields && fields.status !== issue.status && !skipTransition) {
      const ok = project.workflow.transitions.some(([a, b]) => a === issue.status && b === fields.status);
      if (!ok) throw conflict(`transition ${issue.status} -> ${fields.status} not allowed`, 'invalid_transition');
      if (catOf(project, fields.status) === 'completed') {
        for (const l of linksTo(issue)) {
          const blocker = l;
          if (issueCat(blocker) !== 'completed') throw conflict(`blocked by ${blocker.key}`, 'blocked');
        }
      }
    }
    const changed = [];
    for (const k of TRACKED) {
      if (!(k in fields)) continue;
      if (eq(issue[k], fields[k])) continue;
      issue.history.push({ field: k, from: issue[k], to: fields[k], actorId, at });
      const old = issue[k];
      issue[k] = fields[k];
      changed.push([k, old]);
    }
    if (!changed.length) return false;
    issue.updatedAt = at;
    for (const [k] of changed) {
      if (k === 'status') {
        const c = catOf(project, issue.status);
        if (c === 'completed') { if (!issue.resolvedAt) issue.resolvedAt = at; }
        else issue.resolvedAt = null;
        if (c === 'started' && !issue.startedAt) issue.startedAt = at;
      }
    }
    for (const [k] of changed) {
      if (k === 'assigneeId' && issue.assigneeId && !issue.watchers.includes(issue.assigneeId)) issue.watchers.push(issue.assigneeId);
    }
    for (const [k] of changed) {
      if (k === 'status') for (const w of issue.watchers) notify(w, 'status_change', issue, actorId);
      if (k === 'assigneeId' && issue.assigneeId) for (const w of issue.watchers) notify(w, 'assignment', issue, actorId);
    }
    if (event) fire('issue.updated', issue, actorId);
    return true;
  }
  // issues that block `issue` (blocked_by)
  function linksTo(issue) {
    const out = [];
    for (const o of db.issues) for (const l of o.links) if (l.type === 'blocks' && l.targetId === issue.id) out.push(o);
    return out;
  }
  function createIssue(project, input, user, { skipEvent = false } = {}) {
    const f = normalizeFields(project, input, null);
    if (!f.title) throw bad('title is required');
    const type = f.type || 'task';
    const merged = { type, parentId: f.parentId ?? null, epicId: f.epicId ?? null };
    crossValidate(project, merged, null);
    const at = iso();
    const wf = project.workflow.statuses;
    const status = f.status || (wf.find(s => s.category === 'unstarted') || wf[0]).name;
    const cat = catOf(project, status);
    project.issueCounter = (project.issueCounter || 0) + 1;
    const issue = {
      id: uid(), key: `${project.key}-${project.issueCounter}`, projectId: project.id, type, title: f.title,
      description: f.description ?? '', status, priority: f.priority || 'none', assigneeId: f.assigneeId ?? null,
      reporterId: user.id, labels: f.labels || [], storyPoints: f.storyPoints ?? null, parentId: merged.parentId,
      epicId: merged.epicId, sprintId: f.sprintId ?? null, dueDate: f.dueDate ?? null, watchers: [],
      createdAt: at, updatedAt: at, resolvedAt: cat === 'completed' ? at : null,
      startedAt: cat === 'started' ? at : null, links: [], history: [],
    };
    issue.watchers.push(user.id);
    if (issue.assigneeId && !issue.watchers.includes(issue.assigneeId)) issue.watchers.push(issue.assigneeId);
    db.issues.push(issue);
    if (issue.assigneeId) notify(issue.assigneeId, 'assignment', issue, user.id);
    if (!skipEvent) fire('issue.created', issue, user.id);
    return issue;
  }
  function deleteIssue(issue, actorId, fireEvents = true) {
    for (const c of db.issues.filter(i => i.parentId === issue.id)) deleteIssue(c, actorId, fireEvents);
    for (const e of db.issues.filter(i => i.epicId === issue.id)) e.epicId = null;
    for (const o of db.issues) o.links = o.links.filter(l => l.targetId !== issue.id);
    db.comments = db.comments.filter(c => c.issueId !== issue.id);
    db.issues = db.issues.filter(i => i !== issue);
    if (fireEvents) fire('issue.deleted', issue, actorId);
  }

  // ---------- http plumbing ----------
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    routes.push({ method, parts: pattern.split('/').filter(Boolean), handler, ...opts });
  };
  function matchRoute(method, pathname) {
    const segs = pathname.split('/').filter(Boolean).map(s => { try { return decodeURIComponent(s); } catch { return s; } });
    let pathMatched = false;
    for (const r of routes) {
      if (r.parts.length !== segs.length) continue;
      const params = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        if (r.parts[i][0] === ':') params[r.parts[i].slice(1)] = segs[i];
        else if (r.parts[i] !== segs[i]) { ok = false; break; }
      }
      if (!ok) continue;
      pathMatched = true;
      if (r.method === method) return { r, params };
    }
    return { pathMatched };
  }
  function send(res, status, body, headers = {}) {
    if (body === undefined) { res.writeHead(status, headers); return res.end(); }
    if (typeof body === 'string') { res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', ...headers }); return res.end(body); }
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(body));
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      req.on('data', c => { size += c.length; if (size > 10 * 1024 * 1024) { reject(new HttpError(413, 'too_large', 'body too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }
  function authenticate(req) {
    const h = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return null;
    const hash = sha(m[1].trim());
    const t = db.tokens.find(t => t.hash === hash);
    if (!t) return null;
    const user = userById(t.userId);
    return user ? { user, token: t } : null;
  }
  function serveStatic(res, pathname) {
    let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/static\//, '');
    const full = path.normalize(path.join(STATIC_DIR, rel));
    if (!full.startsWith(STATIC_DIR + path.sep) && full !== path.join(STATIC_DIR, 'index.html')) return send(res, 404, { error: 'not_found', message: 'not found' });
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return send(res, 404, { error: 'not_found', message: 'not found' });
    const ext = path.extname(full);
    const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
    res.writeHead(200, { 'content-type': types[ext] || 'application/octet-stream' });
    res.end(fs.readFileSync(full));
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://x');
    const method = req.method;
    try {
      if (method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/static/'))) return serveStatic(res, url.pathname);
      if (!url.pathname.startsWith('/api/')) throw notFound('route not found');
      const m = matchRoute(method, url.pathname);
      if (!m.r) {
        if (m.pathMatched) throw new HttpError(405, 'method_not_allowed', 'method not allowed');
        throw notFound('route not found');
      }
      const raw = await readBody(req);
      const ctx = { req, res, params: m.params, query: url.searchParams, raw, body: {}, user: null };
      if (!m.r.public) {
        const a = authenticate(req);
        if (!a) throw new HttpError(401, 'unauthenticated', 'authentication required');
        ctx.user = a.user; ctx.auth = a;
      }
      if (!m.r.raw) {
        if (raw.trim()) {
          try { ctx.body = JSON.parse(raw); } catch { throw bad('invalid JSON body'); }
          if (!isObj(ctx.body)) throw bad('body must be a JSON object');
        }
      }
      const result = await m.r.handler(ctx);
      if (method !== 'GET') save();
      if (result === undefined) return send(res, 204);
      send(res, result.status || 200, result.body, result.headers);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.code, message: e.message });
      console.error(e);
      send(res, 500, { error: 'internal', message: 'internal server error' });
    }
  }
  const ok = (body, status = 200, headers) => ({ status, body, headers });

  // ---------- auth routes ----------
  route('POST', '/api/auth/register', ({ body }) => {
    const { username, password, displayName } = body;
    if (!isStr(username) || !/^[A-Za-z0-9_.-]{3,32}$/.test(username)) throw bad('username must be 3-32 chars (letters, digits, _ . -)');
    if (!isStr(password) || password.length < 8) throw bad('password must be at least 8 characters');
    if (displayName !== undefined && (!isStr(displayName) || displayName.length > 100)) throw bad('invalid displayName');
    if (userByName(username)) throw conflict('username taken');
    const { salt, hash } = hashPassword(password);
    const u = { id: uid(), username, displayName: displayName?.trim() || username, salt, passwordHash: hash, createdAt: iso() };
    db.users.push(u);
    return ok({ user: pubUser(u) }, 201);
  }, { public: true });

  route('POST', '/api/auth/login', ({ body }) => {
    const { username, password } = body;
    if (!isStr(username) || !isStr(password)) throw bad('username and password required');
    const key = username.toLowerCase();
    const cutoff = nowDate().getTime() - 15 * 60 * 1000;
    const recent = (failures.get(key) || []).filter(t => t > cutoff);
    failures.set(key, recent);
    if (recent.length >= 5) throw new HttpError(429, 'rate_limited', 'too many failed login attempts');
    const u = userByName(username);
    if (!u || !checkPassword(u, password)) {
      recent.push(nowDate().getTime());
      throw new HttpError(401, 'invalid_credentials', 'invalid username or password');
    }
    failures.delete(key);
    const token = crypto.randomBytes(32).toString('hex');
    db.tokens.push({ id: uid(), hash: sha(token), userId: u.id, kind: 'session', createdAt: iso() });
    return ok({ token, user: pubUser(u) });
  }, { public: true });

  route('POST', '/api/auth/logout', ({ auth }) => {
    if (auth.token.kind === 'session') db.tokens = db.tokens.filter(t => t !== auth.token);
    return undefined;
  });
  route('GET', '/api/auth/me', ({ user }) => ok({ user: pubUser(user) }));
  route('PATCH', '/api/auth/me', ({ user, body }) => {
    const { displayName, password, currentPassword } = body;
    if (displayName !== undefined && (!nonEmpty(displayName) || displayName.length > 100)) throw bad('invalid displayName');
    if (password !== undefined) {
      if (!isStr(password) || password.length < 8) throw bad('password must be at least 8 characters');
      if (!isStr(currentPassword)) throw bad('currentPassword required');
    }
    if (currentPassword !== undefined || password !== undefined) {
      if (!isStr(currentPassword) || !checkPassword(user, currentPassword)) {
        if (password !== undefined) throw forbidden('current password incorrect');
      }
    }
    if (displayName !== undefined) user.displayName = displayName.trim();
    if (password !== undefined) { const h = hashPassword(password); user.salt = h.salt; user.passwordHash = h.hash; }
    return ok({ user: pubUser(user) });
  });

  // ---------- API tokens ----------
  route('POST', '/api/tokens', ({ user, body }) => {
    if (!nonEmpty(body.name)) throw bad('name required');
    const token = 'pmt_' + crypto.randomBytes(24).toString('hex');
    const t = { id: uid(), hash: sha(token), userId: user.id, kind: 'api', name: body.name.trim(), createdAt: iso() };
    db.tokens.push(t);
    auditUser(user.id, 'token.created', { tokenId: t.id, name: t.name });
    return ok({ id: t.id, name: t.name, token }, 201);
  });
  route('GET', '/api/tokens', ({ user }) =>
    ok(db.tokens.filter(t => t.userId === user.id && t.kind === 'api').map(t => ({ id: t.id, name: t.name, createdAt: t.createdAt }))));
  route('DELETE', '/api/tokens/:id', ({ user, params }) => {
    const t = db.tokens.find(t => t.id === params.id && t.userId === user.id && t.kind === 'api');
    if (!t) throw notFound('token not found');
    db.tokens = db.tokens.filter(x => x !== t);
    auditUser(user.id, 'token.deleted', { tokenId: t.id, name: t.name });
    return undefined;
  });

  // ---------- workspaces ----------
  route('POST', '/api/workspaces', ({ user, body }) => {
    if (!nonEmpty(body.name)) throw bad('name required');
    if (!isStr(body.key) || !/^[A-Z]{2,10}$/.test(body.key)) throw bad('key must be 2-10 uppercase letters');
    if (db.workspaces.some(w => w.key === body.key)) throw conflict('workspace key already exists');
    const ws = { id: uid(), name: body.name.trim(), key: body.key, createdAt: iso(), members: [{ userId: user.id, role: 'admin' }] };
    db.workspaces.push(ws);
    audit(ws.id, 'workspace.created', user.id, { name: ws.name });
    return ok(serializeWs(ws, 'admin'), 201);
  });
  route('GET', '/api/workspaces', ({ user }) =>
    ok(db.workspaces.filter(w => wsRole(w, user)).map(w => serializeWs(w, wsRole(w, user)))));
  route('GET', '/api/workspaces/:id', ({ user, params }) => {
    const { ws, role } = getWorkspace(params.id, user);
    return ok(serializeWs(ws, role));
  });
  route('GET', '/api/workspaces/:id/members', ({ user, params }) => {
    const { ws } = getWorkspace(params.id, user);
    return ok(ws.members.map(memberOut));
  });
  route('POST', '/api/workspaces/:id/members', ({ user, params, body }) => {
    const { ws } = getWorkspace(params.id, user, true);
    if (!isStr(body.username)) throw bad('username required');
    if (!WS_ROLES.includes(body.role)) throw bad('invalid role');
    const u = userByName(body.username);
    if (!u) throw notFound('user not found');
    if (ws.members.some(m => m.userId === u.id)) throw conflict('already a member');
    const m = { userId: u.id, role: body.role };
    ws.members.push(m);
    audit(ws.id, 'member.added', user.id, { userId: u.id, username: u.username, role: m.role });
    return ok(memberOut(m), 201);
  });
  const findWsMember = (ws, ref) => ws.members.find(m => m.userId === ref || usernameOf(m.userId)?.toLowerCase() === String(ref).toLowerCase());
  route('PATCH', '/api/workspaces/:id/members/:userId', ({ user, params, body }) => {
    const { ws } = getWorkspace(params.id, user, true);
    const m = findWsMember(ws, params.userId);
    if (!m) throw notFound('member not found');
    if (!WS_ROLES.includes(body.role)) throw bad('invalid role');
    if (m.role === 'admin' && body.role !== 'admin' && ws.members.filter(x => x.role === 'admin').length === 1) throw bad('cannot demote the last admin');
    const from = m.role;
    m.role = body.role;
    if (from !== m.role) audit(ws.id, 'member.role_changed', user.id, { userId: m.userId, from, to: m.role });
    return ok(memberOut(m));
  });
  route('DELETE', '/api/workspaces/:id/members/:userId', ({ user, params }) => {
    const { ws } = getWorkspace(params.id, user, true);
    const m = findWsMember(ws, params.userId);
    if (!m) throw notFound('member not found');
    if (m.role === 'admin' && ws.members.filter(x => x.role === 'admin').length === 1) throw bad('cannot remove the last admin');
    ws.members = ws.members.filter(x => x !== m);
    for (const p of db.projects) if (p.workspaceId === ws.id) p.members = p.members.filter(x => x.userId !== m.userId);
    audit(ws.id, 'member.removed', user.id, { userId: m.userId, role: m.role });
    return undefined;
  });
  route('GET', '/api/workspaces/:id/audit', ({ user, params }) => {
    const { ws } = getWorkspace(params.id, user, true);
    return ok(db.audit.filter(a => a.workspaceId === ws.id).map(({ n, ...a }) => a));
  });

  // ---------- projects ----------
  const DEFAULT_STATUSES = [
    { name: 'Backlog', category: 'backlog' }, { name: 'Todo', category: 'unstarted' },
    { name: 'In Progress', category: 'started' }, { name: 'In Review', category: 'started' }, { name: 'Done', category: 'completed' },
  ];
  route('POST', '/api/workspaces/:id/projects', ({ user, params, body }) => {
    const { ws, role } = getWorkspace(params.id, user);
    if (role === 'guest') throw forbidden('guests cannot create projects');
    if (!nonEmpty(body.name)) throw bad('name required');
    if (!isStr(body.key) || !/^[A-Z]{2,10}$/.test(body.key)) throw bad('key must be 2-10 uppercase letters');
    if (db.projects.some(p => p.workspaceId === ws.id && p.key === body.key)) throw conflict('project key already exists');
    const names = DEFAULT_STATUSES.map(s => s.name);
    const p = {
      id: uid(), workspaceId: ws.id, name: body.name.trim(), key: body.key, createdAt: iso(), issueCounter: 0,
      members: [{ userId: user.id, role: 'lead' }],
      workflow: {
        statuses: DEFAULT_STATUSES.map(s => ({ ...s })),
        transitions: names.flatMap(a => names.filter(b => b !== a).map(b => [a, b])),
      },
    };
    db.projects.push(p);
    return ok(serializeProject(p, projRole(p, user)), 201);
  });
  route('GET', '/api/workspaces/:id/projects', ({ user, params }) => {
    const { ws } = getWorkspace(params.id, user);
    return ok(db.projects.filter(p => p.workspaceId === ws.id && projRole(p, user)).map(p => serializeProject(p, projRole(p, user))));
  });
  route('GET', '/api/projects/:id', ({ user, params }) => {
    const { project, role } = getProject(params.id, user);
    return ok(serializeProject(project, role));
  });
  route('PATCH', '/api/projects/:id', ({ user, params, body }) => {
    const { project, role } = getProject(params.id, user, 'lead');
    if ('name' in body) { if (!nonEmpty(body.name)) throw bad('invalid name'); project.name = body.name.trim(); }
    return ok(serializeProject(project, role));
  });
  route('GET', '/api/projects/:id/members', ({ user, params }) => {
    const { project } = getProject(params.id, user);
    return ok(project.members.map(memberOut));
  });
  route('POST', '/api/projects/:id/members', ({ user, params, body }) => {
    const { project } = getProject(params.id, user, 'lead');
    if (!isStr(body.username)) throw bad('username required');
    if (!PROJ_ROLES.includes(body.role)) throw bad('invalid role');
    const u = userByName(body.username);
    if (!u) throw notFound('user not found');
    if (!wsRole(wsById(project.workspaceId), u)) throw bad('user is not a workspace member');
    if (project.members.some(m => m.userId === u.id)) throw conflict('already a project member');
    const m = { userId: u.id, role: body.role };
    project.members.push(m);
    audit(project.workspaceId, 'project.member_added', user.id, { projectId: project.id, userId: u.id, role: m.role });
    return ok(memberOut(m), 201);
  });
  const findProjMember = (p, ref) => p.members.find(m => m.userId === ref || usernameOf(m.userId)?.toLowerCase() === String(ref).toLowerCase());
  route('PATCH', '/api/projects/:id/members/:userId', ({ user, params, body }) => {
    const { project } = getProject(params.id, user, 'lead');
    const m = findProjMember(project, params.userId);
    if (!m) throw notFound('member not found');
    if (!PROJ_ROLES.includes(body.role)) throw bad('invalid role');
    const from = m.role; m.role = body.role;
    audit(project.workspaceId, 'project.member_role_changed', user.id, { projectId: project.id, userId: m.userId, from, to: m.role });
    return ok(memberOut(m));
  });
  route('DELETE', '/api/projects/:id/members/:userId', ({ user, params }) => {
    const { project } = getProject(params.id, user, 'lead');
    const m = findProjMember(project, params.userId);
    if (!m) throw notFound('member not found');
    project.members = project.members.filter(x => x !== m);
    audit(project.workspaceId, 'project.member_removed', user.id, { projectId: project.id, userId: m.userId });
    return undefined;
  });

  // ---------- workflow ----------
  route('GET', '/api/projects/:id/workflow', ({ user, params }) => ok(getProject(params.id, user).project.workflow));
  route('PUT', '/api/projects/:id/workflow', ({ user, params, body }) => {
    const { project } = getProject(params.id, user, 'lead');
    const { statuses, transitions, remap } = body;
    if (!Array.isArray(statuses) || !statuses.length) throw bad('statuses required');
    const seen = new Set();
    for (const s of statuses) {
      if (!isObj(s) || !nonEmpty(s.name) || !CATS.includes(s.category)) throw bad('each status needs name and valid category');
      if (seen.has(s.name)) throw bad('duplicate status name');
      seen.add(s.name);
    }
    let trans;
    if (transitions === undefined) {
      const names = statuses.map(s => s.name);
      trans = names.flatMap(a => names.filter(b => b !== a).map(b => [a, b]));
    } else {
      if (!Array.isArray(transitions)) throw bad('transitions must be an array');
      for (const t of transitions) if (!Array.isArray(t) || t.length !== 2 || !seen.has(t[0]) || !seen.has(t[1])) throw bad('transitions must reference existing statuses');
      trans = transitions.map(t => [t[0], t[1]]);
    }
    if (remap !== undefined && !isObj(remap)) throw bad('remap must be an object');
    const removedInUse = new Set();
    for (const i of db.issues) if (i.projectId === project.id && !seen.has(i.status)) removedInUse.add(i.status);
    for (const r of removedInUse) {
      const to = remap?.[r];
      if (!isStr(to) || !seen.has(to)) throw bad(`status "${r}" is in use; provide remap for it`);
    }
    project.workflow = { statuses: statuses.map(s => ({ name: s.name.trim() === s.name ? s.name : s.name.trim(), category: s.category })), transitions: trans };
    for (const i of db.issues) {
      if (i.projectId !== project.id) continue;
      if (!seen.has(i.status)) applyChanges(i, { status: remap[i.status] }, user.id, { skipTransition: true, event: false });
      const c = catOf(project, i.status);
      if (c === 'completed' && !i.resolvedAt) i.resolvedAt = iso();
      if (c !== 'completed' && i.resolvedAt) i.resolvedAt = null;
    }
    audit(project.workspaceId, 'workflow.updated', user.id, { projectId: project.id, statuses: project.workflow.statuses.map(s => s.name) });
    return ok(project.workflow);
  });

  // ---------- issues ----------
  route('POST', '/api/projects/:id/issues', ({ user, params, body }) => {
    const { project } = getProject(params.id, user, 'write');
    const issue = createIssue(project, body, user);
    return ok(serializeIssue(issue), 201);
  });
  route('GET', '/api/projects/:id/issues', ({ user, params, query }) => {
    const { project } = getProject(params.id, user);
    let list = db.issues.filter(i => i.projectId === project.id);
    for (const [q, fn] of [
      ['status', i => i.status === query.get('status')], ['type', i => i.type === query.get('type')],
      ['assigneeId', i => i.assigneeId === query.get('assigneeId')], ['sprintId', i => (query.get('sprintId') === 'none' ? !i.sprintId : i.sprintId === query.get('sprintId'))],
      ['epicId', i => i.epicId === query.get('epicId')], ['parentId', i => i.parentId === query.get('parentId')],
    ]) if (query.has(q)) list = list.filter(fn);
    list.sort((a, b) => numOf(a) - numOf(b));
    return ok(list.map(serializeIssue));
  });
  const numOf = i => Number(i.key.split('-').pop());
  route('GET', '/api/issues/:key', ({ user, params }) => ok(serializeIssue(getIssue(params.key, user).issue)));
  route('PATCH', '/api/issues/:key', ({ user, params, body }) => {
    const { issue, project } = getIssue(params.key, user, 'write');
    const f = normalizeFields(project, body, issue);
    const merged = { ...issue, ...f };
    crossValidate(project, merged, issue.id);
    applyChanges(issue, f, user.id);
    return ok(serializeIssue(issue));
  });
  route('DELETE', '/api/issues/:key', ({ user, params }) => {
    const { issue } = getIssue(params.key, user, 'write');
    deleteIssue(issue, user.id);
    return undefined;
  });
  route('GET', '/api/issues/:key/history', ({ user, params }) => {
    const { issue } = getIssue(params.key, user);
    return ok(issue.history.map(h => ({ field: h.field, from: h.from, to: h.to, actorId: h.actorId, at: h.at })));
  });

  // links
  route('POST', '/api/issues/:key/links', ({ user, params, body }) => {
    const { issue, project } = getIssue(params.key, user, 'write');
    if (!LINK_TYPES.includes(body.type)) throw bad('invalid link type');
    if (!isStr(body.target)) throw bad('target required');
    const cands = db.issues.filter(i => i.key.toLowerCase() === body.target.toLowerCase() || i.id === body.target);
    const target = cands.find(t => projRole(projById(t.projectId), user));
    if (!target) throw (cands.length ? forbidden('no access to target') : bad('target issue not found'));
    if (target.id === issue.id) throw bad('cannot link an issue to itself');
    const dup = [...issue.links.filter(l => l.targetId === target.id), ...target.links.filter(l => l.targetId === issue.id)];
    if (dup.some(l => l.type === body.type)) throw conflict('link already exists');
    const l = { id: uid(), type: body.type, targetId: target.id };
    issue.links.push(l);
    issue.updatedAt = target.updatedAt = iso();
    void project;
    return ok(linksOf(issue).find(x => x.id === l.id), 201);
  });
  route('GET', '/api/issues/:key/links', ({ user, params }) => ok(linksOf(getIssue(params.key, user).issue)));
  route('DELETE', '/api/issues/:key/links/:linkId', ({ user, params }) => {
    const { issue } = getIssue(params.key, user, 'write');
    let removed = false;
    for (const o of db.issues) {
      const before = o.links.length;
      o.links = o.links.filter(l => !(l.id === params.linkId && (o.id === issue.id || l.targetId === issue.id)));
      if (o.links.length !== before) removed = true;
    }
    if (!removed) throw notFound('link not found');
    return undefined;
  });

  // watchers
  route('POST', '/api/issues/:key/watch', ({ user, params }) => {
    const { issue } = getIssue(params.key, user);
    if (!issue.watchers.includes(user.id)) issue.watchers.push(user.id);
    return ok(serializeIssue(issue));
  });
  route('DELETE', '/api/issues/:key/watch', ({ user, params }) => {
    const { issue } = getIssue(params.key, user);
    issue.watchers = issue.watchers.filter(w => w !== user.id);
    return undefined;
  });

  // ---------- comments ----------
  route('POST', '/api/issues/:key/comments', ({ user, params, body }) => {
    const { issue, project } = getIssue(params.key, user, 'write');
    if (!nonEmpty(body.body)) throw bad('body required');
    const at = iso();
    const c = { id: uid(), issueId: issue.id, authorId: user.id, body: body.body, createdAt: at, updatedAt: at, edited: false };
    db.comments.push(c);
    const mentioned = new Set();
    for (const m of body.body.matchAll(/(?:^|[^A-Za-z0-9_])@([A-Za-z0-9_][A-Za-z0-9_.-]*)/g)) {
      const u = userByName(m[1].replace(/[.-]+$/, ''));
      if (u && u.id !== user.id && projRole(project, u)) mentioned.add(u.id);
    }
    for (const id of mentioned) notify(id, 'mention', issue, user.id);
    for (const w of issue.watchers) if (!mentioned.has(w)) notify(w, 'comment', issue, user.id);
    fire('comment.created', issue, user.id, { comment: serializeComment(c) });
    return ok(serializeComment(c), 201);
  });
  route('GET', '/api/issues/:key/comments', ({ user, params }) => {
    const { issue } = getIssue(params.key, user);
    return ok(db.comments.filter(c => c.issueId === issue.id).map(serializeComment));
  });
  const editComment = ({ user, params, body }) => {
    const c = db.comments.find(c => c.id === params.id);
    if (!c) throw notFound('comment not found');
    const issue = db.issues.find(i => i.id === c.issueId);
    if (!projRole(projById(issue.projectId), user)) throw forbidden('no access');
    if (c.authorId !== user.id) throw forbidden('only the author can edit');
    if (!nonEmpty(body.body)) throw bad('body required');
    c.body = body.body; c.edited = true; c.updatedAt = iso();
    return ok(serializeComment(c));
  };
  const deleteComment = ({ user, params }) => {
    const c = db.comments.find(c => c.id === params.id);
    if (!c) throw notFound('comment not found');
    const issue = db.issues.find(i => i.id === c.issueId);
    const role = projRole(projById(issue.projectId), user);
    if (!role) throw forbidden('no access');
    if (c.authorId !== user.id && role !== 'lead') throw forbidden('only the author or a lead can delete');
    db.comments = db.comments.filter(x => x !== c);
    return undefined;
  };
  route('PATCH', '/api/comments/:id', editComment);
  route('PATCH', '/api/issues/:key/comments/:id', editComment);
  route('DELETE', '/api/comments/:id', deleteComment);
  route('DELETE', '/api/issues/:key/comments/:id', deleteComment);

  // ---------- notifications ----------
  route('GET', '/api/notifications', ({ user, query }) => {
    let l = db.notifications.filter(n => n.userId === user.id);
    if (query.get('unread') === 'true') l = l.filter(n => !n.read);
    l.sort((a, b) => b.n - a.n);
    return ok(l.map(({ id, type, issueKey, actorId, at, read }) => ({ id, type, issueKey, actorId, at, read })));
  });
  route('POST', '/api/notifications/read', ({ user, body }) => {
    const mine = db.notifications.filter(n => n.userId === user.id);
    let targets;
    if (body.all === true) targets = mine;
    else if (Array.isArray(body.ids)) targets = mine.filter(n => body.ids.includes(n.id));
    else throw bad('ids or all required');
    for (const n of targets) n.read = true;
    return ok({ updated: targets.length });
  });

  // ---------- sprints ----------
  const dateOrNull = (v, name) => {
    if (v === undefined || v === null) return null;
    if (!isStr(v) || isNaN(Date.parse(v)) || !/^\d{4}-\d{2}-\d{2}/.test(v)) throw bad(`${name} must be an ISO date`);
    return v;
  };
  route('POST', '/api/projects/:id/sprints', ({ user, params, body }) => {
    const { project } = getProject(params.id, user, 'write');
    if (!nonEmpty(body.name)) throw bad('name required');
    const startDate = dateOrNull(body.startDate, 'startDate'), endDate = dateOrNull(body.endDate, 'endDate');
    if (startDate && endDate && endDate.slice(0, 10) < startDate.slice(0, 10)) throw bad('endDate before startDate');
    const s = { id: uid(), projectId: project.id, name: body.name.trim(), startDate, endDate, state: 'planned', createdAt: iso(), startedAt: null, completedAt: null, committedPoints: null, carriedOver: 0 };
    db.sprints.push(s);
    return ok(serializeSprint(s), 201);
  });
  route('GET', '/api/projects/:id/sprints', ({ user, params }) => {
    const { project } = getProject(params.id, user);
    return ok(db.sprints.filter(s => s.projectId === project.id).map(serializeSprint));
  });
  function getSprint(id, user, need) {
    const s = sprintById(id);
    if (!s) throw notFound('sprint not found');
    const { project } = getProject(s.projectId, user, need);
    return { s, project };
  }
  route('GET', '/api/sprints/:id', ({ user, params }) => ok(serializeSprint(getSprint(params.id, user).s)));
  route('PATCH', '/api/sprints/:id', ({ user, params, body }) => {
    const { s } = getSprint(params.id, user, 'write');
    if ('name' in body) { if (!nonEmpty(body.name)) throw bad('invalid name'); s.name = body.name.trim(); }
    if ('startDate' in body) s.startDate = dateOrNull(body.startDate, 'startDate');
    if ('endDate' in body) s.endDate = dateOrNull(body.endDate, 'endDate');
    return ok(serializeSprint(s));
  });
  route('POST', '/api/sprints/:id/start', ({ user, params }) => {
    const { s, project } = getSprint(params.id, user, 'write');
    if (s.state !== 'planned') throw conflict('sprint is not in planned state');
    if (db.sprints.some(x => x.projectId === project.id && x.state === 'active')) throw conflict('another sprint is already active');
    s.state = 'active'; s.startedAt = iso();
    if (!s.startDate) s.startDate = s.startedAt.slice(0, 10);
    const inS = db.issues.filter(i => i.sprintId === s.id);
    s.committedPoints = inS.reduce((a, i) => a + (i.storyPoints || 0), 0);
    return ok(serializeSprint(s));
  });
  route('POST', '/api/sprints/:id/complete', ({ user, params, body }) => {
    const { s, project } = getSprint(params.id, user, 'write');
    if (s.state !== 'active') throw conflict('sprint is not active');
    const to = body.carryOverTo === undefined ? 'backlog' : body.carryOverTo;
    let target = null;
    if (to !== 'backlog') {
      target = sprintById(to);
      if (!isStr(to) || !target || target.projectId !== project.id || target.id === s.id) throw bad('invalid carryOverTo');
      if (target.state === 'completed') throw bad('cannot carry over to a completed sprint');
    }
    const unfinished = db.issues.filter(i => i.sprintId === s.id && issueCat(i) !== 'completed');
    for (const i of unfinished) applyChanges(i, { sprintId: target ? target.id : null }, user.id);
    s.state = 'completed'; s.completedAt = iso(); s.carriedOver = unfinished.length;
    return ok(serializeSprint(s));
  });
  const valueAt = (issue, field, t) => {
    const h = issue.history.filter(x => x.field === field);
    if (!h.length) return issue[field];
    let last = null;
    for (const x of h) if (x.at <= t) last = x;
    return last ? last.to : h[0].from;
  };
  route('GET', '/api/sprints/:id/report', ({ user, params }) => {
    const { s, project } = getSprint(params.id, user);
    const inSprint = db.issues.filter(i => i.sprintId === s.id);
    const sum = l => l.reduce((a, i) => a + (i.storyPoints || 0), 0);
    const done = inSprint.filter(i => issueCat(i) === 'completed');
    const committed = s.committedPoints ?? sum(inSprint);
    const burndown = [];
    if (s.startDate) {
      const today = iso().slice(0, 10);
      let last = today;
      if (s.endDate && s.endDate.slice(0, 10) < last) last = s.endDate.slice(0, 10);
      const everIn = db.issues.filter(i => i.sprintId === s.id || i.history.some(h => h.field === 'sprintId' && (h.from === s.id || h.to === s.id)));
      let d = new Date(s.startDate.slice(0, 10) + 'T00:00:00Z');
      for (let n = 0; n < 1000; n++, d = new Date(d.getTime() + 86400000)) {
        const day = d.toISOString().slice(0, 10);
        if (day > last) break;
        const t = day + 'T23:59:59.999Z';
        let remaining = 0;
        for (const i of everIn) {
          if (i.createdAt > t) continue;
          if (valueAt(i, 'sprintId', t) !== s.id) continue;
          if (catOf(project, valueAt(i, 'status', t)) === 'completed') continue;
          remaining += valueAt(i, 'storyPoints', t) || 0;
        }
        burndown.push({ date: day, remainingPoints: remaining });
      }
    }
    return ok({ committedPoints: committed, completedPoints: sum(done), completedIssues: done.length, carriedOver: s.carriedOver || 0, burndown });
  });

  route('GET', '/api/projects/:id/stats', ({ user, params }) => {
    const { project } = getProject(params.id, user);
    const issues = db.issues.filter(i => i.projectId === project.id);
    const byStatus = {}, byType = {}, byAssignee = {};
    for (const s of project.workflow.statuses) byStatus[s.name] = 0;
    for (const i of issues) {
      byStatus[i.status] = (byStatus[i.status] || 0) + 1;
      byType[i.type] = (byType[i.type] || 0) + 1;
      const a = i.assigneeId ? usernameOf(i.assigneeId) : 'unassigned';
      byAssignee[a] = (byAssignee[a] || 0) + 1;
    }
    const cycles = issues.filter(i => i.resolvedAt && i.startedAt).map(i => (Date.parse(i.resolvedAt) - Date.parse(i.startedAt)) / 3600000);
    const avg = cycles.length ? cycles.reduce((a, b) => a + b, 0) / cycles.length : null;
    return ok({ total: issues.length, byStatus, byType, byAssignee, avgCycleTimeHours: avg, averageCycleTimeHours: avg, avgCycleTime: avg, resolvedCount: cycles.length });
  });

  // ---------- search ----------
  route('GET', '/api/search', ({ user, query }) => {
    let terms;
    try { terms = parseQuery(query.get('q') || ''); } catch (e) { if (e instanceof QueryError) throw bad(`malformed query: ${e.message}`); throw e; }
    const sort = query.get('sort') || 'updated';
    if (!['updated', 'created', 'priority'].includes(sort)) throw bad('invalid sort');
    let projects = db.projects.filter(p => projRole(p, user));
    const pf = query.get('project');
    if (pf) {
      projects = projects.filter(p => p.id === pf || p.key.toLowerCase() === pf.toLowerCase());
      if (!projects.length && !projById(pf)) throw notFound('project not found');
    }
    const ids = new Set(projects.map(p => p.id));
    const ctx = { userId: user.id, usernameOf, categoryOf: issueCat, sprintOf: sprintById };
    const res = db.issues.filter(i => ids.has(i.projectId) && matches(terms, i, ctx));
    const ord = i => PRIOS.indexOf(i.priority);
    const seqOf = i => db.issues.indexOf(i);
    res.sort((a, b) => {
      if (sort === 'priority') { const d = ord(a) - ord(b); if (d) return d; }
      const k = sort === 'created' ? 'createdAt' : 'updatedAt';
      if (a[k] !== b[k]) return a[k] < b[k] ? 1 : -1;
      return seqOf(b) - seqOf(a);
    });
    return ok(res.map(serializeIssue));
  });

  // ---------- CSV ----------
  route('GET', '/api/projects/:id/export.csv', ({ user, params }) => {
    const { project } = getProject(params.id, user);
    const rows = [CSV_HEADER];
    const keyOf = id => id ? db.issues.find(i => i.id === id)?.key || '' : '';
    const list = db.issues.filter(i => i.projectId === project.id).sort((a, b) => numOf(a) - numOf(b));
    for (const i of list) rows.push([
      i.key, i.type, i.title, i.status, i.priority, i.assigneeId ? usernameOf(i.assigneeId) : '', i.labels.join(';'),
      i.storyPoints ?? '', keyOf(i.parentId), keyOf(i.epicId), i.sprintId ? sprintById(i.sprintId)?.name || '' : '',
      i.dueDate || '', i.createdAt, i.resolvedAt || '',
    ]);
    return ok(toCSV(rows), 200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${project.key}.csv"` });
  });
  route('POST', '/api/projects/:id/import.csv', ({ user, params, raw }) => {
    const { project } = getProject(params.id, user, 'write');
    let recs;
    try { recs = parseCSV(raw); } catch (e) { throw bad('malformed CSV: ' + e.message); }
    if (!recs.length) throw bad('empty CSV');
    const header = recs[0].cells.map(h => h.trim());
    if (!header.includes('title')) throw bad('CSV header must include a title column');
    let created = 0;
    const errors = [];
    for (const rec of recs.slice(1)) {
      if (rec.cells.length === 1 && rec.cells[0].trim() === '') continue;
      const row = {};
      header.forEach((h, idx) => { row[h] = (rec.cells[idx] ?? '').trim(); });
      try {
        if (rec.cells.length > header.length) throw bad('too many columns');
        const input = {};
        if (!row.title) throw bad('title is required');
        input.title = row.title;
        if (row.type) input.type = row.type.toLowerCase();
        if (row.status) {
          const st = project.workflow.statuses.find(s => s.name.toLowerCase() === row.status.toLowerCase());
          if (!st) throw bad(`unknown status "${row.status}"`);
          input.status = st.name;
        }
        if (row.priority) input.priority = row.priority.toLowerCase();
        if (row.assignee) { const u = userByName(row.assignee); if (!u) throw bad(`unknown assignee "${row.assignee}"`); input.assigneeId = u.id; }
        if (row.labels) input.labels = row.labels.split(';').map(s => s.trim()).filter(Boolean);
        if (row.storyPoints) { const n = Number(row.storyPoints); if (isNaN(n)) throw bad('storyPoints must be a number'); input.storyPoints = n; }
        if (row.parent) { const p = findIssueRef(row.parent, project.id); if (!p) throw bad(`unknown parent "${row.parent}"`); input.parentId = p.id; }
        if (row.epic) { const p = findIssueRef(row.epic, project.id); if (!p) throw bad(`unknown epic "${row.epic}"`); input.epicId = p.id; }
        if (row.sprint) {
          const s = db.sprints.find(s => s.projectId === project.id && (s.name.toLowerCase() === row.sprint.toLowerCase() || s.id === row.sprint));
          if (!s) throw bad(`unknown sprint "${row.sprint}"`);
          input.sprintId = s.id;
        }
        if (row.dueDate) input.dueDate = row.dueDate;
        if (input.type === undefined && input.parentId) input.type = 'subtask';
        createIssue(project, input, user);
        created++;
      } catch (e) {
        if (e instanceof HttpError) errors.push({ line: rec.line, message: e.message });
        else throw e;
      }
    }
    return ok({ created, errors });
  }, { raw: true });

  // ---------- webhooks ----------
  const serializeHook = w => ({ id: w.id, projectId: w.projectId, url: w.url, events: w.events, createdAt: w.createdAt });
  route('POST', '/api/projects/:id/webhooks', ({ user, params, body }) => {
    const { project } = getProject(params.id, user, 'lead');
    if (!isStr(body.url)) throw bad('url required');
    let u; try { u = new URL(body.url); } catch { throw bad('invalid url'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw bad('url must be http(s)');
    if (!Array.isArray(body.events) || !body.events.length || body.events.some(e => !EVENTS.includes(e))) throw bad('invalid events');
    if (!nonEmpty(body.secret)) throw bad('secret required');
    const w = { id: uid(), projectId: project.id, url: body.url, events: [...new Set(body.events)], secret: body.secret, createdAt: iso() };
    db.webhooks.push(w);
    audit(project.workspaceId, 'webhook.created', user.id, { projectId: project.id, webhookId: w.id, url: w.url });
    return ok(serializeHook(w), 201);
  });
  route('GET', '/api/projects/:id/webhooks', ({ user, params }) => {
    const { project } = getProject(params.id, user, 'lead');
    return ok(db.webhooks.filter(w => w.projectId === project.id).map(serializeHook));
  });
  function getHook(id, user) {
    const w = db.webhooks.find(w => w.id === id);
    if (!w) throw notFound('webhook not found');
    const { project } = getProject(w.projectId, user, 'lead');
    return { w, project };
  }
  route('DELETE', '/api/webhooks/:id', ({ user, params }) => {
    const { w, project } = getHook(params.id, user);
    db.webhooks = db.webhooks.filter(x => x !== w);
    audit(project.workspaceId, 'webhook.deleted', user.id, { projectId: project.id, webhookId: w.id });
    return undefined;
  });
  route('GET', '/api/webhooks/:id/deliveries', ({ user, params }) => {
    const { w } = getHook(params.id, user);
    return ok(db.deliveries.filter(d => d.webhookId === w.id).map(d => ({ id: d.id, webhookId: d.webhookId, event: d.event, status: d.status, attempts: d.attempts, lastError: d.lastError, createdAt: d.createdAt })));
  });

  const server = http.createServer((req, res) => { handle(req, res); });
  return server;
}
