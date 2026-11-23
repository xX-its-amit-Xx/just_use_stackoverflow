// Importer for uncompressed draw.io / mxGraph XML.
import { DiagramError, newId } from './errors.js';

import { createDocument } from './document.js';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(s) {
  return String(s).replace(/&(#x[0-9a-fA-F]+|#\d+|\w+);/g, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return ENTITIES[e] ?? m;
  });
}

function label(v) {
  if (!v) return '';
  return decode(String(v).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''));
}

// Minimal XML tree parser (elements, attributes, text is ignored except for structure).
function parseXML(xml) {
  const root = { name: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[2] === undefined) continue; // comment / declaration
    if (m[1] === '/') {
      if (stack.length > 1) stack.pop();
      continue;
    }
    const attrs = {};
    const ar = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
    let a;
    while ((a = ar.exec(m[3]))) attrs[a[1]] = decode(a[2] ?? a[3]);
    const node = { name: m[2], attrs, children: [] };
    stack[stack.length - 1].children.push(node);
    if (!m[4]) stack.push(node);
  }
  return root;
}

function walk(node, fn) {
  for (const c of node.children) { fn(c); walk(c, fn); }
}

function parseStyle(s) {
  const out = {};
  for (const part of String(s ?? '').split(';')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    if (eq < 0) out[part] = true;
    else out[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return out;
}

const STYLE_MAP = {
  fillColor: 'fill',
  strokeColor: 'stroke',
  strokeWidth: 'strokeWidth',
  fontSize: 'fontSize',
  fontFamily: 'fontFamily',
  fontColor: 'fontColor',
  opacity: 'opacity',
};

function mapStyle(st) {
  const out = {};
  for (const [k, v] of Object.entries(st)) {
    if (STYLE_MAP[k] === undefined || v === true) continue;
    const val = ['strokeWidth', 'fontSize', 'opacity'].includes(STYLE_MAP[k]) ? Number(v) : v;
    if (typeof val === 'number' && Number.isNaN(val)) continue;
    out[STYLE_MAP[k]] = val;
  }
  return out;
}

export function importDrawio(xml, opts = {}) {
  if (typeof xml !== 'string') throw new DiagramError('draw.io XML must be a string');
  const root = parseXML(xml);
  const cells = new Map();
  walk(root, (n) => {
    if (n.name === 'mxCell') cells.set(n.attrs.id, { node: n, attrs: n.attrs, geom: null });
  });
  if (!cells.size) throw new DiagramError('no mxCell elements found');
  for (const c of cells.values()) {
    const g = c.node.children.find((x) => x.name === 'mxGeometry');
    c.geom = g ? g.attrs : null;
    c.points = [];
    if (g) {
      const arr = g.children.find((x) => x.name === 'Array');
      for (const p of arr?.children ?? []) {
        if (p.name === 'mxPoint') c.points.push([Number(p.attrs.x ?? 0), Number(p.attrs.y ?? 0)]);
      }
    }
  }
  // Absolute origin of each cell (containers add their own geometry offset).
  const absOrigin = (id, depth = 0) => {
    const c = cells.get(id);
    if (!c || depth > 50 || !c.attrs.vertex || !c.attrs.parent || c.attrs.parent === '0' || c.attrs.parent === '1') return [0, 0];
    const p = absOrigin(c.attrs.parent, depth + 1);
    return [p[0] + Number(c.geom?.x ?? 0), p[1] + Number(c.geom?.y ?? 0)];
  };

  const doc = createDocument({ id: opts.id ?? newId('doc'), actor: opts.actor ?? 'import' });
  const elementIds = new Set();
  doc.transaction(() => {
    for (const [id, c] of cells) {
      if (!c.attrs.vertex || !c.geom) continue;
      const st = parseStyle(c.attrs.style);
      let type = 'rect';
      if (st.ellipse !== undefined || st.shape === 'ellipse') type = 'ellipse';
      else if (st.rhombus !== undefined || st.shape === 'rhombus') type = 'diamond';
      else if (st.text !== undefined && st.text !== '0') type = 'text';
      else if (st.shape === 'image' || st.image) type = 'image';
      else if (st.shape === 'line') type = 'line';
      const [ox, oy] = absOrigin(id);
      const el = {
        id,
        type,
        x: Number(c.geom.x ?? 0) + ox,
        y: Number(c.geom.y ?? 0) + oy,
        width: Number(c.geom.width ?? 0),
        height: Number(c.geom.height ?? 0),
        rotation: Number(st.rotation ?? 0),
        style: mapStyle(st),
        text: label(c.attrs.value),
      };
      if (type === 'image' && st.image) el.src = decode(st.image);
      doc.apply({ type: 'add', element: el });
      elementIds.add(id);
    }
    for (const [id, c] of cells) {
      if (!c.attrs.edge) continue;
      const s = c.attrs.source;
      const t = c.attrs.target;
      if (!elementIds.has(s) || !elementIds.has(t)) continue;
      const st = parseStyle(c.attrs.style);
      doc.apply({
        type: 'add',
        element: {
          id,
          type: 'connector',
          source: { elementId: s },
          target: { elementId: t },
          routing: st.edgeStyle && String(st.edgeStyle).includes('orthogonal') ? 'orthogonal' : 'straight',
          waypoints: c.points,
          label: label(c.attrs.value),
          style: mapStyle(st),
        },
      });
    }
  });
  return doc;
}
