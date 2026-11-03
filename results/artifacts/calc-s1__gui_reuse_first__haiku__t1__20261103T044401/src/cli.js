#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluate } from './calc.js';

export function main(argv, out = process.stdout, err = process.stderr) {
  try {
    const result = evaluate(argv[0]);
    out.write(`${String(result)}\n`);
    return 0;
  } catch (e) {
    err.write(`Error: ${e && e.message ? e.message : String(e)}\n`);
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
