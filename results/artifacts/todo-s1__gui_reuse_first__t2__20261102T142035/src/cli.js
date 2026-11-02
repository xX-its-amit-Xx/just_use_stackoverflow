#!/usr/bin/env node
import { TodoStore, TodoError } from './todo.js';

function parse(args) {
  const pos = [], opts = { tag: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (!['due', 'priority', 'tag', 'status', 'sort'].includes(k)) throw new TodoError('Unknown option: ' + a);
      if (i + 1 >= args.length) throw new TodoError('Missing value for ' + a);
      const v = args[++i];
      if (k === 'tag') opts.tag.push(v); else opts[k] = v;
    } else pos.push(a);
  }
  return { pos, opts };
}
function parseId(s) {
  if (!/^\d+$/.test(s || '')) throw new TodoError('Invalid id: ' + s);
  return Number(s);
}

try {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opts } = parse(rest);
  const store = new TodoStore({ file: process.env.TODO_FILE || './todos.json' });
  switch (cmd) {
    case 'add': {
      if (pos.length < 1) throw new TodoError('Title required');
      const o = { tags: opts.tag };
      if (opts.due !== undefined) o.due = opts.due;
      if (opts.priority !== undefined) o.priority = opts.priority;
      const it = store.add(pos[0], o);
      console.log(`Added #${it.id}: ${it.title}`);
      break;
    }
    case 'list': {
      const o = {};
      if (opts.status) o.status = opts.status;
      if (opts.sort) o.sort = opts.sort;
      if (opts.tag.length) o.tag = opts.tag[0];
      for (const it of store.list(o)) console.log(`#${it.id} [${it.done ? 'x' : ' '}] ${it.title}`);
      break;
    }
    case 'done': { const id = parseId(pos[0]); store.complete(id); console.log(`Completed #${id}`); break; }
    case 'rm': { const id = parseId(pos[0]); store.remove(id); console.log(`Removed #${id}`); break; }
    default: throw new TodoError('Unknown command: ' + cmd);
  }
} catch (e) {
  console.error('Error: ' + e.message);
  process.exit(1);
}
