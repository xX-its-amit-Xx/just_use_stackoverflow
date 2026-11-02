import { TodoStore, TodoError } from './todo.js';

function main(argv) {
  const [cmd, ...rest] = argv;
  const store = new TodoStore({ file: process.env.TODO_FILE || './todos.json' });
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
      const it = store.add(pos[0], { due: opts.due, priority: opts.priority, tags: opts.tag });
      console.log(`Added #${it.id}: ${it.title}`); break;
    }
    case 'list': {
      const f = { sort: opts.sort, status: opts.status };
      if (opts.tag.length) f.tag = opts.tag[0];
      for (const k of Object.keys(f)) if (f[k] === undefined) delete f[k];
      for (const it of store.list(f)) console.log(`#${it.id} [${it.done ? 'x' : ' '}] ${it.title}`);
      break;
    }
    case 'done': { const i = id(); store.complete(i); console.log(`Completed #${i}`); break; }
    case 'rm': { const i = id(); store.remove(i); console.log(`Removed #${i}`); break; }
    default: throw new TodoError(`Unknown command: ${cmd ?? ''}`);
  }
}
try { main(process.argv.slice(2)); }
catch (e) { console.error(`Error: ${e.message}`); process.exit(1); }
