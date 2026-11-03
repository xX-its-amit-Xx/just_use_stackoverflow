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
  assert.equal(evaluate('1+2*3-4/2'), 5);
  assert.equal(evaluate('10-4-3'), 3);
  assert.equal(evaluate('8/4/2'), 1);
  assert.equal(evaluate('2*3%4'), 2);
});

test('remainder uses JS semantics', () => {
  assert.equal(evaluate('-7 % 3'), -1);
  assert.equal(evaluate('7 % -3'), 1);
});

test('numbers', () => {
  assert.equal(evaluate('3.14'), 3.14);
  assert.equal(evaluate('.5'), 0.5);
  assert.equal(evaluate('5.'), 5);
  assert.equal(evaluate('1e3'), 1000);
  assert.equal(evaluate('2.5E-2'), 0.025);
});

test('parentheses and whitespace', () => {
  assert.equal(evaluate('  ( (1 + 2) * \t3 ) '), 9);
  assert.equal(evaluate('((((7))))'), 7);
  assert.equal(evaluate('+(-(2))'), -2);
});

test('invalid inputs throw CalcError with position', () => {
  const cases = [
    ['', 0], ['   ', 0], ['1 + a', 4], ['(1+2', 4], ['1+2)', 3],
    ['1+', 2], ['*2', 0], ['1 2', 2], ['1/0', 2], ['1%0', 2],
    ['10^400', 0], [')', 0], ['1e', 1], ['()', 1],
  ];
  for (const [expr, pos] of cases) {
    assert.throws(() => evaluate(expr), (e) => {
      assert.ok(e instanceof CalcError, `${JSON.stringify(expr)} should be CalcError`);
      assert.equal(typeof e.position, 'number');
      return true;
    }, expr);
  }
  assert.equal(new CalcError('x', 3).position, 3);
});

test('non-string input throws CalcError', () => {
  for (const v of [null, undefined, 42, {}, []]) {
    assert.throws(() => evaluate(v), CalcError);
  }
});

test('CLI prints result and exits 0', () => {
  assert.equal(execFileSync(process.execPath, [cli, '1+2*3'], { encoding: 'utf8' }), '7\n');
  assert.equal(execFileSync(process.execPath, [cli, '0.1+0.2'], { encoding: 'utf8' }), '0.30000000000000004\n');
});

test('CLI errors go to stderr with exit 1', () => {
  const r = spawnSync(process.execPath, [cli, '1/0'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^Error: .+\n$/);
});
