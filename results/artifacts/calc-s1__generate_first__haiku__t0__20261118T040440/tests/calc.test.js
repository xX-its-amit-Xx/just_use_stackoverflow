import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluate, CalcError } from '../src/calc.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('precedence and associativity', () => {
  assert.equal(evaluate('-2^2'), -4);
  assert.equal(evaluate('2^-1'), 0.5);
  assert.equal(evaluate('2^3^2'), 512);
  assert.equal(evaluate('-3*-2'), 6);
  assert.equal(evaluate('1+2*3'), 7);
  assert.equal(evaluate('10-4-3'), 3);
  assert.equal(evaluate('100/10/5'), 2);
  assert.equal(evaluate('-7 % 3'), -1);
  assert.equal(evaluate('2*3%4'), 2);
});

test('numbers', () => {
  assert.equal(evaluate('3.14'), 3.14);
  assert.equal(evaluate('.5'), 0.5);
  assert.equal(evaluate('5.'), 5);
  assert.equal(evaluate('1e3'), 1000);
  assert.equal(evaluate('2.5E-2'), 0.025);
  assert.equal(evaluate('\t 1 \t+ 1 '), 2);
});

test('parentheses', () => {
  assert.equal(evaluate('((1+2))*(3-(4-1))'), 0);
  assert.equal(evaluate('(2+3)*4'), 20);
});

test('errors', () => {
  const bad = ['', '   ', '1 +', '*2', '1 2', '1 / 0', '1 % 0', '10^400', '2 $ 3',
    '(1+2', '1+2)', '()', '1e', '1e400', 'abc', null, 42, undefined];
  for (const b of bad) {
    assert.throws(() => evaluate(b), CalcError, `expected error for ${String(b)}`);
  }
});

test('error position is a number', () => {
  try { evaluate('1 $ 2'); assert.fail('no throw'); } catch (e) {
    assert.ok(e instanceof CalcError);
    assert.equal(e.position, 2);
  }
});

test('cli success and failure', () => {
  assert.equal(execFileSync(process.execPath, [cli, '1+2*3'], { encoding: 'utf8' }), '7\n');
  const r = spawnSync(process.execPath, [cli, '1 +'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^Error: /);
  assert.equal(r.stdout, '');
});
