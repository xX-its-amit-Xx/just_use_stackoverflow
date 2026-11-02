import readline from 'node:readline';
import { createCalculator, CalcError } from './calc.js';

const c = createCalculator();
const show = (v) => (typeof v === 'number' ? c.format(v) : v);
const rl = readline.createInterface({ input: process.stdin, terminal: false });
const out = [];

rl.on('line', (raw) => {
  const line = raw.trim();
  if (!line) return;
  if (line[0] === ':') {
    if (line === ':deg' || line === ':rad') {
      c.setAngleMode(line.slice(1));
      out.push(`mode: ${line.slice(1)}`);
    } else if (line === ':vars') {
      for (const n of c._userVars().sort()) out.push(`${n} = ${c.format(c.getVariable(n))}`);
    } else if (line === ':history') {
      c.history().forEach((h, i) => out.push(`${i + 1}: ${h.input} = ${show(h.result)}`));
    } else out.push(`Error: Unknown command ${line}`);
    return;
  }
  try {
    out.push(show(c.evaluate(line)));
  } catch (e) {
    if (e instanceof CalcError) out.push(`Error: ${e.message}`);
    else out.push(`Error: ${e.message}`);
  }
});
rl.on('close', () => { if (out.length) process.stdout.write(out.join('\n') + '\n'); });
