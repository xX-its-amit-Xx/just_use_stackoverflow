#!/usr/bin/env node
import { evaluate, CalcError } from './calc.js';

const expr = process.argv[2];

try {
  const result = evaluate(expr);
  process.stdout.write(String(result) + '\n');
  process.exit(0);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}
