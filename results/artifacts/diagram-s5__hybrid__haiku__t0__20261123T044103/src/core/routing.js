// Connector routing: straight polylines and orthogonal (Hanan-grid Dijkstra) routes.
import { DiagramError } from './errors.js';
import { aabb, boundaryPoint, center, portPoint } from './geometry.js';

const BEND_COST = 60;
const MARGIN = 100;

export function routeConnector(items, conn) {
  const src = items.get(conn.source.elementId);
  const tgt = items.get(conn.target.elementId);
  if (!src || !tgt || src.type === 'connector' || tgt.type === 'connector') {
    throw new DiagramError('connector endpoints must reference existing shapes');
  }
  const wps = (conn.waypoints ?? []).map((p) => [p[0], p[1]]);
  return conn.routing === 'orthogonal'
    ? orthogonal(items, conn, src, tgt, wps)
    : straight(conn, src, tgt, wps);
}

function straight(conn, src, tgt, wps) {
  const sp = conn.source.port ? portPoint(src, conn.source.port) : null;
  const tp = conn.target.port ? portPoint(tgt, conn.target.port) : null;
  const toward0 = wps[0] ?? tp ?? center(tgt);
  const first = sp ?? boundaryPoint(src, toward0);
  const toward1 = wps.length ? wps[wps.length - 1] : first;
  const last = tp ?? boundaryPoint(tgt, toward1);
  return [first, ...wps, last];
}

function sides(b) {
  return [
    [b.x + b.width / 2, b.y],
    [b.x + b.width, b.y + b.height / 2],
    [b.x + b.width / 2, b.y + b.height],
    [b.x, b.y + b.height / 2],
  ];
}

function endpointSet(el, port) {
  if (port) {
    const p = portPoint(el, port);
    if (p) return [p];
  }
  return sides(aabb(el));
}

function orthogonal(items, conn, src, tgt, wps) {
  const obstacles = [];
  for (const e of items.values()) {
    if (e.type === 'connector') continue;
    const b = aabb(e);
    obstacles.push({ l: b.x, r: b.x + b.width, t: b.y, b: b.y + b.height });
  }
  if (!obstacles.length) return straight(conn, src, tgt, wps);
  const bounds = {
    l: Math.min(...obstacles.map((o) => o.l)) - MARGIN,
    r: Math.max(...obstacles.map((o) => o.r)) + MARGIN,
    t: Math.min(...obstacles.map((o) => o.t)) - MARGIN,
    b: Math.max(...obstacles.map((o) => o.b)) + MARGIN,
  };
  const sets = [
    endpointSet(src, conn.source.port),
    ...wps.map((p) => [p]),
    endpointSet(tgt, conn.target.port),
  ];
  let path = [];
  for (let i = 0; i < sets.length - 1; i++) {
    const leg = gridRoute(obstacles, bounds, sets[i], sets[i + 1]) ?? elbow(sets[i][0], sets[i + 1][0]);
    path = path.length ? path.concat(leg.slice(1)) : leg.slice();
  }
  return simplify(path);
}

function elbow(a, b) {
  if (a[0] === b[0] || a[1] === b[1]) return [a, b];
  return [a, [b[0], a[1]], b];
}

function simplify(points) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    out.push(p);
  }
  const res = [];
  for (let i = 0; i < out.length; i++) {
    const prev = res[res.length - 1];
    const next = out[i + 1];
    const p = out[i];
    if (prev && next && ((prev[0] === p[0] && p[0] === next[0]) || (prev[1] === p[1] && p[1] === next[1]))) continue;
    res.push(p);
  }
  return res;
}

// Minimal binary heap keyed on cost.
class Heap {
  constructor() { this.a = []; }
  push(cost, s) {
    const a = this.a;
    a.push([cost, s]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  get size() { return this.a.length; }
}

// Shortest orthogonal path on the Hanan grid of obstacle/point coordinates.
function gridRoute(obstacles, bounds, fromPts, toPts) {
  const xsSet = new Set([bounds.l, bounds.r]);
  const ysSet = new Set([bounds.t, bounds.b]);
  for (const o of obstacles) { xsSet.add(o.l); xsSet.add(o.r); ysSet.add(o.t); ysSet.add(o.b); }
  for (const p of [...fromPts, ...toPts]) { xsSet.add(p[0]); ysSet.add(p[1]); }
  const xs = [...xsSet].sort((a, b) => a - b);
  const ys = [...ysSet].sort((a, b) => a - b);
  const xi = new Map(xs.map((v, i) => [v, i]));
  const yi = new Map(ys.map((v, i) => [v, i]));
  const NX = xs.length;
  const NY = ys.length;
  const N = NX * NY;

  const blocked = new Uint8Array(N);
  for (let i = 0; i < NX; i++) {
    for (let j = 0; j < NY; j++) {
      const x = xs[i];
      const y = ys[j];
      for (const o of obstacles) {
        if (x > o.l && x < o.r && y > o.t && y < o.b) { blocked[i * NY + j] = 1; break; }
      }
    }
  }
  // hBlk[i*NY+j]: edge (i,j)-(i+1,j) blocked; vBlk[i*(NY-1)+j]: edge (i,j)-(i,j+1) blocked
  const hBlk = new Uint8Array(Math.max(NX - 1, 0) * NY);
  for (let i = 0; i < NX - 1; i++) {
    for (let j = 0; j < NY; j++) {
      const y = ys[j];
      for (const o of obstacles) {
        if (y > o.t && y < o.b && o.l < xs[i + 1] && o.r > xs[i]) { hBlk[i * NY + j] = 1; break; }
      }
    }
  }
  const vBlk = new Uint8Array(NX * Math.max(NY - 1, 0));
  for (let i = 0; i < NX; i++) {
    for (let j = 0; j < NY - 1; j++) {
      const x = xs[i];
      for (const o of obstacles) {
        if (x > o.l && x < o.r && o.t < ys[j + 1] && o.b > ys[j]) { vBlk[i * (NY - 1) + j] = 1; break; }
      }
    }
  }

  const goal = new Uint8Array(N);
  for (const p of toPts) {
    const i = xi.get(p[0]);
    const j = yi.get(p[1]);
    if (i !== undefined && j !== undefined && !blocked[i * NY + j]) goal[i * NY + j] = 1;
  }
  const dist = new Float64Array(N * 5).fill(Infinity);
  const prev = new Int32Array(N * 5).fill(-1);
  const heap = new Heap();
  for (const p of fromPts) {
    const i = xi.get(p[0]);
    const j = yi.get(p[1]);
    if (i === undefined || j === undefined) continue;
    const node = i * NY + j;
    if (blocked[node]) continue;
    const s = node * 5 + 4;
    dist[s] = 0;
    heap.push(0, s);
  }
  const DX = [1, -1, 0, 0];
  const DY = [0, 0, 1, -1];
  while (heap.size) {
    const [d, s] = heap.pop();
    if (d > dist[s]) continue;
    const node = Math.floor(s / 5);
    const dir = s % 5;
    if (goal[node]) {
      const pts = [];
      let cur = s;
      while (cur !== -1) {
        const nd = Math.floor(cur / 5);
        pts.push([xs[Math.floor(nd / NY)], ys[nd % NY]]);
        cur = prev[cur];
      }
      return pts.reverse();
    }
    const i = Math.floor(node / NY);
    const j = node % NY;
    for (let k = 0; k < 4; k++) {
      const ni = i + DX[k];
      const nj = j + DY[k];
      if (ni < 0 || nj < 0 || ni >= NX || nj >= NY) continue;
      const nn = ni * NY + nj;
      if (blocked[nn]) continue;
      let edgeBlocked;
      if (k === 0) edgeBlocked = hBlk[i * NY + j];
      else if (k === 1) edgeBlocked = hBlk[ni * NY + nj];
      else if (k === 2) edgeBlocked = vBlk[i * (NY - 1) + j];
      else edgeBlocked = vBlk[i * (NY - 1) + nj];
      if (edgeBlocked) continue;
      const len = Math.abs(xs[ni] - xs[i]) + Math.abs(ys[nj] - ys[j]);
      const cost = d + len + (dir !== 4 && dir !== k ? BEND_COST : 0);
      const ns = nn * 5 + k;
      if (cost < dist[ns]) {
        dist[ns] = cost;
        prev[ns] = s;
        heap.push(cost, ns);
      }
    }
  }
  return null;
}


