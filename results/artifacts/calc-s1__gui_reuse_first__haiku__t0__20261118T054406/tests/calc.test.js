import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, CalcError } from '../src/calc.js';
import { run } from '../src/cli.js';

const ok = (expr, expected) => test(`ok: ${expr}`, () => assert.equal(evaluate(expr), expected));
const bad = (expr) => test(`error: ${JSON.stringify(expr)}`, () => {
  assert.throws(() => evaluate(expr), (e) => e instanceof CalcError && typeof e.position === 'number');
});

ok('1 + 2 * 3', 7);
ok('-2^2', -4);
ok('2^-1', 0.5);
ok('2^3^2', 512);
ok('-3*-2', 6);
ok('-7 % 3', -1);
ok('10 / 4', 2.5);
ok('(1 + 2) * (3 + (4 - 1))', 18);
ok('((2))', 2);
ok('3.14 * 2', 6.28);
ok('.5 + 5.', 5.5);
ok('1e3', 1000);
ok('2.5E-2 * 2', 0.05);
ok('1 - 2 - 3', -4);
ok('8 / 4 / 2', 1);
ok('\t 1\t+ 1 ', 2);
ok('+5', 5);
ok('--4', 4);
ok('2*-+-3', 6);
ok('2 ^ 0.5 * 0 + 9', 9);

bad('');
bad('   ');
bad('1 $ 2');
bad('abc');
bad('(1 + 2');
bad('1 + 2)');
bad('1 +');
bad('*2');
bad('1 2');
bad('1 / 0');
bad('1 % 0');
bad('10^400');
bad('1e400');
bad('(');
bad('1e');
bad('()');

test('non-string input throws CalcError', () => {
  assert.throws(() => evaluate(42), CalcError);
  assert.throws(() => evaluate(null), CalcError);
});

test('CalcError position points at problem', () => {
  try {
    evaluate('1 + $');
    assert.fail('expected throw');
  } catch (e) {
    assert.equal(e.position, 4);
  }
});

test('cli prints result and error', () => {
  assert.deepEqual(run(['1+1']), { code: 0, stdout: '2\n', stderr: '' });
  const r = run(['1/0']);
  assert.equal(r.code, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^Error: /);
});
