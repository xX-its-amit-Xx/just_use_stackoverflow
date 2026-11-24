import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { TodoStore, TodoError } from '../../src/todo.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'todo-'));

test('add validates and normalises', () => {
  const s = new TodoStore();
  const a = s.add('  Buy milk  ', { due: '2030-02-28', priority: 'high', tags: ['Home', 'home', 'X'] });
  assert.equal(a.title, 'Buy milk');
  assert.deepEqual(a.tags, ['home', 'x']);
  assert.equal(a.due, '2030-02-28');
  assert.equal(a.done, false);
  assert.equal(s.add('b').due, null);
  assert.throws(() => s.add('c', { due: '2030-02-30' }), TodoError);
  assert.throws(() => s.add('c', { due: '2030/01/01' }), TodoError);
  assert.throws(() => s.add('c', { priority: 'urgent' }), TodoError);
  assert.throws(() => s.add('c', { tags: 'x' }), TodoError);
});

test('ids are never reused, even after removal and reload', () => {
  const file = path.join(tmp(), 'todos.json');
  const s = new TodoStore({ file });
  const a = s.add('one');
  s.remove(a.id);
  const b = s.add('two');
  assert.equal(b.id, a.id + 1);
  const s2 = new TodoStore({ file });
  s2.remove(b.id);
  assert.equal(s2.add('three').id, b.id + 1);
});

test('persistence round-trips', () => {
  const file = path.join(tmp(), 'todos.json');
  const s = new TodoStore({ file });
  s.add('x');
  s.complete(1);
  const s2 = new TodoStore({ file });
  assert.equal(s2.get(1).done, true);
});

test('update, complete, reopen, get errors', () => {
  const s = new TodoStore();
  s.add('a');
  assert.equal(s.update(1, { title: 'b', tags: ['T'] }).title, 'b');
  assert.throws(() => s.update(1, { id: 9 }), TodoError);
  assert.equal(s.complete(1).done, true);
  assert.equal(s.reopen(1).done, false);
  assert.throws(() => s.get(42), TodoError);
});

test('returned items are copies', () => {
  const s = new TodoStore();
  s.add('a', { tags: ['t'] });
  s.list()[0].tags.push('evil');
  assert.deepEqual(s.get(1).tags, ['t']);
});

test('list filters and sorts', () => {
  const s = new TodoStore();
  s.add('low one', { priority: 'low' });
  s.add('Alpha task', { due: '2030-01-02', tags: ['work'] });
  s.add('beta', { due: '2030-01-01', priority: 'high' });
  s.add('gamma', { priority: 'high' });
  s.complete(2);
  assert.deepEqual(s.list({ status: 'done' }).map((i) => i.id), [2]);
  assert.deepEqual(s.list({ status: 'open' }).map((i) => i.id), [1, 3, 4]);
  assert.deepEqual(s.list({ tag: 'WORK' }).map((i) => i.id), [2]);
  assert.deepEqual(s.list({ search: 'ALPHA' }).map((i) => i.id), [2]);
  assert.deepEqual(s.list({ sort: 'due' }).map((i) => i.id), [3, 2, 1, 4]);
  assert.deepEqual(s.list({ sort: 'priority' }).map((i) => i.id), [3, 4, 2, 1]);
});

test('stats and clearCompleted', () => {
  const s = new TodoStore();
  s.add('a', { due: '2020-01-01' });
  s.add('b', { due: '2999-01-01' });
  s.add('c');
  s.complete(3);
  assert.deepEqual(s.stats('2025-01-01'), { total: 3, open: 2, done: 1, overdue: 1 });
  assert.equal(s.clearCompleted(), 1);
  assert.equal(s.list().length, 2);
});

test('CLI add/list/done/rm and errors', () => {
  const file = path.join(tmp(), 'cli.json');
  const env = { ...process.env, TODO_FILE: file };
  const cli = path.resolve('src/cli.js');
  const run = (...args) => execFileSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
  assert.equal(run('add', 'Write tests', '--due', '2031-05-05', '--priority', 'high', '--tag', 'dev'), 'Added #1: Write tests\n');
  run('add', 'Second');
  assert.equal(run('done', '1'), 'Completed #1\n');
  assert.equal(run('list'), '#1 [x] Write tests\n#2 [ ] Second\n');
  assert.equal(run('list', '--status', 'open'), '#2 [ ] Second\n');
  assert.equal(run('rm', '2'), 'Removed #2\n');
  let err;
  try { run('done', '99'); } catch (e) { err = e; }
  assert.equal(err.status, 1);
  assert.match(err.stderr, /^Error: /);
});
