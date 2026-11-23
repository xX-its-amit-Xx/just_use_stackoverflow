// Rotation-aware geometry helpers. Pure functions, no DOM.
import { DiagramError } from './errors.js';

const DEG = Math.PI / 180;
const EPS = 1e-9;

export function center(el) {
  return [el.x + el.width / 2, el.y + el.height / 2];
}

export function rotatePoint([x, y], deg, [cx, cy]) {
  const t = (deg || 0) * DEG;
  const c = Math.cos(t);
  const s = Math.sin(t);
  const dx = x - cx;
  const dy = y - cy;
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
}

export function corners(el) {
  const c = center(el);
  const pts = [
    [el.x, el.y],
    [el.x + el.width, el.y],
    [el.x + el.width, el.y + el.height],
    [el.x, el.y + el.height],
  ];
  return el.rotation ? pts.map((p) => rotatePoint(p, el.rotation, c)) : pts;
}

// Axis-aligned bounding box of the (rotated) shape.
export function aabb(el) {
  const pts = corners(el);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function containsPoint(el, px, py) {
  const c = center(el);
  const [lx, ly] = rotatePoint([px, py], -(el.rotation || 0), c);
  const dx = lx - c[0];
  const dy = ly - c[1];
  const a = el.width / 2;
  const b = el.height / 2;
  switch (el.type) {
    case 'ellipse':
      return (dx * dx) / ((a || EPS) ** 2) + (dy * dy) / ((b || EPS) ** 2) <= 1;
    case 'diamond':
      return Math.abs(dx) / (a || EPS) + Math.abs(dy) / (b || EPS) <= 1;
    case 'line': {
      const ax = el.x;
      const ay = el.y;
      const bx = el.x + el.width;
      const by = el.y + el.height;
      const vx = bx - ax;
      const vy = by - ay;
      const len2 = vx * vx + vy * vy;
      let t = len2 > 0 ? ((lx - ax) * vx + (ly - ay) * vy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const qx = ax + t * vx - lx;
      const qy = ay + t * vy - ly;
      return Math.hypot(qx, qy) <= 4;
    }
    default:
      return Math.abs(dx) <= a + EPS && Math.abs(dy) <= b + EPS;
  }
}

// Point where the ray from the shape centre towards p leaves the shape outline.
export function boundaryPoint(el, p) {
  const c = center(el);
  const [lx, ly] = rotatePoint(p, -(el.rotation || 0), c);
  const dx = lx - c[0];
  const dy = ly - c[1];
  if (Math.abs(dx) < EPS && Math.abs(dy) < EPS) return c;
  const a = el.width / 2;
  const b = el.height / 2;
  let t;
  if (el.type === 'ellipse') {
    t = 1 / Math.sqrt((dx * dx) / ((a || EPS) ** 2) + (dy * dy) / ((b || EPS) ** 2));
  } else if (el.type === 'diamond') {
    t = 1 / (Math.abs(dx) / (a || EPS) + Math.abs(dy) / (b || EPS));
  } else {
    const tx = Math.abs(dx) > EPS ? a / Math.abs(dx) : Infinity;
    const ty = Math.abs(dy) > EPS ? b / Math.abs(dy) : Infinity;
    t = Math.min(tx, ty);
  }
  return rotatePoint([c[0] + dx * t, c[1] + dy * t], el.rotation || 0, c);
}

const PORTS = {
  n: [0, -0.5], north: [0, -0.5],
  e: [0.5, 0], east: [0.5, 0],
  s: [0, 0.5], south: [0, 0.5],
  w: [-0.5, 0], west: [-0.5, 0],
  center: [0, 0], c: [0, 0],
};

export function portPoint(el, port) {
  const off = PORTS[port];
  if (!off) return null;
  const c = center(el);
  const p = [c[0] + off[0] * el.width, c[1] + off[1] * el.height];
  return el.rotation ? rotatePoint(p, el.rotation, c) : p;
}

// Axis-parallel segment (x1,y1)-(x2,y2) passes through the strict interior of rect r.
export function segmentCrossesInterior(x1, y1, x2, y2, r) {
  if (x1 === x2) {
    const x = x1;
    return x > r.l && x < r.r && Math.max(Math.min(y1, y2), r.t) < Math.min(Math.max(y1, y2), r.b);
  }
  const y = y1;
  return y > r.t && y < r.b && Math.max(Math.min(x1, x2), r.l) < Math.min(Math.max(x1, x2), r.r);
}

// Snap a point ({x,y} or [x,y]) to a grid and/or guide lines.
// opts.grid: number; opts.guides: number[] (both axes) or {x:number[], y:number[]}; opts.tolerance: px.
export function snap(point, opts = {}) {
  if (!point || typeof point !== 'object') throw new DiagramError('point required');
  const isArr = Array.isArray(point);
  const x = isArr ? point[0] : point.x;
  const y = isArr ? point[1] : point.y;
  const tol = opts.tolerance ?? 5;
  let gx = x;
  let gy = y;
  if (opts.grid && opts.grid > 0) {
    gx = Math.round(x / opts.grid) * opts.grid;
    gy = Math.round(y / opts.grid) * opts.grid;
  }
  const g = opts.guides;
  const gxs = Array.isArray(g) ? g : g?.x ?? [];
  const gys = Array.isArray(g) ? g : g?.y ?? [];
  const pick = (v, cands, fallback) => {
    let best = null;
    for (const c of cands) {
      const d = Math.abs(c - v);
      if (d <= tol && (best === null || d < Math.abs(best - v))) best = c;
    }
    return best === null ? fallback : best;
  };
  const sx = pick(x, gxs, gx);
  const sy = pick(y, gys, gy);
  return isArr ? [sx, sy] : { x: sx, y: sy };
}
