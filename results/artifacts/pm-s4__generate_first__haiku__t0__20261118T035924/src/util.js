import { randomUUID, randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';

export class ApiError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

export const bad = (m) => new ApiError(400, 'validation', m);
export const notFound = (m = 'not found') => new ApiError(404, 'not_found', m);
export const forbidden = (m = 'forbidden') => new ApiError(403, 'forbidden', m);
export const conflict = (m = 'conflict') => new ApiError(409, 'conflict', m);

export const newId = () => randomUUID();
export const randomToken = () => 'pmt_' + randomBytes(32).toString('base64url');
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

export function hashPassword(pw) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pw, salt, 64).toString('hex')}`;
}

export function verifyPassword(pw, stored) {
  const [salt, hex] = String(stored).split(':');
  if (!salt || !hex) return false;
  const actual = scryptSync(pw, salt, 64);
  const expected = Buffer.from(hex, 'hex');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'];
export const ISSUE_TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
export const WS_ROLES = ['admin', 'member', 'guest'];
export const PROJECT_ROLES = ['lead', 'developer', 'viewer'];
export const CATEGORIES = ['backlog', 'unstarted', 'started', 'completed'];
export const LINK_TYPES = ['blocks', 'relates', 'duplicates'];
export const EVENTS = ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'];

export function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function reqStr(v, name, max) {
  if (typeof v !== 'string' || !v.trim()) throw bad(`${name} is required`);
  const t = v.trim();
  if (t.length > max) throw bad(`${name} is too long`);
  return t;
}

export function optStr(v, name, max) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw bad(`${name} must be a string`);
  if (v.length > max) throw bad(`${name} is too long`);
  return v;
}

export function reqPassword(v) {
  if (typeof v !== 'string' || v.length < 8) throw bad('password must be at least 8 characters');
  if (v.length > 200) throw bad('password is too long');
  return v;
}

export function pick(v, list, name) {
  if (!list.includes(v)) throw bad(`invalid ${name}`);
  return v;
}
