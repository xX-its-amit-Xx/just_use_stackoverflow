import fs from 'node:fs';

export class TodoError extends Error {
  constructor(m) { super(m); this.name = 'TodoError'; }
}

const PRIOS = ['low', 'normal', 'high'];
const FIELDS = ['title', 'due', 'priority', 'tags'];

function vTitle(t) {
  if (typeof t !== 'string' || !t.trim()) throw new TodoError('Title must be a non-empty string');
  return t.trim();
}
function vDue(d) {
  if (d === undefined || d === null) return null;
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new TodoError('Invalid due date: ' + d);
  const [y, m, day] = d.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== day) throw new TodoError('Invalid due date: ' + d);
  return d;
}
function vPrio(p) {
  if (!PRIOS.includes(p)) throw new TodoError('Invalid priority: ' + p);
  return p;
}
function vTags(t) {
  if (!Array.isArray(t) || t.some(x => typeof x !== 'string')) throw new TodoError('Tags must be an array of strings');
  return [...new Set(t.map(x => x.toLowerCase()))];
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
        try { data = JSON.parse(raw); } catch { throw new TodoError('Corrupt todo file'); }
        if (Array.isArray(data)) this.items = data;
        else { this.items = data.items || []; this.nextId = data.nextId || 1; }
        for (const it of this.items) if (it.id >= this.nextId) this.nextId = it.id + 1;
      }
    }
  }
  _save() {
    if (!this.file) return;
    fs.writeFileSync(this.file, JSON.stringify({ nextId: this.nextId, items: this.items }, null, 2));
  }
  _find(id) {
    const it = this.items.find(i => i.id === id);
    if (!it) throw new TodoError('Unknown id: ' + id);
    return it;
  }
  _copy(it) { return { ...it, tags: [...it.tags] }; }
  add(title, { due, priority = 'normal', tags = [] } = {}) {
    const item = {
      id: this.nextId, title: vTitle(title), done: false, priority: vPrio(priority),
      due: vDue(due), tags: vTags(tags), createdAt: new Date().toISOString(),
    };
    this.nextId++;
    this.items.push(item);
    this._save();
    return this._copy(item);
  }
  get(id) { return this._copy(this._find(id)); }
  update(id, patch) {
    const it = this._find(id);
    if (!patch || typeof patch !== 'object') throw new TodoError('Invalid patch');
    for (const k of Object.keys(patch)) if (!FIELDS.includes(k)) throw new TodoError('Unknown field: ' + k);
    const n = {};
    if ('title' in patch) n.title = vTitle(patch.title);
    if ('due' in patch) n.due = vDue(patch.due);
    if ('priority' in patch) n.priority = vPrio(patch.priority);
    if ('tags' in patch) n.tags = vTags(patch.tags);
    Object.assign(it, n);
    this._save();
    return this._copy(it);
  }
  complete(id) { const it = this._find(id); it.done = true; this._save(); return this._copy(it); }
  reopen(id) { const it = this._find(id); it.done = false; this._save(); return this._copy(it); }
  remove(id) {
    const it = this._find(id);
    this.items = this.items.filter(i => i !== it);
    this._save();
    return this._copy(it);
  }
  clearCompleted() {
    const before = this.items.length;
    this.items = this.items.filter(i => !i.done);
    this._save();
    return before - this.items.length;
  }
  list({ status = 'all', tag, priority, search, sort = 'created' } = {}) {
    if (!['all', 'open', 'done'].includes(status)) throw new TodoError('Invalid status: ' + status);
    if (!['created', 'due', 'priority'].includes(sort)) throw new TodoError('Invalid sort: ' + sort);
    let r = this.items.filter(i => {
      if (status === 'open' && i.done) return false;
      if (status === 'done' && !i.done) return false;
      if (tag !== undefined && tag !== null && !i.tags.includes(String(tag).toLowerCase())) return false;
      if (priority !== undefined && priority !== null && i.priority !== priority) return false;
      if (search !== undefined && search !== null && !i.title.toLowerCase().includes(String(search).toLowerCase())) return false;
      return true;
    });
    const rank = { high: 0, normal: 1, low: 2 };
    r = r.slice();
    if (sort === 'created') r.sort((a, b) => a.id - b.id);
    else if (sort === 'due') r.sort((a, b) => (a.due === null) - (b.due === null) || (a.due && b.due && (a.due < b.due ? -1 : a.due > b.due ? 1 : 0)) || a.id - b.id);
    else r.sort((a, b) => rank[a.priority] - rank[b.priority] || a.id - b.id);
    return r.map(i => this._copy(i));
  }
  stats(today = new Date().toISOString().slice(0, 10)) {
    const total = this.items.length;
    const done = this.items.filter(i => i.done).length;
    const overdue = this.items.filter(i => !i.done && i.due !== null && i.due < today).length;
    return { total, open: total - done, done, overdue };
  }
}
