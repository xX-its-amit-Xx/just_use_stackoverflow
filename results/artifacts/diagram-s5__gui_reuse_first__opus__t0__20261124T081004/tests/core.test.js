import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, fromJSON, importDrawio, snap, DiagramError } from '../src/core/index.js';

const R = (id, x, y, w = 50, h = 50, extra = {}) => ({ type: 'add', element: { id, type: 'rect', x, y, width: w, height: h, ...extra } });

test('add defaults, update style merge, remove cascades', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  assert.equal(d.id, 'd'); assert.equal(d.actor, 'a');
  d.apply({ type: 'add', element: { id: 'r', type: 'rect', style: { fill: 'red' } } });
  const r = d.get('r');
  assert.equal(r.x, 0); assert.equal(r.rotation, 0); assert.equal(r.layer, d.layers()[0].id);
  d.apply({ type: 'update', id: 'r', patch: { style: { stroke: 'blue' }, text: 'hi' } });
  assert.deepEqual(d.get('r').style, { fill: 'red', stroke: 'blue' });
  d.apply(R('s', 100, 0));
  d.apply({ type: 'add', element: { id: 'c', type: 'connector', source: { elementId: 'r' }, target: { elementId: 's' } } });
  assert.equal(d.get('c').routing, 'straight');
  d.apply({ type: 'remove', id: 'r' });
  assert.equal(d.get('c'), undefined);
  d.undo();
  assert.ok(d.get('c')); assert.ok(d.get('r'));
  assert.throws(() => d.apply({ type: 'nope' }), DiagramError);
  assert.throws(() => d.apply({ type: 'update', id: 'zz', patch: {} }), DiagramError);
});

test('locked layer, transactions, redo', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply({ type: 'addLayer', layer: { id: 'L', name: 'L', locked: true } });
  assert.throws(() => d.apply(R('x', 0, 0, 1, 1, { layer: 'L' })), DiagramError);
  d.apply({ type: 'updateLayer', id: 'L', patch: { locked: false } });
  d.apply(R('x', 0, 0, 1, 1, { layer: 'L' }));
  d.apply({ type: 'updateLayer', id: 'L', patch: { locked: true } });
  assert.throws(() => d.apply({ type: 'move', ids: ['x'], dx: 1, dy: 1 }), DiagramError);
  const e = createDocument({ actor: 'a' });
  e.transaction(() => { e.apply(R('a', 0, 0)); e.apply(R('b', 0, 0)); e.apply({ type: 'move', ids: ['a'], dx: 5, dy: 5 }); });
  e.undo();
  assert.equal(e.elements().length, 0);
  e.redo();
  assert.equal(e.elements().length, 2); assert.equal(e.get('a').x, 5);
});

test('reorder, hitTest rotation, select, bounds', () => {
  const d = createDocument({ actor: 'a' });
  d.apply(R('a', 0, 0, 100, 100)); d.apply(R('b', 50, 50, 100, 100)); d.apply(R('c', 500, 500, 10, 10));
  assert.equal(d.hitTest(75, 75).id, 'b');
  d.apply({ type: 'reorder', id: 'a', to: 'front' });
  assert.equal(d.hitTest(75, 75).id, 'a');
  assert.deepEqual(d.elements().map(e => e.id), ['b', 'c', 'a']);
  d.apply({ type: 'reorder', id: 'a', to: 'backward' });
  assert.deepEqual(d.elements().map(e => e.id), ['b', 'a', 'c']);
  d.apply({ type: 'reorder', id: 'a', to: 'back' });
  assert.deepEqual(d.elements().map(e => e.id), ['a', 'b', 'c']);
  d.apply({ type: 'reorder', id: 'a', to: 'forward' });
  assert.deepEqual(d.elements().map(e => e.id), ['b', 'a', 'c']);
  const e = createDocument({ actor: 'a' });
  e.apply(R('t', 0, 0, 200, 20));
  assert.ok(e.hitTest(190, 10));
  e.apply({ type: 'rotate', id: 't', deg: 90 });
  assert.equal(e.hitTest(190, 10), null);
  assert.ok(e.hitTest(100, 90));
  assert.equal(e.hitTest(1000, 1000), null);
  assert.deepEqual(d.select({ x: -1, y: -1, width: 200, height: 200 }).map(e => e.id).sort(), ['a', 'b']);
  assert.deepEqual(d.bounds(['a', 'c']), { x: 0, y: 0, width: 510, height: 510 });
});

test('snap, align, distribute', () => {
  assert.deepEqual(snap({ x: 13, y: 27 }, { grid: 10 }), { x: 10, y: 30 });
  assert.deepEqual(snap({ x: 13, y: 27 }, { grid: 10, guides: { x: [15] } }), { x: 15, y: 30 });
  const d = createDocument({ actor: 'a' });
  d.apply(R('a', 0, 0, 10, 10)); d.apply(R('b', 30, 50, 20, 10)); d.apply(R('c', 100, 20, 10, 40));
  d.align(['a', 'b', 'c'], 'right');
  assert.deepEqual(['a', 'b', 'c'].map(i => d.get(i).x + d.get(i).width), [110, 110, 110]);
  d.undo();
  assert.equal(d.get('a').x, 0);
  d.distribute(['a', 'b', 'c'], 'horizontal');
  // span 0..110, widths 40, gap = 35 -> b.x = 45
  assert.equal(d.get('b').x, 45);
});

test('orthogonal route avoids obstacles', () => {
  const d = createDocument({ actor: 'a' });
  d.apply(R('s', 0, 0, 40, 40)); d.apply(R('t', 300, 0, 40, 40)); d.apply(R('o', 120, -50, 60, 140));
  d.apply({ type: 'add', element: { id: 'c', type: 'connector', source: { elementId: 's' }, target: { elementId: 't' }, routing: 'orthogonal' } });
  const pts = d.route('c');
  for (let i = 0; i + 1 < pts.length; i++) {
    const [a, b] = [pts[i], pts[i + 1]];
    assert.ok(a[0] === b[0] || a[1] === b[1], 'axis parallel');
    // not through o interior
    const o = { x: 120, y: -50, w: 60, h: 140 };
    for (let t = 0; t <= 1; t += 0.05) {
      const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t;
      assert.ok(!(x > o.x && x < o.x + o.w && y > o.y && y < o.y + o.h), `inside at ${x},${y}`);
    }
  }
  const onBoundary = (p, e) => (p[0] === e.x || p[0] === e.x + e.width || p[1] === e.y || p[1] === e.y + e.height);
  assert.ok(onBoundary(pts[0], d.get('s')));
  assert.ok(onBoundary(pts[pts.length - 1], d.get('t')));
  const st = createDocument({ actor: 'a' });
  st.apply(R('s', 0, 0, 40, 40)); st.apply(R('t', 100, 0, 40, 40));
  st.apply({ type: 'add', element: { id: 'c', type: 'connector', source: { elementId: 's' }, target: { elementId: 't' } } });
  assert.deepEqual(st.route('c'), [[40, 20], [100, 20]]);
});

test('layered layout', () => {
  const d = createDocument({ actor: 'a' });
  const ids = ['a', 'b', 'c', 'd', 'e'];
  ids.forEach((id, i) => d.apply(R(id, i * 10, 0, 60, 30)));
  const edges = [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd'], ['a', 'e'], ['e', 'd']];
  edges.forEach(([s, t], i) => d.apply({ type: 'add', element: { id: 'c' + i, type: 'connector', source: { elementId: s }, target: { elementId: t } } }));
  d.layout('layered', { direction: 'TB', spacing: 20 });
  for (const [s, t] of edges) assert.ok(d.get(s).y + d.get(s).height <= d.get(t).y);
  const els = d.shapes();
  for (const a of els) for (const b of els) if (a !== b) {
    const ov = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    assert.ok(!ov, `${a.id} overlaps ${b.id}`);
  }
  d.layout('layered', { direction: 'LR', spacing: 20 });
  for (const [s, t] of edges) assert.ok(d.get(s).x + d.get(s).width <= d.get(t).x);
  d.layout('grid');
  d.undo();
});

test('serialization round trip + svg + drawio', () => {
  const d = createDocument({ id: 'x', actor: 'a' });
  d.apply(R('a', 0, 0, 10, 10, { text: '<b>&"x"', style: { fill: '#f00' } }));
  d.apply({ type: 'add', element: { id: 'e', type: 'ellipse', x: 20, y: 0, width: 10, height: 10 } });
  d.apply({ type: 'add', element: { id: 'c', type: 'connector', source: { elementId: 'a' }, target: { elementId: 'e' }, label: 'l<' } });
  d.apply({ type: 'group', ids: ['a', 'e'], groupId: 'g' });
  const j = d.toJSON();
  assert.deepEqual(fromJSON(j).toJSON(), j);
  assert.deepEqual(fromJSON(JSON.parse(JSON.stringify(j))).toJSON(), j);
  const svg = d.toSVG({ padding: 5 });
  assert.match(svg, /^<\?xml[^>]*>\s*<svg/);
  assert.equal((svg.match(/data-id=/g) || []).length, 3);
  assert.ok(svg.includes('&lt;b&gt;&amp;&quot;x&quot;'));
  assert.ok(!svg.includes('<b>'));
  const xml = `<mxfile><diagram id="p" name="Page-1"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
  <mxCell id="v1" value="Hello &amp;amp; bye" style="rounded=0;whiteSpace=wrap;fillColor=#dae8fc;" vertex="1" parent="1"><mxGeometry x="10" y="20" width="120" height="60" as="geometry"/></mxCell>
  <mxCell id="v2" value="" style="ellipse;whiteSpace=wrap;" vertex="1" parent="1"><mxGeometry x="200" y="20" width="80" height="80" as="geometry"/></mxCell>
  <mxCell id="v3" value="Q?" style="rhombus;" vertex="1" parent="1"><mxGeometry x="200" y="200" width="80" height="80" as="geometry"/></mxCell>
  <mxCell id="e1" value="go" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1" source="v1" target="v2"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="150" y="50"/></Array></mxGeometry></mxCell>
  </root></mxGraphModel></diagram></mxfile>`;
  const imp = importDrawio(xml);
  assert.equal(imp.get('v1').type, 'rect'); assert.equal(imp.get('v1').text, 'Hello & bye');
  assert.equal(imp.get('v1').x, 10); assert.equal(imp.get('v1').width, 120);
  assert.equal(imp.get('v2').type, 'ellipse'); assert.equal(imp.get('v3').type, 'diamond');
  assert.equal(imp.get('e1').type, 'connector'); assert.equal(imp.get('e1').source.elementId, 'v1');
  assert.equal(imp.get('e1').label, 'go'); assert.equal(imp.get('e1').routing, 'orthogonal');
  assert.deepEqual(imp.get('e1').waypoints, [[150, 50]]);
});

test('CRDT convergence', () => {
  const a = createDocument({ id: 'd', actor: 'A' });
  const b = createDocument({ id: 'd', actor: 'B' });
  const ops = [];
  a.on('op', op => ops.push(op));
  a.apply(R('r', 0, 0));
  const init = a.pendingOps();
  assert.equal(init.length, 1); assert.equal(ops.length, 1);
  assert.deepEqual(a.pendingOps(), []);
  b.receive(init); b.receive(init);
  a.apply({ type: 'update', id: 'r', patch: { x: 10 } });
  b.apply({ type: 'update', id: 'r', patch: { y: 20 } });
  a.apply({ type: 'update', id: 'r', patch: { text: 'A' } });
  b.apply({ type: 'update', id: 'r', patch: { text: 'B' } });
  const pa = a.pendingOps(), pb = b.pendingOps();
  b.receive(pa); a.receive(pb); a.receive(pb);
  assert.deepEqual(a.toJSON(), b.toJSON());
  assert.equal(a.get('r').x, 10); assert.equal(a.get('r').y, 20);
  // remove vs update
  a.apply({ type: 'remove', id: 'r' });
  b.apply({ type: 'update', id: 'r', patch: { x: 99 } });
  const qa = a.pendingOps(), qb = b.pendingOps();
  a.receive(qb); b.receive(qa);
  assert.equal(a.get('r'), undefined); assert.equal(b.get('r'), undefined);
  assert.deepEqual(a.toJSON(), b.toJSON());
  // undo only local ops
  const c = createDocument({ id: 'd', actor: 'C' });
  c.receive([...init, ...pa, ...pb]);
  c.undo();
  assert.ok(c.get('r'));
  // concurrent add -> z collision deterministic
  a.apply(R('n1', 0, 0)); b.apply(R('n2', 0, 0));
  a.receive(b.pendingOps()); b.receive(a.pendingOps());
  assert.deepEqual(a.toJSON(), b.toJSON());
  // undo emits op
  a.undo();
  b.receive(a.pendingOps());
  assert.deepEqual(a.toJSON(), b.toJSON());
});

test('randomized convergence across 3 replicas', () => {
  let seed = 42;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const reps = ['A', 'B', 'C'].map(a => createDocument({ id: 'd', actor: a }));
  const logs = [];
  for (let round = 0; round < 30; round++) {
    for (const d of reps) {
      for (let k = 0; k < 3; k++) {
        const els = d.elements().filter(e => e.type !== 'connector');
        const t = rnd(9);
        try {
          if (t === 0 || els.length < 2) d.apply({ type: 'add', element: { id: `${d.actor}${round}${k}`, type: 'rect', x: rnd(100), y: rnd(100), width: 10, height: 10 } });
          else if (t === 1) d.apply({ type: 'remove', id: els[rnd(els.length)].id });
          else if (t === 2) d.apply({ type: 'update', id: els[rnd(els.length)].id, patch: { x: rnd(100), style: { fill: '#' + rnd(999) } } });
          else if (t === 3) d.apply({ type: 'reorder', id: els[rnd(els.length)].id, to: ['front', 'back', 'forward', 'backward'][rnd(4)] });
          else if (t === 4) d.undo();
          else if (t === 5) d.redo();
          else if (t === 6) d.apply({ type: 'add', element: { id: `c${d.actor}${round}${k}`, type: 'connector', source: { elementId: els[0].id }, target: { elementId: els[1].id } } });
          else if (t === 7) d.apply({ type: 'move', ids: [els[rnd(els.length)].id], dx: 3, dy: 4 });
          else d.apply({ type: 'group', ids: [els[0].id, els[1].id] });
        } catch (e) { if (!(e instanceof DiagramError)) throw e; }
      }
      logs.push(...d.pendingOps());
    }
    // partial sync
    const r = reps[rnd(3)];
    r.receive(logs.slice(0, rnd(logs.length + 1)));
  }
  for (const d of reps) { d.receive([...logs].reverse()); d.receive(logs); }
  const j = reps.map(d => JSON.stringify(d.toJSON()));
  assert.equal(j[0], j[1]); assert.equal(j[1], j[2]);
});
