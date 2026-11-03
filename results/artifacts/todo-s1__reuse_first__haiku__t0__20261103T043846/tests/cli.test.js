import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(here, '..', 'src', 'cli.js');

function cli(args, file) {
  return spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, TODO_FILE: file },
    encoding: 'utf8',
  });
}

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'todo-cli-')), 'todos.json');
}

test('add, list, done, rm flow', () => {
  const file = tmpFile();
  let r = cli(['add', 'Buy milk', '--due', '2026-03-01', '--priority', 'high', '--tag', 'home', '--tag', 'Shop'], file);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'Added #1: Buy milk\n');
  r = cli(['add', 'Walk dog'], file);
  assert.equal(r.stdout, 'Added #2: Walk dog\n');

  r = cli(['done', '1'], file);
  assert.equal(r.stdout, 'Completed #1\n');

  r = cli(['list'], file);
  assert.equal(r.stdout, '#1 [x] Buy milk\n#2 [ ] Walk dog\n');

  r = cli(['list', '--status', 'open'], file);
  assert.equal(r.stdout, '#2 [ ] Walk dog\n');

  r = cli(['list', '--tag', 'shop', '--sort', 'due'], file);
  assert.equal(r.stdout, '#1 [x] Buy milk\n');

  r = cli(['rm', '2'], file);
  assert.equal(r.stdout, 'Removed #2\n');

  r = cli(['add', 'Next'], file);
  assert.equal(r.stdout, 'Added #3: Next\n');
});

test('errors go to stderr with exit code 1', () => {
  const file = tmpFile();
  let r = cli(['add', 'x', '--due', '2026-13-01'], file);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^Error: /);

  r = cli(['done', '42'], file);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^Error: /);

  r = cli(['rm', 'abc'], file);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^Error: /);
});
