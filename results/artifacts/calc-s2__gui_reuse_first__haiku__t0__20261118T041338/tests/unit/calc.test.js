import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCalculator, CalcError } from '../../src/calc.js';

const ev = (c, s) => c.evaluate(s);
const err = (c, s) => {
  try { c.evaluate(s); } catch (e) { return e; }
  assert.fail(`expected error for ${s}`);
};

test('precedence and power', () => {
  const c = createCalculator();
  assert.equal(ev(c, '2^3^2'), 512);
  assert.equal(ev(c, '-2^2'), -4);
  assert.equal(ev(c, '-3!'), -6);
  assert.equal(ev(c, '2^-1'), 0.5);
  assert.equal(ev(c, '1 + 2 * 3 - 4 / 2'), 5);
  assert.equal(ev(c, '7 % 4'), 3);
  assert.equal(ev(c, '5!'), 120);
  assert.equal(ev(c, '0!'), 1);
});

test('numbers', () => {
  const c = createCalculator();
  assert.equal(ev(c, '.5'), 0.5);
  assert.equal(ev(c, '1e-3'), 0.001);
  assert.equal(ev(c, '2.5E+4'), 25000);
  assert.equal(ev(c, '0x1F'), 31);
  assert.equal(ev(c, '0b101'), 5);
});

test('implicit multiplication', () => {
  const c = createCalculator();
  assert.equal(ev(c, '6/2(1+2)'), 1);
  assert.equal(ev(c, '(1+1)(2+2)'), 8);
  assert.equal(ev(c, '2(3+1)'), 8);
  assert.equal(ev(c, '2 sin(0)'), 0);
  assert.equal(ev(c, '2pi') , 2 * Math.PI);
  ev(c, 'x = 2');
  assert.equal(ev(c, '1/2x'), 0.25);
  assert.equal(ev(c, '3x'), 6);
});

test('variables, ans, constants', () => {
  const c = createCalculator();
  assert.equal(c.evaluate('ans'), 0);
  c.evaluate('x = 4');
  assert.equal(ev(c, 'ans * x'), 16);
  assert.equal(c.getVariable('x'), 4);
  assert.equal(c.getVariable('nope'), undefined);
  assert.equal(err(c, 'pi = 3').constructor, CalcError);
  assert.equal(err(c, 'ans = 3').constructor, CalcError);
  assert.equal(err(c, 'y + 1').constructor, CalcError);
  c.clear();
  assert.equal(c.getVariable('x'), undefined);
  assert.equal(ev(c, 'ans'), 0);
  assert.deepEqual(c.history(), [{ input: 'ans', result: 0 }]);
});

test('user functions, redefinition, recursion', () => {
  const c = createCalculator();
  assert.equal(ev(c, 'f(x,y) = x*y + k'), 'f(x,y)');
  ev(c, 'k = 1');
  assert.equal(ev(c, 'f(3,4)'), 13);
  ev(c, 'k = 10');
  assert.equal(ev(c, 'f(3,4)'), 22);
  ev(c, 'g(x) = f(x, 2)');
  assert.equal(ev(c, 'g(5)'), 20);
  assert.equal(ev(c, 'h(x) = x + 1'), 'h(x)');
  ev(c, 'r(n) = r(n)');
  assert.ok(err(c, 'r(1)') instanceof CalcError);
  assert.ok(err(c, 'f(1)') instanceof CalcError); // arity
  assert.ok(err(c, 'sin(x) = x') instanceof CalcError); // builtin name
  assert.ok(err(c, 'q() = 1') instanceof CalcError);
  assert.ok(err(c, 'q(a,a) = 1') instanceof CalcError);
});

test('angle modes', () => {
  const c = createCalculator({ angleMode: 'deg' });
  assert.equal(c.format(ev(c, 'sin(30)')), '0.5');
  assert.ok(Math.abs(ev(c, 'cos(90)')) < 1e-12);
  assert.ok(Math.abs(ev(c, 'sin(180)')) < 1e-12);
  assert.ok(Math.abs(ev(c, 'asin(1)') - 90) < 1e-9);
  assert.ok(Math.abs(ev(c, 'atan2(1,1)') - 45) < 1e-9);
  c.setAngleMode('rad');
  assert.equal(c.getAngleMode(), 'rad');
  assert.ok(Math.abs(ev(c, 'sin(pi/2)') - 1) < 1e-12);
  assert.throws(() => c.setAngleMode('grad'), CalcError);
});

test('built-in functions', () => {
  const c = createCalculator();
  assert.equal(ev(c, 'round(-2.5)'), -3);
  assert.equal(ev(c, 'round(2.5)'), 3);
  assert.equal(ev(c, 'nroot(-8,3)'), -2);
  assert.equal(c.format(ev(c, 'logb(8,2)')), '3');
  assert.equal(ev(c, 'log(1000)'), 3);
  assert.equal(ev(c, 'ln(1)'), 0);
  assert.equal(ev(c, 'pow(2,10)'), 1024);
  assert.equal(ev(c, 'min(3,1,2)'), 1);
  assert.equal(ev(c, 'max(3,1,2)'), 3);
  assert.equal(ev(c, 'sum(1,2,3)'), 6);
  assert.equal(ev(c, 'avg(1,2,3)'), 2);
  assert.equal(ev(c, 'hypot(3,4)'), 5);
  assert.equal(ev(c, 'sign(-7)'), -1);
  assert.equal(ev(c, 'floor(-1.5)'), -2);
  assert.equal(ev(c, 'ceil(-1.5)'), -1);
  assert.equal(ev(c, 'abs(-3)'), 3);
  assert.equal(ev(c, 'log2(8)'), 3);
  assert.equal(ev(c, 'cbrt(27)'), 3);
  assert.equal(ev(c, 'exp(0)'), 1);
  assert.equal(ev(c, 'tau'), 2 * Math.PI);
  assert.equal(ev(c, 'e'), Math.E);
  assert.throws(() => ev(c, 'sin(1,2)'), CalcError);
  assert.throws(() => ev(c, 'min()'), CalcError);
  assert.throws(() => ev(c, 'nroot(-4,2)'), CalcError);
});

test('domain and overflow errors', () => {
  const c = createCalculator();
  for (const s of ['sqrt(-1)', 'ln(0)', 'ln(-1)', 'log(0)', 'asin(2)', '1/0', '1%0',
    '10^400', '1e400', '171!', '(-1)!', '2.5!', '0^-1', 'nroot(-4,2)']) {
    assert.ok(err(c, s) instanceof CalcError, s);
  }
});

test('syntax error positions', () => {
  const c = createCalculator();
  assert.equal(err(c, '2 + * 3').position, 4);
  assert.equal(err(c, '(1+2').position, 4);
  assert.equal(err(c, '1 + $').position, 4);
  assert.equal(err(c, '').position, 0);
  assert.equal(err(c, '1 2').position, 2);
  assert.equal(err(c, 'foo(1').position, 5);
});

test('format and precision', () => {
  const c = createCalculator();
  assert.equal(c.format(1 / 3), '0.333333333333');
  assert.equal(c.format(-0), '0');
  assert.equal(c.format(1.5), '1.5');
  assert.equal(c.format(100), '100');
  const p = createCalculator({ precision: 3 });
  assert.equal(p.format(3.14159), '3.14');
  assert.throws(() => createCalculator({ angleMode: 'x' }), CalcError);
});

test('setVariable / getVariable', () => {
  const c = createCalculator();
  c.setVariable('z', 2.5);
  assert.equal(ev(c, 'z*2'), 5);
  assert.throws(() => c.setVariable('pi', 1), CalcError);
  assert.throws(() => c.setVariable('ans', 1), CalcError);
  assert.throws(() => c.setVariable('1x', 1), CalcError);
});

test('history records successes only', () => {
  const c = createCalculator();
  ev(c, '1+1');
  assert.throws(() => ev(c, '1/0'));
  ev(c, 'f(x) = x');
  ev(c, 'y = 3');
  assert.deepEqual(c.history(), [
    { input: '1+1', result: 2 },
    { input: 'f(x) = x', result: 'f(x)' },
    { input: 'y = 3', result: 3 },
  ]);
});
