# pm-s4 — Lightweight project-management application (tier S4)

A self-hosted Jira/Linear-style project manager: JSON REST API on `node:http` (stdlib only, no runtime npm dependencies) plus a browser single-page application. All data persisted to a JSON file (`dataFile`). Conventions (errors `{error, message}`, Bearer auth, ISO timestamps, string ids, 400/401/403/404/409/429 semantics) are identical to kanban-s3.

## Module
`src/server.js`: `export function createServer({ dataFile, clock } = {})` → `http.Server` (not listening). `clock` (optional) is a function returning the current `Date` (tests inject it). `src/main.js` starts on `PORT`.

## 1. Accounts, workspaces, RBAC
- Register/login/logout/me exactly as kanban-s3 (incl. rate limit and hashed passwords). `PATCH /api/auth/me {displayName?, password?, currentPassword}`.
- Personal API tokens: `POST /api/tokens {name}` → 201 `{id, name, token}` (token shown once, stored hashed); `GET /api/tokens` (no secrets); `DELETE /api/tokens/:id`. API tokens authenticate like session tokens.
- Workspaces: `POST /api/workspaces {name, key}` (`key` 2–10 uppercase letters, unique) → creator is `admin`. Workspace roles `admin | member | guest`. `POST /api/workspaces/:id/members {username, role}`, `PATCH`, `DELETE` (admin only; the last admin cannot be removed → 400).
- Guests see only projects they are explicitly added to and cannot create projects.

## 2. Projects and workflows
- `POST /api/workspaces/:id/projects {name, key}` (members+) → project with a default workflow: statuses `Backlog, Todo, In Progress, In Review, Done` (categories `backlog|unstarted|started|started|completed`) and transitions allowing any status → any status.
- Project roles `lead | developer | viewer` (`POST /api/projects/:id/members`). Workspace admins act as leads.
- Custom workflow: `PUT /api/projects/:id/workflow {statuses: [{name, category}], transitions: [[from, to], ...]}` (lead). Issues in a removed status must be mapped: body field `remap: {oldStatus: newStatus}` (400 if an in-use status is removed without a mapping).

## 3. Issues
Issue: `{ id, key: "<PROJECTKEY>-<n>", projectId, type: bug|feature|task|epic|subtask, title, description, status, priority: urgent|high|medium|low|none, assigneeId, reporterId, labels[], storyPoints, parentId, epicId, sprintId, dueDate, watchers[], createdAt, updatedAt, resolvedAt }`.
- `POST /api/projects/:id/issues` → 201; key numbers are sequential per project and never reused. Initial status = first `unstarted` status (or first status).
- `PATCH /api/issues/:key` → status changes must follow workflow transitions (409 `invalid_transition`). Entering a `completed` status sets `resolvedAt`; leaving it clears it.
- Subtasks require a non-subtask `parentId` in the same project; epics cannot have parents; `epicId` must reference an epic. Deleting a parent deletes its subtasks.
- `GET /api/issues/:key` includes `children` (subtask keys) and, for epics, `progress: {total, done, points_total, points_done}`.
- Issue links: `POST /api/issues/:key/links {type: blocks|relates|duplicates, target}`; the inverse (`blocked_by`) appears on the target. An issue cannot move to a `completed` status while it is `blocked_by` an unresolved issue (409 `blocked`).
- History: every field change is recorded; `GET /api/issues/:key/history` → `[{ field, from, to, actorId, at }]`.

## 4. Comments, mentions, watchers, notifications
- Comments as in kanban-s3 plus `PATCH` by the author (`edited: true`). `@username` mentions in comment bodies notify the mentioned users (if they can see the project).
- Reporter and assignee automatically watch. `POST/DELETE /api/issues/:key/watch`.
- Watchers are notified on status change, assignment, and new comment (not the actor themself). `GET /api/notifications?unread=true` → newest first `{id, type, issueKey, actorId, at, read}`; `POST /api/notifications/read {ids | all: true}`.

## 5. Sprints and reporting
- `POST /api/projects/:id/sprints {name, startDate?, endDate?}`; states `planned → active → completed`. One active sprint per project (409). `POST /api/sprints/:id/start`, `POST /api/sprints/:id/complete {carryOverTo: sprintId | "backlog"}` moves unfinished issues.
- `GET /api/sprints/:id/report` → `{ committedPoints, completedPoints, completedIssues, carriedOver, burndown: [{ date, remainingPoints }] }` with one burndown entry per day from start date to min(today, end date), computed from issue history (points remaining at end of each day, using `clock`).
- `GET /api/projects/:id/stats` → counts by status, by type, by assignee, average cycle time in hours (first `started` → `resolvedAt`) for resolved issues.

## 6. Search query language
`GET /api/search?q=...&project=...` with terms ANDed: `status:"In Progress"`, `type:bug`, `priority:high`, `assignee:me|<username>|none`, `label:x`, `sprint:active|<id>|none`, `is:open|resolved`, `due:<YYYY-MM-DD` (also `>`), `points:>3`, `key:ABC-12`, free text (case-insensitive title/description), quoted phrases, and negation with leading `-` (e.g. `-label:wontfix`). Results include only visible projects; sort `?sort=updated|created|priority` (default `updated` desc). Malformed query → 400.

## 7. Import / export, webhooks, audit
- `GET /api/projects/:id/export.csv` → RFC 4180 CSV with header `key,type,title,status,priority,assignee,labels,storyPoints,parent,epic,sprint,dueDate,createdAt,resolvedAt` (labels `;`-joined; assignee as username).
- `POST /api/projects/:id/import.csv` (text/csv body, same columns; `key` ignored) → `{ created, errors: [{ line, message }] }`; valid rows are imported even if others fail.
- Webhooks: `POST /api/projects/:id/webhooks {url, events: [issue.created|issue.updated|issue.deleted|comment.created], secret}`. On events the server POSTs JSON `{event, issue, actorId, at}` with header `X-PM-Signature: sha256=<hex HMAC-SHA256(secret, body)>`; deliveries recorded at `GET /api/webhooks/:id/deliveries` (`{status, attempts, lastError}`), with up to 3 attempts on failure.
- Workspace audit log `GET /api/workspaces/:id/audit` (admin): membership, role, workflow, token and webhook changes.

## 8. Web UI
`GET /` serves an SPA (static files under `/static/`) providing: login/register; workspace & project switcher; board view per workflow status with drag-and-drop transitions; backlog with sprint planning; issue detail with comments, history, links, subtasks; search bar using the query language; notifications panel; sprint report with burndown chart (SVG); project settings (workflow editor, members, webhooks). The UI must use only the public API.
