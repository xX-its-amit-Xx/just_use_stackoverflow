import fs from 'node:fs';

export class TodoError extends Error {
  constructor(m) { super(m); this.name = 'TodoError'; }
}
const PRI = ['low', 'normal', 'high'];

function vTitle(t) {
  if (typeof t !== 'string' || !t.trim()) throw new TodoError('title must be a non-empty string');
  return t.trim();
}
function vDue(d) {
  if (d === undefined || d === null) return null;
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new TodoError('due must be YYYY-MM-DD');
  const [y, m, day] = d.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== day) throw new TodoError('invalid date');
  return d;
}
function vPri(p) {
  if (!PRI.includes(p)) throw new TodoError('invalid priority');
  return p;
}
function vTags(t) {
  if (!Array.isArray(t) || t.some(x => typeof x !== 'string')) throw new TodoError('tags must be an array of strings');
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
        if (Array.isArray(data)) this.items = data;
        else { this.items = data.items || []; this.nextId = data.nextId || 1; }
        for (const i of this.items) if (i.id >= this.nextId) this.nextId = i.id + 1;
      }
    }
  }
  _save() {
    if (this.file) fs.writeFileSync(this.file, JSON.stringify({ nextId: this.nextId, items: this.items }, null, 2));
  }
  _find(id) {
    const it = this.items.find(i => i.id === id);
    if (!it) throw new TodoError(`unknown id: ${id}`);
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
    return { ...item, tags: [...item.tags] };
  }
  get(id) { const i = this._find(id); return { ...i, tags: [...i.tags] }; }
  update(id, patch) {
    const it = this._find(id);
    if (!patch || typeof patch !== 'object') throw new TodoError('invalid patch');
    for (const k of Object.keys(patch)) if (!['title', 'due', 'priority', 'tags'].includes(k)) throw new TodoError(`unknown field: ${k}`);
    const n = {};
    if ('title' in patch) n.title = vTitle(patch.title);
    if ('due' in patch) n.due = vDue(patch.due);
    if ('priority' in patch) n.priority = vPri(patch.priority);
    if ('tags' in patch) n.tags = vTags(patch.tags);
    Object.assign(it, n);
    this._save();
    return this.get(id);
  }
  complete(id) { const it = this._find(id); it.done = true; this._save(); return this.get(id); }
  reopen(id) { const it = this._find(id); it.done = false; this._save(); return this.get(id); }
  remove(id) {
    const it = this._find(id);
    this.items = this.items.filter(i => i !== it);
    this._save();
    return { ...it, tags: [...it.tags] };
  }
  clearCompleted() {
    const n = this.items.filter(i => i.done).length;
    this.items = this.items.filter(i => !i.done);
    this._save();
    return n;
  }
  list({ status = 'all', tag, priority, search, sort = 'created' } = {}) {
    if (!['all', 'open', 'done'].includes(status)) throw new TodoError('invalid status');
    if (!['created', 'due', 'priority'].includes(sort)) throw new TodoError('invalid sort');
    let r = this.items.filter(i => {
      if (status === 'open' && i.done) return false;
      if (status === 'done' && !i.done) return false;
      if (tag !== undefined && tag !== null && !i.tags.includes(String(tag).toLowerCase())) return false;
      if (priority !== undefined && priority !== null && i.priority !== priority) return false;
      if (search !== undefined && search !== null && !i.title.toLowerCase().includes(String(search).toLowerCase())) return false;
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
      } else if (sort === 'priority') {
        if (rank[a.priority] !== rank[b.priority]) return rank[a.priority] - rank[b.priority];
      }
      return a.id - b.id;
    });
    return r.map(i => ({ ...i, tags: [...i.tags] }));
  }
  stats(today = new Date().toISOString().slice(0, 10)) {
    const total = this.items.length;
    const done = this.items.filter(i => i.done).length;
    const overdue = this.items.filter(i => !i.done && i.due !== null && i.due < today).length;
    return { total, open: total - done, done, overdue };
  }
}
