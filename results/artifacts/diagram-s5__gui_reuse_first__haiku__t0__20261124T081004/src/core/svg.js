import { aabbOf, centerOf } from './geometry.js';
import { CONNECTOR } from './util.js';

export function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function styleAttrs(style, type) {
  const fill = style.fill ?? (type === 'text' || type === CONNECTOR ? 'none' : '#ffffff');
  const stroke = style.stroke ?? (type === 'text' ? 'none' : '#000000');
  const parts = [`fill="${escapeXml(fill)}"`, `stroke="${escapeXml(stroke)}"`];
  if (style.strokeWidth !== undefined) parts.push(`stroke-width="${escapeXml(style.strokeWidth)}"`);
  if (style.opacity !== undefined) parts.push(`opacity="${escapeXml(style.opacity)}"`);
  return parts.join(' ');
}

function textBlock(text, cx, cy, style) {
  const lines = String(text).split('\n');
  const size = style.fontSize !== undefined ? Number(style.fontSize) : 14;
  const color = style.fontColor ?? '#000000';
  const tspans = lines
    .map((line, i) => `<tspan x="${cx}" dy="${i === 0 ? 0 : size * 1.2}">${escapeXml(line)}</tspan>`)
    .join('');
  return `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle" font-size="${size}" fill="${escapeXml(color)}">${tspans}</text>`;
}

function renderShape(el) {
  const [cx, cy] = centerOf(el);
  const { x, y, width: w, height: h } = el;
  const style = el.style || {};
  const common = `data-id="${escapeXml(el.id)}" ${styleAttrs(style, el.type)}`;
  const transform = el.rotation ? ` transform="rotate(${el.rotation} ${cx} ${cy})"` : '';
  let body;
  switch (el.type) {
    case 'ellipse':
      body = `<ellipse ${common} cx="${cx}" cy="${cy}" rx="${w / 2}" ry="${h / 2}"${transform}/>`;
      break;
    case 'diamond':
      body = `<polygon ${common} points="${cx},${y} ${x + w},${cy} ${cx},${y + h} ${x},${cy}"${transform}/>`;
      break;
    case 'line':
      body = `<line ${common} x1="${x}" y1="${y}" x2="${x + w}" y2="${y + h}"${transform}/>`;
      break;
    case 'text':
      body = el.text ? textBlock(el.text, cx, cy, style) : '';
      return `<g data-id="${escapeXml(el.id)}"${transform}>${body}</g>`;
    default: // rect, image
      body = `<rect ${common} x="${x}" y="${y}" width="${w}" height="${h}"${transform}/>`;
  }
  if (el.text && el.type !== 'text') {
    body += textBlock(el.text, cx, cy, style);
  }
  return body;
}

function renderConnector(doc, c) {
  const pts = doc.route(c.id);
  const style = c.style || {};
  const points = pts.map(p => `${p[0]},${p[1]}`).join(' ');
  let out = `<polyline data-id="${escapeXml(c.id)}" points="${points}" fill="none" stroke="${escapeXml(style.stroke ?? '#000000')}"${style.strokeWidth !== undefined ? ` stroke-width="${escapeXml(style.strokeWidth)}"` : ''}/>`;
  if (c.label && pts.length) {
    const mid = pts[Math.floor((pts.length - 1) / 2)];
    out += textBlock(c.label, mid[0], mid[1], style);
  }
  return out;
}

export function renderSVG(doc, { padding = 10 } = {}) {
  const visible = new Set(doc.layers().filter(l => l.visible).map(l => l.id));
  const items = doc.elements().filter(e => visible.has(e.layer));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x, y) => {
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  };
  const parts = [];
  for (const el of items) {
    if (el.type === CONNECTOR) {
      const pts = doc.route(el.id);
      for (const p of pts) grow(p[0], p[1]);
      parts.push(renderConnector(doc, el));
    } else {
      const b = aabbOf(el);
      grow(b.left, b.top);
      grow(b.right, b.bottom);
      parts.push(renderShape(el));
    }
  }
  if (!Number.isFinite(minX)) { minX = 0; minY = 0; maxX = 100; maxY = 100; }
  const vx = minX - padding;
  const vy = minY - padding;
  const w = maxX - minX + 2 * padding;
  const h = maxY - minY + 2 * padding;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vx} ${vy} ${w} ${h}" width="${w}" height="${h}">\n` +
    parts.filter(Boolean).join('\n') + (parts.length ? '\n' : '') + `</svg>\n`;
}
