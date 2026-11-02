import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const CATS = ['backlog', 'unstarted', 'started', 'completed'];
const TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIOS = ['urgent', 'high', 'medium', 'low', 'none'];
const LINK_TYPES = ['blocks', 'relates', 'duplicates'];
const INVERSE = { blocks: 'blocked_by', relates: 'relates', duplicates: 'duplicated_by' };
const WH_EVENTS = ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'];
const DEFAULT_STATUSES = [['Backlog', 'backlog'], ['Todo', 'unstarted'], ['In Progress', 'started'], ['In Review', 'started'], ['Done', 'completed']];

class HttpError extends Error { constructor(status, error, message) { super(message); this.status = status; this.error = error; } }
const bad = (m) => new HttpError(400, 'validation_error', m);
const forbidden = (m = 'Forbidden') => new HttpError(403, 'forbidden', m);
const notFound = (m = 'Not found') => new HttpError(404, 'not_found', m);
const conflict = (code, m) => new HttpError(409, code, m);

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hashPw = (pw) => { const salt = crypto.randomBytes(16).toString('hex'); return `scrypt$${salt}$${crypto.scryptSync(pw, salt, 32).toString('hex')}`; };
const checkPw = (pw, stored) => { const [, salt, h] = stored.split('$'); const a = Buffer.from(crypto.scryptSync(pw, salt, 32).toString('hex')); return crypto.timingSafeEqual(a, Buffer.from(h)); };
const isStr = (v) => typeof v === 'string' && v.trim().length > 0;
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));

export function createServer({ dataFile, clock } = {}) {
  const now = () => (clock ? clock() : new Date());
  const iso = () => now().toISOString();
  let db = { seq: 1, users: [], sessions: [], apiTokens: [], workspaces: [], projects: [], issues: [], links: [], comments: [], notifications: [], sprints: [], webhooks: [], deliveries: [], audit: [] };
  if (dataFile && fs.existsSync(dataFile)) { try { db = { ...db, ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) }; } catch { /* ignore */ } }
  const save = () => { if (dataFile) { fs.writeFileSync(dataFile + '.tmp', JSON.stringify(db)); fs.renameSync(dataFile + '.tmp', dataFile); } };
  const nid = () => String(db.seq++);
  const loginFails = new Map();

  // ---------- helpers ----------
  const userById = (id) => db.users.find((u) => u.id === id);
  const userByName = (n) => db.users.find((u) => u.username === String(n).toLowerCase());
  const pubUser = (u) => ({ id: u.id, username: u.username, displayName: u.displayName });
  const wsById = (id) => db.workspaces.find((w) => w.id === id);
  const projById = (id) => db.projects.find((p) => p.id === id);
  const wsRole = (u, ws) => ws.members.find((m) => m.userId === u.id)?.role || null;
  const projRole = (u, p) => {
    const ws = wsById(p.workspaceId); const r = wsRole(u, ws);
    if (!r) return null;
    if (r === 'admin') return 'lead';
    const pm = p.members.find((m) => m.userId === u.id);
    if (r === 'guest') return pm ? pm.role : null;
    return pm ? pm.role : 'developer';
  };
  const getProject = (u, id, need = 'viewer') => {
    const p = projById(id); if (!p) throw notFound('Project not found');
    const r = projRole(u, p); if (!r) throw notFound('Project not found');
    const rank = { viewer: 0, developer: 1, lead: 2 };
    if (rank[r] < rank[need]) throw forbidden('Insufficient project role');
    return p;
  };
  const getWs = (u, id, need) => {
    const w = wsById(id); if (!w) throw notFound('Workspace not found');
    const r = wsRole(u, w); if (!r) throw notFound('Workspace not found');
    if (need === 'admin' && r !== 'admin') throw forbidden('Admin only');
    if (need === 'member' && r === 'guest') throw forbidden('Guests cannot do this');
    return w;
  };
  const issueByKey = (key) => db.issues.find((i) => i.key === String(key).toUpperCase());
  const getIssue = (u, key, need = 'viewer') => { const i = issueByKey(key); if (!i) throw notFound('Issue not found'); getProject(u, i.projectId, need); return i; };
  const visibleProjects = (u) => db.projects.filter((p) => projRole(u, p));
  const statusCat = (p, name) => p.workflow.statuses.find((s) => s.name === name)?.category;
  const isDone = (p, i) => statusCat(p, i.status) === 'completed';
  const audit = (u, type, details, wsId) => {
    const ids = wsId ? [wsId] : db.workspaces.filter((w) => wsRole(u, w)).map((w) => w.id);
    for (const workspaceId of ids) db.audit.push({ id: nid(), workspaceId, type, action: type, actorId: u.id, at: iso(), details });
  };
  const needStr = (b, k) => { if (!isStr(b[k])) throw bad(`${k} is required`); return b[k].trim(); };

  const outIssue = (i, full) => {
    const o = { ...i, labels: [...i.labels], watchers: [...i.watchers] };
    if (full) {
      const p = projById(i.projectId);
      o.children = db.issues.filter((c) => c.parentId === i.id).map((c) => c.key);
      o.links = db.links.flatMap((l) => {
        if (l.from === i.id) return [{ id: l.id, type: l.type, target: db.issues.find((x) => x.id === l.to)?.key }];
        if (l.to === i.id) return [{ id: l.id, type: INVERSE[l.type], target: db.issues.find((x) => x.id === l.from)?.key }];
        return [];
      }).map((l) => ({ ...l, key: l.target }));
      if (i.type === 'epic') {
        const ch = db.issues.filter((c) => c.epicId === i.id);
        o.progress = { total: ch.length, done: ch.filter((c) => isDone(p, c)).length, points_total: ch.reduce((a, c) => a + (c.storyPoints || 0), 0), points_done: ch.filter((c) => isDone(p, c)).reduce((a, c) => a + (c.storyPoints || 0), 0) };
      }
    }
    return o;
  };

  // ---------- notifications / webhooks ----------
  const notify = (userIds, type, issue, actor) => {
    const p = projById(issue.projectId);
    for (const uid of new Set(userIds)) {
      if (uid === actor.id) continue; const u = userById(uid); if (!u || !projRole(u, p)) continue;
      db.notifications.push({ id: nid(), userId: uid, type, issueKey: issue.key, actorId: actor.id, at: iso(), read: false });
    }
  };
  const fire = (project, event, issue, actor) => {
    for (const wh of db.webhooks.filter((w) => w.projectId === project.id && w.events.includes(event))) {
      const body = JSON.stringify({ event, issue: outIssue(issue), actorId: actor.id, at: iso() });
      const d = { id: nid(), webhookId: wh.id, event, status: 'pending', attempts: 0, lastError: null, at: iso() };
      db.deliveries.push(d);
      (async () => {
        const sig = 'sha256=' + crypto.createHmac('sha256', wh.secret).update(body).digest('hex');
        for (let a = 1; a <= 3; a++) {
          d.attempts = a;
          try {
            const r = await fetch(wh.url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pm-signature': sig, 'x-pm-event': event }, body, signal: AbortSignal.timeout(5000) });
            if (r.ok) { d.status = 'delivered'; d.lastError = null; break; }
            d.lastError = `HTTP ${r.status}`;
          } catch (e) { d.lastError = String(e.message || e); }
          d.status = 'failed';
          if (a < 3) await new Promise((r) => setTimeout(r, 50 * a));
        }
        save();
      })();
    }
  };

  // ---------- issue logic ----------
  const record = (i, field, from, to, actor) => {
    if (JSON.stringify(from) === JSON.stringify(to)) return;
    i.history.push({ field, from, to, actorId: actor.id, at: iso() });
  };
  const validateIssueFields = (p, b, cur) => {
    const type = b.type ?? cur?.type;
    if (b.type !== undefined && !TYPES.includes(b.type)) throw bad('invalid type');
    if (b.priority !== undefined && !PRIOS.includes(b.priority)) throw bad('invalid priority');
    if (b.title !== undefined && !isStr(b.title)) throw bad('title is required');
    if (b.labels !== undefined && (!Array.isArray(b.labels) || b.labels.some((l) => typeof l !== 'string'))) throw bad('labels must be strings');
    if (b.storyPoints !== undefined && b.storyPoints !== null && (typeof b.storyPoints !== 'number' || b.storyPoints < 0)) throw bad('invalid storyPoints');
    if (b.dueDate !== undefined && b.dueDate !== null && !isDate(b.dueDate)) throw bad('invalid dueDate');
    const parentId = b.parentId !== undefined ? b.parentId : cur?.parentId;
    if (type === 'subtask') {
      if (!parentId) throw bad('subtask requires parentId');
    }
    if (parentId) {
      if (type === 'epic') throw bad('epics cannot have parents');
      const par = db.issues.find((x) => x.id === parentId || x.key === parentId);
      if (!par || par.projectId !== p.id) throw bad('invalid parentId');
      if (par.type === 'subtask') throw bad('parent cannot be a subtask');
      if (cur && par.id === cur.id) throw bad('invalid parentId');
      b.parentId = par.id;
    } else if (b.parentId !== undefined) b.parentId = null;
    if (b.epicId) {
      const e = db.issues.find((x) => x.id === b.epicId || x.key === b.epicId);
      if (!e || e.type !== 'epic' || e.projectId !== p.id) throw bad('epicId must reference an epic');
      b.epicId = e.id;
    }
    if (b.sprintId) {
      const s = db.sprints.find((x) => x.id === b.sprintId);
      if (!s || s.projectId !== p.id) throw bad('invalid sprintId');
    }
    if (b.assigneeId === undefined && isStr(b.assignee)) { const u = userByName(b.assignee); if (!u) throw bad('unknown assignee'); b.assigneeId = u.id; }
    if (b.assigneeId) { const u = userById(b.assigneeId); if (!u || !projRole(u, p)) throw bad('invalid assigneeId'); }
  };

  const createIssue = (p, actor, b) => {
    validateIssueFields(p, b, null);
    if (!isStr(b.title)) throw bad('title is required');
    if (!b.type) throw bad('type is required');
    const initial = p.workflow.statuses.find((s) => s.category === 'unstarted') || p.workflow.statuses[0];
    let status = initial.name;
    if (b.status !== undefined) { if (!p.workflow.statuses.some((s) => s.name === b.status)) throw bad('invalid status'); status = b.status; }
    const n = p.nextNumber++;
    const t = iso();
    const i = {
      id: nid(), key: `${p.key}-${n}`, projectId: p.id, type: b.type, title: b.title.trim(), description: b.description ?? '', status,
      priority: b.priority || 'none', assigneeId: b.assigneeId || null, reporterId: actor.id, labels: b.labels || [], storyPoints: b.storyPoints ?? null,
      parentId: b.parentId || null, epicId: b.epicId || null, sprintId: b.sprintId || null, dueDate: b.dueDate || null,
      watchers: [], createdAt: t, updatedAt: t, resolvedAt: null, history: [],
    };
    if (statusCat(p, status) === 'completed') i.resolvedAt = t;
    i.watchers.push(actor.id); if (i.assigneeId && !i.watchers.includes(i.assigneeId)) i.watchers.push(i.assigneeId);
    db.issues.push(i);
    return i;
  };

  const FIELDS = ['title', 'description', 'type', 'priority', 'assigneeId', 'labels', 'storyPoints', 'parentId', 'epicId', 'sprintId', 'dueDate'];
  const updateIssue = (i, actor, b) => {
    const p = projById(i.projectId);
    validateIssueFields(p, b, i);
    if (b.status !== undefined && b.status !== i.status) {
      const st = p.workflow.statuses.find((s) => s.name === b.status);
      if (!st) throw bad('invalid status');
      if (!p.workflow.transitions.some(([f, t]) => f === i.status && t === b.status)) throw conflict('invalid_transition', `Transition ${i.status} -> ${b.status} not allowed`);
      if (st.category === 'completed') {
        const blockers = db.links.filter((l) => l.type === 'blocks' && l.to === i.id).map((l) => db.issues.find((x) => x.id === l.from)).filter((x) => x && !x.resolvedAt);
        if (blockers.length) throw conflict('blocked', `Blocked by ${blockers.map((x) => x.key).join(', ')}`);
      }
    } else if (b.status !== undefined && !p.workflow.statuses.some((s) => s.name === b.status)) throw bad('invalid status');
    const oldAssignee = i.assigneeId; let statusChanged = false;
    if (b.type && b.type !== i.type) {
      if (b.type === 'subtask' && !(b.parentId ?? i.parentId)) throw bad('subtask requires parentId');
    }
    for (const f of FIELDS) {
      if (b[f] === undefined) continue;
      let v = b[f]; if (v === '') v = f === 'description' ? '' : null;
      record(i, f, i[f], v, actor); i[f] = v;
    }
    if (b.status !== undefined && b.status !== i.status) {
      const was = isDone(p, i);
      record(i, 'status', i.status, b.status, actor); i.status = b.status; statusChanged = true;
      const now_ = isDone(p, i);
      if (now_ && !was) { i.resolvedAt = iso(); record(i, 'resolvedAt', null, i.resolvedAt, actor); } else if (!now_ && was) { record(i, 'resolvedAt', i.resolvedAt, null, actor); i.resolvedAt = null; }
    }
    if (i.assigneeId && !i.watchers.includes(i.assigneeId)) i.watchers.push(i.assigneeId);
    i.updatedAt = iso();
    if (statusChanged) notify(i.watchers, 'status_changed', i, actor);
    if (i.assigneeId !== oldAssignee && i.assigneeId) notify([...i.watchers.filter((w) => w === i.assigneeId)], 'assigned', i, actor);
  };

  const deleteIssue = (i) => {
    const ids = new Set([i.id, ...db.issues.filter((c) => c.parentId === i.id).map((c) => c.id)]);
    for (const c of db.issues) if (ids.has(c.epicId)) c.epicId = null;
    db.issues = db.issues.filter((x) => !ids.has(x.id));
    db.links = db.links.filter((l) => !ids.has(l.from) && !ids.has(l.to));
    db.comments = db.comments.filter((c) => !ids.has(c.issueId));
  };

  // ---------- search ----------
  const tokenize = (q) => {
    const toks = []; let k = 0;
    while (k < q.length) {
      if (/\s/.test(q[k])) { k++; continue; }
      let neg = false;
      if (q[k] === '-') { neg = true; k++; if (k >= q.length || /\s/.test(q[k])) throw bad('dangling -'); }
      let field = null; let val = ''; let phrase = false;
      const readQuoted = () => { k++; let s = ''; while (k < q.length && q[k] !== '"') s += q[k++]; if (k >= q.length) throw bad('unterminated quote'); k++; return s; };
      if (q[k] === '"') { val = readQuoted(); phrase = true; } else {
        let w = ''; while (k < q.length && !/\s/.test(q[k]) && q[k] !== ':' && q[k] !== '"') w += q[k++];
        if (q[k] === ':') { field = w; k++; if (q[k] === '"') val = readQuoted(); else { while (k < q.length && !/\s/.test(q[k])) val += q[k++]; } if (!field || val === '') throw bad('malformed term'); } else if (q[k] === '"') throw bad('unexpected quote'); else val = w;
      }
      toks.push({ neg, field, val, phrase });
    }
    return toks;
  };
  const compile = (q, user) => {
    const preds = tokenize(q).map((t) => {
      const v = t.val; const lv = v.toLowerCase(); let fn;
      if (!t.field) fn = (i) => i.title.toLowerCase().includes(lv) || (i.description || '').toLowerCase().includes(lv);
      else switch (t.field.toLowerCase()) {
        case 'status': fn = (i) => i.status.toLowerCase() === lv; break;
        case 'type': if (!TYPES.includes(lv)) throw bad('invalid type'); fn = (i) => i.type === lv; break;
        case 'priority': if (!PRIOS.includes(lv)) throw bad('invalid priority'); fn = (i) => i.priority === lv; break;
        case 'assignee': if (lv === 'me') fn = (i) => i.assigneeId === user.id; else if (lv === 'none') fn = (i) => !i.assigneeId; else { const u = userByName(lv); fn = (i) => !!u && i.assigneeId === u.id; } break;
        case 'label': fn = (i) => i.labels.some((l) => l.toLowerCase() === lv); break;
        case 'sprint':
          if (lv === 'active') fn = (i) => !!i.sprintId && db.sprints.find((s) => s.id === i.sprintId)?.state === 'active';
          else if (lv === 'none') fn = (i) => !i.sprintId; else fn = (i) => i.sprintId === v; break;
        case 'is': if (lv === 'open') fn = (i) => !isDone(projById(i.projectId), i); else if (lv === 'resolved') fn = (i) => isDone(projById(i.projectId), i); else throw bad('invalid is: value'); break;
        case 'due': {
          const m = /^([<>]=?|=)?(\d{4}-\d{2}-\d{2})$/.exec(v); if (!m || !isDate(m[2])) throw bad('invalid due date');
          const op = m[1] || '='; fn = (i) => i.dueDate && cmp(i.dueDate, op, m[2]); break;
        }
        case 'points': {
          const m = /^([<>]=?|=)?(\d+(?:\.\d+)?)$/.exec(v); if (!m) throw bad('invalid points');
          const op = m[1] || '='; const n = Number(m[2]); fn = (i) => i.storyPoints != null && cmp(i.storyPoints, op, n); break;
        }
        case 'key': fn = (i) => i.key.toLowerCase() === lv; break;
        default: throw bad(`unknown field ${t.field}`);
      }
      return t.neg ? (i) => !fn(i) : fn;
    });
    return (i) => preds.every((f) => f(i));
  };
  const cmp = (a, op, b) => (op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : op === '>=' ? a >= b : a === b);

  // ---------- CSV ----------
  const csvEsc = (v) => { const s = v == null ? '' : String(v); return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const parseCsv = (text) => {
    const rows = []; let row = []; let f = ''; let q = false; let line = 1; let startLine = 1; let any = false;
    for (let k = 0; k < text.length; k++) {
      const c = text[k];
      if (q) { if (c === '"') { if (text[k + 1] === '"') { f += '"'; k++; } else q = false; } else { if (c === '\n') line++; f += c; } continue; }
      if (c === '"' && f === '') { q = true; any = true; } else if (c === ',') { row.push(f); f = ''; any = true; } else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[k + 1] === '\n') k++;
        if (any || f !== '') { row.push(f); rows.push({ line: startLine, cells: row }); } row = []; f = ''; any = false; line++; startLine = line;
      } else { f += c; any = true; }
    }
    if (q) throw bad('unterminated quoted field');
    if (any || f !== '') { row.push(f); rows.push({ line: startLine, cells: row }); }
    return rows;
  };

  // ---------- sprint report ----------
  const dayEnd = (d) => Date.parse(d + 'T23:59:59.999Z');
  const stateAt = (i, field, t) => {
    const h = i.history.filter((e) => e.field === field);
    let v = h.length ? h[0].from : i[field];
    for (const e of h) { if (Date.parse(e.at) <= t) v = e.to; }
    return v;
  };
  const sprintReport = (s) => {
    const p = projById(s.projectId);
    const inSprint = db.issues.filter((i) => i.projectId === p.id && (i.sprintId === s.id || i.history.some((e) => e.field === 'sprintId' && (e.from === s.id || e.to === s.id))));
    const done = inSprint.filter((i) => i.sprintId === s.id && isDone(p, i));
    const live = s.state !== 'completed';
    const rep = {
      committedPoints: s.committedPoints ?? inSprint.filter((i) => i.sprintId === s.id).reduce((a, i) => a + (i.storyPoints || 0), 0),
      completedPoints: done.reduce((a, i) => a + (i.storyPoints || 0), 0),
      completedIssues: done.length,
      carriedOver: live ? 0 : s.carriedOver || 0,
      burndown: [],
    };
    if (s.startDate) {
      const today = now().toISOString().slice(0, 10);
      const last = s.endDate && s.endDate < today ? s.endDate : today;
      for (let d = new Date(s.startDate + 'T00:00:00Z'); d.toISOString().slice(0, 10) <= last; d = new Date(d.getTime() + 86400000)) {
        const day = d.toISOString().slice(0, 10); const t = dayEnd(day); let rem = 0;
        for (const i of inSprint) {
          if (Date.parse(i.createdAt) > t) continue;
          if (stateAt(i, 'sprintId', t) !== s.id) continue;
          const st = stateAt(i, 'status', t);
          if (statusCat(p, st) === 'completed') continue;
          rem += stateAt(i, 'storyPoints', t) || 0;
        }
        rep.burndown.push({ date: day, remainingPoints: rem });
      }
    }
    return rep;
  };

  // ---------- routes ----------
  const routes = [];
  const R = (method, pattern, fn, auth = true) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:[a-zA-Z]+/g, '([^/]+)') + '$'), fn, auth });

  R('POST', '/api/auth/register', ({ body }) => {
    const username = needStr(body, 'username').toLowerCase();
    if (!/^[a-z0-9_.-]{3,32}$/.test(username)) throw bad('username must be 3-32 chars [a-z0-9_.-]');
    if (typeof body.password !== 'string' || body.password.length < 8) throw bad('password must be at least 8 characters');
    if (userByName(username)) throw conflict('conflict', 'Username taken');
    const u = { id: nid(), username, displayName: isStr(body.displayName) ? body.displayName.trim() : username, passwordHash: hashPw(body.password), createdAt: iso() };
    db.users.push(u); return [201, pubUser(u)];
  }, false);
  R('POST', '/api/auth/login', ({ body, req }) => {
    const username = String(body.username || '').toLowerCase();
    const k = username; const nowMs = Date.now();
    const rec = (loginFails.get(k) || []).filter((t) => nowMs - t < 60000);
    if (rec.length >= 5) throw new HttpError(429, 'rate_limited', 'Too many failed login attempts');
    const u = userByName(username);
    if (!u || typeof body.password !== 'string' || !checkPw(body.password, u.passwordHash)) { rec.push(nowMs); loginFails.set(k, rec); throw new HttpError(401, 'unauthorized', 'Invalid credentials'); }
    loginFails.delete(k);
    const token = crypto.randomBytes(32).toString('hex');
    db.sessions.push({ hash: sha(token), userId: u.id, createdAt: iso() });
    return [200, { token, user: pubUser(u) }];
  }, false);
  R('POST', '/api/auth/logout', ({ token }) => { db.sessions = db.sessions.filter((s) => s.hash !== sha(token)); return [204]; });
  R('GET', '/api/auth/me', ({ user }) => [200, pubUser(user)]);
  R('PATCH', '/api/auth/me', ({ user, body }) => {
    if (body.displayName !== undefined && !isStr(body.displayName)) throw bad('invalid displayName');
    if (body.password !== undefined) {
      if (typeof body.password !== 'string' || body.password.length < 8) throw bad('password must be at least 8 characters');
      if (typeof body.currentPassword !== 'string') throw bad('currentPassword is required');
      if (!checkPw(body.currentPassword, user.passwordHash)) throw forbidden('Current password incorrect');
      user.passwordHash = hashPw(body.password);
    }
    if (body.displayName !== undefined) user.displayName = body.displayName.trim();
    return [200, pubUser(user)];
  });

  R('POST', '/api/tokens', ({ user, body }) => {
    const name = needStr(body, 'name'); const token = 'pm_' + crypto.randomBytes(24).toString('hex');
    const t = { id: nid(), userId: user.id, name, hash: sha(token), createdAt: iso() }; db.apiTokens.push(t);
    audit(user, 'token.created', { name, id: t.id }); return [201, { id: t.id, name, token }];
  });
  R('GET', '/api/tokens', ({ user }) => [200, db.apiTokens.filter((t) => t.userId === user.id).map((t) => ({ id: t.id, name: t.name, createdAt: t.createdAt }))]);
  R('DELETE', '/api/tokens/:id', ({ user, params }) => {
    const t = db.apiTokens.find((x) => x.id === params[0] && x.userId === user.id); if (!t) throw notFound();
    db.apiTokens = db.apiTokens.filter((x) => x !== t); audit(user, 'token.deleted', { name: t.name, id: t.id }); return [204];
  });

  // workspaces
  const outWs = (w) => ({ id: w.id, name: w.name, key: w.key, createdAt: w.createdAt, members: w.members.map((m) => ({ ...m, username: userById(m.userId)?.username })) });
  R('POST', '/api/workspaces', ({ user, body }) => {
    const name = needStr(body, 'name');
    if (typeof body.key !== 'string' || !/^[A-Z]{2,10}$/.test(body.key)) throw bad('key must be 2-10 uppercase letters');
    if (db.workspaces.some((w) => w.key === body.key)) throw conflict('conflict', 'Workspace key already used');
    const w = { id: nid(), name, key: body.key, createdAt: iso(), members: [{ userId: user.id, role: 'admin' }] };
    db.workspaces.push(w); audit(user, 'workspace.created', { name }, w.id); return [201, outWs(w)];
  });
  R('GET', '/api/workspaces', ({ user }) => [200, db.workspaces.filter((w) => wsRole(user, w)).map((w) => ({ ...outWs(w), role: wsRole(user, w) }))]);
  R('GET', '/api/workspaces/:id', ({ user, params }) => [200, { ...outWs(getWs(user, params[0])), role: wsRole(user, wsById(params[0])) }]);
  R('POST', '/api/workspaces/:id/members', ({ user, params, body }) => {
    const w = getWs(user, params[0], 'admin');
    if (!['admin', 'member', 'guest'].includes(body.role)) throw bad('invalid role');
    const u = userByName(needStr(body, 'username')); if (!u) throw notFound('User not found');
    if (w.members.some((m) => m.userId === u.id)) throw conflict('conflict', 'Already a member');
    w.members.push({ userId: u.id, role: body.role }); audit(user, 'member.added', { userId: u.id, username: u.username, role: body.role }, w.id);
    return [201, { userId: u.id, username: u.username, role: body.role }];
  });
  R('PATCH', '/api/workspaces/:id/members/:uid', ({ user, params, body }) => {
    const w = getWs(user, params[0], 'admin'); const m = w.members.find((x) => x.userId === params[1]); if (!m) throw notFound('Member not found');
    if (!['admin', 'member', 'guest'].includes(body.role)) throw bad('invalid role');
    if (m.role === 'admin' && body.role !== 'admin' && w.members.filter((x) => x.role === 'admin').length === 1) throw bad('Cannot demote the last admin');
    const from = m.role; m.role = body.role; audit(user, 'member.role_changed', { userId: m.userId, from, to: m.role }, w.id);
    return [200, { userId: m.userId, username: userById(m.userId)?.username, role: m.role }];
  });
  R('DELETE', '/api/workspaces/:id/members/:uid', ({ user, params }) => {
    const w = getWs(user, params[0], 'admin'); const m = w.members.find((x) => x.userId === params[1]); if (!m) throw notFound('Member not found');
    if (m.role === 'admin' && w.members.filter((x) => x.role === 'admin').length === 1) throw bad('Cannot remove the last admin');
    w.members = w.members.filter((x) => x !== m);
    for (const p of db.projects.filter((p) => p.workspaceId === w.id)) p.members = p.members.filter((x) => x.userId !== m.userId);
    audit(user, 'member.removed', { userId: m.userId }, w.id); return [204];
  });
  R('GET', '/api/workspaces/:id/audit', ({ user, params }) => { getWs(user, params[0], 'admin'); return [200, db.audit.filter((a) => a.workspaceId === params[0]).slice().reverse()]; });

  // projects
  const outProject = (p, u) => ({ id: p.id, workspaceId: p.workspaceId, name: p.name, key: p.key, workflow: p.workflow, members: p.members.map((m) => ({ ...m, username: userById(m.userId)?.username })), role: projRole(u, p), createdAt: p.createdAt });
  R('POST', '/api/workspaces/:id/projects', ({ user, params, body }) => {
    const w = getWs(user, params[0], 'member'); const name = needStr(body, 'name');
    if (typeof body.key !== 'string' || !/^[A-Z]{2,10}$/.test(body.key)) throw bad('key must be 2-10 uppercase letters');
    if (db.projects.some((p) => p.key === body.key)) throw conflict('conflict', 'Project key already used');
    const names = DEFAULT_STATUSES.map((s) => s[0]);
    const p = {
      id: nid(), workspaceId: w.id, name, key: body.key, nextNumber: 1, createdAt: iso(), members: [{ userId: user.id, role: 'lead' }],
      workflow: { statuses: DEFAULT_STATUSES.map(([name, category]) => ({ name, category })), transitions: names.flatMap((a) => names.filter((b) => b !== a).map((b) => [a, b])) },
    };
    db.projects.push(p); return [201, outProject(p, user)];
  });
  R('GET', '/api/workspaces/:id/projects', ({ user, params }) => { getWs(user, params[0]); return [200, db.projects.filter((p) => p.workspaceId === params[0] && projRole(user, p)).map((p) => outProject(p, user))]; });
  R('GET', '/api/projects/:id', ({ user, params }) => [200, outProject(getProject(user, params[0]), user)]);
  R('POST', '/api/projects/:id/members', ({ user, params, body }) => {
    const p = getProject(user, params[0], 'lead');
    if (!['lead', 'developer', 'viewer'].includes(body.role)) throw bad('invalid role');
    const u = userByName(needStr(body, 'username')); if (!u) throw notFound('User not found');
    if (!wsRole(u, wsById(p.workspaceId))) throw bad('User is not a workspace member');
    if (p.members.some((m) => m.userId === u.id)) throw conflict('conflict', 'Already a member');
    p.members.push({ userId: u.id, role: body.role }); audit(user, 'project.member_added', { projectId: p.id, userId: u.id, role: body.role }, p.workspaceId);
    return [201, { userId: u.id, username: u.username, role: body.role }];
  });
  R('PATCH', '/api/projects/:id/members/:uid', ({ user, params, body }) => {
    const p = getProject(user, params[0], 'lead'); if (!['lead', 'developer', 'viewer'].includes(body.role)) throw bad('invalid role');
    let m = p.members.find((x) => x.userId === params[1]); if (!m) throw notFound('Member not found'); m.role = body.role; return [200, m];
  });
  R('DELETE', '/api/projects/:id/members/:uid', ({ user, params }) => {
    const p = getProject(user, params[0], 'lead'); const m = p.members.find((x) => x.userId === params[1]); if (!m) throw notFound('Member not found');
    p.members = p.members.filter((x) => x !== m); return [204];
  });
  R('PUT', '/api/projects/:id/workflow', ({ user, params, body }) => {
    const p = getProject(user, params[0], 'lead');
    if (!Array.isArray(body.statuses) || !body.statuses.length) throw bad('statuses required');
    const names = new Set();
    for (const s of body.statuses) {
      if (!s || !isStr(s.name) || !CATS.includes(s.category)) throw bad('invalid status');
      if (names.has(s.name)) throw bad('duplicate status'); names.add(s.name);
    }
    if (!Array.isArray(body.transitions) || body.transitions.some((t) => !Array.isArray(t) || t.length !== 2 || !names.has(t[0]) || !names.has(t[1]))) throw bad('invalid transitions');
    const remap = body.remap || {};
    if (typeof remap !== 'object' || Array.isArray(remap)) throw bad('invalid remap');
    const inUse = new Set(db.issues.filter((i) => i.projectId === p.id).map((i) => i.status));
    for (const s of inUse) if (!names.has(s) && !(remap[s] && names.has(remap[s]))) throw bad(`Status "${s}" is in use and needs a remap`);
    const newWf = { statuses: body.statuses.map((s) => ({ name: s.name, category: s.category })), transitions: body.transitions.map((t) => [t[0], t[1]]) };
    const oldWf = p.workflow; p.workflow = newWf;
    for (const i of db.issues.filter((x) => x.projectId === p.id && !names.has(x.status))) {
      const to = remap[i.status]; record(i, 'status', i.status, to, user); i.status = to; i.updatedAt = iso();
      const done = statusCat(p, to) === 'completed';
      if (done && !i.resolvedAt) i.resolvedAt = iso(); else if (!done) i.resolvedAt = null;
    }
    audit(user, 'workflow.updated', { projectId: p.id, from: oldWf, to: newWf }, p.workspaceId);
    return [200, outProject(p, user)];
  });

  // issues
  R('POST', '/api/projects/:id/issues', ({ user, params, body }) => {
    const p = getProject(user, params[0], 'developer'); const i = createIssue(p, user, body);
    if (i.assigneeId) notify([i.assigneeId], 'assigned', i, user);
    fire(p, 'issue.created', i, user); return [201, outIssue(i, true)];
  });
  R('GET', '/api/projects/:id/issues', ({ user, params, query }) => {
    const p = getProject(user, params[0]); const f = compile(query.get('q') || '', user);
    return [200, db.issues.filter((i) => i.projectId === p.id && f(i)).map((i) => outIssue(i))];
  });
  R('GET', '/api/issues/:key', ({ user, params }) => [200, outIssue(getIssue(user, params[0]), true)]);
  R('PATCH', '/api/issues/:key', ({ user, params, body }) => {
    const i = getIssue(user, params[0], 'developer'); updateIssue(i, user, body);
    fire(projById(i.projectId), 'issue.updated', i, user); return [200, outIssue(i, true)];
  });
  R('DELETE', '/api/issues/:key', ({ user, params }) => {
    const i = getIssue(user, params[0], 'developer'); const p = projById(i.projectId); fire(p, 'issue.deleted', i, user); deleteIssue(i); return [204];
  });
  R('GET', '/api/issues/:key/history', ({ user, params }) => [200, getIssue(user, params[0]).history.map((h) => ({ field: h.field, from: h.from, to: h.to, actorId: h.actorId, at: h.at }))]);
  R('POST', '/api/issues/:key/links', ({ user, params, body }) => {
    const i = getIssue(user, params[0], 'developer');
    if (!LINK_TYPES.includes(body.type)) throw bad('invalid link type');
    const t = issueByKey(body.target || ''); if (!t) throw bad('target not found');
    getProject(user, t.projectId, 'viewer');
    if (t.id === i.id) throw bad('cannot link to itself');
    if (db.links.some((l) => l.type === body.type && ((l.from === i.id && l.to === t.id) || (body.type === 'relates' && l.from === t.id && l.to === i.id)))) throw conflict('conflict', 'Link exists');
    const l = { id: nid(), type: body.type, from: i.id, to: t.id }; db.links.push(l);
    i.updatedAt = iso(); return [201, { id: l.id, type: l.type, target: t.key, key: t.key }];
  });
  R('DELETE', '/api/issues/:key/links/:id', ({ user, params }) => {
    getIssue(user, params[0], 'developer'); const l = db.links.find((x) => x.id === params[1]); if (!l) throw notFound(); db.links = db.links.filter((x) => x !== l); return [204];
  });
  R('POST', '/api/issues/:key/watch', ({ user, params }) => { const i = getIssue(user, params[0]); if (!i.watchers.includes(user.id)) i.watchers.push(user.id); return [200, outIssue(i)]; });
  R('DELETE', '/api/issues/:key/watch', ({ user, params }) => { const i = getIssue(user, params[0]); i.watchers = i.watchers.filter((w) => w !== user.id); return [200, outIssue(i)]; });

  // comments
  const outComment = (c) => ({ id: c.id, issueKey: c.issueKey, authorId: c.authorId, body: c.body, edited: !!c.edited, createdAt: c.createdAt, updatedAt: c.updatedAt });
  R('POST', '/api/issues/:key/comments', ({ user, params, body }) => {
    const i = getIssue(user, params[0], 'developer'); const text = needStr(body, 'body'); const p = projById(i.projectId);
    const c = { id: nid(), issueId: i.id, issueKey: i.key, authorId: user.id, body: text, edited: false, createdAt: iso(), updatedAt: iso() }; db.comments.push(c);
    const mentioned = [...text.matchAll(/@([a-zA-Z0-9_.-]+)/g)].map((m) => userByName(m[1])).filter((u) => u && projRole(u, p)).map((u) => u.id);
    notify(mentioned, 'mention', i, user);
    notify(i.watchers.filter((w) => !mentioned.includes(w)), 'comment', i, user);
    fire(p, 'comment.created', i, user); return [201, outComment(c)];
  });
  R('GET', '/api/issues/:key/comments', ({ user, params }) => { const i = getIssue(user, params[0]); return [200, db.comments.filter((c) => c.issueId === i.id).map(outComment)]; });
  R('PATCH', '/api/comments/:id', ({ user, params, body }) => {
    const c = db.comments.find((x) => x.id === params[0]); if (!c) throw notFound(); getIssue(user, c.issueKey);
    if (c.authorId !== user.id) throw forbidden('Only the author can edit'); c.body = needStr(body, 'body'); c.edited = true; c.updatedAt = iso(); return [200, outComment(c)];
  });
  R('DELETE', '/api/comments/:id', ({ user, params }) => {
    const c = db.comments.find((x) => x.id === params[0]); if (!c) throw notFound(); const i = getIssue(user, c.issueKey);
    if (c.authorId !== user.id && projRole(user, projById(i.projectId)) !== 'lead') throw forbidden(); db.comments = db.comments.filter((x) => x !== c); return [204];
  });

  // notifications
  R('GET', '/api/notifications', ({ user, query }) => {
    let l = db.notifications.filter((n) => n.userId === user.id); if (query.get('unread') === 'true') l = l.filter((n) => !n.read);
    return [200, l.slice().reverse().map(({ id, type, issueKey, actorId, at, read }) => ({ id, type, issueKey, actorId, at, read }))];
  });
  R('POST', '/api/notifications/read', ({ user, body }) => {
    if (body.all !== true && !Array.isArray(body.ids)) throw bad('ids or all required');
    let n = 0; for (const x of db.notifications) if (x.userId === user.id && !x.read && (body.all === true || body.ids.includes(x.id))) { x.read = true; n++; }
    return [200, { updated: n }];
  });

  // sprints
  const getSprint = (u, id, need) => { const s = db.sprints.find((x) => x.id === id); if (!s) throw notFound('Sprint not found'); getProject(u, s.projectId, need); return s; };
  const outSprint = (s) => { const { committedPoints, carriedOver, ...r } = s; return r; };
  R('POST', '/api/projects/:id/sprints', ({ user, params, body }) => {
    const p = getProject(user, params[0], 'developer'); const name = needStr(body, 'name');
    for (const k of ['startDate', 'endDate']) if (body[k] != null && !isDate(body[k])) throw bad(`invalid ${k}`);
    if (body.startDate && body.endDate && body.endDate < body.startDate) throw bad('endDate before startDate');
    const s = { id: nid(), projectId: p.id, name, state: 'planned', startDate: body.startDate || null, endDate: body.endDate || null, createdAt: iso() }; db.sprints.push(s); return [201, outSprint(s)];
  });
  R('GET', '/api/projects/:id/sprints', ({ user, params }) => { const p = getProject(user, params[0]); return [200, db.sprints.filter((s) => s.projectId === p.id).map(outSprint)]; });
  R('POST', '/api/sprints/:id/start', ({ user, params }) => {
    const s = getSprint(user, params[0], 'lead'); if (s.state !== 'planned') throw conflict('conflict', 'Sprint is not planned');
    if (db.sprints.some((x) => x.projectId === s.projectId && x.state === 'active')) throw conflict('conflict', 'Another sprint is active');
    s.state = 'active'; if (!s.startDate) s.startDate = now().toISOString().slice(0, 10);
    s.committedPoints = db.issues.filter((i) => i.sprintId === s.id).reduce((a, i) => a + (i.storyPoints || 0), 0); return [200, outSprint(s)];
  });
  R('POST', '/api/sprints/:id/complete', ({ user, params, body }) => {
    const s = getSprint(user, params[0], 'lead'); if (s.state !== 'active') throw conflict('conflict', 'Sprint is not active');
    const p = projById(s.projectId); let target = null; const c = body.carryOverTo;
    if (c === undefined || c === 'backlog' || c === null) target = null; else { const t = db.sprints.find((x) => x.id === c && x.projectId === p.id && x.id !== s.id && x.state !== 'completed'); if (!t) throw bad('invalid carryOverTo'); target = t.id; }
    const open = db.issues.filter((i) => i.sprintId === s.id && !isDone(p, i));
    for (const i of open) { record(i, 'sprintId', i.sprintId, target, user); i.sprintId = target; i.updatedAt = iso(); }
    s.carriedOver = open.length; s.state = 'completed'; s.completedAt = iso();
    if (!s.endDate) s.endDate = now().toISOString().slice(0, 10);
    return [200, outSprint(s)];
  });
  R('GET', '/api/sprints/:id/report', ({ user, params }) => [200, sprintReport(getSprint(user, params[0]))]);
  R('GET', '/api/projects/:id/stats', ({ user, params }) => {
    const p = getProject(user, params[0]); const is = db.issues.filter((i) => i.projectId === p.id);
    const byStatus = Object.fromEntries(p.workflow.statuses.map((s) => [s.name, 0])); const byType = {}; const byAssignee = {};
    for (const i of is) { byStatus[i.status] = (byStatus[i.status] || 0) + 1; byType[i.type] = (byType[i.type] || 0) + 1; const a = i.assigneeId ? userById(i.assigneeId)?.username : 'unassigned'; byAssignee[a] = (byAssignee[a] || 0) + 1; }
    const times = [];
    for (const i of is) {
      if (!i.resolvedAt) continue;
      const first = i.history.find((h) => h.field === 'status' && statusCat(p, h.to) === 'started');
      if (first) times.push(Date.parse(i.resolvedAt) - Date.parse(first.at));
    }
    return [200, { total: is.length, byStatus, byType, byAssignee, avgCycleTimeHours: times.length ? times.reduce((a, b) => a + b, 0) / times.length / 3600000 : null }];
  });

  // search
  R('GET', '/api/search', ({ user, query }) => {
    const f = compile(query.get('q') || '', user); let ps = visibleProjects(user);
    const pr = query.get('project'); if (pr) { ps = ps.filter((p) => p.id === pr || p.key === pr.toUpperCase()); }
    const sort = query.get('sort') || 'updated'; if (!['updated', 'created', 'priority'].includes(sort)) throw bad('invalid sort');
    const ids = new Set(ps.map((p) => p.id)); const res = db.issues.filter((i) => ids.has(i.projectId) && f(i));
    const num = (i) => Number(i.id);
    const byUpd = (a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : num(b) - num(a));
    if (sort === 'updated') res.sort(byUpd); else if (sort === 'created') res.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : num(b) - num(a)));
    else res.sort((a, b) => PRIOS.indexOf(a.priority) - PRIOS.indexOf(b.priority) || byUpd(a, b));
    return [200, res.map((i) => outIssue(i))];
  });

  // CSV
  const HEAD = ['key', 'type', 'title', 'status', 'priority', 'assignee', 'labels', 'storyPoints', 'parent', 'epic', 'sprint', 'dueDate', 'createdAt', 'resolvedAt'];
  R('GET', '/api/projects/:id/export.csv', ({ user, params }) => {
    const p = getProject(user, params[0]); const k = (id) => db.issues.find((x) => x.id === id)?.key || '';
    const lines = [HEAD.join(',')];
    for (const i of db.issues.filter((x) => x.projectId === p.id)) {
      lines.push([i.key, i.type, i.title, i.status, i.priority, i.assigneeId ? userById(i.assigneeId)?.username : '', i.labels.join(';'), i.storyPoints ?? '', k(i.parentId), k(i.epicId), db.sprints.find((s) => s.id === i.sprintId)?.name || '', i.dueDate || '', i.createdAt, i.resolvedAt || ''].map(csvEsc).join(','));
    }
    return [200, lines.join('\r\n') + '\r\n', 'text/csv; charset=utf-8'];
  });
  R('POST', '/api/projects/:id/import.csv', ({ user, params, body }) => {
    const p = getProject(user, params[0], 'developer'); const text = typeof body === 'string' ? body.replace(/^﻿/, '') : '';
    const rows = parseCsv(text); if (!rows.length) throw bad('empty CSV');
    const head = rows[0].cells.map((h) => h.trim()); if (!head.includes('title')) throw bad('missing title column');
    let created = 0; const errors = [];
    for (const { line, cells } of rows.slice(1)) {
      const r = {}; head.forEach((h, n) => { r[h] = (cells[n] ?? '').trim(); });
      try {
        const b = { type: r.type || 'task', title: r.title };
        if (!TYPES.includes(b.type)) throw bad(`invalid type "${b.type}"`);
        if (!r.title) throw bad('title is required');
        if (r.status) { if (!p.workflow.statuses.some((s) => s.name === r.status)) throw bad(`unknown status "${r.status}"`); b.status = r.status; }
        if (r.priority) b.priority = r.priority;
        if (r.assignee) { const u = userByName(r.assignee); if (!u) throw bad(`unknown assignee "${r.assignee}"`); b.assigneeId = u.id; }
        if (r.labels) b.labels = r.labels.split(';').map((s) => s.trim()).filter(Boolean);
        if (r.storyPoints) { const n = Number(r.storyPoints); if (Number.isNaN(n)) throw bad('invalid storyPoints'); b.storyPoints = n; }
        if (r.parent) { if (!issueByKey(r.parent)) throw bad(`unknown parent "${r.parent}"`); b.parentId = issueByKey(r.parent).id; }
        if (r.epic) { if (!issueByKey(r.epic)) throw bad(`unknown epic "${r.epic}"`); b.epicId = issueByKey(r.epic).id; }
        if (r.sprint) { const s = db.sprints.find((x) => x.projectId === p.id && (x.name === r.sprint || x.id === r.sprint)); if (!s) throw bad(`unknown sprint "${r.sprint}"`); b.sprintId = s.id; }
        if (r.dueDate) b.dueDate = r.dueDate;
        const i = createIssue(p, user, b); created++; fire(p, 'issue.created', i, user);
      } catch (e) { if (e instanceof HttpError) errors.push({ line, message: e.message }); else throw e; }
    }
    return [200, { created, errors }];
  });

  // webhooks
  const outWh = (w) => ({ id: w.id, projectId: w.projectId, url: w.url, events: w.events, createdAt: w.createdAt });
  R('POST', '/api/projects/:id/webhooks', ({ user, params, body }) => {
    const p = getProject(user, params[0], 'lead');
    try { const u = new URL(body.url); if (!/^https?:$/.test(u.protocol)) throw 0; } catch { throw bad('invalid url'); }
    if (!Array.isArray(body.events) || !body.events.length || body.events.some((e) => !WH_EVENTS.includes(e))) throw bad('invalid events');
    if (!isStr(body.secret)) throw bad('secret is required');
    const w = { id: nid(), projectId: p.id, url: body.url, events: body.events, secret: body.secret, createdAt: iso() }; db.webhooks.push(w);
    audit(user, 'webhook.created', { id: w.id, url: w.url }, p.workspaceId); return [201, outWh(w)];
  });
  R('GET', '/api/projects/:id/webhooks', ({ user, params }) => { const p = getProject(user, params[0], 'lead'); return [200, db.webhooks.filter((w) => w.projectId === p.id).map(outWh)]; });
  R('DELETE', '/api/webhooks/:id', ({ user, params }) => {
    const w = db.webhooks.find((x) => x.id === params[0]); if (!w) throw notFound(); const p = getProject(user, w.projectId, 'lead');
    db.webhooks = db.webhooks.filter((x) => x !== w); audit(user, 'webhook.deleted', { id: w.id }, p.workspaceId); return [204];
  });
  R('GET', '/api/webhooks/:id/deliveries', ({ user, params }) => {
    const w = db.webhooks.find((x) => x.id === params[0]); if (!w) throw notFound(); getProject(user, w.projectId, 'lead');
    return [200, db.deliveries.filter((d) => d.webhookId === w.id).map(({ id, event, status, attempts, lastError, at }) => ({ id, event, status, attempts, lastError, at }))];
  });

  // ---------- server ----------
  const send = (res, status, payload, ctype) => {
    if (status === 204) { res.writeHead(204); return res.end(); }
    const body = ctype ? payload : JSON.stringify(payload);
    res.writeHead(status, { 'content-type': ctype || 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) }); res.end(body);
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > 5e6) { reject(new HttpError(413, 'too_large', 'Body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); req.on('error', reject);
  });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x'); const pn = url.pathname;
      if (req.method === 'GET' && (pn === '/' || pn.startsWith('/static/'))) {
        const f = pn === '/' ? 'index.html' : path.normalize(pn.slice(8));
        const full = path.join(STATIC_DIR, f);
        if (!full.startsWith(STATIC_DIR) || !fs.existsSync(full) || !fs.statSync(full).isFile()) throw notFound();
        return send(res, 200, fs.readFileSync(full), MIME[path.extname(full)] || 'application/octet-stream');
      }
      if (!pn.startsWith('/api/')) throw notFound();
      let matched = null; let pathMatched = false;
      for (const r of routes) { const m = r.re.exec(pn); if (m) { pathMatched = true; if (r.method === req.method) { matched = { r, params: m.slice(1).map(decodeURIComponent) }; break; } } }
      if (!matched) { if (pathMatched) throw new HttpError(405, 'method_not_allowed', 'Method not allowed'); throw notFound(); }
      let user = null; let token = null;
      if (matched.r.auth) {
        const h = req.headers.authorization || ''; token = h.startsWith('Bearer ') ? h.slice(7).trim() : null;
        if (token) { const hh = sha(token); const s = db.sessions.find((x) => x.hash === hh) || db.apiTokens.find((x) => x.hash === hh); user = s && userById(s.userId); }
        if (!user) throw new HttpError(401, 'unauthorized', 'Authentication required');
      }
      const raw = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : '';
      let body = {};
      if (req.url.includes('import.csv') && req.method === 'POST') body = raw;
      else if (raw.trim()) { try { body = JSON.parse(raw); } catch { throw bad('Invalid JSON'); } if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('Body must be an object'); }
      const out = matched.r.fn({ req, user, token, params: matched.params, query: url.searchParams, body });
      if (req.method !== 'GET') save();
      send(res, out[0], out[1], out[2]);
    } catch (e) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.error, message: e.message });
      console.error(e); send(res, 500, { error: 'internal_error', message: 'Internal error' });
    }
  });
  return server;
}
