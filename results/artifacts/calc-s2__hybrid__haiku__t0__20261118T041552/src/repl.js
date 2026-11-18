// Line-based REPL over stdin for the calculator engine.
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { createCalculator } from './calc.js';

const errText = (e) => `Error: ${e && e.message ? e.message : String(e)}`;

function formatResult(calc, v) {
  return typeof v === 'number' ? calc.format(v) : String(v);
}

// Processes one line; returns the output lines (array of strings) it produces.
export function handleLine(calc, rawLine) {
  const line = rawLine.trim();
  if (line === '') return [];

  if (line === ':deg' || line === ':rad') {
    calc.setAngleMode(line.slice(1));
    return [`mode: ${calc.getAngleMode()}`];
  }
  if (line === ':vars') {
    return calc.variables().map(([name, value]) => `${name} = ${calc.format(value)}`);
  }
  if (line === ':history') {
    return calc.history().map((h, i) => `${i + 1}: ${h.input} = ${formatResult(calc, h.result)}`);
  }

  try {
    return [formatResult(calc, calc.evaluate(line))];
  } catch (e) {
    return [errText(e)];
  }
}

export function runRepl(input, output, { calc = createCalculator(), prompt = '' } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, crlfDelay: Infinity, terminal: false });
    rl.on('line', (line) => {
      for (const out of handleLine(calc, line)) output.write(out + '\n');
      if (prompt) output.write(prompt);
    });
    rl.on('close', () => resolve(0));
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const prompt = process.stdin.isTTY ? '> ' : '';
  runRepl(process.stdin, process.stdout, { prompt }).then((code) => {
    process.exitCode = code;
  });
}
