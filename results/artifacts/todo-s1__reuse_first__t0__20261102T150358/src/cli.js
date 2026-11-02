#!/usr/bin/env node
import { TodoStore, TodoError } from './todo.js';

function parse(args) {
  const pos = [], opt = { tag: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (!['due', 'priority', 'tag', 'status', 'sort'].includes(k)) throw new TodoError(`Unknown option: ${a}`);
      if (i + 1 >= args.length) throw new TodoError(`Missing value for ${a}`);
      const v = args[++i];
      if (k === 'tag') opt.tag.push(v); else opt[k] = v;
    } else pos.push(a);
  }
  return { pos, opt };
}
function id(s) {
  if (!/^\d+$/.test(s ?? '')) throw new TodoError(`Invalid id: ${s}`);
  return Number(s);
}

try {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = parse(rest);
  const store = new TodoStore({ file: process.env.TODO_FILE || './todos.json' });
  if (cmd === 'add') {
    const it = store.add(pos[0], { due: opt.due, priority: opt.priority, tags: opt.tag });
    console.log(`Added #${it.id}: ${it.title}`);
  } else if (cmd === 'list') {
    const q = { sort: opt.sort, status: opt.status };
    if (opt.tag.length) q.tag = opt.tag[0];
    for (const it of store.list(q)) console.log(`#${it.id} [${it.done ? 'x' : ' '}] ${it.title}`);
  } else if (cmd === 'done') {
    console.log(`Completed #${store.complete(id(pos[0])).id}`);
  } else if (cmd === 'rm') {
    console.log(`Removed #${store.remove(id(pos[0])).id}`);
  } else throw new TodoError(`Unknown command: ${cmd}`);
} catch (e) {
  console.error(`Error: ${e.message}`);
  process.exit(1);
}
