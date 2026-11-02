import { createCalculator, CalcError } from './calc.js';
import { createInterface } from 'node:readline';

const c = createCalculator();
const fmt = (r) => (typeof r === 'number' ? c.format(r) : r);
const out = [];
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (raw) => {
  const line = raw.trim();
  if (!line) return;
  if (line === ':deg' || line === ':rad') {
    c.setAngleMode(line.slice(1));
    console.log(`mode: ${line.slice(1)}`);
  } else if (line === ':vars') {
    for (const k of [...c._vars().keys()].sort()) console.log(`${k} = ${c.format(c._vars().get(k))}`);
  } else if (line === ':history') {
    c.history().forEach((h, i) => console.log(`${i + 1}: ${h.input} = ${fmt(h.result)}`));
  } else {
    try { console.log(fmt(c.evaluate(line))); }
    catch (e) {
      if (e instanceof CalcError) console.log(`Error: ${e.message}`);
      else throw e;
    }
  }
});
