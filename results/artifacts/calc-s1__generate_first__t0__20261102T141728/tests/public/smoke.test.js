import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, CalcError } from '../../src/calc.js';
test('basic arithmetic', () => { assert.equal(evaluate('1 + 2 * 3'), 7); });
test('errors are CalcError', () => { assert.throws(() => evaluate('1 +'), CalcError); });
