#!/usr/bin/env node
// CLI for the todo library (argument parsing is original glue code).
import { TodoStore } from './todo.js';

const VALUE_FLAGS = new Set(['due', 'priority', 'tag', 'status', 'sort', 'search']);

function parseArgs(argv) {
  const positional = [];
  const opts = { tag: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      let name = a.slice(2);
      let value;
      const eq = name.indexOf('=');
      if (eq >= 0) { value = name.slice(eq + 1); name = name.slice(0, eq); }
      if (!VALUE_FLAGS.has(name)) throw new Error(`Unknown option: --${name}`);
      if (value === undefined) {
        if (i + 1 >= argv.length) throw new Error(`Missing value for --${name}`);
        value = argv[++i];
      }
      if (name === 'tag') opts.tag.push(value); else opts[name] = value;
    } else positional.push(a);
  }
  return { positional, opts };
}

function parseId(s) {
  if (s === undefined || !/^\d+$/.test(s)) throw new Error(`Invalid id: ${s ?? '(missing)'}`);
  return Number(s);
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd) throw new Error('Usage: cli.js <add|list|done|rm> ...');
  const { positional, opts } = parseArgs(rest);
  const store = new TodoStore({ file: process.env.TODO_FILE || './todos.json' });
  switch (cmd) {
    case 'add': {
      const title = positional.join(' ');
      const item = store.add(title, { due: opts.due, priority: opts.priority ?? 'normal', tags: opts.tag });
      console.log(`Added #${item.id}: ${item.title}`);
      break;
    }
    case 'list': {
      const items = store.list({
        status: opts.status ?? 'all',
        tag: opts.tag.length ? opts.tag[0] : undefined,
        priority: opts.priority,
        search: opts.search,
        sort: opts.sort ?? 'created',
      });
      for (const i of items) console.log(`#${i.id} [${i.done ? 'x' : ' '}] ${i.title}`);
      break;
    }
    case 'done': {
      const item = store.complete(parseId(positional[0]));
      console.log(`Completed #${item.id}`);
      break;
    }
    case 'rm': {
      const item = store.remove(parseId(positional[0]));
      console.log(`Removed #${item.id}`);
      break;
    }
    default:
      throw new Error(`Unknown command: ${cmd}`);
  }
}

try {
  main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exit(1);
}
