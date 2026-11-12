// pm-s4 — lightweight project management server (node:http, stdlib only)
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { csvParseRows, csvFormatRows } from './csv.js';

const STATIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'static');

const ISSUE_TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'];
const CATEGORIES = ['backlog', 'unstarted', 'started', 'completed'];
const WS_ROLES = ['admin', 'member', 'guest'];
const PROJECT_ROLES = ['lead', 'developer', 'viewer'];
const LINK_TYPES = ['blocks', 'relates', 'duplicates'];
const INVERSE = { blocks: 'blocked_by', relates: 'relates', duplicates: 'duplicated_by' };
const WEBHOOK_EVENTS = ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'];
const CSV_COLUMNS = ['key', 'type', 'title', 'status', 'priority', 'assignee', 'labels', 'storyPoints', 'parent', 'epic', 'sprint', 'dueDate', 'createdAt', 'resolvedAt'];
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const DAY_MS = 86400000;

class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}
const bad = (msg, code = 'validation_error') => new HttpError(400, code, msg);
const forbidden = (msg = 'Forbidden') => new HttpError(403, 'forbidden', msg);
const notFound = (msg = 'Not found') => new HttpError(404, 'not_found', msg);
const conflict = (msg, code = 'conflict') => new HttpError(409, code, msg);

const newId = () => crypto.randomBytes(8).toString('hex');
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
function verifyPassword(pw, user) {
  const h = crypto.scryptSync(pw, user.salt, 64);
  const ref = Buffer.from(user.passwordHash, 'hex');
  return h.length === ref.length && crypto.timingSafeEqual(h, ref);
}
const isDateStr = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
const nonEmptyStr = s => typeof s === 'string' && s.trim().length > 0;

function emptyData() {
  return {
    users: [], sessions: [], tokens: [], workspaces: [], wsMembers: [], projects: [], projMembers: [],
    issues: [], links: [], comments: [], history: {}, notifications: [], sprints: [], webhooks: [],
    deliveries: [], audit: [], loginFailures: {},
  };
}

export function createServer({ dataFile, clock } = {}) {
  const now = () => (clock ? new Date(clock()) : new Date());
  const nowIso = () => now().toISOString();

  let data = emptyData();
  if (dataFile && fs.existsSync(dataFile)) {
    try { data = { ...emptyData(), ...JSON.parse(fs.readFileSync(dataFile, 'utf8')) }; } catch { data = emptyData(); }
  }
  function save() {
    if (!dataFile) return;
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, dataFile);
  }

  // ---------- lookups / views ----------
  const publicUser = u => u && ({ id: u.id, username: u.username, displayName: u.displayName });
  const userById = id => data.users.find(u => u.id === id);
  const userByName = name => typeof name === 'string' ? data.users.find(u => u.username.toLowerCase() === name.toLowerCase()) : undefined;
  const wsMember = (wsId, userId) => data.wsMembers.find(m => m.workspaceId === wsId && m.userId === userId);
  const projMember = (pId, userId) => data.projMembers.find(m => m.projectId === pId && m.userId === userId);

  function getWorkspace(id, user) {
    const ws = data.workspaces.find(w => w.id === id || w.key === id);
    if (!ws) throw notFound('Workspace not found');
    const m = wsMember(ws.id, user.id);
    if (!m) throw forbidden('Not a member of this workspace');
    return { ws, role: m.role };
  }
  function requireWsAdmin(id, user) {
    const r = getWorkspace(id, user);
    if (r.role !== 'admin') throw forbidden('Workspace admin required');
    return r;
  }
  function projectRole(user, project) {
    const wm = wsMember(project.workspaceId, user.id);
    if (!wm) return null;
    if (wm.role === 'admin') return 'lead';
    const pm = projMember(project.id, user.id);
    if (pm) return pm.role;
    if (wm.role === 'member') return 'developer';
    return null; // guests must be explicitly added
  }
  const canSee = (user, project) => !!projectRole(user, project);
  function getProject(id, user, need = 'viewer') {
    const p = data.projects.find(x => x.id === id) || data.projects.find(x => x.key === id);
    if (!p) throw notFound('Project not found');
    const role = projectRole(user, p);
    if (!role) throw forbidden('No access to this project');
    const rank = { viewer: 0, developer: 1, lead: 2 };
    if (rank[role] < rank[need]) throw forbidden(`Project ${need} role required`);
    return { project: p, role };
  }
  function findIssue(ref) {
    if (typeof ref !== 'string' && typeof ref !== 'number') return undefined;
    ref = String(ref);
    return data.issues.find(i => i.id === ref) || data.issues.find(i => i.key.toLowerCase() === ref.toLowerCase());
  }
  function getIssue(ref, user, need = 'viewer') {
    const issue = findIssue(ref);
    if (!issue) throw notFound('Issue not found');
    const { project, role } = getProject(issue.projectId, user, need);
    return { issue, project, role };
  }
  const statusOf = (project, name) => project.workflow.statuses.find(s => s.name === name);
  const categoryOf = (project, name) => statusOf(project, name)?.category;
  const isCompleted = (project, issue) => categoryOf(project, issue.status) === 'completed';
  const projectById = id => data.projects.find(p => p.id === id);

  function issueLinks(issue) {
    const out = [];
    for (const l of data.links) {
      if (l.sourceId === issue.id) {
        const t = data.issues.find(i => i.id === l.targetId);
        if (t) out.push({ id: l.id, type: l.type, key: t.key, issueKey: t.key, target: t.key, issueId: t.id });
      } else if (l.targetId === issue.id) {
        const s = data.issues.find(i => i.id === l.sourceId);
        if (s) out.push({ id: l.id, type: INVERSE[l.type], key: s.key, issueKey: s.key, target: s.key, issueId: s.id });
      }
    }
    return out;
  }
  function baseIssue(i) {
    const { startedAt, ...rest } = i;
    return { ...rest, labels: [...i.labels], watchers: [...i.watchers] };
  }
  function issueView(i) {
    const v = baseIssue(i);
    v.children = data.issues.filter(c => c.parentId === i.id).map(c => c.key);
    v.links = issueLinks(i);
    if (i.type === 'epic') {
      const project = projectById(i.projectId);
      const kids = data.issues.filter(c => c.epicId === i.id);
      const done = kids.filter(c => isCompleted(project, c));
      const pts = arr => arr.reduce((s, c) => s + (Number(c.storyPoints) || 0), 0);
      v.progress = { total: kids.length, done: done.length, points_total: pts(kids), points_done: pts(done) };
    }
    return v;
  }
  function projectView(p, role) {
    return { id: p.id, workspaceId: p.workspaceId, name: p.name, key: p.key, description: p.description || '', workflow: p.workflow, createdAt: p.createdAt, ...(role ? { role } : {}) };
  }
  const sprintView = s => ({ ...s });

  // ---------- audit / notifications / history / webhooks ----------
  function audit(workspaceId, actorId, action, details = {}) {
    data.audit.push({ id: newId(), workspaceId, actorId, action, details, at: nowIso() });
  }
  function notify(userIds, type, issue, actorId, extra = {}) {
    const project = projectById(issue.projectId);
    const seen = new Set();
    for (const uid of userIds) {
      if (!uid || uid === actorId || seen.has(uid)) continue;
      seen.add(uid);
      const u = userById(uid);
      if (!u || !canSee(u, project)) continue;
      data.notifications.push({ id: newId(), userId: uid, type, issueKey: issue.key, actorId, at: nowIso(), read: false, ...extra });
    }
  }
  function addHistory(issue, field, from, to, actorId, at) {
    (data.history[issue.id] ||= []).push({ field, from: from === undefined ? null : from, to: to === undefined ? null : to, actorId, at });
  }
  function fireWebhooks(project, event, payloadExtra) {
    const hooks = data.webhooks.filter(h => h.projectId === project.id && h.events.includes(event));
    for (const h of hooks) {
      const body = JSON.stringify({ event, ...payloadExtra, at: nowIso() });
      const delivery = { id: newId(), webhookId: h.id, event, status: null, attempts: 0, lastError: null, createdAt: nowIso() };
      data.deliveries.push(delivery);
      deliver(h, delivery, body);
    }
  }
  async function deliver(hook, delivery, body) {
    const sig = 'sha256=' + crypto.createHmac('sha256', hook.secret || '').update(body).digest('hex');
    for (let attempt = 1; attempt <= 3; attempt++) {
      delivery.attempts = attempt;
      try {
        const res = await fetch(hook.url, {
          method: 'POST', body, signal: AbortSignal.timeout(5000),
          headers: { 'content-type': 'application/json', 'x-pm-signature': sig, 'x-pm-event': delivery.event, 'x-pm-delivery': delivery.id },
        });
        delivery.status = res.status;
        try { await res.arrayBuffer(); } catch {}
        if (res.ok) { delivery.lastError = null; break; }
        delivery.lastError = `HTTP ${res.status}`;
      } catch (e) {
        delivery.lastError = String(e?.cause?.message || e?.message || e);
      }
      try { save(); } catch {}
      if (attempt < 3) await new Promise(r => setTimeout(r, 50 * attempt));
    }
    delivery.completedAt = new Date().toISOString();
    try { save(); } catch {}
  }

  // ---------- auth ----------
  function authenticate(req) {
    const h = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (!m) return null;
    const hashed = sha256(m[1].trim());
    const s = data.sessions.find(x => x.tokenHash === hashed);
    if (s) return userById(s.userId) || null;
    const t = data.tokens.find(x => x.tokenHash === hashed);
    if (t) { t.lastUsedAt = nowIso(); return userById(t.userId) || null; }
    return null;
  }

  // ---------- validation of issue fields ----------
  function resolveUserRef(v) {
    if (v === null || v === undefined || v === '') return null;
    return userById(v) || userByName(v);
  }
  function validateIssueInput(project, input, existing) {
    const out = {};
    const has = k => Object.prototype.hasOwnProperty.call(input, k) && input[k] !== undefined;
    if (has('title')) { if (!nonEmptyStr(input.title)) throw bad('title is required'); out.title = input.title.trim(); }
    else if (!existing) throw bad('title is required');
    if (has('description')) { if (input.description !== null && typeof input.description !== 'string') throw bad('description must be a string'); out.description = input.description ?? ''; }
    if (has('type')) { if (!ISSUE_TYPES.includes(input.type)) throw bad('invalid type'); out.type = input.type; }
    if (has('priority')) { if (!PRIORITIES.includes(input.priority)) throw bad('invalid priority'); out.priority = input.priority; }
    if (has('status')) { if (typeof input.status !== 'string' || !statusOf(project, input.status)) throw bad('unknown status'); out.status = input.status; }
    if (has('assigneeId') || has('assignee')) {
      const ref = has('assigneeId') ? input.assigneeId : input.assignee;
      if (ref === null || ref === '') out.assigneeId = null;
      else {
        const u = resolveUserRef(ref);
        if (!u) throw bad('unknown assignee');
        if (!canSee(u, project)) throw bad('assignee has no access to this project');
        out.assigneeId = u.id;
      }
    }
    if (has('labels')) {
      if (input.labels === null) out.labels = [];
      else {
        if (!Array.isArray(input.labels) || !input.labels.every(l => typeof l === 'string' && l.trim())) throw bad('labels must be an array of strings');
        out.labels = [...new Set(input.labels.map(l => l.trim()))];
      }
    }
    if (has('storyPoints')) {
      const sp = input.storyPoints;
      if (sp === null) out.storyPoints = null;
      else if (typeof sp !== 'number' || !isFinite(sp) || sp < 0) throw bad('storyPoints must be a non-negative number');
      else out.storyPoints = sp;
    }
    if (has('dueDate')) {
      if (input.dueDate === null || input.dueDate === '') out.dueDate = null;
      else if (!isDateStr(input.dueDate)) throw bad('dueDate must be YYYY-MM-DD');
      else out.dueDate = input.dueDate;
    }
    if (has('sprintId')) {
      if (input.sprintId === null || input.sprintId === '') out.sprintId = null;
      else {
        const s = data.sprints.find(x => x.id === input.sprintId);
        if (!s || s.projectId !== project.id) throw bad('unknown sprint');
        if (s.state === 'completed') throw bad('sprint is completed');
        out.sprintId = s.id;
      }
    }
    if (has('parentId')) {
      if (input.parentId === null || input.parentId === '') out.parentId = null;
      else {
        const p = findIssue(input.parentId);
        if (!p) throw bad('unknown parent');
        if (p.projectId !== project.id) throw bad('parent must be in the same project');
        if (p.type === 'subtask') throw bad('parent cannot be a subtask');
        if (existing && p.id === existing.id) throw bad('issue cannot be its own parent');
        out.parentId = p.id;
      }
    }
    if (has('epicId')) {
      if (input.epicId === null || input.epicId === '') out.epicId = null;
      else {
        const e = findIssue(input.epicId);
        if (!e) throw bad('unknown epic');
        if (e.type !== 'epic') throw bad('epicId must reference an epic');
        if (e.projectId !== project.id) throw bad('epic must be in the same project');
        if (existing && e.id === existing.id) throw bad('issue cannot be its own epic');
        out.epicId = e.id;
      }
    }
    const type = out.type ?? existing?.type ?? 'task';
    const parentId = 'parentId' in out ? out.parentId : existing?.parentId ?? null;
    const epicId = 'epicId' in out ? out.epicId : existing?.epicId ?? null;
    if (type === 'subtask' && !parentId) throw bad('subtasks require a parentId');
    if (type === 'epic' && parentId) throw bad('epics cannot have a parent');
    if (type === 'epic' && epicId) throw bad('epics cannot belong to an epic');
    if (existing && type === 'subtask' && data.issues.some(c => c.parentId === existing.id)) throw bad('an issue with subtasks cannot become a subtask');
    if (existing && existing.type === 'epic' && type !== 'epic' && data.issues.some(c => c.epicId === existing.id)) throw bad('epic has issues');
    return out;
  }
  function unresolvedBlockers(issue) {
    return data.links.filter(l => l.type === 'blocks' && l.targetId === issue.id).map(l => data.issues.find(i => i.id === l.sourceId))
      .filter(b => b && !isCompleted(projectById(b.projectId), b));
  }
  function applyStatus(project, issue, status, at) {
    const cat = categoryOf(project, status);
    issue.status = status;
    if (cat === 'started' && !issue.startedAt) issue.startedAt = at;
    if (cat === 'completed') { if (!issue.resolvedAt) issue.resolvedAt = at; }
    else issue.resolvedAt = null;
  }
  function createIssueRecord(project, fields, actor) {
    const at = nowIso();
    const initial = project.workflow.statuses.find(s => s.category === 'unstarted') || project.workflow.statuses[0];
    project.nextIssueNumber = (project.nextIssueNumber || 1);
    const n = project.nextIssueNumber++;
    const issue = {
      id: newId(), key: `${project.key}-${n}`, projectId: project.id, type: fields.type || 'task', title: fields.title,
      description: fields.description ?? '', status: initial.name, priority: fields.priority || 'none',
      assigneeId: fields.assigneeId ?? null, reporterId: actor.id, labels: fields.labels || [],
      storyPoints: fields.storyPoints ?? null, parentId: fields.parentId ?? null, epicId: fields.epicId ?? null,
      sprintId: fields.sprintId ?? null, dueDate: fields.dueDate ?? null, watchers: [],
      createdAt: at, updatedAt: at, resolvedAt: null, startedAt: null,
    };
    applyStatus(project, issue, fields.status || initial.name, at);
    issue.watchers = [...new Set([actor.id, issue.assigneeId].filter(Boolean))];
    data.issues.push(issue);
    data.history[issue.id] = [];
    return issue;
  }

  // ---------- search ----------
  const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3, none: 4 };
  function parseQuery(q) {
    q = (q || '').trim();
    if (!q) return [];
    if (((q.match(/"/g) || []).length) % 2 === 1) throw bad('Unbalanced quotes in query', 'invalid_query');
    // Tokenizer regex adapted from Stack Overflow answer https://stackoverflow.com/a/16261693 (CC BY-SA 3.0)
    const tokens = q.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    const unq = s => s.replace(/"/g, '');
    const terms = [];
    for (let tok of tokens) {
      let neg = false;
      if (tok.startsWith('-') && tok.length > 1) { neg = true; tok = tok.slice(1); }
      const m = /^([a-zA-Z]+):(.*)$/.exec(tok);
      if (m) {
        const field = m[1].toLowerCase();
        const value = unq(m[2]);
        if (!value) throw bad(`Missing value for ${field}`, 'invalid_query');
        terms.push({ neg, ...compileField(field, value) });
      } else {
        const text = unq(tok).toLowerCase();
        if (!text) throw bad('Empty search term', 'invalid_query');
        terms.push({ neg, kind: 'text', text });
      }
    }
    return terms;
  }
  function parseCmp(value, isNum) {
    const m = /^(<=|>=|<|>|=)?(.+)$/.exec(value);
    const op = m[1] || '=';
    const v = m[2];
    if (isNum) { if (!/^-?\d+(\.\d+)?$/.test(v)) throw bad('Invalid number', 'invalid_query'); return { op, v: Number(v) }; }
    if (!isDateStr(v)) throw bad('Invalid date', 'invalid_query');
    return { op, v };
  }
  const cmp = (a, op, b) => op === '<' ? a < b : op === '>' ? a > b : op === '<=' ? a <= b : op === '>=' ? a >= b : a === b;
  function compileField(field, value) {
    const lv = value.toLowerCase();
    switch (field) {
      case 'status': return { kind: 'status', value: lv };
      case 'type': if (!ISSUE_TYPES.includes(lv)) throw bad('Invalid type', 'invalid_query'); return { kind: 'type', value: lv };
      case 'priority': if (!PRIORITIES.includes(lv)) throw bad('Invalid priority', 'invalid_query'); return { kind: 'priority', value: lv };
      case 'assignee': return { kind: 'assignee', value };
      case 'label': return { kind: 'label', value: lv };
      case 'sprint': return { kind: 'sprint', value };
      case 'is': if (!['open', 'resolved'].includes(lv)) throw bad('is: must be open or resolved', 'invalid_query'); return { kind: 'is', value: lv };
      case 'due': return { kind: 'due', ...parseCmp(value, false) };
      case 'points': return { kind: 'points', ...parseCmp(value, true) };
      case 'key': return { kind: 'key', value: lv };
      default: throw bad(`Unknown field: ${field}`, 'invalid_query');
    }
  }
  function matchTerm(t, issue, project, user) {
    switch (t.kind) {
      case 'text': return issue.title.toLowerCase().includes(t.text) || (issue.description || '').toLowerCase().includes(t.text);
      case 'status': return issue.status.toLowerCase() === t.value;
      case 'type': return issue.type === t.value;
      case 'priority': return issue.priority === t.value;
      case 'assignee': {
        if (t.value.toLowerCase() === 'me') return issue.assigneeId === user.id;
        if (t.value.toLowerCase() === 'none') return !issue.assigneeId;
        const u = userByName(t.value);
        return !!u && issue.assigneeId === u.id;
      }
      case 'label': return issue.labels.some(l => l.toLowerCase() === t.value);
      case 'sprint': {
        if (t.value.toLowerCase() === 'none') return !issue.sprintId;
        if (t.value.toLowerCase() === 'active') { const s = data.sprints.find(x => x.id === issue.sprintId); return !!s && s.state === 'active'; }
        const s = data.sprints.find(x => x.id === issue.sprintId);
        return !!s && (s.id === t.value || s.name.toLowerCase() === t.value.toLowerCase());
      }
      case 'is': return t.value === 'resolved' ? isCompleted(project, issue) : !isCompleted(project, issue);
      case 'due': return !!issue.dueDate && cmp(issue.dueDate, t.op, t.v);
      case 'points': return issue.storyPoints !== null && issue.storyPoints !== undefined && cmp(Number(issue.storyPoints), t.op, t.v);
      case 'key': return issue.key.toLowerCase() === t.value;
    }
    return false;
  }

  // ---------- burndown ----------
  function issueStateAt(issue, T) {
    if (Date.parse(issue.createdAt) >= T) return null;
    const st = { status: issue.status, storyPoints: issue.storyPoints, sprintId: issue.sprintId };
    const hist = data.history[issue.id] || [];
    for (let k = hist.length - 1; k >= 0; k--) {
      const h = hist[k];
      if (Date.parse(h.at) < T) break;
      if (h.field in st) st[h.field] = h.from;
    }
    return st;
  }
  function sprintReport(sprint) {
    const project = projectById(sprint.projectId);
    const inSprint = data.issues.filter(i => i.sprintId === sprint.id);
    const pts = i => Number(i.storyPoints) || 0;
    const nowD = now();
    let completedIssues, completedPoints, carriedOver;
    if (sprint.state === 'completed' && sprint.completion) {
      ({ completedIssues, completedPoints, carriedOver } = sprint.completion);
    } else {
      const done = inSprint.filter(i => isCompleted(project, i));
      completedIssues = done.length; completedPoints = done.reduce((s, i) => s + pts(i), 0); carriedOver = 0;
    }
    const committedPoints = sprint.committedPoints ?? inSprint.reduce((s, i) => s + pts(i), 0);
    const burndown = [];
    const startDay = (sprint.startDate || (sprint.startedAt || '').slice(0, 10));
    if (isDateStr(startDay)) {
      const today = nowD.toISOString().slice(0, 10);
      const endCap = sprint.state === 'completed' && sprint.completedAt ? sprint.completedAt.slice(0, 10) : today;
      let endDay = endCap;
      if (sprint.endDate && isDateStr(sprint.endDate) && sprint.endDate < endDay) endDay = sprint.endDate;
      const issues = data.issues.filter(i => i.projectId === project.id);
      for (let d = Date.parse(startDay + 'T00:00:00Z'); d <= Date.parse(endDay + 'T00:00:00Z'); d += DAY_MS) {
        const T = Math.min(d + DAY_MS, nowD.getTime());
        let remaining = 0;
        for (const i of issues) {
          const st = issueStateAt(i, T);
          if (!st || st.sprintId !== sprint.id) continue;
          if (categoryOf(project, st.status) === 'completed') continue;
          remaining += Number(st.storyPoints) || 0;
        }
        burndown.push({ date: new Date(d).toISOString().slice(0, 10), remainingPoints: remaining });
      }
    }
    return { sprintId: sprint.id, committedPoints, completedPoints, completedIssues, carriedOver, burndown };
  }

  // ---------- CSV ----------
  function exportCsv(project) {
    const rows = [CSV_COLUMNS];
    const issues = data.issues.filter(i => i.projectId === project.id).sort((a, b) => Number(a.key.split('-').pop()) - Number(b.key.split('-').pop()));
    for (const i of issues) {
      const keyOf = id => (id && data.issues.find(x => x.id === id)?.key) || '';
      const sprint = i.sprintId ? data.sprints.find(s => s.id === i.sprintId) : null;
      rows.push([i.key, i.type, i.title, i.status, i.priority, i.assigneeId ? userById(i.assigneeId)?.username || '' : '',
        i.labels.join(';'), i.storyPoints ?? '', keyOf(i.parentId), keyOf(i.epicId), sprint ? sprint.name : '', i.dueDate || '', i.createdAt, i.resolvedAt || '']);
    }
    return csvFormatRows(rows);
  }
  function importCsv(project, text, actor) {
    const rows = csvParseRows(text);
    if (rows.unterminated) throw bad('Malformed CSV: unterminated quoted field');
    if (!rows.length) throw bad('CSV is empty');
    const header = rows[0].map(h => h.trim());
    const idx = Object.fromEntries(header.map((h, i) => [h, i]));
    if (!('title' in idx)) throw bad('CSV header must include title');
    let created = 0;
    const errors = [];
    const createdIssues = [];
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      const line = r + 1;
      if (row.length === 1 && row[0].trim() === '' && header.length > 1) continue;
      const get = c => (c in idx ? (row[idx[c]] ?? '').trim() : '');
      try {
        if (row.length !== header.length) throw bad(`Expected ${header.length} columns, got ${row.length}`);
        const input = { title: get('title') };
        if (get('type')) input.type = get('type').toLowerCase();
        if (get('priority')) input.priority = get('priority').toLowerCase();
        if (get('status')) {
          const s = project.workflow.statuses.find(x => x.name.toLowerCase() === get('status').toLowerCase());
          if (!s) throw bad(`Unknown status "${get('status')}"`);
          input.status = s.name;
        }
        if (get('assignee')) input.assignee = get('assignee');
        if (get('labels')) input.labels = get('labels').split(';').map(s => s.trim()).filter(Boolean);
        if (get('storyPoints')) {
          const n = Number(get('storyPoints'));
          if (!isFinite(n)) throw bad('storyPoints must be a number');
          input.storyPoints = n;
        }
        if (get('parent')) input.parentId = get('parent');
        if (get('epic')) input.epicId = get('epic');
        if (get('sprint')) {
          const v = get('sprint');
          const s = data.sprints.find(x => x.projectId === project.id && (x.id === v || x.name === v));
          if (!s) throw bad(`Unknown sprint "${v}"`);
          input.sprintId = s.id;
        }
        if (get('dueDate')) input.dueDate = get('dueDate');
        const fields = validateIssueInput(project, input, null);
        const issue = createIssueRecord(project, fields, actor);
        created++;
        createdIssues.push(issue);
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        errors.push({ line, message: e.message });
      }
    }
    return { created, errors, createdIssues };
  }

  // ---------- routing ----------
  const routes = [];
  const route = (method, pattern, handler, opts = {}) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
    routes.push({ method, re, keys, handler, auth: opts.auth !== false });
  };

  // --- auth ---
  route('POST', '/api/auth/register', ({ body }) => {
    const { username, password, displayName } = body;
    if (typeof username !== 'string' || !/^[A-Za-z0-9_.-]{2,32}$/.test(username)) throw bad('username must be 2-32 characters of letters, digits, _ . -');
    if (typeof password !== 'string' || password.length < 8) throw bad('password must be at least 8 characters');
    if (displayName !== undefined && displayName !== null && typeof displayName !== 'string') throw bad('displayName must be a string');
    if (userByName(username)) throw conflict('Username already taken');
    const { salt, hash } = hashPassword(password);
    const user = { id: newId(), username, displayName: (displayName && displayName.trim()) || username, salt, passwordHash: hash, createdAt: nowIso() };
    data.users.push(user);
    return [201, { user: publicUser(user) }];
  }, { auth: false });

  route('POST', '/api/auth/login', ({ body }) => {
    const { username, password } = body;
    if (typeof username !== 'string' || typeof password !== 'string') throw bad('username and password are required');
    const k = username.toLowerCase();
    const t = now().getTime();
    const fails = (data.loginFailures[k] || []).filter(x => t - x < LOGIN_WINDOW_MS);
    data.loginFailures[k] = fails;
    if (fails.length >= LOGIN_MAX_FAILURES) throw new HttpError(429, 'rate_limited', 'Too many failed login attempts');
    const user = userByName(username);
    if (!user || !verifyPassword(password, user)) {
      fails.push(t);
      throw new HttpError(401, 'invalid_credentials', 'Invalid username or password');
    }
    delete data.loginFailures[k];
    const token = crypto.randomBytes(32).toString('hex');
    data.sessions.push({ tokenHash: sha256(token), userId: user.id, createdAt: nowIso() });
    return [200, { token, user: publicUser(user) }];
  }, { auth: false });

  route('POST', '/api/auth/logout', ({ req }) => {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '');
    if (m) { const h = sha256(m[1].trim()); data.sessions = data.sessions.filter(s => s.tokenHash !== h); }
    return [204];
  });
  route('GET', '/api/auth/me', ({ user }) => [200, { user: publicUser(user) }]);
  route('PATCH', '/api/auth/me', ({ user, body }) => {
    const { displayName, password, currentPassword } = body;
    if (password !== undefined) {
      if (typeof currentPassword !== 'string') throw bad('currentPassword is required');
      if (!verifyPassword(currentPassword, user)) throw forbidden('currentPassword is incorrect');
      if (typeof password !== 'string' || password.length < 8) throw bad('password must be at least 8 characters');
    } else if (currentPassword !== undefined && (typeof currentPassword !== 'string' || !verifyPassword(currentPassword, user))) {
      throw forbidden('currentPassword is incorrect');
    }
    if (displayName !== undefined && !nonEmptyStr(displayName)) throw bad('displayName must be a non-empty string');
    if (displayName !== undefined) user.displayName = displayName.trim();
    if (password !== undefined) { const { salt, hash } = hashPassword(password); user.salt = salt; user.passwordHash = hash; }
    return [200, { user: publicUser(user) }];
  });

  // --- API tokens ---
  const auditUserWorkspaces = (user, action, details) => {
    for (const m of data.wsMembers.filter(x => x.userId === user.id)) audit(m.workspaceId, user.id, action, details);
  };
  route('POST', '/api/tokens', ({ user, body }) => {
    if (!nonEmptyStr(body.name)) throw bad('name is required');
    const token = 'pm_' + crypto.randomBytes(24).toString('hex');
    const rec = { id: newId(), userId: user.id, name: body.name.trim(), tokenHash: sha256(token), createdAt: nowIso(), lastUsedAt: null };
    data.tokens.push(rec);
    auditUserWorkspaces(user, 'token.created', { tokenId: rec.id, name: rec.name });
    return [201, { id: rec.id, name: rec.name, token, createdAt: rec.createdAt }];
  });
  route('GET', '/api/tokens', ({ user }) => [200, data.tokens.filter(t => t.userId === user.id).map(t => ({ id: t.id, name: t.name, createdAt: t.createdAt, lastUsedAt: t.lastUsedAt }))]);
  route('DELETE', '/api/tokens/:id', ({ user, params }) => {
    const t = data.tokens.find(x => x.id === params.id);
    if (!t) throw notFound('Token not found');
    if (t.userId !== user.id) throw forbidden();
    data.tokens = data.tokens.filter(x => x !== t);
    auditUserWorkspaces(user, 'token.deleted', { tokenId: t.id, name: t.name });
    return [204];
  });

  // --- workspaces ---
  const wsView = (ws, role) => ({ id: ws.id, name: ws.name, key: ws.key, createdAt: ws.createdAt, ...(role ? { role } : {}) });
  const memberView = m => ({ userId: m.userId, username: userById(m.userId)?.username, displayName: userById(m.userId)?.displayName, role: m.role, user: publicUser(userById(m.userId)) });
  route('POST', '/api/workspaces', ({ user, body }) => {
    if (!nonEmptyStr(body.name)) throw bad('name is required');
    if (typeof body.key !== 'string' || !/^[A-Z]{2,10}$/.test(body.key)) throw bad('key must be 2-10 uppercase letters');
    if (data.workspaces.some(w => w.key === body.key)) throw conflict('Workspace key already in use');
    const ws = { id: newId(), name: body.name.trim(), key: body.key, createdAt: nowIso(), createdBy: user.id };
    data.workspaces.push(ws);
    data.wsMembers.push({ workspaceId: ws.id, userId: user.id, role: 'admin', addedAt: nowIso() });
    return [201, wsView(ws, 'admin')];
  });
  route('GET', '/api/workspaces', ({ user }) => [200, data.wsMembers.filter(m => m.userId === user.id).map(m => wsView(data.workspaces.find(w => w.id === m.workspaceId), m.role)).filter(w => w.id)]);
  route('GET', '/api/workspaces/:id', ({ user, params }) => {
    const { ws, role } = getWorkspace(params.id, user);
    return [200, { ...wsView(ws, role), members: data.wsMembers.filter(m => m.workspaceId === ws.id).map(memberView) }];
  });
  route('PATCH', '/api/workspaces/:id', ({ user, params, body }) => {
    const { ws, role } = requireWsAdmin(params.id, user);
    if (body.name !== undefined) { if (!nonEmptyStr(body.name)) throw bad('name must be non-empty'); ws.name = body.name.trim(); }
    return [200, wsView(ws, role)];
  });
  route('GET', '/api/workspaces/:id/members', ({ user, params }) => {
    const { ws } = getWorkspace(params.id, user);
    return [200, data.wsMembers.filter(m => m.workspaceId === ws.id).map(memberView)];
  });
  route('POST', '/api/workspaces/:id/members', ({ user, params, body }) => {
    const { ws } = requireWsAdmin(params.id, user);
    const role = body.role ?? 'member';
    if (!WS_ROLES.includes(role)) throw bad('invalid role');
    const target = resolveUserRef(body.username ?? body.userId);
    if (!target) throw notFound('User not found');
    if (wsMember(ws.id, target.id)) throw conflict('User is already a member');
    const m = { workspaceId: ws.id, userId: target.id, role, addedAt: nowIso() };
    data.wsMembers.push(m);
    audit(ws.id, user.id, 'member.added', { userId: target.id, username: target.username, role });
    return [201, memberView(m)];
  });
  const findWsMemberParam = (ws, ref) => {
    const u = resolveUserRef(ref);
    const m = u && wsMember(ws.id, u.id);
    if (!m) throw notFound('Member not found');
    return m;
  };
  const adminCount = wsId => data.wsMembers.filter(m => m.workspaceId === wsId && m.role === 'admin').length;
  route('PATCH', '/api/workspaces/:id/members/:userId', ({ user, params, body }) => {
    const { ws } = requireWsAdmin(params.id, user);
    const m = findWsMemberParam(ws, params.userId);
    if (!WS_ROLES.includes(body.role)) throw bad('invalid role');
    if (m.role === 'admin' && body.role !== 'admin' && adminCount(ws.id) <= 1) throw bad('Cannot demote the last admin', 'last_admin');
    const from = m.role;
    m.role = body.role;
    if (from !== m.role) audit(ws.id, user.id, 'member.role_changed', { userId: m.userId, from, to: m.role });
    return [200, memberView(m)];
  });
  route('DELETE', '/api/workspaces/:id/members/:userId', ({ user, params }) => {
    const { ws } = requireWsAdmin(params.id, user);
    const m = findWsMemberParam(ws, params.userId);
    if (m.role === 'admin' && adminCount(ws.id) <= 1) throw bad('Cannot remove the last admin', 'last_admin');
    data.wsMembers = data.wsMembers.filter(x => x !== m);
    const pids = new Set(data.projects.filter(p => p.workspaceId === ws.id).map(p => p.id));
    data.projMembers = data.projMembers.filter(pm => !(pm.userId === m.userId && pids.has(pm.projectId)));
    audit(ws.id, user.id, 'member.removed', { userId: m.userId });
    return [204];
  });
  route('GET', '/api/workspaces/:id/audit', ({ user, params }) => {
    const { ws } = requireWsAdmin(params.id, user);
    return [200, data.audit.filter(a => a.workspaceId === ws.id)];
  });

  // --- projects ---
  function defaultWorkflow() {
    const statuses = [
      { name: 'Backlog', category: 'backlog' }, { name: 'Todo', category: 'unstarted' }, { name: 'In Progress', category: 'started' },
      { name: 'In Review', category: 'started' }, { name: 'Done', category: 'completed' },
    ];
    return { statuses, transitions: allTransitions(statuses) };
  }
  function allTransitions(statuses) {
    const t = [];
    for (const a of statuses) for (const b of statuses) if (a.name !== b.name) t.push([a.name, b.name]);
    return t;
  }
  route('POST', '/api/workspaces/:id/projects', ({ user, params, body }) => {
    const { ws, role } = getWorkspace(params.id, user);
    if (role === 'guest') throw forbidden('Guests cannot create projects');
    if (!nonEmptyStr(body.name)) throw bad('name is required');
    if (typeof body.key !== 'string' || !/^[A-Z][A-Z0-9]{1,9}$/.test(body.key)) throw bad('key must be 2-10 uppercase letters');
    if (data.projects.some(p => p.workspaceId === ws.id && p.key === body.key)) throw conflict('Project key already in use');
    const p = { id: newId(), workspaceId: ws.id, name: body.name.trim(), key: body.key, description: typeof body.description === 'string' ? body.description : '', workflow: defaultWorkflow(), nextIssueNumber: 1, createdAt: nowIso(), createdBy: user.id };
    data.projects.push(p);
    data.projMembers.push({ projectId: p.id, userId: user.id, role: 'lead', addedAt: nowIso() });
    return [201, projectView(p, projectRole(user, p))];
  });
  route('GET', '/api/workspaces/:id/projects', ({ user, params }) => {
    const { ws } = getWorkspace(params.id, user);
    return [200, data.projects.filter(p => p.workspaceId === ws.id && canSee(user, p)).map(p => projectView(p, projectRole(user, p)))];
  });
  route('GET', '/api/projects', ({ user }) => [200, data.projects.filter(p => canSee(user, p)).map(p => projectView(p, projectRole(user, p)))]);
  route('GET', '/api/projects/:id', ({ user, params }) => { const { project, role } = getProject(params.id, user); return [200, projectView(project, role)]; });
  route('PATCH', '/api/projects/:id', ({ user, params, body }) => {
    const { project, role } = getProject(params.id, user, 'lead');
    if (body.name !== undefined) { if (!nonEmptyStr(body.name)) throw bad('name must be non-empty'); project.name = body.name.trim(); }
    if (body.description !== undefined) { if (typeof body.description !== 'string') throw bad('description must be a string'); project.description = body.description; }
    return [200, projectView(project, role)];
  });
  route('DELETE', '/api/projects/:id', ({ user, params }) => {
    const { project } = getProject(params.id, user, 'lead');
    const ids = new Set(data.issues.filter(i => i.projectId === project.id).map(i => i.id));
    data.issues = data.issues.filter(i => !ids.has(i.id));
    data.links = data.links.filter(l => !ids.has(l.sourceId) && !ids.has(l.targetId));
    data.comments = data.comments.filter(c => !ids.has(c.issueId));
    for (const id of ids) delete data.history[id];
    data.sprints = data.sprints.filter(s => s.projectId !== project.id);
    data.webhooks = data.webhooks.filter(h => h.projectId !== project.id);
    data.projMembers = data.projMembers.filter(m => m.projectId !== project.id);
    data.projects = data.projects.filter(p => p !== project);
    audit(project.workspaceId, user.id, 'project.deleted', { projectId: project.id });
    return [204];
  });
  const projMemberView = m => ({ userId: m.userId, username: userById(m.userId)?.username, displayName: userById(m.userId)?.displayName, role: m.role, user: publicUser(userById(m.userId)) });
  route('GET', '/api/projects/:id/members', ({ user, params }) => {
    const { project } = getProject(params.id, user);
    return [200, data.projMembers.filter(m => m.projectId === project.id).map(projMemberView)];
  });
  route('POST', '/api/projects/:id/members', ({ user, params, body }) => {
    const { project } = getProject(params.id, user, 'lead');
    const role = body.role ?? 'developer';
    if (!PROJECT_ROLES.includes(role)) throw bad('invalid role');
    const target = resolveUserRef(body.username ?? body.userId);
    if (!target) throw notFound('User not found');
    if (!wsMember(project.workspaceId, target.id)) throw bad('User is not a member of the workspace');
    let m = projMember(project.id, target.id);
    if (m) { m.role = role; audit(project.workspaceId, user.id, 'project.member_role_changed', { projectId: project.id, userId: target.id, role }); return [200, projMemberView(m)]; }
    m = { projectId: project.id, userId: target.id, role, addedAt: nowIso() };
    data.projMembers.push(m);
    audit(project.workspaceId, user.id, 'project.member_added', { projectId: project.id, userId: target.id, role });
    return [201, projMemberView(m)];
  });
  route('PATCH', '/api/projects/:id/members/:userId', ({ user, params, body }) => {
    const { project } = getProject(params.id, user, 'lead');
    const u = resolveUserRef(params.userId);
    const m = u && projMember(project.id, u.id);
    if (!m) throw notFound('Member not found');
    if (!PROJECT_ROLES.includes(body.role)) throw bad('invalid role');
    m.role = body.role;
    audit(project.workspaceId, user.id, 'project.member_role_changed', { projectId: project.id, userId: u.id, role: m.role });
    return [200, projMemberView(m)];
  });
  route('DELETE', '/api/projects/:id/members/:userId', ({ user, params }) => {
    const { project } = getProject(params.id, user, 'lead');
    const u = resolveUserRef(params.userId);
    const m = u && projMember(project.id, u.id);
    if (!m) throw notFound('Member not found');
    data.projMembers = data.projMembers.filter(x => x !== m);
    audit(project.workspaceId, user.id, 'project.member_removed', { projectId: project.id, userId: u.id });
    return [204];
  });

  route('GET', '/api/projects/:id/workflow', ({ user, params }) => [200, getProject(params.id, user).project.workflow]);
  route('PUT', '/api/projects/:id/workflow', ({ user, params, body }) => {
    const { project } = getProject(params.id, user, 'lead');
    const { statuses, transitions, remap = {} } = body;
    if (!Array.isArray(statuses) || statuses.length === 0) throw bad('statuses must be a non-empty array');
    const names = new Set();
    const newStatuses = statuses.map(s => {
      if (!s || !nonEmptyStr(s.name)) throw bad('status name is required');
      if (!CATEGORIES.includes(s.category)) throw bad(`invalid category for status ${s.name}`);
      const name = s.name.trim();
      if (names.has(name)) throw bad(`duplicate status ${name}`);
      names.add(name);
      return { name, category: s.category };
    });
    let newTransitions;
    if (transitions === undefined || transitions === null) newTransitions = allTransitions(newStatuses);
    else {
      if (!Array.isArray(transitions)) throw bad('transitions must be an array');
      const seen = new Set();
      newTransitions = [];
      for (const t of transitions) {
        let pair = t;
        if (t && !Array.isArray(t) && typeof t === 'object') pair = [t.from, t.to];
        if (!Array.isArray(pair) || pair.length !== 2 || !names.has(pair[0]) || !names.has(pair[1])) throw bad('each transition must be [from, to] with known statuses');
        const k = pair[0] + '\u0000' + pair[1];
        if (!seen.has(k)) { seen.add(k); newTransitions.push([pair[0], pair[1]]); }
      }
    }
    if (remap === null || typeof remap !== 'object' || Array.isArray(remap)) throw bad('remap must be an object');
    const issues = data.issues.filter(i => i.projectId === project.id);
    const plan = [];
    for (const i of issues) {
      if (names.has(i.status)) continue;
      const target = remap[i.status];
      if (target === undefined) throw bad(`Status "${i.status}" is in use; provide remap`, 'remap_required');
      if (!names.has(target)) throw bad(`remap target "${target}" is not a status`);
      plan.push([i, target]);
    }
    const old = project.workflow;
    project.workflow = { statuses: newStatuses, transitions: newTransitions };
    const at = nowIso();
    for (const [i, target] of plan) {
      addHistory(i, 'status', i.status, target, user.id, at);
      applyStatus(project, i, target, at);
      i.updatedAt = at;
    }
    for (const i of issues) {
      if (plan.some(([x]) => x === i)) continue;
      const cat = categoryOf(project, i.status);
      if (cat === 'completed' && !i.resolvedAt) i.resolvedAt = at;
      if (cat !== 'completed' && i.resolvedAt) i.resolvedAt = null;
    }
    audit(project.workspaceId, user.id, 'workflow.updated', { projectId: project.id, from: old.statuses.map(s => s.name), to: newStatuses.map(s => s.name), remap });
    return [200, projectView(project, projectRole(user, project))];
  });

  // --- issues ---
  route('POST', '/api/projects/:id/issues', ({ user, params, body }) => {
    const { project } = getProject(params.id, user, 'developer');
    const fields = validateIssueInput(project, body, null);
    const issue = createIssueRecord(project, fields, user);
    if (issue.assigneeId && issue.assigneeId !== user.id) notify([issue.assigneeId], 'assigned', issue, user.id);
    fireWebhooks(project, 'issue.created', { issue: issueView(issue), actorId: user.id });
    return [201, issueView(issue)];
  });
  route('GET', '/api/projects/:id/issues', ({ user, params, query }) => {
    const { project } = getProject(params.id, user);
    let list = data.issues.filter(i => i.projectId === project.id);
    if (query.get('status')) list = list.filter(i => i.status === query.get('status'));
    if (query.has('sprint')) { const s = query.get('sprint'); list = list.filter(i => (s === 'none' || s === 'backlog' || s === '') ? !i.sprintId : i.sprintId === s); }
    if (query.get('type')) list = list.filter(i => i.type === query.get('type'));
    return [200, list.map(issueView)];
  });
  route('GET', '/api/issues/:key', ({ user, params }) => [200, issueView(getIssue(params.key, user).issue)]);
  route('PATCH', '/api/issues/:key', ({ user, params, body }) => {
    const { issue, project } = getIssue(params.key, user, 'developer');
    const changes = validateIssueInput(project, body, issue);
    if (changes.status !== undefined && changes.status !== issue.status) {
      const ok = project.workflow.transitions.some(([f, t]) => f === issue.status && t === changes.status);
      if (!ok) throw conflict(`Transition from "${issue.status}" to "${changes.status}" is not allowed`, 'invalid_transition');
      if (categoryOf(project, changes.status) === 'completed' && categoryOf(project, issue.status) !== 'completed') {
        const blockers = unresolvedBlockers(issue);
        if (blockers.length) throw conflict(`Blocked by ${blockers.map(b => b.key).join(', ')}`, 'blocked');
      }
    }
    const at = nowIso();
    let changed = false, statusChanged = false, assigneeChanged = false;
    for (const [field, value] of Object.entries(changes)) {
      const prev = issue[field];
      const same = Array.isArray(value) ? JSON.stringify(prev) === JSON.stringify(value) : prev === value;
      if (same) continue;
      changed = true;
      addHistory(issue, field, Array.isArray(prev) ? [...prev] : prev, Array.isArray(value) ? [...value] : value, user.id, at);
      if (field === 'status') { applyStatus(project, issue, value, at); statusChanged = true; }
      else issue[field] = value;
      if (field === 'assigneeId') {
        assigneeChanged = true;
        if (value && !issue.watchers.includes(value)) issue.watchers.push(value);
      }
    }
    if (changed) {
      issue.updatedAt = at;
      if (statusChanged) notify(issue.watchers, 'status_changed', issue, user.id, { from: data.history[issue.id].findLast(h => h.field === 'status').from, to: issue.status });
      if (assigneeChanged) notify(issue.watchers, 'assigned', issue, user.id, { assigneeId: issue.assigneeId });
      fireWebhooks(project, 'issue.updated', { issue: issueView(issue), actorId: user.id, changes: Object.keys(changes) });
    }
    return [200, issueView(issue)];
  });
  route('DELETE', '/api/issues/:key', ({ user, params }) => {
    const { issue, project } = getIssue(params.key, user, 'developer');
    const doomed = new Set([issue.id]);
    let grew = true;
    while (grew) { grew = false; for (const i of data.issues) if (i.parentId && doomed.has(i.parentId) && !doomed.has(i.id)) { doomed.add(i.id); grew = true; } }
    const views = data.issues.filter(i => doomed.has(i.id)).map(issueView);
    data.issues = data.issues.filter(i => !doomed.has(i.id));
    for (const i of data.issues) if (i.epicId && doomed.has(i.epicId)) i.epicId = null;
    data.links = data.links.filter(l => !doomed.has(l.sourceId) && !doomed.has(l.targetId));
    data.comments = data.comments.filter(c => !doomed.has(c.issueId));
    for (const id of doomed) delete data.history[id];
    for (const v of views) fireWebhooks(project, 'issue.deleted', { issue: v, actorId: user.id });
    return [204];
  });
  route('GET', '/api/issues/:key/history', ({ user, params }) => [200, (data.history[getIssue(params.key, user).issue.id] || []).map(h => ({ ...h }))]);

  // links
  route('GET', '/api/issues/:key/links', ({ user, params }) => [200, issueLinks(getIssue(params.key, user).issue)]);
  route('POST', '/api/issues/:key/links', ({ user, params, body }) => {
    const { issue } = getIssue(params.key, user, 'developer');
    let type = body.type;
    if (!LINK_TYPES.includes(type) && type !== 'blocked_by') throw bad('type must be blocks, relates or duplicates');
    const target = findIssue(body.target ?? body.targetKey ?? body.issueKey);
    if (!target) throw (body.target === undefined ? bad('target is required') : notFound('Target issue not found'));
    if (!canSee(user, projectById(target.projectId))) throw forbidden('No access to target issue');
    if (target.id === issue.id) throw bad('Cannot link an issue to itself');
    let sourceId = issue.id, targetId = target.id;
    if (type === 'blocked_by') { type = 'blocks'; sourceId = target.id; targetId = issue.id; }
    const dup = data.links.find(l => l.type === type && ((l.sourceId === sourceId && l.targetId === targetId) || (type === 'relates' && l.sourceId === targetId && l.targetId === sourceId)));
    if (dup) throw conflict('Link already exists');
    const link = { id: newId(), type, sourceId, targetId, createdAt: nowIso(), createdBy: user.id };
    data.links.push(link);
    const src = findIssue(sourceId), tgt = findIssue(targetId);
    return [201, { id: link.id, type: body.type, source: src.key, target: body.type === 'blocked_by' ? src.key : tgt.key, key: target.key, issueKey: target.key, createdAt: link.createdAt }];
  });
  route('DELETE', '/api/issues/:key/links/:linkId', ({ user, params }) => {
    const { issue } = getIssue(params.key, user, 'developer');
    const l = data.links.find(x => x.id === params.linkId && (x.sourceId === issue.id || x.targetId === issue.id));
    if (!l) throw notFound('Link not found');
    data.links = data.links.filter(x => x !== l);
    return [204];
  });

  // watchers
  route('POST', '/api/issues/:key/watch', ({ user, params }) => {
    const { issue } = getIssue(params.key, user);
    if (!issue.watchers.includes(user.id)) issue.watchers.push(user.id);
    return [200, { watching: true, watchers: [...issue.watchers] }];
  });
  route('DELETE', '/api/issues/:key/watch', ({ user, params }) => {
    const { issue } = getIssue(params.key, user);
    issue.watchers = issue.watchers.filter(w => w !== user.id);
    return [204];
  });
  route('GET', '/api/issues/:key/watchers', ({ user, params }) => [200, getIssue(params.key, user).issue.watchers.map(id => publicUser(userById(id))).filter(Boolean)]);

  // comments
  const commentView = c => ({ ...c, issueKey: data.issues.find(i => i.id === c.issueId)?.key });
  route('GET', '/api/issues/:key/comments', ({ user, params }) => {
    const { issue } = getIssue(params.key, user);
    return [200, data.comments.filter(c => c.issueId === issue.id).map(commentView)];
  });
  route('POST', '/api/issues/:key/comments', ({ user, params, body }) => {
    const { issue, project } = getIssue(params.key, user);
    if (!nonEmptyStr(body.body)) throw bad('body is required');
    const at = nowIso();
    const c = { id: newId(), issueId: issue.id, authorId: user.id, body: body.body, createdAt: at, updatedAt: at, edited: false };
    data.comments.push(c);
    const mentioned = new Set();
    for (const m of body.body.matchAll(/(^|[^A-Za-z0-9_.-])@([A-Za-z0-9_.-]+)/g)) {
      const u = userByName(m[2]) || userByName(m[2].replace(/[.]+$/, ''));
      if (u && u.id !== user.id && canSee(u, project)) mentioned.add(u.id);
    }
    notify([...mentioned], 'mention', issue, user.id, { commentId: c.id });
    notify(issue.watchers.filter(w => !mentioned.has(w)), 'comment', issue, user.id, { commentId: c.id });
    fireWebhooks(project, 'comment.created', { issue: issueView(issue), comment: commentView(c), actorId: user.id });
    return [201, commentView(c)];
  });
  function getComment(id, user) {
    const c = data.comments.find(x => x.id === id);
    if (!c) throw notFound('Comment not found');
    const { issue, project, role } = getIssue(c.issueId, user);
    return { c, issue, project, role };
  }
  const patchComment = ({ user, params, body }) => {
    const { c } = getComment(params.commentId, user);
    if (c.authorId !== user.id) throw forbidden('Only the author can edit a comment');
    if (!nonEmptyStr(body.body)) throw bad('body is required');
    if (c.body !== body.body) { c.body = body.body; c.edited = true; c.updatedAt = nowIso(); }
    else c.edited = true;
    return [200, commentView(c)];
  };
  const deleteComment = ({ user, params }) => {
    const { c, role } = getComment(params.commentId, user);
    if (c.authorId !== user.id && role !== 'lead') throw forbidden('Only the author can delete a comment');
    data.comments = data.comments.filter(x => x !== c);
    return [204];
  };
  route('PATCH', '/api/comments/:commentId', patchComment);
  route('DELETE', '/api/comments/:commentId', deleteComment);
  route('PATCH', '/api/issues/:key/comments/:commentId', patchComment);
  route('DELETE', '/api/issues/:key/comments/:commentId', deleteComment);

  // notifications
  route('GET', '/api/notifications', ({ user, query }) => {
    let list = data.notifications.filter(n => n.userId === user.id);
    if (query.get('unread') === 'true' || query.get('unread') === '1') list = list.filter(n => !n.read);
    list = list.map((n, i) => [n, i]).sort((a, b) => (b[0].at.localeCompare(a[0].at)) || (b[1] - a[1])).map(([n]) => n);
    return [200, list.map(({ userId, ...n }) => n)];
  });
  route('POST', '/api/notifications/read', ({ user, body }) => {
    let updated = 0;
    if (body.all === true) {
      for (const n of data.notifications) if (n.userId === user.id && !n.read) { n.read = true; updated++; }
    } else if (Array.isArray(body.ids)) {
      const ids = new Set(body.ids);
      for (const n of data.notifications) if (n.userId === user.id && ids.has(n.id) && !n.read) { n.read = true; updated++; }
    } else throw bad('Provide ids or all: true');
    return [200, { updated }];
  });

  // --- sprints ---
  function getSprint(id, user, need = 'viewer') {
    const s = data.sprints.find(x => x.id === id);
    if (!s) throw notFound('Sprint not found');
    const { project } = getProject(s.projectId, user, need);
    return { sprint: s, project };
  }
  const validDateOrIso = v => typeof v === 'string' && !isNaN(Date.parse(v.length === 10 ? v + 'T00:00:00Z' : v));
  route('POST', '/api/projects/:id/sprints', ({ user, params, body }) => {
    const { project } = getProject(params.id, user, 'developer');
    if (!nonEmptyStr(body.name)) throw bad('name is required');
    for (const f of ['startDate', 'endDate']) if (body[f] !== undefined && body[f] !== null && !validDateOrIso(body[f])) throw bad(`${f} must be a date`);
    const startDate = body.startDate ? body.startDate.slice(0, 10) : null, endDate = body.endDate ? body.endDate.slice(0, 10) : null;
    if (startDate && endDate && endDate < startDate) throw bad('endDate must be after startDate');
    const s = { id: newId(), projectId: project.id, name: body.name.trim(), goal: typeof body.goal === 'string' ? body.goal : '', state: 'planned', startDate, endDate, startedAt: null, completedAt: null, createdAt: nowIso() };
    data.sprints.push(s);
    return [201, sprintView(s)];
  });
  route('GET', '/api/projects/:id/sprints', ({ user, params }) => {
    const { project } = getProject(params.id, user);
    return [200, data.sprints.filter(s => s.projectId === project.id).map(sprintView)];
  });
  route('GET', '/api/sprints/:id', ({ user, params }) => {
    const { sprint } = getSprint(params.id, user);
    return [200, { ...sprintView(sprint), issues: data.issues.filter(i => i.sprintId === sprint.id).map(i => i.key) }];
  });
  route('PATCH', '/api/sprints/:id', ({ user, params, body }) => {
    const { sprint } = getSprint(params.id, user, 'developer');
    if (body.name !== undefined) { if (!nonEmptyStr(body.name)) throw bad('name must be non-empty'); }
    for (const f of ['startDate', 'endDate']) if (body[f] !== undefined && body[f] !== null && !validDateOrIso(body[f])) throw bad(`${f} must be a date`);
    if (body.name !== undefined) sprint.name = body.name.trim();
    if (body.goal !== undefined) sprint.goal = String(body.goal);
    if (body.startDate !== undefined) sprint.startDate = body.startDate ? body.startDate.slice(0, 10) : null;
    if (body.endDate !== undefined) sprint.endDate = body.endDate ? body.endDate.slice(0, 10) : null;
    return [200, sprintView(sprint)];
  });
  route('DELETE', '/api/sprints/:id', ({ user, params }) => {
    const { sprint } = getSprint(params.id, user, 'developer');
    if (sprint.state !== 'planned') throw conflict('Only planned sprints can be deleted');
    const at = nowIso();
    for (const i of data.issues) if (i.sprintId === sprint.id) { addHistory(i, 'sprintId', sprint.id, null, user.id, at); i.sprintId = null; i.updatedAt = at; }
    data.sprints = data.sprints.filter(s => s !== sprint);
    return [204];
  });
  route('POST', '/api/sprints/:id/start', ({ user, params, body }) => {
    const { sprint, project } = getSprint(params.id, user, 'developer');
    if (sprint.state !== 'planned') throw conflict('Sprint is not in planned state', 'invalid_state');
    if (data.sprints.some(s => s.projectId === project.id && s.state === 'active')) throw conflict('Project already has an active sprint', 'active_sprint_exists');
    const n = now();
    if (body.startDate && validDateOrIso(body.startDate)) sprint.startDate = body.startDate.slice(0, 10);
    if (body.endDate && validDateOrIso(body.endDate)) sprint.endDate = body.endDate.slice(0, 10);
    sprint.state = 'active';
    sprint.startedAt = n.toISOString();
    if (!sprint.startDate) sprint.startDate = n.toISOString().slice(0, 10);
    const inSprint = data.issues.filter(i => i.sprintId === sprint.id);
    sprint.committedPoints = inSprint.reduce((s, i) => s + (Number(i.storyPoints) || 0), 0);
    sprint.committedIssues = inSprint.length;
    return [200, sprintView(sprint)];
  });
  route('POST', '/api/sprints/:id/complete', ({ user, params, body }) => {
    const { sprint, project } = getSprint(params.id, user, 'developer');
    if (sprint.state !== 'active') throw conflict('Sprint is not active', 'invalid_state');
    const dest = body.carryOverTo ?? 'backlog';
    let destId = null;
    if (dest !== 'backlog' && dest !== null) {
      const d = data.sprints.find(s => s.id === dest);
      if (!d || d.projectId !== project.id) throw bad('carryOverTo must be a sprint in this project or "backlog"');
      if (d.state === 'completed' || d.id === sprint.id) throw bad('carryOverTo sprint must not be completed');
      destId = d.id;
    }
    const at = nowIso();
    const inSprint = data.issues.filter(i => i.sprintId === sprint.id);
    const done = inSprint.filter(i => isCompleted(project, i));
    const unfinished = inSprint.filter(i => !isCompleted(project, i));
    for (const i of unfinished) { addHistory(i, 'sprintId', sprint.id, destId, user.id, at); i.sprintId = destId; i.updatedAt = at; }
    sprint.state = 'completed';
    sprint.completedAt = at;
    sprint.completion = {
      completedIssues: done.length, completedPoints: done.reduce((s, i) => s + (Number(i.storyPoints) || 0), 0),
      carriedOver: unfinished.length, carriedOverTo: destId ?? 'backlog', completedKeys: done.map(i => i.key), carriedOverKeys: unfinished.map(i => i.key),
    };
    return [200, { ...sprintView(sprint), carriedOver: unfinished.map(i => i.key) }];
  });
  route('GET', '/api/sprints/:id/report', ({ user, params }) => [200, sprintReport(getSprint(params.id, user).sprint)]);

  // --- stats ---
  route('GET', '/api/projects/:id/stats', ({ user, params }) => {
    const { project } = getProject(params.id, user);
    const issues = data.issues.filter(i => i.projectId === project.id);
    const byStatus = Object.fromEntries(project.workflow.statuses.map(s => [s.name, 0]));
    const byType = {}, byAssignee = {}, byPriority = {};
    for (const i of issues) {
      byStatus[i.status] = (byStatus[i.status] || 0) + 1;
      byType[i.type] = (byType[i.type] || 0) + 1;
      byPriority[i.priority] = (byPriority[i.priority] || 0) + 1;
      const a = i.assigneeId ? (userById(i.assigneeId)?.username || i.assigneeId) : 'unassigned';
      byAssignee[a] = (byAssignee[a] || 0) + 1;
    }
    const cycles = issues.filter(i => i.resolvedAt && i.startedAt).map(i => (Date.parse(i.resolvedAt) - Date.parse(i.startedAt)) / 3600000);
    const avg = cycles.length ? cycles.reduce((a, b) => a + b, 0) / cycles.length : null;
    return [200, { total: issues.length, byStatus, byType, byPriority, byAssignee, avgCycleTimeHours: avg, averageCycleTimeHours: avg, cycleTimeHours: avg, resolvedCount: cycles.length }];
  });

  // --- search ---
  route('GET', '/api/search', ({ user, query }) => {
    const terms = parseQuery(query.get('q'));
    const sort = query.get('sort') || 'updated';
    if (!['updated', 'created', 'priority'].includes(sort)) throw bad('sort must be updated, created or priority');
    let projects = data.projects.filter(p => canSee(user, p));
    const pref = query.get('project');
    if (pref) {
      const p = data.projects.find(x => x.id === pref) || data.projects.find(x => x.key === pref);
      if (!p) throw notFound('Project not found');
      if (!canSee(user, p)) throw forbidden('No access to this project');
      projects = [p];
    }
    const pmap = new Map(projects.map(p => [p.id, p]));
    const res = data.issues.filter(i => pmap.has(i.projectId) && terms.every(t => matchTerm(t, i, pmap.get(i.projectId), user) !== t.neg));
    const order = data.issues.map(i => i.id);
    const seq = new Map(order.map((id, n) => [id, n]));
    const byUpdated = (a, b) => b.updatedAt.localeCompare(a.updatedAt) || seq.get(b.id) - seq.get(a.id);
    const byCreated = (a, b) => b.createdAt.localeCompare(a.createdAt) || seq.get(b.id) - seq.get(a.id);
    res.sort(sort === 'created' ? byCreated : sort === 'priority' ? (a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || byUpdated(a, b) : byUpdated);
    return [200, res.map(issueView)];
  });

  // --- CSV ---
  route('GET', '/api/projects/:id/export.csv', ({ user, params }) => {
    const { project } = getProject(params.id, user);
    return [200, exportCsv(project), 'text/csv; charset=utf-8', { 'content-disposition': `attachment; filename="${project.key}.csv"` }];
  });
  route('POST', '/api/projects/:id/import.csv', ({ user, params, rawBody }) => {
    const { project } = getProject(params.id, user, 'developer');
    const { created, errors, createdIssues } = importCsv(project, rawBody, user);
    for (const i of createdIssues) fireWebhooks(project, 'issue.created', { issue: issueView(i), actorId: user.id });
    return [200, { created, errors, keys: createdIssues.map(i => i.key) }];
  }, { raw: true });

  // --- webhooks ---
  const hookView = h => ({ id: h.id, projectId: h.projectId, url: h.url, events: [...h.events], createdAt: h.createdAt });
  route('POST', '/api/projects/:id/webhooks', ({ user, params, body }) => {
    const { project } = getProject(params.id, user, 'lead');
    let u;
    try { u = new URL(body.url); } catch { throw bad('url must be a valid URL'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw bad('url must be http(s)');
    if (!Array.isArray(body.events) || !body.events.length || !body.events.every(e => WEBHOOK_EVENTS.includes(e))) throw bad('events must be a non-empty list of known events');
    if (body.secret !== undefined && typeof body.secret !== 'string') throw bad('secret must be a string');
    const h = { id: newId(), projectId: project.id, url: body.url, events: [...new Set(body.events)], secret: body.secret || '', createdAt: nowIso(), createdBy: user.id };
    data.webhooks.push(h);
    audit(project.workspaceId, user.id, 'webhook.created', { projectId: project.id, webhookId: h.id, url: h.url });
    return [201, hookView(h)];
  });
  route('GET', '/api/projects/:id/webhooks', ({ user, params }) => {
    const { project } = getProject(params.id, user, 'lead');
    return [200, data.webhooks.filter(h => h.projectId === project.id).map(hookView)];
  });
  function getHook(id, user) {
    const h = data.webhooks.find(x => x.id === id);
    if (!h) throw notFound('Webhook not found');
    const { project } = getProject(h.projectId, user, 'lead');
    return { h, project };
  }
  route('GET', '/api/webhooks/:id', ({ user, params }) => [200, hookView(getHook(params.id, user).h)]);
  route('DELETE', '/api/webhooks/:id', ({ user, params }) => {
    const { h, project } = getHook(params.id, user);
    data.webhooks = data.webhooks.filter(x => x !== h);
    audit(project.workspaceId, user.id, 'webhook.deleted', { projectId: project.id, webhookId: h.id, url: h.url });
    return [204];
  });
  route('GET', '/api/webhooks/:id/deliveries', ({ user, params }) => {
    const { h } = getHook(params.id, user);
    return [200, data.deliveries.filter(d => d.webhookId === h.id).map(d => ({ ...d }))];
  });

  // ---------- static ----------
  const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
  function serveStatic(res, rel) {
    const file = path.normalize(path.join(STATIC_DIR, rel));
    if (!file.startsWith(STATIC_DIR + path.sep)) return false;
    let content;
    try { content = fs.readFileSync(file); } catch { return false; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'content-length': content.length });
    res.end(content);
    return true;
  }

  // ---------- request handling ----------
  function send(res, status, body, type, headers = {}) {
    if (status === 204 || body === undefined) { res.writeHead(status, headers); return res.end(); }
    if (type) { const buf = Buffer.from(body); res.writeHead(status, { 'content-type': type, 'content-length': buf.length, ...headers }); return res.end(buf); }
    const buf = Buffer.from(JSON.stringify(body));
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': buf.length, ...headers });
    res.end(buf);
  }
  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = []; let size = 0;
      req.on('data', c => { size += c.length; if (size > 10 * 1024 * 1024) { reject(new HttpError(413, 'payload_too_large', 'Body too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const pathname = decodeURIComponent(url.pathname);
      if (req.method === 'GET' && !pathname.startsWith('/api/')) {
        if (pathname === '/' || pathname === '/index.html') { if (serveStatic(res, 'index.html')) return; }
        else if (pathname.startsWith('/static/') && serveStatic(res, pathname.slice('/static/'.length))) return;
        else if (!pathname.startsWith('/static/') && !path.extname(pathname) && serveStatic(res, 'index.html')) return;
        throw notFound('Not found');
      }
      let match = null, methodMismatch = false;
      for (const r of routes) {
        const m = r.re.exec(pathname);
        if (!m) continue;
        if (r.method !== req.method) { methodMismatch = true; continue; }
        match = { r, params: Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]])) };
        break;
      }
      if (!match) throw methodMismatch ? new HttpError(405, 'method_not_allowed', 'Method not allowed') : notFound('Route not found');
      const raw = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) ? await readBody(req) : '';
      const user = authenticate(req);
      if (match.r.auth && !user) throw new HttpError(401, 'unauthorized', 'Authentication required');
      let body = {};
      const ctype = (req.headers['content-type'] || '').toLowerCase();
      if (raw.trim() && !pathname.endsWith('/import.csv')) {
        try { body = JSON.parse(raw); } catch { throw bad('Invalid JSON body', 'invalid_json'); }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('JSON body must be an object');
      }
      let rawBody = raw;
      if (pathname.endsWith('/import.csv') && ctype.includes('application/json')) {
        try { const j = JSON.parse(raw); if (typeof j?.csv === 'string') rawBody = j.csv; } catch {}
      }
      const out = await match.r.handler({ req, user, params: match.params, body, rawBody, query: url.searchParams });
      if (req.method !== 'GET') save();
      const [status, payload, type, headers] = out;
      send(res, status, payload, type, headers);
    } catch (e) {
      if (e instanceof HttpError) {
        if (e.status === 401 || e.status === 429) { try { save(); } catch {} }
        return send(res, e.status, { error: e.code, message: e.message });
      }
      console.error(e);
      send(res, 500, { error: 'internal_error', message: 'Internal server error' });
    }
  });
  return server;
}
