// JSON-file persistence for the whole application state.
import fs from 'node:fs';
import path from 'node:path';

export function emptyDb() {
  return {
    seq: 0,
    users: [],
    sessions: [],
    apiTokens: [],
    loginFailures: {},
    workspaces: [],
    projects: [],
    issues: [],
    history: [],
    links: [],
    comments: [],
    notifications: [],
    sprints: [],
    webhooks: [],
    deliveries: [],
    audit: [],
  };
}

export function loadDb(file) {
  if (!file) return emptyDb();
  try {
    return { ...emptyDb(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    if (err.code === 'ENOENT') return emptyDb();
    throw err;
  }
}

export function saveDb(file, db) {
  if (!file) return;
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, file);
}
