import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TodoStore, TodoError } from '../../src/todo.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, '../../src/cli.js');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-'));
  return path.join(dir, 'todos.json');
}

test('add validates and normalises', () => {
  const s = new TodoStore();
  const it = s.add('  Buy milk  ', { due: '2026-01-31', priority: 'high', tags: ['Home', 'home', 'X'] });
  assert.equal(it.id, 1);
  assert.equal(it.title, 'Buy milk');
  assert.equal(it.done, false);
  assert.equal(it.priority, 'high');
  assert.equal(it.due, '2026-01-31');
  assert.deepEqual(it.tags, ['home', 'x']);
  assert.ok(!Number.isNaN(Date.parse(it.createdAt)));
  const d = s.add('No extras');
  assert.equal(d.due, null);
  assert.equal(d.priority, 'normal');
  assert.deepEqual(d.tags, []);
});

test('invalid inputs throw TodoError', () => {
  const s = new TodoStore();
  assert.throws(() => s.add(''), TodoError);
  assert.throws(() => s.add('x', { due: '2026-02-30' }), TodoError);
  assert.throws(() => s.add('x', { due: '2026/01/01' }), TodoError);
  assert.throws(() => s.add('x', { priority: 'urgent' }), TodoError);
  assert.throws(() => s.get(99), TodoError);
  assert.throws(() => s.update(1, { id: 5 }), TodoError);
});

test('ids are never reused, even across reload', () => {
  const file = tmpFile();
  const s = new TodoStore({ file });
  s.add('a');
  s.add('b');
  s.remove(2);
  const s2 = new TodoStore({ file });
  assert.equal(s2.add('c').id, 3);
  assert.equal(s2.list().length, 2);
});

test('update, complete, reopen, clearCompleted', () => {
  const s = new TodoStore();
  s.add('a');
  s.add('b');
  s.add('c');
  assert.equal(s.update(1, { title: 'A', tags: ['T'] }).title, 'A');
  assert.equal(s.complete(1).done, true);
  assert.equal(s.reopen(1).done, false);
  s.complete(2);
  assert.equal(s.clearCompleted(), 1);
  assert.equal(s.stats().total, 2);
});

test('list filters and sorts', () => {
  const s = new TodoStore();
  s.add('Write report', { due: '2026-03-02', priority: 'low', tags: ['work'] });
  s.add('Call mom', { priority: 'high', tags: ['Home'] });
  s.add('Pay bills', { due: '2026-03-01', priority: 'high' });
  s.complete(2);
  assert.deepEqual(s.list({ status: 'open' }).map((i) => i.id), [1, 3]);
  assert.deepEqual(s.list({ status: 'done' }).map((i) => i.id), [2]);
  assert.deepEqual(s.list({ tag: 'HOME' }).map((i) => i.id), [2]);
  assert.deepEqual(s.list({ priority: 'high' }).map((i) => i.id), [2, 3]);
  assert.deepEqual(s.list({ search: 'REPORT' }).map((i) => i.id), [1]);
  assert.deepEqual(s.list({ sort: 'due' }).map((i) => i.id), [3, 1, 2]);
  assert.deepEqual(s.list({ sort: 'priority' }).map((i) => i.id), [2, 3, 1]);
  const copies = s.list();
  copies[0].title = 'mutated';
  copies[0].tags.push('zzz');
  assert.equal(s.get(1).title, 'Write report');
  assert.deepEqual(s.get(1).tags, ['work']);
});

test('stats counts overdue open items', () => {
  const s = new TodoStore();
  s.add('a', { due: '2026-01-01' });
  s.add('b', { due: '2026-01-01' });
  s.add('c', { due: '2099-01-01' });
  s.complete(2);
  assert.deepEqual(s.stats('2026-06-01'), { total: 3, open: 2, done: 1, overdue: 1 });
});

test('persists to file and reloads', () => {
  const file = tmpFile();
  const s = new TodoStore({ file });
  s.add('persisted', { tags: ['x'] });
  const s2 = new TodoStore({ file });
  assert.equal(s2.get(1).title, 'persisted');
  assert.deepEqual(s2.get(1).tags, ['x']);
});

test('CLI add, list, done, rm', () => {
  const file = tmpFile();
  const env = { ...process.env, TODO_FILE: file };
  const exec = (...args) => execFileSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
  assert.equal(exec('add', 'Buy milk', '--due', '2026-05-01', '--tag', 'home'), 'Added #1: Buy milk\n');
  assert.equal(exec('add', 'Walk dog', '--priority', 'high'), 'Added #2: Walk dog\n');
  assert.equal(exec('done', '1'), 'Completed #1\n');
  assert.equal(exec('list'), '#1 [x] Buy milk\n#2 [ ] Walk dog\n');
  assert.equal(exec('list', '--status', 'open'), '#2 [ ] Walk dog\n');
  assert.equal(exec('list', '--tag', 'home'), '#1 [x] Buy milk\n');
  assert.equal(exec('rm', '2'), 'Removed #2\n');
});

test('CLI errors go to stderr with exit code 1', () => {
  const env = { ...process.env, TODO_FILE: tmpFile() };
  let err;
  try {
    execFileSync(process.execPath, [cli, 'done', '42'], { env, encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    err = e;
  }
  assert.ok(err);
  assert.equal(err.status, 1);
  assert.match(err.stderr, /^Error: /);
});
