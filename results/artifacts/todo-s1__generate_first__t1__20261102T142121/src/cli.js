#!/usr/bin/env node
import { TodoStore, TodoError } from './todo.js';

function main(argv) {
  const [cmd, ...rest] = argv;
  const pos = [], opt = { tag: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (!['due', 'priority', 'tag', 'status', 'sort'].includes(k)) throw new TodoError(`unknown option: ${a}`);
      if (i + 1 >= rest.length) throw new TodoError(`missing value for ${a}`);
      const v = rest[++i];
      if (k === 'tag') opt.tag.push(v); else opt[k] = v;
    } else pos.push(a);
  }
  const store = new TodoStore({ file: process.env.TODO_FILE || './todos.json' });
  const id = () => {
    if (!/^\d+$/.test(pos[0] ?? '')) throw new TodoError('invalid id');
    return Number(pos[0]);
  };
  switch (cmd) {
    case 'add': {
      const o = { tags: opt.tag };
      if (opt.due !== undefined) o.due = opt.due;
      if (opt.priority !== undefined) o.priority = opt.priority;
      const it = store.add(pos[0], o);
      console.log(`Added #${it.id}: ${it.title}`);
      break;
    }
    case 'list': {
      const o = {};
      if (opt.status) o.status = opt.status;
      if (opt.sort) o.sort = opt.sort;
      if (opt.tag.length) o.tag = opt.tag[0];
      for (const i of store.list(o)) console.log(`#${i.id} [${i.done ? 'x' : ' '}] ${i.title}`);
      break;
    }
    case 'done': { const n = id(); store.complete(n); console.log(`Completed #${n}`); break; }
    case 'rm': { const n = id(); store.remove(n); console.log(`Removed #${n}`); break; }
    default: throw new TodoError(`unknown command: ${cmd ?? ''}`);
  }
}
try { main(process.argv.slice(2)); }
catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
