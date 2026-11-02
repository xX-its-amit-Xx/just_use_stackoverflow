import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
const APP = process.env.APP_DIR;
const { TodoStore, TodoError } = await import(path.join(APP, 'src/todo.js'));
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'todo-')), 'todos.json');
test('item shape', () => {
  const it = new TodoStore().add('  Write report ', { due: '2030-01-15', priority: 'high', tags: ['Work', 'work', 'Urgent'] });
  assert.equal(it.title, 'Write report'); assert.equal(it.done, false); assert.equal(it.priority, 'high'); assert.equal(it.due, '2030-01-15');
  assert.deepEqual(it.tags, ['work', 'urgent']); assert.ok(Number.isInteger(it.id) && it.id > 0); assert.ok(!Number.isNaN(Date.parse(it.createdAt)));
});
test('defaults', () => { const it = new TodoStore().add('x'); assert.equal(it.priority, 'normal'); assert.equal(it.due, null); assert.deepEqual(it.tags, []); });
test('validation', () => {
  const s = new TodoStore();
  assert.throws(() => s.add(''), TodoError); assert.throws(() => s.add(5), TodoError);
  assert.throws(() => s.add('x', { priority: 'urgent' }), TodoError);
  assert.throws(() => s.add('x', { due: '2030-13-01' }), TodoError); assert.throws(() => s.add('x', { due: '2030-02-30' }), TodoError);
  assert.throws(() => s.add('x', { due: '15/01/2030' }), TodoError);
  assert.throws(() => s.get(999), TodoError); assert.throws(() => s.complete(999), TodoError); assert.throws(() => s.remove(999), TodoError);
});
test('ids increase and are never reused', () => {
  const s = new TodoStore(); const a = s.add('a'); const b = s.add('b'); s.remove(b.id); const c = s.add('c');
  assert.ok(b.id > a.id && c.id > b.id);
});
test('complete / reopen / get', () => {
  const s = new TodoStore(); const a = s.add('a');
  assert.equal(s.complete(a.id).done, true); assert.equal(s.get(a.id).done, true); assert.equal(s.reopen(a.id).done, false);
});
test('update', () => {
  const s = new TodoStore(); const a = s.add('a');
  const u = s.update(a.id, { title: ' b ', priority: 'low', tags: ['X'], due: '2031-05-05' });
  assert.equal(u.title, 'b'); assert.equal(u.priority, 'low'); assert.deepEqual(u.tags, ['x']); assert.equal(u.due, '2031-05-05');
  assert.throws(() => s.update(a.id, { color: 'red' }), TodoError); assert.throws(() => s.update(a.id, { title: '' }), TodoError);
});
test('list filters', () => {
  const s = new TodoStore();
  const a = s.add('Buy milk', { tags: ['home'] }); const b = s.add('Email boss', { tags: ['work'], priority: 'high' }); s.add('buy bread', { tags: ['Home'] });
  s.complete(a.id);
  assert.deepEqual(s.list({ status: 'done' }).map(i => i.title), ['Buy milk']);
  assert.equal(s.list({ status: 'open' }).length, 2);
  assert.equal(s.list({ tag: 'HOME' }).length, 2);
  assert.deepEqual(s.list({ priority: 'high' }).map(i => i.id), [b.id]);
  assert.equal(s.list({ search: 'BUY' }).length, 2);
  assert.equal(s.list({ search: 'buy', status: 'open' }).length, 1);
});
test('sorting', () => {
  const s = new TodoStore();
  const a = s.add('a', { due: '2030-03-01', priority: 'low' }); const b = s.add('b'); const c = s.add('c', { due: '2030-01-01', priority: 'high' }); const d = s.add('d', { priority: 'high' });
  assert.deepEqual(s.list({ sort: 'created' }).map(i => i.id), [a.id, b.id, c.id, d.id]);
  assert.deepEqual(s.list({ sort: 'due' }).map(i => i.id), [c.id, a.id, b.id, d.id]);
  assert.deepEqual(s.list({ sort: 'priority' }).map(i => i.id), [c.id, d.id, b.id, a.id]);
});
test('list returns copies', () => { const s = new TodoStore(); s.add('a'); s.list()[0].title = 'hacked'; assert.equal(s.list()[0].title, 'a'); });
test('clearCompleted', () => { const s = new TodoStore(); const a = s.add('a'); s.add('b'); const c = s.add('c'); s.complete(a.id); s.complete(c.id); assert.equal(s.clearCompleted(), 2); assert.equal(s.list().length, 1); });
test('stats with overdue', () => {
  const s = new TodoStore(); s.add('a', { due: '2020-01-01' }); const b = s.add('b', { due: '2020-01-01' }); s.add('c', { due: '2099-01-01' }); s.add('d');
  s.complete(b.id);
  assert.deepEqual(s.stats('2025-06-01'), { total: 4, open: 3, done: 1, overdue: 1 });
});
test('persistence round trip incl. id counter', () => {
  const f = tmp(); const s = new TodoStore({ file: f }); const a = s.add('a', { tags: ['t'] }); const b = s.add('b'); s.complete(a.id); s.remove(b.id);
  assert.ok(fs.existsSync(f));
  const s2 = new TodoStore({ file: f }); assert.equal(s2.list().length, 1); assert.equal(s2.get(a.id).done, true);
  assert.ok(s2.add('c').id > b.id);
});
test('CLI workflow', () => {
  const env = { ...process.env, TODO_FILE: tmp() }; const cli = path.join(APP, 'src/cli.js');
  const run = (...a) => execFileSync(process.execPath, [cli, ...a], { encoding: 'utf8', env });
  assert.match(run('add', 'Buy milk', '--priority', 'high', '--tag', 'home'), /^Added #1: Buy milk\n?$/);
  run('add', 'Walk dog', '--due', '2030-01-01');
  assert.match(run('done', '1'), /Completed #1/);
  const out = run('list');
  assert.match(out, /#1 \[x\] Buy milk/); assert.match(out, /#2 \[ \] Walk dog/);
  assert.match(run('list', '--status', 'open'), /^#2 \[ \] Walk dog\n?$/);
  assert.match(run('rm', '2'), /Removed #2/);
  const r = spawnSync(process.execPath, [cli, 'done', '42'], { encoding: 'utf8', env });
  assert.equal(r.status, 1); assert.match(r.stderr, /^Error: /);
});
