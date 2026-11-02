#!/usr/bin/env node
import { TodoStore, TodoError } from './todo.js';

function parse(args) {
  const pos = [], opt = { tag: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (!['due', 'priority', 'tag', 'status', 'sort'].includes(k)) throw new TodoError('Unknown option: ' + a);
      if (i + 1 >= args.length) throw new TodoError('Missing value for ' + a);
      const v = args[++i];
      if (k === 'tag') opt.tag.push(v); else opt[k] = v;
    } else pos.push(a);
  }
  return { pos, opt };
}
function parseId(s) {
  if (!/^\d+$/.test(s || '')) throw new TodoError('Invalid id: ' + s);
  return Number(s);
}
function main(argv) {
  const [cmd, ...rest] = argv;
  const { pos, opt } = parse(rest);
  const store = new TodoStore({ file: process.env.TODO_FILE || './todos.json' });
  switch (cmd) {
    case 'add': {
      if (pos.length < 1) throw new TodoError('Missing title');
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
      if (opt.tag.length) o.tag = opt.tag[0];
      if (opt.sort) o.sort = opt.sort;
      for (const i of store.list(o)) console.log(`#${i.id} [${i.done ? 'x' : ' '}] ${i.title}`);
      break;
    }
    case 'done': console.log(`Completed #${store.complete(parseId(pos[0])).id}`); break;
    case 'rm': console.log(`Removed #${store.remove(parseId(pos[0])).id}`); break;
    default: throw new TodoError('Unknown command: ' + cmd);
  }
}
try { main(process.argv.slice(2)); } catch (e) {
  console.error('Error: ' + e.message);
  process.exit(1);
}
