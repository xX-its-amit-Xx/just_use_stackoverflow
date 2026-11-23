#!/usr/bin/env node
import readline from 'node:readline';
import { createCalculator } from './calc.js';

const calc = createCalculator();
const out = (s) => process.stdout.write(s + '\n');
const fmt = (r) => (typeof r === 'number' ? calc.format(r) : String(r));

function handle(line) {
  const s = line.trim();
  if (s === '') return;
  try {
    if (s === ':deg' || s === ':rad') {
      calc.setAngleMode(s.slice(1));
      out(`mode: ${calc.getAngleMode()}`);
    } else if (s === ':vars') {
      for (const [k, v] of calc.variables()) out(`${k} = ${calc.format(v)}`);
    } else if (s === ':history') {
      calc.history().forEach((h, i) => out(`${i + 1}: ${h.input} = ${fmt(h.result)}`));
    } else {
      out(fmt(calc.evaluate(s)));
    }
  } catch (e) {
    out(`Error: ${e && e.message ? e.message : String(e)}`);
  }
}

const tty = process.stdin.isTTY;
const rl = readline.createInterface({ input: process.stdin, output: tty ? process.stdout : undefined, terminal: !!tty });
if (tty) { rl.setPrompt('> '); rl.prompt(); }
rl.on('line', (line) => { handle(line); if (tty) rl.prompt(); });
rl.on('close', () => { process.exitCode = 0; });
