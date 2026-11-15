#!/usr/bin/env node
// calc-s2 REPL: reads one statement per line from stdin.
import { createInterface } from 'node:readline';
import { createCalculator } from './calc.js';

export function runLine(c, raw) {
  const line = raw.trim();
  if (line === '') return [];
  if (line.startsWith(':')) {
    switch (line) {
      case ':deg': c.setAngleMode('deg'); return ['mode: deg'];
      case ':rad': c.setAngleMode('rad'); return ['mode: rad'];
      case ':vars':
        return [...c.variables().entries()]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => `${k} = ${c.format(v)}`);
      case ':history':
        return c.history().map((h, i) => `${i + 1}: ${h.input} = ${typeof h.result === 'number' ? c.format(h.result) : h.result}`);
      default:
        return [`Error: Unknown command "${line}"`];
    }
  }
  try {
    const r = c.evaluate(line);
    return [typeof r === 'number' ? c.format(r) : r];
  } catch (e) {
    return [`Error: ${e.message}`];
  }
}

export async function main(input = process.stdin, output = process.stdout) {
  const c = createCalculator();
  const interactive = Boolean(input.isTTY);
  const rl = createInterface({ input, output: interactive ? output : undefined, terminal: interactive });
  if (interactive) { rl.setPrompt('> '); rl.prompt(); }
  for await (const line of rl) {
    for (const out of runLine(c, line)) output.write(out + '\n');
    if (interactive) rl.prompt();
  }
}

import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
const self = fileURLToPath(import.meta.url);
let invoked = false;
try { invoked = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(self); } catch { invoked = false; }
if (invoked) {
  main().then(() => { process.exitCode = 0; });
}
