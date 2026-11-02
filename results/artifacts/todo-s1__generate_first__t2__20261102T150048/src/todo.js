import fs from 'node:fs';

export class TodoError extends Error {
  constructor(msg) { super(msg); this.name = 'TodoError'; }
}

const PRIOS = ['low', 'normal', 'high'];
const PRANK = { high: 0, normal: 1, low: 2 };

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
    this.file = file;
    this.items = [];
    this.nextId = 1;
    if (file && fs.existsSync(file)) {
      const txt = fs.readFileSync(file, 'utf8');
      if (txt.trim()) {
        let data;
        try { data = JSON.parse(txt); } catch { throw new TodoError('Corrupt storage file'); }
        if (Array.isArray(data)) this.items = data;
        else { this.items = data.items || []; this.nextId = data.nextId || 1; }
        const max = this.items.reduce((m, i) => Math.max(m, i.id), 0);
        if (this.nextId <= max) this.nextId = max + 1;
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
  _copy(i) { return { ...i, tags: [...i.tags] }; }
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
    const allowed = ['title', 'due', 'priority', 'tags'];
    for (const k of Object.keys(patch)) if (!allowed.includes(k)) throw new TodoError('Unknown field: ' + k);
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
    r.sort((a, b) => {
      if (sort === 'due') {
        if (a.due === b.due) return a.id - b.id;
        if (a.due === null) return 1;
        if (b.due === null) return -1;
        return a.due < b.due ? -1 : 1;
      }
      if (sort === 'priority' && PRANK[a.priority] !== PRANK[b.priority]) return PRANK[a.priority] - PRANK[b.priority];
      return a.id - b.id;
    });
    return r.map(i => this._copy(i));
  }
  stats(today = new Date().toISOString().slice(0, 10)) {
    const done = this.items.filter(i => i.done).length;
    const overdue = this.items.filter(i => !i.done && i.due !== null && i.due < today).length;
    return { total: this.items.length, open: this.items.length - done, done, overdue };
  }
}
