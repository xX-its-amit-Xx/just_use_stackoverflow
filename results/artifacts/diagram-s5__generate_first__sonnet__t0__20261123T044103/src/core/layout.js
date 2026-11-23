// Auto layout: layered (Sugiyama-style) and grid.

function countCrossings(layers, edges) {
  // edges between adjacent layers: [u,v] where layer(v)=layer(u)+1
  let total = 0;
  const posOf = new Map();
  layers.forEach((l) => l.forEach((n, i) => posOf.set(n, i)));
  const byLayer = new Map();
  for (const [u, v] of edges) {
    const lu = layers.findIndex((l) => l.includes(u));
    if (!byLayer.has(lu)) byLayer.set(lu, []);
    byLayer.get(lu).push([posOf.get(u), posOf.get(v)]);
  }
  for (const list of byLayer.values()) {
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const [a, b] = list[i], [c, d] = list[j];
      if ((a - c) * (b - d) < 0) total++;
    }
  }
  return total;
}

export function layoutLayered(shapes, connectors, opts = {}) {
  const dir = opts.direction === 'LR' ? 'LR' : 'TB';
  const spacing = typeof opts.spacing === 'number' ? opts.spacing : 50;
  const ids = shapes.map((s) => s.id);
  const idSet = new Set(ids);
  const nodeBox = new Map(shapes.map((s) => [s.id, s]));
  let edges = [];
  const seen = new Set();
  for (const c of connectors) {
    const u = c.source?.elementId, v = c.target?.elementId;
    if (!idSet.has(u) || !idSet.has(v) || u === v) continue;
    const k = u + '\0' + v;
    if (seen.has(k)) continue;
    seen.add(k);
    edges.push([u, v]);
  }
  // break cycles via DFS (reverse back edges)
  const adj = new Map(ids.map((i) => [i, []]));
  edges.forEach(([u, v]) => adj.get(u).push(v));
  const state = new Map();
  const back = new Set();
  const dfs = (u) => {
    state.set(u, 1);
    for (const v of adj.get(u)) {
      if (state.get(v) === 1) back.add(u + '\0' + v);
      else if (!state.get(v)) dfs(v);
    }
    state.set(u, 2);
  };
  for (const i of ids) if (!state.get(i)) dfs(i);
  edges = edges.map(([u, v]) => (back.has(u + '\0' + v) ? [v, u] : [u, v]));
  // longest path layering
  const preds = new Map(ids.map((i) => [i, []]));
  const succs = new Map(ids.map((i) => [i, []]));
  edges.forEach(([u, v]) => { preds.get(v).push(u); succs.get(u).push(v); });
  const rank = new Map();
  const rk = (n) => {
    if (rank.has(n)) return rank.get(n);
    rank.set(n, 0);
    let r = 0;
    for (const p of preds.get(n)) r = Math.max(r, rk(p) + 1);
    rank.set(n, r);
    return r;
  };
  ids.forEach(rk);
  const maxRank = Math.max(0, ...ids.map((i) => rank.get(i)));
  // dummy nodes for long edges
  const layers = Array.from({ length: maxRank + 1 }, () => []);
  ids.forEach((i) => layers[rank.get(i)].push(i));
  const segs = [];
  let dn = 0;
  for (const [u, v] of edges) {
    let last = u;
    for (let r = rank.get(u) + 1; r < rank.get(v); r++) {
      const d = `\0d${dn++}`;
      layers[r].push(d);
      segs.push([last, d]);
      last = d;
    }
    segs.push([last, v]);
  }
  // crossing minimisation: barycenter sweeps, keep best (initial order included)
  const snapshot = () => layers.map((l) => [...l]);
  let best = snapshot();
  let bestC = countCrossings(layers, segs);
  const sortLayer = (li, ref, usePred) => {
    const posRef = new Map(layers[ref].map((n, i) => [n, i]));
    const bary = new Map();
    layers[li].forEach((n, i) => {
      const ns = segs.filter((s) => (usePred ? s[1] === n : s[0] === n)).map((s) => posRef.get(usePred ? s[0] : s[1])).filter((x) => x !== undefined);
      bary.set(n, ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : i);
    });
    const orig = new Map(layers[li].map((n, i) => [n, i]));
    layers[li].sort((a, b) => bary.get(a) - bary.get(b) || orig.get(a) - orig.get(b));
  };
  for (let it = 0; it < 12 && bestC > 0; it++) {
    for (let l = 1; l < layers.length; l++) sortLayer(l, l - 1, true);
    let c = countCrossings(layers, segs);
    if (c < bestC) { bestC = c; best = snapshot(); }
    for (let l = layers.length - 2; l >= 0; l--) sortLayer(l, l + 1, false);
    c = countCrossings(layers, segs);
    if (c < bestC) { bestC = c; best = snapshot(); }
  }
  // coordinates
  const sizeAlong = (n) => (nodeBox.has(n) ? (dir === 'TB' ? nodeBox.get(n).width : nodeBox.get(n).height) : 0);
  const sizeAcross = (n) => (nodeBox.has(n) ? (dir === 'TB' ? nodeBox.get(n).height : nodeBox.get(n).width) : 0);
  const extents = best.map((l) => l.reduce((s, n) => s + sizeAlong(n), 0) + Math.max(0, l.length - 1) * spacing);
  const widest = Math.max(0, ...extents);
  const origin = shapes.length ? { x: Math.min(...shapes.map((s) => s.x)), y: Math.min(...shapes.map((s) => s.y)) } : { x: 0, y: 0 };
  const out = new Map();
  let offset = 0;
  best.forEach((l, li) => {
    let cur = (widest - extents[li]) / 2;
    const thick = Math.max(0, ...l.map(sizeAcross));
    for (const n of l) {
      if (nodeBox.has(n)) {
        const a = cur, b = offset;
        out.set(n, dir === 'TB' ? { x: origin.x + a, y: origin.y + b } : { x: origin.x + b, y: origin.y + a });
      }
      cur += sizeAlong(n) + spacing;
    }
    offset += thick + spacing;
  });
  return out;
}

export function layoutGrid(shapes, opts = {}) {
  const spacing = typeof opts.spacing === 'number' ? opts.spacing : 40;
  const out = new Map();
  if (!shapes.length) return out;
  const cols = opts.columns || Math.ceil(Math.sqrt(shapes.length));
  const cw = Math.max(...shapes.map((s) => s.width)) + spacing;
  const ch = Math.max(...shapes.map((s) => s.height)) + spacing;
  const ox = Math.min(...shapes.map((s) => s.x)), oy = Math.min(...shapes.map((s) => s.y));
  shapes.forEach((s, i) => out.set(s.id, { x: ox + (i % cols) * cw, y: oy + Math.floor(i / cols) * ch }));
  return out;
}
