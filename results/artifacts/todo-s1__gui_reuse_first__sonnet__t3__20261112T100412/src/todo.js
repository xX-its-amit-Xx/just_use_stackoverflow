import fs from 'node:fs';

export class TodoError extends Error {
  constructor(m) { super(m); this.name = 'TodoError'; }
}

const PRIOS = ['low', 'normal', 'high'];

function checkDue(due) {
  if (due === undefined || due === null) return null;
  if (typeof due !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new TodoError(`Invalid due date: ${due}`);
  const d = new Date(due + 'T00:00:00Z');
  if (isNaN(d) || d.toISOString().slice(0, 10) !== due) throw new TodoError(`Invalid due date: ${due}`);
  return due;
}
function checkTitle(t) {
  if (typeof t !== 'string' || !t.trim()) throw new TodoError('Title must be a non-empty string');
  return t.trim();
}
function checkPrio(p) {
  if (!PRIOS.includes(p)) throw new TodoError(`Invalid priority: ${p}`);
  return p;
}
function checkTags(tags) {
  if (!Array.isArray(tags) || tags.some(t => typeof t !== 'string')) throw new TodoError('Tags must be an array of strings');
  return [...new Set(tags.map(t => t.toLowerCase()))];
}

export class TodoStore {
  constructor({ file } = {}) {
    this.file = file;
    this.items = [];
    this.nextId = 1;
    if (file && fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      if (raw.trim()) {
        let data;
        try { data = JSON.parse(raw); } catch { throw new TodoError('Corrupt storage file'); }
        this.items = Array.isArray(data) ? data : (data.items || []);
        const max = this.items.reduce((m, i) => Math.max(m, i.id), 0);
        this.nextId = Math.max(Array.isArray(data) ? 1 : (data.nextId || 1), max + 1);
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
    return structuredClone(item);
  }
  get(id) { return structuredClone(this._find(id)); }
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
    return structuredClone(it);
  }
  complete(id) { const it = this._find(id); it.done = true; this._save(); return structuredClone(it); }
  reopen(id) { const it = this._find(id); it.done = false; this._save(); return structuredClone(it); }
  remove(id) {
    const it = this._find(id);
    this.items = this.items.filter(i => i !== it);
    this._save();
    return structuredClone(it);
  }
  clearCompleted() {
    const n = this.items.filter(i => i.done).length;
    this.items = this.items.filter(i => !i.done);
    if (n) this._save();
    return n;
  }
  list({ status = 'all', tag, priority, search, sort = 'created' } = {}) {
    if (!['all', 'open', 'done'].includes(status)) throw new TodoError(`Invalid status: ${status}`);
    if (!['created', 'due', 'priority'].includes(sort)) throw new TodoError(`Invalid sort: ${sort}`);
    let r = this.items.filter(i => {
      if (status === 'open' && i.done) return false;
      if (status === 'done' && !i.done) return false;
      if (tag != null && !i.tags.includes(String(tag).toLowerCase())) return false;
      if (priority != null && i.priority !== priority) return false;
      if (search != null && !i.title.toLowerCase().includes(String(search).toLowerCase())) return false;
      return true;
    });
    const rank = { high: 0, normal: 1, low: 2 };
    r.sort((a, b) => {
      if (sort === 'due') {
        if (a.due !== b.due) {
          if (a.due === null) return 1;
          if (b.due === null) return -1;
          return a.due < b.due ? -1 : 1;
        }
      } else if (sort === 'priority' && rank[a.priority] !== rank[b.priority]) {
        return rank[a.priority] - rank[b.priority];
      }
      return a.id - b.id;
    });
    return structuredClone(r);
  }
  stats(today = new Date().toISOString().slice(0, 10)) {
    const done = this.items.filter(i => i.done).length;
    return {
      total: this.items.length, open: this.items.length - done, done,
      overdue: this.items.filter(i => !i.done && i.due && i.due < today).length,
    };
  }
}
