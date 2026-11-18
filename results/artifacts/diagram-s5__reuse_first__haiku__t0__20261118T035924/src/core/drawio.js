// Importer for uncompressed draw.io / mxGraph XML.
//
// The attribute parsing, entity handling and <object>/<UserObject> wrapper
// handling follow jgraph/drawio-mcp (Apache-2.0): shared/mx-xml.js. See
// src/THIRD_PARTY_NOTICES.md. The mapping to this model is new code.
import { Document, DEFAULT_LAYER } from './document.js';
import { DiagramError } from './errors.js';

const XML_ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };

// Decodes one pass of XML/HTML character references; unknown ones are kept.
function unescapeXml(s) {
  return String(s).replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (m, e) => {
    if (e.charAt(0) !== '#') return XML_ENTITIES[e] ?? m;
    const code = e.charAt(1) === 'x' ? parseInt(e.substring(2), 16) : parseInt(e.substring(1), 10);
    return code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : m;
  });
}

function parseAttrs(s) {
  const attrs = {};
  const re = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(s)) !== null) attrs[m[1]] = unescapeXml(m[2]);
  return attrs;
}

// draw.io html=1 labels: turn line breaks into newlines and strip markup.
function labelToText(value, html) {
  if (!value) return '';
  let s = html ? String(value).replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p)>/gi, '\n') : String(value);
  if (html) s = s.replace(/<[^>]+>/g, '');
  return unescapeXml(s).replace(/\n$/, '');
}

function parseStyle(str) {
  const out = {};
  for (const tok of String(str || '').split(';')) {
    if (!tok) continue;
    const eq = tok.indexOf('=');
    if (eq < 0) out[tok] = '1';
    else out[tok.slice(0, eq)] = tok.slice(eq + 1);
  }
  return out;
}

const STYLE_MAP = {
  fillColor: 'fill', strokeColor: 'stroke', strokeWidth: 'strokeWidth', fontSize: 'fontSize',
  fontColor: 'fontColor', fontFamily: 'fontFamily', opacity: 'opacity', rounded: 'rounded',
};

function mapStyle(raw) {
  const style = {};
  for (const [k, v] of Object.entries(raw)) {
    if (STYLE_MAP[k]) {
      const n = Number(v);
      style[STYLE_MAP[k]] = v !== '' && !Number.isNaN(n) && ['strokeWidth', 'fontSize', 'opacity'].includes(STYLE_MAP[k]) ? n : v;
    }
  }
  return style;
}

// Every <mxCell> with its enclosing wrapper's id/label, if any.
function parseCells(xml) {
  const wrappers = [];
  for (const m of xml.matchAll(/<(object|UserObject)\b([^>]*?)>([\s\S]*?)<\/\1>/g)) {
    wrappers.push({ start: m.index, end: m.index + m[0].length, attrs: parseAttrs(m[2]) });
  }
  const cells = [];
  for (const m of xml.matchAll(/<mxCell\b([^>]*?)(\/>|>([\s\S]*?)<\/mxCell>)/g)) {
    const w = wrappers.find((x) => m.index > x.start && m.index < x.end);
    const a = parseAttrs(m[1]);
    const body = m[3] || '';
    const g = /<mxGeometry\b([^>]*?)(\/>|>([\s\S]*?)<\/mxGeometry>)/.exec(body);
    let geometry = null;
    if (g) {
      const ga = parseAttrs(g[1]);
      const num = (v) => (v === undefined ? 0 : Number(v) || 0);
      const points = [];
      const arr = /<Array\b[^>]*as="points"[^>]*>([\s\S]*?)<\/Array>/.exec(g[3] || '');
      if (arr) for (const pm of arr[1].matchAll(/<mxPoint\b([^>]*?)\/?>/g)) {
        const pa = parseAttrs(pm[1]);
        points.push([Number(pa.x) || 0, Number(pa.y) || 0]);
      }
      geometry = { x: num(ga.x), y: num(ga.y), width: num(ga.width), height: num(ga.height), points };
    }
    cells.push({
      id: a.id ?? w?.attrs.id ?? null,
      value: a.value ?? w?.attrs.label ?? '',
      html: (a.html ?? '') === '1' || /(^|;)html=1(;|$)/.test(a.style || ''),
      style: a.style || '',
      parent: a.parent ?? null,
      source: a.source ?? null,
      target: a.target ?? null,
      vertex: a.vertex === '1',
      edge: a.edge === '1',
      geometry,
    });
  }
  return cells;
}

export function importDrawio(xml, opts = {}) {
  if (typeof xml !== 'string') throw new DiagramError('importDrawio: XML string required');
  const src = xml.replace(/<!--[\s\S]*?-->/g, '');
  if (/<diagram\b[^>]*>\s*[A-Za-z0-9+/=]{16,}\s*<\/diagram>/.test(src) && !/<mxGraphModel\b/.test(src)) {
    throw new DiagramError('compressed draw.io diagrams are not supported; export uncompressed XML');
  }
  const cells = parseCells(src);
  if (cells.length === 0) throw new DiagramError('no mxCell elements found');
  const byId = new Map();
  for (const c of cells) if (c.id !== null && !byId.has(c.id)) byId.set(c.id, c);

  const doc = new Document({ id: opts.id, actor: opts.actor });
  const layerCells = cells.filter((c) => c.id && c.id !== '0' && !c.vertex && !c.edge);
  const layerIds = new Set(layerCells.map((c) => c.id));

  // Absolute origin of a cell: draw.io geometry is relative to its parent vertex.
  const originOf = (c, depth = 0) => {
    const p = c.parent && byId.get(c.parent);
    if (!p || depth > 50 || !p.vertex || !p.geometry) return [0, 0];
    const [px, py] = originOf(p, depth + 1);
    return [px + p.geometry.x, py + p.geometry.y];
  };
  const layerOf = (c, depth = 0) => {
    if (c.parent && layerIds.has(c.parent)) return c.parent;
    const p = c.parent && byId.get(c.parent);
    if (p && depth < 50) return layerOf(p, depth + 1);
    return null;
  };

  const seen = new Set();
  const shapes = [];
  const edges = [];
  for (const c of cells) {
    if (!c.id || c.id === '0' || layerIds.has(c.id) || seen.has(c.id)) continue;
    seen.add(c.id);
    if (c.vertex) shapes.push(c);
    else if (c.edge) edges.push(c);
  }

  const hasLayers = layerCells.length > 0;
  doc.transaction(() => {
    for (const l of layerCells) {
      doc.apply({ type: 'addLayer', layer: { id: l.id, name: l.value || l.id } });
    }
    if (hasLayers) doc.apply({ type: 'removeLayer', id: DEFAULT_LAYER });
    const layerFor = (c) => layerOf(c) ?? (hasLayers ? [...layerIds][0] : DEFAULT_LAYER);
    for (const c of shapes) {
      const st = parseStyle(c.style);
      let type = 'rect';
      if (st.ellipse === '1' || st.shape === 'ellipse') type = 'ellipse';
      else if (st.rhombus === '1' || st.shape === 'rhombus') type = 'diamond';
      else if (st.text === '1' || st.shape === 'text') type = 'text';
      else if (st.shape === 'image' || st.image) type = 'image';
      else if (st.shape === 'line') type = 'line';
      const [ox, oy] = originOf(c);
      const g = c.geometry || { x: 0, y: 0, width: 0, height: 0 };
      const style = mapStyle(st);
      doc.apply({
        type: 'add',
        element: {
          id: c.id, type, x: ox + g.x, y: oy + g.y, width: g.width, height: g.height,
          rotation: Number(st.rotation) || 0,
          text: labelToText(c.value, c.html), layer: layerFor(c), style,
        },
      });
    }
    for (const c of edges) {
      if (!c.source || !c.target || !doc.get(c.source) || !doc.get(c.target)) continue;
      const st = parseStyle(c.style);
      const wps = c.geometry?.points ?? [];
      doc.apply({
        type: 'add',
        element: {
          id: c.id, type: 'connector',
          source: { elementId: c.source }, target: { elementId: c.target },
          routing: /orthogonalEdgeStyle/.test(c.style) || st.edgeStyle === 'orthogonalEdgeStyle' ? 'orthogonal' : 'straight',
          waypoints: wps, label: labelToText(c.value, c.html),
          layer: layerFor(c), style: mapStyle(st),
        },
      });
    }
  });
  doc._undo.length = 0;
  doc._redo.length = 0;
  doc.pendingOps();
  return doc;
}
