#!/usr/bin/env node
// CLI: node src/cli.js <file.md|-> [--toc] [--ids]
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { render, toc } from './markdown.js';

export function run(argv) {
  const args = argv.slice(2);
  const flags = new Set(args.filter(a => a.startsWith('--')));
  const file = args.find(a => !a.startsWith('--'));
  if (file === undefined) {
    process.stderr.write('usage: node src/cli.js <file.md|-> [--toc] [--ids]\n');
    return 2;
  }
  const md = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');
  if (flags.has('--toc')) {
    process.stdout.write(JSON.stringify(toc(md), null, 2) + '\n');
  } else {
    process.stdout.write(render(md, { headingIds: flags.has('--ids') }));
  }
  return 0;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exitCode = run(process.argv);
}
