import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, fromJSON, importDrawio, snap, toSVG, DiagramError } from '../src/core/index.js';
import { keyBetween } from '../src/core/fractional.js';

const rect = (id, x, y, w = 100, h = 50, extra = {}) => ({ type: 'add', element: { id, type: 'rect', x, y, width: w, height: h, ...extra } });
const conn = (id, s, t, extra = {}) => ({ type: 'add', element: { id, type: 'connector', source: { elementId: s }, target: { elementId: t }, ...extra } });

test('add, update, remove and unknown ids', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply(rect('r1', 0, 0));
  assert.equal(d.get('r1').width, 100);
  d.apply({ type: 'update', id: 'r1', patch: { x: 5, style: { fill: 'red' } } });
  assert.equal(d.get('r1').x, 5);
  assert.equal(d.get('r1').style.fill, 'red');
  d.apply({ type: 'update', id: 'r1', patch: { style: { stroke: 'blue' } } });
  assert.equal(d.get('r1').style.fill, 'red', 'style merges key by key');
  d.apply({ type: 'remove', id: 'r1' });
  assert.equal(d.get('r1'), undefined);
  assert.throws(() => d.apply({ type: 'remove', id: 'nope' }), DiagramError);
  assert.throws(() => d.apply({ type: 'add', element: { type: 'hexagon' } }), DiagramError);
});

test('removing a shape removes attached connectors, and undo restores them', () => {
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

test('undo/redo only revert local operations and history is one step per transaction', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.transaction(() => {
    d.apply(rect('r1', 0, 0));
    d.apply(rect('r2', 0, 100));
  });
  d.undo();
  assert.equal(d.get('r1'), undefined);
  assert.equal(d.get('r2'), undefined);
  d.redo();
  assert.ok(d.get('r1') && d.get('r2'));
});

test('transaction failure rolls back everything', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  assert.throws(() =>
    d.transaction(() => {
      d.apply(rect('r1', 0, 0));
      d.apply({ type: 'remove', id: 'missing' });
    }),
  );
  assert.equal(d.get('r1'), undefined);
  assert.equal(d.pendingOps().length, 0);
});

test('locked layers reject creates and modifications', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply({ type: 'addLayer', layer: { id: 'L', name: 'Locked', locked: true } });
  assert.throws(() => d.apply({ ...rect('x', 0, 0), element: { id: 'x', type: 'rect', layer: 'L' } }), DiagramError);
  d.apply({ type: 'updateLayer', id: 'L', patch: { locked: false } });
  d.apply({ type: 'add', element: { id: 'x', type: 'rect', layer: 'L' } });
  d.apply({ type: 'updateLayer', id: 'L', patch: { locked: true } });
  assert.throws(() => d.apply({ type: 'move', ids: ['x'], dx: 1, dy: 1 }), DiagramError);
});

test('move, resize, rotate and hit testing (rotation aware)', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply(rect('r', 0, 0, 100, 20));
  d.apply({ type: 'move', ids: ['r'], dx: 10, dy: 10 });
  assert.equal(d.get('r').x, 10);
  d.apply({ type: 'resize', id: 'r', box: { x: 0, y: 0, width: 200, height: 40 } });
  assert.equal(d.get('r').width, 200);
  d.apply({ type: 'rotate', id: 'r', deg: 90 });
  assert.equal(d.get('r').rotation, 90);
  assert.equal(d.hitTest(100, 90)?.id, 'r', 'point inside rotated shape');
  assert.equal(d.hitTest(10, 10), null, 'point outside rotated footprint');
});

test('reorder with fractional indices and hitTest topmost', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply(rect('a', 0, 0));
  d.apply(rect('b', 0, 0));
  d.apply(rect('c', 0, 0));
  assert.deepEqual(d.elements().map((e) => e.id), ['a', 'b', 'c']);
  d.apply({ type: 'reorder', id: 'a', to: 'front' });
  assert.deepEqual(d.elements().map((e) => e.id), ['b', 'c', 'a']);
  d.apply({ type: 'reorder', id: 'a', to: 'backward' });
  assert.deepEqual(d.elements().map((e) => e.id), ['b', 'a', 'c']);
  d.apply({ type: 'reorder', id: 'c', to: 'back' });
  assert.deepEqual(d.elements().map((e) => e.id), ['c', 'b', 'a']);
  assert.equal(d.hitTest(10, 10).id, 'a');
});

test('keyBetween produces strictly ordered keys', () => {
  let k = null;
  const keys = [];
  for (let i = 0; i < 200; i++) {
    k = keyBetween(k, null);
    keys.push(k);
  }
  assert.deepEqual([...keys].sort(), keys);
  const m = keyBetween(keys[0], keys[1]);
  assert.ok(keys[0] < m && m < keys[1]);
  const lo = keyBetween(null, keys[0]);
  assert.ok(lo < keys[0]);
});

test('align and distribute', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply(rect('a', 0, 0, 50, 50));
  d.apply(rect('b', 100, 20, 50, 30));
  d.apply(rect('c', 300, 0, 50, 50));
  d.align(['a', 'b', 'c'], 'top');
  assert.ok(['a', 'b', 'c'].every((id) => d.get(id).y === 0));
  d.align(['a', 'b', 'c'], 'middle');
  assert.ok(['a', 'b', 'c'].every((id) => d.get(id).y + d.get(id).height / 2 === 25));
  d.apply({ type: 'move', ids: ['b'], dx: 0, dy: 0 });
  d.distribute(['a', 'b', 'c'], 'horizontal');
  const gap1 = d.get('b').x - (d.get('a').x + d.get('a').width);
  const gap2 = d.get('c').x - (d.get('b').x + d.get('b').width);
  assert.equal(gap1, gap2);
  assert.equal(d.get('a').x, 0);
  assert.equal(d.get('c').x, 300);
  d.align(['a', 'b', 'c'], 'right');
  assert.ok(['a', 'b', 'c'].every((id) => d.get(id).x + d.get(id).width === 350));
});

test('select(rect) returns ids fully contained and bounds()', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply(rect('a', 0, 0, 10, 10));
  d.apply(rect('b', 50, 50, 10, 10));
  assert.deepEqual(d.select({ x: 0, y: 0, width: 30, height: 30 }), ['a']);
  assert.deepEqual(d.bounds(), { x: 0, y: 0, width: 60, height: 60 });
});

test('snap to grid and guides', () => {
  assert.deepEqual(snap({ x: 13, y: 27 }, { grid: 10 }), { x: 10, y: 30 });
  assert.deepEqual(snap({ x: 102, y: 7 }, { grid: 10, guides: { x: [100] } }), { x: 100, y: 10 });
});

test('orthogonal routes are axis-parallel and avoid other shapes', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply(rect('a', 0, 0, 100, 50));
  d.apply(rect('b', 400, 0, 100, 50));
  d.apply(rect('blocker', 180, -40, 100, 130));
  d.apply(conn('c', 'a', 'b', { routing: 'orthogonal' }));
  const pts = d.route('c');
  for (let i = 0; i + 1 < pts.length; i++) {
    assert.ok(pts[i][0] === pts[i + 1][0] || pts[i][1] === pts[i + 1][1], 'axis-parallel segment');
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    const b = { x: 180, y: -40, w: 100, h: 130 };
    assert.ok(!(mx > b.x && mx < b.x + b.w && my > b.y && my < b.y + b.h), 'segment avoids blocker interior');
  }
});

test('straight routes start and end on boundaries', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply(rect('a', 0, 0, 100, 100));
  d.apply(rect('b', 300, 0, 100, 100));
  d.apply(conn('c', 'a', 'b'));
  const pts = d.route('c');
  assert.deepEqual(pts[0], [100, 50]);
  assert.deepEqual(pts[pts.length - 1], [300, 50]);
});

test('layered layout: edges point down, nodes in a layer do not overlap', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  for (const id of ['a', 'b', 'c', 'd', 'e']) d.apply(rect(id, 0, 0, 80, 40));
  for (const [i, [s, t]] of [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd'], ['a', 'e'], ['e', 'd']].entries()) d.apply(conn(`e${i}`, s, t));
  d.layout('layered', { direction: 'TB', spacing: 40 });
  for (const e of d.elements().filter((x) => x.type === 'connector')) {
    const s = d.get(e.source.elementId);
    const t = d.get(e.target.elementId);
    assert.ok(t.y > s.y, `edge ${e.id} points down`);
  }
  const shapes = d.elements().filter((x) => x.type !== 'connector');
  for (const p of shapes) for (const q of shapes) {
    if (p === q || p.y !== q.y) continue;
    assert.ok(p.x + p.width <= q.x || q.x + q.width <= p.x, 'no overlap in a layer');
  }
  d.layout('grid');
  assert.equal(d.elements().filter((x) => x.type !== 'connector').length, 5);
});

test('toJSON / fromJSON round trip is lossless', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply(rect('a', 1, 2, 3, 4, { style: { fill: '#fff' }, text: 'hi' }));
  d.apply(rect('b', 10, 2));
  d.apply(conn('c', 'a', 'b', { label: 'x', waypoints: [[5, 5]] }));
  const json = JSON.parse(JSON.stringify(d.toJSON()));
  const back = fromJSON(json);
  assert.deepEqual(back.toJSON(), d.toJSON());
  assert.equal(back.get('a').text, 'hi');
});

test('replicas converge under concurrent edits, duplicates and reordering', () => {
  const a = createDocument({ id: 'x', actor: 'A' });
  const b = createDocument({ id: 'x', actor: 'B' });
  const c = createDocument({ id: 'x', actor: 'C' });
  a.apply(rect('p', 0, 0));
  const base = a.pendingOps();
  b.receive(base);
  c.receive(base);
  a.apply({ type: 'update', id: 'p', patch: { x: 10 } });
  a.apply({ type: 'update', id: 'p', patch: { y: 20 } });
  b.apply({ type: 'update', id: 'p', patch: { x: 99 } });
  b.apply({ type: 'update', id: 'p', patch: { width: 7 } });
  c.apply({ type: 'remove', id: 'p' });
  const opsA = a.pendingOps();
  const opsB = b.pendingOps();
  const opsC = c.pendingOps();
  const all = [...opsA, ...opsB, ...opsC];
  const order1 = [...all, ...all.slice(0, 3)];
  const order2 = [...all].reverse().concat(all);
  const r1 = createDocument({ id: 'x', actor: 'R1' });
  const r2 = createDocument({ id: 'x', actor: 'R2' });
  r1.receive(order1);
  r2.receive(order2);
  assert.deepEqual(r1.toJSON(), r2.toJSON());
  // Concurrent update vs remove: removed wins.
  assert.equal(r1.get('p'), undefined);
});

test('concurrent edits to different properties both apply; same property is LWW', () => {
  const a = createDocument({ id: 'x', actor: 'A' });
  const b = createDocument({ id: 'x', actor: 'B' });
  a.apply(rect('p', 0, 0, 10, 10));
  b.receive(a.pendingOps());
  a.apply({ type: 'update', id: 'p', patch: { x: 5 } });
  b.apply({ type: 'update', id: 'p', patch: { y: 9 } });
  b.apply({ type: 'update', id: 'p', patch: { x: 7 } });
  const oa = a.pendingOps();
  const ob = b.pendingOps();
  a.receive(ob);
  b.receive(oa);
  assert.equal(a.get('p').y, 9);
  assert.equal(a.get('p').x, b.get('p').x);
  assert.equal(a.get('p').x, 7, 'later Lamport timestamp wins');
});

test('pendingOps excludes remote ops and clears the buffer; op event fires', () => {
  const a = createDocument({ id: 'x', actor: 'A' });
  const b = createDocument({ id: 'x', actor: 'B' });
  const seen = [];
  a.on('op', (op) => seen.push(op));
  a.apply(rect('p', 0, 0));
  b.apply(rect('q', 0, 0));
  a.receive(b.pendingOps());
  assert.equal(seen.length, 1);
  assert.equal(a.pendingOps().length, 1);
  assert.equal(a.pendingOps().length, 0);
});

test('undo of a field that a remote replica later changed does not clobber remote value', () => {
  const a = createDocument({ id: 'x', actor: 'A' });
  const b = createDocument({ id: 'x', actor: 'B' });
  a.apply(rect('p', 0, 0));
  b.receive(a.pendingOps());
  a.apply({ type: 'update', id: 'p', patch: { x: 5 } });
  b.receive(a.pendingOps());
  b.apply({ type: 'update', id: 'p', patch: { x: 50 } });
  a.receive(b.pendingOps());
  a.undo();
  assert.equal(a.get('p').x, 50);
});

test('setStyle, group/ungroup, layers', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply(rect('a', 0, 0));
  d.apply(rect('b', 0, 0));
  d.apply({ type: 'setStyle', ids: ['a', 'b'], style: { fill: 'green' } });
  assert.equal(d.get('b').style.fill, 'green');
  d.apply({ type: 'group', ids: ['a', 'b'], groupId: 'g1' });
  assert.equal(d.get('a').groupId, 'g1');
  d.apply({ type: 'ungroup', groupId: 'g1' });
  assert.equal(d.get('a').groupId, null);
  d.apply({ type: 'addLayer', layer: { id: 'L2', name: 'Two' } });
  d.apply({ type: 'update', id: 'b', patch: { layer: 'L2' } });
  assert.equal(d.elements({ layer: 'L2' }).length, 1);
  d.apply({ type: 'updateLayer', id: 'L2', patch: { visible: false } });
  assert.equal(d.hitTest(10, 10)?.id, 'a');
  d.apply({ type: 'removeLayer', id: 'L2' });
  assert.equal(d.get('b').layer, 'default');
});

test('svg export has one data-id element per shape and escapes text', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply(rect('a', 0, 0, 10, 10, { text: '<b>&"x"' }));
  d.apply(rect('b', 50, 0, 10, 10));
  d.apply(conn('c', 'a', 'b'));
  const svg = toSVG(d);
  assert.match(svg, /^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  for (const id of ['a', 'b', 'c']) assert.equal(svg.split(`data-id="${id}"`).length - 1, 1);
  assert.ok(svg.includes('&lt;b&gt;&amp;&quot;x&quot;'));
  assert.ok(!svg.includes('<b>'));
});

test('draw.io import maps vertices, edges, labels and geometry', () => {
  const xml = `<mxfile><diagram><mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" value="Hi &amp; bye" style="rounded=0;" vertex="1" parent="1"><mxGeometry x="10" y="20" width="100" height="50" as="geometry"/></mxCell>
    <mxCell id="3" value="" style="ellipse;" vertex="1" parent="1"><mxGeometry x="200" y="20" width="60" height="60" as="geometry"/></mxCell>
    <mxCell id="4" value="Dia" style="rhombus;" vertex="1" parent="1"><mxGeometry x="300" y="20" width="60" height="60" as="geometry"/></mxCell>
    <mxCell id="5" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1" source="2" target="3"><mxGeometry relative="1" as="geometry"/></mxCell>
    <mxCell id="6" style="" edge="1" parent="1" source="2" target="missing"><mxGeometry relative="1" as="geometry"/></mxCell>
  </root></mxGraphModel></diagram></mxfile>`;
  const d = importDrawio(xml);
  assert.equal(d.get('2').text, 'Hi & bye');
  assert.equal(d.get('2').type, 'rect');
  assert.equal(d.get('3').type, 'ellipse');
  assert.equal(d.get('4').type, 'diamond');
  assert.equal(d.get('5').type, 'connector');
  assert.equal(d.get('5').routing, 'orthogonal');
  assert.equal(d.get('6'), undefined, 'dangling edge skipped');
  assert.equal(d.get('2').x, 10);
});
