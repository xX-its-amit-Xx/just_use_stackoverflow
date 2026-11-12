import { DiagramDocument, fromJSON as docFromJSON } from './document.js';
import { importDrawio as importDrawioXml } from './drawio.js';
import { snap as snapPoint } from './geometry.js';

export { DiagramError } from './errors.js';

/** Creates an empty document with the default layer. */
export function createDocument(opts = {}) {
  return new DiagramDocument(opts);
}

/** Restores a document from toJSON() output (lossless, including merge state). */
export function fromJSON(json, opts = {}) {
  return docFromJSON(json, opts);
}

/** Imports uncompressed draw.io (mxGraph) XML. */
export function importDrawio(xml, opts = {}) {
  return importDrawioXml(xml, opts);
}

export function snap(point, opts = {}) {
  return snapPoint(point, opts);
}
