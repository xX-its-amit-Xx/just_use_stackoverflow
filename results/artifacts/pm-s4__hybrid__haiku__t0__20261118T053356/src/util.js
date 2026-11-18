import crypto from 'node:crypto';

export const ISSUE_TYPES = ['bug', 'feature', 'task', 'epic', 'subtask'];
export const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'];
export const WS_ROLES = ['admin', 'member', 'guest'];
export const PROJ_ROLES = ['lead', 'developer', 'viewer'];
export const CATEGORIES = ['backlog', 'unstarted', 'started', 'completed'];
export const WEBHOOK_EVENTS = ['issue.created', 'issue.updated', 'issue.deleted', 'comment.created'];
export const PROJECT_KEY_RE = /^[A-Z]{2,10}$/;
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}
export const bad = (msg) => new HttpError(400, 'validation_error', msg);
export const unauthenticated = (msg = 'authentication required') => new HttpError(401, 'unauthenticated', msg);
export const forbidden = (msg = 'forbidden') => new HttpError(403, 'forbidden', msg);
export const notFound = (msg = 'not found') => new HttpError(404, 'not_found', msg);
export const conflict = (code, msg) => new HttpError(409, code, msg || code);

export const newId = () => crypto.randomUUID();
export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(pw, salt, 64).toString('hex');
  return `${salt}:${h}`;
}

export function verifyPassword(pw, stored) {
  const [salt, h] = String(stored).split(':');
  const actual = crypto.scryptSync(pw, salt, 64);
  const expected = Buffer.from(h, 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

export function validDate(s) {
  return typeof s === 'string' && DATE_RE.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
}

export function readBody(req, limit = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'payload_too_large', 'body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function sendJson(res, status, body) {
  if (body === undefined) {
    res.writeHead(status);
    res.end();
    return;
  }
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

export function sendError(res, status, code, message) {
  sendJson(res, status, { error: code, message });
}
