import { DiagramError } from './errors.js';
import { Document } from './doc.js';

function decode(s) {
  return String(s).replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}
function attrs(s) {
  const o = {};
  const re = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(s))) o[m[1]] = decode(m[2] ?? m[3]);
  return o;
}
function parseStyle(s = '') {
  const o = {}; const flags = [];
  for (const part of s.split(';')) {
    if (!part) continue;
    const i = part.indexOf('=');
    if (i < 0) flags.push(part); else o[part.slice(0, i)] = part.slice(i + 1);
  }
  return { kv: o, flags };
}
function stripHtml(v) {
  return v.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(div|p)>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
}

// Tokenise cells: returns [{tag, attrs, body}] for mxCell / object / UserObject
function readCells(xml) {
  const cells = [];
  const re = /<(mxCell|object|UserObject)\b([^>]*?)(\/>|>([\s\S]*?)<\/\1>)/g;
  let m;
  while ((m = re.exec(xml))) {
    const a = attrs(m[2]);
    let body = m[4] || '';
    if (m[1] !== 'mxCell') {
      // wrapper: real mxCell inside
      const inner = /<mxCell\b([^>]*?)(\/>|>([\s\S]*?)<\/mxCell>)/.exec(body);
      if (!inner) continue;
      const ia = attrs(inner[1]);
      cells.push({ a: { ...ia, id: a.id ?? ia.id, value: a.label ?? a.value ?? ia.value }, body: inner[3] || '' });
    } else cells.push({ a, body });
  }
  return cells;
}

export function importDrawio(xml, opts = {}) {
  if (typeof xml !== 'string' || !xml.trim()) throw new DiagramError('empty draw.io input');
  if (!/<mxGraphModel|<mxfile|<diagram/.test(xml)) throw new DiagramError('not a draw.io document');
  if (/<diagram\b[^>]*>\s*[A-Za-z0-9+/=]{20,}\s*<\/diagram>/.test(xml)) throw new DiagramError('compressed draw.io diagrams are not supported');
  // only the first diagram
  const dm = /<diagram\b[^>]*>([\s\S]*?)<\/diagram>/.exec(xml);
  const src = dm ? dm[1] : xml;
  const doc = new Document({ id: opts.id ?? 'drawio', actor: opts.actor ?? 'import' });
  const cells = readCells(src);
  const info = new Map();
  for (const c of cells) if (c.a.id !== undefined) {
    const g = /<mxGeometry\b([^>]*?)(\/>|>([\s\S]*?)<\/mxGeometry>)/.exec(c.body);
    const geo = g ? attrs(g[1]) : {};
    const pts = [];
    if (g && g[3]) {
      const arr = /<Array\b[^>]*as="points"[^>]*>([\s\S]*?)<\/Array>/.exec(g[3]);
      if (arr) { const re = /<mxPoint\b([^>]*?)\/?>/g; let m; while ((m = re.exec(arr[1]))) { const p = attrs(m[1]); pts.push({ x: +p.x || 0, y: +p.y || 0 }); } }
    }
    info.set(c.a.id, { ...c, geo, pts });
  }
  const abs = (id, seen = 0) => {
    const c = info.get(id);
    if (!c || seen > 20) return { x: 0, y: 0 };
    const p = c.a.parent !== undefined && info.get(c.a.parent)?.a.vertex === '1' ? abs(c.a.parent, seen + 1) : { x: 0, y: 0 };
    return { x: p.x + (+c.geo.x || 0), y: p.y + (+c.geo.y || 0) };
  };
  const vertices = [], edges = [];
  for (const c of info.values()) {
    if (c.a.vertex === '1') vertices.push(c); else if (c.a.edge === '1') edges.push(c);
  }
  const label = (c, st) => {
    let v = c.a.value ?? '';
    if (v && (st.kv.html === '1' || /<[a-z][^>]*>/i.test(v))) v = stripHtml(v);
    return v;
  };
  doc.transaction(() => {
    for (const v of vertices) {
      const st = parseStyle(v.a.style);
      let type = 'rect';
      const shape = st.kv.shape;
      if (st.flags.includes('ellipse') || shape === 'ellipse' || shape === 'doubleEllipse') type = 'ellipse';
      else if (st.flags.includes('rhombus') || shape === 'rhombus') type = 'diamond';
      else if (st.flags.includes('text') || shape === 'text') type = 'text';
      else if (shape === 'image' || st.kv.image) type = 'image';
      const pos = abs(v.a.id);
      const style = {};
      if (st.kv.fillColor && st.kv.fillColor !== 'none') style.fill = st.kv.fillColor;
      if (st.kv.strokeColor && st.kv.strokeColor !== 'none') style.stroke = st.kv.strokeColor;
      if (st.kv.fontColor) style.fontColor = st.kv.fontColor;
      if (st.kv.fontSize) style.fontSize = +st.kv.fontSize;
      if (st.kv.strokeWidth) style.strokeWidth = +st.kv.strokeWidth;
      if (st.kv.opacity) style.opacity = +st.kv.opacity / 100;
      const el = { id: v.a.id, type, x: pos.x, y: pos.y, width: +v.geo.width || 0, height: +v.geo.height || 0, text: label(v, st), style };
      if (st.kv.rotation) el.rotation = +st.kv.rotation;
      doc.apply({ type: 'add', element: el });
    }
    for (const e of edges) {
      const st = parseStyle(e.a.style);
      const orth = /orthogonal|elbow/i.test(st.kv.edgeStyle || '');
      const style = {};
      if (st.kv.strokeColor && st.kv.strokeColor !== 'none') style.stroke = st.kv.strokeColor;
      if (st.kv.strokeWidth) style.strokeWidth = +st.kv.strokeWidth;
      const end = (id, which) => {
        if (id !== undefined && info.get(id)?.a.vertex === '1') return { elementId: id };
        const tp = e.body && new RegExp(`<mxPoint\\b([^>]*?as="${which}"[^>]*?)/?>`).exec(e.body);
        if (tp) { const p = attrs(tp[1]); return { x: +p.x || 0, y: +p.y || 0 }; }
        return { x: 0, y: 0 };
      };
      doc.apply({ type: 'add', element: {
        id: e.a.id, type: 'connector', source: end(e.a.source, 'sourcePoint'), target: end(e.a.target, 'targetPoint'),
        routing: orth ? 'orthogonal' : 'straight', waypoints: e.pts, label: label(e, st), style,
      } });
    }
  });
  doc._undo = []; doc._redo = [];
  return doc;
}
