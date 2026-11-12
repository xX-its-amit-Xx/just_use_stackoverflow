#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TodoStore, TodoError } from './todo.js';

const VALUE_FLAGS = ['due', 'priority', 'tag', 'status', 'sort'];

// Parses args after the command: positionals plus --flag value / --flag=value.
// Repeated flags are collected into arrays.
function parseArgs(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (!VALUE_FLAGS.includes(name)) throw new TodoError(`unknown option: --${name}`);
      let value;
      if (eq !== -1) {
        value = a.slice(eq + 1);
      } else {
        if (i + 1 >= args.length || args[i + 1].startsWith('--')) {
          throw new TodoError(`option --${name} requires a value`);
        }
        value = args[++i];
      }
      if (name === 'tag') {
        (flags.tag ??= []).push(value);
      } else {
        flags[name] = value;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function usage() {
  return [
    'Usage:',
    '  todo add "<title>" [--due YYYY-MM-DD] [--priority low|normal|high] [--tag t]...',
    '  todo list [--status all|open|done] [--tag t] [--sort created|due|priority]',
    '  todo done <id>',
    '  todo rm <id>',
  ].join('\n');
}

function requireOne(positional, what) {
  if (positional.length !== 1) throw new TodoError(`${what} expected`);
  return positional[0];
}

// Runs a CLI command. Returns { stdout: [lines], code }. Throws TodoError on bad input.
export function run(argv, { file } = {}) {
  const [command, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);
  const store = new TodoStore({ file });
  const out = [];

  switch (command) {
    case 'add': {
      const title = requireOne(positional, 'a title');
      const item = store.add(title, {
        due: flags.due,
        priority: flags.priority ?? 'normal',
        tags: flags.tag ?? [],
      });
      out.push(`Added #${item.id}: ${item.title}`);
      break;
    }
    case 'list': {
      const items = store.list({
        status: flags.status ?? 'all',
        tag: flags.tag?.[flags.tag.length - 1],
        sort: flags.sort ?? 'created',
      });
      for (const it of items) {
        out.push(`#${it.id} [${it.done ? 'x' : ' '}] ${it.title}`);
      }
      break;
    }
    case 'done': {
      const item = store.complete(requireOne(positional, 'an id'));
      out.push(`Completed #${item.id}`);
      break;
    }
    case 'rm': {
      const item = store.remove(requireOne(positional, 'an id'));
      out.push(`Removed #${item.id}`);
      break;
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      out.push(usage());
      break;
    default:
      throw new TodoError(`unknown command: ${command}\n${usage()}`);
  }
  return { stdout: out };
}

function main() {
  const file = process.env.TODO_FILE || path.resolve(process.cwd(), 'todos.json');
  try {
    const { stdout } = run(process.argv.slice(2), { file });
    for (const line of stdout) console.log(line);
  } catch (err) {
    const msg = err instanceof TodoError ? err.message : (err && err.message) || String(err);
    process.stderr.write(`Error: ${msg}\n`);
    process.exitCode = 1;
  }
}

// Run only when executed directly (not when imported by tests).
const isMain = (() => {
  try {
    return process.argv[1] !== undefined &&
      import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (isMain) main();
