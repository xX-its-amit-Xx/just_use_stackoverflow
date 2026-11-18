#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { evaluate } from './calc.js';

export function run(argv) {
  try {
    const result = evaluate(argv[0] ?? '');
    return { code: 0, stdout: `${String(result)}\n`, stderr: '' };
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    return { code: 1, stdout: '', stderr: `Error: ${message}\n` };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { code, stdout, stderr } = run(process.argv.slice(2));
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  process.exitCode = code;
}
