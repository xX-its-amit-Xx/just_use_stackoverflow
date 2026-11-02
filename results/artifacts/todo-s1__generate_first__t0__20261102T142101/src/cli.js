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
function id(s) {
  if (!/^\d+$/.test(s || '')) throw new TodoError('Invalid id: ' + s);
  return Number(s);
}

try {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opts } = parse(rest);
  const store = new TodoStore({ file: process.env.TODO_FILE || './todos.json' });
  switch (cmd) {
    case 'add': {
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
      if (opts.tag.length) o.tag = opts.tag[0];
      if (opts.sort) o.sort = opts.sort;
      for (const it of store.list(o)) console.log(`#${it.id} [${it.done ? 'x' : ' '}] ${it.title}`);
      break;
    }
    case 'done': store.complete(id(pos[0])); console.log(`Completed #${pos[0] && Number(pos[0])}`); break;
    case 'rm': store.remove(id(pos[0])); console.log(`Removed #${Number(pos[0])}`); break;
    default: throw new TodoError('Unknown command: ' + cmd);
  }
} catch (e) {
  if (e instanceof TodoError) { console.error('Error: ' + e.message); process.exit(1); }
  console.error('Error: ' + e.message); process.exit(1);
}
