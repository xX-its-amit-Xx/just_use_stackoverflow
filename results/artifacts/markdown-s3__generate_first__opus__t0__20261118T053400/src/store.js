// Persistent page store: one JSON file per data directory, written atomically.
import fs from 'node:fs';
import path from 'node:path';

export class Store {
  constructor(dataDir) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
    this.file = path.join(dataDir, 'wiki.json');
    this.pages = new Map();
    this.lastTs = 0;
    if (fs.existsSync(this.file)) {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const p of data.pages || []) {
        this.pages.set(p.slug, p);
        for (const h of p.history) this.lastTs = Math.max(this.lastTs, Date.parse(h.updatedAt) || 0);
      }
    }
  }

  now() {
    const t = Math.max(Date.now(), this.lastTs + 1);
    this.lastTs = t;
    return new Date(t).toISOString();
  }

  save() {
    const tmp = this.file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ pages: [...this.pages.values()] }));
    fs.renameSync(tmp, this.file);
  }

  get(slug) { return this.pages.get(slug) || null; }
  all() { return [...this.pages.values()]; }

  // Returns { page, created, changed }
  put(slug, { title, body, tags }) {
    const existing = this.pages.get(slug);
    if (!existing) {
      const ts = this.now();
      const page = { slug, title, body, tags, version: 1, createdAt: ts, updatedAt: ts,
        history: [{ version: 1, title, body, tags, updatedAt: ts }] };
      this.pages.set(slug, page);
      this.save();
      return { page, created: true, changed: true };
    }
    if (existing.title === title && existing.body === body && sameTags(existing.tags, tags)) {
      return { page: existing, created: false, changed: false };
    }
    return { page: this.addVersion(existing, { title, body, tags }), created: false, changed: true };
  }

  addVersion(page, { title, body, tags }) {
    const ts = this.now();
    page.version += 1;
    page.title = title; page.body = body; page.tags = tags; page.updatedAt = ts;
    page.history.push({ version: page.version, title, body, tags, updatedAt: ts });
    this.save();
    return page;
  }

  delete(slug) {
    const ok = this.pages.delete(slug);
    if (ok) this.save();
    return ok;
  }
}

function sameTags(a, b) {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}
