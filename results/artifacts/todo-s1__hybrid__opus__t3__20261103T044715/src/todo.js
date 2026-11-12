import fs from 'node:fs';

export class TodoError extends Error {
  constructor(message) { super(message); this.name = 'TodoError'; }
}

const PRIORITIES = ['low', 'normal', 'high'];
const PRIO_RANK = { high: 0, normal: 1, low: 2 };
const STATUSES = ['all', 'open', 'done'];
const SORTS = ['created', 'due', 'priority'];
const PATCHABLE = new Set(['title', 'due', 'priority', 'tags']);

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
const copy = (it) => ({ ...it, tags: [...it.tags] });

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
      const maxId = this.items.reduce((m, i) => Math.max(m, i.id), 0);
      this.nextId = Math.max(Number.isInteger(data.nextId) ? data.nextId : 1, maxId + 1);
    }
  }

  _save() {
    if (!this.file) return;
    fs.writeFileSync(this.file, JSON.stringify({ nextId: this.nextId, items: this.items }, null, 2));
  }

  _find(id) {
    const n = typeof id === 'string' && /^\d+$/.test(id.trim()) ? Number(id) : id;
    const it = Number.isInteger(n) ? this.items.find((i) => i.id === n) : undefined;
    if (!it) throw new TodoError(`Unknown id: ${id}`);
    return it;
  }

  add(title, { due, priority, tags } = {}) {
    const item = {
      id: 0,
      title: validTitle(title),
      done: false,
      priority: validPriority(priority),
      due: validDue(due),
      tags: validTags(tags),
      createdAt: new Date().toISOString(),
    };
    item.id = this.nextId++;
    this.items.push(item);
    this._save();
    return copy(item);
  }

  get(id) { return copy(this._find(id)); }

  update(id, patch) {
    const it = this._find(id);
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new TodoError('Patch must be an object');
    const next = {};
    for (const [k, v] of Object.entries(patch)) {
      if (!PATCHABLE.has(k)) throw new TodoError(`Unknown field: ${k}`);
      if (k === 'title') next.title = validTitle(v);
      else if (k === 'due') next.due = validDue(v);
      else if (k === 'priority') {
        if (!PRIORITIES.includes(v)) throw new TodoError(`Invalid priority: ${v}`);
        next.priority = v;
      } else if (k === 'tags') next.tags = validTags(v);
    }
    Object.assign(it, next);
    this._save();
    return copy(it);
  }

  complete(id) { const it = this._find(id); it.done = true; this._save(); return copy(it); }
  reopen(id) { const it = this._find(id); it.done = false; this._save(); return copy(it); }

  remove(id) {
    const it = this._find(id);
    this.items = this.items.filter((i) => i !== it);
    this._save();
    return copy(it);
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
    let res = this.items.filter((i) => status === 'all' || (status === 'done' ? i.done : !i.done));
    if (tag !== undefined && tag !== null) {
      const t = String(tag).toLowerCase();
      res = res.filter((i) => i.tags.includes(t));
    }
    if (priority !== undefined && priority !== null) res = res.filter((i) => i.priority === priority);
    if (search !== undefined && search !== null) {
      const s = String(search).toLowerCase();
      res = res.filter((i) => i.title.toLowerCase().includes(s));
    }
    res = [...res];
    if (sort === 'created') res.sort((a, b) => a.id - b.id);
    else if (sort === 'due') res.sort((a, b) => {
      if (a.due === b.due) return a.id - b.id;
      if (a.due === null) return 1;
      if (b.due === null) return -1;
      return a.due < b.due ? -1 : 1;
    });
    else res.sort((a, b) => (PRIO_RANK[a.priority] - PRIO_RANK[b.priority]) || (a.id - b.id));
    return res.map(copy);
  }

  stats(today) {
    if (today === undefined) {
      const d = new Date();
      today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    const total = this.items.length;
    const done = this.items.filter((i) => i.done).length;
    const overdue = this.items.filter((i) => !i.done && i.due && i.due < today).length;
    return { total, open: total - done, done, overdue };
  }
}
