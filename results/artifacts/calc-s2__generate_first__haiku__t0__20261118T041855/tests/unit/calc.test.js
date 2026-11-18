import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCalculator, CalcError } from '../../src/calc.js';

const val = (c, s) => c.evaluate(s);
const fmt = (c, s) => c.format(c.evaluate(s));

test('precedence and associativity', () => {
  const c = createCalculator();
  assert.equal(val(c, '-2^2'), -4);
  assert.equal(val(c, '-3!'), -6);
  assert.equal(val(c, '2^-1'), 0.5);
  assert.equal(val(c, '2^3^2'), 512);
  assert.equal(val(c, '6/2(1+2)'), 1);
  assert.equal(val(c, '10-4-3'), 3);
});

test('implicit multiplication', () => {
  const c = createCalculator();
  c.evaluate('x = 2');
  assert.equal(val(c, '1/2x'), 0.25);
  assert.equal(fmt(c, '2pi'), '6.28318530718');
  assert.equal(val(c, '(1+1)(2+2)'), 8);
  assert.equal(val(c, '2 sin(0)'), 0);
  assert.equal(val(c, '2e3'), 2000);
});

test('number literals', () => {
  const c = createCalculator();
  assert.equal(val(c, '0x1F'), 31);
  assert.equal(val(c, '0b101'), 5);
  assert.equal(val(c, '.5'), 0.5);
  assert.equal(val(c, '2.5E+4'), 25000);
});

test('deg mode exactness', () => {
  const c = createCalculator({ angleMode: 'deg' });
  assert.equal(fmt(c, 'sin(30)'), '0.5');
  assert.ok(Math.abs(val(c, 'cos(90)')) < 1e-12);
  assert.ok(Math.abs(val(c, 'sin(180)')) < 1e-12);
  assert.equal(fmt(c, 'asin(0.5)'), '30');
});

test('functions, recursion and arity', () => {
  const c = createCalculator();
  assert.equal(val(c, 'f(x,y) = x*y'), 'f(x,y)');
  assert.equal(val(c, 'f(3,4)'), 12);
  assert.equal(val(c, 'nroot(-8,3)'), -2);
  assert.equal(val(c, 'round(-2.5)'), -3);
  assert.equal(val(c, 'g(n) = g(n)'), 'g(n)');
  assert.throws(() => c.evaluate('g(1)'), CalcError);
  assert.throws(() => c.evaluate('sin(1,2)'), CalcError);
  assert.throws(() => c.evaluate('sin(x) = 2'), CalcError);
});

test('errors and positions', () => {
  const c = createCalculator();
  const pos = (s) => { try { c.evaluate(s); } catch (e) { assert.ok(e instanceof CalcError); return e.position; } assert.fail(s); };
  assert.equal(pos('(1+2'), 4);
  assert.equal(pos('1 + $'), 4);
  assert.equal(pos('1/0'), 1);
  assert.equal(pos('sqrt(-1)'), 0);
  assert.equal(pos('pi = 3'), 0);
  assert.equal(pos('ans = 3'), 0);
});

test('history excludes failures and state clear', () => {
  const c = createCalculator({ angleMode: 'deg' });
  c.evaluate('1+1');
  assert.throws(() => c.evaluate('1/0'));
  c.evaluate('f(x) = x');
  assert.deepEqual(c.history(), [
    { input: '1+1', result: 2 },
    { input: 'f(x) = x', result: 'f(x)' },
  ]);
  c.setVariable('v', 3);
  c.clear();
  assert.equal(c.getVariable('v'), undefined);
  assert.equal(c.getAngleMode(), 'deg');
  assert.equal(c.getVariable('ans'), 0);
  assert.deepEqual(c.history(), []);
});

test('format strips zeros and -0', () => {
  const c = createCalculator();
  assert.equal(c.format(-0), '0');
  assert.equal(c.format(0.1 + 0.2), '0.3');
  assert.equal(c.format(1 / 3), '0.333333333333');
});

test('repl session', () => {
  const out = execFileSync(process.execPath, [fileURLToPath(new URL('../../src/repl.js', import.meta.url))], {
    input: '1+2\nx = 4\n\nf(x) = x^2\nf(3)\n:deg\nsin(30)\nbad $\n:vars\n:history\n',
    encoding: 'utf8',
  });
  assert.equal(out, [
    '3',
    '4',
    'f(x)',
    '9',
    'mode: deg',
    '0.5',
    "Error: Syntax error: unexpected '$'",
    'x = 4',
    '1: 1+2 = 3',
    '2: x = 4 = 4',
    '3: f(x) = x^2 = f(x)',
    '4: f(3) = 9',
    '5: sin(30) = 0.5',
    '',
  ].join('\n'));
});
