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
const PATCH_FIELDS = ['title', 'due', 'priority', 'tags'];

function todayString() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function validateTitle(title) {
  if (typeof title !== 'string') throw new TodoError('title must be a string');
  const trimmed = title.trim();
  if (trimmed === '') throw new TodoError('title must not be empty');
  return trimmed;
}

function validateDue(due) {
  if (due === undefined || due === null) return null;
  if (typeof due !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    throw new TodoError(`invalid due date: ${String(due)} (expected YYYY-MM-DD)`);
  }
  const [y, m, d] = due.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new TodoError(`invalid due date: ${due} is not a real date`);
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
    if (typeof t !== 'string') throw new TodoError('tags must be an array of strings');
    const norm = t.trim().toLowerCase();
    if (norm === '') throw new TodoError('tags must not be empty');
    if (!out.includes(norm)) out.push(norm);
  }
  return out;
}

function validateId(id) {
  if (!Number.isInteger(id) || id <= 0) throw new TodoError(`invalid id: ${String(id)}`);
  return id;
}

function copy(item) {
  return { ...item, tags: [...item.tags] };
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
      throw new TodoError(`could not read store file ${this.file}: ${err.message}`);
    }
    let items;
    let nextId = 1;
    if (Array.isArray(raw)) {
      items = raw;
    } else if (raw && typeof raw === 'object' && Array.isArray(raw.items)) {
      items = raw.items;
      if (Number.isInteger(raw.nextId) && raw.nextId > 0) nextId = raw.nextId;
    } else {
      throw new TodoError(`invalid store file ${this.file}`);
    }
    this.items = items.map((i) => ({ ...i, tags: [...(i.tags || [])] }));
    const maxId = this.items.reduce((m, i) => Math.max(m, i.id), 0);
    this.nextId = Math.max(nextId, maxId + 1);
  }

  _save() {
    if (!this.file) return;
    const dir = path.dirname(path.resolve(this.file));
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    const data = JSON.stringify({ nextId: this.nextId, items: this.items }, null, 2) + '\n';
    fs.writeFileSync(tmp, data);
    fs.renameSync(tmp, this.file);
  }

  _find(id) {
    validateId(id);
    const item = this.items.find((i) => i.id === id);
    if (!item) throw new TodoError(`no item with id #${id}`);
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
    this._save();
    return copy(item);
  }

  get(id) {
    return copy(this._find(id));
  }

  update(id, patch) {
    const item = this._find(id);
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new TodoError('patch must be an object');
    }
    for (const key of Object.keys(patch)) {
      if (!PATCH_FIELDS.includes(key)) throw new TodoError(`unknown field: ${key}`);
    }
    const next = { ...item, tags: [...item.tags] };
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
    this.items = this.items.filter((i) => i !== item);
    this._save();
    return copy(item);
  }

  clearCompleted() {
    const before = this.items.length;
    this.items = this.items.filter((i) => !i.done);
    const removed = before - this.items.length;
    if (removed > 0) this._save();
    return removed;
  }

  list({ status = 'all', tag, priority, search, sort = 'created' } = {}) {
    if (!STATUSES.includes(status)) throw new TodoError(`invalid status: ${status}`);
    if (!SORTS.includes(sort)) throw new TodoError(`invalid sort: ${sort}`);
    if (priority !== undefined && !PRIORITIES.includes(priority)) {
      throw new TodoError(`invalid priority: ${priority}`);
    }
    let out = this.items.filter((i) => {
      if (status === 'open' && i.done) return false;
      if (status === 'done' && !i.done) return false;
      if (tag !== undefined && !i.tags.includes(String(tag).toLowerCase())) return false;
      if (priority !== undefined && i.priority !== priority) return false;
      if (search !== undefined && !i.title.toLowerCase().includes(String(search).toLowerCase())) {
        return false;
      }
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
      out.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || byId(a, b));
    }
    return out.map(copy);
  }

  stats(today = todayString()) {
    let open = 0;
    let done = 0;
    let overdue = 0;
    for (const i of this.items) {
      if (i.done) {
        done += 1;
      } else {
        open += 1;
        if (i.due !== null && i.due < today) overdue += 1;
      }
    }
    return { total: this.items.length, open, done, overdue };
  }
}
