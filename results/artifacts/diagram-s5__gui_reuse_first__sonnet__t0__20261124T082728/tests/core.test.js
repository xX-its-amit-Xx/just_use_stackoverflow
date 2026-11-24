import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, fromJSON, importDrawio, snap, DiagramError } from '../src/core/index.js';
const mk = (a = 'a') => createDocument({ id: 'd', actor: a });
const rect = (d, id, x, y, w = 40, h = 30) => d.apply({ type: 'add', element: { id, type: 'rect', x, y, width: w, height: h } });

test('locked layer, errors', () => {
  const d = mk(); rect(d, 'r', 0, 0);
  d.apply({ type: 'addLayer', layer: { id: 'L', name: 'L' } });
  d.apply({ type: 'update', id: 'r', patch: { layer: 'L' } });
  d.apply({ type: 'updateLayer', id: 'L', patch: { locked: true } });
  assert.throws(() => d.apply({ type: 'move', ids: ['r'], dx: 1, dy: 1 }), DiagramError);
  assert.throws(() => d.apply({ type: 'nope' }), DiagramError);
  assert.throws(() => d.apply({ type: 'remove', id: 'zzz' }), DiagramError);
});
test('convergence out of order with duplicates', () => {
  const A = mk('a'), B = mk('b'), C = mk('c');
  rect(A, 'r', 0, 0); const first = A.pendingOps(); B.receive(first); C.receive(first);
  A.apply({ type: 'update', id: 'r', patch: { x: 5 } });
  B.apply({ type: 'update', id: 'r', patch: { y: 7, style: { fill: 'red' } } });
  C.apply({ type: 'remove', id: 'r' });
  const all = [...A.pendingOps(), ...B.pendingOps(), ...C.pendingOps()];
  for (const d of [A, B, C]) d.receive([...all].reverse()), d.receive(all);
  assert.deepEqual(A.toJSON(), B.toJSON()); assert.deepEqual(B.toJSON(), C.toJSON());
  assert.equal(A.get('r'), undefined);
});
test('undo/redo only local, transaction', () => {
  const A = mk('a'), B = mk('b');
  A.transaction(() => { rect(A, '1', 0, 0); rect(A, '2', 10, 10); });
  assert.equal(A.elements().length, 2); A.undo(); assert.equal(A.elements().length, 0); A.redo(); assert.equal(A.elements().length, 2);
  B.receive(A.pendingOps()); rect(B, '3', 0, 0); B.undo(); assert.equal(B.elements().length, 2);
});
test('align/distribute/hitTest/select', () => {
  const d = mk(); rect(d, 'a', 0, 0, 10, 10); rect(d, 'b', 15, 50, 10, 10); rect(d, 'c', 100, 20, 10, 10);
  d.distribute(['a', 'b', 'c'], 'horizontal'); assert.equal(d.get('b').x, 50);
  d.align(['a', 'b', 'c'], 'top'); assert.equal(d.get('c').y, 0);
  d.undo(); assert.equal(d.get('c').y, 20);
  assert.equal(d.hitTest(5, 5).id, 'a'); assert.equal(d.hitTest(500, 5), null);
  d.apply({ type: 'rotate', id: 'a', deg: 90 });
  assert.deepEqual(d.select({ x: -1, y: -1, width: 30, height: 30 }), ['a']);
});
test('orthogonal route avoids obstacles', () => {
  const d = mk(); rect(d, 's', 0, 100, 40, 40); rect(d, 't', 300, 100, 40, 40); rect(d, 'o', 140, 80, 60, 80);
  d.apply({ type: 'add', element: { id: 'c', type: 'connector', source: { elementId: 's' }, target: { elementId: 't' }, routing: 'orthogonal' } });
  const r = d.route('c');
  for (let i = 0; i + 1 < r.length; i++) {
    const [a, b] = [r[i], r[i + 1]]; assert.ok(a[0] === b[0] || a[1] === b[1]);
    const lo = [Math.min(a[0], b[0]), Math.min(a[1], b[1])], hi = [Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    assert.ok(!(hi[0] > 140 && lo[0] < 200 && hi[1] > 80 && lo[1] < 160));
  }
});
test('layered layout + svg + json + drawio + snap', () => {
  const d = mk(); for (const i of [1, 2, 3, 4]) rect(d, 'n' + i, 0, 0);
  [['n1', 'n2'], ['n1', 'n3'], ['n2', 'n4'], ['n3', 'n4']].forEach(([s, t], i) => d.apply({ type: 'add', element: { id: 'e' + i, type: 'connector', source: { elementId: s }, target: { elementId: t } } }));
  d.layout('layered', { direction: 'TB', spacing: 40 });
  assert.ok(d.get('n1').y < d.get('n2').y && d.get('n2').y < d.get('n4').y);
  d.layout('layered', { direction: 'LR' }); assert.ok(d.get('n1').x < d.get('n2').x);
  d.apply({ type: 'update', id: 'n1', patch: { text: 'a<b&"' } });
  const svg = d.toSVG({ padding: 10 }); assert.equal((svg.match(/data-id=/g) || []).length, 8); assert.ok(svg.includes('a&lt;b&amp;&quot;'));
  assert.deepEqual(fromJSON(JSON.parse(JSON.stringify(d.toJSON()))).toJSON(), d.toJSON());
  assert.deepEqual(snap({ x: 13, y: 27 }, { grid: 10 }), { x: 10, y: 30 });
  assert.deepEqual(snap({ x: 13, y: 27 }, { grid: 10, guides: [{ axis: 'x', value: 15 }] }), { x: 15, y: 30 });
  const dd = importDrawio('<mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="a" value="Hi" style="rhombus" vertex="1" parent="1"><mxGeometry x="1" y="2" width="3" height="4" as="geometry"/></mxCell><mxCell id="b" vertex="1" parent="1"><mxGeometry width="3" height="4" as="geometry"/></mxCell><mxCell id="e" edge="1" source="a" target="b" parent="1"/></root></mxGraphModel>');
  assert.equal(dd.get('a').type, 'diamond'); assert.equal(dd.get('e').type, 'connector');
});
