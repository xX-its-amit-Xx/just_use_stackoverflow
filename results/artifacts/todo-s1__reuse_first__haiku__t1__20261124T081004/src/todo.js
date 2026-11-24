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
    throw new TodoError(`invalid due date: ${due}`);
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
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags)) throw new TodoError('tags must be an array of strings');
  const out = [];
  for (const t of tags) {
    if (typeof t !== 'string' || t.trim() === '') {
      throw new TodoError('each tag must be a non-empty string');
    }
    const tag = t.trim().toLowerCase();
    if (!out.includes(tag)) out.push(tag);
  }
  return out;
}

function copy(item) {
  return { ...item, tags: [...item.tags] };
}

function todayString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export class TodoStore {
  constructor({ file } = {}) {
    this.file = file;
    this.items = [];
    this.nextId = 1;
    if (file && fs.existsSync(file)) this._load();
  }

  _load() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      throw new TodoError(`could not read todo file ${this.file}: ${err.message}`);
    }
    // Accept either {nextId, items} (current format) or a bare array of items.
    const items = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.items) ? raw.items : null);
    if (!items) throw new TodoError(`invalid todo file format: ${this.file}`);
    this.items = items.map((it) => ({ ...it, tags: [...(it.tags || [])] }));
    let maxId = 0;
    for (const it of this.items) if (it.id > maxId) maxId = it.id;
    const stored = !Array.isArray(raw) && Number.isInteger(raw.nextId) ? raw.nextId : 1;
    this.nextId = Math.max(stored, maxId + 1);
  }

  _persist() {
    if (!this.file) return;
    const dir = path.dirname(this.file);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data = JSON.stringify({ nextId: this.nextId, items: this.items }, null, 2) + '\n';
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, this.file);
  }

  _find(id) {
    if (!Number.isInteger(id) || id <= 0) throw new TodoError(`invalid id: ${String(id)}`);
    const item = this.items.find((it) => it.id === id);
    if (!item) throw new TodoError(`unknown id: #${id}`);
    return item;
  }

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
    this._persist();
    return copy(item);
  }

  get(id) {
    return copy(this._find(id));
  }

  update(id, patch = {}) {
    const item = this._find(id);
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new TodoError('patch must be an object');
    }
    for (const key of Object.keys(patch)) {
      if (!PATCHABLE.includes(key)) throw new TodoError(`unknown field: ${key}`);
    }
    const next = { ...item, tags: [...item.tags] };
    if ('title' in patch) next.title = validateTitle(patch.title);
    if ('due' in patch) next.due = validateDue(patch.due);
    if ('priority' in patch) next.priority = validatePriority(patch.priority);
    if ('tags' in patch) next.tags = validateTags(patch.tags);
    Object.assign(item, next);
    this._persist();
    return copy(item);
  }

  complete(id) {
    const item = this._find(id);
    item.done = true;
    this._persist();
    return copy(item);
  }

  reopen(id) {
    const item = this._find(id);
    item.done = false;
    this._persist();
    return copy(item);
  }

  remove(id) {
    const item = this._find(id);
    this.items = this.items.filter((it) => it !== item);
    this._persist();
    return copy(item);
  }

  clearCompleted() {
    const before = this.items.length;
    this.items = this.items.filter((it) => !it.done);
    const removed = before - this.items.length;
    if (removed > 0) this._persist();
    return removed;
  }

  list({ status = 'all', tag, priority, search, sort = 'created' } = {}) {
    if (!STATUSES.includes(status)) throw new TodoError(`invalid status: ${status}`);
    if (!SORTS.includes(sort)) throw new TodoError(`invalid sort: ${sort}`);
    if (priority !== undefined) validatePriority(priority);

    let out = this.items.filter((it) => {
      if (status === 'open' && it.done) return false;
      if (status === 'done' && !it.done) return false;
      if (tag !== undefined && !it.tags.includes(String(tag).toLowerCase())) return false;
      if (priority !== undefined && it.priority !== priority) return false;
      if (search !== undefined && !it.title.toLowerCase().includes(String(search).toLowerCase())) return false;
      return true;
    });

    if (sort === 'created') {
      out.sort((a, b) => a.id - b.id);
    } else if (sort === 'due') {
      out.sort((a, b) => {
        if (a.due === b.due) return a.id - b.id;
        if (a.due === null) return 1;
        if (b.due === null) return -1;
        return a.due < b.due ? -1 : 1;
      });
    } else {
      out.sort((a, b) => (PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]) || (a.id - b.id));
    }
    return out.map(copy);
  }

  stats(today = todayString()) {
    let open = 0;
    let done = 0;
    let overdue = 0;
    for (const it of this.items) {
      if (it.done) {
        done += 1;
      } else {
        open += 1;
        if (it.due && it.due < today) overdue += 1;
      }
    }
    return { total: this.items.length, open, done, overdue };
  }
}
