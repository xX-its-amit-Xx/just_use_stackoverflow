// Line-oriented REPL on top of the calculator engine.
import readline from 'node:readline';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createCalculator } from './calc.js';

function display(calc, result) {
  return typeof result === 'number' ? calc.format(result) : result;
}

// Returns an array of output lines for one input line (empty array for blank lines).
export function handleLine(calc, rawLine) {
  const line = rawLine.trim();
  if (line === '') return [];
  switch (line) {
    case ':deg':
      calc.setAngleMode('deg');
      return ['mode: deg'];
    case ':rad':
      calc.setAngleMode('rad');
      return ['mode: rad'];
    case ':vars':
      return calc.variables().map(([name, value]) => `${name} = ${calc.format(value)}`);
    case ':history':
      return calc.history().map((h, i) => `${i + 1}: ${h.input} = ${display(calc, h.result)}`);
    default:
      if (line.startsWith(':')) return [`Error: unknown command '${line}'`];
      try {
        return [display(calc, calc.evaluate(line))];
      } catch (e) {
        return [`Error: ${e.message}`];
      }
  }
}

export function runRepl({
  input = process.stdin,
  output = process.stdout,
  calc = createCalculator(),
} = {}) {
  return new Promise((done) => {
    const tty = Boolean(input.isTTY);
    const rl = readline.createInterface({ input, terminal: false, crlfDelay: Infinity });
    if (tty) output.write('> ');
    rl.on('line', (line) => {
      for (const out of handleLine(calc, line)) output.write(out + '\n');
      if (tty) output.write('> ');
    });
    rl.on('close', () => done(0));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runRepl().then((code) => {
    process.exitCode = code;
  });
}
