#!/usr/bin/env node
import { evaluate } from './calc.js';

try {
  const expr = process.argv[2];
  if (expr === undefined) throw new Error('No expression provided');
  process.stdout.write(String(evaluate(expr)) + '\n');
  process.exitCode = 0;
} catch (e) {
  process.stderr.write(`Error: ${e && e.message ? e.message : String(e)}\n`);
  process.exitCode = 1;
}
