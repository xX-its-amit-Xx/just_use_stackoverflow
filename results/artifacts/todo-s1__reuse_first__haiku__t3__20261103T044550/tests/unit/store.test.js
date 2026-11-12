import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TodoStore, TodoError } from '../../src/todo.js';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-'));
  return path.join(dir, 'todos.json');
}

test('add validates and normalises', () => {
  const s = new TodoStore();
  const it = s.add('  Pay rent ', { due: '2026-01-31', priority: 'high', tags: ['Home', 'home', 'Bills'] });
  assert.equal(it.title, 'Pay rent');
  assert.equal(it.done, false);
  assert.equal(it.due, '2026-01-31');
  assert.deepEqual(it.tags, ['home', 'bills']);
  assert.equal(s.add('x').due, null);
  assert.equal(s.add('x').priority, 'normal');
  assert.throws(() => s.add('a', { due: '2026-02-30' }), TodoError);
  assert.throws(() => s.add('a', { due: '2026-1-01' }), TodoError);
  assert.throws(() => s.add('a', { priority: 'urgent' }), TodoError);
  assert.throws(() => s.add('a', { tags: 'x' }), TodoError);
  assert.throws(() => s.add(5), TodoError);
});

test('ids increase and are never reused', () => {
  const file = tmpFile();
  const s = new TodoStore({ file });
  const a = s.add('a');
  const b = s.add('b');
  s.remove(b.id);
  const s2 = new TodoStore({ file });
  const c = s2.add('c');
  assert.equal(a.id, 1);
  assert.equal(b.id, 2);
  assert.equal(c.id, 3);
});

test('file persistence survives reload', () => {
  const file = tmpFile();
  const s = new TodoStore({ file });
  s.add('one');
  s.add('two', { tags: ['t'] });
  s.complete(1);
  const r = new TodoStore({ file });
  assert.equal(r.list().length, 2);
  assert.equal(r.get(1).done, true);
  assert.deepEqual(r.get(2).tags, ['t']);
});

test('get / update / complete / reopen / remove / clearCompleted', () => {
  const s = new TodoStore();
  const a = s.add('a');
  s.add('b');
  assert.throws(() => s.get(99), TodoError);
  const u = s.update(a.id, { title: 'A2', due: '2030-05-05', tags: ['X'] });
  assert.equal(u.title, 'A2');
  assert.equal(u.due, '2030-05-05');
  assert.deepEqual(u.tags, ['x']);
  assert.equal(s.update(a.id, { due: null }).due, null);
  assert.throws(() => s.update(a.id, { done: true }), TodoError);
  assert.throws(() => s.update(a.id, { priority: 'bogus' }), TodoError);
  assert.equal(s.complete(a.id).done, true);
  assert.equal(s.reopen(a.id).done, false);
  s.complete(a.id);
  assert.equal(s.clearCompleted(), 1);
  assert.equal(s.clearCompleted(), 0);
  assert.equal(s.remove(2).title, 'b');
  assert.throws(() => s.remove(2), TodoError);
});

test('list filters and sorts', () => {
  const s = new TodoStore();
  s.add('Write report', { due: '2026-03-01', priority: 'low', tags: ['work'] });
  s.add('Buy milk', { priority: 'high', tags: ['home'] });
  s.add('Call Bob', { due: '2026-02-01', priority: 'high', tags: ['Work'] });
  s.add('Nothing due');
  s.complete(4);
  assert.deepEqual(s.list({ status: 'open' }).map((i) => i.id), [1, 2, 3]);
  assert.deepEqual(s.list({ status: 'done' }).map((i) => i.id), [4]);
  assert.deepEqual(s.list({ tag: 'WORK' }).map((i) => i.id), [1, 3]);
  assert.deepEqual(s.list({ priority: 'high' }).map((i) => i.id), [2, 3]);
  assert.deepEqual(s.list({ search: 'CALL' }).map((i) => i.id), [3]);
  assert.deepEqual(s.list({ sort: 'due' }).map((i) => i.id), [3, 1, 2, 4]);
  assert.deepEqual(s.list({ sort: 'priority' }).map((i) => i.id), [2, 3, 4, 1]);
  assert.throws(() => s.list({ sort: 'nope' }), TodoError);
  // returned copies do not affect the store
  const copy = s.list()[0];
  copy.title = 'mutated';
  copy.tags.push('zzz');
  assert.equal(s.get(1).title, 'Write report');
  assert.deepEqual(s.get(1).tags, ['work']);
});

test('stats counts overdue open items', () => {
  const s = new TodoStore();
  s.add('a', { due: '2026-01-01' });
  s.add('b', { due: '2026-01-01' });
  s.add('c', { due: '2099-01-01' });
  s.add('d');
  s.complete(2);
  assert.deepEqual(s.stats('2026-06-01'), { total: 4, open: 3, done: 1, overdue: 1 });
  assert.equal(typeof s.stats().total, 'number');
});
