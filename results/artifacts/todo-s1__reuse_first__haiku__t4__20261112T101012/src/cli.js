#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TodoStore, TodoError } from './todo.js';

const USAGE = `Usage:
  node src/cli.js add "<title>" [--due YYYY-MM-DD] [--priority p] [--tag t]...
  node src/cli.js list [--status s] [--tag t] [--sort k]
  node src/cli.js done <id>
  node src/cli.js rm <id>`;

// Parse argv into { positional: [], flags: { name: [values] } }.
// Supports "--name value" and "--name=value". Flags that take values must have one.
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
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
      if (!flags[name]) flags[name] = [];
      flags[name].push(value);
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function last(flags, name) {
  const v = flags[name];
  return v && v.length ? v[v.length - 1] : undefined;
}

function parseId(raw) {
  if (raw === undefined) throw new TodoError('Missing id');
  const s = String(raw).replace(/^#/, '');
  if (!/^\d+$/.test(s)) throw new TodoError(`Invalid id: ${raw}`);
  return Number(s);
}

function storeFile() {
  return process.env.TODO_FILE || './todos.json';
}

function run(argv, out = console.log) {
  const [cmd, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);
  const store = new TodoStore({ file: storeFile() });

  switch (cmd) {
    case 'add': {
      const title = positional.join(' ');
      const item = store.add(title, {
        due: last(flags, 'due'),
        priority: last(flags, 'priority') ?? 'normal',
        tags: flags.tag ?? [],
      });
      out(`Added #${item.id}: ${item.title}`);
      return;
    }
    case 'list': {
      const items = store.list({
        status: last(flags, 'status') ?? 'all',
        tag: last(flags, 'tag'),
        sort: last(flags, 'sort') ?? 'created',
      });
      for (const it of items) {
        out(`#${it.id} [${it.done ? 'x' : ' '}] ${it.title}`);
      }
      return;
    }
    case 'done': {
      const item = store.complete(parseId(positional[0]));
      out(`Completed #${item.id}`);
      return;
    }
    case 'rm': {
      const item = store.remove(parseId(positional[0]));
      out(`Removed #${item.id}`);
      return;
    }
    default:
      throw new TodoError(cmd ? `Unknown command: ${cmd}\n${USAGE}` : USAGE);
  }
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    run(process.argv.slice(2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n`);
    process.exitCode = 1;
  }
}

export { run, parseArgs };
