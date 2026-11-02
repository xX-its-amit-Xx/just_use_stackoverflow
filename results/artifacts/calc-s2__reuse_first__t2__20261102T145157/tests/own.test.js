import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCalculator, CalcError } from '../src/calc.js';
test('misc', () => {
  const c = createCalculator();
  assert.equal(c.evaluate('-2^2'), -4);
  assert.equal(c.evaluate('2^-1'), 0.5);
  assert.equal(c.evaluate('0x1F + 0b101'), 36);
  assert.equal(c.evaluate('round(-2.5)'), -3);
  assert.equal(c.evaluate('f(x)=x+1'), 'f(x)');
  assert.throws(() => c.evaluate('g(x)=g(x)+1') && c.evaluate('g(1)'), CalcError);
  assert.throws(() => c.evaluate('sin(x)=1'), CalcError);
  assert.throws(() => c.evaluate('1/0'), CalcError);
  try { c.evaluate('1 + $'); } catch (e) { assert.equal(e.position, 4); }
  try { c.evaluate('(1+2'); } catch (e) { assert.equal(e.position, 4); }
  c.setAngleMode('deg');
  assert.equal(c.format(c.evaluate('sin(30)')), '0.5');
  assert.ok(Math.abs(c.evaluate('cos(90)')) < 1e-12);
});
