import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TodoStore, TodoError } from '../../src/todo.js';
test('add and list', () => { const s = new TodoStore(); s.add('Buy milk'); assert.equal(s.list().length, 1); });
test('empty title rejected', () => { assert.throws(() => new TodoStore().add('  '), TodoError); });
