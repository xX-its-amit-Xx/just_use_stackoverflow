import { boundaryToward, center, sidePoint, sideName, SIDES, unionBox, aabb } from './geom.js';

const STUB = 12;
const TURN = 30;
const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // up right down left
const SIDE_DIR = { top: 0, right: 1, bottom: 2, left: 3 };
const DIR_SIDE = ['top', 'right', 'bottom', 'left'];

function endpointPoint(end, byId, toward) {
  const el = end?.elementId ? byId.get(end.elementId) : null;
  if (!el) return end && typeof end.x === 'number' ? { p: { x: end.x, y: end.y }, el: null } : null;
  const side = sideName(end.port);
  if (side) return { p: sidePoint(el, side), el, side };
  if (end.port && typeof end.port === 'object' && typeof end.port.x === 'number') {
    return { p: { x: el.x + el.width * end.port.x, y: el.y + el.height * end.port.y }, el };
  }
  return { p: boundaryToward(el, toward), el };
}

export function routeConnector(c, byId, shapes) {
  const sEl = c.source?.elementId ? byId.get(c.source.elementId) : null;
  const tEl = c.target?.elementId ? byId.get(c.target.elementId) : null;
  const sC = sEl ? center(sEl) : c.source;
  const tC = tEl ? center(tEl) : c.target;
  if (!sC || !tC || typeof sC.x !== 'number' || typeof tC.x !== 'number') return [];
  const wps = (c.waypoints || []).map((w) => ({ x: w.x, y: w.y }));
  if (c.routing !== 'orthogonal') {
    const a = endpointPoint(c.source, byId, wps[0] || tC);
    const b = endpointPoint(c.target, byId, wps[wps.length - 1] || sC);
    return [[a.p.x, a.p.y], ...wps.map((w) => [w.x, w.y]), [b.p.x, b.p.y]];
  }
  return orthogonal(c, byId, shapes, sEl, tEl, sC, tC, wps);
}

function orthogonal(c, byId, shapes, sEl, tEl, sC, tC, wps) {
  const obstacles = shapes.map((o) => ({ id: o.id, ...aabb(o) }));
  const all = obstacles.length ? unionBox(obstacles) : { x: 0, y: 0, width: 0, height: 0 };
  const fixedS = sideName(c.source?.port), fixedT = sideName(c.target?.port);

  const pickSides = (fromC, toC) => {
    const dx = toC.x - fromC.x, dy = toC.y - fromC.y;
    const horiz = Math.abs(dx) >= Math.abs(dy);
    const h = dx >= 0 ? 'right' : 'left', v = dy >= 0 ? 'bottom' : 'top';
    return horiz ? [h, v] : [v, h];
  };
  const opposite = (s) => ({ top: 'bottom', bottom: 'top', left: 'right', right: 'left' }[s]);
  const sTarget = wps[0] || tC, tTarget = wps[wps.length - 1] || sC;
  const [sp, sa] = pickSides(sC, sTarget);
  const [tp, ta] = pickSides(tC, tTarget);
  const sCands = fixedS ? [fixedS] : [sp, sa];
  const tCands = fixedT ? [fixedT] : [tp, ta];

  let best = null;
  for (const ss of sCands) {
    for (const ts of tCands) {
      const r = tryRoute(sEl, tEl, c, ss, ts, obstacles, all, wps);
      if (r && (!best || r.cost < best.cost)) best = r;
    }
  }
  if (best) return best.pts;
  // fallback: simple manhattan
  const a = sEl ? sidePoint(sEl, sp) : sC, b = tEl ? sidePoint(tEl, opposite(sp) === tp ? tp : tp) : tC;
  const pts = [[a.x, a.y], [a.x, b.y], [b.x, b.y]];
  return dedupe(pts);
}

function tryRoute(sEl, tEl, c, ss, ts, obstacles, all, wps) {
  const S = sEl ? sidePoint(sEl, ss) : { x: c.source.x, y: c.source.y };
  const E = tEl ? sidePoint(tEl, ts) : { x: c.target.x, y: c.target.y };
  const sd = SIDE_DIR[ss], td = SIDE_DIR[ts];
  const S2 = sEl ? { x: S.x + DIRS[sd][0] * STUB, y: S.y + DIRS[sd][1] * STUB } : S;
  const E2 = tEl ? { x: E.x + DIRS[td][0] * STUB, y: E.y + DIRS[td][1] * STUB } : E;
  const pts = [S2, ...wps, E2];
  const xsSet = new Set(), ysSet = new Set();
  const M = 100;
  xsSet.add(all.x - M); xsSet.add(all.x + all.width + M); ysSet.add(all.y - M); ysSet.add(all.y + all.height + M);
  for (const p of pts) { xsSet.add(p.x); ysSet.add(p.y); xsSet.add(p.x - 0); }
  for (const o of obstacles) {
    for (const m of [STUB, 0]) {
      xsSet.add(o.x - m); xsSet.add(o.x + o.width + m); ysSet.add(o.y - m); ysSet.add(o.y + o.height + m);
    }
  }
  const addMid = (set) => {
    const a = [...set].sort((x, y) => x - y);
    for (let i = 0; i + 1 < a.length; i++) set.add((a[i] + a[i + 1]) / 2);
    return [...set].sort((x, y) => x - y);
  };
  const xs = addMid(xsSet), ys = addMid(ysSet);
  const xi = new Map(xs.map((v, i) => [v, i])), yi = new Map(ys.map((v, i) => [v, i]));
  let path = [];
  let cost = 0;
  let prevDir = sEl ? sd : -1;
  for (let i = 0; i + 1 < pts.length; i++) {
    const r = astar(xs, ys, xi, yi, obstacles, pts[i], pts[i + 1], prevDir, i + 2 === pts.length && tEl ? td : -1);
    if (!r) return null;
    path = path.concat(i === 0 ? r.path : r.path.slice(1));
    cost += r.cost;
    prevDir = r.lastDir;
  }
  const full = [S, ...path, E];
  // reject if the stub segments themselves cross a foreign obstacle interior
  if (segBlocked(S, S2, obstacles, sEl && sEl.id) || segBlocked(E2, E, obstacles, tEl && tEl.id)) return null;
  return { pts: dedupe(full.map((p) => [p.x, p.y])), cost };
}

function segBlocked(a, b, obstacles, ignoreId) {
  for (const o of obstacles) {
    if (o.id === ignoreId) continue;
    if (a.y === b.y) {
      if (a.y > o.y && a.y < o.y + o.height && Math.max(Math.min(a.x, b.x), o.x) < Math.min(Math.max(a.x, b.x), o.x + o.width)) return true;
    } else if (a.x > o.x && a.x < o.x + o.width && Math.max(Math.min(a.y, b.y), o.y) < Math.min(Math.max(a.y, b.y), o.y + o.height)) return true;
  }
  return false;
}

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
        let l = 2 * i + 1, r = l + 1, m = i;
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

function astar(xs, ys, xi, yi, obstacles, A, B, startDir, endDir) {
  const nx = xs.length;
  const sx = xi.get(A.x), sy = yi.get(A.y), gx = xi.get(B.x), gy = yi.get(B.y);
  if (sx === undefined || sy === undefined || gx === undefined || gy === undefined) return null;
  if (sx === gx && sy === gy) return { path: [A], cost: 0, lastDir: startDir };
  const key = (x, y, d) => ((y * nx + x) << 2) | d;
  const dist = new Map(), prev = new Map();
  const h = (x, y) => Math.abs(xs[x] - xs[gx]) + Math.abs(ys[y] - ys[gy]);
  const heap = new Heap();
  // start: any dir if -1
  const starts = startDir >= 0 ? [startDir] : [0, 1, 2, 3];
  for (const d of starts) { dist.set(key(sx, sy, d), 0); heap.push(h(sx, sy), [sx, sy, d]); }
  while (heap.size) {
    const [, [x, y, d]] = heap.pop();
    const k = key(x, y, d);
    const g = dist.get(k);
    if (x === gx && y === gy) {
      const path = [];
      let cur = k;
      while (cur !== undefined) {
        const d2 = cur & 3, idx = cur >> 2;
        path.push({ x: xs[idx % nx], y: ys[Math.floor(idx / nx)] });
        cur = prev.get(cur);
      }
      path.reverse();
      return { path, cost: g, lastDir: d };
    }
    for (let nd = 0; nd < 4; nd++) {
      if (nd !== d && (nd + 2) % 4 === d && startDir >= 0 && x === sx && y === sy) continue;
      if ((nd + 2) % 4 === d) continue;
      const x2 = x + DIRS[nd][0], y2 = y + DIRS[nd][1];
      if (x2 < 0 || y2 < 0 || x2 >= nx || y2 >= ys.length) continue;
      const a = { x: xs[x], y: ys[y] }, b = { x: xs[x2], y: ys[y2] };
      if (segBlocked(a, b, obstacles, null)) continue;
      let ng = g + Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + (nd !== d ? TURN : 0);
      if (x2 === gx && y2 === gy && endDir >= 0 && nd !== endDir) ng += TURN;
      const nk = key(x2, y2, nd);
      if (!dist.has(nk) || ng < dist.get(nk)) { dist.set(nk, ng); prev.set(nk, k); heap.push(ng + h(x2, y2), [x2, y2, nd]); }
    }
  }
  return null;
}

function dedupe(pts) {
  const out = [];
  for (const p of pts) {
    const l = out[out.length - 1];
    if (l && l[0] === p[0] && l[1] === p[1]) continue;
    out.push(p);
  }
  // remove collinear middle points
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 1; i < out.length - 1; i++) {
      const a = out[i - 1], b = out[i], c = out[i + 1];
      if ((a[0] === b[0] && b[0] === c[0]) || (a[1] === b[1] && b[1] === c[1])) { out.splice(i, 1); changed = true; break; }
    }
  }
  return out;
}
