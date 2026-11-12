# markdown-s2 — Safe Markdown → HTML renderer (tier S2)

## Module: `src/markdown.js` (ES module)
- `export function render(markdown: string, { headingIds = false } = {}): string` → HTML.
- `export function toc(markdown: string): Array<{ level: number, text: string, slug: string }>` — every ATX/setext heading in document order; `text` is the heading's plain text (inline markup removed).
- `export function slugify(text: string, seen?: Map)` — GitHub-style slug: lower-case; remove every character that is not a letter, digit, space, `-` or `_`; spaces → `-`. When a `Map` of previously seen slugs is passed, repeated slugs get `-1`, `-2`, … suffixes. `toc` and `headingIds` use one map per document.

## Output conventions
Follow CommonMark 0.31 HTML output (as produced by the reference implementation commonmark.js) plus GFM tables and strikethrough, except where this spec says otherwise. Insignificant whitespace between block-level tags is not significant to the tests; `<br>`/`<br />`, `<hr>`/`<hr />`, `<img ...>`/`<img ... />` are equivalent; table alignment may be expressed as `align="left"` or `style="text-align:left"`.

Required features:
- ATX headings `#`…`######` (closing `#`s stripped), setext headings (`===`, `---`). With `headingIds: true`, headings get `id="<slug>"`: `<h2 id="my-title">My title</h2>`.
- Paragraphs; soft line breaks preserved as `\n`; hard breaks via two trailing spaces or a trailing backslash → `<br />`.
- Emphasis/strong with `*` and `_` (CommonMark rules incl. no intraword `_` emphasis), `***x***` → `<em><strong>x</strong></em>`; GFM `~~strike~~` → `<del>`.
- Code spans (multi-backtick delimiters, one leading/trailing space stripped when both present).
- Fenced code blocks (``` and ~~~, info string → `class="language-<first word>"`) and indented code blocks.
- Blockquotes (nested, with lazy continuation lines), thematic breaks (`---`, `***`, `___`).
- Bullet lists (`-`, `*`, `+`) and ordered lists (`1.` / `1)`, `start` attribute when not 1), nesting by indentation, tight vs loose lists (`<li><p>` when loose).
- Inline links `[t](url "title")`, images `![alt](src "title")`, reference links `[t][ref]`, `[ref]` with definitions `[ref]: url "title"` (case-insensitive labels), autolinks `<https://…>` and `<user@example.com>` (→ `mailto:`).
- Backslash escapes; HTML-escape `& < > "` in text, attributes and code.
- GFM pipe tables with header row, delimiter row, optional alignment (`:--`, `:-:`, `--:`), inline markup in cells, `\|` escapes.

## Safety (deliberate deviation from CommonMark)
- Raw HTML (block and inline) is NOT passed through: it is rendered as escaped text, e.g. `<script>x</script>` → `<p>&lt;script&gt;x&lt;/script&gt;</p>`.
- Link/image URLs with schemes `javascript:`, `vbscript:`, `file:` or `data:` (except `data:image/png|gif|jpeg|webp;`) are replaced by `#`.

## CLI: `src/cli.js`
`node src/cli.js <file.md> [--toc] [--ids]` prints HTML (or with `--toc`, the TOC as JSON) to stdout. Reads stdin when the file argument is `-`.
