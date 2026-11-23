#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TodoStore, TodoError } from './todo.js';

const USAGE = `Usage:
  node src/cli.js add "<title>" [--due YYYY-MM-DD] [--priority low|normal|high] [--tag t]...
  node src/cli.js list [--status all|open|done] [--tag t] [--sort created|due|priority]
  node src/cli.js done <id>
  node src/cli.js rm <id>`;

function parseArgs(argv, multi = ['tag']) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const name = a.slice(2);
      if (name.length === 0) throw new TodoError('invalid option: --');
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        throw new TodoError(`missing value for --${name}`);
      }
      i++;
      if (multi.includes(name)) {
        (flags[name] ??= []).push(next);
      } else {
        flags[name] = next;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function parseId(raw) {
  if (raw === undefined || !/^\d+$/.test(raw) || Number(raw) <= 0) {
    throw new TodoError(`invalid id: ${raw === undefined ? '(missing)' : raw}`);
  }
  return Number(raw);
}

function storeFromEnv() {
  const file = process.env.TODO_FILE || './todos.json';
  return new TodoStore({ file: path.resolve(file) });
}

function run(argv) {
  const [cmd, ...rest] = argv;
  const store = () => storeFromEnv();
  switch (cmd) {
    case 'add': {
      const { positional, flags } = parseArgs(rest);
      if (positional.length !== 1) throw new TodoError('add requires exactly one title argument');
      const item = store().add(positional[0], {
        due: flags.due,
        priority: flags.priority ?? 'normal',
        tags: flags.tag ?? [],
      });
      return `Added #${item.id}: ${item.title}`;
    }
    case 'list': {
      const { positional, flags } = parseArgs(rest, []);
      if (positional.length) throw new TodoError(`unexpected argument: ${positional[0]}`);
      const items = store().list({
        status: flags.status ?? 'all',
        tag: flags.tag,
        sort: flags.sort ?? 'created',
      });
      return items.map((it) => `#${it.id} [${it.done ? 'x' : ' '}] ${it.title}`).join('\n');
    }
    case 'done': {
      const { positional } = parseArgs(rest, []);
      const id = parseId(positional[0]);
      store().complete(id);
      return `Completed #${id}`;
    }
    case 'rm': {
      const { positional } = parseArgs(rest, []);
      const id = parseId(positional[0]);
      store().remove(id);
      return `Removed #${id}`;
    }
    default:
      throw new TodoError(cmd ? `unknown command: ${cmd}\n${USAGE}` : USAGE);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const out = run(process.argv.slice(2));
    if (out) process.stdout.write(out + '\n');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${msg}\n`);
    process.exitCode = 1;
  }
}

export { run };
