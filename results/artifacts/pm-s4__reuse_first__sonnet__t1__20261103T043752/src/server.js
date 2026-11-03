import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { parseCSV, toCSV } from './csv.js';

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');
const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIOS = ['urgent', 'high', 'medium', 'low', 'none'];
const CATS = ['backlog', 'unstarted', 'started', 'completed'];
const ROLES_WS = ['admin', 'member', 'guest'];
const ROLES_PR = ['lead', 'developer', 'viewer'];
const EVENTS = ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'];
const LINK_TYPES = ['blocks', 'relates', 'duplicates'];
const INVERSE = { blocks: 'blocked_by', blocked_by: 'blocks', relates: 'relates', duplicates: 'duplicated_by', duplicated_by: 'duplicates' };

class ApiError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}
const bad = m => new ApiError(400, 'validation_error', m);
const forbidden = m => new ApiError(403, 'forbidden', m || 'forbidden');
const notFound = m => new ApiError(404, 'not_found', m || 'not found');
const conflict = (c, m) => new ApiError(409, c || 'conflict', m || c || 'conflict');

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const uid = () => crypto.randomUUID();
const isStr = v => typeof v === 'string' && v.trim().length > 0;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pw, salt, 32).toString('hex') };
}
function checkPw(pw, u) {
  const h = Buffer.from(hashPw(pw, u.salt).hash, 'hex'); const e = Buffer.from(u.hash, 'hex');
  return h.length === e.length && crypto.timingSafeEqual(h, e);
}

const DEFAULT_WORKFLOW = () => {
  const statuses = [
    { name: 'Backlog', category: 'backlog' }, { name: 'Todo', category: 'unstarted' },
    { name: 'In Progress', category: 'started' }, { name: 'In Review', category: 'started' },
    { name: 'Done', category: 'completed' }];
  return { statuses, transitions: allTransitions(statuses) };
};
function allTransitions(statuses) {
  const t = [];
  for (const a of statuses) for (const b of statuses) if (a.name !== b.name) t.push([a.name, b.name]);
  return t;
}

export function createServer({ dataFile, clock } = {}) {
  const now = () => (clock ? clock() : new Date());
  const iso = () => now().toISOString();
  let db = { users: [], sessions: [], apiTokens: [], workspaces: [], projects: [], issues: [], comments: [],
    notifications: [], sprints: [], webhooks: [], deliveries: [], audit: [] };
  if (dataFile && fs.existsSync(dataFile)) {
    try { db = { ...db, ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) }; } catch { /* ignore */ }
  }
  const failures = new Map(); // username -> [ms]
  function save() {
    if (!dataFile) return;
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, dataFile);
  }

  // ---------- lookups ----------
  const userById = id => db.users.find(u => u.id === id);
  const userByName = n => typeof n === 'string' ? db.users.find(u => u.username.toLowerCase() === n.toLowerCase()) : undefined;
  const pubUser = u => ({ id: u.id, username: u.username, displayName: u.displayName });
  const wsById = id => db.workspaces.find(w => w.id === id);
  const projById = id => db.projects.find(p => p.id === id);
  const issueByKey = k => db.issues.find(i => i.key === k);
  const issueByRef = (ref, projectId) => db.issues.find(i => (i.id === ref || i.key === ref) && (!projectId || i.projectId === projectId));
  const wsRole = (u, ws) => ws.members.find(m => m.userId === u.id)?.role || null;
  function projRole(u, p) {
    const ws = wsById(p.workspaceId);
    const r = ws && wsRole(u, ws);
    if (r === 'admin') return 'lead';
    const pm = p.members.find(m => m.userId === u.id);
    if (pm) return r ? pm.role : null;
    if (r === 'member') return 'developer';
    return null;
  }
  function needProject(u, id, min) {
    const p = projById(id); if (!p) throw notFound('project not found');
    const r = projRole(u, p); if (!r) throw forbidden('no access to project');
    checkMin(r, min); return { p, r };
  }
  const RANK = { viewer: 0, developer: 1, lead: 2 };
  function checkMin(r, min) { if (min && RANK[r] < RANK[min]) throw forbidden('insufficient role'); }
  function needIssue(u, key, min) {
    const i = issueByKey(key); if (!i) throw notFound('issue not found');
    const p = projById(i.projectId); const r = projRole(u, p);
    if (!r) throw forbidden('no access to project'); checkMin(r, min);
    return { i, p, r };
  }
  function needWs(u, id, role) {
    const w = wsById(id); if (!w) throw notFound('workspace not found');
    const r = wsRole(u, w); if (!r) throw forbidden('not a workspace member');
    if (role === 'admin' && r !== 'admin') throw forbidden('admin only');
    return { w, r };
  }
  const wsView = w => ({ id: w.id, name: w.name, key: w.key, createdAt: w.createdAt,
    members: w.members.map(m => ({ userId: m.userId, username: userById(m.userId)?.username, role: m.role })) });
  const projView = p => ({ id: p.id, workspaceId: p.workspaceId, name: p.name, key: p.key, createdAt: p.createdAt,
    workflow: p.workflow, members: p.members.map(m => ({ userId: m.userId, username: userById(m.userId)?.username, role: m.role })) });
  const catOf = (p, name) => p.workflow.statuses.find(s => s.name === name)?.category;

  function audit(wsId, action, actorId, details) {
    if (wsId) db.audit.push({ id: uid(), workspaceId: wsId, action, actorId, at: iso(), details: details || {} });
  }

  // ---------- issue serialization ----------
  function serIssue(i, full) {
    const out = { ...i };
    delete out.links;
    out.children = db.issues.filter(c => c.parentId === i.id).map(c => c.key);
    out.links = (i.links || []).map(l => ({ id: l.id, type: l.type, target: l.target, key: l.target }));
    for (const o of db.issues) for (const l of o.links || []) if (l.target === i.key) {
      out.links.push({ id: l.id, type: INVERSE[l.type], target: o.key, key: o.key });
    }
    if (i.type === 'epic') {
      const p = projById(i.projectId);
      const kids = db.issues.filter(c => c.epicId === i.id);
      const done = kids.filter(c => catOf(p, c.status) === 'completed');
      const sum = a => a.reduce((s, c) => s + (Number(c.storyPoints) || 0), 0);
      out.progress = { total: kids.length, done: done.length, points_total: sum(kids), points_done: sum(done) };
    }
    return out;
  }
  const refKey = id => (id ? db.issues.find(i => i.id === id)?.key : undefined);

  // ---------- notifications / webhooks ----------
  function notify(userIds, type, issue, actorId, p) {
    for (const uidd of new Set(userIds)) {
      if (uidd === actorId) continue;
      const u = userById(uidd); if (!u || !projRole(u, p)) continue;
      db.notifications.push({ id: uid(), userId: uidd, type, issueKey: issue.key, actorId, at: iso(), read: false });
    }
  }
  function fire(event, issue, actorId, p, extra) {
    for (const wh of db.webhooks.filter(w => w.projectId === p.id && w.events.includes(event))) {
      const payload = JSON.stringify({ event, issue: serIssue(issue), actorId, at: iso(), ...(extra || {}) });
      const d = { id: uid(), webhookId: wh.id, event, status: null, attempts: 0, lastError: null, at: iso() };
      db.deliveries.push(d);
      deliver(wh, d, payload);
    }
  }
  async function deliver(wh, d, payload) {
    const sig = 'sha256=' + crypto.createHmac('sha256', wh.secret).update(payload).digest('hex');
    for (let a = 1; a <= 3; a++) {
      d.attempts = a;
      try {
        const r = await fetch(wh.url, { method: 'POST', body: payload, signal: AbortSignal.timeout(5000),
          headers: { 'content-type': 'application/json', 'x-pm-signature': sig, 'x-pm-event': d.event } });
        d.status = r.status;
        if (r.ok) { d.lastError = null; break; }
        d.lastError = 'HTTP ' + r.status;
      } catch (e) { d.lastError = String(e.message || e); }
      save();
      if (a < 3) await new Promise(r => setTimeout(r, 25 * a));
    }
    save();
  }

  // ---------- issue logic ----------
  function record(i, field, from, to, actorId) {
    if (same(from, to)) return false;
    db.history = db.history || [];
    db.history.push({ issueId: i.id, field, from: from ?? null, to: to ?? null, actorId, at: iso() });
    return true;
  }
  const histOf = i => (db.history || []).filter(h => h.issueId === i.id);

  function validateFields(p, b, cur) {
    const out = {};
    if ('title' in b) { if (!isStr(b.title)) throw bad('title required'); out.title = b.title.trim(); }
    if ('description' in b) { if (b.description != null && typeof b.description !== 'string') throw bad('description must be string'); out.description = b.description ?? ''; }
    if ('type' in b) { if (!TYPES.includes(b.type)) throw bad('invalid type'); out.type = b.type; }
    if ('priority' in b) { if (!PRIOS.includes(b.priority)) throw bad('invalid priority'); out.priority = b.priority; }
    if ('labels' in b) {
      if (!Array.isArray(b.labels) || b.labels.some(l => !isStr(l))) throw bad('labels must be array of strings');
      out.labels = [...new Set(b.labels)];
    }
    if ('storyPoints' in b) {
      if (b.storyPoints !== null && (typeof b.storyPoints !== 'number' || !isFinite(b.storyPoints) || b.storyPoints < 0)) throw bad('invalid storyPoints');
      out.storyPoints = b.storyPoints;
    }
    if ('dueDate' in b) {
      if (b.dueDate !== null && (typeof b.dueDate !== 'string' || isNaN(Date.parse(b.dueDate)))) throw bad('invalid dueDate');
      out.dueDate = b.dueDate;
    }
    if ('assigneeId' in b) {
      if (b.assigneeId !== null) {
        const u = userById(b.assigneeId); if (!u) throw bad('unknown assignee');
        if (!projRole(u, p)) throw bad('assignee has no access to project');
      }
      out.assigneeId = b.assigneeId;
    }
    if ('status' in b) {
      if (!p.workflow.statuses.some(s => s.name === b.status)) throw bad('unknown status');
      out.status = b.status;
    }
    if ('sprintId' in b) {
      if (b.sprintId !== null) {
        const s = db.sprints.find(s => s.id === b.sprintId && s.projectId === p.id);
        if (!s) throw bad('unknown sprint'); if (s.state === 'completed') throw bad('sprint completed');
      }
      out.sprintId = b.sprintId;
    }
    const type = out.type ?? cur?.type;
    for (const f of ['parentId', 'epicId']) if (f in b) {
      if (b[f] === null) { out[f] = null; continue; }
      if (typeof b[f] !== 'string') throw bad(f + ' must be string');
      const ref = issueByRef(b[f], p.id); if (!ref) throw bad(f + ' not found in project');
      if (f === 'parentId') { if (ref.type === 'subtask') throw bad('parent cannot be a subtask'); if (cur && ref.id === cur.id) throw bad('self parent'); }
      else if (ref.type !== 'epic') throw bad('epicId must reference an epic');
      out[f] = ref.id;
    }
    const parent = 'parentId' in out ? out.parentId : cur?.parentId;
    if (type === 'subtask' && !parent) throw bad('subtask requires parentId');
    if (type === 'epic' && parent) throw bad('epics cannot have parents');
    return out;
  }

  function setResolved(i, p, actorId) {
    const c = catOf(p, i.status);
    if (c === 'completed') { if (!i.resolvedAt) i.resolvedAt = iso(); } else i.resolvedAt = null;
  }

  function createIssue(p, b, actor, opts = {}) {
    if (!isStr(b.title)) throw bad('title required');
    if (!b.type) b = { ...b, type: 'task' };
    const f = validateFields(p, b, null);
    let status = f.status;
    if (!status) status = (p.workflow.statuses.find(s => s.category === 'unstarted') || p.workflow.statuses[0]).name;
    p.nextNumber = (p.nextNumber || 1);
    const n = p.nextNumber++;
    const t = iso();
    const i = {
      id: uid(), key: `${p.key}-${n}`, projectId: p.id, type: f.type, title: f.title, description: f.description ?? '',
      status, priority: f.priority ?? 'none', assigneeId: f.assigneeId ?? null, reporterId: actor.id,
      labels: f.labels ?? [], storyPoints: f.storyPoints ?? null, parentId: f.parentId ?? null, epicId: f.epicId ?? null,
      sprintId: f.sprintId ?? null, dueDate: f.dueDate ?? null, watchers: [], createdAt: t, updatedAt: t, resolvedAt: null, links: [],
    };
    i.watchers.push(actor.id);
    if (i.assigneeId && !i.watchers.includes(i.assigneeId)) i.watchers.push(i.assigneeId);
    setResolved(i, p);
    db.issues.push(i);
    if (i.assigneeId) notify([i.assigneeId], 'assigned', i, actor.id, p);
    if (!opts.quiet) fire('issue.created', i, actor.id, p);
    return i;
  }

  function checkTransition(p, i, to) {
    if (i.status === to) return;
    if (!p.workflow.transitions.some(([a, b]) => a === i.status && b === to)) throw conflict('invalid_transition', `cannot move from ${i.status} to ${to}`);
    if (catOf(p, to) === 'completed') {
      for (const o of db.issues) for (const l of o.links || []) {
        if (l.type === 'blocks' && l.target === i.key && !o.resolvedAt) throw conflict('blocked', `blocked by ${o.key}`);
      }
      for (const l of i.links || []) if (l.type === 'blocked_by') {
        const o = issueByKey(l.target); if (o && !o.resolvedAt) throw conflict('blocked', `blocked by ${o.key}`);
      }
    }
  }

  function applyPatch(i, p, f, actor) {
    const changed = [];
    const wasStatus = i.status, wasAssignee = i.assigneeId;
    for (const [k, v] of Object.entries(f)) {
      if (same(i[k], v)) continue;
      record(i, k, i[k], v, actor.id); i[k] = v; changed.push(k);
    }
    if (changed.length) {
      setResolved(i, p, actor.id);
      i.updatedAt = iso();
    }
    if (i.status !== wasStatus) notify(i.watchers, 'status_changed', i, actor.id, p);
    if (i.assigneeId !== wasAssignee && i.assigneeId) {
      if (!i.watchers.includes(i.assigneeId)) i.watchers.push(i.assigneeId);
      notify(i.watchers, 'assigned', i, actor.id, p);
    }
    return changed;
  }

  function deleteIssue(i, p, actor) {
    for (const c of db.issues.filter(c => c.parentId === i.id)) deleteIssue(c, p, actor);
    db.issues = db.issues.filter(x => x.id !== i.id);
    db.comments = db.comments.filter(c => c.issueId !== i.id);
    for (const o of db.issues) {
      if (o.epicId === i.id) o.epicId = null;
      o.links = (o.links || []).filter(l => l.target !== i.key);
    }
    fire('issue.deleted', i, actor.id, p);
  }

  // ---------- search ----------
  function tokenize(q) {
    const toks = []; let n = 0;
    while (n < q.length) {
      if (/\s/.test(q[n])) { n++; continue; }
      let neg = false;
      if (q[n] === '-') { neg = true; n++; if (n >= q.length || /\s/.test(q[n])) throw bad('dangling -'); }
      let field = null, buf = '', quoted = false, hadQuote = false;
      while (n < q.length && !/\s/.test(q[n])) {
        const ch = q[n];
        if (ch === '"') {
          const e = q.indexOf('"', n + 1); if (e < 0) throw bad('unterminated quote');
          buf += q.slice(n + 1, e); quoted = true; hadQuote = true; n = e + 1; continue;
        }
        if (ch === ':' && field === null && !hadQuote && buf) { field = buf.toLowerCase(); buf = ''; n++; continue; }
        buf += ch; n++;
      }
      if (field !== null && !buf && !quoted) throw bad('empty value for ' + field);
      toks.push({ neg, field, value: buf, quoted });
    }
    return toks;
  }
  const cmp = (op, a, b) => op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : op === '>=' ? a >= b : a === b;
  function buildMatcher(toks, user) {
    const fns = toks.map(t => {
      const v = t.value; const lv = v.toLowerCase(); let fn;
      switch (t.field) {
        case null: fn = i => (i.title + '\n' + (i.description || '')).toLowerCase().includes(lv); break;
        case 'status': fn = i => i.status.toLowerCase() === lv; break;
        case 'type': if (!TYPES.includes(lv)) throw bad('invalid type'); fn = i => i.type === lv; break;
        case 'priority': if (!PRIOS.includes(lv)) throw bad('invalid priority'); fn = i => i.priority === lv; break;
        case 'assignee':
          if (lv === 'none') fn = i => !i.assigneeId;
          else if (lv === 'me') fn = i => i.assigneeId === user.id;
          else fn = i => userById(i.assigneeId)?.username.toLowerCase() === lv;
          break;
        case 'label': fn = i => i.labels.some(l => l.toLowerCase() === lv); break;
        case 'sprint':
          if (lv === 'none') fn = i => !i.sprintId;
          else if (lv === 'active') fn = i => !!i.sprintId && db.sprints.find(s => s.id === i.sprintId)?.state === 'active';
          else fn = i => i.sprintId === v;
          break;
        case 'is':
          if (lv !== 'open' && lv !== 'resolved') throw bad('is: expects open|resolved');
          fn = i => (catOf(projById(i.projectId), i.status) === 'completed') === (lv === 'resolved'); break;
        case 'due': {
          const m = /^(<=|>=|<|>|=)?(\d{4}-\d{2}-\d{2})$/.exec(v); if (!m) throw bad('invalid due');
          fn = i => !!i.dueDate && cmp(m[1] || '=', i.dueDate.slice(0, 10), m[2]); break;
        }
        case 'points': {
          const m = /^(<=|>=|<|>|=)?(\d+(?:\.\d+)?)$/.exec(v); if (!m) throw bad('invalid points');
          fn = i => i.storyPoints != null && cmp(m[1] || '=', i.storyPoints, Number(m[2])); break;
        }
        case 'key': fn = i => i.key.toLowerCase() === lv; break;
        default: throw bad('unknown field ' + t.field);
      }
      return t.neg ? i => !fn(i) : fn;
    });
    return i => fns.every(f => f(i));
  }

  // ---------- burndown ----------
  function valueAt(i, hist, field, E) {
    const hs = hist.filter(h => h.field === field);
    if (!hs.length) return i[field];
    let val = hs[0].from;
    for (const h of hs) if (new Date(h.at) <= E) val = h.to;
    return val;
  }
  function sprintReport(s) {
    const p = projById(s.projectId);
    const inSprint = db.issues.filter(i => i.sprintId === s.id);
    const pts = a => a.reduce((x, i) => x + (Number(i.storyPoints) || 0), 0);
    const done = inSprint.filter(i => catOf(p, i.status) === 'completed');
    const committed = s.committedPoints != null ? s.committedPoints : pts(inSprint);
    const burndown = [];
    if (s.startDate) {
      const start = s.startDate.slice(0, 10);
      const today = now().toISOString().slice(0, 10);
      let last = today; if (s.endDate && s.endDate.slice(0, 10) < today) last = s.endDate.slice(0, 10);
      const cand = db.issues.filter(i => i.projectId === s.projectId);
      for (let d = new Date(start + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= last; d = new Date(d.getTime() + 86400000)) {
        const E = new Date(d.toISOString().slice(0, 10) + 'T23:59:59.999Z');
        let rem = 0;
        for (const i of cand) {
          if (new Date(i.createdAt) > E) continue;
          const h = histOf(i);
          if (valueAt(i, h, 'sprintId', E) !== s.id) continue;
          if (catOf(p, valueAt(i, h, 'status', E)) === 'completed') continue;
          rem += Number(valueAt(i, h, 'storyPoints', E)) || 0;
        }
        burndown.push({ date: d.toISOString().slice(0, 10), remainingPoints: rem });
      }
    }
    return { committedPoints: committed, completedPoints: pts(done), completedIssues: done.length,
      carriedOver: s.carriedOver || 0, burndown };
  }

  // ---------- routes ----------
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = []; const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, public: !!opts.public });
  };
  const body = c => { if (!c.body || typeof c.body !== 'object' || Array.isArray(c.body)) throw bad('JSON object body required'); return c.body; };
  const ok = (data, status = 200) => ({ status, data });
  const noContent = () => ({ status: 204 });

  // auth
  route('POST', '/api/auth/register', c => {
    const b = body(c);
    if (!isStr(b.username) || !/^[A-Za-z0-9_.-]{3,32}$/.test(b.username)) throw bad('invalid username');
    if (typeof b.password !== 'string' || b.password.length < 8) throw bad('password must be at least 8 characters');
    if (b.displayName != null && typeof b.displayName !== 'string') throw bad('invalid displayName');
    if (userByName(b.username)) throw conflict('conflict', 'username taken');
    const { salt, hash } = hashPw(b.password);
    const u = { id: uid(), username: b.username, displayName: b.displayName || b.username, salt, hash, createdAt: iso() };
    db.users.push(u);
    return ok({ user: pubUser(u) }, 201);
  }, { public: true });
  route('POST', '/api/auth/login', c => {
    const b = body(c);
    if (!isStr(b.username) || typeof b.password !== 'string') throw bad('username and password required');
    const k = b.username.toLowerCase(); const t = now().getTime();
    const f = (failures.get(k) || []).filter(x => t - x < 15 * 60000); failures.set(k, f);
    if (f.length >= 5) throw new ApiError(429, 'rate_limited', 'too many failed attempts');
    const u = userByName(b.username);
    if (!u || !checkPw(b.password, u)) { f.push(t); throw new ApiError(401, 'invalid_credentials', 'invalid credentials'); }
    failures.delete(k);
    const token = crypto.randomBytes(32).toString('hex');
    db.sessions.push({ hash: sha(token), userId: u.id, createdAt: iso() });
    return ok({ token, user: pubUser(u) });
  }, { public: true });
  route('POST', '/api/auth/logout', c => { db.sessions = db.sessions.filter(s => s.hash !== c.tokenHash); return noContent(); });
  route('GET', '/api/auth/me', c => ok({ user: pubUser(c.user) }));
  route('PATCH', '/api/auth/me', c => {
    const b = body(c); const u = c.user;
    if ('displayName' in b && !isStr(b.displayName)) throw bad('invalid displayName');
    if ('password' in b) {
      if (typeof b.password !== 'string' || b.password.length < 8) throw bad('password must be at least 8 characters');
      if (typeof b.currentPassword !== 'string') throw bad('currentPassword required');
      if (!checkPw(b.currentPassword, u)) throw forbidden('current password incorrect');
      Object.assign(u, hashPw(b.password));
    }
    if ('displayName' in b) u.displayName = b.displayName;
    return ok({ user: pubUser(u) });
  });

  // api tokens
  const memberWs = u => db.workspaces.filter(w => wsRole(u, w));
  route('POST', '/api/tokens', c => {
    const b = body(c); if (!isStr(b.name)) throw bad('name required');
    const token = 'pmt_' + crypto.randomBytes(24).toString('hex');
    const t = { id: uid(), userId: c.user.id, name: b.name, hash: sha(token), createdAt: iso() };
    db.apiTokens.push(t);
    for (const w of memberWs(c.user)) audit(w.id, 'token.created', c.user.id, { tokenId: t.id, name: t.name });
    return ok({ id: t.id, name: t.name, token }, 201);
  });
  route('GET', '/api/tokens', c => ok(db.apiTokens.filter(t => t.userId === c.user.id).map(t => ({ id: t.id, name: t.name, createdAt: t.createdAt }))));
  route('DELETE', '/api/tokens/:id', c => {
    const t = db.apiTokens.find(t => t.id === c.params.id); if (!t) throw notFound();
    if (t.userId !== c.user.id) throw forbidden();
    db.apiTokens = db.apiTokens.filter(x => x !== t);
    for (const w of memberWs(c.user)) audit(w.id, 'token.deleted', c.user.id, { tokenId: t.id, name: t.name });
    return noContent();
  });

  // workspaces
  route('POST', '/api/workspaces', c => {
    const b = body(c);
    if (!isStr(b.name)) throw bad('name required');
    if (typeof b.key !== 'string' || !/^[A-Z]{2,10}$/.test(b.key)) throw bad('key must be 2-10 uppercase letters');
    if (db.workspaces.some(w => w.key === b.key)) throw conflict('conflict', 'workspace key taken');
    const w = { id: uid(), name: b.name.trim(), key: b.key, createdAt: iso(), members: [{ userId: c.user.id, role: 'admin' }] };
    db.workspaces.push(w); audit(w.id, 'workspace.created', c.user.id);
    return ok(wsView(w), 201);
  });
  route('GET', '/api/workspaces', c => ok(memberWs(c.user).map(wsView)));
  route('GET', '/api/workspaces/:id', c => ok(wsView(needWs(c.user, c.params.id).w)));
  route('POST', '/api/workspaces/:id/members', c => {
    const { w } = needWs(c.user, c.params.id, 'admin'); const b = body(c);
    if (!ROLES_WS.includes(b.role)) throw bad('invalid role');
    const u = userByName(b.username); if (!u) throw notFound('user not found');
    if (w.members.some(m => m.userId === u.id)) throw conflict('conflict', 'already a member');
    w.members.push({ userId: u.id, role: b.role });
    audit(w.id, 'member.added', c.user.id, { userId: u.id, username: u.username, role: b.role });
    return ok({ userId: u.id, username: u.username, role: b.role }, 201);
  });
  route('PATCH', '/api/workspaces/:id/members/:userId', c => {
    const { w } = needWs(c.user, c.params.id, 'admin'); const b = body(c);
    if (!ROLES_WS.includes(b.role)) throw bad('invalid role');
    const m = w.members.find(m => m.userId === c.params.userId); if (!m) throw notFound('member not found');
    if (m.role === 'admin' && b.role !== 'admin' && w.members.filter(x => x.role === 'admin').length === 1) throw bad('cannot demote the last admin');
    const from = m.role; m.role = b.role;
    audit(w.id, 'member.role_changed', c.user.id, { userId: m.userId, from, to: b.role });
    return ok({ userId: m.userId, username: userById(m.userId)?.username, role: m.role });
  });
  route('DELETE', '/api/workspaces/:id/members/:userId', c => {
    const { w } = needWs(c.user, c.params.id, 'admin');
    const m = w.members.find(m => m.userId === c.params.userId); if (!m) throw notFound('member not found');
    if (m.role === 'admin' && w.members.filter(x => x.role === 'admin').length === 1) throw bad('cannot remove the last admin');
    w.members = w.members.filter(x => x !== m);
    for (const p of db.projects.filter(p => p.workspaceId === w.id)) p.members = p.members.filter(x => x.userId !== m.userId);
    audit(w.id, 'member.removed', c.user.id, { userId: m.userId });
    return noContent();
  });
  route('GET', '/api/workspaces/:id/audit', c => {
    const { w } = needWs(c.user, c.params.id, 'admin');
    return ok(db.audit.filter(a => a.workspaceId === w.id).slice().reverse());
  });

  // projects
  route('POST', '/api/workspaces/:id/projects', c => {
    const { w, r } = needWs(c.user, c.params.id);
    if (r === 'guest') throw forbidden('guests cannot create projects');
    const b = body(c);
    if (!isStr(b.name)) throw bad('name required');
    if (typeof b.key !== 'string' || !/^[A-Z][A-Z0-9]{1,9}$/.test(b.key)) throw bad('invalid project key');
    if (db.projects.some(p => p.key === b.key)) throw conflict('conflict', 'project key taken');
    const p = { id: uid(), workspaceId: w.id, name: b.name.trim(), key: b.key, createdAt: iso(), nextNumber: 1,
      workflow: DEFAULT_WORKFLOW(), members: [{ userId: c.user.id, role: 'lead' }] };
    db.projects.push(p);
    return ok(projView(p), 201);
  });
  route('GET', '/api/workspaces/:id/projects', c => {
    const { w } = needWs(c.user, c.params.id);
    return ok(db.projects.filter(p => p.workspaceId === w.id && projRole(c.user, p)).map(projView));
  });
  route('GET', '/api/projects/:id', c => ok(projView(needProject(c.user, c.params.id).p)));
  route('POST', '/api/projects/:id/members', c => {
    const { p } = needProject(c.user, c.params.id, 'lead'); const b = body(c);
    if (!ROLES_PR.includes(b.role)) throw bad('invalid role');
    const u = userByName(b.username); if (!u) throw notFound('user not found');
    const w = wsById(p.workspaceId); if (!wsRole(u, w)) throw bad('user is not a workspace member');
    if (p.members.some(m => m.userId === u.id)) throw conflict('conflict', 'already a project member');
    p.members.push({ userId: u.id, role: b.role });
    audit(w.id, 'project.member_added', c.user.id, { projectId: p.id, userId: u.id, role: b.role });
    return ok({ userId: u.id, username: u.username, role: b.role }, 201);
  });
  route('PATCH', '/api/projects/:id/members/:userId', c => {
    const { p } = needProject(c.user, c.params.id, 'lead'); const b = body(c);
    if (!ROLES_PR.includes(b.role)) throw bad('invalid role');
    const m = p.members.find(m => m.userId === c.params.userId); if (!m) throw notFound('member not found');
    m.role = b.role; audit(p.workspaceId, 'project.member_role_changed', c.user.id, { projectId: p.id, userId: m.userId, role: b.role });
    return ok({ userId: m.userId, username: userById(m.userId)?.username, role: m.role });
  });
  route('DELETE', '/api/projects/:id/members/:userId', c => {
    const { p } = needProject(c.user, c.params.id, 'lead');
    const m = p.members.find(m => m.userId === c.params.userId); if (!m) throw notFound('member not found');
    p.members = p.members.filter(x => x !== m);
    audit(p.workspaceId, 'project.member_removed', c.user.id, { projectId: p.id, userId: m.userId });
    return noContent();
  });
  route('PUT', '/api/projects/:id/workflow', c => {
    const { p } = needProject(c.user, c.params.id, 'lead'); const b = body(c);
    if (!Array.isArray(b.statuses) || !b.statuses.length) throw bad('statuses required');
    const names = new Set();
    for (const s of b.statuses) {
      if (!s || !isStr(s.name) || !CATS.includes(s.category)) throw bad('invalid status');
      if (names.has(s.name)) throw bad('duplicate status'); names.add(s.name);
    }
    const statuses = b.statuses.map(s => ({ name: s.name, category: s.category }));
    let transitions;
    if (b.transitions === undefined) transitions = allTransitions(statuses);
    else {
      if (!Array.isArray(b.transitions)) throw bad('transitions must be array');
      for (const t of b.transitions) if (!Array.isArray(t) || t.length !== 2 || !names.has(t[0]) || !names.has(t[1])) throw bad('invalid transition');
      transitions = b.transitions.map(t => [t[0], t[1]]);
    }
    const remap = b.remap && typeof b.remap === 'object' ? b.remap : {};
    const inUse = db.issues.filter(i => i.projectId === p.id && !names.has(i.status));
    for (const i of inUse) {
      const to = remap[i.status];
      if (!to || !names.has(to)) throw bad(`status "${i.status}" is in use and needs a remap`);
    }
    p.workflow = { statuses, transitions };
    const actor = c.user;
    for (const i of inUse) {
      const was = i.status; i.status = remap[was]; record(i, 'status', was, i.status, actor.id);
      i.updatedAt = iso(); setResolved(i, p);
    }
    for (const i of db.issues.filter(i => i.projectId === p.id)) setResolved(i, p);
    audit(p.workspaceId, 'workflow.updated', actor.id, { projectId: p.id });
    return ok({ ...projView(p), statuses, transitions });
  });

  // issues
  route('POST', '/api/projects/:id/issues', c => {
    const { p } = needProject(c.user, c.params.id, 'developer');
    const i = createIssue(p, body(c), c.user);
    return ok(serIssue(i), 201);
  });
  route('GET', '/api/projects/:id/issues', c => {
    const { p } = needProject(c.user, c.params.id);
    return ok(db.issues.filter(i => i.projectId === p.id).map(i => serIssue(i)));
  });
  route('GET', '/api/issues/:key', c => ok(serIssue(needIssue(c.user, c.params.key).i)));
  route('PATCH', '/api/issues/:key', c => {
    const { i, p } = needIssue(c.user, c.params.key, 'developer'); const b = body(c);
    const f = validateFields(p, b, i);
    if ('status' in f) checkTransition(p, i, f.status);
    if (applyPatch(i, p, f, c.user).length) fire('issue.updated', i, c.user.id, p);
    return ok(serIssue(i));
  });
  route('DELETE', '/api/issues/:key', c => {
    const { i, p } = needIssue(c.user, c.params.key, 'developer');
    deleteIssue(i, p, c.user); return noContent();
  });
  route('GET', '/api/issues/:key/history', c => {
    const { i } = needIssue(c.user, c.params.key);
    return ok(histOf(i).map(({ field, from, to, actorId, at }) => ({ field, from, to, actorId, at })));
  });
  route('POST', '/api/issues/:key/links', c => {
    const { i } = needIssue(c.user, c.params.key, 'developer'); const b = body(c);
    if (!LINK_TYPES.includes(b.type)) throw bad('invalid link type');
    if (!isStr(b.target)) throw bad('target required');
    const t = issueByKey(b.target); if (!t) throw notFound('target not found');
    if (!projRole(c.user, projById(t.projectId))) throw forbidden();
    if (t.id === i.id) throw bad('cannot link to self');
    const dup = (a, bb, ty) => (a.links || []).some(l => l.type === ty && l.target === bb.key);
    if (dup(i, t, b.type) || (b.type === 'relates' && dup(t, i, 'relates'))) throw conflict('conflict', 'link exists');
    const l = { id: uid(), type: b.type, target: t.key };
    (i.links = i.links || []).push(l);
    return ok({ id: l.id, type: l.type, target: t.key, key: t.key, source: i.key }, 201);
  });
  route('DELETE', '/api/issues/:key/links/:linkId', c => {
    const { i } = needIssue(c.user, c.params.key, 'developer');
    let found = false;
    for (const o of [i, ...db.issues]) { const n = (o.links || []).length; o.links = (o.links || []).filter(l => l.id !== c.params.linkId); if (o.links.length !== n) found = true; }
    if (!found) throw notFound(); return noContent();
  });
  route('POST', '/api/issues/:key/watch', c => {
    const { i } = needIssue(c.user, c.params.key);
    if (!i.watchers.includes(c.user.id)) i.watchers.push(c.user.id);
    return ok(serIssue(i));
  });
  route('DELETE', '/api/issues/:key/watch', c => {
    const { i } = needIssue(c.user, c.params.key);
    i.watchers = i.watchers.filter(x => x !== c.user.id); return noContent();
  });

  // comments
  const comView = x => ({ id: x.id, issueKey: issueByKey ? db.issues.find(i => i.id === x.issueId)?.key : undefined, authorId: x.authorId,
    body: x.body, edited: x.edited, createdAt: x.createdAt, updatedAt: x.updatedAt });
  route('POST', '/api/issues/:key/comments', c => {
    const { i, p } = needIssue(c.user, c.params.key, 'developer'); const b = body(c);
    if (!isStr(b.body)) throw bad('body required');
    const t = iso();
    const cm = { id: uid(), issueId: i.id, authorId: c.user.id, body: b.body, edited: false, createdAt: t, updatedAt: t };
    db.comments.push(cm);
    const mentioned = new Set();
    for (const m of b.body.matchAll(/@([A-Za-z0-9_.-]+)/g)) {
      const u = userByName(m[1].replace(/[.-]+$/, '')); if (u && projRole(u, p)) mentioned.add(u.id);
    }
    notify([...mentioned], 'mention', i, c.user.id, p);
    notify(i.watchers.filter(w => !mentioned.has(w)), 'comment', i, c.user.id, p);
    i.updatedAt = t;
    fire('comment.created', i, c.user.id, p, { comment: comView(cm) });
    return ok(comView(cm), 201);
  });
  route('GET', '/api/issues/:key/comments', c => {
    const { i } = needIssue(c.user, c.params.key);
    return ok(db.comments.filter(x => x.issueId === i.id).map(comView));
  });
  route('PATCH', '/api/comments/:id', c => {
    const cm = db.comments.find(x => x.id === c.params.id); if (!cm) throw notFound();
    const i = db.issues.find(i => i.id === cm.issueId);
    if (!projRole(c.user, projById(i.projectId))) throw forbidden();
    if (cm.authorId !== c.user.id) throw forbidden('only the author can edit');
    const b = body(c); if (!isStr(b.body)) throw bad('body required');
    cm.body = b.body; cm.edited = true; cm.updatedAt = iso();
    return ok(comView(cm));
  });
  route('DELETE', '/api/comments/:id', c => {
    const cm = db.comments.find(x => x.id === c.params.id); if (!cm) throw notFound();
    const i = db.issues.find(i => i.id === cm.issueId);
    const r = projRole(c.user, projById(i.projectId)); if (!r) throw forbidden();
    if (cm.authorId !== c.user.id && r !== 'lead') throw forbidden();
    db.comments = db.comments.filter(x => x !== cm); return noContent();
  });

  // notifications
  route('GET', '/api/notifications', c => {
    let l = db.notifications.filter(n => n.userId === c.user.id);
    if (c.query.get('unread') === 'true') l = l.filter(n => !n.read);
    return ok(l.slice().reverse().map(({ id, type, issueKey, actorId, at, read }) => ({ id, type, issueKey, actorId, at, read })));
  });
  route('POST', '/api/notifications/read', c => {
    const b = body(c); let n = 0;
    if (b.all !== true && !Array.isArray(b.ids)) throw bad('ids or all required');
    for (const x of db.notifications) if (x.userId === c.user.id && !x.read && (b.all === true || b.ids.includes(x.id))) { x.read = true; n++; }
    return ok({ updated: n });
  });

  // sprints
  const sprintView = s => ({ id: s.id, projectId: s.projectId, name: s.name, state: s.state, startDate: s.startDate, endDate: s.endDate,
    createdAt: s.createdAt, startedAt: s.startedAt || null, completedAt: s.completedAt || null });
  const dateOk = d => d === null || d === undefined || (typeof d === 'string' && !isNaN(Date.parse(d)));
  function needSprint(u, id, min) {
    const s = db.sprints.find(s => s.id === id); if (!s) throw notFound('sprint not found');
    const p = projById(s.projectId); const r = projRole(u, p); if (!r) throw forbidden(); checkMin(r, min);
    return { s, p };
  }
  route('POST', '/api/projects/:id/sprints', c => {
    const { p } = needProject(c.user, c.params.id, 'developer'); const b = body(c);
    if (!isStr(b.name)) throw bad('name required');
    if (!dateOk(b.startDate) || !dateOk(b.endDate)) throw bad('invalid date');
    if (b.startDate && b.endDate && b.endDate < b.startDate) throw bad('endDate before startDate');
    const s = { id: uid(), projectId: p.id, name: b.name.trim(), state: 'planned', startDate: b.startDate ?? null, endDate: b.endDate ?? null, createdAt: iso() };
    db.sprints.push(s); return ok(sprintView(s), 201);
  });
  route('GET', '/api/projects/:id/sprints', c => ok(db.sprints.filter(s => s.projectId === needProject(c.user, c.params.id).p.id).map(sprintView)));
  route('PATCH', '/api/sprints/:id', c => {
    const { s } = needSprint(c.user, c.params.id, 'developer'); const b = body(c);
    if ('name' in b) { if (!isStr(b.name)) throw bad('name'); s.name = b.name; }
    for (const f of ['startDate', 'endDate']) if (f in b) { if (!dateOk(b[f])) throw bad('invalid date'); s[f] = b[f]; }
    return ok(sprintView(s));
  });
  route('GET', '/api/sprints/:id', c => ok(sprintView(needSprint(c.user, c.params.id).s)));
  route('POST', '/api/sprints/:id/start', c => {
    const { s, p } = needSprint(c.user, c.params.id, 'developer');
    if (s.state !== 'planned') throw conflict('conflict', 'sprint is not planned');
    if (db.sprints.some(x => x.projectId === p.id && x.state === 'active')) throw conflict('conflict', 'another sprint is active');
    s.state = 'active'; s.startedAt = iso();
    if (!s.startDate) s.startDate = s.startedAt.slice(0, 10);
    s.committedPoints = db.issues.filter(i => i.sprintId === s.id).reduce((x, i) => x + (Number(i.storyPoints) || 0), 0);
    return ok(sprintView(s));
  });
  route('POST', '/api/sprints/:id/complete', c => {
    const { s, p } = needSprint(c.user, c.params.id, 'developer');
    if (s.state !== 'active') throw conflict('conflict', 'sprint is not active');
    const b = c.body && typeof c.body === 'object' ? c.body : {};
    const to = b.carryOverTo ?? 'backlog'; let target = null;
    if (to !== 'backlog') {
      target = db.sprints.find(x => x.id === to && x.projectId === p.id);
      if (!target || target.state === 'completed' || target.id === s.id) throw bad('invalid carryOverTo');
    }
    let n = 0;
    for (const i of db.issues.filter(i => i.sprintId === s.id && catOf(p, i.status) !== 'completed')) {
      record(i, 'sprintId', i.sprintId, target ? target.id : null, c.user.id);
      i.sprintId = target ? target.id : null; i.updatedAt = iso(); n++;
    }
    s.carriedOver = n; s.state = 'completed'; s.completedAt = iso();
    const rep = sprintReport(s);
    return ok({ ...sprintView(s), report: rep });
  });
  route('GET', '/api/sprints/:id/report', c => ok(sprintReport(needSprint(c.user, c.params.id).s)));

  // stats
  route('GET', '/api/projects/:id/stats', c => {
    const { p } = needProject(c.user, c.params.id);
    const is = db.issues.filter(i => i.projectId === p.id);
    const byStatus = {}, byType = {}, byAssignee = {};
    for (const s of p.workflow.statuses) byStatus[s.name] = 0;
    for (const i of is) {
      byStatus[i.status] = (byStatus[i.status] || 0) + 1;
      byType[i.type] = (byType[i.type] || 0) + 1;
      const a = i.assigneeId ? userById(i.assigneeId)?.username : 'unassigned';
      byAssignee[a] = (byAssignee[a] || 0) + 1;
    }
    const times = [];
    for (const i of is) {
      if (!i.resolvedAt) continue;
      const h = histOf(i).filter(h => h.field === 'status' && catOf(p, h.to) === 'started')[0];
      if (h) times.push((new Date(i.resolvedAt) - new Date(h.at)) / 3600000);
    }
    const avg = times.length ? times.reduce((a, b) => a + b, 0) / times.length : null;
    return ok({ total: is.length, byStatus, byType, byAssignee, averageCycleTimeHours: avg, avgCycleTimeHours: avg,
      by_status: byStatus, by_type: byType, by_assignee: byAssignee, avg_cycle_time_hours: avg, resolvedCount: times.length });
  });

  // search
  route('GET', '/api/search', c => {
    const q = c.query.get('q') || '';
    const toks = tokenize(q);
    const match = buildMatcher(toks, c.user);
    const sort = c.query.get('sort') || 'updated';
    if (!['updated', 'created', 'priority'].includes(sort)) throw bad('invalid sort');
    let pf = c.query.get('project'); let pid = null;
    if (pf) {
      const p = db.projects.find(p => p.id === pf || p.key === pf); if (!p) throw notFound('project not found');
      if (!projRole(c.user, p)) throw forbidden(); pid = p.id;
    }
    let res = db.issues.filter(i => (!pid || i.projectId === pid) && projRole(c.user, projById(i.projectId)) && match(i));
    const rank = i => PRIOS.indexOf(i.priority);
    const ord = db.issues.reduce((m, i, n) => m.set(i.id, n), new Map());
    res.sort((a, b) => {
      if (sort === 'priority') { const d = rank(a) - rank(b); if (d) return d; }
      const f = sort === 'created' ? 'createdAt' : 'updatedAt';
      return a[f] < b[f] ? 1 : a[f] > b[f] ? -1 : ord.get(b.id) - ord.get(a.id);
    });
    return ok(res.map(i => serIssue(i)));
  });

  // CSV
  const HEADER = ['key', 'type', 'title', 'status', 'priority', 'assignee', 'labels', 'storyPoints', 'parent', 'epic', 'sprint', 'dueDate', 'createdAt', 'resolvedAt'];
  route('GET', '/api/projects/:id/export.csv', c => {
    const { p } = needProject(c.user, c.params.id);
    const rows = [HEADER];
    for (const i of db.issues.filter(i => i.projectId === p.id)) rows.push([i.key, i.type, i.title, i.status, i.priority,
      userById(i.assigneeId)?.username || '', i.labels.join(';'), i.storyPoints ?? '', refKey(i.parentId) || '', refKey(i.epicId) || '',
      db.sprints.find(s => s.id === i.sprintId)?.name || '', i.dueDate || '', i.createdAt, i.resolvedAt || '']);
    return { status: 200, raw: toCSV(rows), type: 'text/csv; charset=utf-8' };
  });
  route('POST', '/api/projects/:id/import.csv', c => {
    const { p } = needProject(c.user, c.params.id, 'developer');
    const text = typeof c.raw === 'string' ? c.raw.replace(/^﻿/, '') : '';
    const rows = parseCSV(text).filter(r => !(r.length === 1 && r[0] === ''));
    if (!rows.length) throw bad('empty CSV');
    const head = rows[0].map(h => h.trim());
    if (!head.includes('title')) throw bad('missing title column');
    let created = 0; const errors = [];
    rows.slice(1).forEach((r, n) => {
      const line = n + 2; const g = {};
      head.forEach((h, k) => { g[h] = (r[k] ?? '').trim(); });
      try {
        if (r.length > head.length) throw bad('too many columns');
        const b = { title: g.title, type: g.type || 'task' };
        if (g.status) b.status = g.status;
        if (g.priority) b.priority = g.priority;
        if (g.assignee) { const u = userByName(g.assignee); if (!u) throw bad('unknown assignee ' + g.assignee); b.assigneeId = u.id; }
        if (g.labels) b.labels = g.labels.split(';').map(s => s.trim()).filter(Boolean);
        if (g.storyPoints) { const v = Number(g.storyPoints); if (!isFinite(v)) throw bad('invalid storyPoints'); b.storyPoints = v; }
        if (g.parent) b.parentId = g.parent;
        if (g.epic) b.epicId = g.epic;
        if (g.sprint) { const s = db.sprints.find(s => s.projectId === p.id && s.name === g.sprint && s.state !== 'completed'); if (!s) throw bad('unknown sprint ' + g.sprint); b.sprintId = s.id; }
        if (g.dueDate) b.dueDate = g.dueDate;
        if (g.parent && !issueByRef(g.parent, p.id)) throw bad('unknown parent ' + g.parent);
        if (g.epic && !issueByRef(g.epic, p.id)) throw bad('unknown epic ' + g.epic);
        createIssue(p, b, c.user);
        created++;
      } catch (e) {
        if (e instanceof ApiError) errors.push({ line, message: e.message }); else throw e;
      }
    });
    return ok({ created, errors });
  });

  // webhooks
  const whView = w => ({ id: w.id, projectId: w.projectId, url: w.url, events: w.events, createdAt: w.createdAt });
  route('POST', '/api/projects/:id/webhooks', c => {
    const { p } = needProject(c.user, c.params.id, 'lead'); const b = body(c);
    if (!isStr(b.url) || !/^https?:\/\//i.test(b.url)) throw bad('invalid url');
    try { new URL(b.url); } catch { throw bad('invalid url'); }
    if (!Array.isArray(b.events) || !b.events.length || b.events.some(e => !EVENTS.includes(e))) throw bad('invalid events');
    if (!isStr(b.secret)) throw bad('secret required');
    const w = { id: uid(), projectId: p.id, url: b.url, events: [...new Set(b.events)], secret: b.secret, createdAt: iso() };
    db.webhooks.push(w); audit(p.workspaceId, 'webhook.created', c.user.id, { webhookId: w.id, projectId: p.id, url: w.url });
    return ok(whView(w), 201);
  });
  route('GET', '/api/projects/:id/webhooks', c => {
    const { p } = needProject(c.user, c.params.id, 'lead');
    return ok(db.webhooks.filter(w => w.projectId === p.id).map(whView));
  });
  function needWebhook(u, id) {
    const w = db.webhooks.find(w => w.id === id); if (!w) throw notFound('webhook not found');
    const p = projById(w.projectId); const r = projRole(u, p); if (!r) throw forbidden(); checkMin(r, 'lead'); return { w, p };
  }
  route('DELETE', '/api/webhooks/:id', c => {
    const { w, p } = needWebhook(c.user, c.params.id);
    db.webhooks = db.webhooks.filter(x => x !== w);
    audit(p.workspaceId, 'webhook.deleted', c.user.id, { webhookId: w.id, projectId: p.id });
    return noContent();
  });
  route('GET', '/api/webhooks/:id/deliveries', c => {
    const { w } = needWebhook(c.user, c.params.id);
    return ok(db.deliveries.filter(d => d.webhookId === w.id).map(d => ({ id: d.id, event: d.event, status: d.status, attempts: d.attempts, lastError: d.lastError, at: d.at })));
  });

  // ---------- http plumbing ----------
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
  function sendStatic(res, rel) {
    const f = path.resolve(STATIC_DIR, rel);
    if (!f.startsWith(STATIC_DIR + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return false;
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' });
    res.end(fs.readFileSync(f)); return true;
  }
  const send = (res, status, data) => {
    if (status === 204) { res.writeHead(204); return res.end(); }
    const s = JSON.stringify(data);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(s) }); res.end(s);
  };
  function authenticate(req) {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || ''); if (!m) return null;
    const h = sha(m[1].trim());
    const s = db.sessions.find(s => s.hash === h) || db.apiTokens.find(t => t.hash === h);
    const u = s && userById(s.userId);
    return u ? { user: u, tokenHash: h } : null;
  }

  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      try {
        const url = new URL(req.url, 'http://x');
        const p = url.pathname;
        if (req.method === 'GET' && !p.startsWith('/api/')) {
          if (p === '/' || p === '/index.html') { if (sendStatic(res, 'index.html')) return; }
          else if (p.startsWith('/static/') && sendStatic(res, decodeURIComponent(p.slice(8)))) return;
          return send(res, 404, { error: 'not_found', message: 'not found' });
        }
        let matched = null, pathMatched = false;
        for (const r of routes) {
          const m = r.re.exec(p); if (!m) continue;
          pathMatched = true;
          if (r.method === req.method) { matched = { r, m }; break; }
        }
        if (!matched) return send(res, pathMatched ? 405 : 404, { error: pathMatched ? 'method_not_allowed' : 'not_found', message: 'no such route' });
        const ctx = { query: url.searchParams, params: {}, body: null, raw: null };
        matched.r.keys.forEach((k, n) => { ctx.params[k] = decodeURIComponent(matched.m[n + 1]); });
        const rawText = Buffer.concat(chunks).toString('utf8');
        if (!matched.r.public) {
          const a = authenticate(req);
          if (!a) throw new ApiError(401, 'unauthenticated', 'authentication required');
          ctx.user = a.user; ctx.tokenHash = a.tokenHash;
        }
        ctx.raw = rawText;
        if (rawText && !/text\/csv/i.test(req.headers['content-type'] || '')) {
          try { ctx.body = JSON.parse(rawText); } catch { throw bad('invalid JSON body'); }
        }
        const out = matched.r.handler(ctx);
        if (req.method !== 'GET') save();
        if (out.raw !== undefined) {
          res.writeHead(out.status, { 'content-type': out.type }); return res.end(out.raw);
        }
        send(res, out.status, out.data);
      } catch (e) {
        if (e instanceof ApiError) return send(res, e.status, { error: e.code, message: e.message });
        console.error(e);
        send(res, 500, { error: 'internal_error', message: 'internal error' });
      }
    });
  });
}
