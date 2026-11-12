import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TodoStore, TodoError } from '../../src/todo.js';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-test-'));
  return path.join(dir, 'todos.json');
}

test('add applies defaults and normalises fields', () => {
  const s = new TodoStore();
  const item = s.add('  Buy milk  ', { tags: [' Home ', 'home', 'Errands'] });
  assert.equal(item.id, 1);
  assert.equal(item.title, 'Buy milk');
  assert.equal(item.done, false);
  assert.equal(item.priority, 'normal');
  assert.equal(item.due, null);
  assert.deepEqual(item.tags, ['home', 'errands']);
  assert.ok(!Number.isNaN(Date.parse(item.createdAt)));
});

test('invalid add inputs throw TodoError', () => {
  const s = new TodoStore();
  assert.throws(() => s.add(''), TodoError);
  assert.throws(() => s.add('x', { due: '2024-02-30' }), TodoError);
  assert.throws(() => s.add('x', { due: '2024/01/01' }), TodoError);
  assert.throws(() => s.add('x', { priority: 'urgent' }), TodoError);
  assert.throws(() => s.add('x', { tags: 'a' }), TodoError);
  assert.equal(s.list().length, 0);
});

test('ids are increasing and never reused after removal', () => {
  const s = new TodoStore();
  const a = s.add('a');
  const b = s.add('b');
  s.remove(b.id);
  const c = s.add('c');
  assert.equal(a.id, 1);
  assert.equal(c.id, 3);
});

test('ids are not reused after reload', () => {
  const file = tmpFile();
  const s1 = new TodoStore({ file });
  s1.add('a');
  s1.add('b');
  s1.remove(2);
  const s2 = new TodoStore({ file });
  assert.equal(s2.add('c').id, 3);
});

test('persists every mutation to file', () => {
  const file = tmpFile();
  const s = new TodoStore({ file });
  s.add('a', { due: '2030-01-01', priority: 'high', tags: ['x'] });
  assert.ok(fs.existsSync(file));
  const s2 = new TodoStore({ file });
  const [item] = s2.list();
  assert.equal(item.title, 'a');
  assert.equal(item.due, '2030-01-01');
  assert.equal(item.priority, 'high');
  assert.deepEqual(item.tags, ['x']);
});

test('get, update, complete, reopen, remove', () => {
  const s = new TodoStore();
  const a = s.add('a');
  assert.deepEqual(s.get(a.id), a);
  const u = s.update(a.id, { title: 'b', due: '2025-05-05', priority: 'low', tags: ['T'] });
  assert.equal(u.title, 'b');
  assert.equal(u.due, '2025-05-05');
  assert.equal(u.priority, 'low');
  assert.deepEqual(u.tags, ['t']);
  assert.equal(s.complete(a.id).done, true);
  assert.equal(s.reopen(a.id).done, false);
  assert.equal(s.remove(a.id).id, a.id);
  assert.throws(() => s.get(a.id), TodoError);
  assert.throws(() => s.complete(999), TodoError);
});

test('update rejects unknown fields and invalid values', () => {
  const s = new TodoStore();
  const a = s.add('a');
  assert.throws(() => s.update(a.id, { done: true }), TodoError);
  assert.throws(() => s.update(a.id, { priority: 'x' }), TodoError);
  assert.throws(() => s.update(a.id, { title: ' ' }), TodoError);
  assert.equal(s.get(a.id).title, 'a');
});

test('returned items are copies', () => {
  const s = new TodoStore();
  s.add('a', { tags: ['x'] });
  const [item] = s.list();
  item.tags.push('hacked');
  item.title = 'changed';
  const [again] = s.list();
  assert.deepEqual(again.tags, ['x']);
  assert.equal(again.title, 'a');
});

test('clearCompleted returns number removed', () => {
  const s = new TodoStore();
  const a = s.add('a');
  s.add('b');
  s.complete(a.id);
  assert.equal(s.clearCompleted(), 1);
  assert.equal(s.list().length, 1);
});

test('list filters by status, tag, priority and search', () => {
  const s = new TodoStore();
  const a = s.add('Write Report', { tags: ['Work'], priority: 'high' });
  s.add('buy eggs', { tags: ['home'] });
  s.complete(a.id);
  assert.deepEqual(s.list({ status: 'done' }).map((i) => i.id), [a.id]);
  assert.equal(s.list({ status: 'open' }).length, 1);
  assert.deepEqual(s.list({ tag: 'WORK' }).map((i) => i.id), [a.id]);
  assert.deepEqual(s.list({ priority: 'high' }).map((i) => i.id), [a.id]);
  assert.deepEqual(s.list({ search: 'REPORT' }).map((i) => i.id), [a.id]);
  assert.throws(() => s.list({ status: 'nope' }), TodoError);
  assert.throws(() => s.list({ sort: 'nope' }), TodoError);
});

test('sort by due puts missing dates last, ties by id', () => {
  const s = new TodoStore();
  const a = s.add('a');
  const b = s.add('b', { due: '2025-03-01' });
  const c = s.add('c', { due: '2025-01-01' });
  const d = s.add('d', { due: '2025-03-01' });
  assert.deepEqual(s.list({ sort: 'due' }).map((i) => i.id), [c.id, b.id, d.id, a.id]);
});

test('sort by priority high, normal, low with id ties', () => {
  const s = new TodoStore();
  const l = s.add('l', { priority: 'low' });
  const n = s.add('n');
  const h1 = s.add('h1', { priority: 'high' });
  const h2 = s.add('h2', { priority: 'high' });
  assert.deepEqual(
    s.list({ sort: 'priority' }).map((i) => i.id),
    [h1.id, h2.id, n.id, l.id],
  );
});

test('stats counts overdue open items', () => {
  const s = new TodoStore();
  s.add('past', { due: '2020-01-01' });
  const done = s.add('done past', { due: '2020-01-01' });
  s.complete(done.id);
  s.add('future', { due: '2999-01-01' });
  assert.deepEqual(s.stats('2025-06-01'), { total: 3, open: 2, done: 1, overdue: 1 });
  const today = s.stats();
  assert.equal(typeof today.total, 'number');
});
