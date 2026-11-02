import fs from 'node:fs';

export class TodoError extends Error {
  constructor(m) { super(m); this.name = 'TodoError'; }
}
const PRI = ['low', 'normal', 'high'];
const PORD = { high: 0, normal: 1, low: 2 };

function vTitle(t) {
  if (typeof t !== 'string' || !t.trim()) throw new TodoError('Title must be a non-empty string');
  return t.trim();
}
function vDue(d) {
  if (d === undefined || d === null) return null;
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new TodoError('Invalid due date');
  const [y, m, day] = d.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== day) throw new TodoError('Invalid due date');
  return d;
}
function vPri(p) {
  if (!PRI.includes(p)) throw new TodoError('Invalid priority');
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
        if (Array.isArray(data)) data = { items: data };
        this.items = Array.isArray(data.items) ? data.items : [];
        const max = this.items.reduce((a, i) => Math.max(a, i.id), 0);
        this.nextId = Math.max(data.nextId || 1, max + 1);
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
    const allowed = ['title', 'due', 'priority', 'tags'];
    for (const k of Object.keys(patch)) if (!allowed.includes(k)) throw new TodoError(`Unknown field: ${k}`);
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
    if (!['all', 'open', 'done'].includes(status)) throw new TodoError('Invalid status');
    if (!['created', 'due', 'priority'].includes(sort)) throw new TodoError('Invalid sort');
    let r = this.items.slice();
    if (status === 'open') r = r.filter(i => !i.done);
    if (status === 'done') r = r.filter(i => i.done);
    if (tag !== undefined && tag !== null) { const t = String(tag).toLowerCase(); r = r.filter(i => i.tags.includes(t)); }
    if (priority !== undefined && priority !== null) r = r.filter(i => i.priority === priority);
    if (search !== undefined && search !== null) { const s = String(search).toLowerCase(); r = r.filter(i => i.title.toLowerCase().includes(s)); }
    if (sort === 'due') r.sort((a, b) => (a.due === b.due ? 0 : a.due === null ? 1 : b.due === null ? -1 : a.due < b.due ? -1 : 1) || a.id - b.id);
    else if (sort === 'priority') r.sort((a, b) => PORD[a.priority] - PORD[b.priority] || a.id - b.id);
    else r.sort((a, b) => a.id - b.id);
    return r.map(copy);
  }
  stats(today = new Date().toISOString().slice(0, 10)) {
    const done = this.items.filter(i => i.done).length;
    const overdue = this.items.filter(i => !i.done && i.due && i.due < today).length;
    return { total: this.items.length, open: this.items.length - done, done, overdue };
  }
}
