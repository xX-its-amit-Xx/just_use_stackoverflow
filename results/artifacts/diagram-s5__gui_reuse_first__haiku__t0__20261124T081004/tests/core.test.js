import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, fromJSON, importDrawio, snap, DiagramError } from '../src/core/index.js';

const rect = (id, x, y, w = 40, h = 40) => ({ id, type: 'rect', x, y, width: w, height: h });

test('operations: add, update, remove, undo/redo', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  assert.equal(d.id, 'd');
  assert.equal(d.actor, 'a');
  d.apply({ type: 'add', element: rect('r1', 0, 0) });
  d.apply({ type: 'update', id: 'r1', patch: { x: 5, style: { fill: 'red' } } });
  assert.equal(d.get('r1').x, 5);
  assert.equal(d.get('r1').style.fill, 'red');
  d.undo();
  assert.equal(d.get('r1').style.fill, undefined);
  d.redo();
  assert.equal(d.get('r1').style.fill, 'red');
  d.apply({ type: 'remove', id: 'r1' });
  assert.equal(d.get('r1'), undefined);
  d.undo();
  assert.ok(d.get('r1'));
});

test('unknown types and ids raise DiagramError', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  assert.throws(() => d.apply({ type: 'bogus' }), DiagramError);
  assert.throws(() => d.apply({ type: 'remove', id: 'nope' }), DiagramError);
  assert.throws(() => d.apply({ type: 'add', element: { type: 'hexagon' } }), DiagramError);
  assert.ok(new DiagramError('x') instanceof Error);
});

test('locked layers reject element writes', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply({ type: 'addLayer', layer: { id: 'L', name: 'L', locked: true } });
  assert.throws(() => d.apply({ type: 'add', element: { ...rect('r', 0, 0), layer: 'L' } }), DiagramError);
  d.apply({ type: 'updateLayer', id: 'L', patch: { locked: false } });
  d.apply({ type: 'add', element: { ...rect('r', 0, 0), layer: 'L' } });
  d.apply({ type: 'updateLayer', id: 'L', patch: { locked: true } });
  assert.throws(() => d.apply({ type: 'move', ids: ['r'], dx: 1, dy: 1 }), DiagramError);
});

test('removing an element removes attached connectors', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply({ type: 'add', element: rect('a', 0, 0) });
  d.apply({ type: 'add', element: rect('b', 200, 0) });
  d.apply({ type: 'add', element: { id: 'c', type: 'connector', source: { elementId: 'a' }, target: { elementId: 'b' } } });
  assert.ok(d.get('c'));
  d.apply({ type: 'remove', id: 'a' });
  assert.equal(d.get('c'), undefined);
});

test('move, resize, rotate, group, reorder', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply({ type: 'add', element: rect('a', 0, 0) });
  d.apply({ type: 'add', element: rect('b', 0, 100) });
  d.apply({ type: 'move', ids: ['a', 'b'], dx: 10, dy: 5 });
  assert.deepEqual([d.get('a').x, d.get('a').y, d.get('b').x, d.get('b').y], [10, 5, 10, 105]);
  d.apply({ type: 'resize', id: 'a', box: { x: 0, y: 0, width: 100, height: 20 } });
  assert.equal(d.get('a').width, 100);
  d.apply({ type: 'rotate', id: 'a', deg: 45 });
  assert.equal(d.get('a').rotation, 45);
  d.apply({ type: 'group', ids: ['a', 'b'], groupId: 'G' });
  assert.equal(d.get('b').groupId, 'G');
  d.apply({ type: 'ungroup', groupId: 'G' });
  assert.equal(d.get('b').groupId, null);
  assert.deepEqual(d.elements().map(e => e.id), ['a', 'b']);
  d.apply({ type: 'reorder', id: 'a', to: 'front' });
  assert.deepEqual(d.elements().map(e => e.id), ['b', 'a']);
  d.apply({ type: 'reorder', id: 'a', to: 'back' });
  assert.deepEqual(d.elements().map(e => e.id), ['a', 'b']);
});

test('hitTest is rotation-aware and select uses containment', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply({ type: 'add', element: { id: 'r', type: 'rect', x: 0, y: 0, width: 100, height: 10 } });
  assert.equal(d.hitTest(50, 5).id, 'r');
  assert.equal(d.hitTest(50, 50), null);
  d.apply({ type: 'rotate', id: 'r', deg: 90 });
  assert.equal(d.hitTest(5, 5), null, 'left end is no longer inside after 90deg rotation');
  assert.equal(d.hitTest(50, 40).id, 'r');
  assert.equal(d.select({ x: -60, y: -60, width: 200, height: 200 }).length, 1, 'rotated bounds fully contained');
  assert.equal(d.select({ x: 0, y: 0, width: 10, height: 10 }).length, 0);
});

test('align and distribute', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply({ type: 'add', element: rect('a', 0, 0, 10, 10) });
  d.apply({ type: 'add', element: rect('b', 20, 30, 10, 10) });
  d.apply({ type: 'add', element: rect('c', 100, 60, 10, 10) });
  d.align(['a', 'b', 'c'], 'top');
  assert.ok(['a', 'b', 'c'].every(id => d.get(id).y === 0));
  d.distribute(['a', 'b', 'c'], 'horizontal');
  assert.equal(d.get('a').x, 0, 'outermost fixed');
  assert.equal(d.get('c').x, 100, 'outermost fixed');
  assert.equal(d.get('b').x, 50, 'gaps equal: 40 on each side');
  d.undo();
  assert.equal(d.get('b').x, 20);
});

test('transaction is one undo step and rolls back on failure', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.transaction(() => {
    d.apply({ type: 'add', element: rect('a', 0, 0) });
    d.apply({ type: 'add', element: rect('b', 0, 0) });
  });
  d.undo();
  assert.equal(d.get('a'), undefined);
  assert.equal(d.get('b'), undefined);
  assert.throws(() => d.transaction(() => {
    d.apply({ type: 'add', element: rect('x', 0, 0) });
    d.apply({ type: 'remove', id: 'missing' });
  }), DiagramError);
  assert.equal(d.get('x'), undefined);
});

test('undo history is capped at 500 steps and only reverts local ops', () => {
  const a = createDocument({ id: 'd', actor: 'a' });
  const b = createDocument({ id: 'd', actor: 'b' });
  a.apply({ type: 'add', element: rect('r', 0, 0) });
  b.receive(a.pendingOps());
  b.apply({ type: 'update', id: 'r', patch: { x: 9 } });
  assert.equal(b.undo(), true);
  assert.equal(b.get('r').x, 0);
  assert.equal(b.undo(), false);
  for (let i = 0; i < 600; i++) a.apply({ type: 'update', id: 'r', patch: { x: i } });
  let n = 0;
  while (a.undo()) n++;
  assert.equal(n, 500);
});

test('orthogonal routes are axis-parallel and avoid other elements', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply({ type: 'add', element: rect('s', 0, 0, 50, 50) });
  d.apply({ type: 'add', element: rect('t', 300, 0, 50, 50) });
  d.apply({ type: 'add', element: rect('block', 120, -40, 60, 120) });
  d.apply({ type: 'add', element: { id: 'c', type: 'connector', source: { elementId: 's' }, target: { elementId: 't' }, routing: 'orthogonal' } });
  const pts = d.route('c');
  assert.ok(pts.length >= 2);
  for (let i = 1; i < pts.length; i++) {
    assert.ok(pts[i][0] === pts[i - 1][0] || pts[i][1] === pts[i - 1][1], 'axis-parallel segment');
  }
  const block = { l: 120, r: 180, t: -40, b: 80 };
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i - 1], [x2, y2] = pts[i];
    const inside = Math.max(x1, x2) > block.l && Math.min(x1, x2) < block.r && Math.max(y1, y2) > block.t && Math.min(y1, y2) < block.b;
    assert.ok(!inside, 'segment crosses obstacle interior');
  }
  // endpoints lie on the boundaries of the source and target
  assert.ok(pts[0][0] === 50 || pts[0][0] === 0 || pts[0][1] === 0 || pts[0][1] === 50);
});

test('straight routes clip to shape boundaries', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply({ type: 'add', element: rect('s', 0, 0, 10, 10) });
  d.apply({ type: 'add', element: rect('t', 100, 0, 10, 10) });
  d.apply({ type: 'add', element: { id: 'c', type: 'connector', source: { elementId: 's' }, target: { elementId: 't' } } });
  assert.deepEqual(d.route('c'), [[10, 5], [100, 5]]);
});

test('layered layout places edges downward without overlaps', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  const ids = ['a', 'b', 'c', 'd', 'e'];
  ids.forEach((id, i) => d.apply({ type: 'add', element: rect(id, i * 37, (i * 53) % 90, 60, 30) }));
  const edges = [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd'], ['d', 'e']];
  edges.forEach(([s, t], i) => d.apply({ type: 'add', element: { id: `k${i}`, type: 'connector', source: { elementId: s }, target: { elementId: t } } }));
  d.layout('layered', { direction: 'TB', spacing: 40 });
  for (const [s, t] of edges) assert.ok(d.get(t).y > d.get(s).y, `${s}->${t} points down`);
  const els = d.elements().filter(e => e.type !== 'connector');
  for (let i = 0; i < els.length; i++) for (let j = i + 1; j < els.length; j++) {
    const p = els[i], q = els[j];
    const overlap = p.x < q.x + q.width && q.x < p.x + p.width && p.y < q.y + q.height && q.y < p.y + p.height;
    assert.ok(!overlap, 'no overlapping nodes');
  }
  d.layout('grid');
  assert.equal(d.get('a').x, 0);
});

test('JSON round trip is lossless', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply({ type: 'add', element: { ...rect('r', 1, 2, 3, 4), text: 'hi', style: { fill: '#fff' } } });
  d.apply({ type: 'addLayer', layer: { id: 'x', name: 'X' } });
  const json = d.toJSON();
  assert.deepEqual(fromJSON(JSON.parse(JSON.stringify(json))).toJSON(), json);
});

test('replicas converge regardless of order and duplicates', () => {
  const a = createDocument({ id: 'd', actor: 'A' });
  const b = createDocument({ id: 'd', actor: 'B' });
  const c = createDocument({ id: 'd', actor: 'C' });
  a.apply({ type: 'add', element: rect('s', 1, 1, 5, 5) });
  const boot = a.pendingOps();
  b.receive(boot);
  c.receive(boot);
  a.apply({ type: 'update', id: 's', patch: { x: 50 } });
  a.apply({ type: 'setStyle', ids: ['s'], style: { fill: 'red' } });
  b.apply({ type: 'update', id: 's', patch: { y: 60 } });
  b.apply({ type: 'update', id: 's', patch: { x: 70 } });
  c.apply({ type: 'remove', id: 's' });
  const ea = a.pendingOps(), eb = b.pendingOps(), ec = c.pendingOps();
  a.receive([...eb, ...ec, ...eb]);
  b.receive([...ec, ...ea, ea[0]]);
  c.receive([...ea, ...eb]);
  assert.equal(JSON.stringify(a.toJSON()), JSON.stringify(b.toJSON()));
  assert.equal(JSON.stringify(b.toJSON()), JSON.stringify(c.toJSON()));
  assert.equal(a.get('s'), undefined, 'remove wins over concurrent updates');
});

test('concurrent updates to different props merge; same prop is LWW by (lamport, actor)', () => {
  const a = createDocument({ id: 'd', actor: 'A' });
  const b = createDocument({ id: 'd', actor: 'B' });
  a.apply({ type: 'add', element: rect('s', 0, 0) });
  b.receive(a.pendingOps());
  a.apply({ type: 'update', id: 's', patch: { x: 1 } });
  a.apply({ type: 'update', id: 's', patch: { width: 77 } });
  b.apply({ type: 'update', id: 's', patch: { height: 88 } });
  b.apply({ type: 'update', id: 's', patch: { x: 2 } });
  const ea = a.pendingOps(), eb = b.pendingOps();
  a.receive(eb); b.receive(ea);
  assert.equal(a.get('s').width, 77);
  assert.equal(a.get('s').height, 88);
  assert.equal(a.get('s').x, b.get('s').x);
  assert.equal(a.get('s').x, 2, 'B wrote x later in lamport order');
});

test('z-order uses fractional indices (midpoints)', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply({ type: 'add', element: rect('a', 0, 0) });
  d.apply({ type: 'add', element: rect('b', 0, 0) });
  d.apply({ type: 'add', element: rect('c', 0, 0) });
  d.apply({ type: 'reorder', id: 'a', to: 'forward' });
  assert.deepEqual(d.elements().map(e => e.id), ['b', 'a', 'c']);
  d.apply({ type: 'reorder', id: 'c', to: 'backward' });
  assert.deepEqual(d.elements().map(e => e.id), ['b', 'c', 'a']);
});

test('pendingOps returns local ops once and never remote ones', () => {
  const a = createDocument({ id: 'd', actor: 'A' });
  const b = createDocument({ id: 'd', actor: 'B' });
  a.apply({ type: 'add', element: rect('a', 0, 0) });
  const first = a.pendingOps();
  assert.ok(first.length > 0);
  assert.equal(a.pendingOps().length, 0);
  b.receive(first);
  assert.equal(b.pendingOps().length, 0);
  assert.equal(JSON.parse(JSON.stringify(first))[0].id, first[0].id);
});

test('importDrawio maps vertices, edges, labels and geometry', () => {
  const xml = `<mxfile host="x"><diagram name="p"><mxGraphModel><root>
    <mxCell id="0"/><mxCell id="1" parent="0"/>
    <mxCell id="2" value="Start" style="rounded=0;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="10" y="20" width="120" height="60" as="geometry"/></mxCell>
    <mxCell id="3" value="&lt;b&gt;Check&lt;/b&gt;?" style="rhombus;whiteSpace=wrap;html=1;" vertex="1" parent="1"><mxGeometry x="200" y="20" width="100" height="80" as="geometry"/></mxCell>
    <mxCell id="4" value="yes" style="endArrow=classic;edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1" source="2" target="3"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="140" y="200"/></Array></mxGeometry></mxCell>
    <mxCell id="5" value="" style="ellipse;" vertex="1" parent="1"><mxGeometry x="0" y="200" width="30" height="30" as="geometry"/></mxCell>
  </root></mxGraphModel></diagram></mxfile>`;
  const d = importDrawio(xml);
  const s = d.get('2');
  assert.equal(s.type, 'rect');
  assert.equal(s.text, 'Start');
  assert.equal([s.x, s.y, s.width, s.height].join(), '10,20,120,60');
  assert.equal(d.get('3').type, 'diamond');
  assert.equal(d.get('3').text, 'Check?');
  assert.equal(d.get('5').type, 'ellipse');
  const e = d.get('4');
  assert.equal(e.type, 'connector');
  assert.equal(e.routing, 'orthogonal');
  assert.equal(e.label, 'yes');
  assert.deepEqual(e.waypoints, [[140, 200]]);
  assert.equal(e.source.elementId, '2');
});

test('importDrawio rejects compressed diagrams', () => {
  assert.throws(() => importDrawio('<mxfile><diagram>eJzLSM3JyQcABiwCFQ==</diagram></mxfile>'), DiagramError);
});

test('toSVG emits one data-id element per shape and connector, escaped text', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply({ type: 'add', element: { ...rect('r', 0, 0), text: '<script>&' } });
  d.apply({ type: 'add', element: rect('t', 100, 0) });
  d.apply({ type: 'add', element: { id: 'c', type: 'connector', source: { elementId: 'r' }, target: { elementId: 't' } } });
  const svg = d.toSVG({ padding: 5 });
  assert.match(svg, /^<svg[^>]*viewBox=/);
  for (const id of ['r', 't', 'c']) assert.ok(svg.includes(`data-id="${id}"`));
  assert.ok(svg.includes('&lt;script&gt;&amp;'));
  assert.ok(!svg.includes('<script>'));
});

test('snap rounds to grid and to nearby guides', () => {
  assert.deepEqual(snap({ x: 12, y: 23 }, { grid: 10 }), { x: 10, y: 20 });
  assert.deepEqual(snap([101, 3], { guides: [{ x: 100 }] }), [100, 3]);
  assert.deepEqual(snap({ x: 50, y: 50 }, { guides: [{ x: 100 }] }), { x: 50, y: 50 });
});
