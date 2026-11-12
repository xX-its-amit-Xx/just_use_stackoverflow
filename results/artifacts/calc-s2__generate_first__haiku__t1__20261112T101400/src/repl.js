// Line-oriented REPL over a calculator engine.
// Reads statements from stdin, writes one result line per statement.

import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { createCalculator } from './calc.js';

function formatResult(calc, result) {
  return typeof result === 'number' ? calc.format(result) : String(result);
}

// Returns an array of output lines for one input line (empty for blank lines).
export function processLine(calc, rawLine) {
  const line = rawLine.trim();
  if (line === '') return [];

  if (line.startsWith(':')) {
    switch (line) {
      case ':deg':
        calc.setAngleMode('deg');
        return ['mode: deg'];
      case ':rad':
        calc.setAngleMode('rad');
        return ['mode: rad'];
      case ':vars':
        return calc.variables().map((v) => `${v.name} = ${calc.format(v.value)}`);
      case ':history':
        return calc.history().map(
          (h, idx) => `${idx + 1}: ${h.input} = ${formatResult(calc, h.result)}`,
        );
      default:
        return [`Error: Unknown command: ${line}`];
    }
  }

  try {
    return [formatResult(calc, calc.evaluate(line))];
  } catch (err) {
    return [`Error: ${err.message}`];
  }
}

export async function runRepl({
  input = process.stdin,
  output = process.stdout,
  calc = createCalculator(),
} = {}) {
  const interactive = Boolean(input.isTTY && output.isTTY);
  const rl = createInterface({ input, crlfDelay: Infinity });
  if (interactive) output.write('> ');
  for await (const line of rl) {
    for (const out of processLine(calc, line)) output.write(out + '\n');
    if (interactive) output.write('> ');
  }
  return 0;
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  runRepl().then((code) => {
    process.exitCode = code;
  });
}
