// Markdown -> HTML renderer built on vendored commonmark.js
// (see THIRD_PARTY_NOTICES.md). Raw HTML parsing is disabled so that any
// HTML in the input is escaped as text.
import { Parser, HtmlRenderer } from "./commonmark/index.js";

export function render(markdown) {
  const parser = new Parser({ noHtml: true });
  const renderer = new HtmlRenderer();
  return renderer.render(parser.parse(String(markdown ?? "")));
}

export default render;
