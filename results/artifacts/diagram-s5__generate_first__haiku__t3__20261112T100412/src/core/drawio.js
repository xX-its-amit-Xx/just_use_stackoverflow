import { DiagramError } from './errors.js';
import { DiagramDocument } from './document.js';

const DECODE = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g, (m, g) => {
    if (g[0] === '#') {
      const code = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return DECODE[g];
  });
}

function parseAttrs(src) {
  const attrs = {};
  const re = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(src))) attrs[m[1]] = decodeEntities(m[2] ?? m[3] ?? '');
  return attrs;
}

/** Minimal XML tree builder (elements and attributes only), sufficient for mxGraph files. */
export function parseXml(xml) {
  const root = { name: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re =
    /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<![^>]*>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[A-Za-z_:][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (!m[2]) continue; // comment, processing instruction, doctype
    if (m[1]) {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const node = { name: m[2], attrs: parseAttrs(m[3] ?? ''), children: [] };
    stack[stack.length - 1].children.push(node);
    if (!m[4]) stack.push(node);
  }
  return root;
}

function parseStyle(style) {
  const out = { shape: null, flags: new Set(), kv: {} };
  for (const tok of String(style ?? '').split(';')) {
    if (!tok) continue;
    const eq = tok.indexOf('=');
    if (eq === -1) out.flags.add(tok);
    else out.kv[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  return out;
}

const STYLE_MAP = {
  fillColor: ['fill', 'str'],
  strokeColor: ['stroke', 'str'],
  strokeWidth: ['strokeWidth', 'num'],
  fontSize: ['fontSize', 'num'],
  fontFamily: ['font', 'str'],
  fontColor: ['fontColor', 'str'],
  opacity: ['opacity', 'num'],
};

function mapStyle(parsed) {
  const out = {};
  for (const [k, [name, kind]] of Object.entries(STYLE_MAP)) {
    if (parsed.kv[k] === undefined || parsed.kv[k] === 'none') continue;
    if (kind === 'num') {
      const v = Number(parsed.kv[k]);
      if (Number.isFinite(v)) out[name] = v;
    } else {
      out[name] = parsed.kv[k];
    }
  }
  return out;
}

function shapeTypeOf(parsed) {
  const kv = parsed.kv;
  if (parsed.flags.has('rhombus') || kv.shape === 'rhombus') return 'diamond';
  if (parsed.flags.has('ellipse') || parsed.flags.has('circle') || kv.shape === 'ellipse') return 'ellipse';
  if (parsed.flags.has('text') || kv.text === '1' || kv.shape === 'text') return 'text';
  if (parsed.flags.has('image') || kv.shape === 'image') return 'image';
  if (kv.shape === 'line' || parsed.flags.has('line')) return 'line';
  return 'rect';
}

function stripHtml(s) {
  return decodeEntities(String(s ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, ''));
}

function collectCells(node, wrapper, out) {
  for (const child of node.children) {
    if (child.name === 'mxCell') {
      out.push({ cell: child, wrapper });
    } else if (child.name === 'object' || child.name === 'UserObject') {
      collectCells(child, child, out);
    } else {
      collectCells(child, null, out);
    }
  }
  return out;
}

/**
 * Imports uncompressed draw.io (mxGraph) XML into a new document.
 * vertices -> shapes (rhombus -> diamond), edges -> connectors, labels and geometry kept.
 */
export function importDrawio(xml, opts = {}) {
  if (typeof xml !== 'string' || !xml.includes('mxCell')) throw new DiagramError('not a draw.io document');
  if (/<diagram[^>]*>\s*[A-Za-z0-9+/=]{40,}\s*<\/diagram>/.test(xml)) {
    throw new DiagramError('compressed draw.io diagrams are not supported');
  }
  const tree = parseXml(xml);
  const cells = collectCells(tree, null, []).map(({ cell, wrapper }) => {
    const geo = cell.children.find((c) => c.name === 'mxGeometry');
    return {
      id: cell.attrs.id ?? wrapper?.attrs.id,
      parent: cell.attrs.parent,
      value: cell.attrs.value ?? wrapper?.attrs.label ?? '',
      style: cell.attrs.style ?? '',
      vertex: cell.attrs.vertex === '1',
      edge: cell.attrs.edge === '1',
      source: cell.attrs.source,
      target: cell.attrs.target,
      geo,
    };
  });
  const byId = new Map(cells.filter((c) => c.id !== undefined).map((c) => [c.id, c]));
  const isRoot = (id) => id === undefined || id === '0' || id === '1' || !byId.has(id);
  const offsetOf = (c) => {
    let x = 0;
    let y = 0;
    let p = byId.get(c.parent);
    const seen = new Set();
    while (p && !isRoot(p.id) && !seen.has(p.id)) {
      seen.add(p.id);
      if (p.vertex && p.geo) {
        x += Number(p.geo.attrs.x ?? 0) || 0;
        y += Number(p.geo.attrs.y ?? 0) || 0;
      }
      p = byId.get(p.parent);
    }
    return { x, y };
  };

  const doc = new DiagramDocument({ id: opts.id ?? 'import', actor: opts.actor ?? 'import' });
  const shapeIds = new Set();
  for (const c of cells) {
    if (!c.vertex || c.id === undefined || c.edge) continue;
    const g = c.geo?.attrs ?? {};
    const off = offsetOf(c);
    const parsed = parseStyle(c.style);
    const element = {
      id: c.id,
      type: shapeTypeOf(parsed),
      x: (Number(g.x) || 0) + off.x,
      y: (Number(g.y) || 0) + off.y,
      width: Number(g.width) || 0,
      height: Number(g.height) || 0,
      text: stripHtml(c.value),
      style: mapStyle(parsed),
    };
    doc.apply({ type: 'add', element });
    shapeIds.add(c.id);
  }
  for (const c of cells) {
    if (!c.edge || c.id === undefined) continue;
    if (!shapeIds.has(c.source) || !shapeIds.has(c.target)) continue;
    const parsed = parseStyle(c.style);
    const pts = [];
    const arr = c.geo?.children.find((ch) => ch.name === 'Array' && ch.attrs.as === 'points');
    for (const p of arr?.children ?? []) {
      if (p.name === 'mxPoint') pts.push([Number(p.attrs.x) || 0, Number(p.attrs.y) || 0]);
    }
    doc.apply({
      type: 'add',
      element: {
        id: c.id,
        type: 'connector',
        source: { elementId: c.source },
        target: { elementId: c.target },
        routing: parsed.kv.edgeStyle !== undefined || parsed.flags.has('orthogonalEdgeStyle') ? 'orthogonal' : 'straight',
        waypoints: pts,
        label: stripHtml(c.value),
        style: mapStyle(parsed),
      },
    });
  }
  // The import's ops stay in the pending buffer so a caller can ship them to a server.
  return doc;
}
