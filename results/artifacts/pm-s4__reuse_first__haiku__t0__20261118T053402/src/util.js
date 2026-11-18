import crypto from 'node:crypto';

export class HttpError extends Error {
  constructor(status, error, message) {
    super(message || error);
    this.status = status;
    this.error = error;
  }
}

export const bad = (m) => new HttpError(400, 'validation_error', m);
export const unauth = (m = 'Authentication required') => new HttpError(401, 'unauthenticated', m);
export const forbidden = (m = 'Forbidden') => new HttpError(403, 'forbidden', m);
export const notFound = (m = 'Not found') => new HttpError(404, 'not_found', m);
export const conflict = (m, code = 'conflict') => new HttpError(409, code, m);
export const newId = () => crypto.randomUUID();

export const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function reqStr(v, field, max = 1000) {
  if (typeof v !== 'string' || !v.trim()) throw bad(`${field} is required`);
  if (v.length > max) throw bad(`${field} is too long (max ${max})`);
  return v;
}

export function optStr(v, field, max = 1000) {
  if (v == null) return '';
  if (typeof v !== 'string') throw bad(`${field} must be a string`);
  if (v.length > max) throw bad(`${field} is too long (max ${max})`);
  return v;
}

export const isDate = (v) => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
};

export function readRaw(req, limit = 5e6) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'payload_too_large', 'Request body too large'));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function parseJson(raw) {
  if (!raw || !raw.trim()) return {};
  let v;
  try {
    v = JSON.parse(raw);
  } catch {
    throw bad('Invalid JSON body');
  }
  if (!isObj(v)) throw bad('JSON object body required');
  return v;
}
