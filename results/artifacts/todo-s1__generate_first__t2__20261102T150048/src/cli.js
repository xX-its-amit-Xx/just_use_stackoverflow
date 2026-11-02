#!/usr/bin/env node
import { TodoStore, TodoError } from './todo.js';

function fail(msg) { process.stderr.write('Error: ' + msg + '\n'); process.exit(1); }

function parse(args) {
  const pos = [], opt = {}, tags = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (!['due', 'priority', 'tag', 'status', 'sort'].includes(k)) fail('Unknown option: ' + a);
      if (i + 1 >= args.length) fail('Missing value for ' + a);
      const v = args[++i];
      if (k === 'tag') tags.push(v); else opt[k] = v;
    } else pos.push(a);
  }
  return { pos, opt, tags };
}
function id(s) {
  if (!/^\d+$/.test(s || '')) fail('Invalid id: ' + s);
  return Number(s);
}

try {
  const [cmd, ...rest] = process.argv.slice(2);
  const store = new TodoStore({ file: process.env.TODO_FILE || './todos.json' });
  const { pos, opt, tags } = parse(rest);
  switch (cmd) {
    case 'add': {
      if (pos.length < 1) fail('Missing title');
      const o = { tags };
      if (opt.due !== undefined) o.due = opt.due;
      if (opt.priority !== undefined) o.priority = opt.priority;
      const it = store.add(pos[0], o);
      console.log(`Added #${it.id}: ${it.title}`);
      break;
    }
    case 'list': {
      const o = {};
      if (opt.status) o.status = opt.status;
      if (tags.length) o.tag = tags[0];
      if (opt.sort) o.sort = opt.sort;
      for (const i of store.list(o)) console.log(`#${i.id} [${i.done ? 'x' : ' '}] ${i.title}`);
      break;
    }
    case 'done': store.complete(id(pos[0])); console.log(`Completed #${pos[0]}`); break;
    case 'rm': store.remove(id(pos[0])); console.log(`Removed #${pos[0]}`); break;
    default: fail('Unknown command: ' + (cmd ?? ''));
  }
} catch (e) {
  if (e instanceof TodoError) fail(e.message);
  throw e;
}
