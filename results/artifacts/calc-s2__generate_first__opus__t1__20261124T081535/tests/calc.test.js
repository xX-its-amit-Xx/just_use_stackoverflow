import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createCalculator, CalcError } from '../src/calc.js';

const pos = (c, s) => { try { c.evaluate(s); } catch (e) { assert.ok(e instanceof CalcError); return e.position; } assert.fail('no error: ' + s); };

test('precedence and implicit multiplication', () => {
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

test('functions, recursion, errors', () => {
  const c = createCalculator();
  assert.equal(c.evaluate('f(x, y) = x*y + k'), 'f(x,y)');
  c.evaluate('k = 1');
  assert.equal(c.evaluate('f(2,3)'), 7);
  c.evaluate('g(x) = h(x)'); c.evaluate('h(x) = g(x)');
  assert.throws(() => c.evaluate('g(1)'), CalcError);
  assert.throws(() => c.evaluate('sin(x) = x'), CalcError);
  assert.throws(() => c.evaluate('pi = 3'), CalcError);
  assert.equal(pos(c, '(1+2'), 4);
  assert.equal(pos(c, '1 + $'), 4);
  for (const s of ['sqrt(-1)', 'ln(0)', 'log(0)', 'asin(2)', '1/0', '1%0', '10^400', '(-1)!', '171!']) assert.throws(() => c.evaluate(s), CalcError);
});

test('deg mode and format', () => {
  const c = createCalculator({ angleMode: 'deg' });
  assert.equal(c.format(c.evaluate('sin(30)')), '0.5');
  assert.ok(Math.abs(c.evaluate('cos(90)')) < 1e-12);
  assert.equal(c.format(-0), '0');
  assert.equal(c.format(0.1 + 0.2), '0.3');
  assert.throws(() => c.setAngleMode('grad'), CalcError);
});

test('history and clear', () => {
  const c = createCalculator();
  c.evaluate('1+1'); try { c.evaluate('1/0'); } catch {}
  assert.deepEqual(c.history(), [{ input: '1+1', result: 2 }]);
  assert.equal(c.evaluate('ans*3'), 6);
  c.clear();
  assert.deepEqual(c.history(), []);
  assert.equal(c.evaluate('ans'), 0);
});

test('repl', () => {
  const out = execFileSync(process.execPath, [new URL('../src/repl.js', import.meta.url).pathname], { input: 'x=2\n\nf(a)=a+1\n1/0\n:vars\n:history\n:deg\n' }).toString();
  assert.equal(out, 'x = 2\n'.slice(4) + 'f(a)\nError: Division by zero\nx = 2\n1: x=2 = 2\n2: f(a)=a+1 = f(a)\nmode: deg\n');
});
