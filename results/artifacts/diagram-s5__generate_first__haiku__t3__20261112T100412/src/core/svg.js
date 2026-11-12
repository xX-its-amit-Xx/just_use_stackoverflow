export function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const n = (v) => (Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : '0');

function paint(style) {
  const fill = style.fill ?? '#ffffff';
  const stroke = style.stroke ?? '#000000';
  const sw = style.strokeWidth ?? 1;
  let a = ` fill="${escapeXml(fill)}" stroke="${escapeXml(stroke)}" stroke-width="${n(sw)}"`;
  if (style.opacity !== undefined) a += ` opacity="${n(style.opacity)}"`;
  return a;
}

function fontAttrs(style) {
  return ` font-family="${escapeXml(style.font ?? 'sans-serif')}" font-size="${n(style.fontSize ?? 14)}" fill="${escapeXml(style.fontColor ?? '#000000')}"`;
}

/** Renders a document as a standalone SVG string. */
export function renderSVG(doc, { padding = 20 } = {}) {
  const els = doc.visibleElements();
  const b = doc.bounds() ?? { x: 0, y: 0, width: 0, height: 0 };
  const vx = b.x - padding;
  const vy = b.y - padding;
  const vw = b.width + 2 * padding;
  const vh = b.height + 2 * padding;
  const body = [];
  for (const v of els) {
    const st = v.style ?? {};
    if (v.type === 'connector') {
      const pts = doc.route(v.id);
      body.push(
        `<polyline data-id="${escapeXml(v.id)}" points="${pts.map((p) => `${n(p[0])},${n(p[1])}`).join(' ')}" fill="none" stroke="${escapeXml(st.stroke ?? '#000000')}" stroke-width="${n(st.strokeWidth ?? 1)}"${st.opacity !== undefined ? ` opacity="${n(st.opacity)}"` : ''} />`,
      );
      if (v.label) {
        const mid = pts[Math.floor(pts.length / 2)] ?? [0, 0];
        body.push(
          `<text x="${n(mid[0])}" y="${n(mid[1])}" text-anchor="middle"${fontAttrs(st)}>${escapeXml(v.label)}</text>`,
        );
      }
      continue;
    }
    const cx = v.x + v.width / 2;
    const cy = v.y + v.height / 2;
    const tr = v.rotation ? ` transform="rotate(${n(v.rotation)} ${n(cx)} ${n(cy)})"` : '';
    const id = ` data-id="${escapeXml(v.id)}"`;
    switch (v.type) {
      case 'rect':
        body.push(`<rect${id} x="${n(v.x)}" y="${n(v.y)}" width="${n(v.width)}" height="${n(v.height)}"${paint(st)}${tr} />`);
        break;
      case 'ellipse':
        body.push(`<ellipse${id} cx="${n(cx)}" cy="${n(cy)}" rx="${n(v.width / 2)}" ry="${n(v.height / 2)}"${paint(st)}${tr} />`);
        break;
      case 'diamond':
        body.push(
          `<polygon${id} points="${n(cx)},${n(v.y)} ${n(v.x + v.width)},${n(cy)} ${n(cx)},${n(v.y + v.height)} ${n(v.x)},${n(cy)}"${paint(st)}${tr} />`,
        );
        break;
      case 'line':
        body.push(
          `<line${id} x1="${n(v.x)}" y1="${n(v.y)}" x2="${n(v.x + v.width)}" y2="${n(v.y + v.height)}" stroke="${escapeXml(st.stroke ?? '#000000')}" stroke-width="${n(st.strokeWidth ?? 1)}"${tr} />`,
        );
        break;
      case 'text':
        body.push(
          `<text${id} x="${n(v.x)}" y="${n(v.y + (st.fontSize ?? 14))}"${fontAttrs(st)}${st.opacity !== undefined ? ` opacity="${n(st.opacity)}"` : ''}${tr}>${escapeXml(v.text ?? '')}</text>`,
        );
        break;
      case 'image': {
        const href = v.src ?? st.src ?? v.text ?? '';
        body.push(
          `<image${id} x="${n(v.x)}" y="${n(v.y)}" width="${n(v.width)}" height="${n(v.height)}" href="${escapeXml(href)}"${tr} />`,
        );
        break;
      }
      default:
        break;
    }
    if (v.type !== 'text' && v.text) {
      body.push(
        `<text x="${n(cx)}" y="${n(cy)}" text-anchor="middle" dominant-baseline="middle"${fontAttrs(st)}${tr}>${escapeXml(v.text)}</text>`,
      );
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${n(vx)} ${n(vy)} ${n(vw)} ${n(vh)}" width="${n(vw)}" height="${n(vh)}">` +
    body.join('') +
    `</svg>`
  );
}
