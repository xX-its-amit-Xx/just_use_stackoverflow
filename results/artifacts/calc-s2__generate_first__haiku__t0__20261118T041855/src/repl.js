#!/usr/bin/env node
// Line-oriented REPL for the calculator engine.

import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { createCalculator } from './calc.js';

// Processes one input line. Returns the output text (may be multi-line) or null for blank lines.
export function processLine(calc, rawLine) {
  const line = rawLine.trim();
  if (line === '') return null;

  if (line.startsWith(':')) {
    switch (line) {
      case ':deg':
        calc.setAngleMode('deg');
        return 'mode: deg';
      case ':rad':
        calc.setAngleMode('rad');
        return 'mode: rad';
      case ':vars':
        return calc.variables()
          .map(([name, value]) => `${name} = ${calc.format(value)}`)
          .join('\n');
      case ':history':
        return calc.history()
          .map((h, i) => {
            const res = typeof h.result === 'number' ? calc.format(h.result) : h.result;
            return `${i + 1}: ${h.input} = ${res}`;
          })
          .join('\n');
      default:
        return `Error: unknown command ${line}`;
    }
  }

  try {
    const result = calc.evaluate(line);
    return typeof result === 'number' ? calc.format(result) : result;
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

export function runRepl({ input = process.stdin, output = process.stdout, calc = createCalculator() } = {}) {
  return new Promise((resolve) => {
    const tty = Boolean(input.isTTY);
    const rl = readline.createInterface({ input, terminal: false });
    if (tty) output.write('> ');
    rl.on('line', (line) => {
      const out = processLine(calc, line);
      if (out !== null) output.write(out + '\n');
      if (tty) output.write('> ');
    });
    rl.on('close', () => resolve(0));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await runRepl();
  process.exitCode = code;
}
