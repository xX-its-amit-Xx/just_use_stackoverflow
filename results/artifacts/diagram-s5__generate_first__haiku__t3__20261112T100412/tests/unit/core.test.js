import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, fromJSON, importDrawio, snap, DiagramError } from '../../src/core/index.js';

const rect = (id, x, y, w = 100, h = 50, extra = {}) => ({ type: 'add', element: { id, type: 'rect', x, y, width: w, height: h, ...extra } });
const conn = (id, s, t, extra = {}) => ({ type: 'add', element: { id, type: 'connector', source: { elementId: s }, target: { elementId: t }, ...extra } });

test('add, get, update merges style key by key', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply({ type: 'add', element: { id: 'r', type: 'rect', x: 1, y: 2, width: 3, height: 4, style: { fill: 'red', stroke: 'blue' } } });
  d.apply({ type: 'update', id: 'r', patch: { style: { fill: 'green' }, text: 'hi' } });
  const e = d.get('r');
  assert.equal(e.x, 1);
  assert.equal(e.rotation, 0);
  assert.deepEqual(e.style, { fill: 'green', stroke: 'blue' });
  assert.equal(e.text, 'hi');
  assert.equal(e.layer, 'default');
});

test('unknown ids and types throw DiagramError', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  assert.throws(() => d.apply({ type: 'update', id: 'nope', patch: {} }), DiagramError);
  assert.throws(() => d.apply({ type: 'bogus' }), DiagramError);
  assert.throws(() => d.apply({ type: 'add', element: { id: 'x', type: 'blob' } }), DiagramError);
  assert.ok(new DiagramError('x') instanceof Error);
});

test('remove cascades to attached connectors and undo restores them', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply(rect('a', 0, 0));
  d.apply(rect('b', 300, 0));
  d.apply(conn('c', 'a', 'b'));
  d.apply({ type: 'remove', id: 'a' });
  assert.equal(d.get('c'), undefined);
  d.undo();
  assert.ok(d.get('a'));
  assert.ok(d.get('c'));
});

test('undo/redo only revert local actor operations and history is one step per transaction', () => {
  const a = createDocument({ id: 'd', actor: 'A' });
  const b = createDocument({ id: 'd', actor: 'B' });
  a.apply(rect('r', 0, 0));
  b.receive(a.pendingOps());
  b.apply({ type: 'update', id: 'r', patch: { text: 'from B' } });
  a.receive(b.pendingOps());
  a.transaction(() => {
    a.apply({ type: 'move', ids: ['r'], dx: 5, dy: 0 });
    a.apply({ type: 'move', ids: ['r'], dx: 5, dy: 0 });
  });
  assert.equal(a.get('r').x, 10);
  a.undo();
  assert.equal(a.get('r').x, 0);
  assert.equal(a.get('r').text, 'from B');
  assert.equal(a.undo(), true);
  assert.equal(a.get('r'), undefined); // the add is undone, but B's text edit is not ours to undo
});

test('undo of a local add does not reach into remote edits', () => {
  const a = createDocument({ id: 'd', actor: 'A' });
  a.apply(rect('r', 0, 0));
  a.undo();
  assert.equal(a.get('r'), undefined);
});

test('move, resize, rotate, setStyle', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply(rect('r', 10, 10, 100, 50));
  d.apply({ type: 'move', ids: ['r'], dx: 5, dy: -5 });
  d.apply({ type: 'resize', id: 'r', box: { x: 0, y: 0, width: 200, height: 80 } });
  d.apply({ type: 'rotate', id: 'r', deg: 45 });
  d.apply({ type: 'setStyle', ids: ['r'], style: { opacity: 0.5 } });
  const e = d.get('r');
  assert.deepEqual([e.x, e.y, e.width, e.height, e.rotation], [0, 0, 200, 80, 45]);
  assert.equal(e.style.opacity, 0.5);
});

test('locked layers reject creation and modification, but not unlocking', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply({ type: 'addLayer', layer: { id: 'L', name: 'Locked', locked: true } });
  assert.throws(() => d.apply(rect('x', 0, 0, 1, 1, { layer: 'L' })), DiagramError);
  d.apply({ type: 'updateLayer', id: 'L', patch: { locked: false } });
  d.apply(rect('x', 0, 0, 1, 1, { layer: 'L' }));
  d.apply({ type: 'updateLayer', id: 'L', patch: { locked: true } });
  assert.throws(() => d.apply({ type: 'move', ids: ['x'], dx: 1, dy: 1 }), DiagramError);
});

test('hitTest is rotation-aware and select uses containment', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply(rect('r', 0, 0, 100, 20, { rotation: 90 }));
  assert.equal(d.hitTest(50, 40)?.id, 'r'); // rotated box is tall
  assert.equal(d.hitTest(90, 10), null);
  d.apply(rect('s', 200, 200));
  assert.deepEqual(d.select({ x: -50, y: -50, width: 200, height: 200 }).map((e) => e.id), ['r']);
});

test('z-order reorder front/back/forward/backward', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply(rect('a', 0, 0));
  d.apply(rect('b', 0, 0));
  d.apply(rect('c', 0, 0));
  const order = () => d.elements().map((e) => e.id);
  assert.deepEqual(order(), ['a', 'b', 'c']);
  d.apply({ type: 'reorder', id: 'a', to: 'front' });
  assert.deepEqual(order(), ['b', 'c', 'a']);
  d.apply({ type: 'reorder', id: 'a', to: 'back' });
  assert.deepEqual(order(), ['a', 'b', 'c']);
  d.apply({ type: 'reorder', id: 'a', to: 'forward' });
  assert.deepEqual(order(), ['b', 'a', 'c']);
  d.apply({ type: 'reorder', id: 'a', to: 'backward' });
  assert.deepEqual(order(), ['a', 'b', 'c']);
});

test('group and ungroup', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply(rect('a', 0, 0));
  d.apply(rect('b', 0, 0));
  d.apply({ type: 'group', ids: ['a', 'b'], groupId: 'g1' });
  assert.equal(d.get('a').groupId, 'g1');
  d.apply({ type: 'ungroup', groupId: 'g1' });
  assert.equal(d.get('b').groupId, null);
});

test('align and distribute', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply(rect('a', 0, 0, 50, 50));
  d.apply(rect('b', 100, 20, 50, 50));
  d.apply(rect('c', 300, 40, 50, 50));
  d.align(['a', 'b', 'c'], 'top');
  assert.deepEqual([d.get('a').y, d.get('b').y, d.get('c').y], [0, 0, 0]);
  d.distribute(['a', 'b', 'c'], 'horizontal');
  const gap1 = d.get('b').x - (d.get('a').x + 50);
  const gap2 = d.get('c').x - (d.get('b').x + 50);
  assert.equal(gap1, gap2);
  assert.equal(d.get('c').x, 300);
});

test('orthogonal route is axis-parallel and avoids other shapes', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply(rect('s', 0, 0, 100, 50));
  d.apply(rect('t', 400, 0, 100, 50));
  d.apply(rect('blocker', 200, -40, 80, 140));
  d.apply(conn('c', 's', 't', { routing: 'orthogonal' }));
  const pts = d.route('c');
  assert.ok(pts.length >= 2);
  for (let i = 1; i < pts.length; i++) {
    assert.ok(pts[i][0] === pts[i - 1][0] || pts[i][1] === pts[i - 1][1], 'axis-parallel');
    const mx = (pts[i][0] + pts[i - 1][0]) / 2;
    const my = (pts[i][1] + pts[i - 1][1]) / 2;
    const inside = mx > 200 && mx < 280 && my > -40 && my < 100;
    assert.ok(!inside, 'does not pass through blocker');
  }
  const first = pts[0];
  assert.ok(first[0] === 100 || first[1] === 0 || first[1] === 50, 'starts on source boundary');
});

test('straight route clips to element boundaries', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply(rect('s', 0, 0, 100, 100));
  d.apply(rect('t', 300, 0, 100, 100));
  d.apply(conn('c', 's', 't'));
  const pts = d.route('c');
  assert.deepEqual(pts[0], [100, 50]);
  assert.deepEqual(pts[pts.length - 1], [300, 50]);
});

test('layered layout puts edges downward with no overlaps', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  for (const id of ['a', 'b', 'c', 'd2']) d.apply(rect(id, 0, 0, 100, 50));
  d.apply(conn('e1', 'a', 'b'));
  d.apply(conn('e2', 'a', 'c'));
  d.apply(conn('e3', 'b', 'd2'));
  d.apply(conn('e4', 'c', 'd2'));
  d.layout('layered', { direction: 'TB', spacing: 30 });
  const g = (id) => d.get(id);
  assert.ok(g('b').y > g('a').y && g('c').y > g('a').y);
  assert.ok(g('d2').y > g('b').y);
  const shapes = ['a', 'b', 'c', 'd2'].map(g);
  for (let i = 0; i < shapes.length; i++) {
    for (let j = i + 1; j < shapes.length; j++) {
      const p = shapes[i];
      const q = shapes[j];
      const overlap = p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height;
      assert.ok(!overlap, `${p.id} overlaps ${q.id}`);
    }
  }
  d.layout('layered', { direction: 'LR' });
  assert.ok(g('b').x > g('a').x && g('d2').x > g('b').x);
  d.layout('grid');
});

test('toJSON / fromJSON round trip is lossless', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply(rect('r', 0, 0, 10, 10, { text: 'a & <b>', style: { fill: '#fff' } }));
  d.apply(conn('c', 'r', 'r'));
  const j = JSON.parse(JSON.stringify(d.toJSON()));
  const d2 = fromJSON(j, { actor: 'b' });
  assert.deepEqual(JSON.parse(JSON.stringify(d2.toJSON())), j);
});

test('SVG output escapes text and carries data-id attributes', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply(rect('r', 0, 0, 100, 50, { text: '<script>&"' }));
  d.apply(rect('s', 200, 0, 100, 50));
  d.apply(conn('c', 'r', 's'));
  const svg = d.toSVG({ padding: 10 });
  assert.match(svg, /^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.ok(!svg.includes('<script>'));
  assert.ok(svg.includes('&lt;script&gt;&amp;&quot;'));
  for (const id of ['r', 's', 'c']) assert.ok(svg.includes(`data-id="${id}"`));
});

test('pendingOps is cleared on read and received ops are never re-emitted', () => {
  const a = createDocument({ id: 'd', actor: 'A' });
  const b = createDocument({ id: 'd', actor: 'B' });
  a.apply(rect('r', 0, 0));
  const ops = a.pendingOps();
  assert.equal(a.pendingOps().length, 0);
  b.receive(ops);
  assert.equal(b.pendingOps().length, 0);
  assert.equal(b.receive(ops), 0);
});

test('replicas converge under reordering and duplication of ops', () => {
  const a = createDocument({ id: 'd', actor: 'A' });
  const b = createDocument({ id: 'd', actor: 'B' });
  const c = createDocument({ id: 'd', actor: 'C' });
  a.apply(rect('r', 0, 0));
  a.apply(rect('s', 0, 0));
  const base = a.pendingOps();
  b.receive(base);
  c.receive(base);
  b.apply({ type: 'update', id: 'r', patch: { text: 'B' } });
  b.apply({ type: 'move', ids: ['r'], dx: 3, dy: 0 });
  c.apply({ type: 'update', id: 'r', patch: { text: 'C', style: { fill: 'red' } } });
  c.apply({ type: 'remove', id: 's' });
  c.apply({ type: 'reorder', id: 'r', to: 'front' });
  a.apply({ type: 'move', ids: ['s'], dx: 9, dy: 9 });
  a.apply({ type: 'update', id: 'r', patch: { text: 'A' } });
  const ob = b.pendingOps();
  const oc = c.pendingOps();
  const oa = a.pendingOps();
  const all = [...ob, ...oc, ...oa, ...ob];
  const x = createDocument({ id: 'd', actor: 'X' });
  const y = createDocument({ id: 'd', actor: 'Y' });
  x.receive(base);
  y.receive(base);
  x.receive([...oa].reverse());
  x.receive(all);
  y.receive(all.slice().reverse());
  y.receive(oc);
  const sx = JSON.stringify(x.toJSON());
  assert.equal(sx, JSON.stringify(y.toJSON()));
  assert.equal(x.get('s'), undefined);
  assert.ok(['A', 'C'].includes(x.get('r').text));
});

test('concurrent updates to different properties both apply', () => {
  const a = createDocument({ id: 'd', actor: 'A' });
  const b = createDocument({ id: 'd', actor: 'B' });
  a.apply(rect('r', 0, 0));
  b.receive(a.pendingOps());
  a.apply({ type: 'update', id: 'r', patch: { x: 50 } });
  b.apply({ type: 'update', id: 'r', patch: { text: 'hello' } });
  a.receive(b.pendingOps());
  b.receive(a.pendingOps());
  assert.equal(a.get('r').x, 50);
  assert.equal(a.get('r').text, 'hello');
  assert.equal(b.get('r').text, 'hello');
  assert.equal(b.get('r').x, 50);
});

test('concurrent remove vs update resolves to removed', () => {
  const a = createDocument({ id: 'd', actor: 'A' });
  const b = createDocument({ id: 'd', actor: 'B' });
  a.apply(rect('r', 0, 0));
  b.receive(a.pendingOps());
  a.apply({ type: 'remove', id: 'r' });
  b.apply({ type: 'update', id: 'r', patch: { x: 9 } });
  a.receive(b.pendingOps());
  b.receive(a.pendingOps());
  assert.equal(a.get('r'), undefined);
  assert.equal(b.get('r'), undefined);
});

test('snap rounds to grid and prefers guides within threshold', () => {
  assert.deepEqual(snap({ x: 13, y: 27 }, { grid: 10 }), { x: 10, y: 30 });
  assert.deepEqual(snap({ x: 13, y: 27 }, { grid: 10, guides: [{ x: 12 }, { y: 100 }] }), { x: 12, y: 30 });
});

test('draw.io import maps vertices, edges, labels and geometry', () => {
  const xml = `<mxfile><diagram><mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="a" value="Hello &amp; bye" style="rounded=0;fillColor=#dae8fc;" vertex="1" parent="1"><mxGeometry x="10" y="20" width="120" height="60" as="geometry"/></mxCell>
    <mxCell id="b" value="" style="rhombus;whiteSpace=wrap;" vertex="1" parent="1"><mxGeometry x="300" y="20" width="80" height="80" as="geometry"/></mxCell>
    <mxCell id="e" value="yes" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1" source="a" target="b"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="200" y="200"/></Array></mxGeometry></mxCell>
  </root></mxGraphModel></diagram></mxfile>`;
  const d = importDrawio(xml);
  const a = d.get('a');
  assert.equal(a.type, 'rect');
  assert.equal(a.text, 'Hello & bye');
  assert.equal(a.x, 10);
  assert.equal(a.style.fill, '#dae8fc');
  assert.equal(d.get('b').type, 'diamond');
  const c = d.get('e');
  assert.equal(c.type, 'connector');
  assert.equal(c.routing, 'orthogonal');
  assert.equal(c.label, 'yes');
  assert.deepEqual(c.waypoints, [[200, 200]]);
  assert.throws(() => importDrawio('<nope/>'), DiagramError);
});

test('invalid remote ops are rejected', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  assert.throws(() => d.receive([{ nope: true }]), DiagramError);
});
