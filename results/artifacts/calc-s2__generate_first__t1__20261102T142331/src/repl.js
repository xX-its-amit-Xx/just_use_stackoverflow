import readline from 'node:readline';
import { createCalculator, CalcError } from './calc.js';

const c = createCalculator();
const out = [];
const rl = readline.createInterface({ input: process.stdin, terminal: false });
const fmt = (r) => (typeof r === 'number' ? c.format(r) : String(r));
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  if (s === ':deg' || s === ':rad') {
    c.setAngleMode(s.slice(1));
    console.log(`mode: ${s.slice(1)}`);
  } else if (s === ':vars') {
    for (const k of [...c._vars.keys()].sort()) console.log(`${k} = ${c.format(c._vars.get(k))}`);
  } else if (s === ':history') {
    c.history().forEach((h, i) => console.log(`${i + 1}: ${h.input} = ${fmt(h.result)}`));
  } else {
    try { console.log(fmt(c.evaluate(s))); }
    catch (e) {
      if (e instanceof CalcError) console.log(`Error: ${e.message}`);
      else throw e;
    }
  }
});
