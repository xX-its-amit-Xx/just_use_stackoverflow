// Computes user-level operations that turn snapshot `cur` into snapshot `snap`.
// Order: add layers, remove elements, add shapes, add connectors, update elements, update/remove layers.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function diffOps(cur, snap) {
  const ops = [];
  const curL = new Map(cur.layers.map((l) => [l.id, l]));
  const snapL = new Map(snap.layers.map((l) => [l.id, l]));
  const curE = new Map(cur.elements.map((e) => [e.id, e]));
  const snapE = new Map(snap.elements.map((e) => [e.id, e]));

  for (const [id, l] of snapL) if (!curL.has(id)) ops.push({ type: 'addLayer', layer: structuredClone(l) });

  for (const id of curE.keys()) if (!snapE.has(id)) ops.push({ type: 'remove', id });

  const adds = [...snapE.values()].filter((e) => !curE.has(e.id));
  for (const e of adds.filter((e) => e.type !== 'connector')) ops.push({ type: 'add', element: structuredClone(e) });
  for (const e of adds.filter((e) => e.type === 'connector')) ops.push({ type: 'add', element: structuredClone(e) });

  for (const [id, e] of snapE) {
    const c = curE.get(id);
    if (!c) continue;
    const patch = {};
    const keys = new Set([...Object.keys(c), ...Object.keys(e)]);
    for (const k of keys) {
      if (k === 'id' || k === 'type') continue;
      if (k === 'style') {
        const cs = c.style ?? {};
        const ss = e.style ?? {};
        const sp = {};
        for (const sk of new Set([...Object.keys(cs), ...Object.keys(ss)])) {
          if (!same(cs[sk], ss[sk])) sp[sk] = ss[sk] === undefined ? null : structuredClone(ss[sk]);
        }
        if (Object.keys(sp).length) patch.style = sp;
      } else if (!same(c[k], e[k])) {
        patch[k] = e[k] === undefined ? null : structuredClone(e[k]);
      }
    }
    if (Object.keys(patch).length) ops.push({ type: 'update', id, patch });
  }

  for (const [id, l] of snapL) {
    const c = curL.get(id);
    if (!c) continue;
    const patch = {};
    for (const k of ['name', 'visible', 'locked', 'order']) if (!same(c[k], l[k])) patch[k] = l[k];
    if (Object.keys(patch).length) ops.push({ type: 'updateLayer', id, patch });
  }
  for (const id of curL.keys()) if (!snapL.has(id) && id !== 'default') ops.push({ type: 'removeLayer', id });
  return ops;
}
