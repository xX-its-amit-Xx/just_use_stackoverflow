export { DiagramError } from './errors.js';
export { createDocument, fromJSON, Document } from './document.js';
export { importDrawio } from './drawio.js';

const isNum = v => typeof v === 'number' && Number.isFinite(v);

// Snap a point ({x,y} or [x,y]) to a grid and/or to guide lines within `tolerance`.
// guides: array of {x} / {y} objects or numbers (treated as x), or {x:[...], y:[...]}.
// Returns the same shape as the input.
export function snap(point, { grid, guides, tolerance = 5 } = {}) {
  const isArr = Array.isArray(point);
  const x = isArr ? point[0] : point.x;
  const y = isArr ? point[1] : point.y;
  let sx = x, sy = y;
  if (isNum(grid) && grid > 0) {
    sx = Math.round(x / grid) * grid;
    sy = Math.round(y / grid) * grid;
  }
  const gx = [], gy = [];
  if (Array.isArray(guides)) {
    for (const g of guides) {
      if (isNum(g)) gx.push(g);
      else if (g && typeof g === 'object') {
        if (isNum(g.x)) gx.push(g.x);
        if (isNum(g.y)) gy.push(g.y);
      }
    }
  } else if (guides && typeof guides === 'object') {
    if (Array.isArray(guides.x)) gx.push(...guides.x.filter(isNum));
    if (Array.isArray(guides.y)) gy.push(...guides.y.filter(isNum));
  }
  const nearest = (v, list) => {
    let best = null, bestD = tolerance;
    for (const g of list) {
      const d = Math.abs(g - v);
      if (d <= bestD) { best = g; bestD = d; }
    }
    return best;
  };
  const nx = nearest(x, gx);
  const ny = nearest(y, gy);
  if (nx !== null) sx = nx;
  if (ny !== null) sy = ny;
  return isArr ? [sx, sy] : { x: sx, y: sy };
}
