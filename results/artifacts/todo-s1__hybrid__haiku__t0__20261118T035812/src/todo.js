import fs from 'node:fs';
import path from 'node:path';

export class TodoError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TodoError';
  }
}

const PRIORITIES = ['low', 'normal', 'high'];
const STATUSES = ['all', 'open', 'done'];
const SORTS = ['created', 'due', 'priority'];
const PATCH_FIELDS = ['title', 'due', 'priority', 'tags'];
const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };

function validateTitle(title) {
  if (typeof title !== 'string' || title.trim() === '') {
    throw new TodoError('Title must be a non-empty string');
  }
  return title.trim();
}

function validateDue(due) {
  if (due === undefined || due === null) return null;
  if (typeof due !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(due)) {
    throw new TodoError(`Invalid due date: ${String(due)} (expected YYYY-MM-DD)`);
  }
  const [y, m, d] = due.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
    throw new TodoError(`Invalid due date: ${due}`);
  }
  return due;
}

function validatePriority(priority) {
  if (!PRIORITIES.includes(priority)) {
    throw new TodoError(`Invalid priority: ${String(priority)} (expected low, normal or high)`);
  }
  return priority;
}

function validateTags(tags) {
  if (!Array.isArray(tags)) throw new TodoError('Tags must be an array of strings');
  const out = [];
  for (const t of tags) {
    if (typeof t !== 'string' || t.trim() === '') {
      throw new TodoError('Each tag must be a non-empty string');
    }
    const norm = t.trim().toLowerCase();
    if (!out.includes(norm)) out.push(norm);
  }
  return out;
}

function validateId(id) {
  if (!Number.isInteger(id) || id <= 0) throw new TodoError(`Invalid id: ${String(id)}`);
  return id;
}

function todayString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function copy(item) {
  return { ...item, tags: [...item.tags] };
}

export class TodoStore {
  #file;
  #items = [];
  #nextId = 1;

  constructor({ file } = {}) {
    this.#file = file;
    if (file !== undefined && fs.existsSync(file)) this.#load(file);
  }

  #load(file) {
    const raw = fs.readFileSync(file, 'utf8');
    if (raw.trim() === '') return;
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      throw new TodoError(`Corrupt store file: ${file}`);
    }
    const items = Array.isArray(data) ? data : data && Array.isArray(data.items) ? data.items : null;
    if (!items) throw new TodoError(`Corrupt store file: ${file}`);
    this.#items = items.map((it) => ({ ...it, tags: [...(it.tags || [])] }));
    let next = data && !Array.isArray(data) && Number.isInteger(data.nextId) ? data.nextId : 1;
    for (const it of this.#items) next = Math.max(next, it.id + 1);
    this.#nextId = next;
  }

  #persist() {
    if (this.#file === undefined) return;
    const dir = path.dirname(path.resolve(this.#file));
    fs.mkdirSync(dir, { recursive: true });
    const payload = JSON.stringify({ nextId: this.#nextId, items: this.#items }, null, 2) + '\n';
    const tmp = `${this.#file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, payload);
    fs.renameSync(tmp, this.#file);
  }

  #find(id) {
    validateId(id);
    const item = this.#items.find((it) => it.id === id);
    if (!item) throw new TodoError(`Unknown id: ${id}`);
    return item;
  }

  add(title, { due, priority = 'normal', tags = [] } = {}) {
    const item = {
      id: this.#nextId,
      title: validateTitle(title),
      done: false,
      priority: validatePriority(priority),
      due: validateDue(due),
      tags: validateTags(tags),
      createdAt: new Date().toISOString(),
    };
    this.#nextId += 1;
    this.#items.push(item);
    this.#persist();
    return copy(item);
  }

  get(id) {
    return copy(this.#find(id));
  }

  update(id, patch) {
    const item = this.#find(id);
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new TodoError('Patch must be an object');
    }
    for (const key of Object.keys(patch)) {
      if (!PATCH_FIELDS.includes(key)) throw new TodoError(`Unknown field: ${key}`);
    }
    const changes = {};
    if ('title' in patch) changes.title = validateTitle(patch.title);
    if ('due' in patch) changes.due = validateDue(patch.due);
    if ('priority' in patch) changes.priority = validatePriority(patch.priority);
    if ('tags' in patch) changes.tags = validateTags(patch.tags);
    Object.assign(item, changes);
    this.#persist();
    return copy(item);
  }

  complete(id) {
    const item = this.#find(id);
    item.done = true;
    this.#persist();
    return copy(item);
  }

  reopen(id) {
    const item = this.#find(id);
    item.done = false;
    this.#persist();
    return copy(item);
  }

  remove(id) {
    const item = this.#find(id);
    this.#items = this.#items.filter((it) => it !== item);
    this.#persist();
    return copy(item);
  }

  clearCompleted() {
    const before = this.#items.length;
    this.#items = this.#items.filter((it) => !it.done);
    const removed = before - this.#items.length;
    this.#persist();
    return removed;
  }

  list({ status = 'all', tag, priority, search, sort = 'created' } = {}) {
    if (!STATUSES.includes(status)) throw new TodoError(`Invalid status: ${String(status)}`);
    if (!SORTS.includes(sort)) throw new TodoError(`Invalid sort: ${String(sort)}`);
    if (priority !== undefined) validatePriority(priority);
    const wantTag = tag === undefined ? undefined : String(tag).trim().toLowerCase();
    const needle = search === undefined ? undefined : String(search).toLowerCase();

    let out = this.#items.filter((it) => {
      if (status === 'open' && it.done) return false;
      if (status === 'done' && !it.done) return false;
      if (wantTag !== undefined && !it.tags.includes(wantTag)) return false;
      if (priority !== undefined && it.priority !== priority) return false;
      if (needle !== undefined && !it.title.toLowerCase().includes(needle)) return false;
      return true;
    });

    const byId = (a, b) => a.id - b.id;
    if (sort === 'created') {
      out.sort(byId);
    } else if (sort === 'due') {
      out.sort((a, b) => {
        if (a.due === b.due) return byId(a, b);
        if (a.due === null) return 1;
        if (b.due === null) return -1;
        return a.due < b.due ? -1 : 1;
      });
    } else {
      out.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || byId(a, b));
    }
    return out.map(copy);
  }

  stats(today = todayString()) {
    let open = 0;
    let done = 0;
    let overdue = 0;
    for (const it of this.#items) {
      if (it.done) {
        done += 1;
      } else {
        open += 1;
        if (it.due !== null && it.due < today) overdue += 1;
      }
    }
    return { total: this.#items.length, open, done, overdue };
  }
}
