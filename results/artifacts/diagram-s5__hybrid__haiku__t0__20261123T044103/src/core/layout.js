// Auto-layout: layered (Sugiyama-style) for DAGs and grid. Returns Map<id, {x,y}>.
import { DiagramError } from './errors.js';

export function layoutLayered(nodes, edges, opts = {}) {
  const dir = opts.direction ?? 'TB';
  const spacing = opts.spacing ?? 40;
  if (!['TB', 'BT', 'LR', 'RL'].includes(dir)) throw new DiagramError(`unknown direction ${dir}`);
  const n = nodes.length;
  const result = new Map();
  if (!n) return result;
  const idx = new Map(nodes.map((nd, i) => [nd.id, i]));
  const E = [];
  for (const e of edges) {
    const u = idx.get(e.source.elementId);
    const v = idx.get(e.target.elementId);
    if (u !== undefined && v !== undefined && u !== v) E.push([u, v]);
  }

  // Cycle removal: reverse back edges found by DFS (input order).
  const out = Array.from({ length: n }, () => []);
  E.forEach(([u], k) => out[u].push(k));
  const color = new Uint8Array(n);
  const reversed = new Uint8Array(E.length);
  for (let s = 0; s < n; s++) {
    if (color[s]) continue;
    const stack = [[s, 0]];
    color[s] = 1;
    while (stack.length) {
      const top = stack[stack.length - 1];
      const u = top[0];
      if (top[1] < out[u].length) {
        const k = out[u][top[1]++];
        const v = E[k][1];
        if (color[v] === 1) reversed[k] = 1;
        else if (color[v] === 0) { color[v] = 1; stack.push([v, 0]); }
      } else {
        color[u] = 2;
        stack.pop();
      }
    }
  }
  const D = E.map(([u, v], k) => (reversed[k] ? [v, u] : [u, v]));
  const succs = Array.from({ length: n }, () => []);
  const preds = Array.from({ length: n }, () => []);
  for (const [u, v] of D) { succs[u].push(v); preds[v].push(u); }

  // Longest-path layering.
  const indeg = new Array(n).fill(0);
  for (const [, v] of D) indeg[v]++;
  const layerOf = new Array(n).fill(0);
  const queue = [];
  for (let i = 0; i < n; i++) if (indeg[i] === 0) queue.push(i);
  for (let qi = 0; qi < queue.length; qi++) {
    const u = queue[qi];
    for (const v of succs[u]) {
      layerOf[v] = Math.max(layerOf[v], layerOf[u] + 1);
      if (--indeg[v] === 0) queue.push(v);
    }
  }
  const L = Math.max(...layerOf) + 1;
  const layers = Array.from({ length: L }, () => []);
  for (let i = 0; i < n; i++) layers[layerOf[i]].push(i); // input order baseline

  const posOf = new Array(n).fill(0);
  const reindex = (cur) => {
    for (const layer of cur) layer.forEach((node, p) => { posOf[node] = p; });
  };
  const countCrossings = (cur) => {
    reindex(cur);
    const groups = new Map();
    for (const [u, v] of D) {
      if (layerOf[v] !== layerOf[u] + 1) continue;
      const key = layerOf[u];
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push([posOf[u], posOf[v]]);
    }
    let c = 0;
    for (const list of groups.values()) {
      for (let a = 0; a < list.length; a++) {
        for (let b = a + 1; b < list.length; b++) {
          if ((list[a][0] - list[b][0]) * (list[a][1] - list[b][1]) < 0) c++;
        }
      }
    }
    return c;
  };
  const reorderLayer = (cur, k, nbrs, refLayer) => {
    const rank = new Map(cur[k].map((node, p) => [node, p]));
    const keyed = cur[k].map((node) => {
      const ns = nbrs[node].filter((m) => layerOf[m] === refLayer);
      const bary = ns.length ? ns.reduce((s, m) => s + posOf[m], 0) / ns.length : rank.get(node);
      return { node, bary, r: rank.get(node) };
    });
    keyed.sort((a, b) => a.bary - b.bary || a.r - b.r);
    cur[k] = keyed.map((x) => x.node);
    reindex(cur);
  };

  let cur = layers.map((l) => l.slice());
  let best = cur.map((l) => l.slice());
  let bestC = countCrossings(cur);
  for (let it = 0; it < 24 && bestC > 0; it++) {
    if (it % 2 === 0) {
      for (let k = 1; k < L; k++) reorderLayer(cur, k, preds, k - 1);
    } else {
      for (let k = L - 2; k >= 0; k--) reorderLayer(cur, k, succs, k + 1);
    }
    const c = countCrossings(cur);
    if (c < bestC) { bestC = c; best = cur.map((l) => l.slice()); }
  }

  // Coordinates.
  const minX = Math.min(...nodes.map((nd) => nd.x));
  const minY = Math.min(...nodes.map((nd) => nd.y));
  const horizontalLayers = dir === 'LR' || dir === 'RL'; // layers run along x
  const reverse = dir === 'BT' || dir === 'RL';
  const withinSize = (i) => (horizontalLayers ? nodes[i].height : nodes[i].width);
  const layerSize = (i) => (horizontalLayers ? nodes[i].width : nodes[i].height);
  const extents = best.map((layer) => {
    const total = layer.reduce((s, i) => s + withinSize(i), 0) + spacing * Math.max(layer.length - 1, 0);
    const thick = layer.reduce((m, i) => Math.max(m, layerSize(i)), 0);
    return { total, thick };
  });
  const maxWithin = Math.max(...extents.map((e) => e.total));
  const order = best.map((_, k) => k);
  if (reverse) order.reverse();
  let cursor = 0;
  for (const k of order) {
    let offset = (maxWithin - extents[k].total) / 2;
    for (const i of best[k]) {
      const along = offset;   // position inside the layer
      const across = cursor;  // position of the layer
      result.set(nodes[i].id, horizontalLayers
        ? { x: minX + across, y: minY + along }
        : { x: minX + along, y: minY + across });
      offset += withinSize(i) + spacing;
    }
    cursor += extents[k].thick + spacing;
  }
  return result;
}

export function layoutGrid(nodes, opts = {}) {
  const spacing = opts.spacing ?? 40;
  const result = new Map();
  const n = nodes.length;
  if (!n) return result;
  const cols = Math.ceil(Math.sqrt(n));
  const cellW = Math.max(...nodes.map((nd) => nd.width)) + spacing;
  const cellH = Math.max(...nodes.map((nd) => nd.height)) + spacing;
  const minX = Math.min(...nodes.map((nd) => nd.x));
  const minY = Math.min(...nodes.map((nd) => nd.y));
  nodes.forEach((nd, i) => {
    const c = i % cols;
    const r = Math.floor(i / cols);
    result.set(nd.id, { x: minX + c * cellW, y: minY + r * cellH });
  });
  return result;
}
