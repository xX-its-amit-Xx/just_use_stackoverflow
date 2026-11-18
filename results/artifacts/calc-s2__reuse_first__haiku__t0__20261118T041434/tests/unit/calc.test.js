import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCalculator, CalcError } from '../../src/calc.js';

const ev = (src, c = createCalculator()) => c.evaluate(src);
const errOf = (src, c = createCalculator()) => {
  try { c.evaluate(src); } catch (e) { return e; }
  assert.fail(`expected error for ${src}`);
};

test('precedence and associativity', () => {
  assert.equal(ev('2^3^2'), 512);
  assert.equal(ev('-2^2'), -4);
  assert.equal(ev('-3!'), -6);
  assert.equal(ev('2^-1'), 0.5);
  assert.equal(ev('10-4-3'), 3);
  assert.equal(ev('2*3%4'), 2);
});

test('implicit multiplication', () => {
  const c = createCalculator();
  assert.equal(ev('6/2(1+2)', c), 1);
  c.evaluate('x = 2');
  assert.equal(ev('1/2x', c), 0.25);
  assert.equal(ev('2pi', c), 2 * Math.PI);
  assert.equal(ev('2 sin(0)', c), 0);
  assert.equal(ev('(1+1)(2+2)', c), 8);
});

test('number literals', () => {
  assert.equal(ev('.5'), 0.5);
  assert.equal(ev('1e-3'), 0.001);
  assert.equal(ev('2.5E+4'), 25000);
  assert.equal(ev('0x1F'), 31);
  assert.equal(ev('0b101'), 5);
});

test('built-in functions', () => {
  assert.equal(ev('round(-2.5)'), -3);
  assert.equal(ev('round(2.5)'), 3);
  assert.equal(ev('nroot(-8,3)'), -2);
  assert.equal(ev('logb(8,2)'), 3);
  assert.equal(ev('min(3,1,2)'), 1);
  assert.equal(ev('avg(1,2,3,4)'), 2.5);
  assert.equal(ev('hypot(3,4)'), 5);
  assert.equal(ev('sum(1,2,3)'), 6);
  assert.equal(ev('3!!'), 720);
});

test('domain and overflow errors', () => {
  for (const s of ['sqrt(-1)', 'ln(0)', 'ln(-1)', 'log(0)', 'asin(2)', '1/0', '5%0', '171!', '(-1)!', '2.5!', '10^400']) {
    assert.ok(errOf(s) instanceof CalcError, s);
  }
});

test('arity errors', () => {
  assert.ok(errOf('sin(1,2)') instanceof CalcError);
  assert.ok(errOf('min()') instanceof CalcError);
  assert.ok(errOf('nosuch(1)') instanceof CalcError);
});

test('syntax error positions', () => {
  assert.equal(errOf('2 + * 3').position, 4);
  assert.equal(errOf('(1+2').position, 4);
  assert.equal(errOf('1 + $').position, 4);
});

test('deg mode exact values', () => {
  const c = createCalculator({ angleMode: 'deg' });
  assert.equal(c.format(ev('sin(30)', c)), '0.5');
  assert.ok(Math.abs(ev('cos(90)', c)) < 1e-12);
  assert.ok(Math.abs(ev('sin(180)', c)) < 1e-12);
  assert.equal(c.format(ev('asin(0.5)', c)), '30');
  assert.equal(c.format(ev('atan2(1,1)', c)), '45');
  c.setAngleMode('rad');
  assert.equal(c.getAngleMode(), 'rad');
  assert.throws(() => c.setAngleMode('grad'), CalcError);
});

test('variables, ans, constants', () => {
  const c = createCalculator();
  ev('x = 4', c);
  assert.equal(ev('ans * x', c), 16);
  assert.equal(c.getVariable('x'), 4);
  assert.equal(c.getVariable('nope'), undefined);
  assert.equal(c.getVariable('ans'), 16);
  assert.throws(() => ev('pi = 3', c), CalcError);
  assert.throws(() => ev('ans = 3', c), CalcError);
  ev('a = b = 7', c);
  assert.equal(c.getVariable('a'), 7);
  assert.equal(c.getVariable('b'), 7);
  assert.throws(() => ev('y', c), CalcError);
  c.setVariable('z', 2.5);
  assert.equal(ev('z*2', c), 5);
});

test('failed statements do not change ans or history', () => {
  const c = createCalculator();
  ev('3', c);
  assert.throws(() => ev('x = 1/0', c));
  assert.equal(c.getVariable('x'), undefined);
  assert.equal(ev('ans', c), 3);
  assert.deepEqual(c.history().map((h) => h.input), ['3', 'ans']);
});

test('user functions', () => {
  const c = createCalculator();
  assert.equal(ev('f(x,y)=x+y', c), 'f(x,y)');
  assert.equal(ev('f(1,2)', c), 3);
  ev('k = 10', c);
  ev('g(x) = x + k', c);
  assert.equal(ev('g(1)', c), 11);
  ev('g(x) = 2*x', c); // redefinition replaces
  assert.equal(ev('g(5)', c), 10);
  assert.throws(() => ev('f(1)', c), CalcError);
  assert.throws(() => ev('sin(x)=x', c), CalcError);
  assert.throws(() => ev('h(x,x)=x', c), CalcError);
  ev('h(x)=h(x)+1', c);
  assert.throws(() => ev('h(1)', c), CalcError);
  assert.equal(ev('2+3', c), 5); // state still usable after recursion error
});

test('history, clear, format', () => {
  const c = createCalculator({ precision: 4 });
  ev('1/3', c);
  ev('f(x)=x', c);
  assert.deepEqual(c.history(), [
    { input: '1/3', result: 1 / 3 },
    { input: 'f(x)=x', result: 'f(x)' },
  ]);
  assert.equal(c.format(1 / 3), '0.3333');
  assert.equal(c.format(-0), '0');
  c.clear();
  assert.deepEqual(c.history(), []);
  assert.equal(ev('ans', c), 0);
  assert.equal(c.history().length, 1);
  assert.equal(c.getVariable('x'), undefined);
});
