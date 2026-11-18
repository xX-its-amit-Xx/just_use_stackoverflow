// Standalone SVG export. One primary element per shape/connector carries data-id.
import { aabb, centerOf, normDeg, unionRect } from './geometry.js';

export function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const num = (n) => (Number.isFinite(n) ? String(Math.round(n * 1000) / 1000) : '0');

function styleAttrs(style, defaults) {
  const s = { ...defaults, ...style };
  const parts = [
    `fill="${escapeXml(s.fill)}"`,
    `stroke="${escapeXml(s.stroke)}"`,
    `stroke-width="${num(Number(s.strokeWidth))}"`,
  ];
  if (s.opacity !== undefined) parts.push(`opacity="${num(Number(s.opacity))}"`);
  return parts.join(' ');
}

function textAttrs(style) {
  const size = Number(style.fontSize ?? 14);
  const color = style.color ?? '#000000';
  const family = style.fontFamily ?? 'sans-serif';
  return `font-size="${num(size)}" fill="${escapeXml(color)}" font-family="${escapeXml(family)}"`;
}

function rotAttr(e) {
  const rot = normDeg(e.rotation ?? 0);
  if (!rot) return '';
  const c = centerOf(e);
  return ` transform="rotate(${num(rot)} ${num(c.x)} ${num(c.y)})"`;
}

function renderShape(e) {
  const st = e.style ?? {};
  const id = escapeXml(e.id);
  const rot = rotAttr(e);
  const base = { fill: '#ffffff', stroke: '#000000', strokeWidth: 1 };
  const x = num(e.x);
  const y = num(e.y);
  const w = num(e.width);
  const h = num(e.height);
  const cx = num(e.x + e.width / 2);
  const cy = num(e.y + e.height / 2);
  let el;
  switch (e.type) {
    case 'ellipse':
      el = `<ellipse data-id="${id}" cx="${cx}" cy="${cy}" rx="${num(e.width / 2)}" ry="${num(e.height / 2)}" ${styleAttrs(st, base)}${rot}/>`;
      break;
    case 'diamond':
      el = `<polygon data-id="${id}" points="${cx},${y} ${x + w},${cy} ${cx},${num(e.y + e.height)} ${x},${cy}" ${styleAttrs(st, base)}${rot}/>`;
      break;
    case 'text':
      return `<text data-id="${id}" x="${x}" y="${num(e.y + Number(st.fontSize ?? 14))}" ${textAttrs(st)}${rot}>${escapeXml(e.text)}</text>`;
    case 'image':
      el = `<image data-id="${id}" href="${escapeXml(st.src ?? e.text ?? '')}" x="${x}" y="${y}" width="${w}" height="${h}" preserveAspectRatio="none"${rot}/>`;
      break;
    case 'line':
      return `<line data-id="${id}" x1="${x}" y1="${y}" x2="${num(e.x + e.width)}" y2="${num(e.y + e.height)}" stroke="${escapeXml(st.stroke ?? '#000000')}" stroke-width="${num(Number(st.strokeWidth ?? 1))}"${rot}/>`;
    default:
      el = `<rect data-id="${id}" x="${x}" y="${y}" width="${w}" height="${h}" ${styleAttrs(st, base)}${rot}/>`;
  }
  if (e.text) {
    el += `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="middle" ${textAttrs(st)}${rot}>${escapeXml(e.text)}</text>`;
  }
  return el;
}

function renderConnector(doc, e) {
  const pts = doc.route(e.id);
  const st = e.style ?? {};
  const id = escapeXml(e.id);
  const points = pts.map((p) => `${num(p[0])},${num(p[1])}`).join(' ');
  let out = `<polyline data-id="${id}" points="${points}" fill="none" stroke="${escapeXml(st.stroke ?? '#000000')}" stroke-width="${num(Number(st.strokeWidth ?? 1))}"/>`;
  if (e.label && pts.length) {
    const mid = pts[Math.floor((pts.length - 1) / 2)];
    out += `<text x="${num(mid[0])}" y="${num(mid[1] - 4)}" text-anchor="middle" ${textAttrs(st)}>${escapeXml(e.label)}</text>`;
  }
  return out;
}

export function toSVG(doc, { padding = 10 } = {}) {
  const hidden = new Set(doc.layers().filter((l) => !l.visible).map((l) => l.id));
  const els = doc.elements().filter((e) => !hidden.has(e.layer));
  const boxes = [];
  for (const e of els) {
    if (e.type === 'connector') for (const p of doc.route(e.id)) boxes.push({ x: p[0], y: p[1], width: 0, height: 0 });
    else boxes.push(aabb(e));
  }
  const b = boxes.length ? unionRect(boxes) : { x: 0, y: 0, width: 100, height: 100 };
  const vx = b.x - padding;
  const vy = b.y - padding;
  const vw = b.width + 2 * padding;
  const vh = b.height + 2 * padding;
  const body = els.map((e) => (e.type === 'connector' ? renderConnector(doc, e) : renderShape(e))).join('\n  ');
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${num(vx)} ${num(vy)} ${num(vw)} ${num(vh)}" ` +
    `width="${num(vw)}" height="${num(vh)}">\n  ${body}\n</svg>\n`
  );
}
