import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCalculator, CalcError } from '../../src/calc.js';

const ev = (c, s) => c.evaluate(s);
const fmt = (c, s) => c.format(c.evaluate(s));
const errOf = (c, s) => {
  try { c.evaluate(s); } catch (e) { return e; }
  assert.fail(`expected error for ${s}`);
};

test('precedence and associativity', () => {
  const c = createCalculator();
  assert.equal(ev(c, '2^3^2'), 512);
  assert.equal(ev(c, '2^-1'), 0.5);
  assert.equal(ev(c, '-2^2'), -4);
  assert.equal(ev(c, '-3!'), -6);
  assert.equal(ev(c, '1 - 2 - 3'), -4);
  assert.equal(ev(c, '7 % 4'), 3);
  assert.equal(ev(c, '-7 % 3'), -1);
});

test('implicit multiplication', () => {
  const c = createCalculator();
  assert.equal(ev(c, '6/2(1+2)'), 1);
  ev(c, 'x = 2');
  assert.equal(ev(c, '1/2x'), 0.25);
  assert.equal(ev(c, '2pi') , 2 * Math.PI);
  assert.equal(ev(c, '(1+1)(2+2)'), 8);
  assert.equal(ev(c, '2 sin(0)'), 0);
  assert.equal(ev(c, '2^3x'), 16);
});

test('numeric literals', () => {
  const c = createCalculator();
  assert.equal(ev(c, '12'), 12);
  assert.equal(ev(c, '.5'), 0.5);
  assert.equal(ev(c, '3.5'), 3.5);
  assert.equal(ev(c, '1e-3'), 0.001);
  assert.equal(ev(c, '2.5E+4'), 25000);
  assert.equal(ev(c, '0x1F'), 31);
  assert.equal(ev(c, '0b101'), 5);
});

test('constants and assignment rules', () => {
  const c = createCalculator();
  assert.equal(ev(c, 'e'), Math.E);
  assert.equal(ev(c, 'tau'), 2 * Math.PI);
  assert.ok(errOf(c, 'pi = 3') instanceof CalcError);
  assert.ok(errOf(c, 'ans = 3') instanceof CalcError);
  assert.equal(ev(c, 'y = 3'), 3);
  assert.equal(c.getVariable('y'), 3);
  assert.equal(c.getVariable('nope'), undefined);
  assert.equal(c.getVariable('ans'), 3);
});

test('ans chaining and initial value', () => {
  const c = createCalculator();
  assert.equal(c.getVariable('ans'), 0);
  ev(c, '5');
  assert.equal(ev(c, 'ans * 2'), 10);
});

test('user functions, redefinition, scoping', () => {
  const c = createCalculator();
  assert.equal(ev(c, 'f(x,y) = x*y+k'), 'f(x,y)');
  ev(c, 'k = 1');
  assert.equal(ev(c, 'f(2,3)'), 7);
  ev(c, 'k = 10');
  assert.equal(ev(c, 'f(2,3)'), 16);
  ev(c, 'g(a) = a + 1');
  ev(c, 'h(a) = g(a) * 2');
  assert.equal(ev(c, 'h(1)'), 4);
  assert.ok(errOf(c, 'g(1,2)') instanceof CalcError);
  assert.ok(errOf(c, 'k2(1)') instanceof CalcError);
  assert.ok(errOf(c, 'sin(x) = 1') instanceof CalcError);
  assert.ok(errOf(c, 'q(x,x) = 1') instanceof CalcError);
  // params do not leak into callers' globals
  ev(c, 'w(a) = a');
  assert.equal(ev(c, 'w(4)'), 4);
  assert.ok(errOf(c, 'a') instanceof CalcError);
});

test('recursion is detected', () => {
  const c = createCalculator();
  ev(c, 'r(n) = r(n)');
  assert.ok(errOf(c, 'r(1)') instanceof CalcError);
  ev(c, 'p(n) = q(n)');
  ev(c, 'q(n) = p(n)');
  assert.ok(errOf(c, 'p(1)') instanceof CalcError);
  // bounded depth still works
  ev(c, 'down(n) = n');
  ev(c, 'up(n) = down(n) + 1');
  assert.equal(ev(c, 'up(1)'), 2);
});

test('angle modes', () => {
  const c = createCalculator({ angleMode: 'deg' });
  assert.equal(fmt(c, 'sin(30)'), '0.5');
  assert.ok(Math.abs(ev(c, 'cos(90)')) < 1e-12);
  assert.ok(Math.abs(ev(c, 'sin(180)')) < 1e-12);
  assert.equal(fmt(c, 'asin(0.5)'), '30');
  assert.equal(fmt(c, 'atan2(1,1)'), '45');
  c.setAngleMode('rad');
  assert.equal(c.getAngleMode(), 'rad');
  assert.ok(Math.abs(ev(c, 'sin(pi/6)') - 0.5) < 1e-12);
  assert.throws(() => c.setAngleMode('grad'), CalcError);
});

test('built-in functions', () => {
  const c = createCalculator();
  assert.equal(ev(c, 'round(-2.5)'), -3);
  assert.equal(ev(c, 'round(2.5)'), 3);
  assert.equal(ev(c, 'nroot(-8,3)'), -2);
  assert.equal(fmt(c, 'logb(8,2)'), '3');
  assert.equal(ev(c, 'log(1000)'), 3);
  assert.equal(ev(c, 'log2(8)'), 3);
  assert.equal(ev(c, 'min(3,1,2)'), 1);
  assert.equal(ev(c, 'max(3,1,2)'), 3);
  assert.equal(ev(c, 'sum(1,2,3)'), 6);
  assert.equal(ev(c, 'avg(1,2,3)'), 2);
  assert.equal(ev(c, 'hypot(3,4)'), 5);
  assert.equal(ev(c, 'pow(2,10)'), 1024);
  assert.equal(ev(c, 'sign(-4)'), -1);
  assert.equal(ev(c, 'floor(-1.5)'), -2);
  assert.equal(ev(c, 'ceil(-1.5)'), -1);
  assert.ok(errOf(c, 'sqrt(1,2)') instanceof CalcError);
  assert.ok(errOf(c, 'min()') instanceof CalcError);
  assert.ok(errOf(c, 'pow(2)') instanceof CalcError);
});

test('domain errors', () => {
  const c = createCalculator();
  for (const s of ['sqrt(-1)', 'ln(0)', 'ln(-1)', 'log(0)', 'asin(2)', '1/0', '1%0',
    '0^-1', '(-1)!', '1.5!', '171!', 'exp(1000)', 'nroot(-4,2)', 'nroot(4,0)', '1e400']) {
    assert.ok(errOf(c, s) instanceof CalcError, s);
  }
  assert.equal(ev(c, '170!') > 1e300, true);
  assert.equal(ev(c, '0!'), 1);
});

test('syntax error positions', () => {
  const c = createCalculator();
  assert.equal(errOf(c, '2 + * 3').position, 4);
  assert.equal(errOf(c, '(1+2').position, 4);
  assert.equal(errOf(c, '1 + $').position, 4);
  assert.equal(errOf(c, '').position, 0);
  assert.equal(errOf(c, '2 3').position, 2);
});

test('format', () => {
  const c = createCalculator();
  assert.equal(c.format(-0), '0');
  assert.equal(c.format(1 / 3), '0.333333333333');
  assert.equal(c.format(1234.5000000000001), '1234.5');
  const c3 = createCalculator({ precision: 3 });
  assert.equal(c3.format(1234.5), '1230');
});

test('history and clear', () => {
  const c = createCalculator();
  ev(c, '1+1');
  ev(c, 'f(x) = x');
  assert.ok(errOf(c, '1/0') instanceof CalcError);
  assert.deepEqual(c.history(), [
    { input: '1+1', result: 2 },
    { input: 'f(x) = x', result: 'f(x)' },
  ]);
  c.setAngleMode('deg');
  c.clear();
  assert.deepEqual(c.history(), []);
  assert.equal(c.getAngleMode(), 'deg');
  assert.equal(c.getVariable('ans'), 0);
  assert.ok(errOf(c, 'f(1)') instanceof CalcError);
});

test('setVariable', () => {
  const c = createCalculator();
  c.setVariable('z', 5);
  assert.equal(ev(c, 'z+1'), 6);
  assert.throws(() => c.setVariable('pi', 1), CalcError);
});
