import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseCsv, toCsv } from './csv.js';
import { parseQuery } from './search.js';
import { ApiError } from './errors.js';

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');
const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIOS = ['urgent', 'high', 'medium', 'low', 'none'];
const CATS = ['backlog', 'unstarted', 'started', 'completed'];
const WS_ROLES = ['admin', 'member', 'guest'];
const PROJ_ROLES = ['lead', 'developer', 'viewer'];
const RANK = { viewer: 0, developer: 1, lead: 2 };
const LINK_TYPES = ['blocks', 'relates', 'duplicates'];
const INVERSE = { blocks: 'blocked_by', relates: 'relates', duplicates: 'duplicated_by' };
const EVENTS = ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'];
const TRACKED = ['type', 'title', 'description', 'status', 'priority', 'assigneeId', 'labels', 'storyPoints', 'parentId', 'epicId', 'sprintId', 'dueDate'];

const bad = (m) => new ApiError(400, 'validation_error', m);
const notFound = (m = 'not found') => new ApiError(404, 'not_found', m);
const forbidden = (m = 'forbidden') => new ApiError(403, 'forbidden', m);
const conflict = (m, code = 'conflict') => new ApiError(409, code, m);

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const rid = () => crypto.randomBytes(8).toString('hex');
const isStr = (v) => typeof v === 'string';
const isDate = (v) => isStr(v) && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v + 'T00:00:00Z')) && new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v;

function hashPw(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
}
function checkPw(pw, stored) {
  const [salt, h] = stored.split(':');
  const a = Buffer.from(crypto.scryptSync(pw, salt, 32).toString('hex'));
  return crypto.timingSafeEqual(a, Buffer.from(h));
}
const clean = (o) => {
  if (Array.isArray(o)) return o.map(clean);
  if (o && typeof o === 'object') { const r = {}; for (const k of Object.keys(o)) if (!k.startsWith('_')) r[k] = o[k]; return r; }
  return o;
};

export function createServer({ dataFile, clock } = {}) {
  const now = () => (clock ? clock() : new Date());
  const iso = () => now().toISOString();
  const empty = () => ({ seq: 0, users: [], sessions: {}, tokens: [], workspaces: [], projects: [], issues: [], comments: [], sprints: [], notifications: [], webhooks: [], deliveries: [], audit: [], links: [] });
  let db = empty();
  if (dataFile && fs.existsSync(dataFile)) {
    try { db = { ...empty(), ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) }; } catch { /* ignore */ }
  }
  const save = () => {
    if (!dataFile) return;
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, dataFile);
  };
  const failures = new Map();

  // ---------- lookups ----------
  const user = (id) => db.users.find((u) => u.id === id);
  const userByName = (n) => isStr(n) ? db.users.find((u) => u.username.toLowerCase() === n.toLowerCase()) : undefined;
  const pubUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName, createdAt: u.createdAt });
  const wsOf = (id) => db.workspaces.find((w) => w.id === id);
  const projOf = (id) => db.projects.find((p) => p.id === id);
  const issueById = (id) => db.issues.find((i) => i.id === id);
  const issueByKey = (k) => db.issues.find((i) => i.key === k) || issueById(k);
  const sprintOf = (id) => db.sprints.find((s) => s.id === id);
  const wsRole = (ws, uid) => ws.members.find((m) => m.userId === uid)?.role || null;
  function projRole(p, uid) {
    const ws = wsOf(p.workspaceId); const wr = wsRole(ws, uid);
    if (!wr) return null;
    if (wr === 'admin') return 'lead';
    const pm = p.members.find((m) => m.userId === uid);
    if (wr === 'guest') return pm ? pm.role : null;
    return pm ? pm.role : 'developer';
  }
  function getWs(id, uid, admin) {
    const ws = wsOf(id); if (!ws) throw notFound('workspace not found');
    const r = wsRole(ws, uid); if (!r) throw forbidden('not a workspace member');
    if (admin && r !== 'admin') throw forbidden('admin only');
    return ws;
  }
  function getProj(id, uid, min = 'viewer') {
    const p = projOf(id); if (!p) throw notFound('project not found');
    const r = projRole(p, uid); if (!r) throw forbidden('no access to project');
    if (RANK[r] < RANK[min]) throw forbidden('insufficient role');
    return p;
  }
  function getIssue(key, uid, min = 'viewer') {
    const i = issueByKey(key); if (!i) throw notFound('issue not found');
    const p = getProj(i.projectId, uid, min);
    return [i, p];
  }
  function getSprint(id, uid, min = 'viewer') {
    const s = sprintOf(id); if (!s) throw notFound('sprint not found');
    const p = getProj(s.projectId, uid, min); return [s, p];
  }
  const canSee = (p, uid) => !!projRole(p, uid);
  const catOf = (p, status) => p.workflow.statuses.find((s) => s.name === status)?.category;
  const isDone = (p, i) => catOf(p, i.status) === 'completed';

  // ---------- audit / notifications / webhooks ----------
  function audit(wsId, actorId, action, details = {}) {
    db.audit.push({ id: rid(), workspaceId: wsId, actorId, action, details, at: iso() });
  }
  function notify(issue, p, userIds, type, actorId, extra = {}) {
    for (const uid of new Set(userIds)) {
      if (uid === actorId || !user(uid) || !canSee(p, uid)) continue;
      db.notifications.push({ id: rid(), userId: uid, type, issueKey: issue.key, actorId, at: iso(), read: false, _seq: ++db.seq, ...extra });
    }
  }
  function fire(event, issue, actorId, p, extra) {
    for (const h of db.webhooks) {
      if (h.projectId !== p.id || !h.events.includes(event)) continue;
      const payload = { event, issue: clean(issueOut(issue)), actorId, at: iso(), ...(extra || {}) };
      const d = { id: rid(), webhookId: h.id, event, status: 'pending', attempts: 0, lastError: null, createdAt: iso() };
      db.deliveries.push(d);
      deliver(h, d, JSON.stringify(payload));
    }
  }
  async function deliver(h, d, body) {
    const sig = 'sha256=' + crypto.createHmac('sha256', h.secret).update(body).digest('hex');
    for (let a = 1; a <= 3; a++) {
      d.attempts = a;
      try {
        const r = await fetch(h.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pm-signature': sig }, body, signal: AbortSignal.timeout(5000) });
        if (r.ok) { d.status = 'success'; d.lastError = null; save(); return; }
        d.lastError = `HTTP ${r.status}`;
      } catch (e) { d.lastError = String(e.message || e); }
      d.status = 'failed';
      save();
      if (a < 3) await new Promise((r) => setTimeout(r, 50 * a));
    }
  }

  // ---------- issue helpers ----------
  function issueOut(i) {
    const p = projOf(i.projectId);
    const o = clean({ ...i });
    delete o.history;
    o.children = db.issues.filter((c) => c.parentId === i.id && c.type === 'subtask').map((c) => c.key);
    o.links = db.links.filter((l) => l.from === i.id || l.to === i.id).map((l) => {
      const out = l.from === i.id;
      const other = issueById(out ? l.to : l.from);
      return { id: l.id, type: out ? l.type : INVERSE[l.type], target: other?.key, key: other?.key };
    });
    if (i.type === 'epic') {
      const m = db.issues.filter((c) => c.epicId === i.id);
      o.progress = { total: m.length, done: m.filter((c) => isDone(p, c)).length, points_total: m.reduce((s, c) => s + (c.storyPoints || 0), 0), points_done: m.filter((c) => isDone(p, c)).reduce((s, c) => s + (c.storyPoints || 0), 0) };
    }
    return o;
  }
  function resolveRef(ref, p, what) {
    if (ref === null || ref === undefined || ref === '') return null;
    if (!isStr(ref)) throw bad(`${what} must be a string`);
    const t = issueByKey(ref);
    if (!t || t.projectId !== p.id) throw bad(`${what} not found in project`);
    return t.id;
  }
  // validate & normalise field values; returns normalised partial
  function normFields(d, p, partial) {
    const o = {};
    const has = (k) => Object.prototype.hasOwnProperty.call(d, k);
    if (!partial || has('type')) { const t = has('type') ? d.type : 'task'; if (!TYPES.includes(t)) throw bad('invalid type'); o.type = t; }
    if (!partial || has('title')) { if (!isStr(d.title) || !d.title.trim() || d.title.length > 500) throw bad('title required'); o.title = d.title.trim(); }
    if (has('description')) { if (d.description !== null && !isStr(d.description)) throw bad('invalid description'); o.description = d.description ?? ''; }
    if (has('priority')) { if (!PRIOS.includes(d.priority)) throw bad('invalid priority'); o.priority = d.priority; }
    if (has('labels')) { if (!Array.isArray(d.labels) || d.labels.some((l) => !isStr(l) || !l)) throw bad('invalid labels'); o.labels = [...new Set(d.labels)]; }
    if (has('storyPoints')) { if (d.storyPoints !== null && (typeof d.storyPoints !== 'number' || !isFinite(d.storyPoints) || d.storyPoints < 0)) throw bad('invalid storyPoints'); o.storyPoints = d.storyPoints; }
    if (has('dueDate')) { if (d.dueDate !== null && !isDate(d.dueDate)) throw bad('invalid dueDate'); o.dueDate = d.dueDate; }
    if (has('assigneeId')) {
      if (d.assigneeId !== null) {
        if (!isStr(d.assigneeId) || !user(d.assigneeId) || !canSee(p, d.assigneeId)) throw bad('invalid assignee');
      }
      o.assigneeId = d.assigneeId;
    }
    if (has('status')) { if (!isStr(d.status) || !catOf(p, d.status)) throw bad('invalid status'); o.status = d.status; }
    if (has('parentId')) o.parentId = resolveRef(d.parentId, p, 'parentId');
    if (has('epicId')) o.epicId = resolveRef(d.epicId, p, 'epicId');
    if (has('sprintId')) {
      if (d.sprintId === null) o.sprintId = null;
      else {
        const s = isStr(d.sprintId) && sprintOf(d.sprintId);
        if (!s || s.projectId !== p.id) throw bad('invalid sprintId');
        if (s.state === 'completed') throw bad('sprint is completed');
        o.sprintId = s.id;
      }
    }
    return o;
  }
  function checkRelations(c, p, self) {
    if (c.type === 'subtask') {
      if (!c.parentId) throw bad('subtask requires parentId');
    }
    if (c.parentId) {
      if (c.type === 'epic') throw bad('epics cannot have parents');
      const par = issueById(c.parentId);
      if (!par || par.projectId !== p.id) throw bad('invalid parent');
      if (par.type === 'subtask') throw bad('parent cannot be a subtask');
      if (self && par.id === self.id) throw bad('parent cannot be self');
    }
    if (c.epicId) {
      const e = issueById(c.epicId);
      if (!e || e.type !== 'epic') throw bad('epicId must reference an epic');
    }
  }
  function setStatusSideEffects(i, p, ts) {
    const cat = catOf(p, i.status);
    if (cat === 'completed') { if (!i.resolvedAt) { i.resolvedAt = ts; i._res.push([ts, true]); } }
    else if (i.resolvedAt) { i.resolvedAt = null; i._res.push([ts, false]); }
    if (cat === 'started' && !i._startedAt) i._startedAt = ts;
  }
  function createIssue(p, actor, d, opts = {}) {
    const f = normFields(d, p, false);
    const ts = iso();
    const ini = p.workflow.statuses.find((s) => s.category === 'unstarted') || p.workflow.statuses[0];
    const i = {
      id: rid(), key: `${p.key}-${++p.counter}`, projectId: p.id, type: f.type, title: f.title, description: f.description ?? '',
      status: f.status || ini.name, priority: f.priority || 'none', assigneeId: f.assigneeId ?? null, reporterId: actor,
      labels: f.labels || [], storyPoints: f.storyPoints ?? null, parentId: f.parentId ?? null, epicId: f.epicId ?? null,
      sprintId: f.sprintId ?? null, dueDate: f.dueDate ?? null, watchers: [], createdAt: ts, updatedAt: ts, resolvedAt: null,
      _res: [], _seq: ++db.seq,
    };
    checkRelations(i, p);
    setStatusSideEffects(i, p, ts);
    i.watchers.push(actor);
    if (i.assigneeId && !i.watchers.includes(i.assigneeId)) i.watchers.push(i.assigneeId);
    db.issues.push(i);
    if (i.assigneeId) notify(i, p, [i.assigneeId], 'assigned', actor);
    fire('issue.created', i, actor, p);
    return i;
  }
  function cascadeDelete(i, p, actor) {
    for (const c of db.issues.filter((x) => x.parentId === i.id && x.type === 'subtask')) cascadeDelete(c, p, actor);
    for (const x of db.issues) { if (x.epicId === i.id) x.epicId = null; }
    db.issues = db.issues.filter((x) => x.id !== i.id);
    db.links = db.links.filter((l) => l.from !== i.id && l.to !== i.id);
    db.comments = db.comments.filter((c) => c.issueId !== i.id);
    fire('issue.deleted', i, actor, p);
  }
  function applyIssueChanges(i, p, d, actor) {
    const f = normFields(d, p, true);
    const cand = { ...i, ...f };
    if (f.type || 'parentId' in f || 'epicId' in f) checkRelations(cand, p, i);
    if (f.status && f.status !== i.status) {
      if (!p.workflow.transitions.some(([a, b]) => a === i.status && b === f.status)) throw conflict(`transition ${i.status} -> ${f.status} not allowed`, 'invalid_transition');
      if (catOf(p, f.status) === 'completed') {
        const blocked = db.links.some((l) => l.type === 'blocks' && l.to === i.id && !issueById(l.from)?.resolvedAt);
        if (blocked) throw conflict('issue is blocked by an unresolved issue', 'blocked');
      }
    }
    const ts = iso(); const changes = [];
    for (const k of TRACKED) {
      if (!(k in f)) continue;
      const a = JSON.stringify(i[k]); const b = JSON.stringify(f[k]);
      if (a === b) continue;
      changes.push({ field: k, from: i[k], to: f[k], actorId: actor, at: ts });
      i[k] = f[k];
    }
    if (!changes.length) return [];
    i.history = (i.history || []);
    i.history.push(...changes);
    if (changes.some((c) => c.field === 'status')) setStatusSideEffects(i, p, ts);
    i.updatedAt = ts; i._seq = ++db.seq;
    for (const c of changes) {
      if (c.field === 'assigneeId' && c.to) {
        if (!i.watchers.includes(c.to)) i.watchers.push(c.to);
        notify(i, p, i.watchers, 'assigned', actor);
      }
      if (c.field === 'status') notify(i, p, i.watchers, 'status_changed', actor, { from: c.from, to: c.to });
    }
    fire('issue.updated', i, actor, p);
    return changes;
  }

  // ---------- search ----------
  function runSearch(uid, qs) {
    const terms = parseQuery(qs.get('q') || '');
    const sort = qs.get('sort') || 'updated';
    if (!['updated', 'created', 'priority'].includes(sort)) throw bad('invalid sort');
    let projects = db.projects.filter((p) => canSee(p, uid));
    const pq = qs.get('project');
    if (pq) projects = projects.filter((p) => p.id === pq || p.key === pq);
    const today = iso().slice(0, 10);
    const me = user(uid);
    const out = [];
    for (const p of projects) for (const i of db.issues.filter((x) => x.projectId === p.id)) {
      if (terms.every((t) => matchTerm(t, i, p, me) !== t.neg)) out.push(i);
    }
    const pr = (i) => PRIOS.indexOf(i.priority);
    out.sort((a, b) => sort === 'priority' ? pr(a) - pr(b) || b._seq - a._seq : sort === 'created' ? (b.createdAt.localeCompare(a.createdAt) || b._seq - a._seq) : (b.updatedAt.localeCompare(a.updatedAt) || b._seq - a._seq));
    void today;
    return out.map(issueOut);
  }
  function matchTerm(t, i, p, me) {
    const v = t.value;
    switch (t.field) {
      case null: { const s = v.toLowerCase(); return i.title.toLowerCase().includes(s) || (i.description || '').toLowerCase().includes(s); }
      case 'status': return i.status.toLowerCase() === v.toLowerCase();
      case 'type': return i.type === v;
      case 'priority': return i.priority === v;
      case 'assignee': {
        if (v === 'none') return !i.assigneeId;
        const u = v === 'me' ? me : userByName(v);
        return !!u && i.assigneeId === u.id;
      }
      case 'label': return i.labels.some((l) => l.toLowerCase() === v.toLowerCase());
      case 'sprint': {
        if (v === 'none') return !i.sprintId;
        if (v === 'active') return !!i.sprintId && sprintOf(i.sprintId)?.state === 'active';
        return i.sprintId === v;
      }
      case 'is': return v === 'open' ? !i.resolvedAt : !!i.resolvedAt;
      case 'due': return !!i.dueDate && cmp(i.dueDate, t.op, v);
      case 'points': return i.storyPoints !== null && i.storyPoints !== undefined && cmp(i.storyPoints, t.op, Number(v));
      case 'key': return i.key.toLowerCase() === v.toLowerCase();
      default: return false;
    }
  }
  const cmp = (a, op, b) => op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : op === '>=' ? a >= b : a === b;

  // ---------- sprint reports ----------
  function sprintReport(s, p) {
    const members = db.issues.filter((i) => i.sprintId === s.id);
    const completed = members.filter((i) => isDone(p, i));
    const today = iso().slice(0, 10);
    const burndown = [];
    if (s.startDate) {
      let end = s.endDate && s.endDate < today ? s.endDate : today;
      for (let d = new Date(s.startDate + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= end; d = new Date(d.getTime() + 86400000)) {
        const day = d.toISOString().slice(0, 10);
        const T = day + 'T23:59:59.999Z';
        let rem = 0;
        for (const i of db.issues) {
          if (i.createdAt > T) continue;
          let sp = i.sprintId, pts = i.storyPoints;
          const hist = i.history || [];
          for (let k = hist.length - 1; k >= 0; k--) {
            const h = hist[k]; if (h.at <= T) continue;
            if (h.field === 'sprintId') sp = h.from; else if (h.field === 'storyPoints') pts = h.from;
          }
          if (sp !== s.id) continue;
          let res = false;
          for (const [at, b] of i._res) if (at <= T) res = b;
          if (!res) rem += pts || 0;
        }
        burndown.push({ date: day, remainingPoints: rem });
      }
    }
    const sum = (a) => a.reduce((x, i) => x + (i.storyPoints || 0), 0);
    return {
      committedPoints: s.committedPoints ?? sum(members), completedPoints: sum(completed), completedIssues: completed.length,
      carriedOver: s.carriedOver || 0, burndown,
    };
  }

  // ---------- routes ----------
  const routes = [];
  const R = (method, pattern, fn, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '/?$');
    routes.push({ method, re, keys, fn, auth: opts.auth !== false, raw: opts.raw });
  };
  const out = (status, body) => ({ status, body });

  R('POST', '/api/auth/register', (c) => {
    const { username, password, displayName } = c.body;
    if (!isStr(username) || !/^[A-Za-z0-9_.-]{3,32}$/.test(username)) throw bad('username must be 3-32 chars [A-Za-z0-9_.-]');
    if (!isStr(password) || password.length < 8) throw bad('password must be at least 8 characters');
    if (displayName !== undefined && !isStr(displayName)) throw bad('invalid displayName');
    if (userByName(username)) throw conflict('username taken');
    const u = { id: rid(), username, displayName: displayName || username, passwordHash: hashPw(password), createdAt: iso() };
    db.users.push(u);
    return out(201, pubUser(u));
  }, { auth: false });
  R('POST', '/api/auth/login', (c) => {
    const { username, password } = c.body;
    if (!isStr(username) || !isStr(password)) throw bad('username and password required');
    const k = username.toLowerCase(); const t = Date.now();
    const f = (failures.get(k) || []).filter((x) => t - x < 60000);
    failures.set(k, f);
    if (f.length >= 10) throw new ApiError(429, 'rate_limited', 'too many login attempts');
    const u = userByName(username);
    if (!u || !checkPw(password, u.passwordHash)) { f.push(t); throw new ApiError(401, 'unauthorized', 'invalid credentials'); }
    failures.delete(k);
    const token = crypto.randomBytes(24).toString('hex');
    db.sessions[sha(token)] = u.id;
    return out(200, { token, user: pubUser(u) });
  }, { auth: false });
  R('POST', '/api/auth/logout', (c) => {
    if (c.tokenHash) delete db.sessions[c.tokenHash];
    return out(204);
  });
  R('GET', '/api/auth/me', (c) => out(200, pubUser(c.user)));
  R('PATCH', '/api/auth/me', (c) => {
    const { displayName, password, currentPassword } = c.body;
    if (displayName !== undefined && (!isStr(displayName) || !displayName.trim())) throw bad('invalid displayName');
    if (password !== undefined) {
      if (!isStr(password) || password.length < 8) throw bad('password must be at least 8 characters');
      if (!isStr(currentPassword)) throw bad('currentPassword required');
      if (!checkPw(currentPassword, c.user.passwordHash)) throw forbidden('current password incorrect');
      c.user.passwordHash = hashPw(password);
    }
    if (displayName !== undefined) c.user.displayName = displayName.trim();
    return out(200, pubUser(c.user));
  });

  // tokens
  R('POST', '/api/tokens', (c) => {
    if (!isStr(c.body.name) || !c.body.name.trim()) throw bad('name required');
    const token = 'pm_' + crypto.randomBytes(24).toString('hex');
    const t = { id: rid(), userId: c.user.id, name: c.body.name.trim(), hash: sha(token), createdAt: iso() };
    db.tokens.push(t);
    for (const w of db.workspaces) if (wsRole(w, c.user.id) === 'admin') audit(w.id, c.user.id, 'token.created', { tokenId: t.id, name: t.name });
    return out(201, { id: t.id, name: t.name, token });
  });
  R('GET', '/api/tokens', (c) => out(200, db.tokens.filter((t) => t.userId === c.user.id).map((t) => ({ id: t.id, name: t.name, createdAt: t.createdAt }))));
  R('DELETE', '/api/tokens/:id', (c) => {
    const t = db.tokens.find((x) => x.id === c.params.id && x.userId === c.user.id);
    if (!t) throw notFound('token not found');
    db.tokens = db.tokens.filter((x) => x !== t);
    for (const w of db.workspaces) if (wsRole(w, c.user.id) === 'admin') audit(w.id, c.user.id, 'token.deleted', { tokenId: t.id, name: t.name });
    return out(204);
  });

  // workspaces
  const wsOut = (w) => ({ id: w.id, name: w.name, key: w.key, createdAt: w.createdAt, members: w.members.map((m) => ({ userId: m.userId, username: user(m.userId)?.username, role: m.role })) });
  R('POST', '/api/workspaces', (c) => {
    const { name, key } = c.body;
    if (!isStr(name) || !name.trim()) throw bad('name required');
    if (!isStr(key) || !/^[A-Z]{2,10}$/.test(key)) throw bad('key must be 2-10 uppercase letters');
    if (db.workspaces.some((w) => w.key === key)) throw conflict('workspace key taken');
    const w = { id: rid(), name: name.trim(), key, createdAt: iso(), members: [{ userId: c.user.id, role: 'admin' }] };
    db.workspaces.push(w);
    return out(201, wsOut(w));
  });
  R('GET', '/api/workspaces', (c) => out(200, db.workspaces.filter((w) => wsRole(w, c.user.id)).map(wsOut)));
  R('GET', '/api/workspaces/:id', (c) => out(200, wsOut(getWs(c.params.id, c.user.id))));
  R('GET', '/api/workspaces/:id/members', (c) => out(200, wsOut(getWs(c.params.id, c.user.id)).members));
  R('POST', '/api/workspaces/:id/members', (c) => {
    const ws = getWs(c.params.id, c.user.id, true);
    const u = userByName(c.body.username);
    if (!isStr(c.body.username)) throw bad('username required');
    if (!WS_ROLES.includes(c.body.role)) throw bad('invalid role');
    if (!u) throw notFound('user not found');
    if (wsRole(ws, u.id)) throw conflict('already a member');
    ws.members.push({ userId: u.id, role: c.body.role });
    audit(ws.id, c.user.id, 'member.added', { userId: u.id, role: c.body.role });
    return out(201, { userId: u.id, username: u.username, role: c.body.role });
  });
  const findMember = (ws, ref) => { const m = ws.members.find((x) => x.userId === ref || user(x.userId)?.username === ref); if (!m) throw notFound('member not found'); return m; };
  const adminCount = (ws) => ws.members.filter((m) => m.role === 'admin').length;
  R('PATCH', '/api/workspaces/:id/members/:uid', (c) => {
    const ws = getWs(c.params.id, c.user.id, true);
    const m = findMember(ws, c.params.uid);
    if (!WS_ROLES.includes(c.body.role)) throw bad('invalid role');
    if (m.role === 'admin' && c.body.role !== 'admin' && adminCount(ws) <= 1) throw bad('cannot demote the last admin');
    const from = m.role; m.role = c.body.role;
    audit(ws.id, c.user.id, 'member.role_changed', { userId: m.userId, from, to: m.role });
    return out(200, { userId: m.userId, username: user(m.userId)?.username, role: m.role });
  });
  R('DELETE', '/api/workspaces/:id/members/:uid', (c) => {
    const ws = getWs(c.params.id, c.user.id, true);
    const m = findMember(ws, c.params.uid);
    if (m.role === 'admin' && adminCount(ws) <= 1) throw bad('cannot remove the last admin');
    ws.members = ws.members.filter((x) => x !== m);
    for (const p of db.projects) if (p.workspaceId === ws.id) p.members = p.members.filter((x) => x.userId !== m.userId);
    audit(ws.id, c.user.id, 'member.removed', { userId: m.userId });
    return out(204);
  });
  R('GET', '/api/workspaces/:id/audit', (c) => {
    const ws = getWs(c.params.id, c.user.id, true);
    return out(200, db.audit.filter((a) => a.workspaceId === ws.id).slice().reverse());
  });

  // projects
  const projOut = (p) => ({ id: p.id, workspaceId: p.workspaceId, name: p.name, key: p.key, createdAt: p.createdAt, workflow: p.workflow, members: p.members.map((m) => ({ userId: m.userId, username: user(m.userId)?.username, role: m.role })) });
  R('POST', '/api/workspaces/:id/projects', (c) => {
    const ws = getWs(c.params.id, c.user.id);
    if (wsRole(ws, c.user.id) === 'guest') throw forbidden('guests cannot create projects');
    const { name, key } = c.body;
    if (!isStr(name) || !name.trim()) throw bad('name required');
    if (!isStr(key) || !/^[A-Z]{2,10}$/.test(key)) throw bad('key must be 2-10 uppercase letters');
    if (db.projects.some((p) => p.key === key)) throw conflict('project key taken');
    const names = ['Backlog', 'Todo', 'In Progress', 'In Review', 'Done'];
    const p = {
      id: rid(), workspaceId: ws.id, name: name.trim(), key, counter: 0, createdAt: iso(),
      members: [{ userId: c.user.id, role: 'lead' }],
      workflow: { statuses: names.map((n, i) => ({ name: n, category: ['backlog', 'unstarted', 'started', 'started', 'completed'][i] })), transitions: names.flatMap((a) => names.filter((b) => b !== a).map((b) => [a, b])) },
    };
    db.projects.push(p);
    return out(201, projOut(p));
  });
  R('GET', '/api/workspaces/:id/projects', (c) => {
    const ws = getWs(c.params.id, c.user.id);
    return out(200, db.projects.filter((p) => p.workspaceId === ws.id && canSee(p, c.user.id)).map(projOut));
  });
  R('GET', '/api/projects/:id', (c) => out(200, projOut(getProj(c.params.id, c.user.id))));
  R('GET', '/api/projects/:id/workflow', (c) => out(200, getProj(c.params.id, c.user.id).workflow));
  R('POST', '/api/projects/:id/members', (c) => {
    const p = getProj(c.params.id, c.user.id, 'lead');
    if (!isStr(c.body.username)) throw bad('username required');
    if (!PROJ_ROLES.includes(c.body.role)) throw bad('invalid role');
    const u = userByName(c.body.username); if (!u) throw notFound('user not found');
    if (!wsRole(wsOf(p.workspaceId), u.id)) throw bad('user is not a workspace member');
    if (p.members.some((m) => m.userId === u.id)) throw conflict('already a member');
    p.members.push({ userId: u.id, role: c.body.role });
    audit(p.workspaceId, c.user.id, 'project_member.added', { projectId: p.id, userId: u.id, role: c.body.role });
    return out(201, { userId: u.id, username: u.username, role: c.body.role });
  });
  R('PATCH', '/api/projects/:id/members/:uid', (c) => {
    const p = getProj(c.params.id, c.user.id, 'lead');
    const m = p.members.find((x) => x.userId === c.params.uid || user(x.userId)?.username === c.params.uid);
    if (!m) throw notFound('member not found');
    if (!PROJ_ROLES.includes(c.body.role)) throw bad('invalid role');
    const from = m.role; m.role = c.body.role;
    audit(p.workspaceId, c.user.id, 'project_member.role_changed', { projectId: p.id, userId: m.userId, from, to: m.role });
    return out(200, { userId: m.userId, username: user(m.userId)?.username, role: m.role });
  });
  R('DELETE', '/api/projects/:id/members/:uid', (c) => {
    const p = getProj(c.params.id, c.user.id, 'lead');
    const m = p.members.find((x) => x.userId === c.params.uid || user(x.userId)?.username === c.params.uid);
    if (!m) throw notFound('member not found');
    p.members = p.members.filter((x) => x !== m);
    audit(p.workspaceId, c.user.id, 'project_member.removed', { projectId: p.id, userId: m.userId });
    return out(204);
  });
  R('PUT', '/api/projects/:id/workflow', (c) => {
    const p = getProj(c.params.id, c.user.id, 'lead');
    const { statuses, transitions, remap } = c.body;
    if (!Array.isArray(statuses) || !statuses.length) throw bad('statuses required');
    const names = new Set();
    for (const s of statuses) {
      if (!s || !isStr(s.name) || !s.name.trim() || !CATS.includes(s.category)) throw bad('invalid status');
      if (names.has(s.name)) throw bad('duplicate status name');
      names.add(s.name);
    }
    let tr = transitions;
    if (tr === undefined) tr = statuses.flatMap((a) => statuses.filter((b) => b.name !== a.name).map((b) => [a.name, b.name]));
    if (!Array.isArray(tr) || tr.some((t) => !Array.isArray(t) || t.length !== 2 || !names.has(t[0]) || !names.has(t[1]))) throw bad('invalid transitions');
    if (remap !== undefined && (typeof remap !== 'object' || remap === null || Array.isArray(remap))) throw bad('invalid remap');
    const mine = db.issues.filter((i) => i.projectId === p.id);
    const need = [...new Set(mine.filter((i) => !names.has(i.status)).map((i) => i.status))];
    for (const o of need) if (!remap || !isStr(remap[o]) || !names.has(remap[o])) throw bad(`status "${o}" is in use; provide remap`);
    const ts = iso();
    p.workflow = { statuses: statuses.map((s) => ({ name: s.name, category: s.category })), transitions: tr.map((t) => [t[0], t[1]]) };
    for (const i of mine) {
      let changed = false;
      if (!names.has(i.status)) {
        const to = remap[i.status];
        (i.history ||= []).push({ field: 'status', from: i.status, to, actorId: c.user.id, at: ts });
        i.status = to; changed = true;
      }
      const before = i.resolvedAt;
      setStatusSideEffects(i, p, ts);
      if (changed || before !== i.resolvedAt) { i.updatedAt = ts; i._seq = ++db.seq; }
    }
    audit(p.workspaceId, c.user.id, 'workflow.updated', { projectId: p.id });
    return out(200, p.workflow);
  });

  // issues
  R('POST', '/api/projects/:id/issues', (c) => {
    const p = getProj(c.params.id, c.user.id, 'developer');
    return out(201, issueOut(createIssue(p, c.user.id, c.body)));
  });
  R('GET', '/api/projects/:id/issues', (c) => {
    const p = getProj(c.params.id, c.user.id);
    const q = c.query;
    let l = db.issues.filter((i) => i.projectId === p.id);
    if (q.get('status')) l = l.filter((i) => i.status === q.get('status'));
    if (q.get('type')) l = l.filter((i) => i.type === q.get('type'));
    if (q.get('assigneeId')) l = l.filter((i) => i.assigneeId === q.get('assigneeId'));
    if (q.get('sprintId')) l = l.filter((i) => i.sprintId === q.get('sprintId'));
    if (q.get('sprint') === 'none') l = l.filter((i) => !i.sprintId);
    return out(200, l.map(issueOut));
  });
  R('GET', '/api/issues/:key', (c) => out(200, issueOut(getIssue(c.params.key, c.user.id)[0])));
  R('PATCH', '/api/issues/:key', (c) => {
    const [i, p] = getIssue(c.params.key, c.user.id, 'developer');
    applyIssueChanges(i, p, c.body, c.user.id);
    return out(200, issueOut(i));
  });
  R('DELETE', '/api/issues/:key', (c) => {
    const [i, p] = getIssue(c.params.key, c.user.id, 'developer');
    cascadeDelete(i, p, c.user.id);
    return out(204);
  });
  R('GET', '/api/issues/:key/history', (c) => out(200, (getIssue(c.params.key, c.user.id)[0].history || []).map((h) => ({ ...h }))));
  R('POST', '/api/issues/:key/links', (c) => {
    const [i, p] = getIssue(c.params.key, c.user.id, 'developer');
    const { type, target } = c.body;
    if (!LINK_TYPES.includes(type)) throw bad('invalid link type');
    if (!isStr(target)) throw bad('target required');
    const t = issueByKey(target); if (!t) throw notFound('target not found');
    if (!canSee(projOf(t.projectId), c.user.id)) throw forbidden('no access to target');
    if (t.id === i.id) throw bad('cannot link to self');
    if (db.links.some((l) => (l.from === i.id && l.to === t.id && l.type === type) || (type === 'relates' && l.type === 'relates' && l.from === t.id && l.to === i.id))) throw conflict('link exists');
    const l = { id: rid(), type, from: i.id, to: t.id };
    db.links.push(l);
    void p;
    return out(201, { id: l.id, type, target: t.key, key: t.key });
  });
  R('DELETE', '/api/issues/:key/links/:id', (c) => {
    const [i] = getIssue(c.params.key, c.user.id, 'developer');
    const l = db.links.find((x) => x.id === c.params.id && (x.from === i.id || x.to === i.id));
    if (!l) throw notFound('link not found');
    db.links = db.links.filter((x) => x !== l);
    return out(204);
  });

  // comments / watchers / notifications
  R('POST', '/api/issues/:key/comments', (c) => {
    const [i, p] = getIssue(c.params.key, c.user.id, 'developer');
    if (!isStr(c.body.body) || !c.body.body.trim()) throw bad('body required');
    const ts = iso();
    const cm = { id: rid(), issueId: i.id, issueKey: i.key, authorId: c.user.id, body: c.body.body, createdAt: ts, updatedAt: ts, edited: false };
    db.comments.push(cm);
    const mentioned = [];
    for (const m of c.body.body.matchAll(/@([A-Za-z0-9_.-]+)/g)) {
      let name = m[1]; let u = userByName(name);
      while (!u && /[.-]$/.test(name)) { name = name.slice(0, -1); u = userByName(name); }
      if (u && u.id !== c.user.id && canSee(p, u.id)) mentioned.push(u.id);
    }
    const mset = [...new Set(mentioned)];
    notify(i, p, mset, 'mention', c.user.id, { commentId: cm.id });
    notify(i, p, i.watchers.filter((w) => !mset.includes(w)), 'comment', c.user.id, { commentId: cm.id });
    fire('comment.created', i, c.user.id, p, { comment: cm });
    return out(201, cm);
  });
  R('GET', '/api/issues/:key/comments', (c) => out(200, db.comments.filter((x) => x.issueId === getIssue(c.params.key, c.user.id)[0].id)));
  const getComment = (c) => {
    const cm = db.comments.find((x) => x.id === c.params.id); if (!cm) throw notFound('comment not found');
    const [i, p] = getIssue(cm.issueId, c.user.id); return [cm, i, p];
  };
  R('PATCH', '/api/comments/:id', (c) => {
    const [cm] = getComment(c);
    if (cm.authorId !== c.user.id) throw forbidden('only the author can edit');
    if (!isStr(c.body.body) || !c.body.body.trim()) throw bad('body required');
    cm.body = c.body.body; cm.edited = true; cm.updatedAt = iso();
    return out(200, cm);
  });
  R('DELETE', '/api/comments/:id', (c) => {
    const [cm, , p] = getComment(c);
    if (cm.authorId !== c.user.id && projRole(p, c.user.id) !== 'lead') throw forbidden('not allowed');
    db.comments = db.comments.filter((x) => x !== cm);
    return out(204);
  });
  R('POST', '/api/issues/:key/watch', (c) => {
    const [i] = getIssue(c.params.key, c.user.id);
    if (!i.watchers.includes(c.user.id)) i.watchers.push(c.user.id);
    return out(200, issueOut(i));
  });
  R('DELETE', '/api/issues/:key/watch', (c) => {
    const [i] = getIssue(c.params.key, c.user.id);
    i.watchers = i.watchers.filter((w) => w !== c.user.id);
    return out(200, issueOut(i));
  });
  R('GET', '/api/notifications', (c) => {
    let l = db.notifications.filter((n) => n.userId === c.user.id);
    if (c.query.get('unread') === 'true') l = l.filter((n) => !n.read);
    return out(200, l.sort((a, b) => b._seq - a._seq).map(({ userId, _seq, ...r }) => r));
  });
  R('POST', '/api/notifications/read', (c) => {
    const mine = db.notifications.filter((n) => n.userId === c.user.id);
    let n = 0;
    if (c.body.all === true) { for (const x of mine) { if (!x.read) n++; x.read = true; } }
    else if (Array.isArray(c.body.ids)) { for (const x of mine) if (c.body.ids.includes(x.id)) { if (!x.read) n++; x.read = true; } }
    else throw bad('ids or all required');
    return out(200, { updated: n });
  });

  // sprints
  const spOut = (s) => clean(s);
  R('POST', '/api/projects/:id/sprints', (c) => {
    const p = getProj(c.params.id, c.user.id, 'developer');
    const { name, startDate, endDate } = c.body;
    if (!isStr(name) || !name.trim()) throw bad('name required');
    if (startDate != null && !isDate(startDate)) throw bad('invalid startDate');
    if (endDate != null && !isDate(endDate)) throw bad('invalid endDate');
    if (startDate && endDate && endDate < startDate) throw bad('endDate before startDate');
    const s = { id: rid(), projectId: p.id, name: name.trim(), startDate: startDate || null, endDate: endDate || null, state: 'planned', createdAt: iso(), startedAt: null, completedAt: null };
    db.sprints.push(s);
    return out(201, spOut(s));
  });
  R('GET', '/api/projects/:id/sprints', (c) => out(200, db.sprints.filter((s) => s.projectId === getProj(c.params.id, c.user.id).id).map(spOut)));
  R('GET', '/api/sprints/:id', (c) => out(200, spOut(getSprint(c.params.id, c.user.id)[0])));
  R('POST', '/api/sprints/:id/start', (c) => {
    const [s, p] = getSprint(c.params.id, c.user.id, 'developer');
    if (s.state !== 'planned') throw conflict('sprint is not planned');
    if (db.sprints.some((x) => x.projectId === p.id && x.state === 'active')) throw conflict('another sprint is active');
    const ts = iso();
    if (!s.startDate) s.startDate = ts.slice(0, 10);
    if (s.endDate && s.endDate < s.startDate) throw bad('endDate before startDate');
    s.state = 'active'; s.startedAt = ts;
    s.committedPoints = db.issues.filter((i) => i.sprintId === s.id).reduce((a, i) => a + (i.storyPoints || 0), 0);
    return out(200, spOut(s));
  });
  R('POST', '/api/sprints/:id/complete', (c) => {
    const [s, p] = getSprint(c.params.id, c.user.id, 'developer');
    if (s.state !== 'active') throw conflict('sprint is not active');
    const to = c.body.carryOverTo ?? 'backlog';
    let target = null;
    if (to !== 'backlog') {
      target = isStr(to) && sprintOf(to);
      if (!target || target.projectId !== p.id || target.id === s.id || target.state === 'completed') throw bad('invalid carryOverTo');
    }
    const ts = iso(); let n = 0;
    for (const i of db.issues.filter((x) => x.sprintId === s.id && !isDone(p, x))) {
      (i.history ||= []).push({ field: 'sprintId', from: s.id, to: target ? target.id : null, actorId: c.user.id, at: ts });
      i.sprintId = target ? target.id : null; i.updatedAt = ts; i._seq = ++db.seq; n++;
    }
    s.state = 'completed'; s.completedAt = ts; s.carriedOver = n;
    return out(200, spOut(s));
  });
  R('GET', '/api/sprints/:id/report', (c) => { const [s, p] = getSprint(c.params.id, c.user.id); return out(200, sprintReport(s, p)); });
  R('GET', '/api/projects/:id/stats', (c) => {
    const p = getProj(c.params.id, c.user.id);
    const mine = db.issues.filter((i) => i.projectId === p.id);
    const byStatus = Object.fromEntries(p.workflow.statuses.map((s) => [s.name, 0]));
    const byType = {}; const byAssignee = {};
    for (const i of mine) {
      byStatus[i.status] = (byStatus[i.status] || 0) + 1;
      byType[i.type] = (byType[i.type] || 0) + 1;
      const a = i.assigneeId ? user(i.assigneeId)?.username : 'unassigned';
      byAssignee[a] = (byAssignee[a] || 0) + 1;
    }
    const cy = mine.filter((i) => i.resolvedAt && i._startedAt).map((i) => (Date.parse(i.resolvedAt) - Date.parse(i._startedAt)) / 3600000);
    const avg = cy.length ? cy.reduce((a, b) => a + b, 0) / cy.length : null;
    return out(200, { total: mine.length, byStatus, byType, byAssignee, avgCycleTimeHours: avg, averageCycleTimeHours: avg, cycleTimeHours: avg });
  });
  R('GET', '/api/search', (c) => out(200, runSearch(c.user.id, c.query)));

  // CSV
  const COLS = ['key', 'type', 'title', 'status', 'priority', 'assignee', 'labels', 'storyPoints', 'parent', 'epic', 'sprint', 'dueDate', 'createdAt', 'resolvedAt'];
  R('GET', '/api/projects/:id/export.csv', (c) => {
    const p = getProj(c.params.id, c.user.id);
    const rows = [COLS];
    for (const i of db.issues.filter((x) => x.projectId === p.id)) {
      rows.push([i.key, i.type, i.title, i.status, i.priority, (i.assigneeId && user(i.assigneeId)?.username) || '', i.labels.join(';'),
        i.storyPoints ?? '', (i.parentId && issueById(i.parentId)?.key) || '', (i.epicId && issueById(i.epicId)?.key) || '',
        (i.sprintId && sprintOf(i.sprintId)?.name) || '', i.dueDate || '', i.createdAt, i.resolvedAt || '']);
    }
    return { status: 200, raw: toCsv(rows), type: 'text/csv; charset=utf-8' };
  });
  R('POST', '/api/projects/:id/import.csv', (c) => {
    const p = getProj(c.params.id, c.user.id, 'developer');
    const rows = parseCsv(c.text || '');
    if (!rows.length) throw bad('empty CSV');
    const header = rows[0].fields.map((h) => h.trim());
    if (!header.includes('title')) throw bad('CSV header must include title');
    let created = 0; const errors = [];
    for (const r of rows.slice(1)) {
      try {
        const g = (k) => { const ix = header.indexOf(k); return ix < 0 ? '' : (r.fields[ix] ?? '').trim(); };
        const d = { title: g('title') };
        if (g('type')) d.type = g('type');
        if (g('status')) d.status = g('status');
        if (g('priority')) d.priority = g('priority');
        if (g('assignee')) { const u = userByName(g('assignee')); if (!u) throw bad(`unknown assignee ${g('assignee')}`); d.assigneeId = u.id; }
        if (g('labels')) d.labels = g('labels').split(';').map((x) => x.trim()).filter(Boolean);
        if (g('storyPoints')) { const n = Number(g('storyPoints')); if (!isFinite(n)) throw bad('invalid storyPoints'); d.storyPoints = n; }
        if (g('parent')) d.parentId = g('parent');
        if (g('epic')) d.epicId = g('epic');
        if (g('sprint')) { const s = db.sprints.find((x) => x.projectId === p.id && (x.id === g('sprint') || x.name === g('sprint'))); if (!s) throw bad(`unknown sprint ${g('sprint')}`); d.sprintId = s.id; }
        if (g('dueDate')) d.dueDate = g('dueDate');
        const snapshot = p.counter;
        try { createIssue(p, c.user.id, d); } catch (e) { p.counter = snapshot; throw e; }
        created++;
      } catch (e) {
        if (!(e instanceof ApiError)) throw e;
        errors.push({ line: r.line, message: e.message });
      }
    }
    return out(200, { created, errors });
  }, { raw: true });

  // webhooks
  const hookOut = (h) => ({ id: h.id, projectId: h.projectId, url: h.url, events: h.events, createdAt: h.createdAt });
  R('POST', '/api/projects/:id/webhooks', (c) => {
    const p = getProj(c.params.id, c.user.id, 'lead');
    const { url, events, secret } = c.body;
    let ok = false; try { const u = new URL(url); ok = /^https?:$/.test(u.protocol); } catch { /* */ }
    if (!ok) throw bad('invalid url');
    if (!Array.isArray(events) || !events.length || events.some((e) => !EVENTS.includes(e))) throw bad('invalid events');
    if (!isStr(secret) || !secret) throw bad('secret required');
    const h = { id: rid(), projectId: p.id, url, events: [...new Set(events)], secret, createdAt: iso() };
    db.webhooks.push(h);
    audit(p.workspaceId, c.user.id, 'webhook.created', { webhookId: h.id, projectId: p.id, url });
    return out(201, hookOut(h));
  });
  R('GET', '/api/projects/:id/webhooks', (c) => out(200, db.webhooks.filter((h) => h.projectId === getProj(c.params.id, c.user.id, 'lead').id).map(hookOut)));
  const getHook = (c) => { const h = db.webhooks.find((x) => x.id === c.params.id); if (!h) throw notFound('webhook not found'); return [h, getProj(h.projectId, c.user.id, 'lead')]; };
  R('DELETE', '/api/webhooks/:id', (c) => {
    const [h, p] = getHook(c);
    db.webhooks = db.webhooks.filter((x) => x !== h);
    audit(p.workspaceId, c.user.id, 'webhook.deleted', { webhookId: h.id, projectId: p.id });
    return out(204);
  });
  R('GET', '/api/webhooks/:id/deliveries', (c) => { const [h] = getHook(c); return out(200, db.deliveries.filter((d) => d.webhookId === h.id).map((d) => ({ ...d, delivered: d.status === 'success' }))); });

  // ---------- http ----------
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
  function serveStatic(res, rel) {
    const f = path.normalize(path.join(STATIC_DIR, rel));
    if (!f.startsWith(STATIC_DIR) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { send(res, 404, { error: 'not_found', message: 'not found' }); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(fs.readFileSync(f));
  }
  function send(res, status, body, type) {
    if (status === 204) { res.writeHead(204); res.end(); return; }
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    res.writeHead(status, { 'content-type': type || 'application/json; charset=utf-8' });
    res.end(data);
  }
  const server = http.createServer((req, res) => {
    const chunks = []; let size = 0; let dead = false;
    req.on('data', (d) => { size += d.length; if (size > 5e6) { dead = true; send(res, 413, { error: 'payload_too_large', message: 'too large' }); req.destroy(); } else chunks.push(d); });
    req.on('end', () => {
      if (dead) return;
      try { handle(req, res, Buffer.concat(chunks).toString('utf8')); }
      catch (e) {
        if (e instanceof ApiError) send(res, e.status, { error: e.code, message: e.message });
        else { console.error(e); send(res, 500, { error: 'internal_error', message: 'internal error' }); }
      }
    });
  });
  function handle(req, res, text) {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveStatic(res, 'index.html');
    if (req.method === 'GET' && p.startsWith('/static/')) return serveStatic(res, decodeURIComponent(p.slice(8)));
    if (!p.startsWith('/api/')) throw notFound();
    let matched = null; let pathMatch = false;
    for (const r of routes) {
      const m = r.re.exec(p); if (!m) continue;
      pathMatch = true;
      if (r.method !== req.method) continue;
      matched = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
      break;
    }
    if (!matched) { if (pathMatch) throw new ApiError(405, 'method_not_allowed', 'method not allowed'); throw notFound('route not found'); }
    const { r, params } = matched;
    const ctx = { req, res, params, query: url.searchParams, text, body: {}, user: null };
    if (r.auth) {
      const h = req.headers.authorization || '';
      const mm = /^Bearer\s+(\S+)$/i.exec(h);
      if (!mm) throw new ApiError(401, 'unauthorized', 'authentication required');
      const th = sha(mm[1]);
      let uid = db.sessions[th];
      if (!uid) uid = db.tokens.find((t) => t.hash === th)?.userId;
      const u = uid && user(uid);
      if (!u) throw new ApiError(401, 'unauthorized', 'invalid token');
      ctx.user = u; ctx.tokenHash = th;
    }
    if (!r.raw && text.trim() && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      try { ctx.body = JSON.parse(text); } catch { throw bad('invalid JSON'); }
      if (!ctx.body || typeof ctx.body !== 'object' || Array.isArray(ctx.body)) throw bad('body must be an object');
    }
    const result = r.fn(ctx);
    if (req.method !== 'GET') save();
    if (result.raw !== undefined) send(res, result.status, result.raw, result.type);
    else send(res, result.status, result.body);
  }
  return server;
}
