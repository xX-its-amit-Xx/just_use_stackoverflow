import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createCalculator, CalcError } from '../../src/calc.js';

const err = (c, s, pos) => assert.throws(() => c.evaluate(s), (e) => e instanceof CalcError && (pos === undefined || e.position === pos));

test('precedence & implicit multiplication', () => {
  const c = createCalculator();
  assert.equal(c.evaluate('-2^2'), -4);
  assert.equal(c.evaluate('-3!'), -6);
  assert.equal(c.evaluate('2^-1'), 0.5);
  assert.equal(c.evaluate('6/2(1+2)'), 1);
  c.evaluate('x = 2');
  assert.equal(c.evaluate('1/2x'), 0.25);
  assert.equal(c.evaluate('(1+1)(2+2)'), 8);
  assert.equal(c.evaluate('0x1F + 0b101'), 36);
});
test('functions, errors, deg mode', () => {
  const c = createCalculator();
  assert.equal(c.evaluate('f(x, y) = x*y'), 'f(x,y)');
  assert.equal(c.evaluate('f(2,3)'), 6);
  c.evaluate('g(x) = h(x)'); c.evaluate('h(x) = g(x)');
  err(c, 'g(1)');
  err(c, 'sin(x) = x');
  err(c, 'sqrt(-1)'); err(c, '1/0'); err(c, '(1+2', 4); err(c, '1 + $', 4);
  assert.equal(c.evaluate('round(-2.5)'), -3);
  assert.equal(c.evaluate('nroot(-8,3)'), -2);
  c.setAngleMode('deg');
  assert.equal(c.format(c.evaluate('sin(30)')), '0.5');
  assert.ok(Math.abs(c.evaluate('cos(90)')) < 1e-12);
  assert.equal(c.format(-0), '0');
  assert.equal(c.history().length, 8);
  c.clear();
  assert.equal(c.history().length, 0);
  assert.equal(c.getAngleMode(), 'deg');
});
test('repl', () => {
  const r = spawnSync(process.execPath, ['src/repl.js'], { input: 'a=2\n\n:vars\n1/0\n:history\n' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.toString(), '2\na = 2\nError: Division by zero\n1: a=2 = 2\n');
});
