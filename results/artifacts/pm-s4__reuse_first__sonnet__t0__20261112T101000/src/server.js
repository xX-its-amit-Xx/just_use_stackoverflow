import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCsv, csvLine } from './csv.js';
import { parseQuery, matches } from './search.js';

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIOS = ['urgent', 'high', 'medium', 'low', 'none'];
const CATS = ['backlog', 'unstarted', 'started', 'completed'];
const EVENTS = ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'];
const LINKTYPES = ['blocks', 'relates', 'duplicates'];
const INVERSE = { blocks: 'blocked_by', relates: 'relates', duplicates: 'duplicated_by' };

class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const bad = (m) => new HttpError(400, 'validation_error', m);
const forbidden = (m = 'forbidden') => new HttpError(403, 'forbidden', m);
const notFound = (m = 'not found') => new HttpError(404, 'not_found', m);
const conflict = (code, m) => new HttpError(409, code, m);

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rid = () => crypto.randomBytes(8).toString('hex');
const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');

export function createServer({ dataFile, clock } = {}) {
  const now = () => (clock ? clock() : new Date());
  const iso = () => now().toISOString();
  const empty = () => ({ users: [], sessions: {}, apiTokens: [], workspaces: [], projects: [], issues: [], links: [], comments: [], notifications: [], sprints: [], webhooks: [], deliveries: [], audit: [] });
  let db = empty();
  if (dataFile && fs.existsSync(dataFile)) { try { db = { ...empty(), ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) }; } catch { /* corrupt: start fresh */ } }
  const save = () => { if (!dataFile) return; const tmp = dataFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, dataFile); };
  const failedLogins = new Map();

  // ---------- lookups ----------
  const userById = (id) => db.users.find((u) => u.id === id);
  const userByName = (n) => db.users.find((u) => u.username.toLowerCase() === String(n).toLowerCase());
  const pubUser = (u) => u && ({ id: u.id, username: u.username, displayName: u.displayName });
  const wsById = (id) => db.workspaces.find((w) => w.id === id);
  const projById = (id) => db.projects.find((p) => p.id === id);
  const wsRole = (user, ws) => ws.members.find((m) => m.userId === user.id)?.role || null;
  const projRole = (user, p) => {
    const ws = wsById(p.workspaceId); const r = wsRole(user, ws);
    if (!r) return null;
    if (r === 'admin') return 'lead';
    const m = p.members.find((x) => x.userId === user.id);
    if (m) return m.role;
    return r === 'member' ? 'developer' : null;
  };
  const getWs = (user, id, need) => {
    const ws = wsById(id); if (!ws) throw notFound('workspace not found');
    const r = wsRole(user, ws); if (!r) throw forbidden();
    if (need === 'admin' && r !== 'admin') throw forbidden('admin only');
    return ws;
  };
  const RANK = { viewer: 0, developer: 1, lead: 2 };
  const getProj = (user, id, need) => {
    const p = projById(id); if (!p) throw notFound('project not found');
    const r = projRole(user, p); if (!r) throw forbidden();
    if (need && RANK[r] < RANK[need]) throw forbidden('insufficient role');
    return { p, role: r };
  };
  const getIssue = (user, key, need) => {
    const cands = db.issues.filter((i) => i.key === key);
    if (!cands.length) throw notFound('issue not found');
    let hit = cands.find((i) => projRole(user, projById(i.projectId)));
    if (!hit) throw forbidden();
    const p = projById(hit.projectId); const r = projRole(user, p);
    if (need && RANK[r] < RANK[need]) throw forbidden('insufficient role');
    return { issue: hit, p, role: r };
  };
  const catOf = (p, status) => p.workflow.statuses.find((s) => s.name === status)?.category;
  const isDone = (issue) => catOf(projById(issue.projectId), issue.status) === 'completed';
  const keyOf = (id) => db.issues.find((i) => i.id === id)?.key ?? null;

  // ---------- audit / notifications / webhooks ----------
  const audit = (wsId, action, actorId, details = {}) => db.audit.push({ id: rid(), workspaceId: wsId, action, actorId, at: iso(), details });
  const notify = (userIds, type, issue, actorId) => {
    const p = projById(issue.projectId);
    for (const uid of new Set(userIds)) {
      if (!uid || uid === actorId) continue;
      const u = userById(uid); if (!u || !projRole(u, p)) continue;
      db.notifications.push({ id: rid(), userId: uid, type, issueKey: issue.key, actorId, at: iso(), read: false });
    }
  };
  const fire = (project, event, issue, actorId, extra = {}) => {
    for (const wh of db.webhooks.filter((w) => w.projectId === project.id && w.events.includes(event))) {
      const d = { id: rid(), webhookId: wh.id, event, status: null, attempts: 0, lastError: null, at: iso() };
      db.deliveries.push(d);
      const body = JSON.stringify({ event, issue, actorId, at: d.at, ...extra });
      deliver(wh, d, body);
    }
  };
  async function deliver(wh, d, body) {
    const sig = 'sha256=' + crypto.createHmac('sha256', wh.secret).update(body).digest('hex');
    for (let a = 1; a <= 3; a++) {
      d.attempts = a;
      try {
        const r = await fetch(wh.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pm-signature': sig }, body, signal: AbortSignal.timeout(5000) });
        d.status = r.status; d.lastError = r.ok ? null : `HTTP ${r.status}`;
        if (r.ok) break;
      } catch (e) { d.lastError = String(e.cause?.code || e.message); }
      save();
      if (a < 3) await new Promise((res) => setTimeout(res, 100 * a));
    }
    save();
  }

  // ---------- issue helpers ----------
  const childrenOf = (i) => db.issues.filter((c) => c.parentId === i.id);
  const issueOut = (i) => {
    const { history, ...rest } = i;
    const out = { ...rest, children: childrenOf(i).map((c) => c.key), links: linksOf(i) };
    if (i.type === 'epic') {
      const m = db.issues.filter((x) => x.epicId === i.id);
      out.progress = { total: m.length, done: m.filter(isDone).length, points_total: m.reduce((s, x) => s + (x.storyPoints || 0), 0), points_done: m.filter(isDone).reduce((s, x) => s + (x.storyPoints || 0), 0) };
    }
    return out;
  };
  const linksOf = (i) => {
    const out = [];
    for (const l of db.links) {
      if (l.source === i.id) { const k = keyOf(l.target); out.push({ id: l.id, type: l.type, key: k, target: k }); }
      else if (l.target === i.id) { const k = keyOf(l.source); out.push({ id: l.id, type: INVERSE[l.type], key: k, target: k }); }
    }
    return out;
  };
  const setField = (issue, field, to, actorId) => {
    const from = issue[field];
    if (JSON.stringify(from) === JSON.stringify(to)) return false;
    issue.history.push({ field, from, to, actorId, at: iso() });
    issue[field] = to; return true;
  };
  const initialStatus = (p) => (p.workflow.statuses.find((s) => s.category === 'unstarted') || p.workflow.statuses[0]).name;
  const validateRefs = (p, v, issue) => {
    // returns normalized partial of validated reference fields present in v
    const out = {};
    const find = (id) => db.issues.find((i) => i.id === id || i.key === id);
    if ('parentId' in v && v.parentId != null) {
      const par = find(v.parentId);
      if (!par || par.projectId !== p.id) throw bad('parentId must reference an issue in the same project');
      if (par.type === 'subtask') throw bad('parent cannot be a subtask');
      if (issue && par.id === issue.id) throw bad('issue cannot be its own parent');
      out.parentId = par.id;
    } else if ('parentId' in v) out.parentId = null;
    if ('epicId' in v && v.epicId != null) {
      const e = find(v.epicId);
      if (!e || e.projectId !== p.id || e.type !== 'epic') throw bad('epicId must reference an epic in the project');
      out.epicId = e.id;
    } else if ('epicId' in v) out.epicId = null;
    if ('sprintId' in v && v.sprintId != null) {
      const s = db.sprints.find((x) => x.id === v.sprintId);
      if (!s || s.projectId !== p.id) throw bad('sprintId must reference a sprint in the project');
      if (s.state === 'completed') throw bad('sprint is completed');
    } else if ('sprintId' in v) out.sprintId = null;
    return out;
  };
  const validateScalar = (v, partial) => {
    if ('type' in v && !TYPES.includes(v.type)) throw bad('invalid type');
    if ('priority' in v && !PRIOS.includes(v.priority)) throw bad('invalid priority');
    if ('title' in v && !isStr(v.title)) throw bad('title is required');
    if ('description' in v && v.description != null && typeof v.description !== 'string') throw bad('description must be a string');
    if ('labels' in v && !(Array.isArray(v.labels) && v.labels.every((l) => isStr(l)))) throw bad('labels must be an array of strings');
    if ('storyPoints' in v && v.storyPoints != null && !(typeof v.storyPoints === 'number' && v.storyPoints >= 0 && isFinite(v.storyPoints))) throw bad('storyPoints must be a non-negative number');
    if ('dueDate' in v && v.dueDate != null && !(typeof v.dueDate === 'string' && !isNaN(Date.parse(v.dueDate)))) throw bad('invalid dueDate');
    if ('assigneeId' in v && v.assigneeId != null && !userById(v.assigneeId)) throw bad('assignee not found');
  };
  const checkAssignee = (p, id) => { if (id != null) { const u = userById(id); if (!projRole(u, p)) throw bad('assignee has no access to the project'); } };
  const checkStructure = (type, parentId, epicId) => {
    if (type === 'subtask' && !parentId) throw bad('subtasks require a parentId');
    if (type === 'epic' && parentId) throw bad('epics cannot have parents');
    if (type !== 'subtask' && parentId) throw bad('only subtasks can have a parent');
    if (type === 'epic' && epicId) throw bad('epics cannot belong to an epic');
  };
  const createIssue = (p, user, v) => {
    validateScalar(v);
    if (!isStr(v.title)) throw bad('title is required');
    const type = v.type ?? 'task';
    if (!TYPES.includes(type)) throw bad('invalid type');
    const refs = validateRefs(p, v, null);
    const parentId = refs.parentId ?? null, epicId = refs.epicId ?? null;
    checkStructure(type, parentId, epicId);
    checkAssignee(p, v.assigneeId ?? null);
    let status = initialStatus(p);
    if (v.status != null) { if (catOf(p, v.status) === undefined) throw bad('unknown status'); status = v.status; }
    p.counter++;
    const t = iso();
    const issue = {
      id: rid(), key: `${p.key}-${p.counter}`, projectId: p.id, type, title: v.title.trim(), description: v.description ?? '', status,
      priority: v.priority ?? 'none', assigneeId: v.assigneeId ?? null, reporterId: user.id, labels: v.labels ?? [], storyPoints: v.storyPoints ?? null,
      parentId, epicId, sprintId: v.sprintId ?? null, dueDate: v.dueDate ?? null, watchers: [], createdAt: t, updatedAt: t,
      resolvedAt: catOf(p, status) === 'completed' ? t : null, history: [],
    };
    issue.watchers.push(user.id);
    if (issue.assigneeId && !issue.watchers.includes(issue.assigneeId)) issue.watchers.push(issue.assigneeId);
    db.issues.push(issue);
    return issue;
  };

  // ---------- router ----------
  const routes = [];
  const R = (method, pattern, handler, opts = {}) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler, ...opts });

  // ----- auth -----
  R('POST', '/api/auth/register', ({ body }) => {
    const { username, password, displayName } = body;
    if (typeof username !== 'string' || !/^[A-Za-z0-9_.-]{2,32}$/.test(username)) throw bad('invalid username');
    if (typeof password !== 'string' || password.length < 8) throw bad('password must be at least 8 characters');
    if (displayName != null && typeof displayName !== 'string') throw bad('invalid displayName');
    if (userByName(username)) throw conflict('conflict', 'username taken');
    const salt = crypto.randomBytes(16).toString('hex');
    const u = { id: rid(), username, displayName: displayName || username, salt, hash: hashPw(password, salt), createdAt: iso() };
    db.users.push(u);
    return [201, { user: pubUser(u) }];
  }, { anon: true });
  R('POST', '/api/auth/login', ({ body }) => {
    const { username, password } = body;
    if (typeof username !== 'string' || typeof password !== 'string') throw bad('username and password required');
    const k = username.toLowerCase(); const t = now().getTime();
    const fails = (failedLogins.get(k) || []).filter((x) => t - x < 15 * 60 * 1000);
    failedLogins.set(k, fails);
    if (fails.length >= 5) throw new HttpError(429, 'rate_limited', 'too many failed attempts');
    const u = userByName(username);
    if (!u || hashPw(password, u.salt) !== u.hash) { fails.push(t); throw new HttpError(401, 'unauthenticated', 'invalid credentials'); }
    failedLogins.delete(k);
    const token = crypto.randomBytes(24).toString('hex');
    db.sessions[sha(token)] = { userId: u.id, createdAt: iso() };
    return { token, user: pubUser(u) };
  }, { anon: true });
  R('POST', '/api/auth/logout', ({ token }) => { delete db.sessions[sha(token)]; return [204]; });
  R('GET', '/api/auth/me', ({ user }) => ({ user: pubUser(user) }));
  R('PATCH', '/api/auth/me', ({ user, body }) => {
    if (typeof body.currentPassword !== 'string') throw bad('currentPassword required');
    if (hashPw(body.currentPassword, user.salt) !== user.hash) throw forbidden('current password incorrect');
    if ('displayName' in body) { if (!isStr(body.displayName)) throw bad('invalid displayName'); user.displayName = body.displayName; }
    if ('password' in body) { if (typeof body.password !== 'string' || body.password.length < 8) throw bad('password must be at least 8 characters'); user.salt = crypto.randomBytes(16).toString('hex'); user.hash = hashPw(body.password, user.salt); }
    return { user: pubUser(user) };
  });
  R('GET', '/api/users', ({ query }) => db.users.filter((u) => !query.get('q') || u.username.toLowerCase().includes(query.get('q').toLowerCase())).map(pubUser));

  // ----- tokens -----
  const auditUser = (user, action, details) => { for (const ws of db.workspaces) if (wsRole(user, ws)) audit(ws.id, action, user.id, details); };
  R('POST', '/api/tokens', ({ user, body }) => {
    if (!isStr(body.name)) throw bad('name required');
    const token = 'pmt_' + crypto.randomBytes(24).toString('hex');
    const t = { id: rid(), userId: user.id, name: body.name, tokenHash: sha(token), createdAt: iso() };
    db.apiTokens.push(t); auditUser(user, 'token.created', { tokenId: t.id, name: t.name });
    return [201, { id: t.id, name: t.name, token }];
  });
  R('GET', '/api/tokens', ({ user }) => db.apiTokens.filter((t) => t.userId === user.id).map((t) => ({ id: t.id, name: t.name, createdAt: t.createdAt })));
  R('DELETE', '/api/tokens/:id', ({ user, params }) => {
    const i = db.apiTokens.findIndex((t) => t.id === params.id && t.userId === user.id);
    if (i < 0) throw notFound();
    const [t] = db.apiTokens.splice(i, 1); auditUser(user, 'token.deleted', { tokenId: t.id, name: t.name });
    return [204];
  });

  // ----- workspaces -----
  const wsOut = (ws, user) => ({ id: ws.id, name: ws.name, key: ws.key, role: wsRole(user, ws), createdAt: ws.createdAt });
  const memberOut = (m) => ({ userId: m.userId, role: m.role, user: pubUser(userById(m.userId)) });
  R('POST', '/api/workspaces', ({ user, body }) => {
    if (!isStr(body.name)) throw bad('name required');
    if (typeof body.key !== 'string' || !/^[A-Z]{2,10}$/.test(body.key)) throw bad('key must be 2-10 uppercase letters');
    if (db.workspaces.some((w) => w.key === body.key)) throw conflict('conflict', 'workspace key taken');
    const ws = { id: rid(), name: body.name, key: body.key, createdAt: iso(), members: [{ userId: user.id, role: 'admin' }] };
    db.workspaces.push(ws);
    return [201, wsOut(ws, user)];
  });
  R('GET', '/api/workspaces', ({ user }) => db.workspaces.filter((w) => wsRole(user, w)).map((w) => wsOut(w, user)));
  R('GET', '/api/workspaces/:id', ({ user, params }) => { const ws = getWs(user, params.id); return { ...wsOut(ws, user), members: ws.members.map(memberOut) }; });
  R('GET', '/api/workspaces/:id/members', ({ user, params }) => getWs(user, params.id).members.map(memberOut));
  R('POST', '/api/workspaces/:id/members', ({ user, params, body }) => {
    const ws = getWs(user, params.id, 'admin');
    if (!['admin', 'member', 'guest'].includes(body.role)) throw bad('invalid role');
    const u = typeof body.username === 'string' && userByName(body.username);
    if (!u) throw notFound('user not found');
    if (ws.members.some((m) => m.userId === u.id)) throw conflict('conflict', 'already a member');
    const m = { userId: u.id, role: body.role }; ws.members.push(m);
    audit(ws.id, 'member.added', user.id, { userId: u.id, role: m.role });
    return [201, memberOut(m)];
  });
  const findMember = (ws, uid) => { const m = ws.members.find((x) => x.userId === uid); if (!m) throw notFound('member not found'); return m; };
  const adminCount = (ws) => ws.members.filter((m) => m.role === 'admin').length;
  R('PATCH', '/api/workspaces/:id/members/:uid', ({ user, params, body }) => {
    const ws = getWs(user, params.id, 'admin'); const m = findMember(ws, params.uid);
    if (!['admin', 'member', 'guest'].includes(body.role)) throw bad('invalid role');
    if (m.role === 'admin' && body.role !== 'admin' && adminCount(ws) <= 1) throw bad('cannot demote the last admin');
    const from = m.role; m.role = body.role;
    audit(ws.id, 'member.role_changed', user.id, { userId: m.userId, from, to: m.role });
    return memberOut(m);
  });
  R('DELETE', '/api/workspaces/:id/members/:uid', ({ user, params }) => {
    const ws = getWs(user, params.id, 'admin'); const m = findMember(ws, params.uid);
    if (m.role === 'admin' && adminCount(ws) <= 1) throw bad('cannot remove the last admin');
    ws.members = ws.members.filter((x) => x !== m);
    for (const p of db.projects.filter((p) => p.workspaceId === ws.id)) p.members = p.members.filter((x) => x.userId !== m.userId);
    audit(ws.id, 'member.removed', user.id, { userId: m.userId });
    return [204];
  });
  R('GET', '/api/workspaces/:id/audit', ({ user, params }) => {
    const ws = getWs(user, params.id, 'admin');
    return db.audit.filter((a) => a.workspaceId === ws.id).slice().reverse();
  });

  // ----- projects -----
  const projOut = (p, user) => ({ id: p.id, workspaceId: p.workspaceId, name: p.name, key: p.key, role: projRole(user, p), workflow: p.workflow, members: p.members.map(memberOut), createdAt: p.createdAt });
  const defaultWorkflow = () => {
    const statuses = [['Backlog', 'backlog'], ['Todo', 'unstarted'], ['In Progress', 'started'], ['In Review', 'started'], ['Done', 'completed']].map(([name, category]) => ({ name, category }));
    const transitions = []; for (const a of statuses) for (const b of statuses) if (a.name !== b.name) transitions.push([a.name, b.name]);
    return { statuses, transitions };
  };
  R('POST', '/api/workspaces/:id/projects', ({ user, params, body }) => {
    const ws = getWs(user, params.id);
    if (wsRole(user, ws) === 'guest') throw forbidden('guests cannot create projects');
    if (!isStr(body.name)) throw bad('name required');
    if (typeof body.key !== 'string' || !/^[A-Z]{2,10}$/.test(body.key)) throw bad('key must be 2-10 uppercase letters');
    if (db.projects.some((p) => p.workspaceId === ws.id && p.key === body.key)) throw conflict('conflict', 'project key taken');
    const p = { id: rid(), workspaceId: ws.id, name: body.name, key: body.key, counter: 0, members: [{ userId: user.id, role: 'lead' }], workflow: defaultWorkflow(), createdAt: iso() };
    db.projects.push(p);
    return [201, projOut(p, user)];
  });
  R('GET', '/api/workspaces/:id/projects', ({ user, params }) => {
    const ws = getWs(user, params.id);
    return db.projects.filter((p) => p.workspaceId === ws.id && projRole(user, p)).map((p) => projOut(p, user));
  });
  R('GET', '/api/projects/:id', ({ user, params }) => projOut(getProj(user, params.id).p, user));
  R('POST', '/api/projects/:id/members', ({ user, params, body }) => {
    const { p } = getProj(user, params.id, 'lead');
    if (!['lead', 'developer', 'viewer'].includes(body.role)) throw bad('invalid role');
    const u = typeof body.username === 'string' && userByName(body.username);
    if (!u) throw notFound('user not found');
    if (!wsRole(u, wsById(p.workspaceId))) throw bad('user is not a member of the workspace');
    if (p.members.some((m) => m.userId === u.id)) throw conflict('conflict', 'already a project member');
    const m = { userId: u.id, role: body.role }; p.members.push(m);
    audit(p.workspaceId, 'project.member_added', user.id, { projectId: p.id, userId: u.id, role: m.role });
    return [201, memberOut(m)];
  });
  R('PATCH', '/api/projects/:id/members/:uid', ({ user, params, body }) => {
    const { p } = getProj(user, params.id, 'lead');
    if (!['lead', 'developer', 'viewer'].includes(body.role)) throw bad('invalid role');
    const m = p.members.find((x) => x.userId === params.uid); if (!m) throw notFound('member not found');
    const from = m.role; m.role = body.role;
    audit(p.workspaceId, 'project.member_role_changed', user.id, { projectId: p.id, userId: m.userId, from, to: m.role });
    return memberOut(m);
  });
  R('DELETE', '/api/projects/:id/members/:uid', ({ user, params }) => {
    const { p } = getProj(user, params.id, 'lead');
    const m = p.members.find((x) => x.userId === params.uid); if (!m) throw notFound('member not found');
    p.members = p.members.filter((x) => x !== m);
    audit(p.workspaceId, 'project.member_removed', user.id, { projectId: p.id, userId: m.userId });
    return [204];
  });
  R('PUT', '/api/projects/:id/workflow', ({ user, params, body }) => {
    const { p } = getProj(user, params.id, 'lead');
    const { statuses, transitions, remap = {} } = body;
    if (!Array.isArray(statuses) || !statuses.length) throw bad('statuses required');
    const names = new Set();
    for (const s of statuses) {
      if (!s || !isStr(s.name) || !CATS.includes(s.category)) throw bad('each status needs a name and valid category');
      if (names.has(s.name)) throw bad('duplicate status name'); names.add(s.name);
    }
    let tr = transitions;
    if (tr === undefined) { tr = []; for (const a of names) for (const b of names) if (a !== b) tr.push([a, b]); }
    if (!Array.isArray(tr) || !tr.every((t) => Array.isArray(t) && t.length === 2 && names.has(t[0]) && names.has(t[1]))) throw bad('transitions must be [from,to] pairs of known statuses');
    if (typeof remap !== 'object' || remap === null || Array.isArray(remap)) throw bad('remap must be an object');
    const removedInUse = [...new Set(db.issues.filter((i) => i.projectId === p.id && !names.has(i.status)).map((i) => i.status))];
    for (const s of removedInUse) if (!(s in remap) || !names.has(remap[s])) throw bad(`status "${s}" is in use; provide remap to an existing status`);
    const newCat = Object.fromEntries(statuses.map((s) => [s.name, s.category]));
    for (const i of db.issues.filter((i) => i.projectId === p.id)) {
      if (!names.has(i.status)) setField(i, 'status', remap[i.status], user.id);
      const done = newCat[i.status] === 'completed';
      if (done && !i.resolvedAt) i.resolvedAt = iso(); else if (!done) i.resolvedAt = null;
    }
    p.workflow = { statuses: statuses.map((s) => ({ name: s.name, category: s.category })), transitions: tr.map((t) => [t[0], t[1]]) };
    audit(p.workspaceId, 'workflow.updated', user.id, { projectId: p.id });
    return p.workflow;
  });
  R('GET', '/api/projects/:id/workflow', ({ user, params }) => getProj(user, params.id).p.workflow);

  // ----- issues -----
  R('POST', '/api/projects/:id/issues', ({ user, params, body }) => {
    const { p } = getProj(user, params.id, 'developer');
    const issue = createIssue(p, user, body);
    notify(issue.assigneeId ? [issue.assigneeId] : [], 'assigned', issue, user.id);
    fire(p, 'issue.created', issueOut(issue), user.id);
    return [201, issueOut(issue)];
  });
  R('GET', '/api/projects/:id/issues', ({ user, params, query }) => {
    const { p } = getProj(user, params.id);
    return runSearch(user, query.get('q') || '', [p], query.get('sort'));
  });
  R('GET', '/api/issues/:key', ({ user, params }) => issueOut(getIssue(user, params.key).issue));
  R('PATCH', '/api/issues/:key', ({ user, params, body }) => {
    const { issue, p } = getIssue(user, params.key, 'developer');
    const allowed = ['type', 'title', 'description', 'status', 'priority', 'assigneeId', 'labels', 'storyPoints', 'parentId', 'epicId', 'sprintId', 'dueDate'];
    const v = {}; for (const k of allowed) if (k in body) v[k] = body[k];
    validateScalar(v);
    if ('title' in v) v.title = v.title.trim();
    const refs = validateRefs(p, v, issue);
    for (const k of Object.keys(refs)) v[k] = refs[k];
    const type = v.type ?? issue.type;
    checkStructure(type, 'parentId' in v ? v.parentId : issue.parentId, 'epicId' in v ? v.epicId : issue.epicId);
    if ('assigneeId' in v) checkAssignee(p, v.assigneeId);
    if (v.type && v.type !== issue.type && issue.type === 'epic' && db.issues.some((x) => x.epicId === issue.id) ) throw bad('epic has members');
    let statusChanged = false;
    if ('status' in v && v.status !== issue.status) {
      if (catOf(p, v.status) === undefined) throw bad('unknown status');
      if (!p.workflow.transitions.some(([a, b]) => a === issue.status && b === v.status)) throw conflict('invalid_transition', `cannot move from "${issue.status}" to "${v.status}"`);
      if (catOf(p, v.status) === 'completed') {
        const blocked = db.links.some((l) => ((l.type === 'blocks' && l.target === issue.id) ) && !isDone(db.issues.find((x) => x.id === l.source)));
        if (blocked) throw conflict('blocked', 'issue is blocked by an unresolved issue');
      }
      statusChanged = true;
    }
    let assignChanged = false;
    for (const k of Object.keys(v)) {
      if (k === 'status' && !statusChanged) continue;
      if (setField(issue, k, v[k], user.id)) { if (k === 'status') {} if (k === 'assigneeId') assignChanged = true; }
    }
    if (statusChanged) {
      const done = catOf(p, issue.status) === 'completed';
      if (done) issue.resolvedAt = iso(); else issue.resolvedAt = null;
    }
    if (assignChanged && issue.assigneeId && !issue.watchers.includes(issue.assigneeId)) issue.watchers.push(issue.assigneeId);
    issue.updatedAt = iso();
    if (statusChanged) notify(issue.watchers, 'status_changed', issue, user.id);
    if (assignChanged) notify(issue.watchers, 'assigned', issue, user.id);
    fire(p, 'issue.updated', issueOut(issue), user.id);
    return issueOut(issue);
  });
  R('DELETE', '/api/issues/:key', ({ user, params }) => {
    const { issue, p } = getIssue(user, params.key, 'developer');
    const gone = new Set([issue.id, ...childrenOf(issue).map((c) => c.id)]);
    const out = issueOut(issue);
    db.issues = db.issues.filter((i) => !gone.has(i.id));
    db.links = db.links.filter((l) => !gone.has(l.source) && !gone.has(l.target));
    db.comments = db.comments.filter((c) => !gone.has(c.issueId));
    for (const i of db.issues) if (gone.has(i.epicId)) i.epicId = null;
    fire(p, 'issue.deleted', out, user.id);
    return [204];
  });
  R('GET', '/api/issues/:key/history', ({ user, params }) => getIssue(user, params.key).issue.history.map((h) => ({ ...h })));
  R('POST', '/api/issues/:key/links', ({ user, params, body }) => {
    const { issue, p } = getIssue(user, params.key, 'developer');
    if (!LINKTYPES.includes(body.type)) throw bad('invalid link type');
    if (!isStr(body.target)) throw bad('target required');
    const t = db.issues.find((i) => i.key === body.target && i.projectId === p.id) || db.issues.find((i) => i.key === body.target && projRole(user, projById(i.projectId)));
    if (!t) throw notFound('target issue not found');
    if (t.id === issue.id) throw bad('cannot link an issue to itself');
    if (db.links.some((l) => (l.source === issue.id && l.target === t.id && l.type === body.type) || (l.source === t.id && l.target === issue.id && l.type === body.type && body.type === 'relates'))) throw conflict('conflict', 'link already exists');
    const l = { id: rid(), type: body.type, source: issue.id, target: t.id }; db.links.push(l);
    issue.updatedAt = iso();
    return [201, issueOut(issue)];
  });
  R('DELETE', '/api/issues/:key/links/:id', ({ user, params }) => {
    const { issue } = getIssue(user, params.key, 'developer');
    const i = db.links.findIndex((l) => l.id === params.id && (l.source === issue.id || l.target === issue.id));
    if (i < 0) throw notFound(); db.links.splice(i, 1); return [204];
  });
  R('POST', '/api/issues/:key/watch', ({ user, params }) => {
    const { issue } = getIssue(user, params.key);
    if (!issue.watchers.includes(user.id)) issue.watchers.push(user.id);
    return issueOut(issue);
  });
  R('DELETE', '/api/issues/:key/watch', ({ user, params }) => {
    const { issue } = getIssue(user, params.key);
    issue.watchers = issue.watchers.filter((w) => w !== user.id); return [204];
  });

  // ----- comments -----
  const commentOut = (c) => ({ id: c.id, issueId: c.issueId, issueKey: keyOf(c.issueId), authorId: c.authorId, body: c.body, createdAt: c.createdAt, updatedAt: c.updatedAt, edited: c.edited });
  const mentionsIn = (text, p) => [...new Set([...text.matchAll(/(?:^|[^\w@])@([A-Za-z0-9_.-]+)/g)].map((m) => m[1].replace(/[.-]+$/, '')))].map(userByName).filter((u) => u && projRole(u, p));
  R('POST', '/api/issues/:key/comments', ({ user, params, body }) => {
    const { issue, p } = getIssue(user, params.key, 'developer');
    if (!isStr(body.body)) throw bad('body required');
    const t = iso();
    const c = { id: rid(), issueId: issue.id, authorId: user.id, body: body.body, createdAt: t, updatedAt: t, edited: false };
    db.comments.push(c);
    const mentioned = mentionsIn(body.body, p).map((u) => u.id);
    notify(mentioned, 'mention', issue, user.id);
    notify(issue.watchers.filter((w) => !mentioned.includes(w)), 'comment', issue, user.id);
    fire(p, 'comment.created', issueOut(issue), user.id, { comment: commentOut(c) });
    return [201, commentOut(c)];
  });
  R('GET', '/api/issues/:key/comments', ({ user, params }) => { const { issue } = getIssue(user, params.key); return db.comments.filter((c) => c.issueId === issue.id).map(commentOut); });
  const findComment = (user, id, key) => {
    const c = db.comments.find((x) => x.id === id); if (!c) throw notFound('comment not found');
    const issue = db.issues.find((i) => i.id === c.issueId); const p = projById(issue.projectId);
    if (key && issue.key !== key) throw notFound('comment not found');
    const role = projRole(user, p); if (!role) throw forbidden();
    return { c, issue, p, role };
  };
  const patchComment = ({ user, params, body }) => {
    const { c } = findComment(user, params.id, params.key);
    if (c.authorId !== user.id) throw forbidden('only the author can edit');
    if (!isStr(body.body)) throw bad('body required');
    c.body = body.body; c.edited = true; c.updatedAt = iso(); return commentOut(c);
  };
  const delComment = ({ user, params }) => {
    const { c, role } = findComment(user, params.id, params.key);
    if (c.authorId !== user.id && role !== 'lead') throw forbidden();
    db.comments = db.comments.filter((x) => x !== c); return [204];
  };
  R('PATCH', '/api/comments/:id', patchComment); R('PATCH', '/api/issues/:key/comments/:id', patchComment);
  R('DELETE', '/api/comments/:id', delComment); R('DELETE', '/api/issues/:key/comments/:id', delComment);

  // ----- notifications -----
  R('GET', '/api/notifications', ({ user, query }) => {
    const unread = query.get('unread') === 'true';
    return db.notifications.filter((n) => n.userId === user.id && (!unread || !n.read)).slice().reverse().map(({ userId, ...n }) => n);
  });
  R('POST', '/api/notifications/read', ({ user, body }) => {
    let n = 0;
    if (body.all === true) { for (const x of db.notifications) if (x.userId === user.id && !x.read) { x.read = true; n++; } }
    else if (Array.isArray(body.ids)) { for (const x of db.notifications) if (x.userId === user.id && body.ids.includes(x.id) && !x.read) { x.read = true; n++; } }
    else throw bad('ids or all required');
    return { updated: n };
  });

  // ----- sprints -----
  const sprintOut = (s) => s;
  const getSprint = (user, id, need) => {
    const s = db.sprints.find((x) => x.id === id); if (!s) throw notFound('sprint not found');
    const p = projById(s.projectId); const r = projRole(user, p); if (!r) throw forbidden();
    if (need && RANK[r] < RANK[need]) throw forbidden('insufficient role');
    return { s, p };
  };
  const dateOk = (d) => d == null || (typeof d === 'string' && !isNaN(Date.parse(d)));
  R('POST', '/api/projects/:id/sprints', ({ user, params, body }) => {
    const { p } = getProj(user, params.id, 'developer');
    if (!isStr(body.name)) throw bad('name required');
    if (!dateOk(body.startDate) || !dateOk(body.endDate)) throw bad('invalid date');
    if (body.startDate && body.endDate && body.endDate < body.startDate) throw bad('endDate before startDate');
    const s = { id: rid(), projectId: p.id, name: body.name, state: 'planned', startDate: body.startDate ?? null, endDate: body.endDate ?? null, createdAt: iso(), startedAt: null, completedAt: null, result: null, committedPoints: null };
    db.sprints.push(s); return [201, sprintOut(s)];
  });
  R('GET', '/api/projects/:id/sprints', ({ user, params }) => { const { p } = getProj(user, params.id); return db.sprints.filter((s) => s.projectId === p.id); });
  R('GET', '/api/sprints/:id', ({ user, params }) => sprintOut(getSprint(user, params.id).s));
  const sprintIssues = (s) => db.issues.filter((i) => i.sprintId === s.id);
  const pts = (list) => list.reduce((a, i) => a + (i.storyPoints || 0), 0);
  R('POST', '/api/sprints/:id/start', ({ user, params }) => {
    const { s, p } = getSprint(user, params.id, 'developer');
    if (s.state !== 'planned') throw conflict('conflict', 'sprint is not planned');
    if (db.sprints.some((x) => x.projectId === p.id && x.state === 'active')) throw conflict('conflict', 'another sprint is already active');
    s.state = 'active'; s.startedAt = iso(); if (!s.startDate) s.startDate = s.startedAt.slice(0, 10);
    s.committedPoints = pts(sprintIssues(s)); return sprintOut(s);
  });
  R('POST', '/api/sprints/:id/complete', ({ user, params, body }) => {
    const { s, p } = getSprint(user, params.id, 'developer');
    if (s.state !== 'active') throw conflict('conflict', 'sprint is not active');
    const to = body.carryOverTo ?? 'backlog';
    let target = null;
    if (to !== 'backlog') {
      target = db.sprints.find((x) => x.id === to);
      if (!target || target.projectId !== p.id || target.id === s.id || target.state === 'completed') throw bad('invalid carryOverTo');
    }
    const all = sprintIssues(s), done = all.filter(isDone), open = all.filter((i) => !isDone(i));
    s.result = { completedPoints: pts(done), completedIssues: done.length, carriedOver: open.length };
    for (const i of open) { setField(i, 'sprintId', target ? target.id : null, user.id); i.updatedAt = iso(); }
    s.state = 'completed'; s.completedAt = iso(); return sprintOut(s);
  });
  const stateAt = (issue, T) => {
    if (issue.createdAt > T) return null;
    const st = { sprintId: issue.sprintId, storyPoints: issue.storyPoints, status: issue.status };
    for (let k = issue.history.length - 1; k >= 0; k--) { const h = issue.history[k]; if (h.at <= T) break; if (h.field in st) st[h.field] = h.from; }
    return st;
  };
  R('GET', '/api/sprints/:id/report', ({ user, params }) => {
    const { s, p } = getSprint(user, params.id);
    const live = sprintIssues(s);
    const res = s.result || { completedPoints: pts(live.filter(isDone)), completedIssues: live.filter(isDone).length, carriedOver: 0 };
    const burndown = [];
    const startD = s.startDate || (s.startedAt && s.startedAt.slice(0, 10));
    if (startD && s.state !== 'planned') {
      const today = iso().slice(0, 10);
      let end = s.endDate ? s.endDate.slice(0, 10) : today;
      if (end > today) end = today;
      if (s.completedAt && s.completedAt.slice(0, 10) < end) end = s.completedAt.slice(0, 10);
      const candidates = db.issues.filter((i) => i.projectId === p.id);
      for (let d = new Date(startD.slice(0, 10) + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= end; d = new Date(d.getTime() + 86400000)) {
        const day = d.toISOString().slice(0, 10), T = day + 'T23:59:59.999Z';
        let rem = 0;
        for (const i of candidates) { const st = stateAt(i, T); if (st && st.sprintId === s.id && catOf(p, st.status) !== 'completed') rem += st.storyPoints || 0; }
        burndown.push({ date: day, remainingPoints: rem });
      }
    }
    return { committedPoints: s.committedPoints ?? pts(live), completedPoints: res.completedPoints, completedIssues: res.completedIssues, carriedOver: res.carriedOver, burndown };
  });
  R('GET', '/api/projects/:id/stats', ({ user, params }) => {
    const { p } = getProj(user, params.id);
    const list = db.issues.filter((i) => i.projectId === p.id);
    const byStatus = Object.fromEntries(p.workflow.statuses.map((s) => [s.name, 0])), byType = {}, byAssignee = {};
    const cycles = [];
    for (const i of list) {
      byStatus[i.status] = (byStatus[i.status] || 0) + 1; byType[i.type] = (byType[i.type] || 0) + 1;
      const an = i.assigneeId ? userById(i.assigneeId)?.username : 'unassigned'; byAssignee[an] = (byAssignee[an] || 0) + 1;
      if (i.resolvedAt) {
        let startAt = null;
        if (catOf(p, i.history.find((h) => h.field === 'status')?.from ?? i.status) === 'started') startAt = i.createdAt;
        for (const h of i.history) { if (h.field === 'status' && catOf(p, h.to) === 'started') { startAt = startAt && startAt < h.at ? startAt : h.at; break; } }
        if (startAt) cycles.push((Date.parse(i.resolvedAt) - Date.parse(startAt)) / 3600000);
      }
    }
    return { total: list.length, byStatus, byType, byAssignee, averageCycleTimeHours: cycles.length ? cycles.reduce((a, b) => a + b, 0) / cycles.length : null, avgCycleTimeHours: cycles.length ? cycles.reduce((a, b) => a + b, 0) / cycles.length : null };
  });

  // ----- search -----
  const PR = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
  function runSearch(user, q, projects, sort) {
    let terms; try { terms = parseQuery(q); } catch (e) { throw bad('malformed query: ' + e.message); }
    if (sort && !['updated', 'created', 'priority'].includes(sort)) throw bad('invalid sort');
    const ctx = { me: user, userByName, sprintById: (id) => db.sprints.find((s) => s.id === id), isDone };
    const ids = new Set(projects.map((p) => p.id));
    let res = db.issues.filter((i) => ids.has(i.projectId) && terms.every((t) => matches(i, t, ctx) !== !!t.neg));
    const by = sort || 'updated';
    const ord = (a, b) => a < b ? -1 : a > b ? 1 : 0;
    res.sort((a, b) => by === 'priority' ? (PR[a.priority] - PR[b.priority]) || ord(b.updatedAt, a.updatedAt) : by === 'created' ? ord(b.createdAt, a.createdAt) || (b.createdAt === a.createdAt ? db.issues.indexOf(b) - db.issues.indexOf(a) : 0) : ord(b.updatedAt, a.updatedAt) || (db.issues.indexOf(b) - db.issues.indexOf(a)));
    return res.map(issueOut);
  }
  R('GET', '/api/search', ({ user, query }) => {
    let projects = db.projects.filter((p) => projRole(user, p));
    const pr = query.get('project');
    if (pr) { projects = projects.filter((p) => p.id === pr || p.key === pr); }
    return runSearch(user, query.get('q') || '', projects, query.get('sort'));
  });

  // ----- CSV -----
  const COLS = ['key', 'type', 'title', 'status', 'priority', 'assignee', 'labels', 'storyPoints', 'parent', 'epic', 'sprint', 'dueDate', 'createdAt', 'resolvedAt'];
  R('GET', '/api/projects/:id/export.csv', ({ user, params }) => {
    const { p } = getProj(user, params.id);
    const lines = [COLS.join(',')];
    for (const i of db.issues.filter((x) => x.projectId === p.id)) {
      lines.push(csvLine([i.key, i.type, i.title, i.status, i.priority, i.assigneeId ? userById(i.assigneeId)?.username : '', i.labels.join(';'), i.storyPoints ?? '', i.parentId ? keyOf(i.parentId) : '', i.epicId ? keyOf(i.epicId) : '', i.sprintId ? db.sprints.find((s) => s.id === i.sprintId)?.name : '', i.dueDate ?? '', i.createdAt, i.resolvedAt ?? '']));
    }
    return { raw: lines.join('\r\n') + '\r\n', type: 'text/csv; charset=utf-8', headers: { 'content-disposition': `attachment; filename="${p.key}.csv"` } };
  });
  R('POST', '/api/projects/:id/import.csv', ({ user, params, raw }) => {
    const { p } = getProj(user, params.id, 'developer');
    const rows = parseCsv(raw || '');
    if (!rows.length) throw bad('empty CSV');
    const head = rows[0].cells.map((h) => h.trim());
    for (const need of ['title']) if (!head.includes(need)) throw bad(`missing column: ${need}`);
    const errors = []; let created = 0;
    for (const { line, cells } of rows.slice(1)) {
      const g = (c) => { const k = head.indexOf(c); return k < 0 ? '' : (cells[k] ?? '').trim(); };
      try {
        const v = {};
        if (!g('title')) throw bad('title is required');
        v.title = g('title');
        if (g('type')) v.type = g('type');
        if (g('status')) v.status = g('status');
        if (g('priority')) v.priority = g('priority');
        if (g('assignee')) { const u = userByName(g('assignee')); if (!u) throw bad(`unknown assignee "${g('assignee')}"`); v.assigneeId = u.id; }
        if (g('labels')) v.labels = g('labels').split(';').map((x) => x.trim()).filter(Boolean);
        if (g('storyPoints')) { const n = Number(g('storyPoints')); if (!isFinite(n) || n < 0) throw bad('invalid storyPoints'); v.storyPoints = n; }
        if (g('parent')) { const par = db.issues.find((i) => i.key === g('parent') && i.projectId === p.id); if (!par) throw bad(`unknown parent "${g('parent')}"`); v.parentId = par.id; }
        if (g('epic')) { const e = db.issues.find((i) => i.key === g('epic') && i.projectId === p.id); if (!e) throw bad(`unknown epic "${g('epic')}"`); v.epicId = e.id; }
        if (g('sprint')) { const s = db.sprints.find((x) => x.projectId === p.id && x.name === g('sprint')); if (!s) throw bad(`unknown sprint "${g('sprint')}"`); v.sprintId = s.id; }
        if (g('dueDate')) v.dueDate = g('dueDate');
        createIssue(p, user, v); created++;
      } catch (e) { if (!(e instanceof HttpError)) throw e; errors.push({ line, message: e.message }); }
    }
    return { created, errors };
  });

  // ----- webhooks -----
  const whOut = (w) => ({ id: w.id, projectId: w.projectId, url: w.url, events: w.events, createdAt: w.createdAt });
  R('POST', '/api/projects/:id/webhooks', ({ user, params, body }) => {
    const { p } = getProj(user, params.id, 'lead');
    let u; try { u = new URL(body.url); } catch { throw bad('invalid url'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw bad('invalid url');
    if (!Array.isArray(body.events) || !body.events.length || !body.events.every((e) => EVENTS.includes(e))) throw bad('invalid events');
    if (!isStr(body.secret)) throw bad('secret required');
    const w = { id: rid(), projectId: p.id, url: body.url, events: body.events, secret: body.secret, createdAt: iso() };
    db.webhooks.push(w); audit(p.workspaceId, 'webhook.created', user.id, { webhookId: w.id, projectId: p.id, url: w.url });
    return [201, whOut(w)];
  });
  R('GET', '/api/projects/:id/webhooks', ({ user, params }) => { const { p } = getProj(user, params.id, 'lead'); return db.webhooks.filter((w) => w.projectId === p.id).map(whOut); });
  const getWh = (user, id) => { const w = db.webhooks.find((x) => x.id === id); if (!w) throw notFound('webhook not found'); return { w, p: getProj(user, w.projectId, 'lead').p }; };
  R('DELETE', '/api/webhooks/:id', ({ user, params }) => {
    const { w, p } = getWh(user, params.id);
    db.webhooks = db.webhooks.filter((x) => x !== w); audit(p.workspaceId, 'webhook.deleted', user.id, { webhookId: w.id, projectId: p.id });
    return [204];
  });
  R('GET', '/api/webhooks/:id/deliveries', ({ user, params }) => { const { w } = getWh(user, params.id); return db.deliveries.filter((d) => d.webhookId === w.id).map(({ id, event, status, attempts, lastError, at }) => ({ id, event, status, attempts, lastError, at })); });

  // ---------- HTTP plumbing ----------
  const send = (res, status, body, extra = {}) => {
    if (status === 204) { res.writeHead(204); return res.end(); }
    const data = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': data.length, ...extra }); res.end(data);
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > 10 * 1024 * 1024) { reject(new HttpError(400, 'validation_error', 'body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
  const serveStatic = (res, pathname) => {
    let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/static\//, '');
    const file = path.normalize(path.join(STATIC_DIR, rel));
    if (!file.startsWith(STATIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
    const data = fs.readFileSync(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-length': data.length }); res.end(data); return true;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = url.pathname.replace(/(.)\/+$/, '$1');
      if (!pathname.startsWith('/api/')) {
        if (req.method === 'GET' && (pathname === '/' || pathname.startsWith('/static/')) && serveStatic(res, pathname)) return;
        return send(res, 404, { error: 'not_found', message: 'not found' });
      }
      let route = null, params = null, pathMatched = false;
      for (const r of routes) { const m = r.re.exec(pathname); if (m) { pathMatched = true; if (r.method === req.method) { route = r; params = m.groups || {}; break; } } }
      if (!route) return send(res, pathMatched ? 405 : 404, { error: pathMatched ? 'method_not_allowed' : 'not_found', message: pathMatched ? 'method not allowed' : 'not found' });
      let user = null, token = null;
      const auth = req.headers.authorization;
      if (auth && /^Bearer /i.test(auth)) {
        token = auth.slice(7).trim(); const h = sha(token);
        const s = db.sessions[h]; const at = db.apiTokens.find((t) => t.tokenHash === h);
        user = userById(s ? s.userId : at?.userId);
      }
      if (!route.anon && !user) return send(res, 401, { error: 'unauthenticated', message: 'authentication required' });
      const text = (req.method === 'GET' || req.method === 'DELETE' || req.method === 'HEAD') ? '' : await readBody(req);
      let body = {};
      if (text && !route.re.source.includes('import')) {
        try { body = JSON.parse(text); } catch { throw bad('invalid JSON body'); }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('body must be a JSON object');
      }
      const out = await route.handler({ req, user, token, params, body, raw: text, query: url.searchParams });
      if (out && out.raw !== undefined) { res.writeHead(200, { 'content-type': out.type, ...out.headers }); return res.end(out.raw); }
      if (Array.isArray(out) && typeof out[0] === 'number') { if (req.method !== 'GET') save(); return send(res, out[0], out[1]); }
      if (req.method !== 'GET') save();
      send(res, 200, out);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.code, message: e.message });
      console.error(e);
      send(res, 500, { error: 'internal_error', message: 'internal error' });
    }
  });
  return server;
}
