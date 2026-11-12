#!/usr/bin/env node
import { evaluate } from './calc.js';

try {
  const result = evaluate(process.argv[2]);
  process.stdout.write(String(result) + '\n');
  process.exit(0);
} catch (e) {
  process.stderr.write(`Error: ${e && e.message ? e.message : String(e)}\n`);
  process.exit(1);
}
