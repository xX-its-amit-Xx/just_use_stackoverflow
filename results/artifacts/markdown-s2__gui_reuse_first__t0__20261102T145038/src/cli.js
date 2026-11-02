import { readFileSync } from 'node:fs';
import { render, toc } from './markdown.js';

const args = process.argv.slice(2);
const file = args.find(a => a === '-' || !a.startsWith('--'));
if (!file) { console.error('usage: cli.js <file.md|-> [--toc] [--ids]'); process.exit(2); }
const md = readFileSync(file === '-' ? 0 : file, 'utf8');
if (args.includes('--toc')) console.log(JSON.stringify(toc(md), null, 2));
else process.stdout.write(render(md, { headingIds: args.includes('--ids') }));
