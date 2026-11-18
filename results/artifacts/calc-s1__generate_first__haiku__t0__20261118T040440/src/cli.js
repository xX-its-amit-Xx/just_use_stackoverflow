#!/usr/bin/env node
import { evaluate, CalcError } from './calc.js';

const expr = process.argv[2];
try {
  if (expr === undefined) {
    throw new CalcError('No expression given', 0);
  }
  process.stdout.write(String(evaluate(expr)) + '\n');
  process.exitCode = 0;
} catch (err) {
  const message = err instanceof CalcError ? err.message : String(err && err.message);
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
}
