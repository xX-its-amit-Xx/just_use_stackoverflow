import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
const APP = process.env.APP_DIR;
const { evaluate, CalcError } = await import(path.join(APP, 'src/calc.js'));
const ok = [
  ['1+2', 3], ['2*3+4', 10], ['2+3*4', 14], ['(2+3)*4', 20], ['10/4', 2.5], ['7%3', 1], ['-7 % 3', -1],
  ['2^10', 1024], ['2^3^2', 512], ['-2^2', -4], ['(-2)^2', 4], ['2^-1', 0.5], ['-3*-2', 6], ['+5', 5], ['--5', 5],
  ['3.14', 3.14], ['.5+.5', 1], ['5.*2', 10], ['1e3', 1000], ['2.5E-2', 0.025], ['  1 +\t2  ', 3],
  ['((((1))))', 1], ['(1+(2*(3+(4))))', 15], ['10-2-3', 5], ['100/10/2', 5], ['2*3%4', 2], ['1-1-1', -1],
  ['0.1+0.2', 0.1 + 0.2], ['4^0.5', 2], ['-(3+4)', -7], ['2*(3)', 6], ['1.5e1*2', 30], ['8/2*4', 16], ['2^2*3', 12],
];
for (const [e, v] of ok) test(`evaluate ${JSON.stringify(e)} = ${v}`, () => { assert.equal(evaluate(e), v); });
const bad = ['', '   ', '1+', '*2', '1 2', '(1+2', '1+2)', ')(', '2 $ 3', '1/0', '5%0', '10^400', 'abc', '1..2', '()', '3 + * 4', '1e', '(1)(2)'];
for (const e of bad) test(`rejects ${JSON.stringify(e)}`, () => { assert.throws(() => evaluate(e), CalcError); });
test('non-string input rejected', () => { assert.throws(() => evaluate(42), CalcError); assert.throws(() => evaluate(null), CalcError); });
test('CalcError is an Error with numeric position', () => {
  try { evaluate('1 + $'); assert.fail('should throw'); } catch (e) {
    assert.ok(e instanceof Error); assert.ok(e instanceof CalcError); assert.equal(typeof e.position, 'number'); assert.ok(e.position >= 0);
  }
});
test('unknown char position points at it', () => { try { evaluate('12 + #'); } catch (e) { assert.equal(e.position, 5); } });
test('no eval/Function used', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(path.join(APP, 'src/calc.js'), 'utf8');
  assert.ok(!/\beval\s*\(|new\s+Function\s*\(/.test(src));
});
test('CLI prints result', () => {
  const out = execFileSync(process.execPath, [path.join(APP, 'src/cli.js'), '2^3 + 1'], { encoding: 'utf8' });
  assert.equal(out, '9\n');
});
test('CLI error exit code', () => {
  const r = spawnSync(process.execPath, [path.join(APP, 'src/cli.js'), '1/0'], { encoding: 'utf8' });
  assert.equal(r.status, 1); assert.match(r.stderr, /^Error: /);
});
