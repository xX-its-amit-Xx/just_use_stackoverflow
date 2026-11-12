import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { TodoStore, TodoError } from '../../src/todo.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'todo-')), 'todos.json');

test('validation', () => {
  const s = new TodoStore();
  assert.throws(() => s.add('x', { due: '2024-02-30' }), TodoError);
  assert.throws(() => s.add('x', { due: '2024-2-3' }), TodoError);
  assert.throws(() => s.add('x', { priority: 'urgent' }), TodoError);
  const it = s.add('  hi ', { due: '2024-02-29', tags: ['A', 'b', 'a'] });
  assert.deepEqual([it.title, it.due, it.tags, it.priority, it.done], ['hi', '2024-02-29', ['a', 'b'], 'normal', false]);
  assert.throws(() => s.update(it.id, { done: true }), TodoError);
  assert.throws(() => s.get(99), TodoError);
});

test('list sort/filter and copies', () => {
  const s = new TodoStore();
  s.add('a', { priority: 'low', due: '2024-05-01' });
  s.add('B task', { priority: 'high', tags: ['Work'] });
  s.add('c', { due: '2024-01-01' });
  assert.deepEqual(s.list({ sort: 'due' }).map((i) => i.id), [3, 1, 2]);
  assert.deepEqual(s.list({ sort: 'priority' }).map((i) => i.id), [2, 3, 1]);
  assert.deepEqual(s.list({ tag: 'WORK' }).map((i) => i.id), [2]);
  assert.deepEqual(s.list({ search: 'b t' }).map((i) => i.id), [2]);
  s.list()[0].tags.push('z');
  assert.deepEqual(s.get(1).tags, []);
  s.complete(1);
  assert.deepEqual(s.stats('2024-06-01'), { total: 3, open: 2, done: 1, overdue: 1 });
  assert.equal(s.clearCompleted(), 1);
});

test('persistence and ids never reused', () => {
  const f = tmp();
  const s = new TodoStore({ file: f });
  s.add('a'); s.add('b'); s.remove(2);
  const s2 = new TodoStore({ file: f });
  assert.equal(s2.add('c').id, 3);
});

test('cli', () => {
  const env = { ...process.env, TODO_FILE: tmp() };
  const run = (...a) => execFileSync('node', ['src/cli.js', ...a], { env, encoding: 'utf8' });
  assert.equal(run('add', 'Buy milk', '--tag', 'x', '--priority', 'high'), 'Added #1: Buy milk\n');
  run('add', 'Two');
  assert.equal(run('done', '1'), 'Completed #1\n');
  assert.equal(run('list'), '#1 [x] Buy milk\n#2 [ ] Two\n');
  assert.equal(run('list', '--status', 'open'), '#2 [ ] Two\n');
  assert.equal(run('rm', '2'), 'Removed #2\n');
  const r = spawnSync('node', ['src/cli.js', 'done', '42'], { env, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^Error: /);
});
