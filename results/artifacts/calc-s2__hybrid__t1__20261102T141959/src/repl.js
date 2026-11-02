import { createCalculator, CalcError } from './calc.js';

const c = createCalculator();
let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { data += d; });
process.stdin.on('end', () => {
  const out = [];
  const fmt = (r) => (typeof r === 'number' ? c.format(r) : r);
  for (const raw of data.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line === ':deg' || line === ':rad') {
      c.setAngleMode(line.slice(1));
      out.push(`mode: ${line.slice(1)}`);
    } else if (line === ':vars') {
      for (const n of [...c._vars().keys()].sort()) out.push(`${n} = ${c.format(c._vars().get(n))}`);
    } else if (line === ':history') {
      c.history().forEach((h, i) => out.push(`${i + 1}: ${h.input} = ${fmt(h.result)}`));
    } else {
      try { out.push(fmt(c.evaluate(line))); }
      catch (e) { out.push(`Error: ${e instanceof CalcError ? e.message : String(e.message)}`); }
    }
  }
  if (out.length) process.stdout.write(out.join('\n') + '\n');
});
