import fs from 'node:fs';
import path from 'node:path';

export function emptyState() {
  return {
    users: [], sessions: [], apiTokens: [],
    workspaces: [], workspaceMembers: [],
    projects: [], projectMembers: [],
    issues: [], history: [], links: [], comments: [], sprints: [],
    notifications: [], webhooks: [], deliveries: [], audit: [],
  };
}

export function loadState(file) {
  if (!file || !fs.existsSync(file)) return emptyState();
  return { ...emptyState(), ...JSON.parse(fs.readFileSync(file, 'utf8')) };
}

export function saveState(file, state) {
  if (!file) return;
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, file);
}
