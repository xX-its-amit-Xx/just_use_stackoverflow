import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { TodoStore, TodoError } from '../../src/todo.js';
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'todo-')), 't.json');
test('validation', () => {
  const s = new TodoStore();
  assert.throws(() => s.add('a', { due: '2023-02-30' }), TodoError);
  assert.throws(() => s.add('a', { priority: 'x' }), TodoError);
  const it = s.add(' a ', { tags: ['A', 'b', 'a'], due: '2024-02-29' });
  assert.deepEqual(it.tags, ['a', 'b']); assert.equal(it.title, 'a');
  assert.throws(() => s.update(it.id, { foo: 1 }), TodoError);
  assert.throws(() => s.get(99), TodoError);
});
test('persist + ids not reused + sort', () => {
  const f = tmp(); let s = new TodoStore({ file: f });
  s.add('a', { priority: 'low' }); const b = s.add('b', { due: '2020-01-01', priority: 'high' }); s.remove(b.id);
  s = new TodoStore({ file: f }); assert.equal(s.add('c', { due: '2021-01-01' }).id, 3);
  assert.deepEqual(s.list({ sort: 'due' }).map((x) => x.id), [3, 1]);
  assert.deepEqual(s.list({ sort: 'priority' }).map((x) => x.id), [3, 1]);
  assert.deepEqual(s.stats('2022-01-01'), { total: 2, open: 2, done: 0, overdue: 1 });
  s.list()[0].title = 'zzz'; assert.equal(s.get(1).title, 'a');
});
test('cli', () => {
  const env = { ...process.env, TODO_FILE: tmp() }; const cli = path.resolve('src/cli.js');
  const run = (...a) => execFileSync('node', [cli, ...a], { env }).toString();
  assert.equal(run('add', 'Buy milk', '--tag', 'x', '--priority', 'high'), 'Added #1: Buy milk\n');
  assert.equal(run('done', '1'), 'Completed #1\n');
  assert.equal(run('list'), '#1 [x] Buy milk\n');
  assert.equal(run('rm', '1'), 'Removed #1\n');
  const r = spawnSync('node', [cli, 'rm', '5'], { env });
  assert.equal(r.status, 1); assert.match(r.stderr.toString(), /^Error: /);
});
