import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { TodoStore, TodoError } from '../../src/todo.js';

test('validation', () => {
  const s = new TodoStore();
  assert.throws(() => s.add('x', { due: '2025-02-30' }), TodoError);
  assert.throws(() => s.add('x', { due: '2025-2-3' }), TodoError);
  assert.throws(() => s.add('x', { priority: 'urgent' }), TodoError);
  const i = s.add('  a ', { tags: ['A', 'b', 'a'], due: '2024-02-29' });
  assert.deepEqual([i.title, i.tags, i.due, i.done], ['a', ['a', 'b'], '2024-02-29', false]);
  assert.throws(() => s.update(i.id, { done: true }), TodoError);
  assert.throws(() => s.get(99), TodoError);
});

test('sort, filter, stats, copies', () => {
  const s = new TodoStore();
  s.add('one', { priority: 'low', due: '2025-05-01' });
  s.add('Two', { priority: 'high', tags: ['Work'] });
  s.add('three', { due: '2025-01-01' });
  assert.deepEqual(s.list({ sort: 'due' }).map(i => i.id), [3, 1, 2]);
  assert.deepEqual(s.list({ sort: 'priority' }).map(i => i.id), [2, 3, 1]);
  assert.deepEqual(s.list({ tag: 'WORK' }).map(i => i.id), [2]);
  assert.deepEqual(s.list({ search: 'tw' }).map(i => i.id), [2]);
  s.complete(1);
  assert.deepEqual(s.stats('2025-03-01'), { total: 3, open: 2, done: 1, overdue: 1 });
  s.list()[0].tags.push('z'); assert.deepEqual(s.get(1).tags, []);
  assert.equal(s.clearCompleted(), 1);
});

test('persistence and id never reused', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'todo-')), 't.json');
  let s = new TodoStore({ file: f });
  s.add('a'); s.add('b'); s.remove(2);
  s = new TodoStore({ file: f });
  assert.equal(s.add('c').id, 3);
});

test('cli', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'todo-')), 't.json');
  const run = (...a) => spawnSync(process.execPath, ['src/cli.js', ...a], { env: { ...process.env, TODO_FILE: f }, encoding: 'utf8' });
  assert.equal(run('add', 'Buy milk', '--tag', 'x', '--priority', 'high').stdout, 'Added #1: Buy milk\n');
  run('add', 'B');
  assert.equal(run('done', '1').stdout, 'Completed #1\n');
  assert.equal(run('list').stdout, '#1 [x] Buy milk\n#2 [ ] B\n');
  assert.equal(run('list', '--status', 'open').stdout, '#2 [ ] B\n');
  assert.equal(run('rm', '2').stdout, 'Removed #2\n');
  const e = run('rm', '7');
  assert.equal(e.status, 1); assert.match(e.stderr, /^Error: /);
});
