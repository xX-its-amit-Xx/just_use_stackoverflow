import { Document } from './doc.js';
import { DiagramError } from './errors.js';
import { snap } from './geom.js';
import { importDrawio } from './drawio.js';

export function createDocument(opts = {}) { return new Document(opts); }
export function fromJSON(json, opts) { return Document.fromJSON(json, opts); }
export { importDrawio, snap, DiagramError };
