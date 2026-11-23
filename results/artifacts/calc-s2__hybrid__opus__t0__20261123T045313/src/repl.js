#!/usr/bin/env node
import readline from 'node:readline';
import { createCalculator } from './calc.js';

const c = createCalculator();
const tty = Boolean(process.stdin.isTTY);
const rl = readline.createInterface({ input: process.stdin, output: tty ? process.stdout : undefined, terminal: tty });
const out = (s) => process.stdout.write(s + '\n');
const fmt = (r) => (typeof r === 'number' ? c.format(r) : String(r));

function handle(line) {
  const s = line.trim();
  if (!s) return;
  if (s.startsWith(':')) {
    switch (s) {
      case ':deg': c.setAngleMode('deg'); out('mode: deg'); return;
      case ':rad': c.setAngleMode('rad'); out('mode: rad'); return;
      case ':vars': for (const [k, v] of c.variables()) out(`${k} = ${c.format(v)}`); return;
      case ':history': c.history().forEach((h, i) => out(`${i + 1}: ${h.input} = ${fmt(h.result)}`)); return;
      default: out(`Error: Unknown command '${s}'`); return;
    }
  }
  try { out(fmt(c.evaluate(s))); } catch (e) { out(`Error: ${e.message}`); }
}

if (tty) { rl.setPrompt('> '); rl.prompt(); }
rl.on('line', (line) => { handle(line); if (tty) rl.prompt(); });
rl.on('close', () => { process.exitCode = 0; });
