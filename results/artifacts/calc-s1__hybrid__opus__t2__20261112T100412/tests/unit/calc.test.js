import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { evaluate, CalcError } from '../../src/calc.js';

test('values', () => {
  const cases = [['-2^2', -4], ['2^-1', 0.5], ['2^3^2', 512], ['-3*-2', 6], ['-7 % 3', -1],
    ['3.14', 3.14], ['.5', 0.5], ['5.', 5], ['1e3', 1000], ['2.5E-2', 0.025], ['((1+2))*3', 9],
    ['10-4-3', 3], ['2*3/4', 1.5], ['\t1 +\t2', 3], ['--2', 2], ['(-2)^2', 4], ['2^-2^2', 1/16], ['-(1+2)', -3]];
  for (const [e, v] of cases) assert.equal(evaluate(e), v, e);
});

test('errors', () => {
  for (const e of ['', '   ', '1+', '*2', '1 2', '(1', '1)', '1/0', '1%0', '10^400', '2$3', '()', '1e', '.', '2(3)', '1..2'])
    assert.throws(() => evaluate(e), (err) => err instanceof CalcError && typeof err.position === 'number', e);
  for (const e of [null, 5, undefined]) assert.throws(() => evaluate(e), CalcError);
});

test('cli', () => {
  assert.equal(execFileSync('node', ['src/cli.js', '1+2*3']).toString(), '7\n');
  const r = spawnSync('node', ['src/cli.js', '1/0']);
  assert.equal(r.status, 1);
  assert.match(r.stderr.toString(), /^Error: /);
});
