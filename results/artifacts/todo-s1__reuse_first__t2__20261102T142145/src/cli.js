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
function id(s) {
  if (!/^\d+$/.test(s || '')) throw new TodoError('Invalid id: ' + s);
  return Number(s);
}
try {
  const [cmd, ...rest] = process.argv.slice(2);
  const { pos, opt } = parse(rest);
  const s = new TodoStore({ file: process.env.TODO_FILE || './todos.json' });
  if (cmd === 'add') {
    const o = { tags: opt.tag };
    if (opt.due !== undefined) o.due = opt.due;
    if (opt.priority !== undefined) o.priority = opt.priority;
    const it = s.add(pos[0], o);
    console.log(`Added #${it.id}: ${it.title}`);
  } else if (cmd === 'list') {
    const o = {};
    if (opt.status) o.status = opt.status;
    if (opt.tag.length) o.tag = opt.tag[0];
    if (opt.sort) o.sort = opt.sort;
    for (const i of s.list(o)) console.log(`#${i.id} [${i.done ? 'x' : ' '}] ${i.title}`);
  } else if (cmd === 'done') {
    console.log(`Completed #${s.complete(id(pos[0])).id}`);
  } else if (cmd === 'rm') {
    console.log(`Removed #${s.remove(id(pos[0])).id}`);
  } else throw new TodoError('Unknown command: ' + cmd);
} catch (e) {
  console.error('Error: ' + e.message);
  process.exit(1);
}
