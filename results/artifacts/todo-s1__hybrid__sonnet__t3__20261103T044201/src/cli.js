#!/usr/bin/env node
import { TodoStore, TodoError } from './todo.js';

function main(argv) {
  const store = new TodoStore({ file: process.env.TODO_FILE || './todos.json' });
  const [cmd, ...rest] = argv;
  const pos = [], opts = { tag: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (!['due', 'priority', 'tag', 'status', 'sort'].includes(k)) throw new TodoError(`Unknown option: ${a}`);
      if (i + 1 >= rest.length) throw new TodoError(`Missing value for ${a}`);
      const v = rest[++i];
      if (k === 'tag') opts.tag.push(v); else opts[k] = v;
    } else pos.push(a);
  }
  const id = () => {
    if (!/^\d+$/.test(pos[0] ?? '')) throw new TodoError('Invalid id');
    return Number(pos[0]);
  };
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
      if (opts.sort) o.sort = opts.sort;
      if (opts.tag.length) o.tag = opts.tag[0];
      for (const i of store.list(o)) console.log(`#${i.id} [${i.done ? 'x' : ' '}] ${i.title}`);
      break;
    }
    case 'done': { const n = id(); store.complete(n); console.log(`Completed #${n}`); break; }
    case 'rm': { const n = id(); store.remove(n); console.log(`Removed #${n}`); break; }
    default: throw new TodoError(`Unknown command: ${cmd ?? ''}`);
  }
}
try { main(process.argv.slice(2)); } catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
