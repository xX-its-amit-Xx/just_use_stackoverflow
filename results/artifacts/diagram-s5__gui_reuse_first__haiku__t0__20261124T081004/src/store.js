// File-based persistence: users.json, one <id>.json metadata file per document and an
// append-only <id>.ops.jsonl op log per document.
import fs from 'node:fs';
import path from 'node:path';

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

function writeAtomic(file, text) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export class Store {
  constructor(dataDir) {
    this.dir = path.resolve(dataDir);
    this.docsDir = path.join(this.dir, 'docs');
    fs.mkdirSync(this.docsDir, { recursive: true });
    this.usersFile = path.join(this.dir, 'users.json');
    this.users = readJson(this.usersFile, { users: {}, tokens: {} });
  }

  saveUsers() {
    writeAtomic(this.usersFile, JSON.stringify(this.users, null, 2));
  }

  metaPath(id) {
    return path.join(this.docsDir, `${id}.json`);
  }

  opsPath(id) {
    return path.join(this.docsDir, `${id}.ops.jsonl`);
  }

  listDocIds() {
    return fs.readdirSync(this.docsDir)
      .filter(f => f.endsWith('.json'))
      .map(f => f.slice(0, -5));
  }

  readMeta(id) {
    return readJson(this.metaPath(id), null);
  }

  writeMeta(meta) {
    writeAtomic(this.metaPath(meta.id), JSON.stringify(meta));
  }

  deleteDoc(id) {
    for (const f of [this.metaPath(id), this.opsPath(id)]) {
      try { fs.unlinkSync(f); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
  }

  readOps(id) {
    let text;
    try {
      text = fs.readFileSync(this.opsPath(id), 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }
    return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
  }

  appendOps(id, envs) {
    if (!envs.length) return;
    fs.appendFileSync(this.opsPath(id), envs.map(e => JSON.stringify(e) + '\n').join(''));
  }
}
