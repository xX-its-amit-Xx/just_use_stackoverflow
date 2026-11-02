// diagram-s5 hidden evaluation suite (core library + sync API). Not executed in the pilot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
const APP = process.env.APP_DIR;
const core = await import(path.join(APP, 'src/core/index.js'));
const { createDocument, fromJSON, importDrawio, DiagramError } = core;
const rect = (id, x, y, w = 40, h = 30, extra = {}) => ({ type: 'add', element: { id, type: 'rect', x, y, width: w, height: h, ...extra } });
const conn = (id, s, t, routing = 'orthogonal') => ({ type: 'add', element: { id, type: 'connector', source: { elementId: s }, target: { elementId: t }, routing } });
const inside = (p, e) => p[0] > e.x + 0.5 && p[0] < e.x + e.width - 0.5 && p[1] > e.y + 0.5 && p[1] < e.y + e.height - 0.5;

test('remove cascades to connectors; undo restores both', () => {
  const d = createDocument({ id: 'd', actor: 'a' }); d.apply(rect('a', 0, 0)); d.apply(rect('b', 200, 0)); d.apply(conn('c', 'a', 'b'));
  d.apply({ type: 'remove', id: 'a' }); assert.equal(d.get('c'), undefined); d.undo(); assert.ok(d.get('a')); assert.ok(d.get('c'));
});
test('transaction is one undo step; redo', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.transaction(() => { d.apply(rect('a', 0, 0)); d.apply(rect('b', 50, 0)); }); d.undo(); assert.equal(d.elements().length, 0); d.redo(); assert.equal(d.elements().length, 2);
});
test('locked layer rejects edits', () => {
  const d = createDocument({ id: 'd', actor: 'a' }); d.apply({ type: 'addLayer', layer: { id: 'L', name: 'L', locked: true } });
  assert.throws(() => d.apply(rect('a', 0, 0, 10, 10, { layer: 'L' })), DiagramError);
});
test('hit test respects z-order, visibility and rotation', () => {
  const d = createDocument({ id: 'd', actor: 'a' }); d.apply(rect('lo', 0, 0, 100, 100)); d.apply(rect('hi', 50, 50, 100, 100));
  assert.equal(d.hitTest(75, 75).id, 'hi'); d.apply({ type: 'reorder', id: 'lo', to: 'front' }); assert.equal(d.hitTest(75, 75).id, 'lo');
  const r = createDocument({ id: 'r', actor: 'a' }); r.apply(rect('t', 0, 0, 100, 10)); r.apply({ type: 'rotate', id: 't', deg: 90 });
  assert.equal(r.hitTest(50, 40)?.id, 't'); assert.equal(r.hitTest(5, 5), null);
});
test('align and distribute', () => {
  const d = createDocument({ id: 'd', actor: 'a' }); d.apply(rect('a', 0, 0)); d.apply(rect('b', 10, 50)); d.apply(rect('c', 300, 100));
  d.align(['a', 'b', 'c'], 'left'); assert.deepEqual(['a', 'b', 'c'].map(i => d.get(i).x), [0, 0, 0]);
  d.distribute(['a', 'b', 'c'], 'vertical'); const ys = ['a', 'b', 'c'].map(i => d.get(i).y).sort((x, y) => x - y);
  assert.ok(Math.abs((ys[1] - ys[0] - 30) - (ys[2] - ys[1] - 30)) < 1e-6);
});
test('orthogonal routing avoids obstacles', () => {
  const d = createDocument({ id: 'd', actor: 'a' }); d.apply(rect('s', 0, 100)); d.apply(rect('t', 400, 100)); d.apply(rect('wall', 180, 0, 40, 300)); d.apply(conn('c', 's', 't'));
  const pts = d.route('c'); assert.ok(pts.length >= 2);
  for (let i = 1; i < pts.length; i++) assert.ok(pts[i][0] === pts[i - 1][0] || pts[i][1] === pts[i - 1][1], 'axis-parallel');
  const wall = d.get('wall');
  for (let i = 1; i < pts.length; i++) for (let k = 0; k <= 20; k++) { const p = [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * k / 20, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * k / 20]; assert.ok(!inside(p, wall), `passes through wall at ${p}`); }
});
test('layered layout: edges point downward, no overlaps', () => {
  const d = createDocument({ id: 'd', actor: 'a' }); const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  ids.forEach((id, i) => d.apply(rect(id, i * 7, 0))); const edges = [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd'], ['d', 'e'], ['a', 'f']];
  edges.forEach(([s, t], i) => d.apply(conn('e' + i, s, t, 'straight'))); d.layout('layered', { direction: 'TB', spacing: 20 });
  for (const [s, t] of edges) assert.ok(d.get(s).y + d.get(s).height <= d.get(t).y, `${s}->${t}`);
  for (const x of ids) for (const y of ids) if (x < y) { const A = d.get(x), B = d.get(y); assert.ok(A.x + A.width <= B.x || B.x + B.width <= A.x || A.y + A.height <= B.y || B.y + B.height <= A.y, `${x}/${y} overlap`); }
});
test('JSON round trip and SVG export', () => {
  const d = createDocument({ id: 'd', actor: 'a' }); d.apply(rect('a', 0, 0, 40, 30, { text: 'A & <B>' })); d.apply(rect('b', 100, 0)); d.apply(conn('c', 'a', 'b'));
  const j = d.toJSON(); assert.deepEqual(fromJSON(j).toJSON(), j);
  const svg = d.toSVG({ padding: 10 }); assert.match(svg, /^<\?xml[^>]*>\s*<svg|^<svg/); assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.ok(svg.includes('data-id="a"') && svg.includes('data-id="c"')); assert.ok(svg.includes('A &amp; &lt;B&gt;'));
});
test('draw.io import', () => {
  const xml = `<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
  <mxCell id="v1" value="Start" style="ellipse;whiteSpace=wrap;" vertex="1" parent="1"><mxGeometry x="10" y="20" width="80" height="40" as="geometry"/></mxCell>
  <mxCell id="v2" value="Check?" style="rhombus;" vertex="1" parent="1"><mxGeometry x="10" y="120" width="80" height="80" as="geometry"/></mxCell>
  <mxCell id="e1" value="go" edge="1" source="v1" target="v2" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell></root></mxGraphModel>`;
  const d = importDrawio(xml); const els = d.elements();
  const start = els.find(e => e.text === 'Start'); assert.equal(start.type, 'ellipse'); assert.deepEqual([start.x, start.y, start.width, start.height], [10, 20, 80, 40]);
  assert.equal(els.find(e => e.text === 'Check?').type, 'diamond'); const c = els.find(e => e.type === 'connector'); assert.equal(c.label, 'go');
});
test('CRDT convergence under random interleavings', () => {
  let seed = 42; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let round = 0; round < 20; round++) {
    const reps = ['a', 'b', 'c'].map(actor => createDocument({ id: 'x', actor }));
    reps[0].apply(rect('base', 0, 0)); const init = reps[0].pendingOps(); reps[1].receive(init); reps[2].receive(init);
    const all = [...init];
    for (const r of reps) for (let k = 0; k < 6; k++) {
      const n = rnd();
      if (n < 0.3) r.apply(rect(`${r.actor ?? 'r'}${round}_${k}_${Math.floor(rnd() * 1e6)}`, rnd() * 100, rnd() * 100));
      else if (n < 0.6) r.apply({ type: 'update', id: 'base', patch: { x: Math.floor(rnd() * 100) } });
      else if (n < 0.8) r.apply({ type: 'update', id: 'base', patch: { style: { fill: ['red', 'blue', 'green'][Math.floor(rnd() * 3)] } } });
      else r.apply({ type: 'reorder', id: 'base', to: 'front' });
      all.push(...r.pendingOps());
    }
    const views = reps.map(r => { const shuffled = [...all, ...all.slice(0, 3)].sort(() => rnd() - 0.5); r.receive(shuffled); return JSON.stringify(r.toJSON()); });
    assert.equal(views[0], views[1]); assert.equal(views[1], views[2]);
  }
});
test('concurrent remove beats update', () => {
  const a = createDocument({ id: 'x', actor: 'a' }), b = createDocument({ id: 'x', actor: 'b' });
  a.apply(rect('r', 0, 0)); b.receive(a.pendingOps()); a.apply({ type: 'remove', id: 'r' }); b.apply({ type: 'update', id: 'r', patch: { x: 5 } });
  const oa = a.pendingOps(), ob = b.pendingOps(); a.receive(ob); b.receive(oa); assert.equal(a.get('r'), undefined); assert.equal(b.get('r'), undefined);
});
test('undo only reverts local ops', () => {
  const a = createDocument({ id: 'x', actor: 'a' }), b = createDocument({ id: 'x', actor: 'b' });
  a.apply(rect('ra', 0, 0)); b.receive(a.pendingOps()); b.apply(rect('rb', 50, 0)); b.undo(); assert.ok(b.get('ra')); assert.equal(b.get('rb'), undefined);
});
test('server sync endpoints', async () => {
  const fs = await import('node:fs'); const os = await import('node:os');
  const { createServer } = await import(path.join(APP, 'src/server.js'));
  const srv = createServer({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'dg-')) }); await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const call = async (m, p, b, t) => { const r = await fetch(base + p, { method: m, headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) }, body: b && JSON.stringify(b) }); return { status: r.status, body: await r.json().catch(() => null) }; };
  await call('POST', '/api/auth/register', { username: 'alice', password: 'password123' }); const t = (await call('POST', '/api/auth/login', { username: 'alice', password: 'password123' })).body.token;
  const doc = (await call('POST', '/api/docs', { title: 'D' }, t)).body; const d = createDocument({ id: doc.id, actor: 'alice' }); d.apply(rect('a', 0, 0));
  const p = await call('POST', `/api/docs/${doc.id}/ops`, { ops: d.pendingOps() }, t); assert.equal(p.status, 200);
  const g = await call('GET', `/api/docs/${doc.id}/ops?since=0`, undefined, t); assert.ok(g.body.ops.length >= 1);
  const snap = (await call('GET', `/api/docs/${doc.id}`, undefined, t)).body; assert.ok(JSON.stringify(snap).includes('"a"'));
  srv.closeAllConnections?.(); srv.close();
});
