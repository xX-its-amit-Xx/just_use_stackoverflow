import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');
const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIOS = ['urgent', 'high', 'medium', 'low', 'none'];
const CATS = ['backlog', 'unstarted', 'started', 'completed'];
const LINK_TYPES = ['blocks', 'relates', 'duplicates'];
const INVERSE = { blocks: 'blocked_by', relates: 'relates', duplicates: 'duplicated_by' };
const EVENTS = ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'];
const DEFAULT_STATUSES = [['Backlog', 'backlog'], ['Todo', 'unstarted'], ['In Progress', 'started'], ['In Review', 'started'], ['Done', 'completed']];
const TRACKED = ['type', 'title', 'description', 'status', 'priority', 'assigneeId', 'labels', 'storyPoints', 'parentId', 'epicId', 'sprintId', 'dueDate'];

class HttpError extends Error { constructor(status, code, message) { super(message); this.status = status; this.code = code; } }
const fail = (s, c, m) => { throw new HttpError(s, c, m || c); };
const bad = (m) => fail(400, 'validation_error', m);
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const uid = () => crypto.randomUUID();
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const hashPw = (pw) => { const salt = crypto.randomBytes(16).toString('hex'); return `scrypt$${salt}$${crypto.scryptSync(pw, salt, 32).toString('hex')}`; };
const checkPw = (pw, h) => { const [, salt, hex] = h.split('$'); const a = Buffer.from(crypto.scryptSync(pw, salt, 32).toString('hex')); return crypto.timingSafeEqual(a, Buffer.from(hex)); };
const isStr = (v) => typeof v === 'string' && v.trim().length > 0;

export function createServer({ dataFile, clock } = {}) {
  const now = () => (clock ? clock() : new Date());
  const iso = () => now().toISOString();
  let db = { users: [], sessions: [], tokens: [], workspaces: [], projects: [], issues: [], comments: [], notifications: [], sprints: [], webhooks: [], deliveries: [], audit: [], seq: 0 };
  if (dataFile && fs.existsSync(dataFile)) { try { db = { ...db, ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) }; } catch { /* ignore */ } }
  const save = () => {
    if (!dataFile) return;
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, dataFile);
  };
  const loginFails = new Map();

  // ---------- helpers ----------
  const userById = (id) => db.users.find(u => u.id === id);
  const userByName = (n) => typeof n === 'string' ? db.users.find(u => u.username.toLowerCase() === n.toLowerCase()) : null;
  const pubUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName, createdAt: u.createdAt });
  const clean = (o) => { const r = {}; for (const k of Object.keys(o)) if (!k.startsWith('_')) r[k] = o[k]; return r; };
  const audit = (ws, actor, action, details) => db.audit.push({ id: uid(), workspaceId: ws.id, action, type: action, actorId: actor.id, at: iso(), details: details || {} });

  const wsMember = (ws, u) => ws.members.find(m => m.userId === u.id);
  const projRole = (p, u) => {
    const ws = db.workspaces.find(w => w.id === p.workspaceId); if (!ws) return null;
    const m = wsMember(ws, u); if (!m) return null;
    if (m.role === 'admin') return 'lead';
    const pm = p.members.find(x => x.userId === u.id);
    if (m.role === 'guest') return pm ? pm.role : null;
    return pm ? pm.role : 'developer';
  };
  const RANK = { viewer: 0, developer: 1, lead: 2 };
  const getWs = (id, u, minRole) => {
    const ws = db.workspaces.find(w => w.id === id); const m = ws && wsMember(ws, u);
    if (!ws || !m) fail(404, 'not_found', 'workspace not found');
    if (minRole === 'admin' && m.role !== 'admin') fail(403, 'forbidden', 'admin only');
    if (minRole === 'member' && m.role === 'guest') fail(403, 'forbidden', 'members only');
    return ws;
  };
  const getProj = (id, u, min = 'viewer') => {
    const p = db.projects.find(x => x.id === id); const r = p && projRole(p, u);
    if (!p || !r) fail(404, 'not_found', 'project not found');
    if (RANK[r] < RANK[min]) fail(403, 'forbidden', 'insufficient role');
    return p;
  };
  const getIssue = (key, u, min = 'viewer') => {
    const i = db.issues.find(x => x.key.toLowerCase() === String(key).toLowerCase());
    if (!i) fail(404, 'not_found', 'issue not found');
    const p = getProj(i.projectId, u, min); return { i, p };
  };
  const statusCat = (p, name) => (p.workflow.statuses.find(s => s.name === name) || {}).category;
  const initialStatus = (p) => (p.workflow.statuses.find(s => s.category === 'unstarted') || p.workflow.statuses[0]).name;

  const notify = (userId, type, issue, actorId) => {
    db.notifications.push({ id: uid(), userId, type, issueKey: issue.key, actorId, at: iso(), read: false, _seq: ++db.seq });
  };
  const notifyUsers = (ids, type, issue, actor, p) => {
    for (const id of new Set(ids)) { if (id === actor.id || !id) continue; const u = userById(id); if (u && projRole(p, u)) notify(id, type, issue, actor.id); }
  };

  const outIssue = (i, full) => {
    const o = clean(i);
    const links = [];
    for (const l of db.issues.flatMap(x => x._links || [])) {
      if (l.source === i.id) { const t = db.issues.find(x => x.id === l.target); if (t) links.push({ id: l.id, type: l.type, target: t.key, key: t.key }); }
      else if (l.target === i.id) { const s = db.issues.find(x => x.id === l.source); if (s) links.push({ id: l.id, type: INVERSE[l.type], target: s.key, key: s.key }); }
    }
    o.links = links;
    if (full) {
      o.children = db.issues.filter(x => x.parentId === i.id).map(x => x.key);
      if (i.type === 'epic') {
        const ch = db.issues.filter(x => x.epicId === i.id);
        o.progress = { total: ch.length, done: ch.filter(x => x.resolvedAt).length, points_total: ch.reduce((a, x) => a + (x.storyPoints || 0), 0), points_done: ch.filter(x => x.resolvedAt).reduce((a, x) => a + (x.storyPoints || 0), 0) };
      }
    }
    return o;
  };

  // webhooks
  const fire = (p, event, issue, actor, extra) => {
    for (const w of db.webhooks.filter(x => x.projectId === p.id && x.events.includes(event))) {
      const payload = { event, issue: outIssue(issue), actorId: actor.id, at: iso(), ...(extra || {}) };
      const body = JSON.stringify(payload);
      const d = { id: uid(), webhookId: w.id, event, status: 'pending', attempts: 0, lastError: null, at: iso() };
      db.deliveries.push(d);
      (async () => {
        for (let a = 1; a <= 3; a++) {
          d.attempts = a;
          try {
            const r = await fetch(w.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pm-signature': 'sha256=' + crypto.createHmac('sha256', w.secret).update(body).digest('hex') }, body, signal: AbortSignal.timeout(5000) });
            if (r.ok) { d.status = 'delivered'; d.lastError = null; d.responseStatus = r.status; break; }
            d.lastError = 'HTTP ' + r.status;
          } catch (e) { d.lastError = String(e.message || e); }
          d.status = 'failed';
          if (a < 3) await new Promise(r => setTimeout(r, 50 * a));
        }
        try { save(); } catch { /* ignore */ }
      })();
    }
  };

  // ---------- issue logic ----------
  const record = (i, field, from, to, actor) => {
    if (JSON.stringify(from) === JSON.stringify(to)) return;
    i.history.push({ field, from: from ?? null, to: to ?? null, actorId: actor.id, at: iso() });
  };
  const setResolved = (i, p, status) => {
    const completed = statusCat(p, status) === 'completed';
    const prev = i.resolvedAt;
    if (completed && !prev) { i.resolvedAt = iso(); i._resolveLog.push({ at: i.resolvedAt, resolved: true }); }
    else if (!completed && prev) { i.resolvedAt = null; i._resolveLog.push({ at: iso(), resolved: false }); }
    if (statusCat(p, status) === 'started' && !i._startedAt) i._startedAt = iso();
  };
  const validateRefs = (p, f, selfType, self) => {
    if (f.assigneeId != null) { const u = userById(f.assigneeId); if (!u || !projRole(p, u)) bad('invalid assignee'); }
    if (f.parentId != null) {
      const par = db.issues.find(x => x.id === f.parentId);
      if (!par || par.projectId !== p.id) bad('parent must be in the same project');
      if (par.type === 'subtask') bad('parent cannot be a subtask');
      if (self && par.id === self.id) bad('cannot parent itself');
      if (selfType === 'epic') bad('epics cannot have parents');
    } else if (selfType === 'subtask') bad('subtask requires parentId');
    if (selfType !== 'subtask' && f.parentId != null && selfType !== 'epic') bad('only subtasks can have a parent');
    if (f.epicId != null) { const e = db.issues.find(x => x.id === f.epicId); if (!e || e.projectId !== p.id || e.type !== 'epic') bad('epicId must reference an epic'); }
    if (f.sprintId != null) { const s = db.sprints.find(x => x.id === f.sprintId); if (!s || s.projectId !== p.id) bad('invalid sprint'); if (s.state === 'completed') bad('sprint is completed'); }
  };
  const normLabels = (l) => { if (!Array.isArray(l) || l.some(x => !isStr(x))) bad('labels must be an array of strings'); return [...new Set(l.map(x => x.trim()))]; };
  const checkFields = (b, p) => {
    if (b.type !== undefined && !TYPES.includes(b.type)) bad('invalid type');
    if (b.title !== undefined && !isStr(b.title)) bad('title required');
    if (b.description !== undefined && b.description !== null && typeof b.description !== 'string') bad('invalid description');
    if (b.priority !== undefined && !PRIOS.includes(b.priority)) bad('invalid priority');
    if (b.storyPoints !== undefined && b.storyPoints !== null && !(typeof b.storyPoints === 'number' && isFinite(b.storyPoints) && b.storyPoints >= 0)) bad('invalid storyPoints');
    if (b.dueDate !== undefined && b.dueDate !== null && !isDate(b.dueDate)) bad('invalid dueDate');
    if (b.status !== undefined && !p.workflow.statuses.some(s => s.name === b.status)) bad('unknown status');
  };
  function createIssue(p, actor, b, silent) {
    checkFields(b, p);
    if (!TYPES.includes(b.type)) bad('type is required');
    if (!isStr(b.title)) bad('title is required');
    const f = { assigneeId: b.assigneeId ?? null, parentId: b.parentId ?? null, epicId: b.epicId ?? null, sprintId: b.sprintId ?? null };
    validateRefs(p, f, b.type, null);
    const n = p.nextNumber++;
    const status = b.status || initialStatus(p);
    const i = {
      id: uid(), key: `${p.key}-${n}`, projectId: p.id, type: b.type, title: b.title.trim(), description: b.description || '', status,
      priority: b.priority || 'none', assigneeId: f.assigneeId, reporterId: actor.id, labels: b.labels !== undefined ? normLabels(b.labels) : [],
      storyPoints: b.storyPoints ?? null, parentId: f.parentId, epicId: f.epicId, sprintId: f.sprintId, dueDate: b.dueDate ?? null,
      watchers: [], createdAt: iso(), updatedAt: iso(), resolvedAt: null, history: [], _resolveLog: [], _links: [], _seq: ++db.seq,
    };
    i.watchers.push(actor.id); if (i.assigneeId && !i.watchers.includes(i.assigneeId)) i.watchers.push(i.assigneeId);
    setResolved(i, p, status);
    db.issues.push(i);
    if (i.sprintId) { const s = db.sprints.find(x => x.id === i.sprintId); (s._ever ||= []).push(i.id); }
    if (i.assigneeId && !silent) notifyUsers([i.assigneeId], 'assigned', i, actor, p);
    if (!silent) fire(p, 'issue.created', i, actor);
    return i;
  }
  function updateIssue(i, p, actor, b) {
    checkFields(b, p);
    const before = { ...i, labels: [...i.labels] };
    const f = {};
    for (const k of ['assigneeId', 'parentId', 'epicId', 'sprintId']) f[k] = b[k] !== undefined ? b[k] : i[k];
    const newType = b.type !== undefined ? b.type : i.type;
    if (b.type !== undefined || b.parentId !== undefined || b.epicId !== undefined || b.sprintId !== undefined || b.assigneeId !== undefined) {
      const chk = { ...f };
      if (b.assigneeId === undefined) chk.assigneeId = null;
      if (b.epicId === undefined) chk.epicId = null;
      if (b.sprintId === undefined || b.sprintId === i.sprintId) chk.sprintId = null;
      validateRefs(p, chk, newType, i);
      if (newType === 'epic' && db.issues.some(x => x.parentId === i.id)) bad('epic cannot have subtasks');
    }
    if (b.status !== undefined && b.status !== i.status) {
      const ok = p.workflow.transitions.some(t => t[0] === i.status && t[1] === b.status);
      if (!ok) fail(409, 'invalid_transition', `cannot move from ${i.status} to ${b.status}`);
      if (statusCat(p, b.status) === 'completed') {
        const blocked = db.issues.some(x => (x._links || []).some(l => l.type === 'blocks' && l.target === i.id) && !db.issues.find(y => y.id === x.id).resolvedAt);
        if (blocked) fail(409, 'blocked', 'issue is blocked by an unresolved issue');
      }
    }
    for (const k of TRACKED) {
      if (b[k] === undefined) continue;
      if (k === 'labels') continue;
      i[k] = k === 'title' ? b[k].trim() : (k === 'priority' || k === 'type' || k === 'status' ? b[k] : (b[k] ?? (k === 'description' ? '' : null)));
    }
    if (b.labels !== undefined) i.labels = normLabels(b.labels);
    if (b.status !== undefined) setResolved(i, p, i.status);
    for (const k of TRACKED) record(i, k, before[k], i[k], actor);
    if (i.sprintId && i.sprintId !== before.sprintId) { const s = db.sprints.find(x => x.id === i.sprintId); (s._ever ||= []); if (!s._ever.includes(i.id)) s._ever.push(i.id); }
    const changed = TRACKED.some(k => JSON.stringify(before[k]) !== JSON.stringify(i[k]));
    if (changed) i.updatedAt = iso();
    if (i.assigneeId !== before.assigneeId && i.assigneeId) { if (!i.watchers.includes(i.assigneeId)) i.watchers.push(i.assigneeId); }
    if (i.status !== before.status) notifyUsers(i.watchers, 'status_changed', i, actor, p);
    if (i.assigneeId !== before.assigneeId && i.assigneeId) notifyUsers([i.assigneeId], 'assigned', i, actor, p);
    if (changed) fire(p, 'issue.updated', i, actor);
  }
  function deleteIssue(i, p, actor) {
    const kids = db.issues.filter(x => x.parentId === i.id);
    for (const k of kids) deleteIssue(k, p, actor);
    db.issues = db.issues.filter(x => x.id !== i.id);
    for (const x of db.issues) { if (x.epicId === i.id) x.epicId = null; x._links = (x._links || []).filter(l => l.target !== i.id); }
    db.comments = db.comments.filter(c => c.issueId !== i.id);
    fire(p, 'issue.deleted', i, actor);
  }

  // ---------- CSV ----------
  const csvEsc = (v) => { v = v == null ? '' : String(v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const parseCsv = (text) => {
    const rows = []; let row = [], f = '', q = false, line = 1, rowLine = 1, any = false;
    for (let k = 0; k < text.length; k++) {
      const c = text[k];
      if (q) {
        if (c === '"') { if (text[k + 1] === '"') { f += '"'; k++; } else q = false; }
        else { if (c === '\n') line++; f += c; }
      } else if (c === '"' && f === '') { q = true; any = true; }
      else if (c === ',') { row.push(f); f = ''; any = true; }
      else if (c === '\r') { /* skip */ }
      else if (c === '\n') { if (any || f !== '' || row.length) { row.push(f); rows.push({ line: rowLine, cells: row }); } row = []; f = ''; any = false; line++; rowLine = line; }
      else { f += c; any = true; }
    }
    if (q) { rows.push({ line: rowLine, cells: null, error: 'unterminated quote' }); return rows; }
    if (any || f !== '' || row.length) { row.push(f); rows.push({ line: rowLine, cells: row }); }
    return rows;
  };

  // ---------- search ----------
  const FIELDS = ['status', 'type', 'priority', 'assignee', 'label', 'sprint', 'is', 'due', 'points', 'key'];
  function parseQuery(q) {
    const terms = []; let k = 0; const n = q.length;
    const readWord = () => {
      let s = '', quoted = false;
      while (k < n && !/\s/.test(q[k])) {
        if (q[k] === '"') { quoted = true; k++; let closed = false; while (k < n) { if (q[k] === '"') { closed = true; k++; break; } s += q[k++]; } if (!closed) bad('unterminated quote'); }
        else s += q[k++];
      }
      return { s, quoted };
    };
    while (k < n) {
      if (/\s/.test(q[k])) { k++; continue; }
      let neg = false;
      if (q[k] === '-') { neg = true; k++; if (k >= n || /\s/.test(q[k])) bad('dangling negation'); }
      const startK = k;
      const { s, quoted } = readWord();
      const m = !q.slice(startK).startsWith('"') && /^([A-Za-z]+):/.exec(q.slice(startK));
      if (m) {
        const field = m[1].toLowerCase();
        if (!FIELDS.includes(field)) bad('unknown field ' + field);
        const val = s.slice(s.indexOf(':') + 1);
        if (val === '') bad('empty value for ' + field);
        const t = { neg, field, val };
        if (field === 'type' && !TYPES.includes(val.toLowerCase())) bad('invalid type');
        if (field === 'priority' && !PRIOS.includes(val.toLowerCase())) bad('invalid priority');
        if (field === 'is' && !['open', 'resolved'].includes(val.toLowerCase())) bad('invalid is:');
        if (field === 'due') { const mm = /^([<>]=?|=)?(\d{4}-\d{2}-\d{2})$/.exec(val); if (!mm || !isDate(mm[2])) bad('invalid due'); t.op = mm[1] || '='; t.val = mm[2]; }
        if (field === 'points') { const mm = /^([<>]=?|=)?(\d+(?:\.\d+)?)$/.exec(val); if (!mm) bad('invalid points'); t.op = mm[1] || '='; t.val = Number(mm[2]); }
        terms.push(t);
      } else { if (s === '' && !quoted) bad('empty term'); terms.push({ neg, field: 'text', val: s }); }
    }
    return terms;
  }
  const cmp = (a, op, b) => op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : op === '>=' ? a >= b : a === b;
  function matches(i, t, user) {
    const v = String(t.val).toLowerCase();
    switch (t.field) {
      case 'status': return i.status.toLowerCase() === v;
      case 'type': return i.type === v;
      case 'priority': return i.priority === v;
      case 'assignee': {
        if (v === 'none') return !i.assigneeId;
        if (v === 'me') return i.assigneeId === user.id;
        const u = userByName(t.val); return !!u && i.assigneeId === u.id;
      }
      case 'label': return i.labels.some(l => l.toLowerCase() === v);
      case 'sprint': {
        if (v === 'none') return !i.sprintId;
        const s = db.sprints.find(x => x.id === i.sprintId);
        if (v === 'active') return !!s && s.state === 'active';
        return i.sprintId === t.val;
      }
      case 'is': return v === 'open' ? !i.resolvedAt : !!i.resolvedAt;
      case 'due': return !!i.dueDate && cmp(i.dueDate, t.op, t.val);
      case 'points': return i.storyPoints != null && cmp(i.storyPoints, t.op, t.val);
      case 'key': return i.key.toLowerCase() === v;
      default: return (i.title + '\n' + (i.description || '')).toLowerCase().includes(v);
    }
  }

  // ---------- sprint report ----------
  const dayStr = (d) => d.toISOString().slice(0, 10);
  function sprintReport(s) {
    const ever = (s._ever || []).map(id => db.issues.find(x => x.id === id)).filter(Boolean);
    const pts = (i) => i.storyPoints || 0;
    const burndown = [];
    if (s._startedDay) {
      const end = s.endDate ? s.endDate.slice(0, 10) : null; const today = dayStr(now());
      const last = end && end < today ? end : today;
      for (let d = new Date(s._startedDay + 'T00:00:00Z'); dayStr(d) <= last; d = new Date(d.getTime() + 86400000)) {
        const eod = new Date(d.getTime() + 86400000 - 1).toISOString();
        let rem = 0;
        for (const i of ever) {
          if (i.createdAt > eod && !(s._committed || []).includes(i.id)) { /* not yet existing */ }
          let resolved = false;
          for (const e of i._resolveLog) if (e.at <= eod) resolved = e.resolved;
          if (!resolved) rem += pts(i);
        }
        burndown.push({ date: dayStr(d), remainingPoints: rem });
      }
    }
    const inSprintNow = ever.filter(i => i.sprintId === s.id);
    const done = s.state === 'completed' ? (s._completedIds || []).map(id => db.issues.find(x => x.id === id)).filter(Boolean) : inSprintNow.filter(i => i.resolvedAt);
    return {
      committedPoints: s._committedPoints || 0,
      completedPoints: done.reduce((a, i) => a + pts(i), 0),
      completedIssues: done.length,
      carriedOver: s._carried || 0,
      burndown,
    };
  }

  // ---------- routing ----------
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = []; const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
    routes.push({ method, re, keys, handler, auth: opts.auth !== false });
  };

  // auth
  route('POST', '/api/auth/register', ({ body }) => {
    const { username, password, displayName } = body || {};
    if (typeof username !== 'string' || !/^[A-Za-z0-9_.-]{3,32}$/.test(username)) bad('username must be 3-32 characters (letters, digits, _ . -)');
    if (typeof password !== 'string' || password.length < 8) bad('password must be at least 8 characters');
    if (displayName !== undefined && typeof displayName !== 'string') bad('invalid displayName');
    if (userByName(username)) fail(409, 'conflict', 'username taken');
    const u = { id: uid(), username, displayName: displayName || username, passwordHash: hashPw(password), createdAt: iso() };
    db.users.push(u);
    return [201, pubUser(u)];
  }, { auth: false });
  route('POST', '/api/auth/login', ({ body }) => {
    const { username, password } = body || {};
    if (typeof username !== 'string' || typeof password !== 'string') bad('username and password required');
    const k = username.toLowerCase(); const t = Date.now();
    const rec = (loginFails.get(k) || []).filter(x => t - x < 60000);
    if (rec.length >= 10) { loginFails.set(k, rec); fail(429, 'rate_limited', 'too many failed attempts'); }
    const u = userByName(username);
    if (!u || !checkPw(password, u.passwordHash)) { rec.push(t); loginFails.set(k, rec); fail(401, 'unauthorized', 'invalid credentials'); }
    loginFails.delete(k);
    const token = crypto.randomBytes(32).toString('hex');
    db.sessions.push({ hash: sha(token), userId: u.id, createdAt: iso() });
    return [200, { token, user: pubUser(u) }];
  }, { auth: false });
  route('POST', '/api/auth/logout', ({ tokenHash }) => { db.sessions = db.sessions.filter(s => s.hash !== tokenHash); return [204]; });
  route('GET', '/api/auth/me', ({ user }) => [200, pubUser(user)]);
  route('PATCH', '/api/auth/me', ({ user, body }) => {
    const { displayName, password, currentPassword } = body || {};
    if (displayName !== undefined && !isStr(displayName)) bad('invalid displayName');
    if (password !== undefined) {
      if (typeof password !== 'string' || password.length < 8) bad('password must be at least 8 characters');
      if (typeof currentPassword !== 'string') bad('currentPassword required');
      if (!checkPw(currentPassword, user.passwordHash)) fail(403, 'forbidden', 'current password incorrect');
      user.passwordHash = hashPw(password);
    }
    if (displayName !== undefined) user.displayName = displayName;
    return [200, pubUser(user)];
  });
  route('GET', '/api/users', ({ user, query }) => {
    const mine = new Set(db.workspaces.filter(w => wsMember(w, user)).flatMap(w => w.members.map(m => m.userId)));
    return [200, db.users.filter(u => mine.has(u.id)).map(pubUser)];
  });

  // tokens
  route('POST', '/api/tokens', ({ user, body }) => {
    if (!isStr(body?.name)) bad('name required');
    const token = 'pm_' + crypto.randomBytes(24).toString('hex');
    const t = { id: uid(), name: body.name, userId: user.id, hash: sha(token), createdAt: iso() };
    db.tokens.push(t);
    for (const w of db.workspaces) if (wsMember(w, user)) audit(w, user, 'token.created', { tokenId: t.id, name: t.name });
    return [201, { id: t.id, name: t.name, token }];
  });
  route('GET', '/api/tokens', ({ user }) => [200, db.tokens.filter(t => t.userId === user.id).map(t => ({ id: t.id, name: t.name, createdAt: t.createdAt }))]);
  route('DELETE', '/api/tokens/:id', ({ user, params }) => {
    const t = db.tokens.find(x => x.id === params.id && x.userId === user.id); if (!t) fail(404, 'not_found', 'token not found');
    db.tokens = db.tokens.filter(x => x !== t);
    for (const w of db.workspaces) if (wsMember(w, user)) audit(w, user, 'token.deleted', { tokenId: t.id, name: t.name });
    return [204];
  });

  // workspaces
  const outWs = (w) => ({ id: w.id, name: w.name, key: w.key, createdAt: w.createdAt, members: w.members.map(m => ({ userId: m.userId, username: userById(m.userId)?.username, role: m.role })) });
  route('POST', '/api/workspaces', ({ user, body }) => {
    const { name, key } = body || {};
    if (!isStr(name)) bad('name required');
    if (typeof key !== 'string' || !/^[A-Z]{2,10}$/.test(key)) bad('key must be 2-10 uppercase letters');
    if (db.workspaces.some(w => w.key === key)) fail(409, 'conflict', 'workspace key taken');
    const w = { id: uid(), name: name.trim(), key, createdAt: iso(), members: [{ userId: user.id, role: 'admin' }] };
    db.workspaces.push(w); audit(w, user, 'workspace.created', { key });
    return [201, outWs(w)];
  });
  route('GET', '/api/workspaces', ({ user }) => [200, db.workspaces.filter(w => wsMember(w, user)).map(outWs)]);
  route('GET', '/api/workspaces/:id', ({ user, params }) => [200, outWs(getWs(params.id, user))]);
  const roleCheck = (r) => { if (!['admin', 'member', 'guest'].includes(r)) bad('role must be admin, member or guest'); };
  route('POST', '/api/workspaces/:id/members', ({ user, params, body }) => {
    const ws = getWs(params.id, user, 'admin');
    const u = userByName(body?.username); roleCheck(body?.role);
    if (!u) fail(404, 'not_found', 'user not found');
    if (wsMember(ws, u)) fail(409, 'conflict', 'already a member');
    ws.members.push({ userId: u.id, role: body.role });
    audit(ws, user, 'member.added', { userId: u.id, role: body.role });
    return [201, { userId: u.id, username: u.username, role: body.role }];
  });
  const findMember = (ws, id) => { const m = ws.members.find(x => x.userId === id || userById(x.userId)?.username === id); if (!m) fail(404, 'not_found', 'member not found'); return m; };
  const lastAdmin = (ws, m) => m.role === 'admin' && ws.members.filter(x => x.role === 'admin').length === 1;
  route('PATCH', '/api/workspaces/:id/members/:uid', ({ user, params, body }) => {
    const ws = getWs(params.id, user, 'admin'); const m = findMember(ws, params.uid); roleCheck(body?.role);
    if (body.role !== 'admin' && lastAdmin(ws, m)) bad('cannot demote the last admin');
    const from = m.role; m.role = body.role;
    audit(ws, user, 'member.role_changed', { userId: m.userId, from, to: m.role });
    return [200, { userId: m.userId, username: userById(m.userId)?.username, role: m.role }];
  });
  route('DELETE', '/api/workspaces/:id/members/:uid', ({ user, params }) => {
    const ws = getWs(params.id, user, 'admin'); const m = findMember(ws, params.uid);
    if (lastAdmin(ws, m)) bad('cannot remove the last admin');
    ws.members = ws.members.filter(x => x !== m);
    for (const p of db.projects.filter(p => p.workspaceId === ws.id)) p.members = p.members.filter(x => x.userId !== m.userId);
    audit(ws, user, 'member.removed', { userId: m.userId });
    return [204];
  });
  route('GET', '/api/workspaces/:id/audit', ({ user, params }) => {
    const ws = getWs(params.id, user, 'admin');
    return [200, db.audit.filter(a => a.workspaceId === ws.id).slice().reverse()];
  });

  // projects
  const outProj = (p, u) => ({ id: p.id, workspaceId: p.workspaceId, name: p.name, key: p.key, workflow: p.workflow, members: p.members.map(m => ({ userId: m.userId, username: userById(m.userId)?.username, role: m.role })), role: projRole(p, u), createdAt: p.createdAt });
  route('POST', '/api/workspaces/:id/projects', ({ user, params, body }) => {
    const ws = getWs(params.id, user, 'member');
    const { name, key } = body || {};
    if (!isStr(name)) bad('name required');
    if (typeof key !== 'string' || !/^[A-Z]{2,10}$/.test(key)) bad('key must be 2-10 uppercase letters');
    if (db.projects.some(p => p.key === key)) fail(409, 'conflict', 'project key taken');
    const statuses = DEFAULT_STATUSES.map(([name, category]) => ({ name, category }));
    const transitions = []; for (const a of statuses) for (const b of statuses) if (a !== b) transitions.push([a.name, b.name]);
    const p = { id: uid(), workspaceId: ws.id, name: name.trim(), key, createdAt: iso(), nextNumber: 1, members: [], workflow: { statuses, transitions } };
    db.projects.push(p);
    return [201, outProj(p, user)];
  });
  route('GET', '/api/workspaces/:id/projects', ({ user, params }) => {
    const ws = getWs(params.id, user);
    return [200, db.projects.filter(p => p.workspaceId === ws.id && projRole(p, user)).map(p => outProj(p, user))];
  });
  route('GET', '/api/projects/:id', ({ user, params }) => [200, outProj(getProj(params.id, user), user)]);
  route('POST', '/api/projects/:id/members', ({ user, params, body }) => {
    const p = getProj(params.id, user, 'lead');
    const u = userByName(body?.username);
    if (!['lead', 'developer', 'viewer'].includes(body?.role)) bad('role must be lead, developer or viewer');
    if (!u) fail(404, 'not_found', 'user not found');
    const ws = db.workspaces.find(w => w.id === p.workspaceId);
    if (!wsMember(ws, u)) bad('user is not a workspace member');
    const ex = p.members.find(m => m.userId === u.id);
    if (ex) ex.role = body.role; else p.members.push({ userId: u.id, role: body.role });
    audit(ws, user, 'project.member_set', { projectId: p.id, userId: u.id, role: body.role });
    return [201, { userId: u.id, username: u.username, role: body.role }];
  });
  route('DELETE', '/api/projects/:id/members/:uid', ({ user, params }) => {
    const p = getProj(params.id, user, 'lead');
    const m = p.members.find(x => x.userId === params.uid || userById(x.userId)?.username === params.uid); if (!m) fail(404, 'not_found', 'member not found');
    p.members = p.members.filter(x => x !== m);
    audit(db.workspaces.find(w => w.id === p.workspaceId), user, 'project.member_removed', { projectId: p.id, userId: m.userId });
    return [204];
  });
  route('PUT', '/api/projects/:id/workflow', ({ user, params, body }) => {
    const p = getProj(params.id, user, 'lead');
    const { statuses, transitions, remap = {} } = body || {};
    if (!Array.isArray(statuses) || statuses.length === 0) bad('statuses required');
    const names = new Set();
    for (const s of statuses) {
      if (!s || !isStr(s.name) || !CATS.includes(s.category)) bad('each status needs a name and valid category');
      if (names.has(s.name)) bad('duplicate status ' + s.name); names.add(s.name);
    }
    if (!Array.isArray(transitions)) bad('transitions required');
    for (const t of transitions) if (!Array.isArray(t) || t.length !== 2 || !names.has(t[0]) || !names.has(t[1])) bad('transition references unknown status');
    if (typeof remap !== 'object' || remap === null || Array.isArray(remap)) bad('invalid remap');
    const issues = db.issues.filter(i => i.projectId === p.id);
    for (const old of new Set(issues.map(i => i.status))) {
      if (names.has(old)) continue;
      if (!(old in remap)) bad(`status "${old}" is in use; provide remap`);
      if (!names.has(remap[old])) bad(`remap target "${remap[old]}" does not exist`);
    }
    const prevStatuses = p.workflow.statuses;
    p.workflow = { statuses: statuses.map(s => ({ name: s.name, category: s.category })), transitions: transitions.map(t => [t[0], t[1]]) };
    for (const i of issues) {
      if (!names.has(i.status)) { const from = i.status; i.status = remap[from]; record(i, 'status', from, i.status, user); i.updatedAt = iso(); }
      setResolved(i, p, i.status);
    }
    audit(db.workspaces.find(w => w.id === p.workspaceId), user, 'workflow.updated', { projectId: p.id, statuses: statuses.map(s => s.name), removed: prevStatuses.map(s => s.name).filter(n => !names.has(n)) });
    return [200, p.workflow];
  });
  route('GET', '/api/projects/:id/workflow', ({ user, params }) => [200, getProj(params.id, user).workflow]);

  // issues
  route('POST', '/api/projects/:id/issues', ({ user, params, body }) => {
    const p = getProj(params.id, user, 'developer');
    const i = createIssue(p, user, body || {});
    return [201, outIssue(i, true)];
  });
  route('GET', '/api/projects/:id/issues', ({ user, params, query }) => {
    const p = getProj(params.id, user);
    let list = db.issues.filter(i => i.projectId === p.id);
    for (const k of ['status', 'type', 'priority', 'assigneeId', 'sprintId', 'epicId']) if (query[k]) list = list.filter(i => String(i[k]) === query[k]);
    if (query.sprintId === 'none') list = db.issues.filter(i => i.projectId === p.id && !i.sprintId);
    list.sort((a, b) => a._seq - b._seq);
    return [200, list.map(i => outIssue(i))];
  });
  route('GET', '/api/issues/:key', ({ user, params }) => { const { i } = getIssue(params.key, user); return [200, outIssue(i, true)]; });
  route('PATCH', '/api/issues/:key', ({ user, params, body }) => {
    const { i, p } = getIssue(params.key, user, 'developer');
    if (!body || typeof body !== 'object' || Array.isArray(body)) bad('invalid body');
    updateIssue(i, p, user, body);
    return [200, outIssue(i, true)];
  });
  route('DELETE', '/api/issues/:key', ({ user, params }) => { const { i, p } = getIssue(params.key, user, 'developer'); deleteIssue(i, p, user); return [204]; });
  route('GET', '/api/issues/:key/history', ({ user, params }) => { const { i } = getIssue(params.key, user); return [200, i.history.map(h => ({ ...h }))]; });
  route('POST', '/api/issues/:key/links', ({ user, params, body }) => {
    const { i } = getIssue(params.key, user, 'developer');
    if (!LINK_TYPES.includes(body?.type)) bad('invalid link type');
    if (!isStr(body?.target)) bad('target required');
    const t = db.issues.find(x => x.key.toLowerCase() === body.target.toLowerCase());
    if (!t) fail(404, 'not_found', 'target not found');
    getProj(t.projectId, user, 'viewer');
    if (t.id === i.id) bad('cannot link to itself');
    const dup = db.issues.flatMap(x => x._links || []).some(l => (l.source === i.id && l.target === t.id && l.type === body.type) || (l.source === t.id && l.target === i.id && l.type === body.type && body.type === 'relates'));
    if (dup) fail(409, 'conflict', 'link exists');
    const l = { id: uid(), type: body.type, source: i.id, target: t.id }; (i._links ||= []).push(l);
    return [201, outIssue(i, true)];
  });
  route('DELETE', '/api/issues/:key/links/:id', ({ user, params }) => {
    const { i } = getIssue(params.key, user, 'developer');
    for (const x of db.issues) { const n = (x._links || []).length; x._links = (x._links || []).filter(l => !(l.id === params.id && (l.source === i.id || l.target === i.id))); if (x._links.length !== n) return [204]; }
    fail(404, 'not_found', 'link not found');
  });
  route('POST', '/api/issues/:key/watch', ({ user, params }) => { const { i } = getIssue(params.key, user); if (!i.watchers.includes(user.id)) i.watchers.push(user.id); return [200, outIssue(i, true)]; });
  route('DELETE', '/api/issues/:key/watch', ({ user, params }) => { const { i } = getIssue(params.key, user); i.watchers = i.watchers.filter(w => w !== user.id); return [200, outIssue(i, true)]; });

  // comments
  const outComment = (c, i) => ({ id: c.id, issueKey: i ? i.key : c.issueKey, authorId: c.authorId, body: c.body, createdAt: c.createdAt, updatedAt: c.updatedAt, edited: c.edited });
  const mentionIds = (body, p) => { const ids = []; for (const m of body.matchAll(/(^|[^A-Za-z0-9_.-])@([A-Za-z0-9_.-]{3,32})/g)) { const u = userByName(m[2].replace(/[.-]+$/, '')); if (u && projRole(p, u)) ids.push(u.id); } return ids; };
  route('POST', '/api/issues/:key/comments', ({ user, params, body }) => {
    const { i, p } = getIssue(params.key, user, 'developer');
    if (!isStr(body?.body)) bad('body required');
    const c = { id: uid(), issueId: i.id, issueKey: i.key, authorId: user.id, body: body.body, createdAt: iso(), updatedAt: iso(), edited: false };
    db.comments.push(c);
    const ment = new Set(mentionIds(c.body, p));
    for (const id of ment) if (id !== user.id) notify(id, 'mention', i, user.id);
    notifyUsers(i.watchers.filter(w => !ment.has(w)), 'comment', i, user, p);
    fire(p, 'comment.created', i, user, { comment: outComment(c, i) });
    return [201, outComment(c, i)];
  });
  route('GET', '/api/issues/:key/comments', ({ user, params }) => { const { i } = getIssue(params.key, user); return [200, db.comments.filter(c => c.issueId === i.id).map(c => outComment(c, i))]; });
  const getComment = (id, user) => { const c = db.comments.find(x => x.id === id); if (!c) fail(404, 'not_found', 'comment not found'); const i = db.issues.find(x => x.id === c.issueId); const p = getProj(i.projectId, user); return { c, i, p }; };
  route('PATCH', '/api/comments/:id', ({ user, params, body }) => {
    const { c, i } = getComment(params.id, user);
    if (c.authorId !== user.id) fail(403, 'forbidden', 'only the author can edit');
    if (!isStr(body?.body)) bad('body required');
    c.body = body.body; c.edited = true; c.updatedAt = iso();
    return [200, outComment(c, i)];
  });
  route('DELETE', '/api/comments/:id', ({ user, params }) => {
    const { c, p } = getComment(params.id, user);
    if (c.authorId !== user.id && projRole(p, user) !== 'lead') fail(403, 'forbidden', 'not allowed');
    db.comments = db.comments.filter(x => x !== c); return [204];
  });

  // notifications
  route('GET', '/api/notifications', ({ user, query }) => {
    let l = db.notifications.filter(n => n.userId === user.id);
    if (query.unread === 'true') l = l.filter(n => !n.read);
    l = l.slice().sort((a, b) => b._seq - a._seq);
    return [200, l.map(clean)];
  });
  route('POST', '/api/notifications/read', ({ user, body }) => {
    const mine = db.notifications.filter(n => n.userId === user.id);
    if (body?.all === true) mine.forEach(n => { n.read = true; });
    else if (Array.isArray(body?.ids)) { const s = new Set(body.ids); mine.forEach(n => { if (s.has(n.id)) n.read = true; }); }
    else bad('ids or all required');
    return [200, { unread: mine.filter(n => !n.read).length }];
  });

  // sprints
  const outSprint = (s) => clean(s);
  const getSprint = (id, user, min) => { const s = db.sprints.find(x => x.id === id); if (!s) fail(404, 'not_found', 'sprint not found'); const p = getProj(s.projectId, user, min); return { s, p }; };
  route('POST', '/api/projects/:id/sprints', ({ user, params, body }) => {
    const p = getProj(params.id, user, 'developer');
    const { name, startDate, endDate } = body || {};
    if (!isStr(name)) bad('name required');
    for (const d of [startDate, endDate]) if (d != null && !isDate(d)) bad('dates must be YYYY-MM-DD');
    if (startDate && endDate && endDate < startDate) bad('endDate before startDate');
    const s = { id: uid(), projectId: p.id, name: name.trim(), startDate: startDate ?? null, endDate: endDate ?? null, state: 'planned', createdAt: iso(), _ever: [] };
    db.sprints.push(s); return [201, outSprint(s)];
  });
  route('GET', '/api/projects/:id/sprints', ({ user, params }) => { const p = getProj(params.id, user); return [200, db.sprints.filter(s => s.projectId === p.id).map(outSprint)]; });
  route('GET', '/api/sprints/:id', ({ user, params }) => [200, outSprint(getSprint(params.id, user).s)]);
  route('POST', '/api/sprints/:id/start', ({ user, params }) => {
    const { s } = getSprint(params.id, user, 'developer');
    if (s.state !== 'planned') fail(409, 'conflict', 'sprint is not planned');
    if (db.sprints.some(x => x.projectId === s.projectId && x.state === 'active')) fail(409, 'conflict', 'another sprint is active');
    s.state = 'active'; s.startedAt = iso();
    if (!s.startDate) s.startDate = dayStr(now());
    s._startedDay = s.startDate;
    const cur = db.issues.filter(i => i.sprintId === s.id);
    s._committed = cur.map(i => i.id); s._committedPoints = cur.reduce((a, i) => a + (i.storyPoints || 0), 0);
    return [200, outSprint(s)];
  });
  route('POST', '/api/sprints/:id/complete', ({ user, params, body }) => {
    const { s, p } = getSprint(params.id, user, 'developer');
    if (s.state !== 'active') fail(409, 'conflict', 'sprint is not active');
    const target = body?.carryOverTo ?? 'backlog';
    let dest = null;
    if (target !== 'backlog') {
      dest = db.sprints.find(x => x.id === target);
      if (!dest || dest.projectId !== s.projectId || dest.id === s.id || dest.state === 'completed') bad('invalid carryOverTo');
    }
    const inS = db.issues.filter(i => i.sprintId === s.id);
    const unfinished = inS.filter(i => !i.resolvedAt);
    s._completedIds = inS.filter(i => i.resolvedAt).map(i => i.id);
    for (const i of unfinished) {
      const from = i.sprintId; i.sprintId = dest ? dest.id : null; record(i, 'sprintId', from, i.sprintId, user); i.updatedAt = iso();
      if (dest) { (dest._ever ||= []); if (!dest._ever.includes(i.id)) dest._ever.push(i.id); }
    }
    s._carried = unfinished.length; s.state = 'completed'; s.completedAt = iso();
    return [200, { ...outSprint(s), carriedOver: unfinished.length }];
  });
  route('GET', '/api/sprints/:id/report', ({ user, params }) => [200, sprintReport(getSprint(params.id, user).s)]);

  route('GET', '/api/projects/:id/stats', ({ user, params }) => {
    const p = getProj(params.id, user);
    const list = db.issues.filter(i => i.projectId === p.id);
    const byStatus = {}, byType = {}, byAssignee = {};
    for (const s of p.workflow.statuses) byStatus[s.name] = 0;
    for (const i of list) {
      byStatus[i.status] = (byStatus[i.status] || 0) + 1; byType[i.type] = (byType[i.type] || 0) + 1;
      const a = i.assigneeId ? userById(i.assigneeId)?.username : 'unassigned'; byAssignee[a] = (byAssignee[a] || 0) + 1;
    }
    const cts = list.filter(i => i.resolvedAt && i._startedAt).map(i => (Date.parse(i.resolvedAt) - Date.parse(i._startedAt)) / 3600000);
    const avg = cts.length ? cts.reduce((a, b) => a + b, 0) / cts.length : null;
    return [200, { total: list.length, byStatus, byType, byAssignee, averageCycleTimeHours: avg, avgCycleTimeHours: avg, cycleTimeHours: avg }];
  });

  // search
  route('GET', '/api/search', ({ user, query }) => {
    const terms = parseQuery(query.q || '');
    let projects = db.projects.filter(p => projRole(p, user));
    if (query.project) { projects = projects.filter(p => p.id === query.project || p.key === query.project); }
    const ids = new Set(projects.map(p => p.id));
    let list = db.issues.filter(i => ids.has(i.projectId) && terms.every(t => matches(i, t, user) !== t.neg));
    const sort = query.sort || 'updated';
    if (!['updated', 'created', 'priority'].includes(sort)) bad('invalid sort');
    const byUpd = (a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : b._seq - a._seq);
    if (sort === 'created') list.sort((a, b) => b._seq - a._seq);
    else if (sort === 'priority') list.sort((a, b) => PRIOS.indexOf(a.priority) - PRIOS.indexOf(b.priority) || byUpd(a, b));
    else list.sort(byUpd);
    return [200, list.map(i => outIssue(i))];
  });

  // csv
  route('GET', '/api/projects/:id/export.csv', ({ user, params }) => {
    const p = getProj(params.id, user);
    const head = 'key,type,title,status,priority,assignee,labels,storyPoints,parent,epic,sprint,dueDate,createdAt,resolvedAt';
    const lines = [head];
    for (const i of db.issues.filter(x => x.projectId === p.id).sort((a, b) => a._seq - b._seq)) {
      const par = db.issues.find(x => x.id === i.parentId), ep = db.issues.find(x => x.id === i.epicId), sp = db.sprints.find(x => x.id === i.sprintId);
      lines.push([i.key, i.type, i.title, i.status, i.priority, i.assigneeId ? userById(i.assigneeId)?.username : '', i.labels.join(';'), i.storyPoints ?? '', par?.key || '', ep?.key || '', sp?.name || '', i.dueDate || '', i.createdAt, i.resolvedAt || ''].map(csvEsc).join(','));
    }
    return [200, lines.join('\r\n') + '\r\n', 'text/csv; charset=utf-8'];
  });
  route('POST', '/api/projects/:id/import.csv', ({ user, params, rawBody }) => {
    const p = getProj(params.id, user, 'developer');
    const rows = parseCsv(String(rawBody || '').replace(/^﻿/, ''));
    const errors = []; let created = 0;
    if (!rows.length) bad('empty csv');
    if (rows[0].cells === null) bad('malformed csv');
    const header = rows[0].cells.map(h => h.trim());
    if (!header.includes('title')) bad('csv header must include title');
    const rest = rows.slice(1);
    for (const r of rest) {
      if (r.cells === null) { errors.push({ line: r.line, message: r.error }); continue; }
      const c = {}; header.forEach((h, k) => { c[h] = (r.cells[k] ?? '').trim(); });
      try {
        if (r.cells.length > header.length) throw new HttpError(400, 'v', 'too many columns');
        const b = { type: c.type || 'task', title: c.title };
        if (!c.title) throw new HttpError(400, 'v', 'title is required');
        if (c.status) b.status = c.status;
        if (c.priority) b.priority = c.priority;
        if (c.assignee) { const u = userByName(c.assignee); if (!u) throw new HttpError(400, 'v', 'unknown assignee ' + c.assignee); b.assigneeId = u.id; }
        if (c.labels) b.labels = c.labels.split(';').map(x => x.trim()).filter(Boolean);
        if (c.storyPoints) { const n = Number(c.storyPoints); if (!isFinite(n)) throw new HttpError(400, 'v', 'invalid storyPoints'); b.storyPoints = n; }
        if (c.dueDate) b.dueDate = c.dueDate;
        const ref = (key, what) => { const t = db.issues.find(x => x.projectId === p.id && x.key.toLowerCase() === key.toLowerCase()); if (!t) throw new HttpError(400, 'v', `unknown ${what} ${key}`); return t.id; };
        if (c.parent) b.parentId = ref(c.parent, 'parent');
        if (c.epic) b.epicId = ref(c.epic, 'epic');
        if (c.sprint) { const s = db.sprints.find(x => x.projectId === p.id && x.state !== 'completed' && (x.name === c.sprint || x.id === c.sprint)); if (!s) throw new HttpError(400, 'v', 'unknown sprint ' + c.sprint); b.sprintId = s.id; }
        createIssue(p, user, b);
        created++;
      } catch (e) { if (e instanceof HttpError) errors.push({ line: r.line, message: e.message }); else throw e; }
    }
    return [200, { created, errors }];
  });

  // webhooks
  const outHook = (w) => ({ id: w.id, projectId: w.projectId, url: w.url, events: w.events, createdAt: w.createdAt });
  route('POST', '/api/projects/:id/webhooks', ({ user, params, body }) => {
    const p = getProj(params.id, user, 'lead');
    const { url, events, secret } = body || {};
    try { const u = new URL(url); if (!/^https?:$/.test(u.protocol)) throw 0; } catch { bad('valid http(s) url required'); }
    if (!Array.isArray(events) || !events.length || events.some(e => !EVENTS.includes(e))) bad('invalid events');
    if (!isStr(secret)) bad('secret required');
    const w = { id: uid(), projectId: p.id, url, events: [...new Set(events)], secret, createdAt: iso() };
    db.webhooks.push(w);
    audit(db.workspaces.find(x => x.id === p.workspaceId), user, 'webhook.created', { webhookId: w.id, projectId: p.id, url });
    return [201, outHook(w)];
  });
  route('GET', '/api/projects/:id/webhooks', ({ user, params }) => { const p = getProj(params.id, user, 'lead'); return [200, db.webhooks.filter(w => w.projectId === p.id).map(outHook)]; });
  const getHook = (id, user) => { const w = db.webhooks.find(x => x.id === id); if (!w) fail(404, 'not_found', 'webhook not found'); const p = getProj(w.projectId, user, 'lead'); return { w, p }; };
  route('DELETE', '/api/webhooks/:id', ({ user, params }) => {
    const { w, p } = getHook(params.id, user);
    db.webhooks = db.webhooks.filter(x => x !== w);
    audit(db.workspaces.find(x => x.id === p.workspaceId), user, 'webhook.deleted', { webhookId: w.id, projectId: p.id });
    return [204];
  });
  route('GET', '/api/webhooks/:id/deliveries', ({ user, params }) => { const { w } = getHook(params.id, user); return [200, db.deliveries.filter(d => d.webhookId === w.id).map(d => ({ ...d }))]; });

  // ---------- server ----------
  const MIME = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml' };
  const sendJson = (res, status, obj) => { const b = JSON.stringify(obj); res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(b) }); res.end(b); };
  const sendErr = (res, e) => {
    if (e instanceof HttpError) return sendJson(res, e.status, { error: e.code, message: e.message });
    console.error(e); return sendJson(res, 500, { error: 'internal_error', message: 'internal error' });
  };
  const serveFile = (res, file) => {
    const full = path.join(STATIC_DIR, file);
    if (!full.startsWith(STATIC_DIR) || !fs.existsSync(full) || !fs.statSync(full).isFile()) return sendJson(res, 404, { error: 'not_found', message: 'not found' });
    const b = fs.readFileSync(full); res.writeHead(200, { 'content-type': MIME[path.extname(full)] || 'application/octet-stream' }); res.end(b);
  };

  return http.createServer((req, res) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 5e6) { req.destroy(); return; } chunks.push(c); });
    req.on('error', () => {});
    req.on('end', () => {
      try {
        const url = new URL(req.url, 'http://x'); const pathname = url.pathname;
        if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) return serveFile(res, 'index.html');
        if (req.method === 'GET' && pathname.startsWith('/static/')) return serveFile(res, decodeURIComponent(pathname.slice(8)));
        if (!pathname.startsWith('/api/')) return sendJson(res, 404, { error: 'not_found', message: 'not found' });
        const raw = Buffer.concat(chunks).toString('utf8');
        let matched = null, params = {}, pathHit = false;
        for (const r of routes) {
          const m = r.re.exec(pathname); if (!m) continue;
          pathHit = true;
          if (r.method !== req.method) continue;
          matched = r; r.keys.forEach((k, n) => { params[k] = decodeURIComponent(m[n + 1]); }); break;
        }
        if (!matched) return sendJson(res, pathHit ? 405 : 404, { error: pathHit ? 'method_not_allowed' : 'not_found', message: pathHit ? 'method not allowed' : 'not found' });
        let user = null, tokenHash = null;
        if (matched.auth) {
          const h = req.headers.authorization || ''; const m = /^Bearer\s+(\S+)$/i.exec(h);
          if (!m) fail(401, 'unauthorized', 'missing or invalid token');
          tokenHash = sha(m[1]);
          const s = db.sessions.find(x => x.hash === tokenHash) || db.tokens.find(x => x.hash === tokenHash);
          user = s && userById(s.userId);
          if (!user) fail(401, 'unauthorized', 'invalid token');
        }
        let body;
        const isCsv = /import\.csv$/.test(pathname);
        if (raw && !isCsv) { try { body = JSON.parse(raw); } catch { fail(400, 'validation_error', 'invalid JSON body'); } }
        const query = Object.fromEntries(url.searchParams);
        const out = matched.handler({ user, params, query, body, rawBody: raw, tokenHash });
        const [status, payload, ctype] = out;
        if (status !== 200 && status !== 201 && status !== 204 || req.method !== 'GET') save();
        if (status === 204) { res.writeHead(204); return res.end(); }
        if (ctype) { res.writeHead(status, { 'content-type': ctype }); return res.end(payload); }
        return sendJson(res, status, payload);
      } catch (e) { sendErr(res, e); }
    });
  });
}
