# markdown-s1 — Minimal Markdown → HTML renderer (tier S1)

## Module: `src/markdown.js` (ES module)
`export function render(markdown: string): string` → HTML.

Output must follow CommonMark 0.31 HTML output (as produced by the reference implementation commonmark.js) for the following subset. Insignificant whitespace between block-level tags does not matter; `<hr>`/`<hr />` and `<img ...>`/`<img ... />` are equivalent.

- ATX headings `#` … `######`.
- Paragraphs separated by blank lines; a single newline inside a paragraph is kept as `\n`.
- Emphasis `*a*` / `_a_` → `<em>`, strong `**a**` / `__a__` → `<strong>` (no intraword `_` emphasis).
- Inline code `` `x` ``.
- Links `[text](url)` and `[text](url "title")`, images `![alt](src)`.
- Unordered lists (`-` or `*`) and ordered lists (`1.`, with `start` attribute when not starting at 1), single level, tight.
- Fenced code blocks with ``` and an optional language → `<pre><code class="language-x">…</code></pre>`; contents are not parsed.
- Blockquotes (`> `, single level).
- Thematic break `---` on its own line (not under a paragraph line).
- Escape `&`, `<`, `>`, `"` in text, code and attributes. Raw HTML is never passed through (it is escaped as text).
