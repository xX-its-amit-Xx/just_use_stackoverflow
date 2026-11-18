# todo-s1 — Todo list library + CLI (tier S1)

## Module: `src/todo.js` (ES module)
`export class TodoError extends Error` — thrown for invalid input / unknown ids.

`export class TodoStore`
- `constructor({ file } = {})` — if `file` is given, the store loads from it when it exists (JSON) and every mutating call persists to it synchronously. Without `file` the store is in-memory.
- `add(title, { due, priority = 'normal', tags = [] } = {})` → item.
  - `title`: non-empty string after trimming (stored trimmed), else `TodoError`.
  - `due`: optional ISO date string `YYYY-MM-DD` (validate format and that it is a real date), stored as given; `null` when absent.
  - `priority`: one of `'low' | 'normal' | 'high'`, else `TodoError`.
  - `tags`: array of strings, stored lower-cased, de-duplicated, order preserved.
  - Item shape: `{ id, title, done: false, priority, due, tags, createdAt }` where `id` is a positive integer, unique and increasing (never reused, also after removal and reload), and `createdAt` is an ISO timestamp.
- `get(id)` → item or `TodoError` if unknown.
- `update(id, patch)` → updated item. Patchable: `title`, `due`, `priority`, `tags` (same validation). Unknown fields → `TodoError`.
- `complete(id)` / `reopen(id)` → item with `done` true / false.
- `remove(id)` → removed item.
- `clearCompleted()` → number of items removed.
- `list({ status = 'all', tag, priority, search, sort = 'created' } = {})` → array (copies, mutating them must not affect the store).
  - `status`: `'all' | 'open' | 'done'`; `tag`: items having that tag (case-insensitive); `priority`: exact; `search`: case-insensitive substring of title.
  - `sort`: `'created'` (id ascending), `'due'` (ascending; items without due date last, ties by id), `'priority'` (high, normal, low; ties by id).
- `stats(today = <current date as YYYY-MM-DD>)` → `{ total, open, done, overdue }` where overdue = open items with `due` < `today`.

## CLI: `src/cli.js`
Storage file from env `TODO_FILE` (default `./todos.json`).
- `node src/cli.js add "<title>" [--due YYYY-MM-DD] [--priority p] [--tag t]...` → prints `Added #<id>: <title>`
- `node src/cli.js list [--status s] [--tag t] [--sort k]` → one line per item: `#<id> [x] <title>` for done, `#<id> [ ] <title>` for open
- `node src/cli.js done <id>` → prints `Completed #<id>`
- `node src/cli.js rm <id>` → prints `Removed #<id>`
Errors: message to stderr prefixed with `Error: `, exit code 1.
