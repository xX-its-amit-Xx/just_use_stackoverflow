// Shared error type and input validators.

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message ?? code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export const badRequest = (m = 'invalid request') => new HttpError(400, 'validation', m);
export const unauthorized = (m = 'authentication required') => new HttpError(401, 'unauthorized', m);
export const forbidden = (m = 'forbidden') => new HttpError(403, 'forbidden', m);
export const notFound = (m = 'not found') => new HttpError(404, 'not_found', m);
export const conflict = (m = 'conflict', code = 'conflict') => new HttpError(409, code, m);
export const rateLimited = (m = 'too many requests') => new HttpError(429, 'rate_limited', m);

export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
export const nowIso = () => new Date().toISOString();

export function requireString(v, label, min, max) {
  if (typeof v !== 'string') throw badRequest(`${label} must be a string`);
  const t = v.trim();
  if (t.length < min || t.length > max) throw badRequest(`${label} must be ${min}-${max} characters`);
  return t;
}

export function parseDescription(v) {
  if (v === undefined || v === null) return '';
  if (typeof v !== 'string' || v.length > 10000) throw badRequest('description must be a string of at most 10000 characters');
  return v;
}

export function parseWip(v) {
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v) || v < 1) throw badRequest('wipLimit must be a positive integer or null');
  return v;
}

export function parseDate(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw badRequest('dueDate must be YYYY-MM-DD or null');
  const d = new Date(`${v}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v) throw badRequest('dueDate is not a valid date');
  return v;
}

// Optional integer position; null when absent.
export function parseIndex(v) {
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v)) throw badRequest('position must be an integer');
  return v;
}
