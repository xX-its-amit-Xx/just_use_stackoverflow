import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toCsv, parseCsv } from './csv.js';
import { parseQuery, compile, QueryError } from './search.js';

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');
const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIOS = ['urgent', 'high', 'medium', 'low', 'none'];
const LINK_TYPES = ['blocks', 'relates', 'duplicates'];
const INVERSE = { blocks: 'blocked_by', duplicates: 'duplicated_by', relates: 'relates' };
const CATS = ['backlog', 'unstarted', 'started', 'completed'];
const PROLE = { viewer: 1, developer: 2, lead: 3 };
const EVENTS = ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'];
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

class HttpError extends Error { constructor(status, error, message) { super(message); this.status = status; this.error = error; } }
const bad = m => new HttpError(400, 'validation_error', m);
const notFound = (m = 'not found') => new HttpError(404, 'not_found', m);
const forbidden = (m = 'forbidden') => new HttpError(403, 'forbidden', m);
const conflict = (m, code = 'conflict') => new HttpError(409, code, m);
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const isStr = (v, min = 1, max = 1000) => typeof v === 'string' && v.trim().length >= min && v.length <= max;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function hashPw(pw) { const salt = crypto.randomBytes(16).toString('hex'); return `${salt}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`; }
function checkPw(pw, stored) { const [salt, h] = stored.split(':'); const a = crypto.scryptSync(pw, salt, 32); return crypto.timingSafeEqual(a, Buffer.from(h, 'hex')); }

export function createServer({ dataFile, clock } = {}) {
  const emptyDb = () => ({ seq: 0, users: [], sessions: [], tokens: [], workspaces: [], projects: [], issues: [], links: [], comments: [], sprints: [], notifications: [], webhooks: [], deliveries: [], audit: [] });
  let db = emptyDb();
  if (dataFile && fs.existsSync(dataFile)) { try { db = { ...emptyDb(), ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) }; } catch { /* ignore */ } }
  const save = () => { if (!dataFile) return; const tmp = dataFile + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, dataFile); };
  const nowD = () => (clock ? clock() : new Date());
  const now = () => nowD().toISOString();
  const id = () => crypto.randomUUID();
  const attempts = new Map(); // login rate limit

  // ---------- serializers ----------
  const pubUser = u => ({ id: u.id, username: u.username, displayName: u.displayName, createdAt: u.createdAt });
  const userById = i => db.users.find(u => u.id === i);
  const userByName = n => db.users.find(u => u.username.toLowerCase() === String(n).toLowerCase());
  const pubWs = ws => ({ id: ws.id, name: ws.name, key: ws.key, createdAt: ws.createdAt, members: ws.members.map(m => ({ userId: m.userId, username: userById(m.userId)?.username, role: m.role })) });
  const pubProject = p => ({ id: p.id, workspaceId: p.workspaceId, name: p.name, key: p.key, workflow: p.workflow, members: p.members, createdAt: p.createdAt });
  const issueByKey = k => db.issues.find(i => i.key === k);
  const issueById = i => db.issues.find(x => x.id === i);
  const projectById = i => db.projects.find(p => p.id === i || p.key === i);
  const wsById = i => db.workspaces.find(w => w.id === i);
  function pubIssue(i, detail) {
    const { history, seq, ...o } = i;
    if (!detail) return o;
    const p = projectById(i.projectId);
    o.children = db.issues.filter(c => c.parentId === i.id).map(c => c.key);
    o.links = db.links.filter(l => l.sourceId === i.id || l.targetId === i.id).map(l => {
      const out = l.sourceId === i.id; const other = issueById(out ? l.targetId : l.sourceId);
      return { id: l.id, type: out ? l.type : INVERSE[l.type], target: other?.key, targetTitle: other?.title };
    });
    o.parentKey = i.parentId ? issueById(i.parentId)?.key : null;
    if (i.type === 'epic') {
      const m = db.issues.filter(x => x.epicId === i.id);
      o.progress = { total: m.length, done: m.filter(x => x.resolvedAt).length, points_total: m.reduce((s, x) => s + (x.storyPoints || 0), 0), points_done: m.filter(x => x.resolvedAt).reduce((s, x) => s + (x.storyPoints || 0), 0) };
    }
    void p; return o;
  }

  // ---------- access ----------
  function wsRole(user, ws) { return ws.members.find(m => m.userId === user.id)?.role || null; }
  function projRole(user, p) {
    const ws = wsById(p.workspaceId); const m = ws && ws.members.find(x => x.userId === user.id);
    if (!m) return null; if (m.role === 'admin') return 'lead';
    const pm = p.members.find(x => x.userId === user.id); if (pm) return pm.role;
    return m.role === 'member' ? 'developer' : null;
  }
  function getWs(user, wid, admin) {
    const ws = wsById(wid); const r = ws && wsRole(user, ws); if (!r) throw notFound('workspace not found');
    if (admin && r !== 'admin') throw forbidden('admin only'); return ws;
  }
  function getProject(user, pid, min = 'viewer') {
    const p = projectById(pid); const r = p && projRole(user, p); if (!r) throw notFound('project not found');
    if (PROLE[r] < PROLE[min]) throw forbidden('insufficient project role'); return { p, role: r };
  }
  function getIssue(user, key, min = 'viewer') {
    const i = issueByKey(key); if (!i) throw notFound('issue not found');
    const { p, role } = getProject(user, i.projectId, min); return { i, p, role };
  }
  const audit = (wsId, actorId, action, details) => db.audit.push({ id: id(), workspaceId: wsId, actorId, action, details, at: now() });

  // ---------- history / issues ----------
  function setField(issue, field, value, actorId, at, extra) {
    const from = issue[field] ?? null; const to = value ?? null;
    if (same(from, to)) return false;
    issue[field] = value ?? null; issue.history.push({ field, from, to, actorId, at, ...extra }); return true;
  }
  function applyStatus(issue, p, status, actorId, at, record = true) {
    const cat = p.workflow.statuses.find(s => s.name === status)?.category;
    if (record) setField(issue, 'status', status, actorId, at); else issue.status = status;
    if (cat === 'completed') { if (!issue.resolvedAt) record ? setField(issue, 'resolvedAt', at, actorId, at) : (issue.resolvedAt = at); }
    else if (issue.resolvedAt) record ? setField(issue, 'resolvedAt', null, actorId, at) : (issue.resolvedAt = null);
  }
  function watch(issue, uid) { if (uid && !issue.watchers.includes(uid)) issue.watchers.push(uid); }
  function notify(issue, p, type, actorId, uids, at) {
    for (const uid of new Set(uids)) {
      if (uid === actorId) continue; const u = userById(uid); if (!u || !projRole(u, p)) continue;
      db.notifications.push({ id: id(), userId: uid, type, issueKey: issue.key, actorId, at, read: false });
    }
  }
  function validateIssueFields(p, d, cur) {
    const o = {};
    if ('title' in d) { if (!isStr(d.title, 1, 300)) throw bad('title required'); o.title = d.title.trim(); }
    if ('description' in d) { if (d.description != null && typeof d.description !== 'string') throw bad('bad description'); o.description = d.description ?? ''; }
    if ('type' in d) { if (!TYPES.includes(d.type)) throw bad('bad type'); o.type = d.type; }
    if ('priority' in d) { if (!PRIOS.includes(d.priority)) throw bad('bad priority'); o.priority = d.priority; }
    if ('assigneeId' in d) {
      if (d.assigneeId != null) { const u = userById(d.assigneeId); if (!u || !projRole(u, p)) throw bad('invalid assignee'); } o.assigneeId = d.assigneeId ?? null;
    }
    if ('labels' in d) { if (!Array.isArray(d.labels) || d.labels.some(l => !isStr(l, 1, 100))) throw bad('bad labels'); o.labels = [...new Set(d.labels)]; }
    if ('storyPoints' in d) { if (d.storyPoints != null && (typeof d.storyPoints !== 'number' || !(d.storyPoints >= 0))) throw bad('bad storyPoints'); o.storyPoints = d.storyPoints ?? null; }
    if ('dueDate' in d) { if (d.dueDate != null && (typeof d.dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(d.dueDate) || isNaN(Date.parse(d.dueDate)))) throw bad('bad dueDate'); o.dueDate = d.dueDate ?? null; }
    if ('sprintId' in d) {
      if (d.sprintId != null) { const s = db.sprints.find(x => x.id === d.sprintId && x.projectId === p.id); if (!s) throw bad('invalid sprint'); if (s.state === 'completed') throw bad('sprint completed'); } o.sprintId = d.sprintId ?? null;
    }
    const type = o.type ?? cur?.type ?? 'task';
    const parentId = 'parentId' in d ? d.parentId ?? null : cur?.parentId ?? null;
    const epicId = 'epicId' in d ? d.epicId ?? null : cur?.epicId ?? null;
    if (parentId) {
      const par = issueById(parentId) || issueByKey(parentId);
      if (!par || par.projectId !== p.id) throw bad('invalid parent'); if (par.type === 'subtask') throw bad('parent cannot be a subtask');
      if (cur && par.id === cur.id) throw bad('parent cannot be self');
      if (type !== 'subtask') throw bad('only subtasks can have parents'); o.parentId = par.id;
    } else { if (type === 'subtask') throw bad('subtask requires parentId'); if ('parentId' in d || cur?.parentId) o.parentId = null; }
    if (epicId) {
      const e = issueById(epicId) || issueByKey(epicId);
      if (!e || e.projectId !== p.id || e.type !== 'epic') throw bad('epicId must reference an epic'); o.epicId = e.id;
    } else if ('epicId' in d) o.epicId = null;
    if (type === 'epic' && (o.parentId || cur?.parentId)) throw bad('epics cannot have parents');
    return o;
  }
  function createIssue(p, d, actorId, at) {
    if (!d || typeof d !== 'object') throw bad('body required');
    if (!('title' in d)) throw bad('title required');
    const type = d.type ?? 'task';
    const o = validateIssueFields(p, { ...d, type }, null);
    let status = p.workflow.statuses.find(s => s.category === 'unstarted')?.name ?? p.workflow.statuses[0].name;
    if (d.status != null) { if (!p.workflow.statuses.some(s => s.name === d.status)) throw bad('unknown status'); status = d.status; }
    p.counter = (p.counter || 0) + 1;
    const issue = { id: id(), key: `${p.key}-${p.counter}`, projectId: p.id, type, title: o.title, description: o.description ?? '', status, priority: o.priority ?? 'none', assigneeId: o.assigneeId ?? null, reporterId: actorId, labels: o.labels ?? [], storyPoints: o.storyPoints ?? null, parentId: o.parentId ?? null, epicId: o.epicId ?? null, sprintId: o.sprintId ?? null, dueDate: o.dueDate ?? null, watchers: [], createdAt: at, updatedAt: at, resolvedAt: null, history: [], seq: ++db.seq };
    applyStatus(issue, p, status, actorId, at, false);
    watch(issue, actorId); watch(issue, issue.assigneeId);
    db.issues.push(issue);
    if (issue.assigneeId) notify(issue, p, 'assigned', actorId, [issue.assigneeId], at);
    return issue;
  }

  // ---------- webhooks ----------
  function emit(p, event, issue, actorId, at, extra) {
    for (const wh of db.webhooks.filter(w => w.projectId === p.id && w.events.includes(event))) {
      const body = JSON.stringify({ event, issue: pubIssue(issue), actorId, at, ...extra });
      const d = { id: id(), webhookId: wh.id, event, status: 'pending', attempts: 0, lastError: null, createdAt: at };
      db.deliveries.push(d);
      (async () => {
        const sig = 'sha256=' + crypto.createHmac('sha256', wh.secret).update(body).digest('hex');
        for (let a = 1; a <= 3; a++) {
          d.attempts = a;
          try {
            const r = await fetch(wh.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pm-signature': sig, 'x-pm-event': event }, body, signal: AbortSignal.timeout(5000) });
            d.httpStatus = r.status; if (r.ok) { d.status = 'success'; d.lastError = null; break; }
            d.lastError = `HTTP ${r.status}`;
          } catch (e) { d.lastError = String(e.message || e); }
          d.status = 'failed'; if (a < 3) await new Promise(r => setTimeout(r, 50 * a));
        }
        save();
      })();
    }
  }

  // ---------- routing ----------
  const routes = [];
  const route = (method, pat, h, auth = true) => {
    const keys = []; const re = new RegExp('^' + pat.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, h, auth });
  };
  const body = c => { if (!c.body || typeof c.body !== 'object' || Array.isArray(c.body)) throw bad('JSON object body required'); return c.body; };

  // --- auth
  route('POST', '/api/auth/register', c => {
    const b = body(c);
    if (!isStr(b.username, 3, 32) || !/^[A-Za-z0-9_.-]+$/.test(b.username)) throw bad('username must be 3-32 chars [A-Za-z0-9_.-]');
    if (!isStr(b.password, 8, 200)) throw bad('password must be at least 8 characters');
    if (b.displayName != null && !isStr(b.displayName, 1, 100)) throw bad('bad displayName');
    if (userByName(b.username)) throw conflict('username taken');
    const u = { id: id(), username: b.username, displayName: b.displayName || b.username, passwordHash: hashPw(b.password), createdAt: now() };
    db.users.push(u); return [201, pubUser(u)];
  }, false);
  route('POST', '/api/auth/login', c => {
    const b = body(c); const k = String(b.username).toLowerCase(); const t = Date.now();
    const rec = (attempts.get(k) || []).filter(x => t - x < 60000);
    if (rec.length >= 5) { attempts.set(k, rec); throw new HttpError(429, 'rate_limited', 'too many failed attempts'); }
    const u = typeof b.username === 'string' && typeof b.password === 'string' ? userByName(b.username) : null;
    if (!u || !checkPw(b.password, u.passwordHash)) { rec.push(t); attempts.set(k, rec); throw new HttpError(401, 'unauthorized', 'invalid credentials'); }
    attempts.delete(k);
    const token = crypto.randomBytes(32).toString('hex'); db.sessions.push({ hash: sha(token), userId: u.id, createdAt: now() });
    return [200, { token, user: pubUser(u) }];
  }, false);
  route('POST', '/api/auth/logout', c => { db.sessions = db.sessions.filter(s => s.hash !== c.tokenHash); return [204]; });
  route('GET', '/api/auth/me', c => [200, pubUser(c.user)]);
  route('PATCH', '/api/auth/me', c => {
    const b = body(c);
    if ('displayName' in b) { if (!isStr(b.displayName, 1, 100)) throw bad('bad displayName'); c.user.displayName = b.displayName; }
    if ('password' in b) {
      if (!isStr(b.password, 8, 200)) throw bad('password must be at least 8 characters');
      if (typeof b.currentPassword !== 'string' || !checkPw(b.currentPassword, c.user.passwordHash)) throw forbidden('current password incorrect');
      c.user.passwordHash = hashPw(b.password);
    }
    return [200, pubUser(c.user)];
  });
  // --- tokens
  const auditUser = (u, action, details) => db.workspaces.filter(w => wsRole(u, w)).forEach(w => audit(w.id, u.id, action, details));
  route('POST', '/api/tokens', c => {
    const b = body(c); if (!isStr(b.name, 1, 100)) throw bad('name required');
    const token = 'pmt_' + crypto.randomBytes(24).toString('hex'); const t = { id: id(), userId: c.user.id, name: b.name, hash: sha(token), createdAt: now() };
    db.tokens.push(t); auditUser(c.user, 'token.created', { tokenId: t.id, name: t.name }); return [201, { id: t.id, name: t.name, token }];
  });
  route('GET', '/api/tokens', c => [200, db.tokens.filter(t => t.userId === c.user.id).map(t => ({ id: t.id, name: t.name, createdAt: t.createdAt }))]);
  route('DELETE', '/api/tokens/:id', c => {
    const t = db.tokens.find(x => x.id === c.params.id && x.userId === c.user.id); if (!t) throw notFound();
    db.tokens = db.tokens.filter(x => x !== t); auditUser(c.user, 'token.deleted', { tokenId: t.id, name: t.name }); return [204];
  });
  // --- workspaces
  route('POST', '/api/workspaces', c => {
    const b = body(c); if (!isStr(b.name, 1, 100)) throw bad('name required');
    if (typeof b.key !== 'string' || !/^[A-Z]{2,10}$/.test(b.key)) throw bad('key must be 2-10 uppercase letters');
    if (db.workspaces.some(w => w.key === b.key)) throw conflict('workspace key taken');
    const ws = { id: id(), name: b.name.trim(), key: b.key, createdAt: now(), members: [{ userId: c.user.id, role: 'admin' }] };
    db.workspaces.push(ws); audit(ws.id, c.user.id, 'workspace.created', { key: ws.key }); return [201, pubWs(ws)];
  });
  route('GET', '/api/workspaces', c => [200, db.workspaces.filter(w => wsRole(c.user, w)).map(pubWs)]);
  route('GET', '/api/workspaces/:id', c => [200, pubWs(getWs(c.user, c.params.id))]);
  route('POST', '/api/workspaces/:id/members', c => {
    const ws = getWs(c.user, c.params.id, true); const b = body(c);
    if (!['admin', 'member', 'guest'].includes(b.role)) throw bad('bad role');
    const u = typeof b.username === 'string' && userByName(b.username); if (!u) throw bad('unknown user');
    if (ws.members.some(m => m.userId === u.id)) throw conflict('already a member');
    ws.members.push({ userId: u.id, role: b.role }); audit(ws.id, c.user.id, 'member.added', { userId: u.id, role: b.role }); return [201, pubWs(ws)];
  });
  const lastAdminCheck = (ws, m) => { if (m.role === 'admin' && ws.members.filter(x => x.role === 'admin').length === 1) throw bad('cannot remove or demote the last admin'); };
  route('PATCH', '/api/workspaces/:id/members/:uid', c => {
    const ws = getWs(c.user, c.params.id, true); const b = body(c); const m = ws.members.find(x => x.userId === c.params.uid); if (!m) throw notFound('member not found');
    if (!['admin', 'member', 'guest'].includes(b.role)) throw bad('bad role');
    if (b.role !== 'admin') lastAdminCheck(ws, m);
    const from = m.role; m.role = b.role; audit(ws.id, c.user.id, 'member.role_changed', { userId: m.userId, from, to: b.role }); return [200, pubWs(ws)];
  });
  route('DELETE', '/api/workspaces/:id/members/:uid', c => {
    const ws = getWs(c.user, c.params.id, true); const m = ws.members.find(x => x.userId === c.params.uid); if (!m) throw notFound('member not found');
    lastAdminCheck(ws, m); ws.members = ws.members.filter(x => x !== m);
    for (const p of db.projects.filter(p => p.workspaceId === ws.id)) p.members = p.members.filter(x => x.userId !== m.userId);
    audit(ws.id, c.user.id, 'member.removed', { userId: m.userId }); return [204];
  });
  route('GET', '/api/workspaces/:id/audit', c => { const ws = getWs(c.user, c.params.id, true); return [200, db.audit.filter(a => a.workspaceId === ws.id).slice().reverse()]; });
  // --- projects
  const defaultWorkflow = () => {
    const names = ['Backlog', 'Todo', 'In Progress', 'In Review', 'Done']; const cats = ['backlog', 'unstarted', 'started', 'started', 'completed'];
    return { statuses: names.map((name, i) => ({ name, category: cats[i] })), transitions: names.flatMap(a => names.filter(b => b !== a).map(b => [a, b])) };
  };
  route('POST', '/api/workspaces/:id/projects', c => {
    const ws = getWs(c.user, c.params.id); if (wsRole(c.user, ws) === 'guest') throw forbidden('guests cannot create projects');
    const b = body(c); if (!isStr(b.name, 1, 100)) throw bad('name required');
    if (typeof b.key !== 'string' || !/^[A-Z]{2,10}$/.test(b.key)) throw bad('key must be 2-10 uppercase letters');
    if (db.projects.some(p => p.key === b.key)) throw conflict('project key taken');
    const p = { id: id(), workspaceId: ws.id, name: b.name.trim(), key: b.key, workflow: defaultWorkflow(), members: [{ userId: c.user.id, role: 'lead' }], counter: 0, createdAt: now() };
    db.projects.push(p); return [201, pubProject(p)];
  });
  route('GET', '/api/workspaces/:id/projects', c => { const ws = getWs(c.user, c.params.id); return [200, db.projects.filter(p => p.workspaceId === ws.id && projRole(c.user, p)).map(pubProject)]; });
  route('GET', '/api/projects/:id', c => [200, pubProject(getProject(c.user, c.params.id).p)]);
  route('POST', '/api/projects/:id/members', c => {
    const { p } = getProject(c.user, c.params.id, 'lead'); const b = body(c);
    if (!PROLE[b.role]) throw bad('bad role'); const u = typeof b.username === 'string' && userByName(b.username);
    if (!u || !wsRole(u, wsById(p.workspaceId))) throw bad('user must be a workspace member');
    const ex = p.members.find(m => m.userId === u.id); if (ex) throw conflict('already a project member');
    p.members.push({ userId: u.id, role: b.role }); audit(p.workspaceId, c.user.id, 'project.member_added', { projectId: p.id, userId: u.id, role: b.role }); return [201, pubProject(p)];
  });
  route('PATCH', '/api/projects/:id/members/:uid', c => {
    const { p } = getProject(c.user, c.params.id, 'lead'); const b = body(c); const m = p.members.find(x => x.userId === c.params.uid); if (!m) throw notFound('member not found');
    if (!PROLE[b.role]) throw bad('bad role'); m.role = b.role; audit(p.workspaceId, c.user.id, 'project.member_role_changed', { projectId: p.id, userId: m.userId, role: b.role }); return [200, pubProject(p)];
  });
  route('DELETE', '/api/projects/:id/members/:uid', c => {
    const { p } = getProject(c.user, c.params.id, 'lead'); const m = p.members.find(x => x.userId === c.params.uid); if (!m) throw notFound('member not found');
    p.members = p.members.filter(x => x !== m); audit(p.workspaceId, c.user.id, 'project.member_removed', { projectId: p.id, userId: m.userId }); return [204];
  });
  route('PUT', '/api/projects/:id/workflow', c => {
    const { p } = getProject(c.user, c.params.id, 'lead'); const b = body(c);
    if (!Array.isArray(b.statuses) || !b.statuses.length) throw bad('statuses required');
    const names = new Set();
    for (const s of b.statuses) { if (!s || !isStr(s.name, 1, 50) || !CATS.includes(s.category)) throw bad('each status needs name and valid category'); if (names.has(s.name)) throw bad('duplicate status'); names.add(s.name); }
    let transitions = b.transitions;
    if (transitions == null) transitions = [...names].flatMap(a => [...names].filter(x => x !== a).map(x => [a, x]));
    if (!Array.isArray(transitions) || transitions.some(t => !Array.isArray(t) || t.length !== 2 || !names.has(t[0]) || !names.has(t[1]))) throw bad('transitions must reference known statuses');
    const remap = b.remap && typeof b.remap === 'object' ? b.remap : {};
    const issues = db.issues.filter(i => i.projectId === p.id);
    for (const old of new Set(issues.map(i => i.status))) if (!names.has(old)) { if (!remap[old] || !names.has(remap[old])) throw bad(`status "${old}" is in use; provide remap`); }
    const at = now();
    p.workflow = { statuses: b.statuses.map(s => ({ name: s.name, category: s.category })), transitions };
    for (const i of issues) { const target = names.has(i.status) ? i.status : remap[i.status]; if (target !== i.status) { applyStatus(i, p, target, c.user.id, at); i.updatedAt = at; } else applyStatus(i, p, i.status, c.user.id, at); }
    audit(p.workspaceId, c.user.id, 'workflow.updated', { projectId: p.id, statuses: p.workflow.statuses.map(s => s.name) });
    return [200, pubProject(p)];
  });
  // --- issues
  route('POST', '/api/projects/:id/issues', c => {
    const { p } = getProject(c.user, c.params.id, 'developer'); const at = now();
    const issue = createIssue(p, body(c), c.user.id, at); emit(p, 'issue.created', issue, c.user.id, at); return [201, pubIssue(issue, true)];
  });
  route('GET', '/api/projects/:id/issues', c => {
    const { p } = getProject(c.user, c.params.id); return [200, db.issues.filter(i => i.projectId === p.id).sort((a, b) => a.seq - b.seq).map(i => pubIssue(i))];
  });
  route('GET', '/api/issues/:key', c => [200, pubIssue(getIssue(c.user, c.params.key).i, true)]);
  route('PATCH', '/api/issues/:key', c => {
    const { i, p } = getIssue(c.user, c.params.key, 'developer'); const d = body(c); const at = now(); const actor = c.user.id;
    for (const k of Object.keys(d)) if (!['title', 'description', 'type', 'status', 'priority', 'assigneeId', 'labels', 'storyPoints', 'parentId', 'epicId', 'sprintId', 'dueDate'].includes(k)) throw bad(`unknown field ${k}`);
    const o = validateIssueFields(p, d, i);
    if (i.type === 'epic' && o.type && o.type !== 'epic') { /* allowed; epic links cleared below */ }
    let newStatus = null;
    if ('status' in d && d.status !== i.status) {
      const st = p.workflow.statuses.find(s => s.name === d.status); if (!st) throw bad('unknown status');
      if (!p.workflow.transitions.some(t => t[0] === i.status && t[1] === d.status)) throw conflict(`transition ${i.status} -> ${d.status} not allowed`, 'invalid_transition');
      if (st.category === 'completed') {
        const blocked = db.links.some(l => l.type === 'blocks' && l.targetId === i.id && !issueById(l.sourceId)?.resolvedAt);
        if (blocked) throw conflict('issue is blocked by an unresolved issue', 'blocked');
      }
      newStatus = d.status;
    }
    const prevAssignee = i.assigneeId; let changed = false;
    for (const [k, v] of Object.entries(o)) changed = setField(i, k, v, actor, at) || changed;
    if (newStatus) { applyStatus(i, p, newStatus, actor, at); changed = true; }
    if (changed) {
      i.updatedAt = at; i.seq = ++db.seq;
      if (i.assigneeId !== prevAssignee && i.assigneeId) { watch(i, i.assigneeId); notify(i, p, 'assigned', actor, [i.assigneeId], at); }
      if (newStatus) notify(i, p, 'status_changed', actor, i.watchers, at);
      emit(p, 'issue.updated', i, actor, at);
    }
    return [200, pubIssue(i, true)];
  });
  route('DELETE', '/api/issues/:key', c => {
    const { i, p } = getIssue(c.user, c.params.key, 'developer'); const at = now();
    const doomed = [i, ...db.issues.filter(x => x.parentId === i.id)]; const ids = new Set(doomed.map(x => x.id));
    db.issues = db.issues.filter(x => !ids.has(x.id)); db.links = db.links.filter(l => !ids.has(l.sourceId) && !ids.has(l.targetId));
    db.comments = db.comments.filter(m => !doomed.some(x => x.key === m.issueKey));
    if (i.type === 'epic') db.issues.filter(x => x.epicId === i.id).forEach(x => { x.epicId = null; });
    for (const x of doomed) emit(p, 'issue.deleted', x, c.user.id, at);
    return [204];
  });
  route('GET', '/api/issues/:key/history', c => { const { i } = getIssue(c.user, c.params.key); return [200, i.history.map(({ field, from, to, actorId, at }) => ({ field, from, to, actorId, at }))]; });
  route('POST', '/api/issues/:key/links', c => {
    const { i, p } = getIssue(c.user, c.params.key, 'developer'); const b = body(c);
    if (!LINK_TYPES.includes(b.type)) throw bad('bad link type');
    const t = typeof b.target === 'string' && issueByKey(b.target); if (!t) throw bad('unknown target');
    if (!projRole(c.user, projectById(t.projectId))) throw bad('unknown target');
    if (t.id === i.id) throw bad('cannot link to self');
    if (db.links.some(l => (l.sourceId === i.id && l.targetId === t.id && l.type === b.type) || (l.sourceId === t.id && l.targetId === i.id && l.type === INVERSE[b.type]) || (b.type === 'relates' && l.type === 'relates' && l.sourceId === t.id && l.targetId === i.id))) throw conflict('link exists');
    const l = { id: id(), type: b.type, sourceId: i.id, targetId: t.id }; db.links.push(l);
    const at = now(); i.updatedAt = at; emit(p, 'issue.updated', i, c.user.id, at);
    return [201, pubIssue(i, true)];
  });
  route('DELETE', '/api/issues/:key/links/:lid', c => {
    const { i } = getIssue(c.user, c.params.key, 'developer'); const l = db.links.find(x => x.id === c.params.lid && (x.sourceId === i.id || x.targetId === i.id)); if (!l) throw notFound('link not found');
    db.links = db.links.filter(x => x !== l); return [204];
  });
  route('POST', '/api/issues/:key/watch', c => { const { i } = getIssue(c.user, c.params.key); watch(i, c.user.id); return [200, pubIssue(i, true)]; });
  route('DELETE', '/api/issues/:key/watch', c => { const { i } = getIssue(c.user, c.params.key); i.watchers = i.watchers.filter(w => w !== c.user.id); return [200, pubIssue(i, true)]; });
  // --- comments
  const pubComment = m => { const { ...o } = m; return o; };
  route('POST', '/api/issues/:key/comments', c => {
    const { i, p } = getIssue(c.user, c.params.key, 'viewer'); const b = body(c);
    if (!isStr(b.body, 1, 10000)) throw bad('body required'); const at = now();
    const m = { id: id(), issueKey: i.key, authorId: c.user.id, body: b.body, edited: false, createdAt: at, updatedAt: at }; db.comments.push(m);
    const mentioned = [...new Set([...b.body.matchAll(/@([A-Za-z0-9_.-]+)/g)].map(x => userByName(x[1])).filter(Boolean).map(u => u.id))];
    const mset = mentioned.filter(uid => uid !== c.user.id && projRole(userById(uid), p));
    notify(i, p, 'mention', c.user.id, mset, at);
    notify(i, p, 'comment', c.user.id, i.watchers.filter(w => !mset.includes(w)), at);
    emit(p, 'comment.created', i, c.user.id, at, { comment: pubComment(m) });
    return [201, pubComment(m)];
  });
  route('GET', '/api/issues/:key/comments', c => { const { i } = getIssue(c.user, c.params.key); return [200, db.comments.filter(m => m.issueKey === i.key).map(pubComment)]; });
  route('PATCH', '/api/comments/:id', c => {
    const m = db.comments.find(x => x.id === c.params.id); if (!m) throw notFound(); getIssue(c.user, m.issueKey);
    if (m.authorId !== c.user.id) throw forbidden('only the author can edit'); const b = body(c); if (!isStr(b.body, 1, 10000)) throw bad('body required');
    m.body = b.body; m.edited = true; m.updatedAt = now(); return [200, pubComment(m)];
  });
  route('DELETE', '/api/comments/:id', c => {
    const m = db.comments.find(x => x.id === c.params.id); if (!m) throw notFound(); const { role } = getIssue(c.user, m.issueKey);
    if (m.authorId !== c.user.id && role !== 'lead') throw forbidden(); db.comments = db.comments.filter(x => x !== m); return [204];
  });
  // --- notifications
  route('GET', '/api/notifications', c => {
    const unread = c.query.get('unread') === 'true';
    return [200, db.notifications.filter(n => n.userId === c.user.id && (!unread || !n.read)).reverse().map(({ userId, ...o }) => o)];
  });
  route('POST', '/api/notifications/read', c => {
    const b = body(c); let n = 0;
    if (b.all !== true && !Array.isArray(b.ids)) throw bad('ids or all required');
    for (const x of db.notifications) if (x.userId === c.user.id && !x.read && (b.all === true || b.ids.includes(x.id))) { x.read = true; n++; }
    return [200, { updated: n }];
  });
  // --- sprints
  const pubSprint = s => ({ ...s });
  const getSprint = (c, min) => { const s = db.sprints.find(x => x.id === c.params.id); if (!s) throw notFound('sprint not found'); const r = getProject(c.user, s.projectId, min); return { s, p: r.p }; };
  const dateOnly = (v, name) => { if (v == null) return null; if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(v) || isNaN(Date.parse(v))) throw bad(`bad ${name}`); return v.slice(0, 10); };
  route('POST', '/api/projects/:id/sprints', c => {
    const { p } = getProject(c.user, c.params.id, 'developer'); const b = body(c); if (!isStr(b.name, 1, 100)) throw bad('name required');
    const startDate = dateOnly(b.startDate, 'startDate'), endDate = dateOnly(b.endDate, 'endDate'); if (startDate && endDate && endDate < startDate) throw bad('endDate before startDate');
    const s = { id: id(), projectId: p.id, name: b.name.trim(), state: 'planned', startDate, endDate, startedAt: null, completedAt: null, snapshot: null, createdAt: now() }; db.sprints.push(s); return [201, pubSprint(s)];
  });
  route('GET', '/api/projects/:id/sprints', c => { const { p } = getProject(c.user, c.params.id); return [200, db.sprints.filter(s => s.projectId === p.id).map(pubSprint)]; });
  route('POST', '/api/sprints/:id/start', c => {
    const { s } = getSprint(c, 'developer'); if (s.state !== 'planned') throw conflict('sprint is not planned');
    if (db.sprints.some(x => x.projectId === s.projectId && x.state === 'active')) throw conflict('another sprint is already active');
    s.state = 'active'; s.startedAt = now(); if (!s.startDate) s.startDate = s.startedAt.slice(0, 10); return [200, pubSprint(s)];
  });
  route('POST', '/api/sprints/:id/complete', c => {
    const { s, p } = getSprint(c, 'developer'); if (s.state !== 'active') throw conflict('sprint is not active');
    const b = c.body && typeof c.body === 'object' ? c.body : {}; const target = b.carryOverTo ?? 'backlog'; let tid = null;
    if (target !== 'backlog') { const t = db.sprints.find(x => x.id === target && x.projectId === s.projectId && x.state !== 'completed' && x.id !== s.id); if (!t) throw bad('invalid carryOverTo'); tid = t.id; }
    const at = now(); const inS = db.issues.filter(i => i.sprintId === s.id);
    const done = inS.filter(i => i.resolvedAt), open = inS.filter(i => !i.resolvedAt);
    s.snapshot = { committedPoints: committed(s), completedPoints: sum(done), completedIssues: done.length, carriedOver: open.length };
    for (const i of open) { setField(i, 'sprintId', tid, c.user.id, at, { carry: true }); i.updatedAt = at; }
    s.state = 'completed'; s.completedAt = at; void p; return [200, pubSprint(s)];
  });
  const sum = list => list.reduce((a, i) => a + (i.storyPoints || 0), 0);
  function fieldAt(i, field, T) {
    const hs = i.history.filter(h => h.field === field); if (!hs.length) return i[field] ?? null;
    let v = hs[0].from; for (const h of hs) if (!h.carry && h.at <= T) v = h.to; return v;
  }
  function membersAt(s, T) { // issues in sprint at time T with points & remaining flag
    return db.issues.filter(i => i.projectId === s.projectId && i.createdAt <= T && fieldAt(i, 'sprintId', T) === s.id)
      .map(i => ({ pts: fieldAt(i, 'storyPoints', T) || 0, done: !!fieldAt(i, 'resolvedAt', T) }));
  }
  function committed(s) { return membersAt(s, s.startedAt || now()).reduce((a, m) => a + m.pts, 0); }
  route('GET', '/api/sprints/:id/report', c => {
    const { s } = getSprint(c); const today = now().slice(0, 10);
    let live;
    if (s.snapshot) live = s.snapshot;
    else { const inS = db.issues.filter(i => i.sprintId === s.id); const done = inS.filter(i => i.resolvedAt); live = { committedPoints: s.startedAt ? committed(s) : sum(inS), completedPoints: sum(done), completedIssues: done.length, carriedOver: 0 }; }
    const burndown = [];
    if (s.startDate && s.state !== 'planned') {
      let last = s.endDate && s.endDate < today ? s.endDate : today; if (s.completedAt && s.completedAt.slice(0, 10) < last) last = s.completedAt.slice(0, 10);
      for (let d = new Date(s.startDate + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= last && burndown.length < 2000; d = new Date(d.getTime() + 86400000)) {
        const day = d.toISOString().slice(0, 10); let T = day + 'T23:59:59.999Z'; if (s.completedAt && s.completedAt < T) T = s.completedAt;
        burndown.push({ date: day, remainingPoints: membersAt(s, T).filter(m => !m.done).reduce((a, m) => a + m.pts, 0) });
      }
    }
    return [200, { ...live, burndown }];
  });
  route('GET', '/api/projects/:id/stats', c => {
    const { p } = getProject(c.user, c.params.id); const is = db.issues.filter(i => i.projectId === p.id);
    const count = f => is.reduce((o, i) => { const k = f(i); o[k] = (o[k] || 0) + 1; return o; }, {});
    const byStatus = count(i => i.status); for (const s of p.workflow.statuses) byStatus[s.name] ??= 0;
    const byType = count(i => i.type), byAssignee = count(i => (i.assigneeId ? userById(i.assigneeId)?.username : null) || 'unassigned');
    const cyc = [];
    for (const i of is) if (i.resolvedAt) {
      const started = new Set(p.workflow.statuses.filter(s => s.category === 'started').map(s => s.name));
      const h = i.history.find(x => x.field === 'status' && started.has(x.to)); const st = h ? h.at : (started.has(i.history.find(x => x.field === 'status')?.from ?? i.status) ? i.createdAt : null);
      const from = h ? h.at : st; if (from) cyc.push((Date.parse(i.resolvedAt) - Date.parse(from)) / 3600000);
    }
    const avg = cyc.length ? cyc.reduce((a, b) => a + b, 0) / cyc.length : null;
    return [200, { total: is.length, byStatus, byType, byAssignee, avgCycleTimeHours: avg, averageCycleTimeHours: avg }];
  });
  // --- search
  route('GET', '/api/search', c => {
    const q = c.query.get('q') || ''; let terms; let pred;
    const sort = c.query.get('sort') || 'updated'; if (!['updated', 'created', 'priority'].includes(sort)) throw bad('bad sort');
    try { terms = parseQuery(q); pred = compile(terms, { me: c.user, userByName, sprintState: sid => db.sprints.find(s => s.id === sid)?.state }); } catch (e) { if (e instanceof QueryError) throw bad(e.message); throw e; }
    let pids = null; const pj = c.query.get('project');
    if (pj) pids = [getProject(c.user, pj).p.id];
    const vis = new Map(db.projects.map(p => [p.id, !!projRole(c.user, p)]));
    let r = db.issues.filter(i => vis.get(i.projectId) && (!pids || pids.includes(i.projectId)) && pred(i));
    const pr = i => PRIOS.indexOf(i.priority);
    if (sort === 'updated') r.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.seq - a.seq);
    else if (sort === 'created') r.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || db.issues.indexOf(b) - db.issues.indexOf(a));
    else r.sort((a, b) => pr(a) - pr(b) || b.updatedAt.localeCompare(a.updatedAt));
    return [200, r.map(i => pubIssue(i))];
  });
  // --- csv
  const HEAD = ['key', 'type', 'title', 'status', 'priority', 'assignee', 'labels', 'storyPoints', 'parent', 'epic', 'sprint', 'dueDate', 'createdAt', 'resolvedAt'];
  route('GET', '/api/projects/:id/export.csv', c => {
    const { p } = getProject(c.user, c.params.id);
    const rows = [HEAD, ...db.issues.filter(i => i.projectId === p.id).sort((a, b) => a.seq - b.seq).sort((a, b) => Number(a.key.split('-').pop()) - Number(b.key.split('-').pop())).map(i => [i.key, i.type, i.title, i.status, i.priority, userById(i.assigneeId)?.username ?? '', i.labels.join(';'), i.storyPoints ?? '', issueById(i.parentId)?.key ?? '', issueById(i.epicId)?.key ?? '', db.sprints.find(s => s.id === i.sprintId)?.name ?? '', i.dueDate ?? '', i.createdAt, i.resolvedAt ?? ''])];
    return [200, toCsv(rows), 'text/csv; charset=utf-8'];
  });
  route('POST', '/api/projects/:id/import.csv', c => {
    const { p } = getProject(c.user, c.params.id, 'developer'); let recs;
    try { recs = parseCsv(typeof c.raw === 'string' ? c.raw : ''); } catch (e) { throw bad('malformed CSV: ' + e.message); }
    if (!recs.length) throw bad('empty CSV');
    const head = recs[0].fields.map(h => h.trim()); if (!head.includes('title')) throw bad('header must include title column');
    let created = 0; const errors = []; const at = now(); const keyMap = new Map();
    for (const { line, fields } of recs.slice(1)) {
      try {
        const r = {}; head.forEach((h, k) => { r[h] = (fields[k] ?? '').trim(); });
        if (fields.length > head.length && fields.slice(head.length).some(x => x.trim())) throw new Error('too many columns');
        const d = { title: fields[head.indexOf('title')] ?? '' };
        if (r.type) d.type = r.type; if (r.priority) d.priority = r.priority; if (r.status) d.status = r.status;
        if (r.description) d.description = r.description;
        if (r.assignee) { const u = userByName(r.assignee); if (!u) throw new Error(`unknown assignee ${r.assignee}`); d.assigneeId = u.id; }
        if (r.labels) d.labels = r.labels.split(';').map(x => x.trim()).filter(Boolean);
        if (r.storyPoints) { const n = Number(r.storyPoints); if (isNaN(n)) throw new Error('bad storyPoints'); d.storyPoints = n; }
        if (r.dueDate) d.dueDate = r.dueDate;
        const ref = k => { const x = issueByKey(k); if (!x || x.projectId !== p.id) throw new Error(`unknown issue ${k}`); return x.id; };
        if (r.parent) d.parentId = ref(r.parent); if (r.epic) d.epicId = ref(r.epic);
        if (r.sprint) { const s = db.sprints.find(x => x.projectId === p.id && (x.name === r.sprint || x.id === r.sprint)); if (!s) throw new Error(`unknown sprint ${r.sprint}`); d.sprintId = s.id; }
        const issue = createIssue(p, d, c.user.id, at); created++; keyMap.set(line, issue.key); emit(p, 'issue.created', issue, c.user.id, at);
      } catch (e) { errors.push({ line, message: e.message }); }
    }
    return [200, { created, errors }];
  });
  // --- webhooks
  const pubHook = w => ({ id: w.id, projectId: w.projectId, url: w.url, events: w.events, createdAt: w.createdAt });
  route('POST', '/api/projects/:id/webhooks', c => {
    const { p } = getProject(c.user, c.params.id, 'lead'); const b = body(c);
    if (!isStr(b.url, 1, 2000) || !/^https?:\/\//.test(b.url)) throw bad('url must be http(s)');
    if (!Array.isArray(b.events) || !b.events.length || b.events.some(e => !EVENTS.includes(e))) throw bad('bad events');
    if (!isStr(b.secret, 1, 500)) throw bad('secret required');
    const w = { id: id(), projectId: p.id, url: b.url, events: [...new Set(b.events)], secret: b.secret, createdAt: now() }; db.webhooks.push(w);
    audit(p.workspaceId, c.user.id, 'webhook.created', { webhookId: w.id, url: w.url }); return [201, pubHook(w)];
  });
  route('GET', '/api/projects/:id/webhooks', c => { const { p } = getProject(c.user, c.params.id, 'lead'); return [200, db.webhooks.filter(w => w.projectId === p.id).map(pubHook)]; });
  const getHook = (c, min) => { const w = db.webhooks.find(x => x.id === c.params.id); if (!w) throw notFound('webhook not found'); return { w, p: getProject(c.user, w.projectId, min).p }; };
  route('GET', '/api/webhooks/:id/deliveries', c => { const { w } = getHook(c, 'lead'); return [200, db.deliveries.filter(d => d.webhookId === w.id).map(d => ({ ...d }))]; });
  route('DELETE', '/api/webhooks/:id', c => { const { w, p } = getHook(c, 'lead'); db.webhooks = db.webhooks.filter(x => x !== w); audit(p.workspaceId, c.user.id, 'webhook.deleted', { webhookId: w.id, url: w.url }); return [204]; });

  // ---------- http ----------
  async function readBody(req) { const ch = []; let n = 0; for await (const c of req) { n += c.length; if (n > 5e6) throw new HttpError(413, 'too_large', 'body too large'); ch.push(c); } return Buffer.concat(ch).toString('utf8'); }
  function send(res, status, payload, type = 'application/json; charset=utf-8') {
    const data = status === 204 ? '' : typeof payload === 'string' ? payload : JSON.stringify(payload);
    res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(data), 'cache-control': 'no-store' }); res.end(data);
  }
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x'); const pathname = url.pathname;
      if (req.method === 'GET' && (pathname === '/' || pathname.startsWith('/static/'))) {
        const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(8)); const f = path.normalize(path.join(STATIC_DIR, rel));
        if (!f.startsWith(STATIC_DIR) || !fs.existsSync(f) || !fs.statSync(f).isFile()) throw notFound();
        return send(res, 200, fs.readFileSync(f), MIME[path.extname(f)] || 'application/octet-stream');
      }
      if (!pathname.startsWith('/api/')) throw notFound();
      let match = null, pathOk = false;
      for (const r of routes) { const m = r.re.exec(pathname); if (m) { pathOk = true; if (r.method === req.method) { match = { r, m }; break; } } }
      if (!match) throw pathOk ? new HttpError(405, 'method_not_allowed', 'method not allowed') : notFound('no such route');
      const { r, m } = match; const ctx = { params: {}, query: url.searchParams };
      r.keys.forEach((k, i) => { ctx.params[k] = decodeURIComponent(m[i + 1]); });
      if (r.auth) {
        const h = req.headers.authorization || ''; const tok = /^Bearer (.+)$/i.exec(h)?.[1];
        if (!tok) throw new HttpError(401, 'unauthorized', 'authentication required');
        const hash = sha(tok); const s = db.sessions.find(x => x.hash === hash) || db.tokens.find(x => x.hash === hash);
        const u = s && userById(s.userId); if (!u) throw new HttpError(401, 'unauthorized', 'invalid token');
        ctx.user = u; ctx.tokenHash = hash;
      }
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
        ctx.raw = await readBody(req);
        if (!/csv/.test(req.headers['content-type'] || '')) { if (ctx.raw.trim()) { try { ctx.body = JSON.parse(ctx.raw); } catch { throw bad('invalid JSON'); } } }
        else ctx.body = null;
      }
      const out = r.h(ctx); save();
      send(res, out[0], out[1], out[2]);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.error, message: e.message });
      console.error(e); send(res, 500, { error: 'internal_error', message: 'internal error' });
    }
  });
  return server;
}
