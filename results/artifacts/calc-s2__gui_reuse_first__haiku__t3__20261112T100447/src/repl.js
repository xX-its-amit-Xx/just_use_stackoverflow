// Line-oriented REPL for the calculator. Reads statements from stdin, writes one
// line per statement to stdout. Run with: node src/repl.js
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { createCalculator } from './calc.js';

export async function runRepl(input, output, { tty = false, calc = createCalculator() } = {}) {
  const say = (s) => output.write(s + '\n');
  const rl = createInterface({ input, crlfDelay: Infinity, terminal: false });

  const handle = (line) => {
    switch (line) {
      case ':deg':
        calc.setAngleMode('deg');
        say('mode: deg');
        return;
      case ':rad':
        calc.setAngleMode('rad');
        say('mode: rad');
        return;
      case ':vars':
        for (const { name, value } of calc.variables()) say(`${name} = ${calc.format(value)}`);
        return;
      case ':history':
        calc.history().forEach((h, i) => {
          const shown = typeof h.result === 'number' ? calc.format(h.result) : h.result;
          say(`${i + 1}: ${h.input} = ${shown}`);
        });
        return;
      default:
        break;
    }
    try {
      const r = calc.evaluate(line);
      say(typeof r === 'number' ? calc.format(r) : r);
    } catch (e) {
      say(`Error: ${e.message}`);
    }
  };

  if (tty) output.write('> ');
  for await (const raw of rl) {
    const line = raw.trim();
    if (line !== '') handle(line);
    if (tty) output.write('> ');
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  await runRepl(process.stdin, process.stdout, { tty: Boolean(process.stdin.isTTY) });
}
