// Public API of the core library (isomorphic, no DOM).
import { Document } from './document.js';
import { importDrawio as importDrawioXml } from './drawio.js';
import { snap as snapPoint } from './geometry.js';

export { DiagramError } from './errors.js';

export function createDocument({ id, actor } = {}) {
  return new Document({ id, actor });
}

export function fromJSON(json, { actor } = {}) {
  if (!json || typeof json !== 'object') throw new TypeError('fromJSON: object required');
  const doc = new Document({ id: json.id, actor });
  doc._load(json);
  return doc;
}

export function importDrawio(xml, opts) {
  return importDrawioXml(xml, opts);
}

export const snap = snapPoint;
