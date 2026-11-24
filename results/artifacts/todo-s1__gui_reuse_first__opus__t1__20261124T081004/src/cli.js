#!/usr/bin/env node
import { TodoStore } from './todo.js';

function parse(args) {
  const pos = [];
  const opts = { tags: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      let key = a.slice(2), val;
      const eq = key.indexOf('=');
      if (eq >= 0) { val = key.slice(eq + 1); key = key.slice(0, eq); }
      else {
        if (i + 1 >= args.length) throw new Error(`Missing value for --${key}`);
        val = args[++i];
      }
      if (key === 'tag') opts.tags.push(val);
      else opts[key] = val;
    } else pos.push(a);
  }
  return { pos, opts };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const store = new TodoStore({ file: process.env.TODO_FILE || './todos.json' });
  const { pos, opts } = parse(rest);
  const needId = () => {
    if (pos.length < 1 || !/^\d+$/.test(pos[0])) throw new Error(`Invalid id: ${pos[0] ?? ''}`);
    return Number(pos[0]);
  };
  switch (cmd) {
    case 'add': {
      const item = store.add(pos.join(' ') || pos[0] || '', { due: opts.due, priority: opts.priority ?? 'normal', tags: opts.tags });
      console.log(`Added #${item.id}: ${item.title}`);
      break;
    }
    case 'list': {
      const items = store.list({ status: opts.status ?? 'all', tag: opts.tags[0], priority: opts.priority, search: opts.search, sort: opts.sort ?? 'created' });
      for (const i of items) console.log(`#${i.id} [${i.done ? 'x' : ' '}] ${i.title}`);
      break;
    }
    case 'done': { const id = needId(); store.complete(id); console.log(`Completed #${id}`); break; }
    case 'rm': { const id = needId(); store.remove(id); console.log(`Removed #${id}`); break; }
    default: throw new Error(`Unknown command: ${cmd ?? ''}`);
  }
}

try { main(process.argv.slice(2)); }
catch (e) { process.stderr.write(`Error: ${e.message}\n`); process.exit(1); }
