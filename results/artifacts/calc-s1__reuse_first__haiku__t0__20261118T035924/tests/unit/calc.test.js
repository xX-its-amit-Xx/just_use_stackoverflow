import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { evaluate, CalcError } from '../../src/calc.js';
import { main } from '../../src/cli.js';

const cliPath = fileURLToPath(new URL('../../src/cli.js', import.meta.url));

test('precedence and associativity from the spec', () => {
  assert.equal(evaluate('-2^2'), -4);
  assert.equal(evaluate('2^-1'), 0.5);
  assert.equal(evaluate('2^3^2'), 512);
  assert.equal(evaluate('-3*-2'), 6);
  assert.equal(evaluate('1+2*3'), 7);
  assert.equal(evaluate('10-4-3'), 3);
  assert.equal(evaluate('100/10/5'), 2);
  assert.equal(evaluate('2*3%4'), 2);
});

test('remainder follows JavaScript semantics', () => {
  assert.equal(evaluate('-7 % 3'), -1);
  assert.equal(evaluate('7 % -3'), 1);
});

test('number formats', () => {
  assert.equal(evaluate('3.14'), 3.14);
  assert.equal(evaluate('.5'), 0.5);
  assert.equal(evaluate('5.'), 5);
  assert.equal(evaluate('1e3'), 1000);
  assert.equal(evaluate('2.5E-2'), 0.025);
});

test('parentheses, nesting and whitespace', () => {
  assert.equal(evaluate('((1 + 2) * (3 + 4))'), 21);
  assert.equal(evaluate(' \t 2 \t* ( 3 ) '), 6);
  assert.equal(evaluate('-(2+3)'), -5);
  assert.equal(evaluate('+4'), 4);
});

test('invalid input throws CalcError', () => {
  const bad = [
    '', '   ', '\t', '1 +', '*2', '1 2', '(1+2', '1+2)', '()', '1/0', '1%0',
    '10^400', '2 $ 3', 'abc', '1e', '1..2', '(', ')', '-', '2^',
  ];
  for (const e of bad) {
    assert.throws(() => evaluate(e), CalcError, `expected CalcError for ${JSON.stringify(e)}`);
  }
});

test('non-string input throws CalcError', () => {
  for (const v of [undefined, null, 42, {}, ['1']]) {
    assert.throws(() => evaluate(v), CalcError);
  }
});

test('CalcError carries a numeric position', () => {
  try {
    evaluate('1 + $');
    assert.fail('should throw');
  } catch (err) {
    assert.ok(err instanceof CalcError);
    assert.equal(typeof err.position, 'number');
    assert.equal(err.position, 4);
  }
  try {
    evaluate('1 2');
    assert.fail('should throw');
  } catch (err) {
    assert.equal(err.position, 2);
  }
});

test('CLI prints result and exits 0', () => {
  const out = execFileSync(process.execPath, [cliPath, '1 + 2 * 3'], { encoding: 'utf8' });
  assert.equal(out, '7\n');
});

test('CLI prints Error to stderr and exits 1', () => {
  const r = spawnSync(process.execPath, [cliPath, '1 +'], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^Error: .+\n$/);
});

test('main() handles usage and results', () => {
  const sink = () => { const s = { data: '', write(x) { this.data += x; } }; return s; };
  const io = { stdout: sink(), stderr: sink() };
  assert.equal(main([], io), 1);
  assert.match(io.stderr.data, /^Error: usage/);
  const io2 = { stdout: sink(), stderr: sink() };
  assert.equal(main(['0.1 + 0.2'], io2), 0);
  assert.equal(io2.stdout.data, `${0.1 + 0.2}\n`);
});
