// Public entry point of the framework-free core library (isomorphic, no DOM).
export { createDocument, fromJSON, Document, SHAPE_TYPES } from './document.js';
export { importDrawio } from './drawio.js';
export { snap } from './geometry.js';
export { DiagramError } from './errors.js';
export { toSVG } from './svg.js';
export { keyBetween } from './fractional.js';
