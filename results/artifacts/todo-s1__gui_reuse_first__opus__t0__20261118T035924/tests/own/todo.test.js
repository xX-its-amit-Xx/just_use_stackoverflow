import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { TodoStore, TodoError } from '../../src/todo.js';

test('validation', () => {
  const s = new TodoStore();
  assert.throws(() => s.add('x', { due: '2024-02-30' }), TodoError);
  assert.throws(() => s.add('x', { due: '2024-2-3' }), TodoError);
  assert.throws(() => s.add('x', { priority: 'urgent' }), TodoError);
  const a = s.add('  hi ', { due: '2024-02-29', tags: ['A', 'b', 'a'] });
  assert.deepEqual([a.title, a.due, a.tags, a.done, a.id], ['hi', '2024-02-29', ['a', 'b'], false, 1]);
  assert.throws(() => s.update(1, { done: true }), TodoError);
  assert.throws(() => s.get(99), TodoError);
});

test('list sort/filter/stats', () => {
  const s = new TodoStore();
  s.add('a', { priority: 'low', due: '2024-05-01' });
  s.add('B milk', { priority: 'high', tags: ['Shop'] });
  s.add('c', { due: '2024-01-01' });
  s.complete(3);
  assert.deepEqual(s.list({ sort: 'due' }).map((i) => i.id), [3, 1, 2]);
  assert.deepEqual(s.list({ sort: 'priority' }).map((i) => i.id), [2, 3, 1]);
  assert.deepEqual(s.list({ tag: 'SHOP' }).map((i) => i.id), [2]);
  assert.deepEqual(s.list({ search: 'MILK' }).map((i) => i.id), [2]);
  assert.deepEqual(s.list({ status: 'done' }).map((i) => i.id), [3]);
  s.list()[0].tags.push('z');
  assert.deepEqual(s.get(1).tags, []);
  assert.deepEqual(s.stats('2024-06-01'), { total: 3, open: 2, done: 1, overdue: 1 });
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
  const env = { ...process.env, TODO_FILE: f };
  const run = (...a) => execFileSync('node', ['src/cli.js', ...a], { env, encoding: 'utf8' });
  assert.equal(run('add', 'Buy milk', '--tag', 'x', '--priority', 'high'), 'Added #1: Buy milk\n');
  run('add', 'Two');
  assert.equal(run('done', '1'), 'Completed #1\n');
  assert.equal(run('list'), '#1 [x] Buy milk\n#2 [ ] Two\n');
  assert.equal(run('rm', '2'), 'Removed #2\n');
  const r = spawnSync('node', ['src/cli.js', 'rm', '9'], { env, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^Error: /);
});
