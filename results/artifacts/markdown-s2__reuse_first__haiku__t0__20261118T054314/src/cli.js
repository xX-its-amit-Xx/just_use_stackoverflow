#!/usr/bin/env node
// CLI: node src/cli.js <file.md|-> [--toc] [--ids]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { render, toc } from './markdown.js';

export function main(argv, readInput = readStdinOrFile) {
  const args = argv.slice(2);
  const flags = new Set(args.filter(a => a.startsWith('--')));
  const files = args.filter(a => !a.startsWith('--'));
  if (files.length !== 1) {
    process.stderr.write('usage: node src/cli.js <file.md|-> [--toc] [--ids]\n');
    return 2;
  }
  const source = readInput(files[0]);
  if (flags.has('--toc')) {
    process.stdout.write(JSON.stringify(toc(source), null, 2) + '\n');
  } else {
    process.stdout.write(render(source, { headingIds: flags.has('--ids') }));
  }
  return 0;
}

function readStdinOrFile(file) {
  return file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv);
}
