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
  if (due === null || due === undefined) return null;
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
  if (!Array.isArray(tags)) throw new TodoError('tags must be an array of strings');
  const out = [];
  for (const tag of tags) {
    if (typeof tag !== 'string') throw new TodoError('tags must be an array of strings');
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
    if (file && fs.existsSync(file)) this._load();
  }

  _load() {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      throw new TodoError(`could not read store file ${this.file}: ${err.message}`);
    }
    const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : null;
    if (!items) throw new TodoError(`invalid store file ${this.file}`);
    this.items = items.map((it) => ({ ...it, tags: [...(it.tags ?? [])] }));
    let maxId = 0;
    for (const it of this.items) {
      if (Number.isInteger(it.id) && it.id > maxId) maxId = it.id;
    }
    const stored = data && !Array.isArray(data) && Number.isInteger(data.nextId) ? data.nextId : 0;
    this.nextId = Math.max(stored, maxId + 1, 1);
  }

  _save() {
    if (!this.file) return;
    const dir = path.dirname(this.file);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify({ nextId: this.nextId, items: this.items }, null, 2) + '\n';
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, this.file);
  }

  _find(id) {
    const item = this.items.find((it) => it.id === id);
    if (!item) throw new TodoError(`unknown id: #${id}`);
    return item;
  }

  add(title, { due, priority = 'normal', tags = [] } = {}) {
    const t = validateTitle(title);
    const d = validateDue(due);
    const p = validatePriority(priority);
    const tg = validateTags(tags);
    const item = {
      id: this.nextId++,
      title: t,
      done: false,
      priority: p,
      due: d,
      tags: tg,
      createdAt: new Date().toISOString(),
    };
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
    if ('title' in patch) item.title = validateTitle(patch.title);
    if ('due' in patch) item.due = validateDue(patch.due);
    if ('priority' in patch) item.priority = validatePriority(patch.priority);
    if ('tags' in patch) item.tags = validateTags(patch.tags);
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
    const idx = this.items.findIndex((it) => it.id === id);
    if (idx === -1) throw new TodoError(`unknown id: #${id}`);
    const [removed] = this.items.splice(idx, 1);
    this._save();
    return copy(removed);
  }

  clearCompleted() {
    const before = this.items.length;
    this.items = this.items.filter((it) => !it.done);
    const removed = before - this.items.length;
    if (removed > 0) this._save();
    return removed;
  }

  list({ status = 'all', tag, priority, search, sort = 'created' } = {}) {
    if (!STATUSES.includes(status)) throw new TodoError(`invalid status: ${String(status)}`);
    if (!SORTS.includes(sort)) throw new TodoError(`invalid sort: ${String(sort)}`);
    if (priority !== undefined) validatePriority(priority);

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
    let open = 0;
    let done = 0;
    let overdue = 0;
    for (const it of this.items) {
      if (it.done) {
        done++;
      } else {
        open++;
        if (it.due && it.due < today) overdue++;
      }
    }
    return { total: this.items.length, open, done, overdue };
  }
}
