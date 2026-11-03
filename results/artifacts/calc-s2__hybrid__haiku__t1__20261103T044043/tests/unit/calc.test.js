import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createCalculator, CalcError } from '../../src/calc.js';

const ev = (c, s) => c.evaluate(s);
const fmt = (c, s) => c.format(c.evaluate(s));
const errOf = (c, s) => {
  try { c.evaluate(s); } catch (e) { return e; }
  assert.fail(`expected error for ${s}`);
};

test('precedence and associativity', () => {
  const c = createCalculator();
  assert.equal(ev(c, '2^3^2'), 512);
  assert.equal(ev(c, '-2^2'), -4);
  assert.equal(ev(c, '-3!'), -6);
  assert.equal(ev(c, '2^-1'), 0.5);
  assert.equal(ev(c, '6/2(1+2)'), 1);
  assert.equal(ev(c, '(1+1)(2+2)'), 8);
  assert.equal(ev(c, '2 sin(0)'), 0);
  assert.equal(ev(c, '5%3'), 2);
  assert.equal(ev(c, '-7%3'), -1);
});

test('number literals', () => {
  const c = createCalculator();
  assert.equal(ev(c, '0x1F'), 31);
  assert.equal(ev(c, '0b101'), 5);
  assert.equal(ev(c, '.5'), 0.5);
  assert.equal(ev(c, '1e-3'), 0.001);
  assert.equal(ev(c, '2.5E+4'), 25000);
});

test('builtins', () => {
  const c = createCalculator();
  assert.equal(ev(c, 'round(-2.5)'), -3);
  assert.equal(ev(c, 'nroot(-8,3)'), -2);
  assert.equal(ev(c, 'logb(8,2)'), 3);
  assert.equal(ev(c, 'min(3,1,2)'), 1);
  assert.equal(ev(c, 'avg(1,2,3,4)'), 2.5);
  assert.equal(ev(c, 'hypot(3,4)'), 5);
  assert.equal(ev(c, '3!'), 6);
});

test('deg mode exactness', () => {
  const c = createCalculator({ angleMode: 'deg' });
  assert.equal(fmt(c, 'sin(30)'), '0.5');
  assert.ok(Math.abs(ev(c, 'cos(90)')) < 1e-12);
  assert.ok(Math.abs(ev(c, 'sin(180)')) < 1e-12);
  assert.equal(ev(c, 'asin(1)'), 90);
});

test('domain and syntax errors', () => {
  const c = createCalculator();
  for (const s of ['sqrt(-1)', 'ln(0)', 'ln(-1)', 'log(0)', 'asin(2)', '1/0', '5%0', '171!', '(-2)!', '2.5!', '2^1024']) {
    assert.ok(errOf(c, s) instanceof CalcError, s);
  }
  assert.equal(errOf(c, '2 + * 3').position, 4);
  assert.equal(errOf(c, '(1+2').position, 4);
  assert.equal(errOf(c, '1 + $').position, 4);
});

test('variables, ans and constants', () => {
  const c = createCalculator();
  ev(c, 'x = 4');
  assert.equal(ev(c, 'ans * x'), 16);
  assert.equal(c.getVariable('x'), 4);
  assert.equal(c.getVariable('nope'), undefined);
  assert.throws(() => ev(c, 'pi = 3'), CalcError);
  assert.throws(() => ev(c, 'ans = 3'), CalcError);
  assert.equal(ev(c, 'tau'), 2 * Math.PI);
});

test('user functions, recursion and call-time name resolution', () => {
  const c = createCalculator();
  assert.equal(ev(c, 'f(x,y)=x*y+z'), 'f(x,y)');
  ev(c, 'z = 1');
  assert.equal(ev(c, 'f(2,3)'), 7);
  assert.throws(() => ev(c, 'f(1)'), CalcError);
  assert.throws(() => ev(c, 'sin(x)=x'), CalcError);
  assert.throws(() => ev(c, 'g(x,x)=1'), CalcError);
  ev(c, 'r(n)=r(n)+1');
  assert.throws(() => ev(c, 'r(1)'), /recursion/i);
});

test('history, vars and clear', () => {
  const c = createCalculator();
  ev(c, '1+1');
  ev(c, 'f(x)=x');
  assert.throws(() => ev(c, '1/0'));
  assert.deepEqual(c.history(), [
    { input: '1+1', result: 2 },
    { input: 'f(x)=x', result: 'f(x)' },
  ]);
  c.setVariable('b', 2);
  ev(c, 'a = 1');
  assert.deepEqual(c.variables(), [{ name: 'a', value: 1 }, { name: 'b', value: 2 }]);
  c.setAngleMode('deg');
  c.clear();
  assert.equal(c.getVariable('a'), undefined);
  assert.equal(c.getVariable('ans'), 0);
  assert.equal(c.history().length, 0);
  assert.equal(c.getAngleMode(), 'deg');
  assert.throws(() => c.setAngleMode('grad'), CalcError);
});

test('format strips zeros and -0 becomes 0', () => {
  const c = createCalculator();
  assert.equal(c.format(-0), '0');
  assert.equal(c.format(1 / 3), '0.333333333333');
  assert.equal(c.format(2.5), '2.5');
});

test('repl processes stdin', () => {
  const repl = fileURLToPath(new URL('../../src/repl.js', import.meta.url));
  const out = execFileSync(process.execPath, [repl], {
    input: '2+3\n\nx = 4\n:deg\nsin(30)\n:rad\nf(a)=a*x\n1/0\n:vars\n:history\n',
    encoding: 'utf8',
  });
  assert.equal(out, [
    '5', '4', 'mode: deg', '0.5', 'mode: rad', 'f(a)', 'Error: Division by zero',
    'x = 4',
    '1: 2+3 = 5', '2: x = 4 = 4', '3: sin(30) = 0.5', '4: f(a)=a*x = f(a)',
  ].join('\n') + '\n');
});
