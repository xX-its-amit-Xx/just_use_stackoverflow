#!/usr/bin/env node
// REPL for calc-s2. Reads one statement per line from stdin.
import readline from 'node:readline';
import { createCalculator } from './calc.js';

const calc = createCalculator();
const interactive = Boolean(process.stdin.isTTY);
const rl = readline.createInterface({ input: process.stdin, output: interactive ? process.stdout : undefined, terminal: interactive });
const out = (s) => process.stdout.write(s + '\n');
const fmt = (v) => (typeof v === 'number' ? calc.format(v) : String(v));

function handle(line) {
  const s = line.trim();
  if (!s) return;
  if (s.startsWith(':')) {
    switch (s) {
      case ':deg': calc.setAngleMode('deg'); out('mode: deg'); return;
      case ':rad': calc.setAngleMode('rad'); out('mode: rad'); return;
      case ':vars':
        for (const [k, v] of calc.variables()) out(`${k} = ${fmt(v)}`);
        return;
      case ':history':
        calc.history().forEach((h, i) => out(`${i + 1}: ${h.input} = ${fmt(h.result)}`));
        return;
      default:
        out('Error: Unknown command: ' + s);
        return;
    }
  }
  try {
    out(fmt(calc.evaluate(s)));
  } catch (e) {
    out('Error: ' + (e && e.message ? e.message : String(e)));
  }
}

if (interactive) { rl.setPrompt('> '); rl.prompt(); }
rl.on('line', (line) => { handle(line); if (interactive) rl.prompt(); });
rl.on('close', () => { process.exitCode = 0; });
