import fs from 'node:fs';

export class TodoError extends Error {
  constructor(msg) { super(msg); this.name = 'TodoError'; }
}

const PRIOS = ['low', 'normal', 'high'];

function checkTitle(t) {
  if (typeof t !== 'string' || !t.trim()) throw new TodoError('Title must be a non-empty string');
  return t.trim();
}
function checkDue(d) {
  if (d === undefined || d === null) return null;
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new TodoError('Invalid due date');
  const [y, m, day] = d.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== day) throw new TodoError('Invalid due date');
  return d;
}
function checkPrio(p) {
  if (!PRIOS.includes(p)) throw new TodoError('Invalid priority');
  return p;
}
function checkTags(t) {
  if (!Array.isArray(t) || t.some(x => typeof x !== 'string')) throw new TodoError('Tags must be an array of strings');
  return [...new Set(t.map(x => x.toLowerCase()))];
}

export class TodoStore {
  constructor({ file } = {}) {
    this.file = file;
    this.items = [];
    this.nextId = 1;
    if (file && fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      if (raw.trim()) {
        const data = JSON.parse(raw);
        this.items = Array.isArray(data) ? data : (data.items || []);
        this.nextId = (!Array.isArray(data) && data.nextId) || 1;
        for (const i of this.items) if (i.id >= this.nextId) this.nextId = i.id + 1;
      }
    }
  }
  _save() {
    if (this.file) fs.writeFileSync(this.file, JSON.stringify({ nextId: this.nextId, items: this.items }, null, 2));
  }
  _find(id) {
    const it = this.items.find(i => i.id === id);
    if (!it) throw new TodoError(`Unknown id: ${id}`);
    return it;
  }
  add(title, { due, priority = 'normal', tags = [] } = {}) {
    const item = {
      id: this.nextId, title: checkTitle(title), done: false,
      priority: checkPrio(priority), due: checkDue(due), tags: checkTags(tags),
      createdAt: new Date().toISOString(),
    };
    this.nextId++;
    this.items.push(item);
    this._save();
    return { ...item, tags: [...item.tags] };
  }
  get(id) { const i = this._find(id); return { ...i, tags: [...i.tags] }; }
  update(id, patch = {}) {
    const it = this._find(id);
    const allowed = ['title', 'due', 'priority', 'tags'];
    for (const k of Object.keys(patch)) if (!allowed.includes(k)) throw new TodoError(`Unknown field: ${k}`);
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
    this.items = this.items.filter(i => i !== it);
    this._save();
    return it;
  }
  clearCompleted() {
    const n = this.items.filter(i => i.done).length;
    this.items = this.items.filter(i => !i.done);
    if (n) this._save();
    return n;
  }
  list({ status = 'all', tag, priority, search, sort = 'created' } = {}) {
    if (!['all', 'open', 'done'].includes(status)) throw new TodoError('Invalid status');
    if (!['created', 'due', 'priority'].includes(sort)) throw new TodoError('Invalid sort');
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
    return r.map(i => ({ ...i, tags: [...i.tags] }));
  }
  stats(today = new Date().toISOString().slice(0, 10)) {
    const done = this.items.filter(i => i.done).length;
    return {
      total: this.items.length, open: this.items.length - done, done,
      overdue: this.items.filter(i => !i.done && i.due !== null && i.due < today).length,
    };
  }
}
