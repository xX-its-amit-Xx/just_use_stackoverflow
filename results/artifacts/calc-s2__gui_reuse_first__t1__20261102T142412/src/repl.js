import { createInterface } from 'node:readline';
import { createCalculator, CalcError } from './calc.js';

const c = createCalculator();
const out = [];
const fmt = (r) => (typeof r === 'number' ? c.format(r) : String(r));
const rl = createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  if (s === ':deg' || s === ':rad') {
    c.setAngleMode(s.slice(1));
    out.push(`mode: ${s.slice(1)}`);
  } else if (s === ':vars') {
    for (const [k, v] of c.variables().sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
      out.push(`${k} = ${c.format(v)}`);
    }
  } else if (s === ':history') {
    c.history().forEach((h, i) => out.push(`${i + 1}: ${h.input} = ${fmt(h.result)}`));
  } else {
    try { out.push(fmt(c.evaluate(line))); }
    catch (e) {
      if (e instanceof CalcError) out.push(`Error: ${e.message}`); else throw e;
    }
  }
});
rl.on('close', () => { if (out.length) process.stdout.write(out.join('\n') + '\n'); });
