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

function validTitle(title) {
  if (typeof title !== 'string' || title.trim() === '') {
    throw new TodoError('Title must be a non-empty string');
  }
  return title.trim();
}

function isRealDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (mo < 1 || mo > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function validDue(due) {
  if (due === undefined || due === null) return null;
  if (typeof due !== 'string' || !isRealDate(due)) {
    throw new TodoError(`Invalid due date: ${due}`);
  }
  return due;
}

function validPriority(p) {
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

function copy(item) {
  return { ...item, tags: [...item.tags] };
}

export class TodoStore {
  constructor({ file } = {}) {
    this.file = file || null;
    this.items = [];
    this.nextId = 1;
    if (this.file && fs.existsSync(this.file)) this._load();
  }

  _load() {
    const raw = fs.readFileSync(this.file, 'utf8');
    let data;
    if (raw.trim() === '') data = {};
    else {
      try { data = JSON.parse(raw); } catch { throw new TodoError(`Corrupt store file: ${this.file}`); }
    }
    const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
    this.items = items.map((it) => ({
      id: it.id,
      title: it.title,
      done: !!it.done,
      priority: it.priority ?? 'normal',
      due: it.due ?? null,
      tags: Array.isArray(it.tags) ? [...it.tags] : [],
      createdAt: it.createdAt ?? new Date().toISOString(),
    }));
    const maxId = this.items.reduce((m, it) => Math.max(m, Number(it.id) || 0), 0);
    const stored = Number(data?.nextId) || 1;
    this.nextId = Math.max(stored, maxId + 1);
  }

  _save() {
    if (!this.file) return;
    const dir = path.dirname(this.file);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ nextId: this.nextId, items: this.items }, null, 2));
    fs.renameSync(tmp, this.file);
  }

  _find(id) {
    const n = typeof id === 'string' && /^\d+$/.test(id.trim()) ? Number(id) : id;
    const item = Number.isInteger(n) ? this.items.find((it) => it.id === n) : undefined;
    if (!item) throw new TodoError(`Unknown todo id: ${id}`);
    return item;
  }

  add(title, opts = {}) {
    const { due, priority = 'normal', tags = [] } = opts ?? {};
    const item = {
      id: this.nextId,
      title: validTitle(title),
      done: false,
      priority: validPriority(priority),
      due: validDue(due),
      tags: validTags(tags),
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

  update(id, patch = {}) {
    const item = this._find(id);
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new TodoError('Patch must be an object');
    }
    const next = {};
    for (const key of Object.keys(patch)) {
      if (!PATCHABLE.includes(key)) throw new TodoError(`Unknown field: ${key}`);
      const v = patch[key];
      if (key === 'title') next.title = validTitle(v);
      else if (key === 'due') next.due = validDue(v);
      else if (key === 'priority') next.priority = validPriority(v);
      else if (key === 'tags') next.tags = validTags(v);
    }
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
    if (removed) this._save();
    return removed;
  }

  list(opts = {}) {
    const { status = 'all', tag, priority, search, sort = 'created' } = opts ?? {};
    if (!STATUSES.includes(status)) throw new TodoError(`Invalid status: ${status}`);
    if (!SORTS.includes(sort)) throw new TodoError(`Invalid sort: ${sort}`);
    if (priority !== undefined && priority !== null) validPriority(priority);
    let res = this.items.slice();
    if (status === 'open') res = res.filter((it) => !it.done);
    else if (status === 'done') res = res.filter((it) => it.done);
    if (tag !== undefined && tag !== null) {
      const t = String(tag).trim().toLowerCase();
      res = res.filter((it) => it.tags.includes(t));
    }
    if (priority !== undefined && priority !== null) res = res.filter((it) => it.priority === priority);
    if (search !== undefined && search !== null && search !== '') {
      const q = String(search).toLowerCase();
      res = res.filter((it) => it.title.toLowerCase().includes(q));
    }
    const byId = (a, b) => a.id - b.id;
    if (sort === 'created') res.sort(byId);
    else if (sort === 'due') {
      res.sort((a, b) => {
        if (a.due === b.due) return byId(a, b);
        if (a.due === null) return 1;
        if (b.due === null) return -1;
        return a.due < b.due ? -1 : 1;
      });
    } else {
      res.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || byId(a, b));
    }
    return res.map(copy);
  }

  stats(today) {
    if (today === undefined || today === null) {
      const d = new Date();
      const pad = (n) => String(n).padStart(2, '0');
      today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    }
    const total = this.items.length;
    const done = this.items.filter((it) => it.done).length;
    const open = total - done;
    const overdue = this.items.filter((it) => !it.done && it.due !== null && it.due < today).length;
    return { total, open, done, overdue };
  }
}
