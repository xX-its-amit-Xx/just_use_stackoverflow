import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { evaluate, CalcError } from '../src/calc.js';

test('values', () => {
  const cases = { '-2^2': -4, '2^-1': 0.5, '2^3^2': 512, '-3*-2': 6, '-7 % 3': -1, '.5+5.': 5.5,
    '1e3': 1000, '2.5E-2': 0.025, '((1+2))*3': 9, '\t1 -\t2': -1, '10-2-3': 5, '8/2/2': 2, '--2': 2, '2^-2^2': 1/16, '-(2)^2': -4 };
  for (const [e, v] of Object.entries(cases)) assert.equal(evaluate(e), v, e);
});
test('errors', () => {
  for (const e of ['', '  ', '1+', '*2', '1 2', '(1', '1)', '1/0', '1%0', '10^400', 'a', '.', '1e', '()', '2^', '1..2'])
    assert.throws(() => evaluate(e), (err) => err instanceof CalcError && typeof err.position === 'number', e);
  assert.throws(() => evaluate(5), CalcError);
});
test('cli', () => {
  assert.equal(execFileSync('node', ['src/cli.js', '1/4']).toString(), '0.25\n');
  const r = spawnSync('node', ['src/cli.js', '1/0']);
  assert.equal(r.status, 1);
  assert.match(r.stderr.toString(), /^Error: /);
});
