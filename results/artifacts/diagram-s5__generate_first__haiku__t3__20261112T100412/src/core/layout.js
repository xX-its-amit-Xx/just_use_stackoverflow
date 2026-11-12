/**
 * Layered (Sugiyama-style) layout.
 * nodes: [{id, width, height}] in input order; edges: [{from, to}] (ids).
 * Returns Map id -> {x, y} (top-left corners).
 */
export function layeredPositions(nodes, edges, { direction = 'TB', spacing = 40 } = {}) {
  const N = nodes.length;
  const pos = new Map();
  if (N === 0) return pos;
  const idx = new Map(nodes.map((n, i) => [n.id, i]));

  // 1. Break cycles: keep only edges that do not close a DFS back-edge.
  const out = Array.from({ length: N }, () => []);
  for (const e of edges) {
    const a = idx.get(e.from);
    const b = idx.get(e.to);
    if (a === undefined || b === undefined || a === b) continue;
    if (!out[a].includes(b)) out[a].push(b);
  }
  const state = new Uint8Array(N);
  const dag = Array.from({ length: N }, () => []);
  const dfs = (u) => {
    state[u] = 1;
    for (const v of out[u]) {
      if (state[v] === 1) continue; // back edge: dropped
      dag[u].push(v);
      if (state[v] === 0) dfs(v);
    }
    state[u] = 2;
  };
  for (let i = 0; i < N; i++) if (state[i] === 0) dfs(i);

  // 2. Longest-path ranking (every DAG edge goes to a strictly higher rank).
  const indeg = new Array(N).fill(0);
  for (let u = 0; u < N; u++) for (const v of dag[u]) indeg[v]++;
  const rank = new Array(N).fill(0);
  const queue = [];
  for (let i = 0; i < N; i++) if (indeg[i] === 0) queue.push(i);
  for (let q = 0; q < queue.length; q++) {
    const u = queue[q];
    for (const v of dag[u]) {
      rank[v] = Math.max(rank[v], rank[u] + 1);
      if (--indeg[v] === 0) queue.push(v);
    }
  }
  const R = Math.max(...rank) + 1;
  const preds = Array.from({ length: N }, () => []);
  for (let u = 0; u < N; u++) for (const v of dag[u]) preds[v].push(u);

  // 3. Initial order = input order within each rank, then barycentre sweeps.
  let layers = Array.from({ length: R }, () => []);
  for (let i = 0; i < N; i++) layers[rank[i]].push(i);

  const positionsOf = (ls) => {
    const p = new Array(N).fill(0);
    for (const layer of ls) layer.forEach((n, i) => (p[n] = i));
    return p;
  };
  const crossings = (ls) => {
    const p = positionsOf(ls);
    let count = 0;
    for (let r = 0; r + 1 < ls.length; r++) {
      const es = [];
      for (const u of ls[r]) for (const v of dag[u]) if (rank[v] === r + 1) es.push([p[u], p[v]]);
      for (let i = 0; i < es.length; i++) {
        for (let j = i + 1; j < es.length; j++) {
          const d1 = es[i][0] - es[j][0];
          const d2 = es[i][1] - es[j][1];
          if (d1 * d2 < 0) count++;
        }
      }
    }
    return count;
  };

  let best = layers.map((l) => l.slice());
  let bestCross = crossings(best);
  const succs = dag;
  for (let iter = 0; iter < 12 && bestCross > 0; iter++) {
    const cur = layers.map((l) => l.slice());
    if (iter % 2 === 0) {
      for (let r = 1; r < R; r++) {
        const p = positionsOf(cur);
        cur[r] = sortByBary(cur[r], (n) => preds[n], p);
      }
    } else {
      for (let r = R - 2; r >= 0; r--) {
        const p = positionsOf(cur);
        cur[r] = sortByBary(cur[r], (n) => succs[n], p);
      }
    }
    layers = cur;
    const c = crossings(layers);
    if (c < bestCross) {
      bestCross = c;
      best = layers.map((l) => l.slice());
    }
  }
  layers = best;

  // 4. Coordinates.
  const minX = Math.min(...nodes.map((n) => n.x ?? 0));
  const minY = Math.min(...nodes.map((n) => n.y ?? 0));
  const origin = { x: Number.isFinite(minX) ? minX : 0, y: Number.isFinite(minY) ? minY : 0 };
  const vertical = direction !== 'LR';
  // "along" = within-rank axis, "across" = rank axis.
  const along = (n) => (vertical ? nodes[n].width : nodes[n].height);
  const across = (n) => (vertical ? nodes[n].height : nodes[n].width);
  const bands = layers.map((l) => l.reduce((m, n) => Math.max(m, across(n)), 0));
  const lengths = layers.map((l) => l.reduce((s, n) => s + along(n), 0) + spacing * Math.max(0, l.length - 1));
  const maxLen = Math.max(0, ...lengths);
  let cursor = 0;
  layers.forEach((layer, r) => {
    let a = (maxLen - lengths[r]) / 2;
    for (const n of layer) {
      const bandOffset = (bands[r] - across(n)) / 2;
      const alongPos = origin[vertical ? 'x' : 'y'] + a;
      const acrossPos = origin[vertical ? 'y' : 'x'] + cursor + bandOffset;
      pos.set(nodes[n].id, vertical ? { x: alongPos, y: acrossPos } : { x: acrossPos, y: alongPos });
      a += along(n) + spacing;
    }
    cursor += bands[r] + spacing;
  });
  return pos;
}

function sortByBary(layer, neighbours, p) {
  const keyed = layer.map((n, i) => {
    const ns = neighbours(n);
    const bary = ns.length ? ns.reduce((s, m) => s + p[m], 0) / ns.length : p[n];
    return { n, bary, i };
  });
  keyed.sort((a, b) => a.bary - b.bary || a.i - b.i);
  return keyed.map((k) => k.n);
}

/** Grid layout: nodes in input order, row-major, cell size from the largest node. */
export function gridPositions(nodes, { spacing = 40 } = {}) {
  const pos = new Map();
  if (nodes.length === 0) return pos;
  const cols = Math.ceil(Math.sqrt(nodes.length));
  const cellW = Math.max(...nodes.map((n) => n.width)) + spacing;
  const cellH = Math.max(...nodes.map((n) => n.height)) + spacing;
  const ox = Math.min(...nodes.map((n) => n.x ?? 0));
  const oy = Math.min(...nodes.map((n) => n.y ?? 0));
  nodes.forEach((n, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    pos.set(n.id, { x: ox + c * cellW, y: oy + r * cellH });
  });
  return pos;
}
