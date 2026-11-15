#!/usr/bin/env node
import { evaluate } from './calc.js';

try {
  const args = process.argv.slice(2);
  if (args.length === 0) throw new Error('No expression given');
  const result = evaluate(args.join(' '));
  process.stdout.write(String(result) + '\n');
  process.exitCode = 0;
} catch (e) {
  process.stderr.write(`Error: ${e && e.message ? e.message : String(e)}\n`);
  process.exitCode = 1;
}
