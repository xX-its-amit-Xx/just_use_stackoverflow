import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { toCsv, parseCsv } from './csv.js';
import { compile, QueryError } from './search.js';

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');
const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIOS = ['urgent', 'high', 'medium', 'low', 'none'];
const CATS = ['backlog', 'unstarted', 'started', 'completed'];
const EVENTS = ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'];
const DEFAULT_STATUSES = [['Backlog', 'backlog'], ['Todo', 'unstarted'], ['In Progress', 'started'], ['In Review', 'started'], ['Done', 'completed']];
const CSV_HEADER = ['key', 'type', 'title', 'status', 'priority', 'assignee', 'labels', 'storyPoints', 'parent', 'epic', 'sprint', 'dueDate', 'createdAt', 'resolvedAt'];

class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}
const bad = (m) => new HttpError(400, 'validation_error', m);
const forbidden = (m = 'forbidden') => new HttpError(403, 'forbidden', m);
const notFound = (m = 'not found') => new HttpError(404, 'not_found', m);
const conflict = (code, m) => new HttpError(409, code, m || code);

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const newId = () => crypto.randomBytes(8).toString('hex');
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return 'scrypt$' + salt.toString('hex') + '$' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function checkPassword(pw, stored) {
  const [, salt, h] = stored.split('$');
  const a = crypto.scryptSync(pw, Buffer.from(salt, 'hex'), 32), b = Buffer.from(h, 'hex');
  return crypto.timingSafeEqual(a, b);
}
const emptyDb = () => ({
  users: [], sessions: [], tokens: [], workspaces: [], wsMembers: [], projects: [], projMembers: [], issues: [],
  comments: [], links: [], history: [], notifications: [], sprints: [], webhooks: [], deliveries: [], audit: [],
});

export function createServer({ dataFile, clock } = {}) {
  const now = () => (clock ? clock() : new Date());
  const iso = () => now().toISOString();
  let db = emptyDb();
  if (dataFile && fs.existsSync(dataFile)) {
    try { db = { ...emptyDb(), ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) }; } catch { /* ignore */ }
  }
  function save() {
    if (!dataFile) return;
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, dataFile);
  }
  const failures = new Map();

  // ---------- lookups ----------
  const userById = (id) => db.users.find(u => u.id === id);
  const userByName = (n) => typeof n === 'string' ? db.users.find(u => u.username.toLowerCase() === n.toLowerCase()) : undefined;
  const pubUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName, createdAt: u.createdAt });
  const wsOf = (id) => db.workspaces.find(w => w.id === id);
  const projOf = (id) => db.projects.find(p => p.id === id);
  const wsRole = (user, wsId) => db.wsMembers.find(m => m.workspaceId === wsId && m.userId === user.id)?.role || null;
  function projRole(user, p) {
    const wr = wsRole(user, p.workspaceId);
    if (wr === 'admin') return 'lead';
    const pm = db.projMembers.find(m => m.projectId === p.id && m.userId === user.id);
    if (pm) return pm.role;
    if (wr === 'member') return 'developer';
    return null;
  }
  const RANK = { viewer: 1, developer: 2, lead: 3 };
  function getProject(user, id, min = 'viewer') {
    const p = projOf(id); if (!p) throw notFound('project not found');
    const r = projRole(user, p); if (!r) throw notFound('project not found');
    if (RANK[r] < RANK[min]) throw forbidden('insufficient project role');
    return p;
  }
  function getWs(user, id, role) {
    const w = wsOf(id); if (!w) throw notFound('workspace not found');
    const r = wsRole(user, id); if (!r) throw forbidden('not a workspace member');
    if (role === 'admin' && r !== 'admin') throw forbidden('admin only');
    if (role === 'member' && r === 'guest') throw forbidden('guests cannot do this');
    return w;
  }
  const findIssue = (key) => db.issues.find(i => i.key === String(key).toUpperCase());
  function getIssue(user, key, min = 'viewer') {
    const i = findIssue(key); if (!i) throw notFound('issue not found');
    const p = getProject(user, i.projectId, min);
    return { issue: i, project: p };
  }
  function resolveIssueRef(ref, project) {
    if (ref === null || ref === undefined || ref === '') return null;
    const i = db.issues.find(x => x.id === ref || x.key === String(ref).toUpperCase());
    if (!i || i.projectId !== project.id) throw bad('referenced issue not found in project');
    return i;
  }
  const statusCat = (p, name) => p.workflow.statuses.find(s => s.name === name)?.category;
  const isDone = (p, name) => statusCat(p, name) === 'completed';

  // ---------- audit / notifications / webhooks ----------
  function audit(wsId, actor, action, details) {
    db.audit.push({ id: newId(), workspaceId: wsId, action, type: action, actorId: actor.id, details: details || {}, at: iso() });
  }
  function notify(issue, project, userIds, type, actor, extra = {}) {
    const seen = new Set();
    for (const uid of userIds) {
      if (seen.has(uid) || uid === actor.id) continue; seen.add(uid);
      const u = userById(uid); if (!u || !projRole(u, project)) continue;
      db.notifications.push({ id: newId(), userId: uid, type, issueKey: issue.key, actorId: actor.id, at: iso(), read: false, ...extra });
    }
  }
  function fire(project, event, issue, actor, extra = {}) {
    for (const wh of db.webhooks) {
      if (wh.projectId !== project.id || !wh.events.includes(event)) continue;
      const body = JSON.stringify({ event, issue, actorId: actor.id, at: iso(), ...extra });
      const d = { id: newId(), webhookId: wh.id, event, status: 'pending', attempts: 0, lastError: null, at: iso() };
      db.deliveries.push(d);
      deliver(wh, d, body);
    }
  }
  async function deliver(wh, d, body) {
    const sig = 'sha256=' + crypto.createHmac('sha256', wh.secret).update(body).digest('hex');
    for (let a = 1; a <= 3; a++) {
      d.attempts = a;
      try {
        const r = await fetch(wh.url, { method: 'POST', body, headers: { 'content-type': 'application/json', 'x-pm-signature': sig, 'x-pm-event': d.event }, signal: AbortSignal.timeout(5000) });
        d.responseStatus = r.status;
        if (r.status >= 200 && r.status < 300) { d.status = 'success'; d.lastError = null; save(); return; }
        d.lastError = 'HTTP ' + r.status;
      } catch (e) { d.lastError = String(e.message || e); }
      d.status = 'failed'; save();
      if (a < 3) await new Promise(r => setTimeout(r, 50 * a));
    }
  }

  // ---------- issues ----------
  const outIssue = (i, full) => {
    const o = {};
    for (const k of Object.keys(i)) if (!k.startsWith('_')) o[k] = i[k];
    o.watchers = [...i.watchers]; o.labels = [...i.labels];
    if (full) {
      const p = projOf(i.projectId);
      o.children = db.issues.filter(c => c.parentId === i.id).map(c => c.key);
      o.links = linksFor(i);
      if (i.type === 'epic') {
        const m = db.issues.filter(c => c.epicId === i.id);
        o.progress = { total: m.length, done: m.filter(c => c.resolvedAt).length,
          points_total: m.reduce((s, c) => s + (c.storyPoints || 0), 0), points_done: m.filter(c => c.resolvedAt).reduce((s, c) => s + (c.storyPoints || 0), 0) };
      }
      void p;
    }
    return o;
  };
  const INV = { blocks: 'blocked_by', duplicates: 'duplicated_by', relates: 'relates' };
  function linksFor(i) {
    const res = [];
    for (const l of db.links) {
      if (l.sourceId === i.id) { const t = db.issues.find(x => x.id === l.targetId); if (t) res.push({ id: l.id, type: l.type, key: t.key, issueKey: t.key, target: t.key, title: t.title, status: t.status }); }
      else if (l.targetId === i.id) { const t = db.issues.find(x => x.id === l.sourceId); if (t) res.push({ id: l.id, type: INV[l.type], key: t.key, issueKey: t.key, target: t.key, title: t.title, status: t.status }); }
    }
    return res;
  }
  const initialStatus = (p) => (p.workflow.statuses.find(s => s.category === 'unstarted') || p.workflow.statuses[0]).name;
  function validDate(v, name) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v) || isNaN(Date.parse(v))) throw bad(name + ' must be a date YYYY-MM-DD');
    return v;
  }
  function resolveAssignee(project, data) {
    if (data.assigneeId === undefined && data.assignee === undefined) return undefined;
    const ref = data.assigneeId !== undefined ? data.assigneeId : data.assignee;
    if (ref === null || ref === '') return null;
    const u = userById(ref) || userByName(ref);
    if (!u || !projRole(u, project)) throw bad('assignee must be a member who can see the project');
    return u.id;
  }
  // normalise + validate a field set; `cur` is current issue (patch) or null
  function normalize(project, data, cur) {
    const out = {};
    if ('title' in data || !cur) {
      if (typeof data.title !== 'string' || !data.title.trim() || data.title.length > 300) throw bad('title is required (1-300 chars)');
      out.title = data.title.trim();
    }
    if ('description' in data) {
      if (data.description !== null && typeof data.description !== 'string') throw bad('description must be a string');
      out.description = data.description || '';
    }
    if ('type' in data || !cur) {
      const t = data.type === undefined ? 'task' : data.type;
      if (!TYPES.includes(t)) throw bad('invalid type'); out.type = t;
    }
    if ('priority' in data || !cur) {
      const t = data.priority === undefined ? 'none' : data.priority;
      if (!PRIOS.includes(t)) throw bad('invalid priority'); out.priority = t;
    }
    if ('status' in data) {
      if (typeof data.status !== 'string' || !project.workflow.statuses.some(s => s.name === data.status)) throw bad('unknown status');
      out.status = data.status;
    }
    const as = resolveAssignee(project, data); if (as !== undefined) out.assigneeId = as;
    if ('labels' in data) {
      if (!Array.isArray(data.labels) || data.labels.some(l => typeof l !== 'string' || !l.trim())) throw bad('labels must be an array of strings');
      out.labels = [...new Set(data.labels.map(l => l.trim()))];
    }
    if ('storyPoints' in data) {
      const v = data.storyPoints;
      if (v !== null && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) throw bad('storyPoints must be a non-negative number');
      out.storyPoints = v;
    }
    if ('dueDate' in data) out.dueDate = validDate(data.dueDate, 'dueDate');
    if ('parentId' in data) out.parentId = resolveIssueRef(data.parentId, project)?.id ?? null;
    if ('epicId' in data) out.epicId = resolveIssueRef(data.epicId, project)?.id ?? null;
    if ('sprintId' in data) {
      if (data.sprintId === null || data.sprintId === '') out.sprintId = null;
      else {
        const s = db.sprints.find(x => x.id === data.sprintId);
        if (!s || s.projectId !== project.id) throw bad('sprint not found in project');
        if (s.state === 'completed') throw bad('sprint is completed');
        out.sprintId = s.id;
      }
    }
    // structural checks on merged
    const m = { ...(cur || { parentId: null, epicId: null }), ...out };
    if (m.type === 'subtask') {
      const par = db.issues.find(x => x.id === m.parentId);
      if (!par) throw bad('subtask requires parentId');
      if (par.type === 'subtask') throw bad('parent cannot be a subtask');
    } else if (m.parentId) {
      const par = db.issues.find(x => x.id === m.parentId);
      if (m.type === 'epic') throw bad('epics cannot have parents');
      if (par.type === 'subtask') throw bad('parent cannot be a subtask');
    }
    if (m.parentId && cur && m.parentId === cur.id) throw bad('issue cannot be its own parent');
    if (m.epicId) {
      const e = db.issues.find(x => x.id === m.epicId);
      if (!e || e.type !== 'epic') throw bad('epicId must reference an epic');
    }
    return out;
  }
  function createIssue(project, actor, data, opts = {}) {
    const f = normalize(project, data, null);
    const status = f.status || initialStatus(project);
    const t = iso();
    project.nextNumber = (project.nextNumber || 1);
    const n = project.nextNumber++;
    const issue = {
      id: newId(), key: `${project.key}-${n}`, projectId: project.id, type: f.type, title: f.title, description: f.description || '',
      status, priority: f.priority, assigneeId: f.assigneeId ?? null, reporterId: actor.id, labels: f.labels || [],
      storyPoints: f.storyPoints ?? null, parentId: f.parentId ?? null, epicId: f.epicId ?? null, sprintId: f.sprintId ?? null,
      dueDate: f.dueDate ?? null, watchers: [], createdAt: t, updatedAt: t, resolvedAt: isDone(project, status) ? t : null,
      _init: { status, sprintId: f.sprintId ?? null, startedAt: statusCat(project, status) === 'started' ? t : null },
    };
    issue.watchers.push(actor.id);
    if (issue.assigneeId && !issue.watchers.includes(issue.assigneeId)) issue.watchers.push(issue.assigneeId);
    db.issues.push(issue);
    if (issue.assigneeId) notify(issue, project, [issue.assigneeId], 'assigned', actor);
    if (!opts.quiet) fire(project, 'issue.created', outIssue(issue, true), actor);
    return issue;
  }
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function patchIssue(project, issue, actor, data, role) {
    const f = normalize(project, data, issue);
    const t = iso();
    if (f.status !== undefined && f.status !== issue.status) {
      if (!project.workflow.transitions.some(([a, b]) => a === issue.status && b === f.status)) throw conflict('invalid_transition', `transition ${issue.status} -> ${f.status} not allowed`);
      if (isDone(project, f.status)) {
        for (const l of db.links) {
          let blocker = null;
          if (l.type === 'blocks' && l.targetId === issue.id) blocker = db.issues.find(x => x.id === l.sourceId);
          if (blocker && !blocker.resolvedAt) throw conflict('blocked', `blocked by ${blocker.key}`);
        }
      }
    }
    const changed = [];
    for (const k of Object.keys(f)) {
      if (same(issue[k], f[k])) continue;
      db.history.push({ id: newId(), issueId: issue.id, field: k, from: issue[k] ?? null, to: f[k] ?? null, actorId: actor.id, at: t });
      issue[k] = f[k]; changed.push(k);
    }
    if (changed.includes('status')) {
      const done = isDone(project, issue.status);
      if (done && !issue.resolvedAt) issue.resolvedAt = t; else if (!done) issue.resolvedAt = null;
    }
    if (changed.length) {
      issue.updatedAt = t;
      if (changed.includes('assigneeId') && issue.assigneeId) {
        if (!issue.watchers.includes(issue.assigneeId)) issue.watchers.push(issue.assigneeId);
        notify(issue, project, issue.watchers, 'assigned', actor);
      }
      if (changed.includes('status')) notify(issue, project, issue.watchers, 'status_changed', actor);
      fire(project, 'issue.updated', outIssue(issue, true), actor, { changes: changed });
    }
    void role;
    return issue;
  }
  function deleteIssue(project, issue, actor) {
    const kids = db.issues.filter(c => c.parentId === issue.id);
    for (const k of kids) deleteIssue(project, k, actor);
    const snap = outIssue(issue, true);
    db.issues = db.issues.filter(x => x.id !== issue.id);
    db.links = db.links.filter(l => l.sourceId !== issue.id && l.targetId !== issue.id);
    db.comments = db.comments.filter(c => c.issueId !== issue.id);
    db.history = db.history.filter(h => h.issueId !== issue.id);
    db.notifications = db.notifications.filter(n => n.issueKey !== issue.key);
    for (const x of db.issues) { if (x.epicId === issue.id) x.epicId = null; }
    fire(project, 'issue.deleted', snap, actor);
  }

  // ---------- routes ----------
  const routes = [];
  const R = (method, pattern, handler, auth = true) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, auth });
  };
  const str = (v, name, min = 1, max = 200) => {
    if (typeof v !== 'string' || v.trim().length < min || v.length > max) throw bad(`${name} is required`);
    return v.trim();
  };

  // auth
  R('POST', '/api/auth/register', (c) => {
    const username = str(c.body.username, 'username', 3, 32);
    if (!/^[A-Za-z0-9_.-]+$/.test(username)) throw bad('username may contain letters, digits, _ . -');
    if (typeof c.body.password !== 'string' || c.body.password.length < 8 || c.body.password.length > 200) throw bad('password must be at least 8 characters');
    if (c.body.displayName !== undefined && typeof c.body.displayName !== 'string') throw bad('displayName must be a string');
    if (userByName(username)) throw conflict('conflict', 'username taken');
    const u = { id: newId(), username, displayName: (c.body.displayName || username).trim() || username, passwordHash: hashPassword(c.body.password), createdAt: iso() };
    db.users.push(u);
    return [201, pubUser(u)];
  }, false);
  R('POST', '/api/auth/login', (c) => {
    const username = typeof c.body.username === 'string' ? c.body.username : '';
    const fk = username.toLowerCase();
    const t = now().getTime();
    const rec = failures.get(fk);
    if (rec && t - rec.first > 60000) failures.delete(fk);
    const cur = failures.get(fk);
    if (cur && cur.n >= 5) { c.headers['retry-after'] = '60'; throw new HttpError(429, 'rate_limited', 'too many failed attempts'); }
    const u = userByName(username);
    if (!u || typeof c.body.password !== 'string' || !checkPassword(c.body.password, u.passwordHash)) {
      const r = failures.get(fk) || { n: 0, first: t }; r.n++; failures.set(fk, r);
      throw new HttpError(401, 'unauthorized', 'invalid credentials');
    }
    failures.delete(fk);
    const token = crypto.randomBytes(32).toString('hex');
    db.sessions.push({ hash: sha(token), userId: u.id, createdAt: iso() });
    return [200, { token, user: pubUser(u) }];
  }, false);
  R('POST', '/api/auth/logout', (c) => {
    db.sessions = db.sessions.filter(s => s.hash !== sha(c.tokenStr));
    return [204];
  });
  R('GET', '/api/auth/me', (c) => [200, pubUser(c.user)]);
  R('PATCH', '/api/auth/me', (c) => {
    const b = c.body; const u = c.user;
    if (b.password !== undefined) {
      if (typeof b.currentPassword !== 'string' || !checkPassword(b.currentPassword, u.passwordHash)) throw forbidden('current password incorrect');
      if (typeof b.password !== 'string' || b.password.length < 8) throw bad('password must be at least 8 characters');
      u.passwordHash = hashPassword(b.password);
    } else if (b.currentPassword !== undefined && (typeof b.currentPassword !== 'string' || !checkPassword(b.currentPassword, u.passwordHash))) throw forbidden('current password incorrect');
    if (b.displayName !== undefined) u.displayName = str(b.displayName, 'displayName', 1, 100);
    return [200, pubUser(u)];
  });
  R('GET', '/api/users', (c) => [200, db.users.map(pubUser)]);

  // tokens
  const wsForUser = (u) => db.wsMembers.filter(m => m.userId === u.id).map(m => m.workspaceId);
  R('POST', '/api/tokens', (c) => {
    const name = str(c.body.name, 'name', 1, 100);
    const token = 'pmt_' + crypto.randomBytes(24).toString('hex');
    const t = { id: newId(), userId: c.user.id, name, hash: sha(token), createdAt: iso() };
    db.tokens.push(t);
    for (const w of wsForUser(c.user)) audit(w, c.user, 'token.created', { tokenId: t.id, name });
    return [201, { id: t.id, name, token, createdAt: t.createdAt }];
  });
  R('GET', '/api/tokens', (c) => [200, db.tokens.filter(t => t.userId === c.user.id).map(t => ({ id: t.id, name: t.name, createdAt: t.createdAt }))]);
  R('DELETE', '/api/tokens/:id', (c) => {
    const t = db.tokens.find(x => x.id === c.params.id && x.userId === c.user.id); if (!t) throw notFound('token not found');
    db.tokens = db.tokens.filter(x => x !== t);
    for (const w of wsForUser(c.user)) audit(w, c.user, 'token.deleted', { tokenId: t.id, name: t.name });
    return [204];
  });

  // workspaces
  const outWs = (w, u) => ({ id: w.id, name: w.name, key: w.key, createdAt: w.createdAt, role: wsRole(u, w.id) });
  R('POST', '/api/workspaces', (c) => {
    const name = str(c.body.name, 'name', 1, 100);
    if (typeof c.body.key !== 'string' || !/^[A-Z]{2,10}$/.test(c.body.key)) throw bad('key must be 2-10 uppercase letters');
    if (db.workspaces.some(w => w.key === c.body.key)) throw conflict('conflict', 'workspace key taken');
    const w = { id: newId(), name, key: c.body.key, createdAt: iso() };
    db.workspaces.push(w);
    db.wsMembers.push({ workspaceId: w.id, userId: c.user.id, role: 'admin' });
    return [201, outWs(w, c.user)];
  });
  R('GET', '/api/workspaces', (c) => [200, db.workspaces.filter(w => wsRole(c.user, w.id)).map(w => outWs(w, c.user))]);
  R('GET', '/api/workspaces/:id', (c) => [200, outWs(getWs(c.user, c.params.id), c.user)]);
  const outMember = (m) => { const u = userById(m.userId); return { userId: m.userId, username: u?.username, displayName: u?.displayName, role: m.role }; };
  R('GET', '/api/workspaces/:id/members', (c) => {
    getWs(c.user, c.params.id);
    return [200, db.wsMembers.filter(m => m.workspaceId === c.params.id).map(outMember)];
  });
  const WROLES = ['admin', 'member', 'guest'];
  R('POST', '/api/workspaces/:id/members', (c) => {
    const w = getWs(c.user, c.params.id, 'admin');
    const u = userByName(c.body.username) ; if (!u) throw notFound('user not found');
    const role = c.body.role === undefined ? 'member' : c.body.role;
    if (!WROLES.includes(role)) throw bad('invalid role');
    if (db.wsMembers.some(m => m.workspaceId === w.id && m.userId === u.id)) throw conflict('conflict', 'already a member');
    const m = { workspaceId: w.id, userId: u.id, role }; db.wsMembers.push(m);
    audit(w.id, c.user, 'member.added', { userId: u.id, username: u.username, role });
    return [201, outMember(m)];
  });
  const findWsMember = (wsId, ref) => {
    const u = userById(ref) || userByName(ref);
    const m = u && db.wsMembers.find(x => x.workspaceId === wsId && x.userId === u.id);
    if (!m) throw notFound('member not found'); return m;
  };
  const adminCount = (wsId) => db.wsMembers.filter(m => m.workspaceId === wsId && m.role === 'admin').length;
  R('PATCH', '/api/workspaces/:id/members/:uid', (c) => {
    const w = getWs(c.user, c.params.id, 'admin'); const m = findWsMember(w.id, c.params.uid);
    if (!WROLES.includes(c.body.role)) throw bad('invalid role');
    if (m.role === 'admin' && c.body.role !== 'admin' && adminCount(w.id) <= 1) throw bad('cannot demote the last admin');
    const from = m.role; m.role = c.body.role;
    audit(w.id, c.user, 'member.role_changed', { userId: m.userId, from, to: m.role });
    return [200, outMember(m)];
  });
  R('DELETE', '/api/workspaces/:id/members/:uid', (c) => {
    const w = getWs(c.user, c.params.id, 'admin'); const m = findWsMember(w.id, c.params.uid);
    if (m.role === 'admin' && adminCount(w.id) <= 1) throw bad('cannot remove the last admin');
    db.wsMembers = db.wsMembers.filter(x => x !== m);
    const pids = db.projects.filter(p => p.workspaceId === w.id).map(p => p.id);
    db.projMembers = db.projMembers.filter(x => !(x.userId === m.userId && pids.includes(x.projectId)));
    audit(w.id, c.user, 'member.removed', { userId: m.userId });
    return [204];
  });
  R('GET', '/api/workspaces/:id/audit', (c) => {
    getWs(c.user, c.params.id, 'admin');
    return [200, db.audit.filter(a => a.workspaceId === c.params.id).slice().reverse()];
  });

  // projects
  const outProj = (p, u) => ({ id: p.id, workspaceId: p.workspaceId, name: p.name, key: p.key, workflow: p.workflow, createdAt: p.createdAt, role: projRole(u, p) });
  R('POST', '/api/workspaces/:id/projects', (c) => {
    const w = getWs(c.user, c.params.id, 'member');
    const name = str(c.body.name, 'name', 1, 100);
    if (typeof c.body.key !== 'string' || !/^[A-Z][A-Z0-9]{1,9}$/.test(c.body.key)) throw bad('key must be 2-10 uppercase letters/digits');
    if (db.projects.some(p => p.key === c.body.key)) throw conflict('conflict', 'project key taken');
    const names = DEFAULT_STATUSES.map(s => s[0]);
    const p = { id: newId(), workspaceId: w.id, name, key: c.body.key, nextNumber: 1, createdAt: iso(),
      workflow: { statuses: DEFAULT_STATUSES.map(([name, category]) => ({ name, category })), transitions: names.flatMap(a => names.filter(b => b !== a).map(b => [a, b])) } };
    db.projects.push(p);
    db.projMembers.push({ projectId: p.id, userId: c.user.id, role: 'lead' });
    return [201, outProj(p, c.user)];
  });
  R('GET', '/api/workspaces/:id/projects', (c) => {
    getWs(c.user, c.params.id);
    return [200, db.projects.filter(p => p.workspaceId === c.params.id && projRole(c.user, p)).map(p => outProj(p, c.user))];
  });
  R('GET', '/api/projects/:id', (c) => [200, outProj(getProject(c.user, c.params.id), c.user)]);
  R('GET', '/api/projects/:id/members', (c) => {
    const p = getProject(c.user, c.params.id);
    const ids = new Set(db.projMembers.filter(m => m.projectId === p.id).map(m => m.userId));
    for (const m of db.wsMembers) if (m.workspaceId === p.workspaceId && m.role !== 'guest') ids.add(m.userId);
    return [200, [...ids].map(uid => { const u = userById(uid); return { userId: uid, username: u.username, displayName: u.displayName, role: projRole(u, p) }; })];
  });
  const PROLES = ['lead', 'developer', 'viewer'];
  R('POST', '/api/projects/:id/members', (c) => {
    const p = getProject(c.user, c.params.id, 'lead');
    const u = userByName(c.body.username); if (!u) throw notFound('user not found');
    if (!PROLES.includes(c.body.role)) throw bad('invalid role');
    if (!wsRole(u, p.workspaceId)) throw bad('user must be a workspace member first');
    let m = db.projMembers.find(x => x.projectId === p.id && x.userId === u.id);
    if (m) m.role = c.body.role; else { m = { projectId: p.id, userId: u.id, role: c.body.role }; db.projMembers.push(m); }
    audit(p.workspaceId, c.user, 'project.member_set', { projectId: p.id, userId: u.id, role: m.role });
    return [201, { userId: u.id, username: u.username, role: m.role }];
  });
  R('PATCH', '/api/projects/:id/members/:uid', (c) => {
    const p = getProject(c.user, c.params.id, 'lead');
    const u = userById(c.params.uid) || userByName(c.params.uid); if (!u) throw notFound('user not found');
    if (!PROLES.includes(c.body.role)) throw bad('invalid role');
    let m = db.projMembers.find(x => x.projectId === p.id && x.userId === u.id);
    if (!m) { if (!wsRole(u, p.workspaceId)) throw notFound('member not found'); m = { projectId: p.id, userId: u.id }; db.projMembers.push(m); }
    m.role = c.body.role;
    audit(p.workspaceId, c.user, 'project.member_set', { projectId: p.id, userId: u.id, role: m.role });
    return [200, { userId: u.id, username: u.username, role: m.role }];
  });
  R('DELETE', '/api/projects/:id/members/:uid', (c) => {
    const p = getProject(c.user, c.params.id, 'lead');
    const u = userById(c.params.uid) || userByName(c.params.uid);
    const m = u && db.projMembers.find(x => x.projectId === p.id && x.userId === u.id); if (!m) throw notFound('member not found');
    db.projMembers = db.projMembers.filter(x => x !== m);
    audit(p.workspaceId, c.user, 'project.member_removed', { projectId: p.id, userId: u.id });
    return [204];
  });
  R('PUT', '/api/projects/:id/workflow', (c) => {
    const p = getProject(c.user, c.params.id, 'lead');
    const { statuses, transitions, remap } = c.body;
    if (!Array.isArray(statuses) || !statuses.length) throw bad('statuses required');
    const names = new Set();
    for (const s of statuses) {
      if (!s || typeof s.name !== 'string' || !s.name.trim()) throw bad('status name required');
      if (!CATS.includes(s.category)) throw bad('invalid category');
      if (names.has(s.name)) throw bad('duplicate status name'); names.add(s.name);
    }
    if (!Array.isArray(transitions)) throw bad('transitions required');
    for (const t of transitions) if (!Array.isArray(t) || t.length !== 2 || !names.has(t[0]) || !names.has(t[1])) throw bad('transition references unknown status');
    if (remap !== undefined && (typeof remap !== 'object' || remap === null || Array.isArray(remap))) throw bad('remap must be an object');
    const rm = remap || {};
    const used = [...new Set(db.issues.filter(i => i.projectId === p.id).map(i => i.status))];
    for (const u of used) if (!names.has(u)) { if (!rm[u] || !names.has(rm[u])) throw bad(`status "${u}" is in use; provide remap`); }
    const wf = { statuses: statuses.map(s => ({ name: s.name, category: s.category })), transitions: transitions.map(t => [t[0], t[1]]) };
    const old = p.workflow; p.workflow = wf;
    const t = iso();
    for (const i of db.issues) {
      if (i.projectId !== p.id || names.has(i.status)) continue;
      const to = rm[i.status];
      db.history.push({ id: newId(), issueId: i.id, field: 'status', from: i.status, to, actorId: c.user.id, at: t });
      i.status = to; i.updatedAt = t;
    }
    for (const i of db.issues) {
      if (i.projectId !== p.id) continue;
      const d = isDone(p, i.status);
      if (d && !i.resolvedAt) i.resolvedAt = t; else if (!d) i.resolvedAt = null;
    }
    void old;
    audit(p.workspaceId, c.user, 'workflow.updated', { projectId: p.id, statuses: wf.statuses.map(s => s.name) });
    return [200, wf];
  });
  R('GET', '/api/projects/:id/workflow', (c) => [200, getProject(c.user, c.params.id).workflow]);

  // issues
  R('POST', '/api/projects/:id/issues', (c) => {
    const p = getProject(c.user, c.params.id, 'developer');
    return [201, outIssue(createIssue(p, c.user, c.body), true)];
  });
  R('GET', '/api/projects/:id/issues', (c) => {
    const p = getProject(c.user, c.params.id); const q = c.query;
    let list = db.issues.filter(i => i.projectId === p.id);
    if (q.status) list = list.filter(i => i.status === q.status);
    if (q.type) list = list.filter(i => i.type === q.type);
    if (q.assignee) list = list.filter(i => { const u = userByName(q.assignee); return q.assignee === 'none' ? !i.assigneeId : q.assignee === 'me' ? i.assigneeId === c.user.id : (i.assigneeId === q.assignee || (u && i.assigneeId === u.id)); });
    if (q.sprint) list = list.filter(i => q.sprint === 'none' ? !i.sprintId : i.sprintId === q.sprint);
    if (q.epic) list = list.filter(i => i.epicId === q.epic);
    return [200, list.map(i => outIssue(i, true))];
  });
  R('GET', '/api/issues/:key', (c) => [200, outIssue(getIssue(c.user, c.params.key).issue, true)]);
  R('PATCH', '/api/issues/:key', (c) => {
    const { issue, project } = getIssue(c.user, c.params.key, 'developer');
    return [200, outIssue(patchIssue(project, issue, c.user, c.body), true)];
  });
  R('DELETE', '/api/issues/:key', (c) => {
    const { issue, project } = getIssue(c.user, c.params.key, 'developer');
    deleteIssue(project, issue, c.user); return [204];
  });
  R('GET', '/api/issues/:key/history', (c) => {
    const { issue } = getIssue(c.user, c.params.key);
    return [200, db.history.filter(h => h.issueId === issue.id).map(h => ({ field: h.field, from: h.from, to: h.to, actorId: h.actorId, at: h.at }))];
  });
  R('POST', '/api/issues/:key/links', (c) => {
    const { issue, project } = getIssue(c.user, c.params.key, 'developer');
    if (!['blocks', 'relates', 'duplicates'].includes(c.body.type)) throw bad('invalid link type');
    const tgt = findIssue(typeof c.body.target === 'string' ? c.body.target : '');
    if (!tgt || !projRole(c.user, projOf(tgt.projectId))) throw bad('target issue not found');
    if (tgt.id === issue.id) throw bad('cannot link an issue to itself');
    if (db.links.some(l => (l.sourceId === issue.id && l.targetId === tgt.id && l.type === c.body.type) || (c.body.type === 'relates' && l.type === 'relates' && l.sourceId === tgt.id && l.targetId === issue.id))) throw conflict('conflict', 'link exists');
    const l = { id: newId(), type: c.body.type, sourceId: issue.id, targetId: tgt.id };
    db.links.push(l); issue.updatedAt = iso(); void project;
    return [201, { id: l.id, type: l.type, target: tgt.key, key: tgt.key, links: linksFor(issue) }];
  });
  R('DELETE', '/api/issues/:key/links/:lid', (c) => {
    const { issue } = getIssue(c.user, c.params.key, 'developer');
    const l = db.links.find(x => x.id === c.params.lid && (x.sourceId === issue.id || x.targetId === issue.id)); if (!l) throw notFound('link not found');
    db.links = db.links.filter(x => x !== l); return [204];
  });
  R('POST', '/api/issues/:key/watch', (c) => {
    const { issue } = getIssue(c.user, c.params.key);
    if (!issue.watchers.includes(c.user.id)) issue.watchers.push(c.user.id);
    return [200, outIssue(issue, true)];
  });
  R('DELETE', '/api/issues/:key/watch', (c) => {
    const { issue } = getIssue(c.user, c.params.key);
    issue.watchers = issue.watchers.filter(w => w !== c.user.id);
    return [200, outIssue(issue, true)];
  });

  // comments
  const outComment = (m, issue) => ({ id: m.id, issueId: m.issueId, issueKey: issue?.key, authorId: m.authorId, body: m.body, edited: !!m.edited, createdAt: m.createdAt, updatedAt: m.updatedAt });
  function mentions(body) {
    const set = new Set();
    for (const m of body.matchAll(/(?:^|[^A-Za-z0-9_])@([A-Za-z0-9_][A-Za-z0-9_.-]*)/g)) {
      let n = m[1].replace(/[.-]+$/, ''); const u = userByName(n); if (u) set.add(u.id);
    }
    return [...set];
  }
  R('POST', '/api/issues/:key/comments', (c) => {
    const { issue, project } = getIssue(c.user, c.params.key, 'developer');
    const body = str(c.body.body, 'body', 1, 20000);
    const t = iso();
    const m = { id: newId(), issueId: issue.id, authorId: c.user.id, body, edited: false, createdAt: t, updatedAt: t };
    db.comments.push(m);
    const ment = mentions(body);
    notify(issue, project, ment, 'mention', c.user, { commentId: m.id });
    notify(issue, project, issue.watchers.filter(w => !ment.includes(w)), 'comment', c.user, { commentId: m.id });
    fire(project, 'comment.created', outIssue(issue, true), c.user, { comment: outComment(m, issue) });
    return [201, outComment(m, issue)];
  });
  R('GET', '/api/issues/:key/comments', (c) => {
    const { issue } = getIssue(c.user, c.params.key);
    return [200, db.comments.filter(m => m.issueId === issue.id).map(m => outComment(m, issue))];
  });
  const getComment = (c, needAuthor) => {
    const m = db.comments.find(x => x.id === c.params.id); if (!m) throw notFound('comment not found');
    const issue = db.issues.find(i => i.id === m.issueId); const p = getProject(c.user, issue.projectId);
    if (needAuthor === 'author' && m.authorId !== c.user.id) throw forbidden('only the author can edit');
    if (needAuthor === 'delete' && m.authorId !== c.user.id && projRole(c.user, p) !== 'lead') throw forbidden('not allowed');
    return { m, issue, project: p };
  };
  R('PATCH', '/api/comments/:id', (c) => {
    const { m, issue } = getComment(c, 'author');
    m.body = str(c.body.body, 'body', 1, 20000); m.edited = true; m.updatedAt = iso();
    return [200, outComment(m, issue)];
  });
  R('DELETE', '/api/comments/:id', (c) => { const { m } = getComment(c, 'delete'); db.comments = db.comments.filter(x => x !== m); return [204]; });

  // notifications
  R('GET', '/api/notifications', (c) => {
    let l = db.notifications.filter(n => n.userId === c.user.id);
    if (c.query.unread === 'true') l = l.filter(n => !n.read);
    return [200, l.slice().reverse().map(({ userId, ...n }) => n)];
  });
  R('POST', '/api/notifications/read', (c) => {
    let n = 0;
    if (c.body.all === true) { for (const x of db.notifications) if (x.userId === c.user.id && !x.read) { x.read = true; n++; } }
    else if (Array.isArray(c.body.ids)) { for (const x of db.notifications) if (x.userId === c.user.id && !x.read && c.body.ids.includes(x.id)) { x.read = true; n++; } }
    else throw bad('ids or all required');
    return [200, { updated: n }];
  });

  // sprints
  const today = () => iso().slice(0, 10);
  const outSprint = (s) => ({ id: s.id, projectId: s.projectId, name: s.name, startDate: s.startDate, endDate: s.endDate, state: s.state, createdAt: s.createdAt, startedAt: s.startedAt || null, completedAt: s.completedAt || null });
  const getSprint = (c, min = 'viewer') => {
    const s = db.sprints.find(x => x.id === c.params.id); if (!s) throw notFound('sprint not found');
    return { s, p: getProject(c.user, s.projectId, min) };
  };
  R('POST', '/api/projects/:id/sprints', (c) => {
    const p = getProject(c.user, c.params.id, 'developer');
    const name = str(c.body.name, 'name', 1, 100);
    const startDate = validDate(c.body.startDate, 'startDate'), endDate = validDate(c.body.endDate, 'endDate');
    if (startDate && endDate && endDate < startDate) throw bad('endDate before startDate');
    const s = { id: newId(), projectId: p.id, name, startDate, endDate, state: 'planned', createdAt: iso() };
    db.sprints.push(s); return [201, outSprint(s)];
  });
  R('GET', '/api/projects/:id/sprints', (c) => { const p = getProject(c.user, c.params.id); return [200, db.sprints.filter(s => s.projectId === p.id).map(outSprint)]; });
  R('GET', '/api/sprints/:id', (c) => [200, outSprint(getSprint(c).s)]);
  R('POST', '/api/sprints/:id/start', (c) => {
    const { s, p } = getSprint(c, 'developer');
    if (s.state !== 'planned') throw conflict('conflict', 'sprint is not planned');
    if (db.sprints.some(x => x.projectId === p.id && x.state === 'active')) throw conflict('conflict', 'another sprint is active');
    s.state = 'active'; s.startedAt = iso();
    if (!s.startDate) s.startDate = today();
    const ms = db.issues.filter(i => i.sprintId === s.id);
    s.committedPoints = ms.reduce((a, i) => a + (i.storyPoints || 0), 0);
    s.committedIssues = ms.length;
    return [200, outSprint(s)];
  });
  R('POST', '/api/sprints/:id/complete', (c) => {
    const { s, p } = getSprint(c, 'developer');
    if (s.state !== 'active') throw conflict('conflict', 'sprint is not active');
    const to = c.body.carryOverTo === undefined ? 'backlog' : c.body.carryOverTo;
    let target = null;
    if (to !== 'backlog') {
      target = db.sprints.find(x => x.id === to);
      if (!target || target.projectId !== p.id || target.id === s.id || target.state === 'completed') throw bad('invalid carryOverTo');
    }
    const t = iso();
    const ms = db.issues.filter(i => i.sprintId === s.id);
    s.completedPoints = ms.filter(i => i.resolvedAt).reduce((a, i) => a + (i.storyPoints || 0), 0);
    s.completedIssues = ms.filter(i => i.resolvedAt).length;
    const un = ms.filter(i => !i.resolvedAt);
    s.carriedOver = un.length;
    for (const i of un) {
      db.history.push({ id: newId(), issueId: i.id, field: 'sprintId', from: s.id, to: target ? target.id : null, actorId: c.user.id, at: t });
      i.sprintId = target ? target.id : null; i.updatedAt = t;
    }
    s.state = 'completed'; s.completedAt = t;
    return [200, outSprint(s)];
  });
  const valueAt = (issue, field, at) => {
    let v = issue._init?.[field] ?? null;
    for (const h of db.history) if (h.issueId === issue.id && h.field === field && h.at <= at) v = h.to;
    return v;
  };
  R('GET', '/api/sprints/:id/report', (c) => {
    const { s, p } = getSprint(c);
    const rep = { sprint: outSprint(s), committedPoints: 0, completedPoints: 0, completedIssues: 0, carriedOver: 0, burndown: [] };
    if (s.state === 'planned') return [200, rep];
    const ms = db.issues.filter(i => i.sprintId === s.id);
    rep.committedPoints = s.committedPoints || 0;
    if (s.state === 'completed') { rep.completedPoints = s.completedPoints; rep.completedIssues = s.completedIssues; rep.carriedOver = s.carriedOver; }
    else { const d = ms.filter(i => i.resolvedAt); rep.completedPoints = d.reduce((a, i) => a + (i.storyPoints || 0), 0); rep.completedIssues = d.length; }
    const start = s.startDate.slice(0, 10); let end = today();
    if (s.endDate && s.endDate.slice(0, 10) < end) end = s.endDate.slice(0, 10);
    const cand = db.issues.filter(i => i.projectId === p.id);
    for (let d = new Date(start + 'T00:00:00Z'), n = 0; d.toISOString().slice(0, 10) <= end && n < 800; d = new Date(d.getTime() + 86400000), n++) {
      const ds = d.toISOString().slice(0, 10), eod = ds + 'T23:59:59.999Z';
      let rem = 0;
      for (const i of cand) {
        if (i.createdAt > eod || valueAt(i, 'sprintId', eod) !== s.id) continue;
        if (!isDone(p, valueAt(i, 'status', eod))) rem += i.storyPoints || 0;
      }
      rep.burndown.push({ date: ds, remainingPoints: rem });
    }
    return [200, rep];
  });
  R('GET', '/api/projects/:id/stats', (c) => {
    const p = getProject(c.user, c.params.id);
    const list = db.issues.filter(i => i.projectId === p.id);
    const byStatus = {}, byType = {}, byAssignee = {};
    for (const s of p.workflow.statuses) byStatus[s.name] = 0;
    for (const i of list) {
      byStatus[i.status] = (byStatus[i.status] || 0) + 1; byType[i.type] = (byType[i.type] || 0) + 1;
      const a = i.assigneeId ? userById(i.assigneeId)?.username : 'unassigned'; byAssignee[a] = (byAssignee[a] || 0) + 1;
    }
    const cycles = [];
    for (const i of list) {
      if (!i.resolvedAt) continue;
      let st = i._init?.startedAt || null;
      for (const h of db.history) if (h.issueId === i.id && h.field === 'status' && statusCat(p, h.to) === 'started') { st = h.at; break; }
      if (!st) continue;
      cycles.push((Date.parse(i.resolvedAt) - Date.parse(st)) / 3600000);
    }
    const avg = cycles.length ? cycles.reduce((a, b) => a + b, 0) / cycles.length : null;
    return [200, { total: list.length, byStatus, byType, byAssignee, avgCycleTimeHours: avg, averageCycleTimeHours: avg, cycleTimeHours: avg }];
  });

  // search
  R('GET', '/api/search', (c) => {
    const q = c.query.q || '';
    let pred;
    try { pred = compile(q, { meId: c.user.id, userByName, sprintOf: (i) => db.sprints.find(s => s.id === i.sprintId) || null }); }
    catch (e) { if (e instanceof QueryError) throw bad('malformed query: ' + e.message); throw e; }
    let pid = null;
    if (c.query.project) {
      const p = db.projects.find(x => x.id === c.query.project || x.key === c.query.project); if (!p || !projRole(c.user, p)) throw notFound('project not found'); pid = p.id;
    }
    let list = db.issues.filter(i => (!pid || i.projectId === pid) && projRole(c.user, projOf(i.projectId)) && pred(i));
    const sort = c.query.sort || 'updated';
    if (!['updated', 'created', 'priority'].includes(sort)) throw bad('invalid sort');
    const seq = new Map(db.issues.map((x, n) => [x.id, n]));
    const key = sort === 'created' ? (i) => i.createdAt : sort === 'updated' ? (i) => i.updatedAt : null;
    list.sort((a, b) => {
      if (sort === 'priority') { const d = PRIOS.indexOf(a.priority) - PRIOS.indexOf(b.priority); if (d) return d; }
      else { const ka = key(a), kb = key(b); if (ka !== kb) return ka < kb ? 1 : -1; }
      return seq.get(b.id) - seq.get(a.id);
    });
    return [200, list.map(i => outIssue(i, true))];
  });

  // csv
  R('GET', '/api/projects/:id/export.csv', (c) => {
    const p = getProject(c.user, c.params.id);
    const rows = [CSV_HEADER];
    for (const i of db.issues.filter(x => x.projectId === p.id)) {
      const ref = (id) => db.issues.find(x => x.id === id)?.key || '';
      rows.push([i.key, i.type, i.title, i.status, i.priority, userById(i.assigneeId)?.username || '', i.labels.join(';'), i.storyPoints ?? '', ref(i.parentId), ref(i.epicId),
        db.sprints.find(s => s.id === i.sprintId)?.name || '', i.dueDate || '', i.createdAt, i.resolvedAt || '']);
    }
    return [200, toCsv(rows), 'text/csv; charset=utf-8'];
  });
  R('POST', '/api/projects/:id/import.csv', (c) => {
    const p = getProject(c.user, c.params.id, 'developer');
    let recs;
    try { recs = parseCsv(c.raw); } catch (e) { throw bad('malformed CSV: ' + e.message); }
    if (!recs.length) throw bad('empty CSV');
    const header = recs[0].fields.map(h => h.trim());
    if (!header.includes('title')) throw bad('CSV header must include title');
    const result = { created: 0, errors: [] };
    for (const r of recs.slice(1)) {
      try {
        if (r.fields.length > header.length) throw new Error('too many fields');
        const row = {}; header.forEach((h, n) => { row[h] = (r.fields[n] ?? '').trim(); });
        const d = { title: row.title };
        if (!row.title) throw new Error('title is required');
        if (row.type) d.type = row.type;
        if (row.status) d.status = row.status;
        if (row.priority) d.priority = row.priority;
        if (row.assignee) { if (!userByName(row.assignee)) throw new Error('unknown assignee ' + row.assignee); d.assignee = row.assignee; }
        if (row.labels) d.labels = row.labels.split(';').map(x => x.trim()).filter(Boolean);
        if (row.storyPoints) { const n = Number(row.storyPoints); if (!Number.isFinite(n) || n < 0) throw new Error('invalid storyPoints'); d.storyPoints = n; }
        if (row.parent) d.parentId = row.parent;
        if (row.epic) d.epicId = row.epic;
        if (row.sprint) { const s = db.sprints.find(x => x.projectId === p.id && x.state !== 'completed' && (x.name === row.sprint || x.id === row.sprint)); if (!s) throw new Error('unknown sprint ' + row.sprint); d.sprintId = s.id; }
        if (row.dueDate) d.dueDate = row.dueDate;
        createIssue(p, c.user, d);
        result.created++;
      } catch (e) { result.errors.push({ line: r.line, message: e.message }); }
    }
    return [200, result];
  });

  // webhooks
  const outWh = (w) => ({ id: w.id, projectId: w.projectId, url: w.url, events: w.events, createdAt: w.createdAt });
  R('POST', '/api/projects/:id/webhooks', (c) => {
    const p = getProject(c.user, c.params.id, 'lead');
    let u; try { u = new URL(c.body.url); } catch { throw bad('invalid url'); }
    if (!/^https?:$/.test(u.protocol)) throw bad('url must be http(s)');
    if (!Array.isArray(c.body.events) || !c.body.events.length || c.body.events.some(e => !EVENTS.includes(e))) throw bad('invalid events');
    if (typeof c.body.secret !== 'string' || !c.body.secret) throw bad('secret is required');
    const w = { id: newId(), projectId: p.id, url: c.body.url, events: [...new Set(c.body.events)], secret: c.body.secret, createdAt: iso() };
    db.webhooks.push(w);
    audit(p.workspaceId, c.user, 'webhook.created', { webhookId: w.id, projectId: p.id, url: w.url });
    return [201, outWh(w)];
  });
  R('GET', '/api/projects/:id/webhooks', (c) => { const p = getProject(c.user, c.params.id, 'lead'); return [200, db.webhooks.filter(w => w.projectId === p.id).map(outWh)]; });
  const getWh = (c) => { const w = db.webhooks.find(x => x.id === c.params.id); if (!w) throw notFound('webhook not found'); return { w, p: getProject(c.user, w.projectId, 'lead') }; };
  R('DELETE', '/api/webhooks/:id', (c) => {
    const { w, p } = getWh(c); db.webhooks = db.webhooks.filter(x => x !== w);
    audit(p.workspaceId, c.user, 'webhook.deleted', { webhookId: w.id, projectId: p.id }); return [204];
  });
  R('GET', '/api/webhooks/:id/deliveries', (c) => { const { w } = getWh(c); return [200, db.deliveries.filter(d => d.webhookId === w.id)]; });

  // ---------- http plumbing ----------
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
  function serveStatic(res, file) {
    const full = path.join(STATIC_DIR, file);
    if (!full.startsWith(STATIC_DIR + path.sep) || !fs.existsSync(full) || !fs.statSync(full).isFile()) return false;
    res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(fs.readFileSync(full)); return true;
  }
  const sendJson = (res, status, obj, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
    res.end(JSON.stringify(obj));
  };
  async function readBody(req) {
    const chunks = []; let size = 0;
    for await (const ch of req) { size += ch.length; if (size > 10e6) throw new HttpError(413, 'too_large', 'body too large'); chunks.push(ch); }
    return Buffer.concat(chunks).toString('utf8');
  }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const pathname = url.pathname;
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) { serveStatic(res, 'index.html'); return; }
      if (req.method === 'GET' && pathname.startsWith('/static/')) { if (serveStatic(res, decodeURIComponent(pathname.slice(8)))) return; return sendJson(res, 404, { error: 'not_found', message: 'not found' }); }
      if (!pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not_found', message: 'not found' });
      let match = null, pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(pathname); if (!m) continue;
        pathMatched = true;
        if (r.method !== req.method) continue;
        match = { r, params: Object.fromEntries(r.keys.map((k, n) => [k, decodeURIComponent(m[n + 1])])) }; break;
      }
      if (!match) return sendJson(res, pathMatched ? 405 : 404, { error: pathMatched ? 'method_not_allowed' : 'not_found', message: pathMatched ? 'method not allowed' : 'not found' });
      const ctx = { req, params: match.params, query: Object.fromEntries(url.searchParams), headers: {}, body: {}, raw: '', user: null };
      if (match.r.auth) {
        const h = req.headers.authorization || '';
        const m = /^Bearer\s+(\S+)$/i.exec(h);
        if (!m) throw new HttpError(401, 'unauthorized', 'missing or invalid bearer token');
        const hh = sha(m[1]);
        const s = db.sessions.find(x => x.hash === hh) || db.tokens.find(x => x.hash === hh);
        const u = s && userById(s.userId);
        if (!u) throw new HttpError(401, 'unauthorized', 'invalid token');
        ctx.user = u; ctx.tokenStr = m[1];
      }
      ctx.raw = await readBody(req);
      if (!(req.method === 'GET' || req.method === 'DELETE') && ctx.raw.trim() && !pathname.endsWith('/import.csv')) {
        try { ctx.body = JSON.parse(ctx.raw); } catch { throw new HttpError(400, 'invalid_json', 'malformed JSON body'); }
        if (ctx.body === null || typeof ctx.body !== 'object' || Array.isArray(ctx.body)) throw bad('body must be a JSON object');
      }
      const [status, payload, ctype] = match.r.handler(ctx);
      if (req.method !== 'GET') save();
      if (status === 204) { res.writeHead(204, ctx.headers); res.end(); return; }
      if (ctype) { res.writeHead(status, { 'content-type': ctype }); res.end(payload); return; }
      sendJson(res, status, payload, ctx.headers);
    } catch (e) {
      if (e instanceof HttpError) sendJson(res, e.status, { error: e.code, message: e.message }, e.code === 'rate_limited' ? { 'retry-after': '60' } : {});
      else { console.error(e); sendJson(res, 500, { error: 'internal_error', message: 'internal error' }); }
    }
  });
  return server;
}
