import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDocument } from '../../src/core/index.js';
test('add + undo', () => {
  const d = createDocument({ id: 'd', actor: 'a' });
  d.apply({ type: 'add', element: { id: 'r1', type: 'rect', x: 0, y: 0, width: 10, height: 10 } });
  assert.ok(d.get('r1')); d.undo(); assert.equal(d.get('r1'), undefined);
});
