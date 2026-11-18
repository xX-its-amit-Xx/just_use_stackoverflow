import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { TodoStore, TodoError } from '../src/todo.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'todo-')), 't.json');

test('validation', () => {
  const s = new TodoStore();
  assert.throws(() => s.add('x', { due: '2023-02-30' }), TodoError);
  assert.throws(() => s.add('x', { due: '2023-2-3' }), TodoError);
  assert.throws(() => s.add('x', { priority: 'urgent' }), TodoError);
  const it = s.add('  a  ', { tags: ['A', 'b', 'a'], due: '2024-02-29' });
  assert.deepEqual(it.tags, ['a', 'b']);
  assert.equal(it.title, 'a');
  assert.throws(() => s.update(it.id, { done: true }), TodoError);
  assert.throws(() => s.get(99), TodoError);
});

test('persistence and ids never reused', () => {
  const f = tmp();
  const s = new TodoStore({ file: f });
  s.add('a'); const b = s.add('b'); s.remove(b.id);
  const s2 = new TodoStore({ file: f });
  assert.equal(s2.add('c').id, 3);
});

test('list sort/filter and stats', () => {
  const s = new TodoStore();
  s.add('one', { priority: 'low', due: '2020-01-02' });
  s.add('Two', { priority: 'high', tags: ['Work'] });
  s.add('three', { due: '2020-01-01' });
  assert.deepEqual(s.list({ sort: 'due' }).map((i) => i.id), [3, 1, 2]);
  assert.deepEqual(s.list({ sort: 'priority' }).map((i) => i.id), [2, 3, 1]);
  assert.deepEqual(s.list({ tag: 'WORK' }).map((i) => i.id), [2]);
  assert.deepEqual(s.list({ search: 'tw' }).map((i) => i.id), [2]);
  s.complete(1);
  s.list()[0].tags.push('z');
  assert.deepEqual(s.get(1).tags, []);
  assert.deepEqual(s.stats('2020-06-01'), { total: 3, open: 2, done: 1, overdue: 1 });
  assert.equal(s.clearCompleted(), 1);
});

test('cli', () => {
  const env = { ...process.env, TODO_FILE: tmp() };
  const run = (...a) => execFileSync('node', ['src/cli.js', ...a], { env, encoding: 'utf8' });
  assert.equal(run('add', 'Milk', '--tag', 'x', '--priority', 'high'), 'Added #1: Milk\n');
  run('add', 'Eggs');
  assert.equal(run('done', '1'), 'Completed #1\n');
  assert.equal(run('list'), '#1 [x] Milk\n#2 [ ] Eggs\n');
  assert.equal(run('list', '--status', 'open'), '#2 [ ] Eggs\n');
  assert.equal(run('rm', '2'), 'Removed #2\n');
  const r = spawnSync('node', ['src/cli.js', 'done', '9'], { env, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^Error: /);
});
