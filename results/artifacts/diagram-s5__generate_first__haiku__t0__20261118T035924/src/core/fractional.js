// Fractional indices for z-order. Keys are strings over a base-62 alphabet whose
// ASCII order matches the digit order, so plain string comparison orders them.
// Keys never end in '0', which keeps the representation canonical.

const ALPHA = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = ALPHA.length;
const IDX = new Map([...ALPHA].map((c, i) => [c, i]));

// a: lower bound ('' = minimum), b: upper bound (null = maximum); requires a < b.
function midKey(a, b) {
  let r = '';
  for (let i = 0; ; i++) {
    const da = i < a.length ? IDX.get(a[i]) : 0;
    const db = b === null ? BASE : i < b.length ? IDX.get(b[i]) : 0;
    if (da === db) {
      r += ALPHA[da];
      continue;
    }
    if (db - da > 1) return r + ALPHA[(da + db) >> 1];
    // db === da + 1: take da and find something above the rest of a.
    return r + ALPHA[da] + midKey(a.slice(i + 1), null);
  }
}

/** Returns a key strictly between lo and hi (null lo = min, null hi = max). */
export function keyBetween(lo = null, hi = null) {
  const a = lo ?? '';
  if (hi !== null && hi !== undefined && a >= hi) {
    throw new RangeError('keyBetween: lower key must be below upper key');
  }
  return midKey(a, hi ?? null);
}
