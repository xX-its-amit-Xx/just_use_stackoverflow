import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCalculator, CalcError } from '../../src/calc.js';
import { processLine } from '../../src/repl.js';

const ev = (c, s) => c.evaluate(s);
const fmt = (c, s) => c.format(c.evaluate(s));

function errOf(c, s) {
  try { c.evaluate(s); } catch (e) { return e; }
  assert.fail(`expected error for ${s}`);
}

test('precedence and associativity', () => {
  const c = createCalculator();
  assert.equal(ev(c, '2^3^2'), 512);
  assert.equal(ev(c, '2^-1'), 0.5);
  assert.equal(ev(c, '-2^2'), -4);
  assert.equal(ev(c, '-3!'), -6);
  assert.equal(ev(c, '1 - 2 - 3'), -4);
  assert.equal(ev(c, '7 % 4'), 3);
  assert.equal(ev(c, '2 + 3 * 4'), 14);
});

test('implicit multiplication', () => {
  const c = createCalculator();
  assert.equal(ev(c, '6/2(1+2)'), 1);
  c.evaluate('x = 2');
  assert.equal(ev(c, '1/2x'), 0.25);
  assert.equal(ev(c, '2pi') , 2 * Math.PI);
  assert.equal(ev(c, '(1+1)(2+2)'), 8);
  assert.equal(ev(c, '2 sin(0)'), 0);
  assert.equal(ev(c, '2e') , 2 * Math.E);
});

test('numbers', () => {
  const c = createCalculator();
  assert.equal(ev(c, '.5'), 0.5);
  assert.equal(ev(c, '1e-3'), 0.001);
  assert.equal(ev(c, '2.5E+4'), 25000);
  assert.equal(ev(c, '0x1F'), 31);
  assert.equal(ev(c, '0b101'), 5);
});

test('deg mode trig', () => {
  const c = createCalculator();
  c.setAngleMode('deg');
  assert.equal(c.format(ev(c, 'sin(30)')), '0.5');
  assert.ok(Math.abs(ev(c, 'cos(90)')) < 1e-12);
  assert.ok(Math.abs(ev(c, 'sin(180)')) < 1e-12);
  assert.equal(c.format(ev(c, 'atan2(1,1)')), '45');
  assert.equal(c.format(ev(c, 'asin(1)')), '90');
});

test('builtins', () => {
  const c = createCalculator();
  assert.equal(ev(c, 'round(-2.5)'), -3);
  assert.equal(ev(c, 'nroot(-8,3)'), -2);
  assert.equal(ev(c, 'logb(8,2)') > 2.9999, true);
  assert.equal(ev(c, 'min(3,1,2)'), 1);
  assert.equal(ev(c, 'max(3,1,2)'), 3);
  assert.equal(ev(c, 'sum(1,2,3)'), 6);
  assert.equal(ev(c, 'avg(1,2,3)'), 2);
  assert.equal(ev(c, 'hypot(3,4)'), 5);
  assert.equal(ev(c, 'pow(2,10)'), 1024);
  assert.equal(ev(c, 'sign(-4)'), -1);
});

test('domain and arity errors', () => {
  const c = createCalculator();
  for (const s of ['sqrt(-1)', 'ln(0)', 'ln(-1)', 'log(0)', 'asin(2)', '1/0', '1%0',
    '(-1)!', '1.5!', '171!', 'exp(1000)', 'sin(1,2)', 'nroot(-4,2)', '2^1024']) {
    assert.ok(errOf(c, s) instanceof CalcError, s);
  }
});

test('syntax error positions', () => {
  const c = createCalculator();
  assert.equal(errOf(c, '2 + * 3').position, 4);
  assert.equal(errOf(c, '(1+2').position, 4);
  assert.equal(errOf(c, '1 + $').position, 4);
});

test('assignment rules', () => {
  const c = createCalculator();
  assert.equal(ev(c, 'x = 4'), 4);
  assert.equal(ev(c, 'ans * x'), 16);
  assert.throws(() => c.evaluate('pi = 3'), CalcError);
  assert.throws(() => c.evaluate('ans = 3'), CalcError);
  assert.throws(() => c.evaluate('y = z'), CalcError);
  assert.equal(c.getVariable('x'), 4);
  assert.equal(c.getVariable('nope'), undefined);
});

test('user functions, recursion and redefinition', () => {
  const c = createCalculator();
  assert.equal(ev(c, 'f(x,y) = x*y + k'), 'f(x,y)');
  c.evaluate('k = 1');
  assert.equal(ev(c, 'f(2,3)'), 7);
  c.evaluate('k = 10');
  assert.equal(ev(c, 'f(2,3)'), 16);
  assert.equal(ev(c, 'g(x) = x + 1'), 'g(x)');
  assert.equal(ev(c, 'g(g(1))'), 3);
  c.evaluate('r(n) = r(n)');
  assert.throws(() => c.evaluate('r(1)'), CalcError);
  assert.throws(() => c.evaluate('sin(x) = x'), CalcError);
  assert.throws(() => c.evaluate('g(1,2)'), CalcError);
  c.evaluate('g(x) = 2*x');
  assert.equal(ev(c, 'g(4)'), 8);
});

test('history, clear and angle mode', () => {
  const c = createCalculator({ angleMode: 'deg' });
  c.evaluate('1+1');
  assert.throws(() => c.evaluate('1/0'));
  c.evaluate('h(a) = a');
  assert.deepEqual(c.history(), [
    { input: '1+1', result: 2 },
    { input: 'h(a) = a', result: 'h(a)' },
  ]);
  c.evaluate('v = 3');
  c.clear();
  assert.equal(c.getVariable('v'), undefined);
  assert.equal(c.getAngleMode(), 'deg');
  assert.deepEqual(c.history(), []);
  assert.equal(ev(c, 'ans'), 0);
  assert.throws(() => c.setAngleMode('grad'), CalcError);
});

test('format', () => {
  const c = createCalculator();
  assert.equal(c.format(1 / 3), '0.333333333333');
  assert.equal(c.format(-0), '0');
  assert.equal(c.format(100), '100');
  assert.equal(c.format(1.5000000000001), '1.5');
});

test('repl lines', () => {
  const c = createCalculator();
  assert.deepEqual(processLine(c, '   '), []);
  assert.deepEqual(processLine(c, 'x = 2'), ['2']);
  assert.deepEqual(processLine(c, 'f(a) = a*x'), ['f(a)']);
  assert.deepEqual(processLine(c, 'f(3)'), ['6']);
  assert.deepEqual(processLine(c, '1/0'), ['Error: Division by zero']);
  assert.deepEqual(processLine(c, ':deg'), ['mode: deg']);
  assert.deepEqual(processLine(c, ':vars'), ['x = 2']);
  assert.deepEqual(processLine(c, ':history'), [
    '1: x = 2 = 2',
    '2: f(a) = a*x = f(a)',
    '3: f(3) = 6',
  ]);
});
