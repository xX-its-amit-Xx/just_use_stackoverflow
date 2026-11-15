// Todo library. Validation helpers and JSON load/save/next-id logic adapted from
// TaskNinja CLI (MIT, (c) 2026 Mohamed Bakr) — see THIRD_PARTY_NOTICES.md.
import fs from 'node:fs';
import path from 'node:path';

export class TodoError extends Error {
  constructor(message) { super(message); this.name = 'TodoError'; }
}

// allowed task priorities (adapted from TaskNinja src/utils/validators.js)
const ALLOWED_PRIORITIES = ['low', 'normal', 'high'];
const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };
const STATUSES = ['all', 'open', 'done'];
const SORTS = ['created', 'due', 'priority'];
const PATCHABLE = ['title', 'due', 'priority', 'tags'];

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
// verify due date format: strict YYYY-MM-DD and a real calendar date
const validateDueDate = (due) => {
  if (due === undefined || due === null) return null;
  if (typeof due !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    throw new TodoError('Invalid due date. Please use the format YYYY-MM-DD.');
  }
  const [y, m, d] = due.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new TodoError(`Invalid due date: ${due} is not a real date`);
  }
  return due;
};
const validateTags = (tags) => {
  if (tags === undefined || tags === null) return [];
  if (!Array.isArray(tags)) throw new TodoError('Tags must be an array of strings');
  const out = [];
  for (const t of tags) {
    if (typeof t !== 'string') throw new TodoError('Tags must be an array of strings');
    const v = t.trim().toLowerCase();
    if (v === '') throw new TodoError('Tags must be non-empty strings');
    if (!out.includes(v)) out.push(v);
  }
  return out;
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

  // load tasks from file (adapted from TaskNinja loadTasks, made synchronous)
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
    try { parsed = JSON.parse(data); } catch { throw new TodoError(`Corrupt store file: ${this.file}`); }
    const items = Array.isArray(parsed) ? parsed : (parsed.items || []);
    this.items = items.map((i) => ({ ...i, tags: Array.isArray(i.tags) ? i.tags : [] }));
    // get next task ID (TaskNinja getNextId), but never below the persisted counter
    const maxId = this.items.length > 0 ? Math.max(...this.items.map((t) => t.id)) : 0;
    const stored = !Array.isArray(parsed) && Number.isInteger(parsed.nextId) ? parsed.nextId : 1;
    this.nextId = Math.max(stored, maxId + 1);
  }

  _save() {
    if (!this.file) return;
    const dir = path.dirname(this.file);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ nextId: this.nextId, items: this.items }, null, 2));
  }

  _find(id) {
    const n = typeof id === 'string' && /^\d+$/.test(id.trim()) ? Number(id) : id;
    const item = this.items.find((i) => i.id === n);
    if (!item) throw new TodoError(`Unknown todo id: ${id}`);
    return item;
  }

  add(title, { due, priority = 'normal', tags = [] } = {}) {
    const item = {
      id: this.nextId,
      title: validateTitle(title),
      done: false,
      priority: validatePriority(priority),
      due: validateDueDate(due),
      tags: validateTags(tags),
      createdAt: new Date().toISOString(),
    };
    this.nextId += 1;
    this.items.push(item);
    this._save();
    return copy(item);
  }

  get(id) { return copy(this._find(id)); }

  update(id, patch = {}) {
    const item = this._find(id);
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new TodoError('Patch must be an object');
    for (const k of Object.keys(patch)) {
      if (!PATCHABLE.includes(k)) throw new TodoError(`Unknown field: ${k}`);
    }
    const next = {};
    if ('title' in patch) next.title = validateTitle(patch.title);
    if ('due' in patch) next.due = validateDueDate(patch.due);
    if ('priority' in patch) next.priority = validatePriority(patch.priority);
    if ('tags' in patch) next.tags = validateTags(patch.tags);
    Object.assign(item, next);
    this._save();
    return copy(item);
  }

  complete(id) { const item = this._find(id); item.done = true; this._save(); return copy(item); }
  reopen(id) { const item = this._find(id); item.done = false; this._save(); return copy(item); }

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
    this._save();
    return removed;
  }

  list({ status = 'all', tag, priority, search, sort = 'created' } = {}) {
    if (!STATUSES.includes(status)) throw new TodoError(`Invalid status: ${status}`);
    if (!SORTS.includes(sort)) throw new TodoError(`Invalid sort: ${sort}`);
    if (priority !== undefined && priority !== null) validatePriority(priority);
    let out = this.items.slice();
    if (status === 'open') out = out.filter((i) => !i.done);
    else if (status === 'done') out = out.filter((i) => i.done);
    if (tag !== undefined && tag !== null) {
      const t = String(tag).trim().toLowerCase();
      out = out.filter((i) => i.tags.includes(t));
    }
    if (priority !== undefined && priority !== null) out = out.filter((i) => i.priority === priority);
    if (search !== undefined && search !== null) {
      const s = String(search).toLowerCase();
      out = out.filter((i) => i.title.toLowerCase().includes(s));
    }
    const byId = (a, b) => a.id - b.id;
    if (sort === 'created') out.sort(byId);
    else if (sort === 'due') {
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

  stats(today = todayStr()) {
    const total = this.items.length;
    const done = this.items.filter((i) => i.done).length;
    const overdue = this.items.filter((i) => !i.done && i.due && i.due < today).length;
    return { total, open: total - done, done, overdue };
  }
}
