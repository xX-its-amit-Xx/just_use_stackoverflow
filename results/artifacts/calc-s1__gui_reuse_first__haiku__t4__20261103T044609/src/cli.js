#!/usr/bin/env node
// CLI: node src/cli.js "<expr>"
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluate } from './calc.js';

function runCli(argv) {
  try {
    const result = evaluate(argv[2] ?? '');
    process.stdout.write(`${String(result)}\n`);
    process.exitCode = 0;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  }
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) runCli(process.argv);
