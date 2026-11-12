export const SHAPE_TYPES = new Set(['rect', 'ellipse', 'diamond', 'text', 'image', 'line']);

export function centerOf(el) {
  return { x: el.x + el.width / 2, y: el.y + el.height / 2 };
}

export function rotatePoint(x, y, cx, cy, deg) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const dx = x - cx;
  const dy = y - cy;
  return { x: cx + dx * c - dy * s, y: cy + dx * s + dy * c };
}

/** Corners of the (rotated) bounding box, clockwise from top-left. */
export function cornersOf(el) {
  const c = centerOf(el);
  const pts = [
    { x: el.x, y: el.y },
    { x: el.x + el.width, y: el.y },
    { x: el.x + el.width, y: el.y + el.height },
    { x: el.x, y: el.y + el.height },
  ];
  return el.rotation ? pts.map((p) => rotatePoint(p.x, p.y, c.x, c.y, el.rotation)) : pts;
}

function distToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const qx = a.x + t * dx - p.x;
  const qy = a.y + t * dy - p.y;
  return Math.hypot(qx, qy);
}

/** Rotation-aware point containment test for a shape. */
export function containsPoint(el, px, py) {
  const c = centerOf(el);
  const p = el.rotation ? rotatePoint(px, py, c.x, c.y, -el.rotation) : { x: px, y: py };
  if (el.type === 'line') {
    return distToSegment(p, { x: el.x, y: el.y }, { x: el.x + el.width, y: el.y + el.height }) <= 4;
  }
  const hw = el.width / 2;
  const hh = el.height / 2;
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  if (hw > 0 && hh > 0) {
    if (el.type === 'ellipse') return (dx / hw) ** 2 + (dy / hh) ** 2 <= 1;
    if (el.type === 'diamond') return Math.abs(dx) / hw + Math.abs(dy) / hh <= 1;
  }
  return p.x >= el.x && p.x <= el.x + el.width && p.y >= el.y && p.y <= el.y + el.height;
}

/** Point where the ray from the shape centre towards (tx, ty) leaves the shape. */
export function clipToBoundary(el, tx, ty) {
  const c = centerOf(el);
  const dx = tx - c.x;
  const dy = ty - c.y;
  if (dx === 0 && dy === 0) return { x: c.x, y: c.y };
  const hw = el.width / 2;
  const hh = el.height / 2;
  let t;
  if (hw > 0 && hh > 0 && el.type === 'ellipse') {
    t = 1 / Math.sqrt((dx / hw) ** 2 + (dy / hh) ** 2);
  } else if (hw > 0 && hh > 0 && el.type === 'diamond') {
    t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  } else {
    t = Math.min(dx !== 0 ? hw / Math.abs(dx) : Infinity, dy !== 0 ? hh / Math.abs(dy) : Infinity);
  }
  if (!Number.isFinite(t)) t = 0;
  return { x: c.x + dx * t, y: c.y + dy * t };
}

const PORTS = {
  top: (e) => ({ x: e.x + e.width / 2, y: e.y }),
  n: (e) => ({ x: e.x + e.width / 2, y: e.y }),
  bottom: (e) => ({ x: e.x + e.width / 2, y: e.y + e.height }),
  s: (e) => ({ x: e.x + e.width / 2, y: e.y + e.height }),
  left: (e) => ({ x: e.x, y: e.y + e.height / 2 }),
  w: (e) => ({ x: e.x, y: e.y + e.height / 2 }),
  right: (e) => ({ x: e.x + e.width, y: e.y + e.height / 2 }),
  e: (e) => ({ x: e.x + e.width, y: e.y + e.height / 2 }),
  center: (e) => centerOf(e),
};

/** Anchor point for a named port, or null when no (known) port is given. */
export function portPoint(el, port) {
  if (port === undefined || port === null) return null;
  const f = PORTS[port];
  return f ? f(el) : null;
}

/**
 * Snap a point to a grid and to guide lines.
 * guides: array of {x?, y?} objects, or {x: number[], y: number[]}.
 * Guides win over the grid when within `threshold` on that axis.
 */
export function snap(point, opts = {}) {
  const grid = opts.grid ?? 0;
  const threshold = opts.threshold ?? 5;
  let x = point.x;
  let y = point.y;
  if (grid > 0) {
    x = Math.round(x / grid) * grid;
    y = Math.round(y / grid) * grid;
  }
  const xs = [];
  const ys = [];
  const g = opts.guides ?? [];
  if (Array.isArray(g)) {
    for (const item of g) {
      if (item && typeof item.x === 'number') xs.push(item.x);
      if (item && typeof item.y === 'number') ys.push(item.y);
    }
  } else if (g && typeof g === 'object') {
    for (const v of g.x ?? []) xs.push(v);
    for (const v of g.y ?? []) ys.push(v);
  }
  let bestX = null;
  let bestY = null;
  for (const v of xs) {
    const d = Math.abs(v - point.x);
    if (d <= threshold && (bestX === null || d < Math.abs(bestX - point.x))) bestX = v;
  }
  for (const v of ys) {
    const d = Math.abs(v - point.y);
    if (d <= threshold && (bestY === null || d < Math.abs(bestY - point.y))) bestY = v;
  }
  if (bestX !== null) x = bestX;
  if (bestY !== null) y = bestY;
  return { x, y };
}
