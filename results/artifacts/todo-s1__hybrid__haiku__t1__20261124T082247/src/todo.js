import fs from 'node:fs';

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

function localToday() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function validateTitle(title) {
  if (typeof title !== 'string') throw new TodoError('title must be a string');
  const t = title.trim();
  if (t.length === 0) throw new TodoError('title must not be empty');
  return t;
}

function validateDue(due) {
  if (due === undefined || due === null) return null;
  if (typeof due !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    throw new TodoError(`invalid due date: ${due}`);
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
    throw new TodoError(`invalid priority: ${priority}`);
  }
  return priority;
}

function validateTags(tags) {
  if (!Array.isArray(tags)) throw new TodoError('tags must be an array');
  const out = [];
  for (const tag of tags) {
    if (typeof tag !== 'string') throw new TodoError('tags must be strings');
    const t = tag.trim().toLowerCase();
    if (t.length === 0) throw new TodoError('tags must not be empty');
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

function copy(item) {
  return { ...item, tags: [...item.tags] };
}

export class TodoStore {
  constructor({ file } = {}) {
    this.file = file;
    this.items = [];
    this.nextId = 1;
    if (file && fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      const data = raw.trim() === '' ? {} : JSON.parse(raw);
      const items = Array.isArray(data) ? data : (data.items || []);
      this.items = items.map(copy);
      let maxId = 0;
      for (const it of this.items) if (it.id > maxId) maxId = it.id;
      const stored = Array.isArray(data) ? 0 : Number(data.nextId) || 0;
      this.nextId = Math.max(stored, maxId + 1, 1);
    }
  }

  _persist() {
    if (!this.file) return;
    const data = JSON.stringify({ nextId: this.nextId, items: this.items }, null, 2) + '\n';
    fs.writeFileSync(this.file, data, 'utf8');
  }

  _find(id) {
    const item = this.items.find((it) => it.id === id);
    if (!item) throw new TodoError(`unknown id: ${id}`);
    return item;
  }

  _resolveId(id) {
    const n = typeof id === 'string' && /^\d+$/.test(id.trim()) ? Number(id.trim()) : id;
    if (!Number.isInteger(n) || n <= 0) throw new TodoError(`invalid id: ${id}`);
    return n;
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
    return copy(this._find(this._resolveId(id)));
  }

  update(id, patch) {
    const item = this._find(this._resolveId(id));
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new TodoError('patch must be an object');
    }
    const changes = {};
    for (const key of Object.keys(patch)) {
      if (!PATCHABLE.includes(key)) throw new TodoError(`unknown field: ${key}`);
      if (key === 'title') changes.title = validateTitle(patch.title);
      if (key === 'due') changes.due = validateDue(patch.due);
      if (key === 'priority') changes.priority = validatePriority(patch.priority);
      if (key === 'tags') changes.tags = validateTags(patch.tags);
    }
    Object.assign(item, changes);
    this._persist();
    return copy(item);
  }

  complete(id) {
    const item = this._find(this._resolveId(id));
    item.done = true;
    this._persist();
    return copy(item);
  }

  reopen(id) {
    const item = this._find(this._resolveId(id));
    item.done = false;
    this._persist();
    return copy(item);
  }

  remove(id) {
    const rid = this._resolveId(id);
    const idx = this.items.findIndex((it) => it.id === rid);
    if (idx === -1) throw new TodoError(`unknown id: ${rid}`);
    const [removed] = this.items.splice(idx, 1);
    this._persist();
    return copy(removed);
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
    if (priority !== undefined && !PRIORITIES.includes(priority)) {
      throw new TodoError(`invalid priority: ${priority}`);
    }
    let res = this.items.filter((it) => {
      if (status === 'open' && it.done) return false;
      if (status === 'done' && !it.done) return false;
      if (tag !== undefined && !it.tags.includes(String(tag).trim().toLowerCase())) return false;
      if (priority !== undefined && it.priority !== priority) return false;
      if (search !== undefined && !it.title.toLowerCase().includes(String(search).toLowerCase())) return false;
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
    return res.map(copy);
  }

  stats(today = localToday()) {
    let done = 0;
    let overdue = 0;
    for (const it of this.items) {
      if (it.done) done += 1;
      else if (it.due !== null && it.due < today) overdue += 1;
    }
    const total = this.items.length;
    return { total, open: total - done, done, overdue };
  }
}
