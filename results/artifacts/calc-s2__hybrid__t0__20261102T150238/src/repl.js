import { createInterface } from 'node:readline';
import { createCalculator, CalcError } from './calc.js';

const c = createCalculator();
const rl = createInterface({ input: process.stdin, terminal: false });
const out = [];
const fmt = (r) => (typeof r === 'string' ? r : c.format(r));
rl.on('line', (raw) => {
  const line = raw.trim();
  if (!line) return;
  if (line === ':deg' || line === ':rad') {
    c.setAngleMode(line.slice(1));
    out.push(`mode: ${line.slice(1)}`);
  } else if (line === ':vars') {
    for (const [n, v] of c.variables()) out.push(`${n} = ${c.format(v)}`);
  } else if (line === ':history') {
    c.history().forEach((h, i) => out.push(`${i + 1}: ${h.input} = ${fmt(h.result)}`));
  } else {
    try { out.push(fmt(c.evaluate(raw))); }
    catch (e) {
      if (e instanceof CalcError) out.push(`Error: ${e.message}`); else throw e;
    }
  }
});
rl.on('close', () => { if (out.length) process.stdout.write(out.join('\n') + '\n'); });
