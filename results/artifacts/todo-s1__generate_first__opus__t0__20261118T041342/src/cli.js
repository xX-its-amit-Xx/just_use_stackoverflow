#!/usr/bin/env node
import { TodoStore, TodoError } from './todo.js';

const MULTI = new Set(['tag']);

function parseArgs(args) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--') && a.length > 2) {
      let key = a.slice(2);
      let val;
      const eq = key.indexOf('=');
      if (eq !== -1) { val = key.slice(eq + 1); key = key.slice(0, eq); }
      else {
        if (i + 1 >= args.length) throw new TodoError(`Missing value for --${key}`);
        val = args[++i];
      }
      if (MULTI.has(key)) (opts[key] ??= []).push(val);
      else opts[key] = val;
    } else positional.push(a);
  }
  return { positional, opts };
}

function checkOpts(opts, allowed) {
  for (const k of Object.keys(opts)) {
    if (!allowed.includes(k)) throw new TodoError(`Unknown option: --${k}`);
  }
}

function parseId(s) {
  if (s === undefined) throw new TodoError('Missing id');
  if (!/^\d+$/.test(s)) throw new TodoError(`Invalid id: ${s}`);
  return Number(s);
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const { positional, opts } = parseArgs(rest);
  const store = new TodoStore({ file: process.env.TODO_FILE || './todos.json' });
  switch (cmd) {
    case 'add': {
      checkOpts(opts, ['due', 'priority', 'tag']);
      if (positional.length === 0) throw new TodoError('Missing title');
      const item = store.add(positional.join(' '), {
        due: opts.due,
        priority: opts.priority ?? 'normal',
        tags: opts.tag ?? [],
      });
      console.log(`Added #${item.id}: ${item.title}`);
      break;
    }
    case 'list': {
      checkOpts(opts, ['status', 'tag', 'sort', 'priority', 'search']);
      const items = store.list({
        status: opts.status ?? 'all',
        tag: opts.tag ? opts.tag[opts.tag.length - 1] : undefined,
        sort: opts.sort ?? 'created',
        priority: opts.priority,
        search: opts.search,
      });
      for (const it of items) console.log(`#${it.id} [${it.done ? 'x' : ' '}] ${it.title}`);
      break;
    }
    case 'done': {
      checkOpts(opts, []);
      const item = store.complete(parseId(positional[0]));
      console.log(`Completed #${item.id}`);
      break;
    }
    case 'rm': {
      checkOpts(opts, []);
      const item = store.remove(parseId(positional[0]));
      console.log(`Removed #${item.id}`);
      break;
    }
    default:
      throw new TodoError(cmd ? `Unknown command: ${cmd}` : 'No command given');
  }
}

try {
  main(process.argv.slice(2));
} catch (err) {
  process.stderr.write(`Error: ${err.message}\n`);
  process.exitCode = 1;
}
