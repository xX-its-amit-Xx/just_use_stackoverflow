import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, fromJSON, importDrawio, snap, DiagramError } from '../../src/core/index.js';

const rect = (id, x, y, w = 100, h = 50, extra = {}) => ({ id, type: 'rect', x, y, width: w, height: h, ...extra });
const link = (id, s, t, routing = 'straight') => ({ id, type: 'connector', source: { elementId: s }, target: { elementId: t }, routing });

test('defaults, unknown ids and types', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply({ type: 'add', element: { id: 'r', type: 'rect' } });
  const r = d.get('r');
  assert.equal(r.x, 0); assert.equal(r.width, 0); assert.equal(r.rotation, 0); assert.equal(r.layer, 'default');
  assert.throws(() => d.apply({ type: 'move', ids: ['nope'], dx: 1, dy: 1 }), DiagramError);
  assert.throws(() => d.apply({ type: 'bogus' }), DiagramError);
  assert.throws(() => d.apply({ type: 'add', element: link('c', 'r', 'missing') }), DiagramError);
});

test('style updates merge key by key; move, resize, rotate', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply({ type: 'add', element: rect('r', 0, 0, 100, 50, { style: { fill: 'red', stroke: 'blue' } }) });
  d.apply({ type: 'update', id: 'r', patch: { style: { fill: 'green' } } });
  assert.deepEqual(d.get('r').style, { fill: 'green', stroke: 'blue' });
  d.apply({ type: 'move', ids: ['r'], dx: 5, dy: -5 });
  assert.equal(d.get('r').x, 5); assert.equal(d.get('r').y, -5);
  d.apply({ type: 'resize', id: 'r', box: { x: 0, y: 0, width: 200, height: 100 }, keepAspect: true });
  assert.equal(d.get('r').width, 200); assert.equal(d.get('r').height, 100);
  d.apply({ type: 'rotate', id: 'r', deg: 90 });
  assert.equal(d.get('r').rotation, 90);
});

test('rotation-aware hit test and select(rect)', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply({ type: 'add', element: rect('wide', 0, 0, 200, 20, { rotation: 90 }) });
  assert.ok(d.hitTest(100, 90), 'rotated shape is hit vertically');
  assert.equal(d.hitTest(20, 10), null);
  d.apply({ type: 'add', element: rect('a', 300, 300, 10, 10) });
  assert.deepEqual(d.select({ x: 290, y: 290, width: 50, height: 50 }).map((e) => e.id), ['a']);
});

test('undo/redo and undo scoped to local actor', () => {
  const a = createDocument({ id: 'd', actor: 'A' });
  const b = createDocument({ id: 'd', actor: 'B' });
  a.apply({ type: 'add', element: rect('r', 0, 0) });
  b.receive(a.pendingOps());
  a.apply({ type: 'update', id: 'r', patch: { text: 'from A' } });
  b.apply({ type: 'update', id: 'r', patch: { style: { fill: 'red' } } });
  a.receive(b.pendingOps());
  assert.equal(a.undo(), true);
  assert.equal(a.get('r').text, '', "A's undo reverts A's text");
  assert.equal(a.get('r').style.fill, 'red', "B's fill is untouched");
  a.redo();
  assert.equal(a.get('r').text, 'from A');
  a.undo(); a.undo();
  assert.equal(a.get('r'), undefined, 'undo of add removes element');
  assert.equal(a.undo(), false, 'nothing left to undo');
});

test('transaction is one undo step and rolls back on error', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.transaction(() => { d.apply({ type: 'add', element: rect('x', 0, 0) }); d.apply({ type: 'add', element: rect('y', 0, 0) }); });
  d.undo();
  assert.equal(d.get('x'), undefined); assert.equal(d.get('y'), undefined);
  assert.throws(() => d.transaction(() => { d.apply({ type: 'add', element: rect('z', 0, 0) }); d.apply({ type: 'move', ids: ['nope'], dx: 1, dy: 0 }); }), DiagramError);
  assert.equal(d.get('z'), undefined, 'failed transaction is rolled back');
});

test('locked layers reject creates and modifications', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply({ type: 'add', element: rect('r', 0, 0) });
  d.apply({ type: 'addLayer', layer: { id: 'L2', name: 'Locked' } });
  d.apply({ type: 'updateLayer', id: 'L2', patch: { locked: true } });
  assert.throws(() => d.apply({ type: 'add', element: rect('n', 0, 0, 10, 10, { layer: 'L2' }) }), DiagramError);
  assert.throws(() => d.apply({ type: 'update', id: 'r', patch: { layer: 'L2' } }), DiagramError);
  d.apply({ type: 'updateLayer', id: 'L2', patch: { locked: false } });
  d.apply({ type: 'add', element: rect('n', 0, 0, 10, 10, { layer: 'L2' }) });
  d.apply({ type: 'updateLayer', id: 'L2', patch: { locked: true } });
  assert.throws(() => d.apply({ type: 'move', ids: ['n'], dx: 1, dy: 1 }), DiagramError);
  assert.equal(d.elements({ layer: 'L2' }).length, 1);
});

test('remove cascades to attached connectors; undo restores them', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply({ type: 'add', element: rect('a', 0, 0) });
  d.apply({ type: 'add', element: rect('b', 300, 0) });
  d.apply({ type: 'add', element: link('c', 'a', 'b') });
  d.apply({ type: 'remove', id: 'a' });
  assert.equal(d.get('c'), undefined);
  d.undo();
  assert.ok(d.get('a')); assert.ok(d.get('c'));
});

test('group/ungroup, reorder and setStyle', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  ['p', 'q', 'r'].forEach((id, i) => d.apply({ type: 'add', element: rect(id, i * 10, 0) }));
  d.apply({ type: 'group', ids: ['p', 'q'], groupId: 'G' });
  assert.equal(d.get('p').groupId, 'G');
  d.apply({ type: 'ungroup', groupId: 'G' });
  assert.equal(d.get('q').groupId, null);
  d.apply({ type: 'reorder', id: 'p', to: 'front' });
  assert.deepEqual(d.elements().map((e) => e.id), ['q', 'r', 'p']);
  d.apply({ type: 'reorder', id: 'p', to: 'back' });
  assert.deepEqual(d.elements().map((e) => e.id), ['p', 'q', 'r']);
  d.apply({ type: 'reorder', id: 'p', to: 'forward' });
  assert.deepEqual(d.elements().map((e) => e.id), ['q', 'p', 'r']);
  d.apply({ type: 'setStyle', ids: ['p', 'r'], style: { opacity: 0.5 } });
  assert.equal(d.get('r').style.opacity, 0.5);
});

test('align and distribute are undoable', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply({ type: 'add', element: rect('a', 0, 0, 10, 10) });
  d.apply({ type: 'add', element: rect('b', 50, 40, 10, 10) });
  d.apply({ type: 'add', element: rect('c', 200, 80, 10, 10) });
  d.align(['a', 'b'], 'top');
  assert.equal(d.get('b').y, 0);
  d.undo();
  assert.equal(d.get('b').y, 40);
  d.align(['a', 'b'], 'right');
  assert.equal(d.get('a').x, 50, 'right edges align at 60');
  d.undo();
  assert.equal(d.get('a').x, 0);
  d.distribute(['a', 'b', 'c'], 'horizontal');
  assert.equal(d.get('a').x, 0, 'outermost shapes stay fixed');
  assert.equal(d.get('c').x, 200, 'outermost shapes stay fixed');
  assert.equal(d.get('b').x, 100, 'equal gaps of 90');
  d.undo();
  assert.equal(d.get('b').x, 50);
});

test('orthogonal routes are axis-parallel and avoid obstacles', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply({ type: 'add', element: rect('s', 0, 0, 100, 100) });
  d.apply({ type: 'add', element: rect('t', 400, 0, 100, 100) });
  d.apply({ type: 'add', element: rect('blk', 180, -100, 100, 300) });
  d.apply({ type: 'add', element: link('o', 's', 't', 'orthogonal') });
  const pts = d.route('o');
  for (let i = 0; i < pts.length - 1; i++) assert.ok(pts[i][0] === pts[i + 1][0] || pts[i][1] === pts[i + 1][1]);
  const blk = { x: 180, y: -100, width: 100, height: 300 };
  for (let i = 0; i < pts.length - 1; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    assert.ok(!(mx > blk.x && mx < blk.x + blk.width && my > blk.y && my < blk.y + blk.height), 'segment avoids obstacle interior');
  }
  assert.deepEqual(pts[0], [100, 50]);
  assert.deepEqual(pts.at(-1), [400, 50]);
});

test('straight route starts and ends on shape boundaries', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply({ type: 'add', element: rect('a', 0, 0, 100, 50) });
  d.apply({ type: 'add', element: rect('b', 300, 200, 100, 50) });
  d.apply({ type: 'add', element: link('c', 'a', 'b') });
  const [s, e] = [d.route('c')[0], d.route('c').at(-1)];
  assert.ok(s[0] === 100 || s[1] === 50);
  assert.ok(e[0] === 300 || e[1] === 200);
});

test('layered layout: edges point down, no overlap in a layer', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  ['a', 'b', 'c', 'd'].forEach((id) => d.apply({ type: 'add', element: rect(id, 0, 0, 80, 40) }));
  [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd']].forEach(([s, t], i) => d.apply({ type: 'add', element: link('e' + i, s, t) }));
  d.layout('layered', { direction: 'TB', spacing: 30 });
  const g = Object.fromEntries(['a', 'b', 'c', 'd'].map((id) => [id, d.get(id)]));
  assert.ok(g.a.y < g.b.y && g.b.y < g.d.y);
  assert.ok(g.a.y < g.c.y);
  assert.ok(!(g.b.y === g.c.y && Math.abs(g.b.x - g.c.x) < 80));
});

test('CRDT: concurrent edits converge in any delivery order, with duplicates', () => {
  const a = createDocument({ id: 'doc', actor: 'A' });
  const b = createDocument({ id: 'doc', actor: 'B' });
  const c = createDocument({ id: 'doc', actor: 'C' });
  a.apply({ type: 'add', element: rect('r', 0, 0) });
  const seed = a.pendingOps();
  b.receive(seed); c.receive(seed);
  a.apply({ type: 'move', ids: ['r'], dx: 10, dy: 0 });
  a.apply({ type: 'update', id: 'r', patch: { text: 'A' } });
  b.apply({ type: 'update', id: 'r', patch: { text: 'B', style: { fill: 'red' } } });
  b.apply({ type: 'move', ids: ['r'], dx: 0, dy: 7 });
  c.apply({ type: 'remove', id: 'r' });
  const opsA = a.pendingOps(), opsB = b.pendingOps(), opsC = c.pendingOps();
  a.receive([...opsC, ...opsB, ...opsB]);
  b.receive([...opsC.reverse(), ...opsA, ...opsA]);
  c.receive([...opsB, ...opsA]);
  assert.equal(JSON.stringify(a.toJSON()), JSON.stringify(b.toJSON()));
  assert.equal(JSON.stringify(a.toJSON()), JSON.stringify(c.toJSON()));
  assert.equal(a.get('r'), undefined, 'concurrent remove wins over update');
});

test('CRDT: different properties both apply; same property is last-writer-wins', () => {
  const a = createDocument({ id: 'doc', actor: 'A' });
  const b = createDocument({ id: 'doc', actor: 'B' });
  a.apply({ type: 'add', element: rect('r', 0, 0) });
  b.receive(a.pendingOps());
  a.apply({ type: 'update', id: 'r', patch: { text: 'hello' } });
  b.apply({ type: 'update', id: 'r', patch: { style: { fill: 'red' } } });
  const oa = a.pendingOps(), ob = b.pendingOps();
  a.receive(ob); b.receive(oa);
  assert.equal(a.get('r').text, 'hello'); assert.equal(a.get('r').style.fill, 'red');
  assert.equal(JSON.stringify(a.toJSON()), JSON.stringify(b.toJSON()));
  a.apply({ type: 'update', id: 'r', patch: { text: 'A' } });
  b.apply({ type: 'update', id: 'r', patch: { text: 'B' } });
  const x = a.pendingOps(), y = b.pendingOps();
  a.receive(y); b.receive(x);
  assert.equal(a.get('r').text, b.get('r').text);
});

test('pendingOps drains and receive ignores own echo', () => {
  const a = createDocument({ id: 'doc', actor: 'A' });
  a.apply({ type: 'add', element: rect('r', 0, 0) });
  const first = a.pendingOps();
  assert.equal(first.length, 1);
  assert.equal(a.pendingOps().length, 0);
  assert.equal(a.receive(first), 0);
});

test('toJSON / fromJSON round trip is lossless', () => {
  const d = createDocument({ id: 'doc', actor: 'A' });
  d.apply({ type: 'add', element: rect('r', 1, 2, 3, 4, { text: 'x\ny', style: { fill: '#fff' } }) });
  d.apply({ type: 'add', element: link('c', 'r', 'r', 'orthogonal') });
  d.apply({ type: 'addLayer', layer: { id: 'L', name: 'Two', order: 5 } });
  const json = JSON.parse(JSON.stringify(d.toJSON()));
  assert.deepEqual(fromJSON(json).toJSON(), json);
});

test('toSVG has data-id per shape and escaped text', () => {
  const d = createDocument({ id: 'doc', actor: 'A' });
  d.apply({ type: 'add', element: rect('r', 0, 0, 50, 50, { text: '<b>&"x"' }) });
  d.apply({ type: 'add', element: { id: 'e', type: 'ellipse', x: 60, y: 0, width: 20, height: 20 } });
  const svg = d.toSVG({ padding: 5 });
  assert.ok(svg.startsWith('<svg'));
  assert.equal((svg.match(/data-id="/g) || []).length, 2);
  assert.ok(svg.includes('&lt;b&gt;&amp;&quot;x&quot;'));
  assert.ok(!svg.includes('<b>'));
});

test('draw.io import maps vertices, edges, labels and rhombus', () => {
  const xml = `<mxfile><diagram><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>
<mxCell id="2" value="Start &amp; go" style="rounded=1;fillColor=#dae8fc;" vertex="1" parent="1"><mxGeometry x="20" y="30" width="120" height="60" as="geometry"/></mxCell>
<mxCell id="3" value="Choose" style="rhombus;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="200" y="30" width="80" height="80" as="geometry"/></mxCell>
<mxCell id="4" value="yes" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1" source="2" target="3"><mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>`;
  const doc = importDrawio(xml);
  assert.equal(doc.get('2').text, 'Start & go');
  assert.equal(doc.get('2').style.fill, '#dae8fc');
  assert.equal(doc.get('3').type, 'diamond');
  assert.equal(doc.get('4').type, 'connector');
  assert.equal(doc.get('4').routing, 'orthogonal');
  assert.equal(doc.get('4').label, 'yes');
});

test('snap to grid and guides', () => {
  assert.deepEqual(snap({ x: 12, y: 7 }, { grid: 10 }), { x: 10, y: 10 });
  assert.deepEqual(snap({ x: 11, y: 20 }, { guides: { x: [10] } }), { x: 10, y: 20 });
});
