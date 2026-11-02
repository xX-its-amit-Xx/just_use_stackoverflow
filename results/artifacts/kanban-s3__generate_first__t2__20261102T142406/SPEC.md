# kanban-s3 — Multi-user Kanban board service with web UI (tier S3)

A Trello-style Kanban backend (JSON REST API over `node:http`, no frameworks) with authentication, roles, WIP limits, labels, comments, search, an activity log, file persistence, and a single-page web UI served at `/`.

## Module
- `src/server.js`: `export function createServer({ dataFile } = {})` → a `node:http` `Server` (NOT yet listening). If `dataFile` is given, all data (users, boards, columns, cards, labels, comments, activity) is loaded from it on creation and saved to it after every mutation (synchronously or before the response is sent). A new server created with the same file sees the same data. Sessions/tokens need not survive restarts.
- `src/main.js`: starts the server on `process.env.PORT || 3000` with `dataFile = process.env.DATA_FILE || './data.json'`.

## Conventions
- JSON request/response bodies (`Content-Type: application/json`). Invalid JSON → 400.
- Errors: status code + body `{ "error": "<code>", "message": "<text>" }`. Codes used by tests: 400 validation, 401 unauthenticated, 403 forbidden, 404 not found (also unknown routes), 409 conflict, 429 rate limited.
- IDs are strings. Timestamps are ISO-8601 strings.
- Auth: `Authorization: Bearer <token>` on every `/api` route except register/login. Missing/invalid/logged-out token → 401.
- Passwords must be stored hashed with a salt (e.g. `crypto.scrypt`); the plaintext password must not appear in the data file.

## Users / auth
- `POST /api/auth/register {username, password, displayName?}` → 201 `{ user }`. `username`: 3–32 chars of `[a-z0-9_]`, case-insensitive (stored lower-case), unique (409). `password` ≥ 8 chars (400). `displayName` defaults to the username.
- `POST /api/auth/login {username, password}` → 200 `{ token, user }`; wrong credentials → 401. After 5 failed attempts for one username within 15 minutes, further attempts (even correct) → 429.
- `POST /api/auth/logout` → 204 (token invalidated). `GET /api/auth/me` → 200 `{ user }`.
- User object: `{ id, username, displayName }` (never the password hash).

## Boards and roles
Roles per board: `owner` (exactly one; the creator), `editor`, `viewer`.
viewer: read only. editor: may create/edit/move/delete columns, cards, labels and comments. owner: everything, plus board settings, members and deletion. A non-member gets 403 on board-scoped resources that exist; unknown ids → 404.
- `POST /api/boards {name, description?, columns?}` → 201 board. `name` 1–100 chars. `columns` (array of names) defaults to `["To Do", "In Progress", "Done"]`.
- `GET /api/boards` → `[{ id, name, role }]` for boards the user is a member of.
- `GET /api/boards/:id` → `{ id, name, description, ownerId, createdAt, members: [{ userId, username, role }], labels: [label], columns: [{ id, name, position, wipLimit, cards: [card sorted by position] }] }`, columns sorted by position.
- `PATCH /api/boards/:id {name?, description?}` (owner) → 200 board. `DELETE /api/boards/:id` (owner) → 204 (everything on it is deleted).
- `POST /api/boards/:id/members {username, role}` (owner; role `editor`|`viewer`) → 201 `{ userId, username, role }`; unknown user 404; already member 409.
- `PATCH /api/boards/:id/members/:userId {role}` (owner) → 200. `DELETE /api/boards/:id/members/:userId` (owner, or a member removing themself) → 204; removing the owner → 400.

## Columns
- `POST /api/boards/:id/columns {name, wipLimit?}` → 201 column appended at the end. `wipLimit`: positive integer or null.
- `PATCH /api/columns/:id {name?, wipLimit?, position?}` → 200. Changing `position` (0-based, clamped to range) reorders the board's columns; positions stay contiguous `0..n-1`.
- `DELETE /api/columns/:id` → 204; if it still has cards → 409 unless `?force=true` (then its cards are deleted too). Remaining positions re-compacted.

## Cards
Card: `{ id, boardId, columnId, title, description, position, assignees: [userId], labels: [labelId], dueDate, createdBy, createdAt, updatedAt }`.
- `POST /api/columns/:id/cards {title, description?, assignees?, labels?, dueDate?, position?}` → 201. `title` 1–200 chars. `dueDate` `YYYY-MM-DD` or null. Assignees must be board members and labels must belong to the board (400). Default position: end of column; explicit position inserts and shifts others.
  If the column has a `wipLimit` and already holds that many cards → 409 with `error: "wip_limit"`.
- `GET /api/cards/:id`; `PATCH /api/cards/:id {title?, description?, assignees?, labels?, dueDate?}` → 200 (updates `updatedAt`); `DELETE /api/cards/:id` → 204.
- `POST /api/cards/:id/move {columnId, position?}` → 200 card. Target column must be on the same board (400). Moving into a different column respects its WIP limit (409 `wip_limit`). Positions in source and target columns remain contiguous `0..n-1`, ordered as the user requested.

## Labels
- `POST /api/boards/:id/labels {name, color}` → 201 `{ id, boardId, name, color }`; `color` must be `#rrggbb` (400). Names unique per board, case-insensitive (409).
- `DELETE /api/labels/:id` → 204 and removed from every card.

## Comments
- `POST /api/cards/:id/comments {body}` (editor+) → 201 `{ id, cardId, authorId, body, createdAt }`; `body` 1–5000 chars.
- `GET /api/cards/:id/comments` → oldest first.
- `DELETE /api/comments/:id` → 204; only the comment's author or the board owner (others 403).

## Search
`GET /api/boards/:id/cards?q=&assignee=&label=&column=&due_before=` → array of matching cards (all filters ANDed; `q` is a case-insensitive substring of title or description; `assignee` a userId; `label` a labelId; `column` a columnId; `due_before` `YYYY-MM-DD`, exclusive, cards without due date excluded), sorted by column position then card position.

## Activity log
`GET /api/boards/:id/activity?limit=` → newest first (`limit` default 50). Entry: `{ id, boardId, type, actorId, cardId?, at, details }`. Types that must be recorded: `board.created`, `column.created`, `card.created`, `card.updated`, `card.moved` (details include `fromColumnId`, `toColumnId`), `card.deleted`, `comment.added`, `member.added`.

## Web UI
`GET /` serves a single-page HTML app (`Content-Type: text/html`) that lets a user register/log in, list and create boards, and view a board with its columns and cards, create cards and move them between columns (drag-and-drop or buttons), using the API above. Additional static assets may be served under `/static/`.
