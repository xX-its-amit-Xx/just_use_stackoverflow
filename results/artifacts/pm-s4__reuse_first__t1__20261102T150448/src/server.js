import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildPredicate, QueryError, TYPES, PRIORITIES } from './search.js';
import { parseCsv, formatCsv } from './csv.js';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.join(__dir, 'static');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

const CATEGORIES = ['backlog', 'unstarted', 'started', 'completed'];
const WS_ROLES = ['admin', 'member', 'guest'];
const PROJECT_ROLES = ['lead', 'developer', 'viewer'];
const RANK = { viewer: 1, developer: 2, lead: 3 };
const LINK_TYPES = ['blocks', 'relates', 'duplicates'];
const INVERSE = { blocks: 'blocked_by', relates: 'relates', duplicates: 'duplicated_by' };
const EVENTS = ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'];

class HttpError extends Error {
  constructor(status, error, message) { super(message); this.status = status; this.error = error; }
}
const bad = m => new HttpError(400, 'validation_error', m);
const notFound = (m = 'not found') => new HttpError(404, 'not_found', m);
const forbidden = (m = 'forbidden') => new HttpError(403, 'forbidden', m);
const conflict = (m, code = 'conflict') => new HttpError(409, code, m);

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const rid = () => crypto.randomUUID();
const isObj = o => o && typeof o === 'object' && !Array.isArray(o);
const isStr = s => typeof s === 'string' && s.trim().length > 0;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function hashPw(pw) { const salt = crypto.randomBytes(16).toString('hex'); return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex'); }
function checkPw(pw, stored) {
  const [salt, h] = stored.split(':');
  const a = Buffer.from(crypto.scryptSync(pw, salt, 32).toString('hex')), b = Buffer.from(h);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const defaultWorkflow = () => ({
  statuses: [
    { name: 'Backlog', category: 'backlog' }, { name: 'Todo', category: 'unstarted' },
    { name: 'In Progress', category: 'started' }, { name: 'In Review', category: 'started' },
    { name: 'Done', category: 'completed' },
  ],
  transitions: null, // null => any status -> any status
});

export function createServer({ dataFile, clock } = {}) {
  clock = clock || (() => new Date());
  const now = () => clock().toISOString();
  const today = () => now().slice(0, 10);

  let db = { users: [], sessions: [], tokens: [], workspaces: [], projects: [], issues: [], comments: [], notifications: [],
    sprints: [], links: [], webhooks: [], deliveries: [], audit: [] };
  if (dataFile && fs.existsSync(dataFile)) {
    try { db = { ...db, ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) }; } catch { /* ignore corrupt */ }
  }
  function save() {
    if (!dataFile) return;
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, dataFile);
  }

  // ---------- lookups ----------
  const userById = id => db.users.find(u => u.id === id);
  const userByName = n => db.users.find(u => u.username.toLowerCase() === String(n).toLowerCase());
  const wsById = id => db.workspaces.find(w => w.id === id);
  const projById = id => db.projects.find(p => p.id === id);
  const pubUser = u => ({ id: u.id, username: u.username, displayName: u.displayName, createdAt: u.createdAt });

  function wsRole(user, ws) { const m = ws.members.find(m => m.userId === user.id); return m ? m.role : null; }
  function projRole(user, p) {
    const ws = wsById(p.workspaceId);
    const wr = wsRole(user, ws);
    if (!wr) return null;
    if (wr === 'admin') return 'lead';
    const pm = p.members.find(m => m.userId === user.id);
    if (pm) return pm.role;
    return wr === 'member' ? 'developer' : null;
  }
  function getWs(user, id, min) {
    const ws = wsById(id);
    if (!ws) throw notFound('workspace not found');
    const r = wsRole(user, ws);
    if (!r) throw notFound('workspace not found');
    if (min === 'admin' && r !== 'admin') throw forbidden('admin only');
    if (min === 'member' && r === 'guest') throw forbidden('members only');
    return ws;
  }
  function getProject(user, id, min = 'viewer') {
    const p = projById(id);
    if (!p) throw notFound('project not found');
    const role = projRole(user, p);
    if (!role) throw notFound('project not found');
    if (RANK[role] < RANK[min]) throw forbidden('insufficient role');
    return { project: p, role };
  }
  function findIssue(key) {
    const m = /^([A-Za-z]+)-(\d+)$/.exec(key);
    if (!m) return null;
    const pk = m[1].toUpperCase();
    return db.issues.find(i => i.key === `${pk}-${m[2]}`) || null;
  }
  function getIssue(user, key, min = 'viewer') {
    const issue = findIssue(key);
    if (!issue) throw notFound('issue not found');
    const { project, role } = getProject(user, issue.projectId, 'viewer');
    if (RANK[role] < RANK[min]) throw forbidden('insufficient role');
    return { issue, project, role };
  }
  const catOf = (p, status) => (p.workflow.statuses.find(s => s.name === status) || {}).category;
  const isDone = (p, issue) => catOf(p, issue.status) === 'completed';

  function audit(wsId, action, actorId, details = {}) {
    db.audit.push({ id: rid(), workspaceId: wsId, action, type: action, actorId, at: now(), details });
  }

  // ---------- serialization ----------
  function ser(issue, full = false) {
    const out = {};
    for (const k of Object.keys(issue)) if (!k.startsWith('_')) out[k] = issue[k];
    const children = db.issues.filter(i => i.parentId === issue.id).map(i => i.key);
    out.children = children;
    if (full) {
      out.links = linksOf(issue);
      if (issue.type === 'epic') {
        const p = projById(issue.projectId);
        const kids = db.issues.filter(i => i.epicId === issue.id);
        out.progress = { total: kids.length, done: kids.filter(i => isDone(p, i)).length,
          points_total: kids.reduce((a, i) => a + (i.storyPoints || 0), 0),
          points_done: kids.filter(i => isDone(p, i)).reduce((a, i) => a + (i.storyPoints || 0), 0) };
      }
    }
    return out;
  }
  function linksOf(issue) {
    const res = [];
    for (const l of db.links) {
      if (l.from === issue.id) { const t = db.issues.find(i => i.id === l.to); if (t) res.push({ id: l.id, type: l.type, key: t.key, target: t.key, title: t.title, status: t.status }); }
      else if (l.to === issue.id) { const t = db.issues.find(i => i.id === l.from); if (t) res.push({ id: l.id, type: INVERSE[l.type], key: t.key, target: t.key, title: t.title, status: t.status }); }
    }
    return res;
  }

  // ---------- notifications / webhooks ----------
  function notify(userIds, type, issue, actor) {
    const seen = new Set();
    for (const uid of userIds) {
      if (!uid || uid === actor.id || seen.has(uid)) continue;
      seen.add(uid);
      db.notifications.push({ id: rid(), userId: uid, type, issueKey: issue.key, actorId: actor.id, at: now(), read: false });
    }
  }
  function fire(project, event, issue, actor, extra = {}) {
    for (const wh of db.webhooks) {
      if (wh.projectId !== project.id || !wh.events.includes(event)) continue;
      const body = JSON.stringify({ event, issue: issue._deleted || ser(issue), actorId: actor.id, at: now(), ...extra });
      const d = { id: rid(), webhookId: wh.id, event, status: 'pending', attempts: 0, lastError: null, createdAt: now() };
      db.deliveries.push(d);
      deliver(wh, d, body);
    }
  }
  async function deliver(wh, d, body) {
    const sig = 'sha256=' + crypto.createHmac('sha256', wh.secret || '').update(body).digest('hex');
    for (let a = 1; a <= 3; a++) {
      d.attempts = a;
      try {
        const r = await fetch(wh.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pm-signature': sig, 'x-pm-event': d.event },
          body, signal: AbortSignal.timeout(5000) });
        d.responseStatus = r.status;
        r.body?.cancel?.().catch(() => {});
        if (r.status >= 200 && r.status < 300) { d.status = 'success'; d.lastError = null; save(); return; }
        d.lastError = `HTTP ${r.status}`;
      } catch (e) { d.lastError = String(e.message || e); }
      if (a < 3) await new Promise(r => setTimeout(r, 50 * a));
    }
    d.status = 'failed';
    save();
  }

  // ---------- issue mutation helpers ----------
  const hist = (issue, field, from, to, actor) => {
    if (JSON.stringify(from) === JSON.stringify(to)) return;
    issue._history.push({ field, from: from ?? null, to: to ?? null, actorId: actor.id, at: now() });
  };
  function setResolvedState(issue, project) {
    const done = isDone(project, issue);
    const was = !!issue.resolvedAt;
    if (done && !was) { issue.resolvedAt = now(); issue._res.push({ at: issue.resolvedAt, resolved: true }); }
    else if (!done && was) { issue.resolvedAt = null; issue._res.push({ at: now(), resolved: false }); }
    if (catOf(project, issue.status) === 'started' && !issue._startedAt) issue._startedAt = now();
  }
  function addToSprint(issue) {
    if (!issue.sprintId) return;
    const s = db.sprints.find(s => s.id === issue.sprintId);
    if (s && !s.issueIds.includes(issue.id)) s.issueIds.push(issue.id);
  }
  function addWatcher(issue, uid) { if (uid && !issue.watchers.includes(uid)) issue.watchers.push(uid); }

  function validateIssueFields(project, b, cur, user) {
    // returns normalized partial changes; cur is existing issue or null
    const ch = {};
    if ('title' in b || !cur) {
      if (!isStr(b.title) || b.title.length > 255) throw bad('title is required (max 255 chars)');
      ch.title = b.title.trim();
    }
    if ('description' in b) { if (b.description != null && typeof b.description !== 'string') throw bad('description must be a string'); ch.description = b.description ?? ''; }
    if ('type' in b || !cur) {
      const t = b.type ?? 'task';
      if (!TYPES.includes(t)) throw bad('invalid type');
      ch.type = t;
    }
    if ('priority' in b) { if (!PRIORITIES.includes(b.priority)) throw bad('invalid priority'); ch.priority = b.priority; }
    if ('status' in b) {
      if (!project.workflow.statuses.some(s => s.name === b.status)) throw bad('unknown status');
      ch.status = b.status;
    }
    if ('assigneeId' in b || 'assignee' in b) {
      let v = 'assigneeId' in b ? b.assigneeId : b.assignee;
      if (v != null && !('assigneeId' in b)) { const u = userByName(v); v = u ? u.id : '__none__'; }
      if (v != null) {
        const u = userById(v);
        if (!u || !projRole(u, project)) throw bad('assignee must be a user with access to the project');
      }
      ch.assigneeId = v ?? null;
    }
    if ('labels' in b) {
      if (!Array.isArray(b.labels) || b.labels.some(l => !isStr(l))) throw bad('labels must be an array of strings');
      ch.labels = [...new Set(b.labels.map(l => l.trim()))];
    }
    if ('storyPoints' in b) {
      if (b.storyPoints != null && (typeof b.storyPoints !== 'number' || !(b.storyPoints >= 0) || !Number.isFinite(b.storyPoints))) throw bad('storyPoints must be a non-negative number');
      ch.storyPoints = b.storyPoints ?? null;
    }
    if ('dueDate' in b) {
      if (b.dueDate != null && (typeof b.dueDate !== 'string' || !DATE_RE.test(b.dueDate) || isNaN(Date.parse(b.dueDate)))) throw bad('dueDate must be YYYY-MM-DD');
      ch.dueDate = b.dueDate ?? null;
    }
    const type = ch.type ?? cur?.type;
    if ('parentId' in b || 'type' in b || !cur) {
      let pid = 'parentId' in b ? b.parentId : (cur?.parentId ?? null);
      if (pid != null) {
        const par = db.issues.find(i => i.id === pid || i.key === pid);
        if (!par || par.projectId !== project.id) throw bad('parent must be an issue in the same project');
        if (par.type === 'subtask') throw bad('parent cannot be a subtask');
        if (cur && par.id === cur.id) throw bad('issue cannot be its own parent');
        pid = par.id;
      }
      if (type === 'subtask' && pid == null) throw bad('subtasks require a parentId');
      if (type === 'epic' && pid != null) throw bad('epics cannot have parents');
      if (type !== 'subtask' && pid != null) throw bad('only subtasks can have a parent');
      if (type !== 'subtask' || 'parentId' in b || !cur) ch.parentId = type === 'subtask' ? pid : null;
    }
    if ('epicId' in b) {
      let e = b.epicId;
      if (e != null) {
        const ep = db.issues.find(i => i.id === e || i.key === e);
        if (!ep || ep.projectId !== project.id || ep.type !== 'epic') throw bad('epicId must reference an epic in the project');
        e = ep.id;
      }
      ch.epicId = e ?? null;
    }
    if (type === 'epic' && (ch.epicId ?? cur?.epicId)) throw bad('epics cannot belong to an epic');
    if ('sprintId' in b) {
      let s = b.sprintId;
      if (s != null) {
        const sp = db.sprints.find(x => x.id === s);
        if (!sp || sp.projectId !== project.id) throw bad('sprintId must reference a sprint in the project');
        if (sp.state === 'completed') throw bad('cannot add issues to a completed sprint');
      }
      ch.sprintId = s ?? null;
    }
    return ch;
  }

  function createIssue(project, user, b) {
    const ch = validateIssueFields(project, b, null, user);
    const wf = project.workflow;
    let status = ch.status;
    if (!status) status = (wf.statuses.find(s => s.category === 'unstarted') || wf.statuses[0]).name;
    const t = now();
    project.nextNum = (project.nextNum || 1);
    const num = project.nextNum++;
    const issue = {
      id: rid(), key: `${project.key}-${num}`, projectId: project.id, type: ch.type, title: ch.title, description: ch.description ?? '',
      status, priority: ch.priority ?? 'none', assigneeId: ch.assigneeId ?? null, reporterId: user.id, labels: ch.labels ?? [],
      storyPoints: ch.storyPoints ?? null, parentId: ch.parentId ?? null, epicId: ch.epicId ?? null, sprintId: ch.sprintId ?? null,
      dueDate: ch.dueDate ?? null, watchers: [], createdAt: t, updatedAt: t, resolvedAt: null,
      _history: [], _res: [], _startedAt: null,
    };
    addWatcher(issue, user.id); addWatcher(issue, issue.assigneeId);
    setResolvedState(issue, project);
    db.issues.push(issue);
    addToSprint(issue);
    return issue;
  }

  function applyChanges(issue, project, ch, actor) {
    const changed = [];
    for (const [k, v] of Object.entries(ch)) {
      if (k === 'status') continue;
      if (JSON.stringify(issue[k]) !== JSON.stringify(v)) { hist(issue, k, issue[k], v, actor); issue[k] = v; changed.push(k); }
    }
    if ('assigneeId' in ch && ch.assigneeId) addWatcher(issue, ch.assigneeId);
    if ('sprintId' in ch) addToSprint(issue);
    if (issue.type === 'subtask' && changed.includes('type')) { /* validated */ }
    return changed;
  }

  function changeStatus(issue, project, to, actor) {
    const from = issue.status;
    if (from === to) return false;
    const wf = project.workflow;
    if (!wf.statuses.some(s => s.name === to)) throw bad('unknown status');
    if (wf.transitions && !wf.transitions.some(([a, b]) => a === from && b === to)) throw conflict(`transition ${from} -> ${to} not allowed`, 'invalid_transition');
    if (catOf(project, to) === 'completed') {
      for (const l of db.links) {
        if (l.type === 'blocks' && l.to === issue.id) {
          const blocker = db.issues.find(i => i.id === l.from);
          if (blocker && !isDone(projById(blocker.projectId), blocker)) throw conflict(`blocked by ${blocker.key}`, 'blocked');
        }
      }
    }
    hist(issue, 'status', from, to, actor);
    issue.status = to;
    setResolvedState(issue, project);
    return true;
  }

  function deleteIssueCascade(issue, project, actor) {
    const kids = db.issues.filter(i => i.parentId === issue.id);
    for (const k of kids) deleteIssueCascade(k, project, actor);
    for (const i of db.issues) if (i.epicId === issue.id) { i.epicId = null; }
    db.issues = db.issues.filter(i => i.id !== issue.id);
    db.links = db.links.filter(l => l.from !== issue.id && l.to !== issue.id);
    db.comments = db.comments.filter(c => c.issueId !== issue.id);
    for (const s of db.sprints) s.issueIds = s.issueIds.filter(x => x !== issue.id);
    fire(project, 'issue.deleted', { _deleted: ser(issue) }, actor);
  }

  // ---------- auth ----------
  const failures = new Map();
  const RL_MAX = 5, RL_WINDOW = 15 * 60 * 1000;
  function authenticate(req) {
    const h = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return null;
    const hh = sha(m[1].trim());
    const s = db.sessions.find(s => s.hash === hh) || db.tokens.find(t => t.hash === hh);
    if (!s) return null;
    return userById(s.userId) || null;
  }

  // ---------- router ----------
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, auth: opts.auth !== false, raw: !!opts.raw });
  };

  // --- auth routes
  route('POST', '/api/auth/register', ({ body }) => {
    const { username, password } = body;
    if (typeof username !== 'string' || !/^[A-Za-z0-9_.-]{3,32}$/.test(username)) throw bad('username must be 3-32 chars of letters, digits, _ . -');
    if (typeof password !== 'string' || password.length < 8) throw bad('password must be at least 8 characters');
    if (body.displayName != null && typeof body.displayName !== 'string') throw bad('displayName must be a string');
    if (userByName(username)) throw conflict('username taken');
    const u = { id: rid(), username, displayName: body.displayName || username, passwordHash: hashPw(password), createdAt: now() };
    db.users.push(u);
    return [201, pubUser(u)];
  }, { auth: false });
  route('POST', '/api/auth/login', ({ body }) => {
    const { username, password } = body;
    if (typeof username !== 'string' || typeof password !== 'string') throw bad('username and password required');
    const k = username.toLowerCase();
    const rec = failures.get(k);
    const t = Date.now();
    if (rec && t - rec.first < RL_WINDOW && rec.count >= RL_MAX) throw new HttpError(429, 'rate_limited', 'too many failed login attempts');
    const u = userByName(username);
    if (!u || !checkPw(password, u.passwordHash)) {
      if (!rec || t - rec.first >= RL_WINDOW) failures.set(k, { first: t, count: 1 }); else rec.count++;
      throw new HttpError(401, 'unauthorized', 'invalid credentials');
    }
    failures.delete(k);
    const token = crypto.randomBytes(32).toString('hex');
    db.sessions.push({ hash: sha(token), userId: u.id, createdAt: now() });
    return [200, { token, user: pubUser(u) }];
  }, { auth: false });
  route('POST', '/api/auth/logout', ({ req }) => {
    const hh = sha(/^Bearer\s+(.+)$/i.exec(req.headers.authorization)[1].trim());
    db.sessions = db.sessions.filter(s => s.hash !== hh);
    return [204];
  });
  route('GET', '/api/auth/me', ({ user }) => [200, pubUser(user)]);
  route('PATCH', '/api/auth/me', ({ user, body }) => {
    if ('displayName' in body) { if (!isStr(body.displayName)) throw bad('displayName must be a non-empty string'); }
    if ('password' in body) {
      if (typeof body.password !== 'string' || body.password.length < 8) throw bad('password must be at least 8 characters');
      if (typeof body.currentPassword !== 'string') throw bad('currentPassword required');
      if (!checkPw(body.currentPassword, user.passwordHash)) throw forbidden('current password incorrect');
    }
    if ('displayName' in body) user.displayName = body.displayName.trim();
    if ('password' in body) user.passwordHash = hashPw(body.password);
    return [200, pubUser(user)];
  });

  // --- tokens
  route('POST', '/api/tokens', ({ user, body }) => {
    if (!isStr(body.name)) throw bad('name required');
    const token = 'pmt_' + crypto.randomBytes(24).toString('hex');
    const t = { id: rid(), name: body.name.trim(), hash: sha(token), userId: user.id, createdAt: now() };
    db.tokens.push(t);
    for (const w of db.workspaces) if (wsRole(user, w)) audit(w.id, 'token.created', user.id, { tokenId: t.id, name: t.name });
    return [201, { id: t.id, name: t.name, token }];
  });
  route('GET', '/api/tokens', ({ user }) => [200, db.tokens.filter(t => t.userId === user.id).map(t => ({ id: t.id, name: t.name, createdAt: t.createdAt }))]);
  route('DELETE', '/api/tokens/:id', ({ user, params }) => {
    const t = db.tokens.find(t => t.id === params.id && t.userId === user.id);
    if (!t) throw notFound('token not found');
    db.tokens = db.tokens.filter(x => x !== t);
    for (const w of db.workspaces) if (wsRole(user, w)) audit(w.id, 'token.deleted', user.id, { tokenId: t.id, name: t.name });
    return [204];
  });

  // --- workspaces
  const wsOut = ws => ({ id: ws.id, name: ws.name, key: ws.key, createdAt: ws.createdAt,
    members: ws.members.map(m => ({ userId: m.userId, username: userById(m.userId)?.username, role: m.role })) });
  route('POST', '/api/workspaces', ({ user, body }) => {
    if (!isStr(body.name)) throw bad('name required');
    if (typeof body.key !== 'string' || !/^[A-Z]{2,10}$/.test(body.key)) throw bad('key must be 2-10 uppercase letters');
    if (db.workspaces.some(w => w.key === body.key)) throw conflict('workspace key already exists');
    const ws = { id: rid(), name: body.name.trim(), key: body.key, createdAt: now(), members: [{ userId: user.id, role: 'admin' }] };
    db.workspaces.push(ws);
    audit(ws.id, 'workspace.created', user.id, {});
    return [201, wsOut(ws)];
  });
  route('GET', '/api/workspaces', ({ user }) => [200, db.workspaces.filter(w => wsRole(user, w)).map(wsOut)]);
  route('GET', '/api/workspaces/:id', ({ user, params }) => [200, wsOut(getWs(user, params.id))]);
  route('POST', '/api/workspaces/:id/members', ({ user, params, body }) => {
    const ws = getWs(user, params.id, 'admin');
    if (!WS_ROLES.includes(body.role)) throw bad('invalid role');
    const u = typeof body.username === 'string' ? userByName(body.username) : null;
    if (!u) throw bad('unknown user');
    if (ws.members.some(m => m.userId === u.id)) throw conflict('already a member');
    ws.members.push({ userId: u.id, role: body.role });
    audit(ws.id, 'member.added', user.id, { userId: u.id, username: u.username, role: body.role });
    return [201, { userId: u.id, username: u.username, role: body.role }];
  });
  route('PATCH', '/api/workspaces/:id/members/:uid', ({ user, params, body }) => {
    const ws = getWs(user, params.id, 'admin');
    const m = ws.members.find(m => m.userId === params.uid);
    if (!m) throw notFound('member not found');
    if (!WS_ROLES.includes(body.role)) throw bad('invalid role');
    if (m.role === 'admin' && body.role !== 'admin' && ws.members.filter(x => x.role === 'admin').length === 1) throw bad('cannot demote the last admin');
    const from = m.role;
    m.role = body.role;
    audit(ws.id, 'member.role_changed', user.id, { userId: m.userId, from, to: m.role });
    return [200, { userId: m.userId, username: userById(m.userId)?.username, role: m.role }];
  });
  route('DELETE', '/api/workspaces/:id/members/:uid', ({ user, params }) => {
    const ws = getWs(user, params.id, 'admin');
    const m = ws.members.find(m => m.userId === params.uid);
    if (!m) throw notFound('member not found');
    if (m.role === 'admin' && ws.members.filter(x => x.role === 'admin').length === 1) throw bad('cannot remove the last admin');
    ws.members = ws.members.filter(x => x !== m);
    for (const p of db.projects) if (p.workspaceId === ws.id) p.members = p.members.filter(x => x.userId !== m.userId);
    audit(ws.id, 'member.removed', user.id, { userId: m.userId });
    return [204];
  });
  route('GET', '/api/workspaces/:id/audit', ({ user, params }) => {
    const ws = getWs(user, params.id, 'admin');
    return [200, db.audit.filter(a => a.workspaceId === ws.id).slice().reverse().map(({ workspaceId, ...a }) => a)];
  });

  // --- projects
  const projOut = (p, role) => ({ id: p.id, workspaceId: p.workspaceId, name: p.name, key: p.key, createdAt: p.createdAt, workflow: p.workflow, role,
    members: p.members.map(m => ({ userId: m.userId, username: userById(m.userId)?.username, role: m.role })) });
  route('POST', '/api/workspaces/:id/projects', ({ user, params, body }) => {
    const ws = getWs(user, params.id, 'member');
    if (!isStr(body.name)) throw bad('name required');
    if (typeof body.key !== 'string' || !/^[A-Z]{2,10}$/.test(body.key)) throw bad('key must be 2-10 uppercase letters');
    if (db.projects.some(p => p.key === body.key)) throw conflict('project key already exists');
    const p = { id: rid(), workspaceId: ws.id, name: body.name.trim(), key: body.key, createdAt: now(), members: [], workflow: defaultWorkflow(), nextNum: 1 };
    db.projects.push(p);
    return [201, projOut(p, projRole(user, p))];
  });
  route('GET', '/api/workspaces/:id/projects', ({ user, params }) => {
    const ws = getWs(user, params.id);
    return [200, db.projects.filter(p => p.workspaceId === ws.id && projRole(user, p)).map(p => projOut(p, projRole(user, p)))];
  });
  route('GET', '/api/projects/:id', ({ user, params }) => { const { project, role } = getProject(user, params.id); return [200, projOut(project, role)]; });
  route('PATCH', '/api/projects/:id', ({ user, params, body }) => {
    const { project, role } = getProject(user, params.id, 'lead');
    if ('name' in body) { if (!isStr(body.name)) throw bad('name required'); project.name = body.name.trim(); }
    return [200, projOut(project, role)];
  });
  route('GET', '/api/projects/:id/members', ({ user, params }) => { const { project, role } = getProject(user, params.id); return [200, projOut(project, role).members]; });
  route('POST', '/api/projects/:id/members', ({ user, params, body }) => {
    const { project } = getProject(user, params.id, 'lead');
    if (!PROJECT_ROLES.includes(body.role)) throw bad('invalid role');
    const u = typeof body.username === 'string' ? userByName(body.username) : null;
    if (!u) throw bad('unknown user');
    if (!wsRole(u, wsById(project.workspaceId))) throw bad('user must be a workspace member first');
    if (project.members.some(m => m.userId === u.id)) throw conflict('already a project member');
    project.members.push({ userId: u.id, role: body.role });
    audit(project.workspaceId, 'project.member_added', user.id, { projectId: project.id, userId: u.id, role: body.role });
    return [201, { userId: u.id, username: u.username, role: body.role }];
  });
  route('PATCH', '/api/projects/:id/members/:uid', ({ user, params, body }) => {
    const { project } = getProject(user, params.id, 'lead');
    const m = project.members.find(m => m.userId === params.uid);
    if (!m) throw notFound('member not found');
    if (!PROJECT_ROLES.includes(body.role)) throw bad('invalid role');
    const from = m.role; m.role = body.role;
    audit(project.workspaceId, 'project.member_role_changed', user.id, { projectId: project.id, userId: m.userId, from, to: m.role });
    return [200, { userId: m.userId, username: userById(m.userId)?.username, role: m.role }];
  });
  route('DELETE', '/api/projects/:id/members/:uid', ({ user, params }) => {
    const { project } = getProject(user, params.id, 'lead');
    const m = project.members.find(m => m.userId === params.uid);
    if (!m) throw notFound('member not found');
    project.members = project.members.filter(x => x !== m);
    audit(project.workspaceId, 'project.member_removed', user.id, { projectId: project.id, userId: m.userId });
    return [204];
  });

  route('PUT', '/api/projects/:id/workflow', ({ user, params, body }) => {
    const { project } = getProject(user, params.id, 'lead');
    const { statuses, transitions } = body;
    if (!Array.isArray(statuses) || statuses.length === 0) throw bad('statuses required');
    const names = new Set();
    for (const s of statuses) {
      if (!isObj(s) || !isStr(s.name) || !CATEGORIES.includes(s.category)) throw bad('each status needs a name and valid category');
      if (names.has(s.name)) throw bad('duplicate status name');
      names.add(s.name);
    }
    let trans = null;
    if (transitions != null) {
      if (!Array.isArray(transitions)) throw bad('transitions must be an array');
      for (const t of transitions) if (!Array.isArray(t) || t.length !== 2 || !names.has(t[0]) || !names.has(t[1])) throw bad('transitions must reference known statuses');
      trans = transitions.map(([a, b]) => [a, b]);
    }
    const remap = body.remap == null ? {} : body.remap;
    if (!isObj(remap)) throw bad('remap must be an object');
    const issues = db.issues.filter(i => i.projectId === project.id);
    const used = new Set(issues.map(i => i.status));
    for (const old of used) {
      if (!names.has(old)) {
        if (!(old in remap)) throw bad(`status "${old}" is in use and needs a remap`);
        if (!names.has(remap[old])) throw bad(`remap target for "${old}" is not a new status`);
      }
    }
    project.workflow = { statuses: statuses.map(s => ({ name: s.name, category: s.category })), transitions: trans };
    for (const i of issues) {
      if (!names.has(i.status)) { hist(i, 'status', i.status, remap[i.status], user); i.status = remap[i.status]; i.updatedAt = now(); }
      setResolvedState(i, project);
    }
    audit(project.workspaceId, 'workflow.updated', user.id, { projectId: project.id });
    return [200, project.workflow];
  });
  route('GET', '/api/projects/:id/workflow', ({ user, params }) => [200, getProject(user, params.id).project.workflow]);

  // --- issues
  route('POST', '/api/projects/:id/issues', ({ user, params, body }) => {
    const { project } = getProject(user, params.id, 'developer');
    const issue = createIssue(project, user, body);
    if (issue.assigneeId) notify([issue.assigneeId], 'assigned', issue, user);
    fire(project, 'issue.created', issue, user);
    return [201, ser(issue, true)];
  });
  function visibleIssues(user, projectFilter) {
    const roleCache = new Map();
    return db.issues.filter(i => {
      if (projectFilter && i.projectId !== projectFilter.id) return false;
      if (!roleCache.has(i.projectId)) roleCache.set(i.projectId, !!projRole(user, projById(i.projectId)));
      return roleCache.get(i.projectId);
    });
  }
  function runSearch(user, q, projectFilter, sort) {
    const sprintState = id => db.sprints.find(s => s.id === id)?.state;
    let pred;
    try {
      pred = buildPredicate(q, { me: user.id, sprintState, username: id => userById(id)?.username,
        isDone: i => isDone(projById(i.projectId), i) });
    } catch (e) { if (e instanceof QueryError) throw bad('malformed query: ' + e.message); throw e; }
    const list = visibleIssues(user, projectFilter).filter(pred);
    const pr = i => PRIORITIES.indexOf(i.priority);
    const num = i => Number(i.key.split('-')[1]);
    const byUpd = (a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0);
    const stable = list.map((i, idx) => [i, idx]);
    const cmpf = sort === 'created' ? (a, b) => (a[0].createdAt < b[0].createdAt ? 1 : a[0].createdAt > b[0].createdAt ? -1 : b[1] - a[1])
      : sort === 'priority' ? (a, b) => pr(a[0]) - pr(b[0]) || byUpd(a[0], b[0]) || b[1] - a[1]
        : (a, b) => byUpd(a[0], b[0]) || b[1] - a[1];
    stable.sort(cmpf);
    return stable.map(x => ser(x[0]));
  }
  function sortParam(q) {
    const s = q.get('sort') || 'updated';
    if (!['updated', 'created', 'priority'].includes(s)) throw bad('invalid sort');
    return s;
  }
  route('GET', '/api/projects/:id/issues', ({ user, params, query }) => {
    const { project } = getProject(user, params.id);
    return [200, runSearch(user, query.get('q') || '', project, sortParam(query))];
  });
  route('GET', '/api/search', ({ user, query }) => {
    let pf = null;
    const pq = query.get('project');
    if (pq) {
      pf = db.projects.find(p => p.id === pq || p.key === pq.toUpperCase());
      if (!pf || !projRole(user, pf)) return [200, []];
    }
    return [200, runSearch(user, query.get('q') || '', pf, sortParam(query))];
  });
  route('GET', '/api/issues/:key', ({ user, params }) => [200, ser(getIssue(user, params.key).issue, true)]);
  route('PATCH', '/api/issues/:key', ({ user, params, body }) => {
    const { issue, project } = getIssue(user, params.key, 'developer');
    if (!isObj(body)) throw bad('body must be an object');
    for (const k of ['id', 'key', 'projectId', 'reporterId', 'createdAt', 'updatedAt', 'resolvedAt', 'watchers']) if (k in body) throw bad(`${k} is read-only`);
    const ch = validateIssueFields(project, body, issue, user);
    const prevAssignee = issue.assigneeId, prevStatus = issue.status;
    // validate status first (may throw before mutations)
    const backup = JSON.stringify(issue);
    let changed;
    try {
      changed = applyChanges(issue, project, ch, user);
      if ('status' in ch) { if (changeStatus(issue, project, ch.status, user)) changed.push('status'); }
    } catch (e) { Object.assign(issue, JSON.parse(backup)); throw e; }
    if (changed.length) {
      issue.updatedAt = now();
      if (changed.includes('status')) notify(issue.watchers, 'status_changed', issue, user);
      if (changed.includes('assigneeId') && issue.assigneeId) notify(issue.watchers, 'assigned', issue, user);
      fire(project, 'issue.updated', issue, user, { changes: changed });
    }
    void prevAssignee; void prevStatus;
    return [200, ser(issue, true)];
  });
  route('DELETE', '/api/issues/:key', ({ user, params }) => {
    const { issue, project } = getIssue(user, params.key, 'developer');
    deleteIssueCascade(issue, project, user);
    return [204];
  });
  route('GET', '/api/issues/:key/history', ({ user, params }) => [200, getIssue(user, params.key).issue._history.map(h => ({ ...h }))]);

  // links
  route('POST', '/api/issues/:key/links', ({ user, params, body }) => {
    const { issue } = getIssue(user, params.key, 'developer');
    if (!LINK_TYPES.includes(body.type)) throw bad('invalid link type');
    if (typeof body.target !== 'string') throw bad('target required');
    const target = findIssue(body.target);
    if (!target) throw bad('target not found');
    const tp = projById(target.projectId);
    if (!projRole(user, tp)) throw bad('target not found');
    if (target.id === issue.id) throw bad('cannot link an issue to itself');
    if (db.links.some(l => (l.from === issue.id && l.to === target.id && l.type === body.type) || (l.from === target.id && l.to === issue.id && l.type === body.type))) throw conflict('link already exists');
    const l = { id: rid(), type: body.type, from: issue.id, to: target.id };
    db.links.push(l);
    return [201, { id: l.id, type: l.type, target: target.key, key: target.key }];
  });
  route('GET', '/api/issues/:key/links', ({ user, params }) => [200, linksOf(getIssue(user, params.key).issue)]);
  route('DELETE', '/api/issues/:key/links/:lid', ({ user, params }) => {
    const { issue } = getIssue(user, params.key, 'developer');
    const l = db.links.find(l => l.id === params.lid && (l.from === issue.id || l.to === issue.id));
    if (!l) throw notFound('link not found');
    db.links = db.links.filter(x => x !== l);
    return [204];
  });

  // watchers
  route('POST', '/api/issues/:key/watch', ({ user, params }) => { const { issue } = getIssue(user, params.key); addWatcher(issue, user.id); return [200, ser(issue, true)]; });
  route('DELETE', '/api/issues/:key/watch', ({ user, params }) => { const { issue } = getIssue(user, params.key); issue.watchers = issue.watchers.filter(w => w !== user.id); return [200, ser(issue, true)]; });

  // comments
  route('POST', '/api/issues/:key/comments', ({ user, params, body }) => {
    const { issue, project } = getIssue(user, params.key, 'developer');
    if (!isStr(body.body)) throw bad('body required');
    const c = { id: rid(), issueId: issue.id, issueKey: issue.key, authorId: user.id, body: body.body, createdAt: now(), updatedAt: now(), edited: false };
    db.comments.push(c);
    const mentioned = new Set();
    for (const m of body.body.matchAll(/@([A-Za-z0-9_.-]+)/g)) {
      const u = userByName(m[1].replace(/[.-]+$/, ''));
      if (u && projRole(u, project)) mentioned.add(u.id);
    }
    notify([...mentioned], 'mention', issue, user);
    notify(issue.watchers.filter(w => !mentioned.has(w)), 'comment', issue, user);
    fire(project, 'comment.created', issue, user, { comment: c });
    return [201, c];
  });
  route('GET', '/api/issues/:key/comments', ({ user, params }) => {
    const { issue } = getIssue(user, params.key);
    return [200, db.comments.filter(c => c.issueId === issue.id)];
  });
  route('PATCH', '/api/comments/:id', ({ user, params, body }) => {
    const c = db.comments.find(c => c.id === params.id);
    if (!c) throw notFound('comment not found');
    getIssue(user, c.issueKey);
    if (c.authorId !== user.id) throw forbidden('only the author can edit');
    if (!isStr(body.body)) throw bad('body required');
    c.body = body.body; c.edited = true; c.updatedAt = now();
    return [200, c];
  });
  route('DELETE', '/api/comments/:id', ({ user, params }) => {
    const c = db.comments.find(c => c.id === params.id);
    if (!c) throw notFound('comment not found');
    const { role } = getIssue(user, c.issueKey);
    if (c.authorId !== user.id && role !== 'lead') throw forbidden('only the author or a lead can delete');
    db.comments = db.comments.filter(x => x !== c);
    return [204];
  });

  // notifications
  route('GET', '/api/notifications', ({ user, query }) => {
    let l = db.notifications.filter(n => n.userId === user.id);
    if (query.get('unread') === 'true') l = l.filter(n => !n.read);
    return [200, l.slice().reverse().map(({ userId, ...n }) => n)];
  });
  route('POST', '/api/notifications/read', ({ user, body }) => {
    let l = db.notifications.filter(n => n.userId === user.id);
    if (body.all === true) { /* all */ }
    else if (Array.isArray(body.ids)) l = l.filter(n => body.ids.includes(n.id));
    else throw bad('ids or all required');
    for (const n of l) n.read = true;
    return [200, { updated: l.length }];
  });

  // --- sprints
  const sprintOut = s => { const { issueIds, ...r } = s; return r; };
  function getSprint(user, id, min = 'viewer') {
    const s = db.sprints.find(s => s.id === id);
    if (!s) throw notFound('sprint not found');
    const { project } = getProject(user, s.projectId, min);
    return { sprint: s, project };
  }
  function dateArg(v, name) {
    if (v == null) return null;
    if (typeof v !== 'string' || isNaN(Date.parse(v))) throw bad(`${name} must be a date`);
    return v.slice(0, 10);
  }
  route('POST', '/api/projects/:id/sprints', ({ user, params, body }) => {
    const { project } = getProject(user, params.id, 'developer');
    if (!isStr(body.name)) throw bad('name required');
    const startDate = dateArg(body.startDate, 'startDate'), endDate = dateArg(body.endDate, 'endDate');
    if (startDate && endDate && endDate < startDate) throw bad('endDate before startDate');
    const s = { id: rid(), projectId: project.id, name: body.name.trim(), state: 'planned', startDate, endDate, createdAt: now(), startedAt: null, completedAt: null, carriedOver: 0, issueIds: [] };
    db.sprints.push(s);
    return [201, sprintOut(s)];
  });
  route('GET', '/api/projects/:id/sprints', ({ user, params }) => {
    const { project } = getProject(user, params.id);
    return [200, db.sprints.filter(s => s.projectId === project.id).map(sprintOut)];
  });
  route('GET', '/api/sprints/:id', ({ user, params }) => [200, sprintOut(getSprint(user, params.id).sprint)]);
  route('POST', '/api/sprints/:id/start', ({ user, params }) => {
    const { sprint } = getSprint(user, params.id, 'developer');
    if (sprint.state !== 'planned') throw conflict('sprint is not planned');
    if (db.sprints.some(s => s.projectId === sprint.projectId && s.state === 'active')) throw conflict('another sprint is already active');
    sprint.state = 'active'; sprint.startedAt = now();
    if (!sprint.startDate) sprint.startDate = today();
    return [200, sprintOut(sprint)];
  });
  route('POST', '/api/sprints/:id/complete', ({ user, params, body }) => {
    const { sprint, project } = getSprint(user, params.id, 'developer');
    if (sprint.state !== 'active') throw conflict('sprint is not active');
    const target = body.carryOverTo ?? 'backlog';
    let tsp = null;
    if (target !== 'backlog') {
      tsp = db.sprints.find(s => s.id === target);
      if (!tsp || tsp.projectId !== project.id || tsp.id === sprint.id || tsp.state === 'completed') throw bad('invalid carryOverTo');
    }
    let n = 0;
    for (const i of db.issues) {
      if (i.sprintId === sprint.id && !isDone(project, i)) {
        hist(i, 'sprintId', i.sprintId, tsp ? tsp.id : null, user);
        i.sprintId = tsp ? tsp.id : null; i.updatedAt = now(); addToSprint(i); n++;
      }
    }
    sprint.state = 'completed'; sprint.completedAt = now(); sprint.carriedOver = n;
    return [200, sprintOut(sprint)];
  });
  const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
  route('GET', '/api/sprints/:id/report', ({ user, params }) => {
    const { sprint, project } = getSprint(user, params.id);
    const issues = sprint.issueIds.map(id => db.issues.find(i => i.id === id)).filter(Boolean);
    const pts = i => i.storyPoints || 0;
    const committedPoints = issues.reduce((a, i) => a + pts(i), 0);
    const doneIssues = issues.filter(i => isDone(project, i) && i.sprintId === sprint.id);
    const burndown = [];
    if (sprint.startDate) {
      let last = today();
      if (sprint.endDate && sprint.endDate < last) last = sprint.endDate;
      if (sprint.completedAt && sprint.completedAt.slice(0, 10) < last) last = sprint.completedAt.slice(0, 10);
      for (let d = sprint.startDate, guard = 0; d <= last && guard < 1000; d = addDays(d, 1), guard++) {
        const endOfDay = d + 'T23:59:59.999Z';
        let remaining = 0;
        for (const i of issues) {
          let res = false;
          for (const e of i._res) if (e.at <= endOfDay) res = e.resolved;
          if (!res) remaining += pts(i);
        }
        burndown.push({ date: d, remainingPoints: remaining });
      }
    }
    return [200, { committedPoints, completedPoints: doneIssues.reduce((a, i) => a + pts(i), 0), completedIssues: doneIssues.length, carriedOver: sprint.carriedOver || 0, burndown }];
  });

  route('GET', '/api/projects/:id/stats', ({ user, params }) => {
    const { project } = getProject(user, params.id);
    const issues = db.issues.filter(i => i.projectId === project.id);
    const byStatus = {}, byType = {}, byAssignee = {};
    for (const s of project.workflow.statuses) byStatus[s.name] = 0;
    for (const i of issues) {
      byStatus[i.status] = (byStatus[i.status] || 0) + 1;
      byType[i.type] = (byType[i.type] || 0) + 1;
      const a = i.assigneeId ? (userById(i.assigneeId)?.username || i.assigneeId) : 'unassigned';
      byAssignee[a] = (byAssignee[a] || 0) + 1;
    }
    const cyc = issues.filter(i => i.resolvedAt && i._startedAt).map(i => (Date.parse(i.resolvedAt) - Date.parse(i._startedAt)) / 3600000);
    const avg = cyc.length ? cyc.reduce((a, b) => a + b, 0) / cyc.length : null;
    return [200, { total: issues.length, byStatus, byType, byAssignee, avgCycleTimeHours: avg, averageCycleTimeHours: avg }];
  });

  // --- CSV
  const CSV_HEADER = ['key', 'type', 'title', 'status', 'priority', 'assignee', 'labels', 'storyPoints', 'parent', 'epic', 'sprint', 'dueDate', 'createdAt', 'resolvedAt'];
  route('GET', '/api/projects/:id/export.csv', ({ user, params }) => {
    const { project } = getProject(user, params.id);
    const keyOf = id => db.issues.find(i => i.id === id)?.key || '';
    const rows = [CSV_HEADER];
    for (const i of db.issues.filter(i => i.projectId === project.id)) {
      rows.push([i.key, i.type, i.title, i.status, i.priority, i.assigneeId ? userById(i.assigneeId)?.username || '' : '', i.labels.join(';'),
        i.storyPoints ?? '', i.parentId ? keyOf(i.parentId) : '', i.epicId ? keyOf(i.epicId) : '',
        i.sprintId ? db.sprints.find(s => s.id === i.sprintId)?.name || '' : '', i.dueDate || '', i.createdAt, i.resolvedAt || '']);
    }
    return [200, formatCsv(rows), 'text/csv; charset=utf-8'];
  });
  route('POST', '/api/projects/:id/import.csv', ({ user, params, rawBody }) => {
    const { project } = getProject(user, params.id, 'developer');
    const rows = parseCsv(rawBody || '');
    if (!rows.length) throw bad('empty CSV');
    const header = rows[0].map(h => h.trim());
    if (!header.includes('title')) throw bad('CSV header must include a title column');
    const col = n => header.indexOf(n);
    const errors = []; let created = 0;
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const line = r + 1;
      if (row.length === 1 && row[0] === '') continue;
      const get = n => { const c = col(n); return c >= 0 && row[c] != null ? row[c].trim() : ''; };
      try {
        const b = { title: get('title') };
        if (get('type')) b.type = get('type');
        if (get('status')) b.status = get('status');
        if (get('priority')) b.priority = get('priority');
        if (get('assignee')) { const u = userByName(get('assignee')); if (!u) throw bad(`unknown assignee ${get('assignee')}`); b.assigneeId = u.id; }
        if (get('labels')) b.labels = get('labels').split(';').map(s => s.trim()).filter(Boolean);
        if (get('storyPoints')) { const n = Number(get('storyPoints')); if (!Number.isFinite(n)) throw bad('invalid storyPoints'); b.storyPoints = n; }
        if (get('parent')) { const p = findIssue(get('parent')); if (!p || p.projectId !== project.id) throw bad(`unknown parent ${get('parent')}`); b.parentId = p.id; }
        if (get('epic')) { const p = findIssue(get('epic')); if (!p || p.projectId !== project.id) throw bad(`unknown epic ${get('epic')}`); b.epicId = p.id; }
        if (get('sprint')) { const s = db.sprints.find(s => s.projectId === project.id && (s.name === get('sprint') || s.id === get('sprint')) && s.state !== 'completed'); if (!s) throw bad(`unknown sprint ${get('sprint')}`); b.sprintId = s.id; }
        if (get('dueDate')) b.dueDate = get('dueDate');
        const issue = createIssue(project, user, b);
        created++;
        fire(project, 'issue.created', issue, user);
      } catch (e) {
        if (e instanceof HttpError) errors.push({ line, message: e.message }); else throw e;
      }
    }
    return [200, { created, errors }];
  }, { raw: true });

  // --- webhooks
  const whOut = w => ({ id: w.id, projectId: w.projectId, url: w.url, events: w.events, createdAt: w.createdAt });
  route('POST', '/api/projects/:id/webhooks', ({ user, params, body }) => {
    const { project } = getProject(user, params.id, 'lead');
    let u;
    try { u = new URL(body.url); } catch { throw bad('valid url required'); }
    if (!/^https?:$/.test(u.protocol)) throw bad('url must be http(s)');
    if (!Array.isArray(body.events) || !body.events.length || body.events.some(e => !EVENTS.includes(e))) throw bad('invalid events');
    if (body.secret != null && typeof body.secret !== 'string') throw bad('secret must be a string');
    const w = { id: rid(), projectId: project.id, url: body.url, events: [...new Set(body.events)], secret: body.secret || '', createdAt: now() };
    db.webhooks.push(w);
    audit(project.workspaceId, 'webhook.created', user.id, { webhookId: w.id, projectId: project.id, url: w.url });
    return [201, whOut(w)];
  });
  route('GET', '/api/projects/:id/webhooks', ({ user, params }) => {
    const { project } = getProject(user, params.id, 'lead');
    return [200, db.webhooks.filter(w => w.projectId === project.id).map(whOut)];
  });
  function getWebhook(user, id) {
    const w = db.webhooks.find(w => w.id === id);
    if (!w) throw notFound('webhook not found');
    const { project } = getProject(user, w.projectId, 'lead');
    return { w, project };
  }
  route('DELETE', '/api/webhooks/:id', ({ user, params }) => {
    const { w, project } = getWebhook(user, params.id);
    db.webhooks = db.webhooks.filter(x => x !== w);
    audit(project.workspaceId, 'webhook.deleted', user.id, { webhookId: w.id, projectId: project.id });
    return [204];
  });
  route('GET', '/api/webhooks/:id/deliveries', ({ user, params }) => {
    const { w } = getWebhook(user, params.id);
    return [200, db.deliveries.filter(d => d.webhookId === w.id)];
  });

  // ---------- HTTP plumbing ----------
  function send(res, status, payload, ctype = 'application/json; charset=utf-8') {
    if (status === 204) { res.writeHead(204); return res.end(); }
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    res.writeHead(status, { 'content-type': ctype, 'content-length': Buffer.byteLength(data) });
    res.end(data);
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      req.on('data', c => { size += c.length; if (size > 5 * 1024 * 1024) { reject(new HttpError(400, 'validation_error', 'body too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }
  function serveStatic(req, res, pathname) {
    let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/static\//, '');
    const file = path.normalize(path.join(STATIC_DIR, rel));
    if (!file.startsWith(STATIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: 'not_found', message: 'not found' });
    const data = fs.readFileSync(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-length': data.length });
    res.end(data);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname;
      if (req.method === 'GET' && (pathname === '/' || pathname.startsWith('/static/'))) return serveStatic(req, res, pathname);
      if (!pathname.startsWith('/api/')) throw notFound('not found');
      let matched = null, params = {}, pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== req.method) continue;
        matched = r; r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        break;
      }
      if (!matched) throw pathMatched ? new HttpError(405, 'method_not_allowed', 'method not allowed') : notFound('route not found');
      let user = null;
      if (matched.auth) { user = authenticate(req); if (!user) throw new HttpError(401, 'unauthorized', 'authentication required'); }
      let body = {}, rawBody;
      if (req.method !== 'GET' && req.method !== 'DELETE' || req.headers['content-length'] > 0) {
        const text = await readBody(req);
        if (matched.raw) rawBody = text;
        else if (text.trim()) {
          try { body = JSON.parse(text); } catch { throw bad('invalid JSON'); }
          if (!isObj(body)) throw bad('body must be a JSON object');
        }
      }
      const out = matched.handler({ req, user, params, body, rawBody, query: url.searchParams });
      if (req.method !== 'GET') save();
      send(res, out[0], out[1], out[2]);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.error, message: e.message });
      console.error(e);
      send(res, 500, { error: 'internal_error', message: 'internal error' });
    }
  });
  return server;
}
