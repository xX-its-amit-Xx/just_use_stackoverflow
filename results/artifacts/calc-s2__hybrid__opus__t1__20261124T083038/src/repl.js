#!/usr/bin/env node
import readline from 'node:readline';
import { createCalculator } from './calc.js';

const c = createCalculator();
const tty = Boolean(process.stdin.isTTY);
const rl = readline.createInterface({ input: process.stdin, output: tty ? process.stdout : undefined, terminal: tty });
const out = (s) => process.stdout.write(s + '\n');
const show = (r) => (typeof r === 'number' ? c.format(r) : String(r));

if (tty) { rl.setPrompt('> '); rl.prompt(); }
rl.on('line', (raw) => {
  const line = raw.trim();
  if (line !== '') {
    try {
      if (line === ':deg' || line === ':rad') {
        c.setAngleMode(line.slice(1));
        out(`mode: ${c.getAngleMode()}`);
      } else if (line === ':vars') {
        for (const [k, v] of c.userVariables()) out(`${k} = ${c.format(v)}`);
      } else if (line === ':history') {
        c.history().forEach((h, i) => out(`${i + 1}: ${h.input} = ${show(h.result)}`));
      } else if (line.startsWith(':')) {
        out(`Error: Unknown command '${line}'`);
      } else {
        out(show(c.evaluate(line)));
      }
    } catch (e) {
      out(`Error: ${e && e.message ? e.message : String(e)}`);
    }
  }
  if (tty) rl.prompt();
});
rl.on('close', () => { process.exitCode = 0; });
