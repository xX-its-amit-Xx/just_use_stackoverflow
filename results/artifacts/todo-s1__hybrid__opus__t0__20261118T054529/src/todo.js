import fs from 'node:fs';

export class TodoError extends Error {
  constructor(message) { super(message); this.name = 'TodoError'; }
}

const PRIORITIES = ['low', 'normal', 'high'];
const PRIO_RANK = { high: 0, normal: 1, low: 2 };
const STATUSES = ['all', 'open', 'done'];
const SORTS = ['created', 'due', 'priority'];
const PATCHABLE = ['title', 'due', 'priority', 'tags'];

function validTitle(title) {
  if (typeof title !== 'string' || title.trim() === '') throw new TodoError('Title must be a non-empty string');
  return title.trim();
}

function validDue(due) {
  if (due === undefined || due === null) return null;
  if (typeof due !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new TodoError(`Invalid due date: ${due}`);
  const [y, m, d] = due.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (m < 1 || m > 12 || d < 1 || dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new TodoError(`Invalid due date: ${due}`);
  }
  return due;
}

function validPriority(p) {
  if (p === undefined) return 'normal';
  if (!PRIORITIES.includes(p)) throw new TodoError(`Invalid priority: ${p}`);
  return p;
}

function validTags(tags) {
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
}

const copy = (item) => ({ ...item, tags: [...item.tags] });

function todayStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export class TodoStore {
  constructor({ file } = {}) {
    this.file = file || null;
    this.items = [];
    this.nextId = 1;
    if (this.file && fs.existsSync(this.file)) {
      const raw = fs.readFileSync(this.file, 'utf8');
      let data;
      try { data = raw.trim() === '' ? {} : JSON.parse(raw); } catch { throw new TodoError(`Corrupt store file: ${this.file}`); }
      const items = Array.isArray(data) ? data : Array.isArray(data.items) ? data.items : [];
      this.items = items.map((i) => ({ ...i, tags: Array.isArray(i.tags) ? [...i.tags] : [] }));
      const maxId = this.items.reduce((m, i) => Math.max(m, Number(i.id) || 0), 0);
      const stored = Array.isArray(data) ? 0 : Number(data.nextId) || 0;
      this.nextId = Math.max(stored, maxId + 1, 1);
    }
  }

  _save() {
    if (!this.file) return;
    fs.writeFileSync(this.file, JSON.stringify({ nextId: this.nextId, items: this.items }, null, 2));
  }

  _find(id) {
    const n = typeof id === 'string' && /^\d+$/.test(id.trim()) ? Number(id) : id;
    const item = this.items.find((i) => i.id === n);
    if (!item) throw new TodoError(`Unknown id: ${id}`);
    return item;
  }

  add(title, opts = {}) {
    if (opts === null || typeof opts !== 'object') opts = {};
    const { due, priority, tags } = opts;
    const item = {
      id: this.nextId,
      title: validTitle(title),
      done: false,
      priority: validPriority(priority),
      due: validDue(due),
      tags: validTags(tags),
      createdAt: new Date().toISOString(),
    };
    this.nextId++;
    this.items.push(item);
    this._save();
    return copy(item);
  }

  get(id) { return copy(this._find(id)); }

  update(id, patch = {}) {
    const item = this._find(id);
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new TodoError('Patch must be an object');
    for (const k of Object.keys(patch)) if (!PATCHABLE.includes(k)) throw new TodoError(`Unknown field: ${k}`);
    const next = {};
    if ('title' in patch) next.title = validTitle(patch.title);
    if ('due' in patch) next.due = validDue(patch.due);
    if ('priority' in patch) {
      if (!PRIORITIES.includes(patch.priority)) throw new TodoError(`Invalid priority: ${patch.priority}`);
      next.priority = patch.priority;
    }
    if ('tags' in patch) next.tags = validTags(patch.tags);
    Object.assign(item, next);
    this._save();
    return copy(item);
  }

  complete(id) { const i = this._find(id); i.done = true; this._save(); return copy(i); }
  reopen(id) { const i = this._find(id); i.done = false; this._save(); return copy(i); }

  remove(id) {
    const item = this._find(id);
    this.items = this.items.filter((i) => i !== item);
    this._save();
    return copy(item);
  }

  clearCompleted() {
    const before = this.items.length;
    this.items = this.items.filter((i) => !i.done);
    const n = before - this.items.length;
    this._save();
    return n;
  }

  list({ status = 'all', tag, priority, search, sort = 'created' } = {}) {
    if (!STATUSES.includes(status)) throw new TodoError(`Invalid status: ${status}`);
    if (!SORTS.includes(sort)) throw new TodoError(`Invalid sort: ${sort}`);
    if (priority !== undefined && priority !== null && !PRIORITIES.includes(priority)) throw new TodoError(`Invalid priority: ${priority}`);
    let res = this.items.filter((i) => status === 'all' || (status === 'open' ? !i.done : i.done));
    if (tag !== undefined && tag !== null) {
      const t = String(tag).trim().toLowerCase();
      res = res.filter((i) => i.tags.includes(t));
    }
    if (priority) res = res.filter((i) => i.priority === priority);
    if (search !== undefined && search !== null) {
      const q = String(search).toLowerCase();
      res = res.filter((i) => i.title.toLowerCase().includes(q));
    }
    res = [...res];
    if (sort === 'created') res.sort((a, b) => a.id - b.id);
    else if (sort === 'due') res.sort((a, b) => {
      if (a.due === b.due) return a.id - b.id;
      if (!a.due) return 1;
      if (!b.due) return -1;
      return a.due < b.due ? -1 : 1;
    });
    else res.sort((a, b) => (PRIO_RANK[a.priority] - PRIO_RANK[b.priority]) || a.id - b.id);
    return res.map(copy);
  }

  stats(today = todayStr()) {
    const open = this.items.filter((i) => !i.done);
    return {
      total: this.items.length,
      open: open.length,
      done: this.items.length - open.length,
      overdue: open.filter((i) => i.due && i.due < today).length,
    };
  }
}
