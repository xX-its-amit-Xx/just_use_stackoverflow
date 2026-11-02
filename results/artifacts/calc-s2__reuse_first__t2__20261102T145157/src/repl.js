import readline from 'node:readline';
import { createCalculator, CalcError } from './calc.js';

const c = createCalculator();
const out = [];
const show = (r) => (typeof r === 'number' ? c.format(r) : r);
const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (raw) => {
  const line = raw.trim();
  if (!line) return;
  if (line === ':deg' || line === ':rad') {
    c.setAngleMode(line.slice(1));
    out.push(`mode: ${c.getAngleMode()}`);
  } else if (line === ':vars') {
    for (const [k, v] of c._vars().sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
      out.push(`${k} = ${c.format(v)}`);
    }
  } else if (line === ':history') {
    c.history().forEach((h, i) => out.push(`${i + 1}: ${h.input} = ${show(h.result)}`));
  } else {
    try {
      out.push(show(c.evaluate(line)));
    } catch (e) {
      if (e instanceof CalcError) out.push(`Error: ${e.message}`);
      else out.push(`Error: ${e.message}`);
    }
  }
  if (out.length) process.stdout.write(out.splice(0).join('\n') + '\n');
});
