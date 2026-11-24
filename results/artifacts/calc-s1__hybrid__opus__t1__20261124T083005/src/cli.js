#!/usr/bin/env node
import { evaluate } from './calc.js';

try {
  const result = evaluate(process.argv[2]);
  process.stdout.write(String(result) + '\n');
  process.exitCode = 0;
} catch (err) {
  process.stderr.write(`Error: ${err && err.message ? err.message : String(err)}\n`);
  process.exitCode = 1;
}
