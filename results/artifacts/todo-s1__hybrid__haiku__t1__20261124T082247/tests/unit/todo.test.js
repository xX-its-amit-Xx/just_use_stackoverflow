import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TodoStore, TodoError } from '../../src/todo.js';

test('validation', () => {
  const s = new TodoStore();
  assert.throws(() => s.add('x', { due: '2024-02-30' }), TodoError);
  assert.throws(() => s.add('x', { due: '2024-1-01' }), TodoError);
  assert.throws(() => s.add('x', { priority: 'urgent' }), TodoError);
  assert.equal(s.add('  hi  ').title, 'hi');
  assert.equal(s.add('y', { due: '2024-02-29' }).due, '2024-02-29');
});

test('tags lowercased and deduped in order', () => {
  const it = new TodoStore().add('a', { tags: ['Work', 'home', 'WORK'] });
  assert.deepEqual(it.tags, ['work', 'home']);
});

test('ids are never reused, including after reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-'));
  const file = path.join(dir, 't.json');
  const s = new TodoStore({ file });
  s.add('a'); s.add('b'); s.add('c');
  s.remove(3);
  const s2 = new TodoStore({ file });
  assert.equal(s2.add('d').id, 4);
});

test('persistence round trip', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-'));
  const file = path.join(dir, 't.json');
  new TodoStore({ file }).add('a', { tags: ['x'] });
  const s = new TodoStore({ file });
  assert.equal(s.list().length, 1);
  assert.deepEqual(s.get(1).tags, ['x']);
});

test('update patch validation', () => {
  const s = new TodoStore();
  s.add('a');
  assert.equal(s.update(1, { title: 'b', priority: 'high' }).priority, 'high');
  assert.throws(() => s.update(1, { done: true }), TodoError);
  assert.throws(() => s.update(1, { priority: 'x' }), TodoError);
});

test('complete, reopen, clearCompleted, stats', () => {
  const s = new TodoStore();
  s.add('a', { due: '2020-01-01' });
  s.add('b', { due: '2999-01-01' });
  s.add('c');
  s.complete(2);
  assert.deepEqual(s.stats('2025-01-01'), { total: 3, open: 2, done: 1, overdue: 1 });
  assert.equal(s.reopen(2).done, false);
  s.complete(2);
  assert.equal(s.clearCompleted(), 1);
  assert.equal(s.list().length, 2);
});

test('list filters and sorts', () => {
  const s = new TodoStore();
  s.add('Alpha', { priority: 'low', due: '2030-01-02', tags: ['T'] });
  s.add('beta', { priority: 'high' });
  s.add('gamma', { priority: 'normal', due: '2030-01-01' });
  assert.deepEqual(s.list({ tag: 't' }).map((i) => i.id), [1]);
  assert.deepEqual(s.list({ search: 'ETA' }).map((i) => i.id), [2]);
  assert.deepEqual(s.list({ sort: 'due' }).map((i) => i.id), [3, 1, 2]);
  assert.deepEqual(s.list({ sort: 'priority' }).map((i) => i.id), [2, 3, 1]);
  assert.throws(() => s.list({ status: 'nope' }), TodoError);
});

test('returned items are copies', () => {
  const s = new TodoStore();
  s.add('a', { tags: ['x'] });
  s.list()[0].tags.push('y');
  s.list()[0].title = 'changed';
  assert.deepEqual(s.get(1).tags, ['x']);
  assert.equal(s.get(1).title, 'a');
});

test('unknown id throws', () => {
  assert.throws(() => new TodoStore().get(9), TodoError);
  assert.throws(() => new TodoStore().remove(1), TodoError);
});
