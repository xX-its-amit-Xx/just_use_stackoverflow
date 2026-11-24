import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { TodoStore, TodoError } from '../../src/todo.js';

test('validation', () => {
  const s = new TodoStore();
  assert.throws(() => s.add('x', { due: '2023-02-30' }), TodoError);
  assert.throws(() => s.add('x', { due: '2023-2-03' }), TodoError);
  assert.throws(() => s.add('x', { priority: 'urgent' }), TodoError);
  const i = s.add('  a ', { tags: ['A', 'b', 'a'], due: '2024-02-29' });
  assert.deepEqual([i.title, i.tags, i.due, i.done, i.priority], ['a', ['a', 'b'], '2024-02-29', false, 'normal']);
  assert.throws(() => s.update(i.id, { foo: 1 }), TodoError);
  assert.throws(() => s.get(99), TodoError);
});

test('sort, filters, stats, copies', () => {
  const s = new TodoStore();
  s.add('a', { priority: 'low' }); s.add('b', { due: '2020-01-01', priority: 'high' }); s.add('c', { due: '2019-01-01' });
  assert.deepEqual(s.list({ sort: 'due' }).map(i => i.id), [3, 2, 1]);
  assert.deepEqual(s.list({ sort: 'priority' }).map(i => i.id), [2, 3, 1]);
  s.complete(3);
  assert.deepEqual(s.stats('2021-01-01'), { total: 3, open: 2, done: 1, overdue: 1 });
  s.list()[0].title = 'zz'; assert.equal(s.get(1).title, 'a');
  assert.equal(s.clearCompleted(), 1);
});

test('persistence and id not reused', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'td-')), 't.json');
  const s = new TodoStore({ file: f }); s.add('a'); s.add('b'); s.remove(2);
  const s2 = new TodoStore({ file: f }); assert.equal(s2.add('c').id, 3);
});

test('cli', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'td-')), 't.json');
  const env = { ...process.env, TODO_FILE: f };
  const run = (...a) => execFileSync('node', ['src/cli.js', ...a], { env, encoding: 'utf8' });
  assert.equal(run('add', 'Buy milk', '--tag', 'x', '--priority', 'high'), 'Added #1: Buy milk\n');
  assert.equal(run('done', '1'), 'Completed #1\n');
  run('add', 'Two');
  assert.equal(run('list'), '#1 [x] Buy milk\n#2 [ ] Two\n');
  assert.equal(run('list', '--status', 'open'), '#2 [ ] Two\n');
  assert.equal(run('rm', '2'), 'Removed #2\n');
  const r = spawnSync('node', ['src/cli.js', 'rm', '9'], { env, encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stderr, /^Error: /);
});
