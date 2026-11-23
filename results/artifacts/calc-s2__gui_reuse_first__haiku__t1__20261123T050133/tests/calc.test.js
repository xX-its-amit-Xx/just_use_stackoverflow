import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCalculator, CalcError } from '../src/calc.js';

const ev = (c, s) => c.evaluate(s);
const fmt = (c, s) => c.format(ev(c, s));
const err = (c, s) => {
  try { c.evaluate(s); } catch (e) { return e; }
  assert.fail(`expected error for ${s}`);
};

test('precedence and associativity', () => {
  const c = createCalculator();
  assert.equal(ev(c, '2^3^2'), 512);
  assert.equal(ev(c, '2^-1'), 0.5);
  assert.equal(ev(c, '-2^2'), -4);
  assert.equal(ev(c, '-3!'), -6);
  assert.equal(ev(c, '1 + 2 * 3'), 7);
  assert.equal(ev(c, '10 % 4'), 2);
  assert.equal(ev(c, '10 - 4 - 3'), 3);
  assert.equal(ev(c, '0 + 0x1F + 0b101'), 36);
  assert.equal(ev(c, '.5 + 1e-3 + 2.5E+1'), 25.501);
});

test('implicit multiplication', () => {
  const c = createCalculator();
  assert.equal(fmt(c, '2pi'), '6.28318530718');
  assert.equal(ev(c, '6/2(1+2)'), 1);
  c.evaluate('x = 2');
  assert.equal(ev(c, '1/2x'), 0.25);
  assert.equal(ev(c, '3x'), 6);
  assert.equal(ev(c, '(1+1)(2+2)'), 8);
  assert.equal(ev(c, '2 sin(0)'), 0);
});

test('assignment, ans, constants', () => {
  const c = createCalculator();
  assert.equal(c.evaluate('x = 4'), 4);
  assert.equal(ev(c, 'ans * x'), 16);
  assert.equal(c.getVariable('x'), 4);
  assert.equal(c.getVariable('nope'), undefined);
  assert.equal(err(c, 'pi = 3').constructor, CalcError);
  assert.equal(err(c, 'ans = 3').constructor, CalcError);
  assert.equal(c.getVariable('x'), 4);
});

test('failed assignment does not change state', () => {
  const c = createCalculator();
  c.evaluate('x = 1');
  assert.throws(() => c.evaluate('x = 1/0'), CalcError);
  assert.equal(c.getVariable('x'), 1);
  assert.equal(c.evaluate('ans'), 1);
});

test('syntax error positions', () => {
  const c = createCalculator();
  assert.equal(err(c, '2 + * 3').position, 4);
  assert.equal(err(c, '(1+2').position, 4);
  assert.equal(err(c, '1 + $').position, 4);
});

test('domain and arity errors', () => {
  const c = createCalculator();
  for (const s of ['sqrt(-1)', 'ln(0)', 'ln(-1)', 'log(0)', 'asin(2)', '1/0', '1%0',
    '(-1)!', '2.5!', '171!', 'sin()', 'sin(1,2)', 'nroot(-4,2)', 'exp(1000)', 'nosuch(1)',
    'min()', 'q', '5 5']) {
    assert.throws(() => c.evaluate(s), CalcError, s);
  }
});

test('built-in functions', () => {
  const c = createCalculator();
  assert.equal(ev(c, 'round(-2.5)'), -3);
  assert.equal(ev(c, 'nroot(-8,3)'), -2);
  assert.equal(fmt(c, 'logb(8,2)'), '3');
  assert.equal(ev(c, 'atan2(1,1)'), Math.PI / 4);
  assert.equal(ev(c, 'pow(2,10)'), 1024);
  assert.equal(ev(c, 'min(3,1,2)'), 1);
  assert.equal(ev(c, 'max(3,1,2)'), 3);
  assert.equal(ev(c, 'sum(1,2,3)'), 6);
  assert.equal(ev(c, 'avg(1,2,3)'), 2);
  assert.equal(ev(c, 'hypot(3,4)'), 5);
  assert.equal(ev(c, 'sign(-7)'), -1);
  assert.equal(ev(c, '5!'), 120);
  assert.equal(ev(c, '0!'), 1);
});

test('degree mode', () => {
  const c = createCalculator({ angleMode: 'deg' });
  assert.equal(fmt(c, 'sin(30)'), '0.5');
  assert.ok(Math.abs(ev(c, 'cos(90)')) < 1e-12);
  assert.ok(Math.abs(ev(c, 'sin(180)')) < 1e-12);
  assert.equal(fmt(c, 'asin(1)'), '90');
  assert.equal(fmt(c, 'atan2(1,1)'), '45');
  c.setAngleMode('rad');
  assert.equal(c.getAngleMode(), 'rad');
  assert.throws(() => c.setAngleMode('grad'), CalcError);
});

test('user functions and recursion', () => {
  const c = createCalculator();
  assert.equal(ev(c, 'f(x,y) = x*y + z'), 'f(x,y)' );
  c.evaluate('z = 1');
  assert.equal(ev(c, 'f(2,3)'), 7);
  assert.throws(() => c.evaluate('f(1)'), CalcError);
  assert.throws(() => c.evaluate('sin(x) = x'), CalcError);
  assert.throws(() => c.evaluate('g() = 1'), CalcError);
  assert.throws(() => c.evaluate('h(a,a) = 1'), CalcError);
  c.evaluate('r(n) = r(n)');
  assert.throws(() => c.evaluate('r(1)'), CalcError);
  c.evaluate('a(n) = b(n)');
  c.evaluate('b(n) = a(n)');
  assert.throws(() => c.evaluate('a(1)'), CalcError);
  assert.equal(c.evaluate('k(x) = x+1'), 'k(x)');
  assert.equal(c.evaluate('k(x) = x+2'), 'k(x)');
  assert.equal(ev(c, 'k(1)'), 3);
});

test('history and clear', () => {
  const c = createCalculator();
  c.evaluate('1+1');
  assert.throws(() => c.evaluate('1/0'));
  c.evaluate('f(x) = x');
  c.evaluate('y = 3');
  assert.deepEqual(c.history(), [
    { input: '1+1', result: 2 },
    { input: 'f(x) = x', result: 'f(x)' },
    { input: 'y = 3', result: 3 },
  ]);
  c.setAngleMode('deg');
  c.clear();
  assert.deepEqual(c.history(), []);
  assert.equal(c.getVariable('y'), undefined);
  assert.equal(c.evaluate('ans'), 0);
  assert.equal(c.getAngleMode(), 'deg');
  assert.throws(() => c.evaluate('f(1)'), CalcError);
});

test('format', () => {
  const c = createCalculator();
  assert.equal(c.format(-0), '0');
  assert.equal(c.format(1 / 3), '0.333333333333');
  assert.equal(c.format(100), '100');
  assert.equal(createCalculator({ precision: 3 }).format(1234.5), '1230');
});

test('REPL end to end', () => {
  const repl = fileURLToPath(new URL('../src/repl.js', import.meta.url));
  const input = [
    '2^3^2', '', 'x = 4', 'ans * x', ':deg', 'sin(30)', 'f(a) = a*2', 'f(3)',
    '1/0', ':vars', ':history', ':rad',
  ].join('\n') + '\n';
  const out = execFileSync(process.execPath, [repl], { input, encoding: 'utf8' });
  assert.equal(out, [
    '512',
    '4',
    '16',
    'mode: deg',
    '0.5',
    'f(a)',
    '6',
    'Error: Division by zero',
    'x = 4',
    '1: 2^3^2 = 512',
    '2: x = 4 = 4',
    '3: ans * x = 16',
    '4: sin(30) = 0.5',
    '5: f(a) = a*2 = f(a)',
    '6: f(3) = 6',
    'mode: rad',
    '',
  ].join('\n'));
});
