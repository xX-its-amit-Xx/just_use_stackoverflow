// Pure geometry helpers. Angles are in degrees, rotation is clockwise in screen coordinates.

export function rotatePoint(x, y, cx, cy, deg) {
  if (!deg) return [x, y];
  const rad = (deg * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  const dx = x - cx;
  const dy = y - cy;
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
}

export function centerOf(el) {
  return [el.x + el.width / 2, el.y + el.height / 2];
}

// Axis-aligned bounding box of a shape, rotation-aware.
export function aabbOf(el) {
  const [cx, cy] = centerOf(el);
  const corners = [
    [el.x, el.y],
    [el.x + el.width, el.y],
    [el.x + el.width, el.y + el.height],
    [el.x, el.y + el.height],
  ].map(([x, y]) => rotatePoint(x, y, cx, cy, el.rotation || 0));
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const [x, y] of corners) {
    if (x < left) left = x;
    if (x > right) right = x;
    if (y < top) top = y;
    if (y > bottom) bottom = y;
  }
  return { left, top, right, bottom };
}

export function boxToRect(b) {
  return { x: b.left, y: b.top, width: b.right - b.left, height: b.bottom - b.top };
}

// Rotation-aware point containment test.
export function containsPoint(el, px, py) {
  const [cx, cy] = centerOf(el);
  const [lx, ly] = rotatePoint(px, py, cx, cy, -(el.rotation || 0));
  const dx = lx - cx;
  const dy = ly - cy;
  const hw = el.width / 2;
  const hh = el.height / 2;
  switch (el.type) {
    case 'ellipse':
      if (hw <= 0 || hh <= 0) return false;
      return (dx * dx) / (hw * hw) + (dy * dy) / (hh * hh) <= 1;
    case 'diamond':
      if (hw <= 0 || hh <= 0) return false;
      return Math.abs(dx) / hw + Math.abs(dy) / hh <= 1;
    default:
      return Math.abs(dx) <= hw && Math.abs(dy) <= hh;
  }
}

// Point on the boundary of `el` in the direction of (tx, ty) from its centre.
export function clipToShape(el, tx, ty) {
  const [cx, cy] = centerOf(el);
  const rot = el.rotation || 0;
  const [lx, ly] = rotatePoint(tx, ty, cx, cy, -rot);
  const dx = lx - cx;
  const dy = ly - cy;
  const hw = el.width / 2;
  const hh = el.height / 2;
  if (dx === 0 && dy === 0) return [cx, cy];
  let t;
  switch (el.type) {
    case 'ellipse':
      t = 1 / Math.sqrt((dx * dx) / (hw * hw) + (dy * dy) / (hh * hh));
      break;
    case 'diamond':
      t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
      break;
    default:
      t = Math.min(dx !== 0 ? hw / Math.abs(dx) : Infinity, dy !== 0 ? hh / Math.abs(dy) : Infinity);
  }
  if (!Number.isFinite(t) || t <= 0) return [cx, cy];
  return rotatePoint(cx + dx * t, cy + dy * t, cx, cy, rot);
}

// Named port anchor on a shape ('n'|'e'|'s'|'w'|'center' or top/right/bottom/left).
export function portPoint(el, port) {
  const cx = el.x + el.width / 2;
  const cy = el.y + el.height / 2;
  let p;
  switch (port) {
    case 'n': case 'top': p = [cx, el.y]; break;
    case 'e': case 'right': p = [el.x + el.width, cy]; break;
    case 's': case 'bottom': p = [cx, el.y + el.height]; break;
    case 'w': case 'left': p = [el.x, cy]; break;
    case 'center': p = [cx, cy]; break;
    default: return null;
  }
  return rotatePoint(p[0], p[1], cx, cy, el.rotation || 0);
}
