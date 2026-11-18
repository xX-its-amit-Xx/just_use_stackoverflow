import fs from 'node:fs';

export class TodoError extends Error {
  constructor(message) { super(message); this.name = 'TodoError'; }
}

const PRIORITIES = ['low', 'normal', 'high'];
const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };
const PATCHABLE = new Set(['title', 'due', 'priority', 'tags']);

function validateTitle(title) {
  if (typeof title !== 'string' || title.trim() === '') throw new TodoError('Title must be a non-empty string');
  return title.trim();
}

function validateDue(due) {
  if (due === undefined || due === null) return null;
  if (typeof due !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new TodoError(`Invalid due date: ${due}`);
  const [y, m, d] = due.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) throw new TodoError(`Invalid due date: ${due}`);
  return due;
}

function validatePriority(p) {
  if (!PRIORITIES.includes(p)) throw new TodoError(`Invalid priority: ${p}`);
  return p;
}

function validateTags(tags) {
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

function copy(item) { return { ...item, tags: [...item.tags] }; }

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
      if (raw.trim() !== '') {
        let data;
        try { data = JSON.parse(raw); } catch { throw new TodoError(`Corrupt store file: ${this.file}`); }
        const items = Array.isArray(data) ? data : (Array.isArray(data.items) ? data.items : []);
        this.items = items.map((i) => ({ ...i, tags: Array.isArray(i.tags) ? [...i.tags] : [] }));
        const maxId = this.items.reduce((m, i) => Math.max(m, i.id), 0);
        this.nextId = Math.max(Number.isInteger(data.nextId) ? data.nextId : 1, maxId + 1);
      }
    }
  }

  _save() {
    if (!this.file) return;
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
      due: validateDue(due),
      tags: validateTags(tags),
      createdAt: new Date().toISOString(),
    };
    this.nextId++;
    this.items.push(item);
    this._save();
    return copy(item);
  }

  get(id) { return copy(this._find(id)); }

  update(id, patch) {
    const item = this._find(id);
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new TodoError('Patch must be an object');
    for (const k of Object.keys(patch)) if (!PATCHABLE.has(k)) throw new TodoError(`Unknown field: ${k}`);
    const next = {};
    if ('title' in patch) next.title = validateTitle(patch.title);
    if ('due' in patch) next.due = validateDue(patch.due);
    if ('priority' in patch) next.priority = validatePriority(patch.priority);
    if ('tags' in patch) next.tags = validateTags(patch.tags);
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
    if (!['all', 'open', 'done'].includes(status)) throw new TodoError(`Invalid status: ${status}`);
    if (!['created', 'due', 'priority'].includes(sort)) throw new TodoError(`Invalid sort: ${sort}`);
    if (priority !== undefined && priority !== null) validatePriority(priority);
    let res = this.items.filter((i) => status === 'all' || (status === 'done' ? i.done : !i.done));
    if (tag !== undefined && tag !== null) { const t = String(tag).toLowerCase(); res = res.filter((i) => i.tags.includes(t)); }
    if (priority !== undefined && priority !== null) res = res.filter((i) => i.priority === priority);
    if (search !== undefined && search !== null) { const s = String(search).toLowerCase(); res = res.filter((i) => i.title.toLowerCase().includes(s)); }
    const byId = (a, b) => a.id - b.id;
    if (sort === 'created') res.sort(byId);
    else if (sort === 'due') res.sort((a, b) => {
      if (a.due === b.due) return byId(a, b);
      if (a.due === null) return 1;
      if (b.due === null) return -1;
      return a.due < b.due ? -1 : 1;
    });
    else res.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || byId(a, b));
    return res.map(copy);
  }

  stats(today = todayStr()) {
    const total = this.items.length;
    const done = this.items.filter((i) => i.done).length;
    const overdue = this.items.filter((i) => !i.done && i.due !== null && i.due < today).length;
    return { total, open: total - done, done, overdue };
  }
}
