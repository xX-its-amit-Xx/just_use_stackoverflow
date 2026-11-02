import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, CalcError } from '../../src/calc.js';
test('semantics', () => {
  for (const [e, v] of [['-2^2',-4],['2^-1',0.5],['2^3^2',512],['-3*-2',6],['-7%3',-1],['.5+5.',5.5],['2.5E-2',0.025],['((1))',1]])
    assert.equal(evaluate(e), v, e);
});
test('errors', () => {
  for (const e of ['', ' ', '1+', '*2', '1 2', '1/0', '1%0', '10^400', '(1', '1)', '1$', 5, '()'])
    assert.throws(() => evaluate(e), CalcError, String(e));
});
