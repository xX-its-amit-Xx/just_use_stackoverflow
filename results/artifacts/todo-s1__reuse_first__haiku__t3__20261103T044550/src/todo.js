import fs from 'node:fs';
import path from 'node:path';

export class TodoError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TodoError';
  }
}

const PRIORITIES = ['low', 'normal', 'high'];
const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };
const STATUSES = ['all', 'open', 'done'];
const SORTS = ['created', 'due', 'priority'];
const PATCHABLE = ['title', 'due', 'priority', 'tags'];

function validateTitle(title) {
  if (typeof title !== 'string' || title.trim() === '') {
    throw new TodoError('title must be a non-empty string');
  }
  return title.trim();
}

function validateDue(due) {
  if (due === undefined || due === null) return null;
  if (typeof due !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    throw new TodoError(`invalid due date: ${String(due)} (expected YYYY-MM-DD)`);
  }
  const [y, m, d] = due.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new TodoError(`invalid due date: ${due} (not a real date)`);
  }
  return due;
}

function validatePriority(priority) {
  if (!PRIORITIES.includes(priority)) {
    throw new TodoError(`invalid priority: ${String(priority)} (expected low, normal or high)`);
  }
  return priority;
}

function validateTags(tags) {
  if (!Array.isArray(tags)) throw new TodoError('tags must be an array of strings');
  const out = [];
  for (const t of tags) {
    if (typeof t !== 'string' || t.trim() === '') {
      throw new TodoError('each tag must be a non-empty string');
    }
    const norm = t.trim().toLowerCase();
    if (!out.includes(norm)) out.push(norm);
  }
  return out;
}

function validateId(id) {
  if (typeof id === 'string' && /^#?\d+$/.test(id.trim())) id = Number(id.trim().replace(/^#/, ''));
  if (!Number.isInteger(id) || id <= 0) throw new TodoError(`invalid id: ${String(id)}`);
  return id;
}

function today() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function copy(item) {
  return { ...item, tags: [...item.tags] };
}

export class TodoStore {
  constructor({ file } = {}) {
    this.file = file;
    this.items = [];
    this.nextId = 1;
    if (file !== undefined && fs.existsSync(file)) this._load();
  }

  // --- persistence -------------------------------------------------------
  // Adapted from the JSON load/save pattern in rajveeerr/CLI-Todo (MIT).
  _load() {
    const raw = fs.readFileSync(this.file, 'utf-8');
    if (raw.trim() === '') return;
    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      throw new TodoError(`could not parse todo file ${this.file}: ${err.message}`);
    }
    const items = Array.isArray(data) ? data : (data && Array.isArray(data.items) ? data.items : null);
    if (!items) throw new TodoError(`invalid todo file format: ${this.file}`);
    this.items = items.map((it) => ({ ...it, tags: Array.isArray(it.tags) ? [...it.tags] : [] }));
    const maxId = this.items.reduce((m, it) => Math.max(m, it.id), 0);
    const stored = data && !Array.isArray(data) && Number.isInteger(data.nextId) ? data.nextId : 1;
    this.nextId = Math.max(stored, maxId + 1, 1);
  }

  _save() {
    if (this.file === undefined) return;
    const dir = path.dirname(this.file);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    const body = JSON.stringify({ nextId: this.nextId, items: this.items }, null, 2) + '\n';
    fs.writeFileSync(tmp, body, 'utf-8');
    fs.renameSync(tmp, this.file);
  }

  _find(id) {
    const vid = validateId(id);
    const item = this.items.find((it) => it.id === vid);
    if (!item) throw new TodoError(`no todo with id #${vid}`);
    return item;
  }

  // --- mutations ---------------------------------------------------------
  add(title, { due, priority = 'normal', tags = [] } = {}) {
    const item = {
      id: this.nextId,
      title: validateTitle(title),
      done: false,
      priority: validatePriority(priority),
      due: validateDue(due),
      tags: validateTags(tags),
      createdAt: new Date().toISOString(),
    };
    this.nextId += 1;
    this.items.push(item);
    this._save();
    return copy(item);
  }

  get(id) {
    return copy(this._find(id));
  }

  update(id, patch) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new TodoError('patch must be an object');
    }
    for (const key of Object.keys(patch)) {
      if (!PATCHABLE.includes(key)) throw new TodoError(`unknown field: ${key}`);
    }
    const item = this._find(id);
    const next = { ...item };
    if ('title' in patch) next.title = validateTitle(patch.title);
    if ('due' in patch) next.due = validateDue(patch.due);
    if ('priority' in patch) next.priority = validatePriority(patch.priority);
    if ('tags' in patch) next.tags = validateTags(patch.tags);
    Object.assign(item, next);
    this._save();
    return copy(item);
  }

  complete(id) {
    const item = this._find(id);
    item.done = true;
    this._save();
    return copy(item);
  }

  reopen(id) {
    const item = this._find(id);
    item.done = false;
    this._save();
    return copy(item);
  }

  remove(id) {
    const item = this._find(id);
    this.items = this.items.filter((it) => it !== item);
    this._save();
    return copy(item);
  }

  clearCompleted() {
    const before = this.items.length;
    this.items = this.items.filter((it) => !it.done);
    const removed = before - this.items.length;
    if (removed > 0) this._save();
    return removed;
  }

  // --- queries -----------------------------------------------------------
  list({ status = 'all', tag, priority, search, sort = 'created' } = {}) {
    if (!STATUSES.includes(status)) throw new TodoError(`invalid status: ${status}`);
    if (!SORTS.includes(sort)) throw new TodoError(`invalid sort: ${sort}`);
    if (priority !== undefined) validatePriority(priority);
    const wantTag = tag === undefined ? undefined : String(tag).trim().toLowerCase();
    const needle = search === undefined ? undefined : String(search).toLowerCase();

    let out = this.items.filter((it) => {
      if (status === 'open' && it.done) return false;
      if (status === 'done' && !it.done) return false;
      if (wantTag !== undefined && !it.tags.includes(wantTag)) return false;
      if (priority !== undefined && it.priority !== priority) return false;
      if (needle !== undefined && !it.title.toLowerCase().includes(needle)) return false;
      return true;
    });

    const byId = (a, b) => a.id - b.id;
    if (sort === 'created') {
      out.sort(byId);
    } else if (sort === 'due') {
      out.sort((a, b) => {
        if (a.due === b.due) return byId(a, b);
        if (a.due === null) return 1;
        if (b.due === null) return -1;
        return a.due < b.due ? -1 : 1;
      });
    } else {
      out.sort((a, b) => (PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]) || byId(a, b));
    }
    return out.map(copy);
  }

  stats(now = today()) {
    let total = 0;
    let open = 0;
    let done = 0;
    let overdue = 0;
    for (const it of this.items) {
      total += 1;
      if (it.done) {
        done += 1;
      } else {
        open += 1;
        if (it.due !== null && it.due < now) overdue += 1;
      }
    }
    return { total, open, done, overdue };
  }
}
