import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluate, CalcError } from '../src/calc.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));

test('numbers', () => {
  assert.equal(evaluate('3.14'), 3.14);
  assert.equal(evaluate('.5'), 0.5);
  assert.equal(evaluate('5.'), 5);
  assert.equal(evaluate('1e3'), 1000);
  assert.equal(evaluate('2.5E-2'), 0.025);
});

test('precedence and associativity', () => {
  assert.equal(evaluate('-2^2'), -4);
  assert.equal(evaluate('2^-1'), 0.5);
  assert.equal(evaluate('2^3^2'), 512);
  assert.equal(evaluate('-3*-2'), 6);
  assert.equal(evaluate('1+2*3'), 7);
  assert.equal(evaluate('10-4-3'), 3);
  assert.equal(evaluate('100/10/5'), 2);
  assert.equal(evaluate('2*3%4'), 2);
});

test('remainder uses JS semantics', () => {
  assert.equal(evaluate('-7 % 3'), -1);
  assert.equal(evaluate('7 % -3'), 1);
});

test('parentheses and whitespace', () => {
  assert.equal(evaluate('((1 + 2)) * 3'), 9);
  assert.equal(evaluate(' \t( 2 + 3 )\t* 2 '), 10);
  assert.equal(evaluate('+5'), 5);
  assert.equal(evaluate('- (2 + 3)'), -5);
});

test('errors throw CalcError with position', () => {
  const cases = ['', '   ', '1 $ 2', '(1+2', '1+2)', '1+', '*2', '1 2', '1/0', '1%0', '10^400', '()', '1e', '1..2'];
  for (const c of cases) {
    assert.throws(() => evaluate(c), CalcError, `expected CalcError for ${JSON.stringify(c)}`);
  }
  try {
    evaluate('1 $ 2');
  } catch (e) {
    assert.equal(e.position, 2);
  }
});

test('non-string input', () => {
  assert.throws(() => evaluate(42), CalcError);
  assert.throws(() => evaluate(null), CalcError);
  assert.throws(() => evaluate(undefined), CalcError);
});

test('CLI success and failure', () => {
  assert.equal(execFileSync(process.execPath, [cli, '1+2*3'], { encoding: 'utf8' }), '7\n');
  assert.equal(execFileSync(process.execPath, [cli, '0.1+0.2'], { encoding: 'utf8' }), '0.30000000000000004\n');
  const r = spawnSync(process.execPath, [cli, '1+'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^Error: .+\n$/);
});
