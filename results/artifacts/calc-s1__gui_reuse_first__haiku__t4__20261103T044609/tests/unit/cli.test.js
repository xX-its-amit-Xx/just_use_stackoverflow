import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../src/cli.js', import.meta.url));

function run(...args) {
  return spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
}

test('cli prints result and exits 0', () => {
  const r = run('1 + 2 * 3');
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '7\n');
  assert.equal(r.stderr, '');
});

test('cli prints default String() formatting', () => {
  assert.equal(run('1/3').stdout, `${1 / 3}\n`);
  assert.equal(run('2^-1').stdout, '0.5\n');
});

test('cli reports errors on stderr and exits 1', () => {
  const r = run('1 +');
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^Error: .+\n$/);
});

test('cli with no argument reports an error', () => {
  const r = run();
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^Error: /);
});
