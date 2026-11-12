import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TodoStore, TodoError } from '../../src/todo.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(here, '../../src/cli.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'todo-'));

test('add validates and normalizes', () => {
  const s = new TodoStore();
  const it = s.add('  Buy milk  ', { due: '2030-02-28', priority: 'high', tags: ['A', 'a', 'B'] });
  assert.equal(it.title, 'Buy milk');
  assert.deepEqual(it.tags, ['a', 'b']);
  assert.equal(it.done, false);
  assert.equal(it.due, '2030-02-28');
  assert.equal(s.add('x').due, null);
  assert.equal(s.add('x').priority, 'normal');
  assert.throws(() => s.add('x', { due: '2030-02-29' }), TodoError);
  assert.throws(() => s.add('x', { due: '2030-1-1' }), TodoError);
  assert.throws(() => s.add('x', { priority: 'urgent' }), TodoError);
  assert.throws(() => s.add(''), TodoError);
  assert.throws(() => s.add(5), TodoError);
});

test('ids are increasing and never reused, across reload', () => {
  const dir = tmp();
  const file = path.join(dir, 'todos.json');
  const s = new TodoStore({ file });
  const a = s.add('a');
  const b = s.add('b');
  s.remove(b.id);
  const r = new TodoStore({ file });
  const c = r.add('c');
  assert.equal(a.id, 1);
  assert.equal(b.id, 2);
  assert.equal(c.id, 3);
  r.remove(c.id);
  assert.equal(new TodoStore({ file }).add('d').id, 4);
});

test('persistence round-trip and in-memory store', () => {
  const dir = tmp();
  const file = path.join(dir, 'sub', 'todos.json');
  const s = new TodoStore({ file });
  s.add('one');
  s.complete(1);
  const r = new TodoStore({ file });
  assert.equal(r.get(1).done, true);
  assert.equal(new TodoStore().list().length, 0);
});

test('get, update, complete, reopen, remove, unknown ids', () => {
  const s = new TodoStore();
  const it = s.add('t', { tags: ['x'] });
  assert.equal(s.get(it.id).title, 't');
  const u = s.update(it.id, { title: ' new ', due: '2031-01-01', tags: ['Y'], priority: 'low' });
  assert.equal(u.title, 'new');
  assert.deepEqual(u.tags, ['y']);
  assert.equal(s.update(it.id, { due: null }).due, null);
  assert.throws(() => s.update(it.id, { id: 9 }), TodoError);
  assert.throws(() => s.update(it.id, { title: '' }), TodoError);
  assert.equal(s.complete(it.id).done, true);
  assert.equal(s.reopen(it.id).done, false);
  assert.equal(s.remove(it.id).id, it.id);
  assert.throws(() => s.get(it.id), TodoError);
  assert.throws(() => s.complete(999), TodoError);
  assert.throws(() => s.remove(0), TodoError);
});

test('clearCompleted returns count', () => {
  const s = new TodoStore();
  s.add('a'); s.add('b'); s.add('c');
  s.complete(1); s.complete(3);
  assert.equal(s.clearCompleted(), 2);
  assert.equal(s.list().length, 1);
});

test('list filters and returns copies', () => {
  const s = new TodoStore();
  s.add('Apple pie', { tags: ['Food'], priority: 'low' });
  s.add('banana', { priority: 'high', tags: ['food'] });
  s.add('carrot', { priority: 'normal' });
  s.complete(2);
  assert.equal(s.list({ status: 'open' }).length, 2);
  assert.equal(s.list({ status: 'done' })[0].title, 'banana');
  assert.equal(s.list({ tag: 'FOOD' }).length, 2);
  assert.equal(s.list({ priority: 'normal' })[0].title, 'carrot');
  assert.equal(s.list({ search: 'APPLE' })[0].title, 'Apple pie');
  assert.throws(() => s.list({ status: 'x' }), TodoError);
  assert.throws(() => s.list({ sort: 'x' }), TodoError);
  const copy = s.list()[0];
  copy.tags.push('mutated'); copy.title = 'zzz';
  assert.equal(s.get(1).title, 'Apple pie');
  assert.deepEqual(s.get(1).tags, ['food']);
});

test('list sorting', () => {
  const s = new TodoStore();
  s.add('a', { due: '2030-05-01' });        // 1
  s.add('b');                                // 2 no due
  s.add('c', { due: '2030-01-01', priority: 'low' });  // 3
  s.add('d', { priority: 'high' });          // 4
  s.add('e', { due: '2030-05-01', priority: 'high' }); // 5
  assert.deepEqual(s.list({ sort: 'due' }).map((i) => i.id), [3, 1, 5, 2, 4]);
  assert.deepEqual(s.list({ sort: 'priority' }).map((i) => i.id), [4, 5, 1, 2, 3]);
  assert.deepEqual(s.list().map((i) => i.id), [1, 2, 3, 4, 5]);
});

test('stats', () => {
  const s = new TodoStore();
  s.add('a', { due: '2020-01-01' });
  s.add('b', { due: '2099-01-01' });
  s.add('c', { due: '2020-01-01' });
  s.complete(3);
  assert.deepEqual(s.stats('2021-01-01'), { total: 3, open: 2, done: 1, overdue: 1 });
  const def = s.stats();
  assert.equal(typeof def.total, 'number');
  assert.equal(def.overdue, 1);
});

test('CLI add/list/done/rm and errors', () => {
  const dir = tmp();
  const env = { ...process.env, TODO_FILE: path.join(dir, 'todos.json') };
  const run = (...args) => {
    try {
      return { out: execFileSync(process.execPath, [cliPath, ...args], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }), code: 0 };
    } catch (e) {
      return { out: e.stdout, err: e.stderr, code: e.status };
    }
  };
  assert.equal(run('add', 'Buy milk', '--due', '2030-01-02', '--priority', 'high', '--tag', 'Home', '--tag', 'x').out, 'Added #1: Buy milk\n');
  run('add', 'Walk dog');
  assert.equal(run('done', '1').out, 'Completed #1\n');
  assert.equal(run('list').out, '#1 [x] Buy milk\n#2 [ ] Walk dog\n');
  assert.equal(run('list', '--status', 'open').out, '#2 [ ] Walk dog\n');
  assert.equal(run('list', '--tag', 'home').out, '#1 [x] Buy milk\n');
  assert.equal(run('list', '--sort', 'due').out, '#1 [x] Buy milk\n#2 [ ] Walk dog\n');
  assert.equal(run('rm', '2').out, 'Removed #2\n');
  const bad = run('done', '99');
  assert.equal(bad.code, 1);
  assert.match(bad.err, /^Error: /);
  const bad2 = run('add', 'x', '--due', '2030-02-30');
  assert.equal(bad2.code, 1);
  assert.match(bad2.err, /^Error: /);
});
