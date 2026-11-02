import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, CalcError } from '../../src/calc.js';
test('precedence', () => {
  assert.equal(evaluate('-2^2'), -4);
  assert.equal(evaluate('2^-1'), 0.5);
  assert.equal(evaluate('2^3^2'), 512);
  assert.equal(evaluate('-3*-2'), 6);
  assert.equal(evaluate('-7 % 3'), -1);
  assert.equal(evaluate('.5+5.+2.5E-2'), 5.525);
});
test('errors', () => {
  for (const e of ['', ' ', '1+', '*2', '1 2', '1/0', '1%0', '(1', '1)', '10^400', '2$', '()'])
    assert.throws(() => evaluate(e), CalcError, e);
  assert.throws(() => evaluate(5), CalcError);
});
