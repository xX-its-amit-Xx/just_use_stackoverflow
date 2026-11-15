#!/usr/bin/env node
import { evaluate } from './calc.js';

const expr = process.argv[2];

try {
  if (expr === undefined) {
    throw new Error('No expression given');
  }
  process.stdout.write(String(evaluate(expr)) + '\n');
  process.exitCode = 0;
} catch (err) {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exitCode = 1;
}
