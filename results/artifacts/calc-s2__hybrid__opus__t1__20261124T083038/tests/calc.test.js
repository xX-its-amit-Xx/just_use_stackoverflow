import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createCalculator, CalcError } from '../src/calc.js';

const ev = (s, c = createCalculator()) => c.evaluate(s);
const pos = (s, c = createCalculator()) => { try { c.evaluate(s); } catch (e) { assert.ok(e instanceof CalcError, String(e)); return e.position; } assert.fail('no error: ' + s); };

test('precedence', () => {
  assert.equal(ev('-2^2'), -4); assert.equal(ev('-3!'), -6); assert.equal(ev('2^-1'), 0.5);
  assert.equal(ev('6/2(1+2)'), 1); assert.equal(ev('(1+1)(2+2)'), 8); assert.equal(ev('2 sin(0)'), 0);
  const c = createCalculator(); c.evaluate('x=2'); assert.equal(c.evaluate('1/2x'), 0.25); assert.equal(c.evaluate('3x'), 6);
  assert.equal(ev('2pi'), 2 * Math.PI); assert.equal(ev('7 % 3'), 1); assert.equal(ev('0x1F + 0b101'), 36);
  assert.equal(ev('.5 + 1e-3 + 2.5E+4'), 25000.501); assert.equal(ev('2e'), 2 * Math.E);
});
test('functions', () => {
  assert.equal(ev('round(-2.5)'), -3); assert.equal(ev('nroot(-8,3)'), -2); assert.equal(ev('logb(8,2)'), 3);
  assert.equal(ev('log(1000)'), 3); assert.equal(ev('avg(1,2,3)'), 2); assert.equal(ev('hypot(3,4)'), 5);
  const c = createCalculator();
  assert.equal(c.evaluate('f(x,y) = x*y + k'), 'f(x,y)');
  c.evaluate('k = 1'); assert.equal(c.evaluate('f(2,3)'), 7);
  c.evaluate('g(x) = g(x)'); assert.throws(() => c.evaluate('g(1)'), CalcError);
  assert.throws(() => c.evaluate('sin(x) = 1'), CalcError);
  assert.throws(() => c.evaluate('h(x,x) = 1'), CalcError);
  assert.throws(() => c.evaluate('sin(1,2)'), CalcError);
  assert.throws(() => c.evaluate('pi = 3'), CalcError);
  assert.throws(() => c.evaluate('ans = 3'), CalcError);
});
test('deg mode', () => {
  const c = createCalculator({ angleMode: 'deg' });
  assert.equal(c.format(c.evaluate('sin(30)')), '0.5');
  assert.ok(Math.abs(c.evaluate('cos(90)')) < 1e-12); assert.ok(Math.abs(c.evaluate('sin(180)')) < 1e-12);
  assert.equal(c.format(c.evaluate('asin(1)')), '90');
  assert.throws(() => c.setAngleMode('grad'), CalcError);
});
test('errors', () => {
  for (const s of ['sqrt(-1)', 'ln(0)', 'ln(-1)', 'log(0)', 'asin(2)', '1/0', '1%0', '10^400', '(-1)!', '2.5!', '171!', 'y'])
    assert.throws(() => ev(s), CalcError, s);
  assert.equal(pos('(1+2'), 4); assert.equal(pos('1 + $'), 4); assert.equal(pos('2 + * 3'), 4);
});
test('history/clear/format', () => {
  const c = createCalculator();
  c.evaluate('a = 1'); try { c.evaluate('1/0'); } catch {} c.evaluate('f(x)=x');
  assert.deepEqual(c.history(), [{ input: 'a = 1', result: 1 }, { input: 'f(x)=x', result: 'f(x)' }]);
  c.clear(); assert.equal(c.getVariable('a'), undefined); assert.equal(c.evaluate('ans'), 0);
  assert.equal(c.format(-0), '0'); assert.equal(c.format(0.1 + 0.2), '0.3');
});
test('repl', () => {
  const out = execFileSync('node', ['src/repl.js'], { input: 'x = 2\n\n:deg\nsin(30)\n1/0\nf(a)=a\n:vars\n:history\n' }).toString();
  assert.equal(out, 'x = 2\n'.replace('x = 2', '2') + 'mode: deg\n0.5\nError: Division by zero\nf(a)\nx = 2\n1: x = 2 = 2\n2: sin(30) = 0.5\n3: f(a)=a = f(a)\n');
});
