import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createCalculator, CalcError } from '../../src/calc.js';

const ev = (s, c = createCalculator()) => c.evaluate(s);
const errPos = (s, c = createCalculator()) => {
  try { c.evaluate(s); } catch (e) { assert.ok(e instanceof CalcError, String(e)); return e.position; }
  assert.fail('expected error for ' + s);
};

test('numbers and precedence', () => {
  assert.equal(ev('.5 + 1e-3'), 0.501);
  assert.equal(ev('2.5E+4'), 25000);
  assert.equal(ev('0x1F + 0b101'), 36);
  assert.equal(ev('2^-1'), 0.5);
  assert.equal(ev('-2^2'), -4);
  assert.equal(ev('-3!'), -6);
  assert.equal(ev('6/2(1+2)'), 1);
  assert.equal(ev('(1+1)(2+2)'), 8);
  assert.equal(ev('2 sin(0)'), 0);
  assert.equal(ev('2pi'), 2 * Math.PI);
  assert.equal(ev('7 % 3'), 1);
  assert.equal(ev('-7 % 3'), -1);
  assert.equal(ev('2e'), 2 * Math.E);
  const c = createCalculator(); c.evaluate('x = 2');
  assert.equal(c.evaluate('1/2x'), 0.25);
  assert.equal(c.evaluate('3x'), 6);
});

test('functions', () => {
  assert.equal(ev('round(-2.5)'), -3);
  assert.equal(ev('round(2.5)'), 3);
  assert.equal(ev('nroot(-8,3)'), -2);
  assert.equal(ev('nroot(27,3)'), 3);
  assert.equal(ev('logb(8,2)'), 3);
  assert.equal(ev('log(1000)'), 3);
  assert.equal(ev('avg(1,2,3)'), 2);
  assert.equal(ev('sum(1,2,3)'), 6);
  assert.equal(ev('hypot(3,4)'), 5);
  assert.equal(ev('max(1,5,2)'), 5);
  for (const s of ['sqrt(-1)', 'ln(0)', 'ln(-1)', 'log(0)', 'asin(2)', '1/0', '1%0', '10^400', '(-1)!', '2.5!', '171!', 'sin(1,2)', 'atan2(1)', 'min()', 'foo(1)', 'y', 'nroot(-8,2)'])
    errPos(s);
});

test('angle modes', () => {
  const c = createCalculator({ angleMode: 'deg' });
  assert.equal(c.format(c.evaluate('sin(30)')), '0.5');
  assert.ok(Math.abs(c.evaluate('cos(90)')) < 1e-12);
  assert.ok(Math.abs(c.evaluate('sin(180)')) < 1e-12);
  assert.equal(c.format(c.evaluate('asin(0.5)')), '30');
  assert.equal(c.format(c.evaluate('atan2(1,1)')), '45');
  c.setAngleMode('rad');
  assert.equal(c.getAngleMode(), 'rad');
  assert.throws(() => c.setAngleMode('grad'), CalcError);
});

test('variables, functions, history, clear', () => {
  const c = createCalculator();
  assert.equal(c.evaluate('f(x, y) = x*y + a'), 'f(x,y)');
  c.setVariable('a', 1);
  assert.equal(c.evaluate('f(2,3)'), 7);
  assert.equal(c.evaluate('ans + 1'), 8);
  assert.equal(c.evaluate('g(x) = f(x,x)'), 'g(x)');
  assert.equal(c.evaluate('g(3)'), 10);
  errPos('pi = 3', c); errPos('ans = 3', c); errPos('sin(x) = x', c); errPos('h(x,x) = 1', c);
  c.evaluate('r(x) = r(x)');
  errPos('r(1)', c);
  c.evaluate('p(x) = q(x)'); c.evaluate('q(x) = p(x)');
  errPos('p(1)', c);
  errPos('f(1)', c);
  const h = c.history();
  assert.deepEqual(h[0], { input: 'f(x, y) = x*y + a', result: 'f(x,y)' });
  assert.equal(h.length, 8);
  c.clear();
  assert.equal(c.history().length, 0);
  assert.equal(c.getVariable('a'), undefined);
  assert.equal(c.evaluate('ans'), 0);
});

test('syntax error positions', () => {
  assert.equal(errPos('2 + * 3'), 4);
  assert.equal(errPos('(1+2'), 4);
  assert.equal(errPos('1 + $'), 4);
  assert.equal(errPos('1 2'), 2);
  assert.equal(errPos('1 = 2'), 2);
});

test('format', () => {
  const c = createCalculator();
  assert.equal(c.format(0.1 + 0.2), '0.3');
  assert.equal(c.format(-0), '0');
  assert.equal(createCalculator({ precision: 3 }).format(3.14159), '3.14');
});

test('repl', () => {
  const r = spawnSync(process.execPath, ['src/repl.js'], {
    input: 'x = 2\n\nf(a) = a^2\nf(x)\n1/0\n:deg\nsin(30)\n:vars\n:history\n',
    encoding: 'utf8',
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, ['2', 'f(a)', '4', 'Error: Division by zero', 'mode: deg', '0.5', 'x = 2',
    '1: x = 2 = 2', '2: f(a) = a^2 = f(a)', '3: f(x) = 4', '4: sin(30) = 0.5', ''].join('\n'));
});
