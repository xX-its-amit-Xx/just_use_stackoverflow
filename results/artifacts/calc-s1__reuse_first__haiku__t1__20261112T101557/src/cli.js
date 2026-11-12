#!/usr/bin/env node
import { evaluate } from './calc.js';

const expr = process.argv.slice(2).join(' ');

try {
  const result = evaluate(expr);
  process.stdout.write(`${String(result)}\n`);
  process.exit(0);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(`Error: ${message}\n`);
  process.exit(1);
}
