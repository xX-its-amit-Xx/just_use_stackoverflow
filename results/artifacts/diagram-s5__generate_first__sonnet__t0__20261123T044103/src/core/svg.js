import { aabb, unionBox } from './geom.js';
import { routeConnector } from './route.js';

export function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
const n = (v) => Math.round(v * 100) / 100;

function textSvg(el, cx, cy) {
  const st = el.style || {};
  const lines = String(el.text ?? '').split('\n');
  const fs = Number(st.fontSize) || 14;
  const y0 = cy - ((lines.length - 1) * fs * 1.2) / 2;
  return lines.map((l, i) => `<text x="${n(cx)}" y="${n(y0 + i * fs * 1.2)}" text-anchor="middle" dominant-baseline="central" font-family="${esc(st.fontFamily || 'sans-serif')}" font-size="${fs}" fill="${esc(st.fontColor || st.color || '#000000')}">${esc(l)}</text>`).join('');
}

export function toSVG(items, layerById, opts = {}) {
  const padding = typeof opts.padding === 'number' ? opts.padding : 20;
  const visible = items.filter((o) => layerById.get(o.layer)?.visible !== false);
  const byId = new Map(items.map((o) => [o.id, o]));
  const shapes = visible.filter((o) => o.type !== 'connector');
  const routes = new Map();
  const boxes = shapes.map(aabb);
  for (const c of visible) {
    if (c.type !== 'connector') continue;
    const r = routeConnector(c, byId, items.filter((o) => o.type !== 'connector'));
    routes.set(c.id, r);
    if (r.length) {
      const xs = r.map((p) => p[0]), ys = r.map((p) => p[1]);
      boxes.push({ x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) });
    }
  }
  const b = unionBox(boxes) || { x: 0, y: 0, width: 0, height: 0 };
  const vx = b.x - padding, vy = b.y - padding, vw = b.width + padding * 2, vh = b.height + padding * 2;
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${n(vw)}" height="${n(vh)}" viewBox="${n(vx)} ${n(vy)} ${n(vw)} ${n(vh)}">`);
  parts.push('<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#000000"/></marker></defs>');
  for (const o of visible) {
    const st = o.style || {};
    const fill = esc(st.fill ?? '#ffffff'), stroke = esc(st.stroke ?? '#000000'), sw = Number(st.strokeWidth) || 1;
    const op = st.opacity !== undefined ? ` opacity="${esc(st.opacity)}"` : '';
    if (o.type === 'connector') {
      const r = routes.get(o.id) || [];
      if (!r.length) continue;
      const d = r.map((p, i) => `${i ? 'L' : 'M'} ${n(p[0])} ${n(p[1])}`).join(' ');
      let label = '';
      if (o.label) {
        const mid = r[Math.floor((r.length - 1) / 2)], nx = r[Math.floor(r.length / 2)];
        label = textSvg({ text: o.label, style: st }, (mid[0] + nx[0]) / 2, (mid[1] + nx[1]) / 2 - 8);
      }
      parts.push(`<g data-id="${esc(o.id)}" data-type="connector"${op}><path d="${d}" fill="none" stroke="${stroke}" stroke-width="${sw}" marker-end="url(#arrow)"/>${label}</g>`);
      continue;
    }
    const cx = o.x + o.width / 2, cy = o.y + o.height / 2;
    const tr = o.rotation ? ` transform="rotate(${n(o.rotation)} ${n(cx)} ${n(cy)})"` : '';
    let body;
    const common = `fill="${fill}" stroke="${stroke}" stroke-width="${sw}"`;
    if (o.type === 'ellipse') body = `<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(o.width / 2)}" ry="${n(o.height / 2)}" ${common}/>`;
    else if (o.type === 'diamond') body = `<polygon points="${n(cx)},${n(o.y)} ${n(o.x + o.width)},${n(cy)} ${n(cx)},${n(o.y + o.height)} ${n(o.x)},${n(cy)}" ${common}/>`;
    else if (o.type === 'line') body = `<line x1="${n(o.x)}" y1="${n(o.y)}" x2="${n(o.x + o.width)}" y2="${n(o.y + o.height)}" stroke="${stroke}" stroke-width="${sw}"/>`;
    else if (o.type === 'image') body = `<image x="${n(o.x)}" y="${n(o.y)}" width="${n(o.width)}" height="${n(o.height)}" href="${esc(o.src || st.src || st.href || '')}"/>`;
    else if (o.type === 'text') body = '';
    else body = `<rect x="${n(o.x)}" y="${n(o.y)}" width="${n(o.width)}" height="${n(o.height)}" rx="${n(Number(st.radius) || 0)}" ${common}/>`;
    const label = o.text && o.type !== 'image' ? textSvg(o, cx, cy) : '';
    parts.push(`<g data-id="${esc(o.id)}" data-type="${o.type}"${tr}${op}>${body}${label}</g>`);
  }
  parts.push('</svg>');
  return parts.join('\n');
}
