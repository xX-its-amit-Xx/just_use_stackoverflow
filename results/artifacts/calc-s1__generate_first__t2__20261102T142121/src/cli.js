#!/usr/bin/env node
import { evaluate, CalcError } from './calc.js';
try {
  console.log(String(evaluate(process.argv[2] ?? '')));
} catch (e) {
  if (e instanceof CalcError) { console.error(`Error: ${e.message}`); process.exit(1); }
  throw e;
}
