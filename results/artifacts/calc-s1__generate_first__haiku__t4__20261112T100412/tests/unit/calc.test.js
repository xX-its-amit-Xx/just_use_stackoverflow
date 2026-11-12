import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluate, CalcError } from '../../src/calc.js';

const cli = fileURLToPath(new URL('../../src/cli.js', import.meta.url));

test('precedence and associativity', () => {
  assert.equal(evaluate('-2^2'), -4);
  assert.equal(evaluate('2^-1'), 0.5);
  assert.equal(evaluate('2^3^2'), 512);
  assert.equal(evaluate('-3*-2'), 6);
  assert.equal(evaluate('10-4-3'), 3);
  assert.equal(evaluate('100/10/5'), 2);
  assert.equal(evaluate('2+3*4^2'), 50);
  assert.equal(evaluate('+5'), 5);
});

test('remainder uses JS semantics', () => {
  assert.equal(evaluate('-7 % 3'), -1);
  assert.equal(evaluate('7%-3'), 1);
});

test('numbers', () => {
  assert.equal(evaluate('3.14'), 3.14);
  assert.equal(evaluate('.5'), 0.5);
  assert.equal(evaluate('5.'), 5);
  assert.equal(evaluate('1e3'), 1000);
  assert.equal(evaluate('2.5E-2'), 0.025);
});

test('parentheses and whitespace', () => {
  assert.equal(evaluate(' ( 1 + 2 ) * \t3 '), 9);
  assert.equal(evaluate('((((2))))'), 2);
});

test('errors are CalcError with position', () => {
  const bad = ['', '   ', '1+', '*2', '1 2', '(1+2', '1+2)', '1/0', '1%0', '10^400', '2 $ 3', '1..2', 'abc', '()'];
  for (const e of bad) {
    assert.throws(() => evaluate(e), CalcError, `expected error for ${JSON.stringify(e)}`);
  }
  assert.throws(() => evaluate(undefined), CalcError);
  assert.throws(() => evaluate(42), CalcError);
  try { evaluate('1 $'); } catch (e) { assert.equal(e.position, 2); }
});

test('CLI prints result and exits 0', () => {
  assert.equal(execFileSync(process.execPath, [cli, '1+2*3']).toString(), '7\n');
  assert.equal(execFileSync(process.execPath, [cli, '0.1+0.2']).toString(), '0.30000000000000004\n');
});

test('CLI prints error to stderr and exits 1', () => {
  const r = spawnSync(process.execPath, [cli, '1+']);
  assert.equal(r.status, 1);
  assert.match(r.stderr.toString(), /^Error: /);
  assert.equal(r.stdout.toString(), '');
});
