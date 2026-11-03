#!/usr/bin/env node
// CLI glue (new code), command layout inspired by TaskNinja CLI (MIT).
import { parseArgs } from 'node:util';
import { TodoStore, TodoError } from './todo.js';

function main(argv) {
  const [cmd, ...rest] = argv;
  const store = new TodoStore({ file: process.env.TODO_FILE || './todos.json' });
  const parse = (options) => {
    try {
      return parseArgs({ args: rest, options, allowPositionals: true, strict: true });
    } catch (e) { throw new TodoError(e.message); }
  };
  switch (cmd) {
    case 'add': {
      const { values, positionals } = parse({
        due: { type: 'string' }, priority: { type: 'string' }, tag: { type: 'string', multiple: true },
      });
      if (positionals.length === 0) throw new TodoError('Missing title');
      const opts = { tags: values.tag ?? [] };
      if (values.due !== undefined) opts.due = values.due;
      if (values.priority !== undefined) opts.priority = values.priority;
      const item = store.add(positionals.join(' '), opts);
      console.log(`Added #${item.id}: ${item.title}`);
      break;
    }
    case 'list': {
      const { values } = parse({
        status: { type: 'string' }, tag: { type: 'string' }, sort: { type: 'string' },
        priority: { type: 'string' }, search: { type: 'string' },
      });
      for (const it of store.list(values)) console.log(`#${it.id} [${it.done ? 'x' : ' '}] ${it.title}`);
      break;
    }
    case 'done': {
      const { positionals } = parse({});
      if (positionals.length !== 1) throw new TodoError('Usage: done <id>');
      const it = store.complete(positionals[0]);
      console.log(`Completed #${it.id}`);
      break;
    }
    case 'rm': {
      const { positionals } = parse({});
      if (positionals.length !== 1) throw new TodoError('Usage: rm <id>');
      const it = store.remove(positionals[0]);
      console.log(`Removed #${it.id}`);
      break;
    }
    default:
      throw new TodoError(cmd ? `Unknown command: ${cmd}` : 'Usage: cli.js <add|list|done|rm> ...');
  }
}

try {
  main(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`Error: ${e.message}\n`);
  process.exit(1);
}
