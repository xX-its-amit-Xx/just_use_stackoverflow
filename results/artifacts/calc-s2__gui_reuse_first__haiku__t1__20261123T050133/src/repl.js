#!/usr/bin/env node
// Line-oriented REPL for the calculator engine (see SPEC.md, "REPL").
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { createCalculator } from './calc.js';

function formatResult(calc, result) {
  return typeof result === 'number' ? calc.format(result) : String(result);
}

// Returns an array of output lines for one input line (empty array for blank lines).
export function handleLine(calc, rawLine) {
  const line = rawLine.trim();
  if (line === '') return [];

  if (line.startsWith(':')) {
    switch (line) {
      case ':deg':
      case ':rad':
        calc.setAngleMode(line.slice(1));
        return [`mode: ${calc.getAngleMode()}`];
      case ':vars': {
        const vars = calc.variables();
        return Object.keys(vars).sort().map((name) => `${name} = ${calc.format(vars[name])}`);
      }
      case ':history':
        return calc.history().map((h, idx) =>
          `${idx + 1}: ${h.input} = ${formatResult(calc, h.result)}`);
      default:
        return [`Error: unknown command ${line}`];
    }
  }

  try {
    return [formatResult(calc, calc.evaluate(line))];
  } catch (err) {
    return [`Error: ${err.message}`];
  }
}

// Runs the REPL over the given streams. Resolves when input ends.
export function runRepl({
  input = process.stdin,
  output = process.stdout,
  calc = createCalculator(),
} = {}) {
  const tty = Boolean(input.isTTY);
  const rl = createInterface({
    input,
    output: tty ? output : undefined,
    terminal: tty,
  });
  return new Promise((resolve) => {
    if (tty) {
      rl.setPrompt('> ');
      rl.prompt();
    }
    rl.on('line', (line) => {
      for (const out of handleLine(calc, line)) output.write(out + '\n');
      if (tty) rl.prompt();
    });
    rl.on('close', () => resolve(0));
  });
}

const isMain = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  runRepl().then((code) => {
    process.exitCode = code;
  });
}
