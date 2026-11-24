// Shared helpers: HTTP error type and atomic JSON file writes.
// writeFileAtomic is adapted from igembitsky/vibeops-tracker lib/store.mjs (MIT); see PROVENANCE.json.
import fs from 'node:fs';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

export const bad = (message) => new HttpError(400, 'validation_error', message);
export const unauthorized = (message = 'Authentication required') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'Forbidden') => new HttpError(403, 'forbidden', message);
export const notFound = (what = 'Resource') => new HttpError(404, 'not_found', `${what} not found`);
export const conflict = (message, code = 'conflict') => new HttpError(409, code, message);

export function writeFileAtomic(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}
