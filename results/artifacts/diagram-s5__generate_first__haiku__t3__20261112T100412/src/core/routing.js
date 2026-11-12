import { centerOf, clipToBoundary, portPoint } from './geometry.js';

const BEND_COST = 50;
const MARGIN = 100;
const DIRS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const NO_DIR = 4;

export const toPt = (p) => (Array.isArray(p) ? { x: p[0], y: p[1] } : { x: p.x, y: p.y });

/** Midpoints of the four sides of a box: top, right, bottom, left. */
export function sidePoints(el) {
  const { x, y, width: w, height: h } = el;
  return [
    { x: x + w / 2, y },
    { x: x + w, y: y + h / 2 },
    { x: x + w / 2, y: y + h },
    { x, y: y + h / 2 },
  ];
}

export function straightRoute(src, tgt, wps, srcPort, tgtPort) {
  const sc = centerOf(src);
  const tc = centerOf(tgt);
  const first = wps[0] ?? tc;
  const last = wps[wps.length - 1] ?? sc;
  const start = portPoint(src, srcPort) ?? clipToBoundary(src, first.x, first.y);
  const end = portPoint(tgt, tgtPort) ?? clipToBoundary(tgt, last.x, last.y);
  return [start, ...wps, end].map((p) => [p.x, p.y]);
}

/** Removes duplicate points and points that lie between two collinear neighbours. */
export function simplify(points) {
  const dedup = [];
  for (const p of points) {
    const q = dedup[dedup.length - 1];
    if (!q || q[0] !== p[0] || q[1] !== p[1]) dedup.push(p);
  }
  const out = [];
  for (let i = 0; i < dedup.length; i++) {
    if (i > 0 && i < dedup.length - 1) {
      const a = dedup[i - 1];
      const b = dedup[i];
      const c = dedup[i + 1];
      const sameX = a[0] === b[0] && b[0] === c[0];
      const sameY = a[1] === b[1] && b[1] === c[1];
      if (sameX || sameY) continue;
    }
    out.push(dedup[i]);
  }
  return out;
}

class MinHeap {
  constructor() {
    this.c = [];
    this.s = [];
  }

  get size() {
    return this.c.length;
  }

  push(cost, state) {
    const c = this.c;
    const s = this.s;
    c.push(cost);
    s.push(state);
    let i = c.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (c[p] <= c[i]) break;
      [c[p], c[i]] = [c[i], c[p]];
      [s[p], s[i]] = [s[i], s[p]];
      i = p;
    }
  }

  pop() {
    const c = this.c;
    const s = this.s;
    const top = [c[0], s[0]];
    const lc = c.pop();
    const ls = s.pop();
    if (c.length > 0) {
      c[0] = lc;
      s[0] = ls;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < c.length && c[l] < c[m]) m = l;
        if (r < c.length && c[r] < c[m]) m = r;
        if (m === i) break;
        [c[m], c[i]] = [c[i], c[m]];
        [s[m], s[i]] = [s[i], s[m]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Orthogonal routing on the grid formed by all box edges (plus margins and anchor lines).
 * Returns an array of [x, y] points or null when no route exists.
 */
export function orthogonalRoute({ obstacles, src, tgt, wps, srcPort, tgtPort }) {
  const boxes = obstacles.map((o) => ({ x0: o.x, y0: o.y, x1: o.x + o.width, y1: o.y + o.height }));
  const xsSet = new Set();
  const ysSet = new Set();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const b of boxes) {
    xsSet.add(b.x0);
    xsSet.add(b.x1);
    ysSet.add(b.y0);
    ysSet.add(b.y1);
    minX = Math.min(minX, b.x0);
    minY = Math.min(minY, b.y0);
    maxX = Math.max(maxX, b.x1);
    maxY = Math.max(maxY, b.y1);
  }
  if (boxes.length === 0) return null;
  xsSet.add(minX - MARGIN);
  xsSet.add(maxX + MARGIN);
  ysSet.add(minY - MARGIN);
  ysSet.add(maxY + MARGIN);

  const srcPt = portPoint(src, srcPort);
  const tgtPt = portPoint(tgt, tgtPort);
  const srcStarts = srcPt ? [srcPt] : sidePoints(src);
  const tgtGoals = tgtPt ? [tgtPt] : sidePoints(tgt);
  for (const p of [...srcStarts, ...tgtGoals, ...wps]) {
    xsSet.add(p.x);
    ysSet.add(p.y);
  }
  const xs = [...xsSet].sort((a, b) => a - b);
  const ys = [...ysSet].sort((a, b) => a - b);
  const NX = xs.length;
  const NY = ys.length;
  const xi = new Map(xs.map((v, i) => [v, i]));
  const yi = new Map(ys.map((v, i) => [v, i]));

  const inside = (x, y) => boxes.some((b) => x > b.x0 && x < b.x1 && y > b.y0 && y < b.y1);
  const valid = new Uint8Array(NX * NY);
  for (let ix = 0; ix < NX; ix++) {
    for (let iy = 0; iy < NY; iy++) valid[ix * NY + iy] = inside(xs[ix], ys[iy]) ? 0 : 1;
  }
  const edgeCache = new Int8Array(NX * NY * 4).fill(-1);
  const edgeOk = (node, d) => {
    const k = node * 4 + d;
    if (edgeCache[k] !== -1) return edgeCache[k] === 1;
    const ix = Math.floor(node / NY);
    const iy = node % NY;
    const nx = ix + DIRS[d][0];
    const ny = iy + DIRS[d][1];
    let ok = nx >= 0 && ny >= 0 && nx < NX && ny < NY;
    if (ok) {
      const mx = (xs[ix] + xs[nx]) / 2;
      const my = (ys[iy] + ys[ny]) / 2;
      ok = !inside(mx, my);
    }
    edgeCache[k] = ok ? 1 : 0;
    return ok;
  };
  const nodeOf = (p) => {
    const a = xi.get(p.x);
    const b = yi.get(p.y);
    return a === undefined || b === undefined ? -1 : a * NY + b;
  };

  const search = (startNodes, goalNodes) => {
    const S = NX * NY * 5;
    const dist = new Float64Array(S).fill(Infinity);
    const prev = new Int32Array(S).fill(-1);
    const heap = new MinHeap();
    for (const n of startNodes) {
      if (n < 0 || !valid[n]) continue;
      const st = n * 5 + NO_DIR;
      if (dist[st] > 0) {
        dist[st] = 0;
        heap.push(0, st);
      }
    }
    while (heap.size) {
      const [c, st] = heap.pop();
      if (c > dist[st]) continue;
      const node = Math.floor(st / 5);
      const dir = st % 5;
      if (goalNodes.has(node)) {
        const nodes = [];
        for (let cur = st; cur !== -1; cur = prev[cur]) nodes.push(Math.floor(cur / 5));
        nodes.reverse();
        return nodes.map((n) => [xs[Math.floor(n / NY)], ys[n % NY]]);
      }
      const ix = Math.floor(node / NY);
      const iy = node % NY;
      for (let d = 0; d < 4; d++) {
        if (!edgeOk(node, d)) continue;
        const nx = ix + DIRS[d][0];
        const ny = iy + DIRS[d][1];
        const nb = nx * NY + ny;
        if (!valid[nb]) continue;
        const len = d < 2 ? Math.abs(xs[nx] - xs[ix]) : Math.abs(ys[ny] - ys[iy]);
        const turn = dir !== NO_DIR && dir !== d ? BEND_COST : 0;
        const nc = c + len + turn;
        const ns = nb * 5 + d;
        if (nc < dist[ns]) {
          dist[ns] = nc;
          prev[ns] = st;
          heap.push(nc, ns);
        }
      }
    }
    return null;
  };

  const srcNodes = srcStarts.map(nodeOf);
  const tgtNodes = new Set(tgtGoals.map(nodeOf));
  if (srcNodes.some((n) => n < 0) || tgtNodes.has(-1)) return null;
  if (src.id !== undefined && src.id === tgt.id) return null;

  let points = null;
  if (wps.length === 0) {
    points = search(srcNodes, tgtNodes);
  } else {
    const wpNodes = wps.map(nodeOf);
    if (wpNodes.some((n) => n < 0)) return null;
    points = search(srcNodes, new Set([wpNodes[0]]));
    for (let i = 0; i < wpNodes.length && points; i++) {
      const goal = i + 1 < wpNodes.length ? new Set([wpNodes[i + 1]]) : tgtNodes;
      const seg = search([wpNodes[i]], goal);
      if (!seg) {
        points = null;
        break;
      }
      points = points.concat(seg.slice(1));
    }
  }
  if (!points) return null;
  return simplify(points);
}

/** Orthogonal L-shaped fallback used when no grid route exists. */
export function fallbackRoute(src, tgt, wps, srcPort, tgtPort) {
  if (src.id !== undefined && src.id === tgt.id) {
    const r = src.x + src.width;
    const b = src.y + src.height;
    const cx = src.x + src.width / 2;
    return [
      [r, src.y + src.height / 2],
      [r + 30, src.y + src.height / 2],
      [r + 30, b + 30],
      [cx, b + 30],
      [cx, b],
    ];
  }
  const first = wps[0] ?? centerOf(tgt);
  const last = wps[wps.length - 1] ?? centerOf(src);
  const start = portPoint(src, srcPort) ?? clipToBoundary(src, first.x, first.y);
  const end = portPoint(tgt, tgtPort) ?? clipToBoundary(tgt, last.x, last.y);
  const raw = [start, ...wps, end].map((p) => [p.x, p.y]);
  const out = [raw[0]];
  for (let i = 1; i < raw.length; i++) {
    const a = out[out.length - 1];
    const b = raw[i];
    if (a[0] !== b[0] && a[1] !== b[1]) out.push([b[0], a[1]]);
    out.push(b);
  }
  return simplify(out);
}
