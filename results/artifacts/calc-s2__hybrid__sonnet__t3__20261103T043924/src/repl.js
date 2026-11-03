import { createInterface } from 'node:readline';
import { createCalculator, CalcError } from './calc.js';

const c = createCalculator();
const show = (r) => (typeof r === 'number' ? c.format(r) : r);
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  const out = [];
  if (s === ':deg' || s === ':rad') {
    c.setAngleMode(s.slice(1));
    out.push(`mode: ${s.slice(1)}`);
  } else if (s === ':vars') {
    for (const [k, v] of [...c._vars()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) out.push(`${k} = ${c.format(v)}`);
  } else if (s === ':history') {
    c.history().forEach((h, i) => out.push(`${i + 1}: ${h.input} = ${show(h.result)}`));
  } else {
    try { out.push(show(c.evaluate(s))); } catch (e) {
      if (e instanceof CalcError) out.push(`Error: ${e.message}`); else throw e;
    }
  }
  if (out.length) process.stdout.write(out.join('\n') + '\n');
});
