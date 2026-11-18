// Auto-layout algorithms. They return Map<id, {x, y}> of top-left positions and do not
// touch the document themselves.

/**
 * Layered (Sugiyama-style) layout for directed graphs.
 * nodes: [{id, width, height}] in input order; edges: [{from, to}].
 * Edges that point against the layering are reversed for layering only (cycle breaking).
 */
export function layeredLayout({ nodes, edges, direction = 'TB', spacing = 40, origin = { x: 0, y: 0 } }) {
  const N = nodes.length;
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const outAdj = Array.from({ length: N }, () => []);
  for (const e of edges) {
    const u = index.get(e.from);
    const v = index.get(e.to);
    if (u === undefined || v === undefined || u === v) continue;
    outAdj[u].push(v);
  }

  // 1. Cycle breaking by DFS: back edges are reversed.
  const state = new Uint8Array(N);
  const dag = [];
  const visit = (u) => {
    state[u] = 1;
    for (const v of outAdj[u]) {
      if (state[v] === 1) {
        dag.push([v, u]);
      } else {
        if (state[v] === 0) visit(v);
        dag.push([u, v]);
      }
    }
    state[u] = 2;
  };
  for (let u = 0; u < N; u++) if (state[u] === 0) visit(u);

  // 2. Longest-path layering via topological order (Kahn).
  const succ = Array.from({ length: N }, () => []);
  const indeg = new Array(N).fill(0);
  for (const [u, v] of dag) {
    succ[u].push(v);
    indeg[v]++;
  }
  const rank = new Array(N).fill(0);
  const queue = [];
  for (let u = 0; u < N; u++) if (indeg[u] === 0) queue.push(u);
  for (let q = 0; q < queue.length; q++) {
    const u = queue[q];
    for (const v of succ[u]) {
      rank[v] = Math.max(rank[v], rank[u] + 1);
      if (--indeg[v] === 0) queue.push(v);
    }
  }

  // 3. Dummy nodes for edges spanning several ranks.
  const allRank = rank.slice();
  const segments = []; // [fromNode, toNode] between consecutive ranks
  const isDummy = new Array(N).fill(false);
  for (const [u, v] of dag) {
    let prev = u;
    const span = rank[v] - rank[u];
    for (let k = 1; k < span; k++) {
      const d = allRank.length;
      allRank.push(rank[u] + k);
      isDummy.push(true);
      segments.push([prev, d]);
      prev = d;
    }
    segments.push([prev, v]);
  }
  const total = allRank.length;
  const R = allRank.length ? Math.max(...allRank) + 1 : 0;
  const layers = Array.from({ length: R }, () => []);
  for (let u = 0; u < total; u++) layers[allRank[u]].push(u); // ascending id = input order

  const upNbrs = Array.from({ length: total }, () => []);
  const downNbrs = Array.from({ length: total }, () => []);
  for (const [a, b] of segments) {
    downNbrs[a].push(b);
    upNbrs[b].push(a);
  }

  const positions = () => {
    const pos = new Array(total);
    for (const layer of layers) layer.forEach((u, k) => (pos[u] = k));
    return pos;
  };
  const crossings = () => {
    const pos = positions();
    let count = 0;
    for (let r = 0; r + 1 < R; r++) {
      const segs = [];
      for (const u of layers[r]) for (const v of downNbrs[u]) segs.push([pos[u], pos[v]]);
      for (let i = 0; i < segs.length; i++) {
        for (let j = i + 1; j < segs.length; j++) {
          const d1 = segs[i][0] - segs[j][0];
          const d2 = segs[i][1] - segs[j][1];
          if (d1 * d2 < 0) count++;
        }
      }
    }
    return count;
  };

  // 4. Barycentre sweeps; keep the best ordering seen (never worse than input order).
  let best = layers.map((l) => l.slice());
  let bestCross = crossings();
  for (let iter = 0; iter < 12 && bestCross > 0; iter++) {
    const down = iter % 2 === 0;
    const order = down ? [...Array(R).keys()].slice(1) : [...Array(R).keys()].slice(0, R - 1).reverse();
    for (const r of order) {
      const pos = positions();
      const nbrs = down ? upNbrs : downNbrs;
      const key = new Map();
      for (const u of layers[r]) {
        const ps = nbrs[u].map((w) => pos[w]);
        key.set(u, ps.length ? ps.reduce((s, p) => s + p, 0) / ps.length : pos[u]);
      }
      layers[r].sort((a, b) => key.get(a) - key.get(b) || a - b);
    }
    const c = crossings();
    if (c < bestCross) {
      bestCross = c;
      best = layers.map((l) => l.slice());
    }
  }
  for (let r = 0; r < R; r++) layers[r] = best[r];

  // 5. Coordinates. Vertical (TB): ranks are rows; LR swaps the roles.
  const horizontal = direction !== 'LR';
  const extent = (u) => {
    if (isDummy[u]) return { along: 0, across: 0 };
    const n = nodes[u];
    return horizontal ? { along: n.width, across: n.height } : { along: n.height, across: n.width };
  };
  const bandSize = layers.map((layer) => Math.max(0, ...layer.map((u) => extent(u).across)));
  const bandStart = [];
  let cursor = horizontal ? origin.y : origin.x;
  for (let r = 0; r < R; r++) {
    bandStart.push(cursor);
    cursor += bandSize[r] + spacing;
  }
  const rowLen = layers.map((layer) => {
    if (layer.length === 0) return 0;
    return layer.reduce((s, u) => s + extent(u).along, 0) + spacing * (layer.length - 1);
  });
  const maxRow = Math.max(0, ...rowLen);
  const out = new Map();
  for (let r = 0; r < R; r++) {
    let along = (horizontal ? origin.x : origin.y) + (maxRow - rowLen[r]) / 2;
    for (const u of layers[r]) {
      const ext = extent(u);
      if (!isDummy[u]) {
        const band = bandSize[r];
        const acrossOff = (band - ext.across) / 2;
        const a = along;
        const b = bandStart[r] + acrossOff;
        const n = nodes[u];
        out.set(n.id, horizontal ? { x: a, y: b } : { x: b, y: a });
      }
      along += ext.along + spacing;
    }
  }
  return out;
}

/** Grid layout: nodes in input order, row-major in ceil(sqrt(n)) columns, centred in cells. */
export function gridLayout({ nodes, spacing = 40, origin = { x: 0, y: 0 } }) {
  const out = new Map();
  if (nodes.length === 0) return out;
  const cols = Math.ceil(Math.sqrt(nodes.length));
  const cellW = Math.max(...nodes.map((n) => n.width)) + spacing;
  const cellH = Math.max(...nodes.map((n) => n.height)) + spacing;
  nodes.forEach((n, k) => {
    const c = k % cols;
    const r = Math.floor(k / cols);
    out.set(n.id, {
      x: origin.x + c * cellW + (cellW - spacing - n.width) / 2,
      y: origin.y + r * cellH + (cellH - spacing - n.height) / 2,
    });
  });
  return out;
}
