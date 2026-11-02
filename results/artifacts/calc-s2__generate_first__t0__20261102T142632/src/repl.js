import { createCalculator, CalcError } from './calc.js';

const c = createCalculator();
const out = [];
const fmt = (r) => (typeof r === 'number' ? c.format(r) : String(r));

function handle(line) {
  const s = line.trim();
  if (!s) return;
  if (s === ':deg' || s === ':rad') {
    c.setAngleMode(s.slice(1));
    out.push(`mode: ${s.slice(1)}`);
  } else if (s === ':vars') {
    const names = c.variables().sort();
    for (const n of names) out.push(`${n} = ${c.format(c.getVariable(n))}`);
  } else if (s === ':history') {
    c.history().forEach((h, i) => out.push(`${i + 1}: ${h.input} = ${fmt(h.result)}`));
  } else {
    try { out.push(fmt(c.evaluate(s))); } catch (e) {
      if (e instanceof CalcError) out.push(`Error: ${e.message}`); else out.push(`Error: ${e.message}`);
    }
  }
}

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  for (const line of data.split(/\r?\n/)) handle(line);
  if (out.length) process.stdout.write(out.join('\n') + '\n');
});
