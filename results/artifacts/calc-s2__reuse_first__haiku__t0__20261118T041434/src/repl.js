// Line-oriented REPL for the calculator engine (see SPEC.md "REPL").
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createCalculator } from './calc.js';

function showResult(calc, result) {
  return typeof result === 'number' ? calc.format(result) : result;
}

// Processes one trimmed, non-empty line; returns the output line(s) as strings.
function handleLine(calc, line) {
  if (line.startsWith(':')) {
    switch (line) {
      case ':deg':
      case ':rad':
        calc.setAngleMode(line.slice(1));
        return [`mode: ${calc.getAngleMode()}`];
      case ':vars':
        return calc.listVariables().map(([name, value]) => `${name} = ${calc.format(value)}`);
      case ':history':
        return calc.history().map(
          (h, i) => `${i + 1}: ${h.input} = ${showResult(calc, h.result)}`,
        );
      default:
        return [`Error: Unknown command '${line}'`];
    }
  }
  try {
    return [showResult(calc, calc.evaluate(line))];
  } catch (e) {
    return [`Error: ${e.message}`];
  }
}

// Reads statements from `input` line by line and writes results to `output`.
// Resolves to exit code 0 at EOF.
export async function runRepl({
  input = process.stdin,
  output = process.stdout,
  calc = createCalculator(),
} = {}) {
  const tty = Boolean(input.isTTY);
  const prompt = tty ? '> ' : '';
  const rl = createInterface({ input, crlfDelay: Infinity, terminal: false });
  if (tty) output.write(prompt);
  for await (const raw of rl) {
    const line = raw.trim();
    if (line !== '') {
      for (const out of handleLine(calc, line)) output.write(`${out}\n`);
    }
    if (tty) output.write(prompt);
  }
  return 0;
}

const isMain = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runRepl().then((code) => {
    process.exitCode = code;
  });
}
