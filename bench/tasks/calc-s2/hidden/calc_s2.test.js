import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const APP = process.env.APP_DIR;
const { createCalculator, CalcError } = await import(path.join(APP, 'src/calc.js'));
const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} != ${b}`);
const E = (s, c = createCalculator()) => c.evaluate(s);
const cases = [
  ['1+2*3', 7], ['(1+2)*3', 9], ['2^3^2', 512], ['-2^2', -4], ['2^-1', 0.5], ['-3!', -6], ['3!', 6], ['0!', 1], ['3!^2', 36], ['2^3!', 64],
  ['10 % 4', 2], ['-7 % 3', -1], ['0x1F', 31], ['0b101', 5], ['1e-3', 0.001], ['2.5E+4', 25000], ['.5*4', 2],
  ['2pi', 2 * Math.PI], ['2(3+1)', 8], ['(1+1)(2+2)', 8], ['6/2(1+2)', 1], ['2 sin(0)', 0], ['tau', 2 * Math.PI], ['e', Math.E],
  ['sqrt(16)', 4], ['cbrt(-27)', -3], ['abs(-5)', 5], ['ln(e)', 1], ['log(1000)', 3], ['log2(8)', 3], ['exp(0)', 1],
  ['floor(-2.5)', -3], ['ceil(2.1)', 3], ['round(2.5)', 3], ['round(-2.5)', -3], ['sign(-4)', -1],
  ['atan2(1, 1)', Math.PI / 4], ['pow(2, 10)', 1024], ['nroot(27, 3)', 3], ['nroot(-8, 3)', -2], ['logb(81, 3)', 4],
  ['min(3, 1, 2)', 1], ['max(3, 1, 2)', 3], ['sum(1,2,3,4)', 10], ['avg(2, 4)', 3], ['hypot(3, 4)', 5], ['max(5)', 5],
  ['sinh(0)', 0], ['cosh(0)', 1], ['tanh(0)', 0], ['sin(pi/2)', 1], ['acos(1)', 0],
];
for (const [s, v] of cases) test(`eval ${s}`, () => close(E(s), v));
const errs = ['sqrt(-1)', 'ln(0)', 'ln(-1)', 'log(0)', 'asin(2)', '1/0', '5%0', '10^400', '(-1)!', '2.5!', '171!', 'foo', 'sin()', 'sin(1,2)', 'atan2(1)', 'min()',
  '2 +', '(1+2', '1+2)', '1 $ 2', 'pi = 3', 'e = 1', 'ans = 2', 'sin(x) = x', 'f(x, x) = x', 'undefinedfn(2)', ''];
for (const s of errs) test(`error ${JSON.stringify(s)}`, () => assert.throws(() => E(s), CalcError));
test('error positions', () => {
  const pos = s => { try { E(s); } catch (e) { return e.position; } return 'no-throw'; };
  assert.equal(pos('2 + * 3'), 4); assert.equal(pos('(1+2'), 4); assert.equal(pos('1 + $'), 4);
});
test('variables, ans, implicit with variables', () => {
  const c = createCalculator();
  assert.equal(c.evaluate('x = 2'), 2); assert.equal(c.evaluate('3x'), 6); assert.equal(c.evaluate('ans + 1'), 7);
  assert.equal(c.evaluate('1/2x'), 0.25); assert.equal(c.getVariable('x'), 2); c.setVariable('y', 10); assert.equal(c.evaluate('y/x'), 5);
  assert.equal(c.getVariable('nope'), undefined);
});
test('ans starts at 0', () => { assert.equal(createCalculator().evaluate('ans + 1'), 1); });
test('user functions', () => {
  const c = createCalculator();
  assert.equal(c.evaluate('f(x) = x^2 + 1'), 'f(x)'); assert.equal(c.evaluate('f(3)'), 10);
  assert.equal(c.evaluate('g(a, b) = f(a) * b'), 'g(a,b)'); assert.equal(c.evaluate('g(2, 3)'), 15);
  c.evaluate('k = 5'); c.evaluate('h(x) = x + k'); assert.equal(c.evaluate('h(1)'), 6); c.evaluate('k = 10'); assert.equal(c.evaluate('h(1)'), 11);
  c.evaluate('f(x) = 2x'); assert.equal(c.evaluate('f(3)'), 6);
  assert.throws(() => c.evaluate('f(1, 2)'), CalcError);
  c.evaluate('r(x) = r(x) + 1'); assert.throws(() => c.evaluate('r(1)'), CalcError);
});
test('degree mode', () => {
  const c = createCalculator({ angleMode: 'deg' });
  assert.equal(c.getAngleMode(), 'deg');
  assert.equal(c.format(c.evaluate('sin(30)')), '0.5'); assert.ok(Math.abs(c.evaluate('cos(90)')) < 1e-12); assert.ok(Math.abs(c.evaluate('sin(180)')) < 1e-12);
  close(c.evaluate('asin(1)'), 90); close(c.evaluate('atan2(1, 1)'), 45); close(c.evaluate('tan(45)'), 1);
  c.setAngleMode('rad'); close(c.evaluate('sin(pi/6)'), 0.5);
  assert.throws(() => c.setAngleMode('grad'), CalcError);
});
test('history and clear', () => {
  const c = createCalculator(); c.evaluate('1+1'); try { c.evaluate('1/0'); } catch {} c.evaluate('x = 3');
  assert.deepEqual(c.history(), [{ input: '1+1', result: 2 }, { input: 'x = 3', result: 3 }]);
  c.setAngleMode('deg'); c.clear(); assert.deepEqual(c.history(), []); assert.equal(c.getVariable('x'), undefined);
  assert.equal(c.evaluate('ans'), 0); assert.equal(c.getAngleMode(), 'deg');
});
test('format', () => {
  const c = createCalculator(); assert.equal(c.format(0.1 + 0.2), '0.3'); assert.equal(c.format(-0), '0'); assert.equal(c.format(1 / 3), '0.333333333333');
  assert.equal(createCalculator({ precision: 3 }).format(Math.PI), '3.14'); assert.equal(c.format(1e21), '1e+21');
});
test('builtin names cannot be redefined', () => { assert.throws(() => E('sqrt(x) = x'), CalcError); });
test('no eval', async () => { const fs = await import('node:fs'); const src = fs.readdirSync(path.join(APP, 'src')).filter(f => f.endsWith('.js')).map(f => fs.readFileSync(path.join(APP, 'src', f), 'utf8')).join('\n'); assert.ok(!/\beval\s*\(|new\s+Function\s*\(/.test(src)); });
test('REPL', () => {
  const input = ['1 + 2', '', 'x = 0.1 + 0.2', 'f(a) = a*2', 'f(x)', '1/0', ':deg', 'sin(30)', ':vars', ':history'].join('\n') + '\n';
  const r = spawnSync(process.execPath, [path.join(APP, 'src/repl.js')], { input, encoding: 'utf8' });
  assert.equal(r.status, 0);
  const lines = r.stdout.trim().split('\n').map(s => s.replace(/^> ?/, '')).filter(Boolean);
  assert.deepEqual(lines.slice(0, 7), ['3', '0.3', 'f(a)', '0.6', lines[4].startsWith('Error: ') ? lines[4] : 'Error: <expected>', 'mode: deg', '0.5']);
  assert.ok(lines.includes('x = 0.3'));
  assert.ok(lines.some(l => /^1: 1 \+ 2 = 3$/.test(l)));
  assert.ok(lines.some(l => /^\d+: sin\(30\) = 0\.5$/.test(l)));
});
