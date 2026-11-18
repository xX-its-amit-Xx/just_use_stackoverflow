// Geometry helpers: rotation-aware boxes and hit tests, boundary anchors,
// an obstacle-avoiding orthogonal router and the snapping helper.
import { DiagramError } from './errors.js';

const RAD = Math.PI / 180;

export function rotatePoint(x, y, cx, cy, deg) {
  if (!deg) return [x, y];
  const c = Math.cos(deg * RAD), s = Math.sin(deg * RAD);
  const dx = x - cx, dy = y - cy;
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
}

export function centerOf(el) {
  return [el.x + el.width / 2, el.y + el.height / 2];
}

// Axis-aligned bounding box of a (possibly rotated) shape.
export function aabb(el) {
  const rot = ((el.rotation || 0) % 360 + 360) % 360;
  if (rot === 0) return { x: el.x, y: el.y, width: el.width, height: el.height };
  const [cx, cy] = centerOf(el);
  const corners = [
    [el.x, el.y], [el.x + el.width, el.y],
    [el.x + el.width, el.y + el.height], [el.x, el.y + el.height],
  ].map(([x, y]) => rotatePoint(x, y, cx, cy, el.rotation));
  const xs = corners.map((p) => p[0]), ys = corners.map((p) => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

// Rotation-aware point containment for a shape ('rect'|'text'|'image'|'line'|'ellipse'|'diamond').
export function containsPoint(el, px, py) {
  const [cx, cy] = centerOf(el);
  const [lx, ly] = rotatePoint(px, py, cx, cy, -(el.rotation || 0));
  const hw = el.width / 2, hh = el.height / 2;
  const dx = lx - cx, dy = ly - cy;
  if (el.type === 'ellipse') {
    if (hw === 0 || hh === 0) return false;
    return (dx * dx) / (hw * hw) + (dy * dy) / (hh * hh) <= 1;
  }
  if (el.type === 'diamond') {
    if (hw === 0 || hh === 0) return false;
    return Math.abs(dx) / hw + Math.abs(dy) / hh <= 1;
  }
  return lx >= el.x && lx <= el.x + el.width && ly >= el.y && ly <= el.y + el.height;
}

// Point where the ray from the shape centre towards (tx, ty) leaves the shape outline.
export function boundaryToward(el, tx, ty) {
  const [cx, cy] = centerOf(el);
  const [lx, ly] = rotatePoint(tx, ty, cx, cy, -(el.rotation || 0));
  const dx = lx - cx, dy = ly - cy;
  if (dx === 0 && dy === 0) return [cx, cy];
  const hw = el.width / 2, hh = el.height / 2;
  let t;
  if (el.type === 'ellipse') {
    t = 1 / Math.sqrt((dx * dx) / (hw * hw || 1) + (dy * dy) / (hh * hh || 1));
  } else if (el.type === 'diamond') {
    t = 1 / (Math.abs(dx) / (hw || 1) + Math.abs(dy) / (hh || 1));
  } else {
    t = Math.min(Math.abs(dx) > 0 ? hw / Math.abs(dx) : Infinity, Math.abs(dy) > 0 ? hh / Math.abs(dy) : Infinity);
  }
  return rotatePoint(cx + dx * t, cy + dy * t, cx, cy, el.rotation || 0);
}

// Named connection points: n/e/s/w side midpoints and c (centre), rotation-aware.
export function portPoint(el, port) {
  const [cx, cy] = centerOf(el);
  const map = {
    n: [cx, el.y], s: [cx, el.y + el.height], e: [el.x + el.width, cy], w: [el.x, cy], c: [cx, cy],
  };
  if (!map[port]) return null;
  const [x, y] = map[port];
  return rotatePoint(x, y, cx, cy, el.rotation || 0);
}

// Side midpoint of the (axis-aligned) box, used by the orthogonal router.
export function sideAnchor(box, side) {
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  switch (side) {
    case 'n': return [cx, box.y];
    case 's': return [cx, box.y + box.height];
    case 'e': return [box.x + box.width, cy];
    case 'w': return [box.x, cy];
    default: return [cx, cy];
  }
}

const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BEND_COST = 40;

// Minimal binary heap of [cost, state] pairs.
class Heap {
  constructor() { this.a = []; }
  push(item) {
    const a = this.a; a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]]; i = p;
    }
  }
  pop() {
    const a = this.a, top = a[0], last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
  get size() { return this.a.length; }
}

// Orthogonal routing on the grid induced by obstacle edges and the endpoints.
// Segments may not pass through the open interior of any obstacle. Returns
// [[x,y], ...] (corners only) or null when no route exists.
export function orthogonalRoute(start, end, obstacles, frame) {
  const xSet = new Set([frame.x, frame.x + frame.width, start[0], end[0]]);
  const ySet = new Set([frame.y, frame.y + frame.height, start[1], end[1]]);
  for (const o of obstacles) {
    xSet.add(o.x); xSet.add(o.x + o.width);
    ySet.add(o.y); ySet.add(o.y + o.height);
  }
  const xs = [...xSet].sort((a, b) => a - b);
  const ys = [...ySet].sort((a, b) => a - b);
  const nx = xs.length, ny = ys.length;
  const inside = (px, py) => obstacles.some((o) => px > o.x && px < o.x + o.width && py > o.y && py < o.y + o.height);

  const blockedNode = new Uint8Array(nx * ny);
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) blockedNode[i * ny + j] = inside(xs[i], ys[j]) ? 1 : 0;

  const idx = (i, j) => i * ny + j;
  const si = xs.indexOf(start[0]), sj = ys.indexOf(start[1]);
  const ti = xs.indexOf(end[0]), tj = ys.indexOf(end[1]);
  if (blockedNode[idx(si, sj)] || blockedNode[idx(ti, tj)]) return null;

  const nStates = nx * ny * 5;
  const dist = new Float64Array(nStates).fill(Infinity);
  const prev = new Int32Array(nStates).fill(-1);
  const heap = new Heap();
  const start0 = idx(si, sj) * 5 + 4;
  dist[start0] = 0;
  heap.push([0, start0]);
  let goal = -1;
  while (heap.size) {
    const [d, state] = heap.pop();
    if (d > dist[state]) continue;
    const dir = state % 5, node = (state - dir) / 5;
    const i = Math.floor(node / ny), j = node % ny;
    if (i === ti && j === tj) { goal = state; break; }
    for (let k = 0; k < 4; k++) {
      const ni = i + DIRS[k][0], nj = j + DIRS[k][1];
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
      const nNode = idx(ni, nj);
      if (blockedNode[nNode]) continue;
      // Segment midpoint test: the grid lines include every obstacle edge, so
      // the midpoint decides whether the whole segment crosses an interior.
      const mx = (xs[i] + xs[ni]) / 2, my = (ys[j] + ys[nj]) / 2;
      if (inside(mx, my)) continue;
      const len = Math.abs(xs[ni] - xs[i]) + Math.abs(ys[nj] - ys[j]);
      const bend = (dir !== 4 && dir !== k) ? BEND_COST : 0;
      const nd = d + len + bend;
      const ns = nNode * 5 + k;
      if (nd < dist[ns]) {
        dist[ns] = nd; prev[ns] = state; heap.push([nd, ns]);
      }
    }
  }
  if (goal < 0) return null;
  const pts = [];
  for (let s = goal; s !== -1; s = prev[s]) {
    const node = Math.floor(s / 5);
    pts.push([xs[Math.floor(node / ny)], ys[node % ny]]);
  }
  pts.reverse();
  // Drop collinear intermediate points, keeping corners only.
  const out = [pts[0]];
  for (let k = 1; k < pts.length - 1; k++) {
    const a = out[out.length - 1], b = pts[k], c = pts[k + 1];
    if ((a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1])) continue;
    out.push(b);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// Snap a point to guides (within threshold) or to a grid.
// opts: { grid?: number, guides?: {x?: number[], y?: number[]}, threshold?: number }
export function snap(point, opts = {}) {
  const isArray = Array.isArray(point);
  let x = isArray ? point[0] : point.x;
  let y = isArray ? point[1] : point.y;
  if (typeof x !== 'number' || typeof y !== 'number' || Number.isNaN(x) || Number.isNaN(y)) {
    throw new DiagramError('snap: point must have numeric coordinates');
  }
  const threshold = opts.threshold ?? 5;
  const guides = opts.guides || {};
  const nearest = (value, list) => {
    let best = null, bestD = threshold + 1e-9;
    for (const g of list || []) {
      const d = Math.abs(g - value);
      if (d <= bestD) { best = g; bestD = d; }
    }
    return best;
  };
  const gx = nearest(x, guides.x), gy = nearest(y, guides.y);
  if (gx !== null) x = gx;
  else if (opts.grid > 0) x = Math.round(x / opts.grid) * opts.grid;
  if (gy !== null) y = gy;
  else if (opts.grid > 0) y = Math.round(y / opts.grid) * opts.grid;
  return isArray ? [x, y] : { x, y };
}
