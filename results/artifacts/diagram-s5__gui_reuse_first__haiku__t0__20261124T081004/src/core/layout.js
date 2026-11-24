// Layout wrappers. The layered (Sugiyama-style) layout delegates to the vendored dagre
// bundle in src/vendor/dagre (MIT, see src/THIRD_PARTY_NOTICES.md).
import dagre from '../vendor/dagre/dagre.esm.js';

// nodes: [{id,width,height}], edges: [{v,w}]. Returns Map id -> {x,y} (top-left corners).
export function layeredLayout(nodes, edges, { direction = 'TB', spacing = 50 } = {}) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: direction === 'LR' ? 'LR' : 'TB',
    nodesep: spacing,
    ranksep: spacing,
    marginx: 0,
    marginy: 0,
  });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) {
    g.setNode(n.id, { width: n.width || 0, height: n.height || 0 });
  }
  for (const e of edges) {
    if (e.v !== e.w && g.hasNode(e.v) && g.hasNode(e.w)) g.setEdge(e.v, e.w, {});
  }
  dagre.layout(g);
  const out = new Map();
  for (const n of nodes) {
    const p = g.node(n.id);
    out.set(n.id, { x: p.x - (n.width || 0) / 2, y: p.y - (n.height || 0) / 2 });
  }
  return out;
}

// Row-major grid, origin at the current top-left of the nodes.
export function gridLayout(nodes, { spacing = 40 } = {}) {
  const out = new Map();
  if (!nodes.length) return out;
  const cols = Math.ceil(Math.sqrt(nodes.length));
  const maxW = Math.max(...nodes.map(n => n.width || 0));
  const maxH = Math.max(...nodes.map(n => n.height || 0));
  const originX = 0;
  const originY = 0;
  nodes.forEach((n, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    out.set(n.id, { x: originX + col * (maxW + spacing), y: originY + row * (maxH + spacing) });
  });
  return out;
}
