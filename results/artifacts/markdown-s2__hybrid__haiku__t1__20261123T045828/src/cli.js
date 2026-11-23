#!/usr/bin/env node
// CLI: node src/cli.js <file.md|-> [--toc] [--ids]
import { readFileSync } from 'node:fs';
import { render, toc } from './markdown.js';

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const file = args.find(a => !a.startsWith('--'));

if (file === undefined) {
  process.stderr.write('usage: node src/cli.js <file.md|-> [--toc] [--ids]\n');
  process.exit(2);
}

const source = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');

if (flags.has('--toc')) {
  process.stdout.write(JSON.stringify(toc(source), null, 2) + '\n');
} else {
  process.stdout.write(render(source, { headingIds: flags.has('--ids') }));
}
