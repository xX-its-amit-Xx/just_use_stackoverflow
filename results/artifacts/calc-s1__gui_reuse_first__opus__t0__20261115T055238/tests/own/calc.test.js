import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, CalcError } from '../../src/calc.js';
test('precedence', () => {
  for (const [e, v] of [['-2^2', -4], ['2^-1', 0.5], ['2^3^2', 512], ['-3*-2', 6], ['-7 % 3', -1], ['.5 + 5.', 5.5], ['2.5E-2', 0.025], ['(1+2)*\t3', 9]])
    assert.equal(evaluate(e), v, e);
});
test('errors', () => {
  for (const e of ['', '  ', '1+', '*2', '1 2', '(1', '1)', '1/0', '5%0', '10^400', '2a', null, 42]) {
    assert.throws(() => evaluate(e), (err) => err instanceof CalcError && typeof err.position === 'number', String(e));
  }
});
