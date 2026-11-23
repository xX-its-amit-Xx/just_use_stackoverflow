import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, fromJSON, importDrawio, snap, DiagramError } from '../src/core/index.js';

const rect = (id, x, y, w = 50, h = 30, extra = {}) => ({ type: 'add', element: { id, type: 'rect', x, y, width: w, height: h, ...extra } });

test('ops, locked layers, errors', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply(rect('r1', 0, 0));
  assert.equal(d.get('r1').layer, 'default');
  assert.throws(() => d.apply({ type: 'update', id: 'nope', patch: {} }), DiagramError);
  assert.throws(() => d.apply({ type: 'bogus' }), DiagramError);
  d.apply({ type: 'addLayer', layer: { id: 'L2', name: 'two' } });
  d.apply({ type: 'update', id: 'r1', patch: { layer: 'L2' } });
  d.apply({ type: 'updateLayer', id: 'L2', patch: { locked: true } });
  assert.throws(() => d.apply({ type: 'move', ids: ['r1'], dx: 1, dy: 1 }), DiagramError);
  assert.throws(() => d.apply(rect('r2', 0, 0, 5, 5, { layer: 'L2' })), DiagramError);
});

test('style merge, remove cascades connectors, undo/redo', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply(rect('a', 0, 0)); d.apply(rect('b', 100, 0));
  d.apply({ type: 'add', element: { id: 'c', type: 'connector', source: { elementId: 'a' }, target: { elementId: 'b' } } });
  d.apply({ type: 'update', id: 'a', patch: { style: { fill: 'red' } } });
  d.apply({ type: 'update', id: 'a', patch: { style: { stroke: 'blue' } } });
  assert.deepEqual(d.get('a').style, { fill: 'red', stroke: 'blue' });
  d.apply({ type: 'remove', id: 'a' });
  assert.equal(d.get('c'), undefined);
  d.undo();
  assert.ok(d.get('c')); assert.ok(d.get('a'));
  d.redo();
  assert.equal(d.get('a'), undefined);
});

test('hitTest rotation, select, bounds, align, distribute', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply(rect('a', 0, 0, 100, 20));
  d.apply({ type: 'rotate', id: 'a', deg: 90 });
  assert.equal(d.hitTest(50, 50)?.id, 'a');
  assert.equal(d.hitTest(5, 10), null);
  d.apply(rect('b', 0, 100, 10, 10)); d.apply(rect('c', 40, 200, 10, 10)); d.apply(rect('e', 500, 300, 10, 10));
  d.distribute(['b', 'c', 'e'], 'vertical');
  assert.equal(d.get('c').y, 200);
  d.distribute(['b', 'c', 'e'], 'horizontal');
  assert.equal(d.get('c').x, 250);
  d.align(['b', 'c', 'e'], 'left');
  assert.equal(d.get('e').x, 0);
  d.undo();
  assert.equal(d.get('e').x, 500);
});

test('CRDT convergence', () => {
  const a = createDocument({ id: 'd', actor: 'a' }), b = createDocument({ id: 'd', actor: 'b' });
  a.apply(rect('r', 0, 0)); b.receive(a.pendingOps());
  a.apply({ type: 'update', id: 'r', patch: { x: 10 } });
  b.apply({ type: 'update', id: 'r', patch: { y: 20 } });
  const oa = a.pendingOps(), ob = b.pendingOps();
  a.receive(ob); a.receive(ob); b.receive([...oa].reverse()); b.receive(oa);
  assert.deepEqual(a.toJSON(), b.toJSON());
  assert.equal(a.get('r').x, 10); assert.equal(a.get('r').y, 20);
  a.apply({ type: 'update', id: 'r', patch: { x: 1 } });
  b.apply({ type: 'remove', id: 'r' });
  const x = a.pendingOps(), y = b.pendingOps();
  a.receive(y); b.receive(x);
  assert.equal(a.get('r'), undefined); assert.equal(b.get('r'), undefined);
  assert.equal(JSON.stringify(a.toJSON()), JSON.stringify(b.toJSON()));
  // received ops are not pending
  assert.deepEqual(a.pendingOps(), []);
});

test('orthogonal route avoids obstacles', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply(rect('s', 0, 100, 60, 40)); d.apply(rect('t', 400, 100, 60, 40)); d.apply(rect('o', 180, 60, 60, 120));
  d.apply({ type: 'add', element: { id: 'c', type: 'connector', source: { elementId: 's' }, target: { elementId: 't' }, routing: 'orthogonal' } });
  const r = d.route('c');
  for (let i = 0; i + 1 < r.length; i++) assert.ok(r[i][0] === r[i + 1][0] || r[i][1] === r[i + 1][1]);
  for (let i = 0; i + 1 < r.length; i++) {
    const [x1, y1] = r[i], [x2, y2] = r[i + 1];
    const ix = Math.max(Math.min(x1, x2), 180) < Math.min(Math.max(x1, x2), 240);
    const iy = Math.max(Math.min(y1, y2), 60) < Math.min(Math.max(y1, y2), 180);
    const inside = (y1 === y2 ? (y1 > 60 && y1 < 180 && ix) : (x1 > 180 && x1 < 240 && iy));
    assert.ok(!inside);
  }
  const onB = (p, x, y, w, h) => (p[0] === x || p[0] === x + w || p[1] === y || p[1] === y + h) && p[0] >= x && p[0] <= x + w && p[1] >= y && p[1] <= y + h;
  assert.ok(onB(r[0], 0, 100, 60, 40)); assert.ok(onB(r[r.length - 1], 400, 100, 60, 40));
});

test('layered layout', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  for (const i of 'abcde') d.apply(rect(i, 0, 0));
  [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd'], ['a', 'e'], ['e', 'd']].forEach(([s, t], i) =>
    d.apply({ type: 'add', element: { id: 'k' + i, type: 'connector', source: { elementId: s }, target: { elementId: t } } }));
  d.layout('layered', { direction: 'TB', spacing: 40 });
  assert.ok(d.get('b').y > d.get('a').y && d.get('d').y > d.get('b').y);
  d.layout('layered', { direction: 'LR' });
  assert.ok(d.get('b').x > d.get('a').x);
  d.layout('grid');
});

test('serialization, svg, drawio, snap', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply(rect('a', 0, 0, 50, 50, { text: 'a<b&"c' }));
  d.apply({ type: 'update', id: 'a', patch: { style: { fill: '#f00' } } });
  assert.deepEqual(fromJSON(JSON.parse(JSON.stringify(d.toJSON()))).toJSON(), d.toJSON());
  const svg = d.toSVG({ padding: 5 });
  assert.match(svg, /data-id="a"/); assert.match(svg, /a&lt;b&amp;&quot;c/);
  const dd = importDrawio(`<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" value="Hi &amp; bye" style="rounded=1;fillColor=#ff0000;" vertex="1" parent="1"><mxGeometry x="10" y="20" width="80" height="40" as="geometry"/></mxCell>
    <mxCell id="3" value="D" style="rhombus;" vertex="1" parent="1"><mxGeometry x="200" y="20" width="80" height="80" as="geometry"/></mxCell>
    <mxCell id="4" value="e" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1" source="2" target="3"><mxGeometry relative="1" as="geometry"/></mxCell></root></mxGraphModel>`);
  assert.equal(dd.get('2').text, 'Hi & bye'); assert.equal(dd.get('3').type, 'diamond');
  assert.equal(dd.get('4').routing, 'orthogonal'); assert.equal(dd.get('4').target.elementId, '3');
  assert.deepEqual(snap({ x: 13, y: 27 }, { grid: 10 }), { x: 10, y: 30 });
});
