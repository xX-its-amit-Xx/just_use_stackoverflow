import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repl = join(here, '..', '..', 'src', 'repl.js');

test('repl processes stdin lines and exits 0', () => {
  const input = [
    '1 + 2',
    '',
    'x = 4',
    'ans * x',
    'f(a)=a^2',
    'f(3)',
    '1/0',
    '2 + * 3',
    ':deg',
    'sin(30)',
    ':rad',
    ':vars',
    ':history',
    '',
  ].join('\n');
  const r = spawnSync(process.execPath, [repl], { input, encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, [
    '3',
    '4',
    '16',
    'f(a)',
    '9',
    'Error: Division by zero',
    "Error: Unexpected '*'",
    'mode: deg',
    '0.5',
    'mode: rad',
    'x = 4',
    '1: 1 + 2 = 3',
    '2: x = 4 = 4',
    '3: ans * x = 16',
    '4: f(a)=a^2 = f(a)',
    '5: f(3) = 9',
    '6: sin(30) = 0.5',
    '',
  ].join('\n'));
});
