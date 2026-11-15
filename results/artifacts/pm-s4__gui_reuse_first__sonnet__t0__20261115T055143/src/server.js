import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseCsv, toCsv } from './csv.js';
import { parseQuery, matchTerm } from './search.js';

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');
const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIOS = ['urgent', 'high', 'medium', 'low', 'none'];
const CATS = ['backlog', 'unstarted', 'started', 'completed'];
const WS_ROLES = ['admin', 'member', 'guest'];
const P_ROLES = ['lead', 'developer', 'viewer'];
const RANK = { viewer: 1, developer: 2, lead: 3 };
const EVENTS = ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}
const bad = (m) => new HttpError(400, 'validation_error', m);
const notFound = (m = 'not found') => new HttpError(404, 'not_found', m);
const forbidden = (m = 'forbidden') => new HttpError(403, 'forbidden', m);
const conflict = (code, m) => new HttpError(409, code, m || code);

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s) => typeof s === 'string' && DATE_RE.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pw, salt, 32).toString('hex') };
}

export function createServer({ dataFile, clock } = {}) {
  const now = () => (clock ? clock() : new Date());
  const iso = () => now().toISOString();
  let db = { seq: 0, users: {}, sessions: {}, tokens: {}, workspaces: {}, projects: {}, issues: {}, comments: {}, links: {}, notifications: {}, sprints: {}, webhooks: {}, deliveries: {}, audit: [] };
  if (dataFile && fs.existsSync(dataFile)) {
    try { db = { ...db, ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) }; } catch { /* ignore */ }
  }
  const failures = new Map();
  const id = () => String(++db.seq);
  const save = () => {
    if (!dataFile) return;
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, dataFile);
  };

  // ---------- helpers ----------
  const publicUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName });
  const userByName = (n) => Object.values(db.users).find((u) => u.username.toLowerCase() === String(n).toLowerCase());
  const userByRef = (r) => db.users[r] || userByName(r);
  const getWs = (wid) => { const w = db.workspaces[wid]; if (!w) throw notFound('workspace not found'); return w; };
  const wsRole = (u, w) => w.members[u.id] || null;
  const needWs = (u, w, roles) => {
    const r = wsRole(u, w);
    if (!r || (roles && !roles.includes(r))) throw forbidden();
    return r;
  };
  const projRole = (u, p) => {
    const w = db.workspaces[p.workspaceId];
    const r = w && w.members[u.id];
    if (!r) return null;
    if (r === 'admin') return 'lead';
    if (p.members[u.id]) return p.members[u.id];
    return r === 'member' ? 'developer' : null;
  };
  const getProject = (pid, u, min) => {
    const p = db.projects[pid];
    if (!p) throw notFound('project not found');
    const r = projRole(u, p);
    if (!r || (min && RANK[r] < RANK[min])) throw forbidden();
    return p;
  };
  const getIssue = (key, u, min) => {
    const cands = Object.values(db.issues).filter((i) => i.key === key || i.id === key);
    if (!cands.length) throw notFound('issue not found');
    for (const i of cands) {
      const p = db.projects[i.projectId];
      const r = projRole(u, p);
      if (r && (!min || RANK[r] >= RANK[min])) return i;
    }
    throw forbidden();
  };
  const issuesOf = (pid) => Object.values(db.issues).filter((i) => i.projectId === pid);
  const catOf = (p, name) => (p.workflow.statuses.find((s) => s.name === name) || {}).category;
  const isDone = (p, i) => catOf(p, i.status) === 'completed';
  const audit = (wid, action, actorId, details) => { db.audit.push({ id: id(), workspaceId: wid, action, type: action, actorId, at: iso(), details }); };

  function issueView(i, full) {
    const o = { ...i, watchers: [...i.watchers], labels: [...i.labels] };
    if (full) {
      const p = db.projects[i.projectId];
      const kids = issuesOf(i.projectId).filter((c) => c.parentId === i.id);
      o.children = kids.map((c) => c.key);
      o.links = linksOf(i);
      if (i.type === 'epic') {
        const m = issuesOf(i.projectId).filter((c) => c.epicId === i.id);
        o.progress = { total: m.length, done: m.filter((c) => isDone(p, c)).length, points_total: m.reduce((a, c) => a + (c.storyPoints || 0), 0), points_done: m.filter((c) => isDone(p, c)).reduce((a, c) => a + (c.storyPoints || 0), 0) };
      }
    }
    return o;
  }
  const INV = { blocks: 'blocked_by', relates: 'relates', duplicates: 'duplicated_by' };
  function linksOf(i) {
    const out = [];
    for (const l of Object.values(db.links)) {
      if (l.sourceId === i.id && db.issues[l.targetId]) out.push({ id: l.id, type: l.type, key: db.issues[l.targetId].key, target: db.issues[l.targetId].key });
      else if (l.targetId === i.id && db.issues[l.sourceId]) out.push({ id: l.id, type: INV[l.type], key: db.issues[l.sourceId].key, target: db.issues[l.sourceId].key });
    }
    return out;
  }
  const canSee = (uid, p) => { const u = db.users[uid]; return !!u && !!projRole(u, p); };

  function notify(uids, type, issue, actorId, skip = new Set()) {
    for (const uid of new Set(uids)) {
      if (uid === actorId || skip.has(uid) || !db.users[uid]) continue;
      const nid = id();
      db.notifications[nid] = { id: nid, userId: uid, type, issueKey: issue.key, actorId, at: iso(), read: false };
    }
  }

  // ---------- webhooks ----------
  function fire(event, issue, actorId, extra) {
    for (const wh of Object.values(db.webhooks)) {
      if (wh.projectId !== issue.projectId || !wh.events.includes(event)) continue;
      const did = id();
      const d = { id: did, webhookId: wh.id, event, status: null, attempts: 0, lastError: null, at: iso() };
      db.deliveries[did] = d;
      const body = JSON.stringify({ event, issue: issueView(issue), actorId, at: iso(), ...extra });
      const sig = 'sha256=' + crypto.createHmac('sha256', wh.secret).update(body).digest('hex');
      (async () => {
        for (let a = 1; a <= 3; a++) {
          d.attempts = a;
          try {
            const r = await fetch(wh.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pm-signature': sig }, body, signal: AbortSignal.timeout(5000) });
            d.status = r.status;
            if (r.status >= 200 && r.status < 300) { d.lastError = null; break; }
            d.lastError = 'HTTP ' + r.status;
          } catch (e) { d.lastError = String((e && e.message) || e); }
          if (a < 3) await new Promise((r) => setTimeout(r, 20));
        }
        save();
      })();
    }
  }

  // ---------- issue validation / mutation ----------
  function resolveRef(p, ref, what) {
    if (ref == null) return null;
    const t = Object.values(db.issues).find((i) => i.projectId === p.id && (i.id === String(ref) || i.key === ref));
    if (!t) throw bad(`${what} not found in project`);
    return t;
  }
  function checkFields(p, b, cur, u) {
    const out = {};
    const has = (k) => Object.prototype.hasOwnProperty.call(b, k);
    if (has('title')) { if (!isStr(b.title) || b.title.length > 500) throw bad('title required'); out.title = b.title.trim(); }
    if (has('description')) { if (b.description != null && typeof b.description !== 'string') throw bad('description must be string'); out.description = b.description ?? ''; }
    if (has('type')) { if (!TYPES.includes(b.type)) throw bad('invalid type'); out.type = b.type; }
    if (has('priority')) { if (!PRIOS.includes(b.priority)) throw bad('invalid priority'); out.priority = b.priority; }
    if (has('labels')) { if (!Array.isArray(b.labels) || b.labels.some((l) => !isStr(l))) throw bad('labels must be array of strings'); out.labels = [...new Set(b.labels.map((l) => l.trim()))]; }
    if (has('storyPoints')) { if (b.storyPoints !== null && (typeof b.storyPoints !== 'number' || !isFinite(b.storyPoints) || b.storyPoints < 0)) throw bad('invalid storyPoints'); out.storyPoints = b.storyPoints; }
    if (has('dueDate')) { if (b.dueDate !== null && !(typeof b.dueDate === 'string' && (validDate(b.dueDate) || (DATE_RE.test(b.dueDate.slice(0, 10)) && !isNaN(Date.parse(b.dueDate)))))) throw bad('invalid dueDate'); out.dueDate = b.dueDate; }
    if (has('assigneeId')) {
      if (b.assigneeId !== null) {
        const au = db.users[b.assigneeId] || userByName(b.assigneeId);
        if (!au || !canSee(au.id, p)) throw bad('invalid assignee');
        out.assigneeId = au.id;
      } else out.assigneeId = null;
    }
    if (has('sprintId')) {
      if (b.sprintId !== null) {
        const s = db.sprints[b.sprintId];
        if (!s || s.projectId !== p.id) throw bad('invalid sprint');
        if (s.state === 'completed') throw bad('sprint is completed');
      }
      out.sprintId = b.sprintId;
    }
    if (has('status')) { if (!catOf(p, b.status)) throw bad('unknown status'); out.status = b.status; }
    const type = out.type || (cur && cur.type);
    if (has('parentId') || has('type') || !cur) {
      const pr = has('parentId') ? b.parentId : cur && cur.parentId;
      if (type === 'subtask') {
        const par = resolveRef(p, pr, 'parent');
        if (!par) throw bad('subtask requires parentId');
        if (par.type === 'subtask') throw bad('parent cannot be a subtask');
        if (cur && par.id === cur.id) throw bad('invalid parent');
        out.parentId = par.id;
      } else if (pr != null) {
        if (type === 'epic') throw bad('epics cannot have parents');
        out.parentId = resolveRef(p, pr, 'parent').id;
      } else if (has('parentId') || (cur && cur.parentId)) out.parentId = null;
    }
    if (has('epicId')) {
      if (b.epicId !== null) {
        const e = resolveRef(p, b.epicId, 'epic');
        if (e.type !== 'epic') throw bad('epicId must reference an epic');
        out.epicId = e.id;
      } else out.epicId = null;
    }
    return out;
  }

  function createIssue(p, b, u) {
    if (!b || typeof b !== 'object') throw bad('body required');
    if (!isStr(b.title)) throw bad('title required');
    const body = { type: 'task', priority: 'none', ...b };
    if (body.type == null) body.type = 'task';
    const f = checkFields(p, body, null, u);
    const t = iso();
    const init = (p.workflow.statuses.find((s) => s.category === 'unstarted') || p.workflow.statuses[0]).name;
    const num = ++p.nextNum;
    const i = {
      id: id(), key: `${p.key}-${num}`, projectId: p.id, type: 'task', title: '', description: '', status: init, priority: 'none',
      assigneeId: null, reporterId: u.id, labels: [], storyPoints: null, parentId: null, epicId: null, sprintId: null, dueDate: null,
      watchers: [], createdAt: t, updatedAt: t, resolvedAt: null, ...f,
    };
    if (!f.status) i.status = init;
    if (isDone(p, i)) i.resolvedAt = t;
    i.watchers = [...new Set([i.reporterId, i.assigneeId].filter(Boolean))];
    db.issues[i.id] = i;
    fire('issue.created', i, u.id);
    return i;
  }

  function addHistory(i, field, from, to, actorId, at, extra) {
    if (!i.history) i.history = [];
    i.history.push({ field, from, to, actorId, at, ...extra });
  }

  function updateIssue(i, b, u) {
    const p = db.projects[i.projectId];
    const f = checkFields(p, b, i, u);
    const t = iso();
    if (f.status !== undefined && f.status !== i.status) {
      if (!p.workflow.transitions.some(([a, c]) => a === i.status && c === f.status)) throw conflict('invalid_transition', `cannot move from ${i.status} to ${f.status}`);
      if (catOf(p, f.status) === 'completed') {
        const blocked = Object.values(db.links).some((l) => l.type === 'blocks' && l.targetId === i.id && db.issues[l.sourceId] && !isDone(db.projects[db.issues[l.sourceId].projectId], db.issues[l.sourceId]));
        if (blocked) throw conflict('blocked', 'issue is blocked by an unresolved issue');
      }
    }
    const changed = [];
    for (const [k, v] of Object.entries(f)) {
      const from = i[k];
      if (JSON.stringify(from) === JSON.stringify(v)) continue;
      addHistory(i, k, from ?? null, v ?? null, u.id, t);
      i[k] = v;
      changed.push(k);
    }
    if (!changed.length) return { changed };
    if (changed.includes('status')) {
      const d = isDone(p, i);
      if (d && !i.resolvedAt) i.resolvedAt = t; else if (!d) i.resolvedAt = null;
    }
    if (changed.includes('assigneeId') && i.assigneeId && !i.watchers.includes(i.assigneeId)) i.watchers.push(i.assigneeId);
    i.updatedAt = t;
    if (changed.includes('status')) notify(i.watchers, 'status_changed', i, u.id);
    if (changed.includes('assigneeId')) notify(i.watchers, 'assigned', i, u.id);
    fire('issue.updated', i, u.id);
    return { changed };
  }

  function deleteIssue(i, u) {
    const kids = issuesOf(i.projectId).filter((c) => c.parentId === i.id);
    for (const k of kids) deleteIssue(k, u);
    for (const l of Object.values(db.links)) if (l.sourceId === i.id || l.targetId === i.id) delete db.links[l.id];
    for (const c of Object.values(db.comments)) if (c.issueId === i.id) delete db.comments[c.id];
    for (const o of issuesOf(i.projectId)) if (o.epicId === i.id) o.epicId = null;
    delete db.issues[i.id];
    fire('issue.deleted', i, u.id);
  }

  // ---------- routes ----------
  const routes = [];
  const R = (method, pattern, fn, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, fn, auth: opts.auth !== false, raw: opts.raw });
  };
  const ok = (body, status = 200) => ({ status, body });

  // auth
  R('POST', '/api/auth/register', ({ body }) => {
    const { username, password, displayName } = body || {};
    if (!isStr(username) || !/^[A-Za-z0-9_.-]{2,32}$/.test(username)) throw bad('invalid username');
    if (typeof password !== 'string' || password.length < 8) throw bad('password must be at least 8 characters');
    if (displayName != null && typeof displayName !== 'string') throw bad('invalid displayName');
    if (userByName(username)) throw conflict('conflict', 'username taken');
    const u = { id: id(), username, displayName: displayName || username, ...(() => { const h = hashPw(password); return { salt: h.salt, passwordHash: h.hash }; })(), createdAt: iso() };
    db.users[u.id] = u;
    return ok({ user: publicUser(u) }, 201);
  }, { auth: false });
  R('POST', '/api/auth/login', ({ body }) => {
    const { username, password } = body || {};
    if (!isStr(username) || typeof password !== 'string') throw bad('username and password required');
    const key = username.toLowerCase();
    const t = now().getTime();
    const fails = (failures.get(key) || []).filter((x) => t - x < 15 * 60 * 1000);
    failures.set(key, fails);
    if (fails.length >= 5) throw new HttpError(429, 'rate_limited', 'too many failed attempts');
    const u = userByName(username);
    let good = false;
    if (u) good = crypto.timingSafeEqual(Buffer.from(hashPw(password, u.salt).hash), Buffer.from(u.passwordHash));
    if (!good) { fails.push(t); throw new HttpError(401, 'unauthorized', 'invalid credentials'); }
    failures.delete(key);
    const token = crypto.randomBytes(32).toString('hex');
    db.sessions[sha(token)] = u.id;
    return ok({ token, user: publicUser(u) });
  }, { auth: false });
  R('POST', '/api/auth/logout', ({ token }) => { delete db.sessions[sha(token)]; return { status: 204 }; });
  R('GET', '/api/auth/me', ({ user }) => ok({ user: publicUser(user) }));
  R('PATCH', '/api/auth/me', ({ user, body }) => {
    const b = body || {};
    if (b.displayName !== undefined && !isStr(b.displayName)) throw bad('invalid displayName');
    if (b.password !== undefined) {
      if (typeof b.password !== 'string' || b.password.length < 8) throw bad('password must be at least 8 characters');
      if (typeof b.currentPassword !== 'string') throw bad('currentPassword required');
      if (hashPw(b.currentPassword, user.salt).hash !== user.passwordHash) throw forbidden('current password incorrect');
      const h = hashPw(b.password);
      user.salt = h.salt; user.passwordHash = h.hash;
    }
    if (b.displayName !== undefined) user.displayName = b.displayName.trim();
    return ok({ user: publicUser(user) });
  });

  // tokens
  R('POST', '/api/tokens', ({ user, body }) => {
    if (!isStr(body && body.name)) throw bad('name required');
    const token = 'pm_' + crypto.randomBytes(24).toString('hex');
    const t = { id: id(), userId: user.id, name: body.name, hash: sha(token), createdAt: iso() };
    db.tokens[t.id] = t;
    for (const w of Object.values(db.workspaces)) if (w.members[user.id]) audit(w.id, 'token.created', user.id, { tokenId: t.id, name: t.name });
    return ok({ id: t.id, name: t.name, token }, 201);
  });
  R('GET', '/api/tokens', ({ user }) => ok(Object.values(db.tokens).filter((t) => t.userId === user.id).map((t) => ({ id: t.id, name: t.name, createdAt: t.createdAt }))));
  R('DELETE', '/api/tokens/:id', ({ user, params }) => {
    const t = db.tokens[params.id];
    if (!t || t.userId !== user.id) throw notFound();
    delete db.tokens[t.id];
    for (const w of Object.values(db.workspaces)) if (w.members[user.id]) audit(w.id, 'token.deleted', user.id, { tokenId: t.id, name: t.name });
    return { status: 204 };
  });

  // workspaces
  const wsView = (w, u) => ({ id: w.id, name: w.name, key: w.key, createdAt: w.createdAt, role: w.members[u.id] || null });
  R('POST', '/api/workspaces', ({ user, body }) => {
    const { name, key } = body || {};
    if (!isStr(name)) throw bad('name required');
    if (typeof key !== 'string' || !/^[A-Z]{2,10}$/.test(key)) throw bad('key must be 2-10 uppercase letters');
    if (Object.values(db.workspaces).some((w) => w.key === key)) throw conflict('conflict', 'workspace key taken');
    const w = { id: id(), name: name.trim(), key, createdAt: iso(), members: { [user.id]: 'admin' } };
    db.workspaces[w.id] = w;
    audit(w.id, 'workspace.created', user.id, { name: w.name });
    return ok(wsView(w, user), 201);
  });
  R('GET', '/api/workspaces', ({ user }) => ok(Object.values(db.workspaces).filter((w) => w.members[user.id]).map((w) => wsView(w, user))));
  R('GET', '/api/workspaces/:id', ({ user, params }) => { const w = getWs(params.id); needWs(user, w); return ok(wsView(w, user)); });
  const memView = (w, uid) => { const u = db.users[uid]; return { userId: uid, username: u.username, displayName: u.displayName, role: w.members[uid] }; };
  R('GET', '/api/workspaces/:id/members', ({ user, params }) => { const w = getWs(params.id); needWs(user, w); return ok(Object.keys(w.members).map((x) => memView(w, x))); });
  R('POST', '/api/workspaces/:id/members', ({ user, params, body }) => {
    const w = getWs(params.id); needWs(user, w, ['admin']);
    const { username, role } = body || {};
    if (!isStr(username)) throw bad('username required');
    if (!WS_ROLES.includes(role)) throw bad('invalid role');
    const t = userByName(username);
    if (!t) throw notFound('user not found');
    if (w.members[t.id]) throw conflict('conflict', 'already a member');
    w.members[t.id] = role;
    audit(w.id, 'member.added', user.id, { userId: t.id, username: t.username, role });
    return ok(memView(w, t.id), 201);
  });
  const adminCount = (w) => Object.values(w.members).filter((r) => r === 'admin').length;
  R('PATCH', '/api/workspaces/:id/members/:uid', ({ user, params, body }) => {
    const w = getWs(params.id); needWs(user, w, ['admin']);
    const t = userByRef(params.uid);
    if (!t || !w.members[t.id]) throw notFound('member not found');
    if (!WS_ROLES.includes(body && body.role)) throw bad('invalid role');
    if (w.members[t.id] === 'admin' && body.role !== 'admin' && adminCount(w) <= 1) throw bad('cannot demote the last admin');
    const from = w.members[t.id];
    w.members[t.id] = body.role;
    audit(w.id, 'member.role_changed', user.id, { userId: t.id, username: t.username, from, to: body.role });
    return ok(memView(w, t.id));
  });
  R('DELETE', '/api/workspaces/:id/members/:uid', ({ user, params }) => {
    const w = getWs(params.id); needWs(user, w, ['admin']);
    const t = userByRef(params.uid);
    if (!t || !w.members[t.id]) throw notFound('member not found');
    if (w.members[t.id] === 'admin' && adminCount(w) <= 1) throw bad('cannot remove the last admin');
    delete w.members[t.id];
    for (const p of Object.values(db.projects)) if (p.workspaceId === w.id) delete p.members[t.id];
    audit(w.id, 'member.removed', user.id, { userId: t.id, username: t.username });
    return { status: 204 };
  });
  R('GET', '/api/workspaces/:id/audit', ({ user, params }) => {
    const w = getWs(params.id); needWs(user, w, ['admin']);
    return ok(db.audit.filter((a) => a.workspaceId === w.id).slice().reverse());
  });

  // projects
  const projView = (p, u) => ({ id: p.id, workspaceId: p.workspaceId, name: p.name, key: p.key, workflow: p.workflow, role: projRole(u, p), createdAt: p.createdAt });
  R('POST', '/api/workspaces/:id/projects', ({ user, params, body }) => {
    const w = getWs(params.id);
    const r = needWs(user, w);
    if (r === 'guest') throw forbidden('guests cannot create projects');
    const { name, key } = body || {};
    if (!isStr(name)) throw bad('name required');
    if (typeof key !== 'string' || !/^[A-Z]{2,10}$/.test(key)) throw bad('key must be 2-10 uppercase letters');
    if (Object.values(db.projects).some((p) => p.workspaceId === w.id && p.key === key)) throw conflict('conflict', 'project key taken');
    const statuses = [['Backlog', 'backlog'], ['Todo', 'unstarted'], ['In Progress', 'started'], ['In Review', 'started'], ['Done', 'completed']].map(([name, category]) => ({ name, category }));
    const transitions = [];
    for (const a of statuses) for (const b of statuses) if (a !== b) transitions.push([a.name, b.name]);
    const p = { id: id(), workspaceId: w.id, name: name.trim(), key, createdAt: iso(), members: { [user.id]: 'lead' }, workflow: { statuses, transitions }, nextNum: 0 };
    db.projects[p.id] = p;
    return ok(projView(p, user), 201);
  });
  R('GET', '/api/workspaces/:id/projects', ({ user, params }) => {
    const w = getWs(params.id); needWs(user, w);
    return ok(Object.values(db.projects).filter((p) => p.workspaceId === w.id && projRole(user, p)).map((p) => projView(p, user)));
  });
  R('GET', '/api/projects/:id', ({ user, params }) => ok(projView(getProject(params.id, user), user)));
  const pmView = (p, uid) => { const u = db.users[uid]; return { userId: uid, username: u.username, displayName: u.displayName, role: projRole(u, p) }; };
  R('GET', '/api/projects/:id/members', ({ user, params }) => {
    const p = getProject(params.id, user);
    const w = db.workspaces[p.workspaceId];
    return ok(Object.keys(w.members).filter((uid) => projRole(db.users[uid], p)).map((uid) => pmView(p, uid)));
  });
  R('POST', '/api/projects/:id/members', ({ user, params, body }) => {
    const p = getProject(params.id, user, 'lead');
    const { username, role } = body || {};
    if (!isStr(username)) throw bad('username required');
    if (!P_ROLES.includes(role)) throw bad('invalid role');
    const t = userByName(username);
    if (!t) throw notFound('user not found');
    const w = db.workspaces[p.workspaceId];
    if (!w.members[t.id]) throw bad('user is not a workspace member');
    p.members[t.id] = role;
    audit(w.id, 'project_member.added', user.id, { projectId: p.id, userId: t.id, role });
    return ok(pmView(p, t.id), 201);
  });
  R('PATCH', '/api/projects/:id/members/:uid', ({ user, params, body }) => {
    const p = getProject(params.id, user, 'lead');
    const t = userByRef(params.uid);
    if (!t || !p.members[t.id]) throw notFound('member not found');
    if (!P_ROLES.includes(body && body.role)) throw bad('invalid role');
    p.members[t.id] = body.role;
    audit(p.workspaceId, 'project_member.role_changed', user.id, { projectId: p.id, userId: t.id, role: body.role });
    return ok(pmView(p, t.id));
  });
  R('DELETE', '/api/projects/:id/members/:uid', ({ user, params }) => {
    const p = getProject(params.id, user, 'lead');
    const t = userByRef(params.uid);
    if (!t || !p.members[t.id]) throw notFound('member not found');
    delete p.members[t.id];
    audit(p.workspaceId, 'project_member.removed', user.id, { projectId: p.id, userId: t.id });
    return { status: 204 };
  });
  R('PUT', '/api/projects/:id/workflow', ({ user, params, body }) => {
    const p = getProject(params.id, user, 'lead');
    const { statuses, transitions, remap } = body || {};
    if (!Array.isArray(statuses) || !statuses.length) throw bad('statuses required');
    const names = new Set();
    for (const s of statuses) {
      if (!s || !isStr(s.name) || !CATS.includes(s.category)) throw bad('invalid status');
      if (names.has(s.name)) throw bad('duplicate status');
      names.add(s.name);
    }
    let tr = transitions;
    if (tr === undefined) { tr = []; for (const a of names) for (const b of names) if (a !== b) tr.push([a, b]); }
    if (!Array.isArray(tr) || tr.some((t) => !Array.isArray(t) || t.length !== 2 || !names.has(t[0]) || !names.has(t[1]))) throw bad('invalid transitions');
    const rm = remap && typeof remap === 'object' ? remap : {};
    const affected = issuesOf(p.id).filter((i) => !names.has(i.status));
    for (const i of affected) {
      const to = rm[i.status];
      if (!to || !names.has(to)) throw bad(`status "${i.status}" is in use; provide remap`);
    }
    const t = iso();
    p.workflow = { statuses: statuses.map((s) => ({ name: s.name, category: s.category })), transitions: tr.map((x) => [x[0], x[1]]) };
    for (const i of affected) {
      const to = rm[i.status];
      addHistory(i, 'status', i.status, to, user.id, t);
      i.status = to;
      const d = isDone(p, i);
      if (d && !i.resolvedAt) i.resolvedAt = t; else if (!d) i.resolvedAt = null;
      i.updatedAt = t;
    }
    audit(p.workspaceId, 'workflow.updated', user.id, { projectId: p.id, statuses: p.workflow.statuses.map((s) => s.name) });
    return ok(projView(p, user));
  });

  // issues
  R('POST', '/api/projects/:id/issues', ({ user, params, body }) => {
    const p = getProject(params.id, user, 'developer');
    return ok(issueView(createIssue(p, body, user), true), 201);
  });
  R('GET', '/api/projects/:id/issues', ({ user, params }) => {
    const p = getProject(params.id, user);
    return ok(issuesOf(p.id).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || +a.id - +b.id).map((i) => issueView(i)));
  });
  R('GET', '/api/issues/:key', ({ user, params }) => ok(issueView(getIssue(params.key, user), true)));
  R('PATCH', '/api/issues/:key', ({ user, params, body }) => {
    const i = getIssue(params.key, user, 'developer');
    if (!body || typeof body !== 'object') throw bad('body required');
    updateIssue(i, body, user);
    return ok(issueView(i, true));
  });
  R('DELETE', '/api/issues/:key', ({ user, params }) => { deleteIssue(getIssue(params.key, user, 'developer'), user); return { status: 204 }; });
  R('GET', '/api/issues/:key/history', ({ user, params }) => {
    const i = getIssue(params.key, user);
    return ok((i.history || []).map(({ field, from, to, actorId, at }) => ({ field, from, to, actorId, at })));
  });
  R('POST', '/api/issues/:key/links', ({ user, params, body }) => {
    const i = getIssue(params.key, user, 'developer');
    const { type, target } = body || {};
    if (!INV[type]) throw bad('invalid link type');
    if (!isStr(target)) throw bad('target required');
    const t = getIssue(target, user);
    if (t.id === i.id) throw bad('cannot link issue to itself');
    if (Object.values(db.links).some((l) => (l.sourceId === i.id && l.targetId === t.id && l.type === type) || (type === 'relates' && l.type === 'relates' && l.sourceId === t.id && l.targetId === i.id))) throw conflict('conflict', 'link exists');
    const l = { id: id(), type, sourceId: i.id, targetId: t.id };
    db.links[l.id] = l;
    return ok({ id: l.id, type, source: i.key, target: t.key, links: linksOf(i) }, 201);
  });
  R('DELETE', '/api/issues/:key/links/:lid', ({ user, params }) => {
    const i = getIssue(params.key, user, 'developer');
    const l = db.links[params.lid];
    if (!l || (l.sourceId !== i.id && l.targetId !== i.id)) throw notFound('link not found');
    delete db.links[l.id];
    return { status: 204 };
  });

  // comments & watchers
  R('GET', '/api/issues/:key/comments', ({ user, params }) => {
    const i = getIssue(params.key, user);
    return ok(Object.values(db.comments).filter((c) => c.issueId === i.id).sort((a, b) => +a.id - +b.id));
  });
  R('POST', '/api/issues/:key/comments', ({ user, params, body }) => {
    const i = getIssue(params.key, user, 'developer');
    if (!isStr(body && body.body)) throw bad('body required');
    const t = iso();
    const c = { id: id(), issueId: i.id, authorId: user.id, body: body.body, createdAt: t, updatedAt: t, edited: false };
    db.comments[c.id] = c;
    const p = db.projects[i.projectId];
    const mentioned = new Set();
    for (const m of body.body.matchAll(/@([A-Za-z0-9_.-]+)/g)) {
      const mu = userByName(m[1].replace(/[.-]+$/, '')) || userByName(m[1]);
      if (mu && canSee(mu.id, p)) mentioned.add(mu.id);
    }
    notify([...mentioned], 'mention', i, user.id);
    notify(i.watchers, 'comment', i, user.id, mentioned);
    fire('comment.created', i, user.id, { comment: c });
    return ok(c, 201);
  });
  const getComment = (cid, user) => {
    const c = db.comments[cid];
    if (!c) throw notFound('comment not found');
    const i = db.issues[c.issueId];
    if (!i || !projRole(user, db.projects[i.projectId])) throw forbidden();
    return c;
  };
  R('PATCH', '/api/comments/:id', ({ user, params, body }) => {
    const c = getComment(params.id, user);
    if (c.authorId !== user.id) throw forbidden('only the author can edit');
    if (!isStr(body && body.body)) throw bad('body required');
    c.body = body.body; c.edited = true; c.updatedAt = iso();
    return ok(c);
  });
  R('DELETE', '/api/comments/:id', ({ user, params }) => {
    const c = getComment(params.id, user);
    const i = db.issues[c.issueId];
    if (c.authorId !== user.id && projRole(user, db.projects[i.projectId]) !== 'lead') throw forbidden();
    delete db.comments[c.id];
    return { status: 204 };
  });
  R('POST', '/api/issues/:key/watch', ({ user, params }) => {
    const i = getIssue(params.key, user);
    if (!i.watchers.includes(user.id)) i.watchers.push(user.id);
    return ok(issueView(i));
  });
  R('DELETE', '/api/issues/:key/watch', ({ user, params }) => {
    const i = getIssue(params.key, user);
    i.watchers = i.watchers.filter((w) => w !== user.id);
    return ok(issueView(i));
  });

  // notifications
  R('GET', '/api/notifications', ({ user, query }) => {
    let l = Object.values(db.notifications).filter((n) => n.userId === user.id);
    if (query.get('unread') === 'true') l = l.filter((n) => !n.read);
    return ok(l.sort((a, b) => b.at.localeCompare(a.at) || +b.id - +a.id).map(({ id, type, issueKey, actorId, at, read }) => ({ id, type, issueKey, actorId, at, read })));
  });
  R('POST', '/api/notifications/read', ({ user, body }) => {
    const b = body || {};
    let n = 0;
    if (b.all === true) { for (const x of Object.values(db.notifications)) if (x.userId === user.id && !x.read) { x.read = true; n++; } }
    else if (Array.isArray(b.ids)) { for (const x of b.ids) { const o = db.notifications[x]; if (o && o.userId === user.id && !o.read) { o.read = true; n++; } } }
    else throw bad('ids or all required');
    return ok({ updated: n });
  });

  // sprints
  const getSprint = (sid, user, min) => {
    const s = db.sprints[sid];
    if (!s) throw notFound('sprint not found');
    getProject(s.projectId, user, min);
    return s;
  };
  R('POST', '/api/projects/:id/sprints', ({ user, params, body }) => {
    const p = getProject(params.id, user, 'developer');
    const { name, startDate, endDate } = body || {};
    if (!isStr(name)) throw bad('name required');
    for (const d of [startDate, endDate]) if (d != null && !validDate(d)) throw bad('dates must be YYYY-MM-DD');
    if (startDate && endDate && endDate < startDate) throw bad('endDate before startDate');
    const s = { id: id(), projectId: p.id, name: name.trim(), startDate: startDate || null, endDate: endDate || null, state: 'planned', createdAt: iso(), completedAt: null };
    db.sprints[s.id] = s;
    return ok(s, 201);
  });
  R('GET', '/api/projects/:id/sprints', ({ user, params }) => { const p = getProject(params.id, user); return ok(Object.values(db.sprints).filter((s) => s.projectId === p.id)); });
  R('GET', '/api/sprints/:id', ({ user, params }) => ok(getSprint(params.id, user)));
  const sprintIssues = (s) => issuesOf(s.projectId).filter((i) => i.sprintId === s.id);
  const pts = (l) => l.reduce((a, i) => a + (i.storyPoints || 0), 0);
  R('POST', '/api/sprints/:id/start', ({ user, params }) => {
    const s = getSprint(params.id, user, 'developer');
    if (s.state !== 'planned') throw conflict('conflict', 'sprint is not planned');
    if (Object.values(db.sprints).some((o) => o.projectId === s.projectId && o.state === 'active')) throw conflict('conflict', 'another sprint is active');
    s.state = 'active';
    if (!s.startDate) s.startDate = iso().slice(0, 10);
    s.committedPoints = pts(sprintIssues(s));
    s.startedAt = iso();
    return ok(s);
  });
  R('POST', '/api/sprints/:id/complete', ({ user, params, body }) => {
    const s = getSprint(params.id, user, 'developer');
    if (s.state !== 'active') throw conflict('conflict', 'sprint is not active');
    const p = db.projects[s.projectId];
    const to = (body && body.carryOverTo) ?? 'backlog';
    let target = null;
    if (to !== 'backlog') {
      target = db.sprints[to];
      if (!target || target.projectId !== s.projectId || target.id === s.id || target.state === 'completed') throw bad('invalid carryOverTo');
    }
    const t = iso();
    let carried = 0;
    for (const i of sprintIssues(s)) {
      if (isDone(p, i)) continue;
      addHistory(i, 'sprintId', s.id, target ? target.id : null, user.id, t, { _carry: true });
      i.sprintId = target ? target.id : null;
      i.updatedAt = t;
      carried++;
    }
    s.state = 'completed'; s.completedAt = t; s.carriedOver = carried;
    return ok(s);
  });
  R('GET', '/api/sprints/:id/report', ({ user, params }) => {
    const s = getSprint(params.id, user);
    const p = db.projects[s.projectId];
    const cur = sprintIssues(s);
    const completed = cur.filter((i) => isDone(p, i));
    const rep = { committedPoints: s.committedPoints ?? pts(cur), completedPoints: pts(completed), completedIssues: completed.length, carriedOver: s.carriedOver || 0, burndown: [] };
    if (s.state === 'planned' || !s.startDate) return ok(rep);
    const today = iso().slice(0, 10);
    let end = s.endDate && s.endDate < today ? s.endDate : today;
    if (!s.endDate && s.completedAt) end = s.completedAt.slice(0, 10) < end ? s.completedAt.slice(0, 10) : end;
    const all = issuesOf(s.projectId);
    for (let d = new Date(s.startDate + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= end; d = new Date(d.getTime() + 86400000)) {
      const ds = d.toISOString().slice(0, 10);
      const T = ds + 'T23:59:59.999Z';
      let rem = 0;
      for (const i of all) {
        if (i.createdAt > T) continue;
        const st = { sprintId: i.sprintId, storyPoints: i.storyPoints, status: i.status };
        const h = i.history || [];
        for (let k = h.length - 1; k >= 0; k--) {
          const e = h[k];
          if (!(e.field in st)) continue;
          if (e.at > T || (e._carry && e.from === s.id)) st[e.field] = e.from;
        }
        if (st.sprintId === s.id && catOf(p, st.status) !== 'completed') rem += st.storyPoints || 0;
      }
      rep.burndown.push({ date: ds, remainingPoints: rem });
    }
    return ok(rep);
  });
  R('GET', '/api/projects/:id/stats', ({ user, params }) => {
    const p = getProject(params.id, user);
    const l = issuesOf(p.id);
    const byStatus = Object.fromEntries(p.workflow.statuses.map((s) => [s.name, 0]));
    const byType = {}; const byAssignee = {};
    for (const i of l) {
      byStatus[i.status] = (byStatus[i.status] || 0) + 1;
      byType[i.type] = (byType[i.type] || 0) + 1;
      const a = i.assigneeId ? db.users[i.assigneeId].username : 'unassigned';
      byAssignee[a] = (byAssignee[a] || 0) + 1;
    }
    const times = [];
    for (const i of l) {
      if (!i.resolvedAt) continue;
      let start = null;
      if (catOf(p, i.status) && (i.history || []).length === 0) start = null;
      const h = (i.history || []).find((e) => e.field === 'status' && catOf(p, e.to) === 'started');
      if (h) start = h.at;
      if (start) times.push((Date.parse(i.resolvedAt) - Date.parse(start)) / 3600000);
    }
    const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length : null;
    return ok({ total: l.length, byStatus, byType, byAssignee, averageCycleTimeHours: avg, avgCycleTimeHours: avg, cycleTimeHours: avg, resolvedCount: times.length });
  });

  // search
  R('GET', '/api/search', ({ user, query }) => {
    const terms = parseQuery(query.get('q') || '');
    const sort = query.get('sort') || 'updated';
    if (!['updated', 'created', 'priority'].includes(sort)) throw bad('invalid sort');
    const pf = query.get('project');
    const visible = Object.values(db.projects).filter((p) => projRole(user, p) && (!pf || p.id === pf || p.key === pf));
    if (pf && !visible.length) {
      if (db.projects[pf]) throw forbidden();
    }
    const ctx = { user, db, projects: db.projects, sprints: db.sprints, users: db.users, userByName };
    let out = [];
    for (const p of visible) for (const i of issuesOf(p.id)) if (terms.every((t) => matchTerm(t, i, ctx))) out.push(i);
    const upd = (a, b) => b.updatedAt.localeCompare(a.updatedAt) || +b.id - +a.id;
    if (sort === 'created') out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || +b.id - +a.id);
    else if (sort === 'priority') out.sort((a, b) => PRIOS.indexOf(a.priority) - PRIOS.indexOf(b.priority) || upd(a, b));
    else out.sort(upd);
    return ok(out.map((i) => issueView(i)));
  });

  // csv
  const COLS = ['key', 'type', 'title', 'status', 'priority', 'assignee', 'labels', 'storyPoints', 'parent', 'epic', 'sprint', 'dueDate', 'createdAt', 'resolvedAt'];
  R('GET', '/api/projects/:id/export.csv', ({ user, params }) => {
    const p = getProject(params.id, user);
    const rows = [COLS];
    for (const i of issuesOf(p.id).sort((a, b) => +a.id - +b.id)) {
      rows.push([i.key, i.type, i.title, i.status, i.priority, i.assigneeId ? db.users[i.assigneeId].username : '', i.labels.join(';'), i.storyPoints ?? '', i.parentId && db.issues[i.parentId] ? db.issues[i.parentId].key : '', i.epicId && db.issues[i.epicId] ? db.issues[i.epicId].key : '', i.sprintId && db.sprints[i.sprintId] ? db.sprints[i.sprintId].name : '', i.dueDate ?? '', i.createdAt, i.resolvedAt ?? '']);
    }
    return { status: 200, raw: toCsv(rows), type: 'text/csv; charset=utf-8' };
  });
  R('POST', '/api/projects/:id/import.csv', ({ user, params, rawBody }) => {
    const p = getProject(params.id, user, 'developer');
    const recs = parseCsv(rawBody || '');
    if (!recs.length) throw bad('empty csv');
    const header = recs[0].fields.map((h) => h.trim());
    if (!header.includes('title')) throw bad('missing title column');
    let created = 0;
    const errors = [];
    for (const r of recs.slice(1)) {
      if (r.fields.length === 1 && r.fields[0].trim() === '') continue;
      const row = {};
      header.forEach((h, k) => { row[h] = (r.fields[k] ?? '').trim(); });
      try {
        const b = { title: row.title };
        if (row.type) b.type = row.type.toLowerCase();
        if (row.status) { if (!catOf(p, row.status)) throw bad(`unknown status "${row.status}"`); b.status = row.status; }
        if (row.priority) b.priority = row.priority.toLowerCase();
        if (row.assignee) { const au = userByName(row.assignee); if (!au) throw bad(`unknown assignee "${row.assignee}"`); b.assigneeId = au.id; }
        if (row.labels) b.labels = row.labels.split(';').map((x) => x.trim()).filter(Boolean);
        if (row.storyPoints) { const n = Number(row.storyPoints); if (!isFinite(n)) throw bad('invalid storyPoints'); b.storyPoints = n; }
        if (row.parent) b.parentId = row.parent;
        if (row.epic) b.epicId = row.epic;
        if (row.sprint) { const s = Object.values(db.sprints).find((x) => x.projectId === p.id && (x.name === row.sprint || x.id === row.sprint)); if (!s) throw bad(`unknown sprint "${row.sprint}"`); b.sprintId = s.id; }
        if (row.dueDate) b.dueDate = row.dueDate;
        createIssue(p, b, user);
        created++;
      } catch (e) {
        if (e instanceof HttpError) errors.push({ line: r.line, message: e.message }); else throw e;
      }
    }
    return ok({ created, errors });
  }, { raw: true });

  // webhooks
  const whView = ({ secret, ...rest }) => rest;
  R('POST', '/api/projects/:id/webhooks', ({ user, params, body }) => {
    const p = getProject(params.id, user, 'lead');
    const { url, events, secret } = body || {};
    let okUrl = false;
    try { okUrl = /^https?:$/.test(new URL(url).protocol); } catch { /* */ }
    if (!okUrl) throw bad('invalid url');
    if (!Array.isArray(events) || !events.length || events.some((e) => !EVENTS.includes(e))) throw bad('invalid events');
    if (!isStr(secret)) throw bad('secret required');
    const w = { id: id(), projectId: p.id, url, events, secret, createdAt: iso() };
    db.webhooks[w.id] = w;
    audit(p.workspaceId, 'webhook.created', user.id, { projectId: p.id, webhookId: w.id, url });
    return ok(whView(w), 201);
  });
  R('GET', '/api/projects/:id/webhooks', ({ user, params }) => { const p = getProject(params.id, user, 'lead'); return ok(Object.values(db.webhooks).filter((w) => w.projectId === p.id).map(whView)); });
  const getHook = (hid, user) => { const w = db.webhooks[hid]; if (!w) throw notFound('webhook not found'); getProject(w.projectId, user, 'lead'); return w; };
  R('DELETE', '/api/webhooks/:id', ({ user, params }) => {
    const w = getHook(params.id, user);
    delete db.webhooks[w.id];
    audit(db.projects[w.projectId].workspaceId, 'webhook.deleted', user.id, { projectId: w.projectId, webhookId: w.id });
    return { status: 204 };
  });
  R('GET', '/api/webhooks/:id/deliveries', ({ user, params }) => {
    const w = getHook(params.id, user);
    return ok(Object.values(db.deliveries).filter((d) => d.webhookId === w.id).map((d) => ({ ...d })));
  });

  // ---------- server ----------
  const send = (res, status, body, type = 'application/json; charset=utf-8') => {
    const data = body === undefined ? '' : typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(data) });
    res.end(status === 204 ? undefined : data);
  };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const p = url.pathname;
      if (req.method === 'GET' && (p === '/' || p.startsWith('/static/'))) {
        const rel = p === '/' ? 'index.html' : decodeURIComponent(p.slice(8));
        const f = path.join(STATIC_DIR, rel);
        if (!f.startsWith(STATIC_DIR) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return send(res, 404, { error: 'not_found', message: 'not found' });
        return send(res, 200, fs.readFileSync(f), MIME[path.extname(f)] || 'application/octet-stream');
      }
      let route = null; let params = {}; let pathMatched = false;
      for (const r of routes) {
        const m = r.re.exec(p);
        if (!m) continue;
        pathMatched = true;
        if (r.method !== req.method) continue;
        route = r;
        r.keys.forEach((k, n) => { params[k] = decodeURIComponent(m[n + 1]); });
        break;
      }
      if (!route) return send(res, pathMatched ? 405 : 404, { error: pathMatched ? 'method_not_allowed' : 'not_found', message: 'no such route' });
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const text = Buffer.concat(chunks).toString('utf8');
      let body;
      if (!route.raw && text.trim()) {
        try { body = JSON.parse(text); } catch { throw bad('invalid JSON body'); }
      }
      let user = null; let token = null;
      if (route.auth) {
        const h = req.headers.authorization || '';
        const m = /^Bearer\s+(\S+)$/i.exec(h);
        if (m) {
          token = m[1];
          const hs = sha(token);
          const uid = db.sessions[hs] || Object.values(db.tokens).find((t) => t.hash === hs)?.userId;
          user = uid && db.users[uid];
        }
        if (!user) throw new HttpError(401, 'unauthorized', 'authentication required');
      }
      const out = await route.fn({ user, token, params, query: url.searchParams, body, rawBody: text });
      if (out.raw !== undefined) send(res, out.status, out.raw, out.type);
      else send(res, out.status, out.body);
      if (req.method !== 'GET') save();
    } catch (e) {
      if (e && e.status === 400 && e.code === 'validation_error' && !(e instanceof HttpError)) return send(res, 400, { error: 'validation_error', message: e.message });
      if (e instanceof HttpError) return send(res, e.status, { error: e.code, message: e.message });
      console.error(e);
      send(res, 500, { error: 'internal_error', message: 'internal error' });
    }
  });
  return server;
}
