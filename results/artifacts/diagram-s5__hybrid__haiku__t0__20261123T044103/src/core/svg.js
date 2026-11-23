// Standalone SVG rendering of a document snapshot (toJSON output).
import { aabb, corners } from './geometry.js';

export function esc(v) {
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function num(v) {
  return Number.isFinite(v) ? String(+v.toFixed(3)) : '0';
}

function styleAttrs(el) {
  const s = el.style ?? {};
  const isLine = el.type === 'line';
  const parts = [
    `fill="${esc(s.fill ?? (isLine ? 'none' : '#ffffff'))}"`,
    `stroke="${esc(s.stroke ?? '#000000')}"`,
    `stroke-width="${num(Number(s.strokeWidth ?? 1))}"`,
  ];
  if (s.opacity !== undefined && s.opacity !== null) parts.push(`opacity="${num(Number(s.opacity))}"`);
  return parts.join(' ');
}

function textEl(text, x, y, anchor, style, color) {
  const s = style ?? {};
  const size = num(Number(s.fontSize ?? 14));
  const family = s.fontFamily ? ` font-family="${esc(s.fontFamily)}"` : '';
  return `<text x="${num(x)}" y="${num(y)}" text-anchor="${anchor}" dominant-baseline="middle" font-size="${size}" fill="${esc(color ?? s.fontColor ?? '#000000')}"${family}>${esc(text ?? '')}</text>`;
}

function shapeSVG(el) {
  const cx = el.x + el.width / 2;
  const cy = el.y + el.height / 2;
  const tr = el.rotation ? ` transform="rotate(${num(el.rotation)} ${num(cx)} ${num(cy)})"` : '';
  const attrs = styleAttrs(el);
  let body;
  switch (el.type) {
    case 'ellipse':
      body = `<ellipse cx="${num(cx)}" cy="${num(cy)}" rx="${num(el.width / 2)}" ry="${num(el.height / 2)}" ${attrs}/>`;
      break;
    case 'diamond': {
      const pts = [[cx, el.y], [el.x + el.width, cy], [cx, el.y + el.height], [el.x, cy]];
      body = `<polygon points="${pts.map((p) => `${num(p[0])},${num(p[1])}`).join(' ')}" ${attrs}/>`;
      break;
    }
    case 'line':
      body = `<line x1="${num(el.x)}" y1="${num(el.y)}" x2="${num(el.x + el.width)}" y2="${num(el.y + el.height)}" ${attrs}/>`;
      break;
    case 'image':
      body = `<image href="${esc(el.src ?? el.style?.src ?? '')}" x="${num(el.x)}" y="${num(el.y)}" width="${num(el.width)}" height="${num(el.height)}" preserveAspectRatio="none"/>`;
      break;
    case 'text':
      body = textEl(el.text, cx, cy, 'middle', el.style, el.style?.fontColor);
      break;
    default:
      body = `<rect x="${num(el.x)}" y="${num(el.y)}" width="${num(el.width)}" height="${num(el.height)}" ${attrs}/>`;
  }
  if (el.type !== 'text' && el.text) body += textEl(el.text, cx, cy, 'middle', el.style);
  return `<g data-id="${esc(el.id)}" data-type="${esc(el.type)}"${tr}>${body}</g>`;
}

function connectorSVG(el, route) {
  const pts = route.map((p) => `${num(p[0])},${num(p[1])}`).join(' ');
  const s = el.style ?? {};
  let body = `<polyline points="${pts}" fill="none" stroke="${esc(s.stroke ?? '#000000')}" stroke-width="${num(Number(s.strokeWidth ?? 1))}" marker-end="url(#arrow)"/>`;
  if (el.label) {
    const a = route[Math.floor((route.length - 1) / 2)];
    const b = route[Math.ceil((route.length - 1) / 2)];
    body += textEl(el.label, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, 'middle', s);
  }
  return `<g data-id="${esc(el.id)}" data-type="connector">${body}</g>`;
}

export function renderSVG(json, routeOf, opts = {}) {
  const padding = opts.padding ?? 20;
  const items = [...json.elements].sort((a, b) => a.z - b.z || (a.id < b.id ? -1 : 1));
  const routes = new Map();
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const extend = (x, y) => {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  };
  for (const el of items) {
    if (el.type === 'connector') {
      const r = routeOf(el);
      routes.set(el.id, r);
      for (const p of r) extend(p[0], p[1]);
    } else {
      for (const p of corners(el)) extend(p[0], p[1]);
    }
  }
  if (!items.length) { minX = 0; minY = 0; maxX = 0; maxY = 0; }
  const x = minX - padding;
  const y = minY - padding;
  const w = maxX - minX + 2 * padding;
  const h = maxY - minY + 2 * padding;
  const body = items.map((el) => (el.type === 'connector' ? connectorSVG(el, routes.get(el.id)) : shapeSVG(el))).join('\n');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${num(x)} ${num(y)} ${num(w)} ${num(h)}" width="${num(w)}" height="${num(h)}">`,
    '<defs><marker id="arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#000000"/></marker></defs>',
    body,
    '</svg>',
  ].join('\n');
}



// Markup for a single shape or connector (used by the editor canvas).
export function elementMarkup(el, route) {
  return el.type === 'connector' ? connectorSVG(el, route ?? []) : shapeSVG(el);
}
