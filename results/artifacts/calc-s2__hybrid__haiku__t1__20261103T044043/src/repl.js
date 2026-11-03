import { createInterface } from 'node:readline';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCalculator } from './calc.js';

const fmtResult = (c, r) => (typeof r === 'number' ? c.format(r) : r);

// Handle one input line. Returns the output text (without trailing newline),
// or null when nothing should be printed (blank lines).
export function processLine(c, line) {
  const s = line.trim();
  if (s === '') return null;

  if (s.startsWith(':')) {
    switch (s) {
      case ':deg':
        c.setAngleMode('deg');
        return `mode: ${c.getAngleMode()}`;
      case ':rad':
        c.setAngleMode('rad');
        return `mode: ${c.getAngleMode()}`;
      case ':vars':
        return c.variables().map(({ name, value }) => `${name} = ${c.format(value)}`).join('\n') || null;
      case ':history':
        return c.history()
          .map((h, i) => `${i + 1}: ${h.input} = ${fmtResult(c, h.result)}`)
          .join('\n') || null;
      default:
        return `Error: unknown command: ${s}`;
    }
  }

  try {
    return fmtResult(c, c.evaluate(s));
  } catch (e) {
    return `Error: ${e.message}`;
  }
}

// Run the REPL over a readable input stream, writing results to output.
export async function runRepl(input = process.stdin, output = process.stdout, calc = createCalculator()) {
  const rl = createInterface({ input, crlfDelay: Infinity });
  const prompt = input.isTTY ? '> ' : '';
  if (prompt) output.write(prompt);
  for await (const line of rl) {
    const out = processLine(calc, line);
    if (out !== null) output.write(out + '\n');
    if (prompt) output.write(prompt);
  }
  return 0;
}

const isMain = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();

if (isMain) {
  runRepl().then((code) => { process.exitCode = code; });
}
