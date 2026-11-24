// Geometry helpers (original code).

export const SHAPE_TYPES = new Set(['rect', 'ellipse', 'diamond', 'text', 'image', 'line']);

export function center(e) {
  return [e.x + e.width / 2, e.y + e.height / 2];
}

function rot(px, py, cx, cy, deg) {
  if (!deg) return [px, py];
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r), s = Math.sin(r);
  const dx = px - cx, dy = py - cy;
  return [cx + dx * c - dy * s, cy + dx * s + dy * c];
}
export { rot as rotatePoint };

export function aabb(e) {
  if (!e.rotation || e.rotation % 360 === 0) {
    return { x: Math.min(e.x, e.x + e.width), y: Math.min(e.y, e.y + e.height), width: Math.abs(e.width), height: Math.abs(e.height) };
  }
  const [cx, cy] = center(e);
  const pts = [[e.x, e.y], [e.x + e.width, e.y], [e.x + e.width, e.y + e.height], [e.x, e.y + e.height]].map(([x, y]) => rot(x, y, cx, cy, e.rotation));
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export function unionBoxes(boxes) {
  if (!boxes.length) return null;
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const b of boxes) {
    x1 = Math.min(x1, b.x); y1 = Math.min(y1, b.y);
    x2 = Math.max(x2, b.x + b.width); y2 = Math.max(y2, b.y + b.height);
  }
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

/** Is the point inside the (possibly rotated) shape? Boundary counts as inside. */
export function containsPoint(e, px, py) {
  const [cx, cy] = center(e);
  const [lx, ly] = rot(px, py, cx, cy, -(e.rotation || 0));
  const hw = Math.abs(e.width) / 2, hh = Math.abs(e.height) / 2;
  const dx = lx - cx, dy = ly - cy;
  const eps = 1e-9;
  if (e.type === 'ellipse') {
    if (hw === 0 || hh === 0) return false;
    return (dx * dx) / (hw * hw) + (dy * dy) / (hh * hh) <= 1 + eps;
  }
  if (e.type === 'diamond') {
    if (hw === 0 || hh === 0) return false;
    return Math.abs(dx) / hw + Math.abs(dy) / hh <= 1 + eps;
  }
  if (e.type === 'line') {
    // distance from the segment (tolerance 4px)
    const x1 = e.x, y1 = e.y, x2 = e.x + e.width, y2 = e.y + e.height;
    const L = (x2 - x1) ** 2 + (y2 - y1) ** 2;
    let t = L ? ((lx - x1) * (x2 - x1) + (ly - y1) * (y2 - y1)) / L : 0;
    t = Math.max(0, Math.min(1, t));
    const qx = x1 + t * (x2 - x1), qy = y1 + t * (y2 - y1);
    return Math.hypot(lx - qx, ly - qy) <= 4;
  }
  return Math.abs(dx) <= hw + eps && Math.abs(dy) <= hh + eps;
}

/** Point on the shape boundary in direction of (tx, ty) from its centre. */
export function boundaryToward(e, tx, ty) {
  const [cx, cy] = center(e);
  const [lx, ly] = rot(tx, ty, cx, cy, -(e.rotation || 0));
  const dx = lx - cx, dy = ly - cy;
  const hw = Math.abs(e.width) / 2, hh = Math.abs(e.height) / 2;
  if ((dx === 0 && dy === 0) || (hw === 0 && hh === 0)) return [cx, cy];
  let t;
  if (e.type === 'ellipse') t = 1 / Math.sqrt((dx / (hw || 1e-9)) ** 2 + (dy / (hh || 1e-9)) ** 2);
  else if (e.type === 'diamond') t = 1 / (Math.abs(dx) / (hw || 1e-9) + Math.abs(dy) / (hh || 1e-9));
  else t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  return rot(cx + dx * t, cy + dy * t, cx, cy, e.rotation || 0);
}

const PORT_ALIASES = { n: 'top', north: 'top', s: 'bottom', south: 'bottom', e: 'right', east: 'right', w: 'left', west: 'left', c: 'center', centre: 'center', middle: 'center' };

export function portSide(port) {
  if (typeof port !== 'string') return null;
  const p = port.toLowerCase();
  const s = PORT_ALIASES[p] || p;
  return ['top', 'bottom', 'left', 'right', 'center'].includes(s) ? s : null;
}

/** Point of a port (named side or {x,y} fractions) on the element, or null. */
export function portPoint(e, port) {
  if (port == null) return null;
  let fx, fy;
  if (typeof port === 'object') {
    fx = Number(port.x); fy = Number(port.y);
    if (!Number.isFinite(fx) || !Number.isFinite(fy)) return null;
  } else {
    const s = portSide(port);
    if (!s) return null;
    [fx, fy] = { top: [0.5, 0], bottom: [0.5, 1], left: [0, 0.5], right: [1, 0.5], center: [0.5, 0.5] }[s];
  }
  const [cx, cy] = center(e);
  return rot(e.x + fx * e.width, e.y + fy * e.height, cx, cy, e.rotation || 0);
}

/** Snap a point to guides (priority) and/or grid. */
export function snap(point, opts = {}) {
  const isArr = Array.isArray(point);
  let x = isArr ? point[0] : point.x, y = isArr ? point[1] : point.y;
  const { grid, guides, threshold = 5 } = opts || {};
  const gx = [], gy = [];
  if (Array.isArray(guides)) {
    for (const g of guides) {
      if (g == null) continue;
      if (typeof g === 'object') {
        if (g.axis === 'x' || g.axis === 'vertical' || g.orientation === 'vertical') gx.push(+g.value);
        else if (g.axis === 'y' || g.axis === 'horizontal' || g.orientation === 'horizontal') gy.push(+g.value);
        else {
          if (typeof g.x === 'number') gx.push(g.x);
          if (typeof g.y === 'number') gy.push(g.y);
        }
      }
    }
  } else if (guides && typeof guides === 'object') {
    for (const v of [].concat(guides.x ?? [], guides.vertical ?? [])) gx.push(+v);
    for (const v of [].concat(guides.y ?? [], guides.horizontal ?? [])) gy.push(+v);
  }
  const near = (v, list) => {
    let best = null, bd = Infinity;
    for (const g of list) { const d = Math.abs(g - v); if (d <= threshold && d < bd) { bd = d; best = g; } }
    return best;
  };
  const sx = near(x, gx), sy = near(y, gy);
  const gsize = typeof grid === 'number' ? grid : grid && typeof grid === 'object' ? grid.size : 0;
  if (sx !== null) x = sx; else if (gsize > 0) x = Math.round(x / gsize) * gsize;
  if (sy !== null) y = sy; else if (gsize > 0) y = Math.round(y / gsize) * gsize;
  x = x + 0; y = y + 0; // normalise -0
  return isArr ? [x, y] : { x, y };
}

// ---------------------------------------------------------------------------
// Orthogonal routing: Dijkstra over a sparse orthogonal grid built from the
// obstacle edges. Segments never pass through an obstacle interior.

class Heap {
  constructor() { this.a = []; }
  push(k, v) {
    const a = this.a; a.push([k, v]);
    let i = a.length - 1;
    while (i > 0) { const p = (i - 1) >> 1; if (a[p][0] <= a[i][0]) break; [a[p], a[i]] = [a[i], a[p]]; i = p; }
  }
  pop() {
    const a = this.a; const top = a[0]; const last = a.pop();
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break; [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
  get size() { return this.a.length; }
}

const SIDES = {
  top: { pt: b => [b.x + b.width / 2, b.y], dir: 2 },      // outward: up (dir 2 = -y)
  bottom: { pt: b => [b.x + b.width / 2, b.y + b.height], dir: 3 }, // +y
  left: { pt: b => [b.x, b.y + b.height / 2], dir: 1 },     // -x
  right: { pt: b => [b.x + b.width, b.y + b.height / 2], dir: 0 }, // +x
};
const DIRS = [[1, 0], [-1, 0], [0, -1], [0, 1]];
const OPP = [1, 0, 3, 2];

export function simplify(pts) {
  const out = [];
  for (const p of pts) {
    const q = [p[0] + 0, p[1] + 0];
    const last = out[out.length - 1];
    if (last && Math.abs(last[0] - q[0]) < 1e-9 && Math.abs(last[1] - q[1]) < 1e-9) continue;
    out.push(q);
    while (out.length >= 3) {
      const [a, b, c] = out.slice(-3);
      const col = (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(b[0] - c[0]) < 1e-9) || (Math.abs(a[1] - b[1]) < 1e-9 && Math.abs(b[1] - c[1]) < 1e-9);
      if (col) out.splice(out.length - 2, 1); else break;
    }
  }
  return out;
}

/**
 * @param srcBox, dstBox  axis-aligned boxes of source/target
 * @param obstacles  boxes (including source/target) whose interiors must be avoided
 * @param area  bounding area for the search
 */
export function orthogonalRoute(srcBox, dstBox, obstacles, area, srcSide, dstSide, waypoints = []) {
  const sSides = srcSide && SIDES[srcSide] ? [srcSide] : Object.keys(SIDES);
  const tSides = dstSide && SIDES[dstSide] ? [dstSide] : Object.keys(SIDES);
  const xsSet = new Set([area.x, area.x + area.width]);
  const ysSet = new Set([area.y, area.y + area.height]);
  const M = 20;
  for (const o of obstacles) {
    for (const v of [o.x, o.x + o.width, o.x - M, o.x + o.width + M, o.x + o.width / 2]) xsSet.add(v);
    for (const v of [o.y, o.y + o.height, o.y - M, o.y + o.height + M, o.y + o.height / 2]) ysSet.add(v);
  }
  for (const s of sSides) { const p = SIDES[s].pt(srcBox); xsSet.add(p[0]); ysSet.add(p[1]); }
  for (const s of tSides) { const p = SIDES[s].pt(dstBox); xsSet.add(p[0]); ysSet.add(p[1]); }
  // midpoints between source and target help produce balanced Z routes
  xsSet.add((srcBox.x + srcBox.width / 2 + dstBox.x + dstBox.width / 2) / 2);
  ysSet.add((srcBox.y + srcBox.height / 2 + dstBox.y + dstBox.height / 2) / 2);
  const inArea = (v, lo, hi) => v >= lo - 1e-9 && v <= hi + 1e-9;
  const xs = [...xsSet].filter(v => Number.isFinite(v) && inArea(v, area.x, area.x + area.width)).sort((a, b) => a - b);
  const ys = [...ysSet].filter(v => Number.isFinite(v) && inArea(v, area.y, area.y + area.height)).sort((a, b) => a - b);
  const W = xs.length, H = ys.length;
  const xi = new Map(xs.map((v, i) => [v, i])), yi = new Map(ys.map((v, i) => [v, i]));
  const nodeBlocked = new Uint8Array(W * H);
  const hBlocked = new Uint8Array(W * H); // segment (i,j)->(i+1,j)
  const vBlocked = new Uint8Array(W * H); // segment (i,j)->(i,j+1)
  const lb = (arr, v) => { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; } return lo; };
  for (const o of obstacles) {
    const x1 = o.x, x2 = o.x + o.width, y1 = o.y, y2 = o.y + o.height;
    if (!(x2 > x1 && y2 > y1)) continue;
    const i0 = lb(xs, x1), i1 = lb(xs, x2); // xs[i0] >= x1, xs[i1] >= x2
    const j0 = lb(ys, y1), j1 = lb(ys, y2);
    for (let j = j0; j < H && ys[j] <= y2; j++) {
      const yInt = ys[j] > y1 && ys[j] < y2;
      for (let i = i0; i < W && xs[i] <= x2; i++) {
        const xInt = xs[i] > x1 && xs[i] < x2;
        if (xInt && yInt) nodeBlocked[j * W + i] = 1;
        // horizontal segment i->i+1 at row j crosses interior if row strictly inside and span within [x1,x2]
        if (yInt && i + 1 < W && xs[i] >= x1 && xs[i + 1] <= x2) hBlocked[j * W + i] = 1;
        if (xInt && j + 1 < H && ys[j] >= y1 && ys[j + 1] <= y2) vBlocked[j * W + i] = 1;
      }
    }
    void i1; void j1;
  }
  const BEND = 25;
  const N = W * H;
  const dist = new Float64Array(N * 4).fill(Infinity);
  const prev = new Int32Array(N * 4).fill(-1);
  const heap = new Heap();
  for (const s of sSides) {
    const p = SIDES[s].pt(srcBox);
    const i = xi.get(p[0]), j = yi.get(p[1]);
    if (i === undefined || j === undefined) continue;
    const st = (j * W + i) * 4 + SIDES[s].dir;
    dist[st] = 0; heap.push(0, st);
  }
  const goals = new Map();
  for (const s of tSides) {
    const p = SIDES[s].pt(dstBox);
    const i = xi.get(p[0]), j = yi.get(p[1]);
    if (i === undefined || j === undefined) continue;
    goals.set(j * W + i, OPP[SIDES[s].dir]);
  }
  let best = -1, bestCost = Infinity;
  while (heap.size) {
    const [d, st] = heap.pop();
    if (d > dist[st]) continue;
    if (d >= bestCost) break;
    const node = st >> 2, dir = st & 3;
    if (goals.has(node)) {
      const c = d + (goals.get(node) === dir ? 0 : BEND * 2);
      if (c < bestCost) { bestCost = c; best = st; }
    }
    const i = node % W, j = (node - i) / W;
    for (let nd = 0; nd < 4; nd++) {
      if (nd === OPP[dir] && d > 0) continue;
      let ni = i, nj = j, blocked;
      if (nd === 0) { ni = i + 1; blocked = ni >= W || hBlocked[j * W + i]; }
      else if (nd === 1) { ni = i - 1; blocked = ni < 0 || hBlocked[j * W + ni]; }
      else if (nd === 2) { nj = j - 1; blocked = nj < 0 || vBlocked[nj * W + i]; }
      else { nj = j + 1; blocked = nj >= H || vBlocked[j * W + i]; }
      if (blocked) continue;
      const nn = nj * W + ni;
      if (nodeBlocked[nn]) continue;
      const len = Math.abs(xs[ni] - xs[i]) + Math.abs(ys[nj] - ys[j]);
      const nc = d + len + (nd === dir ? 0 : BEND);
      const ns = nn * 4 + nd;
      if (nc < dist[ns]) { dist[ns] = nc; prev[ns] = st; heap.push(nc, ns); }
    }
  }
  if (best < 0) return null;
  const pts = [];
  for (let st = best; st >= 0; st = prev[st]) {
    const node = st >> 2; const i = node % W, j = (node - i) / W;
    pts.push([xs[i], ys[j]]);
  }
  pts.reverse();
  void waypoints;
  return simplify(pts);
}
