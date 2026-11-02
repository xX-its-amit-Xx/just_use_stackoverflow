import fs from 'node:fs';

export class TodoError extends Error {
  constructor(m) { super(m); this.name = 'TodoError'; }
}
const PRI = ['low', 'normal', 'high'];

function vTitle(t) {
  if (typeof t !== 'string' || !t.trim()) throw new TodoError('Title must be a non-empty string');
  return t.trim();
}
function vDue(d) {
  if (d === undefined || d === null) return null;
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new TodoError('Invalid due date: ' + d);
  const dt = new Date(d + 'T00:00:00Z');
  if (isNaN(dt) || dt.toISOString().slice(0, 10) !== d) throw new TodoError('Invalid due date: ' + d);
  return d;
}
function vPri(p) {
  if (!PRI.includes(p)) throw new TodoError('Invalid priority: ' + p);
  return p;
}
function vTags(t) {
  if (!Array.isArray(t) || t.some(x => typeof x !== 'string')) throw new TodoError('Tags must be an array of strings');
  return [...new Set(t.map(x => x.toLowerCase()))];
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
        let data;
        try { data = JSON.parse(raw); } catch { throw new TodoError('Corrupt storage file'); }
        this.items = Array.isArray(data) ? data : (data.items || []);
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
      id: this.nextId, title: vTitle(title), done: false, priority: vPri(priority),
      due: vDue(due), tags: vTags(tags), createdAt: new Date().toISOString(),
    };
    this.nextId++;
    this.items.push(item);
    this._save();
    return copy(item);
  }
  get(id) { return copy(this._find(id)); }
  update(id, patch) {
    const it = this._find(id);
    if (!patch || typeof patch !== 'object') throw new TodoError('Invalid patch');
    for (const k of Object.keys(patch)) if (!['title', 'due', 'priority', 'tags'].includes(k)) throw new TodoError('Unknown field: ' + k);
    const n = {};
    if ('title' in patch) n.title = vTitle(patch.title);
    if ('due' in patch) n.due = vDue(patch.due);
    if ('priority' in patch) n.priority = vPri(patch.priority);
    if ('tags' in patch) n.tags = vTags(patch.tags);
    Object.assign(it, n);
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
      if (tag != null && !i.tags.includes(String(tag).toLowerCase())) return false;
      if (priority != null && i.priority !== priority) return false;
      if (search != null && !i.title.toLowerCase().includes(String(search).toLowerCase())) return false;
      return true;
    });
    if (sort === 'due') {
      r.sort((a, b) => (a.due === b.due ? 0 : a.due === null ? 1 : b.due === null ? -1 : a.due < b.due ? -1 : 1) || a.id - b.id);
    } else if (sort === 'priority') {
      r.sort((a, b) => PRI.indexOf(b.priority) - PRI.indexOf(a.priority) || a.id - b.id);
    } else r.sort((a, b) => a.id - b.id);
    return r.map(copy);
  }
  stats(today = new Date().toISOString().slice(0, 10)) {
    const done = this.items.filter(i => i.done).length;
    const overdue = this.items.filter(i => !i.done && i.due !== null && i.due < today).length;
    return { total: this.items.length, open: this.items.length - done, done, overdue };
  }
}
