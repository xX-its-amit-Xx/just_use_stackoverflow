import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const cli = path.resolve(here, '../../src/cli.js');

function runCli(args, file) {
  return spawnSync(process.execPath, [cli, ...args], {
    env: { ...process.env, TODO_FILE: file },
    encoding: 'utf8',
  });
}

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'todo-cli-')), 'todos.json');
}

test('add, list, done, rm flow', () => {
  const file = tmpFile();
  let r = runCli(['add', 'Buy milk', '--due', '2030-01-02', '--priority', 'high', '--tag', 'home'], file);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'Added #1: Buy milk\n');

  r = runCli(['add', 'Call mum'], file);
  assert.equal(r.stdout, 'Added #2: Call mum\n');

  r = runCli(['done', '1'], file);
  assert.equal(r.stdout, 'Completed #1\n');

  r = runCli(['list'], file);
  assert.equal(r.stdout, '#1 [x] Buy milk\n#2 [ ] Call mum\n');

  r = runCli(['list', '--status', 'open'], file);
  assert.equal(r.stdout, '#2 [ ] Call mum\n');

  r = runCli(['rm', '2'], file);
  assert.equal(r.stdout, 'Removed #2\n');

  r = runCli(['list', '--tag', 'home', '--sort', 'due'], file);
  assert.equal(r.stdout, '#1 [x] Buy milk\n');
});

test('errors go to stderr with Error prefix and exit 1', () => {
  const file = tmpFile();
  let r = runCli(['done', '42'], file);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /^Error: /);

  r = runCli(['add', '   '], file);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^Error: /);

  r = runCli(['add', 'x', '--due', '2024-13-01'], file);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /^Error: /);
});

test('TODO_FILE env is honoured for persistence', () => {
  const file = tmpFile();
  runCli(['add', 'persisted'], file);
  assert.ok(fs.existsSync(file));
  const data = fs.readFileSync(file, 'utf8');
  assert.match(data, /persisted/);
  assert.equal(execFileSync(process.execPath, [cli, 'list'], {
    env: { ...process.env, TODO_FILE: file },
    encoding: 'utf8',
  }), '#1 [ ] persisted\n');
});
