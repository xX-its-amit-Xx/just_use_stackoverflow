import { DiagramError } from './errors.js';
import { createDocument, DEFAULT_LAYER } from './document.js';
import { parseXml, findAll, decodeEntities } from './xml.js';

const NUMERIC_KEYS = new Set(['strokeWidth', 'fontSize', 'opacity', 'rounded', 'arcSize']);
const RENAME = { fillColor: 'fill', strokeColor: 'stroke' };

// Parse draw.io "a=1;b=2;flag" style strings.
function parseStyle(str) {
  const out = {};
  for (const tok of String(str || '').split(';')) {
    if (!tok) continue;
    const eq = tok.indexOf('=');
    if (eq < 0) {
      out[tok] = true;
      continue;
    }
    const key = tok.slice(0, eq);
    const val = tok.slice(eq + 1);
    const name = RENAME[key] || key;
    if (NUMERIC_KEYS.has(key) && /^-?\d+(\.\d+)?$/.test(val)) out[name] = Number(val);
    else out[name] = val;
  }
  return out;
}

// Convert a draw.io HTML label to plain text.
function plainText(v) {
  return decodeEntities(String(v ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(div|p)>/gi, '\n')
    .replace(/<[^>]+>/g, ''))
    .replace(/\n$/, '');
}

function shapeType(st) {
  if (st.shape === 'ellipse' || st.ellipse) return 'ellipse';
  if (st.shape === 'rhombus' || st.rhombus) return 'diamond';
  if (st.shape === 'image' || st.image !== undefined) return 'image';
  if (st.shape === 'line' || st.line) return 'line';
  if (st.text) return 'text';
  return 'rect';
}

// Imports uncompressed mxGraph XML (as stored in .drawio files) into a new Document.
export function importDrawio(xml, opts = {}) {
  const root = parseXml(String(xml));
  const diagrams = findAll(root, 'diagram');
  const models = findAll(root, 'mxGraphModel');
  if (!models.length) {
    if (diagrams.some(d => d.text.trim())) throw new DiagramError('compressed draw.io diagrams are not supported');
    throw new DiagramError('no mxGraphModel found');
  }
  const cells = new Map();
  const order = [];
  for (const cell of findAll(models[0], 'mxCell')) {
    const a = cell.attrs;
    if (a.id === undefined) continue;
    const geomNode = cell.children.find(c => c.name === 'mxGeometry');
    const pointsArr = geomNode ? geomNode.children.find(c => c.name === 'Array') : undefined;
    const geom = {
      x: Number(geomNode?.attrs.x ?? 0) || 0,
      y: Number(geomNode?.attrs.y ?? 0) || 0,
      width: Number(geomNode?.attrs.width ?? 0) || 0,
      height: Number(geomNode?.attrs.height ?? 0) || 0,
      points: (pointsArr ? pointsArr.children : [])
        .filter(c => c.name === 'mxPoint')
        .map(p => [Number(p.attrs.x) || 0, Number(p.attrs.y) || 0]),
    };
    const rec = {
      id: a.id,
      attrs: a,
      parent: a.parent ?? null,
      vertex: a.vertex === '1',
      edge: a.edge === '1',
      value: a.value ?? '',
      style: parseStyle(a.style),
      geom,
    };
    cells.set(a.id, rec);
    order.push(rec);
  }

  const isLayer = c => c.parent === '0' && !c.vertex && !c.edge && c.id !== '0';
  const layerIds = new Set(order.filter(isLayer).map(c => c.id));

  const absOrigin = c => {
    const p = c.parent ? cells.get(c.parent) : undefined;
    if (!p || !p.vertex) return [0, 0];
    const [px, py] = absOrigin(p);
    return [px + p.geom.x, py + p.geom.y];
  };
  const layerOf = c => {
    let cur = c;
    for (let depth = 0; cur && depth < 1000; depth++) {
      if (layerIds.has(cur.parent)) return cur.parent;
      cur = cur.parent ? cells.get(cur.parent) : undefined;
    }
    return layerIds.size ? [...layerIds][0] : DEFAULT_LAYER;
  };

  const doc = createDocument({ id: opts.id ?? 'imported', actor: opts.actor ?? 'import' });
  for (const c of order.filter(isLayer)) {
    doc.apply({
      type: 'addLayer',
      layer: {
        id: c.id,
        name: plainText(c.value) || c.id,
        visible: c.attrs.visible !== '0',
        locked: false,
      },
    });
  }
  let z = 0;
  const imported = new Set();
  for (const c of order) {
    if (!c.vertex || c.edge) continue;
    const st = c.style;
    const [ox, oy] = absOrigin(c);
    const style = { ...st };
    delete style.rotation;
    const element = {
      id: c.id,
      type: shapeType(st),
      x: c.geom.x + ox,
      y: c.geom.y + oy,
      width: c.geom.width,
      height: c.geom.height,
      rotation: Number.isFinite(Number(st.rotation)) ? Number(st.rotation) : 0,
      text: plainText(c.value),
      style: stripShapeKeys(style),
      layer: layerOf(c),
      z: z++,
    };
    doc.apply({ type: 'add', element });
    imported.add(c.id);
  }

  for (const c of order) {
    if (!c.edge) continue;
    const src = c.attrs.source;
    const tgt = c.attrs.target;
    if (!imported.has(src) || !imported.has(tgt)) continue;
    const element = {
      id: c.id,
      type: 'connector',
      source: { elementId: src },
      target: { elementId: tgt },
      routing: /orthogonalEdgeStyle/.test(c.attrs.style || '') ? 'orthogonal' : 'straight',
      waypoints: c.geom.points,
      label: plainText(c.value),
      style: stripShapeKeys({ ...c.style }),
      layer: layerOf(c),
      z: z++,
    };
    doc.apply({ type: 'add', element });
  }

  // Drop the unused built-in layer when the file defines its own layers.
  if (layerIds.size && doc.elements({ layer: DEFAULT_LAYER }).length === 0) {
    doc.apply({ type: 'removeLayer', id: DEFAULT_LAYER });
  }
  for (const c of order.filter(isLayer)) {
    if (c.attrs.locked === '1') doc.apply({ type: 'updateLayer', id: c.id, patch: { locked: true } });
  }
  return doc;
}

function stripShapeKeys(style) {
  const out = {};
  for (const [k, v] of Object.entries(style)) {
    if (['shape', 'ellipse', 'rhombus', 'text', 'image', 'line', 'edgeStyle', 'html', 'whiteSpace', 'rotation'].includes(k)) continue;
    out[k] = v;
  }
  return out;
}
