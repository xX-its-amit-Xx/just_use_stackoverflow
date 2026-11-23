// Geometry helpers (no DOM).
export function rad(deg) { return (deg * Math.PI) / 180; }
export function center(el) { return { x: el.x + el.width / 2, y: el.y + el.height / 2 }; }

export function rotatePoint(p, c, deg) {
  const a = rad(deg), cos = Math.cos(a), sin = Math.sin(a);
  const dx = p.x - c.x, dy = p.y - c.y;
  return { x: c.x + dx * cos - dy * sin, y: c.y + dx * sin + dy * cos };
}

export function corners(el) {
  const pts = [
    { x: el.x, y: el.y }, { x: el.x + el.width, y: el.y },
    { x: el.x + el.width, y: el.y + el.height }, { x: el.x, y: el.y + el.height },
  ];
  if (!el.rotation) return pts;
  const c = center(el);
  return pts.map((p) => rotatePoint(p, c, el.rotation));
}

export function aabb(el) {
  const cs = corners(el);
  const xs = cs.map((p) => p.x), ys = cs.map((p) => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export function unionBox(boxes) {
  if (!boxes.length) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const b of boxes) {
    x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.width); y2 = Math.max(y2, b.y + b.height);
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

export function containsPoint(el, px, py) {
  let p = { x: px, y: py };
  const c = center(el);
  if (el.rotation) p = rotatePoint(p, c, -el.rotation);
  const hw = el.width / 2, hh = el.height / 2;
  const lx = p.x - c.x, ly = p.y - c.y;
  const eps = 1e-9;
  if (el.type === 'ellipse') {
    if (hw === 0 || hh === 0) return Math.abs(lx) <= hw + eps && Math.abs(ly) <= hh + eps;
    return (lx / hw) ** 2 + (ly / hh) ** 2 <= 1 + eps;
  }
  if (el.type === 'diamond') {
    if (hw === 0 || hh === 0) return Math.abs(lx) <= hw + eps && Math.abs(ly) <= hh + eps;
    return Math.abs(lx) / hw + Math.abs(ly) / hh <= 1 + eps;
  }
  return Math.abs(lx) <= hw + eps && Math.abs(ly) <= hh + eps;
}

// Point on the shape boundary in the direction of target point t (from the centre).
export function boundaryToward(el, t) {
  const c = center(el);
  let dx = t.x - c.x, dy = t.y - c.y;
  if (dx === 0 && dy === 0) { dx = 1; dy = 0; }
  const hw = el.width / 2, hh = el.height / 2;
  let s;
  if (el.type === 'ellipse') s = 1 / Math.sqrt((dx / (hw || 1e-9)) ** 2 + (dy / (hh || 1e-9)) ** 2);
  else if (el.type === 'diamond') s = 1 / (Math.abs(dx) / (hw || 1e-9) + Math.abs(dy) / (hh || 1e-9));
  else s = Math.min(dx !== 0 ? hw / Math.abs(dx) : Infinity, dy !== 0 ? hh / Math.abs(dy) : Infinity);
  return { x: c.x + dx * s, y: c.y + dy * s };
}

export const SIDES = {
  top: { x: 0, y: -1 }, bottom: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 },
};
const SIDE_ALIAS = { n: 'top', s: 'bottom', w: 'left', e: 'right', north: 'top', south: 'bottom', west: 'left', east: 'right', t: 'top', b: 'bottom', l: 'left', r: 'right' };
export function sideName(port) {
  if (typeof port !== 'string') return null;
  const p = port.toLowerCase();
  if (SIDES[p]) return p;
  return SIDE_ALIAS[p] || null;
}
export function sidePoint(el, side) {
  const c = center(el);
  const d = SIDES[side];
  return { x: c.x + d.x * el.width / 2, y: c.y + d.y * el.height / 2 };
}

// grid / guide snapping
export function snap(point, opts = {}) {
  const { grid, guides, threshold = 5 } = opts || {};
  let { x, y } = point;
  const gx = [], gy = [];
  const addGuide = (g) => {
    if (typeof g === 'number') { gx.push(g); gy.push(g); return; }
    if (!g || typeof g !== 'object') return;
    if (Array.isArray(g.x)) gx.push(...g.x);
    if (Array.isArray(g.y)) gy.push(...g.y);
    const axis = g.axis || g.orientation || g.type;
    const val = g.value ?? g.position ?? g.pos;
    if (typeof val === 'number') {
      if (axis === 'x' || axis === 'vertical' || axis === 'v') gx.push(val);
      else if (axis === 'y' || axis === 'horizontal' || axis === 'h') gy.push(val);
    } else {
      if (typeof g.x === 'number') gx.push(g.x);
      if (typeof g.y === 'number') gy.push(g.y);
    }
  };
  if (Array.isArray(guides)) guides.forEach(addGuide); else if (guides) addGuide(guides);
  const best = (v, list) => {
    let b = null, bd = Infinity;
    for (const g of list) { const d = Math.abs(g - v); if (d <= threshold && d < bd) { b = g; bd = d; } }
    return b;
  };
  const sx = best(x, gx), sy = best(y, gy);
  const g = typeof grid === 'number' && grid > 0 ? grid : (grid && grid.size > 0 ? grid.size : 0);
  if (sx !== null) x = sx; else if (g) x = Math.round(x / g) * g;
  if (sy !== null) y = sy; else if (g) y = Math.round(y / g) * g;
  return { x, y };
}
