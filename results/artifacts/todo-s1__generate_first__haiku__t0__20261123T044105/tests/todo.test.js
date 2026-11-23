import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TodoStore, TodoError } from '../src/todo.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.join(here, '..', 'src', 'cli.js');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-test-'));
  return path.join(dir, 'todos.json');
}

test('add normalises title, tags and defaults', () => {
  const s = new TodoStore();
  const it = s.add('  Buy milk  ', { tags: ['Home', 'home', 'Errand'] });
  assert.equal(it.title, 'Buy milk');
  assert.deepEqual(it.tags, ['home', 'errand']);
  assert.equal(it.priority, 'normal');
  assert.equal(it.due, null);
  assert.equal(it.done, false);
  assert.equal(typeof it.createdAt, 'string');
  assert.ok(Number.isInteger(it.id) && it.id > 0);
});

test('invalid inputs throw TodoError', () => {
  const s = new TodoStore();
  assert.throws(() => s.add(''), TodoError);
  assert.throws(() => s.add('x', { due: '2026-02-30' }), TodoError);
  assert.throws(() => s.add('x', { due: '2026/01/01' }), TodoError);
  assert.throws(() => s.add('x', { priority: 'urgent' }), TodoError);
  assert.throws(() => s.get(999), TodoError);
  assert.throws(() => s.update(1, { bogus: 1 }), TodoError);
});

test('ids are never reused, even after removal and reload', () => {
  const file = tmpFile();
  const s = new TodoStore({ file });
  const a = s.add('a');
  const b = s.add('b');
  s.remove(b.id);
  const s2 = new TodoStore({ file });
  const c = s2.add('c');
  assert.ok(c.id > b.id && c.id > a.id);
});

test('update, complete, reopen, clearCompleted', () => {
  const s = new TodoStore();
  const a = s.add('a');
  s.add('b');
  const u = s.update(a.id, { title: 'A2', due: '2026-05-01', priority: 'high', tags: ['X'] });
  assert.equal(u.title, 'A2');
  assert.equal(u.due, '2026-05-01');
  assert.deepEqual(u.tags, ['x']);
  assert.equal(s.complete(a.id).done, true);
  assert.equal(s.reopen(a.id).done, false);
  s.complete(a.id);
  assert.equal(s.clearCompleted(), 1);
  assert.equal(s.list().length, 1);
});

test('list filters and sorts', () => {
  const s = new TodoStore();
  const a = s.add('Alpha', { priority: 'low', due: '2026-03-02', tags: ['work'] });
  const b = s.add('beta', { priority: 'high' });
  const c = s.add('Gamma', { priority: 'normal', due: '2026-01-05', tags: ['Work'] });
  s.complete(b.id);
  assert.deepEqual(s.list({ status: 'open' }).map((i) => i.id), [a.id, c.id]);
  assert.deepEqual(s.list({ status: 'done' }).map((i) => i.id), [b.id]);
  assert.deepEqual(s.list({ tag: 'WORK' }).map((i) => i.id), [a.id, c.id]);
  assert.deepEqual(s.list({ search: 'AMM' }).map((i) => i.id), [c.id]);
  assert.deepEqual(s.list({ sort: 'due' }).map((i) => i.id), [c.id, a.id, b.id]);
  assert.deepEqual(s.list({ sort: 'priority' }).map((i) => i.id), [b.id, c.id, a.id]);
});

test('list returns copies', () => {
  const s = new TodoStore();
  s.add('x', { tags: ['t'] });
  const [item] = s.list();
  item.title = 'changed';
  item.tags.push('evil');
  const [again] = s.list();
  assert.equal(again.title, 'x');
  assert.deepEqual(again.tags, ['t']);
});

test('stats counts overdue open items', () => {
  const s = new TodoStore();
  s.add('a', { due: '2026-01-01' });
  const b = s.add('b', { due: '2026-01-01' });
  s.add('c', { due: '2030-01-01' });
  s.complete(b.id);
  assert.deepEqual(s.stats('2026-06-01'), { total: 3, open: 2, done: 1, overdue: 1 });
});

test('persistence round-trips to file', () => {
  const file = tmpFile();
  const s = new TodoStore({ file });
  s.add('persist me', { tags: ['a'] });
  const s2 = new TodoStore({ file });
  assert.equal(s2.list()[0].title, 'persist me');
  assert.deepEqual(s2.list()[0].tags, ['a']);
});

test('CLI add, list, done, rm', () => {
  const file = tmpFile();
  const env = { ...process.env, TODO_FILE: file };
  const run = (...args) => execFileSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });
  assert.equal(run('add', 'Write tests', '--priority', 'high', '--tag', 'dev'), 'Added #1: Write tests\n');
  run('add', 'Ship it');
  assert.equal(run('done', '1'), 'Completed #1\n');
  assert.equal(run('list'), '#1 [x] Write tests\n#2 [ ] Ship it\n');
  assert.equal(run('list', '--status', 'open'), '#2 [ ] Ship it\n');
  assert.equal(run('rm', '2'), 'Removed #2\n');
  assert.equal(run('list', '--tag', 'dev'), '#1 [x] Write tests\n');
});

test('CLI errors go to stderr with exit code 1', () => {
  const file = tmpFile();
  const env = { ...process.env, TODO_FILE: file };
  let caught;
  try {
    execFileSync(process.execPath, [cli, 'done', '42'], { env, encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught);
  assert.equal(caught.status, 1);
  assert.match(caught.stderr, /^Error: /);
});
