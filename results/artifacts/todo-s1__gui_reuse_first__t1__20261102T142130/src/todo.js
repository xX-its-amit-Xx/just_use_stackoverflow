import fs from 'node:fs';

export class TodoError extends Error {
  constructor(msg) { super(msg); this.name = 'TodoError'; }
}

const PRIOS = ['low', 'normal', 'high'];
const RANK = { high: 0, normal: 1, low: 2 };

function checkDue(due) {
  if (due === null || due === undefined) return null;
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
function checkPrio(p) {
  if (!PRIOS.includes(p)) throw new TodoError('Invalid priority: ' + p);
  return p;
}
function checkTags(tags) {
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) throw new TodoError('Tags must be an array of strings');
  return [...new Set(tags.map((t) => t.toLowerCase()))];
}
const today = () => new Date().toISOString().slice(0, 10);

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
        this.nextId = Math.max(data.nextId || 1, ...this.items.map((i) => i.id + 1), 1);
      }
    }
  }
  _save() {
    if (this.file) fs.writeFileSync(this.file, JSON.stringify({ nextId: this.nextId, items: this.items }, null, 2));
  }
  _find(id) {
    const it = this.items.find((i) => i.id === id);
    if (!it) throw new TodoError('Unknown id: ' + id);
    return it;
  }
  add(title, { due, priority = 'normal', tags = [] } = {}) {
    const item = {
      id: this.nextId, title: checkTitle(title), done: false, priority: checkPrio(priority),
      due: checkDue(due), tags: checkTags(tags), createdAt: new Date().toISOString(),
    };
    this.nextId++;
    this.items.push(item);
    this._save();
    return { ...item, tags: [...item.tags] };
  }
  get(id) { const i = this._find(id); return { ...i, tags: [...i.tags] }; }
  update(id, patch = {}) {
    const it = this._find(id);
    for (const k of Object.keys(patch)) if (!['title', 'due', 'priority', 'tags'].includes(k)) throw new TodoError('Unknown field: ' + k);
    const n = {};
    if ('title' in patch) n.title = checkTitle(patch.title);
    if ('due' in patch) n.due = checkDue(patch.due);
    if ('priority' in patch) n.priority = checkPrio(patch.priority);
    if ('tags' in patch) n.tags = checkTags(patch.tags);
    Object.assign(it, n);
    this._save();
    return this.get(id);
  }
  complete(id) { this._find(id).done = true; this._save(); return this.get(id); }
  reopen(id) { this._find(id).done = false; this._save(); return this.get(id); }
  remove(id) {
    const it = this._find(id);
    this.items = this.items.filter((i) => i !== it);
    this._save();
    return { ...it, tags: [...it.tags] };
  }
  clearCompleted() {
    const before = this.items.length;
    this.items = this.items.filter((i) => !i.done);
    this._save();
    return before - this.items.length;
  }
  list({ status = 'all', tag, priority, search, sort = 'created' } = {}) {
    if (!['all', 'open', 'done'].includes(status)) throw new TodoError('Invalid status: ' + status);
    if (!['created', 'due', 'priority'].includes(sort)) throw new TodoError('Invalid sort: ' + sort);
    let r = this.items.filter((i) => {
      if (status === 'open' && i.done) return false;
      if (status === 'done' && !i.done) return false;
      if (tag !== undefined && !i.tags.includes(String(tag).toLowerCase())) return false;
      if (priority !== undefined && i.priority !== priority) return false;
      if (search !== undefined && !i.title.toLowerCase().includes(String(search).toLowerCase())) return false;
      return true;
    });
    r.sort((a, b) => {
      if (sort === 'due') {
        if (a.due !== b.due) {
          if (a.due === null) return 1;
          if (b.due === null) return -1;
          return a.due < b.due ? -1 : 1;
        }
      } else if (sort === 'priority') {
        if (RANK[a.priority] !== RANK[b.priority]) return RANK[a.priority] - RANK[b.priority];
      }
      return a.id - b.id;
    });
    return r.map((i) => ({ ...i, tags: [...i.tags] }));
  }
  stats(t = today()) {
    const open = this.items.filter((i) => !i.done);
    return {
      total: this.items.length, open: open.length, done: this.items.length - open.length,
      overdue: open.filter((i) => i.due !== null && i.due < t).length,
    };
  }
}
