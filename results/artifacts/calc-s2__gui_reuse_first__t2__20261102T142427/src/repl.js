import { createInterface } from 'node:readline';
import { createCalculator, CalcError } from './calc.js';

const c = createCalculator();
const out = [];
const rl = createInterface({ input: process.stdin, terminal: false });
const fmt = (r) => (typeof r === 'number' ? c.format(r) : r);
rl.on('line', (raw) => {
  const line = raw.trim();
  if (!line) return;
  if (line[0] === ':') {
    if (line === ':deg' || line === ':rad') { c.setAngleMode(line.slice(1)); console.log(`mode: ${line.slice(1)}`); }
    else if (line === ':vars') {
      for (const n of [...c._vars().keys()].filter((k) => k !== 'ans').sort()) console.log(`${n} = ${c.format(c._vars().get(n))}`);
    } else if (line === ':history') {
      c.history().forEach((h, i) => console.log(`${i + 1}: ${h.input} = ${fmt(h.result)}`));
    } else console.log(`Error: Unknown command ${line}`);
    return;
  }
  try { console.log(fmt(c.evaluate(line))); }
  catch (e) { if (e instanceof CalcError) console.log(`Error: ${e.message}`); else throw e; }
});
