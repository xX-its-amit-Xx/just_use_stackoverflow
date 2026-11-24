#!/usr/bin/env node
// Line-oriented REPL for the calculator engine.
import readline from 'node:readline';
import { createCalculator } from './calc.js';

const calc = createCalculator();
const interactive = Boolean(process.stdin.isTTY);
const rl = readline.createInterface({
  input: process.stdin,
  output: interactive ? process.stdout : undefined,
  terminal: interactive,
});

const out = (s) => process.stdout.write(s + '\n');
const show = (r) => (typeof r === 'number' ? calc.format(r) : String(r));

function handle(line) {
  const input = line.trim();
  if (input === '') return;
  if (input.startsWith(':')) {
    switch (input) {
      case ':deg': calc.setAngleMode('deg'); out('mode: deg'); return;
      case ':rad': calc.setAngleMode('rad'); out('mode: rad'); return;
      case ':vars': {
        const vars = [...calc.variables().entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
        for (const [k, v] of vars) out(`${k} = ${calc.format(v)}`);
        return;
      }
      case ':history':
        calc.history().forEach((h, i) => out(`${i + 1}: ${h.input} = ${show(h.result)}`));
        return;
      default:
        out(`Error: Unknown command '${input}'`);
        return;
    }
  }
  try {
    out(show(calc.evaluate(input)));
  } catch (e) {
    out(`Error: ${e && e.message ? e.message : String(e)}`);
  }
}

if (interactive) { rl.setPrompt('> '); rl.prompt(); }
rl.on('line', (line) => { handle(line); if (interactive) rl.prompt(); });
rl.on('close', () => { process.exitCode = 0; });
