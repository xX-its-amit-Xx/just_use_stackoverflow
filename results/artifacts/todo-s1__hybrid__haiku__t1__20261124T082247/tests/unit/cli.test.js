import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/cli.js');

function run(args, file) {
  return spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, TODO_FILE: file },
    encoding: 'utf8',
  });
}

test('cli add/list/done/rm flow', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-')), 't.json');
  let r = run(['add', 'Buy', 'milk', '--due', '2030-01-01', '--priority', 'high', '--tag', 'Home'], file);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'Added #1: Buy milk\n');
  assert.equal(run(['done', '1'], file).stdout, 'Completed #1\n');
  assert.equal(run(['add', 'Second'], file).stdout, 'Added #2: Second\n');
  assert.equal(run(['list'], file).stdout, '#1 [x] Buy milk\n#2 [ ] Second\n');
  assert.equal(run(['list', '--status', 'open'], file).stdout, '#2 [ ] Second\n');
  assert.equal(run(['list', '--tag', 'home'], file).stdout, '#1 [x] Buy milk\n');
  assert.equal(run(['rm', '2'], file).stdout, 'Removed #2\n');
});

test('cli errors go to stderr with exit 1', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-')), 't.json');
  const r = run(['done', '42'], file);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^Error: /);
  const r2 = run(['add', '   '], file);
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /^Error: /);
});
