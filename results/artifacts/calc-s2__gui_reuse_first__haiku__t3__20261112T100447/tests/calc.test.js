import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createCalculator, CalcError } from '../src/calc.js';

const ev = (src, c = createCalculator()) => c.evaluate(src);
const fmt = (src, c = createCalculator()) => c.format(c.evaluate(src));
const errOf = (src, c = createCalculator()) => {
  try { c.evaluate(src); } catch (e) { return e; }
  assert.fail(`expected error for ${JSON.stringify(src)}`);
};

test('precedence and associativity', () => {
  assert.equal(ev('2^3^2'), 512);
  assert.equal(ev('2^-1'), 0.5);
  assert.equal(ev('-2^2'), -4);
  assert.equal(ev('-3!'), -6);
  assert.equal(ev('1 + 2 * 3 - 4 / 2'), 5);
  assert.equal(ev('7 % 4'), 3);
  assert.equal(ev('-7 % 3'), -1);
});

test('implicit multiplication', () => {
  assert.equal(ev('2pi'), 2 * Math.PI);
  assert.equal(ev('2(3+1)'), 8);
  assert.equal(ev('(1+1)(2+2)'), 8);
  assert.equal(ev('6/2(1+2)'), 1);
  const c = createCalculator();
  c.evaluate('x = 2');
  assert.equal(ev('1/2x', c), 0.25);
  assert.equal(ev('2 sin(0)'), 0);
});

test('numbers and radix literals', () => {
  assert.equal(ev('.5'), 0.5);
  assert.equal(ev('1e-3'), 0.001);
  assert.equal(ev('2.5E+4'), 25000);
  assert.equal(ev('0x1F'), 31);
  assert.equal(ev('0b101'), 5);
});

test('factorial', () => {
  assert.equal(ev('5!'), 120);
  assert.equal(ev('0!'), 1);
  assert.ok(errOf('(-1)!') instanceof CalcError);
  assert.ok(errOf('2.5!') instanceof CalcError);
  assert.ok(errOf('171!') instanceof CalcError);
  assert.ok(Number.isFinite(ev('170!')));
});

test('built-ins and rounding', () => {
  assert.equal(ev('round(-2.5)'), -3);
  assert.equal(ev('round(2.5)'), 3);
  assert.equal(ev('nroot(-8,3)'), -2);
  assert.equal(ev('max(1,5,3)'), 5);
  assert.equal(ev('avg(2,4)'), 3);
  assert.equal(ev('sum(1,2,3)'), 6);
  assert.equal(fmt('hypot(3,4)'), '5');
  assert.equal(fmt('logb(8,2)'), '3');
  assert.equal(fmt('log(1000)'), '3');
  assert.equal(fmt('ln(e)'), '1');
  assert.equal(fmt('tau/pi'), '2');
});

test('arity errors', () => {
  assert.ok(errOf('sin(1,2)') instanceof CalcError);
  assert.ok(errOf('atan2(1)') instanceof CalcError);
  assert.ok(errOf('min()') instanceof CalcError);
});

test('domain and arithmetic errors', () => {
  for (const s of ['sqrt(-1)', 'ln(0)', 'ln(-1)', 'log(0)', 'asin(2)', '1/0', '1%0', '10^400', 'nroot(-4,2)']) {
    assert.ok(errOf(s) instanceof CalcError, s);
  }
});

test('syntax error positions', () => {
  assert.equal(errOf('2 + * 3').position, 4);
  assert.equal(errOf('(1+2').position, 4);
  assert.equal(errOf('1 + $').position, 4);
  assert.equal(errOf('').position, 0);
});

test('angle modes', () => {
  const c = createCalculator({ angleMode: 'deg' });
  assert.equal(c.format(c.evaluate('sin(30)')), '0.5');
  assert.ok(Math.abs(c.evaluate('cos(90)')) < 1e-12);
  assert.ok(Math.abs(c.evaluate('sin(180)')) < 1e-12);
  assert.equal(c.format(c.evaluate('atan2(1,1)')), '45');
  assert.equal(c.format(c.evaluate('asin(1)')), '90');
  c.setAngleMode('rad');
  assert.equal(c.getAngleMode(), 'rad');
  assert.throws(() => c.setAngleMode('grad'), CalcError);
});

test('variables, constants and ans', () => {
  const c = createCalculator();
  assert.equal(c.evaluate('x = 4'), 4);
  assert.equal(c.evaluate('ans * x'), 16);
  assert.equal(c.getVariable('x'), 4);
  assert.equal(c.getVariable('nope'), undefined);
  assert.throws(() => c.evaluate('pi = 3'), CalcError);
  assert.throws(() => c.evaluate('ans = 3'), CalcError);
  assert.throws(() => c.evaluate('y + 1'), CalcError);
  c.setVariable('z', 2);
  assert.equal(c.evaluate('z * 3'), 6);
});

test('user functions, resolution at call time and recursion', () => {
  const c = createCalculator();
  assert.equal(c.evaluate('f(x,y) = x*y + k'), 'f(x,y)');
  c.evaluate('k = 1');
  assert.equal(c.evaluate('f(2,3)'), 7);
  assert.ok(errOf('f(1)', c) instanceof CalcError);
  c.evaluate('g(x) = g(x)');
  assert.ok(errOf('g(1)', c) instanceof CalcError);
  assert.throws(() => c.evaluate('sin(x) = x'), CalcError);
  assert.throws(() => c.evaluate('h(x,x) = x'), CalcError);
});

test('history, clear and format', () => {
  const c = createCalculator();
  c.evaluate('1+1');
  assert.throws(() => c.evaluate('1/0'));
  c.evaluate('f(x) = x');
  assert.deepEqual(c.history(), [
    { input: '1+1', result: 2 },
    { input: 'f(x) = x', result: 'f(x)' },
  ]);
  c.clear();
  assert.equal(c.history().length, 0);
  assert.equal(c.evaluate('ans'), 0);
  assert.equal(c.format(-0), '0');
  assert.equal(c.format(1 / 3), '0.333333333333');
  assert.equal(c.format(1e21), '1e+21');
});

test('REPL end-to-end', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const replPath = path.join(here, '..', 'src', 'repl.js');
  const input = ['1 + 2', '', 'x = 4', 'x * 2', ':deg', 'sin(30)', ':rad', 'f(a) = a^2', 'f(3)', '1/0', ':vars', ':history'].join('\n') + '\n';
  const out = execFileSync(process.execPath, [replPath], { input, encoding: 'utf8' });
  assert.equal(out, [
    '3', '4', '8', 'mode: deg', '0.5', 'mode: rad', 'f(a)', '9', 'Error: Division by zero',
    'x = 4', '1: 1 + 2 = 3', '2: x = 4 = 4', '3: x * 2 = 8', '4: sin(30) = 0.5', '5: f(a) = a^2 = f(a)', '6: f(3) = 9',
    '',
  ].join('\n'));
});
