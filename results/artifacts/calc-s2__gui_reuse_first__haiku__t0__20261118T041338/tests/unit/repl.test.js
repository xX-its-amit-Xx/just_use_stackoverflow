import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createCalculator } from '../../src/calc.js';
import { handleLine } from '../../src/repl.js';

const here = dirname(fileURLToPath(import.meta.url));
const replPath = join(here, '..', '..', 'src', 'repl.js');

test('handleLine: results, errors, commands', () => {
  const c = createCalculator();
  assert.deepEqual(handleLine(c, '   '), []);
  assert.deepEqual(handleLine(c, '1/3'), ['0.333333333333']);
  assert.deepEqual(handleLine(c, 'f(x) = x^2'), ['f(x)']);
  assert.deepEqual(handleLine(c, '1/0'), ['Error: Division by zero']);
  assert.deepEqual(handleLine(c, ':deg'), ['mode: deg']);
  assert.deepEqual(handleLine(c, 'b = 2'), ['2']);
  assert.deepEqual(handleLine(c, 'a = 1.5'), ['1.5']);
  assert.deepEqual(handleLine(c, ':vars'), ['a = 1.5', 'b = 2']);
  assert.deepEqual(handleLine(c, ':history'), [
    '1: 1/3 = 0.333333333333',
    '2: f(x) = x^2 = f(x)',
    '3: b = 2 = 2',
    '4: a = 1.5 = 1.5',
  ]);
  assert.deepEqual(handleLine(c, ':rad'), ['mode: rad']);
});

test('process: stdin piped, state across lines, exit 0', () => {
  const input = '2^3^2\nx = 4\n\nans * x\n:deg\nsin(30)\n:vars\n1 + $\n:rad\n';
  const r = spawnSync(process.execPath, [replPath], { input, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout,
    '512\n4\n16\nmode: deg\n0.5\nx = 4\nError: Unexpected character \'$\'\nmode: rad\n');
});
