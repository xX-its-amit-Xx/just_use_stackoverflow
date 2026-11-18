// Orthogonal routing on a compressed grid. The grid lines are the coordinates of
// obstacle edges, the two end points and the region border, so every obstacle
// boundary lies on the grid and a grid edge is either fully inside or fully outside
// an obstacle's interior. A* (with bend penalty) finds the shortest path with fewest turns.

const BEND_PENALTY = 40;
const DIRS = [
  [1, 0], // east
  [-1, 0], // west
  [0, 1], // south
  [0, -1], // north
];
const NO_DIR = 4;

class MinHeap {
  constructor() {
    this.items = [];
  }
  push(key, value) {
    const a = this.items;
    a.push({ key, value });
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].key <= a[i].key) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].key < a[m].key) m = l;
        if (r < a.length && a[r].key < a[m].key) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  get size() {
    return this.items.length;
  }
}

/**
 * Finds an axis-parallel polyline from a to b that does not enter the open interior
 * of any obstacle ({x,y,width,height}) and stays inside `region`. Returns an array of
 * {x,y} points, or null when no such route exists on the grid.
 */
export function orthoRoute(a, b, obstacles, region) {
  if (a.x === b.x && a.y === b.y) return [{ x: a.x, y: a.y }];
  const xSet = new Set([region.minX, region.maxX, a.x, b.x]);
  const ySet = new Set([region.minY, region.maxY, a.y, b.y]);
  const inX = (v) => v >= region.minX && v <= region.maxX;
  const inY = (v) => v >= region.minY && v <= region.maxY;
  for (const o of obstacles) {
    for (const v of [o.x, o.x + o.width]) if (inX(v)) xSet.add(v);
    for (const v of [o.y, o.y + o.height]) if (inY(v)) ySet.add(v);
  }
  const xs = [...xSet].sort((p, q) => p - q);
  const ys = [...ySet].sort((p, q) => p - q);
  const NX = xs.length;
  const NY = ys.length;
  const xi = new Map(xs.map((v, i) => [v, i]));
  const yi = new Map(ys.map((v, i) => [v, i]));
  const node = (i, j) => i * NY + j;

  const blockedNode = new Uint8Array(NX * NY);
  const blockedH = new Uint8Array(NX * NY); // edge (i,j)-(i+1,j)
  const blockedV = new Uint8Array(NX * NY); // edge (i,j)-(i,j+1)
  for (const o of obstacles) {
    const L = o.x;
    const R = o.x + o.width;
    const T = o.y;
    const B = o.y + o.height;
    if (R <= L || B <= T) continue;
    for (let i = 0; i < NX; i++) {
      const x = xs[i];
      if (x > L && x < R) {
        for (let j = 0; j < NY; j++) {
          if (ys[j] > T && ys[j] < B) blockedNode[node(i, j)] = 1;
        }
      }
    }
    for (let i = 0; i + 1 < NX; i++) {
      const mx = (xs[i] + xs[i + 1]) / 2;
      if (!(mx > L && mx < R)) continue;
      for (let j = 0; j < NY; j++) if (ys[j] > T && ys[j] < B) blockedH[node(i, j)] = 1;
    }
    for (let j = 0; j + 1 < NY; j++) {
      const my = (ys[j] + ys[j + 1]) / 2;
      if (!(my > T && my < B)) continue;
      for (let i = 0; i < NX; i++) if (xs[i] > L && xs[i] < R) blockedV[node(i, j)] = 1;
    }
  }

  const si = xi.get(a.x);
  const sj = yi.get(a.y);
  const gi = xi.get(b.x);
  const gj = yi.get(b.y);
  if (blockedNode[node(si, sj)] || blockedNode[node(gi, gj)]) return null;

  const S = NX * NY * 5;
  const g = new Float64Array(S).fill(Infinity);
  const parent = new Int32Array(S).fill(-1);
  const closed = new Uint8Array(S);
  const heap = new MinHeap();
  const start = node(si, sj) * 5 + NO_DIR;
  g[start] = 0;
  heap.push(Math.abs(xs[si] - xs[gi]) + Math.abs(ys[sj] - ys[gj]), start);

  let goalState = -1;
  while (heap.size > 0) {
    const { value: s } = heap.pop();
    if (closed[s]) continue;
    closed[s] = 1;
    const dir = s % 5;
    const n = (s - dir) / 5;
    const i = Math.floor(n / NY);
    const j = n % NY;
    if (i === gi && j === gj) {
      goalState = s;
      break;
    }
    for (let d = 0; d < 4; d++) {
      const ni = i + DIRS[d][0];
      const nj = j + DIRS[d][1];
      if (ni < 0 || nj < 0 || ni >= NX || nj >= NY) continue;
      if (blockedNode[node(ni, nj)]) continue;
      let blocked;
      let step;
      if (d === 0) {
        blocked = blockedH[node(i, j)];
        step = xs[ni] - xs[i];
      } else if (d === 1) {
        blocked = blockedH[node(ni, nj)];
        step = xs[i] - xs[ni];
      } else if (d === 2) {
        blocked = blockedV[node(i, j)];
        step = ys[nj] - ys[j];
      } else {
        blocked = blockedV[node(ni, nj)];
        step = ys[j] - ys[nj];
      }
      if (blocked) continue;
      const bend = dir !== NO_DIR && dir !== d ? BEND_PENALTY : 0;
      const ns = node(ni, nj) * 5 + d;
      const cost = g[s] + step + bend;
      if (cost < g[ns]) {
        g[ns] = cost;
        parent[ns] = s;
        heap.push(cost + Math.abs(xs[ni] - xs[gi]) + Math.abs(ys[nj] - ys[gj]), ns);
      }
    }
  }
  if (goalState < 0) return null;

  const cells = [];
  for (let s = goalState; s !== -1; s = parent[s]) {
    const n = Math.floor(s / 5);
    cells.push({ x: xs[Math.floor(n / NY)], y: ys[n % NY] });
  }
  cells.reverse();
  return simplifyPoints(cells);
}

/** Removes duplicate and collinear interior points of an axis-parallel polyline. */
export function simplifyPoints(points) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last.x === p.x && last.y === p.y) continue;
    out.push({ x: p.x, y: p.y });
  }
  const res = [];
  for (let k = 0; k < out.length; k++) {
    const prev = res[res.length - 1];
    const cur = out[k];
    const next = out[k + 1];
    if (prev && next) {
      const sameX = prev.x === cur.x && cur.x === next.x;
      const sameY = prev.y === cur.y && cur.y === next.y;
      if (sameX || sameY) continue;
    }
    res.push(cur);
  }
  return res;
}
