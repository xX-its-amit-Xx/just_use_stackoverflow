import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCalculator, CalcError } from '../../src/calc.js';

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
  assert.equal(c.evaluate('f(x, y) = x + y'), 'f(x,y)');
  assert.equal(c.evaluate('f(2,3)'), 5);
  c.evaluate('g(x) = g(x)');
  assert.throws(() => c.evaluate('g(1)'), CalcError);
  assert.throws(() => c.evaluate('sin(x) = 1'), CalcError);
  assert.throws(() => c.evaluate('pi = 3'), CalcError);
  for (const s of ['sqrt(-1)', 'ln(0)', 'log(0)', 'asin(2)', '1/0', '1%0', '(-1)!', '2.5!', '171!', '10^400', 'sin(1,2)'])
    assert.throws(() => c.evaluate(s), CalcError, s);
  assert.equal(pos(c, '(1+2'), 4);
  assert.equal(pos(c, '1 + $'), 4);
});

test('deg mode, format, history, clear', () => {
  const c = createCalculator({ angleMode: 'deg' });
  assert.equal(c.format(c.evaluate('sin(30)')), '0.5');
  assert.ok(Math.abs(c.evaluate('cos(90)')) < 1e-12);
  assert.equal(c.format(-0), '0');
  assert.equal(c.evaluate('round(-2.5)'), -3);
  assert.equal(c.evaluate('nroot(-8,3)'), -2);
  assert.throws(() => c.setAngleMode('grad'), CalcError);
  try { c.evaluate('1+'); } catch {}
  assert.equal(c.history().length, 4);
  c.clear();
  assert.deepEqual(c.history(), []);
  assert.equal(c.getVariable('ans'), 0);
  assert.equal(c.getAngleMode(), 'deg');
});

test('repl', () => {
  const repl = fileURLToPath(new URL('../../src/repl.js', import.meta.url));
  const r = spawnSync(process.execPath, [repl], { input: 'x=3\n\nf(a)=a+x\nf(1)\n1/0\n:deg\n:vars\n:history\n', encoding: 'utf8' });
  assert.equal(r.status, 0);
  const lines = r.stdout.trim().split('\n');
  assert.deepEqual(lines.slice(0, 2), ['3', 'f(a)']);
  assert.equal(lines[2], '4');
  assert.match(lines[3], /^Error: /);
  assert.equal(lines[4], 'mode: deg');
  assert.equal(lines[5], 'x = 3');
  assert.deepEqual(lines.slice(6), ['1: x=3 = 3', '2: f(a)=a+x = f(a)', '3: f(1) = 4']);
});
