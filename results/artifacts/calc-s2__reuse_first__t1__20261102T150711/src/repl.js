import readline from 'node:readline';
import { createCalculator } from './calc.js';

const c = createCalculator();
const fmt = (r) => (typeof r === 'number' ? c.format(r) : r);
const rl = readline.createInterface({ input: process.stdin, terminal: false });
const out = [];

for await (const raw of rl) {
  const line = raw.trim();
  if (!line) continue;
  if (line === ':deg' || line === ':rad') {
    c.setAngleMode(line.slice(1));
    out.push(`mode: ${line.slice(1)}`);
  } else if (line === ':vars') {
    for (const [k, v] of [...c._vars()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
      out.push(`${k} = ${c.format(v)}`);
    }
  } else if (line === ':history') {
    c.history().forEach((h, i) => out.push(`${i + 1}: ${h.input} = ${fmt(h.result)}`));
  } else {
    try { out.push(fmt(c.evaluate(raw))); } catch (e) {
      if (!(e instanceof Error)) throw e;
      out.push(`Error: ${e.message}`);
    }
  }
  process.stdout.write(out.splice(0).map((l) => l + '\n').join(''));
}
