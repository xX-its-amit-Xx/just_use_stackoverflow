import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createCalculator, CalcError } from '../../src/calc.js';

const pos = (c, s) => { try { c.evaluate(s); } catch (e) { assert.ok(e instanceof CalcError); return e.position; } assert.fail('no error: ' + s); };

test('precedence and implicit multiplication', () => {
  const c = createCalculator();
  assert.equal(c.evaluate('-2^2'), -4);
  assert.equal(c.evaluate('-3!'), -6);
  assert.equal(c.evaluate('6/2(1+2)'), 1);
  c.evaluate('x = 2');
  assert.equal(c.evaluate('1/2x'), 0.25);
  assert.equal(c.evaluate('(1+1)(2+2)'), 8);
  assert.equal(c.evaluate('0x1F + 0b101'), 36);
});

test('functions, errors and degrees', () => {
  const c = createCalculator({ angleMode: 'deg' });
  assert.equal(c.evaluate('f(x,y) = x*y'), 'f(x,y)');
  assert.equal(c.evaluate('f(3,4)'), 12);
  assert.equal(c.format(c.evaluate('sin(30)')), '0.5');
  assert.ok(Math.abs(c.evaluate('cos(90)')) < 1e-12);
  c.evaluate('g(x) = g(x)');
  assert.throws(() => c.evaluate('g(1)'), CalcError);
  assert.throws(() => c.evaluate('sqrt(-1)'), CalcError);
  assert.throws(() => c.evaluate('sin(x) = 1'), CalcError);
  assert.equal(pos(c, '(1+2'), 4);
  assert.equal(pos(c, '1 + $'), 4);
  assert.equal(c.evaluate('round(-2.5)'), -3);
  assert.equal(c.evaluate('nroot(-8,3)'), -2);
  assert.equal(c.history().length, 7);
});

test('repl', () => {
  const out = execFileSync(process.execPath, ['src/repl.js'], { input: 'x=3\n\n:vars\n1/0\n:history\n' }).toString();
  assert.equal(out, 'x = 3\n'.replace('x = 3', '3') + 'x = 3\nError: Division by zero\n1: x=3 = 3\n');
});
