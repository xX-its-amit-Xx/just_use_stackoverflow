import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluate, CalcError } from '../src/calc.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('precedence and associativity', () => {
  assert.equal(evaluate('1 + 2 * 3'), 7);
  assert.equal(evaluate('-2^2'), -4);
  assert.equal(evaluate('2^-1'), 0.5);
  assert.equal(evaluate('2^3^2'), 512);
  assert.equal(evaluate('-3*-2'), 6);
  assert.equal(evaluate('10 - 4 - 3'), 3);
  assert.equal(evaluate('100 / 10 / 2'), 5);
  assert.equal(evaluate('-7 % 3'), -1);
  assert.equal(evaluate('7 % 3 * 2'), 2);
  assert.equal(evaluate('2 * 3 % 4'), 2);
});

test('parentheses and unary plus', () => {
  assert.equal(evaluate('(1+2)*(3+4)'), 21);
  assert.equal(evaluate('((((5))))'), 5);
  assert.equal(evaluate('+4 - -1'), 5);
  assert.equal(evaluate('-(2+3)'), -5);
});

test('number formats', () => {
  assert.equal(evaluate('3.14'), 3.14);
  assert.equal(evaluate('.5'), 0.5);
  assert.equal(evaluate('5.'), 5);
  assert.equal(evaluate('1e3'), 1000);
  assert.equal(evaluate('2.5E-2'), 0.025);
  assert.equal(evaluate('\t 1 \t+\t 1 '), 2);
});

test('spec error cases throw CalcError', () => {
  const bad = [
    '', '   ', '\t', '1 +', '*2', '1 2', '1+', '(1+2', '1+2)', '()',
    '1/0', '1%0', '10^400', '2 $ 3', 'abc', '1e', '1.2.3', '1e400',
    '1,5', '1\n+1',
  ];
  for (const e of bad) {
    assert.throws(() => evaluate(e), CalcError, `expected error for ${JSON.stringify(e)}`);
  }
  for (const v of [null, undefined, 1, {}, ['1']]) {
    assert.throws(() => evaluate(v), CalcError);
  }
});

test('CalcError has numeric position', () => {
  try {
    evaluate('1 + $');
    assert.fail('should throw');
  } catch (err) {
    assert.ok(err instanceof CalcError);
    assert.ok(err instanceof Error);
    assert.equal(typeof err.position, 'number');
    assert.equal(err.position, 4);
  }
});

test('CLI prints result and exits 0', () => {
  const out = execFileSync(process.execPath, [cli, '2^10']).toString();
  assert.equal(out, '1024\n');
  const frac = execFileSync(process.execPath, [cli, '1/3']).toString();
  assert.equal(frac, `${String(1 / 3)}\n`);
});

test('CLI prints Error to stderr and exits 1', () => {
  const r = spawnSync(process.execPath, [cli, '1 +']);
  assert.equal(r.status, 1);
  assert.match(r.stderr.toString(), /^Error: .+\n$/);
  assert.equal(r.stdout.toString(), '');
});
