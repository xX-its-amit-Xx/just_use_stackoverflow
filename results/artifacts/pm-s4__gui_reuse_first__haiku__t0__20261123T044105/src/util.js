import crypto from 'node:crypto';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

export const bad = (message, code = 'validation_error') => new ApiError(400, code, message);

export const newId = () => crypto.randomUUID();

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export const randomToken = (prefix) => prefix + crypto.randomBytes(24).toString('base64url');

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  const expected = Buffer.from(hash || '', 'hex');
  const actual = crypto.scryptSync(password, salt || '', 64);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/** Returns the YYYY-MM-DD string if valid, otherwise null. */
export function parseDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const t = Date.parse(`${s}T00:00:00Z`);
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== s) return null;
  return s;
}

export const dayOf = (date) => date.toISOString().slice(0, 10);

export function addDays(day, n) {
  return dayOf(new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400000));
}
