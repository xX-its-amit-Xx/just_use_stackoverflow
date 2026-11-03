import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluate, CalcError } from '../../src/calc.js';

const CLI = fileURLToPath(new URL('../../src/cli.js', import.meta.url));

test('precedence and associativity', () => {
  assert.equal(evaluate('1 + 2 * 3'), 7);
  assert.equal(evaluate('-2^2'), -4);
  assert.equal(evaluate('2^-1'), 0.5);
  assert.equal(evaluate('2^3^2'), 512);
  assert.equal(evaluate('-3*-2'), 6);
  assert.equal(evaluate('10 - 4 - 3'), 3);
  assert.equal(evaluate('8 / 4 / 2'), 1);
  assert.equal(evaluate('2 * 3 % 4'), 2);
  assert.equal(evaluate('-7 % 3'), -1);
  assert.equal(evaluate('+5 - -1'), 6);
});

test('numbers', () => {
  assert.equal(evaluate('3.14'), 3.14);
  assert.equal(evaluate('.5'), 0.5);
  assert.equal(evaluate('5.'), 5);
  assert.equal(evaluate('1e3'), 1000);
  assert.equal(evaluate('2.5E-2'), 0.025);
});

test('parentheses and whitespace', () => {
  assert.equal(evaluate('((1+2))*(3)'), 9);
  assert.equal(evaluate(' \t(1 +\t2) * 3 '), 9);
});

test('result formatting value', () => {
  assert.equal(evaluate('0.1 + 0.2'), 0.1 + 0.2);
});

test('errors are CalcError with position', () => {
  const cases = [
    '', '   ', '1 +', '*2', '1 2', '(1+2', '1+2)', '()', '1/0', '5%0',
    '10^400', '2 & 3', '1..2', '1e', '(', ')', '2(3)',
  ];
  for (const c of cases) {
    assert.throws(() => evaluate(c), CalcError, `expected CalcError for ${JSON.stringify(c)}`);
  }
  assert.throws(() => evaluate(null), CalcError);
  assert.throws(() => evaluate(42), CalcError);
  try {
    evaluate('1 2');
  } catch (e) {
    assert.equal(e.position, 2);
  }
  try {
    evaluate('2 & 3');
  } catch (e) {
    assert.equal(e.position, 2);
  }
});

test('CLI prints result and exits 0', () => {
  const out = execFileSync(process.execPath, [CLI, '1 + 2 * 3'], { encoding: 'utf8' });
  assert.equal(out, '7\n');
});

test('CLI prints error to stderr and exits 1', () => {
  const r = spawnSync(process.execPath, [CLI, '1 +'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^Error: /);
});
