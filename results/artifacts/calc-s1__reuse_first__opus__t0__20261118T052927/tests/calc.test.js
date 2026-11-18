import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { evaluate, CalcError } from '../src/calc.js';

test('values', () => {
  const cases = { '1 + 2 * 3': 7, '-2^2': -4, '2^-1': 0.5, '2^3^2': 512, '-3*-2': 6, '-7 % 3': -1,
    '3.14': 3.14, '.5': 0.5, '5.': 5, '1e3': 1000, '2.5E-2': 0.025, '((1+2))*\t3': 9, '10-2-3': 5,
    '8/2/2': 2, '--2': 2, '+3': 3, '(2)^2': 4, '2*-2^2': -8 };
  for (const [e, v] of Object.entries(cases)) assert.equal(evaluate(e), v, e);
});

test('errors', () => {
  for (const e of ['', '  ', '1+', '*2', '1 2', '(1', '1)', '1/0', '1%0', '10^400', '2 $ 3', '()', '1e', '.', '1..2'])
    assert.throws(() => evaluate(e), CalcError, e);
  assert.throws(() => evaluate(5), CalcError);
  try { evaluate('1 + $'); } catch (e) { assert.equal(e.position, 4); }
});

test('cli', () => {
  assert.equal(execFileSync('node', ['src/cli.js', '2^10']).toString(), '1024\n');
  const r = spawnSync('node', ['src/cli.js', '1/0']);
  assert.equal(r.status, 1);
  assert.match(r.stderr.toString(), /^Error: /);
});
