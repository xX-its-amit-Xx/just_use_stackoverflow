# Third-party notices

No third-party source code is vendored or adapted in `src/`.

The project is implemented from scratch using only Node.js 22 standard library modules
(`node:http`, `node:crypto`, `node:fs`, `node:path`, `node:url`) and the built-in `fetch`
for webhook delivery. The browser UI (`src/static/`) is hand-written vanilla JavaScript and CSS
with no external assets.

A GitHub repository (Snowxdxaxd/clone-jira) was inspected in the browser during discovery but
nothing was copied from it; see `PROVENANCE.json`.
