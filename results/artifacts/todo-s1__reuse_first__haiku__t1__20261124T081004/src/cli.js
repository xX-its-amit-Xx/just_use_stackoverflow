#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { TodoStore, TodoError } from './todo.js';

const USAGE = `Usage:
  todo add "<title>" [--due YYYY-MM-DD] [--priority low|normal|high] [--tag t]...
  todo list [--status all|open|done] [--tag t] [--sort created|due|priority]
  todo done <id>
  todo rm <id>`;

// Parses "--name value" / "--name=value" options (repeatable) and positionals.
function parseArgs(args) {
  const positional = [];
  const opts = { tag: [] };
  const valueOpts = new Set(['due', 'priority', 'tag', 'status', 'sort']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      let name = arg.slice(2);
      let value;
      const eq = name.indexOf('=');
      if (eq !== -1) {
        value = name.slice(eq + 1);
        name = name.slice(0, eq);
      } else if (valueOpts.has(name)) {
        if (i + 1 >= args.length) throw new TodoError(`missing value for --${name}`);
        value = args[++i];
      }
      if (!valueOpts.has(name)) throw new TodoError(`unknown option: --${name}`);
      if (name === 'tag') opts.tag.push(value);
      else opts[name] = value;
    } else {
      positional.push(arg);
    }
  }
  return { positional, opts };
}

function parseId(raw) {
  if (raw === undefined || !/^#?\d+$/.test(raw)) {
    throw new TodoError(`invalid id: ${raw === undefined ? '(missing)' : raw}`);
  }
  return Number(raw.replace(/^#/, ''));
}

function formatItem(item) {
  return `#${item.id} [${item.done ? 'x' : ' '}] ${item.title}`;
}

export function run(argv, env = process.env, out = console.log) {
  const [command, ...rest] = argv;
  const file = env.TODO_FILE || './todos.json';
  const store = new TodoStore({ file });
  const { positional, opts } = parseArgs(rest);

  switch (command) {
    case 'add': {
      const title = positional.join(' ');
      const item = store.add(title, {
        due: opts.due,
        priority: opts.priority ?? 'normal',
        tags: opts.tag,
      });
      out(`Added #${item.id}: ${item.title}`);
      return 0;
    }
    case 'list': {
      const items = store.list({
        status: opts.status ?? 'all',
        tag: opts.tag.length ? opts.tag[opts.tag.length - 1] : undefined,
        priority: opts.priority,
        sort: opts.sort ?? 'created',
      });
      for (const item of items) out(formatItem(item));
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
      throw new TodoError(command ? `unknown command: ${command}\n${USAGE}` : USAGE);
  }
}

function main() {
  try {
    run(process.argv.slice(2));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n`);
    process.exitCode = 1;
  }
}

const isMain = (() => {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) main();
