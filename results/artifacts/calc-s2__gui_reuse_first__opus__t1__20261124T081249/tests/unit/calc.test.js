import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createCalculator, CalcError } from '../../src/calc.js';

const ev = (s, c = createCalculator()) => c.evaluate(s);
const err = (s, pos, c = createCalculator()) => {
  assert.throws(() => c.evaluate(s), (e) => e instanceof CalcError && (pos === undefined || e.position === pos));
};

test('precedence', () => {
  assert.equal(ev('2^-1'), 0.5);
  assert.equal(ev('-2^2'), -4);
  assert.equal(ev('-3!'), -6);
  assert.equal(ev('6/2(1+2)'), 1);
  assert.equal(ev('(1+1)(2+2)'), 8);
  const c = createCalculator(); c.evaluate('x=2'); assert.equal(c.evaluate('1/2x'), 0.25);
  assert.equal(ev('0x1F + 0b101'), 36);
  assert.equal(ev('-7 % 3'), -1);
});
test('functions', () => {
  const c = createCalculator();
  assert.equal(c.evaluate('f(x,y) = x*y + a'), 'f(x,y)');
  err('f(1,2)', undefined, c);
  c.evaluate('a = 1');
  assert.equal(c.evaluate('f(2,3)'), 7);
  c.evaluate('g(x) = g(x)');
  err('g(1)', undefined, c);
  err('sin(x) = x', undefined, c);
  err('min()', undefined, c);
  assert.equal(ev('nroot(-8,3)'), -2);
  assert.equal(ev('round(-2.5)'), -3);
});
test('errors', () => {
  err('(1+2', 4); err('1 + $', 4); err('sqrt(-1)'); err('ln(0)'); err('asin(2)'); err('1/0');
  err('171!'); err('2.5!'); err('10^400'); err('pi = 3'); err('ans = 1'); err('undefinedvar');
});
test('deg mode, format, history, clear', () => {
  const c = createCalculator({ angleMode: 'deg' });
  assert.equal(c.format(c.evaluate('sin(30)')), '0.5');
  assert.ok(Math.abs(c.evaluate('cos(90)')) < 1e-12);
  assert.throws(() => c.setAngleMode('grad'), CalcError);
  assert.equal(c.format(-0), '0');
  assert.equal(c.format(0.1 + 0.2), '0.3');
  try { c.evaluate('1+'); } catch {}
  assert.equal(c.history().length, 2);
  c.clear();
  assert.equal(c.history().length, 0);
  assert.equal(c.evaluate('ans'), 0);
  assert.equal(c.getAngleMode(), 'deg');
});
test('repl', () => {
  const r = spawnSync(process.execPath, ['src/repl.js'], { input: 'x=3\nf(a)=a\n\n:vars\n1+\n:history\n:deg\n' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.toString(), '3\nf(a)\nx = 3\nError: Unexpected end of input\n1: x=3 = 3\n2: f(a)=a = f(a)\nmode: deg\n');
});
