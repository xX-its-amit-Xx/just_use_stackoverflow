#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TodoStore, TodoError } from './todo.js';

const USAGE = `Usage:
  node src/cli.js add "<title>" [--due YYYY-MM-DD] [--priority p] [--tag t]...
  node src/cli.js list [--status s] [--tag t] [--sort k]
  node src/cli.js done <id>
  node src/cli.js rm <id>`;

// Parses argv into { positional: [], flags: { name: [values] } }.
// Supports "--name value" and "--name=value". Flags that take values are repeatable.
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--') && arg.length > 2) {
      let name = arg.slice(2);
      let value;
      const eq = name.indexOf('=');
      if (eq !== -1) {
        value = name.slice(eq + 1);
        name = name.slice(0, eq);
      } else {
        if (i + 1 >= argv.length) throw new TodoError(`Missing value for --${name}`);
        value = argv[++i];
      }
      (flags[name] ??= []).push(value);
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function last(flags, name) {
  const vals = flags[name];
  return vals ? vals[vals.length - 1] : undefined;
}

function parseId(raw) {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    throw new TodoError(`Invalid id: ${raw === undefined ? '(missing)' : raw}`);
  }
  return Number(raw);
}

function requireNoExtra(flags, allowed) {
  for (const name of Object.keys(flags)) {
    if (!allowed.includes(name)) throw new TodoError(`Unknown option: --${name}`);
  }
}

export function run(argv, store, out = (s) => process.stdout.write(s + '\n')) {
  const [command, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);

  switch (command) {
    case 'add': {
      requireNoExtra(flags, ['due', 'priority', 'tag']);
      const title = positional.join(' ');
      const item = store.add(title, {
        due: last(flags, 'due'),
        priority: last(flags, 'priority') ?? 'normal',
        tags: flags.tag ?? [],
      });
      out(`Added #${item.id}: ${item.title}`);
      return 0;
    }
    case 'list': {
      requireNoExtra(flags, ['status', 'tag', 'sort']);
      const items = store.list({
        status: last(flags, 'status') ?? 'all',
        tag: last(flags, 'tag'),
        sort: last(flags, 'sort') ?? 'created',
      });
      for (const it of items) {
        out(`#${it.id} [${it.done ? 'x' : ' '}] ${it.title}`);
      }
      return 0;
    }
    case 'done': {
      const item = store.complete(parseId(positional[0]));
      out(`Completed #${item.id}`);
      return 0;
    }
    case 'rm': {
      const item = store.remove(parseId(positional[0]));
      out(`Removed #${item.id}`);
      return 0;
    }
    default:
      throw new TodoError(command ? `Unknown command: ${command}\n${USAGE}` : USAGE);
  }
}

function main() {
  const file = process.env.TODO_FILE || './todos.json';
  try {
    const store = new TodoStore({ file });
    process.exitCode = run(process.argv.slice(2), store);
  } catch (err) {
    if (err instanceof TodoError) {
      process.stderr.write(`Error: ${err.message}\n`);
    } else {
      process.stderr.write(`Error: ${err && err.message ? err.message : String(err)}\n`);
    }
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
