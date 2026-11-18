#!/usr/bin/env node
import { TodoStore, TodoError } from './todo.js';

function parseArgs(argv) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      let key = a.slice(2), val;
      const eq = key.indexOf('=');
      if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
      else {
        if (i + 1 >= argv.length) throw new TodoError(`Missing value for --${key}`);
        val = argv[++i];
      }
      if (key === 'tag') (opts.tags ||= []).push(val);
      else opts[key] = val;
    } else positional.push(a);
  }
  return { positional, opts };
}

function allowOnly(opts, allowed) {
  for (const k of Object.keys(opts)) if (!allowed.includes(k)) throw new TodoError(`Unknown option: --${k === 'tags' ? 'tag' : k}`);
}

function parseId(s) {
  if (s === undefined || !/^\d+$/.test(s)) throw new TodoError(`Invalid id: ${s ?? '(missing)'}`);
  return Number(s);
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const { positional, opts } = parseArgs(rest);
  const store = new TodoStore({ file: process.env.TODO_FILE || './todos.json' });
  switch (cmd) {
    case 'add': {
      allowOnly(opts, ['due', 'priority', 'tags']);
      if (positional.length !== 1) throw new TodoError('Usage: add "<title>" [--due YYYY-MM-DD] [--priority p] [--tag t]...');
      const item = store.add(positional[0], { due: opts.due, priority: opts.priority ?? 'normal', tags: opts.tags ?? [] });
      console.log(`Added #${item.id}: ${item.title}`);
      break;
    }
    case 'list': {
      allowOnly(opts, ['status', 'tags', 'sort', 'priority', 'search']);
      const tag = opts.tags ? opts.tags[opts.tags.length - 1] : undefined;
      const items = store.list({ status: opts.status ?? 'all', tag, sort: opts.sort ?? 'created', priority: opts.priority, search: opts.search });
      for (const i of items) console.log(`#${i.id} [${i.done ? 'x' : ' '}] ${i.title}`);
      break;
    }
    case 'done': {
      const id = parseId(positional[0]);
      store.complete(id);
      console.log(`Completed #${id}`);
      break;
    }
    case 'rm': {
      const id = parseId(positional[0]);
      store.remove(id);
      console.log(`Removed #${id}`);
      break;
    }
    default:
      throw new TodoError(`Unknown command: ${cmd ?? '(none)'}`);
  }
}

try {
  main(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`Error: ${e.message}\n`);
  process.exit(1);
}
