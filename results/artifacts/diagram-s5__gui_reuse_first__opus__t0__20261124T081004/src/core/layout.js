// Auto-layout algorithms (original code): Sugiyama-style layered layout and grid layout.

/** Count crossings between two adjacent layers given the edges between them. */
function crossingsBetween(upper, lower, edgesDown) {
  const posU = new Map(upper.map((v, i) => [v, i]));
  const posL = new Map(lower.map((v, i) => [v, i]));
  const es = [];
  for (const v of upper) for (const w of edgesDown.get(v) || []) if (posL.has(w)) es.push([posU.get(v), posL.get(w)]);
  let c = 0;
  for (let a = 0; a < es.length; a++) for (let b = a + 1; b < es.length; b++) {
    const [u1, l1] = es[a], [u2, l2] = es[b];
    if ((u1 - u2) * (l1 - l2) < 0) c++;
  }
  return c;
}

function totalCrossings(layers, edgesDown) {
  let c = 0;
  for (let i = 0; i + 1 < layers.length; i++) c += crossingsBetween(layers[i], layers[i + 1], edgesDown);
  return c;
}

/**
 * nodes: [{id, width, height, x, y}] in input order; edges: [[sourceId, targetId]].
 * Returns Map id -> {x, y}.
 */
export function layeredLayout(nodes, edges, opts = {}) {
  const dir = String(opts.direction || 'TB').toUpperCase() === 'LR' ? 'LR' : 'TB';
  const spacing = Number.isFinite(+opts.spacing) && +opts.spacing > 0 ? +opts.spacing : 40;
  const ids = nodes.map(n => n.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  const byId = new Map(nodes.map(n => [n.id, n]));
  // dedupe edges and drop self loops
  const seen = new Set();
  let E = [];
  for (const [s, t] of edges) {
    if (s === t || !index.has(s) || !index.has(t)) continue;
    const k = s + '\u0000' + t;
    if (seen.has(k)) continue;
    seen.add(k); E.push([s, t]);
  }
  // 1. cycle removal (DFS, reverse back edges)
  const out = new Map(ids.map(id => [id, []]));
  for (const [s, t] of E) out.get(s).push(t);
  const state = new Map();
  const reversed = new Set();
  const dfs = (v) => {
    state.set(v, 1);
    for (const w of out.get(v)) {
      if (state.get(w) === 1) reversed.add(v + '\u0000' + w);
      else if (!state.get(w)) dfs(w);
    }
    state.set(v, 2);
  };
  for (const id of ids) if (!state.get(id)) dfs(id);
  E = E.map(([s, t]) => (reversed.has(s + '\u0000' + t) ? [t, s] : [s, t]));
  // 2. longest-path layering
  const preds = new Map(ids.map(id => [id, []]));
  const succs = new Map(ids.map(id => [id, []]));
  for (const [s, t] of E) { preds.get(t).push(s); succs.get(s).push(t); }
  const layerOf = new Map();
  const indeg = new Map(ids.map(id => [id, preds.get(id).length]));
  const queue = ids.filter(id => indeg.get(id) === 0);
  for (const id of queue) layerOf.set(id, 0);
  while (queue.length) {
    const v = queue.shift();
    for (const w of succs.get(v)) {
      layerOf.set(w, Math.max(layerOf.get(w) ?? 0, layerOf.get(v) + 1));
      indeg.set(w, indeg.get(w) - 1);
      if (indeg.get(w) === 0) queue.push(w);
    }
  }
  for (const id of ids) if (!layerOf.has(id)) layerOf.set(id, 0);
  // pull sources down towards their successors (tighter layering)
  for (const id of [...ids].reverse()) {
    if (preds.get(id).length === 0 && succs.get(id).length > 0) {
      const m = Math.min(...succs.get(id).map(w => layerOf.get(w))) - 1;
      if (m > layerOf.get(id)) layerOf.set(id, m);
    }
  }
  const nLayers = Math.max(0, ...layerOf.values()) + 1;
  // 3. dummy nodes
  const edgesDown = new Map();
  const addDown = (a, b) => { if (!edgesDown.has(a)) edgesDown.set(a, []); edgesDown.get(a).push(b); };
  const edgesUp = new Map();
  const addUp = (b, a) => { if (!edgesUp.has(b)) edgesUp.set(b, []); edgesUp.get(b).push(a); };
  const layers = Array.from({ length: nLayers }, () => []);
  const sortKey = new Map();
  for (const id of ids) { layers[layerOf.get(id)].push(id); sortKey.set(id, index.get(id)); }
  let dummyN = 0;
  const isDummy = new Set();
  for (const [s, t] of E) {
    let prev = s;
    const ls = layerOf.get(s), lt = layerOf.get(t);
    for (let l = ls + 1; l < lt; l++) {
      const d = '\u0000d' + dummyN++;
      isDummy.add(d); layers[l].push(d); layerOf.set(d, l);
      sortKey.set(d, (index.get(s) + index.get(t)) / 2 + 0.5);
      addDown(prev, d); addUp(d, prev); prev = d;
    }
    addDown(prev, t); addUp(t, prev);
  }
  for (const L of layers) L.sort((a, b) => sortKey.get(a) - sortKey.get(b));
  // 4. crossing minimisation: barycenter sweeps + adjacent transpositions; keep best
  const clone = ls => ls.map(l => l.slice());
  let best = clone(layers), bestC = totalCrossings(layers, edgesDown);
  let cur = clone(layers);
  const bary = (L, ref, nbrs) => {
    const pos = new Map(ref.map((v, i) => [v, i]));
    const old = new Map(L.map((v, i) => [v, i]));
    const val = new Map();
    for (const v of L) {
      const ns = (nbrs.get(v) || []).filter(w => pos.has(w));
      val.set(v, ns.length ? ns.reduce((a, w) => a + pos.get(w), 0) / ns.length : old.get(v));
    }
    L.sort((a, b) => val.get(a) - val.get(b) || old.get(a) - old.get(b));
  };
  const transpose = (ls) => {
    let improved = true, guard = 0;
    while (improved && guard++ < 20) {
      improved = false;
      for (let l = 0; l < ls.length; l++) {
        for (let i = 0; i + 1 < ls[l].length; i++) {
          const before = (l > 0 ? crossingsBetween(ls[l - 1], ls[l], edgesDown) : 0) + (l + 1 < ls.length ? crossingsBetween(ls[l], ls[l + 1], edgesDown) : 0);
          [ls[l][i], ls[l][i + 1]] = [ls[l][i + 1], ls[l][i]];
          const after = (l > 0 ? crossingsBetween(ls[l - 1], ls[l], edgesDown) : 0) + (l + 1 < ls.length ? crossingsBetween(ls[l], ls[l + 1], edgesDown) : 0);
          if (after < before) improved = true;
          else [ls[l][i], ls[l][i + 1]] = [ls[l][i + 1], ls[l][i]];
        }
      }
    }
  };
  for (let it = 0; it < 24 && bestC > 0; it++) {
    if (it % 2 === 0) for (let l = 1; l < cur.length; l++) bary(cur[l], cur[l - 1], edgesUp);
    else for (let l = cur.length - 2; l >= 0; l--) bary(cur[l], cur[l + 1], edgesDown);
    transpose(cur);
    const c = totalCrossings(cur, edgesDown);
    if (c < bestC) { bestC = c; best = clone(cur); }
  }
  // 5. coordinates
  const main = n => (dir === 'TB' ? n.height : n.width); // size along layer axis
  const cross = n => (dir === 'TB' ? n.width : n.height); // size along in-layer axis
  const size = v => (isDummy.has(v) ? 0 : cross(byId.get(v)));
  const pos = new Map(); // centre along in-layer axis
  for (const L of best) {
    let c = 0;
    for (const v of L) { const s = size(v); pos.set(v, c + s / 2); c += s + spacing; }
  }
  // align to neighbours a few rounds while preserving order and separation
  const place = (L, ref, nbrs) => {
    const desired = L.map(v => {
      const ns = (nbrs.get(v) || []).filter(w => ref.includes(w));
      return ns.length ? ns.reduce((a, w) => a + pos.get(w), 0) / ns.length : pos.get(v);
    });
    const res = desired.slice();
    for (let i = 1; i < L.length; i++) {
      const minC = res[i - 1] + size(L[i - 1]) / 2 + spacing + size(L[i]) / 2;
      if (res[i] < minC) res[i] = minC;
    }
    // shift block back towards desired mean
    const shift = (desired.reduce((a, b) => a + b, 0) - res.reduce((a, b) => a + b, 0)) / (L.length || 1);
    L.forEach((v, i) => pos.set(v, res[i] + shift));
  };
  for (let r = 0; r < 4; r++) {
    for (let l = 1; l < best.length; l++) place(best[l], best[l - 1], edgesUp);
    for (let l = best.length - 2; l >= 0; l--) place(best[l], best[l + 1], edgesDown);
  }
  // layer offsets along main axis
  const origin = opts.origin || { x: 0, y: 0 };
  let minCross = Infinity;
  for (const L of best) for (const v of L) minCross = Math.min(minCross, pos.get(v) - size(v) / 2);
  if (!Number.isFinite(minCross)) minCross = 0;
  const result = new Map();
  let offset = 0;
  for (const L of best) {
    const real = L.filter(v => !isDummy.has(v));
    const band = Math.max(0, ...real.map(v => main(byId.get(v))));
    for (const v of real) {
      const n = byId.get(v);
      const c = pos.get(v) - minCross - cross(n) / 2;
      const m = offset + (band - main(n)) / 2;
      result.set(v, dir === 'TB' ? { x: origin.x + c, y: origin.y + m } : { x: origin.x + m, y: origin.y + c });
    }
    offset += band + spacing;
  }
  return result;
}

export function gridLayout(nodes, opts = {}) {
  const spacing = Number.isFinite(+opts.spacing) && +opts.spacing >= 0 ? +opts.spacing : 40;
  const n = nodes.length;
  const cols = Math.max(1, Math.floor(+opts.columns || +opts.cols || Math.ceil(Math.sqrt(n))));
  const cw = Math.max(0, ...nodes.map(e => e.width)) + spacing;
  const ch = Math.max(0, ...nodes.map(e => e.height)) + spacing;
  const origin = opts.origin || { x: 0, y: 0 };
  const res = new Map();
  nodes.forEach((e, i) => {
    const c = i % cols, r = Math.floor(i / cols);
    res.set(e.id, { x: origin.x + c * cw, y: origin.y + r * ch });
  });
  return res;
}
