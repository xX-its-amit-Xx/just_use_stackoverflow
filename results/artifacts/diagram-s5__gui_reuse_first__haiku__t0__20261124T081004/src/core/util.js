export const SHAPE_TYPES = ['rect', 'ellipse', 'diamond', 'text', 'image', 'line'];
export const CONNECTOR = 'connector';

export function clone(v) {
  if (v === undefined) return undefined;
  return JSON.parse(JSON.stringify(v));
}

// Timestamps are [lamport, actor]; compare lexicographically.
export function cmpTs(a, b) {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] === b[1]) return 0;
  return a[1] < b[1] ? -1 : 1;
}

export function randomId(prefix = '') {
  const r = globalThis.crypto && globalThis.crypto.randomUUID
    ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12)
    : Math.random().toString(36).slice(2, 14);
  return prefix + r;
}

export function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

export function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function sortObj(o) {
  const out = {};
  for (const k of Object.keys(o).sort()) out[k] = o[k];
  return out;
}
