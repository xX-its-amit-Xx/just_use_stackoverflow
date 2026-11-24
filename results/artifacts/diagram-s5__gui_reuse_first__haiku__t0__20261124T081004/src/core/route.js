import { aabbOf, clipToShape, portPoint, centerOf } from './geometry.js';

const MARGIN = 100;
const BEND_COST = 30;
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// Route a connector. `source`/`target` are shape objects, `shapes` every live shape (obstacles).
export function routeConnector({ connector, source, target, shapes }) {
  if (connector.routing === 'orthogonal') {
    return orthogonalRoute(connector, source, target, shapes);
  }
  return straightRoute(connector, source, target);
}

function straightRoute(c, s, t) {
  const sc = centerOf(s);
  const tc = centerOf(t);
  const first = c.source && c.source.port ? portPoint(s, c.source.port) : null;
  const last = c.target && c.target.port ? portPoint(t, c.target.port) : null;
  const wps = c.waypoints || [];
  const aimS = wps.length ? wps[0] : last || tc;
  const aimT = wps.length ? wps[wps.length - 1] : first || sc;
  const p0 = first || clipToShape(s, aimS[0], aimS[1]);
  const pN = last || clipToShape(t, aimT[0], aimT[1]);
  return [p0, ...wps.map(p => [p[0], p[1]]), pN];
}

function anchorsFor(shape, port) {
  if (port) {
    const p = portPoint(shape, port);
    if (p) return [p];
  }
  const cx = shape.x + shape.width / 2;
  const cy = shape.y + shape.height / 2;
  return [
    [cx, shape.y],
    [shape.x + shape.width, cy],
    [cx, shape.y + shape.height],
    [shape.x, cy],
  ];
}

function orthogonalRoute(c, s, t, shapes) {
  const obstacles = shapes.map(e => {
    const b = aabbOf(e);
    return { l: b.left, r: b.right, t: b.top, b: b.bottom };
  });
  const sAnchors = anchorsFor(s, c.source && c.source.port);
  const tAnchors = anchorsFor(t, c.target && c.target.port);
  const wps = (c.waypoints || []).map(p => [p[0], p[1]]);

  // Grid is built from obstacle edges, anchors, waypoints and a margin around everything.
  const xs = new Set();
  const ys = new Set();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const o of obstacles) {
    xs.add(o.l); xs.add(o.r); ys.add(o.t); ys.add(o.b);
    minX = Math.min(minX, o.l); maxX = Math.max(maxX, o.r);
    minY = Math.min(minY, o.t); maxY = Math.max(maxY, o.b);
  }
  for (const p of [...sAnchors, ...tAnchors, ...wps]) {
    xs.add(p[0]); ys.add(p[1]);
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
  }
  if (!Number.isFinite(minX)) return straightRoute(c, s, t);
  xs.add(minX - MARGIN); xs.add(maxX + MARGIN);
  ys.add(minY - MARGIN); ys.add(maxY + MARGIN);
  const X = [...xs].sort((a, b) => a - b);
  const Y = [...ys].sort((a, b) => a - b);
  const nx = X.length, ny = Y.length;
  const N = nx * ny;
  const idx = (i, j) => i * ny + j;

  const blocked = new Uint8Array(N);
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const x = X[i], y = Y[j];
      for (const o of obstacles) {
        if (x > o.l && x < o.r && y > o.t && y < o.b) { blocked[idx(i, j)] = 1; break; }
      }
    }
  }

  const segBlocked = (x1, y1, x2, y2) => {
    const lx = Math.min(x1, x2), hx = Math.max(x1, x2);
    const ly = Math.min(y1, y2), hy = Math.max(y1, y2);
    for (const o of obstacles) {
      if (hx > o.l && lx < o.r && hy > o.t && ly < o.b) return true;
    }
    return false;
  };

  const nodeOf = (p) => {
    const i = X.indexOf(p[0]);
    const j = Y.indexOf(p[1]);
    return i < 0 || j < 0 ? -1 : idx(i, j);
  };

  // Sequence of stops: source anchors, each waypoint, target anchors.
  const stops = [sAnchors, ...wps.map(p => [p]), tAnchors];
  const full = [];
  for (let k = 0; k + 1 < stops.length; k++) {
    const from = stops[k].map(nodeOf).filter(n => n >= 0 && !blocked[n]);
    const to = stops[k + 1].map(nodeOf).filter(n => n >= 0 && !blocked[n]);
    let leg = null;
    if (from.length && to.length) {
      leg = searchLeg(from, to, nx, ny, X, Y, blocked, segBlocked);
    }
    if (!leg) {
      // Fallback: L-shaped connection between the first anchors of each stop.
      const a = stops[k][0], b = stops[k + 1][0];
      leg = [a, [b[0], a[1]], b];
    }
    for (let m = 0; m < leg.length; m++) {
      if (full.length && sameXY(full[full.length - 1], leg[m])) continue;
      full.push(leg[m]);
    }
  }
  return simplify(full);
}

function sameXY(a, b) {
  return a[0] === b[0] && a[1] === b[1];
}

// Remove collinear interior points.
function simplify(pts) {
  if (pts.length <= 2) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const p = out[out.length - 1];
    const q = pts[i], r = pts[i + 1];
    const collinear = (p[0] === q[0] && q[0] === r[0]) || (p[1] === q[1] && q[1] === r[1]);
    if (!collinear) out.push(q);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// Dijkstra over (node, direction) states with a bend penalty.
function searchLeg(fromNodes, toNodes, nx, ny, X, Y, blocked, segBlocked) {
  const N = nx * ny;
  const S = N * 5; // state = node*5 + (dir+1), dir -1 = none
  const dist = new Float64Array(S).fill(Infinity);
  const prev = new Int32Array(S).fill(-1);
  const isTarget = new Uint8Array(N);
  for (const n of toNodes) isTarget[n] = 1;

  const heap = [];
  const push = (cost, state) => {
    heap.push([cost, state]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };

  for (const n of fromNodes) {
    const st = n * 5 + 0;
    dist[st] = 0;
    push(0, st);
  }

  let goal = -1;
  while (heap.length) {
    const [cost, st] = pop();
    if (cost > dist[st]) continue;
    const node = Math.floor(st / 5);
    const dirIdx = (st % 5) - 1;
    if (isTarget[node]) { goal = st; break; }
    const i = Math.floor(node / ny);
    const j = node % ny;
    for (let d = 0; d < 4; d++) {
      const ni = i + DIRS[d][0];
      const nj = j + DIRS[d][1];
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
      const nn = ni * ny + nj;
      if (blocked[nn]) continue;
      if (segBlocked(X[i], Y[j], X[ni], Y[nj])) continue;
      const len = Math.abs(X[ni] - X[i]) + Math.abs(Y[nj] - Y[j]);
      const bend = dirIdx >= 0 && dirIdx !== d ? BEND_COST : 0;
      const nc = cost + len + bend;
      const nst = nn * 5 + (d + 1);
      if (nc < dist[nst]) {
        dist[nst] = nc;
        prev[nst] = st;
        push(nc, nst);
      }
    }
  }
  if (goal < 0) return null;
  const path = [];
  for (let s = goal; s >= 0; s = prev[s]) {
    const node = Math.floor(s / 5);
    path.push([X[Math.floor(node / ny)], Y[node % ny]]);
  }
  path.reverse();
  return path;
}
