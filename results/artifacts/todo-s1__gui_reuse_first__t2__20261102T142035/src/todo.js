import fs from 'node:fs';

export class TodoError extends Error {
  constructor(m) { super(m); this.name = 'TodoError'; }
}

const PRIORITIES = ['low', 'normal', 'high'];

function checkDue(due) {
  if (due === undefined || due === null) return null;
  if (typeof due !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new TodoError('Invalid due date: ' + due);
  const [y, m, d] = due.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) throw new TodoError('Invalid due date: ' + due);
  return due;
}
function checkTitle(t) {
  if (typeof t !== 'string' || !t.trim()) throw new TodoError('Title must be a non-empty string');
  return t.trim();
}
function checkPriority(p) {
  if (!PRIORITIES.includes(p)) throw new TodoError('Invalid priority: ' + p);
  return p;
}
function checkTags(tags) {
  if (!Array.isArray(tags) || tags.some(t => typeof t !== 'string')) throw new TodoError('Tags must be an array of strings');
  return [...new Set(tags.map(t => t.toLowerCase()))];
}
const copy = i => ({ ...i, tags: [...i.tags] });

export class TodoStore {
  constructor({ file } = {}) {
    this.file = file;
    this.items = [];
    this.nextId = 1;
    if (file && fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      if (raw.trim()) {
        const data = JSON.parse(raw);
        this.items = data.items || [];
        this.nextId = Math.max(data.nextId || 1, ...this.items.map(i => i.id + 1), 1);
      }
    }
  }
  _save() {
    if (this.file) fs.writeFileSync(this.file, JSON.stringify({ nextId: this.nextId, items: this.items }, null, 2));
  }
  _find(id) {
    const it = this.items.find(i => i.id === id);
    if (!it) throw new TodoError('Unknown id: ' + id);
    return it;
  }
  add(title, { due, priority = 'normal', tags = [] } = {}) {
    const item = {
      id: this.nextId, title: checkTitle(title), done: false,
      priority: checkPriority(priority), due: checkDue(due), tags: checkTags(tags),
      createdAt: new Date().toISOString(),
    };
    this.nextId++;
    this.items.push(item);
    this._save();
    return copy(item);
  }
  get(id) { return copy(this._find(id)); }
  update(id, patch = {}) {
    const it = this._find(id);
    const allowed = ['title', 'due', 'priority', 'tags'];
    for (const k of Object.keys(patch)) if (!allowed.includes(k)) throw new TodoError('Unknown field: ' + k);
    const next = {};
    if ('title' in patch) next.title = checkTitle(patch.title);
    if ('due' in patch) next.due = checkDue(patch.due);
    if ('priority' in patch) next.priority = checkPriority(patch.priority);
    if ('tags' in patch) next.tags = checkTags(patch.tags);
    Object.assign(it, next);
    this._save();
    return copy(it);
  }
  complete(id) { const it = this._find(id); it.done = true; this._save(); return copy(it); }
  reopen(id) { const it = this._find(id); it.done = false; this._save(); return copy(it); }
  remove(id) {
    const it = this._find(id);
    this.items = this.items.filter(i => i !== it);
    this._save();
    return copy(it);
  }
  clearCompleted() {
    const n = this.items.filter(i => i.done).length;
    this.items = this.items.filter(i => !i.done);
    this._save();
    return n;
  }
  list({ status = 'all', tag, priority, search, sort = 'created' } = {}) {
    if (!['all', 'open', 'done'].includes(status)) throw new TodoError('Invalid status: ' + status);
    if (!['created', 'due', 'priority'].includes(sort)) throw new TodoError('Invalid sort: ' + sort);
    let r = this.items.filter(i => {
      if (status === 'open' && i.done) return false;
      if (status === 'done' && !i.done) return false;
      if (tag !== undefined && !i.tags.includes(String(tag).toLowerCase())) return false;
      if (priority !== undefined && i.priority !== priority) return false;
      if (search !== undefined && !i.title.toLowerCase().includes(String(search).toLowerCase())) return false;
      return true;
    });
    const rank = { high: 0, normal: 1, low: 2 };
    if (sort === 'due') r.sort((a, b) => (a.due === null) - (b.due === null) || (a.due && b.due && (a.due < b.due ? -1 : a.due > b.due ? 1 : 0)) || a.id - b.id);
    else if (sort === 'priority') r.sort((a, b) => rank[a.priority] - rank[b.priority] || a.id - b.id);
    else r.sort((a, b) => a.id - b.id);
    return r.map(copy);
  }
  stats(today = new Date().toISOString().slice(0, 10)) {
    const done = this.items.filter(i => i.done).length;
    return {
      total: this.items.length, open: this.items.length - done, done,
      overdue: this.items.filter(i => !i.done && i.due !== null && i.due < today).length,
    };
  }
}
