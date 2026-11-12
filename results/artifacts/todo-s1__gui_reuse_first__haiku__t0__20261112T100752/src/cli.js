#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TodoStore, TodoError } from './todo.js';

const USAGE = `Usage:
  node src/cli.js add "<title>" [--due YYYY-MM-DD] [--priority low|normal|high] [--tag t]...
  node src/cli.js list [--status all|open|done] [--tag t] [--sort created|due|priority]
  node src/cli.js done <id>
  node src/cli.js rm <id>`;

// Options that take a value, and which of them may be repeated.
const VALUE_OPTS = {
  due: { repeat: false },
  priority: { repeat: false },
  tag: { repeat: true },
  status: { repeat: false },
  sort: { repeat: false },
};

function parseArgs(args) {
  const positional = [];
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      let name = arg.slice(2);
      let value;
      const eq = name.indexOf('=');
      if (eq !== -1) {
        value = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      if (!Object.hasOwn(VALUE_OPTS, name)) {
        throw new TodoError(`unknown option: --${name}`);
      }
      if (value === undefined) {
        if (i + 1 >= args.length) throw new TodoError(`option --${name} requires a value`);
        value = args[++i];
      }
      if (VALUE_OPTS[name].repeat) {
        (opts[name] ??= []).push(value);
      } else {
        opts[name] = value;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, opts };
}

function parseId(raw) {
  if (raw === undefined) throw new TodoError('an id is required');
  const s = raw.startsWith('#') ? raw.slice(1) : raw;
  if (!/^\d+$/.test(s)) throw new TodoError(`invalid id: ${raw}`);
  return Number(s);
}

function formatItem(item) {
  return `#${item.id} [${item.done ? 'x' : ' '}] ${item.title}`;
}

function storeFile(env) {
  return env.TODO_FILE || './todos.json';
}

/**
 * Runs one CLI command. Returns { code, stdout, stderr } so it can be tested
 * without spawning a process.
 */
export function run(argv, env = process.env) {
  const out = [];
  const err = [];
  try {
    const [command, ...rest] = argv;
    if (!command) throw new TodoError(USAGE);
    const { positional, opts } = parseArgs(rest);
    const store = new TodoStore({ file: storeFile(env) });

    switch (command) {
      case 'add': {
        const title = positional[0];
        if (positional.length !== 1) throw new TodoError('add requires exactly one title');
        const item = store.add(title, {
          due: opts.due,
          priority: opts.priority ?? 'normal',
          tags: opts.tag ?? [],
        });
        out.push(`Added #${item.id}: ${item.title}`);
        break;
      }
      case 'list': {
        if (positional.length !== 0) throw new TodoError('list takes no arguments');
        const items = store.list({
          status: opts.status ?? 'all',
          tag: opts.tag?.[0],
          sort: opts.sort ?? 'created',
        });
        for (const item of items) out.push(formatItem(item));
        break;
      }
      case 'done': {
        const item = store.complete(parseId(positional[0]));
        out.push(`Completed #${item.id}`);
        break;
      }
      case 'rm': {
        const item = store.remove(parseId(positional[0]));
        out.push(`Removed #${item.id}`);
        break;
      }
      default:
        throw new TodoError(`unknown command: ${command}\n${USAGE}`);
    }
    return { code: 0, stdout: out.map((l) => l + '\n').join(''), stderr: '' };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    err.push(`Error: ${message}`);
    return { code: 1, stdout: '', stderr: err.map((l) => l + '\n').join('') };
  }
}

function isMain() {
  try {
    return process.argv[1] !== undefined &&
      fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const result = run(process.argv.slice(2), process.env);
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
