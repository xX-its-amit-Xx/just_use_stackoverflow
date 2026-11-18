// Password hashing with scrypt (node:crypto) and per-user random salts.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEYLEN = 64;

export function hashPassword(password) {
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, KEYLEN);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1], 'base64');
  const expected = Buffer.from(parts[2], 'base64');
  const actual = scryptSync(password, salt, expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
