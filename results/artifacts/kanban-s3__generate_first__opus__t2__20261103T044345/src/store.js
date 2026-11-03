import fs from 'node:fs';
import path from 'node:path';

const KEYS = ['users', 'boards', 'columns', 'cards', 'labels', 'comments', 'activity'];

export function createStore(dataFile) {
  const data = {};
  for (const k of KEYS) data[k] = new Map();
  if (dataFile && fs.existsSync(dataFile)) {
    let raw = '';
    try { raw = fs.readFileSync(dataFile, 'utf8'); } catch { raw = ''; }
    if (raw.trim()) {
      const parsed = JSON.parse(raw);
      for (const k of KEYS) {
        for (const item of parsed[k] || []) data[k].set(item.id, item);
      }
    }
  }
  function save() {
    if (!dataFile) return;
    const out = {};
    for (const k of KEYS) out[k] = [...data[k].values()];
    const dir = path.dirname(path.resolve(dataFile));
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${dataFile}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(out));
    fs.renameSync(tmp, dataFile);
  }
  return { data, save };
}
