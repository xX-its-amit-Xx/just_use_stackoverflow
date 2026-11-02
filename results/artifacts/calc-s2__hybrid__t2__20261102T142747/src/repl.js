import { createInterface } from 'node:readline';
import { createCalculator, CalcError } from './calc.js';

const c = createCalculator();
const out = [];
const fmt = (r) => (typeof r === 'number' ? c.format(r) : r);
const rl = createInterface({ input: process.stdin, terminal: false });
const w = (s) => process.stdout.write(s + '\n');
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  if (s === ':deg' || s === ':rad') { c.setAngleMode(s.slice(1)); w(`mode: ${s.slice(1)}`); return; }
  if (s === ':vars') {
    for (const k of [...c._vars().keys()].filter((k) => k !== 'ans').sort()) w(`${k} = ${c.format(c._vars().get(k))}`);
    return;
  }
  if (s === ':history') {
    c.history().forEach((h, i) => w(`${i + 1}: ${h.input} = ${fmt(h.result)}`));
    return;
  }
  try { w(fmt(c.evaluate(s))); }
  catch (e) {
    if (e instanceof CalcError) w(`Error: ${e.message}`);
    else w(`Error: ${e.message}`);
  }
});
