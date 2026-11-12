import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, '../../src/cli.js');

function cliRun(file, args) {
  return spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, TODO_FILE: file },
    encoding: 'utf-8',
  });
}

test('cli add / list / done / rm', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'todo-cli-')), 'todos.json');
  let r = cliRun(file, ['add', 'Buy milk', '--due', '2026-05-01', '--priority', 'high', '--tag', 'home']);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, 'Added #1: Buy milk\n');
  r = cliRun(file, ['add', 'Walk dog', '--tag=pets']);
  assert.equal(r.stdout, 'Added #2: Walk dog\n');
  r = cliRun(file, ['done', '1']);
  assert.equal(r.stdout, 'Completed #1\n');
  r = cliRun(file, ['list']);
  assert.equal(r.stdout, '#1 [x] Buy milk\n#2 [ ] Walk dog\n');
  r = cliRun(file, ['list', '--status', 'open']);
  assert.equal(r.stdout, '#2 [ ] Walk dog\n');
  r = cliRun(file, ['list', '--tag', 'home']);
  assert.equal(r.stdout, '#1 [x] Buy milk\n');
  r = cliRun(file, ['rm', '2']);
  assert.equal(r.stdout, 'Removed #2\n');
  r = cliRun(file, ['add', 'After rm']);
  assert.equal(r.stdout, 'Added #3: After rm\n');
});

test('cli errors go to stderr with exit code 1', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'todo-cli-')), 'todos.json');
  for (const args of [['done', '42'], ['add', '   '], ['add', 'x', '--due', 'nope'], ['rm', 'abc']]) {
    const r = cliRun(file, args);
    assert.equal(r.status, 1, args.join(' '));
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^Error: .+\n$/);
  }
});
