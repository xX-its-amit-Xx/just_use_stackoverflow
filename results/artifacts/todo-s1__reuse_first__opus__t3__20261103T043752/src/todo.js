// Adapted from TaskNinja CLI (MIT, (c) 2026 Mohamed Bakr):
//   src/utils/validators.js (validatePriority / validateDueDate) and
//   src/utils/taskService.js (loadTasks / saveTasks / getNextId), made synchronous.
// Date check idea (regex + Date round-trip) from https://stackoverflow.com/a/11611388 (CC BY-SA).
import fs from 'node:fs';

export class TodoError extends Error {
  constructor(message) { super(message); this.name = 'TodoError'; }
}

const ALLOWED_PRIORITIES = ['low', 'normal', 'high'];
const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };
const STATUSES = ['all', 'open', 'done'];
const SORTS = ['created', 'due', 'priority'];
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const validateTitle = (title) => {
  if (typeof title !== 'string' || title.trim() === '') throw new TodoError('Title must be a non-empty string');
  return title.trim();
};
const validatePriority = (priority) => {
  if (!ALLOWED_PRIORITIES.includes(priority)) {
    throw new TodoError(`Invalid priority. Allowed priorities are: ${ALLOWED_PRIORITIES.join(', ')}`);
  }
  return priority;
};
export const isValidDate = (s) => {
  if (typeof s !== 'string') return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
};
const validateDueDate = (due) => {
  if (due === undefined || due === null) return null;
  if (!isValidDate(due)) throw new TodoError('Invalid due date. Please use a valid date format (YYYY-MM-DD).');
  return due;
};
const validateTags = (tags) => {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags)) throw new TodoError('Tags must be an array of strings');
  const out = [];
  for (const t of tags) {
    if (typeof t !== 'string') throw new TodoError('Tags must be an array of strings');
    const v = t.toLowerCase();
    if (!out.includes(v)) out.push(v);
  }
  return out;
};
const validateId = (id) => {
  const n = typeof id === 'string' && /^\d+$/.test(id.trim()) ? Number(id) : id;
  if (!Number.isInteger(n) || n <= 0) throw new TodoError(`Invalid id: ${id}`);
  return n;
};

const copy = (item) => ({ ...item, tags: [...item.tags] });
const todayStr = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export class TodoStore {
  constructor({ file } = {}) {
    this.file = file || null;
    this.items = [];
    this.nextId = 1;
    if (this.file) this._load();
  }

  _load() {
    let data;
    try {
      data = fs.readFileSync(this.file, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (data.trim() === '') return;
    let parsed;
    try { parsed = JSON.parse(data); } catch { throw new TodoError(`Corrupt storage file: ${this.file}`); }
    const items = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.items) ? parsed.items : [];
    this.items = items.map((it) => ({ ...it, tags: Array.isArray(it.tags) ? [...it.tags] : [] }));
    const maxId = this.items.length > 0 ? Math.max(...this.items.map((t) => t.id)) : 0;
    const stored = Number.isInteger(parsed?.nextId) ? parsed.nextId : 1;
    this.nextId = Math.max(stored, maxId + 1);
  }

  _save() {
    if (!this.file) return;
    fs.writeFileSync(this.file, JSON.stringify({ nextId: this.nextId, items: this.items }, null, 2));
  }

  _find(id) {
    const n = validateId(id);
    const item = this.items.find((t) => t.id === n);
    if (!item) throw new TodoError(`Unknown todo id: ${id}`);
    return item;
  }

  add(title, opts = {}) {
    const { due, priority = 'normal', tags = [] } = opts ?? {};
    const item = {
      id: 0,
      title: validateTitle(title),
      done: false,
      priority: validatePriority(priority),
      due: validateDueDate(due),
      tags: validateTags(tags),
      createdAt: new Date().toISOString(),
    };
    item.id = this.nextId++;
    this.items.push(item);
    this._save();
    return copy(item);
  }

  get(id) { return copy(this._find(id)); }

  update(id, patch = {}) {
    const item = this._find(id);
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new TodoError('Patch must be an object');
    const allowed = ['title', 'due', 'priority', 'tags'];
    for (const k of Object.keys(patch)) if (!allowed.includes(k)) throw new TodoError(`Unknown field: ${k}`);
    const next = {};
    if ('title' in patch) next.title = validateTitle(patch.title);
    if ('due' in patch) next.due = validateDueDate(patch.due);
    if ('priority' in patch) next.priority = validatePriority(patch.priority);
    if ('tags' in patch) next.tags = validateTags(patch.tags);
    Object.assign(item, next);
    this._save();
    return copy(item);
  }

  complete(id) { const it = this._find(id); it.done = true; this._save(); return copy(it); }
  reopen(id) { const it = this._find(id); it.done = false; this._save(); return copy(it); }

  remove(id) {
    const it = this._find(id);
    this.items = this.items.filter((t) => t !== it);
    this._save();
    return copy(it);
  }

  clearCompleted() {
    const before = this.items.length;
    this.items = this.items.filter((t) => !t.done);
    const n = before - this.items.length;
    if (n > 0) this._save();
    return n;
  }

  list(opts = {}) {
    const { status = 'all', tag, priority, search, sort = 'created' } = opts ?? {};
    if (!STATUSES.includes(status)) throw new TodoError(`Invalid status: ${status}`);
    if (!SORTS.includes(sort)) throw new TodoError(`Invalid sort: ${sort}`);
    if (priority !== undefined && priority !== null) validatePriority(priority);
    let res = this.items.slice();
    if (status === 'open') res = res.filter((t) => !t.done);
    if (status === 'done') res = res.filter((t) => t.done);
    if (tag !== undefined && tag !== null) {
      const tl = String(tag).toLowerCase();
      res = res.filter((t) => t.tags.includes(tl));
    }
    if (priority !== undefined && priority !== null) res = res.filter((t) => t.priority === priority);
    if (search !== undefined && search !== null && search !== '') {
      const s = String(search).toLowerCase();
      res = res.filter((t) => t.title.toLowerCase().includes(s));
    }
    if (sort === 'created') res.sort((a, b) => a.id - b.id);
    else if (sort === 'due') {
      res.sort((a, b) => {
        if (a.due && b.due) return a.due < b.due ? -1 : a.due > b.due ? 1 : a.id - b.id;
        if (a.due) return -1;
        if (b.due) return 1;
        return a.id - b.id;
      });
    } else res.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.id - b.id);
    return res.map(copy);
  }

  stats(today = todayStr()) {
    const total = this.items.length;
    const done = this.items.filter((t) => t.done).length;
    const overdue = this.items.filter((t) => !t.done && t.due && t.due < today).length;
    return { total, open: total - done, done, overdue };
  }
}
