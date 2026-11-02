import fs from 'node:fs';

export class TodoError extends Error {
  constructor(msg) { super(msg); this.name = 'TodoError'; }
}

const PRIORITIES = ['low', 'normal', 'high'];
const PRANK = { high: 0, normal: 1, low: 2 };

function checkDate(d) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new TodoError(`Invalid due date: ${d}`);
  const dt = new Date(d + 'T00:00:00Z');
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== d) throw new TodoError(`Invalid due date: ${d}`);
  return d;
}
function checkTitle(t) {
  if (typeof t !== 'string' || !t.trim()) throw new TodoError('Title must be a non-empty string');
  return t.trim();
}
function checkPriority(p) {
  if (!PRIORITIES.includes(p)) throw new TodoError(`Invalid priority: ${p}`);
  return p;
}
function checkTags(tags) {
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) throw new TodoError('Tags must be an array of strings');
  return [...new Set(tags.map((t) => t.toLowerCase()))];
}
const today = () => new Date().toISOString().slice(0, 10);

export class TodoStore {
  #file; #items = []; #nextId = 1;
  constructor({ file } = {}) {
    this.#file = file;
    if (file && fs.existsSync(file)) {
      const raw = fs.readFileSync(file, 'utf8');
      if (raw.trim()) {
        let data;
        try { data = JSON.parse(raw); } catch { throw new TodoError('Corrupt storage file'); }
        if (Array.isArray(data)) data = { items: data };
        this.#items = Array.isArray(data.items) ? data.items : [];
        const max = this.#items.reduce((m, i) => Math.max(m, i.id), 0);
        this.#nextId = Math.max(data.nextId || 1, max + 1);
      }
    }
  }
  #save() {
    if (this.#file) fs.writeFileSync(this.#file, JSON.stringify({ nextId: this.#nextId, items: this.#items }, null, 2));
  }
  #find(id) {
    const it = this.#items.find((i) => i.id === id);
    if (!it) throw new TodoError(`Unknown id: ${id}`);
    return it;
  }
  #copy(i) { return { ...i, tags: [...i.tags] }; }

  add(title, { due, priority = 'normal', tags = [] } = {}) {
    const item = {
      id: this.#nextId, title: checkTitle(title), done: false, priority: checkPriority(priority),
      due: due == null ? null : checkDate(due), tags: checkTags(tags), createdAt: new Date().toISOString(),
    };
    this.#nextId++;
    this.#items.push(item);
    this.#save();
    return this.#copy(item);
  }
  get(id) { return this.#copy(this.#find(id)); }
  update(id, patch) {
    const it = this.#find(id);
    if (patch === null || typeof patch !== 'object') throw new TodoError('Invalid patch');
    const allowed = ['title', 'due', 'priority', 'tags'];
    for (const k of Object.keys(patch)) if (!allowed.includes(k)) throw new TodoError(`Unknown field: ${k}`);
    const next = {};
    if ('title' in patch) next.title = checkTitle(patch.title);
    if ('due' in patch) next.due = patch.due == null ? null : checkDate(patch.due);
    if ('priority' in patch) next.priority = checkPriority(patch.priority);
    if ('tags' in patch) next.tags = checkTags(patch.tags);
    Object.assign(it, next);
    this.#save();
    return this.#copy(it);
  }
  complete(id) { const it = this.#find(id); it.done = true; this.#save(); return this.#copy(it); }
  reopen(id) { const it = this.#find(id); it.done = false; this.#save(); return this.#copy(it); }
  remove(id) {
    const it = this.#find(id);
    this.#items = this.#items.filter((i) => i !== it);
    this.#save();
    return this.#copy(it);
  }
  clearCompleted() {
    const n = this.#items.filter((i) => i.done).length;
    this.#items = this.#items.filter((i) => !i.done);
    this.#save();
    return n;
  }
  list({ status = 'all', tag, priority, search, sort = 'created' } = {}) {
    if (!['all', 'open', 'done'].includes(status)) throw new TodoError(`Invalid status: ${status}`);
    if (!['created', 'due', 'priority'].includes(sort)) throw new TodoError(`Invalid sort: ${sort}`);
    let r = this.#items.filter((i) => {
      if (status === 'open' && i.done) return false;
      if (status === 'done' && !i.done) return false;
      if (tag != null && !i.tags.includes(String(tag).toLowerCase())) return false;
      if (priority != null && i.priority !== priority) return false;
      if (search != null && !i.title.toLowerCase().includes(String(search).toLowerCase())) return false;
      return true;
    });
    r = r.slice().sort((a, b) => {
      if (sort === 'due') {
        if (a.due === b.due) return a.id - b.id;
        if (a.due === null) return 1;
        if (b.due === null) return -1;
        return a.due < b.due ? -1 : 1;
      }
      if (sort === 'priority' && PRANK[a.priority] !== PRANK[b.priority]) return PRANK[a.priority] - PRANK[b.priority];
      return a.id - b.id;
    });
    return r.map((i) => this.#copy(i));
  }
  stats(t = today()) {
    const open = this.#items.filter((i) => !i.done);
    return {
      total: this.#items.length, open: open.length, done: this.#items.length - open.length,
      overdue: open.filter((i) => i.due !== null && i.due < t).length,
    };
  }
}
