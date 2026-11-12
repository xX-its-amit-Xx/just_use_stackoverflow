#!/usr/bin/env node
import { evaluate, CalcError } from './calc.js';

const expr = process.argv[2];

try {
  const result = evaluate(expr === undefined ? '' : expr);
  process.stdout.write(String(result) + '\n');
  process.exitCode = 0;
} catch (err) {
  const message = err instanceof CalcError ? err.message : `Unexpected failure: ${err && err.message}`;
  process.stderr.write(`Error: ${message}\n`);
  process.exitCode = 1;
}
