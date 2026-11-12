#!/usr/bin/env node
import { TodoStore, TodoError } from './todo.js';

function parse(args, spec) {
  const pos = [];
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      let name = a.slice(2), val;
      const eq = name.indexOf('=');
      if (eq >= 0) { val = name.slice(eq + 1); name = name.slice(0, eq); }
      if (!spec.includes(name)) throw new TodoError(`Unknown option: --${name}`);
      if (val === undefined) {
        if (i + 1 >= args.length) throw new TodoError(`Missing value for --${name}`);
        val = args[++i];
      }
      if (name === 'tag' && spec.includes('tags')) (opts.tags ||= []).push(val);
      else opts[name] = val;
    } else pos.push(a);
  }
  return { pos, opts };
}

function parseId(s) {
  if (s === undefined || !/^\d+$/.test(s)) throw new TodoError(`Invalid id: ${s ?? ''}`);
  return Number(s);
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const store = new TodoStore({ file: process.env.TODO_FILE || './todos.json' });
  switch (cmd) {
    case 'add': {
      const { pos, opts } = parse(rest, ['due', 'priority', 'tag', 'tags']);
      if (pos.length === 0) throw new TodoError('Missing title');
      const item = store.add(pos.join(' '), { due: opts.due, priority: opts.priority, tags: opts.tags });
      console.log(`Added #${item.id}: ${item.title}`);
      break;
    }
    case 'list': {
      const { opts } = parse(rest, ['status', 'tag', 'sort', 'priority', 'search']);
      for (const i of store.list(opts)) console.log(`#${i.id} [${i.done ? 'x' : ' '}] ${i.title}`);
      break;
    }
    case 'done': {
      const item = store.complete(parseId(rest[0]));
      console.log(`Completed #${item.id}`);
      break;
    }
    case 'rm': {
      const item = store.remove(parseId(rest[0]));
      console.log(`Removed #${item.id}`);
      break;
    }
    default:
      throw new TodoError(cmd ? `Unknown command: ${cmd}` : 'Usage: todo <add|list|done|rm> ...');
  }
}

try {
  main(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`Error: ${e.message}\n`);
  process.exit(1);
}
