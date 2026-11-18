#!/usr/bin/env node
// CLI: node src/cli.js "<expr>"
// Argument handling pattern adapted from node-calc's bin/cli.js (MIT, hkh12/heokhe).
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { evaluate, CalcError } from './calc.js';

/**
 * Run the CLI with the given argument list (without node and script path).
 * Returns the process exit code.
 * @param {string[]} args
 * @param {{stdout: {write: Function}, stderr: {write: Function}}} io
 */
export function main(args, io = { stdout: process.stdout, stderr: process.stderr }) {
  if (args.length === 0) {
    io.stderr.write('Error: usage: node src/cli.js "<expr>"\n');
    return 1;
  }
  try {
    const result = evaluate(args.join(' '));
    io.stdout.write(`${String(result)}\n`);
    return 0;
  } catch (err) {
    const message = err instanceof CalcError ? err.message : `internal error: ${err && err.message}`;
    io.stderr.write(`Error: ${message}\n`);
    return 1;
  }
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exitCode = main(process.argv.slice(2));
}
