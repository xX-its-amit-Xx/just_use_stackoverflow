import fs from 'node:fs';
import path from 'node:path';

export class TodoError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TodoError';
  }
}

const PRIORITIES = ['low', 'normal', 'high'];
const PRIORITY_RANK = { high: 0, normal: 1, low: 2 };
const STATUSES = ['all', 'open', 'done'];
const SORTS = ['created', 'due', 'priority'];
const PATCH_FIELDS = ['title', 'due', 'priority', 'tags'];

function isValidDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function localToday() {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function validateTitle(title) {
  if (typeof title !== 'string' || title.trim() === '') {
    throw new TodoError('title must be a non-empty string');
  }
  return title.trim();
}

function validateDue(due) {
  if (due === undefined || due === null) return null;
  if (!isValidDate(due)) {
    throw new TodoError(`due must be a valid date in YYYY-MM-DD format: ${String(due)}`);
  }
  return due;
}

function validatePriority(priority) {
  if (!PRIORITIES.includes(priority)) {
    throw new TodoError(`priority must be one of ${PRIORITIES.join(', ')}: ${String(priority)}`);
  }
  return priority;
}

function validateTags(tags) {
  if (!Array.isArray(tags)) throw new TodoError('tags must be an array of strings');
  const out = [];
  for (const tag of tags) {
    if (typeof tag !== 'string' || tag.trim() === '') {
      throw new TodoError('each tag must be a non-empty string');
    }
    const t = tag.trim().toLowerCase();
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

function copyItem(item) {
  return { ...item, tags: [...item.tags] };
}

function validateId(id) {
  if (!Number.isInteger(id) || id <= 0) {
    throw new TodoError(`invalid id: ${String(id)}`);
  }
  return id;
}

export class TodoStore {
  #file;
  #items = [];
  #nextId = 1;

  constructor({ file } = {}) {
    this.#file = file;
    if (file !== undefined && fs.existsSync(file)) {
      this.#load(file);
    }
  }

  #load(file) {
    let data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new TodoError(`cannot read store file ${file}: ${err.message}`);
    }
    let items;
    let storedNext = 1;
    if (Array.isArray(data)) {
      items = data;
    } else if (data && typeof data === 'object' && Array.isArray(data.items)) {
      items = data.items;
      if (Number.isInteger(data.nextId) && data.nextId > 0) storedNext = data.nextId;
    } else {
      throw new TodoError(`invalid store file ${file}`);
    }
    let maxId = 0;
    for (const raw of items) {
      if (!raw || typeof raw !== 'object' || !Number.isInteger(raw.id) || raw.id <= 0) {
        throw new TodoError(`invalid item in store file ${file}`);
      }
      maxId = Math.max(maxId, raw.id);
      this.#items.push({
        id: raw.id,
        title: String(raw.title),
        done: raw.done === true,
        priority: PRIORITIES.includes(raw.priority) ? raw.priority : 'normal',
        due: typeof raw.due === 'string' ? raw.due : null,
        tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
        createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date(0).toISOString(),
      });
    }
    this.#nextId = Math.max(storedNext, maxId + 1);
  }

  #persist() {
    if (this.#file === undefined) return;
    const dir = path.dirname(this.#file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.#file}.${process.pid}.tmp`;
    const body = JSON.stringify({ nextId: this.#nextId, items: this.#items }, null, 2) + '\n';
    fs.writeFileSync(tmp, body, 'utf8');
    fs.renameSync(tmp, this.#file);
  }

  #find(id) {
    validateId(id);
    const item = this.#items.find((i) => i.id === id);
    if (!item) throw new TodoError(`unknown id: #${id}`);
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
    return copyItem(item);
  }

  get(id) {
    return copyItem(this.#find(id));
  }

  update(id, patch) {
    const item = this.#find(id);
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new TodoError('patch must be an object');
    }
    const changes = {};
    for (const key of Object.keys(patch)) {
      if (!PATCH_FIELDS.includes(key)) throw new TodoError(`unknown field: ${key}`);
    }
    if ('title' in patch) changes.title = validateTitle(patch.title);
    if ('due' in patch) changes.due = validateDue(patch.due);
    if ('priority' in patch) changes.priority = validatePriority(patch.priority);
    if ('tags' in patch) changes.tags = validateTags(patch.tags);
    Object.assign(item, changes);
    this.#persist();
    return copyItem(item);
  }

  complete(id) {
    const item = this.#find(id);
    item.done = true;
    this.#persist();
    return copyItem(item);
  }

  reopen(id) {
    const item = this.#find(id);
    item.done = false;
    this.#persist();
    return copyItem(item);
  }

  remove(id) {
    const item = this.#find(id);
    this.#items = this.#items.filter((i) => i !== item);
    this.#persist();
    return copyItem(item);
  }

  clearCompleted() {
    const before = this.#items.length;
    this.#items = this.#items.filter((i) => !i.done);
    const removed = before - this.#items.length;
    this.#persist();
    return removed;
  }

  list({ status = 'all', tag, priority, search, sort = 'created' } = {}) {
    if (!STATUSES.includes(status)) throw new TodoError(`invalid status: ${String(status)}`);
    if (!SORTS.includes(sort)) throw new TodoError(`invalid sort: ${String(sort)}`);
    if (priority !== undefined) validatePriority(priority);

    let items = this.#items.filter((i) => {
      if (status === 'open' && i.done) return false;
      if (status === 'done' && !i.done) return false;
      if (tag !== undefined && !i.tags.includes(String(tag).toLowerCase())) return false;
      if (priority !== undefined && i.priority !== priority) return false;
      if (search !== undefined && !i.title.toLowerCase().includes(String(search).toLowerCase())) {
        return false;
      }
      return true;
    });

    if (sort === 'created') {
      items.sort((a, b) => a.id - b.id);
    } else if (sort === 'due') {
      items.sort((a, b) => {
        if (a.due === b.due) return a.id - b.id;
        if (a.due === null) return 1;
        if (b.due === null) return -1;
        return a.due < b.due ? -1 : 1;
      });
    } else {
      items.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.id - b.id);
    }
    return items.map(copyItem);
  }

  stats(today = localToday()) {
    if (!isValidDate(today)) throw new TodoError(`invalid date: ${String(today)}`);
    let open = 0;
    let done = 0;
    let overdue = 0;
    for (const i of this.#items) {
      if (i.done) {
        done += 1;
      } else {
        open += 1;
        if (i.due !== null && i.due < today) overdue += 1;
      }
    }
    return { total: this.#items.length, open, done, overdue };
  }
}
