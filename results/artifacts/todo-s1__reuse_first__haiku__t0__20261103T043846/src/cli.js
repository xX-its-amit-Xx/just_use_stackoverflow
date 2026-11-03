#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { TodoStore, TodoError } from './todo.js';

const USAGE = `Usage:
  todo add "<title>" [--due YYYY-MM-DD] [--priority low|normal|high] [--tag t]...
  todo list [--status all|open|done] [--tag t] [--priority p] [--search s] [--sort created|due|priority]
  todo done <id>
  todo rm <id>`;

// Parses args into { positional: [], flags: { name: [values] } }.
// Supports "--name value" and "--name=value". Repeatable flags accumulate.
const VALUE_FLAGS = new Set(['due', 'priority', 'tag', 'status', 'sort', 'search']);

function parseArgs(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      let name = a.slice(2);
      let value;
      const eq = name.indexOf('=');
      if (eq !== -1) {
        value = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      if (!VALUE_FLAGS.has(name)) throw new TodoError(`unknown option: --${name}`);
      if (value === undefined) {
        if (i + 1 >= args.length) throw new TodoError(`option --${name} requires a value`);
        value = args[++i];
      }
      (flags[name] ||= []).push(value);
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function parseId(raw) {
  if (raw === undefined || !/^#?\d+$/.test(raw)) {
    throw new TodoError(`invalid id: ${raw === undefined ? '(missing)' : raw}`);
  }
  const id = Number(raw.replace(/^#/, ''));
  if (!Number.isSafeInteger(id) || id <= 0) throw new TodoError(`invalid id: ${raw}`);
  return id;
}

function last(flags, name) {
  const v = flags[name];
  return v ? v[v.length - 1] : undefined;
}

function openStore(env) {
  return new TodoStore({ file: env.TODO_FILE || './todos.json' });
}

// Returns the output lines; throws TodoError on invalid usage.
export function run(argv, env = process.env) {
  const [cmd, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);
  const store = openStore(env);

  switch (cmd) {
    case 'add': {
      const title = positional.join(' ');
      if (positional.length === 0) throw new TodoError('add requires a title');
      const item = store.add(title, {
        due: last(flags, 'due'),
        priority: last(flags, 'priority') ?? 'normal',
        tags: flags.tag || [],
      });
      return [`Added #${item.id}: ${item.title}`];
    }
    case 'list': {
      const items = store.list({
        status: last(flags, 'status') ?? 'all',
        tag: last(flags, 'tag'),
        priority: last(flags, 'priority'),
        search: last(flags, 'search'),
        sort: last(flags, 'sort') ?? 'created',
      });
      return items.map((i) => `#${i.id} [${i.done ? 'x' : ' '}] ${i.title}`);
    }
    case 'done': {
      const id = parseId(positional[0]);
      store.complete(id);
      return [`Completed #${id}`];
    }
    case 'rm': {
      const id = parseId(positional[0]);
      store.remove(id);
      return [`Removed #${id}`];
    }
    default:
      throw new TodoError(`unknown command: ${cmd ?? '(none)'}\n${USAGE}`);
  }
}

function main() {
  try {
    const lines = run(process.argv.slice(2));
    for (const l of lines) console.log(l);
  } catch (err) {
    if (err instanceof TodoError) {
      process.stderr.write(`Error: ${err.message}\n`);
    } else {
      process.stderr.write(`Error: ${err && err.message ? err.message : String(err)}\n`);
    }
    process.exitCode = 1;
  }
}

function isMain() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname);
  } catch {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  }
}

if (isMain()) main();
