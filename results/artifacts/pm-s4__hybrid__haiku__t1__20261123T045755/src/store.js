import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function emptyState() {
  return {
    users: [], tokens: [], loginFailures: {},
    workspaces: [], projects: [], issues: [], history: [], links: [], comments: [],
    sprints: [], notifications: [], audit: [], webhooks: [], deliveries: [],
  };
}

export function loadState(file) {
  if (!file || !existsSync(file)) return emptyState();
  return { ...emptyState(), ...JSON.parse(readFileSync(file, 'utf8')) };
}

export function saveState(file, state) {
  if (!file) return;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(state));
  renameSync(tmp, file);
}
