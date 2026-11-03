import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TodoStore, TodoError } from '../src/todo.js';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-test-'));
  return path.join(dir, 'todos.json');
}

test('add applies defaults and normalises fields', () => {
  const s = new TodoStore();
  const it = s.add('  Buy milk  ', { tags: ['Home', 'home', ' Errand '] });
  assert.equal(it.title, 'Buy milk');
  assert.equal(it.done, false);
  assert.equal(it.priority, 'normal');
  assert.equal(it.due, null);
  assert.deepEqual(it.tags, ['home', 'errand']);
  assert.equal(it.id, 1);
  assert.ok(!Number.isNaN(Date.parse(it.createdAt)));
});

test('add validates title, due, priority', () => {
  const s = new TodoStore();
  assert.throws(() => s.add(''), TodoError);
  assert.throws(() => s.add('x', { due: '2026-02-30' }), TodoError);
  assert.throws(() => s.add('x', { due: '2026/01/01' }), TodoError);
  assert.throws(() => s.add('x', { priority: 'urgent' }), TodoError);
  assert.throws(() => s.add('x', { tags: 'a' }), TodoError);
  assert.equal(s.list().length, 0);
  assert.equal(s.add('ok', { due: '2024-02-29' }).due, '2024-02-29');
});

test('ids increase and are never reused, even after reload', () => {
  const file = tmpFile();
  const s = new TodoStore({ file });
  s.add('a');
  s.add('b');
  s.add('c');
  s.remove(3);
  const s2 = new TodoStore({ file });
  assert.equal(s2.add('d').id, 4);
  s2.remove(4);
  const s3 = new TodoStore({ file });
  assert.equal(s3.add('e').id, 5);
});

test('get, update, complete, reopen, remove', () => {
  const s = new TodoStore();
  const a = s.add('a');
  assert.throws(() => s.get(99), TodoError);
  assert.throws(() => s.get('1'), TodoError);
  const u = s.update(a.id, { title: 'A!', priority: 'high', due: '2030-01-01', tags: ['X'] });
  assert.equal(u.title, 'A!');
  assert.equal(u.priority, 'high');
  assert.equal(u.due, '2030-01-01');
  assert.deepEqual(u.tags, ['x']);
  assert.throws(() => s.update(a.id, { done: true }), TodoError);
  assert.equal(s.update(a.id, { due: null }).due, null);
  assert.equal(s.complete(a.id).done, true);
  assert.equal(s.reopen(a.id).done, false);
  assert.equal(s.remove(a.id).id, a.id);
  assert.throws(() => s.remove(a.id), TodoError);
});

test('returned items are copies', () => {
  const s = new TodoStore();
  const a = s.add('a', { tags: ['t'] });
  a.tags.push('evil');
  a.title = 'changed';
  const got = s.get(a.id);
  assert.deepEqual(got.tags, ['t']);
  assert.equal(got.title, 'a');
  s.list()[0].tags.push('zzz');
  assert.deepEqual(s.get(a.id).tags, ['t']);
});

test('clearCompleted returns count removed', () => {
  const s = new TodoStore();
  const a = s.add('a');
  s.add('b');
  s.complete(a.id);
  assert.equal(s.clearCompleted(), 1);
  assert.equal(s.clearCompleted(), 0);
  assert.equal(s.list().length, 1);
});

test('list filters', () => {
  const s = new TodoStore();
  const a = s.add('Write Report', { tags: ['work'], priority: 'high' });
  s.add('buy eggs', { tags: ['Home'] });
  s.complete(a.id);
  assert.equal(s.list({ status: 'done' }).length, 1);
  assert.equal(s.list({ status: 'open' }).length, 1);
  assert.equal(s.list({ tag: 'WORK' })[0].id, a.id);
  assert.equal(s.list({ priority: 'high' }).length, 1);
  assert.equal(s.list({ search: 'REPORT' }).length, 1);
  assert.throws(() => s.list({ status: 'x' }), TodoError);
  assert.throws(() => s.list({ sort: 'x' }), TodoError);
});

test('list sorting: due and priority', () => {
  const s = new TodoStore();
  const a = s.add('a', { due: '2026-05-01' });
  const b = s.add('b');
  const c = s.add('c', { due: '2026-01-01', priority: 'low' });
  const d = s.add('d', { priority: 'high' });
  const e = s.add('e', { due: '2026-05-01', priority: 'high' });
  assert.deepEqual(s.list().map((i) => i.id), [a.id, b.id, c.id, d.id, e.id]);
  assert.deepEqual(s.list({ sort: 'due' }).map((i) => i.id), [c.id, a.id, e.id, b.id, d.id]);
  assert.deepEqual(s.list({ sort: 'priority' }).map((i) => i.id), [d.id, e.id, a.id, b.id, c.id]);
});

test('stats counts overdue open items', () => {
  const s = new TodoStore();
  s.add('past', { due: '2020-01-01' });
  s.add('future', { due: '2999-01-01' });
  const p = s.add('done past', { due: '2020-01-01' });
  s.complete(p.id);
  s.complete(s.add('x').id);
  assert.deepEqual(s.stats('2026-06-01'), { total: 4, open: 2, done: 2, overdue: 1 });
  assert.equal(typeof s.stats().total, 'number');
});

test('file persistence round-trips', () => {
  const file = tmpFile();
  const s = new TodoStore({ file });
  s.add('one', { tags: ['a'], due: '2026-01-02', priority: 'low' });
  const s2 = new TodoStore({ file });
  const [it] = s2.list();
  assert.equal(it.title, 'one');
  assert.deepEqual(it.tags, ['a']);
  assert.equal(it.due, '2026-01-02');
  assert.equal(it.priority, 'low');
});

test('corrupt store file raises TodoError', () => {
  const file = tmpFile();
  fs.writeFileSync(file, '{not json');
  assert.throws(() => new TodoStore({ file }), TodoError);
});
