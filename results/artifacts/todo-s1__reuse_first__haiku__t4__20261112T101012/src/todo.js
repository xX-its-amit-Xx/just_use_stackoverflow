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
    throw new TodoError('Title must be a non-empty string');
  }
  return title.trim();
}

function validateDue(due) {
  if (due === undefined || due === null) return null;
  if (typeof due !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    throw new TodoError(`Invalid due date: ${String(due)} (expected YYYY-MM-DD)`);
  }
  const [y, m, d] = due.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new TodoError(`Invalid due date: ${due} (not a real date)`);
  }
  return due;
}

function validatePriority(priority) {
  if (!PRIORITIES.includes(priority)) {
    throw new TodoError(`Invalid priority: ${String(priority)} (expected low, normal or high)`);
  }
  return priority;
}

function validateTags(tags) {
  if (!Array.isArray(tags)) throw new TodoError('Tags must be an array of strings');
  const out = [];
  for (const t of tags) {
    if (typeof t !== 'string' || t.trim() === '') {
      throw new TodoError('Each tag must be a non-empty string');
    }
    const norm = t.trim().toLowerCase();
    if (!out.includes(norm)) out.push(norm);
  }
  return out;
}

function todayLocal() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function copyItem(item) {
  return { ...item, tags: [...item.tags] };
}

export class TodoStore {
  constructor({ file } = {}) {
    this.file = file;
    this.items = [];
    this.nextId = 1;
    if (file !== undefined && fs.existsSync(file)) {
      this._load();
    }
  }

  _load() {
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      throw new TodoError(`Could not read store file ${this.file}: ${err.message}`);
    }
    let items;
    let nextId = 1;
    if (Array.isArray(raw)) {
      items = raw;
    } else if (raw && typeof raw === 'object' && Array.isArray(raw.items)) {
      items = raw.items;
      if (Number.isInteger(raw.nextId) && raw.nextId > 0) nextId = raw.nextId;
    } else {
      throw new TodoError(`Invalid store file format: ${this.file}`);
    }
    this.items = items.map((it) => copyItem(it));
    const maxId = this.items.reduce((m, it) => Math.max(m, it.id), 0);
    this.nextId = Math.max(nextId, maxId + 1);
  }

  _save() {
    if (this.file === undefined) return;
    const dir = path.dirname(path.resolve(this.file));
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    const data = JSON.stringify({ nextId: this.nextId, items: this.items }, null, 2) + '\n';
    fs.writeFileSync(tmp, data, 'utf8');
    fs.renameSync(tmp, this.file);
  }

  _find(id) {
    if (!Number.isInteger(id) || id <= 0) {
      throw new TodoError(`Unknown id: ${String(id)}`);
    }
    const item = this.items.find((it) => it.id === id);
    if (!item) throw new TodoError(`Unknown id: ${id}`);
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
    return copyItem(item);
  }

  get(id) {
    return copyItem(this._find(id));
  }

  update(id, patch = {}) {
    const item = this._find(id);
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new TodoError('Patch must be an object');
    }
    for (const key of Object.keys(patch)) {
      if (!PATCHABLE.includes(key)) throw new TodoError(`Unknown field: ${key}`);
    }
    const next = {};
    if ('title' in patch) next.title = validateTitle(patch.title);
    if ('due' in patch) next.due = validateDue(patch.due);
    if ('priority' in patch) next.priority = validatePriority(patch.priority);
    if ('tags' in patch) next.tags = validateTags(patch.tags);
    Object.assign(item, next);
    this._save();
    return copyItem(item);
  }

  complete(id) {
    const item = this._find(id);
    item.done = true;
    this._save();
    return copyItem(item);
  }

  reopen(id) {
    const item = this._find(id);
    item.done = false;
    this._save();
    return copyItem(item);
  }

  remove(id) {
    const item = this._find(id);
    this.items = this.items.filter((it) => it !== item);
    this._save();
    return copyItem(item);
  }

  clearCompleted() {
    const before = this.items.length;
    this.items = this.items.filter((it) => !it.done);
    const removed = before - this.items.length;
    this._save();
    return removed;
  }

  list({ status = 'all', tag, priority, search, sort = 'created' } = {}) {
    if (!STATUSES.includes(status)) throw new TodoError(`Invalid status: ${status}`);
    if (!SORTS.includes(sort)) throw new TodoError(`Invalid sort: ${sort}`);
    if (priority !== undefined) validatePriority(priority);

    let res = this.items.filter((it) => {
      if (status === 'open' && it.done) return false;
      if (status === 'done' && !it.done) return false;
      if (tag !== undefined && !it.tags.includes(String(tag).toLowerCase())) return false;
      if (priority !== undefined && it.priority !== priority) return false;
      if (search !== undefined && !it.title.toLowerCase().includes(String(search).toLowerCase())) {
        return false;
      }
      return true;
    });

    if (sort === 'created') {
      res.sort((a, b) => a.id - b.id);
    } else if (sort === 'due') {
      res.sort((a, b) => {
        if (a.due === b.due) return a.id - b.id;
        if (a.due === null) return 1;
        if (b.due === null) return -1;
        return a.due < b.due ? -1 : 1;
      });
    } else {
      res.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.id - b.id);
    }
    return res.map(copyItem);
  }

  stats(today = todayLocal()) {
    let open = 0;
    let done = 0;
    let overdue = 0;
    for (const it of this.items) {
      if (it.done) {
        done += 1;
      } else {
        open += 1;
        if (it.due !== null && it.due < today) overdue += 1;
      }
    }
    return { total: this.items.length, open, done, overdue };
  }
}
