import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createCalculator, CalcError } from '../src/calc.js';

const ev = (s, c = createCalculator()) => c.evaluate(s);
const pos = (s, c = createCalculator()) => { try { c.evaluate(s); } catch (e) { assert.ok(e instanceof CalcError); return e.position; } assert.fail('no error: ' + s); };

test('precedence', () => {
  assert.equal(ev('2^3^2'), 512); assert.equal(ev('2^-1'), 0.5); assert.equal(ev('-2^2'), -4);
  assert.equal(ev('-3!'), -6); assert.equal(ev('6/2(1+2)'), 1); assert.equal(ev('(1+1)(2+2)'), 8);
  assert.equal(ev('2(3+1)'), 8); assert.equal(ev('2 sin(0)'), 0); assert.equal(ev('2pi'), 2 * Math.PI);
  assert.equal(ev('7 % 3'), 1); assert.equal(ev('-7 % 3'), -1); assert.equal(ev('1+2*3-4'), 3);
  const c = createCalculator(); c.evaluate('x = 2'); assert.equal(c.evaluate('1/2x'), 0.25); assert.equal(c.evaluate('3x'), 6);
});
test('numbers', () => {
  assert.equal(ev('.5'), 0.5); assert.equal(ev('1e-3'), 0.001); assert.equal(ev('2.5E+4'), 25000);
  assert.equal(ev('0x1F'), 31); assert.equal(ev('0b101'), 5); assert.equal(ev('2e'), 2 * Math.E);
});
test('functions', () => {
  assert.equal(ev('round(-2.5)'), -3); assert.equal(ev('nroot(-8,3)'), -2); assert.equal(ev('log(1000)'), 3);
  assert.equal(ev('logb(8,2)'), 3); assert.equal(ev('sum(1,2,3)'), 6); assert.equal(ev('avg(1,2,3)'), 2);
  assert.equal(ev('hypot(3,4)'), 5); assert.equal(ev('max(1,5,2)'), 5); assert.equal(ev('5!'), 120);
  for (const s of ['sqrt(-1)', 'ln(0)', 'ln(-1)', 'log(0)', 'asin(2)', '1/0', '1%0', '10^400', '(-1)!', '2.5!', '171!', 'sin(1,2)', 'atan2(1)', 'max()', 'foo(1)', 'y'])
    assert.throws(() => ev(s), CalcError, s);
});
test('deg mode', () => {
  const c = createCalculator({ angleMode: 'deg' });
  assert.equal(c.format(c.evaluate('sin(30)')), '0.5');
  assert.ok(Math.abs(c.evaluate('cos(90)')) < 1e-12); assert.ok(Math.abs(c.evaluate('sin(180)')) < 1e-12);
  assert.equal(c.format(c.evaluate('asin(1)')), '90');
  assert.throws(() => c.setAngleMode('grad'), CalcError);
  c.setAngleMode('rad'); assert.equal(c.getAngleMode(), 'rad');
});
test('positions', () => {
  assert.equal(pos('2 + * 3'), 4); assert.equal(pos('(1+2'), 4); assert.equal(pos('1 + $'), 4);
  assert.equal(pos('2 3'), 2); assert.equal(pos(''), 0);
});
test('user functions, vars, history', () => {
  const c = createCalculator();
  assert.equal(c.evaluate('f(x,y) = x*y + k'), 'f(x,y)');
  assert.throws(() => c.evaluate('f(2,3)'), CalcError);
  c.setVariable('k', 1); assert.equal(c.evaluate('f(2,3)'), 7);
  assert.throws(() => c.evaluate('sin(x) = x'), CalcError);
  assert.throws(() => c.evaluate('g(x,x) = x'), CalcError);
  assert.throws(() => c.evaluate('pi = 3'), CalcError);
  assert.throws(() => c.evaluate('ans = 3'), CalcError);
  c.evaluate('r(x) = s(x)'); c.evaluate('s(x) = r(x)');
  assert.throws(() => c.evaluate('r(1)'), CalcError);
  assert.equal(c.evaluate('ans + 1'), 8);
  assert.deepEqual(c.history().map((h) => h.result), ['f(x,y)', 7, 'r(x)', 's(x)', 8]);
  assert.equal(c.format(-0), '0'); assert.equal(c.format(0.1 + 0.2), '0.3');
  c.clear(); assert.equal(c.getVariable('k'), undefined); assert.equal(c.evaluate('ans'), 0);
});
test('repl', () => {
  const out = execFileSync('node', ['src/repl.js'], { input: 'x = 2\n\nf(a) = a^2\n:deg\nsin(30)\n1/0\n:vars\n:history\n' }).toString();
  assert.equal(out, 'x = 2\n'.replace('x = 2', '2') + 'f(a)\nmode: deg\n0.5\nError: Division by zero\nx = 2\n1: x = 2 = 2\n2: f(a) = a^2 = f(a)\n3: sin(30) = 0.5\n');
});
