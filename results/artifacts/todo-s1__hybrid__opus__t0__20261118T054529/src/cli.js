#!/usr/bin/env node
import { TodoStore, TodoError } from './todo.js';

const VALUE_FLAGS = ['due', 'priority', 'tag', 'status', 'sort', 'search'];

function parse(args) {
  const pos = [];
  const flags = { tag: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      let name = a.slice(2), val;
      const eq = name.indexOf('=');
      if (eq >= 0) { val = name.slice(eq + 1); name = name.slice(0, eq); }
      if (!VALUE_FLAGS.includes(name)) throw new TodoError(`Unknown option: --${name}`);
      if (val === undefined) {
        if (i + 1 >= args.length) throw new TodoError(`Missing value for --${name}`);
        val = args[++i];
      }
      if (name === 'tag') flags.tag.push(val); else flags[name] = val;
    } else pos.push(a);
  }
  return { pos, flags };
}

function parseId(s) {
  if (s === undefined || !/^\d+$/.test(s)) throw new TodoError(`Invalid id: ${s ?? ''}`.trim());
  return Number(s);
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const store = new TodoStore({ file: process.env.TODO_FILE || './todos.json' });
  const { pos, flags } = parse(rest);
  switch (cmd) {
    case 'add': {
      if (pos.length === 0) throw new TodoError('Title is required');
      const item = store.add(pos.join(' '), { due: flags.due, priority: flags.priority, tags: flags.tag });
      console.log(`Added #${item.id}: ${item.title}`);
      break;
    }
    case 'list': {
      const opts = { status: flags.status, sort: flags.sort, priority: flags.priority, search: flags.search };
      if (flags.tag.length) opts.tag = flags.tag[0];
      for (const k of Object.keys(opts)) if (opts[k] === undefined) delete opts[k];
      for (const i of store.list(opts)) console.log(`#${i.id} [${i.done ? 'x' : ' '}] ${i.title}`);
      break;
    }
    case 'done': { const i = store.complete(parseId(pos[0])); console.log(`Completed #${i.id}`); break; }
    case 'rm': { const i = store.remove(parseId(pos[0])); console.log(`Removed #${i.id}`); break; }
    default: throw new TodoError(cmd ? `Unknown command: ${cmd}` : 'No command given');
  }
}

try {
  main(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`Error: ${e.message}\n`);
  process.exit(1);
}
