# markdown-s3 — Personal Markdown wiki with live-preview editor (tier S3)

Node.js 22, standard library only (no runtime npm dependencies). Single user, no authentication.

## 1. Renderer `src/markdown.js` (ES module)
- `export function render(markdown, { headingIds = false, wikiLinks } = {})` → HTML.
- `export function toc(markdown)` → `[{ level, text, slug }]`; `export function slugify(text, seen?)`.

Rendering rules: CommonMark 0.31 HTML output (as produced by commonmark.js) plus GFM pipe tables and `~~strikethrough~~` (`<del>`). Insignificant whitespace between block-level tags does not matter; `<br>`/`<br />`, `<hr>`/`<hr />`, `<img …>`/`<img … />` are equivalent; table alignment may be `align="x"` or `style="text-align:x"`. Required: ATX/setext headings, paragraphs, hard breaks, emphasis/strong, code spans, fenced + indented code (`class="language-<info>"`), blockquotes, nested bullet/ordered lists (tight/loose, `start`), inline/reference links, images, autolinks, backslash escapes, tables, thematic breaks.

Safety (deviation from CommonMark): raw HTML is rendered as escaped text; link/image URLs with schemes `javascript:`, `vbscript:`, `file:`, or `data:` (except `data:image/png|gif|jpeg|webp;`) become `#`.

Slugs (GitHub style): lower-case, drop every character that is not a letter, digit, space, `-` or `_`, spaces → `-`; with a `Map` `seen`, duplicates get `-1`, `-2`, …. `headingIds: true` adds `id="<slug>"` to headings; `toc` lists headings in order with the same slugs.

Wiki links (when `wikiLinks` is given as `{ exists(slug) → boolean }`): `[[Page Title]]` → `<a href="/wiki/<slugify(Page Title)>" class="wikilink">Page Title</a>`; `[[target|label]]` → link to `slugify(target)` with text `label`. If `exists(slug)` is false the class is `wikilink missing`. Wiki links inside code spans/blocks are not converted. Without the option `[[x]]` is plain text.

## 2. Server `src/server.js`
`export function createServer({ dataDir })` → `node:http` Server (not listening). All state is stored under `dataDir` and survives a restart (new server, same directory). JSON bodies; errors `{ "error": "<code>", "message": "<text>" }` with 400 (validation / bad JSON), 404 (unknown page/version/route), 409 (conflict).

Pages: `{ slug, title, body, tags[], version, createdAt, updatedAt }`. `slug` matches `^[a-z0-9][a-z0-9_-]*$` (else 400). `title` non-empty ≤ 200 chars. Tags are lower-cased, de-duplicated, sorted.
- `PUT /api/pages/:slug {title, body, tags?, baseVersion?}` → creates (201, version 1) or updates (200, version+1). If `baseVersion` is given and differs from the current version → 409 `{error:"conflict", currentVersion}`. A PUT whose title, body and tags are unchanged does not create a new version (200, same version).
- `GET /api/pages/:slug` → page plus `html` (rendered with `headingIds: true` and wiki links resolved against existing pages), `toc`, `backlinks` (sorted slugs of pages whose current body links to this page via a wiki link), `links` (sorted distinct target slugs of this page's wiki links).
- `GET /api/pages?tag=&sort=title|updated` → `[{ slug, title, tags, version, updatedAt }]`; default sort `title` (case-insensitive), `updated` = newest first.
- `DELETE /api/pages/:slug` → 204 (history removed too).
- History: `GET /api/pages/:slug/history` → `[{ version, title, updatedAt }]` newest first; `GET /api/pages/:slug/versions/:n` → that version's `{ version, title, body, tags }`; `POST /api/pages/:slug/revert {version}` → creates a new version whose content equals that version (200).
- Diff: `GET /api/pages/:slug/diff?from=a&to=b` → `{ from, to, lines: [{ op, text }] }`, a minimal line-based diff of the bodies (LCS) with `op` ∈ `" "` (unchanged), `"-"` (only in `from`), `"+"` (only in `to`); inside each changed run all `-` lines come before `+` lines.
- Search: `GET /api/search?q=` (case-insensitive, ≥ 1 char after trimming else 400) → `[{ slug, title, snippet, score }]` for pages whose title or body contains `q`. Order: title matches first, then by number of occurrences in title+body (desc), then slug. `snippet`: up to 40 characters before and after the first body occurrence (or the start of the body when only the title matches), HTML-escaped, with the matched text wrapped in `<mark>…</mark>` (original case).
- `POST /api/render {markdown}` → `{ html, toc }` (wiki links resolved against existing pages).
- `GET /api/tags` → `[{ tag, count }]` sorted by tag.
- `GET /api/export` → `{ pages: [{ slug, title, body, tags, version }] }`; `POST /api/import {pages}` → creates/updates each page (new version if changed) → `{ imported }`.
- `GET /wiki/:slug` → a standalone HTML document (`text/html`) containing the page title and the same `html` as `GET /api/pages/:slug` (heading ids, resolved wiki links); 404 page for unknown slugs.

## 3. Editor UI
`GET /` serves a single-page app (`text/html`; extra assets under `/static/`) with: page list with tag filter, search box, a Markdown editor with live preview (via `/api/render`), save with conflict handling (`baseVersion`), history view with diff, backlinks panel. The UI must use only the public API.

`src/main.js` starts the server on `PORT` (default 3000) with `DATA_DIR` (default `./data`).
