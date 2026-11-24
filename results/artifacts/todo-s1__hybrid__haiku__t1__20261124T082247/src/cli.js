#!/usr/bin/env node
import path from 'node:path';
import { TodoStore, TodoError } from './todo.js';

const USAGE = 'usage: cli.js <add|list|done|rm> ...';

function parseArgs(argv) {
  const positional = [];
  const flags = { tag: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (!['due', 'priority', 'tag', 'status', 'sort'].includes(name)) {
        throw new TodoError(`unknown option: ${a}`);
      }
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new TodoError(`missing value for ${a}`);
      }
      i++;
      if (name === 'tag') flags.tag.push(value);
      else flags[name] = value;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function run(argv) {
  const file = process.env.TODO_FILE || path.resolve('./todos.json');
  const store = new TodoStore({ file });
  const [cmd, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);

  switch (cmd) {
    case 'add': {
      const title = positional.join(' ');
      const item = store.add(title, {
        due: flags.due,
        priority: flags.priority ?? 'normal',
        tags: flags.tag,
      });
      return `Added #${item.id}: ${item.title}`;
    }
    case 'list': {
      const items = store.list({
        status: flags.status ?? 'all',
        tag: flags.tag.length ? flags.tag[0] : undefined,
        sort: flags.sort ?? 'created',
      });
      return items.map((it) => `#${it.id} [${it.done ? 'x' : ' '}] ${it.title}`).join('\n');
    }
    case 'done': {
      if (positional.length !== 1) throw new TodoError('usage: done <id>');
      const item = store.complete(positional[0]);
      return `Completed #${item.id}`;
    }
    case 'rm': {
      if (positional.length !== 1) throw new TodoError('usage: rm <id>');
      const item = store.remove(positional[0]);
      return `Removed #${item.id}`;
    }
    default:
      throw new TodoError(cmd ? `unknown command: ${cmd}\n${USAGE}` : USAGE);
  }
}

try {
  const out = run(process.argv.slice(2));
  if (out.length) process.stdout.write(out + '\n');
} catch (err) {
  const msg = err instanceof TodoError ? err.message : (err && err.message) || String(err);
  process.stderr.write(`Error: ${msg}\n`);
  process.exitCode = 1;
}
