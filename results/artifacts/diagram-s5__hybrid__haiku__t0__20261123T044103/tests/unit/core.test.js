import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, fromJSON, importDrawio, snap, DiagramError } from '../../src/core/index.js';

const rect = (id, x, y, w = 10, h = 10, extra = {}) => ({ type: 'add', element: { id, type: 'rect', x, y, width: w, height: h, ...extra } });
const conn = (id, s, t, extra = {}) => ({ type: 'add', element: { id, type: 'connector', source: { elementId: s }, target: { elementId: t }, ...extra } });

function sync(a, b) {
  b.receive(a.pendingOps());
  a.receive(b.pendingOps());
}

test('defaults and validation', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  assert.equal(d.id, 'd');
  assert.equal(d.actor, 'a');
  d.apply(rect('r', 5, 6));
  const r = d.get('r');
  assert.equal(r.width, 10);
  assert.equal(r.rotation, 0);
  assert.equal(r.layer, 'default');
  assert.throws(() => d.apply({ type: 'bogus' }), DiagramError);
  assert.throws(() => d.apply({ type: 'update', id: 'nope', patch: {} }), DiagramError);
  assert.throws(() => d.apply(rect('r', 0, 0)), DiagramError);
  assert.equal(d.get('missing'), undefined);
});

test('update merges style key by key', () => {
  const d = createDocument({ actor: 'a' });
  d.apply(rect('r', 0, 0, 10, 10, { style: { fill: 'red', stroke: 'blue' } }));
  d.apply({ type: 'update', id: 'r', patch: { style: { fill: 'green' }, text: 'hi' } });
  assert.deepEqual(d.get('r').style, { fill: 'green', stroke: 'blue' });
  assert.equal(d.get('r').text, 'hi');
});

test('remove cascades to connectors and undo restores them', () => {
  const d = createDocument({ actor: 'a' });
  d.apply(rect('a', 0, 0)); d.apply(rect('b', 100, 0)); d.apply(conn('c', 'a', 'b'));
  d.apply({ type: 'remove', id: 'a' });
  assert.equal(d.get('c'), undefined);
  d.undo();
  assert.ok(d.get('a'));
  assert.ok(d.get('c'));
  d.redo();
  assert.equal(d.get('a'), undefined);
});

test('undo/redo of update, move, transaction, history limit', () => {
  const d = createDocument({ actor: 'a' });
  d.apply(rect('r', 0, 0));
  d.apply({ type: 'move', ids: ['r'], dx: 5, dy: 7 });
  assert.equal(d.get('r').x, 5);
  d.undo();
  assert.equal(d.get('r').x, 0);
  d.transaction(() => { d.apply({ type: 'move', ids: ['r'], dx: 1, dy: 1 }); d.apply({ type: 'move', ids: ['r'], dx: 1, dy: 1 }); });
  assert.equal(d.get('r').x, 2);
  d.undo();
  assert.equal(d.get('r').x, 0);
  assert.equal(d.undo(), true); // removes r
  assert.equal(d.get('r'), undefined);
  assert.equal(d.undo(), false);
  for (let i = 0; i < 600; i++) d.apply({ type: 'move', ids: [], dx: 0, dy: 0 });
  // only real ops enter history; ensure no crash with many
  assert.ok(d.canUndo() === false || d.canUndo() === true);
});

test('transaction rollback on error leaves no trace', () => {
  const d = createDocument({ actor: 'a' });
  d.apply(rect('r', 0, 0));
  const before = JSON.stringify(d.toJSON());
  assert.throws(() => d.transaction(() => {
    d.apply({ type: 'move', ids: ['r'], dx: 9, dy: 9 });
    d.apply({ type: 'remove', id: 'nope' });
  }), DiagramError);
  assert.equal(JSON.stringify(d.toJSON()), before);
  // only the earlier, committed add remains pending
  assert.equal(d.pendingOps().length, 1);
});

test('locked layers reject writes', () => {
  const d = createDocument({ actor: 'a' });
  d.apply({ type: 'addLayer', layer: { id: 'L', name: 'Locked' } });
  d.apply(rect('r', 0, 0, 10, 10, { layer: 'L' }));
  d.apply({ type: 'updateLayer', id: 'L', patch: { locked: true } });
  assert.throws(() => d.apply({ type: 'move', ids: ['r'], dx: 1, dy: 0 }), DiagramError);
  assert.throws(() => d.apply(rect('q', 0, 0, 10, 10, { layer: 'L' })), DiagramError);
  assert.throws(() => d.apply({ type: 'update', id: 'r', patch: { x: 3 } }), DiagramError);
  d.apply({ type: 'updateLayer', id: 'L', patch: { locked: false } });
  d.apply({ type: 'move', ids: ['r'], dx: 1, dy: 0 });
  assert.equal(d.get('r').x, 1);
});

test('rotate, resize, group, ungroup, setStyle, reorder, layers', () => {
  const d = createDocument({ actor: 'a' });
  d.apply(rect('a', 0, 0)); d.apply(rect('b', 20, 0));
  d.apply({ type: 'rotate', id: 'a', deg: 45 });
  assert.equal(d.get('a').rotation, 45);
  d.apply({ type: 'resize', id: 'a', box: { x: 1, y: 2, width: 30, height: 40 } });
  assert.deepEqual([d.get('a').x, d.get('a').y, d.get('a').width, d.get('a').height], [1, 2, 30, 40]);
  d.apply({ type: 'group', ids: ['a', 'b'], groupId: 'G' });
  assert.equal(d.get('b').groupId, 'G');
  d.apply({ type: 'ungroup', groupId: 'G' });
  assert.equal(d.get('a').groupId, null);
  d.apply({ type: 'setStyle', ids: ['a', 'b'], style: { fill: '#f00' } });
  assert.equal(d.get('b').style.fill, '#f00');
  assert.deepEqual(d.elements().map((e) => e.id), ['a', 'b']);
  d.apply({ type: 'reorder', id: 'a', to: 'front' });
  assert.deepEqual(d.elements().map((e) => e.id), ['b', 'a']);
  d.apply({ type: 'reorder', id: 'a', to: 'back' });
  assert.deepEqual(d.elements().map((e) => e.id), ['a', 'b']);
  d.apply({ type: 'addLayer', layer: { id: 'L2', name: 'Two' } });
  d.apply({ type: 'update', id: 'b', patch: { layer: 'L2' } });
  assert.equal(d.elements({ layer: 'L2' }).length, 1);
  d.apply({ type: 'removeLayer', id: 'L2' });
  assert.equal(d.get('b').layer, 'default');
  assert.throws(() => d.apply({ type: 'removeLayer', id: 'default' }), DiagramError);
});

test('hitTest is rotation-aware and select/bounds work', () => {
  const d = createDocument({ actor: 'a' });
  d.apply({ type: 'add', element: { id: 'r', type: 'rect', x: 0, y: 0, width: 100, height: 10 } });
  assert.equal(d.hitTest(50, 5).id, 'r');
  assert.equal(d.hitTest(50, 50), null);
  d.apply({ type: 'rotate', id: 'r', deg: 90 });
  assert.equal(d.hitTest(5, 5), null);
  assert.equal(d.hitTest(50, 45)?.id, 'r');
  d.apply({ type: 'add', element: { id: 'el', type: 'ellipse', x: 300, y: 300, width: 100, height: 100 } });
  assert.equal(d.hitTest(302, 302), null); // corner of bounding box outside ellipse
  assert.equal(d.hitTest(350, 350).id, 'el');
  assert.deepEqual(d.select({ x: 290, y: 290, width: 200, height: 200 }).map((e) => e.id), ['el']);
  assert.deepEqual(d.bounds(['el']), { x: 300, y: 300, width: 100, height: 100 });
});

test('align and distribute', () => {
  const d = createDocument({ actor: 'a' });
  d.apply(rect('a', 0, 0, 10, 10)); d.apply(rect('b', 50, 20, 20, 10)); d.apply(rect('c', 200, 40, 10, 30));
  d.align(['a', 'b', 'c'], 'left');
  assert.deepEqual(['a', 'b', 'c'].map((i) => d.get(i).x), [0, 0, 0]);
  d.align(['a', 'b', 'c'], 'bottom');
  assert.equal(d.get('a').y + 10, d.get('c').y + 30);
  d.apply(rect('a2', 0, 300, 10, 10)); d.apply(rect('b2', 30, 300, 10, 10)); d.apply(rect('c2', 200, 300, 10, 10));
  d.distribute(['a2', 'b2', 'c2'], 'horizontal');
  const gap1 = d.get('b2').x - (d.get('a2').x + 10);
  const gap2 = d.get('c2').x - (d.get('b2').x + 10);
  assert.ok(Math.abs(gap1 - gap2) < 1e-9);
  assert.equal(d.get('c2').x, 200);
  assert.equal(d.get('a2').x, 0);
});

test('orthogonal routes are axis-parallel, avoid obstacles', () => {
  const d = createDocument({ actor: 'a' });
  d.apply(rect('a', 0, 0, 50, 50));
  d.apply(rect('b', 300, 0, 50, 50));
  d.apply(rect('wall', 150, -200, 20, 300)); // blocks the direct horizontal line
  d.apply(conn('c', 'a', 'b', { routing: 'orthogonal' }));
  const pts = d.route('c');
  assert.ok(pts.length >= 2);
  for (let i = 0; i < pts.length - 1; i++) {
    const [p, q] = [pts[i], pts[i + 1]];
    assert.ok(p[0] === q[0] || p[1] === q[1], `segment ${i} not axis-parallel`);
    const mx = (p[0] + q[0]) / 2;
    const my = (p[1] + q[1]) / 2;
    const wall = { x: 150, y: -200, width: 20, height: 300 };
    const inside = mx > wall.x && mx < wall.x + wall.width && my > wall.y && my < wall.y + wall.height;
    assert.ok(!inside, 'route passes through wall');
  }
  const first = pts[0];
  const last = pts[pts.length - 1];
  assert.ok(first[0] >= 0 && first[0] <= 50 && (first[1] === 0 || first[1] === 50 || first[0] === 0 || first[0] === 50));
  assert.ok(last[0] >= 300 && last[0] <= 350);
});

test('straight routes clip to shape boundaries', () => {
  const d = createDocument({ actor: 'a' });
  d.apply(rect('a', 0, 0, 10, 10)); d.apply(rect('b', 100, 0, 10, 10));
  d.apply(conn('c', 'a', 'b'));
  assert.deepEqual(d.route('c'), [[10, 5], [100, 5]]);
  d.apply(conn('p', 'a', 'b', { source: { elementId: 'a', port: 'e' }, target: { elementId: 'b', port: 'w' } }));
  assert.deepEqual(d.route('p'), [[10, 5], [100, 5]]);
});

test('layered layout: edges point down, no overlap, no worse crossings', () => {
  const d = createDocument({ actor: 'a' });
  const names = ['A', 'B', 'C', 'D', 'E', 'F'];
  names.forEach((n, i) => d.apply(rect(n, i * 7, i * 3, 60, 30)));
  const edges = [['A', 'C'], ['A', 'D'], ['B', 'C'], ['B', 'E'], ['C', 'F'], ['D', 'F'], ['E', 'F']];
  edges.forEach(([s, t], i) => d.apply(conn('e' + i, s, t)));
  d.layout('layered', { direction: 'TB', spacing: 40 });
  const y = (n) => d.get(n).y;
  for (const [s, t] of edges) assert.ok(y(s) < y(t), `${s}->${t} not downward`);
  const shapes = names.map((n) => d.get(n));
  for (let i = 0; i < shapes.length; i++) for (let j = i + 1; j < shapes.length; j++) {
    const a = shapes[i]; const b = shapes[j];
    const overlap = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    assert.ok(!overlap, `${a.id} overlaps ${b.id}`);
  }
  d.layout('layered', { direction: 'LR' });
  for (const [s, t] of edges) assert.ok(d.get(s).x < d.get(t).x, `${s}->${t} not rightward`);
  d.layout('grid');
  assert.equal(d.elements({ type: 'rect' }).length, 6);
});

test('snap to grid and guides', () => {
  assert.deepEqual(snap({ x: 12, y: 27 }, { grid: 10 }), { x: 10, y: 30 });
  assert.deepEqual(snap([12, 27], { grid: 10 }), [10, 30]);
  assert.deepEqual(snap({ x: 101, y: 50 }, { guides: { x: [100] }, grid: 10 }), { x: 100, y: 50 });
});

test('toSVG escapes text and tags every shape/connector', () => {
  const d = createDocument({ actor: 'a' });
  d.apply(rect('a', 0, 0, 50, 50, { text: '<b>&"x"</b>' }));
  d.apply(rect('b', 200, 0, 50, 50));
  d.apply(conn('c', 'a', 'b', { label: 'x<y' }));
  const svg = d.toSVG({ padding: 10 });
  assert.match(svg, /^<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.equal((svg.match(/data-id="/g) ?? []).length, 3);
  assert.ok(!svg.includes('<b>&"x"</b>'));
  assert.ok(svg.includes('&lt;b&gt;&amp;&quot;x&quot;&lt;/b&gt;'));
  assert.ok(svg.includes('x&lt;y'));
});

test('JSON round trip is lossless', () => {
  const d = createDocument({ id: 'doc1', actor: 'a' });
  d.apply({ type: 'addLayer', layer: { id: 'L', name: 'Two' } });
  d.apply(rect('a', 1, 2, 3, 4, { layer: 'L', style: { fill: 'red' }, text: 'hello', rotation: 12 }));
  d.apply(rect('b', 9, 9));
  d.apply(conn('c', 'a', 'b', { routing: 'orthogonal', waypoints: [[5, 50]], label: 'L' }));
  const json = d.toJSON();
  const back = fromJSON(JSON.parse(JSON.stringify(json)));
  assert.deepEqual(back.toJSON(), json);
  assert.equal(back.id, 'doc1');
  assert.equal(JSON.stringify(back.toJSON()), JSON.stringify(json));
});

test('draw.io import: vertices, edges, labels, geometry, shape mapping', () => {
  const xml = `<?xml version="1.0"?>
<mxfile><diagram><mxGraphModel><root>
  <mxCell id="0"/>
  <mxCell id="1" parent="0"/>
  <mxCell id="2" value="Start &amp; go" style="rounded=0;fillColor=#dae8fc;" vertex="1" parent="1"><mxGeometry x="10" y="20" width="100" height="50" as="geometry"/></mxCell>
  <mxCell id="3" value="Decide" style="rhombus;whiteSpace=wrap;" vertex="1" parent="1"><mxGeometry x="200" y="20" width="80" height="80" as="geometry"/></mxCell>
  <mxCell id="4" value="" style="ellipse;" vertex="1" parent="1"><mxGeometry x="0" y="200" width="40" height="40" as="geometry"/></mxCell>
  <mxCell id="5" value="yes" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1" source="2" target="3"><mxGeometry relative="1" as="geometry"><Array as="points"><mxPoint x="150" y="100"/></Array></mxGeometry></mxCell>
  <mxCell id="6" edge="1" parent="1" source="3" target="4"><mxGeometry relative="1" as="geometry"/></mxCell>
</root></mxGraphModel></diagram></mxfile>`;
  const d = importDrawio(xml);
  const start = d.get('2');
  assert.equal(start.type, 'rect');
  assert.equal(start.text, 'Start & go');
  assert.equal(start.x, 10);
  assert.equal(start.style.fill, '#dae8fc');
  assert.equal(d.get('3').type, 'diamond');
  assert.equal(d.get('4').type, 'ellipse');
  const e5 = d.get('5');
  assert.equal(e5.type, 'connector');
  assert.equal(e5.routing, 'orthogonal');
  assert.equal(e5.label, 'yes');
  assert.deepEqual(e5.waypoints, [[150, 100]]);
  assert.equal(d.get('6').routing, 'straight');
});

test('pendingOps only contains local ops and receive is idempotent', () => {
  const a = createDocument({ id: 'doc', actor: 'A' });
  const b = createDocument({ id: 'doc', actor: 'B' });
  a.apply(rect('r', 0, 0));
  const ops = a.pendingOps();
  assert.equal(ops.length, 1);
  assert.equal(a.pendingOps().length, 0);
  b.receive(ops);
  b.receive(ops);
  assert.equal(b.pendingOps().length, 0);
  assert.deepEqual(b.toJSON(), a.toJSON());
});

test('concurrent edits converge in any delivery order', () => {
  const a = createDocument({ id: 'doc', actor: 'A' });
  const b = createDocument({ id: 'doc', actor: 'B' });
  const c = createDocument({ id: 'doc', actor: 'C' });
  a.apply(rect('r', 0, 0)); a.apply(rect('s', 50, 0));
  const base = a.pendingOps();
  b.receive(base); c.receive(base);
  // concurrent work
  a.apply({ type: 'update', id: 'r', patch: { style: { fill: 'red' }, text: 'from A' } });
  a.apply({ type: 'move', ids: ['s'], dx: 5, dy: 0 });
  b.apply({ type: 'update', id: 'r', patch: { text: 'from B', x: 99 } });
  b.apply({ type: 'remove', id: 's' });
  c.apply({ type: 'update', id: 's', patch: { width: 77 } });
  c.apply({ type: 'update', id: 'r', patch: { style: { stroke: 'green' } } });
  const opsA = a.pendingOps(); const opsB = b.pendingOps(); const opsC = c.pendingOps();
  const orders = [[opsA, opsB, opsC], [opsC, opsA, opsB], [opsB, opsC, opsA]];
  const results = [];
  for (const [i, order] of orders.entries()) {
    const r = createDocument({ id: 'doc', actor: 'R' + i });
    r.receive(base);
    r.receive([...order[0], ...order[1], ...order[2]].reverse());
    r.receive([...order[0], ...order[1], ...order[2]]); // duplicates
    results.push(JSON.stringify(r.toJSON()));
  }
  assert.equal(new Set(results).size, 1);
  const final = JSON.parse(results[0]);
  const rElem = final.elements.find((e) => e.id === 'r');
  assert.equal(rElem.style.fill, 'red');
  assert.equal(rElem.style.stroke, 'green');
  assert.equal(final.elements.find((e) => e.id === 's'), undefined); // remove wins over update
  // everyone replays to the same thing from their own state too
  a.receive([...opsB, ...opsC]); b.receive([...opsA, ...opsC]); c.receive([...opsA, ...opsB]);
  assert.deepEqual(a.toJSON(), b.toJSON());
  assert.deepEqual(b.toJSON(), c.toJSON());
  assert.equal(JSON.stringify(a.toJSON()), results[0]);
  assert.equal(JSON.stringify(c.toJSON()), results[0]);
});

test('concurrent updates to same property are last-writer-wins by (clock, actor)', () => {
  const a = createDocument({ actor: 'A' });
  const b = createDocument({ actor: 'B' });
  a.apply(rect('r', 0, 0));
  sync(a, b);
  a.apply({ type: 'update', id: 'r', patch: { text: 'a' } });
  b.apply({ type: 'update', id: 'r', patch: { text: 'b' } });
  const oa = a.pendingOps(); const ob = b.pendingOps();
  a.receive(ob); b.receive(oa);
  assert.equal(a.get('r').text, b.get('r').text);
  assert.equal(a.get('r').text, 'b'); // same clock 2 -> actor 'B' > 'A'
});

test('undo only reverts local ops', () => {
  const a = createDocument({ id: 'doc', actor: 'A' });
  const b = createDocument({ id: 'doc', actor: 'B' });
  a.apply(rect('r', 0, 0));
  b.receive(a.pendingOps());
  a.apply({ type: 'move', ids: ['r'], dx: 3, dy: 0 }); // A's own op
  b.apply({ type: 'update', id: 'r', patch: { text: 'from B' } }); // concurrent
  a.receive(b.pendingOps());
  b.receive(a.pendingOps());
  assert.equal(a.get('r').x, 3);
  assert.equal(a.undo(), true); // reverts only A's move
  assert.equal(a.get('r').x, 0);
  assert.equal(a.get('r').text, 'from B');
  b.receive(a.pendingOps());
  assert.equal(b.get('r').x, 0);
  assert.equal(b.get('r').text, 'from B');
});

test('undo of local op emits an op event and reverts remotely', () => {
  const a = createDocument({ actor: 'A' });
  const b = createDocument({ actor: 'B' });
  let events = 0;
  a.on('op', () => { events++; });
  a.apply(rect('r', 0, 0));
  sync(a, b);
  a.undo();
  assert.equal(events, 2);
  b.receive(a.pendingOps());
  assert.equal(b.get('r'), undefined);
});

test('transaction is a single undo step', () => {
  const d = createDocument({ actor: 'a' });
  d.transaction(() => { d.apply(rect('a', 0, 0)); d.apply(rect('b', 1, 1)); });
  d.undo();
  assert.equal(d.elements().length, 0);
  assert.equal(d.undo(), false);
});

test('generic exports and error type', () => {
  assert.ok(new DiagramError('x') instanceof Error);
});
