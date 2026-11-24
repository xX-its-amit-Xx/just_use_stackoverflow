#!/usr/bin/env node
// CLI: node src/cli.js <file.md|-> [--toc] [--ids]
//   prints HTML (or the TOC as JSON with --toc); reads stdin when file is `-`.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { render, toc } from './markdown.js';

const USAGE = 'usage: node src/cli.js <file.md|-> [--toc] [--ids]\n';

function main (argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const files = argv.filter((a) => !a.startsWith('--'));
  const file = files[0];
  const known = new Set(['--toc', '--ids']);

  if (file === undefined || files.length > 1 || [...flags].some((f) => !known.has(f))) {
    process.stderr.write(USAGE);
    return 2;
  }

  const source = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8');

  if (flags.has('--toc')) {
    process.stdout.write(JSON.stringify(toc(source), null, 2) + '\n');
  } else {
    process.stdout.write(render(source, { headingIds: flags.has('--ids') }));
  }
  return 0;
}

const isMain = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  process.exitCode = main(process.argv.slice(2));
}

export { main };
