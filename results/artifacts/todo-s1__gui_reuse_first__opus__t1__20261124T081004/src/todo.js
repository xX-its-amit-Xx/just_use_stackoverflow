import fs from 'node:fs';

export class TodoError extends Error {
  constructor(message) { super(message); this.name = 'TodoError'; }
}

const PRIORITIES = ['low', 'normal', 'high'];
// Priority ordering map adapted from TaskNinja (MIT, Mohamed Bakr) sortCommand.js
const priorityOrder = { high: 1, normal: 2, low: 3 };
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
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) throw new TodoError(`Invalid due date: ${due}`);
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
    const l = t.toLowerCase();
    if (!out.includes(l)) out.push(l);
  }
  return out;
}
function validId(id) {
  const n = typeof id === 'string' && /^\d+$/.test(id.trim()) ? Number(id) : id;
  return n;
}
const clone = (item) => ({ ...item, tags: [...item.tags] });
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
      if (raw.trim()) {
        let data;
        try { data = JSON.parse(raw); } catch { throw new TodoError(`Corrupt store file: ${this.file}`); }
        const items = Array.isArray(data) ? data : (data.items || []);
        this.items = items.map(clone);
        const maxId = this.items.reduce((m, i) => Math.max(m, i.id), 0);
        this.nextId = Math.max(Number(data.nextId) || 1, maxId + 1);
      }
    }
  }

  _save() {
    if (!this.file) return;
    fs.writeFileSync(this.file, JSON.stringify({ nextId: this.nextId, items: this.items }, null, 2));
  }

  _find(id) {
    const n = validId(id);
    const item = this.items.find((i) => i.id === n);
    if (!item) throw new TodoError(`Unknown todo id: ${id}`);
    return item;
  }

  add(title, { due, priority = 'normal', tags = [] } = {}) {
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
    return clone(item);
  }

  get(id) { return clone(this._find(id)); }

  update(id, patch = {}) {
    const item = this._find(id);
    if (patch === null || typeof patch !== 'object') throw new TodoError('Patch must be an object');
    for (const k of Object.keys(patch)) if (!PATCHABLE.has(k)) throw new TodoError(`Unknown field: ${k}`);
    const next = { ...item };
    if ('title' in patch) next.title = validTitle(patch.title);
    if ('due' in patch) next.due = validDue(patch.due);
    if ('priority' in patch) next.priority = validPriority(patch.priority);
    if ('tags' in patch) next.tags = validTags(patch.tags);
    Object.assign(item, next);
    this._save();
    return clone(item);
  }

  complete(id) { const i = this._find(id); i.done = true; this._save(); return clone(i); }
  reopen(id) { const i = this._find(id); i.done = false; this._save(); return clone(i); }

  remove(id) {
    const item = this._find(id);
    this.items = this.items.filter((i) => i !== item);
    this._save();
    return clone(item);
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
    if (priority !== undefined && priority !== null) validPriority(priority);
    let res = this.items.filter((i) =>
      (status === 'all' || (status === 'done' ? i.done : !i.done)) &&
      (tag == null || i.tags.includes(String(tag).toLowerCase())) &&
      (priority == null || i.priority === priority) &&
      (search == null || i.title.toLowerCase().includes(String(search).toLowerCase())));
    res = [...res];
    if (sort === 'created') res.sort((a, b) => a.id - b.id);
    else if (sort === 'due') res.sort((a, b) => {
      if (a.due === b.due) return a.id - b.id;
      if (a.due === null) return 1;
      if (b.due === null) return -1;
      return a.due < b.due ? -1 : 1;
    });
    else res.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority] || a.id - b.id);
    return res.map(clone);
  }

  stats(today = todayStr()) {
    const total = this.items.length;
    const done = this.items.filter((i) => i.done).length;
    const overdue = this.items.filter((i) => !i.done && i.due && i.due < today).length;
    return { total, open: total - done, done, overdue };
  }
}
