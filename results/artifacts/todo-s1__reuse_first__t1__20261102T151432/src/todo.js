import fs from 'node:fs';

export class TodoError extends Error {
  constructor(m) { super(m); this.name = 'TodoError'; }
}
const PRI = ['low', 'normal', 'high'];
const today = () => new Date().toISOString().slice(0, 10);

function vDue(d) {
  if (d === undefined || d === null) return null;
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new TodoError('Invalid due date');
  const dt = new Date(d + 'T00:00:00Z');
  if (isNaN(dt) || dt.toISOString().slice(0, 10) !== d) throw new TodoError('Invalid due date');
  return d;
}
function vTitle(t) {
  if (typeof t !== 'string' || !t.trim()) throw new TodoError('Title must be non-empty');
  return t.trim();
}
function vPri(p) {
  if (!PRI.includes(p)) throw new TodoError('Invalid priority');
  return p;
}
function vTags(t) {
  if (!Array.isArray(t) || t.some(x => typeof x !== 'string')) throw new TodoError('Invalid tags');
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
        let d;
        try { d = JSON.parse(raw); } catch { throw new TodoError('Corrupt storage file'); }
        this.items = Array.isArray(d) ? d : d.items || [];
        const max = this.items.reduce((m, i) => Math.max(m, i.id), 0);
        this.nextId = Math.max(max + 1, (!Array.isArray(d) && d.nextId) || 1);
      }
    }
  }
  _save() {
    if (this.file) fs.writeFileSync(this.file, JSON.stringify({ nextId: this.nextId, items: this.items }, null, 2));
  }
  _find(id) {
    const i = this.items.find(x => x.id === id);
    if (!i) throw new TodoError(`Unknown id: ${id}`);
    return i;
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
    for (const k of Object.keys(patch)) if (!['title', 'due', 'priority', 'tags'].includes(k)) throw new TodoError(`Unknown field: ${k}`);
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
    this.items = this.items.filter(x => x !== it);
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
    let r = this.items.filter(i =>
      (status === 'all' || (status === 'done') === i.done) &&
      (tag === undefined || i.tags.includes(String(tag).toLowerCase())) &&
      (priority === undefined || i.priority === priority) &&
      (search === undefined || i.title.toLowerCase().includes(String(search).toLowerCase())));
    const rank = { high: 0, normal: 1, low: 2 };
    r = r.slice().sort((a, b) => {
      if (sort === 'due') {
        if (a.due !== b.due) {
          if (a.due === null) return 1;
          if (b.due === null) return -1;
          return a.due < b.due ? -1 : 1;
        }
      } else if (sort === 'priority' && rank[a.priority] !== rank[b.priority]) return rank[a.priority] - rank[b.priority];
      return a.id - b.id;
    });
    return r.map(copy);
  }
  stats(t = today()) {
    const open = this.items.filter(i => !i.done);
    return {
      total: this.items.length, open: open.length, done: this.items.length - open.length,
      overdue: open.filter(i => i.due !== null && i.due < t).length,
    };
  }
}
