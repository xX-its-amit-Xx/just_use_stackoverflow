#!/usr/bin/env node
// calc-s2 REPL: one statement per line from stdin.
import { createInterface } from 'node:readline';
import { createCalculator } from './calc.js';

const calc = createCalculator();
const isTTY = Boolean(process.stdin.isTTY);
const rl = createInterface({ input: process.stdin, output: isTTY ? process.stdout : undefined, terminal: isTTY });
const out = (s) => process.stdout.write(s + '\n');
const fmt = (r) => (typeof r === 'number' ? calc.format(r) : String(r));

if (isTTY) { rl.setPrompt('> '); rl.prompt(); }

rl.on('line', (raw) => {
  const line = raw.replace(/\r$/, '');
  const cmd = line.trim();
  if (cmd !== '') {
    try {
      if (cmd === ':deg' || cmd === ':rad') {
        calc.setAngleMode(cmd.slice(1));
        out('mode: ' + calc.getAngleMode());
      } else if (cmd === ':vars') {
        for (const [n, v] of calc.variables()) out(`${n} = ${calc.format(v)}`);
      } else if (cmd === ':history') {
        calc.history().forEach((h, i) => out(`${i + 1}: ${h.input} = ${fmt(h.result)}`));
      } else {
        out(fmt(calc.evaluate(cmd)));
      }
    } catch (e) {
      out('Error: ' + (e && e.message ? e.message : String(e)));
    }
  }
  if (isTTY) rl.prompt();
});

rl.on('close', () => { process.exitCode = 0; });
