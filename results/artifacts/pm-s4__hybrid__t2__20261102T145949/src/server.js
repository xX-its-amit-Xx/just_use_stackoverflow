import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');
const CATS = ['backlog', 'unstarted', 'started', 'completed'];
const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIOS = ['urgent', 'high', 'medium', 'low', 'none'];
const LINKS = ['blocks', 'relates', 'duplicates'];
const EVENTS = ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'];
const DEFAULT_STATUSES = [['Backlog', 'backlog'], ['Todo', 'unstarted'], ['In Progress', 'started'], ['In Review', 'started'], ['Done', 'completed']];

class HttpError extends Error { constructor(status, error, message) { super(message || error); this.status = status; this.error = error; } }
const bad = (m) => new HttpError(400, 'validation_error', m);
const notFound = (m = 'not found') => new HttpError(404, 'not_found', m);
const forbidden = (m = 'forbidden') => new HttpError(403, 'forbidden', m);
const conflict = (m, code = 'conflict') => new HttpError(409, code, m);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const uid = () => crypto.randomUUID();
const isStr = (v) => typeof v === 'string';
const isDate = (s) => isStr(s) && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) { return { salt, hash: crypto.scryptSync(pw, salt, 32).toString('hex') }; }
function checkPw(u, pw) { const h = crypto.scryptSync(pw, u.salt, 32); const b = Buffer.from(u.passHash, 'hex'); return b.length === h.length && crypto.timingSafeEqual(h, b); }

export function createServer({ dataFile, clock } = {}) {
  const now = () => (clock ? clock() : new Date());
  const iso = () => now().toISOString();
  const emptyDb = () => ({ users: [], sessions: [], apiTokens: [], workspaces: [], projects: [], issues: [], comments: [], links: [], sprints: [], notifications: [], webhooks: [], deliveries: [], audit: [], history: [] });
  let db = emptyDb();
  if (dataFile && fs.existsSync(dataFile)) { try { db = { ...emptyDb(), ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) }; } catch { /* ignore */ } }
  const save = () => { if (!dataFile) return; const tmp = dataFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, dataFile); };
  const loginFails = new Map();

  // ---------- lookups / access ----------
  const userById = (id) => db.users.find((u) => u.id === id);
  const userByName = (n) => isStr(n) ? db.users.find((u) => u.username.toLowerCase() === n.toLowerCase()) : undefined;
  const pubUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName, createdAt: u.createdAt });
  const wsRole = (u, ws) => ws.members.find((m) => m.userId === u.id)?.role;
  function projRole(u, p) {
    const ws = db.workspaces.find((w) => w.id === p.workspaceId); if (!ws) return null;
    const wr = wsRole(u, ws); if (!wr) return null;
    if (wr === 'admin') return 'lead';
    const pm = p.members.find((m) => m.userId === u.id)?.role;
    if (pm) return pm;
    return wr === 'member' ? 'developer' : null;
  }
  const canSeeProject = (userId, p) => { const u = userById(userId); return !!u && !!projRole(u, p); };
  function getWs(u, id) { const ws = db.workspaces.find((w) => w.id === id); if (!ws) throw notFound('workspace not found'); if (!wsRole(u, ws)) throw forbidden('not a workspace member'); return ws; }
  function getProject(u, id, need) {
    const p = db.projects.find((x) => x.id === id); if (!p) throw notFound('project not found');
    const r = projRole(u, p); if (!r) throw notFound('project not found');
    if (need === 'lead' && r !== 'lead') throw forbidden('lead role required');
    if (need === 'write' && r === 'viewer') throw forbidden('read-only role');
    return { p, role: r };
  }
  function findIssue(u, key, need) {
    const k = String(key);
    const is = db.issues.find((i) => i.key === k && db.projects.some((p) => p.id === i.projectId && projRole(u, p)));
    if (!is) throw notFound('issue not found');
    const p = db.projects.find((x) => x.id === is.projectId); const r = projRole(u, p);
    if (need === 'lead' && r !== 'lead') throw forbidden('lead role required');
    if (need === 'write' && r === 'viewer') throw forbidden('read-only role');
    return { is, p, role: r };
  }
  const audit = (wsId, actor, action, target, details) => db.audit.push({ id: uid(), workspaceId: wsId, action, actorId: actor, target: target ?? null, details: details ?? null, at: iso() });

  // ---------- issue helpers ----------
  const issueById = (id) => db.issues.find((i) => i.id === id);
  const catOf = (p, status) => p.workflow.statuses.find((s) => s.name === status)?.category;
  const isDone = (p, i) => catOf(p, i.status) === 'completed';
  function hist(is, field, from, to, actor, at) { db.history.push({ issueId: is.id, field, from: from ?? null, to: to ?? null, actorId: actor, at: at || iso() }); }
  function outIssue(is) {
    const p = db.projects.find((x) => x.id === is.projectId);
    const o = { ...is, labels: [...is.labels], watchers: [...is.watchers] };
    o.children = db.issues.filter((c) => c.parentId === is.id).map((c) => c.key);
    o.links = linksOf(is);
    if (is.type === 'epic') {
      const ch = db.issues.filter((c) => c.epicId === is.id);
      o.progress = { total: ch.length, done: ch.filter((c) => isDone(p, c)).length, points_total: ch.reduce((a, c) => a + (c.storyPoints || 0), 0), points_done: ch.filter((c) => isDone(p, c)).reduce((a, c) => a + (c.storyPoints || 0), 0) };
    }
    return o;
  }
  const INV = { blocks: 'blocked_by', duplicates: 'duplicated_by', relates: 'relates' };
  function linksOf(is) {
    const out = [];
    for (const l of db.links) {
      if (l.from === is.id) { const t = issueById(l.to); if (t) out.push({ id: l.id, type: l.type, target: t.key }); }
      else if (l.to === is.id) { const t = issueById(l.from); if (t) out.push({ id: l.id, type: INV[l.type], target: t.key }); }
    }
    return out;
  }
  function resolveRef(p, ref, what) {
    if (ref === null || ref === undefined || ref === '') return null;
    if (!isStr(ref)) throw bad(what + ' must be a string');
    const t = db.issues.find((i) => i.projectId === p.id && (i.id === ref || i.key === ref));
    if (!t) throw bad(what + ' not found in project');
    return t;
  }
  function validateFields(p, f, self) {
    if (!TYPES.includes(f.type)) throw bad('invalid type');
    if (!isStr(f.title) || !f.title.trim() || f.title.length > 300) throw bad('title required');
    if (f.description !== undefined && f.description !== null && !isStr(f.description)) throw bad('invalid description');
    if (!PRIOS.includes(f.priority)) throw bad('invalid priority');
    if (!Array.isArray(f.labels) || f.labels.some((l) => !isStr(l) || !l)) throw bad('invalid labels');
    if (f.storyPoints !== null && (typeof f.storyPoints !== 'number' || !isFinite(f.storyPoints) || f.storyPoints < 0)) throw bad('invalid storyPoints');
    if (f.dueDate !== null && !isDate(f.dueDate)) throw bad('invalid dueDate');
    if (f.assigneeId !== null) { if (!isStr(f.assigneeId) || !canSeeProject(f.assigneeId, p)) throw bad('invalid assignee'); }
    if (f.type === 'subtask') {
      const par = f.parentId && issueById(f.parentId);
      if (!par || par.projectId !== p.id || par.type === 'subtask' || (self && par.id === self.id)) throw bad('subtask requires a valid non-subtask parent in the same project');
    } else if (f.parentId) throw bad('only subtasks may have a parent');
    if (f.epicId) {
      const e = issueById(f.epicId);
      if (!e || e.projectId !== p.id || e.type !== 'epic') throw bad('epicId must reference an epic');
      if (f.type === 'epic') throw bad('epics cannot belong to epics');
    }
    if (f.sprintId) { const s = db.sprints.find((x) => x.id === f.sprintId); if (!s || s.projectId !== p.id) throw bad('invalid sprint'); }
    if (self && f.type !== self.type && self.type === 'epic' && db.issues.some((c) => c.epicId === self.id)) throw bad('epic has children');
  }
  function watch(is, userId) { if (userId && !is.watchers.includes(userId)) is.watchers.push(userId); }
  function notify(userIds, type, is, actor) {
    for (const uidd of new Set(userIds)) { if (!uidd || uidd === actor) continue; db.notifications.push({ id: uid(), userId: uidd, type, issueKey: is.key, actorId: actor, at: iso(), read: false }); }
  }
  function createIssue(p, actor, b, { silent } = {}) {
    const initial = p.workflow.statuses.find((s) => s.category === 'unstarted') || p.workflow.statuses[0];
    let status = initial.name;
    if (b.status !== undefined && b.status !== null) { if (!p.workflow.statuses.some((s) => s.name === b.status)) throw bad('unknown status'); status = b.status; }
    const f = {
      type: b.type ?? 'task', title: b.title, description: b.description ?? '', priority: b.priority ?? 'none', labels: b.labels ?? [],
      storyPoints: b.storyPoints ?? null, dueDate: b.dueDate ?? null, assigneeId: b.assigneeId ?? null,
      parentId: b.parentId ? (resolveRef(p, b.parentId, 'parentId')?.id ?? null) : null,
      epicId: b.epicId ? (resolveRef(p, b.epicId, 'epicId')?.id ?? null) : null, sprintId: b.sprintId ?? null,
    };
    validateFields(p, f, null);
    if (f.sprintId && db.sprints.find((s) => s.id === f.sprintId).state === 'completed') throw bad('sprint is completed');
    p.nextNum++;
    const t = iso();
    const is = { id: uid(), key: `${p.key}-${p.nextNum}`, projectId: p.id, ...f, status, reporterId: actor, watchers: [], createdAt: t, updatedAt: t, resolvedAt: catOf(p, status) === 'completed' ? t : null };
    watch(is, actor); watch(is, f.assigneeId);
    db.issues.push(is);
    if (!silent) fire(p, 'issue.created', is, actor);
    return is;
  }

  // ---------- webhooks ----------
  function fire(p, event, is, actor) {
    for (const w of db.webhooks.filter((x) => x.projectId === p.id && x.events.includes(event))) {
      const body = JSON.stringify({ event, issue: outIssue(is), actorId: actor, at: iso() });
      const d = { id: uid(), webhookId: w.id, event, status: 'pending', attempts: 0, lastError: null, at: iso() };
      db.deliveries.push(d);
      (async () => {
        const sig = 'sha256=' + crypto.createHmac('sha256', w.secret).update(body).digest('hex');
        for (let a = 1; a <= 3; a++) {
          d.attempts = a;
          try {
            const r = await fetch(w.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pm-signature': sig }, body, signal: AbortSignal.timeout(5000) });
            if (r.ok) { d.status = 'success'; d.lastError = null; break; }
            d.lastError = 'HTTP ' + r.status;
          } catch (e) { d.lastError = String(e.message || e); }
          d.status = 'failed';
          if (a < 3) await new Promise((r) => setTimeout(r, 50 * a));
        }
        try { save(); } catch { /* ignore */ }
      })();
    }
  }

  // ---------- routes ----------
  const routes = [];
  const R = (m, p, fn, opts = {}) => routes.push({ m, re: new RegExp('^' + p.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn, auth: opts.auth !== false });
  const needStr = (v, n) => { if (!isStr(v) || !v.trim()) throw bad(n + ' required'); return v.trim(); };

  // auth
  R('POST', '/api/auth/register', ({ body }) => {
    const username = needStr(body.username, 'username');
    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) throw bad('invalid username');
    if (!isStr(body.password) || body.password.length < 8) throw bad('password must be at least 8 characters');
    if (userByName(username)) throw conflict('username taken');
    const { salt, hash } = hashPw(body.password);
    const u = { id: uid(), username, displayName: isStr(body.displayName) && body.displayName.trim() ? body.displayName.trim() : username, salt, passHash: hash, createdAt: iso() };
    db.users.push(u);
    return [201, pubUser(u)];
  }, { auth: false });
  R('POST', '/api/auth/login', ({ body, req }) => {
    const key = (isStr(body.username) ? body.username.toLowerCase() : '') + '|' + req.socket.remoteAddress;
    const t = Date.now(); const rec = loginFails.get(key) || { n: 0, t };
    if (t - rec.t > 60000) { rec.n = 0; rec.t = t; }
    if (rec.n >= 10) throw new HttpError(429, 'rate_limited', 'too many attempts');
    if (!isStr(body.username) || !isStr(body.password)) throw bad('username and password required');
    const u = userByName(body.username);
    if (!u || !checkPw(u, body.password)) { rec.n++; loginFails.set(key, rec); throw new HttpError(401, 'unauthorized', 'invalid credentials'); }
    loginFails.delete(key);
    const token = crypto.randomBytes(32).toString('hex');
    db.sessions.push({ hash: sha(token), userId: u.id, createdAt: iso() });
    return [200, { token, user: pubUser(u) }];
  }, { auth: false });
  R('POST', '/api/auth/logout', ({ tokenHash }) => { db.sessions = db.sessions.filter((s) => s.hash !== tokenHash); return [204]; });
  R('GET', '/api/auth/me', ({ u }) => [200, pubUser(u)]);
  R('PATCH', '/api/auth/me', ({ u, body }) => {
    if (body.displayName !== undefined) { if (!isStr(body.displayName) || !body.displayName.trim()) throw bad('invalid displayName'); }
    if (body.password !== undefined) {
      if (!isStr(body.password) || body.password.length < 8) throw bad('password must be at least 8 characters');
      if (!isStr(body.currentPassword)) throw bad('currentPassword required');
      if (!checkPw(u, body.currentPassword)) throw forbidden('current password incorrect');
      const { salt, hash } = hashPw(body.password); u.salt = salt; u.passHash = hash;
    }
    if (body.displayName !== undefined) u.displayName = body.displayName.trim();
    return [200, pubUser(u)];
  });
  // api tokens
  R('POST', '/api/tokens', ({ u, body }) => {
    const name = needStr(body.name, 'name');
    const token = 'pmt_' + crypto.randomBytes(24).toString('hex');
    const t = { id: uid(), userId: u.id, name, hash: sha(token), createdAt: iso() };
    db.apiTokens.push(t);
    for (const w of db.workspaces) if (wsRole(u, w)) audit(w.id, u.id, 'token.created', t.id, { name });
    return [201, { id: t.id, name, token }];
  });
  R('GET', '/api/tokens', ({ u }) => [200, db.apiTokens.filter((t) => t.userId === u.id).map((t) => ({ id: t.id, name: t.name, createdAt: t.createdAt }))]);
  R('DELETE', '/api/tokens/:id', ({ u, params }) => {
    const t = db.apiTokens.find((x) => x.id === params.id && x.userId === u.id); if (!t) throw notFound('token not found');
    db.apiTokens = db.apiTokens.filter((x) => x !== t);
    for (const w of db.workspaces) if (wsRole(u, w)) audit(w.id, u.id, 'token.deleted', t.id, { name: t.name });
    return [204];
  });
  // workspaces
  const outWs = (w) => ({ id: w.id, name: w.name, key: w.key, createdAt: w.createdAt, members: w.members.map((m) => ({ userId: m.userId, username: userById(m.userId)?.username, role: m.role })) });
  R('POST', '/api/workspaces', ({ u, body }) => {
    const name = needStr(body.name, 'name');
    if (!isStr(body.key) || !/^[A-Z]{2,10}$/.test(body.key)) throw bad('key must be 2-10 uppercase letters');
    if (db.workspaces.some((w) => w.key === body.key)) throw conflict('workspace key taken');
    const w = { id: uid(), name, key: body.key, createdAt: iso(), members: [{ userId: u.id, role: 'admin' }] };
    db.workspaces.push(w); audit(w.id, u.id, 'workspace.created', w.id, { name });
    return [201, outWs(w)];
  });
  R('GET', '/api/workspaces', ({ u }) => [200, db.workspaces.filter((w) => wsRole(u, w)).map(outWs)]);
  R('GET', '/api/workspaces/:id', ({ u, params }) => [200, outWs(getWs(u, params.id))]);
  const adminWs = (u, id) => { const w = getWs(u, id); if (wsRole(u, w) !== 'admin') throw forbidden('admin required'); return w; };
  R('POST', '/api/workspaces/:id/members', ({ u, params, body }) => {
    const w = adminWs(u, params.id);
    const t = userByName(body.username); if (!t) throw notFound('user not found');
    if (!['admin', 'member', 'guest'].includes(body.role)) throw bad('invalid role');
    if (wsRole(t, w)) throw conflict('already a member');
    w.members.push({ userId: t.id, role: body.role }); audit(w.id, u.id, 'member.added', t.id, { username: t.username, role: body.role });
    return [201, outWs(w)];
  });
  R('PATCH', '/api/workspaces/:id/members/:uid', ({ u, params, body }) => {
    const w = adminWs(u, params.id);
    const m = w.members.find((x) => x.userId === params.uid || userById(x.userId)?.username === params.uid); if (!m) throw notFound('member not found');
    if (!['admin', 'member', 'guest'].includes(body.role)) throw bad('invalid role');
    if (m.role === 'admin' && body.role !== 'admin' && w.members.filter((x) => x.role === 'admin').length === 1) throw bad('cannot demote the last admin');
    const from = m.role; m.role = body.role; audit(w.id, u.id, 'member.role_changed', m.userId, { from, to: body.role });
    return [200, outWs(w)];
  });
  R('DELETE', '/api/workspaces/:id/members/:uid', ({ u, params }) => {
    const w = adminWs(u, params.id);
    const m = w.members.find((x) => x.userId === params.uid || userById(x.userId)?.username === params.uid); if (!m) throw notFound('member not found');
    if (m.role === 'admin' && w.members.filter((x) => x.role === 'admin').length === 1) throw bad('cannot remove the last admin');
    w.members = w.members.filter((x) => x !== m);
    for (const p of db.projects.filter((x) => x.workspaceId === w.id)) p.members = p.members.filter((x) => x.userId !== m.userId);
    audit(w.id, u.id, 'member.removed', m.userId, null);
    return [204];
  });
  R('GET', '/api/workspaces/:id/audit', ({ u, params }) => { const w = adminWs(u, params.id); return [200, db.audit.filter((a) => a.workspaceId === w.id).map(({ workspaceId, ...a }) => a)]; });
  // projects
  const outProj = (p) => ({ id: p.id, workspaceId: p.workspaceId, name: p.name, key: p.key, createdAt: p.createdAt, workflow: p.workflow, members: p.members.map((m) => ({ userId: m.userId, username: userById(m.userId)?.username, role: m.role })) });
  R('POST', '/api/workspaces/:id/projects', ({ u, params, body }) => {
    const w = getWs(u, params.id);
    if (wsRole(u, w) === 'guest') throw forbidden('guests cannot create projects');
    const name = needStr(body.name, 'name');
    if (!isStr(body.key) || !/^[A-Z]{2,10}$/.test(body.key)) throw bad('key must be 2-10 uppercase letters');
    if (db.projects.some((p) => p.workspaceId === w.id && p.key === body.key)) throw conflict('project key taken');
    const statuses = DEFAULT_STATUSES.map(([n, c]) => ({ name: n, category: c }));
    const transitions = []; for (const a of statuses) for (const b of statuses) if (a.name !== b.name) transitions.push([a.name, b.name]);
    const p = { id: uid(), workspaceId: w.id, name, key: body.key, createdAt: iso(), nextNum: 0, members: [{ userId: u.id, role: 'lead' }], workflow: { statuses, transitions } };
    db.projects.push(p);
    return [201, outProj(p)];
  });
  R('GET', '/api/workspaces/:id/projects', ({ u, params }) => { const w = getWs(u, params.id); return [200, db.projects.filter((p) => p.workspaceId === w.id && projRole(u, p)).map(outProj)]; });
  R('GET', '/api/projects/:id', ({ u, params }) => [200, { ...outProj(getProject(u, params.id).p), role: getProject(u, params.id).role }]);
  R('POST', '/api/projects/:id/members', ({ u, params, body }) => {
    const { p } = getProject(u, params.id, 'lead');
    const t = userByName(body.username); if (!t) throw notFound('user not found');
    if (!['lead', 'developer', 'viewer'].includes(body.role)) throw bad('invalid role');
    const w = db.workspaces.find((x) => x.id === p.workspaceId);
    if (!wsRole(t, w)) throw bad('user is not a workspace member');
    const ex = p.members.find((m) => m.userId === t.id);
    if (ex) throw conflict('already a project member');
    p.members.push({ userId: t.id, role: body.role }); audit(w.id, u.id, 'project.member_added', t.id, { project: p.key, role: body.role });
    return [201, outProj(p)];
  });
  R('PATCH', '/api/projects/:id/members/:uid', ({ u, params, body }) => {
    const { p } = getProject(u, params.id, 'lead');
    const m = p.members.find((x) => x.userId === params.uid); if (!m) throw notFound('member not found');
    if (!['lead', 'developer', 'viewer'].includes(body.role)) throw bad('invalid role');
    m.role = body.role; audit(p.workspaceId, u.id, 'project.member_role_changed', m.userId, { project: p.key, role: body.role });
    return [200, outProj(p)];
  });
  R('DELETE', '/api/projects/:id/members/:uid', ({ u, params }) => {
    const { p } = getProject(u, params.id, 'lead');
    const m = p.members.find((x) => x.userId === params.uid); if (!m) throw notFound('member not found');
    p.members = p.members.filter((x) => x !== m); audit(p.workspaceId, u.id, 'project.member_removed', m.userId, { project: p.key });
    return [204];
  });
  R('PUT', '/api/projects/:id/workflow', ({ u, params, body }) => {
    const { p } = getProject(u, params.id, 'lead');
    if (!Array.isArray(body.statuses) || !body.statuses.length) throw bad('statuses required');
    const names = new Set();
    for (const s of body.statuses) {
      if (!s || !isStr(s.name) || !s.name.trim() || !CATS.includes(s.category)) throw bad('invalid status');
      if (names.has(s.name)) throw bad('duplicate status'); names.add(s.name);
    }
    let transitions = body.transitions;
    if (transitions === undefined) { transitions = []; for (const a of names) for (const b of names) if (a !== b) transitions.push([a, b]); }
    if (!Array.isArray(transitions) || transitions.some((t) => !Array.isArray(t) || t.length !== 2 || !names.has(t[0]) || !names.has(t[1]))) throw bad('invalid transitions');
    const remap = body.remap ?? {};
    if (typeof remap !== 'object' || Array.isArray(remap)) throw bad('invalid remap');
    const removed = p.workflow.statuses.map((s) => s.name).filter((n) => !names.has(n));
    const pissues = db.issues.filter((i) => i.projectId === p.id);
    for (const r of removed) if (pissues.some((i) => i.status === r) && !(isStr(remap[r]) && names.has(remap[r]))) throw bad(`status "${r}" is in use; provide remap`);
    const newCat = (n) => body.statuses.find((s) => s.name === n).category;
    const t = iso();
    for (const i of pissues) {
      const to = removed.includes(i.status) ? remap[i.status] : i.status;
      const wasDone = i.resolvedAt !== null; const nowDone = newCat(to) === 'completed';
      if (to !== i.status) { hist(i, 'status', i.status, to, u.id); i.status = to; i.updatedAt = t; }
      if (wasDone && !nowDone) { hist(i, 'resolvedAt', i.resolvedAt, null, u.id); i.resolvedAt = null; }
      else if (!wasDone && nowDone) { i.resolvedAt = t; hist(i, 'resolvedAt', null, t, u.id); }
    }
    p.workflow = { statuses: body.statuses.map((s) => ({ name: s.name, category: s.category })), transitions: transitions.map((x) => [x[0], x[1]]) };
    audit(p.workspaceId, u.id, 'workflow.updated', p.id, { project: p.key });
    return [200, outProj(p)];
  });
  // issues
  R('POST', '/api/projects/:id/issues', ({ u, params, body }) => {
    const { p } = getProject(u, params.id, 'write');
    return [201, outIssue(createIssue(p, u.id, body))];
  });
  R('GET', '/api/projects/:id/issues', ({ u, params }) => { const { p } = getProject(u, params.id); return [200, db.issues.filter((i) => i.projectId === p.id).map(outIssue)]; });
  R('GET', '/api/issues/:key', ({ u, params }) => [200, outIssue(findIssue(u, params.key).is)]);
  R('PATCH', '/api/issues/:key', ({ u, params, body }) => {
    const { is, p } = findIssue(u, params.key, 'write');
    const fields = ['type', 'title', 'description', 'status', 'priority', 'assigneeId', 'labels', 'storyPoints', 'parentId', 'epicId', 'sprintId', 'dueDate'];
    const f = {}; for (const k of fields) f[k] = is[k];
    for (const k of fields) if (body[k] !== undefined) f[k] = body[k];
    if (body.parentId !== undefined) f.parentId = body.parentId ? (resolveRef(p, body.parentId, 'parentId').id) : null;
    if (body.epicId !== undefined) f.epicId = body.epicId ? (resolveRef(p, body.epicId, 'epicId').id) : null;
    for (const k of ['assigneeId', 'storyPoints', 'dueDate', 'sprintId']) if (f[k] === undefined || f[k] === '') f[k] = null;
    validateFields(p, f, is);
    if (f.sprintId && f.sprintId !== is.sprintId && db.sprints.find((s) => s.id === f.sprintId).state === 'completed') throw bad('sprint is completed');
    let newResolved = is.resolvedAt;
    if (f.status !== is.status) {
      if (!p.workflow.statuses.some((s) => s.name === f.status)) throw bad('unknown status');
      if (!p.workflow.transitions.some((t) => t[0] === is.status && t[1] === f.status)) throw conflict(`transition ${is.status} -> ${f.status} not allowed`, 'invalid_transition');
      if (catOf(p, f.status) === 'completed') {
        const blockers = db.links.filter((l) => l.type === 'blocks' && l.to === is.id).map((l) => issueById(l.from)).filter((b) => b && !isDone(p, b) && b.resolvedAt === null);
        if (blockers.length) throw conflict('blocked by unresolved issue ' + blockers.map((b) => b.key).join(', '), 'blocked');
        if (!is.resolvedAt) newResolved = iso();
      } else newResolved = null;
    }
    const t = iso(); const changes = [];
    for (const k of fields) {
      const a = is[k], b = f[k];
      if (JSON.stringify(a) !== JSON.stringify(b)) { hist(is, k, a, b, u.id, t); changes.push(k); is[k] = Array.isArray(b) ? [...b] : b; }
    }
    if (newResolved !== is.resolvedAt) { hist(is, 'resolvedAt', is.resolvedAt, newResolved, u.id, t); is.resolvedAt = newResolved; }
    if (changes.length || newResolved !== null) { /* fallthrough */ }
    if (changes.length) {
      is.updatedAt = t;
      if (changes.includes('assigneeId') && is.assigneeId) { watch(is, is.assigneeId); notify([is.assigneeId, ...is.watchers], 'assigned', is, u.id); }
      if (changes.includes('status')) notify(is.watchers, 'status_changed', is, u.id);
      fire(p, 'issue.updated', is, u.id);
    }
    return [200, outIssue(is)];
  });
  R('DELETE', '/api/issues/:key', ({ u, params }) => {
    const { is, p } = findIssue(u, params.key, 'write');
    const ids = new Set([is.id, ...db.issues.filter((c) => c.parentId === is.id).map((c) => c.id)]);
    const gone = db.issues.filter((i) => ids.has(i.id));
    db.issues = db.issues.filter((i) => !ids.has(i.id));
    for (const i of db.issues) if (ids.has(i.epicId)) i.epicId = null;
    db.links = db.links.filter((l) => !ids.has(l.from) && !ids.has(l.to));
    db.comments = db.comments.filter((c) => !ids.has(c.issueId));
    db.history = db.history.filter((h) => !ids.has(h.issueId));
    for (const g of gone) fire(p, 'issue.deleted', g, u.id);
    return [204];
  });
  R('GET', '/api/issues/:key/history', ({ u, params }) => { const { is } = findIssue(u, params.key); return [200, db.history.filter((h) => h.issueId === is.id).map(({ field, from, to, actorId, at }) => ({ field, from, to, actorId, at }))]; });
  R('POST', '/api/issues/:key/links', ({ u, params, body }) => {
    const { is, p } = findIssue(u, params.key, 'write');
    if (!LINKS.includes(body.type)) throw bad('invalid link type');
    const t = db.issues.find((i) => i.key === body.target && db.projects.some((q) => q.id === i.projectId && projRole(u, q)));
    if (!t) throw bad('target not found');
    if (t.id === is.id) throw bad('cannot link to self');
    if (db.links.some((l) => (l.from === is.id && l.to === t.id && l.type === body.type) || (l.from === t.id && l.to === is.id && (l.type === body.type && body.type === 'relates')))) throw conflict('link exists');
    const l = { id: uid(), type: body.type, from: is.id, to: t.id }; db.links.push(l);
    is.updatedAt = iso();
    return [201, { id: l.id, type: l.type, target: t.key }];
  });
  R('GET', '/api/issues/:key/links', ({ u, params }) => [200, linksOf(findIssue(u, params.key).is)]);
  R('DELETE', '/api/issues/:key/links/:id', ({ u, params }) => {
    const { is } = findIssue(u, params.key, 'write');
    const l = db.links.find((x) => x.id === params.id && (x.from === is.id || x.to === is.id)); if (!l) throw notFound('link not found');
    db.links = db.links.filter((x) => x !== l); return [204];
  });
  // comments / watchers / notifications
  const outComment = (c) => ({ id: c.id, issueKey: c.issueKey, authorId: c.authorId, body: c.body, createdAt: c.createdAt, updatedAt: c.updatedAt, edited: c.edited });
  R('POST', '/api/issues/:key/comments', ({ u, params, body }) => {
    const { is, p } = findIssue(u, params.key);
    const text = needStr(body.body, 'body');
    const c = { id: uid(), issueId: is.id, issueKey: is.key, authorId: u.id, body: text, createdAt: iso(), updatedAt: iso(), edited: false };
    db.comments.push(c);
    const mentioned = [];
    for (const m of text.matchAll(/@([A-Za-z0-9_.-]+)/g)) { const mu = userByName(m[1].replace(/[.-]+$/, '')); if (mu && canSeeProject(mu.id, p)) mentioned.push(mu.id); }
    notify(mentioned, 'mention', is, u.id);
    notify(is.watchers.filter((w) => !mentioned.includes(w)), 'comment', is, u.id);
    fire(p, 'comment.created', is, u.id);
    return [201, outComment(c)];
  });
  R('GET', '/api/issues/:key/comments', ({ u, params }) => { const { is } = findIssue(u, params.key); return [200, db.comments.filter((c) => c.issueId === is.id).map(outComment)]; });
  R('PATCH', '/api/comments/:id', ({ u, params, body }) => {
    const c = db.comments.find((x) => x.id === params.id); if (!c) throw notFound('comment not found');
    findIssue(u, c.issueKey);
    if (c.authorId !== u.id) throw forbidden('only the author can edit');
    c.body = needStr(body.body, 'body'); c.edited = true; c.updatedAt = iso(); return [200, outComment(c)];
  });
  R('DELETE', '/api/comments/:id', ({ u, params }) => {
    const c = db.comments.find((x) => x.id === params.id); if (!c) throw notFound('comment not found');
    const { role } = findIssue(u, c.issueKey);
    if (c.authorId !== u.id && role !== 'lead') throw forbidden('not allowed');
    db.comments = db.comments.filter((x) => x !== c); return [204];
  });
  R('POST', '/api/issues/:key/watch', ({ u, params }) => { const { is } = findIssue(u, params.key); watch(is, u.id); return [200, outIssue(is)]; });
  R('DELETE', '/api/issues/:key/watch', ({ u, params }) => { const { is } = findIssue(u, params.key); is.watchers = is.watchers.filter((w) => w !== u.id); return [200, outIssue(is)]; });
  R('GET', '/api/notifications', ({ u, query }) => {
    let l = db.notifications.filter((n) => n.userId === u.id);
    if (query.get('unread') === 'true') l = l.filter((n) => !n.read);
    return [200, l.map(({ id, type, issueKey, actorId, at, read }) => ({ id, type, issueKey, actorId, at, read })).reverse()];
  });
  R('POST', '/api/notifications/read', ({ u, body }) => {
    const mine = db.notifications.filter((n) => n.userId === u.id);
    if (body.all === true) mine.forEach((n) => { n.read = true; });
    else if (Array.isArray(body.ids)) mine.filter((n) => body.ids.includes(n.id)).forEach((n) => { n.read = true; });
    else throw bad('ids or all required');
    return [200, { unread: mine.filter((n) => !n.read).length }];
  });
  // sprints
  const getSprint = (u, id, need) => { const s = db.sprints.find((x) => x.id === id); if (!s) throw notFound('sprint not found'); const { p } = getProject(u, s.projectId, need); return { s, p }; };
  const outSprint = (s) => ({ id: s.id, projectId: s.projectId, name: s.name, state: s.state, startDate: s.startDate, endDate: s.endDate, createdAt: s.createdAt });
  R('POST', '/api/projects/:id/sprints', ({ u, params, body }) => {
    const { p } = getProject(u, params.id, 'write');
    const name = needStr(body.name, 'name');
    for (const k of ['startDate', 'endDate']) if (body[k] !== undefined && body[k] !== null && !isDate(body[k])) throw bad('invalid ' + k);
    if (body.startDate && body.endDate && body.endDate < body.startDate) throw bad('endDate before startDate');
    const s = { id: uid(), projectId: p.id, name, state: 'planned', startDate: body.startDate ?? null, endDate: body.endDate ?? null, createdAt: iso(), committedIds: [], committedPoints: 0, carriedOver: 0 };
    db.sprints.push(s); return [201, outSprint(s)];
  });
  R('GET', '/api/projects/:id/sprints', ({ u, params }) => { const { p } = getProject(u, params.id); return [200, db.sprints.filter((s) => s.projectId === p.id).map(outSprint)]; });
  R('GET', '/api/sprints/:id', ({ u, params }) => [200, outSprint(getSprint(u, params.id).s)]);
  R('POST', '/api/sprints/:id/start', ({ u, params }) => {
    const { s } = getSprint(u, params.id, 'write');
    if (s.state !== 'planned') throw conflict('sprint is not planned');
    if (db.sprints.some((x) => x.projectId === s.projectId && x.state === 'active')) throw conflict('another sprint is active');
    s.state = 'active'; if (!s.startDate) s.startDate = iso().slice(0, 10);
    const is = db.issues.filter((i) => i.sprintId === s.id);
    s.committedIds = is.map((i) => i.id); s.committedPoints = is.reduce((a, i) => a + (i.storyPoints || 0), 0);
    return [200, outSprint(s)];
  });
  R('POST', '/api/sprints/:id/complete', ({ u, params, body }) => {
    const { s, p } = getSprint(u, params.id, 'write');
    if (s.state !== 'active') throw conflict('sprint is not active');
    const to = body.carryOverTo ?? 'backlog';
    let target = null;
    if (to !== 'backlog') {
      target = db.sprints.find((x) => x.id === to);
      if (!target || target.projectId !== s.projectId || target.id === s.id || target.state === 'completed') throw bad('invalid carryOverTo');
    }
    const t = iso(); let n = 0;
    for (const i of db.issues.filter((x) => x.sprintId === s.id && !isDone(p, x))) {
      hist(i, 'sprintId', i.sprintId, target ? target.id : null, u.id, t); i.sprintId = target ? target.id : null; i.updatedAt = t; n++;
    }
    s.state = 'completed'; s.carriedOver = n; s.completedAt = t;
    if (target && target.state === 'active') { /* committed snapshot unchanged */ }
    return [200, outSprint(s)];
  });
  R('GET', '/api/sprints/:id/report', ({ u, params }) => {
    const { s, p } = getSprint(u, params.id);
    let ids = s.committedIds; let committed = s.committedPoints;
    if (s.state === 'planned') { const cur = db.issues.filter((i) => i.sprintId === s.id); ids = cur.map((i) => i.id); committed = cur.reduce((a, i) => a + (i.storyPoints || 0), 0); }
    const issues = ids.map(issueById).filter(Boolean);
    const completed = issues.filter((i) => isDone(p, i));
    const out = { committedPoints: committed, completedPoints: completed.reduce((a, i) => a + (i.storyPoints || 0), 0), completedIssues: completed.length, carriedOver: s.state === 'completed' ? s.carriedOver : 0, burndown: [] };
    if (s.startDate && s.state !== 'planned') {
      const today = now().toISOString().slice(0, 10);
      let last = s.endDate && s.endDate < today ? s.endDate : today;
      if (s.state === 'completed' && s.completedAt && s.completedAt.slice(0, 10) < last) last = s.completedAt.slice(0, 10);
      for (let d = new Date(s.startDate + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= last; d = new Date(d.getTime() + 86400000)) {
        const ds = d.toISOString().slice(0, 10); const endOfDay = ds + 'T23:59:59.999Z';
        let rem = 0;
        for (const i of issues) {
          const hs = db.history.filter((h) => h.issueId === i.id && h.field === 'resolvedAt' && h.at <= endOfDay);
          let resolved;
          if (hs.length) resolved = hs[hs.length - 1].to !== null;
          else resolved = db.history.some((h) => h.issueId === i.id && h.field === 'resolvedAt') ? false : (i.resolvedAt !== null && i.resolvedAt <= endOfDay);
          if (!resolved) rem += i.storyPoints || 0;
        }
        out.burndown.push({ date: ds, remainingPoints: rem });
      }
    }
    return [200, out];
  });
  R('GET', '/api/projects/:id/stats', ({ u, params }) => {
    const { p } = getProject(u, params.id);
    const is = db.issues.filter((i) => i.projectId === p.id);
    const byStatus = {}; p.workflow.statuses.forEach((s) => { byStatus[s.name] = 0; });
    const byType = {}; TYPES.forEach((t) => { byType[t] = 0; }); const byAssignee = {};
    for (const i of is) { byStatus[i.status] = (byStatus[i.status] || 0) + 1; byType[i.type]++; const a = i.assigneeId ? userById(i.assigneeId)?.username ?? i.assigneeId : 'unassigned'; byAssignee[a] = (byAssignee[a] || 0) + 1; }
    const times = [];
    for (const i of is.filter((x) => x.resolvedAt)) {
      const sh = db.history.filter((h) => h.issueId === i.id && h.field === 'status' && catOf(p, h.to) === 'started').sort((a, b) => a.at < b.at ? -1 : 1)[0];
      const start = sh ? sh.at : (catOf(p, i.status) === 'started' ? i.createdAt : null);
      if (start) times.push((Date.parse(i.resolvedAt) - Date.parse(start)) / 3600000);
    }
    return [200, { total: is.length, byStatus, byType, byAssignee, avgCycleTimeHours: times.length ? times.reduce((a, b) => a + b, 0) / times.length : null, averageCycleTimeHours: times.length ? times.reduce((a, b) => a + b, 0) / times.length : null }];
  });

  // search
  function parseQuery(q) {
    const terms = []; let i = 0;
    while (i < q.length) {
      if (/\s/.test(q[i])) { i++; continue; }
      let neg = false; if (q[i] === '-') { neg = true; i++; if (i >= q.length || /\s/.test(q[i])) throw bad('dangling -'); }
      let field = null;
      const m = /^([a-z]+):/.exec(q.slice(i));
      if (m) { field = m[1]; i += m[0].length; }
      let val;
      if (q[i] === '"') { const e = q.indexOf('"', i + 1); if (e < 0) throw bad('unterminated quote'); val = q.slice(i + 1, e); i = e + 1; if (i < q.length && !/\s/.test(q[i])) throw bad('malformed query'); }
      else { let e = i; while (e < q.length && !/\s/.test(q[e])) { if (q[e] === '"') throw bad('malformed query'); e++; } val = q.slice(i, e); i = e; }
      if (field && !val) throw bad('empty value for ' + field);
      if (field && !['status', 'type', 'priority', 'assignee', 'label', 'sprint', 'is', 'due', 'points', 'key'].includes(field)) throw bad('unknown field ' + field);
      terms.push({ neg, field, val });
    }
    return terms;
  }
  function cmp(val, a, isNum) {
    const m = /^(<=|>=|<|>|=)?(.*)$/.exec(val); const op = m[1] || '='; let b = m[2];
    if (isNum) { b = Number(b); if (b === '' || isNaN(b)) throw bad('invalid number'); if (a === null || a === undefined) return false; }
    else { if (!isDate(b)) throw bad('invalid date'); if (!a) return false; }
    return op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : op === '>=' ? a >= b : a === b;
  }
  R('GET', '/api/search', ({ u, query }) => {
    const terms = parseQuery(query.get('q') || '');
    const sort = query.get('sort') || 'updated';
    if (!['updated', 'created', 'priority'].includes(sort)) throw bad('invalid sort');
    const proj = query.get('project');
    const vis = db.projects.filter((p) => projRole(u, p) && (!proj || p.id === proj || p.key === proj));
    const lc = (s) => String(s ?? '').toLowerCase();
    // validate eagerly
    for (const t of terms) { if (t.field === 'due') cmp(t.val, '2000-01-01', false); if (t.field === 'points') cmp(t.val, 0, true); if (t.field === 'is' && !['open', 'resolved'].includes(t.val)) throw bad('is: open|resolved'); }
    const res = [];
    for (const p of vis) for (const i of db.issues.filter((x) => x.projectId === p.id)) {
      const ok = terms.every((t) => {
        let r;
        switch (t.field) {
          case 'status': r = lc(i.status) === lc(t.val); break;
          case 'type': r = i.type === lc(t.val); break;
          case 'priority': r = i.priority === lc(t.val); break;
          case 'assignee': r = t.val === 'none' ? !i.assigneeId : t.val === 'me' ? i.assigneeId === u.id : lc(userById(i.assigneeId)?.username) === lc(t.val); break;
          case 'label': r = i.labels.some((l) => lc(l) === lc(t.val)); break;
          case 'sprint': { const sp = db.sprints.find((s) => s.id === i.sprintId); r = t.val === 'none' ? !i.sprintId : t.val === 'active' ? sp?.state === 'active' : (i.sprintId === t.val || lc(sp?.name) === lc(t.val)); break; }
          case 'is': r = (catOf(p, i.status) === 'completed') === (t.val === 'resolved'); break;
          case 'due': r = cmp(t.val, i.dueDate, false); break;
          case 'points': r = cmp(t.val, i.storyPoints, true); break;
          case 'key': r = lc(i.key) === lc(t.val); break;
          default: r = lc(i.title).includes(lc(t.val)) || lc(i.description).includes(lc(t.val));
        }
        return t.neg ? !r : r;
      });
      if (ok) res.push(i);
    }
    const pr = (i) => PRIOS.indexOf(i.priority);
    if (sort === 'updated') res.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
    else if (sort === 'created') res.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    else res.sort((a, b) => pr(a) - pr(b));
    return [200, res.map(outIssue)];
  });

  // csv
  const COLS = ['key', 'type', 'title', 'status', 'priority', 'assignee', 'labels', 'storyPoints', 'parent', 'epic', 'sprint', 'dueDate', 'createdAt', 'resolvedAt'];
  const csvCell = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  function parseCsv(text) {
    const rows = []; let row = [], cell = '', q = false, line = 1, rowLine = 1, i = 0, started = false;
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    while (i < text.length) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else { if (c === '\n') line++; cell += c; } }
      else if (c === '"' && cell === '') { q = true; started = true; }
      else if (c === ',') { row.push(cell); cell = ''; started = true; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { if (started || cell !== '' || row.length) { row.push(cell); rows.push({ line: rowLine, cells: row }); } row = []; cell = ''; started = false; line++; rowLine = line; }
      else { cell += c; started = true; }
      i++;
    }
    if (q) throw bad('unterminated quoted field');
    if (started || cell !== '' || row.length) { row.push(cell); rows.push({ line: rowLine, cells: row }); }
    return rows;
  }
  R('GET', '/api/projects/:id/export.csv', ({ u, params }) => {
    const { p } = getProject(u, params.id);
    const lines = [COLS.join(',')];
    for (const i of db.issues.filter((x) => x.projectId === p.id)) {
      lines.push([i.key, i.type, i.title, i.status, i.priority, userById(i.assigneeId)?.username ?? '', i.labels.join(';'), i.storyPoints ?? '', issueById(i.parentId)?.key ?? '', issueById(i.epicId)?.key ?? '', db.sprints.find((s) => s.id === i.sprintId)?.name ?? '', i.dueDate ?? '', i.createdAt, i.resolvedAt ?? ''].map(csvCell).join(','));
    }
    return [200, lines.join('\r\n') + '\r\n', 'text/csv; charset=utf-8'];
  });
  R('POST', '/api/projects/:id/import.csv', ({ u, params, rawBody }) => {
    const { p } = getProject(u, params.id, 'write');
    const rows = parseCsv(rawBody || '');
    if (!rows.length) throw bad('empty csv');
    const head = rows[0].cells.map((h) => h.trim());
    if (!head.includes('title')) throw bad('missing title column');
    const errors = []; let created = 0;
    for (const r of rows.slice(1)) {
      const g = {}; head.forEach((h, k) => { g[h] = (r.cells[k] ?? '').trim(); });
      try {
        const b = { type: g.type || 'task', title: g.title };
        if (!g.title) throw new Error('title required');
        if (g.status) b.status = g.status;
        if (g.priority) b.priority = g.priority;
        if (g.assignee) { const au = userByName(g.assignee); if (!au) throw new Error('unknown assignee ' + g.assignee); b.assigneeId = au.id; }
        if (g.labels) b.labels = g.labels.split(';').map((s) => s.trim()).filter(Boolean);
        if (g.storyPoints) { const n = Number(g.storyPoints); if (isNaN(n)) throw new Error('invalid storyPoints'); b.storyPoints = n; }
        if (g.parent) { const pi = db.issues.find((i) => i.projectId === p.id && i.key === g.parent); if (!pi) throw new Error('unknown parent ' + g.parent); b.parentId = pi.id; }
        if (g.epic) { const ei = db.issues.find((i) => i.projectId === p.id && i.key === g.epic); if (!ei) throw new Error('unknown epic ' + g.epic); b.epicId = ei.id; }
        if (g.sprint) { const sp = db.sprints.find((s) => s.projectId === p.id && (s.name === g.sprint || s.id === g.sprint)); if (!sp) throw new Error('unknown sprint ' + g.sprint); b.sprintId = sp.id; }
        if (g.dueDate) b.dueDate = g.dueDate;
        createIssue(p, u.id, b); created++;
      } catch (e) { errors.push({ line: r.line, message: e.message }); }
    }
    return [200, { created, errors }];
  });
  // webhooks
  const outHook = (w) => ({ id: w.id, projectId: w.projectId, url: w.url, events: w.events, createdAt: w.createdAt });
  R('POST', '/api/projects/:id/webhooks', ({ u, params, body }) => {
    const { p } = getProject(u, params.id, 'lead');
    let ok = false; try { const x = new URL(body.url); ok = x.protocol === 'http:' || x.protocol === 'https:'; } catch { /* */ }
    if (!ok) throw bad('invalid url');
    if (!Array.isArray(body.events) || !body.events.length || body.events.some((e) => !EVENTS.includes(e))) throw bad('invalid events');
    if (!isStr(body.secret) || !body.secret) throw bad('secret required');
    const w = { id: uid(), projectId: p.id, url: body.url, events: [...new Set(body.events)], secret: body.secret, createdAt: iso() };
    db.webhooks.push(w); audit(p.workspaceId, u.id, 'webhook.created', w.id, { project: p.key, url: w.url });
    return [201, outHook(w)];
  });
  R('GET', '/api/projects/:id/webhooks', ({ u, params }) => { const { p } = getProject(u, params.id, 'lead'); return [200, db.webhooks.filter((w) => w.projectId === p.id).map(outHook)]; });
  const getHook = (u, id) => { const w = db.webhooks.find((x) => x.id === id); if (!w) throw notFound('webhook not found'); const { p } = getProject(u, w.projectId, 'lead'); return { w, p }; };
  R('DELETE', '/api/webhooks/:id', ({ u, params }) => { const { w, p } = getHook(u, params.id); db.webhooks = db.webhooks.filter((x) => x !== w); audit(p.workspaceId, u.id, 'webhook.deleted', w.id, { project: p.key }); return [204]; });
  R('GET', '/api/webhooks/:id/deliveries', ({ u, params }) => { const { w } = getHook(u, params.id); return [200, db.deliveries.filter((d) => d.webhookId === w.id).map(({ id, event, status, attempts, lastError, at }) => ({ id, event, status, attempts, lastError, at }))]; });

  // ---------- server ----------
  const MIME = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml' };
  function sendStatic(res, rel) {
    const f = path.normalize(path.join(STATIC_DIR, rel));
    if (!f.startsWith(STATIC_DIR) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'not_found', message: 'not found' })); }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  }
  const send = (res, status, data, ctype) => {
    if (status === 204) { res.writeHead(204); return res.end(); }
    const out = typeof data === 'string' ? data : JSON.stringify(data);
    res.writeHead(status, { 'content-type': ctype || 'application/json; charset=utf-8' }); res.end(out);
  };

  const server = http.createServer((req, res) => {
    const chunks = []; let size = 0; let aborted = false;
    req.on('data', (c) => { size += c.length; if (size > 5e6) { aborted = true; send(res, 413, { error: 'payload_too_large', message: 'too large' }); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (aborted) return;
      try {
        const url = new URL(req.url, 'http://x');
        if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return sendStatic(res, 'index.html');
        if (req.method === 'GET' && url.pathname.startsWith('/static/')) return sendStatic(res, decodeURIComponent(url.pathname.slice(8)));
        let match = null, params = {}; let pathHit = false;
        for (const r of routes) { const m = r.re.exec(url.pathname); if (m) { pathHit = true; if (r.m === req.method) { match = r; params = { ...m.groups }; break; } } }
        if (!match) throw pathHit ? new HttpError(405, 'method_not_allowed', 'method not allowed') : notFound('route not found');
        let u = null, tokenHash = null;
        if (match.auth) {
          const h = req.headers.authorization || '';
          const mm = /^Bearer\s+(\S+)$/i.exec(h);
          if (!mm) throw new HttpError(401, 'unauthorized', 'authentication required');
          tokenHash = sha(mm[1]);
          const s = db.sessions.find((x) => x.hash === tokenHash) || db.apiTokens.find((x) => x.hash === tokenHash);
          u = s && userById(s.userId);
          if (!u) throw new HttpError(401, 'unauthorized', 'invalid token');
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        let body = {};
        const ct = req.headers['content-type'] || '';
        const isCsv = /import\.csv$/.test(url.pathname);
        if (!isCsv && raw.trim() && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
          try { body = JSON.parse(raw); } catch { throw bad('invalid JSON'); }
          if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('body must be an object');
        }
        const [status, data, ctype] = match.fn({ req, u, tokenHash, params, body, rawBody: raw, query: url.searchParams, ct });
        if (req.method !== 'GET') save();
        send(res, status, data, ctype);
      } catch (e) {
        if (e instanceof HttpError) { try { if (req.method !== 'GET') save(); } catch { /* */ } return send(res, e.status, { error: e.error, message: e.message }); }
        console.error(e); send(res, 500, { error: 'internal_error', message: 'internal error' });
      }
    });
  });
  return server;
}
