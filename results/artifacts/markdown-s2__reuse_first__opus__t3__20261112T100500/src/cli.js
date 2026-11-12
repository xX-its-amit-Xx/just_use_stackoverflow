#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { render, toc } from './markdown.js'

const args = process.argv.slice(2)
const flags = new Set(args.filter(a => a.startsWith('--')))
const file = args.find(a => a === '-' || !a.startsWith('--'))
if (!file) {
  process.stderr.write('Usage: node src/cli.js <file.md|-> [--toc] [--ids]\n')
  process.exit(2)
}
let input
try {
  input = readFileSync(file === '-' ? 0 : file, 'utf8')
} catch (e) {
  process.stderr.write(`Error reading ${file}: ${e.message}\n`)
  process.exit(1)
}
if (flags.has('--toc')) process.stdout.write(JSON.stringify(toc(input), null, 2) + '\n')
else process.stdout.write(render(input, { headingIds: flags.has('--ids') }))
