// Importer for uncompressed draw.io / mxGraph XML.
import { createDocument } from './document.js';
import { DiagramError } from './errors.js';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(s) {
  return String(s ?? '')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, n) => (n in ENTITIES ? ENTITIES[n] : m));
}

function htmlToText(s) {
  return decode(String(s ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ''));
}

function parseAttrs(str) {
  const attrs = {};
  const re = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(str))) attrs[m[1]] = decode(m[2] ?? m[3] ?? '');
  return attrs;
}

function parseStyle(style) {
  const map = {};
  for (const part of String(style ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) map[part.slice(0, i)] = part.slice(i + 1);
  }
  return map;
}

function shapeTypeOf(style) {
  const first = String(style ?? '').split(';')[0];
  const st = parseStyle(style);
  if (st.shape === 'image' || first === 'image') return 'image';
  if (first === 'ellipse') return 'ellipse';
  if (first === 'rhombus') return 'diamond';
  if (first === 'text' || st.text === '1') return 'text';
  if (first === 'line') return 'line';
  return 'rect';
}

function styleOf(style) {
  const st = parseStyle(style);
  const out = {};
  if (st.fillColor && st.fillColor !== 'none') out.fill = st.fillColor;
  if (st.strokeColor && st.strokeColor !== 'none') out.stroke = st.strokeColor;
  if (st.strokeWidth !== undefined && !Number.isNaN(Number(st.strokeWidth))) out.strokeWidth = Number(st.strokeWidth);
  if (st.opacity !== undefined && !Number.isNaN(Number(st.opacity))) out.opacity = Number(st.opacity);
  if (st.fontSize !== undefined && !Number.isNaN(Number(st.fontSize))) out.fontSize = Number(st.fontSize);
  if (st.fontFamily) out.fontFamily = st.fontFamily;
  if (st.fontColor) out.color = st.fontColor;
  return out;
}

/**
 * Parses draw.io XML into a new Document. Vertices become shapes, edges become
 * connectors (with waypoints and labels). Dangling edges are skipped.
 */
export function importDrawio(xml, { id, actor } = {}) {
  if (typeof xml !== 'string' || !xml.includes('<mxCell')) throw new DiagramError('not a draw.io document');
  const cells = new Map();
  const order = [];
  const cellRe = /<mxCell\b([^>]*?)(?:\/>|>([\s\S]*?)<\/mxCell>)/g;
  let m;
  while ((m = cellRe.exec(xml))) {
    const attrs = parseAttrs(m[1]);
    const body = m[2] ?? '';
    const geoM = /<mxGeometry\b([^>]*?)(?:\/>|>([\s\S]*?)<\/mxGeometry>)/.exec(body);
    let geometry = null;
    let points = [];
    if (geoM) {
      const ga = parseAttrs(geoM[1]);
      geometry = {
        x: Number(ga.x ?? 0),
        y: Number(ga.y ?? 0),
        width: Number(ga.width ?? 0),
        height: Number(ga.height ?? 0),
      };
      const ptRe = /<mxPoint\b([^>]*?)\/>/g;
      let p;
      const pointsBlock = /<Array\b[^>]*as="points"[^>]*>([\s\S]*?)<\/Array>/.exec(geoM[2] ?? '');
      if (pointsBlock) {
        while ((p = ptRe.exec(pointsBlock[1]))) {
          const pa = parseAttrs(p[1]);
          points.push({ x: Number(pa.x ?? 0), y: Number(pa.y ?? 0) });
        }
      }
    }
    const cell = { id: attrs.id, attrs, geometry, points };
    cells.set(attrs.id, cell);
    order.push(cell);
  }

  // Absolute origin of a vertex: sum of vertex ancestors' offsets.
  const originOf = (cell, depth = 0) => {
    if (!cell || depth > 50) return { x: 0, y: 0 };
    const parent = cells.get(cell.attrs.parent);
    if (!parent || parent.attrs.vertex !== '1') return { x: 0, y: 0 };
    const po = originOf(parent, depth + 1);
    return { x: po.x + (parent.geometry?.x ?? 0), y: po.y + (parent.geometry?.y ?? 0) };
  };

  const doc = createDocument({ id, actor: actor ?? 'import' });
  const shapeIds = new Set();
  doc.transaction(() => {
    for (const c of order) {
      if (c.attrs.vertex !== '1' || !c.geometry || !c.attrs.id) continue;
      const o = originOf(c);
      const style = c.attrs.style ?? '';
      doc.apply({
        type: 'add',
        element: {
          id: c.attrs.id,
          type: shapeTypeOf(style),
          x: o.x + c.geometry.x,
          y: o.y + c.geometry.y,
          width: c.geometry.width,
          height: c.geometry.height,
          text: htmlToText(c.attrs.value),
          style: styleOf(style),
        },
      });
      shapeIds.add(c.attrs.id);
    }
    for (const c of order) {
      if (c.attrs.edge !== '1' || !c.attrs.id) continue;
      const s = c.attrs.source;
      const t = c.attrs.target;
      if (!shapeIds.has(s) || !shapeIds.has(t)) continue;
      const style = c.attrs.style ?? '';
      const st = parseStyle(style);
      const parentOrigin = originOf(c);
      const waypoints = c.points.map((p) => [p.x + parentOrigin.x, p.y + parentOrigin.y]);
      doc.apply({
        type: 'add',
        element: {
          id: c.attrs.id,
          type: 'connector',
          source: { elementId: s },
          target: { elementId: t },
          routing: /orthogonal|elbow/.test(style) ? 'orthogonal' : 'straight',
          waypoints,
          label: htmlToText(c.attrs.value),
          style: styleOf(style),
        },
      });
    }
  });
  return doc;
}
