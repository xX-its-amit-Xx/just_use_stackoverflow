// Pure geometry helpers. Angles are degrees, clockwise on screen (y grows downwards).

const TAU = Math.PI / 180;

export function normDeg(deg) {
  return ((deg % 360) + 360) % 360;
}

function rotateAround(px, py, cx, cy, deg) {
  const r = deg * TAU;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  const dx = px - cx;
  const dy = py - cy;
  return { x: cx + dx * cos - dy * sin, y: cy + dx * sin + dy * cos };
}

export function centerOf(e) {
  return { x: e.x + e.width / 2, y: e.y + e.height / 2 };
}

/** Axis-aligned bounding box of a (possibly rotated) element. */
export function aabb(e) {
  const rot = normDeg(e.rotation ?? 0);
  if (rot === 0) return { x: e.x, y: e.y, width: e.width, height: e.height };
  const c = centerOf(e);
  const corners = [
    [e.x, e.y],
    [e.x + e.width, e.y],
    [e.x + e.width, e.y + e.height],
    [e.x, e.y + e.height],
  ].map(([px, py]) => rotateAround(px, py, c.x, c.y, rot));
  const xs = corners.map((p) => p.x);
  const ys = corners.map((p) => p.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

/** Rectangle union of boxes; empty input gives a zero rectangle at the origin. */
export function unionRect(boxes) {
  if (boxes.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  const maxX = Math.max(...boxes.map((b) => b.x + b.width));
  const maxY = Math.max(...boxes.map((b) => b.y + b.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function containsPoint(e, px, py) {
  const c = centerOf(e);
  const rot = normDeg(e.rotation ?? 0);
  const local = rot === 0 ? { x: px, y: py } : rotateAround(px, py, c.x, c.y, -rot);
  const dx = local.x - c.x;
  const dy = local.y - c.y;
  const hw = e.width / 2;
  const hh = e.height / 2;
  if (e.type === 'ellipse' && hw > 0 && hh > 0) return (dx / hw) ** 2 + (dy / hh) ** 2 <= 1;
  if (e.type === 'diamond' && hw > 0 && hh > 0) return Math.abs(dx) / hw + Math.abs(dy) / hh <= 1;
  const tol = e.type === 'line' ? 3 : 0;
  return Math.abs(dx) <= hw + tol && Math.abs(dy) <= hh + tol;
}

/** Point where the ray from the centre of e towards p leaves the shape outline. */
export function boundaryPoint(e, p) {
  const c = centerOf(e);
  const rot = normDeg(e.rotation ?? 0);
  const local = rotateAround(p.x, p.y, c.x, c.y, -rot);
  const dx = local.x - c.x;
  const dy = local.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const hw = e.width / 2;
  const hh = e.height / 2;
  let t;
  if (e.type === 'ellipse' && hw > 0 && hh > 0) {
    t = 1 / Math.sqrt((dx / hw) ** 2 + (dy / hh) ** 2);
  } else if (e.type === 'diamond' && hw > 0 && hh > 0) {
    t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  } else {
    const tx = dx !== 0 ? hw / Math.abs(dx) : Infinity;
    const ty = dy !== 0 ? hh / Math.abs(dy) : Infinity;
    t = Math.min(tx, ty);
  }
  return rotateAround(c.x + dx * t, c.y + dy * t, c.x, c.y, rot);
}

const PORTS = {
  n: (e) => [e.x + e.width / 2, e.y],
  top: (e) => [e.x + e.width / 2, e.y],
  s: (e) => [e.x + e.width / 2, e.y + e.height],
  bottom: (e) => [e.x + e.width / 2, e.y + e.height],
  w: (e) => [e.x, e.y + e.height / 2],
  left: (e) => [e.x, e.y + e.height / 2],
  e: (e) => [e.x + e.width, e.y + e.height / 2],
  right: (e) => [e.x + e.width, e.y + e.height / 2],
};

export const PORT_NAMES = Object.keys(PORTS);

/** Side midpoint for a named port, rotated with the element. Null if the port is unknown. */
export function portPoint(e, port) {
  const f = PORTS[port];
  if (!f) return null;
  const [px, py] = f(e);
  const rot = normDeg(e.rotation ?? 0);
  if (rot === 0) return { x: px, y: py };
  const c = centerOf(e);
  return rotateAround(px, py, c.x, c.y, rot);
}

/** Side midpoint of e facing the point p (dominant axis of the centre-to-point vector). */
export function sideToward(e, p) {
  const c = centerOf(e);
  const dx = p.x - c.x;
  const dy = p.y - c.y;
  const side = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'e' : 'w') : dy >= 0 ? 's' : 'n';
  return portPoint(e, side);
}

function guidesFor(guides, axis) {
  if (!guides) return [];
  if (Array.isArray(guides)) {
    const out = [];
    for (const g of guides) {
      if (typeof g === 'number') out.push(g);
      else if (g && typeof g === 'object') {
        if (typeof g[axis] === 'number') out.push(g[axis]);
        else if (g.axis === axis && typeof g.value === 'number') out.push(g.value);
      }
    }
    return out;
  }
  const list = guides[axis];
  return Array.isArray(list) ? list.filter((n) => typeof n === 'number') : [];
}

function snapAxis(v, guides, grid, threshold) {
  let best = null;
  for (const g of guides) {
    const d = Math.abs(g - v);
    if (d <= threshold && (best === null || d < Math.abs(best - v))) best = g;
  }
  if (best !== null) return best;
  if (grid && grid > 0) return Math.round(v / grid) * grid;
  return v;
}

/**
 * Snaps a point to guide lines (within `threshold`, default 5 px) first, then to the grid.
 * Returns a new point of the same shape as the input.
 */
export function snap(point, opts = {}) {
  const grid = opts.grid;
  const threshold = opts.threshold ?? 5;
  const x = snapAxis(point.x, guidesFor(opts.guides, 'x'), grid, threshold);
  const y = snapAxis(point.y, guidesFor(opts.guides, 'y'), grid, threshold);
  return { x: x + 0, y: y + 0 };
}
