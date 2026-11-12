import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, CalcError } from '../../src/calc.js';

test('numbers: integers, decimals, scientific notation', () => {
  assert.equal(evaluate('3.14'), 3.14);
  assert.equal(evaluate('.5'), 0.5);
  assert.equal(evaluate('5.'), 5);
  assert.equal(evaluate('1e3'), 1000);
  assert.equal(evaluate('2.5E-2'), 0.025);
});

test('precedence and associativity from the spec', () => {
  assert.equal(evaluate('-2^2'), -4);
  assert.equal(evaluate('2^-1'), 0.5);
  assert.equal(evaluate('2^3^2'), 512);
  assert.equal(evaluate('-3*-2'), 6);
  assert.equal(evaluate('1 + 2 * 3'), 7);
  assert.equal(evaluate('10 - 4 - 3'), 3);
  assert.equal(evaluate('100 / 10 / 5'), 2);
  assert.equal(evaluate('2 * 3 % 4'), 2);
});

test('remainder uses JavaScript semantics', () => {
  assert.equal(evaluate('-7 % 3'), -1);
  assert.equal(evaluate('7 % -3'), 1);
});

test('parentheses and whitespace', () => {
  assert.equal(evaluate('((1+2))*(3)'), 9);
  assert.equal(evaluate(' \t2\t*\t( 3 + 4 ) '), 14);
  assert.equal(evaluate('(((2)))'), 2);
});

test('unary plus and minus', () => {
  assert.equal(evaluate('+5'), 5);
  assert.equal(evaluate('--5'), 5);
  assert.equal(evaluate('2*-(3)'), -6);
});

test('result is returned as a number', () => {
  assert.equal(typeof evaluate('1+1'), 'number');
  assert.equal(evaluate('0.1+0.2'), 0.1 + 0.2);
});

const invalid = [
  ['', 'empty'],
  ['   \t ', 'whitespace only'],
  ['1 + a', 'unknown character'],
  ['2 $ 3', 'unknown character'],
  ['(1+2', 'unbalanced open'],
  ['1+2)', 'unbalanced close'],
  ['1+', 'missing right operand'],
  ['*2', 'missing left operand'],
  ['1 2', 'two numbers in a row'],
  ['1/0', 'division by zero'],
  ['5 % 0', 'remainder by zero'],
  ['10^400', 'non-finite result'],
  ['1e400', 'out-of-range literal'],
  ['0^-1', 'infinite power'],
  ['()', 'empty parentheses'],
  ['1..2', 'double dot'],
];

for (const [expr, label] of invalid) {
  test(`invalid input throws CalcError: ${label} (${JSON.stringify(expr)})`, () => {
    assert.throws(() => evaluate(expr), (err) => {
      assert.ok(err instanceof CalcError, 'should be CalcError');
      assert.ok(err instanceof Error);
      assert.equal(typeof err.position, 'number');
      return true;
    });
  });
}

test('non-string input throws CalcError', () => {
  for (const bad of [undefined, null, 42, {}, ['1+1']]) {
    assert.throws(() => evaluate(bad), CalcError);
  }
});

test('position points at the offending character', () => {
  assert.throws(() => evaluate('1 + a'), (e) => e.position === 4);
  assert.throws(() => evaluate('1+2)'), (e) => e.position === 3);
  assert.throws(() => evaluate('1 2'), (e) => e.position === 2);
  assert.throws(() => evaluate('1/0'), (e) => e.position === 1);
});

test('deeply nested input fails with CalcError rather than crashing', () => {
  const deep = '('.repeat(200000) + '1' + ')'.repeat(200000);
  assert.throws(() => evaluate(deep), CalcError);
});
