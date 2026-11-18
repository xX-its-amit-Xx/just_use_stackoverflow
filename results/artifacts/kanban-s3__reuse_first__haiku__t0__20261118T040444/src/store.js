// JSON file persistence. Writes go to a temp file that is then renamed over the target.
import fs from 'node:fs';
import path from 'node:path';

export function emptyData() {
  return { version: 1, users: [], boards: [], columns: [], cards: [], labels: [], comments: [], activity: [] };
}

export function loadData(file) {
  if (!file || !fs.existsSync(file)) return emptyData();
  const raw = fs.readFileSync(file, 'utf8');
  if (!raw.trim()) return emptyData();
  return { ...emptyData(), ...JSON.parse(raw) };
}

export function saveData(file, data) {
  if (!file) return;
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}
