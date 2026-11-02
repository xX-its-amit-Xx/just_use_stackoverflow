#!/usr/bin/env node
import { TodoStore } from './todo.js';

function main(argv) {
  const [cmd, ...rest] = argv;
  const store = new TodoStore({ file: process.env.TODO_FILE || './todos.json' });
  const opts = { tag: [] }, pos = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (i + 1 >= rest.length) throw new Error(`Missing value for --${k}`);
      const v = rest[++i];
      if (k === 'tag') opts.tag.push(v); else opts[k] = v;
    } else pos.push(a);
  }
  const num = s => { if (!/^\d+$/.test(s ?? '')) throw new Error(`Invalid id: ${s}`); return Number(s); };
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
      let items = store.list(o);
      for (const t of opts.tag.slice(1)) items = items.filter(i => i.tags.includes(t.toLowerCase()));
      for (const i of items) console.log(`#${i.id} [${i.done ? 'x' : ' '}] ${i.title}`);
      break;
    }
    case 'done': store.complete(num(pos[0])); console.log(`Completed #${num(pos[0])}`); break;
    case 'rm': store.remove(num(pos[0])); console.log(`Removed #${num(pos[0])}`); break;
    default: throw new Error(`Unknown command: ${cmd ?? ''}`);
  }
}
try { main(process.argv.slice(2)); }
catch (e) { console.error(`Error: ${e.message}`); process.exit(1); }
