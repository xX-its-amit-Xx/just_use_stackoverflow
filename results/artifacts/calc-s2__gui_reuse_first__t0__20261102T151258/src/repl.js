import { createInterface } from 'node:readline';
import { createCalculator, CalcError } from './calc.js';

const c = createCalculator();
const fmt = (r) => (typeof r === 'number' ? c.format(r) : r);
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (raw) => {
  const line = raw.trim();
  if (!line) return;
  const out = (s) => process.stdout.write(s + '\n');
  if (line.startsWith(':')) {
    if (line === ':deg' || line === ':rad') {
      c.setAngleMode(line.slice(1)); out(`mode: ${line.slice(1)}`);
    } else if (line === ':vars') {
      for (const k of [...c._vars.keys()].sort()) out(`${k} = ${c.format(c._vars.get(k))}`);
    } else if (line === ':history') {
      c.history().forEach((h, i) => out(`${i + 1}: ${h.input} = ${fmt(h.result)}`));
    } else out(`Error: Unknown command ${line}`);
    return;
  }
  try { out(fmt(c.evaluate(line))); }
  catch (e) {
    if (e instanceof CalcError) out(`Error: ${e.message}`); else throw e;
  }
});
