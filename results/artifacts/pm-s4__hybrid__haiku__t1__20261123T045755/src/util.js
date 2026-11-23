const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const isStr = (v) => typeof v === 'string';
export const isNonEmptyStr = (v) => typeof v === 'string' && v.trim().length > 0;

export function validDate(v) {
  if (!isStr(v) || !DATE_RE.test(v)) return false;
  const t = Date.parse(v + 'T00:00:00Z');
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === v;
}

// Inclusive list of YYYY-MM-DD strings from a to b (both UTC).
export function dayRange(a, b) {
  const out = [];
  const end = Date.parse(b + 'T00:00:00Z');
  for (let t = Date.parse(a + 'T00:00:00Z'); t <= end; t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}
